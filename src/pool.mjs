// Bounded concurrency pool with FIFO queue (R3).
// run() returns { started, result } — result is null on agent failure;
// started is false when the pool was closed (interrupt) before the call began,
// so the caller can distinguish "agent failed" from "never ran" for journaling.

export class Pool {
  constructor(limit = 8) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    this.running = 0;
    this.queue = [];
    this.closed = false;
  }

  run(fn) {
    return new Promise((resolve) => {
      const entry = { fn, resolve };
      if (this.closed) return resolve({ started: false, result: null });
      this.queue.push(entry);
      this.#pump();
    });
  }

  #pump() {
    while (!this.closed && this.running < this.limit && this.queue.length > 0) {
      const { fn, resolve } = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(fn)
        .then((result) => resolve({ started: true, result: result ?? null }))
        .catch(() => resolve({ started: true, result: null }))
        .finally(() => {
          this.running--;
          this.#pump();
        });
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.resolve({ started: false, result: null });
    }
  }
}
