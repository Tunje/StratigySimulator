import { addBullet, addExplosion, addDeath } from './effects.js';
import { Scout } from './captain.js';

const CANNON_RADIUS       = 26;
const CANNON_SPEED        = 10;   // almost stationary — repositioning only
const ARRIVE_THRESH       = 16;
const RELOAD_TIME         = 8.0;  // s between shots
export const BLAST_RADIUS = 130;
const SCATTER_OBSERVED    = 55;   // spotter-designated fire
const SCATTER_UNOBSERVED  = 180;  // firing on stale contact reports

export class ArtilleryCannon {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x          = x;
    this.y          = y;
    this.factionId  = factionId;
    this.facing     = facing;
    this.color      = color;
    this.state      = 'active';
    this.armorClass = 'heavy'; // cannon position is protected

    this._target         = null; // {x, y} fire mission — set by captain
    this._reloadTimer    = RELOAD_TIME * 0.5; // start half-loaded
    this._moveTarget     = null;
    this._shotsRemaining = 0;   // shells left on current fire mission
    this._lastTargetX    = null;
    this._lastTargetY    = null;
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire() {} // crew ducks, cannon itself survives light fire

  setTarget(x, y, unobserved = false) {
    const dist = this._lastTargetX !== null
      ? Math.hypot(x - this._lastTargetX, y - this._lastTargetY)
      : Infinity;

    if (dist > 80) {
      // Genuinely new target — fresh 3-shell mission
      this._shotsRemaining = 3;
      this._lastTargetX    = x;
      this._lastTargetY    = y;
    }

    if (this._shotsRemaining > 0) {
      this._target = { x, y, unobserved };
    }
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    this._moveTarget = { x, y };
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    // Slow repositioning when ordered
    if (this._moveTarget) {
      const dx   = this._moveTarget.x - this.x;
      const dy   = this._moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESH) {
        this.x      += (dx / dist) * CANNON_SPEED * dt;
        this.y      += (dy / dist) * CANNON_SPEED * dt;
        this.facing  = Math.atan2(dy, dx);
      } else {
        this.x = this._moveTarget.x;
        this.y = this._moveTarget.y;
        this._moveTarget = null;
      }
    }

    if (!this._target) return;

    this._reloadTimer -= dt;
    if (this._reloadTimer > 0) return;

    // Fire
    this._fireAt(this._target.x, this._target.y, allUnits, factionMgr);
    this._reloadTimer    = RELOAD_TIME;
    this._shotsRemaining = Math.max(0, this._shotsRemaining - 1);
    this._target         = null; // captain must re-designate
  }

  _fireAt(tx, ty, allUnits, factionMgr) {
    const scatter = this._target?.unobserved ? SCATTER_UNOBSERVED : SCATTER_OBSERVED;
    const angle   = Math.random() * Math.PI * 2;
    const dist    = Math.random() * scatter;
    const ix      = tx + Math.cos(angle) * dist;
    const iy      = ty + Math.sin(angle) * dist;

    addBullet(this.x, this.y, ix, iy, true);
    addExplosion(ix, iy, BLAST_RADIUS);

    // Area damage — kill/injure everything in BLAST_RADIUS with falloff from centre
    const r2 = BLAST_RADIUS * BLAST_RADIUS;
    for (const u of allUnits) {
      if (!u.active) continue;
      const dx = u.x - ix, dy = u.y - iy;
      if (dx * dx + dy * dy > r2) continue;
      const d      = Math.sqrt(dx * dx + dy * dy);
      const chance = (1 - d / BLAST_RADIUS) * 0.85;
      if (Math.random() < chance) {
        u.state = Math.random() < 0.65 ? 'dead' : 'injured';
        if (u.state === 'dead') addDeath(u.x, u.y, u.color);
      }
    }
  }

  draw(ctx, camera) {
    if (this.dead) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = CANNON_RADIUS * zoom;

    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    // Cannon body (wheel + barrel)
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this._target
      ? Math.atan2(this._target.y - this.y, this._target.x - this.x)
      : this.facing);
    ctx.strokeStyle = '#000';
    ctx.fillStyle   = this.color;
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    // Wheels
    [-r * 0.55, r * 0.55].forEach(yo => {
      ctx.beginPath();
      ctx.arc(0, yo, r * 0.38, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
    // Barrel
    ctx.fillRect(0, -r * 0.13, r * 1.9, r * 0.26);
    ctx.strokeRect(0, -r * 0.13, r * 1.9, r * 0.26);
    // Base plate
    ctx.fillRect(-r * 0.45, -r * 0.38, r * 0.9, r * 0.76);
    ctx.strokeRect(-r * 0.45, -r * 0.38, r * 0.9, r * 0.76);
    ctx.restore();

    // Reload arc
    if (this._reloadTimer < RELOAD_TIME) {
      const pct = 1 - this._reloadTimer / RELOAD_TIME;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5 * zoom, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,220,80,0.85)';
      ctx.lineWidth   = Math.max(2, zoom * 2);
      ctx.stroke();
    }

    // Target line
    if (this._target && zoom >= 0.4) {
      const tx = (this._target.x - camera.x) * zoom;
      const ty = (this._target.y - camera.y) * zoom;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = 'rgba(255,120,0,0.35)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([6, 9]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Target cross
      ctx.beginPath();
      ctx.arc(tx, ty, 8 * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,120,0,0.5)';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    if (zoom >= 0.6) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font      = `bold ${Math.max(8, zoom * 6)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('ART', sx, sy + r * 1.5 + 10 * zoom);
    }

    ctx.restore();
  }
}

// ── Spotter ───────────────────────────────────────────────────────────────────
// Scout variant that relays precise coordinates to artillery.
export class Spotter extends Scout {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    super(x, y, factionId, facing, color);
    this._spotTarget = null; // {x, y} — most recent designated target
  }

  update(dt, allUnits, factionMgr) {
    super.update(dt, allUnits, factionMgr);

    // While observing, track the best target for artillery
    if (!this._isObserving && !this._isFleeing) {
      this._spotTarget = null;
      return;
    }

    const enemies = allUnits.filter(u =>
      u !== this && u.active &&
      factionMgr.areEnemies(this.factionId, u.factionId) &&
      this._canSee(u)
    );
    if (enemies.length === 0) { this._spotTarget = null; return; }

    // Prioritise armored targets, then densest cluster
    const armor = enemies.filter(e => e.armorClass && e.armorClass !== 'none');
    const primary = armor.length > 0 ? armor[0] : enemies[0];
    this._spotTarget = { x: primary.x, y: primary.y };
  }

  draw(ctx, camera, showCones = true) {
    super.draw(ctx, camera, showCones);
    if (!this._spotTarget || !this.active) return;

    const zoom = camera.zoom;
    const tx   = (this._spotTarget.x - camera.x) * zoom;
    const ty   = (this._spotTarget.y - camera.y) * zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(tx, ty, 10 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,120,0,0.7)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}
