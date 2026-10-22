/**
 * The stat-pill glyphs.
 *
 * The shell freezes its primitives table, and that table's icon names moved
 * with the host line: 0.2.1-rc.2 exports `IconGaugeOutlineRegular` /
 * `IconDatabaseOutlineRegular` (plus the `Medium` weight) and no longer
 * exports the `…Outline16` names this plugin used to import. A missing named
 * export is `undefined` at runtime, and React then throws "Element type is
 * invalid" on the entry's first render — the shell's slot boundary catches it,
 * ABDICATES the entry, and the shadowed official pill silently returns. That
 * failure mode is invisible in types (the package's own declarations still
 * describe the old names) and looks exactly like "the plugin did nothing".
 *
 * So the glyph is resolved from the runtime table by preference order and
 * falls back to an inline drawing of the same shape when no name exists, which
 * keeps one published build rendering on every host line.
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

type IconComponent = () => JSX.Element

const table = primitives as unknown as Record<string, unknown>

/** First exported function component among `names`, or null when the shell
 *  exports none of them (an older or newer icon roster). */
function resolveIcon(...names: readonly string[]): IconComponent | null {
  for (const name of names) {
    const candidate = table[name]
    if (typeof candidate === 'function') return candidate as IconComponent
  }
  return null
}

const resolvedGauge = resolveIcon(
  'IconGaugeOutlineRegular',
  'IconGaugeOutlineMedium',
  'IconGaugeOutline16',
)
const resolvedDatabase = resolveIcon(
  'IconDatabaseOutlineRegular',
  'IconDatabaseOutlineMedium',
  'IconDatabaseOutline16',
)

/** Gauge glyph for the activity pill (counts + throughput). */
export function GaugeIcon(): JSX.Element {
  if (resolvedGauge !== null) {
    const Icon = resolvedGauge
    return <Icon />
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5M8 8l2.6-2.6M2.5 8A5.5 5.5 0 0 1 8 2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  )
}

/** Database glyph for the token-usage pill. */
export function DatabaseIcon(): JSX.Element {
  if (resolvedDatabase !== null) {
    const Icon = resolvedDatabase
    return <Icon />
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <ellipse cx="8" cy="3.6" rx="4.6" ry="1.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.4 3.6v8.8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.6M3.4 8c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
