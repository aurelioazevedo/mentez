// Painel de chamadas: página pública da TV (/tv, sem login, conectada por código) e Configurações → Painel de chamadas.
import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import * as Media from '../lib/tvmedia.js';
import * as Sp from '../lib/tvsponsors.js';
import * as WA from '../lib/whatsapp.js';
import { page, bare, html, raw, brDate, brDateTime, money, VERSION, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { proName } from '../lib/perm.js';
import * as TV from '../lib/tv.js';
import * as TTS from '../lib/tts.js';

const COOKIE = 'lm_tv';
const tokenOf = (req) => { const m = /(?:^|;\s*)lm_tv=([A-Za-z0-9_-]{20,64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
const setCookie = (req, res, token) => res.append('Set-Cookie', `${COOKIE}=${token}; Path=/tv; Max-Age=${5 * 365 * 86400}; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);

// ---------- TV (público) ----------
export const publicTv = router();
publicTv.get('/', async (req, res) => {
  let s = await TV.byToken(tokenOf(req));
  if (!s) { const p = await TV.createPending(); setCookie(req, res, p.token); }
  res.set('Cache-Control', 'no-store');
  send(res, html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Painel de chamadas</title>
<link rel="icon" href="/static/img/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/tv.css?v=${VERSION}">
</head>
<body class="tv theme-escuro">
<div id="tv" class="tv-root" aria-live="polite"><p class="tv-loading">Carregando…</p></div>
<script src="/static/tv.js?v=${VERSION}"></script>
</body>
</html>`);
});
publicTv.get('/estado', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let s = await TV.byToken(tokenOf(req));
  if (!s) return res.status(401).json({ state: 'sem' });
  if (s.status === 'pendente') { s = await TV.refreshCode(s); return res.json({ state: 'pendente', code: s.pair_code }); }
  res.json(await TV.feed(s));
});

// Voz neural da chamada (MP3; só para TVs conectadas)
publicTv.get('/voz/:id', async (req, res) => {
  const s = await TV.byToken(tokenOf(req));
  if (!s || s.status !== 'ativa') return res.sendStatus(403);
  const t = await TTS.config();
  if (!TTS.ready(t)) return res.sendStatus(404);
  const text = await TV.callSpeech(int(req.params.id), s);
  if (!text) return res.sendStatus(404);
  try {
    const out = await TTS.synth(t, text);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' }).send(out.buf);
  } catch (e) { console.error('voz da TV:', e.message); res.sendStatus(502); }
});

// Arquivos de mídia (só para TVs conectadas)
publicTv.get('/midia/:id', async (req, res) => {
  const s = await TV.byToken(tokenOf(req));
  if (!s || s.status !== 'ativa') return res.sendStatus(403);
  const m = await Media.readMedia(int(req.params.id));
  if (!m) return res.sendStatus(404);
  Media.sendMedia(req, res, m);
});
// A TV avisa que exibiu uma campanha (números para a clínica e, depois, para patrocinadores)
publicTv.post('/exibicao', express.json({ limit: '1kb' }), async (req, res) => {
  const s = await TV.byToken(tokenOf(req));
  if (!s || s.status !== 'ativa') return res.sendStatus(403);
  const cid = int(req.body?.cid);
  if (cid) await Media.recordPlay(cid).catch(() => {});
  res.json({ ok: true });
});
// Leitura do QR code de uma campanha: conta e redireciona para o link
export async function qrRedirect(req, res) {
  const c = await one('SELECT id, qr_url FROM tv_campaigns WHERE id = ? AND deleted = 0', [int(req.params.id)]);
  if (!c?.qr_url || !/^https?:\/\//i.test(c.qr_url)) return res.status(404).send('Link não encontrado.');
  await Media.recordScan(c.id).catch(() => {});
  res.redirect(302, c.qr_url);
}

// ---------- Configurações ----------
const tvTabs = (on) => html`<nav class="tabs"><a href="/configuracoes/tv" class="${on === 'chamadas' ? 'on' : ''}">Chamadas, salas e telas</a><a href="/configuracoes/tv/midia" class="${on === 'midia' ? 'on' : ''}">Mídia e campanhas</a><a href="/configuracoes/tv/parceiros" class="${on === 'parceiros' ? 'on' : ''}">Parceiros</a></nav>`;
export const settings = router();
const BACK = '/configuracoes/tv';
const yes = (b) => (b ? raw('checked') : '');
const sel = (a, b) => (a === b ? raw('selected') : '');
settings.get('/', async (req, res) => {
  const c = await TV.config();
  const tts = await TTS.config();
  const rooms = await TV.rooms();
  const pros = await q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const screens = await TV.screens();
  const field = (label, inner, cls = '') => html`<label class="fld ${cls}"><span>${label}</span>${inner}</label>`;
  const opts = (map, cur) => Object.entries(map).map(([k, l]) => html`<option value="${k}" ${sel(cur, k)}>${l}</option>`);
  send(res, page(req, {
    title: 'Painel de chamadas', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Painel de chamadas (TV)</h1>
        <p class="muted">Senha na chegada, chamada na TV da recepção com sinal e voz. A TV nunca recebe dado clínico: só a senha (ou iniciais), a ${c.roomWord.toLowerCase()} e o profissional.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/tv" target="_blank" rel="noopener">Abrir a TV</a>
        <form method="post" action="${BACK}/teste"><button class="btn">Chamada de teste</button></form></div></header>
    ${tvTabs('chamadas')}

    <form method="post" class="tv-cfg">
      <section class="card stack"><h2>Geral</h2>
        <label class="fld check"><input type="checkbox" name="enabled" value="1" ${yes(c.enabled)}><span><b>Painel de chamadas ligado</b></span></label>
        <div class="form-grid">
          ${field('O que aparece na TV', html`<select name="display">${opts(TV.DISPLAY, c.display)}</select>`)}
          ${field('Como chamar os ambientes', html`<select name="roomWord">${TV.ROOM_WORDS.map((w) => html`<option value="${w}" ${sel(c.roomWord, w)}>${w} (ex.: ${w} 2)</option>`)}</select>`)}
        </div>
        <label class="fld check"><input type="checkbox" name="showPro" value="1" ${yes(c.showPro)}><span>Mostrar o nome do profissional junto da ${c.roomWord.toLowerCase()}</span></label>
        <p class="muted small">Mostrar nome expõe quem faz terapia a quem está na sala de espera: prefira “só a senha”, ou use nomes apenas com o consentimento do paciente.</p>
      </section>

      <section class="card stack"><h2>Senhas</h2>
        <div class="form-grid">
          ${field('Prefixo da senha', html`<select name="prefixMode">${opts(TV.PREFIX, c.prefixMode)}</select>`)}
        </div>
        <ul class="tv-types">${Object.entries(TV.TYPES).map(([k, l]) => html`<li><b>${k}</b><span>${l}</span></li>`)}</ul>
        <label class="fld check"><input type="checkbox" name="autoTicket" value="1" ${yes(c.autoTicket)}><span>Gerar a senha automaticamente ao marcar “Chegou” na Recepção</span></label>
        <label class="fld check"><input type="checkbox" name="autoPriority" value="1" ${yes(c.autoPriority)}><span>Senha de prioridade (P) automática para pacientes com 60 anos ou mais</span></label>
        <label class="fld check"><input type="checkbox" name="dailyReset" value="1" ${yes(c.dailyReset)}><span>Recomeçar a numeração todo dia</span></label>
      </section>

      <section class="card stack"><h2>Som e voz</h2>
        <label class="fld check"><input type="checkbox" name="voice" value="1" ${yes(c.voice)}><span>Anunciar a chamada por voz</span></label>
        ${field('Frase falada', html`<input name="voiceText" maxlength="160" value="${c.voiceText}">`)}
        <div class="form-grid tv-voice" data-tts>
          ${field('Voz', html`<select name="ttsEngine" data-tts-engine>${Object.entries(TTS.ENGINES).map(([k, l]) => html`<option value="${k}" ${sel(tts.engine, k)}>${l}</option>`)}</select>`)}
          ${field('Locutor(a)', html`<select name="ttsVoice" data-tts-voice>${Object.entries(TTS.VOICES).map(([eng, list]) => html`<optgroup label="Feminina" data-engine="${eng}">${list.filter((v) => v[2] === 'F').map(([id, l]) => html`<option value="${id}" data-engine="${eng}" ${sel(tts.voice, id)}>${l}</option>`)}</optgroup><optgroup label="Masculina" data-engine="${eng}">${list.filter((v) => v[2] === 'M').map(([id, l]) => html`<option value="${id}" data-engine="${eng}" ${sel(tts.voice, id)}>${l}</option>`)}</optgroup>`)}</select>`)}
          ${field('Velocidade', html`<select name="ttsRate">${Object.entries(TTS.RATES).map(([k, l]) => html`<option value="${k}" ${sel(String(tts.rate), k)}>${l}</option>`)}</select>`)}
          ${field(html`Chave da API ${tts.key ? html`<small class="muted">(cadastrada para ${TTS.ENGINES[tts.keyEngine]?.split(' —')[0] || '—'}; preencha só para trocar)</small>` : ''}`, html`<input type="password" name="ttsKey" autocomplete="off" maxlength="400" data-tts-key>`)}
          <div data-tts-azure>${field('Região do Azure', html`<input name="ttsRegion" maxlength="30" value="${tts.region}" placeholder="brazilsouth">`)}</div>
          <div class="fld"><span>Testar</span><div class="actions"><button type="button" class="btn ghost" data-tts-test>▶ Ouvir esta voz</button><span class="small" data-tts-msg aria-live="polite"></span></div></div>
        </div>
        <details class="tv-tips"><summary>Como conseguir a chave da voz neural</summary><ul>
          <li><b>Google Cloud (recomendado):</b> em console.cloud.google.com, crie um projeto, ative a “Cloud Text-to-Speech API” e crie uma <b>chave de API</b> (APIs e serviços → Credenciais). Há cota grátis mensal; as frases da recepção quase não gastam.</li>
          <li><b>Microsoft Azure:</b> crie um recurso “Speech” (região Brazil South) e copie a Chave 1. Também tem cota grátis mensal.</li>
          <li><b>OpenAI:</b> use uma chave de platform.openai.com (paga por uso; centavos por mês).</li>
          <li>Cada frase é gerada uma vez e guardada: chamadas repetidas não são cobradas de novo. Se o serviço falhar, a TV usa a voz do navegador.</li>
        </ul></details>
        <p class="muted small">Campos: {senha} e {sala} (vira “${c.roomWord} 2”, por exemplo).</p>
        <div class="form-grid">
          ${field('Sinal', html`<select name="chime">${opts(TV.CHIMES, c.chime)}</select>`)}
          ${field('Repetir a voz', html`<select name="repeat">${[1, 2, 3].map((n) => html`<option value="${n}" ${sel(c.repeat, n)}>${n} vez(es)</option>`)}</select>`)}
          ${field('Chamada em destaque por (segundos)', html`<input type="number" name="highlightSec" min="5" max="120" value="${c.highlightSec}">`)}
        </div>
      </section>

      <section class="card stack"><h2>Chamar</h2>
        <label class="fld check"><input type="checkbox" name="chooseRoom" value="1" ${yes(c.chooseRoom)}><span>Escolher a ${c.roomWord.toLowerCase()} na hora de chamar (ambientes compartilhados)</span></label>
        <p class="muted small">Desmarcado: usa a ${c.roomWord.toLowerCase()} padrão do profissional (abaixo). Chame pela tela da Recepção, no card de quem está aguardando.</p>
      </section>

      <section class="card stack"><h2>Mensagens na TV</h2>
        ${field('Faixa de avisos no rodapé', html`<input name="ticker" maxlength="400" value="${c.ticker}" placeholder="Ex.: Chegue 5 minutos antes · Wi-Fi: …">`)}
        ${field('Mensagens que alternam ao lado da chamada (uma por linha)', html`<textarea name="messages" rows="5">${c.messages}</textarea>`)}
        <p class="muted small">Textos simples que entram na rotação junto com as campanhas. Para imagens, vídeos, QR code e programação por período, use <a class="link" href="/configuracoes/tv/midia">Mídia e campanhas</a>.</p>
      </section>

      <section class="card stack"><h2>WhatsApp</h2>
        <label class="fld check"><input type="checkbox" name="waTicket" value="1" ${yes(c.waTicket)}><span>Enviar a senha ao paciente na chegada</span></label>
        ${field('Texto', html`<textarea name="waTicketText" rows="2">${c.waTicketText}</textarea>`)}
        <label class="fld check"><input type="checkbox" name="waCall" value="1" ${yes(c.waCall)}><span>Avisar o paciente quando for chamado(a) (útil se ele espera fora da recepção)</span></label>
        ${field('Texto', html`<textarea name="waCallText" rows="2">${c.waCallText}</textarea>`)}
        <p class="muted small">Campos: {nome} {senha} {sala}. Só para pacientes que autorizaram mensagens.</p>
      </section>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>

    <section class="card stack" id="salas"><h2>${c.roomWord === 'Sala' ? 'Salas' : 'Consultórios'}</h2>
      ${rooms.length ? html`<ul class="list tv-rooms">${rooms.map((rm) => html`<li><form method="post" action="${BACK}/salas/${rm.id}" class="tv-room">
        <label class="fld"><span>Número</span><input type="number" name="number" min="1" max="99" value="${rm.number}"></label>
        <label class="fld"><span>Nome na TV <small class="muted">(vazio = “${c.roomWord} ${rm.number}”)</small></span><input name="name" maxlength="60" value="${rm.name || ''}" placeholder="${c.roomWord} ${rm.number}"></label>
        <label class="fld"><span>Profissional padrão</span><select name="owner_id"><option value="">—</option>${pros.map((u) => html`<option value="${u.id}" ${sel(rm.owner_id, u.id)}>${proName(u)}</option>`)}</select></label>
        <div class="tv-room-acts"><button class="chip">Salvar</button><button class="chip" formaction="${BACK}/salas/${rm.id}/remover" data-confirm="Remover ${TV.roomLabel(rm, c)}?">Remover</button></div>
      </form></li>`)}</ul>` : html`<p class="muted">Nenhuma ${c.roomWord.toLowerCase()} cadastrada ainda.</p>`}
      <form method="post" action="${BACK}/salas" class="tv-room tv-room-new">
        <label class="fld"><span>Nome na TV <small class="muted">(opcional)</small></span><input name="name" maxlength="60" placeholder="${c.roomWord} ${(rooms.at(-1)?.number || 0) + 1}"></label>
        <label class="fld"><span>Profissional padrão</span><select name="owner_id"><option value="">—</option>${pros.map((u) => html`<option value="${u.id}">${proName(u)}</option>`)}</select></label>
        <div class="tv-room-acts"><button class="btn ghost">+ Adicionar ${c.roomWord.toLowerCase()}</button></div>
      </form>
    </section>

    <section class="card stack" id="telas"><h2>Telas conectadas</h2>
      ${screens.length ? html`<ul class="list tv-screens">${screens.map((s) => {
        const sr = String(s.rooms || '').split(',').filter(Boolean).map(Number);
        return html`<li><form method="post" action="${BACK}/telas/${s.id}" class="tv-screen">
          <div class="tv-screen-h"><b>${s.name}</b>${TV.isOnline(s) ? html`<span class="badge b-realizada">No ar</span>` : html`<span class="badge b-falta">${s.last_seen ? `Desligada · visto ${brDateTime(s.last_seen)}` : 'Ainda não abriu'}</span>`}</div>
          <div class="form-grid">
            <label class="fld"><span>Nome</span><input name="name" maxlength="60" value="${s.name}"></label>
            <label class="fld"><span>Tema</span><select name="theme">${opts(TV.THEMES, s.theme)}</select></label>
            <label class="fld"><span>Modelo</span><select name="layout">${opts(TV.LAYOUTS, s.layout)}</select></label>
          </div>
          ${rooms.length ? html`<fieldset class="fld wl-chips"><legend>Chamadas de quais ${c.roomWord === 'Sala' ? 'salas' : 'consultórios'} <small class="muted">(nenhuma marcada = todas)</small></legend>
            ${rooms.map((rm) => html`<label class="wl-chip"><input type="checkbox" name="rooms" value="${rm.id}" ${yes(sr.includes(rm.id))}><span>${TV.roomLabel(rm, c)}</span></label>`)}</fieldset>` : ''}
          <div class="tv-room-acts"><button class="chip">Salvar</button><button class="chip" formaction="${BACK}/telas/${s.id}/recarregar">Recarregar a tela</button><button class="chip" formaction="${BACK}/telas/${s.id}/remover" data-confirm="Desconectar ${s.name}? Para usar de novo, será preciso conectar com um código.">Desconectar</button></div>
        </form></li>`;
      })}</ul>` : html`<p class="muted">Nenhuma TV conectada ainda.</p>`}
      <form method="post" action="${BACK}/telas/parear" class="tv-pair">
        <p><b>Conectar uma TV:</b> no navegador da TV (Smart TV, Fire TV Stick, Chromecast ou computador), abra <b>${req.protocol}://${req.get('host')}/tv</b>. Aparece um código de 6 dígitos: digite aqui.</p>
        <div class="tv-pair-row"><label class="fld"><span>Código da TV</span><input name="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000000" required></label>
          <label class="fld"><span>Nome da TV</span><input name="name" maxlength="60" placeholder="Recepção · térreo"></label>
          <button class="btn">Conectar</button></div>
      </form>
      <details class="tv-tips"><summary>Como deixar a TV em tela cheia e sempre ligada no painel</summary>
        <ul>
          <li><b>Qualquer TV:</b> depois de abrir o painel, aperte <b>OK</b> no controle (ou toque no botão da tela). Isso libera o som e coloca em tela cheia. Se sair da tela cheia, o botão volta a aparecer.</li>
          <li><b>Android TV / Google TV / Fire TV:</b> o jeito mais estável é o app <b>Fully Kiosk Browser</b>: coloque o endereço do painel como página inicial e ative “abrir ao ligar” e “manter tela acesa”.</li>
          <li><b>Computador ou mini PC:</b> no Chrome, aperte <b>F11</b>, ou crie um atalho com <code>chrome --kiosk ${req.protocol}://${req.get('host')}/tv</code> e coloque-o para iniciar com o sistema.</li>
          <li><b>TV Roku:</b> não tem navegador. Ligue um Fire TV Stick ou Google TV numa entrada HDMI da própria TV.</li>
          <li>Desligue o “desligamento automático” e a economia de energia da TV. O painel pede para a tela não apagar, mas nem todo aparelho obedece.</li>
          <li>Se a internet cair, a tela continua mostrando a última informação e volta sozinha quando a conexão retornar.</li>
        </ul>
      </details>
    </section>`,
  }));
});
settings.post('/', async (req, res) => {
  const cur = await TTS.config();
  const bad = TTS.checkInput(req.body, cur);
  if (bad) return res.flash(bad, 'err').redirect(BACK);
  await TTS.saveConfig(req.body, cur);
  await TV.saveConfig(req.body);
  await audit(req, 'tv-config');
  res.flash('Painel de chamadas salvo.').redirect(BACK);
});
// Ouvir uma voz antes de salvar (usa a chave digitada ou a já cadastrada)
settings.post('/voz-teste', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {}; const cur = await TTS.config();
  const engine = TTS.ENGINES[b.engine] && b.engine !== 'navegador' ? b.engine : null;
  if (!engine) return res.status(400).json({ error: 'Escolha uma voz neural (Google, Azure ou OpenAI).' });
  const key = String(b.key || '').trim() || (cur.keyEngine === engine ? cur.key : '');
  if (!key) return res.status(400).json({ error: 'Informe a chave da API.' });
  const t = { engine, voice: TTS.VOICES[engine].some((v) => v[0] === b.voice) ? b.voice : TTS.VOICES[engine][0][0], rate: TTS.RATES[b.rate] ? Number(b.rate) : 1, region: String(b.region || cur.region || 'brazilsouth').toLowerCase(), key, keyEngine: engine };
  const c = await TV.config();
  try {
    const out = await TTS.synth(t, WA.render(c.voiceText, { senha: 'A, 12', sala: `${c.roomWord} 2` }));
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).send(out.buf);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
settings.post('/teste', async (req, res) => {
  await TV.testCall(req.user.id);
  res.flash('Chamada de teste enviada às TVs conectadas.').redirect(BACK);
});
settings.post('/salas', async (req, res) => {
  await TV.addRoom({ name: str(req.body.name, 60), ownerId: int(req.body.owner_id) });
  await audit(req, 'tv-sala-incluir');
  res.flash('Adicionado.').redirect(`${BACK}#salas`);
});
settings.post('/salas/:id', async (req, res) => {
  await TV.updateRoom(int(req.params.id), { number: req.body.number, name: str(req.body.name, 60), ownerId: int(req.body.owner_id) });
  res.flash('Salvo.').redirect(`${BACK}#salas`);
});
settings.post('/salas/:id/remover', async (req, res) => {
  await TV.removeRoom(int(req.params.id));
  await audit(req, 'tv-sala-remover', `room:${int(req.params.id)}`);
  res.flash('Removido.').redirect(`${BACK}#salas`);
});
settings.post('/telas/parear', async (req, res) => {
  const id = await TV.pair(req.body.code, str(req.body.name, 60));
  if (!id) return res.flash('Código não encontrado ou vencido. Confira o código na tela da TV (ele muda a cada 30 minutos).', 'err').redirect(`${BACK}#telas`);
  await audit(req, 'tv-conectar', `screen:${id}`);
  res.flash('TV conectada! Em alguns segundos ela mostra o painel.').redirect(`${BACK}#telas`);
});
settings.post('/telas/:id', async (req, res) => {
  await TV.updateScreen(int(req.params.id), { name: str(req.body.name, 60), theme: req.body.theme, layout: req.body.layout, rooms: req.body.rooms });
  res.flash('TV atualizada.').redirect(`${BACK}#telas`);
});
settings.post('/telas/:id/recarregar', async (req, res) => {
  await TV.reloadScreen(int(req.params.id));
  res.flash('A TV vai recarregar em alguns segundos.').redirect(`${BACK}#telas`);
});
settings.post('/telas/:id/remover', async (req, res) => {
  await TV.removeScreen(int(req.params.id));
  await audit(req, 'tv-desconectar', `screen:${int(req.params.id)}`);
  res.flash('TV desconectada.').redirect(`${BACK}#telas`);
});

// ---------- Mídia e campanhas ----------
const MB = (n) => `${(Number(n) / 1048576).toFixed(n > 10485760 ? 0 : 1).replace('.', ',')} MB`;
const thumb = (c) => (c.media_id && c.media_kind === 'imagem' ? html`<img class="tvc-thumb" src="${BACK}/arquivo/${c.media_id}" alt="" loading="lazy">`
  : c.media_id && c.media_kind === 'video' ? html`<span class="tvc-thumb tvc-thumb-v" aria-hidden="true">▶</span>` : html`<span class="tvc-thumb tvc-thumb-t" aria-hidden="true">Aa</span>`);
const when = (c) => {
  const p = [];
  p.push(c.start_date || c.end_date ? `${c.start_date ? brDate(c.start_date).slice(0, 5) : 'já'} a ${c.end_date ? brDate(c.end_date) : 'sem fim'}` : 'contínua');
  const d = String(c.weekdays || '').split(',').filter(Boolean).map(Number);
  if (d.length) p.push(d.map((x) => Media.DAYS[x]).join(', '));
  if (c.time_from || c.time_to) p.push(`${String(c.time_from || '00:00').slice(0, 5)}–${String(c.time_to || '24:00').slice(0, 5)}`);
  return p.join(' · ');
};
settings.get('/midia', async (req, res) => {
  const camps = await Media.list();
  const ads = await Sp.config();
  const screens = await TV.screens();
  const tpl = Media.templates();
  const st0 = (c) => Media.statusOf(c, ads);
  const pending = camps.filter((c) => c.approval === 'pendente' && c.active);
  const groups = [['No ar', camps.filter((c) => st0(c)[1] === 'No ar')], ['Agendadas e fora do horário', camps.filter((c) => st0(c)[0] === 'agendada' && !(c.approval === 'pendente' && c.active))], ['Pausadas, encerradas e recusadas', camps.filter((c) => !['realizada', 'agendada'].includes(st0(c)[0]))]];
  const plays = camps.reduce((s, c) => s + Number(c.plays30), 0); const scans = camps.reduce((s, c) => s + Number(c.scans30), 0);
  send(res, page(req, {
    title: 'Mídia e campanhas', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações · Painel de chamadas</p><h1>Mídia e campanhas</h1>
        <p class="muted">O que passa na TV entre uma chamada e outra. Quando alguém é chamado, a mídia pausa e a chamada aparece por cima.</p></div>
      <div class="ph-actions"><a class="btn" href="${BACK}/midia/nova">+ Nova campanha</a></div></header>
    ${tvTabs('midia')}
    <div class="kpis">
      <div class="kpi"><span>No ar agora</span><b>${groups[0][1].length}</b></div>
      <div class="kpi"><span>Agendadas ou fora do horário</span><b>${groups[1][1].length}</b></div>
      <div class="kpi"><span>Exibições (30 dias)</span><b>${plays.toLocaleString('pt-BR')}</b></div>
      <div class="kpi"><span>Leituras de QR code (30 dias)</span><b>${scans.toLocaleString('pt-BR')}</b></div>
    </div>
    ${!screens.length ? html`<p class="flash warn">Nenhuma TV conectada ainda. <a class="link" href="${BACK}#telas">Conectar uma TV</a></p>` : ''}
    ${pending.length ? html`<section class="card tvc-pending"><h2>Aguardando aprovação <small class="muted">(${pending.length})</small></h2>
      <p class="muted small sub-h">Campanhas de parceiros só vão ao ar depois de aprovadas. Confira texto, imagem e link do QR code (normas do CFP e categorias bloqueadas).</p>
      <ul class="list tvc-list">${pending.map((c) => html`<li><div class="tvc-row">${thumb(c)}
        <div class="tvc-main"><b>${c.title || '(sem título)'}</b> <span class="badge b-agendada">Aguardando aprovação</span><small class="wl-sub">${c.sp_name || ''} · ${Media.FORMATS[c.format]}${c.qr_url ? ` · QR: ${c.qr_url}` : ''}</small>${c.body ? html`<small class="wl-sub muted">${c.body}</small>` : ''}</div>
        <div class="wl-acts"><a class="chip" href="${BACK}/midia/${c.id}">Ver</a>
          <form method="post" action="${BACK}/midia/${c.id}/aprovar"><button class="chip tvc-ok">Aprovar</button></form>
          <form method="post" action="${BACK}/midia/${c.id}/recusar" class="tvc-reject"><input name="reason" maxlength="200" placeholder="Motivo (opcional)" aria-label="Motivo da recusa"><button class="chip">Recusar</button></form></div>
      </div></li>`)}</ul></section>` : ''}
    ${groups.map(([title, list], gi) => html`<section class="card"><h2>${title} <small class="muted">(${list.length})</small></h2>
      ${gi === 0 && list.length > 1 ? html`<p class="muted small sub-h">A TV mostra nesta ordem. Arraste pela alça ⠿ ou use ↑ ↓ para mudar.</p>` : ''}
      ${list.length ? html`<ul class="list tvc-list" data-tvc-sort="${BACK}/midia/ordem">${list.map((c, i) => { const st = st0(c); const ids = list.map((x) => x.id); const mv = (d) => { const o = [...ids]; const j = i + d; [o[i], o[j]] = [o[j], o[i]]; return o.join(','); }; return html`<li data-id="${c.id}"><div class="tvc-row">
        ${list.length > 1 ? html`<span class="tvc-grip" draggable="true" title="Arraste para mudar a ordem" aria-hidden="true">⠿</span>` : ''}
        ${thumb(c)}
        <div class="tvc-main"><b>${c.title || '(sem título)'}</b>${c.show_title === 0 ? html` <small class="muted">(título não aparece na TV)</small>` : ''} <span class="badge b-${st[0]}">${st[1]}</span>
          <small class="wl-sub">${c.sponsor_id ? `Parceiro ${c.sp_name} (${Sp.TIERS[c.sp_tier]?.label || ''})` : Media.KINDS[c.kind] || ''} · ${Media.FORMATS[c.format]}${c.reject_reason ? ` · recusada: ${c.reject_reason}` : ''} · ${c.duration_sec} s${c.weight > 1 ? ` · ${c.weight}× mais` : ''} · ${when(c)}${c.screens ? ` · ${c.screens.split(',').length} TV(s)` : ' · todas as TVs'}</small>
          <small class="wl-sub muted">${Number(c.plays30).toLocaleString('pt-BR')} exibição(ões) em 30 dias${c.qr_url ? ` · ${c.scans30} leitura(s) do QR` : ''}</small></div>
        <div class="wl-acts">${list.length > 1 ? html`<span class="tvc-move">${i > 0 ? html`<form method="post" action="${BACK}/midia/ordem"><input type="hidden" name="ids" value="${mv(-1)}"><button class="chip" title="Subir" aria-label="Subir “${c.title || 'campanha'}”">↑</button></form>` : ''}${i < list.length - 1 ? html`<form method="post" action="${BACK}/midia/ordem"><input type="hidden" name="ids" value="${mv(1)}"><button class="chip" title="Descer" aria-label="Descer “${c.title || 'campanha'}”">↓</button></form>` : ''}</span>` : ''}<a class="chip" href="${BACK}/midia/${c.id}">Editar</a>
          <form method="post" action="${BACK}/midia/${c.id}/${c.active ? 'pausar' : 'ativar'}"><button class="chip">${c.active ? 'Pausar' : 'Ativar'}</button></form>
          <form method="post" action="${BACK}/midia/${c.id}/duplicar"><button class="chip">Duplicar</button></form>
          <form method="post" action="${BACK}/midia/${c.id}/remover" data-confirm="Excluir a campanha “${c.title}”?"><button class="chip">Excluir</button></form></div>
      </div></li>`; })}</ul>` : html`<p class="muted">Nenhuma.</p>`}
    </section>`)}
    <section class="card"><h2>Conteúdo pronto</h2>
      <p class="muted small sub-h">Comece por um modelo e ajuste o texto. As campanhas de saúde mental já vêm com o mês certo.</p>
      <div class="tvc-tpl">${Object.entries(tpl).map(([k, t]) => html`<a class="chip" href="${BACK}/midia/nova?modelo=${k}">${t.label}</a>`)}</div>
    </section>`,
  }));
});

function campaignForm(req, c, screens, action, title, sponsors = []) {
  const days = String(c.weekdays || '').split(',').filter(Boolean).map(Number);
  const scr = String(c.screens || '').split(',').filter(Boolean).map(Number);
  const fmt = c.format || 'texto';
  return html`<form method="post" action="${action}" class="card form-grid tvc-form" data-tvc-form>
    <h2 class="span2">${title}</h2>
    <fieldset class="fld span2 wl-chips"><legend>Formato</legend>${Object.entries(Media.FORMATS).map(([k, l]) => html`<label class="wl-chip"><input type="radio" name="format" value="${k}" ${fmt === k ? raw('checked') : ''} data-tvc-format><span>${l}</span></label>`)}</fieldset>
    <div class="span2 tvc-upload" data-tvc-upload ${fmt === 'texto' ? raw('hidden') : ''}>
      <input type="hidden" name="media_id" value="${c.media_id || ''}">
      <div class="tvc-preview" data-tvc-preview>${c.media_id && c.media_kind === 'imagem' ? html`<img src="${BACK}/arquivo/${c.media_id}" alt="Prévia">` : c.media_id && c.media_kind === 'video' ? html`<video src="${BACK}/arquivo/${c.media_id}" muted playsinline controls></video>` : html`<span class="muted small">Nenhum arquivo ainda</span>`}</div>
      <div class="tvc-upload-side">
        <label class="btn ghost tvc-file">Escolher arquivo<input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" data-tvc-file hidden></label>
        <p class="muted small">Imagem JPG, PNG ou WebP até 5 MB (ideal 1080 × 1080 ou 1920 × 1080). Vídeo MP4 ou WebM até 40 MB, sem som. ${c.media_size ? `Atual: ${MB(c.media_size)}.` : ''}</p>
        <p class="small" data-tvc-msg aria-live="polite"></p>
      </div>
    </div>
    <label class="fld span2"><span>Título ${fmt === 'texto' ? '' : html`<small class="muted">(opcional em imagem/vídeo)</small>`}</span><input name="title" maxlength="90" value="${c.title || ''}"></label>
    <input type="hidden" name="show_title_f" value="1">
    <label class="fld check span2"><input type="checkbox" name="show_title" value="1" ${c.show_title === 0 ? '' : raw('checked')}><span>Mostrar o título na TV <small class="muted">(desmarcado: o título serve só para organizar aqui na lista)</small></span></label>
    <label class="fld span2"><span>Texto</span><textarea name="body" rows="3" maxlength="300">${c.body || ''}</textarea></label>
    <label class="fld"><span>Tipo</span><select name="kind">${Object.entries(Media.KINDS).map(([k, l]) => html`<option value="${k}" ${c.kind === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <label class="fld"><span>Parceiro <small class="muted">(só para o tipo “Parceiro do consultório”)</small></span><select name="sponsor_id"><option value="">—</option>${sponsors.map((sp) => html`<option value="${sp.id}" ${c.sponsor_id === sp.id ? raw('selected') : ''}>${sp.name} · ${Sp.TIERS[sp.tier].label}${sp.status !== 'ativo' ? ` (${sp.status})` : ''}</option>`)}</select></label>
    <label class="fld"><span>Tempo na tela (segundos)</span><input type="number" name="duration_sec" min="5" max="60" value="${c.duration_sec || 12}"></label>
    <label class="fld"><span>Link do QR code <small class="muted">(opcional)</small></span><input name="qr_url" maxlength="500" inputmode="url" value="${c.qr_url || ''}" placeholder="https://wa.me/55…"></label>
    <label class="fld"><span>Frase ao lado do QR code</span><input name="qr_label" maxlength="60" value="${c.qr_label || ''}" placeholder="Aponte a câmera do celular"></label>
    <label class="fld"><span>Começa em <small class="muted">(vazio = já)</small></span><input type="date" name="start_date" value="${c.start_date ? String(c.start_date).slice(0, 10) : ''}"></label>
    <label class="fld"><span>Termina em <small class="muted">(vazio = sem fim)</small></span><input type="date" name="end_date" value="${c.end_date ? String(c.end_date).slice(0, 10) : ''}"></label>
    <fieldset class="fld span2 wl-chips"><legend>Dias <small class="muted">(nenhum marcado = todos)</small></legend>${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<label class="wl-chip"><input type="checkbox" name="weekdays" value="${d}" ${days.includes(d) ? raw('checked') : ''}><span>${Media.DAYS[d]}</span></label>`)}</fieldset>
    <label class="fld"><span>Das <small class="muted">(vazio = o dia todo)</small></span><input type="time" name="time_from" value="${c.time_from ? String(c.time_from).slice(0, 5) : ''}"></label>
    <label class="fld"><span>Até</span><input type="time" name="time_to" value="${c.time_to ? String(c.time_to).slice(0, 5) : ''}"></label>
    <label class="fld"><span>Frequência <small class="muted">(parceiros: pelo plano Ouro/Prata/Bronze)</small></span><select name="weight">${Object.entries(Media.WEIGHTS).map(([k, l]) => html`<option value="${k}" ${Number(c.weight || 1) === Number(k) ? raw('selected') : ''}>${l}</option>`)}</select></label>
    ${screens.length ? html`<fieldset class="fld span2 wl-chips"><legend>Em quais TVs <small class="muted">(nenhuma marcada = todas)</small></legend>${screens.map((s) => html`<label class="wl-chip"><input type="checkbox" name="screens" value="${s.id}" ${scr.includes(s.id) ? raw('checked') : ''}><span>${s.name}</span></label>`)}</fieldset>` : ''}
    <label class="fld check span2"><input type="checkbox" name="active" value="1" ${c.active === 0 ? '' : raw('checked')}><span>Campanha ativa</span></label>
    <p class="muted small span2">Publicidade de serviços de psicologia segue as normas do CFP: sem depoimentos de pacientes, sem promessa de resultado, sem sensacionalismo nem preços em destaque.</p>
    <div class="actions span2"><button class="btn">Salvar campanha</button><a class="btn ghost" href="${BACK}/midia">Cancelar</a></div>
  </form>`;
}
settings.get('/midia/nova', async (req, res) => {
  const t = Media.templates()[req.query.modelo] || {};
  send(res, page(req, { title: 'Nova campanha', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Mídia e campanhas</p><h1>Nova campanha</h1></div></header>
    ${campaignForm(req, { ...t, format: 'texto', active: 1, kind: req.query.parceiro ? 'patrocinador' : t.kind, sponsor_id: Number(req.query.parceiro) || null }, await TV.screens(), `${BACK}/midia`, t.label ? `A partir do modelo “${t.label}”` : 'Conteúdo da campanha', await Sp.list())}` }));
});
settings.get('/midia/:id', async (req, res, next) => {
  const c = await Media.get(int(req.params.id));
  if (!c) return next();
  send(res, page(req, { title: 'Editar campanha', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Mídia e campanhas</p><h1>${c.title || 'Campanha'}</h1>
    <p class="muted">${Number(c.plays30).toLocaleString('pt-BR')} exibição(ões) nos últimos 30 dias${c.qr_url ? ` · ${c.scans30} leitura(s) do QR code` : ''}.</p></div></header>
    ${c.approval === 'pendente' ? html`<p class="flash warn">Esta campanha está aguardando aprovação: ainda não aparece na TV.</p>` : c.approval === 'recusada' ? html`<p class="flash err">Campanha recusada${c.reject_reason ? `: ${c.reject_reason}` : ''}. Ajuste e salve para enviar de novo à aprovação.</p>` : ''}
    ${campaignForm(req, c, await TV.screens(), `${BACK}/midia/${c.id}`, 'Conteúdo da campanha', await Sp.list())}` }));
});
const baseOf = (req) => Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;
settings.post('/midia/ordem', express.json({ limit: '20kb' }), async (req, res) => {
  const ids = String(Array.isArray(req.body.ids) ? req.body.ids.join(',') : req.body.ids || '').split(',');
  const ok = await Media.reorder(ids);
  if (ok) await audit(req, 'tv-campanhas-ordem');
  if (req.is('application/json')) return res.json({ ok });
  res.flash(ok ? 'Ordem das campanhas atualizada.' : 'Não foi possível mudar a ordem.', ok ? 'ok' : 'err').redirect(`${BACK}/midia`);
});
settings.post('/midia', async (req, res) => {
  const out = await Media.save(null, req.body, { userId: req.user.id, base: baseOf(req) });
  if (!out.ok) return res.flash(out.error, 'err').redirect(`${BACK}/midia/nova`);
  await audit(req, 'tv-campanha-criar', `campaign:${out.id}`);
  TV.bump();
  res.flash(out.pending ? 'Campanha salva e enviada para aprovação: ela vai ao ar depois de aprovada.' : 'Campanha salva. Ela entra na TV em alguns segundos, conforme a programação.').redirect(`${BACK}/midia`);
});
settings.post('/midia/:id', async (req, res) => {
  const id = int(req.params.id);
  const out = await Media.save(id, req.body, { userId: req.user.id, base: baseOf(req) });
  if (!out.ok) return res.flash(out.error, 'err').redirect(`${BACK}/midia/${id}`);
  await audit(req, 'tv-campanha-editar', `campaign:${id}`);
  res.flash(out.pending ? 'Campanha atualizada e enviada para aprovação de novo.' : 'Campanha atualizada.').redirect(`${BACK}/midia`);
});
settings.post('/midia/:id/aprovar', async (req, res) => { await Media.approve(int(req.params.id), req.user.id); await audit(req, 'tv-campanha-aprovar', `campaign:${int(req.params.id)}`); res.flash('Campanha aprovada: ela entra na TV conforme a programação.').redirect(`${BACK}/midia`); });
settings.post('/midia/:id/recusar', async (req, res) => { await Media.reject(int(req.params.id), str(req.body.reason, 200), req.user.id); await audit(req, 'tv-campanha-recusar', `campaign:${int(req.params.id)}`); res.flash('Campanha recusada.').redirect(`${BACK}/midia`); });
settings.post('/midia/:id/pausar', async (req, res) => { await Media.setActive(int(req.params.id), false); res.flash('Campanha pausada.').redirect(`${BACK}/midia`); });
settings.post('/midia/:id/ativar', async (req, res) => { await Media.setActive(int(req.params.id), true); res.flash('Campanha ativada.').redirect(`${BACK}/midia`); });
settings.post('/midia/:id/duplicar', async (req, res) => {
  const id = await Media.duplicate(int(req.params.id), req.user.id);
  res.flash('Cópia criada (pausada). Ajuste e ative.').redirect(id ? `${BACK}/midia/${id}` : `${BACK}/midia`);
});
settings.post('/midia/:id/remover', async (req, res) => {
  await Media.remove(int(req.params.id));
  await audit(req, 'tv-campanha-excluir', `campaign:${int(req.params.id)}`);
  res.flash('Campanha excluída.').redirect(`${BACK}/midia`);
});
// Envio do arquivo (direto, sem formulário) e prévia para a equipe
settings.post('/arquivo', express.raw({ type: () => true, limit: '41mb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  let name = 'arquivo'; try { name = decodeURIComponent(String(req.get('x-filename') || 'arquivo')); } catch { /* padrão */ }
  const out = await Media.saveMedia(buf, String(req.get('content-type') || '').split(';')[0], name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_'), req.user.id);
  if (!out.ok) return res.status(400).json(out);
  await audit(req, 'tv-midia-enviar', `media:${out.id}`);
  res.json({ ok: true, id: out.id, kind: out.kind, url: `${BACK}/arquivo/${out.id}` });
});
settings.get('/arquivo/:id', async (req, res, next) => {
  const m = await Media.readMedia(int(req.params.id));
  if (!m) return next();
  Media.sendMedia(req, res, m);
});

// ---------- Parceiros (patrocinadores) ----------
const tierBadge = (t) => html`<span class="badge tv-tier tv-tier-${t}">${Sp.TIERS[t]?.label || t}</span>`;
const spStatus = (sp) => (sp.status !== 'ativo' ? ['cancelada', sp.status === 'pausado' ? 'Pausado' : 'Encerrado'] : Sp.inForce(sp) ? ['realizada', 'Em vigor'] : ['agendada', 'Fora do período']);
settings.get('/parceiros', async (req, res) => {
  const list = await Sp.list(); const ads = await Sp.config();
  const live = list.filter((x) => Sp.inForce(x));
  send(res, page(req, {
    title: 'Parceiros', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações · Painel de chamadas</p><h1>Parceiros</h1>
        <p class="muted">Patrocinadores que anunciam na TV da recepção: plano, mensalidade no Financeiro, aprovação das campanhas e relatório mensal.</p></div>
      <div class="ph-actions"><a class="btn" href="${BACK}/parceiros/novo">+ Novo parceiro</a></div></header>
    ${tvTabs('parceiros')}
    <div class="kpis">
      <div class="kpi"><span>Parceiros em vigor</span><b>${live.length}</b></div>
      <div class="kpi"><span>Receita mensal de patrocínio</span><b>${money(live.reduce((t, x) => t + Number(x.monthly), 0))}</b></div>
      <div class="kpi"><span>Exibições no mês</span><b>${list.reduce((t, x) => t + Number(x.plays_month), 0).toLocaleString('pt-BR')}</b></div>
      <div class="kpi"><span>Leituras de QR no mês</span><b>${list.reduce((t, x) => t + Number(x.scans_month), 0).toLocaleString('pt-BR')}</b></div>
    </div>
    <section class="card"><h2>Parceiros <small class="muted">(${list.length})</small></h2>
      ${list.length ? html`<ul class="list tvc-list">${list.map((x) => { const st = spStatus(x); return html`<li><div class="tvc-row">
        <div class="tvc-main"><b>${x.name}</b> ${tierBadge(x.tier)} <span class="badge b-${st[0]}">${st[1]}</span>${Sp.isBlocked(x.category, ads) ? html` <span class="badge b-falta">Categoria bloqueada</span>` : ''}
          <small class="wl-sub">${money(x.monthly)}/mês · vence dia ${x.due_day} · ${x.start_date ? brDate(x.start_date) : 'já'} a ${x.end_date ? brDate(x.end_date) : 'sem fim'} · ${x.category}</small>
          <small class="wl-sub muted">${x.camps} campanha(s) · ${Number(x.plays_month).toLocaleString('pt-BR')} exibição(ões) e ${x.scans_month} leitura(s) do QR neste mês${x.to_finance ? ' · no Financeiro' : ''}</small></div>
        <div class="wl-acts"><a class="chip" href="${BACK}/parceiros/${x.id}">Abrir e relatório</a><a class="chip" href="${BACK}/midia/nova?parceiro=${x.id}">+ Campanha</a></div>
      </div></li>`; })}</ul>` : html`<p class="muted">Nenhum parceiro ainda.</p>`}
    </section>
    <form method="post" action="${BACK}/parceiros/regras" class="card stack"><h2>Regras para anúncios de parceiros</h2>
      <label class="fld check"><input type="checkbox" name="requireApproval" value="1" ${ads.requireApproval ? raw('checked') : ''}><span>Campanha de parceiro só vai ao ar depois de aprovada (recomendado)</span></label>
      <fieldset class="fld wl-chips"><legend>Categorias bloqueadas (não podem anunciar)</legend>${Sp.CATEGORIES.map((c) => html`<label class="wl-chip"><input type="checkbox" name="blocked" value="${c}" ${ads.blocked.includes(c) ? raw('checked') : ''}><span>${c}</span></label>`)}</fieldset>
      <p class="muted small">Sugestão: manter bloqueados apostas, bebidas alcoólicas, medicamentos (regulados pela Anvisa), política e tabaco. A sala de espera de um consultório de psicologia é um ambiente de cuidado.</p>
      <div class="actions"><button class="btn">Salvar regras</button></div>
    </form>`,
  }));
});
settings.post('/parceiros/regras', async (req, res) => { await Sp.saveConfig(req.body); await audit(req, 'tv-parceiros-regras'); res.flash('Regras salvas.').redirect(`${BACK}/parceiros`); });

function sponsorForm(x, action) {
  return html`<form method="post" action="${action}" class="card form-grid">
    <h2 class="span2">Dados do parceiro</h2>
    <label class="fld span2"><span>Nome do parceiro (como aparece na TV)</span><input name="name" maxlength="120" required value="${x.name || ''}"></label>
    <label class="fld"><span>Contato</span><input name="contact" maxlength="120" value="${x.contact || ''}"></label>
    <label class="fld"><span>WhatsApp do contato</span><input name="phone" maxlength="40" inputmode="tel" value="${x.phone || ''}" placeholder="(62) 99999-9999"></label>
    <label class="fld"><span>E-mail</span><input name="email" type="email" maxlength="160" value="${x.email || ''}"></label>
    <label class="fld"><span>CNPJ ou CPF</span><input name="doc" maxlength="30" value="${x.doc || ''}"></label>
    <label class="fld"><span>Categoria</span><select name="category">${Sp.CATEGORIES.map((c) => html`<option ${x.category === c ? raw('selected') : ''}>${c}</option>`)}</select></label>
    <label class="fld"><span>Plano</span><select name="tier">${Object.entries(Sp.TIERS).map(([k, t]) => html`<option value="${k}" ${(x.tier || 'prata') === k ? raw('selected') : ''}>${t.label} — aparece ${t.weight}× ${t.weight > 1 ? 'mais' : '(normal)'}</option>`)}</select></label>
    <label class="fld"><span>Valor mensal (R$)</span><input name="monthly" inputmode="decimal" value="${x.monthly ? String(Number(x.monthly).toFixed(2)).replace('.', ',') : ''}" placeholder="0,00"></label>
    <label class="fld"><span>Dia do vencimento</span><input name="due_day" type="number" min="1" max="28" value="${x.due_day || 10}"></label>
    <label class="fld"><span>Início do contrato</span><input name="start_date" type="date" value="${x.start_date ? String(x.start_date).slice(0, 10) : ''}"></label>
    <label class="fld"><span>Fim do contrato <small class="muted">(vazio = sem fim)</small></span><input name="end_date" type="date" value="${x.end_date ? String(x.end_date).slice(0, 10) : ''}"></label>
    <label class="fld"><span>Situação</span><select name="status">${[['ativo', 'Ativo'], ['pausado', 'Pausado'], ['encerrado', 'Encerrado']].map(([k, l]) => html`<option value="${k}" ${(x.status || 'ativo') === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <label class="fld check span2"><input type="checkbox" name="to_finance" value="1" ${x.to_finance === 0 ? '' : raw('checked')}><span>Lançar a mensalidade no Financeiro (conta fixa a receber, categoria “Patrocínio”)</span></label>
    <label class="fld span2"><span>Observações</span><input name="notes" maxlength="500" value="${x.notes || ''}"></label>
    <div class="actions span2"><button class="btn">Salvar parceiro</button><a class="btn ghost" href="${BACK}/parceiros">Voltar</a></div>
  </form>`;
}
settings.get('/parceiros/novo', async (req, res) => {
  send(res, page(req, { title: 'Novo parceiro', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Parceiros</p><h1>Novo parceiro</h1></div></header>${sponsorForm({}, `${BACK}/parceiros`)}` }));
});
const reportBody = (x, r, opts = {}) => {
  const max = Math.max(1, ...r.days.map((d) => d.plays));
  return html`<div class="tvr-kpis kpis">
      <div class="kpi"><span>Exibições na TV</span><b>${r.total.plays.toLocaleString('pt-BR')}</b></div>
      <div class="kpi"><span>Tempo na tela</span><b>${Sp.duration(r.total.seconds)}</b></div>
      <div class="kpi"><span>Leituras do QR code</span><b>${r.total.scans.toLocaleString('pt-BR')}</b></div>
      <div class="kpi"><span>Campanhas</span><b>${r.campaigns.length}</b></div>
    </div>
    ${r.days.length ? html`<div class="tvr-chart" role="img" aria-label="Exibições por dia">${r.days.map((d) => html`<span class="tvr-bar" style="height:${Math.max(4, Math.round((d.plays / max) * 100))}%" title="${brDate(d.d)}: ${d.plays} exibição(ões)"><i>${d.d.slice(8, 10)}</i></span>`)}</div>` : html`<p class="muted">Ainda não há exibições neste mês.</p>`}
    ${r.campaigns.length ? html`<div class="tvr-scroll"><table class="tbl tvr-tbl"><thead><tr><th>Campanha</th><th>Exibições</th><th>Tempo na tela</th><th>Leituras do QR</th></tr></thead><tbody>${r.campaigns.map((c) => html`<tr><td>${c.title || '(imagem/vídeo)'}${c.deleted ? ' (encerrada)' : ''}</td><td>${c.plays.toLocaleString('pt-BR')}</td><td>${Sp.duration(c.seconds)}</td><td>${c.scans}</td></tr>`)}</tbody></table></div>` : ''}
    <p class="muted small">Exibição = cada vez que a campanha apareceu numa TV da recepção${opts.screens ? ` (${opts.screens} TV(s) conectada(s))` : ''}. Tempo na tela = exibições × duração da campanha. Leituras do QR = acessos pelo QR code mostrado na TV.</p>`;
};
settings.get('/parceiros/:id', async (req, res, next) => {
  const x = await Sp.get(int(req.params.id));
  if (!x) return next();
  const months = Sp.months(6); const ym = months.includes(req.query.mes) ? req.query.mes : months[0];
  const r = await Sp.report(x.id, ym);
  const link = `${baseOf(req)}/r/${x.report_token}?mes=${ym}`;
  const camps = await q('SELECT id, title, approval, active FROM tv_campaigns WHERE sponsor_id = ? AND deleted = 0 ORDER BY id DESC', [x.id]);
  send(res, page(req, { title: x.name, active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Parceiros</p><h1>${x.name} ${tierBadge(x.tier)}</h1>
      <p class="muted">${money(x.monthly)}/mês · ${x.category}</p></div>
      <div class="ph-actions"><a class="btn" href="${BACK}/midia/nova?parceiro=${x.id}">+ Campanha deste parceiro</a></div></header>
    ${tvTabs('parceiros')}
    <section class="card"><div class="tvr-head"><h2>Relatório de ${Sp.monthLabel(ym)}</h2>
        <form method="get" class="tvr-month"><select name="mes" data-autosubmit aria-label="Mês">${months.map((m) => html`<option value="${m}" ${m === ym ? raw('selected') : ''}>${Sp.monthLabel(m)}</option>`)}</select><noscript><button class="chip">Ver</button></noscript></form></div>
      ${reportBody(x, r, { screens: r.screens })}
      <div class="actions"><a class="btn ghost" href="${link}" target="_blank" rel="noopener">Abrir relatório do parceiro</a>
        <form method="post" action="${BACK}/parceiros/${x.id}/whatsapp"><input type="hidden" name="mes" value="${ym}"><button class="btn ghost" ${x.phone ? '' : raw('disabled title="Cadastre o WhatsApp do contato"')}>Enviar ao parceiro pelo WhatsApp</button></form>
        <form method="post" action="${BACK}/parceiros/${x.id}/novo-link" data-confirm="Gerar um novo link? O link enviado antes deixa de funcionar."><button class="chip">Gerar novo link</button></form></div>
      <p class="muted small">O link mostra só os números das campanhas deste parceiro, sem dados de pacientes.</p>
    </section>
    <section class="card"><h2>Campanhas <small class="muted">(${camps.length})</small></h2>
      ${camps.length ? html`<ul class="list">${camps.map((c) => html`<li><a href="${BACK}/midia/${c.id}">${c.title || '(imagem/vídeo)'} <small class="muted">${c.approval === 'pendente' ? 'aguardando aprovação' : c.approval === 'recusada' ? 'recusada' : c.active ? 'ativa' : 'pausada'}</small></a></li>`)}</ul>` : html`<p class="muted">Nenhuma campanha ainda.</p>`}
    </section>
    ${sponsorForm(x, `${BACK}/parceiros/${x.id}`)}` }));
});
settings.post('/parceiros', async (req, res) => {
  const out = await Sp.save(null, req.body, req.user.id);
  if (!out.ok) return res.flash(out.error, 'err').redirect(`${BACK}/parceiros/novo`);
  await audit(req, 'tv-parceiro-criar', `sponsor:${out.id}`);
  res.flash('Parceiro cadastrado.' + (req.body.to_finance && Number(String(req.body.monthly || '').replace(',', '.')) > 0 ? ' A mensalidade já está no Financeiro (contas a receber).' : '')).redirect(`${BACK}/parceiros/${out.id}`);
});
settings.post('/parceiros/:id', async (req, res) => {
  const id = int(req.params.id);
  const out = await Sp.save(id, req.body, req.user.id);
  if (!out.ok) return res.flash(out.error, 'err').redirect(`${BACK}/parceiros/${id}`);
  await audit(req, 'tv-parceiro-editar', `sponsor:${id}`);
  res.flash('Parceiro atualizado.').redirect(`${BACK}/parceiros/${id}`);
});
settings.post('/parceiros/:id/novo-link', async (req, res) => { await Sp.newToken(int(req.params.id)); res.flash('Novo link gerado.').redirect(`${BACK}/parceiros/${int(req.params.id)}`); });
settings.post('/parceiros/:id/whatsapp', async (req, res, next) => {
  const x = await Sp.get(int(req.params.id));
  if (!x) return next();
  const ym = Sp.months(6).includes(req.body.mes) ? req.body.mes : Sp.months(1)[0];
  const r = await Sp.report(x.id, ym);
  const text = `Olá${x.contact ? `, ${String(x.contact).split(' ')[0]}` : ''}! Segue o relatório da sua divulgação na TV da recepção em ${Sp.monthLabel(ym)}: *${r.total.plays.toLocaleString('pt-BR')} exibições*, ${Sp.duration(r.total.seconds)} na tela e ${r.total.scans} leitura(s) do QR code.\n\nDetalhes: ${baseOf(req)}/r/${x.report_token}?mes=${ym}\n\nObrigada pela parceria!`;
  const out = await WA.send({ phone: x.phone, text, kind: 'manual' });
  await audit(req, 'tv-parceiro-relatorio', `sponsor:${x.id} ${ym}`);
  res.flash(out.ok ? 'Relatório enviado ao parceiro pelo WhatsApp.' : `Não enviado: ${out.error}`, out.ok ? 'ok' : 'err').redirect(`${BACK}/parceiros/${x.id}?mes=${ym}`);
});
// Relatório público do parceiro (link com código, sem login)
export async function publicReport(req, res) {
  const x = await Sp.byToken(req.params.token);
  if (!x) return res.status(404).send(String(bare('Relatório', html`<div class="center-card"><h1>Link inválido</h1><p>Peça um novo link à clínica.</p></div>`)));
  const months = Sp.months(6); const ym = months.includes(req.query.mes) ? req.query.mes : months[0];
  const r = await Sp.report(x.id, ym);
  res.set('Cache-Control', 'no-store');
  res.send(String(bare(`Relatório — ${x.name}`, html`<main class="tvr-public">
    <header class="tvr-pub-h">${logoTag('tvr-logo')}<div><p class="eyebrow">Relatório de divulgação na TV da recepção</p><h1>${x.name}</h1><p class="muted">${Sp.monthLabel(ym)}</p></div></header>
    <form method="get" class="tvr-month no-print"><label>Mês <select name="mes" data-autosubmit>${months.map((m) => html`<option value="${m}" ${m === ym ? raw('selected') : ''}>${Sp.monthLabel(m)}</option>`)}</select></label><noscript><button>Ver</button></noscript> <button type="button" class="btn ghost" data-print>Imprimir / salvar PDF</button></form>
    ${reportBody(x, r)}
    <p class="muted small">Gerado em ${brDateTime(new Date(Date.now() - 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 19))} · ${Brand.get().name}</p>
  </main>`, 'bare tvr-page')));
}
