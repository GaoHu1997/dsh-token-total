import assert from 'node:assert/strict'
import test from 'node:test'
import { UsageCollector, UsageFold } from '../src/collector.ts'
import { SessionUsageService } from '../src/session-usage.ts'

const usage = (inputTokens, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
const event = (seq, data, type = 'assistant/message') => ({ seq, time: Date.UTC(2026, 9, 22, 8), type, data })
const message = (seq, tokens, turn = 1, step = 1) => event(seq, { turn, step, usage: usage(tokens) })
const stream = (...samples) => samples.map(usage => ({ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }))
const totals = samples => samples.reduce((n, sample) => n + (sample?.inputTokens ?? 0), 0)
const legacy = (rows, logs, cuts = {}) => ({
  async list() { return rows },
  async inspect(id) {
    if (!Object.hasOwn(logs, id)) throw new Error(`missing ${id}`)
    return { meta: { id }, events: logs[id], inheritedEventCount: cuts[id] ?? 0 }
  },
})
const liveStore = (...handles) => ({ list: () => handles, get: id => handles.find(handle => handle.id === id) })

 test('modern message/attempt stream usage uses last raw usage and legacy top-level priority', () => {
  const fold = new UsageFold()
  const samples = [
    fold.fold(event(0, { turn: 1, step: 1, stream: stream(usage(3), usage(7)) }, 'assistant/attempt')),
    fold.fold(event(1, { turn: 1, step: 2, stream: stream(usage(11), usage(13)) })),
    fold.fold(event(2, { turn: 1, step: 3, usage: usage(17), stream: stream(usage(99)) })),
  ]
  assert.equal(totals(samples), 37)
  assert.equal(fold.fold(event(3, { turn: 1, step: 4, stream: [] }, 'assistant/attempt')), null)
})

test('same call emits signed last-wins correction without mutating emitted samples', () => {
  const fold = new UsageFold()
  const first = fold.fold(message(0, 10))
  first.model = 'provider/model'
  const before = structuredClone(first)
  const second = fold.fold(message(1, 15))
  assert.equal(second.inputTokens, 5)
  assert.equal(second.model, 'provider/model')
  assert.equal(fold.fold(message(2, 15)), null)
  const zero = fold.fold(message(3, 0))
  assert.equal(zero.inputTokens, -15)
  assert.equal(totals([first, second, zero]), 0)
  assert.deepEqual(first, before)
})

test('started retry closes the previous attempt replacement slot', () => {
  const fold = new UsageFold()
  const first = fold.fold(event(0, { turn: 1, step: 1, stream: stream(usage(10)) }, 'assistant/attempt'))
  const retry = fold.fold(event(1, { turn: 1, step: 1 }, 'llm/retry-started'))
  const last = fold.fold(message(2, 20))
  assert.equal(retry.request, true)
  assert.equal(totals([first, retry, last]), 30)
  assert.equal(fold.fold(message(3, 20)), null)
})

test('pure cache usage counts and reasoning tokens are not added twice', () => {
  const sample = new UsageFold().fold(event(0, { turn: 1, step: 1, usage: { ...usage(0, 0, 30, 5), reasoningTokens: 10 } }))
  assert.equal(sample.inputTokens, 0)
  assert.equal(sample.outputTokens, 0)
  assert.equal(sample.cacheReadTokens, 30)
  assert.equal(sample.cacheWriteTokens, 5)
})

test('nested forks skip exact inherited prefix and isolate session step keys', async () => {
  const root = message(0, 100)
  const child = message(1, 20)
  const grandchild = message(2, 3)
  const persistence = legacy([
    { id: 'root' }, { id: 'child', parentSession: 'root' },
    { id: 'grandchild', parentSession: 'child' }, { id: 'unrelated' },
    { id: 'child', parentSession: 'root' },
  ], { root: [root], child: [root, child], grandchild: [root, child, grandchild], unrelated: [message(0, 999)] }, { child: 1, grandchild: 2 })
  const tree = await new SessionUsageService().tree(persistence, undefined, 'root')
  assert.equal(tree.self.uncachedInputTokens, 100)
  assert.equal(tree.subagents.uncachedInputTokens, 23)
  assert.equal(tree.total.uncachedInputTokens, 123)
  assert.equal(tree.subagentSessions, 2)
})

test('root compaction is supplemental to native main while descendants retain full owned spend', async () => {
  const compaction = (seq, id, input) => event(seq, {
    compactionId: id, provider: 'p', model: 'm', usage: usage(input, 2, 3, 4),
  }, 'compaction/summary')
  const rootMain = message(0, 100), rootCompaction = compaction(1, 'root-fold', 10)
  const childMain = message(2, 20, 2, 1), childCompaction = compaction(3, 'child-fold', 5)
  const persistence = legacy([{ id: 'root' }, { id: 'child', parentSession: 'root' }], {
    root: [rootMain, rootCompaction, compaction(2, 'root-fold', 10)],
    child: [rootMain, rootCompaction, childMain, childCompaction, compaction(4, 'child-fold', 5)],
  }, { child: 2 })
  const tree = await new SessionUsageService().tree(persistence, undefined, 'root')
  assert.deepEqual(tree.self, { uncachedInputTokens: 110, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
  assert.deepEqual(tree.selfCompaction, { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
  assert.deepEqual(tree.subagents, { uncachedInputTokens: 25, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
  assert.deepEqual(tree.total, { uncachedInputTokens: 135, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 })
  for (const key of Object.keys(tree.total)) {
    const nativeMain = key === 'uncachedInputTokens' ? 100 : 0
    assert.equal(nativeMain + tree.selfCompaction[key] + tree.subagents[key], tree.total[key])
  }
  assert.equal(tree.subagentSessions, 1)
})

test('alpha snapshot listing and 500-event pages win over inspect and always close', async () => {
  const log = Array.from({ length: 1001 }, (_, seq) => message(seq, 1, 1, seq + 1))
  const offsets = [], calls = []
  const controller = new AbortController()
  const persistence = {
    async list(options) { assert.equal(options.signal, controller.signal); return [{ header: { id: 'root' } }, null, { nonsense: true }] },
    async open(id, access, options) {
      assert.equal(id, 'root'); assert.equal(access, 'read'); assert.equal(options.signal, controller.signal)
      return { inheritedEventCount: 2,
        async read(offset, length) { offsets.push(offset); assert.equal(length, 500); return { events: log.slice(offset, offset + length) } },
        async close() { calls.push('close') },
      }
    },
    async inspect() { assert.fail('open must win') },
  }
  const tree = await new SessionUsageService().tree(persistence, undefined, 'root', controller.signal)
  assert.equal(tree.self.uncachedInputTokens, 999)
  assert.deepEqual(offsets, [0, 500, 1000, 1001])
  assert.deepEqual(calls, ['close'])
})

test('live full snapshot and header parent discover descendants before persistence catches up', async () => {
  const inherited = message(0, 100)
  const child = { id: 'child', header: { id: 'child', parentSession: 'root' }, inheritedEventCount: 1,
    snapshotEvents: () => [inherited, event(1, { turn: 2, step: 1, stream: stream(usage(7)) }, 'assistant/attempt')] }
  const root = { id: 'root', header: { id: 'root' }, inheritedEventCount: 0, snapshotEvents: () => [inherited] }
  const persistence = legacy([{ id: 'root' }], {})
  const tree = await new SessionUsageService().tree(persistence, liveStore(root, child), 'root')
  assert.equal(tree.self.uncachedInputTokens, 100)
  assert.equal(tree.subagents.uncachedInputTokens, 7)
  assert.equal(tree.total.uncachedInputTokens, 107)
})

test('unseen child event invalidates a root previously cached without it', async () => {
  const rows = [{ id: 'root' }], logs = { root: [message(0, 10)] }
  const persistence = legacy(rows, logs)
  const service = new SessionUsageService()
  assert.equal((await service.tree(persistence, undefined, 'root')).subagentSessions, 0)
  rows.push({ id: 'child', parentSession: 'root' }); logs.child = [message(0, 20)]
  service.invalidate('child')
  const next = await service.tree(persistence, undefined, 'root')
  assert.equal(next.subagentSessions, 1)
  assert.equal(next.total.uncachedInputTokens, 30)
})

test('event during asynchronous read prevents stale result being cached', async () => {
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0, log = [message(0, 10)]
  const persistence = { async list() { return [{ id: 'root' }] }, async inspect() {
    calls++
    const events = [...log]
    if (calls === 1) { started(); await gate }
    return { events, inheritedEventCount: 0 }
  } }
  const service = new SessionUsageService()
  const pending = service.tree(persistence, undefined, 'root')
  await entered
  log = [message(0, 20)]; service.invalidate('root'); release()
  assert.equal((await pending).total.uncachedInputTokens, 10)
  assert.equal((await service.tree(persistence, undefined, 'root')).total.uncachedInputTokens, 20)
  assert.equal(calls, 2)
})

test('corrupt child does not become a cached partial success and can recover next request', async () => {
  const rows = [{ id: 'root' }, { id: 'child', parentSession: 'root' }], logs = { root: [message(0, 10)] }
  const service = new SessionUsageService(), persistence = legacy(rows, logs)
  await assert.rejects(service.tree(persistence, undefined, 'root'), /missing child/)
  logs.child = [message(0, 20)]
  assert.equal((await service.tree(persistence, undefined, 'root')).total.uncachedInputTokens, 30)
})

test('failed or canceled paged reads close handles and never cache partial totals', async () => {
  let closed = 0
  const controller = new AbortController()
  const persistence = { async list() { return [{ header: { id: 'root' } }] }, async open() {
    return { inheritedEventCount: 0, async read() { controller.abort(); return { events: [message(0, 10)] } }, async close() { closed++ } }
  } }
  await assert.rejects(new SessionUsageService().tree(persistence, undefined, 'root', controller.signal), { name: 'AbortError' })
  assert.equal(closed, 1)
})

test('tree honors legacy direct parent handles and cycles without double counting', async () => {
  const persistence = legacy([{ id: 'root', parentSession: 'child' }], { root: [message(0, 10)], child: [message(0, 20)] })
  const tree = await new SessionUsageService().tree(persistence, liveStore({ id: 'child', parentSession: 'root' }), 'root')
  assert.equal(tree.subagentSessions, 1)
  assert.equal(tree.total.uncachedInputTokens, 30)
})

const mockStore = () => {
  const samples = [], daySeen = new Set(), hourSeen = new Set()
  return { samples,
    async record(sample) { samples.push(structuredClone(sample)) }, async recordHours(sample) { samples.push(structuredClone(sample)) },
    async seenSessions() { return daySeen }, async hoursSeenSessions() { return hourSeen },
    async liveSequences() { return new Map() }, async hoursLiveSequences() { return new Map() },
    async markSeenSessions(ids) { for (const id of ids) daySeen.add(id) },
    async markHoursSeenSessions(ids) { for (const id of ids) hourSeen.add(id) },
    async markHoursReady() {}, async markLiveSequences() {}, async markHoursLiveSequences() {},
  }
}

test('collector live keeps separate session buckets and records failed attempt plus retry', async () => {
  const listeners = new Map(), store = mockStore()
  const collector = new UsageCollector({ on(name, fn) { listeners.set(name, fn) }, sessions: { get: () => ({ requestContext: () => ({ provider: 'p', model: 'm' }) }) } }, store)
  collector.start()
  const emit = listeners.get('session/event')
  emit({ id: 'root' }, event(0, { turn: 1, step: 1, stream: stream(usage(10)) }, 'assistant/attempt'))
  emit({ id: 'root' }, event(1, { turn: 1, step: 1 }, 'llm/retry-started'))
  emit({ id: 'root' }, message(2, 20))
  emit({ id: 'child' }, message(0, 3))
  await Promise.resolve()
  assert.equal(totals(store.samples), 33)
  assert.equal(store.samples.filter(s => s.request).length, 1)
  assert.ok(store.samples.every(s => s.model === 'p/m'))
})

test('collector paged replay skips inherited samples and counts attempt stream/retries once', async () => {
  const store = mockStore(), collector = new UsageCollector({}, store)
  const events = [message(0, 100), event(1, { turn: 2, step: 1, stream: stream(usage(10)) }, 'assistant/attempt'),
    event(2, { turn: 2, step: 1 }, 'llm/retry-started'), message(3, 20, 2, 1)]
  let closed = 0
  await collector.backfill({ async list() { return [{ header: { id: 'child' } }] }, async open() { return {
    inheritedEventCount: 1, async read(offset, length) { return { events: events.slice(offset, offset + length) } }, async close() { closed++ },
  } } }, liveStore())
  assert.equal(totals(store.samples), 30)
  assert.equal(closed, 1)
  assert.equal(collector.status.scannedSessions, 1)
  assert.equal(collector.status.error, undefined)
  await collector.backfill({ async list() { return [{ header: { id: 'child' } }] } }, liveStore())
  assert.equal(totals(store.samples), 30)
})
