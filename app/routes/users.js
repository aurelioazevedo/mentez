import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { ROLES, ROLE_KEYS, PERM_LABELS, isClinician, TITLES, proTitle, proName } from '../lib/perm.js';
import { isYmd } from '../lib/time.js';
import { syncLater, futureIds } from '../lib/google.js';

const r = router();

// Senha provisória legível (sem caracteres ambíguos), trocada no primeiro login.
function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += A[b[i] % A.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

const roleBadge = (role) => html`<span class="badge role-${role}">${ROLES[role]?.label || role}</span>`;

async function activeAdmins(exceptId = 0) {
  const row = await one("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [exceptId]);
  return row.n;
}

function matrix() {
  const perms = Object.keys(PERM_LABELS);
  return html`<div class="tbl-wrap"><table class="tbl matrix"><thead><tr><th>Perfil</th>${perms.map((p) => html`<th>${PERM_LABELS[p]}</th>`)}<th>Pacientes visíveis</th></tr></thead>
  <tbody>${ROLE_KEYS.map((k) => html`<tr><td>${roleBadge(k)}<small class="muted block">${ROLES[k].desc}</small></td>
    ${perms.map((p) => html`<td class="c">${ROLES[k].perms.includes(p) ? html`<span class="yes" aria-label="sim">✓</span>` : html`<span class="no" aria-label="não">—</span>`}</td>`)}
    <td>${ROLES[k].perms.some((p) => ['agenda', 'cadastro', 'prontuario'].includes(p)) ? (ROLES[k].scope === 'proprios' ? 'Somente os seus' : 'Todos') : '—'}</td></tr>`)}</tbody></table></div>`;
}

// ---------- lista ----------
r.get('/', async (req, res) => {
  const users = await q(`SELECT u.*, (SELECT COUNT(*) FROM patients p WHERE p.owner_id = u.id AND p.status = 'ativo') pacientes
    FROM users u ORDER BY u.active DESC, FIELD(u.role,'admin','psicologo','secretaria','financeiro'), u.name`);
  send(res, page(req, {
    title: 'Usuários', active: 'usuarios',
    body: html`
    <header class="ph"><div><p class="eyebrow">Administração</p><h1>Usuários e acessos</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Configurações</a><a class="btn" href="/usuarios/novo">+ Novo usuário</a></div></header>
    <section class="card flush">
      <div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>2 etapas</th><th>Pacientes</th><th>Último acesso</th><th>Situação</th></tr></thead>
      <tbody>${users.map((u) => html`<tr data-href="/usuarios/${u.id}" class="${u.active ? '' : 'off'}">
        <td><a href="/usuarios/${u.id}"><b>${isClinician(u.role) ? proName(u) : u.name}</b></a>${u.crp ? html`<small class="muted block">CRP ${u.crp}</small>` : ''}${isClinician(u.role) ? html`<small class="muted block">${u.attends ? `atende ${String(u.modalities || '').split(',').filter(Boolean).map((m) => (m === 'online' ? 'on-line' : 'presencial')).join(' e ')}` : 'não atende pacientes'}</small>` : ''}${u.id === req.user.id ? html` <small class="muted">(você)</small>` : ''}</td>
        <td>${u.email}</td><td>${roleBadge(u.role)}</td>
        <td>${u.totp_enabled ? html`<span class="badge b-realizada">Ativa</span>` : html`<span class="badge b-agendada">Não</span>`}</td>
        <td>${isClinician(u.role) ? u.pacientes : '—'}</td>
        <td>${u.last_login_at ? brDateTime(u.last_login_at) : 'nunca'}</td>
        <td>${u.active ? html`<span class="badge b-ativo">Ativo</span>` : html`<span class="badge b-inativo">Desativado</span>`}</td></tr>`)}</tbody></table></div>
    </section>
    <section class="card"><h2>Níveis de acesso</h2>${matrix()}
      <p class="muted small">O prontuário e as respostas dos exercícios são visíveis apenas a perfis clínicos (Código de Ética do Psicólogo, art. 9º; Resolução CFP nº 01/2009). Psicólogos(as) colaboradores(as) veem somente os pacientes sob sua responsabilidade.</p></section>`,
  }));
});

// ---------- formulário ----------
function form(u, action, isNew) {
  return html`<form method="post" action="${action}" class="card form-grid">
    <label class="fld"><span>Nome *</span><input name="name" required maxlength="120" value="${u.name || ''}"></label>
    <label class="fld"><span>E-mail de acesso *</span><input type="email" name="email" required maxlength="190" value="${u.email || ''}" autocomplete="off"></label>
    <label class="fld"><span>Telefone</span><input name="phone" maxlength="40" value="${u.phone || ''}" inputmode="tel"></label>
    <label class="fld"><span>Tratamento (como pacientes e o atendente se referem)</span><select name="title"><option value="">— escolha (obrigatório para psicólogos) —</option>${TITLES.map((t) => html`<option value="${t}" ${(u.title || (u.name && isClinician(u.role) ? proTitle(u) : '')) === t ? raw('selected') : ''}>${t} ${u.name ? String(u.name).split(' ')[0] : '(nome)'}</option>`)}</select></label>
    <label class="fld"><span>CRP (perfis clínicos)</span><input name="crp" maxlength="30" value="${u.crp || ''}" placeholder="09/00000"></label>
    <fieldset class="fld span2"><legend>Perfil de acesso *</legend>
      <div class="roles">${ROLE_KEYS.map((k) => html`<label class="role-opt"><input type="radio" name="role" value="${k}" required ${k === (u.role || 'secretaria') ? raw('checked') : ''}>
        <span><b>${ROLES[k].label}</b><small>${ROLES[k].desc}</small></span></label>`)}</div>
    </fieldset>
    <fieldset class="fld span2 us-attend" data-attend-box><legend>Atendimento a pacientes</legend>
      <label class="check"><input type="checkbox" name="attends" value="1" ${(u.attends ?? 1) ? raw('checked') : ''} data-attend> <span><b>Atende pacientes</b> <small class="muted">— aparece na agenda, na escala, no agendamento online, no atendente virtual e como responsável por pacientes. Desmarque para administradores que só gerenciam.</small></span></label>
      <div class="wl-chips" data-attend-mods>${[['online', 'On-line'], ['presencial', 'Presencial']].map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="modalities" value="${k}" ${String(u.modalities ?? 'online,presencial').split(',').includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</div>
      <small class="muted">Modalidades em que atende: o agendamento online, o atendente virtual e a agenda só oferecem o que estiver marcado.</small>
    </fieldset>
    ${isNew ? html`<p class="span2 muted small">Uma senha provisória será gerada e mostrada uma única vez. A pessoa precisará trocá-la no primeiro acesso.</p>` : ''}
    <div class="span2 actions"><button class="btn">${isNew ? 'Criar usuário' : 'Salvar alterações'}</button><a class="btn ghost" href="/usuarios">Cancelar</a></div>
  </form>`;
}

function readBody(b) {
  return {
    name: str(b.name, 120), email: str(b.email, 190).toLowerCase(), phone: str(b.phone, 40) || null, crp: str(b.crp, 30) || null,
    role: ROLE_KEYS.includes(b.role) ? b.role : null, title: TITLES.includes(b.title) ? b.title : null,
    attends: isClinician(b.role) && b.attends ? 1 : 0,
    modalities: [].concat(b.modalities || []).filter((m) => m === 'online' || m === 'presencial').sort().join(','),
  };
}
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function showPassword(req, res, u, pwd, title) {
  send(res, page(req, {
    title, active: 'usuarios',
    body: html`<header class="ph"><div><p class="eyebrow">Usuários</p><h1>${title}</h1></div></header>
    <section class="card">
      <p><b>${u.name}</b> · ${u.email} · ${roleBadge(u.role)}</p>
      <p>Senha provisória (aparece só agora):</p>
      <div class="copy"><input readonly value="${pwd}" id="pwd" class="mono"><button class="btn ghost" data-copy="#pwd">Copiar</button></div>
      <p class="muted small">Entregue pessoalmente ou por um canal privado. No primeiro acesso em <b>sistema.lorrainymendes.com.br</b> o sistema pedirá uma nova senha. Recomende ativar a verificação em duas etapas em “Conta”.</p>
      <div class="actions"><a class="btn" href="/usuarios/${u.id}">Ver usuário</a><a class="btn ghost" href="/usuarios">Voltar à lista</a></div>
    </section>`,
  }));
}

r.get('/novo', (req, res) => send(res, page(req, {
  title: 'Novo usuário', active: 'usuarios',
  body: html`<header class="ph"><div><p class="eyebrow">Usuários</p><h1>Novo usuário</h1></div></header>${form({}, '/usuarios/novo', true)}`,
})));

r.post('/novo', async (req, res) => {
  const d = readBody(req.body);
  if (!d.name || !validEmail(d.email) || !d.role) return res.flash('Preencha nome, e-mail válido e perfil.', 'err').redirect('/usuarios/novo');
  if (isClinician(d.role) && !d.title) return res.flash('Escolha o tratamento (Dr. ou Dra.) para perfis clínicos.', 'err').redirect('/usuarios/novo');
  if (d.attends && !d.modalities) return res.flash('Marque em quais modalidades o profissional atende (on-line e/ou presencial).', 'err').redirect('/usuarios/novo');
  if (await one('SELECT id FROM users WHERE email = ?', [d.email])) return res.flash('Já existe um usuário com este e-mail.', 'err').redirect('/usuarios/novo');
  const pwd = tempPassword();
  const out = await q('INSERT INTO users (name, email, phone, crp, title, role, attends, modalities, password_hash, must_change_password) VALUES (?,?,?,?,?,?,?,?,?,1)',
    [d.name, d.email, d.phone, d.crp, d.title, d.role, d.attends, d.modalities || 'online,presencial', await bcrypt.hash(pwd, 12)]);
  await audit(req, 'usuario-criar', `user:${out.insertId} (${d.role})`);
  showPassword(req, res, { ...d, id: out.insertId }, pwd, 'Usuário criado');
});


// ---------- detalhe ----------
r.get('/:id', async (req, res, next) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [int(req.params.id)]);
  if (!u) return next();
  const self = u.id === req.user.id;
  const [patients, logs, others] = await Promise.all([
    q('SELECT id, name, social_name, status FROM patients WHERE owner_id = ? ORDER BY status, name', [u.id]),
    q('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 25', [u.id]),
    q("SELECT id, name, role FROM users WHERE id <> ? AND active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name", [u.id]),
  ]);
  send(res, page(req, {
    title: u.name, active: 'usuarios',
    body: html`
    <header class="ph"><div><p class="eyebrow">${ROLES[u.role]?.label} · ${u.active ? 'ativo' : 'desativado'}</p><h1>${u.name}</h1>
      <p class="muted">Criado em ${brDate(u.created_at)} · último acesso ${u.last_login_at ? brDateTime(u.last_login_at) : 'nunca'}</p></div></header>
    ${form(u, `/usuarios/${u.id}`, false)}
    <div class="grid2">
      <section class="card"><h2>Segurança</h2>
        <p>Verificação em duas etapas: ${u.totp_enabled ? html`<span class="badge b-realizada">Ativa</span>` : html`<span class="badge b-agendada">Não ativada</span>`}</p>
        ${u.must_change_password ? html`<p><span class="badge b-respondido">Aguardando troca da senha provisória</span></p>` : ''}
        <div class="actions">
          <form method="post" action="/usuarios/${u.id}/senha" data-confirm="Gerar uma nova senha provisória? A senha atual deixa de funcionar e as sessões abertas serão encerradas."><button class="btn ghost">Redefinir senha</button></form>
          ${u.totp_enabled ? html`<form method="post" action="/usuarios/${u.id}/2fa" data-confirm="Remover a verificação em duas etapas deste usuário (ex.: celular perdido)?"><button class="btn ghost">Remover 2 etapas</button></form>` : ''}
          <form method="post" action="/usuarios/${u.id}/encerrar" data-confirm="Encerrar todas as sessões abertas deste usuário?"><button class="btn ghost">Encerrar sessões</button></form>
        </div>
      </section>
      <section class="card"><h2>Situação</h2>
        ${self ? html`<p class="muted">Você não pode desativar o próprio acesso.</p>` : u.active
          ? html`<p>Ao desativar, o acesso é bloqueado na hora. O histórico e os registros feitos por este usuário são mantidos.</p>
            <form method="post" action="/usuarios/${u.id}/ativo" data-confirm="Desativar este acesso agora?"><input type="hidden" name="active" value="0"><button class="btn danger">Desativar acesso</button></form>`
          : html`<p>Este acesso está desativado.</p><form method="post" action="/usuarios/${u.id}/ativo"><input type="hidden" name="active" value="1"><button class="btn">Reativar acesso</button></form>`}
      </section>
    </div>
    ${isClinician(u.role) || patients.length ? html`
    <section class="card"><h2>Pacientes sob responsabilidade (${patients.length})</h2>
      ${patients.length ? html`<p class="chips">${patients.map((p) => html`<a class="chip" href="/pacientes/${p.id}">${p.social_name || p.name}${p.status !== 'ativo' ? ` · ${p.status}` : ''}</a>`)}</p>
        ${others.length ? html`<form method="post" action="/usuarios/${u.id}/transferir" class="filters" data-confirm="Transferir todos os pacientes (com prontuários) para o(a) profissional escolhido(a)?">
          <span class="muted small">Transferir todos para</span><select name="to" required>${others.map((o) => html`<option value="${o.id}">${o.name} (${ROLES[o.role].label})</option>`)}</select><button class="btn ghost">Transferir</button></form>` : ''}`
        : html`<p class="muted">Nenhum paciente. Defina o(a) responsável na ficha de cada paciente.</p>`}
    </section>` : ''}
    <section class="card flush"><h2 class="pad-h">Últimas ações</h2>
      ${logs.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Ação</th><th>Alvo</th><th>IP</th></tr></thead>
      <tbody>${logs.map((l) => html`<tr><td>${brDateTime(l.created_at)}</td><td>${l.action}</td><td>${l.target || ''}</td><td>${l.ip || ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Sem registros.</p>`}
      <p class="pad-h"><a class="link" href="/configuracoes/acessos?usuario=${u.id}">Ver histórico completo →</a></p>
    </section>`,
  }));
});

r.post('/:id', async (req, res, next) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [int(req.params.id)]);
  if (!u) return next();
  const d = readBody(req.body);
  if (!d.name || !validEmail(d.email) || !d.role) return res.flash('Preencha nome, e-mail válido e perfil.', 'err').redirect(`/usuarios/${u.id}`);
  if (isClinician(d.role) && !d.title) return res.flash('Escolha o tratamento (Dr. ou Dra.) para perfis clínicos.', 'err').redirect(`/usuarios/${u.id}`);
  if (d.attends && !d.modalities) return res.flash('Marque em quais modalidades o profissional atende (on-line e/ou presencial).', 'err').redirect(`/usuarios/${u.id}`);
  if (await one('SELECT id FROM users WHERE email = ? AND id <> ?', [d.email, u.id])) return res.flash('Já existe outro usuário com este e-mail.', 'err').redirect(`/usuarios/${u.id}`);
  if (u.role === 'admin' && d.role !== 'admin' && (await activeAdmins(u.id)) === 0) return res.flash('É preciso manter pelo menos um(a) administrador(a) ativo(a).', 'err').redirect(`/usuarios/${u.id}`);
  const roleChanged = d.role !== u.role;
  await q(`UPDATE users SET name = ?, email = ?, phone = ?, crp = ?, title = ?, role = ?, attends = ?, modalities = ?${roleChanged ? ', session_version = session_version + 1' : ''} WHERE id = ?`,
    [d.name, d.email, d.phone, d.crp, d.title, d.role, d.attends, d.modalities || u.modalities || 'online,presencial', u.id]);
  await audit(req, roleChanged ? 'usuario-perfil' : 'usuario-editar', `user:${u.id}${roleChanged ? ` ${u.role}→${d.role}` : ''}`);
  if (roleChanged && u.id === req.user.id) return res.flash('Seu perfil foi alterado. Entre novamente.').redirect('/login');
  res.flash(roleChanged ? 'Perfil alterado. As sessões abertas deste usuário foram encerradas.' : 'Dados atualizados.').redirect(`/usuarios/${u.id}`);
});

r.post('/:id/senha', async (req, res, next) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [int(req.params.id)]);
  if (!u) return next();
  const pwd = tempPassword();
  await q('UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?', [await bcrypt.hash(pwd, 12), u.id]);
  await audit(req, 'usuario-redefinir-senha', `user:${u.id}`);
  showPassword(req, res, u, pwd, 'Senha redefinida');
});

r.post('/:id/2fa', async (req, res) => {
  const id = int(req.params.id);
  await q('UPDATE users SET totp_enabled = 0, totp_secret = NULL, session_version = session_version + 1 WHERE id = ?', [id]);
  await audit(req, 'usuario-remover-2fa', `user:${id}`);
  if (id === req.user.id) return res.redirect('/login');
  res.flash('Verificação em duas etapas removida. Peça para a pessoa ativar de novo em “Conta”.').redirect(`/usuarios/${id}`);
});

r.post('/:id/encerrar', async (req, res) => {
  const id = int(req.params.id);
  await q('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [id]);
  await audit(req, 'usuario-encerrar-sessoes', `user:${id}`);
  if (id === req.user.id) return res.redirect('/login');
  res.flash('Sessões encerradas.').redirect(`/usuarios/${id}`);
});

r.post('/:id/ativo', async (req, res, next) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [int(req.params.id)]);
  if (!u) return next();
  const active = req.body.active === '1';
  if (u.id === req.user.id) return res.flash('Você não pode desativar o próprio acesso.', 'err').redirect(`/usuarios/${u.id}`);
  if (!active && u.role === 'admin' && (await activeAdmins(u.id)) === 0) return res.flash('É preciso manter pelo menos um(a) administrador(a) ativo(a).', 'err').redirect(`/usuarios/${u.id}`);
  await q('UPDATE users SET active = ?, session_version = session_version + 1 WHERE id = ?', [active ? 1 : 0, u.id]);
  await audit(req, active ? 'usuario-reativar' : 'usuario-desativar', `user:${u.id}`);
  res.flash(active ? 'Acesso reativado.' : 'Acesso desativado.').redirect(`/usuarios/${u.id}`);
});

r.post('/:id/transferir', async (req, res, next) => {
  const from = await one('SELECT id FROM users WHERE id = ?', [int(req.params.id)]);
  const to = await one("SELECT id, name FROM users WHERE id = ? AND active = 1 AND role IN ('admin','psicologo') AND attends = 1", [int(req.body.to)]);
  if (!from || !to || from.id === to.id) return next();
  const moved = await futureIds('p.owner_id = ?', [from.id]);
  const out = await q('UPDATE patients SET owner_id = ? WHERE owner_id = ?', [to.id, from.id]);
  syncLater(moved); // eventos saem da agenda Google antiga e entram na nova
  await audit(req, 'pacientes-transferir', `user:${from.id}→user:${to.id} (${out.affectedRows})`);
  res.flash(`${out.affectedRows} paciente(s) transferido(s) para ${to.name}.`).redirect(`/usuarios/${from.id}`);
});

export default r;

// ---------- registro de acessos (auditoria) ----------
const ACTIONS = {
  login: 'Entrou', 'login-2fa': 'Entrou (2 etapas)', logout: 'Saiu', 'prontuario-ver': 'Abriu ficha/prontuário', 'prontuario-registrar': 'Registrou no prontuário',
  'prontuario-editar': 'Editou registro', 'prontuario-imprimir': 'Imprimiu prontuário', 'exercicio-enviar': 'Enviou exercício', 'exercicio-ver': 'Abriu exercício',
};
export async function acessos(req, res) {
  const uid = int(req.query.usuario);
  const de = isYmd(req.query.de) ? req.query.de : null;
  const ate = isYmd(req.query.ate) ? req.query.ate : null;
  const where = ['1=1'], params = [];
  if (uid) { where.push('l.user_id = ?'); params.push(uid); }
  if (de) { where.push('l.created_at >= ?'); params.push(de); }
  if (ate) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(ate); }
  if (req.query.tipo === 'clinico') where.push("(l.action LIKE 'prontuario%' OR l.action LIKE 'exercicio%')");
  if (req.query.tipo === 'admin') where.push("(l.action LIKE 'usuario%' OR l.action LIKE 'pacientes-transferir%')");
  const [rows, users] = await Promise.all([
    q(`SELECT l.*, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 300`, params),
    q('SELECT id, name FROM users ORDER BY name'),
  ]);
  const sel = (v, x) => (String(v) === String(x) ? raw('selected') : '');
  send(res, page(req, {
    title: 'Registro de acessos', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Registro de acessos</h1></div><div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form class="filters" method="get">
      <select name="usuario"><option value="">Todos os usuários</option>${users.map((u) => html`<option value="${u.id}" ${sel(uid, u.id)}>${u.name}</option>`)}</select>
      <select name="tipo"><option value="">Todas as ações</option><option value="clinico" ${sel(req.query.tipo, 'clinico')}>Dados clínicos</option><option value="admin" ${sel(req.query.tipo, 'admin')}>Administração</option></select>
      <input type="date" name="de" value="${de || ''}" aria-label="De"><input type="date" name="ate" value="${ate || ''}" aria-label="Até">
      <button class="btn ghost">Filtrar</button>
    </form>
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>IP</th></tr></thead>
      <tbody>${rows.map((l) => html`<tr><td>${brDateTime(l.created_at)}</td><td>${l.name || '—'}</td><td>${ACTIONS[l.action] || l.action}</td><td>${l.target || ''}</td><td>${l.ip || ''}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhum registro no período.</p>`}</section>
    <p class="muted small">Mostrando até 300 registros. O registro de acessos não pode ser editado nem apagado pelo sistema.</p>`,
  }));
}
