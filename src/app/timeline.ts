// Game-time timers. Sessions wait on these instead of setTimeout so their beats (countdown, the
// hang after a whipper, the celebration) pause with the game and follow the debug time scale.

interface Wait {
  at: number;
  resolve: () => void;
}

export class Timeline {
  private t = 0;
  private readonly waits: Wait[] = [];

  /** Seconds of game time since the timeline started. */
  get now(): number {
    return this.t;
  }

  tick(dt: number): void {
    this.t += dt;
    if (!this.waits.length) return;
    for (let i = this.waits.length - 1; i >= 0; i--) {
      const w = this.waits[i];
      if (this.t >= w.at) {
        this.waits.splice(i, 1);
        w.resolve();
      }
    }
  }

  /** Resolves after `seconds` of game time. */
  wait(seconds: number): Promise<void> {
    return new Promise((resolve) => this.waits.push({ at: this.t + Math.max(0, seconds), resolve }));
  }

  /** Drop pending waits (their promises never resolve: callers check their own liveness). */
  clear(): void {
    this.waits.length = 0;
  }
}
