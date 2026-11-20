import { describe, expect, it } from 'vitest'
import { checkFlow, describeIssues, parseInputRef } from '../src/flow/check.ts'
import { FlowNodeRegistry } from '../src/flow/registry.ts'
import type { Flow, FlowNodeSpec } from '../src/flow/types.ts'

/** 一个只用来取「类型声明出参」的注册表。 */
function registryWith(outputs: Record<string, readonly string[]> = {}): FlowNodeRegistry {
  const registry = new FlowNodeRegistry()
  for (const [type, keys] of Object.entries(outputs)) {
    registry.register('test', {
      type,
      label: type,
      group: 'control',
      outputs: keys.map(key => ({ key })),
      run: async () => ({ status: 'continue', ok: true, detail: '' }),
    })
  }
  return registry
}

/** 一张图。 */
function flow(nodes: readonly FlowNodeSpec[], params?: Flow['params']): Flow {
  return { id: 'f', name: 'f', connector: 'test', nodes, ...(params === undefined ? {} : { params }) }
}

const trigger: FlowNodeSpec = { id: 't', type: 'trigger', outputs: { from: {}, subject: {} } }

describe('parseInputRef', () => {
  it('认三种引用', () => {
    expect(parseInputRef('event.subject')).toEqual({ scope: 'event', key: 'subject' })
    expect(parseInputRef('flow.repo')).toEqual({ scope: 'flow', key: 'repo' })
    expect(parseInputRef('t.subject')).toEqual({ scope: 'node', nodeId: 't', key: 'subject' })
  })

  it('写歪的返回 undefined', () => {
    expect(parseInputRef('subject')).toBeUndefined()
    expect(parseInputRef('.subject')).toBeUndefined()
    expect(parseInputRef('event.')).toBeUndefined()
    expect(parseInputRef('event.a.b')).toBeUndefined()
  })
})

describe('checkFlow', () => {
  it('占位符没声明来源就报错', () => {
    const result = checkFlow(flow([
      trigger,
      { id: 'n', type: 'notify', config: { title: '主题：{subject}' } },
    ]), registryWith({ trigger: [], notify: [] }))

    expect(result.ok).toBe(false)
    expect(describeIssues(result.issues)).toContain('用了「subject」')
  })

  it('声明了 event 来源就通过', () => {
    const result = checkFlow(flow([
      trigger,
      { id: 'n', type: 'notify', inputs: { subject: 'event.subject' }, config: { title: '{subject}' } },
    ]), registryWith({ trigger: [], notify: [] }))

    expect(result.ok).toBe(true)
  })

  it('event 引用必须由 trigger 声明', () => {
    const result = checkFlow(flow([
      { id: 't', type: 'trigger', outputs: { from: {} } },
      { id: 'n', type: 'notify', inputs: { subject: 'event.subject' }, config: { title: '{subject}' } },
    ]), registryWith({ trigger: [], notify: [] }))

    expect(result.ok).toBe(false)
    expect(describeIssues(result.issues)).toContain('trigger 节点没有声明这个出参')
  })

  it('flow 引用必须在 flow.params 或 start.params 里', () => {
    const ok = checkFlow(flow([
      { id: 's', type: 'start', config: { params: [{ name: 'repo', required: true }] } },
      { id: 'n', type: 'notify', inputs: { repo: 'flow.repo' }, config: { title: '{repo}' } },
    ]), registryWith({ start: [], notify: [] }))
    expect(ok.ok).toBe(true)

    const bad = checkFlow(flow([
      { id: 's', type: 'start' },
      { id: 'n', type: 'notify', inputs: { repo: 'flow.repo' }, config: { title: '{repo}' } },
    ]), registryWith({ start: [], notify: [] }))
    expect(bad.ok).toBe(false)
  })

  it('只能引用上游节点，且那个节点要声明该出参', () => {
    const notUpstream = checkFlow(flow([
      trigger,
      { id: 'a', type: 'notify', inputs: { subject: 'b.subject' }, config: { title: '{subject}' } },
      { id: 'b', type: 'session', outputs: { subject: {} } },
    ]), registryWith({ trigger: [], notify: [], session: [] }))
    expect(describeIssues(notUpstream.issues)).toContain('不是上游节点')

    const notDeclared = checkFlow(flow([
      trigger,
      { id: 'a', type: 'session', outputs: { sessionId: {} } },
      { id: 'b', type: 'notify', inputs: { sessionId: 'a.sessionId' }, config: { title: '{sessionId}' } },
    ]), registryWith({ trigger: [], notify: [], session: [] }))
    expect(notDeclared.ok).toBe(false)
  })

  it('入参键必须与引用末段同名', () => {
    const result = checkFlow(flow([
      trigger,
      { id: 'n', type: 'notify', inputs: { title: 'event.subject' }, config: { title: '{title}' } },
    ]), registryWith({ trigger: [], notify: [] }))
    expect(describeIssues(result.issues)).toContain('末段不同名')
  })

  it('出边条件的 field 不算节点入参（正文由条件求值器自己拉）', () => {
    const result = checkFlow(flow([
      trigger,
      { id: 'r', type: 'switch', out: [{ to: 'end', when: [{ kind: 'regex', field: 'body', pattern: 'x' } as never] }] },
      { id: 'end', type: 'end' },
    ]), registryWith({ trigger: [], switch: [], end: [] }))
    expect(result.ok).toBe(true)
  })

  it('workflow 的 pass 与 end 的 outputs 都要声明', () => {
    const missingPass = checkFlow(flow([
      trigger,
      { id: 'w', type: 'workflow', config: { workflow: 'x', pass: ['subject'] } },
    ]), registryWith({ trigger: [], workflow: [] }))
    expect(describeIssues(missingPass.issues)).toContain('用了「subject」')

    const declared = checkFlow(flow([
      trigger,
      { id: 'w', type: 'workflow', inputs: { subject: 'event.subject' }, config: { workflow: 'x', pass: ['subject'] } },
    ]), registryWith({ trigger: [], workflow: [] }))
    expect(declared.ok).toBe(true)
  })

  it('子图的节点也要校验', () => {
    const result = checkFlow(flow([
      trigger,
      { id: 'loop', type: 'loop', body: { nodes: [{ id: 'inner', type: 'notify', config: { title: '{subject}' } }] } },
    ]), registryWith({ trigger: [], loop: [], notify: [] }))
    expect(result.ok).toBe(false)
    expect(describeIssues(result.issues)).toContain('子图')
  })
})
