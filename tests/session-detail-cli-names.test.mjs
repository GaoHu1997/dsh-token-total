import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionUsageDetail } from '../src/session-detail.ts'

// Isolated synthetic session logs; no real profile records are read or changed.
const event = (seq, type, data) => ({ seq, time: 1000 + seq, type, data })
const catalog = (seq, childId, label) => event(seq, 'subagent/catalog', { version: 0, childId, label, childCreatedAt: 1, mode: 'one-shot' })
const title = (seq, value) => event(seq, 'session/title', { title: value, messageSeqs: [], source: { kind: 'user' } })
const usageEvents = (seq = 10) => [
  event(seq, 'step/start', { turn: 1, step: 1 }),
  event(seq + 1, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 3 } }),
]
const log = (id, parentSession, events = [], inheritedEventCount = 0, extra = {}) => ({
  header: { id, ...(parentSession ? { parentSession } : {}), ...extra }, events, inheritedEventCount,
})
function persistenceOf(logs, seam) {
  const byId = new Map(logs.map(value => [value.header.id, value]))
  const persistence = { list: async () => logs.map(value => seam === 'open' ? { header: value.header } : value.header) }
  if (seam === 'inspect') persistence.inspect = async id => {
    const value = byId.get(id)
    assert.ok(value, `unexpected read: ${id}`)
    return { meta: value.header, events: value.events, inheritedEventCount: value.inheritedEventCount }
  }
  else persistence.open = async (id, access) => {
    assert.equal(access, 'read', 'name resolution must not write historical logs')
    const value = byId.get(id)
    assert.ok(value, `unexpected read: ${id}`)
    return { header: value.header, inheritedEventCount: value.inheritedEventCount,
      read: async offset => ({ events: offset === 0 ? value.events : [] }), close: async () => {} }
  }
  return persistence
}
function assertName(detail, id, expected) {
  assert.equal(detail.subagents.find(row => row.sessionId === id)?.name, expected)
  const records = detail.records.filter(row => row.sessionId === id)
  assert.ok(records.length > 0)
  for (const row of records) assert.equal(row.sessionName, expected)
}

for (const seam of ['inspect', 'open']) {
  test(`${seam}: historical CLI names come from the actual parent's catalog, not the raw id or cwd`, async () => {
    const childId = 'cli-task-48c88613-3333-4444-5555-666666666666'
    const logs = [
      log('root', undefined, [catalog(0, childId, '  修复会话标题  ')]),
      log(childId, 'root', usageEvents(), 0, { cwd: 'D:/work/project' }),
    ]
    const before = structuredClone(logs)
    const detail = await buildSessionUsageDetail(persistenceOf(logs, seam), undefined, 'root')
    assertName(detail, childId, '修复会话标题')
    assert.deepEqual(detail.totals, { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.equal(detail.requests, 1)
    assert.equal(detail.coverage.complete, true)
    assert.deepEqual(logs, before, 'name resolution is read-only')
  })

  test(`${seam}: own descriptor and latest nonempty title take precedence over parent labels`, async () => {
    const logs = [
      log('root', undefined, [catalog(0, 'cli-title', '旧目录名'), catalog(1, 'cli-label', '目录名')]),
      log('cli-title', 'root', [title(0, '最早名称'), title(1, ' 最新任务名 '), title(2, '   '), ...usageEvents()]),
      log('cli-label', 'root', [title(0, '会话标题'), event(1, 'subagent/descriptor', { label: ' 子代理真实标签 ' }), ...usageEvents()]),
    ]
    const detail = await buildSessionUsageDetail(persistenceOf(logs, seam), undefined, 'root')
    assertName(detail, 'cli-title', '最新任务名')
    assertName(detail, 'cli-label', '子代理真实标签')
  })

  test(`${seam}: nested names are scoped to the immediate parent and exclude inherited catalogs and titles`, async () => {
    const logs = [
      log('root', undefined, [catalog(0, 'branch', '分支任务'), catalog(1, 'cli-nested', '错误祖先名称')]),
      log('branch', 'root', [
        catalog(0, 'cli-inherited', '继承目录不属于此分支'),
        catalog(1, 'cli-nested', '过期名称'), catalog(2, 'cli-nested', '嵌套任务'),
        catalog(3, 'cli-nested', '   '), catalog(4, 'cli-foreign', '其他分支的名称'),
      ], 1),
      log('cli-nested', 'branch', [title(0, '继承的父标题'), ...usageEvents()], 1),
      log('cli-inherited', 'branch', usageEvents()),
      log('cli-foreign', 'root', usageEvents()),
    ]
    const detail = await buildSessionUsageDetail(persistenceOf(logs, seam), undefined, 'root')
    assert.equal(detail.subagents.find(row => row.sessionId === 'branch')?.name, '分支任务')
    assertName(detail, 'cli-nested', '嵌套任务')
    assertName(detail, 'cli-inherited', 'cli-inherited')
    assertName(detail, 'cli-foreign', 'cli-foreign')
  })

  test(`${seam}: absent or invalid names retain header, directory and id fallbacks`, async () => {
    const logs = [
      log('root', undefined, [catalog(0, 'by-id', ''), event(1, 'subagent/catalog', null), event(2, 'subagent/catalog', { childId: 'by-id', label: 123 })]),
      log('by-name', 'root', usageEvents(), 0, { name: 'Header name' }),
      log('by-title', 'root', usageEvents(), 0, { title: 'Header title' }),
      log('by-cwd', 'root', usageEvents(), 0, { cwd: 'D:/work/project' }),
      log('by-id', 'root', usageEvents()),
    ]
    const detail = await buildSessionUsageDetail(persistenceOf(logs, seam), undefined, 'root')
    assertName(detail, 'by-name', 'Header name')
    assertName(detail, 'by-title', 'Header title')
    assertName(detail, 'by-cwd', 'project')
    assertName(detail, 'by-id', 'by-id')
  })
}

for (const modern of [true, false]) {
  test(`live ${modern ? 'header' : 'legacy'} parent metadata resolves names without stale persistence reads`, async () => {
    const rootEvents = [catalog(0, 'cli-live', '实时任务名')]
    const childEvents = usageEvents()
    const handles = [
      { id: 'root', inheritedEventCount: 0, snapshotEvents: () => rootEvents },
      { id: 'cli-live', ...(modern ? { header: { id: 'cli-live', parentSession: 'root' } } : { parentSession: 'root' }), inheritedEventCount: 0, snapshotEvents: () => childEvents },
    ]
    const persistence = { list: async () => [], inspect: async () => { throw new Error('live logs should not be read from persistence') } }
    const sessions = { list: () => handles, get: id => handles.find(handle => handle.id === id) }
    const detail = await buildSessionUsageDetail(persistence, sessions, 'root')
    assertName(detail, 'cli-live', '实时任务名')
  })
}
