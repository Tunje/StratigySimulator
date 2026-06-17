import { GameMap } from './map.js';
import { Camera } from './camera.js';
import { InputManager } from './input.js';
import { createDefaultFactions } from './factions.js';
import { Soldier } from './soldier.js';
import { Officer } from './officer.js';
import { Lieutenant } from './lieutenant.js';
import { Captain, Scout, Medic } from './captain.js';
import { Tank } from './tank.js';
import { APC, MechanizedPlatoon } from './apc.js';
import { ArtilleryCannon, Spotter } from './artillery.js';
import { updateEffects, drawEffects } from './effects.js';
import { SQUAD_SIZE, PLATOON_SIZE, COMPANY_SIZE } from './config.js';

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

const LT_COUNT  = 5;          // lieutenants per captain
const SGT_COUNT = PLATOON_SIZE; // sergeants per lieutenant
const SOL_COUNT = SQUAD_SIZE;   // soldiers per sergeant

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

    // One AT rifleman per platoon — first soldier of the first squad
    if (lt.sergeants.length > 0 && lt.sergeants[0].soldiers.length > 0) {
      lt.sergeants[0].soldiers[0]._isATRifleman = true;
    }

    lts.push(lt);
  }

  return { lts, sgts };
}

// Crimson deploys near the LEFT edge; Azure near the RIGHT edge
// Map is MAP_W * 32 = 8192px wide; CX = 4096

// ── Command squads (bodyguard — flank the captain, move with him) ─────────────
function makeCommandSquad(cpt, cx, cy, factionId, facing, color) {
  const sgt = new Officer(cx, cy, factionId, facing, color);
  for (const soldy of SOL_Y) {
    sgt.attach(new Soldier(cx, cy + soldy, factionId, facing, color));
  }
  cpt.attachCommandSquad(sgt);
  return sgt;
}


// ── Attachments (each captain gets one random attachment) ─────────────────────
// Returns { type, units } where units is the flat list for allUnits + draw loops.
function createAttachment(cpt, x, y, factionId, facing, color) {
  const roll = Math.floor(Math.random() * 3);

  if (roll === 0) {
    // Tank platoon — 3 tanks spread perpendicular to facing, one LT_SPACING apart
    const tanks = [-LT_SPACING, 0, LT_SPACING].map(off =>
      new Tank(x, y + off, factionId, facing, color)
    );
    cpt.setAttachment('tanks', tanks);
    return tanks;
  }

  if (roll === 1) {
    // Mechanized platoon — 4 APCs each with a sergeant + soldiers
    const platoon = new MechanizedPlatoon(x, y, factionId, facing, color);
    // Attach a sergeant squad to each troop APC (skip command APC at index 0)
    for (let i = 1; i < platoon.apcs.length; i++) {
      const apc = platoon.apcs[i];
      const sgt = new Officer(apc.x, apc.y, factionId, facing, color);
      for (let j = 0; j < SOL_COUNT; j++) {
        sgt.attach(new Soldier(apc.x, apc.y + (j - 1) * SOL_SPACING, factionId, facing, color));
      }
      apc._sergeant = sgt;
      sgt._mounted  = true;
      sgt.soldiers.forEach(s => { s._mounted = true; });
    }
    const allApcUnits = platoon.allUnits();
    cpt.setAttachment('mechanized', [platoon, ...allApcUnits]);
    return allApcUnits; // platoon wrapper isn't a drawn/updated unit itself
  }

  // roll === 2: Artillery section — 2 cannons + 1 spotter
  // Cannons deploy perpendicular to the march axis so they stay on the map
  const perp    = facing + Math.PI / 2;
  const cannon1 = new ArtilleryCannon(x + Math.cos(perp) * SGT_SPACING * 2,  y + Math.sin(perp) * SGT_SPACING * 2,  factionId, facing, color);
  const cannon2 = new ArtilleryCannon(x - Math.cos(perp) * SGT_SPACING * 2,  y - Math.sin(perp) * SGT_SPACING * 2,  factionId, facing, color);
  const spotter = new Spotter(x + Math.cos(facing) * SGT_SPACING * 2, y + Math.sin(facing) * SGT_SPACING * 2, factionId, facing, color);
  spotter._captain = cpt;
  cpt.attachScout(spotter);
  cpt.setAttachment('artillery', [cannon1, cannon2, spotter]);
  return [cannon1, cannon2, spotter]; // all three need to be in the game loop
}

// ── Company factory — wraps all per-company unit creation ────────────────────
function makeCompany(cy, factionId, facing, color) {
  const sign = factionId === 'crimson' ? -1 : 1;
  const cptX = CX + sign * 3800;
  const sctX = CX + sign * 3700;
  const ltX  = CX + sign * 3500;
  const sgtX = CX + sign * 3300;
  const solX = CX + sign * 3100;

  const { lts, sgts } = makeSide(ltX, sgtX, solX, cy, factionId, facing, color);

  const compScouts = [
    new Scout(sctX, cy - 80, factionId, facing, color),
    new Scout(sctX, cy + 80, factionId, facing, color),
    new Scout(sctX, cy,      factionId, facing, color),
  ];

  const cpt = new Captain(cptX, cy, factionId, facing, color);
  lts.forEach(lt => cpt.attach(lt));
  compScouts.forEach(s => cpt.attachScout(s));
  cpt.setObjective(CX, cy, 'center');

  const cmdSgts = [
    makeCommandSquad(cpt, cptX, cy - 60, factionId, facing, color),
    makeCommandSquad(cpt, cptX, cy + 60, factionId, facing, color),
  ];

  const attachUnits    = createAttachment(cpt, cptX, cy, factionId, facing, color);
  const compAttachSgts = attachUnits.filter(u => u instanceof Officer);
  const compPureAttach = attachUnits.filter(u => !(u instanceof Officer) && !(u instanceof Soldier));

  const medic = new Medic(cptX, cy + 30, factionId, facing, color);
  medic._captain = cpt;

  const allCompSgts  = [...sgts, ...cmdSgts, ...compAttachSgts];
  const compSoldiers = allCompSgts.flatMap(o => o.soldiers);

  return { cpt, lts, sgts: allCompSgts, scouts: compScouts,
           soldiers: compSoldiers, pureAttach: compPureAttach, medic };
}

// ── Mega battle — 3 strips × 2 factions, each company fights toward its strip center ─
const STRIP_SEP        = 1400;
const stripOffsets     = [-STRIP_SEP, 0, STRIP_SEP];
const crimsonCompanies = stripOffsets.map(dy => makeCompany(CY + dy, 'crimson', 0,       cColor));
const azureCompanies   = stripOffsets.map(dy => makeCompany(CY + dy, 'azure',   Math.PI, aColor));
const allCompanies     = [...crimsonCompanies, ...azureCompanies];

// ── Flat lists for game loop ──────────────────────────────────────────────────
const captains        = allCompanies.map(c => c.cpt);
const lieutenants     = allCompanies.flatMap(c => c.lts);
let officers          = allCompanies.flatMap(c => c.sgts);
const scouts          = allCompanies.flatMap(c => c.scouts);
const allSoldiers     = allCompanies.flatMap(c => c.soldiers);
const pureAttachUnits = allCompanies.flatMap(c => c.pureAttach);
const medics          = allCompanies.map(c => c.medic);
const allUnits        = [...allSoldiers, ...scouts, ...officers, ...lieutenants, ...captains, ...medics, ...pureAttachUnits];

// Center companies — used for the two report panels
const crimsonCpt = crimsonCompanies[1].cpt;
const azureCpt   = azureCompanies[1].cpt;

function integratePromotions() {
  for (const lt of lieutenants) {
    if (lt._promotedSergeants.length === 0) continue;
    const newSgts = lt._promotedSergeants.splice(0);
    for (const sgt of newSgts) {
      officers.push(sgt);
      allUnits.push(sgt);
    }
  }
  for (const cpt of captains) {
    if (cpt._promotedScouts.length === 0) continue;
    const newScouts = cpt._promotedScouts.splice(0);
    for (const s of newScouts) {
      scouts.push(s);
      allUnits.push(s);
    }
  }
}

// Start camera centered
resize();
camera.centerOn(CX, CY, canvas.width, canvas.height);

// ── Selection (captains are fully autonomous — clicks only pan/zoom) ──────────
let selectedOfficer   = null;
let pendingDestMarker = null;

function handleClick(sx, sy) {
  const wx = camera.x + sx / camera.zoom;
  const wy = camera.y + sy / camera.zoom;
  const HIT = 24 / camera.zoom; // hit radius in world px

  const hit = captains.find(c => {
    const dx = c.x - wx, dy = c.y - wy;
    return dx * dx + dy * dy < HIT * HIT;
  });

  selectedOfficer = hit || null;
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

  // Selected captain highlight + contact points
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

    // Draw contact points if this is a captain
    if (selectedOfficer._sightings) {
      const now = Date.now() / 1000;
      for (const s of selectedOfficer._sightings) {
        const age  = now - s.time;
        const alpha = Math.max(0, 1 - age / 30);
        const px   = (s.x - camera.x) * camera.zoom;
        const py   = (s.y - camera.y) * camera.zoom;

        // Line from captain to contact point
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(px, py);
        ctx.strokeStyle = `rgba(255, 80, 80, ${alpha * 0.3})`;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Contact dot — larger and brighter than the captain's own draw
        ctx.beginPath();
        ctx.arc(px, py, Math.max(4, 6 * camera.zoom), 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(255, 60, 60, ${alpha * 0.9})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 200, 200, ${alpha})`;
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Age label
        ctx.fillStyle = `rgba(255,220,220,${alpha})`;
        ctx.font      = `${Math.max(9, 10 * camera.zoom)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(age)}s`, px, py - 8 * camera.zoom);
      }
    }

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

  // Top-down update: captains → lieutenants → sergeants → soldiers → scouts → attachments
  for (const c  of captains)         c.update(dt, allUnits, factions);
  for (const lt of lieutenants)      lt.update(dt, allUnits, factions);
  for (const o  of officers)         o.update(dt, allUnits, factions);
  for (const s  of allSoldiers)      s.update(dt, allUnits, factions);
  for (const s  of scouts)           s.update(dt, allUnits, factions);
  for (const m  of medics)           m.update(dt, allUnits, factions);
  for (const u  of pureAttachUnits)  u.update(dt, allUnits, factions);

  updateEffects(dt);

  // Clear
  ctx.fillStyle = '#050810';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Map
  map.render(ctx, camera);

  // Hide vision cones when too many units are active to keep rendering fast
  const activeCount = allUnits.filter(u => u.active).length;
  const showCones   = activeCount < 200;

  // Front to back: soldiers → scouts → attachment vehicles → sergeants → lieutenants → captains
  for (const s  of allSoldiers)      s.draw(ctx, camera, showCones);
  for (const s  of scouts)           s.draw(ctx, camera, showCones);
  for (const m  of medics)           m.draw(ctx, camera, showCones);
  for (const u  of pureAttachUnits)  u.draw(ctx, camera, showCones);
  for (const o  of officers)         o.draw(ctx, camera, showCones);
  for (const lt of lieutenants)      lt.draw(ctx, camera, showCones);
  for (const c  of captains)         c.draw(ctx, camera, showCones);

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
