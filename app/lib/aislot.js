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
  return { provider, model: String(o.model || ''), baseUrl: String(o.baseUrl || ''), key, on: o.on !== false };
}
export const store = (s) => (s ? { provider: s.provider, model: s.model, baseUrl: s.baseUrl || '', key_enc: s.key ? encrypt(s.key) : null, on: s.on !== false } : null);

// Lê a vaga enviada pelo formulário (campos com prefixo, ex.: p1_provider, p1_model, p1_key, p1_base).
// Chave em branco: mantém a atual se o provedor não mudou (ou a de outra vaga do mesmo provedor).
export function fromBody(b, prefix, cur, others = []) {
  const provider = PROVIDERS[b[`${prefix}_provider`]] ? b[`${prefix}_provider`] : 'anthropic';
  const typed = String(b[`${prefix}_key`] || '').trim();
  const baseUrl = String(b[`${prefix}_base`] || '').trim().slice(0, 300);
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
  if (!error && on && key && provider !== 'anthropic' && !model) error = `Informe o modelo de ${labelOf(provider)} (ex.: o nome que aparece no painel do provedor).`;
  return { slot: s, error, typed: !!typed };
}

// Campos do formulário de uma vaga. models: lista de modelos já conhecidos do provedor (para sugerir).
export function fields(prefix, s, { title, hint = '', toggle = false, models = [], error = '' } = {}) {
  s = s || { provider: 'anthropic', model: '', baseUrl: '', key: '', on: false };
  const sel = (v) => (v ? raw('selected') : '');
  const list = s.provider === 'anthropic' ? Object.keys(CLAUDE_MODELS) : models;
  return html`<fieldset class="fld ai-slot" data-ai-slot="${prefix}"><legend>${title}</legend>
    ${hint ? html`<p class="muted small">${hint}</p>` : ''}
    ${toggle ? html`<label class="fld check"><input type="checkbox" name="${prefix}_on" value="1" ${s.on && s.provider ? raw('checked') : ''}><span>Ativar o provedor secundário</span></label>` : ''}
    <div class="form-grid">
      <label class="fld"><span>Provedor</span><select name="${prefix}_provider" data-ai-provider>${Object.entries(PROVIDERS).map(([k, p]) => html`<option value="${k}" ${sel(s.provider === k)}>${p.label}</option>`)}</select></label>
      <label class="fld"><span>Modelo</span><input name="${prefix}_model" value="${s.model || ''}" maxlength="120" list="${prefix}-models" placeholder="${s.provider === 'anthropic' ? 'claude-haiku-5-5' : 'salve a chave para listar os modelos'}" autocomplete="off">
        <datalist id="${prefix}-models">${list.map((m) => html`<option value="${m}">${CLAUDE_MODELS[m] || ''}</option>`)}</datalist></label>
      <label class="fld"><span>Chave da API ${s.key ? html`<small class="muted">(cadastrada · termina em ${s.key.slice(-4)} — preencha só para trocar)</small>` : html`<small class="muted">(${PROVIDERS[s.provider]?.site || ''})</small>`}</span><input type="password" name="${prefix}_key" autocomplete="off" maxlength="300" placeholder="${PROVIDERS[s.provider]?.keyHint || ''}"></label>
      <label class="fld"><span>Endereço da API <small class="muted">(só para “Outro”)</small></span><input name="${prefix}_base" value="${s.baseUrl || ''}" maxlength="300" placeholder="https://…/v1"></label>
      ${s.key ? html`<label class="fld check span2"><input type="checkbox" name="${prefix}_remove" value="1"><span>Remover a chave cadastrada</span></label>` : ''}
    </div>
    ${error ? html`<p class="flash err small">${error}</p>` : ''}
  </fieldset>`;
}
