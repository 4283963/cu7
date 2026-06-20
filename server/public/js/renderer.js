'use strict';

(function (global) {
  const SS = global.SteamShip;
  if (!SS) throw new Error('shared.js must be loaded first');

  const { TERRAIN_STYLE, SHIP_STYLE, buildCoordKey, computeReachableClient, reconstructPath, manhattan } = SS;

  class CanvasRenderer {
    constructor(canvas, overlayCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.overlay = overlayCanvas;
      this.octx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
      this.cellSize = 54;
      this.offsetX = 20;
      this.offsetY = 20;
      this.map = null;
      this.ships = [];
      this.players = [];
      this.meId = null;
      this.hoverCell = null;
      this.selectedShipId = null;
      this.reachable = null;
      this.attackTiles = null;
      this.plannedPath = null;
      this.animations = [];
      this._running = false;
    }

    resize(width, height, mapWidth, mapHeight) {
      const maxCell = Math.min(
        Math.floor((width - 40) / mapWidth),
        Math.floor((height - 40) / mapHeight),
        72
      );
      this.cellSize = Math.max(36, maxCell);
      this.canvas.width = width;
      this.canvas.height = height;
      this.overlay.width = width;
      this.overlay.height = height;
      this.offsetX = Math.floor((width - this.cellSize * mapWidth) / 2);
      this.offsetY = Math.floor((height - this.cellSize * mapHeight) / 2);
    }

    setState(state, meId) {
      this.map = state.map;
      this.ships = state.ships;
      this.players = state.players;
      this.meId = meId;
      this.updateHighlights();
    }

    setSelectedShip(shipId) {
      this.selectedShipId = shipId;
      this.updateHighlights();
    }

    updateHighlights() {
      this.reachable = null;
      this.attackTiles = null;
      if (!this.selectedShipId || !this.map || !this.ships) return;
      const ship = this.ships.find(s => s.id === this.selectedShipId);
      if (!ship || ship.isDestroyed) return;
      try {
        this.reachable = computeReachableClient(this.map, ship.coord, ship.baseMoveRange, ship.id);
      } catch (e) { console.warn(e); }
      this.attackTiles = new Set();
      for (let y = 0; y < this.map.height; y++) {
        for (let x = 0; x < this.map.width; x++) {
          const d = manhattan({ x, y }, ship.coord);
          if (d >= ship.baseAttackMinRange && d <= ship.baseAttackMaxRange) {
            this.attackTiles.add(buildCoordKey(x, y));
          }
        }
      }
    }

    setHover(x, y) {
      if (x === null || y === null) { this.hoverCell = null; this.plannedPath = null; return; }
      this.hoverCell = { x, y };
      if (this.selectedShipId && this.reachable) {
        const ship = this.ships.find(s => s.id === this.selectedShipId);
        const path = reconstructPath(this.reachable, { x, y });
        this.plannedPath = path && path.length > 0 ? path : null;
      }
    }

    cellToPx(cx, cy) {
      return {
        x: this.offsetX + cx * this.cellSize + this.cellSize / 2,
        y: this.offsetY + cy * this.cellSize + this.cellSize / 2
      };
    }

    pxToCell(px, py) {
      const cx = Math.floor((px - this.offsetX) / this.cellSize);
      const cy = Math.floor((py - this.offsetY) / this.cellSize);
      if (!this.map) return { x: cx, y: cy };
      if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) return null;
      return { x: cx, y: cy };
    }

    _drawCell(cx, cy) {
      const key = buildCoordKey(cx, cy);
      const terrain = (this.map && this.map.terrains && this.map.terrains[key]) || 'plain';
      const style = TERRAIN_STYLE[terrain] || TERRAIN_STYLE.plain;
      const x = this.offsetX + cx * this.cellSize;
      const y = this.offsetY + cy * this.cellSize;
      this.ctx.fillStyle = style.fill;
      this.ctx.fillRect(x, y, this.cellSize, this.cellSize);
      this.ctx.strokeStyle = style.grid;
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(x + 0.5, y + 0.5, this.cellSize - 1, this.cellSize - 1);
      this._drawTerrainDecoration(cx, cy, terrain, x, y);
    }

    _drawTerrainDecoration(cx, cy, terrain, x, y) {
      const cs = this.cellSize;
      this.ctx.save();
      this.ctx.globalAlpha = 0.5;
      if (terrain === 'mountain') {
        this.ctx.fillStyle = '#4a3f2a';
        this.ctx.beginPath();
        this.ctx.moveTo(x + cs * 0.2, y + cs * 0.8);
        this.ctx.lineTo(x + cs * 0.5, y + cs * 0.25);
        this.ctx.lineTo(x + cs * 0.65, y + cs * 0.55);
        this.ctx.lineTo(x + cs * 0.8, y + cs * 0.35);
        this.ctx.lineTo(x + cs * 0.9, y + cs * 0.8);
        this.ctx.closePath();
        this.ctx.fill();
      } else if (terrain === 'forest') {
        this.ctx.fillStyle = '#1e4620';
        for (let i = 0; i < 3; i++) {
          const tx = x + cs * (0.2 + i * 0.28);
          const ty = y + cs * 0.55;
          const tr = cs * 0.15;
          this.ctx.beginPath();
          this.ctx.moveTo(tx, ty + tr * 1.3);
          this.ctx.lineTo(tx + tr, ty);
          this.ctx.lineTo(tx - tr, ty);
          this.ctx.closePath();
          this.ctx.fill();
        }
      } else if (terrain === 'water') {
        this.ctx.strokeStyle = '#7fb3d5';
        this.ctx.lineWidth = 2;
        for (let i = 0; i < 2; i++) {
          this.ctx.beginPath();
          const wy = y + cs * (0.35 + i * 0.3);
          this.ctx.moveTo(x + cs * 0.15, wy);
          this.ctx.quadraticCurveTo(x + cs * 0.3, wy - cs * 0.05, x + cs * 0.45, wy);
          this.ctx.quadraticCurveTo(x + cs * 0.6, wy + cs * 0.05, x + cs * 0.75, wy);
          this.ctx.stroke();
        }
      } else if (terrain === 'wreck') {
        this.ctx.fillStyle = '#5d4e37';
        this.ctx.fillRect(x + cs * 0.3, y + cs * 0.35, cs * 0.45, cs * 0.25);
        this.ctx.fillStyle = '#3f3325';
        this.ctx.fillRect(x + cs * 0.2, y + cs * 0.5, cs * 0.25, cs * 0.15);
      } else if (terrain === 'supernova') {
        const cx = x + cs * 0.5, cy = y + cs * 0.5;
        const t = Date.now() / 1000;
        for (let r = 0; r < 3; r++) {
          const rad = cs * (0.12 + r * 0.1) + Math.sin(t * 2 + r) * cs * 0.02;
          this.ctx.strokeStyle = `rgba(244, 114, 182, ${0.55 - r * 0.15})`;
          this.ctx.lineWidth = 2;
          this.ctx.beginPath();
          this.ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          this.ctx.stroke();
        }
        this.ctx.fillStyle = '#fff';
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, cs * 0.06, 0, Math.PI * 2);
        this.ctx.fill();
      } else if (terrain === 'blackhole') {
        const cx = x + cs * 0.5, cy = y + cs * 0.5;
        const t = Date.now() / 800;
        this.ctx.fillStyle = '#000';
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, cs * 0.28, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = 'rgba(139, 92, 246, 0.7)';
        this.ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          this.ctx.beginPath();
          const startAngle = t + (i * Math.PI * 2 / 3);
          this.ctx.arc(cx, cy, cs * 0.35 + i * 4, startAngle, startAngle + Math.PI * 1.2);
          this.ctx.stroke();
        }
      } else if (terrain === 'meteor') {
        this.ctx.fillStyle = '#78350f';
        const rocks = [[0.25, 0.3, 0.09], [0.6, 0.5, 0.12], [0.35, 0.7, 0.08], [0.75, 0.25, 0.07]];
        for (const [rx, ry, rr] of rocks) {
          this.ctx.beginPath();
          this.ctx.arc(x + cs * rx, y + cs * ry, cs * rr, 0, Math.PI * 2);
          this.ctx.fill();
        }
        this.ctx.fillStyle = '#a16207';
        for (const [rx, ry, rr] of rocks) {
          this.ctx.beginPath();
          this.ctx.arc(x + cs * rx - 1, y + cs * ry - 1, cs * rr * 0.6, 0, Math.PI * 2);
          this.ctx.fill();
        }
      }
      this.ctx.restore();
    }

    _drawHighlights() {
      const cs = this.cellSize;
      if (this.attackTiles && this.selectedShipId) {
        for (const key of this.attackTiles) {
          const [x, y] = key.split(',').map(Number);
          const p = this.cellToPx(x, y);
          this.ctx.save();
          this.ctx.globalAlpha = 0.22;
          this.ctx.fillStyle = '#ef4444';
          this.ctx.fillRect(p.x - cs / 2, p.y - cs / 2, cs, cs);
          this.ctx.restore();
        }
      }
      if (this.reachable && this.selectedShipId) {
        for (const [, v] of this.reachable) {
          const p = this.cellToPx(v.x, v.y);
          this.ctx.save();
          this.ctx.globalAlpha = 0.22;
          this.ctx.fillStyle = '#3b82f6';
          this.ctx.fillRect(p.x - cs / 2, p.y - cs / 2, cs, cs);
          this.ctx.restore();
        }
      }
      if (this.plannedPath && this.plannedPath.length > 1) {
        this.ctx.save();
        this.ctx.strokeStyle = '#fbbf24';
        this.ctx.lineWidth = 3;
        this.ctx.setLineDash([6, 4]);
        this.ctx.beginPath();
        for (let i = 0; i < this.plannedPath.length; i++) {
          const p = this.cellToPx(this.plannedPath[i].x, this.plannedPath[i].y);
          if (i === 0) this.ctx.moveTo(p.x, p.y); else this.ctx.lineTo(p.x, p.y);
        }
        this.ctx.stroke();
        const last = this.plannedPath[this.plannedPath.length - 1];
        const lp = this.cellToPx(last.x, last.y);
        this.ctx.setLineDash([]);
        this.ctx.fillStyle = '#fbbf24';
        this.ctx.beginPath();
        this.ctx.arc(lp.x, lp.y, 6, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();
      }
      if (this.hoverCell) {
        const p = this.cellToPx(this.hoverCell.x, this.hoverCell.y);
        this.ctx.save();
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 3;
        this.ctx.strokeRect(p.x - cs / 2 + 2, p.y - cs / 2 + 2, cs - 4, cs - 4);
        this.ctx.restore();
      }
      if (this.selectedShipId) {
        const ship = this.ships.find(s => s.id === this.selectedShipId);
        if (ship) {
          const p = this.cellToPx(ship.coord.x, ship.coord.y);
          this.ctx.save();
          this.ctx.strokeStyle = '#22d3ee';
          this.ctx.lineWidth = 3;
          this.ctx.setLineDash([4, 3]);
          this.ctx.strokeRect(p.x - cs / 2 + 2, p.y - cs / 2 + 2, cs - 4, cs - 4);
          this.ctx.restore();
        }
      }
    }

    _playerColor(playerId) {
      if (!this.players) return '#888';
      const p = this.players.find(x => x.id === playerId);
      return p ? p.color : '#888';
    }

    _drawShip(ship) {
      if (ship.isDestroyed) return;
      const style = SHIP_STYLE[ship.role] || SHIP_STYLE.cruiser;
      const ownerColor = this._playerColor(ship.ownerId);
      const p = this.cellToPx(ship.coord.x, ship.coord.y);
      const cs = this.cellSize;
      const facingDeg = { N: -90, E: 0, S: 90, W: 180 }[ship.facing] || 0;
      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(facingDeg * Math.PI / 180);
      this.ctx.fillStyle = style.color;
      this.ctx.strokeStyle = ownerColor;
      this.ctx.lineWidth = 2.5;
      const w = cs * 0.72, h = cs * 0.48;
      this.ctx.beginPath();
      this.ctx.moveTo(w / 2, 0);
      this.ctx.lineTo(w / 2 - h * 0.35, -h / 2);
      this.ctx.lineTo(-w / 2, -h / 2);
      this.ctx.lineTo(-w / 2 + h * 0.15, 0);
      this.ctx.lineTo(-w / 2, h / 2);
      this.ctx.lineTo(w / 2 - h * 0.35, h / 2);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.fillStyle = style.stroke;
      this.ctx.fillRect(0, -h * 0.18, w * 0.2, h * 0.36);
      this.ctx.fillStyle = '#1f2937';
      this.ctx.fillRect(-w * 0.25, -h * 0.35, w * 0.06, h * 0.15);
      this.ctx.fillRect(-w * 0.25, h * 0.2, w * 0.06, h * 0.15);
      this.ctx.restore();
      this._drawStatusBars(ship, p.x, p.y, cs);
    }

    _drawStatusBars(ship, cx, cy, cs) {
      const barW = cs * 0.7, barH = 4;
      const y0 = cy + cs * 0.38;
      const x0 = cx - barW / 2;
      const ownerColor = this._playerColor(ship.ownerId);
      const hpPct = Math.max(0, ship.hull / ship.maxHull);
      const shPct = ship.maxShield > 0 ? Math.max(0, ship.shield / ship.maxShield) : 0;
      const arPct = ship.maxArmor > 0 ? Math.max(0, ship.armor / ship.maxArmor) : 0;
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(0,0,0,0.45)';
      this.ctx.fillRect(x0 - 1, y0 - 1, barW + 2, barH * 3 + 4);
      this.ctx.fillStyle = '#374151';
      this.ctx.fillRect(x0, y0, barW, barH);
      this.ctx.fillStyle = hpPct > 0.5 ? '#22c55e' : hpPct > 0.25 ? '#eab308' : '#ef4444';
      this.ctx.fillRect(x0, y0, barW * hpPct, barH);
      this.ctx.fillStyle = '#374151';
      this.ctx.fillRect(x0, y0 + barH + 1, barW, barH);
      this.ctx.fillStyle = '#06b6d4';
      this.ctx.fillRect(x0, y0 + barH + 1, barW * shPct, barH);
      this.ctx.fillStyle = '#374151';
      this.ctx.fillRect(x0, y0 + (barH + 1) * 2, barW, barH);
      this.ctx.fillStyle = '#a8a29e';
      this.ctx.fillRect(x0, y0 + (barH + 1) * 2, barW * arPct, barH);
      this.ctx.strokeStyle = ownerColor;
      this.ctx.lineWidth = 1.5;
      this.ctx.strokeRect(x0 - 1, y0 - 1, barW + 2, barH * 3 + 4);
      this.ctx.restore();
    }

    _drawCoordLabels() {
      if (!this.map) return;
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(255,255,255,0.35)';
      this.ctx.font = `${Math.max(10, this.cellSize * 0.18)}px monospace`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'top';
      for (let x = 0; x < this.map.width; x++) {
        const p = this.cellToPx(x, 0);
        this.ctx.fillText(String.fromCharCode(65 + x), p.x, this.offsetY - 2);
      }
      this.ctx.textAlign = 'right';
      this.ctx.textBaseline = 'middle';
      for (let y = 0; y < this.map.height; y++) {
        const p = this.cellToPx(0, y);
        this.ctx.fillText(y + 1, this.offsetX - 4, p.y);
      }
      this.ctx.restore();
    }

    _drawGridLines() {
      if (!this.map) return;
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(0,0,0,0.1)';
      this.ctx.lineWidth = 1;
      for (let y = 0; y <= this.map.height; y++) {
        this.ctx.beginPath();
        this.ctx.moveTo(this.offsetX, this.offsetY + y * this.cellSize);
        this.ctx.lineTo(this.offsetX + this.map.width * this.cellSize, this.offsetY + y * this.cellSize);
        this.ctx.stroke();
      }
      for (let x = 0; x <= this.map.width; x++) {
        this.ctx.beginPath();
        this.ctx.moveTo(this.offsetX + x * this.cellSize, this.offsetY);
        this.ctx.lineTo(this.offsetX + x * this.cellSize, this.offsetY + this.map.height * this.cellSize);
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    render() {
      if (!this.map) return;
      const { ctx } = this;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      for (let y = 0; y < this.map.height; y++) for (let x = 0; x < this.map.width; x++) this._drawCell(x, y);
      this._drawHighlights();
      this._drawCoordLabels();
      this._drawGridLines();
      const sortedShips = [...this.ships].sort((a, b) => a.coord.y - b.coord.y);
      for (const s of sortedShips) this._drawShip(s);
      this._drawAnimations();
    }

    addExplosion(px, py, color = '#ef4444') {
      this.animations.push({ type: 'explosion', x: px, y: py, t: 0, duration: 0.7, color });
    }
    addLaser(fromPx, fromPy, toPx, toPy, color = '#60a5fa') {
      this.animations.push({ type: 'laser', x1: fromPx, y1: fromPy, x2: toPx, y2: toPy, t: 0, duration: 0.4, color });
    }
    _drawAnimations() {
      this.animations = this.animations.filter(a => a.t < a.duration);
      for (const a of this.animations) {
        const t = a.t / a.duration;
        this.ctx.save();
        if (a.type === 'explosion') {
          const r = 10 + t * 50;
          this.ctx.globalAlpha = 1 - t;
          this.ctx.strokeStyle = a.color;
          this.ctx.lineWidth = 3;
          this.ctx.beginPath(); this.ctx.arc(a.x, a.y, r, 0, Math.PI * 2); this.ctx.stroke();
          this.ctx.fillStyle = '#fbbf24';
          this.ctx.globalAlpha = (1 - t) * 0.8;
          this.ctx.beginPath(); this.ctx.arc(a.x, a.y, r * 0.35, 0, Math.PI * 2); this.ctx.fill();
        } else if (a.type === 'laser') {
          this.ctx.globalAlpha = 1 - t;
          this.ctx.strokeStyle = a.color;
          this.ctx.lineWidth = 3 + (1 - t) * 3;
          this.ctx.beginPath(); this.ctx.moveTo(a.x1, a.y1); this.ctx.lineTo(a.x2, a.y2); this.ctx.stroke();
        }
        this.ctx.restore();
      }
    }

    animate(dt) {
      for (const a of this.animations) a.t += dt;
      this.render();
    }
  }

  SS.CanvasRenderer = CanvasRenderer;
})(window);
