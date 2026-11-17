'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { randomUUID } = require('node:crypto');
const { requireAdmin_ } = require('./admin');
const LazyMedia = require('./media-providers');
const SocialCopy = require('./social-copy');
const OwnVideo = require('./own-video');

const CHANNELS = ['facebook', 'instagram', 'x', 'tiktok'];
const FIELDS = ['metaPageId', 'metaPageToken', 'instagramAccountId', 'instagramToken', 'xUserToken', 'tiktokAccessToken', 'tiktokVerifiedDomain'];
const SECRETS = new Set(['metaPageToken', 'instagramToken', 'xUserToken', 'tiktokAccessToken']);
const GRAPH = 'https://graph.facebook.com/v26.0';
let _db;
function db() { if (!_db) _db = getFirestore(); return _db; }
function respond(res, status, body) { res.set('Cache-Control', 'no-store'); res.status(status).json(body); }
function configured(config) {
  return {
    facebook: !!(config.metaPageId && config.metaPageToken),
    instagram: !!(config.instagramAccountId && (config.instagramToken || config.metaPageToken)),
    x: !!config.xUserToken,
    tiktok: !!(config.tiktokAccessToken && config.tiktokVerifiedDomain)
  };
}
function safeConfig(config) {
  const result = { channels: configured(config) };
  for (const key of FIELDS) result[key] = SECRETS.has(key) ? !!config[key] : String(config[key] || '');
  return result;
}
function validId(value) { return /^\d{5,30}$/.test(String(value || '')); }
function validDomain(value) { return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(value || '')); }
function sourceImage(post) { return post.cover_url || ((LazyMedia.video(post.video_url) || {}).thumbnail || ''); }
function tiktokVideo(post, config) {
  const video = String(post.tiktok_video_url || '').trim();
  if (!video) return '';
  try {
    const url = new URL(video);
    if (url.protocol !== 'https:') return '';
    if (url.hostname.toLowerCase() === String(config.tiktokVerifiedDomain || '').toLowerCase()) return url.href;
    return '';
  } catch (_) { return ''; }
}
function postUrl(post) { return 'https://blog.example.com/artigo/' + post.slug; }
function caption(post, max, channel) { return SocialCopy.approved(channel || 'facebook', post).slice(0, max); }
function ownVideo(post) {
  const value = String(post.tiktok_video_url || '');
  return /^https:\/\/blog\.example\.com\/media\/blog-video\/[0-9a-f-]{36}\.mp4$/i.test(value) ? value : '';
}
function mode(post, channel) { return String((post.social_modes || {})[channel] || 'auto'); }
async function call(url, options) {
  const response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(25000) }, options));
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch (_) { data = {}; }
  const apiError = data.error && !(data.error.code === 'ok' || data.error.code === 0);
  if (!response.ok || apiError || data.error_code) {
    const detail = data.error && (data.error.message || data.error) || data.error_description || data.message || ('HTTP ' + response.status);
    throw new Error(String(detail).slice(0, 240));
  }
  return data;
}
function metaOptions(token, params) {
  return { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) };
}
async function publishFacebook(config, post) {
  const id = config.metaPageId;
  const video = ownVideo(post);
  if (mode(post, 'facebook') === 'video') {
    if (!video) throw new Error('Facebook Reels exige vídeo MP4 próprio enviado pelo editor.');
    const started = await call(GRAPH + '/' + id + '/video_reels', metaOptions(config.metaPageToken, { upload_phase:'start' }));
    if (!started.video_id || !/^https:\/\/rupload\.facebook\.com\//.test(String(started.upload_url || ''))) throw new Error('Meta não iniciou o envio do Reel.');
    await call(started.upload_url, { method:'POST', headers:{ Authorization:'OAuth ' + config.metaPageToken, file_url:video } });
    await call(GRAPH + '/' + id + '/video_reels', metaOptions(config.metaPageToken,
      { upload_phase:'finish', video_id:started.video_id, video_state:'PUBLISHED', title:String(post.title || '').slice(0, 100), description:caption(post, 5000, 'facebook') }));
    return { id:String(started.video_id), accepted:true };
  }
  const image = sourceImage(post);
  const path = image ? '/photos' : '/feed';
  const params = image ? { url: image, caption: caption(post, 5000, 'facebook'), published: 'true' } : { message: caption(post, 5000, 'facebook'), link: postUrl(post) };
  const data = await call(GRAPH + '/' + id + path, metaOptions(config.metaPageToken, params));
  return { id: String(data.post_id || data.id || '') };
}
async function publishInstagram(config, post) {
  const image = sourceImage(post);
  const video = ownVideo(post);
  const reel = mode(post, 'instagram') === 'video';
  if (reel && !video) throw new Error('Instagram Reels exige vídeo MP4 próprio enviado pelo editor.');
  if (!reel && (!image || !/^https:\/\//.test(image))) throw new Error('Instagram exige uma capa HTTPS pública ou thumbnail do YouTube.');
  const id = config.instagramAccountId, token = config.instagramToken || config.metaPageToken;
  const mediaParams = reel ? { media_type:'REELS', video_url:video, caption:caption(post, 2100, 'instagram'), share_to_feed:'true' }
    : { image_url:image, caption:caption(post, 2100, 'instagram') };
  const container = await call(GRAPH + '/' + id + '/media', metaOptions(token, mediaParams));
  if (!container.id) throw new Error('Instagram não criou o contêiner da mídia.');
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const status = await call(GRAPH + '/' + container.id + '?fields=status_code', { headers: { Authorization: 'Bearer ' + token } });
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error('Instagram não conseguiu processar a imagem.');
    if (i === 11) throw Object.assign(new Error('Instagram ainda está processando a mídia. Confira o canal antes de tentar novamente.'), { uncertain:true });
  }
  const data = await call(GRAPH + '/' + id + '/media_publish', metaOptions(token, { creation_id: container.id }));
  return { id: String(data.id || '') };
}
async function publishX(config, post) {
  let mediaId = '';
  if (mode(post, 'x') === 'video') {
    const bytes = await OwnVideo.read(post.tiktok_video_url);
    const headers = { Authorization:'Bearer ' + config.xUserToken };
    const init = await call('https://api.x.com/2/media/upload/initialize', { method:'POST', headers:Object.assign({ 'Content-Type':'application/json' }, headers),
      body:JSON.stringify({ media_type:'video/mp4', total_bytes:bytes.length, media_category:'tweet_video' }) });
    mediaId = String(init.data && init.data.id || '');
    if (!/^\d+$/.test(mediaId)) throw new Error('X não iniciou o envio do vídeo.');
    for (let offset = 0, index = 0; offset < bytes.length; offset += 4 * 1024 * 1024, index++) {
      const form = new FormData();
      form.set('segment_index', String(index));
      form.set('media', new Blob([bytes.subarray(offset, offset + 4 * 1024 * 1024)], { type:'application/octet-stream' }), 'part.mp4');
      await call('https://api.x.com/2/media/upload/' + mediaId + '/append', { method:'POST', headers, body:form });
    }
    let status = await call('https://api.x.com/2/media/upload/' + mediaId + '/finalize', { method:'POST', headers });
    for (let i = 0; status.data && status.data.processing_info && status.data.processing_info.state !== 'succeeded'; i++) {
      const info = status.data.processing_info;
      if (info.state === 'failed') throw new Error('X não conseguiu processar o vídeo.');
      if (i >= 8) throw new Error('O vídeo continua em processamento no X. Confira o canal antes de tentar publicar novamente.');
      await new Promise(resolve => setTimeout(resolve, Math.min(8000, Math.max(1000, Number(info.check_after_secs || 2) * 1000))));
      status = await call('https://api.x.com/2/media/upload?command=STATUS&media_id=' + mediaId, { headers });
    }
  }
  const data = await call('https://api.x.com/2/tweets', {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.xUserToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ text: caption(post, 270, 'x') }, mediaId ? { media:{ media_ids:[mediaId] } } : {}))
  });
  return { id: String((data.data && data.data.id) || '') };
}
async function tikTokCreator(config) {
  return call('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method:'POST', headers:{ Authorization:'Bearer ' + config.tiktokAccessToken, 'Content-Type':'application/json; charset=UTF-8' }
  });
}
async function publishTikTok(config, post, options) {
  const video = tiktokVideo(post, config);
  if (!video) throw new Error('Anexe um vídeo próprio no domínio verificado da aplicação TikTok.');
  const headers = { Authorization: 'Bearer ' + config.tiktokAccessToken, 'Content-Type': 'application/json; charset=UTF-8' };
  const creator = await tikTokCreator(config);
  const privacy = (creator.data && creator.data.privacy_level_options) || [];
  const selectedPrivacy = String((options && options.privacyLevel) || '');
  if (!privacy.includes(selectedPrivacy)) throw new Error('Escolha uma opção de privacidade permitida pela conta TikTok.');
  const data = await call('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST', headers,
    body: JSON.stringify({ post_info: { title: caption(post, 2100, 'tiktok'), privacy_level: selectedPrivacy, disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: 'PULL_FROM_URL', video_url: video } })
  });
  return { id: String((data.data && data.data.publish_id) || ''), accepted: true };
}
const PUBLISHERS = { facebook: publishFacebook, instagram: publishInstagram, x: publishX, tiktok: publishTikTok };

async function publishChannel(channel, post, config, options) {
  const ref = db().doc('social_publications/' + post.slug + '_' + channel);
  const lease = randomUUID();
  const decision = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const previous = snap.exists ? snap.data() : {};
    if (previous.status === 'published' || previous.status === 'accepted') return { already: true, previous };
    if (previous.status === 'pending' || previous.status === 'unknown') return { blocked: true };
    tx.set(ref, { status: 'pending', lease, slug: post.slug, channel, startedAt: new Date().toISOString() });
    return {};
  });
  if (decision.already) return { ok: true, already: true, status: decision.previous.status, id: decision.previous.externalId || '' };
  if (decision.blocked) return { ok: false, message: 'Publicação anterior pendente ou incerta. Confira a rede antes de tentar novamente.' };
  try {
    const result = await PUBLISHERS[channel](config, post, options);
    if (!result.id) throw Object.assign(new Error('A plataforma aceitou o pedido sem devolver um identificador. Confira o canal antes de tentar novamente.'), { uncertain:true });
    await ref.set({ status: result.accepted ? 'accepted' : 'published', externalId: result.id, completedAt: new Date().toISOString() }, { merge: true });
    return { ok: true, status: result.accepted ? 'accepted' : 'published', id: result.id };
  } catch (error) {
    const uncertain = !!error.uncertain || /timeout|abort|network|fetch failed/i.test(String(error.message || error.name));
    await ref.set({ status: uncertain ? 'unknown' : 'failed', error: String(error.message || 'Falha').slice(0, 240), completedAt: new Date().toISOString() }, { merge: true });
    return { ok: false, message: String(error.message || 'Falha no canal').slice(0, 240), uncertain };
  }
}

async function handler(req, res) {
  res.set('Access-Control-Allow-Origin', 'https://blog.example.com');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const user = await requireAdmin_(req, res); if (!user) return;
  const action = String(req.path || '').replace(/\/+$/, '').split('/').pop();
  try {
    if (action === 'draft') {
      if (req.method !== 'POST') return respond(res, 405, { ok:false, message:'Use POST.' });
      const input = req.body || {};
      const post = { title:String(input.title || '').slice(0, 300), excerpt:String(input.excerpt || '').slice(0, 500),
        content:String(input.content || '').slice(0, 60000), slug:String(input.slug || '').slice(0, 200) };
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) || !post.title) return respond(res, 400, { ok:false, message:'Informe título e slug antes de preparar as redes.' });
      return respond(res, 200, { ok:true, drafts:Object.fromEntries(SocialCopy.CHANNELS.map(channel => [channel, SocialCopy.draft(channel, post)])) });
    }
    if (action === 'config') {
      const ref = db().doc('config/social');
      if (req.method === 'GET') {
        const snap = await ref.get(); return respond(res, 200, { ok: true, config: safeConfig(snap.exists ? snap.data() : {}) });
      }
      if (req.method !== 'POST') return respond(res, 405, { ok: false, message: 'Use GET ou POST.' });
      const input = req.body || {};
      const patch = {};
      for (const key of FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const value = String(input[key] || '').trim();
        if (value.length > 4096) return respond(res, 400, { ok: false, message: 'Campo muito longo: ' + key });
        if (key === 'metaPageId' || key === 'instagramAccountId') {
          if (value && !validId(value)) return respond(res, 400, { ok: false, message: 'ID de conta Meta inválido.' });
        }
        if (key === 'tiktokVerifiedDomain' && value && !validDomain(value)) return respond(res, 400, { ok: false, message: 'Domínio TikTok inválido.' });
        if (!SECRETS.has(key) || value) patch[key] = value;
      }
      if (Array.isArray(input.clearSecrets)) for (const key of input.clearSecrets) if (SECRETS.has(key)) patch[key] = '';
      patch.updatedAt = new Date().toISOString();
      await ref.set(patch, { merge: true });
      const snap = await ref.get();
      return respond(res, 200, { ok: true, config: safeConfig(snap.data() || {}) });
    }
    if (action === 'publish') {
      if (req.method !== 'POST') return respond(res, 405, { ok: false, message: 'Use POST.' });
      const body = req.body || {};
      const channel = String(body.channel || '');
      const slug = String(body.slug || '');
      if (!CHANNELS.includes(channel) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return respond(res, 400, { ok: false, message: 'Canal ou slug inválido.' });
      const [configSnap, postSnap] = await Promise.all([db().doc('config/social').get(), db().doc('posts/' + slug).get()]);
      const config = configSnap.exists ? configSnap.data() : {};
      const post = postSnap.exists ? postSnap.data() : null;
      if (!post || post.status !== 'published' || post.blog_id !== 'your-blog') return respond(res, 404, { ok: false, message: 'Artigo publicado não encontrado.' });
      if (!configured(config)[channel]) return respond(res, 400, { ok: false, message: 'Configure o canal em Configurações antes de publicar.' });
      return respond(res, 200, await publishChannel(channel, Object.assign({}, post, { slug }), config, { privacyLevel: body.privacyLevel }));
    }
    if (action === 'creator') {
      if (req.method !== 'GET') return respond(res, 405, { ok:false, message:'Use GET.' });
      const snap = await db().doc('config/social').get();
      const config = snap.exists ? snap.data() : {};
      if (!configured(config).tiktok) return respond(res, 400, { ok:false, message:'Configure o TikTok antes.' });
      const data = await tikTokCreator(config);
      const options = (data.data && data.data.privacy_level_options) || [];
      return respond(res, 200, { ok:true, privacyLevels:options.filter(v => ['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'].includes(v)) });
    }
    return respond(res, 404, { ok: false, message: 'Ação desconhecida.' });
  } catch (error) {
    console.error('[social]', action, error);
    return respond(res, 500, { ok: false, message: 'Falha na integração. Consulte os logs.' });
  }
}

module.exports = { handler, configured, safeConfig, caption, sourceImage, tiktokVideo, publishChannel, publishFacebook, publishInstagram, publishX, publishTikTok };
