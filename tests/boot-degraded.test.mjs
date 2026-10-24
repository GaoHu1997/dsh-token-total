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
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    on: () => () => {},
    get: () => undefined,
    webServer: { host: '127.0.0.1', protocol: 'http:', register: (route) => { routes.push(route); return () => {} } },
    sessionPersistence: persistence,
    sessions: { list: () => [] },
    storageDomain,
  }
  return { ctx, disposers, warnings, routes }
}

const degradedDomain = () => ({ open: () => { throw new Error('domain unavailable') } })

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
