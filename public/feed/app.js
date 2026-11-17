(function () {
  'use strict';
  const ranking = window.LazyFeedRanking;
  const state = { posts: [], topic: '', view: 'all', sort: 'for-you', query: '', visible: 6 };
  const commentCounts = new Map();
  let countObserver, searchTimer;
  const $ = id => document.getElementById(id);
  const slugOk = slug => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ''));
  const articleUrl = post => '/artigo/' + encodeURIComponent(post.slug);
  function trackArticleClick(post) {
    ranking.record(post, 1);
    try {
      if (localStorage.getItem('ll_cookie_consent') !== 'all') return;
      const body = new Blob([JSON.stringify({ slug:post.slug, kind:'feed' })], { type:'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/posts/engagementClick', body);
      else fetch('/api/posts/engagementClick', { method:'POST', body, keepalive:true });
    } catch (_) {}
  }
  const date = value => { try { return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)); } catch (_) { return ''; } };
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = String(content);
    return node;
  }
  function safeImage(url) {
    try { const parsed = new URL(url, location.origin); return parsed.protocol === 'https:' || parsed.origin === location.origin ? parsed.href : '/assets/related-fallback.svg'; }
    catch (_) { return '/assets/related-fallback.svg'; }
  }
  function cover(post) {
    const img = element('img'); img.src = safeImage(post.cover_url || '/assets/related-fallback.svg');
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.addEventListener('error', () => { if (!img.src.includes('related-fallback.svg')) img.src = '/assets/related-fallback.svg'; });
    return img;
  }
  function profileUI() {
    const enabled = ranking.load().enabled;
    $('personalization-title').textContent = enabled ? 'Feed personalizado neste navegador' : 'Seu feed pode aprender com você';
    $('personalization-description').textContent = enabled
      ? 'Tópicos e artigos são ordenados pelas suas leituras. Você pode desativar e limpar tudo quando quiser.'
      : 'Ative a personalização para ordenar artigos pelos temas que você lê. Os interesses ficam somente neste navegador.';
    $('personalization-action').textContent = enabled ? 'Desativar e limpar' : 'Ativar';
  }
  function sortedPosts() {
    let posts = state.sort === 'recent' || state.view === 'recent'
      ? state.posts.slice().sort((a, b) => (Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0))
      : ranking.rank(state.posts, ranking.load());
    if (state.topic) posts = posts.filter(post => [post.category, ...(post.tags || [])].some(label => ranking.tokens(label).join('-') === state.topic));
    if (state.query) {
      const words = ranking.tokens(state.query);
      posts = posts.filter(post => {
        const hay = ranking.tokens([post.title, post.excerpt, post.category, ...(post.tags || [])].join(' '));
        return words.length ? words.every(word => hay.some(term => term.includes(word))) : [post.title, post.excerpt].join(' ').toLowerCase().includes(state.query.toLowerCase());
      });
    }
    return posts;
  }
  function renderTopics() {
    const list = $('topic-list'); list.replaceChildren();
    const topics = ranking.topics(state.posts, ranking.load());
    for (const topic of topics) {
      const button = element('button', 'topic-link' + (state.topic === topic.key ? ' active' : ''));
      button.type = 'button'; button.title = topic.label;
      button.append(element('span', 'topic-symbol', '⌗'), element('span', 'topic-text', topic.label), element('span', 'topic-count', topic.count));
      button.addEventListener('click', () => {
        state.topic = state.topic === topic.key ? '' : topic.key; state.view = 'all'; state.visible = 6;
        if (state.topic) ranking.recordTopic(topic.label);
        refresh();
        if (matchMedia('(max-width:760px)').matches) $('sidebar').classList.remove('is-open');
      });
      list.append(button);
    }
    if (!topics.length) list.append(element('p', 'topic-empty', 'Os assuntos aparecerão aqui com os artigos.'));
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', !state.topic && state.view === button.dataset.view));
  }
  function postCard(post) {
    const card = element('article', 'feed-card');
    const top = element('div', 'feed-card-top');
    const avatar = element('span', 'avatar', (post.author_name || 'L').slice(0, 1).toUpperCase());
    if (post.author_photo_url) { const img = element('img'); img.src = safeImage(post.author_photo_url); img.alt = ''; avatar.replaceChildren(img); }
    const author = element('div', 'author-row'); author.append(element('strong', '', post.author_name || 'Lazy Labs'), element('small', '', (post.category || 'Artigo') + ' · ' + date(post.published_at)));
    top.append(avatar, author);
    if (post.affinity_score >= 6 && ranking.load().enabled) top.append(element('span', 'interest-pill', 'Combina com você'));
    const coverButton = element('a', 'feed-cover'); coverButton.href = articleUrl(post); coverButton.setAttribute('aria-label', 'Ler ' + post.title); coverButton.append(cover(post)); coverButton.onclick = () => trackArticleClick(post);
    const body = element('div', 'feed-card-body'); body.append(element('div', 'feed-category', post.category || 'Artigo'));
    const title = element('a', 'feed-title', post.title); title.href = articleUrl(post); title.onclick = () => trackArticleClick(post); body.append(title);
    body.append(element('p', 'feed-excerpt', post.excerpt || 'Abra o artigo para começar a leitura.'));
    body.append(element('div', 'feed-slug', '/' + post.slug));
    const tags = element('div', 'feed-tags'); (post.tags || []).slice(0, 5).forEach(tag => tags.append(element('span', '', tag))); body.append(tags);
    const meta = element('div', 'feed-meta');
    meta.append(element('span', '', (Number(post.reading_time) || 5) + ' min de leitura'));
    if (post.audio_url) meta.append(element('span', 'audio', '◉ Áudio disponível'));
    const comments = element('span', '', 'Comentários · …'); comments.dataset.commentCount = post.slug; meta.append(comments);
    meta.append(element('span', '', '↗ ' + (Number(post.qualified_view_count) || 0) + ' visualizações'));
    body.append(meta);
    const actions = element('div', 'feed-actions');
    const like = element('button', '', '↑ ' + (Number(post.like_count) || 0)); like.type = 'button'; like.setAttribute('aria-label', 'Votar positivamente em ' + post.title);
    try { if (localStorage.getItem('lk_' + post.slug)) like.classList.add('liked'); } catch (_) {}
    like.onclick = () => toggleLike(post, like); actions.append(like);
    const comment = element('a', '', '◌ Comentar'); comment.href = articleUrl(post) + '#comments'; comment.onclick = () => trackArticleClick(post); actions.append(comment);
    const read = element('a', 'read', 'Ler artigo ↗'); read.href = articleUrl(post); read.onclick = () => trackArticleClick(post); actions.append(read);
    body.append(actions); card.append(top, coverButton, body);
    card.tabIndex = 0;
    card.setAttribute('aria-label', 'Abrir artigo ' + post.title);
    card.addEventListener('click', event => {
      if (event.target.closest('a,button,input')) return;
      trackArticleClick(post); location.assign(articleUrl(post));
    });
    card.addEventListener('keydown', event => {
      if (event.target !== card || event.key !== 'Enter') return;
      trackArticleClick(post); location.assign(articleUrl(post));
    });
    return card;
  }
  async function toggleLike(post, button) {
    if (button.disabled) return; button.disabled = true;
    let already = false; try { already = !!localStorage.getItem('lk_' + post.slug); } catch (_) {}
    try {
      const response = await fetch('/api/posts/toggleLike', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: post.slug, liked: !already }) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error('Falha ao curtir.');
      post.like_count = Math.max(0, Number(data.like_count) || 0);
      try { if (already) localStorage.removeItem('lk_' + post.slug); else localStorage.setItem('lk_' + post.slug, '1'); } catch (_) {}
      button.classList.toggle('liked', !already); button.textContent = '↑ ' + post.like_count;
    } catch (_) { button.textContent = 'Tente novamente'; setTimeout(() => { button.textContent = '↑ ' + (Number(post.like_count) || 0); }, 2000); }
    finally { button.disabled = false; }
  }
  async function loadCommentCounts() {
    if (countObserver) countObserver.disconnect();
    const nodes = [...document.querySelectorAll('[data-comment-count]')];
    countObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { countObserver.unobserve(entry.target); count(entry.target); }
    }, { rootMargin: '150px' }) : null;
    for (const node of nodes) countObserver ? countObserver.observe(node) : count(node);
  }
  async function count(node) {
    try {
      const slug = node.dataset.commentCount;
      if (!commentCounts.has(slug)) commentCounts.set(slug, fetch('/api/posts/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, count_only: true }) })
        .then(response => response.json()).then(data => data.ok && Number.isFinite(Number(data.count)) ? Number(data.count) : null).catch(() => null));
      const total = await commentCounts.get(slug);
      node.textContent = total == null ? 'Comentários' : 'Comentários · ' + total;
    } catch (_) { node.textContent = 'Comentários'; }
  }
  function refresh() {
    profileUI(); renderTopics();
    const posts = sortedPosts(), visible = posts.slice(0, state.visible), list = $('feed-list'); list.replaceChildren();
    $('feed-title').textContent = state.topic ? (ranking.topics(state.posts, ranking.load()).find(t => t.key === state.topic)?.label || 'Tópico') : (state.view === 'recent' || state.sort === 'recent' ? 'Mais recentes' : 'Artigos para explorar');
    $('feed-count').textContent = posts.length + ' artigos';
    $('feed-context').textContent = ranking.load().enabled ? 'Ordenado pelos seus interesses e por descobertas' : 'Novidades e assuntos em destaque';
    document.querySelectorAll('[data-sort]').forEach(button => button.classList.toggle('active', button.dataset.sort === state.sort));
    if (!visible.length) list.append(element('div', 'loading-card', state.posts.length ? 'Nenhum artigo encontrado para este filtro.' : 'Ainda não há artigos publicados.'));
    else visible.forEach(post => list.append(postCard(post)));
    $('load-more').hidden = visible.length >= posts.length;
    loadCommentCounts();
  }
  async function init() {
    profileUI();
    const mobile = matchMedia('(max-width:760px)').matches;
    $('sidebar-toggle').setAttribute('aria-expanded', String(!mobile));
    $('sidebar-toggle').setAttribute('aria-label', mobile ? 'Mostrar tópicos' : 'Recolher tópicos');
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.view; state.topic = ''; state.visible = 6; refresh(); }));
    document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => { state.sort = button.dataset.sort; state.visible = 6; refresh(); }));
    $('feed-search').addEventListener('input', event => { clearTimeout(searchTimer); state.query = event.target.value.trim().slice(0, 100); state.visible = 6; searchTimer = setTimeout(refresh, 160); });
    $('load-more').onclick = () => { state.visible += 6; refresh(); };
    $('personalization-action').onclick = () => { ranking.load().enabled ? ranking.clear() : ranking.enable(); refresh(); };
    $('clear-interests').onclick = () => { ranking.clear(); refresh(); };
    $('sidebar-toggle').onclick = () => {
      const mobile = matchMedia('(max-width:760px)').matches;
      if (mobile) $('sidebar').classList.toggle('is-open'); else $('layout').classList.toggle('sidebar-small');
      const expanded = mobile ? $('sidebar').classList.contains('is-open') : !$('layout').classList.contains('sidebar-small');
      $('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
      $('sidebar-toggle').setAttribute('aria-label', expanded ? 'Recolher tópicos' : 'Mostrar tópicos');
    };
    try {
      const response = await fetch('/api/posts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blog_id: 'your-blog', status: 'published' }) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message || 'Falha ao buscar artigos.');
      state.posts = (data.posts || []).filter(post => slugOk(post.slug) && post.status === 'published'); refresh();
    } catch (_) { $('feed-list').replaceChildren(element('div', 'loading-card', 'Não foi possível carregar os artigos. Recarregue a página para tentar novamente.')); }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
