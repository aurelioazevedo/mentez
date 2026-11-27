// Mentez no site da clínica (WordPress ou qualquer site): botão flutuante de WhatsApp e seção de Agendamento on-line.
// Carregado por <script src="https://ENDERECO-DA-CLINICA/agendar/site.js" async></script>.
// A configuração (número, textos, cores) vem da Mentez: Configurações → Agendamento online → No seu site.
// Onde aparecer <div data-mentez-agendar></div> (ou o atalho [mentez_agendamento] do plugin), entra a seção completa.
// Na seção: data-titulo, data-texto e data-cor (cor de destaque, ex.: #0ea5e9).
// Opções no <script>: data-botao="nao" (sem botão flutuante), data-posicao="esquerda",
// data-trocar="sim" (os links de WhatsApp que já existem no site passam a abrir o número escolhido na Mentez).
(function (C) {
  if (window.__mentezSite) return; window.__mentezSite = 1;
  var me = document.currentScript || document.querySelector('script[src*="/agendar/site.js"]');
  var opt = (me && me.dataset) || {};
  var d = document;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var waUrl = C.wa ? 'https://wa.me/' + C.wa + (C.msg ? '?text=' + encodeURIComponent(C.msg) : '') : '';
  var bookUrl = C.base + '/agendar';
  var WA_ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.6-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-1-2.2-1-.3-.1-.5-.2-.7.1l-1 1.3c-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.2 1.4 3.5c.2.2 2.4 3.6 5.7 5 2.8 1.1 3.4.9 4 .8.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5l-.5-.4z"/></svg>';
  var CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 14l2 2 4-4"/></svg>';

  // ---------- estilos (tudo com prefixo mzw-, para não mexer no tema do site) ----------
  var css = '' +
    '.mzw-fab{position:fixed;z-index:99990;bottom:max(18px,env(safe-area-inset-bottom));' + (opt.posicao === 'esquerda' ? 'left' : 'right') + ':18px;display:flex;align-items:center;gap:10px;padding:0;height:58px;min-width:58px;border-radius:999px;background:#25D366;color:#fff !important;text-decoration:none !important;font:600 15px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 30px -10px rgba(0,0,0,.45),0 0 0 0 rgba(37,211,102,.5);transition:transform .2s ease,box-shadow .2s ease,padding .25s ease;animation:mzw-pulse 2.6s ease-out 1.2s 3}' +
    '.mzw-fab svg{width:30px;height:30px;flex:0 0 30px;margin-left:14px}' +
    '.mzw-fab span{max-width:0;overflow:hidden;white-space:nowrap;opacity:0;transition:max-width .3s ease,opacity .2s ease,margin .3s ease}' +
    '.mzw-fab.mzw-open span,.mzw-fab:hover span,.mzw-fab:focus-visible span{max-width:220px;opacity:1;margin-right:20px}' +
    '.mzw-fab:hover{transform:translateY(-2px)}.mzw-fab:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
    '@keyframes mzw-pulse{0%{box-shadow:0 12px 30px -10px rgba(0,0,0,.45),0 0 0 0 rgba(37,211,102,.55)}70%{box-shadow:0 12px 30px -10px rgba(0,0,0,.45),0 0 0 16px rgba(37,211,102,0)}100%{box-shadow:0 12px 30px -10px rgba(0,0,0,.45),0 0 0 0 rgba(37,211,102,0)}}' +
    '.mzw-book{--mzw-c:' + (C.color || '#0D7C77') + ';box-sizing:border-box;max-width:1080px;margin:0 auto;padding:56px 20px;font-family:inherit;color:inherit;scroll-margin-top:80px}' +
    '.mzw-book *{box-sizing:border-box}' +
    '.mzw-head{max-width:680px;margin:0 auto 26px;text-align:center}' +
    '.mzw-eyebrow{display:inline-flex;align-items:center;gap:8px;margin:0 0 10px;padding:6px 14px;border-radius:999px;background:color-mix(in srgb,var(--mzw-c) 12%,transparent);color:var(--mzw-c);font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}' +
    '.mzw-eyebrow svg{width:16px;height:16px}' +
    '.mzw-head h2{color:inherit;font-family:inherit;font-weight:800;margin:0 0 10px;font-size:clamp(26px,4vw,38px);line-height:1.15}' +
    '.mzw-head p{color:inherit;margin:0;opacity:.8;font-size:17px;line-height:1.55}' +
    '.mzw-head .mzw-eyebrow{color:var(--mzw-c);opacity:1;margin:0 0 10px;font-size:13px}' +
    '.mzw-steps{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:0 0 26px;padding:0;list-style:none}' +
    '.mzw-steps li{color:inherit;margin:0;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:12px;background:rgba(127,127,127,.08);font-size:14px;font-weight:600}' +
    '.mzw-steps b{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--mzw-c);color:#fff;font-size:12px}' +
    '.mzw-card{position:relative;max-width:760px;margin:0 auto;padding:20px 22px 8px;border-radius:22px;overflow:hidden;background:#fff;box-shadow:0 30px 60px -36px rgba(0,0,0,.45);border:1px solid rgba(0,0,0,.07)}' +
    '.mzw-card iframe{display:block;width:100%;height:520px;border:0;background:#fff;transition:height .25s ease}' +
    '.mzw-load{position:absolute;inset:0;display:grid;place-items:center;background:#fff;color:#55606e;font-size:15px;transition:opacity .3s}' +
    '.mzw-load i{display:block;width:36px;height:36px;margin:0 auto 10px;border:4px solid rgba(0,0,0,.08);border-top-color:var(--mzw-c);border-radius:50%;animation:mzw-r 1s linear infinite}' +
    '@keyframes mzw-r{to{transform:rotate(360deg)}}' +
    '.mzw-card.mzw-ready .mzw-load{opacity:0;pointer-events:none}' +
    '.mzw-alt{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:10px 18px;margin:18px auto 0;font-size:15px}' +
    '.mzw-alt a{color:var(--mzw-c);font-weight:600;text-decoration:none}.mzw-alt a:hover{text-decoration:underline}' +
    '.mzw-wa{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:999px;background:#25D366;color:#fff !important;text-decoration:none !important}' +
    '.mzw-wa svg{width:20px;height:20px}' +
    '.mzw-off{max-width:560px;margin:0 auto;padding:28px;border-radius:18px;background:rgba(127,127,127,.08);text-align:center}' +
    '.mzw-trust{margin:14px 0 0;text-align:center;font-size:13px;opacity:.65}' +
    '@media (max-width:600px){.mzw-book{padding:40px 14px}.mzw-card{border-radius:16px;padding:12px 10px 4px}.mzw-steps li{font-size:13px;padding:7px 11px}.mzw-fab{height:56px;min-width:56px}}' +
    '@media (prefers-reduced-motion:reduce){.mzw-fab,.mzw-card iframe{animation:none;transition:none}}';
  var st = d.createElement('style'); st.id = 'mentez-site-css'; st.textContent = css; (d.head || d.documentElement).appendChild(st);

  // ---------- botão flutuante ----------
  var fab = null;
  function addFab() {
    if (!waUrl || opt.botao === 'nao' || d.querySelector('.mzw-fab')) return;
    fab = d.createElement('a');
    fab.className = 'mzw-fab'; fab.href = waUrl; fab.target = '_blank'; fab.rel = 'noopener';
    fab.setAttribute('aria-label', C.label || 'Agendar pelo WhatsApp');
    fab.innerHTML = WA_ICON + '<span>' + esc(C.label || 'Agendar pelo WhatsApp') + '</span>';
    d.body.appendChild(fab);
    // mostra o texto por alguns segundos ao abrir o site; depois fica só o ícone (o texto volta ao passar o mouse)
    setTimeout(function () { fab.classList.add('mzw-open'); }, 1500);
    setTimeout(function () { fab.classList.remove('mzw-open'); }, 7000);
  }
  // links do site que devem abrir o mesmo WhatsApp: class="mentez-whatsapp" ou href="#whatsapp"
  function wireLinks() {
    if (!waUrl) return;
    var sel = 'a.mentez-whatsapp, .mentez-whatsapp a, a[href="#whatsapp"]';
    if (opt.trocar === 'sim') sel += ', a[href*="wa.me/"], a[href*="api.whatsapp.com/send"], a[href*="web.whatsapp.com/send"], a[href^="whatsapp:"]';
    var ls = d.querySelectorAll(sel);
    for (var i = 0; i < ls.length; i++) { if (ls[i].className.indexOf('mzw-') === 0) continue; ls[i].href = waUrl; ls[i].target = '_blank'; ls[i].rel = 'noopener'; }
  }

  // ---------- seção de agendamento ----------
  var frames = [];
  function section(el) {
    if (el.getAttribute('data-mz-ok')) return; el.setAttribute('data-mz-ok', '1');
    var title = el.getAttribute('data-titulo') || C.title; var text = el.getAttribute('data-texto') || C.text;
    var s = d.createElement('section'); s.className = 'mzw-book'; if (!d.getElementById('agendar')) s.id = 'agendar';
    var cor = el.getAttribute('data-cor'); if (cor && /^#[0-9a-f]{3,8}$/i.test(cor)) s.style.setProperty('--mzw-c', cor);
    var head = '<div class="mzw-head"><p class="mzw-eyebrow">' + CAL_ICON + 'Agendamento on-line</p><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
    var alt = '<div class="mzw-alt">' + (waUrl ? '<span>Prefere conversar antes?</span><a class="mzw-wa" href="' + esc(waUrl) + '" target="_blank" rel="noopener">' + WA_ICON + 'Falar no WhatsApp</a>' : '') +
      (C.enabled ? '<a href="' + esc(bookUrl) + '" target="_blank" rel="noopener">Abrir em tela cheia ↗</a>' : '') + '</div>';
    if (!C.enabled) {
      s.innerHTML = head + '<div class="mzw-off"><p>O agendamento on-line está indisponível no momento.' + (waUrl ? ' Fale com a gente pelo WhatsApp para marcar sua consulta.' : '') + '</p></div>' + alt;
    } else {
      s.innerHTML = head + '<ol class="mzw-steps"><li><b>1</b>Escolha o dia e o horário</li><li><b>2</b>Informe seus dados</li><li><b>3</b>Confirme com o código no WhatsApp</li></ol>' +
        '<div class="mzw-card"><div class="mzw-load"><div><i></i>Carregando os horários livres…</div></div><iframe title="Agendamento on-line — ' + esc(C.name) + '" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write"></iframe></div>' +
        alt + '<p class="mzw-trust">🔒 Seus dados são protegidos (LGPD) · agendamento pela Mentez</p>';
    }
    el.innerHTML = ''; el.appendChild(s);
    var fr = s.querySelector('iframe'); if (!fr) return;
    frames.push({ fr: fr, card: s.querySelector('.mzw-card'), sec: s, first: true });
    var load = function () { if (!fr.src) fr.src = bookUrl + '?embed=1'; };
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { load(); io.disconnect(); } }, { rootMargin: '600px 0px' });
      io.observe(s);
    } else load();
    fr.addEventListener('load', function () { setTimeout(function () { s.querySelector('.mzw-card').classList.add('mzw-ready'); }, 300); });
  }
  // a página de agendamento informa a altura e as trocas de etapa (embed.js)
  window.addEventListener('message', function (e) {
    if (e.origin !== C.origin || !e.data || e.data.type !== 'lm-agendar') return;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i]; if (f.fr.contentWindow !== e.source) continue;
      if (e.data.h) f.fr.style.height = Math.max(320, Math.min(4000, Number(e.data.h) + 4)) + 'px';
      f.card.classList.add('mzw-ready');
      if (e.data.nav) {
        if (f.first) f.first = false;
        else { var r = f.sec.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight * .6) f.card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
    }
  });

  function boot() {
    addFab(); wireLinks();
    // temas e construtores (Elementor etc.) às vezes montam botões depois de carregar: confere de novo
    if (opt.trocar === 'sim') { setTimeout(wireLinks, 1500); setTimeout(wireLinks, 4000); }
    var els = d.querySelectorAll('[data-mentez-agendar], #mentez-agendar');
    for (var i = 0; i < els.length; i++) section(els[i]);
    // o botão flutuante some enquanto a seção de agendamento está na tela (para não cobrir o formulário no celular)
    if (fab && frames.length && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { var on = es.some(function (x) { return x.isIntersecting; }); fab.style.transform = on ? 'translateY(140%)' : ''; }, { threshold: .25 });
      frames.forEach(function (f) { io.observe(f.card); });
    }
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot); else boot();
})
