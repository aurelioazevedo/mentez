// Bem-Estar Mental: filtros que buscam sozinhos e envio da foto do perfil.
(function () {
  var d = document;
  // no celular, os filtros começam recolhidos (os resultados aparecem primeiro)
  var fb = d.querySelector('[data-fbox]'); if (fb && window.innerWidth < 980) fb.open = false;
  d.querySelectorAll('[data-filters] [data-auto]').forEach(function (el) { el.addEventListener('change', function () { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }); });
  d.querySelectorAll('[data-photo]').forEach(function (inp) {
    inp.addEventListener('change', async function () {
      var f = inp.files[0]; if (!f) return; var lb = inp.closest('label'); lb.firstChild.textContent = 'Enviando…';
      try { var r = await fetch(inp.dataset.photo, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f, credentials: 'same-origin' }); var j = await r.json(); if (j.ok) location.href = '/meu-perfil?ok=foto'; else { alert(j.error || 'Não foi possível enviar.'); lb.firstChild.textContent = 'Trocar foto'; } }
      catch (e) { alert('Falha de conexão.'); lb.firstChild.textContent = 'Trocar foto'; }
    });
  });
})();
