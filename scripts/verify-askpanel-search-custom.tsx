/**
 * AskUserQuestionPanel search-first regression (the `/provider` model list).
 *
 * A long question WITH a free-text answer row used to give that row every
 * keystroke, so the model list could not be searched at all. The row is now
 * an option: plain typing filters, Enter on the row arms its caret, and only
 * then does typing edit the answer. Short lists keep issue #9's inline
 * append (`type on an option = custom answer`).
 *
 * Run: node --import tsx/esm scripts/verify-askpanel-search-custom.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }, { settle, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 32
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
function screen(): string {
  return viewportLines(term, ROWS).join('\n')
}

let answer: unknown
let cancelled = false
const app = await render(
  React.createElement(AskUserQuestionPanel, {
    position: 1, total: 1, answered: 0,
    onAnswer: (selection: unknown) => { answer = selection },
    onCancel: () => { cancelled = true },
    question: { question: '占位', options: [{ label: 'x' }] },
  }),
  { stdout, stdin, stderr: new FakeStdout(), debug: true, exitOnCtrlC: false, patchConsole: false },
)
await settle(() => screen().includes('占位'))

let failures = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const MODELS = Array.from({ length: 12 }, (_, index) => ({
  label: `model-${String(index).padStart(2, '0')}`,
  description: `Model ${String(index).padStart(2, '0')}`,
}))

let mountSeq = 0
async function mount(question: Record<string, unknown>, ready: () => boolean): Promise<void> {
  answer = undefined
  cancelled = false
  app.rerender(React.createElement(AskUserQuestionPanel, {
    key: `q${++mountSeq}`,
    position: 1, total: 1, answered: 0,
    onAnswer: (selection: unknown) => { answer = selection },
    onCancel: () => { cancelled = true },
    question,
  }))
  await settle(ready)
}

const modelQuestion = (question: string, extra: Record<string, unknown> = {}) => ({
  question,
  options: MODELS,
  multiSelect: true,
  ...extra,
})

// ── 1. long list + answer row: typing filters, not the answer ────────────
await mount(modelQuestion('选择要启用的模型'), () => screen().includes('model-00') && screen().includes('自定义回答'))
check('1 long list renders the filter row', await settled(() => screen().includes('输入以筛选…')))
check('1 long list renders the answer row as an option', await settled(() => screen().includes('自定义回答')))
stdin.write('model-11')
const filtered = await settled(() => screen().includes('model-11') && !screen().includes('model-00'))
check('1 typing narrows to the match', filtered)
check('1 typing did not arm the answer row', await settled(() => screen().includes('model-11') && screen().includes('按 Enter 输入…')))

// ── 2. Backspace widens the query again ──────────────────────────────────
stdin.write('\x7f'.repeat('model-11'.length))
check('2 Backspace clears the query', await settled(() => screen().includes('输入以筛选…')))

// ── 3. no match → ↓ reaches the answer option, Enter arms it ─────────────
stdin.write('zzz')
await settle(() => screen().includes('没有匹配'))
stdin.write('\x1b[B')
await sleep(80) // 固定窗:pacing — 焦点移动只改行高亮，无独有文本
stdin.write('\r')
check('3 Enter on the unarmed answer row does not submit',
  await settled(() => answer === undefined && screen().includes('输入回答')), JSON.stringify(answer))
check('3 text mode shows the type-answer hint', await settled(() => screen().includes('Enter 提交') && screen().includes('输入回答')))
stdin.write('custom-model')
await settle(() => screen().includes('custom-model'))
stdin.write('\r')
check('3 Enter after arming submits the custom answer',
  await settled(() => eq(answer, { selected: [], custom: 'custom-model' })), JSON.stringify(answer))

// ── 4. Space checks the filtered option; Enter submits the checked set ───
await mount(modelQuestion('选择要启用的模型'), () => screen().includes('model-00') && screen().includes('输入以筛选…'))
stdin.write('03')
await settle(() => screen().includes('model-03') && !screen().includes('model-04'))
stdin.write(' ')
check('4 Space toggles the focused match while a query is active',
  await settled(() => screen().includes('◉ model-03')))
stdin.write('\r')
check('4 Enter submits the checked option',
  await settled(() => eq(answer, { selected: ['model-03'] })), JSON.stringify(answer))

// ── 5. single-select: filter then Enter answers the match ───────────────
answer = undefined
app.rerender(React.createElement(AskUserQuestionPanel, {
  key: `q${++mountSeq}`,
  position: 1, total: 1, answered: 0,
  onAnswer: (selection: unknown) => { answer = selection },
  onCancel: () => { cancelled = true },
  question: { question: '选择模型', options: MODELS },
}))
await settle(() => screen().includes('model-00') && screen().includes('输入以筛选…'))
stdin.write('05')
await settle(() => screen().includes('model-05') && !screen().includes('model-04'))
stdin.write('\r')
check('5 single-select Enter answers the filtered row',
  await settled(() => eq(answer, { selected: ['model-05'] })), JSON.stringify(answer))

// ── 6. short list keeps issue #9: typing on an option is the answer ──────
await mount({
  question: '短列表自定义回答',
  options: [{ label: 'deepseek-chat' }, { label: 'deepseek-reasoner' }],
  multiSelect: true,
}, () => screen().includes('deepseek-chat') && screen().includes('自定义回答'))
check('6 short list has no filter row', await settled(() => !screen().includes('输入以筛选…')))
stdin.write('extra-model')
await settle(() => screen().includes('extra-model'))
stdin.write('\r')
check('6 short-list typing still appends the custom answer',
  await settled(() => eq(answer, { selected: [], custom: 'extra-model' })), JSON.stringify(answer))

app.unmount()
console.log(failures === 0 ? '\nAll search-first answer-row checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
