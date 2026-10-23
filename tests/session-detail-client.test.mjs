import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { usageEn, usageZh, usageZhTW } from '../src/client/session-usage-locales.ts'
import { billedTotal, cacheHitPercentOf } from '../src/client/session-usage-core.ts'
import { formatCompact, formatTokens } from '../src/client/format.ts'
import { normalizeModelName } from '../src/shared.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const hookCode = await compile('../src/client/use-session-detail.ts')
const viewCode = await compile('../src/client/SessionUsageView.tsx')

function hookHarness() {
  const state = [], effects = [], refs = [], queue = [], requests = [], timers = new Set(), listeners = new Map()
  let cursor = 0
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial } },
    useEffect(effect, deps) { const i = cursor++; if (!same(effects[i]?.deps, deps)) queue.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, effect, cleanup: effect() } }) },
  }
  const document = { visibilityState: 'visible', addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) } }
  const sandbox = createContext({ exports: {}, AbortController, document, setTimeout: fn => { timers.add(fn); return fn }, clearTimeout: fn => timers.delete(fn) })
  sandbox.require = name => name === 'react' ? react : name === './api.ts' ? { fetchSessionDetail: (id, signal) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject })) } : assert.fail(name)
  runInContext(hookCode, sandbox)
  return {
    requests, timers, listeners,
    render(id = 'root') { cursor = 0; const result = sandbox.exports.useSessionDetail(id); while (queue.length) queue.shift()(); return result },
    tick() { for (const fn of [...timers]) { timers.delete(fn); fn() } },
    unmount() { for (const effect of effects) effect?.cleanup?.() },
    strictReplay() { for (const effect of effects) if (effect) { effect.cleanup?.(); effect.cleanup = effect.effect() } },
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const detail = { sessionId: 'root', requests: 2 }

test('Usage detail starts immediately, serializes retries, preserves good data on failure', async () => {
  const h = hookHarness()
  assert.equal(h.render().loading, true)
  assert.equal(h.requests.length, 1)
  h.render().retry()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(detail); await flush()
  assert.equal(h.render().detail, detail)
  h.tick()
  h.requests[1].reject(new Error('network')); await flush()
  assert.equal(h.render().error, true)
  assert.equal(h.render().detail, detail)
  h.render().retry()
  assert.equal(h.requests.length, 3)
  h.unmount()
  assert.equal(h.requests[2].signal.aborted, true)
  assert.equal(h.timers.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('Usage detail switching hides old result immediately and aborts the old request', async () => {
  const h = hookHarness()
  h.render('a'); h.requests[0].resolve({ sessionId: 'a' }); await flush()
  assert.equal(h.render('a').detail.sessionId, 'a')
  h.tick()
  assert.equal(h.render('b').detail, null)
  assert.equal(h.requests[1].signal.aborted, true)
  h.requests[1].resolve({ sessionId: 'a' }); await flush()
  assert.equal(h.render('b').detail, null)
  h.requests[2].resolve({ sessionId: 'b' }); await flush()
  assert.equal(h.render('b').detail.sessionId, 'b')
  h.unmount()
})

test('Usage detail StrictMode replay cleans up and discards disposed answers', async () => {
  const h = hookHarness()
  h.render(); h.strictReplay()
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0].signal.aborted, true)
  h.requests[0].resolve(detail); await flush()
  assert.equal(h.render().detail, null)
  h.requests[1].resolve(detail); await flush()
  assert.equal(h.render().detail, detail)
  h.unmount()
})

test('Usage dictionaries have matching keys and cache writes are in the denominator', () => {
  assert.deepEqual(Object.keys(usageZh).sort(), Object.keys(usageEn).sort())
  assert.deepEqual(Object.keys(usageZh).sort(), Object.keys(usageZhTW).sort())
  assert.equal(cacheHitPercentOf({ uncachedInputTokens: 10, outputTokens: 999, cacheReadTokens: 30, cacheWriteTokens: 10 }), 60)
})

const fixture = {
  sessionId: 'root', requests: 2,
  totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 },
  averageFirstTokenMs: null, tokensPerSecond: null,
  subagents: [{ sessionId: 'child', name: 'A very long full subagent session name that must have a tooltip', requests: 1, totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, averageFirstTokenMs: null, tokensPerSecond: null }],
  models: [
    { model: 'model-with-a-long-name', name: 'GPT 6.1 sol', providers: ['GitHub Models', 'Azure'], requests: 2, totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 } },
    // Same display name after normalization (case/word separators), other route id.
    { model: 'another-id', name: 'gpt 6.1-sol', providers: ['LinuxDO'], requests: 1, totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    // Unresolvable route: no display name, falls back to the raw id.
    { model: 'bare-id-row', requests: 1, totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    { model: 'unique-name-row', name: 'DeepSeek V4 Flash', providers: ['GitHub Models'], requests: 1, totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
  ],
  routes: [{ id: 'p/m', provider: 'p', name: 'Provider', model: 'm', status: 'idle' }],
  records: [
    { id: 'root:1:1', sessionId: 'root', sessionName: 'Root', turn: 1, step: 1, startedAt: 10, finishedAt: 20, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 }, firstTokenMs: 3000, tokensPerSecond: 42, turnName: 'Fix the login bug', effort: 'high' },
    { id: 'root:1:2', sessionId: 'root', sessionName: 'Root', turn: 1, step: 2, startedAt: 30, finishedAt: 40, provider: 'p', model: 'm', status: 'failed', totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Fix the login bug', effort: '' },
    { id: 'root:2:1', sessionId: 'root', sessionName: 'Root', turn: 2, step: 1, startedAt: 50, finishedAt: 60, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Add regression tests', effort: '' },
    { id: 'child:1:1', sessionId: 'child', sessionName: 'A very long full subagent session name that must have a tooltip', turn: 1, step: 1, startedAt: 15, finishedAt: 25, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Subagent turn topic', effort: '' },
  ],
}
function viewHarness() {
  const state = []
  let cursor = 0
  const css = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  const jsx = (type, props = {}, key) => typeof type === 'function' ? type(props) : { type, props, key }
  const sandbox = createContext({ exports: {} })
  sandbox.require = name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === 'react') return { useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] } }
    if (name === './session-usage-core.ts') return { billedTotal, cacheHitPercentOf }
    if (name === './format.ts') return { formatCompact, formatTokens, normalizeModelName }
    if (name === './SessionUsageView.module.css') return { __esModule: true, default: css }
    if (name === './session-usage-locales.ts') return { SESSION_USAGE_NS: 'sessionUsage' }
    if (name === './use-session-detail.ts') return { useSessionDetail: () => ({ detail: fixture, loading: false, error: false, retry() {} }) }
    assert.fail(name)
  }
  runInContext(viewCode, sandbox)
  return () => { cursor = 0; return sandbox.exports.SessionUsageContent({ detail: fixture, t: key => usageZh[key] }) }
}
function nodes(root) {
  if (root == null || typeof root !== 'object') return []
  if (Array.isArray(root)) return root.flatMap(nodes)
  return [root, ...nodes(root.props?.children)]
}
test('Usage request log folds by turn: groups start collapsed, toggle, and expand/collapse all', () => {
  const render = viewHarness()
  let tree = render(), all = nodes(tree)
  // root turn 1, root turn 2, child turn 1 → 3 collapsible turn groups
  const groupButtons = () => nodes(render()).filter(n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(groupButtons().length, 3)
  assert.ok(groupButtons().every(n => n.props['aria-expanded'] === false), 'turn groups start collapsed')
  assert.ok(all.some(n => n.props?.hidden === true))
  // each turn group holds its own requests (root turn 1 = 2)
  all = nodes(render())
  const group0 = () => groupButtons()[0]
  group0().props.onClick()
  assert.equal(groupButtons()[0].props['aria-expanded'], true)
  assert.equal(groupButtons()[1].props['aria-expanded'], false, 'other groups stay closed')
  const expandAll = all.find(n => n.type === 'button' && n.props.className === 'action')
  expandAll.props.onClick(); all = nodes(render())
  assert.ok(groupButtons().every(n => n.props['aria-expanded'] === true))
  nodes(render()).find(n => n.type === 'button' && n.props.className === 'action').props.onClick()
  assert.ok(groupButtons().every(n => n.props['aria-expanded'] === false))
  assert.ok(all.some(n => n.props?.title === fixture.subagents[0].name))
  assert.ok(all.some(n => n.props?.title === '4,600'))
  assert.ok(!all.some(n => String(n.props?.className ?? '').includes('activity')), 'request activity section is removed')
  // turn groups carry a concrete name (first user prompt of the turn), not "轮 N"
  assert.ok(all.some(n => n.props?.title === 'Fix the login bug'), 'turn topic appears as the group name tooltip')
  assert.ok(all.some(n => n.props?.title === 'Add regression tests'))
  assert.ok(!all.some(n => String(n.props?.className ?? '').includes('turnTopic') && String(n.props?.children ?? '').includes('轮')), 'named turns never fall back to 轮 N')
  // effort badge renders on requests that carry a reasoning effort
  assert.ok(all.some(n => n.props?.className === 'effort'), 'effort badge is rendered')
  // request rows are one line: the metrics are the last cell of the row itself
  assert.ok(all.some(n => n.props?.className === 'recordMeta'), 'metrics line exists for finished requests')
  assert.ok(!all.some(n => n.props?.className === 'requestBody'), 'metrics no longer sit on a second line under the head')
  const requestRows = all.filter(n => n.props?.className === 'turnRequest')
  assert.ok(requestRows.length > 0, 'request rows render')
  for (const row of requestRows) {
    const cells = [row.props.children].flat(Infinity).filter(Boolean)
    assert.equal(cells.at(-1).props?.className, 'recordMeta', 'metrics are the row end cell')
    assert.equal(cells[1].props?.className, 'turnRequestHead', 'what answered keeps the middle of the row')
  }
  assert.ok(all.some(n => String(n.props?.children ?? '').includes('首字耗时 3 秒')), 'meta line keeps first-token timing')
  assert.ok(all.some(n => String(n.props?.children ?? '').includes('42 token/秒')), 'meta line keeps throughput')
  assert.ok(!all.some(n => n.props?.className === 'recordFacts'), 'old fact grid is replaced by the row-end metrics')
})

test('By-model card labels rows with model display names and gray providers on name collisions', () => {
  const render = viewHarness()
  const all = nodes(render())
  // Display name renders; the raw model id stays as the tooltip / fallback.
  const nameOf = id => all.find(n => n.type === 'span' && n.props?.title === id && n.props?.className === 'ellipsis')
  assert.equal(nameOf('model-with-a-long-name')?.props.children, 'GPT 6.1 sol')
  assert.equal(nameOf('another-id')?.props.children, 'gpt 6.1-sol', 'same display name shows even from another route id')
  assert.equal(nameOf('bare-id-row')?.props.children, 'bare-id-row', 'unresolved rows fall back to the raw id')
  assert.equal(nameOf('unique-name-row')?.props.children, 'DeepSeek V4 Flash')
  // Gray provider labels appear only for the two rows sharing one display name
  // (case/word separators normalized together), never for unique names.
  const gray = all.filter(n => n.type === 'small' && n.props?.className === 'modelProvider')
  assert.deepEqual(gray.map(n => n.props.children), ['GitHub Models / Azure', 'LinuxDO'], 'only colliding names get a provider label')
  assert.deepEqual(gray.map(n => n.props.title), ['GitHub Models / Azure', 'LinuxDO'], 'tooltip lists every provider that served the model')
})
