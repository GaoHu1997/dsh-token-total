/** The composer row's window onto the whole session tree. The native usage
 * projection only moves for main-agent calls, so poll the displayed session
 * even before its first child appears. Hidden pages pause; slow responses do
 * not queue timer retries. Disposed requests are aborted and late answers are
 * discarded. Failures keep the last good reading. */
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
    let again = false
    let lastResult: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const clearTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const request = (): void => {
      if (!active || !visible()) return
      if (controller !== undefined) {
        again = true
        return
      }
      clearTimer()
      const current = new AbortController()
      controller = current
      void fetchSessionUsage(sessionId, current.signal).then((tree) => {
        if (!active || controller !== current || current.signal.aborted) return
        const result = JSON.stringify(tree)
        if (result !== lastResult) {
          lastResult = result
          setReading({ sessionId, tree })
        }
      }).catch(() => {
        // Retry on the next beat/signature; do not replace good data with zero.
      }).finally(() => {
        if (controller !== current) return
        controller = undefined
        if (!active || !visible()) return
        if (again) {
          again = false
          request()
        } else {
          timer = setTimeout(request, SESSION_POLL_MS)
        }
      })
    }
    const onVisibility = (): void => {
      clearTimer()
      if (!visible()) {
        again = false
        controller?.abort()
        controller = undefined
      } else {
        request()
      }
    }
    refresh.current = request
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      refresh.current = null
      clearTimer()
      controller?.abort()
      controller = undefined
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
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
