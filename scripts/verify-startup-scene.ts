/**
 * verify-startup-scene — the generic startup-scene seam and the scene command
 * bridge introduced in 0.19 (the core no longer ships a launchpad).
 *
 *   A. Ordinary-launch gate: a `startup: true` scene claims the first frame only
 *      while `setFreshLaunch(true)` holds; a resumed/prompted launch leaves the
 *      screen alone, and a plain scene never auto-opens.
 *   B. First registration wins: a second startup scene waits for an explicit
 *      `open()`.
 *   C. The scene command bridge forwards what Chat publishes and goes quiet when
 *      no runner is registered (bare embed).
 *
 * Run: node --import tsx/esm scripts/verify-startup-scene.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-scene-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_ADAPTER_MODE = 'new'

const { Context } = await import('@deepseek-ai/cordis')
const { TuiSceneRuntime, getHostSceneRuntime } = await import('../src/dsh-adapter/scenes.js')
const { setFreshLaunch } = await import('../src/dsh-adapter/launch-intent.js')
const { runSceneCommand, setSceneCommandRunner } = await import('../src/utils/sceneCommandBridge.js')

let checks = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else failures.push(`${name}${detail === undefined ? '' : `: ${detail}`}`)
}

const noopComponent = (): null => null
const activeOf = (runtime: unknown): string | undefined =>
  getHostSceneRuntime(runtime as never)?.active?.id

// ── A：普通启动门 + 非 startup 场景不自开 ───────────────────────────────────
{
  setFreshLaunch(true)
  const ctx = new Context()
  new TuiSceneRuntime(ctx)
  const fiber = ctx.inject(['tuiScenes'], pluginCtx => {
    pluginCtx.tuiScenes.register({ id: 'plain-probe', component: noopComponent })
    pluginCtx.tuiScenes.register({ id: 'startup-probe', component: noopComponent, startup: true })
  })
  await fiber
  const runtime = ctx.get('tuiScenes')
  check('startup scene claims the first frame of an ordinary launch', activeOf(runtime) === 'startup-probe', String(activeOf(runtime)))
  await fiber.dispose()
  await ctx.fiber.dispose()
}

{
  setFreshLaunch(false)
  const ctx = new Context()
  new TuiSceneRuntime(ctx)
  const fiber = ctx.inject(['tuiScenes'], pluginCtx => {
    pluginCtx.tuiScenes.register({ id: 'startup-probe', component: noopComponent, startup: true })
    pluginCtx.tuiScenes.register({ id: 'plain-probe', component: noopComponent })
  })
  await fiber
  const runtime = ctx.get('tuiScenes')
  check('a resumed/prompted launch never auto-opens a startup scene', activeOf(runtime) === undefined, String(activeOf(runtime)))
  // An explicit open still works (the plugin's own command path).
  check('the scene can still be opened explicitly', getHostSceneRuntime(runtime as never)?.open('startup-probe') === true && activeOf(runtime) === 'startup-probe')
  await fiber.dispose()
  await ctx.fiber.dispose()
}

// ── B：先登记先得 ───────────────────────────────────────────────────────────
{
  setFreshLaunch(true)
  const ctx = new Context()
  new TuiSceneRuntime(ctx)
  const fiber = ctx.inject(['tuiScenes'], pluginCtx => {
    pluginCtx.tuiScenes.register({ id: 'first-startup', component: noopComponent, startup: true })
    pluginCtx.tuiScenes.register({ id: 'second-startup', component: noopComponent, startup: true })
  })
  await fiber
  const runtime = ctx.get('tuiScenes')
  check('the first startup registration wins', activeOf(runtime) === 'first-startup', String(activeOf(runtime)))
  check('the second startup scene stays registered but inactive',
    getHostSceneRuntime(runtime as never)?.list().some(scene => scene.id === 'second-startup') === true && activeOf(runtime) !== 'second-startup')
  await fiber.dispose()
  await ctx.fiber.dispose()
}

// ── C：场景命令桥 ───────────────────────────────────────────────────────────
{
  const lines: string[] = []
  const off = setSceneCommandRunner(line => { lines.push(line) })
  runSceneCommand('/settings')
  check('the published runner receives the command line', lines.join() === '/settings', JSON.stringify(lines))
  off()
  runSceneCommand('/settings')
  check('no runner (bare embed) is a no-op instead of a throw', lines.length === 1, JSON.stringify(lines))
}

setFreshLaunch(false)
rmSync(home, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`verify-startup-scene FAILED (${failures.length}/${checks})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify-startup-scene OK (${checks} checks)`)
process.exit(0)
