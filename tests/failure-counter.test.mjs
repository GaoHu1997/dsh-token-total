import assert from 'node:assert/strict'
import test from 'node:test'
import { UsageStore } from '../src/store.ts'

const day = '2026-10-22'

/** In-memory stand-in for the storage-domain service: one Map per table plus
 *  the global cursor value. Mirrors KvTable's observable contract, including
 *  the package's "no record to update" miss that `recordInto` retries on. */
function memoryStorage() {
  const tables = new Map()
  let globalValue
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    const rows = tables.get(name)
    return {
      get: (key) => rows.get(key),
      entries: () => rows.entries(),
      keys: () => rows.keys(),
      get size() { return rows.size },
      async put(key, value) { rows.set(key, structuredClone(value)) },
      async delete(key) { return rows.delete(key) },
      async update(key, fn) {
        if (!rows.has(key)) throw new Error(`no record "${key}" to update`)
        const next = fn(structuredClone(rows.get(key)))
        rows.set(key, structuredClone(next))
        return next
      },
    }
  }
  return {
    tables,
    async open() {
      return {
        table,
        global: {
          get: () => globalValue,
          async set(value) { globalValue = structuredClone(value) },
        },
      }
    },
  }
}

const sample = (overrides = {}) => ({
  day,
  hour: `${day}T08`,
  model: 'tiny/model',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
})

const rowsOf = (storage, name) => [...storage.tables.get(name).values()]

async function openStore() {
  const storage = memoryStorage()
  const store = new UsageStore(storage)
  await store.readyPromise()
  return { storage, store }
}

test('record folds failures without charging extra requests or tokens', async () => {
  const { storage, store } = await openStore()
  await store.record(sample({ request: true, failed: true }))
  await store.record(sample({ request: true, failed: true }))
  await store.record(sample({ request: true, inputTokens: 10 }))
  const [row] = rowsOf(storage, 'days')
  assert.equal(row.requests, 3, 'each call is one request, failures included')
  assert.equal(row.failures, 2)
  assert.equal(row.inputTokens, 10)
  const [hourRow] = rowsOf(storage, 'hours')
  assert.equal(hourRow.requests, 3)
  assert.equal(hourRow.failures, 2)
})

test('a persisted row without failures folds as zero and starts counting', async () => {
  const { storage, store } = await openStore()
  // Seed a row written by a pre-failure version: no `failures` field at all.
  storage.tables.get('days').set(`${day}|tiny|tiny/model`, {
    day,
    provider: 'tiny',
    model: 'tiny/model',
    inputTokens: 7,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 4,
    turns: 0,
    lastSeen: 0,
  })
  await store.record(sample({ failed: true }))
  const [row] = rowsOf(storage, 'days')
  assert.equal(row.failures, 1)
  assert.equal(row.requests, 4, 'the legacy count must survive the fold')
  assert.equal(row.inputTokens, 7)
})

test('recordFailure moves only the failure counter (upgrade pass)', async () => {
  const { storage, store } = await openStore()
  await store.record(sample({ request: true, inputTokens: 5 }))
  await store.recordFailure(sample({ inputTokens: 99, request: true, failed: true }))
  const [row] = rowsOf(storage, 'days')
  assert.equal(row.failures, 1)
  assert.equal(row.inputTokens, 5, 'replayed tokens must never be added twice')
  assert.equal(row.requests, 1, 'replayed requests must never be added twice')
})

test('recordFailure ignores a sample without the failed marker (v1.0.2–v1.0.8 regression)', async () => {
  const { storage, store } = await openStore()
  await store.record(sample({ request: true, inputTokens: 5 }))
  // The upgrade pass replays whole session logs, so most folded samples are
  // successful calls. v1.0.2 hardcoded failed:true here and inflated the
  // failure counter to ~2x requests on every pre-upgrade day.
  await store.recordFailure(sample({ inputTokens: 50, request: true }))
  await store.recordFailure(sample({ inputTokens: 51, request: false }))
  await store.recordFailure(sample({ inputTokens: 52, turn: true }))
  const [row] = rowsOf(storage, 'days')
  assert.equal(row.failures, 0, 'non-failed samples must count nothing')
  assert.equal(row.requests, 1)
  assert.equal(row.inputTokens, 5)
})

test('failure cursor round-trips, keeps the earliest live boundary and resets', async () => {
  const { storage, store } = await openStore()
  await store.record(sample({ request: true, inputTokens: 3 }))
  await store.markFailuresSeenSessions(['s1', 's2'])
  assert.deepEqual([...(await store.failuresSeenSessions())].sort(), ['s1', 's2'])
  await store.markFailuresLiveSequences([['s1', 5], ['s1', 3], ['s2', -1]])
  const boundaries = await store.failuresLiveSequences()
  assert.equal(boundaries.get('s1'), 3)
  assert.equal(boundaries.get('s2'), -1)
  await store.markFailuresReady()
  assert.equal(await store.failuresReady(), true)
  // A reset (rebuild) starts the pass over from the new boundary.
  await store.reset(new Map([['s1', 7]]))
  assert.equal(await store.failuresReady(), false)
  assert.equal((await store.failuresSeenSessions()).size, 0)
  assert.equal((await store.failuresLiveSequences()).get('s1'), 7)
  assert.equal(storage.tables.get('days').size, 0, 'reset wipes the day table')
  assert.equal(storage.tables.get('hours').size, 0, 'reset wipes the hour table')
})
