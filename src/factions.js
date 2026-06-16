export class Faction {
  constructor(id, name, color, primaryColor, secondaryColor) {
    this.id             = id;
    this.name           = name;
    this.color          = color;         // hex string, used for units/UI
    this.primaryColor   = primaryColor;
    this.secondaryColor = secondaryColor;
  }
}

export class FactionManager {
  constructor() {
    this.factions = new Map();  // id -> Faction
    this._allies  = new Set();  // "idA:idB" pairs (always sorted so A < B)
  }

  add(id, name, color, primaryColor, secondaryColor) {
    this.factions.set(id, new Faction(id, name, color, primaryColor, secondaryColor));
    return this;
  }

  get(id) {
    return this.factions.get(id) ?? null;
  }

  all() {
    return [...this.factions.values()];
  }

  // Form an alliance between two factions (bidirectional)
  ally(idA, idB) {
    if (idA === idB) return;
    this._allies.add(this._key(idA, idB));
  }

  // Break an alliance
  unally(idA, idB) {
    this._allies.delete(this._key(idA, idB));
  }

  areAllied(idA, idB) {
    if (idA === idB) return true; // same faction is always "allied" with itself
    return this._allies.has(this._key(idA, idB));
  }

  // Not the same faction and not allied
  areEnemies(idA, idB) {
    return idA !== idB && !this.areAllied(idA, idB);
  }

  // All factions allied with a given faction
  alliesOf(id) {
    return this.all().filter(f => f.id !== id && this.areAllied(id, f.id));
  }

  // All factions that are enemies of a given faction
  enemiesOf(id) {
    return this.all().filter(f => f.id !== id && this.areEnemies(id, f.id));
  }

  _key(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}

// ── Default factions ──────────────────────────────────────────────────────────
export function createDefaultFactions() {
  const mgr = new FactionManager();

  mgr.add('crimson', 'Crimson',  '#d94040', '#d94040', '#8a1a1a');
  mgr.add('azure',   'Azure',    '#3a82d4', '#3a82d4', '#1a3a7a');

  // Start as enemies (no alliance formed)
  return mgr;
}
