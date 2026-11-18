/**
 * 一条连线的条件的编辑器：**按条件的形状给表单**，而不是让人手写 `key: value`。
 *
 * 为什么要有它：条件原来是两行裸文本框，`from`/`header`/`regex`/`classifier` 全塞在
 * 同一套「键: 值」语法里——写错一个逗号，值是空的还是字符串全凭猜；`classifier` 的
 * 大段判定说明更是被压成一行。每种条件的字段其实就那么几个，按类型渲染出来，人才知道
 * 该填什么。
 *
 * **形状表放在这儿、而不是问 Host**：内核只认「一条 when 元素」是个不透明对象，条件
 * 语义由连接器自己收窄（`normalizeCondition`），Host 手上没有字段级 schema。所以这里
 * 给常见条件各配一份形状，**认不出的 kind 一律回落到裸编辑**——新连接器发明新条件时
 * 仍然能用，只是少了表单。
 *
 * @module @free-dsh-plugins/dsh-console/client/condition-editor
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** 一个字段该怎么填。 */
export interface ConditionFieldSpec {
  readonly key: string
  readonly label: string
  readonly kind: 'list' | 'text' | 'long' | 'enum' | 'boolean'
  /** 留空就没法判：建规则时会拦下来。 */
  readonly required?: boolean
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly placeholder?: string
  readonly hint?: string
}

/** 一种条件的形状。 */
interface ConditionShape {
  readonly label: string
  readonly fields: readonly ConditionFieldSpec[]
  /**
   * 这几个键里**至少**要有一个有值。
   *
   * 判类条件是特例：只写判定说明、不列标签也成立，只列标签、不写说明也成立，但两个都
   * 空就等于「让模型随便猜」——那不该被当成一条规则存下去。
   */
  readonly requireAny?: readonly string[]
}

/** 四种「检查哪个字段」的条件共用同一份形状：至少得写一个值，否则判不了。 */
const ANY_OF = (key: string, label: string, placeholder: string, hint?: string): ConditionFieldSpec => ({
  key,
  label,
  kind: 'list',
  required: true,
  placeholder,
  ...(hint === undefined ? {} : { hint }),
})

/** 常见条件的形状。认不出的 kind 走裸编辑。 */
export const CONDITION_SHAPES: Readonly<Record<string, ConditionShape>> = {
  from: { label: '发件人', fields: [ANY_OF('any', '发件人地址', 'a@example.com，回车添加')] },
  to: { label: '收件人', fields: [ANY_OF('any', '收件人地址', 'a@example.com，回车添加')] },
  subject: { label: '主题包含', fields: [ANY_OF('any', '关键词', '关键词，回车添加')] },
  body: { label: '正文包含', fields: [ANY_OF('any', '关键词', '关键词，回车添加')] },
  header: {
    label: '邮件头',
    fields: [
      { key: 'name', label: '头名称', kind: 'text', required: true, placeholder: 'list-unsubscribe' },
      { key: 'any', label: '值包含', kind: 'list', placeholder: '值，回车添加', hint: '留空表示「只要有这个头就命中」' },
    ],
  },
  regex: {
    label: '正则匹配',
    fields: [
      {
        key: 'field',
        label: '检查哪个字段',
        kind: 'enum',
        required: true,
        options: [
          { value: 'subject', label: '主题' },
          { value: 'body', label: '正文' },
          { value: 'from', label: '发件人' },
          { value: 'to', label: '收件人' },
        ],
      },
      { key: 'pattern', label: '正则', kind: 'text', required: true, placeholder: '\\b[A-Z][A-Z0-9]{1,9}-\\d{1,7}\\b' },
    ],
  },
  attachment: {
    label: '附件',
    fields: [
      { key: 'has', label: '带附件', kind: 'boolean' },
      { key: 'any', label: '扩展名', kind: 'list', placeholder: 'pdf、xlsx，回车添加' },
    ],
  },
  classifier: {
    label: '模型判类',
    requireAny: ['labels', 'prompt'],
    fields: [
      {
        key: 'channel',
        label: '判定通道',
        kind: 'enum',
        options: [
          { value: 'llm', label: '大模型' },
          { value: 'session', label: '当前会话' },
        ],
      },
      { key: 'labels', label: '只允许这些标签', kind: 'list', placeholder: 'dev，回车添加' },
      { key: 'prompt', label: '判定说明', kind: 'long', placeholder: '把这些标签的含义写清楚，模型照着判。' },
    ],
  },
}

/**
 * 这条条件还缺什么。
 *
 * 「缺一个必填字段」在规则文件里的后果不是「少判一点」，而是那条条件被 `normalizeCondition`
 * 判成非法、整条连同边一起消失——建规则时先在这里拦一下，别让人对着一条永远不命中的边
 * 找原因。
 *
 * @param condition - 一条 `when` 元素。
 * @returns 缺的东西，一句话一条；不缺就是空数组。
 */
export function conditionIssues(condition: Readonly<Record<string, unknown>>): string[] {
  const kind = typeof condition['kind'] === 'string' ? condition['kind'] : ''
  const shape = CONDITION_SHAPES[kind]
  // 不认识的 kind 没法校验（连接器自己的形状），交给引擎。
  if (shape === undefined) return []
  const issues: string[] = []
  for (const spec of shape.fields) {
    if (spec.required !== true) continue
    const value = condition[spec.key]
    const empty = value === undefined || value === null || value === ''
      || (Array.isArray(value) && value.length === 0)
    if (empty) issues.push(`「${shape.label}」缺 ${spec.label}`)
  }
  if (issues.length === 0 && shape.requireAny !== undefined) {
    const filled = shape.requireAny.some(key => {
      const value = condition[key]
      return value !== undefined && value !== null && value !== ''
        && !(Array.isArray(value) && value.length === 0)
    })
    if (!filled) {
      const names = shape.requireAny
        .map(key => shape.fields.find(field => field.key === key)?.label ?? key)
        .join(' 或 ')
      issues.push(`「${shape.label}」至少要有 ${names}`)
    }
  }
  return issues
}

/** 一个字段的样式基础。 */
const FIELD: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12,
  lineHeight: '18px',
  padding: '4px 6px',
  borderRadius: 'var(--dsw-radius-sm)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-settings-card-fill)',
  color: 'var(--dsw-alias-label-primary)',
}

/** 字段标题。 */
const FIELD_LABEL: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

/**
 * 字符串列表的编辑器：值摆成一片小圆角块，回车或逗号再加一个。
 * @param props - 当前值与改动回调。
 * @returns 一片 chip 加一个输入框。
 */
function ListField(props: {
  readonly value: readonly string[]
  readonly placeholder?: string
  readonly onChange: (next: readonly string[]) => void
}): ReactNode {
  const { value, placeholder, onChange } = props
  const [draft, setDraft] = useState('')

  const commit = (raw: string): void => {
    const pieces = raw.split(/[,，\n]/).map(item => item.trim()).filter(item => item !== '')
    if (pieces.length === 0) return
    const next = [...value]
    for (const piece of pieces) if (!next.includes(piece)) next.push(piece)
    onChange(next)
    setDraft('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {value.length === 0 ? null : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {value.map(item => (
            <span
              key={item}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: '100%',
                padding: '1px 4px 1px 6px',
                borderRadius: 'var(--dsw-radius-sm)',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 11,
                lineHeight: '16px',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item}</span>
              <button
                type="button"
                aria-label={`删掉 ${item}`}
                onClick={() => { onChange(value.filter(other => other !== item)) }}
                style={{ border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 11, lineHeight: '16px', padding: 0 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        placeholder={placeholder ?? '回车添加'}
        onChange={event => { setDraft(event.target.value) }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault()
            commit(draft)
          }
          // 退格清空最后一个：手不用离开键盘。
          if (event.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => { commit(draft) }}
        style={FIELD}
      />
    </div>
  )
}

/** 一条条件的编辑器。 */
export interface ConditionEditorProps {
  readonly condition: Readonly<Record<string, unknown>>
  /** 可选的 kind（页面从图上已经出现过的条件里收集）。 */
  readonly kinds: readonly string[]
  readonly onChange: (next: Record<string, unknown>) => void
  readonly onRemove: () => void
}

/**
 * 画一条条件。
 * @param props - 条件本身、可选 kind、改动与删除。
 * @returns 标题行 + 按形状渲染的字段。
 */
export function ConditionEditor({ condition, kinds, onChange, onRemove }: ConditionEditorProps): ReactNode {
  const kind = typeof condition['kind'] === 'string' ? condition['kind'] : ''
  const shape = CONDITION_SHAPES[kind]
  /** 形状里没声明的键：留着，别让高级写法在保存时被悄悄吞掉。 */
  const extras = Object.fromEntries(
    Object.entries(condition).filter(([key]) => key !== 'kind' && !(shape?.fields ?? []).some(field => field.key === key)),
  )
  const kindOptions = [...new Set([...kinds, ...(kind === '' ? [] : [kind])])]

  const field = (spec: ConditionFieldSpec): ReactNode => {
    const value = condition[spec.key]
    const set = (next: unknown): void => {
      const copy: Record<string, unknown> = { ...condition, kind }
      if (next === undefined || (Array.isArray(next) && next.length === 0) || next === '') delete copy[spec.key]
      else copy[spec.key] = next
      onChange(copy)
    }
    if (spec.kind === 'boolean') {
      return (
        <label key={spec.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px' }}>
          <input type="checkbox" checked={value === true} onChange={event => { set(event.target.checked) }} />
          {spec.label}
        </label>
      )
    }
    const control = ((): ReactNode => {
      if (spec.kind === 'list') {
        const list = Array.isArray(value) ? value.map(item => String(item)) : []
        return <ListField value={list} {...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder })} onChange={next => { set(next) }} />
      }
      if (spec.kind === 'long') {
        return (
          <textarea
            rows={5}
            spellCheck={false}
            value={typeof value === 'string' ? value : ''}
            placeholder={spec.placeholder ?? ''}
            onChange={event => { set(event.target.value) }}
            style={{ ...FIELD, resize: 'vertical' }}
          />
        )
      }
      if (spec.kind === 'enum') {
        return (
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={event => { set(event.target.value) }}
            style={FIELD}
          >
            <option value="">（未设置）</option>
            {(spec.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )
      }
      return (
        <input
          value={typeof value === 'string' ? value : ''}
          placeholder={spec.placeholder ?? ''}
          spellCheck={false}
          onChange={event => { set(event.target.value) }}
          style={FIELD}
        />
      )
    })()
    return (
      <div key={spec.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={FIELD_LABEL}>{spec.label}</span>
        {control}
        {spec.hint === undefined ? null : <span style={{ ...FIELD_LABEL, color: 'var(--dsw-alias-label-tertiary)' }}>{spec.hint}</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, borderRadius: 'var(--dsw-radius-md)', border: '0.5px solid var(--dsw-alias-border-l2)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          aria-label="条件类型"
          value={kind}
          onChange={event => {
            // 换类型等于换一条条件：旧类型的字段带过去只会变成噪声。
            onChange({ kind: event.target.value })
          }}
          style={{ ...FIELD, flex: 1 }}
        >
          {kindOptions.map(option => (
            <option key={option} value={option}>
              {CONDITION_SHAPES[option] === undefined ? option : `${CONDITION_SHAPES[option].label}（${option}）`}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label="删掉这条条件"
          style={{ fontSize: 12, padding: '4px 8px', borderRadius: 'var(--dsw-radius-sm)', border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' }}
        >
          删
        </button>
      </div>

      {shape === undefined
        ? null
        : shape.fields.map(spec => field(spec))}

      {shape === undefined || Object.keys(extras).length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={FIELD_LABEL}>其它字段（键: 值，一行一个）</span>
          <textarea
            rows={2}
            spellCheck={false}
            value={Object.entries(extras).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join('\n')}
            onChange={event => {
              const next: Record<string, unknown> = { ...condition, kind }
              for (const [key] of Object.entries(extras)) delete next[key]
              for (const line of event.target.value.split('\n')) {
                const at = line.indexOf(':')
                if (at <= 0) continue
                const key = line.slice(0, at).trim()
                const raw = line.slice(at + 1).trim()
                if (key === '' || key === 'kind') continue
                next[key] = raw.includes(',') ? raw.split(',').map(item => item.trim()).filter(item => item !== '') : raw
              }
              onChange(next)
            }}
            style={{ ...FIELD, resize: 'vertical' }}
          />
        </div>
      )}

      {shape === undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={FIELD_LABEL}>这种条件没有现成表单，按「键: 值」写（一行一个）</span>
          <textarea
            rows={3}
            spellCheck={false}
            value={Object.entries(condition).filter(([key]) => key !== 'kind').map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join('\n')}
            onChange={event => {
              const next: Record<string, unknown> = { kind }
              for (const line of event.target.value.split('\n')) {
                const at = line.indexOf(':')
                if (at <= 0) continue
                const key = line.slice(0, at).trim()
                const raw = line.slice(at + 1).trim()
                if (key === '' || key === 'kind') continue
                next[key] = raw.includes(',') ? raw.split(',').map(item => item.trim()).filter(item => item !== '') : raw
              }
              onChange(next)
            }}
            style={{ ...FIELD, resize: 'vertical' }}
          />
        </div>
      ) : null}
    </div>
  )
}
