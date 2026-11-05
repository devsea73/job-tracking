import * as cheerio from 'cheerio';

/**
 * Converts a posting's HTML to readable plain text, keeping paragraphs and lists.
 * Script and style contents are dropped, nothing from the page is ever executed.
 */

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'blockquote',
  'pre',
  'table',
  'tr',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6'
]);

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'img', 'video', 'audio']);

export function htmlToText(html: string): string {
  // Some sources double-encode their HTML (&lt;p&gt;...).
  const source = /&lt;\/?[a-z]+[^&]*&gt;/i.test(html) && !/<\/?(p|div|ul|li|br|h\d)\b/i.test(html) ? decodeEntities(html) : html;
  const $ = cheerio.load(source, null, false);
  const out: string[] = [];

  const walk = (node: unknown, listDepth: number): void => {
    const element = node as { type: string; data?: string; name?: string; children?: unknown[] };
    const children = element.children ?? [];
    if (element.type === 'text') {
      out.push((element.data ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (element.type !== 'tag' && element.type !== 'root') return;
    const tag = element.name?.toLowerCase();
    if (tag && SKIP_TAGS.has(tag)) return;

    if (tag === 'br') {
      out.push('\n');
      return;
    }
    if (tag === 'li') {
      out.push(`\n${'  '.repeat(Math.max(0, listDepth - 1))}- `);
      for (const child of children) walk(child, listDepth);
      out.push('\n');
      return;
    }
    if (tag === 'td' || tag === 'th') {
      for (const child of children) walk(child, listDepth);
      out.push(' ');
      return;
    }
    const isBlock = tag !== undefined && BLOCK_TAGS.has(tag);
    if (isBlock) out.push('\n\n');
    const nextDepth = tag === 'ul' || tag === 'ol' ? listDepth + 1 : listDepth;
    for (const child of children) walk(child, nextDepth);
    if (isBlock) out.push('\n\n');
  };

  for (const node of $.root().contents().toArray()) walk(node, 0);
  return tidyText(out.join(''));
}

export function tidyText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?!- )(?=\S)/g, (match) => (/\n {2,}- /.test(match) ? match : '\n'))
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/^\s*[•·▪◦‣]\s*/gm, '- ')
    .replace(/\n(?:- *\n)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeEntities(value: string): string {
  const $ = cheerio.load(`<x>${value.replace(/</g, '&lt;')}</x>`, null, false);
  return $('x').text();
}

/** Plain-text cleanup for short single-line fields like titles. */
export function cleanInline(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = decodeEntities(String(value)).replace(/\s+/g, ' ').trim();
  return text || null;
}
