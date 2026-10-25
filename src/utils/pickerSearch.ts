/**
 * Type-to-filter search shared by every searchable picker.
 *
 * The matcher is pi's `/model` selector semantics: a query matches when its
 * characters appear **in order** in the row text (not necessarily adjacent),
 * and the score ranks the survivors — consecutive runs, word starts and early
 * positions win, gaps and late positions cost. A query is split into tokens on
 * whitespace and `/`, and every token must match, so `openrouter/gpt` narrows
 * by provider and model at once.
 *
 * One deliberate deviation from pi: every alignment start is scored and the
 * best one wins, instead of the first greedy left-to-right hit (see
 * {@link scoreSubsequence}). Without it `opus` ranks a Sonnet row above
 * `claude-opus-4`, because o-p-u-s happens to hide inside
 * "anthr**op**ic … cla**u**de … **s**onnet".
 *
 * Everything here is pure and renderer-free: `scripts/verify-picker-search.ts`
 * drives it headless, and the pickers only ever feed it strings.
 *
 * @module dsh-tui/utils/pickerSearch
 */

/** One row's match verdict; lower `score` is a better match. */
export type FuzzyMatch = { readonly matches: boolean; readonly score: number }

/** Word starts (`provider/model: gpt-4o_v2`) earn the boundary bonus. */
const WORD_SEPARATOR = /[\s\-_./:]/u

/** Query tokens split on whitespace and `/` (`openrouter/gpt` = two tokens). */
const TOKEN_SEPARATOR = /[\s/]+/u

/**
 * Cap on one picker query, in UTF-16 units. Typing is naturally bounded (no
 * human types past this), but a stray bracketed paste of a log line must not
 * become a query nobody can see the end of nor clear without holding ⌫.
 */
export const PICKER_QUERY_MAX = 120

/**
 * Cap on the alignment starts scored per token. A row text is short (a model
 * row is provider + id + name), so this only bites on pathological text; the
 * scan keeps going past it when nothing has matched yet, so a match is never
 * missed because of the cap.
 */
const MAX_ALIGNMENT_STARTS = 32

/**
 * Score one greedy alignment of `needle` in `haystack`, starting at `start`.
 * Assumes both are already lower-cased.
 * @param needle - Lower-cased token.
 * @param haystack - Lower-cased row text.
 * @param start - Index of `needle`'s first character in `haystack`.
 * @returns The alignment score, or undefined when the token does not fit.
 */
function scoreAlignment(needle: string, haystack: string, start: number): number | undefined {
  let score = 0
  let cursor = start - 1
  let run = 0
  for (const char of needle) {
    const at = haystack.indexOf(char, cursor + 1)
    if (at === -1) return undefined
    if (cursor === at - 1) {
      run += 1
      score -= run * 5
    } else {
      run = 0
      if (cursor >= 0) score += (at - cursor - 1) * 2
    }
    if (at === 0 || WORD_SEPARATOR.test(haystack[at - 1]!)) score -= 10
    score += at * 0.1
    cursor = at
  }
  return score
}

/**
 * Score one token against one row text, over the BEST alignment rather than
 * the first one.
 *
 * This is where the matcher deliberately beats a single left-to-right scan
 * (pi's selector stops at the first hit): a row that merely contains the
 * letters scattered (`opus` inside "anthrOpic … claUde … Sonnet") would score
 * better than the row that actually spells them (`claude-**opus**-4`), which
 * highlights the wrong model. Trying every start and keeping the lowest score
 * puts the row a person means first.
 *
 * @param needle - Lower-cased token.
 * @param haystack - Lower-cased row text.
 * @returns Whether every needle char was found in order, and the best score.
 */
function scoreSubsequence(needle: string, haystack: string): FuzzyMatch {
  if (needle.length === 0) return { matches: true, score: 0 }
  if (needle.length > haystack.length) return { matches: false, score: 0 }
  let best: number | undefined
  let starts = 0
  for (let at = haystack.indexOf(needle[0]!); at !== -1; at = haystack.indexOf(needle[0]!, at + 1)) {
    const score = scoreAlignment(needle, haystack, at)
    if (score !== undefined && (best === undefined || score < best)) best = score
    starts += 1
    // Bounded work once something matched; an unmatched token keeps scanning
    // every start so a real match is never dropped by the cap.
    if (starts >= MAX_ALIGNMENT_STARTS && best !== undefined) break
  }
  if (best === undefined) return { matches: false, score: 0 }
  // An exact hit beats any subsequence hit; this is what puts `gpt-4o` above
  // `gpt-4o-mini` when the query is the full id.
  return { matches: true, score: needle === haystack ? best - 100 : best }
}

/**
 * Fuzzy-match one query token against one row text.
 * @param query - Token as typed (case-insensitive).
 * @param text - Row search text (case-insensitive).
 * @returns The match verdict and its score.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  return scoreSubsequence(query.toLowerCase(), text.toLowerCase())
}

/**
 * Filter and rank rows by fuzzy match quality.
 *
 * An empty (or whitespace-only) query returns `items` itself, so callers can
 * memo on identity and an unfiltered picker renders exactly its old list.
 *
 * @param items - Candidate rows in their natural order.
 * @param query - The user's query; tokens split on whitespace and `/`.
 * @param getText - The searchable text of one row.
 * @returns Surviving rows, best match first.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): readonly T[] {
  const tokens = query.trim().toLowerCase().split(TOKEN_SEPARATOR).filter(token => token.length > 0)
  if (tokens.length === 0) return items
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const text = getText(item).toLowerCase()
    let total = 0
    let matched = true
    for (const token of tokens) {
      const match = scoreSubsequence(token, text)
      if (!match.matches) {
        matched = false
        break
      }
      total += match.score
    }
    if (matched) scored.push({ item, score: total })
  }
  // Array.prototype.sort is stable, so equal scores keep the caller's order
  // (recents stay recent, model catalog order stays the catalog's).
  scored.sort((a, b) => a.score - b.score)
  return scored.map(entry => entry.item)
}

/**
 * Append typed (or pasted) text to a picker query.
 *
 * Pasted chunks carry newlines and control characters; flattening them to
 * spaces keeps the query single-line (the search row is one row) and keeps
 * every token visible. Non-pasted typing passes through unchanged.
 *
 * @param query - The query so far.
 * @param input - The keypress's text, possibly a whole paste chunk.
 * @returns The new query, capped at {@link PICKER_QUERY_MAX}.
 */
export function appendPickerQuery(query: string, input: string): string {
  const flat = input.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
  return (query + flat).slice(0, PICKER_QUERY_MAX)
}

/**
 * Delete the query's last character, by code point so an emoji or a CJK
 * extension-B character can never be split into a lone surrogate.
 * @param query - The query to trim.
 * @returns The trimmed query.
 */
export function deletePickerQueryChar(query: string): string {
  const chars = [...query]
  return chars.length === 0 ? '' : chars.slice(0, -1).join('')
}

/** The key flags that decide whether a keypress is query text. */
export type PickerQueryKeyFlags = {
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly tab?: boolean
  readonly return?: boolean
  readonly escape?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly home?: boolean
  readonly end?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
}

/**
 * Whether a keypress should be appended to the pending picker query.
 *
 * Everything with a navigation or editing meaning of its own (arrows, tab,
 * Enter, Esc, ⌫/Del, Home/End, PgUp/PgDn) and every modifier chord stays with
 * the picker's own key handling — only plain text (typed characters, or a
 * bracketed paste chunk) becomes a query.
 *
 * @param input - The keypress's text payload.
 * @param key - The keypress's named-key flags.
 * @returns True when `input` is query text.
 */
export function isPickerQueryInput(input: string, key: PickerQueryKeyFlags): boolean {
  if (input.length === 0) return false
  if (key.ctrl === true || key.meta === true || key.super === true) return false
  return key.tab !== true
    && key.return !== true
    && key.escape !== true
    && key.backspace !== true
    && key.delete !== true
    && key.upArrow !== true
    && key.downArrow !== true
    && key.leftArrow !== true
    && key.rightArrow !== true
    && key.home !== true
    && key.end !== true
    && key.pageUp !== true
    && key.pageDown !== true
}
