import { addBullet, addImpact, addDeath } from './effects.js';
import { SQUAD_SIZE, PLATOON_SIZE } from './config.js';
import { Lieutenant } from './lieutenant.js';
import { Officer } from './officer.js';

const RADIUS           = 8;
const MOVE_SPEED       = 35;
const ARRIVE_THRESHOLD = 14;
const CAPTAIN_VISION   = 300;
const SHOOT_RANGE      = 130;
const DETECT_RANGE     = SHOOT_RANGE / 3;
const VISION_ANGLE     = Math.PI;
const FIRE_RATE_MIN    = 2.5;
const FIRE_RATE_MAX    = 4.0;
const UNDER_FIRE_DUR   = 4.0;

const SCOUT_VISION      = 380;
const SCOUT_SPEED       = 65;
const SCOUT_FLEE_DIST   = 280;
const SCOUT_DETECT      = SCOUT_VISION / 3;
const SCOUT_DANGER_DIST = 180; // flee if enemy closer than this when observing

const SIGHTING_MAX_AGE  = 30;   // s before a sighting is forgotten
const MAP_CENTER_X      = 4096; // 256 tiles * 32px / 2
const WAYPOINT_STEP     = 700;  // px per sector
const SCOUT_PATROL_TIME    = 10.0; // s to patrol sector before declaring clear
const ADVANCE_WAIT         = 18.0; // max s waiting for lts to reach waypoint
const CONSOLIDATE_TIME     = 20.0;  // s to regroup after battle
const REORDER_TIME         = 120.0; // 2-min post-battle reorder before next advance
const NO_CONTACT_LIMIT     = 120.0; // s of silence before captain consolidates all forces
const STRATEGY_COMMIT_TIME = 25.0; // min s before re-evaluating a chosen battle strategy
const SQUAD_FULL_SIZE   = SQUAD_SIZE; // from config.js
const FLANK_SPREAD      = 420;  // perpendicular px offset for flanking lts
const LT_WPT_SPREAD     = 200;  // vertical spread between lts at a waypoint

const MEDIC_SPEED      = 45;
const MEDIC_HEAL_RANGE = 20;   // px — must be this close to heal
const MEDIC_HEAL_TIME  = 3.0;  // s to revive one injured unit
const MEDIC_IDLE_DIST  = 80;   // follows captain at this distance when idle

// ── Medic ─────────────────────────────────────────────────────────────────────

export class Medic {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active';

    this._captain    = null;
    this._healTarget = null;
    this._healTimer  = 0;
    this._moveTarget = null;
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire() {}

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    // Safety is based only on what the captain has been told — not omniscient
    const isSafe = (x, y) => {
      if (!this._captain) return true;
      const now = Date.now() / 1000;
      return !this._captain._sightings.some(s => {
        if (now - s.time > 10) return false;
        const dx = s.x - x, dy = s.y - y;
        return dx * dx + dy * dy < 400 * 400;
      });
    };

    // Retreat if enemies get close to the medic
    if (!isSafe(this.x, this.y)) {
      this._healTarget = null;
      this._healTimer  = 0;
      this._moveTarget = null;
      return;
    }

    // Drop heal target if battle has moved to them
    if (this._healTarget && !isSafe(this._healTarget.x, this._healTarget.y)) {
      this._healTarget = null;
      this._healTimer  = 0;
    }

    // Continue healing current target
    if (this._healTarget) {
      if (this._healTarget.state !== 'injured') {
        this._healTarget = null;
        this._healTimer  = 0;
      } else {
        const dx   = this._healTarget.x - this.x;
        const dy   = this._healTarget.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > MEDIC_HEAL_RANGE) {
          this._moveToward(this._healTarget.x, this._healTarget.y, dt);
        } else {
          this._moveTarget = null;
          this._healTimer += dt;
          if (this._healTimer >= MEDIC_HEAL_TIME) {
            this._healTarget.state = 'active';
            this._healTarget       = null;
            this._healTimer        = 0;
          }
        }
        return;
      }
    }

    // Pick nearest injured friendly that is in a safe zone
    const safeInjured = allUnits.filter(u =>
      u !== this && u.state === 'injured' &&
      !factionMgr.areEnemies(this.factionId, u.factionId) &&
      isSafe(u.x, u.y)
    );

    if (safeInjured.length > 0) {
      let best = null, bestD = Infinity;
      for (const u of safeInjured) {
        const dx = u.x - this.x, dy = u.y - this.y;
        const d  = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = u; }
      }
      this._healTarget = best;
      this._healTimer  = 0;
      return;
    }

    // Nothing safe to heal — follow captain
    if (this._captain) {
      const dx   = this._captain.x - this.x;
      const dy   = this._captain.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > MEDIC_IDLE_DIST) {
        this._moveToward(this._captain.x, this._captain.y, dt);
      } else {
        this._moveTarget = null;
      }
    }
  }

  _moveToward(tx, ty, dt) {
    const dx   = tx - this.x;
    const dy   = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 2) {
      this.x      += (dx / dist) * MEDIC_SPEED * dt;
      this.y      += (dy / dist) * MEDIC_SPEED * dt;
      this.facing  = Math.atan2(dy, dx);
    }
  }

  draw(ctx, camera) {
    if (this.dead) return;
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;

    if (sx < -100 || sy < -100 || sx > ctx.canvas.width + 100 || sy > ctx.canvas.height + 100) return;

    ctx.save();
    ctx.globalAlpha = this.injured ? 0.5 : 1;

    // Cross symbol
    ctx.fillStyle   = this.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = Math.max(1, zoom * 1.5);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // White cross
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = Math.max(1, zoom * 1.2);
    ctx.beginPath();
    ctx.moveTo(sx - r * 0.5, sy); ctx.lineTo(sx + r * 0.5, sy);
    ctx.moveTo(sx, sy - r * 0.5); ctx.lineTo(sx, sy + r * 0.5);
    ctx.stroke();

    // Heal progress arc
    if (this._healTarget && this._healTimer > 0) {
      const pct = this._healTimer / MEDIC_HEAL_TIME;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4 * zoom, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
      ctx.strokeStyle = 'rgba(80,255,120,0.8)';
      ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
      ctx.stroke();
    }

    ctx.restore();
  }
}

// ── Scout ─────────────────────────────────────────────────────────────────────

export class Scout {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active';

    this.moveTarget      = null;
    this._isFleeing      = false;
    this._isObserving    = false;
    this._fleeTarget     = null;
    this._reportCooldown = 0;
    this._captain        = null;

    this._headOffset = 0;
    this._headTarget = 0;
    this._headTimer  = rand(1.0, 3.0);

    this._underFire      = false;
    this._underFireTimer = 0;
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire() {
    this._underFire      = true;
    this._underFireTimer = 3.0;
  }

  setMoveTarget(x, y) {
    if (!this.active) return;
    this.moveTarget = { x, y };
    this._isFleeing = false;
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    if (this._underFireTimer > 0) {
      this._underFireTimer -= dt;
      if (this._underFireTimer <= 0) this._underFire = false;
    }

    if (this._reportCooldown > 0) this._reportCooldown -= dt;

    const enemies = allUnits.filter(u =>
      u !== this && u.state !== 'dead' &&
      factionMgr.areEnemies(this.factionId, u.factionId) && u.active &&
      !(u instanceof Scout)
    );
    const visible = enemies.filter(e => this._canSee(e));

    if (visible.length > 0) {
      const cx = visible.reduce((s, e) => s + e.x, 0) / visible.length;
      const cy = visible.reduce((s, e) => s + e.y, 0) / visible.length;

      if (this._captain && this._reportCooldown <= 0) {
        visible.forEach(e => this._captain.receiveSightingReport({ x: e.x, y: e.y }));
        this._reportCooldown = 0.8;
      }

      if (this._underFire) {
        // Taking fire — break contact and run
        this._isObserving = false;
        const away = Math.atan2(this.y - cy, this.x - cx);
        this._fleeTarget = {
          x: this.x + Math.cos(away) * SCOUT_FLEE_DIST,
          y: this.y + Math.sin(away) * SCOUT_FLEE_DIST,
        };
        this._isFleeing = true;
      } else {
        // Visible enemies but not under fire — hold and observe
        this._isObserving = true;
        this._isFleeing   = false;
        this.moveTarget   = null;
      }
    } else {
      this._isObserving = false;
      // Under fire from an unseen shooter — run back the way we came
      if (this._underFire && !this._isFleeing) {
        const away = this.facing + Math.PI;
        this._fleeTarget = {
          x: this.x + Math.cos(away) * SCOUT_FLEE_DIST,
          y: this.y + Math.sin(away) * SCOUT_FLEE_DIST,
        };
        this._isFleeing = true;
      }
    }

    if (!this._isObserving && this._isFleeing && this._fleeTarget) {
      const dx = this._fleeTarget.x - this.x;
      const dy = this._fleeTarget.y - this.y;
      if (Math.sqrt(dx * dx + dy * dy) < ARRIVE_THRESHOLD) {
        this._isFleeing  = false;
        this._fleeTarget = null;
      }
    }

    const target = this._isFleeing ? this._fleeTarget : this.moveTarget;
    if (target) {
      const dx   = target.x - this.x;
      const dy   = target.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESHOLD) {
        const speed = this._isFleeing ? SCOUT_SPEED * 1.4 : SCOUT_SPEED;
        this.x     += (dx / dist) * speed * dt;
        this.y     += (dy / dist) * speed * dt;
        this.facing = Math.atan2(dy, dx);
      } else if (!this._isFleeing) {
        this.x = target.x;
        this.y = target.y;
        this.moveTarget = null;
      }
    }

    // Idle detection — request orders from captain if stationary with nothing to do
    const isIdle = !this.moveTarget && !this._isFleeing && !this._isObserving;
    if (isIdle) {
      this._idleTimer = (this._idleTimer || 0) + dt;
      if (this._idleTimer >= 2.0 && this._captain) {
        this._captain._scoutNeedsOrders(this);
        this._idleTimer = 0;
      }
    } else {
      this._idleTimer = 0;
    }

    this._headTimer -= dt;
    if (this._headTimer <= 0) {
      const opts = [-0.4, 0, 0.4].filter(t => Math.abs(t - this._headTarget) > 0.1);
      this._headTarget = opts[Math.floor(Math.random() * opts.length)];
      this._headTimer  = rand(1.0, 3.0);
    }
    const diff = normalizeAngle(this._headTarget - this._headOffset);
    const step = 1.6 * dt;
    this._headOffset = Math.abs(diff) <= step ? this._headTarget : this._headOffset + Math.sign(diff) * step;
  }

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < SCOUT_DETECT) return true;
    if (dist < SCOUT_VISION) {
      const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - (this.facing + this._headOffset)));
      if (diff < VISION_ANGLE / 2) return true;
    }
    return false;
  }

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom * 0.75;

    if (sx < -300 || sy < -300 || sx > ctx.canvas.width + 300 || sy > ctx.canvas.height + 300) return;

    ctx.save();

    if (this.active && showCones) {
      const lookAngle = this.facing + this._headOffset;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, SCOUT_VISION * zoom, lookAngle - VISION_ANGLE / 2, lookAngle + VISION_ANGLE / 2);
      ctx.closePath();
      ctx.fillStyle   = 'rgba(180,255,180,0.025)';
      ctx.fill();
      ctx.strokeStyle = this._isFleeing ? 'rgba(255,100,100,0.18)' : 'rgba(180,255,180,0.1)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom);
    ctx.stroke();
    ctx.restore();

    if (this.active) {
      const lookAngle = this.facing + this._headOffset;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(
        sx + Math.cos(lookAngle) * r * 0.5,
        sy + Math.sin(lookAngle) * r * 0.5,
        r * 0.28, 0, Math.PI * 2
      );
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fill();

      if (this._isFleeing) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 100);
        ctx.globalAlpha = pulse;
        ctx.fillStyle   = 'rgba(255,80,80,0.9)';
        ctx.font        = `${Math.max(7, zoom * 6)}px monospace`;
        ctx.textAlign   = 'center';
        ctx.fillText('!', sx, sy - r - 2 * zoom);
      }
    }

    ctx.restore();
  }
}

// ── Captain ───────────────────────────────────────────────────────────────────

export class Captain {
  constructor(x, y, factionId, facing = 0, color = '#888') {
    this.x         = x;
    this.y         = y;
    this.factionId = factionId;
    this.facing    = facing;
    this.color     = color;
    this.state     = 'active';

    this.lieutenants    = [];
    this.scouts         = [];
    this._commandSquads = [];
    this._promotedScouts    = [];
    this._promotedLts       = [];
    this._reconstitutedSgts = [];
    this._pendingPromotions = [];
    this._reconstituted     = false;

    // Phase machine
    this._phase            = 'forming';
    this._formingTimer     = 2.5;
    this._objective        = null; // {x, y} — set via setObjective()
    this._objectiveName    = 'objective';
    this._tactic           = null;
    this._marchDir         = 0;    // angle from start → objective
    this._waypoints        = [];   // [{x, y}] from start → objective
    this._waypointIdx      = 0;
    this._currentWpt       = null;
    this._scoutTimer       = 0;    // time elapsed in scouting phase
    this._advanceTimer     = 0;    // time elapsed in advancing phase
    this._consolidateTimer = 0;    // time elapsed in consolidating phase
    this._noContactTimer   = 0;    // s since last enemy sighting — triggers consolidation
    this._lastContactPos    = null; // last known enemy position
    this._flankingOrdered   = false;
    this._strategyChosen    = false;
    this._contactAssessTimer = 0;
    this._battleStrategy    = null;
    this._scoutDoctrine     = null; // set in _buildWaypoints
    this._lastSafeWpt       = null; // last waypoint confirmed clear
    this._rallyPoint        = null; // where to gather after battle
    this._battleStartTroops = 0;   // troop count when contact was made
    this._battleWon         = false;
    this._circleCenter      = null; // {x,y} for scout circle patrol
    this._circleAngle       = 0;

    // Awareness
    this._sightings          = [];   // [{x, y, time}] for visualization
    this._hasContact         = false;
    this._knownActiveEnemies = 0;
    this._tactic             = null;
    this._hasArmorContact    = false;
    this._armorContactPos    = null;

    // Attachment (one of: 'tanks' | 'mechanized' | 'artillery' | null)
    this._attachmentType  = null;
    this._attachmentUnits = [];   // flat list of all attachment unit objects
    this._attachOrderTimer = 0;

    // Movement
    this._moveTarget = null;

    // Head / eyes
    this._headOffset = 0;
    this._headTarget = 0;
    this._headTimer  = rand(1.2, 4.0);

    // Combat
    this._lockedTarget   = null;
    this._shootCooldown  = rand(1.0, FIRE_RATE_MAX);
    this._underFireTimer = 0;

    this._cachedAllUnits   = null;
    this._cachedFactionMgr = null;

    // Strategic Advisor
    this._advisor                = null;
    this._advisorRecommendation  = null;
  }

  attach(lieutenant) {
    this.lieutenants.push(lieutenant);
    lieutenant.commandingOfficer = this;
    return this;
  }

  attachScout(scout) {
    this.scouts.push(scout);
    scout._captain = this;
    return this;
  }

  attachCommandSquad(sgt) {
    this._commandSquads.push(sgt);
    return this;
  }

  attachRadioOperator(ro) {
    this.radioOperator = ro;
    ro.commandingOfficer = this;
    return this;
  }

  attachAdvisor(advisor) {
    this._advisor = advisor;
    advisor.commandingOfficer = this;
    return this;
  }

  setObjective(x, y, name = 'objective') {
    this._objective     = { x, y };
    this._objectiveName = name;
    this._tactic        = `advance to ${name}`;
  }

  get active()      { return this.state === 'active';  }
  get dead()        { return this.state === 'dead';    }
  get injured()     { return this.state === 'injured'; }
  get isUnderFire() { return this._underFireTimer > 0; }

  markUnderFire() {
    if (this.active) this._underFireTimer = UNDER_FIRE_DUR;
  }

  // ── Incoming reports ────────────────────────────────────────────────────────

  // Merges nearby sightings within 150px; updates count upward so arriving reinforcements
  // are reflected correctly instead of being hard-locked to the original slot count.
  _addSighting(x, y, count = 1) {
    const now      = Date.now() / 1000;
    const MERGE_R2 = 150 * 150;
    let nearest = null, nearestD2 = MERGE_R2;
    for (const s of this._sightings) {
      const dx = s.x - x, dy = s.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = s; }
    }
    if (nearest) {
      nearest.x     = x;
      nearest.y     = y;
      nearest.time  = now;
      nearest.count = Math.max(nearest.count, count);
    } else {
      this._sightings.push({ x, y, time: now, count });
    }
    this._sightings = this._sightings.filter(s => now - s.time < SIGHTING_MAX_AGE);
  }

  receiveSightingReport(pos) {
    this._addSighting(pos.x, pos.y, pos.count ?? 1);
    this._lastContactPos = { x: pos.x, y: pos.y };
    this._noContactTimer = 0;
    if (!this._hasContact) this._hasContact = true;
    // Re-engage from any non-committed phase — a scout report means enemies are real and present
    const nonCommitted = ['scouting', 'advancing', 'moving_up', 'rallying', 'holding', 'consolidating'];
    if (nonCommitted.includes(this._phase)) {
      this._enterContact();
    }
  }

  receiveContactReport(lt) {
    if (lt.lastReport?.enemyPosition) {
      const pos = lt.lastReport.enemyPosition;
      this._lastContactPos = { ...pos };
      this._addSighting(pos.x, pos.y, lt.lastReport.opposition ?? 1);
    }
    // Track armor contact — always reported immediately
    if (lt.lastReport?.hasArmorContact) {
      this._hasArmorContact = true;
      if (lt.lastReport.armorContactPos) {
        this._armorContactPos = { ...lt.lastReport.armorContactPos };
      }
    }
    this._noContactTimer = 0;
    if (!this._hasContact) this._hasContact = true;
    // Re-engage from any non-committed phase — an LT report means live contact
    const nonCommitted = ['scouting', 'advancing', 'moving_up', 'rallying', 'holding', 'consolidating'];
    if (nonCommitted.includes(this._phase)) {
      this._enterContact();
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    this._cachedAllUnits   = allUnits;
    this._cachedFactionMgr = factionMgr;

    if (this._underFireTimer > 0) this._underFireTimer -= dt;
    if (this._shootCooldown  > 0) this._shootCooldown  -= dt;

    this._checkPromotions();
    this._tickPendingPromotions();
    this._checkScoutPromotion();
    this._updateAttachment(dt);

    // If all officers are gone but soldiers survive, emergency retreat
    if (!['falling_back', 'emergency_retreat', 'forming', 'holding'].includes(this._phase)) {
      if (!this.lieutenants.some(l => l.active) && this._hasSurvivingOrphanedSoldiers()) {
        this._triggerEmergencyRetreat();
      }
    }

    // ── Phase machine ─────────────────────────────────────────────────────────
    switch (this._phase) {

      case 'forming':
        this._formingTimer -= dt;
        if (this._formingTimer <= 0) {
          this._buildWaypoints();
          this._startScouting();
        }
        break;

      case 'scouting': {
        // Only count patrol time once scouts have arrived at their positions
        const stillTraveling = this.scouts.some(s => s.active && s.moveTarget && !s._isFleeing);
        if (!stillTraveling) {
          this._scoutTimer += dt;
          if (this._scoutTimer >= SCOUT_PATROL_TIME) {
            this._onSectorClear();
          }
        }
        break;
      }

      case 'advancing':
        this._advanceTimer += dt;
        if (this._advanceTimer >= ADVANCE_WAIT || this._frontLtsNear(this._currentWpt)) {
          this._phase = 'moving_up';
          // Captain moves BEHIND the lieutenant line, not on top of them
          this._moveTarget = {
            x: this._currentWpt.x - Math.cos(this._marchDir) * 500,
            y: this._currentWpt.y - Math.sin(this._marchDir) * 500,
          };
        }
        break;

      case 'moving_up':
        this._tactic = `advance to ${this._objectiveName}`;
        if (!this._moveTarget) {
          // Don't advance until scouts confirm no live targets remain
          const combatClear = this._scoutsConfirmClear();
          if (combatClear) {
            this._waypointIdx++;
            this._startScouting();
          } else {
            this._tactic = 'waiting — scouts confirming clear';
          }
        }
        break;

      case 'contact':
        this._contactAssessTimer += dt;
        if (!this._strategyChosen && this._contactAssessTimer >= (this._personality?.contactAssessTime ?? 2.5)) {
          this._pickAndExecuteBattleStrategy();
          this._strategyChosen  = true;
          this._flankingOrdered = true;
          this._phase           = 'flanking';
        }
        break;

      case 'flanking':
        // Actively ping lts every 3s so stale _knownActiveEnemies can't trap this phase
        this._flankPingTimer = (this._flankPingTimer || 0) + dt;
        if (this._flankPingTimer >= 3.0) {
          this._flankPingTimer = 0;
          for (const lt of this.lieutenants.filter(l => l.active)) {
            if (lt._cachedAllUnits && lt._assess) {
              lt._assess(lt._cachedAllUnits, lt._cachedFactionMgr);
            }
          }
        }
        this._strategyCommitTimer  = (this._strategyCommitTimer  || 0) + dt;
        // Order flanking lts to push in once they've reached their flank position
        this._orderFlankPushIfReady();
        if (this._ltsHaveNoContact()) {
          // Enemy gone — always exit regardless of commit timer
          const now = Date.now() / 1000;
          const stragglers = this._sightings.filter(s => now - s.time < 10);
          if (stragglers.length > 0) {
            this._enterMoppingUp();
          } else {
            this._startRally();
          }
        } else if (this._strategyCommitTimer >= STRATEGY_COMMIT_TIME) {
          // Committed long enough — evaluate whether to stay the course or adapt
          this._strategyCommitTimer = 0;
          this._evaluateAndAdaptStrategy();
        }
        break;

      case 'mopping_up': {
        this._mopUpTimer = (this._mopUpTimer || 0) + dt;
        // If lts find serious contact again, re-engage properly
        if (this.lieutenants.some(l => l.active && l._knownActiveEnemies > 2)) {
          this._enterContact();
          break;
        }
        this._dispatchMopUpOrders();
        const now2 = Date.now() / 1000;
        const stillVisible = this._sightings.filter(s => now2 - s.time < 10);
        // Rally when area is clear, or after 45s of mopping up so stragglers don't trap us here
        if (stillVisible.length === 0 && this._ltsHaveNoContact() || this._mopUpTimer >= 45) {
          this._startRally();
        }
        break;
      }

      case 'rallying':
        this._consolidateTimer += dt;
        this._tickScoutCircle(dt);
        if (this._consolidateTimer >= CONSOLIDATE_TIME || this._allLtsNear(this._rallyPoint)) {
          this._startReordering();
        }
        break;

      case 'reordering':
        this._reorderTimer += dt;
        this._tickScoutCircle(dt);
        // Periodically re-issue orders to units that are still making their way in
        if (Math.floor(this._reorderTimer / 20) > (this._lastReorderPulse || 0)) {
          this._lastReorderPulse = Math.floor(this._reorderTimer / 20);
          this._reorderPulse();
        }
        if (this._reorderTimer >= REORDER_TIME) {
          this._reformFormation();
          this._checkPromotions();
          const remaining = this._countActiveTroops();
          if (remaining >= Math.max(1, this._battleStartTroops * 0.20)) {
            this._waypointIdx++;
            this._startScouting();
          } else {
            this._fallBack();
          }
        }
        break;

      case 'falling_back':
        this._tickScoutCircle(dt);
        this._fallBackTimer = (this._fallBackTimer || 0) + dt;
        if (!this._moveTarget) {
          const dest = this._lastSafeWpt || { x: this.x, y: this.y };
          // Timeout safety — don't get stuck waiting for lts that can't arrive
          if (this._allLtsNear(dest) || this._fallBackTimer > 20) {
            this._fallBackTimer = 0;
            const remaining = this._countActiveTroops();
            // If most force intact, try again — fallback is a tactical pause not a retreat
            if (remaining >= Math.max(1, this._battleStartTroops * 0.20)) {
              this._startScouting();
            } else {
              this._phase               = 'holding';
          this._holdTimer           = 0;
          this._defensiveLineFormed = false;
              this._tactic = 'hold';
              this._setScoutsToCircle(dest.x, dest.y);
            }
          }
        }
        break;

      case 'holding':
        this._tickScoutCircle(dt);
        this._dispatchMopUpOrders();
        this._holdTimer = (this._holdTimer || 0) + dt;
        if (this._holdTimer >= 60 && !this._defensiveLineFormed) {
          this._formDefensiveLine();
          this._defensiveLineFormed = true;
        }
        if (this._lastContactPos) this._noContactTimer += dt;
        if (this._noContactTimer >= NO_CONTACT_LIMIT) {
          this._noContactTimer = 0;
          this._phase  = 'consolidating';
          this._tactic = 'consolidate';
          this._dispatchConsolidation();
        }
        break;

      case 'consolidating':
        this._tickScoutCircle(dt);
        break;

      case 'emergency_retreat':
        this._tickScoutCircle(dt);
        // Re-issue orders to orphaned soldiers periodically in case they stop to fight
        this._retreatOrderTimer = (this._retreatOrderTimer || 0) + dt;
        if (this._retreatOrderTimer >= 5.0) {
          this._retreatOrderTimer = 0;
          this._orderOrphanedSoldiersTo(this._retreatDest);
        }
        if (!this._moveTarget) {
          this._phase               = 'holding';
          this._holdTimer           = 0;
          this._defensiveLineFormed = false;
          this._tactic = 'hold';
          this._setScoutsToCircle(this.x, this.y);
        }
        break;
    }

    // ── Own movement ──────────────────────────────────────────────────────────
    if (this._moveTarget) {
      const dx   = this._moveTarget.x - this.x;
      const dy   = this._moveTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > ARRIVE_THRESHOLD) {
        this.x      += (dx / dist) * MOVE_SPEED * dt;
        this.y      += (dy / dist) * MOVE_SPEED * dt;
        this.facing  = Math.atan2(dy, dx);
      } else {
        this.x = this._moveTarget.x;
        this.y = this._moveTarget.y;
        this._moveTarget = null;
      }
    }

    // ── Command squads — reposition to flank captain ─────────────────────────
    for (let i = 0; i < this._commandSquads.length; i++) {
      const sgt = this._commandSquads[i];
      if (!sgt.active) continue;
      const side   = i % 2 === 0 ? 1 : -1;
      const perp   = this._marchDir + Math.PI / 2;
      const tgtX   = this.x + Math.cos(perp) * 70 * side;
      const tgtY   = this.y + Math.sin(perp) * 70 * side;
      const dx     = sgt.x - tgtX, dy = sgt.y - tgtY;
      if (dx * dx + dy * dy > 100 * 100) {
        sgt.setMoveTarget(tgtX, tgtY);
      }
    }

    // ── Combat ────────────────────────────────────────────────────────────────
    const enemies   = allUnits.filter(u =>
      u !== this && u.state !== 'dead' && factionMgr.areEnemies(this.factionId, u.factionId)
    );
    const visActive = enemies.filter(e => e.active && this._canSee(e));
    this._lockedTarget = visActive.length > 0 ? nearest(this, visActive) : null;

    // Aggregate enemy count from own vision + lieutenant reports
    this._knownActiveEnemies = visActive.length + this.lieutenants
      .filter(lt => lt.active && lt.lastReport)
      .reduce((sum, lt) => sum + (lt.lastReport.opposition || 0), 0);

    if (this._lockedTarget) {
      const desired = normalizeAngle(
        Math.atan2(this._lockedTarget.y - this.y, this._lockedTarget.x - this.x) - this.facing
      );
      const diff = normalizeAngle(desired - this._headOffset);
      const step = 4.0 * dt;
      this._headOffset = Math.abs(diff) <= step ? desired : this._headOffset + Math.sign(diff) * step;
      this._headTimer  = rand(1.2, 4.0);
    } else {
      this._headTimer -= dt;
      if (this._headTimer <= 0) {
        const opts = [-Math.PI * 0.38, 0, Math.PI * 0.38].filter(t => Math.abs(t - this._headTarget) > 0.1);
        this._headTarget = opts[Math.floor(Math.random() * opts.length)];
        this._headTimer  = rand(1.2, 4.0);
      }
      const diff = normalizeAngle(this._headTarget - this._headOffset);
      const step = 1.6 * dt;
      this._headOffset = Math.abs(diff) <= step ? this._headTarget : this._headOffset + Math.sign(diff) * step;
    }

    if (this._lockedTarget && this._shootCooldown <= 0) {
      this._shoot(this._lockedTarget);
      this._shootCooldown = rand(FIRE_RATE_MIN, FIRE_RATE_MAX);
    }

    const now = Date.now() / 1000;
    this._sightings = this._sightings.filter(s => now - s.time < SIGHTING_MAX_AGE);
  }

  // ── Attachment API ──────────────────────────────────────────────────────────

  setAttachment(type, units) {
    this._attachmentType  = type;
    this._attachmentUnits = units;
  }

  _updateAttachment(dt) {
    if (!this._attachmentType || !this._attachmentUnits.length) return;

    this._attachOrderTimer += dt;
    if (this._attachOrderTimer < 6.0) return;
    this._attachOrderTimer = 0;

    const epos = this._armorContactPos || this._lastContactPos;

    // Formation half-width: scales with however many platoons are active.
    // LT_WPT_SPREAD is the natural spacing unit — all offsets are multiples of it.
    const activeLts = this.lieutenants.filter(l => l.active);
    const formHalf  = Math.max(1, (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
    const perp      = this._marchDir + Math.PI / 2;

    if (this._attachmentType === 'tanks') {
      const tanks = this._attachmentUnits.filter(u => u.active);
      if (!tanks.length) return;
      // Spread tanks evenly across the formation front
      const tankSpread = (formHalf * 2) / Math.max(tanks.length, 1);

      if (['contact', 'flanking', 'mopping_up'].includes(this._phase) && epos) {
        const toEnemy = Math.atan2(epos.y - this.y, epos.x - this.x);
        tanks.forEach((t, i) => {
          const off = (i - (tanks.length - 1) / 2) * tankSpread;
          t.setMoveTarget(
            epos.x - Math.cos(toEnemy) * LT_WPT_SPREAD * 1.25 + Math.cos(perp) * off,
            epos.y - Math.sin(toEnemy) * LT_WPT_SPREAD * 1.25 + Math.sin(perp) * off,
          );
        });
      } else if (this._currentWpt) {
        tanks.forEach((t, i) => {
          const off = (i - (tanks.length - 1) / 2) * tankSpread;
          t.setMoveTarget(
            this._currentWpt.x - Math.cos(this._marchDir) * LT_WPT_SPREAD * 1.75 + Math.cos(perp) * off,
            this._currentWpt.y - Math.sin(this._marchDir) * LT_WPT_SPREAD * 1.75 + Math.sin(perp) * off,
          );
        });
      }

    } else if (this._attachmentType === 'mechanized') {
      const platoon = this._attachmentUnits[0];
      if (!platoon || !platoon.active) return;
      // Flank staging position: just outside the infantry formation edge
      const flankOff = formHalf + LT_WPT_SPREAD;

      if (['flanking', 'mopping_up'].includes(this._phase) && epos) {
        // Infantry has fixed the enemy — APCs execute the envelopment around their flank
        const toEnemy   = Math.atan2(epos.y - this.y, epos.x - this.x);
        const enemyPerp = toEnemy + Math.PI / 2;
        platoon.setMoveTarget(
          epos.x + Math.cos(enemyPerp) * flankOff + Math.cos(toEnemy) * LT_WPT_SPREAD * 0.5,
          epos.y + Math.sin(enemyPerp) * flankOff + Math.sin(toEnemy) * LT_WPT_SPREAD * 0.5,
        );
      } else {
        // Advancing or contact assessment — keep pace with the infantry line, not the captain
        const wpt = this._currentWpt || { x: this.x, y: this.y };
        platoon.setMoveTarget(
          wpt.x + Math.cos(perp) * flankOff,
          wpt.y + Math.sin(perp) * flankOff,
        );
      }

    } else if (this._attachmentType === 'artillery') {
      const [cannon1, cannon2, spotter] = this._attachmentUnits;
      const spotTarget = spotter?._spotTarget;

      if (spotTarget) {
        // Observed fire — spotter has eyes on target, accurate
        if (cannon1?.active) cannon1.setTarget(spotTarget.x, spotTarget.y, false);
        if (cannon2?.active) cannon2.setTarget(spotTarget.x, spotTarget.y, false);
      } else {
        // Unobserved fire — use last known contact position, much wider scatter
        const now        = Date.now() / 1000;
        const fresh      = this._sightings.filter(s => now - s.time < 30);
        const unobserved = fresh.length > 0
          ? fresh[fresh.length - 1]
          : this._lastContactPos;
        if (unobserved) {
          if (cannon1?.active) cannon1.setTarget(unobserved.x, unobserved.y, true);
          if (cannon2?.active) cannon2.setTarget(unobserved.x, unobserved.y, true);
        }
      }
    }
  }

  // ── Phase helpers ───────────────────────────────────────────────────────────

  _buildWaypoints() {
    const end  = this._objective || { x: MAP_CENTER_X, y: this.y };
    const dx   = end.x - this.x;
    const dy   = end.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(3, Math.ceil(dist / WAYPOINT_STEP));
    this._marchDir = Math.atan2(dy, dx);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._waypoints.push({ x: this.x + dx * t, y: this.y + dy * t });
    }

    // Captain sets his own scout doctrine given his standing order (aggressive advance)
    this._scoutDoctrine = { depth: 'deep', onContact: 'observe' };

    // Each captain has a slightly different personality — affects strategy thresholds, timing, and formation
    const formations = ['line', 'refused_flank', 'two_back', 'wedge', 'echelon'];
    this._personality = {
      aggressionBias:    (Math.random() - 0.5) * 0.4,
      contactAssessTime: 4.0 + Math.random() * 3.0,
      marchFormation:    formations[Math.floor(Math.random() * formations.length)],
      echelonDir:        Math.random() < 0.5 ? 1 : -1,
    };
    this._frontLtSet = null;
  }

  _startScouting() {
    if (this._waypointIdx >= this._waypoints.length) {
      this._phase               = 'holding';
          this._holdTimer           = 0;
          this._defensiveLineFormed = false;
      this._tactic = 'hold';
      const holdPos = this._objective || { x: this.x, y: this.y };
      this._setScoutsToCircle(holdPos.x, holdPos.y);
      return;
    }
    this._currentWpt = this._waypoints[this._waypointIdx];
    this._scoutTimer = 0;
    this._phase      = 'scouting';
    this._tactic     = `advance to ${this._objectiveName}`;
    this._deployScoutsTo(this._currentWpt);
  }

  _deployScoutsTo(wpt) {
    const active = this.scouts.filter(s => s.active && !s._isFleeing);
    if (!active.length) return;

    // All scouts go to the same forward distance — a screen line, not a V.
    // They spread laterally so flanks are covered at the same depth as center.
    const fwd  = this._marchDir;
    const perp = this._marchDir + Math.PI / 2;

    // Deep doctrine: probe the sector after this one for earlier warning
    let targetWpt = wpt;
    if (this._scoutDoctrine?.depth === 'deep') {
      const nextIdx = this._waypointIdx + 1;
      if (nextIdx < this._waypoints.length) targetWpt = this._waypoints[nextIdx];
    }

    const dx   = targetWpt.x - this.x;
    const dy   = targetWpt.y - this.y;
    const fwdDist = Math.sqrt(dx * dx + dy * dy) + 200;
    const n    = active.length;

    // Measure how wide the army actually is, then put scouts beyond that
    let armyHalfWidth = 300;
    for (const lt of this.lieutenants.filter(l => l.active)) {
      const ldx  = lt.x - this.x;
      const ldy  = lt.y - this.y;
      const span = Math.abs(ldx * Math.cos(perp) + ldy * Math.sin(perp));
      if (span > armyHalfWidth) armyHalfWidth = span;
    }
    const totalSpan = (armyHalfWidth + 400) * 2; // scouts extend 400px past outermost lt on each side

    active.forEach((scout, i) => {
      const t          = n === 1 ? 0.5 : i / (n - 1);
      const lateral    = (t - 0.5) * totalSpan;
      const fwdJitter  = (Math.random() - 0.5) * 300; // ±150px forward variance
      const perpJitter = (Math.random() - 0.5) * 120; // ±60px lateral variance
      scout.setMoveTarget(
        this.x + Math.cos(fwd) * (fwdDist + fwdJitter) + Math.cos(perp) * (lateral + perpJitter),
        this.y + Math.sin(fwd) * (fwdDist + fwdJitter) + Math.sin(perp) * (lateral + perpJitter)
      );
    });
  }

  _getStableFormationOrder(activeLts) {
    if (!this._formationSlots) {
      // First assignment — sort laterally so left-to-right order is meaningful
      const perp = this._marchDir + Math.PI / 2;
      this._formationSlots = [...activeLts].sort((a, b) => {
        const la = a.x * Math.cos(perp) + a.y * Math.sin(perp);
        const lb = b.x * Math.cos(perp) + b.y * Math.sin(perp);
        return la - lb;
      });
      return [...this._formationSlots];
    }
    // Maintain existing order, drop dead, append any promoted lts at the end
    const ordered = this._formationSlots.filter(lt => lt.active);
    for (const lt of activeLts) {
      if (!ordered.includes(lt)) ordered.push(lt);
    }
    this._formationSlots = ordered;
    return [...ordered];
  }

  _onSectorClear() {
    this._lastSafeWpt  = { ...this._currentWpt };
    this._phase        = 'advancing';
    this._advanceTimer = 0;
    this._tactic       = `advance to ${this._objectiveName}`;

    const wpt       = this._currentWpt;
    const activeLts = this.lieutenants.filter(l => l.active);
    const formation = this._personality?.marchFormation || 'refused_flank';
    const ordered   = this._getStableFormationOrder(activeLts);

    const assignments = this._buildMarchFormation(ordered, wpt, formation);
    for (const a of assignments) a.lt.setMoveTarget(a.x, a.y);
    this._frontLtSet = new Set(assignments.filter(a => a.isFront).map(a => a.lt));
  }

  _buildMarchFormation(orderedLts, wpt, formation) {
    const fwd  = this._marchDir;
    const perp = this._marchDir + Math.PI / 2;
    const n    = orderedLts.length;
    const s    = LT_WPT_SPREAD;

    // Directly zip stable-ordered lts with positions — no proximity shuffle
    const zip = (lts, positions, isFront) =>
      lts.map((lt, i) => ({ lt, x: positions[i].x, y: positions[i].y, isFront }));

    switch (formation) {

      case 'line': {
        const positions = orderedLts.map((_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (n - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (n - 1) / 2) * s,
        }));
        return zip(orderedLts, positions, true);
      }

      case 'refused_flank': {
        // Last slot in the stable order is permanently the rear guard
        const frontLts = orderedLts.slice(0, -1);
        const rearLt   = orderedLts[orderedLts.length - 1];
        const frontN   = frontLts.length;
        const positions = frontLts.map((_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (frontN - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (frontN - 1) / 2) * s,
        }));
        return [
          ...zip(frontLts, positions, true),
          { lt: rearLt, x: this.x - Math.cos(fwd) * 160, y: this.y - Math.sin(fwd) * 160, isFront: false },
        ];
      }

      case 'two_back': {
        // Last two slots are permanently the rear guard
        const frontLts = orderedLts.slice(0, -2);
        const rearLts  = orderedLts.slice(-2);
        const frontN   = frontLts.length;
        const frontPositions = frontLts.map((_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (frontN - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (frontN - 1) / 2) * s,
        }));
        const rearAssignments = rearLts.map((lt, i) => {
          const side = i % 2 === 0 ? 1 : -1;
          return {
            lt,
            x: this.x - Math.cos(fwd) * 160 + Math.cos(perp) * 90 * side,
            y: this.y - Math.sin(fwd) * 160 + Math.sin(perp) * 90 * side,
            isFront: false,
          };
        });
        return [...zip(frontLts, frontPositions, true), ...rearAssignments];
      }

      case 'wedge': {
        const positions = orderedLts.map((_, i) => {
          const lateral = (i - (n - 1) / 2) * s;
          const depth   = Math.abs(i - (n - 1) / 2) * 140;
          return {
            x: wpt.x + Math.cos(perp) * lateral - Math.cos(fwd) * depth,
            y: wpt.y + Math.sin(perp) * lateral - Math.sin(fwd) * depth,
          };
        });
        const result = zip(orderedLts, positions, false);
        // Most forward is the front trigger — center slot leads in a wedge
        const center = Math.floor(n / 2);
        result[center].isFront = true;
        return result;
      }

      case 'echelon': {
        const dir = this._personality?.echelonDir ?? 1;
        const positions = orderedLts.map((_, i) => {
          const lateral = (i - (n - 1) / 2) * s;
          const depth   = (i - (n - 1) / 2) * 140 * dir;
          return {
            x: wpt.x + Math.cos(perp) * lateral + Math.cos(fwd) * depth,
            y: wpt.y + Math.sin(perp) * lateral + Math.sin(fwd) * depth,
          };
        });
        const result = zip(orderedLts, positions, false);
        // Leading slot (most forward in march direction) is the front trigger
        let frontIdx = 0, frontDot = -Infinity;
        result.forEach((a, i) => {
          const dot = (a.x - wpt.x) * Math.cos(fwd) + (a.y - wpt.y) * Math.sin(fwd);
          if (dot > frontDot) { frontDot = dot; frontIdx = i; }
        });
        result[frontIdx].isFront = true;
        return result;
      }

      default:
        return this._buildMarchFormation(orderedLts, wpt, 'refused_flank');
    }
  }

  _enterContact() {
    this._phase              = 'contact';
    this._flankingOrdered    = false;
    this._strategyChosen     = false;
    this._contactAssessTimer = 0;
    this._battleStrategy     = null;
    this._tactic             = 'contact — assessing';
    this._battleStartTroops  = this._countActiveTroops();

    // Rear guard commits immediately as reinforcements toward the contact
    const activeLts = this.lieutenants.filter(l => l.active);
    if (activeLts.length > 1 && this._lastContactPos) {
      const rearGuard  = activeLts[activeLts.length - 1];
      const toContact  = Math.atan2(
        this._lastContactPos.y - rearGuard.y,
        this._lastContactPos.x - rearGuard.x
      );
      rearGuard.setMoveTarget(
        this._lastContactPos.x - Math.cos(toContact) * 280,
        this._lastContactPos.y - Math.sin(toContact) * 280
      );
    }
  }

  _orderFlanking() {
    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;
    const epos = this._lastContactPos || this._currentWpt;
    if (!epos) return;

    const toEnemy = Math.atan2(epos.y - this.y, epos.x - this.x);
    const perp    = toEnemy + Math.PI / 2;
    const center  = Math.floor(activeLts.length / 2);

    // Build all target positions first
    const positions = activeLts.map((_, i) => {
      if (i === center) {
        return {
          x: epos.x - Math.cos(toEnemy) * 200,
          y: epos.y - Math.sin(toEnemy) * 200,
        };
      }
      const side  = i < center ? 1 : -1;
      const depth = i < center ? (center - 1 - i) : (i - center - 1);
      const dist  = FLANK_SPREAD + depth * 180;
      return {
        x: epos.x - Math.cos(toEnemy) * 150 + Math.cos(perp) * dist * side,
        y: epos.y - Math.sin(toEnemy) * 150 + Math.sin(perp) * dist * side,
      };
    });

    // Assign each position to the nearest available lieutenant so no one crosses
    const remaining = [...activeLts];
    for (const pos of positions) {
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const dx = remaining[i].x - pos.x, dy = remaining[i].y - pos.y;
        const d  = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      remaining[bestIdx].setMoveTarget(pos.x, pos.y);
      remaining.splice(bestIdx, 1);
    }
  }

  _orderFlankPushIfReady() {
    const epos = this._lastContactPos;
    if (!epos) return;
    const perp = this._marchDir + Math.PI / 2;

    for (const lt of this.lieutenants.filter(l => l.active)) {
      // Only push lts that have arrived at their flank position (no move target)
      // AND have made contact from the flank (they can see enemies)
      if (lt._moveTarget) continue;
      if (!lt._hasContact || lt._knownActiveEnemies === 0) continue;

      // Check this lt is actually off to the side — not the frontal lt
      const dx = lt.x - this.x;
      const dy = lt.y - this.y;
      const lateralOffset = Math.abs(dx * Math.cos(perp) + dy * Math.sin(perp));
      if (lateralOffset < FLANK_SPREAD * 0.4) continue;

      // Push them toward the enemy position from their flank angle
      const toEnemy = Math.atan2(epos.y - lt.y, epos.x - lt.x);
      lt.setMoveTarget(
        epos.x - Math.cos(toEnemy) * 120,
        epos.y - Math.sin(toEnemy) * 120,
      );
    }
  }

  _allLtsNear(wpt, radius = 300) {
    if (!wpt) return false;
    const r2     = radius * radius;
    const active = this.lieutenants.filter(l => l.active);
    if (!active.length) return true;
    return active.every(lt => {
      const dx = lt.x - wpt.x, dy = lt.y - wpt.y;
      return dx * dx + dy * dy < r2;
    });
  }

  _frontLtsNear(wpt) {
    const frontLts = this._frontLtSet
      ? [...this._frontLtSet].filter(lt => lt.active)
      : this.lieutenants.filter(l => l.active);
    if (!frontLts.length) return true;
    const r2 = 250 * 250;
    return frontLts.every(lt => {
      const dx = lt.x - wpt.x, dy = lt.y - wpt.y;
      return dx * dx + dy * dy < r2;
    });
  }

  _ltsHaveNoContact() {
    const active = this.lieutenants.filter(l => l.active);
    if (!active.length) {
      // No infantry left — base the answer on the captain's own awareness and scouts
      const now   = Date.now() / 1000;
      const fresh = this._sightings.filter(s => now - s.time < 10);
      return fresh.length === 0 && this._knownActiveEnemies === 0;
    }
    return active.every(lt => !lt._hasContact || lt._knownActiveEnemies === 0);
  }

  _isAreaClear() {
    return this._ltsHaveNoContact();
  }

  _enterMoppingUp() {
    this._phase      = 'mopping_up';
    this._tactic     = 'mop up';
    this._mopUpTimer = 0;
  }

  _dispatchMopUpOrders() {
    const now      = Date.now() / 1000;
    const targets  = this._sightings
      .filter(s => now - s.time < 10)
      .sort((a, b) => b.time - a.time); // freshest first

    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;

    if (!targets.length) {
      // Sightings went stale — cautiously advance the free LTs toward last known position
      if (!this._lastContactPos) return;
      const freeLts = activeLts.filter(l => l._knownActiveEnemies === 0 && !l._moveTarget);
      freeLts.forEach(lt => {
        const angle = Math.atan2(this._lastContactPos.y - lt.y, this._lastContactPos.x - lt.x);
        lt.setMoveTarget(
          this._lastContactPos.x - Math.cos(angle) * LT_WPT_SPREAD,
          this._lastContactPos.y - Math.sin(angle) * LT_WPT_SPREAD,
        );
      });
      return;
    }

    // Fresh sightings — send free LTs to clear each target cluster
    const freeLts = activeLts.filter(l => l._knownActiveEnemies === 0 && !l._moveTarget);
    freeLts.forEach((lt, i) => {
      const tgt   = targets[i % targets.length];
      const angle = Math.atan2(tgt.y - lt.y, tgt.x - lt.x);
      lt.setMoveTarget(
        tgt.x - Math.cos(angle) * LT_WPT_SPREAD * 0.75,
        tgt.y - Math.sin(angle) * LT_WPT_SPREAD * 0.75,
      );
    });
  }

  _formDefensiveLine() {
    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;

    // Orient the line toward the last known threat, or along march direction if none
    const threatPos  = this._lastContactPos || {
      x: this.x + Math.cos(this._marchDir) * 1000,
      y: this.y + Math.sin(this._marchDir) * 1000,
    };
    const toThreat   = Math.atan2(threatPos.y - this.y, threatPos.x - this.x);
    const perp       = toThreat + Math.PI / 2;
    const lineX      = this.x + Math.cos(toThreat) * 200;
    const lineY      = this.y + Math.sin(toThreat) * 200;

    const ordered = this._getStableFormationOrder(activeLts);
    ordered.forEach((lt, i) => {
      const offset = (i - (ordered.length - 1) / 2) * LT_WPT_SPREAD;
      lt.recallTo(
        lineX + Math.cos(perp) * offset,
        lineY + Math.sin(perp) * offset,
      );
    });

    this._tactic = 'defensive line';
  }

  // Direct orders to every unit in the company — bypasses chain so orphaned sgts
  // (whose LT is KIA) and orphaned soldiers (whose sgt is KIA) are still reached.
  _dispatchConsolidation() {
    const rear = this._marchDir + Math.PI;
    const perp = this._marchDir + Math.PI / 2;

    // Scouts pull back close to captain
    this.scouts.forEach(s => {
      if (!s.active) return;
      s._patrolCenter = { x: this.x, y: this.y };
      s._patrolRadius = LT_WPT_SPREAD * 0.4;
    });

    // All LTs — direct order regardless of whether they still have subordinates
    const allLts = this.lieutenants;
    allLts.forEach((lt, li) => {
      if (!lt.active) return;
      const lateralOff = (li - (allLts.length - 1) / 2) * LT_WPT_SPREAD * 0.5;
      const ltX = this.x + Math.cos(rear) * LT_WPT_SPREAD * 0.4 + Math.cos(perp) * lateralOff;
      const ltY = this.y + Math.sin(rear) * LT_WPT_SPREAD * 0.4 + Math.sin(perp) * lateralOff;
      lt._forcedMoveTarget = { x: ltX, y: ltY };
      lt._moveTarget       = null;
      lt._lockedTarget     = null;
    });

    // All sgts from all LTs — direct order even if their LT is KIA
    allLts.forEach((lt, li) => {
      const ltLateral = (li - (allLts.length - 1) / 2) * LT_WPT_SPREAD * 0.5;
      const ltX = this.x + Math.cos(rear) * LT_WPT_SPREAD * 0.4 + Math.cos(perp) * ltLateral;
      const ltY = this.y + Math.sin(rear) * LT_WPT_SPREAD * 0.4 + Math.sin(perp) * ltLateral;

      (lt.sergeants || []).forEach((sgt, si) => {
        if (!sgt.active) return;
        const sgtLateral = (si - (lt.sergeants.length - 1) / 2) * LT_WPT_SPREAD * 0.32;
        const sgtX = ltX + Math.cos(rear) * LT_WPT_SPREAD * 0.7 + Math.cos(perp) * sgtLateral;
        const sgtY = ltY + Math.sin(rear) * LT_WPT_SPREAD * 0.7 + Math.sin(perp) * sgtLateral;
        sgt._forcedMoveTarget = { x: sgtX, y: sgtY };
        sgt._moveTarget       = null;
        sgt._lockedTarget     = null;

        // All soldiers — direct order even if their sgt is the last one standing
        sgt.soldiers.forEach((sol, ski) => {
          if (!sol.active) return;
          const solLateral = (ski - (sgt.soldiers.length - 1) / 2) * LT_WPT_SPREAD * 0.14;
          const solX = sgtX + Math.cos(rear) * LT_WPT_SPREAD * 0.5 + Math.cos(perp) * solLateral;
          const solY = sgtY + Math.sin(rear) * LT_WPT_SPREAD * 0.5 + Math.sin(perp) * solLateral;
          sol.setMoveTarget(solX, solY);
          sol._lockedTarget = null;
        });
      });
    });
  }

  _scoutsConfirmClear() {
    // Any fresh sightings means not clear
    const now   = Date.now() / 1000;
    const fresh = this._sightings.filter(s => now - s.time < 15);
    if (fresh.length > 0) return false;
    // Any scout still observing an enemy means not clear
    if (this.scouts.some(s => s.active && s._isObserving)) return false;
    return true;
  }

  _scoutNeedsOrders(scout) {
    // During reordering — keep scouts fanned ahead on the march axis
    if (this._phase === 'reordering') {
      const activeScouts = this.scouts.filter(s => s.active);
      const idx       = activeScouts.indexOf(scout);
      const depth     = idx + 1;
      const targetIdx = Math.min(this._waypointIdx + depth, this._waypoints.length - 1);
      const wpt       = this._waypoints[targetIdx];
      if (wpt) scout.setMoveTarget(wpt.x, wpt.y);
      return;
    }

    // If scouting/advancing with no contact — scout is on station, throttle their idle requests
    if (['scouting', 'advancing', 'moving_up'].includes(this._phase) && !this._hasContact) {
      scout._idleTimer = -20;
      return;
    }

    if (this._circleCenter) {
      // Rally/hold/fallback — send on expanding outward patrol bearing
      if (!scout._patrolDist)    scout._patrolDist    = 250;
      if (!scout._patrolBearing) scout._patrolBearing = this._marchDir;
      scout.setMoveTarget(
        this._circleCenter.x + Math.cos(scout._patrolBearing) * scout._patrolDist,
        this._circleCenter.y + Math.sin(scout._patrolBearing) * scout._patrolDist,
      );
      scout._patrolDist    = Math.min(scout._patrolDist + 200, 900);
      scout._patrolBearing += 0.35;
    } else if (this._lastContactPos) {
      // In contact — send to flank observation position off the side of the enemy
      const epos    = this._lastContactPos;
      const toEnemy = Math.atan2(epos.y - this.y, epos.x - this.x);
      const perp    = toEnemy + Math.PI / 2;
      const side    = this.scouts.filter(s => s.active).indexOf(scout) % 2 === 0 ? 1 : -1;
      scout.setMoveTarget(
        epos.x - Math.cos(toEnemy) * 350 + Math.cos(perp) * 550 * side,
        epos.y - Math.sin(toEnemy) * 350 + Math.sin(perp) * 550 * side,
      );
    } else if (this._currentWpt) {
      // Advance — reposition to screen line ahead of current waypoint
      const activeScouts = this.scouts.filter(s => s.active);
      const idx          = activeScouts.indexOf(scout);
      const n            = Math.max(1, activeScouts.length);
      const perp         = this._marchDir + Math.PI / 2;
      const t            = n === 1 ? 0.5 : idx / (n - 1);
      const lateral      = (t - 0.5) * 1200;
      const dx           = this._currentWpt.x - this.x;
      const dy           = this._currentWpt.y - this.y;
      const fwdDist      = Math.sqrt(dx * dx + dy * dy) + 200;
      scout.setMoveTarget(
        this.x + Math.cos(this._marchDir) * fwdDist + Math.cos(perp) * lateral,
        this.y + Math.sin(this._marchDir) * fwdDist + Math.sin(perp) * lateral,
      );
    }
  }

  _checkScoutPromotion() {
    if (this.scouts.some(s => s.active)) return;
    for (const sgt of this._commandSquads) {
      if (!sgt.active) continue;
      const soldierIdx = (sgt.soldiers || []).findIndex(s => s.active);
      if (soldierIdx === -1) continue;
      // Remove the soldier from the squad roster — they're leaving this role
      const [soldier] = sgt.soldiers.splice(soldierIdx, 1);
      soldier.state = 'dead'; // clears them from allUnits draw/update
      const newScout = new Scout(soldier.x, soldier.y, this.factionId, soldier.facing, this.color);
      newScout._captain = this;
      this.scouts.push(newScout);
      this._promotedScouts.push(newScout);
      return;
    }
  }

  // After a battle, promote up to 3 scouts and send each one to a different
  // forward sector so the captain has eyes ahead before the next advance.
  _promoteAndDeployForwardScouts() {
    const MAX_SCOUTS = 3;

    // Stop any circle-patrol so deployed scouts aren't pulled back
    this._circleCenter = null;

    // Top up scouts from command-squad soldiers until we have MAX_SCOUTS
    while (this.scouts.filter(s => s.active).length < MAX_SCOUTS) {
      let promoted = false;
      for (const sgt of this._commandSquads) {
        if (!sgt.active) continue;
        const soldierIdx = (sgt.soldiers || []).findIndex(s => s.active);
        if (soldierIdx === -1) continue;
        const [soldier] = sgt.soldiers.splice(soldierIdx, 1);
        soldier.state = 'dead';
        const newScout = new Scout(soldier.x, soldier.y, this.factionId, soldier.facing, this.color);
        newScout._captain = this;
        this.scouts.push(newScout);
        this._promotedScouts.push(newScout);
        promoted = true;
        break;
      }
      if (!promoted) break;
    }

    // Send each scout to a progressively deeper forward sector (+1, +2, +3 waypoints)
    const activeScouts = this.scouts.filter(s => s.active);
    activeScouts.forEach((scout, i) => {
      const depth     = i + 1;
      const targetIdx = Math.min(this._waypointIdx + depth, this._waypoints.length - 1);
      const wpt       = this._waypoints[targetIdx];
      if (!wpt) return;
      scout._patrolDist    = 250;
      scout._patrolBearing = this._marchDir;
      scout.setMoveTarget(wpt.x, wpt.y);
    });
  }

  _checkPromotions() {
    for (const lt of this.lieutenants) {
      if (lt.active || lt._captainPromotionHandled) continue;
      lt._captainPromotionHandled = true;
      if (!lt.sergeants) continue;
      const survivors = lt.sergeants.filter(s => s.active);
      if (!survivors.length) continue;

      const sgt      = survivors[0];
      const otherSgts = survivors.slice(1, PLATOON_SIZE);
      const trooper  = sgt.soldiers.find(s => s.active);

      if (trooper) {
        // Walk trooper to sergeant's position; LT spawns when they arrive
        trooper.setMoveTarget(sgt.x, sgt.y);
        this._pendingPromotions.push({ trooper, sgt, otherSgts });
      } else {
        this._executeLtPromotion(sgt, otherSgts);
      }
    }
  }

  _executeLtPromotion(sgt, otherSgts) {
    const newLt = new Lieutenant(sgt.x, sgt.y, this.factionId, sgt.facing, this.color);
    newLt.commandingOfficer = this;
    sgt.commandingOfficer = newLt;
    newLt.sergeants.push(sgt);
    otherSgts.forEach(s => {
      s.commandingOfficer = newLt;
      newLt.sergeants.push(s);
    });
    this.lieutenants.push(newLt);
    this._promotedLts.push(newLt);
  }

  _reconstitute() {
    this._reconstituted = true;

    // Find soldiers whose sergeant is dead AND whose lieutenant is also dead
    // (_checkPromotions already handles dead-LT / live-sergeant cases)
    const orphans = [];
    for (const lt of this.lieutenants) {
      if (lt.active) continue;
      for (const sgt of (lt.sergeants || [])) {
        if (sgt.active) continue;
        for (const s of (sgt.soldiers || [])) {
          if (s.active) orphans.push(s);
        }
      }
    }

    if (orphans.length < 1) return;

    const newSgts = [];

    // Group orphans into squads of SQUAD_SIZE; first member becomes an Officer
    for (let i = 0; i < orphans.length; i += SQUAD_SIZE) {
      const chunk  = orphans.slice(i, i + SQUAD_SIZE);
      const leader = chunk[0];

      // Consume the leading trooper; spawn an Officer at their position
      leader.state = 'dead';
      const newSgt = new Officer(leader.x, leader.y, this.factionId, leader.facing, this.color);
      newSgt.commandingOfficer = null; // assigned below when LT is created

      chunk.slice(1).forEach(s => {
        s.commandingOfficer = newSgt;
        newSgt.soldiers.push(s);
      });

      newSgts.push(newSgt);
      this._reconstitutedSgts.push(newSgt);
    }

    // Group new sergeants into platoons of PLATOON_SIZE; create a Lieutenant per platoon
    for (let i = 0; i < newSgts.length; i += PLATOON_SIZE) {
      const platoon  = newSgts.slice(i, i + PLATOON_SIZE);
      const firstSgt = platoon[0];
      const newLt    = new Lieutenant(firstSgt.x, firstSgt.y, this.factionId, firstSgt.facing, this.color);
      newLt.commandingOfficer = this;
      platoon.forEach(sgt => {
        sgt.commandingOfficer = newLt;
        newLt.sergeants.push(sgt);
      });
      this.lieutenants.push(newLt);
      this._promotedLts.push(newLt);
    }
  }

  _tickPendingPromotions() {
    this._pendingPromotions = this._pendingPromotions.filter(p => {
      const { trooper, sgt, otherSgts } = p;
      // Trooper was killed before arriving — promote without the walk animation
      if (!trooper.active) {
        this._executeLtPromotion(sgt, otherSgts);
        return false;
      }
      const dx = trooper.x - sgt.x, dy = trooper.y - sgt.y;
      if (dx * dx + dy * dy < 20 * 20) {
        trooper.state = 'dead'; // trooper consumed — the LT appears in their place
        this._executeLtPromotion(sgt, otherSgts);
        return false;
      }
      return true; // still walking
    });
  }

  _countActiveTroops() {
    return this.lieutenants.filter(l => l.active).reduce((sum, lt) => {
      const soldiers = lt.sergeants
        ? lt.sergeants.reduce((s, sgt) => s + (sgt.soldiers || []).filter(sol => sol.active).length, 0)
        : (lt.soldiers || []).filter(sol => sol.active).length;
      return sum + soldiers + 1;
    }, 0);
  }

  _flankingIsViable(recentSightings) {
    if (!recentSightings.length) return false;
    const perp = this._marchDir + Math.PI / 2;

    // Find our flanking lieutenants — those whose move target is significantly
    // off to the side of the march axis (not just straight ahead).
    const flankLts = this.lieutenants.filter(l => {
      if (!l.active || !l._moveTarget) return false;
      const dx = l._moveTarget.x - this.x;
      const dy = l._moveTarget.y - this.y;
      const lateralOffset = Math.abs(dx * Math.cos(perp) + dy * Math.sin(perp));
      return lateralOffset > FLANK_SPREAD * 0.5;
    });

    if (!flankLts.length) return false; // no one is actually flanking

    // For each flanking lieutenant, check that enemy sightings are NOT already
    // between us and them (i.e., the enemy hasn't pivoted to block the route).
    for (const lt of flankLts) {
      const blocked = recentSightings.some(s => {
        // Is the sighting closer to the lt's path than the lt itself?
        const toDest = Math.atan2(lt._moveTarget.y - lt.y, lt._moveTarget.x - lt.x);
        const toSighting = Math.atan2(s.y - lt.y, s.x - lt.x);
        const angleDiff = Math.abs(normalizeAngle(toDest - toSighting));
        const dx = s.x - lt.x, dy = s.y - lt.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        return angleDiff < Math.PI * 0.25 && dist < 400;
      });
      if (!blocked) return true; // at least one flanking route is open
    }

    return false; // all flanking routes are blocked — envelop is no longer viable
  }

  _applyAdvisorIfConfident() {
    const rec = this._advisorRecommendation;
    if (!rec || rec.confidence < 0.75) return false;
    if      (rec.strategy === 'assault') { this._battleStrategy = 'assault'; this._orderFrontalAssault(); }
    else if (rec.strategy === 'envelop') { this._battleStrategy = 'envelop'; this._orderFlanking(); }
    else if (rec.strategy === 'defend')  { this._battleStrategy = 'defend';  this._orderHoldAndDefend(); }
    else return false;
    return true;
  }

  _evaluateAndAdaptStrategy() {
    const now          = Date.now() / 1000;
    const recent       = this._sightings.filter(s => now - s.time < 15);
    const clusters     = this._countContactClusters(recent, 500);
    const myStrength   = this._countActiveTroops();
    const enemyEst     = recent.reduce((s, sig) => s + (sig.count || 1), 0);
    const bias         = this._personality?.aggressionBias ?? 0;
    const troopRatio   = myStrength / Math.max(1, this._battleStartTroops);

    const continueValid = (() => {
      switch (this._battleStrategy) {
        case 'envelop':
          // Flanking still makes sense: not outnumbered, not badly mauled,
          // and the enemy flank is actually still open (sightings don't wrap
          // around our own flanking lieutenants, meaning the enemy hasn't
          // pivoted to face them).
          if (troopRatio < 0.55 || enemyEst > myStrength * (1.3 - bias) || clusters >= 3) return false;
          return this._flankingIsViable(recent);
        case 'assault':
          // Frontal still makes sense: we have numerical edge and aren't bleeding out
          return troopRatio >= 0.65 && myStrength > enemyEst * (1.4 - bias);
        case 'defend':
          // Defence still makes sense: enemy pressure is still high
          return enemyEst > myStrength * (0.6 - bias) || clusters >= 2;
        default:
          return false;
      }
    })();

    if (continueValid) {
      // Re-issue orders for current strategy to keep pressure on
      if      (this._battleStrategy === 'envelop')  this._orderFlanking();
      else if (this._battleStrategy === 'assault')  this._orderFrontalAssault();
      else if (this._battleStrategy === 'defend')   this._orderHoldAndDefend();
      return;
    }

    // Conditions changed — check advisor before picking from scratch
    if (!this._applyAdvisorIfConfident()) this._pickAndExecuteBattleStrategy();
  }

  _pickAndExecuteBattleStrategy() {
    if (this._applyAdvisorIfConfident()) return;
    const now      = Date.now() / 1000;
    const recent   = this._sightings.filter(s => now - s.time < 10);
    const clusters = this._countContactClusters(recent, 500);
    const myStrength  = this._countActiveTroops();
    const enemyEstimate = recent.reduce((s, sig) => s + (sig.count || 1), 0);

    const bias = this._personality?.aggressionBias ?? 0;
    if (clusters >= 3 || enemyEstimate > myStrength * (1.2 - bias)) {
      this._battleStrategy = 'defend';
      this._orderHoldAndDefend();
    } else if (myStrength > enemyEstimate * (1.8 - bias)) {
      this._battleStrategy = 'assault';
      this._orderFrontalAssault();
    } else {
      this._battleStrategy = 'envelop';
      this._orderFlanking();
      this._tactic = 'hasty envelopment';
    }
  }

  _countContactClusters(sightings, clusterDist) {
    if (!sightings.length) return 0;
    const clusters = [];
    for (const s of sightings) {
      const existing = clusters.find(c => {
        const dx = c.x - s.x, dy = c.y - s.y;
        return dx * dx + dy * dy < clusterDist * clusterDist;
      });
      if (existing) {
        existing.x = (existing.x + s.x) / 2;
        existing.y = (existing.y + s.y) / 2;
      } else {
        clusters.push({ x: s.x, y: s.y });
      }
    }
    return clusters.length;
  }

  _orderFrontalAssault() {
    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;
    const epos = this._lastContactPos || this._currentWpt;
    if (!epos) return;

    const toEnemy = Math.atan2(epos.y - this.y, epos.x - this.x);
    const perp    = toEnemy + Math.PI / 2;

    const positions = activeLts.map((_, i) => {
      const offset = (i - (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
      return {
        x: epos.x - Math.cos(toEnemy) * 100 + Math.cos(perp) * offset,
        y: epos.y - Math.sin(toEnemy) * 100 + Math.sin(perp) * offset,
      };
    });

    const remaining = [...activeLts];
    for (const pos of positions) {
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const dx = remaining[i].x - pos.x, dy = remaining[i].y - pos.y;
        const d  = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      remaining[bestIdx].orderAssault(pos.x, pos.y);
      remaining.splice(bestIdx, 1);
    }

    this._tactic = 'frontal assault';
  }

  _orderHoldAndDefend() {
    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;

    const perp  = this._marchDir + Math.PI / 2;
    const lineX = this.x + Math.cos(this._marchDir) * 120;
    const lineY = this.y + Math.sin(this._marchDir) * 120;

    // Use stable slot order so lts don't swap positions across repeated calls
    const ordered = this._getStableFormationOrder(activeLts);
    const n       = ordered.length;
    ordered.forEach((lt, i) => {
      const offset = (i - (n - 1) / 2) * LT_WPT_SPREAD;
      lt.recallTo(
        lineX + Math.cos(perp) * offset,
        lineY + Math.sin(perp) * offset,
      );
    });

    this._moveTarget = null;
    this._tactic     = 'hold and defend';
  }

  _hasSurvivingOrphanedSoldiers() {
    for (const lt of this.lieutenants) {
      if (lt.active) continue;
      if (lt.sergeants) {
        for (const sgt of lt.sergeants) {
          if ((sgt.soldiers || []).some(s => s.active)) return true;
        }
      } else if (lt.soldiers) {
        if (lt.soldiers.some(s => s.active)) return true;
      }
    }
    return false;
  }

  _triggerEmergencyRetreat() {
    this._phase  = 'emergency_retreat';
    this._tactic = 'emergency retreat';

    const dest = this._lastSafeWpt || {
      x: this.x - Math.cos(this._marchDir) * 800,
      y: this.y - Math.sin(this._marchDir) * 800,
    };
    this._retreatDest    = dest;
    this._retreatOrderTimer = 0;

    const now     = Date.now() / 1000;
    const threats = this._sightings.filter(s => now - s.time < 30);
    this._moveTarget = this._safeRouteWaypoint(this.x, this.y, dest, threats);

    this._orderOrphanedSoldiersTo(dest);
    this._setScoutsToCircle(dest.x, dest.y);
  }

  _orderOrphanedSoldiersTo(dest) {
    if (!dest) return;
    const now     = Date.now() / 1000;
    const threats = this._sightings.filter(s => now - s.time < 30);
    const via     = this._safeRouteWaypoint(this.x, this.y, dest, threats);

    const orphans = [];
    for (const lt of this.lieutenants) {
      if (lt.sergeants) {
        for (const sgt of lt.sergeants) {
          if (sgt.active) continue;
          for (const sol of (sgt.soldiers || [])) {
            if (sol.active) orphans.push(sol);
          }
        }
      } else if (!lt.active && lt.soldiers) {
        for (const sol of lt.soldiers) {
          if (sol.active) orphans.push(sol);
        }
      }
    }

    const cols = Math.ceil(Math.sqrt(orphans.length));
    orphans.forEach((sol, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      sol.setMoveTarget(
        via.x + (col - (cols - 1) / 2) * 40,
        via.y + (row - (Math.ceil(orphans.length / cols) - 1) / 2) * 40,
      );
    });
  }

  _safeRouteWaypoint(fromX, fromY, dest, threats) {
    const THREAT_RADIUS = 550;
    const pathBlocked   = threats.some(t =>
      distToSegment(t.x, t.y, fromX, fromY, dest.x, dest.y) < THREAT_RADIUS
    );

    if (!pathBlocked) {
      return { x: dest.x - Math.cos(this._marchDir) * 300, y: dest.y - Math.sin(this._marchDir) * 300 };
    }

    // Pick the side with fewer known threats and detour around them
    const perp = this._marchDir + Math.PI / 2;
    const midX = (fromX + dest.x) / 2;
    const midY = (fromY + dest.y) / 2;
    let leftCount = 0, rightCount = 0;
    for (const t of threats) {
      const dot = (t.x - midX) * Math.cos(perp) + (t.y - midY) * Math.sin(perp);
      if (dot > 0) leftCount++; else rightCount++;
    }
    const side = leftCount <= rightCount ? 1 : -1;
    return {
      x: midX + Math.cos(perp) * 900 * side,
      y: midY + Math.sin(perp) * 900 * side,
    };
  }

  _startReordering() {
    this._phase            = 'reordering';
    this._reorderTimer     = 0;
    this._lastReorderPulse = 0;
    this._tactic           = 'reordering';
    this._reconstituted    = false;

    const rallyBase = this._rallyPoint || this._currentWpt || { x: this.x, y: this.y };

    // Clear stale contact on all LTs so the movement guard doesn't pin them
    for (const lt of this.lieutenants) {
      lt._knownActiveEnemies = 0;
      lt._hasContact         = false;
    }

    // Order all active LTs to their positions at the rally base via recallTo —
    // this bypasses the movement guard and cascades down to their sergeants
    const activeLts = this.lieutenants.filter(l => l.active);
    const perp = this._marchDir + Math.PI / 2;
    activeLts.forEach((lt, i) => {
      const offset = (i - (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
      lt.recallTo(
        rallyBase.x + Math.cos(perp) * offset,
        rallyBase.y + Math.sin(perp) * offset,
      );
    });

    // Order every orphaned soldier (under dead LTs or dead sergeants) to gather
    this._orderOrphanedSoldiersTo(rallyBase);

    // Order any active sergeants still under dead LTs that weren't promoted yet
    for (const lt of this.lieutenants) {
      if (lt.active) continue;
      for (const sgt of (lt.sergeants || [])) {
        if (!sgt.active) continue;
        sgt.recallTo(rallyBase.x, rallyBase.y);
      }
    }

    this._promoteAndDeployForwardScouts();
    this._reconstitute();
  }

  // Periodic re-pulse during reordering — catches units still en route
  _reorderPulse() {
    const rallyBase = this._rallyPoint || this._currentWpt || { x: this.x, y: this.y };
    this._orderOrphanedSoldiersTo(rallyBase);
    for (const lt of this.lieutenants) {
      if (lt.active) continue;
      for (const sgt of (lt.sergeants || [])) {
        if (!sgt.active) continue;
        sgt.recallTo(rallyBase.x, rallyBase.y);
      }
    }
  }

  // Final formation tidy at the end of reordering — consolidates under-strength
  // squads, then places everyone into a proper march line before the next advance
  _reformFormation() {
    this._consolidateTroops();

    // Push the form-up line 200px forward of the rally base so troops visibly
    // advance into position rather than shuffling where they already stand.
    const rallyBase = this._rallyPoint || this._currentWpt || { x: this.x, y: this.y };
    const formX     = rallyBase.x + Math.cos(this._marchDir) * 200;
    const formY     = rallyBase.y + Math.sin(this._marchDir) * 200;
    const perp      = this._marchDir + Math.PI / 2;
    const activeLts = this.lieutenants.filter(l => l.active);
    const ordered   = this._getStableFormationOrder(activeLts);

    ordered.forEach((lt, li) => {
      const ltOff = (li - (ordered.length - 1) / 2) * LT_WPT_SPREAD;
      lt.recallTo(
        formX + Math.cos(perp) * ltOff,
        formY + Math.sin(perp) * ltOff,
      );
      // lt.recallTo cascades to the LT's sergeants automatically
    });
  }

  _consolidateTroops() {
    for (const lt of this.lieutenants) {
      const sgts = (lt.sergeants || []);
      if (!sgts.length) continue;

      // Step 1: Pool all active soldiers from dead sergeants
      const pool = [];
      for (const sgt of sgts) {
        if (sgt.active) continue;
        for (const sol of (sgt.soldiers || [])) {
          if (!sol.active) continue;
          sol.commandingOfficer = null;
          pool.push(sol);
        }
        sgt.soldiers = (sgt.soldiers || []).filter(s => !s.active);
      }

      const activeSgts = sgts.filter(s => s.active);
      if (!activeSgts.length) continue;

      // Step 2: Distribute dead-sergeant soldiers into active squads (smallest first)
      const bySize = () => [...activeSgts].sort((a, b) =>
        a.soldiers.filter(s => s.active).length - b.soldiers.filter(s => s.active).length
      );
      for (let i = 0; i < pool.length; i++) {
        const sgt = bySize()[i % activeSgts.length];
        sgt.soldiers.push(pool[i]);
        pool[i].commandingOfficer = sgt;
      }

      // Step 3: Merge under-strength squads into larger ones
      const mergeThreshold = SQUAD_FULL_SIZE - 1;
      const tinySquads = activeSgts.filter(s =>
        s.soldiers.filter(sol => sol.active).length <= mergeThreshold
      );
      const fullSquads = activeSgts.filter(s =>
        s.soldiers.filter(sol => sol.active).length > mergeThreshold
      );

      if (tinySquads.length > 0 && fullSquads.length > 0) {
        for (const tiny of tinySquads) {
          // Find the largest receiving squad
          const receiver = fullSquads.reduce((best, s) =>
            s.soldiers.filter(sol => sol.active).length >
            best.soldiers.filter(sol => sol.active).length ? s : best
          );
          const toMove = tiny.soldiers.filter(s => s.active);
          for (const sol of toMove) {
            tiny.soldiers.splice(tiny.soldiers.indexOf(sol), 1);
            receiver.soldiers.push(sol);
            sol.commandingOfficer = receiver;
          }
          // Tiny sergeant now has no squad — they fight alone until next reform
        }
      }
    }
  }

  _startRally() {
    const remaining  = this._countActiveTroops();
    const ownLosses  = Math.max(0, this._battleStartTroops - remaining);

    // Estimate enemy kills from lt reports: peak enemies seen minus still-active enemies
    const allLts = this.lieutenants;
    const enemyKillsEst = allLts.reduce((sum, lt) => {
      const peak    = lt._peakEnemyCount || 0;
      const current = lt.lastReport?.opposition || 0;
      return sum + Math.max(0, peak - current);
    }, 0);

    // Traded well (killed more than lost) → won; traded badly → lost
    // If no contact at all (both zero), treat as won to avoid false retreats
    // Also treat as won if 60%+ of force is still standing — kill estimates from LTs
    // are unreliable so don't retreat a largely intact force on bad intel
    const forceIntact = remaining >= this._battleStartTroops * 0.60;
    this._battleWon = forceIntact || (enemyKillsEst >= ownLosses) || (enemyKillsEst === 0 && ownLosses === 0);

    // Win → hold the position just taken; Loss → fall back to last safe sector
    const rallyBase = this._battleWon
      ? (this._currentWpt || { x: this.x, y: this.y })
      : (this._lastSafeWpt || { x: this.x - Math.cos(this._marchDir)*400, y: this.y - Math.sin(this._marchDir)*400 });

    this._rallyPoint       = { ...rallyBase };
    this._phase            = 'rallying';
    this._tactic           = this._battleWon ? 'hold position' : 'rally';
    this._consolidateTimer = 0;

    const activeLts = this.lieutenants.filter(l => l.active);
    const perp = this._marchDir + Math.PI / 2;
    activeLts.forEach((lt, i) => {
      const offset = (i - (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
      lt.setMoveTarget(rallyBase.x + Math.cos(perp)*offset, rallyBase.y + Math.sin(perp)*offset);
    });

    this._moveTarget = {
      x: rallyBase.x - Math.cos(this._marchDir) * 500,
      y: rallyBase.y - Math.sin(this._marchDir) * 500,
    };

    this._setScoutsToCircle(rallyBase.x, rallyBase.y);
  }

  _fallBack() {
    const dest       = this._lastSafeWpt
      ? { ...this._lastSafeWpt }
      : { x: this.x - Math.cos(this._marchDir)*600, y: this.y - Math.sin(this._marchDir)*600 };
    this._phase      = 'falling_back';
    this._tactic     = 'fall back';

    this._moveTarget = {
      x: dest.x - Math.cos(this._marchDir) * 500,
      y: dest.y - Math.sin(this._marchDir) * 500,
    };

    const activeLts = this.lieutenants.filter(l => l.active);
    const perp = this._marchDir + Math.PI / 2;
    activeLts.forEach((lt, i) => {
      // Clear stale contact so the movement guard doesn't block them from retreating
      lt._knownActiveEnemies = 0;
      const offset = (i - (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
      lt.setMoveTarget(dest.x + Math.cos(perp)*offset, dest.y + Math.sin(perp)*offset);
    });

    this._setScoutsToCircle(dest.x, dest.y);
  }

  _setScoutsToCircle(cx, cy) {
    this._circleCenter = { x: cx, y: cy };
    // Reset each scout's outward patrol state so they start fresh
    const n = Math.max(1, this.scouts.filter(s => s.active).length);
    this.scouts.filter(s => s.active).forEach((scout, i) => {
      scout._patrolDist    = 250;
      scout._patrolBearing = this._marchDir + (i / n) * Math.PI * 2;
    });
  }

  // Scouts patrol outward on unique bearings, pushing further each sweep.
  // Real scouts expand their awareness — they don't loop the same ring.
  _tickScoutCircle(_dt) {
    if (!this._circleCenter) return;
    const cx = this._circleCenter.x;
    const cy = this._circleCenter.y;
    const allActive = this.scouts.filter(s => s.active);

    for (const scout of allActive) {
      if (scout._isFleeing || scout.moveTarget) continue;

      // Initialise if somehow missing state
      if (!scout._patrolDist)    scout._patrolDist    = 250;
      if (!scout._patrolBearing) scout._patrolBearing = this._marchDir;

      // Send scout out on their bearing at current distance
      scout.setMoveTarget(
        cx + Math.cos(scout._patrolBearing) * scout._patrolDist,
        cy + Math.sin(scout._patrolBearing) * scout._patrolDist
      );

      // Next sweep: go further and rotate bearing slightly for new ground
      scout._patrolDist    = Math.min(scout._patrolDist + 200, 900);
      scout._patrolBearing += 0.35; // ~20° rotation per sweep
    }
  }

  // ── Combat helpers ──────────────────────────────────────────────────────────

  _canSee(other) {
    const dx   = other.x - this.x;
    const dy   = other.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < DETECT_RANGE) return true;
    if (dist < CAPTAIN_VISION) {
      const diff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - (this.facing + this._headOffset)));
      if (diff < VISION_ANGLE / 2) return true;
    }
    return false;
  }

  _shoot(target) {
    const hit = Math.random() < (0.50 - (this.isUnderFire ? 0.10 : 0));
    target.markUnderFire();
    addBullet(this.x, this.y, target.x, target.y, hit);
    if (hit) {
      addImpact(target.x, target.y);
      target.state = Math.random() < 0.40 ? 'dead' : 'injured';
      if (target.state === 'dead') addDeath(target.x, target.y, target.color);
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  draw(ctx, camera, showCones = true) {
    if (this.dead) return;

    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;

    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    // Route waypoints
    if (this._waypoints.length > 0) {
      for (let i = this._waypointIdx; i < this._waypoints.length; i++) {
        const wpt = this._waypoints[i];
        const wx  = (wpt.x - camera.x) * zoom;
        const wy  = (wpt.y - camera.y) * zoom;
        ctx.beginPath();
        ctx.arc(wx, wy, (i === this._waypointIdx ? 5 : 3) * zoom, 0, Math.PI * 2);
        ctx.fillStyle = i === this._waypointIdx
          ? `${this.color}80`
          : `${this.color}30`;
        ctx.fill();
      }
      // Line from captain to current waypoint
      if (this._currentWpt) {
        const cwx = (this._currentWpt.x - camera.x) * zoom;
        const cwy = (this._currentWpt.y - camera.y) * zoom;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(cwx, cwy);
        ctx.strokeStyle = `${this.color}20`;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Fading scout sighting dots
    const now = Date.now() / 1000;
    for (const s of this._sightings) {
      const age   = now - s.time;
      const alpha = Math.max(0, 0.45 * (1 - age / SIGHTING_MAX_AGE));
      const ssx   = (s.x - camera.x) * zoom;
      const ssy   = (s.y - camera.y) * zoom;
      ctx.beginPath();
      ctx.arc(ssx, ssy, 3 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,80,80,${alpha})`;
      ctx.fill();
    }

    // Command vision ring
    ctx.beginPath();
    ctx.arc(sx, sy, CAPTAIN_VISION * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = `${this.color}10`;
    ctx.lineWidth   = 1;
    ctx.setLineDash([10, 12]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.active) {
      if (showCones) {
        const lookAngle = this.facing + this._headOffset;
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

    // Triple rank ring — tight and thin
    [[4.5, 'rgba(0,0,0,0.6)'], [3, null], [1.5, 'rgba(0,0,0,0.6)']].forEach(([off, col]) => {
      ctx.beginPath();
      ctx.arc(sx, sy, r + off * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = col ?? this.color;
      ctx.lineWidth   = 0.75;
      ctx.stroke();
    });

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
      const lookAngle = this.facing + this._headOffset;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(
        sx + Math.cos(lookAngle) * r * 0.55,
        sy + Math.sin(lookAngle) * r * 0.55,
        r * 0.28, 0, Math.PI * 2
      );
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fill();

      // 3-bar pip
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const bw = r * 0.55, bh = r * 0.13, gap = r * 0.19;
      [-1, 0, 1].forEach(row => {
        ctx.fillRect(sx - bw / 2, sy + row * gap - bh / 2, bw, bh);
      });
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

    if (zoom >= 0.5) {
      ctx.globalAlpha = 1;
      ctx.fillStyle   = 'rgba(255,255,255,0.7)';
      ctx.font        = `bold ${Math.max(8, zoom * 7)}px monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(`CPT: ${(this._tactic || this._phase).toUpperCase()}`, sx, sy + r + 16 * zoom);
    }

    ctx.restore();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const nx = ax + t * dx - px, ny = ay + t * dy - py;
  return Math.sqrt(nx * nx + ny * ny);
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
