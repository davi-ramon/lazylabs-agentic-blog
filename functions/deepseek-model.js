'use strict';

// Aliases retired by DeepSeek in July 2026. Keep old saved configurations usable.
function activeModel(provider, model) {
  const selected = String(model || '').trim();
  if (provider !== 'deepseek') return selected;
  if (!selected || selected === 'deepseek-chat' || selected === 'deepseek-reasoner') return 'deepseek-flash';
  return selected;
}

module.exports = { activeModel };
