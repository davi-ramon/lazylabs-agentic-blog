/**
 * Lazy Labs CRM — backend no ecossistema Firebase (Firestore + Functions).
 * Porte do blueprint crm-apps-script-builder: motor preservado (roteador único, engine de CRUD,
 * auth por sessão, white-label) — só troca a casca de dados (Sheets→Firestore) e o transporte.
 *
 * Endpoint: POST /api/crm  com body { action, data, sessionToken } → { success, data|error }
 * Coleções: crm_users · crm_sessions · crm_leads · crm_pipelines · crm_deals · crm_audit
 *           config/crm (white-label, doc único)
 *
 * Acesso ao Firestore é SOMENTE server-side (admin SDK) — o cliente nunca toca o banco.
 */
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

let _cdb;
function cdb() { if (!_cdb) _cdb = getFirestore(); return _cdb; }
function col(name) { return cdb().collection(name); }

/* ───────────── helpers ───────────── */
function nowIso() { return new Date().toISOString(); }
function genId(prefix) { return (prefix || 'ID') + '-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function genToken(n) { return crypto.randomBytes(n || 32).toString('hex'); }
function hashPassword(password, salt) { return crypto.scryptSync(String(password), String(salt), 64).toString('hex'); }
function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 600); }
function normEmail(v) { return String(v || '').trim().toLowerCase(); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
function normPhone(v) { return String(v || '').replace(/[^\d+]/g, ''); }
function toNum(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

/* ───────────── engine de CRUD genérico (Firestore) ───────────── */
async function readAll(name) {
  const snap = await col(name).get();
  const out = [];
  snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
  return out;
}
async function findById(name, id) {
  if (!id) return null;
  const d = await col(name).doc(String(id)).get();
  return d.exists ? Object.assign({ id: d.id }, d.data()) : null;
}
async function findOneBy(name, field, value) {
  const snap = await col(name).where(field, '==', value).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return Object.assign({ id: d.id }, d.data());
}
async function createDoc(name, data, prefix) {
  const id = genId(prefix);
  const doc = Object.assign({}, data, { criadoEm: data.criadoEm || nowIso(), atualizadoEm: nowIso() });
  await col(name).doc(id).set(doc);
  return Object.assign({ id: id }, doc);
}
async function updateDoc(name, id, updates) {
  updates.atualizadoEm = nowIso();
  await col(name).doc(String(id)).set(updates, { merge: true });
  return await findById(name, id);
}
async function removeDoc(name, id) { await col(name).doc(String(id)).delete(); return true; }

async function logAudit(action, entity, entityId, userId, details) {
  try {
    await col('crm_audit').add({ action: action, entity: entity, entityId: entityId || '', userId: userId || 'system', details: details || {}, ts: nowIso() });
  } catch (e) {}
}

/* ───────────── white-label / config ───────────── */
function defaultConfig() {
  return {
    APP_NAME: 'Lazy Labs CRM', APP_LOGO_URL: '', APP_FAVICON_URL: '',
    BRAND_PRIMARY: '#00f0ff', BRAND_ACCENT: '#a855f7', BRAND_OK: '#00ff9d',
    COMPANY_TAGLINE: 'IA & Automação', WHATSAPP_DEFAULT: ''
  };
}
const BRANDING_KEYS = ['APP_NAME', 'APP_LOGO_URL', 'APP_FAVICON_URL', 'BRAND_PRIMARY', 'BRAND_ACCENT', 'BRAND_OK', 'COMPANY_TAGLINE', 'WHATSAPP_DEFAULT'];
async function getConfig() {
  const d = await cdb().doc('config/crm').get();
  return Object.assign(defaultConfig(), d.exists ? d.data() : {});
}

/* ───────────── auth ───────────── */
const SESSION_HOURS = 12, LOCK_THRESHOLD = 5, LOCK_MINUTES = 10;
const loginHits = {}; /* rate-limit em memória (por instância) */

function userDto(u) {
  return { id: u.id, nome: u.nome || '', email: u.email || '', perfil: u.perfil || 'membro', telegramId: u.telegramId || '', ativo: u.ativo !== false, criadoEm: u.criadoEm || '' };
}
function safeUser(u) {
  return { id: u.id, nome: u.nome || '', email: u.email || '', perfil: u.perfil || 'membro', avatar: u.avatar || '' };
}

async function validateSession(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const ref = cdb().doc('crm_sessions/' + sha256hex(t));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const s = snap.data();
  if (!s.expiresAt || new Date(s.expiresAt) < new Date()) { try { await ref.delete(); } catch (e) {} return null; }
  const user = await findById('crm_users', s.userId);
  if (!user || user.ativo === false) return null;
  return { user: user, sessionRef: ref };
}

async function loginUser(p) {
  const email = normEmail(p.email), password = String(p.password || '');
  if (!email || !password) return { success: false, error: 'Informe e-mail e senha.' };
  const k = 'l:' + email, win = Date.now() - 300000;
  loginHits[k] = (loginHits[k] || []).filter(function (t) { return t > win; });
  if (loginHits[k].length >= 12) return { success: false, error: 'Muitas tentativas. Aguarde alguns minutos.' };
  loginHits[k].push(Date.now());

  const user = await findOneBy('crm_users', 'email', email);
  if (!user || user.ativo === false) return { success: false, error: 'Usuário não encontrado ou inativo.' };
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) return { success: false, error: 'Conta bloqueada por tentativas. Aguarde ' + LOCK_MINUTES + ' min.' };
  if (!user.passwordHash) return { success: false, error: 'Sem senha ativa. Use "Esqueci minha senha".' };

  if (hashPassword(password, user.salt || '') !== user.passwordHash) {
    const fails = (toNum(user.failedAttempts) || 0) + 1;
    const upd = { failedAttempts: fails };
    if (fails >= LOCK_THRESHOLD) { upd.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(); upd.failedAttempts = 0; }
    await col('crm_users').doc(user.id).set(upd, { merge: true });
    return { success: false, error: 'Senha inválida.' };
  }
  const result = await createSession_(user);
  await col('crm_users').doc(user.id).set({ failedAttempts: 0, lockedUntil: '', lastLogin: nowIso() }, { merge: true });
  await logAudit('login', 'crm_users', user.id, user.id, {});
  return result;
}

async function createSession_(user) {
  const token = genToken(32);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await cdb().doc('crm_sessions/' + sha256hex(token)).set({ userId: user.id, expiresAt: expiresAt, createdAt: nowIso() });
  return { success: true, data: { token: token, expiresAt: expiresAt, user: safeUser(user) } };
}

async function setUserPassword(userId, password) {
  const salt = genToken(16);
  await col('crm_users').doc(userId).set({ passwordHash: hashPassword(password, salt), salt: salt, atualizadoEm: nowIso() }, { merge: true });
}

/* ───────────── setup de 1º acesso (sem editor; idempotente) ───────────── */
async function setupStatus() {
  const snap = await col('crm_users').limit(1).get();
  return { success: true, data: { configured: !snap.empty } };
}
async function ensureSchemaSeed(email, password, nome) {
  const admin = await createDoc('crm_users', { nome: clean(nome || email.split('@')[0], 120), email: email, perfil: 'admin', telegramId: '', ativo: true, avatar: '' }, 'USR');
  await setUserPassword(admin.id, password);
  await createDoc('crm_pipelines', { nome: 'Comercial', etapas: ['Novo', 'Qualificado', 'Reunião', 'Proposta', 'Fechado', 'Perdido'], ativo: true, ordem: 1, cor: '#00f0ff' }, 'PIPE');
  await cdb().doc('config/crm').set(defaultConfig(), { merge: true });
  return admin;
}
async function setupAdmin(p) {
  if (!p.verifiedAdmin) return { success: false, error: 'Autenticação administrativa necessária.' };
  const snap = await col('crm_users').limit(1).get();
  if (!snap.empty) return { success: false, error: 'CRM já configurado. Faça login.' };
  const nome = clean(p.nome, 120), email = normEmail(p.verifiedAdmin.email), password = String(p.password || '');
  if (!nome || !isEmail(email)) return { success: false, error: 'Informe nome e e-mail válido.' };
  if (password.length < 8) return { success: false, error: 'Senha deve ter ao menos 8 caracteres.' };
  const admin = await ensureSchemaSeed(email, password, nome);
  await logAudit('setup', 'crm_users', admin.id, admin.id, {});
  return { success: true, data: { message: 'CRM configurado. Faça login.' } };
}

/* SSO do hub: o admin (já autenticado no painel) loga no CRM sem segunda tela.
   Provisiona o admin na 1ª vez (banco vazio = primeiro a chamar define as credenciais),
   depois apenas autentica via loginUser (senha verificada). Sem requisito de tamanho — o
   perímetro é o login do painel. O endpoint /api/crm continua exigindo sessão. */
async function hubBind(p) {
  if (!p.verifiedAdmin) return { success: false, error: 'Autenticação administrativa necessária.' };
  const email = normEmail(p.verifiedAdmin.email);
  if (!email) return { success: false, error: 'E-mail ausente.' };
  const snap = await col('crm_users').limit(1).get();
  if (snap.empty) {
    const admin = await ensureSchemaSeed(email, genToken(32), p.verifiedAdmin.email);
    await logAudit('hubBind-setup', 'crm_users', admin.id, admin.id, {});
  }
  let user = await findOneBy('crm_users', 'email', email);
  if (!user) {
    user = await createDoc('crm_users', { nome: clean(email.split('@')[0], 120), email: email, perfil: 'admin', ativo: true }, 'USR');
    await setUserPassword(user.id, genToken(32));
  }
  if (user.ativo === false) return { success: false, error: 'Usuário CRM inativo.' };
  await logAudit('hubBind', 'crm_users', user.id, user.id, {});
  return await createSession_(user);
}

/* ───────────── leads ───────────── */
const LEAD_STATUS = ['Novo', 'Contatado', 'Qualificado', 'Em negociação', 'Cliente', 'Perdido'];
const LEAD_TEMP = ['Frio', 'Morno', 'Quente'];
function leadDto(r) {
  return {
    id: r.id, nome: r.nome || '', telefone: r.telefone || '', email: r.email || '', empresa: r.empresa || '',
    cargo: r.cargo || '', fonte: r.fonte || '', status: r.status || 'Novo', temperatura: r.temperatura || 'Frio',
    responsavel: r.responsavel || '', valorEstimado: toNum(r.valorEstimado), observacoes: r.observacoes || '',
    tags: Array.isArray(r.tags) ? r.tags : [], criadoEm: r.criadoEm || '', atualizadoEm: r.atualizadoEm || ''
  };
}
async function getLeads(p) {
  let list = (await readAll('crm_leads')).map(leadDto);
  if (p.status) list = list.filter(function (l) { return l.status === p.status; });
  if (p.temperatura) list = list.filter(function (l) { return l.temperatura === p.temperatura; });
  if (p.fonte) list = list.filter(function (l) { return l.fonte === p.fonte; });
  const q = String(p.q || '').trim().toLowerCase();
  if (q) list = list.filter(function (l) { return (l.nome + ' ' + l.email + ' ' + l.empresa + ' ' + l.telefone).toLowerCase().indexOf(q) !== -1; });
  list.sort(function (a, b) { return (b.criadoEm || '').localeCompare(a.criadoEm || ''); });
  return { success: true, data: { leads: list, statusOptions: LEAD_STATUS, tempOptions: LEAD_TEMP } };
}
async function getLead(p) {
  const r = await findById('crm_leads', p.id);
  if (!r) return { success: false, error: 'Lead não encontrado.' };
  return { success: true, data: leadDto(r) };
}
async function createLead(p) {
  const nome = clean(p.nome, 160);
  if (!nome) return { success: false, error: 'Informe o nome do lead.' };
  const doc = {
    nome: nome, telefone: normPhone(p.telefone), email: normEmail(p.email), empresa: clean(p.empresa, 160),
    cargo: clean(p.cargo, 120), fonte: clean(p.fonte || 'Manual', 80),
    status: LEAD_STATUS.indexOf(p.status) !== -1 ? p.status : 'Novo',
    temperatura: LEAD_TEMP.indexOf(p.temperatura) !== -1 ? p.temperatura : 'Frio',
    responsavel: clean(p.responsavel || (p.sessionUser && p.sessionUser.nome) || '', 120),
    valorEstimado: toNum(p.valorEstimado), observacoes: clean(p.observacoes, 2000),
    tags: Array.isArray(p.tags) ? p.tags : []
  };
  const res = await createDoc('crm_leads', doc, 'LEAD');
  await logAudit('create', 'crm_leads', res.id, p.sessionUserId, { nome: nome });
  return { success: true, data: leadDto(res) };
}
async function updateLead(p) {
  if (!p.id) return { success: false, error: 'ID ausente.' };
  const upd = {};
  if (p.nome !== undefined) upd.nome = clean(p.nome, 160);
  if (p.telefone !== undefined) upd.telefone = normPhone(p.telefone);
  if (p.email !== undefined) upd.email = normEmail(p.email);
  ['empresa', 'cargo', 'fonte', 'responsavel'].forEach(function (k) { if (p[k] !== undefined) upd[k] = clean(p[k], 160); });
  if (p.status !== undefined && LEAD_STATUS.indexOf(p.status) !== -1) upd.status = p.status;
  if (p.temperatura !== undefined && LEAD_TEMP.indexOf(p.temperatura) !== -1) upd.temperatura = p.temperatura;
  if (p.valorEstimado !== undefined) upd.valorEstimado = toNum(p.valorEstimado);
  if (p.observacoes !== undefined) upd.observacoes = clean(p.observacoes, 2000);
  if (p.tags !== undefined) upd.tags = Array.isArray(p.tags) ? p.tags : [];
  const r = await updateDoc('crm_leads', p.id, upd);
  await logAudit('update', 'crm_leads', p.id, p.sessionUserId, {});
  return { success: true, data: leadDto(r) };
}
async function deleteLead(p) { await removeDoc('crm_leads', p.id); await logAudit('delete', 'crm_leads', p.id, p.sessionUserId, {}); return { success: true }; }
async function convertLead(p) {
  const lead = await findById('crm_leads', p.id);
  if (!lead) return { success: false, error: 'Lead não encontrado.' };
  const pipes = (await readAll('crm_pipelines')).filter(function (x) { return x.ativo !== false; });
  const pipe = pipes[0];
  if (!pipe) return { success: false, error: 'Nenhum pipeline ativo.' };
  const etapas = Array.isArray(pipe.etapas) ? pipe.etapas : ['Novo'];
  const deal = await createDoc('crm_deals', {
    leadId: lead.id, nome: lead.nome + (lead.empresa ? ' — ' + lead.empresa : ''), pipeline: pipe.nome,
    etapa: (p.etapa && etapas.indexOf(p.etapa) !== -1) ? p.etapa : etapas[0], valor: toNum(p.valor || lead.valorEstimado),
    responsavel: lead.responsavel || (p.sessionUser && p.sessionUser.nome) || '', previsao: p.previsao || '',
    status: 'Aberta', origem: lead.fonte || '', observacoes: '', ultimaMov: nowIso()
  }, 'OPP');
  await updateDoc('crm_leads', lead.id, { status: 'Em negociação' });
  await logAudit('convert', 'crm_leads', lead.id, p.sessionUserId, { oport: deal.id });
  return { success: true, data: { oportId: deal.id } };
}

/* ───────────── pipeline / oportunidades ───────────── */
function pipeDto(r) { return { id: r.id, nome: r.nome || '', etapas: Array.isArray(r.etapas) ? r.etapas : [], ativo: r.ativo !== false, ordem: toNum(r.ordem), cor: r.cor || '#00f0ff' }; }
function dealDto(r) {
  return {
    id: r.id, leadId: r.leadId || '', nome: r.nome || '', pipeline: r.pipeline || '', etapa: r.etapa || '',
    valor: toNum(r.valor), responsavel: r.responsavel || '', previsao: r.previsao || '', status: r.status || 'Aberta',
    origem: r.origem || '', observacoes: r.observacoes || '', criadoEm: r.criadoEm || '', ultimaMov: r.ultimaMov || ''
  };
}
async function getPipelines() {
  const list = (await readAll('crm_pipelines')).map(pipeDto).sort(function (a, b) { return a.ordem - b.ordem; });
  return { success: true, data: { pipelines: list } };
}
async function savePipeline(p) {
  if (p.sessionUser && p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas admin pode editar pipelines.' };
  const etapas = Array.isArray(p.etapas) ? p.etapas.map(function (e) { return clean(e, 40); }).filter(Boolean) : [];
  if (!p.nome || etapas.length < 2) return { success: false, error: 'Informe nome e ao menos 2 etapas.' };
  if (p.id) { await updateDoc('crm_pipelines', p.id, { nome: clean(p.nome, 80), etapas: etapas, ativo: p.ativo !== false, cor: clean(p.cor || '#00f0ff', 16) }); return { success: true, data: { id: p.id } }; }
  const res = await createDoc('crm_pipelines', { nome: clean(p.nome, 80), etapas: etapas, ativo: true, ordem: toNum(p.ordem) || 99, cor: clean(p.cor || '#00f0ff', 16) }, 'PIPE');
  return { success: true, data: { id: res.id } };
}
async function getDeals(p) {
  let list = (await readAll('crm_deals')).map(dealDto);
  if (p.pipeline) list = list.filter(function (d) { return d.pipeline === p.pipeline; });
  list.sort(function (a, b) { return (b.ultimaMov || '').localeCompare(a.ultimaMov || ''); });
  return { success: true, data: { deals: list } };
}
async function createDeal(p) {
  if (!p.nome) return { success: false, error: 'Informe o nome da oportunidade.' };
  const res = await createDoc('crm_deals', {
    leadId: clean(p.leadId, 60), nome: clean(p.nome, 160), pipeline: clean(p.pipeline || 'Comercial', 80),
    etapa: clean(p.etapa || 'Novo', 40), valor: toNum(p.valor), responsavel: clean(p.responsavel || (p.sessionUser && p.sessionUser.nome) || '', 120),
    previsao: clean(p.previsao, 30), status: 'Aberta', origem: clean(p.origem || 'Manual', 80), observacoes: clean(p.observacoes, 2000), ultimaMov: nowIso()
  }, 'OPP');
  await logAudit('create', 'crm_deals', res.id, p.sessionUserId, {});
  return { success: true, data: dealDto(res) };
}
async function updateDeal(p) {
  if (!p.id) return { success: false, error: 'ID ausente.' };
  const upd = {};
  if (p.nome !== undefined) upd.nome = clean(p.nome, 160);
  if (p.valor !== undefined) upd.valor = toNum(p.valor);
  if (p.responsavel !== undefined) upd.responsavel = clean(p.responsavel, 120);
  if (p.previsao !== undefined) upd.previsao = clean(p.previsao, 30);
  if (p.status !== undefined) upd.status = clean(p.status, 30);
  if (p.observacoes !== undefined) upd.observacoes = clean(p.observacoes, 2000);
  const r = await updateDoc('crm_deals', p.id, upd);
  return { success: true, data: dealDto(r) };
}
async function moveDeal(p) {
  if (!p.id || !p.etapa) return { success: false, error: 'Dados insuficientes.' };
  const upd = { etapa: clean(p.etapa, 40), ultimaMov: nowIso() };
  if (p.etapa === 'Fechado') upd.status = 'Ganha';
  if (p.etapa === 'Perdido') upd.status = 'Perdida';
  await updateDoc('crm_deals', p.id, upd);
  await logAudit('move', 'crm_deals', p.id, p.sessionUserId, { etapa: p.etapa });
  return { success: true };
}
async function deleteDeal(p) { await removeDoc('crm_deals', p.id); return { success: true }; }

/* ───────────── dashboard ───────────── */
async function getDashboard() {
  const leads = await readAll('crm_leads');
  const deals = await readAll('crm_deals');
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  let leadsQuentes = 0, leadsNovosMes = 0;
  leads.forEach(function (l) { if (l.temperatura === 'Quente') leadsQuentes++; if ((l.criadoEm || '') >= monthStart) leadsNovosMes++; });
  let abertas = 0, valorPipeline = 0, ganhasMes = 0, valorGanhoMes = 0; const porEtapa = {};
  deals.forEach(function (d) {
    porEtapa[d.etapa] = (porEtapa[d.etapa] || 0) + 1;
    if (d.status === 'Aberta') { abertas++; valorPipeline += toNum(d.valor); }
    if (d.status === 'Ganha' && (d.ultimaMov || '') >= monthStart) { ganhasMes++; valorGanhoMes += toNum(d.valor); }
  });
  const recentes = leads.map(leadDto).sort(function (a, b) { return (b.criadoEm || '').localeCompare(a.criadoEm || ''); }).slice(0, 6);
  const funnel = Object.keys(porEtapa).map(function (k) { return { etapa: k, total: porEtapa[k] }; });
  return { success: true, data: { kpis: { totalLeads: leads.length, leadsNovosMes: leadsNovosMes, leadsQuentes: leadsQuentes, oportAbertas: abertas, valorPipeline: valorPipeline, ganhasMes: ganhasMes, valorGanhoMes: valorGanhoMes }, recentes: recentes, funnel: funnel } };
}

/* ───────────── config + usuários (admin) ───────────── */
async function getPublicBootstrapData() {
  const c = await getConfig();
  return { success: true, data: { APP_NAME: c.APP_NAME, APP_LOGO_URL: c.APP_LOGO_URL, APP_FAVICON_URL: c.APP_FAVICON_URL, BRAND_PRIMARY: c.BRAND_PRIMARY, BRAND_ACCENT: c.BRAND_ACCENT, BRAND_OK: c.BRAND_OK, COMPANY_TAGLINE: c.COMPANY_TAGLINE } };
}
async function getSettings(p) {
  const c = await getConfig(); const out = {};
  BRANDING_KEYS.forEach(function (k) { out[k] = c[k] || ''; });
  return { success: true, data: { config: out, isAdmin: p.sessionUser && p.sessionUser.perfil === 'admin' } };
}
async function saveSettings(p) {
  if (!p.sessionUser || p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas administradores.' };
  const cfg = p.config || {}; const upd = {};
  BRANDING_KEYS.forEach(function (k) { if (cfg[k] !== undefined) upd[k] = clean(cfg[k], 300); });
  await cdb().doc('config/crm').set(upd, { merge: true });
  await logAudit('update', 'config', 'crm', p.sessionUserId, {});
  return { success: true };
}
async function getUsers(p) {
  if (!p.sessionUser || p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas administradores.' };
  const users = (await readAll('crm_users')).map(userDto).sort(function (a, b) { return (a.criadoEm || '').localeCompare(b.criadoEm || ''); });
  return { success: true, data: { users: users } };
}
async function inviteUser(p) {
  if (!p.sessionUser || p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas administradores.' };
  const nome = clean(p.nome, 120), email = normEmail(p.email);
  if (!nome || !isEmail(email)) return { success: false, error: 'Informe nome e e-mail válido.' };
  if (await findOneBy('crm_users', 'email', email)) return { success: false, error: 'Já existe um usuário com esse e-mail.' };
  const perfil = p.perfil === 'admin' ? 'admin' : 'membro';
  const res = await createDoc('crm_users', { nome: nome, email: email, perfil: perfil, telegramId: clean(p.telegramId, 60), ativo: true, avatar: '' }, 'USR');
  const tempPassword = 'lazy-' + crypto.randomBytes(4).toString('hex');
  await setUserPassword(res.id, tempPassword);
  await logAudit('invite', 'crm_users', res.id, p.sessionUserId, { email: email });
  return { success: true, data: { id: res.id, tempPassword: tempPassword } };
}
async function updateUser(p) {
  if (!p.sessionUser || p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas administradores.' };
  if (!p.id) return { success: false, error: 'ID ausente.' };
  const upd = {};
  if (p.nome !== undefined) upd.nome = clean(p.nome, 120);
  if (p.perfil !== undefined) upd.perfil = p.perfil === 'admin' ? 'admin' : 'membro';
  if (p.telegramId !== undefined) upd.telegramId = clean(p.telegramId, 60);
  if (p.ativo !== undefined) upd.ativo = !!p.ativo;
  await updateDoc('crm_users', p.id, upd);
  if (p.newPassword) {
    if (String(p.newPassword).length < 8) return { success: false, error: 'Senha deve ter ao menos 8 caracteres.' };
    await setUserPassword(p.id, String(p.newPassword));
  }
  await logAudit('update', 'crm_users', p.id, p.sessionUserId, {});
  return { success: true };
}

/* ───────────── ingestão de leads do funil (form-diagnóstico → CRM) ───────────── */
function tryParseObj(v) { try { if (!v) return {}; if (typeof v === 'object') return v; return JSON.parse(v); } catch (e) { return {}; } }
function summarizeAnswers(answers) {
  if (!answers || typeof answers !== 'object') return '';
  const skip = { name: 1, phone: 1, email: 1, nome: 1, telefone: 1 };
  const lines = [];
  Object.keys(answers).forEach(function (k) {
    if (skip[String(k).toLowerCase()]) return;
    const v = answers[k];
    if (v == null || v === '') return;
    lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : String(v)));
  });
  return lines.join('\n').slice(0, 1900);
}
function crmLeadFromForm(o) {
  const answers = tryParseObj(o.answers);
  const complete = String(o.status || '').toLowerCase().indexOf('compl') === 0;
  return {
    nome: clean(o.nome || answers.name || '', 160),
    telefone: normPhone(o.telefone || answers.phone || ''),
    email: normEmail(o.email || answers.email || ''),
    empresa: '', cargo: '', fonte: 'Formulário', status: 'Novo',
    temperatura: complete ? 'Quente' : 'Morno', responsavel: '', valorEstimado: 0,
    observacoes: summarizeAnswers(answers), tags: ['form-diagnostico'],
    criadoEm: o.criado_em || nowIso(), atualizadoEm: nowIso()
  };
}
/* upsert idempotente: doc id = form_<sid>; em re-envio só atualiza contato/observações,
   preservando o que foi editado no CRM (status, temperatura, responsável, valor, tags). */
async function ingestFormLead(o) {
  try {
    const sid = String(o.sid || o.sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const mapped = crmLeadFromForm(o);
    if (!sid) return false;
    if (!mapped.nome && !mapped.telefone && !mapped.email) return false; // sem contato → ignora
    const ref = col('crm_leads').doc('form_' + sid);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.set({ nome: mapped.nome, telefone: mapped.telefone, email: mapped.email, observacoes: mapped.observacoes, atualizadoEm: nowIso() }, { merge: true });
    } else {
      await ref.set(Object.assign({}, mapped, { sourceRef: 'form_leads/' + sid }));
    }
    return true;
  } catch (e) { console.error('[crmIngest]', e.message); return false; }
}
/* backfill: importa todos os leads já capturados pelo formulário (ação admin). */
async function importLeads(p) {
  if (!p.sessionUser || p.sessionUser.perfil !== 'admin') return { success: false, error: 'Apenas administradores.' };
  const snap = await cdb().collection('form_leads').get();
  let imported = 0;
  const tasks = [];
  snap.forEach(function (d) {
    const fl = d.data();
    tasks.push(ingestFormLead({ sid: d.id, nome: fl.nome, telefone: fl.telefone, email: fl.email, answers: fl.answers_json, status: fl.status, criado_em: fl.criado_em })
      .then(function (ok) { if (ok) imported++; }));
  });
  await Promise.all(tasks);
  await logAudit('import', 'crm_leads', 'form', p.sessionUserId, { imported: imported, total: snap.size });
  return { success: true, data: { imported: imported, total: snap.size } };
}

/* ───────────── roteador único (a API) ───────────── */
const PUBLIC_ACTIONS = { getPublicBootstrapData: 1, loginUser: 1, getCurrentSession: 1, logoutUser: 1, setupStatus: 1, setupAdmin: 1, hubBind: 1 };

async function route(action, data, sessionToken) {
  if (!action) return { success: false, error: 'Nenhuma ação especificada.' };

  if (!PUBLIC_ACTIONS[action]) {
    const session = await validateSession(sessionToken || data.sessionToken || '');
    if (!session) return { success: false, error: 'Sessão expirada. Faça login novamente.', code: 'AUTH_REQUIRED' };
    data.sessionUser = safeUser(session.user);
    data.sessionUserId = session.user.id;
  }

  switch (action) {
    case 'getPublicBootstrapData': return await getPublicBootstrapData();
    case 'setupStatus': return await setupStatus();
    case 'setupAdmin': return await setupAdmin(data);
    case 'hubBind': return await hubBind(data);
    case 'loginUser': return await loginUser(data);
    case 'getCurrentSession': { const s = await validateSession(sessionToken || data.sessionToken || ''); return s ? { success: true, data: { user: safeUser(s.user) } } : { success: false, error: 'Sessão inválida.', code: 'AUTH_REQUIRED' }; }
    case 'logoutUser': { const t = sessionToken || data.sessionToken || ''; if (t) { try { await cdb().doc('crm_sessions/' + sha256hex(t)).delete(); } catch (e) {} } return { success: true }; }
    case 'getDashboard': return await getDashboard(data);
    case 'getLeads': return await getLeads(data);
    case 'importLeads': return await importLeads(data);
    case 'getLead': return await getLead(data);
    case 'createLead': return await createLead(data);
    case 'updateLead': return await updateLead(data);
    case 'deleteLead': return await deleteLead(data);
    case 'convertLead': return await convertLead(data);
    case 'getPipelines': return await getPipelines(data);
    case 'savePipeline': return await savePipeline(data);
    case 'getDeals': return await getDeals(data);
    case 'createDeal': return await createDeal(data);
    case 'updateDeal': return await updateDeal(data);
    case 'moveDeal': return await moveDeal(data);
    case 'deleteDeal': return await deleteDeal(data);
    case 'getSettings': return await getSettings(data);
    case 'saveSettings': return await saveSettings(data);
    case 'getUsers': return await getUsers(data);
    case 'inviteUser': return await inviteUser(data);
    case 'updateUser': return await updateUser(data);
    default: return { success: false, error: 'Ação desconhecida: ' + action };
  }
}

/* handler HTTP — montado como onRequest no index.js */
async function handler(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method === 'GET') { res.status(200).json({ ok: true, service: 'crm' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ success: false, error: 'use POST' }); return; }

  let body = {};
  try { body = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (e) { body = {}; }
  const action = body.action;
  const data = body.data || {};
  const sessionToken = body.sessionToken || '';
  try {
    if (action === 'hubBind' || action === 'setupAdmin') {
      const admin = await require('./admin').requireAdmin_(req, res);
      if (!admin) return;
      data.verifiedAdmin = admin;
    }
    const result = await route(action, data, sessionToken);
    res.status(200).json(result);
  } catch (err) {
    console.error('[crm]', action, err);
    res.status(200).json({ success: false, error: err && err.message ? err.message : 'Erro interno.' });
  }
}

module.exports = { handler: handler, ingestFormLead: ingestFormLead };
