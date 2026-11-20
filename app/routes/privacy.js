// Configurações → Privacidade e LGPD: prazos de guarda, limpeza do CRM e anonimização de pacientes com prazo vencido.
import bcrypt from 'bcryptjs';
import { one, audit } from '../lib/db.js';
import { page, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { forbidden } from '../lib/perm.js';
import * as P from '../lib/privacy.js';

const r = router();
const BACK = '/configuracoes/privacidade';
r.get('/', async (req, res) => {
  const c = await P.config();
  const crmN = await P.crmCandidates(c.crmMonths);
  const exp = await P.expiredPatients(c.recordsYears);
  let last = null; try { last = JSON.parse((await one("SELECT v FROM settings WHERE k = 'privacy_last'"))?.v || 'null'); } catch { /* nada */ }
  send(res, page(req, {
    title: 'Privacidade e LGPD', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Privacidade e LGPD</h1><p class="muted">Prazos de guarda e eliminação de dados conforme o CFP e a LGPD.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack"><h2>Prazos</h2>
      <label class="fld bk-hour"><span>Guardar o prontuário por (anos) — mínimo 5 (Res. CFP 01/2009)</span><input type="number" name="recordsYears" min="5" max="30" value="${c.recordsYears}"></label>
      <p class="muted small">O sistema nunca apaga prontuários sozinho. Depois do prazo, os pacientes com alta ou inativos aparecem abaixo para você decidir.</p>
      <label class="fld check"><input type="checkbox" name="crmAuto" value="1" ${c.crmAuto ? raw('checked') : ''}><span>Apagar automaticamente contatos do CRM que <b>nunca viraram pacientes</b> e estão sem conversa há</span></label>
      <label class="fld bk-hour"><span>meses</span><input type="number" name="crmMonths" min="3" max="60" value="${c.crmMonths}"></label>
      <p class="muted small">Apaga o card, as mensagens e a conversa do atendente virtual desses contatos. Hoje: <b>${crmN}</b> contato(s) nessa situação.${last ? ` Última limpeza: ${brDateTime(last.at)} (${last.removed} removido[s]).` : ''}</p>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    <section class="card"><h2>Pacientes com prazo de guarda vencido</h2>
      <p class="muted small sub-h">Alta ou inativos sem sessão/registro há mais de ${c.recordsYears} anos. Anonimizar apaga prontuário, exercícios, mensagens e dados de identificação; as sessões e valores ficam sem identidade, para a contabilidade. Não dá para desfazer (restauração só por backup).</p>
      ${exp.length ? html`<ul class="list">${exp.map((p) => html`<li><div class="maint-bk"><span><b>${p.social_name || p.name}</b><small>${p.status === 'alta' ? 'Alta' : 'Inativo'} · última atividade ${brDate(p.last_activity)}</small></span>
        ${req.user.is_master ? html`<form method="post" action="${BACK}/anonimizar/${p.id}" class="maint-inline" data-confirm="Anonimizar ${p.social_name || p.name}? O prontuário e os dados de identificação serão apagados definitivamente."><input type="password" name="password" placeholder="Sua senha" required autocomplete="current-password" aria-label="Sua senha"><button class="chip">Anonimizar</button></form>` : html`<small class="muted">Somente o usuário master pode anonimizar.</small>`}</div></li>`)}</ul>`
      : html`<p class="muted">Nenhum paciente com prazo vencido.</p>`}
    </section>
    <section class="card"><h2>Outros direitos do titular</h2>
      <p class="muted small">Cópia dos dados (acesso e portabilidade): na ficha do paciente → aba Dados → <b>Exportar dados (LGPD)</b>. Termos de consentimento: aba <b>Termos</b>. Textos dos termos: <a class="link" href="/configuracoes/termos">Termos e documentos</a>.</p>
    </section>`,
  }));
});
r.post('/', async (req, res) => {
  await P.saveConfig({ recordsYears: req.body.recordsYears, crmAuto: req.body.crmAuto, crmMonths: req.body.crmMonths });
  await audit(req, 'privacidade-config');
  res.flash('Prazos salvos.').redirect(BACK);
});
r.post('/anonimizar/:id', async (req, res) => {
  if (!req.user.is_master) throw forbidden();
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!req.body.password || !(await bcrypt.compare(String(req.body.password), u.password_hash))) return res.flash('Senha incorreta.', 'err').redirect(BACK);
  const c = await P.config(); const id = int(req.params.id);
  if (!(await P.expiredPatients(c.recordsYears)).some((p) => p.id === id)) return res.flash('Este paciente ainda está dentro do prazo de guarda.', 'err').redirect(BACK);
  await P.anonymize(id);
  await audit(req, 'lgpd-anonimizar', `patient:${id}`);
  res.flash('Paciente anonimizado.').redirect(BACK);
});
export default r;
