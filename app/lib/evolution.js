// Mentez: servidor do WhatsApp (Evolution API) da própria plataforma, na rede interna do Docker.
// Cada clínica ganha uma instância “mz-<endereço>” ao ser criada; a clínica guarda só o token da instância dela
// (não a chave geral), então uma clínica não enxerga a instância de outra. A clínica lê o QR code no painel dela.
//
// Variáveis (na VPS, em /opt/mentez/evolution.env, geradas no próprio servidor):
//   AUTHENTICATION_API_KEY  chave geral da Evolution (só o app da Mentez usa, para criar e listar instâncias)
//   MENTEZ_EVOLUTION_URL    endereço interno (padrão http://evolution:8080)
//   MENTEZ_INTERNAL_URL     como a Evolution chama o app (padrão http://app:3000)
// Clínicas que usam uma Evolution própria (ex.: a Dra. Lorrainy) continuam com a configuração delas.
import * as T from './tenancy.js';
import * as W from './whatsapp.js';

const globalKey = () => process.env.MENTEZ_EVOLUTION_KEY || process.env.AUTHENTICATION_API_KEY || '';
export const url = () => String(process.env.MENTEZ_EVOLUTION_URL || 'http://evolution:8080').replace(/\/+$/, '');
export const enabled = () => T.multi() && !!globalKey();
export const instanceName = (slug) => `mz-${slug}`;
const internal = () => String(process.env.MENTEZ_INTERNAL_URL || 'http://app:3000').replace(/\/+$/, '');
// A Evolution chama o app pela rede interna; o endereço leva a clínica no caminho (o Host interno não identifica a clínica)
export const webhookUrl = (slug, secret) => `${internal()}/_mentez/t/${slug}/webhooks/whatsapp/${secret}`;

async function call(method, path, body, key = globalKey()) {
  const res = await fetch(`${url()}${path}`, { method, headers: { apikey: key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20e3) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const m = data?.response?.message; const e = new Error(m ? [].concat(m).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : data?.message || `Evolution respondeu ${res.status}`); e.status = res.status; throw e; }
  return data;
}

// Todas as instâncias (painel da Mentez): nome → { status, number, profileName }
export async function listAll() {
  const list = await call('GET', '/instance/fetchInstances');
  const out = new Map();
  for (const i of Array.isArray(list) ? list : []) {
    const name = i.name ?? i.instance?.instanceName; if (!name) continue;
    out.set(name, { status: i.connectionStatus ?? i.instance?.status ?? 'desconhecido', number: String(i.ownerJid || i.instance?.owner || '').split('@')[0] || null, profileName: i.profileName ?? null, token: i.token ?? i.instance?.token ?? null });
  }
  return out;
}

// Cria (ou reaproveita) a instância da clínica e grava a configuração do WhatsApp dela. Chamar dentro de T.run(t).
// force: troca uma configuração de Evolution própria pela gerenciada (só pelo Painel Mentez).
export async function provision(t, { force = false } = {}) {
  if (!enabled()) return { ok: false, reason: 'A Evolution da Mentez não está configurada neste servidor.' };
  const cur = await W.config();
  if (cur?.url && !cur.managed && !force) return { ok: false, reason: 'A clínica usa uma Evolution própria.' };
  const name = instanceName(t.slug);
  let token = null;
  const found = (await listAll()).get(name);
  if (found) token = found.token;
  else {
    const r = await call('POST', '/instance/create', { instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: true, rejectCall: false, groupsIgnore: true, alwaysOnline: false, readMessages: false, syncFullHistory: false });
    token = typeof r?.hash === 'string' ? r.hash : r?.hash?.apikey || r?.instance?.token || null;
  }
  if (!token) throw new Error('A Evolution não devolveu o token da instância.');
  const fresh = !cur?.managed;
  const c = await W.saveConfig({
    managed: true, url: url(), instance: name, apiKey: token, enabled: true,
    ...(fresh ? { autoReminders: true, hours: 24, windowStart: 8, windowEnd: 20, secondReminder: false, secondHours: 2 } : {}),
  });
  await W.setWebhook(c, webhookUrl(t.slug, c.webhookSecret));
  return { ok: true, instance: name, created: !found };
}

// Para criar sem travar a resposta (cadastro e criação da clínica): erros só vão para o log e o histórico
const recent = new Map(); // não repete a tentativa da mesma clínica por 30 minutos
export function provisionLater(t, actor = 'sistema') {
  if (!enabled() || !t) return;
  if (Date.now() - (recent.get(t.slug) || 0) < 30 * 60e3) return;
  recent.set(t.slug, Date.now());
  setTimeout(() => T.run(t, () => provision(t))
    .then((r) => T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'whatsapp-instancia', t.id, r.ok ? `${r.instance}${r.created ? ' criada' : ' reaproveitada'}` : r.reason]))
    .catch((e) => { console.error('evolution provision', t.slug, e.message); return T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'whatsapp-instancia-erro', t.id, String(e.message).slice(0, 400)]).catch(() => {}); }), 200);
}

// Ao remover uma clínica de vez (não usado na suspensão: os dados e a conexão ficam)
export async function remove(slug) { await call('DELETE', `/instance/delete/${encodeURIComponent(instanceName(slug))}`); }
