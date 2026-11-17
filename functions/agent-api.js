'use strict';

// API de operação editorial independente de provedor de LLM. Os segredos de
// agentes são emitidos apenas por um administrador Firebase e nunca são salvos
// em texto puro. Os handlers existentes continuam sendo a fonte de validação.
const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');
const { requireAdmin_ } = require('./admin');
const LazyMedia = require('./media-providers');

const BLOG_ID = 'lazylabs-blog';
const SCOPES = Object.freeze([
  'posts:read', 'posts:write', 'posts:publish', 'posts:schedule', 'posts:delete',
  'media:write', 'newsletter:read', 'newsletter:send',
  'social:write', 'automations:read', 'automations:write'
]);
const SCOPE_SET = new Set(SCOPES);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-f0-9]{24}$/;
const TOKEN = /^llb_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/;
const RATE_LIMIT = 120; // requisições por token em uma janela móvel aproximada de 1 min
const counters = new Map();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();

function send(res, status, value) { return res.status(status).json(value); }
function validSlug(value) { return typeof value === 'string' && value.length <= 200 && SLUG.test(value); }
function scopeAllowed(token, scope) { return token.scopes.includes(scope); }
function parsePath(path) {
  const parts = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  return parts[0] === 'v1' ? parts.slice(1) : null;
}
function readBody(req) {
  const value = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : req.body || {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Corpo JSON inválido.');
  return value;
}
function limitText(value, max) { return String(value == null ? '' : value).slice(0, max); }

async function verifyToken(raw, store = getFirestore()) {
  const match = TOKEN.exec(String(raw || ''));
  if (!match) return null;
  const snap = await store.doc('api_tokens/' + match[1]).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const expires = Date.parse(data.expiresAt || '');
  if (data.revoked || !Number.isFinite(expires) || expires <= Date.now()) return null;
  if (!Array.isArray(data.scopes) || !data.scopes.every(scope => SCOPE_SET.has(scope))) return null;
  if (data.blogId !== BLOG_ID || !/^[a-f0-9]{64}$/.test(data.hash || '')) return null;
  const expected = Buffer.from(data.hash, 'hex');
  const actual = Buffer.from(digest(raw), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  snap.ref.set({ lastUsedAt: iso() }, { merge:true }).catch(() => {});
  return { id:match[1], label:data.label || '', scopes:data.scopes, blogId:data.blogId, expiresAt:data.expiresAt };
}

function allowRate(token) {
  const now = Date.now();
  const current = counters.get(token.id);
  const next = !current || current.until <= now ? { count:1, until:now + 60000 } : { count:current.count + 1, until:current.until };
  counters.set(token.id, next);
  if (counters.size > 1000) for (const [id, item] of counters) if (item.until <= now) counters.delete(id);
  return next.count <= RATE_LIMIT;
}

async function tokensRoute(req, res, parts, store = getFirestore()) {
  const admin = await requireAdmin_(req, res);
  if (!admin) return;
  if (req.method === 'GET' && parts.length === 1) {
    const snap = await store.collection('api_tokens').orderBy('createdAt', 'desc').limit(100).get();
    return send(res, 200, { ok:true, tokens:snap.docs.map(doc => {
      const { hash, ...data } = doc.data(); return { id:doc.id, ...data };
    }) });
  }
  if (req.method === 'POST' && parts.length === 1) {
    let body; try { body = readBody(req); } catch { return send(res, 400, { ok:false, message:'JSON inválido.' }); }
    const label = limitText(body.label, 60).trim();
    const scopes = body.scopes;
    const days = Number(body.expiresInDays == null ? 90 : body.expiresInDays);
    if (!label || !Array.isArray(scopes) || !scopes.length || scopes.length > SCOPES.length ||
        !scopes.every(scope => typeof scope === 'string' && SCOPE_SET.has(scope)) || new Set(scopes).size !== scopes.length ||
        !Number.isInteger(days) || days < 1 || days > 365)
      return send(res, 400, { ok:false, message:'Informe nome, escopos válidos e prazo de 1 a 365 dias.' });
    const id = crypto.randomBytes(12).toString('hex');
    const raw = `llb_${id}_${crypto.randomBytes(32).toString('base64url')}`;
    const doc = { hash:digest(raw), label, scopes, blogId:BLOG_ID,
      createdAt:iso(), createdBy:admin.uid, expiresAt:new Date(Date.now() + days * 86400000).toISOString(),
      revoked:false, lastUsedAt:null, prefix:`llb_${id.slice(0, 6)}…` };
    await store.doc('api_tokens/' + id).create(doc);
    res.set('Cache-Control', 'no-store');
    return send(res, 201, { ok:true, id, token:raw, expiresAt:doc.expiresAt, scopes });
  }
  if (req.method === 'DELETE' && parts.length === 2 && ID.test(parts[1])) {
    const ref = store.doc('api_tokens/' + parts[1]);
    const snap = await ref.get();
    if (!snap.exists) return send(res, 404, { ok:false, message:'Token não encontrado.' });
    await ref.set({ revoked:true, revokedAt:iso() }, { merge:true });
    return send(res, 200, { ok:true });
  }
  return send(res, 405, { ok:false, message:'Método ou rota inválidos.' });
}

function captureResponse() {
  return {
    statusCode:200, headers:{}, payload:null,
    set(name, value) { this.headers[name] = value; return this; },
    get(name) { return this.headers[name]; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
    end() { return this; }
  };
}
async function delegate(req, res, handler, method, path, body, query) {
  const innerReq = { method, path, rawBody:null, body:body || {}, query:query || {},
    headers:req.headers || {}, get:name => req.get ? req.get(name) : req.headers?.[String(name).toLowerCase()] };
  const innerRes = captureResponse();
  await handler(innerReq, innerRes);
  let value = innerRes.payload;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = { ok:false, message:'Resposta inesperada do serviço.' }; } }
  if (!value || typeof value !== 'object') value = { ok:false, message:'Resposta vazia do serviço.' };
  const status = value.ok === false && innerRes.statusCode === 200 ? 400 : innerRes.statusCode;
  return send(res, status, value);
}

function postInput(body, existing, slug) {
  const prev = existing || {};
  const field = (name, fallback) => Object.prototype.hasOwnProperty.call(body, name) ? body[name] : fallback;
  const tags = field('tags', prev.tags || []);
  if (!Array.isArray(tags) || tags.length > 8) throw new Error('Use até oito tags.');
  const content = limitText(field('content_html', prev.content || ''), 250000);
  const title = limitText(field('title', prev.title || ''), 300).trim();
  if (!title || !content.trim()) throw new Error('Título e conteúdo são obrigatórios.');
  return {
    slug, titulo_final:title, content_html:content,
    excerpt:limitText(field('excerpt', prev.excerpt || ''), 2000),
    categoria:limitText(field('category', prev.category || ''), 60),
    tipo_post_label:limitText(field('post_type', prev.post_type_label || 'Artigo'), 40),
    tags_csv:tags.map(tag => limitText(tag, 40)).join(', '),
    cover_url:limitText(field('cover_url', prev.cover_url || ''), 2000),
    video_url:limitText(field('video_url', prev.video_url || ''), 2000),
    tiktok_video_url:limitText(field('tiktok_video_url', prev.tiktok_video_url || ''), 2000),
    audio_url:limitText(field('audio_url', prev.audio_url || ''), 2000),
    github_url:limitText(field('github_url', prev.github_url || ''), 2000),
    project_url:limitText(field('project_url', prev.project_url || ''), 2000),
    seo_title:limitText(field('seo_title', prev.seo_title || ''), 300),
    seo_description:limitText(field('seo_description', prev.seo_description || ''), 500),
    cta_label:limitText(field('cta_label', prev.cta_label || ''), 100),
    cta_url:limitText(field('cta_url', prev.cta_url || ''), 2000),
    author_id:limitText(field('author_id', prev.author_id || ''), 100),
    author_name:limitText(field('author_name', prev.author_name || ''), 120),
    reading_time:Math.max(1, Math.min(120, Number(field('reading_time', prev.reading_time || 1)) || 1)),
    tts_enabled:field('tts_enabled', prev.tts_enabled !== false),
    auto_translate:field('auto_translate', prev.auto_translate !== false),
    destaque:field('featured', prev.featured || false) ? 'true' : 'false',
    dispatch_newsletter:field('dispatch_newsletter', prev.dispatch_newsletter || false) ? 'true' : 'false',
    status:prev.status || 'draft', blog_id:BLOG_ID,
    scheduled_at:prev.scheduled_at || null
  };
}

function embedMarkup(body) {
  const urls = Array.isArray(body.urls) ? body.urls : [body.url];
  if (!urls.length || urls.length > 10) throw new Error('Envie de um a dez links.');
  const items = urls.map(raw => {
    const media = LazyMedia.embedVideo(raw);
    if (!media || !['youtube', 'instagram', 'tiktok', 'vimeo', 'drive'].includes(media.provider)) throw new Error('Vídeo não suportado.');
    const portrait = media.portrait ? ' article-video-portrait' : '';
    return { provider:media.provider, url:media.href || String(raw), html:`<figure class="article-video${portrait}"><iframe src="${media.src}" loading="lazy" allowfullscreen></iframe></figure>` };
  });
  return { ok:true, items, html:items.map(item => item.html).join('\n') };
}

async function claimIdempotency(store, token, key, action) {
  if (!/^[A-Za-z0-9._:-]{12,100}$/.test(String(key || ''))) return false;
  const id = digest(`${token.id}:${action}:${key}`);
  try {
    await store.doc('api_idempotency/' + id).create({ tokenId:token.id, action, createdAt:iso(), expiresAt:new Date(Date.now() + 7 * 86400000).toISOString() });
    return true;
  } catch (error) {
    if (error.code === 6 || error.code === 'already-exists') return false;
    throw error;
  }
}

async function handler(req, res, services = {}) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const parts = parsePath(req.path);
  if (!parts) return send(res, 404, { ok:false, message:'Rota desconhecida.' });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const method = String(req.method || '').toUpperCase();
  const resource = parts[0];
  if (resource === 'health' && method === 'GET') return send(res, 200, { ok:true, version:'v1' });
  const store = services.db || getFirestore();
  try {
    if (resource === 'tokens') return await tokensRoute(req, res, parts, store);
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const token = bearer && await verifyToken(bearer[1], store);
    if (!token) return send(res, 401, { ok:false, message:'Token de agente inválido ou expirado.' });
    if (!allowRate(token)) return send(res, 429, { ok:false, message:'Limite temporário de requisições.' });
    if ((req.rawBody?.length || 0) > (resource === 'media' ? 29_000_000 : 500_000))
      return send(res, 413, { ok:false, message:'Solicitação muito grande.' });
    const allowed = scope => scopeAllowed(token, scope) || (send(res, 403, { ok:false, message:'Escopo necessário: ' + scope }), false);
    const internalAuth = { requireAdmin:async () => ({ uid:token.id, role:'admin' }) };
    const posts = services.posts || require('./posts');
    const postHandler = (r, s) => posts.handler(r, s, internalAuth);

    if (resource === 'capabilities' && method === 'GET')
      return send(res, 200, { ok:true, blogId:BLOG_ID, scopes:token.scopes, routes:['posts','media','newsletter','social','automations'], openapi:'/api/v1/openapi.json' });
    if (resource === 'openapi.json' && method === 'GET')
      return send(res, 200, require('./agent-openapi.json'));

    if (resource === 'posts') {
      const slug = parts[1], action = parts[2];
      if (slug && !validSlug(slug)) return send(res, 400, { ok:false, message:'Slug inválido.' });
      if (method === 'GET' && !slug) {
        if (!allowed('posts:read')) return;
        const status = String(req.query?.status || 'published');
        if (!['published','draft','scheduled','archived'].includes(status)) return send(res, 400, { ok:false, message:'Status inválido.' });
        return delegate(req, res, postHandler, 'POST', '/api/posts/list', { blog_id:BLOG_ID, status });
      }
      if (method === 'GET' && slug && !action) {
        if (!allowed('posts:read')) return;
        const snap = await store.doc('posts/' + slug).get();
        if (!snap.exists || snap.data().blog_id !== BLOG_ID) return send(res, 404, { ok:false, message:'Artigo não encontrado.' });
        return delegate(req, res, postHandler, 'POST', '/api/posts/get', { slug });
      }
      if (method === 'POST' && !slug) {
        if (!allowed('posts:write')) return;
        const body = readBody(req);
        if (!validSlug(body.slug)) return send(res, 400, { ok:false, message:'Slug inválido.' });
        if ((await store.doc('posts/' + body.slug).get()).exists) return send(res, 409, { ok:false, message:'Slug já existe. Use PATCH para editar.' });
        return delegate(req, res, postHandler, 'POST', '/api/posts/publish', { data:postInput(body, null, body.slug) });
      }
      if (method === 'PATCH' && slug && !action) {
        if (!allowed('posts:write')) return;
        const snap = await store.doc('posts/' + slug).get();
        if (!snap.exists || snap.data().blog_id !== BLOG_ID) return send(res, 404, { ok:false, message:'Artigo não encontrado.' });
        const existing = snap.data();
        if (existing.status === 'published' && !allowed('posts:publish')) return;
        if (existing.status === 'scheduled' && !allowed('posts:schedule')) return;
        return delegate(req, res, postHandler, 'POST', '/api/posts/publish', { data:postInput(readBody(req), existing, slug) });
      }
      if (method === 'DELETE' && slug && !action) {
        if (!allowed('posts:delete')) return;
        const snap = await store.doc('posts/' + slug).get();
        if (!snap.exists || snap.data().blog_id !== BLOG_ID) return send(res, 404, { ok:false, message:'Artigo não encontrado.' });
        return delegate(req, res, postHandler, 'POST', '/api/posts/del', { slug });
      }
      if (method === 'POST' && slug && ['publish','schedule','archive','translate'].includes(action)) {
        const needed = action === 'schedule' ? 'posts:schedule' : 'posts:publish';
        if (!allowed(needed)) return;
        const snap = await store.doc('posts/' + slug).get();
        if (!snap.exists || snap.data().blog_id !== BLOG_ID) return send(res, 404, { ok:false, message:'Artigo não encontrado.' });
        if (action === 'schedule') {
          const when = readBody(req).scheduled_at;
          const at = Date.parse(when);
          if (typeof when !== 'string' || !Number.isFinite(at) || at < Date.now() + 60000 || at > Date.now() + 366 * 86400000)
            return send(res, 400, { ok:false, message:'Use scheduled_at ISO 8601 entre 1 minuto e 1 ano no futuro.' });
          return delegate(req, res, postHandler, 'POST', '/api/posts/publish', { data:postInput({}, { ...snap.data(), status:'scheduled', scheduled_at:new Date(at).toISOString() }, slug) });
        }
        if (action === 'translate') return delegate(req, res, postHandler, 'POST', '/api/posts/translate', { slug });
        return delegate(req, res, postHandler, 'POST', '/api/posts/setStatus', { slug, status:action === 'publish' ? 'published' : 'archived' });
      }
    }

    if (resource === 'media' && method === 'POST' && parts.length === 2) {
      if (parts[1] === 'embed') {
        if (!allowed('media:write')) return;
        return send(res, 200, embedMarkup(readBody(req)));
      }
      if (!allowed('media:write')) return;
      if (parts[1] === 'image' || parts[1] === 'video') {
        const size = req.rawBody?.length || 0;
        if (size > (parts[1] === 'image' ? 12_000_000 : 29_000_000)) return send(res, 413, { ok:false, message:'Arquivo muito grande.' });
        return delegate(req, res, postHandler, 'POST', '/api/posts/' + (parts[1] === 'image' ? 'uploadImage' : 'uploadVideo'), readBody(req));
      }
    }

    if (resource === 'newsletter' && services.newsletter) {
      if (method === 'GET' && parts[1] === 'campaigns' && !parts[2]) {
        if (!allowed('newsletter:read')) return;
        return delegate(req, res, services.newsletter, 'GET', '/api/campaigns/list', {});
      }
      if (method === 'GET' && parts[1] === 'campaigns' && parts[2]) {
        if (!allowed('newsletter:read')) return;
        return delegate(req, res, services.newsletter, 'GET', '/api/campaigns/detail', {}, { id:parts[2] });
      }
      if (method === 'POST' && parts[1] === 'send' && parts.length === 2) {
        if (!allowed('newsletter:send')) return;
        const body = readBody(req);
        if (!validSlug(body.slug)) return send(res, 400, { ok:false, message:'Slug inválido.' });
        const snap = await store.doc('posts/' + body.slug).get();
        if (!snap.exists || snap.data().blog_id !== BLOG_ID || snap.data().status !== 'published')
          return send(res, 404, { ok:false, message:'Artigo publicado não encontrado.' });
        const key = req.headers['idempotency-key'];
        if (!/^[A-Za-z0-9._:-]{12,100}$/.test(String(key || '')))
          return send(res, 400, { ok:false, message:'Envie Idempotency-Key com 12 a 100 caracteres.' });
        if (!await claimIdempotency(store, token, key, 'newsletter:send'))
          return send(res, 409, { ok:false, message:'Este envio já foi solicitado; consulte o histórico antes de repetir.' });
        const post = snap.data();
        return delegate(req, res, services.newsletter, 'POST', '/api/campaigns/send', {
          blog_id:BLOG_ID, slug:body.slug, post_title:post.title, excerpt:post.excerpt || '',
          subject:limitText(body.subject || '', 200), cta_label:'Ler artigo completo'
        });
      }
    }

    if (resource === 'social' && method === 'POST' && parts.length === 2) {
      if (!allowed('social:write')) return;
      if (!['draft','publish'].includes(parts[1])) return send(res, 404, { ok:false });
      const body = readBody(req);
      if (parts[1] === 'publish') {
        if (!validSlug(body.slug)) return send(res, 400, { ok:false, message:'Slug inválido.' });
        const key = req.headers['idempotency-key'];
        if (!/^[A-Za-z0-9._:-]{12,100}$/.test(String(key || '')))
          return send(res, 400, { ok:false, message:'Envie Idempotency-Key.' });
        if (!await claimIdempotency(store, token, key, 'social:' + body.channel))
          return send(res, 409, { ok:false, message:'Publicação já solicitada; confira o canal antes de repetir.' });
      }
      const social = services.social || require('./social');
      return delegate(req, res, (r, s) => social.handler(r, s, internalAuth), 'POST', '/api/social/' + parts[1], body);
    }

    if (resource === 'automations') {
      const automations = services.automations || require('./meta-automations');
      if (method === 'GET' && parts.length === 1) {
        if (!allowed('automations:read')) return;
        return delegate(req, res, (r, s) => automations.admin(r, s, internalAuth), 'GET', '/api/meta/automations', {});
      }
      if (method === 'POST' && parts.length === 1) {
        if (!allowed('automations:write')) return;
        return delegate(req, res, (r, s) => automations.admin(r, s, internalAuth), 'POST', '/api/meta/automations', readBody(req));
      }
      if (method === 'DELETE' && parts.length === 2) {
        if (!allowed('automations:write')) return;
        return delegate(req, res, (r, s) => automations.admin(r, s, internalAuth), 'DELETE', '/api/meta/automations', {}, { id:parts[1] });
      }
    }
    return send(res, 404, { ok:false, message:'Rota de agente não encontrada.' });
  } catch (error) {
    console.error('[agent-api]', error?.code || error?.name || 'error');
    const badInput = error instanceof SyntaxError || /obrigat|inválid|Use até|suportado/i.test(String(error.message));
    return send(res, badInput ? 400 : 500,
      { ok:false, message:badInput ? (error instanceof SyntaxError ? 'JSON inválido.' : String(error.message).slice(0, 160)) : 'Falha interna.' });
  }
}

module.exports = { handler, verifyToken, parsePath, postInput, embedMarkup, SCOPES, claimIdempotency };
