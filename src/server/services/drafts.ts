import { randomUUID } from 'node:crypto';
import type { ExtractionResult } from '../extraction/types';

export interface Draft {
  id: string;
  userId: number;
  /** Normalized link the draft was read from, so that it cannot be reused for another link. */
  url: string;
  extraction: ExtractionResult;
  expiresAt: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * Holds a read page between the steps of adding a job. Without it, answering the
 * "possible duplicate" dialog or fixing a missing field would mean fetching the page again.
 */
export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly now: () => number = Date.now) {}

  create(userId: number, url: string, extraction: ExtractionResult): string {
    this.prune();
    const id = randomUUID();
    this.drafts.set(id, { id, userId, url, extraction, expiresAt: this.now() + DRAFT_TTL_MS });
    return id;
  }

  /** Only the person who created a draft can use it. */
  get(id: string | undefined, userId: number, url: string): Draft | null {
    if (!id) return null;
    const draft = this.drafts.get(id);
    if (!draft || draft.userId !== userId || draft.url !== url || draft.expiresAt <= this.now()) return null;
    return draft;
  }

  delete(id: string | undefined): void {
    if (id) this.drafts.delete(id);
  }

  private prune(): void {
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= this.now()) this.drafts.delete(id);
    }
  }
}
