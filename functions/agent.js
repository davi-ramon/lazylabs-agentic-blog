/**
 * Lazy Labs — Davi Blogger Agent (chat com tools/ações).
 *
 * Endpoint: POST /api/agent
 *   body: { message, history, provider, model, apiKey }
 *
 * Carrega config/davi (identidade + system prompt + capabilities + actions) do Firestore,
 * monta system prompt completo, e faz tool-calling loop com o provider LLM.
 * Cada tool invoca uma rota real do ecossistema (Supabase / Firebase / LinkedIn / WhatsApp).
 *
 * Auth: Firebase ID token verificado por requireAdmin_.
 */

const { getFirestore } = require('firebase-admin/firestore');
const { activeModel } = require('./deepseek-model');
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
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
}

function readBody_(req) {
  try {
    return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {});
  } catch (e) { return {}; }
}

// Alguns modelos "thinking" (ex: deepseek-r1, qwen3 via Groq) devolvem o raciocinio
// dentro de <think>...</think> junto no content. O usuario so quer a resposta final.
function stripThink_(s) {
  var t = String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  var openIdx = t.search(/<think>/i);
  if (openIdx !== -1) t = t.slice(0, openIdx);
  return t.trim();
}

/* ───── Tools ────────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'listar_posts',
    description: 'Lista artigos do blog (Supabase posts). Retorna ate 20 posts com id, title, slug, status, category, published_at.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'published', 'scheduled', 'archived'], description: 'Filtrar por status (opcional).' } }, required: [] }
  },
  {
    name: 'obter_post',
    description: 'Retorna dados completos de um artigo por slug.',
    parameters: { type: 'object', properties: { slug: { type: 'string', description: 'Slug do artigo.' } }, required: ['slug'] }
  },
  {
    name: 'criar_rascunho',
    description: 'Cria um rascunho de artigo. Persiste no Supabase via Firebase Function /api/posts/publish. Retorna o slug e URL.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titulo do artigo.' },
        slug: { type: 'string', description: 'Slug (kebab-case, sem espacos).' },
        excerpt: { type: 'string', description: 'Resumo curto.' },
        content_html: { type: 'string', description: 'Conteudo em HTML.' },
        category: { type: 'string', description: 'Categoria (ex: Agentes de IA, CRM & Automacao, etc).' },
        tags: { type: 'string', description: 'Tags separadas por virgula.' }
      },
      required: ['title', 'slug', 'content_html']
    }
  },
  {
    name: 'atualizar_status_post',
    description: 'Altera o status de um artigo (rascunho, publicado, agendado, arquivado).',
    parameters: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Slug do artigo.' }, status: { type: 'string', enum: ['draft', 'published', 'scheduled', 'archived'] } },
      required: ['slug', 'status']
    }
  },
  {
    name: 'publicar_agora',
    description: 'Publica um rascunho imediatamente (mesma rota de publish, com status=published).',
    parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] }
  },
  {
    name: 'listar_inscritos_newsletter',
    description: 'Lista os primeiros 50 inscritos da newsletter (status=confirmed).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'disparar_whatsapp',
    description: 'Dispara um template WhatsApp configurado para os leads do CRM. Requer config/whatsapp salvo.',
    parameters: {
      type: 'object',
      properties: {
        post_slug: { type: 'string', description: 'Slug do artigo.' },
        post_title: { type: 'string', description: 'Titulo do artigo.' }
      },
      required: ['post_slug', 'post_title']
    }
  },
  {
    name: 'transcrever_audio',
    description: 'Transcreve audio (base64 de webm/ogg) usando Groq Whisper. Retorna o texto.',
    parameters: {
      type: 'object',
      properties: { base64: { type: 'string' }, mime_type: { type: 'string' } },
      required: ['base64']
    }
  },
  {
    name: 'listar_leads_crm',
    description: 'Lista os primeiros 50 leads do CRM (Firestore crm_leads).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'criar_lead_crm',
    description: 'Cria um novo lead no CRM. Campos: nome, telefone, email, empresa.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        telefone: { type: 'string' },
        email: { type: 'string' },
        empresa: { type: 'string' }
      },
      required: ['nome']
    }
  }
];

/* Metadados de auditoria (NAO fazem parte do schema mandado pra LLM — so pra UI
   de "ver detalhes" no admin). Ficam separados de TOOLS de proposito: TOOLS vai
   direto pro provider (openai/groq/deepseek/custom) como function schema, e
   campos extras aqui poderiam confundir alguns providers. */
const TOOL_AUDIT_INFO = {
  listar_posts: {
    backend: 'Firestore — coleção posts, doc id = slug (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: { status: 'draft' },
    example_output: { ok: true, posts: [{ id: 'blog-automatizado-ia-lazy-labs', title: 'Como criei um blog com IA', slug: 'blog-automatizado-ia-lazy-labs', status: 'published', category: 'Agentes de IA', published_at: '2026-06-01T12:00:00.000Z', created_at: '2026-05-28T09:00:00.000Z', featured: false }] }
  },
  obter_post: {
    backend: 'Firestore — posts/<slug> (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: { slug: 'blog-automatizado-ia-lazy-labs' },
    example_output: { ok: true, post: { id: 'blog-automatizado-ia-lazy-labs', title: 'Como criei um blog com IA', slug: 'blog-automatizado-ia-lazy-labs', excerpt: 'Um diario honesto de...', content: '<p>...</p>', category: 'Agentes de IA', tags: ['Blog com IA', 'Automacao'], status: 'published', cover_url: 'https://...', reading_time: 6 } }
  },
  criar_rascunho: {
    backend: 'Firestore — posts/<slug>.set(merge:true) (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: { title: 'Como automatizei o pos-venda', slug: 'como-automatizei-o-pos-venda', excerpt: 'Um resumo curto do artigo.', content_html: '<p>Conteudo completo em HTML...</p>', category: 'Agentes de IA', tags: 'automacao, pos-venda' },
    example_output: { ok: true, slug: 'como-automatizei-o-pos-venda', url: 'https://blog.example.com/artigo/como-automatizei-o-pos-venda', post: { status: 'draft' } }
  },
  atualizar_status_post: {
    backend: 'Firestore — posts/<slug>.set(merge:true) (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: { slug: 'como-automatizei-o-pos-venda', status: 'published' },
    example_output: { ok: true, slug: 'como-automatizei-o-pos-venda', status: 'published' }
  },
  publicar_agora: {
    backend: 'Firestore — posts/<slug>.set(merge:true, status=published) — mesmo caminho de criar_rascunho',
    headers: {},
    example_input: { slug: 'como-automatizei-o-pos-venda' },
    example_output: { ok: true, slug: 'como-automatizei-o-pos-venda', url: 'https://blog.example.com/artigo/como-automatizei-o-pos-venda', post: { status: 'published' } }
  },
  listar_inscritos_newsletter: {
    backend: 'Firestore — coleção newsletter_subscribers, filtro status=active (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: {},
    example_output: { ok: true, count: 2, subscribers: [{ email: 'lead@empresa.com', first_name: 'Joao', last_name: 'Silva', source: 'blog_artigo-x', subscribed_at: '2026-06-10T10:00:00.000Z' }] }
  },
  disparar_whatsapp: {
    backend: 'HTTP — POST https://southamerica-east1-your-firebase-project.cloudfunctions.net/whatsapp/send (Function whatsapp, WhatsApp Cloud API)',
    headers: { 'Content-Type': 'application/json' },
    example_input: { post_slug: 'como-automatizei-o-pos-venda', post_title: 'Como automatizei o pos-venda' },
    example_output: { ok: true, sent: 12, failed: 0 }
  },
  transcrever_audio: {
    backend: 'HTTP — POST https://southamerica-east1-your-firebase-project.cloudfunctions.net/transcribe (Function transcribe, Groq Whisper)',
    headers: { 'Content-Type': 'application/json' },
    example_input: { base64: '<audio codificado em base64, sem o prefixo data:...>', mime_type: 'audio/webm' },
    example_output: { ok: true, transcript: 'Texto transcrito do audio aqui.' }
  },
  listar_leads_crm: {
    backend: 'Firestore — leitura direta da colecao crm_leads, limit 50 (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: {},
    example_output: { ok: true, count: 1, leads: [{ id: 'd5e6...', nome: 'Joao Silva', telefone: '5511999998888', email: 'joao@empresa.com', empresa: 'Empresa X', status: 'Novo', temperatura: 'Morno', fonte: 'Davi Blogger', criadoEm: '2026-07-20T14:00:00.000Z' }] }
  },
  criar_lead_crm: {
    backend: 'Firestore — cria doc na colecao crm_leads (Admin SDK, server-side, sem HTTP)',
    headers: {},
    example_input: { nome: 'Joao Silva', telefone: '5511999998888', email: 'joao@empresa.com', empresa: 'Empresa X' },
    example_output: { ok: true, id: 'd5e6...', lead: { nome: 'Joao Silva', telefone: '5511999998888', email: 'joao@empresa.com', empresa: 'Empresa X', status: 'Novo', temperatura: 'Morno', fonte: 'Davi Blogger', criadoEm: '2026-07-29T08:00:00.000Z' } }
  }
};

function buildToolsAudit_() {
  return TOOLS.map(function (t) {
    var extra = TOOL_AUDIT_INFO[t.name] || {};
    return {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      backend: extra.backend || '',
      headers: extra.headers || {},
      example_input: extra.example_input || {},
      example_output: extra.example_output || {}
    };
  });
}

async function executeTool_(name, args, ctx) {
  switch (name) {
    case 'listar_posts': {
      let q = db().collection('posts');
      if (args.status) q = q.where('status', '==', args.status);
      const snap = await q.orderBy('created_at', 'desc').limit(20)
        .select('title', 'slug', 'status', 'category', 'published_at', 'created_at', 'featured').get();
      const posts = []; snap.forEach(function (d) { posts.push(Object.assign({ id: d.id }, d.data())); });
      return { ok: true, posts: posts };
    }
    case 'obter_post': {
      const snap = await db().doc('posts/' + args.slug).get();
      if (!snap.exists) return { ok: true, post: null };
      return { ok: true, post: Object.assign({ id: snap.id }, snap.data()) };
    }
    case 'criar_rascunho':
    case 'publicar_agora': {
      const isPublish = name === 'publicar_agora';
      const slug = String(args.slug || args.post_slug || '').slice(0, 200);
      if (!slug) return { ok: false, message: 'slug obrigatorio.' };
      const ref = db().doc('posts/' + slug);
      const existingSnap = await ref.get();
      const existing = existingSnap.exists ? existingSnap.data() : null;
      const tags = String(args.tags || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const row = {
        title: String(args.title || args.post_title || (existing && existing.title) || '').slice(0, 300),
        slug: slug,
        excerpt: String(args.excerpt || ''),
        content: String(args.content_html || args.content || (existing && existing.content) || ''),
        category: String(args.category || (existing && existing.category) || 'Agentes de IA'),
        tags: tags.length ? tags : (existing && existing.tags) || [],
        status: isPublish ? 'published' : 'draft',
        blog_id: (existing && existing.blog_id) || 'your-blog',
        author_name: (existing && existing.author_name) || 'Davi Blogger',
        reading_time: (existing && existing.reading_time) || 5,
        cover_url: (existing && existing.cover_url) || '',
        view_count: (existing && existing.view_count) || 0,
        like_count: (existing && existing.like_count) || 0,
        created_at: (existing && existing.created_at) || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        published_at: isPublish ? new Date().toISOString() : ((existing && existing.published_at) || null)
      };
      if (!row.title) return { ok: false, message: 'title obrigatorio.' };
      await ref.set(row, { merge: true });
      return { ok: true, post: row, slug: slug, url: 'https://blog.example.com/artigo/' + slug };
    }
    case 'atualizar_status_post': {
      const slug = String(args.slug || args.id || '').trim();
      if (!slug) return { ok: false, message: 'slug obrigatorio.' };
      const patch = { status: args.status, updated_at: new Date().toISOString() };
      if (args.status === 'published') patch.published_at = new Date().toISOString();
      await db().doc('posts/' + slug).set(patch, { merge: true });
      return { ok: true, slug: slug, status: args.status };
    }
    case 'listar_inscritos_newsletter': {
      const snap = await db().collection('newsletter_subscribers').where('status', '==', 'active')
        .orderBy('subscribed_at', 'desc').limit(50).get();
      const subs = []; snap.forEach(function (d) { subs.push(d.data()); });
      return { ok: true, count: subs.length, subscribers: subs };
    }
    case 'disparar_whatsapp': {
      const r = await fetch('https://southamerica-east1-your-firebase-project.cloudfunctions.net/whatsapp/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postSlug: args.post_slug, postTitle: args.post_title, postUrl: 'https://blog.example.com/artigo/' + args.post_slug })
      });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, message: 'WhatsApp ' + r.status + ' ' + t.slice(0, 200) };
      }
      const d = await r.json();
      return d;
    }
    case 'transcrever_audio': {
      const r = await fetch('https://southamerica-east1-your-firebase-project.cloudfunctions.net/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: args.base64, mimeType: args.mime_type || 'audio/webm' })
      });
      const d = await r.json();
      return d;
    }
    case 'listar_leads_crm': {
      const snap = await db().collection('crm_leads').limit(50).get();
      const leads = [];
      snap.forEach(function (d) { leads.push(Object.assign({ id: d.id }, d.data())); });
      return { ok: true, count: leads.length, leads: leads };
    }
    case 'criar_lead_crm': {
      const ref = db().collection('crm_leads').doc();
      const doc = {
        nome: String(args.nome || '').slice(0, 160),
        telefone: String(args.telefone || ''),
        email: String(args.email || ''),
        empresa: String(args.empresa || ''),
        status: 'Novo', temperatura: 'Morno', fonte: 'Davi Blogger',
        criadoEm: new Date().toISOString()
      };
      await ref.set(doc);
      return { ok: true, id: ref.id, lead: doc };
    }
    default:
      return { ok: false, message: 'Tool desconhecida: ' + name };
  }
}

/* ───── Tool calling (loop) ────────────────────────────────────────────────────── */

const PROVIDERS_CFG = {
  openai:    { base: 'https://api.openai.com/v1',                        defaultModel: 'gpt-4o-mini',          style: 'openai' },
  groq:      { base: 'https://api.groq.com/openai/v1',                  defaultModel: 'llama-3.3-70b-versatile', style: 'openai' },
  deepseek:  { base: 'https://api.deepseek.com/v1',                     defaultModel: 'deepseek-flash',        style: 'openai' },
  anthropic: { base: 'https://api.anthropic.com/v1',                    defaultModel: 'claude-sonnet-4-5',     style: 'anthropic' },
  gemini:    { base: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash',      style: 'gemini' },
  custom:    { base: '__CUSTOM__',                                     defaultModel: '',                       style: 'openai' }
};

async function callLLMForToolLoop_(provider, model, apiKey, messages, tools, customCfg, timeoutMs) {
  const cfg = PROVIDERS_CFG[provider];
  if (!cfg) return { ok: false, message: 'Provider nao suportado: ' + provider };

  // Provider custom: usa base/model do Firestore (config/davi.custom_provider).
  var base = cfg.base;
  var mdl = activeModel(provider, model || cfg.defaultModel);
  if (provider === 'custom' && customCfg) {
    base = (customCfg.base_url || customCfg.base || '').replace(/\/+$/, '');
    mdl = model || customCfg.model || cfg.defaultModel;
    if (!base) return { ok: false, message: 'Custom: base_url nao configurada. Defina em Config API.' };
    // Auto-normalizar: se a base NAO termina com '/v1' (ou similar), adiciona '/v1'
    // (padrao OpenAI-compat: a maioria dos gateways expoe /v1/models e /v1/chat/completions).
    if (base && !/\/v\d+([\/?#].*)?$/.test(base)) base = base + '/v1';
  }

  // Anthropic Messages API
  if (cfg.style === 'anthropic') {
    const sysMsg = messages.find(function (m) { return m.role === 'system'; });
    const turns = messages.filter(function (m) { return m.role !== 'system'; });
    const r = await fetch(base + '/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: mdl, max_tokens: 4000, system: sysMsg ? sysMsg.content : undefined, messages: turns })
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (_) {}
    if (!r.ok) return { ok: false, message: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
    // Anthropic nao suporta tool calling via Messages (ate o momento). Devolve texto puro.
    const text = j && j.content && j.content[0] && j.content[0].text ? j.content[0].text : '';
    return { ok: true, anthropic: true, body: { choices: [{ message: { role: 'assistant', content: text } }] } };
  }

  // Gemini generateContent
  if (cfg.style === 'gemini') {
    var sysPart = null;
    var turns = [];
    var lastRole = null, buf = '';
    messages.forEach(function (m) {
      if (m.role === 'system') { sysPart = { role: 'system', parts: [{ text: m.content }] }; return; }
      var role = m.role === 'assistant' ? 'model' : 'user';
      if (lastRole && lastRole === role) { buf += '\n' + m.content; turns[turns.length - 1].parts[0].text = buf; }
      else { turns.push({ role: role, parts: [{ text: m.content }] }); buf = m.content; lastRole = role; }
    });
    var contents = sysPart ? [sysPart].concat(turns) : turns;
    var url = base + '/models/' + mdl + ':generateContent?key=' + encodeURIComponent(apiKey);
    var r2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: contents }) });
    var t2 = await r2.text();
    var j2 = null; try { j2 = JSON.parse(t2); } catch (_) {}
    if (!r2.ok) return { ok: false, message: (j2 && j2.error && j2.error.message) || ('HTTP ' + r2.status) };
    var cand = j2 && j2.candidates && j2.candidates[0];
    var text = cand && cand.content && cand.content.parts && cand.content.parts.map(function (p) { return p.text; }).join('\n') || '';
    return { ok: true, gemini: true, body: { choices: [{ message: { role: 'assistant', content: text } }] } };
  }

  // OpenAI-compatible (openai, groq, deepseek, custom)
  var ocUrl = base + '/chat/completions';
  var ocR = await fetch(ocUrl, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs || 100000),
    body: JSON.stringify(Object.assign({ model: mdl, messages: messages, tools: tools.map(function (tt) { return { type: 'function', function: tt }; }), tool_choice: 'auto', temperature: 0.5 }, provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}))
  });
  var ocT = await ocR.text();
  var ocJ = null; try { ocJ = JSON.parse(ocT); } catch (_) {}
  if (!ocR.ok) return { ok: false, message: (ocJ && ocJ.error && ocJ.error.message) || ('HTTP ' + ocR.status) };
  if (!ocJ || !Array.isArray(ocJ.choices)) return { ok: false, message: 'Resposta inválida do provedor de IA.' };
  return { ok: true, body: ocJ };
}

async function buildSystemPrompt_(gptCfg) {
  const name = gptCfg.display_name || 'Davi Blogger';
  const desc = gptCfg.description || '';
  const instr = gptCfg.instructions || gptCfg.system_prompt || '';
  const ices = Array.isArray(gptCfg.icebreakers) ? gptCfg.icebreakers.filter(Boolean) : [];
  const caps = gptCfg.capabilities || { web: true, image: false, code: false, data: false };
  const knowledge = Array.isArray(gptCfg.knowledge_files) ? gptCfg.knowledge_files.join('\n\n---\n\n') : '';

  const capLines = [];
  if (caps.web) capLines.push('- Busca na web: SIM');
  else capLines.push('- Busca na web: NAO');
  if (caps.image) capLines.push('- Geracao de imagens: SIM (use a tool `transcrever_audio` se for audio)');
  else capLines.push('- Geracao de imagens: NAO');
  if (caps.code) capLines.push('- Interpretar / gerar codigo: SIM');
  else capLines.push('- Interpretar / gerar codigo: NAO');
  if (caps.data) capLines.push('- Analise de dados: SIM');
  else capLines.push('- Analise de dados: NAO');

  const lines = [
    'Voce e ' + name + ', um agente de IA dentro do ecossistema Lazy Labs (https://blog.example.com).',
    desc ? 'Sobre voce: ' + desc : '',
    '',
    'INSTRUCOES DO AGENTE:',
    instr,
    '',
    'CAPACIDADES:',
    capLines.join('\n'),
    '',
    'ACTIONS DISPONIVEIS:',
    'Voce tem acesso a um set de tools que executam acoes REAIS no ecossistema:',
    '- listar_posts, obter_post: ler artigos do blog',
    '- criar_rascunho, publicar_agora, atualizar_status_post: criar/editar/publicar artigos no Supabase',
    '- listar_inscritos_newsletter: ver audiencia',
    '- disparar_whatsapp: enviar template WhatsApp aos leads',
    '- transcrever_audio: transcrever audio via Groq Whisper',
    '- listar_leads_crm, criar_lead_crm: gerenciar leads do CRM',
    '',
    'Quando o usuario pedir para criar/publicar/editar/listar algo, USE as tools. Quando a acao envolve',
    'alterar dados (criar/publicar/excluir), SEMPRE confirme antes de executar e mostre o que vai fazer.',
    '',
    'Responda sempre em portugues brasileiro, tom tecnico mas acessivel.',
    'Quando executar tools, descreva brevemente o que fez. Se algo falhar, explique o erro.',
    '',
    ices.length ? 'QUEBRA-GELOS (use se o usuario nao sabe por onde comecar):\n' + ices.map(function (i) { return '- ' + i; }).join('\n') : ''
  ];
  if (knowledge) {
    lines.push('');
    lines.push('CONHECIMENTO ANEXADO:');
    lines.push(knowledge);
  }
  return lines.filter(Boolean).join('\n');
}

async function agent_(req, res) {
  const body = readBody_(req);
  const message = String(body.message || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  if (!message) return json_(res, 400, { ok: false, message: 'message vazio.' });

  // Carrega config completa (gpt + keys).
  const cfgSnap = await db().doc('config/davi').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const gpt = cfg.gpt || {};

  const provider = (body.provider || cfg.provider || 'groq').toLowerCase();
  const model = body.model || cfg.model || '';
  let apiKey = String(body.apiKey || '').trim();
  if (!apiKey) apiKey = String(cfg[provider + '_key'] || '').trim();

  // Provider custom: usa base_url + model do Firestore.
  let customCfg = null;
  if (provider === 'custom') {
    customCfg = cfg.custom_provider || { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
    if (!apiKey) apiKey = String(cfg.custom_key || '').trim();
  }

  if (!apiKey) return json_(res, 400, { ok: false, message: 'API key ausente. Salve em Configuracoes do Davi.' });

  // Monta mensagens com system prompt rico.
  const messages = [{ role: 'system', content: await buildSystemPrompt_(gpt) }];
  const prior = history.slice(-10);
  if (prior.length && prior[prior.length - 1].role === 'user' && prior[prior.length - 1].content === message) prior.pop();
  prior.forEach(function (m) { messages.push({ role: m.role || 'user', content: String(m.content || '') }); });
  messages.push({ role: 'user', content: message });

  // Tool-calling loop (max 4 iteracoes).
  const toolCalls = [];
  let finalText = '';
  const deadline = Date.now() + 110000;
  for (var iter = 0; iter < 4; iter++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) return json_(res, 504, { ok: false, message: 'O agente demorou demais para responder. O artigo não foi publicado; tente novamente.' });
    var r = await callLLMForToolLoop_(provider, model, apiKey, messages, TOOLS, customCfg, Math.min(remaining, 100000));
    if (!r.ok) return json_(res, 502, { ok: false, message: 'LLM: ' + r.message });
    var choice = r.body.choices && r.body.choices[0];
    if (!choice) return json_(res, 502, { ok: false, message: 'Resposta vazia do LLM.' });

    var msg = choice.message || {};
    if (msg.content) finalText = stripThink_(String(msg.content));
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) break;

    // Executa cada tool call.
    for (var i = 0; i < msg.tool_calls.length; i++) {
      var tc = msg.tool_calls[i];
      var fn = tc.function && tc.function.name;
      var rawArgs = (tc.function && tc.function.arguments) || '{}';
      var args = {};
      try { args = JSON.parse(rawArgs); } catch (_) {}
      toolCalls.push({ id: tc.id, name: fn, args: args });
      var result;
      try {
        result = await executeTool_(fn, args, { cfg: cfg });
      } catch (e) {
        result = { ok: false, message: (e && e.message) || 'erro ao executar tool' };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
      toolCalls[toolCalls.length - 1].result = result;
    }
  }

  json_(res, 200, { ok: true, message: finalText || '(sem texto)', tool_calls: toolCalls });
}

async function handler(req, res) {
  setCors_(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const user = await require('./admin').requireAdmin_(req, res); if (!user) return;
  // GET /api/agent — metadados de auditoria das tools (nome, descricao, parametros,
  // backend/endpoint, headers, exemplo de input/output). So leitura, nunca executa nada.
  if (req.method === 'GET') {
    return json_(res, 200, { ok: true, tools: buildToolsAudit_() });
  }
  if (req.method !== 'POST') return json_(res, 405, { ok: false, message: 'Use GET ou POST.' });
  try { await agent_(req, res); }
  catch (error) {
    console.error('[agent]', error);
    json_(res, /timeout|aborted/i.test(String(error.name || error.message)) ? 504 : 500,
      { ok: false, message: /timeout|aborted/i.test(String(error.name || error.message))
        ? 'O provedor de IA demorou demais. Tente novamente.' : 'Falha no agente. Verifique a configuração e tente novamente.' });
  }
}

module.exports = { handler, TOOLS };
