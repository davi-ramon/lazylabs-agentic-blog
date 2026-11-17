'use strict';

const crypto = require('node:crypto');
const GIF = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
const BLOG = 'your-blog';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clip = (value, max = 300) => String(value == null ? '' : value).slice(0, max);
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function bodyOf(req) {
  try { return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); }
  catch (_) { return {}; }
}
function validId(value) { return /^[a-zA-Z0-9_-]{8,100}$/.test(String(value || '')); }
function validSubscriberId(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function sign(secret, action, campaignId, sid) {
  return crypto.createHmac('sha256', secret).update(action + ':' + campaignId + ':' + sid).digest('hex');
}
function signatureOk(secret, action, campaignId, sid, signature) {
  if (!/^[a-f0-9]{64}$/.test(String(signature || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(secret, action, campaignId, sid)), Buffer.from(signature));
}
async function trackingSecret(db) {
  const ref = db().doc('config/newsletter_tracking');
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().secret) return snap.data().secret;
    const secret = crypto.randomBytes(32).toString('hex');
    tx.set(ref, { secret, created_at: new Date().toISOString() });
    return secret;
  });
}
function trackedUrl(action, campaignId, sid, secret) {
  return 'https://blog.example.com/api/campaigns/' + action + '?c=' + encodeURIComponent(campaignId)
    + '&s=' + sid + '&sig=' + sign(secret, action, campaignId, sid);
}
function articleUrl(slug) {
  return 'https://blog.example.com/artigo/' + encodeURIComponent(String(slug || '').trim());
}
function inactiveSubscriber(subscriber, settings, now = Date.now()) {
  if (!settings.enabled || subscriber.status !== 'active' || subscriber.consent !== true) return false;
  if (count(subscriber.send_count) < count(settings.min_sends || 3)) return false;
  const cutoff = now - count(settings.days || 60) * 86400000;
  const first = Date.parse(subscriber.first_sent_at || '');
  if (!Number.isFinite(first) || first > cutoff) return false;
  const engaged = Math.max(Date.parse(subscriber.last_open_at || '') || 0, Date.parse(subscriber.last_clicked_at || '') || 0);
  return engaged < cutoff;
}
async function markEngagement(db, campaignId, sid, kind) {
  const now = new Date().toISOString();
  const campaign = db().doc('campaigns/' + campaignId);
  const recipient = campaign.collection('recipients').doc(sid);
  const subscriber = db().doc('newsletter_subscribers/' + sid);
  return db().runTransaction(async tx => {
    const [recSnap, subSnap] = await Promise.all([tx.get(recipient), tx.get(subscriber)]);
    if (!recSnap.exists || !subSnap.exists) return false;
    const rec = recSnap.data();
    const patch = {};
    const subPatch = {};
    const increments = {};
    if (!rec.opened_at) {
      patch.opened_at = now; subPatch.last_open_at = now;
      increments.opened = require('firebase-admin/firestore').FieldValue.increment(1);
    }
    if (kind === 'click' && !rec.clicked_at) {
      patch.clicked_at = now; subPatch.last_clicked_at = now;
      increments.clicked = require('firebase-admin/firestore').FieldValue.increment(1);
    }
    if (!Object.keys(patch).length) return true;
    patch.status = kind === 'click' ? 'clicked' : (rec.clicked_at ? 'clicked' : 'opened');
    tx.update(recipient, patch); tx.update(subscriber, subPatch); tx.update(campaign, increments);
    return true;
  });
}
async function sendWithRetry(resendKey, request, idempotencyKey) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(request)
      });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (response.ok && data.id) return { ok: true, provider_id: String(data.id) };
      const retryable = response.status === 429 || response.status >= 500 || (response.status === 409 && data.name === 'concurrent_idempotent_requests');
      if (retryable && attempt < 3) {
        const after = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 15000) : 1000 * (2 ** attempt));
        continue;
      }
      return { ok: false, error_code: clip(data.name || response.status, 80), error_message: clip(data.message || 'Resend HTTP ' + response.status) };
    } catch (error) {
      if (attempt < 3) { await sleep(1000 * (2 ** attempt)); continue; }
      return { ok: false, error_code: 'network', error_message: clip(error.message) };
    }
  }
  return { ok: false, error_code: 'retry_exhausted', error_message: 'Limite de tentativas' };
}
async function refreshProvider(db, campaignId, recipients, resendKey) {
  if (!resendKey) return;
  const campaign = db().doc('campaigns/' + campaignId);
  for (let i = 0; i < recipients.length; i += 5) {
    await Promise.all(recipients.slice(i, i + 5).map(async rec => {
      if (!rec.provider_id) return;
      try {
        const response = await fetch('https://api.resend.com/emails/' + encodeURIComponent(rec.provider_id), {
          headers: { Authorization: 'Bearer ' + resendKey }
        });
        if (!response.ok) return;
        const data = await response.json();
        const event = String(data.last_event || '');
        if (!event) return;
        const patch = { provider_status: event, provider_checked_at: new Date().toISOString() };
        if (['delivered', 'opened', 'clicked'].includes(event)) patch.delivered_at = rec.delivered_at || patch.provider_checked_at;
        if (['bounced', 'failed', 'suppressed', 'complained'].includes(event)) patch.status = event;
        await campaign.collection('recipients').doc(rec.id).set(patch, { merge: true });
        if (event === 'opened' || event === 'clicked') await markEngagement(db, campaignId, rec.id, event === 'clicked' ? 'click' : 'open');
      } catch (_) { /* status remains unknown; keep the previous result */ }
    }));
    if (i + 5 < recipients.length) await sleep(700);
  }
  await campaign.set({ last_provider_sync_at: new Date().toISOString() }, { merge: true });
}
function campaignSummary(recipients) {
  return {
    delivered: recipients.filter(r => !!r.delivered_at).length,
    opened: recipients.filter(r => !!r.opened_at).length,
    clicked: recipients.filter(r => !!r.clicked_at).length,
    bounced: recipients.filter(r => ['bounced', 'failed', 'suppressed', 'complained'].includes(r.provider_status)).length
  };
}
async function sweep(db) {
  const configSnap = await db().doc('config/newsletter').get();
  const settings = configSnap.exists ? configSnap.data() : {};
  if (!settings.enabled) return { suppressed: 0 };
  const snap = await db().collection('newsletter_subscribers').where('status', '==', 'active').where('consent', '==', true).limit(2000).get();
  const targets = snap.docs.filter(doc => inactiveSubscriber(doc.data(), settings));
  for (let i = 0; i < targets.length; i += 400) {
    const batch = db().batch();
    targets.slice(i, i + 400).forEach(doc => batch.update(doc.ref, {
      status: 'suppressed', suppressed_reason: 'inactivity', suppressed_at: new Date().toISOString()
    }));
    await batch.commit();
  }
  return { suppressed: targets.length };
}

function createHandler(deps) {
  const { db, requireAdmin, getFormConfig, buildFormEmail, esc, json } = deps;
  return async function (req, res) {
    const origin = String(req.headers.origin || '');
    if (['https://blog.example.com', 'https://your-blog.web.app'].includes(origin)) res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
    const publicAction = ['subscribe', 'open', 'click', 'unsubscribe'].includes(action);
    try {
      if (!publicAction && !await requireAdmin(req, res)) return;
      const body = bodyOf(req);
      if (action === 'subscribe') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' });
        const email = clip(body.email, 320).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email) || body.consent !== true) return json(res, 400, { ok: false, message: 'E-mail e consentimento são obrigatórios.' });
        const sid = crypto.createHash('sha256').update(email).digest('hex');
        const ref = db().doc('newsletter_subscribers/' + sid);
        const existing = await ref.get();
        if (existing.exists) return json(res, 200, { ok: false, code: 'duplicate', message: 'E-mail já inscrito.' });
        const now = new Date().toISOString();
        await ref.set({ blog_id: clip(body.blog_id || BLOG, 80), email, first_name: clip(body.first_name, 100), last_name: clip(body.last_name, 100), nickname: clip(body.nickname, 100), source: clip(body.source, 120), consent: true, status: 'active', subscribed_at: now, updated_at: now, ip_hash: '' });
        return json(res, 200, { ok: true });
      }
      if (['open', 'click', 'unsubscribe'].includes(action)) {
        const { c, s, sig } = req.query || {};
        if (!validId(c) || !validSubscriberId(s)) return res.status(404).end();
        const secret = await trackingSecret(db);
        if (!signatureOk(secret, action, c, s, sig)) return res.status(403).end();
        if (action === 'open') {
          await markEngagement(db, c, s, 'open');
          return res.set('Cache-Control', 'no-store').type('gif').status(200).send(GIF);
        }
        if (action === 'click') {
          const snap = await db().doc('campaigns/' + c).get();
          if (!snap.exists) return res.status(404).end();
          await markEngagement(db, c, s, 'click');
          return res.set('Cache-Control', 'no-store').redirect(302, articleUrl(snap.data().slug));
        }
        if (req.method === 'GET') {
          return res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Cancelar newsletter</title><body style="font:16px Arial;background:#090b12;color:#eee;padding:40px;max-width:550px;margin:auto"><h1>Cancelar inscrição</h1><p>Você deixará de receber a newsletter da Lazy Labs.</p><form method="post"><button style="padding:12px 18px">Confirmar cancelamento</button></form></body></html>');
        }
        if (req.method !== 'POST') return res.status(405).end();
        await db().doc('newsletter_subscribers/' + s).set({ status: 'unsubscribed', consent: false, unsubscribed_at: new Date().toISOString() }, { merge: true });
        return res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Inscrição cancelada</title><body style="font:16px Arial;background:#090b12;color:#eee;padding:40px;max-width:550px;margin:auto"><h1>Inscrição cancelada</h1><p>Você não receberá mais esta newsletter.</p></body></html>');
      }
      if (action === 'subscribers' && req.method === 'GET') {
        const filterBlog = clip(req.query.blog_id, 80);
        const snap = await db().collection('newsletter_subscribers').orderBy('subscribed_at', 'desc').limit(2000).get();
        return json(res, 200, { ok: true, subscribers: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(row => !filterBlog || (row.blog_id || BLOG) === filterBlog) });
      }
      if (action === 'subscriber' && req.method === 'POST') {
        if (!validSubscriberId(body.id)) return json(res, 400, { ok: false, message: 'Inscrito inválido.' });
        const ref = db().doc('newsletter_subscribers/' + body.id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, message: 'Inscrito não encontrado.' });
        if (body.action === 'suppress' && snap.data().status === 'active') await ref.update({ status: 'suppressed', suppressed_reason: 'manual', suppressed_at: new Date().toISOString() });
        else if (body.action === 'restore' && snap.data().status === 'suppressed' && snap.data().consent === true && ['manual', 'inactivity'].includes(snap.data().suppressed_reason)) await ref.update({ status: 'active', suppressed_reason: '', restored_at: new Date().toISOString() });
        else return json(res, 400, { ok: false, message: 'Alteração não permitida para este contato.' });
        return json(res, 200, { ok: true });
      }
      if (action === 'settings') {
        const ref = db().doc('config/newsletter');
        if (req.method === 'GET') {
          const snap = await ref.get();
          return json(res, 200, { ok: true, settings: { enabled: false, days: 60, min_sends: 3, ...(snap.exists ? snap.data() : {}) } });
        }
        if (req.method === 'POST') {
          const days = Number(body.days), minSends = Number(body.min_sends);
          if (!Number.isInteger(days) || days < 30 || days > 365 || !Number.isInteger(minSends) || minSends < 2 || minSends > 20) return json(res, 400, { ok: false, message: 'Use 30–365 dias e 2–20 envios.' });
          await ref.set({ enabled: body.enabled === true, days, min_sends: minSends, updated_at: new Date().toISOString() }, { merge: true });
          return json(res, 200, { ok: true });
        }
      }
      if (action === 'list' && req.method === 'GET') {
        const filterBlog = clip(req.query.blog_id, 80);
        const snap = await db().collection('campaigns').orderBy('created_at', 'desc').limit(300).get();
        return json(res, 200, { ok: true, campaigns: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(row => !filterBlog || (row.blog_id || BLOG) === filterBlog) });
      }
      if (action === 'detail' && req.method === 'GET') {
        const id = String(req.query.id || '');
        if (!validId(id)) return json(res, 400, { ok: false, message: 'Campanha inválida.' });
        const ref = db().doc('campaigns/' + id);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, message: 'Campanha não encontrada.' });
        let recipients = (await ref.collection('recipients').limit(500).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const syncAt = Date.parse(snap.data().last_provider_sync_at || '') || 0;
        if (req.query.refresh === '1' && recipients.length && Date.now() - syncAt > 60000) {
          const form = await getFormConfig();
          await refreshProvider(db, id, recipients, form.email && form.email.resendKey);
          recipients = (await ref.collection('recipients').limit(500).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
          await ref.set(campaignSummary(recipients), { merge: true });
        }
        return json(res, 200, { ok: true, campaign: { id, ...(await ref.get()).data() }, recipients });
      }
      if (action === 'send' && req.method === 'POST') {
        const form = await getFormConfig();
        const emailConfig = form.email || {};
        if (!emailConfig.resendKey) return json(res, 400, { ok: false, message: 'Configure o Resend em Formulário → E-mail.' });
        const title = clip(body.post_title, 300).trim();
        const slug = clip(body.slug, 200).trim();
        if (!title || !/^[a-z0-9][a-z0-9-]{1,199}$/.test(slug)) return json(res, 400, { ok: false, message: 'Título e slug válidos são obrigatórios.' });
        const filterBlog = clip(body.blog_id || BLOG, 80);
        const snap = await db().collection('newsletter_subscribers').where('status', '==', 'active').where('consent', '==', true).limit(2000).get();
        const subscribers = snap.docs.filter(doc => (doc.data().blog_id || BLOG) === filterBlog);
        if (!subscribers.length) return json(res, 400, { ok: false, message: 'Nenhum inscrito ativo com consentimento.' });
        const started = new Date().toISOString();
        const campaignRef = await db().collection('campaigns').add({ blog_id: filterBlog, subject: clip(body.subject || 'Novo no blog: ' + title, 200), post_title: title, slug, total: subscribers.length, sent: 0, failed: 0, delivered: 0, opened: 0, clicked: 0, status: 'sending', created_at: Date.now(), sent_at: started });
        const secret = await trackingSecret(db);
        const from = emailConfig.fromEmail ? (clip(emailConfig.fromName || 'Lazy Labs', 100) + ' <' + emailConfig.fromEmail + '>') : 'Lazy Labs <onboarding@resend.dev>';
        const subjectTpl = clip(body.subject || 'Novo no blog: ' + title, 200);
        let sent = 0, failed = 0;
        for (let i = 0; i < subscribers.length; i += 5) {
          const results = await Promise.all(subscribers.slice(i, i + 5).map(async doc => {
            const s = doc.data(), sid = doc.id;
            const first = clip(s.first_name || s.nickname, 80).trim();
            const last = clip(s.last_name, 80).trim();
            const nickname = clip(s.nickname || first, 80).trim();
            const subject = subjectTpl.replace(/@firstname/gi, first).replace(/@nickname/gi, nickname).replace(/@lastname/gi, last) || title;
            const unsub = trackedUrl('unsubscribe', campaignRef.id, sid, secret);
            const click = trackedUrl('click', campaignRef.id, sid, secret);
            const open = trackedUrl('open', campaignRef.id, sid, secret);
            const bodyHtml = esc(clip(body.excerpt, 2000)) + '<p style="margin-top:22px;font-size:12px"><a href="' + esc(unsub) + '" style="color:#9aa4b5">Cancelar inscrição</a></p>';
            const html = buildFormEmail({ heading: esc(title), body: bodyHtml, ctaUrl: esc(click), ctaText: esc(clip(body.cta_label || 'Ler artigo completo', 80)) }).replace('</body>', '<img src="' + esc(open) + '" alt="" width="1" height="1" style="width:1px;height:1px;opacity:0" /></body>');
            const result = await sendWithRetry(emailConfig.resendKey, { from, to: [s.email], subject, html, headers: { 'List-Unsubscribe': '<' + unsub + '>' } }, 'newsletter/' + campaignRef.id + '/' + sid);
            return { doc, result };
          }));
          const batch = db().batch();
          const now = new Date().toISOString();
          for (const { doc, result } of results) {
            batch.set(campaignRef.collection('recipients').doc(doc.id), {
              email: doc.data().email, first_name: clip(doc.data().first_name, 100), nickname: clip(doc.data().nickname, 100),
              status: result.ok ? 'accepted' : 'error', provider_id: result.provider_id || '',
              error_code: result.error_code || '', error_message: result.error_message || '', sent_at: now
            });
            if (result.ok) {
              sent++;
              batch.set(doc.ref, { first_sent_at: doc.data().first_sent_at || now, last_sent_at: now, send_count: require('firebase-admin/firestore').FieldValue.increment(1) }, { merge: true });
            } else failed++;
          }
          batch.update(campaignRef, { sent, failed, updated_at: now });
          await batch.commit();
          if (i + 5 < subscribers.length) await sleep(800);
        }
        await campaignRef.update({ status: 'completed', completed_at: new Date().toISOString(), sent, failed });
        return json(res, 200, { ok: true, campaign_id: campaignRef.id, sent, failed, total: subscribers.length });
      }
      if (action === 'log' && req.method === 'POST') {
        const total = count(body.total), sent = count(body.sent);
        const ref = await db().collection('campaigns').add({ blog_id: clip(body.blog_id || BLOG, 80), subject: clip(body.subject, 300), post_title: clip(body.post_title || body.title, 300), slug: clip(body.slug, 200), sent, failed: count(body.failed != null ? body.failed : total - sent), total, sent_at: body.sent_at || new Date().toISOString(), created_at: Date.now(), status: 'legacy' });
        return json(res, 200, { ok: true, id: ref.id });
      }
      return json(res, 404, { ok: false, message: 'Rota não encontrada.' });
    } catch (error) {
      console.error('[newsletter]', action, error && error.message);
      return json(res, 500, { ok: false, message: 'Falha ao processar a newsletter.' });
    }
  };
}

module.exports = { createHandler, inactiveSubscriber, signatureOk, sign, campaignSummary, sweep };
