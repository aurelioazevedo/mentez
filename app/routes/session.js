// Tela da Sessão (gravação, editor com formatação, rascunho salvo sozinho, hipótese diagnóstica com CID-10/CID-11,
// finalizar com pagamento) e a linha do tempo do prontuário. Usadas pela ficha do paciente (routes/patients.js).
import { one } from '../lib/db.js';
import { html, raw, brDate, brDateTime, label, weekday, money } from '../lib/html.js';
import { todayLocal } from '../lib/time.js';
import { can } from '../lib/perm.js';
import * as CID from '../lib/cid.js';
import * as RT from '../lib/richtext.js';
import * as Rec from '../lib/records.js';
import * as Tele from '../lib/tele.js';
import { panel as sessionAiPanel } from './sessionai.js';

const nm = (p) => p.social_name || p.name;
const hm = (dt) => (dt ? String(dt).slice(11, 16) : '');
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ---------- campos ----------
export function editor(name, value, { placeholder = '' } = {}) {
  return html`<div class="rte" data-rte>
    <div class="rte-bar" role="toolbar" aria-label="Formatação do texto">
      <button type="button" data-cmd="bold" title="Negrito (Ctrl+B)" aria-label="Negrito"><b>N</b></button>
      <button type="button" data-cmd="italic" title="Itálico (Ctrl+I)" aria-label="Itálico"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Sublinhado (Ctrl+U)" aria-label="Sublinhado"><u>S</u></button>
      <span class="rte-sep" aria-hidden="true"></span>
      <select data-size aria-label="Tamanho da fonte" title="Tamanho da fonte"><option value="">Tamanho</option><option value="2">Pequeno</option><option value="3">Normal</option><option value="5">Grande</option><option value="6">Muito grande</option></select>
      <span class="rte-sep" aria-hidden="true"></span>
      <button type="button" data-cmd="insertUnorderedList" title="Lista com marcadores" aria-label="Lista com marcadores">• Lista</button>
      <button type="button" data-cmd="insertOrderedList" title="Lista numerada" aria-label="Lista numerada">1. Lista</button>
      <span class="rte-sep" aria-hidden="true"></span>
      <button type="button" data-cmd="removeFormat" title="Tirar a formatação do trecho selecionado" aria-label="Limpar formatação">Limpar</button>
      <button type="button" data-cmd="undo" title="Desfazer (Ctrl+Z)" aria-label="Desfazer">↶</button>
      <button type="button" data-cmd="redo" title="Refazer" aria-label="Refazer">↷</button>
    </div>
    <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Registro da sessão" data-placeholder="${placeholder}" data-rte-area>${raw(RT.sanitize(value || ''))}</div>
    <input type="hidden" name="${name}" value="">
  </div>`;
}
const chip = (kind, code) => html`<span class="cid-chip" data-code="${code}"><b>${code}</b><span>${CID.nameOf(kind, code)}</span><input type="hidden" name="${kind}" value="${code}"><button type="button" data-cid-del aria-label="Remover ${code}">×</button></span>`;
function cidField(kind, codes) {
  const list = kind === 'cid10' ? CID.CID10 : CID.CID11;
  return html`<div class="fld cid-field" data-cid="${kind}">
    <span>${kind === 'cid10' ? 'CID-10' : 'CID-11'} <small class="muted">(opcional · pode ter mais de um)</small></span>
    <div class="cid-box"><span class="cid-chips" data-cid-chips>${codes.map((c) => chip(kind, c))}</span>
      <input list="${kind}-list" data-cid-input placeholder="${kind === 'cid10' ? 'Ex.: F41.1 ou “ansiedade”' : 'Ex.: 6B00 ou “ansiedade”'}" autocomplete="off" aria-label="Adicionar ${kind === 'cid10' ? 'CID-10' : 'CID-11'}"></div>
    <datalist id="${kind}-list">${list.map(([c, n]) => html`<option value="${c}" label="${c} · ${n}">${n}</option>`)}</datalist>
  </div>`;
}
export function diagnosisFields(d = {}) {
  const has = d.hypothesis || (d.cid10 || []).length || (d.cid11 || []).length;
  return html`<details class="dx-box" ${has ? raw('open') : ''}><summary><b>Hipótese diagnóstica</b> <small class="muted">e CID-10 / CID-11 (opcional)</small></summary>
    <label class="fld"><span>Hipótese diagnóstica</span><textarea name="hypothesis" rows="2" maxlength="2000" placeholder="Hipótese em investigação, critérios observados…">${d.hypothesis || ''}</textarea></label>
    <div class="form-grid">${cidField('cid10', d.cid10 || [])}${cidField('cid11', d.cid11 || [])}</div>
    <p class="muted small">Digite o código ou parte do nome e escolha na lista; códigos fora da lista também são aceitos.</p>
  </details>`;
}
const dxView = (r) => (r.hypothesis || r.cid10.length || r.cid11.length ? html`<div class="ptl-dx"><span class="ptl-lbl">Hipótese diagnóstica</span>
  ${r.hypothesis ? html`<p>${r.hypothesis}</p>` : ''}
  <p class="cid-tags">${r.cid10.map((c) => html`<span class="cid-tag" title="${CID.nameOf('cid10', c)}">CID-10 ${c}</span>`)}${r.cid11.map((c) => html`<span class="cid-tag c11" title="${CID.nameOf('cid11', c)}">CID-11 ${c}</span>`)}</p></div>` : '');

// Formulário do registro (tela da sessão e edição)
export function recordForm({ action, rec = {}, apptId = null, saiRec = '', draftUrl = '', submit = 'Salvar no prontuário', cancelHref = '' }) {
  return html`<form method="post" action="${action}" class="card ses-form" data-rec-form ${draftUrl ? raw(`data-draft-url="${draftUrl}"`) : ''} id="novo-registro">
    <input type="hidden" name="sai_rec" value="${saiRec || ''}"><input type="hidden" name="appt" value="${apptId || ''}">
    <header class="ses-form-h"><h2>Registro da sessão</h2>${draftUrl ? html`<small class="muted ses-saved" data-draft-state aria-live="polite">${rec.updated_at ? `Rascunho recuperado (salvo ${brDateTime(rec.updated_at)})` : 'O rascunho é salvo automaticamente enquanto você escreve'}</small>` : ''}</header>
    <div class="form-grid">
      <label class="fld"><span>Data</span><input type="date" name="record_date" value="${String(rec.record_date || todayLocal()).slice(0, 10)}" required></label>
      <label class="fld"><span>Tipo</span><select name="kind">${Rec.KINDS.map((k) => html`<option value="${k}" ${k === (rec.kind || 'evolucao') ? raw('selected') : ''}>${label(k)}</option>`)}</select></label>
    </div>
    <label class="fld"><span>Demanda trazida <small class="muted">(aparece na linha do tempo do prontuário)</small></span><textarea name="demand" rows="2" maxlength="3000" placeholder="O que o paciente trouxe para a sessão">${rec.demand || ''}</textarea></label>
    <div class="fld"><span>Registro <small class="muted">(criptografado)</small></span>${editor('content_html', rec.html ?? rec.content_html ?? '', { placeholder: 'Procedimentos e técnicas, observações clínicas, evolução, encaminhamentos…' })}</div>
    ${diagnosisFields(rec)}
    <div class="actions"><button class="btn">${submit}</button>${cancelHref ? html`<a class="btn ghost" href="${cancelHref}">Cancelar</a>` : ''}
      ${draftUrl ? html`<button type="button" class="btn ghost danger-text" data-draft-drop>Descartar rascunho</button>` : ''}</div>
  </form>`;
}

// Sessão do dia para esta tela: a indicada (?a=) ou a de hoje em andamento
export async function currentAppt(pid, apptId) {
  if (apptId) {
    const a = await one('SELECT * FROM appointments WHERE id = ? AND patient_id = ?', [apptId, pid]);
    if (a) return a;
  }
  return one(`SELECT * FROM appointments WHERE patient_id = ? AND DATE(starts_at) = CURDATE() AND status IN ('aguardando','em_atendimento','agendada','confirmada','realizada')
    ORDER BY status = 'em_atendimento' DESC, status = 'aguardando' DESC, ABS(TIMESTAMPDIFF(MINUTE, starts_at, NOW())) LIMIT 1`, [pid]);
}

// ---------- página da sessão ----------
export async function sessionPage(req, p, { apptId, auto, fim }) {
  const a = await currentAppt(p.id, apptId);
  const draft = await Rec.draftOf(req.user.id, p.id);
  const dx = await Rec.latestDiagnosis(p.id, req.user.id);
  const live = a && ['aguardando', 'em_atendimento'].includes(a.status);
  const tel = a && a.modality === 'online' ? Tele.staffLink(a) : null;
  const rec = draft ? { ...draft, html: draft.content_html } : { hypothesis: dx?.hypothesis || '', cid10: dx?.cid10 || [], cid11: dx?.cid11 || [] };
  const canFinish = live && can(req.user, 'agenda');
  return html`<header class="ph ses-ph"><div><p class="eyebrow">Sessão${a ? ` · ${weekday(String(a.starts_at).slice(0, 10))}, ${brDate(a.starts_at)} às ${hm(a.starts_at)} · ${a.modality === 'online' ? 'on-line' : 'presencial'}` : ` · ${brDate(todayLocal())}`}</p>
      <h1>${nm(p)}</h1>
      ${a ? html`<p class="ses-st ses-${a.status}"><i aria-hidden="true"></i><span ${a.status === 'em_atendimento' && a.started_at ? raw(`data-since="${a.started_at}" data-tpl="Em atendimento há {m} min"`) : ''}>${a.status === 'em_atendimento' ? 'Em atendimento' : a.status === 'realizada' ? `Finalizado${a.finished_at ? ` às ${hm(a.finished_at)}` : ''}` : label(a.status)}</span></p>` : ''}</div>
    <div class="ph-actions">
      ${tel && live ? html`<a class="btn ghost" href="${tel}" ${/^\//.test(tel) ? '' : raw('target="_blank" rel="noopener"')}>Abrir a chamada</a>` : ''}
      <a class="btn ghost" href="/pacientes/${p.id}?aba=prontuario">Prontuário</a>
      ${canFinish ? html`<button type="button" class="btn" data-ses-finish="${a.id}">■ Finalizar sessão</button>` : ''}
    </div></header>
  <div class="ses-wrap" data-ses="${p.id}" data-ses-appt="${a?.id || ''}" data-ses-fim="${fim && a ? '1' : ''}">
    ${await sessionAiPanel(req, p, { auto, appt: a?.id })}
    ${recordForm({ action: `/pacientes/${p.id}/registros`, rec, apptId: a?.id, saiRec: draft?.sai_rec || '', draftUrl: `/pacientes/${p.id}/rascunho` })}
  </div>
  <dialog class="ask-dlg" data-pay-dlg aria-labelledby="pay-t"><form method="dialog" class="ask-box" data-pay-form>
    <h2 id="pay-t">Sessão finalizada ✓</h2>
    <p data-pay-q>O paciente pagou esta sessão para você?</p>
    <div class="ask-opts two">
      <label class="ask-opt"><input type="radio" name="pago" value="sim"><b>Pago</b><small>Registra o recebimento agora.</small></label>
      <label class="ask-opt"><input type="radio" name="pago" value="nao" checked><b>Não pago</b><small>Fica a receber, como nas regras da recepção.</small></label>
    </div>
    <label class="fld" data-pay-method hidden><span>Forma de pagamento</span><select name="method">${['pix', 'dinheiro', 'cartao', 'transferencia', 'outro'].map((m) => html`<option value="${m}">${label(m)}</option>`)}</select></label>
    <p class="sai-msg small" data-pay-msg role="status"></p>
    <div class="actions"><button type="button" class="btn" data-pay-ok>Confirmar</button></div>
  </form></dialog>`;
}

// ---------- prontuário em linha do tempo ----------
export async function timeline(req, p) {
  const recs = await Rec.forPatient(p.id, req.user.id);
  const draft = await Rec.draftOf(req.user.id, p.id);
  const dx = await Rec.latestDiagnosis(p.id, req.user.id);
  let lastMonth = '';
  const items = recs.map((r) => {
    const ym = String(r.record_date).slice(0, 7);
    const sep = ym !== lastMonth ? html`<li class="ptl-month"><span>${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}</span></li>` : '';
    lastMonth = ym;
    const type = Rec.sessionType(r);
    const more = r.text.trim() !== r.demand.trim() || r.hypothesis || r.cid10.length || r.cid11.length;
    return html`${sep}<li class="ptl-item k-${r.kind}">
      <span class="ptl-dot" aria-hidden="true"></span>
      <article class="ptl-card">
        <header class="ptl-h">
          <time class="ptl-date" datetime="${String(r.record_date).slice(0, 10)}"><b>${brDate(r.record_date).slice(0, 5)}</b><small>${weekday(String(r.record_date).slice(0, 10))}</small></time>
          <div class="ptl-meta"><span class="ptl-type">${type ? html`<i class="ptl-ic t-${type === 'Presencial' ? 'pres' : 'on'}" aria-hidden="true"></i>${type}` : ''}</span><span class="badge b-${r.kind === 'evolucao' ? 'realizada' : 'confirmada'}">${label(r.kind)}</span>${r.appt_at ? html`<small class="muted">sessão das ${hm(r.appt_at)}</small>` : ''}</div>
          <a class="link small ptl-edit" href="/pacientes/${p.id}/registros/${r.id}">editar</a>
        </header>
        <div class="ptl-demand"><span class="ptl-lbl">Demanda trazida</span><p class="pre">${r.demand || '—'}</p></div>
        ${more ? html`<details class="ptl-more"><summary><span class="ptl-open">Ver mais</span><span class="ptl-close">Ver menos</span></summary>
          <div class="rt ptl-body">${raw(r.html)}</div>${dxView(r)}
          <p class="muted small">Registrado por ${r.autor || '—'}${r.crp ? ` (CRP ${r.crp})` : ''} · ${brDateTime(r.created_at)}${String(r.updated_at) !== String(r.created_at) ? ` · alterado ${brDateTime(r.updated_at)}` : ''}</p>
        </details>` : ''}
      </article></li>`;
  });
  return html`<section class="card pr-head">
      <div><h2>Prontuário</h2><p class="muted small">Linha do tempo das suas sessões e registros. Só você vê o que escreveu aqui — nenhum outro profissional, mesmo se o paciente for transferido.</p></div>
      <div class="actions"><a class="btn" href="/pacientes/${p.id}/sessao">${draft ? 'Continuar registro' : '+ Nova sessão / registro'}</a>${recs.length ? html`<a class="btn ghost" href="/pacientes/${p.id}/prontuario" target="_blank">Imprimir</a>` : ''}</div>
    </section>
    ${draft ? html`<div class="flash info">Há um registro em rascunho (salvo ${brDateTime(draft.updated_at)}). <a class="link" href="/pacientes/${p.id}/sessao">Continuar</a></div>` : ''}
    ${dx ? html`<section class="card dx-now"><span class="ptl-lbl">Hipótese diagnóstica atual <small class="muted">(registro de ${brDate(dx.date)})</small></span>${dx.hypothesis ? html`<p>${dx.hypothesis}</p>` : ''}
      <p class="cid-tags">${dx.cid10.map((c) => html`<span class="cid-tag" title="${CID.nameOf('cid10', c)}">CID-10 ${c}${CID.nameOf('cid10', c) ? ` · ${CID.nameOf('cid10', c)}` : ''}</span>`)}${dx.cid11.map((c) => html`<span class="cid-tag c11" title="${CID.nameOf('cid11', c)}">CID-11 ${c}${CID.nameOf('cid11', c) ? ` · ${CID.nameOf('cid11', c)}` : ''}</span>`)}</p></section>` : ''}
    ${recs.length ? html`<ol class="ptl">${items}</ol>` : html`<p class="muted pad">Nenhum registro seu ainda para este paciente.</p>`}`;
}

// Resposta da finalização para a tela da sessão: situação do pagamento e se esta pessoa pode registrá-lo
export async function payInfo(req, apptId) {
  const x = await one("SELECT * FROM payments WHERE appointment_id = ? AND origin IN ('sessao','falta') ORDER BY id DESC LIMIT 1", [apptId]);
  if (!x) return null;
  return { id: x.id, amount: Number(x.amount), amountText: money(x.amount), receiver: x.receiver, paid: !!x.paid_at, method: x.method ? label(x.method) : '' };
}
