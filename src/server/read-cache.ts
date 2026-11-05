/**
 * Finished responses for read-only requests, kept until the data could have changed.
 *
 * Every write in the app goes through this one server process, so a generation counter knows
 * exactly when something changed: any write moves it on, and everything cached under an older
 * generation is ignored. This also spares serializing large responses again, and means ten people
 * asking for the same thing cost one query. Sign-in is checked before this is ever reached.
 */
export class ReadCache {
  private generation = 0;
  private size = 0;
  private readonly entries = new Map<string, { generation: number; at: number; json: string }>();

  constructor(
    /** Interview dates turn from upcoming to past with no write, so nothing lives longer than this. */
    private readonly maxAgeMs = 15_000,
    private readonly maxBytes = 64 * 1024 * 1024
  ) {}

  /** Call on every write. */
  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
    this.size = 0;
  }

  /** The cached response as JSON text, computing and storing it if needed. */
  read(key: string, compute: () => unknown, now = Date.now()): string {
    const hit = this.entries.get(key);
    if (hit && hit.generation === this.generation && now - hit.at < this.maxAgeMs) {
      // Reinserted so that the Map's order runs from least to most recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.json;
    }
    if (hit) {
      this.entries.delete(key);
      this.size -= hit.json.length;
    }
    const json = JSON.stringify(compute());
    this.entries.set(key, { generation: this.generation, at: now, json });
    this.size += json.length;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.size <= this.maxBytes || oldestKey === key) break;
      this.entries.delete(oldestKey);
      this.size -= oldest.json.length;
    }
    return json;
  }
}
