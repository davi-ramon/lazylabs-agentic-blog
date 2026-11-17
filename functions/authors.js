/**
 * Lazy Labs — perfis de autor/blogger (multi-autor por blog).
 * Endpoint: /api/authors/<action>
 *   - list            (GET, admin)                  → autores do blog_id atual
 *   - invite          (POST, admin) {blog_id, email} → cria autor 'pending', manda e-mail com link
 *                                                       de acesso (expira em 5 min)
 *   - regenerateToken (POST, admin) {id}             → gera link novo (5 min) e reenvia o e-mail
 *   - updateAdmin     (POST, admin) {id, ...campos}  → admin edita qualquer autor direto, sem link
 *   - delete          (POST, admin) {id}             → remove o autor (posts existentes mantêm o nome gravado)
 *   - getByToken      (POST, publico) {token}        → dados atuais, valida expiracao
 *   - updateProfile   (POST, publico) {token, name, ...} → o proprio autor configura o perfil
 *
 * Schema de authors/{id}: blog_id, email, name, nickname, bio, specialty, photo_url,
 * social{twitter,linkedin,instagram,website,email}, status(pending|active),
 * edit_token, token_expires_at (ISO), createdAt, updatedAt, invitedBy.
 *
 * O token de edicao NUNCA sai em list/invite pro público — só quem tem o link
 * (getByToken/updateProfile) consegue usar, e só dentro da janela de 5 minutos
 * a partir de quando foi gerado/regenerado.
 */
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');
const adminModule = require('./admin');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SITE_URL = 'https://blog.example.com';
const DEFAULT_BLOG_ID = 'your-blog';
const SOCIAL_KEYS = ['twitter', 'linkedin', 'instagram', 'website', 'email'];
const TOKEN_TTL_MS = 5 * 60 * 1000;

function json_(res, status, obj) { res.set('Content-Type', 'application/json; charset=utf-8'); res.status(status).send(JSON.stringify(obj)); }
function setCors_(req, res) {
  const origin = req.headers.origin || req.headers.Origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
}
function readBody_(req) { try { return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (e) { return {}; } }
function slugify_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\p{Diacritic}]/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'autor';
}
function newToken_() { return crypto.randomBytes(24).toString('hex'); }
function sanitizeSocial_(social) {
  const out = {};
  SOCIAL_KEYS.forEach(function (k) { out[k] = String((social && social[k]) || '').slice(0, 200); });
  return out;
}
function publicShape_(id, a) {
  return {
    id: id, name: a.name || '', nickname: a.nickname || '', bio: a.bio || '',
    specialty: a.specialty || '', photo_url: a.photo_url || '', social: a.social || {},
    status: a.status || 'pending'
  };
}
function isValidEmail_(email) { return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email); }

async function getFormEmailCfg_() {
  const snap = await db().doc('config/form').get();
  const d = snap.exists ? snap.data() : {};
  return (d && d.email) || {};
}

function buildAuthorInviteEmail_(link, isResend) {
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#020208;color:#e8e8f5;border-radius:12px">'
    + '<div style="text-align:center;padding:24px 0;border-bottom:1px solid rgba(0,240,255,.15)">'
    + '<div style="font-family:monospace;font-size:22px;font-weight:700;color:#00f0ff;letter-spacing:.05em">[LAZY LABS]</div>'
    + '<div style="font-size:11px;color:#7a7a9a;letter-spacing:.15em;text-transform:uppercase;margin-top:6px">Convite — Lazy Labs Blog</div>'
    + '</div>'
    + '<div style="padding:32px 0">'
    + '<p style="margin:0 0 16px 0;line-height:1.6">Olá!</p>'
    + '<p style="margin:0 0 24px 0;line-height:1.6">' + (isResend ? 'Aqui está um novo link' : 'Você foi convidado') + ' para configurar seu perfil de autor no <b>Lazy Labs Blog</b> — nome, foto, bio e redes sociais que aparecem nos artigos que você escrever.</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + link + '" style="display:inline-block;background:linear-gradient(120deg,#00f0ff,#a855f7);color:#04040c;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:11px">Configurar meu perfil</a>'
    + '</div>'
    + '<p style="margin:24px 0 0 0;font-size:12px;color:#ffb800;text-align:center"><b>Esse link expira em 5 minutos.</b> Se expirar, peça um novo ao administrador do blog.</p>'
    + '<p style="margin:12px 0 0 0;font-size:12px;color:#7a7a9a;text-align:center">Se você não esperava este convite, ignore este e-mail.</p>'
    + '</div>'
    + '<div style="border-top:1px solid rgba(0,240,255,.15);padding-top:16px;text-align:center;font-size:10px;color:#4a4a6a">'
    + '<a href="https://example.com" style="color:#00f0ff;text-decoration:none">example.com</a> &nbsp;·&nbsp; <a href="https://blog.example.com" style="color:#00f0ff;text-decoration:none">blog.example.com</a>'
    + '</div></div>';
}

async function sendInviteEmail_(toEmail, link, isResend) {
  const e = await getFormEmailCfg_();
  if (!e.resendKey) { console.log('[authors] sem resendKey configurada — nao foi possivel enviar o convite por e-mail.'); return { ok: false, sent: false }; }
  const from = e.fromEmail ? ((e.fromName || 'Lazy Labs') + ' <' + e.fromEmail + '>') : 'Lazy Labs <onboarding@resend.dev>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + e.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: [toEmail], subject: 'Convite — configure seu perfil no Lazy Labs Blog', html: buildAuthorInviteEmail_(link, isResend) })
    });
    return { ok: resp.ok, sent: resp.ok };
  } catch (err) {
    console.error('[authors] falha ao enviar convite:', err.message);
    return { ok: false, sent: false };
  }
}

async function listAuthors_(req, res) {
  const user = await adminModule.requireAdmin_(req, res, { anyRole: true }); if (!user) return;
  const blogId = String((req.query && req.query.blog_id) || DEFAULT_BLOG_ID);
  const snap = await db().collection('authors').where('blog_id', '==', blogId).get();
  const authors = [];
  snap.forEach(function (d) {
    const a = d.data();
    authors.push({
      id: d.id, blog_id: a.blog_id, email: a.email || '', name: a.name || '', nickname: a.nickname || '',
      bio: a.bio || '', specialty: a.specialty || '', photo_url: a.photo_url || '', social: a.social || {},
      status: a.status || 'pending', createdAt: a.createdAt
    });
  });
  json_(res, 200, { ok: true, authors: authors });
}

async function inviteAuthor_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const email = String(body.email || '').trim().toLowerCase();
  const blogId = String(body.blog_id || DEFAULT_BLOG_ID);
  if (!email || !isValidEmail_(email)) { json_(res, 200, { ok: false, message: 'E-mail válido é obrigatório.' }); return; }
  let id = slugify_(email.split('@')[0]);
  const existing = await db().doc('authors/' + id).get();
  if (existing.exists) id = id + '-' + Date.now().toString(36).slice(-4);
  const token = newToken_();
  const now = new Date();
  const doc = {
    blog_id: blogId, email: email, name: '', nickname: '', bio: '', specialty: '', photo_url: '',
    social: sanitizeSocial_({}), status: 'pending', edit_token: token,
    token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(), invitedBy: user.email
  };
  await db().doc('authors/' + id).set(doc);
  const link = SITE_URL + '/colaborar/' + token;
  const mail = await sendInviteEmail_(email, link, false);
  json_(res, 201, { ok: true, id: id, invite_url: link, email_sent: mail.sent });
}

async function regenerateToken_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  const ref = db().doc('authors/' + id);
  const snap = await ref.get();
  if (!snap.exists) { json_(res, 200, { ok: false, message: 'Autor não encontrado.' }); return; }
  const a = snap.data();
  const token = newToken_();
  const now = new Date();
  await ref.set({ edit_token: token, token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(), updatedAt: now.toISOString() }, { merge: true });
  const link = SITE_URL + '/colaborar/' + token;
  let mail = { sent: false };
  if (a.email) mail = await sendInviteEmail_(a.email, link, true);
  json_(res, 200, { ok: true, invite_url: link, email_sent: mail.sent });
}

async function updateAdmin_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  const ref = db().doc('authors/' + id);
  const snap = await ref.get();
  if (!snap.exists) { json_(res, 200, { ok: false, message: 'Autor não encontrado.' }); return; }
  const patch = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 120);
  if (body.nickname !== undefined) patch.nickname = String(body.nickname).slice(0, 80);
  if (body.bio !== undefined) patch.bio = String(body.bio).slice(0, 1000);
  if (body.specialty !== undefined) patch.specialty = String(body.specialty).slice(0, 120);
  if (body.photo_url !== undefined) patch.photo_url = String(body.photo_url).slice(0, 500);
  if (body.social !== undefined) patch.social = sanitizeSocial_(body.social);
  const finalName = patch.name !== undefined ? patch.name : snap.data().name;
  if (finalName) patch.status = 'active';
  await ref.set(patch, { merge: true });
  json_(res, 200, { ok: true });
}

async function deleteAuthor_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  await db().doc('authors/' + id).delete();
  json_(res, 200, { ok: true });
}

function checkExpiry_(a) {
  if (!a.token_expires_at) return true; // autores antigos sem expiracao (pre-2026-09-12) continuam validos
  return new Date(a.token_expires_at).getTime() >= Date.now();
}

async function getByToken_(req, res) {
  const body = readBody_(req);
  const token = String(body.token || '').trim();
  if (!token) { json_(res, 200, { ok: false, message: 'token obrigatório.' }); return; }
  const snap = await db().collection('authors').where('edit_token', '==', token).limit(1).get();
  if (snap.empty) { json_(res, 200, { ok: false, message: 'Link inválido.' }); return; }
  const d = snap.docs[0];
  if (!checkExpiry_(d.data())) { json_(res, 200, { ok: false, message: 'Esse link expirou (validade de 5 minutos). Peça um novo ao administrador do blog.' }); return; }
  json_(res, 200, { ok: true, author: publicShape_(d.id, d.data()) });
}

async function updateProfile_(req, res) {
  const body = readBody_(req);
  const token = String(body.token || '').trim();
  if (!token) { json_(res, 200, { ok: false, message: 'token obrigatório.' }); return; }
  const snap = await db().collection('authors').where('edit_token', '==', token).limit(1).get();
  if (snap.empty) { json_(res, 200, { ok: false, message: 'Link inválido.' }); return; }
  if (!checkExpiry_(snap.docs[0].data())) { json_(res, 200, { ok: false, message: 'Esse link expirou (validade de 5 minutos). Peça um novo ao administrador do blog.' }); return; }
  const name = String(body.name || '').trim();
  if (!name) { json_(res, 200, { ok: false, message: 'Nome é obrigatório.' }); return; }
  const ref = snap.docs[0].ref;
  const patch = {
    name: name.slice(0, 120),
    nickname: String(body.nickname || '').slice(0, 80),
    bio: String(body.bio || '').slice(0, 1000),
    specialty: String(body.specialty || '').slice(0, 120),
    photo_url: String(body.photo_url || '').slice(0, 500),
    social: sanitizeSocial_(body.social || {}),
    status: 'active',
    updatedAt: new Date().toISOString()
  };
  await ref.set(patch, { merge: true });
  json_(res, 200, { ok: true });
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
  try {
    if (action === 'list') return listAuthors_(req, res);
    if (action === 'invite') return inviteAuthor_(req, res);
    if (action === 'regenerateToken') return regenerateToken_(req, res);
    if (action === 'updateAdmin') return updateAdmin_(req, res);
    if (action === 'delete') return deleteAuthor_(req, res);
    if (action === 'getByToken') return getByToken_(req, res);
    if (action === 'updateProfile') return updateProfile_(req, res);
    json_(res, 404, { ok: false, message: 'rota desconhecida: ' + action });
  } catch (err) {
    console.error('[authors]', action, err);
    json_(res, 500, { ok: false, message: err.message });
  }
}

module.exports = { handler: handler, DEFAULT_BLOG_ID: DEFAULT_BLOG_ID };
