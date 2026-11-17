const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('ditado longo gira trechos independentes, insere texto em ordem e bloqueia nova gravação ao transcrever', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/admin/voice-dictation.js'), 'utf8');
  const timers = new Map();
  const recorders = [];
  const inserted = [];
  const elements = new Map();
  let timerId = 0;
  let requests = 0;
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: false, disabled: false, textContent: '', classList: { toggle() {} },
      setAttribute() {}, contains(target) { return target === this; }, dispatchEvent() {},
      getContext() { return null; }
    });
    return elements.get(id);
  }
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['trecho-' + recorders.indexOf(this)], { type: this.mimeType }) });
      this.onstop();
    }
  }
  Recorder.isTypeSupported = type => type === 'audio/webm;codecs=opus';
  class Reader {
    async readAsDataURL(blob) {
      const bytes = Buffer.from(await blob.arrayBuffer());
      this.result = 'data:audio/webm;base64,' + bytes.toString('base64');
      this.onload();
    }
  }
  const editor = el('editor-area');
  const context = vm.createContext({
    window: { getSelection: () => null },
    document: {
      getElementById: el,
      createRange: () => ({ startContainer: editor, selectNodeContents() {}, collapse() {}, insertNode(value) { inserted.push(value.textContent); }, setStartAfter() {} }),
      createTextNode: value => ({ textContent: value })
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder: Recorder, FileReader: Reader, Blob, Buffer, Event: class {},
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, transcript: 'fala ' + (++requests) }) }),
    showToast() {}, updateWordCount() {},
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Date
  });
  vm.runInContext(source, context);
  await context.window.articleVoiceToggle();
  for (let i = 0; i < 7; i++) {
    const timer = [...timers].find(([, value]) => value.ms === 120000);
    assert.ok(timer, 'timer do trecho ativo');
    timers.delete(timer[0]);
    timer[1].fn();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(recorders.length, 8);
  context.window.articleVoiceToggle();
  assert.equal(el('editor-mic-btn').disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 8);
  assert.equal(inserted.join(''), 'fala 1 fala 2 fala 3 fala 4 fala 5 fala 6 fala 7 fala 8 ');
  assert.equal(el('editor-mic-btn').disabled, false);
  assert.match(el('editor-voice-message').textContent, /Transcrição concluída/);
});

test('microfone do Davi mostra processamento e impede nova gravação até finalizar', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/admin/index.html'), 'utf8');
  const first = html.slice(html.indexOf('function daviToggleMic()'), html.indexOf('var daviMediaRecorder ='));
  const second = html.slice(html.indexOf('function daviStopMic()'), html.indexOf('/* ═══ SHIM DOS HANDLERS DAVI'));
  const elements = new Map();
  let stops = 0;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { disabled: false, textContent: '', classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) }, setAttribute() {} });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    daviMicPhase: 'recording', daviIsRecording: true,
    daviMediaRecorder: { state: 'recording', stop() { stops++; this.state = 'inactive'; } },
    document: { getElementById: element },
    daviSyncSendBtn() {}, daviHideRecUI_() {}, daviStartMic() { throw new Error('Não deve iniciar outra gravação.'); }
  });
  vm.runInContext(first + '\n' + second, context);
  vm.runInContext('daviToggleMic(); daviToggleMic()', context);
  assert.equal(stops, 1);
  assert.equal(element('davi-mic-btn').disabled, true);
  assert.equal(element('davi-mic-btn').classList.contains('processing'), true);
  assert.match(element('davi-rec-description').textContent, /Aguarde a transcrição/);
  vm.runInContext('daviFinishMic_()', context);
  assert.equal(element('davi-mic-btn').disabled, false);
});
