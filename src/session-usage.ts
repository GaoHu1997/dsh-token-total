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

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 64

interface TreeRead {
  rootId: string
  persistence: UsageSessionPersistence
  sessions: UsageSessionStore | undefined
  members: ReadonlySet<string>
  invalidated: boolean
  catalogReady: boolean
  catalogVersion: number
  catalogOrder: number
}
interface CachedTree {
  at: number
  value: SessionUsageTree
  read: TreeRead
}

export class SessionUsageService {
  private cache = new Map<string, CachedTree>()
  private parents = new Map<string, ReadonlySet<string>>()
  private catalogVersion = 0
  private catalogOrder = 0
  private appliedCatalogOrder = 0
  private reads = new Set<TreeRead>()
  private inFlight = new Map<string, { read: TreeRead; promise: Promise<SessionUsageTree> }>()

  /** Events keep live trees fresh; the TTL bounds out-of-band catalog changes.
   * Hosts without a live event hook can select the old four-second fallback. */
  constructor(private readonly cacheTtlMs = CACHE_TTL_MS) {}

  /** Invalidate the changed session and every old/new ancestor, not other trees.
   * null is a known root; undefined means parent metadata was not supplied.
   * An unknown parent chain conservatively falls back instead of missing a new
   * child that appeared before the persistence catalog caught up. */
  invalidate(sessionId: string, parentSession?: string | null): void {
    this.catalogVersion++
    const previous = this.parents.get(sessionId)
    const queue = [...(previous ?? [])]
    let uncertain = previous === undefined && parentSession === undefined
    if (parentSession !== undefined) {
      const current = new Set<string>()
      if (parentSession !== null && parentSession !== '' && parentSession !== sessionId) current.add(parentSession)
      // Do not accumulate unbounded event-only ids between catalog reads.
      // Unknown hints still invalidate their ancestors immediately.
      if (previous !== undefined) this.parents.set(sessionId, current)
      queue.push(...current)
    }
    const affected = new Set([sessionId])
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!
      if (affected.has(id)) continue
      affected.add(id)
      const ancestors = this.parents.get(id)
      if (ancestors === undefined) uncertain = true
      else queue.push(...ancestors)
    }
    const touches = (read: TreeRead): boolean => {
      if (affected.has(read.rootId)) return true
      // A newer catalog may have moved an ancestor away from this older tree.
      // Changes below that ancestor must still invalidate its old membership.
      for (const id of affected) if (read.members.has(id)) return true
      return false
    }
    for (const [rootId, entry] of this.cache) {
      if (uncertain || touches(entry.read)) this.cache.delete(rootId)
    }
    // Detached older reads remain tracked until they settle. A new request must
    // not join an invalidated read, and that read must never repopulate the cache.
    for (const read of this.reads) {
      if (!read.catalogReady || uncertain || touches(read)) read.invalidated = true
    }
  }

  /** A bad descendant leaves readable totals available, but is never cached.
   * Signal-less browser requests share one cold read per root. Explicit signals
   * retain independent ownership and are passed through unchanged: aborting one
   * caller cannot cancel another caller's readers or publish its partial totals. */
  async tree(
    persistence: UsageSessionPersistence,
    sessions: UsageSessionStore | undefined,
    rootId: string,
    signal?: AbortSignal,
  ): Promise<SessionUsageTree> {
    signal?.throwIfAborted()
    const hit = this.cache.get(rootId)
    if (hit !== undefined && hit.read.persistence === persistence && hit.read.sessions === sessions
      && Date.now() - hit.at < this.cacheTtlMs) {
      // Map insertion order is the LRU; a hit must protect a popular history.
      this.cache.delete(rootId)
      this.cache.set(rootId, hit)
      return hit.value
    }
    this.cache.delete(rootId)
    const pending = this.inFlight.get(rootId)
    if (signal === undefined && pending !== undefined && !pending.read.invalidated
      && pending.read.persistence === persistence && pending.read.sessions === sessions) return pending.promise

    const read: TreeRead = {
      rootId, persistence, sessions, members: new Set([rootId]), invalidated: false,
      catalogReady: false, catalogVersion: this.catalogVersion, catalogOrder: ++this.catalogOrder,
    }
    this.reads.add(read)
    const promise = this.compute(read, signal).finally(() => {
      this.reads.delete(read)
      if (this.inFlight.get(rootId)?.read === read) this.inFlight.delete(rootId)
    })
    if (signal === undefined) this.inFlight.set(rootId, { read, promise })
    return promise
  }

  private async compute(read: TreeRead, signal?: AbortSignal): Promise<SessionUsageTree> {
    const { root, descendants, coverage } = await readUsageTree(
      read.persistence, read.sessions, read.rootId, signal, (catalog) => {
        read.members = catalog.members
        read.catalogReady = true
        // A slow older listing must not undo newer catalogs or event hints.
        if (read.catalogVersion === this.catalogVersion && read.catalogOrder > this.appliedCatalogOrder) {
          this.parents = new Map(catalog.parents)
          this.appliedCatalogOrder = read.catalogOrder
        }
      },
    )
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
    const newer = this.cache.get(read.rootId)
    if (coverage.complete && !read.invalidated && (newer === undefined || newer.read.catalogOrder < read.catalogOrder)) {
      // Retire older same-source snapshots before publishing. LRU eviction of
      // this result must not let an older detached read be joined or cached.
      for (const older of this.reads) {
        if (older.rootId === read.rootId && older.persistence === read.persistence
          && older.sessions === read.sessions && older.catalogOrder < read.catalogOrder) older.invalidated = true
      }
      this.cache.delete(read.rootId)
      if (this.cache.size >= CACHE_MAX) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      this.cache.set(read.rootId, { at: Date.now(), value, read })
    }
    return value
  }
}
