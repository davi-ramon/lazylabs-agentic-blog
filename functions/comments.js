// Public article discussions. Only root comments and one level of replies are stored.
const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');
const { FieldValue } = require('firebase-admin/firestore');

const PAGE_SIZE = 12;
const STICKERS = new Set(['spark', 'heart', 'idea', 'rocket', 'applause', 'celebrate']);
const readBuckets = new Map();
const countCache = new Map();
function respond(res, status, value) { res.set('Cache-Control', 'no-store'); res.status(status).json(value); }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function ipOf(req) { const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, ''); return isIP(ip) ? ip : 'unknown'; }
function rateKey(req) {
  const secret = process.env.COMMENT_RATE_SECRET;
  if (!secret || secret.length < 32) throw new Error('COMMENT_RATE_SECRET não configurado');
  return createHmac('sha256', secret).update(ipOf(req)).digest('hex');
}
function readLimited(req) {
  const key = ipOf(req), now = Date.now(), current = readBuckets.get(key);
  if (readBuckets.size > 5000) readBuckets.clear();
  const next = !current || current.until < now ? { count: 1, until: now + 60000 } : { count: current.count + 1, until: current.until };
  readBuckets.set(key, next);
  return next.count > 90;
}
function visible(doc) {
  const c = doc.data();
  return { id: doc.id, mode: c.mode || 'anonymous', nickname: c.nickname || '', name: c.name || '', message: c.message || '',
    created_at: c.created_at || null, reply_count: Math.max(0, Number(c.reply_count) || 0),
    reply_to_name: c.reply_to_name || '', media: c.media || null };
}
async function published(db, slug) {
  const post = await db.doc(`posts/${slug}`).get();
  return post.exists && post.data().status === 'published' && post.data().blog_id === 'your-blog';
}
async function page(collection, cursor, order) {
  let query = collection.orderBy('created_at', order).limit(PAGE_SIZE + 1);
  if (cursor) {
    if (!validId(cursor)) throw new Error('Cursor inválido.');
    const last = await collection.doc(cursor).get();
    if (!last.exists) throw new Error('Cursor inválido.');
    query = query.startAfter(last);
  }
  const snap = await query.get();
  const docs = snap.docs.slice(0, PAGE_SIZE);
  return { comments: docs.filter(d => d.data().status === 'approved').map(visible),
    next_cursor: snap.docs.length > PAGE_SIZE ? docs[docs.length - 1].id : null };
}
async function giphySearch(db, req, body, res) {
  const key = process.env.GIPHY_API_KEY;
  if (!key) { respond(res, 200, { ok: true, available: false, items: [] }); return; }
  const q = String(body.query || '').trim().slice(0, 80);
  const type = body.type === 'stickers' ? 'stickers' : 'gifs';
  if (!q.length) { respond(res, 200, { ok: true, available: true, items: [] }); return; }
  if (q.length < 2) { respond(res, 400, { ok: false, message: 'Digite ao menos duas letras.' }); return; }
  const hour = new Date().toISOString().slice(0, 13);
  const userRef = db.doc(`comment_gif_rate/${hour}_${rateKey(req)}`), globalRef = db.doc(`comment_gif_rate/${hour}_global`);
  const allowed = await db.runTransaction(async tx => {
    const [user, global] = await Promise.all([tx.get(userRef), tx.get(globalRef)]);
    const count = user.exists ? Number(user.data().count) || 0 : 0;
    const total = global.exists ? Number(global.data().count) || 0 : 0;
    if (count >= 10 || total >= 70) return false;
    tx.set(userRef, { count: count + 1 }); tx.set(globalRef, { count: total + 1 });
    return true;
  });
  if (!allowed) { res.set('Retry-After', '3600'); respond(res, 429, { ok: false, message: 'Busca de GIFs indisponível por enquanto.' }); return; }
  const url = new URL(`https://api.giphy.com/v1/${type}/search`);
  url.search = new URLSearchParams({ api_key: key, q, limit: '12', rating: 'g', lang: 'en' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error('GIPHY indisponível');
  const data = await response.json();
  const items = (data.data || []).filter(x => /^[A-Za-z0-9]{3,80}$/.test(x.id || '')).map(x => ({
    id: x.id, preview: x.images?.fixed_width_small?.webp || x.images?.fixed_width_small?.url || '',
    width: Number(x.images?.fixed_width_small?.width) || 100,
    height: Number(x.images?.fixed_width_small?.height) || 100
  })).filter(x => /^https:\/\/media\d*\.giphy\.com\//.test(x.preview));
  respond(res, 200, { ok: true, available: true, items });
}
async function verifiedMedia(body) {
  if (!body.media) return null;
  const value = body.media;
  if (value.type === 'sticker' && STICKERS.has(value.id)) return { type: 'sticker', id: value.id };
  if (value.type !== 'giphy' || !/^[A-Za-z0-9]{3,80}$/.test(value.id || '')) throw new Error('Mídia inválida.');
  const key = process.env.GIPHY_API_KEY;
  if (!key) throw new Error('GIFs indisponíveis no momento.');
  const response = await fetch(`https://api.giphy.com/v1/gifs/${encodeURIComponent(value.id)}?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error('GIF indisponível.');
  const item = (await response.json()).data;
  if (!item || !['g', 'y'].includes(String(item.rating || '').toLowerCase())) throw new Error('GIF não permitido.');
  const image = item.images?.fixed_width_small;
  const url = image?.webp || image?.url || '';
  if (!/^https:\/\/media\d*\.giphy\.com\//.test(url)) throw new Error('GIF inválido.');
  return { type: 'giphy', id: item.id, url, width: Math.min(300, Number(image.width) || 100), height: Math.min(300, Number(image.height) || 100) };
}
async function create(db, req, body, res) {
  const slug = String(body.slug || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 200) { respond(res, 400, { ok: false, message: 'Artigo inválido.' }); return; }
  if (!await published(db, slug)) { respond(res, 404, { ok: false, message: 'Artigo não encontrado.' }); return; }
  if (body.website) { respond(res, 400, { ok: false, message: 'Envio inválido.' }); return; }
  const message = String(body.message || '').trim();
  if (message.length > 2000) { respond(res, 400, { ok: false, message: 'Máximo de 2000 caracteres.' }); return; }
  const media = await verifiedMedia(body);
  if (message.length < 3 && !media) { respond(res, 400, { ok: false, message: 'Escreva uma mensagem ou escolha uma figurinha.' }); return; }
  const mode = body.mode === 'identified' ? 'identified' : 'anonymous';
  const nickname = mode === 'anonymous' ? String(body.nickname || '').trim().slice(0, 60) || 'Anônimo' : '';
  const name = mode === 'identified' ? String(body.name || '').trim().slice(0, 100) : '';
  const email = mode === 'identified' ? String(body.email || '').trim().slice(0, 200) : '';
  if (mode === 'identified' && (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)))) { respond(res, 400, { ok: false, message: 'Nome ou e-mail inválido.' }); return; }
  const parent = body.parent_id || '';
  if (parent && !validId(parent)) { respond(res, 400, { ok: false, message: 'Conversa inválida.' }); return; }
  const rootRef = parent ? db.doc(`posts/${slug}/comments/${parent}`) : null;
  let replyToName = '';
  if (rootRef) {
    const root = await rootRef.get();
    if (!root.exists || root.data().status !== 'approved') { respond(res, 404, { ok: false, message: 'Conversa não encontrada.' }); return; }
    if (body.reply_to_id) {
      if (!validId(body.reply_to_id)) { respond(res, 400, { ok: false, message: 'Resposta inválida.' }); return; }
      const target = await rootRef.collection('replies').doc(body.reply_to_id).get();
      if (!target.exists || target.data().status !== 'approved') { respond(res, 404, { ok: false, message: 'Resposta não encontrada.' }); return; }
      replyToName = target.data().nickname || target.data().name || 'Anônimo';
    } else replyToName = root.data().nickname || root.data().name || 'Anônimo';
  }
  const now = new Date(), iso = now.toISOString(), day = iso.slice(0, 10), fingerprint = rateKey(req);
  const bucketRef = db.doc(`comment_rate/${day}_${fingerprint}`), globalRef = db.doc(`comment_rate/${day}_global`);
  const collection = parent ? rootRef.collection('replies') : db.collection(`posts/${slug}/comments`);
  const commentRef = collection.doc();
  const doc = { mode, nickname, name, email, message, media, status: 'approved', created_at: iso, updated_at: iso };
  if (parent) doc.reply_to_name = replyToName;
  else doc.reply_count = 0;
  const result = await db.runTransaction(async tx => {
    const [bucket, global] = await Promise.all([tx.get(bucketRef), tx.get(globalRef)]);
    const b = bucket.exists ? bucket.data() : {};
    const last = Date.parse(b.last_at || 0) || 0;
    const inHour = now.getTime() - (Date.parse(b.hour_start || 0) || 0) < 3600000;
    if (now.getTime() - last < 20000 || Number(b.daily || 0) >= 20 || (inHour && Number(b.hourly || 0) >= 6) || Number(global.exists ? global.data().daily : 0) >= 500) return false;
    tx.set(bucketRef, { daily: (Number(b.daily) || 0) + 1, hourly: inHour ? (Number(b.hourly) || 0) + 1 : 1, hour_start: inHour ? b.hour_start : iso, last_at: iso });
    tx.set(globalRef, { daily: (global.exists ? Number(global.data().daily) || 0 : 0) + 1 });
    tx.set(commentRef, doc);
    if (rootRef) tx.update(rootRef, { reply_count: FieldValue.increment(1) });
    tx.update(db.doc(`posts/${slug}`), { comment_count: FieldValue.increment(1) });
    return true;
  });
  if (!result) { res.set('Retry-After', '60'); respond(res, 429, { ok: false, message: 'Limite de comentários atingido. Tente novamente mais tarde.' }); return; }
  countCache.delete(slug);
  respond(res, 201, { ok: true, comment: { id: commentRef.id, ...visible({ id: commentRef.id, data: () => doc }) } });
}
async function handle(action, db, req, res, body) {
  if (readLimited(req)) { res.set('Retry-After', '60'); respond(res, 429, { ok: false, message: 'Muitas solicitações. Aguarde um pouco.' }); return; }
  if (req.rawBody && req.rawBody.length > 8192) { respond(res, 413, { ok: false, message: 'Solicitação muito grande.' }); return; }
  if (action === 'gifSearch') { await giphySearch(db, req, body, res); return; }
  const slug = String(body.slug || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 200) { respond(res, 400, { ok: false, message: 'Artigo inválido.' }); return; }
  if (action === 'commentCreate') { await create(db, req, body, res); return; }
  if (!await published(db, slug)) { respond(res, 404, { ok: false, message: 'Artigo não encontrado.' }); return; }
  if (action === 'comments' && body.count_only === true) {
    let cached = countCache.get(slug);
    if (!cached || cached.until < Date.now()) {
      const snap = await db.collection(`posts/${slug}/comments`).select('reply_count', 'status').get();
      cached = { count: snap.docs.filter(d => d.data().status === 'approved').reduce((n, d) => n + 1 + Math.max(0, Number(d.data().reply_count) || 0), 0), until: Date.now() + 120000 };
      if (countCache.size > 200) countCache.clear();
      countCache.set(slug, cached);
    }
    respond(res, 200, { ok: true, count: cached.count }); return;
  }
  if (action === 'comments') { respond(res, 200, { ok: true, ...await page(db.collection(`posts/${slug}/comments`), body.cursor, 'desc') }); return; }
  if (action === 'commentReplies') {
    if (!validId(body.parent_id)) { respond(res, 400, { ok: false, message: 'Conversa inválida.' }); return; }
    const root = db.doc(`posts/${slug}/comments/${body.parent_id}`);
    const snap = await root.get();
    if (!snap.exists || snap.data().status !== 'approved') { respond(res, 404, { ok: false, message: 'Conversa não encontrada.' }); return; }
    respond(res, 200, { ok: true, ...await page(root.collection('replies'), body.cursor, 'asc') });
  }
}
module.exports = { handle, STICKERS, validId, visible };
