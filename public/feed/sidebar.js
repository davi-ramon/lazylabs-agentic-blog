(function () {
  'use strict';
  function init() {
    const sidebar = document.getElementById('sidebar');
    const content = document.getElementById('sidebar-content');
    const expand = document.getElementById('sidebar-expand');
    const layout = document.getElementById('layout');
    const toggle = document.getElementById('sidebar-toggle');
    const track = document.getElementById('sidebar-scrollbar');
    const thumb = document.getElementById('sidebar-thumb');
    if (!sidebar || !content || !expand || !track || !thumb) return;

    let drag = null;
    let frame = 0;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function update() {
      frame = 0;
      expand.style.setProperty('--sidebar-expand-height', expand.scrollHeight + 'px');
      const mobile = matchMedia('(max-width: 760px)').matches;
      const expanded = mobile ? sidebar.classList.contains('is-open') : !layout.classList.contains('sidebar-small');
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? 'Recolher tópicos' : 'Mostrar tópicos');
      const hidden = mobile ? !sidebar.classList.contains('is-open') : layout.classList.contains('sidebar-small');
      expand.toggleAttribute('inert', hidden);
      expand.setAttribute('aria-hidden', String(hidden));
      const overflowing = !mobile && content.scrollHeight > content.clientHeight + 2;
      if (sidebar.classList.contains('has-scroll') !== overflowing) sidebar.classList.toggle('has-scroll', overflowing);
      if (!overflowing) return;
      const height = track.clientHeight;
      const thumbHeight = clamp(height * content.clientHeight / content.scrollHeight, 30, height);
      const travel = Math.max(0, height - thumbHeight);
      const offset = content.scrollTop / Math.max(1, content.scrollHeight - content.clientHeight) * travel;
      thumb.style.height = thumbHeight + 'px';
      thumb.style.transform = 'translateY(' + offset + 'px)';
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    content.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    new MutationObserver(schedule).observe(document.getElementById('topic-list'), { childList: true });
    new MutationObserver(schedule).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(schedule).observe(layout, { attributes: true, attributeFilter: ['class'] });
    if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(content);

    track.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !sidebar.classList.contains('has-scroll')) return;
      event.preventDefault();
      const height = track.clientHeight;
      const thumbHeight = thumb.getBoundingClientRect().height;
      if (event.target !== thumb) {
        const top = event.clientY - track.getBoundingClientRect().top - thumbHeight / 2;
        content.scrollTop = clamp(top / Math.max(1, height - thumbHeight), 0, 1) * (content.scrollHeight - content.clientHeight);
      }
      drag = { y: event.clientY, scrollTop: content.scrollTop };
      track.setPointerCapture(event.pointerId);
      sidebar.classList.add('scroll-dragging');
      schedule();
    });
    track.addEventListener('pointermove', event => {
      if (!drag) return;
      const travel = Math.max(1, track.clientHeight - thumb.getBoundingClientRect().height);
      content.scrollTop = drag.scrollTop + (event.clientY - drag.y) / travel * (content.scrollHeight - content.clientHeight);
    });
    function stop(event) {
      if (!drag) return;
      drag = null;
      sidebar.classList.remove('scroll-dragging');
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    }
    track.addEventListener('pointerup', stop);
    track.addEventListener('pointercancel', stop);
    schedule();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
