// One motion pair per animation frame across all pools. Loading a window or
// restoring several contexts must yield between pairs so the UI can respond.
const queues = new Set();
let request = null;

function schedule() {
  if (request !== null || !queues.size) return;
  request = requestAnimationFrame(() => {
    request = null;
    // Displayed pairs across all panes take precedence over backfill. Moving
    // each serviced queue to the end also gives other panes a turn.
    const queue = [...queues].find((q) => q.jobs.has(q.priority))
      || queues.values().next().value;
    queues.delete(queue);
    const key = queue.jobs.has(queue.priority) ? queue.priority : queue.jobs.keys().next().value;
    const run = queue.jobs.get(key);
    queue.jobs.delete(key);
    if (queue.jobs.size) queues.add(queue);
    try {
      run();
    } finally {
      // An unrelated renderer error must not strand work belonging to other
      // panes. The failing job is removed and its error still reaches callers.
      schedule();
    }
  });
}

function remove(queue) {
  queues.delete(queue);
  if (!queues.size && request !== null) {
    cancelAnimationFrame(request);
    request = null;
  }
}

export default class FlowQueue {
  constructor() {
    this.jobs = new Map();
    this.priority = null;
  }

  add(key, run) {
    this.jobs.set(key, run);
    queues.add(this);
    schedule();
  }

  prioritize(key) {
    this.priority = key;
  }

  retain(keys) {
    for (const key of this.jobs.keys()) {
      if (!keys.has(key)) this.jobs.delete(key);
    }
    if (!this.jobs.size) remove(this);
  }

  clear() {
    this.jobs.clear();
    this.priority = null;
    remove(this);
  }
}
