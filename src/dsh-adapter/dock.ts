/**
 * `ctx.tuiDock` — plugin rows immediately above the prompt.
 *
 * The status seam above the prompt is text-only (plus a bounded, pointer-only
 * rich view). A dock row is the full composer-adjacent surface: one host-
 * rendered React component between the transcript and the prompt, owned by a
 * plugin, bounded in rows, and re-rendered with the session's version.
 *
 * Contract notes:
 *
 * - One component per registration; the host clips it at `maxRows` (default
 *   8, at most 24) so a buggy plugin cannot push the prompt off screen.
 * - The host kit is the panel UI kit minus the panel-height contract:
 *   `useTerminalSize()` returns the real terminal size, and `width` is the
 *   composer's content width. Components do not receive keyboard input — use
 *   `tuiShortcuts` for keys and `Box`'s click/hover handlers for pointers.
 * - `host.snapshot()` is the same curated, frozen session view as
 *   `tuiSessionState`; `host.panelEnabled(subId)` answers whether a side
 *   panel with that sub-id is enabled (so a dock can hide itself when its
 *   panel is on screen).
 *
 * @module dock
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
import type { TuiSessionSnapshot } from './session-state.js'

/** Rows a dock may occupy by default / at most. */
export const TUI_DOCK_DEFAULT_MAX_ROWS = 8
export const TUI_DOCK_MAX_ROWS = 24
/** Per-plugin and global dock budgets. */
export const MAX_DOCKS_PER_PLUGIN = 4
export const MAX_PLUGIN_DOCKS_TOTAL = 12

type TuiDockForbiddenBoxProps =
  | 'ref'
  | 'tabIndex'
  | 'autoFocus'
  | 'onContextMenu'
  | 'onFocus'
  | 'onFocusCapture'
  | 'onBlur'
  | 'onBlurCapture'
  | 'onKeyDown'
  | 'onKeyDownCapture'

/** `Box` keeps pointer interaction; focus and keyboard props are removed. */
export type TuiDockBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Box>,
  TuiDockForbiddenBoxProps
>

export type TuiDockTextProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Text>,
  'ref'
>

export type TuiDockImageProps = React.ComponentProps<typeof import('../ui.js').Image>
export type TuiDockScrollBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').ScrollBox>,
  'ref'
>
export type TuiDockDividerProps = React.ComponentProps<
  typeof import('../components/design-system/Divider.js').Divider
>

export interface TuiDockMarkdownProps {
  readonly children: string
}

export interface TuiDockCodeBlockProps {
  readonly code: string
  readonly language?: string
}

/** UI kit handed to a dock component. */
export interface TuiDockUi {
  readonly Box: React.ComponentType<TuiDockBoxProps>
  readonly Text: React.ComponentType<TuiDockTextProps>
  readonly Image: React.ComponentType<TuiDockImageProps>
  readonly ScrollBox: React.ComponentType<TuiDockScrollBoxProps>
  readonly Divider: React.ComponentType<TuiDockDividerProps>
  readonly Markdown: React.ComponentType<TuiDockMarkdownProps>
  readonly CodeBlock: React.ComponentType<TuiDockCodeBlockProps>
  /** The real terminal size (the dock is not a panel viewport). */
  readonly useTerminalSize: typeof import('../ui.js').useTerminalSize
  /** Shared animation clock (same contract as plugin panels). */
  readonly useAnimationTime: (intervalMs: number | null) => number
  readonly useTheme: typeof import('../ui.js').useTheme
}

/** Host services available to a dock row. */
export interface TuiDockHost {
  /** Curated, frozen live session view. */
  snapshot(): TuiSessionSnapshot
  /** Whether a side panel whose id is (or ends with) `subId` is enabled. */
  panelEnabled(subId: string): boolean
  /** Whether the side panel is currently split beside the chat. */
  readonly sidePanelSplit: boolean
  /** Fire-and-forget toast; returns false when the host has no toast sink. */
  toast(text: string): boolean
}

/** Props every dock component receives. */
export interface TuiDockProps {
  readonly React: typeof React
  readonly ui: TuiDockUi
  readonly host: TuiDockHost
  /** Composer content width in terminal cells. */
  readonly width: number
}

/** Registration descriptor. */
export interface TuiDockDescriptor {
  readonly apiVersion: 1
  /** Single lowercase slug; the host adds the `<pluginId>:` prefix. */
  readonly id: string
  /** Human title for diagnostics. */
  readonly title?: string
  /** Sorted ascending; lower rows sit closer to the transcript. */
  readonly order?: number
  /** Row cap, 1…24 (default 8). */
  readonly maxRows?: number
  readonly component: React.ComponentType<TuiDockProps>
}

/** Host-side normalized registration. */
export interface TuiDockEntry {
  readonly id: string
  readonly title: string
  readonly order: number
  readonly maxRows: number
  readonly component: React.ComponentType<TuiDockProps>
  readonly registrationId: number
}

const SUB_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u
const TITLE_CELLS = 80

/** Cordis-free store rendered by Chat. */
export class TuiDockStore {
  private readonly entries = new Map<string, TuiDockEntry>()
  private readonly owners = new Map<string, object | undefined>()
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private snapshot: readonly TuiDockEntry[] = Object.freeze([])

  register(entry: Omit<TuiDockEntry, 'registrationId'>, owner: object | undefined): (() => void) | undefined {
    if (this.entries.has(entry.id)) return undefined
    if (this.entries.size >= MAX_PLUGIN_DOCKS_TOTAL) return undefined
    this.sequence += 1
    const stored: TuiDockEntry = Object.freeze({ ...entry, registrationId: this.sequence })
    this.entries.set(stored.id, stored)
    this.owners.set(stored.id, owner)
    this.emit()
    return () => {
      if (this.entries.get(stored.id)?.registrationId !== stored.registrationId) return
      this.entries.delete(stored.id)
      this.owners.delete(stored.id)
      this.emit()
    }
  }

  list(): readonly TuiDockEntry[] {
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ownerCount(owner: object): number {
    let count = 0
    for (const value of this.owners.values()) if (value === owner) count += 1
    return count
  }

  private emit(): void {
    this.snapshot = Object.freeze([...this.entries.values()].sort((left, right) =>
      left.order - right.order || left.registrationId - right.registrationId))
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One dock subscriber cannot starve the others.
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiDock: TuiDockRuntime
  }
}

interface DockState {
  readonly store: TuiDockStore
  readonly runtime: AdapterRuntimeOptions
}

const hostDockStates = new WeakMap<TuiDockRuntime, DockState>()

function dockStateFor(runtime: TuiDockRuntime): DockState {
  const state = hostDockStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiDock host store is unavailable')
  return state
}

/** `ctx.tuiDock` — prompt-adjacent plugin rows. */
export class TuiDockRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiDock')
    hostDockStates.set(this, {
      store: new TuiDockStore(),
      runtime: adapterRuntimeFor(ctx),
    })
  }

  register(descriptor: TuiDockDescriptor, identity?: Context): (() => void) | undefined {
    assertCapabilityShadowPolicy('host.dock.register', dockStateFor(this).runtime.mode, dockStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiDock.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiDock.register requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined && identity !== caller) {
      this.ctx.logger.warn('dsh-tui: tuiDock.register rejected an identity belonging to another activation')
      return undefined
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      this.ctx.logger.warn('dsh-tui: tuiDock.register requires a live activation owner')
      return undefined
    }
    if (typeof descriptor !== 'object' || descriptor === null) {
      this.ctx.logger.warn('dsh-tui: tuiDock.register rejected an invalid descriptor')
      return undefined
    }
    if (descriptor.apiVersion !== 1) {
      this.ctx.logger.warn('dsh-tui: tuiDock.register rejected apiVersion ' + String(descriptor.apiVersion) + ' (expected 1)')
      return undefined
    }
    if (typeof descriptor.id !== 'string' || !SUB_ID_PATTERN.test(descriptor.id)) {
      this.ctx.logger.warn('dsh-tui: tuiDock.register rejected an invalid dock id')
      return undefined
    }
    if (typeof descriptor.component !== 'function') {
      this.ctx.logger.warn(`dsh-tui: tuiDock.register rejected "${descriptor.id}" — component must be a function`)
      return undefined
    }
    const maxRows = descriptor.maxRows ?? TUI_DOCK_DEFAULT_MAX_ROWS
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > TUI_DOCK_MAX_ROWS) {
      this.ctx.logger.warn(`dsh-tui: tuiDock.register rejected "${descriptor.id}" — maxRows must be an integer from 1 to ${TUI_DOCK_MAX_ROWS}`)
      return undefined
    }
    if (descriptor.order !== undefined && (typeof descriptor.order !== 'number' || !Number.isFinite(descriptor.order))) {
      this.ctx.logger.warn(`dsh-tui: tuiDock.register rejected "${descriptor.id}" — order must be a finite number`)
      return undefined
    }
    const state = dockStateFor(this)
    if (state.store.ownerCount(owner) >= MAX_DOCKS_PER_PLUGIN) {
      this.ctx.logger.warn(`dsh-tui: tuiDock.register rejected "${descriptor.id}" — a plugin may register at most ${MAX_DOCKS_PER_PLUGIN} docks`)
      return undefined
    }
    const title = cleanScalarText(descriptor.title ?? descriptor.id, TITLE_CELLS) || descriptor.id
    const dispose = state.store.register({
      id: descriptor.id,
      title,
      order: descriptor.order ?? 0,
      maxRows,
      component: descriptor.component,
    }, owner)
    if (dispose === undefined) {
      this.ctx.logger.warn(`dsh-tui: tuiDock.register rejected "${descriptor.id}" — duplicate id or the dock budget is full`)
      return undefined
    }
    const bound = bindCallerEffect(caller, dispose)
    if (!bound) {
      dispose()
      return undefined
    }
    return dispose
  }
}

/** Host-only accessor used by Chat. */
export function getHostDockStore(runtime: TuiDockRuntime | undefined): TuiDockStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostDockStates.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

export default TuiDockRuntime
