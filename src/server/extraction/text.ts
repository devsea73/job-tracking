import * as cheerio from 'cheerio';
import { boundMarkup, isSpaceCode } from './markup';

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

const HTML_TAG = /<\/?(?:p|div|span|ul|ol|li|br|strong|em|b|i|u|h[1-6]|table|thead|tbody|tr|td|th|a|section|article|header|footer|blockquote|pre|code|font|hr)\b[^>]*>/i;
const ENCODED_TAG = /&lt;\/?[a-z][a-z0-9]*\b[^&]{0,200}?&gt;/i;

/** The start of a tag HTML_TAG looks for, up to the end of its name. */
const HTML_TAG_START = new RegExp(HTML_TAG.source.slice(0, HTML_TAG.source.indexOf('\\b') + 2), 'i');

/** True for markup that would show as tags if displayed as text: "<p>…</p>", or "&lt;p&gt;". */
export function looksLikeHtml(text: string): boolean {
  // HTML_TAG.test(text), read once: a tag's "[^>]*>" ends at the next '>', so a tag start matches
  // exactly when a '>' comes after it. Tried directly, each "<p" with no '>' after it would read
  // the rest of the text again.
  const lastClose = text.lastIndexOf('>');
  return (lastClose !== -1 && HTML_TAG_START.test(text.slice(0, lastClose))) || ENCODED_TAG.test(text);
}

type TextNode = { type: string; data?: string; name?: string; children?: unknown[] };

export function htmlToText(html: string, depth = 0): string {
  // Some sources encode their HTML once or twice (&lt;p&gt;...), sometimes inside real tags.
  const source = boundMarkup(ENCODED_TAG.test(html) ? decodeEntities(html) : html);
  const $ = cheerio.load(source, null, false);
  return finishText(nodesToText($.root().contents().toArray()), depth);
}

/** Tidies text read from markup. Text still holding tags was encoded more than once, and is read again. */
export function finishText(raw: string, depth = 0): string {
  const text = tidyText(raw);
  return depth < 2 && looksLikeHtml(text) ? htmlToText(text, depth + 1) : text;
}

/**
 * The text of some nodes before it is tidied: blocks and list items on lines of their own.
 * Depth first without recursion, so that no nesting can overflow the stack. An element `skip`
 * says yes to is left out with everything in it.
 */
export function nodesToText(nodes: unknown[], skip?: (element: unknown) => boolean): string {
  const out: string[] = [];
  // A node to read, or text to add once everything pushed after it has been read.
  const pending: Array<{ node: TextNode; listDepth: number } | string> = [];
  const pushChildren = (children: unknown[], listDepth: number) => {
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push({ node: children[index] as TextNode, listDepth });
  };
  pushChildren(nodes, 0);
  while (pending.length > 0) {
    const item = pending.pop() as (typeof pending)[number];
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const { node: element, listDepth } = item;
    const children = element.children ?? [];
    if (element.type === 'text') {
      out.push((element.data ?? '').replace(/\s+/g, ' '));
      continue;
    }
    if (element.type !== 'tag' && element.type !== 'root') continue;
    const tag = element.name?.toLowerCase();
    if ((tag && SKIP_TAGS.has(tag)) || skip?.(element)) continue;

    if (tag === 'br') {
      out.push('\n');
      continue;
    }
    if (tag === 'li') {
      out.push(`\n${'  '.repeat(Math.max(0, listDepth - 1))}- `);
      pending.push('\n');
      pushChildren(children, listDepth);
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      pending.push(' ');
      pushChildren(children, listDepth);
      continue;
    }
    const isBlock = tag !== undefined && BLOCK_TAGS.has(tag);
    if (isBlock) {
      out.push('\n\n');
      pending.push('\n\n');
    }
    pushChildren(children, tag === 'ul' || tag === 'ol' ? listDepth + 1 : listDepth);
  }
  return out.join('');
}

export function tidyText(text: string): string {
  const spaced = text
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    // Only from where a run of spaces begins: tried from inside one too, a run not followed by a
    // line break would be read again from every space in it.
    .replace(/(?<![ \t])[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?!- )(?=\S)/g, (match) => (/\n {2,}- /.test(match) ? match : '\n'))
    .replace(/(\S)[ \t]{2,}/g, '$1 ');
  return bulletsToDashes(spaced)
    .replace(/\n(?:- *\n)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BULLETS = '•·▪◦‣';
const isLineEnd = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * A bullet at the start of a line, with the spaces and blank lines around it, becomes "- ": what
 * text.replace(/^\s*[•·▪◦‣]\s*\/gm, '- ') does. That expression tries again from every line start
 * in a stretch of blank lines, reading the whole stretch each time; this reads it once.
 */
export function bulletsToDashes(text: string): string {
  if (![...BULLETS].some((bullet) => text.includes(bullet))) return text;
  const parts: string[] = [];
  let copied = 0;
  let lineStart = 0;
  const nextLineStart = (from: number): number => {
    for (let index = from; index < text.length; index += 1) if (isLineEnd(text.charCodeAt(index))) return index + 1;
    return -1;
  };
  while (lineStart !== -1 && lineStart <= text.length) {
    let first = lineStart;
    while (first < text.length && isSpaceCode(text.charCodeAt(first))) first += 1;
    if (first < text.length && BULLETS.includes(text[first])) {
      let end = first + 1;
      while (end < text.length && isSpaceCode(text.charCodeAt(end))) end += 1;
      parts.push(text.slice(copied, lineStart), '- ');
      copied = end;
      // Read on from the end of the match, which is a line start if it follows a line break.
      lineStart = end > 0 && isLineEnd(text.charCodeAt(end - 1)) ? end : nextLineStart(end);
      continue;
    }
    // Every line start up to `first` reaches the same character, so none of them can match either.
    lineStart = nextLineStart(first);
  }
  parts.push(text.slice(copied));
  return parts.join('');
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
