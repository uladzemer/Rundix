// Follow layout changes only while the reader has stayed at the latest messages.
class WorkbenchTranscriptScroll {
  constructor(container) {
    this.container = container;
    this.following = true;
    this.lastTop = container.scrollTop;
    this.frame = null;
    this.disposed = false;
    this.observed = [];
    this.onScroll = () => this.readIntent();
    this.onLayout = () => this.schedule();
    container.addEventListener('scroll', this.onScroll, { passive: true });
    container.addEventListener('load', this.onLayout, true);
    container.addEventListener('toggle', this.onLayout, true);
    this.observer = new ResizeObserver(this.onLayout);
    this.observer.observe(container);
  }
  gap() { return this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop; }
  readIntent() {
    const top = this.container.scrollTop;
    // A larger scrollHeight/smaller viewport alone is not a reader scrolling up.
    if (Math.abs(top - this.lastTop) > 0.5) this.following = this.gap() < 60;
    this.lastTop = top;
  }
  capture(owner) {
    if (owner !== this.owner) {
      cancelAnimationFrame(this.frame);this.frame = null;
      this.owner = owner;this.following = true;this.lastTop = this.container.scrollTop;
    } else this.readIntent();
    return { height: this.container.scrollHeight, top: this.container.scrollTop, following: this.following };
  }
  afterUpdate() {
    this.lastTop = this.container.scrollTop;
    for (const node of this.observed) this.observer.unobserve(node);
    // Observe only the tail, rather than every message in a large history.
    const last = this.container.lastElementChild;
    this.observed = last ? [last.previousElementSibling, last].filter(Boolean) : [];
    for (const node of this.observed) this.observer.observe(node, { box: 'border-box' });
    this.schedule();
  }
  schedule() {
    if (this.disposed || this.frame !== null) return;
    const owner = this.owner;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed || owner !== this.owner) return;
      this.readIntent();
      if (this.following) this.toBottom();
    });
  }
  toBottom() {
    this.following = true;
    this.container.scrollTop = this.container.scrollHeight;
    this.lastTop = this.container.scrollTop;
  }
  restore(top) {
    this.container.scrollTop = top;
    this.lastTop = this.container.scrollTop;
    this.following = this.gap() < 60;
  }
  dispose() {
    this.disposed = true;cancelAnimationFrame(this.frame);this.frame = null;
    this.observer.disconnect();
    this.container.removeEventListener('scroll', this.onScroll);
    this.container.removeEventListener('load', this.onLayout, true);
    this.container.removeEventListener('toggle', this.onLayout, true);
  }
}
