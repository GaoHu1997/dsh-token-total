import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, _resetSharedStoreForTests } from '../src/index.ts'

// The store is a process-level singleton, so each boot here starts from a
// clean shared-store slot and resets it afterwards.

const message = (seq) => ({ seq, time: Date.UTC(2026, 9, 22, 8), type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 } } })

/** Minimal host surface for apply(): collects effect disposers, the
 * registered route and logger warnings; every service resolves immediately. */
function hostHarness(persistence, storageDomain) {
  const disposers = []
  const warnings = []
  const routes = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    on(name, fn) {
      const bucket = listeners.get(name) ?? new Set()
      bucket.add(fn)
      listeners.set(name, bucket)
      const dispose = () => { bucket.delete(fn); if (bucket.size === 0) listeners.delete(name) }
      disposers.push(dispose) // Cordis subscriptions are fiber-scoped.
      return dispose
    },
    get: () => undefined,
    webServer: { host: '127.0.0.1', protocol: 'http:', register: (route) => { routes.push(route); return () => {} } },
    sessionPersistence: persistence,
    sessions: { list: () => [], get: () => undefined },
    storageDomain,
  }
  return { ctx, disposers, warnings, routes, listeners,
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args) },
  }
}

const degradedDomain = () => ({ open: () => { throw new Error('domain unavailable') } })

function healthyDomain() {
  let cursor
  const tables = new Map()
  return {
    cursor: () => cursor,
    open: async () => ({
      global: { get: () => cursor, set: async value => { cursor = value } },
      table(name) {
        if (!tables.has(name)) {
          const rows = new Map()
          tables.set(name, {
            get: async key => rows.get(key), put: async (key, value) => { rows.set(key, value) },
            update: async (key, apply) => { if (!rows.has(key)) throw new Error(`no record ${key} to update`); rows.set(key, apply(rows.get(key))) },
            delete: async key => { rows.delete(key) }, keys: () => rows.keys(), entries: () => rows.entries(),
          })
        }
        return tables.get(name)
      },
    }),
  }
}

async function postSession(host, sessionId) {
  const route = host.routes.find(route => route.path === '/token-total/api')
  assert.ok(route)
  let body
  const req = {
    method: 'POST', url: '/token-total/api/session',
    headers: { host: '127.0.0.1:7020', origin: 'http://127.0.0.1:7020' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ sessionId }) },
  }
  const res = { statusCode: 200, writeHead(status) { this.statusCode = status }, end(value) { body = JSON.parse(String(value)) } }
  await route.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, true)
  return body.value
}

const ownedLog = inputTokens => [{ ...message(0), data: { turn: 1, step: 1, usage: { inputTokens } } }]
function cachedHostPersistence() {
  const logs = { a: ownedLog(10), b: ownedLog(20) }, opens = new Map()
  return { logs, opens, persistence: {
    list: async () => [{ header: { id: 'a' } }, { header: { id: 'b' } }],
    open: async id => {
      opens.set(id, (opens.get(id) ?? 0) + 1)
      const events = [...logs[id]]
      return { inheritedEventCount: 0, read: async (offset, length) => ({ events: events.slice(offset, offset + length) }), close: async () => {} }
    },
  } }
}

test('real host event subscriptions preserve unrelated caches and discover modern and legacy live children', async () => {
  _resetSharedStoreForTests()
  const f = cachedHostPersistence(), domain = healthyDomain(), handles = []
  const host = hostHarness(f.persistence, domain)
  host.ctx.sessions = { list: () => handles, get: id => handles.find(handle => handle.id === id) }
  try {
    apply(host.ctx, {})
    await new Promise(resolve => setImmediate(resolve)) // all mocked boot I/O settles before the next macrotask
    assert.ok(domain.cursor()?.hoursReady && domain.cursor()?.failuresReady)
    f.opens.clear()
    assert.equal(host.listeners.get('session/event').size, 2, 'collector and cache invalidation both subscribe')
    assert.equal((await postSession(host, 'a')).total.uncachedInputTokens, 10)
    assert.equal((await postSession(host, 'b')).total.uncachedInputTokens, 20)
    const modern = { id: 'modern', header: { id: 'modern', parentSession: 'a' }, inheritedEventCount: 0, snapshotEvents: () => ownedLog(7) }
    handles.push(modern)
    const notification = { seq: 1, time: 1000, type: 'session/metadata', data: {} }
    host.emit('session/event', { id: 'modern' }, notification)
    assert.equal((await postSession(host, 'b')).total.uncachedInputTokens, 20)
    assert.equal(f.opens.get('b'), 1, 'an id-only event uses the live header to avoid global invalidation')
    assert.equal((await postSession(host, 'a')).total.uncachedInputTokens, 17)
    const legacy = { id: 'legacy', parentSession: 'a', inheritedEventCount: 0, snapshotEvents: () => ownedLog(3) }
    handles.push(legacy)
    host.emit('session/event', legacy, notification)
    const next = await postSession(host, 'a')
    assert.equal(next.total.uncachedInputTokens, 20)
    assert.equal(next.subagentSessions, 2)
    await postSession(host, 'b')
    assert.equal(f.opens.get('b'), 1)
    assert.deepEqual(host.warnings, [])
  } finally {
    for (const dispose of host.disposers) dispose()
    _resetSharedStoreForTests()
  }
  assert.equal(host.listeners.size, 0)
})

test('hosts missing the event hook really use four-second cache revalidation', async t => {
  _resetSharedStoreForTests()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const f = cachedHostPersistence(), domain = healthyDomain()
  const host = hostHarness(f.persistence, domain)
  delete host.ctx.on
  try {
    apply(host.ctx, {})
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(domain.cursor()?.hoursReady && domain.cursor()?.failuresReady)
    f.opens.clear()
    assert.equal((await postSession(host, 'a')).total.uncachedInputTokens, 10)
    f.logs.a = ownedLog(20)
    now += 3999
    assert.equal((await postSession(host, 'a')).total.uncachedInputTokens, 10)
    assert.equal(f.opens.get('a'), 1)
    now++
    assert.equal((await postSession(host, 'a')).total.uncachedInputTokens, 20)
    assert.equal(f.opens.get('a'), 2)
    assert.ok(host.warnings.some(message => message.includes('ctx.on missing')))
  } finally {
    for (const dispose of host.disposers) dispose()
    _resetSharedStoreForTests()
  }
})

/** Boot the plugin against a degraded storage domain and settle the
 * fire-and-forget chain; returns what the host observed. */
async function bootDegraded(headers) {
  _resetSharedStoreForTests()
  const events = [message(0)]
  const handle = { inheritedEventCount: 0, read: async (offset, length) => ({ events: events.slice(offset, offset + length) }), close: async () => {} }
  const persistence = { list: async () => headers, open: async () => handle }
  const host = hostHarness(persistence, degradedDomain())
  apply(host.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 30))
  for (const dispose of host.disposers) dispose()
  return host
}

test('a degraded storage domain never turns the boot chain into an unhandled rejection', async () => {
  _resetSharedStoreForTests()
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    // Both boot shapes hit store operations the degraded domain refuses:
    // an empty history fails the completion marks, a foldable session fails
    // every per-session write.
    for (const headers of [[], [{ header: { id: 's1' } }]]) {
      const host = await bootDegraded(headers)
      assert.equal(unhandled.length, 0, `no unhandled rejection escapes the boot chain (${headers.length} header(s))`)
      assert.ok(host.routes.length >= 1, 'the fenced route still mounts')
      assert.ok(host.warnings.some((line) => line.includes('boot scan failed')), 'the boot failure is logged, not swallowed silently')
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
    _resetSharedStoreForTests()
  }
})

test('a healthy boot still backfills without warnings', async () => {
  _resetSharedStoreForTests()
  // The smallest healthy domain: a global cursor object plus two kv tables.
  let cursor
  const kv = () => {
    const rows = new Map()
    return {
      get: async (key) => rows.get(key),
      put: async (key, value) => { rows.set(key, value) },
      update: async (key, value) => { if (!rows.has(key)) throw new Error('no record to update'); rows.set(key, value) },
      delete: async (key) => { rows.delete(key) },
      keys: () => rows.keys(),
    }
  }
  const domain = {
    open: async () => ({ global: { get: () => cursor, set: async (value) => { cursor = value } }, table: () => kv() }),
  }
  const host = hostHarness({ list: async () => [], open: async () => { throw new Error('unused') } }, domain)
  apply(host.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(host.warnings, [])
  assert.ok(cursor?.hoursReady === true && cursor?.failuresReady === true, 'the boot passes complete their upgrade marks')
  for (const dispose of host.disposers) dispose()
  _resetSharedStoreForTests()
})
