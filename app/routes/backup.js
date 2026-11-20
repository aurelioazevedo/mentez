// Configurações → Backup (somente usuário master): Google Drive, backup manual, agendamentos, histórico e restauração.
import * as Brand from '../lib/brand.js';
import express from 'express';
import bcrypt from 'bcryptjs';
import { one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import * as BK from '../lib/backup.js';
import * as G from '../lib/google.js';

const r = router();
const BACK = '/configuracoes/backup';
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const DOW = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
async function checkPwd(req) {
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  return !!(u && req.body.password && (await bcrypt.compare(String(req.body.password), u.password_hash)));
}
const partsOf = (b) => Object.keys(BK.PARTS).filter((p) => b[`p_${p}`]);

r.get('/', async (req, res) => {
  const c = await BK.config();
  const gOk = !!(await G.config());
  const hist = await BK.history();
  const running = hist.find((h) => h.status === 'andamento');
  const partsBoxes = (sel, prefix = 'p_') => Object.entries(BK.PARTS).map(([k, p]) => html`<label class="maint-g"><input type="checkbox" name="${prefix}${k}" value="1" ${sel.includes(k) ? raw('checked') : ''}><span><b>${p.label}</b><small>${p.desc}</small></span></label>`);
  const modeRadios = (sel, name = 'mode') => html`<div class="bk-mode">${[['juntos', 'Juntos', 'Um único arquivo .zip com tudo'], ['separados', 'Separados', 'Um arquivo para cada parte (banco .sql.gz e anexos .zip)']].map(([v, l, d]) => html`<label class="maint-g"><input type="radio" name="${name}" value="${v}" ${sel === v ? raw('checked') : ''}><span><b>${l}</b><small>${d}</small></span></label>`)}</div>`;
  const sched = (k, label, extra) => html`<div class="bk-sched"><label class="check"><input type="checkbox" name="${k}_on" value="1" ${c[k].on ? raw('checked') : ''}> <b>${label}</b></label>${extra}<label class="bk-keep">manter as últimas <input type="number" name="${k}_keep" min="1" max="60" value="${c[k].keep}"> cópias</label></div>`;
  send(res, page(req, {
    title: 'Backup', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações · somente usuário master</p><h1>Backup</h1>
      <p class="muted">Cópias de segurança do sistema no Google Drive — manuais e automáticas.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${c.error ? html`<div class="flash err">${c.error}</div>` : ''}

    <section class="card bk-drive"><h2>Google Drive</h2>
      ${BK.connected(c) ? html`<p><span class="badge b-realizada">Conectado</span> ${c.email || ''}</p>
        <p class="muted small">Os arquivos ficam na pasta <b>“Backups — ${Brand.get().appName}”</b>. O sistema só enxerga os arquivos que ele mesmo criou no seu Drive.</p>
        <div class="actions">${BK.folderUrl(c) ? html`<a class="btn ghost" href="${BK.folderUrl(c)}" target="_blank" rel="noopener">Abrir pasta no Drive</a>` : ''}
          <form method="post" action="${BACK}/desconectar" data-confirm="Desconectar o Google Drive? Os backups automáticos param até conectar de novo. Os arquivos já salvos continuam no Drive."><button class="btn ghost danger-text">Desconectar</button></form></div>`
      : gOk ? html`<p class="muted">Conecte a conta Google onde os backups serão guardados.</p><a class="btn" href="${BACK}/conectar">Conectar Google Drive</a>
        <p class="muted small">Usa as mesmas credenciais da Google Agenda. No Google Cloud, ative a <b>Google Drive API</b> no mesmo projeto.</p>`
      : html`<p class="muted">Primeiro cadastre as credenciais do Google em <a class="link" href="/configuracoes/google">Configurações → Google Agenda</a>.</p>`}
    </section>

    <form method="post" action="${BACK}/agora" class="card"><h2>Fazer backup agora</h2>
      ${running ? html`<div class="flash warn">Há um backup em andamento (iniciado ${brDateTime(running.started_at)}). Esta página atualiza sozinha.</div>` : ''}
      <div class="maint-groups">${partsBoxes(c.parts)}</div>
      <h3>Arquivos</h3>${modeRadios(c.mode)}
      <div class="actions">
        <button class="btn" name="dest" value="drive" ${BK.connected(c) && !running ? '' : raw('disabled')}>Fazer backup no Google Drive</button>
        <button class="btn ghost" name="dest" value="download" formtarget="_self">Baixar no computador</button>
      </div>
    </form>

    <form method="post" action="${BACK}/agendamento" class="card"><h2>Backup automático</h2>
      <p class="muted small sub-h">Roda sozinho a partir do horário escolhido. As cópias mais antigas são apagadas automaticamente do Drive conforme a quantidade a manter.</p>
      <div class="bk-scheds">
        ${sched('diario', 'Diário', '')}
        ${sched('semanal', 'Semanal', html`<label>no(a) <select name="semanal_dow">${DOW.map((d, i) => html`<option value="${i}" ${Number(c.semanal.dow) === i ? raw('selected') : ''}>${d}</option>`)}</select></label>`)}
        ${sched('mensal', 'Mensal', html`<label>no dia <select name="mensal_day">${Array.from({ length: 28 }, (_, i) => html`<option ${Number(c.mensal.day) === i + 1 ? raw('selected') : ''}>${i + 1}</option>`)}</select></label>`)}
      </div>
      <label class="fld bk-hour"><span>A partir de</span><select name="hour">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${Number(c.hour) === h ? raw('selected') : ''}>${String(h).padStart(2, '0')}:00</option>`)}</select></label>
      <h3>O que incluir nos automáticos</h3><div class="maint-groups">${partsBoxes(c.parts, 'a_')}</div>
      ${modeRadios(c.mode, 'a_mode')}
      <div class="actions"><button class="btn">Salvar agendamento</button></div>
      ${!BK.connected(c) ? html`<p class="muted small">Os automáticos só rodam com o Google Drive conectado.</p>` : ''}
    </form>

    <section class="card"><h2>Histórico</h2>
      ${hist.length ? html`<ul class="list bk-hist">${hist.map((h) => {
        const files = JSON.parse(h.files || '[]');
        return html`<li><div class="maint-bk"><div class="bk-info"><div class="bk-title"><b>${BK.KINDS[h.kind] || h.kind}</b> · ${brDateTime(h.started_at)} ${h.status === 'ok' ? html`<i class="badge b-realizada">OK</i>` : h.status === 'erro' ? html`<i class="badge b-falta">Falhou</i>` : html`<i class="badge b-agendada">Em andamento…</i>`}</div>
          <small>${h.parts.split(',').map((p) => BK.PARTS[p]?.label || p).join(' + ')} · ${h.mode}${h.size ? ` · ${size(h.size)}` : ''}${h.dest === 'download' ? ' · baixado no computador' : ''}${h.who ? ` · ${h.who}` : ''}</small>
          ${h.error ? html`<small class="neg">${h.error}</small>` : ''}
          ${files.filter((f) => f.link).map((f) => html`<small>📄 <a class="link" href="${f.link}" target="_blank" rel="noopener">${f.name}</a> (${size(f.size)})</small>`)}</div>
          ${h.status === 'ok' && h.dest === 'drive' ? html`<form method="post" action="${BACK}/restaurar/${h.id}" class="maint-inline" data-confirm="Restaurar este backup? Os dados atuais serão substituídos pelos do backup (antes, uma cópia do estado atual é enviada ao Drive)."><input type="password" name="password" placeholder="Sua senha" required autocomplete="current-password" aria-label="Sua senha"><button class="chip">Restaurar</button></form>` : ''}
          ${h.status !== 'andamento' ? html`<form method="post" action="${BACK}/excluir/${h.id}" data-confirm="Excluir este backup${h.dest === 'drive' ? ' (apaga também do Google Drive)' : ''}?"><button class="chip">Excluir</button></form>` : ''}</div></li>`;
      })}</ul>` : html`<p class="muted">Nenhum backup ainda.</p>`}
    </section>

    <section class="card"><h2>Restaurar a partir de um arquivo</h2>
      <p class="muted small sub-h">Envie um arquivo de backup deste sistema (.zip, .sql.gz ou .sql). Os dados atuais serão substituídos — antes, uma cópia do estado atual vai para o Drive.</p>
      <div class="maint-row"><input type="password" id="bk-pwd" placeholder="Sua senha" autocomplete="current-password" aria-label="Sua senha">
        <label class="btn ghost file-btn"><input type="file" accept=".zip,.gz,.sql" data-bk-upload="${BACK}/restaurar-arquivo" hidden>⬆ Escolher arquivo e restaurar</label></div>
      <span class="muted small" data-upload-msg></span>
    </section>`,
  }));
});

r.get('/conectar', async (req, res) => {
  const url = await BK.authUrl(req, req.user.id);
  if (!url) return res.flash('Cadastre primeiro as credenciais do Google (Configurações → Google Agenda).', 'err').redirect(BACK);
  res.redirect(url);
});
// Retorno do Google (chamado por /conta/google/retorno quando o estado é do Drive)
export async function oauthReturn(req, res) {
  if (!req.user?.is_master) return res.redirect('/configuracoes');
  if (req.query.error) return res.flash(req.query.error === 'access_denied' ? 'Conexão cancelada.' : `Google: ${String(req.query.error).slice(0, 80)}`, 'warn').redirect(BACK);
  try {
    const email = await BK.connect(req, String(req.query.code || '').slice(0, 2000));
    await audit(req, 'backup-drive-conectar', email);
    res.flash(`Google Drive conectado${email ? ` (${email})` : ''}. A pasta de backups foi criada.`).redirect(BACK);
  } catch (e) { res.flash(`Falha ao conectar o Google Drive: ${e.message}`, 'err').redirect(BACK); }
}
r.post('/desconectar', async (req, res) => {
  await BK.disconnect(); await audit(req, 'backup-drive-desconectar');
  res.flash('Google Drive desconectado.').redirect(BACK);
});

r.post('/agora', async (req, res) => {
  const parts = partsOf(req.body); const mode = req.body.mode === 'separados' ? 'separados' : 'juntos';
  if (!parts.length) return res.flash('Escolha o que incluir no backup.', 'err').redirect(BACK);
  await audit(req, 'backup-manual', `${req.body.dest} ${parts.join('+')} ${mode}`);
  if (req.body.dest === 'download') {
    const out = await BK.run({ kind: 'manual', parts, mode, dest: 'download', userId: req.user.id });
    if (!out.ok) return res.flash(`Backup falhou: ${out.error}`, 'err').redirect(BACK);
    let file = out.build.files[0];
    if (out.build.files.length > 1) { const AdmZip = (await import('adm-zip')).default; const z = new AdmZip(); out.build.files.forEach((f) => z.addFile(f.name, f.buf)); file = { name: file.name.replace(/^banco-/, 'backup-separado-').replace(/\.sql\.gz$/, '.zip'), buf: z.toBuffer(), mime: 'application/zip' }; }
    res.set({ 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="${file.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.send(file.buf);
  }
  BK.run({ kind: 'manual', parts, mode, dest: 'drive', userId: req.user.id }); // em segundo plano; a página acompanha ao vivo
  res.flash('Backup iniciado — acompanhe no histórico abaixo.').redirect(BACK);
});

r.post('/agendamento', async (req, res) => {
  const b = req.body; const k = (n, d, lo, hi) => Math.max(lo, Math.min(hi, int(n) ?? d));
  const parts = Object.keys(BK.PARTS).filter((p) => b[`a_${p}`]);
  await BK.saveConfig({
    hour: k(b.hour, 3, 0, 23), mode: b.a_mode === 'separados' ? 'separados' : 'juntos', parts: parts.length ? parts : ['banco', 'anexos'],
    diario: { on: !!b.diario_on, keep: k(b.diario_keep, 7, 1, 60) },
    semanal: { on: !!b.semanal_on, keep: k(b.semanal_keep, 4, 1, 60), dow: k(b.semanal_dow, 0, 0, 6) },
    mensal: { on: !!b.mensal_on, keep: k(b.mensal_keep, 6, 1, 60), day: k(b.mensal_day, 1, 1, 28) },
  });
  await audit(req, 'backup-agendamento');
  res.flash('Agendamento salvo.').redirect(BACK);
});

r.post('/excluir/:id', async (req, res) => {
  await BK.remove(int(req.params.id)); await audit(req, 'backup-excluir', `run:${int(req.params.id)}`);
  res.flash('Backup excluído.').redirect(BACK);
});

r.post('/restaurar/:id', async (req, res) => {
  if (!(await checkPwd(req))) return res.flash('Senha incorreta.', 'err').redirect(BACK);
  const h = await one("SELECT * FROM backup_runs WHERE id = ? AND status = 'ok' AND dest = 'drive'", [int(req.params.id)]);
  if (!h) return res.flash('Backup não encontrado.', 'err').redirect(BACK);
  try {
    const parts = {};
    for (const f of JSON.parse(h.files || '[]')) Object.assign(parts, BK.readArchive(await BK.downloadFile(f.id), f.name));
    const out = await BK.restore(parts, req.user.id);
    await audit(req, 'backup-restaurar', `run:${h.id}`);
    res.flash(out.ok ? `Backup de ${brDateTime(h.started_at)} restaurado.${out.beforeId ? ' Uma cópia do estado anterior foi salva no Drive.' : ''}` : out.error, out.ok ? 'ok' : 'err').redirect(BACK);
  } catch (e) { res.flash(`Falha ao restaurar: ${e.message}`, 'err').redirect(BACK); }
});

r.post('/restaurar-arquivo', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  const pwd = String(req.get('x-password') || '');
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!pwd || !(await bcrypt.compare(pwd, u.password_hash))) return res.status(403).json({ ok: false, error: 'Senha incorreta.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf?.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
  let name = 'backup'; try { name = decodeURIComponent(String(req.get('x-filename') || 'backup')); } catch { /* padrão */ }
  try {
    const out = await BK.restore(BK.readArchive(buf, name), req.user.id);
    if (!out.ok) return res.status(400).json(out);
    await audit(req, 'backup-restaurar-arquivo', name.slice(0, 60));
    res.flash('Backup restaurado a partir do arquivo.');
    res.json({ ok: true, redirect: BACK });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default r;
