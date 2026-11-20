// Aniversários e pesquisa de satisfação: Configurações, página pública da pesquisa e acompanhamento.
import { q, one, audit } from '../lib/db.js';
import { botFields } from '../lib/ratelimit.js';
import { page, bare, html, raw, brDate } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import * as E from '../lib/engage.js';
import * as WA from '../lib/whatsapp.js';
import * as Notify from '../lib/notify.js';
import * as Fin from '../lib/fin.js';
import { todayLocal } from '../lib/time.js';

const chk = (v) => (v ? raw('checked') : '');
const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');

// ---------- Configurações → Aniversários ----------
export const birthdays = router();
birthdays.get('/', (req, res) => res.redirect('/marketing/aniversarios')); // a tela agora fica em Marketing
birthdays.post('/', async (req, res) => {
  await E.saveConfig('aniversario', req.body);
  await audit(req, 'aniversario-config');
  res.flash(req.body.bdayOn ? 'Mensagem de aniversário ligada.' : 'Configuração salva (envio automático desligado).').redirect('/marketing/aniversarios');
});
birthdays.post('/:id/enviar', async (req, res) => {
  const p = await one('SELECT id, name, social_name, phone, email, email_optin, whatsapp_optin, birthday_optin, birthday_sent_year FROM patients WHERE id = ?', [int(req.params.id)]);
  const r = p ? await E.sendBirthday(p) : { ok: false, error: 'Paciente não encontrado.' };
  await audit(req, 'aniversario-enviar', `patient:${req.params.id}`);
  res.flash(r.ok ? `Mensagem de aniversário enviada${r.via === 'email' ? ' por e-mail' : ''}.` : `Não enviada: ${r.error}`, r.ok ? 'ok' : 'err').redirect('/marketing/aniversarios');
});

// ---------- Configurações → Pesquisa de satisfação ----------
export const survey = router();
survey.get('/', async (req, res) => {
  const c = await E.config();
  const mailOn = Notify.emailReady(await Notify.config());
  send(res, page(req, { title: 'Pesquisa de satisfação', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Pesquisa de satisfação</h1>
      <p class="muted">Algumas horas depois da sessão, o paciente recebe um link para dar uma nota de 0 a 10 e, se quiser, deixar um comentário. Os resultados (NPS) ficam em Relatórios → Satisfação, e notas baixas avisam a equipe na hora.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/s/exemplo" target="_blank" rel="noopener">Ver como o paciente vê</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="surveyOn" value="1" ${chk(c.surveyOn)}><span><b>Enviar a pesquisa automaticamente</b></span></label>
      <div class="form-grid">
        <label class="fld"><span>Enviar depois da sessão</span><select name="surveyDelayH">${[1, 2, 3, 6, 12, 24].map((h) => html`<option value="${h}" ${sel(c.surveyDelayH, h)}>${h} hora(s) depois</option>`)}</select></label>
        <label class="fld"><span>Frequência para o mesmo paciente</span><select name="surveyEveryDays">${[[30, 'no máximo 1 vez por mês'], [60, 'no máximo a cada 2 meses'], [90, 'no máximo a cada 3 meses'], [180, 'no máximo a cada 6 meses'], [365, 'no máximo 1 vez por ano']].map(([d, l]) => html`<option value="${d}" ${sel(c.surveyEveryDays, d)}>${l}</option>`)}</select></label>
        <label class="fld"><span>Avisar a equipe quando a nota for até</span><select name="alertMax">${[0, 3, 5, 6, 7, 8].map((n) => html`<option value="${n}" ${sel(c.alertMax, n)}>${n}</option>`)}</select></label>
      </div>
      <label class="fld check"><input type="checkbox" name="surveyFirst" value="1" ${chk(c.surveyFirst)}><span>Enviar já depois da 1ª sessão (recomendado: é quando a primeira impressão se forma)</span></label>
      <label class="fld check"><input type="checkbox" name="surveyEmail" value="1" ${chk(c.surveyEmail)}><span>Sem WhatsApp autorizado, enviar por e-mail ${mailOn ? '' : html`<small class="muted">(configure em Lembretes por e-mail e SMS)</small>`}</span></label>
      <label class="fld"><span>Mensagem do convite</span><textarea name="surveyText" rows="3" maxlength="800">${c.surveyText}</textarea><small class="muted">Variáveis: {nome}, {clinica} e {link} (o link da pesquisa — obrigatório).</small></label>
      <label class="fld"><span>Agradecimento depois de responder</span><textarea name="thanksText" rows="2" maxlength="500">${c.thanksText}</textarea></label>
      <fieldset class="card soft stack"><legend><b>Convite para avaliar no Google</b> <small class="muted">(opcional)</small></legend>
        <label class="fld check"><input type="checkbox" name="reviewOn" value="1" ${chk(c.reviewOn)}><span>Depois de uma nota alta, convidar o paciente a avaliar a clínica no Google</span></label>
        <div class="form-grid">
          <label class="fld"><span>Link de avaliação do Google</span><input name="reviewUrl" value="${c.reviewUrl}" maxlength="400" placeholder="https://g.page/r/…/review"></label>
          <label class="fld"><span>A partir da nota</span><select name="reviewMin">${[8, 9, 10].map((n) => html`<option value="${n}" ${sel(c.reviewMin, n)}>${n}</option>`)}</select></label>
        </div>
        <p class="flash warn small">Atenção: o Código de Ética Profissional do Psicólogo e as normas do CFP sobre publicidade restringem o uso de depoimentos de pacientes. Antes de ligar este convite, confirme com o CRP se ele é adequado. O convite fica desligado por padrão.</p>
      </fieldset>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    <details class="card tv-tips"><summary>Como ler o resultado (NPS)</summary><ul>
      <li>Notas 9 e 10 são <b>promotores</b>; 7 e 8, <b>neutros</b>; 0 a 6, <b>detratores</b>.</li>
      <li><b>NPS = % de promotores − % de detratores</b>, de −100 a +100. Acima de 50 é muito bom; acima de 75, excelente.</li>
      <li>O paciente pode pedir para não receber mais pesquisas pelo próprio link; na ficha também dá para desmarcar.</li>
    </ul></details>` }));
});
survey.post('/', async (req, res) => {
  const bad = E.checkInput(req.body);
  if (bad) return res.flash(bad, 'err').redirect('/configuracoes/pesquisa');
  if (req.body.surveyText && !String(req.body.surveyText).includes('{link}')) return res.flash('A mensagem do convite precisa ter {link}, o endereço da pesquisa.', 'err').redirect('/configuracoes/pesquisa');
  await E.saveConfig('pesquisa', req.body);
  await audit(req, 'pesquisa-config');
  res.flash(req.body.surveyOn ? 'Pesquisa de satisfação ligada.' : 'Configuração salva (envio automático desligado).').redirect('/configuracoes/pesquisa');
});

// ---------- página pública da pesquisa ----------
export const publicSurvey = router();
const SCORE_HINT = ['Nada provável', '', '', '', '', '', '', '', '', '', 'Muito provável'];
async function surveyPage(req, res, { s, done = null, preview = false, msg = null }) {
  const c = await E.config(); const clinic = await Fin.clinic();
  const nome = s ? WA.firstName(s) : 'Marina';
  const showReview = done != null && c.reviewOn && c.reviewUrl && done >= c.reviewMin;
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  send(res, bare('Pesquisa de satisfação', html`<main class="legal survey-pub">
    <img class="legal-logo-img" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes — Psicóloga" width="150">
    ${msg ? html`<div class="flash ${msg.kind}">${msg.text}</div>` : ''}
    ${done != null ? html`<h1>Obrigado, ${nome}!</h1><p class="lead">${c.thanksText}</p>
      ${showReview ? html`<section class="card survey-review"><p>Que bom que você está gostando! Se quiser, conte sua experiência no Google — isso ajuda outras pessoas a encontrarem cuidado.</p><a class="btn" href="${preview ? '#' : `/s/${req.params.tok}/avaliar`}" rel="noopener">Avaliar no Google</a></section>` : ''}`
    : html`<h1>Olá, ${nome}!</h1><p class="lead">De 0 a 10, quanto você recomendaria nosso atendimento a um amigo ou familiar?</p>
    <form method="${preview ? 'get' : 'post'}" class="card stack survey-form">${preview ? '' : botFields()}
      <fieldset class="survey-scale"><legend class="sr-only">Nota de 0 a 10</legend>
        ${[...Array(11).keys()].map((n) => html`<label class="sv-n sv-${n <= 6 ? 'lo' : n <= 8 ? 'mid' : 'hi'}"><input type="radio" name="score" value="${n}" required><span>${n}</span></label>`)}
      </fieldset>
      <div class="sv-ends"><small>${SCORE_HINT[0]}</small><small>${SCORE_HINT[10]}</small></div>
      <label class="fld"><span>Quer contar o motivo da sua nota? <small class="muted">(opcional)</small></span><textarea name="comment" rows="4" maxlength="1500" placeholder="O que foi bom e o que podemos melhorar"></textarea></label>
      <p class="muted small">Sua resposta vai só para a equipe do consultório e não é publicada.</p>
      <div class="actions"><button class="btn">Enviar resposta</button></div>
    </form>`}
    ${!preview && s && done == null ? html`<form method="post" action="/s/${req.params.tok}/parar" class="survey-stop"><button class="linklike small">Não quero receber pesquisas</button></form>` : ''}
    <p class="muted small">Dúvidas: WhatsApp ${clinic.phone} · <a href="/privacidade">Política de Privacidade</a></p>
  </main>`, 'bare legal-page', req));
}
const invalid = (req, res) => res.status(404).send(String(bare('Link inválido', html`<main class="legal"><h1>Link inválido</h1><p>Este link de pesquisa não existe. Obrigado pelo interesse!</p></main>`, 'bare legal-page', req)));
const loadS = (id) => one('SELECT s.*, p.name, p.social_name FROM surveys s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
publicSurvey.get('/exemplo', (req, res, next) => surveyPage(req, res, { s: null, preview: true }).catch(next));
publicSurvey.get('/:tok', async (req, res) => {
  const id = E.idOfToken(req.params.tok); const s = id ? await loadS(id) : null;
  if (!s) return invalid(req, res);
  if (!s.opened_at) await q('UPDATE surveys SET opened_at = NOW() WHERE id = ?', [s.id]);
  await surveyPage(req, res, { s, done: s.answered_at ? s.score : null });
});
publicSurvey.post('/:tok', async (req, res) => {
  const id = E.idOfToken(req.params.tok); const s = id ? await loadS(id) : null;
  if (!s) return invalid(req, res);
  if (s.answered_at) return surveyPage(req, res, { s, done: s.score });
  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) return surveyPage(req, res, { s, msg: { kind: 'err', text: 'Escolha uma nota de 0 a 10.' } });
  await E.answer(s.id, score, str(req.body.comment, 1500));
  await surveyPage(req, res, { s, done: score });
});
publicSurvey.get('/:tok/avaliar', async (req, res) => {
  const id = E.idOfToken(req.params.tok); const s = id ? await loadS(id) : null; const c = await E.config();
  if (!s || !c.reviewOn || !c.reviewUrl) return invalid(req, res);
  await q('UPDATE surveys SET review_clicked_at = COALESCE(review_clicked_at, NOW()) WHERE id = ?', [s.id]);
  res.redirect(c.reviewUrl);
});
publicSurvey.post('/:tok/parar', async (req, res) => {
  const id = E.idOfToken(req.params.tok); const s = id ? await loadS(id) : null;
  if (!s) return invalid(req, res);
  await q('UPDATE patients SET survey_optin = 0 WHERE id = ?', [s.patient_id]);
  res.set('Cache-Control', 'no-store');
  send(res, bare('Pesquisa de satisfação', html`<main class="legal survey-pub"><img class="legal-logo-img" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes — Psicóloga" width="150"><h1>Tudo certo</h1><p class="lead">Você não vai mais receber pesquisas de satisfação. Obrigado!</p></main>`, 'bare legal-page', req));
});

// ---------- marcar comentário como tratado (Relatórios → Satisfação) ----------
export const followup = router();
followup.post('/:id/tratado', async (req, res) => {
  const s = await one('SELECT id, owner_id FROM surveys WHERE id = ?', [int(req.params.id)]);
  const mine = req.user.role === 'psicologo';
  if (s && (!mine || s.owner_id === req.user.id)) await q('UPDATE surveys SET followup_at = NOW(), followup_by = ? WHERE id = ?', [req.user.id, s.id]);
  await audit(req, 'pesquisa-tratada', `survey:${req.params.id}`);
  const back = String(req.body.back || ''); res.redirect(back.startsWith('/relatorios') ? back : '/relatorios?aba=satisfacao#comentarios');
});
