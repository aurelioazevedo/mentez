// Sites das clínicas: menu do celular, topo ao rolar, animações (desligadas / suaves / expressivas) e agenda on-line embutida.
(function () {
  var d = document; var body = d.body; d.documentElement.classList.add('js');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var motion = body.classList.contains('M-off') ? 'off' : body.classList.contains('M-viva') ? 'viva' : 'suave';
  var viva = motion === 'viva' && !reduce;
  var header = d.querySelector('[data-header]');

  // resultados do site (sem cookies): visita, origem e cliques. A origem vem do utm_source ou do site anterior
  // e fica só nesta aba (sessionStorage) para atribuir o formulário/clique à mesma origem.
  var statPath = body.getAttribute('data-stats');
  var src = 'direto'; var cmp = '';
  try {
    var qs = new URLSearchParams(location.search);
    var ref = d.referrer && d.referrer.indexOf(location.host) < 0 ? d.referrer : '';
    var fresh = qs.get('utm_source') || (ref ? ref.replace(/^https?:\/\//, '').split('/')[0] : '');
    src = fresh || sessionStorage.getItem('mz_src') || 'direto';
    cmp = qs.get('utm_campaign') || sessionStorage.getItem('mz_cmp') || '';
    sessionStorage.setItem('mz_src', src); if (cmp) sessionStorage.setItem('mz_cmp', cmp);
  } catch (e) { /* navegação privada */ }
  var beacon = function (k) {
    if (statPath === null) return;
    var data = JSON.stringify({ p: statPath, s: src, k: k });
    try { if (navigator.sendBeacon) navigator.sendBeacon('/v', data); else fetch('/v', { method: 'POST', body: data, keepalive: true }); } catch (e) { /* sem rede */ }
  };
  if (statPath !== null && !/[?&](enviado|erro)=/.test(location.search)) beacon('view');
  d.addEventListener('click', function (e) { var a = e.target.closest('a[href*="wa.me/"]'); if (a) beacon('wa'); });
  d.querySelectorAll('[data-lead]').forEach(function (f) { var a = f.querySelector('[name=src]'); var b2 = f.querySelector('[name=cmp]'); if (a) a.value = src; if (b2) b2.value = cmp; });
  var menuOpen = false; var lastY = window.scrollY;

  // título da abertura palavra por palavra (Expressivas)
  if (viva) d.querySelectorAll('[data-words]').forEach(function (h) {
    var words = h.textContent.trim().split(/\s+/); h.setAttribute('aria-label', h.textContent.trim()); h.textContent = '';
    words.forEach(function (w, i) {
      var o = d.createElement('span'); o.className = 'w'; o.setAttribute('aria-hidden', 'true');
      var s = d.createElement('span'); s.style.setProperty('--i', i); s.textContent = w; o.appendChild(s); h.appendChild(o);
      if (i < words.length - 1) h.appendChild(d.createTextNode(' '));
    });
  });

  // topo: sombra ao rolar; nas Expressivas some ao descer e volta ao subir
  var parallax = viva && window.innerWidth >= 720 ? [].slice.call(d.querySelectorAll('[data-parallax]')) : [];
  var steps = viva ? [].slice.call(d.querySelectorAll('[data-steps]')) : [];
  var ticking = false;
  var frame = function () {
    ticking = false; var y = window.scrollY; var vh = window.innerHeight;
    if (header) {
      header.classList.toggle('is-scrolled', y > 12);
      if (viva && !menuOpen) { if (y > 320 && y - lastY > 6) header.classList.add('is-hidden'); else if (lastY - y > 6 || y < 120) header.classList.remove('is-hidden'); }
    }
    lastY = y;
    parallax.forEach(function (el) {
      var r = el.getBoundingClientRect(); if (r.bottom < -100 || r.top > vh + 100) return;
      var py = Math.max(-40, Math.min(40, (r.top + r.height / 2 - vh / 2) * -0.07));
      el.style.setProperty('--py', py.toFixed(1) + 'px');
    });
    steps.forEach(function (el) {
      var r = el.getBoundingClientRect(); var p = Math.max(0, Math.min(1, (vh * 0.85 - r.top) / (r.height + vh * 0.3)));
      el.style.setProperty('--p', p.toFixed(3));
    });
  };
  var onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  window.addEventListener('scroll', onScroll, { passive: true }); frame();

  // menu do celular
  var btn = d.querySelector('[data-menu]'); var panel = d.querySelector('[data-menu-panel]');
  if (btn && panel) {
    var set = function (open) { menuOpen = open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); panel.hidden = !open; if (header) { header.classList.remove('is-hidden'); if (open) header.classList.add('is-scrolled'); } if (!open) frame(); };
    btn.addEventListener('click', function () { set(panel.hidden); });
    panel.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  }

  // menu de vidro: a pílula acompanha o mouse e, ao rolar, a seção que está na tela
  var navUl = d.querySelector('[data-navpill]'); var pill = navUl && navUl.querySelector('.nav__pill');
  if (pill) {
    var links = [].slice.call(navUl.querySelectorAll('a')); var current = null;
    var place = function (a, instant) {
      if (!a || !a.offsetParent) { pill.style.opacity = '0'; return; }
      if (instant || reduce) pill.style.transition = 'none';
      pill.style.width = a.offsetWidth + 'px'; pill.style.height = a.offsetHeight + 'px';
      pill.style.transform = 'translate(' + a.offsetLeft + 'px,' + a.offsetTop + 'px)'; pill.style.opacity = '1';
      if (instant || reduce) { void pill.offsetWidth; pill.style.transition = ''; }
    };
    var setCurrent = function (a) { current = a; links.forEach(function (x) { x.classList.toggle('is-on', x === a); }); place(a); };
    navUl.addEventListener('mouseover', function (e) { var a = e.target.closest('a'); if (a) place(a); });
    navUl.addEventListener('mouseleave', function () { place(current); });
    window.addEventListener('resize', function () { place(current, true); });
    if ('IntersectionObserver' in window) {
      var byId = {}; links.forEach(function (a) { var id = (a.getAttribute('href') || '').slice(1); var el = id && d.getElementById(id); if (el) byId[id] = a; });
      var spy = new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) setCurrent(byId[x.target.id]); }); }, { rootMargin: '-45% 0px -50% 0px' });
      Object.keys(byId).forEach(function (id) { spy.observe(d.getElementById(id)); });
      var top = d.getElementById('inicio'); if (top) new IntersectionObserver(function (es) { if (es[0].isIntersecting) { current = null; links.forEach(function (x) { x.classList.remove('is-on'); }); pill.style.opacity = '0'; } }, { rootMargin: '-45% 0px -50% 0px' }).observe(top);
    }
  }

  // seções surgem ao rolar (Suaves e Expressivas)
  if (motion !== 'off' && !reduce && 'IntersectionObserver' in window) {
    var els = d.querySelectorAll('.sec__head, .split__text, .split__media, .card, .step, .mode, .person, .faq, .contacts, .book__intro, .final__in');
    var io = new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) { x.target.classList.add('is-in'); io.unobserve(x.target); } }); }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (el) { el.classList.add('rv'); io.observe(el); });
  }

  // agenda on-line: carrega perto da seção e acompanha a altura do conteúdo
  var fr = d.querySelector('.book__card iframe');
  if (fr) {
    var card = fr.closest('.book__card'); var origin = fr.getAttribute('data-origin'); var first = true;
    var load = function () { if (!fr.src) fr.src = fr.getAttribute('data-src'); };
    if ('IntersectionObserver' in window) { var o2 = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { load(); o2.disconnect(); } }, { rootMargin: '700px 0px' }); o2.observe(card); } else load();
    fr.addEventListener('load', function () { setTimeout(function () { card.classList.add('is-ready'); }, 300); });
    window.addEventListener('message', function (e) {
      if (e.origin !== origin || e.source !== fr.contentWindow || !e.data || e.data.type !== 'lm-agendar') return;
      if (e.data.h) fr.style.height = Math.max(320, Math.min(4000, Number(e.data.h) + 4)) + 'px';
      if (e.data.nav && /^\/agendar\/pronto\//.test(e.data.path || '')) beacon('book');
      card.classList.add('is-ready');
      if (e.data.nav) { if (first) first = false; else { var r = card.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight * 0.6) card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); } }
    });
    // o botão do WhatsApp some enquanto a pessoa preenche o agendamento (não cobre o formulário no celular)
    var wa = d.querySelector('.wa-float');
    if (wa && 'IntersectionObserver' in window) new IntersectionObserver(function (es) { wa.classList.toggle('is-hidden', es[0].isIntersecting); }, { threshold: 0.2 }).observe(card);
  }
})();
