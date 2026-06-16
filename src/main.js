import { GameMap } from './map.js';
import { Camera } from './camera.js';
import { InputManager } from './input.js';
import { createDefaultFactions } from './factions.js';
import { Soldier } from './soldier.js';
import { Officer } from './officer.js';
import { Lieutenant } from './lieutenant.js';
import { Captain, Scout, Medic } from './captain.js';
import { updateEffects, drawEffects } from './effects.js';

// ── Elements ──────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('game-canvas');
const ctx        = canvas.getContext('2d');
const miniCanvas = document.getElementById('minimap');
const miniCtx    = miniCanvas.getContext('2d');
const coordsEl   = document.getElementById('coords-display');
const zoomEl     = document.getElementById('zoom-display');
const tileInfoEl = document.getElementById('tile-info');

// ── World setup ───────────────────────────────────────────────────────────────
const MAP_W = 256;
const MAP_H = 256;

const map      = new GameMap(MAP_W, MAP_H);
const factions = createDefaultFactions();
const camera   = new Camera(MAP_W, MAP_H);

// ── Units ─────────────────────────────────────────────────────────────────────
const CX = (MAP_W * 32) / 2;
const CY = (MAP_H * 32) / 2;

const cColor = factions.get('crimson').color;
const aColor = factions.get('azure').color;

// Change any of these to 3-10
const LT_COUNT   = 5;   // lieutenants per captain
const SGT_COUNT  = 3;   // squads (sergeants) per lieutenant
const SOL_COUNT  = 3;   // troops per squad

const LT_SPACING  = 220;
const SGT_SPACING = 70;
const SOL_SPACING = 28;

const LT_Y  = Array.from({ length: LT_COUNT  }, (_, i) => (i - (LT_COUNT  - 1) / 2) * LT_SPACING);
const SGT_Y = Array.from({ length: SGT_COUNT  }, (_, i) => (i - (SGT_COUNT - 1) / 2) * SGT_SPACING);
const SOL_Y = Array.from({ length: SOL_COUNT  }, (_, i) => (i - (SOL_COUNT - 1) / 2) * SOL_SPACING);

// ltX, sgtX, solX are absolute world X positions for each rank
function makeSide(ltX, sgtX, solX, cy, factionId, facing, color) {
  const lts  = [];
  const sgts = [];

  for (const ldy of LT_Y) {
    const lt = new Lieutenant(ltX, cy + ldy, factionId, facing, color);

    for (const sdy of SGT_Y) {
      const sy  = cy + ldy + sdy;
      const sgt = new Officer(sgtX, sy, factionId, facing, color);
      for (const soldy of SOL_Y) {
        sgt.attach(new Soldier(solX, sy + soldy, factionId, facing, color));
      }
      lt.attach(sgt);
      sgts.push(sgt);
    }

    lts.push(lt);
  }

  return { lts, sgts };
}

// Crimson deploys near the LEFT edge; Azure near the RIGHT edge
// Map is MAP_W = 8192px; CX = 4096
const { lts: crimsonLts, sgts: crimsonSgts } = makeSide(CX - 3500, CX - 3300, CX - 3100, CY, 'crimson', 0,       cColor);
const { lts: azureLts,   sgts: azureSgts   } = makeSide(CX + 3500, CX + 3300, CX + 3100, CY, 'azure',   Math.PI, aColor);

const crimsonScouts = [
  new Scout(CX - 3700, CY - 80, 'crimson', 0,       cColor),
  new Scout(CX - 3700, CY + 80, 'crimson', 0,       cColor),
  new Scout(CX - 3700, CY,      'crimson', 0,       cColor),
];
const crimsonCpt = new Captain(CX - 3800, CY, 'crimson', 0, cColor);
crimsonLts.forEach(lt => crimsonCpt.attach(lt));
crimsonScouts.forEach(s => crimsonCpt.attachScout(s));
crimsonCpt.setObjective(CX, CY, 'center');

const azureScouts = [
  new Scout(CX + 3700, CY - 80, 'azure', Math.PI, aColor),
  new Scout(CX + 3700, CY + 80, 'azure', Math.PI, aColor),
  new Scout(CX + 3700, CY,      'azure', Math.PI, aColor),
];
const azureCpt = new Captain(CX + 3800, CY, 'azure', Math.PI, aColor);
azureLts.forEach(lt => azureCpt.attach(lt));
azureScouts.forEach(s => azureCpt.attachScout(s));
azureCpt.setObjective(CX, CY, 'center');

// ── Command squads (bodyguard — flank the captain, move with him) ─────────────
function makeCommandSquad(cpt, cx, cy, factionId, facing, color) {
  const sgt = new Officer(cx, cy, factionId, facing, color);
  for (const soldy of SOL_Y) {
    sgt.attach(new Soldier(cx, cy + soldy, factionId, facing, color));
  }
  cpt.attachCommandSquad(sgt);
  return sgt;
}

const crimsonCmdSgts = [
  makeCommandSquad(crimsonCpt, CX - 3800, CY - 60, 'crimson', 0,       cColor),
  makeCommandSquad(crimsonCpt, CX - 3800, CY + 60, 'crimson', 0,       cColor),
];
const azureCmdSgts = [
  makeCommandSquad(azureCpt, CX + 3800, CY - 60, 'azure', Math.PI, aColor),
  makeCommandSquad(azureCpt, CX + 3800, CY + 60, 'azure', Math.PI, aColor),
];

// ── Medics (one per captain, follows and revives injured friendlies) ──────────
const crimsonMedic = new Medic(CX - 3800, CY + 30, 'crimson', 0,       cColor);
const azureMedic   = new Medic(CX + 3800, CY + 30, 'azure',   Math.PI, aColor);
crimsonMedic._captain = crimsonCpt;
azureMedic._captain   = azureCpt;
const medics = [crimsonMedic, azureMedic];

// ── Flat lists for game loop ──────────────────────────────────────────────────
const captains    = [crimsonCpt, azureCpt];
const scouts      = [...crimsonScouts, ...azureScouts];
let officers      = [...crimsonSgts, ...azureSgts, ...crimsonCmdSgts, ...azureCmdSgts];
const lieutenants = [...crimsonLts, ...azureLts];
const allSoldiers = officers.flatMap(o => o.soldiers);
const allUnits    = [...allSoldiers, ...scouts, ...officers, ...lieutenants, ...captains, ...medics];

function integratePromotions() {
  for (const lt of lieutenants) {
    if (lt._promotedSergeants.length === 0) continue;
    const newSgts = lt._promotedSergeants.splice(0);
    for (const sgt of newSgts) {
      officers.push(sgt);
      allUnits.push(sgt);
      // soldiers already exist in allSoldiers/allUnits from original squad
    }
  }
}

// Start camera centered
resize();
camera.centerOn(CX, CY, canvas.width, canvas.height);

// ── Selection (captains are fully autonomous — clicks only pan/zoom) ──────────
let selectedOfficer   = null;
let pendingDestMarker = null;

function handleClick(_sx, _sy) {
  // Captains operate autonomously; no click orders
}

function drawSelectionOverlay() {
  // Destination marker
  if (pendingDestMarker) {
    const sx = (pendingDestMarker.x - camera.x) * camera.zoom;
    const sy = (pendingDestMarker.y - camera.y) * camera.zoom;
    const r  = 8 * camera.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.7)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Cross
    ctx.beginPath();
    ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy);
    ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r);
    ctx.stroke();
    ctx.restore();
  }

  // Selected officer highlight
  if (selectedOfficer) {
    const sx    = (selectedOfficer.x - camera.x) * camera.zoom;
    const sy    = (selectedOfficer.y - camera.y) * camera.zoom;
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 180);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 220, 80, ${pulse})`;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 16 * camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
const input = new InputManager(canvas, camera, onMouseMove, handleClick);

let hoveredTile = null;

function onMouseMove(sx, sy) {
  const { tx, ty } = camera.screenToTile(sx, sy);
  hoveredTile = { tx, ty };
  tileInfoEl.textContent = map.get(tx, ty) !== null ? `[${tx}, ${ty}]` : 'Out of bounds';
}

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => { resize(); camera._clamp(canvas.width, canvas.height); });

// ── Minimap ───────────────────────────────────────────────────────────────────
function drawMinimap() {
  map.renderMinimap(miniCanvas);
  const vp = camera.viewportRect();
  const mw = miniCanvas.width;
  const mh = miniCanvas.height;
  miniCtx.strokeStyle = 'rgba(255, 220, 80, 0.9)';
  miniCtx.lineWidth   = 1.5;
  miniCtx.strokeRect(vp.x * mw, vp.y * mh, Math.min(vp.w * mw, mw), Math.min(vp.h * mh, mh));
}

// ── Tile highlight ────────────────────────────────────────────────────────────
function drawHover() {
  if (!hoveredTile) return;
  const { tx, ty } = hoveredTile;
  if (map.get(tx, ty) === null) return;
  const TILE_SIZE = 32;
  const zoom = camera.zoom;
  const sx = (tx * TILE_SIZE - camera.x) * zoom;
  const sy = (ty * TILE_SIZE - camera.y) * zoom;
  const sz = TILE_SIZE * zoom;
  ctx.strokeStyle = 'rgba(255, 220, 80, 0.85)';
  ctx.lineWidth   = Math.max(1, zoom);
  ctx.strokeRect(sx + 0.5, sy + 0.5, sz - 1, sz - 1);
}

// ── Faction panel ─────────────────────────────────────────────────────────────
const factionListEl    = document.getElementById('faction-list');
let _factionPanelDirty = true;

export function markFactionsDirty() { _factionPanelDirty = true; }

function updateFactionPanel() {
  if (!_factionPanelDirty) return;
  _factionPanelDirty = false;
  factionListEl.innerHTML = '';
  const all = factions.all();
  all.forEach((faction, i) => {
    const allies  = factions.alliesOf(faction.id);
    const enemies = factions.enemiesOf(faction.id);
    const row     = document.createElement('div');
    row.className = 'faction-row';
    const swatch  = document.createElement('div');
    swatch.className    = 'faction-swatch';
    swatch.style.background = faction.color;
    const name    = document.createElement('span');
    name.className   = 'faction-name';
    name.textContent = faction.name;
    const relations  = document.createElement('div');
    relations.className = 'faction-relations';
    allies.forEach(a => {
      const tag = document.createElement('span');
      tag.className   = 'relation-tag ally';
      tag.textContent = a.name;
      relations.appendChild(tag);
    });
    enemies.forEach(e => {
      const tag = document.createElement('span');
      tag.className   = 'relation-tag enemy';
      tag.textContent = e.name;
      relations.appendChild(tag);
    });
    row.appendChild(swatch);
    row.appendChild(name);
    row.appendChild(relations);
    factionListEl.appendChild(row);
    if (i < all.length - 1) {
      const div = document.createElement('div');
      div.className = 'faction-divider';
      factionListEl.appendChild(div);
    }
  });
}

// ── Report panels ─────────────────────────────────────────────────────────────
const reportEls = {
  crimson: document.getElementById('report-crimson'),
  azure:   document.getElementById('report-azure'),
};

function updateReportPanel(factionId, cpt) {
  const faction = factions.get(factionId);
  const el      = reportEls[factionId];

  const tactic  = cpt._tactic ? cpt._tactic.toUpperCase() : '—';
  const contact = cpt._hasContact ? 'YES' : 'NO';
  const known   = cpt._knownActiveEnemies || 0;

  let statusVal   = cpt._phase.toUpperCase();
  let statusClass = 'report-value';
  if (cpt.state === 'injured') {
    statusVal = 'WOUNDED'; statusClass = 'kb-status-bad';
  } else if (cpt._lockedTarget) {
    statusVal = 'ENGAGING'; statusClass = 'kb-status-hot';
  } else if (cpt._pendingDestination) {
    statusVal = 'SECURING'; statusClass = 'kb-status-warn';
  } else if (cpt._moveTarget) {
    const dx = cpt._moveTarget.x - cpt.x, dy = cpt._moveTarget.y - cpt.y;
    statusVal = `ADVANCING ${Math.round(Math.sqrt(dx*dx+dy*dy))}m`;
  } else if (cpt._tactic === 'fallback') {
    statusVal = 'WITHDRAWING'; statusClass = 'kb-status-bad';
  } else if (cpt._tactic === 'attack') {
    statusVal = 'ATTACKING'; statusClass = 'kb-status-hot';
  }

  const underFire = cpt._underFireTimer > 0
    ? `<div class="kb-underfire">UNDER FIRE</div>` : '';

  const sightCount  = cpt._sightings.length;
  const scoutStatus = cpt.scouts.map((s, i) =>
    `<span class="${s._isFleeing ? 'kb-status-bad' : s.active ? 'kb-dot-cold' : 'kb-squad-kia'}">SC.${i+1}${s._isFleeing ? '!' : s.active ? '' : ' KIA'}</span>`
  ).join(' ');

  const ltRows = cpt.lieutenants.map((lt, i) => {
    const label = `PLT.${i + 1}`;
    if (lt.state === 'dead') {
      return `<div class="kb-squad-row"><span class="kb-squad-id">${label}</span><span class="kb-squad-kia">KIA</span></div>`;
    }
    const r      = lt.lastReport;
    const troops = r ? `${r.troops}/${r.totalSquads * 3}` : '?';
    const tac    = r && r.tactic ? r.tactic.toUpperCase().slice(0, 4) : lt._phase ? lt._phase.toUpperCase().slice(0,4) : '—';
    const dot    = r && r.hasContact ? '●' : '○';
    const dotCls = r && r.hasContact ? 'kb-dot-hot' : 'kb-dot-cold';
    return `<div class="kb-squad-row">
      <span class="kb-squad-id">${label}</span>
      <span class="kb-squad-troops">${troops}</span>
      <span class="kb-squad-tac">${tac}</span>
      <span class="${dotCls}">${dot}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="report-box-header" style="color:${faction.color}">
      ${faction.name.toUpperCase()} CPT
      <span class="kb-lt-state">${cpt.state === 'injured' ? '⚠ WND' : ''}</span>
    </div>
    ${underFire}
    <div class="kb-main">
      <span class="report-label">STATUS</span><span class="${statusClass}">${statusVal}</span>
      <span class="report-label">TACTIC</span><span class="report-value">${tactic}</span>
      <span class="report-label">CONTACT</span><span class="report-value">${contact}</span>
      <span class="report-label">KNOWN ENM</span><span class="report-value">${known}</span>
      <span class="report-label">SIGHTINGS</span><span class="report-value">${sightCount}</span>
    </div>
    <div class="kb-divider"></div>
    <div class="kb-squads">${ltRows}</div>
    <div class="kb-divider"></div>
    <div class="kb-main"><span class="report-label">SCOUTS</span><span class="report-value">${scoutStatus}</span></div>
  `;
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHUD() {
  const { tx, ty } = camera.screenToTile(canvas.width / 2, canvas.height / 2);
  coordsEl.textContent = `${tx}, ${ty}`;
  zoomEl.textContent   = `${Math.round(camera.zoom * 100)}%`;
}

// ── Game loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;

function frame(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  camera.update(dt, input.keys, canvas.width, canvas.height);

  integratePromotions();

  // Top-down update: captains → lieutenants → sergeants → soldiers → scouts
  for (const c  of captains)    c.update(dt, allUnits, factions);
  for (const lt of lieutenants) lt.update(dt, allUnits, factions);
  for (const o  of officers)    o.update(dt, allUnits, factions);
  for (const s  of allSoldiers) s.update(dt, allUnits, factions);
  for (const s  of scouts)      s.update(dt, allUnits, factions);
  for (const m  of medics)      m.update(dt, allUnits, factions);

  updateEffects(dt);

  // Clear
  ctx.fillStyle = '#050810';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Map
  map.render(ctx, camera);

  // Hide vision cones when too many units are active to keep rendering fast
  const activeCount = allUnits.filter(u => u.active).length;
  const showCones   = activeCount < 200;

  // Front to back: soldiers → scouts → sergeants → lieutenants → captains
  for (const s  of allSoldiers)  s.draw(ctx, camera, showCones);
  for (const s  of scouts)       s.draw(ctx, camera, showCones);
  for (const m  of medics)       m.draw(ctx, camera, showCones);
  for (const o  of officers)     o.draw(ctx, camera, showCones);
  for (const lt of lieutenants)  lt.draw(ctx, camera, showCones);
  for (const c  of captains)     c.draw(ctx, camera, showCones);

  drawEffects(ctx, camera);
  drawSelectionOverlay();
  drawHover();
  updateHUD();
  updateFactionPanel();
  updateReportPanel('crimson', crimsonCpt);
  updateReportPanel('azure',   azureCpt);
  drawMinimap();

  requestAnimationFrame(frame);
}

requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(frame); });
