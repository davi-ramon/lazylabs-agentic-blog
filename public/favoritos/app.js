(function () {
  'use strict';
  var reader = window.LazyReader;
  var $ = id => document.getElementById(id);
  function showError(error) { $('auth-error').textContent = error.message || 'Não foi possível entrar.'; }
  function safeImage(value) {
    try { var url = new URL(value, location.origin); return url.protocol === 'https:' || url.origin === location.origin ? url.href : '/assets/related-fallback.svg'; }
    catch (_) { return '/assets/related-fallback.svg'; }
  }
  async function render(user) {
    $('auth-panel').hidden = !!user; $('favorites-panel').hidden = !user;
    if (!user) return;
    $('account-name').textContent = user.email || 'Sua conta';
    var list = $('favorites-list'); list.textContent = 'Carregando…';
    try {
      var data = await reader.request('list'); list.replaceChildren();
      if (!data.posts.length) { var empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Você ainda não salvou artigos. Abra um artigo e toque no coração.'; list.append(empty); return; }
      data.posts.forEach(function (post) {
        var card = document.createElement('article'); card.className = 'card';
        var image = document.createElement('img'); image.src = safeImage(post.cover_url); image.alt = ''; image.loading = 'lazy';
        var body = document.createElement('div'); var title = document.createElement('h2'); title.textContent = post.title || post.slug;
        var excerpt = document.createElement('p'); excerpt.textContent = post.excerpt || '';
        var link = document.createElement('a'); link.href = '/artigo/' + encodeURIComponent(post.slug); link.textContent = 'Ler artigo ↗';
        body.append(title,excerpt,link); card.append(image,body); list.append(card);
      });
    } catch (error) { list.textContent = error.message; }
  }
  if (!reader) { $('auth-panel').hidden = false; showError(new Error('Não foi possível carregar o login. Atualize a página.')); return; }
  reader.auth.onAuthStateChanged(function (user) {
    var redirect = new URLSearchParams(location.search).get('return');
    if (user && redirect && /^\/artigo\/[a-z0-9-]+$/.test(redirect)) { location.replace(redirect); return; }
    render(user);
  });
  $('google').onclick = function () { reader.signInGoogle().catch(showError); };
  $('email-form').onsubmit = function (event) { event.preventDefault(); reader.signInEmail($('email').value,$('password').value).catch(showError); };
  $('create').onclick = function () { reader.createEmail($('email').value,$('password').value).catch(showError); };
  $('signout').onclick = function () { reader.signOut().catch(showError); };
})();
