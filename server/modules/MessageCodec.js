'use strict';

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
    WEATHER_CHANGED: 's2c_weather_changed',
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

function deepFreeze(obj) {
  return obj;
}

const SCHEMAS = deepFreeze({
  [MSG_TYPE.C2S.HANDSHAKE]: {
    required: ['clientVersion'],
    optional: ['playerName']
  },
  [MSG_TYPE.C2S.JOIN_ROOM]: {
    required: ['roomId'],
    optional: ['password', 'playerName']
  },
  [MSG_TYPE.C2S.CREATE_ROOM]: {
    required: [],
    optional: ['roomName', 'password', 'playerName', 'mapConfig']
  },
  [MSG_TYPE.C2S.START_GAME]: {
    required: [],
    optional: ['firstPlayerId']
  },
  [MSG_TYPE.C2S.SELECT_SHIP]: {
    required: ['shipId'],
    optional: []
  },
  [MSG_TYPE.C2S.REQUEST_MOVE]: {
    required: ['shipId', 'path'],
    optional: []
  },
  [MSG_TYPE.C2S.REQUEST_ATTACK]: {
    required: ['shipId', 'targetId'],
    optional: []
  },
  [MSG_TYPE.C2S.REQUEST_REPAIR]: {
    required: ['shipId'],
    optional: ['hullAmount', 'armorAmount']
  },
  [MSG_TYPE.C2S.REQUEST_SHIELD_REGEN]: {
    required: ['shipId'],
    optional: ['amount']
  },
  [MSG_TYPE.C2S.UNDO_LAST_ACTION]: {
    required: [],
    optional: []
  },
  [MSG_TYPE.C2S.END_TURN]: {
    required: [],
    optional: []
  },
  [MSG_TYPE.C2S.CHAT]: {
    required: ['message'],
    optional: ['targetPlayerId']
  },
  [MSG_TYPE.C2S.PING]: { required: [], optional: ['timestamp'] },
  [MSG_TYPE.C2S.SYNC_QUERY]: { required: [], optional: ['scope'] }
});

function uuid() {
  return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function validateSchema(msg, schemas) {
  const errors = [];
  if (!schemas) return errors;
  for (const field of schemas.required || []) {
    if (msg.payload === undefined || msg.payload[field] === undefined) {
      errors.push(`缺少必填字段: ${field}`);
    }
  }
  return errors;
}

class MessageCodec {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false;
    this.includeTimestamps = options.includeTimestamps !== false;
    this._clientMsgNum = 0;
    this._serverMsgNum = 0;
  }

  encode(type, payload = {}, meta = {}) {
    const msg = {
      type,
      payload,
      id: meta.id || uuid(),
      seq: (typeof window !== 'undefined' ? ++this._clientMsgNum : ++this._serverMsgNum)
    };
    if (this.includeTimestamps) msg.ts = Date.now();
    if (meta.replyTo) msg.replyTo = meta.replyTo;
    if (meta.tag) msg.tag = meta.tag;
    return JSON.stringify(msg);
  }

  decode(raw) {
    if (typeof raw !== 'string') {
      throw this._makeError(ERROR_CODE.BAD_FORMAT, '消息不是字符串', null);
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      throw this._makeError(ERROR_CODE.BAD_FORMAT, 'JSON解析失败: ' + e.message, null);
    }
    if (!msg || typeof msg !== 'object' || !msg.type) {
      throw this._makeError(ERROR_CODE.UNKNOWN_TYPE, '缺少type字段', msg && msg.id);
    }
    if (this.strictMode) {
      const isC2S = Object.values(MSG_TYPE.C2S).includes(msg.type);
      const isS2C = Object.values(MSG_TYPE.S2C).includes(msg.type);
      if (!isC2S && !isS2C) {
        throw this._makeError(ERROR_CODE.UNKNOWN_TYPE, `未知消息类型: ${msg.type}`, msg.id);
      }
      const schema = SCHEMAS[msg.type];
      if (schema && msg.payload !== undefined) {
        const errs = validateSchema(msg, schema);
        if (errs.length > 0) {
          throw this._makeError(ERROR_CODE.MISSING_FIELD, errs.join('; '), msg.id);
        }
      }
    }
    if (msg.payload === undefined) msg.payload = {};
    return msg;
  }

  tryDecode(raw) {
    try {
      return { ok: true, message: this.decode(raw) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  makeError(code, reason, replyToId = null) {
    return this.encode(MSG_TYPE.S2C.ERROR, {
      code,
      reason,
      name: Object.keys(ERROR_CODE).find(k => ERROR_CODE[k] === code) || 'UNKNOWN'
    }, { replyTo: replyToId });
  }

  _makeError(code, reason, msgId) {
    const err = new Error(reason);
    err.code = code;
    err.codeName = Object.keys(ERROR_CODE).find(k => ERROR_CODE[k] === code) || 'UNKNOWN';
    err.msgId = msgId || null;
    return err;
  }

  buildC2S(type, payload = {}, meta = {}) {
    if (!Object.values(MSG_TYPE.C2S).includes(type)) {
      throw new Error(`不是C2S消息: ${type}`);
    }
    return this.encode(type, payload, meta);
  }

  buildS2C(type, payload = {}, meta = {}) {
    if (!Object.values(MSG_TYPE.S2C).includes(type)) {
      throw new Error(`不是S2C消息: ${type}`);
    }
    return this.encode(type, payload, meta);
  }
}

class MessageDispatcher {
  constructor() {
    this._handlers = new Map();
    this._defaultHandler = null;
    this._errorHandler = null;
    this._beforeHooks = [];
    this._afterHooks = [];
  }

  on(type, handler) {
    if (Array.isArray(type)) {
      for (const t of type) this.on(t, handler);
      return;
    }
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
  }

  off(type, handler) {
    const list = this._handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  onDefault(handler) { this._defaultHandler = handler; }
  onError(handler) { this._errorHandler = handler; }

  before(hook) { this._beforeHooks.push(hook); }
  after(hook) { this._afterHooks.push(hook); }

  dispatch(msg, context = {}) {
    for (const hook of this._beforeHooks) {
      try { hook(msg, context); } catch (e) { console.warn('beforeHook error:', e); }
    }
    let result = undefined;
    const handlers = this._handlers.get(msg.type);
    if (handlers && handlers.length > 0) {
      for (const h of handlers) {
        try {
          const r = h(msg, context);
          if (r !== undefined && result === undefined) result = r;
        } catch (e) {
          if (this._errorHandler) {
            try { this._errorHandler(e, msg, context); } catch (_) {}
          } else {
            console.error(`Handler error for ${msg.type}:`, e);
          }
        }
      }
    } else if (this._defaultHandler) {
      try { result = this._defaultHandler(msg, context); }
      catch (e) {
        if (this._errorHandler) this._errorHandler(e, msg, context);
        else console.error('Default handler error:', e);
      }
    }
    for (const hook of this._afterHooks) {
      try { hook(msg, context, result); } catch (e) { console.warn('afterHook error:', e); }
    }
    return result;
  }
}

module.exports = {
  MSG_TYPE,
  ERROR_CODE,
  SCHEMAS,
  MessageCodec,
  MessageDispatcher
};
