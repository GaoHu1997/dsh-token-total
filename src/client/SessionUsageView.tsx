import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionUsageDetail, SessionUsageTotals } from '../wire.ts'
import { billedTotal, cacheHitPercentOf } from './session-usage-core.ts'
import { formatCompact, formatTokens, normalizeModelName, decodeRateOf } from './format.ts'
import { SESSION_USAGE_NS, type SessionUsageKey } from './session-usage-locales.ts'
import { useSessionDetail } from './use-session-detail.ts'
import { ModelLogo } from './ModelLogo.tsx'
import css from './SessionUsageView.module.css'

type T = (key: SessionUsageKey) => string
type Row = SessionUsageDetail['records'][number]
export type SessionUsageViewProps = PropsLocale<typeof SESSION_USAGE_NS> & { sessionId: string }

const seconds = (ms: number | null): string => ms !== null && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '—'
// Request-log style metrics follow the reference log: seconds without trailing
// ".0", short lowercase tokens (80.0k / 1.5M), integer percentages.
const secText = (ms: number | null): string => ms !== null && Number.isFinite(ms) ? String(Math.round(ms / 100) / 10) : '—'
const tokShort = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const pctInt = (rate: number | null): string => rate === null ? '—' : `${Math.round(rate)}%`
const speed = (n: number | null): string => n !== null && Number.isFinite(n) ? `${Math.round(n)} tok/s` : '—'
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const modelShort = (ref: string): string => ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref
const zero = (): SessionUsageTotals => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const sum = (rows: Row[]): SessionUsageTotals => rows.reduce((acc, r) => ({
  uncachedInputTokens: acc.uncachedInputTokens + r.totals.uncachedInputTokens,
  outputTokens: acc.outputTokens + r.totals.outputTokens,
  cacheReadTokens: acc.cacheReadTokens + r.totals.cacheReadTokens,
  cacheWriteTokens: acc.cacheWriteTokens + r.totals.cacheWriteTokens,
}), zero())

function Token({ n }: { n: number }): JSX.Element {
  return <span className={css.number} title={formatTokens(n)}>{formatCompact(n)}</span>
}

function Hit({ totals }: { totals: SessionUsageTotals }): JSX.Element {
  const rate = cacheHitPercentOf(totals)
  return <span className={rate === null ? css.muted : rate >= 80 ? css.good : rate >= 50 ? css.warn : css.bad}>{rate === null ? '—' : `${rate.toFixed(1)}%`}</span>
}

const icons = {
  requests: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  tokens: 'M4 8c0-2.2 3.6-4 8-4s8 1.8 8 4-3.6 4-8 4-8-1.8-8-4Zm0 0v8c0 2.2 3.6 4 8 4s8-1.8 8-4V8',
  hit: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  speed: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  input: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  output: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  read: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  write: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z',
}

function Stat({ tone, name, label, value, sub, title }: { tone: string; name: keyof typeof icons; label: string; value: string | JSX.Element; sub?: string; title?: string }): JSX.Element {
  const icon = icons[name]
  return <article className={`${css.stat} ${tone}`}>
    {/* Oversized gradient watermark filling the card's empty right side. */}
    <svg className={css.statMark} viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id={`usage-mark-${name}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.3" /><stop offset="1" stopColor="currentColor" stopOpacity="0.03" /></linearGradient></defs>
      <path d={icon} fill={`url(#usage-mark-${name})`} stroke={`url(#usage-mark-${name})`} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <div className={css.statHead}><span className={css.statIcon}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg></span><span className={css.statLabel}>{label}</span></div>
    <strong className={css.statValue} title={title}>{value}</strong>
    {sub !== undefined && <span className={css.statSub}>{sub}</span>}
  </article>
}

function Metrics({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element {
  const billed = billedTotal(detail.totals)
  const failed = detail.records.filter(row => row.status === 'failed').length
  const failRate = detail.requests > 0 ? (failed / detail.requests * 100).toFixed(1) : '0.0'
  return <div className={css.stats}>
    <div className={css.statRow}>
      <Stat tone={css.toneBlue} name="requests" label={t('requestsCount')} value={formatTokens(detail.requests)} sub={`${t('failed')} ${failed} · ${failRate}%`} />
      <Stat tone={css.tonePurple} name="tokens" label={t('tokens')} value={formatCompact(billed)} title={formatTokens(billed)} sub={`${formatTokens(billed)} tokens`} />
      <Stat tone={css.toneGreen} name="hit" label={t('hit')} value={<Hit totals={detail.totals} />} sub={`${formatCompact(detail.totals.cacheReadTokens)} ${t('cacheHit')}`} />
      <Stat tone={css.toneOrange} name="speed" label={t('speed')} value={speed(detail.tokensPerSecond)} sub={`${t('first')} ${seconds(detail.averageFirstTokenMs)}`} />
    </div>
    <div className={css.statRow}>
      <Stat tone={css.toneTeal} name="input" label={t('inputFull')} value={formatCompact(detail.totals.uncachedInputTokens)} title={formatTokens(detail.totals.uncachedInputTokens)} sub={formatTokens(detail.totals.uncachedInputTokens)} />
      <Stat tone={css.toneOrange} name="output" label={t('outputFull')} value={formatCompact(detail.totals.outputTokens)} title={formatTokens(detail.totals.outputTokens)} sub={formatTokens(detail.totals.outputTokens)} />
      <Stat tone={css.tonePurple} name="read" label={t('readFull')} value={formatCompact(detail.totals.cacheReadTokens)} title={formatTokens(detail.totals.cacheReadTokens)} sub={formatTokens(detail.totals.cacheReadTokens)} />
      <Stat tone={css.tonePink} name="write" label={t('writeFull')} value={formatCompact(detail.totals.cacheWriteTokens)} title={formatTokens(detail.totals.cacheWriteTokens)} sub={formatTokens(detail.totals.cacheWriteTokens)} />
    </div>
  </div>
}

function Tables({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element {
  // The by-model card labels rows with the model selector's display name, never
  // the route id (which stays in the tooltip). When two rows end up sharing one
  // display name, each of those rows additionally shows its provider in gray
  // below the name so they stay tellable apart.
  const nameCounts = new Map<string, number>()
  for (const row of detail.models) {
    const key = normalizeModelName(row.name?.trim() || row.model)
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  return <div className={css.mid}>
    <section className={css.card}><header className={css.cardHead}><h2>{t('children')} <span className={css.count}>{detail.subagents.length}</span></h2></header>
      <table className={`${css.table} ${css.childTable}`}><colgroup><col className={css.childName} /><col className={css.childRequests} /><col /><col /><col /><col /></colgroup>
        <thead><tr><th>{t('session')}</th><th>{t('requests')}</th><th>{t('tokens')}</th><th>{t('hit')}</th><th>{t('first')}</th><th>{t('speed')}</th></tr></thead>
        <tbody>{detail.subagents.map(row => <tr key={row.sessionId}><td><span className={css.ellipsis} title={row.name || row.sessionId}>{row.name || row.sessionId}</span></td><td>{formatTokens(row.requests)}</td><td><Token n={billedTotal(row.totals)} /></td><td><Hit totals={row.totals} /></td><td>{seconds(row.averageFirstTokenMs)}</td><td><span className={css.speedCell}>{row.tokensPerSecond === null ? '—' : <>{Math.round(row.tokensPerSecond)}<small>tok/s</small></>}</span></td></tr>)}</tbody>
      </table>{detail.subagents.length === 0 && <p className={css.empty}>{t('noChildren')}</p>}
    </section>
    <section className={css.card}><header className={css.cardHead}><h2>{t('models')} <span className={css.count}>{detail.models.length}</span></h2></header>
      <table className={`${css.table} ${css.modelTable}`}><colgroup><col className={css.modelName} /><col className={css.modelRequests} /><col /><col /><col /><col /><col className={css.modelHit} /></colgroup>
        <thead><tr><th>{t('model')}</th><th>{t('requests')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('read')}</th><th>{t('write')}</th><th>{t('hit')}</th></tr></thead>
        <tbody>{detail.models.map(row => {
          const name = row.name?.trim() || row.model
          const providers = row.providers ?? []
          const shared = (nameCounts.get(normalizeModelName(name)) ?? 0) > 1
          return <tr key={row.model}>
            <td><span className={css.modelNameCell}><ModelLogo model={row.model} name={row.name} providers={row.providers} className={css.modelLogo} /><span className={css.ellipsis} title={row.model}>{name}</span></span>
              {shared && providers.length > 0 ? <small className={css.modelProvider} title={providers.join(' / ')}>{providers.join(' / ')}</small> : null}
            </td>
            <td>{formatTokens(row.requests)}</td><td><Token n={row.totals.uncachedInputTokens} /></td><td><Token n={row.totals.outputTokens} /></td><td><Token n={row.totals.cacheReadTokens} /></td><td><Token n={row.totals.cacheWriteTokens} /></td><td><Hit totals={row.totals} /></td>
          </tr>
        })}</tbody>
      </table>{detail.models.length === 0 && <p className={css.empty}>{t('noModels')}</p>}
    </section>
  </div>
}

function Records({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element {
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const [allOpen, setAllOpen] = useState(false)
  const toggleAll = (): void => { setAllOpen(!allOpen); setOpened(new Set()) }
  const toggle = (id: string): void => setOpened(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const providerNames = new Map(detail.routes.map(route => [route.provider, route.name]))
  // Fold by conversation turn: one collapsible group per session turn, holding
  // every request of that turn. A group is titled by what the turn did (the
  // turn's first real user prompt, turnName from the backend), never by the
  // session name: the page header already names this session, so repeating it on
  // every row would only crowd out the topic. A subagent's turn gets a compact
  // "subagent" tag instead, with the full session name kept in its tooltip —
  // that tag is the only thing distinguishing it from this session's own turns.
  const groups: Array<{ key: string; turn: number; name: string; topic: string; main: boolean; rows: Row[] }> = []
  const index = new Map<string, { key: string; turn: number; name: string; topic: string; main: boolean; rows: Row[] }>()
  for (const record of detail.records) {
    const key = `${record.sessionId}:${record.turn}`
    let group = index.get(key)
    if (!group) {
      group = {
        key,
        turn: record.turn,
        name: record.sessionName || record.sessionId,
        topic: record.turnName || `${t('turn')} ${record.turn}`,
        main: record.sessionId === detail.sessionId,
        rows: [],
      }
      index.set(key, group); groups.push(group)
    }
    group.rows.push(record)
  }
  return <section className={css.card}><header className={css.cardHead}><h2>{t('records')} <span className={css.count}>{detail.records.length}</span></h2><button type="button" className={css.action} onClick={toggleAll}>{t(allOpen ? 'collapse' : 'expand')}</button></header>
    <div className={css.turnList}>{groups.map(group => {
      const open = allOpen !== opened.has(group.key)
      const totals = sum(group.rows)
      const billed = billedTotal(totals)
      const running = group.rows.filter(row => row.status === 'running').length
      // Same decode based rate as the card and the composer bottom bar: the
      // turn's output tokens over its summed decode windows, never the mean of
      // independently rounded per-request rates.
      const rate = decodeRateOf(group.rows)
      const avgRate = rate === null ? null : Math.round(rate)
      return <article key={group.key} className={css.turn}>
        <button type="button" className={css.turnHead} onClick={() => toggle(group.key)} aria-expanded={open} aria-controls={`usage-turn-${encodeURIComponent(group.key)}`}>
          <svg className={`${css.chevron} ${open ? css.rotated : ''}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
          <span className={css.turnTitle}>
            {group.main ? null : <span className={css.turnAgent} title={group.name}>{t('children')}</span>}
            <span className={css.turnTopic} title={group.turn === 0 ? t('compaction') : group.topic}>{group.turn === 0 ? t('compaction') : group.topic}</span>
          </span>
          <span className={css.turnSummary}>
            <span>{group.rows.length} {t('reqTimes')} · <span className={css.number} title={formatTokens(billed)}>{tokShort(billed)}</span> {t('tokenWord')}{running > 0 ? ` · ${running} ${t('inProgress')}` : ''}</span>
            <span>{t('avgCache')} {pctInt(cacheHitPercentOf(totals))}</span>
            <span>{t('avgRate')} {avgRate === null ? '—' : avgRate} {t('perSec')}</span>
          </span>
        </button>
        <div id={`usage-turn-${encodeURIComponent(group.key)}`} className={css.turnBody} hidden={!open}>
          {/* Requests arrive in event order, so every turn lists its newest
              request first; turn groups themselves keep chronological order. */}
          {group.rows.slice().reverse().map(record => {
            const duration = record.finishedAt !== null ? record.finishedAt - record.startedAt : null
            const billed = billedTotal(record.totals)
            const hit = cacheHitPercentOf(record.totals)
            const meta: Array<{ text: string; title?: string }> = []
            if (duration !== null) meta.push({ text: `${secText(duration)} ${t('sec')}` })
            if (record.firstTokenMs !== null) meta.push({ text: `${t('firstWait')} ${secText(record.firstTokenMs)} ${t('sec')}` })
            meta.push({ text: `${tokShort(billed)} ${t('tokenWord')}`, title: formatTokens(billed) })
            if (hit !== null) meta.push({ text: `${t('cacheShort')} ${pctInt(hit)}` })
            if (record.tokensPerSecond !== null) meta.push({ text: `${Math.round(record.tokensPerSecond)} ${t('perSec')}` })
            const statusText = record.status === 'running' ? t('answering') : record.status === 'completed' ? '' : t(record.status)
            return <div key={record.id} className={css.turnRequest}>
              <span className={css.requestTime}>{clock(record.startedAt)}</span>
              <div className={css.turnRequestHead}>
                <span className={`${css.statusDot} ${record.status === 'running' ? css.live : record.status === 'failed' ? css.bad : record.status === 'interrupted' ? css.muted : css.good}`} />
                <span className={css.recordModel} title={`${record.provider} / ${record.model}`}><ModelLogo provider={record.provider} model={record.model} className={css.modelLogo} />{record.model || '—'}</span>
                <span className={css.routeText} title={record.provider}>{providerNames.get(record.provider) || record.provider || '—'} · {modelShort(record.model) || '—'}</span>
                {record.effort ? <span className={css.effort}>· {record.effort}</span> : null}
                {statusText !== '' && <span className={record.status === 'running' ? css.live : record.status === 'failed' ? css.bad : css.muted}>{statusText}</span>}
              </div>
              {record.finishedAt !== null && <div className={css.recordMeta}>{meta.map((item, i) => <span key={i} title={item.title}>{i > 0 ? ' · ' : ''}{item.text}</span>)}</div>}
            </div>
          })}
        </div>
      </article>
    })}</div>{detail.records.length === 0 && <p className={css.empty}>{t('empty')}</p>}
  </section>
}

/** Pure presentation export also used by offline visual regression fixtures. */
export function SessionUsageContent({ detail, t }: { detail: SessionUsageDetail; t: T }): JSX.Element {
  return <><p className={css.scope}>{t('scope')}</p><Metrics detail={detail} t={t} /><Tables detail={detail} t={t} /><Records key={detail.sessionId} detail={detail} t={t} /><p className={css.note}>{t('note')}</p></>
}

export function SessionUsageView({ sessionId, t }: SessionUsageViewProps): JSX.Element {
  const { detail, loading, error, refresh, updatedAt } = useSessionDetail(sessionId)
  return <div className={css.scroll} data-dsh-session-usage><div className={css.page}>
    {/* Freshness header: the view polls continuously, so it always shows a live
        badge with the time of the last successful read, plus a manual refresh
        that refetches immediately. */}
    <header className={css.head}>
      <span className={css.headStatus}>
        <span className={css.liveDot} aria-hidden="true" />
        <span>{t('live')}</span>
        {updatedAt !== null && <span className={css.asOf}>{t('asOf')} {clock(updatedAt)}</span>}
      </span>
      <button type="button" className={css.refresh} onClick={refresh} disabled={loading}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
        {t('refresh')}
      </button>
    </header>
    {loading && <p className={css.empty} role="status">{t('loading')}</p>}
    {error && <div className={css.error} role="status">{t('failedLoad')}<button type="button" className={css.action} onClick={refresh}>{t('retry')}</button></div>}
    {detail && <SessionUsageContent detail={detail} t={t} />}
  </div></div>
}
