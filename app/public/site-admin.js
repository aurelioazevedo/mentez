// Marketing → Site: envio de imagens, ponto de foco, miniatura das imagens escolhidas e prévia do Google.
(function () {
  var d = document;
  // envio de imagens (uma por vez, com o andamento)
  var up = d.querySelector('[data-site-upload]');
  if (up) {
    var input = up.querySelector('[data-site-file]'); var log = up.querySelector('[data-site-log]'); var drop = up.querySelector('.site-drop');
    var send = async function (files) {
      var ok = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i]; var line = d.createElement('p'); line.textContent = 'Enviando ' + f.name + '…'; log.appendChild(line);
        try {
          var r = await fetch(up.dataset.siteUpload, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }, body: f, credentials: 'same-origin' });
          var j = await r.json().catch(function () { return { ok: false, error: 'Resposta inválida do servidor.' }; });
          if (j.ok) { ok++; line.textContent = '✓ ' + f.name + ' convertida' + (j.kind === 'svg' ? ' (SVG)' : ' para WebP') + '.' + (j.warn ? ' ' + j.warn : ''); line.className = j.warn ? 'warn' : 'ok'; }
          else { line.textContent = '✗ ' + f.name + ': ' + (j.error || 'não foi possível enviar.'); line.className = 'err'; }
        } catch (e) { line.textContent = '✗ ' + f.name + ': falha de conexão.'; line.className = 'err'; }
      }
      if (ok) { var p = d.createElement('p'); p.textContent = 'Atualizando a biblioteca…'; log.appendChild(p); setTimeout(function () { location.reload(); }, 1200); }
    };
    input.addEventListener('change', function () { if (input.files.length) send(input.files); });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) send(e.dataTransfer.files); });
  }
  // envio de PDF (material gratuito)
  d.querySelectorAll('[data-site-pdf]').forEach(function (inp) {
    inp.addEventListener('change', async function () {
      var f = inp.files[0]; if (!f) return; var lb = inp.closest('label'); lb.firstChild.textContent = 'Enviando…';
      var r = await fetch(inp.dataset.sitePdf, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(f.name) }, body: f, credentials: 'same-origin' }).catch(function () { return null; });
      var j = r ? await r.json().catch(function () { return {}; }) : {};
      if (j.ok) location.reload(); else { alert(j.error || 'Não foi possível enviar.'); lb.firstChild.textContent = 'Enviar PDF'; }
    });
  });
  // ponto de foco: clique na foto, salva sozinho
  d.querySelectorAll('[data-focal]').forEach(function (box) {
    var img = box.querySelector('img'); var dot = box.querySelector('.site-focal__dot'); if (!dot) return;
    box.addEventListener('click', function (e) {
      var r = img.getBoundingClientRect();
      var fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); var fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      dot.style.left = (fx * 100) + '%'; dot.style.top = (fy * 100) + '%';
      var f = box.closest('form'); f.querySelector('[name=fx]').value = fx.toFixed(3); f.querySelector('[name=fy]').value = fy.toFixed(3);
      f.requestSubmit ? f.requestSubmit() : f.submit();
    });
  });
  // miniatura da imagem escolhida
  d.querySelectorAll('[data-imgsel]').forEach(function (sel) {
    var th = sel.parentNode.querySelector('.site-imgsel__th');
    var upd = function () { var o = sel.selectedOptions[0]; if (o && o.dataset.thumb) { th.src = o.dataset.thumb; th.hidden = false; } else th.hidden = true; };
    sel.addEventListener('change', upd); upd();
  });
  // ao escolher um layout animado com as animações em “Suaves”, sugere “Expressivas”
  d.querySelectorAll('input[name=layout][data-motion]').forEach(function (r) {
    r.addEventListener('change', function () { var viva = d.querySelector('input[name=motion][value=viva]'); var suave = d.querySelector('input[name=motion][value=suave]'); if (r.dataset.motion === '1' && suave && suave.checked && viva) viva.checked = true; });
  });
  // ✨ IA: sugere o texto de um campo da seção (o texto atual é usado como base)
  d.querySelectorAll('[data-site-ai]').forEach(function (b) {
    b.addEventListener('click', async function (e) {
      e.preventDefault();
      var fld = b.closest('.fld').querySelector('input, textarea'); if (!fld) return;
      var old = b.textContent; b.disabled = true; b.textContent = 'Escrevendo…';
      try {
        var r = await fetch('/marketing/site/ia/secao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ section: b.dataset.section, label: b.dataset.label, kind: b.dataset.kind, current: fld.value }) });
        var j = await r.json().catch(function () { return { ok: false, error: 'Resposta inválida.' }; });
        if (j.ok) { fld.value = j.text; fld.dispatchEvent(new Event('input', { bubbles: true })); fld.classList.add('site-ai-new'); setTimeout(function () { fld.classList.remove('site-ai-new'); }, 1600); if (j.risks && j.risks.length) alert('Revise antes de publicar: ' + j.risks.join(', ') + '.'); }
        else alert(j.error || 'Não foi possível sugerir agora.');
      } catch (err) { alert('Falha de conexão.'); }
      b.disabled = false; b.textContent = old;
    });
  });
  // botão que avisa que vai demorar (escrever artigo com IA)
  d.querySelectorAll('[data-busy]').forEach(function (b) { var f = b.closest('form'); if (f) f.addEventListener('submit', function () { setTimeout(function () { b.disabled = true; b.textContent = b.dataset.busy; }, 0); }); });
  // seção ligada/desligada
  d.querySelectorAll('[data-sec-on]').forEach(function (c) { c.addEventListener('change', function () { c.closest('.site-sec').classList.toggle('is-off', !c.checked); }); });
  // prévia do Google ao digitar
  var t = d.querySelector('input[name=title][data-count]'); var ds = d.querySelector('textarea[name=description][data-count]');
  var st = d.querySelector('[data-serp-title]'); var sd = d.querySelector('[data-serp-desc]');
  if (t && st) t.addEventListener('input', function () { st.textContent = t.value; });
  if (ds && sd) ds.addEventListener('input', function () { sd.textContent = ds.value; });
})();
