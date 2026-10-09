// Bounded concurrency pool. Calls beyond the limit queue in FIFO order.
// drain() stops dequeuing; queued tasks resolve as cancelled (null via caller).
export class Pool {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
    this.draining = false;
    this.maxActive = 0;
  }

  run(fn) {
    return new Promise((resolve) => {
      if (this.draining) return resolve(null);
      this.queue.push({ fn, resolve });
      this.#pump();
    });
  }

  #pump() {
    while (!this.draining && this.active < this.limit && this.queue.length) {
      const { fn, resolve } = this.queue.shift();
      this.active++;
      if (this.active > this.maxActive) this.maxActive = this.active;
      Promise.resolve()
        .then(fn)
        .then(
          (v) => { this.active--; resolve(v); this.#pump(); },
          (e) => { this.active--; resolve({ __agentflowError: e }); this.#pump(); },
        );
    }
  }

  // Stop dequeuing and resolve every queued task as cancelled.
  // In-flight tasks keep running; the caller owns their grace/kill policy.
  drain() {
    this.draining = true;
    for (const t of this.queue.splice(0)) t.resolve(null);
  }
}
