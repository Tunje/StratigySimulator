export const TILE_SIZE = 32;

export class GameMap {
  constructor(width = 256, height = 256) {
    this.width  = width;
    this.height = height;
  }

  render(ctx, camera) {
    const { x: camX, y: camY, zoom } = camera;
    const screenW = ctx.canvas.width;
    const screenH = ctx.canvas.height;
    const tileSize = TILE_SIZE * zoom;

    // Fill background
    ctx.fillStyle = '#1a1e2a';
    ctx.fillRect(0, 0, screenW, screenH);

    // Visible tile range
    const startTX = Math.max(0, Math.floor(camX / TILE_SIZE));
    const startTY = Math.max(0, Math.floor(camY / TILE_SIZE));
    const endTX   = Math.min(this.width  - 1, Math.ceil((camX + screenW / zoom) / TILE_SIZE));
    const endTY   = Math.min(this.height - 1, Math.ceil((camY + screenH / zoom) / TILE_SIZE));

    // Fill map area
    const mapLeft   = (0           - camX) * zoom;
    const mapTop    = (0           - camY) * zoom;
    const mapRight  = (this.width  * TILE_SIZE - camX) * zoom;
    const mapBottom = (this.height * TILE_SIZE - camY) * zoom;

    ctx.fillStyle = '#c8a97a';
    ctx.fillRect(mapLeft, mapTop, mapRight - mapLeft, mapBottom - mapTop);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let tx = startTX; tx <= endTX + 1; tx++) {
      const sx = (tx * TILE_SIZE - camX) * zoom;
      ctx.moveTo(sx, mapTop);
      ctx.lineTo(sx, mapBottom);
    }
    for (let ty = startTY; ty <= endTY + 1; ty++) {
      const sy = (ty * TILE_SIZE - camY) * zoom;
      ctx.moveTo(mapLeft, sy);
      ctx.lineTo(mapRight, sy);
    }
    ctx.stroke();

    // Map border
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mapLeft, mapTop, mapRight - mapLeft, mapBottom - mapTop);
  }

  renderMinimap(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c8a97a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return 0;
  }
}
