import { addBullet, addImpact, addDeath } from './effects.js';

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
const SCOUT_PATROL_TIME = 5.0;  // s to patrol sector before declaring clear
const ADVANCE_WAIT      = 14.0; // max s waiting for lts to reach waypoint
const CONSOLIDATE_TIME  = 8.0;  // s to regroup after battle
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
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire() {} // scouts flee instead of hunker

  setMoveTarget(x, y) {
    if (!this.active) return;
    this.moveTarget = { x, y };
    this._isFleeing = false;
  }

  update(dt, allUnits, factionMgr) {
    if (!this.active) return;

    if (this._reportCooldown > 0) this._reportCooldown -= dt;

    const enemies = allUnits.filter(u =>
      u !== this && u.state !== 'dead' &&
      factionMgr.areEnemies(this.factionId, u.factionId) && u.active &&
      !(u instanceof Scout)
    );
    const visible = enemies.filter(e => this._canSee(e));

    if (visible.length > 0) {
      const cx        = visible.reduce((s, e) => s + e.x, 0) / visible.length;
      const cy        = visible.reduce((s, e) => s + e.y, 0) / visible.length;
      const enemyDist = Math.sqrt((cx - this.x) ** 2 + (cy - this.y) ** 2);
      const doctrine  = this._captain?._scoutDoctrine?.onContact || 'flee';

      if (this._captain && this._reportCooldown <= 0) {
        visible.forEach(e => this._captain.receiveSightingReport({ x: e.x, y: e.y }));
        this._reportCooldown = doctrine === 'observe' ? 0.8 : 2.0;
      }

      if (doctrine === 'observe' && enemyDist > SCOUT_DANGER_DIST) {
        // Hold position and keep watching — only flee when enemy closes in
        this._isObserving = true;
        this._isFleeing   = false;
        this.moveTarget   = null;
      } else {
        this._isObserving = false;
        const away = Math.atan2(this.y - cy, this.x - cx);
        this._fleeTarget  = {
          x: this.x + Math.cos(away) * SCOUT_FLEE_DIST,
          y: this.y + Math.sin(away) * SCOUT_FLEE_DIST,
        };
        this._isFleeing = true;
      }
    } else {
      this._isObserving = false;
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

  receiveSightingReport(pos) {
    const now = Date.now() / 1000;
    this._sightings.push({ x: pos.x, y: pos.y, time: now });
    this._sightings = this._sightings.filter(s => now - s.time < SIGHTING_MAX_AGE);
    this._lastContactPos = { x: pos.x, y: pos.y };
    if (!this._hasContact) this._hasContact = true;
    if (['scouting', 'advancing', 'moving_up'].includes(this._phase)) {
      this._enterContact();
    }
  }

  receiveContactReport(lt) {
    if (lt.lastReport?.enemyPosition) {
      this._lastContactPos = { ...lt.lastReport.enemyPosition };
    }
    if (!this._hasContact) this._hasContact = true;
    if (['scouting', 'advancing', 'moving_up'].includes(this._phase)) {
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
          this._waypointIdx++;
          this._startScouting();
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
        if (this._ltsHaveNoContact()) {
          const now = Date.now() / 1000;
          const stragglers = this._sightings.filter(s => now - s.time < 10);
          if (stragglers.length > 0) {
            this._enterMoppingUp();
          } else {
            this._startRally();
          }
        }
        break;

      case 'mopping_up': {
        // If lts find serious contact again, re-engage properly
        if (this.lieutenants.some(l => l.active && l._knownActiveEnemies > 2)) {
          this._enterContact();
          break;
        }
        this._dispatchMopUpOrders();
        const now2 = Date.now() / 1000;
        const stillVisible = this._sightings.filter(s => now2 - s.time < 10);
        if (stillVisible.length === 0 && this._ltsHaveNoContact()) {
          this._startRally();
        }
        break;
      }

      case 'rallying':
        this._consolidateTimer += dt;
        this._tickScoutCircle(dt);
        if (this._consolidateTimer >= CONSOLIDATE_TIME || this._allLtsNear(this._rallyPoint)) {
          if (this._battleWon) {
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
            if (remaining >= Math.max(1, this._battleStartTroops * 0.60)) {
              this._startScouting();
            } else {
              this._phase  = 'holding';
              this._tactic = 'hold';
              this._setScoutsToCircle(dest.x, dest.y);
            }
          }
        }
        break;

      case 'holding':
        this._tickScoutCircle(dt);
        this._dispatchMopUpOrders();
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
          this._phase  = 'holding';
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
      contactAssessTime: 1.5 + Math.random() * 2.0,
      marchFormation:    formations[Math.floor(Math.random() * formations.length)],
      echelonDir:        Math.random() < 0.5 ? 1 : -1,
    };
    this._frontLtSet = null;
  }

  _startScouting() {
    if (this._waypointIdx >= this._waypoints.length) {
      this._phase  = 'holding';
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

  _onSectorClear() {
    this._lastSafeWpt  = { ...this._currentWpt };
    this._phase        = 'advancing';
    this._advanceTimer = 0;
    this._tactic       = `advance to ${this._objectiveName}`;

    const wpt       = this._currentWpt;
    const activeLts = this.lieutenants.filter(l => l.active);
    const formation = this._personality?.marchFormation || 'refused_flank';

    const assignments = this._buildMarchFormation(activeLts, wpt, formation);
    for (const a of assignments) a.lt.setMoveTarget(a.x, a.y);
    this._frontLtSet = new Set(assignments.filter(a => a.isFront).map(a => a.lt));
  }

  _buildMarchFormation(activeLts, wpt, formation) {
    const fwd  = this._marchDir;
    const perp = this._marchDir + Math.PI / 2;
    const n    = activeLts.length;
    const s    = LT_WPT_SPREAD;

    const assignByProximity = (lts, positions, isFront) => {
      const rem = [...lts], result = [];
      for (const pos of positions) {
        if (!rem.length) break;
        let best = 0, bestD = Infinity;
        rem.forEach((lt, i) => {
          const dx = lt.x - pos.x, dy = lt.y - pos.y;
          const d  = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = i; }
        });
        result.push({ lt: rem[best], x: pos.x, y: pos.y, isFront });
        rem.splice(best, 1);
      }
      return result;
    };

    switch (formation) {

      case 'line': {
        const positions = activeLts.map((_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (n - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (n - 1) / 2) * s,
        }));
        return assignByProximity(activeLts, positions, true);
      }

      case 'refused_flank': {
        const frontN   = Math.max(1, n - 1);
        const rearPos  = { x: this.x - Math.cos(fwd) * 160, y: this.y - Math.sin(fwd) * 160 };
        // nearest lt to rear position becomes the guard
        let rearIdx = 0, rearD = Infinity;
        activeLts.forEach((lt, i) => {
          const dx = lt.x - rearPos.x, dy = lt.y - rearPos.y;
          const d  = dx * dx + dy * dy;
          if (d < rearD) { rearD = d; rearIdx = i; }
        });
        const rearLt   = activeLts[rearIdx];
        const frontLts = activeLts.filter((_, i) => i !== rearIdx);
        const positions = Array.from({ length: frontN }, (_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (frontN - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (frontN - 1) / 2) * s,
        }));
        return [
          ...assignByProximity(frontLts, positions, true),
          { lt: rearLt, x: rearPos.x, y: rearPos.y, isFront: false },
        ];
      }

      case 'two_back': {
        const frontN    = Math.max(1, n - 2);
        const rearCount = n - frontN;
        const rearPositions = Array.from({ length: rearCount }, (_, i) => {
          const side = i % 2 === 0 ? 1 : -1;
          return {
            x: this.x - Math.cos(fwd) * 160 + Math.cos(perp) * 90 * side,
            y: this.y - Math.sin(fwd) * 160 + Math.sin(perp) * 90 * side,
          };
        });
        const rem = [...activeLts];
        const rearAssignments = [];
        for (const rp of rearPositions) {
          let best = 0, bestD = Infinity;
          rem.forEach((lt, i) => {
            const dx = lt.x - rp.x, dy = lt.y - rp.y;
            const d  = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
          });
          rearAssignments.push({ lt: rem[best], x: rp.x, y: rp.y, isFront: false });
          rem.splice(best, 1);
        }
        const frontPositions = Array.from({ length: frontN }, (_, i) => ({
          x: wpt.x + Math.cos(perp) * (i - (frontN - 1) / 2) * s,
          y: wpt.y + Math.sin(perp) * (i - (frontN - 1) / 2) * s,
        }));
        return [...assignByProximity(rem, frontPositions, true), ...rearAssignments];
      }

      case 'wedge': {
        // Center leads, flanks stagger back
        const positions = activeLts.map((_, i) => {
          const lateral = (i - (n - 1) / 2) * s;
          const depth   = Math.abs(i - (n - 1) / 2) * 140;
          return {
            x: wpt.x + Math.cos(perp) * lateral - Math.cos(fwd) * depth,
            y: wpt.y + Math.sin(perp) * lateral - Math.sin(fwd) * depth,
          };
        });
        const result = assignByProximity(activeLts, positions, false);
        // Most forward assignment is the "front" trigger
        result.sort((a, b) => {
          const da = (a.x - wpt.x) * Math.cos(fwd) + (a.y - wpt.y) * Math.sin(fwd);
          const db = (b.x - wpt.x) * Math.cos(fwd) + (b.y - wpt.y) * Math.sin(fwd);
          return db - da;
        });
        if (result.length) result[0].isFront = true;
        return result;
      }

      case 'echelon': {
        const dir = this._personality?.echelonDir ?? 1;
        const positions = activeLts.map((_, i) => {
          const lateral = (i - (n - 1) / 2) * s;
          const depth   = (i - (n - 1) / 2) * 140 * dir;
          return {
            x: wpt.x + Math.cos(perp) * lateral + Math.cos(fwd) * depth,
            y: wpt.y + Math.sin(perp) * lateral + Math.sin(fwd) * depth,
          };
        });
        const result = assignByProximity(activeLts, positions, false);
        result.sort((a, b) => {
          const da = (a.x - wpt.x) * Math.cos(fwd) + (a.y - wpt.y) * Math.sin(fwd);
          const db = (b.x - wpt.x) * Math.cos(fwd) + (b.y - wpt.y) * Math.sin(fwd);
          return db - da;
        });
        if (result.length) result[0].isFront = true;
        return result;
      }

      default:
        return this._buildMarchFormation(activeLts, wpt, 'refused_flank');
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
    if (!active.length) return true;
    return active.every(lt => !lt._hasContact || lt._knownActiveEnemies === 0);
  }

  _isAreaClear() {
    return this._ltsHaveNoContact();
  }

  _enterMoppingUp() {
    this._phase  = 'mopping_up';
    this._tactic = 'mop up';
  }

  _dispatchMopUpOrders() {
    const now      = Date.now() / 1000;
    const targets  = this._sightings
      .filter(s => now - s.time < 10)
      .sort((a, b) => b.time - a.time); // freshest first
    if (!targets.length) return;

    // Find lts not currently in contact and not already moving to a target
    const freeLts = this.lieutenants.filter(l =>
      l.active && l._knownActiveEnemies === 0 && !l._moveTarget
    );

    freeLts.forEach((lt, i) => {
      const tgt   = targets[i % targets.length];
      const angle = Math.atan2(tgt.y - lt.y, tgt.x - lt.x);
      lt.setMoveTarget(
        tgt.x - Math.cos(angle) * 150,
        tgt.y - Math.sin(angle) * 150
      );
    });
  }

  _checkPromotions() {
    for (const lt of this.lieutenants) {
      if (lt.active || lt._captainPromotionHandled) continue;
      lt._captainPromotionHandled = true;
      if (!lt.sergeants) continue; // already a promoted sergeant, no sub-sergeants
      const survivors = lt.sergeants.filter(s => s.active);
      if (!survivors.length) continue;
      const promoted = survivors[0];
      promoted.commandingOfficer = this;
      promoted._isPromotedToLt   = true;
      this.lieutenants.push(promoted);
    }
  }

  _countActiveTroops() {
    return this.lieutenants.filter(l => l.active).reduce((sum, lt) => {
      const soldiers = lt.sergeants
        ? lt.sergeants.reduce((s, sgt) => s + (sgt.soldiers || []).filter(sol => sol.active).length, 0)
        : (lt.soldiers || []).filter(sol => sol.active).length;
      return sum + soldiers + 1;
    }, 0);
  }

  _pickAndExecuteBattleStrategy() {
    const now      = Date.now() / 1000;
    const recent   = this._sightings.filter(s => now - s.time < 10);
    const clusters = this._countContactClusters(recent, 500);
    const myStrength  = this._countActiveTroops();
    const enemyEstimate = recent.length;

    const bias = this._personality?.aggressionBias ?? 0; // positive = more aggressive
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
      remaining[bestIdx].setMoveTarget(pos.x, pos.y);
      remaining.splice(bestIdx, 1);
    }

    this._tactic = 'frontal assault';
  }

  _orderHoldAndDefend() {
    const activeLts = this.lieutenants.filter(l => l.active);
    if (!activeLts.length) return;

    // Form a line slightly ahead of captain, perpendicular to march direction
    const perp  = this._marchDir + Math.PI / 2;
    const lineX = this.x + Math.cos(this._marchDir) * 120;
    const lineY = this.y + Math.sin(this._marchDir) * 120;

    const positions = activeLts.map((_, i) => {
      const offset = (i - (activeLts.length - 1) / 2) * LT_WPT_SPREAD;
      return {
        x: lineX + Math.cos(perp) * offset,
        y: lineY + Math.sin(perp) * offset,
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
      remaining[bestIdx].setMoveTarget(pos.x, pos.y);
      remaining.splice(bestIdx, 1);
    }

    // Captain holds position
    this._moveTarget = null;
    this._tactic = 'hold and defend';
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
    for (const lt of this.lieutenants) {
      if (lt.sergeants) {
        for (const sgt of lt.sergeants) {
          for (const sol of (sgt.soldiers || [])) {
            if (sol.active) sol.setMoveTarget(via.x, via.y);
          }
        }
      } else if (lt.soldiers) {
        for (const sol of lt.soldiers) {
          if (sol.active) sol.setMoveTarget(via.x, via.y);
        }
      }
    }
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
    this._battleWon = (enemyKillsEst >= ownLosses) || (enemyKillsEst === 0 && ownLosses === 0);

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

    // Triple rank ring
    [7, 5, 3].forEach((off, i) => {
      ctx.beginPath();
      ctx.arc(sx, sy, r + off * zoom, 0, Math.PI * 2);
      ctx.strokeStyle = i === 1 ? this.color : '#000';
      ctx.lineWidth   = Math.max(0.5, zoom * (i === 1 ? 0.5 : 0.8));
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
