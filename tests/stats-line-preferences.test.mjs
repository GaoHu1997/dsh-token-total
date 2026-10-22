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
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconDatabaseOutlineRegular: 'database', IconGaugeOutlineRegular: 'gauge' }
    if (name === './stats-icons.tsx') return { DatabaseIcon: 'database', GaugeIcon: 'gauge' }
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
      // Native row set in native order: the takeover widens the TOTAL's scope,
      // not the breakdown, so there is no cache-miss row and no extra split.
      const keys = nodes.filter(node => node.type === 'dt').map(node => node.props.children)
      assert.deepEqual(keys, [
        'message.turnUsage.cacheHit',
        'message.turnUsage.input',
        'message.turnUsage.cacheRead',
        'message.turnUsage.cacheWrite',
        'message.turnUsage.output',
      ])
      assert.equal(nodes.findIndex(node => node.props.children === 'stats.cacheMiss'), -1)
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

test('usage pill and every dialog bucket share authoritative tree totals in both layouts', () => {
  const pills = loadPills({})
  const subagents = { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 }
  // Deliberately differ from native usage: the log owns retries, compaction
  // and inherited-prefix exclusion, and must drive both the pill and dialog.
  const self = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  const tree = { tree: { self, subagents, total: sessionCore.combinedTotals({ self, subagents }), subagentSessions: 12 } }
  for (const dock of [false, true]) {
    const nodes = flatten(pills.UsagePill({ usage, tree, t, dock }))
    const total = sessionCore.billedTotal(self) + sessionCore.billedTotal(subagents)
    const button = nodes.find(node => node.type === 'button')
    assert.ok(button.props['aria-label'].includes(`"count":"${core.formatTokensCompact(total)}"`))
    const detail = key => {
      const index = nodes.findIndex(node => node.type === 'dt' && node.props.children === key)
      assert.ok(index >= 0, `missing ${key}`)
      return nodes[index + 1].props.children
    }
    assert.equal(detail('message.turnUsage.input'), 'message.turnUsage.count:{"count":"101"}')
    assert.equal(detail('message.turnUsage.cacheRead'), 'message.turnUsage.count:{"count":"303"}')
    assert.equal(detail('message.turnUsage.cacheWrite'), 'message.turnUsage.count:{"count":"404"}')
    assert.equal(detail('message.turnUsage.output'), 'message.turnUsage.count:{"count":"202"}')
    // The one deliberate divergence from native: the pill's headline total is the
    // WHOLE session tree, subagents included.
    assert.ok(
      button.props['aria-label'].includes(`"count":"${core.formatTokensCompact(total)}"`),
      'pill total must include subagent spend',
    )
    // ...and nothing else diverges: no main/tree rows, no +N badge.
    assert.equal(nodes.findIndex(node => node.props.children === 'stats.dialog.main'), -1)
    assert.equal(nodes.findIndex(node => node.props.children === 'stats.dialog.treeTotal'), -1)
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
  // Native integer cache-hit figure, and no preference/state machinery anywhere.
  assert.match(pillSource, /const cacheHit = cacheHitPercent\(billed\)/)
  assert.doesNotMatch(pillSource, /cachePrecision|tokenDetail|streamThroughput|liveSpeed|stats-line-state|cacheHitPercentPrecise\(/)
  assert.doesNotMatch(panel, /cachePrecision|tokenDetail|streamThroughput|StatsLineOptions|SettingToggle|prefGroup|role="switch"|stats-line-state|rebuildStats|rebuildTimer/)
  assert.doesNotMatch(locales, /cachePrecision|tokenDetail|streamThroughput|rebuildConfirm|rebuilding/)
  assert.doesNotMatch(css, /\.prefGroup|\.prefRow|\.switchTrack|\.switchThumb/)
  assert.match(panel, /const name = m\.model/)
  assert.match(panel, /m\.providers \?\? \(m\.provider === '' \? \[\] : \[m\.provider\]\)/)
  assert.match(panel, /useState(?:<string>)?\('today'\)/)
  assert.match(panel, /t\('usageRanking'\)/)
})
