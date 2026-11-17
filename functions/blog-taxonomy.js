'use strict';

const PATH = 'config/blog-taxonomy';
const DEFAULT_CATEGORIES = ['Agentes de IA', 'CRM & Automacao', 'Trafego Pago', 'Sites & LPs', 'MicroSaaS', 'Apps Script', 'Integracoes API', 'Reflexoes'];
const DEFAULT_TYPES = [
  { value: 'projeto', label: 'Projeto' }, { value: 'case', label: 'Case' },
  { value: 'artigo', label: 'Artigo' }, { value: 'reflexao', label: 'Reflexao' },
  { value: 'tutorial', label: 'Tutorial' }
];

function key(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function label(value, max = 60) {
  const original = String(value || '');
  if (/[\x00-\x1f<>]/.test(original.replace(/[\t\r\n]/g, ' '))) return '';
  const result = original.replace(/\s+/g, ' ').trim();
  return result.length <= max && /^[\p{L}\p{N}][\p{L}\p{N} .&/+\-()]*$/u.test(result) ? result : '';
}
function type(value) {
  const name = label(typeof value === 'object' && value ? value.label || value.value : value, 40);
  if (!name || name.split(/\s+/).length > 4) return null;
  const id = key(name).replace(/\s+/g, '-').slice(0, 40);
  return id ? { value: id, label: name } : null;
}
function unique(items, itemKey, limit) {
  const seen = new Set();
  return items.filter(item => {
    const id = itemKey(item);
    if (!id || seen.has(id) || seen.size >= limit) return false;
    seen.add(id); return true;
  });
}
function merge(data) {
  const categories = unique(DEFAULT_CATEGORIES.concat(Array.isArray(data.categories) ? data.categories.map(value => label(value)) : []), key, 100);
  const postTypes = unique(DEFAULT_TYPES.concat(Array.isArray(data.postTypes) ? data.postTypes.map(type).filter(Boolean) : []), item => key(item.label), 40);
  const tags = unique((Array.isArray(data.tags) ? data.tags : []).map(value => label(value, 40)).filter(Boolean), key, 400);
  return { categories, postTypes, tags };
}
function resolveCategory(value, taxonomy) {
  const name = label(value);
  if (!name) return '';
  return taxonomy.categories.find(item => key(item) === key(name)) || name;
}
function resolveType(value, taxonomy) {
  const candidate = type(value);
  if (!candidate) return null;
  return taxonomy.postTypes.find(item => key(item.label) === key(candidate.label) || item.value === candidate.value) || candidate;
}
async function read(store) {
  const snap = await store.doc(PATH).get();
  return merge(snap.exists ? snap.data() || {} : {});
}
async function record(store, proposal) {
  const ref = store.doc(PATH);
  return store.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = merge(snap.exists ? snap.data() || {} : {});
    const category = resolveCategory(proposal.category, current);
    const postType = resolveType(proposal.postType, current);
    const tags = Array.isArray(proposal.tags) ? proposal.tags.slice(0, 8) : [];
    const updated = merge({
      categories: current.categories.concat(category ? [category] : []),
      postTypes: current.postTypes.concat(postType ? [postType] : []),
      tags: current.tags.concat(tags)
    });
    tx.set(ref, Object.assign({}, updated, { updatedAt: new Date().toISOString() }), { merge: true });
    return updated;
  });
}

module.exports = { DEFAULT_CATEGORIES, DEFAULT_TYPES, key, label, type, merge, resolveCategory, resolveType, read, record };
