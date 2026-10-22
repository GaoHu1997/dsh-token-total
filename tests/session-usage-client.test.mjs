import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import test from 'node:test'
import { billedTotal, combinedTotals, sessionUsageForDisplay } from '../src/client/session-usage-core.ts'

const zeros = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const main = { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 }
const child = { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 }
const tree = { self: main, subagents: child, total: combinedTotals({ self: main, subagents: child }), subagentSessions: 2 }

test('display sums all four tree buckets without replacing root spend with native usage', () => {
  const native = { ...main, outputTokens: 50 }
  const display = sessionUsageForDisplay(native, tree)
  assert.deepEqual(display.self, main)
  assert.deepEqual(display.total, { uncachedInputTokens: 1100, outputTokens: 220, cacheReadTokens: 3300, cacheWriteTokens: 440 })
  assert.equal(billedTotal(display.total), billedTotal(display.self) + billedTotal(display.subagents))
  assert.equal(display.subagentSessions, 2)
})

test('pending tree uses native main, missing native uses logs, delegated-only still has tokens', () => {
  assert.equal(billedTotal(sessionUsageForDisplay(main, null).total), 460)
  assert.deepEqual(sessionUsageForDisplay(undefined, tree).total, tree.total)
  assert.equal(billedTotal(sessionUsageForDisplay(zeros(), tree).total), 5060)
  assert.equal(billedTotal(sessionUsageForDisplay(undefined, null).total), 0)
})

test('root compaction is already included in tree.self and never added twice', () => {
  const compaction = { uncachedInputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17 }
  const own = { uncachedInputTokens: 107, outputTokens: 31, cacheReadTokens: 313, cacheWriteTokens: 57 }
  const compacted = { ...tree, self: own, selfCompaction: compaction, total: combinedTotals({ self: own, subagents: child }) }
  const displayed = sessionUsageForDisplay(main, compacted)
  assert.deepEqual(displayed.self, own)
  assert.deepEqual(displayed.total, compacted.total)
  assert.deepEqual(sessionUsageForDisplay(undefined, compacted).total, compacted.total)
  assert.equal(billedTotal(displayed.total), billedTotal(main) + billedTotal(compaction) + billedTotal(child))
})

test('incomplete native usage cannot hide failed-attempt and legacy spend recorded by the tree', () => {
  const incomplete = { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  assert.deepEqual(sessionUsageForDisplay(incomplete, tree).total, tree.total)
  assert.deepEqual(sessionUsageForDisplay(zeros(), tree).total, tree.total)
})

test('native fork-inherited history cannot inflate the root or compaction buckets', () => {
  const own = { uncachedInputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17 }
  const fork = { self: own, selfCompaction: own, subagents: child, total: combinedTotals({ self: own, subagents: child }), subagentSessions: 2 }
  const inheritedNative = { uncachedInputTokens: 10007, outputTokens: 20011, cacheReadTokens: 30013, cacheWriteTokens: 40017 }
  assert.deepEqual(sessionUsageForDisplay(inheritedNative, fork).total, fork.total)
  assert.deepEqual(sessionUsageForDisplay(inheritedNative, fork).self, own)
})

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = await readFile(new URL('../src/client/use-session-usage.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

// A minimal effect/state driver runs the actual hook, controlling requests and
// timer ticks rather than checking its source text or waiting four seconds.
function hookHarness() {
  const state = [], effects = [], refs = [], queue = []
  const timers = new Set()
  let cursor = 0
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useRef(initial) {
      const i = cursor++
      return refs[i] ??= { current: initial }
    },
    useEffect(effect, deps) {
      const i = cursor++
      if (!same(effects[i]?.deps, deps)) queue.push(() => {
        effects[i]?.cleanup?.()
        effects[i] = { deps, effect, cleanup: effect() }
      })
    },
  }
  const requests = []
  const fetchSessionUsage = id => new Promise((resolve, reject) => { requests.push({ id, resolve, reject }) })
  const sandbox = createContext({ exports: {}, setInterval: (callback) => { timers.add(callback); return callback }, clearInterval: callback => timers.delete(callback) })
  sandbox.require = name => {
    if (name === 'react') return react
    if (name === './api.ts') return { fetchSessionUsage }
    if (name === './session-usage-core.ts') return { combinedTotals }
    assert.fail(`unexpected dependency ${name}`)
  }
  runInContext(compiled, sandbox)
  const render = (id = 'root', signature = '0') => {
    cursor = 0
    const result = sandbox.exports.useSessionUsage(id, signature)
    while (queue.length) queue.shift()()
    return result
  }
  return {
    render, requests,
    tick: () => { for (const timer of timers) timer() },
    unmount: () => { for (const effect of effects) effect?.cleanup?.() },
    strictReplay: () => { for (const effect of effects) { if (effect) { effect.cleanup?.(); effect.cleanup = effect.effect() } } },
    timers,
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('polling starts even with zero descendants and discovers child-only changes', async () => {
  const h = hookHarness()
  assert.equal(h.render().tree, null)
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve({ self: main, subagents: zeros(), total: main, subagentSessions: 0 })
  await flush()
  assert.equal(h.render().tree.subagentSessions, 0)
  h.tick()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(tree)
  await flush()
  assert.equal(h.render().tree.subagentSessions, 2)
  h.unmount()
  assert.equal(h.timers.size, 0)
})

test('switching sessions immediately hides old totals and discards old responses', async () => {
  const h = hookHarness()
  h.render('a')
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.render('a').tree.subagentSessions, 2)
  h.tick() // request for a remains in flight
  assert.equal(h.render('b').tree, null)
  assert.equal(h.requests[2].id, 'b')
  h.requests[1].resolve(tree)
  await flush()
  assert.equal(h.render('b').tree, null)
  h.requests[2].resolve({ self: main, subagents: zeros(), total: main, subagentSessions: 0 })
  await flush()
  assert.equal(h.render('b').tree.subagentSessions, 0)
  h.unmount()
})

test('errors retain last good reading and signature refresh is serialized', async () => {
  const h = hookHarness()
  h.render()
  h.requests[0].resolve(tree)
  await flush()
  h.tick()
  h.render('root', '1')
  h.render('root', '2')
  assert.equal(h.requests.length, 2, 'no overlapping requests')
  h.requests[1].reject(new Error('network unavailable'))
  await flush()
  assert.equal(h.requests.length, 3, 'queued refresh runs after failure')
  assert.equal(h.render('root', '2').tree.subagentSessions, 2)
  h.requests[2].resolve(tree)
  await flush()
  h.unmount()
})

test('StrictMode setup replay restarts the initial request and ignores disposed request', async () => {
  const h = hookHarness()
  h.render()
  h.strictReplay()
  assert.equal(h.requests.length, 2)
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.render().tree, null)
  h.requests[1].resolve(tree)
  await flush()
  assert.equal(h.render().tree.subagentSessions, 2)
  h.unmount()
})
