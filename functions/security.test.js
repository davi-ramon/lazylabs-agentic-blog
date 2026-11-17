const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Os handlers devem recusar requisições antes de tocar no Firestore ou em APIs externas.
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (name === 'firebase-admin/app') return { getApps: () => [{}], initializeApp: () => ({}) };
  if (name === 'firebase-admin/firestore') return {
    getFirestore: () => { throw new Error('Firestore não deveria ser acessado'); },
    FieldValue: { increment: () => {}, serverTimestamp: () => {}, arrayUnion: () => {} }
  };
  if (name === 'firebase-admin/auth') return { getAuth: () => ({
    verifyIdToken: async (token) => {
      if (token === 'owner') return { uid: 'owner', email: 'owner@example.com', email_verified: true, role: 'admin' };
      if (token === 'viewer') return { uid: 'viewer', email: 'viewer@example.com', role: 'viewer' };
      throw new Error('invalid token');
    }
  }) };
  return originalLoad(name, parent, isMain);
};
const admin = require('./admin');
const posts = require('./posts');
const functions = require('./index');
const davi = require('./davi');
const agent = require('./agent');
const transcribe = require('./transcribe');
const whatsapp = require('./whatsapp');
Module._load = originalLoad;

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = v; return this; },
    get(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

async function request(handler, path, body, headers, method) {
  const req = { method: method || 'POST', path, url: path, headers: headers || {}, body: body || {} };
  const res = response();
  await handler(req, res);
  return res;
}

test('ID token do dono é aceito; viewer não administra; cabeçalho fixo não autentica', async () => {
  let res = await request(admin.handler, '/api/admin/session', {}, { 'x-ll-admin': '1' }, 'GET');
  assert.equal(res.statusCode, 401);
  res = await request(admin.handler, '/api/admin/session', {}, { authorization: 'Bearer owner' }, 'GET');
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).user.role, 'admin');
  res = await request(posts.handler, '/api/posts/publish', { data: { slug: 'x' } }, { authorization: 'Bearer viewer' });
  assert.equal(res.statusCode, 403);
});

test('rotas de gestão recusam chamada anônima', async () => {
  const routes = [
    [posts.handler, '/api/posts/publish', { data: { slug: 'x' } }],
    [posts.handler, '/api/posts/del', { slug: 'x' }],
    [posts.handler, '/api/posts/get', { slug: 'x' }],
    [posts.handler, '/api/posts/translate', { slug: 'x' }],
    [functions.campaigns, '/api/campaigns/send', {}],
    [functions.linkedin, '/api/linkedin/publish', {}],
    [functions.bio, '/api/bio/save', {}],
    [functions.form, '/api/form/adminConfig', {}],
    [functions.crm, '/api/crm', { action: 'hubBind', data: {} }],
    [davi.handler, '/api/davi/key', {}],
    [agent.handler, '/api/agent', { message: 'teste' }],
    [transcribe.handler, '/api/transcribe', {}],
    [whatsapp.handler, '/api/whatsapp/send', {}]
  ];
  for (const [handler, path, body] of routes) {
    const res = await request(handler, path, body);
    assert.equal(res.statusCode, 401, path);
  }
});

test('transcrição rejeita áudio grande ou malformado antes de acessar provedor externo', async () => {
  let res = await request(transcribe.handler, '/api/transcribe', { base64: 'not-base64!', mimeType: 'audio/webm' }, { authorization: 'Bearer owner' });
  assert.equal(res.statusCode, 400);
  res = await request(transcribe.handler, '/api/transcribe', { base64: 'YWJj', mimeType: 'text/html' }, { authorization: 'Bearer owner' });
  assert.equal(res.statusCode, 400);
  res = response();
  await transcribe.handler({ method: 'POST', path: '/api/transcribe', headers: { authorization: 'Bearer owner' }, rawBody: Buffer.alloc(8_400_001) }, res);
  assert.equal(res.statusCode, 413);
});

test('login e reset legados estão desativados', async () => {
  for (const path of ['/api/admin/login', '/api/admin/reset', '/api/admin/verify', '/api/admin/setnew']) {
    const res = await request(admin.handler, path);
    assert.equal(res.statusCode, 410, path);
  }
  for (const path of ['/api/v1/posts', '/api']) {
    const res = await request(admin.handler, path);
    assert.equal(res.statusCode, 404, path);
  }
});
