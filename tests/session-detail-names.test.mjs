import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionUsageDetail } from '../src/session-detail.ts'

// Host-side contract for the by-model card labels: model rows stay keyed by the
// raw historical model id, but each row carries the model selector's display
// name plus the providers that served it, so the client can label rows with the
// name and disambiguate same-named models in gray.
const usage = (inputTokens, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
const event = (seq, data, type = 'assistant/message') => ({ seq, time: Date.UTC(2026, 9, 22, 8, 0, seq), type, data })
const request = (seq, source, usageAt) => [
  event(seq, { source }, 'request/context'),
  event(seq + 1, { turn: 1, step: seq }, 'step/start'),
  event(seq + 2, { turn: 1, step: seq, usage: usageAt }),
]

const events = [
  // A route without a provider still resolves its display name (bare ref).
  ...request(1, { model: 'orphan-model' }, usage(10, 2, 1, 1)),
  // Same model id served by two providers → one row, both providers listed.
  ...request(4, { provider: 'github', model: 'gpt-6.1-sol' }, usage(100, 20, 5, 2)),
  ...request(7, { provider: 'linuxdo', model: 'gpt-6.1-sol' }, usage(200, 40, 5, 2)),
  ...request(10, { provider: 'group', model: 'minimax-m3' }, usage(5, 5)),
  // resolveModelInfo rejects this route; the selector catalog still names it.
  ...request(13, { provider: 'gone', model: 'mystery-9' }, usage(1, 1)),
  // Unknown everywhere: the raw id stays the label.
  ...request(16, { provider: 'ghost', model: 'ghost-1' }, usage(1, 1)),
  // A different route id with the same display name as gpt-6.1-sol.
  ...request(19, { provider: 'dseek', model: 'deepseek-v4' }, usage(1, 1)),
  event(22, { turn: 1 }, 'turn/end'),
]

const CATALOG = {
  'github/gpt-6.1-sol': 'GPT 6.1 Sol',
  'linuxdo/gpt-6.1-sol': 'gpt 6.1 sol',
  'group/minimax-m3': 'MiniMax M3',
  'default/orphan-model': 'Orphan Model',
  'dseek/deepseek-v4': 'GPT 6.1 Sol',
}
const llm = {
  listProviders: () => [
    { id: 'github', name: 'GitHub Models' },
    { id: 'linuxdo', name: 'LinuxDO' },
    { id: 'group', name: 'Group' },
    { id: 'gone', name: 'Gone' },
    { id: 'dseek', name: 'DeepSeek' },
  ],
  listConfigurableProviders: () => [
    { provider: 'group', displayName: 'Group Configurable' }, // listProviders wins
  ],
  resolveModelInfo: async (provider, model) => {
    const name = CATALOG[`${provider}/${model}`]
    if (!name) throw new Error(`unknown route ${provider}/${model}`)
    return { name }
  },
  listModels: async provider => (provider === 'gone' ? [{ id: 'mystery-9', name: 'Mystery Nine' }] : []),
}
const persistence = {
  list: async () => [{ id: 'root', name: 'Main' }],
  inspect: async () => ({ meta: { id: 'root' }, events, inheritedEventCount: 0 }),
}
const ctx = { get: key => (key === 'llm' ? llm : undefined) }

test('model rows resolve display names and provider labels without losing the raw ids', async () => {
  const detail = await buildSessionUsageDetail(persistence, undefined, 'root', ctx)
  const rowOf = model => detail.models.find(row => row.model === model)
  assert.deepEqual(detail.models.map(row => row.model).sort(), ['deepseek-v4', 'ghost-1', 'gpt-6.1-sol', 'minimax-m3', 'mystery-9', 'orphan-model'])

  assert.equal(rowOf('orphan-model').name, 'Orphan Model', 'a bare model ref resolves without a provider prefix')
  assert.deepEqual(rowOf('orphan-model').providers, [])

  assert.equal(rowOf('gpt-6.1-sol').name, 'GPT 6.1 Sol', 'the first serving provider decides the label')
  assert.deepEqual(rowOf('gpt-6.1-sol').providers, ['GitHub Models', 'LinuxDO'], 'every serving provider is listed, first-seen order')
  assert.equal(rowOf('gpt-6.1-sol').requests, 2)

  assert.equal(rowOf('minimax-m3').name, 'MiniMax M3')
  assert.deepEqual(rowOf('minimax-m3').providers, ['Group'], 'the listProviders label wins over the configurable displayName')

  assert.equal(rowOf('mystery-9').name, 'Mystery Nine', 'a rejected route falls back to the selector catalog')
  assert.deepEqual(rowOf('mystery-9').providers, ['Gone'])

  assert.ok(!('name' in rowOf('ghost-1')), 'unknown routes keep the raw id as their label')
  assert.deepEqual(rowOf('ghost-1').providers, ['ghost'], 'unknown providers fall back to the raw provider id')

  // Two route ids sharing one display name stay separate rows (the gray
  // provider tag disambiguates them client-side).
  assert.equal(rowOf('deepseek-v4').name, 'GPT 6.1 Sol')
  assert.notEqual(rowOf('deepseek-v4'), rowOf('gpt-6.1-sol'))
  assert.deepEqual(rowOf('deepseek-v4').providers, ['DeepSeek'])
})

test('without an llm service model rows fall back to raw route ids', async () => {
  const detail = await buildSessionUsageDetail(persistence, undefined, 'root')
  const rowOf = model => detail.models.find(row => row.model === model)
  assert.ok(detail.models.every(row => !('name' in row)))
  assert.equal(rowOf('gpt-6.1-sol').model, 'gpt-6.1-sol')
  assert.deepEqual(rowOf('gpt-6.1-sol').providers, ['github', 'linuxdo'], 'provider ids stay as labels')
})
