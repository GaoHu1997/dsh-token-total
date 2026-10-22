import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as core from '../src/client/stats-line-core.ts'
import * as sessionCore from '../src/client/session-usage-core.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const pillSource = await readFile(new URL('../src/client/StatsLineEnhanced.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(pillSource + '\nexport { UsagePill, TimePill }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText

// Exercise the actual shared pills without a browser. A retired preference
// must never be read, even if a previous installation explicitly disabled it.
const loadPills = (saved) => {
  const element = (type, props) => ({ type, props })
  const react = {
    memo: component => component,
    useMemo: read => read(),
    useState: initial => [initial, () => {}],
    useRef: value => ({ current: value }),
    useEffect: () => {},
    useLayoutEffect: () => {},
  }
  const sandbox = createContext({ exports: {}, window: {
    get localStorage() { assert.fail(`retired preferences accessed: ${JSON.stringify(saved)}`) },
  }, document: { body: {} } })
  sandbox.require = name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' }
    if (name === 'react-dom') return { createPortal: content => content }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconDatabaseOutline16: 'database', IconGaugeOutline16: 'gauge' }
    if (name === './stats-line-core.ts') return core
    if (name === './format.ts') return { formatTokens: String }
    if (name === './locales.ts') return { LOCALE_NS: 'tokenTotal' }
    if (name === './stat-dialog.ts') return {
      MEASURE_STYLE: {}, useStatDialog: () => ({ open: true, setOpen: () => {}, pos: {}, rootRef: {}, panelRef: {} }),
    }
    if (name === './session-usage-core.ts') return sessionCore
    if (name === './use-session-usage.ts') return {
      useSessionUsage: () => ({ tree: null, totals: null }),
    }
    if (name.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => key })
    assert.fail(`unexpected runtime dependency: ${name}`)
  }
  runInContext(compiled, sandbox)
  return sandbox.exports
}
const flatten = value => {
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (value === null || typeof value !== 'object') return []
  return [value, ...flatten(value.props?.children)]
}
const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key
const usage = { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 99 }

test('session breakdown and live speed stay enabled for legacy false/true settings in both dock layouts', () => {
  for (const enabled of [false, true]) {
    const pills = loadPills({ cachePrecision: enabled, tokenDetail: enabled, streamThroughput: enabled })
    for (const dock of [false, true]) {
      const nodes = flatten(pills.UsagePill({ usage, t, dock }))
      const missIndex = nodes.findIndex(node => node.type === 'dt' && node.props.children === 'stats.cacheMiss')
      assert.ok(missIndex >= 0, 'cache miss detail must render unconditionally')
      assert.equal(nodes[missIndex + 1].type, 'dd')
      assert.equal(nodes[missIndex + 1].props.children, 'message.turnUsage.count:{"count":"15"}')
      for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        assert.ok(nodes.some(node => node.type === 'dt' && node.props.children === `message.turnUsage.${key}`))
      }
      const stats = { turns: 1, steps: 1, llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 1000, decodeTokens: 50 }
      const timeNodes = flatten(pills.TimePill({ stats, t, dock, useChat: read => read({ legacy: { partial: null } }), scale: 1 }))
      const live = timeNodes.find(node => typeof node.type === 'function' && node.type.name === 'LiveSpeed')
      assert.ok(live, 'live speed child must always mount')
      assert.equal(live.props.fallback, 'stats.tokensPerSecond:{"throughput":"50"}')
      const settled = live.type(live.props)
      assert.equal(settled.props.text, live.props.fallback, 'settled/no-sample speed must use official reading')
    }
  }
})

test('usage pill and every dialog bucket share live main + descendants in both layouts', () => {
  const pills = loadPills({})
  const subagents = { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 }
  const staleSelf = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  const tree = { tree: { self: staleSelf, subagents, total: sessionCore.combinedTotals({ self: staleSelf, subagents }), subagentSessions: 12 } }
  for (const dock of [false, true]) {
    const nodes = flatten(pills.UsagePill({ usage, tree, t, dock }))
    const total = sessionCore.billedTotal(usage) + sessionCore.billedTotal(subagents)
    const button = nodes.find(node => node.type === 'button')
    assert.ok(button.props['aria-label'].includes(`"count":"${core.formatTokensCompact(total)}"`))
    const detail = key => {
      const index = nodes.findIndex(node => node.type === 'dt' && node.props.children === key)
      assert.ok(index >= 0, `missing ${key}`)
      return nodes[index + 1].props.children
    }
    assert.equal(detail('stats.dialog.main'), 'message.turnUsage.count:{"count":"134"}')
    assert.equal(detail('stats.dialog.treeTotal'), `message.turnUsage.count:{"count":"${total}"}`)
    assert.equal(detail('message.turnUsage.input'), 'message.turnUsage.count:{"count":"110"}')
    assert.equal(detail('message.turnUsage.cacheRead'), 'message.turnUsage.count:{"count":"320"}')
    assert.equal(detail('message.turnUsage.cacheWrite'), 'message.turnUsage.count:{"count":"405"}')
    assert.equal(detail('message.turnUsage.output'), 'message.turnUsage.count:{"count":"299"}')
  }
})

test('cache precision always formats two decimals including full hits', () => {
  const usage = (miss, hit) => ({ uncachedInputTokens: miss, cacheReadTokens: hit, cacheWriteTokens: 0, outputTokens: 99 })
  assert.equal(core.cacheHitPercentPrecise(usage(1, 2)), '66.67')
  assert.equal(core.cacheHitPercentPrecise(usage(0, 2)), '100.00')
  assert.equal(core.cacheHitPercentPrecise(usage(2, 0)), '0.00')
  assert.equal(core.cacheHitPercentPrecise(usage(1, 100000)), '99.99')
  assert.equal(core.cacheHitPercentPrecise(usage(0, 0)), null)
})

test('streaming sampler publishes measured growth and a new step starts without a reading', () => {
  const sampler = new core.StreamingRateSampler()
  assert.equal(sampler.ratePerSecond(), null)
  sampler.observe(100, 0)
  assert.equal(sampler.ratePerSecond(), null)
  sampler.observe(150, 1000)
  assert.equal(sampler.ratePerSecond(), 50)
  sampler.observe(150, 2000)
  assert.equal(sampler.ratePerSecond(), 50)
  assert.equal(new core.StreamingRateSampler().ratePerSecond(), null)
})

test('both composer layouts have no preference gates; panel has no enhancement or rebuild switches', async () => {
  const panel = await readFile(new URL('../src/client/TokenTotalPanel.tsx', import.meta.url), 'utf8')
  const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/client/TokenTotalPanel.module.css', import.meta.url), 'utf8')
  assert.match(pillSource, /const cacheHit = cacheHitPercentPrecise\(billed\)/)
  assert.doesNotMatch(pillSource, /cachePrecision|tokenDetail|streamThroughput|liveSpeed|stats-line-state|cacheHitPercent\(/)
  assert.doesNotMatch(panel, /cachePrecision|tokenDetail|streamThroughput|StatsLineOptions|SettingToggle|prefGroup|role="switch"|stats-line-state|rebuildStats|rebuildTimer/)
  assert.doesNotMatch(locales, /cachePrecision|tokenDetail|streamThroughput|rebuildConfirm|rebuilding/)
  assert.doesNotMatch(css, /\.prefGroup|\.prefRow|\.switchTrack|\.switchThumb/)
  assert.match(panel, /const name = m\.model/)
  assert.match(panel, /m\.providers \?\? \(m\.provider === '' \? \[\] : \[m\.provider\]\)/)
  assert.match(panel, /useState(?:<string>)?\('today'\)/)
  assert.match(panel, /t\('usageRanking'\)/)
})
