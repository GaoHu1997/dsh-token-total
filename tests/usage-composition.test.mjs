import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionUsageComposition, mergeUsageCompositions } from '../src/usage-composition.ts'
import { messageTokens, toolTokens } from '../src/context-window.ts'
import { CONTEXT_BUCKET_ORDER, USAGE_BUCKET_ORDER } from '../src/usage-buckets.ts'

const event = (seq, type, data) => ({ seq, type, time: 1_700_000_000_000 + seq * 1000, data })
const text = value => [{ type: 'text', text: value }]
const tools = [
  { name: 'pwsh', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'read', description: 'Read one file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const header = (seq, catalogue = tools) => event(seq, 'request/header', { header: { config: { provider: 'p', model: 'm' }, tools: catalogue } })
const system = seq => event(seq, 'system/message', { message: { role: 'system', content: text('You are a coding agent.'), source: { kind: 'system-prompt' } } })
const user = (seq, body, kind = 'user') => event(seq, 'user/message', { content: text(body), source: { kind } })
const answer = (seq, usage, body = 'done') => event(seq, 'assistant/message', {
  message: { role: 'assistant', content: text(body) },
  usage,
})
const result = (seq, body) => event(seq, 'tool/result', { message: { role: 'tool', content: text(body) } })
const usageA = { inputTokens: 5_000, outputTokens: 40, cacheReadTokens: 20_000, cacheWriteTokens: 100 }
const usageB = { inputTokens: 1_000, outputTokens: 30, cacheReadTokens: 26_000, cacheWriteTokens: 0 }
const byKey = composition => new Map(composition.buckets.map(row => [row.key, row.tokens]))

test('the composition keeps the eight buckets in legend order and folds the billed split', () => {
  const composition = buildSessionUsageComposition([
    header(1),
    system(2),
    user(3, 'Fix the failing test.'),
    result(4, 'ok '.repeat(200)),
    answer(5, usageA),
  ])
  assert.ok(composition)
  assert.deepEqual(composition.buckets.map(row => row.key), [...USAGE_BUCKET_ORDER])
  // The context card renders the same split minus output; the orders must stay
  // aligned so both legends read left to right.
  assert.deepEqual([...CONTEXT_BUCKET_ORDER], [...USAGE_BUCKET_ORDER].filter(key => key !== 'output'))
  const buckets = byKey(composition)
  assert.ok(buckets.get('systemPrompt') > 0)
  assert.ok(buckets.get('user') > 0)
  assert.ok(buckets.get('toolResult') > 0)
  // The first request carried no assistant history: only its own catalogue.
  assert.equal(buckets.get('assistant'), 0)
  assert.equal(buckets.get('skill'), 0)
  assert.equal(buckets.get('injected'), 0)
  assert.equal(buckets.get('toolDef'), tools.reduce((sum, tool) => sum + toolTokens(tool), 0))
  assert.equal(buckets.get('output'), usageA.outputTokens)
  assert.equal(composition.requests, 1)
  assert.equal(composition.billedTokens, usageA.inputTokens + usageA.outputTokens + usageA.cacheReadTokens + usageA.cacheWriteTokens)
  assert.deepEqual(composition.totals, {
    uncachedInputTokens: usageA.inputTokens,
    outputTokens: usageA.outputTokens,
    cacheReadTokens: usageA.cacheReadTokens,
    cacheWriteTokens: usageA.cacheWriteTokens,
  })
})

test('a second request is charged for the earlier answer and the shared prompt again', () => {
  const composition = buildSessionUsageComposition([
    header(1),
    system(2),
    user(3, 'Fix the failing test.'),
    answer(4, usageA, 'First answer.'),
    user(5, 'Now add a regression test.'),
    result(6, 'ok '.repeat(200)),
    answer(7, usageB, 'Second answer.'),
  ])
  const buckets = byKey(composition)
  assert.equal(composition.requests, 2)
  // Both requests replayed the system prompt; the second also replayed the
  // first answer, which is why that bucket is non-zero now.
  assert.equal(buckets.get('systemPrompt'), 2 * messageTokens({ content: text('You are a coding agent.') }))
  assert.ok(buckets.get('assistant') >= messageTokens({ content: text('First answer.') }))
  assert.equal(buckets.get('user'), 2 * messageTokens({ content: text('Fix the failing test.') }) + messageTokens({ content: text('Now add a regression test.') }))
  assert.equal(buckets.get('toolResult'), messageTokens({ content: text('ok '.repeat(200)) }))
  // The catalogue rides on every request, not just the newest one.
  assert.equal(buckets.get('toolDef'), 2 * tools.reduce((sum, tool) => sum + toolTokens(tool), 0))
  assert.equal(buckets.get('output'), usageA.outputTokens + usageB.outputTokens)
  assert.equal(composition.billedTokens, 5_000 + 40 + 20_000 + 100 + 1_000 + 30 + 26_000)
})

test('compaction charges its own prompt before pruning the shadowed blocks', () => {
  const summaryUsage = { inputTokens: 30_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const composition = buildSessionUsageComposition([
    header(1),
    system(2),
    user(3, 'An old prompt that gets compacted away.'),
    answer(4, usageA),
    event(5, 'compaction/summary', {
      summary: text('Earlier: the user asked for a failing test to be fixed.'),
      shadowedSeqs: [3],
      usage: summaryUsage,
    }),
    user(6, 'Continue.'),
    answer(7, usageB),
  ])
  const buckets = byKey(composition)
  assert.equal(composition.requests, 3, 'the summary call is billed as a request')
  // The old prompt was replayed by request 1 and by the summary request, then
  // dropped: the third request no longer carries it.
  assert.equal(buckets.get('user'), 2 * messageTokens({ content: text('An old prompt that gets compacted away.') }) + messageTokens({ content: text('Continue.') }))
  // The summary itself replays as injected content on the next request.
  assert.equal(buckets.get('injected'), messageTokens({ content: text('Earlier: the user asked for a failing test to be fixed.') }))
  assert.equal(buckets.get('systemPrompt'), 3 * messageTokens({ content: text('You are a coding agent.') }))
})

test('a shadowed range prunes exactly the events it names', () => {
  const composition = buildSessionUsageComposition([
    header(1),
    system(2),
    user(3, 'one'),
    user(4, 'two'),
    user(5, 'three'),
    answer(6, usageA),
    event(7, 'compaction/prune', { shadowedRange: { start: 3, end: 4 } }),
    user(8, 'four'),
    answer(9, usageB),
  ])
  const buckets = byKey(composition)
  const one = messageTokens({ content: text('one') })
  const two = messageTokens({ content: text('two') })
  const three = messageTokens({ content: text('three') })
  const four = messageTokens({ content: text('four') })
  // Request 1 saw one/two/three, request 2 saw three/four only.
  assert.equal(buckets.get('user'), one + two + 2 * three + four)
})

test('the eight legend buckets carry skill catalogues and runtime injections separately', () => {
  const composition = buildSessionUsageComposition([
    header(1),
    system(2),
    event(3, 'system/message', { message: { role: 'system', content: text('Today is Wednesday.'), source: { kind: 'time-context' } } }),
    user(4, 'Use the office skill.', 'skill-catalog'),
    user(5, 'Current working directory: D:\\repo.', 'runtime-context'),
    user(6, 'Do the thing.'),
    answer(7, usageA),
  ])
  const buckets = byKey(composition)
  assert.equal(buckets.get('skill'), messageTokens({ content: text('Use the office skill.') }))
  assert.equal(buckets.get('injected'), messageTokens({ content: text('Today is Wednesday.') }) + messageTokens({ content: text('Current working directory: D:\\repo.') }))
  assert.equal(buckets.get('user'), messageTokens({ content: text('Do the thing.') }))
})

test('a log without usage hides the card, and merging adds a child tree in', () => {
  assert.equal(buildSessionUsageComposition([]), null)
  assert.equal(buildSessionUsageComposition([system(1), user(2, 'hi')]), null, 'no usage, no card')
  const root = buildSessionUsageComposition([header(1), system(2), answer(3, usageA)])
  const child = buildSessionUsageComposition([header(1, [tools[0]]), user(2, 'sub task'), answer(3, usageB)])
  const merged = mergeUsageCompositions([root, null, child])
  assert.ok(merged)
  assert.equal(merged.requests, root.requests + child.requests)
  assert.equal(merged.billedTokens, root.billedTokens + child.billedTokens)
  assert.equal(merged.buckets.find(row => row.key === 'toolDef').tokens, toolTokens(tools[0]) + toolTokens(tools[1]) + toolTokens(tools[0]))
  assert.equal(merged.buckets.find(row => row.key === 'output').tokens, usageA.outputTokens + usageB.outputTokens)
  assert.deepEqual(merged.totals, {
    uncachedInputTokens: usageA.inputTokens + usageB.inputTokens,
    outputTokens: usageA.outputTokens + usageB.outputTokens,
    cacheReadTokens: usageA.cacheReadTokens + usageB.cacheReadTokens,
    cacheWriteTokens: usageA.cacheWriteTokens + usageB.cacheWriteTokens,
  })
  assert.equal(mergeUsageCompositions([null, undefined]), null)
})
