'use strict';
// Rastreamento do site institucional: GTM e Conversions API configurados no admin
// (config/form.meta) e leads da qualificação do chat (home e /agendar).
const { isIP } = require('node:net');

const GRAPH = 'https://graph.facebook.com/v26.0';
const CAPI_EVENTS = new Set(['PageView', 'ViewContent', 'Contact', 'Lead', 'Schedule']);
const ORIGINS = new Set(['https://example.com', 'https://www.example.com',
  'https://your-firebase-project.web.app', 'https://your-firebase-project.firebaseapp.com']);
const SOURCES = new Set(['agendar', 'bot']);
const ANSWER_KEYS = ['desafio', 'segmento', 'tamanho', 'faturamento'];

function clip(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
function validGtm(value) { return /^GTM-[A-Z0-9]{4,12}$/.test(String(value || '')); }
function validPixel(value) { return /^\d{8,20}$/.test(String(value || '')); }
function allowedOrigin(origin) { return ORIGINS.has(String(origin || '')); }

function publicTracking(config) {
  const meta = (config && config.meta) || {};
  return { pixelId: validPixel(meta.pixelId) ? String(meta.pixelId) : '', gtmId: validGtm(meta.gtmId) ? String(meta.gtmId) : '' };
}

function clientIp(req) {
  const headers = req.headers || {};
  const first = String(headers['fastly-client-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim();
  return isIP(first) ? first : '';
}

function buildCapiEvent(input, context, now = Date.now()) {
  const name = String((input && input.event) || '');
  if (!CAPI_EVENTS.has(name)) return null;
  const eventId = clip(input.eventId, 80);
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(eventId)) return null;
  const url = clip(input.url, 500);
  if (!/^https:\/\/(www\.)?example\.com(\/|$|\?)/.test(url)) return null;
  const userData = {};
  if (context.ip) userData.client_ip_address = context.ip;
  if (context.userAgent) userData.client_user_agent = clip(context.userAgent, 400);
  const fbp = clip(input.fbp, 120), fbc = clip(input.fbc, 300);
  if (/^fb\.\d\.\d+\.\d+$/.test(fbp)) userData.fbp = fbp;
  if (/^fb\.\d\.\d+\.[\w.-]+$/.test(fbc)) userData.fbc = fbc;
  const custom = {};
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  for (const key of ['content_name', 'content_category', 'page']) if (data[key]) custom[key] = clip(data[key], 120);
  return { event_name: name, event_time: Math.floor(now / 1000), event_id: eventId,
    action_source: 'website', event_source_url: url, user_data: userData, custom_data: custom };
}

async function sendCapi(meta, event, fetcher = fetch) {
  const m = meta || {};
  if (!event || !m.capiEnabled || !m.capiToken || !validPixel(m.pixelId)) return { sent: false };
  const body = { data: [event] };
  if (m.testEventCode) body.test_event_code = clip(m.testEventCode, 40);
  const response = await fetcher(`${GRAPH}/${m.pixelId}/events?access_token=${encodeURIComponent(m.capiToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) throw new Error('Meta CAPI HTTP ' + response.status);
  return { sent: true };
}

function normalizeSiteLead(input) {
  const p = input || {};
  const source = SOURCES.has(p.source) ? p.source : '';
  const sessionId = clip(p.sessionId, 64).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!source || !sessionId) return null;
  const given = p.answers && typeof p.answers === 'object' ? p.answers : {};
  const answers = {};
  for (const key of ANSWER_KEYS) if (given[key]) answers[key] = clip(given[key], 240);
  if (!Object.keys(answers).length) return null;
  const utm = p.utm && typeof p.utm === 'object' ? p.utm : {};
  return { source, sessionId, answers, qualified: p.qualified === true, reason: clip(p.reason, 120),
    utmSource: clip(utm.utm_source, 120), utmCampaign: clip(utm.utm_campaign, 120),
    fbclid: clip(p.fbclid, 200), landingUrl: clip(p.url, 300) };
}

module.exports = { CAPI_EVENTS, publicTracking, validGtm, validPixel, allowedOrigin, clientIp,
  buildCapiEvent, sendCapi, normalizeSiteLead };
