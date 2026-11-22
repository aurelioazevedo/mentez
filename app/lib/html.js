import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as Tenancy from './tenancy.js';
import * as Brand from './brand.js';
import * as Styles from './styles.js';
import { can, ROLES } from './perm.js';

// Templates HTML seguros: tudo é escapado, exceto valores marcados com raw().
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));

export function esc(v) {
  if (v instanceof Raw) return v.s;
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += esc(v) + strings[i + 1]; });
  return raw(out);
}

// Versão dos arquivos do navegador (app.js, app.css, tele.js…): calculada pelo conteúdo, para o navegador
// sempre buscar a versão nova depois de uma atualização (os arquivos ficam em cache por 7 dias).
export const VERSION = (() => {
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
    const h = crypto.createHash('sha1');
    for (const f of fs.readdirSync(dir).filter((x) => /\.(js|css)$/.test(x)).sort()) h.update(fs.readFileSync(path.join(dir, f)));
    return h.digest('hex').slice(0, 10);
  } catch { return String(Date.now()); }
})();
const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  pacientes: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.6c2.6.1 4.7 1.8 5.5 5.4"/>',
  exercicios: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4M8 12h8M8 16h6"/>',
  financeiro: '<rect x="2.5" y="6" width="19" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.6"/><path d="M6 9.5v.01M18 15.5v.01"/>',
  relatorios: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3" height="5" rx="1"/><rect x="12.5" y="8" width="3" height="9" rx="1"/><rect x="17.5" y="10.5" width="2.5" height="6.5" rx="1"/>',
  conta: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.2 4.2-6.5 8-6.5s7 2.3 8 6.5"/>',
  recepcao: '<path d="M3 20h18"/><path d="M5 20v-6a7 7 0 0 1 14 0v6"/><path d="M12 4v3"/><circle cx="12" cy="3" r="1"/>',
  escala: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8.5 14.5l7 4M15.5 14.5l-7 4"/>',
  marketing: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  crm: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="16" y="4" width="5" height="7" rx="1.5"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  lua: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  recolher: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M15 10l-2 2 2 2"/>',
  busca: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  locacao: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M2 21h20M16 9h4v12"/><circle cx="12.5" cy="12" r=".9"/>',
  termos: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  baixar: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  sino: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  sair: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  usuarios: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
};
export const icon = (n) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n] || ''}</svg>`);

// Módulos que podem ser ligados/desligados (o próprio módulo atualiza ao carregar a configuração)
// Módulos ligáveis do menu (um conjunto por clínica)
export const FEATURES = Tenancy.scoped({ locacao: false, exercicios: !Tenancy.multi() });
const NAV = [
  ['/', 'Início', 'home', ['agenda', 'cadastro']],
  ['/agenda', 'Agenda', 'agenda', ['agenda']],
  ['/recepcao', 'Recepção', 'recepcao', ['agenda']],
  ['/crm', 'CRM', 'crm', ['agenda']],
  ['/marketing', 'Marketing', 'marketing', ['agenda']],
  ['/pacientes', 'Pacientes', 'pacientes', ['cadastro']],
  ['/exercicios', 'Exercícios', 'exercicios', ['prontuario'], 'exercicios'],
  ['/financeiro', 'Financeiro', 'financeiro', ['financeiro', 'meufin']],
  ['/relatorios', 'Relatórios', 'relatorios', ['financeiro', 'meufin']],
  ['/locacao', 'Locação', 'locacao', ['agenda'], 'locacao'],
  ['/usuarios', 'Usuários', 'usuarios', ['usuarios']],
];

// Tema escolhido pela pessoa (cookie “tema”). Padrão: claro para todos.
// “escuro” → dark · “auto” → segue o aparelho · sem escolha (ou “claro”) → light.
export function themeOf(req) {
  const m = /(?:^|;\s*)tema=(claro|escuro|auto)(?:;|$)/.exec(req?.headers?.cookie || '');
  return m?.[1] === 'escuro' ? 'dark' : m?.[1] === 'auto' ? 'auto' : 'light';
}
// Menu lateral recolhido (cookie “menu=min”), para a página já abrir no estado escolhido.
export const sideMin = (req) => /(?:^|;\s*)menu=min(?:;|$)/.test(req?.headers?.cookie || '');
function head(title, theme = '', o = {}) {
  return html`<!doctype html>
<html lang="pt-BR"${theme ? raw(` data-theme="${theme}"`) : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">${process.env.MENTEZ_ENV === 'dev' ? raw('<style>body::after{content:"AMBIENTE DE TESTES · dados fictícios";position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:99999;background:#B4553C;color:#fff;font:700 12px/1 system-ui,sans-serif;letter-spacing:.06em;padding:7px 12px;border-radius:999px;pointer-events:none;opacity:.92}</style>') : ''}
<meta name="googlebot" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<meta name="theme-color" content="${Brand.get().colors?.[1] || Styles.swatch(Brand.get().style).dark || (Brand.get().legacy ? '#47291c' : '#071936')}">
<meta name="color-scheme" content="${theme === 'dark' ? 'dark' : theme === 'auto' ? 'light dark' : 'light'}">
<title>${title} · ${o.suffix || Brand.get().appName}</title>
<link rel="icon" href="${Brand.icon('favicon.png')}" type="image/png">
<link rel="manifest" href="${o.manifest || '/manifest.webmanifest'}">
<link rel="apple-touch-icon" href="${Brand.icon('apple-touch-icon.png')}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${o.appTitle || (Brand.get().legacy ? 'Consultório' : Brand.get().short)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${(Styles.STYLES[Brand.get().style] || Styles.STYLES[Brand.get().legacy ? 'classico' : 'mentez']).fonts}" rel="stylesheet">
<link rel="stylesheet" href="/static/app.css?v=${VERSION}">
${Brand.themeCss() ? raw(`<style>${Brand.themeCss()}</style>`) : ''}
</head>`;
}

// Logo da clínica (ou o nome, se ainda não houver logo). cls: classes da imagem; width opcional.
export function logoTag(cls = '', width = null, b = Brand.get()) {
  if (!b.logoUrl) return html`<span class="brand-word ${cls}">${b.short}</span>`;
  const w = width ? raw(` width="${width}"`) : '';
  return html`<img class="${cls} logo-light" src="${b.logoUrl}" alt="${b.short}"${w}><img class="${cls} logo-dark" src="${b.logoDarkUrl}" alt="${b.short}"${w}>`;
}
// Logo nas telas do sistema (login, primeiro acesso): a da clínica ou, sem logo enviada, a da Mentez
export function appLogo(cls = 'auth-logo', b = Brand.get()) {
  if (b.legacy) return logoTag(cls, null, b);
  return html`<img class="${cls} logo-light" src="${b.appLogoUrl}" alt="${b.short}"><img class="${cls} logo-dark" src="${b.appLogoDarkUrl}" alt="${b.short}">`;
}
function brandLink() {
  const b = Brand.get();
  if (b.legacy && !b.logo && !b.symbol) return raw('<a class="brand" href="/"><img class="logo-light brand-full" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes"><img class="logo-dark brand-full" src="/static/img/logo-creme.png" alt="Lorrainy Mendes"><img class="logo-light brand-mini" src="/static/img/simbolo-terracota.png" alt="Lorrainy Mendes"><img class="logo-dark brand-mini" src="/static/img/simbolo-creme.png" alt="Lorrainy Mendes"><span>Sistema do consultório</span></a>');
  const full = html`<img class="logo-light brand-full" src="${b.appLogoUrl}" alt="${b.short}"><img class="logo-dark brand-full" src="${b.appLogoDarkUrl}" alt="${b.short}">`;
  // menu recolhido: o símbolo (logo sem o nome); sem símbolo, as iniciais da clínica
  const mini = b.symbolUrl ? html`<img class="logo-light brand-mini" src="${b.symbolUrl}" alt="${b.short}"><img class="logo-dark brand-mini" src="${b.symbolDarkUrl}" alt="${b.short}">` : html`<i class="brand-mark brand-mini" aria-hidden="true">${initials(b.short)}</i>`;
  return html`<a class="brand" href="/">${full}${mini}${b.legacy ? html`<span>Sistema do consultório</span>` : ''}</a>`;
}

// Foto do usuário (ou iniciais) — usada na barra superior, na lateral e nas listas.
export function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
}
export const avatar = (u, cls = '') => (u?.photo_v
  ? html`<img class="av ${cls}" src="/conta/foto/${u.id}?v=${u.photo_v}" alt="" width="40" height="40">`
  : html`<span class="av av-ini ${cls}" aria-hidden="true">${initials(u?.name)}</span>`);

// Áreas que cada tela acompanha ao vivo (o Início acompanha tudo).
const LIVE = { marketing: 'agenda,pacientes', home: '*', recepcao: 'agenda,financeiro', agenda: 'agenda,pacientes', crm: 'crm', pacientes: 'pacientes,agenda,financeiro,exercicios,crm', exercicios: 'exercicios,pacientes', financeiro: 'financeiro,pacientes', relatorios: 'agenda,financeiro,pacientes', usuarios: 'usuarios', config: 'config,crm', conta: 'usuarios' };
export function page(req, { title, active = '', body, flash = '', live = null }) {
  const f = flash || req.flash;
  const u = req.user;
  const nav = NAV.filter(([, , , perms, feat]) => (!feat || FEATURES[feat]) && (!perms || perms.some((p) => can(u, p))));
  const notes = req.notes || { count: 0, items: [] };
  return html`${head(title, themeOf(req))}
<body class="app${sideMin(req) ? ' side-min' : ''}" data-live="${live || (LIVE[active] ?? '*')}"${u && (u.role === 'admin' || u.role === 'psicologo') ? raw(' data-tele-poll="1"') : ''}>
<aside class="side">
  ${brandLink()}
  <div class="side-card">
    <button type="button" class="side-toggle" data-side-toggle aria-expanded="${sideMin(req) ? 'false' : 'true'}" title="${sideMin(req) ? 'Expandir menu' : 'Recolher menu'}">${icon('recolher')}<span>Recolher menu</span></button>
    <nav>${nav.map(([href, label, ic]) => html`<a href="${href}" class="${active === ic ? 'on' : ''}" title="${label}">${icon(ic)}<span>${label}</span></a>`)}</nav>
    ${u ? html`<div class="side-user"><a class="who ${active === 'conta' ? 'on' : ''}" href="/conta" title="Minha conta">${avatar(u)}<span><b>${u.name}</b><small>${ROLES[u.role]?.label || ''}</small></span></a>
      <form method="post" action="/logout" class="logout"><button type="submit" title="Sair">${icon('sair')}<span>Sair</span></button></form></div>` : ''}
  </div>
</aside>
<div class="shell">
  ${u ? html`<header class="topbar">
    ${can(u, 'cadastro') ? html`<form class="tsearch" action="/pacientes" method="get" role="search">${icon('busca')}<input type="search" name="q" placeholder="Buscar paciente por nome ou telefone" aria-label="Buscar paciente"></form>` : html`<div class="tsearch-gap"></div>`}
    <div class="tactions">
      <button type="button" class="tinstall" data-install hidden title="Instalar o sistema como aplicativo neste aparelho">${icon('baixar')}<span class="ti-long">Instalar aplicativo</span><span class="ti-short">Instalar</span></button>
      <button type="button" class="ticon" data-theme-toggle title="Alternar tema claro/escuro" aria-label="Alternar tema claro/escuro"><span class="theme-ico-moon">${icon('lua')}</span><span class="theme-ico-sun">${icon('sol')}</span></button>
      ${can(u, 'usuarios') ? html`<a class="ticon ${active === 'config' ? 'on' : ''}" href="/configuracoes" title="Configurações" aria-label="Configurações">${icon('config')}</a>` : ''}
      <details class="tnotes">
        <summary class="ticon" title="Notificações" aria-label="Notificações${notes.count ? ` (${notes.count})` : ''}">${icon('sino')}${notes.count ? html`<i class="tbadge">${notes.count > 9 ? '9+' : notes.count}</i>` : ''}</summary>
        <div class="tmenu"><b class="tmenu-h">Notificações</b>
          ${notes.items.length ? notes.items.map((n) => html`<a href="${n.href}" class="tnote ${n.tone || ''}"><span>${n.text}</span>${n.sub ? html`<small>${n.sub}</small>` : ''}</a>`) : html`<p class="muted small tnote-empty">Tudo em dia por aqui. ✨</p>`}
        </div>
      </details>
      <details class="tuser">
        <summary title="${u.name}" aria-label="Menu do usuário" class="${active === 'conta' ? 'on' : ''}">${avatar(u, 'av-top')}</summary>
        <div class="tmenu"><div class="tmenu-me">${avatar(u)}<span><b>${u.name}</b><small>${u.email}</small></span></div>
          <a href="/conta">Minha conta</a>
          <button type="button" data-install hidden>Instalar aplicativo</button>
          <form method="post" action="/logout?trocar=1"><button type="submit">Trocar perfil</button></form>
          <form method="post" action="/logout"><button type="submit">Sair</button></form></div>
      </details>
    </div>
  </header>` : ''}
  <main class="main">
    ${req.billing && req.path !== '/configuracoes/assinatura' ? html`<div class="flash ${req.billing.tone} bill-bar">${req.billing.text} ${can(u, 'usuarios') ? html`<a class="btn btn-sm" href="/configuracoes/assinatura">${req.billing.cta}</a>` : html`<span class="small">Fale com a administração da clínica.</span>`}</div>` : ''}
    ${f ? html`<div class="flash ${f.type || 'ok'}">${f.text || f}</div>` : ''}
    ${body}
    <footer class="foot">${[Brand.get().short, Brand.get().signLine].filter(Boolean).join(' · ')} · Dados protegidos (LGPD) — uso restrito${Brand.get().legacy ? '' : html` · <a href="https://mentez.com.br" target="_blank" rel="noopener">Mentez</a>`}</footer>
  </main>
</div>
${u ? html`<div class="inst-banner" data-install-banner hidden role="region" aria-label="Instalar aplicativo">
  <img src="${Brand.icon('app-192.png')}" alt="" width="44" height="44">
  <div><b>Use o sistema como aplicativo</b><small>Abre direto pelo ícone, em tela cheia, e recebe notificações.</small></div>
  <button type="button" class="btn" data-install-go>Instalar</button><button type="button" class="btn ghost" data-install-later>Agora não</button>
</div>
<dialog class="inst-dlg" data-install-dlg><form method="dialog">
  <h2>Instalar o aplicativo</h2>
  <ol data-install-steps></ol>
  <p class="muted small">Depois é só abrir pelo ícone “Consultório”. Para receber avisos, ative as notificações em Minha conta.</p>
  <div class="actions"><button class="btn">Entendi</button></div>
</form></dialog>` : ''}
<script src="/static/app.js?v=${VERSION}"></script>
</body></html>`;
}

// Abas da área Agenda (a Escala fica dentro da Agenda)
export const agendaTabs = (active) => html`<nav class="tabs agenda-tabs">
  <a href="/agenda" class="${active === 'semana' ? 'on' : ''}">Agenda</a>
  <a href="/agenda/lista-espera" class="${active === 'espera' ? 'on' : ''}">Lista de espera</a>
  <a href="/escala" class="${active === 'escala' ? 'on' : ''}">Escala e bloqueios</a>
</nav>`;

export function bare(title, body, cls = 'bare', req = null, o = {}) {
  return html`${head(title, themeOf(req), o)}
<body class="${cls}">
${body}
<script src="/static/app.js?v=${VERSION}"></script>
</body></html>`;
}

// ---- formatação ----
export const money = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export function brDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}
export function brDateTime(d) {
  if (!d) return '—';
  return `${brDate(d)} ${String(d).slice(11, 16)}`;
}
export function weekday(d) {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return DIAS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
}
export const STATUS_LABEL = {
  agendada: 'Agendada', confirmada: 'Confirmada', aguardando: 'Aguardando', em_atendimento: 'Em atendimento', realizada: 'Realizada', falta: 'Falta', cancelada: 'Cancelada',
  ativo: 'Em atendimento', pausa: 'Em pausa', alta: 'Alta', inativo: 'Inativo',
  enviado: 'Enviado', aberto: 'Aberto', respondido: 'Respondido', revisado: 'Revisado',
  online: 'On-line', presencial: 'Presencial', hibrido: 'Híbrido',
  evolucao: 'Evolução de sessão', anamnese: 'Anamnese', documento: 'Documento', observacao: 'Observação',
  pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', transferencia: 'Transferência', boleto: 'Boleto', outro: 'Outro',
};
export const label = (k) => STATUS_LABEL[k] || k;
export const badge = (k) => html`<span class="badge b-${k}">${label(k)}</span>`;

export function waLink(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 11) digits = '55' + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
