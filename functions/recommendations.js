// Deterministic recommendations from article metadata and source text.
// Runs on the published Portuguese source, so translations share the same ranking.
const STOP = new Set(('a ao aos as da das de do dos e em entre era esse essa isso este esta eu foi foram ha ja mais mas meu minha na nas no nos o os ou para pela pelo por porque que seu sua seus suas sem ser sobre um uma uns umas voce voces ' +
  'the and for with from this that have has was were are you your our their into over under article blog post new how why what when where who about after before ' +
  'el la los las del de en con por para que una uno un como mas ya su sus este esta se al es son ' +
  'le la les des du de et en avec pour sur une un est sont dans aux au ce cette ses son ' +
  'der die das den dem des und mit ein eine einer einem auf fur von zu im ist sind ich wir sie man').split(/\s+/));
const BRAND = new Set(['lazy', 'labs', 'lazylabs']);

function tokens(value) {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return (normalized.match(/[a-z0-9]{3,}/g) || []).filter(word => !STOP.has(word) && !BRAND.has(word) && !/^\d+$/.test(word));
}
function phrase(value) { return tokens(value).join(' '); }
function add(map, text, weight, maxWords) {
  for (const word of tokens(text).slice(0, maxWords)) map.set(word, (map.get(word) || 0) + weight);
}
function contentWords(html) {
  const counts = new Map();
  const plain = String(html || '').slice(0, 40000).replace(/<[^>]+>/g, ' ');
  for (const word of tokens(plain)) if (word.length >= 4) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 35);
}
function features(post, source) {
  const map = new Map();
  add(map, post.category, 5, 8);
  for (const tag of Array.isArray(post.tags) ? post.tags.slice(0, 20) : []) add(map, tag, 4, 8);
  add(map, post.title, 3, 32);
  add(map, post.excerpt, 1.2, 90);
  if (source) for (const [word, count] of contentWords(post.content)) map.set(word, (map.get(word) || 0) + Math.min(3, count * 0.35));
  return map;
}
function cosine(a, b, idf) {
  let dot = 0, left = 0, right = 0;
  for (const [word, weight] of a) {
    const x = weight * (idf.get(word) || 1); left += x * x;
    const y = b.get(word); if (y) dot += x * y * (idf.get(word) || 1);
  }
  for (const [word, weight] of b) { const y = weight * (idf.get(word) || 1); right += y * y; }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
function youtubeId(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      id = url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/embed/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
  } catch (_) { return ''; }
}
function thumbnail(post) {
  try { const url = new URL(String(post.cover_url || '')); if (url.protocol === 'https:') return url.toString(); } catch (_) {}
  const id = youtubeId(post.video_url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '/assets/related-fallback.svg';
}
function rankRelated(source, candidates, count = 3) {
  const pool = (candidates || []).filter(p => p && p.id !== source.id && p.status === 'published');
  if (!pool.length) return [];
  const sourceFeatures = features(source, true);
  const candidateFeatures = pool.map(p => features(p, false));
  const documents = [sourceFeatures, ...candidateFeatures], frequency = new Map();
  for (const document of documents) for (const word of document.keys()) frequency.set(word, (frequency.get(word) || 0) + 1);
  const idf = new Map([...frequency].map(([word, n]) => [word, 1 + Math.log((documents.length + 1) / (n + 1))]));
  const sourceTags = new Set((source.tags || []).map(phrase).filter(Boolean));
  const sourceCategory = phrase(source.category);
  return pool.map((post, index) => {
    const tagMatches = (post.tags || []).map(phrase).filter(tag => tag && sourceTags.has(tag)).length;
    const categoryMatch = sourceCategory && phrase(post.category) === sourceCategory ? 1 : 0;
    const textScore = cosine(sourceFeatures, candidateFeatures[index], idf);
    const published = Date.parse(post.published_at || '') || 0;
    const ageDays = Math.max(0, (Date.now() - published) / 86400000);
    const freshness = published ? 0.5 / (1 + ageDays / 90) : 0;
    return { post, score: tagMatches * 7 + categoryMatch * 3 + textScore * 24 + freshness };
  }).sort((a, b) => b.score - a.score || String(b.post.published_at || '').localeCompare(String(a.post.published_at || '')))
    .slice(0, Math.max(0, count)).map(({ post }) => ({ ...post, thumbnail_url: thumbnail(post) }));
}
module.exports = { rankRelated, thumbnail, youtubeId, tokens };
