// Sites das clínicas: menu do celular, topo ao rolar, entrada suave das seções e agenda on-line embutida.
(function () {
  var d = document; d.documentElement.classList.add('js');
  var header = d.querySelector('[data-header]');
  var onScroll = function () { if (header) header.classList.toggle('is-scrolled', window.scrollY > 12); };
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // menu do celular
  var btn = d.querySelector('[data-menu]'); var panel = d.querySelector('[data-menu-panel]');
  if (btn && panel) {
    var set = function (open) { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); panel.hidden = !open; if (header && open) header.classList.add('is-scrolled'); else onScroll(); };
    btn.addEventListener('click', function () { set(panel.hidden); });
    panel.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  }

  // entrada suave das seções
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
      card.classList.add('is-ready');
      if (e.data.nav) { if (first) first = false; else { var r = card.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight * 0.6) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
    });
    // o botão do WhatsApp some enquanto a pessoa preenche o agendamento (não cobre o formulário no celular)
    var wa = d.querySelector('.wa-float');
    if (wa && 'IntersectionObserver' in window) new IntersectionObserver(function (es) { wa.classList.toggle('is-hidden', es[0].isIntersecting); }, { threshold: 0.2 }).observe(card);
  }
})();
