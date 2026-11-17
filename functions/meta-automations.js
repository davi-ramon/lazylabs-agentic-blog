'use strict';

const { createHmac, createHash, timingSafeEqual } = require('node:crypto');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getFunctions } = require('firebase-admin/functions');
const { requireAdmin_ } = require('./admin');

const GRAPH = 'https://graph.facebook.com/v26.0';
const IG_GRAPH = 'https://graph.instagram.com/v26.0';
const REGION = 'southamerica-east1';
const RULES = 'automations';
const EVENTS = 'events';
const LEADS = 'leads';
const RATE_CODES = new Set([4, 17, 32, 613]);
const PERMISSION_CODES = new Set([10, 200]);
const ID = /^[a-zA-Z0-9_-]{5,100}$/;
let _db;
const db = () => (_db ||= getFirestore());
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const eventRef = event => db().doc(`${EVENTS}/${event.channel}_${hash(event.commentId)}`);
const leadRef = (channel, id) => db().doc(`${LEADS}/${channel}_${hash(id)}`);
const queue = () => getFunctions().taskQueue(`locations/${REGION}/functions/metaAutomationTask`);

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
function verifySignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !secret || !/^sha256=[a-f\d]{64}$/i.test(String(signature || ''))) return false;
  return safeEqual(signature, 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
}
function stringList(value, normalizer, limit, maxLength) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Lista inválida ou longa demais.');
  return [...new Set(value.map(v => normalizer(String(v || '').trim())).filter(Boolean))]
    .map(v => { if (v.length > maxLength) throw new Error('Item longo demais.'); return v; });
}
function validRule(input) {
  const value = input || {};
  const channel = String(value.channel || '');
  const accountId = String(value.accountId || '').trim();
  if (!['instagram', 'facebook'].includes(channel) || !/^\d{5,30}$/.test(accountId)) throw new Error('Canal ou ID da conta inválido.');
  const keywords = stringList(value.keywords, normalized, 20, 48);
  const postIds = stringList(value.postIds || [], v => v, 50, 100);
  const publicReplies = stringList(value.publicReplies, v => v, 10, 200);
  const dmText = String(value.dmText || '').trim();
  const buttonLabel = String(value.buttonLabel || '').trim();
  const link = String(value.link || '').trim();
  if (!keywords.length || !publicReplies.length) throw new Error('Informe palavra-chave e resposta pública.');
  if (postIds.some(v => !/^[a-zA-Z0-9_:-]+$/.test(v))) throw new Error('ID de post inválido.');
  if (!dmText || dmText.length > 600 || !buttonLabel || buttonLabel.length > 20) throw new Error('Mensagem ou botão inválido.');
  let url;
  try { url = new URL(link); } catch { throw new Error('Link inválido.'); }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || link.length > 1500) throw new Error('Use um link HTTPS público.');
  const nodeOrder = Array.isArray(value.nodeOrder) && value.nodeOrder.length === 6 &&
    [...value.nodeOrder].sort().join(',') === '1,2,3,4,5,6' ? value.nodeOrder.map(Number) : [1,2,3,4,5,6];
  const visualInput = value.visualLayout && typeof value.visualLayout === 'object' ? value.visualLayout : {};
  const visualLayout = { orientation:visualInput.orientation === 'horizontal' ? 'horizontal' : 'vertical', positions:{} };
  if (channel === 'instagram' && visualInput.conditionEnabled === false) visualLayout.conditionEnabled = false;
  for (let step=1; step<=6; step++) {
    const point = visualInput.positions?.[step];
    if (!point) continue;
    const x = Number(point.x), y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) throw new Error('Posição de bloco inválida.');
    visualLayout.positions[step] = { x:Math.round(x), y:Math.round(y) };
  }
  return { channel, accountId, keywords, postIds, publicReplies, dmText, buttonLabel,
    link:url.toString(), nodeOrder, visualLayout, requireFollow:channel === 'instagram' && visualLayout.conditionEnabled !== false && value.requireFollow === true,
    active:value.active === true };
}
function matches(rule, event) {
  if (!rule.active || rule.channel !== event.channel || rule.accountId !== event.accountId) return false;
  if (!Array.isArray(rule.keywords) || !Array.isArray(rule.postIds)) return false;
  if (rule.postIds.length && !rule.postIds.includes(event.postId)) return false;
  const text = ` ${normalized(event.text)} `;
  return rule.keywords.some(word => text.includes(` ${word} `));
}
function eventId(event) { return `${event.channel}_${hash(event.commentId)}`; }
function buttonPayload(ruleId) { return `AUTO_${ruleId}`; }
function quickReply(rule) {
  return [{ content_type:'text', title:rule.buttonLabel, payload:buttonPayload(rule.id) }];
}
function privateReplyMessage(rule) {
  // Alguns clientes do Instagram não exibem quick replies em respostas privadas
  // a comentários. A instrução de texto mantém o fluxo acessível nesses casos.
  const destination = rule.channel === 'facebook' ? 'Messenger' : 'Direct';
  const fallback = `Se o botão não aparecer, responda "${rule.buttonLabel}" aqui no ${destination}.`;
  return `${rule.dmText}\n\n${fallback}`.slice(0, 1000);
}
function inboundMessage(value, channel, accountId, entryTime) {
  const senderId = String(value.sender?.id || value.from?.id || '');
  if (!/^\d{5,30}$/.test(senderId) || senderId === accountId || value.message?.is_echo) return null;
  const messageId = String(value.message?.mid || value.postback?.mid || '');
  const payload = String(value.postback?.payload || value.message?.quick_reply?.payload || '');
  const at = value.timestamp || entryTime || '';
  if (payload.startsWith('AUTO_')) return { kind:'tap', channel, accountId, senderId, payload, messageId, at };
  const text = String(value.message?.text || '').slice(0, 100);
  return text && messageId ? { kind:'message', channel, accountId, senderId, text, messageId, at } : null;
}
function classifyGraphError(error) {
  const code = Number(error && error.code);
  return RATE_CODES.has(code) ? 'rate' : PERMISSION_CODES.has(code) ? 'permission' : 'other';
}
function parseWebhook(body) {
  const result = [];
  if (!body || !['instagram', 'page'].includes(body.object) || !Array.isArray(body.entry)) return result;
  const channel = body.object === 'instagram' ? 'instagram' : 'facebook';
  for (const entry of body.entry.slice(0, 100)) {
    const accountId = String(entry.id || '');
    if (!/^\d{5,30}$/.test(accountId)) continue;
    for (const change of (entry.changes || []).slice(0, 100)) {
      const value = change.value || {};
      if (channel === 'instagram' && change.field === 'comments') {
        const commentId = String(value.id || '');
        if (!/^[\d_]{5,100}$/.test(commentId)) continue;
        const commenterId = String(value.from?.id || '');
        if (commenterId && commenterId === accountId) continue;
        result.push({ kind:'comment', channel, accountId, commentId, postId:String(value.media?.id || ''),
          commenterId, username:String(value.from?.username || '').slice(0, 80), text:String(value.text || '').slice(0, 2000),
          createdAt:value.timestamp || entry.time || '' });
      } else if (channel === 'facebook' && change.field === 'feed' && value.item === 'comment' && value.verb === 'add') {
        const commentId = String(value.comment_id || '');
        if (!/^[\d_]{5,100}$/.test(commentId)) continue;
        const commenterId = String(value.from?.id || '');
        if (commenterId && commenterId === accountId) continue;
        result.push({ kind:'comment', channel, accountId, commentId, postId:String(value.post_id || ''),
          commenterId, username:'', text:String(value.message || '').slice(0, 2000), createdAt:value.created_time || entry.time || '' });
      } else if (['messages', 'messaging_postbacks'].includes(change.field)) {
        const inbound = inboundMessage(value, channel, accountId, entry.time);
        if (inbound) result.push(inbound);
      }
    }
    for (const msg of (entry.messaging || []).slice(0, 100)) {
      const inbound = inboundMessage(msg, channel, accountId, entry.time);
      if (inbound) result.push(inbound);
    }
  }
  return result.slice(0, 200);
}
const eventsFromWebhook = parseWebhook;

class GraphError extends Error {
  constructor(data, status) {
    super(String(data?.error?.message || `Meta HTTP ${status}`).slice(0, 200));
    this.code = Number(data?.error?.code || 0);
    this.status = status;
    this.kind = classifyGraphError(this);
  }
}
async function graph(path, token, options = {}) {
  if (!token) throw new Error('Token Meta ausente.');
  const host = options.instagramProfile ? IG_GRAPH : GRAPH;
  const url = new URL(host + path);
  if (options.fields) url.searchParams.set('fields', options.fields);
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method:options.method || 'GET', signal:AbortSignal.timeout(12000),
    headers:{ Authorization:`Bearer ${token}`, ...(options.params ? { 'Content-Type':'application/x-www-form-urlencoded' } : {}),
      ...(options.json ? { 'Content-Type':'application/json' } : {}) },
    body:options.params ? new URLSearchParams(options.params) : options.json ? JSON.stringify(options.json) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new GraphError(data, response.status);
  return data;
}
function token() { return process.env.META_SYSTEM_USER_TOKEN || ''; }
let cachedPageToken = { value:'', expires:0 };
async function pageToken(pageId) {
  if (cachedPageToken.value && Date.now() < cachedPageToken.expires) return cachedPageToken.value;
  const page = await graph(`/${pageId}`, token(), { fields:'access_token' });
  if (!page.access_token) throw new Error('Token da Página indisponível para o usuário de sistema.');
  cachedPageToken = { value:page.access_token, expires:Date.now() + 10 * 60000 };
  return page.access_token;
}
async function outboundMessageToken(channel, pageId) {
  // Instagram private replies/messaging use the system-user token for this app.
  // The derived Page token can read comments but Meta rejects its private replies
  // with error 200 / subcode 2534066. Facebook Messenger still needs Page token.
  return channel === 'instagram' ? token() : pageToken(pageId);
}
async function accountConfig() {
  const snap = await db().doc('config/social').get();
  const config = snap.exists ? snap.data() : {};
  return { instagram:String(config.instagramAccountId || ''), facebook:String(config.metaPageId || '') };
}
async function increment(ruleId, field) {
  await db().doc(`${RULES}/${ruleId}`).update({ [`counts.${field}`]:FieldValue.increment(1) });
}
function chooseReply(rule, commentId) {
  const index = parseInt(hash(commentId).slice(0, 8), 16) % rule.publicReplies.length;
  return rule.publicReplies[index];
}
async function updateEvent(ref, status, extra = {}) {
  await ref.set({ status, updatedAt:now(), ...extra }, { merge:true });
}
async function recordError(ref, ruleId, stage, error) {
  await updateEvent(ref, 'error', { errorStage:stage, errorCode:Number(error.code || 0),
    error:String(error.message || 'Falha').slice(0, 180) });
  if (ruleId) await increment(ruleId, 'errors');
  console.error('[meta-automation] stage failed', stage, Number(error.code || 0));
}
async function enqueue(data, delaySeconds = 0) {
  return queue().enqueue(data, { scheduleDelaySeconds:delaySeconds, dispatchDeadlineSeconds:120 });
}
async function receiveComment(event) {
  const config = await accountConfig();
  if (event.accountId !== config[event.channel] || event.commenterId === event.accountId) return;
  const ref = eventRef(event);
  const existing = await ref.get();
  if (existing.exists && !['public_rate_retry', 'replied'].includes(existing.data().status)) return;
  const rules = await db().collection(RULES).where('active', '==', true).limit(100).get();
  const ruleDoc = rules.docs.find(doc => matches({ id:doc.id, ...doc.data() }, event));
  if (!ruleDoc) return;
  const rule = { id:ruleDoc.id, ...ruleDoc.data() };
  if (!existing.exists) {
    try { await ref.create({ ...event, ruleId:rule.id, status:'public_pending', receivedAt:now(), updatedAt:now() }); }
    catch (error) { if (error.code === 6) return; throw error; }
  } else if (existing.data().status === 'replied') {
    await enqueue({ kind:'dm', eventId:ref.id }, 5 + parseInt(hash(event.commentId).slice(0, 2), 16) % 16);
    return;
  }
  try {
    const edge = event.channel === 'instagram' ? 'replies' : 'comments';
    await graph(`/${encodeURIComponent(event.commentId)}/${edge}`, await pageToken(config.facebook), { method:'POST', params:{ message:chooseReply(rule, event.commentId) } });
  } catch (error) {
    if (error.kind === 'rate') { await updateEvent(ref, 'public_rate_retry'); throw error; }
    await recordError(ref, rule.id, 'public', error);
    return;
  }
  await updateEvent(ref, 'replied', { publicRepliedAt:now() });
  await increment(rule.id, 'comments').catch(() => console.error('[meta-automation] counter failed'));
  await enqueue({ kind:'dm', eventId:ref.id }, 5 + parseInt(hash(event.commentId).slice(0, 2), 16) % 16);
}
async function sendPrivate(eventId) {
  const ref = db().doc(`${EVENTS}/${eventId}`);
  const snap = await ref.get();
  if (!snap.exists || !['replied', 'dm_rate_retry'].includes(snap.data().status)) return;
  const event = snap.data();
  const ruleSnap = await db().doc(`${RULES}/${event.ruleId}`).get();
  if (!ruleSnap.exists || !ruleSnap.data().active) return;
  const rule = { id:ruleSnap.id, ...ruleSnap.data() };
  const created = Number(event.createdAt) || Date.parse(event.createdAt);
  if (!Number.isFinite(created) || Date.now() - (created < 1e12 ? created * 1000 : created) > 7 * 86400000) {
    await updateEvent(ref, 'error', { errorStage:'dm', error:'Data ausente ou comentário fora da janela de sete dias.' }); return;
  }
  const claimed = await db().runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || !['replied', 'dm_rate_retry'].includes(current.data().status)) return false;
    tx.update(ref, { status:'dm_pending', updatedAt:now() });
    return true;
  });
  if (!claimed) return;
  try {
    const config = await accountConfig();
    const sent = await graph(`/${event.accountId}/messages`, await outboundMessageToken(event.channel, config.facebook), { method:'POST', json:{
      recipient:{ comment_id:event.commentId }, message:{ text:privateReplyMessage(rule), quick_replies:quickReply(rule) }
    } });
    const igsid = String(sent.recipient_id || '');
    await updateEvent(ref, 'dm_sent', { dmSentAt:now(), igsid });
    if (igsid) await leadRef(event.channel, igsid).set({ channel:event.channel, senderId:igsid,
      automations:FieldValue.arrayUnion(rule.id), firstSeenAt:now(), updatedAt:now(),
      pending:true, pendingRuleId:rule.id, pendingSince:now(), pendingButtonLabel:rule.buttonLabel,
      pendingAccountId:event.accountId }, { merge:true });
    await increment(rule.id, 'directs');
  } catch (error) {
    if (error.kind === 'rate') { await updateEvent(ref, 'dm_rate_retry'); throw error; }
    // A timeout may occur after Meta accepted the one permitted private reply. Do not retry it.
    await recordError(ref, rule.id, 'dm', error);
  }
}
async function receiveTap(event) {
  const ruleId = event.payload.slice(5);
  if (!ID.test(ruleId)) return;
  const ruleSnap = await db().doc(`${RULES}/${ruleId}`).get();
  if (!ruleSnap.exists) return;
  const rule = { id:ruleId, ...ruleSnap.data() };
  const config = await accountConfig();
  if (!rule.active || rule.channel !== event.channel || rule.accountId !== event.accountId || event.accountId !== config[event.channel]) return;
  const lead = leadRef(event.channel, event.senderId);
  const leadSnap = await lead.get();
  const prior = leadSnap.exists ? leadSnap.data() : {};
  const pendingSince = Date.parse(prior.pendingSince || '');
  if (!prior.pending || prior.pendingRuleId !== ruleId || prior.pendingAccountId !== event.accountId ||
      !Number.isFinite(pendingSince) || Date.now() - pendingSince > 24 * 3600000) return;
  const eventAt = Number(event.at) || Date.parse(event.at);
  const eventMillis = eventAt < 1e12 ? eventAt * 1000 : eventAt;
  if (Number.isFinite(pendingSince) && Number.isFinite(eventMillis) && eventMillis < pendingSince) return;
  if (deliveredForPending(prior, ruleId)) {
    if (prior.pendingRuleId === ruleId) await lead.set({ pending:false, updatedAt:now() }, { merge:true });
    return;
  }
  const tapId = event.messageId || hash(`${event.accountId}:${event.senderId}:${event.payload}:${event.at}`);
  const tapRef = db().doc(`${EVENTS}/tap_${hash(tapId)}`);
  try { await tapRef.create({ ...event, ruleId, status:'pending', receivedAt:now(), updatedAt:now() }); }
  catch (error) {
    if (error.code !== 6) throw error;
    const retry = await tapRef.get();
    if (!retry.exists || retry.data().status !== 'rate_retry') return;
    await updateEvent(tapRef, 'pending');
  }
  try {
    const tappedAt = Number(event.at) || Date.parse(event.at);
    const tapTime = tappedAt < 1e12 ? tappedAt * 1000 : tappedAt;
    if (tappedAt && Date.now() - tapTime > 24 * 3600000) {
      await updateEvent(tapRef, 'error', { errorStage:'tap', error:'Janela de mensagem expirada.' });
      return;
    }
    let profile = {};
    if (rule.channel === 'instagram' && rule.requireFollow) {
      profile = await graph(`/${encodeURIComponent(event.senderId)}`, await pageToken(config.facebook), {
        fields:'username,is_user_follow_business'
      });
      if (typeof profile.is_user_follow_business !== 'boolean') throw new Error('Meta não informou se o usuário segue a conta. Link bloqueado.');
      if (profile.is_user_follow_business !== true) {
        await graph(`/${event.accountId}/messages`, await outboundMessageToken(event.channel, config.facebook), { method:'POST', json:{
          recipient:{ id:event.senderId }, message:{ text:`Me segue e toque de novo. Se o botão não aparecer, responda "${rule.buttonLabel}" aqui. 👇`, quick_replies:quickReply(rule) }
        } });
        await lead.set({ channel:event.channel, senderId:event.senderId, username:String(profile.username || '').slice(0, 80),
          follows:false, lastTapMessageId:event.messageId || '', automations:FieldValue.arrayUnion(ruleId),
          updatedAt:now(), firstSeenAt:prior.firstSeenAt || now() }, { merge:true });
        await updateEvent(tapRef, 'dm_sent', { followed:false });
        return;
      }
    }
    await graph(`/${event.accountId}/messages`, await outboundMessageToken(event.channel, config.facebook), { method:'POST', json:{
      recipient:{ id:event.senderId }, message:{ text:`${rule.dmText}\n${rule.link}` }
    } });
    await lead.set({ channel:event.channel, senderId:event.senderId,
      username:String(profile.username || prior.username || '').slice(0, 80),
      follows:rule.channel === 'instagram' && rule.requireFollow ? true : null,
      automations:FieldValue.arrayUnion(ruleId), linkSent:{ [ruleId]:now() },
      pending:false, lastTapMessageId:event.messageId || '', updatedAt:now(), firstSeenAt:prior.firstSeenAt || now() }, { merge:true });
    await updateEvent(tapRef, 'link_sent');
    await increment(ruleId, 'links');
    if (rule.channel === 'instagram' && rule.requireFollow && prior.follows === false) await increment(ruleId, 'newFollowers');
  } catch (error) {
    if (error.kind === 'rate') { await updateEvent(tapRef, 'rate_retry'); throw error; }
    await recordError(tapRef, ruleId, 'tap', error);
  }
}
async function receiveMessage(event) {
  const config = await accountConfig();
  if (event.accountId !== config[event.channel]) return;
  const snap = await leadRef(event.channel, event.senderId).get();
  const lead = snap.exists ? snap.data() : {};
  if (!lead.pending || lead.pendingAccountId !== event.accountId ||
      normalized(event.text) !== normalized(lead.pendingButtonLabel)) return;
  await receiveTap({ ...event, kind:'tap', payload:buttonPayload(lead.pendingRuleId) });
}
async function processTask(request) {
  const payload = request.data || {};
  if (payload.kind === 'batch' && Array.isArray(payload.events)) {
    for (const event of payload.events.slice(0, 200)) {
      if (event.kind === 'comment') await receiveComment(event);
      else if (event.kind === 'tap') await receiveTap(event);
      else if (event.kind === 'message') await receiveMessage(event);
    }
  } else if (payload.kind === 'dm' && /^[a-z]+_[a-f0-9]{64}$/.test(String(payload.eventId || ''))) {
    await sendPrivate(payload.eventId);
  }
}
function pendingTap(messages, lead) {
  if (!lead.pending || !lead.pendingRuleId || !lead.pendingButtonLabel || !lead.pendingSince) return null;
  const since = Date.parse(lead.pendingSince);
  if (!Number.isFinite(since)) return null;
  return (messages || []).find(message => message.id && message.id !== lead.lastTapMessageId &&
    String(message.from?.id || '') === String(lead.senderId || '') &&
    Date.parse(message.created_time || '') >= since &&
    normalized(message.message) === normalized(lead.pendingButtonLabel)) || null;
}
function deliveredForPending(lead, ruleId) {
  const pendingSince = Date.parse(lead.pendingSince || '');
  const deliveredAt = Date.parse(lead.linkSent?.[ruleId] || lead[`linkSent.${ruleId}`] || '');
  return Number.isFinite(pendingSince) && Number.isFinite(deliveredAt) && deliveredAt >= pendingSince;
}

// Temporary bounded fallback while Meta keeps this app in development mode and
// does not deliver real comment/message webhooks. The webhook remains primary.
async function pollInstagram() {
  const rulesSnap = await db().collection(RULES).where('active', '==', true).limit(100).get();
  const rules = rulesSnap.docs.map(doc => ({ id:doc.id, ...doc.data() })).filter(rule => rule.channel === 'instagram');
  if (!rules.length) return;
  const config = await accountConfig();
  if (!/^\d{5,30}$/.test(config.instagram) || !/^\d{5,30}$/.test(config.facebook)) return;
  const stateRef = db().doc('config/metaAutomationPoll');
  const state = await stateRef.get();
  const startedAt = state.exists ? String(state.data().startedAt || now()) : now();
  if (!state.exists) await stateRef.create({ startedAt, updatedAt:now() }).catch(error => {
    if (error.code !== 6) throw error;
  });
  const pageAccess = await pageToken(config.facebook);
  const media = await graph(`/${config.instagram}/media`, pageAccess, { fields:'id,timestamp', query:{ limit:25 } });
  const mediaIds = [...new Set([...(media.data || []).map(item => String(item.id || '')),
    ...rules.flatMap(rule => rule.postIds || [])])].filter(id => /^\d{5,30}$/.test(id)).slice(0, 50);
  const events = [];
  const earliest = Math.max(Date.parse(startedAt) || Date.now(), Date.now() - 7 * 86400000);
  for (const mediaId of mediaIds) {
    try {
      const comments = await graph(`/${mediaId}/comments`, pageAccess, {
        fields:'id,text,from,media,timestamp', query:{ limit:100 }
      });
      for (const item of comments.data || []) {
        const createdAt = String(item.timestamp || '');
        if (!item.id || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < earliest) continue;
        const event = { kind:'comment', channel:'instagram', accountId:config.instagram,
          commentId:String(item.id), postId:mediaId, commenterId:String(item.from?.id || ''),
          username:String(item.from?.username || '').slice(0, 80), text:String(item.text || '').slice(0, 2000), createdAt };
        if (event.commenterId === config.instagram || !rules.some(rule => matches(rule, event))) continue;
        if (!(await eventRef(event).get()).exists) events.push(event);
      }
    } catch (error) { console.error('[meta-automation] comment poll failed', Number(error.code || 0)); }
  }
  for (let i = 0; i < events.length; i += 50) await enqueue({ kind:'batch', events:events.slice(i, i + 50) });

  const leads = await db().collection(LEADS).where('pending', '==', true).limit(50).get();
  for (const leadDoc of leads.docs) {
    const lead = leadDoc.data();
    if (lead.channel !== 'instagram' || lead.pendingAccountId !== config.instagram) continue;
    if (Date.now() - Date.parse(lead.pendingSince || '') > 24 * 3600000) {
      await leadDoc.ref.set({ pending:false, updatedAt:now() }, { merge:true }); continue;
    }
    try {
      const conversations = await graph(`/${config.instagram}/conversations`, token(), {
        fields:'id', query:{ platform:'instagram', user_id:lead.senderId, limit:1 }
      });
      const conversationId = conversations.data?.[0]?.id;
      if (!conversationId) continue;
      const messages = await graph(`/${encodeURIComponent(conversationId)}/messages`, token(), {
        fields:'id,created_time,from,message', query:{ limit:20 }
      });
      const tapped = pendingTap(messages.data, lead);
      if (tapped) await enqueue({ kind:'batch', events:[{ kind:'tap', channel:'instagram',
        accountId:config.instagram, senderId:lead.senderId, payload:buttonPayload(lead.pendingRuleId),
        messageId:tapped.id, at:tapped.created_time }] });
    } catch (error) { console.error('[meta-automation] message poll failed', Number(error.code || 0)); }
  }
  await stateRef.set({ updatedAt:now(), mediaChecked:mediaIds.length, pendingChecked:leads.size }, { merge:true });
}
async function pollFacebook() {
  const rulesSnap = await db().collection(RULES).where('active', '==', true).limit(100).get();
  const rules = rulesSnap.docs.map(doc => ({ id:doc.id, ...doc.data() })).filter(rule => rule.channel === 'facebook');
  if (!rules.length) return;
  const config = await accountConfig();
  if (!/^\d{5,30}$/.test(config.facebook)) return;
  const stateRef = db().doc('config/metaAutomationFacebookPoll');
  const state = await stateRef.get();
  const startedAt = state.exists ? String(state.data().startedAt || now()) : now();
  if (!state.exists) await stateRef.create({ startedAt, updatedAt:now() }).catch(error => {
    if (error.code !== 6) throw error;
  });
  const access = await pageToken(config.facebook);
  const posts = await graph(`/${config.facebook}/posts`, access, { fields:'id,created_time', query:{ limit:25 } });
  const postIds = [...new Set([...(posts.data || []).map(item => String(item.id || '')),
    ...rules.flatMap(rule => rule.postIds || [])])].filter(id => /^[\d_]{5,100}$/.test(id)).slice(0, 50);
  const earliest = Math.max(Date.parse(startedAt) || Date.now(), Date.now() - 7 * 86400000);
  const events = [];
  for (const postId of postIds) {
    try {
      const comments = await graph(`/${encodeURIComponent(postId)}/comments`, access, {
        fields:'id,message,from,created_time', query:{ limit:100 }
      });
      for (const item of comments.data || []) {
        const createdAt = String(item.created_time || '');
        if (!item.id || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < earliest) continue;
        const event = { kind:'comment', channel:'facebook', accountId:config.facebook,
          commentId:String(item.id), postId, commenterId:String(item.from?.id || ''),
          username:'', text:String(item.message || '').slice(0, 2000), createdAt };
        if (event.commenterId === config.facebook || !rules.some(rule => matches(rule, event))) continue;
        if (!(await eventRef(event).get()).exists) events.push(event);
      }
    } catch (error) { console.error('[meta-automation] facebook comment poll failed', Number(error.code || 0)); }
  }
  for (let i = 0; i < events.length; i += 50) await enqueue({ kind:'batch', events:events.slice(i, i + 50) });

  const leads = await db().collection(LEADS).where('pending', '==', true).limit(50).get();
  for (const leadDoc of leads.docs) {
    const lead = leadDoc.data();
    if (lead.channel !== 'facebook' || lead.pendingAccountId !== config.facebook) continue;
    if (Date.now() - Date.parse(lead.pendingSince || '') > 24 * 3600000) {
      await leadDoc.ref.set({ pending:false, updatedAt:now() }, { merge:true }); continue;
    }
    try {
      const conversations = await graph(`/${config.facebook}/conversations`, access, {
        fields:'id', query:{ user_id:lead.senderId, limit:1 }
      });
      const conversationId = conversations.data?.[0]?.id;
      if (!conversationId) continue;
      const messages = await graph(`/${encodeURIComponent(conversationId)}/messages`, access, {
        fields:'id,created_time,from,message', query:{ limit:20 }
      });
      const tapped = pendingTap(messages.data, lead);
      if (tapped) await enqueue({ kind:'batch', events:[{ kind:'tap', channel:'facebook',
        accountId:config.facebook, senderId:lead.senderId, payload:buttonPayload(lead.pendingRuleId),
        messageId:tapped.id, at:tapped.created_time }] });
    } catch (error) { console.error('[meta-automation] facebook message poll failed', Number(error.code || 0)); }
  }
  await stateRef.set({ updatedAt:now(), postsChecked:postIds.length, pendingChecked:leads.size }, { merge:true });
}
async function pollMeta() {
  // Uma falha em um canal não deve impedir a verificação do outro.
  const outcomes = await Promise.allSettled([pollInstagram(), pollFacebook()]);
  for (const result of outcomes) if (result.status === 'rejected')
    console.error('[meta-automation] channel poll failed', Number(result.reason?.code || 0));
}
async function webhook(req, res) {
  res.set('Cache-Control', 'no-store');
  const verify = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  const secret = process.env.META_APP_SECRET || '';
  if (!verify || !secret) return res.status(503).send('Not configured');
  if (req.method === 'GET') {
    if (req.query?.['hub.mode'] !== 'subscribe' || !safeEqual(req.query?.['hub.verify_token'], verify)) return res.status(403).send('Forbidden');
    return res.status(200).type('text/plain').send(String(req.query?.['hub.challenge'] || ''));
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const raw = req.rawBody;
  if (!Buffer.isBuffer(raw) || raw.length > 256 * 1024 || !verifySignature(raw, req.get('X-Hub-Signature-256'), secret)) return res.status(403).send('Forbidden');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).send('Invalid JSON'); }
  const events = parseWebhook(body);
  if (!events.length) return res.status(200).send('EVENT_RECEIVED');
  try {
    let timeout;
    await Promise.race([
      enqueue({ kind:'batch', events }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('queue-timeout')), 1500); })
    ]).finally(() => clearTimeout(timeout));
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[meta-automation] queue failure', String(error.code || 'unknown'));
    return res.status(503).send('Retry later');
  }
}
function respond(res, status, body) { return res.set('Cache-Control', 'no-store').status(status).json(body); }
function mediaSummary(item, channel) {
  const entry = item || {};
  const image = channel === 'instagram' ? (entry.thumbnail_url || entry.media_url || '') :
    (entry.full_picture || entry.attachments?.data?.[0]?.media?.image?.src || '');
  return {
    id:String(entry.id || '').slice(0, 100),
    caption:String(channel === 'instagram' ? entry.caption || '' : entry.message || '').slice(0, 350),
    image:/^https:\/\//i.test(image) ? image : '',
    type:channel === 'instagram' ? String(entry.media_type || '') : String(entry.attachments?.data?.[0]?.type || ''),
    permalink:String(channel === 'instagram' ? entry.permalink || '' : entry.permalink_url || ''),
    comments:Number(channel === 'instagram' ? entry.comments_count || 0 : entry.comments?.summary?.total_count || 0),
    likes:Number(channel === 'instagram' ? entry.like_count || 0 : entry.reactions?.summary?.total_count || 0),
    date:String(channel === 'instagram' ? entry.timestamp || '' : entry.created_time || '')
  };
}
async function listMedia(channel, after = '') {
  const config = await accountConfig();
  if (!/^\d{5,30}$/.test(config.facebook) || (channel === 'instagram' && !/^\d{5,30}$/.test(config.instagram)))
    throw new Error('Configure o ID da Página e, para Instagram, o ID da conta em Integrações e APIs.');
  if (after && (!/^[A-Za-z0-9+/_=-]{1,256}$/.test(after))) throw new Error('Cursor inválido.');
  const cursor = after ? `&after=${encodeURIComponent(after)}` : '';
  if (channel === 'instagram') {
    const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,comments_count,like_count,timestamp';
    let data;
    try {
      data = await graph(`/${config.instagram}/media?limit=24&fields=${fields}${cursor}`, await pageToken(config.facebook));
    } catch (error) {
      const igToken = process.env.META_INSTAGRAM_USER_TOKEN;
      if (!igToken) throw error;
      data = await graph(`/${config.instagram}/media?limit=24&fields=${fields}${cursor}`, igToken, { instagramProfile:true });
    }
    return { items:(data.data || []).map(item => mediaSummary(item, channel)).filter(item => item.id),
      nextAfter:data.paging?.next ? String(data.paging?.cursors?.after || '').slice(0, 256) : '' };
  }
  if (channel === 'facebook') {
    const fields = 'id,message,full_picture,permalink_url,created_time,comments.summary(true),reactions.summary(true),attachments{type,media}';
    const data = await graph(`/${config.facebook}/posts?limit=24&fields=${fields}${cursor}`, await pageToken(config.facebook));
    return { items:(data.data || []).map(item => mediaSummary(item, channel)).filter(item => item.id),
      nextAfter:data.paging?.next ? String(data.paging?.cursors?.after || '').slice(0, 256) : '' };
  }
  throw new Error('Canal inválido.');
}
async function admin(req, res) {
  const user = await requireAdmin_(req, res); if (!user) return;
  try {
    const collection = db().collection(RULES);
    if (req.method === 'GET') {
      if (req.query?.action === 'media') {
        const channel = String(req.query?.channel || '');
        if (!['instagram', 'facebook'].includes(channel)) return respond(res, 400, { ok:false, message:'Canal inválido.' });
        const media = await listMedia(channel, String(req.query?.after || ''));
        return respond(res, 200, { ok:true, ...media });
      }
      const [rules, events, config] = await Promise.all([
        collection.limit(100).get(), db().collection(EVENTS).orderBy('updatedAt', 'desc').limit(50).get(), accountConfig()
      ]);
      return respond(res, 200, { ok:true, config,
        rules:rules.docs.filter(doc => !doc.data().deleted).map(doc => ({ id:doc.id, ...doc.data() })),
        errors:events.docs.filter(doc => doc.data().status === 'error').slice(0, 20).map(doc => ({ id:doc.id,
          ruleId:doc.data().ruleId || '', stage:doc.data().errorStage || '', code:Number(doc.data().errorCode || 0),
          message:doc.data().error || '', at:doc.data().updatedAt || '' })) });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!ID.test(id)) return respond(res, 400, { ok:false, message:'ID inválido.' });
      const ref = collection.doc(id); if (!(await ref.get()).exists) return respond(res, 404, { ok:false });
      await ref.set({ active:false, deleted:true, updatedAt:now() }, { merge:true });
      return respond(res, 200, { ok:true });
    }
    if (req.method !== 'POST') return respond(res, 405, { ok:false });
    const input = req.body || {};
    if (input.action === 'test') {
      const event = { channel:String(input.channel || ''), accountId:String(input.accountId || ''),
        postId:String(input.postId || ''), text:String(input.text || '').slice(0, 2000) };
      const rules = await collection.where('active', '==', true).limit(100).get();
      const matched = rules.docs.find(doc => matches({ id:doc.id, ...doc.data() }, event));
      return respond(res, 200, { ok:true, matched:matched ? { id:matched.id, keywords:matched.data().keywords } : null });
    }
    const id = String(input.id || '');
    if (id && !ID.test(id)) return respond(res, 400, { ok:false, message:'ID inválido.' });
    const rule = validRule(input);
    const config = await accountConfig();
    if (rule.accountId !== config[rule.channel]) return respond(res, 400, { ok:false, message:'ID não corresponde à conta Meta configurada.' });
    const ref = id ? collection.doc(id) : collection.doc();
    if (id && !(await ref.get()).exists) return respond(res, 404, { ok:false });
    await ref.set({ ...rule, updatedAt:now(), ...(id ? {} : { createdAt:now(), counts:{ comments:0, directs:0, links:0, newFollowers:0, errors:0 } }) }, { merge:true });
    return respond(res, 200, { ok:true, id:ref.id });
  } catch (error) {
    const message = error instanceof GraphError && error.code === 190 ?
      'Token Meta inválido. Confira META_SYSTEM_USER_TOKEN e META_INSTAGRAM_USER_TOKEN no Secret Manager e reimplante metaAutomations e metaAutomationTask.' :
      String(error.message || 'Falha').slice(0, 180);
    return respond(res, 400, { ok:false, message });
  }
}

module.exports = { webhook, processTask, admin, verifySignature, normalized, validRule, matches,
  parseWebhook, eventsFromWebhook, eventId, classifyGraphError, chooseReply, quickReply, mediaSummary,
  privateReplyMessage, outboundMessageToken, pendingTap, deliveredForPending, pollInstagram, pollFacebook, pollMeta };
