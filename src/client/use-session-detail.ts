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
  retry: () => void
} {
  const [reading, setReading] = useState<{ sessionId: string; detail: SessionUsageDetail | null; error: boolean } | null>(null)
  const refresh = useRef<(() => void) | null>(null)
  useEffect(() => {
    let active = true
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const request = (): void => {
      if (!active || pending || !sessionId) return
      if (timer !== undefined) clearTimeout(timer)
      pending = true
      controller = new AbortController()
      void fetchSessionDetail(sessionId, controller.signal).then(detail => {
        if (active) setReading({ sessionId, detail, error: false })
      }).catch(() => {
        if (active) setReading(previous => ({ sessionId, detail: previous?.sessionId === sessionId ? previous.detail : null, error: true }))
      }).finally(() => {
        pending = false
        if (active) timer = setTimeout(request, DETAIL_POLL_MS)
      })
    }
    const wake = (): void => { if (document.visibilityState === 'visible') request() }
    refresh.current = request
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
  return { detail: current?.detail ?? null, loading: current === null, error: current?.error ?? false, retry: () => refresh.current?.() }
}
