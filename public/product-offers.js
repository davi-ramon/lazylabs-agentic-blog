(function () {
  const copy = {
    'pt-BR': { label: 'Publicidade · Oferta da Lazy Labs', action: 'Conhecer o produto', close: 'Fechar oferta' },
    en: { label: 'Advertising · Lazy Labs offer', action: 'Explore this product', close: 'Close offer' },
    es: { label: 'Publicidad · Oferta de Lazy Labs', action: 'Conocer el producto', close: 'Cerrar oferta' },
    fr: { label: 'Publicité · Offre Lazy Labs', action: 'Découvrir le produit', close: 'Fermer l’offre' },
    de: { label: 'Werbung · Angebot von Lazy Labs', action: 'Produkt ansehen', close: 'Angebot schließen' }
  };
  function record(type, slug) {
    try { fetch('/api/products/event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, slug }), keepalive: true, credentials: 'omit' }).catch(() => {}); } catch (_) {}
  }
  function watchImpression(box, slug) {
    if (!('IntersectionObserver' in window)) return;
    let timer;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5);
      if (visible && !timer) timer = setTimeout(() => { observer.disconnect(); record('impressions', slug); }, 1000);
      if (!visible && timer) { clearTimeout(timer); timer = null; }
    }, { threshold: [0, 0.5, 1] });
    observer.observe(box);
  }
  function addOffer(product, anchor, language, articleSlug) {
    if (!product || !anchor || document.querySelector('.ll-product-offer')) return;
    const words = copy[language] || copy['pt-BR'];
    const box = document.createElement('aside');
    box.className = 'll-product-offer';
    box.setAttribute('aria-label', words.label);
    const main = document.createElement('div');
    const label = document.createElement('div'); label.className = 'll-offer-label'; label.textContent = words.label;
    const title = document.createElement('h3'); title.textContent = product.title;
    const subtitle = document.createElement('p'); subtitle.textContent = product.subtitle || product.description.slice(0, 150);
    const footer = document.createElement('div'); footer.className = 'll-offer-footer';
    const price = document.createElement('strong'); price.className = 'll-offer-price';
    price.textContent = new Intl.NumberFormat(language, { style: 'currency', currency: 'BRL' }).format(product.price_cents / 100);
    const link = document.createElement('a'); link.href = product.url + '?from=' + encodeURIComponent(articleSlug); link.textContent = words.action + ' ↗';
    link.addEventListener('click', () => record('article_clicks', product.slug));
    footer.append(price, link); main.append(label, title, subtitle, footer); box.append(main);
    if (product.cover_url) { const image = document.createElement('img'); image.src = product.cover_url; image.alt = ''; image.loading = 'lazy'; box.append(image); }
    if (product.offer_placement === 'floating') {
      const key = 'll-product-offer-' + product.slug;
      try { if (sessionStorage.getItem(key)) return; } catch (_) {}
      box.classList.add('ll-product-offer-floating');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'll-offer-close';
      close.setAttribute('aria-label', words.close); close.textContent = '×';
      close.addEventListener('click', () => { box.remove(); try { sessionStorage.setItem(key, '1'); } catch (_) {} });
      box.append(close);
      let elapsed = false;
      function maybeShow() {
        if (!elapsed) return;
        const body = document.getElementById('art-body');
        if (!body || window.scrollY + window.innerHeight < body.getBoundingClientRect().top + window.scrollY + body.offsetHeight * 0.55) return;
        window.removeEventListener('scroll', maybeShow);
        document.body.append(box);
        watchImpression(box, product.slug);
        try { sessionStorage.setItem(key, '1'); } catch (_) {}
      }
      window.addEventListener('scroll', maybeShow, { passive: true });
      setTimeout(() => { elapsed = true; maybeShow(); }, 20000);
    } else { anchor.after(box); watchImpression(box, product.slug); }
  }
  function prepare(post, language) {
    const body = document.getElementById('art-body');
    if (!body || !post?.slug) return;
    const paragraphs = [...body.querySelectorAll(':scope > p')].filter(el => el.textContent.trim().length >= 70);
    if (paragraphs.length < 3) return;
    const anchor = paragraphs[Math.min(3, paragraphs.length - 1)];
    let loaded = false;
    async function load() {
      if (loaded) return; loaded = true;
      try {
        const response = await fetch('/api/products/recommend?slug=' + encodeURIComponent(post.slug) + '&language=' + encodeURIComponent(language));
        if (!response.ok) return;
        const data = await response.json();
        if (data.ok && data.product) addOffer(data.product, anchor, language, post.slug);
      } catch (_) { /* Offers are optional; reading must continue. */ }
    }
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
      }, { rootMargin: '600px 0px' });
      observer.observe(paragraphs[1]);
    } else load();
  }
  window.LazyProductOffers = { prepare };
})();
