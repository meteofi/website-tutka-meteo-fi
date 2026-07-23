class Timeline {
  constructor(size, parent, { onSeek } = {}) {
    this.size = size;
    this.parent = parent;
    // Optional seek callback — when present, the strip becomes tap/drag
    // scrubbable. Kept optional so a non-interactive timeline (or a test) can
    // construct one without wiring playback.
    this.onSeek = onSeek || null;
    this.createTimeline();
    if (this.onSeek) this.enableScrub();
  }

  createTimeline() {
    this.parent.innerHTML = '';
    const fragment = new DocumentFragment();
    for (let i = 0; i < this.size; i++) {
      const div = document.createElement('div');
      div.id = `timeline-item-${i}`;
      fragment.appendChild(div);
    }
    this.parent.appendChild(fragment);
  }

  // Map a client X coordinate to a frame index within the strip.
  indexAt(clientX) {
    const rect = this.parent.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const i = Math.floor(((clientX - rect.left) / rect.width) * this.size);
    return Math.max(0, Math.min(this.size - 1, i));
  }

  // Tap or drag anywhere on the strip to seek. Pointer capture keeps the drag
  // live even when the finger strays off the thin track; onSeek fires only when
  // the target cell changes, so a full sweep is at most `size` callbacks.
  enableScrub() {
    let scrubbing = false;
    let last = -1;
    const fire = (clientX) => {
      const i = this.indexAt(clientX);
      if (i === last) return;
      last = i;
      this.onSeek(i);
    };
    this.parent.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return; // ignore secondary/middle mouse buttons
      scrubbing = true;
      last = -1;
      this.parent.setPointerCapture(e.pointerId);
      fire(e.clientX);
      e.preventDefault();
    });
    this.parent.addEventListener('pointermove', (e) => {
      if (scrubbing) fire(e.clientX);
    });
    const end = () => { scrubbing = false; last = -1; };
    this.parent.addEventListener('pointerup', end);
    this.parent.addEventListener('pointercancel', end);
  }

  update(position) {
    const target = Math.round(position);
    const n = this.parent.children.length;
    for (let i = 0; i < n; i++) {
      this.parent.children[i].classList.toggle('timeline-current', i === target);
    }
  }

  setLoadState(index, loaded) {
    const elem = this.parent.children[index];
    if (!elem) return;
    elem.classList.toggle('timeline-loading', !loaded);
  }

  // Flow-pending means the raw bitmap is loaded but the interpolator
  // doesn't have a flow field yet for the pair starting at this
  // index. Shown as a distinct color so the user can see which
  // timesteps will "jump" during playback because the warp has no
  // intermediate to render.
  setFlowPending(index, pending) {
    const elem = this.parent.children[index];
    if (!elem) return;
    elem.classList.toggle('timeline-flow-pending', pending);
  }
}

export default Timeline;
