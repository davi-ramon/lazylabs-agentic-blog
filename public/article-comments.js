/* Lazy Labs article discussions. Loaded only on article pages. */
var _cmMode = 'anonymous', _cmSlug = '', _cmCursor = null, _cmLoaded = false, _cmLoading = false;
var _cmItems = [], _cmThreads = {}, _cmReply = null, _cmMedia = null, _cmObserver = null;
var _cmStickers = ['spark', 'heart', 'idea', 'rocket', 'applause', 'celebrate'];

function cmIcon(id) { return '<svg viewBox="0 0 48 48" aria-hidden="true"><use href="#sticker-' + id + '"></use></svg>'; }
function cmSafeId(id) { return /^[A-Za-z0-9_-]{1,80}$/.test(id || '') ? id : ''; }
function cmMediaHtml(media) {
  if (!media) return '';
  if (media.type === 'sticker' && _cmStickers.includes(media.id)) return '<div class="cm-sticker-media" role="img" aria-label="' + esc(ui('stickers')) + '">' + cmIcon(media.id) + '</div>';
  if (media.type === 'giphy' && /^https:\/\/media\d*\.giphy\.com\//.test(media.url || '')) return '<img class="cm-media" src="' + esc(media.url) + '" alt="GIF" loading="lazy" decoding="async" width="' + (Number(media.width) || 100) + '" height="' + (Number(media.height) || 100) + '">';
  return '';
}
function cmRequest(action, body) {
  return fetch('/api/posts/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.message || ui('publishError')); return data; });
}
function prepareComments(slug) {
  _cmSlug = slug; _cmCursor = null; _cmItems = []; _cmThreads = {}; _cmLoaded = false; _cmReply = null;
  cmRequest('comments', { slug:slug, count_only:true }).then(function(result) {
    if (window.LazyArticleEngagement) window.LazyArticleEngagement.setComments(result.count);
  }).catch(function() {});
  setCommentMode('anonymous');
  document.getElementById('cm-list').innerHTML = '<div class="cm-loading-row">' + esc(ui('commentsOnScroll')) + '</div>';
  if (_cmObserver) _cmObserver.disconnect();
  if ('IntersectionObserver' in window) {
    _cmObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { _cmObserver.disconnect(); loadComments(); } }, { rootMargin: '500px' });
    _cmObserver.observe(document.getElementById('comments'));
  } else loadComments();
}
function setCommentMode(mode) {
  _cmMode = mode === 'identified' ? 'identified' : 'anonymous';
  document.getElementById('cm-tab-anon').classList.toggle('active', _cmMode === 'anonymous');
  document.getElementById('cm-tab-id').classList.toggle('active', _cmMode === 'identified');
  document.getElementById('cm-f-anon').style.display = _cmMode === 'anonymous' ? '' : 'none';
  document.getElementById('cm-f-id').style.display = _cmMode === 'identified' ? '' : 'none';
  document.getElementById('cm-hint').textContent = ui(_cmMode === 'identified' ? 'commentHint' : 'anonymousHint');
}
function cmFormMsg(type, message) {
  const el = document.getElementById('cm-form-msg'); el.className = 'cm-form-msg ' + type;
  el.textContent = message; el.style.display = 'block';
  clearTimeout(cmFormMsg.timer); cmFormMsg.timer = setTimeout(() => { el.style.display = 'none'; }, 6500);
}
function cmInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}
function cmName(c) { return c.nickname || c.name || ui('anonymous'); }
function cmCommentHtml(c, parentId) {
  const id = cmSafeId(c.id); if (!id) return '';
  const name = cmName(c), isReply = !!parentId, root = cmSafeId(parentId || c.id);
  const mention = c.reply_to_name ? '<div class="cm-mention">@' + esc(c.reply_to_name) + '</div>' : '';
  const text = c.message ? '<div class="cm-text">' + esc(c.message).replace(/\n/g, '<br>') + '</div>' : '';
  const replies = !isReply && Number(c.reply_count) > 0
    ? '<button type="button" class="cm-action" onclick="loadCommentReplies(\'' + root + '\')">' + esc(ui('showReplies')) + ' (' + Number(c.reply_count) + ')</button>' : '';
  return '<div class="cm-item" data-comment-id="' + id + '"><div class="cm-item-head"><div class="cm-author-wrap"><div class="cm-avatar">' + esc(cmInitials(name)) + '</div><span class="cm-author' + (c.mode === 'anonymous' ? ' anon' : '') + '">' + esc(name) + '</span></div><span class="cm-date">' + esc(fmtRelDate(c.created_at)) + '</span></div>'
    + mention + text + cmMediaHtml(c.media)
    + '<div class="cm-item-actions"><button type="button" class="cm-action" onclick="replyToComment(\'' + root + '\',\'' + (isReply ? id : '') + '\')">' + esc(ui('reply')) + '</button>' + replies + '</div>'
    + (!isReply ? '<div class="cm-thread" id="cm-thread-' + root + '" style="display:none"></div>' : '') + '</div>';
}
function cmRenderRoots() {
  const list = document.getElementById('cm-list'), more = document.getElementById('cm-more'), badge = document.getElementById('cm-badge');
  list.innerHTML = _cmItems.length ? _cmItems.map(c => cmCommentHtml(c)).join('') : '<div class="cm-empty">' + esc(ui('noComments')) + '</div>';
  badge.style.display = _cmItems.length ? '' : 'none'; badge.textContent = _cmItems.length ? String(_cmItems.length) + (_cmCursor ? '+' : '') : '';
  more.style.display = _cmCursor ? '' : 'none';
  Object.keys(_cmThreads).forEach(id => cmRenderThread(id));
}
function cmRenderThread(rootId) {
  const el = document.getElementById('cm-thread-' + rootId), thread = _cmThreads[rootId];
  if (!el || !thread || !thread.open) return;
  el.style.display = 'block';
  el.innerHTML = (thread.items || []).map(c => cmCommentHtml(c, rootId)).join('')
    + (thread.cursor ? '<button class="cm-more" type="button" onclick="loadCommentReplies(\'' + rootId + '\')">' + esc(ui('loadMoreReplies')) + '</button>' : '');
}
async function loadComments(reset) {
  if (_cmLoading || !_cmSlug || (!reset && _cmLoaded && !_cmCursor)) return;
  _cmLoading = true;
  if (reset) { _cmCursor = null; _cmItems = []; _cmThreads = {}; _cmLoaded = false; }
  if (!_cmLoaded) document.getElementById('cm-list').innerHTML = '<div class="cm-loading-row">' + esc(ui('loadingComments')) + '</div>';
  try {
    const data = await cmRequest('comments', { slug: _cmSlug, cursor: _cmCursor });
    _cmItems.push(...data.comments); _cmCursor = data.next_cursor; _cmLoaded = true; cmRenderRoots();
  } catch (e) {
    console.error('[Lazy Labs Comments]', e);
    if (!_cmLoaded) document.getElementById('cm-list').innerHTML = '<div class="cm-empty">' + esc(ui('errorComments')) + ' <button class="cm-action" onclick="loadComments()">' + esc(ui('tryAgain')) + '</button></div>';
    cmFormMsg('err', ui('errorComments'));
  } finally { _cmLoading = false; }
}
async function loadCommentReplies(rootId) {
  const root = _cmItems.find(c => c.id === rootId); if (!root) return;
  const thread = _cmThreads[rootId] || { items: [], cursor: null, loaded: false, open: false };
  if (thread.loading) return;
  if (thread.open && thread.loaded && !thread.cursor) { thread.open = false; const el = document.getElementById('cm-thread-' + rootId); if (el) el.style.display = 'none'; return; }
  thread.open = true; _cmThreads[rootId] = thread;
  if (thread.loaded && !thread.cursor) { cmRenderThread(rootId); return; }
  thread.loading = true;
  try {
    const data = await cmRequest('commentReplies', { slug: _cmSlug, parent_id: rootId, cursor: thread.cursor });
    thread.items.push(...data.comments); thread.cursor = data.next_cursor; thread.loaded = true; cmRenderThread(rootId);
  } catch (e) { cmFormMsg('err', ui('errorComments')); }
  finally { thread.loading = false; }
}
function replyToComment(rootId, replyId) {
  const root = _cmItems.find(c => c.id === rootId); if (!root) return;
  const reply = replyId && _cmThreads[rootId]?.items.find(c => c.id === replyId);
  const name = cmName(reply || root);
  _cmReply = { rootId, replyId: replyId || '' };
  const box = document.getElementById('cm-replying'); box.style.display = 'flex';
  document.getElementById('cm-replying-text').textContent = ui('replyingTo') + ' @' + name;
  const field = document.getElementById('cm-message');
  document.getElementById('cm-form-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => field.focus({ preventScroll: true }), 250);
}
function cancelCommentReply() {
  _cmReply = null; document.getElementById('cm-replying').style.display = 'none';
}
function cmSelectMedia(media) {
  _cmMedia = media; const selected = document.getElementById('cm-media-selected');
  selected.style.display = 'flex';
  selected.innerHTML = cmMediaHtml(media) + '<span>' + esc(media.type === 'sticker' ? ui('stickers') : 'GIF') + '</span><button type="button" class="cm-media-close" onclick="cmClearMedia()" aria-label="' + esc(ui('removeMedia')) + '">×</button>';
  cmClosePicker();
}
function cmClearMedia() { _cmMedia = null; const el = document.getElementById('cm-media-selected'); el.style.display = 'none'; el.innerHTML = ''; }
function cmClosePicker() {
  document.getElementById('cm-picker').style.display = 'none';
  document.getElementById('cm-sticker-btn').setAttribute('aria-expanded', 'false');
  document.getElementById('cm-gif-btn').setAttribute('aria-expanded', 'false');
}
function toggleCommentPicker(type) {
  const picker = document.getElementById('cm-picker'), open = picker.style.display === 'block' && picker.dataset.type === type;
  cmClosePicker(); if (open) return;
  picker.dataset.type = type; picker.style.display = 'block';
  document.getElementById(type === 'stickers' ? 'cm-sticker-btn' : 'cm-gif-btn').setAttribute('aria-expanded', 'true');
  if (type === 'stickers') {
    picker.innerHTML = '<div class="cm-picker-head"><span>' + esc(ui('chooseSticker')) + '</span><button type="button" class="cm-picker-close" onclick="cmClosePicker()" aria-label="' + esc(ui('close')) + '">×</button></div><div class="cm-sticker-grid">'
      + _cmStickers.map(id => '<button type="button" class="cm-sticker-option" onclick="cmSelectMedia({type:\'sticker\',id:\'' + id + '\'})" aria-label="' + esc(ui('sticker_' + id)) + '">' + cmIcon(id) + '</button>').join('') + '</div>';
  } else {
    picker.innerHTML = '<div class="cm-picker-head"><span>' + esc(ui('searchGif')) + '</span><button type="button" class="cm-picker-close" onclick="cmClosePicker()" aria-label="' + esc(ui('close')) + '">×</button></div>'
      + '<div class="cm-gif-search"><input class="cm-input" id="cm-gif-query" type="search" maxlength="80" placeholder="' + esc(ui('searchGif')) + '" onkeydown="if(event.key===\'Enter\'){event.preventDefault();searchCommentGifs()}"><button type="button" onclick="searchCommentGifs()">' + esc(ui('search')) + '</button></div>'
      + '<div id="cm-gif-results" class="cm-gif-grid"></div><small id="cm-gif-credit" style="display:none;color:var(--mt2);font-family:var(--fm);font-size:10px;margin-top:10px">Powered by GIPHY</small>';
    document.getElementById('cm-gif-query').focus();
    cmRequest('gifSearch', {}).then(data => {
      if (!data.available && picker.dataset.type === 'gifs') {
        picker.querySelector('.cm-gif-search').style.display = 'none';
        document.getElementById('cm-gif-results').innerHTML = '<div class="cm-empty">' + esc(ui('gifsSoon')) + '</div>';
      }
    }).catch(() => {});
  }
}
async function searchCommentGifs() {
  const q = document.getElementById('cm-gif-query').value.trim(), results = document.getElementById('cm-gif-results');
  if (q.length < 2) return;
  results.innerHTML = '<div class="cm-loading-row">' + esc(ui('loadingGifs')) + '</div>';
  try {
    const data = await cmRequest('gifSearch', { query: q });
    if (!data.available) { results.innerHTML = '<div class="cm-empty">' + esc(ui('gifsSoon')) + '</div>'; return; }
    document.getElementById('cm-gif-credit').style.display = 'block';
    results.innerHTML = data.items.length ? data.items.map(x => '<button type="button" class="cm-gif-option" data-gif-id="' + esc(x.id) + '" aria-label="GIF"><img src="' + esc(x.preview) + '" alt="" loading="lazy" decoding="async"></button>').join('') : '<div class="cm-empty">' + esc(ui('noGifs')) + '</div>';
    results.querySelectorAll('[data-gif-id]').forEach(button => button.addEventListener('click', () => cmSelectMedia({ type: 'giphy', id: button.dataset.gifId, url: button.querySelector('img').src })));
  } catch (e) { results.innerHTML = '<div class="cm-empty">' + esc(ui('gifsSoon')) + '</div>'; }
}
async function submitComment() {
  const message = document.getElementById('cm-message').value.trim(), button = document.getElementById('cm-submit-btn');
  if ((message.length < 3 && !_cmMedia) || message.length > 2000) { cmFormMsg('err', ui(message.length > 2000 ? 'commentTooLong' : 'enterComment')); return; }
  const payload = { slug: _cmSlug, mode: _cmMode, message, media: _cmMedia, website: document.getElementById('cm-website').value };
  if (_cmReply) { payload.parent_id = _cmReply.rootId; if (_cmReply.replyId) payload.reply_to_id = _cmReply.replyId; }
  if (_cmMode === 'anonymous') payload.nickname = document.getElementById('cm-nickname').value.trim().slice(0, 60);
  else {
    payload.name = document.getElementById('cm-name').value.trim().slice(0, 100);
    payload.email = document.getElementById('cm-email').value.trim().slice(0, 200);
    if (!payload.name) { cmFormMsg('err', ui('enterName')); return; }
    if (payload.email && !isValidEmail(payload.email)) { cmFormMsg('err', ui('invalidEmail')); return; }
  }
  button.disabled = true; button.textContent = ui('publishing');
  try {
    await cmRequest('commentCreate', payload);
    ['cm-message', 'cm-nickname', 'cm-name', 'cm-email'].forEach(id => { document.getElementById(id).value = ''; });
    cancelCommentReply(); cmClearMedia(); cmFormMsg('ok', ui('commentPublished'));
    await loadComments(true);
  } catch (e) { cmFormMsg('err', e.message || ui('publishError')); }
  finally { button.disabled = false; button.textContent = ui('publish') + ' →'; }
}
