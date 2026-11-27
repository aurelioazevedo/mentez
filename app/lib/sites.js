// Site da clínica (Marketing → Site): montado por seções prontas, com 6 layouts e 8 estilos.
// Endereço grátis: <nome>.bemestarmental.com.br (MENTEZ_SITES_DOMAIN); ou domínio próprio (tenant_domains, purpose = 'site').
// O rascunho fica em sites.draft e só vai ao ar ao publicar (sites.published). Imagens: WebP, recortes por proporção
// com ponto de foco, gerados no primeiro uso; nenhum dado escondido da foto (GPS, aparelho) é guardado.
import sharp from 'sharp';
import * as T from './tenancy.js';
import * as Brand from './brand.js';
import * as BK from './booking.js';
import { q, one } from './db.js';
import { proName } from './perm.js';

sharp.cache(false);
sharp.concurrency(1);

export const sitesDomain = () => String(process.env.MENTEZ_SITES_DOMAIN ?? 'bemestarmental.com.br').toLowerCase().trim();

// ---------- layouts e estilos ----------
export const LAYOUTS = {
  editorial: { name: 'Editorial', desc: 'Títulos grandes com serifa, seções numeradas e muito respiro. Elegante e autoral.', hero: 'split' },
  acolhedor: { name: 'Acolhedor', desc: 'Formas arredondadas, cores suaves e foto em destaque. Transmite calma e proximidade.', hero: 'round' },
  minimalista: { name: 'Minimalista', desc: 'Limpo e direto: poucas cores, foco no texto e na leitura.', hero: 'text' },
  classico: { name: 'Clássico', desc: 'Centralizado e tradicional, com foto de fundo na abertura.', hero: 'cover' },
  escuro: { name: 'Escuro elegante', desc: 'Fundo escuro com destaques luminosos. Sofisticado e moderno.', hero: 'split', dark: true },
  clinica: { name: 'Clínica e equipe', desc: 'Para clínicas com vários profissionais: equipe e serviços em destaque, contatos no topo.', hero: 'cover' },
};
const F = (a, b) => ({ serif: a, sans: b });
export const STYLES = {
  marca: { name: 'Cores da marca', bg: '#F7F7F5', surface: '#FFFFFF', ink: '#1B1F24', muted: '#5C6470', accent: '', ...F('Newsreader', 'Manrope') },
  areia: { name: 'Areia', bg: '#F7F5F0', surface: '#FFFFFF', ink: '#171717', muted: '#66625C', accent: '#8A6E45', ...F('Newsreader', 'Manrope') },
  salvia: { name: 'Sálvia', bg: '#F3F5F0', surface: '#FFFFFF', ink: '#1F2A24', muted: '#56635A', accent: '#4F7458', ...F('Lora', 'Nunito Sans') },
  azul: { name: 'Azul sereno', bg: '#F4F7FB', surface: '#FFFFFF', ink: '#0F2A43', muted: '#4E6075', accent: '#2C6699', ...F('Source Serif 4', 'Source Sans 3') },
  terracota: { name: 'Terracota', bg: '#FBF6F1', surface: '#FFFFFF', ink: '#2B1D16', muted: '#6B5A50', accent: '#A9512F', ...F('Playfair Display', 'Mulish') },
  lavanda: { name: 'Lavanda', bg: '#F7F5FB', surface: '#FFFFFF', ink: '#251F35', muted: '#5E5872', accent: '#6E55AD', ...F('DM Serif Display', 'DM Sans') },
  grafite: { name: 'Grafite', bg: '#F4F4F2', surface: '#FFFFFF', ink: '#121212', muted: '#5E5E5E', accent: '#121212', ...F('Inter', 'Inter') },
  oceano: { name: 'Oceano', bg: '#F1F7F7', surface: '#FFFFFF', ink: '#0C2F33', muted: '#4B6668', accent: '#0F7A7A', ...F('Cormorant Garamond', 'Karla') },
};
const FONT_Q = {
  Newsreader: 'Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400', Manrope: 'Manrope:wght@400;500;600;700',
  Lora: 'Lora:ital,wght@0,400;0,500;1,400', 'Nunito Sans': 'Nunito+Sans:wght@400;600;700',
  'Source Serif 4': 'Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400', 'Source Sans 3': 'Source+Sans+3:wght@400;600;700',
  'Playfair Display': 'Playfair+Display:ital,wght@0,400;0,500;1,400', Mulish: 'Mulish:wght@400;600;700',
  'DM Serif Display': 'DM+Serif+Display:ital@0;1', 'DM Sans': 'DM+Sans:wght@400;500;700',
  Inter: 'Inter:wght@400;500;600;700', 'Cormorant Garamond': 'Cormorant+Garamond:ital,wght@0,500;0,600;1,500', Karla: 'Karla:wght@400;500;700',
};
export const fontsUrl = (st) => `https://fonts.googleapis.com/css2?${[...new Set([st.serif, st.sans])].map((f) => `family=${FONT_Q[f] || f.replace(/ /g, '+')}`).join('&')}&display=swap`;

// ---------- contraste (cores legíveis, inclusive com a cor da marca) ----------
const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? m[1] : null; };
const rgb = (c) => { const h = hex(c); return h ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : null; };
const lum = (c) => { const v = rgb(c); if (!v) return 0; const [r, g, b] = v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const mix = (c, to, t) => { const a = rgb(c); const b = rgb(to); if (!a || !b) return c; return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };
// escurece (ou clareia) a cor até ter contraste de leitura (4.5:1) com o fundo
export function readable(color, bg, min = 4.5) {
  if (!hex(color)) return color;
  const dark = lum(bg) > 0.4; let c = color;
  for (let i = 0; i < 20 && contrast(c, bg) < min; i++) c = mix(c, dark ? '#000000' : '#ffffff', 0.12);
  return c;
}
// Paleta final do site (estilo + layout escuro + cor da marca)
export function palette(site, b = Brand.get()) {
  const st = { ...(STYLES[site.style] || STYLES.areia) };
  if (site.style === 'marca') st.accent = hex(b.color) ? `#${hex(b.color)}` : '#2C6699';
  if (LAYOUTS[site.layout]?.dark) Object.assign(st, { bg: '#0F1216', surface: '#171B21', ink: '#ECEEF1', muted: '#A4ACB8' });
  st.accentText = readable(st.accent, st.bg);
  st.onAccent = contrast('#FFFFFF', st.accent) >= 3 ? '#FFFFFF' : '#111111';
  st.soft = mix(st.accent, st.bg, 0.88);
  st.line = LAYOUTS[site.layout]?.dark ? 'rgba(255,255,255,.12)' : 'rgba(20,20,20,.12)';
  return st;
}

// ---------- seções ----------
// Tipos de campo: text, area (parágrafos), lines (um item por linha), items (título + texto), people, image, check
export const SECTIONS = {
  inicio: { label: 'Abertura', nav: 'Início', fields: [['eyebrow', 'Linha acima do título', 'text'], ['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['cta', 'Texto do botão principal', 'text'], ['image', 'Foto', 'image']] },
  sobre: { label: 'Sobre', nav: 'Sobre', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['highlights', 'Destaques (um por linha: formação, especializações…)', 'lines'], ['image', 'Foto', 'image']] },
  ajuda: { label: 'Como posso ajudar', nav: 'Como ajudo', fields: [['title', 'Título', 'text'], ['text', 'Texto de abertura', 'area'], ['items', 'Temas atendidos', 'items']] },
  abordagem: { label: 'Abordagem', nav: 'Abordagem', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['image', 'Imagem (opcional)', 'image']] },
  processo: { label: 'Como funciona', nav: 'Como funciona', fields: [['title', 'Título', 'text'], ['items', 'Etapas', 'items']] },
  modalidades: { label: 'Atendimento (presencial e on-line)', nav: 'Atendimento', fields: [['title', 'Título', 'text'], ['online', 'Texto do atendimento on-line (vazio = não atende on-line)', 'area'], ['presencial', 'Texto do atendimento presencial (vazio = não atende presencial)', 'area']] },
  equipe: { label: 'Equipe', nav: 'Equipe', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['people', 'Profissionais', 'people']] },
  agendamento: { label: 'Agendamento on-line', nav: 'Agendar', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area']] },
  valores: { label: 'Valores e pagamento', nav: 'Valores', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area']] },
  duvidas: { label: 'Dúvidas frequentes', nav: 'Dúvidas', fields: [['title', 'Título', 'text'], ['items', 'Perguntas e respostas', 'items']] },
  contato: { label: 'Contato', nav: 'Contato', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['map', 'Mostrar o link “Ver no mapa”', 'check']] },
  final: { label: 'Chamada final', nav: '', fields: [['title', 'Título', 'text'], ['text', 'Texto', 'area'], ['cta', 'Texto do botão', 'text']] },
};
export const ORDER = ['inicio', 'sobre', 'ajuda', 'abordagem', 'processo', 'modalidades', 'equipe', 'agendamento', 'valores', 'duvidas', 'contato', 'final'];
const it = (t, d) => ({ t, d });

// Conteúdo inicial, já com os dados da clínica (nome, CRP, cidade, modalidades, profissionais)
export async function defaults() {
  const b = Brand.get();
  const pros = await q("SELECT id, name, title, crp, modalities, photo_v FROM users WHERE active = 1 AND demo = 0 AND attends = 1 AND role IN ('admin','psicologo') ORDER BY role = 'admin' DESC, id").catch(() => []);
  const bk = await BK.config().catch(() => ({ enabled: false, modalities: ['online', 'presencial'] }));
  const mods = new Set(bk.modalities || ['online', 'presencial']);
  const team = pros.length > 1;
  const who = b.who || b.name || 'Consultório';
  const city = b.city || '';
  const role = b.proRole || 'Psicologia';
  const where = [mods.has('presencial') && city ? `presencial em ${city}` : (mods.has('presencial') ? 'presencial' : ''), mods.has('online') ? 'on-line' : ''].filter(Boolean).join(' e ');
  const s = {
    inicio: { eyebrow: b.signLine || role, title: team ? 'Cuidado em saúde mental, com uma equipe que escuta você.' : 'Um espaço seguro para cuidar de você.', text: `Atendimento ${where || 'psicológico'}. Acolhimento, escuta e um processo construído no seu tempo, sem julgamentos.`, cta: 'Agendar consulta', image: null },
    sobre: { title: team ? `Sobre a ${b.name || who}` : `Sobre ${who}`, text: team ? 'Somos uma equipe de profissionais dedicados ao cuidado em saúde mental. Conte aqui a história da clínica, os valores que guiam o trabalho e o que torna o atendimento especial.' : `Sou ${who}${b.crp ? `, ${role.toLowerCase()} (CRP ${b.crp})` : ''}. Conte aqui sua formação, sua abordagem e o que guia o seu trabalho. Escreva como quem conversa com alguém que está procurando ajuda pela primeira vez.`, highlights: [b.crp ? `CRP ${b.crp}` : ''].filter(Boolean), image: null },
    ajuda: { title: 'Como posso ajudar', text: 'Alguns dos temas mais frequentes no consultório:', items: [it('Ansiedade', 'Preocupação constante, crises e sintomas no corpo. Entender os gatilhos e encontrar formas de lidar com eles.'), it('Depressão e desânimo', 'Falta de energia, tristeza persistente e perda de sentido. Um caminho para retomar o que importa.'), it('Relacionamentos', 'Conflitos, dependência emocional e dificuldade de se posicionar nas relações.'), it('Autoestima', 'Autocrítica intensa e insegurança. Construir uma relação mais gentil consigo.'), it('Luto e perdas', 'Espaço para atravessar a dor da perda no seu tempo.'), it('Estresse e esgotamento', 'Excesso de demandas, cansaço e dificuldade de desligar.')] },
    abordagem: { title: 'Abordagem', text: 'Explique aqui, com palavras simples, a abordagem que você usa e como ela ajuda na prática. Evite termos técnicos: quem lê quer saber como será o processo.', image: null },
    processo: { title: 'Como funciona', items: [it('Primeiro contato', 'Você agenda pelo site ou conversa pelo WhatsApp para tirar dúvidas e escolher o melhor horário.'), it('Primeiras sessões', 'Conversamos sobre sua história, o que te trouxe e o que você espera do processo.'), it('Acompanhamento', 'Sessões regulares, com um plano pensado para você e revisto ao longo do caminho.')] },
    modalidades: { title: 'Atendimento', online: mods.has('online') ? 'Por videochamada, de onde você estiver, com a mesma qualidade e sigilo do consultório.' : '', presencial: mods.has('presencial') ? `No consultório${city ? `, em ${city}` : ''}, em um ambiente reservado e acolhedor.${b.address ? ` ${b.address}.` : ''}` : '' },
    equipe: { title: 'Equipe', text: 'Profissionais que trabalham juntos pelo seu cuidado.', people: pros.map((u) => ({ name: proName(u), role: u.title === 'dra' ? 'Psicóloga' : u.title === 'dr' ? 'Psicólogo' : 'Psicologia', text: u.crp ? `CRP ${u.crp}` : '', image: null, uid: u.id })) },
    agendamento: { title: 'Agende sua consulta on-line', text: 'Escolha o dia e o horário que cabem na sua rotina. A confirmação chega no seu WhatsApp.' },
    valores: { title: 'Valores e formas de pagamento', text: 'Informe aqui como funcionam os valores, os pacotes, os convênios aceitos e as formas de pagamento (Pix, cartão).' },
    duvidas: { title: 'Dúvidas frequentes', items: [it('Como funciona a primeira sessão?', 'É um encontro para nos conhecermos: você conta o que te trouxe e tira suas dúvidas sobre o processo.'), it('O atendimento on-line funciona?', 'Sim. As sessões por videochamada têm a mesma qualidade e o mesmo sigilo das presenciais.'), it('Quanto tempo dura cada sessão?', 'Em geral, cerca de 50 minutos, com frequência combinada conforme a sua necessidade.'), it('O que eu falar fica em sigilo?', 'Sim. O sigilo é um dever ético do psicólogo e base de todo o trabalho.')] },
    contato: { title: 'Contato', text: 'Fale com a gente pelo WhatsApp ou agende direto pelo site.', map: true },
    final: { title: 'Dar o primeiro passo já é um cuidado.', text: 'Se algo aqui fez sentido para o momento que você vive, vamos conversar.', cta: 'Agendar consulta' },
  };
  const on = { inicio: 1, sobre: 1, ajuda: 1, abordagem: 0, processo: 1, modalidades: 1, equipe: team ? 1 : 0, agendamento: bk.enabled ? 1 : 0, valores: 0, duvidas: 1, contato: 1, final: 1 };
  return {
    layout: team ? 'clinica' : 'editorial', style: 'areia',
    sections: ORDER.map((type) => ({ type, on: !!on[type], ...s[type] })),
    seo: { title: `${who}${role ? ` | ${role}` : ''}${city ? ` em ${city}` : ''}`.slice(0, 70), description: `Atendimento ${where || 'psicológico'} com ${who}. Agende sua consulta on-line.`.slice(0, 160), image: null, google: '' },
    privacy: { extra: '' },
  };
}

// Primeira vez: cria o site e traz a foto do cartão digital e as fotos da equipe para a biblioteca de imagens
export async function ensure() {
  let row = await one("SELECT * FROM sites WHERE path = ''");
  if (row) return row;
  const d = await defaults();
  try {
    const ph = await Brand.logoFile('foto-original') || await Brand.logoFile('foto');
    if (ph?.buf) { const m = await upload(ph.buf, 'Foto do perfil'); const sec = d.sections.find((x) => x.type === 'inicio'); sec.image = m.id; d.sections.find((x) => x.type === 'sobre').image = m.id; }
  } catch (e) { console.error('site: foto do perfil', e.message); }
  for (const p of d.sections.find((x) => x.type === 'equipe').people) {
    try { const u = await one('SELECT photo FROM users WHERE id = ? AND photo IS NOT NULL', [p.uid]); if (u?.photo) p.image = (await upload(u.photo, p.name)).id; } catch { /* sem foto */ }
    delete p.uid;
  }
  await q("INSERT IGNORE INTO sites (path, kind, draft) VALUES ('', 'site', ?)", [JSON.stringify(d)]);
  return one("SELECT * FROM sites WHERE path = ''");
}
export const parse = (txt) => { try { return JSON.parse(txt || 'null'); } catch { return null; } };
export async function draft() { const r = await ensure(); return normalize(parse(r.draft) || await defaults()); }
export async function published() { const r = await one("SELECT published, published_at FROM sites WHERE path = ''"); const s = parse(r?.published); return s ? { ...normalize(s), at: r.published_at } : null; }
export async function saveDraft(site) { await ensure(); await q("UPDATE sites SET draft = ? WHERE path = ''", [JSON.stringify(normalize(site))]); }
export async function publish() { const r = await ensure(); await q("UPDATE sites SET published = draft, published_at = NOW() WHERE path = ''"); cache.clear(); return r; }
export async function unpublish() { await q("UPDATE sites SET published = NULL, published_at = NULL WHERE path = ''"); cache.clear(); }
export async function state() {
  const r = await one("SELECT draft, published, published_at, updated_at FROM sites WHERE path = ''");
  if (!r) return { exists: false };
  return { exists: true, published: !!r.published, at: r.published_at, pending: !!r.published && r.draft !== r.published, updated: r.updated_at };
}

// garante a forma do site (seções conhecidas, todas presentes, campos limitados)
const str = (v, n) => String(v ?? '').replace(/\r/g, '').slice(0, n);
export function normalize(s) {
  const out = { layout: LAYOUTS[s?.layout] ? s.layout : 'editorial', style: STYLES[s?.style] ? s.style : 'areia', sections: [], seo: {}, privacy: {} };
  const seen = new Set();
  for (const x of Array.isArray(s?.sections) ? s.sections : []) {
    if (!SECTIONS[x?.type] || seen.has(x.type)) continue; seen.add(x.type);
    const y = { type: x.type, on: !!x.on };
    for (const [k, , kind] of SECTIONS[x.type].fields) {
      if (kind === 'image') y[k] = Number(x[k]) > 0 ? Number(x[k]) : null;
      else if (kind === 'check') y[k] = !!x[k];
      else if (kind === 'lines') y[k] = (Array.isArray(x[k]) ? x[k] : []).map((v) => str(v, 160).trim()).filter(Boolean).slice(0, 12);
      else if (kind === 'items') y[k] = (Array.isArray(x[k]) ? x[k] : []).map((v) => ({ t: str(v?.t, 160).trim(), d: str(v?.d, 900).trim() })).filter((v) => v.t || v.d).slice(0, 16);
      else if (kind === 'people') y[k] = (Array.isArray(x[k]) ? x[k] : []).map((v) => ({ name: str(v?.name, 120).trim(), role: str(v?.role, 120).trim(), text: str(v?.text, 600).trim(), image: Number(v?.image) > 0 ? Number(v.image) : null })).filter((v) => v.name).slice(0, 30);
      else y[k] = str(x[k], kind === 'area' ? 3000 : 200);
    }
    out.sections.push(y);
  }
  for (const type of ORDER) if (!seen.has(type)) out.sections.push({ type, on: false });
  out.seo = { title: str(s?.seo?.title, 70), description: str(s?.seo?.description, 170), image: Number(s?.seo?.image) > 0 ? Number(s.seo.image) : null, google: str(s?.seo?.google, 100).replace(/[^A-Za-z0-9_-]/g, '') };
  out.privacy = { extra: str(s?.privacy?.extra, 4000) };
  return out;
}

// ---------- imagens ----------
export const ASPECTS = { '16x9': 16 / 9, '3x2': 3 / 2, '4x5': 4 / 5, '1x1': 1, o: 0 };
export const WIDTHS = [480, 768, 1080, 1600, 1920];
const MAX_UPLOAD = 15 * 1024 * 1024;
export const MAX_MEDIA = 60;

// SVG: só desenho (logos e ícones). Recusa scripts, eventos, conteúdo externo e entidades.
export function sanitizeSvg(txt) {
  let s = String(txt || '').replace(/^﻿/, '').trim();
  if (/<!ENTITY|<!DOCTYPE/i.test(s)) throw new Error('SVG com recursos não permitidos (DOCTYPE/ENTITY).');
  s = s.replace(/<\?xml[^>]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<svg[\s>]/i.test(s)) throw new Error('O arquivo não parece ser um SVG válido.');
  if (/<\s*(script|foreignObject|iframe|embed|object|audio|video|use\b[^>]*href\s*=\s*["']?(?!#))/i.test(s)) throw new Error('SVG com elementos não permitidos (scripts ou conteúdo externo).');
  if (/\son[a-z]+\s*=/i.test(s) || /javascript:/i.test(s)) throw new Error('SVG com código embutido não é permitido.');
  if (/(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);)/i.test(s)) throw new Error('SVG com links para arquivos externos não é permitido.');
  if (s.length > 400 * 1024) throw new Error('O SVG precisa ter até 400 KB.');
  return s;
}
function svgSize(s) {
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (vb) return [Math.round(+vb[1]), Math.round(+vb[2])];
  const w = /\swidth\s*=\s*["']?([\d.]+)/i.exec(s); const h = /\sheight\s*=\s*["']?([\d.]+)/i.exec(s);
  return [Math.round(+(w?.[1] || 0)), Math.round(+(h?.[1] || 0))];
}

export async function upload(buf, name = '') {
  if (!buf?.length) throw new Error('Arquivo vazio.');
  if (buf.length > MAX_UPLOAD) throw new Error('A imagem precisa ter até 15 MB.');
  const n = (await one('SELECT COUNT(*) n FROM site_media'))?.n || 0;
  if (n >= MAX_MEDIA) throw new Error(`A biblioteca tem o limite de ${MAX_MEDIA} imagens. Apague as que não usa para enviar outras.`);
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  const nm = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 160);
  if (/^(<\?xml|<svg|<!--)/i.test(head)) {
    const svg = sanitizeSvg(buf.toString('utf8'));
    const [w, h] = svgSize(svg);
    const r = await q("INSERT INTO site_media (kind, name, mime, w, h, bytes, orig_bytes, data) VALUES ('svg', ?, 'image/svg+xml', ?, ?, ?, ?, ?)", [nm, w, h, Buffer.byteLength(svg), buf.length, Buffer.from(svg)]);
    return { id: r.insertId, kind: 'svg', w, h, warn: '' };
  }
  let meta;
  try { meta = await sharp(buf, { limitInputPixels: 80e6 }).metadata(); } catch { throw new Error('Não foi possível ler a imagem. Envie em JPG, PNG, WebP, HEIC ou SVG.'); }
  if (!['jpeg', 'png', 'webp', 'heif', 'avif', 'gif', 'tiff'].includes(meta.format)) throw new Error('Formato não aceito. Envie em JPG, PNG, WebP, HEIC ou SVG.');
  // gira conforme a câmera, reduz a no máximo 2400 px e grava em WebP; o sharp descarta EXIF/GPS por padrão
  const { data, info } = await sharp(buf, { limitInputPixels: 80e6 }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
  // foto em pé (retrato): o rosto costuma ficar no terço de cima, então o foco inicial sobe
  const fy = info.height > info.width * 1.1 ? 0.3 : 0.5;
  const r = await q("INSERT INTO site_media (kind, name, mime, w, h, fy, bytes, orig_bytes, data) VALUES ('img', ?, 'image/webp', ?, ?, ?, ?, ?, ?)", [nm, info.width, info.height, fy, data.length, buf.length, data]);
  const short = Math.min(info.width, info.height);
  return { id: r.insertId, kind: 'img', w: info.width, h: info.height, warn: short < 700 ? 'A imagem é pequena e pode ficar desfocada em telas grandes. Se tiver, envie uma versão maior (de preferência com 1600 px ou mais).' : '' };
}
export const mediaList = () => q('SELECT id, kind, name, alt, w, h, fx, fy, v, bytes, orig_bytes, created_at FROM site_media ORDER BY id DESC');
export const mediaInfo = (id) => one('SELECT id, kind, name, alt, w, h, fx, fy, v, bytes FROM site_media WHERE id = ?', [id]);
export async function mediaUpdate(id, { alt, fx, fy }) {
  const cur = await mediaInfo(id); if (!cur) return;
  const nfx = Math.max(0, Math.min(1, Number(fx ?? cur.fx))); const nfy = Math.max(0, Math.min(1, Number(fy ?? cur.fy)));
  const moved = Math.abs(nfx - Number(cur.fx)) > 0.001 || Math.abs(nfy - Number(cur.fy)) > 0.001;
  await q('UPDATE site_media SET alt = ?, fx = ?, fy = ?, v = v + ? WHERE id = ?', [String(alt ?? cur.alt ?? '').slice(0, 300), nfx, nfy, moved ? 1 : 0, id]);
  if (moved) await q('DELETE FROM site_media_var WHERE media_id = ?', [id]);
  cache.clear();
}
export async function mediaDelete(id) { await q('DELETE FROM site_media_var WHERE media_id = ?', [id]); await q('DELETE FROM site_media WHERE id = ?', [id]); cache.clear(); }

// Recorte numa proporção, centrado no ponto de foco, na largura pedida (sem ampliar além do original)
export async function variant(id, aspect, width) {
  if (!(aspect in ASPECTS) || !WIDTHS.includes(width)) return null;
  const m = await one('SELECT kind, mime, w, h, fx, fy, data FROM site_media WHERE id = ?', [id]);
  if (!m) return null;
  if (m.kind === 'svg') return { mime: 'image/svg+xml', data: m.data };
  const hit = await one('SELECT data FROM site_media_var WHERE media_id = ? AND aspect = ? AND width = ?', [id, aspect, width]);
  if (hit) return { mime: 'image/webp', data: hit.data };
  const r = ASPECTS[aspect];
  let img = sharp(m.data);
  if (r) {
    let cw = m.w; let ch = Math.round(m.w / r);
    if (ch > m.h) { ch = m.h; cw = Math.round(m.h * r); }
    const left = Math.round(Math.max(0, Math.min(m.w - cw, Number(m.fx) * m.w - cw / 2)));
    const top = Math.round(Math.max(0, Math.min(m.h - ch, Number(m.fy) * m.h - ch / 2)));
    img = img.extract({ left, top, width: cw, height: ch });
  }
  const data = await img.resize({ width, withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toBuffer();
  await q('INSERT IGNORE INTO site_media_var (media_id, aspect, width, data) VALUES (?,?,?,?)', [id, aspect, width, data]);
  return { mime: 'image/webp', data };
}
// imagens usadas no site (para avisar antes de apagar)
export function usedMedia(site) {
  const ids = new Set();
  for (const s of site.sections) { if (s.image) ids.add(s.image); for (const p of s.people || []) if (p.image) ids.add(p.image); }
  if (site.seo?.image) ids.add(site.seo.image);
  return ids;
}

// ---------- endereço do site ----------
export async function migratePlatform() {
  if (!(await T.pone("SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'site_slug'"))) {
    await T.pq('ALTER TABLE tenants ADD COLUMN site_slug VARCHAR(40) NULL, ADD UNIQUE KEY site_slug (site_slug)');
  }
}
export function slugOfSiteHost(host) {
  const base = sitesDomain(); const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!base || !h.endsWith(`.${base}`)) return null;
  const s = h.slice(0, -(base.length + 1));
  return T.SLUG_RE.test(s) && !T.RESERVED.has(s) ? s : null;
}
const hostCache = new Map();
// undefined = não é endereço de site; null = endereço de site sem clínica; senão { t, redirect? }
export async function resolveHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const hit = hostCache.get(h);
  if (hit && Date.now() - hit.at < (hit.v ? 60e3 : 10e3)) return hit.v;
  let v;
  const base = sitesDomain();
  const s = slugOfSiteHost(h);
  if (s) {
    const row = await T.pone('SELECT slug FROM tenants WHERE site_slug = ?', [s]) || await T.pone("SELECT slug FROM tenants WHERE slug = ? AND (site_slug IS NULL OR site_slug = '')", [s]);
    v = row ? { t: await T.bySlug(row.slug) } : null;
  } else if (base && (h === base || h === `www.${base}`)) v = undefined;
  else {
    const row = await T.pone("SELECT t.slug FROM tenant_domains x JOIN tenants t ON t.id = x.tenant_id WHERE x.domain = ? AND x.purpose = 'site' AND x.verified_at IS NOT NULL", [h]).catch(() => null);
    if (row) v = { t: await T.bySlug(row.slug) };
    else if (h.startsWith('www.')) {
      const bare = await T.pone("SELECT t.slug FROM tenant_domains x JOIN tenants t ON t.id = x.tenant_id WHERE x.domain = ? AND x.purpose = 'site' AND x.verified_at IS NOT NULL", [h.slice(4)]).catch(() => null);
      v = bare ? { t: await T.bySlug(bare.slug), redirect: h.slice(4) } : undefined;
    } else v = undefined;
  }
  hostCache.set(h, { v, at: Date.now() });
  return v;
}
export const clearHostCache = () => hostCache.clear();
export async function allowCertificate(domain) {
  const v = await resolveHost(domain).catch(() => undefined);
  return !!(v && v.t && v.t.status !== 'cancelada');
}
// Endereço público do site da clínica atual (domínio próprio ativo, senão o grátis)
export async function siteUrl(t = T.current()) {
  if (!t) return '';
  const own = await T.pone("SELECT domain FROM tenant_domains WHERE tenant_id = ? AND purpose = 'site' AND verified_at IS NOT NULL AND https_at IS NOT NULL ORDER BY created_at LIMIT 1", [t.id]).catch(() => null);
  if (own) return `https://${own.domain}`;
  const row = await T.pone('SELECT site_slug FROM tenants WHERE id = ?', [t.id]).catch(() => null);
  return sitesDomain() ? `https://${row?.site_slug || t.slug}.${sitesDomain()}` : '';
}
// Todos os endereços do site (para liberar a agenda on-line dentro dele)
export async function siteOrigins(t = T.current()) {
  if (!t || !sitesDomain()) return [];
  const row = await T.pone('SELECT site_slug FROM tenants WHERE id = ?', [t.id]).catch(() => null);
  const out = [`https://${row?.site_slug || t.slug}.${sitesDomain()}`];
  for (const d of await T.pq("SELECT domain FROM tenant_domains WHERE tenant_id = ? AND purpose = 'site' AND verified_at IS NOT NULL", [t.id]).catch(() => [])) out.push(`https://${d.domain}`, `https://www.${d.domain}`);
  return out;
}
export async function siteSlugAvailable(slug, tenantId) {
  slug = String(slug || '').toLowerCase().trim();
  if (!T.SLUG_RE.test(slug) || T.RESERVED.has(slug)) return { ok: false, reason: 'Use de 3 a 40 letras minúsculas, números ou hífen (sem acentos e sem espaço).' };
  const a = await T.pone('SELECT id FROM tenants WHERE site_slug = ? AND id <> ?', [slug, tenantId]);
  const b = await T.pone("SELECT id FROM tenants WHERE slug = ? AND id <> ? AND (site_slug IS NULL OR site_slug = '')", [slug, tenantId]);
  return a || b ? { ok: false, reason: 'Este endereço já está em uso por outro site.' } : { ok: true };
}
export async function setSiteSlug(tenantId, slug) {
  const t = await T.pone('SELECT slug FROM tenants WHERE id = ?', [tenantId]);
  const v = String(slug || '').toLowerCase().trim();
  if (!v || v === t?.slug) { await T.pq('UPDATE tenants SET site_slug = NULL WHERE id = ?', [tenantId]); hostCache.clear(); return; }
  const ok = await siteSlugAvailable(v, tenantId);
  if (!ok.ok) throw new Error(ok.reason);
  await T.pq('UPDATE tenants SET site_slug = ? WHERE id = ?', [v, tenantId]);
  hostCache.clear();
}

// cache do HTML publicado (por clínica), limpo ao publicar ou mexer nas imagens
export const cache = new Map();
