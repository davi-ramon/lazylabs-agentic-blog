const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('erro 500 sem JSON não confirma publicação nem oferece artigo inexistente', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/admin/index.html'), 'utf8');
  const start = html.indexOf('var pubFlowState =');
  const end = html.indexOf('function setLoading(', start);
  assert.ok(start > 0 && end > start);
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {} }, remove() {} });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {
      getElementById(id) { return id === 'pub-btn-open-article' ? null : element(id); },
      querySelector() { throw new Error('O link do artigo não deve aparecer após falha.'); }
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('Internal Server Error'); } }),
    PUBLISH_CHANNELS: [{ id:'blog' }],
    isChannelActive: () => true,
    setLoading() {},
    showToast() {},
    setTimeout
  });
  vm.runInContext(html.slice(start, end), context);
  await vm.runInContext("runPublishFlow({}, 'Título', '', 'artigo-inexistente')", context);
  assert.match(element('pub-summary').innerHTML, /publicação não confirmada/);
  assert.match(element('pub-timeline').innerHTML, /HTTP 500/);
  assert.equal(element('pub-modal-sub').textContent, 'falhou · confira a lista de posts');
});
