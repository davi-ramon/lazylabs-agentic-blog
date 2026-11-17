'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { verifySignature, normalized, validRule, matches, parseWebhook, classifyGraphError,
  eventId, quickReply, webhook, mediaSummary, outboundMessageToken, pendingTap, deliveredForPending } = require('./meta-automations');
const { privateReplyMessage } = require('./meta-automations');

const base = { channel:'instagram', accountId:'123456789012345', keywords:['Ação', 'guia'],
  postIds:['987654321'], publicReplies:['Te mandei um direct!', 'Confira sua DM 👇'],
  dmText:'Toque para receber o guia', buttonLabel:'Receber guia', link:'https://blog.example.com/guia',
  requireFollow:true, active:true };

test('HMAC exige assinatura do corpo bruto', () => {
  const body = Buffer.from('{"object":"instagram"}');
  const signature = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('alterado'), signature, 'secret'), false);
  assert.equal(verifySignature(body, signature, ''), false);
  assert.equal(verifySignature(body, 'sha256=bad', 'secret'), false);
});

test('palavra-chave ignora acento e emoji, respeita limite e ID do post', () => {
  const rule = validRule(base);
  assert.equal(normalized('AÇÃO 🚀!!'), 'acao');
  assert.equal(matches(rule, { channel:'instagram', accountId:base.accountId, postId:'987654321', text:'Quero a ação!' }), true);
  assert.equal(matches(rule, { channel:'instagram', accountId:base.accountId, postId:'987654321', text:'reação' }), false);
  assert.equal(matches(rule, { channel:'instagram', accountId:base.accountId, postId:'outro', text:'ação' }), false);
  assert.equal(matches({ ...rule, active:false }, { channel:'instagram', accountId:base.accountId, postId:'987654321', text:'ação' }), false);
  assert.equal(quickReply({ ...rule, id:'regra123' })[0].payload, 'AUTO_regra123');
  assert.throws(() => validRule({ ...base, link:'javascript:alert(1)' }));
});

test('webhooks Meta entregam comentários e toques sem eco próprio', () => {
  const ig = parseWebhook({ object:'instagram', entry:[{ id:base.accountId, changes:[
    { field:'comments', value:{ id:'333333333', text:'guia', media:{ id:'987654321' }, from:{ id:'222222222' } } },
    { field:'comments', value:{ id:'444444444', text:'guia', from:{ id:base.accountId } } }
  ], messaging:[{ sender:{ id:'555555555' }, message:{ mid:'mid123', quick_reply:{ payload:'AUTO_regra123' } } }] }] });
  assert.equal(ig.length, 2);
  assert.equal(ig[0].kind, 'comment'); assert.equal(ig[0].postId, '987654321');
  assert.equal(ig[1].kind, 'tap'); assert.equal(ig[1].payload, 'AUTO_regra123');
  assert.equal(eventId(ig[0]), eventId(ig[0]));
  const fb = parseWebhook({ object:'page', entry:[{ id:'234567890123456', changes:[
    { field:'feed', value:{ item:'comment', verb:'add', comment_id:'123_456', post_id:'777_888', message:'Guia' } }
  ] }] });
  assert.equal(fb[0].channel, 'facebook'); assert.equal(fb[0].commentId, '123_456');
});

test('resposta privada oferece texto de retorno se o botão não aparecer', () => {
  const text = privateReplyMessage(base);
  assert.match(text, /responda "Receber guia"/);
  assert.match(text, /Toque para receber o guia/);
  assert.ok(text.length <= 1000);
  assert.match(privateReplyMessage({ ...base, channel:'facebook' }), /aqui no Messenger/);
});

test('webhooks recebem resposta digitada em IG e Facebook e ignoram eco', () => {
  for (const [object, channel] of [['instagram', 'instagram'], ['page', 'facebook']]) {
    const events = parseWebhook({ object, entry:[{ id:base.accountId, messaging:[
      { sender:{ id:'123456789' }, message:{ mid:'reply-1', text:'Receber guia' }, timestamp:1000 },
      { sender:{ id:base.accountId }, message:{ mid:'own', text:'Receber guia', is_echo:true } }
    ] }] });
    assert.equal(events.length, 1);
    assert.deepEqual({ kind:events[0].kind, channel:events[0].channel, text:events[0].text },
      { kind:'message', channel, text:'Receber guia' });
  }
});

test('erros de limite têm retry; erros de permissão são definitivos', () => {
  assert.equal(classifyGraphError({ code:613 }), 'rate');
  assert.equal(classifyGraphError({ code:200 }), 'permission');
  assert.equal(classifyGraphError({ code:1 }), 'other');
});

test('mensagem privada do Instagram usa token de usuário do sistema', async () => {
  const previous = process.env.META_SYSTEM_USER_TOKEN;
  process.env.META_SYSTEM_USER_TOKEN = 'system-test';
  try { assert.equal(await outboundMessageToken('instagram', '12345'), 'system-test'); }
  finally {
    if (previous === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
    else process.env.META_SYSTEM_USER_TOKEN = previous;
  }
});

test('sondagem reconhece somente o botão do lead pendente após o Direct', () => {
  const lead = { pending:true, senderId:'345678901234567', pendingRuleId:'regra123',
    pendingButtonLabel:'Receber link', pendingSince:'2026-11-01T16:44:02Z', lastTapMessageId:'' };
  const messages = [
    { id:'outro', from:{ id:'111' }, message:'Receber link', created_time:'2026-11-01T16:47:26Z' },
    { id:'antes', from:{ id:lead.senderId }, message:'Receber link', created_time:'2026-11-01T16:40:00Z' },
    { id:'toque', from:{ id:lead.senderId }, message:'Receber link', created_time:'2026-11-01T16:47:26Z' }
  ];
  assert.equal(pendingTap(messages, lead).id, 'toque');
  assert.equal(pendingTap(messages, { ...lead, lastTapMessageId:'toque' }), null);
  assert.equal(pendingTap(messages, { ...lead, pending:false }), null);
});

test('link antigo não bloqueia um novo comentário da mesma pessoa', () => {
  const lead = { pendingSince:'2026-11-01T17:38:20Z', linkSent:{ regra123:'2026-11-01T17:27:08Z' } };
  assert.equal(deliveredForPending(lead, 'regra123'), false);
  assert.equal(deliveredForPending({ ...lead, linkSent:{ regra123:'2026-11-01T17:39:00Z' } }, 'regra123'), true);
  assert.equal(deliveredForPending({ ...lead, linkSent:{}, 'linkSent.regra123':'2026-11-01T17:39:00Z' }, 'regra123'), true);
});

test('layout visual é salvo sem alterar o fluxo; mídia não expõe credenciais', () => {
  const order = [1,3,2,4,5,6];
  assert.deepEqual(validRule({ ...base, nodeOrder:order }).nodeOrder, order);
  assert.deepEqual(validRule({ ...base, nodeOrder:[1,1,2,3,4,5] }).nodeOrder, [1,2,3,4,5,6]);
  const layout = { orientation:'horizontal', positions:{ 1:{ x:135.4, y:98.6 }, 2:{ x:520, y:99 } } };
  const arranged = validRule({ ...base, visualLayout:layout });
  assert.deepEqual(arranged.visualLayout, { orientation:'horizontal', positions:{ 1:{ x:135, y:99 }, 2:{ x:520, y:99 } } });
  assert.equal(matches(arranged, { channel:'instagram', accountId:base.accountId, postId:'987654321', text:'Guia' }), true);
  assert.deepEqual(validRule({ ...base, visualLayout:{ positions:{ 1:{ x:-2, y:0 } } } }).visualLayout.positions[1], { x:-2, y:0 });
  const withoutFollow = validRule({ ...base, visualLayout:{ conditionEnabled:false }, requireFollow:true });
  assert.equal(withoutFollow.visualLayout.conditionEnabled, false);
  assert.equal(withoutFollow.requireFollow, false);
  const facebook = validRule({ ...base, channel:'facebook', visualLayout:{ conditionEnabled:true }, requireFollow:true });
  assert.equal(facebook.requireFollow, false);
  assert.equal(facebook.visualLayout.conditionEnabled, undefined);
  assert.throws(() => validRule({ ...base, visualLayout:{ positions:{ 1:{ x:-200000, y:0 } } } }), /Posição/);
  assert.throws(() => validRule({ ...base, visualLayout:{ positions:{ 1:{ x:'NaN', y:0 } } } }), /Posição/);
  const media = mediaSummary({ id:'178_22', caption:'Um Reel', thumbnail_url:'https://cdn.example.com/a.jpg',
    comments_count:8, like_count:3, access_token:'segredo' }, 'instagram');
  assert.equal(media.image, 'https://cdn.example.com/a.jpg');
  assert.equal(media.comments, 8);
  assert.equal('access_token' in media, false);
});

test('webhook valida desafio e recusa POST com assinatura inválida', async () => {
  const previous = { verify:process.env.META_WEBHOOK_VERIFY_TOKEN, secret:process.env.META_APP_SECRET };
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-test'; process.env.META_APP_SECRET = 'secret-test';
  const response = () => ({ code:0, set() { return this; }, status(code) { this.code=code; return this; },
    type() { return this; }, send(value) { this.body=value; return this; } });
  try {
    const get = response();
    await webhook({ method:'GET', query:{ 'hub.mode':'subscribe', 'hub.verify_token':'verify-test', 'hub.challenge':'12345' } }, get);
    assert.equal(get.code, 200); assert.equal(get.body, '12345');
    const bad = response();
    await webhook({ method:'POST', rawBody:Buffer.from('{}'), get() { return 'sha256=wrong'; } }, bad);
    assert.equal(bad.code, 403);
  } finally {
    if (previous.verify === undefined) delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    else process.env.META_WEBHOOK_VERIFY_TOKEN = previous.verify;
    if (previous.secret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previous.secret;
  }
});
