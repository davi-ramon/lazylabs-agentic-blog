/**
 * Lazy Labs — gestão de artigos (Firestore, coleção `posts`, doc id = slug).
 * Endpoint: POST /api/posts/<action>
 *   - list     { status?, blog_id? }  → lista posts (sem content, pra cards/dashboard)
 *   - get      { slug }               → post completo por slug (edição/preview)
 *   - publish  { data }               → mapeia campos PT do form e faz upsert por slug
 *   - setStatus{ slug, status }       → published/draft/archived/scheduled
 *   - del      { slug }               → exclui
 *
 * Migrado do Supabase em 2026-07-30 (ver `overview.md`). `blog_id` default
 * 'your-blog' até o hub multi-blog existir de verdade.
 */
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
const { getFunctions } = require('firebase-admin/functions');
const indexnow = require('./indexnow');
const adminModule = require('./admin');
const translations = require('./translations');
const comments = require('./comments');
const engagement = require('./engagement');
const recommendations = require('./recommendations');
const LazyMedia = require('./media-providers');
const SocialCopy = require('./social-copy');
const BlogTaxonomy = require('./blog-taxonomy');
const cheerio = require('cheerio');
let _pdb;
function pdb() { if (!_pdb) _pdb = getFirestore(); return _pdb; }
let relatedIndexCache = { expires: 0, posts: [] };
async function resolveShortVideoUrl(raw, request = fetch) {
  if (!LazyMedia.shortVideoUrl(raw)) throw new Error('Use um link curto do TikTok válido.');
  let current = String(raw).trim();
  for (let redirects = 0; redirects < 5; redirects++) {
    const url = new URL(current);
    if (url.protocol !== 'https:' || url.username || url.password || !['vm.tiktok.com','vt.tiktok.com','www.tiktok.com','tiktok.com','m.tiktok.com'].includes(url.hostname.toLowerCase()))
      throw new Error('O redirecionamento saiu do TikTok.');
    const media = LazyMedia.video(current);
    if (media && media.provider === 'tiktok') return media.href;
    const response = await request(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
    if (response.body && response.body.cancel) await response.body.cancel();
    const next = response.headers.get('location');
    if (![301,302,303,307,308].includes(response.status) || !next) throw new Error('O TikTok não retornou o endereço do vídeo.');
    current = new URL(next, current).href;
  }
  throw new Error('O link teve redirecionamentos demais.');
}
let relatedIndexPromise = null;
function invalidateRelatedIndex() { relatedIndexCache.expires = 0; }
async function publishedRelatedPool() {
  if (relatedIndexCache.expires > Date.now()) return relatedIndexCache.posts;
  if (!relatedIndexPromise) relatedIndexPromise = (async () => {
    const snap = await pdb().collection('posts').where('blog_id', '==', DEFAULT_BLOG_ID)
      .where('status', '==', 'published').orderBy('created_at', 'desc').limit(200).select(...RELATED_FIELDS).get();
    const posts = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    relatedIndexCache = { posts, expires: Date.now() + 120000 };
    return posts;
  })().finally(() => { relatedIndexPromise = null; });
  return relatedIndexPromise;
}

const DEFAULT_BLOG_ID = 'your-blog';
const SITE_URL = 'https://blog.example.com';
const TRANSLATION_REGION = 'southamerica-east1';
function translationQueue() { return getFunctions().taskQueue(`locations/${TRANSLATION_REGION}/functions/translationTask`); }
function translationTaskId(slug, hash, lang) {
  // Evita tarefas duplicadas no mesmo ciclo, mas permite que o próximo ciclo
  // recupere uma tradução que esgotou todas as tentativas da fila.
  const cycle = Math.floor(Date.now() / (30 * 60 * 1000));
  return createHash('sha256').update(`${slug}:${hash}:${lang}:${cycle}`).digest('hex');
}
const LIST_FIELDS = ['title', 'slug', 'status', 'category', 'post_type', 'post_type_label', 'tags', 'cover_url', 'featured', 'dispatch_newsletter', 'published_at', 'scheduled_at', 'created_at', 'updated_at', 'blog_id', 'excerpt', 'author_name', 'author_id', 'author_photo_url', 'reading_time', 'audio_url', 'tts_enabled', 'view_count', 'like_count', 'favorite_count', 'comment_count', 'page_load_count', 'qualified_view_count', 'read_session_count', 'feed_click_count', 'cta_click_count', 'translation_ready', 'auto_translate'];
const RELATED_FIELDS = ['title', 'slug', 'status', 'category', 'tags', 'excerpt', 'cover_url', 'video_url', 'published_at', 'created_at', 'reading_time', 'translation_hash', 'translation_ready'];
function isValidSlug(s) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 200; }
function feedExcerpt(html) {
  const $ = cheerio.load(String(html || '').slice(0, 20000));
  $('script,style,iframe,form,nav').remove();
  const blocks = $('body').find('h1,h2,h3,h4,p,li,blockquote,pre').map((_, node) => $(node).text().trim()).get();
  const text = (blocks.length ? blocks.join(' ') : $('body').text()).replace(/\s+/g, ' ').trim();
  if (text.length <= 1050) return text;
  return text.slice(0, 1050).replace(/\s+\S*$/, '') + '…';
}
function validHttps(value) {
  if (!value) return true;
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password; }
  catch (_) { return false; }
}

/* mapeia o objeto do form (chaves PT) para os campos do doc */
function mapPost(data, existing) {
  const d = data || {};
  const tags = String(d.tags_csv || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const postType = BlogTaxonomy.type(d.tipo_post_label || d.tipo_post)
    || BlogTaxonomy.type(existing && (existing.post_type_label || existing.post_type))
    || { value: 'artigo', label: 'Artigo' };
  const status = d.status || 'draft';
  const row = {
    title: String(d.titulo_final || '').slice(0, 300),
    slug: String(d.slug || '').slice(0, 200),
    excerpt: String(d.excerpt || ''),
    content: String(d.content_html || ''),
    category: String(d.categoria || ''),
    post_type: postType.value,
    post_type_label: postType.label,
    tags: tags,
    cover_url: String(d.cover_url || ''),
    author_name: String(d.author_name || 'Equipe do Blog'),
    author_id: String(d.author_id || ''),
    author_photo_url: String(d.author_photo_url || ''),
    reading_time: parseInt(d.reading_time, 10) || 1,
    status: status,
    audio_url: String(d.audio_url || ''),
    tts_enabled: d.tts_enabled !== false && d.tts_enabled !== 'false',
    video_url: String(d.video_url || ''),
    tiktok_video_url: String(d.tiktok_video_url || ''),
    social_copy: SocialCopy.validateCopy(d.social_copy),
    social_modes: d.social_modes && typeof d.social_modes === 'object' && !Array.isArray(d.social_modes)
      ? Object.fromEntries(Object.entries(d.social_modes).filter(([channel, mode]) =>
        SocialCopy.CHANNELS.includes(channel) && ['auto', 'video', 'image', 'link'].includes(mode))) : {},
    github_url: String(d.github_url || ''),
    project_url: String(d.project_url || ''),
    seo_title: String(d.seo_title || ''),
    seo_description: String(d.seo_description || ''),
    cta_label: String(d.cta_label || 'Quero algo parecido'),
    cta_url: String(d.cta_url || 'https://example.com/form-diagnostico'),
    featured: String(d.destaque) === 'true',
    dispatch_newsletter: String(d.dispatch_newsletter) === 'true',
    blog_id: (existing && existing.blog_id) || (d.blog_id ? String(d.blog_id) : DEFAULT_BLOG_ID),
    view_count: (existing && existing.view_count) || 0,
    like_count: (existing && existing.like_count) || 0,
    created_at: (existing && existing.created_at) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  row.auto_translate = d.auto_translate !== false && d.auto_translate !== 'false';
  row.translation_hash = translations.sourceHash(row);
  row.translation_ready = row.auto_translate && existing && existing.translation_hash === row.translation_hash
    ? (existing.translation_ready || []).filter(lang => translations.TARGETS.includes(lang)) : [];
  if (status === 'published') row.published_at = (existing && existing.published_at) || new Date().toISOString();
  else row.published_at = (existing && existing.published_at) || null;
  if (status === 'scheduled' && d.scheduled_at) row.scheduled_at = d.scheduled_at;
  else row.scheduled_at = null;
  return row;
}

function sendJson(res, obj) { res.set('Content-Type', 'application/json; charset=utf-8'); res.status(200).send(JSON.stringify(obj)); }

async function uploadImage(body, res) {
  const encoded = String(body.base64 || '');
  if (!encoded || encoded.length > 11_200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    res.status(400).json({ ok: false, message: 'Imagem inválida ou maior que 8 MB.' }); return;
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 16 || bytes.length > 8 * 1024 * 1024) {
    res.status(400).json({ ok: false, message: 'Imagem inválida ou maior que 8 MB.' }); return;
  }
  let type = '', ext = '';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { type = 'image/png'; ext = 'png'; }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { type = 'image/jpeg'; ext = 'jpg'; }
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { type = 'image/webp'; ext = 'webp'; }
  else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) { type = 'image/gif'; ext = 'gif'; }
  if (!type) { res.status(400).json({ ok: false, message: 'Use PNG, JPEG, WebP ou GIF.' }); return; }
  const bucket = getStorage().bucket('your-firebase-project.firebasestorage.app');
  const objectName = `blog-content/${randomUUID()}.${ext}`;
  const token = randomUUID();
  await bucket.file(objectName).save(bytes, {
    resumable: false,
    contentType: type,
    metadata: { cacheControl: 'public,max-age=31536000,immutable', metadata: { firebaseStorageDownloadTokens: token } }
  });
  sendJson(res, { ok: true, url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}` });
}

async function uploadVideo(body, res) {
  const encoded = String(body.base64 || '');
  if (!encoded || encoded.length > 28_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    res.status(400).json({ ok:false, message:'Vídeo inválido ou maior que 20 MB.' }); return;
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 16 || bytes.length > 20 * 1024 * 1024) {
    res.status(400).json({ ok:false, message:'Vídeo inválido ou maior que 20 MB.' }); return;
  }
  let type = '', ext = '';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') { type = 'video/mp4'; ext = 'mp4'; }
  else if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) { type = 'video/webm'; ext = 'webm'; }
  if (!type) { res.status(400).json({ ok:false, message:'Use MP4 ou WebM.' }); return; }
  const bucket = getStorage().bucket('your-firebase-project.firebasestorage.app');
  const name = `blog-video/${randomUUID()}.${ext}`;
  await bucket.file(name).save(bytes, { resumable:false, contentType:type, metadata:{ cacheControl:'public,max-age=31536000,immutable' } });
  sendJson(res, { ok:true, url:'https://blog.example.com/media/' + name });
}

async function finalizeStudioVideo(body, user, res) {
  const id = String(body.id || '').toLowerCase();
  const ext = String(body.ext || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || !['mp4', 'webm'].includes(ext)) {
    res.status(400).json({ ok: false, message: 'Identificador do vídeo inválido.' }); return;
  }
  const bucket = getStorage().bucket('your-firebase-project.firebasestorage.app');
  const target = bucket.file(`blog-video/${id}.${ext}`);
  const staged = bucket.file(`studio-uploads/${user.uid}/${id}.${ext}`);
  try {
    const [targetExists] = await target.exists();
    if (targetExists) {
      const [meta] = await target.getMetadata();
      if (meta.metadata && meta.metadata.studioOwner === user.uid) {
        sendJson(res, { ok: true, url: `https://blog.example.com/media/blog-video/${id}.${ext}` }); return;
      }
      res.status(409).json({ ok: false, message: 'Identificador de vídeo já utilizado.' }); return;
    }
    const [meta] = await staged.getMetadata();
    const size = Number(meta.size || 0);
    const type = ext === 'mp4' ? 'video/mp4' : 'video/webm';
    if (size < 16 || size > 1024 * 1024 * 1024 || meta.contentType !== type) {
      await staged.delete({ ignoreNotFound: true });
      res.status(400).json({ ok: false, message: 'Vídeo inválido ou maior que 1 GB.' }); return;
    }
    const [header] = await staged.download({ start: 0, end: 15 });
    const valid = ext === 'mp4' ? header.toString('ascii', 4, 8) === 'ftyp'
      : header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
    if (!valid) {
      await staged.delete({ ignoreNotFound: true });
      res.status(400).json({ ok: false, message: 'Formato do vídeo não corresponde a MP4 ou WebM.' }); return;
    }
    await staged.copy(target);
    await target.setMetadata({ contentType: type, cacheControl: 'public,max-age=31536000,immutable', metadata: { studioOwner: user.uid } });
    await staged.delete({ ignoreNotFound: true });
    sendJson(res, { ok: true, url: `https://blog.example.com/media/blog-video/${id}.${ext}` });
  } catch (error) {
    if (error && error.code === 404) { res.status(404).json({ ok: false, message: 'Envio não encontrado. Tente enviar novamente.' }); return; }
    throw error;
  }
}

async function queueTranslations(slug, post) {
  const ready = translations.TARGETS.filter(lang => (post.translation_ready || []).includes(lang));
  if (post.blog_id !== DEFAULT_BLOG_ID || post.auto_translate === false) return { ready, queued: [], failed: [], skipped: true };
  const missing = translations.TARGETS.filter(lang => !ready.includes(lang));
  const outcomes = await Promise.allSettled(missing.map(lang => translationQueue().enqueue(
    { slug, lang, hash: post.translation_hash },
    { id: translationTaskId(slug, post.translation_hash, lang), dispatchDeadlineSeconds: 540 }
  )));
  const queued = [], failed = [];
  outcomes.forEach((result, index) => {
    if (result.status === 'fulfilled' || result.reason && result.reason.code === 'functions/task-already-exists') queued.push(missing[index]);
    else { failed.push(missing[index]); console.error('[translations] falha ao enfileirar', slug, missing[index], result.reason && result.reason.code); }
  });
  return { ready, queued, failed };
}

async function processTranslationTask(request) {
  const { slug, lang, hash } = request.data || {};
  if (!isValidSlug(slug) || !translations.TARGETS.includes(lang) || !/^[a-f0-9]{64}$/.test(String(hash || ''))) return;
  const ref = pdb().doc('posts/' + slug);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;
  const post = snapshot.data();
  if (post.status !== 'published' || post.blog_id !== DEFAULT_BLOG_ID || post.auto_translate === false
      || post.translation_hash !== hash || (post.translation_ready || []).includes(lang)) return;
  const translated = await translations.translatePost(post, lang);
  const saved = await pdb().runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || current.data().status !== 'published' || current.data().translation_hash !== hash
        || (current.data().translation_ready || []).includes(lang)) return false;
    tx.set(ref.collection('translations').doc(lang), translated);
    tx.update(ref, { translation_ready: FieldValue.arrayUnion(lang) });
    return true;
  });
  if (saved) {
    try { await pingPublished(slug, [lang]); }
    catch (err) { console.warn('[translations] indexação pendente', slug, lang, err && err.message); }
  }
}

function pingPublished(slug, ready) {
  return indexnow.ping([SITE_URL + '/artigo/' + slug,
    ...ready.map(lang => SITE_URL + '/' + lang + '/artigo/' + slug), SITE_URL + '/']);
}

async function retryIncompleteTranslations() {
  const snap = await pdb().collection('posts').where('blog_id', '==', DEFAULT_BLOG_ID)
    .where('status', '==', 'published').orderBy('created_at', 'desc').limit(100).get();
  let attempted = 0, completed = 0;
  for (const doc of snap.docs) {
    const post = doc.data();
    if (post.auto_translate === false) continue;
    const hash = translations.sourceHash(post);
    if (post.translation_hash === hash && (post.translation_ready || []).length === translations.TARGETS.length) continue;
    if (attempted >= 20) break;
    attempted++;
    if (post.translation_hash !== hash) { post.translation_hash = hash; post.translation_ready = []; await doc.ref.update({ translation_hash: hash, translation_ready: [] }); }
    const result = await queueTranslations(doc.id, post);
    if (!result.failed.length && result.ready.length === translations.TARGETS.length) completed++;
  }
  console.log('[translations] retry', { attempted, completed });
}

async function handler(req, res, internalAuth) {
  const requireAdmin = internalAuth && internalAuth.requireAdmin || adminModule.requireAdmin_;
  if (['GET','HEAD'].includes(req.method) && /^\/media\/(?:blog-content\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif)|blog-video\/[0-9a-f-]{36}\.(?:mp4|webm))$/.test(req.path || '')) {
    const objectName = String(req.path).replace(/^\/media\//, '');
    try {
      const file = getStorage().bucket('your-firebase-project.firebasestorage.app').file(objectName);
      const [meta] = await file.getMetadata();
      const size = Number(meta.size || 0);
      let start = 0, end = size - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range) {
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : end;
        if (start > end || start >= size) { res.set('Content-Range', 'bytes */' + size); res.status(416).end(); return; }
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.set('Content-Type', meta.contentType || 'application/octet-stream');
      res.set('Cache-Control', 'public,max-age=31536000,immutable');
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD') { res.end(); return; }
      file.createReadStream(range ? { start, end } : {}).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
    } catch (_) { res.status(404).end(); }
    return;
  }
  res.set('Access-Control-Allow-Origin', 'https://blog.example.com');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'Use POST.' }); return; }

  const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
  if (action === 'feedPreview' && req.rawBody && req.rawBody.length > 1024) {
    res.status(413).json({ ok: false, message: 'Solicitação muito grande.' }); return;
  }
  if (['comments', 'commentReplies', 'commentCreate', 'gifSearch'].includes(action) && req.rawBody && req.rawBody.length > 8192) {
    res.status(413).json({ ok: false, message: 'Solicitação muito grande.' }); return;
  }
  if (action === 'resolveVideoLink' && req.rawBody && req.rawBody.length > 2048) {
    res.status(413).json({ ok: false, message: 'Link muito grande.' }); return;
  }
  if (action === 'taxonomyAdd' && req.rawBody && req.rawBody.length > 4096) {
    res.status(413).json({ ok: false, message: 'Taxonomia muito grande.' }); return;
  }
  let body = {};
  try { body = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (e) { body = {}; }

  try {
    const publicActions = new Set(['list', 'taxonomyGet', 'feedPreview', 'related', 'incrementView', 'likes', 'toggleLike', 'comments', 'commentReplies', 'commentCreate', 'gifSearch', 'engagementOpen', 'engagementQualify', 'engagementRead', 'engagementClick', 'engagementStats']);
    let adminUser = null;
    if (!publicActions.has(action)) {
      adminUser = await requireAdmin(req, res);
      if (!adminUser) return;
    }
    if (action === 'uploadImage') { await uploadImage(body, res); return; }
    if (action === 'taxonomyGet') { sendJson(res, { ok: true, taxonomy: await BlogTaxonomy.read(pdb()) }); return; }
    if (action === 'taxonomyAdd') { sendJson(res, { ok: true, taxonomy: await BlogTaxonomy.record(pdb(), body) }); return; }
    if (action === 'resolveVideoLink') {
      try { sendJson(res, { ok: true, url: await resolveShortVideoUrl(body.url) }); }
      catch (error) { sendJson(res, { ok: false, message: error.message || 'Não foi possível abrir o link.' }); }
      return;
    }
    if (action.startsWith('engagement')) { await engagement.handle(action, pdb(), body, res); return; }
    if (action === 'uploadVideo') { await uploadVideo(body, res); return; }
    if (action === 'finalizeStudioVideo') { await finalizeStudioVideo(body, adminUser, res); return; }
    if (action === 'publish') {
      const slug = String((body.data && body.data.slug) || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'Slug inválido.' }); return; }
      const ref = pdb().doc('posts/' + slug);
      const existingSnap = await ref.get();
      const inputData = Object.assign({}, body.data || {});
      if (inputData.video_url && !['youtube','vimeo','drive','file'].includes((LazyMedia.video(inputData.video_url) || {}).provider)) { sendJson(res, { ok: false, message: 'Vídeo inválido. Use YouTube, Vimeo, Google Drive ou vídeo enviado pelo estúdio.' }); return; }
      if (inputData.tiktok_video_url && !validHttps(inputData.tiktok_video_url)) { sendJson(res, { ok: false, message: 'Vídeo próprio do TikTok precisa usar HTTPS.' }); return; }
      if (inputData.audio_url && !LazyMedia.audio(inputData.audio_url)) { sendJson(res, { ok: false, message: 'Áudio inválido. Use Spotify, SoundCloud, YouTube, Drive ou arquivo de áudio HTTPS.' }); return; }
      if (!['cover_url','github_url','project_url'].every(key => validHttps(inputData[key]))) { sendJson(res, { ok: false, message: 'Capa, GitHub e demo precisam usar links HTTPS válidos.' }); return; }
      if (inputData.author_id) {
        // resolve nome/foto no servidor (fonte da verdade), nao confia no que o form mandou
        const authorSnap = await pdb().doc('authors/' + String(inputData.author_id)).get();
        if (authorSnap.exists) {
          const a = authorSnap.data();
          inputData.author_name = a.nickname || a.name || inputData.author_name;
          inputData.author_photo_url = a.photo_url || '';
        } else {
          inputData.author_id = '';
        }
      }
      let row;
      try { row = mapPost(inputData, existingSnap.exists ? existingSnap.data() : null); }
      catch (error) { sendJson(res, { ok: false, message: error.message }); return; }
      if (!row.title) { sendJson(res, { ok: false, message: 'Título é obrigatório.' }); return; }
      await ref.set(row, { merge: true });
      try { await BlogTaxonomy.record(pdb(), { category: row.category,
        postType: { value: row.post_type, label: row.post_type_label }, tags: row.tags }); }
      catch (error) { console.warn('[posts] taxonomia pendente', slug, error && error.message); }
      invalidateRelatedIndex();
      let translation = null;
      if (row.status === 'published' && row.blog_id === DEFAULT_BLOG_ID) {
        translation = await queueTranslations(slug, row);
        try { await pingPublished(slug, translation.ready); }
        catch (err) { console.warn('[posts] indexação pendente', slug, err && err.message); }
      }
      invalidateRelatedIndex();
      sendJson(res, { ok: true, slug: slug, status: row.status, translation });
      return;
    }

    if (action === 'setStatus') {
      const slug = String(body.slug || body.id || '').trim();
      const status = String(body.status || '').trim();
      const allowed = { published: 1, draft: 1, archived: 1, scheduled: 1 };
      if (!isValidSlug(slug) || !allowed[status]) { sendJson(res, { ok: false, message: 'slug/status inválidos' }); return; }
      const ref = pdb().doc('posts/' + slug);
      const current = await ref.get();
      if (!current.exists) { sendJson(res, { ok: false, message: 'Post não encontrado.' }); return; }
      const existing = current.data();
      const hash = translations.sourceHash(existing);
      const patch = { status: status, updated_at: new Date().toISOString(), translation_hash: hash };
      if (existing.translation_hash !== hash) patch.translation_ready = [];
      if (status === 'published') { patch.published_at = new Date().toISOString(); patch.scheduled_at = null; }
      await ref.set(patch, { merge: true });
      invalidateRelatedIndex();
      let translation = null;
      if (status === 'published' && existing.blog_id === DEFAULT_BLOG_ID) {
        translation = await queueTranslations(slug, Object.assign({}, existing, patch));
        try { await pingPublished(slug, translation.ready); }
        catch (err) { console.warn('[posts] indexação pendente', slug, err && err.message); }
      }
      invalidateRelatedIndex();
      sendJson(res, { ok: true, translation });
      return;
    }

    if (action === 'translate') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const ref = pdb().doc('posts/' + slug);
      const snap = await ref.get();
      if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== DEFAULT_BLOG_ID) {
        sendJson(res, { ok: false, message: 'Artigo publicado não encontrado.' }); return;
      }
      const post = snap.data();
      const hash = translations.sourceHash(post);
      if (post.translation_hash !== hash || post.auto_translate === false) {
        await ref.update({ translation_hash: hash, translation_ready: [], auto_translate: true });
        post.translation_ready = [];
        post.translation_hash = hash;
        post.auto_translate = true;
      }
      const translation = await queueTranslations(slug, post);
      invalidateRelatedIndex();
      sendJson(res, { ok: true, translation });
      return;
    }

    if (action === 'list') {
      if (body.status !== 'published' || body.blog_id !== DEFAULT_BLOG_ID) {
        const user = await requireAdmin(req, res, { anyRole: true });
        if (!user) return;
      }
      let q = pdb().collection('posts');
      if (body.blog_id) q = q.where('blog_id', '==', String(body.blog_id));
      if (body.status) q = q.where('status', '==', String(body.status));
      q = q.orderBy('created_at', 'desc').limit(200).select(...LIST_FIELDS);
      const snap = await q.get();
      const arr = []; snap.forEach(function (d) { arr.push(Object.assign({ id: d.id }, d.data())); });
      sendJson(res, { ok: true, posts: arr });
      return;
    }

    if (action === 'feedPreview') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { res.status(400).json({ ok: false, message: 'Artigo inválido.' }); return; }
      const snap = await pdb().doc('posts/' + slug).get();
      if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== DEFAULT_BLOG_ID) {
        res.status(404).json({ ok: false, message: 'Artigo não encontrado.' }); return;
      }
      const post = snap.data();
      sendJson(res, { ok: true, preview: feedExcerpt(post.content) || String(post.excerpt || '').slice(0, 1050) });
      return;
    }

    if (action === 'get') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const snap = await pdb().doc('posts/' + slug).get();
      if (!snap.exists) { sendJson(res, { ok: false, message: 'Post não encontrado.' }); return; }
      sendJson(res, { ok: true, post: Object.assign({ id: snap.id }, snap.data()) });
      return;
    }

    if (action === 'del') {
      const slug = String(body.slug || body.id || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const ref = pdb().doc('posts/' + slug);
      await Promise.all(translations.TARGETS.map(lang => ref.collection('translations').doc(lang).delete()));
      await ref.delete();
      invalidateRelatedIndex();
      sendJson(res, { ok: true });
      return;
    }

    // ── Widgets públicos do artigo (migrados do Supabase em 2026-09-13:
    //    o projeto Supabase pausou por inatividade e derrubou likes/views/
    //    comentários/relacionados, que ainda liam direto do navegador) ──────
    if (action === 'related') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const language = translations.TARGETS.includes(body.language) ? body.language : 'pt-BR';
      const sourceSnap = await pdb().doc('posts/' + slug).get();
      if (!sourceSnap.exists || sourceSnap.data().status !== 'published' || sourceSnap.data().blog_id !== DEFAULT_BLOG_ID) {
        sendJson(res, { ok: false, message: 'Artigo não encontrado.' }); return;
      }
      const pool = await publishedRelatedPool();
      const picked = recommendations.rankRelated(Object.assign({ id: slug }, sourceSnap.data()), pool, 3);
      const localized = await Promise.all(picked.map(async function (post) {
        if (language === 'pt-BR' || !(post.translation_ready || []).includes(language)) return Object.assign({}, post, { language: 'pt-BR' });
        try {
          const translated = await pdb().doc('posts/' + post.id + '/translations/' + language).get();
          if (translated.exists && translated.data().source_hash === post.translation_hash) {
            return Object.assign({}, post, {
              title: translated.data().title || post.title,
              category: translated.data().category || post.category,
              language
            });
          }
        } catch (err) { console.error('[related] tradução indisponível:', err.message); }
        return Object.assign({}, post, { language: 'pt-BR' });
      }));
      sendJson(res, { ok: true, posts: localized.map(post => ({
        slug: post.slug || post.id, title: post.title, category: post.category,
        published_at: post.published_at, reading_time: post.reading_time,
        thumbnail_url: post.thumbnail_url, language: post.language
      })) });
      return;
    }

    if (action === 'incrementView') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const snap = await pdb().doc('posts/' + slug).get();
      if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== DEFAULT_BLOG_ID) {
        sendJson(res, { ok: false, message: 'Post não encontrado.' }); return;
      }
      await pdb().doc('posts/' + slug).update({ view_count: FieldValue.increment(1) });
      sendJson(res, { ok: true });
      return;
    }

    if (action === 'likes') {
      const slug = String(body.slug || '').trim();
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const snap = await pdb().doc('posts/' + slug).get();
      if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== DEFAULT_BLOG_ID) {
        sendJson(res, { ok: false, message: 'Post não encontrado.' }); return;
      }
      sendJson(res, { ok: true, like_count: (snap.exists && snap.data().like_count) || 0 });
      return;
    }

    if (action === 'toggleLike') {
      const slug = String(body.slug || '').trim();
      const delta = body.liked ? 1 : -1;
      if (!isValidSlug(slug)) { sendJson(res, { ok: false, message: 'slug inválido' }); return; }
      const current = await pdb().doc('posts/' + slug).get();
      if (!current.exists || current.data().status !== 'published' || current.data().blog_id !== DEFAULT_BLOG_ID) {
        sendJson(res, { ok: false, message: 'Post não encontrado.' }); return;
      }
      await pdb().doc('posts/' + slug).update({ like_count: FieldValue.increment(delta) });
      const snap = await pdb().doc('posts/' + slug).get();
      sendJson(res, { ok: true, like_count: Math.max(0, (snap.exists && snap.data().like_count) || 0) });
      return;
    }

    if (['comments', 'commentReplies', 'commentCreate', 'gifSearch'].includes(action)) {
      await comments.handle(action, pdb(), req, res, body);
      return;
    }

    sendJson(res, { ok: false, error: 'rota desconhecida: ' + action });
  } catch (err) {
    console.error('[posts]', action, err);
    if (action === 'uploadImage') {
      const message = err && err.code === 404
        ? 'O armazenamento de imagens ainda não está configurado.'
        : 'Não foi possível salvar a imagem no armazenamento. Tente novamente.';
      res.status(503).json({ ok: false, message });
      return;
    }
    if (['comments', 'commentReplies', 'commentCreate', 'gifSearch'].includes(action)) {
      console.error('[comments]', action, err);
      res.status(503).json({ ok: false, message: 'Não foi possível processar a conversa agora.' });
      return;
    }
    sendJson(res, { ok: false, error: err && err.message ? err.message : 'erro interno' });
  }
}

async function publishDueScheduledPosts() {
  const now = new Date().toISOString();
  const due = await pdb().collection('posts').where('status', '==', 'scheduled')
    .where('scheduled_at', '<=', now).orderBy('scheduled_at', 'asc').limit(25).get();
  let published = 0;
  for (const doc of due.docs) {
    const row = await pdb().runTransaction(async transaction => {
      const fresh = await transaction.get(doc.ref);
      if (!fresh.exists) return null;
      const current = fresh.data();
      if (current.blog_id !== DEFAULT_BLOG_ID || current.status !== 'scheduled' ||
          !current.scheduled_at || current.scheduled_at > now) return null;
      const patch = { status:'published', published_at:now, scheduled_at:null, updated_at:now };
      transaction.update(doc.ref, patch);
      return { ...current, ...patch };
    });
    if (!row) continue;
    published++;
    invalidateRelatedIndex();
    try {
      const translation = await queueTranslations(doc.id, row);
      await pingPublished(doc.id, translation.ready);
    } catch (error) { console.warn('[posts] pós-publicação pendente', doc.id, error?.message); }
  }
  return { published };
}

module.exports = { handler: handler, retryIncompleteTranslations, processTranslationTask, publishDueScheduledPosts, feedExcerpt, resolveShortVideoUrl, mapPost };
