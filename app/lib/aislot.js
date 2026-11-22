// Provedor de IA em “vagas” (principal e secundário), usado pelo atendente virtual e pela escrita com IA.
// Cada vaga escolhe livremente o provedor: Anthropic (Claude) ou qualquer um compatível com a API da OpenAI
// (Groq, OpenAI, Gemini, DeepSeek, OpenRouter, Mistral ou outro). O secundário entra quando o principal falha.
import { html, raw } from './html.js';
import * as AP from './aiproviders.js';
import { encrypt, decrypt } from './crypto.js';

export const PROVIDERS = { anthropic: { label: 'Anthropic (Claude)', keyHint: 'sk-ant-…', site: 'console.anthropic.com → API Keys' }, ...AP.PROVIDERS };
export const labelOf = (p) => PROVIDERS[p]?.label || p || '—';
// Modelos do Claude (preços e reservas ficam em lib/agent.js; aqui só os nomes, para não criar dependência circular)
export const CLAUDE_MODELS = { 'claude-haiku-5-5': 'Claude Haiku 5.5 — mais barato', 'claude-sonnet-5-5': 'Claude Sonnet 5.5 — intermediário', 'claude-opus-5-5': 'Claude Opus 5.5 — mais capaz' };

export function checkKey(provider, key) {
  const k = String(key || '').trim();
  if (provider === 'anthropic') return /^sk-ant-[\w-]{20,}$/.test(k) ? null : 'A chave da Anthropic começa com “sk-ant-”.';
  return AP.checkKey(provider, k);
}
// Vaga pronta para uso?
export const ready = (s) => !!(s && s.provider && s.key && s.model && (s.provider !== 'custom' || s.baseUrl));
export const describe = (s) => (s?.provider ? `${labelOf(s.provider)}${s.model ? ` · ${s.model}` : ''}` : '—');

// Leitura de uma vaga guardada ({ provider, model, baseUrl, key_enc, on })
export function read(o, def = {}) {
  if (!o) return null;
  let key = ''; try { key = o.key_enc ? decrypt(o.key_enc) : (o.key || ''); } catch { key = ''; }
  const provider = PROVIDERS[o.provider] ? o.provider : (def.provider || 'anthropic');
  return { provider, model: String(o.model || ''), baseUrl: provider === 'custom' ? String(o.baseUrl || '') : '', key, on: o.on !== false };
}
export const store = (s) => (s ? { provider: s.provider, model: s.model, baseUrl: s.baseUrl || '', key_enc: s.key ? encrypt(s.key) : null, on: s.on !== false } : null);

// Lê a vaga enviada pelo formulário (campos com prefixo, ex.: p1_provider, p1_model, p1_key, p1_base).
// Chave em branco: mantém a atual se o provedor não mudou (ou a de outra vaga do mesmo provedor).
export function fromBody(b, prefix, cur, others = []) {
  const provider = PROVIDERS[b[`${prefix}_provider`]] ? b[`${prefix}_provider`] : 'anthropic';
  const typed = String(b[`${prefix}_key`] || '').trim();
  // o endereço só vale para “Outro”; nos demais é descartado (evita guardar à vista algo colado no campo errado)
  const baseUrl = provider === 'custom' ? String(b[`${prefix}_base`] || '').trim().slice(0, 300) : '';
  let model = String(b[`${prefix}_model`] || '').trim().slice(0, 120);
  if (provider === 'anthropic' && !CLAUDE_MODELS[model]) model = 'claude-haiku-5-5';
  let key = typed;
  if (!key && cur?.provider === provider) key = cur.key;
  if (!key) key = others.find((o) => o?.provider === provider && o.key)?.key || '';
  if (b[`${prefix}_remove`]) key = '';
  const on = prefix.endsWith('2') ? !!b[`${prefix}_on`] : true;
  const s = { provider, model, baseUrl, key, on };
  let error = null;
  if (typed) error = checkKey(provider, typed);
  if (!error && on && provider === 'custom' && AP.checkUrl(baseUrl)) error = AP.checkUrl(baseUrl);
  return { slot: s, error, typed: !!typed };
}
// Modelos da conta no provedor (compatíveis com OpenAI) e a sugestão; Anthropic: a lista fixa do Claude.
export async function models(x) {
  if (!x?.provider) return { list: [], preferred: '' };
  if (x.provider === 'anthropic') return { list: Object.keys(CLAUDE_MODELS), preferred: 'claude-haiku-5-5' };
  if (!x.key || (x.provider === 'custom' && !x.baseUrl)) return { list: [], preferred: '' };
  const list = await AP.listModels(x.provider, x.key, x.baseUrl, false);
  return { list, preferred: AP.preferredModel(x.provider, list) };
}
// Completa o modelo que faltou (ou que não existe na conta) com o recomendado. Devolve um aviso se não deu para listar.
export async function fillModel(x) {
  if (!x?.key || x.provider === 'anthropic') return '';
  try {
    const m = await models(x);
    if (m.list.length && !m.list.includes(x.model)) x.model = m.preferred;
    return '';
  } catch (e) { return `não foi possível listar os modelos de ${labelOf(x.provider)} (${e.message})`; }
}
// Lista para a tela (sem quebrar a página se a chave falhar)
export async function modelsSafe(x) { try { return { ...(await models(x)), err: '' }; } catch (e) { return { list: [], preferred: '', err: e.message }; } }

// Campos do formulário de uma vaga. models: lista de modelos já conhecidos do provedor (para sugerir).
// scope: de onde vem a chave guardada quando a lista é pedida pela tela (agente, docs ou conta)
export function fields(prefix, s, { title, hint = '', toggle = false, models = [], error = '', scope = '' } = {}) {
  s = s || { provider: 'anthropic', model: '', baseUrl: '', key: '', on: false };
  const sel = (v) => (v ? raw('selected') : '');
  const list = s.provider === 'anthropic' ? Object.keys(CLAUDE_MODELS) : models;
  return html`<fieldset class="fld ai-slot" data-ai-slot="${prefix}" data-ai-scope="${scope}" data-provider="${s.provider}"><legend>${title}</legend>
    ${hint ? html`<p class="muted small">${hint}</p>` : ''}
    ${toggle ? html`<label class="fld check"><input type="checkbox" name="${prefix}_on" value="1" ${s.on && s.provider ? raw('checked') : ''}><span>Ativar o provedor secundário</span></label>` : ''}
    <div class="form-grid">
      <label class="fld"><span>Provedor</span><select name="${prefix}_provider" data-ai-provider>${Object.entries(PROVIDERS).map(([k, p]) => html`<option value="${k}" data-hint="${p.keyHint || ''}" data-site="${p.site || ''}" ${sel(s.provider === k)}>${p.label}</option>`)}</select></label>
      <label class="fld"><span>Chave da API <small class="muted" data-ai-keynote data-saved="${s.key ? `cadastrada · termina em ${s.key.slice(-4)} — preencha só para trocar` : ''}">(${s.key ? `cadastrada · termina em ${s.key.slice(-4)} — preencha só para trocar` : PROVIDERS[s.provider]?.site || ''})</small></span><input type="password" name="${prefix}_key" autocomplete="new-password" data-lpignore="true" data-1p-ignore maxlength="300" placeholder="${PROVIDERS[s.provider]?.keyHint || ''}" data-ai-key></label>
      <label class="fld ai-base"><span>Endereço da API <small class="muted">(do provedor “Outro”, ex.: https://meu-provedor.com/v1)</small></span><input name="${prefix}_base" value="${s.provider === 'custom' ? s.baseUrl || '' : ''}" maxlength="300" placeholder="https://…/v1" autocomplete="off" data-ai-base></label>
      <label class="fld"><span>Modelo <small class="muted" data-ai-models-msg>${list.length ? `(${list.length} disponíveis)` : ''}</small></span><input name="${prefix}_model" value="${s.model || ''}" maxlength="120" list="${prefix}-models" placeholder="${s.provider === 'anthropic' ? 'claude-haiku-5-5' : 'informe a chave para listar os modelos'}" autocomplete="off" data-ai-model>
        <datalist id="${prefix}-models">${list.map((m) => html`<option value="${m}">${CLAUDE_MODELS[m] || ''}</option>`)}</datalist></label>
      ${s.key ? html`<label class="fld check span2"><input type="checkbox" name="${prefix}_remove" value="1"><span>Remover a chave cadastrada</span></label>` : ''}
    </div>
    ${error ? html`<p class="flash err small">${error}</p>` : ''}
  </fieldset>`;
}
