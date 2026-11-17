'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const newsletter = require('./newsletter');

test('inactivity requires opt-in, prior sends, elapsed time, and no recent engagement', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const subscriber = { status: 'active', consent: true, send_count: 3, first_sent_at: '2026-08-01T12:00:00Z' };
  const settings = { enabled: true, days: 60, min_sends: 3 };
  assert.equal(newsletter.inactiveSubscriber(subscriber, settings, now), true);
  assert.equal(newsletter.inactiveSubscriber(subscriber, { ...settings, enabled: false }, now), false);
  assert.equal(newsletter.inactiveSubscriber({ ...subscriber, send_count: 2 }, settings, now), false);
  assert.equal(newsletter.inactiveSubscriber({ ...subscriber, last_open_at: '2026-11-01T12:00:00Z' }, settings, now), false);
  assert.equal(newsletter.inactiveSubscriber({ ...subscriber, last_clicked_at: '2026-11-01T12:00:00Z' }, settings, now), false);
  assert.equal(newsletter.inactiveSubscriber({ ...subscriber, consent: false }, settings, now), false);
});

test('tracking signature binds action, campaign, and recipient', () => {
  const sig = newsletter.sign('private-secret', 'click', 'campaign01', 'a'.repeat(64));
  assert.equal(newsletter.signatureOk('private-secret', 'click', 'campaign01', 'a'.repeat(64), sig), true);
  assert.equal(newsletter.signatureOk('private-secret', 'open', 'campaign01', 'a'.repeat(64), sig), false);
  assert.equal(newsletter.signatureOk('private-secret', 'click', 'campaign02', 'a'.repeat(64), sig), false);
  assert.equal(newsletter.signatureOk('private-secret', 'click', 'campaign01', 'b'.repeat(64), sig), false);
});

test('campaign summary counts unique recipient outcomes', () => {
  assert.deepEqual(newsletter.campaignSummary([
    { delivered_at: 'now', opened_at: 'now', clicked_at: 'now' },
    { delivered_at: 'now', opened_at: 'now' },
    { provider_status: 'bounced' }
  ]), { delivered: 2, opened: 2, clicked: 1, bounced: 1 });
});
