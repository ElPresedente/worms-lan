/** A monotonic token bucket; wall clock changes must not refill it. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(burst) || burst < 1 || !Number.isFinite(now)) throw new RangeError('Invalid token bucket');
    this.tokens = burst; this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) * this.rate / 1000);
    this.last = Math.max(now, this.last);
    if (this.tokens < 1) return false;
    this.tokens--; return true;
  }
}
export type Reservation = 'accepted' | 'duplicate-id' | 'resource-limit';
export class RequestIds {
  private readonly requests = new Set<string>();
  private readonly commands = new Set<string>();
  constructor(private readonly limit: number) {}
  /** Atomically reserve both IDs; a refused duplicate never consumes the other ID. */
  reserve(requestId: string, commandId?: string): Reservation {
    if (this.requests.has(requestId) || (commandId !== undefined && this.commands.has(commandId))) return 'duplicate-id';
    if (this.requests.size >= this.limit) return 'resource-limit';
    this.requests.add(requestId); if (commandId !== undefined) this.commands.add(commandId);
    return 'accepted';
  }
}
/** Sustained overload: at least one refusal each second for five seconds. */
export class RateAbuse {
  private first: number | undefined;
  private last: number | undefined;
  denied(now: number): boolean {
    if (this.last === undefined || now - this.last > 1000) this.first = now;
    this.last = now;
    return now - this.first! >= 5000;
  }
}
