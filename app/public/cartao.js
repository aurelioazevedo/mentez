// Cartão digital e link na bio: virar o cartão (QR code) e compartilhar.
(() => {
  const toast = document.querySelector('.toast');
  const say = (t) => { if (!toast) return; toast.textContent = t; toast.classList.add('on'); setTimeout(() => toast.classList.remove('on'), 2200); };
  const card = document.querySelector('[data-flip]');
  card?.addEventListener('click', () => { const on = card.classList.toggle('flip'); card.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  document.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', async () => {
    const url = b.dataset.share; const title = b.dataset.title || document.title;
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); say('Link copiado'); } catch { prompt('Copie o link:', url); }
  }));
})();
