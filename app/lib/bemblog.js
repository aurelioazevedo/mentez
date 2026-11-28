// Bem-Estar Mental · blog do portal (bemestarmental.com.br/blog).
// Pauta e artigos escritos com IA (chave da plataforma, guardada cifrada), revisão no Painel e publicação
// automática em horários fixos (ex.: 10 por semana = seg. a sex., 9h e 15h). Custo e tokens registrados por chamada,
// com limite de gasto por mês.
import * as T from './tenancy.js';
import * as D from './psydocs.js';
import * as Agent from './agent.js';
import { slugify, TEMAS as DIR_TEMAS } from './directory.js';
import { risks } from './mktai.js';

export const TEMAS = { geral: 'Saúde mental', terapia: 'Terapia e psicologia', ...DIR_TEMAS };
export const ST = { pauta: 'Na pauta', gerando: 'Escrevendo…', revisao: 'Para revisar', fila: 'Agendado', publicado: 'Publicado', erro: 'Erro' };
const DEFAULTS = { model: 'claude-sonnet-5-5', perWeek: 10, review: true, auto: true, ahead: 20, budget: 20 };
const TZ = 3 * 3600e3; // Brasília (UTC-3)

export async function migrate() {
  await T.pq('CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  await T.pq(`CREATE TABLE IF NOT EXISTS bem_posts (
    id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(110) NOT NULL, title VARCHAR(160) NOT NULL, tema VARCHAR(20) NOT NULL DEFAULT 'geral',
    keyword VARCHAR(120) NULL, angle VARCHAR(400) NULL, excerpt VARCHAR(320) NULL, seo VARCHAR(180) NULL, body MEDIUMTEXT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pauta', publish_at DATETIME NULL, published_at DATETIME NULL,
    model VARCHAR(60) NULL, in_tok INT NOT NULL DEFAULT 0, out_tok INT NOT NULL DEFAULT 0, cost DECIMAL(10,5) NOT NULL DEFAULT 0, error VARCHAR(300) NULL, risks VARCHAR(600) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (slug), INDEX (status, publish_at), INDEX (tema)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await T.pq(`CREATE TABLE IF NOT EXISTS bem_ai_log (id INT AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(12) NOT NULL, post_id INT NULL, model VARCHAR(60) NULL,
    in_tok INT NOT NULL DEFAULT 0, out_tok INT NOT NULL DEFAULT 0, cost DECIMAL(10,5) NOT NULL DEFAULT 0, ok TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (created_at)) ENGINE=InnoDB`);
  await T.pq("UPDATE bem_posts SET status = 'pauta' WHERE status = 'gerando'"); // escrita interrompida (nova versão subindo)
}

// ---------- configuração ----------
export async function config() {
  const r = await T.pone("SELECT v FROM platform_settings WHERE k = 'bem_blog'");
  let c = {}; try { c = JSON.parse(r?.v || '{}'); } catch { /* vazio */ }
  const out = { ...DEFAULTS, ...c };
  if (!Agent.MODELS[out.model]) out.model = DEFAULTS.model;
  let key = ''; try { key = out.keySealed ? T.unseal(out.keySealed).k || '' : ''; } catch { /* chave antiga */ }
  return { ...out, key, keyHint: key ? `…${key.slice(-4)}` : '' };
}
export async function saveConfig(b) {
  const c = await config();
  const num = (v, min, max, d) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const next = {
    model: Agent.MODELS[b.model] ? b.model : c.model, perWeek: Math.round(num(b.perWeek, 1, 35, c.perWeek)), ahead: Math.round(num(b.ahead, 0, 200, c.ahead)),
    budget: num(b.budget, 0, 1000, c.budget), review: !!b.review, auto: !!b.auto, keySealed: c.keySealed || null,
  };
  const key = String(b.key || '').trim();
  if (b.clearKey) next.keySealed = null;
  else if (key) { if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw new Error('A chave da Anthropic começa com sk-ant-. Confira e cole de novo.'); next.keySealed = T.seal({ k: key }); }
  await T.pq("INSERT INTO platform_settings (k, v) VALUES ('bem_blog', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(next)]);
}

// ---------- uso e custo ----------
async function logAi(kind, postId, r) {
  await T.pq('INSERT INTO bem_ai_log (kind, post_id, model, in_tok, out_tok, cost, ok) VALUES (?,?,?,?,?,?,?)', [kind, postId || null, r.model || null, r.inTok || 0, r.outTok || 0, r.cost || 0, r.ok ? 1 : 0]);
}
const monthStart = () => { const d = new Date(Date.now() - TZ); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + TZ); };
export async function usage() {
  const m = await T.pone('SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o, COALESCE(SUM(cost),0) c FROM bem_ai_log WHERE created_at >= ?', [monthStart()]);
  const all = await T.pone('SELECT COUNT(*) n, COALESCE(SUM(in_tok),0) i, COALESCE(SUM(out_tok),0) o, COALESCE(SUM(cost),0) c FROM bem_ai_log');
  const per = await T.pone("SELECT COUNT(*) n, COALESCE(AVG(in_tok),0) i, COALESCE(AVG(out_tok),0) o, COALESCE(AVG(cost),0) c FROM bem_ai_log WHERE kind = 'artigo' AND ok = 1");
  const fix = (x) => ({ n: Number(x?.n || 0), inTok: Number(x?.i || 0), outTok: Number(x?.o || 0), cost: Number(x?.c || 0) });
  return { month: fix(m), all: fix(all), perPost: fix(per) };
}

// ---------- agenda de publicação ----------
// N por semana: seg. a sex.; primeiro 9h em todos os dias, depois 15h, 12h, 18h… (horário de Brasília)
const HOURS = [9, 15, 12, 18, 7, 21, 10, 16];
function weekSlots(n) {
  const out = [];
  for (const h of HOURS) for (let d = 0; d < 5 && out.length < n; d++) out.push([d, h]);
  return out.slice(0, n);
}
export function nextSlot(after, perWeek) {
  const slots = weekSlots(perWeek);
  const local = new Date(after.getTime() - TZ); // relógio de Brasília em campos UTC
  const dow = (local.getUTCDay() + 6) % 7; // 0 = segunda
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
  for (let w = 0; w < 120; w++) {
    const c = slots.map(([d, h]) => monday + (w * 7 + d) * 86400e3 + h * 3600e3 + TZ).sort((a, b) => a - b);
    const hit = c.find((t) => t > after.getTime());
    if (hit) return new Date(hit);
  }
  return new Date(after.getTime() + 86400e3);
}
async function schedule(id) {
  const c = await config();
  const last = await T.pone("SELECT MAX(publish_at) t FROM bem_posts WHERE status = 'fila'");
  const after = new Date(Math.max(Date.now(), last?.t ? new Date(last.t).getTime() : 0));
  const when = nextSlot(after, c.perWeek);
  await T.pq("UPDATE bem_posts SET status = 'fila', publish_at = ? WHERE id = ?", [when, id]);
  return when;
}
export const approve = (id) => schedule(id);
// refaz a agenda de todos os agendados, na mesma ordem (ao mudar o número por semana)
export async function reschedule() {
  const rows = await T.pq("SELECT id FROM bem_posts WHERE status = 'fila' ORDER BY publish_at, id");
  await T.pq("UPDATE bem_posts SET publish_at = NULL WHERE status = 'fila'");
  for (const r of rows) await schedule(r.id);
}
// publicar fora da agenda ou tirar da agenda: os agendados seguintes andam para não deixar buraco
export async function publishNow(id) { await T.pq("UPDATE bem_posts SET status = 'publicado', publish_at = NOW(), published_at = NOW() WHERE id = ?", [id]); await reschedule(); }
export async function unpublish(id) { await T.pq("UPDATE bem_posts SET status = 'revisao', publish_at = NULL, published_at = NULL WHERE id = ?", [id]); await reschedule(); }

// ---------- posts ----------
export const byId = (id) => T.pone('SELECT * FROM bem_posts WHERE id = ?', [id]);
export const counts = async () => Object.fromEntries((await T.pq('SELECT status, COUNT(*) n FROM bem_posts GROUP BY status')).map((r) => [r.status, Number(r.n)]));
export const listAdmin = (status) => T.pq(`SELECT id, slug, title, tema, status, publish_at, published_at, cost, out_tok, error, risks, updated_at FROM bem_posts ${status ? 'WHERE status = ?' : ''}
  ORDER BY FIELD(status,'gerando','revisao','erro','fila','pauta','publicado'), COALESCE(publish_at, '2999-01-01'), id LIMIT 500`, status ? [status] : []);
const LIVE = "status = 'publicado' OR (status = 'fila' AND publish_at <= NOW())";
export const published = ({ tema = null, limit = 12, offset = 0 } = {}) => T.pq(`SELECT id, slug, title, tema, excerpt, COALESCE(published_at, publish_at) published_at, CHAR_LENGTH(body) len FROM bem_posts
  WHERE (${LIVE}) ${tema ? 'AND tema = ?' : ''} ORDER BY COALESCE(published_at, publish_at) DESC, id DESC LIMIT ? OFFSET ?`, tema ? [tema, limit, offset] : [limit, offset]);
export const countPublished = async (tema = null) => Number((await T.pone(`SELECT COUNT(*) n FROM bem_posts WHERE (${LIVE}) ${tema ? 'AND tema = ?' : ''}`, tema ? [tema] : []))?.n || 0);
export const bySlug = (slug) => T.pone(`SELECT *, COALESCE(published_at, publish_at) pub FROM bem_posts WHERE slug = ? AND (${LIVE})`, [slug]);
export const related = (p, n = 3) => T.pq(`SELECT slug, title, tema, excerpt FROM bem_posts WHERE (${LIVE}) AND id <> ? ORDER BY tema = ? DESC, COALESCE(published_at, publish_at) DESC LIMIT ?`, [p.id, p.tema, n]);
export const temasLive = async () => (await T.pq(`SELECT tema, COUNT(*) n FROM bem_posts WHERE (${LIVE}) GROUP BY tema ORDER BY n DESC`)).filter((r) => TEMAS[r.tema]);

async function freeSlug(title, id = 0) {
  const base = slugify(title).slice(0, 100) || 'artigo';
  let s = base;
  for (let i = 2; await T.pone('SELECT id FROM bem_posts WHERE slug = ? AND id <> ?', [s, id]); i++) s = `${base.slice(0, 95)}-${i}`;
  return s;
}
const str = (v, n) => String(v ?? '').trim().slice(0, n);
export async function addIdea({ title, tema, keyword, angle }) {
  const t = str(title, 160); if (!t) throw new Error('Informe o título.');
  await T.pq('INSERT INTO bem_posts (slug, title, tema, keyword, angle) VALUES (?,?,?,?,?)', [await freeSlug(t), t, TEMAS[tema] ? tema : 'geral', str(keyword, 120) || null, str(angle, 400) || null]);
}
export async function save(id, b) {
  const t = str(b.title, 160); if (!t) throw new Error('Informe o título.');
  await T.pq('UPDATE bem_posts SET title = ?, slug = ?, tema = ?, keyword = ?, angle = ?, excerpt = ?, seo = ?, body = ? WHERE id = ?',
    [t, await freeSlug(str(b.slug, 110) || t, id), TEMAS[b.tema] ? b.tema : 'geral', str(b.keyword, 120) || null, str(b.angle, 400) || null, str(b.excerpt, 320) || null, str(b.seo, 180) || null, String(b.body || '').replace(/\r/g, '').slice(0, 60000) || null, id]);
}
export async function remove(id) { const p = await byId(id); await T.pq('DELETE FROM bem_posts WHERE id = ?', [id]); if (p?.status === 'fila') await reschedule(); }

// ---------- IA ----------
const keyOf = (c) => ({ key: c.key, provider: 'anthropic', model: c.model, owner: 'plataforma' });
const json = (t, open, close) => JSON.parse(t.slice(t.indexOf(open), t.lastIndexOf(close) + 1));
let busy = null; // uma escrita de cada vez (evita gasto em dobro)
export const state = { busy: false, note: '', pauta: false };

async function canSpend(c) {
  if (!c.key) return 'Cole a chave da Anthropic na configuração do blog.';
  if (c.budget > 0 && (await usage()).month.cost >= c.budget) return `Limite de gasto do mês atingido (US$ ${c.budget}). Aumente o limite para continuar.`;
  return '';
}

const ARTICLE = `Você escreve artigos para o Bem-Estar Mental (bemestarmental.com.br), portal brasileiro que ajuda pessoas a entender saúde mental e a encontrar psicólogas e psicólogos com CRP conferido.
Leitor: pessoa leiga que chegou pelo Google procurando entender algo que sente ou que alguém próximo sente.

Regras obrigatórias:
- Informação correta, alinhada ao consenso científico atual (DSM-5-TR, CID-11, OMS, Ministério da Saúde, Conselho Federal de Psicologia). Não invente estatísticas, estudos, citações, autores, leis ou links. Só cite um número se for um dado amplamente conhecido e diga a fonte de forma genérica (ex.: "segundo a OMS"); na dúvida, não cite número.
- Não faça diagnóstico, não indique remédios nem doses, não prometa cura nem resultado. Deixe claro que só um profissional avalia cada caso.
- Psicólogos não prescrevem medicação: quando o tema envolver remédios, fale em avaliação médica ou psiquiátrica.
- Linguagem acolhedora, clara e não estigmatizante ("pessoa com depressão", nunca rótulos como "o depressivo"); sem sensacionalismo, sem culpa, sem clichês de autoajuda; frases curtas; português do Brasil; sem emojis.
- Temas de suicídio, autolesão ou crise: siga as recomendações de comunicação responsável (nunca descreva métodos) e oriente o CVV (188, 24 horas, gratuito) e o SAMU (192).
- Não cite nomes de profissionais, clínicas, marcas ou produtos.
- Estrutura: introdução que acolhe e responde a dúvida principal já nos 2 primeiros parágrafos; 4 a 6 subtítulos com ## escritos como as pessoas buscam; listas com - quando ajudarem; uma seção "## Quando procurar um psicólogo"; no fim, "## Perguntas frequentes" com 3 perguntas em ### e respostas curtas.
- De 1.000 a 1.300 palavras. Markdown simples: ##, ###, listas com -, **negrito** com moderação. Sem título com # (o título vai à parte), sem links, sem imagens, sem tabelas.

Responda só com um JSON válido, sem nada antes ou depois:
{"titulo": "até 70 caracteres, com a palavra-chave", "resumo": "1 a 2 frases, até 220 caracteres", "descricao_google": "até 155 caracteres", "texto": "o artigo em Markdown"}`;

export async function generate(id) {
  const c = await config();
  const stop = await canSpend(c); if (stop) { state.note = stop; return { ok: false, error: stop }; }
  const p = await byId(id); if (!p) return { ok: false, error: 'Artigo não encontrado.' };
  await T.pq("UPDATE bem_posts SET status = 'gerando', error = NULL WHERE id = ?", [id]);
  const others = await T.pq("SELECT title FROM bem_posts WHERE tema = ? AND id <> ? AND status <> 'pauta' ORDER BY id DESC LIMIT 15", [p.tema, id]);
  const user = `Título sugerido: ${p.title}
Tema: ${TEMAS[p.tema] || p.tema}${p.keyword ? `\nPalavra-chave principal: ${p.keyword}` : ''}${p.angle ? `\nÂngulo do artigo: ${p.angle}` : ''}${others.length ? `\nOutros artigos do portal no mesmo tema (não repita o conteúdo deles): ${others.map((o) => o.title).join(' | ')}` : ''}`;
  let r;
  try { r = await D.aiWrite(keyOf(c), ARTICLE, user, { effort: 'medium' }); } catch (e) { r = { ok: false, error: e.message }; }
  await logAi('artigo', id, r).catch(() => {});
  let j = null;
  if (r.ok) { try { j = json(r.text, '{', '}'); } catch { /* fora do formato */ } }
  if (!r.ok || !j?.texto) {
    const err = String(r.error || 'A IA não devolveu o artigo no formato esperado.').slice(0, 300);
    await T.pq("UPDATE bem_posts SET status = 'erro', error = ?, in_tok = in_tok + ?, out_tok = out_tok + ?, cost = cost + ? WHERE id = ?", [err, r.inTok || 0, r.outTok || 0, r.cost || 0, id]);
    return { ok: false, error: err };
  }
  const title = str(j.titulo || p.title, 160);
  const rk = risks(`${title} ${j.texto}`).filter((x) => !/assunto de saúde/.test(x)).join(' · ').slice(0, 600) || null;
  await T.pq(`UPDATE bem_posts SET title = ?, slug = ?, excerpt = ?, seo = ?, body = ?, status = ?, error = NULL, risks = ?, model = ?,
    in_tok = in_tok + ?, out_tok = out_tok + ?, cost = cost + ? WHERE id = ?`,
  [title, await freeSlug(title, id), str(j.resumo, 320), str(j.descricao_google, 180), String(j.texto).slice(0, 60000), 'revisao', rk, r.model, r.inTok, r.outTok, r.cost, id]);
  if (!c.review) await schedule(id);
  return { ok: true };
}

// escreve vários, um de cada vez, em segundo plano
export function generateMany(ids) {
  if (busy) return false;
  busy = (async () => {
    state.busy = true; state.note = '';
    try {
      for (const id of ids) {
        const r = await generate(id);
        if (!r.ok && /chave|Limite|crédito|credit|autentica|inválid/i.test(r.error || '')) { state.note = r.error; break; }
      }
    } catch (e) { state.note = e.message; console.error('bem blog:', e.message); }
    finally { busy = null; state.busy = false; }
  })();
  return true;
}
export async function generateNext(n) {
  const ids = (await T.pq("SELECT id FROM bem_posts WHERE status IN ('pauta','erro') ORDER BY status = 'erro', id LIMIT ?", [Math.max(1, Math.min(200, n))])).map((r) => r.id);
  return ids.length ? generateMany(ids) : false;
}

const PAUTA = `Você é editor de conteúdo do Bem-Estar Mental (bemestarmental.com.br), portal brasileiro de saúde mental e diretório de psicólogos.
Monte a pauta de artigos para atrair, pelo Google, pessoas que procuram entender o que sentem e buscar ajuda psicológica.
Varie a intenção de busca: sintomas e sinais, diferenças entre condições, como ajudar alguém próximo, como funciona a terapia, abordagens (TCC, psicanálise, ACT…), terapia on-line, como escolher um psicólogo, situações do dia a dia (trabalho, relacionamentos, maternidade, luto…), crianças, adolescentes e idosos.
Títulos naturais, como as pessoas pesquisam, até 70 caracteres, sem sensacionalismo, sem promessas de cura e sem clickbait. Nada de remédios ou doses.
Responda só com um JSON válido: uma lista de objetos {"titulo": "...", "tema": "chave", "palavra_chave": "termo principal de busca", "angulo": "1 frase sobre o que o artigo responde"}.`;

export function generatePauta(n = 100) {
  if (state.pauta) return false;
  state.pauta = true; state.note = '';
  (async () => {
    try {
      const c = await config();
      let left = Math.max(1, Math.min(200, n));
      while (left > 0) {
        const stop = await canSpend(c); if (stop) { state.note = stop; break; }
        const k = Math.min(25, left);
        const have = (await T.pq('SELECT title FROM bem_posts ORDER BY id DESC LIMIT 400')).map((x) => x.title);
        const user = `Crie ${k} ideias de artigos novas.
Temas permitidos (use a chave): ${Object.entries(TEMAS).map(([key, l]) => `${key} = ${l}`).join('; ')}.
Distribua entre os temas, priorizando os mais buscados (ansiedade, depressão, relacionamentos, autoestima, estresse e burnout, terapia, TDAH, luto).
${have.length ? `Já existem estes títulos (não repita nem faça variações próximas): ${have.join(' | ').slice(0, 12000)}` : ''}`;
        let r;
        try { r = await D.aiWrite(keyOf(c), PAUTA, user, { effort: 'low' }); } catch (e) { r = { ok: false, error: e.message }; }
        await logAi('pauta', null, r).catch(() => {});
        if (!r.ok) { state.note = r.error; break; }
        let list = [];
        try { list = json(r.text, '[', ']'); } catch { state.note = 'A IA não devolveu a pauta no formato esperado. Tente de novo.'; break; }
        let added = 0;
        for (const x of list.slice(0, k)) {
          const t = str(x?.titulo, 160); if (!t || have.some((h) => slugify(h) === slugify(t))) continue;
          await addIdea({ title: t, tema: x.tema, keyword: x.palavra_chave, angle: x.angulo }); added++;
        }
        if (!added) break;
        left -= added;
      }
    } catch (e) { state.note = e.message; console.error('bem pauta:', e.message); }
    finally { state.pauta = false; }
  })();
  return true;
}

// a cada 10 minutos: publica o que chegou a hora e mantém artigos prontos à frente
export async function tick() {
  await T.pq("UPDATE bem_posts SET status = 'publicado', published_at = publish_at WHERE status = 'fila' AND publish_at <= NOW()");
  const c = await config();
  if (!c.auto || !c.key || busy || state.pauta) return;
  const n = await counts();
  const ready = (n.revisao || 0) + (n.fila || 0);
  if (ready < c.ahead && (n.pauta || 0) > 0) await generateNext(Math.min(5, c.ahead - ready));
}
