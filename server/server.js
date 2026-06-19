'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { GameRoom, roomId } = require('./GameRoom');
const { MessageCodec, MessageDispatcher, MSG_TYPE, ERROR_CODE } = require('./modules/MessageCodec');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const codec = new MessageCodec({ strictMode: true });
const dispatcher = new MessageDispatcher();
const rooms = new Map();

function staticFile(req, res) {
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  if (urlPath.includes('..')) { res.writeHead(403); return res.end('Forbidden'); }
  const filePath = path.join(PUBLIC_DIR, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function createOrJoinRoom(conn, payload) {
  let r = null;
  for (const room of rooms.values()) { if (!room.isFull) { r = room; break; } }
  if (!r) {
    const id = roomId();
    r = new GameRoom(id, codec, dispatcher, null);
    if (payload.roomName) r.name = payload.roomName;
    rooms.set(id, r);
    console.log(`[Server] 房间创建: ${id}`);
  }
  const added = r.addPlayer(conn, payload.playerName);
  return { room: r, added };
}

function onClientMessage(conn, rawData) {
  const decoded = codec.tryDecode(rawData);
  if (!decoded.ok) {
    try {
      if (conn.readyState === 1) conn.send(codec.makeError(decoded.error.code || ERROR_CODE.BAD_FORMAT, decoded.error.message));
    } catch (_) {}
    return;
  }
  const msg = decoded.message;

  if (msg.type === MSG_TYPE.C2S.HANDSHAKE) {
    try {
      if (conn.readyState === 1) conn.send(codec.encode(MSG_TYPE.S2C.HANDSHAKE_ACK, {
        serverVersion: '0.1.0',
        serverTime: Date.now(),
        supported: Object.values(MSG_TYPE.C2S)
      }, { replyTo: msg.id }));
    } catch (_) {}
    return;
  }

  if (msg.type === MSG_TYPE.C2S.CREATE_ROOM || msg.type === MSG_TYPE.C2S.JOIN_ROOM) {
    const { room, added } = (msg.type === MSG_TYPE.C2S.CREATE_ROOM)
      ? (() => {
          const id = roomId();
          const r = new GameRoom(id, codec, dispatcher, null);
          if (msg.payload.roomName) r.name = msg.payload.roomName;
          rooms.set(id, r);
          const a = r.addPlayer(conn, msg.payload.playerName);
          return { room: r, added: a };
        })()
      : createOrJoinRoom(conn, msg.payload);

    if (!added.ok) {
      try {
        if (conn.readyState === 1) conn.send(codec.makeError(added.code, msg.type === MSG_TYPE.C2S.CREATE_ROOM ? '创建失败' : '加入失败', msg.id));
      } catch (_) {}
      return;
    }

    const ackType = msg.type === MSG_TYPE.C2S.CREATE_ROOM ? MSG_TYPE.S2C.ROOM_CREATED : MSG_TYPE.S2C.ROOM_JOINED;
    try {
      if (conn.readyState === 1) conn.send(codec.encode(ackType, {
        roomId: room.id, roomName: room.name, playerId: added.player.id, playerName: added.player.name, color: added.player.color, players: room._publicPlayerList()
      }, { replyTo: msg.id }));
    } catch (_) {}
    if (room.isFull) {
      setTimeout(() => room._broadcast(MSG_TYPE.S2C.ROOM_STATE, {
        roomId: room.id, roomName: room.name, players: room._publicPlayerList(), canStart: true
      }), 150);
    }
    return;
  }

  const roomId = conn._roomId;
  if (!roomId || !rooms.has(roomId)) {
    try {
      if (conn.readyState === 1) conn.send(codec.makeError(ERROR_CODE.NOT_IN_ROOM, '尚未加入房间', msg.id));
    } catch (_) {}
    return;
  }

  const room = rooms.get(roomId);
  room.handle(conn._playerId, msg);
}

function onClientClose(conn) {
  const rid = conn._roomId;
  const pid = conn._playerId;
  if (rid && rooms.has(rid)) {
    const r = rooms.get(rid);
    r.removePlayer(pid);
    console.log(`[Server] ${pid} 离开房间 ${rid}`);
    r._broadcast(MSG_TYPE.S2C.ROOM_STATE, { players: r._publicPlayerList() });
    if (r.playerCount === 0) {
      rooms.delete(rid);
      console.log(`[Server] 销毁空房间: ${rid}`);
    }
  }
}

const server = http.createServer(staticFile);
const wss = new WebSocketServer({ server });

wss.on('connection', (conn) => {
  conn._roomId = null;
  conn._playerId = null;
  console.log(`[Server] 新连接`);
  conn.on('message', (data) => onClientMessage(conn, data.toString()));
  conn.on('close', () => onClientClose(conn));
  conn.on('error', (e) => console.warn('[Server] WS error:', e));
});

server.listen(PORT, () => {
  console.log(`[Server] HTTP+WS on http://localhost:${PORT}`);
  console.log(`[Server] 打开浏览器访问 http://localhost:${PORT} 开始游戏`);
});

process.on('SIGINT', () => { console.log('\n[Server] 关闭...'); process.exit(0); });
