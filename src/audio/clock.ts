// The single lookahead scheduler (~25 ms) that drives music, the effort layer and ambience.
// Jobs receive the audio clock time and return false when they have nothing left to do; the
// interval only runs while at least one job is alive and the clock is not paused.

export type ClockJob = (now: number) => boolean;

export class Clock {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly jobs = new Set<ClockJob>();
  private paused = false;

  constructor(
    private readonly now: () => number,
    private readonly interval = 25,
  ) {}

  /** Register a job (idempotent) and run it once immediately. */
  add(job: ClockJob): void {
    const isNew = !this.jobs.has(job);
    this.jobs.add(job);
    if (isNew && !this.paused) this.run(job, this.now());
    this.ensure();
  }

  has(job: ClockJob): boolean {
    return this.jobs.has(job);
  }

  pause(): void {
    this.paused = true;
    this.halt();
  }

  resume(): void {
    this.paused = false;
    this.ensure();
  }

  dispose(): void {
    this.jobs.clear();
    this.halt();
  }

  private ensure(): void {
    if (this.timer === null && !this.paused && this.jobs.size > 0) {
      this.timer = setInterval(this.tick, this.interval);
    }
  }

  private halt(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private run(job: ClockJob, now: number): void {
    let keep = false;
    try {
      keep = job(now);
    } catch (err) {
      console.error('[audio] scheduler job failed', err);
    }
    if (!keep) this.jobs.delete(job);
  }

  private readonly tick = (): void => {
    const now = this.now();
    for (const job of [...this.jobs]) this.run(job, now);
    if (this.jobs.size === 0) this.halt();
  };
}
