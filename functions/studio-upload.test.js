const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const files = new Map();
const bucket = { file(name) {
  return {
    async exists() { return [files.has(name)]; },
    async getMetadata() {
      const value = files.get(name);
      if (!value) throw Object.assign(new Error('missing'), { code: 404 });
      return [{ size: String(value.bytes.length), contentType: value.type, metadata: value.metadata || {} }];
    },
    async download() { return [files.get(name).bytes.subarray(0, 16)]; },
    async copy(target) { files.set(target.name, { ...files.get(name) }); },
    async setMetadata(meta) { files.get(name).type = meta.contentType; files.get(name).metadata = meta.metadata; },
    async delete() { files.delete(name); },
    name
  };
} };
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (parent?.filename?.endsWith('posts.js')) {
    if (name === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => bucket }) };
    if (name === './admin') return { requireAdmin_: async (req, res) => req.headers.authorization === 'Bearer owner' ? { uid: 'owner' } : (res.status(401).json({ ok: false }), null) };
  }
  return originalLoad(name, parent, isMain);
};
const posts = require('./posts');
Module._load = originalLoad;
function response() { return { statusCode: 200, body: null, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, send(raw) { this.body = JSON.parse(raw); return this; } }; }
function req(authorization, body) { return { method: 'POST', path: '/api/posts/finalizeStudioVideo', headers: authorization ? { authorization } : {}, body }; }
const id = '12345678-1234-1234-1234-123456789abc';
const stage = `studio-uploads/owner/${id}.webm`;
const final = `blog-video/${id}.webm`;

test('gravação grande só é publicada após autenticação e validação do cabeçalho', async () => {
  const header = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(20)]);
  files.set(stage, { bytes: header, type: 'video/webm' });
  const anonymous = response(); await posts.handler(req('', { id, ext: 'webm' }), anonymous);
  assert.equal(anonymous.statusCode, 401); assert.equal(files.has(final), false);
  const authorized = response(); await posts.handler(req('Bearer owner', { id, ext: 'webm' }), authorized);
  assert.equal(authorized.body.ok, true);
  assert.equal(authorized.body.url, `https://blog.example.com/media/${final}`);
  assert.equal(files.has(stage), false); assert.equal(files.get(final).metadata.studioOwner, 'owner');
  const retry = response(); await posts.handler(req('Bearer owner', { id, ext: 'webm' }), retry);
  assert.equal(retry.body.url, authorized.body.url);
});

test('recusa vídeo com extensão correta e conteúdo incompatível', async () => {
  const badId = 'aaaaaaaa-1234-1234-1234-123456789abc';
  files.set(`studio-uploads/owner/${badId}.mp4`, { bytes: Buffer.from('<html>not a video</html>'), type: 'video/mp4' });
  const res = response(); await posts.handler(req('Bearer owner', { id: badId, ext: 'mp4' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(files.has(`blog-video/${badId}.mp4`), false);
  assert.equal(files.has(`studio-uploads/owner/${badId}.mp4`), false);
});

test('não aceita caminho arbitrário para finalizar upload', async () => {
  const res = response(); await posts.handler(req('Bearer owner', { id: '../../secret', ext: 'webm' }), res);
  assert.equal(res.statusCode, 400);
});
