import { addBullet, addImpact, addDeath } from './effects.js';

const RADIUS              = 8;
const MOVE_SPEED          = 50;
const ARRIVE_THRESHOLD    = 12;
const SHOOT_RANGE         = 150;
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
const FIRE_RATE_MIN       = 2.0;
const FIRE_RATE_MAX       = 3.5;
const UNDER_FIRE_DURATION = 4.0;

const ATTACK_SPREAD  = 52;
const DEFEND_SPREAD  = 60;
const ATTACK_PUSH    = 220; // px sergeant pushes forward after clearing contact
const WDRAW_STEP_DUR = 3.0; // seconds per leapfrog step

export class Officer {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active';

    this.soldiers  = [];

    // Phase: 'moving' | 'engaging' | 'attacking' | 'holding' | 'withdrawing'
    this._sgtPhase   = 'holding';
    this._marchDir   = null;   // direction of company advance, saved from last lt move order
    this._moveTarget = null;
    this._forcedMoveTarget = null;

    // Withdraw leapfrog state
    this._wdrawTarget = null;
    this._wdrawStep   = 0;
    this._wdrawTimer  = 0;

    // Contact / reporting
    this._hasContact         = false;
    this._knownActiveEnemies = 0;
    this._contactingSet      = new Set(); // soldiers that have reported being in contact
    this._lastLockedPos      = null; // position of last enemy the sergeant personally saw
    this._prevContactState   = false;
    this._prevSoldierStates  = new Map();
    this._unknownThreat      = false;

    this._reportTimer  = rand(2.0, 5.0);
    this.lastReport    = null;
    this.commandingOfficer = null;

    // Armor
    this._armorContact    = false;
    this._armorContactPos = null;

    this._mounted = false;

    // Combat
    this._headOffset     = 0;
    this._headTarget     = 0;
    this._headTimer      = rand(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
    this._lockedTarget   = null;
    this._shootCooldown  = rand(0.5, FIRE_RATE_MAX);
    this._underFireTimer = 0;
    this._isMoving       = false;
    this._speedMult      = 0.88 + Math.random() * 0.24;
  }

  attach(soldier) {
    this.soldiers.push(soldier);
    soldier.commandingOfficer = this;
    return this;
  }

  attachCorporal(corporal) {
    this.corporal = corporal;
    corporal.commandingOfficer = this;
    return this;
  }

  receiveSoldierContact(soldier, hasContact) {
    if (hasContact) {
      this._contactingSet.add(soldier);
    } else {
      this._contactingSet.delete(soldier);
    }
  }

  get _soldiersInContact() { return this._contactingSet.size; }

  get active()      { return this.state === 'active' && !this._mounted; }
  get dead()        { return this.state === 'dead';    }
  get injured()     { return this.state === 'injured'; }
  get isUnderFire() { return this._underFireTimer > 0; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DURATION;
  }

  // Called by lieutenant — saves march direction and orders troops ahead
  setMoveTarget(x, y) {
    if (!this.active) return;
    this._marchDir   = Math.atan2(y - this.y, x - this.x);
    // Stay in ENGAGING if already fighting — move order is honoured but fight continues
    if (this._sgtPhase !== 'engaging') this._sgtPhase = 'moving';
    this._moveTarget = { x: x - Math.cos(this._marchDir) * 70,
                         y: y - Math.sin(this._marchDir) * 70 };
    const active = this.soldiers.filter(s => s.active);
    const perp   = this._marchDir + Math.PI / 2;
    active.forEach((s, i) => {
      // Don't pull a soldier off their target — let them fight; they'll re-join when contact clears
      if (s._lockedTarget) return;
      const off = (i - (active.length - 1) / 2) * ATTACK_SPREAD;
      s.setMoveTarget(x + Math.cos(perp) * off, y + Math.sin(perp) * off);
    });
  }

  // Called by lieutenant to order a fighting withdrawal
  recallTo(x, y) {
    if (!this.active) return;
    this._sgtPhase    = 'withdrawing';
    this._wdrawTarget = { x, y };
    this._wdrawStep   = 0;
    this._wdrawTimer  = 0;
    this._issueWithdrawStep();
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;
    this._isMoving = false;
    this._checkCasualties();

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    // ── What the sergeant personally sees ─────────────────────────────────────
    const enemies    = allUnits.filter(u =>
      u !== this && u.state !== 'dead' && factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const visAct = enemies.filter(e => (e.active || e.state === 'active') && this._canSee(e));
    const visInj = enemies.filter(e => (e.injured || e.state === 'injured') && this._canSee(e));
    const visTargets = visAct.length > 0 ? visAct : visInj;

    // ── Head tracking ──────────────────────────────────────────────────────────
    this._lockedTarget = visTargets.length > 0 ? nearest(this, visTargets) : null;
    if (this._lockedTarget) {
      this._lastLockedPos = { x: this._lockedTarget.x, y: this._lockedTarget.y };
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

    // ── Armor contact (personal sight only) ───────────────────────────────────
    const armorVis = visAct.filter(e => e.armorClass && e.armorClass !== 'none');
    if (armorVis.length > 0) {
      const wasArmor        = this._armorContact;
      this._armorContact    = true;
      this._armorContactPos = { x: armorVis[0].x, y: armorVis[0].y };
      if (!wasArmor) {
        this._generateReport();
        if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
      }
    } else {
      this._armorContact    = false;
      this._armorContactPos = null;
    }

    // ── Contact: personal sight + what soldiers have reported ─────────────────
    const soldiersEngaged    = this._soldiersInContact > 0;
    const anyContact         = this._lockedTarget !== null || soldiersEngaged;
    this._knownActiveEnemies = visAct.length + (soldiersEngaged && visAct.length === 0 ? 1 : 0);
    if (anyContact) this._hasContact = true;

    // Detect contact made/cleared for instant reports
    if (anyContact !== this._prevContactState) {
      this._prevContactState = anyContact;
      this._generateReport();
      if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
    }

    // ── State machine ──────────────────────────────────────────────────────────
    switch (this._sgtPhase) {

      case 'moving':
        // Soldiers and sergeant advance toward lt-ordered position
        // If squad finds contact, halt and engage
        if (anyContact) {
          this._sgtPhase   = 'engaging';
          this._moveTarget = null; // sergeant holds
        }
        break;

      case 'engaging':
        // Sergeant and soldiers fight what they can see.
        // Withdrawal is the lieutenant's call via recallTo — sergeants hold and fight.
        if (!anyContact) {
          // Contact cleared — push forward in company advance direction
          if (this._marchDir !== null) {
            this._sgtPhase = 'attacking';
            this._issueAttackPush();
          } else {
            this._sgtPhase = 'holding';
            this._issueHoldPositions();
          }
        }
        break;

      case 'attacking':
        // Sergeant moves forward; transitions to holding once he arrives
        if (!this._moveTarget && !this.soldiers.some(s => s.active && s.moveTarget)) {
          this._sgtPhase = 'holding';
          this._issueHoldPositions();
        }
        // New contact while pushing — stop and fight
        if (anyContact) {
          this._sgtPhase   = 'engaging';
          this._moveTarget = null;
        }
        break;

      case 'holding':
        if (anyContact) this._sgtPhase = 'engaging';
        break;

      case 'withdrawing':
        if (this._wdrawTarget) {
          this._wdrawTimer += dt;
          if (this._wdrawTimer >= WDRAW_STEP_DUR) {
            this._wdrawTimer = 0;
            this._wdrawStep  = 1 - this._wdrawStep;
            this._issueWithdrawStep();
          }
          // Sergeant arrived at fallback — settle into holding
          const wdx = this._wdrawTarget.x - this.x;
          const wdy = this._wdrawTarget.y - this.y;
          if (wdx * wdx + wdy * wdy < 28 * 28) {
            this._wdrawTarget = null;
            this._sgtPhase    = 'holding';
            this._issueHoldPositions();
          }
        } else {
          this._sgtPhase = 'holding';
          this._issueHoldPositions();
        }
        break;
    }

    // ── Sergeant own movement ──────────────────────────────────────────────────
    const isWithdrawing = this._sgtPhase === 'withdrawing';
    const moveTgt  = isWithdrawing ? this._wdrawTarget
                   : (this._forcedMoveTarget || this._moveTarget);
    const isForced = !isWithdrawing && !!this._forcedMoveTarget;
    const canMove  = this._sgtPhase === 'moving'
                  || this._sgtPhase === 'attacking'
                  || this._sgtPhase === 'withdrawing'
                  || (this._sgtPhase === 'engaging' && !!this._moveTarget)
                  || isForced;
    if (moveTgt && canMove) {
      const dx   = moveTgt.x - this.x;
      const dy   = moveTgt.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESHOLD) {
        this.x        += (dx / dist) * MOVE_SPEED * this._speedMult * dt;
        this.y        += (dy / dist) * MOVE_SPEED * this._speedMult * dt;
        this.facing    = Math.atan2(dy, dx);
        this._isMoving = true;
      } else if (!isWithdrawing) {
        this.x = moveTgt.x;
        this.y = moveTgt.y;
        if (isForced) this._forcedMoveTarget = null;
        else          this._moveTarget       = null;
      }
    }

    // ── Periodic report ───────────────────────────────────────────────────────
    this._reportTimer -= dt;
    if (this._reportTimer <= 0) {
      this._generateReport();
      this._reportTimer = rand(5.0, 9.0);
    }
  }

  // ── Order helpers ─────────────────────────────────────────────────────────────

  _issueAttackPush() {
    if (this._marchDir === null) return;
    const perp   = this._marchDir + Math.PI / 2;
    const active = this.soldiers.filter(s => s.active);
    active.forEach((s, i) => {
      if (s._lockedTarget) return; // already engaging — don't pull them mid-fight
      const off = (i - (active.length - 1) / 2) * ATTACK_SPREAD;
      s.setMoveTarget(
        this.x + Math.cos(this._marchDir) * ATTACK_PUSH + Math.cos(perp) * off,
        this.y + Math.sin(this._marchDir) * ATTACK_PUSH + Math.sin(perp) * off,
      );
    });
    this._moveTarget = {
      x: this.x + Math.cos(this._marchDir) * (ATTACK_PUSH - 70),
      y: this.y + Math.sin(this._marchDir) * (ATTACK_PUSH - 70),
    };
  }

  _issueHoldPositions() {
    if (this._marchDir === null) return;
    const active = this.soldiers.filter(s => s.active);
    active.forEach((s, i) => {
      const a = this._marchDir + (i - (active.length - 1) / 2) * (Math.PI / Math.max(active.length, 2)) * 0.8;
      s.setMoveTarget(
        this.x + Math.cos(a) * (DEFEND_SPREAD + 10),
        this.y + Math.sin(a) * (DEFEND_SPREAD + 10),
      );
    });
    this._moveTarget = null;
  }

  _issueWithdrawStep() {
    if (!this._wdrawTarget) return;
    const active  = this.soldiers.filter(s => s.active);
    const perp    = this._marchDir !== null ? this._marchDir + Math.PI / 2 : Math.PI / 2;
    const moving  = active.filter((_, i) => i % 2 === this._wdrawStep);
    const holding = active.filter((_, i) => i % 2 !== this._wdrawStep);
    moving.forEach((s, i) => {
      const off = (i - (moving.length - 1) / 2) * ATTACK_SPREAD;
      s.setMoveTarget(
        this._wdrawTarget.x + Math.cos(perp) * off,
        this._wdrawTarget.y + Math.sin(perp) * off,
      );
    });
    holding.forEach(s => { s.moveTarget = null; });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  _checkCasualties() {
    for (const s of this.soldiers) {
      const prev = this._prevSoldierStates.get(s) ?? s.state;
      if (prev === 'active' && s.state !== 'active') {
        // Soldier became a casualty — remove from contact set so the counter doesn't freeze
        this._contactingSet.delete(s);
        // If we had no idea who was shooting, flag an unknown threat
        if (!this._unknownThreat && this._knownActiveEnemies === 0) {
          this._unknownThreat      = true;
          this._hasContact         = true;
          this._knownActiveEnemies = 1;
          if (!this._prevContactState) {
            this._prevContactState = true;
            this._generateReport();
            if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
          }
        }
      }
      this._prevSoldierStates.set(s, s.state);
    }
  }

  _generateReport() {
    const active = this.soldiers.filter(s => s.active);
    this.lastReport = {
      tactic:          this._sgtPhase,
      troops:          active.length,
      total:           this.soldiers.length,
      opposition:      this._knownActiveEnemies,
      hasContact:      this._hasContact,
      distance:        this._lastLockedPos
                         ? Math.round(Math.hypot(this._lastLockedPos.x - this.x, this._lastLockedPos.y - this.y))
                         : null,
      troopsLost:      0,
      position:        { x: this.x, y: this.y },
      enemyPosition:   this._lastLockedPos ? { ...this._lastLockedPos } : null,
      hasATCapability: this.soldiers.some(s => s.active && s._isATRifleman),
      hasArmorContact: this._armorContact,
      armorContactPos: this._armorContactPos ? { ...this._armorContactPos } : null,
      time:            new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
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

  draw(ctx, camera, showCones = true) {
    if (this.dead || this._mounted) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;

    if (sx < -r * 6 || sy < -r * 6 || sx > ctx.canvas.width + r * 6 || sy > ctx.canvas.height + r * 6) return;

    ctx.save();

    if (this.active && showCones) {
      const lookAngle = this.facing + this._headOffset;
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

    if (this.active && this.isUnderFire) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4 * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,60,60,${0.4 + pulse * 0.4})`;
      ctx.lineWidth   = Math.max(1, zoom);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
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

    if (this.active) {
      const lookAngle = this.facing + this._headOffset;
      const dotX = sx + Math.cos(lookAngle) * r * 0.55;
      const dotY = sy + Math.sin(lookAngle) * r * 0.55;
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fill();

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

    if (this._hasContact && this._sgtPhase && zoom >= 1.5) {
      ctx.globalAlpha = 1;
      ctx.fillStyle   = 'rgba(255,255,255,0.7)';
      ctx.font        = `${Math.max(8, zoom * 7)}px monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(this._sgtPhase.toUpperCase(), sx, sy + r + 12 * zoom);
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
