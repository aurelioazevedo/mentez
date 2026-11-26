// Sala de teleconsulta: vídeo ponto a ponto (WebRTC) com sinalização pelo servidor (SSE + POST).
// A profissional ("pro") inicia a chamada quando as duas pessoas estão na sala; o paciente ("pac") responde.
(() => {
  const root = document.querySelector('[data-tele]');
  if (!root) return;
  const cfg = JSON.parse(document.getElementById('tele-cfg').textContent);
  const $ = (s) => root.querySelector(s);
  const local = $('[data-local]'); const remote = $('[data-remote]'); const statusEl = $('[data-status]');
  const wait = $('[data-wait]'); const waitT = $('[data-wait-t]'); const joinBtn = $('[data-join]'); const bar = $('[data-bar]');
  const meter = $('[data-meter]'); const q = $('[data-quality]');
  let dc = null; const seen = new Set(); let admitTimer = null; let titleTimer = null; const title0 = document.title; let muted = false;
  let stream = null; let pc = null; let es = null; let pending = []; let screen = null; let ended = false; let joined = false; let statsTimer = null; let audioCtx = null;
  const setStatus = (t, cls = '') => { statusEl.textContent = t; statusEl.className = `tele-status ${cls}`; };
  const showWait = (t) => { if (t) waitT.textContent = t; wait.hidden = false; };
  // envio em ordem: a oferta sempre chega antes dos candidatos de rede (ICE) que dependem dela
  let chain = Promise.resolve();
  const send1 = (msg) => fetch(cfg.sigUrl, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }).catch(() => {});
  const post = (msg) => { chain = chain.then(() => send1(msg)); return chain; };
  let fails = 0;

  async function startMedia() {
    if (stream) return stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setStatus('Sem câmera: só áudio', 'warn'); } catch {
        setStatus('Câmera e microfone bloqueados', 'bad');
        showWait('Não foi possível acessar a câmera e o microfone. Toque no cadeado ao lado do endereço e permita câmera e microfone, depois recarregue a página.');
        throw e;
      }
    }
    local.srcObject = stream;
    levelMeter(stream);
    return stream;
  }
  function levelMeter(s) {
    if (!meter || !s.getAudioTracks().length) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = audioCtx.createAnalyser(); an.fftSize = 512; audioCtx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); meter.style.width = `${Math.min(100, m * 1.6)}%`; if (!ended) requestAnimationFrame(tick); };
      tick();
    } catch { /* sem medidor */ }
  }

  function newPc(keepPending = false) {
    if (pc) { try { pc.close(); } catch { /* ok */ } }
    if (!keepPending) pending = [];
    pc = new RTCPeerConnection({ iceServers: cfg.ice });
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
    // chat direto entre os aparelhos (não depende do servidor); quem liga cria o canal, quem atende recebe
    if (cfg.role === 'pro') useChannel(pc.createDataChannel('chat', { ordered: true }));
    else pc.ondatachannel = (e) => { if (e.channel.label === 'chat') useChannel(e.channel); };
    pc.onicecandidate = (e) => { if (e.candidate) post({ type: 'ice', candidate: e.candidate }); };
    pc.ontrack = (e) => { if (remote.srcObject !== e.streams[0]) { remote.srcObject = e.streams[0]; remote.play?.().catch(() => {}); } if (typeof aiRemoteConnect === 'function') aiRemoteConnect(); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { fails = 0; wait.hidden = true; setStatus('Em sessão', 'ok'); startStats(); clock?.start(); }
      else if (st === 'connecting') setStatus('Conectando…');
      else if (st === 'disconnected') setStatus('Conexão instável… tentando reconectar', 'warn');
      else if (st === 'failed') {
        fails++;
        setStatus('Não foi possível conectar', 'bad');
        if (cfg.role === 'pro' && fails <= 3) call(fails > 1); // 1ª: conexão nova; depois: reinício do ICE
        showWait(fails > 2
          ? (cfg.relay ? 'A conexão continua falhando. Tente outra rede (por exemplo, os dados móveis do celular) ou use o link alternativo combinado com a clínica.'
            : 'As redes de vocês bloqueiam a conexão direta. É preciso ligar o servidor de retransmissão (TURN) em Configurações → Teleconsulta. Enquanto isso, use o Google Meet nesta sessão.')
          : 'A conexão falhou. Tentando de novo…');
      }
    };
    return pc;
  }
  async function call(restart = false) {
    if (!pc || !restart) newPc();
    const offer = await pc.createOffer(restart ? { iceRestart: true } : {});
    await pc.setLocalDescription(offer);
    post({ type: 'offer', sdp: pc.localDescription });
  }
  async function onSignal(m) {
    if (m.type === 'hello') {
      if (m.peer) onPeer();
      else if (cfg.role === 'pac') showWait('Você está na sala de espera. A psicóloga já foi avisada e vai autorizar a sua entrada em instantes. Fique nesta página.');
      else if (m.waiting) showAdmit(m.waiting.name);
      else showWait('Aguardando o paciente entrar na sala…');
      setStatus(m.peer ? 'Conectando…' : cfg.role === 'pac' ? 'Na sala de espera' : m.waiting ? 'Paciente aguardando autorização' : 'Aguardando o paciente');
      return;
    }
    if (m.type === 'waiting') { if (cfg.role === 'pro') { showAdmit(m.name); setStatus('Paciente aguardando autorização', 'warn'); } return; }
    if (m.type === 'peer-joined') { onPeer(); return; }
    if (m.type === 'peer-left') { hideAdmit(); if (!ended) { setStatus(cfg.role === 'pac' ? 'A psicóloga saiu da sala' : 'O paciente saiu da sala', 'warn'); showWait(cfg.role === 'pac' ? 'A psicóloga saiu da sala. Aguarde aqui — se ela voltar, a chamada recomeça.' : 'O paciente saiu da sala. Se ele voltar, a chamada recomeça sozinha.'); remote.srcObject = null; } return; }
    if (m.type === 'replaced') { ended = true; es?.close(); showWait('Esta sala foi aberta em outra aba ou aparelho.'); return; }
    if (m.type === 'bye') { finish(cfg.role === 'pac' ? 'A psicóloga encerrou a sessão. Obrigado!' : 'O paciente saiu da sessão.'); return; }
    if (m.type === 'chat') { gotChat(m.text, m.mid); return; }
    if (m.type === 'state') { const bd = $('[data-recbadge]'); if (bd && cfg.role === 'pac') bd.hidden = m.state !== 'rec-on'; return; }
    if (m.type === 'offer') {
      if (!pc || pc.signalingState !== 'stable' || cfg.role === 'pac') newPc(true); // mantém candidatos que chegaram antes da oferta
      await pc.setRemoteDescription(m.sdp);
      for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      post({ type: 'answer', sdp: pc.localDescription });
      return;
    }
    if (m.type === 'answer' && pc) { await pc.setRemoteDescription(m.sdp).catch(() => {}); for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {}); return; }
    if (m.type === 'ice') { if (pc && pc.remoteDescription) await pc.addIceCandidate(m.candidate).catch(() => {}); else pending.push(m.candidate); }
  }
  function onPeer() { hideAdmit(); setStatus('Conectando…'); showWait(cfg.role === 'pac' ? 'Sua entrada foi autorizada. Conectando…' : 'Conectando…'); if (cfg.role === 'pro') { call(); if (typeof aiRec !== 'undefined' && aiRec) post({ type: 'state', state: 'rec-on' }); } }

  async function join() {
    joinBtn.disabled = true;
    try { audioCtx?.resume?.(); } catch { /* ok */ } // libera o som do alerta (precisa de um toque na página)
    try { await startMedia(); } catch { joinBtn.disabled = false; return; }
    if (cfg.role === 'test') { setStatus('Câmera e microfone funcionando ✓', 'ok'); waitT.textContent = 'Tudo certo! Se você vê sua imagem e a barrinha se mexe quando fala, está pronto(a) para a sessão.'; joinBtn.hidden = true; return; }
    joined = true; bar.hidden = false; joinBtn.hidden = true;
    es = new EventSource(cfg.sigUrl);
    let inbox = Promise.resolve(); // uma mensagem de cada vez, na ordem em que chegaram
    es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } inbox = inbox.then(() => onSignal(m)).catch(() => {}); };
    es.onerror = () => { if (!ended) setStatus('Reconectando ao servidor…', 'warn'); };
  }
  // ---------- sala de espera: a profissional autoriza a entrada (com alerta sonoro) ----------
  const admitEl = $('[data-admit]');
  function chime() {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.();
      const t0 = audioCtx.currentTime;
      [[880, 0], [1175, 0.18], [1568, 0.36]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.25, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.6);
        o.connect(g).connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.65);
      });
    } catch { /* sem som */ }
  }
  function showAdmit(name) {
    if (!admitEl || ended) return;
    admitEl.querySelector('[data-admit-name]').textContent = name || 'Paciente';
    if (admitEl.hidden) { admitEl.hidden = false; chime(); clearInterval(admitTimer); admitTimer = setInterval(chime, 12000); }
    showWait(`${name || 'O paciente'} está na sala de espera. Autorize a entrada para começar a chamada.`);
    clearInterval(titleTimer); let on = false; titleTimer = setInterval(() => { on = !on; document.title = on ? `🔔 ${name || 'Paciente'} aguardando` : title0; }, 1200);
  }
  function hideAdmit() { if (admitEl) admitEl.hidden = true; clearInterval(admitTimer); clearInterval(titleTimer); document.title = title0; }
  // “Já iniciar com a transcrição”: lembra a escolha neste aparelho
  const admitAi = admitEl?.querySelector('[data-admit-ai]');
  if (admitAi && !admitAi.disabled) { try { admitAi.checked = !!cfg.ai?.pref || localStorage.getItem('tele-admit-ai') === '1'; } catch { /* ok */ } admitAi.addEventListener('change', () => { try { localStorage.setItem('tele-admit-ai', admitAi.checked ? '1' : '0'); } catch { /* ok */ } }); }
  async function admit() {
    const b = admitEl.querySelector('[data-admit-ok]'); b.disabled = true;
    try { await fetch(cfg.sigUrl, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'admit' }) }); } finally { b.disabled = false; }
    const withAi = !!(admitAi && !admitAi.disabled && admitAi.checked);
    onPeer();
    if (withAi && !aiRec) aiBegin(); // a voz do paciente entra na gravação assim que o vídeo dele chegar
  }
  function finish(text) {
    hideAdmit();
    if (typeof aiRec !== 'undefined' && aiRec) aiStop();
    ended = true; clearInterval(statsTimer);
    try { pc?.close(); } catch { /* ok */ }
    es?.close(); stream?.getTracks().forEach((t) => t.stop()); screen?.getTracks().forEach((t) => t.stop());
    remote.srcObject = null; local.srcObject = null; bar.hidden = true;
    setStatus('Sessão encerrada'); showWait(text); joinBtn.hidden = true;
  }
  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc) return;
      const st = await pc.getStats(); let rtt = null; let lost = 0; let recv = 0;
      st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000; if (r.type === 'inbound-rtp' && r.kind === 'video') { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; } });
      const loss = recv ? lost / (lost + recv) : 0;
      const lvl = rtt == null ? '' : rtt < 150 && loss < 0.02 ? 'boa' : rtt < 400 && loss < 0.08 ? 'média' : 'fraca';
      q.textContent = lvl ? `Conexão ${lvl}` : ''; q.dataset.lvl = lvl;
    }, 3000);
  }
  // controles
  const toggle = (btn, kind) => {
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    const on = !tracks[0]?.enabled; tracks.forEach((t) => { t.enabled = on; });
    btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.classList.toggle('off', !on);
  };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-join]')) join();
    else if (b.matches('[data-admit-ok]')) admit();
    else if (b.matches('[data-admit-mute]')) { muted = !muted; b.setAttribute('aria-pressed', muted ? 'true' : 'false'); b.classList.toggle('off', muted); b.title = muted ? 'Ativar o alerta sonoro' : 'Silenciar o alerta'; }
    else if (b.matches('[data-emoji-toggle]')) { const g = $('[data-emojis]'); g.hidden = !g.hidden; b.setAttribute('aria-expanded', g.hidden ? 'false' : 'true'); }
    else if (b.matches('[data-emoji]')) { const i = $('[data-chat-form] input'); const st = i.selectionStart ?? i.value.length; const en = i.selectionEnd ?? st; const e2 = b.dataset.emoji; i.value = i.value.slice(0, st) + e2 + i.value.slice(en); i.focus(); i.setSelectionRange(st + e2.length, st + e2.length); }
    else if (b.matches('[data-mic]')) toggle(b, 'audio');
    else if (b.matches('[data-cam]')) toggle(b, 'video');
    else if (b.matches('[data-full]')) { const el = root.querySelector('.tele-stage'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.().catch(() => {}); }
    else if (b.matches('[data-chat-toggle]')) { const c = $('[data-chat]'); c.hidden = !c.hidden; b.classList.remove('dot'); if (!c.hidden) c.querySelector('input').focus(); }
    else if (b.matches('[data-screen]')) {
      const sender = pc?.getSenders().find((s) => s.track?.kind === 'video'); if (!sender) return;
      if (screen) { screen.getTracks().forEach((t) => t.stop()); screen = null; await sender.replaceTrack(stream.getVideoTracks()[0]); b.classList.remove('on'); local.srcObject = stream; return; }
      try { screen = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return; }
      const t = screen.getVideoTracks()[0]; await sender.replaceTrack(t); b.classList.add('on'); local.srcObject = screen;
      t.onended = async () => { screen = null; await sender.replaceTrack(stream.getVideoTracks()[0]); b.classList.remove('on'); local.srcObject = stream; };
    } else if (b.matches('[data-end]')) {
      if (cfg.role === 'pro' && !confirm('Encerrar a sessão para os dois?')) return;
      await post({ type: 'bye' });
      // profissional: encerra a gravação (o áudio vai para a transcrição) e segue para a tela da sessão, que finaliza e pergunta o pagamento
      const stopping = cfg.role === 'pro' && typeof aiRec !== 'undefined' && aiRec ? aiStop() : null;
      finish(cfg.role === 'pro' ? (cfg.after ? 'Sessão encerrada. Abrindo a tela da sessão…' : 'Sessão encerrada. Você pode voltar à agenda e registrar a evolução.') : 'Você saiu da sessão. Para voltar, abra o link de novo.');
      if (cfg.role === 'pro' && cfg.after) { if (stopping) await stopping.catch(() => {}); location.href = cfg.after; }
    }
  });
  // mensagens (para quando o áudio falha): direto pelo canal de dados; sem ele, pelo servidor
  const onlyEmoji = (t) => /^(\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u.test(t) && [...t.replace(/\s/g, '')].length <= 6;
  function addMsg(text, mine) {
    const box = $('[data-msgs]'); const p = document.createElement('p'); p.className = `${mine ? 'me' : 'them'}${onlyEmoji(text) ? ' emo' : ''}`; p.textContent = text; box.appendChild(p); box.scrollTop = box.scrollHeight;
    if (!mine && $('[data-chat]').hidden) root.querySelector('[data-chat-toggle]')?.classList.add('dot');
  }
  function gotChat(text, mid) { if (mid) { if (seen.has(mid)) return; seen.add(mid); } addMsg(String(text || '').slice(0, 1000), false); }
  function useChannel(ch) {
    dc = ch;
    ch.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'chat') gotChat(m.text, m.mid); } catch { /* ignora */ } };
  }
  $('[data-chat-form]')?.addEventListener('submit', (e) => {
    e.preventDefault(); const i = e.target.m; const t = i.value.trim(); if (!t) return;
    const msg = { type: 'chat', text: t, mid: Math.random().toString(36).slice(2, 12) };
    let sent = false;
    if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(msg)); sent = true; } catch { /* usa o servidor */ } }
    if (!sent) post(msg);
    addMsg(t, true); i.value = ''; $('[data-emojis]').hidden = true; i.focus();
  });
  // ---------- transcrição com IA (só a profissional): mistura a voz dos dois e envia para a “IA na sessão” ----------
  const ai = cfg.ai; const aiBtn = $('[data-ai]'); const aiMsg = $('[data-ai-msg]'); const badge = $('[data-recbadge]');
  let aiRec = null; let aiId = null; let aiSeq = 0; const aiQueue = []; let aiSending = false; let aiStart = 0; let aiCtx = null; let aiDest = null; let aiRemote = null; let aiTimer = null;
  const aiSay = (t, html) => { if (!aiMsg) return; aiMsg.hidden = !t; if (html) aiMsg.innerHTML = html; else aiMsg.textContent = t || ''; };
  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  async function aiPost(url, body, raw) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: raw ? { 'Content-Type': 'application/octet-stream', Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: raw ? body : JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) { const e = new Error(d.error || `erro ${r.status}`); e.status = r.status; e.limit = d.limit; throw e; }
    return d;
  }
  async function aiPump() {
    if (aiSending) return; aiSending = true;
    while (aiQueue.length) {
      const [n, blob] = aiQueue[0];
      try { await aiPost(`/sessao-ia/${aiId}/parte?seq=${n}`, blob, true); aiQueue.shift(); }
      catch (e) { if (e.limit) { aiQueue.length = 0; aiSay(e.message); aiStop(); break; } if (e.status && e.status < 500) { aiQueue.length = 0; aiSay(`Erro ao enviar o áudio: ${e.message}`); break; } await new Promise((r) => setTimeout(r, 3000)); }
    }
    aiSending = false;
  }
  function aiRemoteConnect() {
    const rs = remote.srcObject;
    if (!aiCtx || !rs || !rs.getAudioTracks().length || aiRemote?.ms === rs) return;
    try { aiRemote?.node.disconnect(); } catch { /* ok */ }
    const node = aiCtx.createMediaStreamSource(rs); node.connect(aiDest); aiRemote = { node, ms: rs };
  }
  const label = (t) => { const l = aiBtn?.querySelector('[data-ai-label]'); if (l) l.textContent = t; };
  // Paciente sem autorização: assinou em papel (libera e grava), enviar o termo (WhatsApp + e-mail) ou seguir sem gravar
  const askEl = $('[data-ai-ask]');
  askEl?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ai-consent]'); if (!b) return;
    const act = b.dataset.aiConsent;
    if (act === 'sem') { askEl.hidden = true; aiSay('Sessão sem gravação.'); return; }
    if (act === 'papel' && !confirm('Confirma que o paciente assinou em papel a autorização de gravação e uso de IA? Guarde o documento assinado.')) return;
    askEl.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const d = await aiPost(`/sessao-ia/autorizacao/${ai.pid}`, { acao: act });
      askEl.hidden = true;
      if (act === 'papel') {
        ai.state = 'ok'; aiBtn?.classList.remove('na');
        if (admitAi) { admitAi.disabled = false; admitAi.checked = true; admitAi.closest('label')?.classList.remove('na'); }
        aiSay('Autorização em papel registrada.');
        if (pc && pc.connectionState === 'connected' && !aiRec) aiBegin();
      } else aiSay(d.message || 'Termo enviado.');
    } catch (err) { aiSay(`Não foi possível: ${err.message}`); }
    askEl.querySelectorAll('button').forEach((x) => { x.disabled = false; });
  });
  async function aiBegin() {
    if (ai.state === 'sem-autorizacao' && askEl) { askEl.hidden = false; return; }
    if (ai.state !== 'ok') { aiSay('', `${ai.reason} ${ai.state === 'sem-autorizacao' ? `<a href="${ai.termos}" target="_blank" rel="noopener">Enviar o termo</a>` : ''}`); return; }
    if (!stream || !window.MediaRecorder) { aiSay('Este navegador não grava áudio. Use o Chrome, o Edge ou o Safari atualizado.'); return; }
    const mime = pickMime();
    try {
      const d = await aiPost('/sessao-ia/iniciar', { pid: ai.pid, appt: ai.appt, source: 'teleconsulta', mime });
      aiId = d.id; aiSeq = 0;
      aiCtx = new (window.AudioContext || window.webkitAudioContext)(); aiDest = aiCtx.createMediaStreamDestination();
      if (stream.getAudioTracks().length) aiCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(aiDest);
      aiRemoteConnect();
      aiRec = new MediaRecorder(aiDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 });
      aiRec.ondataavailable = (e) => { if (e.data && e.data.size) { aiQueue.push([aiSeq++, e.data]); aiPump(); } };
      aiRec.start(10000); aiStart = Date.now();
      aiBtn.classList.add('on'); badge.hidden = false; aiSay('');
      aiTimer = setInterval(() => { const s = Math.floor((Date.now() - aiStart) / 1000); label(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`); if (ai.maxMin && s / 60 >= ai.maxMin) aiStop(); }, 1000);
      post({ type: 'state', state: 'rec-on' });
    } catch (e) { aiSay(`Não foi possível iniciar a transcrição: ${e.message}`); }
  }
  async function aiStop() {
    if (!aiRec) return;
    const r = aiRec; aiRec = null; clearInterval(aiTimer); aiBtn?.classList.remove('on'); badge.hidden = true; label('Transcrever');
    post({ type: 'state', state: 'rec-off' });
    await new Promise((res) => { r.onstop = res; try { r.stop(); } catch { res(); } });
    aiSay('Enviando o áudio para a transcrição…');
    const until = Date.now() + 5 * 60e3;
    while ((aiQueue.length || aiSending) && Date.now() < until) { if (!aiSending) aiPump(); await new Promise((res) => setTimeout(res, 400)); }
    try { aiCtx?.close(); } catch { /* ok */ } aiCtx = null; aiRemote = null;
    try {
      await aiPost(`/sessao-ia/${aiId}/encerrar`, { duration: Math.round((Date.now() - aiStart) / 1000) });
      aiSay('', `✓ Áudio enviado. A transcrição e o rascunho da evolução aparecem no prontuário em alguns minutos. <a href="${ai.prontuario}" target="_blank" rel="noopener">Abrir o prontuário</a>`);
    } catch (e) { aiSay(`Não foi possível concluir a transcrição: ${e.message}`); }
  }
  aiBtn?.addEventListener('click', () => (aiRec ? aiStop() : aiBegin()));
  window.addEventListener('beforeunload', (e) => { if (aiRec) { e.preventDefault(); e.returnValue = ''; } });
  // mostra a prévia da câmera antes de entrar (exceto quando a sala está fechada)
  if (joinBtn) startMedia().catch(() => {});
  // ---------- relógio e cronômetro (só para a profissional) ----------
  // O cronômetro começa quando a chamada conecta e continua se a página for recarregada; clique pausa/continua.
  const clock = (() => {
    const box = $('[data-clock]'); const T = cfg.timer;
    if (!box || !T) return null;
    const nowEl = box.querySelector('[data-clock-now]'); const tEl = box.querySelector('[data-clock-timer]'); const leftEl = box.querySelector('[data-clock-left]');
    const KEY = `tele-timer-${T.appt}`;
    let st = null; try { st = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* sem armazenamento */ }
    if (st && Date.now() - (st.at || 0) > 12 * 3600e3) st = null; // de outro dia
    const save = () => { try { if (st) localStorage.setItem(KEY, JSON.stringify({ ...st, at: Date.now() })); else localStorage.removeItem(KEY); } catch { /* ok */ } };
    const elapsed = () => (st ? st.acc + (st.run ? Date.now() - st.run : 0) : 0);
    const two = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); return `${h ? `${h}:` : ''}${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`; };
    const hm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const end = new Date(new Date(`${T.start}-03:00`).getTime() + T.min * 60e3);
    function paint() {
      const now = new Date();
      nowEl.textContent = hm(now);
      tEl.textContent = fmt(elapsed());
      tEl.classList.toggle('paused', !!st && !st.run); tEl.classList.toggle('idle', !st);
      tEl.title = !st ? 'O cronômetro começa quando o paciente entrar (ou clique para iniciar agora)' : st.run ? 'Tempo de sessão — clique para pausar' : 'Pausado — clique para continuar';
      const left = Math.round((end - now) / 60e3);
      leftEl.textContent = left > 0 ? `termina ${hm(end)} · faltam ${left} min` : left === 0 ? `termina ${hm(end)} · agora` : `termina ${hm(end)} · passou ${-left} min`;
      leftEl.className = `tc-left ${left < 0 ? 'over' : left <= 5 ? 'soon' : ''}`;
    }
    tEl.addEventListener('click', () => {
      if (!st) st = { acc: 0, run: Date.now() };
      else if (st.run) { st.acc += Date.now() - st.run; st.run = 0; } else st.run = Date.now();
      save(); paint();
    });
    box.querySelector('[data-clock-reset]').addEventListener('click', () => { if (!st || confirm('Zerar o cronômetro da sessão?')) { st = null; save(); paint(); } });
    paint(); setInterval(paint, 1000);
    return { start() { if (!st) { st = { acc: 0, run: Date.now() }; save(); paint(); } }, get value() { return elapsed(); }, get state() { return st; } };
  })();
  // ---------- layout dos vídeos: destaque (o outro grande), lado a lado, ou eu em destaque; tamanho do vídeo pequeno ----------
  // Clique no vídeo pequeno troca os dois de lugar. A escolha fica guardada neste aparelho (separada para profissional e paciente).
  const lay = (() => {
    const KEY = `tele-layout-${cfg.role}`; const get = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
    let st = { mode: 'foco', main: 'remote', pip: 'p', ...get() };
    const lbl = $('[data-layout-label]'); const sizeBtn = $('[data-pipsize]');
    const NAMES = { foco: 'Destaque', lado: 'Lado a lado' };
    function apply() {
      root.dataset.lay = st.mode; root.dataset.main = st.main; root.dataset.pip = st.pip;
      if (lbl) lbl.textContent = NAMES[st.mode] || 'Destaque';
      if (sizeBtn) { sizeBtn.textContent = st.pip.toUpperCase(); sizeBtn.hidden = st.mode === 'lado'; }
      try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* sem armazenamento */ }
    }
    const pipOf = () => (st.main === 'remote' ? local : remote);
    [local, remote].forEach((v) => v.addEventListener('click', () => {
      if (st.mode === 'lado') { st.mode = 'foco'; st.main = v === local ? 'local' : 'remote'; }
      else if (v === pipOf()) st.main = st.main === 'remote' ? 'local' : 'remote';
      apply();
    }));
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-layout]')) { st.mode = st.mode === 'foco' ? 'lado' : 'foco'; apply(); }
      else if (e.target.closest('[data-pipsize]')) { st.pip = { p: 'm', m: 'g', g: 'p' }[st.pip] || 'p'; apply(); }
    });
    apply();
    return { get state() { return st; } };
  })();

  // ---------- paciente: anel com o andamento da sessão e o horário de término (sem cronômetro) ----------
  (() => {
    const box = $('[data-pclock]'); const T = cfg.timer; if (!box || !T) return;
    const ring = box.querySelector('[data-pclock-ring]'); const tEl = box.querySelector('[data-pclock-t]'); const sEl = box.querySelector('[data-pclock-s]');
    const C = 2 * Math.PI * 15; ring.style.strokeDasharray = `${C}`;
    const start = new Date(`${T.start}-03:00`).getTime(); const end = start + T.min * 60e3;
    const hm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    function paint() {
      const now = Date.now(); const p = Math.min(1, Math.max(0, (now - start) / (end - start)));
      ring.style.strokeDashoffset = `${C * (1 - p)}`;
      const left = Math.ceil((end - now) / 60e3);
      tEl.textContent = now < start ? `Começa às ${hm(start)}` : `Sessão até ${hm(end)}`;
      sEl.textContent = now < start ? `${hm(start)} – ${hm(end)}` : left > 5 ? 'Sessão em andamento' : left > 0 ? 'Últimos minutos' : 'Horário encerrado';
      box.classList.toggle('soon', left <= 5 && left > 0); box.classList.toggle('over', left <= 0);
    }
    paint(); setInterval(paint, 15e3);
  })();

  // ---------- profissional: barra de andamento e avisos discretos aos 10 e aos 5 minutos do fim ----------
  (() => {
    const bar2 = $('[data-prog]'); const warn = $('[data-clock-warn]'); const T = cfg.timer; if (!bar2 || !T) return;
    const fill = bar2.querySelector('i'); const start = new Date(`${T.start}-03:00`).getTime(); const end = start + T.min * 60e3;
    const shown = new Set(); let hideT = null;
    const say = (t, cls) => { warn.textContent = t; warn.className = `tele-warn ${cls || ''}`; warn.hidden = false; clearTimeout(hideT); hideT = setTimeout(() => { warn.hidden = true; }, 12e3); };
    function paint() {
      const now = Date.now(); const p = Math.min(1, Math.max(0, (now - start) / (end - start))); const left = Math.ceil((end - now) / 60e3);
      fill.style.width = `${(p * 100).toFixed(1)}%`;
      bar2.className = `tele-prog ${left <= 0 ? 'over' : left <= 5 ? 'soon' : left <= 10 ? 'near' : ''}`;
      if (!joined) return;
      for (const m of [10, 5]) if (left === m && !shown.has(m)) { shown.add(m); say(`Faltam ${m} minutos para o fim da sessão`, m === 5 ? 'soon' : 'near'); }
      if (left === 0 && !shown.has(0)) { shown.add(0); say('Horário da sessão encerrado', 'over'); }
    }
    paint(); setInterval(paint, 5e3);
  })();
  root.dataset.ready = '1';
  window.__tele = { clock, lay, get pc() { return pc; }, get joined() { return joined; }, get dc() { return dc?.readyState || null; } };
})();
