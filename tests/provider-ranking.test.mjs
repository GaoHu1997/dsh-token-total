import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateSamples } from '../src/query.ts'
import { aggregateRange, buildUsageRoute } from '../src/routes.ts'
import { resolveProviderNames } from '../src/model-names.ts'

const day = '2026-10-22'
const sample = (model, modelName, tokens = {}) => ({
  day, hour: `${day}T08`, model, modelName,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 5,
  ...tokens,
})

test('provider route ids resolve to the selector display names, both catalogs', () => {
  const names = resolveProviderNames({
    listProviders: () => [{ id: 'a', name: '  Acme ' }, { id: 'blank', name: '   ' }, { id: '', name: 'nameless' }],
    listConfigurableProviders: () => [
      { provider: 'a', displayName: 'ignored (listProviders wins)' },
      { provider: 'b', displayName: 'Beta' },
      { provider: 'c', displayName: '   ' },
    ],
  })
  assert.deepEqual({ ...names }, { a: 'Acme', b: 'Beta' })
  // The map is null-prototype so a route id shaped like an Object member stays
  // an ordinary key rather than resolving to inherited junk.
  const tricky = resolveProviderNames({ listProviders: () => [{ id: 'constructor', name: 'Ctor' }] })
  assert.equal(tricky.constructor, 'Ctor')
  assert.equal(Object.getPrototypeOf(tricky), null)
})

test('a missing, broken, or async provider catalog degrades to the raw route id', () => {
  assert.deepEqual({ ...resolveProviderNames() }, {})
  assert.deepEqual({ ...resolveProviderNames({}) }, {})
  assert.deepEqual({ ...resolveProviderNames({ listProviders() { throw new Error('host busy') } }) }, {})
  // A host publishing the catalog over a remote face hands back a promise.
  assert.deepEqual({ ...resolveProviderNames({ listProviders: () => Promise.resolve([{ id: 'a', name: 'Acme' }]) }) }, {})
})

test('model rows carry their per-provider split and provider rows their per-model split', () => {
  const stats = aggregateSamples([
    sample('a/route-1', 'gpt 6.1 sol'),
    sample('b/route-2', 'GPT 6.1 sol'),
    sample('a/route-3', 'gpt-6.2-sol'),
  ], { from: day, to: day })
  assert.equal(stats.tokens, 120)
  const merged = stats.models.find(model => model.model === 'gpt-6.1-sol')
  assert.equal(merged.tokens, 80)
  assert.deepEqual(merged.providers, ['a', 'b'])
  assert.deepEqual(merged.providerTokens, [
    { provider: 'a', tokens: 40 },
    { provider: 'b', tokens: 40 },
  ])
  // Largest first: the split and the ranking agree on ordering.
  assert.deepEqual(stats.models.map(m => [m.model, m.providerTokens]), [
    ['gpt-6.1-sol', [{ provider: 'a', tokens: 40 }, { provider: 'b', tokens: 40 }]],
    ['gpt-6.2-sol', [{ provider: 'a', tokens: 40 }]],
  ])
  const acme = stats.providers.find(provider => provider.provider === 'a')
  assert.deepEqual(acme.modelTokens, [
    { model: 'gpt-6.1-sol', tokens: 40 },
    { model: 'gpt-6.2-sol', tokens: 40 },
  ])
  assert.deepEqual(stats.providers.find(provider => provider.provider === 'b').modelTokens, [
    { model: 'gpt-6.1-sol', tokens: 40 },
  ])
  // Every split sums back to its row: the tip never contradicts the list.
  for (const model of stats.models) {
    assert.equal(model.providerTokens.reduce((n, item) => n + item.tokens, 0), model.tokens)
  }
  for (const provider of stats.providers) {
    assert.equal(provider.modelTokens.reduce((n, item) => n + item.tokens, 0), provider.tokens)
  }
})

test('the range query attaches display names as presentational metadata only', async () => {
  const rows = [
    { ...sample('a/route-1', 'gpt-6.1-sol'), provider: 'a', requests: 1, turns: 0, lastSeen: 0 },
    { ...sample('b/route-2', 'gpt-6.1-sol'), provider: 'b', requests: 1, turns: 0, lastSeen: 0 },
  ]
  const before = structuredClone(rows)
  const store = {
    async rangeRows() { return rows },
    async rangeHourRows() { return rows },
  }
  const llm = {
    async resolveModelInfo() { return { name: 'gpt-6.1-sol' } },
    listProviders: () => [{ id: 'a', name: 'Acme' }],
    listConfigurableProviders: () => [{ provider: 'b', displayName: 'Beta' }],
  }
  const stats = await aggregateRange(store, day, day, 'day', llm)
  // Null-prototype on purpose: a route id shaped like an Object member must
  // stay an ordinary key all the way to the client.
  assert.deepEqual({ ...stats.providerNames }, { a: 'Acme', b: 'Beta' })
  assert.deepEqual(rows, before)

  // A service too old to expose a catalog leaves the field off entirely, so the
  // client keeps falling back to the raw id.
  const bare = await aggregateRange(store, day, day, 'day', { async resolveModelInfo() { return { name: 'gpt-6.1-sol' } } })
  assert.equal(bare.providerNames, undefined)
  const none = await aggregateRange(store, day, day, 'day')
  assert.equal(none.providerNames, undefined)
})

test('HTTP range route ships provider display names alongside the ranking', async () => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const rows = ['a/route-1', 'b/route-2'].map(model => ({
    ...sample(model), day: today, hour: `${today}T08`, provider: model[0], requests: 1, turns: 0, lastSeen: 0,
  }))
  const ctx = { get(service) {
    assert.equal(service, 'llm')
    return {
      async resolveModelInfo() { return { name: 'gpt-6.1-sol' } },
      listProviders: () => [{ id: 'a', name: 'Acme' }],
      listConfigurableProviders: () => [{ provider: 'b', displayName: 'Beta' }],
    }
  } }
  const route = buildUsageRoute(ctx, {
    store: { async rangeRows() { return rows }, async rangeHourRows() { return rows } },
    trust: () => ({ trustedHosts: [] }),
  })
  const req = { method: 'POST', url: '/token-total/api/range', headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ range: 'custom', from: today, to: today }) },
  }
  let result
  const res = { writeHead(status) { assert.equal(status, 200) }, end(value) { result = JSON.parse(value) } }
  await route.handler(req, res)
  assert.equal(result.ok, true)
  assert.deepEqual({ ...result.value.providerNames }, { a: 'Acme', b: 'Beta' })
  assert.deepEqual(result.value.providers.map(provider => provider.provider), ['a', 'b'])
  assert.deepEqual(result.value.models[0].providerTokens, [
    { provider: 'a', tokens: 40 },
    { provider: 'b', tokens: 40 },
  ])
})
