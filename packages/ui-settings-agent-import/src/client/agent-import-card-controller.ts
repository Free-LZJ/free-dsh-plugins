/**
 * The agent-import settings card, browser half: the ten fields the Host serves
 * for the `agent-import` Loader row of `@deepseek-ai/dsh-agent-import`.
 *
 * The controller owns one shared staged form over that row's settings
 * namespace — the section is nested, so the form reads and writes it through
 * the flat-name view — and projects it into the page state the component
 * reads. Every rendered value is the section the Host serves plus the drafts
 * staged on top of it.
 *
 * A second store carries what the import actually produced, which the Host
 * answers on its own route and this controller reads on demand; it is separate
 * because it changes on a different clock than the form.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, type SettingsFieldState, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  AGENT_IMPORT_FIELDS, FOREIGN_SOURCES, listDraft, listRows, sourceDraft, sourceSelection,
  type AgentImportChoiceFieldId, type AgentImportFieldId, type AgentImportInputFieldId,
  type AgentImportListFieldId, type AgentImportSettings, type AgentImportToggleFieldId, type ForeignSource,
} from './agent-import-fields.ts'
import { flatScope } from './agent-import-flat-scope.ts'
import type { AgentImportReport, AgentImportReportResult } from './agent-import-report.ts'

/** Every field of the row, in the order the page renders its controls. */
const FIELDS = Object.values(AGENT_IMPORT_FIELDS)

/**
 * Settings namespace the Host serves for this plugin's Loader row. Spelled here
 * rather than imported: a client package must not depend on a Host package.
 */
export const AGENT_IMPORT_NS = 'agent-import'

/** One selectable source and whether the row reads it. */
export interface AgentImportSourceState {
  /** The foreign tool. */
  readonly value: ForeignSource
  /** Whether the row currently reads it. */
  readonly checked: boolean
}

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
   * Stage the tools to read.
   * @param field - the source selection.
   * @param values - the tools to read, in precedence order.
   */
  readonly setChoices: (field: AgentImportChoiceFieldId, values: readonly ForeignSource[]) => void
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
  /** The tools to read, in the order the plugin imports them. */
  readonly sources: { readonly choices: readonly AgentImportSourceState[]; readonly overridden: boolean }
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

/** What the card's slot registration injects into the page component. */
export interface AgentImportCardFace extends AgentImportFormActions {
  /** Read the Host half's import report again. */
  readonly refreshReport: () => void
  hooks: {
    /** Page snapshot the renderer binds as `useAgentImportCard`. */
    agentImportCard: SnapshotStore<AgentImportPageState>
    /** Loaded-items snapshot the renderer binds as `useAgentImportReport`. */
    agentImportReport: SnapshotStore<AgentImportReportState>
  }
}

/** Stages and writes the settings of this plugin's Loader row. */
export class AgentImportCardController {
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly store: SnapshotStore<AgentImportPageState>
  private readonly reports: SnapshotStore<AgentImportReportState> = createSnapshotStore<AgentImportReportState>({ phase: 'loading' })
  private readonly loadReport: () => Promise<AgentImportReportResult>
  private disposed = false

  /**
   * @param scope - the shared configuration form for the row's settings namespace.
   * @param loadReport - reads the Host half's import report; injected so the card's tests drive it directly.
   */
  constructor(scope: SettingsFormScope<AgentImportSettings>, loadReport: () => Promise<AgentImportReportResult>) {
    this.loadReport = loadReport
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
      hooks: { agentImportCard: this.store, agentImportReport: this.reports },
    }
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

  /** Read the deny list. */
  private listState(): AgentImportListState {
    const state = this.form.field('serverDenyList')
    return { rows: listRows(state.text), overridden: state.overridden }
  }
}
