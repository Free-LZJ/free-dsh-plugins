/**
 * 注意力队列：工作台首页的第一块，也是这个页面存在的理由。
 *
 * 首页原先只列「有哪些插件」——那是手段不是目的。一个人面对一群替他干活的 agent，
 * 真正要回答的问题是**「现在需要我决定什么」**，所以这一块排在最上面，插件目录降到
 * 它下面。
 *
 * 三件事刻意分开：待处理的排前面，已处理/已忽略的折叠在后面。否则「我处理完了吗」
 * 要靠数一遍才知道。
 *
 * @module @free-dshzlj/dsh-console/client/attention
 */

import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConsoleLogEntry, ConsoleNoticeRecord, RunningSession } from '../protocol.ts'
import type { Translate } from './locales.ts'
import { CLS } from './styles.ts'

/** 这一块要读和要调的东西。 */
export interface AttentionProps {
  readonly t: Translate
  readonly notices: readonly ConsoleNoticeRecord[]
  /** 正在跑的会话，由 Host 定期刷新。 */
  readonly running: () => readonly RunningSession[]
  /** 自动化自己做过的事，最新在前。 */
  readonly log: () => readonly ConsoleLogEntry[]
  readonly actOnItem: (id: string, actionId: string) => Promise<{ ok: boolean; message?: string }>
  readonly dismissItem: (id: string) => Promise<{ ok: boolean; message?: string }>
}

/** 条目是否还在等人。 */
function isWaiting(notice: ConsoleNoticeRecord): boolean {
  return notice.state === 'new' && (notice.snoozedUntil === undefined || notice.snoozedUntil <= Date.now())
}

/**
 * 一条要人处理的事。
 * @param props - 这一块的整体 props。
 * @param notice - 这一条。
 * @returns the row.
 */
function waitingRow(props: AttentionProps, notice: ConsoleNoticeRecord): ReactNode {
  return (
    <li key={notice.id} className={CLS.attentionItem}>
      <div className={CLS.attentionMain}>
        <span className={CLS.attentionTitle}>{notice.title}</span>
        {notice.body !== undefined && <span className={CLS.attentionBody}>{notice.body}</span>}
        <span className={CLS.attentionMeta}>
          {notice.source !== undefined && <Tag tone="outline">{notice.source}</Tag>}
          <span className={CLS.noticeTime}>{new Date(notice.createdAt).toLocaleTimeString()}</span>
        </span>
      </div>
      <div className={CLS.attentionActions}>
        {(notice.actions ?? []).map((action) => (
          <Button key={action.id} size="sm" onClick={() => { void props.actOnItem(notice.id, action.id) }}>
            {action.label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => { void props.dismissItem(notice.id) }}>
          {props.t('noticeDismiss')}
        </Button>
      </div>
    </li>
  )
}

/**
 * 注意力队列。
 * @param props - 这一块的整体 props。
 * @returns the section.
 */
export function AttentionQueue(props: AttentionProps): ReactNode {
  const waiting = props.notices.filter(isWaiting)
  const settled = props.notices.filter(notice => !isWaiting(notice)).slice(0, 5)
  const running = props.running()
  return (
    <section className={CLS.attention} aria-label={props.t('attentionTitle')}>
      <div className={CLS.attentionHead}>
        <h2 className={CLS.attentionHeading}>{props.t('attentionTitle')}</h2>
        {waiting.length === 0
          ? <Tag tone="success">{props.t('attentionClear')}</Tag>
          : <Tag tone="info">{props.t('attentionCount', { count: waiting.length })}</Tag>}
      </div>
      {/*
        「它现在在替我干什么」和「它要我干什么」并列：一个替你干活的系统如果不可见，
        人就不敢放手。这一块只列标题与目录，不做会话浏览——那是另一个屏。
      */}
      {running.length > 0 && (
        <div className={CLS.running}>
          <span className={CLS.runningLabel}>{props.t('runningCount', { count: running.length })}</span>
          <ul className={CLS.runningList}>
            {running.slice(0, 5).map(session => (
              <li key={session.sessionId} className={CLS.runningItem}>
                <span className={CLS.attentionTitle}>{session.title === '' ? session.sessionId : session.title}</span>
                {session.cwd !== undefined && <span className={CLS.attentionBody}>{session.cwd}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {waiting.length === 0
        ? <p className={CLS.empty}>{props.t('attentionEmpty')}</p>
        : <ul className={CLS.attentionList}>{waiting.map(notice => waitingRow(props, notice))}</ul>}
      {settled.length > 0 && (
        <>
          <h3 className={CLS.attentionSubheading}>{props.t('attentionSettled')}</h3>
          <ul className={CLS.attentionList}>
            {settled.map(notice => (
              <li key={notice.id} className={CLS.attentionItem}>
                <div className={CLS.attentionMain}>
                  <span className={CLS.attentionTitle}>{notice.title}</span>
                </div>
                <Tag tone={notice.state === 'resolved' ? 'success' : 'outline'}>
                  {notice.state === 'resolved' ? props.t('noticeDone') : props.t('noticeDismissed')}
                </Tag>
              </li>
            ))}
          </ul>
        </>
      )}
      {/*
        自动化日志：它自己做过的事。**不放进上面的队列**——一天归档二十封推广的人不该
        被二十条「我做了这个」打扰；需要看的时候才看，所以这里只列最近几条。
      */}
      {props.log().length > 0 && (
        <>
          <h3 className={CLS.attentionSubheading}>{props.t('automationLog')}</h3>
          <ul className={CLS.attentionList}>
            {props.log().slice(0, 5).map(entry => (
              <li key={entry.id} className={CLS.attentionItem}>
                <div className={CLS.attentionMain}>
                  <span className={CLS.attentionTitle}>{entry.title}</span>
                  {entry.detail !== undefined && <span className={CLS.attentionBody}>{entry.detail}</span>}
                </div>
                <span className={CLS.attentionMeta}>
                  <Tag tone={entry.ok ? 'outline' : 'warning'}>{entry.source}</Tag>
                  <span className={CLS.noticeTime}>{new Date(entry.at).toLocaleTimeString()}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
