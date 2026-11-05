import type { ExtractionFailureReason } from '../../shared/api';

export interface PartialJob {
  title: string | null;
  company: string | null;
  description: string | null;
  location: string | null;
  requisitionId?: string | null;
  canonicalUrl?: string | null;
}

export type ExtractionMethod = 'api' | 'json-ld' | 'embedded-data' | 'site-html' | 'open-graph' | 'content' | 'browser' | 'manual';

export interface ExtractionSuccess {
  ok: true;
  title: string;
  company: string;
  description: string;
  location: string | null;
  requisitionId: string | null;
  method: ExtractionMethod;
  usedBrowser: boolean;
  finalUrl: string;
  canonicalUrl: string | null;
  redirectChain: string[];
  /** ATS links found inside the page, used as evidence for cross-platform matching. */
  discoveredUrls: string[];
}

export interface ExtractionFailure {
  ok: false;
  reason: ExtractionFailureReason;
  message: string;
  partial: PartialJob;
  finalUrl: string | null;
  canonicalUrl: string | null;
  redirectChain: string[];
  discoveredUrls: string[];
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

export interface RenderedPage {
  html: string;
  finalUrl: string;
  status: number | null;
  /** Embedded documents: career sites often show the posting inside an ATS iframe. */
  frames?: Array<{ url: string; html: string }>;
}

/** Renders JavaScript-heavy pages. Injected so tests never launch a real browser. */
export interface PageRenderer {
  render(url: string): Promise<RenderedPage>;
  close(): Promise<void>;
}

export const MIN_DESCRIPTION_LENGTH = 200;
