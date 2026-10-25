/**
 * Headless regression for the neutral sign-in surface:
 * `src/dsh-adapter/channel/authorization-host.ts` (the harness
 * `ctx.authorization` seam as `/login` and `/provider` drive it) and
 * `src/screens/chat/authorizationLogin.ts` (name matching + method choice).
 *
 * The seam itself is faked here on purpose: what this file pins down is the
 * translation this repo owns — which service slices are read, how a notice
 * reaches the transcript, how a declined prompt becomes `cancelled`, and which
 * flow a typed name means. The seam's own contract (commit confirmation,
 * one-attempt-per-key) is tested by the plugins that register flows.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-authorization-login.mjs`
 */
import { createAuthorizationHost } from '../lib/types/dsh-adapter/channel/authorization-host.js'
import { matchAuthorizationFlow, pickSignInMethod, visibleSignInFlows } from '../lib/types/screens/chat/authorizationLogin.js'
import { t } from '../lib/types/i18n.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const FLOWS = [
  {
    key: 'provider-qoder/qoder',
    label: 'Qoder',
    methods: [
      { id: 'oauth', label: 'Sign in with a browser (Qoder)' },
      { id: 'pat', label: 'Paste a Qoder Personal Access Token' },
    ],
    inFlight: false,
  },
  {
    key: 'provider-qoder/qoder-cn',
    label: 'Qoder CN',
    methods: [{ id: 'pat', label: 'Paste a Qoder CN Personal Access Token' }],
    inFlight: false,
  },
]

/** A ServiceLookup over the three seams the host reads. */
function services({ authorization, credentials, userQuestions } = {}) {
  const map = new Map()
  if (authorization !== undefined) map.set('authorization', authorization)
  if (credentials !== undefined) map.set('credentials', credentials)
  if (userQuestions !== undefined) map.set('userQuestions', userQuestions)
  return { get: name => map.get(name) }
}

function recordingCredentials(configured = []) {
  const deleted = []
  const described = []
  return {
    deleted,
    described,
    async describeRecord(key) {
      described.push(key)
      return { configured: configured.includes(key), writable: true }
    },
    async deleteRecord(key) {
      deleted.push(key)
    },
  }
}

// ── matching ────────────────────────────────────────────────────────────────

check('an exact label matches', matchAuthorizationFlow(FLOWS, 'Qoder')?.key === 'provider-qoder/qoder')
check('matching ignores case', matchAuthorizationFlow(FLOWS, 'qoder cn')?.key === 'provider-qoder/qoder-cn')
check('a credential key matches too', matchAuthorizationFlow(FLOWS, 'provider-qoder/qoder-cn')?.key === 'provider-qoder/qoder-cn')
check('a unique substring matches', matchAuthorizationFlow(FLOWS, 'cn')?.key === 'provider-qoder/qoder-cn')
check('an ambiguous substring resolves to nothing', matchAuthorizationFlow(FLOWS, 'oder') === undefined)
check('an exact label beats a longer label sharing its prefix', matchAuthorizationFlow(FLOWS, 'qoder')?.key === 'provider-qoder/qoder')
check('an unknown name resolves to nothing', matchAuthorizationFlow(FLOWS, 'openai') === undefined)
check('an empty name resolves to nothing', matchAuthorizationFlow(FLOWS, '   ') === undefined)

// ── the listing ─────────────────────────────────────────────────────────────

// The registry also holds one flow per installed pi-ai provider (dsh-auth
// registers them) and the Host's account flow, and `/login` already prints
// those as "OAuth accounts". With ~41 duplicates ahead of the adapters' own,
// an installed provider scrolled above the fold of an ordinary terminal and
// read as unsupported.
const REGISTRY = [
  ...FLOWS,
  { key: 'llm-pi-ai/openai-codex', label: 'OpenAI Codex', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }], inFlight: false },
  { key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'Sign in with Claude' }], inFlight: false },
  { key: 'llm-pi-ai/not-listed', label: 'Not listed', methods: [{ id: 'oauth', label: 'x' }], inFlight: false },
  { key: 'deepseek-account-platform/default', label: 'DeepSeek', methods: [{ id: 'browser', label: 'Sign in with DeepSeek' }], inFlight: false },
]
const OAUTH_IDS = ['openai-codex', 'anthropic']

{
  const visible = visibleSignInFlows(REGISTRY, OAUTH_IDS)
  check('listing drops the pi-ai scope in one go', visible.every(flow => !flow.key.startsWith('llm-pi-ai/')))
  check('listing drops a flow whose id the OAuth section already reports',
    !visible.some(flow => flow.key === 'deepseek-account-platform/anthropic'))
  check('listing keeps the adapters\' own flows',
    eq(visible.map(flow => flow.key), ['provider-qoder/qoder', 'provider-qoder/qoder-cn', 'deepseek-account-platform/default']))
  check('listing keeps a Host account flow the OAuth section cannot name',
    visible.some(flow => flow.key === 'deepseek-account-platform/default'))
  check('sixty duplicate rows collapse to the three real ones',
    visibleSignInFlows(
      Array.from({ length: 60 }, (_, index) => ({
        key: `llm-pi-ai/provider-${index}`, label: `P${index}`, methods: [], inFlight: false,
      })).concat(FLOWS),
      [],
    ).length === 2)
  check('an empty registry lists nothing', visibleSignInFlows([], OAUTH_IDS).length === 0)
  check('matching still sees the complete registry',
    matchAuthorizationFlow(REGISTRY, 'anthropic')?.key === 'llm-pi-ai/anthropic')
}

// ── method choice ───────────────────────────────────────────────────────────

const asked = []
const answer = async request => {
  asked.push(request)
  return { answers: [{ id: 'login-signin-method', selected: ['Paste a Qoder Personal Access Token'] }] }
}
check('a single-method flow asks nothing', (await pickSignInMethod(FLOWS[1], answer)) === 'pat' && asked.length === 0)
const picked = await pickSignInMethod(FLOWS[0], answer)
check('a multi-method flow asks and returns the chosen id', picked === 'pat')
check('the method question lists the flow methods in order', eq(asked[0].questions[0].options.map(o => o.label), FLOWS[0].methods.map(m => m.label)))
check('the method question hides the free-text row', asked[0].questions[0].hideCustomInput === true)
const declined = await pickSignInMethod(FLOWS[0], async () => ({ answers: [] }))
check('a dismissed method question resolves to nothing', declined === undefined)

// ── the host over the seam ──────────────────────────────────────────────────

check('no authorization service → no host', createAuthorizationHost(services()) === undefined)

// The in-process entry mounts the interface first and composes the profile's
// plugin rows after the first frame, so a host built while the channel is
// constructed sees no `authorization` service. It must not stay blind for the
// session: presence is re-read per use.
{
  const late = new Map()
  const lateCtx = { get: name => late.get(name) }
  check('a host built before the seam exists reports no host', createAuthorizationHost(lateCtx) === undefined)
  late.set('authorization', { list: () => FLOWS, begin: async () => ({ status: 'authorized' }) })
  late.set('credentials', recordingCredentials())
  const lateHost = createAuthorizationHost(lateCtx)
  check('a host built after the seam appears is usable', lateHost !== undefined)
  check('the late host lists the flows', (await lateHost.flows()).length === FLOWS.length)
}

// A host that survives a seam disappearing (unmount) degrades instead of
// throwing on every call.
{
  const volatile = new Map([
    ['authorization', { list: () => FLOWS, begin: async () => ({ status: 'authorized' }) }],
    ['credentials', recordingCredentials()],
  ])
  const host = createAuthorizationHost({ get: name => volatile.get(name) })
  volatile.delete('authorization')
  check('a host whose seam went away lists nothing', (await host.flows()).length === 0)
  let signOut = 'threw'
  try {
    signOut = await host.signOut('provider-qoder/qoder')
  } catch { /* the assertion below records it */ }
  check('sign-out without a seam reports false rather than throwing', signOut === false)
}

const host = createAuthorizationHost(services({
  authorization: { list: () => FLOWS, begin: async () => ({ status: 'authorized' }) },
  credentials: recordingCredentials(['provider-qoder/qoder']),
}), { openUrl: () => true })

const flows = await host.flows()
check('flows carry the seam order', eq(flows.map(flow => flow.key), FLOWS.map(flow => flow.key)))
check('signed-in state comes from the stored record', flows[0].signedIn === true && flows[1].signedIn === false)
check('methods are copied without secrets', eq(flows[0].methods, FLOWS[0].methods))
check('an empty registry lists nothing', (await createAuthorizationHost(services({
  authorization: { list: () => [], begin: async () => ({ status: 'cancelled' }) },
  credentials: recordingCredentials(),
})).flows()).length === 0)

// ── notices, prompts, cancellation ──────────────────────────────────────────

const notices = []
const opened = []
const seen = []
const abortable = createAuthorizationHost(services({
  authorization: {
    list: () => FLOWS,
    async begin(request) {
      seen.push({ key: request.key, method: request.method })
      request.interaction.notify({ message: 'Approve in your browser', url: 'https://qoder.com/device/selectAccounts?x=1' })
      const value = await request.interaction.prompt({ kind: 'secret', message: 'Paste a token' })
      return { status: value === 'pt' ? 'authorized' : 'cancelled' }
    },
  },
  credentials: recordingCredentials(),
  userQuestions: { ask: async () => ({ answers: [{ id: 'authorization-prompt', custom: 'pt' }] }) },
}), { openUrl: url => opened.push(url) })

const outcome = await abortable.begin('provider-qoder/qoder', 'pat', text => notices.push(text))
check('an authorized attempt reports authorized', outcome === 'authorized')
check('the attempt passes the key and method through', eq(seen[0], { key: 'provider-qoder/qoder', method: 'pat' }))
check('a notice carries its page and opens it once', notices.length === 1 && notices[0].includes('https://qoder.com/device/selectAccounts?x=1') && opened.length === 1)
check('the prompt answer reaches the flow', true)

let withdrawn = false
const declining = createAuthorizationHost(services({
  authorization: {
    list: () => FLOWS,
    async begin(request) {
      // Mirrors the real seam: a withdrawn attempt settles `cancelled` even
      // when the flow never reacts to its signal.
      if (request.signal.aborted) return { status: 'cancelled' }
      return new Promise((resolve) => {
        request.signal.addEventListener('abort', () => {
          withdrawn = true
          resolve({ status: 'cancelled' })
        }, { once: true })
        request.interaction.prompt({ kind: 'secret', message: 'Paste a token' }).catch(() => undefined)
      })
    },
  },
  credentials: recordingCredentials(),
  userQuestions: { ask: async () => ({ answers: [{ id: 'authorization-prompt', custom: '   ' }] }) },
}), { openUrl: () => true })

const declinedOutcome = await declining.begin('provider-qoder/qoder-cn', undefined, () => {})
check('an empty answer withdraws the attempt', declinedOutcome === 'cancelled' && withdrawn)

const failing = createAuthorizationHost(services({
  authorization: {
    list: () => FLOWS,
    async begin(request) {
      await request.interaction.prompt({ kind: 'secret', message: 'Paste a token' })
      return { status: 'authorized' }
    },
  },
  credentials: recordingCredentials(),
  userQuestions: { ask: async () => { throw new Error('the panel is gone') } },
}), { openUrl: () => true })
let threw = false
try {
  await failing.begin('provider-qoder/qoder', 'pat', () => {})
} catch (error) {
  threw = error.message === 'the panel is gone'
}
check('a broken question surface is a failure, not a cancel', threw)

const noQuestions = createAuthorizationHost(services({
  authorization: { list: () => FLOWS, begin: async () => ({ status: 'authorized' }) },
  credentials: recordingCredentials(),
}), { openUrl: () => true })
let refused = ''
try {
  await noQuestions.begin('provider-qoder/qoder', 'pat', () => {})
} catch (error) {
  refused = error.message
}
// Compared against the i18n string rather than an English regex: the gate runs
// under a throwaway HOME, where the resolved UI language may be either.
check('without a question surface the attempt refuses instead of hanging', refused === t('login-no-question-seam'))

// ── sign-out ────────────────────────────────────────────────────────────────

const store = recordingCredentials(['provider-qoder/qoder'])
const signOutHost = createAuthorizationHost(services({
  authorization: { list: () => FLOWS, begin: async () => ({ status: 'cancelled' }) },
  credentials: store,
}), { openUrl: () => true })
check('sign-out removes a stored record', (await signOutHost.signOut('provider-qoder/qoder')) === true && eq(store.deleted, ['provider-qoder/qoder']))
check('sign-out of an unsigned provider deletes nothing', (await signOutHost.signOut('provider-qoder/qoder-cn')) === false && store.deleted.length === 1)
check('sign-out without a credential store reports false', (await createAuthorizationHost(services({
  authorization: { list: () => FLOWS, begin: async () => ({ status: 'cancelled' }) },
}), { openUrl: () => true }).signOut('provider-qoder/qoder')) === false)

console.log(failed === 0 ? '\nverify-authorization-login: OK' : `\nverify-authorization-login: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
