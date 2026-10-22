import assert from 'node:assert/strict'
import test from 'node:test'
import { contextBreakdownSegments, contextOccupancy, formatContextTokens } from '../src/client/context-meter-core.ts'

test('context occupancy keeps native projected-token priority and clamps at 100%', () => {
  assert.deepEqual(contextOccupancy({ projectedTokens: 120, pressureTokens: 90, contextWindow: 100 }), { percent: 100, usedTokens: 120, contextWindow: 100 })
  assert.deepEqual(contextOccupancy({ pressureTokens: 20, contextWindow: 100 }), { percent: 20, usedTokens: 20, contextWindow: 100 })
  assert.equal(contextOccupancy({ projectedTokens: 20 }), null)
})

test('context breakdown segments preserve the native three-bucket proportions', () => {
  assert.deepEqual(contextBreakdownSegments(50, { systemTokens: 20, toolsTokens: 30, messageTokens: 50 }), [
    { key: 'systemTokens', width: 10 }, { key: 'toolsTokens', width: 15 }, { key: 'messageTokens', width: 25 },
  ])
  assert.deepEqual(contextBreakdownSegments(34, undefined), [{ key: 'total', width: 34 }])
})

test('context meter formatting follows the host thresholds', () => {
  const units = { thousand: '{value}K', million: '{value}M' }
  assert.equal(formatContextTokens(999, units), '999')
  assert.equal(formatContextTokens(1_250, units), '1.3K')
  assert.equal(formatContextTokens(2_500_000, units), '2.5M')
})
