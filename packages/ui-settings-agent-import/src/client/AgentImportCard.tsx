/**
 * The agent-import settings card: which foreign tools the plugin reads, where
 * each one keeps its files, and how the import is bounded.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Checkbox, Input, SettingsForm, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AGENT_IMPORT_FIELDS, FOREIGN_SOURCES,
  type AgentImportInputFieldId, type AgentImportToggleFieldId, type ForeignSource,
} from './agent-import-fields.ts'
import { formLabels, type AgentImportLocaleKey } from './locales.ts'
import type { AgentImportCardFace, AgentImportSourceState, AgentImportToggleState } from './agent-import-card-controller.ts'

/** Props the renderer binds for the agent-import page. */
export type AgentImportCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.agentImport'>
  & InjectFace<AgentImportCardFace>

/** One control's page-state member, and the copy it renders. */
interface ControlField<Field extends string> {
  /** Page-state member and form field id. */
  readonly field: Field
  /** Visible label. */
  readonly labelKey: AgentImportLocaleKey
  /** One-line explanation under the control. */
  readonly hintKey: AgentImportLocaleKey
}

/** The text and number fields, in render order. */
const VALUE_FIELDS: readonly ControlField<AgentImportInputFieldId>[] = [
  { field: 'projectRoot', labelKey: 'projectRoot', hintKey: 'projectRootHint' },
  { field: 'codex.home', labelKey: 'codexHome', hintKey: 'codexHomeHint' },
  { field: 'codex.configPath', labelKey: 'codexConfigPath', hintKey: 'codexConfigPathHint' },
  { field: 'claudeCode.configDir', labelKey: 'claudeCodeConfigDir', hintKey: 'claudeCodeConfigDirHint' },
  { field: 'claudeCode.configPath', labelKey: 'claudeCodeConfigPath', hintKey: 'claudeCodeConfigPathHint' },
  { field: 'maxServers', labelKey: 'maxServers', hintKey: 'maxServersHint' },
  { field: 'maxSkills', labelKey: 'maxSkills', hintKey: 'maxSkillsHint' },
]

/** The switches, in render order. */
const SWITCH_FIELDS: readonly ControlField<AgentImportToggleFieldId>[] = [
  { field: 'mcp', labelKey: 'mcp', hintKey: 'mcpHint' },
  { field: 'skills', labelKey: 'skills', hintKey: 'skillsHint' },
  { field: 'codex.includeSystemSkills', labelKey: 'codexIncludeSystemSkills', hintKey: 'codexIncludeSystemSkillsHint' },
  { field: 'failOnStartupError', labelKey: 'failOnStartupError', hintKey: 'failOnStartupErrorHint' },
]

/**
 * Render the agent-import card's one-liner or its configuration form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function AgentImportCard(props: AgentImportCardProps) {
  const { t } = props
  const state = props.useAgentImportCard(snapshot => snapshot)
  if (props.view === 'summary') return t('summary')
  const disabled = !state.writable || state.saving
  const overriddenLabel = t('overridden')
  const resetLabel = t('reset')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <fieldset>
        <legend>{t('sources')}</legend>
        {state.sources.choices.map(choice => (
          <Checkbox
            key={choice.value}
            checked={choice.checked}
            disabled={disabled}
            label={sourceLabel(t, choice.value)}
            onChange={(next) => { props.setChoices('sources', selectionAfter(state.sources.choices, choice.value, next)) }}
          />
        ))}
        {state.sources.overridden
          ? (
            <OverrideReset
              overriddenLabel={overriddenLabel}
              resetLabel={resetLabel}
              disabled={disabled}
              onReset={() => { props.clear('sources') }}
            />
          )
          : null}
        <p>{t('sourcesHint')}</p>
      </fieldset>
      {VALUE_FIELDS.map(item => (
        <SettingsValueField
          key={item.field}
          id={`plugin-config-agent-import-${item.field}`}
          label={t(item.labelKey)}
          hint={t(item.hintKey)}
          overriddenLabel={overriddenLabel}
          resetLabel={resetLabel}
          invalidLabel={t('invalidNumber')}
          numeric={AGENT_IMPORT_FIELDS[item.field].kind === 'count'}
          disabled={disabled}
          {...state.values[item.field]}
          onEdit={(text) => { props.edit(item.field, text) }}
          onReset={() => { props.clear(item.field) }}
        />
      ))}
      {SWITCH_FIELDS.map(item => (
        <ToggleField
          key={item.field}
          label={t(item.labelKey)}
          hint={t(item.hintKey)}
          state={state.switches[item.field]}
          overriddenLabel={overriddenLabel}
          resetLabel={resetLabel}
          disabled={disabled}
          onChange={(next) => { props.setToggle(item.field, next) }}
          onReset={() => { props.clear(item.field) }}
        />
      ))}
      <div>
        <span>{t('serverDenyList')}</span>
        {state.serverDenyList.overridden
          ? (
            <OverrideReset
              overriddenLabel={overriddenLabel}
              resetLabel={resetLabel}
              disabled={disabled}
              onReset={() => { props.clear('serverDenyList') }}
            />
          )
          : null}
        {state.serverDenyList.rows.map((row, index) => (
          // A row's identity is its position: the editor stages the whole list,
          // so a removed row must not carry a later row's draft into its slot.
          <div key={index}>
            <Input
              value={row}
              disabled={disabled}
              aria-label={t('denyEntryName', { index: index + 1 })}
              onChange={(event) => { props.setList('serverDenyList', replaceAt(state.serverDenyList.rows, index, event.target.value)) }}
            />
            <Button
              size="sm"
              disabled={disabled}
              aria-label={t('denyEntryRemove', { index: index + 1 })}
              onClick={() => { props.setList('serverDenyList', state.serverDenyList.rows.filter((_row, position) => position !== index)) }}
            >
              {t('remove')}
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => { props.setList('serverDenyList', [...state.serverDenyList.rows, '']) }}
        >
          {t('addDenyEntry')}
        </Button>
        <p>{t('serverDenyListHint')}</p>
      </div>
    </SettingsForm>
  )
}

/** A switch with its label, hint, and the reset that drops an override. */
function ToggleField(props: {
  label: string
  hint: string
  state: AgentImportToggleState
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onChange: (next: boolean) => void
  onReset: () => void
}) {
  return (
    <div>
      <Switch
        checked={props.state.checked}
        disabled={props.disabled}
        label={props.label}
        onChange={props.onChange}
      />
      <span>{props.label}</span>
      {props.state.overridden
        ? (
          <OverrideReset
            overriddenLabel={props.overriddenLabel}
            resetLabel={props.resetLabel}
            disabled={props.disabled}
            onReset={props.onReset}
          />
        )
        : null}
      <p>{props.hint}</p>
    </div>
  )
}

/** The badge and reset control every overridable field shares outside the staged value field. */
function OverrideReset(props: {
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onReset: () => void
}) {
  return (
    <span>
      <Tag tone="neutral">{props.overriddenLabel}</Tag>
      <Button size="sm" disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</Button>
    </span>
  )
}

/** The copy naming one selectable source. */
function sourceLabel(t: (key: AgentImportLocaleKey) => string, source: ForeignSource): string {
  return source === 'codex' ? t('sourceCodex') : t('sourceClaudeCode')
}

/**
 * The selection one checkbox gesture stages.
 * @param choices - the rendered sources and their current state.
 * @param value - the source the gesture toggled.
 * @param checked - whether that source just became selected.
 * @returns the selected sources in import precedence order.
 */
function selectionAfter(choices: readonly AgentImportSourceState[], value: ForeignSource, checked: boolean): ForeignSource[] {
  const selected = new Set(choices.filter(choice => choice.checked).map(choice => choice.value))
  if (checked) selected.add(value)
  else selected.delete(value)
  return FOREIGN_SOURCES.filter(source => selected.has(source))
}

/** One row of a list draft with its new text. */
function replaceAt(rows: readonly string[], index: number, value: string): string[] {
  return rows.map((row, position) => position === index ? value : row)
}
