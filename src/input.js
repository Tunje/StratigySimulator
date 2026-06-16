export class InputManager {
  constructor(canvas, camera, onMouseMove, onClick) {
    this.canvas = canvas;
    this.camera = camera;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };

    this._drag = null; // { startX, startY, camX, camY }
    this._dragMoved  = false;
    this._onMouseMove = onMouseMove;
    this._onClick     = onClick;

    canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    canvas.addEventListener('mousemove',   e => this._onMouseMoveEvt(e));
    canvas.addEventListener('mouseup',     e => this._onMouseUp(e));
    canvas.addEventListener('mouseleave',  e => this._onMouseUp(e));
    canvas.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
    window.addEventListener('keydown',     e => this.keys.add(e.code));
    window.addEventListener('keyup',       e => this.keys.delete(e.code));
    window.addEventListener('blur',        () => this.keys.clear());
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    this._drag      = { startX: e.clientX, startY: e.clientY, camX: this.camera.x, camY: this.camera.y };
    this._dragMoved = false;
    this.canvas.classList.add('grabbing');
  }

  _onMouseMoveEvt(e) {
    const { clientX: x, clientY: y } = e;
    this.mouse = { x, y };

    if (this._drag) {
      const dx = x - this._drag.startX;
      const dy = y - this._drag.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._dragMoved = true;
      this.camera.x = this._drag.camX - dx / this.camera.zoom;
      this.camera.y = this._drag.camY - dy / this.camera.zoom;
      this.camera._clamp(this.canvas.width, this.canvas.height);
    }

    if (this._onMouseMove) this._onMouseMove(x, y);
  }

  _onMouseUp(e) {
    if (this._drag && !this._dragMoved && this._onClick) {
      this._onClick(e.clientX, e.clientY);
    }
    this._drag = null;
    this.canvas.classList.remove('grabbing');
  }

  _onWheel(e) {
    e.preventDefault();
    this.camera.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1 : -1,
      this.canvas.width, this.canvas.height);
  }
}
