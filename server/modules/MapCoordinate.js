'use strict';

const TERRAIN = Object.freeze({
  PLAIN: 'plain',
  MOUNTAIN: 'mountain',
  WATER: 'water',
  FOREST: 'forest',
  WRECK: 'wreck'
});

const TERRAIN_COST = Object.freeze({
  [TERRAIN.PLAIN]: 1,
  [TERRAIN.MOUNTAIN]: Infinity,
  [TERRAIN.WATER]: Infinity,
  [TERRAIN.FOREST]: 2,
  [TERRAIN.WRECK]: 3
});

const TERRAIN_DEFENSE = Object.freeze({
  [TERRAIN.PLAIN]: 0,
  [TERRAIN.MOUNTAIN]: 0,
  [TERRAIN.WATER]: 0,
  [TERRAIN.FOREST]: 1,
  [TERRAIN.WRECK]: 2
});

class Coord {
  constructor(x, y) {
    this.x = x | 0;
    this.y = y | 0;
  }

  static of(x, y) {
    return new Coord(x, y);
  }

  equals(other) {
    return other && this.x === other.x && this.y === other.y;
  }

  toString() {
    return `(${this.x},${this.y})`;
  }

  toKey() {
    return `${this.x},${this.y}`;
  }

  static fromKey(key) {
    const [x, y] = key.split(',').map(Number);
    return new Coord(x, y);
  }

  clone() {
    return new Coord(this.x, this.y);
  }

  add(other) {
    return new Coord(this.x + other.x, this.y + other.y);
  }
}

const DIRS = Object.freeze([
  Coord.of(1, 0),
  Coord.of(-1, 0),
  Coord.of(0, 1),
  Coord.of(0, -1)
]);

class MapGrid {
  constructor(width, height, terrainMap = null) {
    this.width = width | 0;
    this.height = height | 0;
    this._terrains = new Map();
    this._occupiedBy = new Map();

    if (terrainMap) {
      for (const [key, terrain] of Object.entries(terrainMap)) {
        this._terrains.set(key, terrain);
      }
    }
  }

  static generateDefault(width = 12, height = 10) {
    const map = new MapGrid(width, height);
    const mountains = [
      [3, 2], [3, 3], [4, 2],
      [8, 7], [8, 6], [7, 7],
      [5, 5], [6, 4]
    ];
    const forests = [
      [1, 4], [2, 4], [1, 5],
      [10, 5], [10, 6], [9, 5],
      [6, 8], [5, 8]
    ];
    const wrecks = [
      [4, 7], [7, 2]
    ];
    const waters = [
      [0, 0], [11, 9], [0, 9], [11, 0]
    ];

    for (const [x, y] of mountains) map.setTerrain(Coord.of(x, y), TERRAIN.MOUNTAIN);
    for (const [x, y] of forests) map.setTerrain(Coord.of(x, y), TERRAIN.FOREST);
    for (const [x, y] of wrecks) map.setTerrain(Coord.of(x, y), TERRAIN.WRECK);
    for (const [x, y] of waters) map.setTerrain(Coord.of(x, y), TERRAIN.WATER);

    return map;
  }

  inBounds(coord) {
    return coord.x >= 0 && coord.x < this.width &&
           coord.y >= 0 && coord.y < this.height;
  }

  getTerrain(coord) {
    if (!this.inBounds(coord)) return TERRAIN.MOUNTAIN;
    return this._terrains.get(coord.toKey()) || TERRAIN.PLAIN;
  }

  setTerrain(coord, terrain) {
    if (!this.inBounds(coord)) return;
    this._terrains.set(coord.toKey(), terrain);
  }

  getMoveCost(coord) {
    return TERRAIN_COST[this.getTerrain(coord)];
  }

  getDefenseBonus(coord) {
    return TERRAIN_DEFENSE[this.getTerrain(coord)] || 0;
  }

  isBlocked(coord) {
    return !this.inBounds(coord) || !isFinite(this.getMoveCost(coord));
  }

  isOccupied(coord) {
    return this._occupiedBy.has(coord.toKey());
  }

  getOccupant(coord) {
    return this._occupiedBy.get(coord.toKey()) || null;
  }

  setOccupant(coord, shipId) {
    if (shipId === null || shipId === undefined) {
      this._occupiedBy.delete(coord.toKey());
    } else {
      this._occupiedBy.set(coord.toKey(), shipId);
    }
  }

  moveOccupant(from, to, shipId) {
    this.setOccupant(from, null);
    this.setOccupant(to, shipId);
  }

  manhattanDistance(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  chebyshevDistance(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  getNeighbors(coord) {
    const result = [];
    for (const d of DIRS) {
      const n = coord.add(d);
      if (this.inBounds(n)) result.push(n);
    }
    return result;
  }

  computeReachable(start, maxCost, excludeSelfShipId = null) {
    const result = new Map();
    if (this.isBlocked(start)) return result;

    result.set(start.toKey(), { coord: start.clone(), cost: 0, prev: null });
    const frontier = [{ coord: start.clone(), cost: 0 }];

    while (frontier.length > 0) {
      frontier.sort((a, b) => a.cost - b.cost);
      const current = frontier.shift();

      if (current.cost > maxCost) continue;

      for (const neighbor of this.getNeighbors(current.coord)) {
        const nKey = neighbor.toKey();
        if (this.isBlocked(neighbor)) continue;

        const occupant = this.getOccupant(neighbor);
        if (occupant && occupant !== excludeSelfShipId) continue;

        const stepCost = this.getMoveCost(neighbor);
        if (!isFinite(stepCost)) continue;

        const newCost = current.cost + stepCost;
        if (newCost > maxCost) continue;

        const existing = result.get(nKey);
        if (!existing || newCost < existing.cost) {
          result.set(nKey, { coord: neighbor.clone(), cost: newCost, prev: current.coord });
          frontier.push({ coord: neighbor.clone(), cost: newCost });
        }
      }
    }

    result.delete(start.toKey());
    return result;
  }

  computeAttackRange(origin, minRange, maxRange) {
    const result = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = Coord.of(x, y);
        const dist = this.manhattanDistance(origin, c);
        if (dist >= minRange && dist <= maxRange) {
          result.push(c);
        }
      }
    }
    return result;
  }

  traceLine(from, to) {
    const points = [];
    let x0 = from.x, y0 = from.y;
    const x1 = to.x, y1 = to.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - from.y);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
      points.push(Coord.of(x0, y0));
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return points;
  }

  hasLineOfSight(from, to, ignoreCoord = null) {
    const line = this.traceLine(from, to);
    for (let i = 1; i < line.length - 1; i++) {
      const c = line[i];
      if (ignoreCoord && c.equals(ignoreCoord)) continue;
      if (this.isBlocked(c)) return false;
    }
    return true;
  }

  reconstructPath(reachable, target) {
    const path = [];
    let cur = reachable.get(target.toKey());
    if (!cur) return null;
    while (cur) {
      path.unshift(cur.coord);
      cur = cur.prev ? reachable.get(cur.prev.toKey()) : null;
    }
    return path;
  }

  serialize() {
    const terrains = {};
    for (const [k, v] of this._terrains) terrains[k] = v;
    const occupied = {};
    for (const [k, v] of this._occupiedBy) occupied[k] = v;
    return {
      width: this.width,
      height: this.height,
      terrains,
      occupied
    };
  }

  static deserialize(data) {
    const m = new MapGrid(data.width, data.height, data.terrains);
    if (data.occupied) {
      for (const [k, v] of Object.entries(data.occupied)) m._occupiedBy.set(k, v);
    }
    return m;
  }
}

module.exports = {
  TERRAIN,
  TERRAIN_COST,
  TERRAIN_DEFENSE,
  Coord,
  DIRS,
  MapGrid
};
