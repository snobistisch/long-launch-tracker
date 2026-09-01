export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly maximum: number;

  constructor(maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("Semaphore maximum must be a positive integer");
    }
    this.maximum = maximum;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

class StartRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  async wait(): Promise<void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const waitMs = Math.max(0, this.nextStart - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    this.nextStart = Date.now() + this.intervalMs;
    release();
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class JsonHttpClient {
  private readonly semaphore: Semaphore;
  private readonly limiter: StartRateLimiter;
  private readonly maxAttempts: number;

  constructor(
    concurrency: number,
    requestsPerSecond: number,
    maxAttempts = 5,
  ) {
    this.semaphore = new Semaphore(concurrency);
    this.limiter = new StartRateLimiter(Math.ceil(1_000 / requestsPerSecond));
    this.maxAttempts = maxAttempts;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    return this.semaphore.run(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        await this.limiter.wait();
        try {
          const response = await fetch(url, {
            ...init,
            headers: {
              accept: "application/json",
              ...(init.body ? { "content-type": "application/json" } : {}),
              ...init.headers,
            },
          });

          if (response.ok) return (await response.json()) as T;

          const body = (await response.text()).slice(0, 500);
          const error = new Error(`HTTP ${response.status} from ${url}: ${body}`);
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
          // The public Robinhood RPC can enforce a longer rolling quota than a simple
          // per-second limit. Give 429s a materially longer cooldown than transient 5xxs.
          const retryMs =
            retryAfterMs(response) ?? (response.status === 429 ? 2_000 : 250) * 2 ** attempt;
          await sleep(retryMs + Math.floor(Math.random() * 100));
        } catch (error) {
          lastError = error;
          if (attempt + 1 >= this.maxAttempts) break;
          await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    });
  }
}

export async function mapLimited<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const semaphore = new Semaphore(concurrency);
  return Promise.all(values.map((value, index) => semaphore.run(() => operation(value, index))));
}
