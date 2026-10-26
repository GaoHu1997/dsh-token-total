/** Resolve historical route ids to the same names the model selector shows.
 *  This is query-time metadata: no store wipe/replay is needed, and a provider
 *  rename applies to both the ranking and every trend bucket on refresh. */
import type { UsageLlmService } from './context-types.ts'
import { modelNameOf, providerOf } from './shared.ts'

const LOOKUP_CONCURRENCY = 4
const LOOKUP_TIMEOUT_MS = 2000

/** Raised when a lookup's own timer fires — i.e. the shared phase budget is
 *  spent. Workers stop on this instead of trusting the wall clock again. */
class LookupTimeoutError extends Error {}

/** Bound metadata queries even if an adapter fails to honor cancellation. */
async function lookup<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new LookupTimeoutError('model display-name lookup timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve provider route ids to the labels the model selector shows. Both
 *  catalogs are presentational and synchronous on the host runtime, so this is
 *  a plain in-process read rather than a per-request lookup: a missing service,
 *  a throwing adapter, or an unexpected promise all resolve to an empty map and
 *  every surface falls back to the raw historical route id. */
export function resolveProviderNames(llm?: UsageLlmService): Record<string, string> {
  const names: Record<string, string> = Object.create(null)
  if (!llm) return names
  try {
    for (const provider of catalog(llm.listProviders?.())) {
      const name = provider.name?.trim()
      if (provider.id && name) names[provider.id] = name
    }
  } catch {
    // Metadata is auxiliary: a broken catalog must never fail the range query.
  }
  try {
    for (const entry of catalog(llm.listConfigurableProviders?.())) {
      const name = entry.displayName?.trim()
      if (entry.provider && name && names[entry.provider] === undefined) names[entry.provider] = name
    }
  } catch {
    // Same contract as above.
  }
  return names
}

/** Both catalogs are declared synchronous, but a host that publishes them over
 *  a remote face would hand back a promise; treat anything that is not an array
 *  as "no metadata" instead of throwing mid-query. */
function catalog<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : []
}

/** Resolve each distinct route once per range query. Unknown/deleted providers
 *  fall back to their bare historical model names in aggregateSamples(). */
export async function resolveModelNames(
  modelRefs: Iterable<string>,
  llm?: UsageLlmService,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (!llm) return names
  const refs = [...new Set(modelRefs)].filter((ref) => ref !== '(unknown)' && ref !== '(turns)')
  if (llm.resolveModelInfo) {
    // Each phase has one shared deadline, not 2s per historical model. Keep
    // a separate catalog phase so slow resolvers cannot consume its budget.
    const deadline = Date.now() + LOOKUP_TIMEOUT_MS
    const pending = refs.values()
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, refs.length) }, async () => {
      for (const ref of pending) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        try {
          const info = await lookup((signal) => llm.resolveModelInfo!(providerOf(ref), modelNameOf(ref), signal), remaining)
          if (info.name?.trim()) names.set(ref, info.name)
        } catch (error) {
          // Metadata is auxiliary: never lose usage because a route is gone.
          // The shared budget is spent once our own timer fires; stop instead
          // of trusting the clock again (setTimeout vs Date.now can disagree
          // by ~1ms and would otherwise queue extra lookups past the deadline).
          if (error instanceof LookupTimeoutError) break
        }
      }
    }))
  }
  // A resolver may reject a historical route, or its base adapter may simply
  // echo the raw id as its name. Try the selector catalog in both cases.
  if (llm.listModels) {
    const deadline = Date.now() + LOOKUP_TIMEOUT_MS
    const unresolved = refs.filter((ref) => !names.has(ref) || names.get(ref) === modelNameOf(ref))
    const pending = new Set(unresolved.map(providerOf)).values()
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, unresolved.length) }, async () => {
      for (const provider of pending) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        try {
          const catalog = await lookup(() => llm.listModels!(provider), remaining)
          const byId = new Map(catalog.map((model) => [model.id, model.name]))
          for (const ref of unresolved) {
            if (providerOf(ref) !== provider) continue
            const name = byId.get(modelNameOf(ref))
            if (name?.trim()) names.set(ref, name)
          }
        } catch (error) {
          // A dormant provider must not prevent historical totals from loading;
          // a fired timer still ends the whole catalog phase (see above).
          if (error instanceof LookupTimeoutError) break
        }
      }
    }))
  }
  return names
}
