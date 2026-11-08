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
function hookHarness(initialVisibility = 'visible') {
  const state = [], effects = [], refs = [], queue = []
  const timers = new Map(), visibilityListeners = new Set()
  let cursor = 0, timerId = 0, writes = 0
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], value => { writes++; state[i] = typeof value === 'function' ? value(state[i]) : value }]
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
  const fetchSessionUsage = (id, signal) => new Promise((resolve, reject) => { requests.push({ id, signal, resolve, reject }) })
  const document = {
    visibilityState: initialVisibility,
    addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); visibilityListeners.add(callback) },
    removeEventListener(name, callback) { assert.equal(name, 'visibilitychange'); visibilityListeners.delete(callback) },
  }
  const sandbox = createContext({
    exports: {}, document, AbortController,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  })
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
    render, requests, timers, visibilityListeners,
    get writes() { return writes },
    tick() { const scheduled = [...timers.values()]; timers.clear(); for (const timer of scheduled) timer.callback() },
    visibility(state) { document.visibilityState = state; for (const callback of [...visibilityListeners]) callback() },
    unmount: () => { for (const effect of effects) effect?.cleanup?.() },
    strictReplay: () => { for (const effect of effects) { if (effect) { effect.cleanup?.(); effect.cleanup = effect.effect() } } },
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
  assert.equal(h.requests[1].signal.aborted, true, 'the old session fetch is actually canceled')
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
  assert.equal(h.requests[0].signal.aborted, true)
  assert.equal(h.visibilityListeners.size, 1)
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.render().tree, null)
  h.requests[1].resolve(tree)
  await flush()
  assert.equal(h.render().tree.subagentSessions, 2)
  h.unmount()
})

test('initially hidden pages do not fetch or poll and resume with one immediate request', async () => {
  const h = hookHarness('hidden')
  h.render()
  h.render('root', '1')
  h.tick()
  assert.equal(h.requests.length, 0)
  assert.equal(h.timers.size, 0)
  h.visibility('visible')
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(tree)
  await flush()
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [4000])
  h.visibility('hidden')
  h.tick()
  h.render('root', '2')
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  h.unmount()
  assert.equal(h.visibilityListeners.size, 0)
})

test('hide-show cancels and detaches old requests without letting their finally touch the new request', async () => {
  const h = hookHarness()
  h.render()
  h.visibility('hidden')
  assert.equal(h.requests[0].signal.aborted, true)
  h.render('root', '1')
  assert.equal(h.requests.length, 1)
  h.visibility('visible')
  assert.equal(h.requests.length, 2, 'resume does not wait for an uncooperative canceled fetch')
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.render('root', '1').tree, null)
  assert.equal(h.timers.size, 0, 'old finally cannot install a timer')
  h.render('root', '2')
  assert.equal(h.requests.length, 2, 'old finally cannot clear the new pending request')
  h.requests[1].resolve({ self: main, subagents: zeros(), total: main, subagentSessions: 0 })
  await flush()
  assert.equal(h.requests.length, 3, 'one queued signature refresh follows the new request')
  h.requests[2].resolve(tree)
  await flush()
  assert.equal(h.render('root', '2').tree.subagentSessions, 2)
  assert.equal(h.timers.size, 1)
  h.unmount()
  assert.equal(h.timers.size, 0)
  assert.equal(h.visibilityListeners.size, 0)
})

test('slow responses do not accumulate timer retries and failures still schedule the next beat', async () => {
  const h = hookHarness()
  h.render()
  h.tick()
  h.tick()
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  h.requests[0].reject(new Error('network unavailable'))
  await flush()
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [4000])
  h.tick()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(tree)
  await flush()
  assert.equal(h.timers.size, 1)
  h.unmount()
})

test('identical responses avoid state writes but coverage, attribution, compaction and child count still update', async () => {
  const h = hookHarness()
  h.render()
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.writes, 1)
  h.tick()
  h.requests[1].resolve(structuredClone(tree))
  await flush()
  assert.equal(h.writes, 1)
  const partial = { ...tree, coverage: { complete: false, totalSessions: 4, readableSessions: 3, unreadableSessions: [{ sessionId: 'bad', reason: 'corrupt' }] } }
  const repaired = { ...partial, coverage: { complete: true, totalSessions: 4, readableSessions: 4, unreadableSessions: [] } }
  const moved = { ...repaired, self: { ...main, outputTokens: 21 }, subagents: { ...child, outputTokens: 199 } }
  const compacted = { ...moved, selfCompaction: { ...zeros(), outputTokens: 1 } }
  const moreChildren = { ...compacted, subagentSessions: 3 }
  let expectedWrites = 1
  for (const value of [partial, repaired, moved, compacted, moreChildren]) {
    h.tick()
    h.requests.at(-1).resolve(value)
    await flush()
    assert.equal(h.writes, ++expectedWrites)
    assert.equal(h.render().tree, value)
  }
  h.unmount()
})

test('equal amounts still publish for a different session and unmount aborts its pending fetch', async () => {
  const h = hookHarness()
  h.render('a')
  h.requests[0].resolve(tree)
  await flush()
  assert.equal(h.render('a').tree, tree)
  assert.equal(h.render('b').tree, null)
  h.requests[1].resolve(structuredClone(tree))
  await flush()
  assert.equal(h.render('b').tree.subagentSessions, 2)
  h.tick()
  const pending = h.requests[2]
  h.unmount()
  assert.equal(pending.signal.aborted, true)
  pending.resolve(tree)
  await flush()
  assert.equal(h.timers.size, 0)
  assert.equal(h.visibilityListeners.size, 0)
})

test('the real session API forwards fetch cancellation without changing its document-relative URL', async () => {
  const source = await readFile(new URL('../src/client/api.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const calls = []
  const sandbox = createContext({ exports: {}, fetch: async (url, options) => {
    calls.push({ url, options })
    return { json: async () => ({ ok: true, value: tree }) }
  } })
  runInContext(compiled, sandbox)
  const controller = new AbortController()
  assert.equal(await sandbox.exports.fetchSessionUsage('root', controller.signal), tree)
  assert.equal(calls[0].url, 'token-total/api/session')
  assert.equal(calls[0].options.signal, controller.signal)
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: 'root' })
  await sandbox.exports.fetchSessionUsage('root')
  assert.equal(calls[1].options.signal, undefined)
})
