// Endereços da própria Mentez (mentez.com.br, app.mentez.com.br): não pertencem a nenhuma clínica.
// Por enquanto: página de entrada. O painel de gestão das clínicas (backoffice) vem na próxima etapa.
import { bare, html } from '../lib/html.js';

export function handle(req, res, next) {
  if (req.path === '/robots.txt') return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
  res.set('Cache-Control', 'no-store');
  res.send(String(bare('Mentez', html`<div class="center-card"><h1>mentez</h1><p>Inteligência para cuidar de quem cuida.</p><p class="muted">Cada clínica acessa pelo próprio endereço, por exemplo <b>suaclinica.${process.env.MENTEZ_BASE_DOMAIN || 'mentez.com.br'}</b>.</p></div>`)));
}
