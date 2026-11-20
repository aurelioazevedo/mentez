// Service worker: recebe notificações push do sistema do consultório.
// Não guarda páginas em cache (dados sensíveis); só exibe as notificações.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  const title = d.title || 'Sistema do consultório';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: d.icon || '/static/img/app-192.png',
    badge: d.badge || '/static/img/badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' },
    lang: 'pt-BR',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) { await c.focus(); return c.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});

// Sem cache: as páginas sempre vêm da rede. Se a internet cair ao abrir uma página, mostra um aviso simples.
const OFFLINE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sem conexão</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f0e8;color:#2e2219;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#1a130f;color:#f1e6d8}}button{margin-top:16px;padding:10px 20px;border:0;border-radius:99px;background:#9c4422;color:#fff;font:inherit;cursor:pointer}</style></head>
<body><main><h1>Sem conexão com a internet</h1><p>Verifique o Wi-Fi ou os dados móveis e tente de novo.</p><button onclick="location.reload()">Tentar de novo</button></main></body></html>`;
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
