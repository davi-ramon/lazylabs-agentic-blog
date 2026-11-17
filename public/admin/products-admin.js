let productItems_ = [];
let productCurrentSlug_ = '';
let productStats_ = {};
function pv_(id) { return document.getElementById('product-' + id); }
function productMessage_(message, error) {
  const el = document.getElementById('product-admin-message');
  if (el) { el.textContent = message || ''; el.style.color = error ? '#ff6b9d' : '#00ff9d'; }
}
function productCoverPreview_() {
  const image = pv_('cover-preview'), url = pv_('cover').value.trim();
  image.hidden = !/^https:\/\//i.test(url);
  if (!image.hidden) image.src = url;
}
async function productUploadCover_(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024 || !['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) {
    productMessage_('Use PNG, JPEG, WebP ou GIF de até 8 MB.', true); return;
  }
  const saveButton = pv_('save'); saveButton.disabled = true;
  productMessage_('Enviando capa...', false);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não foi possível ler a imagem.')); reader.readAsDataURL(file);
    });
    const result = await fbFetch_('/api/posts/uploadImage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64: String(dataUrl).split(',')[1] }) });
    if (!result.ok || !result.url) throw new Error(result.message || 'Falha ao enviar a capa.');
    pv_('cover').value = result.url; productCoverPreview_(); productMessage_('Capa enviada.', false);
  } catch (error) { productMessage_(error.message, true); }
  finally { saveButton.disabled = false; }
}
function productSlug_(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}
function productNew_() {
  productCurrentSlug_ = '';
  for (const key of ['title','slug','subtitle','description','deliverables','category','tags','keywords','cover','video','checkout','price']) pv_(key).value = '';
  pv_('type').value = 'course'; pv_('status').value = 'draft'; pv_('language').value = 'pt-BR'; pv_('placement').value = 'inline';
  pv_('offer').checked = true; pv_('slug').disabled = false;
  pv_('cover-file').value = ''; productCoverPreview_();
  document.getElementById('product-page-link').hidden = true;
  productMessage_('Novo produto. Preencha os campos e salve.', false);
  pv_('title').focus();
}
function productFill_(product) {
  productCurrentSlug_ = product.slug;
  pv_('title').value = product.title || ''; pv_('slug').value = product.slug || ''; pv_('slug').disabled = true;
  for (const key of ['subtitle','description','category']) pv_(key).value = product[key] || '';
  for (const key of ['deliverables','tags','keywords']) pv_(key).value = (product[key] || []).join(key === 'deliverables' ? '\n' : ', ');
  pv_('cover').value = product.cover_url || ''; pv_('video').value = product.video_url || '';
  pv_('checkout').value = product.checkout_url || ''; pv_('price').value = ((product.price_cents || 0) / 100).toFixed(2);
  pv_('cover-file').value = ''; productCoverPreview_();
  pv_('type').value = product.type || 'course'; pv_('status').value = product.status || 'draft';
  pv_('language').value = product.language || 'pt-BR'; pv_('placement').value = product.offer_placement || 'inline'; pv_('offer').checked = product.offer_enabled !== false;
  const link = document.getElementById('product-page-link');
  link.hidden = product.status !== 'published'; link.href = '/produto/' + encodeURIComponent(product.slug);
  productMessage_('Editando ' + product.title, false);
  document.getElementById('section-products').scrollIntoView({ behavior: 'smooth' });
}
function productRender_() {
  const root = document.getElementById('product-admin-list'); root.replaceChildren();
  if (!productItems_.length) { const p = document.createElement('p'); p.textContent = 'Nenhum produto cadastrado. Crie seu primeiro curso ou mentoria.'; root.append(p); return; }
  for (const product of productItems_) {
    const item = document.createElement('div'); item.className = 'product-admin-item';
    const name = document.createElement('strong'); name.textContent = product.title;
    const meta = document.createElement('small'); meta.textContent = (product.status === 'published' ? 'Publicado' : 'Rascunho') + ' · ' + (product.language || 'pt-BR') + ' · R$ ' + ((product.price_cents || 0) / 100).toFixed(2);
    const stats = productStats_[product.slug] || { impressions: 0, article_clicks: 0, checkout_clicks: 0 };
    const metric = document.createElement('small'); metric.className = 'product-admin-metrics';
    metric.textContent = 'Últimos 30 dias · ' + stats.impressions + ' visualizações · ' + stats.article_clicks + ' cliques na oferta · ' + stats.checkout_clicks + ' cliques no checkout';
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Editar'; edit.onclick = () => productFill_(product); buttons.append(edit);
    if (product.status === 'published') { const view = document.createElement('a'); view.href = '/produto/' + encodeURIComponent(product.slug); view.target = '_blank'; view.rel = 'noopener'; view.textContent = 'Ver página'; buttons.append(view); }
    const del = document.createElement('button'); del.type = 'button'; del.className = 'danger'; del.textContent = 'Excluir'; del.onclick = () => productDelete_(product); buttons.append(del);
    item.append(name, meta, metric, buttons); root.append(item);
  }
}
async function productLoad_() {
  const root = document.getElementById('product-admin-list');
  if (_currentBlogId !== 'your-blog') { root.textContent = 'O catálogo público está disponível no blog principal nesta fase.'; return; }
  root.textContent = 'Carregando produtos...';
  const result = await fbFetch_('/api/products/list?blog_id=your-blog');
  if (!result.ok) { root.textContent = result.message || 'Não foi possível carregar o catálogo.'; return; }
  productItems_ = result.products || []; productRender_();
  const stats = await fbFetch_('/api/products/stats');
  if (stats.ok) { productStats_ = stats.stats || {}; productRender_(); }
}
async function productPreview_() {
  const slug = productSlug_(pv_('match-slug').value);
  const output = pv_('preview-result');
  if (!slug) { output.textContent = 'Informe o slug do artigo.'; return; }
  output.textContent = 'Analisando artigo e catálogo...';
  try {
    const result = await fbFetch_('/api/products/preview?slug=' + encodeURIComponent(slug));
    if (!result.ok) throw new Error(result.message || 'Não foi possível testar a recomendação.');
    const matches = result.matches || [];
    output.textContent = matches.length
      ? 'Para “' + result.article_title + '”: ' + matches.map((item, index) => (index + 1) + '. ' + item.title + ' (' + item.score + ' pontos; ' + (item.placement === 'floating' ? 'janela' : 'entre parágrafos') + ')').join(' · ')
      : 'Nenhum produto publicado corresponde ao tema deste artigo. A página não mostrará oferta.';
  } catch (error) { output.textContent = error.message; }
}
async function productSave_() {
  if (_currentBlogId !== 'your-blog') { productMessage_('Selecione o blog principal para cadastrar produtos.', true); return; }
  const slug = productCurrentSlug_ || productSlug_(pv_('slug').value || pv_('title').value);
  const price = Number(String(pv_('price').value).replace(',', '.'));
  if (!slug || !pv_('price').value.trim() || !Number.isFinite(price) || price < 0) { productMessage_('Preencha slug e preço válidos.', true); return; }
  const list = key => pv_(key).value.split(key === 'deliverables' ? /\r?\n/ : ',').map(s => s.trim()).filter(Boolean);
  const data = { blog_id: 'your-blog', slug, title: pv_('title').value.trim(), subtitle: pv_('subtitle').value.trim(),
    description: pv_('description').value.trim(), type: pv_('type').value, language: pv_('language').value,
    category: pv_('category').value.trim(), tags: list('tags'), keywords: list('keywords'), deliverables: list('deliverables'),
    cover_url: pv_('cover').value.trim(), video_url: pv_('video').value.trim(), checkout_url: pv_('checkout').value.trim(),
    price_cents: Math.round(price * 100), status: pv_('status').value, offer_enabled: pv_('offer').checked,
    offer_placement: pv_('placement').value };
  const btn = pv_('save'); btn.disabled = true; productMessage_('Salvando...', false);
  try {
    const result = await fbFetch_('/api/products/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!result.ok) throw new Error(result.message || 'Falha ao salvar.');
    productCurrentSlug_ = slug; pv_('slug').value = slug; pv_('slug').disabled = true;
    const link = document.getElementById('product-page-link'); link.href = '/produto/' + encodeURIComponent(slug); link.hidden = data.status !== 'published';
    productMessage_('Produto salvo.', false); await productLoad_();
  } catch (error) { productMessage_(error.message, true); }
  finally { btn.disabled = false; }
}
async function productDelete_(product) {
  if (!confirm('Excluir ' + product.title + '? A página de venda deixará de existir.')) return;
  const result = await fbFetch_('/api/products/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blog_id: 'your-blog', slug: product.slug }) });
  if (!result.ok) { productMessage_(result.message || 'Falha ao excluir.', true); return; }
  if (productCurrentSlug_ === product.slug) productNew_();
  await productLoad_(); productMessage_('Produto excluído.', false);
}
document.addEventListener('DOMContentLoaded', function () {
  pv_('title')?.addEventListener('blur', function () { if (!productCurrentSlug_ && !pv_('slug').value) pv_('slug').value = productSlug_(this.value); });
  pv_('cover')?.addEventListener('input', productCoverPreview_);
  pv_('cover-file')?.addEventListener('change', function () { productUploadCover_(this.files[0]); });
});
