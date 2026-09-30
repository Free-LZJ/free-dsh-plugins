/**
 * The agent-import settings card: which foreign tools the plugin reads, where
 * each one keeps its files, and how the import is bounded.
 *
 * The form is grouped into titled sections, so the paths one tool needs are
 * not interleaved with the bounds that apply to both.
 */

import { useId, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  Button, Checkbox, Input, PathLabel, SettingsForm, SettingsValueField, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AGENT_IMPORT_FIELDS,
  type AgentImportInputFieldId, type AgentImportToggleFieldId, type ForeignSource,
} from './agent-import-fields.ts'
import { AGENT_IMPORT_CLASS } from './agent-import-card-style.ts'
import type { AgentImportReport } from './agent-import-report.ts'
import { formLabels, type AgentImportLocaleKey } from './locales.ts'
import type {
  AgentImportCardFace, AgentImportPageState, AgentImportReportState, AgentImportSourceState, AgentImportToggleState,
} from './agent-import-card-controller.ts'

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

/** The directory and file fields, in render order. */
const PATH_FIELDS: readonly ControlField<AgentImportInputFieldId>[] = [
  { field: 'projectRoot', labelKey: 'projectRoot', hintKey: 'projectRootHint' },
  { field: 'codex.home', labelKey: 'codexHome', hintKey: 'codexHomeHint' },
  { field: 'codex.configPath', labelKey: 'codexConfigPath', hintKey: 'codexConfigPathHint' },
  { field: 'claudeCode.configDir', labelKey: 'claudeCodeConfigDir', hintKey: 'claudeCodeConfigDirHint' },
  { field: 'claudeCode.configPath', labelKey: 'claudeCodeConfigPath', hintKey: 'claudeCodeConfigPathHint' },
]

/** The bounds on what one import reads, in render order. */
const COUNT_FIELDS: readonly ControlField<AgentImportInputFieldId>[] = [
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
  const report = props.useAgentImportReport(snapshot => snapshot)
  if (props.view === 'summary') return t('summary')
  const disabled = !state.writable || state.saving
  const overriddenLabel = t('overridden')
  const resetLabel = t('reset')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <Section id="loaded" title={t('loadedTitle')} hint={t('loadedHint')}>
        <LoadedItems t={t} report={report} onRefresh={props.refreshReport} />
      </Section>
      <Section id="sources" title={t('sources')} hint={t('sourcesHint')}>
        <div className={AGENT_IMPORT_CLASS.choices}>
          {state.sources.choices.map(choice => (
            <Checkbox
              key={choice.value}
              checked={choice.checked}
              disabled={disabled}
              label={sourceLabel(t, choice.value)}
              onChange={(next) => { props.setChoices('sources', selectionAfter(state.sources.choices, choice.value, next)) }}
            />
          ))}
        </div>
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
      </Section>
      <Section id="paths" title={t('pathsTitle')} hint={t('pathsHint')}>
        <div className={AGENT_IMPORT_CLASS.field}>
          {PATH_FIELDS.map(item => (
            <ValueField
              key={item.field}
              item={item}
              state={state.values[item.field]}
              t={t}
              overriddenLabel={overriddenLabel}
              resetLabel={resetLabel}
              disabled={disabled}
              onEdit={text => { props.edit(item.field, text) }}
              onReset={() => { props.clear(item.field) }}
            />
          ))}
        </div>
      </Section>
      <Section id="scope" title={t('scopeTitle')} hint={t('scopeHint')}>
        <div className={AGENT_IMPORT_CLASS.toggles}>
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
        </div>
        <div className={AGENT_IMPORT_CLASS.field}>
          {COUNT_FIELDS.map(item => (
            <ValueField
              key={item.field}
              item={item}
              state={state.values[item.field]}
              t={t}
              overriddenLabel={overriddenLabel}
              resetLabel={resetLabel}
              disabled={disabled}
              onEdit={text => { props.edit(item.field, text) }}
              onReset={() => { props.clear(item.field) }}
            />
          ))}
        </div>
      </Section>
      <Section id="serverDenyList" title={t('serverDenyList')} hint={t('serverDenyListHint')}>
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
        <div className={AGENT_IMPORT_CLASS.list}>
          {state.serverDenyList.rows.map((row, index) => (
            // A row's identity is its position: the editor stages the whole list,
            // so a removed row must not carry a later row's draft into its slot.
            <div className={AGENT_IMPORT_CLASS.listRow} key={index}>
              <Input
                value={row}
                disabled={disabled}
                aria-label={t('denyEntryName', { index: index + 1 })}
                onChange={(event) => { props.setList('serverDenyList', replaceAt(state.serverDenyList.rows, index, event.target.value)) }}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={t('denyEntryRemove', { index: index + 1 })}
                onClick={() => { props.setList('serverDenyList', state.serverDenyList.rows.filter((_row, position) => position !== index)) }}
              >
                {t('remove')}
              </Button>
            </div>
          ))}
        </div>
        <div className={AGENT_IMPORT_CLASS.actions}>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => { props.setList('serverDenyList', [...state.serverDenyList.rows, '']) }}
          >
            {t('addDenyEntry')}
          </Button>
        </div>
      </Section>
    </SettingsForm>
  )
}

/** The loaded-items section: what the current import mounted and published, and when it was built. */
function LoadedItems(props: {
  t: AgentImportCardProps['t']
  report: AgentImportReportState
  onRefresh: () => void
}) {
  const { t, report } = props
  return (
    <>
      <div className={AGENT_IMPORT_CLASS.summary}>
        <span className={AGENT_IMPORT_CLASS.summaryText}>
          {report.phase === 'ready'
            ? t('loadedSummary', { skills: report.report.skills.length, servers: report.report.servers.length })
            : report.phase === 'loading' ? t('reportLoading') : t('reportUnavailable', { reason: report.reason })}
        </span>
        <Button size="sm" variant="ghost" onClick={props.onRefresh}>{t('refresh')}</Button>
      </div>
      {report.phase === 'ready' ? <LoadedLists t={t} report={report.report} /> : null}
    </>
  )
}

/** The skill and server rows of one report, with the notes the import recorded. */
function LoadedLists(props: { t: AgentImportCardProps['t']; report: AgentImportReport }) {
  const { t, report } = props
  return (
    <>
      <h4 className={AGENT_IMPORT_CLASS.subheading}>{t('loadedSkills')}</h4>
      {report.skills.length === 0
        ? <p className={AGENT_IMPORT_CLASS.hint}>{t('loadedNoSkills')}</p>
        : (
          <ul className={AGENT_IMPORT_CLASS.items}>
            {report.skills.map(skill => (
              // A path identifies a skill even when two roots declare one name.
              <li className={AGENT_IMPORT_CLASS.item} key={skill.path === '' ? skill.name : skill.path}>
                <span className={AGENT_IMPORT_CLASS.itemName}>{skill.name}</span>
                <Tag tone="outline">{reportedSourceLabel(t, skill.source)}</Tag>
                <PathLabel className={AGENT_IMPORT_CLASS.itemPath} path={skill.path} />
              </li>
            ))}
          </ul>
        )}
      <h4 className={AGENT_IMPORT_CLASS.subheading}>{t('loadedServers')}</h4>
      {report.servers.length === 0
        ? <p className={AGENT_IMPORT_CLASS.hint}>{t('loadedNoServers')}</p>
        : (
          <ul className={AGENT_IMPORT_CLASS.items}>
            {report.servers.map(server => (
              <li className={AGENT_IMPORT_CLASS.item} key={`${server.name}:${server.serverName ?? ''}`}>
                <span className={AGENT_IMPORT_CLASS.itemName}>{server.name}</span>
                <Tag tone={server.status === 'mounted' ? 'success' : 'warning'}>
                  {server.status === 'mounted' ? t('loadedMounted') : t('loadedSkipped')}
                </Tag>
                <span className={AGENT_IMPORT_CLASS.itemPath}>{server.target}</span>
                {server.reason === undefined ? null : <span className={AGENT_IMPORT_CLASS.itemNote}>{server.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      {report.notes.length === 0
        ? null
        : (
          <>
            <h4 className={AGENT_IMPORT_CLASS.subheading}>{t('loadedNotes')}</h4>
            <ul className={AGENT_IMPORT_CLASS.itemNotes}>
              {report.notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          </>
        )}
    </>
  )
}

/** One titled group of controls, with the page's own heading level and spacing. */
function Section(props: { id: string; title: string; hint: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section className={AGENT_IMPORT_CLASS.section} aria-labelledby={headingId}>
      <h3 className={AGENT_IMPORT_CLASS.heading} id={headingId}>{props.title}</h3>
      <p className={AGENT_IMPORT_CLASS.hint}>{props.hint}</p>
      {props.children}
    </section>
  )
}

/** One staged text or number field, with its override badge and reset. */
function ValueField(props: {
  item: ControlField<AgentImportInputFieldId>
  state: AgentImportPageState['values'][AgentImportInputFieldId]
  t: (key: AgentImportLocaleKey) => string
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <SettingsValueField
      id={`plugin-config-agent-import-${props.item.field}`}
      label={props.t(props.item.labelKey)}
      hint={props.t(props.item.hintKey)}
      overriddenLabel={props.overriddenLabel}
      resetLabel={props.resetLabel}
      invalidLabel={props.t('invalidNumber')}
      numeric={AGENT_IMPORT_FIELDS[props.item.field].kind === 'count'}
      disabled={props.disabled}
      {...props.state}
      onEdit={props.onEdit}
      onReset={props.onReset}
    />
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
    <div className={AGENT_IMPORT_CLASS.toggle}>
      <Switch
        checked={props.state.checked}
        disabled={props.disabled}
        label={props.label}
        onChange={props.onChange}
      />
      <div className={AGENT_IMPORT_CLASS.toggleText}>
        <span className={AGENT_IMPORT_CLASS.toggleLabel}>{props.label}</span>
        <p className={AGENT_IMPORT_CLASS.hint}>{props.hint}</p>
      </div>
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
    <span className={AGENT_IMPORT_CLASS.override}>
      <Tag tone="neutral">{props.overriddenLabel}</Tag>
      <Button size="sm" variant="ghost" disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</Button>
    </span>
  )
}

/** The copy naming one selectable source. */
function sourceLabel(t: (key: AgentImportLocaleKey) => string, source: ForeignSource): string {
  return source === 'codex' ? t('sourceCodex') : t('sourceClaudeCode')
}

/** The copy naming one reported source, which no configuration bounds to the adapters of this build. */
function reportedSourceLabel(t: AgentImportCardProps['t'], source: string): string {
  return source === 'codex' || source === 'claude-code' ? sourceLabel(t, source) : source
}

/**
 * The source selection after one checkbox changes.
 * @param choices - the current choices.
 * @param value - the choice that changed.
 * @param checked - the state it changed to.
 * @returns the source names to read, in precedence order.
 */
function selectionAfter(
  choices: readonly AgentImportSourceState[],
  value: ForeignSource,
  checked: boolean,
): readonly ForeignSource[] {
  return choices
    .filter(choice => choice.value === value ? checked : choice.checked)
    .map(choice => choice.value)
}

/**
 * One list row with a value replaced.
 * @param rows - the current rows.
 * @param index - the row to replace.
 * @param value - the value to put there.
 * @returns the rows with that one replaced.
 */
function replaceAt(rows: readonly string[], index: number, value: string): readonly string[] {
  return rows.map((row, position) => position === index ? value : row)
}
