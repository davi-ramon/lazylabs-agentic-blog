'use strict';

const LAYOUTS = new Set(['flow', 'architecture', 'timeline']);
const THEMES = new Set(['neon', 'mono', 'soft']);
const MOTIONS = new Set(['none', 'pulse', 'trace', 'reveal']);
const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function renderDiagram(spec, options = {}) {
  const layout = String(options.layout || 'flow');
  const theme = String(options.theme || 'neon');
  const motion = String(options.motion || 'none');
  if (!LAYOUTS.has(layout) || !THEMES.has(theme) || !MOTIONS.has(motion)) throw new Error('Estilo do diagrama inválido.');
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length < 2 || spec.nodes.length > 8) {
    throw new Error('A IA precisa sugerir entre 2 e 8 etapas para o diagrama.');
  }
  const title = String(spec.title || 'Como funciona').trim().slice(0, 100);
  const steps = spec.nodes.map((node, index) => {
    const label = String(node && node.label || '').trim().slice(0, 70);
    const detail = String(node && node.detail || '').trim().slice(0, 150);
    if (!label) throw new Error('A IA devolveu uma etapa sem título.');
    return `<div class="diagram-step"><span class="diagram-step-index">${String(index + 1).padStart(2, '0')}</span><div class="diagram-step-copy"><span class="diagram-step-label">${escape(label)}</span>${detail ? `<span class="diagram-step-detail">${escape(detail)}</span>` : ''}</div></div>${index < spec.nodes.length - 1 ? '<span class="diagram-connector" aria-hidden="true"></span>' : ''}`;
  }).join('');
  return `<figure class="article-diagram diagram-${layout} diagram-${theme} diagram-motion-${motion}" data-diagram="true" contenteditable="false"><figcaption>${escape(title)}</figcaption><div class="diagram-track">${steps}</div></figure>`;
}

module.exports = { renderDiagram, LAYOUTS, THEMES, MOTIONS };
