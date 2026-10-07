/**
 * The agent-import settings card, browser half: the fields the Host serves for
 * the `agent-import` Loader row of `@deepseek-ai/dsh-agent-import`, plus the
 * skill catalog that row can act on and the report of what it already imported.
 *
 * The controller owns one shared staged form over that row's settings
 * namespace — the section is nested, so the form reads and writes it through
 * the flat-name view — and projects it into the page state the component
 * reads. Every rendered value is the section the Host serves plus the drafts
 * staged on top of it.
 *
 * Four further stores carry what is not a setting: the import report, the
 * catalog of skills every known tool offers, the outcome of the last import or
 * removal, and the instruction body the detail view is reading. They are
 * separate because they change on different clocks than the form. The catalog
 * is read on demand rather than on load — building it scans every agent's skill
 * directories, which is far too much work to repeat while the page is merely
 * open.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, type SettingsFieldState, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  AGENT_IMPORT_FIELDS, FOREIGN_SOURCES, SKILL_IMPORT_SOURCES, listDraft, listRows, sourceDraft, sourceSelection,
  type AgentImportChoiceFieldId, type AgentImportFieldId, type AgentImportInputFieldId,
  type AgentImportListFieldId, type AgentImportSettings, type AgentImportToggleFieldId, type ForeignSource,
} from './agent-import-fields.ts'
import { flatScope } from './agent-import-flat-scope.ts'
import type { AgentImportReport, AgentImportReportResult } from './agent-import-report.ts'
import {
  loadSkillCatalog, loadSkillContent, sendSkillImport, sendSkillRemoval,
} from './agent-import-skills.ts'
import type {
  SkillCatalog, SkillCatalogResult, SkillContentReport, SkillContentRequest, SkillContentResult,
  SkillImportOutcome, SkillImportRequest, SkillMutationResult, SkillSourceId,
} from './agent-import-skills.ts'

/** Every field of the row, in the order the page renders its controls. */
const FIELDS = Object.values(AGENT_IMPORT_FIELDS)

/**
 * Settings namespace the Host serves for this plugin's Loader row. Spelled here
 * rather than read from the Host half's modules: the value is a Loader row id
 * (`configForms` keys forms by entry id), not something the plugin body knows.
 */
export const AGENT_IMPORT_NS = 'agent-import'

/** One selectable value and whether the row names it. */
export interface AgentImportChoiceState<Value extends string> {
  /** The tool or source the choice names. */
  readonly value: Value
  /** Whether the row currently names it. */
  readonly checked: boolean
}

/** One selectable MCP source and whether the row reads it. */
export type AgentImportSourceState = AgentImportChoiceState<ForeignSource>

/** One selectable skill source and whether automatic import links it. */
export type AgentImportSkillSourceState = AgentImportChoiceState<SkillSourceId>

/** One switch control's state. */
export interface AgentImportToggleState {
  /** Whether the switch is on. */
  readonly checked: boolean
  /** Whether the user layer carries this field. */
  readonly overridden: boolean
}

/** The deny-list editor's state. */
export interface AgentImportListState {
  /** Server names to leave unmounted, one editor row each. */
  readonly rows: readonly string[]
  /** Whether the user layer carries the list. */
  readonly overridden: boolean
}

/** The edits the page stages over the row's section. */
export interface AgentImportFormActions {
  /**
   * Stage draft text for a text or number field.
   * @param field - the field being typed into.
   * @param text - the draft text.
   */
  readonly edit: (field: AgentImportInputFieldId, text: string) => void
  /**
   * Stage a clear, so saving lets the field re-inherit the composition layer.
   * @param field - the field to clear.
   */
  readonly clear: (field: AgentImportFieldId) => void
  /**
   * Stage a switch.
   * @param field - the switch being toggled.
   * @param checked - the state the switch is set to.
   */
  readonly setToggle: (field: AgentImportToggleFieldId, checked: boolean) => void
  /**
   * Stage the tools a selection names.
   * @param field - the source selection, for MCP servers or for automatic import.
   * @param values - the tools to name, in precedence order.
   */
  readonly setChoices: (field: AgentImportChoiceFieldId, values: readonly string[]) => void
  /**
   * Stage the server names to leave unmounted.
   * @param field - the deny list.
   * @param rows - one server name per editor row.
   */
  readonly setList: (field: AgentImportListFieldId, rows: readonly string[]) => void
  /** Write every staged edit. */
  readonly save: () => void
  /** Drop every staged edit. */
  readonly discard: () => void
}

/** Everything the agent-import settings card renders. */
export interface AgentImportPageState extends SettingsFormShell {
  /** The MCP sources to read, in the order the plugin imports them. */
  readonly sources: { readonly choices: readonly AgentImportSourceState[]; readonly overridden: boolean }
  /** The sources automatic import links, in precedence order. */
  readonly skillSources: { readonly choices: readonly AgentImportSkillSourceState[]; readonly overridden: boolean }
  /** Foreign server names to leave unmounted. */
  readonly serverDenyList: AgentImportListState
  /** The text and number controls, each with its draft and override state. */
  readonly values: Readonly<Record<AgentImportInputFieldId, SettingsFieldState>>
  /** The switches, by field. */
  readonly switches: Readonly<Record<AgentImportToggleFieldId, AgentImportToggleState>>
}

/** What the card's loaded-items section renders. */
export type AgentImportReportState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly report: AgentImportReport }
  | { readonly phase: 'unavailable'; readonly reason: string }

/** What the card's Skills tab renders. */
export type AgentImportSkillsState =
  /** Nothing has been read yet: the tab reads the catalog the first time it opens. */
  | { readonly phase: 'idle' }
  /** A read is in flight. */
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly catalog: SkillCatalog }
  | { readonly phase: 'unavailable'; readonly reason: string; readonly offline?: true }

/** What the Skills tab's last import or removal produced. */
export type AgentImportSkillActionState =
  | { readonly phase: 'idle' }
  /** The mutation is in flight, for the row it names. */
  | { readonly phase: 'busy'; readonly name: string }
  /** The mutation settled: what it changed, and what it left alone. */
  | { readonly phase: 'done'; readonly outcome: SkillImportOutcome }
  | { readonly phase: 'failed'; readonly reason: string; readonly offline?: true }

/** What the Skills tab's detail view shows. */
export type AgentImportSkillContentState =
  | { readonly phase: 'closed' }
  | { readonly phase: 'loading'; readonly name: string }
  | { readonly phase: 'ready'; readonly content: SkillContentReport }
  | { readonly phase: 'unavailable'; readonly name: string; readonly reason: string; readonly offline?: true }

/** The reason fields each of the Skills tab's failure phases carries. */
interface SkillFailure {
  /** What to show the user. */
  readonly reason: string
  /** Set when the Host was never reached, so the copy can name that instead. */
  readonly offline?: true
}

/** How the Skills tab reaches the Host half's skill routes. */
export interface AgentImportSkillsPort {
  /** Read the whole catalog. */
  readonly loadCatalog: () => Promise<SkillCatalogResult>
  /** Read one skill's instruction body. */
  readonly loadContent: (request: SkillContentRequest) => Promise<SkillContentResult>
  /** Import one skill, from a chosen source or from the winning one. */
  readonly importSkill: (request: SkillImportRequest) => Promise<SkillMutationResult>
  /** Remove one import. */
  readonly removeSkill: (name: string) => Promise<SkillMutationResult>
}

/** The routes the page really calls, used unless a test passes its own port. */
const LIVE_SKILLS: AgentImportSkillsPort = {
  loadCatalog: loadSkillCatalog,
  loadContent: loadSkillContent,
  importSkill: sendSkillImport,
  removeSkill: sendSkillRemoval,
}

/**
 * Carry one route failure into the fields a store's failure phase shows.
 * @param failure - why the route produced nothing.
 * @returns the reason, marked offline when the page never reached the Host.
 */
function failureFields(failure: SkillFailure): SkillFailure {
  return { reason: failure.reason, ...failure.offline === true ? { offline: true } : {} }
}

/** What the card's slot registration injects into the page component. */
export interface AgentImportCardFace extends AgentImportFormActions {
  /** Read the Host half's import report again. */
  readonly refreshReport: () => void
  /** Read the Host half's skill catalog again. */
  readonly refreshSkills: () => void
  /**
   * Import one skill, then read the catalog again.
   * @param request - the name to import, and optionally which source and whether to replace.
   */
  readonly importSkill: (request: SkillImportRequest) => void
  /**
   * Remove one import, then read the catalog again.
   * @param name - name dsh addresses the skill by.
   */
  readonly removeSkill: (name: string) => void
  /**
   * Read one skill's instruction body into the detail view.
   * @param request - the name to read, and optionally which source's copy.
   */
  readonly openSkill: (request: SkillContentRequest) => void
  /** Leave the detail view. */
  readonly closeSkill: () => void
  hooks: {
    /** Page snapshot the renderer binds as `useAgentImportCard`. */
    agentImportCard: SnapshotStore<AgentImportPageState>
    /** Loaded-items snapshot the renderer binds as `useAgentImportReport`. */
    agentImportReport: SnapshotStore<AgentImportReportState>
    /** Skill catalog snapshot the renderer binds as `useAgentImportSkills`. */
    agentImportSkills: SnapshotStore<AgentImportSkillsState>
    /** Last-mutation snapshot the renderer binds as `useAgentImportSkillAction`. */
    agentImportSkillAction: SnapshotStore<AgentImportSkillActionState>
    /** Detail-view snapshot the renderer binds as `useAgentImportSkillContent`. */
    agentImportSkillContent: SnapshotStore<AgentImportSkillContentState>
  }
}

/** Stages and writes the settings of this plugin's Loader row. */
export class AgentImportCardController {
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly store: SnapshotStore<AgentImportPageState>
  private readonly reports: SnapshotStore<AgentImportReportState> = createSnapshotStore<AgentImportReportState>({ phase: 'loading' })
  private readonly skills: SnapshotStore<AgentImportSkillsState> = createSnapshotStore<AgentImportSkillsState>({ phase: 'idle' })
  private readonly skillAction: SnapshotStore<AgentImportSkillActionState> = createSnapshotStore<AgentImportSkillActionState>({ phase: 'idle' })
  private readonly skillContent: SnapshotStore<AgentImportSkillContentState> = createSnapshotStore<AgentImportSkillContentState>({ phase: 'closed' })
  private readonly loadReport: () => Promise<AgentImportReportResult>
  private readonly port: AgentImportSkillsPort
  private disposed = false

  /**
   * @param scope - the shared configuration form for the row's settings namespace.
   * @param loadReport - reads the Host half's import report; injected so the card's tests drive it directly.
   * @param port - the Host half's skill routes; injected so the Skills tab's tests drive it directly.
   */
  constructor(
    scope: SettingsFormScope<AgentImportSettings>,
    loadReport: () => Promise<AgentImportReportResult>,
    port: AgentImportSkillsPort = LIVE_SKILLS,
  ) {
    this.loadReport = loadReport
    this.port = port
    this.form = new SettingsFormModel(
      flatScope(scope, FIELDS.map(field => field.field)),
      FIELDS.map(field => field.spec),
    )
    this.store = this.form.bind(() => this.projection())
  }

  /** Read the Host half's import report again, replacing what the card shows. */
  refreshReport(): void {
    void this.loadReport().then(
      (result) => {
        if (this.disposed) return
        this.reports.set(result.phase === 'ready'
          ? { phase: 'ready', report: result.report }
          : { phase: 'unavailable', reason: result.reason })
      },
      (error: unknown) => {
        if (this.disposed) return
        this.reports.set({ phase: 'unavailable', reason: String(error) })
      },
    )
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the edit actions plus the bound page snapshot.
   */
  inject(): AgentImportCardFace {
    const actions = this.form.actions()
    return {
      edit: (field, text) => { actions.edit(field, text) },
      clear: (field) => { actions.resetField(field) },
      setToggle: (field, checked) => { actions.edit(field, String(checked)) },
      setChoices: (field, values) => { actions.edit(field, sourceDraft(values)) },
      setList: (field, rows) => { actions.edit(field, listDraft(rows)) },
      save: actions.save,
      discard: actions.discard,
      refreshReport: () => { this.refreshReport() },
      refreshSkills: () => { this.refreshSkills() },
      importSkill: (request) => { this.importSkill(request) },
      removeSkill: (name) => { this.removeSkill(name) },
      openSkill: (request) => { this.openSkill(request) },
      closeSkill: () => { this.closeSkill() },
      hooks: {
        agentImportCard: this.store,
        agentImportReport: this.reports,
        agentImportSkills: this.skills,
        agentImportSkillAction: this.skillAction,
        agentImportSkillContent: this.skillContent,
      },
    }
  }

  /**
   * Read the Host half's skill catalog again, replacing what the Skills tab shows.
   *
   * The tab calls this on first open and after every mutation; the read is
   * deliberately not part of construction because it scans the filesystem.
   */
  refreshSkills(): void {
    this.skills.set({ phase: 'loading' })
    void this.port.loadCatalog().then(
      (result) => {
        if (this.disposed) return
        this.skills.set(result.phase === 'ready'
          ? { phase: 'ready', catalog: result.catalog }
          : { phase: 'unavailable', ...failureFields(result) })
      },
      (error: unknown) => {
        if (this.disposed) return
        this.skills.set({ phase: 'unavailable', reason: String(error), offline: true })
      },
    )
  }

  /**
   * Import one skill, then read the catalog again.
   * @param request - the name to import, and optionally which source and whether to replace.
   */
  importSkill(request: SkillImportRequest): void {
    this.mutate(request.name, () => this.port.importSkill(request))
  }

  /**
   * Remove one import, then read the catalog again.
   * @param name - name dsh addresses the skill by.
   */
  removeSkill(name: string): void {
    this.mutate(name, () => this.port.removeSkill(name))
  }

  /**
   * Read one skill's instruction body into the detail view.
   * @param request - the name to read, and optionally which source's copy.
   */
  openSkill(request: SkillContentRequest): void {
    this.skillContent.set({ phase: 'loading', name: request.name })
    void this.port.loadContent(request).then(
      (result) => {
        if (this.disposed) return
        this.skillContent.set(result.phase === 'ready'
          ? { phase: 'ready', content: result.content }
          : { phase: 'unavailable', name: request.name, ...failureFields(result) })
      },
      (error: unknown) => {
        if (this.disposed) return
        this.skillContent.set({ phase: 'unavailable', name: request.name, reason: String(error), offline: true })
      },
    )
  }

  /** Leave the detail view, leaving the catalog as it was. */
  closeSkill(): void {
    this.skillContent.set({ phase: 'closed' })
  }

  /**
   * Run one mutation, report what it did, and read the catalog again either way.
   *
   * The catalog is re-read even after a failure: a mutation that failed halfway
   * can still have changed what is installed, so the list is never left
   * claiming the state the page had before the attempt.
   */
  private mutate(name: string, run: () => Promise<SkillMutationResult>): void {
    this.skillAction.set({ phase: 'busy', name })
    void run().then(
      (result) => {
        if (this.disposed) return
        this.skillAction.set(result.phase === 'ready'
          ? { phase: 'done', outcome: result.outcome }
          : { phase: 'failed', ...failureFields(result) })
        this.refreshSkills()
      },
      (error: unknown) => {
        if (this.disposed) return
        this.skillAction.set({ phase: 'failed', reason: String(error), offline: true })
        this.refreshSkills()
      },
    )
  }

  /** Release the form's subscription to the Host's section. */
  dispose(): void {
    this.disposed = true
    this.form.dispose()
  }

  /** Read the page state from the form's current projections. */
  private projection(): AgentImportPageState {
    return {
      ...this.form.shell(),
      sources: this.sourceState(),
      skillSources: this.skillSourceState(),
      serverDenyList: this.listState(),
      values: {
        projectRoot: this.form.field('projectRoot'),
        'codex.home': this.form.field('codex.home'),
        'codex.configPath': this.form.field('codex.configPath'),
        'claudeCode.configDir': this.form.field('claudeCode.configDir'),
        'claudeCode.configPath': this.form.field('claudeCode.configPath'),
        maxServers: this.form.field('maxServers'),
        maxSkills: this.form.field('maxSkills'),
      },
      switches: {
        mcp: this.switchState('mcp'),
        skills: this.switchState('skills'),
        skillAutoImport: this.switchState('skillAutoImport'),
        'codex.includeSystemSkills': this.switchState('codex.includeSystemSkills'),
        failOnStartupError: this.switchState('failOnStartupError'),
      },
    }
  }

  /**
   * Read one switch.
   * @param field - the switch field.
   * @returns its state and whether the user layer carries it.
   */
  private switchState(field: AgentImportToggleFieldId): AgentImportToggleState {
    const state = this.form.field(field)
    return { checked: state.text === 'true', overridden: state.overridden }
  }

  /** Read the source selection. */
  private sourceState(): AgentImportPageState['sources'] {
    const state = this.form.field('sources')
    const selected = sourceSelection(state.text)
    return {
      choices: FOREIGN_SOURCES.map(value => ({ value, checked: selected.includes(value) })),
      overridden: state.overridden,
    }
  }

  /** Read the skill-source selection. */
  private skillSourceState(): AgentImportPageState['skillSources'] {
    const state = this.form.field('skillSources')
    const selected = sourceSelection(state.text)
    return {
      choices: SKILL_IMPORT_SOURCES.map(option => ({ value: option.id, checked: selected.includes(option.id) })),
      overridden: state.overridden,
    }
  }

  /** Read the deny list. */
  private listState(): AgentImportListState {
    const state = this.form.field('serverDenyList')
    return { rows: listRows(state.text), overridden: state.overridden }
  }
}
