// Páginas de erro e “sem internet”.
//  - 404 da Mentez (Painel, app.mentez.com.br e endereços de clínica que não existem): com o mascote, no estilo do site.
//  - 404 de cada clínica: com a logo, as cores e o estilo da clínica (identidade visual).
//  - Sem internet: página da clínica guardada pelo aplicativo (service worker) e mostrada quando a conexão cai.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, bare, appLogo, VERSION } from './html.js';
import * as Brand from './brand.js';
import * as Styles from './styles.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FONTS = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Instrument+Serif:ital@1&display=swap';

// ---------- 404 da Mentez (com o mascote) ----------
export function mentez404(req, { title = 'Essa página tirou uma folga.', text = 'O endereço pode ter mudado ou o link está incompleto. Mas não se preocupe: daqui a gente te leva para o lugar certo.', admin = false } = {}) {
  return String(bare('Página não encontrada', html`<main class="e4 e4-mz">
    <div class="e4-bg" aria-hidden="true"><span class="e4-orb o1"></span><span class="e4-orb o2"></span><span class="e4-grid"></span></div>
    <a class="e4-brand" href="https://mentez.com.br"><img src="/static/img/site/simbolo-claro.png" alt="" width="30" height="30">mentez</a>
    <section class="e4-in">
      <figure class="e4-mascot"><img src="/static/img/mentez/assistente.png" alt="Mascote da Mentez" width="220" height="220"><figcaption class="e4-bubble">Hmm… procurei por toda parte e não achei esta página.</figcaption></figure>
      <div class="e4-txt"><p class="e4-code">404</p><h1>${title}</h1><p>${text}</p>
        <div class="e4-acts">${admin ? html`<a class="e4-btn" href="/">Voltar ao Painel</a><a class="e4-btn ghost" href="/clinicas">Ver clínicas</a>`
          : html`<a class="e4-btn" href="https://mentez.com.br">Ir para a Mentez</a><a class="e4-btn ghost" href="/inicio">Entrar na minha clínica</a><a class="e4-link" href="/criar-conta">ou teste grátis por 14 dias →</a>`}</div></div>
    </section></main>`, 'e4-body', req, { suffix: 'Mentez', css: [FONTS, `/static/errors.css?v=${VERSION}`] }));
}

// ---------- 404 da clínica (estilo da clínica) ----------
export function clinic404(req) {
  const portal = String(req.path || '').startsWith('/paciente');
  const acts = portal ? html`<a class="btn" href="/paciente">Ir para o meu portal</a>`
    : req.user ? html`<a class="btn" href="/">Ir para o início</a><a class="btn ghost" href="/agenda">Abrir a agenda</a>`
      : html`<a class="btn" href="/login">Entrar no sistema</a>`;
  return String(bare('Página não encontrada', html`<main class="e4 e4-cl">
    <section class="e4-card card">
      <div class="e4-logo">${appLogo('e4-logo-img')}</div>
      <p class="e4-code">404</p>
      <h1>Página não encontrada</h1>
      <p class="muted">O endereço pode ter mudado ou o link está incompleto. Confira o link recebido ou volte para o início.</p>
      <div class="actions e4-acts">${acts}</div>
      <p class="e4-path muted small">${String(req.originalUrl || '').slice(0, 120)}</p>
    </section></main>`, 'e4-body-cl', req, { css: [`/static/errors.css?v=${VERSION}`] }));
}

// ---------- sem internet (clínica) ----------
// Página completa, sem depender de nada externo: cores da clínica embutidas e a logo em data URL.
async function logoData() {
  try { const f = await Brand.logoFile('claro'); if (f?.buf?.length && f.buf.length < 600e3) return `data:${f.mime};base64,${f.buf.toString('base64')}`; } catch { /* sem logo enviada */ }
  const b = Brand.get();
  const file = b.legacy ? 'img/logo-terracota.png' : 'img/mentez/logo.png';
  try { return `data:image/png;base64,${fs.readFileSync(path.join(PUB, file)).toString('base64')}`; } catch { return ''; }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export async function offlinePage() {
  const b = Brand.get(); const sw = Styles.swatch(b.style || (b.legacy ? 'classico' : 'mentez'));
  const accent = /^#[0-9a-f]{6}$/i.test(b.colors?.[0] || '') ? b.colors[0] : sw.accent;
  const ink = /^#[0-9a-f]{6}$/i.test(b.colors?.[1] || '') ? b.colors[1] : sw.ink;
  const soft = /^#[0-9a-f]{6}$/i.test(b.colors?.[3] || '') ? b.colors[3] : (sw.soft && sw.soft.startsWith('#') ? sw.soft : '#EEF2F7');
  const bg = sw.bg && sw.bg.startsWith('#') ? sw.bg : '#F5F7FC';
  const logo = await logoData();
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="refresh" content="20"><meta name="theme-color" content="${esc(ink)}"><title>Sem conexão · ${esc(b.short || b.name)}</title>
<style>
:root{--a:${accent};--i:${ink};--s:${soft};--b:${bg}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(900px 600px at 10% -10%,var(--s),transparent 60%),radial-gradient(800px 600px at 110% 110%,var(--s),transparent 60%),var(--b);color:var(--i);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center}
main{width:min(460px,100%);background:#fff;border-radius:24px;padding:34px 28px 28px;box-shadow:0 30px 70px -40px rgba(0,0,0,.45);border:1px solid rgba(0,0,0,.06)}
.logo{max-width:200px;max-height:64px;margin:0 auto 22px;display:block;object-fit:contain}
.ic{width:84px;height:84px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:var(--s);color:var(--a)}
.ic svg{width:42px;height:42px}
h1{margin:0 0 8px;font-size:24px;letter-spacing:-.02em}
p{margin:0 0 6px;color:color-mix(in srgb,var(--i) 70%,#fff)}
a.btn{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:13px 22px;border-radius:999px;background:var(--a);color:#fff;font-weight:700;text-decoration:none}
small{display:block;margin-top:16px;color:color-mix(in srgb,var(--i) 55%,#fff);font-size:13px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--a);margin-right:6px;animation:p 1.6s ease-in-out infinite}
@keyframes p{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}
@media (prefers-color-scheme:dark){body{background:#101418;color:#EDF1F5}main{background:#1A2027;border-color:rgba(255,255,255,.08)}p,small{color:#AAB4C0}}
</style></head><body><main>
${logo ? `<img class="logo" src="${logo}" alt="${esc(b.short || b.name)}">` : `<h2>${esc(b.short || b.name)}</h2>`}
<div class="ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10 4.6M5 12.9a10 10 0 0 1 5-2.7M19 12.9a10 10 0 0 0-2.4-1.6M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg></div>
<h1>Sem conexão com a internet</h1>
<p>Não conseguimos falar com o sistema agora. Verifique o Wi-Fi ou os dados móveis.</p>
<p>Nenhum dado foi perdido: o que já foi salvo continua guardado.</p>
<a class="btn" href="">Tentar de novo</a>
<small><span class="dot"></span>Tentando reconectar sozinho a cada 20 segundos…</small>
</main></body></html>`;
}
