/**
 * The Skills tab of the agent-import settings page: every skill name the known
 * tools offer, what dsh holds for each one, and the one switch that decides
 * whether dsh loads it.
 *
 * The catalog arrives whole — the Host resolves precedence, the installed state,
 * and conflicts while it scans — so this half only filters, labels, and drives
 * the mutations. Which source a row imports from is therefore always an explicit
 * choice: the default is the winner the Host marked, and the other offerings are
 * one button away, replacing the current link when there is one. Automatic import
 * narrows to the sources the configuration names, so a row outside that set is
 * flagged as one to link by hand.
 *
 * @module @deepseek-ai/dsh-agent-import/client/AgentImportSkills
 */

import { useState } from 'react'
import { Button, Input, PathLabel, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AGENT_IMPORT_CLASS } from './agent-import-card-style.ts'
import { skillSkipLabel, skillSourceLabel, skillStateLabel } from './locales.ts'
import type { AgentImportCardProps } from './AgentImportCard.tsx'
import type {
  AgentImportSkillActionState, AgentImportSkillContentState, AgentImportSkillsState,
} from './agent-import-card-controller.ts'
import type {
  SkillCatalog, SkillCandidate, SkillContentRequest, SkillImportRequest, SkillReport, SkillSourceId, SkillState,
} from './agent-import-skills.ts'

/** Palette each row's state wears, so what is installed is separable at a glance. */
const STATE_TONES: Record<SkillState, 'outline' | 'neutral' | 'success' | 'warning' | 'quiet'> = {
  available: 'outline',
  linked: 'success',
  local: 'neutral',
  broken: 'warning',
  // A name the user switched off is neither healthy nor broken: it is their own
  // decision, so the tag states it more quietly than the states around it.
  disabled: 'quiet',
}

/**
 * Whether dsh loads this name right now, which is exactly what its switch shows.
 * @param state - the state the catalog reported.
 * @returns true for every state whose switch is on.
 */
function loadsSkill(state: SkillState): boolean {
  return state === 'linked' || state === 'local' || state === 'broken'
}

/**
 * Whether a link is in place, so an import has something to replace.
 * @param state - the state the catalog reported.
 * @returns true when changing where the name points means replacing a link.
 */
function linkedSkill(state: SkillState): boolean {
  return state === 'linked' || state === 'broken'
}

/** Props the card hands the Skills tab: its actions, plus the snapshots it renders. */
export type SkillsTabProps =
  & Pick<AgentImportCardProps, 't' | 'refreshSkills' | 'importSkill' | 'removeSkill' | 'openSkill' | 'closeSkill'>
  & {
    /** The catalog read, or why there is none. */
    readonly skills: AgentImportSkillsState
    /** What the last import or removal did. */
    readonly action: AgentImportSkillActionState
    /** The instruction body the detail view is reading. */
    readonly content: AgentImportSkillContentState
    /**
     * The sources activated automatic import links. The catalog covers every known
     * source, so a row outside this set is only ever linked by hand.
     */
    readonly autoImportSources: readonly SkillSourceId[]
  }

/**
 * Render the Skills tab: its search, its feedback, and either the list or one
 * skill's instruction body.
 * @param props - locale copy, the three snapshots, and the actions that change them.
 * @returns the tab body the settings page mounts in its panel.
 */
export function SkillsTab(props: SkillsTabProps) {
  const { t, skills, action, content, autoImportSources } = props
  const [query, setQuery] = useState('')
  if (content.phase !== 'closed') {
    return (
      <>
        <p className={AGENT_IMPORT_CLASS.hint}>{t('skillsTabHint')}</p>
        <SkillDetail t={t} content={content} onClose={props.closeSkill} />
      </>
    )
  }
  // The Host resolves the whole catalog, so filtering it is a view concern.
  const rows = skills.phase === 'ready' ? matching(skills.catalog.skills, t, query) : []
  return (
    <>
      <p className={AGENT_IMPORT_CLASS.hint}>{t('skillsTabHint')}</p>
      {skills.phase === 'ready'
        ? <p className={AGENT_IMPORT_CLASS.skillMeta}>{statsLine(t, skills.catalog.skills)}</p>
        : null}
      <div className={AGENT_IMPORT_CLASS.skillSearch}>
        <Input
          value={query}
          aria-label={t('skillSearch')}
          placeholder={t('skillSearch')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <Button size="sm" variant="ghost" onClick={props.refreshSkills}>{t('skillRefresh')}</Button>
      </div>
      <p className={AGENT_IMPORT_CLASS.skillMeta}>{statusLine(t, skills, rows.length)}</p>
      <SkillFeedback t={t} action={action} />
      {skills.phase === 'ready'
        ? (
          <SkillLists
            t={t}
            catalog={skills.catalog}
            rows={rows}
            autoImportSources={autoImportSources}
            // A second press while one write is in flight would ask for the
            // opposite of what the first press asked for, so every switch waits.
            busy={action.phase === 'busy'}
            onImport={props.importSkill}
            onRemove={props.removeSkill}
            onOpen={props.openSkill}
          />
        )
        : null}
    </>
  )
}

/** The rows one read produced, with the notes the scan recorded. */
function SkillLists(props: {
  t: AgentImportCardProps['t']
  catalog: SkillCatalog
  rows: readonly SkillReport[]
  autoImportSources: readonly SkillSourceId[]
  /** Whether a write is in flight, so no switch may ask for a second one. */
  busy: boolean
  onImport: (request: SkillImportRequest) => void
  onRemove: (name: string) => void
  onOpen: (request: SkillContentRequest) => void
}) {
  const { t, catalog, rows } = props
  return (
    <>
      {rows.length === 0 && !explainedByNotes(catalog)
        ? <p className={AGENT_IMPORT_CLASS.hint}>{t('skillsEmpty')}</p>
        : null}
      <ul className={AGENT_IMPORT_CLASS.skillRows}>
        {rows.map(skill => (
          <SkillRow
            key={skill.name}
            t={t}
            skill={skill}
            autoImportSources={props.autoImportSources}
            busy={props.busy}
            onImport={props.onImport}
            onRemove={props.onRemove}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
      {catalog.notes.length === 0
        ? null
        : (
          <>
            <h4 className={AGENT_IMPORT_CLASS.subheading}>{t('skillsNotes')}</h4>
            <ul className={AGENT_IMPORT_CLASS.itemNotes}>
              {catalog.notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          </>
        )}
    </>
  )
}

/** One skill name, its offerings, and what can be done with it. */
function SkillRow(props: {
  t: AgentImportCardProps['t']
  skill: SkillReport
  autoImportSources: readonly SkillSourceId[]
  /** Whether a write is in flight, so this row's switch refuses a second one. */
  busy: boolean
  onImport: (request: SkillImportRequest) => void
  onRemove: (name: string) => void
  onOpen: (request: SkillContentRequest) => void
}) {
  const { t, skill } = props
  // What a plain import would take, and therefore what the other offerings are not.
  const installed = skill.installedSource
  const others = installed === undefined
    ? skill.candidates.filter(candidate => !candidate.winner)
    : skill.candidates.filter(candidate => candidate.source !== installed)
  // A name every offering of which sits outside the automatic set is only ever
  // linked by hand, which is worth saying before the row is clicked. A name the
  // user switched off says something else, so it never wears this tag too.
  const manual = skill.state === 'available'
    && !skill.candidates.some(candidate => props.autoImportSources.includes(candidate.source))
  /**
   * Turn this row's switch: on imports the winning copy, which also withdraws a
   * remembered removal, and off removes the link this package made.
   */
  const setLoaded = (next: boolean) => {
    if (next) props.onImport({ name: skill.name })
    else props.onRemove(skill.name)
  }
  return (
    <li className={AGENT_IMPORT_CLASS.skillRow}>
      <div className={AGENT_IMPORT_CLASS.skillHead}>
        <span className={AGENT_IMPORT_CLASS.skillName}>{skill.name}</span>
        <Tag tone={STATE_TONES[skill.state]}>{skillStateLabel(t, skill.state)}</Tag>
        {manual ? <Tag tone="quiet">{t('skillManual')}</Tag> : null}
        <span className={AGENT_IMPORT_CLASS.skillRowActions}>
          <Button size="sm" variant="ghost" onClick={() => { props.onOpen({ name: skill.name }) }}>
            {t('skillView')}
          </Button>
          {/* One switch per row: on means dsh loads this skill. A local directory
              is not this page's to unload, so its switch states that and refuses
              input rather than pressing it into a removal. */}
          <Switch
            checked={loadsSkill(skill.state)}
            disabled={skill.state === 'local' || props.busy}
            label={t('skillSwitch', { name: skill.name })}
            title={skill.state === 'local' ? t('skillLocal') : undefined}
            onChange={setLoaded}
          />
        </span>
      </div>
      {skill.description === ''
        ? null
        : <p className={AGENT_IMPORT_CLASS.skillDescription}>{skill.description}</p>}
      <p className={AGENT_IMPORT_CLASS.skillMeta}>
        {installed === undefined
          ? t('skillOfferedBy', { source: winningLabel(t, skill) })
          : t('skillInstalledFrom', { source: skillSourceLabel(t, installed, installed) })}
        {skill.installedPath === undefined
          ? null
          : <> <PathLabel path={skill.installedPath} /></>}
      </p>
      {skill.state === 'local' ? <p className={AGENT_IMPORT_CLASS.skillMeta}>{t('skillLocal')}</p> : null}
      {skill.state === 'disabled' ? <p className={AGENT_IMPORT_CLASS.skillMeta}>{t('skillDisabled')}</p> : null}
      {skill.conflict && others.length > 0
        ? (
          <div className={AGENT_IMPORT_CLASS.skillConflict}>
            <Tag tone="warning">{t('skillConflict')}</Tag>
            <span>{t('skillConflictSources', { sources: others.map(candidate => sourceLabel(t, candidate)).join(' / ') })}</span>
            {others.map(candidate => (
              <span key={candidate.source} className={AGENT_IMPORT_CLASS.skillChoice}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { props.onImport(switchRequest(skill, candidate.source)) }}
                >
                  {t('skillImportFrom', { source: sourceLabel(t, candidate) })}
                </Button>
              </span>
            ))}
          </div>
        )
        : null}
    </li>
  )
}

/** What the last import or removal did, or why it did nothing. */
function SkillFeedback(props: { t: AgentImportCardProps['t']; action: AgentImportSkillActionState }) {
  const { t, action } = props
  if (action.phase === 'idle') return null
  if (action.phase === 'busy') {
    return (
      <div className={AGENT_IMPORT_CLASS.skillFeedback}>
        <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>{t('skillActionBusy', { name: action.name })}</span>
      </div>
    )
  }
  if (action.phase === 'failed') {
    return (
      <div className={AGENT_IMPORT_CLASS.skillFeedback}>
        <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>
          {action.offline === true ? t('skillActionOffline') : t('skillActionUnavailable', { reason: action.reason })}
        </span>
      </div>
    )
  }
  const { outcome } = action
  return (
    <div className={AGENT_IMPORT_CLASS.skillFeedback}>
      {outcome.imported.length === 0
        ? null
        : (
          <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>
            {t('skillActionImported', { names: outcome.imported.join(', ') })}
          </span>
        )}
      {outcome.removed.length === 0
        ? null
        : (
          <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>
            {t('skillActionRemoved', { names: outcome.removed.join(', ') })}
          </span>
        )}
      {outcome.skipped.length === 0
        ? null
        : (
          <>
            <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>{t('skillActionSkipped')}</span>
            <ul className={AGENT_IMPORT_CLASS.itemNotes}>
              {outcome.skipped.map(skip => (
                <li key={skip.name}>
                  <span className={AGENT_IMPORT_CLASS.skillName}>{skip.name}</span>
                  {' — '}
                  <span>{skillSkipLabel(t, skip.reason)}</span>
                  {skip.detail === undefined
                    ? null
                    : <span className={AGENT_IMPORT_CLASS.cellAside}>{skip.detail}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      {outcome.notes.length === 0
        ? null
        : (
          <>
            <span className={AGENT_IMPORT_CLASS.skillFeedbackLine}>{t('skillActionNotes')}</span>
            <ul className={AGENT_IMPORT_CLASS.itemNotes}>
              {outcome.notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          </>
        )}
    </div>
  )
}

/** One skill's instruction body, with the file it was read from. */
function SkillDetail(props: {
  t: AgentImportCardProps['t']
  content: Exclude<AgentImportSkillContentState, { readonly phase: 'closed' }>
  onClose: () => void
}) {
  const { t, content } = props
  const name = content.phase === 'ready' ? content.content.name : content.name
  return (
    <div className={AGENT_IMPORT_CLASS.skillDetail}>
      <div className={AGENT_IMPORT_CLASS.skillDetailBar}>
        <span className={AGENT_IMPORT_CLASS.skillName}>{name}</span>
        <Button size="sm" variant="ghost" onClick={props.onClose}>{t('skillBack')}</Button>
      </div>
      {content.phase === 'loading'
        ? <p className={AGENT_IMPORT_CLASS.skillMeta}>{t('skillContentLoading')}</p>
        : null}
      {content.phase === 'unavailable'
        ? (
          <p className={AGENT_IMPORT_CLASS.skillMeta}>
            {content.offline === true ? t('skillContentOffline') : t('skillContentUnavailable', { reason: content.reason })}
          </p>
        )
        : null}
      {content.phase === 'ready'
        ? (
          <>
            {content.content.description === ''
              ? null
              : <p className={AGENT_IMPORT_CLASS.skillMeta}>{content.content.description}</p>}
            <p className={AGENT_IMPORT_CLASS.skillMeta}>
              {content.content.source === undefined
                ? null
                : <Tag tone="outline">{skillSourceLabel(t, content.content.source, content.content.source)}</Tag>}
              {' '}
              <PathLabel path={content.content.file} />
            </p>
            {/* The body is markdown, but rendering it is not this page's job: the
                point of the view is to read exactly what dsh would load. */}
            <pre className={AGENT_IMPORT_CLASS.skillBody}>{content.content.content}</pre>
          </>
        )
        : null}
    </div>
  )
}

/**
 * The line above the list: how much of the catalog is shown, or why none is.
 * @param t - the page's locale reader.
 * @param skills - the catalog read.
 * @param shown - how many rows the current search kept.
 * @returns the line to render.
 */
function statusLine(
  t: AgentImportCardProps['t'],
  skills: AgentImportSkillsState,
  shown: number,
): string {
  if (skills.phase === 'ready') return t('skillCount', { shown, total: skills.catalog.skills.length })
  if (skills.phase === 'unavailable') {
    return skills.offline === true ? t('skillsOffline') : t('skillsUnavailable', { reason: skills.reason })
  }
  return t('skillsLoading')
}

/**
 * The whole catalog in three numbers: what dsh loads, and what the user turned
 * off. Both are counted from the switch each row shows, so the line and the list
 * can never disagree about a name.
 * @param t - the page's locale reader.
 * @param skills - every row the read produced, before the search narrows it.
 * @returns the summary line to render.
 */
function statsLine(t: AgentImportCardProps['t'], skills: readonly SkillReport[]): string {
  let enabled = 0
  let disabled = 0
  for (const skill of skills) {
    if (loadsSkill(skill.state)) enabled += 1
    if (skill.state === 'disabled') disabled += 1
  }
  return t('skillStats', { total: skills.length, enabled, disabled })
}

/**
 * Whether the scan's own notes already explain an empty catalog.
 * @param catalog - the catalog a read produced.
 * @returns true when nothing was found and the Host said why.
 */
function explainedByNotes(catalog: SkillCatalog): boolean {
  return catalog.skills.length === 0 && catalog.notes.length > 0
}

/**
 * The rows one search keeps.
 *
 * The text is matched against what each row shows, so searching for a tool's
 * name finds everything it offers.
 */
function matching(
  skills: readonly SkillReport[],
  t: AgentImportCardProps['t'],
  query: string,
): readonly SkillReport[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return skills
  return skills.filter(skill => [skill.name, skill.description, ...skill.candidates.map(candidate => sourceLabel(t, candidate))]
    .some(text => text.toLowerCase().includes(needle)))
}

/**
 * The request that switches one row to another source.
 *
 * `replace` travels only when a link is already in place: changing where a link
 * points means replacing it, while a name nothing has linked — one that was
 * never imported, or one the user switched off — has nothing to replace.
 */
function switchRequest(skill: SkillReport, source: SkillSourceId): SkillImportRequest {
  return {
    name: skill.name,
    source,
    ...linkedSkill(skill.state) ? { replace: true } : {},
  }
}

/** The copy naming the source one offering came from, in the active language. */
function sourceLabel(t: AgentImportCardProps['t'], candidate: SkillCandidate): string {
  return skillSourceLabel(t, candidate.source, candidate.label)
}

/** The copy naming the source a plain import would take. */
function winningLabel(t: AgentImportCardProps['t'], skill: SkillReport): string {
  const winner = skill.candidates.find(candidate => candidate.winner)
  return winner === undefined ? '' : sourceLabel(t, winner)
}
