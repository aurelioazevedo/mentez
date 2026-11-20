// TV da recepção: consulta o painel a cada 2 s, mostra a chamada atual e as últimas, toca o sinal e fala a senha,
// e passa as campanhas da clínica (texto, imagem, vídeo, QR code). A chamada sempre interrompe a mídia.
(() => {
  const root = document.getElementById('tv');
  const TZ = 'America/Sao_Paulo';
  let built = '';            // tema+modelo da estrutura montada
  let lastCall = null;       // id da chamada atual já anunciada
  let lastReload;            // pedido de recarga vindo do sistema
  let first = true;
  let fails = 0;
  let ctx = null;            // áudio (liberado com um toque)
  let soundOk = false;
  let holding = false;       // chamada em destaque: mídia pausada
  // programação
  let items = []; let sig = ''; let seq = []; let pos = -1; let timer = null; let shownAt = 0; let curItem = null;
  window.__tvAnnounced = 0; window.__tvShown = [];

  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const $ = (sel) => root.querySelector(sel);

  // ---------- relógio ----------
  function clock() {
    const d = new Date();
    const c = $('.tv-clock'); const dt = $('.tv-date');
    if (c) c.textContent = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
    if (dt) { const t = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d); dt.textContent = t.charAt(0).toUpperCase() + t.slice(1); }
  }
  setInterval(clock, 1000);

  // ---------- som ----------
  function unlock() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); }
      soundOk = true;
    } catch (e) { /* sem áudio */ }
    goFull(); wake(); updateBtn();
  }

  // ---------- tela cheia e tela sempre acesa ----------
  const de = document.documentElement;
  const fsApi = de.requestFullscreen || de.webkitRequestFullscreen;
  const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function goFull() {
    if (!fsApi || fsOn()) return;
    try { const r = fsApi.call(de, { navigationUI: 'hide' }); if (r && r.catch) r.catch(() => {}); } catch (e) { /* navegador sem tela cheia */ }
  }
  let lock = null;
  async function wake() {
    if (!('wakeLock' in navigator) || lock || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch (e) { /* não permitido */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  // botão único (fica fora da área redesenhada, então não some a cada atualização)
  const btn = h('button', 'tv-sound'); btn.type = 'button'; btn.hidden = true; document.body.append(btn);
  function updateBtn() {
    const needFs = !!fsApi && !fsOn();
    if (!soundOk) btn.textContent = needFs ? 'Toque aqui (ou OK no controle) para ativar o som e a tela cheia' : 'Toque aqui (ou OK no controle) para ativar o som';
    else btn.textContent = '⛶ Tela cheia — toque aqui ou aperte OK';
    btn.hidden = soundOk && !needFs;
    if (!btn.hidden && document.activeElement !== btn) btn.focus({ preventScroll: true });
  }
  document.addEventListener('fullscreenchange', updateBtn);
  document.addEventListener('webkitfullscreenchange', updateBtn);
  window.__tvFs = () => ({ btn: btn.hidden ? '' : btn.textContent, fs: fsOn(), lock: !!lock, sound: soundOk });
  document.addEventListener('click', unlock);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') unlock(); });
  function tone(freq, start, dur, vol = 0.25) {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
  }
  function chime(kind) {
    if (!ctx || !soundOk || kind === 'nenhum') return 0;
    if (kind === 'dois') { tone(880, 0, 0.35); tone(880, 0.45, 0.35); return 1000; }
    tone(988, 0, 1.2, 0.22); tone(784, 0.35, 1.4, 0.2); return 1500;
  }
  function speak(text, times) {
    if (!window.speechSynthesis || !soundOk) return;
    const voices = window.speechSynthesis.getVoices();
    const br = voices.filter((x) => /pt[-_]BR/i.test(x.lang));
    const v = br.find((x) => /natural|online|neural/i.test(x.name)) || br.find((x) => /google/i.test(x.name)) || br[0] || voices.find((x) => /^pt/i.test(x.lang));
    window.__tvVoice = v ? `navegador: ${v.name}` : 'navegador';
    for (let i = 0; i < times; i++) { const u = new SpeechSynthesisUtterance(text); u.lang = 'pt-BR'; u.rate = 0.92; if (v) u.voice = v; window.speechSynthesis.speak(u); }
  }
  // Voz neural gerada no servidor (MP3), tocada pelo áudio já liberado; se falhar, voz do navegador.
  async function neural(call, times, startAt) {
    const r = await fetch(`/tv/voz/${call.id}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`voz ${r.status}`);
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    let t = Math.max(ctx.currentTime + 0.05, startAt);
    for (let i = 0; i < times; i++) { const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(t); t += buf.duration + 0.7; }
    window.__tvVoice = 'neural';
  }
  function announce(call, sound) {
    window.__tvAnnounced++;
    const box = $('.tv-call') || $('.tv-overlay');
    if (box) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
    const wait = chime(sound.chime);
    if (!sound.voice) return;
    if (sound.tts && ctx && soundOk) {
      const t0 = Date.now(); const startAt = ctx.currentTime + wait / 1000;
      neural(call, sound.repeat, startAt).catch(() => { window.__tvVoice = 'navegador'; setTimeout(() => speak(call.speech, sound.repeat), Math.max(0, wait - (Date.now() - t0))); });
    } else setTimeout(() => speak(call.speech, sound.repeat), wait);
  }

  // ---------- tela de conexão ----------
  function renderPair(code) {
    built = 'pair'; stopItems();
    document.body.className = 'tv theme-escuro';
    root.replaceChildren();
    const box = h('div', 'tv-pair');
    const img = h('img', 'tv-pair-logo'); img.src = '/static/img/logo-creme.png'; img.alt = '';
    box.append(img, h('p', 'tv-pair-k', 'Conectar esta TV ao sistema'), h('b', 'tv-pair-code', `${code.slice(0, 3)} ${code.slice(3)}`),
      h('p', 'tv-pair-t', 'No sistema, abra Configurações → Painel de chamadas → Telas conectadas e digite este código.'),
      h('p', 'tv-pair-s', 'O código muda a cada 30 minutos. Esta tela atualiza sozinha quando a conexão for feita.'));
    root.append(box);
  }

  // ---------- estrutura ----------
  const callBlock = (cls) => { const c = h('section', cls); c.append(h('span', 'tv-kicker'), h('b', 'tv-ticket'), (() => { const w = h('div', 'tv-where'); w.append(h('span', 'tv-room'), h('span', 'tv-pro')); return w; })()); return c; };
  function build(d) {
    built = `${d.theme}|${d.layout}`;
    stopItems(); items = []; sig = '';
    document.body.className = `tv theme-${d.theme}`;
    root.replaceChildren();
    const scr = h('div', `tv-screen layout-${d.layout}`);
    const head = h('header', 'tv-head');
    const logo = h('img', 'tv-logo'); logo.alt = 'Logo da clínica'; logo.src = d.theme === 'claro' ? '/static/img/logo-terracota.png' : '/static/img/logo-creme.png';
    const time = h('div', 'tv-time'); time.append(h('span', 'tv-date'), h('b', 'tv-clock'));
    head.append(logo, time);
    const main = h('main', 'tv-main');
    if (d.layout === 'midia') {
      const stage = h('section', 'tv-stage'); stage.append(h('div', 'tv-item-host'));
      main.append(stage);
      const strip = h('div', 'tv-strip');
      const now = h('div', 'tv-strip-now'); now.append(h('span', 'tv-strip-k'), h('b', 'tv-strip-t'), h('span', 'tv-strip-w'));
      strip.append(now, h('span', 'tv-strip-prev'));
      const ov = callBlock('tv-overlay'); ov.hidden = true;
      scr.append(head, main, strip, ov);
    } else {
      const left = h('div', 'tv-left');
      const recent = h('section', 'tv-recent'); recent.append(h('h2', '', 'Últimas chamadas'), h('ol', 'tv-recent-list'));
      left.append(callBlock('tv-call'), recent);
      main.append(left);
      if (d.layout !== 'chamadas') { const side = h('section', 'tv-side'); side.append(h('div', 'tv-item-host')); main.append(side); }
      scr.append(head, main);
    }
    const foot = h('footer', 'tv-ticker'); foot.append(h('span', 'tv-ticker-t'));
    const off = h('p', 'tv-offline'); off.hidden = true;
    scr.append(foot, off);
    root.append(scr);
    clock();
  }

  // ---------- programação (campanhas) ----------
  function stopItems() { clearTimeout(timer); timer = null; pos = -1; curItem = null; }
  function sequence(list) { // distribui pelo peso: A(2) B(1) → A B A
    const out = []; const max = Math.max(1, ...list.map((x) => x.weight || 1));
    for (let r = 1; r <= max; r++) for (const x of list) if ((x.weight || 1) >= r) out.push(x);
    return out;
  }
  function setItems(list) {
    const s = JSON.stringify(list.map((x) => [x.id, x.weight, x.media, x.title, x.body, x.qr, x.duration]));
    const host = $('.tv-item-host'); if (!host) return;
    const box = host.parentElement;
    box.classList.toggle('empty', !list.length);
    if (s === sig) return;
    sig = s; items = list; seq = sequence(list);
    const keep = curItem ? seq.findIndex((x) => x.id === curItem.id) : -1;
    if (!seq.length) { stopItems(); host.replaceChildren(welcome()); return; }
    if (keep >= 0) { pos = keep; return; }
    clearTimeout(timer); pos = -1; next();
  }
  function welcome() {
    const w = h('div', 'tv-item tv-welcome');
    const k = h('span', 'tv-item-k', 'Bem-vindo(a)'); const t = h('h2', 'tv-item-t', 'Fique à vontade. Você será chamado(a) por aqui.');
    w.append(k, t); return w;
  }
  function next() {
    clearTimeout(timer);
    if (!seq.length) return;
    if (holding) { timer = setTimeout(next, 1000); return; }
    pos = (pos + 1) % seq.length;
    show(seq[pos]);
  }
  function show(it) {
    const host = $('.tv-item-host'); if (!host) return;
    curItem = it; shownAt = Date.now();
    const el = h('div', `tv-item fmt-${it.format}${it.title || it.body || it.qr ? '' : ' only-media'}`);
    let video = null;
    if (it.media && it.format === 'imagem') { const img = h('img', 'tv-item-media'); img.src = it.media; img.alt = it.title || ''; el.append(img); }
    if (it.media && it.format === 'video') {
      video = h('video', 'tv-item-media'); video.src = it.media; video.muted = true; video.autoplay = true; video.playsInline = true; video.setAttribute('muted', ''); video.preload = 'auto';
      video.addEventListener('ended', () => { if (curItem === it) next(); });
      video.addEventListener('error', () => { if (curItem === it) timer = setTimeout(next, (it.duration || 12) * 1000); });
      el.append(video);
    }
    if (it.title || it.body || it.qr) {
      const tx = h('div', 'tv-item-text');
      if (it.kind) tx.append(h('span', 'tv-item-k', it.kind));
      if (it.title) tx.append(h('h2', 'tv-item-t', it.title));
      if (it.body) tx.append(h('p', 'tv-item-b', it.body));
      if (it.qr) { const qr = h('div', 'tv-item-qr'); const qi = h('img'); qi.src = it.qr; qi.alt = 'QR code'; qr.append(qi, h('span', '', it.qrLabel || '')); tx.append(qr); }
      el.append(tx);
    }
    el.classList.add('in');
    host.replaceChildren(el);
    window.__tvShown.push(it.id); if (window.__tvShown.length > 50) window.__tvShown.shift();
    if (it.cid) fetch('/tv/exibicao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid: it.cid }), credentials: 'same-origin', keepalive: true }).catch(() => {});
    if (video) { const p = video.play(); if (p && p.catch) p.catch(() => {}); timer = setTimeout(next, 120000); } // vídeo: segue ao terminar (máx. 2 min)
    else timer = setTimeout(next, (it.duration || 12) * 1000);
    // pré-carrega a próxima imagem
    const nx = seq[(pos + 1) % seq.length]; if (nx && nx.media && nx.format === 'imagem') { const pre = new Image(); pre.src = nx.media; }
  }
  function hold(on) {
    if (on === holding) return;
    holding = on;
    const v = $('.tv-item video');
    if (v) { if (on) v.pause(); else { const p = v.play(); if (p && p.catch) p.catch(() => {}); } }
  }

  // ---------- desenho a cada consulta ----------
  function fillCall(box, cur) {
    box.classList.toggle('fresh', !!(cur && cur.fresh));
    box.querySelector('.tv-kicker').textContent = !cur ? 'Aguarde ser chamado(a)' : cur.fresh ? 'Chamando agora' : 'Última chamada';
    box.querySelector('.tv-ticket').textContent = cur ? cur.label : '—';
    box.querySelector('.tv-room').textContent = cur ? cur.sala : '';
    box.querySelector('.tv-pro').textContent = cur && cur.pro ? cur.pro : '';
  }
  function render(d) {
    if (built !== `${d.theme}|${d.layout}`) build(d);
    const cur = d.current;
    if (d.layout === 'midia') {
      const ov = $('.tv-overlay'); fillCall(ov, cur); ov.hidden = !(cur && cur.fresh);
      $('.tv-strip-k').textContent = cur ? (cur.fresh ? 'Chamando' : 'Última chamada') : 'Aguarde ser chamado(a)';
      $('.tv-strip-t').textContent = cur ? cur.label : '';
      $('.tv-strip-w').textContent = cur ? [cur.sala, cur.pro].filter(Boolean).join(' · ') : '';
      $('.tv-strip-prev').textContent = d.recent.length ? `Anteriores: ${d.recent.slice(0, 3).map((x) => `${x.label} ${x.sala}`.trim()).join(' · ')}` : '';
    } else {
      fillCall($('.tv-call'), cur);
      const ol = $('.tv-recent-list');
      ol.replaceChildren(...d.recent.slice(0, d.layout === 'chamadas' ? 6 : 3).map((x) => { const li = h('li'); li.append(h('b', '', x.label), h('span', '', [x.sala, x.pro].filter(Boolean).join(' · ')), h('small', '', x.at)); return li; }));
      $('.tv-recent').hidden = !d.recent.length;
    }
    const t = $('.tv-ticker-t'); t.textContent = d.ticker || ''; $('.tv-ticker').hidden = !d.ticker;
    hold(!!(cur && cur.fresh));
    setItems(d.items || []);
    if (cur && cur.id !== lastCall) { if (!first && cur.fresh) announce(cur, d.sound); lastCall = cur.id; }
    if (!cur) lastCall = null;
    first = false;
  }

  // Consulta o sistema a cada 2 s. Sem resposta em 10 s conta como falha; ao voltar a conexão
  // (ou quando o aparelho avisa que voltou a internet) a tela é remontada sem recarregar a página,
  // para não perder a tela cheia nem o som já liberados.
  let pollTimer = null; let offSince = 0;
  const hm = (t) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(t);
  function offline(show) {
    const off = $('.tv-offline'); if (!off) return;
    off.hidden = !show;
    if (show) off.textContent = `Sem conexão com o sistema desde ${hm(offSince)} — tentando de novo…`;
  }
  async function poll() {
    clearTimeout(pollTimer);
    const ac = window.AbortController ? new AbortController() : null;
    const to = ac ? setTimeout(() => ac.abort(), 10000) : null;
    try {
      const r = await fetch('/tv/estado', { cache: 'no-store', credentials: 'same-origin', signal: ac ? ac.signal : undefined });
      if (r.status === 401) { location.reload(); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (fails >= 3) { built = ''; sig = ''; } // voltou depois de cair: remonta tudo com o estado novo
      fails = 0; offSince = 0;
      if (d.state === 'pendente') { if (built !== 'pair' || $('.tv-pair-code').textContent.replace(' ', '') !== d.code) renderPair(d.code); }
      else if (d.state === 'ativa') {
        if (lastReload === undefined) lastReload = d.reloadAt; else if (d.reloadAt !== lastReload) { location.reload(); return; }
        render(d);
      }
      offline(false);
    } catch (e) {
      fails++;
      if (!offSince) offSince = new Date();
      if (fails >= 3) offline(true);
    } finally {
      clearTimeout(to);
      // sem conexão há muito tempo: tenta com menos frequência (até 15 s)
      pollTimer = setTimeout(poll, fails < 10 ? 2000 : Math.min(15000, 2000 + (fails - 10) * 1000));
    }
  }
  window.addEventListener('online', () => setTimeout(poll, 500));
  updateBtn(); wake();
  poll();
})();
