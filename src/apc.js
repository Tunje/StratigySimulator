import { addBullet, addImpact, addDeath } from './effects.js';

const APC_RADIUS      = 26;
const APC_SPEED       = 65;
const MG_RANGE        = 200;
const MG_DETECT       = 75;
const MG_VISION_ANG   = Math.PI;
const MG_HIT_CHANCE   = 0.28;  // inaccurate spray weapon
const BURST_SIZE      = 10;    // rounds per burst
const BURST_RATE      = 0.10;  // s between rounds in burst
const BURST_RELOAD    = 3.5;   // s reload after full burst
const ARRIVE_THRESH   = 14;
const UNDER_FIRE_DUR  = 4.0;
const DISMOUNT_RANGE  = 260; // dismount when enemies this close
const REMOUNT_CLEAR   = 5.0; // s without enemies before remounting

export class APC {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x          = x;
    this.y          = y;
    this.factionId  = factionId;
    this.facing     = facing;
    this.color      = color;
    this.state      = 'active';
    this.armorClass = 'light';

    this._moveTarget     = null;
    this._lockedTarget   = null;
    this._shootCooldown  = rand(0.5, BURST_RATE);
    this._burstCount     = 0;
    this._reloadTimer    = 0;
    this._underFireTimer = 0;
    this._dismounted     = false;
    this._clearTimer     = 0;
    this._recalling      = false;
    this._sergeant       = null; // Officer attached as dismount squad
    this._reportCooldown = 0;
    this.commandingOfficer = null;
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
    if (this._reloadTimer    > 0) this._reloadTimer    -= dt;

    const enemies = allUnits.filter(u =>
      u !== this && u.state !== 'dead' && u.active &&
      factionMgr.areEnemies(this.factionId, u.factionId)
    );

    const nearbyCount = enemies.filter(e => {
      // Scouts (_isFleeing) and operatives (_sightRadius) are observers, not dismount triggers
      if (e._isFleeing !== undefined) return false;
      if (e._sightRadius !== undefined) return false;
      const dx = e.x - this.x, dy = e.y - this.y;
      return dx * dx + dy * dy < DISMOUNT_RANGE * DISMOUNT_RANGE;
    }).length;

    const visible = enemies.filter(e => this._canSee(e));
    this._lockedTarget = visible.length > 0 ? nearest(this, visible) : null;

    if (this._reportCooldown > 0) this._reportCooldown -= dt;
    if (this._lockedTarget && this._reportCooldown <= 0) {
      this.commandingOfficer?.receiveSightingReport({ x: this._lockedTarget.x, y: this._lockedTarget.y });
      this._reportCooldown = 3.0;
    }

    // Dismount when enemies close
    if (nearbyCount > 0 && !this._dismounted) {
      this._dismount();
      this._recalling  = false;
      this._clearTimer = 0;
    }

    // While dismounted: track how long the area has been clear
    if (this._dismounted) {
      if (nearbyCount > 0) {
        this._clearTimer = 0;
        this._recalling  = false;
      } else {
        this._clearTimer += dt;
        if (this._clearTimer >= REMOUNT_CLEAR && !this._recalling) {
          this._recalling = true;
          this._callTroopsBack();
        }
      }

      // Check if all troops have returned and board them
      if (this._recalling && this._sergeant) {
        const boardRange = APC_RADIUS * 2.5;
        const sgtClose   = Math.hypot(this._sergeant.x - this.x, this._sergeant.y - this.y) < boardRange;
        const allClose   = this._sergeant.soldiers.every(s =>
          s.state === 'dead' || Math.hypot(s.x - this.x, s.y - this.y) < boardRange
        );
        if (sgtClose && allClose) {
          this._remount();
        }
      }
    }

    // While mounted, snap sergeant + soldiers to APC position (they're hidden inside)
    if (!this._dismounted && this._sergeant) {
      this._sergeant._mounted = true;
      this._sergeant.x = this.x;
      this._sergeant.y = this.y;
      for (const s of this._sergeant.soldiers) {
        s._mounted = true;
        s.x = this.x;
        s.y = this.y;
      }
    }

    // Burst-fire MG — 10 rounds rapid then reload
    if (this._lockedTarget && this._reloadTimer <= 0 && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._burstCount++;
      if (this._burstCount >= BURST_SIZE) {
        this._burstCount  = 0;
        this._reloadTimer = BURST_RELOAD;
        this._shootCooldown = BURST_RELOAD;
      } else {
        this._shootCooldown = BURST_RATE * rand(0.8, 1.3);
      }
    }

    // Movement — stop while dismounted so troops have a fixed point to reboard
    if (this._moveTarget && !this._dismounted) {
      const dx   = this._moveTarget.x - this.x;
      const dy   = this._moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESH) {
        this.x      += (dx / dist) * APC_SPEED * dt;
        this.y      += (dy / dist) * APC_SPEED * dt;
        this.facing  = Math.atan2(dy, dx);
      } else {
        this.x = this._moveTarget.x;
        this.y = this._moveTarget.y;
        this._moveTarget = null;
      }
    }

    // Separation — only along facing axis so APCs never drift sideways
    {
      const SEP = APC_RADIUS * 3;
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
        const fwdX = Math.cos(this.facing), fwdY = Math.sin(this.facing);
        const proj = (px * fwdX + py * fwdY) / len;
        this.x += fwdX * proj * APC_SPEED * 0.4 * dt;
        this.y += fwdY * proj * APC_SPEED * 0.4 * dt;
      }
    }
  }

  _dismount() {
    this._dismounted = true;
    this._clearTimer = 0;
    if (!this._sergeant) return;
    this._sergeant._mounted = false;
    const perp    = this.facing + Math.PI / 2;
    const advance = APC_RADIUS * 5; // how far forward soldiers push after exit
    this._sergeant.soldiers.forEach((s, i) => {
      s._mounted = false;
      const side   = i % 2 === 0 ? 1 : -1;
      const stride = Math.floor(i / 2 + 1) * APC_RADIUS * 1.4;
      s.x = this.x + Math.cos(perp) * stride * side;
      s.y = this.y + Math.sin(perp) * stride * side;
      // Immediately push forward rather than standing at the ramp
      s.moveTarget = {
        x: s.x + Math.cos(this.facing) * advance,
        y: s.y + Math.sin(this.facing) * advance,
      };
    });
    this._sergeant.x = this.x + Math.cos(this.facing) * APC_RADIUS * 1.75;
    this._sergeant.y = this.y + Math.sin(this.facing) * APC_RADIUS * 1.75;
    this._sergeant.setMoveTarget(
      this._sergeant.x + Math.cos(this.facing) * advance * 1.5,
      this._sergeant.y + Math.sin(this.facing) * advance * 1.5,
    );
  }

  _callTroopsBack() {
    if (!this._sergeant) return;
    this._sergeant.recallTo(this.x, this.y);
  }

  _remount() {
    this._dismounted = false;
    this._recalling  = false;
    this._clearTimer = 0;
    if (!this._sergeant) return;
    this._sergeant._mounted    = true;
    this._sergeant._sgtPhase   = 'moving';
    this._sergeant.x           = this.x;
    this._sergeant.y           = this.y;
    for (const s of this._sergeant.soldiers) {
      s._mounted  = true;
      s.x         = this.x;
      s.y         = this.y;
      s.moveTarget = null;
    }
  }

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < MG_DETECT) return true;
    if (dist < MG_RANGE) {
      const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - this.facing));
      if (diff < MG_VISION_ANG / 2) return true;
    }
    return false;
  }

  _shoot(target) {
    target.markUnderFire();
    if (target.armorClass && target.armorClass !== 'none') {
      // MG vs heavy armor: nearly useless; vs light armor: occasional damage
      const penChance = target.armorClass === 'heavy' ? 0.02 : 0.22;
      const hit       = Math.random() < penChance;
      addBullet(this.x, this.y, target.x, target.y, hit);
      if (hit) {
        addImpact(target.x, target.y);
        target.state = 'dead';
        addDeath(target.x, target.y, target.color);
      }
      return;
    }
    const hit = Math.random() < MG_HIT_CHANCE;
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      target.state = Math.random() < 0.5 ? 'dead' : 'injured';
      if (target.state === 'dead') addDeath(target.x, target.y, target.color);
    }
  }

  draw(ctx, camera, showCones = true) {
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = APC_RADIUS * zoom;

    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    // Dead APC — burnt-out hulk
    if (this.dead) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(this.facing);
      ctx.fillStyle   = '#2a2a2a';
      ctx.strokeStyle = '#111';
      ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
      ctx.fillRect(-r * 1.05, -r * 0.6, r * 2.1, r * 1.2);
      ctx.strokeRect(-r * 1.05, -r * 0.6, r * 2.1, r * 1.2);
      // Burn marks along the hull sides
      ctx.strokeStyle = 'rgba(80,40,0,0.5)';
      ctx.lineWidth   = Math.max(1, zoom * 0.7);
      [-r * 0.45, r * 0.45].forEach(yOff => {
        ctx.beginPath();
        ctx.moveTo(-r * 1.05, yOff); ctx.lineTo(r * 1.05, yOff);
        ctx.stroke();
      });
      // Crooked MG mount — skewed to show it's wrecked
      ctx.fillStyle = '#333';
      ctx.save();
      ctx.rotate(0.45);
      ctx.fillRect(r * 0.2, -r * 0.12, r * 0.75, r * 0.22);
      ctx.restore();
      ctx.restore();
      // Smoke — two puffs, smaller than tank
      const smokeAlpha = 0.15 + 0.08 * Math.sin(Date.now() / 650);
      for (let i = 0; i < 2; i++) {
        const oy = -(r * 1.0 + i * r * 0.8);
        const ox = Math.sin(Date.now() / 900 + i) * r * 0.25;
        const sr = r * (0.28 + i * 0.15);
        ctx.beginPath();
        ctx.arc(sx + ox, sy + oy, sr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(30,30,30,${smokeAlpha - i * 0.04})`;
        ctx.fill();
      }
      return;
    }

    ctx.save();

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this.facing);
    ctx.globalAlpha  = 1;
    ctx.fillStyle    = this.color;
    ctx.strokeStyle  = '#000';
    ctx.lineWidth    = Math.max(1.5, zoom * 1.5);
    ctx.fillRect(-r * 1.05, -r * 0.6, r * 2.1, r * 1.2);
    ctx.strokeRect(-r * 1.05, -r * 0.6, r * 2.1, r * 1.2);
    // Wheel dots
    [[-r * 0.65, -r * 0.55], [-r * 0.65, r * 0.55], [r * 0.65, -r * 0.55], [r * 0.65, r * 0.55]].forEach(([wx, wy]) => {
      ctx.beginPath();
      ctx.arc(wx, wy, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#333';
      ctx.fill();
    });
    // MG mount
    ctx.fillStyle = '#555';
    ctx.fillRect(r * 0.25, -r * 0.1, r * 0.8, r * 0.2);
    ctx.restore();

    ctx.globalAlpha = 1;

    if (this.isUnderFire) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4 * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,60,60,${0.4 + pulse * 0.4})`;
      ctx.lineWidth   = Math.max(1, zoom);
      ctx.stroke();
    }

    if (this._dismounted && zoom >= 0.7) {
      ctx.fillStyle = 'rgba(255,220,80,0.85)';
      ctx.font      = `bold ${Math.max(7, zoom * 5)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('DSMNT', sx, sy - r * 1.6);
    }

    if (zoom >= 0.7) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font      = `${Math.max(7, zoom * 5)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('APC', sx, sy + r * 1.4 + 10 * zoom);
    }

    ctx.restore();
  }
}

// ── MechanizedPlatoon ─────────────────────────────────────────────────────────
// Thin wrapper the captain orders as a unit — manages 4 APCs internally.
export class MechanizedPlatoon {
  constructor(x, y, factionId, facing, color) {
    this.factionId = factionId;
    this.facing    = facing;
    // 1 command APC + 3 troop APCs stacked in column, spaced by APC diameter + clearance
    const colGap  = APC_RADIUS * 6;
    const offsets = [-colGap * 1.5, -colGap * 0.5, colGap * 0.5, colGap * 1.5];
    this.apcs = offsets.map(dy => new APC(x, y + dy, factionId, facing, color));
  }

  get active() { return this.apcs.some(a => a.active); }

  setMoveTarget(x, y) {
    const fwd  = Math.atan2(y - this.apcs[0].y, x - this.apcs[0].x);
    const perp = fwd + Math.PI / 2;
    this.apcs.filter(a => a.active).forEach((apc, i) => {
      const offset = (i - (this.apcs.length - 1) / 2) * APC_RADIUS * 5;
      apc.setMoveTarget(
        x + Math.cos(perp) * offset,
        y + Math.sin(perp) * offset,
      );
    });
  }

  // Returns flat list of all units (APCs + their squads) for allUnits registration
  allUnits() {
    const units = [...this.apcs];
    for (const apc of this.apcs) {
      if (apc._sergeant) {
        units.push(apc._sergeant);
        units.push(...apc._sergeant.soldiers);
      }
    }
    return units;
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
