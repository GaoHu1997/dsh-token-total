/**
 * The two cards that replaced the context-window panel.
 *
 * Left: what the window holds RIGHT NOW (the context snapshot). Right: what the
 * session's requests actually spent, split by content (the spend composition).
 * They answer two different questions — "what is in the prompt" and "what did
 * the whole session pay for" — so they sit side by side at equal weight rather
 * than one above the other.
 *
 * Everything is drawn from the detail payload the view already polls every
 * 1.5 s (`useSessionDetail`), so both cards refresh with no extra timer. The
 * charts are hand-rolled SVG/CSS: the plugin ships no chart dependency, and a
 * ring plus a stacked bar is little enough markup to keep it that way.
 *
 * The palette is the plugin's tone scale, matching the stat cards above and the
 * dashboard charts; dark values flip under `body[data-ds-dark-theme]` (the
 * host's own theme switch), and every surface uses the host's semantic tokens
 * so the cards sit on the same canvas as the tables.
 */
import type {
  SessionContextWindow,
  SessionUsageBucket,
  SessionUsageComposition,
  SessionUsageDetail,
} from '../wire.ts'
import { bucketPercent, contextBucketTotals, contextReading } from './context-window-core.ts'
import { cacheRate, formatCompact, formatPercent, formatTokens } from './format.ts'
import { cacheHitPercentOf } from './session-usage-core.ts'
import type { SessionUsageKey } from './session-usage-locales.ts'
import { CONTEXT_BUCKET_ORDER, USAGE_BUCKET_ORDER } from '../usage-buckets.ts'
import css from './UsageCards.module.css'

type T = (key: SessionUsageKey, params?: Record<string, string>) => string

/** Legend names, one per bucket (the context-window panel's category names are
 *  a different split — files live inside tool results here). */
const BUCKET_LABEL: Record<SessionUsageBucket, SessionUsageKey> = {
  systemPrompt: 'bucketSystemPrompt',
  user: 'bucketUser',
  skill: 'bucketSkill',
  toolResult: 'bucketToolResult',
  toolDef: 'bucketToolDef',
  injected: 'bucketInjected',
  assistant: 'bucketAssistant',
  output: 'bucketOutput',
}

/** Each bucket brings its own accent as a CSS custom property, so the swatch,
 *  the ring segment, the bar segment and the value text all read one variable. */
const BUCKET_TONE: Record<SessionUsageBucket, string> = {
  systemPrompt: css.toneSystemPrompt,
  user: css.toneUser,
  skill: css.toneSkill,
  toolResult: css.toneToolResult,
  toolDef: css.toneToolDef,
  injected: css.toneInjected,
  assistant: css.toneAssistant,
  output: css.toneOutput,
}

interface Row {
  key: SessionUsageBucket
  tokens: number
}

/** Approximate value as the card prints it: "≈299.1k". */
const approx = (n: number): string => `≈${formatCompact(n)}`

/** Ring geometry: a 116 px donut with a 15 px stroke. */
const RING_SIZE = 116
const RING_STROKE = 15
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2 - 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Donut of bucket shares with the grand total in the middle. Segments are
 *  stroked along one circle and offset by the running length, so the ring is
 *  DPI-independent and needs no chart library. `total` sizes the segments (the
 *  replay estimate); `center` is the exact billed figure the card headlines. */
function Ring({ rows, total, center, centerTitle, caption }: {
  rows: readonly Row[]
  total: number
  center: string
  centerTitle: string
  caption: string
}): JSX.Element {
  const drawn = rows.filter(row => row.tokens > 0)
  let offset = 0
  return <div className={css.ringWrap}>
    <svg className={css.ring} width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="img" aria-label={caption}>
      <title>{caption}</title>
      <circle className={css.ringTrack} cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" strokeWidth={RING_STROKE} />
      <g transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}>
        {drawn.map(row => {
          const length = total > 0 ? (row.tokens / total) * RING_CIRCUMFERENCE : 0
          // A hairline gap keeps adjacent hues from merging into one band; the
          // segment never shrinks below 0.6 px even when it is a rounding crumb.
          const visible = Math.max(length - 1.2, 0.6)
          const dash = `${visible} ${RING_CIRCUMFERENCE - visible}`
          const circle = <circle
            key={row.key}
            className={BUCKET_TONE[row.key]}
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--bucket)"
            strokeWidth={RING_STROKE}
            strokeDasharray={dash}
            strokeDashoffset={-offset}
          />
          offset += length
          return circle
        })}
      </g>
    </svg>
    <div className={css.ringCenter}>
      <strong className={css.ringTotal} title={centerTitle}>{center}</strong>
      <span className={css.ringCaption}>{caption}</span>
    </div>
  </div>
}

/** One legend entry: swatch, name, share, approximate value. */
function LegendRow({ row, percent, suffix, t }: {
  row: Row
  percent: number
  suffix?: string
  t: T
}): JSX.Element {
  return <li className={`${css.legendRow} ${BUCKET_TONE[row.key]}`}>
    <i className={css.swatch} aria-hidden="true" />
    <span className={css.legendName}>{t(BUCKET_LABEL[row.key])}</span>
    <span className={css.legendPercent}>{percent.toFixed(1)}%</span>
    <span className={css.legendValue} title={formatTokens(row.tokens)}>
      {approx(row.tokens)}{suffix === undefined ? '' : <span className={css.legendSuffix}> · {suffix}</span>}
    </span>
  </li>
}

/** Left card: the live window's composition, its occupancy and the hard cap. */
function ContextCard({ context, t }: { context: SessionContextWindow; t: T }): JSX.Element {
  const reading = contextReading(context)
  const rows = contextBucketTotals(context.items)
  // Percentages answer "what share of the window's content", so they divide by
  // the sum of the drawn buckets — not by the billed prompt, which can differ
  // when upstream content rewriting happens. Occupancy keeps its own reading.
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  // The strip spans the model's window, never just the used part: each segment
  // takes its share of the drawn content times the share of the window in use,
  // so the tinted run stops exactly where "used" stops and the track behind it
  // is the room still free. Without a reported window there is no scale to draw
  // against, so the strip falls back to the drawn content itself.
  const capacity = context.contextWindow !== null && context.contextWindow > 0 ? context.contextWindow : total
  const occupied = Math.min(100, bucketPercent(reading.usedTokens, capacity))
  const windowText = context.contextWindow !== null && context.contextWindow > 0
    ? t('contextWindowTotal', { used: formatCompact(reading.usedTokens), window: formatCompact(context.contextWindow) })
    : t('contextWindowTotalUnknown', { used: formatCompact(reading.usedTokens) })
  return <section className={`${css.card} ${css.contextCard}`}>
    <header className={css.head}>
      <h2 className={css.title}>{t('currentContextTitle')}</h2>
      <span className={css.model} title={`${context.provider} / ${context.model}`}>
        {[context.provider, context.model].filter(Boolean).join(' · ') || '—'}
      </span>
    </header>
    <div className={css.body}>
      <div className={css.totalRow}>
        <strong className={css.total} title={formatTokens(reading.usedTokens)}>{windowText}</strong>
        {reading.percent !== null && <span className={css.totalShare}>
          <b>{formatPercent(reading.percent)}</b> {t('contextUsedShort')}
        </span>}
      </div>
      {/* One stacked strip across the whole window: a bucket's width is its
          share of what the next request carries, scaled by how full the window
          is, so the remainder reads as the room still free. */}
      <div className={css.bar} role="img" aria-label={t('currentContextTitle')}>
        {rows.map(row => row.tokens > 0 && total > 0
          ? <span key={row.key} className={`${css.barSeg} ${BUCKET_TONE[row.key]}`} style={{ width: `${bucketPercent(row.tokens, total) * occupied / 100}%` }} />
          : null)}
        {total <= 0 && <span className={css.barEmpty} />}
      </div>
      <ul className={css.legend}>
        {rows.map(row => <LegendRow key={row.key} row={row} percent={bucketPercent(row.tokens, total)} t={t} />)}
      </ul>
    </div>
  </section>
}

/** Right card: every request's replayed content plus the billed output. */
function StatsCard({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element {
  const composition = detail.composition ?? null
  const rows = composition?.buckets ?? []
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const billed = composition?.billedTokens ?? 0
  // Prefer the session's exact cache split; the live window's snapshot is the
  // fallback for an older host payload that predates the composition.
  const hit = composition !== null
    ? cacheHitPercentOf(composition.totals)
    : detail.context?.cacheKnown
      ? cacheRate(detail.context.cacheHitTokens, detail.context.cacheMissTokens)
      : null
  return <section className={`${css.card} ${css.statsCard}`}>
    <header className={css.head}>
      <h2 className={css.title}>{t('statsTitle')}</h2>
      {hit !== null && <span className={css.cacheBadge}>
        {t('statsCacheHit')} <b>{hit.toFixed(2)}%</b>
      </span>}
    </header>
    <div className={css.body}>
      {composition === null
        ? <p className={css.empty}>{t('statsEmpty')}</p>
        : <>
          <div className={css.statsMain}>
            <Ring rows={rows} total={total} center={formatCompact(billed)} centerTitle={formatTokens(billed)} caption={t('statsTotal')} />
            <ul className={css.legend}>
              {USAGE_BUCKET_ORDER.map(key => {
                const row = rows.find(item => item.key === key) ?? { key, tokens: 0 }
                return <LegendRow
                  key={key}
                  row={row}
                  percent={bucketPercent(row.tokens, total)}
                  suffix={key === 'output' ? t('statsIncludesThinking') : undefined}
                  t={t}
                />
              })}
            </ul>
          </div>
        </>}
    </div>
  </section>
}

/** The pair, rendered where the context-window panel used to sit. */
export function SessionUsageCards({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element | null {
  if (detail.context === null || detail.context === undefined) {
    if (detail.composition === null || detail.composition === undefined) return null
    return <div className={css.grid}>
      <StatsCard detail={detail} t={t} />
    </div>
  }
  return <div className={css.grid}>
    <ContextCard context={detail.context} t={t} />
    <StatsCard detail={detail} t={t} />
  </div>
}
