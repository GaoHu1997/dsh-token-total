/** Per-session owned usage, including every readable descendant. */
import type { UsageSessionPersistence, UsageSessionStore } from './context-types.ts'
import { UsageFold } from './collector.ts'
import { readUsageTree, type UsageSessionLog } from './session-tree.ts'
import type { SessionUsageTotals, SessionUsageTree } from './wire.ts'

export type { SessionUsageTotals, SessionUsageTree } from './wire.ts'

const zero = (): SessionUsageTotals => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
function add(into: SessionUsageTotals, from: SessionUsageTotals): void {
  into.uncachedInputTokens += from.uncachedInputTokens
  into.outputTokens += from.outputTokens
  into.cacheReadTokens += from.cacheReadTokens
  into.cacheWriteTokens += from.cacheWriteTokens
}

function sumOneSession(log: UsageSessionLog): { totals: SessionUsageTotals; compaction: SessionUsageTotals } {
  const fold = new UsageFold()
  const totals = zero()
  const compaction = zero()
  for (const event of log.events) {
    if (event.seq < log.inheritedCut) continue
    const sample = fold.fold(event)
    if (sample === null || sample.turn) continue
    const buckets: SessionUsageTotals = {
      uncachedInputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    }
    add(totals, buckets)
    if (event.type === 'compaction/summary') add(compaction, buckets)
  }
  return { totals, compaction }
}

const CACHE_TTL_MS = 4_000
const CACHE_MAX = 64

export class SessionUsageService {
  private cache = new Map<string, { at: number; value: SessionUsageTree }>()
  private generation = 0

  /** New events can introduce descendants of any cached root. */
  invalidate(_sessionId: string): void {
    this.generation++
    this.cache.clear()
  }

  /** A bad descendant leaves the readable totals available with coverage.
   * Never cache incomplete results: a repaired log must recover on the next read.
   * Root, catalog and cancellation failures still reject without publishing zero. */
  async tree(
    persistence: UsageSessionPersistence,
    sessions: UsageSessionStore | undefined,
    rootId: string,
    signal?: AbortSignal,
  ): Promise<SessionUsageTree> {
    signal?.throwIfAborted()
    const hit = this.cache.get(rootId)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
    const generation = this.generation
    const { root, descendants, coverage } = await readUsageTree(persistence, sessions, rootId, signal)
    const own = sumOneSession(root)
    const subagents = zero()
    for (const log of descendants) add(subagents, sumOneSession(log).totals)
    const total = { ...own.totals }
    add(total, subagents)
    const value: SessionUsageTree = {
      self: own.totals,
      selfCompaction: own.compaction,
      subagents,
      total,
      subagentSessions: descendants.length,
      coverage,
    }
    signal?.throwIfAborted()
    if (coverage.complete && generation === this.generation) {
      if (this.cache.size >= CACHE_MAX) this.cache.clear()
      this.cache.set(rootId, { at: Date.now(), value })
    }
    return value
  }
}
