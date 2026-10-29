import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { usageEn, usageZh, usageZhTW } from '../src/client/session-usage-locales.ts'
import { billedTotal, cacheHitPercentOf } from '../src/client/session-usage-core.ts'
import { cacheRate, decodeRateOf, formatCompact, formatPercent, formatTokens } from '../src/client/format.ts'
import * as contextWindowCore from '../src/client/context-window-core.ts'
import * as usageBuckets from '../src/usage-buckets.ts'
import { normalizeModelName } from '../src/shared.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const hookCode = await compile('../src/client/use-session-detail.ts')
const viewCode = await compile('../src/client/SessionUsageView.tsx')
const panelCode = await compile('../src/client/ContextWindowPanel.tsx')
const cardsCode = await compile('../src/client/UsageCards.tsx')

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
  h.render().refresh()
  assert.equal(h.requests.length, 1, 'a refresh click during an in-flight read is absorbed')
  h.requests[0].resolve(detail); await flush()
  assert.equal(h.render().detail, detail)
  h.tick()
  h.requests[1].reject(new Error('network')); await flush()
  assert.equal(h.render().error, true)
  assert.equal(h.render().detail, detail)
  h.render().refresh()
  assert.equal(h.requests.length, 3)
  h.unmount()
  assert.equal(h.requests[2].signal.aborted, true)
  assert.equal(h.timers.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('Usage detail manual refresh refetches now when idle, right after the in-flight poll when busy', async () => {
  const h = hookHarness()
  h.render(); h.requests[0].resolve(detail); await flush()
  assert.ok(h.render().updatedAt !== null, 'updatedAt stamps the last successful read')
  // idle: a refresh click fires a request immediately
  h.render().refresh()
  assert.equal(h.requests.length, 2)
  // mid-poll: the click is remembered and refetches right after the answer lands
  h.render().refresh()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(detail); await flush()
  h.tick()
  assert.equal(h.requests.length, 3)
  const stamp = h.render().updatedAt
  // a failed refresh keeps the previous data and its stamp
  h.requests[2].reject(new Error('network')); await flush()
  assert.equal(h.render().detail, detail)
  assert.equal(h.render().updatedAt, stamp)
  h.unmount()
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
  averageFirstTokenMs: null, tokensPerSecond: 95.98,
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
    { id: 'root:1:1', sessionId: 'root', sessionName: 'Root', turn: 1, step: 1, startedAt: 10, finishedAt: 20, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 }, firstTokenMs: 3000, decodeMs: 1000, tokensPerSecond: 42, turnName: 'Fix the login bug', effort: 'high' },
    { id: 'root:1:2', sessionId: 'root', sessionName: 'Root', turn: 1, step: 2, startedAt: 30, finishedAt: 40, provider: 'p', model: 'm', status: 'failed', totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Fix the login bug', effort: 'high' },
    { id: 'root:2:1', sessionId: 'root', sessionName: 'Root', turn: 2, step: 1, startedAt: 50, finishedAt: 60, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Add regression tests', effort: '' },
    { id: 'child:1:1', sessionId: 'child', sessionName: 'A very long full subagent session name that must have a tooltip', turn: 1, step: 1, startedAt: 15, finishedAt: 25, provider: 'p', model: 'm', status: 'completed', totals: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }, firstTokenMs: null, tokensPerSecond: null, turnName: 'Subagent turn topic', effort: '' },
  ],
}
function viewHarness(override) {
  const detail = override ?? fixture
  const state = []
  let cursor = 0
  const css = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  const jsx = (type, props = {}, key) => typeof type === 'function' ? type(props) : { type, props, key }
  const sandbox = createContext({ exports: {} })
  sandbox.require = name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === 'react') return { useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] } }
    if (name === './session-usage-core.ts') return { billedTotal, cacheHitPercentOf }
    if (name === './format.ts') return { formatCompact, formatTokens, normalizeModelName, decodeRateOf }
    if (name === './SessionUsageView.module.css') return { __esModule: true, default: css }
    if (name === './session-usage-locales.ts') return { SESSION_USAGE_NS: 'sessionUsage' }
    if (name === './use-session-detail.ts') return { useSessionDetail: () => ({ detail, loading: false, error: false, refresh() {}, updatedAt: 1 }) }
    if (name === './ModelLogo.tsx') return { ModelLogo: props => ({ type: 'svg', props: { className: props.className, 'data-model': props.model, 'data-name': props.name } }) }
    // The live cards have their own harness below; here the view only has to
    // place them (and keep them out when the host sent neither a snapshot nor
    // a spend composition).
    if (name === './UsageCards.tsx') return { SessionUsageCards: props => props.detail.context || props.detail.composition ? { type: 'section', props: { 'data-usage-cards': true, 'data-items': props.detail.context?.items.length ?? 0, 'data-composition': props.detail.composition?.buckets.length ?? 0 } } : null }
    assert.fail(name)
  }
  runInContext(viewCode, sandbox)
  return () => { cursor = 0; return sandbox.exports.SessionUsageContent({ detail, t: key => usageZh[key], updatedAt: 1_730_000_000_000 }) }
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
  // each turn group holds its own requests (first group = root turn 2, 1 request)
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
  // Newest first everywhere: turn groups order by their most recent request
  // (turn 2 at 50, turn 1 at 30, child at 15) and, inside a turn, the newest
  // request comes first (root turn 1 reverses its two steps).
  assert.deepEqual(requestRows.map(row => row.key), ['root:2:1', 'root:1:2', 'root:1:1', 'child:1:1'])
  // The status label trails the thinking-level badge: the row reads
  // route → effort → status ("· high 失败"), never status before effort.
  // Spread first: nodes() may return a vm-realm array whose prototype
  // deepStrictEqual would reject against a host-realm literal.
  const statusCells = nodes(requestRows.find(row => row.key === 'root:1:2').props.children).filter(n => n.props?.className === 'effort' || n.props?.className === 'bad')
  assert.deepEqual([...statusCells.map(n => n.props.className)], ['effort', 'bad'], 'effort badge renders before the status text')
  assert.ok(all.some(n => n.type === 'svg' && n.props['data-model'] === 'm'), 'each request row leads with its model logo')
  for (const row of requestRows) {
    const cells = [row.props.children].flat(Infinity).filter(Boolean)
    assert.equal(cells.at(-1).props?.className, 'recordMeta', 'metrics are the row end cell')
    assert.equal(cells[1].props?.className, 'turnRequestHead', 'what answered keeps the middle of the row')
  }
  assert.ok(all.some(n => String(n.props?.children ?? '').includes('首字耗时 3 秒')), 'meta line keeps first-token timing')
  assert.ok(all.some(n => String(n.props?.children ?? '').includes('42 token/秒')), 'meta line keeps throughput')
  // The turn summary and the card fold decode windows instead of averaging the
  // per-request rates (the failed row has no window: 200 tokens / 1.0 s). The
  // newest-first turn order puts the window-less turn 2 on top, so match the
  // folding group's summary instead of the first one.
  const turnRates = all.filter(n => Array.isArray(n.props?.children) && n.props.children[0] === '平均速率')
  const folded = turnRates.find(n => n.props.children[2] === 200)
  assert.deepEqual([...folded.props.children], ['平均速率', ' ', 200, ' ', 'token/秒'], 'turn rate divides by decode windows')
  assert.ok(all.some(n => n.props?.className === 'statValue' && n.props.children === '96 tok/s'), 'the card speed is the same decode rate')
  assert.ok(!all.some(n => String(n.props?.children ?? '').includes('42 token/秒') && String(n.props?.className ?? '') === 'statValue'), 'the card never shows a per-request rate')
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
  // Every model row leads with its brand logo (the stub tags it data-model);
  // record rows also render logos, so scope this to the by-model name cells.
  // The matcher receives the row's display name too, so an opaque route id
  // beside a brandful label still shows that brand's mark.
  for (const { model, name } of fixture.models) {
    const cell = all.find(n => n.props?.className === 'modelNameCell' && nodes(n).some(c => c.type === 'svg' && c.props['data-model'] === model))
    assert.ok(cell, `model row for ${model} leads with its brand logo`)
    assert.ok(nodes(cell).some(c => c.props?.className === 'ellipsis' && c.props?.title === model))
    const logo = nodes(cell).find(c => c.type === 'svg')
    assert.equal(logo.props['data-name'], name, `logo matcher receives the display name for ${model}`)
  }
})

// ── context-window panel ──────────────────────────────────────────────────
const panelItems = [
  { key: 'system:system-prompt', category: 'system', kind: 'system-prompt', label: '', count: 1, tokens: 4_500 },
  { key: 'tools:acp_cache', category: 'tools', label: 'acp_cache', count: 1, tokens: 1_900 },
  { key: 'tools:rest', category: 'tools', kind: 'rest', label: '', count: 20, tokens: 9_800 },
  { key: 'memory:runtime-context', category: 'memory', kind: 'runtime-context', label: '', count: 1, tokens: 419 },
  { key: 'files:wire', category: 'files', label: 'D:\\repo\\src\\wire.ts', count: 2, tokens: 4_700 },
  { key: 'results:pwsh', category: 'results', label: 'pwsh', count: 63, tokens: 11_800 },
  { key: 'conversation:user', category: 'conversation', kind: 'user', label: '', count: 3, tokens: 6_000 },
  { key: 'conversation:assistant', category: 'conversation', kind: 'assistant', label: '', count: 3, tokens: 8_100 },
]
const panelTotal = panelItems.reduce((sum, item) => sum + item.tokens, 0)
const contextFixture = {
  totalTokens: panelTotal, contextWindow: 262_144, provider: 'group', model: 'glm-5.3',
  cacheHitTokens: 40_000, cacheMissTokens: 10_000, cacheKnown: true, items: panelItems,
}
/** The reference card's own figures: eight buckets over a 1.5M billed prompt. */
const compositionFixture = {
  buckets: [
    { key: 'systemPrompt', tokens: 299_100 },
    { key: 'user', tokens: 1_900 },
    { key: 'skill', tokens: 58_000 },
    { key: 'toolResult', tokens: 492_900 },
    { key: 'toolDef', tokens: 18_500 },
    { key: 'injected', tokens: 14_400 },
    { key: 'assistant', tokens: 581_400 },
    { key: 'output', tokens: 23_000 },
  ],
  billedTokens: 1_489_200,
  totals: { uncachedInputTokens: 42_000, outputTokens: 23_000, cacheReadTokens: 1_424_200, cacheWriteTokens: 0 },
  requests: 37,
}
const panelT = (key, params) => String(usageZh[key]).replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? '')
function panelHarness(context = contextFixture, panelProps = {}) {
  const state = []
  const refs = []
  let cursor = 0
  let dirty = false
  const css = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  const jsx = (type, props = {}, key) => typeof type === 'function' ? type(props) : { type, props, key }
  // A measured host box: the treemap needs pixels, so the ref hands out a stub.
  const host = { clientWidth: 640, clientHeight: 268, addEventListener() {}, removeEventListener() {} }
  const sandbox = createContext({
    exports: {},
    window: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  })
  sandbox.require = name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === 'react') return {
      useState(initial) {
        const i = cursor++
        if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
        return [state[i], value => {
          const next = typeof value === 'function' ? value(state[i]) : value
          if (!Object.is(next, state[i])) { state[i] = next; dirty = true }
        }]
      },
      useRef(initial) { const i = cursor++; if (refs[i] === undefined) refs[i] = { current: initial === null ? host : initial }; return refs[i] },
      useMemo(factory) { cursor++; return factory() },
      useLayoutEffect(effect) { cursor++; effect() },
    }
    if (name === './context-window-core.ts') return contextWindowCore
    if (name === './format.ts') return { cacheRate, formatCompact, formatPercent, formatTokens }
    if (name === './session-usage-locales.ts') return {}
    if (name === './ContextWindowPanel.module.css') return { __esModule: true, default: css }
    assert.fail(name)
  }
  runInContext(panelCode, sandbox)
  // Render to a fixpoint: the treemap measures its box in a layout effect, so
  // the first pass has no pixels yet — React would re-render, and so does this.
  return () => {
    let tree
    for (let pass = 0; pass < 6; pass++) {
      cursor = 0
      dirty = false
      tree = sandbox.exports.ContextWindowPanel({ context, t: panelT, ...panelProps })
      if (!dirty) break
    }
    return tree
  }
}
const classes = node => String(node.props?.className ?? '').split(/\s+/).filter(Boolean)
/** Every string a subtree renders, JSX-adjacent pieces glued back together. */
const textOf = root => nodes(root)
  .map(node => Array.isArray(node.props?.children) ? node.props.children.filter(piece => typeof piece === 'string').join('') : node.props?.children)
  .filter(value => typeof value === 'string')
  .join(' ')

/** Render the two live cards in a bare JSX sandbox; the pure helpers are the
 *  real modules, so this exercises the actual bucketing and formatting. */
function cardsHarness(detailOverride = { ...fixture, context: contextFixture, composition: compositionFixture }) {
  const css = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
  const jsx = (type, props = {}, key) => typeof type === 'function' ? type(props) : { type, props, key }
  const sandbox = createContext({ exports: {} })
  sandbox.require = name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === './context-window-core.ts') return contextWindowCore
    if (name === './format.ts') return { cacheRate, formatCompact, formatPercent, formatTokens }
    if (name === './session-usage-core.ts') return { cacheHitPercentOf }
    if (name === '../usage-buckets.ts') return usageBuckets
    if (name === './UsageCards.module.css') return { __esModule: true, default: css }
    assert.fail(name)
  }
  runInContext(cardsCode, sandbox)
  return () => sandbox.exports.SessionUsageCards({ detail: detailOverride, t: panelT })
}

test('the live cards pair the window composition with the session spend', () => {
  const all = nodes(cardsHarness()())
  assert.equal(all.filter(n => n.type === 'section').length, 2, 'both cards render side by side')
  assert.ok(all.some(n => n.type === 'h2' && n.props.children === usageZh.currentContextTitle))
  assert.ok(all.some(n => n.type === 'h2' && n.props.children === usageZh.statsTitle))
  // Left card: used over window, occupancy, and the model that owns it.
  const total = all.find(n => classes(n).includes('total'))
  assert.equal(total.props.children, `${formatCompact(panelTotal)} / 262.1K tokens`)
  assert.ok(all.some(n => n.props?.children === '18.0%'), 'the occupancy share is a whole percentage')
  assert.ok(textOf(all.find(n => classes(n).includes('totalShare'))).includes(usageZh.contextUsedShort))
  assert.ok(all.some(n => classes(n).includes('model') && n.props.children === 'group · glm-5.3'))
  // One bar segment per NON-EMPTY bucket (the fixture has no skill-catalog
  // row), and a 7-row legend — output never lives in the window, so it has no
  // row here.
  assert.equal(all.filter(n => classes(n).includes('barSeg')).length, 6)
  // The strip is scaled to the model's window, not to the drawn content: the
  // tinted run stops exactly where "used" stops and the track behind it is the
  // room still free — the same reading the folded panel's digest gives.
  const barSegs = all.filter(n => classes(n).includes('barSeg'))
  const painted = barSegs.reduce((sum, n) => sum + parseFloat(n.props.style.width), 0)
  const usedShare = panelTotal / 262_144 * 100
  assert.ok(Math.abs(painted - usedShare) < 0.001, 'the tinted run spans exactly the used share, not the whole track')
  const contextRows = all.filter(n => classes(n).includes('legendRow')).slice(0, 7)
  assert.deepEqual(contextRows.map(n => n.props.children[1].props.children), [
    usageZh.bucketSystemPrompt, usageZh.bucketUser, usageZh.bucketSkill, usageZh.bucketToolResult,
    usageZh.bucketToolDef, usageZh.bucketInjected, usageZh.bucketAssistant,
  ])
  // The context legend divides by what the window holds, not by the billed total.
  assert.ok(contextRows.some(n => textOf(n).includes('9.5%')), 'system prompt share')
  assert.ok(contextRows.some(n => textOf(n).includes('24.8%')), 'tool definitions keep their own bucket')
  assert.ok(contextRows.some(n => textOf(n).includes('34.9%')), 'file reads and tool results share one bucket')
  // Right card: the billed ring, eight legend rows, exact cache split.
  assert.ok(all.some(n => n.type === 'circle' && n.props.stroke === 'var(--bucket)'), 'the ring segments are drawn')
  assert.equal(all.filter(n => n.type === 'circle' && n.props.stroke === 'var(--bucket)').length, 8)
  assert.ok(all.some(n => n.type === 'strong' && classes(n).includes('ringTotal') && n.props.children === '1.5M'))
  assert.ok(all.some(n => n.type === 'b' && textOf(n) === '97.14%'), 'cache hit uses the exact usage split')
  const statsRows = all.filter(n => classes(n).includes('legendRow')).slice(7)
  assert.deepEqual(statsRows.map(n => n.props.children[1].props.children), [
    usageZh.bucketSystemPrompt, usageZh.bucketUser, usageZh.bucketSkill, usageZh.bucketToolResult,
    usageZh.bucketToolDef, usageZh.bucketInjected, usageZh.bucketAssistant, usageZh.bucketOutput,
  ])
  assert.ok(statsRows.some(n => textOf(n).includes('20.1%')), 'the reference card share')
  assert.ok(statsRows.some(n => textOf(n).includes(usageZh.statsIncludesThinking)), 'output says it includes thinking')
})

test('the cards degrade one at a time and hide themselves when both are empty', () => {
  // An older host payload can carry the window without the spend composition.
  let all = nodes(cardsHarness({ ...fixture, context: contextFixture, composition: null })())
  assert.equal(all.filter(n => n.type === 'section').length, 2, 'the left card still renders')
  assert.ok(all.some(n => classes(n).includes('empty') && n.props.children === usageZh.statsEmpty), 'the right card explains the gap')
  // And a log can hold spend without a replayable window.
  all = nodes(cardsHarness({ ...fixture, context: null, composition: compositionFixture })())
  assert.equal(all.filter(n => n.type === 'section').length, 1, 'only the spend card renders')
  assert.equal(cardsHarness({ ...fixture, context: null, composition: null })(), null, 'no data, no cards')
})

test('the live cards sit between the detail tables and the request records', () => {
  const without = nodes(viewHarness()())
  assert.ok(!without.some(n => n.props?.['data-usage-cards'] === true), 'no snapshot and no composition, no cards')
  const withContext = nodes(viewHarness({ ...fixture, context: contextFixture, composition: compositionFixture })())
  const cards = withContext.find(n => n.props?.['data-usage-cards'] === true)
  assert.ok(cards, 'the cards appear when the host sent a snapshot')
  assert.equal(cards.props['data-items'], panelItems.length)
  // Document order: the scope note and cards, then the subagent/model tables,
  // then the live cards, then the per-turn request records.
  const at = withContext.indexOf(cards)
  assert.ok(at > withContext.findIndex(n => n.props?.className === 'mid'), 'the cards follow the subagent/model tables')
  assert.ok(at < withContext.findIndex(n => n.props?.className === 'turnList'), 'the cards precede the request records')
})

test('the context-window panel reads the used total, the window and the prompt-cache split', () => {
  const all = nodes(panelHarness()())
  assert.ok(all.some(n => n.type === 'h2' && n.props.children === '上下文窗口'))
  assert.ok(all.some(n => n.props?.className === 'model' && n.props.children === 'group/glm-5.3'), 'the model is named with its provider')
  assert.ok(all.some(n => n.props?.className === 'livePill'), 'a live pill marks the panel as current')
  assert.ok(all.some(n => String(n.props?.children ?? '').includes('已用上下文')))
  assert.equal(all.find(n => n.props?.className === 'total').props.children[0], '47.2K')
  assert.equal(all.find(n => n.props?.className === 'window').props.children, '模型窗口 262.1K · 已用 18%')
  // Cache legends quote both halves of the newest answer's prompt.
  const legendText = textOf(all.filter(n => n.props?.className === 'cacheLegend'))
  assert.ok(legendText.includes('命中 80.0%'), `hit legend reads ${legendText}`)
  assert.ok(legendText.includes('未命中 20.0%'))
})

test('the treemap tiles every block with its size and category, and folds repeats', () => {
  const all = nodes(panelHarness()())
  const tiles = all.filter(n => classes(n).includes('tile'))
  assert.equal(tiles.length, panelItems.length)
  const text = tiles.map(textOf).join(' | ')
  assert.ok(text.includes('acp_cache'), 'a tool keeps its name')
  assert.ok(text.includes('pwsh ×63'), 'a repeated tool shows its call count')
  assert.ok(text.includes('用户消息 ×3'), 'a repeated message kind shows its count')
  assert.ok(text.includes('另外 20 项'), 'the folded tail is named')
  assert.ok(text.includes('D:\\repo\\src\\wire.ts'), 'a file block carries its path')
  assert.ok(text.includes('4.7K · 文件'), 'each tile quotes its size and category')
  // Every tile is tinted by its category, and the legend names all six.
  assert.ok(tiles.some(tile => classes(tile).includes('toneResults')))
  const legendRows = all.filter(n => n.props?.className === 'legend').flatMap(n => nodes(n))
  for (const name of ['系统提示词', '工具', '记忆', '文件', '工具结果', '会话内容']) {
    assert.ok(legendRows.some(n => n.props?.children === name), `legend names ${name}`)
  }
})

test('the panel collapses with balanced header padding and admits a cache it cannot see yet', () => {
  const context = { ...contextFixture, cacheKnown: false, cacheHitTokens: 0, cacheMissTokens: 0 }
  const render = panelHarness(context)
  let all = nodes(render())
  assert.ok(all.some(n => n.props?.className === 'cachePending' && n.props.children === '供应商回答可见'), 'an unanswered cache says so')
  assert.ok(!all.some(n => classes(n).includes('cacheHit')), 'no invented hit bar')
  const collapse = all.find(n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  collapse.props.onClick()
  all = nodes(render())
  assert.equal(all.find(n => n.props?.className === 'body').props.hidden, true, 'the body folds away')
  // Collapsed, the header pads its own bottom — the folded row keeps its shape.
  assert.ok(classes(all.find(n => n.type === 'header')).includes('headCollapsed'), 'the collapsed header balances its padding')
  all.find(n => n.type === 'button' && n.props['aria-expanded'] !== undefined).props.onClick()
  all = nodes(render())
  assert.equal(all.find(n => n.props?.className === 'body').props.hidden, false)
  assert.ok(!classes(all.find(n => n.type === 'header')).includes('headCollapsed'), 'expanded, the extra padding goes away')
  // The list view and its switcher are gone: the treemap is the only view.
  assert.ok(!all.some(n => classes(n).includes('item')), 'no list rows remain')
  assert.ok(!all.some(n => n.props?.['aria-pressed'] !== undefined), 'no view switcher remains')
})

test('folded, the header carries a live digest of what fills the window', () => {
  const render = panelHarness()
  let all = nodes(render())
  assert.ok(!all.some(n => classes(n).includes('digest')), 'expanded, the body speaks for itself')
  all.find(n => n.type === 'button' && n.props['aria-expanded'] !== undefined).props.onClick()
  all = nodes(render())
  assert.ok(all.some(n => classes(n).includes('digest')), 'the folded header summarizes the window')
  // The used figure leads, then the model window and the share it fills, so the
  // folded row answers "how full" before the strip answers "with what".
  const total = all.find(n => classes(n).includes('digestTotal'))
  const expectedDigest = usageZh.contextDigest
    .replace('{used}', formatCompact(panelTotal))
    .replace('{window}', '262.1K')
    .replace('{percent}', String(Math.round(panelTotal / 262_144 * 100)))
  assert.equal(total.props.children, expectedDigest)
  assert.ok(expectedDigest.startsWith(`${formatCompact(panelTotal)} / `), 'used over window comes first')
  assert.ok(String(total.props.title).includes(formatTokens(panelTotal)), 'the tooltip keeps the exact count')
  assert.ok(String(total.props.title).includes('262.1K'), 'the tooltip names the model window')
  // One segment per non-empty bucket, in legend order. The strip's whole length
  // is the model's window, so each segment takes its share of what is used,
  // times the share of the window in use — the grey track behind it is the room
  // still free, and the tinted part ends exactly where "used" ends.
  const categorySum = key => panelItems.filter(item => item.category === key).reduce((sum, item) => sum + item.tokens, 0)
  const usedShare = panelTotal / 262_144 * 100
  const expected = ['system', 'tools', 'memory', 'files', 'results', 'conversation']
    .map(key => ({ key, share: categorySum(key) / panelTotal * usedShare }))
    .filter(row => row.share > 0)
  const segs = all.filter(n => classes(n).includes('digestSeg'))
  assert.deepEqual(segs.map(n => n.props.style.width), expected.map(row => `${row.share}%`))
  const painted = segs.reduce((sum, n) => sum + parseFloat(n.props.style.width), 0)
  assert.ok(Math.abs(painted - usedShare) < 0.001, 'the tinted part spans exactly the used share, leaving the rest grey')
  assert.deepEqual(segs.map(n => classes(n)[1]), expected.map(row => `tone${row.key[0].toUpperCase()}${row.key.slice(1)}`), 'segments keep their category tint')
  const bar = all.find(n => classes(n).includes('digestBar'))
  for (const name of ['系统提示词', '工具', '记忆', '文件', '工具结果', '会话内容']) {
    assert.ok(String(bar.props['aria-label']).includes(name), `the digest names ${name}`)
  }
  // The grey tail is the free room, named in the same tooltip that names the
  // buckets, so "how much is left" is readable without opening the panel.
  assert.ok(String(bar.props['aria-label']).includes(`空闲 ${formatTokens(262_144 - panelTotal)} token`), 'the label names the free room')
  // The digest is a header-only view of the same snapshot: opening the panel
  // hides it again rather than duplicating the figures.
  all.find(n => n.type === 'button' && n.props['aria-expanded'] !== undefined).props.onClick()
  all = nodes(render())
  assert.ok(!all.some(n => classes(n).includes('digest')), 'expanded, the digest steps aside')
})

test('hovering a tile opens a tip with its exact figures and shares', () => {
  const render = panelHarness()
  let all = nodes(render())
  assert.ok(!all.some(n => n.props?.className === 'tip'), 'no tip before hovering')
  const slot = all.find(n => classes(n).includes('slot') && String(n.props?.['aria-label'] ?? '').startsWith('pwsh'))
  assert.ok(slot, 'the pwsh block has a tile')
  slot.props.onMouseEnter()
  all = nodes(render())
  const tip = all.find(n => n.props?.className === 'tip')
  assert.ok(tip, 'hovering opens the tip')
  const text = textOf(tip)
  assert.ok(text.includes('pwsh ×63'), 'the tip names the block and its count')
  assert.ok(text.includes('11,800 token'), 'the tip quotes the exact count')
  assert.ok(text.includes('工具结果'), 'the tip names the category')
  assert.ok(text.includes('占上下文 25.0%'), `the tip shares the estimate (${text})`)
  assert.ok(text.includes('占窗口 4.5%'), 'the tip shares the model window')
  all.find(n => n.props?.className === 'map').props.onMouseLeave()
  all = nodes(render())
  assert.ok(!all.some(n => n.props?.className === 'tip'), 'leaving the map closes the tip')
})

test('the live pill stamps the last refresh when the host sends one', () => {
  const stamped = nodes(panelHarness(contextFixture, { updatedAt: 1_730_000_000_000 })())
  assert.ok(textOf(stamped.filter(n => n.props?.className === 'livePill')).match(/\d{1,2}:\d{2}/), 'the pill carries a clock time')
  const bare = nodes(panelHarness()())
  assert.ok(!textOf(bare.filter(n => n.props?.className === 'livePill')).match(/\d{1,2}:\d{2}/), 'without a timestamp the pill stays plain')
})
