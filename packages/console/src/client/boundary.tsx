/**
 * 面板的错误兜底：一块坏掉，不让整页变白。
 *
 * **为什么要有它**：DSH 升级把 `ui-primitives` 里的一个导出删掉之后，插件在渲染时抛出
 * `... is not a function`，宿主把整个 `main` 槽位判成 crashed——用户看到的就是「工作台
 * 一打开就一片空白」，连侧边栏都点不动，也拿不到任何线索。一个 40 行的边界就能把这种
 * 失败收敛成一张卡片：出错的原文摆在那里，重载按钮就在旁边。
 *
 * 边界本身**刻意不依赖任何插件内部状态**：只用 React 和两个文案字符串，越简单越不会
 * 跟着一起坏。
 *
 * @module @free-dsh-plugins/dsh-console/client/boundary
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { Translate } from './locales.ts'

/** 兜底卡片的属性。 */
export interface PanelBoundaryProps {
  readonly title: string
  readonly hint: string
  readonly reload: string
  readonly children: ReactNode
}

/** 兜底卡片的状态。 */
interface PanelBoundaryState {
  readonly error?: string
}

/**
 * 给一个面板套上边界。
 * @param Inner - 真正的页面组件（拿得到 `t`）。
 * @returns 同签名的、出错也不会把整页带走的版本。
 */
export function withPanelBoundary<P extends { readonly t: Translate }>(
  Inner: (props: P) => ReactNode,
): (props: P) => ReactNode {
  return function GuardedPanel(props: P): ReactNode {
    return (
      <PanelBoundary
        title={props.t('panelCrashed')}
        hint={props.t('panelCrashedHint')}
        reload={props.t('panelReload')}
      >
        <Inner {...props} />
      </PanelBoundary>
    )
  }
}

/**
 * 捕获子树里的渲染错误并画一张卡片。
 *
 * React 只支持类组件做错误边界，所以这里是一个类——不是风格选择。
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  constructor(props: PanelBoundaryProps) {
    super(props)
    this.state = {}
  }

  static getDerivedStateFromError(error: unknown): PanelBoundaryState {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份带组件栈的记录：页面上只放一句话，细节留给排查的人。
    console.error('[dsh-console] panel crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { title, hint, reload, children } = this.props
    const { error } = this.state
    if (error === undefined) return children
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 16,
          margin: 16,
          borderRadius: 'var(--dsw-radius-lg)',
          border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)',
          background: 'var(--dsw-alias-bg-layer-1)',
        }}
      >
        <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>{hint}</div>
        <code
          style={{
            fontSize: 12,
            lineHeight: '18px',
            padding: '6px 8px',
            borderRadius: 'var(--dsw-radius-sm)',
            background: 'var(--dsw-alias-bg-layer-3)',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error}
        </code>
        <button
          type="button"
          onClick={() => { window.location.reload() }}
          style={{
            alignSelf: 'flex-start',
            fontSize: 12,
            lineHeight: '18px',
            padding: '4px 10px',
            borderRadius: 'var(--dsw-radius-sm)',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-3)',
            color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer',
          }}
        >
          {reload}
        </button>
      </div>
    )
  }
}
