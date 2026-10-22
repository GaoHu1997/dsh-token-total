import assert from 'node:assert/strict'
import test from 'node:test'
import { UsageFold } from '../src/collector.ts'
import { aggregateSamples } from '../src/query.ts'
import { usageDayRowSchema, usageHourRowSchema } from '../src/store.ts'

const time = Date.UTC(2026, 9, 22, 8)
const usage = (inputTokens, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
const event = (seq, type, data) => ({ seq, time, type, data })
const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

const expectBuckets = (stats, expected) => {
  assert.equal(stats.tokens, expected.inputTokens + expected.outputTokens + expected.cacheReadTokens + expected.cacheWriteTokens)
  assert.equal(stats.inputTokens, expected.inputTokens)
  assert.equal(stats.outputTokens, expected.outputTokens)
  assert.equal(stats.cacheTokens, expected.cacheReadTokens + expected.cacheWriteTokens)
  assert.equal(stats.cacheHit, expected.cacheReadTokens)
  assert.equal(stats.cacheMiss, expected.inputTokens + expected.cacheWriteTokens)
  assert.equal(stats.models[0].tokens, stats.tokens)
  assert.equal(stats.models[0].cacheHit, stats.cacheHit)
  assert.equal(stats.models[0].cacheMiss, stats.cacheMiss)
  assert.equal(stats.providers[0].tokens, stats.tokens)
  assert.equal(stats.providers[0].cacheHit, stats.cacheHit)
  assert.equal(stats.providers[0].cacheMiss, stats.cacheMiss)
  const bucket = stats.daily.find(row => row.total !== 0)
  assert.equal(bucket.total, stats.tokens)
  assert.equal(bucket.byModel.model, stats.tokens)
  assert.equal(bucket.byProvider.provider, stats.tokens)
  assert.equal(bucket.cacheHit, stats.cacheHit)
  assert.equal(bucket.cacheMiss, stats.cacheMiss)
}

test('failed attempt negative usage correction and retry retain final billed buckets in day/hour queries', () => {
  const fold = new UsageFold()
  const samples = [
    fold.fold(event(0, 'step/start', { turn: 1, step: 1 })),
    fold.fold(event(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: usage(100, 50, 300, 20) } })),
    fold.fold(event(2, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage: usage(40, 10, 100, 5) } }] })),
    fold.fold(event(3, 'llm/retry-started', { turn: 1, step: 1 })),
    fold.fold(event(4, 'assistant/message', { turn: 1, step: 1, usage: usage(20, 30, 10, 2) })),
  ]
  assert.ok(samples[2].failed)
  assert.equal(samples[2].inputTokens, -60)
  for (const sample of samples) sample.model = 'provider/model'
  const day = samples[0].day
  for (const granularity of ['day', 'hour']) {
    const stats = aggregateSamples(samples, { from: day, to: day }, granularity)
    expectBuckets(stats, usage(60, 40, 110, 7))
    assert.equal(stats.requests, 2)
    assert.equal(stats.failures, 1)
    assert.equal(stats.daily.reduce((sum, row) => sum + row.requests, 0), 2)
    assert.equal(stats.daily.reduce((sum, row) => sum + row.failures, 0), 1)
  }
})

test('net-zero and negative marker corrections still update cache and ranked bucket totals', () => {
  const base = { day: '2026-10-22', hour: '2026-10-22T08', model: 'provider/model' }
  const samples = [
    { ...base, ...usage(100, 0, 100, 0) },
    { ...base, ...usage(-20, 0, 20, 0), failed: true },
    { ...base, ...usage(-10, 0, -10, 0), request: true },
  ]
  for (const granularity of ['day', 'hour']) {
    const stats = aggregateSamples(samples, { from: base.day, to: base.day }, granularity)
    expectBuckets(stats, usage(70, 0, 110, 0))
    assert.equal(stats.requests, 1)
    assert.equal(stats.failures, 1)
  }
})

test('zero-token request and failure markers count independently without active/model rows', () => {
  const day = '2026-10-22'
  const marker = { day, hour: `${day}T08`, model: 'provider/model', ...empty, request: true, failed: true }
  for (const granularity of ['day', 'hour']) {
    const stats = aggregateSamples([marker], { from: day, to: day }, granularity)
    assert.equal(stats.requests, 1)
    assert.equal(stats.failures, 1)
    assert.equal(stats.tokens, 0)
    assert.equal(stats.activeDays, 0)
    assert.deepEqual(stats.models, [])
    assert.deepEqual(stats.providers, [])
    const bucket = stats.daily.find(row => row.requests === 1)
    assert.equal(bucket.failures, 1)
    assert.deepEqual(bucket.byModel, {})
  }
})

test('day and hour schemas accept legacy missing failures as zero and preserve existing counts', () => {
  const legacy = { provider: 'provider', model: 'provider/model', ...empty, requests: 4, turns: 1, lastSeen: time }
  for (const [schema, identity] of [[usageDayRowSchema, { day: '2026-10-22' }], [usageHourRowSchema, { hour: '2026-10-22T08' }]]) {
    assert.equal(schema.parse({ ...legacy, ...identity }).failures, 0)
    assert.equal(schema.parse({ ...legacy, ...identity, failures: 3 }).failures, 3)
    assert.equal(schema.safeParse({ ...legacy, ...identity, failures: '3' }).success, false)
  }
})
