// Perfis e permissões do sistema.
// agenda      → ver e editar a agenda
// cadastro    → ver e editar dados cadastrais dos pacientes
// prontuario  → prontuário, exercícios e folhas dos cadernos (dados clínicos)
// financeiro  → lançamentos, recebimentos e recibos
// usuarios    → gestão de usuários e registro de acessos
export const ROLES = {
  admin: {
    label: 'Administrador(a)',
    desc: 'Acesso total, incluindo usuários e registro de acessos.',
    perms: ['agenda', 'cadastro', 'prontuario', 'financeiro', 'usuarios'],
    scope: 'todos',
  },
  psicologo: {
    label: 'Psicólogo(a)',
    desc: 'Agenda, cadastro, prontuário e exercícios apenas dos pacientes sob sua responsabilidade, e o próprio financeiro (recebimentos, despesas e acertos).',
    perms: ['agenda', 'cadastro', 'prontuario', 'meufin'],
    scope: 'proprios',
  },
  secretaria: {
    label: 'Secretária / recepção',
    desc: 'Agenda, cadastro e financeiro de todos os pacientes. Sem acesso ao prontuário nem aos exercícios.',
    perms: ['agenda', 'cadastro', 'financeiro'],
    scope: 'todos',
  },
  financeiro: {
    label: 'Financeiro',
    desc: 'Somente lançamentos, recebimentos e recibos.',
    perms: ['financeiro'],
    scope: 'todos',
  },
};
export const ROLE_KEYS = Object.keys(ROLES);
export const PERM_LABELS = {
  agenda: 'Agenda', cadastro: 'Cadastro de pacientes', prontuario: 'Prontuário e exercícios', financeiro: 'Financeiro da clínica', meufin: 'Financeiro próprio', usuarios: 'Usuários e auditoria',
};

export const can = (user, perm) => !!user && !!ROLES[user.role]?.perms.includes(perm);
export const ownOnly = (user) => ROLES[user?.role]?.scope === 'proprios';
export const isClinician = (role) => role === 'admin' || role === 'psicologo';

export function forbidden() {
  const e = new Error('Acesso não permitido para este perfil.');
  e.status = 403;
  return e;
}

export function requirePerm(...perms) {
  return (req, res, next) => {
    if (perms.some((p) => can(req.user, p))) return next();
    next(forbidden());
  };
}

// Filtro SQL de pacientes visíveis ao usuário (alias da tabela patients).
export function patientScope(user, alias = 'p') {
  if (ownOnly(user)) return { sql: ` AND ${alias}.owner_id = ? `, params: [user.id] };
  return { sql: ' ', params: [] };
}
export function canSeePatient(user, patient) {
  return !!patient && (!ownOnly(user) || patient.owner_id === user.id);
}

// Primeira página permitida para o perfil.
export function homeFor(user) {
  if (can(user, 'agenda') || can(user, 'cadastro')) return '/';
  if (can(user, 'financeiro')) return '/financeiro';
  return '/conta';
}

// Tratamento dos(as) psicólogos(as) para pacientes: “Dra. Lorrainy Mendes”, “Dr. Aurélio …”.
// Usa o escolhido no cadastro; sem escolha (usuários antigos), deduz pelo primeiro nome (terminado em “a”/“y” → Dra.).
export const TITLES = ['Dra.', 'Dr.'];
export function proTitle(u) {
  if (u?.title && TITLES.includes(u.title)) return u.title;
  const first = String(u?.name || '').trim().split(/\s+/)[0].toLowerCase();
  return /[ay]$/.test(first) ? 'Dra.' : 'Dr.';
}
export function proName(u) {
  const name = String(u?.name || '').trim();
  if (!name) return '';
  if (/^dra?\.?\s/i.test(name)) return name; // já tem o título no nome
  return `${proTitle(u)} ${name}`;
}
