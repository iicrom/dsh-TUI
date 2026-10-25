import React from 'react'
import { t } from '../i18n.js'
import { Text } from '../ui.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { SearchBox } from './SearchBox.js'

/**
 * The one-row filter field every searchable picker puts under its title.
 *
 * Pickers are type-to-filter: plain characters land here (the picker's host
 * appends them), Backspace erases, and the keys with navigation meaning of
 * their own (↑/↓/Tab/Enter/Esc/←→) stay with the list. So the field is never
 * focused in the keyboard sense — it always shows the live query and its
 * placeholder advertises that typing filters.
 *
 * The native caret follows the typing: it parks in this row while a query is
 * being typed, and stays with the list at rest (each picker's focused row is
 * the accessibility anchor there). Rendering a caret here unconditionally
 * would fight the model picker's per-region caret zones.
 *
 * @example
 * <PickerSearch query={query} />
 */
export function PickerSearch({ query, placeholder }: {
  /** The live query (empty = unfiltered). */
  query: string
  /** Override the placeholder copy; defaults to "Type to filter…". */
  placeholder?: string
}): React.ReactNode {
  const isTerminalFocused = useTerminalFocus()
  return (
    <SearchBox
      query={query}
      placeholder={placeholder ?? t('picker-search-placeholder')}
      isFocused
      isTerminalFocused={isTerminalFocused}
      width="100%"
      borderless
      placeholderAlign="left"
      declareCursor={query !== ''}
    />
  )
}

/**
 * The empty-list row of a searchable picker: "no matches" while a query is
 * narrowing the list, the picker's own empty copy otherwise (so an empty
 * catalog still says *why* it is empty instead of blaming the filter).
 *
 * @example
 * {rows.length === 0 ? <PickerEmpty query={query} empty={t('skills-empty')} /> : ...}
 */
export function PickerEmpty({ query, empty }: {
  /** The live query (empty = the catalog itself is empty). */
  query: string
  /** The picker's own empty-state copy. */
  empty: string
}): React.ReactNode {
  return <Text dimColor wrap="truncate">{query.trim() === '' ? empty : t('picker-search-empty')}</Text>
}
