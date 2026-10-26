/**
 * Command-report dialog regression: the read-only `/plugin`, `/login`,
 * `/status`, `/doctor` … family opens a scrollable modal instead of appending
 * transcript rows.
 *
 * Covers the shared seam (Chat → chatOverlay `report` → ReportDialog):
 * - `/doctor` renders in the dialog and writes nothing to the transcript;
 * - a report taller than the viewport is reachable with End / Home;
 * - Esc closes it and unmounts the overlay;
 * - `/plugin` diagnostics use the same path (async report).
 *
 * Run after build: `node --import tsx/esm scripts/verify-report-dialog.tsx`
 */
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS },
  { settled, viewportLines },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 24
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const REPORT_LINES = Array.from({ length: 40 }, (_, index) => `REPORT-LINE-${String(index).padStart(2, '0')}`)
const localRows: string[] = []
const stdin = new FakeStdin()
const screen = (): string => viewportLines(term).join('\n')

const channel = {
  version: 0,
  whaleIdle: false,
  rows: [],
  status: 'idle' as const,
  sessionTitle: 'report-probe',
  agentId: 'report-probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  tokens: { input: 0, output: 0 },
  cwd: 'C:/code/demo-project',
  displayCwd: 'C:/code/demo-project',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting' as const,
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications: [],
  contextWindow: undefined,
  reasoningEffort: 'high',
  tps: undefined,
  tpsSamples: [],
  activityFrames: 'moon8',
  activityEnabled: false,
  contextBarEnabled: true,
  agentPreset: 'standard',
  goal: undefined,
  todos: [],
  loadedContext: undefined,
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  modeIndex: 0,
  subscribe: () => () => {},
  submit() {},
  steer() {},
  removePending: () => true,
  cancel() {},
  interruptAndDeliver: () => 0,
  clear() {},
  notify() {},
  pushLocal(title: string, lines: readonly string[]) {
    localRows.push(title, ...lines)
  },
  doctorInfo: () => [...REPORT_LINES],
  pluginsInfo: async () => ['PLUGIN-SECTION-1', 'PLUGIN-SECTION-2'],
  commandCompletions(input: string) {
    const prefix = input.replace(/^\//u, '').trim().toLowerCase()
    return this.commandList
      .filter(command => command.name.startsWith(prefix))
      .map(command => ({ ...command, commandLine: `/${command.name}`, replacement: `/${command.name} ` }))
  },
  listModels: () => Promise.resolve([]),
  runExternalCommand: async () => '',
  loadOlder: () => 0,
  listFiles: async () => [],
  listSessions: () => [],
  previewSession: async () => [],
  setResumeTarget: () => {},
  setActivityFrames: () => true,
  listPresets: async () => [],
  switchPreset: async () => false,
  switchModel: async () => false,
  rewindTo: async () => null,
  resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
  newSession: async () => false,
  mcpStatus: () => [],
  exportSession: () => null,
  initWorkspace: () => null,
  listSubagents: async () => [],
  compact() {},
}

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

const instance = await render(
  <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen />,
  {
    stdout: new FakeStdout(),
    stdin,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

await settled(() => screen().trim() !== '')

// ── /doctor: long report, dialog only, scrollable ──────────────────────────
stdin.write('/doctor\r')
check('doctor: the report opens as a dialog', await settled(() => screen().includes('REPORT-LINE-00')))
check('doctor: the report did NOT append transcript rows', localRows.length === 0, JSON.stringify(localRows))
check('doctor: the dialog title is the command', screen().includes('/doctor'))
check('doctor: the tail starts clipped', !screen().includes('REPORT-LINE-39'))
stdin.write('\x1b[F') // End
check('doctor: End reaches the last line', await settled(() => screen().includes('REPORT-LINE-39')))
stdin.write('\x1b[H') // Home
check('doctor: Home returns to the first line', await settled(() => screen().includes('REPORT-LINE-00') && !screen().includes('REPORT-LINE-39')))
stdin.write('\x1b')
check('doctor: Esc closes the dialog', await settled(() => !screen().includes('REPORT-LINE-00')))

// ── /plugin: the async diagnostics path uses the same dialog ───────────────
stdin.write('/plugin\r')
check('plugin: async diagnostics open the dialog', await settled(() => screen().includes('PLUGIN-SECTION-1') && screen().includes('/plugin')))
check('plugin: diagnostics did NOT append transcript rows', localRows.length === 0, JSON.stringify(localRows))
stdin.write('\x1b')
check('plugin: Esc closes the dialog', await settled(() => !screen().includes('PLUGIN-SECTION-1')))

await instance.unmount()
term.dispose()
assert.equal(failures, 0, `${failures} report-dialog check(s) failed`)
console.log('\nreport dialog checks passed')
