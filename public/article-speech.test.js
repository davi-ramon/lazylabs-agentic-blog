'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const speech = require('./article-speech');

test('prefers an Edge natural Portuguese voice when exposed', () => {
  const voices = [
    { name: 'Microsoft Maria', lang: 'pt-BR', voiceURI: 'local', default: true },
    { name: 'Microsoft Francisca Online (Natural)', lang: 'pt-BR', voiceURI: 'natural', default: false }
  ];
  assert.equal(speech.chooseVoice(voices, 'pt-BR', '').voiceURI, 'natural');
  assert.equal(speech.chooseVoice(voices, 'pt-BR', 'local|pt-BR').voiceURI, 'local');
  assert.equal(speech.chooseVoice(voices, 'pt-BR', 'browser-default'), null);
});

test('speech chunks preserve sentence breaks and stay reasonably short', () => {
  const chunks = speech.split('Primeira frase. Segunda frase, com pausa. ' + 'palavra '.repeat(100));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 370));
  assert.match(chunks[0], /Primeira frase\. Segunda frase, com pausa\./);
});
