// Biblioteca de exercícios das clínicas: modelos próprios (ex_models), criados do zero, copiados da biblioteca base
// da Mentez ou rascunhados pela IA. Todo modelo só pode ser enviado ao paciente depois que um profissional o revisa
// e aprova (reviewed = 1). Cada modelo vira formulário no celular do paciente e folha para imprimir com a marca da clínica.
// As chaves dos modelos são "m:<id>" e convivem com as dos cadernos (v1/…, v2/…, v3/…) na tabela assignments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one } from './db.js';
import * as Tenancy from './tenancy.js';
import { EXERCISES as CADERNOS, byKey as cadernoByKey, BOOKS } from './exercises.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE = path.join(DIR, '..', 'private');

// ---------- formato dos campos (o mesmo de lib/forms.js) ----------
export const FIELD_TYPES = {
  info: 'Texto de orientação', text: 'Resposta curta', textarea: 'Resposta longa', scale: 'Escala de 0 a 10', checks: 'Múltipla escolha', table: 'Tabela (linhas para preencher)',
};
const COL_TYPES = ['text', 'number', 'date'];
const s = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sl = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);

// Valida e normaliza uma lista de campos vinda do editor ou da IA. Gera nomes estáveis (f1, f2…; c1, c2… nas colunas).
export function cleanFields(list) {
  const out = [];
  for (const f of [].concat(list || []).slice(0, 30)) {
    if (!f || !FIELD_TYPES[f.type]) continue;
    const name = `f${out.length + 1}`;
    if (f.type === 'info') { const text = sl(f.text ?? f.label, 1200); if (text) out.push({ type: 'info', name, text }); continue; }
    const label = s(f.label, 200); if (!label) continue;
    if (f.type === 'text' || f.type === 'textarea') out.push({ type: f.type, name, label });
    else if (f.type === 'scale') out.push({ type: 'scale', name, label, left: s(f.left, 30) || '0', right: s(f.right, 30) || '10' });
    else if (f.type === 'checks') {
      const options = [...new Set([].concat(f.options || []).map((o) => s(o, 80)).filter(Boolean))].slice(0, 16);
      if (options.length >= 2) out.push({ type: 'checks', name, label, options });
    } else if (f.type === 'table') {
      const columns = [].concat(f.columns || []).map((c, i) => ({ name: `c${i + 1}`, label: s(typeof c === 'string' ? c : c?.label, 60), type: COL_TYPES.includes(c?.type) ? c.type : 'text' })).filter((c) => c.label).slice(0, 8)
        .map((c, i) => ({ ...c, name: `c${i + 1}` }));
      if (!columns.length) continue;
      const rows = Math.min(10, Math.max(1, Math.round(Number(f.rows) || 3)));
      const nums = columns.filter((c) => c.type === 'number').map((c) => c.name);
      const chart = f.chart && nums.length ? { x: columns[0].name, y: nums.slice(0, 3), title: s(f.chartTitle, 80) || label } : null;
      out.push({ type: 'table', name, label, columns, rows, chart });
    }
  }
  return out;
}

// ---------- biblioteca base da Mentez (técnicas clássicas, linguagem simples; revisar antes de usar) ----------
const t = (label) => ({ type: 'text', label });
const ta = (label) => ({ type: 'textarea', label });
const sc = (label, left = '0', right = '10') => ({ type: 'scale', label, left, right });
const ck = (label, options) => ({ type: 'checks', label, options });
const tb = (label, columns, rows = 3, chart = false) => ({ type: 'table', label, columns, rows, chart });
const n = (label) => ({ label, type: 'number' });
const d = (label) => ({ label, type: 'date' });
const info = (text) => ({ type: 'info', text });
const SAFETY = info('Se em algum momento você sentir que pode se machucar, ligue para o CVV 188 (24 horas, gratuito) ou SAMU 192, ou procure o pronto-socorro mais próximo.');

export const CATEGORIES = ['Pensamentos', 'Emoções', 'Comportamento', 'Ansiedade', 'Rotina e sono', 'Autoestima', 'Valores e metas', 'Crise e segurança', 'Outros'];

export const BASE = [
  { slug: 'registro-de-pensamentos', category: 'Pensamentos', title: 'Registro de pensamentos', summary: 'Situação, pensamento automático, emoção e uma resposta mais equilibrada.',
    intro: 'Quando perceber uma mudança no seu humor, pare e anote o que aconteceu. Não existe resposta certa: o objetivo é observar como pensamentos e emoções se ligam.',
    fields: [tb('Registros', [d('Data'), 'Situação', 'Pensamento automático', 'Emoção', n('Intensidade (0–10)'), 'Resposta alternativa', n('Intensidade depois (0–10)')], 3, true),
      ta('O que eu percebi preenchendo este registro?')] },
  { slug: 'diario-de-emocoes', category: 'Emoções', title: 'Diário de emoções', summary: 'Nomear a emoção do dia, onde ela aparece no corpo e o que ajudou.',
    intro: 'Uma vez por dia, escolha um momento marcante e descreva a emoção que apareceu.',
    fields: [tb('Meu diário', [d('Dia'), 'Emoção', n('Intensidade (0–10)'), 'Onde senti no corpo', 'O que estava acontecendo', 'O que me ajudou'], 7, true)] },
  { slug: 'agenda-de-atividades', category: 'Comportamento', title: 'Agenda de atividades prazerosas', summary: 'Planejar pequenas atividades e avaliar prazer e sensação de realização.',
    intro: 'Planeje uma atividade simples por dia. Depois de fazer, dê uma nota para o prazer (P) e para a sensação de realização (R), de 0 a 10. Comece pequeno.',
    fields: [tb('Minha semana', ['Dia', 'Atividade planejada', 'Fiz? (sim/não)', n('Prazer (0–10)'), n('Realização (0–10)')], 7, true),
      ta('Quais atividades fizeram mais diferença no meu humor?')] },
  { slug: 'respiracao-diafragmatica', category: 'Ansiedade', title: 'Treino de respiração', summary: 'Prática diária de respiração lenta com registro da tensão antes e depois.',
    intro: 'Sente-se confortável, uma mão no peito e outra na barriga. Inspire pelo nariz contando até 4, deixando a barriga subir; solte o ar devagar pela boca contando até 6. Repita por 3 a 5 minutos.',
    fields: [tb('Registro das práticas', [d('Data'), 'Horário', n('Tensão antes (0–10)'), n('Tensão depois (0–10)'), 'Observações'], 7, true)] },
  { slug: 'diario-do-sono', category: 'Rotina e sono', title: 'Diário do sono', summary: 'Horários de deitar e acordar, despertares e qualidade do sono.',
    intro: 'Preencha pela manhã, logo ao acordar, por uma ou duas semanas. Horários aproximados já ajudam.',
    fields: [tb('Minhas noites', [d('Noite de'), 'Deitei às', 'Dormi por volta de', 'Acordei às', n('Vezes que acordei'), n('Qualidade (0–10)')], 7, true),
      ck('O que fiz perto da hora de dormir nesta semana?', ['Usei celular na cama', 'Tomei café ou energético à tarde/noite', 'Fiz exercício à noite', 'Comi muito tarde', 'Tive uma rotina relaxante', 'Mantive horários regulares'])] },
  { slug: 'resolucao-de-problemas', category: 'Comportamento', title: 'Resolução de problemas', summary: 'Definir o problema, levantar opções, escolher e planejar o primeiro passo.',
    intro: 'Escolha um problema concreto e siga os passos abaixo, sem pressa.',
    fields: [ta('Qual é o problema? (descreva de forma específica)'), ta('Todas as soluções possíveis, sem julgar'),
      tb('Prós e contras das melhores opções', ['Opção', 'Prós', 'Contras'], 3), t('Opção escolhida'), ta('Primeiro passo, quando e como'), ta('Como foi? O que aprendi?')] },
  { slug: 'escada-de-exposicao', category: 'Ansiedade', title: 'Escada de exposição', summary: 'Situações temidas em ordem crescente, com a ansiedade esperada e a real.',
    intro: 'Liste situações que você evita, da mais fácil à mais difícil. Combine com seu profissional por onde começar e avance um degrau de cada vez.',
    fields: [t('Meu objetivo final'), tb('Degraus', ['Situação', n('Ansiedade esperada (0–10)'), d('Data em que pratiquei'), n('Ansiedade real (0–10)')], 8, true)] },
  { slug: 'carta-de-autocompaixao', category: 'Autoestima', title: 'Carta de autocompaixão', summary: 'Escrever para si mesmo como escreveria para alguém querido.',
    intro: 'Pense numa situação em que você tem se cobrado muito. Imagine como um amigo que gosta muito de você falaria sobre isso.',
    fields: [ta('A situação'), ta('O que eu costumo dizer a mim mesmo(a)'), ta('Minha carta, com o tom de um amigo gentil'), sc('Como me sinto depois de escrever?', 'pior', 'melhor')] },
  { slug: 'areas-da-vida-e-valores', category: 'Valores e metas', title: 'Áreas da vida e valores', summary: 'Importância de cada área e o quanto as ações de hoje estão de acordo com ela.',
    intro: 'Para cada área, dê uma nota para o quanto ela é importante para você e para o quanto você tem agido de acordo com ela.',
    fields: [tb('Minhas áreas', ['Área (família, trabalho, saúde, lazer…)', n('Importância (0–10)'), n('Como estou agindo hoje (0–10)'), 'Uma pequena ação possível'], 6, true),
      ta('O que percebo comparando as notas?')] },
  { slug: 'plano-de-enfrentamento-de-crise', category: 'Crise e segurança', title: 'Plano de enfrentamento de crise', summary: 'Sinais de alerta, estratégias, pessoas e serviços para os momentos difíceis.',
    intro: 'Preencha junto com seu profissional e deixe este plano num lugar fácil de achar.',
    fields: [SAFETY, ta('Sinais de que uma crise pode estar chegando'), ta('O que posso fazer sozinho(a) para me acalmar'), ta('Pessoas e lugares que me ajudam a me distrair'),
      tb('Pessoas para quem posso pedir ajuda', ['Nome', 'Telefone'], 3), ta('Como deixar o ambiente mais seguro'), t('Uma razão importante para seguir em frente')] },
  { slug: 'registro-de-gratidao', category: 'Emoções', title: 'Registro de gratidão', summary: 'Três coisas boas do dia e o papel que você teve nelas.',
    intro: 'No fim do dia, anote três coisas que foram boas, mesmo que pequenas.',
    fields: [tb('Coisas boas', [d('Dia'), 'O que aconteceu', 'Por que foi bom', 'Qual foi o meu papel'], 7)] },
].map((b) => ({ ...b, key: `base/${b.slug}`, fields: cleanFields(b.fields) }));
export const baseBySlug = (slug) => BASE.find((b) => b.slug === slug) || null;

// ---------- modelos da clínica ----------
let ready = false;
async function ensure() {
  if (ready) return;
  await q(`CREATE TABLE IF NOT EXISTS ex_models (
    id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(160) NOT NULL, category VARCHAR(40) NOT NULL DEFAULT 'Outros', summary VARCHAR(300) NULL,
    intro TEXT NULL, fields_json MEDIUMTEXT NOT NULL, source VARCHAR(10) NOT NULL DEFAULT 'proprio', base_slug VARCHAR(80) NULL,
    reviewed TINYINT(1) NOT NULL DEFAULT 0, reviewed_by INT NULL, reviewed_at DATETIME NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // cópia do formulário no momento do envio: editar o modelo depois não bagunça respostas já dadas
  const col = await one("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assignments' AND COLUMN_NAME = 'form_json'");
  if (!Number(col.n)) await q('ALTER TABLE assignments ADD COLUMN form_json MEDIUMTEXT NULL');
  ready = true;
}
// Formulário de um envio: a cópia gravada no envio ou, nos cadernos, o do catálogo
export function formOf(s, ex = byKey(s.exercise_key)) {
  if (s.form_json) { try { return JSON.parse(s.form_json); } catch { /* usa o atual */ } }
  return ex?.form || null;
}
const shape = (r) => {
  if (!r) return null;
  let fields = []; try { fields = JSON.parse(r.fields_json || '[]'); } catch { /* vazio */ }
  return { ...r, key: `m:${r.id}`, fields, form: fields.some((f) => f.type !== 'info') ? fields : null, bookTitle: r.category || 'Modelo da clínica', pdf: null, sheet: true, model: true };
};

// Cache por clínica para resolver as chaves "m:<id>" de forma síncrona (byKey) nas telas existentes
const CACHE = Tenancy.scoped({ at: 0, models: null, cadernos: null });
export async function warm(force = false) {
  if (!force && CACHE.models && Date.now() - CACHE.at < 30e3) return;
  await ensure();
  CACHE.models = new Map((await q('SELECT * FROM ex_models')).map((r) => [`m:${r.id}`, shape(r)]));
  CACHE.cadernos = fs.existsSync(path.join(Tenancy.filesDir(PRIVATE), BOOKS.v1.dir));
  CACHE.at = Date.now();
}
// Os cadernos (PDFs) só aparecem nas clínicas que têm os arquivos (hoje: Dra. Lorrainy e Dr. Aurélio)
export const hasCadernos = () => !!CACHE.cadernos;
export const cadernos = () => (hasCadernos() ? CADERNOS : []);

export function byKey(k) {
  k = String(k || '');
  if (k.startsWith('m:')) return CACHE.models?.get(k) || null;
  return cadernoByKey(k);
}
// Modelos aprovados e ativos: os que podem ser enviados
export const sendable = () => [...(CACHE.models?.values() || [])].filter((m) => m.active && m.reviewed).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));

export async function list() { await warm(true); return [...CACHE.models.values()].sort((a, b) => (b.active - a.active) || a.title.localeCompare(b.title, 'pt-BR')); }
export async function get(id) { await ensure(); return shape(await one('SELECT * FROM ex_models WHERE id = ?', [Number(id) || 0])); }

export function cleanModel(b) {
  return {
    title: s(b.title, 160), category: CATEGORIES.includes(b.category) ? b.category : 'Outros', summary: s(b.summary, 300) || null,
    intro: sl(b.intro, 3000) || null, fields: cleanFields(b.fields),
  };
}
export async function create(b, userId, { source = 'proprio', baseSlug = null } = {}) {
  await ensure();
  const m = cleanModel(b);
  if (!m.title) return { error: 'Dê um título ao exercício.' };
  if (!m.fields.length) return { error: 'O exercício precisa de pelo menos um campo.' };
  const r = await q('INSERT INTO ex_models (title, category, summary, intro, fields_json, source, base_slug, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [m.title, m.category, m.summary, m.intro, JSON.stringify(m.fields), source, baseSlug, userId || null]);
  await warm(true);
  return { id: r.insertId };
}
export async function copyBase(slug, userId) {
  const b = baseBySlug(slug); if (!b) return { error: 'Modelo não encontrado.' };
  return create(b, userId, { source: 'base', baseSlug: slug });
}
// Toda edição volta o modelo para “aguardando revisão”
export async function update(id, b) {
  await ensure();
  const m = cleanModel(b);
  if (!m.title) return { error: 'Dê um título ao exercício.' };
  if (!m.fields.length) return { error: 'O exercício precisa de pelo menos um campo.' };
  await q('UPDATE ex_models SET title = ?, category = ?, summary = ?, intro = ?, fields_json = ?, reviewed = 0, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?',
    [m.title, m.category, m.summary, m.intro, JSON.stringify(m.fields), id]);
  await warm(true);
  return { ok: true };
}
export async function approve(id, userId) { await ensure(); await q('UPDATE ex_models SET reviewed = 1, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?', [userId, id]); await warm(true); }
export async function setActive(id, on) { await ensure(); await q('UPDATE ex_models SET active = ? WHERE id = ?', [on ? 1 : 0, id]); await warm(true); }
export async function remove(id) {
  await ensure();
  const used = await one('SELECT COUNT(*) n FROM assignments WHERE exercise_key = ?', [`m:${id}`]);
  if (Number(used.n)) { await setActive(id, false); return { archived: true }; }
  await q('DELETE FROM ex_models WHERE id = ?', [id]); await warm(true);
  return { ok: true };
}

// ---------- rascunho pela IA ----------
const AI_SYSTEM = `Você ajuda psicólogos brasileiros a montar exercícios para os pacientes fazerem entre as sessões (tarefas de casa).
O exercício será revisado e aprovado pelo psicólogo antes de chegar ao paciente.
Regras:
- Português do Brasil, linguagem simples, acolhedora e direta, falando com o paciente ("você").
- Use técnicas reconhecidas e baseadas em evidências (por exemplo TCC, ACT, DBT, terapia focada na compaixão), sem prometer resultados.
- Não faça diagnóstico, não cite medicamentos e não peça dados de identificação.
- Se o tema envolver risco (suicídio, autolesão, violência), inclua um campo "info" com: CVV 188 (24 horas, gratuito), SAMU 192 ou o pronto-socorro mais próximo.
- Entre 3 e 8 campos. Tabelas com no máximo 7 colunas e 7 linhas.
Responda SOMENTE com um objeto JSON, sem comentários, neste formato:
{"title": "...", "category": "uma de: ${CATEGORIES.join(', ')}", "summary": "uma frase para o psicólogo", "intro": "orientação ao paciente, até 3 frases",
 "fields": [
  {"type":"info","text":"..."},
  {"type":"text","label":"..."},
  {"type":"textarea","label":"..."},
  {"type":"scale","label":"...","left":"rótulo do 0","right":"rótulo do 10"},
  {"type":"checks","label":"...","options":["...","..."]},
  {"type":"table","label":"...","rows":5,"columns":[{"label":"...","type":"text|number|date"}],"chart":true}
 ]}
Use "chart": true só em tabelas com colunas numéricas que faça sentido acompanhar num gráfico.`;

export async function draftWithAI({ theme, audience, approach, userId }) {
  const D = await import('./psydocs.js');
  const key = await D.aiKeyFor(await D.aiConfig(), userId);
  if (key.error) return { error: key.error };
  const user = `Monte um exercício sobre: ${s(theme, 600)}.${audience ? `\nPúblico: ${s(audience, 120)}.` : ''}${approach ? `\nAbordagem preferida: ${s(approach, 80)}.` : ''}`;
  const r = await D.aiWrite(key, AI_SYSTEM, user, { effort: 'low' });
  if (!r.ok) return { error: r.error };
  const m = String(r.text).match(/\{[\s\S]*\}/);
  let obj; try { obj = JSON.parse(m ? m[0] : r.text); } catch { return { error: 'A IA devolveu um formato inesperado. Tente de novo.' }; }
  const out = cleanModel(obj);
  if (!out.title || !out.fields.length) return { error: 'A IA não montou um exercício válido. Tente descrever o tema de outro jeito.' };
  return create(out, userId, { source: 'ia' });
}
