const test = require('node:test');
const assert = require('node:assert/strict');
const tracking = require('./site-tracking');

const base = { event: 'Lead', eventId: 'evt-12345678', url: 'https://example.com/agendar',
  fbp: 'fb.1.1700000000000.123456', fbc: 'fb.1.1700000000000.AbCd_1', data: { content_name: 'CRM', secret: 'x' } };

test('config pública expõe só IDs válidos, nunca o token', () => {
  const out = tracking.publicTracking({ meta: { pixelId: '123456789012345', gtmId: 'GTM-ABC1234', capiToken: 'segredo' } });
  assert.deepEqual(out, { pixelId: '123456789012345', gtmId: 'GTM-ABC1234' });
  assert.deepEqual(tracking.publicTracking({ meta: { pixelId: '<script>', gtmId: 'abc' } }), { pixelId: '', gtmId: '' });
});

test('evento CAPI usa o mesmo event_id do navegador e filtra campos', () => {
  const event = tracking.buildCapiEvent(base, { ip: '200.1.2.3', userAgent: 'UA' }, 1700000000000);
  assert.equal(event.event_id, 'evt-12345678');
  assert.equal(event.event_time, 1700000000);
  assert.equal(event.user_data.client_ip_address, '200.1.2.3');
  assert.equal(event.user_data.fbp, base.fbp);
  assert.deepEqual(event.custom_data, { content_name: 'CRM' });
});

test('recusa evento fora da lista, URL de outro domínio e ID inválido', () => {
  assert.equal(tracking.buildCapiEvent({ ...base, event: 'Purchase' }, {}), null);
  assert.equal(tracking.buildCapiEvent({ ...base, url: 'https://example.com.evil.com/' }, {}), null);
  assert.equal(tracking.buildCapiEvent({ ...base, eventId: 'x' }, {}), null);
});

test('CAPI só envia quando ligado e com token', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true }; };
  const event = tracking.buildCapiEvent(base, {});
  assert.deepEqual(await tracking.sendCapi({ capiEnabled: false, capiToken: 't', pixelId: '123456789012345' }, event, fetcher), { sent: false });
  assert.equal(calls, 0);
  assert.deepEqual(await tracking.sendCapi({ capiEnabled: true, capiToken: 't', pixelId: '123456789012345' }, event, fetcher), { sent: true });
  assert.equal(calls, 1);
});

test('origem liberada só para o site institucional', () => {
  assert.equal(tracking.allowedOrigin('https://example.com'), true);
  assert.equal(tracking.allowedOrigin('https://evil.com'), false);
  assert.equal(tracking.allowedOrigin(''), false);
});

test('lead do chat aceita só respostas conhecidas e exige origem válida', () => {
  const lead = tracking.normalizeSiteLead({ source: 'agendar', sessionId: 'abc-123', qualified: true,
    answers: { desafio: 'CRM', outro: 'ignorar' } });
  assert.deepEqual(lead.answers, { desafio: 'CRM' });
  assert.equal(lead.qualified, true);
  assert.equal(tracking.normalizeSiteLead({ source: 'x', sessionId: 'a', answers: { desafio: 'y' } }), null);
  assert.equal(tracking.normalizeSiteLead({ source: 'bot', sessionId: 'a', answers: {} }), null);
});
