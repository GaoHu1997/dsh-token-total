import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { cacheHitPercentPrecise } from '../src/client/stats-line-core.ts'

const source = await readFile(new URL('../src/client/stats-line-state.ts', import.meta.url), 'utf8')
const loadPrefs = (saved) => {
  const values = new Map([['dsh-token-total:stats-line', JSON.stringify(saved)]])
  const handlers = new Map()
  const sandbox = createContext({ window: {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    addEventListener: (name, fn) => handlers.set(name, fn),
  } })
  const script = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/export /g, '') + '\nglobalThis.state = statsLineState'
  runInContext(script, sandbox)
  return { state: sandbox.state, values, handlers }
}

test('legacy cachePrecision false/true is ignored, remaining preferences persist and sync', () => {
  for (const cachePrecision of [false, true]) {
    const { state, values, handlers } = loadPrefs({ cachePrecision, tokenDetail: true, streamThroughput: false })
    assert.equal('cachePrecision' in state, false)
    assert.equal('setCachePrecision' in state, false)
    assert.equal(state.tokenDetail, true)
    assert.equal(state.streamThroughput, false)
    let notified = 0
    const unsubscribe = state.subscribe(() => { notified++ })
    state.setStreamThroughput(true)
    assert.equal(notified, 1)
    assert.deepEqual(JSON.parse(values.get('dsh-token-total:stats-line')), { tokenDetail: true, streamThroughput: true })
    // Only a retired precision value changes: no false preference change notification.
    values.set('dsh-token-total:stats-line', JSON.stringify({ cachePrecision: !cachePrecision, tokenDetail: true, streamThroughput: true }))
    handlers.get('storage')({ key: 'dsh-token-total:stats-line' })
    assert.equal(notified, 1)
    values.set('dsh-token-total:stats-line', JSON.stringify({ tokenDetail: false, streamThroughput: true }))
    handlers.get('storage')({ key: 'dsh-token-total:stats-line' })
    assert.equal(state.tokenDetail, false)
    assert.equal(notified, 2)
    unsubscribe()
  }
})

test('cache precision always formats two decimals including full hits', () => {
  const usage = (miss, hit) => ({ uncachedInputTokens: miss, cacheReadTokens: hit, cacheWriteTokens: 0, outputTokens: 99 })
  assert.equal(cacheHitPercentPrecise(usage(1, 2)), '66.67')
  assert.equal(cacheHitPercentPrecise(usage(0, 2)), '100.00')
  assert.equal(cacheHitPercentPrecise(usage(2, 0)), '0.00')
  assert.equal(cacheHitPercentPrecise(usage(1, 100000)), '99.99')
  assert.equal(cacheHitPercentPrecise(usage(0, 0)), null)
})

test('both composer layouts use unconditional precision; panel removes precision and rebuild controls', async () => {
  const pill = await readFile(new URL('../src/client/StatsLineEnhanced.tsx', import.meta.url), 'utf8')
  const panel = await readFile(new URL('../src/client/TokenTotalPanel.tsx', import.meta.url), 'utf8')
  const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  assert.match(pill, /const cacheHit = cacheHitPercentPrecise\(billed\)/)
  assert.doesNotMatch(pill, /cachePrecision|cacheHitPercent\(/)
  assert.doesNotMatch(panel, /cachePrecision|rebuildStats|onRebuild|rebuildTimer|confirmRebuild/)
  assert.doesNotMatch(locales, /cachePrecision|rebuildConfirm|rebuildDesc|rebuilding/)
  assert.match(panel, /const name = m\.model/)
  assert.match(panel, /m\.providers \?\? \[m\.provider\]/)
  assert.match(panel, /useState(?:<string>)?\('today'\)/)
  assert.match(panel, /t\('usageRanking'\)/)
})
