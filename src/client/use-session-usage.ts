/** The composer row's window onto the whole session tree. The native usage
 * projection only moves for main-agent calls, so poll the displayed session
 * even before its first child appears. Requests are serialized and late answers
 * from a previous session are discarded. Failures keep the last good reading. */
import { useEffect, useRef, useState } from 'react'
import { fetchSessionUsage } from './api.ts'
import { combinedTotals } from './session-usage-core.ts'
import type { SessionUsageTotals, SessionUsageTree } from '../wire.ts'

export { billedTotal, cacheHitPercentOf, combinedTotals, hasAnyTokens } from './session-usage-core.ts'

export interface SessionTreeReading {
  tree: SessionUsageTree | null
  /** Authoritative log-based main + all descendant usage after the tree loads. */
  totals: SessionUsageTotals | null
}

const SESSION_POLL_MS = 4_000

export function useSessionUsage(sessionId: string | undefined, signature: string): SessionTreeReading {
  const [reading, setReading] = useState<{ sessionId: string; tree: SessionUsageTree } | null>(null)
  const refresh = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    let active = true
    let pending = false
    let again = false
    const request = (): void => {
      if (!active) return
      if (pending) {
        again = true
        return
      }
      pending = true
      void fetchSessionUsage(sessionId).then((tree) => {
        if (active) setReading({ sessionId, tree })
      }).catch(() => {
        // Retry on the next beat/signature; do not replace good data with zero.
      }).finally(() => {
        pending = false
        if (active && again) {
          again = false
          request()
        }
      })
    }
    refresh.current = request
    const handle = setInterval(request, SESSION_POLL_MS)
    return () => {
      active = false
      refresh.current = null
      clearInterval(handle)
    }
  }, [sessionId])
  useEffect(() => {
    refresh.current?.()
  }, [sessionId, signature])
  // Key the answer on its session, not just effect cleanup: the very first
  // render after switching must not show the previous session's descendants.
  const tree = reading !== null && reading.sessionId === sessionId ? reading.tree : null
  return { tree, totals: tree === null ? null : combinedTotals(tree) }
}
