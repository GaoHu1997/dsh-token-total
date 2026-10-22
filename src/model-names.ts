/** Resolve historical route ids to the same names the model selector shows.
 *  This is query-time metadata: no store wipe/replay is needed, and a provider
 *  rename applies to both the ranking and every trend bucket on refresh. */
import type { UsageLlmService } from './context-types.ts'
import { modelNameOf, providerOf } from './shared.ts'

const LOOKUP_CONCURRENCY = 4
const LOOKUP_TIMEOUT_MS = 2000

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
          reject(new Error('model display-name lookup timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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
        } catch {
          // Metadata is auxiliary: never lose usage because a route is gone.
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
        } catch {
          // A dormant provider must not prevent historical totals from loading.
        }
      }
    }))
  }
  return names
}
