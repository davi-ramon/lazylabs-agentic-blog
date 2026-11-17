/**
 * Lazy Labs — rss.xml dinamico (RSS 2.0), mesmo padrao do sitemap.js.
 * Endpoint: GET /rss.xml (rewrite em firebase.json, sem prefixo /api).
 */
const { getFirestore } = require('firebase-admin/firestore');
let _db = null;
function db() { if (!_db) _db = getFirestore(); return _db; }

const SITE_URL = 'https://blog.example.com';
const BLOG_ID = 'your-blog';
const MAX_ITEMS = 30;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cdata(s) {
  return '<![CDATA[' + String(s || '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}
function toRfc822(iso) {
  var d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.toUTCString();
}

async function handler(req, res) {
  try {
    var snap = await db().collection('posts')
      .where('blog_id', '==', BLOG_ID)
      .select('slug', 'status', 'title', 'excerpt', 'author_name', 'category', 'published_at', 'updated_at')
      .get();

    var posts = [];
    snap.forEach(function (d) {
      var p = d.data();
      if (!p.slug || p.status !== 'published') return;
      posts.push(p);
    });
    posts.sort(function (a, b) { return new Date(b.published_at || 0) - new Date(a.published_at || 0); });
    posts = posts.slice(0, MAX_ITEMS);

    var lastBuild = posts.length ? toRfc822(posts[0].published_at) : toRfc822();
    var items = posts.map(function (p) {
      var link = SITE_URL + '/artigo/' + encodeURIComponent(p.slug);
      return '  <item>\n'
        + '    <title>' + cdata(p.title) + '</title>\n'
        + '    <link>' + esc(link) + '</link>\n'
        + '    <guid isPermaLink="true">' + esc(link) + '</guid>\n'
        + '    <pubDate>' + toRfc822(p.published_at) + '</pubDate>\n'
        + (p.category ? '    <category>' + cdata(p.category) + '</category>\n' : '')
        + (p.author_name ? '    <dc:creator>' + cdata(p.author_name) + '</dc:creator>\n' : '')
        + '    <description>' + cdata(p.excerpt || '') + '</description>\n'
        + '  </item>';
    }).join('\n');

    var body = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">\n'
      + '<channel>\n'
      + '  <title>Lazy Labs Blog</title>\n'
      + '  <link>' + SITE_URL + '/</link>\n'
      + '  <atom:link href="' + SITE_URL + '/rss.xml" rel="self" type="application/rss+xml"/>\n'
      + '  <description>Cases reais, sistemas implementados e reflexoes sobre IA, automacao e desenvolvimento de software pela Lazy Labs.</description>\n'
      + '  <language>pt-BR</language>\n'
      + '  <lastBuildDate>' + lastBuild + '</lastBuildDate>\n'
      + items
      + '\n</channel>\n</rss>\n';

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=1800');
    res.status(200).send(body);
  } catch (err) {
    console.error('[rss]', err);
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Lazy Labs Blog</title><link>' + SITE_URL + '</link><description></description></channel></rss>\n');
  }
}

module.exports = { handler: handler };
