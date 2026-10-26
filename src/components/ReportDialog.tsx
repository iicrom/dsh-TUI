import React from 'react'
import { t } from '../i18n.js'
import { Box, ScrollBox, Text, type ScrollBoxHandle } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { HintLine } from './design-system/HintLine.js'
import { useOverlayListRows } from './OverlayAbove.js'

/**
 * Read-only command report (the `/plugin`, `/login`, `/status`, `/doctor` …
 * family), rendered as a modal pane instead of transcript rows.
 *
 * The dialog is deliberately presentational: Chat owns the keyboard (Esc /
 * Enter close, arrows / PgUp / PgDn / Home / End scroll the shared ref), the
 * same split every other picker uses. `lines` arrive already sanitized and
 * bounded by the caller, so this component only controls layout — long lines
 * wrap inside the pane, blank lines stay blank rows, and the viewport is the
 * one `OverlayAbove` measured above the prompt.
 */
export function ReportDialog({
  title,
  lines,
  scrollRef,
}: {
  title: string
  lines: readonly string[]
  scrollRef?: React.Ref<ScrollBoxHandle>
}): React.ReactNode {
  // Frame rows: overlay marginTop 1 + Pane paddingTop 1 + divider 1 + title 1
  // + title marginBottom 1 + footer 1. The list windows itself inside what is
  // left, so a short terminal scrolls instead of painting past the anchor.
  const listRows = useOverlayListRows(6)
  const visibleRows = Math.max(1, Math.min(lines.length, listRows))
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="permission" bold>{title}</Text>
        </Box>
        <Box height={visibleRows} flexDirection="column">
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1}>
            {lines.map((line, index) => (
              // A blank line is still a row: an empty Text collapses to zero
              // height and would silently delete the report's section breaks.
              <Text key={index} wrap="wrap">{line === '' ? ' ' : line}</Text>
            ))}
          </ScrollBox>
        </Box>
        <Text dimColor italic>
          <HintLine text={t('hint-report-dialog')} />
        </Text>
      </Box>
    </Pane>
  )
}
