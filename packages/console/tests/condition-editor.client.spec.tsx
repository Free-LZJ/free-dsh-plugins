// @vitest-environment jsdom
/**
 * 条件编辑器：按条件的形状给表单。
 *
 * 回归点：条件原来是两行裸文本框（`键: 值`），`from`/`header`/`regex`/`classifier` 全用
 * 同一套语法——`classifier` 的大段判定说明被压成一行，`from` 的地址列表要靠逗号猜。
 *
 * @module @free-dsh-plugins/dsh-console/tests/condition-editor-client
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CONDITION_SHAPES, ConditionEditor, conditionIssues } from '../src/client/condition-editor.tsx'

afterEach(cleanup)

/** 画出编辑器并记录每次改动。 */
function draw(condition: Record<string, unknown>, kinds: readonly string[] = Object.keys(CONDITION_SHAPES)) {
  const changes: Record<string, unknown>[] = []
  let removed = 0
  const { container, rerender } = render(
    <ConditionEditor
      condition={condition}
      kinds={kinds}
      onChange={next => { changes.push(next) }}
      onRemove={() => { removed += 1 }}
    />,
  )
  return {
    container,
    changes,
    removed: () => removed,
    rerender: (next: Record<string, unknown>) => {
      rerender(<ConditionEditor condition={next} kinds={kinds} onChange={value => { changes.push(value) }} onRemove={() => { removed += 1 }} />)
    },
  }
}

describe('条件和边一起落盘之前，先看它缺什么', () => {
  it('发件人条件没写地址 = 缺东西', () => {
    expect(conditionIssues({ kind: 'from' })).toEqual(['「发件人」缺 发件人地址'])
    expect(conditionIssues({ kind: 'from', any: [] })).toHaveLength(1)
    expect(conditionIssues({ kind: 'from', any: ['a@example.com'] })).toEqual([])
  })

  it('邮件头必须有头名称，值可以空', () => {
    expect(conditionIssues({ kind: 'header' })).toEqual(['「邮件头」缺 头名称'])
    expect(conditionIssues({ kind: 'header', name: 'list-unsubscribe' })).toEqual([])
  })

  it('正则要求字段和式子都在', () => {
    expect(conditionIssues({ kind: 'regex', field: 'body' })).toEqual(['「正则匹配」缺 正则'])
    expect(conditionIssues({ kind: 'regex', pattern: 'x' })).toEqual(['「正则匹配」缺 检查哪个字段'])
    expect(conditionIssues({ kind: 'regex', field: 'body', pattern: 'x' })).toEqual([])
  })

  it('认不出的条件不拦——形状由连接器说了算', () => {
    expect(conditionIssues({ kind: 'webhook' })).toEqual([])
  })
})

describe('条件编辑器', () => {
  it('发件人条件给的是地址列表，不是裸文本框', () => {
    const { container } = draw({ kind: 'from', any: ['a@example.com'] })
    expect(screen.getByText('发件人地址')).toBeTruthy()
    // 已有的值摆成 chip。
    expect(screen.getByText('a@example.com')).toBeTruthy()
    // 是给表单，不是让人写 `any: a@example.com`。
    expect(container.textContent).not.toContain('any:')
  })

  it('回车把地址加进 any', () => {
    const { changes } = draw({ kind: 'from', any: [] })
    const input = screen.getByPlaceholderText('a@example.com，回车添加')
    fireEvent.change(input, { target: { value: 'b@example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes.at(-1)).toEqual({ kind: 'from', any: ['b@example.com'] })
  })

  it('点 × 把地址去掉', () => {
    const { changes } = draw({ kind: 'from', any: ['a@example.com', 'c@example.com'] })
    fireEvent.click(screen.getByRole('button', { name: '删掉 a@example.com' }))
    expect(changes.at(-1)).toEqual({ kind: 'from', any: ['c@example.com'] })
  })

  it('判定类条件给的是「标签 + 判定说明」表单', () => {
    render(<ConditionEditor condition={{ kind: 'classifier', labels: ['dev'], prompt: '按这段判' }} kinds={['classifier']} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.getByText('只允许这些标签')).toBeTruthy()
    expect(screen.getByText('判定说明')).toBeTruthy()
    const prompt = screen.getByDisplayValue('按这段判') as HTMLTextAreaElement
    // 大段说明要有地方写：textarea 而不是单行。
    expect(prompt.tagName).toBe('TEXTAREA')
  })

  it('正则条件把「检查哪个字段」做成下拉，不用记字段名', () => {
    render(<ConditionEditor condition={{ kind: 'regex', field: 'body', pattern: 'x' }} kinds={['regex']} onChange={() => {}} onRemove={() => {}} />)
    const select = screen.getByDisplayValue('正文') as HTMLSelectElement
    expect([...select.options].map(option => option.value)).toContain('body')
  })

  it('换条件类型时不把旧类型的字段带过去', () => {
    const { changes } = draw({ kind: 'from', any: ['a@example.com'] })
    fireEvent.change(screen.getByLabelText('条件类型'), { target: { value: 'regex' } })
    expect(changes.at(-1)).toEqual({ kind: 'regex' })
  })

  it('认不出的条件回落到裸编辑，而且不丢字段', () => {
    render(
      <ConditionEditor
        condition={{ kind: 'webhook', path: '/hook', flags: ['a', 'b'] }}
        kinds={['webhook']}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    const box = boxes.find(item => item.value.includes('path: /hook'))
    expect(box).toBeDefined()
    // 两个字段都在，没被形状表吃掉。
    expect(box?.value).toContain('flags: a, b')
  })
})
