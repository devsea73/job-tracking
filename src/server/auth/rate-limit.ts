export interface RateLimitOptions {
  /** Failures allowed for one username from one address before it is locked out. */
  maxPerAccount: number;
  /** Failures allowed from one address across all usernames. */
  maxPerAddress: number;
  windowMs: number;
  now?: () => number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxPerAccount: 5,
  maxPerAddress: 30,
  windowMs: 15 * 60 * 1000
};

interface Bucket {
  failures: number;
  windowEndsAt: number;
}

/** Slows password guessing. Held in memory: restarting the host clears it, which is acceptable on a LAN. */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions = DEFAULT_RATE_LIMIT) {
    this.now = options.now ?? Date.now;
  }

  private read(key: string): Bucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (bucket.windowEndsAt <= this.now()) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  /** Seconds until the next attempt is allowed, or null when it is allowed now. */
  retryAfter(address: string, username: string): number | null {
    const account = this.read(accountKey(address, username));
    const addr = this.read(addressKey(address));
    let until = 0;
    if (account && account.failures >= this.options.maxPerAccount) until = account.windowEndsAt;
    if (addr && addr.failures >= this.options.maxPerAddress) until = Math.max(until, addr.windowEndsAt);
    return until ? Math.max(1, Math.ceil((until - this.now()) / 1000)) : null;
  }

  recordFailure(address: string, username: string): void {
    this.bump(accountKey(address, username));
    this.bump(addressKey(address));
    this.prune();
  }

  /** Clears the account's failures, and takes this attempt, counted when it began, back off the address. */
  recordSuccess(address: string, username: string): void {
    this.buckets.delete(accountKey(address, username));
    const addr = this.read(addressKey(address));
    if (addr && addr.failures > 0) addr.failures -= 1;
  }

  private bump(key: string): void {
    const bucket = this.read(key);
    if (bucket) bucket.failures += 1;
    else this.buckets.set(key, { failures: 1, windowEndsAt: this.now() + this.options.windowMs });
  }

  private prune(): void {
    if (this.buckets.size < 5_000) return;
    for (const key of [...this.buckets.keys()]) this.read(key);
  }
}

const accountKey = (address: string, username: string) => `account:${address}:${username.toLowerCase()}`;
const addressKey = (address: string) => `address:${address}`;
