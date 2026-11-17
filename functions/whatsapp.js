/**
 * Lazy Labs — WhatsApp Cloud API (Meta) via Firebase Function.
 *
 * Rotas:
 *   GET  /api/whatsapp/status                 → { configured, hasToken }
 *   POST /api/whatsapp/save     { config }   → salva em Firestore config/whatsapp
 *   POST /api/whatsapp/test                    → testa conexão (busca info do número)
 *   POST /api/whatsapp/templates              → lista templates (filter ?category=marketing|utility)
 *   POST /api/whatsapp/send     { payload }   → dispara template para lista de destinatários
 *
 * Config em Firestore (config/whatsapp):
 *   { phoneNumberId, wabaId, accessToken, apiVersion, defaultTemplate, defaultTemplateLang, defaultAudience,
 *     enabledCategories: ['marketing','utility'], mappings: { '<template_name>': { header, bodyParams, buttons, mediaUrl, language } } }
 *
 * Por que server-side: accessToken é sensível e a Meta exige HTTPS com cert válido.
 * O bridge do admin reusa as mesmas Functions para CORS echo Origin.
 */

const { getFirestore } = require('firebase-admin/firestore');
const adminModule = require('./admin');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const DEFAULT_API_VERSION = 'v20.0';
const ALLOWED_CATEGORIES = ['marketing', 'utility'];

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

async function loadConfig() {
  const snap = await db().doc('config/whatsapp').get();
  return snap.exists ? snap.data() : {};
}

async function saveConfig(cfg) {
  const safe = {
    phoneNumberId: String(cfg.phoneNumberId || '').trim(),
    wabaId: String(cfg.wabaId || '').trim(),
    accessToken: String(cfg.accessToken || '').trim(),
    apiVersion: String(cfg.apiVersion || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION,
    defaultTemplate: String(cfg.defaultTemplate || '').trim(),
    defaultTemplateLang: String(cfg.defaultTemplateLang || 'pt_BR').trim(),
    defaultAudience: String(cfg.defaultAudience || 'all_subscribers').trim(),
    enabledCategories: Array.isArray(cfg.enabledCategories) ? cfg.enabledCategories.filter(function (c) { return ALLOWED_CATEGORIES.indexOf(c) !== -1; }) : ['marketing', 'utility'],
    mappings: typeof cfg.mappings === 'object' && cfg.mappings ? cfg.mappings : {},
    updatedAt: new Date().toISOString()
  };
  await db().doc('config/whatsapp').set(safe, { merge: true });
  return safe;
}

async function fetchFromMeta_(cfg, path, options) {
  const base = 'https://graph.facebook.com/' + (cfg.apiVersion || DEFAULT_API_VERSION);
  const url = base + '/' + String(cfg.phoneNumberId).trim() + path;
  const headers = { 'Authorization': 'Bearer ' + cfg.accessToken };
  const opts = Object.assign({ method: 'GET', headers: headers }, options || {});
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, raw: t };
}

async function getStatus() {
  const cfg = await loadConfig();
  return { configured: !!(cfg.phoneNumberId && cfg.accessToken), categories: cfg.enabledCategories || ALLOWED_CATEGORIES };
}

async function handleTest() {
  const cfg = await loadConfig();
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return { ok: false, message: 'Configure Phone Number ID e Access Token antes de testar.' };
  }
  const r = await fetchFromMeta_(cfg, '?fields=display_phone_number,verified_name,quality_rating', {});
  if (!r.ok) {
    const err = (r.body && r.body.error && r.body.error.message) || ('Meta HTTP ' + r.status);
    return { ok: false, message: err };
  }
  return { ok: true, number: r.body };
}

async function handleTemplates(data) {
  const cfg = await loadConfig();
  if (!cfg.wabaId || !cfg.accessToken) {
    return { ok: false, message: 'Informe o WABA ID para listar templates.' };
  }
  const url = 'https://graph.facebook.com/' + (cfg.apiVersion || DEFAULT_API_VERSION) + '/' + cfg.wabaId + '/message_templates?limit=200';
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + cfg.accessToken } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok) {
    const err = (j && j.error && j.error.message) || ('Meta HTTP ' + r.status);
    return { ok: false, message: err };
  }
  const enabled = new Set(cfg.enabledCategories || ALLOWED_CATEGORIES);
  const filter = String((data && data.category) || '').trim();
  let list = Array.isArray(j && j.data) ? j.data : [];
  list = list.filter(function (tpl) { return enabled.has(tpl.category); });
  if (filter && ALLOWED_CATEGORIES.indexOf(filter) !== -1) {
    list = list.filter(function (tpl) { return tpl.category === filter; });
  }
  return { ok: true, templates: list.map(function (tpl) {
    return {
      id: tpl.id, name: tpl.name, category: tpl.category, language: tpl.language,
      status: tpl.status, components: tpl.components || []
    };
  }) };
}

/** Lista destinatários conforme audiência.
 *  'all_subscribers' (default): newsletter_subscribers (⚠ não tem coluna phone — só dispara se houver).
 *  'newsletter_subscribers': idem.
 *  'crm_leads': crm_leads com status !== 'Perdido' (estes têm telefone).
 */
async function fetchAudiencePhoneList(audience) {
  const supSnap = await db().doc('config/supabase').get();
  const cfg = supSnap.exists ? supSnap.data() : {};
  if (!cfg.serviceKey) return { ok: false, message: 'Supabase service key ausente (config/supabase).', rows: [] };

  const base = 'https://your-supabase-project.supabase.co/rest/v1/';
  const headers = { 'apikey': cfg.serviceKey, 'Authorization': 'Bearer ' + cfg.serviceKey };

  if (audience === 'crm_leads') {
    const url = base + 'posts?select=id&limit=1';
    const r = await fetch(url, { headers: headers });
    if (!r.ok) return { ok: false, message: 'Supabase indisponível.', rows: [] };
    // CRM vive no Firestore, não no Supabase.
    const leadsSnap = await db().collection('crm_leads').get();
    const out = [];
    leadsSnap.forEach(function (d) {
      const x = d.data();
      out.push({ phone: x.telefone || '', nome: x.nome || '', email: x.email || '' });
    });
    return { ok: true, rows: out, source: 'crm_leads (Firestore)' };
  }

  // default: newsletter_subscribers (sem coluna phone — só dispara se existir)
  const url = base + 'newsletter_subscribers?select=id,email,first_name,last_name,nickname,phone,telefone&limit=1000';
  const r = await fetch(url, { headers: headers });
  if (!r.ok) return { ok: false, message: 'Supabase HTTP ' + r.status, rows: [] };
  const arr = await r.json();
  return { ok: true, rows: Array.isArray(arr) ? arr : [], source: 'newsletter_subscribers (Supabase)' };
}

function normalizePhone(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s.slice(1);
  if (s.startsWith('55')) return s;
  return '55' + s;
}

async function handleSend(data) {
  const cfg = await loadConfig();
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return { ok: false, message: 'WhatsApp não configurado.' };
  }
  const templateName = String((data && data.template) || cfg.defaultTemplate || '').trim();
  const language = String((data && data.language) || cfg.defaultTemplateLang || 'pt_BR').trim();
  const audience = String((data && data.audience) || cfg.defaultAudience || 'all_subscribers').trim();
  const postSlug = String((data && data.postSlug) || '').trim();
  const postTitle = String((data && data.postTitle) || '').trim();
  const postUrl = String((data && data.postUrl) || '').trim();

  if (!templateName) return { ok: false, message: 'Selecione um template.' };

  const audienceData = await fetchAudiencePhoneList(audience);
  if (!audienceData.ok) {
    return { ok: false, message: audienceData.message };
  }
  const targets = audienceData.rows.map(function (u) { return normalizePhone(u.phone || u.telefone); }).filter(Boolean);
  if (!targets.length) {
    return { ok: false, message: 'Nenhum destinatário com telefone válido no público "' + audience + '" (fonte: ' + audienceData.source + '). Adicione telefones aos leads do CRM ou troque a audiência.' };
  }

  const tplUrl = 'https://graph.facebook.com/' + (cfg.apiVersion || DEFAULT_API_VERSION) + '/' + cfg.phoneNumberId + '/messages';
  let sent = 0, failed = 0, errors = [];

  // Pequeno paralelismo para não estourar rate limit. Em série para mais previsibilidade.
  for (var i = 0; i < targets.length; i++) {
    const phone = targets[i];
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: postTitle || 'Novo artigo no blog' },
              { type: 'text', text: postUrl || ('https://blog.example.com/artigo/' + postSlug) }
            ]
          }
        ]
      }
    };
    try {
      const r = await fetch(tplUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const respText = await r.text();
      if (!r.ok) {
        failed++;
        let parsed = null; try { parsed = JSON.parse(respText); } catch (_) {}
        const errMsg = (parsed && parsed.error && parsed.error.message) || ('HTTP ' + r.status);
        if (errors.length < 5) errors.push({ phone: phone, message: errMsg });
      } else {
        sent++;
      }
    } catch (e) {
      failed++;
      if (errors.length < 5) errors.push({ phone: phone, message: (e && e.message) || 'erro' });
    }
  }

  // Log da campanha na coleção whatsapp_logs.
  try {
    await db().collection('whatsapp_logs').add({
      template: templateName, audience: audience, total: targets.length,
      sent: sent, failed: failed, postSlug: postSlug,
      errors: errors, createdAt: new Date().toISOString()
    });
  } catch (e) { /* silencioso */ }

  return { ok: true, total: targets.length, sent: sent, failed: failed, errors: errors };
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const user = await adminModule.requireAdmin_(req, res); if (!user) return;

  const path = (req.path || '').replace(/\/+$/, '').replace(/^\/+/, '');
  const action = path.split('/').pop() || 'status';

  try {
    if (req.method === 'GET' && (action === 'status' || path === '')) {
      const s = await getStatus();
      json_(res, 200, s); return;
    }

    const body = readBody_(req);

    if (action === 'status') { json_(res, 200, await getStatus()); return; }
    if (action === 'save') {
      const saved = await saveConfig(body.config || body);
      json_(res, 200, { ok: true, config: { phoneNumberId: saved.phoneNumberId, wabaId: saved.wabaId, apiVersion: saved.apiVersion, enabledCategories: saved.enabledCategories, defaultTemplate: saved.defaultTemplate, defaultAudience: saved.defaultAudience } });
      return;
    }
    if (action === 'test')  { json_(res, 200, await handleTest()); return; }
    if (action === 'templates') { json_(res, 200, await handleTemplates(body)); return; }
    if (action === 'send')  { json_(res, 200, await handleSend(body)); return; }

    json_(res, 404, { ok: false, message: 'Ação desconhecida: ' + action });
  } catch (err) {
    console.error('[whatsapp]', action, err);
    json_(res, 500, { ok: false, message: (err && err.message) || 'Erro interno.' });
  }
}

module.exports = { handler };
