/**
 * `tuiDock` regression: registration, order, duplicate refusal, host snapshot
 * and row clipping through the same `PluginDockRow` Chat renders.
 *
 * Run: node --import tsx/esm scripts/verify-extension-dock.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'

const [{ default: React }, { renderToScreen }, { cellAt }, { TerminalSizeContext }, ui, { TuiDockStore }, { PluginDockRow }] = await Promise.all([
  import('react'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/ui.js'),
  import('../src/dsh-adapter/dock.js'),
  import('../src/components/PluginDockRow.js'),
])

const { Text } = ui
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : ` (${detail})`}`)
}

const store = new TuiDockStore()
const snapshot = {
  sessionId: 's1',
  cwd: '/tmp',
  lang: 'en',
  working: true,
  version: 1,
  goal: { id: 'g', revision: 1, objective: 'ship the extraction', phase: 'active' as const, maxGoalRounds: 8, roundsStarted: 2 },
  todos: [{ content: 'decouple goal', status: 'in_progress' as const }],
}

const first = store.register({
  id: 'first',
  title: 'First',
  order: 20,
  maxRows: 1,
  component: ({ host }: { host: { snapshot(): typeof snapshot } }) => React.createElement(Text, null, `DOCK ${host.snapshot().goal?.objective ?? 'none'}`),
}, {})
const second = store.register({
  id: 'second',
  title: 'Second',
  order: 10,
  maxRows: 1,
  component: () => React.createElement(Text, null, 'CLIPPED-ROW-1\nCLIPPED-ROW-2'),
}, {})
check('registrations accepted', first !== undefined && second !== undefined)
check('ordered by order then registration', store.list().map(entry => entry.id).join(',') === 'second,first')
check('duplicate id refused', store.register({ id: 'first', title: 'dup', order: 0, maxRows: 1, component: () => null }, {}) === undefined)

const render = (entry: (typeof store.list)[number]): string => {
  const { screen, height } = renderToScreen(
    React.createElement(TerminalSizeContext.Provider, { value: { columns: 60, rows: 20 } },
      React.createElement(PluginDockRow, {
        entry,
        snapshot,
        panelEnabled: subId => subId === 'todo',
        sidePanelSplit: true,
        width: 60,
        toast: () => true,
        onError: () => undefined,
      })),
    60,
  )
  const rows: string[] = []
  for (let row = 0; row < height; row++) {
    let line = ''
    for (let col = 0; col < 60; col++) line += cellAt(screen, col, row)?.char ?? ' '
    rows.push(line)
  }
  return rows.join('\n')
}

const firstRow = render(store.list()[1]!)
check('host snapshot reaches the component', firstRow.includes('DOCK ship the extraction'), firstRow.trim())

const secondRow = render(store.list()[0]!)
check('maxRows clips the second row', secondRow.includes('CLIPPED-ROW-1') && !secondRow.includes('CLIPPED-ROW-2'), secondRow.trim())

first?.()
check('dispose removes the row', store.list().some(entry => entry.id === 'first') === false)
second?.()
check('store empty after disposal', store.list().length === 0)

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nverify-extension-dock OK')
