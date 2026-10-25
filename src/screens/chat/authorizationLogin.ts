/**
 * `/login` and `/logout` over the harness authorization seam.
 *
 * The channel methods (`authorizationFlows`, `signInToCredential`,
 * `signOutCredential`) do the work; this module holds the two decisions that
 * are worth testing on their own — which flow a typed name means, and which
 * method to run when a flow offers more than one.
 *
 * @module @deepseek-harness-tui/dsh-tui/screens/chat/authorizationLogin
 */

import type { AuthorizationFlowStatus } from '../../adapter/ports/channel-settings.js'
import { t } from '../../i18n.js'

/**
 * Credential-record scope a dsh-auth-style login writes for each pi-ai
 * provider. Those flows are already reported by `/login`'s "OAuth accounts"
 * section (they are the same providers), so the neutral section skips them.
 */
const PI_AI_SCOPE = 'llm-pi-ai'

/**
 * The flows `/login` lists under "Sign in providers".
 *
 * The neutral registry holds one flow per installed pi-ai provider too —
 * dsh-auth registers them, and the Host registers its own account flow — and
 * `/login` already prints those as "OAuth accounts". Repeating them here was
 * not a cosmetic duplicate: with forty-odd pi-ai flows ahead of the adapters'
 * own, the real entries sat above the fold of an ordinary terminal and
 * scrolled out of sight, so an installed provider read as "not supported".
 *
 * A flow whose id segment is one the OAuth section already reports is
 * therefore dropped from the listing. Matching (`/login <name>`) deliberately
 * keeps the complete registry, so the pi-ai providers stay addressable.
 */
export function visibleSignInFlows(
  flows: readonly AuthorizationFlowStatus[],
  oauthProviderIds: readonly string[],
): AuthorizationFlowStatus[] {
  const covered = new Set(oauthProviderIds)
  return flows.filter(flow => {
    const separator = flow.key.indexOf('/')
    const scope = separator === -1 ? flow.key : flow.key.slice(0, separator)
    const id = separator === -1 ? '' : flow.key.slice(separator + 1)
    if (scope === PI_AI_SCOPE) return false
    return !covered.has(id)
  })
}

/**
 * Resolve a `/login <target>` argument to one flow.
 *
 * An exact label or credential key wins; otherwise a unique substring matches,
 * so `/login qoder` reaches "Qoder" and `/login cn` reaches "Qoder CN" without
 * this file inventing aliases the plugin never declared. An ambiguous or
 * unknown name resolves to `undefined` and the caller lists what exists.
 */
export function matchAuthorizationFlow(
  flows: readonly AuthorizationFlowStatus[],
  target: string,
): AuthorizationFlowStatus | undefined {
  const needle = target.trim().toLowerCase()
  if (needle === '') return undefined
  const exact = flows.find(
    flow => flow.label.toLowerCase() === needle || flow.key.toLowerCase() === needle,
  )
  if (exact !== undefined) return exact
  const partial = flows.filter(
    flow => flow.label.toLowerCase().includes(needle) || flow.key.toLowerCase().includes(needle),
  )
  return partial.length === 1 ? partial[0] : undefined
}

/**
 * The ask surface `pickSignInMethod` drives — the shared question panel.
 *
 * Declared structurally rather than imported from the harness package: this
 * layer is vendor-neutral (`verify:boundary`), and the panel's own request type
 * is a superset of what an option question needs, so the real handle assigns
 * here without a cast.
 */
export type SignInAsk = (request: { questions: PanelQuestionItem[] }) => Promise<PanelAnswer>

/** One question as this layer builds it. */
interface PanelQuestionItem {
  id: string
  header: string
  question: string
  options?: readonly { label: string; description?: string }[]
  /** Local presentation extension: a pure option question hides the free-text row. */
  hideCustomInput?: boolean
}

/** The answer rows this layer reads. */
interface PanelAnswer {
  answers: readonly { id: string; selected?: readonly string[] }[]
}

/**
 * The method to run: a single-method flow needs no question, and a flow with
 * several asks which one (the flow's own order is the preference order, so the
 * first option is the recommended one). `undefined` means the human cancelled.
 */
export async function pickSignInMethod(
  flow: AuthorizationFlowStatus,
  ask: SignInAsk,
): Promise<string | undefined> {
  const [only, ...rest] = flow.methods
  if (only === undefined) return undefined
  if (rest.length === 0) return only.id
  const question: PanelQuestionItem = {
    id: 'login-signin-method',
    header: '/login',
    question: t('login-signin-method', { provider: flow.label }),
    options: flow.methods.map(method => ({ label: method.label })),
    hideCustomInput: true,
  }
  const answer = await ask({ questions: [question] })
  const label = answer.answers.find(row => row.id === 'login-signin-method')?.selected?.[0]
  return flow.methods.find(method => method.label === label)?.id
}
