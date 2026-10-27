/**
 * `ctx.tuiCommands` — plugin-local slash commands.
 *
 * The built-in command table (`src/commands.ts`) and the DSH command registry
 * cover the host's own commands; a plugin's pure-UI command (toggle an editing
 * mode, print a plugin state report) had no way in. This seam registers such a
 * command with the TUI's own dispatcher.
 *
 * Precedence (the same "locals win" rule as every extension seam):
 *
 * - A built-in command of the same name always runs first; registration of a
 *   built-in name is refused outright.
 * - A command served by the backend's registry (`/goal` on DSH, plugins
 *   installed in the DSH profile) shadows the local one at dispatch time.
 * - Only then does the local handler run. `false`/`undefined` lets the line
 *   fall through to the model, exactly like an unknown command.
 *
 * Handlers receive the command's argument text and the curated session
 * snapshot; they cannot reach the Channel. Returning `lines` prints a local
 * report row the way a built-in report does, and `notice` raises a toast.
 *
 * @module plugin-commands
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, bindCallerEffect, concreteService, requirePluginCaller } from './host-access.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { HIDDEN_COMMAND_NAMES, LOCAL_COMMANDS } from '../commands.js'
import type { TuiSessionSnapshot } from './session-state.js'
import type { Lang } from '../i18n.js'

/** One notice a handler may raise alongside (or instead of) its report. */
export interface TuiLocalCommandNotice {
  readonly text: string
  readonly tone?: 'success' | 'warning' | 'error' | 'info'
}

/** What a handler returns. */
export type TuiLocalCommandResult =
  | boolean
  | {
    readonly handled?: boolean
    /** Lines printed as a local report under the command echo. */
    readonly lines?: readonly string[]
    /** Transient toast. */
    readonly notice?: TuiLocalCommandNotice
  }
  | undefined

/** Input handed to a command handler. */
export interface TuiLocalCommandInput {
  /** Text after the command name (no leading separator). */
  readonly args: string
  /** The full command line as typed. */
  readonly raw: string
  /** Frozen live session view (goal/todos included). */
  readonly snapshot: TuiSessionSnapshot
}

/** A plugin-local slash command. */
export interface TuiLocalCommandDescriptor {
  readonly apiVersion: 1
  /** Lowercase command name without the slash. */
  readonly name: string
  /** English fallback description. */
  readonly description: string
  /** Optional per-language descriptions (`en` / `zh`). */
  readonly descriptions?: Partial<Record<Lang, string>>
  handler(input: TuiLocalCommandInput): TuiLocalCommandResult | Promise<TuiLocalCommandResult>
}

/** Host-side normalized command. */
export interface TuiLocalCommandEntry {
  readonly name: string
  readonly description: string
  readonly descriptions: Partial<Record<Lang, string>>
  readonly handler: TuiLocalCommandDescriptor['handler']
  readonly registrationId: number
  /** Localized description resolved at call time. */
  readonly owner: object
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u
const MAX_COMMANDS = 32
const DESCRIPTION_CELLS = 200
/** Report bounds: a handler cannot flood the transcript. */
const MAX_REPORT_LINES = 100
const MAX_REPORT_CELLS = 400

function validDescriptions(input: unknown): Partial<Record<Lang, string>> {
  if (typeof input !== 'object' || input === null) return {}
  const out: Partial<Record<Lang, string>> = {}
  for (const lang of ['en', 'zh'] as const) {
    const value = (input as Record<string, unknown>)[lang]
    if (typeof value !== 'string') continue
    const clean = cleanScalarText(value, DESCRIPTION_CELLS)
    if (clean !== '') out[lang] = clean
  }
  return out
}

function cleanResult(result: TuiLocalCommandResult): {
  handled: boolean
  lines: readonly string[]
  notice: TuiLocalCommandNotice | undefined
} {
  if (typeof result === 'boolean') return { handled: result, lines: [], notice: undefined }
  if (typeof result !== 'object' || result === null) return { handled: false, lines: [], notice: undefined }
  const lines = Array.isArray(result.lines)
    ? result.lines
      .slice(0, MAX_REPORT_LINES)
      .map(line => cleanScalarText(String(line), MAX_REPORT_CELLS))
    : []
  const rawNotice = result.notice
  const noticeText = typeof rawNotice === 'object' && rawNotice !== null && typeof rawNotice.text === 'string'
    ? cleanScalarText(rawNotice.text, DESCRIPTION_CELLS)
    : ''
  const tone = rawNotice !== undefined && typeof rawNotice === 'object' && rawNotice !== null
    && (rawNotice.tone === 'success' || rawNotice.tone === 'warning' || rawNotice.tone === 'error' || rawNotice.tone === 'info')
    ? rawNotice.tone
    : undefined
  return {
    handled: result.handled !== false,
    lines,
    notice: noticeText === '' ? undefined : { text: noticeText, ...(tone === undefined ? {} : { tone }) },
  }
}

/** Cordis-free store the Chat screen reads. */
export class TuiLocalCommandStore {
  private readonly entries = new Map<string, TuiLocalCommandEntry>()
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private snapshot: readonly TuiLocalCommandEntry[] = Object.freeze([])

  register(
    entry: Omit<TuiLocalCommandEntry, 'registrationId' | 'owner'>,
    owner: object,
  ): (() => void) | undefined {
    if (this.entries.has(entry.name)) return undefined
    if (this.entries.size >= MAX_COMMANDS) return undefined
    this.sequence += 1
    const stored: TuiLocalCommandEntry = Object.freeze({ ...entry, registrationId: this.sequence, owner })
    this.entries.set(stored.name, stored)
    this.emit()
    return () => {
      if (this.entries.get(stored.name)?.registrationId !== stored.registrationId) return
      this.entries.delete(stored.name)
      this.emit()
    }
  }

  list(): readonly TuiLocalCommandEntry[] {
    return this.snapshot
  }

  get(name: string): TuiLocalCommandEntry | undefined {
    return this.entries.get(name)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    this.snapshot = Object.freeze([...this.entries.values()].sort((left, right) =>
      left.registrationId - right.registrationId))
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One subscriber cannot starve the others.
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiCommands: TuiLocalCommandRuntime
  }
}

interface CommandState {
  readonly store: TuiLocalCommandStore
  readonly runtime: AdapterRuntimeOptions
}

const hostCommandStates = new WeakMap<TuiLocalCommandRuntime, CommandState>()

function commandStateFor(runtime: TuiLocalCommandRuntime): CommandState {
  const state = hostCommandStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiCommands host store is unavailable')
  return state
}

/** `ctx.tuiCommands` — plugin-local slash commands. */
export class TuiLocalCommandRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiCommands')
    hostCommandStates.set(this, {
      store: new TuiLocalCommandStore(),
      runtime: adapterRuntimeFor(ctx),
    })
  }

  register(descriptor: TuiLocalCommandDescriptor, identity?: Context): (() => void) | undefined {
    assertCapabilityShadowPolicy('host.commands.register', commandStateFor(this).runtime.mode, commandStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiCommands.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined && identity !== caller) {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register rejected an identity belonging to another activation')
      return undefined
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register requires a live activation owner')
      return undefined
    }
    if (typeof descriptor !== 'object' || descriptor === null) {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register rejected an invalid descriptor')
      return undefined
    }
    if (descriptor.apiVersion !== 1) {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register rejected apiVersion ' + String(descriptor.apiVersion) + ' (expected 1)')
      return undefined
    }
    if (typeof descriptor.name !== 'string' || !NAME_PATTERN.test(descriptor.name)) {
      this.ctx.logger.warn('dsh-tui: tuiCommands.register rejected an invalid command name')
      return undefined
    }
    // Built-ins are local-first: a plugin may never shadow one (nor a hidden
    // command, which is still this app's own name).
    if (LOCAL_COMMANDS.some(command => command.name === descriptor.name) || HIDDEN_COMMAND_NAMES.has(descriptor.name)) {
      this.ctx.logger.warn(`dsh-tui: tuiCommands.register rejected "${descriptor.name}" — a built-in command owns that name`)
      return undefined
    }
    if (typeof descriptor.handler !== 'function') {
      this.ctx.logger.warn(`dsh-tui: tuiCommands.register rejected "${descriptor.name}" — handler must be a function`)
      return undefined
    }
    const description = cleanScalarText(descriptor.description ?? '', DESCRIPTION_CELLS)
    if (description === '') {
      this.ctx.logger.warn(`dsh-tui: tuiCommands.register rejected "${descriptor.name}" — description is required`)
      return undefined
    }
    const dispose = commandStateFor(this).store.register({
      name: descriptor.name,
      description,
      descriptions: validDescriptions(descriptor.descriptions),
      handler: descriptor.handler,
    }, owner)
    if (dispose === undefined) {
      this.ctx.logger.warn(`dsh-tui: tuiCommands.register rejected "${descriptor.name}" — duplicate name or the command budget is full`)
      return undefined
    }
    const bound = bindCallerEffect(caller, dispose)
    if (!bound) {
      dispose()
      return undefined
    }
    return dispose
  }

  /** The calling plugin's own command names (diagnostics). */
  list(): readonly string[] {
    assertCapabilityShadowPolicy('host.commands.list', commandStateFor(this).runtime.mode, commandStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiCommands.list', this)
    } catch {
      return []
    }
    const owner = activationFiber(caller)
    if (owner === undefined) return []
    return commandStateFor(this).store.list().filter(entry => entry.owner === owner).map(entry => entry.name)
  }
}

/** Host-only accessor used by Chat. */
export function getHostCommandStore(runtime: TuiLocalCommandRuntime | undefined): TuiLocalCommandStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostCommandStates.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

/** Run a registered command through the store (host side). */
export async function runHostCommand(
  store: TuiLocalCommandStore,
  name: string,
  input: TuiLocalCommandInput,
): Promise<{ handled: boolean; lines: readonly string[]; notice: TuiLocalCommandNotice | undefined } | undefined> {
  const entry = store.get(name)
  if (entry === undefined) return undefined
  const result = await entry.handler(input)
  return cleanResult(result)
}

export default TuiLocalCommandRuntime
