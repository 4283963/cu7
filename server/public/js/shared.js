'use strict';

(function (global) {
  const MSG_TYPE = Object.freeze({
    C2S: Object.freeze({
      HANDSHAKE: 'c2s_handshake',
      JOIN_ROOM: 'c2s_join_room',
      CREATE_ROOM: 'c2s_create_room',
      START_GAME: 'c2s_start_game',
      SELECT_SHIP: 'c2s_select_ship',
      REQUEST_MOVE: 'c2s_request_move',
      REQUEST_ATTACK: 'c2s_request_attack',
      REQUEST_REPAIR: 'c2s_request_repair',
      REQUEST_SHIELD_REGEN: 'c2s_request_shield_regen',
      UNDO_LAST_ACTION: 'c2s_undo_last_action',
      END_TURN: 'c2s_end_turn',
      CHAT: 'c2s_chat',
      PING: 'c2s_ping',
      SYNC_QUERY: 'c2s_sync_query'
    }),
    S2C: Object.freeze({
      HANDSHAKE_ACK: 's2c_handshake_ack',
      ROOM_CREATED: 's2c_room_created',
      ROOM_JOINED: 's2c_room_joined',
      ROOM_STATE: 's2c_room_state',
      GAME_STARTED: 's2c_game_started',
      TURN_START: 's2c_turn_start',
      TURN_END: 's2c_turn_end',
      PHASE_CHANGE: 's2c_phase_change',
      ACTION_VALIDATED: 's2c_action_validated',
      ACTION_REJECTED: 's2c_action_rejected',
      ACTION_APPLIED: 's2c_action_applied',
      MOVE_RESULT: 's2c_move_result',
      ATTACK_RESULT: 's2c_attack_result',
      REPAIR_RESULT: 's2c_repair_result',
      SHIELD_REGEN_RESULT: 's2c_shield_regen_result',
      SHIP_DESTROYED: 's2c_ship_destroyed',
      ACTION_UNDONE: 's2c_action_undone',
      GAME_OVER: 's2c_game_over',
      CHAT_BROADCAST: 's2c_chat_broadcast',
      PONG: 's2c_pong',
      STATE_SYNC: 's2c_state_sync',
      ERROR: 's2c_error'
    })
  });

  const ERROR_CODE = Object.freeze({
    BAD_FORMAT: 1001,
    UNKNOWN_TYPE: 1002,
    MISSING_FIELD: 1003,
    INVALID_ROOM: 2001,
    ROOM_FULL: 2002,
    NOT_IN_ROOM: 2003,
    NOT_YOUR_TURN: 3001,
    INVALID_PHASE: 3002,
    NOT_ENOUGH_AP: 3003,
    SHIP_NOT_FOUND: 3004,
    NOT_YOUR_SHIP: 3005,
    INVALID_TARGET: 3006,
    OUT_OF_RANGE: 3007,
    PATH_BLOCKED: 3008,
    CANNOT_UNDO: 3009,
    SHIP_ALREADY_ACTED: 3010,
    GAME_NOT_STARTED: 3011,
    GAME_ALREADY_OVER: 3012,
    INTERNAL: 5000
  });

  const TERRAIN = Object.freeze({
    PLAIN: 'plain',
    MOUNTAIN: 'mountain',
    WATER: 'water',
    FOREST: 'forest',
    WRECK: 'wreck'
  });

  const TERRAIN_STYLE = Object.freeze({
    plain:    { name: '平原', fill: '#8fbc8f', grid: '#6b8e6b', cost: 1 },
    mountain: { name: '山脉', fill: '#8a795d', grid: '#5a4d3a', cost: Infinity },
    water:    { name: '水域', fill: '#5b9bd5', grid: '#3a6fa8', cost: Infinity },
    forest:   { name: '森林', fill: '#3f704d', grid: '#2a4d35', cost: 2 },
    wreck:    { name: '残骸', fill: '#a0826d', grid: '#6e5747', cost: 3 }
  });

  const PHASE = Object.freeze({
    WAITING: 'waiting',
    PLANNING: 'planning',
    ACTION: 'action',
    RESOLUTION: 'resolution',
    TURN_END: 'turn_end',
    GAME_OVER: 'game_over'
  });

  const SHIP_ROLE = Object.freeze({
    IRONCLAD: 'ironclad',
    CRUISER: 'cruiser',
    SCOUT: 'scout',
    BOMBARD: 'bombard'
  });

  const SHIP_STYLE = Object.freeze({
    ironclad: { name: '铁甲舰', shape: 'battleship', color: '#64748b', stroke: '#334155' },
    cruiser:  { name: '巡洋舰', shape: 'cruiser',    color: '#9ca3af', stroke: '#4b5563' },
    scout:    { name: '侦察舰', shape: 'scout',      color: '#eab308', stroke: '#854d0e' },
    bombard:  { name: '轰击舰', shape: 'bombard',    color: '#a16207', stroke: '#713f12' }
  });

  function uuid() {
    return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  class MessageCodec {
    constructor(options = {}) {
      this.includeTimestamps = options.includeTimestamps !== false;
      this._clientMsgNum = 0;
    }
    encode(type, payload, meta = {}) {
      const msg = {
        type,
        payload: payload || {},
        id: meta.id || uuid(),
        seq: ++this._clientMsgNum
      };
      if (this.includeTimestamps) msg.ts = Date.now();
      if (meta.replyTo) msg.replyTo = meta.replyTo;
      if (meta.tag) msg.tag = meta.tag;
      return JSON.stringify(msg);
    }
    decode(raw) {
      const msg = JSON.parse(raw);
      if (!msg || !msg.type) throw new Error('Invalid message: missing type');
      if (!msg.payload) msg.payload = {};
      return msg;
    }
    buildC2S(type, payload, meta = {}) {
      return this.encode(type, payload, meta);
    }
  }

  class GameClient {
    constructor() {
      this.ws = null;
      this.codec = new MessageCodec();
      this.state = null;
      this.me = null;
      this.selectedShipId = null;
      this.selectedMode = 'select';
      this.hoverCoord = null;
      this.plannedPath = [];
      this.attackTargets = new Set();
      this.listeners = {};
      this.pendingPings = new Map();
      this.lastPingLatency = null;
    }

    on(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    }
    _emit(evt, data) {
      (this.listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
    }

    connect(url) {
      return new Promise((resolve, reject) => {
        try {
          this.ws = new WebSocket(url);
        } catch (e) { return reject(e); }
        this.ws.addEventListener('open', () => {
          this.sendC2S(MSG_TYPE.C2S.HANDSHAKE, { clientVersion: '0.1.0' }).then(() => resolve(this));
        });
        this.ws.addEventListener('error', reject);
        this.ws.addEventListener('message', (ev) => {
          try {
            const msg = this.codec.decode(ev.data);
            this._handleMessage(msg);
          } catch (e) {
            console.error('Decode error:', e, ev.data);
          }
        });
        this.ws.addEventListener('close', () => this._emit('disconnected'));
      });
    }

    _handleMessage(msg) {
      switch (msg.type) {
        case MSG_TYPE.S2C.HANDSHAKE_ACK:
          this._resolveSend(msg.replyTo, msg);
          break;
        case MSG_TYPE.S2C.ROOM_CREATED:
        case MSG_TYPE.S2C.ROOM_JOINED:
          this.me = {
            playerId: msg.payload.playerId,
            playerName: msg.payload.playerName,
            color: msg.payload.color,
            roomId: msg.payload.roomId,
            roomName: msg.payload.roomName
          };
          this._resolveSend(msg.replyTo, msg);
          this._emit('room_joined', msg.payload);
          break;
        case MSG_TYPE.S2C.ROOM_STATE:
          this._emit('room_state', msg.payload);
          break;
        case MSG_TYPE.S2C.GAME_STARTED:
          this._emit('game_started', msg.payload);
          break;
        case MSG_TYPE.S2C.TURN_START:
          this._emit('turn_start', msg.payload);
          break;
        case MSG_TYPE.S2C.TURN_END:
          this._emit('turn_end', msg.payload);
          break;
        case MSG_TYPE.S2C.PHASE_CHANGE:
          this._emit('phase_change', msg.payload);
          break;
        case MSG_TYPE.S2C.ACTION_VALIDATED:
          this._resolveSend(msg.replyTo, msg);
          break;
        case MSG_TYPE.S2C.MOVE_RESULT:
          this._emit('move_result', msg.payload);
          break;
        case MSG_TYPE.S2C.ATTACK_RESULT:
          this._emit('attack_result', msg.payload);
          break;
        case MSG_TYPE.S2C.REPAIR_RESULT:
          this._emit('repair_result', msg.payload);
          break;
        case MSG_TYPE.S2C.SHIELD_REGEN_RESULT:
          this._emit('shield_regen_result', msg.payload);
          break;
        case MSG_TYPE.S2C.SHIP_DESTROYED:
          this._emit('ship_destroyed', msg.payload);
          break;
        case MSG_TYPE.S2C.ACTION_UNDONE:
          this._resolveSend(msg.replyTo, msg);
          break;
        case MSG_TYPE.S2C.GAME_OVER:
          this._emit('game_over', msg.payload);
          break;
        case MSG_TYPE.S2C.STATE_SYNC:
          this.state = msg.payload;
          if (this.state.selectedShipId) this.selectedShipId = this.state.selectedShipId;
          this._emit('state_sync', this.state);
          break;
        case MSG_TYPE.S2C.CHAT_BROADCAST:
          this._emit('chat', msg.payload);
          break;
        case MSG_TYPE.S2C.PONG:
          const ts = this.pendingPings.get(msg.replyTo);
          if (ts !== undefined) {
            this.lastPingLatency = Date.now() - ts;
            this.pendingPings.delete(msg.replyTo);
            this._emit('latency', this.lastPingLatency);
          }
          break;
        case MSG_TYPE.S2C.ERROR:
          console.warn('Server error:', msg.payload);
          this._rejectSend(msg.replyTo, msg.payload);
          this._emit('server_error', msg.payload);
          break;
        default:
          console.warn('Unhandled message:', msg);
      }
    }

    sendC2S(type, payload, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) {
          return reject(new Error('WebSocket not connected'));
        }
        const msg = this.codec.encode(type, payload || {});
        const parsed = JSON.parse(msg);
        const id = parsed.id;
        const timer = setTimeout(() => {
          delete this._pendingResolve[id];
          delete this._pendingReject[id];
          reject(new Error('Request timeout'));
        }, timeoutMs);
        this._pendingResolve = this._pendingResolve || {};
        this._pendingReject = this._pendingReject || {};
        this._pendingResolve[id] = (m) => { clearTimeout(timer); resolve(m); };
        this._pendingReject[id] = (e) => { clearTimeout(timer); reject(e); };
        this.ws.send(msg);
      });
    }
    _resolveSend(id, m) {
      if (id && this._pendingResolve && this._pendingResolve[id]) {
        this._pendingResolve[id](m);
        delete this._pendingResolve[id];
        delete this._pendingReject[id];
      }
    }
    _rejectSend(id, e) {
      if (id && this._pendingReject && this._pendingReject[id]) {
        this._pendingReject[id](e);
        delete this._pendingResolve[id];
        delete this._pendingReject[id];
      }
    }

    sendRaw(type, payload) {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(this.codec.encode(type, payload));
      }
    }

    createRoom(playerName) { return this.sendC2S(MSG_TYPE.C2S.CREATE_ROOM, { playerName }); }
    joinRoom(roomId, playerName) { return this.sendC2S(MSG_TYPE.C2S.JOIN_ROOM, { roomId, playerName }); }
    startGame() { return this.sendC2S(MSG_TYPE.C2S.START_GAME); }
    selectShip(shipId) { return this.sendC2S(MSG_TYPE.C2S.SELECT_SHIP, { shipId }).then(r => { this.selectedShipId = shipId; return r; }); }
    move(shipId, path) { return this.sendC2S(MSG_TYPE.C2S.REQUEST_MOVE, { shipId, path }); }
    attack(shipId, targetId) { return this.sendC2S(MSG_TYPE.C2S.REQUEST_ATTACK, { shipId, targetId }); }
    repair(shipId, hullAmount, armorAmount) { return this.sendC2S(MSG_TYPE.C2S.REQUEST_REPAIR, { shipId, hullAmount, armorAmount }); }
    shieldRegen(shipId, amount) { return this.sendC2S(MSG_TYPE.C2S.REQUEST_SHIELD_REGEN, { shipId, amount }); }
    undo() { return this.sendC2S(MSG_TYPE.C2S.UNDO_LAST_ACTION); }
    endTurn() { return this.sendC2S(MSG_TYPE.C2S.END_TURN); }
    chat(message, targetPlayerId) { this.sendRaw(MSG_TYPE.C2S.CHAT, { message, targetPlayerId }); }
    sync() { this.sendRaw(MSG_TYPE.C2S.SYNC_QUERY); }
    ping() {
      if (this.ws && this.ws.readyState === 1) {
        const msg = this.codec.encode(MSG_TYPE.C2S.PING, { timestamp: Date.now() });
        const id = JSON.parse(msg).id;
        this.pendingPings.set(id, Date.now());
        this.ws.send(msg);
      }
    }

    get isMyTurn() {
      return !!(this.state && this.me && this.state.tsm &&
        this.state.players[this.state.tsm.currentPlayerIndex].id === this.me.playerId);
    }
    get currentPlayer() {
      if (!this.state || !this.state.tsm) return null;
      return this.state.players[this.state.tsm.currentPlayerIndex];
    }
    getShip(id) { return (this.state && this.state.ships) ? this.state.ships.find(s => s.id === id) : null; }
    getMyShips() {
      if (!this.state || !this.me) return [];
      return this.state.ships.filter(s => s.ownerId === this.me.playerId);
    }
    getEnemyShips() {
      if (!this.state || !this.me) return [];
      return this.state.ships.filter(s => s.ownerId !== this.me.playerId && !s.isDestroyed);
    }
  }

  function manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  function buildCoordKey(x, y) { return `${x},${y}`; }

  function computeReachableClient(map, start, maxCost, selfShipId = null) {
    const { width, height, terrains = {}, occupied = {} } = map;
    const result = new Map();
    const startKey = buildCoordKey(start.x, start.y);
    result.set(startKey, { x: start.x, y: start.y, cost: 0, prev: null });
    const frontier = [{ x: start.x, y: start.y, cost: 0 }];
    const costFor = (t) => ({ plain: 1, forest: 2, wreck: 3, mountain: Infinity, water: Infinity }[t] || 1);
    const isBlocked = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return true;
      const t = terrains[buildCoordKey(x, y)] || 'plain';
      return !isFinite(costFor(t));
    };
    while (frontier.length) {
      frontier.sort((a, b) => a.cost - b.cost);
      const cur = frontier.shift();
      if (cur.cost > maxCost) continue;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (isBlocked(nx, ny)) continue;
        const k = buildCoordKey(nx, ny);
        const occ = occupied[k];
        if (occ && occ !== selfShipId) continue;
        const step = costFor(terrains[k] || 'plain');
        const nc = cur.cost + step;
        if (nc > maxCost) continue;
        const ex = result.get(k);
        if (!ex || nc < ex.cost) {
          result.set(k, { x: nx, y: ny, cost: nc, prev: { x: cur.x, y: cur.y } });
          frontier.push({ x: nx, y: ny, cost: nc });
        }
      }
    }
    result.delete(startKey);
    return result;
  }

  function reconstructPath(reachable, target) {
    const path = [];
    let cur = reachable.get(buildCoordKey(target.x, target.y));
    if (!cur) return null;
    while (cur) {
      path.unshift({ x: cur.x, y: cur.y });
      cur = cur.prev ? reachable.get(buildCoordKey(cur.prev.x, cur.prev.y)) : null;
    }
    return path;
  }

  global.SteamShip = {
    MSG_TYPE, ERROR_CODE, TERRAIN, TERRAIN_STYLE, PHASE, SHIP_ROLE, SHIP_STYLE,
    MessageCodec, GameClient,
    manhattan, buildCoordKey, computeReachableClient, reconstructPath
  };
})(window);
