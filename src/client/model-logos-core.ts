/**
 * Brand matching for the usage panel's per-model logos: maps whatever naming
 * fields a usage record carries (provider id, raw model id, resolved display
 * names) onto one of the bundled brand logos in model-logos-data.ts. This is
 * presentation-only metadata — a miss just means the neutral glyph, never a
 * lost record.
 */
import { MODEL_LOGOS } from './model-logos-data.ts'

/** Brand id -> first-matching pattern over one stage's lowercased joined
 *  haystack, most distinctive brands first.
 *  Long unique names match as plain substrings; short or collision-prone
 *  ones (the OpenAI "o3" series, StepFun "step", Cohere "command", Yi,
 *  Amazon "nova", Microsoft "phi") require word/dash boundaries so
 *  "gpt-4o" stays OpenAI, "multistep-2" stays unknown and "commander" is
 *  not Cohere. Serving platforms (groq, openrouter, ollama, …) sit last:
 *  an identifiable model id always beats the platform that served it. */
const MATCHERS: ReadonlyArray<readonly [string, RegExp]> = [
  // ai360 precedes openai: its "360gpt" ids must not fall to the plain "gpt".
  ['ai360', /ai360|360gpt|智脑/],
  ['deepseek', /deepseek/],
  ['openai', /openai|chatgpt|gpt|davinci|\bo[134](?:-|$)/],
  ['claude', /claude|anthropic/],
  ['gemini', /gemini|gemma|google|vertex/],
  ['qwen', /qwen|qwq|qvq|tongyi|通义|百炼/],
  ['zhipu', /zhipu|chatglm|glm|智谱|(?:^|[^a-z0-9])zai(?:-|$)/],
  ['kimi', /kimi|moonshot|月之暗面/],
  ['grok', /grok|\bxai\b/],
  // Boundary before "llama" so the "ollama" platform falls through to its own
  // logo; codellama is named explicitly since its "llama" is mid-word.
  ['llama', /(?:^|[^a-z0-9])llama|codellama|\bmeta\b/],
  ['mistral', /mistral|mixtral|codestral|ministral|magistral|pixtral|voxtral|devstral/],
  ['doubao', /doubao|bytedance|volcengine|豆包|火山|(?:^|[^a-z0-9])seed(?:-|$)/],
  ['minimax', /minimax|abab/],
  ['hunyuan', /hunyuan|tencent|混元|腾讯/],
  ['ernie', /ernie|wenxin|baidu|qianfan|文心|百度/],
  ['stepfun', /stepfun|阶跃|(?:^|[^a-z0-9])step(?:-|$)/],
  ['cohere', /cohere|(?:^|[^a-z0-9])command(?:-|$)|c4ai/],
  ['xiaomi', /xiaomi|mimo|小米/],
  ['baichuan', /baichuan|百川/],
  ['yi', /01-?ai|lingyi|零一万物|(?:^|[^a-z0-9])yi(?:-|$)/],
  ['spark', /spark|iflytek|xfyun|讯飞|星火/],
  ['sensenova', /sensenova|商汤/],
  ['internlm', /internlm|书生/],
  ['microsoft', /microsoft|azure|(?:^|[^a-z0-9])phi(?:-\d|$)/],
  ['nvidia', /nvidia|nemotron|英伟达/],
  ['amazon', /amazon|bedrock|aws|(?:^|[^a-z0-9])(?:nova|titan)(?:-|$)/],
  ['ibm', /(?:^|[^a-z0-9])ibm(?:-|$)|granite/],
  ['databricks', /databricks|dbrx/],
  ['perplexity', /perplexity|(?:^|[^a-z0-9])sonar(?:-|$)/],
  ['ai21', /ai21|jamba/],
  ['upstage', /upstage|(?:^|[^a-z0-9])solar(?:-|$)/],
  ['jina', /jina/],
  ['reka', /(?:^|[^a-z0-9])reka(?:-|$)/],
  ['snowflake', /snowflake|arctic/],
  ['sambanova', /sambanova/],
  ['infinigence', /infinigence|无问芯穹/],
  ['rwkv', /(?:^|[^a-z0-9])rwkv(?:-|$)/],
  ['falcon', /(?:^|[^a-z0-9])(?:falcon|tii)(?:-|$)/],
  ['groq', /groq/],
  ['together', /together/],
  ['fireworks', /fireworks/],
  ['cerebras', /cerebras/],
  ['openrouter', /openrouter/],
  ['siliconflow', /siliconflow|siliconcloud|硅基流动/],
  ['ollama', /ollama/],
  ['huggingface', /huggingface|hugging/],
  ['novita', /novita/],
  ['deepinfra', /deepinfra/],
  ['modelscope', /modelscope|魔搭/],
]

/** Brand ids in match order — every id here must ship markup. */
export const MODEL_LOGO_BRANDS: ReadonlyArray<string> = MATCHERS.map(([id]) => id)

/** Resolve the brand id for one usage record. The model's own naming (raw
 *  model id plus its resolved display name) decides the brand when it can;
 *  the provider fields (route id and provider display names) are the fallback
 *  for opaque model ids, so a Llama served through a vertex/google route keeps
 *  the Llama mark. Empty/undefined parts are ignored; null when no bundled
 *  brand matches. */
export function resolveModelLogo(
  provider: string | null | undefined,
  model: string | null | undefined,
  name?: string | null,
  providers?: ReadonlyArray<string>,
): string | null {
  return matchBrand(model, name) ?? matchBrand(provider, ...(providers ?? []))
}

function matchBrand(...parts: ReadonlyArray<string | null | undefined>): string | null {
  const haystack = parts.filter((part) => typeof part === 'string' && part !== '').join('/').toLowerCase()
  if (haystack === '') return null
  for (const [id, pattern] of MATCHERS) if (pattern.test(haystack)) return id
  return null
}

/** Inner SVG markup of a brand's logo, or undefined for an unknown id. */
export function modelLogoMarkup(id: string | null): string | undefined {
  return id === null ? undefined : MODEL_LOGOS[id]
}
