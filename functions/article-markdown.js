'use strict';

const cheerio = require('cheerio');

function escapeText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/([*_[\]`])/g, '\\$1');
}

function absoluteUrl(value) {
  try {
    const url = new URL(String(value || ''), 'https://blog.example.com');
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}

function markdownFromHtml(html) {
  const $ = cheerio.load(String(html || ''), null, false);
  function inline(node) {
    if (node.type === 'text') return escapeText(node.data).replace(/\s+/g, ' ');
    if (node.type !== 'tag') return '';
    const tag = node.name.toLowerCase();
    const children = (node.children || []).map(inline).join('');
    if (tag === 'br') return '  \n';
    if (tag === 'strong' || tag === 'b') return `**${children.trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${children.trim()}*`;
    if (tag === 'code') return '`' + $(node).text().replace(/`/g, '\\`') + '`';
    if (tag === 'a') {
      const url = absoluteUrl(node.attribs?.href);
      return url ? `[${children.trim() || url}](${url.replace(/\)/g, '%29')})` : children;
    }
    if (tag === 'img') {
      const url = absoluteUrl(node.attribs?.src);
      return url ? `![${escapeText(node.attribs?.alt || '')}](${url.replace(/\)/g, '%29')})` : '';
    }
    if (tag === 'iframe') {
      const url = absoluteUrl(node.attribs?.src);
      return url ? `[Vídeo incorporado](${url.replace(/\)/g, '%29')})` : '';
    }
    return children;
  }
  function block(node, depth = 0) {
    if (node.type === 'text') return node.data.trim() ? escapeText(node.data.trim()) + '\n\n' : '';
    if (node.type !== 'tag') return '';
    const tag = node.name.toLowerCase();
    if ($(node).hasClass('article-prompt-block')) {
      const prompt = $(node).find('.article-prompt-text').first().text().trimEnd();
      const fence = '`'.repeat(Math.max(3, ...Array.from(prompt.matchAll(/`+/g), match => match[0].length + 1)));
      return prompt ? `**Prompt para IA**\n\n${fence}text\n${prompt}\n${fence}\n\n` : '';
    }
    if ($(node).hasClass('article-video')) {
      const url = absoluteUrl(node.attribs?.['data-video-url'] || $(node).find('iframe').first().attr('src'));
      return url ? `[Vídeo incorporado](${url.replace(/\)/g, '%29')})\n\n` : '';
    }
    if (/^h[1-4]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + $(node).text().trim() + '\n\n';
    if (tag === 'p' || tag === 'figcaption') return inline(node).trim() + '\n\n';
    if (tag === 'pre') return '```\n' + $(node).text().trimEnd() + '\n```\n\n';
    if (tag === 'hr') return '---\n\n';
    if (tag === 'img' || tag === 'iframe') return inline(node) + '\n\n';
    if (tag === 'blockquote') return $(node).text().trim().split(/\r?\n/).map(line => '> ' + escapeText(line.trim())).join('\n') + '\n\n';
    if (tag === 'ul' || tag === 'ol') {
      const items = $(node).children('li').toArray();
      return items.map((item, index) => {
        const nested = $(item).children('ul,ol').toArray().map(child => block(child, depth + 1).trimEnd()).join('\n');
        const copy = $(item).clone(); copy.children('ul,ol').remove();
        const prefix = tag === 'ol' ? `${index + 1}. ` : '- ';
        return '  '.repeat(depth) + prefix + inline(copy[0]).trim() + (nested ? '\n' + nested : '');
      }).join('\n') + '\n\n';
    }
    if (tag === 'table') {
      const rows = $(node).find('tr').toArray().map(row => $(row).children('th,td').toArray().map(cell => inline(cell).trim().replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |\n';
      return line(rows[0]) + line(Array(width).fill('---')) + rows.slice(1).map(line).join('') + '\n';
    }
    if (tag === 'figure' || tag === 'div' || tag === 'span') {
      if (tag === 'span') return inline(node);
      return (node.children || []).map(child => block(child, depth)).join('');
    }
    return (node.children || []).map(child => block(child, depth)).join('');
  }
  return ($.root()[0].children || []).map(node => block(node)).join('').replace(/\n{3,}/g, '\n\n').trim();
}

function articleMarkdown(post, language, canonical) {
  const heading = '# ' + escapeText(post.title || 'Artigo');
  const meta = [
    `Fonte: ${canonical}`,
    `Idioma: ${language}`,
    post.author_name ? `Autor: ${escapeText(post.author_name)}` : '',
    post.published_at ? `Publicado: ${String(post.published_at).slice(0, 10)}` : '',
    post.category ? `Categoria: ${escapeText(post.category)}` : '',
    Array.isArray(post.tags) && post.tags.length ? `Tags: ${post.tags.map(escapeText).join(', ')}` : ''
  ].filter(Boolean).join('  \n');
  const excerpt = post.excerpt ? escapeText(post.excerpt) + '\n\n' : '';
  return `${heading}\n\n${meta}\n\n${excerpt}${markdownFromHtml(post.content)}\n`;
}

module.exports = { markdownFromHtml, articleMarkdown };
