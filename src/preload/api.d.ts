import type { JobTrackerBridge } from '../shared/bridge';

declare global {
  interface Window {
    jobTracker: JobTrackerBridge;
  }
}

export {};
