import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionContextCategory, SessionContextItem, SessionContextWindow } from '../wire.ts'
import { CONTEXT_CATEGORY_ORDER, contextCategoryTotals, contextReading, treemapLayout } from './context-window-core.ts'
import { cacheRate, formatCompact, formatPercent, formatTokens } from './format.ts'
import type { SessionUsageKey } from './session-usage-locales.ts'
import css from './ContextWindowPanel.module.css'

type T = (key: SessionUsageKey, params?: Record<string, string>) => string

const CATEGORY_LABEL: Record<SessionContextCategory, SessionUsageKey> = {
  system: 'contextSystem', tools: 'contextTools', memory: 'contextMemory',
  files: 'contextFiles', results: 'contextResults', conversation: 'contextConversation',
}
const CATEGORY_TONE: Record<SessionContextCategory, string> = {
  system: css.toneSystem, tools: css.toneTools, memory: css.toneMemory,
  files: css.toneFiles, results: css.toneResults, conversation: css.toneConversation,
}
/** Which locale string names an injected/system row, keyed by its log kind. */
const KIND_LABEL: Record<string, SessionUsageKey> = {
  'system-prompt': 'contextKindSystemPrompt',
  'runtime-context': 'contextKindRuntimeContext',
  'skill-catalog': 'contextKindSkillCatalog',
  'time-context': 'contextKindTimeContext',
  'compaction-summary': 'contextKindCompaction',
  user: 'contextKindUser',
  assistant: 'contextKindAssistant',
}

/** What one treemap tile is called: a tool name or path as-is, an
 *  injected kind through the dictionary, and a folded tail as "N more". */
function itemText(item: SessionContextItem, t: T): string {
  if (item.kind === 'rest') return t('contextKindRest', { count: String(item.count) })
  const label = item.kind === undefined ? undefined : KIND_LABEL[item.kind]
  const base = label !== undefined ? t(label) : item.label || item.kind || ''
  // Repeated entries of one kind (a tool ran 63 times, five user prompts) keep
  // their multiplicity visible: that repetition is what makes them bulky.
  return item.count > 1 ? `${base} ${t('contextTimes', { count: String(item.count) })}` : base
}

const sumOf = (items: readonly SessionContextItem[]): number => items.reduce((sum, item) => sum + item.tokens, 0)

/** Wall-clock stamp of the last successful read, same shape as the page's. */
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Hover-card footprint estimate, so the tip can be kept inside the map
 *  without measuring itself first. */
const TIP_W = 220
const TIP_H = 70

/** The hover card for one tile: name and call count, the exact token count
 *  with its category, and the block's share of the estimate and of the
 *  model's window — the figures a tile has no room to print. */
function Tip({ item, box, map, t, total, contextWindow }: {
  item: SessionContextItem
  box: { x: number; y: number; width: number; height: number }
  map: { width: number; height: number }
  t: T
  total: number
  contextWindow: number | null
}): JSX.Element {
  const share = total > 0 ? formatPercent(item.tokens / total * 100) : null
  const windowShare = contextWindow !== null && contextWindow > 0 ? formatPercent(item.tokens / contextWindow * 100) : null
  // Under the tile's center by default, flipping above it near the map floor,
  // clamped to the map so overflow:hidden never clips the tip away.
  const left = Math.min(Math.max(box.x + box.width / 2 - TIP_W / 2, 4), Math.max(4, map.width - TIP_W - 4))
  const top = box.y + box.height + 6 + TIP_H < map.height - 4
    ? box.y + box.height + 6
    : Math.max(4, box.y - TIP_H - 6)
  return <div className={css.tip} role="tooltip" style={{ left, top }}>
    <div className={css.tipName}>{itemText(item, t)}</div>
    <div className={css.tipMeta}>{formatTokens(item.tokens)} token · {t(CATEGORY_LABEL[item.category])}</div>
    {share !== null && <div className={css.tipShare}>
      {t('contextTipShare', { percent: share })}{windowShare === null ? '' : ` · ${t('contextTipWindow', { percent: windowShare })}`}
    </div>}
  </div>
}

function Treemap({ items, t, contextWindow }: { items: SessionContextItem[]; t: T; contextWindow: number | null }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Hover state is keyed by block, not by tile instance, so the tip follows its
  // block across refreshes even while the boxes re-lay-out underneath it.
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  // The treemap needs real pixels: measure the box and re-lay out on resize
  // (the Usage page is a container-query surface, so widths change freely).
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const measure = (): void => setSize(previous => {
      const width = host.clientWidth
      const height = host.clientHeight
      return previous.width === width && previous.height === height ? previous : { width, height }
    })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  const boxes = useMemo(
    () => treemapLayout(items.map(item => ({ key: item.key, tokens: item.tokens })), size.width, size.height),
    [items, size.width, size.height],
  )
  const byKey = useMemo(() => new Map(items.map(item => [item.key, item])), [items])
  const hoverBox = hoverKey === null ? undefined : boxes.find(box => box.key === hoverKey)
  const hoverItem = hoverBox === undefined ? undefined : byKey.get(hoverBox.key)
  return <div ref={hostRef} className={css.map} onMouseLeave={() => setHoverKey(null)}>
    {boxes.map(box => {
      const item = byKey.get(box.key)
      if (item === undefined || box.width <= 0 || box.height <= 0) return null
      const text = itemText(item, t)
      // Tiles shed their captions before they shed their color: a label needs
      // room for two glyphs plus padding, the size line needs a second row.
      const showLabel = box.width >= 46 && box.height >= 22
      const showSize = box.width >= 62 && box.height >= 40
      return <div key={box.key} className={css.slot}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        onMouseEnter={() => setHoverKey(box.key)}
        aria-label={`${text} · ${formatTokens(item.tokens)} token · ${t(CATEGORY_LABEL[item.category])}`}>
        <div className={`${css.tile} ${CATEGORY_TONE[item.category]}`}>
          {showLabel && <span className={css.tileLabel}>{text}</span>}
          {showSize && <span className={css.tileSize}>{formatCompact(item.tokens)} · {t(CATEGORY_LABEL[item.category])}</span>}
        </div>
      </div>
    })}
    {hoverBox !== undefined && hoverItem !== undefined &&
      <Tip item={hoverItem} box={hoverBox} map={size} t={t} total={sumOf(items)} contextWindow={contextWindow} />}
  </div>
}

/** The context-window panel above the Usage cards, in magpie's shape: the used
 *  total and the model's window on the left, the newest answer's prompt-cache
 *  split on the right, a treemap of what occupies the window below (with a
 *  hover card per tile), and one legend row naming the six buckets with their
 *  sizes. Every figure is an estimate, so the panel never claims an exact
 *  count — and the live pill stamps when the estimate was last refreshed. */
export function ContextWindowPanel({ context, t, updatedAt }: {
  context: SessionContextWindow
  t: T
  /** Wall-clock ms of the last successful read, when the host reports one. */
  updatedAt?: number | null
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const totals = contextCategoryTotals(context.items)
  const reading = contextReading(context)
  const percent = reading.percent
  const hitRate = context.cacheKnown ? cacheRate(context.cacheHitTokens, context.cacheMissTokens) : null
  const model = context.model !== '' && !context.model.includes('/') && context.provider !== ''
    ? `${context.provider}/${context.model}`
    : context.model
  const windowText = context.contextWindow === null
    ? t('contextWindowUnknown')
    : t('contextWindowKnown', {
      value: formatCompact(context.contextWindow),
      percent: String(percent ?? 0),
    })
  return <section className={css.panel} data-dsh-context-window>
    {/* Collapsed, the body's spacing is gone, so the header pads its own
        bottom — otherwise the folded row reads heavy on top. */}
    <header className={open ? css.head : `${css.head} ${css.headCollapsed}`}>
      <button type="button" className={css.toggle} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="dsh-context-window-body">
        <svg className={`${css.chevron} ${open ? css.chevronOpen : ''}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
        <h2>{t('contextTitle')}</h2>
      </button>
      <div className={css.headRight}>
        {model !== '' && <span className={css.model} title={`${context.provider} / ${context.model}`}>{model}</span>}
        <span className={css.livePill}>
          <span className={css.liveDot} aria-hidden="true" />
          {t('contextLive')}
          {typeof updatedAt === 'number' && <span className={css.liveTime}> · {clock(updatedAt)}</span>}
        </span>
      </div>
    </header>
    <div id="dsh-context-window-body" className={css.body} hidden={!open}>
      <div className={css.summary}>
        <div className={css.used}>
          <span className={css.label}>{t('contextUsed')}</span>
          <strong className={css.total} title={formatTokens(reading.usedTokens)}>{formatCompact(reading.usedTokens)}<small>token</small></strong>
          <span className={css.window}>{windowText}</span>
        </div>
        <div className={css.cache}>
          <span className={css.label}>{t('contextCache')}</span>
          <div className={css.cacheBar}>
            {hitRate === null
              ? <span className={css.cacheEmpty} />
              : <>
                <span className={css.cacheHit} style={{ width: `${hitRate}%` }} />
                <span className={css.cacheMiss} style={{ width: `${100 - hitRate}%` }} />
              </>}
          </div>
          <div className={css.cacheLegend}>
            {hitRate === null
              ? <span className={css.cachePending}>{t('contextCachePending')}</span>
              : <>
                <span><i className={css.cacheHitDot} aria-hidden="true" />{t('contextCacheHit')} {formatPercent(hitRate)}</span>
                <span><i className={css.cacheMissDot} aria-hidden="true" />{t('contextCacheMiss')} {formatPercent(100 - hitRate)}</span>
              </>}
          </div>
        </div>
      </div>
      {reading.estimateDiffers && <p className={css.note}>
        {t('contextEstimateNote', { estimate: formatCompact(reading.estimateTokens), billed: formatCompact(reading.usedTokens) })}
      </p>}
      {context.items.length === 0
        ? <p className={css.empty}>{t('contextEmpty')}</p>
        : <Treemap items={context.items} t={t} contextWindow={context.contextWindow} />}
      {totals.length > 0 && <ul className={css.legend}>
        {totals.map(row => <li key={row.key}>
          <span className={`${css.swatch} ${CATEGORY_TONE[row.key]}`} aria-hidden="true" />
          <span className={css.legendName}>{t(CATEGORY_LABEL[row.key])}</span>
          <span className={css.legendValue}>{formatCompact(row.tokens)}</span>
        </li>)}
      </ul>}
    </div>
  </section>
}

/** Legend order shared with the CSS tone classes (kept exported for tests). */
export const CONTEXT_LEGEND_ORDER = CONTEXT_CATEGORY_ORDER
