/**
 * Lazy Labs — páginas públicas de autor.
 * Rotas (via firebase.json, sem /api):
 *   GET /autor/<id>        → perfil público SSR (bio, foto, redes, artigos publicados)
 *   GET /colaborar/<token> → formulário privado onde o autor configura o próprio perfil
 */
const { getFirestore } = require('firebase-admin/firestore');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SITE_URL = 'https://blog.example.com';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
}

const BASE_STYLE = '*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}'
  + 'body{background:#020208;color:#e8e8f5;font-family:Outfit,system-ui,sans-serif;font-size:16px;line-height:1.7}'
  + 'a{color:#00f0ff}'
  + '.wrap{max-width:720px;margin:0 auto;padding:48px 24px}'
  + '.back{font-family:monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a7a9a;text-decoration:none;display:inline-block;margin-bottom:32px}'
  + '.back:hover{color:#00f0ff}';

const COOKIE_BANNER_HTML = '<div id="cookie-banner" style="display:none;position:fixed;left:16px;right:16px;bottom:16px;z-index:400;max-width:560px;margin:0 auto;background:rgba(6,6,15,.97);backdrop-filter:blur(16px);border:1px solid rgba(0,240,255,.18);border-radius:12px;padding:18px 20px;box-shadow:0 12px 32px rgba(0,0,0,.4)">'
  + '<p style="font-size:13px;color:#c0c0d8;line-height:1.6;margin-bottom:14px">Usamos cookies essenciais e de medição pra melhorar sua experiência. Ao continuar, você concorda com nossa <a href="https://example.com/politica-de-privacidade" target="_blank" style="color:#00f0ff">Política de Privacidade</a>.</p>'
  + '<div style="display:flex;gap:10px;justify-content:flex-end">'
  + '<button onclick="cookieConsent_(false)" style="font-family:monospace;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#7a7a9a;background:transparent;border:1px solid rgba(255,255,255,.1);padding:9px 16px;border-radius:4px;cursor:pointer">Só essenciais</button>'
  + '<button onclick="cookieConsent_(true)" style="font-family:monospace;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#020208;background:#00f0ff;border:none;padding:9px 16px;border-radius:4px;cursor:pointer">Entendi</button>'
  + '</div></div>'
  + '<script>'
  + 'try { if (!localStorage.getItem("ll_cookie_consent")) { document.getElementById("cookie-banner").style.display = "block"; } } catch (e) {}'
  + 'function cookieConsent_(acceptAll) { try { localStorage.setItem("ll_cookie_consent", acceptAll ? "all" : "essential"); } catch (e) {} var b = document.getElementById("cookie-banner"); if (b) b.style.display = "none"; }'
  + '</script>';

async function renderAuthorProfile_(req, res, authorId) {
  const snap = await db().doc('authors/' + authorId).get();
  if (!snap.exists) { res.status(404).send(buildNotFound_()); return; }
  const a = snap.data();
  const displayName = a.nickname || a.name || 'Autor';

  const postsSnap = await db().collection('posts').where('author_id', '==', authorId).get();
  const posts = [];
  postsSnap.forEach(function (d) {
    const p = d.data();
    if (p.status === 'published') posts.push(Object.assign({ slug: d.id }, p));
  });
  posts.sort(function (x, y) { return new Date(y.published_at || 0) - new Date(x.published_at || 0); });

  const socialLinks = [];
  const soc = a.social || {};
  if (soc.website) socialLinks.push('<a href="' + esc(soc.website) + '" target="_blank">Site</a>');
  if (soc.twitter) socialLinks.push('<a href="' + esc(soc.twitter) + '" target="_blank">X / Twitter</a>');
  if (soc.linkedin) socialLinks.push('<a href="' + esc(soc.linkedin) + '" target="_blank">LinkedIn</a>');
  if (soc.instagram) socialLinks.push('<a href="' + esc(soc.instagram) + '" target="_blank">Instagram</a>');
  if (soc.email) socialLinks.push('<a href="mailto:' + esc(soc.email) + '">E-mail</a>');

  const avatarHtml = a.photo_url
    ? '<img src="' + esc(a.photo_url) + '" alt="' + esc(displayName) + '" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid rgba(0,240,255,.25)">'
    : '<div style="width:96px;height:96px;border-radius:50%;background:linear-gradient(135deg,rgba(0,240,255,.15),rgba(168,85,247,.15));display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:800;color:#00f0ff">' + esc(displayName.slice(0, 1).toUpperCase()) + '</div>';

  const postsHtml = posts.length
    ? posts.map(function (p) {
        return '<a href="/artigo/' + esc(p.slug) + '" style="display:block;padding:16px 0;border-bottom:1px solid rgba(255,255,255,.06);text-decoration:none;color:inherit">'
          + '<div style="font-family:monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#00f0ff;margin-bottom:6px">' + esc(p.category || 'Artigo') + '</div>'
          + '<div style="font-weight:700;font-size:16px;margin-bottom:4px">' + esc(p.title || '') + '</div>'
          + '<div style="font-family:monospace;font-size:10px;color:#7a7a9a">' + fmtDate(p.published_at) + ' &middot; ' + (p.reading_time || 5) + ' min</div>'
          + '</a>';
      }).join('')
    : '<p style="color:#7a7a9a;font-size:14px">Nenhum artigo publicado ainda.</p>';

  const canonical = SITE_URL + '/autor/' + authorId;
  const html = '<!DOCTYPE html><html lang="pt-BR"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(displayName) + ' — Lazy Labs Blog</title>'
    + '<meta name="description" content="' + esc(a.bio || (displayName + ' — autor no Lazy Labs Blog.')) + '">'
    + '<link rel="canonical" href="' + esc(canonical) + '">'
    + '<meta property="og:type" content="profile">'
    + '<meta property="og:title" content="' + esc(displayName) + '">'
    + '<meta property="og:description" content="' + esc(a.bio || '') + '">'
    + (a.photo_url ? '<meta property="og:image" content="' + esc(a.photo_url) + '">' : '')
    + '<script type="application/ld+json">' + JSON.stringify({
        '@context': 'https://schema.org', '@type': 'ProfilePage',
        'mainEntity': { '@type': 'Person', 'name': displayName, 'description': a.bio || '', 'image': a.photo_url || undefined }
      }) + '</script>'
    + '<style>' + BASE_STYLE + '</style><link rel="stylesheet" href="/assets/button-depth.css?v=1"></head><body><div class="wrap">'
    + '<a class="back" href="' + SITE_URL + '">&larr; Todos os artigos</a>'
    + '<div style="display:flex;gap:20px;align-items:center;margin-bottom:20px">' + avatarHtml
    + '<div><h1 style="font-size:26px;font-weight:800;margin-bottom:4px">' + esc(displayName) + '</h1>'
    + (a.specialty ? '<div style="font-family:monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a855f7">' + esc(a.specialty) + '</div>' : '')
    + '</div></div>'
    + (a.bio ? '<p style="color:#c0c0d8;margin-bottom:20px">' + esc(a.bio) + '</p>' : '')
    + (socialLinks.length ? '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:36px;font-family:monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase">' + socialLinks.join('') + '</div>' : '<div style="margin-bottom:36px"></div>')
    + '<div style="font-family:monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#7a7a9a;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.05)">Artigos publicados (' + posts.length + ')</div>'
    + postsHtml
    + '</div>' + COOKIE_BANNER_HTML + '</body></html>';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).send(html);
}

function buildNotFound_() {
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Autor não encontrado — Lazy Labs Blog</title>'
    + '<style>' + BASE_STYLE + '</style><link rel="stylesheet" href="/assets/button-depth.css?v=1"></head><body><div class="wrap" style="text-align:center;padding-top:100px">'
    + '<h1 style="font-size:22px;margin-bottom:16px">Autor não encontrado</h1>'
    + '<a class="back" href="' + SITE_URL + '">&larr; Voltar pro blog</a></div></body></html>';
}

function renderConfigPage_(req, res, token) {
  const html = '<!DOCTYPE html><html lang="pt-BR"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>Configurar perfil de autor — Lazy Labs Blog</title>'
    + '<style>' + BASE_STYLE
    + '.field{margin-bottom:16px}label{display:block;font-family:monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#7a7a9a;margin-bottom:6px}'
    + 'input,textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:11px 14px;color:#e8e8f5;font-family:Outfit,sans-serif;font-size:14px;outline:none}'
    + 'input:focus,textarea:focus{border-color:rgba(0,240,255,.4)}'
    + 'input:disabled{opacity:.5}'
    + 'textarea{resize:vertical;min-height:90px}'
    + 'button{font-family:monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#020208;background:#00f0ff;border:none;padding:14px 28px;border-radius:4px;cursor:pointer;width:100%}'
    + 'button:disabled{opacity:.5;cursor:not-allowed}'
    + '#msg{padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:18px;display:none}'
    + '#msg.ok{display:block;background:rgba(0,255,157,.08);border:1px solid rgba(0,255,157,.25);color:#00ff9d}'
    + '#msg.err{display:block;background:rgba(255,0,110,.08);border:1px solid rgba(255,0,110,.25);color:#ff006e}'
    + '</style><link rel="stylesheet" href="/assets/button-depth.css?v=1"></head><body><div class="wrap" style="max-width:520px">'
    + '<h1 style="font-size:22px;font-weight:800;margin-bottom:8px">Configure seu perfil</h1>'
    + '<p style="color:#7a7a9a;font-size:13px;margin-bottom:28px">Isso aparece publicamente quando alguém clicar no seu nome nos artigos do Lazy Labs Blog. Deixe em branco o que não quiser compartilhar.</p>'
    + '<div id="msg"></div>'
    + '<div id="form-area">'
    + '<div class="field"><label>Nome<span style="color:#ff006e">*</span></label><input id="f-name" maxlength="120" placeholder="Seu nome completo"></div>'
    + '<div class="field"><label>Apelido público (opcional — se vazio, usa o nome)</label><input id="f-nickname" maxlength="80"></div>'
    + '<div class="field"><label>Especialidade</label><input id="f-specialty" maxlength="120" placeholder="Ex: Growth &amp; Performance"></div>'
    + '<div class="field"><label>Bio</label><textarea id="f-bio" maxlength="1000"></textarea></div>'
    + '<div class="field"><label>Foto (URL, opcional)</label><input id="f-photo" placeholder="https://..."></div>'
    + '<div class="field"><label>Site (opcional)</label><input id="f-website" placeholder="https://..."></div>'
    + '<div class="field"><label>X / Twitter (opcional)</label><input id="f-twitter" placeholder="https://x.com/..."></div>'
    + '<div class="field"><label>LinkedIn (opcional)</label><input id="f-linkedin" placeholder="https://linkedin.com/in/..."></div>'
    + '<div class="field"><label>Instagram (opcional)</label><input id="f-instagram" placeholder="https://instagram.com/..."></div>'
    + '<div class="field"><label>E-mail de contato publico (opcional)</label><input id="f-email" placeholder="voce@exemplo.com"></div>'
    + '<button id="btn-save" onclick="salvar()">Salvar perfil</button>'
    + '</div></div>'
    + '<script>'
    + 'const TOKEN = ' + JSON.stringify(token) + ';'
    + 'function msg(type, text) { const el = document.getElementById("msg"); el.className = type; el.textContent = text; }'
    + 'async function carregar() {'
    + '  try {'
    + '    const r = await fetch("/api/authors/getByToken", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });'
    + '    const d = await r.json();'
    + '    if (!d.ok) { document.getElementById("form-area").style.display = "none"; msg("err", d.message || "Link invalido."); return; }'
    + '    const a = d.author;'
    + '    document.getElementById("f-name").value = a.name || "";'
    + '    document.getElementById("f-nickname").value = a.nickname || "";'
    + '    document.getElementById("f-specialty").value = a.specialty || "";'
    + '    document.getElementById("f-bio").value = a.bio || "";'
    + '    document.getElementById("f-photo").value = a.photo_url || "";'
    + '    const s = a.social || {};'
    + '    document.getElementById("f-website").value = s.website || "";'
    + '    document.getElementById("f-twitter").value = s.twitter || "";'
    + '    document.getElementById("f-linkedin").value = s.linkedin || "";'
    + '    document.getElementById("f-instagram").value = s.instagram || "";'
    + '    document.getElementById("f-email").value = s.email || "";'
    + '  } catch (e) { msg("err", "Erro de conexao."); }'
    + '}'
    + 'async function salvar() {'
    + '  const nome = document.getElementById("f-name").value.trim();'
    + '  if (!nome) { msg("err", "Nome e obrigatorio."); document.getElementById("f-name").focus(); return; }'
    + '  const btn = document.getElementById("btn-save"); btn.disabled = true; btn.textContent = "Salvando...";'
    + '  try {'
    + '    const payload = { token: TOKEN, name: nome, nickname: document.getElementById("f-nickname").value.trim(), specialty: document.getElementById("f-specialty").value.trim(), bio: document.getElementById("f-bio").value.trim(), photo_url: document.getElementById("f-photo").value.trim(), social: { website: document.getElementById("f-website").value.trim(), twitter: document.getElementById("f-twitter").value.trim(), linkedin: document.getElementById("f-linkedin").value.trim(), instagram: document.getElementById("f-instagram").value.trim(), email: document.getElementById("f-email").value.trim() } };'
    + '    const r = await fetch("/api/authors/updateProfile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });'
    + '    const d = await r.json();'
    + '    btn.disabled = false; btn.textContent = "Salvar perfil";'
    + '    if (d.ok) { document.getElementById("form-area").style.display = "none"; msg("ok", "Perfil salvo! Pode fechar essa pagina. Se precisar editar de novo depois, peca um novo link ao administrador."); }'
    + '    else msg("err", d.message || "Erro ao salvar.");'
    + '  } catch (e) { btn.disabled = false; btn.textContent = "Salvar perfil"; msg("err", "Erro de conexao."); }'
    + '}'
    + 'carregar();'
    + '</script></body></html>';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.status(200).send(html);
}

async function handler(req, res) {
  const rawPath = req.path || '';
  try {
    if (rawPath.indexOf('/autor/') === 0) {
      const authorId = rawPath.replace(/^\/autor\//, '').replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0];
      if (!authorId) { res.redirect(301, SITE_URL); return; }
      await renderAuthorProfile_(req, res, authorId);
      return;
    }
    if (rawPath.indexOf('/colaborar/') === 0) {
      const token = rawPath.replace(/^\/colaborar\//, '').replace(/^\/+/, '').replace(/\/+$/, '').split('?')[0];
      if (!token) { res.redirect(301, SITE_URL); return; }
      renderConfigPage_(req, res, token);
      return;
    }
    res.status(404).send(buildNotFound_());
  } catch (err) {
    console.error('[authorPages]', err);
    res.status(500).send('<h1>Erro</h1><p>' + esc(err.message) + '</p>');
  }
}

module.exports = { handler: handler };
