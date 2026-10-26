/** Serialized polling for one visible Usage view, never leaking another
 * session's answer. Abort and stop all timers when the tab unmounts. */
import { useEffect, useRef, useState } from 'react'
import type { SessionUsageDetail } from '../wire.ts'
import { fetchSessionDetail } from './api.ts'

export const DETAIL_POLL_MS = 1_500

export function useSessionDetail(sessionId: string): {
  detail: SessionUsageDetail | null
  loading: boolean
  error: boolean
  /** Manual refresh: runs now when idle, or right after an in-flight poll lands. */
  refresh: () => void
  /** Wall-clock time of the last successful read, for the "as of" stamp. */
  updatedAt: number | null
} {
  const [reading, setReading] = useState<{ sessionId: string; detail: SessionUsageDetail | null; error: boolean; updatedAt: number | null } | null>(null)
  const refresh = useRef<(() => void) | null>(null)
  useEffect(() => {
    let active = true
    let pending = false
    let wantedNow = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const request = (): void => {
      if (!active || pending || !sessionId) return
      if (timer !== undefined) clearTimeout(timer)
      pending = true
      controller = new AbortController()
      void fetchSessionDetail(sessionId, controller.signal).then(detail => {
        if (active) setReading({ sessionId, detail, error: false, updatedAt: Date.now() })
      }).catch(() => {
        if (active) setReading(previous => ({ sessionId, detail: previous?.sessionId === sessionId ? previous.detail : null, error: true, updatedAt: previous?.sessionId === sessionId ? previous.updatedAt : null }))
      }).finally(() => {
        pending = false
        // A refresh pressed mid-poll skips the regular interval and refetches
        // as soon as the in-flight answer lands, so the click never stalls.
        if (active) timer = setTimeout(request, wantedNow ? 0 : DETAIL_POLL_MS)
        wantedNow = false
      })
    }
    const wake = (): void => { if (document.visibilityState === 'visible') request() }
    // Manual refresh: fire immediately when idle; when a poll is already in
    // flight, mark it and refetch right after it settles.
    refresh.current = () => { if (pending) wantedNow = true; else request() }
    document.addEventListener('visibilitychange', wake)
    request()
    return () => {
      active = false
      refresh.current = null
      controller?.abort()
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [sessionId])
  const current = reading?.sessionId === sessionId ? reading : null
  return { detail: current?.detail ?? null, loading: current === null, error: current?.error ?? false, refresh: () => refresh.current?.(), updatedAt: current?.updatedAt ?? null }
}
