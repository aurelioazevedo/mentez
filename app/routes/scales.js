// Escalas (PHQ-9, GAD-7): aba na ficha do paciente, aplicação na sessão, envio por link/WhatsApp/portal e página do paciente.
import { q, one, audit } from '../lib/db.js';
import { botFields } from '../lib/ratelimit.js';
import { page, bare, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { canSeePatient, forbidden } from '../lib/perm.js';
import * as S from '../lib/scales.js';
import * as WA from '../lib/whatsapp.js';
import * as Fin from '../lib/fin.js';

const nm = (p) => p.social_name || p.name;

// ---------- formulário (paciente ou sessão) ----------
export function scaleForm(inst, { action = '', submit = 'Enviar respostas', staff = false } = {}) {
  const I = S.INSTRUMENTS[inst];
  return html`<form method="post" ${action ? raw(`action="${action}"`) : ''} class="scale-form stack" data-scale-form>
    ${staff ? '' : botFields()}<p class="sc-intro">${I.intro}</p>
    ${I.items.map((t, i) => html`<fieldset class="sc-item"><legend><span class="sc-n">${i + 1}</span>${t}</legend>
      <div class="sc-opts">${I.options.map(([l, v]) => html`<label><input type="radio" name="a${i}" value="${v}" required><span>${l}</span></label>`)}</div></fieldset>`)}
    ${I.func ? html`<fieldset class="sc-item sc-func"><legend>${S.FUNC_Q} <small class="muted">(opcional)</small></legend>
      <div class="sc-opts">${S.FUNC_OPTS.map((l, v) => html`<label><input type="radio" name="func" value="${v}"><span>${l}</span></label>`)}</div></fieldset>` : ''}
    ${staff ? '' : html`<p class="muted small">Não existe resposta certa ou errada. Suas respostas vão só para a sua psicóloga.</p>`}
    <div class="actions"><button class="btn big">${submit}</button></div>
  </form>`;
}
const readAnswers = (inst, b) => S.INSTRUMENTS[inst].items.map((_, i) => (b[`a${i}`] === undefined ? NaN : Number(b[`a${i}`])));
// Depois de responder: agradecimento; se o item 9 do PHQ-9 foi marcado, recursos de ajuda imediata
export const thanks = (r) => html`<section class="card sc-done"><h2>Obrigado! Suas respostas foram enviadas.</h2><p>Sua psicóloga vai ver o resultado e conversar com você na próxima sessão.</p></section>
  ${r?.alert ? html`<section class="card sc-help" role="alert"><h2>Você não está sozinho(a)</h2><p>Se você estiver pensando em se machucar, procure ajuda agora:</p>
    <ul><li><b>CVV — 188</b> (ligação gratuita, 24 horas) ou chat em <a href="https://cvv.org.br" target="_blank" rel="noopener">cvv.org.br</a></li><li><b>SAMU — 192</b> ou o pronto-socorro mais próximo em caso de emergência</li></ul>
    <p>Sua psicóloga foi avisada e vai entrar em contato.</p></section>` : ''}`;

// ---------- gráfico de evolução com faixas de gravidade ----------
function evolution(inst, pts) {
  const I = S.INSTRUMENTS[inst];
  if (!pts.length) return html`<p class="muted small">Ainda sem respostas.</p>`;
  const n = pts.length; const max = I.max;
  const X = (i) => (n === 1 ? 50 : 4 + (i / (n - 1)) * 92); const Y = (v) => 100 - (v / max) * 100;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)},${Y(p.score).toFixed(2)}`).join(' ');
  return html`<figure class="sc-chart" data-bi aria-label="Evolução do ${I.short}">
    <div class="sc-plot">
      ${I.bands.map(([a, b, l], k) => html`<div class="sc-band b${k}" style="bottom:${((a / max) * 100).toFixed(2)}%;height:${(((Math.min(b + 1, max) - a) / max) * 100).toFixed(2)}%"><span>${l}</span></div>`)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" vector-effect="non-scaling-stroke"/></svg>
      ${pts.map((p, i) => html`<i class="sc-dot b${S.band(inst, p.score)}" style="left:${X(i).toFixed(2)}%;top:${Y(p.score).toFixed(2)}%" data-tip="${brDate(p.date)}: ${p.score} pontos — ${S.bandLabel(inst, p.score).toLowerCase()}" tabindex="0"></i>`)}
    </div>
    <div class="sc-x">${pts.map((p, i) => html`<span style="left:${X(i).toFixed(2)}%">${n <= 8 || i === 0 || i === n - 1 || i % Math.ceil(n / 6) === 0 ? brDate(p.date).slice(0, 5) : ''}</span>`)}</div>
    <details class="bi-data"><summary>Ver dados em tabela</summary><table class="tbl small"><tbody>${pts.map((p) => html`<tr><td>${brDate(p.date)}</td><td class="num">${p.score}</td><td>${S.bandLabel(inst, p.score)}</td></tr>`)}</tbody></table></details>
  </figure>`;
}
function change(inst, pts) {
  const I = S.INSTRUMENTS[inst];
  if (pts.length < 2) return '';
  const first = pts[0].score; const last = pts[pts.length - 1].score; const prev = pts[pts.length - 2].score;
  const d = last - prev; const dt = last - first;
  const tags = [];
  if (first - last >= I.mcid) tags.push(['good', `melhora clinicamente significativa (−${first - last} pontos desde a 1ª aplicação)`]);
  else if (last - first >= I.mcid) tags.push(['bad', `piora clinicamente significativa (+${last - first} pontos desde a 1ª aplicação)`]);
  if (first >= 10 && last <= first / 2) tags.push(['good', 'resposta: redução de 50% ou mais']);
  if (first >= 10 && last < 5) tags.push(['good', 'remissão (abaixo de 5 pontos)']);
  return html`<p class="sc-change">Última: <b>${last}</b> (${d === 0 ? 'igual à anterior' : `${d > 0 ? '+' : '−'}${Math.abs(d)} vs anterior`}) · 1ª aplicação: ${first} (${dt === 0 ? 'igual' : `${dt > 0 ? '+' : '−'}${Math.abs(dt)}`})
    ${tags.map(([t, l]) => html`<span class="sc-tag ${t}">${l}</span>`)}</p>`;
}

// ---------- aba “Escalas” na ficha ----------
export async function patientTab(req, p) {
  const [hist, plans, alerts] = await Promise.all([S.history(p.id), S.plans(p.id), S.unseenAlerts(p.id)]);
  const waOn = WA.ready(await WA.config());
  const done = hist.filter((h) => h.status === 'respondido' && h.res);
  const pend = hist.filter((h) => h.status === 'pendente');
  const planOf = (k) => plans.find((x) => x.instrument === k);
  return html`
    ${alerts.length ? html`<div class="flash err sc-alert" role="alert"><b>⚠️ Atenção:</b> no PHQ-9 de ${brDateTime(alerts[0].answered_at)}, ${nm(p)} marcou o item 9 (pensamentos de se ferir ou de que seria melhor estar morto(a)). Avalie o risco o quanto antes.
      <form method="post" action="/escalas/${alerts[0].id}/visto" class="inline"><button class="btn ghost btn-sm">Ciente — marcar como visto</button></form></div>` : ''}
    <section class="card"><h2>Aplicar ou enviar</h2>
      <form method="post" action="/escalas/enviar" class="form-grid">
        <input type="hidden" name="patient_id" value="${p.id}">
        <label class="fld"><span>Questionário</span><select name="instrument">${Object.values(S.INSTRUMENTS).map((I) => html`<option value="${I.key}">${I.short} — ${I.domain.toLowerCase()}</option>`)}</select></label>
        <label class="fld"><span>Como</span><select name="mode">
          ${waOn && p.whatsapp_optin && p.phone ? html`<option value="whatsapp">Enviar o link pelo WhatsApp</option>` : ''}
          <option value="portal">Deixar no portal do paciente</option><option value="link">Só gerar o link</option><option value="sessao">Aplicar agora, na sessão</option></select></label>
        <label class="fld"><span>Prazo para responder</span><select name="days"><option value="3">3 dias</option><option value="7" selected>7 dias</option><option value="14">14 dias</option></select></label>
        <div class="actions"><button class="btn">Continuar</button></div>
      </form>
      <p class="muted small">A mensagem do WhatsApp não diz o assunto do questionário. O paciente vê o resultado só com você, na sessão.</p>
    </section>
    ${pend.length ? html`<section class="card"><h2>Aguardando resposta</h2><ul class="plain">${pend.map((h) => html`<li class="sc-pend"><b>${S.INSTRUMENTS[h.instrument]?.short}</b> · ${S.VIA[h.via] || h.via} · enviado em ${brDate(h.created_at)} · até ${brDate(h.expires_at)}${String(h.expires_at) < new Date(Date.now() - 3 * 3600e3).toISOString().replace('T', ' ') ? html` <span class="muted">(expirado)</span>` : ''}
      <span class="sc-acts"><button type="button" class="btn ghost btn-sm" data-copy-text="${S.urlOf(h.id)}">Copiar link</button>
      <form method="post" action="/escalas/${h.id}/cancelar" class="inline"><button class="btn ghost btn-sm">Cancelar</button></form></span></li>`)}</ul></section>` : ''}
    ${Object.values(S.INSTRUMENTS).map((I) => {
      const pts = done.filter((h) => h.instrument === I.key).map((h) => ({ id: h.id, date: h.answered_at, score: h.res.score, ans: h.ans, via: h.via, alert: h.alert })).sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : a.id - b.id));
      const pl = planOf(I.key);
      return html`<section class="card sc-inst" id="escala-${I.key}"><header class="bi-ph"><div><h2>${I.short} <small class="muted">· ${I.domain}</small></h2>
          <p class="muted small">${pts.length ? `${pts.length} aplicação(ões) · última em ${brDate(pts[pts.length - 1].date)}: ${pts[pts.length - 1].score}/${I.max} — ${S.bandLabel(I.key, pts[pts.length - 1].score).toLowerCase()}` : 'Ainda não aplicado.'}</p></div>
        <form method="post" action="/escalas/plano" class="inline sc-plan"><input type="hidden" name="patient_id" value="${p.id}"><input type="hidden" name="instrument" value="${I.key}">
          <label class="small">Reaplicar automaticamente <select name="every" data-autosubmit><option value="0">não</option>${[[14, 'a cada 2 semanas'], [28, 'a cada 4 semanas'], [56, 'a cada 8 semanas'], [84, 'a cada 12 semanas']].map(([d, l]) => html`<option value="${d}" ${pl?.every_days === d ? raw('selected') : ''}>${l}</option>`)}</select></label>
          ${pl ? html`<small class="muted">próxima: ${brDate(pl.next_at)}</small>` : ''}</form></header>
        ${change(I.key, pts)}
        ${evolution(I.key, pts)}
        ${pts.length ? html`<details class="sc-hist"><summary>Respostas de cada aplicação</summary>${pts.slice().reverse().map((x) => html`<div class="sc-app"><p><b>${brDate(x.date)}</b> · ${x.score} pontos (${S.bandLabel(I.key, x.score).toLowerCase()}) · ${S.VIA[x.via] || x.via}${x.alert ? html` · <span class="err-txt">item ${I.alertItem + 1} positivo</span>` : ''}</p>
          <ol class="sc-ans">${I.items.map((t, i) => html`<li class="${I.alertItem === i && x.ans?.a?.[i] > 0 ? 'alert' : ''}"><span>${t}</span><b>${I.options.find(([, v]) => v === x.ans?.a?.[i])?.[0] || '—'}</b></li>`)}</ol>
          ${x.ans?.f != null ? html`<p class="small muted">Dificuldade no dia a dia: ${S.FUNC_OPTS[x.ans.f]}</p>` : ''}</div>`)}</details>` : ''}
        <p class="muted small">Faixas: ${I.bands.map(([a, b, l]) => `${a}–${b} ${l.toLowerCase()}`).join(' · ')}. Instrumento de rastreio e acompanhamento: não substitui a avaliação clínica. ${I.source}</p>
      </section>`;
    })}`;
}

// ---------- ações da equipe ----------
export const staff = router();
async function patientOf(req, id) {
  const p = await one('SELECT * FROM patients WHERE id = ?', [int(id)]);
  if (!p) return null;
  if (!canSeePatient(req.user, p)) throw forbidden();
  return p;
}
async function appOf(req) {
  const a = await one('SELECT s.*, p.owner_id powner FROM scale_apps s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(req.params.id)]);
  if (!a) return null;
  if (!canSeePatient(req.user, { owner_id: a.powner })) throw forbidden();
  return a;
}
const back = (pid, inst) => `/pacientes/${pid}?aba=escalas${inst ? `#escala-${inst}` : ''}`;
staff.post('/enviar', async (req, res, next) => {
  const p = await patientOf(req, req.body.patient_id); if (!p) return next();
  const inst = S.INSTRUMENTS[req.body.instrument] ? req.body.instrument : null;
  if (!inst) return res.flash('Escolha o questionário.', 'err').redirect(back(p.id));
  if (req.body.mode === 'sessao') return res.redirect(`/escalas/aplicar/${p.id}/${inst}`);
  const days = [3, 7, 14].includes(int(req.body.days)) ? int(req.body.days) : 7;
  const id = await S.create(p.id, inst, { via: req.body.mode === 'whatsapp' ? 'whatsapp' : req.body.mode === 'portal' ? 'portal' : 'link', userId: req.user.id, days });
  await audit(req, 'escala-enviar', `patient:${p.id} ${inst}`);
  if (req.body.mode === 'whatsapp') {
    const r = await S.sendWhatsApp(id, req.user.id);
    return res.flash(r.ok ? `${S.INSTRUMENTS[inst].short} enviado pelo WhatsApp.` : `Link criado, mas o WhatsApp falhou: ${r.error}. Copie o link abaixo.`, r.ok ? 'ok' : 'warn').redirect(back(p.id));
  }
  res.flash(req.body.mode === 'portal' ? `${S.INSTRUMENTS[inst].short} disponível no portal do paciente.` : `Link do ${S.INSTRUMENTS[inst].short} criado: ${S.urlOf(id)}`).redirect(back(p.id));
});
staff.get('/aplicar/:pid/:inst', async (req, res, next) => {
  const p = await patientOf(req, req.params.pid); const I = S.INSTRUMENTS[req.params.inst];
  if (!p || !I) return next();
  send(res, page(req, { title: I.short, active: 'pacientes', body: html`<header class="ph"><div><p class="eyebrow">${nm(p)} · aplicação na sessão</p><h1>${I.title}</h1></div><div class="ph-actions"><a class="btn ghost" href="${back(p.id)}">Voltar</a></div></header>
    <section class="card">${scaleForm(I.key, { submit: 'Salvar respostas', staff: true })}</section>` }));
});
staff.post('/aplicar/:pid/:inst', async (req, res, next) => {
  const p = await patientOf(req, req.params.pid); const I = S.INSTRUMENTS[req.params.inst];
  if (!p || !I) return next();
  const id = await S.create(p.id, I.key, { via: 'sessao', userId: req.user.id, days: 1 });
  const r = await S.answer(id, readAnswers(I.key, req.body), req.body.func);
  if (!r || r.error) { await q("UPDATE scale_apps SET status = 'cancelado' WHERE id = ?", [id]); return res.flash(r?.error || 'Não foi possível salvar.', 'err').redirect(`/escalas/aplicar/${p.id}/${I.key}`); }
  if (r.alert) await q('UPDATE scale_apps SET alert_seen_at = NOW(), alert_seen_by = ? WHERE id = ?', [req.user.id, id]); // aplicado com a psicóloga presente
  await audit(req, 'escala-aplicar', `patient:${p.id} ${I.key}`);
  res.flash(`${I.short}: ${r.score} pontos (${S.bandLabel(I.key, r.score).toLowerCase()}).${r.alert ? ' Item 9 positivo: avalie o risco.' : ''}`, r.alert ? 'warn' : 'ok').redirect(back(p.id, I.key));
});
staff.post('/plano', async (req, res, next) => {
  const p = await patientOf(req, req.body.patient_id); if (!p) return next();
  const every = [0, 14, 28, 56, 84].includes(int(req.body.every)) ? int(req.body.every) : 0;
  await S.setPlan(p.id, req.body.instrument, every, req.user.id);
  await audit(req, 'escala-plano', `patient:${p.id} ${req.body.instrument} ${every}`);
  res.flash(every ? `Reaplicação automática a cada ${every / 7} semanas (pelo WhatsApp ou portal).` : 'Reaplicação automática desligada.').redirect(back(p.id, req.body.instrument));
});
staff.post('/:id/cancelar', async (req, res, next) => {
  const a = await appOf(req); if (!a) return next();
  await q("UPDATE scale_apps SET status = 'cancelado' WHERE id = ? AND status = 'pendente'", [a.id]);
  res.flash('Envio cancelado.').redirect(back(a.patient_id));
});
staff.post('/:id/visto', async (req, res, next) => {
  const a = await appOf(req); if (!a) return next();
  await q('UPDATE scale_apps SET alert_seen_at = NOW(), alert_seen_by = ? WHERE id = ?', [req.user.id, a.id]);
  await audit(req, 'escala-alerta-visto', `scale:${a.id}`);
  res.redirect(back(a.patient_id));
});

// ---------- página do paciente (link) ----------
export const publicScale = router();
async function shellPub(req, title, inner) {
  const clinic = await Fin.clinic();
  return bare(title, html`<main class="legal scale-pub"><img class="legal-logo-img" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes — Psicóloga" width="150">${inner}
    <p class="muted small">Dúvidas: WhatsApp ${clinic.phone} · Em caso de crise: CVV 188 (24 h) · SAMU 192</p></main>`, 'bare legal-page', req);
}
const loadPub = async (tok) => { const id = S.idOfToken(tok); return id ? one('SELECT s.*, p.name, p.social_name FROM scale_apps s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]) : null; };
publicScale.get('/:tok', async (req, res) => {
  const a = await loadPub(req.params.tok);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (!a || a.status === 'cancelado') return res.status(404).send(String(await shellPub(req, 'Link inválido', html`<h1>Link inválido</h1><p>Este questionário não existe ou foi cancelado.</p>`)));
  const I = S.INSTRUMENTS[a.instrument];
  if (a.status === 'respondido') return send(res, await shellPub(req, I.short, html`<h1>Questionário já respondido</h1><p>Obrigado, ${WA.firstName(a)}! Suas respostas já foram enviadas.</p>`));
  if (String(a.expires_at) < new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')) return send(res, await shellPub(req, I.short, html`<h1>Prazo encerrado</h1><p>O prazo para responder terminou. Peça um novo link à sua psicóloga.</p>`));
  if (!a.opened_at) await q('UPDATE scale_apps SET opened_at = NOW() WHERE id = ?', [a.id]);
  send(res, await shellPub(req, I.short, html`<h1>Olá, ${WA.firstName(a)}!</h1><p class="lead">${I.title}</p>${scaleForm(I.key)}`));
});
publicScale.post('/:tok', async (req, res) => {
  const a = await loadPub(req.params.tok);
  if (!a || a.status !== 'pendente') return res.redirect(`/e/${req.params.tok}`);
  const r = await S.answer(a.id, readAnswers(a.instrument, req.body), req.body.func);
  if (!r || r.error) return res.redirect(`/e/${req.params.tok}`);
  res.set('Cache-Control', 'no-store');
  send(res, await shellPub(req, 'Obrigado', thanks(r)));
});
export { readAnswers };
