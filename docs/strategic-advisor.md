# Strategic Advisor — Design Document

## Role
A staff officer attached one-per-captain. He does not fight and does not scout.
His job is to analyse the battlefield picture and write a recommendation back to
his captain before the captain commits to a strategy. He can read data from all
captains on the field but only influences his own.

---

## Position on the field
Follows his captain at a close perpendicular offset (same pattern as the radio
operator). He never advances ahead of the captain. If the captain enters
emergency retreat the advisor retreats with him.

---

## Data the advisor can read

### From his own captain
- `_sightings` — timestamped enemy position reports (with counts after the
  recent fix)
- `_battleStrategy` — what strategy the captain is currently executing
- `_phase` — what phase the captain is in
- `_knownActiveEnemies` — captain's current enemy estimate
- `_lastContactPos` — last known enemy position
- `_marchDir` — direction of advance
- `_countActiveTroops()` — own strength

### From all other captains (read-only, no writing)
- `_sightings` — to see where enemy forces are across the whole front
- `_battleStrategy` — to know what strategies are already in use
- `_phase` — to know which companies are engaged, retreating, or advancing
- `_knownActiveEnemies` — to build a whole-battlefield enemy strength picture

---

## What the advisor produces

He writes a single struct to his captain each deliberation cycle:

```
_advisorRecommendation = {
  strategy:   'assault' | 'envelop' | 'defend' | 'hold' | null,
  confidence: 0.0 – 1.0,
  reason:     string   // for the report panel
}
```

The captain checks this in `_pickAndExecuteBattleStrategy` and
`_evaluateAndAdaptStrategy`. If `confidence >= 0.75` the advisor's strategy
takes precedence. Below that threshold the captain uses his own logic as normal.

---

## Deliberation cycle

Runs every **15 seconds** (slow — this is planning, not reaction).

Each cycle he runs three analyses in order:

### 1. Enemy concentration map
Collect all sightings from all captains that are younger than 20 seconds.
Cluster them at 500px radius. Each cluster gives an estimated enemy group with
a position and a strength (sum of sighting counts in the cluster).

Output: list of `{ x, y, strength }` enemy groups.

### 2. Friendly situation map
For each captain: record position, active troop count, current strategy, phase.
Note which directions are already being pressed (envelop left, envelop right,
frontal assault etc.) so duplicate strategies can be avoided.

### 3. Recommendation logic (in order of priority)

| Condition | Recommendation |
|---|---|
| Own captain in emergency retreat or falling back | `null` — do not interfere |
| Enemy strength in contact > own troops × 1.5 | `defend`, high confidence |
| Another captain is already executing the same strategy we would pick | shift to the next best option |
| Enemy groups ≥ 3 distinct clusters | `defend` — too spread to assault |
| Own troops > total visible enemy × 1.8 | `assault` |
| Enemy flank exposed (no sightings within 400px perpendicular to march axis) | `envelop` toward the open flank |
| Neighbouring captain broke through (phase = mopping_up or consolidating) and enemy flank is adjacent | `envelop` to exploit the gap |
| Default | `null` — let the captain decide |

---

## What he does NOT do
- He does not issue orders to lieutenants or sergeants directly.
- He does not move units.
- He does not override emergency retreat or falling_back — survival trumps strategy.
- He does not replace the captain's own logic; he feeds into it.

---

## Class structure

Extends `Operative` (same base as Corporal, StaffSergeant, RadioOperator).

```
class StrategicAdvisor extends Operative {
  constructor(x, y, factionId, facing, color)

  // Called at construction by captain.attachAdvisor(advisor, allCaptains)
  attachCaptains(allCaptains)

  // Runs every deliberation cycle
  _deliberate()

  // Sub-analyses
  _buildEnemyGroups()       → [{ x, y, strength }]
  _buildFriendlySituation() → [{ captain, strategy, phase, troops, x, y }]
  _pickRecommendation(enemyGroups, friendlySituation) → recommendation

  // Operative overrides
  _report()           // no sighting report — writes _advisorRecommendation instead
  _onContactChange()  // no-op
  draw()              // small distinct visual, staff map symbol
}
```

---

## Captain changes needed

- `attachAdvisor(advisor, allCaptains)` method
- `_advisorRecommendation` field initialised to `null`
- In `_pickAndExecuteBattleStrategy`: check recommendation before own logic
- In `_evaluateAndAdaptStrategy`: check recommendation before deciding to continue or switch
- Report panel: show advisor recommendation and confidence

---

## Visual
Small unit, distinct from other operatives. Suggested: thin double ring (like
LT) but in a neutral grey-white, with a small map/compass pip in the centre.
Draws a faint dashed line from himself to `_lastContactPos` when a
recommendation is active, so you can see what he is reacting to.
