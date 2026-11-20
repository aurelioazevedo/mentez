// Configurações → Dados e demonstração (somente usuário master)
import bcrypt from 'bcryptjs';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { ROLES, proName, forbidden } from '../lib/perm.js';
import * as M from '../lib/maint.js';

const r = router();
export const requireMaster = (req, res, next) => {
  if (!req.user) return next(forbidden());
  M.ensureMaster(req.user.id).then((ok) => { req.user.is_master = ok ? 1 : 0; next(ok ? undefined : forbidden()); }, next);
};
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function checkPwd(req) {
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  return !!(u && req.body.password && (await bcrypt.compare(String(req.body.password), u.password_hash)));
}
const BACK = '/configuracoes/dados';

r.get('/', async (req, res) => {
  const c = await one(`SELECT (SELECT COUNT(*) FROM patients) pacientes, (SELECT COUNT(*) FROM appointments) agenda, (SELECT COUNT(*) FROM schedule_blocks) + (SELECT COUNT(*) FROM schedule_days) bloqueios,
    (SELECT COUNT(*) FROM payments) + (SELECT COUNT(*) FROM fin_entries) financeiro, (SELECT COUNT(*) FROM crm_cards) + (SELECT COUNT(*) FROM wa_messages) crm`);
  const users = await q('SELECT id, name, email, role, title, is_master, demo, active FROM users ORDER BY is_master DESC, demo, name');
  const heirs = users.filter((u) => u.active && ['admin', 'psicologo'].includes(u.role));
  const demo = await M.demoStats();
  const bks = await M.backups();
  send(res, page(req, {
    title: 'Dados e demonstração', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações · somente usuário master</p><h1>Dados e demonstração</h1>
      <p class="muted">Limpe os registros, exclua usuários e carregue dados de exemplo para apresentações.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <div class="flash ok">🔒 <b>Nunca são apagados:</b> chaves das IAs (Claude e Groq), conexão do WhatsApp, credenciais do Google, textos das mensagens, configuração do atendente virtual, dados da clínica, etapas do CRM, categorias e regras de repasse.</div>

    <section class="card">
      <h2>Dados de demonstração</h2>
      <p class="muted small sub-h">Cria pacientes, agenda (10 semanas passadas e 4 à frente), cobranças, pacotes, contas da clínica, cards do CRM com conversas e anotações de prontuário — tudo fictício. Os pacientes de exemplo <b>nunca recebem WhatsApp</b> nem vão para o Google Agenda; o que for “enviado” a eles é só simulado.</p>
      ${demo.any ? html`<p><span class="badge b-agendada">Carregados agora</span> ${demo.pacientes} pacientes · ${demo.crm} cards no CRM · ${demo.contas} contas · ${demo.usuarios} profissionais de exemplo</p>` : ''}
      <div class="maint-row">
        <form method="post" action="${BACK}/demo" class="maint-inline" data-confirm="${demo.any ? 'Recarregar os dados de demonstração (os atuais de exemplo são substituídos)?' : 'Carregar os dados de demonstração?'}">
          <label class="check"><input type="checkbox" name="pros" value="1" checked> Criar 2 profissionais de exemplo (Dr. Rafael e Dra. Helena)</label>
          <button class="btn">${demo.any ? 'Recarregar demonstração' : 'Carregar dados de demonstração'}</button>
        </form>
        ${demo.any ? html`<form method="post" action="${BACK}/demo/remover" data-confirm="Remover todos os dados de demonstração? Os dados reais não são tocados."><button class="btn ghost">Remover só a demonstração</button></form>` : ''}
      </div>
      <p class="muted small">Dica para apresentar: limpe os módulos abaixo (fica uma cópia de segurança) e depois carregue a demonstração. Ao terminar, remova a demonstração e, se quiser, restaure a cópia.</p>
    </section>

    <form method="post" action="${BACK}/limpar" class="card maint-wipe" data-confirm="Apagar definitivamente os itens marcados? Uma cópia de segurança será guardada antes.">
      <h2>Limpar registros</h2>
      <p class="muted small sub-h">Antes de apagar, o sistema guarda automaticamente uma cópia de segurança (as 5 mais recentes ficam disponíveis para restaurar).</p>
      <div class="maint-groups">${Object.entries(M.GROUPS).map(([k, g]) => html`<label class="maint-g"><input type="checkbox" name="g_${k}" value="1"><span><b>${g.label}</b> <small class="muted">· ${c[k]} registro(s)</small><small>${g.desc}</small></span></label>`)}</div>
      <h3>Usuários a excluir <small class="muted">(opcional)</small></h3>
      <p class="muted small">Marque só quem deve sair. Para manter os profissionais, não marque nenhum. Você e os usuários master não podem ser excluídos aqui.</p>
      <ul class="maint-users">${users.map((u) => {
        const locked = u.id === req.user.id || u.is_master;
        return html`<li><label class="check ${locked ? 'muted' : ''}"><input type="checkbox" name="u_${u.id}" value="1" ${locked ? raw('disabled') : ''}><span>${u.role === 'psicologo' || u.role === 'admin' ? proName(u) : u.name} <small class="muted">${ROLES[u.role]?.label || u.role}${u.is_master ? ' · master' : ''}${u.demo ? ' · exemplo' : ''}${u.active ? '' : ' · desativado'} · ${u.email}</small></span></label></li>`;
      })}</ul>
      <label class="fld"><span>Pacientes e cobranças dos usuários excluídos passam para</span><select name="heir">${heirs.map((u) => html`<option value="${u.id}" ${u.id === req.user.id ? raw('selected') : ''}>${proName(u)}</option>`)}</select></label>
      <div class="maint-confirm">
        <label class="fld"><span>Digite APAGAR para confirmar</span><input name="confirm" autocomplete="off" required pattern="APAGAR" placeholder="APAGAR"></label>
        <label class="fld"><span>Sua senha</span><input type="password" name="password" autocomplete="current-password" required></label>
      </div>
      <div class="actions"><button class="btn danger">Apagar itens marcados</button></div>
    </form>

    <section class="card"><h2>Cópias de segurança</h2>
      ${bks.length ? html`<ul class="list">${bks.map((b) => html`<li><div class="maint-bk"><span>${b.label}<small>${brDateTime(b.created_at)}${b.who ? ` · ${b.who}` : ''} · ${b.rows_count} registros · ${kb(b.size)}</small></span>
        <form method="post" action="${BACK}/restaurar/${b.id}" class="maint-inline" data-confirm="Restaurar esta cópia? Os dados de demonstração são removidos e as tabelas da cópia voltam ao estado salvo (usuários não são alterados)."><input type="password" name="password" placeholder="Sua senha" required autocomplete="current-password" aria-label="Sua senha"><button class="chip">Restaurar</button></form></div></li>`)}</ul>`
      : html`<p class="muted">Nenhuma cópia ainda. Ela é criada automaticamente toda vez que você limpa registros.</p>`}
    </section>

    <section class="card"><h2>Usuários master</h2>
      <p class="muted small sub-h">Só quem é master vê esta área. Precisa haver pelo menos um.</p>
      <ul class="list">${users.filter((u) => u.role === 'admin' && u.active && !u.demo).map((u) => html`<li><div class="maint-bk"><span>${u.name}<small>${u.email}${u.is_master ? ' · master' : ''}</small></span>
        <form method="post" action="${BACK}/master/${u.id}" class="maint-inline"><button class="chip">${u.is_master ? 'Tirar master' : 'Tornar master'}</button></form></div></li>`)}</ul>
    </section>`,
  }));
});

r.post('/limpar', async (req, res) => {
  if (req.body.confirm !== 'APAGAR') return res.flash('Digite APAGAR para confirmar.', 'err').redirect(BACK);
  if (!(await checkPwd(req))) return res.flash('Senha incorreta.', 'err').redirect(BACK);
  const groups = Object.keys(M.GROUPS).filter((k) => req.body[`g_${k}`]);
  const userIds = Object.keys(req.body).filter((k) => /^u_\d+$/.test(k)).map((k) => int(k.slice(2)));
  const out = await M.wipe({ groups, userIds, reassignTo: int(req.body.heir), actor: req.user });
  if (!out.ok) return res.flash(out.error, 'err').redirect(BACK);
  await audit(req, 'manutencao-limpar', out.label.slice(0, 200));
  res.flash(`Pronto: ${out.label}. Cópia de segurança nº ${out.backupId} guardada.`).redirect(BACK);
});

r.post('/demo', async (req, res) => {
  const out = await M.loadDemo({ withProfessionals: !!req.body.pros, actor: req.user });
  await audit(req, 'manutencao-demo', `${out.patients} pacientes`);
  res.flash(`Demonstração carregada: ${out.patients} pacientes, ${out.appts} sessões, ${out.pays} cobranças e ${out.cards} cards no CRM${out.pros ? `, ${out.pros} profissionais de exemplo` : ''}.`).redirect(BACK);
});

r.post('/demo/remover', async (req, res) => {
  await M.removeDemo();
  await audit(req, 'manutencao-demo-remover');
  res.flash('Dados de demonstração removidos.').redirect(BACK);
});

r.post('/restaurar/:id', async (req, res) => {
  if (!(await checkPwd(req))) return res.flash('Senha incorreta.', 'err').redirect(BACK);
  const out = await M.restore(int(req.params.id));
  await audit(req, 'manutencao-restaurar', `backup:${int(req.params.id)}`);
  res.flash(out.ok ? `Cópia restaurada (${out.rows} registros).` : out.error, out.ok ? 'ok' : 'err').redirect(BACK);
});

r.post('/master/:id', async (req, res) => {
  const u = await one("SELECT id, is_master FROM users WHERE id = ? AND role = 'admin' AND active = 1 AND demo = 0", [int(req.params.id)]);
  if (!u) return res.flash('Usuário inválido.', 'err').redirect(BACK);
  if (u.is_master && (await one('SELECT COUNT(*) n FROM users WHERE is_master = 1 AND active = 1')).n <= 1) return res.flash('Precisa haver pelo menos um usuário master.', 'err').redirect(BACK);
  await q('UPDATE users SET is_master = 1 - is_master WHERE id = ?', [u.id]);
  await audit(req, 'manutencao-master', `user:${u.id}`);
  res.flash('Usuário master atualizado.').redirect(u.id === req.user.id && u.is_master ? '/configuracoes' : BACK);
});

export default r;
