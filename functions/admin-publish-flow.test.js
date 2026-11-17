'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/admin/index.html'), 'utf8');
const start = html.indexOf('async function runPublishFlow(');
const end = html.indexOf('\nfunction setLoading(', start);
assert.ok(start > 0 && end > start, 'Fluxo de publicação encontrado no admin ativo');
const flow = html.slice(start, end);

async function simulate(blogResponse, channels = {}, socialResponse = {}) {
  const events = { reset:0, finish:[], loading:[], steps:[] };
  const output = { innerHTML:'', className:'' };
  const state = { blogPublished:false, pendingCount:0 };
  const sandbox = {
    PUBLISH_CHANNELS: [{id:'blog'},{id:'newsletter'},{id:'linkedin'},{id:'whatsapp'},{id:'facebook'},{id:'instagram'},{id:'x'},{id:'tiktok'}],
    pubFlowState:state,
    pubOpenModal() { state.blogPublished = false; state.pendingCount = 0; },
    setLoading(value) { events.loading.push(value); },
    isChannelActive(id) { return !!channels[id]; },
    pubAddStep(label) { events.steps.push(label); return label; },
    pubSetStepState() {},
    pubFinishFlow(ok, error) { events.finish.push({ok,error}); },
    showToast() {},
    document:{ getElementById(id) { return id === 'last-submit' ? output : {value:'PUBLIC_TO_EVERYONE'}; } },
    fetch:async () => ({ ok:blogResponse.httpOk !== false, status:blogResponse.httpOk === false ? 500 : 200, json:async () => blogResponse.body }),
    fbFetch_:async () => socialResponse,
    sleep_:async () => {},
    clearEditorForNext_() { events.reset++; },
    mostrarCardNewsletter() {},
    Date,
    Object
  };
  vm.createContext(sandbox);
  vm.runInContext(flow, sandbox);
  await sandbox.runPublishFlow({ auto_translate:true, blog_id:'your-blog' }, 'Título', 'Resumo', 'artigo');
  return events;
}

test('publicação completa limpa o editor e libera os botões', async () => {
  const events = await simulate({body:{ok:true, slug:'artigo', translation:{ready:['en','es','fr','de'],failed:[]}}});
  assert.equal(events.reset, 1);
  assert.deepEqual(events.loading, [true,false]);
  assert.equal(events.finish[0].error, 0);
});

test('falha de tradução ou HTTP mantém o artigo para corrigir e tentar novamente', async () => {
  const translation = await simulate({body:{ok:true, slug:'artigo', translation:{ready:['en'],failed:['es','fr','de']}}});
  const http = await simulate({httpOk:false, body:null});
  assert.equal(translation.reset, 0);
  assert.equal(http.reset, 0);
  assert.deepEqual(translation.loading, [true,false]);
  assert.deepEqual(http.loading, [true,false]);
});

test('canal apenas aceito e ainda em processamento mantém o artigo no editor', async () => {
  const events = await simulate({body:{ok:true, slug:'artigo', translation:{ready:['en','es','fr','de'],failed:[]}}}, {tiktok:true}, {ok:true,status:'accepted'});
  assert.equal(events.reset, 0);
  assert.equal(events.finish[0].error, 0);
});
