import {
  compareLocations,
  descriptionSimilarity,
  extractRequisitionIds,
  hashDescription,
  normalizeCompany,
  titleSimilarity
} from './text-normalize';

export interface ComparableJob {
  company: string;
  title: string;
  location: string | null;
  description: string;
  /** provider → external ids known for the posting */
  identifiers: Array<{ provider: string; externalId: string }>;
}

export type MatchDecision = 'auto' | 'possible' | 'none';

export interface ContentComparison {
  decision: MatchDecision;
  score: number;
  reasons: string[];
}

/** Thresholds are deliberately conservative: a wrong merge is worse than a question. */
export const THRESHOLDS = {
  autoTitle: 0.85,
  autoDescription: 0.85,
  possibleTitle: 0.6,
  possibleDescription: 0.5,
  repostDescription: 0.9,
  /** How much of a shorter text must appear in the longer one for it to count as an excerpt of it. */
  autoContainment: 0.85,
  /** Below this, an "excerpt" could just be shared boilerplate. */
  minExcerptLength: 1000
} as const;

/** Same provider with a different id: the provider itself says these are separate postings. */
function hasConflictingIdentifier(a: ComparableJob, b: ComparableJob): boolean {
  for (const left of a.identifiers) {
    for (const right of b.identifiers) {
      if (left.provider === right.provider && left.externalId !== right.externalId) return true;
    }
  }
  return false;
}

function companiesRelated(keyA: string, keyB: string): boolean {
  if (keyA.length < 4 || keyB.length < 4) return false;
  return keyA.startsWith(keyB) || keyB.startsWith(keyA);
}

export function compareJobs(incoming: ComparableJob, existing: ComparableJob): ContentComparison {
  const reasons: string[] = [];
  const companyA = normalizeCompany(incoming.company);
  const companyB = normalizeCompany(existing.company);
  const sameCompany = companyA.length > 0 && companyA === companyB;
  const relatedCompany = !sameCompany && companiesRelated(companyA, companyB);
  const titleScore = titleSimilarity(incoming.title, existing.title);
  // Every match below needs at least this, so unrelated titles skip the costly text comparison.
  if (titleScore < THRESHOLDS.possibleTitle) return { decision: 'none', score: 0, reasons };
  const location = compareLocations(incoming.location, existing.location);

  const hashA = hashDescription(incoming.description);
  const hashB = hashDescription(existing.description);
  const identicalText = hashA !== null && hashA === hashB;
  const text = identicalText
    ? { jaccard: 1, containment: 1 }
    : descriptionSimilarity(incoming.description, existing.description);

  const reqA = extractRequisitionIds(incoming.description);
  const reqB = extractRequisitionIds(existing.description);
  const sameRequisition = [...reqA].some((id) => reqB.has(id));
  const requisitionConflict = reqA.size > 0 && reqB.size > 0 && !sameRequisition;
  const identifierConflict = hasConflictingIdentifier(incoming, existing);

  if (sameCompany) reasons.push('Same company');
  else if (relatedCompany) reasons.push('Similar company name');
  if (titleScore === 1) reasons.push('Same job title');
  else if (titleScore >= THRESHOLDS.possibleTitle) reasons.push('Similar job title');
  if (location === 'match') reasons.push('Same location');
  if (location === 'conflict') reasons.push('Different location');
  if (identicalText) reasons.push('Identical description');
  else if (text.jaccard >= THRESHOLDS.possibleDescription) {
    reasons.push(`Description ${Math.round(text.jaccard * 100)}% similar`);
  } else if (text.containment >= 0.8) {
    reasons.push('Description is an excerpt of the other');
  }
  if (sameRequisition) reasons.push('Same requisition number');
  if (requisitionConflict) reasons.push('Different requisition numbers');
  if (identifierConflict) reasons.push('Different posting ids on the same system');

  const score = Math.min(
    1,
    0.35 * (sameCompany ? 1 : relatedCompany ? 0.6 : 0) +
      0.25 * titleScore +
      0.35 * Math.max(text.jaccard, text.containment * 0.9) +
      (location === 'match' ? 0.05 : 0)
  );

  const blocked = identifierConflict || requisitionConflict || location === 'conflict';

  // Automatic merge needs every signal to agree and nothing to disagree.
  if (sameCompany && !blocked) {
    if (sameRequisition && titleScore >= THRESHOLDS.possibleTitle) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons };
    }
    if (titleScore >= THRESHOLDS.autoTitle && (identicalText || text.jaccard >= THRESHOLDS.autoDescription)) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons };
    }
    // An aggregator's shortened copy: nearly every phrase of it comes from the fuller posting.
    const shorter = Math.min(incoming.description.length, existing.description.length);
    if (titleScore >= THRESHOLDS.autoTitle && text.containment >= THRESHOLDS.autoContainment && shorter >= THRESHOLDS.minExcerptLength) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons };
    }
  }

  // Different requisitions with different text are simply different jobs.
  if (blocked) {
    const nearIdentical = sameCompany && titleScore >= THRESHOLDS.autoTitle && text.jaccard >= THRESHOLDS.repostDescription;
    return { decision: nearIdentical ? 'possible' : 'none', score, reasons };
  }

  if (sameCompany && titleScore >= THRESHOLDS.autoTitle) return { decision: 'possible', score, reasons };
  if (
    sameCompany &&
    titleScore >= THRESHOLDS.possibleTitle &&
    Math.max(text.jaccard, text.containment) >= THRESHOLDS.possibleDescription
  ) {
    return { decision: 'possible', score, reasons };
  }
  // "Devoted Health" and "Devoted Health Services, Inc" with one title: worth a question,
  // even when one site rewrote the description so that the text says nothing either way.
  if (relatedCompany && titleScore >= THRESHOLDS.autoTitle) {
    return { decision: 'possible', score, reasons };
  }
  // Recruiting agencies repost the same text under their own name.
  if (titleScore >= THRESHOLDS.possibleTitle && text.jaccard >= THRESHOLDS.repostDescription) {
    return { decision: 'possible', score, reasons };
  }
  return { decision: 'none', score, reasons };
}
