/* Turns consecutive vertical video figures into an accessible, swipeable carousel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LazyVideoCarousel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isVertical(node) {
    return !!(node && node.matches && node.matches('figure.article-video.article-video-portrait'));
  }
  function isGap(node) {
    return !!(node && node.matches && node.matches('p') && !node.textContent.trim() && !node.querySelector('img,video,iframe'));
  }
  function button(label, symbol) {
    var element = document.createElement('button');
    element.type = 'button'; element.setAttribute('aria-label', label); element.textContent = symbol;
    return element;
  }
  function build(figures) {
    var locale = (document.documentElement.lang || 'pt').split('-')[0];
    var copy = ({
      pt: ['Vídeos curtos', 'Arraste para navegar', 'Vídeo anterior', 'Próximo vídeo', 'Vídeos curtos do artigo', 'Vídeos em sequência', 'Vídeo'],
      en: ['Short videos', 'Drag to browse', 'Previous video', 'Next video', 'Article short videos', 'Video sequence', 'Video'],
      es: ['Vídeos cortos', 'Arrastra para navegar', 'Vídeo anterior', 'Vídeo siguiente', 'Vídeos cortos del artículo', 'Secuencia de vídeos', 'Vídeo'],
      fr: ['Vidéos courts', 'Glissez pour parcourir', 'Vidéo précédente', 'Vidéo suivante', "Vidéos courts de l’article", 'Séquence vidéo', 'Vidéo'],
      de: ['Kurzvideos', 'Zum Blättern ziehen', 'Vorheriges Video', 'Nächstes Video', 'Kurzvideos des Artikels', 'Videosequenz', 'Video']
    })[locale] || ['Vídeos curtos', 'Arraste para navegar', 'Vídeo anterior', 'Próximo vídeo', 'Vídeos curtos do artigo', 'Vídeos em sequência', 'Vídeo'];
    var carousel = document.createElement('div');
    carousel.className = 'article-video-carousel';
    carousel.setAttribute('role', 'region');
    carousel.setAttribute('aria-roledescription', 'carrossel');
    carousel.setAttribute('aria-label', copy[4]);
    carousel.tabIndex = 0;
    var bar = document.createElement('div'); bar.className = 'article-video-carousel-bar';
    var title = document.createElement('strong'); title.textContent = copy[0];
    var hint = document.createElement('span'); hint.className = 'article-video-carousel-hint'; hint.textContent = copy[1];
    var counter = document.createElement('span'); counter.className = 'article-video-carousel-counter'; counter.setAttribute('aria-live', 'polite');
    var back = button(copy[2], '←');
    var next = button(copy[3], '→');
    bar.append(title, hint, counter, back, next);
    var track = document.createElement('div'); track.className = 'article-video-carousel-track';
    track.setAttribute('aria-label', copy[5]);
    figures.forEach(function (figure, index) {
      figure.setAttribute('aria-label', copy[6] + ' ' + (index + 1) + ' / ' + figures.length);
      track.appendChild(figure);
    });
    carousel.append(bar, track);

    function index() {
      var left = track.getBoundingClientRect().left;
      var closest = 0, distance = Infinity;
      figures.forEach(function (figure, i) {
        var current = Math.abs(figure.getBoundingClientRect().left - left);
        if (current < distance) { closest = i; distance = current; }
      });
      return closest;
    }
    function update() {
      var current = index();
      counter.textContent = (current + 1) + ' / ' + figures.length;
      back.disabled = current === 0;
      next.disabled = current === figures.length - 1;
    }
    function goTo(position) {
      var target = figures[Math.max(0, Math.min(figures.length - 1, position))];
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollTo({ left: target.offsetLeft - track.offsetLeft, behavior: reduced ? 'auto' : 'smooth' });
      setTimeout(update, 350);
    }
    back.addEventListener('click', function () { goTo(index() - 1); });
    next.addEventListener('click', function () { goTo(index() + 1); });
    carousel.addEventListener('keydown', function (event) {
      if (event.target !== carousel || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault(); goTo(index() + (event.key === 'ArrowRight' ? 1 : -1));
    });
    var scrollTimer;
    track.addEventListener('scroll', function () { clearTimeout(scrollTimer); scrollTimer = setTimeout(update, 70); }, { passive: true });
    var startX = 0, startScroll = 0, dragging = false;
    track.addEventListener('pointerdown', function (event) {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('iframe,a,button')) return;
      dragging = true; startX = event.clientX; startScroll = track.scrollLeft;
      track.classList.add('is-dragging'); track.setPointerCapture(event.pointerId);
    });
    track.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      track.scrollLeft = startScroll - (event.clientX - startX);
    });
    function stopDrag() {
      if (!dragging) return;
      dragging = false; track.classList.remove('is-dragging');
      goTo(index());
    }
    track.addEventListener('pointerup', stopDrag);
    track.addEventListener('pointercancel', stopDrag);
    update();
    return carousel;
  }

  function enhance(container) {
    if (!container) return 0;
    var groups = 0;
    for (var node = container.firstElementChild; node;) {
      if (!isVertical(node)) { node = node.nextElementSibling; continue; }
      var figures = [node], gaps = [], cursor = node.nextElementSibling;
      while (cursor) {
        var pendingGaps = [];
        while (isGap(cursor)) { pendingGaps.push(cursor); cursor = cursor.nextElementSibling; }
        if (!isVertical(cursor)) break;
        gaps.push.apply(gaps, pendingGaps);
        figures.push(cursor);
        cursor = cursor.nextElementSibling;
      }
      if (figures.length < 2) { node = node.nextElementSibling; continue; }
      var marker = document.createComment('video carousel');
      node.before(marker);
      var carousel = build(figures);
      marker.replaceWith(carousel);
      gaps.forEach(function (gap) { gap.remove(); });
      groups++;
      node = carousel.nextElementSibling;
    }
    return groups;
  }
  return { enhance: enhance };
});
