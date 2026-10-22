import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MEASURE_STYLE } from './stat-dialog.ts'
import { contextBreakdownSegments, contextOccupancy, formatContextTokens, type ContextBreakdownLike, type ContextPressureLike } from './context-meter-core.ts'
import css from './ContextUsageEntry.module.css'

export const CONTEXT_LOCALE_NS = 'tokenTotalContext'
const keys = ['label', 'used', 'system', 'tools', 'messages', 'aria', 'thousand', 'million'] as const
export type ContextLocaleKey = typeof keys[number]
export const CONTEXT_LOCALES: Record<string, Record<ContextLocaleKey, string>> = {
  zh: { label: '上下文', used: '上下文已用', system: '系统提示词', tools: '工具定义', messages: '对话消息', aria: '上下文已用 {percent}', thousand: '{value}K', million: '{value}M' },
  en: { label: 'Context', used: 'Context used', system: 'System', tools: 'Tools', messages: 'Conversation', aria: 'Context usage {percent}', thousand: '{value}K', million: '{value}M' },
  'zh-TW': { label: '上下文', used: '已用上下文', system: '系統提示詞', tools: '工具', messages: '對話', aria: '上下文使用量 {percent}', thousand: '{value}千', million: '{value}百萬' },
}

type ProjectionMap = {
  contextPressure: ContextPressureLike
  contextBreakdown: ContextBreakdownLike
}
type UseContextProjection = <K extends keyof ProjectionMap & string>(key: K) => ProjectionMap[K] | undefined

export interface ContextUsageEntryProps extends PropsLocale<typeof CONTEXT_LOCALE_NS> {
  useProjection: UseContextProjection
  installContextTakeover?: (anchor: HTMLElement) => () => void
}

export function ContextUsageEntry({ useProjection, t, installContextTakeover }: ContextUsageEntryProps): JSX.Element | null {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const context = contextOccupancy(pressure)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({ open: open && context !== null, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open && context !== null, setOpen, panelRef)
  useLayoutEffect(() => {
    const anchor = rootRef.current
    if (anchor === null || context === null || installContextTakeover === undefined) return
    return installContextTakeover(anchor)
  }, [context !== null, installContextTakeover])
  useEffect(() => { if (context === null && open) setOpen(false) }, [context, open])
  useEffect(() => {
    if (!open || context === null) return
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [context, open])
  if (context === null) return null
  const percent = context.percent
  const reading = `${percent}%`
  const segments = contextBreakdownSegments(percent, breakdown)
  const format = (value: number): string => formatContextTokens(value, {
    thousand: t('thousand'), million: t('million'),
  })
  const [headBefore = '', headAfter = ''] = t('aria', { percent: '\0' }).split('\0').map(part => part.trim())
  const rowLabels = ['system', 'tools', 'messages'] as const
  const rowColors = ['colorSystem', 'colorTools', 'colorMessages'] as const
  const segmentColors: Record<string, string> = { systemTokens: css.colorSystem, toolsTokens: css.colorTools, messageTokens: css.colorMessages }
  return (
    <span ref={rootRef} className={css.root} data-dsh-token-total-stat="context">
      <button type="button" className={css.trigger} aria-label={t('aria', { percent: reading })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <circle className={css.track} cx="7" cy="7" r="5.5" />
          <circle className={css.fill} cx="7" cy="7" r="5.5" strokeDasharray={`${2 * Math.PI * 5.5 * percent / 100} ${2 * Math.PI * 5.5}`} transform="rotate(-90 7 7)" />
        </svg>
        <span>{reading}</span>
      </button>
      {open && createPortal(
        <div ref={panelRef} className={css.panel} style={position ?? MEASURE_STYLE} role="dialog" aria-label={t('used')}>
          <div className={css.header}>
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>{`~${format(context.usedTokens)} / ${format(context.contextWindow)}`}</span>
          </div>
          <div className={css.bar}>{segments.map(segment => <div key={segment.key} className={segmentColors[segment.key] === undefined ? css.segment : `${css.segment} ${segmentColors[segment.key]}`} style={{ width: `${segment.width}%` }} />)}</div>
          {breakdown !== undefined && <dl className={css.rows}>
            {(['systemTokens', 'toolsTokens', 'messageTokens'] as const).map((key, index) => <div className={css.row} key={key}>
              <dt><span className={`${css.swatch} ${css[rowColors[index]]}`} />{t(rowLabels[index])}</dt>
              <dd>{`~${format(breakdown[key])}`}</dd>
            </div>)}
          </dl>}
        </div>, document.body,
      )}
    </span>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { tokenTotalContext: ContextLocaleKey }
}
