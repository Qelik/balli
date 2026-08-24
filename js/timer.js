/**
 * Round clock. rAF-driven and read off performance.now(), so a dropped frame or
 * a backgrounded tab cannot make the round longer than it should be.
 */
export class RoundTimer {
    raf = 0;
    endsAt = 0;
    span = 0;
    lastWholeSecond = -1;
    start(seconds, onTick, onEnd) {
        this.stop();
        this.endsAt = performance.now() + seconds * 1000;
        this.span = seconds * 1000;
        this.lastWholeSecond = -1;
        const frame = () => {
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
    addTime(ms) {
        if (!this.raf)
            return;
        this.endsAt += ms;
        // The progress bar divides by the span; growing it keeps the bar inside its
        // track instead of overflowing when the clock goes past its starting value.
        this.span = Math.max(this.span, this.endsAt - performance.now());
    }
    /** The largest total the round has reached — the progress bar's denominator. */
    get spanMs() {
        return this.span;
    }
    stop() {
        if (this.raf)
            cancelAnimationFrame(this.raf);
        this.raf = 0;
    }
    get running() {
        return this.raf !== 0;
    }
}
//# sourceMappingURL=timer.js.map