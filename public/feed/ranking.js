(function (root) {
  'use strict';
  const KEY = 'll_feed_profile_v1';
  const STOP = new Set('para sobre entre como onde quando porque nosso nossa este esta esse essa aqui muito mais menos voce vocês blog artigo lazy labs uma dois três criar fazer tenho acho sistema'.split(' '));
  function tokens(value) {
    return (String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
      .filter(word => !STOP.has(word) && !/^\d+$/.test(word));
  }
  function features(post) {
    const out = new Map();
    function add(text, weight) { for (const word of new Set(tokens(text))) out.set(word, (out.get(word) || 0) + weight); }
    add(post.category, 4);
    for (const tag of (Array.isArray(post.tags) ? post.tags : []).slice(0, 12)) add(tag, 3);
    add(post.title, 1.3);
    add(post.excerpt, 0.35);
    return out;
  }
  function empty() { return { enabled: false, terms: {}, seen: {}, updated_at: Date.now() }; }
  function load() {
    try {
      const value = JSON.parse(root.localStorage.getItem(KEY) || 'null');
      if (!value || typeof value !== 'object' || value.enabled !== true) return empty();
      return { enabled: true, terms: value.terms || {}, seen: value.seen || {}, updated_at: Number(value.updated_at) || Date.now() };
    } catch (_) { return empty(); }
  }
  function save(profile) { try { root.localStorage.setItem(KEY, JSON.stringify(profile)); } catch (_) {} }
  function enable() { const profile = load(); profile.enabled = true; save(profile); return profile; }
  function clear() { try { root.localStorage.removeItem(KEY); } catch (_) {} return empty(); }
  function record(post, strength) {
    const profile = load();
    if (!profile.enabled || !post || !post.slug) return profile;
    const now = Date.now(), old = profile.seen[post.slug];
    const previous = typeof old === 'object' ? Number(old.at) || 0 : Number(old) || 0;
    const oldStrength = typeof old === 'object' ? Number(old.strength) || 0 : 1;
    const requested = Math.min(2, Math.max(0.2, strength || 1));
    if (now - previous < 6 * 3600000 && requested <= oldStrength) return profile;
    const contribution = now - previous < 6 * 3600000 ? requested - oldStrength : requested;
    const decay = Math.pow(0.5, Math.max(0, now - profile.updated_at) / (14 * 86400000));
    const weighted = {};
    for (const [term, value] of Object.entries(profile.terms)) {
      const next = Number(value) * decay;
      if (Number.isFinite(next) && next >= 0.1) weighted[term] = next;
    }
    for (const [term, value] of features(post)) weighted[term] = Math.min(30, (weighted[term] || 0) + value * contribution);
    profile.terms = Object.fromEntries(Object.entries(weighted).sort((a, b) => b[1] - a[1]).slice(0, 80));
    profile.seen = Object.fromEntries(Object.entries({ ...profile.seen, [post.slug]: { at: now, strength: requested } })
      .sort((a, b) => (Number(b[1]?.at || b[1]) || 0) - (Number(a[1]?.at || a[1]) || 0)).slice(0, 60));
    profile.updated_at = now; save(profile); return profile;
  }
  function recordTopic(label) {
    const profile = load(); if (!profile.enabled) return profile;
    for (const term of new Set(tokens(label))) profile.terms[term] = Math.min(30, (Number(profile.terms[term]) || 0) + 4);
    profile.updated_at = Date.now(); save(profile); return profile;
  }
  function affinity(post, profile) {
    if (!profile?.enabled) return 0;
    let score = 0;
    for (const [term, weight] of features(post)) score += Math.min(30, Number(profile.terms[term]) || 0) * Math.min(weight, 4);
    return Math.min(100, score / 4);
  }
  function rank(posts, profile = empty(), now = Date.now()) {
    const rows = (posts || []).filter(p => p && p.status === 'published' && p.slug).map(p => {
      const age = Math.max(0, (now - (Date.parse(p.published_at || p.created_at || '') || now)) / 86400000);
      const fresh = 12 / (1 + age / 35);
      const popular = Math.min(6, Math.log1p(Math.max(0, Number(p.view_count) || 0)) * 0.8);
      const interest = affinity(p, profile);
      const seen = profile?.enabled && profile.seen?.[p.slug] ? -7 : 0;
      return { ...p, feed_score: fresh + popular + interest + seen, affinity_score: interest };
    }).sort((a, b) => b.feed_score - a.feed_score || String(b.published_at || '').localeCompare(String(a.published_at || '')));
    // Keep discovery in the feed even when the reader has strong preferences.
    if (!profile?.enabled || rows.length < 5) return rows;
    const selected = [], remaining = rows.slice();
    while (remaining.length) {
      const explore = selected.length % 5 === 4;
      const index = explore ? remaining.findIndex(p => p.affinity_score < 4 && !profile.seen?.[p.slug]) : 0;
      selected.push(remaining.splice(index >= 0 ? index : 0, 1)[0]);
    }
    return selected;
  }
  function topics(posts, profile = empty()) {
    const map = new Map();
    for (const post of posts || []) {
      for (const label of [post.category, ...(Array.isArray(post.tags) ? post.tags.slice(0, 8) : [])]) {
        const text = String(label || '').trim(); if (!text || text.length > 55) continue;
        const key = tokens(text).join('-'); if (!key) continue;
        const item = map.get(key) || { label: text, key, count: 0, score: 0 };
        item.count++;
        item.score = item.count + (profile.enabled ? tokens(text).reduce((n, term) => n + Math.min(12, Number(profile.terms[term]) || 0), 0) : 0);
        map.set(key, item);
      }
    }
    return [...map.values()].sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label)).slice(0, 30);
  }
  const api = { tokens, features, empty, load, enable, clear, record, recordTopic, affinity, rank, topics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LazyFeedRanking = api;
})(typeof window !== 'undefined' ? window : globalThis);
