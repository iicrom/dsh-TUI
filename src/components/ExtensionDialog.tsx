/**
 * The managed plugin dialog (`ctx.tuiDialogs`) — one panel rendering the
 * store's current snapshot in the chat chrome (the slot approval/question
 * panels occupy). Three kinds share one component:
 *
 * - `select`  — focus list (↑/↓, windowed), Enter settles the option id
 * - `confirm` — two rows (confirm/cancel), Enter settles the boolean
 * - `input`   — single-line text edit, Enter settles the text
 *
 * Esc (and Ctrl+C) always cancels — the plugin's promise resolves with the
 * cancelled value. The panel owns the keyboard through its own useInput,
 * the same contract as ApprovalPanel/AskUserQuestionPanel: Chat's global
 * handler early-returns while a snapshot is pending.
 *
 * Two input-pipeline rules shape every handler below:
 *
 * - BATCHED KEYS: a terminal delivers one stdin chunk as several key events
 *   inside a single React batch (Down+Enter arrives together), so state
 *   queued by the first event is NOT visible to the second. Every piece of
 *   editing state the handlers act on (focus, value, cursor) therefore
 *   lives in a ref mutated SYNCHRONOUSLY per event; the useState mirror
 *   only exists to re-render.
 * - CODE POINTS: cursor movement and deletion step over whole code points
 *   (`[...s]` iteration, same contract as the transcript search box), so an
 *   emoji can never be split into a lone surrogate.
 *
 * All text arrives pre-sanitized from TuiDialogRuntime (control chars
 * stripped, cell-width capped); the panel still renders everything through
 * ListItem's single-line truncation.
 */

import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { SearchBox } from './SearchBox.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { readClipboard } from '../utils/clipboard.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { PickerSearch } from './PickerSearch.js'
import { listWindow } from './listWindow.js'
import { INPUT_CELLS, type TuiDialogAnswer, type TuiDialogSelectOption, type TuiDialogSnapshot } from '../dsh-adapter/dialogs.js'
import { capCells, flattenPasteInline } from '../dsh-adapter/sanitize.js'
import { appendPickerQuery, deletePickerQueryChar, fuzzyFilter, isPickerQueryInput } from '../utils/pickerSearch.js'

export type ExtensionDialogProps = {
  /** The pending dialog (TuiDialogStore snapshot; `key` remounts per dialog). */
  readonly dialog: TuiDialogSnapshot
  readonly onDecide: (value: TuiDialogAnswer) => void
  readonly onCancel: () => void
}

export function ExtensionDialog({ dialog, onDecide, onCancel }: ExtensionDialogProps): React.ReactNode {
  switch (dialog.kind) {
    case 'select':
      return <SelectDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'confirm':
      return <ConfirmDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'input':
      return <InputDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
  }
}

function SelectDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'select' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const searchable = dialog.searchable === true
  const [query, setQuery] = React.useState('')
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Down+Enter in one stdin chunk must move AND read the new focus, and a
  // typed character + Enter in one chunk must filter before Enter reads.
  const focusRef = React.useRef(0)
  const queryRef = React.useRef('')
  /** Match text: the plugin's compact `searchText`, or the rendered row. */
  const rowSearchText = (option: TuiDialogSelectOption): string =>
    option.searchText ?? `${option.label} ${option.description ?? ''}`
  const filteredRows = (search: string): readonly TuiDialogSelectOption[] =>
    searchable && search.trim() !== ''
      ? fuzzyFilter(dialog.options, search, rowSearchText)
      : dialog.options
  // The rendered rows follow the committed query; handlers re-filter from
  // queryRef so batched keys see each other's edits.
  const rows = React.useMemo(
    () => filteredRows(query),
    [dialog.options, query, searchable],
  )
  const focusRow = (next: number, count: number): void => {
    const clamped = count === 0 ? 0 : Math.min(Math.max(next, 0), count - 1)
    focusRef.current = clamped
    setFocusIndex(clamped)
  }
  const moveFocus = (delta: number): void => {
    const count = filteredRows(queryRef.current).length
    if (count === 0) return
    focusRow((focusRef.current + delta + count) % count, count)
  }
  const setSearch = (next: string): void => {
    queryRef.current = next
    setQuery(next)
    // Typing re-ranks: the best match becomes row 0 (same contract as /model).
    focusRow(0, filteredRows(next).length)
  }
  const { rows: terminalRows } = useTerminalSize()

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    // A bracketed paste that is all line breaks is pasted content, never an
    // Enter press — the key carries isPasted, and isPlainReturnInput
    // refuses pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      const option = filteredRows(queryRef.current)[focusRef.current]
      if (option !== undefined) onDecide(option.id)
      return
    }
    if (key.backspace) {
      if (queryRef.current !== '') setSearch(deletePickerQueryChar(queryRef.current))
      return
    }
    if (searchable && isPickerQueryInput(input, key)) {
      setSearch(appendPickerQuery(queryRef.current, input))
    }
  }, { isActive: true })

  // Row budget mirrors the rewind picker: a described option costs 2 rows,
  // a bare one 1; frame rows: Pane 2 + title 2 + search 1 + footer 1 + slack.
  const safeFocus = Math.min(focusIndex, Math.max(rows.length - 1, 0))
  const { start, end } = listWindow(
    rows.map(option => (option.description === undefined ? 1 : 2)),
    safeFocus,
    Math.max(terminalRows - (searchable ? 11 : 10), 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={searchable ? 0 : 1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        {searchable ? (
          <Box marginBottom={1}>
            <PickerSearch
              query={query}
              placeholder={dialog.searchPlaceholder ?? t('picker-search-placeholder')}
            />
          </Box>
        ) : null}
        {rows.length === 0 ? (
          // A non-searchable empty select is already refused by the runtime;
          // only the filter can legitimately empty a rendered list.
          searchable ? <Text dimColor wrap="truncate">{t('picker-search-empty')}</Text> : null
        ) : rows.slice(start, end).map((option, index) => {
          const absoluteIndex = start + index
          return (
            <ListItem
              key={option.id}
              isFocused={absoluteIndex === safeFocus}
              description={option.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < rows.length}
              // Click = decide this option (same as Enter on it).
              onClick={() => onDecide(option.id)}
            >
              {option.label}
            </ListItem>
          )
        })}
      </Box>
      <Text dimColor italic>
        <HintLine text={t(searchable ? 'hint-select-search-exit' : 'hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function ConfirmDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'confirm' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Right+Enter in one stdin chunk must settle the NEW row, not the old.
  const focusRef = React.useRef(0)
  const labels = [
    dialog.confirmLabel || t('ext-dialog-yes'),
    dialog.cancelLabel || t('ext-dialog-no'),
  ]
  const moveFocus = (delta: number): void => {
    const next = (focusRef.current + delta + labels.length) % labels.length
    focusRef.current = next
    setFocusIndex(next)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow || key.leftArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow || key.rightArrow) {
      moveFocus(1)
      return
    }
    // A bracketed paste that is all line breaks is pasted content, never an
    // Enter press — the key carries isPasted, and isPlainReturnInput
    // refuses pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      onDecide(focusRef.current === 0)
    }
  }, { isActive: true })

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
          {dialog.message !== undefined && <Text dimColor>{dialog.message}</Text>}
        </Box>
        {labels.map((label, index) => (
          <ListItem
            key={label}
            isFocused={index === focusIndex}
            // Click = decide this row (same as Enter on it).
            onClick={() => onDecide(index === 0)}
          >
            {label}
          </ListItem>
        ))}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function InputDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'input' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = React.useState(dialog.initial)
  const [cursor, setCursor] = React.useState<number>(() => [...dialog.initial].length)
  // Synchronous source of truth for the handlers (see the module header):
  // two Backspaces in one stdin chunk must BOTH delete, each seeing the
  // other's result. The cursor counts CODE POINTS, not UTF-16 units — an
  // emoji is one step and can never be split into a lone surrogate.
  const valueRef = React.useRef(dialog.initial)
  const cursorRef = React.useRef([...dialog.initial].length)
  const applyEdit = (nextValue: string, nextCursor: number): void => {
    valueRef.current = nextValue
    cursorRef.current = nextCursor
    setValue(nextValue)
    setCursor(nextCursor)
  }
  /** True while the component is mounted (async clipboard continuation
   *  guard: the dialog can close before the read resolves). */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])
  /** True while a clipboard read is in flight (ignore repeat Ctrl+V). */
  const pasteBusyRef = React.useRef(false)

  /** Insert one chunk under the single-line + cell-cap contract: content
   *  that fits lands at the caret; oversized PASTE content is truncated
   *  (mayCap) while oversized typing stays ignored — the value never
   *  exceeds INPUT_CELLS cells either way. */
  const insertChunk = (chunk: string, mayCap: boolean): void => {
    const points = [...valueRef.current]
    const at = cursorRef.current
    const chunkPoints = [...chunk].length
    const candidate = points.slice(0, at).join('') + chunk + points.slice(at).join('')
    if (stringWidth(candidate) <= INPUT_CELLS) {
      applyEdit(candidate, at + chunkPoints)
    } else if (mayCap) {
      const capped = capCells(candidate, INPUT_CELLS)
      applyEdit(capped, Math.min(at + chunkPoints, [...capped].length))
    }
  }

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    // A bracketed paste that is all line breaks is inserted as text, never
    // submitted — the key carries isPasted, and isPlainReturnInput refuses
    // pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      onDecide(valueRef.current)
      return
    }
    const points = [...valueRef.current]
    const at = cursorRef.current
    // Single-line editing, same key set as the transcript search bar.
    if (key.backspace) {
      if (at > 0) {
        points.splice(at - 1, 1)
        applyEdit(points.join(''), at - 1)
      }
      return
    }
    if (key.delete) {
      if (at < points.length) {
        points.splice(at, 1)
        applyEdit(points.join(''), at)
      }
      return
    }
    if (key.leftArrow) {
      if (at > 0) applyEdit(valueRef.current, at - 1)
      return
    }
    if (key.rightArrow) {
      if (at < points.length) applyEdit(valueRef.current, at + 1)
      return
    }
    if (key.home) {
      applyEdit(valueRef.current, 0)
      return
    }
    if (key.end) {
      applyEdit(valueRef.current, points.length)
      return
    }
    // Clipboard paste (default Ctrl+V / Alt+V — the keymap `paste`
    // binding): raw mode hands the key to the app, so the clipboard is
    // read here. Only text offers insert — files/images have no text form
    // in a single-line value, and read failures are silently ignored (the
    // dialog has no notice channel; repeat keys while a read is in flight
    // are dropped by the busy guard).
    if (actionMatches('paste', input, key)) {
      if (!pasteBusyRef.current) {
        pasteBusyRef.current = true
        void readClipboard()
          .then(content => {
            if (!mountedRef.current) return
            if (content?.kind === 'text' && content.text !== '') {
              insertChunk(flattenPasteInline(content.text), true)
            }
          })
          .finally(() => { pasteBusyRef.current = false })
      }
      return
    }
    if (input && !key.ctrl && !key.meta && !key.super && !key.tab && !key.escape) {
      // A bracketed paste arrives as one chunk and may carry newlines/control
      // chars (even complete ANSI sequences) — this is a single-line panel,
      // so strip ANSI and flatten controls to spaces (typed text is already
      // control-free; mayCap only applies to paste).
      insertChunk(event.isPasted ? flattenPasteInline(input) : input, event.isPasted === true)
    }
  }, { isActive: true })

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        <SearchBox
          query={value}
          cursorOffset={[...value].slice(0, cursor).join('').length}
          placeholder={dialog.placeholder ?? ''}
          placeholderAlign="left"
          prefix=""
          borderless
          isFocused
          isTerminalFocused
        />
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-ext-dialog-input')} />
      </Text>
    </Pane>
  )
}
