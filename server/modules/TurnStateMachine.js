'use strict';

const { SpaceWeatherSystem, SPACE_WEATHER, WEATHER_DEF, WEATHER_CHANGE_INTERVAL } = require('./SpaceWeather');

const PHASE = Object.freeze({
  WAITING: 'waiting',
  PLANNING: 'planning',
  ACTION: 'action',
  RESOLUTION: 'resolution',
  TURN_END: 'turn_end',
  GAME_OVER: 'game_over'
});

const ACTION_TYPE = Object.freeze({
  MOVE: 'move',
  ATTACK: 'attack',
  REPAIR: 'repair',
  SHIELD_REGEN: 'shield_regen',
  SKIP: 'skip',
  END_TURN: 'end_turn'
});

class ActionPointPool {
  constructor(total = 6) {
    this.max = total;
    this.remaining = total;
    this.moveCost = 1;
    this.attackCost = 3;
    this.repairCost = 4;
    this.shieldRegenCost = 2;
  }

  reset(total = null) {
    if (total !== null) this.max = total;
    this.remaining = this.max;
  }

  canAfford(cost) {
    return this.remaining >= cost;
  }

  spend(cost) {
    if (this.remaining < cost) return false;
    this.remaining -= cost;
    return true;
  }

  refund(cost) {
    this.remaining = Math.min(this.max, this.remaining + cost);
  }

  serialize() {
    return {
      max: this.max,
      remaining: this.remaining,
      moveCost: this.moveCost,
      attackCost: this.attackCost,
      repairCost: this.repairCost,
      shieldRegenCost: this.shieldRegenCost
    };
  }

  static deserialize(data) {
    const p = new ActionPointPool(data.max);
    p.remaining = data.remaining;
    p.moveCost = data.moveCost;
    p.attackCost = data.attackCost;
    p.repairCost = data.repairCost;
    p.shieldRegenCost = data.shieldRegenCost;
    return p;
  }
}

class TurnStateMachine {
  constructor(playerIds) {
    this.phase = PHASE.WAITING;
    this.turnNumber = 0;
    this.roundNumber = 0;
    this.players = playerIds ? [...playerIds] : [];
    this.currentPlayerIndex = 0;
    this.apPools = new Map();
    this.actionsThisTurn = [];
    this.actedShips = new Set();
    this.winner = null;
    this._listeners = new Map();
    this.weather = new SpaceWeatherSystem();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const list = this._listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  _emit(event, payload) {
    const list = this._listeners.get(event);
    if (!list) return;
    for (const h of list) {
      try { h(payload); } catch (e) { console.error('TSM listener error:', e); }
    }
  }

  get currentPlayerId() {
    if (this.players.length === 0) return null;
    return this.players[this.currentPlayerIndex];
  }

  getPlayerAP(playerId) {
    return this.apPools.get(playerId) || null;
  }

  _ensureAPPools() {
    for (const pid of this.players) {
      if (!this.apPools.has(pid)) {
        this.apPools.set(pid, new ActionPointPool());
      }
    }
  }

  startGame(firstPlayerIndex = 0) {
    if (this.players.length < 2) throw new Error('Need at least 2 players');
    if (this.phase !== PHASE.WAITING) return false;

    this._ensureAPPools();
    this.currentPlayerIndex = firstPlayerIndex % this.players.length;
    this.roundNumber = 1;
    this.turnNumber = 1;
    this.phase = PHASE.PLANNING;
    this.actionsThisTurn = [];
    this.actedShips = new Set();
    this._resetCurrentAP();

    this._emit('phase_change', { phase: this.phase });
    this._emit('turn_start', {
      playerId: this.currentPlayerId,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber
    });
    return true;
  }

  _resetCurrentAP() {
    const ap = this.apPools.get(this.currentPlayerId);
    if (ap) ap.reset();
  }

  enterActionPhase() {
    if (this.phase !== PHASE.PLANNING) return false;
    this.phase = PHASE.ACTION;
    this._emit('phase_change', { phase: this.phase });
    return true;
  }

  enterResolutionPhase() {
    if (this.phase !== PHASE.ACTION) return false;
    this.phase = PHASE.RESOLUTION;
    this._emit('phase_change', { phase: this.phase });
    return true;
  }

  canPerformAction(actionType, shipId = null) {
    if (this.phase !== PHASE.ACTION && this.phase !== PHASE.PLANNING) return false;
    const ap = this.apPools.get(this.currentPlayerId);
    if (!ap) return false;

    let cost = 0;
    switch (actionType) {
      case ACTION_TYPE.MOVE: cost = ap.moveCost; break;
      case ACTION_TYPE.ATTACK: cost = ap.attackCost; break;
      case ACTION_TYPE.REPAIR: cost = ap.repairCost; break;
      case ACTION_TYPE.SHIELD_REGEN: cost = ap.shieldRegenCost; break;
      case ACTION_TYPE.SKIP: cost = 0; break;
      case ACTION_TYPE.END_TURN: cost = 0; break;
      default: return false;
    }

    if (!ap.canAfford(cost)) return false;
    if (shipId && actionType !== ACTION_TYPE.END_TURN && actionType !== ACTION_TYPE.SKIP) {
      if (this.actedShips.has(shipId) && actionType !== ACTION_TYPE.MOVE) return false;
    }
    return true;
  }

  getActionCost(actionType) {
    const ap = this.apPools.get(this.currentPlayerId);
    if (!ap) return 0;
    switch (actionType) {
      case ACTION_TYPE.MOVE: return ap.moveCost;
      case ACTION_TYPE.ATTACK: return ap.attackCost;
      case ACTION_TYPE.REPAIR: return ap.repairCost;
      case ACTION_TYPE.SHIELD_REGEN: return ap.shieldRegenCost;
      default: return 0;
    }
  }

  recordAction(action) {
    const type = action.type;
    const cost = this.getActionCost(type);
    const ap = this.apPools.get(this.currentPlayerId);
    if (!ap || !ap.spend(cost)) return false;

    if (action.shipId) this.actedShips.add(action.shipId);
    this.actionsThisTurn.push({
      ...action,
      resolved: false,
      timestamp: Date.now(),
      playerId: this.currentPlayerId
    });
    return true;
  }

  refundLastAction() {
    if (this.actionsThisTurn.length === 0) return null;
    const last = this.actionsThisTurn.pop();
    const cost = this.getActionCost(last.type);
    const ap = this.apPools.get(last.playerId);
    if (ap) ap.refund(cost);
    if (last.shipId) this.actedShips.delete(last.shipId);
    this._emit('action_refunded', last);
    return last;
  }

  endTurn() {
    if (this.phase === PHASE.GAME_OVER) return null;

    const endedPlayerId = this.currentPlayerId;
    this.phase = PHASE.TURN_END;
    this._emit('phase_change', { phase: this.phase });
    this._emit('turn_end', {
      playerId: endedPlayerId,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber,
      actions: [...this.actionsThisTurn]
    });

    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.turnNumber += 1;

    if (this.currentPlayerIndex === 0) {
      this.roundNumber += 1;
      this._emit('round_end', { roundNumber: this.roundNumber - 1 });
    }

    const weatherChange = this.weather.advanceTurn(this.turnNumber);
    if (weatherChange) {
      this._emit('weather_change', weatherChange);
    }

    this.actionsThisTurn = [];
    this.actedShips = new Set();
    this.phase = PHASE.PLANNING;
    this._resetCurrentAP();

    this._emit('phase_change', { phase: this.phase });
    this._emit('turn_start', {
      playerId: this.currentPlayerId,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber,
      weather: weatherChange ? weatherChange.newWeather : null
    });

    return {
      endedPlayerId,
      nextPlayerId: this.currentPlayerId,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber,
      weatherChange
    };
  }

  isPlayerTurn(playerId) {
    return this.currentPlayerId === playerId && this.phase !== PHASE.GAME_OVER;
  }

  setGameOver(winnerId) {
    this.phase = PHASE.GAME_OVER;
    this.winner = winnerId;
    this._emit('game_over', { winner: winnerId });
  }

  serialize() {
    const pools = {};
    for (const [pid, pool] of this.apPools) pools[pid] = pool.serialize();
    return {
      phase: this.phase,
      turnNumber: this.turnNumber,
      roundNumber: this.roundNumber,
      players: [...this.players],
      currentPlayerIndex: this.currentPlayerIndex,
      apPools: pools,
      actionsThisTurn: this.actionsThisTurn,
      actedShips: [...this.actedShips],
      winner: this.winner,
      weather: this.weather.serialize()
    };
  }

  static deserialize(data) {
    const t = new TurnStateMachine(data.players);
    t.phase = data.phase;
    t.turnNumber = data.turnNumber;
    t.roundNumber = data.roundNumber;
    t.currentPlayerIndex = data.currentPlayerIndex;
    for (const [pid, pd] of Object.entries(data.apPools)) {
      t.apPools.set(pid, ActionPointPool.deserialize(pd));
    }
    t.actionsThisTurn = data.actionsThisTurn || [];
    t.actedShips = new Set(data.actedShips || []);
    t.winner = data.winner;
    if (data.weather) {
      t.weather = SpaceWeatherSystem.deserialize(data.weather);
    }
    return t;
  }
}

module.exports = {
  PHASE,
  ACTION_TYPE,
  ActionPointPool,
  TurnStateMachine,
  SPACE_WEATHER,
  WEATHER_DEF,
  WEATHER_CHANGE_INTERVAL
};
