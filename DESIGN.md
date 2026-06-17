# Strategy Simulator — Design Document

## Overview

A browser-based real-time military strategy simulator. Two autonomous armies (Crimson and Azure) are given a shared objective and advance toward each other across a large procedural map. There is no player control — everything is driven by a layered command AI that mirrors a real infantry company structure with attached armour or fire support. The simulation is a testbed for emergent tactical behaviour: both sides plan, scout, engage, and react independently using only the information their own chain of command has gathered.

---

## Technology Stack

- **Rendering:** HTML5 Canvas 2D (`<canvas id="game-canvas">`)
- **Language:** Vanilla JavaScript, ES Modules (no bundler, no framework)
- **Dev server:** `npx serve -l 5000`
- **Map:** 256×256 tiles, 32 px/tile → 8192×8192 world pixels
- **Camera:** Pan (WASD / drag) and zoom (scroll wheel)
- **UI:** Minimap, faction panel, live captain report boxes (centre companies), coordinate/zoom display

---

## Battle Scale

Three parallel company battles run simultaneously, each on its own north-south strip separated by 1400 px. Each strip has one Crimson company fighting one Azure company. The centre strip's captains are shown in the report panels.

```
Strip −1400:  Crimson Coy A  vs  Azure Coy A
Strip     0:  Crimson Coy B  vs  Azure Coy B  ← report panel companies
Strip +1400:  Crimson Coy C  vs  Azure Coy C
```

---

## Unit Hierarchy

Every unit sits at exactly one level of the chain of command. Orders flow strictly downward; intelligence flows strictly upward via reports.

```
Captain (1 per company)
  ├── Scout ×3              (attached directly to captain)
  ├── Medic ×1              (attached directly to captain)
  ├── Command Squads ×2     (bodyguard sergeants, flank the captain)
  ├── Attachment (one of):
  │     ├── Tank Platoon    (3 × Tank)
  │     ├── Mechanized Plt  (MechanizedPlatoon: 4 × APC, each carrying 1 Sergeant + 3 Soldiers)
  │     └── Artillery Sec   (2 × ArtilleryCannon + 1 × Spotter)
  └── Lieutenant ×5
        └── Sergeant (Officer) ×3
              └── Soldier ×3
                    (one per lt platoon is an AT Rifleman)
```

Default configuration (editable in `main.js`):

| Parameter | Value |
|-----------|-------|
| Lieutenants per captain | 5 |
| Sergeants per lieutenant | 3 |
| Soldiers per sergeant | 3 |
| AT riflemen per lt platoon | 1 (first soldier of first squad) |
| Total infantry per company | ~47 (5×3×3 + 2 command squads) |

---

## Files

| File | Responsibility |
|------|----------------|
| `src/main.js` | World setup, game loop, unit instantiation, draw calls |
| `src/captain.js` | Captain, Scout, Medic classes |
| `src/lieutenant.js` | Lieutenant class |
| `src/officer.js` | Sergeant (Officer) class |
| `src/soldier.js` | Soldier class |
| `src/tank.js` | Tank class |
| `src/apc.js` | APC class, MechanizedPlatoon wrapper |
| `src/artillery.js` | ArtilleryCannon class, Spotter class |
| `src/map.js` | Procedural tile map |
| `src/camera.js` | Pan/zoom camera |
| `src/input.js` | Keyboard and mouse input |
| `src/factions.js` | Faction definitions (Crimson / Azure) |
| `src/effects.js` | Bullets, impacts, explosions, death particles |

---

## The No-Omniscience Rule

**This is the most important design constraint in the simulation.**

No unit may ever read raw `allUnits` data to find enemies. Every unit may only act on:

1. What it can personally see — checked via `_canSee(other)`, which tests distance and facing/heading angle.
2. What has been reported to it through the chain of command — the captain's `_sightings` array (timestamped enemy position reports from scouts and lieutenants).

Violating this rule breaks the simulation: it produces omniscient AI that never makes realistic mistakes, never acts on stale intelligence, and never has the fog-of-war behaviour that makes the simulation interesting.

The Medic is the most tempting place to break this rule — it is explicitly fixed to use captain sightings for safety checks, not `allUnits` scanning.

---

## Intelligence / Report Chain

### Soldier → Sergeant
Soldiers report nothing explicitly. The sergeant observes through his own vision cone and those of his soldiers via `_canSee()`.

### Sergeant → Lieutenant
Each sergeant fires a report to its lieutenant when contact state changes (immediately) and on a regular timer. The report contains:
- `troops` — active soldiers in the squad
- `opposition` — visible active enemies
- `hasContact` — bool
- `enemyPosition` — last known enemy centroid
- `hasATCapability` — true if the squad's AT rifleman is still alive
- `hasArmorContact` — true if the sergeant can see enemy armoured vehicles
- `armorContactPos` — position of the spotted armour

**Armor flash report:** The first time a sergeant spots enemy armour, it fires an immediate out-of-cycle report to the lieutenant (which then immediately flashes to the captain). This bypasses the normal timer to ensure armour contact is acted on quickly.

### Lieutenant → Captain
Lieutenant fires a report to the captain when:
- Contact state changes (immediate via `receiveContactReport`)
- Armor contact first detected (immediate flash)
- A scout files a sighting (immediate via `receiveSightingReport`)
- On a slow periodic timer (8–14 s)

The lieutenant maintains:
- `_knownActiveEnemies` — sum of sergeant opposition reports + own sight
- `_peakEnemyCount` — highest `_knownActiveEnemies` ever seen (used by captain for kill estimates)
- `_armorContact` / `_armorContactPos` — aggregated from sergeants
- `lastReport` — the full report object including `hasArmorContact` and `armorContactPos`

When armor contact is confirmed at lt level, the lt routes its AT-capable sergeant toward the armour contact position immediately.

### Captain's Intelligence Picture
- `_sightings[]` — timestamped positions `{x, y, time}` reported by scouts and lieutenants; expire after 30 s
- `_hasContact` / `_lastContactPos` — general infantry contact
- `_hasArmorContact` / `_armorContactPos` — enemy armour position, takes priority as targeting reference for the attachment
- `_knownActiveEnemies` — own vision + sum of lt reports

---

## Captain Phase Machine

The captain controls the entire company through a finite state machine. All transitions are driven by intelligence received through the report chain, not by direct enemy observation (except the captain's own 300 px personal vision cone).

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
Troops assemble. Captain builds waypoints to objective, assigns personality, scout doctrine, and march formation.

**scouting**
Scouts deployed to next sector. Captain waits 5 s after scouts arrive. Contact report jumps immediately to `contact`.

**advancing**
Lieutenants advance to the waypoint in march formation. Captain waits up to 14 s or until front-line lts arrive.

**moving_up**
Captain moves 500 px behind the lieutenant line, then loops back to `scouting` for the next sector.

**contact**
Captain pauses and assesses. Duration is personality-driven (`contactAssessTime`, 4–7 s). Picks battle strategy and orders the flank.

**flanking**
Lieutenants execute assigned strategy. Captain pings lts every 3 s to refresh contact counts. Transitions to `mopping_up` or `rallying` when all lts report clear.

**mopping_up**
Scattered enemies remain. Dispatches available lts to last known sighting positions. Re-enters `contact` if serious opposition re-emerges.

**rallying**
Company consolidates for 8 s. Captain assesses battle outcome and chooses next move.

**falling_back**
Ordered retreat to last safe waypoint. Force ≥60% intact → re-scouts contested sector. Below 60% → `holding`.

**holding**
Holds current position, keeps scouts circling, dispatches mop-up orders within reach.

**emergency_retreat**
All officers (lts and sgts) dead but soldiers survive. Captain routes survivors around known enemy sighting clusters. Soldiers re-ordered every 5 s in case they stop to fight.

---

## Captain Personality

Each captain is randomly assigned a personality at the start, giving variance so both sides don't mirror each other.

| Parameter | Range | Effect |
|-----------|-------|--------|
| `aggressionBias` | –0.2 to +0.2 | Shifts thresholds for strategy choice |
| `contactAssessTime` | 4.0–7.0 s | How long he pauses before ordering a strategy |
| `marchFormation` | one of 5 | Formation chosen for the advance |
| `echelonDir` | +1 or –1 | Which way the echelon formation slants |

---

## March Formations

Assigned at random per captain. Lieutenants assigned to positions by **proximity** (nearest lt to each slot), not by index — no unit ever crosses another to reach its position.

| Formation | Description |
|-----------|-------------|
| **line** | All lts on a straight perpendicular line at the waypoint |
| **refused_flank** | n−1 lts at front, 1 lt held back behind captain as rear guard |
| **two_back** | n−2 lts at front, 2 lts flanking behind captain |
| **wedge** | Centre lt leads, flanks stagger progressively rearward |
| **echelon** | Diagonal line — one flank forward, opposite flank trailing; direction is personality-driven |

`_frontLtSet` tracks which lts are the "front" trigger — advance phase only progresses once these reach the waypoint.

---

## Battle Strategies

Chosen in `_pickAndExecuteBattleStrategy()` after the assessment period:

| Strategy | Condition | Behaviour |
|----------|-----------|-----------|
| **defend** | Enemy estimate ≥ 3 sighting clusters, or enemy significantly outnumbers own force | Hold position, lts dig in |
| **assault** | Own force substantially larger than enemy estimate | Direct frontal attack |
| **envelop** | Default | One group pins frontally, others sent to flanking positions 420 px off the perpendicular |

All estimates use `_sightings` and lieutenant reports — not direct observation.

---

## Attachment System

Each captain is randomly assigned one of three attachments at startup via `createAttachment()`. The roll is random (equal 1-in-3 chance). The attachment operates alongside the infantry and receives orders from the captain every 6 s via `_updateAttachment()`.

The captain uses `_armorContactPos` (if set) as the priority target reference for attachment orders, falling back to `_lastContactPos`.

---

### Tank Platoon (`Tank`)

Three tanks spread perpendicular to the march axis, one `LT_SPACING` apart.

| Stat | Value |
|------|-------|
| Radius | 30 px |
| Speed | 22 px/s |
| Shoot range | 380 px |
| Vision angle | ±58° from turret |
| Fire rate | 4.5–6.0 s |
| Hit chance vs infantry | 78% (always kills — cannon shell) |
| Armor class | heavy |

**Turret:** Rotates separately from the hull at 1.8 rad/s. Vision and shooting both use the turret angle.

**Behaviour:** Tanks hold position when a target is in range and only advance when clear. Separation force keeps them from stacking on friendly infantry. During `contact`/`flanking`/`mopping_up`, tanks are ordered to spread across the formation front 280 px short of the contact position (close range for maximum effect). During advance, they keep pace behind the lt line.

**Armor penetration (outgoing — tank cannon):**
- vs heavy armor: 65% pen, on pen → immediate kill
- vs light armor: 90% pen, on pen → immediate kill
- vs infantry: 78% hit, on hit → immediate kill (no injury)

---

### Mechanized Platoon (`APC` / `MechanizedPlatoon`)

Four APCs in a column (1 command + 3 troop APCs). Each troop APC carries one sergeant squad (sergeant + 3 soldiers).

| Stat | Value |
|------|-------|
| Radius | 20 px |
| Speed (mounted) | 65 px/s |
| Speed (dismounted, crawling) | 12 px/s |
| MG range | 200 px |
| MG vision angle | ±90° |
| MG fire rate | 1.2 s ×(0.8–1.3) |
| MG hit chance vs infantry | 60% (50/50 kill/injure on hit) |
| Armor class | light |
| Dismount trigger | enemies within 260 px |
| Remount clear time | 5 s with no nearby enemies |

**Mount/dismount:** While mounted, sergeant and soldiers are hidden at the APC position. On dismount, soldiers fan out perpendicular to the APC's facing and immediately push forward. On remount (area clear for 5 s), they snap back inside.

**Captain orders:** During `flanking`/`mopping_up`, the platoon is sent to a position on the formation flank to execute envelopment. At all other times, it keeps pace on the flank rather than racing to the waypoint.

**MG penetration vs armor:**
- vs heavy armor: 2% pen
- vs light armor: 22% pen

---

### Artillery Section (`ArtilleryCannon` / `Spotter`)

Two cannons positioned perpendicular to the march axis, plus one spotter (a specialised Scout variant).

| Stat | Value |
|------|-------|
| Reload time | 8 s per shell |
| Shells per fire mission | 3 |
| Scatter (observed) | 55 px radius |
| Scatter (unobserved) | 180 px radius |
| Blast radius | 130 px |
| Blast kill chance at centre | 85% (65% dead, 35% injured) |
| Blast chance at edge | 0% (linear falloff) |
| Armor class of cannon | heavy |

**Observed vs unobserved fire:**
- If the Spotter has eyes on a target (`_spotTarget` set), both cannons fire with 55 px scatter.
- If the Spotter has no eyes on but the captain has recent sightings (<30 s old), cannons fire unobserved with 180 px scatter.
- The captain must re-designate after each shell — the cannon clears its target after firing.

**Spotter:** Extends the Scout class. While observing (in range of enemy, not fleeing), tracks the nearest enemy armoured vehicle (falls back to nearest infantry if no armour). Draws an orange dashed ring on its spotted target. Reports sightings to the captain as a normal scout would.

**New explosion effect:** Artillery hits render a three-phase effect — a fast expanding fireball (first 40% of 1.4 s lifetime), an outward blast ring, and a lingering grey smoke cloud.

---

## Anti-Tank Rifleman

One soldier per lieutenant platoon is designated as the AT rifleman. It is the first soldier of the first sergeant squad under each lieutenant, set at spawn via `_isATRifleman = true`.

**Visual:** Orange ring around the body and orange head dot instead of black.

**Improved penetration odds:**
- vs heavy armor: 25% (vs regular rifle 5%)
- vs light armor: 50% (vs regular rifle 10%)

**Tactical positioning:** When the sergeant orders an attack, the AT rifleman is placed in the front-centre slot so it closes range on armour first. When the lieutenant detects armour contact, it routes the AT-capable sergeant toward the armour position.

**Report field:** The sergeant report includes `hasATCapability: true` as long as the AT rifleman is alive. The lieutenant uses this to know which sergeant to dispatch toward armour.

---

## Armor Class System

Every unit has an optional `armorClass` property. Infantry have none.

| Unit | `armorClass` |
|------|--------------|
| Tank | `'heavy'` |
| APC | `'light'` |
| ArtilleryCannon | `'heavy'` |
| All infantry | (none / falsy) |

Shooting code in every unit checks `target.armorClass` before applying normal hit logic. If armored, it runs a penetration roll instead. On pen fail, the shot does nothing. On pen success, the vehicle is destroyed immediately (no injury state for vehicles).

---

## Sergeant Promotion

When a lieutenant is killed, the captain promotes the senior surviving sergeant from that lieutenant's squads to act as a replacement lieutenant. The promoted sergeant is added to the captain's `lieutenants` array and given a reference to the captain as commanding officer. This allows the captain to continue commanding even as the officer corps is depleted. Promoted scouts are handled similarly via `_promotedScouts`.

---

## Scout System

Three scouts per captain. Scouts are the forward intelligence arm.

### Scout Doctrine
Set by captain. Currently hardcoded to:
- `depth: 'deep'` — scouts sent to the sector *after* the current one for earlier warning
- `onContact: 'observe'` — on spotting an enemy, scouts stop and watch rather than fleeing

### Scout Deployment
Scouts form a **screen line** (all at the same forward depth), spread laterally beyond the army's full width by 400 px on each side. Stagger: ±150 px forward, ±60 px lateral jitter so scouts see slightly different ground.

### Scout Behaviour
- **Observing:** Enemy is further than 180 px — scout halts and watches, reports sightings to captain.
- **Fleeing:** Enemy closes within 180 px — scout runs back behind the friendly line.
- **Scouts ignore other scouts** — no reaction to enemy scouts.

### Scout Circle Patrol
During `rallying`, `falling_back`, `holding`, and `emergency_retreat`, scouts circle a designated point at ~300 px radius to maintain a picket rather than collapsing to one spot.

---

## Emergency Retreat Routing

When all officers are dead but soldiers survive:

1. Collects all known enemy sighting positions.
2. Builds a route to the last safe waypoint that avoids known threat clusters (using `distToSegment()` — if the direct path passes too close to a sighting cluster, inserts a detour waypoint arcing around it).
3. Every 5 s, re-issues retreat orders to orphaned soldiers in case they stopped to fight.

---

## Battle Outcome Assessment

Called in `_startRally()` after contact ends. The captain estimates win/loss using his intelligence picture — not omniscient casualty data.

```
ownLosses     = _battleStartTroops − _countActiveTroops()

enemyKillsEst = Σ max(0, lt._peakEnemyCount − lt.lastReport.opposition)
                    for each lieutenant

battleWon = (enemyKillsEst >= ownLosses)
          OR (both are zero — no real battle occurred)
```

`_peakEnemyCount` is the highest enemy count that lieutenant ever reported. The difference between peak and current opposition is a proxy for enemies neutralized. If the captain killed more than he lost, he won and advances. Otherwise he falls back.

---

## Combat Mechanics

### Vision
Every unit has a vision cone (`_canSee(other)`):
- Detection circle (no facing requirement): `range / 3`
- Directional cone: full range, ±90° from current head/turret direction

Head direction is separate from body facing. Units slowly pan between three offsets (left, centre, right) when idle, and lock onto a target when spotted.

### Accuracy (infantry)
Base hit chance: 50%  
Penalties stack:
- Under fire (suppressed): −10%
- Moving while shooting: −15%

Kill chance on hit: 40%. Otherwise target is injured (immobile, can be finished off).

### Fire Rates

| Unit type | Rate |
|-----------|------|
| Soldier | 1.5–2.5 s |
| Sergeant (Officer) | 1.5–2.5 s |
| Lieutenant | 2.0–3.5 s |
| Captain | 2.5–4.0 s |
| APC MG | 1.0–1.6 s |
| Tank cannon | 4.5–6.0 s |
| Artillery cannon | 8.0 s |

### Speed

| Unit | px/s |
|------|------|
| Soldier | 55 × speed mult |
| Scout / Spotter | 65 |
| Officer (sergeant) | 45 |
| Lieutenant | 45 |
| Captain | 35 |
| Medic | 45 |
| Tank | 22 |
| APC (mounted) | 65 |
| APC (dismounted) | 12 |
| Artillery cannon | 10 (repositioning only) |

Speed variance (±12%) causes infantry formations to drift naturally over distance.

---

## Medic

One medic per captain. The medic:

1. Checks safety using the captain's `_sightings` — will not operate within 400 px of a known recent enemy position (no omniscient scanning).
2. Finds nearest injured friendly within the safe zone.
3. Moves to the casualty and heals over 3 s, restoring `injured` → `active`.
4. Retreats immediately if enemies approach.
5. When idle, follows the captain at 80 px distance.

---

## Visual Features

- **Vision cones:** Per-unit detection circle + directional sight cone. Orange tint when a target is locked.
- **Performance cutoff:** Vision cones hidden when >200 active units on screen.
- **Turret (tanks):** Separate rotation from hull, drawn on top.
- **APC dismount indicator:** `DSMNT` label floats above APC in yellow when infantry are out.
- **Reload arc:** Yellow arc sweeps around artillery cannon showing reload progress.
- **Artillery target line:** Orange dashed line from cannon to current fire mission target.
- **Spotter ring:** Orange dashed circle drawn on the spotted target.
- **Under-fire ring:** Pulsing red ring around suppressed infantry units.
- **Explosion effect:** Three-phase — fireball → blast ring → smoke cloud.
- **Minimap:** Top-down overview of the full 8192×8192 world.
- **Captain report boxes:** Live text per faction (centre company) showing phase, tactic, strength, and lieutenant reports.

---

## Ideas Discussed But Not Yet Implemented

### Higher Command Tier (Major / Colonel)

The next logical layer above captain. The Colonel would be AI-driven, issuing standing orders (e.g. "aggressive advance", "hold the line", "withdraw"). The Major would act as an advisor offering mathematically optimal recommendations based on aggregate strength and position data. The Colonel could override or follow that advice based on his own personality — making him a true strategic AI layer above the tactical captain layer.

### Multiple Captains per Side at Scale

Currently 3 companies per side. Estimated scaling ceiling:
- 5–6 captains per side: no performance concern
- 10+ captains: `allUnits` iteration in the game loop becomes the bottleneck; spatial hashing or quadtrees would be needed at that point
- Vision cones already cut off at 200 active units

### Configurable Scout Doctrine per Captain

Currently `depth: 'deep', onContact: 'observe'` is hardcoded. Design intent: captain chooses based on personality and situation:
- `depth: screen` — scouts stay one sector ahead (closer cover, lower scout casualties)
- `depth: deep` — scouts probe two sectors ahead (earlier warning, higher risk)
- `onContact: flee` — scouts retreat immediately on sight (preserves scouts, loses observation)
- `onContact: observe` — scouts hold and watch (better intelligence, higher scout casualties)

### More Battle Strategies

Three current strategies (assault, envelop, defend) are a starting point:
- **Feint and encircle:** One lt group draws enemy forward while two groups close the pocket from the flanks
- **Delay and withdraw:** Fall back deliberately to lure the enemy into a chosen kill zone
- **Hasty ambush:** Company halts and waits for the enemy advance to walk into them

### Terrain

The current map is flat procedural tiles. Adding terrain that blocks line of sight (forests, ridgelines, buildings) would substantially increase the tactical depth of scout placement and flanking decisions — and make the AT rifleman and spotter far more interesting to watch.

---

## Repository

https://github.com/Tunje/StratigySimulator.git
