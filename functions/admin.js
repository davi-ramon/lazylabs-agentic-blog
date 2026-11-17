/**
 * Lazy Labs — Admin Functions.
 *
 * Legado (senha única, ainda no ar como fallback durante a migração):
 *   POST /api/admin/login     { pass } -> { ok, session, hash }
 *   POST /api/admin/reset     { email } -> { ok, code } (cria reset code)
 *   POST /api/admin/verify    { email, code } -> { ok, reset_token }
 *   POST /api/admin/setnew    { email, code, new_pass } -> { ok }
 *
 * Firebase Auth (usuários reais, com papel admin/viewer via custom claim):
 *   GET  /api/admin/listUsers                    -> { users: [...] }  (admin)
 *   POST /api/admin/inviteUser  { email, role }  -> cria/atualiza + manda link de senha  (admin)
 *   POST /api/admin/removeUser  { uid }           -> deleta a conta  (admin)
 *   POST /api/admin/profile     { email?, new_pass? } -> autoatendimento (admin ou viewer)
 *   POST /api/admin/bootstrap   { secret, email } -> promove a admin, protegido por .env, 1a vez
 *
 * requireAdmin_(req,res,opts) é exportado pra outras Functions passarem a
 * exigir Authorization: Bearer <idToken> de verdade.
 *
 * Persistencia em Firestore:
 *   - config/admin: { passwordHash (SHA-256), passwordSalt } (legado)
 *   - password_resets/{emailHash}/codes/{code}: código de reset (legado)
 *   - reset_sessions/{token}: sessão de reset (legado)
 *
 * Senha inicial do legado: 'admin' (definida na primeira chamada se nao existir).
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');

let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }
let _fbAuth = null;
function fbAuth() { if (!_fbAuth) _fbAuth = getAuth(); return _fbAuth; }

function json_(res, status, obj) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(obj));
}

function setCors_(req, res) {
  const origin = req.headers.origin || req.headers.Origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
}

function readBody_(req) {
  try {
    return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {});
  } catch (e) { return {}; }
}

function sha256_(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function getEmailCfg_() {
  const snap = await db().doc('config/email').get();
  return snap.exists ? snap.data() : {};
}

async function sendResetEmail_(to, code) {
  const e = await getEmailCfg_();
  if (!e.resendKey) {
    console.log('[admin.reset] Sem resendKey salva, retornando codigo no body (dev mode).');
    return { ok: false, dev: true, code: code };
  }
  const from = e.fromEmail ? ((e.fromName || 'Lazy Labs') + ' <' + e.fromEmail + '>') : 'Lazy Labs <onboarding@resend.dev>';
  const subject = 'Codigo de recuperacao de senha — Lazy Labs';
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#020208;color:#e8e8f5;border-radius:12px">'
    + '<div style="text-align:center;padding:24px 0;border-bottom:1px solid rgba(0,240,255,.15)">'
    + '<div style="font-family:monospace;font-size:22px;font-weight:700;color:#00f0ff;letter-spacing:.05em">[LAZY LABS]</div>'
    + '<div style="font-size:11px;color:#7a7a9a;letter-spacing:.15em;text-transform:uppercase;margin-top:6px">Recuperacao de senha</div>'
    + '</div>'
    + '<div style="padding:32px 0">'
    + '<p style="margin:0 0 16px 0;line-height:1.6">Ola!</p>'
    + '<p style="margin:0 0 24px 0;line-height:1.6">Voce solicitou a recuperacao de senha do painel admin da Lazy Labs. Use o codigo abaixo para continuar:</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<div style="display:inline-block;background:#00f0ff;color:#020208;font-family:monospace;font-size:28px;font-weight:700;letter-spacing:.3em;padding:18px 28px;border-radius:8px">'
    + code
    + '</div></div>'
    + '<p style="margin:24px 0 0 0;font-size:12px;color:#7a7a9a;text-align:center">Valido por 5 minutos. Ignore esta mensagem se voce nao fez a solicitacao.</p>'
    + '</div>'
    + '<div style="border-top:1px solid rgba(0,240,255,.15);padding-top:16px;text-align:center;font-size:10px;color:#4a4a6a">'
    + '<a href="https://example.com" style="color:#00f0ff;text-decoration:none">example.com</a> &nbsp;·&nbsp; <a href="https://blog.example.com" style="color:#00f0ff;text-decoration:none">blog.example.com</a>'
    + '</div></div>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + e.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: [to], subject: subject, html: html })
    });
    const t = await r.text();
    console.log('[admin.reset] Resend HTTP ' + r.status + ' ' + t.slice(0, 200));
    if (!r.ok) return { ok: false, message: 'Resend: HTTP ' + r.status + ' ' + t.slice(0, 200) };
    return { ok: true, sent: true };
  } catch (e) {
    console.error('[admin.reset] Resend erro:', e.message);
    return { ok: false, message: e.message };
  }
}

function genCode_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function genToken_() {
  return crypto.randomBytes(32).toString('hex');
}

// Firestore document path NAO aceita '/', '.', '#', '$', '[', ']'. E-mails tem
// '.' e '@'. Usamos SHA-256 do email como document id (32 chars hex, safe).
function emailDocId_(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex');
}

const DEFAULT_EMAIL = String(process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();

async function getAdminCreds_() {
  const snap = await db().doc('config/admin').get();
  if (!snap.exists) {
    // Cria credenciais default: admin/admin (ambos hashes).
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = sha256_('admin' + salt);
    const doc = {
      email: DEFAULT_EMAIL,
      passwordHash: passHash,
      passwordSalt: salt,
      createdAt: new Date().toISOString()
    };
    await db().doc('config/admin').set(doc);
    return doc;
  }
  return snap.data();
}

async function login_(req, res) {
  const body = readBody_(req);
  const pass = String(body.pass || '');
  if (!pass) { json_(res, 400, { ok: false, message: 'Senha obrigatoria.' }); return; }
  const creds = await getAdminCreds_();
  const hash = sha256_(pass + (creds.passwordSalt || ''));
  if (hash !== creds.passwordHash) {
    json_(res, 401, { ok: false, message: 'Senha incorreta.' });
    return;
  }
  const session = genToken_();
  await db().doc('admin_sessions/' + session).set({
    email: creds.email || DEFAULT_EMAIL,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  });
  json_(res, 200, { ok: true, session: session, email: creds.email });
}

async function reset_(req, res) {
  console.log('[admin.reset] start email=' + req.body && req.body.email);
  const body = readBody_(req);
  const email = String(body.email || '').toLowerCase().trim();
  if (!email) { json_(res, 400, { ok: false, message: 'E-mail obrigatorio.' }); return; }
  const creds = await getAdminCreds_();
  if (email !== (creds.email || '').toLowerCase()) {
    json_(res, 200, { ok: true, message: 'Se o e-mail existir, enviaremos um codigo.' });
    return;
  }
  const code = genCode_();
  const docId = emailDocId_(email);
  console.log('[admin.reset] email=' + email + ' docId=' + docId + ' code=' + code);
  // Path: collection/doc/collection/doc (4 componentes). O email hasheado vira docId
  // da sub-collection 'codes' (1 doc por reset request).
  const path = 'password_resets/' + docId + '/codes/' + code;
  console.log('[admin.reset] writing path=' + path);
  await db().doc(path).set({
    email: email,
    code: code,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    used: false,
    attempts: 0
  });
  console.log('[admin.reset] code saved, sending email to ' + email);
  const emailResult = await sendResetEmail_(email, code);
  console.log('[admin.reset] email result:', JSON.stringify(emailResult));
  // Sempre retorna o codigo (admin precisa pra mostrar no UI). Inclui 'sent' se email foi ok.
  if (emailResult.ok) {
    json_(res, 200, { ok: true, code: code, sent: true, expiresIn: 300 });
  } else if (emailResult.dev) {
    json_(res, 200, { ok: true, code: code, dev: true, expiresIn: 300 });
  } else {
    json_(res, 200, { ok: true, code: code, sent: false, message: emailResult.message, expiresIn: 300 });
  }
}

async function verify_(req, res) {
  let body;
  try { body = readBody_(req); } catch (e) {
    return json_(res, 400, { ok: false, message: 'Body invalido (JSON malformado).' });
  }
  const email = String((body && body.email) || '').toLowerCase().trim();
  const code = String((body && body.code) || '').trim();
  if (!email && !code) {
    return json_(res, 400, { ok: false, message: 'Body vazio. Envie { email, code }.' });
  }
  if (!email) return json_(res, 400, { ok: false, message: 'Campo "email" obrigatorio.' });
  if (!code) return json_(res, 400, { ok: false, message: 'Campo "code" obrigatorio.' });
  if (!/^\d{6}$/.test(code)) {
    return json_(res, 400, { ok: false, message: 'Codigo deve ter 6 digitos numericos.' });
  }
  const docId = emailDocId_(email);

  let codesSnap;
  try {
    codesSnap = await db().collection('password_resets/' + docId + '/codes').get();
  } catch (e) {
    console.error('[verify] firestore error:', e.message);
    return json_(res, 503, { ok: false, message: 'Banco indisponivel, tente novamente.' });
  }

  if (codesSnap.empty) {
    return json_(res, 400, { ok: false, message: 'Nenhum codigo pendente para este e-mail. Solicite um novo reset.' });
  }
  var match = null;
  codesSnap.forEach(function (d) {
    var data = d.data();
    if (!match && data.code === code && !data.used) match = { id: d.id, data: data };
  });
  if (!match) {
    var used = false;
    codesSnap.forEach(function (d) {
      var data = d.data();
      if (data.code === code && data.used) used = true;
    });
    if (used) return json_(res, 400, { ok: false, message: 'Codigo ja utilizado. Solicite um novo reset.' });
    return json_(res, 400, { ok: false, message: 'Codigo invalido.' });
  }
  if (new Date(match.data.expiresAt).getTime() < Date.now()) {
    return json_(res, 400, { ok: false, message: 'Codigo expirado. Solicite um novo reset.' });
  }

  const resetToken = genToken_();
  try {
    await db().doc('reset_sessions/' + resetToken).set({
      email: email,
      code: code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false
    });
    await db().doc('password_resets/' + docId + '/codes/' + match.id).set({
      used: true, usedAt: new Date().toISOString()
    }, { merge: true });
    return json_(res, 200, { ok: true, reset_token: resetToken, expiresIn: 600 });
  } catch (e) {
    console.error('[verify] firestore set error:', e.message);
    return json_(res, 500, { ok: false, message: 'Erro ao processar. Tente novamente.' });
  }
}

async function setNew_(req, res) {
  let body;
  try { body = readBody_(req); } catch (e) {
    return json_(res, 400, { ok: false, message: 'Body invalido (JSON malformado).' });
  }
  const email = String((body && body.email) || '').toLowerCase().trim();
  const code = String((body && body.code) || '').trim();
  const newPass = String((body && body.new_pass) || '');
  const codeLen = newPass.length;
  if (!email && !code && !newPass) {
    return json_(res, 400, { ok: false, message: 'Body vazio. Envie { email, code, new_pass }.' });
  }
  if (!email) return json_(res, 400, { ok: false, message: 'Campo "email" obrigatorio.' });
  if (!code) return json_(res, 400, { ok: false, message: 'Campo "code" (reset_token) obrigatorio.' });
  if (!newPass) return json_(res, 400, { ok: false, message: 'Campo "new_pass" obrigatorio.' });
  if (codeLen < 8) return json_(res, 400, { ok: false, message: 'Nova senha deve ter no minimo 8 caracteres.' });
  if (codeLen > 128) return json_(res, 400, { ok: false, message: 'Nova senha muito longa (max 128 chars).' });

  let resetSnap, rData;
  try {
    const resetRef = db().doc('reset_sessions/' + code);
    resetSnap = await resetRef.get();
  } catch (e) {
    console.error('[setnew] firestore error:', e.message);
    return json_(res, 503, { ok: false, message: 'Banco indisponivel, tente novamente em alguns segundos.' });
  }

  if (!resetSnap.exists) {
    return json_(res, 400, { ok: false, message: 'Token invalido ou ja utilizado. Solicite um novo reset.' });
  }
  rData = resetSnap.data();
  if (rData.email !== email) {
    return json_(res, 400, { ok: false, message: 'Token nao corresponde ao e-mail informado.' });
  }
  if (new Date(rData.expiresAt).getTime() < Date.now()) {
    try { await resetSnap.ref.delete(); } catch (e) {}
    return json_(res, 400, { ok: false, message: 'Token expirado. Solicite um novo reset.' });
  }
  if (rData.used) {
    return json_(res, 400, { ok: false, message: 'Token ja utilizado.' });
  }

  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = sha256_(newPass + salt);
    await db().doc('config/admin').set({
      passwordHash: passwordHash, passwordSalt: salt, updatedAt: new Date().toISOString()
    }, { merge: true });
    await resetSnap.ref.set({ used: true, usedAt: new Date().toISOString() }, { merge: true });
    setTimeout(function () {
      resetSnap.ref.delete().catch(function () {});
    }, 5000);
    return json_(res, 200, { ok: true, message: 'Senha atualizada com sucesso.' });
  } catch (e) {
    console.error('[setnew] update error:', e.message);
    return json_(res, 500, { ok: false, message: 'Erro ao atualizar senha. Tente novamente.' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIREBASE AUTH — usuários reais do admin (substitui a senha única acima).
   requireAdmin_ é exportado pra outras Functions (posts/campaigns/crm/etc.)
   passarem a exigir sessão real em vez de nada ou do header X-LL-Admin
   (que é só uma string fixa, sem verificação nenhuma — qualquer um podia
   mandar). Migração é gradual: o login por senha acima continua no ar.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Verifica Authorization: Bearer <idToken>. Responde 401/403 e retorna null
   se inválido; senão retorna { uid, email, role }. opts.anyRole:true aceita
   qualquer papel definido (admin OU viewer), não só admin. */
async function requireAdmin_(req, res, opts) {
  const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  if (!m) { json_(res, 401, { ok: false, message: 'Authorization: Bearer <idToken> ausente.' }); return null; }
  let decoded;
  try { decoded = await fbAuth().verifyIdToken(m[1].trim(), true); }
  catch (e) { json_(res, 401, { ok: false, message: 'Sessão inválida ou expirada. Faça login novamente.' }); return null; }
  // O dono pode entrar com Google sem depender do bootstrap legado.
  const role = DEFAULT_EMAIL && decoded.email_verified && String(decoded.email || '').toLowerCase() === DEFAULT_EMAIL
    ? 'admin' : (decoded.role || '');
  const okRole = (opts && opts.anyRole) ? (role === 'admin' || role === 'viewer') : role === 'admin';
  if (!okRole) { json_(res, 403, { ok: false, message: role ? 'Ação restrita a administradores.' : 'Sua conta ainda não tem papel definido. Peça pra um admin te configurar.' }); return null; }
  return { uid: decoded.uid, email: decoded.email || '', role: role };
}

function buildInviteEmail_(link, role) {
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#020208;color:#e8e8f5;border-radius:12px">'
    + '<div style="text-align:center;padding:24px 0;border-bottom:1px solid rgba(0,240,255,.15)">'
    + '<div style="font-family:monospace;font-size:22px;font-weight:700;color:#00f0ff;letter-spacing:.05em">[LAZY LABS]</div>'
    + '<div style="font-size:11px;color:#7a7a9a;letter-spacing:.15em;text-transform:uppercase;margin-top:6px">Convite para o admin</div>'
    + '</div>'
    + '<div style="padding:32px 0">'
    + '<p style="margin:0 0 16px 0;line-height:1.6">Você foi convidado a acessar o painel administrativo da Lazy Labs, como <b>' + (role === 'admin' ? 'administrador' : 'visualizador') + '</b>.</p>'
    + '<p style="margin:0 0 24px 0;line-height:1.6">Clique no botão abaixo para definir sua senha e entrar (também dá pra entrar direto com Google, se preferir):</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + link + '" style="display:inline-block;background:linear-gradient(120deg,#00f0ff,#a855f7);color:#04040c;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:11px">Definir senha e entrar</a>'
    + '</div>'
    + '<p style="margin:24px 0 0 0;font-size:12px;color:#7a7a9a;text-align:center">Se você não esperava este convite, ignore este e-mail.</p>'
    + '</div>'
    + '<div style="border-top:1px solid rgba(0,240,255,.15);padding-top:16px;text-align:center;font-size:10px;color:#4a4a6a">'
    + '<a href="https://example.com" style="color:#00f0ff;text-decoration:none">example.com</a> &nbsp;·&nbsp; <a href="https://blog.example.com" style="color:#00f0ff;text-decoration:none">blog.example.com</a>'
    + '</div></div>';
}

async function listUsers_(req, res) {
  const user = await requireAdmin_(req, res); if (!user) return;
  const result = await fbAuth().listUsers(1000);
  const users = result.users.map(function (u) {
    return {
      uid: u.uid,
      email: u.email || '',
      role: (u.customClaims && u.customClaims.role) || '',
      provider: (u.providerData[0] && u.providerData[0].providerId) || 'password',
      createdAt: u.metadata.creationTime,
      lastLoginAt: u.metadata.lastSignInTime || null,
      disabled: !!u.disabled
    };
  });
  json_(res, 200, { ok: true, users: users });
}

async function inviteUser_(req, res) {
  const user = await requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const email = String(body.email || '').trim().toLowerCase();
  const role = body.role === 'viewer' ? 'viewer' : 'admin';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { json_(res, 400, { ok: false, message: 'E-mail inválido.' }); return; }

  let target;
  try { target = await fbAuth().getUserByEmail(email); }
  catch (e) { target = await fbAuth().createUser({ email: email, emailVerified: false }); }
  await fbAuth().setCustomUserClaims(target.uid, { role: role });

  let link;
  try { link = await fbAuth().generatePasswordResetLink(email, { url: 'https://blog.example.com/admin/' }); }
  catch (e) { json_(res, 200, { ok: true, uid: target.uid, emailSent: false, message: 'Usuário criado, mas não gerei o link de senha: ' + e.message }); return; }

  // Reaproveita config/form.email (mesma key do Resend ja usada por leads/newsletter/devops).
  const formSnap = await db().doc('config/form').get();
  const e = (formSnap.exists && formSnap.data().email) || {};
  let emailSent = false;
  if (e.resendKey) {
    const from = e.fromEmail ? ((e.fromName || 'Lazy Labs') + ' <' + e.fromEmail + '>') : 'Lazy Labs <onboarding@resend.dev>';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + e.resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, to: [email], subject: 'Você foi convidado pro admin da Lazy Labs', html: buildInviteEmail_(link, role) })
      });
      emailSent = r.ok;
    } catch (_) {}
  }
  json_(res, 200, { ok: true, uid: target.uid, emailSent: emailSent, link: emailSent ? undefined : link });
}

async function removeUser_(req, res) {
  const user = await requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const uid = String(body.uid || '').trim();
  if (!uid) { json_(res, 400, { ok: false, message: 'uid obrigatório.' }); return; }
  if (uid === user.uid) { json_(res, 400, { ok: false, message: 'Você não pode remover a própria conta.' }); return; }
  await fbAuth().deleteUser(uid);
  json_(res, 200, { ok: true });
}

async function profile_(req, res) {
  const user = await requireAdmin_(req, res, { anyRole: true }); if (!user) return;
  const body = readBody_(req);
  const patch = {};
  if (body.email) patch.email = String(body.email).trim().toLowerCase();
  if (body.new_pass) {
    if (String(body.new_pass).length < 8) { json_(res, 400, { ok: false, message: 'Nova senha deve ter no mínimo 8 caracteres.' }); return; }
    patch.password = String(body.new_pass);
  }
  if (!Object.keys(patch).length) { json_(res, 400, { ok: false, message: 'Nada para atualizar.' }); return; }
  await fbAuth().updateUser(user.uid, patch);
  json_(res, 200, { ok: true });
}

/* Promove um e-mail a admin (custom claim). Protegido por secret de .env,
   não por login — é o jeito de criar o PRIMEIRO admin (ovo-e-galinha: sem
   isso, ninguém tem role pra convidar ninguém). O usuário precisa já ter
   feito login uma vez (Google ou senha) pro registro existir no Auth.
   Chamar manualmente 1x via curl; idempotente, sem problema deixar no ar. */
async function bootstrap_(req, res) {
  const body = readBody_(req);
  if (!process.env.ADMIN_BOOTSTRAP_SECRET || body.secret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
    json_(res, 401, { ok: false, message: 'unauthorized' }); return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) { json_(res, 400, { ok: false, message: 'email obrigatório.' }); return; }
  let target;
  try { target = await fbAuth().getUserByEmail(email); }
  catch (e) { json_(res, 404, { ok: false, message: 'Esse e-mail ainda não tem conta no Firebase Auth. Faça login (Google ou senha) uma vez no admin primeiro.' }); return; }
  await fbAuth().setCustomUserClaims(target.uid, { role: 'admin' });
  json_(res, 200, { ok: true, uid: target.uid, email: target.email, role: 'admin' });
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  // Roteamento por path.
  const path = (req.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const action = path.split('/').pop() || 'login';
  try {
    // A senha única e o reset antigo não dão acesso seguro às demais Functions.
    if (['login', 'reset', 'verify', 'setnew', 'bootstrap'].includes(action)) {
      json_(res, 410, { ok: false, message: 'Fluxo desativado. Entre com Google.' }); return;
    }
    if (action === 'session' && req.method === 'GET') {
      const user = await requireAdmin_(req, res);
      if (user) json_(res, 200, { ok: true, user: user });
      return;
    }
    if (action === 'setresend' && req.method === 'POST') return setResend_(req, res);
    if (action === 'listUsers' && req.method === 'GET') return listUsers_(req, res);
    if (action === 'inviteUser' && req.method === 'POST') return inviteUser_(req, res);
    if (action === 'removeUser' && req.method === 'POST') return removeUser_(req, res);
    if (action === 'profile' && req.method === 'POST') return profile_(req, res);
    json_(res, 404, { ok: false, message: 'Ação desconhecida: ' + action });
  } catch (e) {
    console.error('[admin]', action, e);
    json_(res, 500, { ok: false, message: (e && e.message) || 'Erro interno.' });
  }
}

async function setResend_(req, res) {
  const user = await requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const key = String(body.resendKey || '').trim();
  const fromEmail = String(body.fromEmail || '').trim();
  const fromName = String(body.fromName || 'Lazy Labs').trim();
  if (!key || !key.startsWith('re_')) {
    json_(res, 400, { ok: false, message: 'resendKey invalida (deve comecar com re_).' });
    return;
  }
  const ref = db().doc('config/email');
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  await ref.set(Object.assign({}, cur, {
    resendKey: key,
    fromEmail: fromEmail,
    fromName: fromName,
    enabled: true,
    updatedAt: new Date().toISOString()
  }), { merge: true });
  json_(res, 200, { ok: true, message: 'Resend key salva em config/email.' });
}

module.exports = { handler, requireAdmin_ };
