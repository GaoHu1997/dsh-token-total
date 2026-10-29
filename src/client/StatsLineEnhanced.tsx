/**
 * The composer-dock takeover: replicates the official ui-chat StatsPills - a
 * gauge pill (turn/step counts + output speed, click opens the time-and-speed
 * dialog) and a database pill (total tokens + cache hit, click opens the
 * token-usage dialog). The official package is not a client-bundle external,
 * so its internals cannot be imported; the replicated pure folds live in
 * stats-line-core (same derivation, covered by the core tests) and the dialog
 * seat in stat-dialog.ts.
 *
 * ONE published build serves BOTH dock contracts, because the host line
 * decides how many entries the row is:
 *  - DSH <= 0.2.0-rc.2 exposes a single `stats` entry, so the whole row is
 *    one registration: `StatsLineEnhanced` (id 'stats', priority -1) renders
 *    the root container the two pills live in and owns their shared exclusive
 *    dialog slot;
 *  - DSH >= 0.2.1-alpha.1 split that entry into `activity` (counts/speed/time)
 *    and `usage` (tokens/cache), so each pill is its own registration at its
 *    own id: `StatsActivityEntry` and `StatsUsageEntry`. There is no row
 *    element any more - the host's `.dock` flex row lays the entries out, and
 *    the anchors carry the tier `.root` used to own (`css.dockAnchor`) - and
 *    each pill owns its dialog state, with mutual exclusion coming from
 *    stat-dialog's capture-phase outside click.
 * Which pair to register is read from the dock's entry ledger in
 * src/client/index.tsx.
 *
 * Streaming throughput is always enabled; no stored preference gates it. The
 * three columns are style-for-style the official ones: same tier, radius,
 * colours, same dialog rows and the same integer cache-hit figure. The one
 * difference is the middle figure's SCOPE — it totals the whole session tree
 * (this agent plus every subagent it spawned), which the native projection
 * cannot see.
 *
 * Streaming throughput replaces the gauge pill's speed
 * figure with a live estimate of what is happening now, and hands the slot back
 * to the session's decode average when nothing is streaming. While a step
 * streams the live rate is the only reading that can match the pace of the
 * answer on screen; once the step settles it becomes a figure from a window
 * nobody is watching any more, so the pill returns to the same quotient the
 * usage view quotes (ΣoutputTokens / ΣdecodeMs) instead of freezing on the last
 * measurement. That subscription lives in its own child component, so stream
 * deltas never re-render the pills. The live
 * figure itself is measured by a bounded sliding window over observed token
 * growth (stats-line-core's StreamingRateSampler): the earlier cumulative
 * quotient charged a whole step's text to a window that had just opened, so a
 * frame published late read as thousands of tok/s and then decayed.
 *
 * Kernel contract (DSH >= 0.1.2-rc.1): the slot's standard session selector
 * is injected as `useChat` over the ui-chat ChatSnapshot; the `legacy.nodes`
 * compatibility projection carries the ConversationNode[] that officially
 * backs the pills, `legacy.partial` the in-flight assistant output, and the
 * durable sessionStats projection stays the primary source.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { DatabaseIcon, GaugeIcon } from './stats-icons.tsx'
import { LOCALE_NS } from './locales.ts'
import { MEASURE_STYLE, useStatDialog, type StatDialogSeat } from './stat-dialog.ts'
import {
  billedInputTokens, cacheHitPercent, deriveStats,
  estimateOutputTokens, formatDuration, formatTokensCompact, formatTokensPerSecond,
  measuredTokenScale, StreamingRateSampler,
  type ConversationNodeLike, type PartialAssistantLike, type UseProjection, type WindowStats,
} from './stats-line-core.ts'
import { formatTokens } from './format.ts'
import { useSessionUsage, type SessionTreeReading } from './use-session-usage.ts'
import { billedTotal, hasAnyTokens, sessionUsageForDisplay } from './session-usage-core.ts'
import type { SessionUsageTotals } from '../wire.ts'
import css from './StatsLineEnhanced.module.css'

/**
 * Structural type for the `useChat` seat: the standard snapshot selector over
 * the ui-chat ChatSnapshot, whose `legacy.nodes` compatibility projection
 * carries the ConversationNode[] the official pills read and whose
 * `legacy.partial` carries the in-flight assistant output. Declared locally
 * because the seat is consumed structurally at runtime (injected by the slot
 * declaration) and never value-imported.
 */
type ChatSnapshotSelectorHook = SnapshotSelectorHook<{
  legacy: {
    nodes?: readonly ConversationNodeLike[]
    partial?: PartialAssistantLike | null
  }
}>

/**
 * Full props: the standard session kit (selector + projection seat) plus the
 * locale seat this entry declares. `useChat` is injected by the slot
 * declaration on DSH >= 0.1.2-rc.1.
 */
export interface StatsLineEnhancedProps {
  /** The chat-view snapshot selector (path `legacy.nodes`). */
  useChat: ChatSnapshotSelectorHook
  useProjection: UseProjection
  t: PropsLocale<typeof LOCALE_NS>['t']
  /** The session this dock row belongs to. Every session-scope slot receives it
   *  as a standard prop (see dsh-client-ui-session's builtin source), and it is
   *  what lets the usage pill ask the host for the WHOLE session tree — the
   *  native `tokenUsage` projection covers the main agent only. */
  sessionId?: string
}

type T = StatsLineEnhancedProps['t']

/** External open state one pill's dialog reads and writes (the row's exclusive slot). */
type PillDialog = Pick<StatDialogSeat, 'open' | 'setOpen'>

/** The trigger that makes the tree query re-run: the native usage buckets plus
 *  the settled step count. Both move exactly when a main-agent call lands, so
 *  an idle session never re-asks. */
function usageSignature(usage: Parameters<typeof billedInputTokens>[0] | undefined, steps: number): string {
  if (usage === undefined) return `none|${steps}`
  return `${usage.uncachedInputTokens}|${usage.outputTokens}|${usage.cacheReadTokens}|${usage.cacheWriteTokens}|${steps}`
}

/** The anchor's class list. The pre-split row sets the text tier on `.root`
 *  and the anchor inherits it; a split-mode entry IS a child of the host's
 *  `.dock`, so its anchor declares the tier itself (the official `.anchor`). */
function anchorClass(dock: boolean): string | undefined {
  return dock ? `${css.anchor} ${css.dockAnchor}` : css.anchor
}

/** The separator + figure shape both speed arms render into the gauge pill:
 *  exactly the official pill's inline shape — separator and figure appear only
 *  when there is a figure, and the figure occupies no reserved width, so the
 *  row reads and reflows like the native one. */
function SpeedFigure({ text }: { text: string | null }) {
  return (
    <>
      {text !== null && <span className={css.sep} aria-hidden>·</span>}
      {text !== null && <span className={css.speed} data-stats-speed>{text}</span>}
    </>
  )
}

/**
 * Tell the composer row which container the host rendered it in — it has to
 * serve two layouts at once: inside InputBar's flex `.dock` (0.1.6-alpha.2+,
 * beside the resident ContextMeter, which owns the row's centring, 12px gap,
 * top pad and side clearance) or straight in InputBar's own column (through
 * 0.1.6-alpha.1, where this row owns all four). The stylesheet carries both
 * contracts and keys them off `data-dock-row`.
 *
 * The row's parent is NOT that container: the slot renderer wraps every entry
 * in a `display: contents` element (measured against 0.1.6-alpha.2 in a live
 * instance — the wrapper has no box, so its own display axes say nothing about
 * the layout). The nearest ancestor that actually participates in layout is the
 * one to read, so walk up past the wrappers (bounded, in case a host ever
 * stacks several) and take the first real box's axes. Nothing found keeps the
 * row unmarked, i.e. the older contract — the harmless direction.
 *
 * A ref callback, not an effect: this is the one React seam that fires when the
 * row's DOM first exists, and an effect could not be trusted here — the
 * component returns null until the session has steps or tokens, so a mount-time
 * probe would run against no element and never repeat.
 */
function markDockContainer(row: HTMLDivElement | null): void {
  if (row === null) return
  const view = row.ownerDocument.defaultView
  if (view === null) return
  let box: HTMLElement | null = row.parentElement
  for (let depth = 0; box !== null && depth < 8; depth += 1) {
    const style = view.getComputedStyle(box)
    if (style.display !== 'contents') {
      row.toggleAttribute('data-dock-row', style.display === 'flex' && style.flexDirection === 'row')
      return
    }
    box = box.parentElement
  }
}

/**
 * How often the live reading is recomputed while a step streams. Deltas arrive
 * every delta, and this beat only covers a step that has gone quiet mid-answer,
 * where no frame arrives to advance the window at all. It matches the reference
 * implementation this replicates (MiMo-Code's sidebar tps).
 */
const LIVE_SPEED_REFRESH_MS = 1_000

/**
 * The gauge pill's always-on streaming speed slot.
 *
 * It subscribes to `legacy.partial` itself so per-frame deltas re-render only
 * this child, not the surrounding pills. Two figures share the slot, chosen by
 * whether a step is streaming right now:
 *
 * - while one is (`partial != null`), the measured rate of THAT stream — a
 *   bounded sliding window over observed token growth (stats-line-core's
 *   StreamingRateSampler), the only reading that can track the pace of the
 *   answer currently on screen;
 * - otherwise the session's own decode average, ΣoutputTokens / ΣdecodeMs —
 *   the same quotient `decodeRateOf` quotes in the usage view. An idle composer
 *   must not freeze on whatever the last window happened to measure: a settled
 *   thirty-step turn kept showing its final second-long reading (57 tok/s)
 *   beside the usage view's 156 tok/s for the same work, and the two read as a
 *   contradiction rather than as two scopes of one number.
 *
 * The measured reading carries the step it was taken in, so a new step cannot
 * inherit the previous one's figure before its own window publishes; nothing is
 * held across the gap — the gap is exactly when the average applies.
 *
 * One window covers a whole step, across every output kind the accumulator
 * carries — reasoning, answer text, and Tool-call arguments — because the
 * provider bills all three as completion tokens and a step emits them in
 * sequence.
 *
 * Sampling happens in a layout effect and the figure it yields is published as
 * state, so no render reads a clock or mutates the window: a render React starts
 * and then discards must not decide what the next committed one displays. The
 * rate itself comes from stats-line-core's StreamingRateSampler — a bounded
 * window over observed token growth, smoothed, and held while nothing arrives
 * inside the step it belongs to.
 */
function LiveSpeed({ useChat, scale, fallback, t }: {
  useChat: ChatSnapshotSelectorHook
  /** Correction measured from this session's settled steps (1 = raw prior). */
  scale: number
  /** The session's own decode average (ΣoutputTokens / ΣdecodeMs): what the
   *  slot shows whenever no step is streaming, and before the streaming step's
   *  window has published its first reading. */
  fallback: string | null
  t: T
}) {
  const partial = useChat(s => s.legacy.partial)
  const key = partial == null ? null : `${partial.turn}:${partial.step}`
  const tokens = useMemo(
    () => (partial == null ? 0 : estimateOutputTokens(partial.blocks) * scale),
    [partial, scale],
  )
  // One sampler per step, allocated by the render that first sees the step: a
  // window belongs to one step, and the allocation is idempotent, so a discarded
  // render cannot hand the next committed one a window stitched from two steps.
  const sampler = useRef<{ key: string | null; rate: StreamingRateSampler } | null>(null)
  if (sampler.current === null || sampler.current.key !== key) {
    sampler.current = { key, rate: new StreamingRateSampler() }
  }
  const rate = sampler.current.rate
  // The figure last measured, tagged with the step it came from. The tag is
  // what retires it: a reading taken in 3:4 never shows during 3:5, and with
  // no step streaming (`key === null`) no tag can match at all, so the slot
  // falls through to the session average on its own — no timer, no clearing
  // effect, and no stale figure left standing after a turn settles.
  const [reading, setReading] = useState<{ key: string; value: number } | null>(null)
  const scaleRef = useRef(scale)
  // Every delta re-runs this (its dependencies move), and the beat re-runs it once
  // a second so a step that has gone quiet still advances its window.
  const [beat, setBeat] = useState(0)
  useLayoutEffect(() => {
    // Nothing is streaming: the slot shows the session average, and there is no
    // window to advance. Skipping the observation also keeps a settled step's
    // sampler from being fed a zero estimate, which would re-anchor it against
    // text that is already counted.
    if (key === null) return
    // A correction that moved re-prices the whole estimate, so growth already
    // counted under the old one must not be measured against the new one: that
    // would read as a burst the stream never produced.
    if (scaleRef.current !== scale) {
      scaleRef.current = scale
      rate.reset()
    }
    rate.observe(tokens, Date.now())
    // A null here means the fresh window has not measured anything yet (a step
    // that just opened, or one that re-anchored); the average stays up until
    // this step's own window publishes something.
    const next = rate.ratePerSecond()
    if (next !== null) {
      setReading(previous => (previous !== null && previous.key === key && previous.value === next
        ? previous
        : { key, value: next }))
    }
  }, [tokens, key, beat, rate, scale])
  // Keyed on "a step is streaming", not on the step identity: switching steps
  // must not tear the beat down and defer the next one by a full period.
  const streaming = key !== null
  useEffect(() => {
    if (!streaming) return
    const handle = setInterval(() => { setBeat(Date.now()) }, LIVE_SPEED_REFRESH_MS)
    return () => { clearInterval(handle) }
  }, [streaming])
  // The tag test is the whole selection rule: a reading only shows while the
  // step that produced it is the step streaming now.
  const measured = reading !== null && reading.key === key ? reading.value : null
  return <SpeedFigure text={measured === null
    ? fallback
    : t('stats.tokensPerSecond', { throughput: formatTokensPerSecond(measured) })} />
}

function TimePill({ stats, t, dialog, useChat, scale, dock }: {
  stats: WindowStats
  t: T
  /** The row's shared exclusive slot; omitted by a split-mode entry, which
   *  owns its own state (exclusion then rides stat-dialog's outside click). */
  dialog?: PillDialog
  useChat: ChatSnapshotSelectorHook
  /** Correction measured from this session's settled steps (1 = raw prior). */
  scale: number
  /** Whether the host's own dock row owns the layout (DSH >= 0.2.1-alpha.1). */
  dock: boolean
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  // The session figure now serves both jobs: the pill's accessible name (a
  // screen reader gets the durable session reading rather than a value that
  // changes every second while a step streams) and the visible figure whenever
  // no step is streaming.
  const officialTps = stats.decodeMs > 0
    ? t('stats.tokensPerSecond', {
      throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
    })
    : null
  const label = (
    <span className={css.label}>
      {counts}
      <LiveSpeed useChat={useChat} scale={scale} fallback={officialTps} t={t} />
    </span>
  )
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && stats.decodeMs <= 0) {
    return (
      <span className={anchorClass(dock)}>
        <span className={css.pill}>
          <GaugeIcon />
          {label}
        </span>
      </span>
    )
  }
  return (
    <span ref={rootRef} className={anchorClass(dock)} data-dsh-token-total-stat>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={officialTps === null ? counts : counts + ' · ' + officialTps}
        onClick={() => { setOpen(!open) }}
      >
        <GaugeIcon />
        {label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.dialogPanel}
          data-dsh-usage-glass="dialog"
          role="dialog"
          aria-label={t('stats.dialog.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.dialogTitle}>
            <span className={css.dialogTitleLabel}>
              <GaugeIcon />
              {t('stats.dialog.title')}
            </span>
          </div>
          <div className={css.dialogTitleRule} aria-hidden />
          <dl className={css.dialogDetails} data-session-stats-details>
            {stats.llmMs > 0 && (
              <>
                <dt>{t('stats.dialog.llmTime')}</dt>
                <dd>{formatDuration(stats.llmMs)}</dd>
              </>
            )}
            {stats.toolMs > 0 && (
              <>
                <dt>{t('stats.dialog.toolTime')}</dt>
                <dd>{formatDuration(stats.toolMs)}</dd>
              </>
            )}
            {stats.ttftSteps > 0 && (
              <>
                <dt>{t('stats.dialog.ttft')}</dt>
                <dd>{formatDuration(stats.ttftMs / stats.ttftSteps)}</dd>
              </>
            )}
            {stats.decodeMs > 0 && (
              <>
                <dt>{t('stats.dialog.speed')}</dt>
                <dd>{t('stats.tokensPerSecond', {
                  throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
                })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

function UsagePill({ usage, tree, t, dialog, dock }: {
  usage: Parameters<typeof billedInputTokens>[0] | undefined
  /** Descendant spend from the host; the main-agent figure stays live. */
  tree?: SessionTreeReading
  t: T
  /** The row's shared exclusive slot; omitted by a split-mode entry. */
  dialog?: PillDialog
  /** Whether the host's own dock row owns the layout (DSH >= 0.2.1-alpha.1). */
  dock: boolean
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)
  const display = sessionUsageForDisplay(usage, tree?.tree ?? null)
  const billed = display.total
  // Same aggregate as the official pill total: every prompt-side billing bucket plus output.
  const total = billedTotal(billed)
  const totalText = t('message.turnUsage.count', { count: formatTokensCompact(total) })
  // Native formatting, one consistent scope: the ratio comes from the same
  // aggregate the headline uses, so "33M tok · 87%" can never contradict the
  // number printed beside it. The integer shape and its >99% guard are the
  // official ones, untouched.
  const cacheHit = cacheHitPercent(billed)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  const exactCount = (value: number): string =>
    t('message.turnUsage.count', { count: formatTokens(value) })
  return (
    <span ref={rootRef} className={anchorClass(dock)} data-dsh-token-total-stat>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={cacheHitText === null ? totalText : totalText + ' · ' + cacheHitText}
        onClick={() => { setOpen(!open) }}
      >
        <DatabaseIcon />
        <span className={css.label}>
          {totalText}
          {cacheHitText !== null && (
            <>
              {/* Separator only when the second figure exists: an empty span
                  would still take the label's gap and read as a trailing dot. */}
              <span className={css.sep} aria-hidden>·</span>
              {cacheHitText}
            </>
          )}
        </span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.dialogPanel}
          data-dsh-usage-glass="dialog"
          role="dialog"
          aria-label={t('stats.dialog.usageTitle')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.dialogTitle}>
            <span className={css.dialogTitleLabel}>
              <DatabaseIcon />
              {t('stats.dialog.usageTitle')}
            </span>
            <span className={css.dialogTitleValue}>{exactCount(total)}</span>
          </div>
          <div className={css.dialogTitleRule} aria-hidden />
          {/* Exactly the official dialog's rows, in the official order: the
              takeover adds the tree to the TOTAL, not to the breakdown. */}
          <dl className={css.dialogDetails} data-session-stats-usage>
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{cacheHit + '%'}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{exactCount(billed.uncachedInputTokens)}</dd>
            <dt>{t('message.turnUsage.cacheRead')}</dt>
            <dd>{exactCount(billed.cacheReadTokens)}</dd>
            {billed.cacheWriteTokens !== 0 && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{exactCount(billed.cacheWriteTokens)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>{exactCount(billed.outputTokens)}</dd>
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * The pre-split whole-row entry: DSH <= 0.2.0-rc.2 exposes ONE
 * `conversation.composer.dock` entry (id 'stats'), so this component owns the
 * row container, the host-container marker, and the two pills' shared
 * exclusive dialog slot. On 0.2.1-alpha.1+ the two entries below replace it.
 */
export const StatsLineEnhanced = memo(function StatsLineEnhanced(
  { useChat, useProjection, t, sessionId }: StatsLineEnhancedProps,
) {
  const settledNodes = useChat(s => s.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // One exclusive slot for both dialogs: opening either pill closes the other.
  const [openPill, setOpenPill] = useState<'time' | 'usage' | null>(null)
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names).
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes ?? []), [projected, settledNodes])
  // The live estimate's correction, measured once per settled-node change: the
  // session's own reported output tokens against what the published text
  // density predicted for the same text. 1 (the raw prior) until a settled step
  // carries both, so the first stream of a session still reads sensibly.
  const tokenScale = useMemo(() => measuredTokenScale(settledNodes ?? []) ?? 1, [settledNodes])
  // Refresh on main-agent settlements and poll for child-only activity.
  const tree = useSessionUsage(sessionId, usageSignature(usage, stats.steps))
  // A delegated-only session must still show its usage pill.
  const hasTokens = hasAnyTokens(sessionUsageForDisplay(usage, tree.tree).total)
  if (stats.steps === 0 && !hasTokens) return null
  // data-composer-stats: through host 0.1.6-alpha.1 InputBar tightened the
  // composer bottom clearance while this row rendered (the official pills'
  // `:has` contract). 0.1.6-alpha.2 moved the row into InputBar's own flex
  // `.dock` and dropped that rule, so the marker is inert there — kept because
  // older hosts still need it and it costs nothing.
  return (
    <div ref={markDockContainer} className={css.root} data-composer-stats>
      {stats.steps > 0 && (
        <TimePill
          stats={stats}
          t={t}
          useChat={useChat}
          scale={tokenScale}
          dock={false}
          dialog={{
            open: openPill === 'time',
            setOpen: (open) => { setOpenPill(open ? 'time' : null) },
          }}
        />
      )}
      {hasTokens && (
        <UsagePill
          usage={usage}
          tree={tree}
          t={t}
          dialog={{
            open: openPill === 'usage',
            setOpen: (open) => { setOpenPill(open ? 'usage' : null) },
          }}
          dock={false}
        />
      )}
    </div>
  )
})

/**
 * The split-mode `activity` dock entry (DSH >= 0.2.1-alpha.1): the gauge pill
 * alone, at the official entry's id so priority -1 shadows it. The host's
 * `.dock` flex row owns the layout the pre-split row used to build, and the
 * `usage` entry mounts as an independent sibling — so this component reads
 * only what its own pill needs, and its dialog state is its own (the seat's
 * outside click closes it when the sibling opens).
 *
 * The empty check is per entry, exactly as the official pill's: the counts
 * pill is gated on settled steps.
 */
export const StatsActivityEntry = memo(function StatsActivityEntry(
  { useChat, useProjection, t }: StatsLineEnhancedProps,
) {
  const settledNodes = useChat(s => s.legacy.nodes)
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes ?? []), [projected, settledNodes])
  const tokenScale = useMemo(() => measuredTokenScale(settledNodes ?? []) ?? 1, [settledNodes])
  if (stats.steps === 0) return null
  return (
    <TimePill stats={stats} t={t} useChat={useChat} scale={tokenScale} dock />
  )
})

/**
 * The split-mode `usage` dock entry (DSH >= 0.2.1-alpha.1): the database pill
 * alone, at the official entry's id so priority -1 shadows it. Gated on actual
 * token activity, as the official pill is and as the pre-split row's own
 * `hasTokens` did.
 */
export const StatsUsageEntry = memo(function StatsUsageEntry(
  { useProjection, t, sessionId }: StatsLineEnhancedProps,
) {
  const usage = useProjection('tokenUsage')
  const tree = useSessionUsage(sessionId, usageSignature(usage, usage === undefined ? 0 : 1))
  const hasTokens = hasAnyTokens(sessionUsageForDisplay(usage, tree.tree).total)
  if (!hasTokens) return null
  return (
    <UsagePill
      usage={usage}
      tree={tree}
      t={t}
      dock
    />
  )
})
