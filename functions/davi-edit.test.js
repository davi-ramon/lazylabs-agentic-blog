'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
let fakeOpenaiKey = '';
let fakeImageProvider = 'openai';
let fakeCloudflareAccount = '';
let fakeCloudflareToken = '';
let savedImage;
Module._load = function (name, parent, isMain) {
  if (name === 'firebase-admin/firestore') return { getFirestore: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({
    provider: 'deepseek', model: 'deepseek-chat', deepseek_key: 'server-only-key',
    openai_key: fakeOpenaiKey,
    image_provider: fakeImageProvider,
    cloudflare_account_id: fakeCloudflareAccount,
    cloudflare_api_token: fakeCloudflareToken,
    gpt: { instructions: 'Escreva em primeira pessoa, com frases curtas.' }
  }) }) }) }) };
  if (name === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => ({ file: name => ({
    save: async (bytes, options) => { savedImage = { name, bytes, options }; }
  }) }) }) };
  if (name === './admin' && parent && parent.filename.endsWith('davi.js')) return { requireAdmin_: async () => ({ uid: 'owner' }) };
  return originalLoad(name, parent, isMain);
};
const { handler } = require('./davi');
Module._load = originalLoad;

function response() {
  return { statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('configuração pública do admin não devolve chaves de texto ou imagens', async () => {
  fakeOpenaiKey = 'server-image-key';
  fakeCloudflareToken = 'server-cloudflare-token';
  try {
    const res = response();
    await handler({ method:'GET', path:'/api/davi/config', headers:{} }, res);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /server-image-key|server-only-key|server-cloudflare-token/);
    assert.equal(JSON.parse(res.body).config.cloudflare_api_token_set, true);
  } finally { fakeOpenaiKey = ''; fakeCloudflareToken = ''; }
});

test('editor revisa via modelo DeepSeek atual e preserva a imagem', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<p>Olá, mundo.</p>[[MEDIA_1]]' } }]
    }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'proofread', html: '<p>Ola mundu</p><img src="/foto.png">'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.body.thinking.type, 'disabled');
    assert.doesNotMatch(request.body.messages[0].content, /primeira pessoa/);
    assert.match(JSON.parse(res.body).html, /<img src="\/foto.png">/);
  } finally { global.fetch = originalFetch; }
});

test('reescrita incorpora o estilo salvo do autor', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<p>Eu construí o projeto.</p>' } }]
    }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'rewrite', html: '<p>Projeto construido</p>'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(request.messages[0].content, /primeira pessoa/);
  } finally { global.fetch = originalFetch; }
});

test('reescrita de seleção parcial usa estilo do autor e devolve só conteúdo inline', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<p>Eu <strong>automatizei</strong> a API.</p>' } }]
    }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'rewrite', scope: 'selection', inline: true, contextTag: 'p', html: 'eu automatizei a api'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(request.messages[0].content, /primeira pessoa/);
    assert.match(request.messages[0].content, /conteúdo HTML inline/);
    assert.equal(JSON.parse(res.body).html, 'Eu <strong>automatizei</strong> a API.');
  } finally { global.fetch = originalFetch; }
});

test('revisão de seleção completa preserva título e não recebe instruções de reescrita', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<h2>Recursos técnicos</h2>' } }]
    }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'proofread', scope: 'selection', contextTag: 'h2', html: '<h2>Recursos tecnico</h2>'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(request.messages[0].content, /norma culta/);
    assert.doesNotMatch(request.messages[0].content, /primeira pessoa/);
    assert.equal(JSON.parse(res.body).html, '<h2>Recursos técnicos</h2>');
  } finally { global.fetch = originalFetch; }
});

test('falha na reescrita não devolve a chave no erro do provedor', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({
    error: { message: 'Incorrect API key provided: server-only-key' }
  }) });
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'rewrite', html: '<p>Texto de teste para reescrita.</p>'
    } }, res);
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(res.body, /server-only-key/);
  } finally { global.fetch = originalFetch; }
});

test('reescrita de transcrição com mais de 20 mil caracteres usa partes menores', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content = body.messages[1].content.split(' em HTML. Não acrescente introdução nem conclusão artificial:\n')[1];
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/edit', headers: {}, body: {
      mode: 'rewrite', html: '<p>' + 'Descrevo um projeto de automação e seus fluxos. '.repeat(470) + '</p>'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(requests.length >= 5);
    assert.ok(requests.every(request => request.messages[1].content.length < 4000));
    assert.match(JSON.parse(res.body).html, /Descrevo um projeto/);
  } finally { global.fetch = originalFetch; }
});

test('gerador de diagrama usa DeepSeek e devolve apenas visual seguro', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ title: 'Fluxo de dados', nodes: [
        { label: 'Cliente', detail: 'Envia evento' }, { label: '<img src=x>', detail: 'Consulta o banco' }
      ] })
    } }] }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/diagram', headers: {}, body: {
      selected: 'O cliente envia um evento ao servidor. O servidor consulta o banco de dados e responde ao cliente.',
      layout: 'flow', theme: 'mono', motion: 'pulse'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(request.body.response_format.type, 'json_object');
    assert.doesNotMatch(JSON.parse(res.body).html, /<img src=x>/);
    assert.match(JSON.parse(res.body).html, /diagram-mono/);
  } finally { global.fetch = originalFetch; }
});

test('metadados sugeridos são estruturados e o conteúdo não sobrescreve os campos automaticamente', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '{"title":"Meu projeto de IA","excerpt":"Como criei um blog de IA.","tags":["IA","Blog"],"category":"Agentes de IA","seo_title":"Blog de IA com automação","seo_description":"Veja como criei um blog com IA e automação."}' } }]
  }) });
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/metadata', headers: {}, body: {
      html: '<p>' + 'Construí um blog com automação e agentes de inteligência artificial. '.repeat(3) + '</p>'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).tags, ['IA','Blog']);
    assert.equal(JSON.parse(res.body).title, 'Meu projeto de IA');
    assert.equal(JSON.parse(res.body).category, 'Agentes de IA');
    assert.equal(JSON.parse(res.body).seoTitle, 'Blog de IA com automação');
    assert.equal(JSON.parse(res.body).seoDescription, 'Veja como criei um blog com IA e automação.');
  } finally { global.fetch = originalFetch; }
});

test('metadados podem criar categoria nova e reutilizar tipo Tutorial', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        title: 'Edição de vídeo com IA', excerpt: 'Como montar um editor usando três repositórios.',
        tags: ['Edição de vídeo', 'Claude Code', 'Edição de vídeo'], category: 'Edição de Vídeo',
        post_type: 'Tutorial', seo_title: 'Editor de vídeo com IA', seo_description: 'Passo a passo para criar um editor.'
      }) } }]
    }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/metadata', headers: {}, body: {
      html: '<p>' + 'Instale três repositórios no Claude Code para editar vídeo profissionalmente. '.repeat(3) + '</p>', mode: 'basic'
    } }, res);
    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.category, 'Edição de Vídeo');
    assert.equal(result.postType, 'tutorial');
    assert.equal(result.postTypeLabel, 'Tutorial');
    assert.deepEqual(result.tags, ['Edição de vídeo', 'Claude Code']);
    assert.match(request.messages[0].content, /Categorias existentes/);
    assert.match(request.messages[0].content, /Tipos de post existentes/);
  } finally { global.fetch = originalFetch; }
});

test('metadados completos repetem com amostra menor se o modelo cortar a resposta e extraem detalhes', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const content = JSON.stringify({ title:'CRM com IA', excerpt:'Como construí um CRM com IA.', tags:['CRM','IA'], category:'CRM & Automacao', seo_title:'CRM com IA', seo_description:'Veja o CRM com IA.', project:{ problem:'Gestão manual', solution:'CRM', technologies:'Apps Script', result:'', client:'', internal_notes:'Confirmar números' } });
    return { ok:true, text:async () => JSON.stringify({ choices:[{ finish_reason:requests.length === 1 ? 'length' : 'stop', message:{ content } }] }) };
  };
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/metadata', headers:{}, body:{ mode:'all', html:'Artigo sobre CRM e Apps Script. '.repeat(900) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].response_format.type, 'json_object');
    assert.equal(requests[0].max_tokens, 3000);
    assert.equal(requests[1].max_tokens, 4000);
    assert.ok(requests[1].messages[1].content.length < requests[0].messages[1].content.length);
    assert.equal(JSON.parse(res.body).project.technologies, 'Apps Script');
    assert.equal(JSON.parse(res.body).project.result, '');
  } finally { global.fetch = originalFetch; }
});

test('detalhes de projeto aceitam campos vazios quando o artigo não os informa', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok:true, text:async () => JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content:JSON.stringify({ project:{ problem:'', solution:'CRM de vendas', technologies:'Google Sheets', result:'', client:'', internal_notes:'' } }) } }] }) });
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/metadata', headers:{}, body:{ mode:'project', html:'Construí um CRM de vendas usando o Google Sheets. '.repeat(4) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).project.solution, 'CRM de vendas');
    assert.equal(JSON.parse(res.body).project.result, '');
  } finally { global.fetch = originalFetch; }
});

test('capa com IA informa que precisa da chave de API sem cobrar uma geração', async () => {
  const originalFetch = global.fetch;
  let invoked = false;
  global.fetch = async () => { invoked = true; throw new Error('A API não deveria ser chamada.'); };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/image', headers: {}, body: {
      article: 'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4)
    } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).message, /Configure uma chave da API da OpenAI/);
    assert.equal(invoked, false);
  } finally { global.fetch = originalFetch; }
});

test('capa com IA usa a chave do servidor e salva PNG no blog', async () => {
  const originalFetch = global.fetch;
  fakeOpenaiKey = 'server-image-key';
  savedImage = null;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)]);
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
  };
  try {
    const res = response();
    await handler({ method: 'POST', path: '/api/davi/image', headers: {}, body: {
      title: 'Automação de blogs', article: 'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4)
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(request.options.headers.Authorization, 'Bearer server-image-key');
    assert.equal(JSON.parse(request.options.body).model, 'gpt-image-2');
    assert.match(savedImage.name, /^blog-content\/[0-9a-f-]+\.png$/);
    assert.equal(savedImage.options.contentType, 'image/png');
    assert.match(JSON.parse(res.body).url, /^https:\/\/blog\.example\.com\/media\/blog-content\//);
  } finally { global.fetch = originalFetch; fakeOpenaiKey = ''; }
});

test('Cloudflare Workers AI salva JPEG sem usar a chave de texto ou OpenAI', async () => {
  const originalFetch = global.fetch;
  fakeImageProvider = 'cloudflare';
  fakeCloudflareAccount = 'a'.repeat(32);
  fakeCloudflareToken = 'server-cloudflare-token';
  savedImage = null;
  const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(30)]);
  let request;
  global.fetch = async (url, options) => { request = { url, options }; return { ok:true, status:200, json:async () => ({ success:true, result:{ image:jpeg.toString('base64') } }) }; };
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/image', headers:{}, body:{ title:'CRM', variant:2, article:'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4) } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(request.url, /api.cloudflare.com\/client\/v4\/accounts\/a{32}\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell/);
    assert.equal(request.options.headers.Authorization, 'Bearer server-cloudflare-token');
    assert.match(JSON.parse(request.options.body).prompt, /Composição isométrica/);
    assert.deepEqual(Object.keys(JSON.parse(request.options.body)).sort(), ['prompt', 'steps']);
    assert.equal(savedImage.options.contentType, 'image/jpeg');
    assert.match(JSON.parse(res.body).url, /\.jpg$/);
  } finally { global.fetch = originalFetch; fakeImageProvider = 'openai'; fakeCloudflareAccount = ''; fakeCloudflareToken = ''; }
});

test('direção visual longa chega inteira ao FLUX sem ultrapassar o limite do modelo', async () => {
  const originalFetch = global.fetch;
  fakeImageProvider = 'cloudflare';
  fakeCloudflareAccount = 'a'.repeat(32);
  fakeCloudflareToken = 'server-cloudflare-token';
  const ending = ' FIM DA DIREÇÃO';
  const direction = 'A'.repeat(2000 - ending.length) + ending;
  const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(30)]);
  let sentPrompt;
  global.fetch = async (_url, options) => {
    sentPrompt = JSON.parse(options.body).prompt;
    return { ok:true, status:200, json:async () => ({ success:true, result:{ image:jpeg.toString('base64') } }) };
  };
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/image', headers:{}, body:{ title:'Teste de capa', variant:2, article:'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4), prompt:direction } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(sentPrompt.includes(direction));
    assert.doesNotMatch(sentPrompt, /Composição isométrica/);
    assert.ok(sentPrompt.length <= 2048);
  } finally { global.fetch = originalFetch; fakeImageProvider = 'openai'; fakeCloudflareAccount = ''; fakeCloudflareToken = ''; }
});

test('erro HTTP 400 da Cloudflare informa o código sem expor o token', async () => {
  const originalFetch = global.fetch;
  fakeImageProvider = 'cloudflare';
  fakeCloudflareAccount = 'a'.repeat(32);
  fakeCloudflareToken = 'server-cloudflare-token';
  global.fetch = async () => ({ ok:false, status:400, json:async () => ({ success:false, errors:[{ code:5004, message:'server-cloudflare-token' }] }) });
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/image', headers:{}, body:{ article:'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4) } }, res);
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).message, /código 5004/);
    assert.doesNotMatch(res.body, /server-cloudflare-token/);
  } finally { global.fetch = originalFetch; fakeImageProvider = 'openai'; fakeCloudflareAccount = ''; fakeCloudflareToken = ''; }
});

test('falha de autenticação na API de imagens não ecoa a chave', async () => {
  const originalFetch = global.fetch;
  fakeOpenaiKey = 'server-image-key';
  global.fetch = async () => ({ ok:false, status:401, json:async () => ({ error:{ message:'Incorrect API key provided: server-image-key' } }) });
  try {
    const res = response();
    await handler({ method:'POST', path:'/api/davi/image', headers:{}, body:{ article:'Artigo sobre automação de processos e agentes inteligentes. '.repeat(4) } }, res);
    assert.equal(res.statusCode, 502);
    assert.doesNotMatch(res.body, /server-image-key/);
    assert.match(res.body, /chave OpenAI/);
  } finally { global.fetch = originalFetch; fakeOpenaiKey = ''; }
});
