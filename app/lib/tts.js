// Voz neural para o painel de chamadas: o servidor gera o MP3 (Google Cloud, Microsoft Azure ou OpenAI)
// e guarda em cache — a mesma frase não é cobrada duas vezes. Sem chave, a TV usa a voz do próprio navegador.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export const ENGINES = {
  navegador: 'Voz do navegador da TV (grátis; a qualidade depende do aparelho)',
  google: 'Google Cloud — vozes neurais (recomendado; cota grátis mensal)',
  azure: 'Microsoft Azure — vozes neurais (cota grátis mensal)',
  openai: 'OpenAI — voz neural (pago por uso, centavos)',
};
// F = feminina, M = masculina
export const VOICES = {
  google: [
    ['pt-BR-Chirp3-HD-Aoede', 'Aoede — muito natural', 'F'], ['pt-BR-Chirp3-HD-Kore', 'Kore — muito natural', 'F'], ['pt-BR-Chirp3-HD-Leda', 'Leda — muito natural', 'F'], ['pt-BR-Chirp3-HD-Zephyr', 'Zephyr — muito natural', 'F'],
    ['pt-BR-Neural2-A', 'Neural2 A', 'F'], ['pt-BR-Neural2-C', 'Neural2 C', 'F'], ['pt-BR-Wavenet-D', 'WaveNet D', 'F'],
    ['pt-BR-Chirp3-HD-Charon', 'Charon — muito natural', 'M'], ['pt-BR-Chirp3-HD-Fenrir', 'Fenrir — muito natural', 'M'], ['pt-BR-Chirp3-HD-Orus', 'Orus — muito natural', 'M'], ['pt-BR-Chirp3-HD-Puck', 'Puck — muito natural', 'M'],
    ['pt-BR-Neural2-B', 'Neural2 B', 'M'], ['pt-BR-Wavenet-E', 'WaveNet E', 'M'],
  ],
  azure: [
    ['pt-BR-FranciscaNeural', 'Francisca', 'F'], ['pt-BR-ThalitaNeural', 'Thalita', 'F'], ['pt-BR-BrendaNeural', 'Brenda', 'F'], ['pt-BR-GiovannaNeural', 'Giovanna', 'F'], ['pt-BR-LeticiaNeural', 'Letícia', 'F'], ['pt-BR-YaraNeural', 'Yara', 'F'],
    ['pt-BR-AntonioNeural', 'Antônio', 'M'], ['pt-BR-DonatoNeural', 'Donato', 'M'], ['pt-BR-FabioNeural', 'Fábio', 'M'], ['pt-BR-JulioNeural', 'Júlio', 'M'], ['pt-BR-NicolauNeural', 'Nicolau', 'M'], ['pt-BR-ValerioNeural', 'Valério', 'M'],
  ],
  openai: [['coral', 'Coral', 'F'], ['nova', 'Nova', 'F'], ['shimmer', 'Shimmer', 'F'], ['sage', 'Sage', 'F'], ['onyx', 'Onyx', 'M'], ['echo', 'Echo', 'M'], ['ash', 'Ash', 'M'], ['verse', 'Verse', 'M']],
};
export const RATES = { 0.9: 'Mais devagar', 1: 'Normal', 1.1: 'Mais rápida' };
const DEFAULT_VOICE = { google: 'pt-BR-Chirp3-HD-Aoede', azure: 'pt-BR-FranciscaNeural', openai: 'coral' };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('tv_tts')) || '{}'); } catch { /* padrão */ }
  const engine = ENGINES[c.engine] ? c.engine : 'navegador';
  let key = ''; try { key = c.key_enc ? decrypt(c.key_enc) : ''; } catch { /* ilegível */ }
  const voice = engine !== 'navegador' && VOICES[engine].some((v) => v[0] === c.voice) ? c.voice : DEFAULT_VOICE[engine] || '';
  return { engine, voice, rate: RATES[c.rate] ? Number(c.rate) : 1, region: c.region || 'brazilsouth', key, keyEngine: c.key_engine || '' };
}
export const ready = (c) => c.engine !== 'navegador' && !!c.key && c.keyEngine === c.engine;
export function checkInput(b, cur) {
  const engine = ENGINES[b.ttsEngine] ? b.ttsEngine : 'navegador';
  if (engine === 'navegador') return null;
  const k = String(b.ttsKey || '').trim();
  if (!k && !(cur.key && cur.keyEngine === engine)) return `Informe a chave da API (${ENGINES[engine].split(' —')[0]}) para usar a voz neural.`;
  if (k && (/\s/.test(k) || k.length < 20)) return 'Chave da API inválida.';
  if (engine === 'azure' && !/^[a-z0-9]{3,30}$/.test(String(b.ttsRegion || 'brazilsouth'))) return 'Região do Azure inválida (ex.: brazilsouth).';
  return null;
}
export async function saveConfig(b, cur) {
  const engine = ENGINES[b.ttsEngine] ? b.ttsEngine : 'navegador';
  const k = String(b.ttsKey || '').trim();
  const key = k || (cur.keyEngine === engine ? cur.key : '');
  await setSetting('tv_tts', JSON.stringify({
    engine, voice: String(b.ttsVoice || '').slice(0, 60), rate: RATES[b.ttsRate] ? Number(b.ttsRate) : 1, region: String(b.ttsRegion || 'brazilsouth').trim().toLowerCase().slice(0, 30),
    key_enc: key && engine !== 'navegador' ? encrypt(key) : (cur.key ? encrypt(cur.key) : null), key_engine: key && engine !== 'navegador' ? engine : cur.keyEngine,
  }));
}

const esc = (s) => String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
async function request(c, text) {
  const t = String(text).slice(0, 300);
  if (c.engine === 'google') {
    const url = `${process.env.TTS_GOOGLE_URL || 'https://texttospeech.googleapis.com'}/v1/text:synthesize?key=${encodeURIComponent(c.key)}`;
    const body = { input: { text: t }, voice: { languageCode: 'pt-BR', name: c.voice }, audioConfig: { audioEncoding: 'MP3', ...(c.rate !== 1 ? { speakingRate: c.rate } : {}) } };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google ${r.status}: ${d?.error?.message || 'erro'}`);
    return Buffer.from(d.audioContent || '', 'base64');
  }
  if (c.engine === 'azure') {
    const url = `${process.env.TTS_AZURE_URL || `https://${c.region}.tts.speech.microsoft.com`}/cognitiveservices/v1`;
    const pct = Math.round((c.rate - 1) * 100);
    const ssml = `<speak version="1.0" xml:lang="pt-BR"><voice name="${esc(c.voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${esc(t)}</prosody></voice></speak>`;
    const r = await fetch(url, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': c.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'painel-chamadas' }, body: ssml, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Azure ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120) || 'erro'}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (c.engine === 'openai') {
    const r = await fetch(`${process.env.TTS_OPENAI_URL || 'https://api.openai.com/v1'}/audio/speech`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: c.voice, input: t, response_format: 'mp3', speed: c.rate, instructions: 'Fale em português do Brasil, com sotaque brasileiro natural, tom calmo, claro e acolhedor de recepção de consultório.' }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(`OpenAI ${r.status}: ${d?.error?.message || 'erro'}`); }
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('Voz neural não configurada.');
}
// MP3 da frase (do cache, se já foi gerado com a mesma voz e velocidade)
export async function synth(c, text, { fresh = false } = {}) {
  if (!ready(c)) throw new Error('Voz neural não configurada.');
  const hash = crypto.createHash('sha256').update(`${c.engine}|${c.voice}|${c.rate}|${text}`).digest('hex');
  if (!fresh) {
    const hit = await one('SELECT data FROM tts_cache WHERE hash = ?', [hash]);
    if (hit) { q('UPDATE tts_cache SET used_at = NOW() WHERE hash = ?', [hash]).catch(() => {}); return { buf: hit.data, cached: true }; }
  }
  const buf = await request(c, text);
  if (!buf.length) throw new Error('O serviço de voz não devolveu áudio.');
  await q('INSERT INTO tts_cache (hash, engine, data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data = VALUES(data), used_at = NOW()', [hash, c.engine, buf]);
  return { buf, cached: false };
}
export const prune = () => q('DELETE FROM tts_cache WHERE used_at < DATE_SUB(NOW(), INTERVAL 60 DAY)');
