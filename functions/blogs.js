/**
 * Lazy Labs — gestão de blogs (workspaces multi-tenant).
 * Endpoint: /api/blogs/<action> — todas as ações exigem sessão admin (Firebase Auth,
 * Authorization: Bearer <idToken>, via requireAdmin_ de admin.js).
 *   - list   (GET)                          → lista todos os blogs
 *   - create (POST {name, domain, theme?})  → cria (id = slug do nome)
 *   - update (POST {id, ...campos})         → edita (name/domain/logo_url/cover_url/theme/seo/settings/status)
 *   - delete (POST {id})                    → remove (bloqueia se tiver artigos, ou se for o principal)
 *
 * Schema de blogs/{id}: name, domain, logo_url, cover_url, theme{primary,secondary,bg,fg}, seo{},
 * settings{timezone,default_lang}, status, hosting_status, createdAt, updatedAt, createdBy.
 * `list` enriquece cada blog com `stats{posts,views,subscribers}` (calculado on-the-fly).
 */
const { getFirestore } = require('firebase-admin/firestore');
const dns = require('dns').promises;
const adminModule = require('./admin');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

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
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'blog';
}

const DEFAULT_THEME = { primary: '#00f0ff', secondary: '#a855f7', bg: '#020208', fg: '#e8e8f5' };

// Estatisticas leves por blog (posts, views somadas, inscritos). Busca com field-mask
// (so os campos que interessam) e soma em codigo — aggregate({sum}) do Firestore exige
// indice composto proprio (descoberto testando em produção); com o volume atual (dezenas
// de docs) o fetch+soma em JS e mais simples e nao depende de indice nenhum.
async function blogStats_(id) {
  try {
    const [postsSnap, subsSnap] = await Promise.all([
      db().collection('posts').where('blog_id', '==', id).select('view_count').get(),
      db().collection('newsletter_subscribers').where('blog_id', '==', id).select().get()
    ]);
    let views = 0; postsSnap.forEach(function (d) { views += Number(d.data().view_count) || 0; });
    return { posts: postsSnap.size, views: views, subscribers: subsSnap.size };
  } catch (err) {
    console.error('[blogs] stats fail for', id, err.message);
    return { posts: 0, views: 0, subscribers: 0 };
  }
}

async function listBlogs_(req, res) {
  const user = await adminModule.requireAdmin_(req, res, { anyRole: true }); if (!user) return;
  const snap = await db().collection('blogs').orderBy('createdAt', 'desc').get();
  const blogs = await Promise.all(snap.docs.map(async function (d) {
    const b = Object.assign({ id: d.id }, d.data());
    b.stats = await blogStats_(d.id);
    return b;
  }));
  json_(res, 200, { ok: true, blogs: blogs });
}

async function createBlog_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const name = String(body.name || '').trim().slice(0, 120);
  const domain = String(body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 200);
  if (!name || !domain) { json_(res, 200, { ok: false, message: 'Nome e domínio são obrigatórios.' }); return; }
  let id = slugify_(name);
  const existing = await db().doc('blogs/' + id).get();
  if (existing.exists) id = id + '-' + Date.now().toString(36).slice(-4);
  const doc = {
    name: name, domain: domain, logo_url: String(body.logo_url || ''), cover_url: String(body.cover_url || ''),
    theme: Object.assign({}, DEFAULT_THEME, body.theme || {}),
    seo: body.seo || {}, settings: { timezone: 'America/Sao_Paulo', default_lang: 'pt-BR' },
    status: 'setup', hosting_status: 'not_connected',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: user.email
  };
  await db().doc('blogs/' + id).set(doc);
  json_(res, 201, { ok: true, blog: Object.assign({ id: id }, doc) });
}

async function updateBlog_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  const ref = db().doc('blogs/' + id);
  const snap = await ref.get();
  if (!snap.exists) { json_(res, 200, { ok: false, message: 'Blog não encontrado.' }); return; }
  const allowed = ['name', 'domain', 'logo_url', 'cover_url', 'theme', 'seo', 'settings', 'status', 'hosting_status'];
  const patch = { updatedAt: new Date().toISOString() };
  allowed.forEach(function (k) { if (body[k] !== undefined) patch[k] = body[k]; });
  await ref.set(patch, { merge: true });
  const updated = await ref.get();
  json_(res, 200, { ok: true, blog: Object.assign({ id: id }, updated.data()) });
}

async function deleteBlog_(req, res) {
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;
  const body = readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  if (id === 'your-blog') { json_(res, 200, { ok: false, message: 'Este é o blog principal — não pode ser removido por aqui.' }); return; }
  const postsSnap = await db().collection('posts').where('blog_id', '==', id).limit(1).get();
  if (!postsSnap.empty) { json_(res, 200, { ok: false, message: 'Este blog tem artigos. Mova ou exclua os artigos antes de remover o blog.' }); return; }
  await db().doc('blogs/' + id).delete();
  json_(res, 200, { ok: true });
}

// Diagnóstico de DNS do domínio do blog — resolve A/AAAA/CNAME/TXT e dá um palpite
// se já aponta pro Firebase Hosting. Não é a verificação oficial do Firebase (que exige
// registrar o domínio via Hosting API — fase futura); é um raio-x honesto do apontamento atual.
const FIREBASE_HOSTING_IPS = ['151.101.1.195', '151.101.65.195', '199.36.158.100'];
async function verifyDomain_(req, res) {
  const user = await adminModule.requireAdmin_(req, res, { anyRole: true }); if (!user) return;
  const body = req.method === 'GET' ? (req.query || {}) : readBody_(req);
  const id = String(body.id || '').trim();
  if (!id) { json_(res, 200, { ok: false, message: 'id obrigatório.' }); return; }
  const ref = db().doc('blogs/' + id);
  const snap = await ref.get();
  if (!snap.exists) { json_(res, 200, { ok: false, message: 'Blog não encontrado.' }); return; }
  const domain = String((snap.data() || {}).domain || '').trim();
  if (!domain) { json_(res, 200, { ok: false, message: 'Este blog não tem domínio configurado.' }); return; }

  const records = { a: [], aaaa: [], cname: [], txt: [] };
  let resolves = false;
  await Promise.all([
    dns.resolve4(domain).then(function (r) { records.a = r; resolves = true; }).catch(function () {}),
    dns.resolve6(domain).then(function (r) { records.aaaa = r; resolves = true; }).catch(function () {}),
    dns.resolveCname(domain).then(function (r) { records.cname = r; resolves = true; }).catch(function () {}),
    dns.resolveTxt(domain).then(function (r) { records.txt = r.map(function (parts) { return parts.join(''); }); }).catch(function () {})
  ]);

  const pointsAtFirebase = records.a.some(function (ip) { return FIREBASE_HOSTING_IPS.indexOf(ip) !== -1; })
    || records.cname.some(function (c) { return /\.web\.app$|\.firebaseapp\.com$|ghs\.googlehosted\.com$/i.test(c); });

  let hostingStatus = 'not_resolving';
  if (pointsAtFirebase) hostingStatus = 'connected';
  else if (resolves) hostingStatus = 'dns_found_not_firebase';

  await ref.set({ hosting_status: hostingStatus, hosting_checked_at: new Date().toISOString() }, { merge: true });
  json_(res, 200, { ok: true, domain: domain, records: records, resolves: resolves, hosting_status: hostingStatus });
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
  try {
    if (action === 'list') return listBlogs_(req, res);
    if (action === 'create') return createBlog_(req, res);
    if (action === 'update') return updateBlog_(req, res);
    if (action === 'delete') return deleteBlog_(req, res);
    if (action === 'verifyDomain') return verifyDomain_(req, res);
    json_(res, 404, { ok: false, message: 'rota desconhecida: ' + action });
  } catch (err) {
    console.error('[blogs]', action, err);
    json_(res, 500, { ok: false, message: err.message });
  }
}

module.exports = { handler: handler };
