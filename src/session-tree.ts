import type {
  UsageSessionEvent,
  UsageSessionHandle,
  UsageSessionHeader,
  UsageSessionPersistence,
  UsageSessionSnapshot,
  UsageSessionStore,
} from './context-types.ts'
import type { SessionUsageCoverage, SessionUsageReadIssue } from './wire.ts'

/** Shared membership, ownership and failure semantics for both usage APIs.
 * A bad descendant is isolated; root, catalog and cancellation failures reject. */
export interface UsageSessionLog {
  id: string
  header?: UsageSessionHeader
  live?: UsageSessionHandle
  events: readonly UsageSessionEvent[]
  inheritedCut: number
}

/** Metadata only: includes unreadable descendants and both persisted/live links. */
export interface UsageTreeCatalog {
  parents: ReadonlyMap<string, ReadonlySet<string>>
  members: ReadonlySet<string>
}

function headerOf(item: UsageSessionHeader | UsageSessionSnapshot): UsageSessionHeader | null {
  if (!item || typeof item !== 'object') return null
  const header = 'header' in item ? item.header : item
  return header && typeof header.id === 'string' && header.id !== '' ? header : null
}

function inheritedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function throwIfCanceled(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error
}

/** Never send raw exceptions to the client: they may contain paths or secrets. */
function readIssue(sessionId: string, error: unknown): SessionUsageReadIssue {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
  const reason = name === 'SessionPersistenceCorruptionError' || name === 'SessionFormatError'
    ? 'corrupt'
    : name === 'SessionPersistenceNotFoundError' || code === 'ENOENT' ? 'missing' : 'unavailable'
  return { sessionId, reason }
}

async function readSession(
  persistence: UsageSessionPersistence,
  id: string,
  header: UsageSessionHeader | undefined,
  live: UsageSessionHandle | undefined,
  signal?: AbortSignal,
): Promise<UsageSessionLog> {
  signal?.throwIfAborted()
  if (typeof live?.snapshotEvents === 'function' && typeof live.inheritedEventCount === 'number') {
    return { id, header, live, events: live.snapshotEvents(), inheritedCut: inheritedCount(live.inheritedEventCount) }
  }
  if (typeof persistence.open === 'function') {
    const options = signal === undefined ? undefined : { signal }
    const handle = await persistence.open(id, 'read', options)
    try {
      const events: UsageSessionEvent[] = []
      for (let offset = 0;;) {
        signal?.throwIfAborted()
        const page = await handle.read(offset, 500, options)
        if (!page.events.length) break
        for (const event of page.events) events.push(event)
        offset += page.events.length
      }
      return { id, header: header ?? handle.header, live, events, inheritedCut: inheritedCount(handle.inheritedEventCount) }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  if (typeof persistence.inspect === 'function') {
    const inspection = await persistence.inspect(id, signal)
    signal?.throwIfAborted()
    return { id, header: header ?? inspection.meta, live, events: inspection.events, inheritedCut: inheritedCount(inspection.inheritedEventCount) }
  }
  throw new Error('no readable persistence seam (need open or inspect)')
}

export async function readUsageTree(
  persistence: UsageSessionPersistence,
  sessions: UsageSessionStore | undefined,
  rootId: string,
  signal?: AbortSignal,
  onCatalog?: (catalog: UsageTreeCatalog) => void,
): Promise<{ root: UsageSessionLog; descendants: UsageSessionLog[]; coverage: SessionUsageCoverage }> {
  signal?.throwIfAborted()
  const rows = await persistence.list(typeof persistence.open === 'function'
    ? signal === undefined ? undefined : { signal }
    : signal)
  const headers = new Map<string, UsageSessionHeader>()
  for (const row of rows) {
    const header = headerOf(row)
    if (header) headers.set(header.id, header)
  }
  const live = new Map((sessions?.list() ?? []).map(handle => [handle.id, handle]))
  const children = new Map<string, Set<string>>()
  const parents = new Map<string, Set<string>>()
  for (const id of [...headers.keys(), ...live.keys()]) parents.set(id, new Set())
  const link = (id: string, parent: unknown): void => {
    if (typeof parent !== 'string' || parent === '' || parent === id) return
    const bucket = children.get(parent) ?? new Set<string>()
    bucket.add(id)
    children.set(parent, bucket)
    parents.get(id)?.add(parent)
  }
  for (const header of headers.values()) link(header.id, header.parentSession)
  for (const handle of live.values()) link(handle.id, handle.header?.parentSession ?? handle.parentSession)
  const ids: string[] = []
  const seen = new Set([rootId])
  const queue = [rootId]
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]!) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      queue.push(id)
    }
  }
  // Publish membership before any asynchronous log read, so events arriving
  // during that read can invalidate the right root, including bad descendants.
  onCatalog?.({ parents, members: seen })
  const root = await readSession(persistence, rootId, headers.get(rootId), live.get(rootId), signal)
  const logs: Array<UsageSessionLog | undefined> = new Array(ids.length)
  const issues: Array<SessionUsageReadIssue | undefined> = new Array(ids.length)
  let next = 0
  // Bound full-log reads; preserve catalog order regardless of completion order.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted()
      const index = next++
      if (index >= ids.length) return
      const id = ids[index]!
      try {
        logs[index] = await readSession(persistence, id, headers.get(id), live.get(id), signal)
      } catch (error) {
        throwIfCanceled(error, signal)
        issues[index] = readIssue(id, error)
      }
    }
  }))
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason
  signal?.throwIfAborted()
  const descendants = logs.filter((log): log is UsageSessionLog => log !== undefined)
  const unreadableSessions = issues.filter((issue): issue is SessionUsageReadIssue => issue !== undefined)
  return {
    root,
    descendants,
    coverage: { complete: unreadableSessions.length === 0, totalSessions: ids.length + 1, readableSessions: descendants.length + 1, unreadableSessions },
  }
}
