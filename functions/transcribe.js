/**
 * Lazy Labs — transcricao de audio multi-provider via Firebase.
 *
 * Endpoint: POST /api/transcribe
 *   body: { base64: string, mimeType: string, provider?: string }
 *
 * Providers suportados:
 *   - groq        (gratis, padrao) — Whisper large-v3-turbo
 *   - openai_whisper (pago) — Whisper-1
 *   - deepgram    (paga com free tier) — nova-2
 *   - assemblyai  (paga com free tier) — Best
 *   - custom      (qualquer endpoint OpenAI-compatible /audio/transcriptions)
 *
 * Keys e config vao pro Firestore `config/davi` (caminho canonico). Aceita tambem
 * chaves inline no body pra override rapido.
 */

const { getFirestore } = require('firebase-admin/firestore');
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_BODY_BYTES = 8_400_000;
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

function json_(res, status, obj) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(obj));
}

function setCors_(req, res) {
  const origin = req.headers.origin || req.headers.Origin || '';
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
}

function readBody_(req) {
  try {
    return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {});
  } catch (e) { return {}; }
}

const PROVIDERS = {
  groq: {
    label: 'Groq Whisper (gratuito)',
    base: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    keyField: 'groq_key',
    configKey: 'groq'
  },
  openai_whisper: {
    label: 'OpenAI Whisper (pago)',
    base: 'https://api.openai.com/v1',
    model: 'whisper-1',
    keyField: 'openai_key',
    configKey: 'openai'
  },
  deepgram: {
    label: 'Deepgram Nova-2 (free tier 200h)',
    base: 'https://api.deepgram.com/v1',
    model: 'nova-2',
    keyField: 'deepgram_key',
    configKey: 'deepgram'
  },
  assemblyai: {
    label: 'AssemblyAI (free tier 5h)',
    base: 'https://api.assemblyai.com/v2',
    model: 'best',
    keyField: 'assemblyai_key',
    configKey: 'assemblyai'
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    base: '__CUSTOM__',
    model: '__CUSTOM__',
    keyField: 'custom_key',
    configKey: 'custom'
  }
};

async function loadKeyFromFirestore_(providerCfg) {
  // Prioridade: config/davi (atual) > config/ai (legado).
  for (const path of ['config/davi', 'config/ai']) {
    const snap = await db().doc(path).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    const k = String(data[providerCfg.keyField] || '').trim();
    if (k) return k;
  }
  return '';
}

async function callGroq_(apiKey, blob, mimeType, lang) {
  const form = new FormData();
  form.append('file', blob, 'audio.' + (mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'webm'));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  if (lang) form.append('language', lang);
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey }, body: form
  });
  return parseTranscribeResponse_(r, 'groq');
}

async function callOpenAIWhisper_(apiKey, blob, mimeType, lang) {
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');
  if (lang) form.append('language', lang);
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey }, body: form
  });
  return parseTranscribeResponse_(r, 'openai');
}

async function callDeepgram_(apiKey, blob, mimeType, lang) {
  // Deepgram usa endpoint proprio (/listen) com query params + raw body.
  const url = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=' + (lang || 'pt');
  const r = await fetch(url, {
    method: 'POST', headers: { 'Authorization': 'Token ' + apiKey, 'Content-Type': mimeType || 'audio/webm' },
    body: blob
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) return { ok: false, message: (j && j.err_msg) || ('HTTP ' + r.status) };
  return { ok: true, transcript: String((j && j.results && j.results.channels[0] && j.results.channels[0].alternatives[0] && j.results.channels[0].alternatives[0].transcript) || '').trim() };
}

async function callAssemblyAI_(apiKey, blob, mimeType, lang) {
  // AssemblyAI: 1) upload audio, 2) cria transcript, 3) poll, 4) pega texto.
  const base = 'https://api.assemblyai.com/v2';
  const upload = await fetch(base + '/upload', { method: 'POST', headers: { 'Authorization': apiKey }, body: blob });
  const uj = await upload.json();
  if (!upload.ok) return { ok: false, message: 'upload: ' + (uj.error || 'HTTP ' + upload.status) };
  const audioUrl = uj.upload_url;

  const create = await fetch(base + '/transcript', {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, language_code: lang || 'pt', speech_model: 'best' })
  });
  const cj = await create.json();
  if (!create.ok) return { ok: false, message: 'transcript: ' + (cj.error || 'HTTP ' + create.status) };

  const id = cj.id;
  // poll ate concluir (max 60s)
  for (var i = 0; i < 30; i++) {
    await new Promise(function (r) { setTimeout(r, 2000); });
    var get = await fetch(base + '/transcript/' + id, { headers: { 'Authorization': apiKey } });
    var gj = await get.json();
    if (gj.status === 'completed') return { ok: true, transcript: String(gj.text || '').trim() };
    if (gj.status === 'error') return { ok: false, message: gj.error || 'AssemblyAI erro' };
  }
  return { ok: false, message: 'AssemblyAI timeout' };
}

async function callCustom_(apiKey, blob, mimeType, lang, cfg) {
  // cfg = { base: 'https://api.example.com/v1', model: 'whisper-1' }
  if (!cfg || !cfg.base || !cfg.model) return { ok: false, message: 'Custom: base/model nao configurados.' };
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', cfg.model);
  if (lang) form.append('language', lang);
  const r = await fetch(cfg.base.replace(/\/+$/, '') + '/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey }, body: form
  });
  return parseTranscribeResponse_(r, 'custom');
}

async function parseTranscribeResponse_(r, label) {
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) {
    const err = (j && (j.error && (j.error.message || j.error))) || ('HTTP ' + r.status);
    return { ok: false, message: label + ': ' + err };
  }
  const text = j && j.text ? j.text : (j && j.transcript ? j.transcript : '');
  return { ok: true, transcript: String(text || '').trim(), duration: (j && j.duration) || 0 };
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const user = await require('./admin').requireAdmin_(req, res); if (!user) return;
  if (req.method === 'GET') {
    return json_(res, 200, {
      ok: true, service: 'transcribe',
      providers: Object.keys(PROVIDERS).map(function (k) { return { id: k, label: PROVIDERS[k].label }; })
    });
  }
  if (req.method !== 'POST') { json_(res, 405, { ok: false, message: 'Use POST.' }); return; }
  if (req.rawBody && req.rawBody.length > MAX_BODY_BYTES) {
    json_(res, 413, { ok: false, message: 'Trecho de áudio muito grande. Grave trechos menores.' }); return;
  }

  const path = (req.path || '').replace(/\/+$/, '').replace(/^\/+/, '');
  const action = path.split('/').pop() || 'transcribe';

  const body = readBody_(req);
  if (action === 'transcribe') {
    const base64 = String(body.base64 || '').trim();
    const mimeType = String(body.mimeType || 'audio/webm').trim();
    const lang = String(body.lang || 'pt').trim();
    const providerId = String(body.provider || 'groq').trim().toLowerCase();
    if (!base64 || base64.length > MAX_BODY_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      json_(res, 400, { ok: false, message: 'Áudio inválido ou muito grande.' }); return;
    }
    if (!/^audio\/(webm|ogg|mp4|mpeg|mp3|wav)(?:;[a-z0-9=;,._-]+)?$/i.test(mimeType)) {
      json_(res, 400, { ok: false, message: 'Formato de áudio não suportado.' }); return;
    }
    const providerCfg = PROVIDERS[providerId];
    if (!providerCfg) { json_(res, 400, { ok: false, message: 'Provider desconhecido: ' + providerId }); return; }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) {
      json_(res, 413, { ok: false, message: 'Trecho de áudio excede 6 MB.' }); return;
    }
    const blob = new Blob([buffer], { type: mimeType });

    // Key: inline > Firestore
    let apiKey = String(body.apiKey || body.groqKey || body.openai_key || '').trim();
    if (!apiKey && providerId !== 'custom') {
      try { apiKey = await loadKeyFromFirestore_(providerCfg); } catch (e) { /* silencioso */ }
    }
    if (providerId === 'custom') {
      // custom: chave fica em config/davi.custom_key
      try { apiKey = apiKey || (await loadKeyFromFirestore_({ keyField: 'custom_key' })); } catch (e) {}
    }
    if (!apiKey) { json_(res, 503, { ok: false, message: 'API key ausente para provider "' + providerId + '". Salve em Config API.' }); return; }

    try {
      var result;
      if (providerId === 'groq') result = await callGroq_(apiKey, blob, mimeType, lang);
      else if (providerId === 'openai_whisper') result = await callOpenAIWhisper_(apiKey, blob, mimeType, lang);
      else if (providerId === 'deepgram') result = await callDeepgram_(apiKey, blob, mimeType, lang);
      else if (providerId === 'assemblyai') result = await callAssemblyAI_(apiKey, blob, mimeType, lang);
      else if (providerId === 'custom') {
        // cfg do custom fica em config/davi.custom_provider = { base, model }
        let customCfg = { base: 'https://api.openai.com/v1', model: 'whisper-1' };
        try {
          const s = await db().doc('config/davi').get();
          if (s.exists && s.data().custom_provider) customCfg = Object.assign(customCfg, s.data().custom_provider);
        } catch (e) {}
        result = await callCustom_(apiKey, blob, mimeType, lang, customCfg);
      }
      else result = { ok: false, message: 'Provider nao implementado.' };

      json_(res, result.ok ? 200 : 502, result);
    } catch (e) {
      console.error('[transcribe]', providerId, e);
      json_(res, 500, { ok: false, message: (e && e.message) || 'Erro ao transcrever.' });
    }
    return;
  }

  json_(res, 404, { ok: false, message: 'Acao desconhecida: ' + action });
}

module.exports = { handler, PROVIDERS };
