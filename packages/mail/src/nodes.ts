/**
 * 邮件连接器贡献的**动作节点**。
 *
 * 两个都不改外部世界，但都有成本、会失败、要看结果，所以是动作而不是条件：
 *
 * - `mail.fetch` 读一次 IMAP，把正文写进 `memory`（不落盘）。
 * - `classify` 花一次模型调用，把标签写进 `facts`。
 *
 * 它们做成节点之后，**条件就没有任何 IO 了**：`switch` 只读上下文，不读邮箱、不调模型。
 * 这是「动作与条件分开」的落点——以前的 `classifier` 条件自己调模型，规则文件里看不出
 * 那次调用花了什么。
 *
 * 端口通过闭包注入（与 `createMailClassify` 同一模式），因为 `FlowNode.run` 只拿到
 * 图的上下文，不该认识 IMAP 或 LLM。
 *
 * @module @free-lzj/dsh-mail/nodes
 */

import type { FlowNode, FlowNodeSpec } from '@free-lzj/dsh-decision'
import { routeOf } from './model-route.ts'
import type { MailConnectorDeps } from './connector.ts'

/** 默认正文字节上限：够做匹配与分类，又不至于把内存吃光。 */
const DEFAULT_MAX_BYTES = 32 * 1024

/** 从事件投影里取一个必填字段。 */
function required(context: { readonly event: Readonly<Record<string, string>> }, key: string): string | undefined {
  const value = context.event[key]
  return value === undefined || value === '' ? undefined : value
}

/**
 * `mail.fetch`：把正文读进 `memory`。
 *
 * 产出的 `body` 声明为 `persist: false`——任务落盘时它会丢，所以**跨越挂起点的下游
 * 节点不能依赖它**：要么恢复后重读，要么在挂起前把需要的那几行写进 `vars`。
 * @param deps - 邮件端口。
 * @returns 节点。
 */
function fetchNode(deps: MailConnectorDeps): FlowNode {
  return {
    type: 'mail.fetch',
    label: '读邮件正文',
    group: 'action',
    sideEffect: false,
    config: {
      maxBytes: { type: 'number', label: '正文字节上限', default: DEFAULT_MAX_BYTES, hint: '超出部分截断' },
    },
    outputs: [{ key: 'body', persist: false, label: '正文纯文本' }],
    async run(spec: FlowNodeSpec, context) {
      const accountId = required(context, 'accountId')
      const folder = required(context, 'folder')
      const rawUid = required(context, 'uid')
      if (accountId === undefined || folder === undefined || rawUid === undefined) {
        return { ok: false, detail: '事件里缺 accountId / folder / uid，读不了正文', failure: 'config' }
      }
      const uid = Number(rawUid)
      if (!Number.isInteger(uid) || uid < 0) {
        return { ok: false, detail: `事件里的 uid「${rawUid}」不是正整数`, failure: 'config' }
      }
      const limit = typeof spec.config?.['maxBytes'] === 'number'
        ? Math.max(1, spec.config['maxBytes'])
        : DEFAULT_MAX_BYTES

      let detail
      try {
        detail = await deps.mail.fetchDetail(accountId, folder, uid)
      } catch (error: unknown) {
        return {
          ok: false,
          detail: `读邮件失败：${error instanceof Error ? error.message : String(error)}`,
          failure: 'transient',
        }
      }
      if (detail === undefined) {
        return { ok: false, detail: '这封邮件已经不在原目录了', failure: 'transient' }
      }

      const text = detail.text.slice(0, limit)
      const truncated = detail.text.length > limit ? `（截断自 ${String(detail.text.length)} 字）` : ''
      return { ok: true, detail: `读到 ${String(text.length)} 字${truncated}`, output: { body: text } }
    },
  }
}

/**
 * `classify`：问一次模型「这封属于哪一类」。
 *
 * 标签集与说明来自节点配置，不再从规则文件里推断——所以「这次分类会花一次调用」
 * 在图上看得见。
 * @param deps - 模型端口。
 * @returns 节点。
 */
function classifyNode(deps: MailConnectorDeps): FlowNode {
  return {
    type: 'classify',
    label: '分类',
    group: 'action',
    sideEffect: false,
    config: {
      labels: { type: 'json', label: '候选标签', required: true, hint: '模型只能从这些标签里选一个' },
      prompt: { type: 'text', label: '标签说明', template: true, hint: '告诉模型每个标签是什么意思' },
      model: { type: 'string', label: '模型', hint: '留空就用决策配置里的默认模型' },
      maxTokens: { type: 'number', label: '输出预算', default: 4096, hint: 'reasoning 模型要留够思考空间' },
    },
    outputs: [
      { key: 'label', label: '标签' },
      { key: 'confidence', label: '置信度' },
    ],
    async run(spec: FlowNodeSpec, context) {
      const llm = deps.llm?.()
      if (llm === undefined) return { ok: false, detail: '没有挂载模型服务，无法分类', failure: 'config' }

      const config = spec.config ?? {}
      const labels = Array.isArray(config['labels'])
        ? config['labels'].filter((item): item is string => typeof item === 'string')
        : []
      if (labels.length === 0) return { ok: false, detail: '这个分类节点没有配置 labels', failure: 'config' }
      // 模型是**全局设置**，节点只在需要换的时候才写。缺省取决策配置里的那个。
      const own = typeof config['model'] === 'string' ? config['model'].trim() : ''
      const model = own !== '' ? own : (deps.config().model ?? '')
      if (model === '') return { ok: false, detail: '没有可用的模型：节点没写，决策配置里也没有', failure: 'config' }
      // 宿主只要 `{ provider, model }`。整串 `exe/deepseek-xxx` 传过去会被解析成
      // `provider: undefined`，报「no adapter registered for provider "undefined"」。
      const route = routeOf(model)
      if (route === undefined) {
        return { ok: false, detail: `分类模型名必须是 provider/model：${model}`, failure: 'config' }
      }
      const maxTokens = typeof config['maxTokens'] === 'number' ? config['maxTokens'] : 4096

      // 正文来自 memory（由 mail.fetch 写入）；没有就直接用摘要，不因此失败。
      const body = typeof context.memory['body'] === 'string' ? context.memory['body'] : ''
      const prompt = buildPrompt(labels, typeof config['prompt'] === 'string' ? config['prompt'] : '', context, body)

      const controller = new AbortController()
      let answer = ''
      const seen = new Map<string, number>()
      try {
        const call = await llm.prepareCall({ ...route, maxTokens }, controller.signal, current => current)
        for await (const chunk of call.stream({
          ...(typeof call.config === 'object' && call.config !== null ? call.config as object : {}),
          // `content` 必须是块数组：给字符串不会报错，只会被当成空消息发出去。
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          purpose: 'mail-classify',
          signal: controller.signal,
        })) {
          const type = typeof chunk.type === 'string' ? chunk.type : '(none)'
          seen.set(type, (seen.get(type) ?? 0) + 1)
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
        }
      } catch (error: unknown) {
        return {
          ok: false,
          detail: `分类调用失败：${error instanceof Error ? error.message : String(error)}`,
          failure: 'transient',
        }
      } finally {
        controller.abort()
      }

      const picked = pickLabel(answer, labels)
      if (picked.confidence === 0) {
        const kinds = [...seen].map(([type, count]) => `${type}×${String(count)}`).join(', ')
        return {
          ok: true,
          detail: answer.trim() === ''
            ? `模型没有返回文本（收到的块：${kinds === '' ? '无' : kinds}）`
            : `模型没有给出可用类别（回答：${answer.trim().slice(0, 60)}）`,
          output: { label: 'uncertain', confidence: 0 },
        }
      }
      return {
        ok: true,
        detail: `判为 ${picked.label}`,
        output: { label: picked.label, confidence: picked.confidence },
      }
    },
  }
}

/**
 * 拼分类提示词。
 *
 * 只描述「怎么分」，不写「做什么」——动作在图上的下一个节点里，模型碰不到它。
 */
function buildPrompt(
  labels: readonly string[],
  notes: string,
  context: { readonly event: Readonly<Record<string, string>> },
  body: string,
): string {
  const lines = [
    '判断这封邮件属于下面哪一个类型。只回答类型名本身，不要解释。',
    '',
    `可选类型：${labels.join(' / ')}`,
  ]
  if (notes.trim() !== '') lines.push('', notes.trim())
  lines.push(
    '',
    `发件人：${context.event['from'] ?? '(未知)'}`,
    `主题：${context.event['subject'] ?? '(无)'}`,
  )
  const content = body !== '' ? body.slice(0, 4000) : (context.event['snippet'] ?? '')
  if (content !== '') lines.push('', '正文：', content)
  return lines.join('\n')
}

/**
 * 从模型回答里挑一个合法类别。
 *
 * 三档从严到松：整段就是标签 → 去掉标点后相等 → 文本里包含。先严后松是因为「回答里
 * 含标签词」并不可靠：走了带记忆注入的网关时，回答前面会多出几行工具痕迹。
 * @param answer - 模型原始回答。
 * @param labels - 规则声明的标签集。
 * @returns 选中的标签与置信度；一个都没认出来时是 `uncertain`。
 */
export function pickLabel(answer: string, labels: readonly string[]): { label: string; confidence: number } {
  const text = answer.toLowerCase().trim()
  const lastLine = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').pop() ?? ''
  const bare = (value: string): string => value.replace(/[`"'.,!?;:()[\]{}<>\s。、，；：！？（）【】《》]+/g, '')
  const wanted = lastLine === '' ? text : lastLine

  const exact = labels.find(label => bare(label) !== '' && bare(wanted) === bare(label))
  if (exact !== undefined) return { label: exact, confidence: 0.9 }

  const loose = labels.find(label => text.includes(label.toLowerCase()))
  return loose === undefined ? { label: 'uncertain', confidence: 0 } : { label: loose, confidence: 0.8 }
}

/**
 * 邮件连接器注册的全部动作节点。
 * @param deps - 邮件与模型端口。
 * @returns 节点列表。
 */
export function createMailFlowNodes(deps: MailConnectorDeps): readonly FlowNode[] {
  return [fetchNode(deps), classifyNode(deps)]
}
