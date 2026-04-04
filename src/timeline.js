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
      div.id = 'timeline-item-' + i;
      div.classList.add('timeline-off');
      fragment.appendChild(div);
    }
    this.parent.appendChild(fragment);
  }

  next() {
    this.position = Math.min(this.position + 1, this.size - 1);
  }

  update(position) {
    this.position = position;
    this.parent.childNodes.forEach(function (elem) {
      if (parseInt(elem.id.split('-')[2], 10) <= position) {
        elem.classList.add('timeline-on');
        elem.classList.remove('timeline-off');
      } else {
        elem.classList.add('timeline-off');
        elem.classList.remove('timeline-on');
      }
    });
  }
}

export default Timeline;
