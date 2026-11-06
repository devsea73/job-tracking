import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, ParentNode } from 'domhandler';

/**
 * Keeps what a page's markup can cost in check before and after it is parsed.
 *
 * A page can be up to 8 MB, and nothing in it is trusted. Tags nested thousands deep make the
 * parser, and every step after it, slow down far faster than the page grows, and enough of them
 * overflow the stack. A very large page holds more than any posting needs. So tags nested deeper
 * than any real page loses the ones past that depth (their text stays), and a very large page
 * is read only so far, without its scripts, styles and drawings but keeping its structured data
 * and metadata. An ordinary page comes back exactly as it was.
 */

/** Markup kept for parsing, besides structured data: far more than any posting needs. */
export const MAX_MARKUP_CHARS = 1_000_000;
/** Open tags counted at once, past which more are dropped. Real pages stay far below this. */
export const MAX_NESTING = 250;
/** How deep the parsed page may go. Deeper than this, an element keeps only its text. */
export const MAX_DOM_DEPTH = 500;

const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Their content is text, not markup, up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
/** End tags that may be left out: a parser closes these by itself, so they are not counted. */
const OPTIONAL_END = new Set(['p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp', 'html', 'head', 'body']);
/** Drawings and formulas: skipped whole when counting, and dropped from a very large page. */
const FOREIGN = new Set(['svg', 'math']);
/** Dropped from a very large page: nothing in them is read. */
const DROPPED_WHEN_LARGE = new Set(['style', 'noscript', 'template', 'svg', 'math']);
/** Kept from a very large page however far down they are. */
const KEPT_WHEN_LARGE = new Set(['title', 'meta', 'link']);

const DATA_SCRIPT = /\btype\s*=\s*["']?application\/(?:ld\+)?json\b|\bid\s*=\s*["']?__NEXT_DATA__\b/i;

/** The characters \s stands for in a regular expression, which is also what trim() removes. */
export function isSpaceCode(code: number): boolean {
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

const isNameStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameEnd = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13 || code === 47 || code === 62;

interface Tag {
  name: string;
  closing: boolean;
  /** Just past the tag's '>', or the end of the text when it never closes. */
  end: number;
  attributes: string;
}

/** Reads the tag starting at `start` ('<' then a letter, or '</' then a letter). Quoted values may hold '>'. */
function readTag(html: string, start: number): Tag {
  const closing = html.charCodeAt(start + 1) === 47;
  let index = start + (closing ? 2 : 1);
  const nameStart = index;
  while (index < html.length && !isTagNameEnd(html.charCodeAt(index))) index += 1;
  const name = html.slice(nameStart, index).toLowerCase();
  const attributesStart = index;
  while (index < html.length) {
    const char = html[index];
    if (char === '>') return { name, closing, end: index + 1, attributes: html.slice(attributesStart, index) };
    if (char === '=') {
      index += 1;
      while (index < html.length && /\s/.test(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        index = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    index += 1;
  }
  return { name, closing, end: html.length, attributes: html.slice(attributesStart) };
}

/** Just past the end tag that closes a raw-text element ("</script>", not "</scripts"), or the end of the text. */
function rawTextEnd(html: string, lower: () => string, name: string, from: number): number {
  let search = from;
  for (;;) {
    const close = lower().indexOf(`</${name}`, search);
    if (close === -1) return html.length;
    const after = close + 2 + name.length;
    if (after >= html.length || isTagNameEnd(html.charCodeAt(after))) return readTag(html, close).end;
    search = after;
  }
}

/** Just past the end tag that closes a drawing or formula, counting ones of the same kind inside it. */
function foreignEnd(html: string, name: string, from: number): number {
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const tag = readTag(html, match.index);
    if (tag.closing) depth -= 1;
    else if (!tag.attributes.trimEnd().endsWith('/')) depth += 1;
    if (depth === 0) return tag.end;
    tags.lastIndex = tag.end;
  }
  return html.length;
}

/**
 * The markup to parse for a page: the page itself when it is ordinary, otherwise without tags
 * nested past MAX_NESTING and, past MAX_MARKUP_CHARS, without anything but structured data
 * (JSON-LD, Next.js data) and the title, meta and link tags.
 */
export function boundMarkup(html: string): string {
  const large = html.length > MAX_MARKUP_CHARS;
  let lowered: string | null = null;
  const lower = () => (lowered ??= html.toLowerCase());

  const parts: string[] = [];
  /** Everything from here up to the current place is copied, unless dropped. */
  let copiedFrom = 0;
  let changed = false;
  /** Characters copied before copiedFrom, not counting structured data. */
  let kept = 0;
  /** Past the limit: only structured data and the title, meta and link tags are copied. */
  let tail = false;
  const drop = (from: number, to: number) => {
    if (!tail && from > copiedFrom) {
      parts.push(html.slice(copiedFrom, from));
      kept += from - copiedFrom;
    }
    copiedFrom = to;
    changed = true;
  };
  const keepWhole = (from: number, to: number) => {
    parts.push(html.slice(from, to));
  };
  /**
   * Stops copying once the limit is reached, at `index` (where the last tag or comment ended) or
   * within the plain text from there to `textEnd`, so that no tag is ever cut in two.
   */
  const reachedLimit = (index: number, textEnd: number): boolean => {
    if (!large || tail) return tail;
    const before = kept + (index - copiedFrom);
    if (before + (textEnd - index) <= MAX_MARKUP_CHARS) return false;
    parts.push(html.slice(copiedFrom, index + Math.min(Math.max(0, MAX_MARKUP_CHARS - before), textEnd - index)));
    copiedFrom = textEnd;
    changed = true;
    tail = true;
    return true;
  };

  const open: string[] = [];
  const dropped = new Map<string, number>();

  let index = 0;
  while (index < html.length) {
    const at = html.indexOf('<', index);
    if (at === -1) break;
    reachedLimit(index, at);
    const next = html.charCodeAt(at + 1);

    if (next === 33) {
      // A comment, a doctype or a CDATA section.
      const comment = html.startsWith('<!--', at);
      const close = comment ? html.indexOf('-->', at + 2) : html.indexOf('>', at);
      const end = close === -1 ? html.length : close + (comment ? 3 : 1);
      if (tail || (large && comment)) drop(at, end);
      index = end;
      continue;
    }
    if (next === 63 || (next === 47 && !isNameStart(html.charCodeAt(at + 2)))) {
      // A processing instruction or a stray "</": a comment, to a parser.
      const close = html.indexOf('>', at);
      index = close === -1 ? html.length : close + 1;
      if (tail) drop(at, index);
      continue;
    }
    if (!(isNameStart(next) || next === 47)) {
      index = at + 1;
      continue;
    }

    const tag = readTag(html, at);
    const { name } = tag;

    if (!tag.closing && (RAW_TEXT.has(name) || name === 'plaintext')) {
      const end = name === 'plaintext' ? html.length : rawTextEnd(html, lower, name, tag.end);
      const isData = name === 'script' && DATA_SCRIPT.test(tag.attributes);
      if (tail) {
        if (isData || KEPT_WHEN_LARGE.has(name)) keepWhole(at, end);
        copiedFrom = end;
      } else if (large && (name === 'script' ? !isData : DROPPED_WHEN_LARGE.has(name))) {
        drop(at, end);
      } else if (isData) {
        // Structured data does not count against the limit.
        kept -= end - at;
      }
      index = end;
      continue;
    }

    if (!tag.closing && FOREIGN.has(name)) {
      const selfClosing = tag.attributes.trimEnd().endsWith('/');
      const end = selfClosing ? tag.end : foreignEnd(html, name, tag.end);
      if (tail || large) drop(at, end);
      index = end;
      continue;
    }

    if (tail) {
      if (!tag.closing && KEPT_WHEN_LARGE.has(name)) keepWhole(at, tag.end);
      copiedFrom = tag.end;
      index = tag.end;
      continue;
    }

    if (large && !tag.closing && DROPPED_WHEN_LARGE.has(name)) {
      // A template's content is markup: skipped like a drawing, counting templates inside it.
      const end = foreignEnd(html, name, tag.end);
      drop(at, end);
      index = end;
      continue;
    }

    if (!VOID.has(name) && !OPTIONAL_END.has(name)) {
      if (!tag.closing) {
        if (open.length >= MAX_NESTING) {
          drop(at, tag.end);
          dropped.set(name, (dropped.get(name) ?? 0) + 1);
        } else open.push(name);
      } else {
        const waiting = dropped.get(name) ?? 0;
        if (waiting > 0) {
          drop(at, tag.end);
          dropped.set(name, waiting - 1);
        } else {
          const position = open.lastIndexOf(name);
          if (position !== -1) open.length = position;
        }
      }
    }
    index = tag.end;
  }

  if (!reachedLimit(index, html.length) && !changed) return html;
  if (!tail) parts.push(html.slice(copiedFrom));
  return parts.join('');
}

/** A node's text, as a parser's textContent gives it, without recursion. */
export function textOf(node: AnyNode): string {
  const out: string[] = [];
  const stack: AnyNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as AnyNode;
    if (current.type === 'text') out.push(current.data);
    else if (current.type !== 'comment' && 'children' in current) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) stack.push(current.children[index]);
    }
  }
  return out.join('');
}

/** Gives an element deeper than MAX_DOM_DEPTH just its text, so that nothing after this recurses too deep. */
export function flattenDeepNodes($: CheerioAPI, maxDepth = MAX_DOM_DEPTH): void {
  const stack: Array<{ node: ParentNode; depth: number }> = [{ node: $.root()[0] as ParentNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: ParentNode; depth: number };
    const parents = node.children.filter((child): child is ParentNode & AnyNode => 'children' in child);
    if (parents.length === 0) continue;
    if (depth >= maxDepth) {
      $(node as never).text(textOf(node as AnyNode));
      continue;
    }
    for (const child of parents) stack.push({ node: child, depth: depth + 1 });
  }
}

/** Parses a page with its markup kept in check: see boundMarkup and flattenDeepNodes. */
export function loadPage(html: string): CheerioAPI {
  const $ = cheerio.load(boundMarkup(html));
  flattenDeepNodes($);
  return $;
}
