/**
 * The rules view: what the rule engine is doing to arriving events, and the one
 * place a human can steer it.
 *
 * **Where the state lives.** The rule file, the hit records and the undo window
 * belong to the workbench's own engine (`@free-lzj/dsh-decision`, held by this
 * package's Host half), and the page reads that engine's surface under
 * `/dsh-console/rules/*`. A connector (mail today) feeds the engine and registers
 * the conditions and actions it knows; it does not keep a rule state of its own.
 * Every write is followed by a re-read, so what is drawn is always the engine's
 * copy.
 *
 * Two absences look different on purpose: **no engine answering** is an HTTP
 * failure, while **no connector registered** is a normal state (nothing feeds the
 * engine yet) and the page says so instead of drawing an empty rule list.
 *
 * @module @free-lzj/dsh-console/client/rules
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, Input,
  SegmentedControl, StateDot, Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.ts'
import { FlowView } from './flow-view.tsx'

/** 筛选器上的域名字：* 是所有事件，
one 是没写归属。 */
function scopeLabel(name: string, t: Translate): string {
  if (name === 'all') return t('rulesScopeAll')
  if (name === 'none') return t('ruleUnassigned')
  if (name === '*') return t('ruleScopeAll')
  return name
}
import { CLS } from './styles.ts'

/* ───────────────────────────── 端口：引擎的公开面 ───────────────────────────── */

/** One condition of a rule, as the rule file writes it. */
export interface TriageCondition {
  readonly kind: string
  readonly any?: readonly string[]
  readonly name?: string
  readonly field?: string
  readonly pattern?: string
  readonly has?: boolean
  readonly extensions?: readonly string[]
}

/** One action of a rule. 动作没有开关：列在这里就会执行。 */
export interface TriageAction {
  readonly kind: string
  readonly folder?: string
}

/** One rule, in file order. */
export interface TriageRule {
  readonly id: string
  readonly name: string
  /** 这条规则属于哪个域：连接器 id、'*'（任何事件），或缺省（永不执行）。 */
  readonly connector?: string
  readonly enabled: boolean
  readonly priority: number
  readonly when: readonly TriageCondition[]
  readonly label?: string
  readonly then: readonly TriageAction[]
}

/** What the engine says about one applied action. */
export interface TriageRunAction {
  readonly kind: string
  readonly mode: string
  readonly ok: boolean
  readonly detail: string
  readonly sessionId?: string
  /** 失败的性质：页面据此决定给「去改规则」还是「再试一次」。 */
  readonly failure?: 'config' | 'transient' | 'fatal'
}

/** One event the engine acted on. */
export interface TriageRun {
  readonly id: string
  readonly at: string
  readonly ruleId: string
  readonly ruleName: string
  readonly label: string
  /**
   * The event this run is about, as the decision core stores it.
   *
   * The core keeps the connector's own shape (`event`), so the fields below are
   * what the mail connector writes — a different connector would carry its own.
   * The page only needs the four it draws and hands back to a dry run.
   */
  readonly event: {
    readonly from: string
    readonly subject: string
    readonly folder: string
    /** Which mailbox the mail came from, so the engine can re-read it on a dry run. */
    readonly accountId?: string
    readonly uid?: number
  }
  readonly actions: readonly TriageRunAction[]
  /** 图上的足迹：带节点 id，画布用它标出哪些方块跑过。 */
  readonly nodes?: readonly {
    readonly nodeId?: string
    readonly kind: string
    readonly ok: boolean
    readonly detail: string
    readonly failure?: string
  }[]
  readonly status: string
  readonly undoableUntil?: string
  /** 人已经说过「这条我看到了」：它不再占待办。 */
  readonly acknowledged?: boolean
}

/** The rule file as the engine sees it. */
export interface TriageRules {
  readonly rules: readonly TriageRule[]
  readonly error?: { readonly message: string; readonly line?: number }
  readonly source: 'file' | 'default'
  readonly path: string
  readonly dropped: readonly string[]
  /** 没写归属、因而永不执行的规则条数。 */
  readonly unassigned: number
  /** The file's own text, so the page can show what is really on disk. */
  readonly raw?: string
  /**
   * Whether a connector has registered with the engine.
   *
   * `false` means "nothing feeds the engine yet" — not "the rule file is empty".
   * The page words those two differently.
   */
  readonly connector: boolean
  /** 这份文件是节点图格式：规则写在图里，
ules 空是对的。 */
  readonly flowMode?: boolean
}

/** One write's answer. */
export interface TriageResult {
  readonly ok: boolean
  readonly message?: string
}

/** What one rule would do to one mail, with nothing actually done. */
export interface TriageTest {
  readonly ruleId: string
  readonly ruleName: string
  readonly actions: readonly { readonly kind: string; readonly detail: string }[]
  readonly reason: string
}

/** The answer to a dry run: the verdict, or why it could not be reached. */
export type TriageTestAnswer =
  | { readonly ok: true; readonly result: TriageTest }
  | { readonly ok: false; readonly message: string }

/** 图上的一个节点，按页面需要的形状。 */
export interface TriageFlowNode {
  readonly id: string
  readonly type: string
  readonly label?: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly out?: readonly {
    readonly to: string
    readonly when?: readonly Readonly<Record<string, unknown>>[]
    readonly mode?: string
  }[]
  readonly enabled?: boolean
  readonly pos?: { readonly x: number; readonly y: number }
}

/** 一张流程图。 */
export interface TriageFlow {
  readonly id: string
  readonly name: string
  readonly connector: string
  /** 归属的事件触发器；子工作流没有这个字段。 */
  readonly trigger?: string
  readonly nodes: readonly TriageFlowNode[]
}

/** 一种节点的配置字段声明。 */
export interface TriageFieldSpec {
  readonly type: string
  readonly label?: string
  readonly required?: boolean
  readonly default?: unknown
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly placeholder?: string
  readonly hint?: string
}

/** 一种节点：能放什么、要填什么。 */
export interface TriageNodeType {
  readonly type: string
  readonly label: string
  readonly group: string
  readonly sideEffect: boolean
  readonly config?: Readonly<Record<string, TriageFieldSpec>>
  readonly outputs?: readonly { readonly key: string; readonly label?: string; readonly persist?: boolean }[]
}

/** 改一节节点的输入。 */
export interface TriageFlowPatch {
  readonly nodeId: string
  /** 这个节点在哪张图里；	rigger 这类 id 每张图都有，缺了就写错文件。 */
  readonly flowId?: string | undefined
  readonly config?: Readonly<Record<string, unknown>>
  readonly pos?: { readonly x: number; readonly y: number }
  readonly label?: string
  readonly enabled?: boolean
}

/** What the view needs from wherever the engine lives. */
export interface TriageSource {
  rules(): Promise<TriageRules>
  runs(): Promise<readonly TriageRun[]>
  /** 当前生效的图，坐标已算好。 */
  flow(focus?: string): Promise<{ readonly flows: readonly TriageFlow[]; readonly error?: string }>
  /** 能放什么、每种要填什么。 */
  nodeTypes(): Promise<readonly TriageNodeType[]>
  /** 改一个节点；只写这一处。 */
  saveFlowNode(patch: TriageFlowPatch): Promise<TriageResult>
  /** 重新自动布局：换方向、换策略，位置写回文件。 */
  autoLayout(input: { flowId: string; direction?: string; strategy?: string; align?: string }): Promise<TriageResult>
  /** 在 after 之后插一个节点；不传 after 表示接到末尾。 */
  addFlowNode(input: { after?: string; type: string }): Promise<TriageResult & { nodeId?: string }>
  /** 删一个节点，入边接到它的出边。 */
  removeFlowNode(nodeId: string): Promise<TriageResult>
  /** 改一条出边指向谁；	o 省略就是删掉这条边。 */
  relinkFlowEdge(input: { from: string; index: number; to?: string }): Promise<TriageResult>
  /** 新增一条出边：从 A 连到 B，可选带条件。 */
  addFlowEdge(input: { from: string; to: string; flowId?: string; when?: readonly Readonly<Record<string, unknown>>[] }): Promise<TriageResult>
  setEnabled(ruleId: string, enabled: boolean): Promise<TriageResult>
  movePriority(ruleId: string, direction: 'up' | 'down'): Promise<TriageResult>
  /**
   * Replace one condition's match values.
   *
   * Only the values: changing what a condition compares is a different rule, not an
   * edit of this one, so there is deliberately no way to do it from here.
   * @param ruleId - the rule.
   * @param conditionIndex - the condition's position in when.
   * @param values - the new values.
   */
  setCondition(ruleId: string, conditionIndex: number, values: readonly string[]): Promise<TriageResult>
  undo(runId: string): Promise<TriageResult>
  /**
   * 记下「这条命中记录我看到了」。
   *
   * 与 {@link undo} 完全两回事：撤销会真的去回滚已经发生的动作，而这个只影响它还要不要
   * 占着待办。一次配错的失败重试也没用，人能做的是承认它。
   * @param runId - 命中记录 id。
   * @param acknowledged - 省略即标记；false 表示取消标记。
   */
  acknowledge(runId: string, acknowledged?: boolean): Promise<TriageResult>
  /**
   * Run the current rules against one real mail without touching it.
   * @param ref - which mailbox the mail is in.
   */
  testRun(ref: { readonly accountId: string; readonly folder: string; readonly uid: number }): Promise<TriageTestAnswer>
}

/** Where the engine answers: this package's own Host half, under its own prefix. */
export const RULES_PREFIX = '/dsh-console/rules'

/** Header every rules write must carry, as the console Host requires. */
export const RULES_MUTATION_HEADER = 'x-dsh-console'

/**
 * The engine is not answering at all.
 *
 * Distinct from "no connector registered" — that state arrives as
 * `rules.connector === false` and is worded for what it is.
 */
export class TriageUnavailable extends Error {
  constructor(readonly status: number) {
    super(`the rule engine is not answering (HTTP ${String(status)})`)
    this.name = 'TriageUnavailable'
  }
}

/**
 * Read and write the rule engine over its HTTP surface.
 * @returns the source the view is driven by.
 */
export function createTriageSource(): TriageSource {
  /** One GET against the engine, throwing {@link TriageUnavailable} when absent. */
  const read = async <T,>(path: string): Promise<T> => {
    const response = await fetch(`${RULES_PREFIX}${path}`, { cache: 'no-store' })
    if (!response.ok) throw new TriageUnavailable(response.status)
    return await response.json() as T
  }

  /** One guarded POST against the engine. */
  const write = async (path: string, body: unknown): Promise<TriageResult> => {
    const response = await fetch(`${RULES_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RULES_MUTATION_HEADER]: '1' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({})) as { error?: unknown }
    if (response.ok) return { ok: true }
    return { ok: false, message: typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}` }
  }

  return {
    rules: async () => await read<TriageRules>('/state'),
    runs: async () => (await read<{ runs: readonly TriageRun[] }>('/runs')).runs,
    flow: async (focus) => await read<{ flows: readonly TriageFlow[]; error?: string }>(
      focus === undefined ? '/flow' : '/flow?focus=' + encodeURIComponent(focus),
    ),
    nodeTypes: async () => (await read<{ types: readonly TriageNodeType[] }>('/node-types')).types,
    saveFlowNode: async (patch) => await write('/flow/save', patch),
    autoLayout: async (input) => await write('/flow/layout', input),
    addFlowNode: async (input) => await write('/flow/node', { action: 'add', ...input }),
    removeFlowNode: async (nodeId) => await write('/flow/node', { action: 'remove', nodeId }),
    relinkFlowEdge: async (input) => await write('/flow/node', { action: 'link', ...input }),
    addFlowEdge: async (input) => await write('/flow/node', { action: 'connect', ...input }),
    setEnabled: async (ruleId, enabled) => await write('/enable', { ruleId, enabled }),
    movePriority: async (ruleId, direction) => await write('/priority', { ruleId, direction }),
    setCondition: async (ruleId, conditionIndex, values) =>
      await write('/condition', { ruleId, conditionIndex, values }),
    undo: async (runId) => await write('/undo', { runId }),
    acknowledge: async (runId, acknowledged = true) => await write('/ack', { runId, acknowledged }),
    testRun: async (ref) => {
      const response = await fetch(`${RULES_PREFIX}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RULES_MUTATION_HEADER]: '1' },
        body: JSON.stringify(ref),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: unknown }
        return { ok: false, message: typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}` }
      }
      return { ok: true, result: await response.json() as TriageTest }
    },
  }
}

/* ──────────────────────────────── 视图 ──────────────────────────────── */

/** Everything the view holds after one successful read. */
interface TriageSnapshot {
  readonly rules: TriageRules
  readonly runs: readonly TriageRun[]
}

/** How many hit records the page draws before it stops and says how many are left. */
export const RUNS_SHOWN = 20

/** Locale key naming one run status. */
function runStatusKey(status: string): Parameters<Translate>[0] {
  switch (status) {
    case 'done': return 'ruleRunDone'
    case 'partial': return 'ruleRunPartial'
    case 'suggested': return 'ruleRunSuggested'
    case 'undone': return 'ruleRunUndone'
    default: return 'ruleRunSkipped'
  }
}

/** The tone one run status wears. */
function runTone(status: string): TagTone {
  if (status === 'done') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'suggested') return 'info'
  return 'outline'
}

/**
 * One condition's match values, editable in place.
 *
 * A list of values is the one shape the rule file makes unambiguous (`any`), so it
 * is the one shape this page edits. Saving sends the whole list — the kernel
 * replaces it wholesale, which is why an emptied field is a real edit ("match
 * nothing") rather than a no-op.
 * @param props.t - the translate seat.
 * @param props.values - the current values.
 * @param props.onSubmit - called with the new list.
 * @returns the field, or the read-only text when nothing is being edited.
 */
function ConditionValues(props: {
  readonly t: Translate
  /** A header condition names the header it looks at; the values edit keeps it. */
  readonly label?: string
  readonly values: readonly string[]
  readonly onSubmit: (values: readonly string[]) => void
}): ReactNode {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  if (draft === undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={CLS.ruleWhenValueButton}
        title={props.t('ruleEditValuesHint')}
        aria-label={`${props.t('ruleEditValues')}：${props.values.join(', ')}`}
        onClick={() => { setDraft(props.values.join(', ')) }}
      >
        {props.label === undefined
          ? props.values.join(' · ')
          : `${props.label}: ${props.values.join(' · ')}`}
      </Button>
    )
  }
  const save = (): void => {
    const values = draft.split(',').map(value => value.trim()).filter(value => value !== '')
    setDraft(undefined)
    props.onSubmit(values)
  }
  return (
    <Input
      className={CLS.ruleValueInput}
      aria-label={props.t('ruleEditValues')}
      value={draft}
      autoFocus
      // 光标停在全选上：长值一打开就能看到开头，也不会在不经意间只删掉最后一个字符。
      onFocus={(event) => { event.currentTarget.select() }}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') save()
        if (event.key === 'Escape') setDraft(undefined)
      }}
    />
  )
}

/**
 * The value half of one condition, in the rule file's own vocabulary.
 *
 * Deliberately not translated word by word: these are the exact ids someone
 * writes into `rules.yml`, and mangling them behind Chinese prose would make the
 * page teach a vocabulary the file does not accept.
 * @param condition - the condition.
 * @returns the word(s) it matches on.
 */
export function conditionValue(condition: TriageCondition): string {
  if (condition.any !== undefined && condition.any.length > 0) {
    return condition.name === undefined ? condition.any.join(' · ') : `${condition.name}: ${condition.any.join(' · ')}`
  }
  if (condition.pattern !== undefined) {
    return condition.field === undefined ? condition.pattern : `${condition.field} /${condition.pattern}/`
  }
  // `has` on its own is what the `attachment` kind already says; only the
  // extension filter adds a word worth showing.
  if (condition.has !== undefined) return (condition.extensions ?? []).join(' · ')
  // A header condition with no value asks "is this header there at all".
  return condition.name ?? ''
}

/**
 * Draw the rules view.
 * @param props.t - the translate seat.
 * @param props.triage - the engine, as the plugin injected it.
 * @returns the view.
 */
export function RulesView({ t, triage }: {
  readonly t: Translate
  readonly triage: TriageSource
}): ReactNode {
  const [data, setData] = useState<TriageSnapshot | undefined>(undefined)
  /** Why the engine is not answering, or empty. */
  const [unavailable, setUnavailable] = useState('')
  /** Why the last read or write did not take, or empty. */
  const [failure, setFailure] = useState('')
  /** 编排还是列表。默认编排——规则页的第一件事是让人看懂流程。 */
  const [view, setMode] = useState<'flow' | 'list'>('flow')

  const load = useCallback(async (): Promise<void> => {
    try {
      const [rules, runs] = await Promise.all([triage.rules(), triage.runs()])
      setData({ rules, runs })
      setUnavailable('')
    } catch (error: unknown) {
      if (error instanceof TriageUnavailable) {
        setUnavailable(t('rulesUnavailable'))
        return
      }
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [t, triage])

  useEffect(() => { void load() }, [load])

  /** Run one write, report a refusal, then read the engine back. */
  const act = (work: Promise<TriageResult>): void => {
    setFailure('')
    void work.then(async (result) => {
      if (!result.ok) {
        setFailure(result.message ?? t('ruleRejected'))
        return
      }
      await load()
    })
  }

  return (
    <section className={CLS.view}>
      <header className={CLS.viewHead}>
        <h2 className={CLS.viewHeading}>{t('rulesTitle')}</h2>
        <p className={CLS.viewHint}>{t('rulesHint')}</p>
        <nav style={{ display: 'flex', gap: 18, marginTop: 4 }}>
          {(['flow', 'list'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => { setMode(mode) }}
              style={{
                fontSize: 13, lineHeight: '20px', padding: '2px 0', border: 'none', background: 'transparent', cursor: 'pointer',
                color: view === mode ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
                borderBottom: view === mode ? '2px solid var(--dsw-alias-state-business-primary)' : '2px solid transparent',
              }}
            >
              {mode === 'flow' ? '编排' : '规则列表'}
            </button>
          ))}
        </nav>
      </header>
      {failure === '' ? null : <p className={CLS.boardFailure} role="status">{failure}</p>}
      {unavailable !== ''
        ? <p className={CLS.empty}>{unavailable}</p>
        : data === undefined
          ? <p className={CLS.empty}>{t('boardLoading')}</p>
          : view === 'flow'
            // 编排视图自己读图，因为图与规则列表是同一份文件的两种读法；
            // 没有连接器时它也照样能显示（文件里可能已经有 v2 的图）。
            ? <FlowView t={t as never} triage={triage} />
            : data.rules.connector
              ? <TriageBody t={t} data={data} triage={triage} act={act} />
              // 没有连接器不是「装错了」：规则引擎在，只是还没有谁把规则喂给它。
              : <p className={CLS.empty}>{t('rulesNoConnector')}</p>}
    </section>
  )
}

/**
 * The loaded half: where the file is, the rules, and what they did lately.
 * @param props.t - the translate seat.
 * @param props.data - the rules and the runs.
 * @param props.triage - the engine.
 * @param props.act - runs one write and reloads.
 * @returns the body.
 */
function TriageBody({ t, data, triage, act }: {
  readonly t: Translate
  readonly data: TriageSnapshot
  readonly triage: TriageSource
  readonly act: (work: Promise<TriageResult>) => void
}): ReactNode {
  const { rules, runs } = data
  const now = Date.now()
  /** 按域筛选：一条规则只在它所属连接器的事件上生效，页面得能按这个维度看。 */
  const [scope, setScope] = useState('all')
  const scopes = ['all', ...new Set(rules.rules.map(rule => rule.connector ?? 'none'))]
  const shown = scope === 'all'
    ? rules.rules
    : rules.rules.filter(rule => (rule.connector ?? 'none') === scope)
  /** The last copy's outcome: the confirmation, or the instruction itself. */
  const [notice, setNotice] = useState('')
  /** Dry-run answers, keyed by the run they were asked from. */
  const [tests, setTests] = useState<Readonly<Record<string, TriageTestAnswer | 'pending'>>>({})

  /**
   * Run the current rules against the mail one hit record is about.
   *
   * The record already carries which mailbox the mail is in, which is exactly the
   * context a dry run needs — so there is no "pick a mail" control to build and
   * nothing is written: the engine answers what it *would* do.
   * @param run - the hit record whose mail to re-read.
   */
  const tryRun = (run: TriageRun): void => {
    const accountId = run.event.accountId
    const uid = run.event.uid
    if (accountId === undefined || uid === undefined) return
    setTests((current) => ({ ...current, [run.id]: 'pending' }))
    void triage.testRun({ accountId, folder: run.event.folder, uid }).then((answer) => {
      setTests((current) => ({ ...current, [run.id]: answer }))
    })
  }

  /**
   * Copy a fix instruction for one rule.
   *
   * The page can toggle a rule and flip an action's mode, but it cannot author a
   * condition — that edit belongs in the YAML, done by whoever (or whatever) can
   * write files. So the button hands over the rule's current definition as JSON
   * plus where it lives, which is enough for an agent to patch the file. When the
   * clipboard is unavailable the instruction is shown instead: a silent no-op is
   * the worst outcome here (the mail panel learned this the hard way).
   * @param rule - the rule to describe.
   */
  const copyFix = (rule: TriageRule): void => {
    const definition = JSON.stringify({ id: rule.id, when: rule.when, then: rule.then }, null, 2)
    const instruction = t('ruleFixPrompt', { path: rules.path, id: rule.id, definition })
    void (async () => {
      try {
        // `navigator.clipboard` is absent outside a secure context, so even the
        // property access belongs inside the try.
        await navigator.clipboard.writeText(instruction)
        setNotice(t('ruleCopyDone'))
      } catch {
        setNotice(`${t('ruleCopyFallback')}\n${instruction}`)
      }
    })()
  }
  return (
    <>
      {/* 复制回执放在顶部：按钮在每条规则上，回执跟在列表后面就等于没有。 */}
      {notice === '' ? null : <p className={CLS.ruleNotice} role="status">{notice}</p>}
      <p className={CLS.viewMeta} title={rules.path}>
        {t('rulesSource', { source: rules.source === 'file' ? t('rulesSourceFile') : t('rulesSourceDefault') })}
      </p>
      {rules.error !== undefined && (
        <p className={CLS.boardFailure} role="status">
          {t('rulesParseError', { message: rules.error.message })}
          {rules.error.line === undefined ? '' : ` · ${t('rulesLine', { line: rules.error.line })}`}
        </p>
      )}
      {rules.dropped.length > 0 && (
        <ul className={CLS.ruleDropped}>
          {rules.dropped.map((entry) => <li key={entry}>{t('rulesDropped', { entry })}</li>)}
        </ul>
      )}

      {rules.unassigned > 0 && (
        <p className={CLS.viewHint} role="status">
          {t('rulesUnassigned', { count: rules.unassigned })}
        </p>
      )}

      <h3 className={CLS.viewSubheading}>{t('rulesList', { count: shown.length })}</h3>
      {rules.rules.length === 0
        // 节点图格式下「没有规则」是对的：规则写在图里了。说清楚，别让人以为规则丢了。
        ? <p className={CLS.empty}>
          {rules.flowMode === true
            ? '这份规则文件是节点图格式（version: 2），规则写在图里——点上面的「编排」看流程。'
            : t('rulesNone')}
        </p>
        : (
          <>
            {/* 按域看规则：一条规则只在它所属连接器的事件上生效，这一点得看得见。 */}
            <div className={CLS.ruleScopes}>
              <SegmentedControl
                id="dsh-console-rule-scope"
                value={scope}
                label={t('rulesScope')}
                options={scopes.map(name => ({ value: name, label: scopeLabel(name, t) }))}
                onChange={(next: string) => { setScope(next) }}
              />
            </div>
            <ul className={CLS.ruleList} aria-label={t('rulesList', { count: shown.length })}>
              {shown.map((rule, index) => (
                <li key={rule.id} className={CLS.ruleItem}>
                  <div className={CLS.ruleHead}>
                    <span className={CLS.ruleOrder}>{index + 1}</span>
                    <span className={CLS.ruleName}>{rule.name}</span>
                    <Tag tone={rule.enabled ? 'success' : 'outline'}>
                      {rule.enabled ? t('ruleEnabled') : t('ruleDisabled')}
                    </Tag>
                    <Tag tone={rule.connector === undefined ? 'danger' : 'quiet'}>
                      {rule.connector === undefined
                        ? t('ruleUnassigned')
                        : rule.connector === '*' ? t('ruleScopeAll') : rule.connector}
                    </Tag>
                  <span className={CLS.ruleTools}>
                    <Button
                      size="sm"
                      icon={<IconChevronUpOutlineRegular />}
                      disabled={index === 0}
                      aria-label={t('ruleUp')}
                      onClick={() => { act(triage.movePriority(rule.id, 'up')) }}
                    />
                    <Button
                      size="sm"
                      icon={<IconChevronDownOutlineRegular />}
                      disabled={index === rules.rules.length - 1}
                      aria-label={t('ruleDown')}
                      onClick={() => { act(triage.movePriority(rule.id, 'down')) }}
                    />
                    <Button
                      size="sm"
                      onClick={() => { act(triage.setEnabled(rule.id, !rule.enabled)) }}
                    >
                      {rule.enabled ? t('ruleDisable') : t('ruleEnable')}
                    </Button>
                    <Button size="sm" onClick={() => { copyFix(rule) }}>{t('ruleCopyFix')}</Button>
                  </span>
                </div>
                <div className={CLS.ruleWhen}>
                  <span className={CLS.ruleWhenLabel}>{t('ruleWhen')}</span>
                  {rule.when.length === 0
                    ? <span className={CLS.ruleWhenValue}>{t('ruleWhenAny')}</span>
                    : rule.when.map((condition, position) => (
                      <span key={`${condition.kind}-${String(position)}`} className={CLS.ruleCondition}>
                        <Tag tone="quiet">{condition.kind}</Tag>
                        {condition.any === undefined && condition.extensions === undefined
                          // 可编辑的是「一组值」：`any` 与 `extensions` 都是这种形状。
                          // regex 的单值 `pattern`、classifier 的 `prompt` 不是——内核也会拒绝，
                          // 所以那些条件保持只读，不给一个点了没用的输入框。
                          ? <span className={CLS.ruleWhenValue}>{conditionValue(condition)}</span>
                          : (
                            <ConditionValues
                              t={t}
                              {...(condition.name === undefined ? {} : { label: condition.name })}
                              values={condition.any ?? condition.extensions ?? []}
                              onSubmit={(values) => { act(triage.setCondition(rule.id, position, values)) }}
                            />
                          )}
                      </span>
                    ))}
                </div>
                <div className={CLS.ruleThen}>
                  <span className={CLS.ruleWhenLabel}>{t('ruleThen')}</span>
                  {rule.then.map((action, position) => (
                    <span key={`${action.kind}-${String(position)}`} className={CLS.ruleAction}>
                      <Tag tone="outline">{action.kind}</Tag>
                      {action.folder === undefined ? null : (
                        <span className={CLS.ruleWhenValue}>{action.folder}</span>
                      )}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          </>
        )}

      {rules.raw === undefined
        ? null
        : (
          <details className={CLS.ruleRawBlock}>
            <summary className={CLS.ruleRawTitle}>{t('ruleRawTitle')}</summary>
            {/* 本机路径只在这个折叠区里出现：想看文件真身的人点开就能看到，不占抬头。 */}
            <p className={CLS.viewMeta} title={rules.path}>{rules.path}</p>
            <pre className={CLS.ruleRaw}>{rules.raw}</pre>
          </details>
        )}

      <h3 className={CLS.viewSubheading}>{t('rulesRuns', { count: runs.length })}</h3>
      {runs.length === 0
        ? <p className={CLS.empty}>{t('rulesRunsNone')}</p>
        : (
          <>
          <ul className={CLS.runList}>
            {runs.slice(0, RUNS_SHOWN).map((run) => {
              /** This record's dry-run answer, if it has been asked for. */
              const test = tests[run.id]
              return (
              <li key={run.id} className={CLS.runItem}>
                <div className={CLS.runHead}>
                  <span className={CLS.runWhen}>{new Date(run.at).toLocaleString()}</span>
                  <span className={CLS.runRule}>{run.ruleName}</span>
                  <span className={CLS.runSubject}>{run.event.subject === '' ? run.event.from : run.event.subject}</span>
                  <span className={CLS.runTail}>
                    <Tag tone={runTone(run.status)}>{t(runStatusKey(run.status))}</Tag>
                    {run.event.accountId !== undefined && run.event.uid !== undefined && (
                      <Button
                        size="sm"
                        disabled={tests[run.id] === 'pending'}
                        onClick={() => { tryRun(run) }}
                      >
                        {t('ruleTest')}
                      </Button>
                    )}
                    {run.undoableUntil !== undefined && Date.parse(run.undoableUntil) > now && (
                      <Button size="sm" onClick={() => { act(triage.undo(run.id)) }}>{t('ruleUndo')}</Button>
                    )}
                  </span>
                </div>
                <ul className={CLS.runActions}>
                  {run.actions.map((action) => (
                    <li key={`${action.kind}-${action.detail}`} className={CLS.runAction}>
                      <StateDot state={action.ok ? 'done' : 'error'} />
                      {action.detail}
                    </li>
                  ))}
                </ul>
                {test === undefined ? null : test === 'pending'
                  ? <p className={CLS.viewMeta}>{t('ruleTestRunning')}</p>
                  : (
                    <div className={CLS.testBox}>
                      {test.ok
                        ? (
                          <>
                            <p className={CLS.testVerdict}>
                              {t('ruleTestResult', { rule: test.result.ruleName, reason: test.result.reason })}
                            </p>
                            {test.result.actions.length > 0 && (
                              <ul className={CLS.runActions}>
                                {test.result.actions.map((action) => (
                                  <li key={`${action.kind}-${action.detail}`} className={CLS.runAction}>{action.detail}</li>
                                ))}
                              </ul>
                            )}
                          </>
                        )
                        : <p className={CLS.boardFailure}>{t('ruleTestFailed', { message: test.message })}</p>}
                    </div>
                  )}
              </li>
              )
            })}
          </ul>
          {runs.length > RUNS_SHOWN && (
            <p className={CLS.viewMeta}>{t('rulesRunsMore', { shown: RUNS_SHOWN, total: runs.length })}</p>
          )}
          </>
        )}
    </>
  )
}

/* 动作行现在是纯展示：没有三态、没有菜单。要它不跑，就把动作从 `then` 里删掉。 */
