import { addBullet, addImpact, addDeath } from './effects.js';

const RADIUS          = 8;
const VISION_RANGE    = 220;
const DETECTION_RANGE = VISION_RANGE / 3;
const VISION_ANGLE    = Math.PI;
const MOVE_SPEED      = 55; // world px/sec

const HEAD_TURN_TARGETS  = [-Math.PI * 0.38, 0, Math.PI * 0.38];
const HEAD_TURN_SPEED    = 1.6;
const HEAD_LOCK_SPEED    = 4.0;
const HEAD_TURN_HOLD_MIN = 1.2;
const HEAD_TURN_HOLD_MAX = 4.0;

const HIT_CHANCE_BASE    = 0.50;
const UNDER_FIRE_PENALTY = 0.10;
const MOVE_ACCURACY_PENALTY = 0.15;
const CHANCE_KILL        = 0.40;
const FIRE_RATE_MIN      = 1.5;
const FIRE_RATE_MAX      = 2.5;
const UNDER_FIRE_DURATION = 4.0;
const ARRIVE_THRESHOLD   = 10; // world px — close enough to destination

export class Soldier {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;

    // 'active' | 'injured' | 'dead'
    this.state = 'active';

    this._headOffset   = 0;
    this._headTarget   = 0;
    this._headTimer    = rand(HEAD_TURN_HOLD_MIN, HEAD_TURN_HOLD_MAX);
    this._lockedTarget = null;

    this._shootCooldown  = rand(0.5, FIRE_RATE_MAX);
    this._underFireTimer = 0;
    this._isMoving       = false;
    this._speedMult      = 0.88 + Math.random() * 0.24; // ±12% speed variance
    this.moveTarget      = null; // { x, y } — set by officer orders
    this._isATRifleman   = false; // designated anti-tank rifleman for the platoon
    this._mounted        = false; // true when inside an APC — suppresses all activity
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    this.moveTarget = { x, y };
  }

  // Public — used by officer intelligence gathering
  canSee(other) { return this._canSee(other); }

  get dead()      { return this.state === 'dead';    }
  get injured()   { return this.state === 'injured'; }
  get active()    { return this.state === 'active' && !this._mounted; }
  get isUnderFire() { return this._underFireTimer > 0; }
  get isEngaged()   { return this._lockedTarget !== null; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DURATION;
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    this._isMoving = false;
    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    // All living enemies — includes officers
    const enemies = allUnits.filter(
      u => u !== this && u.state !== 'dead' && factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const activeEnemies  = enemies.filter(e => e.active  || e.state === 'active');
    const injuredEnemies = enemies.filter(e => e.injured || e.state === 'injured');

    // Visible subsets
    const visibleActive  = activeEnemies.filter(e  => this._canSee(e));
    const visibleInjured = injuredEnemies.filter(e => this._canSee(e));

    // Prioritise active enemies; finish off injured only if no active enemies visible
    const visibleTargets = visibleActive.length > 0
      ? visibleActive
      : (visibleActive.length === 0 ? visibleInjured : []);

    this._lockedTarget = visibleTargets.length > 0 ? nearest(this, visibleTargets) : null;

    // Head movement
    if (this._lockedTarget) {
      const desired = normalizeAngle(
        Math.atan2(this._lockedTarget.y - this.y, this._lockedTarget.x - this.x) - this.facing
      );
      const diff = normalizeAngle(desired - this._headOffset);
      const step = HEAD_LOCK_SPEED * dt;
      this._headOffset = Math.abs(diff) <= step ? desired : this._headOffset + Math.sign(diff) * step;
      this._headTimer  = rand(HEAD_TURN_HOLD_MIN, HEAD_TURN_HOLD_MAX);
    } else {
      this._headTimer -= dt;
      if (this._headTimer <= 0) {
        const opts      = HEAD_TURN_TARGETS.filter(t => Math.abs(t - this._headTarget) > 0.1);
        this._headTarget = opts[Math.floor(Math.random() * opts.length)];
        this._headTimer  = rand(HEAD_TURN_HOLD_MIN, HEAD_TURN_HOLD_MAX);
      }
      const diff = normalizeAngle(this._headTarget - this._headOffset);
      const step = HEAD_TURN_SPEED * dt;
      this._headOffset = Math.abs(diff) <= step ? this._headTarget : this._headOffset + Math.sign(diff) * step;
    }

    // Shoot
    if (this._lockedTarget && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._shootCooldown = rand(FIRE_RATE_MIN, FIRE_RATE_MAX);
    }

    // Movement — only when not actively engaging an enemy
    if (this.moveTarget && !this._lockedTarget) {
      const dx   = this.moveTarget.x - this.x;
      const dy   = this.moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESHOLD) {
        this.x         += (dx / dist) * MOVE_SPEED * this._speedMult * dt;
        this.y         += (dy / dist) * MOVE_SPEED * this._speedMult * dt;
        this.facing     = Math.atan2(dy, dx);
        this._isMoving  = true;
      } else {
        this.x = this.moveTarget.x;
        this.y = this.moveTarget.y;
        this.moveTarget = null;
      }
    }
  }

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DETECTION_RANGE) return true;
    if (dist < VISION_RANGE) {
      const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - (this.facing + this._headOffset)));
      if (diff < VISION_ANGLE / 2) return true;
    }
    return false;
  }

  _shoot(target) {
    target.markUnderFire();

    // Armor penetration check
    if (target.armorClass && target.armorClass !== 'none') {
      const penChance = this._isATRifleman
        ? (target.armorClass === 'heavy' ? 0.25 : 0.50)   // AT rifle: meaningful vs both
        : (target.armorClass === 'heavy' ? 0.05 : 0.10);  // rifle: 1/20 vs tank, 1/10 vs APC
      const penetrated = Math.random() < penChance;
      addBullet(this.x, this.y, target.x, target.y, penetrated);
      if (penetrated) {
        addImpact(target.x, target.y);
        target.state = 'dead'; // armor penetration always kills
        addDeath(target.x, target.y, target.color);
      }
      return;
    }

    const penalty = (this.isUnderFire ? UNDER_FIRE_PENALTY : 0) + (this._isMoving ? MOVE_ACCURACY_PENALTY : 0);
    const hit     = Math.random() < (HIT_CHANCE_BASE - penalty);
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      if (Math.random() < CHANCE_KILL) {
        target.state = 'dead';
        addDeath(target.x, target.y, target.color);
      } else {
        target.state = 'injured';
      }
    }
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead || this._mounted) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const pad  = (VISION_RANGE + RADIUS) * zoom;
    if (sx < -pad || sy < -pad || sx > ctx.canvas.width + pad || sy > ctx.canvas.height + pad) return;

    const r = RADIUS * zoom;

    ctx.save();

    if (this.active && showCones) {
      const lookAngle = this.facing + this._headOffset;
      const visR      = VISION_RANGE * zoom;
      const detR      = DETECTION_RANGE * zoom;

      // Detection circle
      ctx.beginPath();
      ctx.arc(sx, sy, detR, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(255, 240, 100, 0.04)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 240, 100, 0.18)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Vision cone
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, visR, lookAngle - VISION_ANGLE / 2, lookAngle + VISION_ANGLE / 2);
      ctx.closePath();
      ctx.fillStyle   = this._lockedTarget ? 'rgba(255, 180, 80, 0.10)' : 'rgba(255, 255, 200, 0.06)';
      ctx.fill();
      ctx.strokeStyle = this._lockedTarget ? 'rgba(255, 180, 80, 0.25)' : 'rgba(255, 255, 200, 0.14)';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    if (this.active) {
      // Under-fire ring
      if (this.isUnderFire) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4 * zoom, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 60, 60, ${0.4 + pulse * 0.4})`;
        ctx.lineWidth   = Math.max(1, zoom);
        ctx.stroke();
      }
    }

    // Body circle
    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    ctx.stroke();

    // AT rifleman — orange ring so they're immediately recognisable on the field
    if (this._isATRifleman) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,140,0,0.95)';
      ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
      ctx.stroke();
    }

    if (this.active) {
      // Head direction dot
      const lookAngle = this.facing + this._headOffset;
      const dotX = sx + Math.cos(lookAngle) * r * 0.55;
      const dotY = sy + Math.sin(lookAngle) * r * 0.55;
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = this._isATRifleman ? 'rgba(255,140,0,0.85)' : 'rgba(0,0,0,0.65)';
      ctx.fill();
    }

    if (this.injured) {
      // Cross symbol — indicates down/wounded
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
      const cs = r * 0.4;
      ctx.beginPath();
      ctx.moveTo(sx - cs, sy); ctx.lineTo(sx + cs, sy);
      ctx.moveTo(sx, sy - cs); ctx.lineTo(sx, sy + cs);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function rand(min, max)  { return min + Math.random() * (max - min); }

function normalizeAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
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
