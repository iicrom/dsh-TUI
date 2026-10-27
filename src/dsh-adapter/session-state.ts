/**
 * `ctx.tuiSessionState` — a read-only, subscribable view of the live session
 * for sibling plugins.
 *
 * The Channel owns the session projection (`goal.change` / `todo.write`
 * folded into `goal` and `todos`). A plugin that contributes UI (a dock row,
 * a side panel, a status view, a slash command) cannot reach the Channel
 * object itself, so this seam hands it the curated slice those surfaces need:
 * identity, working state, the goal snapshot and the latest todo list.
 *
 * Contract notes:
 *
 * - Every call resolves the live channel lazily. Before a session binds the
 *   snapshot is the empty one (`sessionId: ''`, no goal, no todos).
 * - The snapshot is structurally copied and frozen on every call: a plugin
 *   cannot mutate the projection through it, and stale references cannot
 *   change under a render.
 * - `subscribe` follows the same notifications as the Channel's version
 *   counter. Throwing listeners are contained here so a faulty plugin cannot
 *   break the TUI's own subscription chain.
 *
 * @module session-state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ChannelGoal, TodoPanelItem } from '../adapter/ports/channel-view.js'
import { getLang } from '../i18n.js'

/** The goal slice a plugin may read. Same fields the Channel exposes. */
export interface TuiSessionGoal {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: { readonly code: string; readonly message: string }
  readonly budget?: {
    readonly tokensUsed: number
    readonly tokenBudget: number | null
    readonly timeUsedSeconds: number
  }
}

/** One todo row a plugin may read. */
export interface TuiSessionTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The curated session view published to plugins. */
export interface TuiSessionSnapshot {
  readonly sessionId: string
  readonly cwd: string
  /** Active UI language, so a plugin can localize its own copy. */
  readonly lang: string
  readonly working: boolean
  /** The Channel's state version; changes on every projection update. */
  readonly version: number
  readonly goal?: TuiSessionGoal
  readonly todos: readonly TuiSessionTodo[]
}

/**
 * The read side of the live session. Both methods are cheap and safe to call
 * from a React `useSyncExternalStore` pair.
 */
export interface TuiSessionState {
  snapshot(): TuiSessionSnapshot
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiSessionState: TuiSessionState
  }
}

/** The channel members this seam reads (structural on purpose). */
export interface TuiSessionStateChannel {
  readonly sessionId: string
  readonly cwd: string
  readonly working: boolean
  readonly version: number
  readonly goal?: ChannelGoal
  readonly todos: readonly TodoPanelItem[]
  subscribe(listener: () => void): () => void
}

const EMPTY_TODOS: readonly TuiSessionTodo[] = Object.freeze([])

export function sessionGoalOf(goal: ChannelGoal | undefined): TuiSessionGoal | undefined {
  if (goal === undefined) return undefined
  return Object.freeze({
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: goal.roundsStarted,
    ...(goal.blockedReason === undefined
      ? {}
      : { blockedReason: Object.freeze({ code: goal.blockedReason.code, message: goal.blockedReason.message }) }),
    ...(goal.budget === undefined
      ? {}
      : {
        budget: Object.freeze({
          tokensUsed: goal.budget.tokensUsed,
          tokenBudget: goal.budget.tokenBudget,
          timeUsedSeconds: goal.budget.timeUsedSeconds,
        }),
      }),
  })
}

export function sessionTodosOf(todos: readonly TodoPanelItem[] | undefined): readonly TuiSessionTodo[] {
  if (todos === undefined || todos.length === 0) return EMPTY_TODOS
  return Object.freeze(todos.map(todo => Object.freeze({ content: todo.content, status: todo.status })))
}

/**
 * Build the service over the live channel. The channel is mutable in place
 * (a session switch updates its fields), so one reference stays current for
 * the row's lifetime.
 */
export function createTuiSessionState(channel: TuiSessionStateChannel): TuiSessionState {
  return Object.freeze({
    snapshot: (): TuiSessionSnapshot => Object.freeze({
      sessionId: channel.sessionId,
      cwd: channel.cwd,
      lang: getLang(),
      working: channel.working,
      version: channel.version,
      ...(channel.goal === undefined ? {} : { goal: sessionGoalOf(channel.goal) }),
      todos: sessionTodosOf(channel.todos),
    }),
    subscribe: (listener: () => void): (() => void) => {
      if (typeof listener !== 'function') return () => {}
      return channel.subscribe(() => {
        try {
          listener()
        } catch {
          // A plugin listener must not break the host's subscription chain.
        }
      })
    },
  })
}
