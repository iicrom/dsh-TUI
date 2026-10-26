/**
 * `ctx.tuiSessionControl` — the live TUI session's model/reasoning-effort
 * control surface for sibling plugins.
 *
 * The TUI owns the session's `ModelSelectionRef` and the persisted `/model` /
 * `/effort` preferences; a plugin cannot drive either by talking to the agent
 * directly. This service is the smallest stable seam for a remote surface
 * (dsh-monitor / pi-monitor clients): it reads the live route, lists the
 * configured providers/models and the route's effort tiers, then delegates a
 * switch to the same channel actions the local `/model` and `/effort`
 * commands use. The working gate, persistence and user notices therefore stay
 * exactly where they are for a local pick.
 *
 * Contract notes:
 *
 * - Every call resolves the live channel lazily. The plugin row can boot
 *   before a session is mounted; `state().sessionId` is then `undefined` and
 *   a consumer must treat the surface as unavailable for that session.
 * - `selectModel` / `setEffort` are host actions, not prompts: they never
 *   enqueue a model message and never bypass the channel's `working` gate.
 * - Listeners are advisory. A throwing listener is contained here so a faulty
 *   plugin cannot break the TUI's reactive store.
 *
 * @module session-control
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ChannelState } from './channel/types.js'

/** The live route + effort readout a consumer mirrors. */
export interface TuiSessionControlState {
  /** The mounted session, or `undefined` before one binds. */
  readonly sessionId: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  /** The selected `reasoningEffort`; `undefined` means the route default. */
  readonly reasoningEffort: string | undefined
  /** Tiers the live route offers, once its metadata has resolved. */
  readonly effortLevels: readonly string[] | undefined
}

/** One selectable model. */
export interface TuiSessionControlModel {
  readonly provider: string
  readonly id: string
  readonly name?: string
}

/** One configured provider. */
export interface TuiSessionControlProvider {
  readonly id: string
  readonly name?: string
}

/** One reasoning-effort tier offered by a route. */
export interface TuiSessionControlEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** A route's effort tiers (and the adapter default when it names one). */
export interface TuiSessionControlEfforts {
  readonly efforts: readonly TuiSessionControlEffort[]
  readonly defaultEffort?: string
  /** The offer is the CLI-standard ladder, not the model's own tier list. */
  readonly levelsFallback?: true
}

/** Refusal reasons a remote caller can map onto its own error codes. */
export type TuiSessionControlFailureCode = 'busy' | 'not_found' | 'bad_request' | 'unsupported'

export type TuiSessionControlSelection =
  | { readonly ok: true; readonly state: TuiSessionControlState }
  | { readonly ok: false; readonly code: TuiSessionControlFailureCode; readonly message: string }

export interface TuiSessionControl {
  /** Current route/effort snapshot. Cheap; safe to poll. */
  state(): TuiSessionControlState
  /** Every configured provider (DSH `llm.listProviders`). */
  listProviders(): Promise<readonly TuiSessionControlProvider[]>
  /** Every model across configured providers, with route ids intact. */
  listModels(): Promise<readonly TuiSessionControlModel[]>
  /**
   * The live route's tiers, or a candidate route's tiers when `route` is
   * given (a preview that changes no live state).
   */
  listEfforts(route?: { readonly provider: string; readonly model: string }): Promise<TuiSessionControlEfforts>
  /**
   * Select the next request's route. Refused while the session is working,
   * exactly like a local `/model`. `reasoningEffort` is applied after the
   * route switch when the new route offers it.
   */
  selectModel(input: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<TuiSessionControlSelection>
  /** Set one effort tier by id (validated against the live route). */
  setEffort(id: string): Promise<boolean>
  /** Watch route/effort changes; the listener gets the new snapshot. */
  subscribe(listener: (state: TuiSessionControlState) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiSessionControl: TuiSessionControl
  }
}

/** The channel members this seam consumes (kept structural on purpose). */
export type TuiSessionControlChannel = Pick<
  ChannelState,
  | 'sessionId'
  | 'provider'
  | 'model'
  | 'reasoningEffort'
  | 'effortLevels'
  | 'backendCapabilities'
  | 'working'
  | 'subscribe'
  | 'listModels'
  | 'listProviders'
  | 'listEfforts'
  | 'switchModel'
  | 'setEffort'
>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function signatureOf(state: TuiSessionControlState): string {
  return JSON.stringify([
    state.sessionId,
    state.provider,
    state.model,
    state.reasoningEffort,
    state.effortLevels,
  ])
}

/**
 * Build the service over the live channel. The channel is mutable in place
 * (a session switch updates its fields, it is not replaced), so a direct
 * reference stays current for the row's lifetime.
 */
export function createTuiSessionControl(channel: TuiSessionControlChannel): TuiSessionControl {
  const state = (): TuiSessionControlState => ({
    sessionId: channel.sessionId,
    provider: channel.provider,
    model: channel.model,
    reasoningEffort: channel.reasoningEffort,
    effortLevels: channel.effortLevels,
  })

  const listModels = async (): Promise<readonly TuiSessionControlModel[]> => {
    const models = await channel.listModels()
    return models.map(model => ({
      provider: model.provider,
      id: model.id,
      ...(typeof model.name === 'string' ? { name: model.name } : {}),
    }))
  }

  const listProviders = async (): Promise<readonly TuiSessionControlProvider[]> => {
    const providers = await channel.listProviders()
    return providers.map(provider => ({
      id: provider.id,
      ...(typeof provider.name === 'string' ? { name: provider.name } : {}),
    }))
  }

  const listEfforts = async (
    route?: { readonly provider: string; readonly model: string },
  ): Promise<TuiSessionControlEfforts> => {
    const result = await channel.listEfforts(route)
    return {
      efforts: result.efforts.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
      ...(result.defaultEffort === undefined ? {} : { defaultEffort: result.defaultEffort }),
      ...(result.levelsFallback === true ? { levelsFallback: true as const } : {}),
    }
  }

  const selectModel = async (input: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<TuiSessionControlSelection> => {
    const provider = typeof input?.provider === 'string' ? input.provider.trim() : ''
    const model = typeof input?.model === 'string' ? input.model.trim() : ''
    if (provider === '' || model === '') {
      return { ok: false, code: 'bad_request', message: 'provider and model are required' }
    }
    if (channel.backendCapabilities?.models === false) {
      return { ok: false, code: 'unsupported', message: 'model switching is not available on this backend' }
    }
    // Mirrors createModelSwitchAction's entry gate. Checking here keeps the
    // refusal attributable without waiting for the channel's own notice.
    if (channel.working) {
      return { ok: false, code: 'busy', message: 'the session is working; retry when idle' }
    }
    let switched = false
    try {
      switched = await channel.switchModel(provider, model)
    } catch (error) {
      return { ok: false, code: 'bad_request', message: messageOf(error) }
    }
    if (!switched) {
      return {
        ok: false,
        code: channel.working ? 'busy' : 'not_found',
        message: `model ${provider}/${model} was not selected`,
      }
    }
    if (typeof input.reasoningEffort === 'string' && input.reasoningEffort !== '') {
      try {
        await channel.setEffort(input.reasoningEffort)
      } catch {
        // The route switch already landed; an unsupported tier is reported
        // through the state/effort list rather than undoing the model pick.
      }
    }
    return { ok: true, state: state() }
  }

  const setEffort = async (id: string): Promise<boolean> => {
    if (typeof id !== 'string' || id.trim() === '') return false
    if (channel.backendCapabilities?.effort === false) return false
    try {
      return await channel.setEffort(id.trim())
    } catch {
      return false
    }
  }

  const subscribe = (listener: (state: TuiSessionControlState) => void): (() => void) => {
    let last = signatureOf(state())
    let disposed = false
    const unsubscribe = channel.subscribe(() => {
      if (disposed) return
      const next = state()
      const signature = signatureOf(next)
      if (signature === last) return
      last = signature
      try {
        listener(next)
      } catch {
        // A plugin listener must never break the TUI reactive store.
      }
    })
    return () => {
      if (disposed) return
      disposed = true
      try {
        unsubscribe()
      } catch {
        // best effort
      }
    }
  }

  return Object.freeze({
    state,
    listModels,
    listProviders,
    listEfforts,
    selectModel,
    setEffort,
    subscribe,
  })
}
