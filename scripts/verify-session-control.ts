/**
 * `ctx.tuiSessionControl` contract: route snapshot, catalogs, switching,
 * effort tiers, and the advisory subscription that remote surfaces (dsh-monitor)
 * rely on.
 *
 * Run: node --import tsx/esm scripts/verify-session-control.ts
 */

import { createTuiSessionControl, type TuiSessionControlChannel } from '../src/dsh-adapter/session-control.js'

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

type Listener = () => void

function fakeChannel(overrides: Partial<TuiSessionControlChannel> = {}) {
  const listeners = new Set<Listener>()
  const calls: string[] = []
  /** The route's adapter-owned tiers, independent of the live readout cache. */
  const tiers = ['low', 'high']
  const bump = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const channel = {
    sessionId: 'session-1',
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low' as string | undefined,
    effortLevels: ['low', 'high'] as readonly string[] | undefined,
    working: false,
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async listModels() {
      calls.push('listModels')
      return [
        { provider: 'provider-a', id: 'model-a', name: 'Model A' },
        { provider: 'provider-a', id: 'model-b', name: 'Model B' },
      ]
    },
    async listProviders() {
      calls.push('listProviders')
      return [{ id: 'provider-a', name: 'Provider A' }]
    },
    async listEfforts(route?: { provider: string; model: string }) {
      calls.push(route === undefined ? 'listEfforts' : `listEfforts:${route.provider}/${route.model}`)
      return {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      }
    },
    async switchModel(provider: string, model: string) {
      calls.push(`switchModel:${provider}/${model}`)
      if (provider !== 'provider-a' || !['model-a', 'model-b'].includes(model)) return false
      channel.provider = provider
      channel.model = model
      channel.effortLevels = undefined
      channel.reasoningEffort = undefined
      bump()
      return true
    },
    async setEffort(id: string) {
      calls.push(`setEffort:${id}`)
      if (!tiers.includes(id)) return false
      channel.reasoningEffort = id
      channel.effortLevels = tiers
      bump()
      return true
    },
    ...overrides,
  }
  return { channel: channel as TuiSessionControlChannel, calls, bump, raw: channel }
}

{
  const { channel, raw } = fakeChannel()
  const control = createTuiSessionControl(channel)
  const state = control.state()
  check('state reports the bound session', state.sessionId === 'session-1')
  check('state reports the live route', state.provider === 'provider-a' && state.model === 'model-a')
  check('state reports the current effort', state.reasoningEffort === 'low')
  check('state reports the route tiers', JSON.stringify(state.effortLevels) === JSON.stringify(['low', 'high']))
  check('the service is frozen', Object.isFrozen(control))

  const models = await control.listModels()
  check('listModels keeps provider ids intact', models.every(model => model.provider === 'provider-a'))
  check('listModels keeps display names', models[1]?.name === 'Model B')
  const providers = await control.listProviders()
  check('listProviders forwards id/name', providers.length === 1 && providers[0]?.name === 'Provider A')

  const efforts = await control.listEfforts({ provider: 'provider-a', model: 'model-b' })
  check('listEfforts forwards the preview route without mutating it', raw.model === 'model-a')
  check('listEfforts returns the route tiers', efforts.efforts.length === 2 && efforts.defaultEffort === 'low')

  // Mid-turn switching is allowed (pi-style): the running turn keeps its
  // assembled route and the next request re-routes, so `working` no longer
  // refuses a pick.
  raw.working = true
  const midTurn = await control.selectModel({ provider: 'provider-a', model: 'model-b' })
  check('selectModel switches mid-turn', midTurn.ok === true && control.state().model === 'model-b')
  raw.working = false

  const switched = await control.selectModel({ provider: 'provider-a', model: 'model-a' })
  check('selectModel switches the route', switched.ok === true && control.state().model === 'model-a')
  check('selectModel clears the previous route tiers', control.state().effortLevels === undefined)

  const unknown = await control.selectModel({ provider: 'provider-a', model: 'nope' })
  check('selectModel reports an unknown model', unknown.ok === false && unknown.code === 'not_found')
  const blank = await control.selectModel({ provider: ' ', model: '' })
  check('selectModel validates its input', blank.ok === false && blank.code === 'bad_request')

  check('setEffort rejects an unoffered tier', (await control.setEffort('off')) === false)
  check('setEffort applies an offered tier', (await control.setEffort('high')) === true)
  check('setEffort updates the readout', control.state().reasoningEffort === 'high')
}

{
  const { channel, raw, bump } = fakeChannel()
  const control = createTuiSessionControl(channel)
  const seen: string[] = []
  const stop = control.subscribe(state => seen.push(`${state.model}:${state.reasoningEffort ?? '-'}`))

  bump()
  check('an unobservable store bump does not notify', seen.length === 0)
  await control.selectModel({ provider: 'provider-a', model: 'model-b' })
  await control.setEffort('high')
  check('subscribe reports route and effort changes', seen.some(entry => entry === 'model-b:high'), seen.join(','))

  const before = seen.length
  stop()
  raw.reasoningEffort = 'low'
  bump()
  check('subscribe stops after disposal', seen.length === before)
}

{
  const { channel } = fakeChannel()
  const control = createTuiSessionControl(channel)
  const stop = control.subscribe(() => { throw new Error('listener exploded') })
  let survived = true
  try {
    await control.setEffort('high')
  } catch {
    survived = false
  }
  check('a throwing listener cannot break a control action', survived && control.state().reasoningEffort === 'high')
  stop()
}

{
  const { channel, calls } = fakeChannel()
  const control = createTuiSessionControl(channel)
  const result = await control.selectModel({ provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' })
  check('selectModel applies an optional effort after the switch', result.ok === true && control.state().reasoningEffort === 'high')
  check('selectModel issues the effort action', calls.includes('setEffort:high'))
}

{
  const { channel } = fakeChannel({ backendCapabilities: { models: false, effort: false } } as never)
  const control = createTuiSessionControl(channel)
  const refused = await control.selectModel({ provider: 'provider-a', model: 'model-b' })
  check('selectModel reports a backend without model switching as unsupported', refused.ok === false && refused.code === 'unsupported')
  check('setEffort reports a backend without effort switching as false', (await control.setEffort('high')) === false)
}

if (failures > 0) {
  console.error(`verify-session-control FAILED (${failures}/${checks})`)
  process.exitCode = 1
} else {
  console.log(`verify-session-control OK (${checks} checks)`)
}
