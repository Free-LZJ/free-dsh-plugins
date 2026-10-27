/**
 * The event simulator, browser half.
 *
 * The simulator is the webhook entrance in miniature: it posts an event to
 * the ingest route and shows the classification and routing the Host
 * answered with, so the whole classify → route → card → dispatch chain is
 * drivable from the page without any outside system. It lives in the
 * connectors view and is labelled as a debug tool there (decision Q7), not on
 * the board.
 *
 * @module @free-lzj/dsh-console/client/workbench/simulator
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../locales.ts'
import { CLS } from '../styles.ts'
import type { WorkbenchFace } from './board.tsx'

/** Sources the simulator offers; the ingest route accepts the same set. */
const SIM_SOURCES = ['mail', 'webhook', 'dingtalk', 'jira', 'manual'] as const

/**
 * Draw the event simulator.
 * @param props - the injected face and the translate seat.
 * @returns the simulator form and its last answer.
 */
export function WorkbenchSimulator(props: { face: WorkbenchFace; t: Translate }): ReactNode {
  const { face, t } = props
  const [source, setSource] = useState<string>('webhook')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [answer, setAnswer] = useState<Record<string, unknown> | undefined>(undefined)

  return (
    <div className={CLS.wbSim}>
      <div className={CLS.wbRow}>
        <SegmentedControl
          id="dsh-console-sim-source"
          value={source}
          label={t('simSource')}
          options={SIM_SOURCES.map((id) => ({ value: id, label: id }))}
          onChange={(next: string) => setSource(next)}
        />
      </div>
      <div className={CLS.wbRow}>
        <Input
          value={title}
          placeholder={t('simTitleLabel')}
          aria-label={t('simTitleLabel')}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Input
          value={body}
          placeholder={t('simBodyLabel')}
          aria-label={t('simBodyLabel')}
          onChange={(event) => setBody(event.target.value)}
        />
        <Button
          onClick={() => {
            if (title.trim() === '') return
            void face.ingest({
              source,
              title: title.trim(),
              ...(body.trim() === '' ? {} : { body: body.trim() }),
            }).then((result) => setAnswer(result))
          }}
        >
          {t('simSubmit')}
        </Button>
      </div>
      {answer !== undefined && (
        <p className={CLS.wbAnswer}>
          {answer.ok === true
            ? t('simResult', {
              kind: decisionKind(answer),
              confidence: decisionConfidence(answer),
              route: decisionRoute(answer),
              action: decisionAction(answer),
            })
            : t('simError', { error: typeof answer.error === 'string' ? answer.error : t('simUnknownError') })}
        </p>
      )}
    </div>
  )
}

/** The classification kind inside an ingest answer, or a dash when absent. */
function decisionKind(answer: Record<string, unknown>): string {
  const decision = answer.decision as Record<string, unknown> | undefined
  const classification = decision?.classification as Record<string, unknown> | undefined
  return typeof classification?.kind === 'string' ? classification.kind : '-'
}

/** The classification confidence inside an ingest answer, as a percent. */
function decisionConfidence(answer: Record<string, unknown>): number {
  const decision = answer.decision as Record<string, unknown> | undefined
  const classification = decision?.classification as Record<string, unknown> | undefined
  return typeof classification?.confidence === 'number' ? Math.round(classification.confidence * 100) : 0
}

/** The route id inside an ingest answer, or a dash when absent. */
function decisionRoute(answer: Record<string, unknown>): string {
  const decision = answer.decision as Record<string, unknown> | undefined
  return typeof decision?.routeId === 'string' ? decision.routeId : '-'
}

/** The routing action inside an ingest answer, or a dash when absent. */
function decisionAction(answer: Record<string, unknown>): string {
  const decision = answer.decision as Record<string, unknown> | undefined
  return typeof decision?.action === 'string' ? decision.action : '-'
}
