import { addBullet, addImpact, addDeath } from './effects.js';
import { Officer } from './officer.js';

const RADIUS             = 8;
const MOVE_SPEED         = 45;
const ARRIVE_THRESHOLD   = 14;
const ASSESS_MIN         = 6.0;   // longer cycle — working from reports
const ASSESS_MAX         = 12.0;
const LT_VISION          = 350;   // own supplementary sight range
const SHOOT_RANGE        = 150;
const DETECT_RANGE       = SHOOT_RANGE / 3;
const VISION_ANGLE       = Math.PI;
const HEAD_TURN_TARGETS  = [-Math.PI * 0.38, 0, Math.PI * 0.38];
const HEAD_TURN_SPEED    = 1.6;
const HEAD_LOCK_SPEED    = 4.0;
const HEAD_HOLD_MIN      = 1.2;
const HEAD_HOLD_MAX      = 4.0;
const HIT_CHANCE_BASE    = 0.50;
const UNDER_FIRE_PENALTY = 0.10;
const CHANCE_KILL        = 0.40;
const FIRE_RATE_MIN      = 2.0;
const FIRE_RATE_MAX      = 3.5;
const UNDER_FIRE_DURATION = 4.0;

// How far apart to spread sergeant squads when attacking
const SQUAD_SPREAD = 120;

export class Lieutenant {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active';

    this.sergeants = []; // attached Officer instances

    this._tactic                = null;
    this._captainOrderedAssault = false;
    this._captainOrderedHold    = false;
    this._hasContact            = false;
    this._assessTimer        = rand(2.0, 4.0);
    this._moveTarget         = null;
    this._enemyCentroid      = null;
    this._knownActiveEnemies = 0;
    this._peakEnemyCount     = 0;
    this._consolidateTimer   = 0;
    this._lastBattleResult   = null;
    this._promotedSergeants  = [];

    // Combat — same as officer, shorter range
    this._headOffset     = 0;
    this._headTarget     = 0;
    this._headTimer      = rand(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
    this._lockedTarget   = null;
    this._shootCooldown  = rand(0.5, FIRE_RATE_MAX);
    this._underFireTimer = 0;

    this._reportTimer      = rand(8.0, 14.0);
    this.lastReport        = null;
    this.commandingOfficer = null;
    this._prevContactState = false;
    this._armorContact     = false;
    this._armorContactPos  = null;

    this._cachedAllUnits   = null;
    this._cachedFactionMgr = null;
  }

  attach(sergeant) {
    this.sergeants.push(sergeant);
    sergeant.commandingOfficer = this; // back-reference for contact reports
    return this;
  }

  attachStaffSergeant(ss) {
    this.staffSergeant = ss;
    ss.commandingOfficer = this;
    return this;
  }

  // Called by StaffSergeant once per visible enemy — updates our centroid estimate
  receiveStaffSighting(pos) {
    this._enemyCentroid = { x: pos.x, y: pos.y };
  }

  // Called by StaffSergeant when contact state changes — trigger immediate assess
  receiveStaffContactChange(ss, hasContact, enemy) {
    if (!hasContact || !this._cachedAllUnits) return;
    this._assess(this._cachedAllUnits, this._cachedFactionMgr);
    this._assessTimer = rand(ASSESS_MIN, ASSESS_MAX);
  }

  // Called immediately by a sergeant when contact is made or cleared
  receiveContactReport(sergeant) {
    if (!this._cachedAllUnits) return;
    this._assess(this._cachedAllUnits, this._cachedFactionMgr);
    this._assessTimer = rand(ASSESS_MIN, ASSESS_MAX); // reset so we don't double-assess immediately
  }

  get active()      { return this.state === 'active';  }
  get dead()        { return this.state === 'dead';    }
  get injured()     { return this.state === 'injured'; }
  get isUnderFire() { return this._underFireTimer > 0; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DURATION;
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    this._captainOrderedHold = false; // captain gave a move order — autonomous consolidation allowed again
    const angle           = Math.atan2(y - this.y, x - this.x);
    const activeSergeants = this.sergeants.filter(s => s.active);
    // Spread sergeants at the ordered position; LT stays 150px behind them
    const positions = spreadPositions(x, y, angle, SQUAD_SPREAD, activeSergeants.length);
    activeSergeants.forEach((sgt, i) => sgt.setMoveTarget(positions[i].x, positions[i].y));
    this._moveTarget = { x: x - Math.cos(angle) * 150,
                         y: y - Math.sin(angle) * 150 };
    if (this.staffSergeant?.active) this.staffSergeant.setMoveTarget(x, y);
  }

  // Captain assault order — advances LT despite being in contact;
  // uses _forcedMoveTarget so the contact movement guard is bypassed,
  // and orders sergeants forward with setMoveTarget (not recallTo) so
  // they move+fight rather than leapfrog-withdraw.
  orderAssault(x, y) {
    if (!this.active) return;
    this._captainOrderedAssault = true;
    this._captainOrderedHold    = false;
    const angle           = Math.atan2(y - this.y, x - this.x);
    // LT advances to 250px short of the contact point — sergeants close the last stretch
    this._forcedMoveTarget = { x: x - Math.cos(angle) * 250,
                               y: y - Math.sin(angle) * 250 };
    const activeSergeants = this.sergeants.filter(s => s.active);
    // Sergeants ordered to the actual contact position; their own 70px offset keeps them short
    const positions = spreadPositions(x, y, angle, SQUAD_SPREAD, activeSergeants.length);
    activeSergeants.forEach((sgt, i) => sgt.orderAssault(positions[i].x, positions[i].y));
    this._tactic = 'attack';
  }

  // Captain recall — bypasses the contact movement guard so lts consolidate even under fire
  recallTo(x, y) {
    if (!this.active) return;
    this._captainOrderedAssault = false;
    this._captainOrderedHold    = true;
    this._forcedMoveTarget = { x, y };
    const angle           = Math.atan2(y - this.y, x - this.x);
    const activeSergeants = this.sergeants.filter(s => s.active);
    const aheadX          = x + Math.cos(angle) * 80;
    const aheadY          = y + Math.sin(angle) * 80;
    const positions       = spreadPositions(aheadX, aheadY, angle, SQUAD_SPREAD, activeSergeants.length);
    activeSergeants.forEach((sgt, i) => sgt.recallTo(positions[i].x, positions[i].y));
    if (this.staffSergeant?.active) this.staffSergeant.setMoveTarget(x, y);
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    // Cache so receiveContactReport() can trigger an immediate assessment
    this._cachedAllUnits   = allUnits;
    this._cachedFactionMgr = factionMgr;

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    // ── Movement ──────────────────────────────────────────────────────────────
    const moveTgt      = this._forcedMoveTarget || this._moveTarget;
    const isForced     = !!this._forcedMoveTarget;
    const hasTroops    = this.sergeants.some(s => s.active);
    const enemiesKnown = this._hasContact && this._knownActiveEnemies > 0;

    if (moveTgt && (isForced || (!enemiesKnown && hasTroops))) {
      const dx   = moveTgt.x - this.x;
      const dy   = moveTgt.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESHOLD) {
        this.x      += (dx / dist) * MOVE_SPEED * dt;
        this.y      += (dy / dist) * MOVE_SPEED * dt;
        this.facing  = Math.atan2(dy, dx);
      } else {
        this.x = moveTgt.x;
        this.y = moveTgt.y;
        if (isForced) this._forcedMoveTarget = null;
        else          this._moveTarget       = null;
      }
    }

    // ── Combat ────────────────────────────────────────────────────────────────
    const enemies = allUnits.filter(
      u => u !== this && u.state !== 'dead' && factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const activeEnemies  = enemies.filter(e => e.active  || e.state === 'active');
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

    // ── Consolidation countdown ───────────────────────────────────────────────
    if (this._tactic === 'consolidate') {
      this._consolidateTimer -= dt;
      if (this._consolidateTimer <= 0) this._resolveConsolidation();
    }

    // ── Assessment (from reports + own eyes) ──────────────────────────────────
    this._assessTimer -= dt;
    if (this._assessTimer <= 0) {
      this._assess(allUnits, factionMgr);
      this._assessTimer = rand(ASSESS_MIN, ASSESS_MAX);
    }

    // ── Report ────────────────────────────────────────────────────────────────
    this._reportTimer -= dt;
    if (this._reportTimer <= 0) {
      this._generateReport();
      this._reportTimer = rand(10.0, 18.0);
      if (this.commandingOfficer && this._knownActiveEnemies > 0) {
        this.commandingOfficer.receiveContactReport(this);
      }
    }

    // ── Reintegrate revived sergeants ─────────────────────────────────────────
    // Only pull idle sergeants in when the LT itself has stopped — never while
    // marching, or sergeants (and their soldiers) get yanked backward past the LT.
    const ltStopped = !this._moveTarget && !this._forcedMoveTarget;
    if (this._knownActiveEnemies === 0 && ltStopped) {
      this._reintegrateTimer = (this._reintegrateTimer || 0) - dt;
      if (this._reintegrateTimer <= 0) {
        this._reintegrateTimer = 5.0;
        const idle = this.sergeants.filter(s => s.active && !s._moveTarget && !s._forcedMoveTarget && !s._lockedTarget);
        if (idle.length > 0) {
          const perp = this.facing + Math.PI / 2;
          idle.forEach((sgt, i) => {
            const offset = (i - (idle.length - 1) / 2) * SQUAD_SPREAD;
            sgt.setMoveTarget(
              this.x + Math.cos(perp) * offset,
              this.y + Math.sin(perp) * offset,
            );
          });
        }
      }
    } else {
      this._reintegrateTimer = 5.0;
    }
  }

  _assess(allUnits, factionMgr) {
    // ── Gather intelligence ───────────────────────────────────────────────────
    // Primary: sergeant reports — use the HIGHEST single report, not the sum.
    // Multiple sergeants often see the same enemies; summing inflates the count
    // and makes the LT believe there are far more enemies than actually present.
    let reportedOpposition = 0;
    let sgtsReporting      = false;
    const enemyPositions   = [];

    for (const sgt of this.sergeants) {
      if (!sgt.active || !sgt.lastReport) continue;
      if (sgt.lastReport.opposition > reportedOpposition) {
        reportedOpposition = sgt.lastReport.opposition;
      }
      sgtsReporting = true;
      if (sgt.lastReport.enemyPosition) enemyPositions.push(sgt.lastReport.enemyPosition);
    }

    // Secondary: own vision + staff sergeant — only used when no sergeant is reporting,
    // so we don't double-count enemies the sergeants already saw.
    let ownSightCount = 0;
    if (!sgtsReporting) {
      for (const u of allUnits) {
        if (u === this || u.factionId === this.factionId || u.state === 'dead') continue;
        if (!factionMgr.areEnemies(this.factionId, u.factionId)) continue;
        if (!(u.active || u.state === 'active')) continue;
        if (!this._canSee(u)) continue;
        ownSightCount++;
        enemyPositions.push({ x: u.x, y: u.y });
      }
      // Staff sergeant extends our awareness when our own sight is limited
      if (this.staffSergeant?.active && this.staffSergeant._visibleCount > ownSightCount) {
        ownSightCount = this.staffSergeant._visibleCount;
        if (this.staffSergeant._lastEnemyPos) enemyPositions.push(this.staffSergeant._lastEnemyPos);
      }
    }

    this._knownActiveEnemies = reportedOpposition + ownSightCount;
    if (this._knownActiveEnemies > this._peakEnemyCount) {
      this._peakEnemyCount = this._knownActiveEnemies;
    }

    // Detect contact change — notify captain immediately
    const nowInContact = this._knownActiveEnemies > 0;
    if (nowInContact !== this._prevContactState) {
      this._prevContactState = nowInContact;
      if (nowInContact && !this._hasContact) this._hasContact = true;
      this._generateReport();
      if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
    }

    if (this._knownActiveEnemies === 0) {
      this._enemyCentroid = null; // no live enemies — clear so stale position isn't reported up
      if (this._hasContact && !this._captainOrderedHold && this._tactic !== 'consolidate' && this._tactic !== 'advance') {
        this._tactic           = 'consolidate';
        this._consolidateTimer = rand(8, 15);
        const activeSgts = this.sergeants.filter(s => s.active);
        const perp = this.facing + Math.PI / 2;
        activeSgts.forEach((sgt, i) => {
          const offset = (i - (activeSgts.length - 1) / 2) * SQUAD_SPREAD;
          sgt.setMoveTarget(
            this.x + Math.cos(perp) * offset,
            this.y + Math.sin(perp) * offset,
          );
        });
      }
      return;
    }

    if (!this._hasContact) this._hasContact = true;

    if (enemyPositions.length > 0) {
      this._enemyCentroid = {
        x: enemyPositions.reduce((s, p) => s + p.x, 0) / enemyPositions.length,
        y: enemyPositions.reduce((s, p) => s + p.y, 0) / enemyPositions.length,
      };
    }

    // ── Reinforcement: redirect freed squads to help engaged ones ─────────────
    const activeSgts   = this.sergeants.filter(s => s.active);
    const freedSgts    = activeSgts.filter(s =>
      s.lastReport && s.lastReport.hasContact && s.lastReport.opposition === 0
    );
    const engagedSgts  = activeSgts.filter(s =>
      s.lastReport && s.lastReport.opposition > 0
    );

    const available = [...freedSgts];
    for (const engaged of engagedSgts) {
      if (available.length === 0) break;
      const helper = nearest(engaged, available);
      available.splice(available.indexOf(helper), 1);
      // Order to a position just behind the struggling sergeant
      const angle = Math.atan2(engaged.y - helper.y, engaged.x - helper.x);
      helper.setMoveTarget(
        engaged.x - Math.cos(angle) * 60,
        engaged.y - Math.sin(angle) * 60
      );
    }

    // ── Armor contact — aggregate and flash-report up the chain ──────────────
    const armorSgts = activeSgts.filter(s => s.lastReport?.hasArmorContact);
    if (armorSgts.length > 0) {
      const wasArmor = this._armorContact;
      this._armorContact    = true;
      this._armorContactPos = armorSgts[0].lastReport.armorContactPos || this._armorContactPos;
      if (!wasArmor) {
        // Immediate flash up to captain
        this._generateReport();
        if (this.commandingOfficer) this.commandingOfficer.receiveContactReport(this);
      }
      // Send the AT-capable sergeant toward the armor contact
      if (this._armorContactPos) {
        const atSgt = activeSgts.find(s => s.lastReport?.hasATCapability);
        if (atSgt && !atSgt._moveTarget && !atSgt._forcedMoveTarget) {
          const pos   = this._armorContactPos;
          const angle = Math.atan2(pos.y - atSgt.y, pos.x - atSgt.x);
          atSgt.setMoveTarget(
            pos.x - Math.cos(angle) * 60,
            pos.y - Math.sin(angle) * 60,
          );
        }
      }
    } else {
      this._armorContact = false;
    }

    // ── Overall tactic ────────────────────────────────────────────────────────
    const totalTroops = activeSgts.reduce(
      (s, sgt) => s + (sgt.lastReport ? sgt.lastReport.troops : sgt.soldiers.filter(x => x.active).length),
      0
    ) + 1; // +1 for self

    // With a captain assault order, lower the threshold — attack even at near-equal strength
    const attackThreshold = this._captainOrderedAssault ? 0.9 : 1.25;
    let tactic;
    if (totalTroops < this._knownActiveEnemies * 0.8) {
      tactic = 'fallback';
    } else if (!this._captainOrderedHold && totalTroops > this._knownActiveEnemies * attackThreshold) {
      tactic = 'attack';
    } else {
      tactic = 'hold';
    }

    if (tactic !== this._tactic) {
      this._tactic = tactic;
      this._issueOrders(activeSgts, tactic);
    }
  }

  _resolveConsolidation() {
    // ── God eval: count actual casualties on both sides ───────────────────────
    const au   = this._cachedAllUnits;
    const fmgr = this._cachedFactionMgr;
    let enemyCasualties = this._peakEnemyCount; // fallback if no cache
    let ownLosses = 0;
    if (au && fmgr) {
      enemyCasualties = au.filter(u =>
        u !== this && fmgr.areEnemies(this.factionId, u.factionId) && u.state !== 'active'
      ).length;
    }
    ownLosses = this.sergeants.reduce(
      (sum, sgt) => sum + sgt.soldiers.filter(s => s.state !== 'active').length, 0
    );
    this._lastBattleResult = { enemyCasualties, ownLosses };

    // ── Promote soldiers to sergeant from squads that lost their commander ────
    for (let i = 0; i < this.sergeants.length; i++) {
      const sgt = this.sergeants[i];
      if (sgt.state !== 'dead') continue;
      const survivors = sgt.soldiers.filter(s => s.active);
      if (survivors.length === 0) continue;

      const promotee = survivors[0];
      const newSgt   = new Officer(promotee.x, promotee.y, this.factionId, promotee.facing, this.color);
      newSgt.commandingOfficer = this;
      survivors.forEach(s => newSgt.soldiers.push(s));
      sgt.soldiers = []; // release from dead sergeant so no double-commanding
      this.sergeants[i] = newSgt;
      this._promotedSergeants.push(newSgt);
    }

    // ── Decide advance or withdraw ─────────────────────────────────────────────
    const activeSgts  = this.sergeants.filter(s => s.active);
    const totalTroops = activeSgts.reduce(
      (sum, sgt) => sum + sgt.soldiers.filter(s => s.active).length, 0
    );

    if (totalTroops > 0 && this._enemyCentroid && !this._captainOrderedHold) {
      this._tactic = 'advance';
      const toEnemy = Math.atan2(
        this._enemyCentroid.y - this.y,
        this._enemyCentroid.x - this.x
      );
      const pushX = this._enemyCentroid.x + Math.cos(toEnemy) * 80;
      const pushY = this._enemyCentroid.y + Math.sin(toEnemy) * 80;
      const positions = spreadPositions(
        pushX + Math.cos(toEnemy) * 80,
        pushY + Math.sin(toEnemy) * 80,
        toEnemy, SQUAD_SPREAD, activeSgts.length
      );
      activeSgts.forEach((sgt, i) => {
        sgt._knownActiveEnemies = 0; // clear stale contact count so movement guard lifts
        sgt.setMoveTarget(positions[i].x, positions[i].y);
      });
      this._moveTarget = { x: pushX, y: pushY };
    } else {
      this._tactic = 'fallback';
      if (this._enemyCentroid) {
        const awayAngle = Math.atan2(
          this._enemyCentroid.y - this.y,
          this._enemyCentroid.x - this.x
        ) + Math.PI;
        activeSgts.forEach(sgt => {
          sgt._knownActiveEnemies = 0;
          sgt.setMoveTarget(
            sgt.x + Math.cos(awayAngle) * 200,
            sgt.y + Math.sin(awayAngle) * 200
          );
        });
        this._moveTarget = {
          x: this.x + Math.cos(awayAngle) * 150,
          y: this.y + Math.sin(awayAngle) * 150,
        };
      }
    }
  }

  _issueOrders(activeSgts, tactic) {
    if (tactic === 'attack') {
      const anyKnownPos = activeSgts.map(s => s.lastReport?.enemyPosition).find(p => p != null);

      activeSgts.forEach(sgt => {
        const targetPos = sgt.lastReport?.enemyPosition ?? anyKnownPos;
        if (targetPos) {
          const angle = Math.atan2(targetPos.y - sgt.y, targetPos.x - sgt.x);
          sgt.setMoveTarget(
            targetPos.x - Math.cos(angle) * 80,
            targetPos.y - Math.sin(angle) * 80
          );
        } else if (sgt._marchDir !== null) {
          // Contact confirmed but no position known — push forward in march direction
          sgt.setMoveTarget(
            sgt.x + Math.cos(sgt._marchDir) * 150,
            sgt.y + Math.sin(sgt._marchDir) * 150
          );
        }
      });

    } else if (tactic === 'fallback') {
      // Retreat away from the most recently known enemy position
      const enemyRef = activeSgts.map(s => s.lastReport?.enemyPosition).find(p => p != null)
        ?? this._enemyCentroid;
      if (!enemyRef) return;

      activeSgts.forEach(sgt => {
        const away = Math.atan2(enemyRef.y - sgt.y, enemyRef.x - sgt.x) + Math.PI;
        sgt.setMoveTarget(
          sgt.x + Math.cos(away) * 200,
          sgt.y + Math.sin(away) * 200
        );
      });
      const ltAway = Math.atan2(enemyRef.y - this.y, enemyRef.x - this.x) + Math.PI;
      this._moveTarget = {
        x: this.x + Math.cos(ltAway) * 150,
        y: this.y + Math.sin(ltAway) * 150,
      };
    }
    // hold: no new orders
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
    const penalty = this.isUnderFire ? UNDER_FIRE_PENALTY : 0;
    const hit     = Math.random() < (HIT_CHANCE_BASE - penalty);
    target.markUnderFire();
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      target.state = Math.random() < CHANCE_KILL ? 'dead' : 'injured';
      if (target.state === 'dead') addDeath(target.x, target.y, target.color);
    }
  }

  _generateReport() {
    const activeSgts = this.sergeants.filter(s => s.active);
    const totalTroops = activeSgts.reduce(
      (s, sgt) => s + (sgt.lastReport ? sgt.lastReport.troops : 0), 0
    );
    // Use _knownActiveEnemies (already MAX-deduped across sergeant reports) rather
    // than summing all sergeant counts — the sum inflates when multiple sergeants
    // see the same enemies simultaneously.
    const totalOpposition = this._knownActiveEnemies;

    const enemyPos = this._enemyCentroid
      ? { ...this._enemyCentroid }
      : (activeSgts.find(s => s.lastReport?.enemyPosition)?.lastReport?.enemyPosition ?? null);

    this.lastReport = {
      tactic:          this._tactic,
      squads:          activeSgts.length,
      totalSquads:     this.sergeants.length,
      troops:          totalTroops,
      opposition:      totalOpposition,
      hasContact:      this._hasContact,
      enemyPosition:   enemyPos,
      hasArmorContact: this._armorContact,
      armorContactPos: this._armorContactPos ? { ...this._armorContactPos } : null,
      time:            new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
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
      // Command awareness ring
      ctx.beginPath();
      ctx.arc(sx, sy, LT_VISION * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = `${this.color}18`;
      ctx.lineWidth   = 1;
      ctx.setLineDash([6, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.active) {
      if (showCones) {
        const lookAngle = this.facing + this._headOffset;

        // Shoot cone
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, SHOOT_RANGE * zoom, lookAngle - VISION_ANGLE / 2, lookAngle + VISION_ANGLE / 2);
        ctx.closePath();
        ctx.fillStyle   = this._lockedTarget ? 'rgba(255,180,80,0.08)' : 'rgba(255,255,200,0.04)';
        ctx.fill();
        ctx.strokeStyle = this._lockedTarget ? 'rgba(255,180,80,0.2)' : 'rgba(255,255,200,0.1)';
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      if (this.isUnderFire) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4 * zoom, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,60,60,${0.4 + pulse * 0.4})`;
        ctx.lineWidth   = Math.max(1, zoom);
        ctx.stroke();
      }
    }

    // Double rank ring — tight and thin
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = 0.75;
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
      // Head dot
      const lookAngle = this.facing + this._headOffset;
      const dotX = sx + Math.cos(lookAngle) * r * 0.55;
      const dotY = sy + Math.sin(lookAngle) * r * 0.55;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fill();

      // 4-pointed star pip (rank indicator, distinct from sergeant diamond)
      ctx.globalAlpha = 1;
      const pip = r * 0.38;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      drawStar4(ctx, sx, sy, pip);
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
      ctx.font        = `bold ${Math.max(8, zoom * 7)}px monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(`LT: ${this._tactic.toUpperCase()}`, sx, sy + r + 14 * zoom);
    }

    ctx.restore();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function spreadPositions(cx, cy, facing, spread, count) {
  const px = -Math.sin(facing), py = Math.cos(facing);
  return Array.from({ length: count }, (_, i) => {
    const offset = (i - (count - 1) / 2) * spread;
    return { x: cx + px * offset, y: cy + py * offset };
  });
}

function drawStar4(ctx, cx, cy, size) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI / 4) - Math.PI / 2;
    const r     = i % 2 === 0 ? size : size * 0.38;
    i === 0
      ? ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r)
      : ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  ctx.closePath();
  ctx.fill();
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
