const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let post = null;
const translatedDocs = new Map();
const pings = [];
const queued = [];
let activeTranslations = 0;
let peakTranslations = 0;
let taxonomy = null;
const taxonomyRef = {
  async get() { return { exists: !!taxonomy, data: () => taxonomy }; }
};
const ref = {
  async get() { return { exists: !!post, data: () => post }; },
  async set(value) { post = { ...(post || {}), ...value }; },
  collection() { return { doc: lang => ({ key: lang }) }; }
};
const db = {
  doc(path) { return path === 'config/blog-taxonomy' ? taxonomyRef : ref; },
  async runTransaction(fn) {
    const tx = {
      get: target => target.get(),
      set(target, value) { if (target === taxonomyRef) taxonomy = value; else translatedDocs.set(target.key, value); },
      update(_, value) { post.translation_ready = [...new Set([...(post.translation_ready || []), value.translation_ready.lang])]; }
    };
    return fn(tx);
  }
};

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (parent?.filename?.endsWith('posts.js')) {
    if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { arrayUnion: lang => ({ lang }) } };
    if (name === 'firebase-admin/functions') return { getFunctions: () => ({ taskQueue: () => ({
      enqueue: async (data, options) => { queued.push({ data, options }); }
    }) }) };
    if (name === './admin') return { requireAdmin_: async () => ({ uid: 'owner' }) };
    if (name === './indexnow') return { ping: urls => pings.push(urls) };
    if (name === './translations') return {
      TARGETS: ['en', 'es', 'fr', 'de'],
      sourceHash: () => 'a'.repeat(64),
      translatePost: async (value, lang) => {
        activeTranslations++;
        peakTranslations = Math.max(peakTranslations, activeTranslations);
        await new Promise(resolve => setTimeout(resolve, 1));
        activeTranslations--;
        return { language: lang, source_hash: 'a'.repeat(64), title: lang + ' title' };
      }
    };
  }
  return originalLoad(name, parent, isMain);
};
const posts = require('./posts');
Module._load = originalLoad;

function response() {
  return {
    statusCode: 200, body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = JSON.parse(value); return this; }
  };
}

test('publicação confirma o artigo sem esperar a tradução e tarefas completam os quatro idiomas', async () => {
  const res = response();
  await posts.handler({ method: 'POST', path: '/api/posts/publish', headers: {}, body: {
    data: { slug: 'artigo-teste', titulo_final: 'Título', content_html: '<p>Texto</p>', status: 'published' }
  } }, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.translation.ready, []);
  assert.deepEqual(res.body.translation.queued, ['en', 'es', 'fr', 'de']);
  assert.deepEqual(res.body.translation.failed, []);
  assert.equal(translatedDocs.size, 0);
  assert.equal(post.status, 'published');
  for (const task of queued) await posts.processTranslationTask({ data: task.data });
  assert.deepEqual([...translatedDocs.keys()].sort(), ['de', 'en', 'es', 'fr']);
  assert.equal(post.translation_ready.length, 4);
  assert.equal(peakTranslations, 1);
  assert.equal(pings[0].length, 2);
  assert.equal(queued.length, 4);
  assert.ok(queued.every(task => task.options.id.length === 64));
  await posts.processTranslationTask({ data: queued[0].data });
  assert.equal(translatedDocs.size, 4);
});

test('tarefa antiga não traduz rascunho nem versão substituída', async () => {
  const task = queued[0].data;
  const before = translatedDocs.size;
  post.status = 'draft';
  await posts.processTranslationTask({ data: task });
  post.status = 'published';
  post.translation_hash = 'b'.repeat(64);
  await posts.processTranslationTask({ data: task });
  assert.equal(translatedDocs.size, before);
});
