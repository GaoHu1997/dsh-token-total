/**
 * The composer row's window onto the WHOLE session tree.
 *
 * dsh's native `tokenUsage` projection is the main agent of the current
 * session only: a session that delegates to subagents (each subagent is its
 * own persisted session, linked by `header.parentSession`) shows a fraction of
 * what it actually spent, and nothing in the shipped UI shows the rest. The
 * host half answers that question over `/token-total/api/session`, replaying
 * the root log plus every descendant's log; this hook is the browser end.
 *
 * Refresh policy: the request is cheap on the host (its tree cache is
 * invalidated by live events), and the native usage figure moves exactly when
 * a call settles — so a change in the native signature is the trigger to
 * re-ask. There is no timer: an idle session costs nothing.
 *
 * Failure policy: the pill must never break the composer, so a failed request
 * keeps the last good answer and simply does not retry until the next trigger.
 */
import { useEffect, useRef, useState } from 'react'
import { fetchSessionUsage } from './api.ts'
import type { SessionUsageTotals, SessionUsageTree } from '../wire.ts'

const ZERO: SessionUsageTotals = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function add(into: SessionUsageTotals, from: SessionUsageTotals): SessionUsageTotals {
  return {
    uncachedInputTokens: into.uncachedInputTokens + from.uncachedInputTokens,
    outputTokens: into.outputTokens + from.outputTokens,
    cacheReadTokens: into.cacheReadTokens + from.cacheReadTokens,
    cacheWriteTokens: into.cacheWriteTokens + from.cacheWriteTokens,
  }
}

/** Fold a tree into the flat shape the pill's dialog renders. */
export function combinedTotals(tree: SessionUsageTree): SessionUsageTotals {
  return add(tree.self, tree.subagents)
}

/** Whether a totals record carries any billable token at all. */
export function hasAnyTokens(totals: SessionUsageTotals | undefined): boolean {
  if (totals === undefined) return false
  return totals.uncachedInputTokens + totals.outputTokens
    + totals.cacheReadTokens + totals.cacheWriteTokens > 0
}

/** Total billed tokens of a flat totals record (prompt side + completion). */
export function billedTotal(totals: SessionUsageTotals): number {
  return totals.uncachedInputTokens + totals.cacheReadTokens
    + totals.cacheWriteTokens + totals.outputTokens
}

/** Cache hit rate over the prompt side, or null when nothing was prompted. */
export function cacheHitPercentOf(totals: SessionUsageTotals): number | null {
  const hit = totals.cacheReadTokens
  const miss = totals.uncachedInputTokens + totals.cacheWriteTokens
  if (hit + miss === 0) return null
  return (hit / (hit + miss)) * 100
}

export interface SessionTreeReading {
  tree: SessionUsageTree | null
  /** main + subagents, or null before the first successful answer. */
  totals: SessionUsageTotals | null
}

/** How often a session that HAS subagents re-asks. The native figure only moves
 *  when the main agent's own call settles, so without this a subagent still
 *  working (or one that just finished) would not update the pill. A session
 *  with no subagents never polls: nothing exists to miss. */
const SUBAGENT_POLL_MS = 4_000

/**
 * Subscribe to one session's whole-tree usage.
 *
 * `signature` is any string that changes when the native usage figure moves;
 * passing it in keeps this hook out of the projection seat and lets the caller
 * decide what "a new call settled" means for its own pill. A session that turns
 * out to have subagents additionally re-asks on a slow beat, because subagent
 * spend lands in a different session log and no native figure moves for it.
 */
export function useSessionUsage(sessionId: string | undefined, signature: string): SessionTreeReading {
  const [tree, setTree] = useState<SessionUsageTree | null>(null)
  const latest = useRef<string>('')
  const [beat, setBeat] = useState(0)
  const hasSubagents = (tree?.subagentSessions ?? 0) > 0
  useEffect(() => {
    if (!hasSubagents) return
    const handle = setInterval(() => { setBeat(Date.now()) }, SUBAGENT_POLL_MS)
    return () => { clearInterval(handle) }
  }, [hasSubagents])
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const key = `${sessionId}|${signature}|${beat}`
    if (latest.current === key) return
    latest.current = key
    let cancelled = false
    void fetchSessionUsage(sessionId).then((value) => {
      if (cancelled) return
      setTree(value)
    }).catch(() => {
      // Keep the previous reading; the next trigger retries.
      latest.current = ''
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, signature, beat])
  const totals = tree === null ? null : combinedTotals(tree)
  return { tree, totals }
}
