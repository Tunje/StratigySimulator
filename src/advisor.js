const MOVE_SPEED      = 55;
const ARRIVE_THRESH   = 14;
const RADIUS          = 8;
const PERP_OFFSET     = 40;
const DELIBERATE_INTV = 15.0;
const CLUSTER_R       = 300;  // px — positions within this are the same enemy group

export class StrategicAdvisor {
  constructor(x, y, factionId, facing, color) {
    this.x          = x;
    this.y          = y;
    this.factionId  = factionId;
    this.facing     = facing;
    this.color      = color;
    this.state      = 'active';
    this.armorClass = 'none';

    this.commandingOfficer  = null;
    this._deliberateTimer   = rand(3.0, 8.0); // stagger first deliberation
    this._underFireTimer    = 0;
  }

  get active()  { return this.state === 'active';  }
  get dead()    { return this.state === 'dead';    }
  get injured() { return this.state === 'injured'; }

  markUnderFire()      { if (this.active) this._underFireTimer = 4.0; }
  receiveContactAlert() {}

  update(dt) {
    if (!this.active) return;
    if (this._underFireTimer > 0) this._underFireTimer -= dt;

    this._followCO(dt);

    this._deliberateTimer -= dt;
    if (this._deliberateTimer <= 0) {
      this._deliberate();
      this._deliberateTimer = DELIBERATE_INTV;
    }
  }

  _followCO(dt) {
    const co = this.commandingOfficer;
    if (!co?.active) return;
    const perp = co.facing + Math.PI / 2;
    const tgtX = co.x + Math.cos(perp) * PERP_OFFSET;
    const tgtY = co.y + Math.sin(perp) * PERP_OFFSET;
    const dx   = tgtX - this.x, dy = tgtY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > ARRIVE_THRESH) {
      this.x      += (dx / dist) * MOVE_SPEED * dt;
      this.y      += (dy / dist) * MOVE_SPEED * dt;
      this.facing  = Math.atan2(dy, dx);
    } else {
      this.facing = co.facing;
    }
  }

  _deliberate() {
    const cpt = this.commandingOfficer;
    if (!cpt) return;

    // Never interfere with survival phases
    if (cpt._phase === 'emergency_retreat' || cpt._phase === 'falling_back') {
      cpt._advisorRecommendation = null;
      return;
    }

    const now      = Date.now() / 1000;
    const activeLts = cpt.lieutenants.filter(l => l.active);
    if (!activeLts.length) { cpt._advisorRecommendation = null; return; }

    // ── Build enemy picture from LT reports ────────────────────────────────────
    const rawPositions = [];
    let ltsInContact   = 0;
    let ltsFallingBack = 0;

    for (const lt of activeLts) {
      if (!lt.lastReport) continue;
      if (lt.lastReport.hasContact)          ltsInContact++;
      if (lt.lastReport.tactic === 'fallback') ltsFallingBack++;
      if (lt.lastReport.enemyPosition) {
        rawPositions.push({
          x:     lt.lastReport.enemyPosition.x,
          y:     lt.lastReport.enemyPosition.y,
          count: lt.lastReport.opposition || 1,
        });
      }
    }

    // Add any recent sightings not already covered by LT positions
    for (const s of cpt._sightings.filter(s => now - s.time < 20)) {
      const covered = rawPositions.some(p => {
        const dx = p.x - s.x, dy = p.y - s.y;
        return dx * dx + dy * dy < CLUSTER_R * CLUSTER_R;
      });
      if (!covered) rawPositions.push({ x: s.x, y: s.y, count: s.count || 1 });
    }

    // Deduplicate into enemy groups — take max count per cluster
    const enemyGroups = [];
    for (const pos of rawPositions) {
      const near = enemyGroups.find(g => {
        const dx = g.x - pos.x, dy = g.y - pos.y;
        return dx * dx + dy * dy < CLUSTER_R * CLUSTER_R;
      });
      if (near) {
        near.count = Math.max(near.count, pos.count);
        near.x = (near.x + pos.x) / 2;
        near.y = (near.y + pos.y) / 2;
      } else {
        enemyGroups.push({ x: pos.x, y: pos.y, count: pos.count });
      }
    }

    const totalEnemies = enemyGroups.reduce((s, g) => s + g.count, 0);
    const totalTroops  = cpt._countActiveTroops();

    if (totalTroops === 0) { cpt._advisorRecommendation = null; return; }

    // ── Recommendation logic (priority order) ─────────────────────────────────

    // Most platoons are falling back — hunker down
    if (ltsFallingBack >= Math.ceil(activeLts.length * 0.6)) {
      cpt._advisorRecommendation = {
        strategy:   'defend',
        confidence: 0.85,
        reason:     `${ltsFallingBack}/${activeLts.length} platoons retreating`,
      };
      return;
    }

    // Significantly outnumbered
    if (totalEnemies > 0 && totalEnemies > totalTroops * 1.5) {
      cpt._advisorRecommendation = {
        strategy:   'defend',
        confidence: 0.82,
        reason:     `outnumbered ${totalEnemies} vs ${totalTroops}`,
      };
      return;
    }

    // Enemy too dispersed across separate groups to assault safely
    if (enemyGroups.length >= 3) {
      cpt._advisorRecommendation = {
        strategy:   'defend',
        confidence: 0.76,
        reason:     `${enemyGroups.length} separate enemy groups`,
      };
      return;
    }

    // Clear numerical advantage — push
    if (totalEnemies > 0 && totalTroops > totalEnemies * 1.8) {
      cpt._advisorRecommendation = {
        strategy:   'assault',
        confidence: 0.80,
        reason:     `${totalTroops} vs ${totalEnemies} — numerical edge`,
      };
      return;
    }

    // Check for open flank
    if (enemyGroups.length > 0 && cpt._marchDir !== null) {
      const perp = cpt._marchDir + Math.PI / 2;
      let leftCount = 0, rightCount = 0;
      for (const g of enemyGroups) {
        const dx = g.x - cpt.x, dy = g.y - cpt.y;
        const lateral = dx * Math.cos(perp) + dy * Math.sin(perp);
        if (lateral >= 0) rightCount += g.count;
        else              leftCount  += g.count;
      }
      if (leftCount === 0 && rightCount > 0) {
        cpt._advisorRecommendation = {
          strategy:   'envelop',
          confidence: 0.78,
          reason:     'left flank open',
        };
        return;
      }
      if (rightCount === 0 && leftCount > 0) {
        cpt._advisorRecommendation = {
          strategy:   'envelop',
          confidence: 0.78,
          reason:     'right flank open',
        };
        return;
      }
    }

    // No clear recommendation — let the captain decide
    cpt._advisorRecommendation = null;
  }

  draw(ctx, camera) {
    if (this.dead) return;
    const zoom = camera.zoom;
    const sx   = (this.x - camera.x) * zoom;
    const sy   = (this.y - camera.y) * zoom;
    const r    = RADIUS * zoom;
    if (sx < -200 || sy < -200 || sx > ctx.canvas.width + 200 || sy > ctx.canvas.height + 200) return;

    ctx.save();

    // Silver-white double ring — distinct from all other operatives
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(220,220,255,0.85)';
    ctx.lineWidth   = Math.max(1, zoom * 1.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(180,180,220,0.55)';
    ctx.lineWidth   = 0.75;
    ctx.stroke();

    ctx.globalAlpha = this.injured ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle   = this.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(1.5, zoom * 1.5);
    ctx.stroke();

    // Compass-cross pip
    if (this.active) {
      ctx.globalAlpha = 1;
      const pip = r * 0.38;
      ctx.strokeStyle = 'rgba(220,220,255,0.9)';
      ctx.lineWidth   = Math.max(0.75, zoom * 0.75);
      ctx.beginPath();
      ctx.moveTo(sx - pip, sy); ctx.lineTo(sx + pip, sy);
      ctx.moveTo(sx, sy - pip); ctx.lineTo(sx, sy + pip);
      ctx.stroke();
    }

    // Dashed line toward last contact when a recommendation is active
    const rec = this.commandingOfficer?._advisorRecommendation;
    const lcp = this.commandingOfficer?._lastContactPos;
    if (rec && lcp && zoom >= 0.8) {
      const tx = (lcp.x - camera.x) * zoom;
      const ty = (lcp.y - camera.y) * zoom;
      ctx.globalAlpha = 0.30;
      ctx.strokeStyle = 'rgba(220,220,255,1)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4 * zoom, 6 * zoom]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}

function rand(min, max) { return min + Math.random() * (max - min); }
