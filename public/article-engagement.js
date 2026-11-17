/* Reader-side engagement. Counts are browser sessions, never exact people. */
(function () {
  'use strict';
  var post = null, started = false, startAt = 0, activeSeconds = 0;
  var qualified = false, read = false, maxProgress = 0, timer = null, exactComments = null;
  var labels = {
    'pt-BR': { clicks:'cliques', downloads:'cliques para baixar' },
    en: { clicks:'clicks', downloads:'download clicks' },
    es: { clicks:'clics', downloads:'clics para descargar' },
    fr: { clicks:'clics', downloads:'clics de téléchargement' },
    de: { clicks:'Klicks', downloads:'Download-Klicks' }
  };
  function accepted() { try { return localStorage.getItem('ll_cookie_consent') === 'all'; } catch (_) { return false; } }
  function visitorId() {
    try {
      var id = localStorage.getItem('ll_reader_visitor');
      if (!id) { id = crypto.randomUUID(); localStorage.setItem('ll_reader_visitor', id); }
      return id;
    } catch (_) { return crypto.randomUUID(); }
  }
  function send(action, body, beacon) {
    var url = '/api/posts/' + action;
    var payload = JSON.stringify(Object.assign({ slug:post.slug }, body || {}));
    if (beacon && navigator.sendBeacon) return Promise.resolve(navigator.sendBeacon(url, new Blob([payload], { type:'application/json' })));
    return fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:payload, keepalive:!!beacon })
      .then(function(response) { return response.json(); });
  }
  function progress() {
    var total = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    maxProgress = Math.max(maxProgress, Math.min(1, window.scrollY / total));
    return maxProgress;
  }
  function tick() {
    if (!started || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    activeSeconds++;
    var depth = progress();
    if (!qualified && depth >= 0.04 && window.scrollY >= Math.max(240, window.innerHeight * 0.65) && Date.now() - startAt >= 2000) {
      qualified = true;
      send('engagementQualify', { visitorId:visitorId(), progress:depth, elapsedMs:Date.now()-startAt }).then(function(result) {
        if (result && result.counted) refresh();
      }).catch(function() {});
    }
    if (!read && depth >= 0.5 && activeSeconds >= 30) {
      read = true;
      send('engagementRead', { visitorId:visitorId(), progress:depth, activeSeconds:activeSeconds }).then(function(result) {
        if (result && result.counted) refresh();
      }).catch(function() {});
      clearInterval(timer);
    }
  }
  function countLabel(n, download) {
    return (Number(n) || 0).toLocaleString(document.documentElement.lang || 'pt-BR') + ' '
      + (download ? (labels[document.documentElement.lang] || labels['pt-BR']).downloads : (labels[document.documentElement.lang] || labels['pt-BR']).clicks);
  }
  function installButtons(items) {
    var inline = Array.from(document.querySelectorAll('#art-body .article-cta-block a.article-cta'));
    var main = document.getElementById('cta-a');
    var links = inline.concat(main && post.cta_label ? [main] : []);
    links.forEach(function(link, index) {
      var metric = items[index];
      if (!metric || link.dataset.engagementId === metric.id) return;
      link.dataset.engagementId = metric.id;
      var counter = document.createElement('span');
      counter.className = 'article-cta-count';
      counter.textContent = countLabel(metric.count, link.classList.contains('article-cta-download'));
      link.insertAdjacentElement('afterend', counter);
      link.addEventListener('click', function() {
        if (!accepted()) return;
        counter.textContent = countLabel((Number(metric.count) || 0) + 1, link.classList.contains('article-cta-download'));
        metric.count = (Number(metric.count) || 0) + 1;
        send('engagementClick', { kind:'button', buttonId:metric.id }, true).catch(function() {});
      });
    });
  }
  function refresh() {
    if (!post) return;
    send('engagementStats').then(function(data) {
      if (!data || !data.ok) return;
      var views = document.getElementById('m-views');
      var comments = document.getElementById('m-comments');
      if (views) views.textContent = (Number(data.views) || 0).toLocaleString(document.documentElement.lang || 'pt-BR');
      if (comments) comments.textContent = (exactComments == null ? (Number(data.comments) || 0) : exactComments).toLocaleString(document.documentElement.lang || 'pt-BR');
      installButtons(data.buttons || []);
      (data.buttons || []).forEach(function(item) {
        var link = document.querySelector('[data-engagement-id="' + item.id + '"]');
        var counter = link && link.nextElementSibling;
        if (counter && counter.classList.contains('article-cta-count')) counter.textContent = countLabel(item.count, link.classList.contains('article-cta-download'));
      });
    }).catch(function() {});
  }
  function start() {
    if (started || !post || !accepted()) return;
    started = true; startAt = Date.now();
    send('engagementOpen').catch(function() {});
    timer = setInterval(tick, 1000);
    window.addEventListener('scroll', progress, { passive:true });
    progress();
  }
  function init(currentPost) { post = currentPost; refresh(); start(); }
  function setComments(value) {
    exactComments = Math.max(0,Number(value)||0);
    var target = document.getElementById('m-comments');
    if (target) target.textContent = exactComments.toLocaleString(document.documentElement.lang || 'pt-BR');
  }
  window.LazyArticleEngagement = { init:init, start:start, refresh:refresh, setComments:setComments };
})();
