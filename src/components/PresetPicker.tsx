import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'
import { PickerEmpty, PickerSearch } from './PickerSearch.js'
import type { PresetOption } from '../dsh-adapter/channel.js'

/**
 * Agent-preset picker (issue #8) using the ActivityPicker layout: a
 * permission-colored Pane listing every roster
 * preset with its display name and description, `❯` focus pointer and `✓`
 * on the preset the current session runs. Enter applies through
 * `channel.switchPreset`, Esc cancels. Broken presets are listed (the
 * roster's discovery contract) but marked with their reason; the roster
 * default is tagged.
 *
 * The header says "内核 Agent 预设 / Kernel agent preset" (not just "Agent
 * preset"): this screen changes the model-facing tool catalog, and must never
 * be confused with the `/settings → 极简界面` (Minimal UI) display switch.
 */
export function PresetPicker({
  presets,
  focusIndex,
  currentPreset,
  query = '',
  onPick,
}: {
  /** Rows to render: already narrowed by `query` (the host filters). */
  presets: readonly PresetOption[]
  focusIndex: number
  currentPreset: string | undefined
  /** Live filter query; empty renders the whole roster. */
  query?: string
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('preset-picker-title')}
          </Text>
        </Box>
        <PickerSearch query={query} />
        {presets.length === 0 ? <PickerEmpty query={query} empty={t('picker-search-empty')} /> : (
          <Select
            options={presets.map(preset => ({
              value: preset.id,
              label:
                (preset.name ?? preset.id) +
                (preset.isDefault ? t('preset-default-tag') : '') +
                (preset.broken !== undefined ? t('preset-broken-tag') : ''),
              description: preset.broken ?? preset.description ?? preset.id,
            }))}
            focusIndex={focusIndex}
            selectedValue={currentPreset}
            onPick={onPick ? index => onPick(index) : undefined}
          />
        )}
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}
