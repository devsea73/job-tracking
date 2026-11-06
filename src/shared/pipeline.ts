import type { ApplicationStatus } from './constants';

/** The stages an application moves through. Rejected ends the journey but is not a stage. */
export const PIPELINE_STAGES = ['Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_SHORT_LABELS: Record<PipelineStage, string> = {
  Applied: 'Applied',
  'Recruiter Screen': 'Screen',
  'Technical Interview': 'Technical',
  'Final Interview': 'Final',
  Offer: 'Offer'
};

/**
 * The highest stage an application ever reached, from its status history. A job that got to
 * Technical Interview and was later rejected still reached it, and going straight from Applied
 * to Technical Interview also counts as having passed Recruiter Screen.
 */
/**
 * The furthest stage reached, from the statuses in the order they were set. A rejection keeps
 * the furthest stage. Any other move back is a correction: a misclicked stage was never reached.
 */
export function furthestStage(statuses: Iterable<ApplicationStatus>): PipelineStage {
  let furthest = 0;
  for (const status of statuses) {
    if (status === 'Rejected') continue;
    furthest = Math.max(0, PIPELINE_STAGES.indexOf(status as PipelineStage));
  }
  return PIPELINE_STAGES[furthest];
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
