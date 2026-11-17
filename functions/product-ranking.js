const { tokens } = require('./recommendations');

function terms(value) { return new Set(tokens(value)); }
function list(value) { return Array.isArray(value) ? value : []; }

function rankProducts(article, products, count = 1) {
  const category = terms(article.category);
  const tags = list(article.tags).map(value => terms(value));
  const title = terms(article.title);
  const excerpt = terms(article.excerpt);
  const body = terms(String(article.content || '').replace(/<[^>]+>/g, ' ').slice(0, 30000));
  const language = article.language || 'pt-BR';
  return list(products).filter(product => product && product.status === 'published' && product.offer_enabled !== false &&
    (product.language || 'pt-BR') === language && product.checkout_url).map(product => {
    const subjects = [...list(product.tags), ...list(product.keywords)].map(value => terms(value));
    const all = new Set([...subjects.flatMap(set => [...set]), ...terms(product.title), ...terms(product.subtitle)]);
    const productCategory = terms(product.category);
    const overlap = (a, b) => [...a].filter(word => b.has(word)).length;
    const tagMatches = tags.filter(tag => tag.size && [...tag].every(word => all.has(word))).length;
    const score = tagMatches * 10 + overlap(category, productCategory) * 5 +
      overlap(title, all) * 4 + overlap(excerpt, all) * 2 + overlap(body, all) * 0.5;
    return { product, score };
  }).filter(item => item.score >= 4)
    .sort((a, b) => b.score - a.score || String(a.product.slug).localeCompare(String(b.product.slug)))
    .slice(0, count).map(item => ({ ...item.product, match_score: item.score }));
}

module.exports = { rankProducts };
