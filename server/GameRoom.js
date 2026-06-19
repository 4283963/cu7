'use strict';

const { MapGrid, Coord, TERRAIN } = require('./modules/MapCoordinate');
const { TurnStateMachine, PHASE, ACTION_TYPE } = require('./modules/TurnStateMachine');
const { Ship, DamageCalculator, SHIP_ROLE, SHIP_STAT_DEFS } = require('./modules/ShieldDamage');
const { MSG_TYPE, ERROR_CODE } = require('./modules/MessageCodec');

function roomId() {
  return 'R' + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function playerId() {
  return 'P' + Math.random().toString(36).slice(2, 8);
}
function shipId() {
  return 'S' + Math.random().toString(36).slice(2, 8);
}

class GameRoom {
  constructor(id, codec, dispatcher, server) {
    this.id = id;
    this.codec = codec;
    this.dispatcher = dispatcher;
    this.server = server;
    this.name = `房间 ${id}`;
    this.players = new Map();
    this.ships = new Map();
    this.map = MapGrid.generateDefault(12, 10);
    this.tsm = null;
    this.selectedShips = new Map();
    this.createdAt = Date.now();
    this.chatLog = [];
    this._tsmListenersBound = false;
  }

  addPlayer(conn, playerName) {
    if (this.players.size >= 2) return { ok: false, code: ERROR_CODE.ROOM_FULL };
    const pid = playerId();
    const entry = {
      id: pid,
      name: playerName || `玩家${this.players.size + 1}`,
      conn,
      color: this.players.size === 0 ? '#3B82F6' : '#EF4444',
      connected: true
    };
    this.players.set(pid, entry);
    conn._roomId = this.id;
    conn._playerId = pid;
    return { ok: true, player: entry };
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (p && p.conn) {
      p.connected = false;
      p.conn._roomId = null;
    }
  }

  _bindTsmListeners() {
    if (this._tsmListenersBound || !this.tsm) return;
    this._tsmListenersBound = true;
    this.tsm.on('phase_change', (p) => {
      this._broadcast(MSG_TYPE.S2C.PHASE_CHANGE, p);
    });
    this.tsm.on('turn_start', (p) => {
      this._onTurnStart(p);
    });
    this.tsm.on('turn_end', (p) => {
      this._broadcast(MSG_TYPE.S2C.TURN_END, p);
    });
    this.tsm.on('game_over', (p) => {
      this._broadcast(MSG_TYPE.S2C.GAME_OVER, p);
    });
  }

  _onTurnStart(info) {
    for (const ship of this.ships.values()) {
      if (ship.ownerId === info.playerId && !ship.isDestroyed) {
        ship.resetTurnState();
        ship.regenShield();
      }
    }
    this._broadcast(MSG_TYPE.S2C.TURN_START, info);
    this._broadcastState();
  }

  startGame() {
    if (this.players.size < 2) return { ok: false, code: ERROR_CODE.ROOM_FULL };
    if (this.tsm && this.tsm.phase !== PHASE.WAITING && this.tsm.phase !== PHASE.GAME_OVER) {
      return { ok: false, code: ERROR_CODE.INVALID_PHASE };
    }
    const playerIds = [...this.players.keys()];
    this.tsm = new TurnStateMachine(playerIds);
    this._bindTsmListeners();
    this._spawnShips();
    this.tsm.startGame(0);
    this._broadcast(MSG_TYPE.S2C.GAME_STARTED, {
      roomId: this.id,
      players: this._publicPlayerList(),
      map: this.map.serialize()
    });
    return { ok: true };
  }

  _spawnShips() {
    this.ships.clear();
    const entries = [...this.players.values()];
    const p1 = entries[0].id;
    const p2 = entries[1].id;
    const shipsP1 = [
      { role: SHIP_ROLE.IRONCLAD, coord: Coord.of(1, 2) },
      { role: SHIP_ROLE.CRUISER, coord: Coord.of(1, 5) },
      { role: SHIP_ROLE.SCOUT, coord: Coord.of(1, 7) }
    ];
    const shipsP2 = [
      { role: SHIP_ROLE.BOMBARD, coord: Coord.of(10, 2) },
      { role: SHIP_ROLE.CRUISER, coord: Coord.of(10, 5) },
      { role: SHIP_ROLE.SCOUT, coord: Coord.of(10, 7) }
    ];
    for (const s of shipsP1) {
      const ship = new Ship(shipId(), s.role, p1, s.coord);
      ship.facing = 'E';
      this.ships.set(ship.id, ship);
      this.map.setOccupant(s.coord, ship.id);
    }
    for (const s of shipsP2) {
      const ship = new Ship(shipId(), s.role, p2, s.coord);
      ship.facing = 'W';
      this.ships.set(ship.id, ship);
      this.map.setOccupant(s.coord, ship.id);
    }
  }

  handle(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return this._sendTo(playerId, this.codec.makeError(ERROR_CODE.NOT_IN_ROOM, '不在房间', msg.id));

    switch (msg.type) {
      case MSG_TYPE.C2S.START_GAME: return this._handleStartGame(player, msg);
      case MSG_TYPE.C2S.SELECT_SHIP: return this._handleSelectShip(player, msg);
      case MSG_TYPE.C2S.REQUEST_MOVE: return this._handleRequestMove(player, msg);
      case MSG_TYPE.C2S.REQUEST_ATTACK: return this._handleRequestAttack(player, msg);
      case MSG_TYPE.C2S.REQUEST_REPAIR: return this._handleRequestRepair(player, msg);
      case MSG_TYPE.C2S.REQUEST_SHIELD_REGEN: return this._handleRequestShieldRegen(player, msg);
      case MSG_TYPE.C2S.UNDO_LAST_ACTION: return this._handleUndo(player, msg);
      case MSG_TYPE.C2S.END_TURN: return this._handleEndTurn(player, msg);
      case MSG_TYPE.C2S.CHAT: return this._handleChat(player, msg);
      case MSG_TYPE.C2S.SYNC_QUERY: return this._handleSyncQuery(player, msg);
      case MSG_TYPE.C2S.PING: return this._sendTo(playerId, this.codec.encode(MSG_TYPE.S2C.PONG, { timestamp: Date.now() }, { replyTo: msg.id }));
      default:
        return this._sendTo(playerId, this.codec.makeError(ERROR_CODE.UNKNOWN_TYPE, `未处理的消息: ${msg.type}`, msg.id));
    }
  }

  _handleStartGame(player, msg) {
    const r = this.startGame();
    if (!r.ok) return this._sendTo(player.id, this.codec.makeError(r.code, '无法开始游戏', msg.id));
    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'start_game', success: true
    }, { replyTo: msg.id }));
    this._broadcastState();
  }

  _handleSelectShip(player, msg) {
    const { shipId } = msg.payload;
    const ship = this.ships.get(shipId);
    if (!ship) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '舰艇不存在', msg.id);
    if (ship.ownerId !== player.id) return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_SHIP, '不是你的舰艇', msg.id);
    this.selectedShips.set(player.id, shipId);
    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'select_ship', success: true, shipId
    }, { replyTo: msg.id }));
  }

  _ensureGamePhase(player, msg, allowPlanning = true) {
    if (!this.tsm) return this._sendErr(player.id, ERROR_CODE.GAME_NOT_STARTED, '游戏未开始', msg.id);
    if (this.tsm.phase === PHASE.GAME_OVER) return this._sendErr(player.id, ERROR_CODE.GAME_ALREADY_OVER, '游戏已结束', msg.id);
    if (this.tsm.phase !== PHASE.ACTION && this.tsm.phase !== PHASE.PLANNING)
      return this._sendErr(player.id, ERROR_CODE.INVALID_PHASE, `当前阶段无法执行操作`, msg.id);
    if (!allowPlanning && this.tsm.phase === PHASE.PLANNING)
      return this._sendErr(player.id, ERROR_CODE.INVALID_PHASE, `规划阶段暂不可用`, msg.id);
    if (!this.tsm.isPlayerTurn(player.id))
      return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_TURN, '不是你的回合', msg.id);
    return false;
  }

  _assertMyTurn(player, msg) {
    if (!this.tsm || this.tsm.currentPlayerId !== player.id) {
      return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_TURN, '不是你的回合', msg.id);
    }
    return false;
  }

  _handleRequestMove(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const { shipId: sid, path } = msg.payload;
    const ship = this.ships.get(sid);
    if (!ship) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '舰艇不存在', msg.id);
    if (ship.ownerId !== player.id) return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_SHIP, '不是你的舰艇', msg.id);
    if (ship.isDestroyed) return this._sendErr(player.id, ERROR_CODE.INVALID_TARGET, '舰艇已损毁', msg.id);
    if (ship.hasAttackedThisTurn) return this._sendErr(player.id, ERROR_CODE.SHIP_ALREADY_ACTED, '该舰本轮已攻击，不可移动', msg.id);

    const movePoints = ship.baseMoveRange;
    const reachable = this.map.computeReachable(ship.coord, movePoints, ship.id);

    if (!Array.isArray(path) || path.length < 2) {
      return this._sendErr(player.id, ERROR_CODE.MISSING_FIELD, '路径无效', msg.id);
    }
    const pathCoords = path.map(p => Coord.of(p.x, p.y));
    const target = pathCoords[pathCoords.length - 1];
    const targetEntry = reachable.get(target.toKey());
    if (!targetEntry) {
      return this._sendErr(player.id, ERROR_CODE.PATH_BLOCKED, '目标不可达或超出移动范围', msg.id);
    }

    const reconstructed = this.map.reconstructPath(reachable, target);
    if (!reconstructed) return this._sendErr(player.id, ERROR_CODE.PATH_BLOCKED, '无法重算路径', msg.id);

    const firstDx = reconstructed[1].x - ship.coord.x;
    const firstDy = reconstructed[1].y - ship.coord.y;
    let facing = ship.facing;
    if (Math.abs(firstDx) >= Math.abs(firstDy)) facing = firstDx >= 0 ? 'E' : 'W';
    else facing = firstDy >= 0 ? 'S' : 'N';

    const apCost = this.tsm.getActionCost(ACTION_TYPE.MOVE);
    if (!this.tsm.canPerformAction(ACTION_TYPE.MOVE, ship.id))
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, `行动点不足(需${apCost})`, msg.id);

    const from = ship.coord.clone();
    if (!this.tsm.recordAction({
      type: ACTION_TYPE.MOVE, shipId: ship.id, from: { x: from.x, y: from.y }, to: { x: target.x, y: target.y }
    })) {
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点扣除失败，移动取消', msg.id);
    }
    this.map.moveOccupant(ship.coord, target, ship.id);
    ship.moveTo(target, facing);

    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'move', success: true, shipId: ship.id, apCost
    }, { replyTo: msg.id }));
    this._broadcast(MSG_TYPE.S2C.MOVE_RESULT, {
      shipId: ship.id, from: { x: from.x, y: from.y }, to: { x: target.x, y: target.y }, facing,
      path: reconstructed.map(c => ({ x: c.x, y: c.y })), playerId: player.id
    });
    this._broadcastState();
  }

  _handleRequestAttack(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const { shipId: sid, targetId } = msg.payload;
    const attacker = this.ships.get(sid);
    const target = this.ships.get(targetId);
    if (!attacker) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '攻击者不存在', msg.id);
    if (!target) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '目标不存在', msg.id);
    if (attacker.ownerId !== player.id) return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_SHIP, '不是你的舰艇', msg.id);
    if (target.ownerId === player.id) return this._sendErr(player.id, ERROR_CODE.INVALID_TARGET, '不能攻击自己的舰艇', msg.id);
    if (attacker.isDestroyed || target.isDestroyed) return this._sendErr(player.id, ERROR_CODE.INVALID_TARGET, '有舰艇已损毁', msg.id);
    if (attacker.hasAttackedThisTurn) return this._sendErr(player.id, ERROR_CODE.SHIP_ALREADY_ACTED, '该舰本轮已攻击', msg.id);

    const dist = this.map.manhattanDistance(attacker.coord, target.coord);
    if (dist < attacker.baseAttackMinRange || dist > attacker.baseAttackMaxRange)
      return this._sendErr(player.id, ERROR_CODE.OUT_OF_RANGE, `超出攻击范围(${dist}/${attacker.baseAttackMaxRange})`, msg.id);

    if (!this.tsm.canPerformAction(ACTION_TYPE.ATTACK, attacker.id))
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点不足', msg.id);

    const apCost = this.tsm.getActionCost(ACTION_TYPE.ATTACK);
    if (!this.tsm.recordAction({
      type: ACTION_TYPE.ATTACK, shipId: attacker.id, targetId: target.id
    })) {
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点扣除失败，攻击取消', msg.id);
    }
    attacker.hasAttackedThisTurn = true;

    const terrainDef = this.map.getDefenseBonus(target.coord);
    const damageResult = DamageCalculator.computeAttackDamage(attacker, target, {
      distance: dist,
      terrainDefenseBonus: terrainDef,
      attackerCoord: attacker.coord,
      attackerFacing: attacker.facing,
      targetCoord: target.coord
    });

    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'attack', success: true, shipId: attacker.id, apCost
    }, { replyTo: msg.id }));
    this._broadcast(MSG_TYPE.S2C.ATTACK_RESULT, {
      attackerId: attacker.id, targetId: target.id, damage: damageResult, playerId: player.id
    });

    if (damageResult.destroyed) {
      this.map.setOccupant(target.coord, null);
      this._broadcast(MSG_TYPE.S2C.SHIP_DESTROYED, { shipId: target.id, ownerId: target.ownerId });
      this._checkGameOver();
    }

    this._broadcastState();
  }

  _handleRequestRepair(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const { shipId: sid, hullAmount, armorAmount } = msg.payload;
    const ship = this.ships.get(sid);
    if (!ship) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '舰艇不存在', msg.id);
    if (ship.ownerId !== player.id) return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_SHIP, '不是你的舰艇', msg.id);
    if (ship.isDestroyed) return this._sendErr(player.id, ERROR_CODE.INVALID_TARGET, '舰艇已损毁', msg.id);
    if (!this.tsm.canPerformAction(ACTION_TYPE.REPAIR, ship.id))
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点不足', msg.id);

    if (!this.tsm.recordAction({ type: ACTION_TYPE.REPAIR, shipId: ship.id })) {
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点扣除失败，修复取消', msg.id);
    }
    const hull = (hullAmount | 0) || 15;
    const armor = (armorAmount | 0) || 8;
    const result = ship.repair(hull, armor);

    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'repair', success: true, shipId: ship.id
    }, { replyTo: msg.id }));
    this._broadcast(MSG_TYPE.S2C.REPAIR_RESULT, { shipId: ship.id, ...result, playerId: player.id });
    this._broadcastState();
  }

  _handleRequestShieldRegen(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const { shipId: sid, amount } = msg.payload;
    const ship = this.ships.get(sid);
    if (!ship) return this._sendErr(player.id, ERROR_CODE.SHIP_NOT_FOUND, '舰艇不存在', msg.id);
    if (ship.ownerId !== player.id) return this._sendErr(player.id, ERROR_CODE.NOT_YOUR_SHIP, '不是你的舰艇', msg.id);
    if (ship.isDestroyed) return this._sendErr(player.id, ERROR_CODE.INVALID_TARGET, '舰艇已损毁', msg.id);
    if (!this.tsm.canPerformAction(ACTION_TYPE.SHIELD_REGEN, ship.id))
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点不足', msg.id);

    if (!this.tsm.recordAction({ type: ACTION_TYPE.SHIELD_REGEN, shipId: ship.id })) {
      return this._sendErr(player.id, ERROR_CODE.NOT_ENOUGH_AP, '行动点扣除失败，护盾强化取消', msg.id);
    }
    const amt = amount !== undefined ? (amount | 0) : Math.round(ship.shieldRegenPerTurn * 2);
    const recovered = ship.regenShield(amt);

    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'shield_regen', success: true, shipId: ship.id
    }, { replyTo: msg.id }));
    this._broadcast(MSG_TYPE.S2C.SHIELD_REGEN_RESULT, { shipId: ship.id, recovered, playerId: player.id });
    this._broadcastState();
  }

  _handleUndo(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const last = this.tsm.actionsThisTurn[this.tsm.actionsThisTurn.length - 1];
    if (!last || last.playerId !== player.id)
      return this._sendErr(player.id, ERROR_CODE.CANNOT_UNDO, '无可撤销的操作', msg.id);
    if (last.type === ACTION_TYPE.MOVE) {
      const ship = this.ships.get(last.shipId);
      if (ship && !ship.isDestroyed) {
        this.map.moveOccupant(ship.coord, Coord.of(last.from.x, last.from.y), ship.id);
        ship.coord = Coord.of(last.from.x, last.from.y);
      }
    } else if (last.type === ACTION_TYPE.ATTACK || last.type === ACTION_TYPE.REPAIR || last.type === ACTION_TYPE.SHIELD_REGEN) {
      return this._sendErr(player.id, ERROR_CODE.CANNOT_UNDO, '该操作不可撤销', msg.id);
    }
    this.tsm.refundLastAction();
    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_UNDONE, { success: true }, { replyTo: msg.id }));
    this._broadcastState();
  }

  _handleEndTurn(player, msg) {
    const block = this._ensureGamePhase(player, msg); if (block) return block;
    const myTurnBlock = this._assertMyTurn(player, msg); if (myTurnBlock) return myTurnBlock;
    const r = this.tsm.endTurn();
    if (!r) return this._sendErr(player.id, ERROR_CODE.INVALID_PHASE, '无法结束回合', msg.id);
    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.ACTION_VALIDATED, {
      action: 'end_turn', success: true, nextPlayerId: r.nextPlayerId
    }, { replyTo: msg.id }));
    this._broadcastState();
  }

  _handleChat(player, msg) {
    const entry = {
      playerId: player.id,
      playerName: player.name,
      message: String(msg.payload.message || '').slice(0, 200),
      ts: Date.now()
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > 50) this.chatLog.shift();
    this._broadcast(MSG_TYPE.S2C.CHAT_BROADCAST, entry);
  }

  _handleSyncQuery(player, msg) {
    this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.STATE_SYNC, this._buildStateSnapshot(player.id), { replyTo: msg.id }));
  }

  _checkGameOver() {
    const livingByPlayer = {};
    for (const ship of this.ships.values()) {
      if (!ship.isDestroyed) {
        livingByPlayer[ship.ownerId] = (livingByPlayer[ship.ownerId] || 0) + 1;
      }
    }
    const aliveOwners = Object.keys(livingByPlayer);
    if (aliveOwners.length <= 1) {
      const winner = aliveOwners[0] || null;
      this.tsm.setGameOver(winner);
      this._broadcast(MSG_TYPE.S2C.GAME_OVER, { winner });
    }
  }

  _publicPlayerList() {
    return [...this.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color }));
  }

  _buildStateSnapshot(viewerId = null) {
    const apPools = {};
    if (this.tsm) {
      for (const [pid, pool] of this.tsm.apPools) apPools[pid] = pool.serialize();
    }
    return {
      roomId: this.id,
      roomName: this.name,
      players: this._publicPlayerList(),
      map: this.map.serialize(),
      ships: [...this.ships.values()].map(s => s.serialize()),
      tsm: this.tsm ? this.tsm.serialize() : null,
      apPools,
      selectedShipId: viewerId ? (this.selectedShips.get(viewerId) || null) : null,
      chatLog: this.chatLog.slice(-10)
    };
  }

  _broadcastState() {
    for (const player of this.players.values()) {
      if (player.conn && player.connected) {
        this._sendTo(player.id, this.codec.encode(MSG_TYPE.S2C.STATE_SYNC, this._buildStateSnapshot(player.id)));
      }
    }
  }

  _sendTo(playerId, raw) {
    const p = this.players.get(playerId);
    if (!p || !p.conn) return;
    try { if (p.conn.readyState === 1) p.conn.send(raw); } catch (e) {}
  }

  _sendErr(playerId, code, reason, replyTo = null) {
    this._sendTo(playerId, this.codec.makeError(code, reason, replyTo));
    return true;
  }

  _broadcast(type, payload, meta = {}) {
    const raw = this.codec.encode(type, payload, meta);
    for (const p of this.players.values()) {
      if (p.conn && p.connected) { try { if (p.conn.readyState === 1) p.conn.send(raw); } catch (e) {} }
    }
  }

  get isFull() { return this.players.size >= 2; }
  get playerCount() { return this.players.size; }
}

module.exports = { GameRoom, roomId, playerId, shipId };
