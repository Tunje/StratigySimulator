import { addBullet, addImpact, addDeath } from './effects.js';

const TANK_RADIUS     = 30;
const TANK_SPEED      = 22;
const SHOOT_RANGE     = 380;
const DETECT_RANGE    = 110;
const VISION_ANGLE    = Math.PI * 0.65;
const FIRE_RATE       = 4.5;
const HIT_CHANCE      = 0.78;
const ARRIVE_THRESH   = 18;
const UNDER_FIRE_DUR  = 4.0;
const TURRET_SPEED    = 1.8; // rad/s — turret rotates slowly

export class Tank {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x          = x;
    this.y          = y;
    this.factionId  = factionId;
    this.facing     = facing;
    this.color      = color;
    this.state      = 'active';
    this.armorClass = 'heavy';

    this._moveTarget     = null;
    this._lockedTarget   = null;
    this._shootCooldown  = rand(1.0, FIRE_RATE);
    this._underFireTimer = 0;
    this._turretOffset   = 0; // relative to hull facing
  }

  get active()      { return this.state === 'active';  }
  get dead()        { return this.state === 'dead';    }
  get injured()     { return this.state === 'injured'; }
  get isUnderFire() { return this._underFireTimer > 0; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DUR;
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    this._moveTarget = { x, y };
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    const enemies = allUnits.filter(u =>
      u !== this && u.state !== 'dead' && u.active &&
      factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const visible = enemies.filter(e => this._canSee(e));
    this._lockedTarget = visible.length > 0 ? nearest(this, visible) : null;

    // Turret tracks target
    if (this._lockedTarget) {
      const desired = normalizeAngle(
        Math.atan2(this._lockedTarget.y - this.y, this._lockedTarget.x - this.x) - this.facing
      );
      const diff = normalizeAngle(desired - this._turretOffset);
      const step = TURRET_SPEED * dt;
      this._turretOffset = Math.abs(diff) <= step ? desired : this._turretOffset + Math.sign(diff) * step;
    }

    if (this._lockedTarget && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._shootCooldown = FIRE_RATE + rand(0, 1.5);
    }

    // Tanks hold position to shoot — only move when no target
    if (this._moveTarget && !this._lockedTarget) {
      const dx   = this._moveTarget.x - this.x;
      const dy   = this._moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESH) {
        this.x      += (dx / dist) * TANK_SPEED * dt;
        this.y      += (dy / dist) * TANK_SPEED * dt;
        this.facing  = Math.atan2(dy, dx);
      } else {
        this.x = this._moveTarget.x;
        this.y = this._moveTarget.y;
        this._moveTarget = null;
      }
    }

    // Separation — push away from nearby friendlies so tanks don't stack on infantry
    {
      const SEP = TANK_RADIUS * 3.5;
      let px = 0, py = 0;
      for (const u of allUnits) {
        if (u === this || !u.active || u.factionId !== this.factionId) continue;
        const dx = this.x - u.x, dy = this.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 >= SEP * SEP) continue;
        const d = Math.sqrt(d2);
        px += (dx / d) * (1 - d / SEP);
        py += (dy / d) * (1 - d / SEP);
      }
      const len = Math.sqrt(px * px + py * py);
      if (len > 0.01) {
        this.x += (px / len) * TANK_SPEED * 0.55 * dt;
        this.y += (py / len) * TANK_SPEED * 0.55 * dt;
      }
    }
  }

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DETECT_RANGE) return true;
    if (dist < SHOOT_RANGE) {
      const lookAngle = this.facing + this._turretOffset;
      const diff      = Math.abs(normalizeAngle(Math.atan2(dy, dx) - lookAngle));
      if (diff < VISION_ANGLE / 2) return true;
    }
    return false;
  }

  _shoot(target) {
    // Tank cannon vs armor: high pen chance
    if (target.armorClass && target.armorClass !== 'none') {
      const penChance = target.armorClass === 'heavy' ? 0.65 : 0.90;
      const hit       = Math.random() < penChance;
      target.markUnderFire();
      addBullet(this.x, this.y, target.x, target.y, hit);
      if (hit) {
        addImpact(target.x, target.y);
        target.state = 'dead';
        addDeath(target.x, target.y, target.color);
      }
      return;
    }
    // vs infantry: cannon always kills, high accuracy
    const hit = Math.random() < HIT_CHANCE;
    target.markUnderFire();
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      target.state = 'dead'; // cannon shell — no injury
      addDeath(target.x, target.y, target.color);
    }
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = TANK_RADIUS * zoom;

    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    if (this.active && showCones) {
      const lookAngle = this.facing + this._turretOffset;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, SHOOT_RANGE * zoom, lookAngle - VISION_ANGLE / 2, lookAngle + VISION_ANGLE / 2);
      ctx.closePath();
      ctx.fillStyle   = this._lockedTarget ? 'rgba(255,100,0,0.07)' : 'rgba(200,180,80,0.03)';
      ctx.fill();
      ctx.strokeStyle = this._lockedTarget ? 'rgba(255,100,0,0.22)' : 'rgba(200,180,80,0.09)';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    // Hull
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this.facing);
    ctx.fillStyle   = this.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    ctx.fillRect(-r * 1.3, -r * 0.75, r * 2.6, r * 1.5);
    ctx.strokeRect(-r * 1.3, -r * 0.75, r * 2.6, r * 1.5);
    // Track details
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth   = Math.max(1, zoom * 0.7);
    [-r * 0.58, r * 0.58].forEach(yOff => {
      ctx.beginPath();
      ctx.moveTo(-r * 1.3, yOff); ctx.lineTo(r * 1.3, yOff);
      ctx.stroke();
    });
    ctx.restore();

    // Turret + gun barrel
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this.facing + this._turretOffset);
    ctx.fillStyle   = this.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.fillRect(r * 0.55, -r * 0.13, r * 1.5, r * 0.26);
    ctx.restore();

    if (this.isUnderFire) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5 * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,60,60,${0.4 + pulse * 0.4})`;
      ctx.lineWidth   = Math.max(1, zoom);
      ctx.stroke();
    }

    if (zoom >= 0.7) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font      = `bold ${Math.max(8, zoom * 6)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('TANK', sx, sy + r * 1.4 + 12 * zoom);
    }

    ctx.restore();
  }
}

function nearest(from, list) {
  let best = null, bestD = Infinity;
  for (const t of list) {
    const dx = t.x - from.x, dy = t.y - from.y;
    const d  = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function normalizeAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function rand(min, max) { return min + Math.random() * (max - min); }
