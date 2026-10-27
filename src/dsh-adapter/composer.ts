/**
 * `ctx.tuiComposer` — plugin-owned prompt editing modes.
 *
 * The prompt is the TUI's most stateful widget: text, caret, fold block,
 * staged images, draft undo, the fullscreen editor and Esc precedence all
 * live inside `PromptInput`. A plugin cannot reach that state directly, and
 * it must not: the host owns the draft. This seam exposes the smallest
 * surface an editing mode needs — the current text/caret, a mode-scoped undo
 * stack, and a key hook that runs after the host's own editing keys.
 *
 * Contract notes:
 *
 * - Modes are registered by a plugin activation and activated explicitly
 *   (`toggle`/`activate`); only the registering activation may drive its own
 *   mode.
 * - `onKey` runs only while the mode is active and only from the prompt's
 *   key path (no help/command/file overlays). A returned `true` (or
 *   `preventDefault()`) means the key was consumed.
 * - `badge()` is pure display: the host renders the text next to the value,
 *   sanitized and capped by display width.
 * - `save()`/`restore()` carry mode-local state across a prompt remount (the
 *   draft cache). `reset()` is called when the draft itself ends (submit,
 *   clear, recall, session switch).
 * - The mode's edits land in the host's draft, never in the plugin's storage;
 *   the plugin only decides what the next text/caret is.
 *
 * @module composer
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, bindCallerEffect, concreteService, requirePluginCaller } from './host-access.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'

/** Badge colour vocabulary (theme semantics, never literal colours). */
export type TuiComposerBadgeTone = 'dim' | 'accent' | 'success' | 'warning' | 'error'

/** The mode badge rendered beside the prompt value. */
export interface TuiComposerBadge {
  readonly text: string
  readonly tone?: TuiComposerBadgeTone
}

/**
 * The key flags an editing mode may read. Kept structural so the host can
 * pass its renderer's key object without importing a vendor type here.
 */
export interface TuiComposerKeyFlags {
  readonly escape?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly shift?: boolean
  readonly tab?: boolean
  readonly return?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly home?: boolean
  readonly end?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
}

/**
 * The draft operations a mode may use. Deliberately small:
 *
 * - `setText` applies a complete edit atomically (sanitizes, normalizes the
 *   caret, drops the fold block and releases removed image tokens).
 * - `pushUndo`/`undo` are the MODE's own history, separate from the draft's
 *   Ctrl+Z stack. The host snapshots text, caret and image bindings, so the
 *   plugin never sees stage ids.
 */
export interface TuiComposerDraft {
  text(): string
  cursor(): number
  setText(text: string, cursor: number): void
  pushUndo(): void
  undo(): boolean
}

/** One key handed to the active mode. */
export interface TuiComposerModeKeyEvent {
  readonly input: string
  readonly key: TuiComposerKeyFlags
  readonly draft: TuiComposerDraft
  /** Mark the key consumed. Equivalent to returning `true`. */
  preventDefault(): void
}

/** A plugin editing mode. */
export interface TuiComposerModeDescriptor {
  readonly apiVersion: 1
  /** Single lowercase slug (the mode id, e.g. `vim`). */
  readonly id: string
  /** Human label for diagnostics (not rendered as-is). */
  readonly label: string
  /** True when bare Esc belongs to this mode at Chat level (working-turn
   *  interrupt yields to the prompt while the mode is active). */
  readonly ownsEscape?: boolean
  /** Runs while active, after the host's standard editing keys. */
  onKey(event: TuiComposerModeKeyEvent): boolean | void
  /** Current badge, or undefined to render none. */
  badge?(): TuiComposerBadge | undefined
  /** Mode-local state carried across prompt remounts. */
  save?(): unknown
  /** Restore the state captured by {@link save}. */
  restore?(state: unknown): void
  /** The mode was switched on (fresh state, e.g. back to insert). */
  onActivate?(): void
  /** The mode was switched off; the host also clears its mode undo stack. */
  onDeactivate?(): void
  /** The draft ended (submit/clear/recall/session switch). */
  reset?(): void
}

/** Host-side normalized entry. */
export interface TuiComposerModeEntry {
  readonly id: string
  readonly label: string
  readonly descriptor: TuiComposerModeDescriptor
  readonly registrationId: number
}

/** Snapshot of the active mode, as the prompt renders it. */
export interface TuiComposerActiveMode {
  readonly id: string
  readonly label: string
  readonly badge: TuiComposerBadge | undefined
  readonly ownsEscape: boolean
}

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/u
const MAX_MODES = 16
const MAX_BADGE_CELLS = 24

function sanitizeBadge(badge: TuiComposerBadge | undefined): TuiComposerBadge | undefined {
  if (badge === undefined || badge === null) return undefined
  const text = cleanScalarText(badge.text, MAX_BADGE_CELLS)
  if (text === '') return undefined
  const tone = badge.tone
  const valid = tone === 'dim' || tone === 'accent' || tone === 'success' || tone === 'warning' || tone === 'error'
  return {
    text,
    ...(valid ? { tone } : {}),
  }
}

/** Cordis-free store the prompt subscribes to. */
export class TuiComposerStore {
  private readonly modes = new Map<string, { readonly entry: TuiComposerModeEntry; readonly owner: object | undefined }>()
  private activeId: string | undefined
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private activeVersion = 0

  /** Host-side registration (the service wraps admission around this). */
  register(descriptor: TuiComposerModeDescriptor, owner: object | undefined): (() => void) | undefined {
    if (typeof descriptor !== 'object' || descriptor === null) return undefined
    if (typeof descriptor.id !== 'string' || !ID_PATTERN.test(descriptor.id)) return undefined
    if (typeof descriptor.onKey !== 'function') return undefined
    if (this.modes.has(descriptor.id)) return undefined
    if (this.modes.size >= MAX_MODES) return undefined
    this.sequence += 1
    const entry: TuiComposerModeEntry = Object.freeze({
      id: descriptor.id,
      label: cleanScalarText(descriptor.label, 60) || descriptor.id,
      descriptor,
      registrationId: this.sequence,
    })
    this.modes.set(descriptor.id, { entry, owner })
    return () => {
      const current = this.modes.get(entry.id)
      if (current?.entry.registrationId !== entry.registrationId) return
      this.modes.delete(entry.id)
      if (this.activeId === entry.id) {
        this.activeId = undefined
        this.bump()
      }
    }
  }

  active(): string | undefined {
    return this.activeId
  }

  /** The active mode's frozen display snapshot (undefined when none). */
  activeMode(): TuiComposerActiveMode | undefined {
    if (this.activeId === undefined) return undefined
    const current = this.modes.get(this.activeId)
    if (current === undefined) return undefined
    const { entry } = current
    let badge: TuiComposerBadge | undefined
    try {
      badge = sanitizeBadge(entry.descriptor.badge?.())
    } catch {
      badge = undefined
    }
    return Object.freeze({
      id: entry.id,
      label: entry.label,
      badge,
      ownsEscape: entry.descriptor.ownsEscape === true,
    })
  }

  /** Version that changes whenever the active mode or its display changes. */
  version(): number {
    return this.activeVersion
  }

  /** Activate a registered mode. Returns false for unknown ids. */
  activate(id: string, owner?: object): boolean {
    const current = this.modes.get(id)
    if (current === undefined) return false
    if (owner !== undefined && current.owner !== owner) return false
    if (this.activeId === id) return true
    if (this.activeId !== undefined) this.deactivate()
    this.activeId = id
    try {
      current.entry.descriptor.onActivate?.()
    } catch {
      // A mode's activation hook cannot break the prompt.
    }
    this.bump()
    return true
  }

  /** Deactivate the current mode (no-op when none is active). */
  deactivate(owner?: object): boolean {
    if (this.activeId === undefined) return false
    const current = this.modes.get(this.activeId)
    if (current === undefined) {
      this.activeId = undefined
      this.bump()
      return true
    }
    if (owner !== undefined && current.owner !== owner) return false
    this.activeId = undefined
    try {
      current.entry.descriptor.onDeactivate?.()
    } catch {
      // Ignored for the same reason as onActivate.
    }
    this.bump()
    return true
  }

  /** Toggle a registered mode. Returns the resulting active state. */
  toggle(id: string, owner?: object): boolean {
    if (this.activeId === id) {
      this.deactivate(owner)
      return false
    }
    return this.activate(id, owner)
  }

  /** Host: hand a key to the active mode. */
  dispatch(event: TuiComposerModeKeyEvent): boolean {
    if (this.activeId === undefined) return false
    const current = this.modes.get(this.activeId)
    if (current === undefined) return false
    let prevented = false
    const wrapped: TuiComposerModeKeyEvent = {
      ...event,
      preventDefault: () => {
        prevented = true
        event.preventDefault()
      },
    }
    try {
      const handled = current.entry.descriptor.onKey(wrapped) === true || prevented
      // A handled key may have changed mode-local display state (INSERT →
      // NORMAL and back). Bump so every prompt re-renders its badge; an
      // ignored key changes nothing and stays quiet.
      if (handled) this.bump()
      return handled
    } catch {
      return false
    }
  }

  /** Host: save the active mode's own state for the draft cache. */
  saveActive(): { readonly modeId: string; readonly state: unknown } | undefined {
    if (this.activeId === undefined) return undefined
    const modeId = this.activeId
    const current = this.modes.get(modeId)
    if (current === undefined || typeof current.entry.descriptor.save !== 'function') {
      return { modeId, state: undefined }
    }
    try {
      return { modeId, state: current.entry.descriptor.save() }
    } catch {
      return { modeId, state: undefined }
    }
  }

  /** Host: restore mode state after a prompt remount. Unknown ids are
   *  dropped (the plugin may have been unloaded while the draft lived). */
  restore(id: string, state: unknown): boolean {
    const current = this.modes.get(id)
    if (current === undefined) return false
    this.activate(id)
    try {
      current.entry.descriptor.restore?.(state)
    } catch {
      // State the mode cannot restore is simply fresh.
    }
    this.bump()
    return this.activeId === id
  }

  /** Host: the draft ended; every active mode resets its transient state. */
  resetActive(): void {
    if (this.activeId === undefined) return
    const current = this.modes.get(this.activeId)
    if (current === undefined) return
    try {
      current.entry.descriptor.reset?.()
    } catch {
      // Ignored: a reset hook must not block the draft reset.
    }
    this.bump()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private bump(): void {
    this.activeVersion += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener cannot starve the others.
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiComposer: TuiComposerRuntime
  }
}

interface ComposerState {
  readonly store: TuiComposerStore
  readonly runtime: AdapterRuntimeOptions
}

const hostComposerStores = new WeakMap<TuiComposerRuntime, ComposerState>()

function composerStateFor(runtime: TuiComposerRuntime): ComposerState {
  const state = hostComposerStores.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiComposer host store is unavailable')
  return state
}

/** `ctx.tuiComposer` — plugin editing modes. */
export class TuiComposerRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiComposer')
    hostComposerStores.set(this, {
      store: new TuiComposerStore(),
      runtime: adapterRuntimeFor(ctx),
    })
  }

  /**
   * Register an editing mode. Refusals warn and return `undefined` so a
   * feature-detecting plugin can tell admission from a bad descriptor.
   * The returned disposer is scoped to the caller's fiber by the service.
   */
  register(descriptor: TuiComposerModeDescriptor, identity?: Context): (() => void) | undefined {
    assertCapabilityShadowPolicy('host.composer.register', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiComposer.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined && identity !== caller) {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register rejected an identity belonging to another activation')
      return undefined
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register requires a live activation owner')
      return undefined
    }
    const state = composerStateFor(this)
    if (typeof descriptor !== 'object' || descriptor === null) {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register rejected an invalid descriptor')
      return undefined
    }
    if (descriptor.apiVersion !== 1) {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register rejected apiVersion ' + String(descriptor.apiVersion) + ' (expected 1)')
      return undefined
    }
    if (typeof descriptor.id !== 'string' || !ID_PATTERN.test(descriptor.id)) {
      this.ctx.logger.warn('dsh-tui: tuiComposer.register rejected an invalid mode id')
      return undefined
    }
    if (typeof descriptor.onKey !== 'function') {
      this.ctx.logger.warn(`dsh-tui: tuiComposer.register rejected "${descriptor.id}" — onKey must be a function`)
      return undefined
    }
    if (descriptor.badge !== undefined && typeof descriptor.badge !== 'function') {
      this.ctx.logger.warn(`dsh-tui: tuiComposer.register rejected "${descriptor.id}" — badge must be a function`)
      return undefined
    }
    const dispose = state.store.register(descriptor, owner)
    if (dispose === undefined) {
      this.ctx.logger.warn(`dsh-tui: tuiComposer.register rejected "${descriptor.id}" — duplicate id or the mode budget is full`)
      return undefined
    }
    const owned = (): void => {
      // The store's own dispose is idempotent and registration-checked.
      dispose()
    }
    const bound = bindCallerEffect(caller, owned)
    if (!bound) {
      dispose()
      return undefined
    }
    return dispose
  }

  /** The active mode id, or undefined. */
  active(): string | undefined {
    assertCapabilityShadowPolicy('host.composer.active', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    return composerStateFor(this).store.active()
  }

  /** Activate one of the calling plugin's modes. */
  activate(id: string): boolean {
    assertCapabilityShadowPolicy('host.composer.activate', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiComposer.activate', this)
    } catch {
      return false
    }
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    return composerStateFor(this).store.activate(id, owner)
  }

  /** Deactivate the calling plugin's active mode. */
  deactivate(): boolean {
    assertCapabilityShadowPolicy('host.composer.deactivate', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiComposer.deactivate', this)
    } catch {
      return false
    }
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    return composerStateFor(this).store.deactivate(owner)
  }

  /** Toggle one of the calling plugin's modes; returns the new active state. */
  toggle(id: string): boolean {
    assertCapabilityShadowPolicy('host.composer.toggle', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiComposer.toggle', this)
    } catch {
      return false
    }
    const owner = activationFiber(caller)
    if (owner === undefined) return false
    return composerStateFor(this).store.toggle(id, owner)
  }

  /** Watch active-mode/badge changes. Caller-fiber scoped. */
  subscribe(listener: () => void): () => void {
    assertCapabilityShadowPolicy('host.composer.subscribe', composerStateFor(this).runtime.mode, composerStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiComposer.subscribe', this)
    } catch {
      return () => {}
    }
    if (typeof listener !== 'function') return () => {}
    const state = composerStateFor(this)
    const wrapped = (): void => {
      try {
        listener()
      } catch {
        // Contained like every other plugin listener.
      }
    }
    const dispose = state.store.subscribe(wrapped)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Host-only accessor: the prompt reads this, never a plugin. */
export function getHostComposerStore(runtime: TuiComposerRuntime | undefined): TuiComposerStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostComposerStores.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

export default TuiComposerRuntime
