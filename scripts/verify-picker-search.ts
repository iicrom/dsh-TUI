/**
 * verify-picker-search — type-to-filter regressions for the shared picker
 * search (src/utils/pickerSearch.ts) and the overlay field it feeds
 * (`{ type: 'search' }` in src/screens/chatOverlay.ts).
 *
 * What is pinned here:
 *   - the matcher is the pi selector's: characters in order, consecutive runs
 *     and word starts win, gaps and late positions cost; tokens split on space
 *     and `/` so `openrouter/gpt` narrows by provider AND model;
 *   - ranking puts the row a person means first (`sonnet` → the Sonnet row,
 *     not a row that merely contains the letters), and equal scores keep the
 *     caller's order (recents stay recent);
 *   - the query editor is code-point safe (⌫ never splits an emoji), flattens
 *     pasted newlines and is length-capped;
 *   - only plain text edits a query: arrows/Tab/Enter/Esc/⌫/Del/PgUp/PgDn and
 *     every modifier chord stay with the picker's own key handling;
 *   - the reducer resets the focus to the best match on every search, ignores
 *     the action for pickers that are not searchable, and a freshly opened
 *     overlay is unfiltered (the query lives IN the variant).
 *
 * Run: node --import tsx/esm scripts/verify-picker-search.ts
 */
import {
  PICKER_QUERY_MAX,
  appendPickerQuery,
  deletePickerQueryChar,
  fuzzyFilter,
  fuzzyMatch,
  isPickerQueryInput,
} from '../src/utils/pickerSearch.js'
import {
  NO_OVERLAY,
  chatOverlayReducer,
  isSearchableOverlay,
  pickerListHidden,
  type ChatOverlay,
} from '../src/screens/chatOverlay.js'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${name}`)
    console.error(`      expected: ${e}`)
    console.error(`      actual:   ${a}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const matches = (query: string, text: string): boolean => fuzzyMatch(query, text).matches

/** Model rows shaped like the /model picker's, in catalog order. */
const MODELS = [
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  { provider: 'anthropic', id: 'claude-opus-4', name: 'Claude Opus 4' },
  { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' },
  { provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  { provider: 'openrouter', id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
]
const modelText = (model: typeof MODELS[number]): string =>
  `${model.provider} ${model.provider}/${model.id} ${model.id} ${model.name}`
const modelQuery = (query: string): string[] =>
  fuzzyFilter(MODELS, query, modelText).map(model => `${model.provider}/${model.id}`)

// --- T1: subsequence matching -------------------------------------------
check('T1a empty query matches everything', matches('', 'anything'), true)
check('T1b characters must appear in order', matches('sonnet', 'claude-sonnet-4'), true)
check('T1c out-of-order characters do not match', matches('tennos', 'claude-sonnet-4'), false)
check('T1d matching is case-insensitive', matches('SONNET', 'claude-Sonnet-4'), true)
check('T1e a gap is allowed (gpt4 finds gpt-4o)', matches('gpt4', 'gpt-4o'), true)
check('T1f a longer query than the text cannot match', matches('claude-sonnet-4-20250101', 'sonnet'), false)

// --- T2: scoring puts the intended row first -----------------------------
check('T2a exact id wins over a longer sibling', modelQuery('gpt-4o'), ['openai/gpt-4o', 'openai/gpt-4o-mini'])
check('T2b a word-start match beats a mid-word match', fuzzyMatch('opus', 'opus-4').score < fuzzyMatch('opus', 'xopus').score, true)
check('T2c consecutive runs beat scattered characters', fuzzyMatch('sonnet', 'sonnet').score < fuzzyMatch('sonnet', 's-o-n-n-e-t').score, true)
check('T2d exact full text carries the tie-break bonus', fuzzyMatch('gpt-4o', 'gpt-4o').score < fuzzyMatch('gpt-4o', 'gpt-4o-mini').score, true)

// --- T3: token splitting (space and `/`) --------------------------------
check('T3a provider/model narrows both at once', modelQuery('openai/gpt-4o'), ['openai/gpt-4o', 'openai/gpt-4o-mini'])
// Subsequence matching is permissive by design (the same as pi's selector):
// `opus` is also a subsequence of "anthropic … claude", so the match set is
// wider than a substring search would give. What matters is the RANKING — the
// row a person means is first — plus the token AND rule (T3c).
check('T3b space-separated tokens are ANDed and ranked', modelQuery('anthropic opus')[0], 'anthropic/claude-opus-4')
check('T3c a token that matches nothing drops the row', modelQuery('anthropic gpt'), [])
check('T3d the provider alone ranks its own rows first', modelQuery('openai').slice(0, 2), ['openai/gpt-4o', 'openai/gpt-4o-mini'])
check('T3e a proxy id loses to the bare provider match', modelQuery('anthropic/claude-sonnet-4')[0], 'anthropic/claude-sonnet-4')

// --- T4: identity and stability ----------------------------------------
check('T4a an empty query returns the same array', fuzzyFilter(MODELS, '', modelText) === MODELS, true)
check('T4b a whitespace-only query is also a no-op', fuzzyFilter(MODELS, '   ', modelText) === MODELS, true)
check(
  'T4c equal scores keep the caller order (recents stay recent)',
  fuzzyFilter(['b-model', 'a-model'], 'model', row => row),
  ['b-model', 'a-model'],
)

// --- T5: query editing --------------------------------------------------
check('T5a typed text appends', appendPickerQuery('gp', 't'), 'gpt')
check('T5b pasted newlines flatten to spaces', appendPickerQuery('a', 'b\nc\td'), 'ab c d')
check('T5c control characters are dropped', appendPickerQuery('', 'a\u0007b'), 'a b')
check('T5d the query is capped', appendPickerQuery('', 'x'.repeat(PICKER_QUERY_MAX + 50)).length, PICKER_QUERY_MAX)
check('T5e ⌫ removes one code point', deletePickerQueryChar('gpt'), 'gp')
check('T5f ⌫ never splits an emoji', deletePickerQueryChar('a🐋'), 'a')
check('T5g ⌫ on an empty query is inert', deletePickerQueryChar(''), '')

// --- T6: which keys are query text -------------------------------------
const noKey = {}
check('T6a a printable character is query text', isPickerQueryInput('g', noKey), true)
check('T6b an empty payload is not', isPickerQueryInput('', noKey), false)
check('T6c ⌫ is not', isPickerQueryInput('\u007f', { backspace: true }), false)
check('T6d arrows are not', isPickerQueryInput('', { upArrow: true }) || isPickerQueryInput('[A', { upArrow: true }), false)
check('T6e Tab is not (it switches provider tabs)', isPickerQueryInput('\t', { tab: true }), false)
check('T6f Enter is not', isPickerQueryInput('\r', { return: true }), false)
check('T6g Esc is not', isPickerQueryInput('\u001b', { escape: true, meta: true }), false)
check('T6h Ctrl chords are not', isPickerQueryInput('c', { ctrl: true }), false)
check('T6i Alt/Option chords are not', isPickerQueryInput('a', { meta: true }), false)
check('T6j Home/End/PgUp/PgDn are not', [
  isPickerQueryInput('', { home: true }),
  isPickerQueryInput('', { end: true }),
  isPickerQueryInput('', { pageUp: true }),
  isPickerQueryInput('', { pageDown: true }),
], [false, false, false, false])

// --- T7: overlay search action -----------------------------------------
const search = (state: ChatOverlay, query: string): ChatOverlay =>
  chatOverlayReducer(state, { type: 'search', query })

check('T7a searchable kinds are the list pickers', [
  isSearchableOverlay({ kind: 'theme', index: 3 }),
  isSearchableOverlay({ kind: 'skills', index: 0 }),
  isSearchableOverlay({ kind: 'kernel', index: 1 }),
  isSearchableOverlay({ kind: 'rewind', index: 2, confirm: null, modes: null, modeIndex: 0, busy: false }),
  isSearchableOverlay({ kind: 'workspace-picker', index: 0 }),
], [true, true, true, true, true])
check('T7b fixed toggles and action panels are not searchable', [
  isSearchableOverlay(NO_OVERLAY),
  isSearchableOverlay({ kind: 'model' }),
  isSearchableOverlay({ kind: 'thinking', focus: 0 }),
  isSearchableOverlay({ kind: 'effort', index: 0 }),
  isSearchableOverlay({ kind: 'history', query: '', cursor: 0, focus: 0 }),
  isSearchableOverlay({ kind: 'file-actions', path: '/tmp/x', index: 0, isDir: false }),
], [false, false, false, false, false, false])

check(
  'T7c search stores the query and returns the focus to the best match',
  search({ kind: 'theme', index: 7 }, 'sol'),
  { kind: 'theme', index: 0, query: 'sol' },
)
check(
  'T7d a second search replaces the query (typing keeps narrowing)',
  search(search({ kind: 'theme', index: 0 }, 's'), 'so'),
  { kind: 'theme', index: 0, query: 'so' },
)
check(
  'T7e ⌫ to empty restores the unfiltered list',
  search({ kind: 'skills', index: 0, query: 'x' }, ''),
  { kind: 'skills', index: 0, query: '' },
)
check(
  'T7f search is ignored for a picker without a query field',
  search({ kind: 'model' }, 'gpt'),
  { kind: 'model' },
)
check(
  'T7g search leaves a non-searchable payload untouched',
  search({ kind: 'file-actions', path: '/tmp/x', index: 1, isDir: true }, 'x'),
  { kind: 'file-actions', path: '/tmp/x', index: 1, isDir: true },
)
check(
  'T7h search keeps the data a permission picker carries',
  search({ kind: 'permission', index: 2, snapshot: { options: [] } as never, confirm: true }, 'aut'),
  { kind: 'permission', index: 0, snapshot: { options: [] }, confirm: true, query: 'aut' },
)
check(
  'T7i search keeps the rewind sub-state (confirm pane, modes, busy)',
  search({ kind: 'rewind', index: 4, confirm: null, modes: null, modeIndex: 0, busy: false }, 'fix'),
  { kind: 'rewind', index: 0, confirm: null, modes: null, modeIndex: 0, busy: false, query: 'fix' },
)
check(
  'T7j navigation still works on a filtered list (move wraps over the matches)',
  chatOverlayReducer({ kind: 'preset', index: 0, query: 'fa' }, { type: 'move', delta: -1, count: 2 }),
  { kind: 'preset', index: 1, query: 'fa' },
)
check(
  'T7k reopening a picker starts unfiltered (a fresh variant has no query)',
  chatOverlayReducer(NO_OVERLAY, { type: 'open', overlay: { kind: 'theme', index: 0 } }),
  { kind: 'theme', index: 0 },
)

// --- T8: panes without a list do not take text --------------------------
check('T8a a rewind confirm pane hides the list', pickerListHidden(
  { kind: 'rewind', index: 0, confirm: {} as never, modes: null, modeIndex: 0, busy: false },
), true)
check('T8b a rewind picker waiting on plugins hides the list', pickerListHidden(
  { kind: 'rewind', index: 0, confirm: null, modes: null, modeIndex: 0, busy: true },
), true)
check('T8c the rewind list takes text', pickerListHidden(
  { kind: 'rewind', index: 0, confirm: null, modes: null, modeIndex: 0, busy: false },
), false)
check('T8d the permission risk confirmation hides the list', pickerListHidden(
  { kind: 'permission', index: 0, snapshot: { options: [] } as never, confirm: true },
), true)
check('T8e the permission list takes text', pickerListHidden(
  { kind: 'permission', index: 0, snapshot: { options: [] } as never },
), false)
check('T8f other searchable pickers always take text', pickerListHidden({ kind: 'theme', index: 0 }), false)

if (failures > 0) {
  console.error(`\n${failures} picker-search check(s) failed`)
  process.exit(1)
}
console.log('\nall picker-search checks passed')
