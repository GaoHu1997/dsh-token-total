import assert from 'node:assert/strict'
import test from 'node:test'
import { readUsageTree } from '../src/session-tree.ts'
import { SessionUsageService } from '../src/session-usage.ts'
import { buildSessionUsageDetail } from '../src/session-detail.ts'

const tokens = value => ({ inputTokens: value, outputTokens: value * 2, cacheReadTokens: value * 3, cacheWriteTokens: value * 4 })
const message = (value, seq = 0) => ({ type: 'assistant/message', seq, time: 1000, data: { turn: 1, step: 1, usage: tokens(value) } })
const buckets = value => ({ uncachedInputTokens: value, outputTokens: value * 2, cacheReadTokens: value * 3, cacheWriteTokens: value * 4 })
const namedError = (name, message = 'private path or credential must not escape') => Object.assign(new Error(message), { name })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

for (const seam of ['inspect', 'open']) {
  test(`${seam}: both APIs isolate a bad child, retain its healthy descendants and recover without cached omissions`, async () => {
    const headers = [
      { id: 'root' }, { id: 'bad', parentSession: 'root' },
      { id: 'sibling', parentSession: 'root' }, { id: 'grandchild', parentSession: 'bad' },
      { id: 'unrelated' }, { id: 'sibling', parentSession: 'root' },
    ]
    const logs = { root: [message(10)], bad: [message(100)], sibling: [message(20)], grandchild: [message(3)], unrelated: [message(999)] }
    const closes = []
    let broken = true
    const persistence = { async list() { return seam === 'open' ? headers.map(header => ({ header })) : headers } }
    if (seam === 'inspect') persistence.inspect = async id => {
      if (id === 'bad' && broken) throw namedError('SessionPersistenceCorruptionError')
      return { meta: { id }, events: logs[id], inheritedEventCount: 0 }
    }
    else persistence.open = async id => ({
      header: { id }, inheritedEventCount: 0,
      async read(offset) {
        // Refuse the complete child even if a readable page preceded corruption.
        if (id === 'bad' && broken && offset > 0) throw namedError('SessionPersistenceCorruptionError')
        return { events: offset === 0 ? logs[id] : [] }
      },
      async close() { closes.push(id) },
    })
    const service = new SessionUsageService()
    const partialTree = await service.tree(persistence, undefined, 'root')
    const partialDetail = await buildSessionUsageDetail(persistence, undefined, 'root')
    const expectedCoverage = {
      complete: false, totalSessions: 4, readableSessions: 3,
      unreadableSessions: [{ sessionId: 'bad', reason: 'corrupt' }],
    }
    assert.deepEqual(partialTree.coverage, expectedCoverage)
    assert.deepEqual(partialDetail.coverage, expectedCoverage)
    assert.deepEqual(partialTree.total, buckets(33))
    assert.deepEqual(partialDetail.totals, buckets(33))
    assert.deepEqual(partialDetail.subagents.map(row => row.sessionId), ['sibling', 'grandchild'])
    assert.ok(!JSON.stringify(partialDetail).includes('credential'))
    if (seam === 'open') assert.equal(closes.filter(id => id === 'bad').length, 2)
    broken = false
    const recoveredTree = await service.tree(persistence, undefined, 'root')
    const recoveredDetail = await buildSessionUsageDetail(persistence, undefined, 'root')
    assert.equal(recoveredTree.coverage.complete, true)
    assert.equal(recoveredDetail.coverage.complete, true)
    assert.deepEqual(recoveredTree.total, buckets(133))
    assert.deepEqual(recoveredDetail.totals, buckets(133))
  })
}

test('missing and unavailable descendants expose only stable reason codes, never raw errors', async () => {
  const persistence = {
    list: async () => [{ id: 'root' }, { id: 'missing', parentSession: 'root' }, { id: 'denied', parentSession: 'root' }],
    inspect: async id => {
      if (id === 'missing') throw Object.assign(new Error('secret path'), { code: 'ENOENT' })
      if (id === 'denied') throw Object.assign(new Error('secret token'), { code: 'EACCES' })
      return { events: [], inheritedEventCount: 0 }
    },
  }
  const { coverage } = await readUsageTree(persistence, undefined, 'root')
  assert.deepEqual(coverage, { complete: false, totalSessions: 3, readableSessions: 1, unreadableSessions: [
    { sessionId: 'missing', reason: 'missing' }, { sessionId: 'denied', reason: 'unavailable' },
  ] })
  assert.ok(!JSON.stringify(coverage).includes('secret'))
})

test('catalog and root failures still reject both APIs rather than report zero or partial success', async () => {
  const failure = new Error('root unavailable')
  for (const stage of ['list', 'root']) {
    const persistence = {
      async list() { if (stage === 'list') throw failure; return [{ id: 'root' }] },
      async inspect() { throw failure },
    }
    await assert.rejects(new SessionUsageService().tree(persistence, undefined, 'root'), error => error === failure)
    await assert.rejects(buildSessionUsageDetail(persistence, undefined, 'root'), error => error === failure)
  }
})

test('cancellation bounds readers to four and waits for every owned handle to close before rejecting', async () => {
  const controller = new AbortController()
  const ready = deferred()
  const gates = Array.from({ length: 8 }, deferred)
  const started = [], closed = []
  const persistence = {
    list: async options => {
      assert.equal(options.signal, controller.signal)
      return [{ header: { id: 'root' } }, ...gates.map((_, i) => ({ header: { id: `child-${i}`, parentSession: 'root' } }))]
    },
    open: async (id, access, options) => {
      assert.equal(access, 'read')
      assert.equal(options.signal, controller.signal)
      return {
        header: { id }, inheritedEventCount: 0,
        async read() {
          if (id === 'root') return { events: [] }
          const i = Number(id.slice(6))
          started.push(id)
          if (started.length === 4) ready.resolve()
          await gates[i].promise
          controller.signal.throwIfAborted()
          return { events: [] }
        },
        async close() { closed.push(id) },
      }
    },
  }
  let settled = false
  const operation = readUsageTree(persistence, undefined, 'root', controller.signal)
  const rejected = assert.rejects(operation, { name: 'AbortError' }).then(() => { settled = true })
  await ready.promise
  assert.equal(started.length, 4)
  controller.abort()
  gates[0].resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'other readers still own handles')
  for (const gate of gates) gate.resolve()
  await rejected
  assert.equal(started.length, 4, 'no new descendants start after cancellation')
  assert.deepEqual(closed.sort(), ['root', ...started].sort())
})

test('a descendant AbortError is never disguised as incomplete accounting', async () => {
  const persistence = {
    list: async () => [{ id: 'root' }, { id: 'child', parentSession: 'root' }],
    inspect: async id => {
      if (id === 'child') throw namedError('AbortError')
      return { events: [], inheritedEventCount: 0 }
    },
  }
  await assert.rejects(readUsageTree(persistence, undefined, 'root'), { name: 'AbortError' })
})
