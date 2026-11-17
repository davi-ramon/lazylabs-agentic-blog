'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('./media-providers');
const social = require('./social');
const copy = require('./social-copy');
const ownVideo = require('./own-video');

test('channel drafts reflect the article and keep the canonical link only where useful', () => {
  const post = { slug:'crm-em-go', title:'Recriando um CRM em Go', excerpt:'Uma migração com Firestore.',
    content:'<p>Eu reconstruí a API do CRM em Go e preservei as regras de negócio.</p><p>O painel continua em React.</p>' };
  const linkedin = copy.draft('linkedin', post);
  assert.match(linkedin, /reconstruí a API/);
  assert.match(linkedin, /https:\/\/blog\.example\.com\/artigo\/crm-em-go/);
  assert.ok(copy.draft('x', post).length <= copy.LIMITS.x);
  assert.doesNotMatch(copy.draft('instagram', post), /https:\/\//);
  assert.equal(copy.approved('linkedin', { ...post, social_copy:{ linkedin:'Texto editado pelo autor.' } }),
    'Texto editado pelo autor.\n\nArtigo completo: https://blog.example.com/artigo/crm-em-go');
  assert.throws(() => copy.validateCopy({ x:'a'.repeat(271) }), /inválido/);
});

test('Facebook publishes an own MP4 as a Reel only when selected', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = calls.length === 1 ? { video_id:'123456', upload_url:'https://rupload.facebook.com/video-upload/test' } : { success:true };
    return { ok:true, status:200, text:async () => JSON.stringify(data) };
  };
  try {
    const post = { slug:'video-proprio', title:'Projeto com vídeo', excerpt:'Resumo', social_modes:{ facebook:'video' },
      tiktok_video_url:'https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.mp4' };
    const result = await social.publishFacebook({ metaPageId:'12345', metaPageToken:'secret' }, post);
    assert.equal(result.id, '123456');
    assert.equal(result.accepted, true);
    assert.match(calls[0].url, /\/video_reels$/);
    assert.equal(calls[1].options.headers.file_url, post.tiktok_video_url);
    assert.match(calls[2].options.body.get('description'), /https:\/\/blog.example.com\/artigo\/video-proprio/);
  } finally { global.fetch = originalFetch; }
});

test('X attaches the uploaded own MP4 to the short article post', async () => {
  const originalFetch = global.fetch, originalRead = ownVideo.read;
  const calls = [];
  ownVideo.read = async () => Buffer.from('0000ftyp' + 'x'.repeat(100));
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/initialize') ? { data:{ id:'123' } }
      : url.endsWith('/finalize') ? { data:{ id:'123', processing_info:{ state:'succeeded' } } }
      : url.endsWith('/2/tweets') ? { data:{ id:'tweet-video' } } : {};
    return { ok:true, status:200, text:async () => JSON.stringify(data) };
  };
  try {
    const post = { slug:'artigo-com-video', title:'Título', social_modes:{ x:'video' },
      tiktok_video_url:'https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.mp4' };
    assert.equal((await social.publishX({ xUserToken:'user-token' }, post)).id, 'tweet-video');
    assert.match(calls[1].url, /\/123\/append$/);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body).media.media_ids, ['123']);
  } finally { global.fetch = originalFetch; ownVideo.read = originalRead; }
});

test('player accepts known providers and rejects lookalike hosts', () => {
  assert.equal(media.video('https://youtu.be/abcdefghijk').provider, 'youtube');
  assert.equal(media.video('https://vimeo.com/123456789').src, 'https://player.vimeo.com/video/123456789');
  assert.equal(media.video('https://drive.google.com/file/d/abcdefghijk123/preview').provider, 'drive');
  assert.equal(media.video('https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.webm').provider, 'file');
  assert.equal(require('../public/media-providers').video('https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.mp4').provider, 'file');
  assert.equal(media.video('https://blog.example.com.evil.test/media/blog-video/12345678-1234-1234-1234-123456789abc.webm'), null);
  assert.equal(media.audio('https://open.spotify.com/episode/abc123').provider, 'spotify');
  assert.equal(media.audio('https://www.youtube.com/watch?v=abcdefghijk').provider, 'youtube');
  assert.equal(media.video('https://youtube.com.evil.test/watch?v=abcdefghijk'), null);
  assert.equal(media.video('javascript:alert(1)'), null);
  assert.equal(media.audio('https://soundcloud.com.evil.test/artist/track'), null);
});

test('social configuration never returns saved tokens and image favors the blog cover', () => {
  const config = { metaPageId:'123456789', metaPageToken:'secret', instagramAccountId:'987654321', xUserToken:'x-secret' };
  assert.deepEqual(social.configured(config), { facebook:true, instagram:true, x:true, tiktok:false });
  const visible = social.safeConfig(config);
  assert.equal(visible.metaPageToken, true);
  assert.equal(visible.xUserToken, true);
  assert.doesNotMatch(JSON.stringify(visible), /secret/);
  const post = { slug:'meu-artigo', title:'Título', excerpt:'Resumo', cover_url:'https://blog.example.com/capa.jpg', video_url:'https://youtu.be/abcdefghijk' };
  assert.equal(social.sourceImage(post), post.cover_url);
  assert.match(social.caption(post, 200), /https:\/\/blog.example.com\/artigo\/meu-artigo/);
  const ownVideo = 'https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.mp4';
  assert.equal(social.tiktokVideo({ tiktok_video_url:ownVideo }, { tiktokVerifiedDomain:'blog.example.com' }), ownVideo);
  assert.equal(social.tiktokVideo({ tiktok_video_url:'https://youtu.be/abcdefghijk' }, { tiktokVerifiedDomain:'blog.example.com' }), '');
});

test('Facebook posts the cover and X posts a link with user authorization', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok:true, status:200, text: async () => JSON.stringify(url.includes('graph.facebook') ? { id:'fb-photo-1', post_id:'fb-post-1' } : { data:{ id:'tweet-1' } }) };
  };
  try {
    const post = { slug:'meu-artigo', title:'Título', excerpt:'Resumo', cover_url:'https://blog.example.com/capa.jpg' };
    assert.equal((await social.publishFacebook({ metaPageId:'12345', metaPageToken:'page-token' }, post)).id, 'fb-post-1');
    assert.equal((await social.publishX({ xUserToken:'user-token' }, post)).id, 'tweet-1');
    assert.match(requests[0].url, /\/12345\/photos$/);
    assert.equal(requests[0].options.body.get('url'), post.cover_url);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer user-token');
    assert.match(JSON.parse(requests[1].options.body).text, /https:\/\/blog.example.com\/artigo\/meu-artigo/);
  } finally { global.fetch = originalFetch; }
});

test('social settings reject requests without an administrator session', async () => {
  const res = { statusCode:200, body:null, set() { return this; }, status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }, send(data) { this.body = data; return this; } };
  await social.handler({ method:'GET', path:'/api/social/config', headers:{} }, res);
  assert.equal(res.statusCode, 401);
});

test('TikTok direct post sends only the original video URL', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok:true, status:200, text:async () => JSON.stringify(url.includes('creator_info')
      ? { data:{ privacy_level_options:['PUBLIC_TO_EVERYONE'] }, error:{ code:'ok', message:'' } }
      : { data:{ publish_id:'publish-1' }, error:{ code:'ok', message:'' } }) };
  };
  try {
    const post = { slug:'meu-artigo', title:'Projeto', excerpt:'Resumo', cover_url:'https://blog.example.com/capa.png',
      tiktok_video_url:'https://blog.example.com/media/blog-video/12345678-1234-1234-1234-123456789abc.mp4' };
    const result = await social.publishTikTok({ tiktokAccessToken:'user-token', tiktokVerifiedDomain:'blog.example.com' }, post, { privacyLevel:'PUBLIC_TO_EVERYONE' });
    assert.equal(result.accepted, true);
    assert.match(calls[1].url, /\/video\/init\/$/);
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.source_info.video_url, post.tiktok_video_url);
    assert.equal(body.source_info.source, 'PULL_FROM_URL');
    assert.equal(body.media_type, undefined);
  } finally { global.fetch = originalFetch; }
});
