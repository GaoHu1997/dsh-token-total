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
import { Activity, ArrowDownToLine, ArrowUpFromLine, Coins, Database, MessagesSquare } from 'lucide-react'
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

/** How many rows each ranking card lists (扩展到 8 个排行). */
const TOP_BREAKDOWN = 8

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
  // When the last successful fetch happened — the "as of" stamp shows a
  // concrete clock time, not just the range's date.
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
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
      setLoadedAt(Date.now())
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
        <div className={css.toolbarEnd}>
          {stats && (
            <span className={css.asOf}>
              {t('asOf')} {asOfStamp(stats.to, loadedAt)}
            </span>
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
      </div>

      {error && <div className={css.errorBanner}>{error}</div>}
      {loading && !stats && <div className={css.loading}>{t('loading')}…</div>}
      {/* Content stays mounted across refreshes (stats keeps its last value):
          only the FIRST load shows the spinner, so a range switch or a manual
          refresh never blanks the whole data area. */}
      {stats && (
        <>
          <StatCards stats={stats} t={t} />
          {/* Heatmap and the token trend share ONE row —one card each, left
              and right (热力图左 / 趋势右). The duo grid stretches both cards
              to a common height and folds to one column on a narrow pane. */}
          <div className={css.duo}>
            <Heatmap daily={heatDaily} from={heatWindow.from} to={heatWindow.to} t={t} panelRef={panelRef} />
            <DailyTrend models={trendModels} daily={trendDaily} granularity={stats?.granularity ?? 'day'} t={t} colorForModel={colorForModel} panelRef={panelRef} />
          </div>
          <UsageBreakdown
            models={stats.models}
            providers={stats.providers}
            total={stats.tokens}
            providerNames={stats.providerNames}
            t={t}
            panelRef={panelRef}
            colorForModel={colorForModel}
          />
        </>
      )}
      {!error && stats && isEmptyRange(stats) && (
        <div className={css.empty}>{t('empty')}</div>
      )}
    </div>
  )
}

// ── Section 2+3: numeric cards ────────────────────────────────────────────

/** "As of" stamp for a loaded range: the fetch clock time when the range
 *  reaches today (the data is live up to that refresh), else the day's end —
 *  the wire carries only dates, and a past day's data is complete. */
function asOfStamp(to: string, fetchedAt: number | null): string {
  if (to !== localDay(0)) return `${to} 23:59`
  const d = new Date(fetchedAt ?? Date.now())
  return `${to} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A range is empty only when NOTHING was recorded in it: a pure-cache day
 *  (zero input/output but real cache hits) or a failed-call day (requests
 *  but no tokens) both carry real usage and must not read as "no data". */
function isEmptyRange(stats: TokenTotalRange): boolean {
  return stats.tokens === 0 && stats.cacheHit === 0 && stats.requests === 0 && stats.failures === 0 && stats.turns === 0
}

function StatCards({ stats, t }: { stats: TokenTotalRange; t: Translator }) {
  // Each card wears one accent hue (tone 1..6 → --dsw-tone-1..6): the accent
  // drives the left bar, the icon badge tint, and the corner wash, so the
  // overview row reads in colour instead of one gray register.
  const cards: Array<{ icon: typeof Coins; label: string; value: string; hint?: string; sub?: string; tone: number }> = [
    // 总tokens —the provider-inclusive headline (uncached input + output +
    // cache reads/writes): the number a provider dashboard reports. Compact
    // K/M/B on the headline, the exact count underneath.
    { icon: Coins, label: t('tokens'), value: formatCompact(stats.tokens), hint: t('tokensHint'), sub: `${formatTokens(stats.tokens)} ${t('tokensUnit')}`, tone: 1 },
    // 输入 tokens —uncached prompt tokens the provider billed as new input.
    { icon: ArrowDownToLine, label: t('inputTokens'), value: formatCompact(stats.inputTokens), sub: `${formatTokens(stats.inputTokens)} ${t('tokensUnit')}`, tone: 2 },
    // 输出 tokens —completion tokens.
    { icon: ArrowUpFromLine, label: t('outputTokens'), value: formatCompact(stats.outputTokens), sub: `${formatTokens(stats.outputTokens)} ${t('tokensUnit')}`, tone: 3 },
    // 缓存 tokens —cached prompt tokens (cache reads + cache writes).
    { icon: Database, label: t('cacheTokens'), value: formatCompact(stats.cacheTokens), sub: `${formatTokens(stats.cacheTokens)} ${t('tokensUnit')}`, tone: 4 },
    // 缓存命中率 —cached share of all prompt tokens in the range.
    { icon: Activity, label: t('cacheRate'), value: cacheRateText(stats.cacheHit, stats.cacheMiss), hint: t('cacheRateHint'), sub: `${formatCompact(stats.cacheHit)} ${t('cachedTokens')}`, tone: 5 },
    // 请求数量 —provider calls (tokens or not). The failed share sits
    // underneath, and only when there were any: a healthy range stays a
    // single line. Failed calls are a SUBSET of requests, never additive.
    { icon: MessagesSquare, label: t('requests'), value: String(stats.requests), sub: stats.failures > 0 ? `${t('requestsFailed')} ${stats.failures} · ${formatPercent((stats.failures / Math.max(stats.requests, 1)) * 100)}` : undefined, tone: 6 },
  ]
  return (
    <div className={css.cards}>
      {cards.map((c) => (
        <div className={clsx(css.card, css[`cardTone${c.tone}`])} data-dsh-usage-glass="card" key={c.label} title={c.hint}>
          <div className={css.cardHead}>
            <c.icon className={css.cardIcon} size={14} strokeWidth={2} aria-hidden="true" />
            <span className={css.cardLabel}>{c.label}</span>
          </div>
          {c.sub !== undefined ? (
            <div className={clsx(css.cardValue, css.cardModelLines)}>
              <FitText text={c.value} className={css.cardValue} maxSize={22} />
              {/* The exact-count line is the longest text in the card: fit it
                  too (down to 8px) instead of letting it clip. */}
              <FitText text={c.sub} className={css.cardSub} maxSize={11} minSize={8} />
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
// the card width (long token numbers never overflow or wrap). `minSize` is
// the floor: secondary lines may shrink further than headline values.
function FitText({ text, className, maxSize, minSize = 11 }: { text: string; className?: string; maxSize: number; minSize?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(maxSize)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let s = maxSize
      el.style.fontSize = `${s}px`
      while (el.scrollWidth > el.clientWidth + 1 && s > minSize) {
        s -= 0.5
        el.style.fontSize = `${s}px`
      }
      setSize(s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, maxSize, minSize])

  return (
    <div ref={ref} className={className} style={{ fontSize: size }}>
      {text}
    </div>
  )
}

// ── Section 4: GitHub-style activity heatmap ──────────────────────────────

// Cell/gap ratio follows the reference chart (a GitHub-style green heatmap):
// roughly a third of the cell in gap, so the tiles read as separate rounded
// squares instead of a wash. The gap also equals the legend's own swatch
// spacing, and the fixed rx matches the legend swatch border-radius, so the
// key renders at exactly the chart's geometry.
const HEAT_BASE = 12 // cell size at which column trimming starts
const HEAT_GAP = 4 // breathing gap between cells; mirrors the legend swatch gap
const HEAT_RX = 2 // cell corner radius; matches the legend swatch (css .heatCell)

// ── heatmap axis gutters ──────────────────────────────────────────────────
// The chart now carries a weekday column on the left and month labels along
// the bottom (matching the GitHub-style reference). Both are drawn INSIDE the
// same SVG so a label sits on the exact cell track it names; the geometry
// solver only ever sees the width left over after these gutters are reserved.
const HEAT_AXIS_LEFT = 30 // px reserved left of the first cell column (weekday labels)
const HEAT_AXIS_BOTTOM = 18 // px reserved under the last row (month labels)

/** 0 = Monday … 6 = Sunday: row order of the heatmap, and the label keys. */
const DOW_KEYS = ['dow.mon', 'dow.tue', 'dow.wed', 'dow.thu', 'dow.fri', 'dow.sat', 'dow.sun'] as const
const MONTH_KEYS = ['month.jan', 'month.feb', 'month.mar', 'month.apr', 'month.may', 'month.jun', 'month.jul', 'month.aug', 'month.sep', 'month.oct', 'month.nov', 'month.dec'] as const

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
      // Reserve the weekday gutter so the cells solve against the space they
      // actually get; the SVG width below re-adds it.
      const avail = Math.max(1, el.clientWidth - 2 - HEAT_AXIS_LEFT)
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

  // Month labels: name a column only where its month differs from the
  // previous column's, so a run of weeks in one month gets a single label
  // sitting over its first week (the GitHub axis convention). The reading is
  // taken from the column's own top cell (row 0), which is the earliest day
  // that column holds.
  // The window is a whole number of weeks, so it can wrap back into the month
  // it started in; that trailing label would sit in the last column and be
  // clipped by the wrap's overflow. Drop it — it repeats the first label.
  const monthLabels: Array<{ col: number; month: number }> = []
  let lastMonth = -1
  for (let i = 0; i < days.length; i++) {
    const col = Math.floor((i + startOffset) / 7)
    if ((i + startOffset) % 7 !== 0) continue // only the column's first day
    const m = new Date(days[i]! + 'T00:00:00').getMonth()
    if (m !== lastMonth) {
      monthLabels.push({ col, month: m })
      lastMonth = m
    }
  }
  while (monthLabels.length > 1 && monthLabels[0]!.month === monthLabels[monthLabels.length - 1]!.month) monthLabels.pop()

  const cellW = geom.size + HEAT_GAP
  const svgW = HEAT_AXIS_LEFT + weeks * cellW + HEAT_GAP
  const svgH = rows * cellW + HEAT_GAP + HEAT_AXIS_BOTTOM

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('heatmap')}</h3>
        <div className={css.heatLegend}>
          <span>{t('heatLess')}</span>
          <i className={clsx(css.heatCell, css.heatLevel0)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel1)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel2)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel3)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel4)} style={{ width: geom.size, height: geom.size }} />
          <i className={clsx(css.heatCell, css.heatLevel5)} style={{ width: geom.size, height: geom.size }} />
          <span>{t('heatMore')}</span>
        </div>
      </div>
      <div className={css.heatWrap} ref={wrapRef}>
        <svg className={css.heatmap} width={svgW} height={svgH} role="img" aria-label={t('heatmap')}>
          {/* Weekday gutter: every row is named Mon…Sun so a bar reads by day. */}
          {DOW_KEYS.map((key, row) => (
            <text
              key={key}
              className={css.heatAxis}
              x={HEAT_AXIS_LEFT - 8}
              y={HEAT_GAP + row * cellW + geom.size / 2}
              textAnchor="end"
              dominantBaseline="central"
            >
              {t(key)}
            </text>
          ))}
          {days.map((day, i) => {
            const col = Math.floor((i + startOffset) / 7)
            const row = (i + startOffset) % 7
            const rec = byDay.get(day)
            const tokens = rec?.total ?? 0
            const level = tokens === 0 ? 0 : 1 + Math.floor((tokens / max) * 4)
            const x = HEAT_AXIS_LEFT + HEAT_GAP + col * cellW
            const y = HEAT_GAP + row * cellW
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
          {/* Month gutter: one label per month, over the column it starts in. */}
          {monthLabels.map(({ col, month }) => (
            <text
              key={`${col}-${month}`}
              className={css.heatAxis}
              x={HEAT_AXIS_LEFT + HEAT_GAP + col * cellW}
              y={rows * cellW + HEAT_GAP + 3}
              textAnchor="start"
              dominantBaseline="hanging"
            >
              {t(MONTH_KEYS[month]!)}
            </text>
          ))}
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
  // What the X axis reads as depends on the WINDOW, not just the granularity:
  // a multi-day hourly span (3天) is a DATE axis — one short date per day,
  // centred over that day's bar cluster, times would be noise across three
  // day-clusters; a single-day hourly span (今日) is a CLOCK axis — the date is
  // constant and would only repeat. Daily ranges stay date labels.
  const dayCount = new Set(visible.map((d) => d.day.slice(0, 10))).size
  const multiDayHourly = granularity === 'hour' && dayCount > 1
  const axisMode: 'day' | 'hour' = multiDayHourly ? 'day' : granularity
  // Label groups: on a multi-day hourly axis each DAY is one group whose label
  // sits at the MIDDLE of that day's bars (centred on the day, not left-
  // aligned to its first bar); otherwise every bucket is its own group and
  // the label sits on its bar.
  const labelGroups: Array<{ start: number; end: number }> = []
  for (let i = 0; i < n; i++) {
    const last = labelGroups[labelGroups.length - 1]
    if (multiDayHourly && last && visible[last.end].day.slice(0, 10) === visible[i].day.slice(0, 10)) last.end = i
    else labelGroups.push({ start: i, end: i })
  }
  // Groups are then thinned by POSITION, walking from the right edge: the
  // rightmost group always keeps its label, an earlier one is kept only when
  // it clears the previously kept label by the label width. (A fixed "every
  // Nth" count plus a forced last label drew two labels on top of each other
  // — the "18:00/23:00" overlap.) Both label shapes are ~30px.
  const labelMinGap = 42
  const labeledGroups = new Set<number>()
  let lastLabelX = Number.POSITIVE_INFINITY
  for (let k = labelGroups.length - 1; k >= 0; k--) {
    const g = labelGroups[k]!
    const x = padL + barHalf + ((g.start + g.end) / 2) * step
    if (lastLabelX - x >= labelMinGap) {
      labeledGroups.add(k)
      lastLabelX = x
    }
  }

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
        <div className={css.headMeta}>
          {trendCapped && <span className={css.trendNote}>{t('trendLimited').replace('{n}', String(view.trimN))}</span>}
          <span className={css.legendItem}><i className={css.legendTrend} aria-hidden="true" />{t('cacheHitRate')}</span>
        </div>
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
              </g>
            )
          })}
          {labelGroups.map((g, k) => labeledGroups.has(k) && (
            <text
              key={`axis-${k}`}
              className={css.axis}
              x={padL + barHalf + ((g.start + g.end) / 2) * step}
              y={H - 8}
              textAnchor="middle"
            >{bucketAxisLabel(visible[g.start].day, axisMode)}</text>
          ))}
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

// ── Section 6: bottom ranking — top 8 by model / by provider ──────────────
//
// Two side-by-side cards, always on screen (no tabs): the left card ranks
// MODELS, the right ranks PROVIDERS, each listing its top 8 rows.
//
// The by-model card aggregates by MODEL NAME, not by the provider/model ref:
// the same model served through two providers must show as ONE row
// (同名模型不同供应商需要聚合). The by-provider card is already aggregated by
// provider upstream, so it ranks the provider rows the host returned, labelled
// with the selector's display name (`providerNames`).
//
// Both cards keep the same row anatomy — rank, swatch, name, tokens, share,
// cache hit rate — and move the cross-dimension detail into the hover tip: a
// model row explains which providers served it, a provider row explains which
// models it served. Hovering therefore never displaces the share column.

/** One child line of a row's hover detail (a provider under a model, or a
 *  model under a provider). `tokens` is null when the host payload predates
 *  the cross-dimension split and only the source NAME is known. */
interface RankChild {
  key: string
  name: string
  tokens: number | null
  color: string
}

/** The hover detail of one ranked row. The tip itself renders once, in
 *  UsageBreakdown, so only one row can be explained at a time. */
interface RankTip {
  anchor: Element
  title: string
  /** The raw route id, set only when it differs from the display label. */
  subtitle?: string
  tokens: number
  cacheHit: number
  cacheMiss: number
  breakdownLabel: string
  breakdown: RankChild[]
}

interface BreakdownRow {
  key: string
  name: string
  subtitle?: string
  tokens: number
  cacheHit: number
  cacheMiss: number
  color: string
  breakdownLabel: string
  breakdown: RankChild[]
}

/** Provider hues run 1..5 then the gray tail (a provider beyond the palette is
 *  rare: the card lists 8 rows, the palette names 5). */
function providerColor(index: number): string {
  return index < 5 ? `var(--dsw-provider-${index + 1})` : 'var(--dsw-provider-other)'
}

function UsageBreakdown({ models, providers, total, providerNames, t, panelRef, colorForModel }: {
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
  total: number
  providerNames?: Record<string, string>
  t: Translator
  panelRef: RefObject<HTMLDivElement | null>
  /** The trend's model palette (rank in `models`), so a model wears the same
   *  hue in the bars, the tooltips and both rankings. */
  colorForModel: (model: string) => string
}) {
  const [tip, setTip] = useState<RankTip | null>(null)

  // The display label for a provider route: the host-resolved selector name
  // when there is one, else the raw historical id (a deleted/renamed route).
  // The typeof guard keeps a prototype-shaped key ("constructor") from being
  // read as a label.
  const providerLabel = useCallback((provider: string): string => {
    const named = providerNames?.[provider]
    return typeof named === 'string' && named.trim() !== '' ? named : provider
  }, [providerNames])

  const shareText = (n: number): string => (total > 0 ? formatPercent((n / total) * 100) : '—')

  // One provider, one hue EVERYWHERE: the palette indexes the provider
  // ranking, so a provider keeps its colour as a card row AND as another
  // row's breakdown child. Per-child ranks used to renumber the same
  // provider differently in every row.
  const providerColorOf = useCallback((provider: string): string => {
    const slot = providers.findIndex((p) => p.provider === provider)
    return slot < 0 ? 'var(--dsw-provider-other)' : providerColor(slot)
  }, [providers])

  const modelRows = useMemo<BreakdownRow[]>(() => {
    const byName = new Map<string, {
      tokens: number
      cacheHit: number
      cacheMiss: number
      /** Provider -> tokens, from the host's cross-dimension split. */
      split: Map<string, number>
      /** Every provider the host named, split or not. */
      sources: Set<string>
    }>()
    for (const m of models) {
      const name = m.model
      const acc = byName.get(name) ?? { tokens: 0, cacheHit: 0, cacheMiss: 0, split: new Map<string, number>(), sources: new Set<string>() }
      acc.tokens += m.tokens
      acc.cacheHit += m.cacheHit
      acc.cacheMiss += m.cacheMiss
      for (const item of m.providerTokens ?? []) {
        acc.split.set(item.provider, (acc.split.get(item.provider) ?? 0) + item.tokens)
      }
      for (const provider of m.providers ?? (m.provider === '' ? [] : [m.provider])) acc.sources.add(provider)
      byName.set(name, acc)
    }
    return [...byName.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, TOP_BREAKDOWN)
      .map(([name, acc]) => {
        const split: RankChild[] = [...acc.split.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([provider, tokens]) => ({ key: provider, name: providerLabel(provider), tokens, color: providerColorOf(provider) }))
        // A payload from before the split still names its sources; list them
        // without a volume rather than inventing a number.
        const known = new Set(split.map((child) => child.key))
        const named: RankChild[] = [...acc.sources]
          .filter((provider) => !known.has(provider))
          .sort()
          .map((provider) => ({ key: provider, name: providerLabel(provider), tokens: null, color: providerColorOf(provider) }))
        return {
          key: name,
          name,
          tokens: acc.tokens,
          cacheHit: acc.cacheHit,
          cacheMiss: acc.cacheMiss,
          color: colorForModel(name),
          breakdownLabel: t('byProvider'),
          breakdown: [...split, ...named],
        }
      })
  }, [models, providerLabel, t, colorForModel, providerColorOf])

  const providerRows = useMemo<BreakdownRow[]>(() => {
    return [...providers]
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_BREAKDOWN)
      .map((p) => {
        const label = providerLabel(p.provider)
        return {
          key: p.provider,
          name: label,
          // Keep the route id reachable: the row shows the display name only.
          subtitle: label === p.provider ? undefined : p.provider,
          tokens: p.tokens,
          cacheHit: p.cacheHit,
          cacheMiss: p.cacheMiss,
          color: providerColorOf(p.provider),
          breakdownLabel: t('byModel'),
          breakdown: [...(p.modelTokens ?? [])]
            .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
            .map((m) => ({ key: m.model, name: m.model, tokens: m.tokens, color: colorForModel(m.model) })),
        }
      })
  }, [providers, providerLabel, t, colorForModel, providerColorOf])

  return (
    <section className={css.section}>
      <div className={css.sectionHead}>
        {/* One heading for the whole section: both rankings are always on
            screen, side by side, so there is no lens to switch. */}
        <h3 className={css.sectionTitle}>{t('usageRanking')}</h3>
      </div>
      <div className={css.rankCards}>
        <RankCard title={t('byModel')} rows={modelRows} total={total} t={t} onTip={setTip} />
        <RankCard title={t('byProvider')} rows={providerRows} total={total} t={t} onTip={setTip} />
      </div>
      <ChartTip anchor={tip?.anchor ?? null} panelRef={panelRef}>
        {tip && (
          <>
            <div className={css.tipTitle}>{tip.title}</div>
            {tip.subtitle !== undefined && <div className={css.tipSubtitle}>{tip.subtitle}</div>}
            <div className={css.tipRow}>{t('total')} {formatTokens(tip.tokens)} · {shareText(tip.tokens)}</div>
            <div className={css.tipRow}>{t('cacheRateColumn')} {cacheRateText(tip.cacheHit, tip.cacheMiss)}</div>
            {tip.breakdown.length > 0 && (
              <div className={css.tipBreakdown}>
                <div className={css.tipLabel}>{tip.breakdownLabel}</div>
                {tip.breakdown.map((child) => (
                  <div key={child.key} className={css.tipRow}>
                    <i className={css.legendSwatch} style={{ background: child.color }} />
                    <span className={css.tipName}>{child.name}</span>
                    <span className={css.tipValue}>
                      {child.tokens === null ? '' : `${formatCompact(child.tokens)} · ${shareText(child.tokens)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </ChartTip>
    </section>
  )
}

/** One ranking card: a titled list whose rows explain themselves on hover.
 *  The tip is owned by UsageBreakdown (one open tip at a time), so a row only
 *  reports which row it is, never where to draw. */
function RankCard({ title, rows, total, t, onTip }: {
  title: string
  rows: BreakdownRow[]
  total: number
  t: Translator
  onTip: (tip: RankTip | null) => void
}) {
  const share = (n: number): string => (total > 0 ? formatPercent((n / total) * 100) : '—')
  return (
    <div className={css.rankCard}>
      <div className={css.rankCardTitle}>{title}</div>
      {rows.length === 0 ? (
        <div className={css.empty}>{t('empty')}</div>
      ) : (
        <ul className={css.rankList} data-dsh-usage-glass="list">
          {rows.map((r, rank) => (
            <li
              key={r.key}
              className={css.modelRow}
              onMouseEnter={(e) => onTip({
                anchor: e.currentTarget,
                title: r.name,
                subtitle: r.subtitle,
                tokens: r.tokens,
                cacheHit: r.cacheHit,
                cacheMiss: r.cacheMiss,
                breakdownLabel: r.breakdownLabel,
                breakdown: r.breakdown,
              })}
              onMouseLeave={() => onTip(null)}
            >
              <span className={css.modelRank} aria-hidden="true">{rank + 1}</span>
              <i className={css.legendSwatch} style={{ background: r.color }} />
              <div className={css.modelId}>
                <span className={css.modelName}>{r.name}</span>
                {/* The share keeps its own line: the hover detail never
                    displaces it (悬浮详情不占用百分比的位置). */}
                <span className={css.modelProvider}>{share(r.tokens)}</span>
                {/* Share bar: the row's slice of the total, in its own colour. */}
                <div className={css.rowTrack} aria-hidden="true">
                  <i
                    className={css.rowFill}
                    style={{ width: total > 0 ? `${Math.min(100, (r.tokens / total) * 100)}%` : '0%', background: r.color }}
                  />
                </div>
              </div>
              <div className={css.modelValues}>
                <span className={css.modelTokens}>{formatCompact(r.tokens)}</span>
                <span className={css.modelPct}>{t('cacheRateColumn')} {cacheRateText(r.cacheHit, r.cacheMiss)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
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

