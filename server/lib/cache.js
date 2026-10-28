// TTL map with a ceiling. One sweep loop, unref'd so it never pins the process.
export class Cache {
  constructor({ max = 2000, sweepMs = 60_000 } = {}) {
    this.max = max;
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return value;
    if (this.map.size >= this.max) this.evict();
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  evict() {
    // Map preserves insertion order; drop the oldest quarter.
    let n = Math.ceil(this.max / 4);
    for (const key of this.map.keys()) {
      if (n-- <= 0) break;
      this.map.delete(key);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expires <= now) this.map.delete(key);
    }
  }
}
