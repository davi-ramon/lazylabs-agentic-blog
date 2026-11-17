/**
 * Lazy Labs — API REST oficial (v1).
 *
 * Endpoints:
 *   GET    /v1/blogs                       Lista blogs
 *   GET    /v1/blogs/:id                   Detalhe
 *   POST   /v1/blogs                       Cria blog (admin)
 *   PATCH  /v1/blogs/:id                   Atualiza
 *   DELETE /v1/blogs/:id                   Remove
 *
 *   GET    /v1/posts                       Lista posts (filtra por blogId do token)
 *   GET    /v1/posts/:id                   Detalhe
 *   GET    /v1/blogs/:blogId/posts         Lista posts de um blog
 *   POST   /v1/posts                       Cria rascunho
 *   PATCH  /v1/posts/:id                   Atualiza
 *   DELETE /v1/posts/:id                   Remove
 *   POST   /v1/posts/:id/publish           Publica
 *   POST   /v1/posts/:id/schedule          Agenda (set status + scheduled_at)
 *   POST   /v1/posts/:id/archive           Arquiva
 *
 *   GET    /v1/newsletter/subscribers
 *   POST   /v1/newsletter/subscribers
 *   GET    /v1/newsletter/campaigns
 *   POST   /v1/newsletter/campaigns
 *
 *   GET    /v1/integrations
 *   POST   /v1/integrations
 *
 *   GET    /v1/webhooks
 *   POST   /v1/webhooks
 *   PATCH  /v1/webhooks/:id
 *   DELETE /v1/webhooks/:id
 *
 *   POST   /v1/tokens                     Gera novo token (admin:all)
 *   GET    /v1/tokens                     Lista tokens existentes (preview)
 *   DELETE /v1/tokens/:id                 Revoga
 *
 * Auth: Authorization: Bearer <token>. Token hasheado (SHA-256) em Firestore.
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SUPABASE_URL_DEFAULT = 'https://your-supabase-project.supabase.co';

function json_(res, status, obj) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(obj));
}

function setCors_(req, res) {
  const origin = req.headers.origin || req.headers.Origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LL-Admin');
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

function generateToken_() {
  // 132 caracteres: 64 bytes randomicos em base64url (~86 chars) + prefixo legivel "llk_".
  const raw = crypto.randomBytes(96).toString('base64url');
  return 'llk_' + raw.slice(0, 128); // 132 chars
}

/* ─── Auth ─── */

async function authMiddleware_(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, message: 'Authorization: Bearer <token> ausente.' };
  const raw = m[1].trim();
  if (!raw) return { ok: false, status: 401, message: 'Token vazio.' };
  const hash = sha256_(raw);
  const snap = await db().collection('api_tokens').where('hash', '==', hash).limit(1).get();
  if (snap.empty) return { ok: false, status: 401, message: 'Token invalido.' };
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.revoked) return { ok: false, status: 401, message: 'Token revogado.' };
  if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
    return { ok: false, status: 401, message: 'Token expirado.' };
  }
  // Atualiza lastUsedAt (best-effort, sem bloquear).
  doc.ref.update({ lastUsedAt: new Date().toISOString() }).catch(function () {});
  return {
    ok: true,
    token: { id: doc.id, label: data.label, scopes: data.scopes || [], blogIds: data.blogIds || '*' }
  };
}

function hasScope_(token, scope) {
  if (!token) return false;
  const scopes = token.scopes || [];
  return scopes.indexOf('admin:all') !== -1 || scopes.indexOf(scope) !== -1;
}

function ensureScope_(res, token, scope) {
  if (!hasScope_(token, scope)) {
    json_(res, 403, { ok: false, message: 'Sem permissao: ' + scope });
    return false;
  }
  return true;
}

function blogAllowed_(token, blogId) {
  if (!token) return false;
  if (token.blogIds === '*' || (Array.isArray(token.blogIds) && token.blogIds.indexOf('*') !== -1)) return true;
  return Array.isArray(token.blogIds) && token.blogIds.indexOf(blogId) !== -1;
}

/* ─── Logger ─── */

async function logRequest_(req, res, token, route, method, status, latencyMs) {
  try {
    await db().collection('api_logs').add({
      tokenId: token ? token.id : null,
      route: route,
      method: method,
      status: status,
      latencyMs: latencyMs,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || null,
      userAgent: req.headers['user-agent'] || null,
      timestamp: new Date().toISOString()
    });
  } catch (e) { /* silencioso */ }
}

/* ─── Supabase (posts, newsletter) ─── */

async function sbReq_(serviceKey, path, method, body) {
  const url = SUPABASE_URL_DEFAULT + '/rest/v1/' + path;
  const r = await fetch(url, {
    method: method,
    headers: {
      'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      'Prefer': method === 'GET' ? 'count=exact' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, raw: t };
}

async function getSupabaseKey_() {
  const s = await db().doc('config/supabase').get();
  return (s.exists && s.data().serviceKey) || '';
}

/* ─── Helpers de rota ─── */

function parseRoute_(path) {
  // path exemplo: "/v1/posts/abc123/publish" -> ["v1","posts","abc123","publish"]
  return path.split('/').filter(Boolean);
}

/* ─── Handlers por recurso ─── */

async function listBlogs_(token) {
  const snap = await db().collection('blogs').orderBy('createdAt', 'desc').get();
  const rows = [];
  snap.forEach(function (d) {
    const data = d.data();
    if (blogAllowed_(token, d.id)) rows.push(Object.assign({ id: d.id }, data));
  });
  return { ok: true, blogs: rows };
}

async function getBlog_(id) {
  const snap = await db().doc('blogs/' + id).get();
  if (!snap.exists) return { ok: false, status: 404, message: 'Blog nao encontrado.' };
  return { ok: true, blog: Object.assign({ id: id }, snap.data()) };
}

async function createBlog_(body) {
  if (!body.name || !body.domain) {
    return { ok: false, status: 400, message: 'name e domain sao obrigatorios.' };
  }
  const ref = db().collection('blogs').doc();
  const doc = {
    name: String(body.name).slice(0, 120),
    domain: String(body.domain).slice(0, 200),
    logo_url: String(body.logo_url || ''),
    theme: body.theme || { primary: '#00f0ff', secondary: '#a855f7', bg: '#020208', fg: '#e8e8f5' },
    seo: body.seo || {},
    settings: body.settings || { timezone: 'America/Sao_Paulo', default_lang: 'pt-BR' },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await ref.set(doc);
  return { ok: true, blog: Object.assign({ id: ref.id }, doc) };
}

async function updateBlog_(id, body) {
  const allowed = ['name', 'domain', 'logo_url', 'theme', 'seo', 'settings', 'status'];
  const upd = { updatedAt: new Date().toISOString() };
  allowed.forEach(function (k) { if (body[k] !== undefined) upd[k] = body[k]; });
  await db().doc('blogs/' + id).set(upd, { merge: true });
  const snap = await db().doc('blogs/' + id).get();
  return { ok: true, blog: Object.assign({ id: id }, snap.data()) };
}

async function deleteBlog_(id) {
  await db().doc('blogs/' + id).delete();
  return { ok: true };
}

async function listPosts_(token, blogId, status) {
  const supabaseKey = await getSupabaseKey_();
  if (!supabaseKey) return { ok: false, status: 503, message: 'Supabase nao configurado.' };
  const params = [];
  if (blogId) params.push('blog_id=eq.' + encodeURIComponent(blogId));
  if (status) params.push('status=eq.' + status);
  params.push('order=published_at.desc');
  params.push('limit=50');
  const r = await sbReq_(supabaseKey, 'posts?' + params.join('&'), 'GET');
  if (!r.ok) return { ok: false, status: r.status, message: r.body && r.body.message || 'Supabase falhou.' };
  // Filtra blogs permitidos pelo token.
  let posts = r.body || [];
  if (token && token.blogIds !== '*' && Array.isArray(token.blogIds)) {
    posts = posts.filter(function (p) { return token.blogIds.indexOf(p.blog_id) !== -1; });
  }
  return { ok: true, posts: posts };
}

async function getPost_(id) {
  const supabaseKey = await getSupabaseKey_();
  const r = await sbReq_(supabaseKey, 'posts?id=eq.' + encodeURIComponent(id) + '&limit=1', 'GET');
  if (!r.ok || !r.body || !r.body.length) return { ok: false, status: 404, message: 'Post nao encontrado.' };
  return { ok: true, post: r.body[0] };
}

async function createPost_(body, token) {
  const supabaseKey = await getSupabaseKey_();
  if (!supabaseKey) return { ok: false, status: 503, message: 'Supabase nao configurado.' };
  if (!body.blog_id) return { ok: false, status: 400, message: 'blog_id obrigatorio.' };
  if (!blogAllowed_(token, body.blog_id)) {
    return { ok: false, status: 403, message: 'Token nao tem permissao neste blog.' };
  }
  const row = {
    title: String(body.title || '').slice(0, 300),
    slug: String(body.slug || '').slice(0, 200),
    excerpt: String(body.excerpt || ''),
    content: String(body.content || ''),
    category: String(body.category || ''),
    tags: Array.isArray(body.tags) ? body.tags : [],
    status: String(body.status || 'draft'),
    author_name: String(body.author_name || 'Davi Blogger'),
    reading_time: parseInt(body.reading_time, 10) || 5,
    cover_url: String(body.cover_url || ''),
    seo_title: String(body.seo_title || body.title || ''),
    seo_description: String(body.seo_description || body.excerpt || ''),
    cta_label: String(body.cta_label || 'Quero algo parecido'),
    cta_url: String(body.cta_url || 'https://example.com/form-diagnostico'),
    blog_id: body.blog_id,
    published_at: body.status === 'published' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };
  const r = await sbReq_(supabaseKey, 'posts?on_conflict=slug', 'POST', row);
  if (!r.ok) return { ok: false, status: r.status, message: (r.body && (r.body.message || r.body.hint)) || 'Supabase falhou.' };
  return { ok: true, post: (r.body && r.body[0]) || null, slug: row.slug };
}

async function updatePost_(id, body) {
  const supabaseKey = await getSupabaseKey_();
  const allowed = ['title', 'slug', 'excerpt', 'content', 'category', 'tags', 'status', 'cover_url', 'seo_title', 'seo_description', 'cta_label', 'cta_url'];
  const upd = { updated_at: new Date().toISOString() };
  allowed.forEach(function (k) { if (body[k] !== undefined) upd[k] = body[k]; });
  if (body.status === 'published' && !body.published_at) upd.published_at = new Date().toISOString();
  const r = await sbReq_(supabaseKey, 'posts?id=eq.' + encodeURIComponent(id), 'PATCH', upd);
  if (!r.ok) return { ok: false, status: r.status, message: 'Supabase falhou.' };
  return { ok: true };
}

async function setPostStatus_(id, status) {
  return updatePost_(id, { status: status });
}

async function deletePost_(id) {
  const supabaseKey = await getSupabaseKey_();
  const r = await sbReq_(supabaseKey, 'posts?id=eq.' + encodeURIComponent(id), 'DELETE');
  return { ok: r.ok, status: r.status };
}

async function listSubscribers_() {
  const supabaseKey = await getSupabaseKey_();
  const r = await sbReq_(supabaseKey, 'newsletter_subscribers?select=email,first_name,last_name,nickname,source,subscribed_at&order=subscribed_at.desc&limit=100', 'GET');
  if (!r.ok) return { ok: false, status: r.status, message: 'Supabase falhou.' };
  return { ok: true, subscribers: r.body || [] };
}

async function listIntegrations_() {
  const snap = await db().collection('integrations').orderBy('createdAt', 'desc').get();
  const rows = [];
  snap.forEach(function (d) {
    const data = d.data();
    if (data.access_token) data.access_token = '••••••••';
    if (data.secret) data.secret = '••••••••';
    rows.push(Object.assign({ id: d.id }, data));
  });
  return { ok: true, integrations: rows };
}

async function listWebhooks_() {
  const snap = await db().collection('webhooks').orderBy('createdAt', 'desc').get();
  const rows = [];
  snap.forEach(function (d) {
    const data = d.data();
    if (data.secret) data.secret = '••••••••';
    rows.push(Object.assign({ id: d.id }, data));
  });
  return { ok: true, webhooks: rows };
}

async function listTokens_() {
  const snap = await db().collection('api_tokens').orderBy('createdAt', 'desc').get();
  const rows = [];
  snap.forEach(function (d) {
    const data = d.data();
    if (data.hash) delete data.hash;
    rows.push(Object.assign({ id: d.id }, data));
  });
  return { ok: true, tokens: rows };
}

async function createToken_(body) {
  const label = String(body.label || 'Token sem rotulo').slice(0, 60);
  const scopes = Array.isArray(body.scopes) ? body.scopes : ['posts:read'];
  const blogIds = body.blogIds || '*';
  const raw = generateToken_();
  const hash = sha256_(raw);
  const ref = db().collection('api_tokens').doc();
  const doc = {
    label: label, scopes: scopes, blogIds: blogIds, hash: hash,
    prefix: raw.slice(0, 8),
    revoked: false,
    createdAt: new Date().toISOString(),
    createdBy: 'admin'
  };
  await ref.set(doc);
  return { ok: true, token: Object.assign({ id: ref.id, raw: raw }, doc) };
}

async function revokeToken_(id) {
  await db().doc('api_tokens/' + id).set({ revoked: true, revokedAt: new Date().toISOString() }, { merge: true });
  return { ok: true };
}

/* ─── Router principal ─── */

async function handleApi_(req, res) {
  const startedAt = Date.now();
  let route = (req.path || '').replace(/^\/+/, '');
  // Rewrite do Firebase Hosting pode mandar "/api/v1/...". Aceitar os dois.
  if (route.indexOf('api/v1/') === 0) route = route.slice(3); // remove "api"
  if (route.indexOf('api/v1') === 0 && route.length === 6) route = 'v1'; // raiz "/api/v1"
  const parts = parseRoute_(route); // ["v1","posts","abc","publish"]
  const version = parts[0];
  const resource = parts[1];
  const id = parts[2];
  const action = parts[3];
  const method = req.method.toUpperCase();
  let token = null;
  let status = 200;
  let result = null;

  try {
    // Endpoint publico: GET /v1/health
    if (resource === 'health' && method === 'GET') {
      result = { ok: true, service: 'lazylabs-api', version: 'v1', time: new Date().toISOString() };
    } else if (version === 'v1') {
      // Auth (exceto health).
      const auth = await authMiddleware_(req);
      if (!auth.ok) { status = auth.status; result = { ok: false, message: auth.message }; }
      else {
        token = auth.token;
        result = await dispatchV1_(method, resource, id, action, req, res, token);
        status = res.statusCode || 200;
      }
    } else {
      result = { ok: false, message: 'Rota desconhecida. Use /v1/...' };
      status = 404;
    }
  } catch (e) {
    console.error('[api] erro:', e);
    status = 500;
    result = { ok: false, message: (e && e.message) || 'Erro interno.' };
  }

  if (result === null) return; // response ja foi enviada

  // Loga a requisicao.
  logRequest_(req, res, token, route, method, status, Date.now() - startedAt).catch(function () {});

  if (!res.headersSent) json_(res, status, result);
}

async function dispatchV1_(method, resource, id, action, req, res, token) {
  // /v1/blogs
  if (resource === 'blogs') {
    if (method === 'GET' && !id) {
      if (!ensureScope_(res, token, 'blogs:read')) return null;
      return await listBlogs_(token);
    }
    if (method === 'GET' && id && !action) {
      if (!blogAllowed_(token, id)) return { ok: false, status: 403, message: 'Sem permissao neste blog.' };
      if (!ensureScope_(res, token, 'blogs:read')) return null;
      return await getBlog_(id);
    }
    if (method === 'GET' && id && action === 'posts') {
      if (!blogAllowed_(token, id)) return { ok: false, status: 403, message: 'Sem permissao neste blog.' };
      if (!ensureScope_(res, token, 'posts:read')) return null;
      return await listPosts_(token, id);
    }
    if (method === 'POST') {
      if (!ensureScope_(res, token, 'blogs:write')) return null;
      const body = readBody_(req);
      res.statusCode = 201;
      return await createBlog_(body);
    }
    if (method === 'PATCH' && id) {
      if (!ensureScope_(res, token, 'blogs:write')) return null;
      return await updateBlog_(id, readBody_(req));
    }
    if (method === 'DELETE' && id) {
      if (!ensureScope_(res, token, 'blogs:write')) return null;
      return await deleteBlog_(id);
    }
  }

  // /v1/posts
  if (resource === 'posts') {
    if (method === 'GET' && !id) {
      if (!ensureScope_(res, token, 'posts:read')) return null;
      const body = readBody_(req);
      return await listPosts_(token, body.blog_id, body.status);
    }
    if (method === 'GET' && id && !action) {
      if (!ensureScope_(res, token, 'posts:read')) return null;
      return await getPost_(id);
    }
    if (method === 'POST' && !action) {
      if (!ensureScope_(res, token, 'posts:write')) return null;
      const body = readBody_(req);
      res.statusCode = 201;
      return await createPost_(body, token);
    }
    if (method === 'PATCH' && id && !action) {
      if (!ensureScope_(res, token, 'posts:write')) return null;
      return await updatePost_(id, readBody_(req));
    }
    if (method === 'DELETE' && id) {
      if (!ensureScope_(res, token, 'posts:delete')) return null;
      return await deletePost_(id);
    }
    if (method === 'POST' && id && action === 'publish') {
      if (!ensureScope_(res, token, 'posts:write')) return null;
      return await setPostStatus_(id, 'published');
    }
    if (method === 'POST' && id && action === 'archive') {
      if (!ensureScope_(res, token, 'posts:write')) return null;
      return await setPostStatus_(id, 'archived');
    }
    if (method === 'POST' && id && action === 'schedule') {
      if (!ensureScope_(res, token, 'posts:write')) return null;
      const body = readBody_(req);
      const when = body.scheduled_at || new Date(Date.now() + 3600000).toISOString();
      return await updatePost_(id, { status: 'scheduled', scheduled_at: when });
    }
  }

  // /v1/newsletter/*
  if (resource === 'newsletter') {
    if (id === 'subscribers' && method === 'GET') {
      if (!ensureScope_(res, token, 'newsletter:read')) return null;
      return await listSubscribers_();
    }
    if (id === 'campaigns' && method === 'GET') {
      if (!ensureScope_(res, token, 'newsletter:read')) return null;
      // Lista campanhas do Firestore.
      const snap = await db().collection('campaigns').orderBy('createdAt', 'desc').limit(50).get();
      const rows = [];
      snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
      return { ok: true, campaigns: rows };
    }
    if (id === 'campaigns' && method === 'POST') {
      if (!ensureScope_(res, token, 'newsletter:write')) return null;
      // Disparar newsletter: chama /api/campaigns/dispatch
      const body = readBody_(req);
      const r = await fetch(SUPABASE_URL_DEFAULT.replace('rest/v1', 'functions/v1') + '/campaigns/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      return d.ok ? { ok: true, result: d } : { ok: false, message: d.message || 'Erro' };
    }
  }

  // /v1/integrations
  if (resource === 'integrations') {
    if (method === 'GET') {
      if (!ensureScope_(res, token, 'integrations:read')) return null;
      return await listIntegrations_();
    }
    if (method === 'POST') {
      if (!ensureScope_(res, token, 'integrations:write')) return null;
      const body = readBody_(req);
      const ref = db().collection('integrations').doc();
      await ref.set(Object.assign({}, body, { createdAt: new Date().toISOString() }));
      return { ok: true, integration: { id: ref.id } };
    }
  }

  // /v1/webhooks
  if (resource === 'webhooks') {
    if (method === 'GET' && !id) {
      if (!ensureScope_(res, token, 'webhooks:read')) return null;
      return await listWebhooks_();
    }
    if (method === 'POST' && !id) {
      if (!ensureScope_(res, token, 'webhooks:write')) return null;
      const body = readBody_(req);
      const ref = db().collection('webhooks').doc();
      await ref.set(Object.assign({}, body, {
        active: body.active !== false,
        createdAt: new Date().toISOString(),
        retries: body.retries || 3
      }));
      return { ok: true, webhook: { id: ref.id } };
    }
    if (method === 'PATCH' && id) {
      if (!ensureScope_(res, token, 'webhooks:write')) return null;
      await db().doc('webhooks/' + id).set(readBody_(req), { merge: true });
      return { ok: true };
    }
    if (method === 'DELETE' && id) {
      if (!ensureScope_(res, token, 'webhooks:write')) return null;
      await db().doc('webhooks/' + id).delete();
      return { ok: true };
    }
  }

  // /v1/tokens (admin)
  if (resource === 'tokens') {
    if (method === 'GET' && !id) {
      if (!ensureScope_(res, token, 'admin:all')) return null;
      return await listTokens_();
    }
    if (method === 'POST' && !id) {
      if (!ensureScope_(res, token, 'admin:all')) return null;
      const body = readBody_(req);
      res.statusCode = 201;
      return await createToken_(body);
    }
    if (method === 'DELETE' && id) {
      if (!ensureScope_(res, token, 'admin:all')) return null;
      return await revokeToken_(id);
    }
  }

  return { ok: false, status: 404, message: 'Rota nao encontrada: ' + method + ' /v1/' + resource + (id ? '/:id' : '') + (action ? '/' + action : '') };
}

async function handler(req, res) {
  // API v1 e ponte Apps Script não têm clientes ativos e mantêm caminhos
  // antigos de escrita fora da autenticação Firebase. Reabrir só após migração.
  json_(res, 410, { ok: false, message: 'API legada desativada.' });
}

async function proxyLegacy_(req, res) {
  const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_APPS_SCRIPT_DEPLOYMENT_ID/exec';
  try {
    const body = readBody_(req);
    const qs = req.url && req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const fetchUrl = APPS_SCRIPT_URL + (qs ? '?' + qs : '');
    const r = await fetch(fetchUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      redirect: 'follow'
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (_) {}
    if (j !== null) {
      if (!res.headersSent) json_(res, r.status || 200, j);
      return;
    }
    if (!res.headersSent) {
      res.set('Content-Type', r.headers.get('content-type') || 'text/html; charset=utf-8');
      res.status(r.status || 502).send(t);
    }
  } catch (e) {
    if (!res.headersSent) json_(res, 502, { ok: false, message: (e && e.message) || 'Proxy falhou.' });
  }
}

module.exports = { handler };
