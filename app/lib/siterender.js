// Gera o HTML do site da clínica (publicado ou prévia). Uma estrutura de seções comum a todos os layouts;
// o layout muda a abertura, a composição e o acabamento (site.css), o estilo muda cores e fontes.
import { html, raw, esc, VERSION } from './html.js';
import * as Sites from './sites.js';

const paras = (t) => String(t || '').split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean).map((x) => html`<p>${x}</p>`);
const ICON = {
  wa: '<path fill="currentColor" d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.6-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-1-2.2-1-.3-.1-.5-.2-.7.1l-1 1.3c-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.2 1.4 3.5c.2.2 2.4 3.6 5.7 5 2.8 1.1 3.4.9 4 .8.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5l-.5-.4z"/>',
  arrow: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 16h20M18 8l8 8-8 8"/>',
  pin: '<path fill="none" stroke="currentColor" stroke-width="2" d="M16 29s9-8.4 9-15a9 9 0 1 0-18 0c0 6.6 9 15 9 15z"/><circle cx="16" cy="14" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  mail: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 8h24v16H4zM4 9l12 9 12-9"/>',
  ig: '<rect x="5" y="5" width="22" height="22" rx="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="22.5" cy="9.5" r="1.4" fill="currentColor"/>',
  video: '<rect x="3" y="8" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M21 14l8-4v12l-8-4z"/>',
  home: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 15L16 5l12 10M8 12v14h16V12"/>',
  menu: '<path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M5 10h22M5 16h22M5 22h22"/>',
};
const ico = (k, cls = 'i') => raw(`<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true">${ICON[k]}</svg>`);
const ASPECT_WH = { '16x9': [1600, 900], '3x2': [1500, 1000], '4x5': [1200, 1500], '1x1': [1200, 1200] };

// ctx: { b (marca), base (endereço do sistema da clínica), wa, media(id, v, aspect, w), mediaMap, siteUrl, preview, t }
export function render(site, ctx) {
  const { b } = ctx;
  const L = Sites.LAYOUTS[site.layout] || Sites.LAYOUTS.editorial;
  const pal = Sites.palette(site, b);
  const on = site.sections.filter((s) => s.on && hasContent(s, ctx));
  const sec = (type) => on.find((s) => s.type === type);
  const book = sec('agendamento');
  const waUrl = ctx.wa ? `https://wa.me/${ctx.wa}?text=${encodeURIComponent('Olá! Vim pelo site e gostaria de agendar uma consulta.')}` : '';
  const formOn = !!sec('form');
  const ctaHref = site.landing && formOn ? '#form' : book ? '#agendamento' : formOn ? '#form' : (waUrl || '#contato');
  const ctaAttrs = /^#/.test(ctaHref) ? '' : raw(' target="_blank" rel="noopener"');
  const img = (id, aspect, sizes, cls = '', { eager = false, alt = null, pos = false } = {}) => {
    const m = id && ctx.mediaMap.get(Number(id));
    if (!m) return '';
    const a = alt ?? m.alt ?? '';
    if (m.kind === 'svg') return html`<img class="${cls}" src="${ctx.media(m.id, m.v, 'o', 480)}" alt="${a}" ${raw(eager ? '' : 'loading="lazy" ')}decoding="async">`;
    const [w, h] = aspect === 'o' ? [m.w, m.h] : ASPECT_WH[aspect];
    const widths = Sites.WIDTHS.filter((x) => x <= Math.max(480, m.w));
    // pos: foto de fundo (corta conforme a tela) → centraliza no ponto de foco
    const style = pos ? raw(` style="object-position:${Math.round(Number(m.fx) * 100)}% ${Math.round(Number(m.fy) * 100)}%"`) : '';
    return html`<img class="${cls}" src="${ctx.media(m.id, m.v, aspect, 1080)}" srcset="${widths.map((x) => `${ctx.media(m.id, m.v, aspect, x)} ${x}w`).join(', ')}" sizes="${sizes}" width="${w}" height="${h}" alt="${a}"${style} ${raw(eager ? 'fetchpriority="high"' : 'loading="lazy"')} decoding="async">`;
  };
  const marquee = () => {
    const items = (sec('ajuda')?.items || []).map((x) => x.t).filter(Boolean);
    if (items.length < 3) return '';
    const row = html`${items.map((t) => html`<span>${t}</span><i aria-hidden="true">✦</i>`)}`;
    return html`<div class="marquee" aria-hidden="true"><div class="marquee__track"><div class="marquee__row">${row}</div><div class="marquee__row">${row}</div></div></div>`;
  };
  let n = 0;
  const num = () => String(++n).padStart(2, '0');
  const eyebrow = (label) => html`<p class="eyebrow"><span class="eyebrow__n">${num()}</span>${label}</p>`;
  const head = (s, label) => html`<header class="sec__head">${eyebrow(label)}<h2 class="h2">${s.title || label}</h2>${s.text && s.type !== 'sobre' && s.type !== 'abordagem' && s.type !== 'contato' && s.type !== 'agendamento' ? html`<div class="sec__lead">${paras(s.text)}</div>` : ''}</header>`;
  const btn = (label, href = ctaHref, cls = '') => html`<a class="btn ${cls}" href="${href}"${href === ctaHref ? ctaAttrs : (/^https?:/.test(href) ? raw(' target="_blank" rel="noopener"') : '')}>${label}${ico('arrow', 'i btn__i')}</a>`;
  const waBtn = (label = 'Falar no WhatsApp', cls = 'btn--ghost') => (waUrl ? html`<a class="btn ${cls}" href="${waUrl}" target="_blank" rel="noopener">${ico('wa', 'i btn__i')}${label}</a>` : '');

  const S = {
    inicio: (s) => {
      const media = { split: ['4x5', '(min-width: 960px) 42vw, 92vw'], round: ['1x1', '(min-width: 960px) 30vw, 70vw'], text: ['4x5', '(min-width: 960px) 28vw, 60vw'], cover: ['o', '100vw'], aurora: ['1x1', '(min-width: 960px) 30vw, 70vw'], breath: ['1x1', '(min-width: 960px) 30vw, 66vw'], mosaic: ['4x5', '(min-width: 960px) 30vw, 70vw'], video: ['3x2', '(min-width: 960px) 44vw, 92vw'], portrait: ['4x5', '(min-width: 960px) 50vw, 100vw'] }[L.hero];
      const pic = img(s.image, media[0], media[1], 'hero__img', { eager: true, pos: L.hero === 'cover' });
      // Mosaico: até duas fotos a mais (das outras seções) flutuando em volta da principal
      const extras = L.hero === 'mosaic' ? [...new Set(site.sections.flatMap((x) => [x.image, ...(x.people || []).map((p) => p.image)]).filter((id) => id && id !== s.image && ctx.mediaMap.get(Number(id))?.kind === 'img'))].slice(0, 2) : [];
      const mediaHtml = !pic ? '' : L.hero === 'breath'
        ? html`<figure class="hero__media breath"><span class="breath__ring" aria-hidden="true"></span><span class="breath__ring breath__ring--2" aria-hidden="true"></span>${pic}<figcaption class="breath__cap" aria-hidden="true"><span class="breath__in">Inspire…</span><span class="breath__out">Solte o ar…</span></figcaption></figure>`
        : L.hero === 'video'
          ? html`<figure class="hero__media vcall">${pic}<span class="vcall__live" aria-hidden="true"><i></i>Sessão on-line</span><span class="vcall__bar" aria-hidden="true"><i class="vcall__b"></i><i class="vcall__b"></i><i class="vcall__b vcall__b--end"></i></span></figure>`
        : L.hero === 'portrait'
          ? html`<figure class="hero__media portrait" data-parallax>${pic}</figure>`
        : L.hero === 'mosaic'
          ? html`<figure class="hero__media mosaic">${pic}${extras.map((id, i) => html`<span class="mosaic__x mosaic__x--${i + 1}">${img(id, '1x1', '(min-width: 960px) 14vw, 32vw', '')}</span>`)}</figure>`
          : L.hero !== 'cover' ? html`<figure class="hero__media"${L.hero === 'split' || L.hero === 'text' ? raw(' data-parallax') : ''}>${pic}</figure>` : '';
      return html`<section class="hero hero--${L.hero}${pic ? '' : ' hero--noimg'}" id="inicio">
        ${L.hero === 'cover' && pic ? html`<div class="hero__bg" data-parallax>${pic}</div>` : ''}
        ${L.hero === 'aurora' ? raw(`<div class="aurora" aria-hidden="true"><i></i><i></i><i></i>${L.spiral ? '<b class="spiral"></b>' : ''}</div>`) : ''}
        <div class="wrap hero__grid">
          <div class="hero__text">
            ${s.eyebrow ? html`<p class="hero__eyebrow">${s.eyebrow}</p>` : ''}
            <h1 class="h1" data-words${s.titleB ? html` data-ab="${s.titleB}"` : ''}>${s.title || b.who}</h1>
            ${s.text ? html`<div class="hero__lead">${paras(s.text)}</div>` : ''}
            <div class="hero__actions">${btn(s.cta || 'Agendar consulta')}${book ? waBtn() : ''}</div>
          </div>
          ${mediaHtml}
        </div>
      </section>${L.marquee ? marquee() : ''}`;
    },
    sobre: (s) => html`<section class="sec sec--sobre" id="sobre"><div class="wrap split">
        ${s.image ? html`<figure class="split__media" data-parallax>${img(s.image, '4x5', '(min-width: 960px) 38vw, 92vw', 'rounded')}</figure>` : ''}
        <div class="split__text">${eyebrow(SL.sobre)}<h2 class="h2">${s.title}</h2><div class="prose">${paras(s.text)}</div>
          ${s.highlights?.length ? html`<ul class="ticks">${s.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : ''}</div>
      </div></section>`,
    ajuda: (s) => html`<section class="sec sec--ajuda" id="ajuda"><div class="wrap">${head(s, SL.ajuda)}
        <div class="cards">${s.items.map((x, i) => html`<article class="card" style="--i:${i % 6}"><h3 class="h3">${x.t}</h3>${x.d ? html`<p>${x.d}</p>` : ''}</article>`)}</div></div></section>`,
    abordagem: (s) => html`<section class="sec sec--abordagem alt" id="abordagem"><div class="wrap ${s.image ? 'split split--rev' : 'narrow'}">
        <div class="split__text">${eyebrow(SL.abordagem)}<h2 class="h2">${s.title}</h2><div class="prose">${paras(s.text)}</div></div>
        ${s.image ? html`<figure class="split__media">${img(s.image, '3x2', '(min-width: 960px) 44vw, 92vw', 'rounded')}</figure>` : ''}
      </div></section>`,
    processo: (s) => html`<section class="sec sec--processo" id="processo"><div class="wrap">${head(s, SL.processo)}
        <ol class="steps" data-steps><li class="steps__line" aria-hidden="true"><i></i></li>${s.items.map((x, i) => html`<li class="step" style="--i:${i}"><span class="step__n">${String(i + 1).padStart(2, '0')}</span><h3 class="h3">${x.t}</h3>${x.d ? html`<p>${x.d}</p>` : ''}</li>`)}</ol></div></section>`,
    modalidades: (s) => html`<section class="sec sec--modos alt" id="atendimento"><div class="wrap">${head(s, SL.modalidades)}
        <div class="modes">
          ${s.presencial ? html`<article class="mode">${ico('home', 'i mode__i')}<h3 class="h3">Presencial</h3>${paras(s.presencial)}</article>` : ''}
          ${s.online ? html`<article class="mode">${ico('video', 'i mode__i')}<h3 class="h3">On-line</h3>${paras(s.online)}</article>` : ''}
        </div>${book ? html`<p class="sec__cta">${btn('Ver horários disponíveis', '#agendamento')}</p>` : ''}</div></section>`,
    equipe: (s) => html`<section class="sec sec--equipe" id="equipe"><div class="wrap">${head(s, SL.equipe)}
        <div class="team">${s.people.map((p, i) => html`<article class="person" style="--i:${i % 6}">${p.image ? img(p.image, '1x1', '(min-width: 960px) 22vw, 45vw', 'person__img') : html`<span class="person__ph" aria-hidden="true">${initials(p.name)}</span>`}
          <h3 class="h3">${p.name}</h3>${p.role ? html`<p class="person__role">${p.role}</p>` : ''}${p.text ? html`<p class="person__text">${p.text}</p>` : ''}</article>`)}</div></div></section>`,
    agendamento: (s) => html`<section class="sec sec--book" id="agendamento"><div class="wrap book">
        <div class="book__intro">${eyebrow(SL.agendamento)}<h2 class="h2">${s.title}</h2>${s.text ? html`<div class="prose">${paras(s.text)}</div>` : ''}
          <ol class="book__steps"><li><span>1</span>Escolha presencial ou on-line, o dia e o horário</li><li><span>2</span>Informe seu nome e WhatsApp</li><li><span>3</span>Confirme com o código enviado ao WhatsApp</li></ol>
          ${waUrl ? html`<p class="book__alt">Prefere conversar antes? <a href="${waUrl}" target="_blank" rel="noopener">Fale pelo WhatsApp</a>.</p>` : ''}</div>
        <div class="book__panel"><div class="book__card"><iframe title="Agendamento on-line" data-src="${ctx.base}/agendar?embed=1" data-origin="${originOf(ctx.base)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>
          <p class="book__load">Carregando os horários livres…</p></div>
          <p class="book__open"><a href="${ctx.base}/agendar" target="_blank" rel="noopener">Abrir o agendamento em tela cheia ↗</a></p></div>
      </div></section>`,
    valores: (s) => html`<section class="sec sec--valores alt" id="valores"><div class="wrap narrow">${eyebrow(SL.valores)}<h2 class="h2">${s.title}</h2><div class="prose">${paras(s.text)}</div></div></section>`,
    duvidas: (s) => html`<section class="sec sec--faq" id="duvidas"><div class="wrap narrow">${head(s, SL.duvidas)}
        <div class="faq">${s.items.map((x) => html`<details class="faq__item"><summary>${x.t}</summary>${paras(x.d)}</details>`)}</div></div></section>`,
    contato: (s) => {
      const map = s.map && b.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([b.address, b.city, b.uf].filter(Boolean).join(', '))}` : '';
      return html`<section class="sec sec--contato alt" id="contato"><div class="wrap split">
        <div class="split__text">${eyebrow(SL.contato)}<h2 class="h2">${s.title}</h2>${s.text ? html`<div class="prose">${paras(s.text)}</div>` : ''}</div>
        <ul class="contacts">
          ${waUrl ? html`<li><a href="${waUrl}" target="_blank" rel="noopener">${ico('wa')}<span><small>WhatsApp</small>${fmtPhone(b.whatsapp || b.phone || ctx.wa)}</span></a></li>` : ''}
          ${b.email ? html`<li><a href="mailto:${b.email}">${ico('mail')}<span><small>E-mail</small>${b.email}</span></a></li>` : ''}
          ${b.instagram ? html`<li><a href="https://instagram.com/${String(b.instagram).replace(/^@/, '')}" target="_blank" rel="noopener">${ico('ig')}<span><small>Instagram</small>@${String(b.instagram).replace(/^@/, '')}</span></a></li>` : ''}
          ${b.address ? html`<li>${map ? html`<a href="${map}" target="_blank" rel="noopener">${ico('pin')}<span><small>Endereço · ver no mapa</small>${[b.address, b.place].filter(Boolean).join(' · ')}</span></a>` : html`<span class="contacts__row">${ico('pin')}<span><small>Endereço</small>${[b.address, b.place].filter(Boolean).join(' · ')}</span></span>`}</li>` : ''}
        </ul></div></section>`;
    },
    beneficios: (s) => html`<section class="sec sec--benef" id="beneficios"><div class="wrap narrow">${eyebrow(SL.beneficios)}<h2 class="h2">${s.title}</h2>
        <ul class="ticks ticks--big">${s.list.map((x, i) => html`<li style="--i:${i}">${x}</li>`)}</ul></div></section>`,
    evento: (s) => html`<section class="sec sec--evento alt" id="evento"><div class="wrap">${eyebrow(SL.evento)}<h2 class="h2">${s.title}</h2>
        <dl class="evt">${[['Data', s.date], ['Horário', s.time], ['Local', s.place], ['Valor', s.price], ['Vagas', s.vagas]].filter(([, v]) => v).map(([k, v], i) => html`<div class="evt__i" style="--i:${i}"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
        ${s.text ? html`<div class="prose">${paras(s.text)}</div>` : ''}${on.some((x) => x.type === 'form') ? html`<p class="sec__cta">${btn(sec('inicio')?.cta || 'Quero participar', '#form')}</p>` : ''}</div></section>`,
    form: (s) => { const st = ctx.form || {}; return html`<section class="sec sec--form" id="form"><div class="wrap form-wrap">
        <div class="form-wrap__intro">${eyebrow(SL.form)}<h2 class="h2">${s.title}</h2>${s.text ? html`<div class="prose">${paras(s.text)}</div>` : ''}
          ${waUrl ? html`<p class="book__alt">Prefere chamar agora? <a href="${waUrl}" target="_blank" rel="noopener">Fale pelo WhatsApp</a>.</p>` : ''}</div>
        <div class="form-card">${st.sent ? html`<div class="lead-ok" role="status"><b>✓</b><p>${s.success || 'Recebemos seu contato! Em breve falamos com você.'}</p>
          ${st.file ? html`<p class="lead-dl"><a class="btn" href="/d/${st.file.token}" target="_blank" rel="noopener">Baixar o material (PDF)${ico('arrow', 'i btn__i')}</a></p>` : ''}
          ${st.pix ? html`<div class="lead-pix"><p><b>Para confirmar a inscrição, pague R$ ${st.pix.amount.toFixed(2).replace('.', ',')} pelo Pix</b></p>${raw(`<img src="${st.pix.qr}" alt="QR code do Pix" width="220" height="220">`)}
            <label><span>Pix copia e cola</span><textarea readonly rows="3" data-copy-src>${st.pix.code}</textarea></label><button type="button" class="btn btn--ghost" data-copy-pix>Copiar código</button>
            <small>Também enviamos o código pelo WhatsApp. A confirmação da vaga chega depois que o pagamento for identificado.</small></div>` : ''}</div>` : html`
          ${st.error ? html`<p class="lead-err" role="alert">${st.error}</p>` : ''}
          <form method="post" action="/f" class="lead" data-lead>
            <input type="hidden" name="p" value="${ctx.path || ''}"><input type="hidden" name="src" value=""><input type="hidden" name="cmp" value="">
            <label class="lead-hp" aria-hidden="true">Não preencha<input name="website" tabindex="-1" autocomplete="off"></label>
            <label><span>Nome</span><input name="nome" required maxlength="120" autocomplete="name"></label>
            <label><span>WhatsApp (com DDD)</span><input name="whatsapp" required maxlength="20" inputmode="tel" autocomplete="tel" placeholder="(00) 00000-0000"></label>
            ${s.email ? html`<label><span>E-mail</span><input type="email" name="email" maxlength="160" autocomplete="email"></label>` : ''}
            ${s.message ? html`<label><span>Mensagem <small>(opcional)</small></span><textarea name="mensagem" rows="3" maxlength="1000" placeholder="Conte brevemente o que você procura"></textarea></label>` : ''}
            <label class="lead-ck"><input type="checkbox" name="lgpd" value="1" required><span>Li e concordo com a <a href="/politica-de-privacidade" target="_blank">Política de privacidade</a> e autorizo o contato pelo WhatsApp.</span></label>
            <button class="btn">${s.button || 'Enviar'}${ico('arrow', 'i btn__i')}</button>
            <p class="lead-note">Não é preciso contar detalhes de saúde aqui: conversamos com sigilo depois.</p>
          </form>`}</div>
      </div></section>`; },
    final: (s) => html`<section class="final" id="final"><div class="wrap final__in"><h2 class="h2">${s.title}</h2>${s.text ? html`<div class="final__lead">${paras(s.text)}</div>` : ''}<div class="hero__actions">${btn(s.cta || 'Agendar consulta', ctaHref, 'btn--light')}${book ? waBtn('Falar no WhatsApp', 'btn--ghost-light') : ''}</div></div></section>`,
  };
  const SL = Object.fromEntries(Object.entries(Sites.SECTIONS).map(([k, v]) => [k, v.label]));
  SL.modalidades = 'Atendimento'; SL.beneficios = 'Benefícios'; SL.evento = 'Informações'; SL.form = 'Contato';

  // ctx.page: página avulsa no visual do site (blog): troca o conteúdo e os dados do Google; os links do menu voltam à página inicial
  const pg = ctx.page || null; const pre = pg ? '/' : '';
  const body = pg ? [pg.main] : on.map((s) => S[s.type]?.(s) || '');
  const nav = site.landing ? [] : on.filter((s) => Sites.SECTIONS[s.type].nav && s.type !== 'inicio' && s.type !== 'agendamento' && s.type !== 'form' && s.type !== 'evento').slice(0, 6);
  // logo e favicon da Identidade visual (servidos pelo próprio endereço do site)
  const logo = b.logo ? b.logoUrl : '';
  const logoDark = b.logoDark ? b.logoDarkUrl : logo;
  const darkHeader = L.dark || (!pg && L.hero === 'cover' && sec('inicio')?.image);
  // com abertura escura, mostra a logo para fundo escuro enquanto o topo está sobre a foto e a normal depois de rolar
  const brandMark = (dark) => {
    if (!logo && !logoDark) return html`<span class="brand__name">${b.who || b.name}</span>`;
    if (L.dark) return html`<img src="${logoDark || logo}" alt="${b.who || b.name}" class="brand__logo">`;
    if (dark && logoDark && logoDark !== logo) return html`<img src="${logo}" alt="${b.who || b.name}" class="brand__logo brand__logo--l"><img src="${logoDark}" alt="" aria-hidden="true" class="brand__logo brand__logo--d">`;
    return html`<img src="${logo || logoDark}" alt="${b.who || b.name}" class="brand__logo">`;
  };
  const heroImg = sec('inicio')?.image;
  const shareId = site.seo.image || heroImg || sec('sobre')?.image;
  const share = shareId && ctx.mediaMap.get(Number(shareId))?.kind === 'img' ? `${ctx.siteUrl}${ctx.media(shareId, ctx.mediaMap.get(Number(shareId)).v, '16x9', 1600)}` : '';
  const title = pg?.title || site.seo.title || b.who || b.name;
  const desc = pg ? pg.desc || '' : site.seo.description || '';
  const cssVars = `:root{--bg:${pal.bg};--surface:${pal.surface};--ink:${pal.ink};--muted:${pal.muted};--accent:${pal.accent};--accent-text:${pal.accentText};--on-accent:${pal.onAccent};--soft:${pal.soft};--line:${pal.line};--serif:"${pal.serif}",Georgia,serif;--sans:"${pal.sans}",system-ui,-apple-system,"Segoe UI",sans-serif}`;
  const ld = {
    '@context': 'https://schema.org', '@type': ['MedicalBusiness', 'ProfessionalService'], name: b.name || b.who, url: ctx.siteUrl || undefined, description: desc || undefined,
    telephone: b.phone ? `+55 ${b.phone}` : undefined, email: b.email || undefined, image: share || undefined,
    address: b.address || b.city ? { '@type': 'PostalAddress', streetAddress: b.address || undefined, addressLocality: b.city || undefined, addressRegion: b.uf || undefined, addressCountry: 'BR' } : undefined,
    sameAs: b.instagram ? [`https://instagram.com/${String(b.instagram).replace(/^@/, '')}`] : undefined,
  };

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
${ctx.preview ? '<meta name="robots" content="noindex, nofollow">' : `<link rel="canonical" href="${esc(ctx.siteUrl)}/${esc(pg?.path ?? ctx.path ?? '')}">`}
<meta property="og:type" content="${pg?.type || 'website'}"><meta property="og:title" content="${esc(title)}">${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}${ctx.siteUrl ? `<meta property="og:url" content="${esc(ctx.siteUrl)}/${esc(pg?.path ?? ctx.path ?? '')}">` : ''}${(pg?.share || share) ? `<meta property="og:image" content="${esc(pg?.share || share)}"><meta name="twitter:card" content="summary_large_image">` : ''}
${site.seo.google && !ctx.preview ? `<meta name="google-site-verification" content="${esc(site.seo.google)}">` : ''}
<meta name="theme-color" content="${esc(pal.bg)}">
${b.faviconUrl ? `<link rel="icon" href="${esc(b.faviconUrl)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(Sites.fontsUrl(pal))}">
<link rel="stylesheet" href="/static/site/site.css?v=${VERSION}">
<style>${cssVars}</style>
<script type="application/ld+json">${JSON.stringify(pg?.ld || ld).replace(/</g, '\\u003c')}</script>
</head>
<body class="L-${site.layout} S-${site.style} M-${site.motion || 'suave'}${L.dark ? ' is-dark' : ''}${L.motion ? ' is-motion' : ''}${site.nav === 'vidro' ? ' nav-glass' : ''}${site.landing ? ' is-landing' : ''}${ctx.preview ? ' has-preview' : ''}"${ctx.preview ? '' : ` data-stats="${esc(pg?.path ?? ctx.path ?? '')}"`}>
${ctx.preview ? '<div class="preview-bar">Prévia do rascunho: só você vê esta versão. Publique em Marketing → Site para colocar no ar.</div>' : ''}
<a class="skip" href="#conteudo">Pular para o conteúdo</a>
${site.layout === 'clinica' ? String(html`<div class="topbar"><div class="wrap topbar__in">${b.address ? html`<span>${ico('pin')}${[b.address, b.place].filter(Boolean).join(' · ')}</span>` : ''}${waUrl ? html`<a href="${waUrl}" target="_blank" rel="noopener">${ico('wa')}${fmtPhone(b.whatsapp || b.phone || ctx.wa)}</a>` : ''}</div></div>`) : ''}
<header class="header${darkHeader ? ' header--ondark' : ''}${site.nav === 'vidro' ? ' header--glass' : ''}" data-header>
  <div class="wrap header__in">
    <a class="brand" href="${site.landing || pg ? '/' : '#inicio'}">${String(brandMark(darkHeader))}</a>
    <nav class="nav" aria-label="Principal"><ul data-navpill>${site.nav === 'vidro' ? '<li class="nav__pill" aria-hidden="true"></li>' : ''}${nav.map((s) => `<li><a href="${pre}#${anchor(s.type)}">${esc(Sites.SECTIONS[s.type].nav)}</a></li>`).join('')}${ctx.blogCount && !site.landing ? `<li><a href="/blog"${pg?.blog ? ' class="is-on"' : ''}>Blog</a></li>` : ''}</ul></nav>
    <a class="btn btn--sm header__cta" href="${esc(/^#/.test(ctaHref) ? pre + ctaHref : ctaHref)}"${/^#/.test(ctaHref) ? '' : ' target="_blank" rel="noopener"'}>${ctaHref === '#agendamento' ? 'Agendar' : ctaHref === '#form' ? (site.landing ? 'Quero participar' : 'Fale comigo') : 'Fale comigo'}</a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu" data-menu>${ico('menu')}<span class="sr">Abrir menu</span></button>
  </div>
  <div class="menu" id="menu" hidden data-menu-panel><ul>${nav.map((s) => `<li><a href="${pre}#${anchor(s.type)}">${esc(Sites.SECTIONS[s.type].nav)}</a></li>`).join('')}${ctx.blogCount && !site.landing ? `<li><a href="/blog"${pg?.blog ? ' class="is-on"' : ''}>Blog</a></li>` : ''}${book ? `<li><a href="${pre}#agendamento">Agendar on-line</a></li>` : ''}</ul></div>
</header>
<main id="conteudo">
${body.map(String).join('\n')}
</main>
<footer class="footer">
  <div class="wrap footer__in">
    <div><p class="footer__name">${esc(b.name || b.who)}</p>${b.signLine ? `<p>${esc(b.signLine)}</p>` : ''}${b.address ? `<p>${esc([b.address, b.place].filter(Boolean).join(' · '))}</p>` : ''}</div>
    <div class="footer__links"><a href="/politica-de-privacidade">Política de privacidade</a>${book ? `<a href="${pre}#agendamento">Agendar on-line</a>` : ''}${ctx.blogCount ? '<a href="/blog">Blog</a>' : ''}${waUrl ? `<a href="${esc(waUrl)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</div>
  </div>
  <div class="wrap footer__small"><span>© ${new Date().getFullYear()} ${esc(b.name || b.who)}</span><span>Em caso de crise ou emergência, ligue 188 (CVV) ou 192 (SAMU).</span><a href="https://mentez.com.br" target="_blank" rel="noopener">Site feito com Mentez</a></div>
</footer>
${waUrl ? `<a class="wa-float" href="${esc(waUrl)}" target="_blank" rel="noopener" aria-label="Conversar pelo WhatsApp">${String(ico('wa'))}<span>WhatsApp</span></a>` : ''}
<script src="/static/site/site.js?v=${VERSION}" defer></script>
</body>
</html>`;
}

// Política de privacidade gerada com os dados da clínica (LGPD)
export function privacy(site, ctx) {
  const { b } = ctx;
  const pal = Sites.palette(site, b);
  const nm = b.name || b.who || 'Este consultório';
  const contato = [b.email ? `e-mail ${b.email}` : '', b.phone ? `telefone/WhatsApp ${fmtPhone(b.phone)}` : ''].filter(Boolean).join(' ou ');
  const book = site.sections.some((s) => s.type === 'agendamento' && s.on);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de privacidade · ${esc(nm)}</title>${ctx.preview ? '<meta name="robots" content="noindex">' : ''}
<link rel="stylesheet" href="${esc(Sites.fontsUrl(pal))}"><link rel="stylesheet" href="/static/site/site.css?v=${VERSION}">
<style>:root{--bg:${pal.bg};--surface:${pal.surface};--ink:${pal.ink};--muted:${pal.muted};--accent:${pal.accent};--accent-text:${pal.accentText};--on-accent:${pal.onAccent};--soft:${pal.soft};--line:${pal.line};--serif:"${pal.serif}",Georgia,serif;--sans:"${pal.sans}",system-ui,sans-serif}</style></head>
<body class="L-${site.layout} S-${site.style}${Sites.LAYOUTS[site.layout]?.dark ? ' is-dark' : ''} legal-page"><main class="wrap legal">
<p><a href="/">← Voltar ao site</a></p>
<h1 class="h2">Política de privacidade</h1>
<p><strong>${esc(nm)}</strong>${b.signLine ? ` (${esc(b.signLine)})` : ''} respeita a sua privacidade e segue a Lei Geral de Proteção de Dados (Lei 13.709/2018, LGPD). Este texto explica quais dados este site trata e para quê.</p>
<h2 class="h3">Quais dados tratamos</h2>
<ul>
${book ? '<li><strong>Agendamento on-line:</strong> nome, WhatsApp e, se você informar, e-mail e data de nascimento, usados apenas para marcar a consulta, confirmar pelo código e enviar lembretes.</li>' : ''}
<li><strong>Contato pelo WhatsApp ou e-mail:</strong> as informações que você enviar, usadas para responder e organizar o atendimento.</li>
<li><strong>Navegação:</strong> este site não usa cookies de rastreamento nem publicidade. O servidor registra dados técnicos mínimos (como endereço IP e data do acesso) por segurança, por prazo limitado.</li>
</ul>
<h2 class="h3">Com quem compartilhamos</h2>
<p>O site e o agendamento funcionam na plataforma Mentez, que trata os dados em nome do consultório (operadora), com proteção técnica e sigilo. As mensagens de confirmação usam o WhatsApp. Não vendemos nem cedemos seus dados para publicidade.</p>
<h2 class="h3">Sigilo profissional</h2>
<p>As informações de atendimento são protegidas pelo sigilo profissional previsto no Código de Ética do Psicólogo e guardadas pelo prazo exigido pelas normas do Conselho Federal de Psicologia.</p>
<h2 class="h3">Seus direitos</h2>
<p>Você pode pedir a confirmação, o acesso, a correção, a exclusão (quando a lei permitir) ou a portabilidade dos seus dados, e revogar consentimentos${contato ? `, pelo ${esc(contato)}` : ''}. Também pode recorrer à Autoridade Nacional de Proteção de Dados (ANPD).</p>
${site.privacy?.extra ? `<h2 class="h3">Informações adicionais</h2>${paras(site.privacy.extra).map(String).join('')}` : ''}
<p class="legal__small">Atualizada em ${new Date().toLocaleDateString('pt-BR')}.</p>
</main></body></html>`;
}

function hasContent(s, ctx) {
  if (s.type === 'beneficios') return !!s.list?.length;
  if (s.type === 'evento') return !!(s.date || s.place || s.price);
  if (s.type === 'form') return true;
  if (s.type === 'agendamento') return !!ctx.bookingOn;
  if (s.type === 'equipe') return !!s.people?.length;
  if (s.type === 'ajuda' || s.type === 'processo' || s.type === 'duvidas') return !!s.items?.length;
  if (s.type === 'modalidades') return !!(s.online || s.presencial);
  if (s.type === 'contato') return true;
  return !!(s.title || s.text || s.image);
}
const anchor = (t) => ({ modalidades: 'atendimento' }[t] || t);
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const initials = (n) => String(n || '').replace(/^(dra?\.?|psic\.?)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : String(p || '');
}

// ---------- Blog ----------
// Monta o conteúdo das páginas do blog; o cabeçalho, as cores e o rodapé são os do site (render com ctx.page)
export function blogIndex(posts, ctx, md) {
  const card = (p) => { const m = p.cover && ctx.mediaMap.get(Number(p.cover)); return html`<article class="post-card"><a href="/blog/${p.slug}">
    ${m ? raw(`<img src="${ctx.media(m.id, m.v, '3x2', 768)}" alt="" width="1500" height="1000" loading="lazy" decoding="async">`) : html`<span class="post-card__ph" aria-hidden="true"></span>`}
    <small>${dateBR(p.published_at)}</small><h2 class="h3">${p.title}</h2>${p.excerpt ? html`<p>${p.excerpt}</p>` : ''}<span class="post-card__more">Ler ${ico('arrow', 'i')}</span></a></article>`; };
  return String(html`<section class="sec blog"><div class="wrap"><header class="sec__head"><p class="eyebrow">Blog</p><h1 class="h2">Artigos</h1><div class="sec__lead"><p>Textos para entender melhor as emoções, as relações e o cuidado com a saúde mental.</p></div></header>
    ${posts.length ? html`<div class="posts">${posts.map(card)}</div>` : html`<p>Em breve, os primeiros artigos.</p>`}</div></section>`);
}
export function blogPost(p, related, ctx, md, extra = '') {
  const m = p.cover && ctx.mediaMap.get(Number(p.cover));
  const waUrl = ctx.wa ? `https://wa.me/${ctx.wa}?text=${encodeURIComponent(`Olá! Li o artigo "${p.title}" no site e gostaria de conversar.`)}` : '';
  const share = `https://wa.me/?text=${encodeURIComponent(`${p.title} ${ctx.siteUrl}/blog/${p.slug}`)}`;
  return String(html`<article class="sec article"><div class="wrap article__in">
      <p class="article__back"><a href="/blog">← Todos os artigos</a></p>
      <p class="eyebrow">${dateBR(p.published_at)} · ${Math.max(1, Math.round(String(p.body || '').split(/\s+/).length / 200))} min de leitura</p>
      <h1 class="h1 article__title">${p.title}</h1>
      ${p.excerpt ? html`<p class="article__lead">${p.excerpt}</p>` : ''}
      ${m ? raw(`<figure class="article__cover"><img src="${ctx.media(m.id, m.v, '16x9', 1080)}" srcset="${[768, 1080, 1600].map((w) => `${ctx.media(m.id, m.v, '16x9', w)} ${w}w`).join(', ')}" sizes="(min-width: 900px) 760px, 92vw" alt="${esc(m.alt || '')}" width="1600" height="900" fetchpriority="high"></figure>`) : ''}
      <div class="article__body">${raw(md(p.body))}</div>
      <aside class="article__cta"><p><b>Precisa conversar sobre isso?</b> O acompanhamento psicológico ajuda a entender o que você sente e a encontrar caminhos.</p>
        <p class="article__btns">${ctx.bookingOn ? html`<a class="btn" href="/#agendamento">Agendar consulta${ico('arrow', 'i btn__i')}</a>` : ''}${waUrl ? html`<a class="btn btn--ghost" href="${waUrl}" target="_blank" rel="noopener">${ico('wa', 'i btn__i')}Falar no WhatsApp</a>` : ''}</p></aside>
      <p class="article__share"><a href="${share}" target="_blank" rel="noopener">${ico('wa', 'i')}Compartilhar no WhatsApp</a></p>
      <p class="article__note">Este conteúdo é informativo e não substitui o atendimento profissional. Em crise ou emergência, ligue 188 (CVV) ou 192 (SAMU).</p>
      ${raw(extra)}
    </div></article>
    ${related.length ? html`<section class="sec alt"><div class="wrap"><h2 class="h2">Leia também</h2><div class="posts">${related.map((r) => { const rm = r.cover && ctx.mediaMap.get(Number(r.cover)); return html`<article class="post-card"><a href="/blog/${r.slug}">${rm ? raw(`<img src="${ctx.media(rm.id, rm.v, '3x2', 768)}" alt="" width="1500" height="1000" loading="lazy">`) : html`<span class="post-card__ph" aria-hidden="true"></span>`}<small>${dateBR(r.published_at)}</small><h3 class="h3">${r.title}</h3></a></article>`; })}</div></div></section>` : ''}`);
}
function dateBR(d) { if (!d) return ''; const x = new Date(d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; }
