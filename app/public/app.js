// Interações leves do sistema (sem dependências).
document.addEventListener('click', (e) => {
  const t = e.target;
  // linhas de tabela clicáveis
  const tr = t.closest('tr[data-href]');
  if (tr && !t.closest('a,button,form,input,select')) { location.href = tr.dataset.href; return; }
  if (t.closest('[data-print]')) { e.preventDefault(); window.print(); return; }
  // copiar um texto direto (sem campo na página): data-copy-text="..."
  const ct = t.closest('[data-copy-text]');
  if (ct) {
    e.preventDefault();
    const txt = ct.dataset.copyText; const orig = ct.dataset.label || ct.textContent;
    ct.dataset.label = orig;
    const done = () => { ct.classList.add('copied'); ct.textContent = 'Copiado ✓'; setTimeout(() => { ct.textContent = orig; ct.classList.remove('copied'); }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => {});
    else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
    return;
  }
  const cp = t.closest('[data-copy]');
  if (cp) {
    const inp = document.querySelector(cp.dataset.copy);
    inp.select();
    (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.resolve(document.execCommand('copy')))
      .then(() => { cp.textContent = 'Copiado!'; setTimeout(() => { cp.textContent = 'Copiar'; }, 1800); });
    return;
  }
  const add = t.closest('.add-row');
  if (add) {
    const box = add.previousElementSibling;
    const cards = box.querySelectorAll('.row-card');
    if (cards.length >= Number(add.dataset.max || 31)) return;
    const clone = cards[cards.length - 1].cloneNode(true);
    const i = cards.length;
    clone.querySelector('.row-n').textContent = i + 1;
    clone.querySelectorAll('input,textarea').forEach((el) => {
      el.name = el.name.replace(/\]\[\d+\]\[/, `][${i}][`);
      el.value = '';
    });
    box.appendChild(clone);
    clone.querySelector('input,textarea').focus();
  }
});

// ---------- Confirmação no visual do sistema ----------
// Exige marcar a caixa “Confirmo…” antes do botão: Enter sozinho nunca confirma (evita envios e exclusões por engano).
function askConfirm(message, opts = {}) {
  if (navigator.webdriver && !window.__lmRealConfirm) return Promise.resolve(window.confirm(message)); // testes automatizados
  return new Promise((resolve) => {
    const isSend = /enviar|whatsapp|cobran|lembrete/i.test(message);
    const isDel = /exclu|apagar|cancelar|arquivar|remover|desconectar|restaurar|desfazer|faltou|falta/i.test(message);
    const checkText = opts.check || (isSend ? 'Confirmo o envio' : isDel ? 'Confirmo, quero continuar' : 'Confirmo');
    const okText = opts.ok || (isSend ? 'Enviar' : 'Confirmar');
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const dlg = document.createElement('div'); dlg.className = 'app-modal'; dlg.setAttribute('role', 'alertdialog'); dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `<div class="app-modal-box cf-box ${isDel && !isSend ? 'cf-danger' : ''}"><h2>${isSend ? 'Confirmar envio' : 'Confirmar'}</h2>
      <p class="cf-msg">${esc(message)}</p>
      <label class="cf-check"><input type="checkbox" data-cf-check> <span>${esc(checkText)}</span></label>
      <div class="actions"><button type="button" class="btn ${isDel && !isSend ? 'danger' : ''}" data-cf-ok disabled>${esc(okText)}</button><button type="button" class="btn ghost" data-cf-cancel>Cancelar</button></div></div>`;
    document.body.appendChild(dlg); document.documentElement.dataset.uiBusy = 'modal';
    const ok = dlg.querySelector('[data-cf-ok]'); const chk = dlg.querySelector('[data-cf-check]');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !(e.target instanceof Element && e.target.matches('[data-cf-cancel]'))) { e.preventDefault(); e.stopPropagation(); } // Enter não confirma
    };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); dlg.remove(); delete document.documentElement.dataset.uiBusy; resolve(v); };
    document.addEventListener('keydown', onKey, true);
    chk.addEventListener('change', () => { ok.disabled = !chk.checked; });
    ok.addEventListener('click', () => { if (chk.checked) done(true); });
    dlg.querySelector('[data-cf-cancel]').addEventListener('click', () => done(false));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(false); });
    dlg.querySelector('[data-cf-cancel]').focus();
  });
}

const nativeConfirm = () => navigator.webdriver && !window.__lmRealConfirm; // testes automatizados: confirmação nativa e síncrona
document.addEventListener('submit', (e) => {
  const f = e.target;
  const msg = f.dataset.confirm || (e.submitter && e.submitter.dataset && e.submitter.dataset.confirm) || ''; // no formulário ou só num botão
  if (msg && nativeConfirm()) { if (!window.confirm(msg)) { e.preventDefault(); return; } }
  else if (msg && !f.__lmOk) {
    e.preventDefault();
    const sub = e.submitter;
    askConfirm(msg).then((yes) => { if (yes) { f.__lmOk = true; if (f.requestSubmit) f.requestSubmit(sub && sub.form === f ? sub : undefined); else f.submit(); f.__lmOk = false; } });
    return;
  }
  if (e.defaultPrevented) return; // formulário tratado pela própria tela (ex.: chat da teleconsulta): não trava o botão
  const b = f.querySelector('button[type=submit],button:not([type])');
  if (b) setTimeout(() => { b.disabled = true; }, 0);
});

// ---------- Comportamentos de cada tela ----------
// Roda ao carregar a página e de novo depois de cada atualização ao vivo (o conteúdo central é trocado).
function initPage() {
  // Modalidade padrão do paciente ao agendar
  const sel = document.querySelector('select[name=patient_id]');
  const mod = document.querySelector('select[name=modality]');
  if (sel && mod && location.pathname === '/agenda/nova') {
    const sync = () => { const m = sel.selectedOptions[0]?.dataset.mod; if (m === 'online' || m === 'presencial') mod.value = m; };
    sel.addEventListener('change', sync); sync();
  }

  // Lista de espera: escolher o paciente recarrega o formulário (traz as sessões que ele pode antecipar)
  const wlSel = document.querySelector('select[data-wl-patient]');
  if (wlSel) {
    const box = document.querySelector('[data-wl-new]');
    wlSel.addEventListener('change', () => {
      if (box) box.hidden = !!wlSel.value;
      const cur = new URLSearchParams(location.search).get('paciente') || '';
      if (wlSel.value && wlSel.value !== cur) location.href = `/agenda/lista-espera?paciente=${encodeURIComponent(wlSel.value)}#nova`;
    });
  }

  // Campanhas da TV: formato (texto/imagem/vídeo) e envio do arquivo com prévia
  const tvc = document.querySelector('form[data-tvc-form]');
  if (tvc) {
    const box = tvc.querySelector('[data-tvc-upload]');
    const sync = () => { const f = tvc.querySelector('[data-tvc-format]:checked')?.value; if (box) box.hidden = f === 'texto'; };
    tvc.querySelectorAll('[data-tvc-format]').forEach((r) => r.addEventListener('change', sync)); sync();
    const file = tvc.querySelector('[data-tvc-file]'); const msg = tvc.querySelector('[data-tvc-msg]'); const prev = tvc.querySelector('[data-tvc-preview]');
    if (file) file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      const video = /^video\//.test(f.type);
      if (f.size > (video ? 40 : 5) * 1024 * 1024) { msg.textContent = video ? 'O vídeo passa de 40 MB.' : 'A imagem passa de 5 MB.'; file.value = ''; return; }
      msg.textContent = `Enviando “${f.name}”…`;
      try {
        const r = await fetch('/configuracoes/tv/arquivo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
        tvc.querySelector('[name=media_id]').value = d.id;
        const radio = tvc.querySelector(`[data-tvc-format][value="${d.kind}"]`); if (radio) { radio.checked = true; sync(); }
        const el = document.createElement(d.kind === 'video' ? 'video' : 'img');
        el.src = d.url; if (d.kind === 'video') { el.muted = true; el.controls = true; el.playsInline = true; } else el.alt = 'Prévia';
        prev.replaceChildren(el);
        msg.textContent = 'Arquivo enviado. Salve a campanha para publicar.';
      } catch (e) { msg.textContent = `Não foi possível enviar: ${e.message}`; file.value = ''; }
    });
  }

  // Documento psicológico: finalidade/solicitante entram no texto enquanto digita
  const psyForm = document.querySelector('form.psy-form');
  if (psyForm) {
    const ta = psyForm.querySelector('textarea[name=body]');
    psyForm.querySelectorAll('[data-psy-field]').forEach((inp) => {
      let last = inp.value.trim() || inp.dataset.psyField;
      inp.addEventListener('input', () => {
        const now = inp.value.trim() || inp.dataset.psyField;
        if (ta && last && ta.value.includes(last)) ta.value = ta.value.split(last).join(now);
        last = now;
      });
    });
    // Escrever com IA
    const ai = document.querySelector('[data-psy-ai]');
    const go = ai && ai.querySelector('[data-ai-go]');
    if (go) go.addEventListener('click', async () => {
      const msg = ai.querySelector('[data-ai-msg]'); const notes = ai.querySelector('[data-ai-notes]').value.trim();
      if (!notes) { msg.textContent = 'Escreva primeiro o que o documento deve conter.'; return; }
      if (ta.value.trim() && ta.dataset.aiDone && !window.confirm('Substituir o texto atual pelo novo texto da IA?')) return;
      go.disabled = true; msg.textContent = 'Escrevendo… (pode levar alguns segundos)';
      try {
        const r = await fetch('/documentos/ia', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          pid: ai.dataset.pid, kind: ai.dataset.kind, notes, records: !!(ai.querySelector('[data-ai-records]') || {}).checked,
          appt: (psyForm.querySelector('[name=appt]') || {}).value || null, purpose: psyForm.querySelector('[name=purpose]').value, requester: psyForm.querySelector('[name=requester]').value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
        ta.value = d.body; ta.dataset.aiDone = '1';
        msg.textContent = 'Texto gerado. Revise, complete o que estiver entre [colchetes] e só então emita.';
        ta.focus();
      } catch (e) { msg.textContent = `Não foi possível gerar: ${e.message}`; } finally { go.disabled = false; }
    });
  }

  // Documento psicológico: trocar a sessão de referência refaz o texto (declaração)
  document.querySelectorAll('select[data-autosubmit-new]').forEach((sel) => sel.addEventListener('change', () => {
    const u = new URL(location.href); u.searchParams.set('sessao', sel.value); location.href = u.toString();
  }));

  // Aviso de alterações não salvas no portal do paciente
  const pf = document.querySelector('form.portal-form');
  if (pf) {
    let dirty = false;
    pf.addEventListener('input', () => { dirty = true; pf.dataset.dirty = '1'; });
    pf.addEventListener('submit', () => { dirty = false; delete pf.dataset.dirty; });
    if (!window.__pfUnload) { window.__pfUnload = true; window.addEventListener('beforeunload', (e) => { if (document.querySelector('form.portal-form')?.dataset.dirty) { e.preventDefault(); e.returnValue = ''; } }); }
  }

  // ---------- Escala ----------
  const escForm = document.querySelector('form.esc-week');
  if (escForm) {
    const sync = () => escForm.querySelectorAll('.esc-day').forEach((box) => {
      const on = box.querySelector('input[type=checkbox]').checked;
      box.classList.toggle('on', on);
      box.querySelector('em').textContent = on ? 'Atende' : 'Folga';
    });
    escForm.addEventListener('change', sync);
    escForm.querySelectorAll('[data-days]').forEach((btn) => btn.addEventListener('click', () => {
      const days = btn.dataset.days === '' ? [] : btn.dataset.days.split(',');
      for (let i = 0; i < 7; i++) escForm.querySelector(`[name=day_${i}]`).checked = days.includes(String(i));
      escForm.querySelectorAll('.esc-only .chip').forEach((c) => c.classList.toggle('on', c === btn && days.length === 1));
      sync();
    }));
    escForm.querySelectorAll('[data-confirm-btn]').forEach((b) => b.addEventListener('click', (e) => {
      if (nativeConfirm()) { if (!window.confirm(b.dataset.confirmBtn)) e.preventDefault(); return; }
      if (b.__lmOk) { b.__lmOk = false; return; }
      e.preventDefault();
      askConfirm(b.dataset.confirmBtn).then((yes) => { if (yes) { b.__lmOk = true; b.click(); } });
    }));
  }
  document.querySelectorAll('select[data-autosubmit], input[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // Resumo da escala do(a) profissional ao escolher o paciente
  const hint = document.getElementById('esc-hint');
  const psel = document.querySelector('select[name=patient_id]');
  if (hint && psel && hint.dataset.map) {
    let map = {};
    try { map = JSON.parse(hint.dataset.map); } catch { /* ignore */ }
    const show = () => { const o = psel.selectedOptions[0]?.dataset.owner; const t = o && map[o]; hint.hidden = !t; if (t) hint.textContent = t; };
    if (Object.keys(map).length) { psel.addEventListener('change', show); show(); }
  }

  // ---------- Avisos ao agendar (push / WhatsApp) ----------
  const nbox = document.getElementById('notify');
  if (nbox && psel) {
    let pros = {};
    try { pros = JSON.parse(nbox.dataset.pros || '{}'); } catch { /* ignore */ }
    const waOn = nbox.dataset.wa === '1';
    const fmt = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : p; };
    const set = (name, ok, msg) => {
      const cb = nbox.querySelector(`[name=${name}]`);
      cb.disabled = !ok; if (!ok) cb.checked = false;
      cb.closest('.nt').classList.toggle('disabled', !ok);
      return cb;
    };
    const upd = (first) => {
      const o = psel.selectedOptions[0]; const phone = o?.dataset.phone; const optin = o?.dataset.optin === '1';
      const pro = pros[o?.dataset.owner] || null;
      const pOk = waOn && !!o?.value && !!phone && optin;
      const cbP = set('n_wa_patient', pOk);
      nbox.querySelector('[data-for=patient]').textContent = phone ? fmt(phone) : '';
      nbox.querySelector('[data-msg=patient]').textContent = !waOn ? 'WhatsApp não configurado (Usuários → WhatsApp)' : !o?.value ? 'Escolha o paciente' : !phone ? 'Paciente sem telefone cadastrado' : !optin ? 'Paciente não autorizou mensagens pelo WhatsApp' : `Envia a confirmação do agendamento para ${fmt(phone)}`;
      const prOk = waOn && !!pro?.phone;
      const cbR = set('n_wa_pro', prOk);
      nbox.querySelector('[data-msg=pro]').textContent = !waOn ? 'WhatsApp não configurado' : !pro ? 'Escolha o paciente' : !pro.phone ? `${pro.name} não tem WhatsApp cadastrado (Usuários)` : `Envia o aviso para ${pro.name} · ${fmt(pro.phone)}`;
      if (first || pOk) cbP.checked = pOk;
      if (first || prOk) cbR.checked = prOk;
    };
    psel.addEventListener('change', () => upd(false)); upd(true);
  }

  // ---------- Notificações push (Conta) ----------
  const pushBox = document.getElementById('push');
  if (pushBox) {
    const st = pushBox.querySelector('[data-push-status]');
    const bOn = pushBox.querySelector('[data-push-on]'), bOff = pushBox.querySelector('[data-push-off]'), bTest = pushBox.querySelector('[data-push-test]');
    const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
    const device = () => { const u = navigator.userAgent; const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Computador'; const b = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Navegador'; return `${os} · ${b}`; };
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' }).then((r) => r.json());
    const show = (text, on) => { st.textContent = text; bOn.hidden = on !== false; bOff.hidden = !on; bTest.hidden = !on; };
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        st.textContent = /iPhone|iPad/.test(navigator.userAgent) ? 'Para receber notificações no iPhone, adicione o sistema à Tela de Início (veja abaixo) e abra pelo ícone.' : 'Este navegador não suporta notificações push.';
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const cur = await reg.pushManager.getSubscription();
      if (Notification.permission === 'denied') return show('As notificações estão bloqueadas nas configurações do navegador para este site.', null);
      if (cur) show('✓ Notificações ativadas neste aparelho.', true); else show('Notificações desativadas neste aparelho.', false);
      bOn.addEventListener('click', async () => {
        bOn.disabled = true;
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { show('Permissão negada. Libere as notificações nas configurações do navegador.', null); return; }
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(pushBox.dataset.vapid) });
          const r = await post('/conta/push/inscrever', { subscription: sub.toJSON(), device: device() });
          if (!r.ok) throw new Error(r.error || 'falha');
          show('✓ Notificações ativadas neste aparelho.', true);
        } catch (e) { st.textContent = `Não foi possível ativar: ${e.message}`; } finally { bOn.disabled = false; }
      });
      bOff.addEventListener('click', async () => {
        const s = await reg.pushManager.getSubscription();
        if (s) { await post('/conta/push/cancelar', { endpoint: s.endpoint }); await s.unsubscribe(); }
        show('Notificações desativadas neste aparelho.', false);
      });
      bTest.addEventListener('click', async () => {
        const r = await post('/conta/push/teste');
        st.textContent = r.ok ? `Notificação de teste enviada (${r.sent} aparelho(s)).` : 'Nenhum aparelho recebeu. Tente desativar e ativar de novo.';
      });
    })().catch((e) => { st.textContent = `Erro: ${e.message}`; });
  }

  // ---------- Simulador do atendente virtual ----------
  const simForm = document.querySelector('[data-sim-form]');
  if (simForm) {
    const chat = document.querySelector('[data-sim-chat]');
    const add = (who, text) => { const p = document.createElement('div'); p.className = `sim-msg ${who}`; p.textContent = text; chat.appendChild(p); chat.scrollTop = chat.scrollHeight; return p; };
    const post = (body) => fetch('/configuracoes/agente/simular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' }).then((r) => r.json());
    simForm.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const inp = simForm.querySelector('input'); const text = inp.value.trim(); if (!text) return;
      if (chat.querySelector('.muted')) chat.innerHTML = '';
      add('in', text); inp.value = ''; const wait = add('out typing', 'digitando…');
      const btn = simForm.querySelector('button'); btn.disabled = true;
      try {
        const r = await post({ text, groq: !!document.querySelector('[data-sim-groq]')?.checked });
        wait.remove();
        const o = add('out', r.ok ? r.reply : `Erro: ${r.error}`);
        if (r.ok && r.provider) { const t = document.createElement('small'); t.className = 'sim-prov'; t.textContent = r.provider === 'groq' ? 'via Groq (reserva)' : 'via Claude'; o.appendChild(t); }
        if (r.handoff) add('sys', `→ Transferido para humano${r.handoff.urgente ? ' (URGENTE)' : ''}: ${r.handoff.motivo}`);
      } catch (err) { wait.remove(); add('sys', `Erro: ${err.message}`); } finally { btn.disabled = false; inp.focus(); }
    }, true);
    document.querySelector('[data-sim-reset]').addEventListener('click', async () => { await post({ reset: true }); chat.innerHTML = '<p class="muted small">Conversa reiniciada.</p>'; });
  }

  // ---------- CRM: Kanban (arrastar e soltar) ----------
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => { const el = document.querySelector(b.dataset.toggle); if (el) el.hidden = !el.hidden; }));
  document.querySelectorAll('[data-autosubmit-check]').forEach((c) => c.addEventListener('change', () => c.form.submit()));
  document.querySelectorAll('select[data-autosubmit]').forEach((c) => c.addEventListener('change', () => c.form.submit()));
  const board = document.querySelector('[data-kanban]');
  if (board) {
    let dragging = null;
    // Etapas: arrastar a coluna pelo título muda a posição (administração)
    let colDrag = null;
    const saveOrder = async (ids) => {
      try { const r = await fetch('/crm/etapas/ordem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ order: ids }) }).then((x) => x.json()); if (!r.ok) location.reload(); } catch { location.reload(); }
    };
    if (board.hasAttribute('data-col-sort')) {
      board.addEventListener('dragstart', (e) => {
        const h = e.target.closest?.('[data-col-drag]'); if (!h) return;
        colDrag = h.closest('.kcol'); colDrag.classList.add('col-dragging'); board.dataset.colDragging = '1';
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `etapa:${colDrag.dataset.stage}`);
        e.stopImmediatePropagation();
      }, true);
      board.addEventListener('dragover', (e) => {
        if (!colDrag) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const cols = [...board.querySelectorAll('.kcol:not(.col-dragging)')];
        const before = cols.find((c) => { const r = c.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
        if (before) { if (colDrag.nextElementSibling !== before) board.insertBefore(colDrag, before); } else if (board.lastElementChild !== colDrag) board.appendChild(colDrag);
      }, true);
      const endCol = (e) => {
        if (!colDrag) return;
        if (e.type === 'drop') e.preventDefault();
        e.stopImmediatePropagation();
        const c = colDrag; colDrag = null; c.classList.remove('col-dragging'); delete board.dataset.colDragging;
        const ids = [...board.querySelectorAll('.kcol')].map((x) => x.dataset.stage);
        if (ids.join() !== board.dataset.colOrder) { board.dataset.colOrder = ids.join(); saveOrder(ids); }
      };
      board.dataset.colOrder = [...board.querySelectorAll('.kcol')].map((x) => x.dataset.stage).join();
      board.addEventListener('drop', endCol, true);
      board.addEventListener('dragend', endCol, true);
    }
    board.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-card]'); if (!c) return; dragging = c; board.dataset.dragging = '1'; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.dataset.card); });
    board.addEventListener('dragend', () => { delete board.dataset.dragging; if (dragging) dragging.classList.remove('dragging'); board.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); dragging = null; });
    const afterEl = (zone, y) => [...zone.querySelectorAll('[data-card]:not(.dragging)')].find((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    board.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-drop]'); if (!zone || !dragging) return;
      e.preventDefault(); board.querySelectorAll('.over').forEach((x) => x !== zone && x.classList.remove('over')); zone.classList.add('over');
      const before = afterEl(zone, e.clientY); if (before) zone.insertBefore(dragging, before); else zone.appendChild(dragging);
    });
    board.addEventListener('drop', async (e) => {
      const zone = e.target.closest('[data-drop]'); if (!zone || !dragging) return;
      e.preventDefault(); zone.classList.remove('over');
      const card = dragging.dataset.card; const stage = zone.closest('[data-stage]').dataset.stage;
      const next = dragging.nextElementSibling?.dataset.card || null;
      const counts = () => board.querySelectorAll('.kcol').forEach((col) => { col.querySelector('.kcount').textContent = col.querySelectorAll('[data-card]').length; });
      counts();
      try {
        const r = await fetch('/crm/mover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ card, stage, before: next }) }).then((x) => x.json());
        if (!r.ok) location.reload();
      } catch { location.reload(); }
    });
    // Evita abrir o card ao soltar depois de arrastar
    board.addEventListener('click', (e) => { if (e.target.closest('.kcard') && board.dataset.justDragged) { e.preventDefault(); delete board.dataset.justDragged; } });
  }

  // ---------- CRM: tela de etapas (arrastar pelo ⠿ para mudar a ordem) ----------
  const stageList = document.querySelector('[data-stage-sort]');
  if (stageList) {
    let row = null;
    const renumber = () => stageList.querySelectorAll('[data-stage-row]').forEach((r, i) => { const p = r.querySelector('input.pos'); if (p) p.value = i + 1; });
    stageList.addEventListener('pointerdown', (e) => { const g = e.target.closest('.kgrip'); if (g) g.closest('[data-stage-row]').draggable = true; });
    stageList.addEventListener('dragstart', (e) => { row = e.target.closest?.('[data-stage-row]'); if (!row) return; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'etapa'); });
    stageList.addEventListener('dragover', (e) => {
      if (!row) return; e.preventDefault();
      const before = [...stageList.querySelectorAll('[data-stage-row]:not(.dragging)')].find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      if (before) stageList.insertBefore(row, before); else stageList.appendChild(row);
    });
    const end = (e) => { if (!row) return; if (e.type === 'drop') e.preventDefault(); row.classList.remove('dragging'); row.draggable = false; row = null; renumber(); };
    stageList.addEventListener('drop', end);
    stageList.addEventListener('dragend', end);
  }

  // ---------- CRM: conversa estilo WhatsApp ----------
  const chatBody = document.querySelector('[data-chat-body]');
  if (chatBody) { chatBody.style.scrollBehavior = 'auto'; chatBody.scrollTop = chatBody.scrollHeight; chatBody.style.scrollBehavior = ''; }
  const compose = document.querySelector('[data-chat-compose]');
  if (compose) {
    const ta = compose.querySelector('textarea');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!ta.value.trim()) return;
        const send = compose.querySelector('.chat-send') || compose.querySelector('.chat-note');
        compose.requestSubmit(send);
      }
    });
  }

  // ---------- WhatsApp: QR code de pareamento ----------
  (() => {
    const box = document.querySelector('[data-wa-qr]');
    if (!box) return;
    const img = box.querySelector('img'); const msg = box.querySelector('.wa-qr-msg'); const codeEl = box.querySelector('.wa-code');
    const btn = box.querySelector('[data-wa-qr-btn]'); const pair = document.querySelector('[data-wa-pair]');
    let refresh = null; let poll = null; let busy = false;
    const post = (data) => fetch('/configuracoes/whatsapp/qr', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data || {}) }).then((r) => r.json());
    const done = () => { clearInterval(refresh); clearInterval(poll); msg.textContent = '✓ Conectado! Atualizando…'; img.hidden = true; msg.hidden = false; setTimeout(() => location.reload(), 1200); };
    const show = (r, numero) => {
      if (r.state === 'open') return done();
      if (r.error) { msg.hidden = false; img.hidden = true; msg.textContent = 'Não foi possível gerar: ' + r.error; return; }
      if (r.qr) { img.src = r.qr; img.hidden = false; msg.hidden = true; }
      else if (!numero) { msg.hidden = false; msg.textContent = 'A Evolution ainda não gerou o QR code. Tentando de novo…'; }
      if (r.pairingCode) { codeEl.hidden = false; codeEl.innerHTML = ''; const b = document.createElement('b'); b.textContent = r.pairingCode.replace(/(.{4})(?=.)/, '$1-'); codeEl.append('Código de pareamento: ', b, document.createElement('br')); const s = document.createElement('small'); s.className = 'muted'; s.textContent = 'No celular: Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone.'; codeEl.append(s); }
    };
    const load = async (numero) => {
      if (busy) return; busy = true; btn.disabled = true;
      if (img.hidden) { msg.hidden = false; msg.textContent = 'Gerando…'; }
      try { show(await post(numero ? { numero } : null), numero); } catch { msg.hidden = false; msg.textContent = 'Falha de rede. Tente novamente.'; }
      busy = false; btn.disabled = false; btn.textContent = 'Gerar novo QR code';
    };
    const start = (numero) => {
      load(numero);
      clearInterval(refresh); clearInterval(poll);
      if (!numero) refresh = setInterval(() => load(), 30000); // o QR do WhatsApp expira em ~40s
      poll = setInterval(async () => { try { const r = await (await fetch('/configuracoes/whatsapp/estado', { cache: 'no-store' })).json(); if (r.state === 'open') done(); } catch { /* tenta de novo */ } }, 3000);
      setTimeout(() => { clearInterval(refresh); if (!img.hidden) { img.hidden = true; msg.hidden = false; msg.textContent = 'QR code pausado. Clique para gerar outro.'; } }, 5 * 60000);
    };
    btn.addEventListener('click', () => start());
    pair?.addEventListener('submit', (e) => { e.preventDefault(); const n = pair.numero.value.trim(); if (n) start(n); });
    if (box.dataset.state === 'connecting' || box.dataset.state === 'close') start();
  })();

  // ---------- Foto do perfil: editor para reenquadrar (arrastar, zoom, girar) antes de salvar ----------
  (() => {
    const form = document.querySelector('[data-photo-form]');
    if (!form) return;
    const file = form.querySelector('[data-photo-file]');
    const reframe = form.querySelector('[data-photo-reframe]');
    const load = (src, isNew) => { const img = new Image(); img.onload = () => editor(img, isNew); img.onerror = () => alert('Não foi possível abrir essa imagem.'); img.src = src; };
    file.addEventListener('change', () => {
      const f = file.files[0]; if (!f) return;
      if (f.size > 10 * 1024 * 1024) { alert('A imagem passa de 10 MB. Escolha uma menor.'); file.value = ''; return; }
      const rd = new FileReader(); // data: (a política de segurança permite data:, não blob:)
      rd.onload = () => load(rd.result, true); rd.onerror = () => alert('Não foi possível ler essa imagem.');
      rd.readAsDataURL(f);
    });
    if (reframe) reframe.addEventListener('click', () => load(reframe.dataset.photoReframe, false));

    function editor(img, isNew) {
      const V = Math.min(300, window.innerWidth - 72); // lado da área de corte
      const dlg = document.createElement('div'); dlg.className = 'app-modal'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', 'Ajustar foto');
      dlg.innerHTML = `<div class="app-modal-box crop-box"><h2>Ajustar foto</h2>
        <p class="muted small">Arraste para posicionar. Use o controle, a roda do mouse ou dois dedos para aproximar.</p>
        <div class="crop-view" style="width:${V}px;height:${V}px" tabindex="0" aria-label="Área da foto: use as setas para mover e + ou − para aproximar"><img alt="" draggable="false"><div class="crop-mask" aria-hidden="true"></div></div>
        <div class="crop-tools"><span aria-hidden="true">−</span><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Aproximar"><span aria-hidden="true">+</span>
          <button type="button" class="btn ghost" data-rot title="Girar 90°" aria-label="Girar 90 graus">⟳</button><button type="button" class="btn ghost" data-center>Centralizar</button></div>
        <div class="actions"><button class="btn" data-ok>Salvar foto</button><button class="btn ghost" data-cancel>Cancelar</button></div></div>`;
      document.body.appendChild(dlg); document.documentElement.dataset.uiBusy = 'modal';
      const view = dlg.querySelector('.crop-view'); const im = view.querySelector('img'); const zoom = dlg.querySelector('input[type=range]');
      im.src = img.src; im.style.width = `${img.naturalWidth}px`; im.style.height = `${img.naturalHeight}px`;
      const st = { x: 0, y: 0, z: 1, r: 0 };
      const dims = () => (st.r % 180 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight]);
      const scale = () => { const [w, h] = dims(); return (V / Math.min(w, h)) * st.z; };
      const clamp = () => { const [w, h] = dims(); const k = scale(); const mx = Math.max(0, (w * k - V) / 2); const my = Math.max(0, (h * k - V) / 2); st.x = Math.max(-mx, Math.min(mx, st.x)); st.y = Math.max(-my, Math.min(my, st.y)); };
      const draw = () => { clamp(); im.style.transform = `translate(-50%, -50%) translate(${st.x}px, ${st.y}px) rotate(${st.r}deg) scale(${scale()})`; zoom.value = st.z; };
      const setZoom = (z, cx = 0, cy = 0) => { const nz = Math.max(1, Math.min(4, z)); const f = nz / st.z; st.x = cx + (st.x - cx) * f; st.y = cy + (st.y - cy) * f; st.z = nz; draw(); };
      draw();
      // arrastar (mouse e dedo) e pinça com dois dedos
      const pts = new Map(); let last = null; let pinch = null;
      view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: st.z }; } e.preventDefault(); });
      view.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; setZoom(pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d); return; }
        st.x += e.clientX - last.x; st.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; draw();
      });
      const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; const rest = [...pts.values()][0]; if (rest) last = { ...rest }; };
      view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
      view.addEventListener('wheel', (e) => { e.preventDefault(); const r = view.getBoundingClientRect(); setZoom(st.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left - V / 2, e.clientY - r.top - V / 2); }, { passive: false });
      view.addEventListener('keydown', (e) => { const k = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key]; if (k) { st.x += k[0]; st.y += k[1]; draw(); e.preventDefault(); } if (e.key === '+' || e.key === '=') setZoom(st.z * 1.1); if (e.key === '-') setZoom(st.z / 1.1); });
      zoom.addEventListener('input', () => setZoom(Number(zoom.value)));
      dlg.querySelector('[data-rot]').addEventListener('click', () => { st.r = (st.r + 90) % 360; draw(); });
      dlg.querySelector('[data-center]').addEventListener('click', () => { st.x = 0; st.y = 0; st.z = 1; draw(); });
      const done = () => { dlg.remove(); delete document.documentElement.dataset.uiBusy; file.value = ''; };
      dlg.querySelector('[data-cancel]').addEventListener('click', done);
      dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
      dlg.querySelector('[data-ok]').addEventListener('click', async () => {
        const ok = dlg.querySelector('[data-ok]'); ok.disabled = true; ok.textContent = 'Salvando…';
        // recorte 320×320 conforme o enquadramento
        const S = 320; const k = S / V;
        const cv = document.createElement('canvas'); cv.width = S; cv.height = S; const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S); ctx.imageSmoothingQuality = 'high';
        ctx.translate(S / 2 + st.x * k, S / 2 + st.y * k); ctx.rotate((st.r * Math.PI) / 180); ctx.scale(scale() * k, scale() * k);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
        let q = 0.88; let data = cv.toDataURL('image/jpeg', q);
        while (data.length > 380000 && q > 0.4) { q -= 0.1; data = cv.toDataURL('image/jpeg', q); }
        try {
          if (isNew) { // guarda o original (até 1600 px) para reenquadrar depois
            const M = 1600; const f = Math.min(1, M / Math.max(img.naturalWidth, img.naturalHeight));
            const oc = document.createElement('canvas'); oc.width = Math.round(img.naturalWidth * f); oc.height = Math.round(img.naturalHeight * f);
            const octx = oc.getContext('2d'); octx.fillStyle = '#fff'; octx.fillRect(0, 0, oc.width, oc.height); octx.drawImage(img, 0, 0, oc.width, oc.height);
            const blob = await new Promise((r) => oc.toBlob(r, 'image/jpeg', 0.85));
            if (blob) await fetch('/conta/foto/original', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
          }
        } catch { /* o original é opcional; o recorte segue */ }
        form.photo.value = data;
        done(); form.submit();
      });
      view.focus();
    }
  })();

  // ---------- Dashboard: abas Semana/Mês/Ano e dica dos gráficos ----------
  document.querySelectorAll('[data-seg]').forEach((seg) => {
    const id = seg.dataset.seg;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-seg-k]'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      document.querySelectorAll(`[data-seg-pane^="${id}:"]`).forEach((p) => { p.hidden = p.dataset.segPane !== `${id}:${b.dataset.segK}`; });
    });
  });
  document.querySelectorAll('.ch').forEach((ch) => {
    const tip = ch.querySelector('.ch-tip'); const svg = ch.querySelector('svg');
    const show = (g, ev) => {
      const box = ch.getBoundingClientRect(); const mark = g.querySelector('.ch-dot, .ch-bar') || g.querySelector('.ch-target');
      const mb = mark.getBoundingClientRect();
      tip.textContent = g.dataset.tip; tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(mb.left + mb.width / 2 - box.left, 60), box.width - 60)}px`;
      tip.style.top = `${Math.max(mb.top - box.top, 24)}px`;
      ch.querySelectorAll('.ch-hit.on').forEach((x) => x.classList.remove('on')); g.classList.add('on');
    };
    svg.addEventListener('pointermove', (e) => { const g = e.target.closest('.ch-hit'); if (g) show(g, e); });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; ch.querySelectorAll('.ch-hit.on').forEach((x) => x.classList.remove('on')); });
  });


  // ---------- Conciliação bancária: mostra descrição/categoria só para "lançar novo"; marcar todas ----------
  document.querySelectorAll('[data-recon-sel]').forEach((sel) => {
    const box = sel.parentElement.querySelector('.recon-create');
    const sync = () => { if (box) box.hidden = sel.value !== 'create'; };
    sel.addEventListener('change', () => { sync(); const ok = sel.closest('li')?.querySelector('[data-recon-item]'); if (ok) ok.checked = true; });
    sync();
  });
  document.querySelectorAll('[data-check-all]').forEach((all) => all.addEventListener('change', () => {
    document.querySelectorAll(`[data-recon-item="${all.dataset.checkAll}"]`).forEach((c) => { c.checked = all.checked; });
  }));

  // ---------- Backup: restaurar a partir de um arquivo ----------
  document.querySelectorAll('[data-bk-upload]').forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    const msg = inp.closest('section')?.querySelector('[data-upload-msg]'); const pwd = document.getElementById('bk-pwd');
    if (!pwd || !pwd.value) { if (msg) msg.textContent = 'Digite sua senha antes de escolher o arquivo.'; inp.value = ''; pwd?.focus(); return; }
    if (!(await askConfirm(`Restaurar o backup “${f.name}”? Os dados atuais serão substituídos.`))) { inp.value = ''; return; }
    if (msg) msg.textContent = `Enviando e restaurando “${f.name}”… não feche esta página.`;
    try {
      const r = await fetch(inp.dataset.bkUpload, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name), 'X-Password': pwd.value }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
      location.href = d.redirect || location.href;
    } catch (e) { if (msg) msg.textContent = `Não foi possível restaurar: ${e.message}`; inp.value = ''; }
  }));

  // ---------- Anexos do financeiro: envia o arquivo direto (sem formulário) ----------
  document.querySelectorAll('[data-upload]').forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    const msg = inp.closest('section')?.querySelector('[data-upload-msg]');
    if (f.size > 5 * 1024 * 1024) { if (msg) msg.textContent = 'O arquivo passa de 5 MB.'; inp.value = ''; return; }
    if (msg) msg.textContent = `Enviando “${f.name}”…`;
    try {
      const r = await fetch(inp.dataset.upload, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
      if (d.redirect && d.redirect.startsWith('/')) location.href = d.redirect; else location.reload();
    } catch (e) { if (msg) msg.textContent = `Não foi possível ${inp.dataset.upload.includes('/extrato') ? 'importar' : 'anexar'}: ${e.message}`; inp.value = ''; }
  }));
}
initPage();

// ---------- Menus da barra superior: fecha ao clicar fora / Esc ----------
document.addEventListener('click', (e) => { document.querySelectorAll('.topbar details[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.topbar details[open]').forEach((d) => { d.open = false; }); });

// ---------- Tema claro/escuro (ícone lua/sol no topo) ----------
document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
  const root = document.documentElement;
  const t = root.dataset.theme || 'light';
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  root.dataset.theme = next;
  // claro é o padrão: apaga a preferência; escuro fica salvo
  document.cookie = next === 'dark' ? `tema=escuro; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` : 'tema=; Path=/; Max-Age=0; SameSite=Lax';
}));

// ---------- Recolher / expandir o menu lateral ----------
document.querySelectorAll('[data-side-toggle]').forEach((b) => b.addEventListener('click', () => {
  const min = document.body.classList.toggle('side-min');
  b.setAttribute('aria-expanded', min ? 'false' : 'true'); b.title = min ? 'Expandir menu' : 'Recolher menu';
  document.cookie = `menu=${min ? 'min' : ''}; Path=/; Max-Age=${min ? 31536000 : 0}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}));

// ---------- Atualização ao vivo (todas as telas, todos os usuários) ----------
// O servidor avisa (SSE em /live; se o proxy bloquear, consulta /live/since a cada 3 s) quais áreas mudaram.
// A página busca o próprio conteúdo de novo e troca só a área central e o sino — sem recarregar e sem
// atrapalhar: se a pessoa está digitando, com algo alterado num formulário, arrastando um card ou com
// um menu aberto, a troca espera e acontece logo depois.
(() => {
  if (!document.querySelector('.topbar') || !window.fetch) return; // só telas com login
  const topics = (document.body.dataset.live || '*').split(',').filter(Boolean);
  const main = () => document.querySelector('main.main');
  const relevant = (ts) => topics.includes('*') || ts.some((t) => topics.includes(t));
  let lastId = null; let pendingMain = false; let pendingBell = false; let busy = false; let again = null; let debounce = null;

  // Algum campo diferente do que veio do servidor? (alteração ainda não salva)
  const unsaved = (root) => [...root.querySelectorAll('input, textarea, select')].some((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.disabled) return false;
    if (el.type === 'file') return !!el.value;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') {
      const opts = [...el.options]; const def = opts.findIndex((o) => o.defaultSelected);
      return el.multiple ? opts.some((o) => o.selected !== o.defaultSelected) : el.selectedIndex !== (def < 0 ? 0 : def);
    }
    return el.value !== el.defaultValue;
  });
  const busyUser = () => {
    const m = main(); if (!m) return true;
    const a = document.activeElement;
    if (a && m.contains(a) && a.matches('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select')) return true;
    if (unsaved(m)) return true;
    if (m.querySelector('[data-kanban][data-dragging]')) return true;
    if (document.documentElement.dataset.uiBusy) return true;              // menu de contexto, remarcação ou arrastar abertos
    if (m.querySelector('.sim-msg')) return true;                          // conversa no simulador
    if (m.querySelector('[data-sai-active]')) return true;                 // IA na sessão gravando ou processando
    if (m.querySelector('[data-wa-qr] img:not([hidden])')) return true;    // QR code na tela
    if (m.querySelector('[data-toggle]') && [...m.querySelectorAll('[data-toggle]')].some((b) => { const el = document.querySelector(b.dataset.toggle); return el && !el.hidden && el.matches('form, form *'); })) return true;
    return false;
  };

  const SCROLLERS = '.kanban, .kcol, .kcards, [data-chat-body], .tbl-wrap, .ag-month, .week, .chat';
  const snapshot = (m) => ({
    y: window.scrollY,
    sc: [...m.querySelectorAll(SCROLLERS)].map((el) => ({ l: el.scrollLeft, t: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 })),
    det: [...m.querySelectorAll('details')].map((d) => d.open),
    seg: [...m.querySelectorAll('[data-seg] button.on')].map((b) => `${b.closest('[data-seg]').dataset.seg}:${b.dataset.segK}`),
    flash: m.querySelector(':scope > .flash')?.outerHTML || '',
  });
  const restore = (m, k) => {
    m.querySelectorAll('details').forEach((d, i) => { if (i in k.det) d.open = k.det[i]; });
    k.seg.forEach((v) => { const [id, key] = v.split(':'); m.querySelector(`[data-seg="${id}"] button[data-seg-k="${key}"]`)?.click(); });
    m.querySelectorAll(SCROLLERS).forEach((el, i) => { const o = k.sc[i]; if (!o) return; el.scrollLeft = o.l; el.scrollTop = o.bottom ? el.scrollHeight : o.t; });
    if (k.flash && !m.querySelector(':scope > .flash')) m.insertAdjacentHTML('afterbegin', k.flash);
    window.scrollTo(0, k.y);
  };

  async function refresh(swapMain) {
    if (busy) { again = again || swapMain; return; }
    busy = true;
    try {
      const r = await fetch(location.href, { headers: { 'X-Live': '1' }, credentials: 'same-origin', cache: 'no-store' });
      // página sumiu ou agora redireciona (ex.: item excluído por outra pessoa): não mexe
      if (!r.ok || (r.redirected && new URL(r.url).pathname !== location.pathname)) return;
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const nb = doc.querySelector('.tnotes'); const ob = document.querySelector('.tnotes');
      if (nb && ob && !ob.open && nb.innerHTML !== ob.innerHTML) ob.replaceWith(nb);
      if (swapMain && !busyUser()) {
        const nm = doc.querySelector('main.main'); const om = main();
        const strip = (h) => h.replace(/<div class="flash[^"]*">[\s\S]*?<\/div>/, '');
        if (nm && om && strip(nm.innerHTML) !== strip(om.innerHTML)) {
          const k = snapshot(om); om.innerHTML = nm.innerHTML; initPage(); restore(om, k);
          document.dispatchEvent(new CustomEvent('live:updated'));
        }
      } else if (swapMain) pendingMain = true;
    } catch { /* rede instável: a próxima notícia tenta de novo */ } finally {
      busy = false;
      if (again !== null) { const a = again; again = null; refresh(a); }
    }
  }
  function onTopics(ts) {
    if (!ts || !ts.length) return;
    const swap = relevant(ts);
    pendingBell = true; if (swap) pendingMain = true;
    clearTimeout(debounce);
    debounce = setTimeout(tick, 250);
  }
  function tick() {
    if (!pendingMain && !pendingBell) return;
    if (document.querySelector('.topbar details[open]')) return;     // menu do topo aberto: espera
    if (pendingMain && busyUser()) { if (pendingBell) { pendingBell = false; refresh(false); } return; }
    const swap = pendingMain; pendingMain = false; pendingBell = false; refresh(swap);
  }
  setInterval(tick, 1500); // aplica o que ficou esperando assim que a pessoa termina

  const since = async () => {
    const r = await fetch(`/live/since?since=${lastId ?? -1}`, { credentials: 'same-origin', cache: 'no-store' });
    const d = await r.json(); const first = lastId === null; lastId = d.id; if (!first) onTopics(d.topics);
  };
  const dot = document.createElement('span'); dot.className = 'live-dot'; dot.title = 'Atualização ao vivo ativa';
  document.querySelector('.tactions')?.prepend(dot);
  const setState = (ok) => { dot.classList.toggle('off', !ok); dot.title = ok ? 'Atualização ao vivo ativa' : 'Reconectando…'; };

  let polling = null;
  const startPoll = () => { if (polling) return; setState(true); since().catch(() => {}); polling = setInterval(() => since().then(() => setState(true), () => setState(false)), 3000); };
  if (!window.EventSource) return startPoll();
  const es = new EventSource('/live');
  let hello = false;
  const fallback = setTimeout(() => { if (!hello) { es.close(); startPoll(); } }, 6000); // proxy segurando o SSE
  es.addEventListener('hello', (e) => {
    hello = true; clearTimeout(fallback); setState(true);
    const d = JSON.parse(e.data);
    if (lastId !== null && d.id > lastId) since().catch(() => {}); // reconectou: busca o que perdeu
    else lastId = d.id;
  });
  es.addEventListener('change', (e) => { const d = JSON.parse(e.data); lastId = d.id; onTopics(d.topics); });
  es.onerror = () => setState(false);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && lastId !== null) since().catch(() => {}); });
})();

// =====================================================================
// Aparência de aplicativo: menu do navegador desativado; menus próprios na agenda e no CRM
// =====================================================================
(() => {
  const root = document.documentElement;
  const busy = (on, k) => { const s = new Set((root.dataset.uiBusy || '').split(' ').filter(Boolean)); if (on) s.add(k); else s.delete(k); if (s.size) root.dataset.uiBusy = [...s].join(' '); else delete root.dataset.uiBusy; };
  const backUrl = () => location.pathname + location.search;
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const toast = (msg) => {
    let t = document.querySelector('.app-toast');
    if (!t) { t = document.createElement('div'); t.className = 'app-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200);
  };
  const post = (url, fields = {}) => {
    const f = document.createElement('form'); f.method = 'post'; f.action = url; f.hidden = true;
    for (const [k, v] of Object.entries({ back: backUrl(), ...fields })) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); f.submit();
  };
  const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok); } catch { window.prompt('Copie:', text); } };

  // ---------- menu ----------
  let menu = null; let openedAt = 0;
  const close = () => { if (menu) { menu.remove(); menu = null; busy(false, 'menu'); } };
  function render(title, items, x, y) {
    const first = !menu;
    if (!menu) { openedAt = Date.now(); menu = document.createElement('div'); menu.className = 'ctxm'; menu.setAttribute('role', 'menu'); document.body.appendChild(menu); busy(true, 'menu'); }
    menu.innerHTML = `<div class="ctxm-h">${esc(title)}</div>`;
    for (const it of items) {
      if (it === '-') { menu.insertAdjacentHTML('beforeend', '<hr>'); continue; }
      if (it.form) { const f = document.createElement('form'); f.className = 'ctxm-form'; f.innerHTML = it.form; f.addEventListener('submit', (e) => { e.preventDefault(); it.submit(new FormData(f)); close(); }); menu.appendChild(f); setTimeout(() => f.querySelector('input')?.focus(), 30); continue; }
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.className = `ctxm-i${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}`;
      b.innerHTML = `<span class="ctxm-ic" aria-hidden="true">${it.icon || ''}</span><span>${esc(it.label)}</span>${it.sub ? '<span class="ctxm-go" aria-hidden="true">›</span>' : ''}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.sub) return render(it.label, [{ icon: '‹', label: 'Voltar', run: () => render(title, items) }, '-', ...it.sub()]);
        if (it.run) return it.run();
        if (it.confirm && navigator.webdriver && !window.__lmRealConfirm) { if (!window.confirm(it.confirm)) return; }
        else if (it.confirm && !it.__ok) { close(); askConfirm(it.confirm).then((yes) => { if (yes) { it.__ok = true; b.click(); } }); return; }
        it.__ok = false;
        close();
        if (it.href) { if (it.blank) window.open(it.href, '_blank', 'noopener'); else location.href = it.href; }
        else if (it.post) post(it.post, it.fields);
        else if (it.copy) copy(it.copy, it.ok || 'Copiado.');
      });
      menu.appendChild(b);
    }
    if (first) {
      const w = menu.offsetWidth; const h = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
    } else {
      const r = menu.getBoundingClientRect();
      if (r.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - r.height - 8)}px`;
    }
    menu.querySelector('.ctxm-i')?.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const its = [...menu.querySelectorAll('.ctxm-i')]; const i = its.indexOf(document.activeElement);
      its[(i + (e.key === 'ArrowDown' ? 1 : -1) + its.length) % its.length]?.focus(); e.preventDefault();
    }
  });
  addEventListener('scroll', (e) => { if (menu && Date.now() - openedAt > 450 && !(e.target instanceof Node && menu.contains(e.target))) close(); }, true); addEventListener('resize', close);

  // ---------- itens: sessão da agenda ----------
  const STATUS = { confirmada: ['✔', 'Confirmar'], aguardando: ['🛎', 'Paciente chegou (aguardando)'], em_atendimento: ['▶', 'Iniciar atendimento'], realizada: ['✓', 'Marcar como realizada'], falta: ['✗', 'Marcar falta'], cancelada: ['⊘', 'Cancelar sessão'] };
  function apptItems(el) {
    const d = el.dataset; const flags = (el.closest('[data-agenda]') || document.querySelector('[data-agenda]') || { dataset: {} }).dataset;
    const open = ['agendada', 'confirmada'].includes(d.st);
    const it = [{ icon: '↗', label: 'Abrir sessão', href: `/agenda/${d.id}` }, { icon: '🛎', label: 'Abrir na recepção', href: '/recepcao' }];
    const st = Object.entries(STATUS).filter(([k]) => k !== d.st && (k !== 'confirmada' || d.st === 'agendada')
      && (k !== 'aguardando' || ['agendada', 'confirmada'].includes(d.st)) && (k !== 'em_atendimento' || ['agendada', 'confirmada', 'aguardando'].includes(d.st)));
    if (st.length) it.push('-', ...st.map(([k, [ic, l]]) => ({ icon: ic, label: l, post: `/agenda/${d.id}/status`, fields: { status: k }, confirm: k === 'cancelada' ? `Cancelar a sessão de ${d.name}?` : null })));
    it.push('-');
    if (open) it.push({ icon: '↻', label: 'Remarcar…', href: `/agenda/${d.id}` });
    it.push({ icon: '⧉', label: 'Repetir na próxima semana', post: `/agenda/${d.id}/repetir` });
    if (open && flags.wa === '1' && d.phone && d.optin === '1') it.push({ icon: '💬', label: 'Enviar lembrete pelo WhatsApp', post: `/agenda/${d.id}/whatsapp` });
    if (d.phone) it.push({ icon: '🟢', label: 'Abrir conversa no WhatsApp', href: `https://wa.me/${d.phone}`, blank: true });
    if (d.link) it.push({ icon: '🔗', label: 'Copiar link da chamada', copy: d.link, ok: 'Link da chamada copiado.' });
    it.push('-', { icon: '👤', label: 'Ficha do paciente', href: `/pacientes/${d.pid}` });
    if (flags.pront === '1') it.push({ icon: '📝', label: 'Registrar evolução', href: `/pacientes/${d.pid}?aba=prontuario` });
    if (flags.fin === '1' && d.pay) {
      it.push({ icon: '💳', label: d.paid === '1' ? 'Ver pagamento (pago)' : 'Registrar pagamento', href: `/financeiro/${d.pay}` });
      if (d.paid !== '1' && flags.wa === '1' && d.optin === '1') it.push({ icon: '⚡', label: 'Cobrar com Pix pelo WhatsApp', post: `/financeiro/${d.pay}/cobrar`, confirm: `Enviar a cobrança com Pix para ${d.name}?` });
    }
    if (d.paid !== '1') it.push('-', { icon: '🗑', label: 'Excluir sessão', danger: true, post: `/agenda/${d.id}/excluir`, confirm: `Excluir definitivamente a sessão de ${d.name}?` });
    return it;
  }

  // ---------- itens: card do CRM ----------
  function cardItems(el) {
    const d = el.dataset; const board = el.closest('[data-kanban]'); const bd = board ? board.dataset : {};
    const stages = JSON.parse(bd.stages || '[]'); const users = JSON.parse(bd.users || '[]');
    const it = [{ icon: '↗', label: 'Abrir card e conversa', href: `/crm/${d.id}` },
      { icon: '⇄', label: 'Mover para etapa', sub: () => stages.map((s) => ({ icon: `<i class="ctxm-dot" style="background:${esc(s.color)}"></i>`, label: s.name, on: String(s.id) === d.stage, run: async () => { close(); await fetch('/crm/mover', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card: d.id, stage: s.id, before: null }) }); location.reload(); } })) },
      { icon: '👤', label: 'Atribuir responsável', sub: () => [{ label: 'Eu mesmo(a)', icon: '★', post: `/crm/${d.id}/responsavel`, fields: { user: bd.me } }, ...users.map((u) => ({ icon: '', label: u.name, on: String(u.id) === d.resp, post: `/crm/${d.id}/responsavel`, fields: { user: u.id } })), { icon: '✗', label: 'Sem responsável', post: `/crm/${d.id}/responsavel`, fields: { user: '' } }] },
      '-'];
    if (d.agent) it.push(d.agent === 'humano' ? { icon: '🤖', label: 'Devolver ao atendente virtual', post: `/crm/${d.id}/atendente` } : { icon: '✋', label: 'Assumir conversa (pausar atendente)', post: `/crm/${d.id}/atendente` });
    if (d.pid) it.push({ icon: '📅', label: 'Agendar sessão', href: `/agenda/nova?paciente=${d.pid}` }, { icon: '👤', label: 'Ficha do paciente', href: `/pacientes/${d.pid}` });
    else if (bd.cadastro === '1') it.push({ icon: '➕', label: 'Cadastrar como paciente', post: `/crm/${d.id}/paciente` });
    it.push({ icon: '🏷', label: 'Adicionar etiqueta', sub: () => [{ form: '<input name="tag" maxlength="40" placeholder="Ex.: Instagram" required aria-label="Etiqueta"><button class="btn">Adicionar</button>', submit: (f) => post(`/crm/${d.id}/etiqueta`, { tag: f.get('tag') }) }] },
      { icon: '📌', label: 'Próxima ação', sub: () => [{ form: `<input name="next_action" maxlength="160" placeholder="Ex.: retornar sobre horário" aria-label="Próxima ação"><input type="date" name="next_action_at" value="${new Date(Date.now() + 864e5 - 3 * 3600e3).toISOString().slice(0, 10)}" aria-label="Data"><button class="btn">Salvar</button>`, submit: (f) => post(`/crm/${d.id}/proxima`, { next_action: f.get('next_action'), next_action_at: f.get('next_action_at') }) }] });
    if (d.phone) it.push({ icon: '📋', label: 'Copiar telefone', copy: `+${d.phone}`, ok: 'Telefone copiado.' }, { icon: '🟢', label: 'Abrir no WhatsApp', href: `https://wa.me/${d.phone}`, blank: true });
    it.push('-', { icon: '🗄', label: 'Arquivar card', danger: true, post: `/crm/${d.id}/arquivar`, confirm: `Arquivar o card de ${d.name}?` });
    return it;
  }

  const openFor = (el, x, y) => render(el.dataset.name || 'Ações', el.dataset.ctx === 'card' ? cardItems(el) : apptItems(el), x, y);

  // Botão direito: menu próprio onde existe; nos demais lugares, nenhum (exceto campos de texto e texto selecionado).
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (String(window.getSelection() || '').trim()) return;
    e.preventDefault();
    if (lp.fired) return;
    const host = e.target.closest('[data-ctx]');
    if (host) { close(); openFor(host, e.clientX, e.clientY); }
  });
  // Botão “⋯” no card
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctx-open]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const host = b.closest('[data-ctx]'); const r = b.getBoundingClientRect();
    close(); openFor(host, r.left, r.bottom + 4);
  }, true);
  // Segurar o dedo (celular / tablet)
  const lp = { t: null, fired: false, x: 0, y: 0 };
  document.addEventListener('pointerdown', (e) => {
    lp.fired = false;
    if (e.pointerType === 'mouse') return;
    const host = e.target.closest('[data-ctx]'); if (!host) return;
    lp.x = e.clientX; lp.y = e.clientY;
    lp.t = setTimeout(() => { lp.fired = true; close(); openFor(host, lp.x, lp.y); if (navigator.vibrate) navigator.vibrate(10); }, 550);
  });
  const cancelLp = (e) => { if (lp.t && (!e || e.type !== 'pointermove' || Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10)) { clearTimeout(lp.t); lp.t = null; } };
  document.addEventListener('pointermove', cancelLp); document.addEventListener('pointerup', () => cancelLp()); document.addEventListener('pointercancel', () => cancelLp());
  document.addEventListener('click', (e) => { if (lp.fired) { e.preventDefault(); e.stopPropagation(); lp.fired = false; } }, true);

  // =====================================================================
  // Agenda: clicar para agendar e arrastar para remarcar
  // =====================================================================
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const snap = (m) => Math.round(m / 15) * 15;
  const gridMin = (g, clientY, offset = 0) => { const r = g.getBoundingClientRect(); return Math.max(0, Math.min(24 * 60 - 15, snap(Number(g.dataset.from) + (clientY - r.top - offset) / Number(g.dataset.px)))); };
  const ghost = (g, m, text) => {
    let el = g.querySelector('.dg-ghost'); if (!el) { el = document.createElement('div'); el.className = 'dg-ghost'; g.appendChild(el); }
    el.style.top = `${(m - Number(g.dataset.from)) * Number(g.dataset.px)}px`; el.textContent = text; el.hidden = false;
  };
  const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const brDay = (d) => `${DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]}, ${d.slice(8, 10)}/${d.slice(5, 7)}`;

  // clique em espaço livre → nova sessão já com data (e horário, na visão Dia)
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || root.dataset.uiBusy) return;
    if (e.target.closest('a, button, form, input, select, textarea, label, [data-ctx], .off-tag, .dg-busy, .gbusy, .am-busy')) return;
    const g = e.target.closest('.dgrid[data-slot-day]');
    if (g) { location.href = `/agenda/nova?data=${g.dataset.slotDay}&hora=${hm(gridMin(g, e.clientY))}${g.dataset.prof ? `&prof=${g.dataset.prof}` : ''}`; return; }
    const cell = e.target.closest('[data-slot-day]');
    if (cell && cell.closest('[data-agenda]')) location.href = `/agenda/nova?data=${cell.dataset.slotDay}`;
  });
  document.addEventListener('mousemove', (e) => {
    const g = e.target.closest && e.target.closest('.dgrid[data-slot-day]');
    document.querySelectorAll('.dgrid .dg-ghost.hover').forEach((x) => { if (!g || !g.contains(x)) x.hidden = true; });
    if (!g || drag || e.target.closest('.dg-ev, .dg-busy')) { g?.querySelector('.dg-ghost')?.setAttribute('hidden', ''); return; }
    const m = gridMin(g, e.clientY); ghost(g, m, `+ ${hm(m)}`); g.querySelector('.dg-ghost').classList.add('hover');
  });
  document.addEventListener('mouseleave', (e) => { if (e.target.matches?.('.dgrid')) e.target.querySelector('.dg-ghost')?.setAttribute('hidden', ''); }, true);

  // arrastar
  let drag = null;
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-ctx="appt"][data-move]'); if (!el) return;
    const r = el.getBoundingClientRect();
    drag = { el, id: el.dataset.id, date: el.dataset.when.slice(0, 10), time: el.dataset.when.slice(11, 16), dur: Number(el.dataset.dur), off: e.clientY - r.top };
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `appt:${drag.id}`);
    setTimeout(() => el.classList.add('dragging'), 0); busy(true, 'drag'); close();
  });
  document.addEventListener('dragend', () => {
    if (!drag) return; drag.el.classList.remove('dragging'); drag = null; busy(false, 'drag');
    document.querySelectorAll('.drop-over').forEach((x) => x.classList.remove('drop-over'));
    document.querySelectorAll('.dg-ghost').forEach((x) => { x.hidden = true; });
  });
  document.addEventListener('dragover', (e) => {
    if (!drag) return;
    const g = e.target.closest('.dgrid[data-slot-day]');
    const z = g || e.target.closest('[data-drop-day]');
    document.querySelectorAll('.drop-over').forEach((x) => x !== z && x.classList.remove('drop-over'));
    if (!z) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; z.classList.add('drop-over');
    if (g) { const m = gridMin(g, e.clientY, drag.off); ghost(g, m, `${hm(m)}–${hm(m + drag.dur)}`); g.querySelector('.dg-ghost').classList.remove('hover'); }
  });
  document.addEventListener('drop', (e) => {
    if (!drag) return;
    const g = e.target.closest('.dgrid[data-slot-day]'); const z = g || e.target.closest('[data-drop-day]');
    if (!z) return;
    e.preventDefault();
    if (g && g.dataset.prof && drag.el.dataset.prof && g.dataset.prof !== drag.el.dataset.prof) { toast('Para trocar o profissional, altere o responsável na ficha do paciente.'); return; }
    const date = g ? g.dataset.slotDay : z.dataset.dropDay;
    const time = g ? hm(gridMin(g, e.clientY, drag.off)) : drag.time;
    const it = { ...drag, name: drag.el.dataset.name, phone: drag.el.dataset.phone, optin: drag.el.dataset.optin };
    if (date === it.date && time === it.time) return;
    confirmMove(it, date, time);
  });

  function confirmMove(it, date, time) {
    const wa = document.querySelector('[data-agenda]')?.dataset.wa === '1' && it.phone && it.optin === '1';
    const dlg = document.createElement('div'); dlg.className = 'app-modal'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `<div class="app-modal-box"><h2>Remarcar sessão</h2>
      <p><b>${esc(it.name)}</b></p>
      <p class="mv-from">de ${esc(brDay(it.date))} às ${esc(it.time)}</p><p class="mv-to">para <b>${esc(brDay(date))} às ${esc(time)}</b></p>
      ${wa ? '<label class="check"><input type="checkbox" name="notify" checked> Avisar o paciente pelo WhatsApp</label>' : ''}
      <p class="mv-err" hidden></p>
      <div class="actions"><button class="btn" data-ok>Remarcar</button><button class="btn danger" data-force hidden>Remarcar mesmo assim (encaixe)</button><button class="btn ghost" data-cancel>Cancelar</button></div></div>`;
    document.body.appendChild(dlg); busy(true, 'modal');
    const done = () => { dlg.remove(); busy(false, 'modal'); };
    const send = async (encaixe) => {
      dlg.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const r = await fetch(`/agenda/${it.id}/mover`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, time, encaixe: !!encaixe, notify: !!dlg.querySelector('[name=notify]')?.checked }) }).then((x) => x.json());
        if (r.ok) { done(); location.reload(); return; }
        const er = dlg.querySelector('.mv-err'); er.textContent = r.error || 'Não foi possível remarcar.'; er.hidden = false;
        if (r.needForce) dlg.querySelector('[data-force]').hidden = false;
      } catch { const er = dlg.querySelector('.mv-err'); er.textContent = 'Sem conexão. Tente de novo.'; er.hidden = false; }
      dlg.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    };
    dlg.querySelector('[data-ok]').addEventListener('click', () => send(false));
    dlg.querySelector('[data-force]').addEventListener('click', () => send(true));
    dlg.querySelector('[data-cancel]').addEventListener('click', done);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(); });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
    dlg.querySelector('[data-ok]').focus();
  }
})();

// ---------- Recepção: tempo de espera / atendimento correndo ao vivo ----------
setInterval(() => {
  document.querySelectorAll('[data-since][data-tpl]').forEach((el) => {
    const since = Date.parse(`${el.dataset.since.replace(' ', 'T')}-03:00`); if (!since) return;
    el.textContent = el.dataset.tpl.replace('{m}', Math.max(0, Math.floor((Date.now() - since) / 60000)));
  });
  document.querySelectorAll('.rc-timer[data-since]').forEach((el) => {
    const since = Date.parse(`${el.dataset.since.replace(' ', 'T')}-03:00`); if (!since) return;
    const min = Math.max(0, Math.floor((Date.now() - since) / 60000));
    const ic = el.textContent.trim().split(' ')[0];
    el.textContent = `${ic} ${min} min`;
    if (el.dataset.alert && min >= Number(el.dataset.alert)) { el.classList.add('late'); el.closest('.rc-card')?.classList.add('late'); }
  });
}, 15000);

// ---------- Copiar / imprimir ----------
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) { const el = document.querySelector(c.dataset.copy); if (el) { el.select(); navigator.clipboard?.writeText(el.value).then(() => { c.textContent = 'Copiado!'; }).catch(() => document.execCommand('copy')); } }
  if (e.target.closest('[data-print]')) window.print();
});

// ---------- IA na sessão: grava no navegador, envia em partes, acompanha e coloca o rascunho no formulário ----------
function initSessionAI() {
  const sai = document.querySelector('[data-sai]');
  if (!sai || !sai.querySelector('[data-sai-idle]') || sai.dataset.saiInit) return;
  sai.dataset.saiInit = '1';
  const pid = sai.dataset.sai; const maxMin = Number(sai.dataset.maxMin) || 110;
  const $s = (x) => sai.querySelector(x);
  const show = (v) => {
    ['idle', 'live', 'busy', 'err', 'ready'].forEach((k) => { const el = $s(`[data-sai-${k}]`); if (el) el.hidden = k !== v; });
    if (v === 'live' || v === 'busy') sai.dataset.saiActive = '1'; else delete sai.dataset.saiActive; // a atualização ao vivo não troca a tela
  };
  const say = (t) => { $s('[data-sai-msg]').textContent = t || ''; };
  const net = (t) => { $s('[data-sai-net]').textContent = t || ''; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const form = document.querySelector('[data-rec-form]');
  // texto do registro: no editor com formatação (tela da sessão) ou num campo simples
  const ed = () => form?.recEditor || null;
  const getText = () => (ed() ? ed().text : form?.querySelector('[name=content]')?.value || '');
  const setText = (t) => { if (ed()) ed().setText(t); else { const ta = form?.querySelector('[name=content]'); if (ta) { ta.value = t; ta.rows = Math.max(ta.rows, 14); } } };
  const addText = (t) => { const cur = getText().trim(); setText(`${cur}${cur ? '\n\n' : ''}${t}`); };
  const toForm = () => { form?.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('novo-registro')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const STEPS = { transcrevendo: 'Transcrevendo o áudio…', redigindo: 'Escrevendo o rascunho da evolução…' };
  let recId = null; let rec = null; let streams = []; let actx = null; let seq = 0; const queue = []; let sending = false;
  let started = 0; let elapsed = 0; let timer = null; let paused = false; let lock = null; let raf = 0; let stopping = false; let orphan = false;

  async function post(url, body, rawBody) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: rawBody ? { 'Content-Type': 'application/octet-stream', Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: rawBody ? body : JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) { const e = new Error(d.error || `erro ${r.status}`); e.status = r.status; e.limit = d.limit; throw e; }
    return d;
  }
  const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
  async function wake() { try { if ('wakeLock' in navigator && !lock && document.visibilityState === 'visible') { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) { /* sem suporte */ } }
  document.addEventListener('visibilitychange', () => { if (rec && rec.state !== 'inactive') wake(); });
  const fmt = (ms) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`; };
  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

  async function pump() {
    if (sending) return; sending = true;
    while (queue.length) {
      const [n, blob] = queue[0];
      try { await post(`/sessao-ia/${recId}/parte?seq=${n}`, blob, true); queue.shift(); net(''); }
      catch (e) {
        if (e.limit) { queue.length = 0; say(e.message); stop(); break; }
        if (e.status && e.status >= 400 && e.status < 500) { queue.length = 0; say(`Erro ao enviar o áudio: ${e.message}`); break; }
        net('sem conexão — o áudio fica guardado e é enviado quando voltar'); await sleep(3000);
      }
    }
    sending = false;
  }
  function cleanup() {
    clearInterval(timer); cancelAnimationFrame(raf);
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams = [];
    try { actx?.close(); } catch (e) { /* já fechado */ } actx = null;
    try { lock?.release(); } catch (e) { /* ok */ } lock = null;
    window.removeEventListener('beforeunload', guard);
  }
  function meter(an) {
    const buf = new Uint8Array(an.fftSize); const bar = $s('[data-sai-level]');
    const loop = () => { an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2; bar.style.width = `${Math.min(100, Math.sqrt(sum / buf.length) * 400)}%`; raf = requestAnimationFrame(loop); };
    loop();
  }
  const now = () => elapsed + (paused || !started ? 0 : Date.now() - started);
  function tick() {
    $s('[data-sai-time]').textContent = fmt(now());
    if (now() >= maxMin * 60000) { say(`Tempo máximo de gravação (${maxMin} min) atingido: gerando o rascunho.`); stop(); }
  }

  async function start() {
    say('');
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) { say('Este navegador não grava áudio. Use Chrome, Edge, Firefox ou Safari atualizados, ou envie um arquivo de áudio.'); return; }
    const btn = $s('[data-sai-start]'); btn.disabled = true;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streams = [mic];
      actx = new (window.AudioContext || window.webkitAudioContext)(); await actx.resume();
      const dest = actx.createMediaStreamDestination(); const an = actx.createAnalyser(); an.fftSize = 512;
      const m = actx.createMediaStreamSource(mic); m.connect(dest); m.connect(an);
      if ($s('[data-sai-tab]')?.checked) {
        if (!navigator.mediaDevices.getDisplayMedia) throw new Error('este navegador não captura o som da chamada; use Chrome ou Edge no computador');
        const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streams.push(disp);
        if (!disp.getAudioTracks().length) throw new Error('o som da chamada não foi compartilhado — escolha a aba da chamada e marque “Compartilhar áudio da aba”');
        const t = actx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())); t.connect(dest); t.connect(an);
        disp.getAudioTracks()[0].addEventListener('ended', () => { net('o compartilhamento do som da chamada terminou — gravando só o microfone'); });
      }
      const mime = pickMime();
      const d = await post('/sessao-ia/iniciar', { pid, mime, source: 'gravacao', appt: sai.dataset.appt || null });
      recId = d.id; seq = 0; elapsed = 0; paused = false; stopping = false; queue.length = 0;
      rec = new MediaRecorder(dest.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) { queue.push([seq++, e.data]); pump(); } };
      rec.onstop = upload;
      rec.start(15000);
      started = Date.now(); timer = setInterval(tick, 500); tick(); meter(an);
      $s('[data-sai-pause]').textContent = 'Pausar';
      show('live'); wake(); window.addEventListener('beforeunload', guard);
    } catch (e) {
      cleanup();
      if (recId) { post(`/sessao-ia/${recId}/descartar`).catch(() => {}); recId = null; }
      say(e.name === 'NotAllowedError' ? 'Permissão negada. Libere o microfone (e o compartilhamento, se for sessão on-line) para este site nas configurações do navegador.' : `Não foi possível começar: ${e.message}`);
    } finally { btn.disabled = false; }
  }
  function pause() {
    if (!rec) return;
    if (!paused) { rec.pause(); elapsed += Date.now() - started; paused = true; $s('[data-sai-pause]').textContent = 'Continuar'; net('pausado'); }
    else { rec.resume(); started = Date.now(); paused = false; $s('[data-sai-pause]').textContent = 'Pausar'; net(''); }
  }
  function stop() {
    if (!rec || stopping || rec.state === 'inactive') return;
    stopping = true; if (!paused) elapsed += Date.now() - started; paused = true;
    rec.stop();
  }
  async function upload() {
    show('busy'); $s('[data-sai-step]').textContent = 'Enviando o áudio…';
    clearInterval(timer); cancelAnimationFrame(raf);
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    const until = Date.now() + 10 * 60e3;
    while ((queue.length || sending) && Date.now() < until) { if (!sending) pump(); await sleep(400); }
    try { await post(`/sessao-ia/${recId}/encerrar`, { duration: Math.round(elapsed / 1000) }); cleanup(); rec = null; follow(recId); }
    catch (e) { cleanup(); rec = null; showErr(`Não foi possível encerrar: ${e.message}`); }
  }
  async function cancel() {
    if (!window.confirm('Descartar esta gravação? O áudio gravado até agora será apagado.')) return;
    if (rec) { rec.onstop = null; rec.ondataavailable = null; try { rec.stop(); } catch (e) { /* ok */ } }
    queue.length = 0; cleanup(); rec = null;
    if (recId) await post(`/sessao-ia/${recId}/descartar`).catch(() => {});
    recId = null; show('idle'); say('Gravação descartada.');
  }
  function showErr(text, isOrphan = false) {
    orphan = isOrphan;
    $s('[data-sai-errmsg]').textContent = text;
    $s('[data-sai-retry]').textContent = isOrphan ? 'Gerar rascunho com o que foi gravado' : 'Tentar de novo';
    show('err');
  }
  function fill(d, ask = true) {
    if (!form) return;
    if (ask && getText().trim() && getText().trim() !== d.draft.trim() && !window.confirm('Substituir o texto do editor pelo rascunho da IA?')) return;
    setText(d.draft);
    const k = form.querySelector('[name=kind]'); if (k) k.value = 'evolucao';
    // “Demanda trazida”: preenche com a seção de demanda do rascunho, se o campo estiver vazio
    const dm = form.querySelector('[name=demand]');
    if (dm && !dm.value.trim()) dm.value = demandFrom(d.draft);
    form.querySelector('[name=sai_rec]').value = d.id;
    toForm();
  }
  async function follow(id) {
    recId = id; show('busy');
    for (;;) {
      let d;
      try { d = await (await fetch(`/sessao-ia/${id}/estado`, { credentials: 'same-origin', cache: 'no-store' })).json(); }
      catch (e) { $s('[data-sai-step]').textContent = 'Sem conexão — tentando de novo…'; await sleep(4000); continue; }
      if (!d.ok) { show('idle'); say(d.error || ''); return; }
      if (d.status === 'processando') { $s('[data-sai-step]').textContent = STEPS[d.step] || 'Processando…'; await sleep(2500); continue; }
      if (d.status === 'erro') { showErr(d.error || 'Não foi possível gerar o rascunho.'); return; }
      if (d.status === 'gravando') { showErr(`Uma gravação deste paciente foi interrompida antes de encerrar (${(d.bytes / 1048576).toFixed(1)} MB recebidos).`, true); return; }
      if (d.status === 'pronto') {
        const al = $s('[data-sai-alerts]'); al.hidden = !d.alerts; $s('[data-sai-alerts-t]').textContent = d.alerts || '';
        $s('[data-sai-tr]').textContent = d.transcript || '';
        sai._last = d; show('ready');
        // rascunho já trazido antes (e talvez editado; o texto ficou salvo no rascunho da sessão): não sobrescreve
        const already = form && String(form.querySelector('[name=sai_rec]')?.value) === String(d.id) && getText().trim();
        if (!already) fill(d, !!getText().trim());
        return;
      }
      show('idle'); return;
    }
  }
  async function sendFile(file) {
    say('');
    if (file.size > 24 * 1024 * 1024) { say('Arquivo maior que 24 MB. Exporte em qualidade de voz (mono, 32–64 kbps) ou divida a gravação.'); return; }
    const dur = await new Promise((res) => { const a = new Audio(); const t = setTimeout(() => res(0), 4000); a.preload = 'metadata'; a.onloadedmetadata = () => { clearTimeout(t); res(Number.isFinite(a.duration) ? a.duration : 0); }; a.onerror = () => { clearTimeout(t); res(0); }; a.src = URL.createObjectURL(file); });
    show('busy');
    try {
      const d = await post('/sessao-ia/iniciar', { pid, mime: file.type || 'audio/mpeg', source: 'arquivo' });
      recId = d.id; const step = 2 * 1024 * 1024; let n = 0;
      window.addEventListener('beforeunload', guard);
      for (let off = 0; off < file.size; off += step) {
        $s('[data-sai-step]').textContent = `Enviando o arquivo… ${Math.round((off / file.size) * 100)}%`;
        for (let tries = 0; ; tries++) { try { await post(`/sessao-ia/${recId}/parte?seq=${n}`, file.slice(off, off + step), true); break; } catch (e) { if (tries >= 4 || (e.status && e.status < 500)) throw e; await sleep(2000); } }
        n++;
      }
      await post(`/sessao-ia/${recId}/encerrar`, { duration: Math.round(dur) });
      window.removeEventListener('beforeunload', guard);
      follow(recId);
    } catch (e) { window.removeEventListener('beforeunload', guard); if (recId) post(`/sessao-ia/${recId}/descartar`).catch(() => {}); show('idle'); say(`Não foi possível enviar: ${e.message}`); }
  }
  async function sendText() {
    const t = $s('[data-sai-text]').value.trim();
    if (t.length < 80) { say('Cole a transcrição completa da sessão.'); return; }
    try { const d = await post('/sessao-ia/texto', { pid, text: t }); $s('[data-sai-text]').value = ''; follow(d.id); } catch (e) { say(`Não foi possível: ${e.message}`); }
  }
  async function retry() {
    try {
      if (orphan) await post(`/sessao-ia/${recId}/encerrar`, { duration: 0 }); else await post(`/sessao-ia/${recId}/tentar`);
      follow(recId);
    } catch (e) { showErr(e.message); }
  }
  async function drop() {
    if (!window.confirm('Descartar? O áudio, a transcrição e o rascunho desta gravação serão apagados.')) return;
    await post(`/sessao-ia/${recId}/descartar`).catch(() => {});
    if (form && String(form.querySelector('[name=sai_rec]').value) === String(recId)) form.querySelector('[name=sai_rec]').value = '';
    recId = null; show('idle'); say('Descartado.');
  }

  $s('[data-sai-start]').addEventListener('click', start);
  $s('[data-sai-pause]').addEventListener('click', pause);
  $s('[data-sai-stop]').addEventListener('click', stop);
  $s('[data-sai-cancel]').addEventListener('click', cancel);
  $s('[data-sai-retry]').addEventListener('click', retry);
  sai.querySelectorAll('[data-sai-drop]').forEach((b) => b.addEventListener('click', drop));
  $s('[data-sai-fill]').addEventListener('click', () => sai._last && fill(sai._last));
  // transcrição como rascunho no formulário
  $s('[data-sai-fill-tr]')?.addEventListener('click', () => {
    const d = sai._last; if (!d || !form) return;
    if (getText().trim() && !window.confirm('Substituir o texto do editor pela transcrição?')) return;
    setText(`Transcrição da sessão (revisar):\n\n${d.transcript || ''}`);
    form.querySelector('[name=sai_rec]').value = d.id;
    toForm();
  });
  // resumo curto gerado pela IA a partir da transcrição
  $s('[data-sai-summary]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; const d = sai._last; if (!d) return;
    b.disabled = true; const t0 = b.textContent; b.textContent = 'Gerando o resumo…';
    try {
      const r = await post(`/sessao-ia/${d.id}/resumo`);
      $s('[data-sai-sum-t]').textContent = r.summary; $s('[data-sai-sum]').hidden = false; say('');
    } catch (err) { say(`Não foi possível gerar o resumo: ${err.message}`); }
    b.disabled = false; b.textContent = t0;
  });
  $s('[data-sai-sum-add]')?.addEventListener('click', () => {
    const t = $s('[data-sai-sum-t]').textContent; if (!form || !t) return;
    addText(`Resumo da sessão:\n${t}`);
    if (sai._last) form.querySelector('[name=sai_rec]').value = sai._last.id;
    toForm();
  });
  $s('[data-sai-sum-copy]')?.addEventListener('click', (e) => { navigator.clipboard?.writeText($s('[data-sai-sum-t]').textContent).then(() => { e.target.textContent = 'Copiado ✓'; }); });
  $s('[data-sai-file]').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f); });
  $s('[data-sai-text-go]').addEventListener('click', sendText);
  if (!window.MediaRecorder) { $s('[data-sai-start]').disabled = true; say('Este navegador não grava áudio: envie um arquivo ou cole a transcrição.'); }
  window.__sai = () => ({ recId, state: rec?.state || '', queue: queue.length, view: ['idle', 'live', 'busy', 'err', 'ready'].find((k) => !$s(`[data-sai-${k}]`).hidden) });
  // Finalizar a sessão com a gravação ligada: encerra e espera o áudio subir (a transcrição começa em seguida)
  window.__saiStop = () => new Promise((resolve) => {
    if (!rec || rec.state === 'inactive') { resolve(false); return; }
    const t0 = Date.now();
    stop();
    const wait = setInterval(() => { const busy = !$s('[data-sai-busy]').hidden && /Enviando/.test($s('[data-sai-step]').textContent); if ((!rec && !busy) || Date.now() - t0 > 10 * 60e3) { clearInterval(wait); resolve(true); } }, 400);
  });
  // gravação em andamento de antes (página recarregada, processamento ou rascunho pendente)
  let open = []; try { open = JSON.parse(sai.dataset.open || '[]'); } catch (e) { /* vazio */ }
  const cur = open[0];
  if (cur) follow(cur.id); else show('idle');
  // veio do “Iniciar” com a preferência de gravar sozinho ligada
  if (!cur && sai.dataset.autostart === '1' && window.MediaRecorder) { sai.dataset.autostart = ''; say('Iniciando a gravação…'); start(); }
}
initSessionAI();
document.addEventListener('live:updated', initSessionAI);

// ---------- Tela da sessão: editor com formatação, rascunho salvo sozinho, CID, autorização e finalizar ----------
// “Demanda trazida”: a seção “Demanda…” do texto (rascunho da IA segue o modelo de evolução)
function demandFrom(text) {
  const m = /^\s*demanda[^:\n]*:[ \t]*([\s\S]*?)(?=\n\s*[A-ZÀ-Úa-zà-ú][^:\n]{2,60}:|(?![\s\S]))/im.exec(String(text || ''));
  return m ? m[1].trim() : '';
}
function initRecordForm() {
  // Editor (contenteditable) → campo escondido, e API para a IA colocar texto
  document.querySelectorAll('[data-rte]').forEach((box) => {
    if (box.dataset.rteInit) return; box.dataset.rteInit = '1';
    const area = box.querySelector('[data-rte-area]'); const hidden = box.querySelector('input[type=hidden]'); const form = box.closest('form');
    try { document.execCommand('styleWithCSS', false, false); document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (e) { /* navegador antigo */ }
    const sync = () => { hidden.value = area.innerHTML; box.classList.toggle('empty', !area.textContent.trim() && !area.querySelector('li')); };
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fromText = (t) => String(t || '').split('\n').map((l) => `<div>${l.trim() ? esc(l) : '<br>'}</div>`).join('');
    const exec = (cmd, val) => { area.focus(); document.execCommand(cmd, false, val); sync(); form?.dispatchEvent(new Event('input', { bubbles: true })); refresh(); };
    const refresh = () => box.querySelectorAll('[data-cmd]').forEach((b) => { try { b.classList.toggle('on', ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'].includes(b.dataset.cmd) && document.queryCommandState(b.dataset.cmd)); } catch (e) { /* ok */ } });
    box.querySelector('.rte-bar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // não perde a seleção
    box.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => exec(b.dataset.cmd)));
    const size = box.querySelector('[data-size]');
    size?.addEventListener('change', () => { if (size.value) exec('fontSize', size.value); size.value = ''; });
    area.addEventListener('input', sync);
    area.addEventListener('keyup', refresh); area.addEventListener('mouseup', refresh);
    // colar: só o texto (sem estilos de outros programas)
    area.addEventListener('paste', (e) => { const t = e.clipboardData?.getData('text/plain'); if (t == null) return; e.preventDefault(); document.execCommand('insertHTML', false, fromText(t)); sync(); });
    if (form) {
      form.recEditor = {
        get text() { return area.innerText || ''; },
        setText(t) { area.innerHTML = fromText(t); sync(); },
      };
      form.addEventListener('submit', sync);
    }
    sync();
  });
  // CID-10 / CID-11: chips com código e nome
  document.querySelectorAll('[data-cid]').forEach((fld) => {
    if (fld.dataset.cidInit) return; fld.dataset.cidInit = '1';
    const kind = fld.dataset.cid; const input = fld.querySelector('[data-cid-input]'); const chips = fld.querySelector('[data-cid-chips]');
    const names = new Map([...fld.querySelectorAll('datalist option')].map((o) => [o.value, o.textContent]));
    const ok = kind === 'cid10' ? (c) => /^[A-Z]\d{2}(\.\d{1,2})?$/.test(c) : (c) => /^[0-9A-Z]{4}(\.[0-9A-Z]{1,2})?$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c);
    const findByName = (t) => { const n = t.toLowerCase(); const hit = [...names].filter(([, v]) => v.toLowerCase().includes(n)); return hit.length === 1 ? hit[0][0] : null; };
    function add() {
      let v = input.value.trim(); if (!v) return;
      let code = v.toUpperCase().split(/[\s·]+/)[0].replace(/[^0-9A-Z.]/g, '');
      if (!ok(code)) code = findByName(v) || '';
      if (!code) { input.setCustomValidity('Código não reconhecido: digite o código (ex.: F41.1) ou escolha na lista.'); input.reportValidity(); return; }
      input.setCustomValidity('');
      if (!chips.querySelector(`[data-code="${code}"]`)) {
        const el = document.createElement('span'); el.className = 'cid-chip'; el.dataset.code = code;
        el.innerHTML = '<b></b><span></span><input type="hidden"><button type="button" data-cid-del>×</button>';
        el.querySelector('b').textContent = code; el.querySelector('span').textContent = names.get(code) || '';
        const h = el.querySelector('input'); h.name = kind; h.value = code;
        el.querySelector('button').setAttribute('aria-label', `Remover ${code}`);
        chips.appendChild(el);
        fld.closest('form')?.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.value = '';
    }
    input.addEventListener('change', add);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } else input.setCustomValidity(''); });
    chips.addEventListener('click', (e) => { const b = e.target.closest('[data-cid-del]'); if (b) { b.closest('.cid-chip').remove(); fld.closest('form')?.dispatchEvent(new Event('input', { bubbles: true })); } });
  });
  // Rascunho salvo sozinho
  document.querySelectorAll('form[data-draft-url]').forEach((form) => {
    if (form.dataset.draftInit) return; form.dataset.draftInit = '1';
    const url = form.dataset.draftUrl; const st = form.querySelector('[data-draft-state]');
    let timer = null; let dirty = false; let saving = false; let submitted = false;
    const data = () => {
      form.querySelector('[data-rte] input[type=hidden]') && (form.querySelector('[data-rte] input[type=hidden]').value = form.querySelector('[data-rte-area]').innerHTML);
      const fd = new FormData(form); const o = {};
      for (const [k, v] of fd.entries()) { if (k === 'cid10' || k === 'cid11') (o[k] = o[k] || []).push(v); else o[k] = v; }
      return o;
    };
    async function save(keep = false) {
      if (!dirty || submitted) return; if (saving && !keep) { clearTimeout(timer); timer = setTimeout(save, 1200); return; }
      saving = true; dirty = false; if (st) st.textContent = 'Salvando rascunho…';
      try {
        const r = await fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: keep, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data()) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || r.status);
        if (st) { st.textContent = `Rascunho salvo às ${d.at}`; st.classList.remove('err'); }
      } catch (e) { dirty = true; if (st) { st.textContent = 'Sem conexão — o rascunho será salvo assim que voltar'; st.classList.add('err'); } clearTimeout(timer); timer = setTimeout(save, 5000); }
      saving = false;
    }
    form.addEventListener('input', () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 1500); if (st) st.textContent = 'Alterações não salvas…'; });
    form.addEventListener('change', () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 1500); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });
    window.addEventListener('pagehide', () => save(true));
    window.addEventListener('beforeunload', (e) => { if (dirty && !submitted) { save(true); e.preventDefault(); e.returnValue = ''; } });
    form.addEventListener('submit', (e) => {
      const sai = window.__sai?.();
      if (sai && (sai.view === 'live' || sai.view === 'busy') && !window.confirm('A gravação ou a transcrição ainda está em andamento. Salvar o registro assim mesmo?')) { e.preventDefault(); return; }
      submitted = true; clearTimeout(timer);
    });
    form.querySelector('[data-draft-drop]')?.addEventListener('click', async () => {
      if (!window.confirm('Descartar o rascunho? O texto escrito aqui será apagado.')) return;
      submitted = true; clearTimeout(timer);
      await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ drop: 1 }) }).catch(() => {});
      location.reload();
    });
  });
  // Mostrar campos conforme uma escolha (ex.: Convênio → selecionar o convênio)
  document.querySelectorAll('[data-show-when]').forEach((el) => {
    if (el.dataset.swInit) return; el.dataset.swInit = '1';
    const [name, val] = el.dataset.showWhen.split('='); const form = el.closest('form'); if (!form) return;
    const upd = () => { const on = form.querySelector(`[name="${name}"]:checked`)?.value === val; el.hidden = !on; el.querySelectorAll('select, input').forEach((i) => { if (i.name === 'insurer_id' || i.name === 'card') i.required = on; }); };
    form.querySelectorAll(`[name="${name}"]`).forEach((r) => r.addEventListener('change', upd)); upd();
  });
}
initRecordForm();
document.addEventListener('live:updated', initRecordForm);

(() => {
  const jpost = async (url, body) => {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `erro ${r.status}`);
    return d;
  };
  // Preferência: começar a gravar sozinho ao iniciar
  document.addEventListener('change', async (e) => {
    const c = e.target.closest('[data-sai-autopref]'); if (!c) return;
    try { await jpost('/sessao-ia/preferencia', { auto_rec: c.checked }); } catch (err) { c.checked = !c.checked; alert(`Não foi possível salvar: ${err.message}`); }
  });
  // Paciente sem autorização: papel / enviar / sem gravar
  const dlg = document.querySelector('dialog[data-sai-ask]');
  if (dlg?.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sai-consent]'); if (!b) return;
    const box = b.closest('[data-sai-ask], [data-sai-ask-inline]'); const pid = box.dataset.pid; const msg = box.querySelector('[data-sai-consent-msg]');
    const act = b.dataset.saiConsent;
    const close = () => { document.querySelectorAll('dialog[data-sai-ask]').forEach((d) => { try { d.close(); } catch (x) { d.removeAttribute('open'); } }); };
    if (act === 'sem') { close(); return; }
    if (act === 'papel' && !window.confirm('Confirma que o paciente assinou em papel a autorização de gravação e uso de IA? Guarde o documento assinado.')) return;
    box.querySelectorAll('button').forEach((x) => { x.disabled = true; }); if (msg) msg.textContent = act === 'enviar' ? 'Enviando…' : 'Registrando…';
    try {
      const d = await jpost(`/sessao-ia/autorizacao/${pid}`, { acao: act });
      if (act === 'papel') { const u = new URL(location.href); u.searchParams.set('auto', '1'); location.replace(u.toString()); return; } // recarrega já gravando
      close();
      document.querySelectorAll('[data-sai-consent-msg]').forEach((m) => { m.textContent = d.message || 'Termo enviado.'; });
    } catch (err) { if (msg) msg.textContent = `Não foi possível: ${err.message}`; }
    box.querySelectorAll('button').forEach((x) => { x.disabled = false; });
  });

  // Finalizar a sessão: encerra a gravação (vai para a transcrição), muda para Finalizado na recepção e pergunta o pagamento
  const wrap = document.querySelector('[data-ses]');
  const payDlg = document.querySelector('[data-pay-dlg]');
  async function finish(apptId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Finalizando…'; }
    try {
      if (window.__saiStop) await window.__saiStop();
      const d = await jpost(`/recepcao/${apptId}/finalizar`, {});
      document.querySelectorAll('.ses-st').forEach((el) => { el.className = 'ses-st ses-realizada'; el.innerHTML = '<i aria-hidden="true"></i><span>Finalizado</span>'; });
      btn?.remove();
      openPay(apptId, d);
    } catch (err) { if (btn) { btn.disabled = false; btn.textContent = '■ Finalizar sessão'; } alert(`Não foi possível finalizar: ${err.message}`); }
  }
  function openPay(apptId, d) {
    if (!payDlg) return;
    const q = payDlg.querySelector('[data-pay-q]'); const msg = payDlg.querySelector('[data-pay-msg]'); const opts = payDlg.querySelector('.ask-opts'); const ok = payDlg.querySelector('[data-pay-ok]'); const meth = payDlg.querySelector('[data-pay-method]');
    msg.textContent = '';
    if (!d.pay || !d.ask) {
      opts.hidden = true; meth.hidden = true;
      q.textContent = d.pay ? (d.pay.paid ? `Pagamento de ${d.pay.amountText} já registrado${d.pay.method ? ` (${d.pay.method})` : ''}.` : `Pagamento de ${d.pay.amountText} a receber pela recepção.`) : (d.info || 'Nada a cobrar nesta sessão.');
      ok.textContent = 'Fechar'; ok.onclick = () => payDlg.close();
    } else {
      opts.hidden = false;
      q.textContent = `O paciente pagou esta sessão (${d.pay.amountText})${d.pay.receiver === 'profissional' ? ' para você' : ''}?`;
      const sync = () => { meth.hidden = payDlg.querySelector('[name=pago]:checked')?.value !== 'sim'; };
      payDlg.querySelectorAll('[name=pago]').forEach((r) => { r.onchange = sync; }); sync();
      ok.textContent = 'Confirmar';
      ok.onclick = async () => {
        ok.disabled = true;
        try {
          const r = await jpost(`/recepcao/${apptId}/pagamento`, { pago: payDlg.querySelector('[name=pago]:checked')?.value, method: payDlg.querySelector('[name=method]').value });
          opts.hidden = true; meth.hidden = true; q.textContent = r.message || 'Registrado.'; ok.textContent = 'Fechar'; ok.onclick = () => payDlg.close();
        } catch (err) { msg.textContent = err.message; }
        ok.disabled = false;
      };
    }
    try { payDlg.showModal(); } catch (e) { payDlg.setAttribute('open', ''); }
    // a transcrição continua no painel; o editor recebe o rascunho quando ficar pronto
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ses-finish]'); if (!b) return;
    if (!window.confirm('Finalizar a sessão? A gravação (se houver) é encerrada e a transcrição começa.')) return;
    finish(b.dataset.sesFinish, b);
  });
  // vindo da teleconsulta (Encerrar): finaliza e pergunta o pagamento automaticamente
  if (wrap?.dataset.sesFim === '1' && wrap.dataset.sesAppt) {
    const u = new URL(location.href); u.searchParams.delete('fim'); history.replaceState(null, '', u.toString());
    finish(wrap.dataset.sesAppt, document.querySelector('[data-ses-finish]'));
  }
})();

// ---------- Identidade da clínica: envio da logo (arquivo direto, sem formulário de várias partes) ----------
document.querySelectorAll('[data-logo-file]').forEach((inp) => inp.addEventListener('change', async () => {
  const f = inp.files[0]; if (!f) return;
  const form = inp.closest('[data-logo-form]'); const msg = form.querySelector('[data-logo-msg]');
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = `small ${bad ? 'err-txt' : 'muted'}`; } else if (bad) alert(t); };
  const type = f.type || (/\.png$/i.test(f.name) ? 'image/png' : /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : /\.webp$/i.test(f.name) ? 'image/webp' : '');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) { say('Envie a logo em PNG, JPG ou WebP (SVG e PDF não são aceitos).', true); inp.value = ''; return; }
  if (f.size > 2 * 1024 * 1024) { say(`A logo tem ${(f.size / 1048576).toFixed(1)} MB; o limite é 2 MB. Exporte em tamanho menor.`, true); inp.value = ''; return; }
  say('Enviando a logo…');
  try {
    const r = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type, Accept: 'application/json' }, body: f });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
    say('Logo salva. Atualizando…'); location.reload();
  } catch (e) { say(`Não foi possível enviar a logo: ${e.message}`, true); inp.value = ''; }
}));

// ---------- Painel Mentez: rótulos das colunas (no celular cada linha da tabela vira um cartão) e fechar o menu ----------
document.querySelectorAll('.mz2-table table').forEach((t) => {
  const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; }));
});
document.addEventListener('keydown', (e) => { const ck = document.getElementById('mz2-menu'); if (e.key === 'Escape' && ck?.checked) ck.checked = false; });

// ---------- Mentez: criar conta (sugere o endereço pelo nome do consultório e confere se está livre) ----------
(() => {
  const f = document.querySelector('[data-signup]'); if (!f) return;
  const clinic = f.querySelector('[data-signup-clinic]'); const slug = f.querySelector('[data-signup-slug]'); const msg = f.querySelector('[data-signup-slug-msg]');
  let touched = false; let timer = null;
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(dra?|clinica|consultorio|psicologa?|psi)\.?\s+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const check = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const v = slug.value.trim(); if (!v) { msg.textContent = 'Letras minúsculas, números e hífen.'; msg.className = 'muted'; return; }
    try { const d = await (await fetch(`/criar-conta/endereco?s=${encodeURIComponent(v)}`)).json(); msg.textContent = d.ok ? `✓ ${v}.${location.hostname.split('.').slice(1).join('.')} está livre` : d.reason; msg.className = d.ok ? 'small ok' : 'small bad'; slug.setCustomValidity(d.ok ? '' : d.reason || 'Endereço indisponível'); } catch (e) { /* rede */ }
  }, 350); };
  clinic.addEventListener('input', () => { if (!touched) { slug.value = norm(clinic.value); check(); } });
  slug.addEventListener('input', () => { touched = true; slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); check(); });
})();

// ---------- Instalar como aplicativo (PWA) ----------
// O botão fica sempre visível até instalar. Onde o navegador permite (Chrome, Edge, Android) instala com um toque;
// nos outros, mostra o passo a passo daquele navegador.
(() => {
  const btns = [...document.querySelectorAll('[data-install]')];
  if (!btns.length) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } } };
  if (standalone) { store.set('installed', '1'); return; }
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const edge = /Edg\//.test(ua); const samsung = /SamsungBrowser/.test(ua); const firefox = /Firefox\/|FxiOS/.test(ua);
  const chrome = /Chrome\/|CriOS/.test(ua) && !edge && !samsung;
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua);
  const banner = document.querySelector('[data-install-banner]');
  const dlg = document.querySelector('[data-install-dlg]');
  const portal = location.pathname.startsWith('/paciente');
  let deferred = null;
  const later = () => { const t = Number(store.get('install-later') || 0); return t > 1 && Date.now() - t < 30 * 864e5; };
  const done = () => { btns.forEach((b) => { b.hidden = true; }); if (banner) banner.hidden = true; };
  function offer() {
    if (store.get('installed') === '1') return;
    btns.forEach((b) => { b.hidden = false; });
    if (banner && (location.pathname === '/' || location.pathname === '/paciente') && !later()) banner.hidden = false;
  }
  function steps() {
    const ol = dlg.querySelector('[data-install-steps]');
    const name = `“${document.querySelector('meta[name=apple-mobile-web-app-title]')?.content || (portal ? 'Portal do paciente' : 'Consultório')}”`;
    let items;
    if (ios) items = ['No Safari, toque em Compartilhar (o quadrado com a seta para cima ⬆️), na barra de baixo ou no topo.', 'Role a lista e toque em “Adicionar à Tela de Início”.', `Confirme em “Adicionar”. O ícone ${name} aparece na tela inicial.`];
    else if (macSafari) items = ['No Safari, abra o menu Arquivo (ou o botão Compartilhar).', 'Escolha “Adicionar ao Dock”.', 'Confirme em “Adicionar”.'];
    else if (samsung) items = ['Toque no menu (☰) do Samsung Internet.', 'Escolha “Adicionar página a” → “Tela inicial”.'];
    else if (firefox && android) items = ['Toque no menu (⋮) do Firefox.', 'Escolha “Instalar” (ou “Adicionar à tela inicial”).'];
    else if (firefox) items = ['O Firefox no computador não instala aplicativos.', 'Abra este endereço no Chrome ou no Edge e clique em “Instalar aplicativo”.'];
    else if (android) items = ['Toque no menu (⋮) do navegador, no canto de cima.', 'Escolha “Instalar app” ou “Adicionar à tela inicial”.', `Confirme. O ícone ${name} aparece junto dos outros aplicativos.`];
    else if (edge) items = ['Clique no menu (…) do Edge, no canto de cima.', 'Escolha “Aplicativos” → “Instalar este site como aplicativo”.', 'Confirme em “Instalar”.'];
    else if (chrome) items = ['Clique no ícone de instalar (um monitor com uma seta ⤓) no fim da barra de endereço,', 'ou abra o menu (⋮) → “Transmitir, salvar e compartilhar” → “Instalar página como app”.', 'Confirme em “Instalar”. Se a opção não aparecer, o aplicativo já está instalado neste computador: procure o ícone no menu Iniciar ou no Launchpad.'];
    else items = ['No menu do navegador, procure “Instalar aplicativo” ou “Adicionar à tela inicial”.', 'Se não houver essa opção, abra este endereço no Chrome, Edge ou Safari.'];
    ol.replaceChildren(...items.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  }
  async function install() {
    if (deferred) {
      deferred.prompt();
      const r = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (r && r.outcome === 'accepted') { store.set('installed', '1'); done(); }
      return;
    }
    if (dlg) { steps(); if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; store.set('installed', ''); offer(); });
  window.addEventListener('appinstalled', () => { deferred = null; store.set('installed', '1'); done(); });
  offer();
  btns.forEach((b) => b.addEventListener('click', () => { b.closest('details')?.removeAttribute('open'); install(); }));
  banner?.querySelector('[data-install-go]').addEventListener('click', install);
  banner?.querySelector('[data-install-later]').addEventListener('click', () => { banner.hidden = true; store.set('install-later', String(Date.now())); });
  window.__install = () => ({ buttons: btns.filter((b) => !b.hidden).length, banner: banner ? !banner.hidden : false, deferred: !!deferred, ios, macSafari });
})();

// Sugestões que preenchem um campo com um toque (ex.: finalidade e solicitante dos documentos)
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fill]');
  if (!b) return;
  const inp = document.querySelector(b.dataset.fill);
  if (!inp) return;
  inp.value = b.dataset.value;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  b.parentElement.querySelectorAll('[data-fill]').forEach((x) => x.classList.toggle('on', x === b));
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.id) return;
  document.querySelectorAll(`button[data-fill="#${CSS.escape(t.id)}"]`).forEach((x) => x.classList.toggle('on', x.dataset.value === t.value));
});

// ---------- Locação: formulário de reserva (tipo de locação, novo locatário e total ao vivo) ----------
document.querySelectorAll('form[data-rental]').forEach((f) => {
  const tsel = f.querySelector('[data-rt-tenant]'); const newt = f.querySelector('[data-rt-newt]');
  const syncT = () => { if (!newt) return; const on = !tsel.value; newt.hidden = !on; const n = newt.querySelector('[name=t_name]'); if (n) n.required = on; };
  if (tsel) { tsel.addEventListener('change', syncT); syncT(); }
  let prices = {}; try { prices = JSON.parse(f.dataset.prices || '{}'); } catch (e) { /* sem preços */ }
  const out = f.querySelector('[data-rt-total]'); const calc = f.querySelector('[data-rt-calc]');
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const m = (t) => { const [h, mi] = String(t || '').split(':').map(Number); return h * 60 + mi; };
  function update() {
    const unit = (f.querySelector('[name=unit]:checked') || {}).value;
    f.querySelectorAll('[data-rt-show]').forEach((el) => { el.hidden = el.dataset.rtShow !== unit; });
    if (!out) return;
    const p = prices[(f.querySelector('[name=space_id]') || {}).value] || {};
    let v = 0; let txt = '';
    if (unit === 'hora') { const s = f.querySelector('[name=start]').value; const e = f.querySelector('[name=end]').value; const h = s && e && e > s ? (m(e) - m(s)) / 60 : 0; v = h * (p.h || 0); txt = p.h ? `${String(h).replace('.', ',')} h × ${brl(p.h)}${h && h < p.min ? ` (mínimo ${p.min} h)` : ''}` : 'este espaço não aluga por hora'; }
    else if (unit === 'periodo') { const n = f.querySelectorAll('[name=periods]:checked').length; v = n * (p.p || 0); txt = p.p ? `${n} período(s) × ${brl(p.p)}` : 'este espaço não aluga por período'; }
    else if (unit === 'diaria') { const a = f.querySelector('[name=date]').value; const z = f.querySelector('[name=date_end]').value || a; const d = a && z >= a ? Math.round((new Date(`${z}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5) + 1 : 0; v = d * (p.d || 0); txt = p.d ? `${d} diária(s) × ${brl(p.d)}` : 'este espaço não aluga por diária'; }
    const disc = Number(String((f.querySelector('[name=discount]') || {}).value || '0').replace(',', '.')) || 0;
    out.textContent = brl(Math.max(0, v - disc)); calc.textContent = txt + (disc ? ` − ${brl(disc)}` : '');
  }
  f.addEventListener('input', update); f.addEventListener('change', update); update();
});

// ---------- Painel de chamadas: escolha e teste da voz neural ----------
document.querySelectorAll('[data-tts]').forEach((box) => {
  const eng = box.querySelector('[data-tts-engine]'); const voice = box.querySelector('[data-tts-voice]');
  const msg = box.querySelector('[data-tts-msg]');
  const sync = () => {
    const e = eng.value; const neural = e !== 'navegador';
    voice.querySelectorAll('optgroup').forEach((g) => { g.hidden = g.dataset.engine !== e; g.disabled = g.dataset.engine !== e; });
    if (!voice.selectedOptions[0] || voice.selectedOptions[0].dataset.engine !== e) { const first = voice.querySelector(`option[data-engine="${e}"]`); if (first) voice.value = first.value; }
    box.querySelectorAll('[data-tts-voice], [data-tts-key], [name=ttsRate], [data-tts-test]').forEach((el) => { (el.closest('.fld') || el).hidden = !neural; });
    const az = box.querySelector('[data-tts-azure]'); if (az) az.hidden = e !== 'azure';
  };
  eng.addEventListener('change', sync); sync();
  let audio = null;
  box.querySelector('[data-tts-test]').addEventListener('click', async (ev) => {
    const b = ev.currentTarget; b.disabled = true; msg.textContent = 'Gerando…';
    try {
      const f = box.closest('form');
      const r = await fetch('/configuracoes/tv/voz-teste', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: eng.value, voice: voice.value, rate: f.querySelector('[name=ttsRate]').value, key: f.querySelector('[name=ttsKey]').value, region: (f.querySelector('[name=ttsRegion]') || {}).value }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `erro ${r.status}`); }
      const url = URL.createObjectURL(await r.blob());
      if (audio) audio.pause();
      audio = new Audio(url); await audio.play(); msg.textContent = '▶ Tocando…'; window.__ttsTested = 1;
      audio.onended = () => { msg.textContent = 'Gostou? Clique em Salvar.'; };
    } catch (e) { msg.textContent = `Não foi possível: ${e.message}`; } finally { b.disabled = false; }
  });
});

// Cadastro de usuário: “Atende pacientes” e modalidades só para perfis clínicos
document.querySelectorAll('[data-attend-box]').forEach((box) => {
  const f = box.closest('form'); const att = box.querySelector('[data-attend]'); const mods = box.querySelector('[data-attend-mods]');
  const sync = () => {
    const role = (f.querySelector('[name=role]:checked') || {}).value;
    box.hidden = !['admin', 'psicologo'].includes(role);
    mods.querySelectorAll('input').forEach((i) => { i.disabled = !att.checked; });
  };
  f.addEventListener('change', sync); sync();
});

// ---------- Faixa “Em atendimento” na ficha: atualiza sozinha (sem trocar o resto da tela, que pode ter um registro sendo digitado) ----------
(() => {
  let busyAtt = false;
  const refreshAtt = async () => {
    const cur = document.getElementById('atendimento'); if (!cur || busyAtt || document.hidden) return;
    if (cur.querySelector('details[open]')) return; // finalizando (com o pagamento aberto): não mexe
    busyAtt = true;
    try {
      const r = await fetch(location.href, { headers: { 'X-Live': '1' }, credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const nw = doc.getElementById('atendimento'); const now = document.getElementById('atendimento');
      if (nw && now && nw.innerHTML !== now.innerHTML) now.replaceWith(nw); else if (!nw && now) now.remove();
    } catch { /* tenta de novo depois */ } finally { busyAtt = false; }
  };
  if (document.getElementById('atendimento')) setInterval(refreshAtt, 8000);
  document.addEventListener('live:topics', refreshAtt);
})();

// ---------- Teleconsulta no formulário da sessão: plataforma só para on-line; link só no “manual” ----------
document.querySelectorAll('[data-tele-prov]').forEach((sel) => {
  const f = sel.closest('form'); const mod = f.querySelector('[name=modality]');
  const sync = () => {
    const on = !mod || mod.value === 'online';
    f.querySelectorAll('[data-tele-only]').forEach((el) => { el.hidden = !on; });
    const man = f.querySelector('[data-tele-manual]'); if (man && on) man.hidden = !['', 'manual'].includes(sel.value); // no padrão dá para colar um link (vira “outro link”)
  };
  sel.addEventListener('change', sync); mod?.addEventListener('change', sync); sync();
});

// ---------- Relatórios (BI): dicas, filtros e impressão ----------
document.querySelectorAll('[data-bi]').forEach((root) => {
  const tip = document.createElement('div'); tip.className = 'bi-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip);
  let cur = null; let shownAt = 0;
  const show = (el, x, y) => {
    cur = el; shownAt = Date.now(); tip.textContent = el.dataset.tip; tip.hidden = false;
    const w = tip.offsetWidth; const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)); const top = y - h - 14 < 8 ? y + 18 : y - h - 14;
    tip.style.left = `${left + window.scrollX}px`; tip.style.top = `${top + window.scrollY}px`;
    root.querySelectorAll('.bi-on').forEach((e) => e !== el && e.classList.remove('bi-on')); el.classList.add('bi-on');
  };
  const hide = () => { tip.hidden = true; cur?.classList.remove('bi-on'); cur = null; };
  root.addEventListener('pointermove', (e) => { const el = e.target.closest('[data-tip]'); if (el && root.contains(el)) show(el, e.clientX, e.clientY); else if (cur) hide(); });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) { const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top); } });
  root.addEventListener('focusout', hide);
  window.addEventListener('scroll', () => { if (cur && Date.now() - shownAt > 250) hide(); }, { passive: true });
});
document.querySelectorAll('[data-bi-filters]').forEach((f) => {
  const preset = f.querySelector('[data-bi-preset]');
  const custom = f.querySelectorAll('.bi-custom');
  const cmp = f.querySelector('[name=cmp][type=checkbox]'); const off = f.querySelector('[data-bi-cmp-off]');
  const sync = () => { custom.forEach((el) => { el.hidden = preset.value !== 'custom'; }); if (off) off.disabled = !!cmp?.checked; };
  f.addEventListener('change', (e) => { sync(); if (e.target.name === 'de' || e.target.name === 'ate') return; if (e.target === preset && preset.value === 'custom') return; f.requestSubmit(); });
  f.addEventListener('submit', sync);
  sync();
});
document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('details.bi-data').forEach((d) => { d.dataset.wasOpen = d.open ? '1' : ''; }); window.print(); }));

// Lembretes por SMS: campos do serviço escolhido e contagem de caracteres
document.querySelectorAll('[data-sms-provider]').forEach((box) => {
  const f = box.closest('form');
  const sync = () => { const v = (f.querySelector('[name=smsProvider]:checked') || {}).value || 'zenvia'; f.querySelectorAll('[data-sms-only]').forEach((el) => { el.hidden = el.dataset.smsOnly !== v; }); };
  box.addEventListener('change', sync); sync();
});
document.querySelectorAll('[data-sms-count]').forEach((ta) => {
  const out = ta.parentElement.querySelector('[data-sms-len]');
  // estimativa: variáveis viram textos de tamanho típico; o link de confirmação tem ~55 caracteres
  const SAMPLE = { nome: 'Marina', quando: 'amanha, quinta', data: '18/11/2026', data_curta: '18/11', hora: '19:00', dia_semana: 'quinta', modalidade: 'on-line', profissional: 'Dra. Ana Souza', link: '', confirmar: `${location.origin}/l/1234.abcdefghijkl`, clinica: document.querySelector('meta[name=apple-mobile-web-app-title]')?.content || 'Consultório' };
  const upd = () => {
    const t = ta.value.replace(/\{(\w+)\}/g, (m, k) => (k in SAMPLE ? SAMPLE[k] : m)).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const n = t.length;
    out.textContent = `≈ ${n} caracteres${n > 160 ? ` · ${Math.ceil(n / 153)} SMS por lembrete` : ' · 1 SMS'}`;
  };
  ta.addEventListener('input', upd); upd();
});

// Cobrança online: mostra só os campos do serviço escolhido (Asaas ou Mercado Pago)
document.querySelectorAll('[data-gw-provider]').forEach((box) => {
  const f = box.closest('form');
  const sync = () => { const v = (f.querySelector('[name=provider]:checked') || {}).value || 'asaas'; f.querySelectorAll('[data-gw-only]').forEach((el) => { el.hidden = el.dataset.gwOnly !== v; }); };
  box.addEventListener('change', sync); sync();
});

// Teleconsulta: paciente na sala de espera aguardando autorização — aviso com alerta sonoro em qualquer tela do sistema
(() => {
  if (!document.body.dataset.telePoll) return;
  let ctx = null; let box = null; let last = ''; let timer = null; let muted = false;
  try { muted = localStorage.getItem('tele-mute') === '1'; } catch { /* ok */ }
  const unlock = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume?.(); } catch { /* sem som */ } };
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { once: true, capture: true }));
  const chime = () => {
    if (muted || !ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    [[880, 0], [1175, 0.18], [1568, 0.36]].forEach(([f, d]) => {
      const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.25, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.6);
      o.connect(g).connect(ctx.destination); o.start(t0 + d); o.stop(t0 + d + 0.65);
    });
  };
  const bell = '<svg class="ti" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>';
  function show(rooms) {
    const key = rooms.map((r) => r.id).join(',');
    if (!rooms.length) { box?.remove(); box = null; last = ''; clearInterval(timer); timer = null; return; }
    if (key === last && box) return;
    const isNew = rooms.some((r) => !last.split(',').includes(String(r.id)));
    last = key; box?.remove();
    const r = rooms[0];
    box = document.createElement('div'); box.className = 'tele-toast'; box.setAttribute('role', 'alert');
    const ic = document.createElement('span'); ic.className = 'tele-admit-ic'; ic.innerHTML = bell;
    const tx = document.createElement('div'); const b = document.createElement('b'); b.textContent = rooms.length > 1 ? `${rooms.length} pacientes na sala de espera` : `${r.name} está na sala de espera`;
    const sm = document.createElement('small'); sm.textContent = 'Teleconsulta: aguardando a sua autorização para entrar'; tx.append(b, sm);
    const go = document.createElement('a'); go.className = 'btn'; go.href = r.url; go.textContent = 'Entrar e autorizar';
    const mu = document.createElement('button'); mu.type = 'button'; mu.className = 'x'; mu.title = muted ? 'Ativar o som' : 'Silenciar'; mu.textContent = muted ? '🔕' : '🔔';
    mu.addEventListener('click', () => { muted = !muted; try { localStorage.setItem('tele-mute', muted ? '1' : '0'); } catch { /* ok */ } mu.textContent = muted ? '🔕' : '🔔'; mu.title = muted ? 'Ativar o som' : 'Silenciar'; if (!muted) { unlock(); chime(); } });
    box.append(ic, tx, go, mu); document.body.appendChild(box);
    if (isNew) chime();
    clearInterval(timer); timer = setInterval(chime, 15000);
  }
  async function poll() {
    if (document.hidden && !box) return;
    try { const r = await fetch('/teleconsulta/espera', { credentials: 'same-origin', headers: { Accept: 'application/json' } }); if (r.ok) show((await r.json()).rooms || []); } catch { /* tenta de novo */ }
  }
  poll(); setInterval(poll, 6000);
})();

// Painel TV → Mídia e campanhas: arrastar para mudar a ordem de exibição
document.querySelectorAll('[data-tvc-sort]').forEach((ul) => {
  let drag = null;
  ul.addEventListener('dragstart', (e) => { const li = e.target.closest('li[data-id]'); if (!li || !e.target.closest('.tvc-grip')) return; drag = li; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', li.dataset.id); e.dataTransfer.setDragImage(li, 20, 20); } catch { /* ok */ } });
  ul.addEventListener('dragover', (e) => {
    if (!drag) return; e.preventDefault();
    const over = e.target.closest('li[data-id]'); if (!over || over === drag || over.parentNode !== ul) return;
    const r = over.getBoundingClientRect(); ul.insertBefore(drag, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
  });
  ul.addEventListener('drop', (e) => { if (drag) e.preventDefault(); });
  ul.addEventListener('dragend', async () => {
    if (!drag) return; drag.classList.remove('dragging'); drag = null;
    const ids = [...ul.querySelectorAll(':scope > li[data-id]')].map((li) => Number(li.dataset.id));
    try { const r = await fetch(ul.dataset.tvcSort, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ids }) }); if (!r.ok) throw new Error(); location.reload(); } catch { location.reload(); }
  });
});

// Conta → Certificado digital: lê o arquivo .pfx e envia junto com o formulário (em base64)
document.querySelectorAll('[data-cert-form]').forEach((f) => {
  f.addEventListener('submit', async (e) => {
    const inp = f.querySelector('[data-cert-file]'); const file = inp?.files?.[0];
    if (!file || f.pfx.value) return; // sem arquivo novo: o servidor responde o que falta
    e.preventDefault();
    if (file.size > 60 * 1024) { alert('Arquivo grande demais para um certificado A1.'); return; }
    const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    f.pfx.value = btoa(bin); inp.value = ''; f.submit();
  });
});

// Marketing: gerar mensagens com IA (3 opções; “Usar esta” troca o texto da caixa)
document.querySelectorAll('[data-mkt-ai]').forEach((box) => {
  const out = box.querySelector('[data-mkt-out]'); const go = box.querySelector('[data-mkt-go]');
  const target = document.querySelector(box.dataset.target);
  go.addEventListener('click', async () => {
    go.disabled = true; out.textContent = 'Gerando…';
    try {
      const r = await fetch('/marketing/ia', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ kind: box.dataset.mktAi, tone: box.querySelector('[data-mkt-tone]').value, current: target?.value || '' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `erro ${r.status}`);
      out.textContent = '';
      d.options.forEach((o, i) => {
        const card = document.createElement('div'); card.className = 'mkt-opt';
        const p = document.createElement('p'); p.textContent = o.text; card.append(p);
        if (o.risks?.length) { const w = document.createElement('small'); w.className = 'err-txt'; w.textContent = `Atenção: ${o.risks.join(', ')}.`; card.append(w); }
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost btn-sm'; b.textContent = 'Usar esta';
        b.dataset.mktUse = String(i);
        b.addEventListener('click', () => { if (target) { target.value = o.text; target.dispatchEvent(new Event('input', { bubbles: true })); target.focus(); } out.querySelectorAll('.mkt-opt').forEach((c) => c.classList.remove('on')); card.classList.add('on'); });
        card.append(b); out.append(card);
      });
      const tip = document.createElement('small'); tip.className = 'muted'; tip.textContent = 'Revise o texto e clique em Salvar para começar a usar.'; out.append(tip);
    } catch (e) { out.textContent = `Não foi possível gerar: ${e.message}`; }
    go.disabled = false;
  });
});

// Agenda → nova sessão: o campo “Atendimento” mostra os convênios do paciente escolhido (padrão: o da ficha)
(() => {
  const ps = document.querySelector('select[name=patient_id]'); const pl = document.querySelector('[data-ins-plan]');
  if (!ps || !pl || ps.disabled) return;
  const fill = () => {
    const o = ps.selectedOptions[0]; let plans = []; try { plans = JSON.parse(o?.dataset.plans || '[]'); } catch { /* sem convênio */ }
    pl.innerHTML = ''; pl.append(new Option('Particular', '0'));
    for (const [id, n] of plans) pl.append(new Option(`Convênio · ${n}`, String(id)));
    pl.value = o?.dataset.defplan || '0';
    pl.closest('[data-ins-field]').hidden = !plans.length;
  };
  ps.addEventListener('change', fill); fill();
})();

// ---------- Máscaras de CPF, CNPJ e telefone (e validação do CPF/CNPJ enquanto digita) ----------
(() => {
  const D = (v) => String(v || '').replace(/\D/g, '');
  const cpfOk = (d) => { if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false; const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; }; return dv(9) === +d[9] && dv(10) === +d[10]; };
  const cnpjOk = (d) => { if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false; const dv = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = w.reduce((a, x, i) => a + x * +d[i], 0) % 11; return r < 2 ? 0 : 11 - r; }; return dv(12) === +d[12] && dv(13) === +d[13]; };
  const fCpf = (d) => { d = d.slice(0, 11); let o = d.slice(0, 3); if (d.length > 3) o += `.${d.slice(3, 6)}`; if (d.length > 6) o += `.${d.slice(6, 9)}`; if (d.length > 9) o += `-${d.slice(9)}`; return o; };
  const fCnpj = (d) => { d = d.slice(0, 14); let o = d.slice(0, 2); if (d.length > 2) o += `.${d.slice(2, 5)}`; if (d.length > 5) o += `.${d.slice(5, 8)}`; if (d.length > 8) o += `/${d.slice(8, 12)}`; if (d.length > 12) o += `-${d.slice(12)}`; return o; };
  const fTel = (d) => { if (d.length > 11 && d.startsWith('55')) d = d.slice(2); d = d.slice(0, 11); if (!d) return ''; if (d.length <= 2) return `(${d}`; const n = d.slice(2); const cut = d.length === 11 ? 5 : 4; return `(${d.slice(0, 2)}) ${n.length > cut ? `${n.slice(0, cut)}-${n.slice(cut)}` : n}`; };
  const KIND = {
    cpf: { fmt: fCpf, max: 14, check: (d) => (!d ? '' : d.length < 11 ? 'CPF incompleto: são 11 números.' : cpfOk(d) ? '' : 'CPF inválido: confira os números.') },
    cnpj: { fmt: fCnpj, max: 18, check: (d) => (!d ? '' : d.length < 14 ? 'CNPJ incompleto: são 14 números.' : cnpjOk(d) ? '' : 'CNPJ inválido: confira os números.') },
    doc: { fmt: (d) => (d.length > 11 ? fCnpj(d) : fCpf(d)), max: 18, check: (d) => (!d ? '' : d.length === 11 ? (cpfOk(d) ? '' : 'CPF inválido: confira os números.') : d.length === 14 ? (cnpjOk(d) ? '' : 'CNPJ inválido: confira os números.') : 'Informe um CPF (11 números) ou CNPJ (14 números).') },
    tel: { fmt: fTel, max: 15, check: (d) => (!d || d.length >= 10 ? '' : 'Telefone incompleto: informe o DDD e o número.') },
  };
  const kindOf = (el) => el.dataset.mask || (/(^|_)cpf$/.test(el.name) ? 'cpf' : /^(t_)?doc$/.test(el.name) ? 'doc' : (el.type === 'tel' || el.inputMode === 'tel') ? 'tel' : null);
  function apply(el) {
    if (el.dataset.masked || el.tagName !== 'INPUT' || el.dataset.mask === 'no') return;
    const k = KIND[kindOf(el)]; if (!k) return;
    el.dataset.masked = '1';
    const intl = () => k === KIND.tel && /^\s*\+(?!55)/.test(el.value); // número de outro país: sem máscara
    const paint = (keepCaret) => {
      if (intl()) { el.setCustomValidity(''); return; }
      const pos = el.selectionStart ?? el.value.length; const before = D(el.value.slice(0, pos)).length;
      const out = k.fmt(D(el.value)); if (out === el.value) return;
      el.value = out;
      if (keepCaret && document.activeElement === el) { let i = 0; let n = 0; while (i < out.length && n < before) { if (/\d/.test(out[i])) n++; i++; } try { el.setSelectionRange(i, i); } catch { /* ok */ } }
    };
    let note = null;
    const validate = (show) => {
      const msg = intl() ? '' : k.check(D(el.value)); el.setCustomValidity(msg);
      el.classList.toggle('bad-input', !!msg && show); el.setAttribute('aria-invalid', msg && show ? 'true' : 'false');
      if (msg && show) { if (!note) { note = document.createElement('small'); note.className = 'fld-err'; note.setAttribute('role', 'alert'); el.insertAdjacentElement('afterend', note); } note.textContent = msg; } else if (note) { note.remove(); note = null; }
      return !msg;
    };
    if (el.maxLength < k.max) el.maxLength = Math.max(k.max, k === KIND.tel ? 20 : k.max);
    el.addEventListener('input', () => { paint(true); validate(!!note && D(el.value).length >= (k === KIND.tel ? 10 : 11)); if (!note) el.classList.remove('bad-input'); });
    el.addEventListener('blur', () => { paint(false); if (el.value) validate(true); });
    el.addEventListener('invalid', () => validate(true)); // o navegador barrou o envio: mostra o motivo abaixo do campo
    paint(false); validate(false);
  }
  const scan = (root = document) => root.querySelectorAll('input[data-mask], input[name="cpf"], input[name$="_cpf"], input[name="doc"], input[name="t_doc"], input[type="tel"], input[inputmode="tel"]').forEach(apply);
  scan();
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.('input')) apply(n); scan(n); } }))).observe(document.body, { childList: true, subtree: true });
})();
