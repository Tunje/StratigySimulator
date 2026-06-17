import { addBullet, addImpact, addDeath } from './effects.js';

const MOVE_SPEED         = 55;
const ARRIVE_THRESH      = 14;
const FIRE_RATE_MIN      = 2.5;
const FIRE_RATE_MAX      = 4.5;
const RADIUS             = 8;
const REPORT_INTV        = 1.5; // s between repeated sighting reports
const OPERATIVE_ENGAGE   = 150; // sidearm range — far shorter than observation range

// Sight radii (world px)
export const CORPORAL_SIGHT  = 330;  // 1.5 × soldier 220
export const STAFF_SGT_SIGHT = 660;  // 3.0 × soldier 220
export const RADIO_OP_SIGHT  = 990;  // 4.5 × soldier 220

function normalizeAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function rand(min, max) { return min + Math.random() * (max - min); }
function nearest(from, list) {
  let best = null, bestD = Infinity;
  for (const t of list) {
    const dx = t.x - from.x, dy = t.y - from.y;
    const d  = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// ── Base Operative ─────────────────────────────────────────────────────────────
// Follows their CO at a perpendicular offset. Primary purpose: observation.
// Does not maneuver independently — only defends itself if attacked.
class Operative {
  constructor(x, y, factionId, facing, color, sightRadius, perpOffset) {
    this.x          = x;
    this.y          = y;
    this.factionId  = factionId;
    this.facing     = facing;
    this.color      = color;
    this.state      = 'active';
    this.armorClass = 'none';

    this._sightRadius      = sightRadius;
    this._perpOffset       = perpOffset;
    this.commandingOfficer = null;      // set by attach method on CO
    this._reportCooldown   = rand(0.5, REPORT_INTV);
    this._inContact        = false;
    this._visibleCount     = 0;
    this._lastEnemyPos     = null;

    this._lockedTarget   = null;
    this._shootCooldown  = rand(1.0, FIRE_RATE_MAX);
    this._headOffset     = 0;
    this._underFireTimer = 0;
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire() { if (this.active) this._underFireTimer = 4.0; }
  receiveContactAlert() {}  // operatives scan wide — ignore buddy alerts

  _canSee(other) {
    const dx = other.x - this.x, dy = other.y - this.y;
    if (dx*dx + dy*dy > this._sightRadius * this._sightRadius) return false;
    // Wide 260° arc — dedicated observers face outward
    const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - this.facing));
    return diff < Math.PI * 0.72;
  }

  _followCO(dt) {
    const co = this.commandingOfficer;
    if (!co?.active) return;
    const perp = co.facing + Math.PI / 2;
    const tgtX = co.x + Math.cos(perp) * this._perpOffset;
    const tgtY = co.y + Math.sin(perp) * this._perpOffset;
    const dx   = tgtX - this.x, dy = tgtY - this.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > ARRIVE_THRESH) {
      this.x     += (dx / dist) * MOVE_SPEED * dt;
      this.y     += (dy / dist) * MOVE_SPEED * dt;
      this.facing = Math.atan2(dy, dx);
    } else {
      // Align facing with CO when stationary
      this.facing = co.facing;
    }
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;
    if (this._reportCooldown > 0) this._reportCooldown -= dt;

    this._followCO(dt);

    const enemies = allUnits.filter(u =>
      u !== this && u.active &&
      factionMgr.areEnemies(this.factionId, u.factionId) &&
      this._canSee(u)
    );

    this._visibleCount = enemies.length;
    this._lastEnemyPos = enemies.length > 0
      ? { x: enemies.reduce((s, e) => s + e.x, 0) / enemies.length,
          y: enemies.reduce((s, e) => s + e.y, 0) / enemies.length }
      : null;

    // Shooting range is much shorter than observation range — operatives carry sidearms only
    const r2engage     = OPERATIVE_ENGAGE * OPERATIVE_ENGAGE;
    const inRange      = enemies.filter(u => {
      const dx = u.x - this.x, dy = u.y - this.y;
      return dx * dx + dy * dy <= r2engage;
    });
    this._lockedTarget = inRange.length > 0 ? nearest(this, inRange) : null;

    const wasContact = this._inContact;
    this._inContact  = enemies.length > 0;

    if (this._inContact && this._reportCooldown <= 0) {
      this._report(enemies);
      this._reportCooldown = REPORT_INTV;
    }

    if (this._inContact !== wasContact) {
      this._onContactChange(this._inContact, enemies);
    }

    // Light self-defence only — operatives are not frontline fighters
    if (this._lockedTarget && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._shootCooldown = rand(FIRE_RATE_MIN, FIRE_RATE_MAX);
    }
  }

  _report(enemies)                     {}  // overridden
  _onContactChange(hasContact, enemies) {}  // overridden

  _shoot(target) {
    target.markUnderFire();
    // Operatives carry pistols/sidearms — no armor penetration
    if (target.armorClass && target.armorClass !== 'none') {
      addBullet(this.x, this.y, target.x, target.y, false);
      return;
    }
    const hit = Math.random() < 0.32; // lower accuracy than frontline units
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      target.state = Math.random() < 0.30 ? 'dead' : 'injured';
      if (target.state === 'dead') addDeath(target.x, target.y, target.color);
    }
  }

  // Returns screen coords for subclass draw methods; returns null if culled
  _screenPos(camera) {
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const pad  = this._sightRadius * zoom + 100;
    if (sx < -pad || sy < -pad || sx > camera._canvas?.width  + pad ||
                                  sy > camera._canvas?.height + pad) {
      // Simple bounds check — pass canvas dims via camera or just use generous pad
    }
    return { sx, sy, r: RADIUS * zoom, zoom };
  }
}

// ── Corporal ──────────────────────────────────────────────────────────────────
// Squad-level observer. Feeds contact into sergeant's _contactingSet exactly
// like a soldier does — ensuring the sergeant knows there is contact even
// when the corporal spots before the soldiers do.
export class Corporal extends Operative {
  constructor(x, y, factionId, facing, color) {
    super(x, y, factionId, facing, color, CORPORAL_SIGHT, 28);
  }

  _report(enemies) {
    this.commandingOfficer?.receiveSoldierContact(this, true);
  }

  _onContactChange(hasContact, enemies) {
    this.commandingOfficer?.receiveSoldierContact(this, hasContact);
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;
    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    if (showCones && this.active) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, CORPORAL_SIGHT * zoom,
        this.facing - Math.PI * 0.72, this.facing + Math.PI * 0.72);
      ctx.closePath();
      ctx.fillStyle = this._inContact
        ? 'rgba(255,200,80,0.06)' : 'rgba(80,255,180,0.04)';
      ctx.fill();
    }

    // Thin teal rank ring — distinguishes corporal from regular soldier
    ctx.beginPath();
    ctx.arc(sx, sy, r + 2.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(60,210,160,0.75)';
    ctx.lineWidth   = Math.max(0.5, zoom * 0.75);
    ctx.stroke();

    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    ctx.stroke();

    // Head dot — teal when observing, amber when in contact
    const dotX = sx + Math.cos(this.facing) * r * 0.55;
    const dotY = sy + Math.sin(this.facing) * r * 0.55;
    ctx.beginPath();
    ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = this._inContact ? 'rgba(255,200,80,0.9)' : 'rgba(60,210,160,0.85)';
    ctx.fill();

    if (this.injured) {
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

// ── Staff Sergeant ─────────────────────────────────────────────────────────────
// Platoon-level observer. Follows lieutenant, extends the platoon's awareness
// well ahead of where the sergeant squads can see. Reports via the LT's
// receiveStaffSighting pathway so the LT can factor it into its assessment.
export class StaffSergeant extends Operative {
  constructor(x, y, factionId, facing, color) {
    super(x, y, factionId, facing, color, STAFF_SGT_SIGHT, 55);
  }

  _report(enemies) {
    if (!this.commandingOfficer) return;
    enemies.forEach(e =>
      this.commandingOfficer.receiveStaffSighting({ x: e.x, y: e.y })
    );
  }

  _onContactChange(hasContact, enemies) {
    this.commandingOfficer?.receiveStaffContactChange(this, hasContact, enemies[0] ?? null);
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;
    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    if (showCones && this.active) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, STAFF_SGT_SIGHT * zoom,
        this.facing - Math.PI * 0.72, this.facing + Math.PI * 0.72);
      ctx.closePath();
      ctx.fillStyle = this._inContact
        ? 'rgba(255,200,80,0.04)' : 'rgba(80,160,255,0.03)';
      ctx.fill();
    }

    // Blue double ring — observer variant of the lieutenant ring pattern
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(60,160,255,0.75)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();

    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(2, zoom * 2);
    ctx.stroke();

    // Head dot
    const dotX = sx + Math.cos(this.facing) * r * 0.55;
    const dotY = sy + Math.sin(this.facing) * r * 0.55;
    ctx.beginPath();
    ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = this._inContact ? 'rgba(255,200,80,0.9)' : 'rgba(60,160,255,0.85)';
    ctx.fill();

    // Small rotated square marker — same as sergeant to show authority level
    if (this.active) {
      const pip = r * 0.3;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(60,160,255,0.55)';
      ctx.fillRect(-pip / 2, -pip / 2, pip, pip);
      ctx.restore();
    }

    if (this.injured) {
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

// ── Radio Operator ─────────────────────────────────────────────────────────────
// Company-level observer. Follows captain, provides a reliable long-range
// intelligence baseline. Never moves forward — so its reach (900px) extends
// about 400px past the infantry line from the captain's usual position.
// Also flags _radioDirectContact on the captain to count as a significance trigger.
export class RadioOperator extends Operative {
  constructor(x, y, factionId, facing, color) {
    super(x, y, factionId, facing, color, RADIO_OP_SIGHT, 55);
  }

  _report(enemies) {
    if (!this.commandingOfficer) return;
    // Cluster enemies within 150px so each cluster is one sighting with an accurate count.
    // This prevents the same N enemies being reported as N*cycles sightings as they move.
    const CLUSTER_R2 = 150 * 150;
    const clusters = [];
    for (const e of enemies) {
      const near = clusters.find(c => {
        const dx = c.x - e.x, dy = c.y - e.y;
        return dx * dx + dy * dy < CLUSTER_R2;
      });
      if (near) {
        near.x = (near.x * near.count + e.x) / (near.count + 1);
        near.y = (near.y * near.count + e.y) / (near.count + 1);
        near.count++;
      } else {
        clusters.push({ x: e.x, y: e.y, count: 1 });
      }
    }
    clusters.forEach(c =>
      this.commandingOfficer.receiveSightingReport({ x: c.x, y: c.y, count: c.count })
    );
    this.commandingOfficer._radioDirectContact = true;
  }

  _onContactChange(hasContact, enemies) {
    if (!this.commandingOfficer) return;
    if (hasContact && enemies.length > 0) {
      this.commandingOfficer.receiveSightingReport({ x: enemies[0].x, y: enemies[0].y, count: enemies.length });
      this.commandingOfficer._radioDirectContact = true;
    } else {
      this.commandingOfficer._radioDirectContact = false;
    }
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;
    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    // Full-circle dashed range ring — shows awareness bubble
    if (showCones && this.active) {
      ctx.beginPath();
      ctx.arc(sx, sy, RADIO_OP_SIGHT * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = this._inContact
        ? 'rgba(255,200,80,0.22)' : 'rgba(220,220,255,0.12)';
      ctx.lineWidth = Math.max(0.5, zoom);
      ctx.setLineDash([6 * zoom, 9 * zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // White/silver double ring — immediately distinct from StaffSergeant's blue rings
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth   = Math.max(1, zoom * 1.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();

    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(2, zoom * 2);
    ctx.stroke();

    // Head dot — white when passive (signals/comms), amber when picking up contacts
    const dotX = sx + Math.cos(this.facing) * r * 0.55;
    const dotY = sy + Math.sin(this.facing) * r * 0.55;
    ctx.beginPath();
    ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = this._inContact ? 'rgba(255,200,80,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Antenna — tall gold L-shape, clearly visible at any zoom
    if (this.active) {
      const antennaColor = this._inContact ? 'rgba(255,200,80,1)' : 'rgba(255,230,100,0.95)';
      ctx.strokeStyle = antennaColor;
      ctx.lineWidth   = Math.max(1.5, zoom * 1.8);
      ctx.beginPath();
      // Vertical mast
      ctx.moveTo(sx,                sy - r - zoom);
      ctx.lineTo(sx,                sy - r - 18 * zoom);
      // Horizontal arm at top
      ctx.lineTo(sx + 7 * zoom,     sy - r - 18 * zoom);
      ctx.stroke();
      // Small tick at arm end
      ctx.beginPath();
      ctx.moveTo(sx + 7 * zoom,     sy - r - 14 * zoom);
      ctx.lineTo(sx + 7 * zoom,     sy - r - 22 * zoom);
      ctx.stroke();
    }

    if (this.injured) {
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
