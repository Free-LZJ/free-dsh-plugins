/**
 * Connectors: the entrances and exits of the workbench.
 *
 * The design brief's first shape decision is that a connector is both: an
 * event comes in through one, an action goes out through one, and adding a
 * channel means adding a connector, never editing the core. This module holds
 * that registry — contract, implementations, registry, configuration, the
 * same four layers as every other extension point
 * (`rules/design-patterns.md`).
 *
 * v0 honesty, stated on each entry rather than buried: mail and webhook have
 * working entrances (the ingest route accepts their events, and the mail
 * plugin can hand an event over through `ctx.console.ingestWorkbenchEvent`
 * once it wires that call); DingTalk and Jira are listed, configurable, and
 * explicitly placeholders — they send no real request and their events can
 * only arrive through the same ingest route a test or a future connector
 * posts to. A placeholder is a normal state here, not a broken one: the board
 * must render a connector it cannot yet reach.
 *
 * @module @free-lzj/dsh-console/workbench/connectors
 */

import type { WorkbenchSource } from '../protocol.ts'

/** One connector implementation. */
export interface Connector {
  /** Stable id the configuration selects by. */
  readonly id: string
  /** Display label. */
  readonly label: string
  /** Which directions this connector carries. */
  readonly directions: readonly ('in' | 'out')[]
  /** Whether the entrance works in this build; a placeholder says false. */
  readonly implemented: boolean
  /** What it does today, and what it deliberately does not. */
  readonly note?: string
}

/**
 * The registry the board consults.
 *
 * Implementations register at assembly; the configuration only selects among
 * registered ids, and an id the configuration names that nobody implements is
 * dropped with a warning, not an error.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()

  /**
   * Register one implementation.
   * @param connector - the implementation.
   * @returns the unregister function.
   */
  register(connector: Connector): () => void {
    this.connectors.set(connector.id, connector)
    return () => {
      if (this.connectors.get(connector.id) === connector) this.connectors.delete(connector.id)
    }
  }

  /** @param id - connector id. @returns the implementation, or undefined. */
  get(id: string): Connector | undefined {
    return this.connectors.get(id)
  }

  /** @returns every registered implementation, in registration order. */
  list(): Connector[] {
    return [...this.connectors.values()]
  }
}

/** The connectors v0 ships, in the order the board lists them. */
export function builtinConnectors(): Connector[] {
  return [
    {
      id: 'mail',
      label: '邮件',
      directions: ['in', 'out'],
      implemented: true,
      note: '入口为工作台 ingest：邮件事件经此建卡；出站回写尚未接真实邮箱，不发信。',
    },
    {
      id: 'webhook',
      label: 'Webhook',
      directions: ['in'],
      implemented: true,
      note: '入口为工作台 ingest 路由；签名校验等生产加固待后续接入时补。',
    },
    {
      id: 'dingtalk',
      label: '钉钉',
      directions: ['in', 'out'],
      implemented: false,
      note: '占位：尚未接钉钉，不发真实消息；事件可经 ingest 路由以 dingtalk 来源投递演示。',
    },
    {
      id: 'jira',
      label: 'Jira',
      directions: ['in'],
      implemented: false,
      note: '占位：尚未接 Jira 事件，不改源单状态；导入只读、去重，写回需用户确认后另行实现。',
    },
  ]
}

/** Whether a source id names a connector direction the board knows. */
export function isWorkbenchSource(value: string): value is WorkbenchSource {
  return value === 'mail' || value === 'webhook' || value === 'dingtalk' || value === 'jira' || value === 'manual'
}
