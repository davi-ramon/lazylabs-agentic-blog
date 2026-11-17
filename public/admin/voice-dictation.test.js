'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('trechos ditados mantêm a ordem mesmo após clicar no microfone para parar', async () => {
  const timers = new Map();
  let timerId = 0;
  let transcription = 0;
  const editor = { childNodes: [], contains(node) { return node === this || this.childNodes.includes(node); }, dispatchEvent() {} };
  const nodes = new Map();
  const element = id => {
    if (id === 'editor-area') return editor;
    if (!nodes.has(id)) nodes.set(id, { hidden:false, disabled:false, textContent:'', classList:{ toggle() {} }, setAttribute() {} });
    return nodes.get(id);
  };
  const range = () => ({ startContainer:editor, cloneRange() { return range(); }, collapse() {},
    insertNode(node) { editor.childNodes.unshift(node); }, setStartAfter() {}, selectNodeContents() {} });
  const selection = { rangeCount:1, anchorNode:editor, getRangeAt:range };
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data:new Blob(['audio']) });
      this.onstop();
    }
  }
  class Reader {
    readAsDataURL() { this.result = 'data:audio/webm;base64,YXVkaW8='; this.onload(); }
  }
  const window = { getSelection:() => selection };
  const context = {
    window, document:{ getElementById:element, createTextNode:data => ({ data }), createRange:range },
    navigator:{ mediaDevices:{ getUserMedia:async () => ({ getTracks:() => [{ stop() {} }] }) } },
    MediaRecorder:Recorder, FileReader:Reader, Blob, Event:class {},
    fetch:async () => ({ ok:true, text:async () => JSON.stringify({ ok:true, transcript:['Primeiro.', 'Segundo.'][transcription++] }) }),
    setTimeout:(fn,ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout:id => timers.delete(id), setInterval:() => 1, clearInterval() {},
    showToast() {}, updateWordCount() {}
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/voice-dictation.js', 'utf8'), context);
  await window.articleVoiceToggle();
  const rotate = [...timers.values()].find(timer => timer.ms === 120000);
  assert.ok(rotate);
  rotate.fn();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  // O pointerdown do botão dispara mesmo na ação de parar.
  window.articleVoiceRememberCaret();
  window.articleVoiceToggle();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.childNodes.map(node => node.data).join(''), 'Primeiro. Segundo. ');
  assert.equal(window.articleVoiceBusy_(), false);
});
