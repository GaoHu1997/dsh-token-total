import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { modelLogoMarkup, resolveModelLogo, MODEL_LOGO_BRANDS } from '../src/client/model-logos-core.ts'
import { MODEL_LOGOS } from '../src/client/model-logos-data.ts'

// Every usage record names its model in several fields (provider route id,
// raw model id, resolved display names); any one of them may carry the brand.

test('model ids resolve to their brand', () => {
  assert.equal(resolveModelLogo('dseek', 'deepseek-v4'), 'deepseek')
  assert.equal(resolveModelLogo(null, 'deepseek-chat'), 'deepseek')
  assert.equal(resolveModelLogo('openai', 'gpt-4o'), 'openai')
  assert.equal(resolveModelLogo(null, 'chatgpt-4o-latest'), 'openai')
  assert.equal(resolveModelLogo(null, 'claude-sonnet-4-5'), 'claude')
  assert.equal(resolveModelLogo('anthropic', 'claude-3.5-haiku'), 'claude')
  assert.equal(resolveModelLogo('google', 'gemini-2.5-pro'), 'gemini')
  assert.equal(resolveModelLogo(null, 'gemma-3-27b'), 'gemini')
  assert.equal(resolveModelLogo(null, 'qwen3-max'), 'qwen')
  assert.equal(resolveModelLogo(null, 'glm-4.6'), 'zhipu')
  assert.equal(resolveModelLogo(null, 'chatglm3-6b'), 'zhipu')
  assert.equal(resolveModelLogo(null, 'kimi-k2'), 'kimi')
  assert.equal(resolveModelLogo(null, 'moonshot-v1-8k'), 'kimi')
  assert.equal(resolveModelLogo(null, 'grok-3-mini'), 'grok')
  assert.equal(resolveModelLogo(null, 'llama-3.3-70b'), 'llama')
  assert.equal(resolveModelLogo(null, 'mistral-large'), 'mistral')
  assert.equal(resolveModelLogo(null, 'mixtral-8x7b'), 'mistral')
  assert.equal(resolveModelLogo(null, 'codestral-latest'), 'mistral')
  assert.equal(resolveModelLogo('volcengine', 'doubao-1.5-pro'), 'doubao')
  assert.equal(resolveModelLogo(null, 'doubao-seed-1-6'), 'doubao')
  assert.equal(resolveModelLogo(null, 'minimax-m2'), 'minimax')
  assert.equal(resolveModelLogo(null, 'abab6.5s'), 'minimax')
  assert.equal(resolveModelLogo('tencent', 'hunyuan-turbos'), 'hunyuan')
  assert.equal(resolveModelLogo(null, 'ernie-4.5'), 'ernie')
  assert.equal(resolveModelLogo(null, 'step-2-16k'), 'stepfun')
  assert.equal(resolveModelLogo(null, 'command-r-plus'), 'cohere')
  assert.equal(resolveModelLogo(null, 'c4ai-aya-expanse'), 'cohere')
})

test('bare o-series models are OpenAI without touching gpt-4o internals', () => {
  assert.equal(resolveModelLogo(null, 'o3-mini'), 'openai')
  assert.equal(resolveModelLogo(null, 'o1-preview'), 'openai')
  assert.equal(resolveModelLogo(null, 'o4-mini'), 'openai')
  // The "4o" inside gpt-4o must not read as an o-series ref (same brand, the
  // boundary rule still has to hold for proto1-style ids to stay unknown).
  assert.equal(resolveModelLogo(null, 'proto1'), null)
  assert.equal(resolveModelLogo(null, 'o11'), null)
})

test('provider ids and display names match when the model id is opaque', () => {
  assert.equal(resolveModelLogo('openai', 'mystery-9'), 'openai')
  assert.equal(resolveModelLogo('zhipu', 'mystery-9'), 'zhipu')
  assert.equal(resolveModelLogo('xai', 'mystery-9'), 'grok')
  assert.equal(resolveModelLogo('meta', 'mystery-9'), 'llama')
  assert.equal(resolveModelLogo('vertexai', 'mystery-9'), 'gemini')
  assert.equal(resolveModelLogo('bytedance', 'ui-tars'), 'doubao')
  assert.equal(resolveModelLogo('cohere', 'aya-23'), 'cohere')
  assert.equal(resolveModelLogo(null, 'anthropic/claude-3.5-sonnet'), 'claude')
  // The model's resolved display name rides along with the raw id.
  assert.equal(resolveModelLogo('ghost', 'ghost-1', 'DeepSeek'), 'deepseek')
})

test('chinese provider aliases match', () => {
  assert.equal(resolveModelLogo('月之暗面', 'k2'), 'kimi')
  assert.equal(resolveModelLogo('智谱', 'mystery-9'), 'zhipu')
  assert.equal(resolveModelLogo('通义千问', 'mystery-9'), 'qwen')
  assert.equal(resolveModelLogo('火山引擎', 'mystery-9'), 'doubao')
  assert.equal(resolveModelLogo('百度', 'mystery-9'), 'ernie')
  assert.equal(resolveModelLogo('腾讯', 'mystery-9'), 'hunyuan')
})

test('matching is case-insensitive over the joined fields', () => {
  assert.equal(resolveModelLogo(null, 'DeepSeek-Chat'), 'deepseek')
  assert.equal(resolveModelLogo(null, 'GLM-4.6'), 'zhipu')
  assert.equal(resolveModelLogo(null, 'MiniMax-M2'), 'minimax')
})

test('boundary-guarded keywords do not fire inside other words', () => {
  assert.equal(resolveModelLogo(null, 'multistep-2'), null)
  assert.equal(resolveModelLogo(null, 'steps'), null)
  assert.equal(resolveModelLogo(null, 'commander-x'), null)
  assert.equal(resolveModelLogo(null, 'seeds'), null)
  // The llama boundary keeps "ollama" (and mid-word llama) out of Meta's mark;
  // yi, phi, nova, sonar, solar, reka, rwkv, falcon are all boundary-guarded.
  assert.equal(resolveModelLogo('ollama', 'mystery-9'), 'ollama')
  assert.equal(resolveModelLogo(null, 'zhiyi-2'), null)
  assert.equal(resolveModelLogo(null, 'dolphin-3'), null)
  assert.equal(resolveModelLogo(null, 'supernova'), null)
  assert.equal(resolveModelLogo(null, 'resonar'), null)
  assert.equal(resolveModelLogo(null, 'solaris-9'), null)
})

test('unknown or empty naming falls back to nothing', () => {
  assert.equal(resolveModelLogo('ghost', 'mystery-9'), null)
  assert.equal(resolveModelLogo('', ''), null)
  assert.equal(resolveModelLogo(), null)
  assert.equal(resolveModelLogo(undefined, null), null)
})

test('the model\'s own naming outranks the provider route', () => {
  // A self-identifying model id keeps its brand even when the provider route
  // names an earlier matcher: a Llama on a vertex route is not a Gemini.
  assert.equal(resolveModelLogo('vertexai', 'llama-3.3-70b'), 'llama')
  assert.equal(resolveModelLogo('google', 'qwen3-max'), 'qwen')
  // Opaque ids still fall back to the provider fields (route id first, then
  // provider display names).
  assert.equal(resolveModelLogo('vertexai', 'mystery-9'), 'gemini')
  assert.equal(resolveModelLogo('ghost', 'mystery-9', undefined, ['DeepSeek Official']), 'deepseek')
  // The by-model row's real gap: an opaque route id beside a brandful display
  // name must show that brand, not the neutral glyph.
  assert.equal(resolveModelLogo('ghost', 'mystery-9', 'Kimi K2'), 'kimi')
  assert.equal(resolveModelLogo(undefined, 'model-with-a-long-name', 'GPT 6.1 sol', ['GitHub Models', 'Azure']), 'openai')
})

// The component half: the view tests stub ModelLogo, so the real render path
// (brand markup via dangerouslySetInnerHTML, the neutral fallback, prop
// passthrough) is exercised here against a fake JSX runtime.
const require = createRequire(import.meta.url)
const ts = require('typescript')
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const jsx = (type, props = {}, key) => typeof type === 'function' ? type(props) : { type, props, key }
const logoSandbox = createContext({ exports: {} })
logoSandbox.require = name => name === 'react/jsx-runtime'
  ? { jsx, jsxs: jsx, Fragment: 'fragment' }
  : name === './model-logos-core.ts'
    ? { modelLogoMarkup, resolveModelLogo }
    : assert.fail(name)
runInContext(await compile('../src/client/ModelLogo.tsx'), logoSandbox)

test('the real component injects brand markup, keeps the fallback neutral and never interpolates request data', () => {
  const { ModelLogo } = logoSandbox.exports
  const known = ModelLogo({ model: 'deepseek-chat', size: 16, className: 'x' })
  assert.equal(known.type, 'svg')
  assert.equal(known.props.width, 16)
  assert.equal(known.props.height, 16)
  assert.equal(known.props.className, 'x')
  assert.ok(known.props.dangerouslySetInnerHTML.__html.includes('4D6BFE'), 'brand markup is injected verbatim')
  const fallback = ModelLogo({ model: 'totally-unknown-model', provider: 'ghost' })
  assert.ok(fallback.props.dangerouslySetInnerHTML.__html.includes('#9aa3b3'), 'unknown models get the neutral spark glyph')
  assert.ok(!fallback.props.dangerouslySetInnerHTML.__html.includes('<svg'), 'the fallback hosts no nested svg root')
  const empty = ModelLogo({ model: '', providers: [] })
  assert.ok(empty.props.dangerouslySetInnerHTML.__html.includes('#9aa3b3'), 'empty naming falls back too')
  const hostile = ModelLogo({ model: 'deepseek-chat', provider: 'evil"><script>alert(1)</script>' })
  assert.ok(!hostile.props.dangerouslySetInnerHTML.__html.includes('script'), 'request strings only steer matching, never enter markup')
  // The by-model row's opaque-id shape resolves through the display name.
  const viaName = ModelLogo({ model: 'model-with-a-long-name', name: 'GPT 6.1 sol', providers: ['GitHub Models', 'Azure'] })
  assert.ok(viaName.props.dangerouslySetInnerHTML.__html.includes('0F0F0F'), 'a brandful display name brands an opaque route id')
})

test('second-wave vendors resolve, xiaomi mimo included', () => {
  assert.equal(resolveModelLogo('xiaomi', 'mimo-7b-rl'), 'xiaomi')
  assert.equal(resolveModelLogo(null, 'MiMo-VL-7B'), 'xiaomi')
  assert.equal(resolveModelLogo(null, 'baichuan2-13b'), 'baichuan')
  assert.equal(resolveModelLogo('百川', 'mystery-9'), 'baichuan')
  assert.equal(resolveModelLogo(null, 'yi-lightning'), 'yi')
  assert.equal(resolveModelLogo('01-ai', 'mystery-9'), 'yi')
  assert.equal(resolveModelLogo(null, 'yi-1.5-9b'), 'yi')
  assert.equal(resolveModelLogo(null, 'spark-max'), 'spark')
  assert.equal(resolveModelLogo('讯飞星火', 'mystery-9'), 'spark')
  assert.equal(resolveModelLogo('sensenova', 'mystery-9'), 'sensenova')
  assert.equal(resolveModelLogo(null, 'internlm2.5'), 'internlm')
  assert.equal(resolveModelLogo(null, 'phi-4'), 'microsoft')
  assert.equal(resolveModelLogo('azure', 'mystery-9'), 'microsoft')
  assert.equal(resolveModelLogo(null, 'nemotron-4'), 'nvidia')
  assert.equal(resolveModelLogo(null, 'nova-lite'), 'amazon')
  assert.equal(resolveModelLogo('bedrock', 'mystery-9'), 'amazon')
  assert.equal(resolveModelLogo(null, 'amazon.titan-text-express'), 'amazon')
  assert.equal(resolveModelLogo(null, 'granite-3.3'), 'ibm')
  assert.equal(resolveModelLogo(null, 'dbrx-instruct'), 'databricks')
  assert.equal(resolveModelLogo(null, 'sonar-pro'), 'perplexity')
  assert.equal(resolveModelLogo(null, 'jamba-1.5-mini'), 'ai21')
  assert.equal(resolveModelLogo(null, 'solar-pro'), 'upstage')
  assert.equal(resolveModelLogo(null, 'jina-embeddings-v3'), 'jina')
  assert.equal(resolveModelLogo(null, 'reka-core'), 'reka')
  assert.equal(resolveModelLogo(null, 'snowflake-arctic-embed'), 'snowflake')
  assert.equal(resolveModelLogo('sambanova', 'mystery-9'), 'sambanova')
  assert.equal(resolveModelLogo(null, 'rwkv-7'), 'rwkv')
  assert.equal(resolveModelLogo(null, 'falcon-3-10b'), 'falcon')
  assert.equal(resolveModelLogo('qianfan', 'mystery-9'), 'ernie')
  assert.equal(resolveModelLogo('zai', 'mystery-9'), 'zhipu')
})

test('ai360 ids beat the plain gpt keyword by match order', () => {
  assert.equal(resolveModelLogo(null, '360gpt2-pro'), 'ai360')
  assert.equal(resolveModelLogo('ai360', 'mystery-9'), 'ai360')
  assert.equal(resolveModelLogo(null, 'gpt-4o'), 'openai')
})

test('serving platforms match, but only after the model brand', () => {
  assert.equal(resolveModelLogo('groq', 'mystery-9'), 'groq')
  assert.equal(resolveModelLogo('together', 'mystery-9'), 'together')
  assert.equal(resolveModelLogo('fireworks', 'mystery-9'), 'fireworks')
  assert.equal(resolveModelLogo('cerebras', 'mystery-9'), 'cerebras')
  assert.equal(resolveModelLogo('openrouter', 'mystery-9'), 'openrouter')
  assert.equal(resolveModelLogo('siliconflow', 'mystery-9'), 'siliconflow')
  assert.equal(resolveModelLogo('硅基流动', 'mystery-9'), 'siliconflow')
  assert.equal(resolveModelLogo('huggingface', 'mystery-9'), 'huggingface')
  assert.equal(resolveModelLogo('novita', 'mystery-9'), 'novita')
  assert.equal(resolveModelLogo('deepinfra', 'mystery-9'), 'deepinfra')
  assert.equal(resolveModelLogo('modelscope', 'mystery-9'), 'modelscope')
  assert.equal(resolveModelLogo('魔搭', 'mystery-9'), 'modelscope')
  // An identifiable model id always outranks the platform serving it.
  assert.equal(resolveModelLogo('openrouter', 'anthropic/claude-3.5-sonnet'), 'claude')
  assert.equal(resolveModelLogo('ollama', 'llama3'), 'llama')
  assert.equal(resolveModelLogo('siliconflow', 'qwen3-max'), 'qwen')
})

test('every brand with a matcher ships markup, and the markup is inlinable', () => {
  const brands = [...new Set(MODEL_LOGO_BRANDS)]
  assert.equal(brands.length, MODEL_LOGO_BRANDS.length, 'matcher brand ids are unique')
  for (const brand of brands) {
    const markup = modelLogoMarkup(brand)
    assert.ok(markup, `${brand} has markup`)
    assert.ok(markup.startsWith('<'), `${brand} markup starts with an element`)
    assert.ok(!/<(svg|title|script|image)/.test(markup), `${brand} markup hosts no root/title/scripts`)
    assert.ok(!/currentColor/.test(markup), `${brand} markup has no live currentColor`)
  }
  assert.equal(modelLogoMarkup(null), undefined)
  assert.equal(modelLogoMarkup('nonexistent'), undefined)
})

test('element and gradient ids stay globally unique across inline brands', () => {
  const ids = [...Object.values(MODEL_LOGOS).join(' ').matchAll(/ id="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [])
})
