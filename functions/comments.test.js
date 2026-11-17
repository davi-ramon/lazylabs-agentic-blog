const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const comments = require('./comments');
process.env.COMMENT_RATE_SECRET = 'test-secret-'.repeat(6);

function fakeDb() {
  const records = new Map(); let sequence = 0;
  const doc = path => ({
    id: path.split('/').pop(), path,
    get: async () => ({ id: path.split('/').pop(), exists: records.has(path), data: () => records.get(path) }),
    collection: name => collection(path + '/' + name)
  });
  const collection = path => ({
    doc: id => doc(path + '/' + (id || `auto${++sequence}`)),
    orderBy: (field, direction) => {
      const state = { field, direction, limit: 100, after: null };
      const query = {
        limit(n) { state.limit = n; return query; },
        startAfter(snap) { state.after = snap.id; return query; },
        async get() {
          let items = [...records.entries()].filter(([key]) => key.startsWith(path + '/') && key.slice(path.length + 1).indexOf('/') < 0)
            .map(([key, value]) => ({ id: key.split('/').pop(), data: () => value }));
          items.sort((a, b) => String(a.data()[field]).localeCompare(String(b.data()[field])) * (direction === 'desc' ? -1 : 1));
          if (state.after) items = items.slice(items.findIndex(x => x.id === state.after) + 1);
          return { docs: items.slice(0, state.limit) };
        }
      };
      return query;
    }
  });
  const db = { doc, collection, records,
    async runTransaction(fn) {
      const writes = [];
      const tx = { get: ref => ref.get(), set: (ref, value) => writes.push([ref.path, value]),
        update: (ref, value) => writes.push([ref.path, { ...records.get(ref.path), reply_count: (records.get(ref.path).reply_count || 0) + (value.reply_count ? 1 : 0) }]) };
      const result = await fn(tx); writes.forEach(([path, value]) => records.set(path, value)); return result;
    }
  };
  records.set('posts/example', { status: 'published', blog_id: 'your-blog' });
  return db;
}
async function call(db, action, body, ip = '192.0.2.1') {
  const req = { ip, rawBody: Buffer.from(JSON.stringify(body)) };
  const res = { headers: {}, code: 200, set(k, v) { this.headers[k] = v; return this; },
    status(n) { this.code = n; return this; }, json(value) { this.value = value; return this; } };
  await comments.handle(action, db, req, res, body); return res;
}

test('comments paginate roots and never expose email', async () => {
  const db = fakeDb();
  for (let i = 0; i < 14; i++) db.records.set(`posts/example/comments/c${i}`, { status: 'approved', created_at: `2026-10-12T00:${String(i).padStart(2, '0')}:00Z`, message: 'Hi', email: 'private@example.com' });
  const first = await call(db, 'comments', { slug: 'example' });
  assert.equal(first.value.comments.length, 12); assert.ok(first.value.next_cursor);
  assert.equal(first.value.comments[0].email, undefined);
  const second = await call(db, 'comments', { slug: 'example', cursor: first.value.next_cursor });
  assert.equal(second.value.comments.length, 2); assert.equal(second.value.next_cursor, null);
});

test('anonymous root and reply to reply remain one thread; publication is throttled', async () => {
  const db = fakeDb();
  const root = await call(db, 'commentCreate', { slug: 'example', message: 'Hello world' }, '192.0.2.2');
  assert.equal(root.code, 201); assert.equal(root.value.comment.mode, 'anonymous');
  const rootId = root.value.comment.id;
  const limited = await call(db, 'commentCreate', { slug: 'example', message: 'Again' }, '192.0.2.2');
  assert.equal(limited.code, 429);
  const reply = await call(db, 'commentCreate', { slug: 'example', parent_id: rootId, message: 'First reply' }, '192.0.2.3');
  assert.equal(reply.code, 201);
  const nested = await call(db, 'commentCreate', { slug: 'example', parent_id: rootId, reply_to_id: reply.value.comment.id, message: 'Second reply' }, '192.0.2.4');
  assert.equal(nested.code, 201);
  const result = await call(db, 'commentReplies', { slug: 'example', parent_id: rootId });
  assert.equal(result.value.comments.length, 2);
  assert.equal(result.value.comments[1].reply_to_name, 'Anônimo');
  assert.equal(db.records.get(`posts/example/comments/${rootId}`).reply_count, 2);
});

test('rejects arbitrary media and returns unavailable GIF search without a key', async () => {
  const db = fakeDb();
  await assert.rejects(() => call(db, 'commentCreate', { slug: 'example', media: { type: 'sticker', id: '<script>' } }, '192.0.2.5'), /Mídia inválida/);
  const gifs = await call(db, 'gifSearch', { query: 'hello' });
  assert.equal(gifs.value.available, false);
});

test('article scripts parse and the comment interface is shared by all locales', () => {
  const html = readFileSync(join(__dirname, 'article-template.html'), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
  new vm.Script(readFileSync(join(__dirname, '../public/article-comments.js'), 'utf8'));
  const locales = require('./article-locales');
  const keys = ['discussionIntro', 'reply', 'showReplies', 'stickers', 'gifsSoon', 'loadMore'];
  for (const locale of Object.values(locales)) for (const key of keys) assert.equal(typeof locale[key], 'string');
});
