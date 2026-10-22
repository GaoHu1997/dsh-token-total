/** Pure billing helpers shared by the session-tree hook and composer pills. */
import type { SessionUsageTotals, SessionUsageTree } from '../wire.ts'

const ZERO: SessionUsageTotals = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** Add the root and descendants once; tree.total is already that sum. */
export function combinedTotals(tree: SessionUsageTree, self: SessionUsageTotals = tree.self): SessionUsageTotals {
  return {
    uncachedInputTokens: self.uncachedInputTokens + tree.subagents.uncachedInputTokens,
    outputTokens: self.outputTokens + tree.subagents.outputTokens,
    cacheReadTokens: self.cacheReadTokens + tree.subagents.cacheReadTokens,
    cacheWriteTokens: self.cacheWriteTokens + tree.subagents.cacheWriteTokens,
  }
}

/** One consistent split for the pill, cache hit rate and every dialog row. */
export function sessionUsageForDisplay(
  native: SessionUsageTotals | undefined,
  tree: SessionUsageTree | null,
): SessionUsageTree {
  // The tree folds the full live/stored log, including failed attempts,
  // retries, legacy chunks and compaction, and excludes fork-inherited usage.
  // Native projections can omit those calls or include an inherited prefix;
  // replacing tree.self (or taking bucket-wise maxima) would lose or double
  // spend. Native is only the initial fallback while the tree is unavailable.
  const self = tree?.self ?? native ?? { ...ZERO }
  const subagents = tree?.subagents ?? { ...ZERO }
  return {
    self,
    subagents,
    total: tree === null ? self : combinedTotals(tree, self),
    subagentSessions: tree?.subagentSessions ?? 0,
  }
}

export function hasAnyTokens(totals: SessionUsageTotals | undefined): boolean {
  return totals !== undefined && billedTotal(totals) > 0
}

export function billedTotal(totals: SessionUsageTotals): number {
  return totals.uncachedInputTokens + totals.cacheReadTokens
    + totals.cacheWriteTokens + totals.outputTokens
}

export function cacheHitPercentOf(totals: SessionUsageTotals): number | null {
  const hit = totals.cacheReadTokens
  const miss = totals.uncachedInputTokens + totals.cacheWriteTokens
  return hit + miss === 0 ? null : (hit / (hit + miss)) * 100
}
