const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const admin = require('./admin');
const { rankProducts } = require('./product-ranking');
const LazyMedia = require('./media-providers');

const DEFAULT_BLOG = 'your-blog';
const LANGUAGES = new Set(['pt-BR', 'en', 'es', 'fr', 'de']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let _db;
function db() { return _db || (_db = getFirestore()); }
let productCache = { until: 0, rows: [], pending: null };
const eventLimits = new Map();
function safeIp(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100); }
function bot(req) { return /bot|spider|crawler|facebookexternalhit|twitterbot|whatsapp|slackbot/i.test(String(req.headers?.['user-agent'] || '')); }
function allowEvent(req, type, slug) {
  const now = Date.now(), ip = safeIp(req), key = type + ':' + slug + ':' + ip;
  if (eventLimits.size > 5000) for (const [k, until] of eventLimits) if (until < now) eventLimits.delete(k);
  if (eventLimits.size > 6000 || (eventLimits.get(key) || 0) > now) return false;
  eventLimits.set(key, now + (type === 'impressions' ? 60 * 60 * 1000 : 10 * 60 * 1000));
  return true;
}
async function countEvent(req, slug, type) {
  if (!['impressions', 'article_clicks', 'checkout_clicks'].includes(type) || bot(req) || !allowEvent(req, type, slug)) return false;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await db().doc('product_stats/' + DEFAULT_BLOG + '--' + slug).set({
    blog_id: DEFAULT_BLOG, slug,
    [type]: FieldValue.increment(1),
    daily: { [day]: { [type]: FieldValue.increment(1) } }
  }, { merge: true });
  return true;
}
function thirtyDayStats(data, now = new Date()) {
  const result = { impressions: 0, article_clicks: 0, checkout_clicks: 0 };
  const earliest = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const latest = now.toISOString().slice(0, 10).replace(/-/g, '');
  for (const [day, counts] of Object.entries(data?.daily || {})) {
    if (day < earliest || day > latest) continue;
    for (const key of Object.keys(result)) result[key] += Number(counts?.[key]) || 0;
  }
  return result;
}
async function publishedProducts() {
  if (productCache.until > Date.now()) return productCache.rows;
  if (!productCache.pending) productCache.pending = db().collection('products').where('blog_id', '==', DEFAULT_BLOG).limit(100).get()
    .then(snap => {
      productCache.rows = snap.docs.map(doc => doc.data()).filter(p => p.status === 'published' && p.offer_enabled !== false);
      productCache.until = Date.now() + 120000;
      return productCache.rows;
    }).finally(() => { productCache.pending = null; });
  return productCache.pending;
}
function json(res, status, data) { res.set('Cache-Control', 'no-store'); res.status(status).json(data); }
function esc(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function validHttps(value) { try { const u = new URL(value); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch (_) { return false; } }
function fields(body) {
  const blog_id = String(body.blog_id || DEFAULT_BLOG).trim();
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!ID.test(blog_id) || !ID.test(slug) || slug.length > 90) throw new Error('Identificador ou slug inválido.');
  const price_cents = body.price_cents === '' || body.price_cents == null ? NaN : Number(body.price_cents);
  if (!Number.isSafeInteger(price_cents) || price_cents < 0 || price_cents > 100000000) throw new Error('Preço inválido.');
  const urlFields = ['cover_url', 'video_url', 'checkout_url'];
  for (const key of urlFields) if (body[key] && !validHttps(body[key])) throw new Error('Use URLs HTTPS válidas para imagem, vídeo e checkout.');
  const status = body.status === 'published' ? 'published' : 'draft';
  const doc = {
    blog_id, slug, title: String(body.title || '').trim().slice(0, 140),
    subtitle: String(body.subtitle || '').trim().slice(0, 240),
    description: String(body.description || '').trim().slice(0, 6000),
    type: ['course', 'mentoring', 'digital'].includes(body.type) ? body.type : 'course',
    language: LANGUAGES.has(body.language) ? body.language : 'pt-BR',
    category: String(body.category || '').trim().slice(0, 100),
    tags: (Array.isArray(body.tags) ? body.tags : []).slice(0, 20).map(t => String(t).trim().slice(0, 60)).filter(Boolean),
    keywords: (Array.isArray(body.keywords) ? body.keywords : []).slice(0, 20).map(t => String(t).trim().slice(0, 60)).filter(Boolean),
    deliverables: (Array.isArray(body.deliverables) ? body.deliverables : []).slice(0, 30).map(t => String(t).trim().slice(0, 180)).filter(Boolean),
    cover_url: String(body.cover_url || '').trim(), video_url: String(body.video_url || '').trim(),
    checkout_url: String(body.checkout_url || '').trim(), price_cents, currency: 'BRL',
    status, offer_enabled: body.offer_enabled !== false,
    offer_placement: body.offer_placement === 'floating' ? 'floating' : 'inline'
  };
  if (!doc.title) throw new Error('Título é obrigatório.');
  if (status === 'published' && (!doc.cover_url || !doc.checkout_url || !doc.description)) throw new Error('Para publicar, informe capa, descrição e URL de checkout.');
  return doc;
}
function publicShape(doc) {
  return { slug: doc.slug, blog_id: doc.blog_id, title: doc.title, subtitle: doc.subtitle,
    description: doc.description, type: doc.type, language: doc.language, category: doc.category,
    tags: doc.tags, deliverables: doc.deliverables, cover_url: doc.cover_url,
    video_url: doc.video_url, price_cents: doc.price_cents, currency: doc.currency,
    offer_placement: doc.offer_placement || 'inline',
    url: '/produto/' + encodeURIComponent(doc.slug) };
}
function price(doc) { return new Intl.NumberFormat(doc.language || 'pt-BR', { style: 'currency', currency: 'BRL' }).format(doc.price_cents / 100); }
const PAGE_COPY = {
  'pt-BR': { back: 'Voltar ao blog', about: 'Sobre', included: 'O que está incluído', investment: 'Investimento', checkout: 'Ir para o checkout', note: 'O pagamento e o acesso ao produto são administrados na plataforma de checkout indicada pelo criador.', video: 'Assistir à apresentação', course: 'Curso', mentoring: 'Mentoria', digital: 'Produto digital' },
  en: { back: 'Back to blog', about: 'About', included: 'What is included', investment: 'Price', checkout: 'Go to checkout', note: 'Payment and access are handled by the creator’s checkout platform.', video: 'Watch presentation', course: 'Course', mentoring: 'Mentoring', digital: 'Digital product' },
  es: { back: 'Volver al blog', about: 'Acerca de', included: 'Qué incluye', investment: 'Precio', checkout: 'Ir al pago', note: 'El pago y el acceso se gestionan en la plataforma de pago del creador.', video: 'Ver presentación', course: 'Curso', mentoring: 'Mentoría', digital: 'Producto digital' },
  fr: { back: 'Retour au blog', about: 'À propos', included: 'Ce qui est inclus', investment: 'Prix', checkout: 'Passer au paiement', note: 'Le paiement et l’accès sont gérés par la plateforme de paiement du créateur.', video: 'Voir la présentation', course: 'Cours', mentoring: 'Mentorat', digital: 'Produit numérique' },
  de: { back: 'Zurück zum Blog', about: 'Über das Produkt', included: 'Enthaltene Leistungen', investment: 'Preis', checkout: 'Zum Checkout', note: 'Zahlung und Zugang werden über die Checkout-Plattform des Anbieters abgewickelt.', video: 'Präsentation ansehen', course: 'Kurs', mentoring: 'Mentoring', digital: 'Digitales Produkt' }
};
function salesPage(doc, articleSlug = '') {
  const product = publicShape(doc);
  const t = PAGE_COPY[product.language] || PAGE_COPY['pt-BR'];
  const image = product.cover_url ? '<img class="cover" src="' + esc(product.cover_url) + '" alt="' + esc(product.title) + '">' : '';
  const items = product.deliverables.length ? '<section><h2>' + esc(t.included) + '</h2><ul>' + product.deliverables.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul></section>' : '';
  const media = LazyMedia.video(product.video_url);
  const video = !product.video_url ? '' : media && media.provider === 'file'
    ? '<video class="sales-video" controls playsinline preload="metadata" src="' + esc(media.src) + '"></video>'
    : media ? '<div class="sales-video"><iframe src="' + esc(media.src) + '" title="' + esc(t.video) + '" loading="lazy" allow="autoplay;encrypted-media;picture-in-picture;fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>'
      : '<p><a class="video-link" href="' + esc(product.video_url) + '" target="_blank" rel="noopener noreferrer">' + esc(t.video) + ' ↗</a></p>';
  const title = esc(product.title), subtitle = esc(product.subtitle), description = esc(product.description);
  return '<!doctype html><html lang="' + esc(product.language) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + ' — Lazy Labs</title><meta name="description" content="' + esc(product.subtitle || product.description.slice(0, 155)) + '">'
    + '<link rel="canonical" href="https://blog.example.com/produto/' + esc(product.slug) + '"><meta property="og:title" content="' + title + '">'
    + '<meta property="og:description" content="' + esc(product.subtitle) + '"><meta property="og:image" content="' + esc(product.cover_url) + '">'
    + '<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;700&family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">'
    + '<link rel="stylesheet" href="/assets/product-sales.css?v=20261029"></head><body><header><a href="/" class="logo">[LAZY <span>LABS]</span></a><a href="/">← ' + esc(t.back) + '</a></header>'
    + '<main><div class="eyebrow">' + esc(t[product.type]) + ' · Lazy Labs</div>'
    + '<h1>' + title + '</h1><p class="subtitle">' + subtitle + '</p>' + image + video + '<div class="content"><section><h2>' + esc(t.about) + '</h2><p>' + description.replace(/\n/g, '<br>') + '</p></section>' + items + '</div>'
    + '<div class="buy"><div><small>' + esc(t.investment) + '</small><strong>' + esc(price(doc)) + '</strong></div><a href="/api/products/go?slug=' + encodeURIComponent(product.slug) + (ID.test(articleSlug) ? '&amp;from=' + encodeURIComponent(articleSlug) : '') + '" target="_blank" rel="noopener noreferrer sponsored">' + esc(t.checkout) + ' ↗</a></div>'
    + '<p class="checkout-note">' + esc(t.note) + '</p></main></body></html>';
}
async function handler(req, res) {
  const path = String(req.path || '');
  const page = /^\/produto\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(path);
  if (page && req.method === 'GET') {
    const snap = await db().doc('products/' + DEFAULT_BLOG + '--' + page[1]).get();
    if (!snap.exists || snap.data().status !== 'published') { res.status(404).send('Produto não encontrado.'); return; }
    res.set('Cache-Control', 'public,max-age=120'); res.type('html').send(salesPage(snap.data(), String(req.query?.from || ''))); return;
  }
  const action = /^\/api\/products\/(list|save|delete|recommend|preview|stats|event|go)$/.exec(path)?.[1];
  if (!action) { json(res, 404, { ok: false, message: 'Rota não encontrada.' }); return; }
  if (action === 'go' && req.method === 'GET') {
    const slug = String(req.query?.slug || '');
    if (!ID.test(slug) || slug.length > 90) { json(res, 400, { ok: false, message: 'Produto inválido.' }); return; }
    const snap = await db().doc('products/' + DEFAULT_BLOG + '--' + slug).get();
    if (!snap.exists || snap.data().status !== 'published' || !validHttps(snap.data().checkout_url)) { json(res, 404, { ok: false, message: 'Produto não encontrado.' }); return; }
    try { await countEvent(req, slug, 'checkout_clicks'); } catch (error) { console.error('[products] checkout tracking:', error.message); }
    res.set('Cache-Control', 'no-store'); res.redirect(302, snap.data().checkout_url); return;
  }
  if (action === 'event' && req.method === 'POST') {
    if (req.rawBody?.length > 1024 || !['https://blog.example.com', 'https://your-blog.web.app'].includes(String(req.headers?.origin || ''))) {
      json(res, 403, { ok: false }); return;
    }
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const slug = String(body.slug || ''), type = String(body.type || '');
    if (!ID.test(slug) || slug.length > 90 || !['impressions', 'article_clicks'].includes(type)) { json(res, 400, { ok: false }); return; }
    const product = await db().doc('products/' + DEFAULT_BLOG + '--' + slug).get();
    if (!product.exists || product.data().status !== 'published') { json(res, 404, { ok: false }); return; }
    try { await countEvent(req, slug, type); json(res, 200, { ok: true }); }
    catch (error) { console.error('[products] event:', error.message); json(res, 503, { ok: false }); }
    return;
  }
  if (action === 'recommend' && req.method === 'GET') {
    const slug = String(req.query.slug || '');
    if (!ID.test(slug) || slug.length > 200) { json(res, 400, { ok: false, message: 'Slug inválido.' }); return; }
    const source = await db().doc('posts/' + slug).get();
    if (!source.exists || source.data().status !== 'published' || source.data().blog_id !== DEFAULT_BLOG) { json(res, 404, { ok: false, message: 'Artigo não encontrado.' }); return; }
    const language = LANGUAGES.has(req.query.language) ? req.query.language : 'pt-BR';
    const product = rankProducts({ ...source.data(), language }, await publishedProducts(), 1)[0];
    json(res, 200, { ok: true, product: product ? publicShape(product) : null }); return;
  }
  if (!['GET', 'POST'].includes(req.method)) { json(res, 405, { ok: false, message: 'Método inválido.' }); return; }
  const user = await admin.requireAdmin_(req, res, { anyRole: action === 'list' });
  if (!user) return;
  try {
    if (action === 'list' && req.method === 'GET') {
      const blog = String(req.query.blog_id || DEFAULT_BLOG);
      if (!ID.test(blog)) { json(res, 400, { ok: false, message: 'Blog inválido.' }); return; }
      const snap = await db().collection('products').where('blog_id', '==', blog).limit(200).get();
      json(res, 200, { ok: true, products: snap.docs.map(d => d.data()).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) }); return;
    }
    if (action === 'preview' && req.method === 'GET') {
      const slug = String(req.query?.slug || ''), language = LANGUAGES.has(req.query?.language) ? req.query.language : 'pt-BR';
      if (!ID.test(slug) || slug.length > 200) { json(res, 400, { ok: false, message: 'Slug inválido.' }); return; }
      const article = await db().doc('posts/' + slug).get();
      if (!article.exists || article.data().blog_id !== DEFAULT_BLOG) { json(res, 404, { ok: false, message: 'Artigo não encontrado no blog principal.' }); return; }
      const products = await db().collection('products').where('blog_id', '==', DEFAULT_BLOG).limit(100).get();
      const matches = rankProducts({ ...article.data(), language }, products.docs.map(d => d.data()), 3);
      json(res, 200, { ok: true, article_title: article.data().title, matches: matches.map(p => ({ slug: p.slug, title: p.title, score: Math.round(p.match_score * 10) / 10, placement: p.offer_placement || 'inline' })) }); return;
    }
    if (action === 'stats' && req.method === 'GET') {
      const products = await db().collection('products').where('blog_id', '==', DEFAULT_BLOG).limit(100).get();
      const docs = await Promise.all(products.docs.map(p => db().doc('product_stats/' + DEFAULT_BLOG + '--' + p.data().slug).get()));
      const stats = {};
      docs.forEach((d, i) => { stats[products.docs[i].data().slug] = thirtyDayStats(d.exists ? d.data() : {}); });
      json(res, 200, { ok: true, days: 30, stats }); return;
    }
    if (action === 'save' && req.method === 'POST') {
      const body = req.body || {}, doc = fields(body), ref = db().doc('products/' + doc.blog_id + '--' + doc.slug);
      const existing = await ref.get();
      const now = new Date().toISOString();
      await ref.set({ ...doc, created_at: existing.exists ? existing.data().created_at : now, updated_at: now }, { merge: false });
      productCache.until = 0;
      json(res, 200, { ok: true, product: doc }); return;
    }
    if (action === 'delete' && req.method === 'POST') {
      const blog = String(req.body?.blog_id || DEFAULT_BLOG), slug = String(req.body?.slug || '');
      if (!ID.test(blog) || !ID.test(slug)) { json(res, 400, { ok: false, message: 'Identificador inválido.' }); return; }
      await db().doc('products/' + blog + '--' + slug).delete();
      productCache.until = 0;
      json(res, 200, { ok: true }); return;
    }
    json(res, 405, { ok: false, message: 'Método inválido.' });
  } catch (error) { json(res, 400, { ok: false, message: error.message || 'Não foi possível processar o produto.' }); }
}

module.exports = { handler, fields, salesPage, publicShape, thirtyDayStats };
