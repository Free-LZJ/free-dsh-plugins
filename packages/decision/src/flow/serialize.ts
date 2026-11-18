/**
 * 把图写回 YAML。
 *
 * 输出**只有结构和已定稿的渲染信息**：节点的 `pos` 会写进去（人摆过的位置要留住），
 * 但自动布局算出来的坐标不写——它每次都能重算，写进去只会让文件随刷新变脏。
 *
 * @module @free-lzj/dsh-decision/flow/serialize
 */

import { Document } from 'yaml'
import type { Flow, FlowNodeSpec } from './types.ts'

/** 写文件的选项。 */
export interface SerializeOptions {
  /** 文件顶层的缺省连接器；每张图自己的 `connector` 优先。 */
  readonly connector?: string
}

/**
 * 序列化一份图文件。
 * @param flows - 图列表。
 * @param options - 顶层缺省值。
 * @returns YAML 文本。字段顺序固定，便于 diff。
 */
export function stringifyFlowFile(flows: readonly Flow[], options: SerializeOptions = {}): string {
  const doc = new Document({
    version: FLOW_FILE_VERSION,
    ...(options.connector === undefined ? {} : { connector: options.connector }),
    flows: flows.map(flow => ({
      id: flow.id,
      name: flow.name,
      ...(flow.description === undefined ? {} : { description: flow.description }),
      connector: flow.connector,
      nodes: flow.nodes.map(serializeNode),
    })),
  })
  // 长边（`{ to, when }`）写成单行更好读；`config` 保持块状。
  doc.contents = doc.createNode(doc.toJS())
  return doc.toString({ lineWidth: 0 })
}

/** 当前文件版本。 */
export const FLOW_FILE_VERSION = 2

/**
 * 把一张图写成「单图文件」。
 *
 * 一规则一文件的形状：**顶层直接是这张图**，没有 `flows:` 包一层。文件名就说明它
 * 是什么，文件里再套一层数组只会让人多点开一次。
 * @param flow - 图。
 * @param options - 文件头注释。
 * @returns YAML 文本。
 */
export function stringifyFlowDocument(flow: Flow, options: { readonly header?: string } = {}): string {
  const doc = new Document({
    id: flow.id,
    name: flow.name,
    ...(flow.description === undefined ? {} : { description: flow.description }),
    connector: flow.connector,
    nodes: flow.nodes.map(serializeNode),
  })
  doc.contents = doc.createNode(doc.toJS())
  // YAML 库把 `commentBefore` 原样接在 `#` 后面：不补一个空格就成了 `#新建的…`，
  // 和手写的 `# 带退订头的群发` 摆在一起明显不齐。多行注释逐行补。
  if (options.header !== undefined) {
    doc.commentBefore = options.header
      .split('\n')
      .map(line => (line.startsWith(' ') ? line : ' ' + line))
      .join('\n')
  }
  return doc.toString({ lineWidth: 0 })
}

/** 只把有值的字段写出去——空数组、undefined 都不该在文件里占一行。 */
function serializeNode(node: FlowNodeSpec): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    ...(node.label === undefined ? {} : { label: node.label }),
    ...(node.desc === undefined ? {} : { desc: node.desc }),
    ...(node.config === undefined || Object.keys(node.config).length === 0 ? {} : { config: node.config }),
    ...(node.runner === undefined ? {} : { runner: node.runner }),
    ...(node.enabled === false ? { enabled: false } : {}),
    ...(node.pos === undefined ? {} : { pos: node.pos }),
    ...(node.body === undefined ? {} : { body: { nodes: node.body.nodes.map(serializeNode) } }),
    ...(node.out === undefined || node.out.length === 0
      ? {}
      : {
          out: node.out.map(edge => ({
            to: edge.to,
            ...(edge.when === undefined || edge.when.length === 0 ? {} : { when: edge.when }),
            ...(edge.mode === undefined ? {} : { mode: edge.mode }),
          })),
        }),
  }
}
