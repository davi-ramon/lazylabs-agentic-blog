'use strict';

const { createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const cheerio = require('cheerio');

const SESSION_MS = 6 * 60 * 60 * 1000;
const slugValid = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 200;
const visitorValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const count = value => Math.max(0, Number(value) || 0);
const buttonId = (label, href) => createHash('sha256').update(String(label || '').trim() + '\0' + String(href || '').trim()).digest('hex').slice(0, 20);

function buttons(post) {
  const $ = cheerio.load(String(post.content || ''), null, false);
  const found = $('a.article-cta').toArray().map(node => ({
    id: buttonId($(node).text(), $(node).attr('href')),
    label: $(node).text().trim(), href: String($(node).attr('href') || '')
  })).filter(item => /^https:\/\//i.test(item.href) && item.label);
  if (post.cta_label && /^https:\/\//i.test(post.cta_url || '')) {
    found.push({ id: buttonId(post.cta_label, post.cta_url), label: post.cta_label, href: post.cta_url });
  }
  return found;
}

function stats(post) {
  return {
    pageLoads: count(post.page_load_count),
    views: count(post.qualified_view_count),
    reads: count(post.read_session_count),
    comments: count(post.comment_count),
    articleClicks: count(post.feed_click_count),
    buttonClicks: count(post.cta_click_count),
    buttons: buttons(post).map(item => ({ id:item.id, count:count((post.button_clicks || {})[item.id]) }))
  };
}

async function handle(action, db, body, res) {
  const slug = String(body.slug || '').trim();
  if (!slugValid(slug)) { res.status(400).json({ ok:false, message:'Artigo inválido.' }); return; }
  const ref = db.doc('posts/' + slug);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== 'your-blog') {
    res.status(404).json({ ok:false, message:'Artigo não encontrado.' }); return;
  }
  const post = snap.data();
  res.set('Cache-Control', 'no-store');
  if (action === 'engagementStats') { res.status(200).json({ ok:true, ...stats(post) }); return; }
  if (action === 'engagementOpen') {
    await ref.update({ page_load_count:FieldValue.increment(1) });
    res.status(200).json({ ok:true }); return;
  }
  if (action === 'engagementClick') {
    if (body.kind === 'feed') {
      await ref.update({ feed_click_count:FieldValue.increment(1) });
    } else if (body.kind === 'button' && buttons(post).some(item => item.id === body.buttonId)) {
      await ref.update({ cta_click_count:FieldValue.increment(1), [`button_clicks.${body.buttonId}`]:FieldValue.increment(1) });
    } else { res.status(400).json({ ok:false, message:'Botão inválido.' }); return; }
    res.status(200).json({ ok:true }); return;
  }
  const visitorId = String(body.visitorId || '');
  if (!visitorValid(visitorId)) { res.status(400).json({ ok:false, message:'Sessão inválida.' }); return; }
  const progress = Number(body.progress);
  const qualifies = action === 'engagementQualify' && progress >= 0.04 && progress <= 1 && Number(body.elapsedMs) >= 2000;
  const read = action === 'engagementRead' && progress >= 0.5 && progress <= 1 && Number(body.activeSeconds) >= 30;
  if (!qualifies && !read) { res.status(400).json({ ok:false, message:'Engajamento insuficiente.' }); return; }
  const sessionId = createHash('sha256').update(visitorId).digest('hex');
  const sessionRef = ref.collection('engagementSessions').doc(sessionId);
  const now = Date.now();
  const field = read ? 'last_read_at' : 'last_view_at';
  const metric = read ? 'read_session_count' : 'qualified_view_count';
  const added = await db.runTransaction(async tx => {
    const current = await tx.get(sessionRef);
    const last = current.exists ? Number(current.data()[field]) || 0 : 0;
    if (now - last < SESSION_MS) return false;
    tx.set(sessionRef, { [field]:now, updated_at:now }, { merge:true });
    tx.update(ref, { [metric]:FieldValue.increment(1) });
    return true;
  });
  res.status(200).json({ ok:true, counted:added, windowHours:6 });
}

module.exports = { handle, stats, buttons, buttonId, SESSION_MS };
