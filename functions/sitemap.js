/**
 * Lazy Labs — sitemap.xml dinamico do blog (Firestore posts, status=published).
 * Endpoint: GET /sitemap.xml (rewrite em firebase.json, sem prefixo /api).
 *
 * Escopado em blog_id='your-blog' (unico dominio real hoje). Quando outro
 * blog ganhar hosting proprio (Fase E do multi-blog), ele precisa do seu proprio
 * sitemap.xml na raiz do SEU dominio — nao da pra reaproveisar este.
 */
const { getFirestore } = require('firebase-admin/firestore');
const translations = require('./translations');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SITE_URL = 'https://blog.example.com';
const BLOG_ID = 'your-blog';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toLastmod(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function handler(req, res) {
  try {
    // So um equality filter (blog_id) — status filtrado em codigo de proposito:
    // combinar 2 equality + aggregate ja mordeu a gente com indice composto essa
    // sessao; com o volume atual de posts, filtrar em JS e mais simples e seguro.
    var snap = await db().collection('posts')
      .where('blog_id', '==', BLOG_ID)
      .select('slug', 'status', 'published_at', 'updated_at', 'translation_ready', 'translation_hash',
        'title', 'excerpt', 'seo_title', 'seo_description', 'category', 'cta_label', 'content', 'tags')
      .get();

    var urls = [
      { loc: SITE_URL + '/', lastmod: '', changefreq: 'daily', priority: '1.0' },
      { loc: SITE_URL + '/feed/', lastmod: '', changefreq: 'daily', priority: '0.8' }
    ];
    snap.forEach(function (d) {
      var p = d.data();
      if (!p.slug || p.status !== 'published') return;
      urls.push({
        loc: SITE_URL + '/artigo/' + encodeURIComponent(p.slug),
        lastmod: toLastmod(p.updated_at || p.published_at),
        changefreq: 'monthly',
        priority: '0.8'
      });
      if (p.translation_hash !== translations.sourceHash(p)) return;
      for (const lang of p.translation_ready || []) {
        if (!translations.TARGETS.includes(lang)) continue;
        urls.push({
          loc: SITE_URL + '/' + lang + '/artigo/' + encodeURIComponent(p.slug),
          lastmod: toLastmod(p.updated_at || p.published_at),
          changefreq: 'monthly',
          priority: '0.8'
        });
      }
    });
    var productsSnap = await db().collection('products').where('blog_id', '==', BLOG_ID)
      .select('slug', 'status', 'updated_at').limit(200).get();
    productsSnap.forEach(function (d) {
      var p = d.data();
      if (p.status !== 'published' || !p.slug) return;
      urls.push({ loc: SITE_URL + '/produto/' + encodeURIComponent(p.slug),
        lastmod: toLastmod(p.updated_at), changefreq: 'monthly', priority: '0.6' });
    });

    var body = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + urls.map(function (u) {
          return '  <url>\n'
            + '    <loc>' + esc(u.loc) + '</loc>\n'
            + (u.lastmod ? '    <lastmod>' + u.lastmod + '</lastmod>\n' : '')
            + '    <changefreq>' + u.changefreq + '</changefreq>\n'
            + '    <priority>' + u.priority + '</priority>\n'
            + '  </url>';
        }).join('\n')
      + '\n</urlset>\n';

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60, s-maxage=0');
    res.status(200).send(body);
  } catch (err) {
    console.error('[sitemap]', err);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.status(503).send('<?xml version="1.0" encoding="UTF-8"?>\n<error>Temporarily unavailable</error>\n');
  }
}

module.exports = { handler: handler };
