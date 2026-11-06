import type { JobFacts } from '../../shared/api';
import { isUnreadableNote } from '../../shared/unreadable';
import { identifiersConflict } from './ats';
import { annualSalary } from './job-facts';
import { EMPTY_FEATURES, phraseSimilarity, textFeatures, vocabularySimilarity, type TextFeatures } from './text-features';
import { compareLocations, levelsConflict, normalizeCompany, titleSimilarity } from './text-normalize';

export interface ComparableJob {
  company: string;
  title: string;
  location: string | null;
  /** The posting's text, when the job is new. Saved jobs are compared on their stored features. */
  description?: string;
  text?: TextFeatures;
  /** provider → external ids known for the posting */
  identifiers: Array<{ provider: string; externalId: string }>;
  facts?: JobFacts | null;
}

export type MatchDecision = 'auto' | 'possible' | 'none';

export type SalaryComparison = 'same' | 'overlap' | 'conflict' | 'unknown';
export type FactComparison = 'same' | 'conflict' | 'unknown';

export interface ComparisonSignals {
  sameCompany: boolean;
  relatedCompany: boolean;
  title: number;
  location: string;
  jaccard: number;
  containment: number;
  vocabulary: number;
  salary: SalaryComparison;
  postedDaysApart: number | null;
  arrangement: FactComparison;
  employment: FactComparison;
  sameRequisition: boolean;
  requisitionConflict: boolean;
  identifierConflict: boolean;
  corroboration: number;
}

export interface ContentComparison {
  decision: MatchDecision;
  score: number;
  reasons: string[];
  signals?: ComparisonSignals;
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
  minExcerptLength: 1000,
  /** How much of a rewritten posting's vocabulary has to appear in the other. */
  autoVocabulary: 0.6,
  someVocabulary: 0.45,
  /** Every real pair measured was above this, however heavily a listing site had rewritten it. */
  strongVocabulary: 0.75,
  /** A shorter text could be nothing but the company's standard introduction. Real listings ran 1,300+. */
  minVocabularyLength: 600,
  /** Agreeing facts needed to merge when the wording has been rewritten. */
  autoCorroboration: 5,
  /** Agreeing facts needed before a slightly different company name counts as the same one. */
  relatedCompanyCorroboration: 8,
  /** Agreeing facts that make a posting under another company's name worth a question. */
  otherCompanyCorroboration: 6,
  closeDays: 7,
  nearDays: 21,
  farDays: 90
} as const;

/** Same provider with a different id: the provider itself says these are separate postings. */
function hasConflictingIdentifier(a: ComparableJob, b: ComparableJob): boolean {
  return a.identifiers.some((left) => b.identifiers.some((right) => identifiersConflict(left, right)));
}

export function compareSalaries(a: JobFacts | null | undefined, b: JobFacts | null | undefined): SalaryComparison {
  const left = a ? annualSalary(a) : null;
  const right = b ? annualSalary(b) : null;
  if (!left || !right) return 'unknown';
  const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * 0.03;
  if (close(left.min, right.min) && close(left.max, right.max)) return 'same';
  // Pay ranges vary by location, so one range can sit inside another. Separate ranges cannot be one job's.
  const gap = Math.max(left.min, right.min) - Math.min(left.max, right.max);
  if (gap > Math.max(left.max, right.max) * 0.05) return 'conflict';
  return 'overlap';
}

function compareArrangement(a: JobFacts | null | undefined, b: JobFacts | null | undefined): FactComparison {
  if (!a?.workArrangement || !b?.workArrangement) return 'unknown';
  return a.workArrangement === b.workArrangement ? 'same' : 'conflict';
}

function compareEmployment(a: JobFacts | null | undefined, b: JobFacts | null | undefined): FactComparison {
  if (!a?.employmentType || !b?.employmentType) return 'unknown';
  return a.employmentType === b.employmentType ? 'same' : 'conflict';
}

function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function companiesRelated(keyA: string, keyB: string): boolean {
  if (keyA.length < 4 || keyB.length < 4) return false;
  return keyA.startsWith(keyB) || keyB.startsWith(keyA);
}

/**
 * Decides whether two postings are one job, using everything known about them. Different sites
 * word the same job differently, so no single signal decides. Several have to agree, and any
 * one that truly disagrees, like separate pay ranges, stops an automatic merge.
 */
/** What a job is compared on: its stored features, or those of the text it came with. */
export function featuresFor(job: Pick<ComparableJob, 'text' | 'description'>): TextFeatures {
  if (job.text) return job.text;
  // A note saying a posting could not be read is not its text: two jobs sharing one are not alike.
  if (!job.description || isUnreadableNote(job.description)) return EMPTY_FEATURES;
  return textFeatures(job.description);
}

export function compareJobs(incoming: ComparableJob, existing: ComparableJob): ContentComparison {
  const textA = featuresFor(incoming);
  const textB = featuresFor(existing);
  const reasons: string[] = [];
  const companyA = normalizeCompany(incoming.company);
  const companyB = normalizeCompany(existing.company);
  const sameCompany = companyA.length > 0 && companyA === companyB;
  const relatedCompany = !sameCompany && companiesRelated(companyA, companyB);
  const titleScore = titleSimilarity(incoming.title, existing.title);
  const identicalText = textA.hash !== null && textA.hash === textB.hash;

  // Everything below needs at least this much, so unrelated titles skip the costly comparisons.
  if (titleScore < THRESHOLDS.possibleTitle && !identicalText) {
    return {
      decision: 'none',
      score: 0,
      reasons,
      signals: {
        sameCompany,
        relatedCompany,
        title: titleScore,
        location: 'unknown',
        jaccard: 0,
        containment: 0,
        vocabulary: 0,
        salary: 'unknown',
        postedDaysApart: null,
        arrangement: 'unknown',
        employment: 'unknown',
        sameRequisition: false,
        requisitionConflict: false,
        identifierConflict: false,
        corroboration: 0
      }
    };
  }

  const location = compareLocations(incoming.location, existing.location);
  const text = identicalText ? { jaccard: 1, containment: 1 } : phraseSimilarity(textA, textB);
  const vocabulary = identicalText ? 1 : vocabularySimilarity(textA, textB);
  const salary = compareSalaries(incoming.facts, existing.facts);
  const arrangement = compareArrangement(incoming.facts, existing.facts);
  const employment = compareEmployment(incoming.facts, existing.facts);
  const postedDaysApart = daysApart(incoming.facts?.postedAt, existing.facts?.postedAt);

  const reqA = new Set(textA.requisitions);
  const reqB = new Set(textB.requisitions);
  const sameRequisition = [...reqA].some((id) => reqB.has(id));
  const requisitionConflict = reqA.size > 0 && reqB.size > 0 && !sameRequisition;
  const identifierConflict = hasConflictingIdentifier(incoming, existing);
  const levelConflict = levelsConflict(incoming.title, existing.title);

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
  } else if (vocabulary >= THRESHOLDS.autoVocabulary) {
    reasons.push('Description covers the same things');
  }
  if (salary === 'same') reasons.push('Same salary');
  else if (salary === 'overlap') reasons.push('Salary ranges overlap');
  else if (salary === 'conflict') reasons.push('Different salary');
  if (postedDaysApart !== null && postedDaysApart <= THRESHOLDS.closeDays) reasons.push('Posted around the same time');
  else if (postedDaysApart !== null && postedDaysApart > THRESHOLDS.farDays) reasons.push(`Posted ${Math.round(postedDaysApart)} days apart`);
  if (arrangement === 'conflict') reasons.push('Different work arrangement');
  if (employment === 'conflict') reasons.push('Different employment type');
  if (sameRequisition) reasons.push('Same requisition number');
  if (requisitionConflict) reasons.push('Different requisition numbers');
  if (identifierConflict) reasons.push('Different posting ids on the same system');
  if (levelConflict) reasons.push('Different seniority');

  // Facts that back each other up when a site has rewritten the description.
  let corroboration = 0;
  if (salary === 'same') corroboration += 3;
  else if (salary === 'overlap') corroboration += 1;
  if (postedDaysApart !== null && postedDaysApart <= THRESHOLDS.closeDays) corroboration += 2;
  else if (postedDaysApart !== null && postedDaysApart <= THRESHOLDS.nearDays) corroboration += 1;
  if (location === 'match') corroboration += 1;
  if (arrangement === 'same') corroboration += 1;
  if (employment === 'same') corroboration += 1;
  if (vocabulary >= THRESHOLDS.autoVocabulary) corroboration += 2;
  else if (vocabulary >= THRESHOLDS.someVocabulary) corroboration += 1;
  if (titleScore === 1) corroboration += 1;

  const score = Math.min(
    1,
    0.3 * (sameCompany ? 1 : relatedCompany ? 0.6 : 0) +
      0.2 * titleScore +
      0.25 * Math.max(text.jaccard, text.containment * 0.9, vocabulary * 0.8) +
      0.25 * Math.min(1, corroboration / THRESHOLDS.autoCorroboration)
  );

  const signals: ComparisonSignals = {
    sameCompany,
    relatedCompany,
    title: titleScore,
    location,
    jaccard: text.jaccard,
    containment: text.containment,
    vocabulary,
    salary,
    postedDaysApart,
    arrangement,
    employment,
    sameRequisition,
    requisitionConflict,
    identifierConflict,
    corroboration
  };

  const substantial = Math.min(textA.length, textB.length) >= THRESHOLDS.minVocabularyLength;
  // Facts that cannot both be true of one job.
  const blocked = identifierConflict || requisitionConflict || levelConflict || location === 'conflict' || salary === 'conflict' || arrangement === 'conflict' || employment === 'conflict';

  // Automatic merge needs every signal to agree and nothing to disagree.
  if (sameCompany && !blocked) {
    if (sameRequisition && titleScore >= THRESHOLDS.possibleTitle) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons, signals };
    }
    if (titleScore >= THRESHOLDS.autoTitle && (identicalText || text.jaccard >= THRESHOLDS.autoDescription)) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons, signals };
    }
    // An aggregator's shortened copy: nearly every phrase of it comes from the fuller posting.
    const shorter = Math.min(textA.length, textB.length);
    if (titleScore >= THRESHOLDS.autoTitle && text.containment >= THRESHOLDS.autoContainment && shorter >= THRESHOLDS.minExcerptLength) {
      return { decision: 'auto', score: Math.max(score, 0.95), reasons, signals };
    }
    // Rewritten by a listing site: the wording differs, but the facts all line up. Sites date one
    // posting up to a year apart, so a far date only counts against text that is not clearly the same work.
    const sameWork = vocabulary >= THRESHOLDS.strongVocabulary && substantial;
    const notStale = postedDaysApart === null || postedDaysApart <= THRESHOLDS.farDays || sameWork;
    // The wording has to cover the same work: a company pays one rate for many openings with one
    // title, so a matching salary stands in for none of it.
    const textSupports = vocabulary >= THRESHOLDS.someVocabulary;
    // Title and wording alone are not enough: one company's openings share its standard text, so
    // other facts have to agree as well.
    if (titleScore >= THRESHOLDS.autoTitle && notStale && textSupports && corroboration >= THRESHOLDS.autoCorroboration) {
      return { decision: 'auto', score: Math.max(score, 0.9), reasons, signals };
    }
  }

  // "Sola" and "Sola Payments", when everything else agrees.
  if (relatedCompany && !blocked && titleScore === 1 && vocabulary >= THRESHOLDS.strongVocabulary && substantial && corroboration >= THRESHOLDS.relatedCompanyCorroboration) {
    return { decision: 'auto', score: Math.max(score, 0.9), reasons, signals };
  }

  // Different requisitions with different text are simply different jobs.
  if (blocked) {
    const nearIdentical = sameCompany && titleScore >= THRESHOLDS.autoTitle && text.jaccard >= THRESHOLDS.repostDescription;
    return { decision: nearIdentical ? 'possible' : 'none', score, reasons, signals };
  }

  if (sameCompany && titleScore >= THRESHOLDS.autoTitle) return { decision: 'possible', score, reasons, signals };
  if (sameCompany && titleScore >= THRESHOLDS.possibleTitle && Math.max(text.jaccard, text.containment, vocabulary) >= THRESHOLDS.possibleDescription) {
    return { decision: 'possible', score, reasons, signals };
  }
  // "Devoted Health" and "Devoted Health Services, Inc" with one title: worth a question,
  // even when one site rewrote the description so that the text says nothing either way.
  if (relatedCompany && titleScore >= THRESHOLDS.autoTitle) {
    return { decision: 'possible', score, reasons, signals };
  }
  // Recruiting agencies repost the same text under their own name.
  if (titleScore >= THRESHOLDS.possibleTitle && text.jaccard >= THRESHOLDS.repostDescription) {
    return { decision: 'possible', score, reasons, signals };
  }
  // A staffing or payroll company's name on a job: a person can tell, the text alone cannot.
  if (titleScore >= THRESHOLDS.autoTitle && vocabulary >= THRESHOLDS.strongVocabulary && corroboration >= THRESHOLDS.otherCompanyCorroboration) {
    return { decision: 'possible', score, reasons, signals };
  }
  return { decision: 'none', score, reasons, signals };
}
