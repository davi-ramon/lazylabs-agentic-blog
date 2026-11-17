const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let saved = null;
let saveError = null;
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (parent?.filename?.endsWith('posts.js')) {
    if (name === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => ({ name: 'your-firebase-project.firebasestorage.app', file: path => ({ save: async (bytes, options) => { if (saveError) throw saveError; saved = { path, bytes, options }; } }) }) }) };
    if (name === './admin') return { requireAdmin_: async (req, res) => req.headers.authorization === 'Bearer owner' ? { uid: 'owner' } : (res.status(401).json({ ok: false }), null) };
  }
  return originalLoad(name, parent, isMain);
};
const posts = require('./posts');
Module._load = originalLoad;

function response() { return { statusCode: 200, body: null, set() { return this; }, status(n) { this.statusCode = n; return this; }, send(text) { this.body = JSON.parse(text); return this; }, json(body) { this.body = body; return this; } }; }
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

test('upload de imagem exige admin e grava PNG com token de leitura', async () => {
  const anonymous = response();
  await posts.handler({ method: 'POST', path: '/api/posts/uploadImage', headers: {}, body: { base64: png.toString('base64') } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(saved, null);
  const authorized = response();
  await posts.handler({ method: 'POST', path: '/api/posts/uploadImage', headers: { authorization: 'Bearer owner' }, body: { base64: png.toString('base64') } }, authorized);
  assert.equal(authorized.body.ok, true);
  assert.match(authorized.body.url, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/your-firebase-project\.firebasestorage\.app\/o\/blog-content%2F/);
  assert.match(saved.path, /^blog-content\/[0-9a-f-]+\.png$/);
  assert.equal(saved.options.contentType, 'image/png');
  assert.ok(saved.options.metadata.metadata.firebaseStorageDownloadTokens);
});

test('upload rejeita SVG e tipos não permitidos', async () => {
  const bad = response();
  await posts.handler({ method: 'POST', path: '/api/posts/uploadImage', headers: { authorization: 'Bearer owner' }, body: { base64: Buffer.from('<svg><script>x</script></svg>').toString('base64') } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.ok, false);
});

test('upload informa falta do bucket sem expor erro interno', async () => {
  saveError = Object.assign(new Error('The specified bucket does not exist.'), { code: 404 });
  try {
    const missing = response();
    const originalError = console.error;
    console.error = () => {};
    try {
      await posts.handler({ method: 'POST', path: '/api/posts/uploadImage', headers: { authorization: 'Bearer owner' }, body: { base64: png.toString('base64') } }, missing);
    } finally { console.error = originalError; }
    assert.equal(missing.statusCode, 503);
    assert.deepEqual(missing.body, { ok: false, message: 'O armazenamento de imagens ainda não está configurado.' });
  } finally { saveError = null; }
});

test('upload de vídeo próprio exige admin e grava MP4 para o TikTok', async () => {
  const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
  saved = null;
  const anonymous = response();
  await posts.handler({ method:'POST', path:'/api/posts/uploadVideo', headers:{}, body:{ base64:mp4.toString('base64') } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(saved, null);
  const authorized = response();
  await posts.handler({ method:'POST', path:'/api/posts/uploadVideo', headers:{ authorization:'Bearer owner' }, body:{ base64:mp4.toString('base64') } }, authorized);
  assert.equal(authorized.body.ok, true);
  assert.match(authorized.body.url, /^https:\/\/blog\.example\.com\/media\/blog-video\/[0-9a-f-]+\.mp4$/);
  assert.equal(saved.options.contentType, 'video/mp4');
});
