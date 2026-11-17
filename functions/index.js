// functions/index.js
// Firebase Function — SSR para bots + SPA completo para humanos
// Node 22 — fetch nativo

const { onRequest } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { defineSecret } = require('firebase-functions/params');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const translationModule = require('./translations');
const ARTICLE_LOCALES = require('./article-locales');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const cheerio = require('cheerio');
const LazyMedia = require('./media-providers');
const { articleMarkdown } = require('./article-markdown');
const SocialCopy = require('./social-copy');
const OwnVideo = require('./own-video');
const { upload: liUploadVideoV } = require('./linkedin-video');
const ARTICLE_TEMPLATE = readFileSync(join(__dirname, 'article-template.html'), 'utf8');

// Firebase Admin (Firestore) — guarda tokens/credenciais do LinkedIn no servidor
if (!getApps().length) initializeApp();
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SUPABASE_URL  = 'https://your-supabase-project.supabase.co';
const SUPABASE_ANON = 'YOUR_SUPABASE_PUBLISHABLE_KEY';
const BLOG_BASE_URL = 'https://blog.example.com';

// Detecta se o request vem de um bot de busca
function isBot(userAgent) {
  if (!userAgent) return false;
  var ua = userAgent.toLowerCase();
  return /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|twitterbot|linkedinbot|whatsapp|telegram|facebookexternalhit|rogerbot|showyoubot|outbrain|pinterestbot|slackbot|vkshare|w3c_validator|curl/.test(ua);
}

// Migrado do Supabase pro Firestore em 2026-07-30 — posts.js so escreve no
// Firestore desde ontem, entao ler daqui e o que faz artigo novo aparecer.
// Nota: os widgets client-side embutidos no SPA_TEMPLATE (likes/views/comentarios/
// relacionados) ainda apontam pro Supabase direto do navegador — isso continua
// pendente (ver overview.md), so o carregamento do artigo em si foi migrado aqui.
async function fetchPost(slug) {
  var snap = await db().doc('posts/' + slug).get();
  if (!snap.exists) return [];
  var p = snap.data();
  if (p.status !== 'published') return [];
  return [{
    id: slug,
    title: p.title || '',
    slug: p.slug || slug,
    excerpt: p.excerpt || '',
    content: p.content || '',
    category: p.category || '',
    tags: p.tags || [],
    cover_url: p.cover_url || '',
    author_name: p.author_name || 'Equipe do Blog',
    author_id: p.author_id || '',
    author_photo_url: p.author_photo_url || '',
    reading_time: p.reading_time || 5,
    published_at: p.published_at || null,
    audio_url: p.audio_url || '',
    video_url: p.video_url || '',
    github_url: p.github_url || '',
    project_url: p.project_url || '',
    featured: !!p.featured,
    view_count: p.view_count || 0,
    like_count: p.like_count || 0,
    favorite_count: p.favorite_count || 0,
    comment_count: p.comment_count || 0,
    page_load_count: p.page_load_count || 0,
    qualified_view_count: p.qualified_view_count || 0,
    read_session_count: p.read_session_count || 0,
    feed_click_count: p.feed_click_count || 0,
    cta_click_count: p.cta_click_count || 0,
    seo_title: p.seo_title || '', seo_description: p.seo_description || '',
    cta_label: p.cta_label || '', cta_url: p.cta_url || '',
    translation_hash: p.translation_hash || '',
    translation_ready: p.translation_hash === translationModule.sourceHash(p)
      ? (p.translation_ready || []).filter(lang => translationModule.TARGETS.includes(lang)) : []
  }];
}

// Debug endpoint
exports.debug = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 15 },
  async function(req, res) {
    const user = await adminModule.requireAdmin_(req, res); if (!user) return;
    var slug = (req.query && req.query.slug) || 'suas-vendas-morrem-sem-followup';
    var rows = []; var rawResp = null; var error = null;
    try {
      var url = SUPABASE_URL + '/rest/v1/posts?slug=eq.' + encodeURIComponent(slug)
        + '&status=eq.published&select=id,title,slug,status&limit=1';
      var resp = await fetch(url, { headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON } });
      rawResp = { status: resp.status, ok: resp.ok };
      var body = await resp.text();
      rawResp.body = body.slice(0, 300);
      try { rows = JSON.parse(body); } catch(e) {}
    } catch(e) { error = e.message; }
    res.set('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ slug, rows_found: Array.isArray(rows)?rows.length:0, first_row: rows[0]||null, raw_response: rawResp, error }, null, 2));
  }
);

// Funcao principal
exports.artigo = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 15, maxInstances: 10 },
  async function(req, res) {
    var rawPath = req.path || '';
    var match = /^\/(?:(en|es|fr|de)\/)?artigo\/([a-z0-9]+(?:-[a-z0-9]+)*)(\.md)?\/?$/.exec(rawPath);
    if (rawPath === '/artigo' || rawPath === '/artigo/') { res.redirect(301, BLOG_BASE_URL); return; }
    if (!match || match[2].length > 200) { res.set('Cache-Control', 'no-store'); res.status(404).send(buildNotFoundHTML('')); return; }
    var language = match[1] || 'pt-BR';
    var slug = match[2];
    var wantsMarkdown = !!match[3];

    try {
      var rows = await fetchPost(slug);
      var post  = rows[0];

      if (!post) {
        res.set('Cache-Control', 'no-store');
        res.status(404).send(buildNotFoundHTML(slug));
        return;
      }

      var ready = post.translation_ready || [];
      if (language !== 'pt-BR') {
        if (!ready.includes(language)) { res.set('Cache-Control', 'no-store'); res.status(404).send(buildNotFoundHTML(slug)); return; }
        var translatedSnap = await db().doc('posts/' + slug + '/translations/' + language).get();
        if (!translatedSnap.exists || translatedSnap.data().source_hash !== post.translation_hash) {
          res.set('Cache-Control', 'no-store');
          res.status(404).send(buildNotFoundHTML(slug)); return;
        }
        var translatedData = translatedSnap.data();
        var originalCategory = post.category;
        post = Object.assign({}, post, translatedData, {
          audio_url: '',
          original_category: originalCategory,
          content: translationModule.restoreInlineWhitespace(post.content, translatedData.content || '')
        });
      }

      if (wantsMarkdown) {
        // Mesmo conteúdo publicado que o HTML; conversão determinística sem IA
        // nem geração de arquivo a cada publicação. Evita ler perfil do autor.
        post.content = safeArticleHtml(post.content);
        res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
        res.set('Content-Type', 'text/markdown; charset=utf-8');
        res.set('Link', '<' + articleUrl(slug, language) + '>; rel="canonical"');
        res.status(200).send(articleMarkdown(post, language, articleUrl(slug, language)));
        return;
      }

      // Busca o autor completo (bio/foto/redes atuais) pro card no fim do artigo —
      // sempre ao vivo, nao denormalizado, pra refletir a ultima atualizacao do perfil.
      var authorFull = null;
      if (post.author_id) {
        try {
          var authorSnap = await db().doc('authors/' + post.author_id).get();
          if (authorSnap.exists) authorFull = Object.assign({ id: post.author_id }, authorSnap.data());
        } catch (e) { console.error('[artigo] erro ao buscar autor:', e.message); }
      }

      post.content = safeArticleHtml(post.content);
      if (authorFull) authorFull = await localizeAuthor(authorFull, language);
      if (authorFull && authorFull.photo_url) post.author_photo_url = authorFull.photo_url;

      var ua  = req.headers['user-agent'] || '';
      var bot = isBot(ua);

      if (bot) {
        // Serve HTML simples com todo o conteudo para indexacao.
        // s-maxage=0: a CDN (Fastly/Firebase Hosting) nao varia cache por
        // User-Agent, entao um cache compartilhado aqui vazaria essa versao
        // sem JS pra visitantes humanos que acessarem a mesma URL logo em
        // seguida (ex: bot de preview do WhatsApp/Facebook cacheia, humano
        // clica no link compartilhado e cai nessa pagina estatica).
        res.set('Cache-Control', 'public, max-age=3600, s-maxage=0');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(buildSSRHTML(post, slug, authorFull, language, ready));
      } else {
        // Serve o SPA completo com os dados injetados para o usuario
        res.set('Cache-Control', 'public, max-age=60, s-maxage=0');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(buildSPAHTML(post, slug, authorFull, ready, language));
      }

    } catch (err) {
      console.error('[SSR] Erro:', err.message);
      res.status(500).send('<h1>Erro</h1><p>' + esc(err.message) + '</p>');
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  LINKEDIN — integração real (OAuth 2.0 + Posts API)
//  Rotas (via rewrite /api/linkedin/**):
//    GET  /auth        → redireciona p/ autorização LinkedIn
//    GET  /callback    → troca code por token, salva no Firestore, fecha popup
//    GET  /status      → { connected, name, configured, expired }
//    POST /config      → { client_id, client_secret } (salvo server-side)
//    POST /publish     → { text, link?, linkTitle?, linkDesc?, imageBase64? }
//    POST /disconnect  → remove token
//  Token e secret ficam SÓ no Firestore (nunca no browser).
// ═══════════════════════════════════════════════════════════════════════════════
const LI_AUTH     = 'https://www.linkedin.com/oauth/v2/authorization';
const LI_TOKEN    = 'https://www.linkedin.com/oauth/v2/accessToken';
const LI_USERINFO = 'https://api.linkedin.com/v2/userinfo';
const LI_POSTS    = 'https://api.linkedin.com/rest/posts';
const LI_IMAGES   = 'https://api.linkedin.com/rest/images';
const LI_VERSION  = '202406';                                  // header LinkedIn-Version (ajustável)
const LI_REDIRECT = BLOG_BASE_URL + '/api/linkedin/callback';
const LI_SCOPE    = 'openid profile email w_member_social';

function liJson(res, code, obj) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  // só seta '*' se o handler ainda não ecoou a Origin (preserva CORS com credentials no bio/form)
  if (!res.get('Access-Control-Allow-Origin')) res.set('Access-Control-Allow-Origin', '*');
  res.status(code).send(JSON.stringify(obj));
}
async function liGetConfig() { const d = await db().doc('config/linkedin').get(); return d.exists ? d.data() : {}; }
async function liGetToken()  { const d = await db().doc('integrations/linkedin').get(); return d.exists ? d.data() : null; }
function liReadBody(req) { try { return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (_) { return {}; } }
function liPopup(ok, msg) {
  return '<!doctype html><meta charset="utf-8"><body style="background:#06060f;color:#e8e8f5;font-family:system-ui,sans-serif;text-align:center;padding:60px">'
    + '<h2 style="color:' + (ok ? '#00ff9d' : '#ff006e') + '">' + (ok ? 'LinkedIn conectado &#10003;' : 'Falha na conexão') + '</h2>'
    + '<p style="color:#7a7a9a;max-width:460px;margin:12px auto">' + String(msg).replace(/</g, '&lt;') + '</p>'
    + '<script>try{window.opener&&window.opener.postMessage({source:"ll-linkedin",ok:' + (ok ? 'true' : 'false') + '},"*");}catch(e){}setTimeout(function(){window.close();},1400);</script>'
    + '<p style="color:#4a4a6a;font-size:12px">Pode fechar esta janela.</p></body>';
}

exports.linkedin = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 180 },
  async function (req, res) {
    res.set('Access-Control-Allow-Origin', BLOG_BASE_URL);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
    let liPublicationRef = null;
    try {
      if (action !== 'callback') {
        const user = await adminModule.requireAdmin_(req, res); if (!user) return;
      }
      // ── AUTH ──
      if (action === 'auth') {
        if (req.method !== 'POST') { liJson(res, 405, { ok: false, error: 'use POST' }); return; }
        const cfg = await liGetConfig();
        if (!cfg.client_id) { liJson(res, 400, { ok: false, error: 'LinkedIn não configurado' }); return; }
        const state = crypto.randomBytes(32).toString('hex');
        await db().doc('oauth_state/' + state).set({ created_at: Date.now() });
        const url = LI_AUTH + '?response_type=code&client_id=' + encodeURIComponent(cfg.client_id)
          + '&redirect_uri=' + encodeURIComponent(LI_REDIRECT)
          + '&state=' + state + '&scope=' + encodeURIComponent(LI_SCOPE);
        liJson(res, 200, { ok: true, url: url }); return;
      }
      // ── CALLBACK ──
      if (action === 'callback') {
        if (req.query.error) { res.send(liPopup(false, 'Autorização negada: ' + req.query.error_description || req.query.error)); return; }
        const code = req.query.code, state = req.query.state;
        if (!code || !state) { res.send(liPopup(false, 'Parâmetros ausentes')); return; }
        const stDoc = await db().doc('oauth_state/' + state).get();
        if (!stDoc.exists) { res.send(liPopup(false, 'State inválido (possível CSRF)')); return; }
        await db().doc('oauth_state/' + state).delete().catch(function () {});
        if (!stDoc.data().created_at || Date.now() - stDoc.data().created_at > 10 * 60 * 1000) {
          res.send(liPopup(false, 'Autorização expirada')); return;
        }
        const cfg = await liGetConfig();
        const form = new URLSearchParams({ grant_type: 'authorization_code', code: code, redirect_uri: LI_REDIRECT, client_id: cfg.client_id, client_secret: cfg.client_secret || '' });
        const tr = await fetch(LI_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
        const tk = await tr.json();
        if (!tk.access_token) { res.send(liPopup(false, 'Falha ao obter token: ' + JSON.stringify(tk))); return; }
        let name = 'Conta LinkedIn', sub = null;
        try { const ur = await fetch(LI_USERINFO, { headers: { Authorization: 'Bearer ' + tk.access_token } }); const u = await ur.json(); name = u.name || name; sub = u.sub || null; } catch (_) {}
        await db().doc('integrations/linkedin').set({
          access_token: tk.access_token,
          expires_in: tk.expires_in || null,
          expires_at: Date.now() + (tk.expires_in ? tk.expires_in * 1000 : 0),
          member_urn: sub ? ('urn:li:person:' + sub) : null,
          name: name, connected_at: Date.now()
        });
        res.send(liPopup(true, name)); return;
      }
      // ── STATUS ──
      if (action === 'status') {
        const t = await liGetToken(); const cfg = await liGetConfig();
        const has = !!(t && t.access_token);
        const expired = has && t.expires_at && Date.now() > t.expires_at;
        liJson(res, 200, { ok: true, connected: has && !expired, expired: !!expired, name: t ? t.name : null, configured: !!cfg.client_id, redirect_uri: LI_REDIRECT });
        return;
      }
      // ── CONFIG ──
      if (action === 'config') {
        if (req.method !== 'POST') { liJson(res, 405, { ok: false, error: 'use POST' }); return; }
        const b = liReadBody(req);
        if (!b.client_id) { liJson(res, 400, { ok: false, error: 'client_id obrigatório' }); return; }
        const upd = { client_id: String(b.client_id).trim() };
        if (b.client_secret) upd.client_secret = String(b.client_secret).trim();
        await db().doc('config/linkedin').set(upd, { merge: true });
        liJson(res, 200, { ok: true, redirect_uri: LI_REDIRECT }); return;
      }
      // ── DISCONNECT ──
      if (action === 'disconnect') {
        await db().doc('integrations/linkedin').delete().catch(function () {});
        liJson(res, 200, { ok: true }); return;
      }
      // ── PUBLISH ──
      if (action === 'publish') {
        if (req.method !== 'POST') { liJson(res, 405, { ok: false, error: 'use POST' }); return; }
        const b = liReadBody(req);
        const t = await liGetToken();
        if (!t || !t.access_token) { liJson(res, 400, { ok: false, error: 'Conta não conectada' }); return; }
        if (t.expires_at && Date.now() > t.expires_at) { liJson(res, 400, { ok: false, error: 'Token expirado — reconecte a conta' }); return; }
        if (!t.member_urn) { liJson(res, 400, { ok: false, error: 'URN do membro ausente — reconecte' }); return; }
        let publicationRef = null;
        if (b.slug) {
          const slug = String(b.slug);
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { liJson(res, 400, { ok:false, error:'Slug inválido.' }); return; }
          const snap = await db().doc('posts/' + slug).get();
          if (!snap.exists || snap.data().status !== 'published' || snap.data().blog_id !== 'your-blog') {
            liJson(res, 404, { ok:false, error:'Artigo publicado não encontrado.' }); return;
          }
          const article = Object.assign({ slug }, snap.data());
          b.text = SocialCopy.approved('linkedin', article);
          b.link = SocialCopy.url(article);
          b.linkTitle = article.title;
          b.linkDesc = article.excerpt;
          const requested = String((article.social_modes || {}).linkedin || 'auto');
          if (requested === 'video' && !OwnVideo.objectName(article.tiktok_video_url)) {
            liJson(res, 400, { ok:false, error:'Envie um MP4 próprio pelo editor para publicar vídeo nativo no LinkedIn.' }); return;
          }
          if ((requested === 'auto' || requested === 'video') && OwnVideo.objectName(article.tiktok_video_url)) b.videoUrl = article.tiktok_video_url;
          publicationRef = db().doc('social_publications/' + slug + '_linkedin');
          liPublicationRef = publicationRef;
          const decision = await db().runTransaction(async tx => {
            const previous = await tx.get(publicationRef);
            const prior = previous.exists ? previous.data() : {};
            if (prior.status === 'published') return 'already';
            if (prior.status === 'pending' || prior.status === 'unknown') return 'blocked';
            tx.set(publicationRef, { status:'pending', slug, channel:'linkedin', startedAt:new Date().toISOString() });
            return 'ready';
          });
          if (decision !== 'ready') { liJson(res, decision === 'already' ? 200 : 409,
            { ok:decision === 'already', already:decision === 'already', error:decision === 'blocked' ? 'Publicação anterior pendente ou incerta. Confira o LinkedIn antes de tentar novamente.' : undefined }); return; }
        }
        const text = (b.text || '').toString();
        if (!text.trim() && !b.link && !b.imageBase64) { liJson(res, 400, { ok: false, error: 'Nada para publicar' }); return; }

        // Descobre a versão ATIVA da API (header LinkedIn-Version) e memoriza no Firestore.
        // LinkedIn invalida versões antigas (erro 426 NONEXISTENT_VERSION); então tentamos
        // do mês atual p/ trás até uma funcionar, e salvamos a vencedora p/ as próximas vezes.
        const cfgV = await liGetConfig();
        const candidates = liVersionCandidates(cfgV.api_version);
        let done = null, usedVer = null, lastErr = null;

        for (let i = 0; i < candidates.length; i++) {
          const ver = candidates[i];
          const headers = { 'Authorization': 'Bearer ' + t.access_token, 'Content-Type': 'application/json', 'LinkedIn-Version': ver, 'X-Restli-Protocol-Version': '2.0.0' };
          const post = {
            author: t.member_urn, commentary: text, visibility: 'PUBLIC',
            distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
            lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false
          };
          // Vídeo próprio publicado nativamente; URL do YouTube vira card do artigo.
          if (b.videoUrl) {
            const up = await liUploadVideoV(t, b.videoUrl, ver);
            if (up.badVersion) continue;
            if (up.error) { lastErr = up.error; break; }
            post.content = { media:{ id:up.urn, title:String(b.linkTitle || 'Vídeo').slice(0, 100) } };
          } else if (b.imageBase64) {
            const up = await liUploadImageV(t, b.imageBase64, ver);
            if (up && up.badVersion) { continue; }                 // versão inativa → próxima
            if (up && up.urn) post.content = { media: { id: up.urn, title: (b.imageAlt || 'imagem').slice(0, 100) } };
            else if (up && up.error) { lastErr = up.error; }
          } else if (b.link) {
            const art = { source: b.link };
            if (b.linkTitle) art.title = String(b.linkTitle).slice(0, 200);
            if (b.linkDesc)  art.description = String(b.linkDesc).slice(0, 256);
            post.content = { article: art };
          }
          const r = await fetch(LI_POSTS, { method: 'POST', headers: headers, body: JSON.stringify(post) });
          let bodyTxt = ''; try { bodyTxt = await r.text(); } catch (_) {}
          if (r.status === 426 && /NONEXISTENT_VERSION/.test(bodyTxt)) { continue; }  // versão inativa → próxima
          const id = r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || null;
          done = { status: r.status, body: bodyTxt, id: id }; usedVer = ver; break;
        }

        if (!done) {
          if (publicationRef) await publicationRef.set({ status:'failed', error:lastErr || 'Versão da API indisponível' }, { merge:true });
          liJson(res, 200, { ok: false, error:lastErr || 'Nenhuma versão ativa da API LinkedIn encontrada.' }); return;
        }
        if (usedVer && usedVer !== cfgV.api_version) db().doc('config/linkedin').set({ api_version: usedVer }, { merge: true }).catch(function () {});
        if (done.status >= 200 && done.status < 300 && done.id) {
          if (publicationRef) await publicationRef.set({ status:'published', externalId:done.id || '', completedAt:new Date().toISOString() }, { merge:true });
          liJson(res, 200, { ok: true, id: done.id, version: usedVer });
        } else if (done.status >= 200 && done.status < 300) {
          if (publicationRef) await publicationRef.set({ status:'unknown', error:'LinkedIn aceitou sem devolver o ID do post.' }, { merge:true });
          liJson(res, 200, { ok:false, error:'LinkedIn aceitou a publicação sem confirmar o ID. Confira seu perfil antes de tentar novamente.' });
        } else {
          if (publicationRef) await publicationRef.set({ status:done.status >= 500 ? 'unknown' : 'failed', error:String(done.body || '').slice(0, 240) }, { merge:true });
          console.error('[linkedin publish]', done.status, done.body); liJson(res, 200, { ok: false, status: done.status, error: done.body || ('HTTP ' + done.status) });
        }
        return;
      }
      liJson(res, 404, { ok: false, error: 'rota desconhecida: ' + action });
    } catch (err) {
      if (liPublicationRef) await liPublicationRef.set({ status:'unknown', error:String(err.message || 'Falha').slice(0, 240), completedAt:new Date().toISOString() }, { merge:true }).catch(() => {});
      console.error('[linkedin]', action, err);
      liJson(res, 500, { ok: false, error: err.message });
    }
  }
);

// Upload de imagem com versão explícita. Retorna {urn} | {badVersion:true} | {error}
async function liUploadImageV(t, dataUrl, version) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return { error: 'imagem base64 inválida' };
  const mime = m[1], buf = Buffer.from(m[2], 'base64');
  const headers = { 'Authorization': 'Bearer ' + t.access_token, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' };
  const initR = await fetch(LI_IMAGES + '?action=initializeUpload', { method: 'POST', headers: headers, body: JSON.stringify({ initializeUploadRequest: { owner: t.member_urn } }) });
  let initTxt = ''; try { initTxt = await initR.text(); } catch (_) {}
  if (initR.status === 426 && /NONEXISTENT_VERSION/.test(initTxt)) return { badVersion: true };
  let init = {}; try { init = JSON.parse(initTxt); } catch (_) {}
  const uploadUrl = init.value && init.value.uploadUrl;
  const imageUrn  = init.value && init.value.image;
  if (!uploadUrl || !imageUrn) return { error: 'initializeUpload falhou: ' + initTxt };
  const up = await fetch(uploadUrl, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + t.access_token, 'Content-Type': mime }, body: buf });
  if (!(up.status >= 200 && up.status < 300)) return { error: 'upload binário falhou: HTTP ' + up.status };
  return { urn: imageUrn };
}

// Versões candidatas da API LinkedIn (YYYYMM): a memorizada primeiro, depois mês atual p/ trás
function liVersionCandidates(cached) {
  const arr = [];
  if (cached) arr.push(String(cached));
  const now = new Date();
  for (let i = 0; i < 16; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const v = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    if (arr.indexOf(v) < 0) arr.push(v);
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NEWSLETTER CAMPAIGNS — histórico de disparos no Firestore (coleção "campaigns")
//  O Supabase não tem tabela newsletter_campaigns; o histórico fica aqui.
//  Rotas (via rewrite /api/campaigns/**):
//    POST /log  → registra { subject, post_title, slug, sent, failed, total }
//    GET  /list → últimas 50 campanhas (desc)
// ═══════════════════════════════════════════════════════════════════════════════
const newsletterModule = require('./newsletter');
exports.campaigns = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 180 },
  newsletterModule.createHandler({
    db,
    requireAdmin: (req, res) => require('./admin').requireAdmin_(req, res),
    getFormConfig, buildFormEmail, esc, json: liJson
  })
);
exports.newsletterInactivitySweep = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'America/Araguaina', region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 120 },
  async () => { await newsletterModule.sweep(db); }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  BIO / LINKTREE — página example.com/bio (config dinâmica + tracking)
//  Rotas (via rewrite /api/bio/**):
//    GET  /config → config pública (Firestore config/bio, ou DEFAULT)
//    POST /save   → admin salva { config }
//    POST /track  → grava sessão (Firestore bio_sessions/{session_id}); 1 sessão/linha
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_BIO = {
  profile: {
    name: 'Equipe do Blog', brand: 'LAZY LABS', tagline: 'Engenharia de IA & Automação',
    avatar: '', cta_label: 'Agendar diagnóstico', cta_url: 'https://example.com/agendar'
  },
  links: [
    { id:'blog',      title:'Blog — IA, automação & bastidores', url:'https://blog.example.com',                          icon:'blog',      color:'#00f0ff', enabled:true },
    { id:'site',      title:'Site Lazy Labs',                     url:'https://example.com',                        icon:'flask',     color:'#a855f7', enabled:true },
    { id:'instagram', title:'Instagram',                          url:'https://www.instagram.com/your-account/',        icon:'instagram', color:'#d6249f', enabled:true },
    { id:'tiktok',    title:'TikTok',                             url:'https://www.tiktok.com/@your-account',             icon:'tiktok',    color:'#25F4EE', enabled:true },
    { id:'linkedin',  title:'LinkedIn',                           url:'https://www.linkedin.com/in/your-account/',        icon:'linkedin',  color:'#0a85c2', enabled:true },
    { id:'whatsapp',  title:'Falar no WhatsApp',                  url:'https://wa.me/YOUR_WHATSAPP_NUMBER',                    icon:'whatsapp',  color:'#25d366', enabled:true }
  ]
};

// ── Espelho do tracking na Planilha central (aba Bio_Tracking, 1 sessão/linha) ──
const BIO_SHEET_ID = '1McN_1FTv2xRmiS9YDiAK6TR71uyCn3f0PWDaUmxrfAY';
const BIO_TAB = 'Bio_Tracking';
const BIO_HEADERS = ['session_id','primeira_visita','pageview','pageview_ts','clicou','ultimo_link','ultimo_click_ts','total_cliques','user_agent','referrer','fbp'];
let _bioSheets = null, _bioSheetReady = null;
async function bioSheetsClient() {
  if (_bioSheets) return _bioSheets;
  const { google } = require('googleapis');   // lazy (dep pesada — fora do load p/ não estourar discovery)
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  _bioSheets = google.sheets({ version: 'v4', auth });
  return _bioSheets;
}
async function bioEnsureSheet(sheets) {
  if (_bioSheetReady) return _bioSheetReady;
  _bioSheetReady = (async function () {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: BIO_SHEET_ID });
    const has = (meta.data.sheets || []).some(function (s) { return s.properties.title === BIO_TAB; });
    if (!has) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: BIO_TAB } } }] } });
      await sheets.spreadsheets.values.update({ spreadsheetId: BIO_SHEET_ID, range: BIO_TAB + '!A1', valueInputOption: 'RAW', requestBody: { values: [BIO_HEADERS] } });
    }
  })().catch(function (e) { _bioSheetReady = null; throw e; });
  return _bioSheetReady;
}
function bioSheetRow(sid, s) {
  const clicks = Array.isArray(s.clicks) ? s.clicks : [];
  const last = clicks.length ? clicks[clicks.length - 1] : {};
  function iso(t) { return t ? (typeof t === 'number' ? new Date(t).toISOString() : String(t)) : ''; }
  return [ sid, iso(s.first_seen), s.pageview ? 'TRUE' : '', s.pageview_ts || '', s.clicked ? 'TRUE' : '',
    last.title || last.link || '', last.ts || '', String(clicks.length || 0), s.ua || '', s.ref || '', s.fbp || '' ];
}
async function bioSheetSync(sid, s) {
  try {
    const sheets = await bioSheetsClient();
    await bioEnsureSheet(sheets);
    const row = bioSheetRow(sid, s);
    if (s.sheet_row) {
      await sheets.spreadsheets.values.update({ spreadsheetId: BIO_SHEET_ID, range: BIO_TAB + '!A' + s.sheet_row, valueInputOption: 'RAW', requestBody: { values: [row] } });
    } else {
      const ap = await sheets.spreadsheets.values.append({ spreadsheetId: BIO_SHEET_ID, range: BIO_TAB + '!A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
      const rng = (ap.data.updates && ap.data.updates.updatedRange) || '';
      const m = /![A-Z]+(\d+)/.exec(rng);
      if (m) await db().doc('bio_sessions/' + sid).set({ sheet_row: parseInt(m[1], 10) }, { merge: true });
    }
  } catch (e) { console.error('[bio sheet]', e.message); }
}

exports.bio = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  async function (req, res) {
    const _o = req.headers.origin || '*';
    res.set('Access-Control-Allow-Origin', _o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    const action = (req.path || '').replace(/\/+$/, '').split('/').pop();
    try {
      if (action !== 'config' && action !== 'track') {
        const user = await adminModule.requireAdmin_(req, res); if (!user) return;
      }
      if (action === 'config') {
        const d = await db().doc('config/bio').get();
        res.set('Cache-Control', 'no-cache');
        liJson(res, 200, { ok: true, config: d.exists ? d.data() : DEFAULT_BIO });
        return;
      }
      if (action === 'save') {
        if (req.method !== 'POST') { liJson(res, 405, { ok: false, error: 'use POST' }); return; }
        let b = {}; try { b = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (_) {}
        if (!b.config || typeof b.config !== 'object') { liJson(res, 400, { ok: false, error: 'config obrigatório' }); return; }
        await db().doc('config/bio').set(b.config);
        liJson(res, 200, { ok: true });
        return;
      }
      if (action === 'track') {
        if (req.method !== 'POST') { liJson(res, 405, { ok: false, error: 'use POST' }); return; }
        let b = {}; try { b = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (_) {}
        const sid = String(b.session_id || '').slice(0, 64);
        if (!sid) { liJson(res, 400, { ok: false, error: 'session_id' }); return; }
        const now = Date.now();
        const ev = String(b.event || '');
        const ref = db().doc('bio_sessions/' + sid);
        const snap = await ref.get();
        const upd = { last_seen: now };
        if (!snap.exists) upd.first_seen = now;
        if (ev === 'pageview') {
          upd.pageview = true; upd.pageview_ts = b.ts || new Date().toISOString();
          upd.ua = String(b.ua || '').slice(0, 300); upd.ref = String(b.ref || '').slice(0, 300);
          upd.fbp = String(b.fbp || '').slice(0, 120); upd.fbc = String(b.fbc || '').slice(0, 200);
        }
        if (ev === 'click') {
          upd.clicked = true;
          upd.clicks = FieldValue.arrayUnion({ link: String(b.link || '').slice(0, 300), title: String(b.title || '').slice(0, 120), ts: b.ts || new Date().toISOString() });
        }
        await ref.set(upd, { merge: true });
        const full = (await ref.get()).data() || {};
        await bioSheetSync(sid, full);   // espelha na Planilha (silencioso se não configurado)
        liJson(res, 200, { ok: true });
        return;
      }
      if (action === 'stats') {
        const snap = await db().collection('bio_sessions').get();
        let sessions = 0, pageviews = 0, clicks = 0; const byLink = {};
        snap.forEach(function (doc) {
          if (doc.id.indexOf('test') === 0) return;      // ignora sessões de teste
          const s = doc.data(); sessions++;
          if (s.pageview) pageviews++;
          if (Array.isArray(s.clicks)) s.clicks.forEach(function (c) {
            clicks++; const k = (c.title || c.link || '?');
            byLink[k] = (byLink[k] || 0) + 1;
          });
        });
        const links = Object.keys(byLink).map(function (k) { return { label: k, count: byLink[k] }; }).sort(function (a, b) { return b.count - a.count; });
        liJson(res, 200, { ok: true, sessions: sessions, pageviews: pageviews, clicks: clicks, links: links });
        return;
      }
      liJson(res, 404, { ok: false, error: 'rota desconhecida: ' + action });
    } catch (err) { console.error('[bio]', action, err); liJson(res, 500, { ok: false, error: err.message }); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  FORM DIAGNÓSTICO — /api/form/** (motor da skill diagnostic-form-builder em Functions)
//  Mantém: whitelist de config (segredos no servidor), 1 linha/sessão, dedup por sessão,
//  CAPI server-side com event_id (dedup c/ Pixel), validação, honeypot, rate limit, hash PII.
//  Transporte = fetch+CORS (Functions têm CORS; JSONP da skill era workaround do Apps Script).
//  Rotas: GET /config · POST /save (admin) · POST /track · POST /lead · GET /logs (admin)
// ═══════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const siteTracking = require('./site-tracking');
let siteConfigCache = { until: 0, value: null };
async function siteFormConfig() {
  if (siteConfigCache.until > Date.now()) return siteConfigCache.value;
  siteConfigCache = { until: Date.now() + 60000, value: await getFormConfig() };
  return siteConfigCache.value;
}
const FORM_PIXEL_DEFAULT = 'YOUR_META_PIXEL_ID';
function DEFAULT_FORM_CONFIG() {
  return {
    title: 'Descubra o que dá pra automatizar no seu negócio',
    subtitle: 'Responda 6 perguntas rápidas e receba um diagnóstico gratuito da Lazy Labs.',
    questions: [
      { id:'perfil', type:'choice', label:'Você é:', required:true, options:['Dono de empresa','Sócio','Gestor','Autônomo / Freelancer','Outro'] },
      { id:'mercado', type:'choice', label:'Em qual mercado você atua?', required:true, options:['Serviços','Automotivo / Autopeças','Saúde / Clínica','Imobiliário','Varejo / E-commerce','Indústria / B2B','Tecnologia','Outro'] },
      { id:'desafio', type:'choice', label:'Qual é o maior gargalo hoje?', required:true, options:['Atendimento manual no WhatsApp','Falta de sistema / CRM','Processos repetitivos','Anúncios sem retorno claro','Preciso de um app / sistema'] },
      { id:'faturamento', type:'choice', label:'Faturamento médio mensal?', required:true, options:['Até R$ 20 mil','R$ 20–100 mil','R$ 100–300 mil','R$ 300 mil – 1 mi','Acima de R$ 1 mi'] },
      { id:'name', type:'text', label:'Qual é o seu nome?', required:true, placeholder:'Seu nome' },
      { id:'phone', type:'tel', label:'Qual é o seu WhatsApp?', required:true, placeholder:'(11) 99999-9999' },
      { id:'email', type:'email', label:'Qual é o seu melhor e-mail?', required:true, placeholder:'voce@email.com' }
    ],
    vsl: { enabled:false, url:'' },
    thankYouVideo: { enabled:false, url:'', title:'Enquanto isso, assista 👇' },
    exitPopup: { enabled:true, title:'Tem certeza que deseja sair?', text:'Falta pouco para concluir seu diagnóstico.' },
    whatsapp: { number:'YOUR_WHATSAPP_NUMBER', text:'Olá! Preenchi o diagnóstico da Lazy Labs e quero saber mais.' },
    meta: { pixelId: FORM_PIXEL_DEFAULT, gtmId:'', capiEnabled:false, capiToken:'', testEventCode:'' },
    telegram: { enabled:false, chatId:'', token:'' },
    whatsappCloud: { enabled:false, phoneId:'', token:'', template:'', langCode:'pt_BR', nameVar:true },
    email: { enabled:false, adminTo:'', confirmLead:true, resendKey:'', fromEmail:'', fromName:'Lazy Labs' },
    redirectUrl: ''
  };
}
function formDeepMerge(base, over) {
  if (over == null) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return over;
  const out = {}; Object.keys(base).forEach(function(k){ out[k] = base[k]; });
  Object.keys(over || {}).forEach(function(k){ out[k] = (typeof base[k]==='object' && !Array.isArray(base[k]) && base[k]) ? formDeepMerge(base[k], over[k]) : over[k]; });
  return out;
}
async function getFormConfig() { const d = await db().doc('config/form').get(); return formDeepMerge(DEFAULT_FORM_CONFIG(), d.exists ? d.data() : {}); }
function publicFormConfig(c) {  // 🔒 whitelist — nunca devolve tokens/segredos
  return { title:c.title, subtitle:c.subtitle, vsl:c.vsl, thankYouVideo:c.thankYouVideo, exitPopup:c.exitPopup,
    questions:c.questions, whatsapp:{ number:c.whatsapp.number, text:c.whatsapp.text },
    pixelId:c.meta.pixelId, redirectUrl:c.redirectUrl };
}
// ── segurança ──
function formValidEmail(v){ const s=String(v||'').trim(); if(/\s/.test(s)||s.indexOf('..')>=0) return false; if(/^[=+\-@]/.test(s)) return false; return /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(s); }
function formValidPhone(v){ const d=String(v||'').replace(/\D/g,''); return d.length>=10 && d.length<=14; }
function formValidName(v){ const n=String(v||'').trim(); return n.length>=2 && n.length<=80; }
function formIsBot(p){ return !!(p && (p.hp || p.website || p.url || p._gotcha)); }
function formSanitize(v){ let s=String(v==null?'':v); if(/^[=+\-@\t\r]/.test(s)) s="'"+s; return s.substring(0,1500); }
function formSha256(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function formMaskPhone(v){ const d=String(v||'').replace(/\D/g,''); return d.length<6?(d?'***':''):d.slice(0,4)+'****'+d.slice(-2); }
function formMaskEmail(v){ const s=String(v||'').trim(), at=s.indexOf('@'); if(at<1) return s?'***':''; const u=s.slice(0,at); return (u.length<=2?u[0]+'*':u.slice(0,2)+'***')+'@'+s.slice(at+1); }
function formEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// E-mail branded (dark Big-Tech) — estilos inline (clientes ignoram <style>)
function buildFormEmail(o){
  o=o||{};
  var cta = o.ctaUrl ? '<table cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td><a href="'+o.ctaUrl+'" style="display:inline-block;background:linear-gradient(120deg,#00f0ff,#a855f7);color:#04040c;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:11px;font-family:Arial,Helvetica,sans-serif">'+(o.ctaText||'Continuar')+'</a></td></tr></table>' : '';
  return '<!doctype html><html><body style="margin:0;background:#06060f;padding:0;width:100%">'
    +'<table width="100%" cellpadding="0" cellspacing="0" style="background:#06060f"><tr><td align="center" style="padding:30px 14px">'
    +'<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0d1018;border:1px solid #1c2030;border-radius:18px;overflow:hidden">'
    +'<tr><td style="padding:24px 30px"><div style="font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:800;color:#eef0fb;letter-spacing:1px">[ <span style="color:#00f0ff">LAZY</span> LABS ]</div></td></tr>'
    +'<tr><td style="height:3px;background:linear-gradient(90deg,#00f0ff,#a855f7)"></td></tr>'
    +'<tr><td style="padding:34px 30px">'
    +'<div style="font-family:Arial,Helvetica,sans-serif;font-size:23px;font-weight:800;color:#ffffff;line-height:1.3;margin-bottom:14px">'+(o.heading||'')+'</div>'
    +'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#b8b8d0;line-height:1.7">'+(o.body||'')+'</div>'+cta
    +'</td></tr>'
    +'<tr><td style="padding:22px 30px;border-top:1px solid #1c2030;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6a6a8a;line-height:1.7">'
    +'<b style="color:#a8a8c8">Lazy Labs</b> — Engenharia de IA &amp; Automação<br>'
    +'<a href="https://example.com" style="color:#00f0ff;text-decoration:none">example.com</a> &nbsp;·&nbsp; <a href="https://blog.example.com" style="color:#00f0ff;text-decoration:none">blog.example.com</a>'
    +'</td></tr></table></td></tr></table></body></html>';
}
async function formResendSend(e, to, subject, html, lead){
  try {
    const from = e.fromEmail ? ((e.fromName||'Lazy Labs')+' <'+e.fromEmail+'>') : 'Lazy Labs <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:'Bearer '+e.resendKey, 'Content-Type':'application/json' }, body:JSON.stringify({ from:from, to:[to], subject:subject, html:html }) });
    const txt = await r.text(); await formLog(lead.leadId,'email', r.status<300?'SUCCESS':'ERROR', 'para '+formMaskEmail(to)+' HTTP '+r.status, txt);
  } catch(err){ await formLog(lead.leadId,'email','ERROR',err.message,''); }
}
async function formSendAdminEmail(c, lead){
  const e=c.email||{}; if(!e.enabled||!e.resendKey||!e.adminTo) return;
  const ans=lead.answers||{};
  const rows=Object.keys(ans).filter(function(k){return k!=='name'&&k!=='phone'&&k!=='email';}).map(function(k){ return '<tr><td style="padding:5px 14px 5px 0;color:#8a8aae;font-family:Arial">'+formEsc(k)+'</td><td style="padding:5px 0;color:#eef0fb;font-family:Arial">'+formEsc(ans[k])+'</td></tr>'; }).join('');
  const body='<b style="color:#fff">'+formEsc(lead.nome)+'</b> acabou de enviar o diagnóstico.<br><br>'
    +'<b style="color:#fff">WhatsApp:</b> '+formEsc(lead.telefone)+'<br><b style="color:#fff">E-mail:</b> '+formEsc(lead.email)+'<br><br>'
    +'<table cellpadding="0" cellspacing="0" style="font-size:13.5px">'+rows+'</table>';
  await formResendSend(e, e.adminTo, '🔥 Novo lead — '+(lead.nome||'Diagnóstico'), buildFormEmail({ heading:'Novo lead recebido', body:body, ctaUrl: lead.telefone?('https://wa.me/'+String(lead.telefone).replace(/\D/g,'')):'', ctaText:'Falar com o lead' }), lead);
}
async function formSendLeadConfirm(c, lead){
  const e=c.email||{}; if(!e.enabled||!e.confirmLead||!e.resendKey||!lead.email) return;
  const fn=(String(lead.nome||'').trim().split(/\s+/)[0])||'';
  const num=String((c.whatsapp&&c.whatsapp.number)||'').replace(/\D/g,'');
  const wa=num?('https://wa.me/'+num+'?text='+encodeURIComponent('Olá! Acabei de preencher o diagnóstico da Lazy Labs.')):'';
  const body='Recebemos suas respostas com sucesso. 🎉<br><br>A equipe da Lazy Labs vão analisar seu caso e entrar em contato em breve para o seu <b style="color:#fff">diagnóstico gratuito</b> de IA &amp; automação.<br><br>Quer adiantar? Fale com a gente agora no WhatsApp 👇';
  await formResendSend(e, lead.email, 'Recebemos seu diagnóstico — Lazy Labs', buildFormEmail({ heading:'Obrigado'+(fn?', '+formEsc(fn):'')+'! 👋', body:body, ctaUrl:wa, ctaText:'Falar no WhatsApp' }), lead);
}
const _formRL = {};  // rate limit em memória (por instância)
function formRate(key, max, windowMs){ const now=Date.now(), e=_formRL[key]; if(!e||now>e.exp){ _formRL[key]={n:1,exp:now+windowMs}; return true; } if(e.n>=max) return false; e.n++; return true; }

// ── espelho na Planilha (reutiliza bioSheetsClient) ──
const FORM_LEADS_TAB = 'Form_Leads', FORM_TRACK_TAB = 'Form_Tracking';
const FORM_LEADS_HEADERS = ['lead_id','session_id','nome','telefone','email','status','respostas','utm_source','utm_campaign','fbclid','device','landing_url','criado_em'];
const FORM_TRACK_HEADERS = ['session_id','primeiro_acesso','status_funil','progresso','page_view_at','form_started_at','contato_nome_at','contato_tel_at','contato_email_at','lead_parcial_at','form_completo_at','exit_intent_at','abandono_at','nome','telefone','email','respostas','utm_source','utm_campaign','fbclid','device','referrer','landing_url','user_agent','last_updated_at'];
let _formTabReady = {};
async function formEnsureTab(sheets, tab, headers){
  if(_formTabReady[tab]) return _formTabReady[tab];
  _formTabReady[tab] = (async function(){
    const meta = await sheets.spreadsheets.get({ spreadsheetId: BIO_SHEET_ID });
    const has = (meta.data.sheets||[]).some(function(s){ return s.properties.title===tab; });
    if(!has){
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody:{ requests:[{ addSheet:{ properties:{ title:tab } } }] } });
      await sheets.spreadsheets.values.update({ spreadsheetId: BIO_SHEET_ID, range: tab+'!A1', valueInputOption:'RAW', requestBody:{ values:[headers] } });
    }
  })().catch(function(e){ _formTabReady[tab]=null; throw e; });
  return _formTabReady[tab];
}
async function formSheetUpsert(docPath, tab, headers, rowFn, rowKeyField){
  try {
    const sheets = await bioSheetsClient(); await formEnsureTab(sheets, tab, headers);
    const snap = await db().doc(docPath).get(); const data = snap.exists?snap.data():{};
    const row = rowFn(data);
    if (data[rowKeyField]) {
      await sheets.spreadsheets.values.update({ spreadsheetId: BIO_SHEET_ID, range: tab+'!A'+data[rowKeyField], valueInputOption:'RAW', requestBody:{ values:[row] } });
    } else {
      const ap = await sheets.spreadsheets.values.append({ spreadsheetId: BIO_SHEET_ID, range: tab+'!A1', valueInputOption:'RAW', insertDataOption:'INSERT_ROWS', requestBody:{ values:[row] } });
      const m = /![A-Z]+(\d+)/.exec((ap.data.updates && ap.data.updates.updatedRange)||'');
      if (m) { const u={}; u[rowKeyField]=parseInt(m[1],10); await db().doc(docPath).set(u, { merge:true }); }
    }
  } catch(e){ console.error('[form sheet]', tab, e.message); }
}

// ── CAPI (server-side, dedup por event_id) ──
async function formSendCAPI(c, eventName, p, lead){
  const m = c.meta||{}; if(!m.capiEnabled || !m.capiToken || !m.pixelId) return;
  try {
    const ud = {};
    if(lead.email) ud.em=[formSha256(String(lead.email).trim().toLowerCase())];
    if(lead.telefone) ud.ph=[formSha256(String(lead.telefone).replace(/[^0-9]/g,''))];
    if(p.fbp) ud.fbp=p.fbp;
    if(p.fbc) ud.fbc=p.fbc; else if(p.fbclid) ud.fbc='fb.1.'+Date.now()+'.'+p.fbclid;
    if(p.userAgent) ud.client_user_agent=p.userAgent;
    const body = { data:[{ event_name:eventName, event_time:Math.floor(Date.now()/1000), event_id:p.eventId||('lead-'+Date.now()),
      action_source:'website', event_source_url:p.landingUrl||'', user_data:ud, custom_data:{ campaign:(p.utm&&p.utm.utm_campaign)||'' } }] };
    if(m.testEventCode) body.test_event_code=m.testEventCode;
    const r = await fetch('https://graph.facebook.com/v26.0/'+m.pixelId+'/events?access_token='+encodeURIComponent(m.capiToken),
      { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const txt = await r.text();
    await formLog(lead.leadId, 'capi', r.status<300?'SUCCESS':'ERROR', eventName+' HTTP '+r.status, txt);
  } catch(e){ await formLog(lead.leadId,'capi','ERROR',e.message,''); }
}
async function formSendWhatsAppCloud(c, lead){
  const w=c.whatsappCloud||{}; if(!w.enabled||!w.phoneId||!w.token||!w.template) return;
  const to=String(lead.telefone||'').replace(/[^0-9]/g,''); if(!to) return;
  const fn=(String(lead.nome||'').trim().split(/\s+/)[0])||'tudo bem';
  const tpl={ name:w.template, language:{ code:w.langCode||'pt_BR' } };
  if(w.nameVar!==false) tpl.components=[{ type:'body', parameters:[{ type:'text', text:fn }] }];
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/'+w.phoneId+'/messages', { method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+w.token }, body:JSON.stringify({ messaging_product:'whatsapp', to, type:'template', template:tpl }) });
    const txt=await r.text(); await formLog(lead.leadId,'whatsapp', r.status<300?'SUCCESS':'ERROR', 'HTTP '+r.status+' → '+formMaskPhone(to), txt);
  } catch(e){ await formLog(lead.leadId,'whatsapp','ERROR',e.message,''); }
}
async function formSendTelegram(c, lead){
  const t=c.telegram||{}; if(!t.enabled||!t.token||!t.chatId) return;
  const msg='🔥 <b>Novo lead — Diagnóstico</b>\n<b>Nome:</b> '+(lead.nome||'')+'\n<b>WhatsApp:</b> '+formMaskPhone(lead.telefone)+'\n<b>Desafio:</b> '+((lead.answers&&lead.answers.desafio)||'-')+'\n<b>Faturamento:</b> '+((lead.answers&&lead.answers.faturamento)||'-');
  try { const r=await fetch('https://api.telegram.org/bot'+t.token+'/sendMessage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:t.chatId, text:msg, parse_mode:'HTML' }) });
    await formLog(lead.leadId,'telegram', r.status<300?'SUCCESS':'ERROR','HTTP '+r.status, await r.text()); } catch(e){ await formLog(lead.leadId,'telegram','ERROR',e.message,''); }
}
async function formLog(leadId, canal, status, detalhe, resp){
  try { await db().collection('form_logs').add({ lead_id:leadId||'', canal:canal, status:status, detalhe:String(detalhe||'').slice(0,400), resp:String(resp||'').slice(0,400), at:Date.now() }); } catch(e){}
}

exports.form = onRequest(
  { region:'southamerica-east1', memory:'256MiB', timeoutSeconds:30 },
  async function(req, res){
    const _o = req.headers.origin || '*';
    res.set('Access-Control-Allow-Origin', _o); res.set('Vary','Origin'); res.set('Access-Control-Allow-Credentials','true');
    res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS'); res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
    if(req.method==='OPTIONS'){ res.status(204).send(''); return; }
    const action=(req.path||'').replace(/\/+$/,'').split('/').pop();
    function bodyOf(){ try { return req.rawBody?JSON.parse(req.rawBody.toString('utf8')):(req.body||{}); } catch(_){ return {}; } }
    try {
      if (!['config', 'track', 'lead', 'tracking', 'event', 'siteLead'].includes(action)) {
        const user = await adminModule.requireAdmin_(req, res); if (!user) return;
      }
      if(action==='config'){ res.set('Cache-Control','no-cache'); liJson(res,200,{ ok:true, config: publicFormConfig(await getFormConfig()) }); return; }

      // Pixel e GTM do site institucional: cache curto na CDN para não pesar na abertura da página.
      if(action==='tracking'){
        res.set('Cache-Control','public, max-age=60, s-maxage=300');
        liJson(res,200,Object.assign({ ok:true }, siteTracking.publicTracking(await siteFormConfig()))); return;
      }

      if(action==='event'){
        if(req.method!=='POST'){ liJson(res,405,{ok:false}); return; }
        if(!siteTracking.allowedOrigin(req.headers.origin)){ liJson(res,403,{ok:false}); return; }
        const ip=siteTracking.clientIp(req);
        if(!formRate('sev:'+(ip||'sem-ip'),40,60000)){ liJson(res,200,{ok:true}); return; }
        const event=siteTracking.buildCapiEvent(bodyOf(),{ ip:ip, userAgent:req.headers['user-agent'] });
        try { await siteTracking.sendCapi((await siteFormConfig()).meta,event); }
        catch(e){ console.error('[site capi]',e.message); }
        liJson(res,200,{ok:true}); return;
      }

      // Qualificação do chat (home e /agendar): vira lead no painel e na planilha.
      if(action==='siteLead'){
        if(req.method!=='POST'){ liJson(res,405,{ok:false}); return; }
        if(!siteTracking.allowedOrigin(req.headers.origin)){ liJson(res,403,{ok:false}); return; }
        const p=bodyOf();
        if(formIsBot(p)){ liJson(res,200,{ok:true}); return; }
        const lead=siteTracking.normalizeSiteLead(p);
        if(!lead){ liJson(res,400,{ok:false}); return; }
        if(!formRate('sld:'+lead.sessionId,5,60000)){ liJson(res,200,{ok:true}); return; }
        const c=await getFormConfig();
        const ref=db().doc('form_leads/site_'+lead.sessionId); const snap=await ref.get();
        const leadId=(snap.exists&&snap.data().lead_id)||('LS'+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
        const rec={ lead_id:leadId, session_id:'site_'+lead.sessionId, nome:lead.source==='agendar'?'Chat /agendar':'Chat da home', telefone:'', email:'',
          status:lead.qualified?'Site qualificado':'Site desqualificado', motivo:formSanitize(lead.reason), answers_json:JSON.stringify(lead.answers),
          utm_source:formSanitize(lead.utmSource), utm_campaign:formSanitize(lead.utmCampaign), fbclid:formSanitize(lead.fbclid), device:'',
          landing_url:formSanitize(lead.landingUrl), parcial:false, criado_em:snap.exists?snap.data().criado_em:new Date().toISOString(), updated_at:Date.now() };
        if(snap.exists) rec.track_row=snap.data().track_row;
        await ref.set(rec,{merge:true});
        formSheetUpsert('form_leads/site_'+lead.sessionId, FORM_LEADS_TAB, FORM_LEADS_HEADERS, function(d){
          return [d.lead_id||leadId,d.session_id||'',d.nome||'',d.telefone||'',d.email||'',d.status||'',d.answers_json||'',d.utm_source||'',d.utm_campaign||'',d.fbclid||'',d.device||'',d.landing_url||'',d.criado_em||''];
        }, 'track_row');
        if(lead.qualified&&!snap.exists&&formRate('formAutoBudget',300,3600000)){
          const event=siteTracking.buildCapiEvent(Object.assign({},p,{event:'Lead',data:{content_name:lead.answers.desafio,content_category:lead.answers.segmento}}),{ ip:siteTracking.clientIp(req), userAgent:req.headers['user-agent'] });
          await Promise.all([ siteTracking.sendCapi(c.meta,event).catch(function(e){ console.error('[site lead capi]',e.message); }),
            formSendTelegram(c,{ leadId:leadId, nome:rec.nome, telefone:'', answers:lead.answers }) ]);
        }
        liJson(res,200,{ok:true}); return;
      }

      if(action==='save'){
        if(req.method!=='POST'){ liJson(res,405,{ok:false,error:'POST'}); return; }
        const b=bodyOf(); const inc=b.config||{}; const cur=await getFormConfig();
        if(inc.meta && inc.meta.capiToken==='••••••') inc.meta.capiToken=cur.meta.capiToken;
        if(inc.whatsappCloud && inc.whatsappCloud.token==='••••••') inc.whatsappCloud.token=cur.whatsappCloud.token;
        if(inc.telegram && inc.telegram.token==='••••••') inc.telegram.token=cur.telegram.token;
        if(inc.email && inc.email.resendKey==='••••••') inc.email.resendKey=cur.email.resendKey;
        await db().doc('config/form').set(formDeepMerge(cur, inc));
        liJson(res,200,{ ok:true }); return;
      }
      if(action==='adminConfig'){  // admin: config completa com tokens mascarados
        const c=await getFormConfig(); const masked=JSON.parse(JSON.stringify(c));
        if(masked.meta) masked.meta.capiToken=c.meta.capiToken?'••••••':'';
        if(masked.whatsappCloud) masked.whatsappCloud.token=c.whatsappCloud.token?'••••••':'';
        if(masked.telegram) masked.telegram.token=c.telegram.token?'••••••':'';
        if(masked.email) masked.email.resendKey=c.email.resendKey?'••••••':'';
        liJson(res,200,{ ok:true, config:masked }); return;
      }
      if(action==='logs'){
        const snap=await db().collection('form_logs').orderBy('at','desc').limit(60).get();
        const arr=[]; snap.forEach(function(d){ arr.push(d.data()); }); liJson(res,200,{ ok:true, logs:arr }); return;
      }
      if(action==='recent'){  // leads recentes + contadores (p/ painel do admin)
        const ls=await db().collection('form_leads').orderBy('updated_at','desc').limit(25).get();
        const leads=[]; let completos=0,parciais=0;
        ls.forEach(function(d){ const x=d.data(); if(x.status==='Completo')completos++; if(x.parcial)parciais++;
          leads.push({ nome:x.nome||'', telefone:formMaskPhone(x.telefone), status:x.status||'', desafio:(function(){try{return (JSON.parse(x.answers_json||'{}').desafio)||'';}catch(e){return'';}})(), criado:x.criado_em||'' }); });
        let pv=0; const ss=await db().collection('form_sessions').get(); ss.forEach(function(d){ if(d.data().page_view_at)pv++; });
        liJson(res,200,{ ok:true, total:ls.size, completos:completos, parciais:parciais, pageviews:pv, leads:leads }); return;
      }
      if(action==='tgChats'){  // descobre chat IDs do Telegram via getUpdates
        if(req.method!=='POST'){ liJson(res,405,{ok:false,error:'POST'}); return; }
        const b=bodyOf(); let token=String(b.token||'').trim();
        if(!token || token==='••••••'){ token=(await getFormConfig()).telegram.token; }
        if(!token){ liJson(res,200,{ok:false,error:'Informe o Bot Token primeiro'}); return; }
        const r=await fetch('https://api.telegram.org/bot'+token+'/getUpdates'); const j=await r.json();
        if(!j.ok){ liJson(res,200,{ok:false,error:(j.description||'Token inválido')}); return; }
        const seen={}, chats=[];
        (j.result||[]).forEach(function(u){ const m=u.message||u.channel_post||u.my_chat_member||u.edited_message; const ch=m&&m.chat; if(ch&&!seen[ch.id]){ seen[ch.id]=1; chats.push({ id:String(ch.id), title:ch.title||ch.first_name||ch.username||'(privado)', type:ch.type }); } });
        liJson(res,200,{ok:true,chats:chats,hint:chats.length?'':'Nenhuma mensagem recente. Mande uma mensagem no grupo (mencionando o bot) e tente de novo.'}); return;
      }

      if(action==='track'){
        if(req.method!=='POST'){ liJson(res,405,{ok:false,error:'POST'}); return; }
        const p=bodyOf();
        if(formIsBot(p)){ liJson(res,200,{ok:true}); return; }
        const sid=String(p.sessionId||'').slice(0,64).replace(/[^a-zA-Z0-9_-]/g,''); if(!sid){ liJson(res,400,{ok:false}); return; }
        if(!formRate('fev:'+sid,80,60000)){ liJson(res,200,{ok:true}); return; }
        const now=Date.now(), ev=String(p.event||''); const ref=db().doc('form_sessions/'+sid); const snap=await ref.get();
        const upd={ last_updated_at:now, status_funil:String(p.status||'').slice(0,40), progresso:Number(p.progress||0),
          nome:String((p.answers&&p.answers.name)||'').slice(0,80), telefone:String((p.answers&&p.answers.phone)||'').replace(/\D/g,'').slice(0,14),
          email:String((p.answers&&p.answers.email)||'').slice(0,120), answers_json:JSON.stringify(p.answers||{}).slice(0,3000),
          utm_source:String((p.utm&&p.utm.utm_source)||'').slice(0,120), utm_campaign:String((p.utm&&p.utm.utm_campaign)||'').slice(0,120),
          fbclid:String(p.fbclid||'').slice(0,200), device:String(p.device||'').slice(0,80), referrer:String(p.referrer||'').slice(0,300),
          landing_url:String(p.landingUrl||'').slice(0,300), user_agent:String(p.userAgent||'').slice(0,300) };
        if(!snap.exists) upd.primeiro_acesso=new Date().toISOString();
        const tsField = { page_view:'page_view_at', form_start:'form_started_at', form_complete:'form_completo_at',
          lead_partial:'lead_parcial_at', exit_intent:'exit_intent_at', form_abandoned:'abandono_at' }[ev];
        if(tsField) upd[tsField]=new Date().toISOString();
        if(ev==='answer'){ const q=String(p.question||''); if(q==='name')upd.contato_nome_at=new Date().toISOString(); else if(q==='phone')upd.contato_tel_at=new Date().toISOString(); else if(q==='email')upd.contato_email_at=new Date().toISOString(); }
        await ref.set(upd,{merge:true});
        formSheetUpsert('form_sessions/'+sid, FORM_TRACK_TAB, FORM_TRACK_HEADERS, function(d){
          return [sid,d.primeiro_acesso||'',d.status_funil||'',String(d.progresso||0),d.page_view_at||'',d.form_started_at||'',d.contato_nome_at||'',d.contato_tel_at||'',d.contato_email_at||'',d.lead_parcial_at||'',d.form_completo_at||'',d.exit_intent_at||'',d.abandono_at||'',d.nome||'',d.telefone||'',d.email||'',d.answers_json||'',d.utm_source||'',d.utm_campaign||'',d.fbclid||'',d.device||'',d.referrer||'',d.landing_url||'',d.user_agent||'',new Date(d.last_updated_at||now).toISOString()];
        }, 'track_row');
        liJson(res,200,{ok:true}); return;
      }

      if(action==='lead'){
        if(req.method!=='POST'){ liJson(res,405,{ok:false,error:'POST'}); return; }
        const p=bodyOf();
        if(formIsBot(p)){ liJson(res,200,{success:true}); return; }   // honeypot finge sucesso
        const sid=String(p.sessionId||'').slice(0,64).replace(/[^a-zA-Z0-9_-]/g,'')||'anon';
        if(!formRate('fld:'+sid,8,60000)){ liJson(res,200,{success:false,error:'Muitas tentativas. Aguarde.'}); return; }
        const c=await getFormConfig(); const answers=p.answers||{}, utm=p.utm||{};
        const nome=String(p.nome||answers.name||'').trim();
        const telefone=String(p.telefone||answers.phone||'').replace(/[^0-9]/g,'');
        const email=String(p.email||answers.email||'').trim();
        const parcial=!!p.partial;
        const inputOk=formValidName(nome)&&formValidPhone(telefone)&&formValidEmail(email);
        // dedup por sessão
        const ref=db().doc('form_leads/'+sid); const snap=await ref.get();
        const leadId=(snap.exists&&snap.data().lead_id)||('LF'+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
        const rec={ lead_id:leadId, session_id:sid, nome:formSanitize(nome), telefone:telefone, email:formSanitize(email),
          status: parcial?'Parcial':(inputOk?'Completo':'Inválido'), answers_json:JSON.stringify(answers).slice(0,3000),
          utm_source:formSanitize(utm.utm_source||''), utm_campaign:formSanitize(utm.utm_campaign||''), fbclid:formSanitize(p.fbclid||''),
          device:formSanitize(p.device||''), landing_url:formSanitize(p.landingUrl||''), parcial:parcial, criado_em: snap.exists?snap.data().criado_em:new Date().toISOString(), updated_at:Date.now() };
        if(snap.exists) rec.track_row=snap.data().track_row;  // preserva linha da planilha
        await ref.set(rec,{merge:true});
        formSheetUpsert('form_leads/'+sid, FORM_LEADS_TAB, FORM_LEADS_HEADERS, function(d){
          return [d.lead_id||leadId,sid,d.nome||'',d.telefone||'',d.email||'',d.status||'',d.answers_json||'',d.utm_source||'',d.utm_campaign||'',d.fbclid||'',d.device||'',d.landing_url||'',d.criado_em||''];
        }, 'track_row');
        // funil → CRM: ingesta o lead no Firestore do CRM (best-effort, nunca quebra a resposta)
        try { await require('./crm').ingestFormLead({ sid:sid, nome:nome, telefone:telefone, email:email, answers:answers, status:rec.status, criado_em:rec.criado_em }); } catch(e){ console.error('[form→crm]', e.message); }

        const num=String(c.whatsapp.number||'').replace(/\D/g,'');
        const redirect = num ? ('https://wa.me/'+num+'?text='+encodeURIComponent(String(c.whatsapp.text||'').replace(/\{\{\s*nome\s*\}\}/gi, nome||''))) : '';

        if(parcial){ liJson(res,200,{success:true,leadId,partial:true,redirect}); return; }
        if(!inputOk){ liJson(res,200,{success:true,leadId,redirect}); return; }  // inválido → sem automação

        const lead={ leadId, nome, telefone, email, answers, sessionId:sid };
        if(formRate('formAutoBudget',300,3600000)){  // teto global/h
          try { await Promise.all([ formSendCAPI(c,'Lead',p,lead), formSendWhatsAppCloud(c,lead), formSendTelegram(c,lead), formSendAdminEmail(c,lead), formSendLeadConfirm(c,lead) ]); }
          catch(e){ console.error('[form auto]', e.message); }   // automações NUNCA quebram a resposta/redirect
        }
        liJson(res,200,{success:true,leadId,redirect}); return;
      }
      liJson(res,404,{ok:false,error:'rota desconhecida: '+action});
    } catch(err){ console.error('[form]',action,err); liJson(res,500,{ok:false,error:err.message}); }
  }
);

// ── SPA HTML completo (para usuarios humanos) ─────────────────────────────────
function articleUrl(slug, language) {
  return BLOG_BASE_URL + (language === 'pt-BR' ? '' : '/' + language) + '/artigo/' + encodeURIComponent(slug);
}

function markdownUrl(slug, language) { return articleUrl(slug, language) + '.md'; }
function markdownAlternate(slug, language) {
  return '<link rel="alternate" type="text/markdown" title="Markdown" href="' + esc(markdownUrl(slug, language)) + '">';
}

function alternateLinks(slug, ready) {
  var langs = ['pt-BR'].concat((ready || []).filter(lang => translationModule.TARGETS.includes(lang)));
  return langs.map(lang => '<link rel="alternate" hreflang="' + lang + '" href="' + esc(articleUrl(slug, lang)) + '">').join('')
    + '<link rel="alternate" hreflang="x-default" href="' + esc(articleUrl(slug, 'pt-BR')) + '">';
}

function languageSwitcher(slug, current, ready) {
  var labels = { 'pt-BR': 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' };
  var langs = ['pt-BR'].concat((ready || []).filter(lang => translationModule.TARGETS.includes(lang)));
  if (langs.length < 2) return '';
  return '<nav class="ll-langs" aria-label="Idiomas do artigo"><span>Idioma / Language</span>'
    + langs.map(lang => '<a lang="' + lang + '" hreflang="' + lang + '" href="' + esc(articleUrl(slug, lang)) + '"'
      + (lang === current ? ' aria-current="page"' : '') + '>' + labels[lang] + '</a>').join('') + '</nav>';
}

var LANGUAGE_STYLES = '<style>.ll-langs{position:relative;z-index:20;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;padding:9px 15px;background:#080816;border-bottom:1px solid rgba(0,240,255,.16);font:12px system-ui,sans-serif}.ll-langs span{color:#9999b4;margin-right:6px}.ll-langs a{color:#c0c0d8;text-decoration:none;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:4px 9px}.ll-langs a:hover,.ll-langs a[aria-current]{color:#00f0ff;border-color:#00f0ff;background:rgba(0,240,255,.08)}</style>';

function buildSPAHTML(post, slug, author, ready, language) {
  language = language || 'pt-BR';
  var SPA_TEMPLATE = ARTICLE_TEMPLATE;

  // Injeta os dados do post no SPA para carregamento instantaneo
  var injection = '<style>.art-layout{position:relative;max-width:720px;margin:0 auto;padding:0 24px}.art-layout .art-body{min-width:0}.toc-wrap{position:sticky;top:80px;background:rgba(6,6,15,.7);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px;max-height:calc(100vh - 120px);overflow-y:auto}.toc-label{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#00f0ff;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.05)}.toc-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}.toc-list a{font-family:"Outfit",sans-serif;font-size:12px;line-height:1.4;color:#7a7a9a;text-decoration:none;padding:4px 8px;border-radius:4px;border-left:2px solid transparent;transition:all .2s;display:block}.toc-list a:hover{color:#00f0ff;background:rgba(0,240,255,.04)}.toc-list a.active{color:#00f0ff;background:rgba(0,240,255,.07);border-left-color:#00f0ff}.related-wrap{position:relative;z-index:1;max-width:720px;margin:0 auto 24px;padding:0 24px}.related-label{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#7a7a9a;display:flex;align-items:center;gap:10px;margin-bottom:16px}.related-label::after{content:" ";flex:1;height:1px;background:rgba(255,255,255,.05)}.related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}.related-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px 16px;text-decoration:none;color:#e8e8f5;transition:all .2s;display:flex;flex-direction:column;gap:8px}.related-card:hover{border-color:rgba(0,240,255,.3);background:rgba(0,240,255,.04);transform:translateY(-2px)}.related-cat{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#00f0ff}.related-title{font-family:"Outfit",sans-serif;font-size:14px;font-weight:600;line-height:1.35;letter-spacing:-.01em}.related-meta{font-family:"JetBrains Mono",monospace;font-size:9px;color:#7a7a9a;letter-spacing:.08em;text-transform:uppercase}</style><script>\nwindow.__POST__ = ' + JSON.stringify(post).replace(/</g, '\\u003c') + ';\nwindow.__ARTICLE_LANG__ = ' + JSON.stringify(language) + ';\nwindow.__ARTICLE_UI__ = ' + JSON.stringify(ARTICLE_LOCALES[language] || ARTICLE_LOCALES['pt-BR']).replace(/</g, '\\u003c') + ';\n</script>\n';

  // Markup do TOC/relacionados: precisa ir no <body>, nao no </head> — uma <div> dentro de
  // <head> e HTML invalido e o parser a realoca pro topo do <body>, duplicando #art-body e
  // fazendo o texto do artigo renderizar antes do hero/capa.
  var artLayoutMarkup = '<div id="art-layout-root"><div class="art-layout" id="art-layout"><article class="art-body" id="art-body"></article><aside class="toc-wrap" id="toc-wrap" style="display:none"><div class="toc-label">Sumario</div><ul class="toc-list" id="toc-list"></ul></aside></div><div class="related-wrap" id="related-wrap" style="display:none"><div class="related-label">Leia tambem</div><div class="related-grid" id="related-grid"></div></div></div>';
  artLayoutMarkup = artLayoutMarkup.replace('<div class="toc-label">Sumario</div>', '<div class="toc-label" data-i18n="toc">Sumário</div>').replace('<div class="related-label">Leia tambem</div>', '<div class="related-label" data-i18n="related">Leia também</div>');

  // Atualiza as meta tags do SPA com os dados reais do post
  var canonical = articleUrl(slug, language);
  var coverUrl  = shareImage(post);
  var title     = post.title || 'Lazy Labs Blog';
  var excerpt   = post.excerpt || '';

  var html = SPA_TEMPLATE
    .replace('<html lang="pt-BR">', '<html lang="' + language + '">')
    .replace('<meta name="description" content="">',
             '<meta name="description" content="' + esc(excerpt) + '">')
    .replace('<meta property="og:title" content="">',
             '<meta property="og:title" content="' + esc(title) + '">')
    .replace('<meta property="og:description" content="">',
             '<meta property="og:description" content="' + esc(excerpt) + '">')
    .replace('<meta property="og:image" content="">',
             '<meta property="og:image" content="' + esc(coverUrl) + '">')
    .replace('<meta property="og:url" content="">',
             '<meta property="og:url" content="' + esc(canonical) + '">')
    .replace('<link rel="canonical" href="">',
             '<link rel="canonical" href="' + esc(canonical) + '">')
    .replace('<title>Lazy Labs Blog</title>',
             '<title>' + esc(title) + ' — Lazy Labs Blog</title>')
    .replace('<article class="art-body" id="art-body"></article>', artLayoutMarkup)
    .replace('<div class="art-cta-wrap">', buildAuthorCardHTML(author, language) + '\n  <div class="art-cta-wrap">')
    .replace('</head>', alternateLinks(slug, ready) + markdownAlternate(slug, language) + LANGUAGE_STYLES + injection + '\n</head>')
    .replace('<body>', '<body>' + languageSwitcher(slug, language, ready));

  return html;
}

// Card "sobre o autor" — mesmo trecho usado no SSR e injetado no SPA_TEMPLATE.
// So renderiza se o autor existe e tem pelo menos o nome configurado.
async function localizeAuthor(author, language) {
  if (!author || language === 'pt-BR' || (!author.bio && !author.specialty)) return author;
  const source = [String(author.specialty || ''), String(author.bio || '')];
  const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const cached = author.profile_translations && author.profile_translations[language];
  if (cached && cached.source_hash === hash) return Object.assign({}, author, { specialty: cached.specialty, bio: cached.bio });
  try {
    const active = source.filter(Boolean);
    const translated = await translationModule.deepseekTranslateBatch(active, 'text/plain', language);
    if (translated.length !== active.length || translated.some(value => !value)) return author;
    const profile = { source_hash: hash, specialty: source[0] ? translated.shift() : '', bio: source[1] ? translated.shift() : '' };
    await db().doc('authors/' + author.id).set({ profile_translations: { [language]: profile } }, { merge: true });
    return Object.assign({}, author, profile);
  } catch (error) {
    console.error('[authors] profile translation:', error.message);
    return author;
  }
}

function youtubeId(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = parsed.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : (/^\/(?:embed|shorts|live)\/([^/]+)/.exec(parsed.pathname) || [])[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
  } catch (_) { return ''; }
}
function safeArticleHtml(html) {
  const $ = cheerio.load(String(html || ''), null, false);
  const allowed = new Set(['p','br','h1','h2','h3','h4','strong','b','em','i','u','s','ul','ol','li','blockquote','pre','code','hr','a','img','figure','figcaption','div','span','table','thead','tbody','tr','th','td','iframe']);
  $('*').each((_, node) => {
    const tag = node.name.toLowerCase();
    if (!allowed.has(tag)) { $(node).remove(); return; }
    if (tag === 'iframe') {
      const url = String(node.attribs.src || '');
      const embed = LazyMedia.video(url);
      if (!embed || !['youtube', 'vimeo', 'drive', 'instagram', 'tiktok'].includes(embed.provider) || embed.src !== url) { $(node).remove(); return; }
    }
    for (const key of Object.keys(node.attribs || {})) {
      const value = node.attribs[key];
      const keep = key === 'class' && /^[A-Za-z0-9 _-]{1,120}$/.test(value)
        || key === 'id' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
        || key === 'alt' || key === 'title' || key === 'loading' || key === 'data-gallery' || key === 'data-diagram' || key === 'translate'
        || key === 'href' && tag === 'a' && /^(https?:\/\/|mailto:|\/|#)/i.test(value)
        || key === 'src' && tag === 'img' && /^(https:\/\/|\/)/i.test(value)
        || key === 'src' && tag === 'iframe'
        || key === 'allowfullscreen' && tag === 'iframe';
      if (!keep) $(node).removeAttr(key);
    }
    if (tag === 'a') $(node).attr('rel', 'noopener noreferrer');
  });
  return $.root().html() || '';
}
function shareImage(post) {
  return post.cover_url || ((LazyMedia.video(post.video_url) || {}).thumbnail || '');
}

function buildAuthorCardHTML(author, language) {
  if (!author || !author.name) return '';
  language = language || 'pt-BR';
  var aboutLabel = { 'pt-BR': 'Sobre o autor', en: 'About the author', es: 'Sobre el autor', fr: "À propos de l’auteur", de: 'Über den Autor' }[language] || 'Sobre o autor';
  var displayName = author.nickname || author.name;
  var avatarHtml = author.photo_url
    ? '<img src="' + esc(author.photo_url) + '" alt="' + esc(displayName) + '" style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex-shrink:0">'
    : '<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,rgba(0,240,255,.15),rgba(168,85,247,.15));display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#00f0ff;flex-shrink:0">' + esc(displayName.slice(0, 1).toUpperCase()) + '</div>';
  var bioHtml = author.bio ? '<div style="font-size:13px;color:#9090b8;line-height:1.6;margin-top:6px">' + esc(author.bio.length > 160 ? author.bio.slice(0, 160) + '…' : author.bio) + '</div>' : '';
  return '<div style="max-width:720px;margin:40px auto;padding:0 24px">'
    + '<a href="' + BLOG_BASE_URL + '/autor/' + esc(author.id) + '" style="display:flex;gap:16px;align-items:flex-start;text-decoration:none;color:inherit;background:linear-gradient(135deg,rgba(0,240,255,.05),rgba(168,85,247,.04));border:1px solid rgba(0,240,255,.18);border-radius:14px;padding:20px 22px;box-shadow:0 0 24px rgba(0,240,255,.05)">'
    + avatarHtml
    + '<div><div style="font-family:monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#7a7a9a;margin-bottom:4px">' + aboutLabel + '</div>'
    + '<div style="font-size:15px;font-weight:700">' + esc(displayName) + '</div>'
    + (author.specialty ? '<div style="font-family:monospace;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#a855f7;margin-top:2px">' + esc(author.specialty) + '</div>' : '')
    + bioHtml
    + '</div></a></div>';
}

// ── SSR HTML simples (para bots e indexacao) ──────────────────────────────────
function buildSSRHTML(post, slug, author, language, ready) {
  language = language || 'pt-BR';
  var tags     = Array.isArray(post.tags) ? post.tags.join(', ') : (post.tags || '');
  var coverUrl = shareImage(post);
  var videoEmbed = LazyMedia.video(post.video_url);
  var canonical = articleUrl(slug, language);
  var pubDate  = post.published_at ? new Date(post.published_at).toISOString() : '';
  var title = post.seo_title || post.title;
  var description = post.seo_description || post.excerpt || '';
  var translatedNotice = {
    en: 'Automatically translated from Portuguese.',
    es: 'Traducción automática del portugués.',
    fr: 'Traduction automatique du portugais.',
    de: 'Automatisch aus dem Portugiesischen übersetzt.'
  }[language] || '';
  var sd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    'headline': post.title, 'description': description, 'abstract': post.excerpt,
    'keywords': Array.isArray(post.tags) ? post.tags : [], 'image': coverUrl,
    'author': post.author_id
      ? { '@type': 'Person', 'name': post.author_name || 'Equipe do Blog', 'url': BLOG_BASE_URL + '/autor/' + post.author_id }
      : { '@type': 'Person', 'name': post.author_name || 'Equipe do Blog' },
    'publisher': { '@type': 'Organization', 'name': 'Lazy Labs', 'url': 'https://blog.example.com' },
    'datePublished': pubDate,
    'inLanguage': language,
    'mainEntityOfPage': { '@type': 'WebPage', '@id': canonical }
  }).replace(/</g, '\\u003c');
  return '<!DOCTYPE html><html lang="' + language + '"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + ' — Lazy Labs Blog</title>'
    + '<meta name="description" content="' + esc(description) + '">'
    + '<link rel="canonical" href="' + esc(canonical) + '">'
    + markdownAlternate(slug, language)
    + alternateLinks(slug, ready)
    + '<meta property="og:type" content="article">'
    + '<meta property="og:site_name" content="Lazy Labs Blog">'
    + '<meta property="og:title" content="' + esc(post.title) + '">'
    + '<meta property="og:description" content="' + esc(post.excerpt || '') + '">'
    + '<meta property="og:image" content="' + esc(coverUrl) + '">'
    + '<meta property="og:url" content="' + esc(canonical) + '">'
    + '<link rel="alternate" type="application/rss+xml" title="Lazy Labs Blog" href="' + BLOG_BASE_URL + '/rss.xml">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:title" content="' + esc(post.title) + '">'
    + '<meta name="twitter:description" content="' + esc(post.excerpt || '') + '">'
    + '<meta name="twitter:image" content="' + esc(coverUrl) + '">'
    + '<script type="application/ld+json">' + sd + '</script>'
    + LANGUAGE_STYLES
    + '<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:32px 24px;background:#020208;color:#e8e8f5;line-height:1.7}'
    + 'h1{font-size:2rem;font-weight:800;margin-bottom:16px}h2{font-size:1.4rem;font-weight:700;margin:32px 0 12px;color:#00f0ff}'
    + 'p{margin-bottom:16px;color:#c0c0d8}a{color:#00f0ff}'
    + '.logo{font-family:monospace;font-size:.875rem;color:#7a7a9a;margin-bottom:40px;display:block}'
    + '.cat{background:rgba(0,240,255,.08);border:1px solid rgba(0,240,255,.2);color:#00f0ff;padding:3px 10px;border-radius:3px;font-size:.8rem;margin-bottom:16px;display:inline-block}'
    + '.meta{font-size:.875rem;color:#7a7a9a;margin-bottom:24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.meta .metric{display:inline-flex;align-items:center;gap:5px}.meta svg{width:15px;height:15px;fill:none;stroke:#00f0ff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}'
    + 'img{width:100%;border-radius:10px;margin-bottom:32px}'
    + '</style></head><body>'
    + languageSwitcher(slug, language, ready)
    + '<a class="logo" href="https://blog.example.com">blog.example.com</a>'
    + '<div class="cat">' + esc(post.category || '') + '</div>'
    + '<h1>' + esc(post.title) + '</h1>'
    + '<div class="meta">' + (post.author_id
        ? '<a href="' + esc(BLOG_BASE_URL + '/autor/' + post.author_id) + '" style="color:inherit;display:inline-flex;align-items:center;gap:7px">' + (post.author_photo_url ? '<img src="' + esc(post.author_photo_url) + '" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:50%;margin:0">' : '') + esc(post.author_name || 'Equipe do Blog') + '</a>'
        : esc(post.author_name || 'Equipe do Blog'))
    + (pubDate ? '<span class="metric"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></svg>' + (language === 'pt-BR' ? formatDate(pubDate) : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(pubDate))) + '</span>' : '')
    + '<span class="metric"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + (post.reading_time || 5) + ' min</span>'
    + '<span class="metric"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>' + (post.qualified_view_count || 0) + '</span>'
    + '<span class="metric"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11.5a8 8 0 0 1-8 8 8.2 8.2 0 0 1-3.8-.9L4 20l1.4-4.2A8 8 0 1 1 20 11.5Z"/></svg>' + (post.comment_count || 0) + '</span></div>'
    + (videoEmbed ? (videoEmbed.provider === 'file'
        ? '<video controls playsinline preload="metadata" src="' + esc(videoEmbed.src) + '" title="' + esc(post.title) + '" style="display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;margin:24px 0 32px"></video>'
        : '<div style="position:relative;padding-bottom:56.25%;margin:24px 0 32px"><iframe src="' + esc(videoEmbed.src) + '" title="' + esc(post.title) + '" allow="autoplay;encrypted-media;picture-in-picture;fullscreen" allowfullscreen style="position:absolute;width:100%;height:100%;border:0;border-radius:10px"></iframe></div>') : (post.cover_url ? '<img src="' + esc(post.cover_url) + '" alt="' + esc(post.title) + '">' : ''))
    + (translatedNotice ? '<p style="font-size:12px;color:#9999b4">' + esc(translatedNotice) + '</p>' : '')
    + '<p><strong>' + esc(post.excerpt || '') + '</strong></p>'
    + (post.content || '')
    + buildAuthorCardHTML(author, language)
    + (post.cta_label && post.cta_url ? '<p style="margin-top:36px"><a href="' + esc(post.cta_url) + '" rel="noopener" style="display:inline-block;background:#00f0ff;color:#020208;border-radius:8px;padding:10px 16px;text-decoration:none;font-weight:700">' + esc(post.cta_label) + '</a></p>' : '')
    + '</body></html>';
}

function buildNotFoundHTML(slug) {
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">'
    + '<title>Artigo nao encontrado — Lazy Labs</title>'
    + '<meta http-equiv="refresh" content="3;url=https://blog.example.com">'
    + '</head><body style="font-family:system-ui;text-align:center;padding:80px;background:#020208;color:#e8e8f5">'
    + '<h1>Artigo nao encontrado</h1><p>Redirecionando...</p>'
    + '<a href="https://blog.example.com" style="color:#00f0ff">blog.example.com</a></body></html>';
}

function formatDate(iso) {
  try {
    var d = new Date(iso);
    var m = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    return d.getDate() + ' de ' + m[d.getMonth()] + ' de ' + d.getFullYear();
  } catch(e) { return ''; }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// ═══════════════════════════════════════════════════════════════════════════════
//  CRM (Firestore) — /api/crm/**  (porte do blueprint crm-apps-script-builder p/ Firebase)
//  Roteador único + engine de CRUD + auth por sessão + white-label. Lógica em ./crm.js
// ═══════════════════════════════════════════════════════════════════════════════
const crmModule = require('./crm');
exports.crm = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  crmModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  POSTS — publicação de artigos no Supabase via Firebase (substitui Apps Script quebrado)
//  Rotas: POST /api/posts/publish {data} · POST /api/posts/setkey {serviceKey}
// ═══════════════════════════════════════════════════════════════════════════════
const postsModule = require('./posts');
exports.posts = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 300, maxInstances: 3 },
  postsModule.handler
);
exports.reader = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  require('./reader').handler
);
const productsModule = require('./products');
exports.products = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30, invoker: 'public' },
  productsModule.handler
);
exports.translationRetry = onSchedule(
  { schedule: 'every 30 minutes', region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 540 },
  postsModule.retryIncompleteTranslations
);
exports.translationTask = onTaskDispatched(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 540,
    retryConfig: { maxAttempts: 4, minBackoffSeconds: 20, maxBackoffSeconds: 600 },
    rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 2 } },
  postsModule.processTranslationTask
);

// ═══════════════════════════════════════════════════════════════════════════════
//  BLOGS — gestão de workspaces multi-blog (Fase A, 2026-07-30)
//  Rotas: GET /api/blogs/list · POST /api/blogs/{create,update,delete}
// ═══════════════════════════════════════════════════════════════════════════════
const blogsModule = require('./blogs');
exports.blogs = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  blogsModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTHORS — perfis de autor/blogger multi-autor (2026-09-12)
//  API:    POST /api/authors/{list,invite,regenerateToken,delete,getByToken,updateProfile}
//  Paginas: GET /autor/<id> (perfil publico) · GET /colaborar/<token> (auto-config)
// ═══════════════════════════════════════════════════════════════════════════════
const authorsModule = require('./authors');
exports.authors = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  authorsModule.handler
);
const authorPagesModule = require('./authorPages');
exports.autorpages = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 15 },
  authorPagesModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  SITEMAP — sitemap.xml dinamico (2026-07-30). Rota: GET /sitemap.xml (sem /api)
// ═══════════════════════════════════════════════════════════════════════════════
const sitemapModule = require('./sitemap');
exports.sitemap = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  sitemapModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  RSS — rss.xml dinamico (2026-09-12). Rota: GET /rss.xml (sem /api)
// ═══════════════════════════════════════════════════════════════════════════════
const rssModule = require('./rss');
exports.rss = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  rssModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TRANSCRIBE — Whisper (Groq) para o Davi Blogger (substitui Apps Script quebrado)
//  Rota: POST /api/transcribe { base64, mimeType } → { ok, transcript, duration }
// ═══════════════════════════════════════════════════════════════════════════════
const transcribeModule = require('./transcribe');
exports.transcribe = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 120 },
  transcribeModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP — Cloud API (Meta) para disparo de templates
//  Rotas: /api/whatsapp/{status,save,test,templates,send}
// ═══════════════════════════════════════════════════════════════════════════════
const whatsappModule = require('./whatsapp');
exports.whatsapp = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 120 },
  whatsappModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  DAVI — chat multi-provider (Groq/OpenAI/Anthropic/Gemini/DeepSeek)
//  Rota: POST /api/davi/chat { messages, provider, model, apiKey, systemPrompt }
// ═══════════════════════════════════════════════════════════════════════════════
const daviModule = require('./davi');
exports.davi = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 300, maxInstances: 10 },
  daviModule.handler
);

const socialModule = require('./social');
exports.social = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 120, invoker: 'public' },
  socialModule.handler
);

const metaAutomations = require('./meta-automations');
const metaAppSecret = defineSecret('META_APP_SECRET');
const metaWebhookVerifyToken = defineSecret('META_WEBHOOK_VERIFY_TOKEN');
const metaSystemUserToken = defineSecret('META_SYSTEM_USER_TOKEN');
const metaInstagramUserToken = defineSecret('META_INSTAGRAM_USER_TOKEN');
exports.metaWebhook = onRequest(
  { region:'southamerica-east1', memory:'256MiB', timeoutSeconds:60, invoker:'public', secrets:[metaAppSecret, metaWebhookVerifyToken] },
  metaAutomations.webhook
);
exports.metaAutomations = onRequest(
  { region:'southamerica-east1', memory:'256MiB', timeoutSeconds:60, invoker:'public', secrets:[metaSystemUserToken, metaInstagramUserToken] },
  metaAutomations.admin
);
exports.metaAutomationTask = onTaskDispatched(
  { region:'southamerica-east1', memory:'256MiB', timeoutSeconds:120,
    retryConfig:{ maxAttempts:5, minBackoffSeconds:10, maxBackoffSeconds:600 },
    rateLimits:{ maxConcurrentDispatches:2, maxDispatchesPerSecond:2 },
    secrets:[metaSystemUserToken, metaInstagramUserToken] },
  metaAutomations.processTask
);
exports.metaAutomationPoll = onSchedule(
  { schedule:'every 2 minutes', timeZone:'UTC', region:'southamerica-east1',
    memory:'256MiB', timeoutSeconds:300, secrets:[metaSystemUserToken] },
  metaAutomations.pollMeta
);

// ═══════════════════════════════════════════════════════════════════════════════
//  DAVI AGENT — chat com tools/ações estilo GPT (lista_posts, criar_rascunho,
//  publicar, disparar_whatsapp, transcrever_audio, etc.)
//  Rota: POST /api/davi/agent { message, history } — header X-LL-Admin: 1 obrigatório
// ═══════════════════════════════════════════════════════════════════════════════
const agentModule = require('./agent');
exports.agent = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 120 },
  agentModule.handler
);

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — porta do Apps Script legado (que esta morto). Login + reset de senha
//  em Firebase. Senha hasheada + salt no Firestore (config/admin).
//  Rotas: /api/admin/login, /api/admin/reset, /api/admin/verify, /api/admin/setnew
// ═══════════════════════════════════════════════════════════════════════════════
const adminModule = require('./admin');
exports.admin = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 30 },
  adminModule.handler
);

// ── DEVOPS: notificação de deploy/implementação (Telegram + e-mail) ────────────
// Chamada pelo ritual de deploy (local, via curl) após cada implementação.
// Secret + credenciais Telegram vêm de functions/.env (DEVOPS_*, nunca commitado).
// O Resend é reaproveitado de config/form.email (já existe, servidor nunca expõe a key).
exports.devops = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 20 },
  async function(req, res) {
    var action = (req.path || '').replace(/\/+$/, '').split('/').pop();
    if (req.method !== 'POST' || action !== 'notify') {
      res.status(404).json({ ok: false, error: 'rota desconhecida' });
      return;
    }
    function bodyOf(){ try { return req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body||{}); } catch(_){ return {}; } }
    var body = bodyOf();
    if (!process.env.DEVOPS_NOTIFY_SECRET || body.secret !== process.env.DEVOPS_NOTIFY_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    var project = String(body.project || 'lazylabs.com').slice(0, 60);
    var summary = String(body.summary || '').slice(0, 4000);
    var changes = Array.isArray(body.changes) ? body.changes.slice(0, 30).map(function(c){ return String(c).slice(0,200); }) : [];
    var results = { telegram: false, email: false };

    var tgToken = process.env.DEVOPS_TELEGRAM_TOKEN, tgChat = process.env.DEVOPS_TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      try {
        var lines = changes.map(function(c){ return '• ' + esc(c); }).join('\n');
        var msg = '🚀 <b>Deploy — ' + esc(project) + '</b>\n' + esc(summary) + (lines ? '\n\n' + lines : '');
        var tr = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChat, text: msg, parse_mode: 'HTML' })
        });
        results.telegram = tr.ok;
      } catch (e) { console.error('[devops][telegram]', e.message); }
    }

    try {
      var fc = await getFormConfig();
      var e = fc.email || {};
      var to = process.env.DEVOPS_NOTIFY_EMAIL;
      if (e.resendKey && to) {
        var itemsHtml = changes.map(function(c){ return '<li style="margin-bottom:6px">' + esc(c) + '</li>'; }).join('');
        var html = '<div style="font-family:Arial,sans-serif;background:#04040c;color:#e8e8f5;padding:24px">'
          + '<h2 style="color:#00f0ff">Deploy — ' + esc(project) + '</h2>'
          + '<p>' + esc(summary) + '</p>'
          + (itemsHtml ? '<ul>' + itemsHtml + '</ul>' : '')
          + '</div>';
        var from = e.fromEmail ? ((e.fromName || 'Lazy Labs') + ' <' + e.fromEmail + '>') : 'Lazy Labs <onboarding@resend.dev>';
        var er = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: 'Bearer ' + e.resendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: from, to: [to], subject: '🚀 Deploy — ' + project, html: html })
        });
        results.email = er.ok;
      }
    } catch (e) { console.error('[devops][email]', e.message); }

    res.status(200).json({ ok: true, results: results });
  }
);

// ── MIGRAÇÃO: copia posts/comentários/inscritos do Supabase pro Firestore ──────
// NÃO apaga nada no Supabase (só lê). Idempotente: usa slug/hash do e-mail como
// doc id, então rodar de novo só atualiza com o estado mais recente. Protegida
// por secret (.env), rodada manualmente 1x via curl.
exports.migrate = onRequest(
  { region: 'southamerica-east1', memory: '256MiB', timeoutSeconds: 300 },
  async function (req, res) {
    if (req.method === 'GET') {
      if (!process.env.MIGRATE_SECRET || req.query.secret !== process.env.MIGRATE_SECRET) { res.status(401).json({ ok: false, message: 'unauthorized' }); return; }
      var peekSlug = req.query.slug;
      if (!peekSlug) {
        var subsSnap = await db().collection('newsletter_subscribers').limit(1).get();
        var postsSnap = await db().collection('posts').limit(3).get();
        var out = { subscriber_sample: subsSnap.empty ? null : subsSnap.docs[0].data(), post_ids: [] };
        postsSnap.forEach(function (d) { out.post_ids.push(d.id); });
        res.status(200).json({ ok: true, peek: out }); return;
      }
      var pdoc = await db().doc('posts/' + peekSlug).get();
      var cdocs = await db().collection('posts/' + peekSlug + '/comments').get();
      var comments = []; cdocs.forEach(function (d) { comments.push(Object.assign({ id: d.id }, d.data())); });
      res.status(200).json({ ok: true, post: pdoc.exists ? pdoc.data() : null, comments: comments }); return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'Use POST.' }); return; }
    var body = {}; try { body = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : (req.body || {}); } catch (e) {}
    if (!process.env.MIGRATE_SECRET || body.secret !== process.env.MIGRATE_SECRET) {
      res.status(401).json({ ok: false, message: 'unauthorized' }); return;
    }

    var scfg = await db().doc('config/supabase').get();
    var svc = (scfg.exists && scfg.data().serviceKey) || '';
    if (!svc) { res.status(200).json({ ok: false, message: 'Supabase serviceKey não configurada.' }); return; }

    var blogId = String(body.blogId || 'your-blog');
    var report = { blogId: blogId, posts: 0, comments: 0, subscribers: 0, errors: [] };

    try {
      var blogRef = db().doc('blogs/' + blogId);
      var blogSnap = await blogRef.get();
      if (!blogSnap.exists) {
        await blogRef.set({
          name: 'Lazy Labs Blog', domain: 'blog.example.com', logo_url: '',
          theme: { primary: '#00f0ff', secondary: '#a855f7', bg: '#020208', fg: '#e8e8f5' },
          seo: {}, settings: { timezone: 'America/Sao_Paulo', default_lang: 'pt-BR' },
          status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
      }

      var pr = await fetch(SUPABASE_URL + '/rest/v1/posts?select=*', { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
      if (!pr.ok) throw new Error('Supabase posts HTTP ' + pr.status);
      var posts = await pr.json();

      var batch = db().batch(); var opCount = 0;
      async function flushIfFull() { if (opCount >= 400) { await batch.commit(); batch = db().batch(); opCount = 0; } }

      for (var i = 0; i < posts.length; i++) {
        var p = posts[i];
        if (!p.slug) { report.errors.push('post sem slug: id=' + p.id); continue; }
        var ref = db().doc('posts/' + p.slug);
        batch.set(ref, {
          legacy_supabase_id: p.id, blog_id: blogId,
          title: p.title || '', slug: p.slug, excerpt: p.excerpt || '', content: p.content || '',
          category: p.category || '', tags: p.tags || [], cover_url: p.cover_url || '',
          author_name: p.author_name || 'Equipe do Blog', reading_time: p.reading_time || 5,
          status: p.status || 'draft', audio_url: p.audio_url || '', video_url: p.video_url || '',
          featured: !!p.featured, dispatch_newsletter: !!p.dispatch_newsletter,
          view_count: p.view_count || 0, like_count: p.like_count || 0,
          seo_title: p.seo_title || '', seo_description: p.seo_description || '',
          cta_label: p.cta_label || 'Quero algo parecido', cta_url: p.cta_url || 'https://example.com/form-diagnostico',
          published_at: p.published_at || null, scheduled_at: p.scheduled_at || null,
          created_at: p.created_at || new Date().toISOString(), updated_at: p.updated_at || new Date().toISOString()
        }, { merge: true });
        opCount++; report.posts++;
        await flushIfFull();

        var cr = await fetch(SUPABASE_URL + '/rest/v1/post_comments?post_slug=eq.' + encodeURIComponent(p.slug) + '&select=*', { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
        if (cr.ok) {
          var comments = await cr.json();
          for (var j = 0; j < comments.length; j++) {
            var c = comments[j];
            var cid = c.id || db().collection('_tmp').doc().id;
            var cref = db().doc('posts/' + p.slug + '/comments/' + cid);
            batch.set(cref, {
              legacy_supabase_id: c.id || null, mode: c.mode || 'anonymous', nickname: c.nickname || '',
              name: c.name || '', email: c.email || '', message: c.message || '', status: c.status || 'approved',
              created_at: c.created_at || new Date().toISOString(), updated_at: c.updated_at || new Date().toISOString()
            }, { merge: true });
            opCount++; report.comments++;
            await flushIfFull();
          }
        }
      }
      if (opCount > 0) await batch.commit();

      var sr = await fetch(SUPABASE_URL + '/rest/v1/newsletter_subscribers?select=*', { headers: { apikey: svc, Authorization: 'Bearer ' + svc } });
      if (!sr.ok) throw new Error('Supabase newsletter_subscribers HTTP ' + sr.status);
      var subs = await sr.json();
      var sbatch = db().batch(); var sOp = 0;
      for (var k = 0; k < subs.length; k++) {
        var s = subs[k];
        if (!s.email) continue;
        var sid = crypto.createHash('sha256').update(String(s.email).toLowerCase()).digest('hex');
        var sref = db().doc('newsletter_subscribers/' + sid);
        sbatch.set(sref, {
          blog_id: blogId, email: s.email, first_name: s.first_name || '', last_name: s.last_name || '',
          nickname: s.nickname || '', source: s.source || '', consent: !!s.consent, status: s.status || 'active',
          subscribed_at: s.subscribed_at || new Date().toISOString(), updated_at: s.updated_at || new Date().toISOString(),
          ip_hash: s.ip_hash || ''
        }, { merge: true });
        sOp++; report.subscribers++;
        if (sOp >= 400) { await sbatch.commit(); sbatch = db().batch(); sOp = 0; }
      }
      if (sOp > 0) await sbatch.commit();

      res.status(200).json({ ok: true, report: report });
    } catch (err) {
      console.error('[migrate]', err);
      res.status(500).json({ ok: false, message: err.message, report: report });
    }
  }
);
