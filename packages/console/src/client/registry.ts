/**
 * The workbench's home list, assembled where the facts are.
 *
 * A panel's title, description, order and glyph are declared by the *adopting
 * plugin's own browser half*, so only this side can render them; the Host knows
 * one id list about panels (pinned) and nothing more. This module is the join
 * the join between those two facts, plus the observable the home list
 * subscribes to.
 *
 * The list therefore contains **only adopted panels** — the workbench shows the
 * plugins that joined it, not everything the profile happens to have loaded.
 *
 * @module @free-lzj/dsh-console/client/registry
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ReactNode } from 'react'
import { CONSOLE_PANEL_ID } from '../protocol.ts'
import type { ConsolePanelDescriptor } from './contract.ts'

/** One adopted panel, plus the rendered glyph the descriptor carried. */
export interface RegisteredPanel {
  readonly descriptor: ConsolePanelDescriptor
  readonly id: string
}

/** One row of the home list, as a layout draws it. */
export interface PanelRow {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly order: number
  /** Whether the user pinned it to the top. */
  readonly pinned: boolean
  /** Free-text terms beyond the title, used by the home search. */
  readonly keywords?: readonly string[]
  /** Glyph the plugin contributed; a layout falls back to the first letter. */
  readonly icon?: ReactNode
}

/** The workbench's own id, which is also a home-list entry. */
export const SELF_ID = CONSOLE_PANEL_ID

/**
 * Live set of adopted panels.
 *
 * Registration order is stable, and the snapshot reference only changes when
 * the set does — the renderer's `useSyncExternalStore` contract.
 */
export class PanelRegistry implements ObservableSnapshot<readonly RegisteredPanel[]> {
  private readonly panels = new Map<string, RegisteredPanel>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly RegisteredPanel[] = []

  /** @returns the current entries. */
  getSnapshot(): readonly RegisteredPanel[] {
    return this.snapshot
  }

  /**
   * Observe membership changes.
   * @param fn - invalidation callback.
   * @returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Adopt one panel.
   * @param descriptor - what the panel is and how to render it.
   * @returns the disposer that withdraws it.
   */
  register(descriptor: ConsolePanelDescriptor): () => void {
    const entry: RegisteredPanel = { descriptor, id: descriptor.id }
    this.panels.set(descriptor.id, entry)
    this.publish()
    return () => {
      if (this.panels.get(descriptor.id) !== entry) return
      this.panels.delete(descriptor.id)
      this.publish()
    }
  }

  /** @returns one entry, if it is registered. */
  get(id: string): RegisteredPanel | undefined {
    return this.panels.get(id)
  }

  /** Replace the snapshot and notify, only when the membership actually moved. */
  private publish(): void {
    this.snapshot = [...this.panels.values()]
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Turn the adopted panels plus the stored pin list into home-list rows.
 *
 * Pinned rows sort first, then declaration order, then title.
 * @param panels - the adopted panels, in registration order.
 * @param pinned - panel ids the user pinned.
 * @returns the rows the home list draws.
 */
export function panelRows(
  panels: readonly RegisteredPanel[],
  pinned: readonly string[],
): PanelRow[] {
  return panels
    .map((panel): PanelRow => {
      const { descriptor } = panel
      const description = descriptor.description?.()
      const keywords = descriptor.keywords?.()
      return {
        id: descriptor.id,
        title: descriptor.title(),
        ...(description === undefined ? {} : { description }),
        order: descriptor.order ?? 1000,
        pinned: pinned.includes(descriptor.id),
        ...(keywords === undefined ? {} : { keywords }),
        ...(descriptor.icon === undefined ? {} : { icon: descriptor.icon }),
      }
    })
    .sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || left.order - right.order
      || left.title.localeCompare(right.title))
}
