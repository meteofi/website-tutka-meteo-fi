class Timeline {
  constructor(size, parent) {
    this.size = size;
    this.parent = parent;
    this.position = 0;
    this.createTimeline();
  }

  createTimeline() {
    let i = 0;
    this.parent.innerHTML = '';
    // eslint-disable-next-line no-plusplus
    for (i = 0; i < this.size; i++) {
      const div = document.createElement('div');
      div.id = 'timeline-item-' + i;
      div.classList.add('timeline-off');
      this.parent.appendChild(div);
    }
  }
}

Timeline.prototype.next = function next() {
  this.position = Math.min(this.position + 1, this.size);
};

Timeline.prototype.previous = function previous() {

};

Timeline.prototype.update = function update(position) {
  this.position = position;
  const elementsArray = this.parent.childNodes;
  elementsArray.forEach(function (elem) {
    if (elem.id.split('-')[2] <= position) {
      elem.classList.add('timeline-on');
      elem.classList.remove('timeline-off');
    } else {
      elem.classList.add('timeline-off');
      elem.classList.remove('timeline-on');
    }
  });
}

export default Timeline;
