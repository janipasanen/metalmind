export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  escalateOnFailure: boolean;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 500,
  escalateOnFailure: true,
};

export class RetryManager {
  private policy: RetryPolicy;
  private attemptCount = 0;
  private totalErrors = 0;

  constructor(policy: Partial<RetryPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  get shouldRetry(): boolean {
    return this.attemptCount < this.policy.maxRetries;
  }

  get shouldEscalate(): boolean {
    return (
      this.policy.escalateOnFailure &&
      this.totalErrors >= this.policy.maxRetries
    );
  }

  async execute<T>(
    fn: () => Promise<T>,
    onError?: (err: unknown) => void,
  ): Promise<T> {
    while (true) {
      try {
        this.attemptCount++;
        const result = await fn();
        this.attemptCount = 0;
        return result;
      } catch (err) {
        this.totalErrors++;
        onError?.(err);
        if (!this.shouldRetry) {
          this.attemptCount = 0;
          throw err;
        }
        await this.delay();
      }
    }
  }

  reset(): void {
    this.attemptCount = 0;
    this.totalErrors = 0;
  }

  private delay(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, this.policy.backoffMs),
    );
  }
}
