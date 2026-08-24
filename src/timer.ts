/**
 * Round clock. rAF-driven and read off performance.now(), so a dropped frame or
 * a backgrounded tab cannot make the round longer than it should be.
 */
export class RoundTimer {
  private raf = 0;
  private endsAt = 0;
  private span = 0;
  private lastWholeSecond = -1;

  start(
    seconds: number,
    onTick: (remainingMs: number, wholeSecondsLeft: number, crossedSecond: boolean) => void,
    onEnd: () => void,
  ): void {
    this.stop();
    this.endsAt = performance.now() + seconds * 1000;
    this.span = seconds * 1000;
    this.lastWholeSecond = -1;

    const frame = (): void => {
      const remaining = Math.max(0, this.endsAt - performance.now());
      const whole = Math.ceil(remaining / 1000);
      const crossed = whole !== this.lastWholeSecond;
      this.lastWholeSecond = whole;
      onTick(remaining, whole, crossed);
      if (remaining <= 0) {
        this.raf = 0;
        onEnd();
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /**
   * Put time back on the clock. Ignored once the round is over, so a late
   * action cannot resurrect a finished round.
   */
  addTime(ms: number): void {
    if (!this.raf) return;
    this.endsAt += ms;
    // The progress bar divides by the span; growing it keeps the bar inside its
    // track instead of overflowing when the clock goes past its starting value.
    this.span = Math.max(this.span, this.endsAt - performance.now());
  }

  /** The largest total the round has reached — the progress bar's denominator. */
  get spanMs(): number {
    return this.span;
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get running(): boolean {
    return this.raf !== 0;
  }
}
