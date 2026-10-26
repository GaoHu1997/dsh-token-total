import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionUsageDetail } from '../src/session-detail.ts'
import { decodeRateOf } from '../src/shared.ts'
// The composer bottom bar renders the official `sessionStats` projection, so it
// is the ground truth for "token 速度". The package does not export the
// projection definition from its root entry, so import the module by path.
import { sessionStatsProjectionDefinition as official } from '../node_modules/@deepseek-ai/dsh-session-stats/lib/types/projection.js'

const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
const ev = (seq, time, type, data = {}) => ({ seq, time, type, data })
const text = (time, value) => ({ type: 'chunk', time, chunk: { type: 'text-delta', text: value } })
const run = (time0, texts, dt) => ({ type: 'text-chunks', time0, index: 0, dt, texts })

// Step 1 retries: attempt one streams the step's first token, the retry keeps
// that token, and only the assembled message closes the decode window.
// Step 2 packs its deltas into a run, so the first non-empty fragment decides
// the token time. Step 3 is cancelled (token, no message). Step 4 assembles a
// message with no usage. Step 5 reports zero output tokens: official still
// spends the decode window on it, and so must this plugin.
const events = [
  ev(0, 1000, 'turn/start', { turn: 1 }),
  ev(1, 1000, 'step/start', { turn: 1, step: 1 }),
  ev(2, 1500, 'assistant/attempt', { turn: 1, step: 1, stream: [text(1600, 'Hel'), text(1700, 'lo')] }),
  ev(3, 2000, 'llm/retry-started', { turn: 1, step: 1 }),
  ev(4, 2200, 'assistant/attempt', { turn: 1, step: 1, stream: [text(3000, 'Retry')] }),
  ev(5, 4000, 'assistant/message', { turn: 1, step: 1, usage: usage(100, 300), stream: [text(3900, 'done')] }),
  ev(6, 4000, 'step/end', { turn: 1, step: 1 }),
  ev(7, 5000, 'step/start', { turn: 1, step: 2 }),
  ev(8, 5100, 'assistant/attempt', { turn: 1, step: 2, stream: [run(5200, ['', 'ab', 'cd'], [30, 40])] }),
  ev(9, 7000, 'assistant/message', { turn: 1, step: 2, usage: usage(50, 177) }),
  ev(10, 7000, 'step/end', { turn: 1, step: 2 }),
  ev(11, 8000, 'step/start', { turn: 1, step: 3 }),
  ev(12, 8100, 'assistant/attempt', { turn: 1, step: 3, stream: [text(8200, 'partial')] }),
  ev(13, 9000, 'turn/end', { turn: 1 }),
  ev(14, 10000, 'turn/start', { turn: 2 }),
  ev(15, 10000, 'step/start', { turn: 2, step: 1 }),
  ev(16, 10100, 'assistant/attempt', { turn: 2, step: 1, stream: [text(10200, 'x')] }),
  ev(17, 11000, 'assistant/message', { turn: 2, step: 1 }),
  ev(18, 11000, 'step/end', { turn: 2, step: 1 }),
  ev(19, 12000, 'turn/start', { turn: 3 }),
  ev(20, 12000, 'step/start', { turn: 3, step: 1 }),
  ev(21, 12100, 'assistant/attempt', { turn: 3, step: 1, stream: [text(12200, 'z')] }),
  ev(22, 13000, 'assistant/message', { turn: 3, step: 1, usage: usage(10, 0) }),
  ev(23, 13000, 'step/end', { turn: 3, step: 1 }),
  // Step 6: the usage rides inside the stream only. The official projection
  // reads `event.data.usage`, so neither side opens a decode window here even
  // though the live fold saw those tokens.
  ev(24, 14000, 'turn/start', { turn: 4 }),
  ev(25, 14000, 'step/start', { turn: 4, step: 1 }),
  ev(26, 14100, 'assistant/attempt', { turn: 4, step: 1, stream: [text(14300, 'tok')] }),
  ev(27, 15200, 'assistant/message', { turn: 4, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(1, 99) } }] }),
  ev(28, 15200, 'step/end', { turn: 4, step: 1 }),
  // Step 7: no attempt at all — the assembled message's own stream carries the
  // first token, which the projection also accepts as the window's start.
  ev(29, 16000, 'turn/start', { turn: 5 }),
  ev(30, 16000, 'step/start', { turn: 5, step: 1 }),
  ev(31, 17000, 'assistant/message', { turn: 5, step: 1, usage: usage(5, 50), stream: [text(16500, 'x')] }),
  ev(32, 17000, 'step/end', { turn: 5, step: 1 }),
]

const persistence = {
  list: async () => [{ id: 'root', name: 'Main' }],
  inspect: async () => ({ meta: { id: 'root' }, events, inheritedEventCount: 0 }),
}
const officialStats = () => events.reduce((state, event) => official.apply(state, event), official.init())

test('per-request decode window and speed follow the official sessionStats projection', async () => {
  const detail = await buildSessionUsageDetail(persistence, undefined, 'root')
  const stats = officialStats()
  const rows = new Map(detail.records.map(row => [`${row.turn}:${row.step}`, row]))

  // decodeMs is message time minus the STEP's first token, not this attempt's:
  // 4000 - 1600 = 2400 ms for 300 tokens.
  assert.equal(rows.get('1:1').decodeMs, 2400)
  assert.equal(rows.get('1:1').tokensPerSecond, 125)
  // The row still reports its own first-token wait (retry start 2000 → 3000),
  // while the official projection measures the step from its first attempt.
  assert.equal(rows.get('1:1').firstTokenMs, 1000)
  // A packed delta run starts at its first non-empty fragment: 5200 + dt[0].
  assert.equal(rows.get('1:2').firstTokenMs, 230)
  assert.equal(rows.get('1:2').decodeMs, 1770)
  assert.equal(rows.get('1:2').tokensPerSecond, 100)

  const failed = detail.records.find(row => row.turn === 1 && row.step === 1 && row.status === 'failed')
  assert.equal(failed.decodeMs, null, 'a failed attempt never carries decode time')
  assert.equal(failed.tokensPerSecond, null)
  const cancelled = detail.records.find(row => row.step === 3)
  assert.equal(cancelled.status, 'failed')
  assert.equal(cancelled.decodeMs, null, 'a cancelled step never closes a decode window')

  // No usage: no decode time, but the first-token wait still counts.
  assert.equal(rows.get('2:1').decodeMs, null)
  assert.equal(rows.get('2:1').firstTokenMs, 200)
  // Zero reported output still spends the window, exactly like the projection.
  assert.equal(rows.get('3:1').decodeMs, 800)
  assert.equal(rows.get('3:1').tokensPerSecond, null, 'a zero-token row shows no rate')
  // A stream-only usage never closes the window, but the message's own stream
  // may still open one when no attempt streamed a token first.
  assert.equal(rows.get('4:1').firstTokenMs, 300)
  assert.equal(rows.get('4:1').decodeMs, null)
  assert.equal(rows.get('4:1').tokensPerSecond, null)
  assert.equal(rows.get('5:1').firstTokenMs, 500)
  assert.equal(rows.get('5:1').decodeMs, 500)
  assert.equal(rows.get('5:1').tokensPerSecond, 100)

  const officialRate = stats.decodeTokens / (stats.decodeMs / 1000)
  assert.equal(stats.decodeTokens, 527)
  assert.equal(stats.decodeMs, 5470)
  assert.ok(Math.abs(detail.tokensPerSecond - officialRate) < 1e-9, 'the card speed is the bottom-bar decode rate')
  assert.ok(Math.abs(decodeRateOf(detail.records) - officialRate) < 1e-9, 'the turn-summary helper agrees')
  // Official latency is per step (first attempt's token minus the step start):
  // this plugin averages each answered request's own wait, so a retried step
  // counts its retry, and the two averages differ on purpose.
  assert.equal(stats.ttftMs / stats.ttftSteps, 2030 / 6, 'official first-token time is measured per step')
  assert.equal(detail.averageFirstTokenMs, (1000 + 230 + 200 + 200 + 300 + 500) / 6)
})

test('a session without a first token or a closed window reports no speed', async () => {
  const barren = {
    list: async () => [{ id: 'root', name: 'Main' }],
    inspect: async () => ({ meta: { id: 'root' }, inheritedEventCount: 0, events: [
      ev(0, 1000, 'turn/start', { turn: 1 }),
      ev(1, 1000, 'step/start', { turn: 1, step: 1 }),
      ev(2, 2000, 'assistant/message', { turn: 1, step: 1, usage: usage(10, 20) }),
      ev(3, 3000, 'step/end', { turn: 1, step: 1 }),
    ] }),
  }
  const detail = await buildSessionUsageDetail(barren, undefined, 'root')
  assert.equal(detail.records[0].decodeMs, null)
  assert.equal(detail.records[0].tokensPerSecond, null)
  assert.equal(detail.tokensPerSecond, null)
  assert.equal(detail.averageFirstTokenMs, null)
})
