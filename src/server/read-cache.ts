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
  private readonly values = new Map<string, { generation: number; at: number; value: unknown }>();

  constructor(
    /** Interview dates turn from upcoming to past with no write, so nothing lives longer than this. */
    private readonly maxAgeMs = 15_000,
    private readonly maxBytes = 64 * 1024 * 1024,
    /** Values are the work behind many answers, not answers: a few are plenty. */
    private readonly maxValues = 24
  ) {}

  /** Call on every write. */
  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
    this.values.clear();
    this.size = 0;
  }

  /**
   * Something worked out from the data that several answers are built from, such as everyone's
   * numbers for a range, which each person's answer then marks as theirs. Kept, like the answers,
   * until anything changes.
   */
  value<T>(key: string, compute: () => T, now = Date.now()): T {
    const hit = this.peek<T>(key, now);
    if (hit !== undefined) return hit;
    const value = compute();
    this.values.delete(key);
    this.values.set(key, { generation: this.generation, at: now, value });
    for (const oldest of this.values.keys()) {
      if (this.values.size <= this.maxValues) break;
      this.values.delete(oldest);
    }
    return value;
  }

  /** A value already worked out and still current, without working it out if it is not. */
  peek<T>(key: string, now = Date.now()): T | undefined {
    const hit = this.values.get(key);
    if (!hit || hit.generation !== this.generation || now - hit.at >= this.maxAgeMs) return undefined;
    this.values.delete(key);
    this.values.set(key, hit);
    return hit.value as T;
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
