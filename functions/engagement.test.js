'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engagement = require('./engagement');
const reader = require('./reader');

function fakeDb() {
  const post = { status:'published', blog_id:'your-blog', title:'Teste', content:'<a class="article-cta" href="https://example.com/file">Baixar</a>' };
  const sessions = new Map();
  let updates = 0;
  const postRef = {
    get:async () => ({ exists:true, data:() => post }),
    update:async () => { updates++; },
    collection:() => ({ doc:id => ({ id }) })
  };
  const db = {
    doc:() => postRef,
    runTransaction:async fn => fn({
      get:async ref => ({ exists:sessions.has(ref.id), data:() => sessions.get(ref.id) }),
      set:(ref,value) => sessions.set(ref.id,{ ...(sessions.get(ref.id)||{}),...value }),
      update:() => { updates++; }
    })
  };
  return { db, post, updates:() => updates };
}
function fakeResponse() {
  return { code:0, body:null, set() { return this; }, status(code) { this.code=code; return this; }, json(body) { this.body=body; return this; } };
}

test('qualified view and read session deduplicate independently in six hours', async () => {
  const { db, updates } = fakeDb();
  const visitorId = 'browser-session-id-1234567890';
  const view = { slug:'test-post', visitorId, progress:.3, elapsedMs:3000 };
  const read = { slug:'test-post', visitorId, progress:.6, activeSeconds:30 };
  const first = fakeResponse(); await engagement.handle('engagementQualify',db,view,first);
  assert.equal(first.body.counted,true);
  const repeated = fakeResponse(); await engagement.handle('engagementQualify',db,view,repeated);
  assert.equal(repeated.body.counted,false);
  const firstRead = fakeResponse(); await engagement.handle('engagementRead',db,read,firstRead);
  assert.equal(firstRead.body.counted,true);
  const repeatedRead = fakeResponse(); await engagement.handle('engagementRead',db,read,repeatedRead);
  assert.equal(repeatedRead.body.counted,false);
  assert.equal(updates(),2);
});

test('weak engagement and unregistered buttons are rejected', async () => {
  const { db } = fakeDb();
  const visitorId = 'browser-session-id-1234567890';
  const weak = fakeResponse(); await engagement.handle('engagementQualify',db,{ slug:'test-post', visitorId, progress:.01, elapsedMs:3000 },weak);
  assert.equal(weak.code,400);
  const badButton = fakeResponse(); await engagement.handle('engagementClick',db,{ slug:'test-post', kind:'button', buttonId:'arbitrary' },badButton);
  assert.equal(badButton.code,400);
});

test('button identifiers are stable and reader slugs are restricted', () => {
  assert.equal(engagement.buttonId('Baixar','https://example.com/file'),engagement.buttonId('Baixar','https://example.com/file'));
  assert.equal(reader.validSlug('meu-artigo-1'),true);
  assert.equal(reader.validSlug('../private'),false);
});
