'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const oldLoad = Module._load;
Module._load = function (id, parent, main) {
  if (id === './admin' && parent?.filename.endsWith('agent-api.js'))
    return { requireAdmin_:async (req, res) => {
      if (req.headers.authorization === 'Bearer firebase-admin-test') return { uid:'owner' };
      res.status(403).json({ ok:false }); return null;
    } };
  return oldLoad.apply(this, arguments);
};
const api = require('./agent-api');
Module._load = oldLoad;

function fakeDb() {
  const docs = new Map();
  const db = {
    doc(path) {
      const ref = {
        id:path.split('/').pop(),
        async get() { return { exists:docs.has(path), id:ref.id, data:() => docs.get(path), ref }; },
        async create(data) { if (docs.has(path)) { const e = new Error('exists'); e.code = 6; throw e; } docs.set(path, data); },
        async set(data, options) { docs.set(path, options?.merge ? { ...docs.get(path), ...data } : data); }
      };
      return ref;
    },
    collection(name) { return { orderBy() { return this; }, limit() { return this; },
      async get() { return { docs:[...docs].filter(([path]) => path.startsWith(name + '/')).map(([path, data]) => ({ id:path.split('/').pop(), data:() => data })) }; }
    }; }
  };
  return { db, docs };
}
function response() { return { code:200, headers:{}, body:null,
  set(k,v) { this.headers[k]=v; return this; }, status(v) { this.code=v; return this; },
  json(v) { this.body=v; return this; }, send(v) { this.body=v; return this; }
}; }
async function call(db, method, path, body, token, services = {}) {
  const req = { method, body:body || {}, query:{}, headers:token ? { authorization:'Bearer ' + token } : {} };
  Object.defineProperty(req, 'path', { get:() => '/api/v1' + path });
  const res = response(); await api.handler(req, res, { db, ...services }); return res;
}

test('token só aparece na emissão, escopos e revogação são aplicados', async () => {
  const { db, docs } = fakeDb();
  let r = await call(db, 'POST', '/tokens', { label:'editor', scopes:['posts:read'], expiresInDays:30 }, 'firebase-admin-test');
  assert.equal(r.code, 201);
  const raw = r.body.token, id = r.body.id;
  assert.match(raw, /^llb_/);
  assert.equal(docs.get('api_tokens/' + id).hash, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(JSON.stringify(docs.get('api_tokens/' + id)).includes(raw), false);
  r = await call(db, 'GET', '/tokens', {}, 'firebase-admin-test');
  assert.equal(r.body.tokens[0].hash, undefined);
  assert.equal(r.body.tokens[0].token, undefined);
  r = await call(db, 'GET', '/capabilities', {}, raw);
  assert.deepEqual(r.body.scopes, ['posts:read']);
  r = await call(db, 'POST', '/posts', { slug:'new-post', title:'A', content_html:'<p>B</p>' }, raw);
  assert.equal(r.code, 403);
  r = await call(db, 'DELETE', '/tokens/' + id, {}, 'firebase-admin-test');
  assert.equal(r.code, 200);
  r = await call(db, 'GET', '/capabilities', {}, raw);
  assert.equal(r.code, 401);
});

test('agendamento e publicação exigem escopos separados', async () => {
  const { db, docs } = fakeDb();
  const id = '1234567890abcdef12345678', raw = `llb_${id}_${crypto.randomBytes(32).toString('base64url')}`;
  docs.set('api_tokens/' + id, { hash:crypto.createHash('sha256').update(raw).digest('hex'), blogId:'lazylabs-blog',
    scopes:['posts:schedule'], expiresAt:new Date(Date.now()+86400000).toISOString() });
  docs.set('posts/existing-post', { blog_id:'lazylabs-blog', status:'draft', title:'Artigo', content:'<p>Texto</p>', tags:[] });
  const calls = [];
  const posts = { async handler(req, res) { calls.push({ path:req.path, body:req.body }); res.status(200).json({ ok:true }); } };
  let r = await call(db, 'POST', '/posts/existing-post/schedule', { scheduled_at:new Date(Date.now()+3600000).toISOString() }, raw, { posts });
  assert.equal(r.code, 200);
  assert.equal(calls[0].body.data.status, 'scheduled');
  assert.ok(calls[0].body.data.scheduled_at);
  r = await call(db, 'POST', '/posts/existing-post/publish', {}, raw, { posts });
  assert.equal(r.code, 403);
});

test('incorporação só aceita provedor conhecido e requer escopo', async () => {
  const { db, docs } = fakeDb();
  const id = '1234567890abcdef12345678', raw = `llb_${id}_${crypto.randomBytes(32).toString('base64url')}`;
  docs.set('api_tokens/' + id, { hash:crypto.createHash('sha256').update(raw).digest('hex'), blogId:'lazylabs-blog',
    scopes:['media:write'], expiresAt:new Date(Date.now()+86400000).toISOString() });
  let r = await call(db, 'POST', '/media/embed', { url:'https://www.youtube.com/shorts/dQw4w9WgXcQ' }, raw);
  assert.equal(r.code, 200);
  assert.match(r.body.html, /youtube-nocookie\.com\/embed/);
  r = await call(db, 'POST', '/media/embed', { url:'https://evil.example/video' }, raw);
  assert.equal(r.code, 400);
});
