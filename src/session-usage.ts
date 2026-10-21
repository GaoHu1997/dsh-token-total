/**
 * Per-session usage aggregation, INCLUDING subagent sessions.
 *
 * Why this exists: dsh's native `tokenUsage` projection covers only the main
 * agent of the current session — a session that delegates to subagents (whose
 * own logs are separate persisted sessions, linked by `header.parentSession`)
 * shows only a fraction of what it actually spent. This module answers "what
 * did this whole session tree cost".
 *
 * The store has no per-session dimension (it accumulates per day x model), so
 * this is computed ON DEMAND from the session logs: the root session plus every
 * descendant whose `parentSession` chain leads back to it, each replayed
 * through a fresh {@link UsageFold} (the same dedupe rules the backfill uses).
 *
 * Two correctness rules carried over from the backfill engine:
 *  - a forked log begins with the events it copied from its parent
 *    (`handle.inheritedEventCount`); that prefix is skipped, the parent owns it;
 *  - the fold dedupes per (turn, step) within one session, so a streaming
 *    sample followed by the final message counts once.
 *
 * Results are cached briefly: the composer pill polls, and replaying a long log
 * per poll would be wasteful. The cache is invalidated for a session as soon as
 * a new event lands (see the collector's live subscription).
 */

import type {
  UsageSessionEvent,
  UsageSessionHeader,
  UsageSessionPersistence,
  UsageSessionSnapshot,
  UsageSessionStore,
} from './context-types.ts'
import { UsageFold } from './collector.ts'
import type { SessionUsageTotals, SessionUsageTree } from './wire.ts'

export type { SessionUsageTotals, SessionUsageTree } from './wire.ts'

const ZERO: SessionUsageTotals = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function add(into: SessionUsageTotals, from: SessionUsageTotals): void {
  into.uncachedInputTokens += from.uncachedInputTokens
  into.outputTokens += from.outputTokens
  into.cacheReadTokens += from.cacheReadTokens
  into.cacheWriteTokens += from.cacheWriteTokens
}

/** How long one computed tree stays hot. The pill refreshes on its own clock,
 *  and a live session's numbers move at step granularity, not per frame. */
const CACHE_TTL_MS = 4_000
/** Absolute ceiling on cached trees, so a long-lived host with many sessions
 *  cannot grow this map without bound. */
const CACHE_MAX = 64

/** Normalize a `list()` row (alpha snapshots or rc.1 header rows). */
function headerOf(item: UsageSessionHeader | UsageSessionSnapshot): UsageSessionHeader | null {
  const snap = item as { header?: { id?: unknown } }
  if (snap !== null && typeof snap === 'object' && 'header' in snap
    && snap.header !== null && typeof snap.header === 'object'
    && typeof snap.header.id === 'string') {
    return snap.header as UsageSessionHeader
  }
  const row = item as UsageSessionHeader
  return typeof row?.id === 'string' && row.id !== '' ? row : null
}

/** Read one stored session's events through whichever persistence seam the
 *  host line exposes (alpha open/read/close wins; rc.1 inspect is the tail). */
async function readEvents(
  persistence: UsageSessionPersistence,
  id: string,
  signal?: AbortSignal,
): Promise<{ events: readonly UsageSessionEvent[]; inheritedCut: number }> {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(id, 'read', signal === undefined ? undefined : { signal })
    try {
      const cut = handle.inheritedEventCount
      const inheritedCut = typeof cut === 'number' && Number.isSafeInteger(cut) && cut >= 0 ? cut : 0
      const collected: UsageSessionEvent[] = []
      let offset = 0
      const PAGE = 500
      for (;;) {
        if (signal?.aborted) break
        const slice = await handle.read(offset, PAGE, signal === undefined ? undefined : { signal })
        const page = ((slice && slice.events) ? slice.events : []) as readonly UsageSessionEvent[]
        if (page.length === 0) break
        for (const ev of page) collected.push(ev)
        offset += page.length
      }
      return { events: collected, inheritedCut }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  if (typeof persistence.inspect === 'function') {
    const inspection = await persistence.inspect(id, signal)
    return { events: inspection.events, inheritedCut: inspection.inheritedEventCount ?? 0 }
  }
  throw new Error('no readable persistence seam (need open or inspect)')
}

/** Sum one session's own usage (its main agent) from its log. */
async function sumOneSession(
  persistence: UsageSessionPersistence,
  id: string,
  signal?: AbortSignal,
): Promise<SessionUsageTotals> {
  const { events, inheritedCut } = await readEvents(persistence, id, signal)
  const fold = new UsageFold()
  const totals: SessionUsageTotals = { ...ZERO }
  for (const ev of events) {
    if (inheritedCut > 0 && typeof ev.seq === 'number' && ev.seq < inheritedCut) continue
    const sample = fold.fold(ev)
    if (sample === null || sample.turn) continue
    totals.uncachedInputTokens += sample.inputTokens
    totals.outputTokens += sample.outputTokens
    totals.cacheReadTokens += sample.cacheReadTokens
    totals.cacheWriteTokens += sample.cacheWriteTokens
  }
  return totals
}

export class SessionUsageService {
  /** Cached trees, each remembering every session id it was built from, so a
   *  live event on ANY of them (a subagent's own event changes its ancestors'
   *  totals too) can invalidate exactly the affected trees. */
  private cache = new Map<string, { at: number; value: SessionUsageTree; members: Set<string> }>()

  /** Drop every cached tree that counted `sessionId` (its own tree, or any
   *  ancestor's tree that folded it in as a subagent). Called by the collector
   *  on each live session event. */
  invalidate(sessionId: string): void {
    for (const [rootId, entry] of this.cache) {
      if (entry.members.has(sessionId)) this.cache.delete(rootId)
    }
  }

  /** Resolve the whole session tree rooted at `rootId` and sum its usage.
   *  `self` is the root's own usage, `subagents` every descendant's, `total`
   *  the sum. Unknown roots answer zeroed totals rather than throwing: the pill
   *  must never break the composer. */
  async tree(
    persistence: UsageSessionPersistence,
    sessions: UsageSessionStore | undefined,
    rootId: string,
    signal?: AbortSignal,
  ): Promise<SessionUsageTree> {
    const hit = this.cache.get(rootId)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

    const headers = await this.listHeaders(persistence, signal)
    const children = new Map<string, string[]>()
    for (const header of headers) {
      const parent = header.parentSession
      if (typeof parent !== 'string' || parent === '') continue
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [header.id])
      else bucket.push(header.id)
    }
    // A brand-new live subagent may not be materialized in persistence yet;
    // the live store still knows its parent, so fold those in too.
    for (const handle of sessions?.list() ?? []) {
      const parent = (handle as { parentSession?: string }).parentSession
      if (typeof parent !== 'string' || parent === '' || parent === handle.id) continue
      if (headers.some((h) => h.id === handle.id)) continue
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [handle.id])
      else if (!bucket.includes(handle.id)) bucket.push(handle.id)
    }

    const descendants: string[] = []
    const seen = new Set<string>([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        descendants.push(child)
        queue.push(child)
      }
    }

    const self = await sumOneSession(persistence, rootId, signal).catch(() => ({ ...ZERO }))
    const subagents: SessionUsageTotals = { ...ZERO }
    for (const id of descendants) {
      const one = await sumOneSession(persistence, id, signal).catch(() => ({ ...ZERO }))
      add(subagents, one)
    }
    const total: SessionUsageTotals = { ...self }
    add(total, subagents)
    const value: SessionUsageTree = { self, subagents, total, subagentSessions: descendants.length }

    if (signal?.aborted !== true) {
      if (this.cache.size >= CACHE_MAX) this.cache.clear()
      this.cache.set(rootId, {
        at: Date.now(),
        value,
        members: new Set([rootId, ...descendants]),
      })
    }
    return value
  }

  private async listHeaders(
    persistence: UsageSessionPersistence,
    signal?: AbortSignal,
  ): Promise<UsageSessionHeader[]> {
    const useAlphaList = typeof persistence.open === 'function'
    const raw = useAlphaList
      ? await persistence.list(signal === undefined ? undefined : { signal })
      : await persistence.list(signal as never)
    return (raw as Array<UsageSessionHeader | UsageSessionSnapshot>)
      .map(headerOf)
      .filter((h): h is UsageSessionHeader => h !== null)
  }
}
