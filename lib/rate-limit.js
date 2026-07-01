/**
 * Giới hạn số request trong cửa sổ thời gian (sliding window, in-memory).
 */
class SlidingWindowLimiter {
    constructor(maxEvents, windowMs) {
        this.max = maxEvents;
        this.windowMs = windowMs;
        /** @type {Map<string, number[]>} */
        this.buckets = new Map();
    }

    allow(key) {
        const now = Date.now();
        let times = this.buckets.get(key) || [];
        times = times.filter((t) => now - t < this.windowMs);
        if (times.length >= this.max) return false;
        times.push(now);
        this.buckets.set(key, times);
        return true;
    }

    prune() {
        const now = Date.now();
        for (const [key, times] of this.buckets) {
            const fresh = times.filter((t) => now - t < this.windowMs);
            if (fresh.length === 0) this.buckets.delete(key);
            else this.buckets.set(key, fresh);
        }
    }
}

module.exports = { SlidingWindowLimiter };
