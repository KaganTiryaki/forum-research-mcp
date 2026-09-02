type Wait = (milliseconds: number) => Promise<void>;

const sleep: Wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class SourceRateLimiter {
  private readonly lastRequest = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: Wait = sleep,
  ) {}

  async acquire(sourceId: string, intervalMs: number): Promise<void> {
    const previous = this.queues.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.queues.set(sourceId, tail);

    await previous;
    try {
      const last = this.lastRequest.get(sourceId);
      const remaining = last === undefined ? 0 : intervalMs - (this.now() - last);
      if (remaining > 0) await this.wait(remaining);
      this.lastRequest.set(sourceId, this.now());
    } finally {
      release();
      if (this.queues.get(sourceId) === tail) this.queues.delete(sourceId);
    }
  }
}

export const defaultRateLimiter = new SourceRateLimiter();
