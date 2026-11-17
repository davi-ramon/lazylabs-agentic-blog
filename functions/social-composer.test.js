'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

test('composer requires review and fresh article versions before social publication', async () => {
  const html = readFileSync(join(__dirname, '../public/admin/index.html'), 'utf8');
  const script = readFileSync(join(__dirname, '../public/admin/social-composer.js'), 'utf8');
  assert.match(html, /social-composer\.js/);
  assert.match(html.slice(0, html.indexOf('<!-- DEAD CODE')), /social_copy: socialCollect\(\)\.copy/);
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value:'', checked:false, disabled:false, textContent:'', style:{},
      options:[{ value:'auto' }], addEventListener() {}, scrollIntoView() {} });
    return elements.get(id);
  }
  element('f-title').value = 'Projeto'; element('f-slug').value = 'projeto';
  element('f-excerpt').value = 'Resumo'; element('editor-area').innerHTML = '<p>Artigo</p>';
  element('editor-area').innerText = 'Artigo';
  const context = vm.createContext({ document:{ getElementById:element },
    isChannelActive:channel => channel === 'linkedin',
    fbFetch_:async () => ({ ok:true, drafts:{ linkedin:'Projeto\n\nArtigo completo: https://blog.example.com/artigo/projeto',
      facebook:'Facebook', instagram:'Instagram', x:'X', tiktok:'TikTok' } }) });
  context.window = context;
  vm.runInContext(script, context);
  assert.equal(context.socialReadyToPublish(), false);
  await context.socialPrepare(false);
  assert.equal(context.socialReadyToPublish(), false);
  element('social-approved').checked = true;
  assert.equal(context.socialReadyToPublish(), true);
  element('f-title').value = 'Projeto alterado';
  assert.equal(context.socialReadyToPublish(), false);
});
