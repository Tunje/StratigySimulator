import { TILE_SIZE } from './map.js';

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 6;
const ZOOM_SPEED = 0.12;
const PAN_SPEED = 400; // px/sec at zoom=1

export class Camera {
  constructor(mapWidth, mapHeight) {
    this.mapW = mapWidth  * TILE_SIZE;
    this.mapH = mapHeight * TILE_SIZE;
    this.x    = 0; // world-space top-left
    this.y    = 0;
    this.zoom = 1;
    this._targetZoom = 1;
  }

  // Center viewport on world pixel position
  centerOn(worldX, worldY, screenW, screenH) {
    this.x = worldX - (screenW / 2) / this.zoom;
    this.y = worldY - (screenH / 2) / this.zoom;
    this._clamp(screenW, screenH);
  }

  // Called each frame with elapsed seconds
  update(dt, keys, screenW, screenH) {
    const speed = (PAN_SPEED / this.zoom) * dt;

    if (keys.has('KeyW') || keys.has('ArrowUp'))    this.y -= speed;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  this.y += speed;
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  this.x -= speed;
    if (keys.has('KeyD') || keys.has('ArrowRight')) this.x += speed;

    this._clamp(screenW, screenH);
  }

  // Zoom toward a screen-space pivot point
  zoomAt(screenX, screenY, delta, screenW, screenH) {
    const worldX = this.x + screenX / this.zoom;
    const worldY = this.y + screenY / this.zoom;

    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * (1 - delta * ZOOM_SPEED)));

    // Keep pivot point fixed on screen
    this.x = worldX - screenX / this.zoom;
    this.y = worldY - screenY / this.zoom;

    this._clamp(screenW, screenH);
  }

  // Pan by screen-space delta (drag)
  pan(dsx, dsy, screenW, screenH) {
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
    this._clamp(screenW, screenH);
  }

  _clamp(screenW, screenH) {
    const visW = screenW / this.zoom;
    const visH = screenH / this.zoom;
    this.x = Math.max(0, Math.min(this.mapW - visW, this.x));
    this.y = Math.max(0, Math.min(this.mapH - visH, this.y));
  }

  // Convert screen coords → world tile coords
  screenToTile(sx, sy) {
    const wx = this.x + sx / this.zoom;
    const wy = this.y + sy / this.zoom;
    return { tx: Math.floor(wx / TILE_SIZE), ty: Math.floor(wy / TILE_SIZE) };
  }

  // Minimap viewport rect (0-1 normalized)
  viewportRect() {
    return {
      x: this.x / this.mapW,
      y: this.y / this.mapH,
      w: (window.innerWidth  / this.zoom) / this.mapW,
      h: (window.innerHeight / this.zoom) / this.mapH,
    };
  }
}
