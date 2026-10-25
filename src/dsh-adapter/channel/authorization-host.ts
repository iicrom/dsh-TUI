/**
 * The harness `authorization` seam as the TUI renders it.
 *
 * `/login` and the `/provider` wizard both drive sign-ins through this module,
 * and neither knows which plugin owns the protocol: a flow is listed by its
 * label, its methods, and whether a credential is stored, and running it is one
 * `begin()` call. That is what lets a third-party adapter (Qoder, say) offer
 * browser sign-in or a pasted token beside the pi-ai providers — the TUI only
 * renders the neutral vocabulary the seam defines.
 *
 * Everything here is structural: the seam's own types stay in its package, so
 * this tree keeps compiling against hosts that predate it, and a composition
 * without `ctx.authorization` reports `undefined` (the pre-existing `/login`
 * output) instead of an empty section.
 *
 * Two seam rules shape the implementation:
 *
 * - **The flow owns the write.** `begin()` reports `authorized` only after the
 *   record was committed through `ctx.credentials`, so a resolved attempt needs
 *   no bookkeeping here.
 * - **"No" is an outcome, not a breakage.** Only the seam's own declined error
 *   settles `cancelled`; a surface that cannot construct it withdraws the
 *   attempt's signal instead, which settles the same way. That is how Esc on a
 *   prompt becomes `cancelled` rather than a failed sign-in.
 *
 * @module @deepseek-harness-tui/dsh-tui/channel/authorization-host
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { t } from '../../i18n.js'
import type {
  AuthorizationFlowStatus,
  AuthorizationSetupHost,
  AuthorizationSignInOutcome,
} from '../../adapter/ports/channel-settings.js'
import type { ServiceLookup } from './channel-host.js'
import { openInBrowser } from '../oauth/opener.js'

/** The `authorization` service slice this module uses (rc-stable, structural). */
interface AuthorizationSeam {
  list(): readonly {
    key: string
    label: string
    methods: readonly { id: string; label: string }[]
    inFlight: boolean
  }[]
  begin(request: {
    key: string
    method?: string
    interaction: {
      notify(notice: { message: string; url?: string; code?: string }): void
      prompt(prompt: {
        kind: 'text' | 'secret' | 'select'
        message: string
        placeholder?: string
        options?: readonly { id: string; label: string; description?: string }[]
      }): Promise<string>
    }
    signal?: AbortSignal
  }): Promise<{ status: AuthorizationSignInOutcome }>
}

/** The `credentials` service slice this module uses. */
interface CredentialSeam {
  describeRecord(key: string): Promise<{ configured: boolean; writable: boolean }>
  deleteRecord(key: string): Promise<void>
}

/** The `userQuestions` service slice this module uses. */
interface QuestionSeam {
  ask(request: { questions: AskUserQuestionItem[]; signal?: AbortSignal }): Promise<AskUserQuestionAnswer>
}

/** Injectable conveniences so a test drives the module without a browser. */
export interface AuthorizationHostOptions {
  /** Open a page a browser flow needs; defaults to the host opener. */
  readonly openUrl?: (url: string) => boolean
}

/**
 * The sign-in host over `ctx.authorization` / `ctx.credentials` /
 * `ctx.userQuestions`, or `undefined` when the composition mounts no
 * authorization service.
 */
export function createAuthorizationHost(
  ctx: ServiceLookup,
  options: AuthorizationHostOptions = {},
): AuthorizationSetupHost | undefined {
  const openUrl = options.openUrl ?? openInBrowser

  const seam = (): AuthorizationSeam | undefined =>
    ctx.get('authorization') as AuthorizationSeam | undefined
  const credentials = (): CredentialSeam | undefined =>
    ctx.get('credentials') as CredentialSeam | undefined
  const questions = (): QuestionSeam | undefined =>
    ctx.get('userQuestions') as QuestionSeam | undefined

  if (seam() === undefined) return undefined

  return {
    async flows(): Promise<readonly AuthorizationFlowStatus[]> {
      const service = seam()
      if (service === undefined) return []
      const store = credentials()
      return Promise.all(service.list().map(async (entry) => {
        // Presence is the whole fact for a record: a grant that expired is
        // still a sign-in, because its owner renews it on the next request.
        const info = store === undefined
          ? undefined
          : await store.describeRecord(entry.key).catch(() => undefined)
        return {
          key: entry.key,
          label: entry.label,
          methods: entry.methods.map((method) => ({ id: method.id, label: method.label })),
          inFlight: entry.inFlight,
          signedIn: info?.configured === true,
        }
      }))
    },

    async begin(
      key: string,
      method: string | undefined,
      notify: (text: string) => void,
      signal?: AbortSignal,
    ): Promise<AuthorizationSignInOutcome> {
      const service = seam()
      if (service === undefined) throw new Error(t('login-no-signin-seam'))
      const ask = questions()
      if (ask === undefined) throw new Error(t('login-no-question-seam'))

      // The attempt's own signal is what a declined prompt withdraws: the seam
      // settles `cancelled` on withdrawal, and no error class has to cross a
      // package boundary to say "the human said no".
      const attempt = new AbortController()
      const withdraw = (): void => attempt.abort()
      signal?.addEventListener('abort', withdraw, { once: true })
      try {
        const outcome = await service.begin({
          key,
          ...(method === undefined ? {} : { method }),
          signal: attempt.signal,
          interaction: {
            notify: (notice) => {
              if (notice.url !== undefined) openUrl(notice.url)
              notify(describeNotice(notice))
            },
            prompt: async (prompt) => {
              const answer = await ask.ask({
                questions: [promptQuestion(prompt)],
                signal: attempt.signal,
              }).catch((error: unknown) => {
                withdraw()
                throw error
              })
              const row = answer.answers[0]
              // `selected` is absent on a custom-answer row and `custom` is
              // absent on an option row, so both are optional at runtime even
              // though the panel's own type marks one of them required.
              const value = (row?.selected?.[0] ?? row?.custom ?? '').trim()
              if (value === '') {
                withdraw()
                throw new Error(t('login-prompt-declined'))
              }
              return value
            },
          },
        })
        return outcome.status
      } finally {
        signal?.removeEventListener('abort', withdraw)
      }
    },

    async signOut(key: string): Promise<boolean> {
      const store = credentials()
      if (store === undefined) return false
      const info = await store.describeRecord(key).catch(() => undefined)
      if (info?.configured !== true) return false
      await store.deleteRecord(key)
      return true
    },
  }
}

/** One notice as the line the transcript shows. */
function describeNotice(notice: { message: string; url?: string; code?: string }): string {
  const parts = [notice.message]
  if (notice.url !== undefined) parts.push(notice.url)
  if (notice.code !== undefined) parts.push(notice.code)
  return parts.join(' — ')
}

/**
 * One seam prompt as one question. `secret` is the same shape as `text` — the
 * panel's redaction is the caller's business — and `select` carries its
 * options, so a flow that picks among accounts renders natively.
 */
function promptQuestion(prompt: {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string; description?: string }[]
}): AskUserQuestionItem {
  const item: AskUserQuestionItem = {
    id: 'authorization-prompt',
    header: '/login',
    question: prompt.message,
  }
  if (prompt.kind !== 'select' || prompt.options === undefined) return item
  return {
    ...item,
    options: prompt.options.map(option => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    hideCustomInput: true,
  } as AskUserQuestionItem
}
