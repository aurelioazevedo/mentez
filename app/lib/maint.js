// Manutenção de dados (somente usuário master): limpar módulos, excluir usuários,
// cópia de segurança/restauração e dados de demonstração para apresentações.
// Nunca toca em `settings` (chaves das IAs, WhatsApp, Google, textos) nem nas etapas do CRM e categorias.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, one, db } from './db.js';
import { encrypt } from './crypto.js';
import * as Fin from './fin.js';
import * as Live from './live.js';
import { todayLocal, addDays } from './time.js';

// Tabelas de cada módulo (o que é apagado ao limpar).
export const GROUPS = {
  agenda: { label: 'Agenda', desc: 'Todas as sessões (passadas e futuras) e as vagas da lista de espera. Cadastros de pacientes ficam.', tables: ['appointments', 'waitlist_slots', 'waitlist_offers'] },
  bloqueios: { label: 'Escala e bloqueios', desc: 'Dias bloqueados e horários de atendimento dos profissionais.', tables: ['schedule_blocks', 'schedule_days', 'schedule_meta'] },
  pacientes: { label: 'Pacientes', desc: 'Cadastros, prontuários, exercícios e — junto — as sessões e cobranças de cada paciente.', tables: ['patients', 'records', 'assignments', 'appointments', 'payments', 'fin_packages', 'waitlist', 'waitlist_slots', 'waitlist_offers'] },
  financeiro: { label: 'Financeiro', desc: 'Recebimentos, contas a pagar/receber, contas fixas, pacotes, acertos, anexos e extratos. Regras de repasse, chaves Pix e categorias ficam.', tables: ['payments', 'fin_entries', 'fin_recurring', 'fin_packages', 'fin_settlements', 'fin_files', 'fin_imports', 'fin_bank_tx'] },
  crm: { label: 'CRM e conversas', desc: 'Cards, histórico do WhatsApp, conversas do atendente virtual e fotos dos contatos. As etapas do quadro ficam.', tables: ['crm_cards', 'crm_events', 'wa_messages', 'agent_conversations', 'agent_inbox', 'wa_photos'] },
};

// Garante um usuário master (instalação nova: a primeira administradora ativa). Devolve se `userId` é master.
export async function ensureMaster(userId) {
  if (!(await one('SELECT id FROM users WHERE is_master = 1 AND active = 1 LIMIT 1'))) {
    const m = await one("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND demo = 0 ORDER BY id LIMIT 1");
    if (m) await q('UPDATE users SET is_master = 1 WHERE id = ?', [m.id]);
  }
  return !!(await one('SELECT is_master FROM users WHERE id = ?', [userId]))?.is_master;
}

// ---------- cópia de segurança ----------
const enc = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v; return o; };
const dec = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = v && typeof v === 'object' && v.$b64 !== undefined ? Buffer.from(v.$b64, 'base64') : v; return o; };

export async function backup(tables, label, userId) {
  const data = {}; let rows = 0;
  for (const t of [...new Set(tables)]) { data[t] = (await q(`SELECT * FROM \`${t}\``)).map(enc); rows += data[t].length; }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const r = await q('INSERT INTO maint_backups (label, tables_list, rows_count, size, data, created_by) VALUES (?,?,?,?,?,?)', [label.slice(0, 255), Object.keys(data).join(','), rows, gz.length, gz, userId]);
  // guarda só as 5 mais recentes
  const old = await q('SELECT id FROM maint_backups ORDER BY id DESC LIMIT 100 OFFSET 5');
  if (old.length) await q('DELETE FROM maint_backups WHERE id IN (?)', [old.map((o) => o.id)]);
  return { id: r.insertId, rows };
}

export const backups = () => q('SELECT b.id, b.label, b.tables_list, b.rows_count, b.size, b.created_at, u.name who FROM maint_backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC');

// Restaura: remove os dados de demonstração, esvazia as tabelas da cópia e regrava as linhas originais.
export async function restore(id) {
  const b = await one('SELECT * FROM maint_backups WHERE id = ?', [id]);
  if (!b) return { ok: false, error: 'Cópia não encontrada.' };
  const data = JSON.parse(zlib.gunzipSync(b.data).toString());
  await removeDemo();
  const conn = await db().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const [t, rows] of Object.entries(data)) {
      if (t === 'users') continue; // usuários nunca são sobrescritos pela restauração
      await conn.query(`DELETE FROM \`${t}\``);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(dec);
        if (!chunk.length) continue;
        const cols = Object.keys(chunk[0]);
        await conn.query(`INSERT IGNORE INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ?`, [chunk.map((r) => cols.map((c) => r[c]))]);
      }
    }
  } finally { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); conn.release(); }
  await removeDemo(); // a cópia pode conter dados de exemplo da época: a restauração devolve só os reais
  Live.emit(['agenda', 'pacientes', 'financeiro', 'crm', 'usuarios']);
  return { ok: true, rows: b.rows_count };
}

// ---------- limpar ----------
// groups: chaves de GROUPS; userIds: usuários a excluir; reassignTo: quem herda pacientes/cobranças dos excluídos.
export async function wipe({ groups = [], userIds = [], reassignTo, actor }) {
  const g = new Set(groups);
  const tables = new Set();
  for (const k of g) for (const t of GROUPS[k]?.tables || []) tables.add(t);
  const users = userIds.length ? await q('SELECT id, name FROM users WHERE id IN (?) AND is_master = 0 AND id <> ?', [userIds, actor.id]) : [];
  if (users.length) ['users', 'patients', 'payments', 'fin_entries', 'fin_recurring', 'fin_rules', 'schedule_days', 'schedule_meta', 'schedule_blocks', 'push_subscriptions', 'crm_cards'].forEach((t) => tables.add(t));
  if (!tables.size) return { ok: false, error: 'Escolha o que limpar.' };
  const label = [...[...g].map((k) => GROUPS[k].label), ...(users.length ? [`usuários: ${users.map((u) => u.name).join(', ')}`] : [])].join(' · ');
  const bk = await backup([...tables], `Antes de limpar: ${label}`, actor.id);

  if (g.has('pacientes')) {
    await q('DELETE FROM fin_packages');
    await q('DELETE FROM patients'); // sessões, prontuários, exercícios e cobranças vão junto (chave estrangeira)
    await q('DELETE FROM payments');
    await q('UPDATE crm_cards SET patient_id = NULL');
    await q('UPDATE agent_conversations SET patient_id = NULL');
    await q('UPDATE wa_messages SET patient_id = NULL, appointment_id = NULL');
    for (const t of ['waitlist_offers', 'waitlist_slots', 'waitlist', 'tv_calls']) await q(`DELETE FROM ${t}`);
  }
  if (g.has('agenda')) {
    await q('DELETE FROM appointments');
    for (const t of ['waitlist_offers', 'waitlist_slots', 'tv_calls']) await q(`DELETE FROM ${t}`);
    await q('UPDATE payments SET appointment_id = NULL');
    await q('UPDATE wa_messages SET appointment_id = NULL');
  }
  if (g.has('bloqueios')) { await q('DELETE FROM schedule_blocks'); await q('DELETE FROM schedule_days'); await q('DELETE FROM schedule_meta'); }
  if (g.has('financeiro')) {
    for (const t of ['fin_bank_tx', 'fin_imports', 'fin_files', 'fin_settlements', 'fin_entries', 'fin_recurring', 'fin_packages', 'payments']) await q(`DELETE FROM ${t}`);
    await q('UPDATE appointments SET package_id = NULL');
  }
  if (g.has('crm')) for (const t of ['crm_events', 'crm_cards', 'agent_inbox', 'agent_conversations', 'wa_messages', 'wa_photos']) await q(`DELETE FROM ${t}`);

  if (users.length) {
    const ids = users.map((u) => u.id);
    const heir = reassignTo && !ids.includes(reassignTo) ? reassignTo : actor.id;
    await q('UPDATE patients SET owner_id = ? WHERE owner_id IN (?)', [heir, ids]);
    await q('UPDATE payments SET professional_id = ? WHERE professional_id IN (?)', [heir, ids]);
    await q('UPDATE crm_cards SET responsible_id = NULL WHERE responsible_id IN (?)', [ids]);
    for (const t of ['fin_entries', 'fin_recurring']) await q(`DELETE FROM ${t} WHERE owner_id IN (?)`, [ids]);
    for (const t of ['fin_rules', 'schedule_days', 'schedule_meta', 'schedule_blocks', 'push_subscriptions']) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids]);
    await q('DELETE FROM users WHERE id IN (?)', [ids]);
  }
  Live.emit(['agenda', 'pacientes', 'financeiro', 'crm', 'usuarios']);
  return { ok: true, backupId: bk.id, label, users: users.length };
}

// ---------- dados de demonstração ----------
// Telefones fictícios (62) 9 0000-xxxx / 9 0001-xxxx: os pacientes ficam sem autorização de WhatsApp
// e o envio de mensagens/Google é bloqueado para eles (ver isDemoPatient).
const DEMO_PATIENT = (i) => `5562900${String(i).padStart(6, '0')}`.replace(/^55/, '');
const DEMO_LEAD = (i) => `62900${String(10000 + i)}`;
const fmt = (d) => `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;

const PATIENTS = [
  ['Mariana Alves Rocha', 'F', 'online'], ['Lucas Fernandes Lima', 'M', 'presencial'], ['Beatriz Cardoso', 'F', 'online'], ['Gabriel Moura Santos', 'M', 'online'],
  ['Juliana Pires', 'F', 'presencial'], ['Rafael Nogueira', 'M', 'online'], ['Camila Teixeira Duarte', 'F', 'online'], ['Pedro Henrique Araújo', 'M', 'presencial'],
  ['Larissa Monteiro', 'F', 'online'], ['Thiago Ribeiro Costa', 'M', 'online'], ['Ana Clara Barbosa', 'F', 'presencial'], ['Felipe Andrade', 'M', 'online'],
  ['Isabela Martins', 'F', 'online'], ['Bruno Carvalho Melo', 'M', 'presencial'], ['Letícia Gomes', 'F', 'online'], ['Vinícius Batista', 'M', 'online'],
  ['Fernanda Lopes Vieira', 'F', 'presencial'], ['Matheus Correia', 'M', 'online'], ['Amanda Freitas', 'F', 'online'], ['Gustavo Rezende', 'M', 'presencial'],
  ['Natália Campos', 'F', 'online'], ['Rodrigo Siqueira', 'M', 'online'], ['Carolina Dias Prado', 'F', 'presencial'], ['Eduardo Fonseca', 'M', 'online'],
];
const LEADS = [
  ['Patrícia Mendonça', 'novo', 'Olá! Vi o site e queria saber os valores da terapia on-line.', 'Instagram'],
  ['Renato Oliveira', 'atendimento', 'Vocês atendem adolescentes? Meu filho tem 15 anos.', 'Indicação'],
  ['Simone Azevedo', 'humano', 'Preciso de declaração de comparecimento para o trabalho.', ''],
  ['Daniela Rocha', 'ebook', 'Quero o e-book sobre ansiedade 😊', 'E-book ansiedade'],
  ['Marcelo Tavares', 'agendado', 'Perfeito, quinta às 19h fica ótimo!', 'Google'],
  ['Aline Moreira', 'agendado', 'Obrigada, confirmado para segunda.', 'Site'],
  ['Henrique Paiva', 'novo', 'Boa tarde, a Dra. atende casais?', 'Site'],
  ['Cristina Sales', 'perdido', 'Vou ver com meu plano e retorno.', 'Instagram'],
  ['Otávio Brandão', 'atendimento', 'Qual a diferença entre presencial e on-line?', 'Indicação'],
  ['Viviane Cunha', 'paciente', 'Até semana que vem, obrigada!', 'Indicação'],
];
const NOTES = ['Sessão com foco em manejo de ansiedade; praticada respiração diafragmática.', 'Revisão das metas terapêuticas e registro de pensamentos da semana.', 'Paciente relata melhora do sono após ajustes de rotina.', 'Trabalhadas estratégias de comunicação assertiva no trabalho.', 'Psicoeducação sobre ciclo da ansiedade; tarefa: diário de emoções.'];

const rnd = (() => { let s = 20261115; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n) => String(n).padStart(2, '0');

export async function isDemoPatient(patientId) {
  if (!patientId) return false;
  const p = await one('SELECT demo FROM patients WHERE id = ?', [patientId]);
  return !!p?.demo;
}

export async function demoStats() {
  const c = await one('SELECT (SELECT COUNT(*) FROM patients WHERE demo = 1) pacientes, (SELECT COUNT(*) FROM crm_cards WHERE demo = 1) crm, (SELECT COUNT(*) FROM users WHERE demo = 1) usuarios, (SELECT COUNT(*) FROM fin_entries WHERE demo = 1) contas');
  return { ...c, any: Object.values(c).some((v) => Number(v) > 0) };
}

export async function loadDemo({ withProfessionals = true, actor }) {
  await removeDemo();
  const today = todayLocal();
  // profissionais
  const pros = [];
  const master = await one('SELECT id, name FROM users WHERE id = ?', [actor.id]);
  const lead = await one("SELECT id FROM users WHERE role IN ('admin','psicologo') AND active = 1 AND demo = 0 ORDER BY role = 'admin' DESC, id LIMIT 1");
  pros.push((lead || master).id);
  if (withProfessionals) {
    const hash = await bcrypt.hash(crypto.randomBytes(18).toString('base64url'), 10);
    for (const [name, title, crp, mode, value] of [['Rafael Moreira', 'Dr.', '09/14523', 'percent', 30], ['Helena Duarte', 'Dra.', '09/18877', 'fixed', 50]]) {
      const email = `demo.${name.split(' ')[0].toLowerCase()}.${crypto.randomBytes(3).toString('hex')}@exemplo.com.br`;
      const r = await q("INSERT INTO users (name, email, password_hash, role, crp, title, active, demo, must_change_password) VALUES (?,?,?,'psicologo',?,?,1,1,1)", [name, email, hash, crp, title]);
      await Fin.saveRule(r.insertId, { mode, value, rent: 0, receipt_by: 'clinica', doc: '', pix_type: null, pix_key: '' });
      for (let wd = 1; wd <= 5; wd++) await q("INSERT IGNORE INTO schedule_days (user_id, weekday, start_time, end_time) VALUES (?,?,'08:00','19:00')", [r.insertId, wd]);
      pros.push(r.insertId);
    }
  }
  // pacientes
  const used = new Set();
  const patients = [];
  for (let i = 0; i < PATIENTS.length; i++) {
    const [name, , modality] = PATIENTS[i];
    const owner = pros[i % pros.length];
    const fee = pick([150, 180, 200, 220, 250]);
    const status = i < 20 ? 'ativo' : i < 22 ? 'pausa' : 'alta';
    const created = addDays(today, -Math.floor(10 + rnd() * 170));
    const phone = fmt(DEMO_PATIENT(i + 1));
    const birth = `${1975 + Math.floor(rnd() * 30)}-${pad(1 + Math.floor(rnd() * 12))}-${pad(1 + Math.floor(rnd() * 27))}`;
    const r = await q(`INSERT INTO patients (owner_id, name, birth_date, phone, email, modality, session_fee, status, consent_at, whatsapp_optin, pay_to, demo, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,1,?)`, [owner, name, birth, phone, `${name.split(' ')[0].toLowerCase()}.exemplo@exemplo.com.br`, modality, fee, status, `${created} 10:00:00`, i % 5 === 3 ? 'profissional' : 'clinica', `${created} 09:30:00`]);
    // horário semanal fixo sem choque na agenda do(a) profissional
    let wd; let hr;
    do { wd = 1 + Math.floor(rnd() * 5); hr = 8 + Math.floor(rnd() * 11); } while (used.has(`${owner}-${wd}-${hr}`));
    used.add(`${owner}-${wd}-${hr}`);
    patients.push({ id: r.insertId, owner, fee, status, created, wd, hr, modality, payTo: i % 5 === 3 ? 'profissional' : 'clinica' });
  }
  // pacote para dois pacientes
  // sessões (10 semanas atrás até 4 semanas à frente) + cobranças
  const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  let appts = 0; let pays = 0;
  for (const p of patients) {
    const first = p.created > addDays(today, -70) ? p.created : addDays(today, -70);
    const last = p.status === 'ativo' ? addDays(today, 28) : addDays(today, -14);
    let d = first; while (dow(d) !== p.wd) d = addDays(d, 1);
    let n = 0;
    for (; d <= last; d = addDays(d, 7)) {
      const past = d < today || (d === today && p.hr < Number(new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 13)));
      const roll = rnd();
      const st = past ? (roll < 0.86 ? 'realizada' : roll < 0.94 ? 'falta' : 'cancelada') : (d <= addDays(today, 2) && roll < 0.6 ? 'confirmada' : 'agendada');
      const r = await q('INSERT INTO appointments (patient_id, starts_at, duration_min, modality, status, created_by, created_via) VALUES (?,?,50,?,?,?,?)',
        [p.id, `${d} ${pad(p.hr)}:00:00`, p.modality === 'presencial' ? 'presencial' : 'online', st, p.owner, rnd() < 0.25 ? 'agente' : 'sistema']);
      appts++; n++;
      if (st === 'realizada' || (st === 'falta' && rnd() < 0.5)) {
        const age = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
        const paid = age > 12 ? rnd() < 0.985 : age > 4 ? rnd() < 0.8 : rnd() < 0.5;
        const amount = st === 'falta' ? Math.round(p.fee * 0.5) : p.fee;
        const pr = await q(`INSERT INTO payments (patient_id, appointment_id, description, amount, due_date, paid_at, method, professional_id, receiver, origin, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [p.id, r.insertId, st === 'falta' ? 'Falta sem aviso (50%)' : 'Sessão de psicoterapia', amount, d, paid ? addDays(d, Math.floor(rnd() * 3)) : null, paid ? pick(['pix', 'pix', 'pix', 'cartao', 'transferencia']) : null, p.owner, p.payTo, st === 'falta' ? 'falta' : 'sessao', `${d} 20:00:00`]);
        if (paid) await Fin.stampShare(pr.insertId);
        pays++;
      }
      if (st === 'realizada' && n % 3 === 1) await q("INSERT INTO records (patient_id, appointment_id, author_id, kind, record_date, content_enc) VALUES (?,?,?,'evolucao',?,?)", [p.id, r.insertId, p.owner, d, encrypt(pick(NOTES))]);
    }
  }
  // lista de espera: pacientes em pausa querendo voltar, um paciente querendo antecipar e dois contatos novos
  const lead0 = pros[0];
  const wlRows = [
    [patients[20], '', 'tarde,noite', 'qualquer', 1, 'Quer voltar às sessões semanais'],
    [patients[21], '2,4', '', 'online', 0, null],
    [patients[9], '', 'manha', 'qualquer', 0, 'Prefere antes do trabalho'],
    [{ name: 'Juliana Prado Ribeiro', phone: fmt(DEMO_PATIENT(91)) }, '', '', 'qualquer', 0, 'Primeira consulta — indicação de paciente'],
    [{ name: 'Marcos Vinícius Teles', phone: fmt(DEMO_PATIENT(92)) }, '1,3,5', 'noite', 'online', 0, 'Primeira consulta'],
  ];
  let wi = 0;
  for (const [pp, days, pers, mod, prio, note] of wlRows) {
    if (!pp) continue;
    await q(`INSERT INTO waitlist (patient_id, name, phone, owner_id, weekdays, periods, modality, notes, priority, created_via, demo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [pp.id || null, pp.id ? null : pp.name, pp.id ? null : pp.phone, pp.owner || lead0, days, pers, mod, note, prio, wi % 2 ? 'agente' : 'equipe', `${addDays(today, -(12 - wi * 2))} 10:${pad(wi * 7)}:00`]);
    wi++;
  }
  // histórico: uma vaga preenchida pela lista e uma que ninguém pegou
  const hs = await q("INSERT INTO waitlist_slots (owner_id, starts_at, duration_min, status, reason, created_at, closed_at, demo) VALUES (?,?,50,'preenchida',NULL,?,?,1)", [lead0, `${addDays(today, -5)} 15:00:00`, `${addDays(today, -7)} 09:10:00`, `${addDays(today, -7)} 09:24:00`]);
  await q("INSERT INTO waitlist_slots (owner_id, starts_at, duration_min, status, reason, created_at, closed_at, demo) VALUES (?,?,50,'encerrada','ninguém aceitou após 3 oferta(s)',?,?,1)", [lead0, `${addDays(today, -3)} 08:00:00`, `${addDays(today, -4)} 16:00:00`, `${addDays(today, -4)} 18:30:00`]);
  const filler = patients[3];
  if (filler) {
    const fa = await one("SELECT id FROM appointments WHERE patient_id = ? AND starts_at < NOW() ORDER BY starts_at DESC LIMIT 1", [filler.id]);
    if (fa) await q('UPDATE waitlist_slots SET appointment_id = ? WHERE id = ?', [fa.id, hs.insertId]);
  }
  for (const p of patients.slice(4, 6)) await Fin.createPackage({ patientId: p.id, sessions: 4, amount: p.fee * 4 * 0.9, dueDate: addDays(today, -3), userId: actor.id }).catch(() => {});
  // contas da clínica (3 meses + mês atual)
  const cat = async (n) => (await one('SELECT id FROM fin_categories WHERE name = ?', [n]))?.id || null;
  const bills = [['Aluguel do consultório', 'Aluguel', 2800, 5, 'Imobiliária Centro-Oeste'], ['Condomínio', 'Condomínio', 420, 8, 'Edifício Office Tower'], ['Energia', 'Energia', 260, 12, 'Equatorial Goiás'], ['Internet', 'Internet e telefone', 139.9, 15, 'Provedor Fibra'], ['Contabilidade', 'Contador', 450, 10, 'Escritório Contábil'], ['Sistema e assinaturas', 'Sistemas e assinaturas', 89.9, 20, ''], ['Marketing digital', 'Marketing', 600, 25, 'Agência Criativa']];
  for (let m = 3; m >= 0; m--) {
    const base = addDays(`${today.slice(0, 7)}-01`, -m * 30).slice(0, 7);
    for (const [desc, c, amt, day, who] of bills) {
      const due = `${base}-${pad(Math.min(day, 28))}`;
      const paid = due < today ? (m > 0 || rnd() < 0.8) : false;
      await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, paid_at, method, demo, created_by) VALUES (NULL,\'pagar\',?,?,?,?,?,?,?,1,?)',
        [await cat(c), desc, who || null, Math.round(amt * (0.92 + rnd() * 0.16) * 100) / 100, due, paid ? due : null, paid ? pick(['boleto', 'pix', 'boleto']) : null, actor.id]);
    }
  }
  await q("INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, paid_at, method, demo, created_by) VALUES (NULL,'receber',?,?,?,?,?,?,?,1,?)",
    [await cat('Aluguel de sala'), 'Sublocação de sala (sábados)', 'Coletivo Bem-Estar', 650, addDays(today, -6), addDays(today, -5), 'pix', actor.id]);
  // CRM com conversas
  const stages = Object.fromEntries((await q('SELECT id, auto_key FROM crm_stages')).map((s) => [s.auto_key, s.id]));
  const firstStage = (await one('SELECT id FROM crm_stages ORDER BY position LIMIT 1'))?.id;
  let cards = 0;
  for (let i = 0; i < LEADS.length; i++) {
    const [name, key, last, tag] = LEADS[i];
    const digits = DEMO_LEAD(i + 1); const phone = `55${digits}`; const pkey = digits.slice(0, 2) + digits.slice(-8);
    const when = `${addDays(today, -Math.floor(rnd() * 6))} ${pad(9 + Math.floor(rnd() * 10))}:${pad(Math.floor(rnd() * 60))}:00`;
    const r = await q('INSERT INTO crm_cards (phone_key, phone, name, stage_id, position, responsible_id, tags, value, source, last_message_at, last_direction, demo) VALUES (?,?,?,?,?,?,?,?,\'whatsapp\',?,?,1)',
      [pkey, phone, name, stages[key] || firstStage, i, i % 3 === 0 ? actor.id : null, tag || null, key === 'perdido' ? null : pick([720, 800, 880, 1000]), when, key === 'humano' || key === 'novo' ? 'in' : 'out']);
    cards++;
    const convo = [['in', `Olá, boa tarde! ${i % 2 ? 'Encontrei vocês pelo Instagram.' : 'Recebi a indicação de uma amiga.'}`], ['out', 'Olá! Que bom ter você por aqui 😊 Sou a assistente virtual do consultório da Dra. Lorrainy Mendes. Como posso ajudar?'], ['in', last]];
    if (key === 'agendado') convo.push(['out', 'Sessão agendada! Você receberá um lembrete um dia antes. Até lá! 🌿']);
    let t = Date.parse(`${when.replace(' ', 'T')}Z`) - convo.length * 120e3;
    for (const [dir, text] of convo) {
      t += 120e3;
      await q("INSERT INTO wa_messages (kind, direction, phone, body_enc, status, created_at) VALUES (?,?,?,?,?,?)", [dir === 'in' ? 'recebida' : 'agente', dir, phone, encrypt(text), dir === 'in' ? 'recebido' : 'enviado', new Date(t).toISOString().slice(0, 19).replace('T', ' ')]);
    }
    if (key === 'humano') await q("INSERT INTO crm_events (card_id, user_id, type, text_enc) VALUES (?, NULL, 'nota', ?)", [r.insertId, encrypt('Encaminhado para a recepção: pedido de declaração.')]).catch(() => {});
  }
  Live.emit(['agenda', 'pacientes', 'financeiro', 'crm', 'usuarios']);
  return { ok: true, patients: patients.length, appts, pays, cards, pros: pros.length - 1 };
}

export async function removeDemo() {
  const pats = (await q('SELECT id FROM patients WHERE demo = 1')).map((p) => p.id);
  // Lista de espera de demonstração (pessoas, vagas e ofertas)
  const wl = (await q(`SELECT id FROM waitlist WHERE demo = 1${pats.length ? ' OR patient_id IN (?)' : ''}`, pats.length ? [pats] : [])).map((w) => w.id);
  const sl = (await q('SELECT id FROM waitlist_slots WHERE demo = 1')).map((x) => x.id);
  if (wl.length) await q('DELETE FROM waitlist_offers WHERE waitlist_id IN (?)', [wl]);
  if (sl.length) await q('DELETE FROM waitlist_offers WHERE slot_id IN (?)', [sl]);
  if (wl.length) await q('DELETE FROM waitlist WHERE id IN (?)', [wl]);
  if (sl.length) await q('DELETE FROM waitlist_slots WHERE id IN (?)', [sl]);
  if (pats.length) {
    await q('DELETE FROM fin_packages WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM wa_messages WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM notify_log WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM surveys WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM scale_apps WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM scale_plans WHERE patient_id IN (?)', [pats]);
    await q('DELETE FROM patients WHERE id IN (?)', [pats]);
  }
  const cards = (await q('SELECT id, phone FROM crm_cards WHERE demo = 1'));
  if (cards.length) {
    await q('DELETE FROM crm_events WHERE card_id IN (?)', [cards.map((c) => c.id)]);
    await q('DELETE FROM wa_messages WHERE phone IN (?)', [cards.map((c) => c.phone)]);
    await q('DELETE FROM wa_photos WHERE phone_key IN (?)', [cards.map((c) => `62${c.phone.slice(-8)}`)]);
    await q('DELETE FROM crm_cards WHERE id IN (?)', [cards.map((c) => c.id)]);
  }
  await q('DELETE FROM fin_entries WHERE demo = 1');
  await q('DELETE FROM fin_recurring WHERE demo = 1');
  const us = (await q('SELECT id FROM users WHERE demo = 1')).map((u) => u.id);
  if (us.length) {
    for (const t of ['fin_rules', 'schedule_days', 'schedule_meta', 'schedule_blocks', 'push_subscriptions']) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [us]);
    await q('UPDATE crm_cards SET responsible_id = NULL WHERE responsible_id IN (?)', [us]);
    await q('DELETE FROM users WHERE id IN (?)', [us]);
  }
  Live.emit(['agenda', 'pacientes', 'financeiro', 'crm', 'usuarios']);
}
