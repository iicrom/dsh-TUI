/**
 * Divider available-width regression: the rule must fill the width Yoga
 * grants it instead of assuming full terminal width — nested in a narrower
 * container (the transcript beside the 2-column timeline-rail gutter) a
 * full-width rule wrapped onto a second row ("Session summary is ready"
 * notice splitting in narrow windows). Asserts a single row at the exact
 * available width, with and without the gutter, and that an explicit
 * \`width\` prop still wins. Also pins the two long-title contracts: a plain
 * Divider clips (navigation labels stay one row), while a notice row
 * (titleWrap) flows the whole message onto further rule-framed rows.
 * Run: node --import tsx/esm scripts/verify-divider-width.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal: XTerm }, ui, { Divider }, { MessageList }, { settled, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/design-system/Divider.js'),
    import('../src/components/MessageList.js'),
    import('./lib/term-test.mjs'),
  ])
const { render, ThemeProvider, Box, Text, ScrollBox } = ui

const COLS = 60
const ROWS = 8

async function renderDivider(gutter, divider) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = COLS; this.rows = ROWS; this.isTTY = true }
    _write(chunk, _encoding, callback) { term.write(String(chunk), callback) }
  }
  const app = await render(
    <ThemeProvider theme="dark">
      <Box flexDirection="row" width="100%">
        <ScrollBox flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box marginTop={1}>{divider}</Box>
          <Box><Text>marker-row</Text></Box>
        </ScrollBox>
        {gutter ? <Box flexShrink={0} width={2} height={1} /> : null}
      </Box>
    </ThemeProvider>,
    { stdout: new FakeStdout(), exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => viewportLines(term, ROWS).some(l => l.includes('marker-row')))
  const lines = viewportLines(term, ROWS)
  await app.unmount()
  return lines
}

const ruleRows = lines => lines.filter(l => l.includes('─'))

// 1. Beside the 2-col gutter the titled rule fits ONE row at exactly the
//    available width (terminal minus gutter), title centered in it.
const guttered = await renderDivider(true, <Divider title=" Session summary is ready " />)
const gutteredRules = ruleRows(guttered)
if (gutteredRules.length !== 1) {
  throw new Error('Divider wrapped onto ' + gutteredRules.length + ' rows beside the gutter:\n' + guttered.join('\n'))
}
if ([...gutteredRules[0]].length !== COLS - 2) {
  throw new Error('Divider width ' + [...gutteredRules[0]].length + ' != available ' + (COLS - 2) + ':\n' + guttered.join('\n'))
}
if (!gutteredRules[0].includes('Session summary is ready')) {
  throw new Error('Divider lost its title when truncated to the available width:\n' + guttered.join('\n'))
}

// 2. Without the gutter the rule spans the full terminal width.
const full = await renderDivider(false, <Divider title=" Session summary is ready " />)
const fullRules = ruleRows(full)
if (fullRules.length !== 1 || [...fullRules[0]].length !== COLS) {
  throw new Error('Full-width divider rendered ' + fullRules.length + ' rows at width ' + (fullRules[0] ? [...fullRules[0]].length : 0) + ':\n' + full.join('\n'))
}

// 3. An explicit width prop still wins over the measured container width.
const explicit = await renderDivider(false, <Divider width={20} />)
const explicitRules = ruleRows(explicit)
if (explicitRules.length !== 1 || [...explicitRules[0]].length !== 20) {
  throw new Error('Explicit-width divider rendered ' + explicitRules.length + ' rows at width ' + (explicitRules[0] ? [...explicitRules[0]].length : 0) + ':\n' + explicit.join('\n'))
}

// 4. A title WIDER than the available width (long turn-error notices on
//    narrow windows) stays on ONE row with the message preserved —
//    clipped, never dropped for a bare rule nor wrapped. Plain dividers are
//    fixed labels (load-earlier, panel headings), so wrapping is opt-in.
const longTitle = ' turn error · pi-ai stream idle timeout after 300000ms (request-id abcdef) '
const narrow = await renderDivider(true, <Divider title={longTitle} />)
const titleRows = narrow.filter(l => l.includes('turn error'))
if (titleRows.length !== 1) {
  throw new Error('Long-title divider rendered ' + titleRows.length + ' title rows:\n' + narrow.join('\n'))
}
if ([...titleRows[0]].length > COLS - 2) {
  throw new Error('Long-title divider wider than available ' + (COLS - 2) + ':\n' + narrow.join('\n'))
}

// 5. Opt-in titleWrap (transcript notices): the same over-wide message
//    flows onto further rule-framed rows, stays complete, and never
//    overshoots the available width.
const wrapped = await renderDivider(true, <Divider title={longTitle} titleWrap />)
const wrappedRules = ruleRows(wrapped)
if (wrappedRules.length < 2) {
  throw new Error('titleWrap kept the long notice on ' + wrappedRules.length + ' row(s):\n' + wrapped.join('\n'))
}
for (const row of wrappedRules) {
  if ([...row].length > COLS - 2) {
    throw new Error('Wrapped notice row wider than available ' + (COLS - 2) + ':\n' + wrapped.join('\n'))
  }
  if (!row.startsWith('─') || !row.endsWith('─')) {
    throw new Error('Wrapped notice row is not rule-framed on both sides:\n' + wrapped.join('\n'))
  }
}
const wrappedMessage = wrappedRules
  .map(row => row.replace(/─/g, ' ').replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .join(' ')
if (!wrappedMessage.includes('pi-ai stream idle timeout after 300000ms (request-id abcdef)')) {
  throw new Error('titleWrap lost part of the notice: ' + JSON.stringify(wrappedMessage) + '\n' + wrapped.join('\n'))
}

// 6. The real transcript notice row opts in: MessageList renders the long
//    turn error across rows instead of clipping it to the row width.
const noticeRow = { id: 1, kind: 'notice' as const, text: longTitle.trim() }
const noticeLines = await renderDivider(
  true,
  <MessageList
    rows={[noticeRow]}
    expanded={false}
    expandedRows={new Set<number>()}
    selectedId={null}
    onToggleRow={(): void => {}}
    model="deepseek-chat"
    showAll
    onToggleAll={(): void => {}}
  />,
)
const noticeContentRows = noticeLines.filter(l => /turn error|request-id|timeout/.test(l))
if (noticeContentRows.length < 2) {
  throw new Error('Transcript notice was clipped to one row:\n' + noticeLines.join('\n'))
}
if (!noticeLines.join(' ').replace(/─/g, ' ').replace(/\s+/g, ' ').includes('(request-id abcdef)')) {
  throw new Error('Transcript notice lost its tail:\n' + noticeLines.join('\n'))
}
if (!noticeLines.some(line => line.includes('marker-row'))) {
  throw new Error('Wrapped notice swallowed the row after it (stale height):\n' + noticeLines.join('\n'))
}

console.log('OK: Divider fills the available layout width; notices wrap when opted in.')
process.exit(0)
