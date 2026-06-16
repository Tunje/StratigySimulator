# Strategy Simulator — Design Document

## Overview

A browser-based real-time military strategy simulator. Two autonomous armies (Crimson and Azure) are given a shared objective and advance toward each other across a large procedural map. There is no player control — everything is driven by a layered command AI that mirrors a real infantry company structure. The simulation is a testbed for emergent tactical behaviour: both sides plan, scout, engage, and react independently using only the information their own chain of command has gathered.

---

## Technology Stack

- **Rendering:** HTML5 Canvas 2D (`<canvas id="game-canvas">`)
- **Language:** Vanilla JavaScript, ES Modules (no bundler, no framework)
- **Dev server:** `npx serve -l 5000`
- **Map:** 256×256 tiles, 32 px/tile → 8192×8192 world pixels
- **Camera:** Pan (WASD / drag) and zoom (scroll wheel)
- **UI:** Minimap, faction panel, live captain report boxes, coordinate/zoom display

---

## Unit Hierarchy

Every unit sits at exactly one level of the chain of command. Orders flow strictly downward; intelligence flows strictly upward via reports.

```
Captain (1 per side)
  ├── Scout ×3             (attached directly to captain)
  ├── Medic ×1             (attached directly to captain)
  ├── Command Squads ×2    (bodyguard sergeants, flank the captain)
  └── Lieutenant ×N
        └── Sergeant (Officer) ×M
              └── Soldier ×K
```

Default configuration (editable in `main.js`):

| Parameter | Value |
|-----------|-------|
| Lieutenants per captain | 5 |
| Sergeants per lieutenant | 3 |
| Soldiers per sergeant | 3 |
| Total fighting strength per side | ~47 units (5×3×3 + 2 command squads) |

---

## Files

| File | Responsibility |
|------|----------------|
| `src/main.js` | World setup, game loop, unit instantiation, draw calls |
| `src/captain.js` | Captain, Scout, Medic classes |
| `src/lieutenant.js` | Lieutenant class |
| `src/officer.js` | Sergeant (Officer) class |
| `src/soldier.js` | Soldier class |
| `src/map.js` | Procedural tile map |
| `src/camera.js` | Pan/zoom camera |
| `src/input.js` | Keyboard and mouse input |
| `src/factions.js` | Faction definitions (Crimson / Azure) |
| `src/effects.js` | Bullets, impacts, death particles |

---

## The No-Omniscience Rule

**This is the most important design constraint in the simulation.**

No unit may ever read raw `allUnits` data to find enemies. Every unit may only act on:

1. What it can personally see — checked via `_canSee(other)`, which tests distance and facing/heading angle.
2. What has been reported to it through the chain of command — the captain's `_sightings` array (timestamped enemy position reports from scouts and lieutenants).

Violating this rule breaks the simulation: it produces omniscient AI that never makes realistic mistakes, never acts on stale intelligence, and never has the fog-of-war behaviour that makes the simulation interesting.

The Medic is the most tempting place to break this rule (finding the nearest injured friendly) — it is explicitly fixed to use captain sightings for safety checks, not `allUnits` scanning.

---

## Intelligence / Report Chain

### Soldier → Sergeant
Soldiers report nothing explicitly. The sergeant can see what his soldiers see via `_canSee()` and aggregates from their proximity.

### Sergeant → Lieutenant
Each sergeant fires a report to its lieutenant when contact state changes (immediately) and on a regular timer. The report contains:
- `troops` — active soldiers in the squad
- `opposition` — visible active enemies
- `hasContact` — bool
- `enemyPosition` — last known enemy centroid

### Lieutenant → Captain
Lieutenant fires a report to the captain when:
- Contact state changes (immediate notification via `receiveContactReport`)
- A scout files a sighting (immediate via `receiveSightingReport`)
- On a slow periodic timer (8–14 s)

The lieutenant maintains:
- `_knownActiveEnemies` — sum of sergeant opposition reports + own sight
- `_peakEnemyCount` — highest `_knownActiveEnemies` ever seen (used by captain for kill estimates)
- `lastReport.opposition` — current known enemies (used by captain for battle assessment)

### Captain's Intelligence Picture
- `_sightings[]` — timestamped positions `{x, y, time}` reported by scouts and lieutenants; entries expire after 30 s
- `_hasContact` — true once any sighting received
- `_lastContactPos` — most recent enemy position known
- `_knownActiveEnemies` — own vision + sum of lt reports

---

## Captain Phase Machine

The captain controls the entire company through a finite state machine. All transitions are driven by intelligence received through the report chain, never by direct enemy observation (except the captain's own 300 px personal vision cone).

```
forming → scouting → advancing → moving_up
                                     │
                               (contact report)
                                     ↓
                                  contact
                                     │
                             (assess period)
                                     ↓
                                 flanking
                              ↙           ↘
                        (no contact)   (stragglers)
                             ↓               ↓
                          rallying       mopping_up
                         ↙       ↘           ↓
                   (won)       (lost)     rallying
                     ↓           ↓
               scouting    falling_back
                                 ↓
                          (force intact → scouting)
                          (force depleted → holding)

(all officers dead at any phase) → emergency_retreat → holding
```

### Phase Descriptions

**forming** (2.5 s)
Troops assemble. Captain builds waypoints to objective, sets personality and scout doctrine.

**scouting**
Scouts are deployed to the next sector. Captain waits 5 s after scouts arrive before declaring the sector clear. If scouts report contact, phase jumps to `contact` immediately.

**advancing**
Lieutenants advance to the waypoint in march formation. Captain waits up to 14 s or until front-line lts arrive.

**moving_up**
Captain moves to a position 500 px behind the lieutenant line, then loops back to `scouting` for the next sector.

**contact**
Captain pauses and assesses. Duration is personality-driven (`contactAssessTime`, 1.5–3.5 s). At the end of assessment, he picks a battle strategy and orders the flank.

**flanking**
Lieutenants execute their assigned strategy. Captain pings lts every 3 s to refresh contact counts (prevents stale data trapping the phase). When all lts report no contact, transitions to `mopping_up` or `rallying`.

**mopping_up**
Low-level scattered enemies remain. Captain dispatches available lts to last known sighting positions. Re-enters `contact` if serious opposition re-emerges.

**rallying**
Company consolidates for 8 s (or until lts are assembled). Captain computes battle outcome and chooses next move.

**falling_back**
Ordered retreat to last safe waypoint. If force is ≥60% intact after falling back, captain re-scouts the contested sector. If below 60%, transitions to `holding`.

**holding**
Captain holds current position, keeps scouts circling. Troops are dispatched to mop up stragglers within range.

**emergency_retreat**
Triggered when all officers (lts and sgts) are dead but soldiers survive. Captain routes the survivors around known enemy sighting clusters using path detours, heading for the last safe waypoint. Soldiers are re-ordered every 5 s in case they stop to fight.

---

## Captain Personality

Each captain is randomly assigned a personality at the start of each run, giving variance so both sides don't mirror each other.

| Parameter | Range | Effect |
|-----------|-------|--------|
| `aggressionBias` | –0.2 to +0.2 | Shifts thresholds for strategy choice |
| `contactAssessTime` | 1.5–3.5 s | How long he pauses before ordering a strategy |
| `marchFormation` | one of 5 | Formation chosen for the advance |
| `echelonDir` | +1 or –1 | Which way the echelon formation slants |

---

## March Formations

Assigned at random per captain via `marchFormation` in personality. Lieutenants are assigned to positions by **proximity** (nearest lt to each slot), not by index, so no unit ever crosses another to reach its position.

| Formation | Description |
|-----------|-------------|
| **line** | All lts on a straight perpendicular line at the waypoint |
| **refused_flank** | n−1 lts at front, 1 lt held back behind captain as rear guard |
| **two_back** | n−2 lts at front, 2 lts flanking behind captain |
| **wedge** | Centre lt leads, flanks stagger progressively rearward |
| **echelon** | Diagonal line — one flank forward, opposite flank trailing; direction is personality-driven |

The `_frontLtSet` tracks which lts are the "front" trigger for the advance phase. The advance only progresses once front-line lts reach the waypoint.

---

## Battle Strategies

When the captain enters `contact` he waits his assessment period, then calls `_pickAndExecuteBattleStrategy()`. The choice is based on his intelligence picture and personality bias:

| Strategy | Condition | Behaviour |
|----------|-----------|-----------|
| **defend** | Enemy estimate ≥ 3 sighting clusters, or enemy outnumbers own force significantly | Hold position, lts dig in |
| **assault** | Own force is substantially larger than enemy estimate | Direct frontal attack |
| **envelop** | Default | Lts are split: one group pins the enemy frontally, the other(s) are sent to flank positions 420 px off the perpendicular |

All estimates use `_sightings` and lieutenant reports — not direct observation of enemy units.

---

## Scout System

Three scouts per captain. Scouts are the forward intelligence arm.

### Scout Doctrine
Set by the captain based on his standing orders. Currently hardcoded to:
- `depth: 'deep'` — scouts are sent to the sector *after* the current one, giving earlier warning
- `onContact: 'observe'` — on spotting an enemy, scouts stop and watch rather than fleeing immediately

### Scout Deployment
Scouts form a **screen line** (all at the same forward depth), spread **laterally** across the army's full width plus 400 px margin on each side. This covers the flanks while keeping all scouts at the same depth so no single scout is dangerously exposed. Stagger is added via forward (±150 px) and lateral (±60 px) jitter so scouts see slightly different ground.

### Scout Behaviour
- **Observing:** If enemy is further than 180 px, scout halts and watches. Reports sightings to captain.
- **Fleeing:** If enemy closes within 180 px (or scout doctrine is `flee`), scout runs back behind the friendly line.
- **Scouts ignore other scouts** — they do not engage or react to enemy scouts.

### Scout Circle Patrol
During `rallying`, `falling_back`, `holding`, and `emergency_retreat`, scouts circle a designated point at ~300 px radius. This maintains a picket around the position rather than all scouts collapsing to one spot.

---

## Sergeant Promotion

When a lieutenant is killed, the captain promotes the senior surviving sergeant from that lieutenant's squads. The promoted sergeant is added to the captain's `lieutenants` array and given a reference to the captain as commanding officer. This allows the captain to continue commanding even as his officer corps is depleted.

---

## Emergency Retreat Routing

When all officers are dead but soldiers survive, the captain executes `_triggerEmergencyRetreat()`:

1. Collects all known enemy sighting positions from `_sightings`.
2. Builds a route to the last safe waypoint that gives a wide berth to any threat cluster (using `distToSegment()` to check if a direct path passes too close to known enemy positions).
3. If the direct path is blocked, inserts a detour waypoint that arcs around the threat.
4. Every 5 s, re-issues the retreat order to orphaned soldiers in case they stopped to engage.

---

## Battle Outcome Assessment

Called in `_startRally()` after contact ends. The captain estimates whether he won or lost using his intelligence picture — not omniscient casualty data.

**Estimate of enemy kills:**
For each lieutenant, take `_peakEnemyCount` (highest enemy count that lt ever reported) minus `lastReport.opposition` (enemies that lt can still account for). The difference is a reasonable proxy for enemies neutralized.

```
enemyKillsEst = Σ max(0, lt._peakEnemyCount − lt.lastReport.opposition)
ownLosses     = _battleStartTroops − _countActiveTroops()

battleWon = enemyKillsEst >= ownLosses
          OR (both are zero — no real battle occurred)
```

If won: captain advances to the next waypoint and resumes scouting.
If lost: captain falls back to the last safe sector.

---

## Combat Mechanics

### Vision
Every unit has a vision cone (`_canSee(other)`):
- Detection circle (no facing requirement): `range / 3`
- Directional cone: full range, ±90° from current head direction

Head direction is separate from body facing. Units slowly pan their heads between three offsets (left, centre, right) when not engaged, and lock onto a target when one is spotted.

### Accuracy
Base hit chance: 50%  
Penalties stack:
- Under fire (took a shot recently): −10%
- Moving while shooting: −15%

Kill chance on hit: 40%. Otherwise the target is injured (immobile, can be finished off).

### Fire Rates

| Unit type | Rate |
|-----------|------|
| Soldier | 1.5–2.5 s |
| Sergeant (Officer) | 1.5–2.5 s |
| Lieutenant | 2.0–3.5 s |
| Captain | 2.5–4.0 s |

### Speed
- Soldiers: 55 px/s × individual `_speedMult` (0.88–1.12)
- Scouts: 65 px/s
- Officers/Lieutenants: 45 px/s
- Captain: 35 px/s
- Medic: 45 px/s

Speed variance (±12%) causes formations to drift naturally over distance rather than moving as a perfectly rigid block.

---

## Medic

One medic per captain. The medic:

1. Checks safety using the captain's `_sightings` (never omniscient scanning). Will not operate within 400 px of a known recent enemy position.
2. Finds the nearest injured friendly visible on the battlefield.
3. Moves to the casualty and heals over 3 s, restoring them from `injured` to `active`.
4. Retreats immediately if enemies approach its position.
5. When idle, follows the captain at 80 px distance.

---

## Visual Features

- **Vision cones:** Rendered per unit showing both detection circle and directional sight cone. Cones turn orange when a target is locked.
- **Performance cutoff:** When more than 200 active units are present, vision cones are hidden to maintain frame rate.
- **Under-fire ring:** Pulsing red ring around units currently suppressed.
- **Minimap:** Top-down overview of the entire 8192×8192 map.
- **Captain report boxes:** Live text readout per faction showing phase, tactic, strength, and lieutenant reports.

---

## Ideas Discussed But Not Yet Implemented

### Higher Command Tier (Major / Colonel)

The next logical layer above captain. The Colonel would be AI-driven and issue standing orders (e.g. "aggressive advance", "hold the line", "withdraw"). The Major would act as an advisor, offering mathematically optimal recommendations based on aggregate strength and position data. The Colonel could override or follow that advice based on his own personality profile — making him a true strategic AI layer above the tactical captain layer.

### Multiple Captains per Side

The simulation currently has one captain per side commanding one company (~50 units). Scaling to multiple captains (battalions) is architecturally straightforward — each captain runs independently. Estimated scaling:
- 2–3 captains per side: no performance concern
- 5+ captains per side: vision cone rendering becomes the bottleneck (already addressed by the 200-unit cutoff)
- 10+ captains: game loop `allUnits` iteration becomes the bottleneck; spatial hashing or quadtrees would be needed

### Configurable Scout Doctrine

Currently `depth: 'deep', onContact: 'observe'` is hardcoded based on the captain's standing order. The design intent is for the captain to choose both parameters based on personality and situation:
- `depth: screen` — scouts stay one sector ahead (closer cover)
- `depth: deep` — scouts probe two sectors ahead (earlier warning, higher risk)
- `onContact: flee` — scouts retreat immediately on sight (preserves scouts, loses observation)
- `onContact: observe` — scouts hold and watch (better intelligence, higher scout casualties)

### More Battle Strategies

The three current strategies (assault, envelop, defend) are a starting point. Further strategies discussed:
- **Feint and encircle:** One lt group draws enemy forward while two groups close the pocket from the flanks
- **Delay and withdraw:** Fall back deliberately to lure the enemy into a chosen kill zone
- **Hasty ambush:** Company halts in cover and waits for the enemy advance to walk into them

### Map Features

The current map is flat procedural tiles. Adding terrain that blocks line of sight (forests, ridgelines, buildings) would substantially increase the tactical depth of scout placement and flanking decisions.

---

## Repository

https://github.com/Tunje/StratigySimulator.git
