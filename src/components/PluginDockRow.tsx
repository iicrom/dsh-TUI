/**
 * Renders one `tuiDock` registration between the transcript and the prompt.
 *
 * The dock component receives the host React instance (single-React rule),
 * a pointer-only UI kit, the curated session snapshot and the composer width.
 * The row is clipped at `entry.maxRows` so a buggy component cannot push the
 * prompt off screen; a render/lifecycle failure collapses only this row and
 * reports through `onError` (the Chat screen toasts and logs it).
 */
import React from 'react'
import { Box, Image, ScrollBox, Text, useAnimationFrame, useTerminalSize, useTheme } from '../ui.js'
import { Divider } from './design-system/Divider.js'
import { PanelCodeBlock, PanelMarkdown } from './sidePanel/panelMarkdown.js'
import type { TuiDockEntry, TuiDockHost, TuiDockUi } from '../dsh-adapter/dock.js'
import type { TuiSessionSnapshot } from '../dsh-adapter/session-state.js'

type DockBoundaryProps = {
  readonly dockId: string
  readonly onError: (id: string, error: Error) => void
  readonly children: React.ReactNode
}

type DockBoundaryState = { readonly crashed: boolean }

/** One broken dock collapses to nothing; the rest of the UI keeps going. */
export class PluginDockBoundary extends React.Component<DockBoundaryProps, DockBoundaryState> {
  override state: DockBoundaryState = { crashed: false }

  static getDerivedStateFromError(): DockBoundaryState {
    return { crashed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(this.props.dockId, error)
  }

  override render(): React.ReactNode {
    return this.state.crashed ? null : this.props.children
  }
}

export function PluginDockRow({
  entry,
  snapshot,
  panelEnabled,
  sidePanelSplit,
  width,
  toast,
  onError,
}: {
  readonly entry: TuiDockEntry
  readonly snapshot: TuiSessionSnapshot
  readonly panelEnabled: (subId: string) => boolean
  readonly sidePanelSplit: boolean
  readonly width: number
  readonly toast: (text: string) => boolean
  readonly onError: (id: string, error: Error) => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const ui = React.useMemo<TuiDockUi>(() => ({
    Box: Box as TuiDockUi['Box'],
    Text: Text as TuiDockUi['Text'],
    Image: Image as TuiDockUi['Image'],
    ScrollBox: ScrollBox as TuiDockUi['ScrollBox'],
    Divider: Divider as TuiDockUi['Divider'],
    Markdown: PanelMarkdown,
    CodeBlock: PanelCodeBlock,
    useTerminalSize: () => ({ columns, rows }),
    useAnimationTime: (intervalMs: number | null) => useAnimationFrame(intervalMs)[1],
    useTheme,
  }), [columns, rows])
  const host = React.useMemo<TuiDockHost>(() => Object.freeze({
    snapshot: () => snapshot,
    panelEnabled,
    sidePanelSplit,
    toast,
  }), [snapshot, panelEnabled, sidePanelSplit, toast])
  return (
    <PluginDockBoundary dockId={entry.id} onError={onError}>
      <Box flexDirection="column" height={entry.maxRows} overflow="hidden" flexShrink={0}>
        {React.createElement(entry.component, { React, ui, host, width })}
      </Box>
    </PluginDockBoundary>
  )
}
