import { isInterviewStage, isOutcomeStage, type Stage } from './constants';

/** The stages an application moves through, in order. Rejected ends the journey but is not a step forward. */
export const PIPELINE_STAGES = ['Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_SHORT_LABELS: Record<PipelineStage, string> = {
  Applied: 'Applied',
  'Recruiter Screen': 'Screen',
  'Technical Interview': 'Technical',
  'Final Interview': 'Final',
  Offer: 'Offer'
};

/** How far along a stage is: 0 for Applied up to 4 for Offer. Rejected moves nothing forward, so it is 0. */
export function stageRank(stage: Stage | string): number {
  return Math.max(0, PIPELINE_STAGES.indexOf(stage as PipelineStage));
}

/**
 * The furthest stage reached, from the stages of an application's steps, in any order. A rejection
 * keeps what was reached, and going straight to Technical Interview has passed Recruiter Screen too.
 * A step put in by mistake is corrected by removing it, so every step there counts.
 */
export function furthestStage(stages: Iterable<Stage | string>): PipelineStage {
  let furthest = 0;
  for (const stage of stages) furthest = Math.max(furthest, stageRank(stage));
  return PIPELINE_STAGES[furthest];
}

/**
 * The stage an application is at: its latest step's, by when each takes place, or Applied before it
 * has any. Two at the same moment go by the one put in later.
 */
export function currentStage(steps: Iterable<{ stage: Stage | string; at: string; id: number }>): Stage {
  let latest: { stage: Stage | string; at: string; id: number } | null = null;
  for (const step of steps) if (!latest || step.at > latest.at || (step.at === latest.at && step.id > latest.id)) latest = step;
  return (latest?.stage as Stage | undefined) ?? 'Applied';
}

/**
 * The interviews an offer or a rejection takes off a timeline when saved: those after it, which
 * will not happen now. The host removes the same ones; the form names them first.
 */
export function interviewsEndedBy<T extends { id: number; stage: string; at: string }>(steps: T[], outcome: { stage: string; at: string; id?: number }): T[] {
  if (!isOutcomeStage(outcome.stage)) return [];
  return steps.filter((step) => step.id !== outcome.id && isInterviewStage(step.stage) && step.at > outcome.at);
}

export interface PassRate {
  /** Applications that reached this stage. */
  reached: number;
  /** Applications that reached the stage before it. */
  from: number;
  /** Null when nothing reached the previous stage: there is no rate to speak of, not 0%. */
  percent: number | null;
}

export interface ProcessStats {
  applications: number;
  interviews: number;
  /** Ever reached Technical Interview. */
  technical: number;
  /** Ever reached Offer. */
  offers: number;
  screenPass: PassRate;
  technicalPass: PassRate;
  interviewPass: PassRate;
  offerPass: PassRate;
  /** Offers out of all applications. */
  success: PassRate;
}

export function passRate(reached: number, from: number): PassRate {
  return { reached, from, percent: from === 0 ? null : Math.round((reached / from) * 1000) / 10 };
}

/** How many applications ever reached each stage. */
export interface ReachedCounts {
  applications: number;
  screen: number;
  technical: number;
  final: number;
  offers: number;
}

/** Pass rates from each application's furthest stage. */
export function computeStats(furthest: PipelineStage[], interviews: number): ProcessStats {
  const reached = (stage: PipelineStage) => {
    const index = PIPELINE_STAGES.indexOf(stage);
    return furthest.filter((value) => PIPELINE_STAGES.indexOf(value) >= index).length;
  };
  return statsFromCounts(
    { applications: furthest.length, screen: reached('Recruiter Screen'), technical: reached('Technical Interview'), final: reached('Final Interview'), offers: reached('Offer') },
    interviews
  );
}

export function statsFromCounts({ applications, screen, technical, final, offers }: ReachedCounts, interviews: number): ProcessStats {
  return {
    applications,
    interviews,
    technical,
    offers,
    screenPass: passRate(screen, applications),
    technicalPass: passRate(technical, screen),
    interviewPass: passRate(final, technical),
    offerPass: passRate(offers, final),
    success: passRate(offers, applications)
  };
}
