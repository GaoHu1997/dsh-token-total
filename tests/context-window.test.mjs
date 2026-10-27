import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionContextWindow, estimateTokens, messageTokens } from '../src/context-window.ts'
import { contextCategoryTotals, contextReading, contextWindowPercent, treemapLayout } from '../src/client/context-window-core.ts'

const event = (seq, type, data) => ({ seq, type, time: 1_700_000_000_000 + seq * 1000, data })
const text = value => [{ type: 'text', text: value }]
const userMessage = (seq, kind, body, form) => event(seq, 'user/message', {
  content: text(body), source: { kind, ...(form === undefined ? {} : { form }) }, role: 'user', id: `u${seq}`,
})
const toolResult = (seq, callId, body, meta) => event(seq, 'tool/result', {
  turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: text(body), isError: false, id: `t${seq}` }, ...(meta === undefined ? {} : { meta }),
})

test('token estimates bill ASCII at four characters and CJK near one per character', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
  // Two CJK characters are the same order of magnitude as two tokens, not half a token.
  assert.equal(estimateTokens('你好'), 2)
  // Forty CJK characters bill tens of tokens (about 0.67 per character), not a
  // tenth of that: the wide-character rate is what keeps CJK content honest.
  const cjk = estimateTokens('你好世界'.repeat(10))
  assert.ok(cjk >= 25 && cjk <= 30, `expected ~27 tokens for 40 CJK chars, got ${cjk}`)
  // Message framing adds a fixed overhead on top of the content.
  assert.equal(messageTokens({ content: text('abcd') }), 1 + 4)
  // Provider replay bookkeeping is not re-sent, so it never inflates a message.
  assert.equal(messageTokens({ content: text('abcd'), replayState: { response: { huge: 'x'.repeat(4000) } } }), 1 + 4)
})

test('the snapshot reads the newest request state: window, route, tool catalogue, cache split', () => {
  const snapshot = buildSessionContextWindow([
    event(1, 'request/header', { header: { config: { provider: 'group', model: 'glm-5.3' }, tools: [
      { name: 'read', description: 'Read one file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'pwsh', description: 'Run a PowerShell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    ] } }),
    event(2, 'request/context', { provider: 'group', model: 'glm-5.3', contextWindow: 262_144 }),
    event(3, 'system/message', { message: { role: 'system', content: text('You are a coding agent.'), source: { kind: 'system-prompt' } } }),
    userMessage(4, 'runtime-context', 'Current working directory: D:\\repo.', 'snapshot'),
    userMessage(5, 'user', 'Fix the failing test.'),
    event(6, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: { path: 'src/wire.ts' } }),
    toolResult(7, 'c1', 'export interface Wire {}'.repeat(20), { path: 'D:\\repo\\src\\wire.ts', offset: 1 }),
    event(8, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'pwsh', arguments: { command: 'pnpm test' } }),
    toolResult(9, 'c2', 'ok'.repeat(400), { cwd: 'D:\\repo' }),
    event(10, 'assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model' } },
      usage: { inputTokens: 5_000, outputTokens: 40, cacheReadTokens: 20_000, cacheWriteTokens: 0 },
    }),
  ])
  assert.ok(snapshot)
  assert.equal(snapshot.contextWindow, 262_144)
  assert.equal(snapshot.provider, 'group')
  assert.equal(snapshot.model, 'glm-5.3')
  assert.deepEqual({ hit: snapshot.cacheHitTokens, miss: snapshot.cacheMissTokens, known: snapshot.cacheKnown }, { hit: 20_000, miss: 5_000, known: true })
  const byCategory = new Map(contextCategoryTotals(snapshot.items).map(row => [row.key, row.tokens]))
  for (const category of ['system', 'tools', 'memory', 'files', 'results', 'conversation']) {
    assert.ok((byCategory.get(category) ?? 0) > 0, `expected ${category} to carry tokens`)
  }
  // One read groups under its path; the shell result groups under its tool name.
  const files = snapshot.items.filter(item => item.category === 'files')
  assert.deepEqual(files.map(item => item.label), ['D:\\repo\\src\\wire.ts'])
  const results = snapshot.items.filter(item => item.category === 'results')
  assert.deepEqual(results.map(item => [item.label, item.count]), [['pwsh', 1]])
  // The catalogue is the newest request's: one row per tool.
  assert.deepEqual(snapshot.items.filter(item => item.category === 'tools').map(item => item.label).sort(), ['pwsh', 'read'])
  // Conversation rows keep their multiplicity (one prompt + one answer).
  const conversation = snapshot.items.filter(item => item.category === 'conversation').map(item => [item.kind, item.count])
  assert.deepEqual(conversation.sort(), [['assistant', 1], ['user', 1]])
  // The total is exactly the sum of the blocks it paints.
  assert.equal(snapshot.totalTokens, snapshot.items.reduce((sum, item) => sum + item.tokens, 0))
})

test('repeated tool calls and reads fold into one row carrying the call count', () => {
  const events = [event(1, 'request/header', { header: { config: { provider: 'p', model: 'm' }, tools: [] } })]
  for (let i = 0; i < 5; i++) {
    events.push(event(2 + i * 2, 'tool/call', { callId: `c${i}`, name: 'pwsh', arguments: {} }))
    events.push(toolResult(3 + i * 2, `c${i}`, 'log line '.repeat(50), { cwd: 'D:\\repo' }))
  }
  const snapshot = buildSessionContextWindow(events)
  const results = snapshot.items.filter(item => item.category === 'results')
  assert.equal(results.length, 1)
  assert.equal(results[0].label, 'pwsh')
  assert.equal(results[0].count, 5)
})

test('compaction prunes shadowed events out of the window and replays its summary as memory', () => {
  const base = [
    event(1, 'system/message', { message: { role: 'system', content: text('system prompt'), source: { kind: 'system-prompt' } } }),
    userMessage(2, 'user', 'an old prompt that gets compacted away'),
    event(3, 'tool/call', { callId: 'c1', name: 'pwsh', arguments: {} }),
    toolResult(4, 'c1', 'x'.repeat(4000), { cwd: 'D:\\repo' }),
  ]
  const before = buildSessionContextWindow(base)
  const pruned = buildSessionContextWindow([
    ...base,
    event(5, 'compaction/prune', { shadowedRange: { start: 4, end: 4 }, shadowedSeqs: [4], shadowedTokenCount: 1000 }),
    event(6, 'compaction/summary', { shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], summary: text('## Summary\n- the old prompt asked for something'), usage: { inputTokens: 100, outputTokens: 10 } }),
  ])
  // The pruned tool result is gone from the request, not just folded in the log.
  assert.equal(pruned.items.filter(item => item.category === 'results').length, 0)
  assert.equal(pruned.totalTokens < before.totalTokens, true)
  const summary = pruned.items.find(item => item.kind === 'compaction-summary')
  assert.ok(summary)
  assert.ok(summary.tokens > 0)
  // A compaction answer is still an answer: it feeds the cache split.
  assert.equal(pruned.cacheKnown, true)
})

test('a large catalogue folds its tail into one counted row', () => {
  const tools = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: 'does something useful', parameters: { type: 'object' } }))
  const snapshot = buildSessionContextWindow([event(1, 'request/header', { header: { config: {}, tools } })])
  const rows = snapshot.items.filter(item => item.category === 'tools')
  const rest = rows.find(item => item.kind === 'rest')
  assert.ok(rest, 'expected a folded tail')
  assert.equal(rest.count, 10)
  assert.equal(rest.tokens, 10 * rows.filter(item => item.kind === undefined)[0].tokens)
})

test('an empty log has no snapshot to paint', () => {
  assert.equal(buildSessionContextWindow([]), null)
})

test('the squarified layout fills the box, keeps order and stays inside it', () => {
  const boxes = treemapLayout([{ key: 'a', tokens: 50 }, { key: 'b', tokens: 30 }, { key: 'c', tokens: 20 }], 300, 200)
  assert.equal(boxes.length, 3)
  assert.deepEqual(boxes.map(box => box.key), ['a', 'b', 'c'])
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0)
    assert.ok(box.x + box.width <= 300.01 && box.y + box.height <= 200.01)
    assert.ok(box.width > 0 && box.height > 0)
  }
  const covered = boxes.reduce((sum, box) => sum + box.width * box.height, 0)
  assert.ok(Math.abs(covered - 300 * 200) < 600, `layout covered ${covered} of 60000`)
  // Proportions survive: the biggest block keeps the biggest area.
  const area = key => { const box = boxes.find(candidate => candidate.key === key); return box.width * box.height }
  assert.ok(area('a') > area('b') && area('b') > area('c'))
  // One block takes the whole box; zero-weight input paints nothing.
  const single = treemapLayout([{ key: 'only', tokens: 7 }], 120, 80)
  assert.deepEqual(single, [{ key: 'only', x: 0, y: 0, width: 120, height: 80 }])
  assert.deepEqual(treemapLayout([], 120, 80), [])
  assert.deepEqual(treemapLayout([{ key: 'zero', tokens: 0 }], 120, 80), [])
})

test('occupancy and category totals stay honest about missing data', () => {
  assert.equal(contextWindowPercent(60_200, null), null)
  assert.equal(contextWindowPercent(60_200, 0), null)
  assert.equal(contextWindowPercent(131_072, 262_144), 50)
  assert.equal(contextWindowPercent(400_000, 262_144), 100)
  const items = [
    { key: 'conversation:user', category: 'conversation', label: '', kind: 'user', count: 1, tokens: 40 },
    { key: 'system:system-prompt', category: 'system', label: '', kind: 'system-prompt', count: 1, tokens: 60 },
  ]
  assert.deepEqual(contextCategoryTotals(items), [{ key: 'system', tokens: 60 }, { key: 'conversation', tokens: 40 }])
  assert.deepEqual(contextCategoryTotals([]), [])
})

test('the billed prompt is the used total, and the estimate only stands in without one', () => {
  const base = (usage) => buildSessionContextWindow([
    event(1, 'request/context', { provider: 'group', model: 'glm-5.3', contextWindow: 262_144 }),
    userMessage(2, 'user', 'hello there'),
    event(3, 'assistant/message', { message: { role: 'assistant', content: text('hi'), source: { kind: 'model' } }, usage }),
  ])
  // Reported total minus the answer's own output = the prompt the model held.
  const billed = base({ inputTokens: 900, outputTokens: 100, totalTokens: 40_100, cacheReadTokens: 39_100 })
  assert.equal(billed.promptTokens, 40_000)
  // No total reported: the uncached plus cached input is the prompt.
  const fallback = base({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 39_100 })
  assert.equal(fallback.promptTokens, 40_000)
  // An answer that never reported usage leaves the figure unknown, not zero.
  assert.equal(base(undefined).promptTokens, null)
})

test('the reading prefers the billed prompt and flags a replay estimate that overshoots', () => {
  const snapshot = (totalTokens, promptTokens) => ({
    totalTokens, contextWindow: 262_144, provider: 'group', model: 'glm-5.3',
    cacheHitTokens: 0, cacheMissTokens: 0, cacheKnown: false, promptTokens, items: [],
  })
  // Agreement (within the tolerance) keeps the estimate's own total as used.
  const agree = contextReading(snapshot(40_000, 40_500))
  assert.deepEqual(agree, { usedTokens: 40_500, percent: 15, estimateTokens: 40_000, estimateDiffers: false })
  // A compressed replay: the blocks sum far above what the provider billed.
  const compressed = contextReading(snapshot(1_419_173, 73_711))
  assert.equal(compressed.usedTokens, 73_711)
  assert.equal(compressed.percent, 28)
  assert.equal(compressed.estimateDiffers, true)
  // Without a billed figure the estimate is all we have, and that is not a gap.
  const estimateOnly = contextReading(snapshot(73_711, null))
  assert.deepEqual(estimateOnly, { usedTokens: 73_711, percent: 28, estimateTokens: 73_711, estimateDiffers: false })
})
