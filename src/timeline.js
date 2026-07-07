class Timeline {
  constructor(size, parent) {
    this.size = size;
    this.parent = parent;
    this.createTimeline();
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
