import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateSamples } from '../src/query.ts'
import { aggregateRange, buildUsageRoute } from '../src/routes.ts'
import { resolveModelNames } from '../src/model-names.ts'
import { normalizeModelName } from '../src/shared.ts'

const day = '2026-10-22'
const sample = (model, modelName, tokens = {}) => ({
  day, hour: `${day}T08`, model, modelName,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 5,
  ...tokens,
})
const sum = (values) => Object.values(values).reduce((a, b) => a + b, 0)

test('equivalent display names merge, distinct versions/suffixes/slashes do not', () => {
  for (const name of ['gpt-6.1-sol', 'GPT 6.1 sol', 'gpt 6.1 sol', ' GPT_6.1–SOL ', 'ＧＰＴ ６.１ sol']) {
    assert.equal(normalizeModelName(name), 'gpt-6.1-sol')
  }
  for (const name of ['gpt-61-sol', 'gpt-6.2-sol', 'gpt-6.1-sol-mini', 'GPT/6.1 sol']) {
    assert.notEqual(normalizeModelName(name), 'gpt-6.1-sol')
  }
  assert.equal(normalizeModelName('vendor/GPT 6.1 sol'), 'vendor/gpt-6.1-sol')
  assert.equal(normalizeModelName('  '), '(unknown)')
})

test('ranking, cache counters and day/hour trends all aggregate by DISPLAY name', () => {
  const samples = [
    sample('a/opaque-id-1', 'gpt-6.1-sol'),
    sample('b/another-route', 'GPT 6.1 sol'),
    sample('c/gpt-999', 'gpt 6.1 sol'),
    sample('a/opaque-id-1', 'GPT 6.1 sol', { hour: `${day}T09` }),
    // Same route id is not sufficient for merging when the display names differ.
    sample('b/opaque-id-1', 'gpt-6.1-sol-mini'),
    sample('c/opaque-id-1', 'gpt-6.2-sol'),
    sample('a/ignored', undefined, { request: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    sample('(turns)', undefined, { turn: true }),
    { ...sample('a/outside', 'outside'), day: '2026-10-21', hour: '2026-10-21T08' },
  ]
  for (const granularity of ['day', 'hour']) {
    const stats = aggregateSamples(samples, { from: day, to: day }, granularity)
    assert.equal(stats.tokens, 240)
    assert.equal(stats.models.length, 3)
    assert.equal(stats.topModel, 'gpt-6.1-sol')
    const merged = stats.models[0]
    assert.deepEqual(merged.providers, ['a', 'b', 'c'])
    assert.equal(merged.provider, '')
    assert.equal(merged.tokens, 160)
    assert.equal(merged.cacheHit, 80)
    assert.equal(merged.cacheMiss, 60)
    assert.equal(merged.percent, 160 / 240 * 100)
    assert.deepEqual(Object.fromEntries(stats.providers.map(p => [p.provider, p.tokens])), { a: 80, b: 80, c: 80 })
    assert.equal(stats.requests, 1)
    assert.equal(stats.turns, 1)
    assert.equal(stats.activeDays, 1)
    assert.equal(stats.daily.length, granularity === 'hour' ? 24 : 1)
    assert.equal(stats.daily.reduce((n, bucket) => n + (bucket.byModel['gpt-6.1-sol'] ?? 0), 0), 160)
    for (const bucket of stats.daily) {
      assert.equal(sum(bucket.byModel), bucket.total)
      assert.equal(sum(bucket.byProvider), bucket.total)
      assert.ok(Object.keys(bucket.byModel).every(key => !key.includes('opaque') && !key.includes('route')))
    }
  }
})

test('missing metadata uses normalized historical names and single-provider attribution', () => {
  const stats = aggregateSamples([sample('a/GPT 6.1 sol'), sample('a/gpt-6.1-sol')], { from: day, to: day })
  assert.equal(stats.models.length, 1)
  assert.equal(stats.models[0].model, 'gpt-6.1-sol')
  assert.equal(stats.models[0].provider, 'a')
  assert.deepEqual(stats.models[0].providers, ['a'])
  assert.equal(stats.tokens, 80)
})

test('metadata resolves distinct ids once, preserves display name, bounds concurrency', async () => {
  const calls = []
  let active = 0, peak = 0
  const refs = Array.from({ length: 9 }, (_, i) => `p/id-${i}`)
  const llm = {
    async resolveModelInfo(provider, id, signal) {
      assert.equal(provider, 'p')
      assert.ok(signal instanceof AbortSignal)
      calls.push(id)
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setImmediate(resolve))
      active--
      return { name: 'GPT 6.1 sol' }
    },
    async listModels() { assert.fail('resolved routes need no catalog call') },
  }
  const names = await resolveModelNames([...refs, refs[0], '(unknown)', '(turns)'], llm)
  assert.equal(names.size, 9)
  assert.equal(calls.length, 9)
  assert.ok(peak <= 4)
  assert.equal(names.get(refs[0]), 'GPT 6.1 sol')
})

test('resolver failures/blank names fall back to catalog; deleted providers stay optional', async () => {
  const catalogs = []
  const names = await resolveModelNames(['p/id-a', 'p/id-b', 'p/id-c', 'gone/route'], {
    async resolveModelInfo(provider, id) {
      if (id === 'id-a') return { name: 'GPT 6.1 sol' }
      if (id === 'id-b') return { name: '   ' }
      throw new Error('unavailable historical route')
    },
    async listModels(provider) {
      catalogs.push(provider)
      if (provider === 'gone') throw new Error('provider removed')
      return [{ id: 'id-b', name: 'gpt 6.1 sol' }, { id: 'id-c', name: 'gpt-6.1-sol' }]
    },
  })
  assert.equal(names.size, 3)
  assert.deepEqual([...names.values()].map(normalizeModelName), Array(3).fill('gpt-6.1-sol'))
  assert.deepEqual(catalogs.sort(), ['gone', 'p'])
  assert.equal((await resolveModelNames(['p/id-a'])).size, 0)
  const oldHost = await resolveModelNames(['p/id-a', 'p/id-a'], {
    async listModels() { return [{ id: 'id-a', name: 'Display/name' }] },
  })
  assert.equal(oldHost.get('p/id-a'), 'Display/name')
})

test('base adapter echoing route id uses selector catalog name instead', async () => {
  const names = await resolveModelNames(['a/opaque-1', 'b/opaque-2', 'a/unlisted', 'b/rich'], {
    async resolveModelInfo(provider, id) { return { name: id === 'rich' ? 'GPT 6.1 sol' : id } },
    async listModels(provider) {
      return [{ id: provider === 'a' ? 'opaque-1' : 'opaque-2', name: provider === 'a' ? 'gpt-6.1-sol' : 'GPT 6.1 sol' }]
    },
  })
  assert.equal(names.get('a/opaque-1'), 'gpt-6.1-sol')
  assert.equal(names.get('b/opaque-2'), 'GPT 6.1 sol')
  assert.equal(names.get('a/unlisted'), 'unlisted')
  assert.equal(names.get('b/rich'), 'GPT 6.1 sol')
  const stats = aggregateSamples([...names].map(([ref, name]) => sample(ref, name)), { from: day, to: day })
  assert.equal(stats.models.find(model => model.model === 'gpt-6.1-sol').tokens, 120)
})

test('prototype-like display names remain ordinary model keys', () => {
  const stats = aggregateSamples([sample('p/id', 'constructor')], { from: day, to: day })
  assert.equal(stats.models[0].model, 'constructor')
  assert.equal(stats.daily[0].byModel.constructor, 40)
  assert.deepEqual(Object.keys(stats.daily[0].byModel), ['constructor'])
})

test('unresponsive metadata adapters share a deadline instead of queuing 2s per ref', async () => {
  let aborted = 0, calls = 0
  const names = await resolveModelNames(Array.from({ length: 40 }, (_, i) => `p/id-${i}`), {
    resolveModelInfo(provider, id, signal) {
      calls++
      signal.addEventListener('abort', () => { aborted++ })
      return new Promise(() => {})
    },
  })
  assert.equal(names.size, 0)
  assert.ok(calls <= 4)
  assert.equal(aborted, calls)
})

test('store range integration uses display metadata in both granularities without rewriting rows', async () => {
  const rows = [
    { ...sample('a/id-a'), provider: 'a', requests: 2, turns: 1, lastSeen: 0 },
    { ...sample('b/id-b'), provider: 'b', requests: 1, turns: 0, lastSeen: 0 },
    { ...sample('gone/GPT 6.1 sol'), provider: 'gone', requests: 1, turns: 0, lastSeen: 0 },
  ]
  const before = structuredClone(rows)
  const reads = []
  const store = {
    async rangeRows(from, to) { reads.push('day'); assert.equal(from, day); assert.equal(to, day); return rows },
    async rangeHourRows() { reads.push('hour'); return rows },
  }
  const llm = { async resolveModelInfo(provider) {
    if (provider === 'gone') throw new Error('removed provider')
    return { name: provider === 'a' ? 'gpt-6.1-sol' : 'GPT 6.1 sol' }
  } }
  for (const granularity of ['day', 'hour']) {
    const stats = await aggregateRange(store, day, day, granularity, llm)
    assert.equal(stats.tokens, 120)
    assert.equal(stats.models.length, 1)
    assert.equal(stats.models[0].model, 'gpt-6.1-sol')
    assert.equal(stats.models[0].tokens, 120)
    assert.equal(stats.requests, 4)
    assert.equal(stats.turns, 1)
    assert.equal(stats.daily.find(bucket => bucket.total > 0).byModel['gpt-6.1-sol'], 120)
  }
  assert.deepEqual(reads, ['day', 'hour'])
  assert.deepEqual(rows, before)
})

test('HTTP range route passes optional host metadata through for hour/day queries', async () => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const rows = ['a/GPT 6.1 sol', 'b/gpt-6.1-sol'].map(model => ({
    ...sample(model), day: today, hour: `${today}T08`, provider: model[0], requests: 1, turns: 0, lastSeen: 0,
  }))
  for (const metadataAvailable of [true, false]) {
    const lookups = []
    const ctx = { get(service) {
      assert.equal(service, 'llm')
      return metadataAvailable ? { async resolveModelInfo(provider, id) {
        lookups.push([provider, id])
        return { name: 'GPT 6.1 sol' }
      } } : undefined
    } }
    const route = buildUsageRoute(ctx, {
      store: { async rangeRows() { return rows }, async rangeHourRows() { return rows } },
      trust: () => ({ trustedHosts: [] }),
    })
    for (const body of [{ range: 'today' }, { range: 'custom', from: today, to: today }]) {
      const req = { method: 'POST', url: '/token-total/api/range', headers: { host: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { yield JSON.stringify(body) },
      }
      let result
      const res = { writeHead(status) { assert.equal(status, 200) }, end(value) { result = JSON.parse(value) } }
      await route.handler(req, res)
      assert.equal(result.ok, true)
      assert.equal(result.value.granularity, body.range === 'today' ? 'hour' : 'day')
      assert.equal(result.value.models.length, 1)
      assert.equal(result.value.models[0].model, 'gpt-6.1-sol')
      assert.deepEqual(result.value.models[0].providers, ['a', 'b'])
      assert.equal(result.value.models[0].tokens, 80)
      assert.equal(result.value.daily.find(bucket => bucket.total > 0).byModel['gpt-6.1-sol'], 80)
    }
    assert.equal(lookups.length, metadataAvailable ? 4 : 0)
  }
})
