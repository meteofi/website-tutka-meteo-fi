class Timeline {
  constructor(size, parent) {
    this.size = size;
    this.parent = parent;
    this.position = 0;
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

  next() {
    this.position = Math.min(this.position + 1, this.size - 1);
  }

  update(position) {
    this.position = position;
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
}

export default Timeline;
