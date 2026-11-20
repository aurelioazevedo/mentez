// Provedores de IA além da Anthropic, todos pela API compatível com a da OpenAI (chat/completions):
// usados pelo atendente virtual (principal ou reserva) e pela escrita de documentos.
export const PROVIDERS = {
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…', site: 'console.groq.com → API Keys' },
  openai: { label: 'OpenAI (ChatGPT)', url: 'https://api.openai.com/v1', keyHint: 'sk-…', site: 'platform.openai.com → API keys' },
  gemini: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'AIza…', site: 'aistudio.google.com → Get API key' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', keyHint: 'sk-…', site: 'platform.deepseek.com → API keys' },
  openrouter: { label: 'OpenRouter (vários modelos)', url: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…', site: 'openrouter.ai → Keys' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1', keyHint: '…', site: 'console.mistral.ai → API Keys' },
  custom: { label: 'Outro (compatível com OpenAI)', url: '', keyHint: '…', site: 'painel do provedor' },
};
export const labelOf = (p) => PROVIDERS[p]?.label || p;
// Endereço da API (a Groq aceita GROQ_BASE_URL para testes; “outro” usa o endereço informado)
export function urlOf(provider, base = '') {
  if (provider === 'custom') return String(base || '').replace(/\/+$/, '');
  if (provider === 'groq' && process.env.GROQ_BASE_URL) return process.env.GROQ_BASE_URL.replace(/\/+$/, '');
  return (PROVIDERS[provider]?.url || '').replace(/\/+$/, '');
}
export function checkKey(provider, key) {
  const k = String(key || '').trim();
  if (!k) return 'Informe a chave.';
  if (provider === 'groq' && !/^gsk_[\w-]{20,}$/.test(k)) return 'A chave da Groq começa com “gsk_”.';
  if (provider === 'gemini' && !/^AIza[\w-]{20,}$/.test(k)) return 'A chave do Gemini começa com “AIza”.';
  if (/\s/.test(k) || k.length < 16) return 'Chave inválida.';
  return null;
}
export function checkUrl(url) {
  return /^https:\/\/[^\s]+$/i.test(String(url || '')) || /^http:\/\/localhost(:\d+)?\//i.test(String(url || '')) ? null : 'O endereço da API precisa começar com https://';
}

async function call(provider, key, base, path, body) {
  const url = urlOf(provider, base);
  if (!url) throw new Error('Endereço da API não informado.');
  const res = await fetch(`${url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (Array.isArray(data) ? data[0]?.error?.message : data?.error?.message) || data?.message || 'erro';
    const e = new Error(`${labelOf(provider)} ${res.status}: ${msg}`); e.status = res.status; e.provider = provider; throw e;
  }
  return data;
}
export const chat = (provider, key, base, body) => call(provider, key, base, '/chat/completions', body);

// Modelos de conversa disponíveis na conta (para escolher na configuração)
const cacheModels = new Map();
export async function listModels(provider, key, base = '', fresh = false) {
  const ck = `${provider}|${base}|${String(key).slice(-6)}`;
  const hit = cacheModels.get(ck);
  if (!fresh && hit && hit.at > Date.now() - 10 * 60e3) return hit.v;
  const data = await call(provider, key, base, '/models');
  const v = (data.data || data.models || []).filter((m) => m.active !== false)
    .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
    .filter((id) => id && !/whisper|tts|guard|playai|orpheus|distil|embed|moderation|dall-e|image|audio|transcri|realtime|search|vision-preview|aqa/i.test(id))
    .sort();
  cacheModels.set(ck, { at: Date.now(), v });
  return v;
}
// Sugestão quando o modelo escolhido não existe na conta
export function preferredModel(provider, list) {
  const prefs = { groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b'] }[provider] || [];
  return prefs.find((m) => list.includes(m)) || list.find((m) => /mini|flash|chat/i.test(m)) || list[0] || '';
}

// Transcrição de áudio (API /audio/transcriptions, padrão OpenAI) — usada pela IA na sessão.
export const STT = {
  groq: { label: 'Groq (Whisper)', models: ['whisper-large-v3-turbo', 'whisper-large-v3'], usdPerMin: { 'whisper-large-v3-turbo': 0.04 / 60, 'whisper-large-v3': 0.111 / 60 } },
  openai: { label: 'OpenAI', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], usdPerMin: { 'gpt-4o-mini-transcribe': 0.003, 'gpt-4o-transcribe': 0.006, 'whisper-1': 0.006 } },
  custom: { label: 'Outro (compatível com OpenAI)', models: [], usdPerMin: {} },
};
export async function transcribe(provider, key, base, { buf, mime, filename, model, prompt }) {
  const url = urlOf(provider, base);
  if (!url) throw new Error('Endereço da API de transcrição não informado.');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), filename || 'sessao.webm');
  fd.append('model', model);
  fd.append('language', 'pt');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  if (prompt) fd.append('prompt', prompt.slice(0, 600));
  const res = await fetch(`${url}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(15 * 60e3) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || 'erro';
    const e = new Error(`${STT[provider]?.label || labelOf(provider)} ${res.status}: ${msg}`); e.status = res.status; throw e;
  }
  return String(data.text || '').trim();
}
