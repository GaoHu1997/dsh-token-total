import { modelLogoMarkup, resolveModelLogo } from './model-logos-core.ts'

/** Neutral glyph for models no bundled brand matches: a soft four-point AI
 *  spark in the panel's muted gray, so an unknown model reads as "unbranded"
 *  rather than as some other vendor. */
const FALLBACK = '<path d="M12 1.6l2.14 5.96a2 2 0 0 0 1.22 1.22l5.96 2.14-5.96 2.14a2 2 0 0 0-1.22 1.22L12 20.24l-2.14-5.96a2 2 0 0 0-1.22-1.22L2.68 10.92l5.96-2.14a2 2 0 0 0 1.22-1.22L12 1.6z" fill="#9aa3b3"/>'

export interface ModelLogoProps {
  /** Raw model id; may itself be a "provider/model" ref. */
  model: string
  /** Resolved model display name (the by-model row's label) — matched with
   *  the raw id, so an opaque route id beside a brandful name still brands. */
  name?: string
  /** Provider route id — a secondary match signal for opaque model ids. */
  provider?: string
  /** Resolved provider display names (the by-model row's split), matched last. */
  providers?: ReadonlyArray<string>
  /** Rendered square size; the record rows read at 13px. */
  size?: number
  className?: string
}

/** One model's brand logo inline. The markup is a bundled constant (never
 *  request data) rendered as-is so each brand keeps its own gradients,
 *  circles and multi-path fills; ids inside stay unique across brands. */
export function ModelLogo({ model, name, provider, providers, size = 13, className }: ModelLogoProps): JSX.Element {
  const markup = modelLogoMarkup(resolveModelLogo(provider, model, name, providers)) ?? FALLBACK
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} dangerouslySetInnerHTML={{ __html: markup }} />
}
