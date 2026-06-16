import { addBullet, addImpact, addDeath } from './effects.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const RADIUS              = 8;
const MOVE_SPEED          = 50;
const ARRIVE_THRESHOLD    = 12;
const ASSESS_MIN          = 2.5;
const ASSESS_MAX          = 4.5;
const OFFICER_VISION      = 260; // intelligence-gathering radius

const SHOOT_RANGE         = 150; // shorter than soldier's 220
const DETECT_RANGE        = SHOOT_RANGE / 3;
const VISION_ANGLE        = Math.PI;
const HEAD_TURN_TARGETS   = [-Math.PI * 0.38, 0, Math.PI * 0.38];
const HEAD_TURN_SPEED     = 1.6;
const HEAD_LOCK_SPEED     = 4.0;
const HEAD_HOLD_MIN       = 1.2;
const HEAD_HOLD_MAX       = 4.0;
const HIT_CHANCE_BASE       = 0.50;
const UNDER_FIRE_PENALTY    = 0.10;
const MOVE_ACCURACY_PENALTY = 0.15;
const CHANCE_KILL         = 0.40;
const FIRE_RATE_MIN       = 2.0; // officers fire less often
const FIRE_RATE_MAX       = 3.5;
const UNDER_FIRE_DURATION = 4.0;

const ATTACK_FRONT  = 100;
const ATTACK_SPREAD = 52;
const DEFEND_SPREAD = 60;
const FALLBACK_DIST = 130;

export class Officer {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active'; // 'active' | 'injured' | 'dead'

    this.soldiers  = [];

    // Tactical state
    this._tactic               = null;
    this._hasContact           = false;
    this._assessTimer          = rand(1.0, 2.0);
    this._moveTarget           = null;
    this._enemyCentroid        = null;
    this._knownActiveEnemies   = 0;

    this._reportTimer            = rand(2.0, 5.0);
    this.lastReport              = null;
    this.commandingOfficer       = null;  // set by lieutenant when attached
    this._prevContactState       = false; // tracks contact changes for instant reports
    this._soldiersAtContactStart = null;  // for post-battle loss reporting
    this._unknownThreat          = false; // casualty taken with no visual on attacker
    this._prevSoldierStates      = new Map();

    // Combat state (same system as soldiers, shorter range)
    this._headOffset     = 0;
    this._headTarget     = 0;
    this._headTimer      = rand(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
    this._lockedTarget   = null;
    this._shootCooldown  = rand(0.5, FIRE_RATE_MAX);
    this._underFireTimer = 0;
    this._isMoving       = false;
    this._speedMult      = 0.88 + Math.random() * 0.24;
  }

  attach(soldier) { this.soldiers.push(soldier); return this; }

  get active()    { return this.state === 'active';  }
  get dead()      { return this.state === 'dead';    }
  get injured()   { return this.state === 'injured'; }
  get isUnderFire() { return this._underFireTimer > 0; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DURATION;
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    const angle  = Math.atan2(y - this.y, x - this.x);
    const active = this.soldiers.filter(s => s.active);
    const fmtn   = lineFormation(x, y, angle, 40, ATTACK_SPREAD, active.length);
    active.forEach((s, i) => s.setMoveTarget(fmtn[i].x, fmtn[i].y));
    this._moveTarget = { x, y };
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;
    this._isMoving = false;
    this._checkCasualties();

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    // ── Movement ──────────────────────────────────────────────────────────────
    if (this._moveTarget) {
      const hasTroops    = this.soldiers.some(s => s.active);
      const enemiesKnown = this._hasContact && this._knownActiveEnemies > 0;

      // Don't advance if enemies are known, or if all soldiers are gone
      if (!enemiesKnown && hasTroops) {
        const dx   = this._moveTarget.x - this.x;
        const dy   = this._moveTarget.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > ARRIVE_THRESHOLD) {
          this.x        += (dx / dist) * MOVE_SPEED * this._speedMult * dt;
          this.y        += (dy / dist) * MOVE_SPEED * this._speedMult * dt;
          this.facing    = Math.atan2(dy, dx);
          this._isMoving = true;
        } else {
          this.x = this._moveTarget.x;
          this.y = this._moveTarget.y;
          this._moveTarget = null;
        }
      }
    }

    // ── Combat (head turns + shooting) ────────────────────────────────────────
    const enemies = allUnits.filter(
      u => u.state !== 'dead' && u !== this && factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const activeEnemies  = enemies.filter(e => e.active || e.state === 'active');
    const injuredEnemies = enemies.filter(e => e.injured || e.state === 'injured');

    const visibleActive  = activeEnemies.filter(e  => this._canSee(e));
    const visibleInjured = injuredEnemies.filter(e => this._canSee(e));

    const visibleTargets = visibleActive.length > 0
      ? visibleActive
      : (visibleActive.length === 0 ? visibleInjured : []);

    this._lockedTarget = visibleTargets.length > 0 ? nearest(this, visibleTargets) : null;

    if (this._lockedTarget) {
      const desired = normalizeAngle(
        Math.atan2(this._lockedTarget.y - this.y, this._lockedTarget.x - this.x) - this.facing
      );
      const diff = normalizeAngle(desired - this._headOffset);
      const step = HEAD_LOCK_SPEED * dt;
      this._headOffset = Math.abs(diff) <= step ? desired : this._headOffset + Math.sign(diff) * step;
      this._headTimer  = rand(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
    } else {
      this._headTimer -= dt;
      if (this._headTimer <= 0) {
        const opts       = HEAD_TURN_TARGETS.filter(t => Math.abs(t - this._headTarget) > 0.1);
        this._headTarget = opts[Math.floor(Math.random() * opts.length)];
        this._headTimer  = rand(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
      }
      const diff = normalizeAngle(this._headTarget - this._headOffset);
      const step = HEAD_TURN_SPEED * dt;
      this._headOffset = Math.abs(diff) <= step ? this._headTarget : this._headOffset + Math.sign(diff) * step;
    }

    if (this._lockedTarget && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._shootCooldown = rand(FIRE_RATE_MIN, FIRE_RATE_MAX);
    }

    // ── Tactical assessment ───────────────────────────────────────────────────
    this._assessTimer -= dt;
    if (this._assessTimer <= 0) {
      this._assess(allUnits, factionMgr);
      this._assessTimer = rand(ASSESS_MIN, ASSESS_MAX);
    }

    // ── Radio report ──────────────────────────────────────────────────────────
    this._reportTimer -= dt;
    if (this._reportTimer <= 0) {
      this._generateReport();
      this._reportTimer = rand(5.0, 9.0);
    }
  }

  _generateReport() {
    const active = this.soldiers.filter(s => s.active);
    const total  = this.soldiers.length;

    let distanceToTarget = null;
    if (this._moveTarget) {
      const dx = this._moveTarget.x - this.x;
      const dy = this._moveTarget.y - this.y;
      distanceToTarget = Math.round(Math.sqrt(dx * dx + dy * dy));
    } else if (this._enemyCentroid) {
      const dx = this._enemyCentroid.x - this.x;
      const dy = this._enemyCentroid.y - this.y;
      distanceToTarget = Math.round(Math.sqrt(dx * dx + dy * dy));
    }

    this.lastReport = {
      tactic:        this._tactic,
      troops:        active.length,
      total,
      opposition:    this._knownActiveEnemies,
      hasContact:    this._hasContact,
      distance:      distanceToTarget,
      troopsLost:    this._soldiersAtContactStart != null
                       ? Math.max(0, this._soldiersAtContactStart - active.length)
                       : 0,
      position:      { x: this.x, y: this.y },
      enemyPosition: this._enemyCentroid ? { ...this._enemyCentroid } : null,
      time:          new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
  }

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DETECT_RANGE) return true;
    if (dist < SHOOT_RANGE) {
      const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - (this.facing + this._headOffset)));
      if (diff < VISION_ANGLE / 2) return true;
    }
    return false;
  }

  _shoot(target) {
    const penalty = (this.isUnderFire ? UNDER_FIRE_PENALTY : 0) + (this._isMoving ? MOVE_ACCURACY_PENALTY : 0);
    const hit     = Math.random() < (HIT_CHANCE_BASE - penalty);

    target.markUnderFire();
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

  _checkCasualties() {
    for (const s of this.soldiers) {
      const prev = this._prevSoldierStates.get(s) ?? s.state;
      if (prev === 'active' && s.state !== 'active' && !this._unknownThreat && this._knownActiveEnemies === 0) {
        // Soldier went down with no visual contact — treat as unknown assailant
        this._unknownThreat      = true;
        this._hasContact         = true;
        this._knownActiveEnemies = 1;
        if (!this._prevContactState) {
          this._prevContactState = true;
          this._generateReport();
          if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
        }
      }
      this._prevSoldierStates.set(s, s.state);
    }
  }

  _assess(allUnits, factionMgr) {
    const knownEnemies  = this._collectKnownEnemies(allUnits, factionMgr);
    const activeEnemies = knownEnemies.filter(e => e.active || e.state === 'active');

    // Visual contact upgrades unknown threat to confirmed — clear the flag
    if (this._unknownThreat && activeEnemies.length > 0) this._unknownThreat = false;
    // No visual and unknown threat resolved — let normal contact logic take over
    if (this._unknownThreat && activeEnemies.length === 0) this._unknownThreat = false;

    this._knownActiveEnemies = activeEnemies.length;

    const wasInContact = this._prevContactState;
    const nowInContact = activeEnemies.length > 0;

    // Detect contact-made and contact-cleared events — send instant report upward
    if (nowInContact !== wasInContact) {
      if (nowInContact && !wasInContact) {
        this._soldiersAtContactStart = this.soldiers.filter(s => s.active).length;
      }
      this._prevContactState = nowInContact;
      if (nowInContact) this._hasContact = true;
      this._generateReport();
      if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
    }

    if (activeEnemies.length === 0) return;

    if (!this._hasContact) this._hasContact = true;
    this._enemyCentroid = centroid(activeEnemies);

    const activeFriendlies = this.soldiers.filter(s => s.active).length + 1;

    let newTactic;
    if (activeFriendlies < activeEnemies.length * 0.8) {
      newTactic = 'fallback';
    } else if (activeFriendlies > activeEnemies.length * 1.25) {
      newTactic = 'attack';
    } else {
      newTactic = 'hold';
    }

    this._tactic = newTactic;
    this._issueOrders();
  }

  _issueOrders() {
    if (!this._enemyCentroid) return;

    const toEnemy = Math.atan2(
      this._enemyCentroid.y - this.y,
      this._enemyCentroid.x - this.x
    );
    const active = this.soldiers.filter(s => s.active);

    if (this._tactic === 'attack') {
      const fmtn = lineFormation(this.x, this.y, toEnemy, ATTACK_FRONT, ATTACK_SPREAD, active.length);
      active.forEach((s, i) => s.setMoveTarget(fmtn[i].x, fmtn[i].y));

    } else if (this._tactic === 'fallback') {
      const awayAngle  = toEnemy + Math.PI;
      const splitIdx   = Math.ceil(active.length / 2);
      const rearGuard  = active.slice(0, splitIdx);
      const retreating = active.slice(splitIdx);

      const rearFmtn = lineFormation(this.x, this.y, toEnemy, 50, DEFEND_SPREAD, rearGuard.length);
      rearGuard.forEach((s, i) => s.setMoveTarget(rearFmtn[i].x, rearFmtn[i].y));

      const retreatPos = {
        x: this.x + Math.cos(awayAngle) * FALLBACK_DIST,
        y: this.y + Math.sin(awayAngle) * FALLBACK_DIST,
      };
      const retreatFmtn = lineFormation(
        retreatPos.x, retreatPos.y,
        awayAngle, 50, ATTACK_SPREAD, retreating.length
      );
      retreating.forEach((s, i) => s.setMoveTarget(retreatFmtn[i].x, retreatFmtn[i].y));

    } else {
      const fmtn = arcFormation(this.x, this.y, toEnemy, DEFEND_SPREAD + 10, active.length);
      active.forEach((s, i) => s.setMoveTarget(fmtn[i].x, fmtn[i].y));
    }
  }

  _collectKnownEnemies(allUnits, factionMgr) {
    const seen = new Set();
    for (const u of allUnits) {
      if (u === this || u.factionId === this.factionId || u.state === 'dead') continue;
      const dx = u.x - this.x, dy = u.y - this.y;
      if (dx * dx + dy * dy < OFFICER_VISION * OFFICER_VISION) seen.add(u);
    }
    for (const s of this.soldiers) {
      if (!s.active) continue;
      for (const u of allUnits) {
        if (u.factionId === this.factionId || u.state === 'dead') continue;
        if (s.canSee(u)) seen.add(u);
      }
    }
    return [...seen].filter(u => factionMgr.areEnemies(this.factionId, u.factionId));
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;

    if (sx < -r * 6 || sy < -r * 6 || sx > ctx.canvas.width + r * 6 || sy > ctx.canvas.height + r * 6) return;

    ctx.save();

    if (showCones) {
      // Command vision circle (subtle)
      ctx.beginPath();
      ctx.arc(sx, sy, OFFICER_VISION * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = `${this.color}22`;
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.active) {
      if (showCones) {
        const lookAngle = this.facing + this._headOffset;

        // Shoot vision cone (shorter range)
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, SHOOT_RANGE * zoom, lookAngle - VISION_ANGLE / 2, lookAngle + VISION_ANGLE / 2);
        ctx.closePath();
        ctx.fillStyle   = this._lockedTarget ? 'rgba(255, 180, 80, 0.08)' : 'rgba(255,255,200,0.04)';
        ctx.fill();
        ctx.strokeStyle = this._lockedTarget ? 'rgba(255,180,80,0.2)' : 'rgba(255,255,200,0.1)';
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Under-fire ring
      if (this.isUnderFire) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4 * zoom, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,60,60,${0.4 + pulse * 0.4})`;
        ctx.lineWidth   = Math.max(1, zoom);
        ctx.stroke();
      }
    }

    // Rank ring
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1, zoom);
    ctx.stroke();

    // Body
    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(2, zoom * 2);
    ctx.stroke();

    if (this.active) {
      // Head direction dot
      const lookAngle = this.facing + this._headOffset;
      const dotX = sx + Math.cos(lookAngle) * r * 0.55;
      const dotY = sy + Math.sin(lookAngle) * r * 0.55;
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fill();

      // Rank pip (diamond)
      ctx.globalAlpha = 1;
      const pip = r * 0.3;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
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

    // Tactic label
    if (this._hasContact && this._tactic && zoom >= 1.5) {
      ctx.globalAlpha = 1;
      ctx.fillStyle   = 'rgba(255,255,255,0.7)';
      ctx.font        = `${Math.max(8, zoom * 7)}px monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(this._tactic.toUpperCase(), sx, sy + r + 12 * zoom);
    }

    ctx.restore();
  }
}

// ── Formation helpers ─────────────────────────────────────────────────────────
function lineFormation(ox, oy, facing, frontDist, spread, count) {
  const fx = Math.cos(facing), fy = Math.sin(facing);
  const px = -fy, py = fx;
  return Array.from({ length: count }, (_, i) => {
    const offset = (i - (count - 1) / 2) * spread;
    return { x: ox + fx * frontDist + px * offset, y: oy + fy * frontDist + py * offset };
  });
}

function arcFormation(ox, oy, facing, spread, count) {
  return Array.from({ length: count }, (_, i) => {
    const a = facing + (i - (count - 1) / 2) * (Math.PI / Math.max(count, 2)) * 0.8;
    return { x: ox + Math.cos(a) * spread, y: oy + Math.sin(a) * spread };
  });
}

function centroid(units) {
  return {
    x: units.reduce((s, u) => s + u.x, 0) / units.length,
    y: units.reduce((s, u) => s + u.y, 0) / units.length,
  };
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
