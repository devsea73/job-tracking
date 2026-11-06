import { descriptionWords, distinctiveWords, extractRequisitionIds, hashDescription } from './text-normalize';

/**
 * What duplicate detection needs from a posting's text, and nothing more: hashed phrases and
 * hashed distinctive words, the text's length, and its requisition numbers. None of it can be
 * turned back into the text, so the duplicate index holds no copy of what a posting says.
 */
export interface TextFeatures {
  /** Same for the same wording, whatever the formatting. Null for text too short to compare. */
  hash: string | null;
  length: number;
  /** Sorted 32-bit hashes of every three-word phrase. */
  shingles: Uint32Array;
  /** Sorted 32-bit hashes of the words that make a posting about this job and not another. */
  words: Uint32Array;
  requisitions: string[];
}

/** Bump when anything here, or how titles and companies are normalized, changes: saved jobs are indexed again. */
export const FEATURES_VERSION = 2;

/** Postings longer than this compare on their first part, which says what the job is. */
const MAX_SHINGLES = 4000;

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function sortedUnique(values: number[]): Uint32Array {
  const array = Uint32Array.from(values).sort();
  let size = 0;
  for (let i = 0; i < array.length; i += 1) if (i === 0 || array[i] !== array[i - 1]) array[size++] = array[i];
  return array.slice(0, size);
}

export const EMPTY_FEATURES: TextFeatures = { hash: null, length: 0, shingles: new Uint32Array(0), words: new Uint32Array(0), requisitions: [] };

export function textFeatures(text: string): TextFeatures {
  if (!text) return EMPTY_FEATURES;
  const words = descriptionWords(text);
  const shingles: number[] = [];
  if (words.length > 0 && words.length < 3) shingles.push(fnv(words.join(' ')));
  for (let i = 0; i <= words.length - 3 && shingles.length < MAX_SHINGLES; i += 1) shingles.push(fnv(`${words[i]} ${words[i + 1]} ${words[i + 2]}`));
  return {
    hash: hashDescription(text),
    length: text.length,
    shingles: sortedUnique(shingles),
    words: sortedUnique([...distinctiveWords(text)].map(fnv)),
    requisitions: [...extractRequisitionIds(text)]
  };
}

/** How many values two sorted arrays share. */
function sharedCount(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  return shared;
}

/** Share of all phrases both contain, and share of the shorter text's phrases in the longer one. */
export function phraseSimilarity(a: TextFeatures, b: TextFeatures): { jaccard: number; containment: number } {
  if (a.shingles.length === 0 || b.shingles.length === 0) return { jaccard: 0, containment: 0 };
  const shared = sharedCount(a.shingles, b.shingles);
  return { jaccard: shared / (a.shingles.length + b.shingles.length - shared), containment: shared / Math.min(a.shingles.length, b.shingles.length) };
}

/** How much of the shorter text's vocabulary the longer one uses. Rewritten postings keep it. */
export function vocabularySimilarity(a: TextFeatures, b: TextFeatures): number {
  if (a.words.length < 15 || b.words.length < 15) return 0;
  return sharedCount(a.words, b.words) / Math.min(a.words.length, b.words.length);
}

/** A few phrases that stand for the whole text in the candidate index: the smallest hashes. */
export function textSketchOf(features: TextFeatures, size = 8): string[] {
  if (features.shingles.length < 18) return [];
  return [...features.shingles.slice(0, size)].map((hash) => hash.toString(16));
}

export function toBlob(values: Uint32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array | null | undefined): Uint32Array {
  if (!blob || blob.byteLength === 0) return new Uint32Array(0);
  // Copied, so that the array is aligned whatever the driver returns.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Uint32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
