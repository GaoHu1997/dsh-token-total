/**
 * TokenTotalPanel renders the "usage statistics" panel. One component mounts
 * in two places —the Plugins page's own page for this bundle and the panel's
 * standalone main panel —so it reads the aggregate from the host (via the
 * fenced /token-total/api route) and draws every chart by hand in SVG —a
 * GitHub-style activity heatmap, a stacked per-day token trend with a cache
 * hit-rate curve, and two ranked sections (models and providers) that each
 * pair a ring with a detail list.
 * No chart library; colours come from a fixed two-series palette
 * (--dsw-chart-1..10 + the gray --dsw-chart-other for models,
 * --dsw-provider-1..5 + the gray --dsw-provider-other for providers, the
 * reasonix usage-stats palette with a lifted dark variant, defined in this
 * plugin's module css).
 *
 * The panel follows the DSH client conventions: component styles are a CSS
 * Module (hashed class map imported as `css`), interactive atoms use the
 * ui-primitives Button/Input, and every visual value rides the --dsw-alias-*
 * semantic tokens. The functionality replicates the reasonix usage stats
 * feature; the implementation is DSH-native.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { Activity, ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, Coins, Database, MessagesSquare } from 'lucide-react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyTokenUsage, ModelTokenUsage, ProviderTokenUsage, TokenTotalRange, TokenTotalRequest } from '../wire.ts'
import { fetchRange, UsageApiError } from './api.ts'
import { ChartTip } from './ChartTip.tsx'
import { Donut, useDonutSize, type DonutSegment } from './Donut.tsx'
import { formatTokens, formatCompact, formatPercent, cacheRate, cacheRateText, daysBetween, localDay, indexOfDay, bucketAxisLabel, bucketTitle, smoothPath, niceTicks } from './format.ts'
import type { TokenTotalKey } from './locales.ts'
import type { TokenTotalTranslator } from './index.tsx'
import css from './TokenTotalPanel.module.css'

type Translator = TokenTotalTranslator

const RANGE_PRESETS = ['today', '3', '7', '30', '90'] as const

// The heatmap's DATA WINDOW: one year, fixed regardless of the range preset.
// It is the window, not the number of weeks drawn —the render trims columns
// to the container's width (see heatGeometry), so a narrow pane shows fewer
// weeks without re-fetching. Sized to the Plugins page's 960px content column,
// where 52 weeks land at roughly 15px cells: the density this chart is meant
// to read at.
export const HEAT_WEEKS = 52

/** The trend chart caps its visible window at 180 days (mirrors reasonix). */
const TREND_MAX_DAYS = 180

/** The top-10 models keep a distinct rank colour; everything beyond collapses
 *  into the gray "Other" step. */
const TOP_MODELS = 10
const OTHER_MODEL = '\u0000other' // sentinel; cannot collide with a real model ref
const OTHER_COLOR = 'var(--dsw-chart-other)'

/** How many rows each bottom breakdown tab lists (requirement 下部: 展示前 5). */
const TOP_BREAKDOWN = 5

/** Shared empty key set: one stable identity for a collapsed expand state. */
const NO_KEYS: ReadonlySet<string> = new Set()

/** Grouped daily rows: the top models stay individual, the tail collapses
 *  into the OTHER_MODEL bucket with the breakdown kept for tooltips. */
type GroupedDaily = DailyTokenUsage & { otherByModel: Record<string, number> }
type GroupedModel = ModelTokenUsage & { items?: ModelTokenUsage[] }

export function TokenTotalPanel({ t }: { t: Translator }): JSX.Element {
  // The panel opens on TODAY: the common question is "what did I just
  // spend", and it is the only preset that reads as a live figure rather
  // than a running total. The other presets are one click away.
  const [range, setRange] = useState<string>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [stats, setStats] = useState<TokenTotalRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generationRef = useRef(0)
  // The panel bounds the chart tooltips: a tip must never leave the panel
  // even when the hovered cell sits near its edge.
  const panelRef = useRef<HTMLDivElement>(null)

  // Heatmap window: the last HEAT_WEEKS*7 days, fixed regardless of `range`.
  const heatWindow = useMemo(() => {
    const to = localDay(0)
    const from = localDay(-(HEAT_WEEKS * 7 - 1))
    return { from, to }
  }, [])
  const [heatDaily, setHeatDaily] = useState<DailyTokenUsage[]>([])
  const heatGenRef = useRef(0)

  const loadHeat = useCallback(async () => {
    const generation = ++heatGenRef.current
    try {
      const res = await fetchRange({ range: 'custom', from: heatWindow.from, to: heatWindow.to })
      if (heatGenRef.current !== generation) return
      setHeatDaily(res.daily)
    } catch (e) {
      // The heatmap is auxiliary and must never block the panel, but it must
      // not fail silently either: its window is fixed, so the first request
      // that dies (a backend still booting, an auth race on mount) used to
      // leave the grid at level-0 for the rest of the session. Log the
      // failure; `load` retries the window on the next panel load.
      console.error('[token-total] heatmap window request failed', e)
    }
  }, [heatWindow.from, heatWindow.to])

  const load = useCallback(async () => {
    if (range === 'custom' && (!customFrom || !customTo)) return
    const req: TokenTotalRequest =
      range === 'custom'
        ? { range, from: customFrom, to: customTo }
        : { range }
    const generation = ++generationRef.current
    setLoading(true)
    setError('')
    try {
      const res = await fetchRange(req)
      if (generationRef.current !== generation) return // stale response
      setStats(res)
      // One trigger chain for both surfaces. The heatmap window does not
      // follow `range`, so binding its fetch to the mount effect alone meant a
      // single failed request left the grid blank until the user pressed
      // refresh, while every other section healed on the next range switch.
      void loadHeat()
    } catch (e) {
      if (generationRef.current !== generation) return
      setError(e instanceof UsageApiError ? e.message : String(e))
    } finally {
      if (generationRef.current === generation) setLoading(false)
    }
  }, [range, customFrom, customTo, loadHeat])

  useEffect(() => {
    void load()
  }, [load])

  // A model's colour is its TOKEN rank (the host returns `models` sorted by
  // token volume), matching reasonix: rank 1..10 take --dsw-chart-1..10 and the
  // aggregated tail is the gray --dsw-chart-other. First-seen order would
  // scramble the rank colours (the top model could lose its blue, and a
  // top-10 model could fall into the gray bucket), so the rank is looked up in
  // `stats.models`, never in the daily walk.
  const colorForModel = useCallback((model: string): string => {
    if (model === OTHER_MODEL) return OTHER_COLOR
    const slot = (stats?.models ?? []).findIndex((m) => m.model === model)
    const rank = Math.min(slot < 0 ? 0 : slot, TOP_MODELS - 1) + 1
    return `var(--dsw-chart-${rank})`
  }, [stats])

  // Top-10 grouping: models beyond the top ten by token volume collapse into
  // the OTHER_MODEL bucket for the bar and the daily stacks; the per-day
  // breakdown stays available for the tooltip.
  const groupedStats = useMemo<{ models: GroupedModel[]; daily: GroupedDaily[] } | null>(() => {
    if (!stats) return null
    const top = stats.models.slice(0, TOP_MODELS)
    const rest = stats.models.slice(TOP_MODELS)
    const topSet = new Set(top.map((m) => m.model))
    const models: GroupedModel[] = rest.length > 0
      ? [
          ...top,
          {
            model: OTHER_MODEL,
            provider: '',
            tokens: rest.reduce((sum, m) => sum + m.tokens, 0),
            percent: rest.reduce((sum, m) => sum + m.percent, 0),
            cacheHit: rest.reduce((sum, m) => sum + m.cacheHit, 0),
            cacheMiss: rest.reduce((sum, m) => sum + m.cacheMiss, 0),
            items: rest,
          },
        ]
      : top
    const daily: GroupedDaily[] = stats.daily.map((d) => {
      const otherByModel: Record<string, number> = {}
      const byModel: Record<string, number> = {}
      for (const [m, v] of Object.entries(d.byModel)) {
        if (topSet.has(m)) byModel[m] = v
        else otherByModel[m] = v
      }
      const other = Object.values(otherByModel).reduce((sum, v) => sum + v, 0)
      if (other > 0) byModel[OTHER_MODEL] = other
      return { ...d, byModel, otherByModel }
    })
    return { models, daily }
  }, [stats])

  const trendDaily = groupedStats?.daily ?? []
  const trendModels = groupedStats?.models ?? []

  return (
    <div className={css.panel} data-dsh-usage-glass="panel" ref={panelRef}>
      <div className={css.toolbar}>
        <div className={css.group} data-dsh-usage-glass="group" role="group" aria-label={t('range')}>
          {RANGE_PRESETS.map((r) => (
            <Button
              key={r}
              size="sm"
              variant="ghost"
              className={clsx(css.segItem, range === r && css.segActive)}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {t(`rangePreset.${r}` as TokenTotalKey)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className={clsx(css.segItem, range === 'custom' && css.segActive)}
            aria-pressed={range === 'custom'}
            onClick={() => setRange('custom')}
          >
            {t('rangeCustom')}
          </Button>
        </div>
        {range === 'custom' && (
          <div className={css.customRange}>
            <Input
              type="date"
              className={css.dateInput}
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label={t('from')}
            />
            <span className={css.customSep}>…</span>
            <Input
              type="date"
              className={css.dateInput}
              value={customTo}
              min={customFrom || undefined}
              max={localDay(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label={t('to')}
            />
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className={css.refresh}
          onClick={() => { void load() }}
          disabled={loading}
        >
          {t('refresh')}
        </Button>
      </div>

      {error && <div className={css.errorBanner}>{error}</div>}
      {loading && !stats && <div className={css.loading}>{t('loading')}…</div>}
      {/* Content stays mounted across refreshes (stats keeps its last value):
          only the FIRST load shows the spinner, so a range switch or a manual
          refresh never blanks the whole data area. */}
      {stats && (
        <>
          <StatCards stats={stats} t={t} />
          <Heatmap daily={heatDaily} from={heatWindow.from} to={heatWindow.to} t={t} panelRef={panelRef} />
          <DailyTrend models={trendModels} daily={trendDaily} granularity={stats?.granularity ?? 'day'} t={t} colorForModel={colorForModel} panelRef={panelRef} />
          <UsageBreakdown models={stats.models} providers={stats.providers} total={stats.tokens} t={t} />
          {stats.to && (
            <div className={css.foot}>
              {t('asOf')} {stats.to}
            </div>
          )}
        </>
      )}
      {!error && stats && isEmptyRange(stats) && (
        <div className={css.empty}>{t('empty')}</div>
      )}
    </div>
  )
}

// ── Section 2+3: numeric cards ────────────────────────────────────────────

/** A range is empty only when NOTHING was recorded in it: a pure-cache day
 *  (zero input/output but real cache hits) or a failed-call day (requests
 *  but no tokens) both carry real usage and must not read as "no data". */
function isEmptyRange(stats: TokenTotalRange): boolean {
  return stats.tokens === 0 && stats.cacheHit === 0 && stats.requests === 0 && stats.turns === 0
}

function StatCards({ stats, t }: { stats: TokenTotalRange; t: Translator }) {
  const cards: Array<{ icon: typeof Coins; label: string; value: string; hint?: string; sub?: string }> = [
    // 总tokens —the provider-inclusive headline (uncached input + output +
    // cache reads/writes): the number a provider dashboard reports. Compact
    // K/M/B on the headline, the exact count underneath.
    { icon: Coins, label: t('tokens'), value: formatCompact(stats.tokens), hint: t('tokensHint'), sub: `${formatTokens(stats.tokens)} ${t('tokensUnit')}` },
    // 输入 tokens —uncached prompt tokens the provider billed as new input.
    { icon: ArrowDownToLine, label: t('inputTokens'), value: formatCompact(stats.inputTokens), sub: `${formatTokens(stats.inputTokens)} ${t('tokensUnit')}` },
    // 输出 tokens —completion tokens.
    { icon: ArrowUpFromLine, label: t('outputTokens'), value: formatCompact(stats.outputTokens), sub: `${formatTokens(stats.outputTokens)} ${t('tokensUnit')}` },
    // 缓存 tokens —cached prompt tokens (cache reads + cache writes).
    { icon: Database, label: t('cacheTokens'), value: formatCompact(stats.cacheTokens), sub: `${formatTokens(stats.cacheTokens)} ${t('tokensUnit')}` },
    // 缓存命中率 —cached share of all prompt tokens in the range.
    { icon: Activity, label: t('cacheRate'), value: cacheRateText(stats.cacheHit, stats.cacheMiss), hint: t('cacheRateHint'), sub: `${formatCompact(stats.cacheHit)} ${t('cachedTokens')}` },
    // 请求数量 —provider calls (tokens or not).
    { icon: MessagesSquare, label: t('requests'), value: String(stats.requests) },
  ]
  return (
    <div className={css.cards}>
      {cards.map((c) => (
        <div className={css.card} data-dsh-usage-glass="card" key={c.label} title={c.hint}>
          <div className={css.cardHead}>
            <c.icon className={css.cardIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.cardLabel}>{c.label}</span>
          </div>
          {c.sub !== undefined ? (
            <div className={clsx(css.cardValue, css.cardModelLines)}>
              <FitText text={c.value} className={css.cardValue} maxSize={22} />
              <div className={css.cardSub}>{c.sub}</div>
            </div>
          ) : (
            <FitText text={c.value} className={css.cardValue} maxSize={22} />
          )}
        </div>
      ))}
    </div>
  )
}

// FitText renders `text` on a single line, shrinking the font until it fits
// the card width (long token numbers never overflow or wrap).
function FitText({ text, className, maxSize }: { text: string; className?: string; maxSize: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(maxSize)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let s = maxSize
      el.style.fontSize = `${s}px`
      while (el.scrollWidth > el.clientWidth + 1 && s > 11) {
        s -= 0.5
        el.style.fontSize = `${s}px`
      }
      setSize(s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, maxSize])

  return (
    <div ref={ref} className={className} style={{ fontSize: size }}>
      {text}
    </div>
  )
}

// ── Section 4: GitHub-style activity heatmap ──────────────────────────────

// Cell/gap ratio follows reasonix (base 13 / gap 3): a 1px gap against a
// ~20px grown cell read as tiles touching edge to edge. The gap also equals
// the legend's own 3px swatch spacing, and the fixed rx matches the legend
// swatch border-radius, so the key renders at exactly the chart's geometry.
const HEAT_BASE = 14 // cell size at which column trimming starts
const HEAT_GAP = 3 // breathing gap between cells; mirrors the legend swatch gap
const HEAT_RX = 3 // cell corner radius; matches the legend swatch (css .heatCell)

/** One heatmap frame's geometry. */
export interface HeatGeometry {
  /** Cell edge in px. */
  size: number
  /** Weeks drawn. */
  cols: number
  /** Columns actually laid out, including the partial first week. */
  totalWeeks: number
}

/**
 * Solve the heatmap's geometry for an available width.
 *
 * Two rules, in this order: spend spare width on MORE WEEKS (up to the data
 * window), and only then grow the cells to close the remaining gap. When the
 * window does not fit at the base cell size, trim the earliest weeks and keep
 * the base size.
 *
 * Two off-by-one traps are handled explicitly, because both produce a real
 * overflow at the page's ~900px content width:
 *  - "does it fit" is tested against `totalWeeks` (the laid-out column count,
 *    one more than `cols` when the first week is partial), not `HEAT_WEEKS`;
 *  - the fitting test reserves the trailing gap, so `baseCols` is derived from
 *    `avail - HEAT_GAP` and the rendered width `cols*(size+GAP)+GAP` can never
 *    exceed `avail`.
 *
 * The growth branch runs only when the solved cell size is still at or above
 * the base size; otherwise the window does not truly fit and the trim branch
 * runs. A `max(BASE, size)` fallback would silently render one column too many.
 * @param avail - available width in px.
 * @param startOffset - leading empty cells of the first week (0..6).
 * @returns the cell size, the week count, and the laid-out column count.
 */
export function heatGeometry(avail: number, startOffset: number): HeatGeometry {
  const totalWeeks = Math.ceil((HEAT_WEEKS * 7 + startOffset) / 7)
  const baseCols = Math.max(1, Math.floor((avail - HEAT_GAP) / (HEAT_BASE + HEAT_GAP)))
  if (baseCols >= totalWeeks) {
    const size = (avail - HEAT_GAP) / totalWeeks - HEAT_GAP
    if (size >= HEAT_BASE) return { size, cols: HEAT_WEEKS, totalWeeks }
  }
  // `cols * 7` days behind a leading partial week occupy one MORE track than
  // `cols`, and the SVG viewport is sized from the track count —so a `cols`
  // that only fits `cols` tracks leaves the newest column outside the viewBox,
  // clipped to a sliver at the right edge. Drop the OLDEST week in that case:
  // one fewer week reads far better than a half-drawn newest one, and the
  // remaining cells grow to fill the width exactly. `cols` was derived from
  // `avail - GAP`, so the solved size stays at or above the base size; the
  // floor only guards absurd widths.
  const tracksFor = (c: number): number => Math.max(c, Math.ceil((c * 7 + startOffset) / 7))
  let cols = Math.max(1, Math.min(baseCols, HEAT_WEEKS))
  while (cols > 1 && tracksFor(cols) > baseCols) cols -= 1
  const totalCols = tracksFor(cols)
  const size = (avail - HEAT_GAP) / totalCols - HEAT_GAP
  return { size: Math.max(HEAT_BASE, size), cols, totalWeeks: totalCols }
}

function Heatmap({ daily, from, to, t, panelRef }: { daily: DailyTokenUsage[]; from: string; to: string; t: Translator; panelRef: RefObject<HTMLDivElement | null> }) {
  // Memoized so a hover/tip state change re-renders without rebuilding the
  // per-day lookup (the daily array is stable between fetches).
  const byDay = useMemo(() => {
    const map = new Map<string, DailyTokenUsage>()
    for (const d of daily) map.set(d.day, d)
    return map
  }, [daily])
  const [tip, setTip] = useState<{ day: string; tokens: number; requests: number; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [geom, setGeom] = useState<HeatGeometry>(() => heatGeometry(HEAT_BASE * HEAT_WEEKS, 0))

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth - 2)
      const next = heatGeometry(avail, (indexOfDay(from) + 1) % 7)
      // Only commit when the geometry actually changed —the heatmap SVG
      // width follows `geom.size`, and committing an identical value on
      // every ResizeObserver callback would feed a render loop and jitter.
      setGeom((prev) => (prev.size === next.size && prev.cols === next.cols ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [from])

  const allDays = daysBetween(from, to)
  if (allDays.length === 0) return null
  const days = allDays.slice(-Math.min(geom.cols * 7, allDays.length))
  const max = Math.max(1, ...days.map((d) => byDay.get(d)?.total ?? 0))

  const rows = 7
  const startOffset = days[0] ? (indexOfDay(days[0]) + 1) % 7 : 0
  // The solver already knows how many columns the layout has, including the
  // partial first week, so the SVG width follows it directly.
  const weeks = geom.totalWeeks

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('heatmap')}</h3>
        <div className={css.heatLegend}>
          <span>{t('heatLess')}</span>
          <i className={clsx(css.heatCell, css.heatLevel1)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel2)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel3)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel4)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel5)} style={{ width: geom.size, height: geom.size }} />
          <span>{t('heatMore')}</span>
        </div>
      </div>
      <div className={css.heatWrap} ref={wrapRef}>
        <svg className={css.heatmap} width={weeks * (geom.size + HEAT_GAP) + HEAT_GAP} height={rows * (geom.size + HEAT_GAP) + HEAT_GAP} role="img" aria-label={t('heatmap')}>
          {days.map((day, i) => {
            const col = Math.floor((i + startOffset) / 7)
            const row = (i + startOffset) % 7
            const rec = byDay.get(day)
            const tokens = rec?.total ?? 0
            const level = tokens === 0 ? 0 : 1 + Math.floor((tokens / max) * 4)
            const x = HEAT_GAP + col * (geom.size + HEAT_GAP)
            const y = HEAT_GAP + row * (geom.size + HEAT_GAP)
            return (
              <rect
                key={day}
                className={clsx(css.heatCell, level === 0 && css.heatLevel0, level === 1 && css.heatLevel1, level === 2 && css.heatLevel2, level === 3 && css.heatLevel3, level === 4 && css.heatLevel4, level === 5 && css.heatLevel5)}
                x={x}
                y={y}
                width={geom.size}
                height={geom.size}
                rx={HEAT_RX}
                onMouseEnter={(e) => {
                  // The tip anchors to the hovered cell's viewport rect, so it
                  // can escape the wrap's overflow clipping and follow scroll.
                  setTip({ day, tokens, requests: rec?.requests ?? 0, cacheHit: rec?.cacheHit ?? 0, cacheMiss: rec?.cacheMiss ?? 0, anchor: e.currentTarget })
                }}
                onMouseLeave={() => setTip(null)}
              />
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{tip.day}</div>
            <div>{t('tokens')}: {formatTokens(tip.tokens)}</div>
            <div>{t('requests')}: {tip.requests}</div>
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
      </div>
    </section>
  )
}

// ── Section 5: stacked daily token trend ──────────────────────────────────

function DailyTrend({ models, daily, granularity, t, colorForModel, panelRef }: { models: GroupedModel[]; daily: GroupedDaily[]; granularity: 'day' | 'hour'; t: Translator; colorForModel: (m: string) => string; panelRef: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ day: string; total: number; byModel: Record<string, number>; otherByModel?: Record<string, number>; cacheHit: number; cacheMiss: number; anchor: Element } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const W = 720
  const H = 220
  const padL = 46
  const padR = 65
  const padB = 26
  const padT = 10
  const plotH = H - padT - padB
  // The smallest column pitch that still reads as separate bars; below it
  // (very long custom ranges on a narrow pane) the oldest days drop off.
  const MIN_PITCH = 4

  const [view, setView] = useState<{ avail: number; trimN: number }>({ avail: W, trimN: TREND_MAX_DAYS })

  useEffect(() => {
    const el = wrapRef.current
    if (!el || daily.length === 0) return
    const update = () => {
      const avail = Math.max(1, el.clientWidth)
      const maxN = Math.floor((avail - padL - padR) / MIN_PITCH) + 1
      const trimN = Math.max(1, Math.min(daily.length, TREND_MAX_DAYS, maxN))
      setView((prev) => (prev.avail === avail && prev.trimN === trimN ? prev : { avail, trimN }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [daily.length])

  if (daily.length === 0) return null

  const visible = daily.slice(-view.trimN)
  // The note is honest about whatever window actually rendered (the 180-day
  // cap, or a narrower pane's minimum-pitch trim).
  const trendCapped = daily.length > view.trimN
  const n = visible.length
  // Columns always spread over the full plot width: pinning a minimum pitch
  // for the step itself letterboxes the chart (the viewBox, narrower than
  // the svg box, centres with empty flanks) when few days are in range —
  // 7/14-day presets used to huddle in the middle. The pitch floor above
  // only caps how many days show.
  const step =
    n > 1
      ? (view.avail - padL - padR) / (n - 1)
      : Math.max(1, view.avail - padL - padR)
  const barW = Math.max(3, Math.min(30, step * 0.62))
  const barHalf = barW / 2
  const plotWUsed = view.avail
  const maxTotal = Math.max(1, ...visible.map((d) => d.total))
  const ticks = niceTicks(maxTotal, 4)
  // X labels keep at least ~46px between their columns —a fixed "every Nth
  // day" count collided when few days stretched across the whole plot
  // (7/14-day presets labelled every bar).
  const labelEvery = Math.max(1, Math.ceil(46 / step))

  const trendPoints: Array<{ x: number; y: number }> = []
  const trendPointByDay = new Map<string, { x: number; y: number }>()
  visible.forEach((d, i) => {
    const rate = cacheRate(d.cacheHit, d.cacheMiss)
    if (rate === null) return
    const pt = { x: padL + barHalf + i * step, y: padT + plotH - (rate / 100) * plotH }
    trendPoints.push(pt)
    trendPointByDay.set(d.day, pt)
  })
  const trendPath = smoothPath(trendPoints)
  const trendTipPt = tip ? trendPointByDay.get(tip.day) : undefined
  const rateTicks = [0, 25, 50, 75, 100]

  // Legend and bar stacks follow the overall usage ranking (not the per-day
  // leader), so a model's colour stays in the same position every day and the
  // aggregated "Other" step always sits on top.
  const legendAgg = aggregateByModel(daily)
  const legendModels = modelOrderOf(models, legendAgg)

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t(granularity === 'hour' ? 'hourlyTrend' : 'dailyTrend')}</h3>
        {trendCapped && <span className={css.trendNote}>{t('trendLimited').replace('{n}', String(view.trimN))}</span>}
      </div>
      <div className={css.chartWrap} ref={wrapRef}>
        <svg className={css.chart} width="100%" height={H} viewBox={`0 0 ${plotWUsed} ${H}`} onMouseLeave={() => { setTip(null); setHover(null) }}>
          {ticks.map((tk) => {
            const y = padT + plotH - (tk / maxTotal) * plotH
            return (
              <g key={tk}>
                <line className={css.grid} x1={padL} y1={y} x2={padL + (n - 1) * step + barW} y2={y} />
                <text className={css.axis} x={padL - 6} y={y + 3} textAnchor="end">{formatCompact(tk)}</text>
              </g>
            )
          })}
          {visible.map((d, i) => {
            const x = padL + barHalf + i * step - barW / 2
            const dayOrder = legendModels.filter((m) => d.byModel[m] !== undefined)
            let yBottom = padT + plotH
            const bars = dayOrder.map((model) => {
              const tokens = d.byModel[model]!
              const h = (tokens / maxTotal) * plotH
              const y = yBottom - h
              yBottom = y
              return { model, tokens, x, y, h, color: colorForModel(model), dimmed: hover !== null && hover !== model }
            })
            const hovered = tip?.day === d.day
            return (
              <g key={d.day}>
                {bars.map((b) => (
                  <rect
                    key={`${d.day}-${b.model}`}
                    className={clsx(css.bar, b.dimmed && css.barDim)}
                    x={b.x}
                    y={b.y}
                    width={barW}
                    height={b.h}
                    fill={b.color}
                    style={hovered ? { transform: `scaleX(${(barW + 3) / barW})` } : undefined}
                  />
                ))}
                <rect
                  className={css.barHit}
                  x={x}
                  y={padT}
                  width={barW}
                  height={plotH}
                  onMouseEnter={(e) => {
                    // The tip anchors to the hovered day column's viewport
                    // rect, so it can escape wrap clipping and follow scroll.
                    setTip({ day: d.day, total: d.total, byModel: d.byModel, otherByModel: d.otherByModel, cacheHit: d.cacheHit, cacheMiss: d.cacheMiss, anchor: e.currentTarget })
                  }}
                  onMouseLeave={() => setTip(null)}
                />
                {(i % labelEvery === 0 || i === n - 1) && (
                  <text className={css.axis} x={padL + barHalf + i * step} y={H - 8} textAnchor="middle">{bucketAxisLabel(d.day, granularity)}</text>
                )}
              </g>
            )
          })}
          <path className={css.trend} d={trendPath} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {trendTipPt && (
            <circle className={css.trendDot} cx={trendTipPt.x} cy={trendTipPt.y} r={4} />
          )}
          {rateTicks.map((p) => {
            const y = padT + plotH - (p / 100) * plotH
            return (
              <g key={`rate-${p}`}>
                <text className={clsx(css.axis, css.axisRate)} x={padL + (n - 1) * step + barW + 8} y={y + 3}>{p}%</text>
              </g>
            )
          })}
        </svg>
        {tip && (
          <ChartTip anchor={tip.anchor} panelRef={panelRef}>
            <div className={css.tipTitle}>{bucketTitle(tip.day, granularity)}</div>
            <div>{t('total')}: {formatTokens(tip.total)}</div>
            {legendModels.filter((m) => tip.byModel[m] !== undefined).map((m) => (
              <div key={m} className={css.tipRow}><i className={css.legendSwatch} style={{ background: colorForModel(m) }} />{m === OTHER_MODEL ? t('other') : m}: {formatTokens(tip.byModel[m]!)}</div>
            ))}
            {tip.otherByModel && Object.entries(tip.otherByModel).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
              <div key={m} className={clsx(css.tipRow, css.tipRowOther)}><i className={css.legendSwatch} style={{ background: OTHER_COLOR }} />{m}: {formatTokens(v)}</div>
            ))}
            <div>{t('cacheHitRate')}: {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
          </ChartTip>
        )}
      </div>
    </section>
  )
}

// ── Section 6: bottom breakdown — top 5 by model / by provider ────────
//
// Requirement 下部: two tabs, one ranking by MODEL and one by PROVIDER, each
// listing the top 5 names with total tokens and the cache hit rate.
//
// The by-model tab aggregates by MODEL NAME, not by the provider/model ref:
// the same model served through two providers must show as ONE row
// (同名模型不同供应商需要聚合). The by-provider tab is already aggregated by
// provider upstream, so it ranks the provider rows the host returned.

interface BreakdownRow {
  key: string
  name: string
  detail?: string
  tokens: number
  cacheHit: number
  cacheMiss: number
  color: string
}

function UsageBreakdown({ models, providers, total, t }: {
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
  total: number
  t: Translator
}) {
  const [tab, setTab] = useState<'model' | 'provider'>('model')

  const modelRows = useMemo<BreakdownRow[]>(() => {
    const byName = new Map<string, { tokens: number; cacheHit: number; cacheMiss: number; providers: Set<string> }>()
    for (const m of models) {
      const name = m.model
      const acc = byName.get(name) ?? { tokens: 0, cacheHit: 0, cacheMiss: 0, providers: new Set<string>() }
      acc.tokens += m.tokens
      acc.cacheHit += m.cacheHit
      acc.cacheMiss += m.cacheMiss
      for (const provider of m.providers ?? [m.provider]) acc.providers.add(provider)
      byName.set(name, acc)
    }
    return [...byName.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, TOP_BREAKDOWN)
      .map(([name, acc], i) => ({
        key: name,
        name,
        detail: acc.providers.size > 1 ? [...acc.providers].join(', ') : undefined,
        tokens: acc.tokens,
        cacheHit: acc.cacheHit,
        cacheMiss: acc.cacheMiss,
        color: `var(--dsw-chart-${i + 1})`,
      }))
  }, [models])

  const providerRows = useMemo<BreakdownRow[]>(() => {
    return [...providers]
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_BREAKDOWN)
      .map((p, i) => ({
        key: p.provider,
        name: p.provider,
        tokens: p.tokens,
        cacheHit: p.cacheHit,
        cacheMiss: p.cacheMiss,
        color: `var(--dsw-provider-${i + 1})`,
      }))
  }, [providers])

  const rows = tab === 'model' ? modelRows : providerRows
  const share = (n: number): string => (total > 0 ? formatPercent((n / total) * 100) : '—')

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        {/* One title for both tabs: the section is ONE ranking, seen through
            two lenses (by model / by provider), so the heading names the
            section rather than the current lens. */}
        <h3 className={css.sectionTitle}>{t('usageRanking')}</h3>
        <div className={css.group} role="tablist" aria-label={t('usageRanking')}>
          <Button size="sm" variant="ghost" role="tab" aria-selected={tab === 'model'} className={clsx(css.segItem, tab === 'model' && css.segActive)} onClick={() => setTab('model')}>
            {t('byModel')}
          </Button>
          <Button size="sm" variant="ghost" role="tab" aria-selected={tab === 'provider'} className={clsx(css.segItem, tab === 'provider' && css.segActive)} onClick={() => setTab('provider')}>
            {t('byProvider')}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className={css.empty}>{t('empty')}</div>
      ) : (
        <ul className={css.modelList} data-dsh-usage-glass="list">
          {rows.map((r, rank) => (
            <li key={r.key} className={css.modelRow}>
              <span className={css.modelRank} aria-hidden="true">{rank + 1}</span>
              <i className={css.legendSwatch} style={{ background: r.color }} />
              <div className={css.modelId}>
                <span className={css.modelName}>{r.name}</span>
                <span className={css.modelProvider}>{r.detail ?? share(r.tokens)}</span>
              </div>
              <div className={css.modelValues}>
                <span className={css.modelTokens}>{formatCompact(r.tokens)}</span>
                <span className={css.modelPct}>{t('cacheRateColumn')} {cacheRateText(r.cacheHit, r.cacheMiss)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Toggle one key in an immutable string set (a fresh Set every call, so React
 *  sees a state change and unrelated keys keep their state). */
function toggleIn(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function aggregateByModel(daily: Array<{ byModel: Record<string, number> }>): Record<string, number> {
  const out: Record<string, number> = Object.create(null)
  for (const d of daily) {
    for (const [m, v] of Object.entries(d.byModel)) out[m] = (out[m] ?? 0) + v
  }
  return out
}

/** The legend model order follows the overall usage ranking, with the Other
 *  bucket pinned last (it sits on top of the stacks). */
function modelOrderOf(models: GroupedModel[], dailyAgg: Record<string, number>): string[] {
  const ranked = models
    .filter((m) => m.model !== OTHER_MODEL && dailyAgg[m.model] !== undefined)
    .map((m) => m.model)
  if (models.some((m) => m.model === OTHER_MODEL)) ranked.push(OTHER_MODEL)
  return ranked
}

