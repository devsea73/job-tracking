import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../shared/api';

/** Tells connected desktop apps that shared data changed, so avatars and highlights update live. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(type: ServerEvent['type'], jobId?: number, extra: Pick<ServerEvent, 'userId' | 'applicationId'> = {}): void {
    this.emitter.emit('event', { type, jobId, ...extra, at: new Date().toISOString() } satisfies ServerEvent);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
