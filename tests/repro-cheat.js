'use strict';

const path = require('path');
const { GameRoom } = require(path.join(__dirname, '..', 'server', 'GameRoom'));
const { MessageCodec, MSG_TYPE } = require(path.join(__dirname, '..', 'server', 'modules', 'MessageCodec'));
const { Coord } = require(path.join(__dirname, '..', 'server', 'modules', 'MapCoordinate'));

function makeMockConn() {
  const sent = [];
  return {
    readyState: 1,
    _roomId: null,
    _playerId: null,
    send(raw) { sent.push(raw); },
    sent
  };
}

function decodeConn(conn) {
  return conn.sent.map(raw => JSON.parse(raw));
}

function findMsg(conn, type) {
  return decodeConn(conn).filter(m => m.type === type);
}

const codec = new MessageCodec({ strictMode: false });

let testNum = 0;
function run(name, fn) {
  testNum++;
  try { fn(); console.log(`  ✓ [#${testNum}] ${name}`); }
  catch (e) { console.log(`  ✗ [#${testNum}] ${name}\n      ${e.message}\n${e.stack && e.stack.split('\n').slice(1, 3).map(s => '      ' + s.trim()).join('\n')}`); }
}

console.log('\n=== 快速连点攻击漏洞回归测试 ===\n');

// ===== 测试1: 同一艘船连续攻击 =====
run('同一艘船在A回合内连续发起多次攻击请求', () => {
  const room = new GameRoom('R1', codec, null, null);
  const connA = makeMockConn();
  const connB = makeMockConn();
  const pa = room.addPlayer(connA, 'A');
  const pb = room.addPlayer(connB, 'B');
  if (!pa.ok || !pb.ok) throw new Error('加入失败');

  room.startGame();

  const shipsArr = [...room.ships.values()];
  const attacker = shipsArr.find(s => s.ownerId === pa.player.id && s.role === 'cruiser');
  const target = shipsArr.find(s => s.ownerId === pb.player.id && s.role === 'cruiser');

  room.map.setOccupant(attacker.coord, null);
  room.map.setOccupant(target.coord, null);
  attacker.coord = Coord.of(5, 5); attacker.facing = 'E';
  target.coord = Coord.of(6, 5); target.facing = 'W';
  room.map.setOccupant(attacker.coord, attacker.id);
  room.map.setOccupant(target.coord, target.id);

  const hullBefore = target.hull;
  const shieldBefore = target.shield;

  connA.sent.length = 0; connB.sent.length = 0;

  const attackMsg = (id) => ({
    type: MSG_TYPE.C2S.REQUEST_ATTACK,
    payload: { shipId: attacker.id, targetId: target.id },
    id, seq: 1, payload2: {}
  });

  // 模拟A在毫秒级内疯狂点击10次
  for (let i = 0; i < 10; i++) {
    room.handle(pa.player.id, attackMsg('atk-' + i));
  }

  const aValidated = findMsg(connA, MSG_TYPE.S2C.ACTION_VALIDATED).filter(m => m.payload.action === 'attack' && m.payload.success);
  const aErrors = findMsg(connA, MSG_TYPE.S2C.ERROR);
  const attackResults = findMsg(connB, MSG_TYPE.S2C.ATTACK_RESULT);
  const dmgApplied = attackResults.filter(m => m.payload.damage && m.payload.damage.hit);

  console.log(`    [数据] 成功验证: ${aValidated.length}, 错误响应: ${aErrors.length}, 命中广播: ${dmgApplied.length}`);
  console.log(`    [数据] 目标船体: ${hullBefore} -> ${target.hull} (减少 ${hullBefore - target.hull}), 护盾: ${shieldBefore} -> ${target.shield}`);
  console.log(`    [数据] 攻击者已攻击标记: ${attacker.hasAttackedThisTurn}, AP剩余: ${room.tsm.getPlayerAP(pa.player.id).remaining}`);

  if (aValidated.length !== 1) {
    throw new Error(`回归失败: 期望仅1次成功验证，实际 ${aValidated.length} 次`);
  }
  if (aErrors.length !== 9) {
    throw new Error(`回归失败: 期望9次拒绝错误，实际 ${aErrors.length} 次`);
  }
  if (dmgApplied.length > 1) {
    throw new Error(`回归失败: 命中广播 ${dmgApplied.length} 次，应最多1次`);
  }
  if (target.hull !== hullBefore) {
    throw new Error(`回归失败: 目标船体被扣 ${hullBefore - target.hull} 点`);
  }
  if (!attacker.hasAttackedThisTurn) {
    throw new Error('回归失败: 攻击者未标记 hasAttackedThisTurn');
  }
});

// ===== 测试2: A结束回合后，在B的回合内A尝试攻击 =====
run('A结束回合后(轮到B)，A继续发起攻击请求应被拒绝', () => {
  const room = new GameRoom('R2', codec, null, null);
  const connA = makeMockConn();
  const connB = makeMockConn();
  const pa = room.addPlayer(connA, 'A');
  const pb = room.addPlayer(connB, 'B');
  room.startGame();

  const shipsArr = [...room.ships.values()];
  const attacker = shipsArr.find(s => s.ownerId === pa.player.id);
  const target = shipsArr.find(s => s.ownerId === pb.player.id);

  room.map.setOccupant(attacker.coord, null);
  room.map.setOccupant(target.coord, null);
  attacker.coord = Coord.of(5, 5); attacker.facing = 'E';
  target.coord = Coord.of(6, 5); target.facing = 'W';
  room.map.setOccupant(attacker.coord, attacker.id);
  room.map.setOccupant(target.coord, target.id);

  const hullBefore = target.hull;
  const shieldBefore = target.shield;
  connA.sent.length = 0;

  // A结束回合
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.END_TURN, payload: {}, id: 'end1', seq: 1
  });

  // 现在应该是B的回合，A继续点攻击
  for (let i = 0; i < 10; i++) {
    room.handle(pa.player.id, {
      type: MSG_TYPE.C2S.REQUEST_ATTACK,
      payload: { shipId: attacker.id, targetId: target.id },
      id: 'cheat-' + i, seq: 1
    });
  }

  const notYourTurnErrs = findMsg(connA, MSG_TYPE.S2C.ERROR).filter(m => m.payload.code === 3001);
  const attackResults = findMsg(connB, MSG_TYPE.S2C.ATTACK_RESULT);

  console.log(`    [数据] "不是你的回合"错误数: ${notYourTurnErrs.length}, 命中广播: ${attackResults.length}`);
  console.log(`    [数据] 目标船体: ${hullBefore} -> ${target.hull}, 护盾: ${shieldBefore} -> ${target.shield}`);

  if (notYourTurnErrs.length !== 10) {
    throw new Error(`回归失败: 期望10次"不是你的回合"错误，实际 ${notYourTurnErrs.length} 次`);
  }
  if (attackResults.length > 0) {
    throw new Error(`回归失败: B不应收到攻击广播，实际收到 ${attackResults.length} 条`);
  }
  if (target.hull !== hullBefore) {
    throw new Error(`回归失败: 目标船体被扣 ${hullBefore - target.hull} 点`);
  }
  if (target.shield !== shieldBefore) {
    throw new Error(`回归失败: 目标护盾被扣 ${shieldBefore - target.shield} 点`);
  }
});

// ===== 测试3: A在攻击模式中，不结束回合，连续攻击不同目标 =====
run('A在单回合内用AP耗尽前对不同目标攻击(验证已行动限制)', () => {
  const room = new GameRoom('R3', codec, null, null);
  const connA = makeMockConn();
  const connB = makeMockConn();
  const pa = room.addPlayer(connA, 'A');
  const pb = room.addPlayer(connB, 'B');
  room.startGame();

  const shipsArr = [...room.ships.values()];
  const myShips = shipsArr.filter(s => s.ownerId === pa.player.id);
  const enemyShips = shipsArr.filter(s => s.ownerId === pb.player.id);

  // 把A的一艘船放到能打到B多艘船的位置
  const attacker = myShips[0];
  room.map.setOccupant(attacker.coord, null);
  attacker.coord = Coord.of(5, 5); attacker.facing = 'E';
  room.map.setOccupant(attacker.coord, attacker.id);

  enemyShips.forEach((t, i) => {
    room.map.setOccupant(t.coord, null);
    t.coord = Coord.of(6, 4 + i); t.facing = 'W';
    room.map.setOccupant(t.coord, t.id);
  });

  connA.sent.length = 0;
  const apBefore = room.tsm.getPlayerAP(pa.player.id).remaining;
  console.log(`    [数据] A的AP: ${apBefore}, 攻击消耗: 3, 理论最大攻击次数: ${Math.floor(apBefore / 3)}`);

  // A用同一艘船尝试攻击多个目标
  for (const t of enemyShips) {
    room.handle(pa.player.id, {
      type: MSG_TYPE.C2S.REQUEST_ATTACK,
      payload: { shipId: attacker.id, targetId: t.id },
      id: 'multi-' + t.id, seq: 1
    });
  }
  const successCount = findMsg(connA, MSG_TYPE.S2C.ACTION_VALIDATED).filter(m => m.payload.action === 'attack' && m.payload.success).length;
  const apAfter = room.tsm.getPlayerAP(pa.player.id).remaining;
  console.log(`    [数据] 同一艘船对${enemyShips.length}个目标攻击，成功数: ${successCount}, AP剩余: ${apAfter}`);

  if (successCount !== 1) {
    throw new Error(`回归失败: 期望仅1次成功，实际 ${successCount} 次 (actedShips 限制未生效)`);
  }
  if (apAfter !== apBefore - 3) {
    throw new Error(`回归失败: AP扣除异常，期望 ${apBefore - 3}，实际 ${apAfter}`);
  }
});

// ===== 测试4: A在B回合内尝试移动/修复/护盾/撤销/结束回合，均应被拒 =====
run('A在B的回合内发起移动/修复/护盾/撤销/结束回合请求均应被拒绝', () => {
  const room = new GameRoom('R4', codec, null, null);
  const connA = makeMockConn();
  const connB = makeMockConn();
  const pa = room.addPlayer(connA, 'A');
  const pb = room.addPlayer(connB, 'B');
  room.startGame();

  const shipsArr = [...room.ships.values()];
  const attacker = shipsArr.find(s => s.ownerId === pa.player.id);

  const hullBefore = attacker.hull;
  const shieldBefore = attacker.shield;
  connA.sent.length = 0;

  // A结束回合，轮到B
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.END_TURN, payload: {}, id: 'end1', seq: 1
  });

  // A在B回合内尝试各种操作
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.REQUEST_REPAIR,
    payload: { shipId: attacker.id, hullAmount: 18, armorAmount: 10 },
    id: 'r1', seq: 1
  });
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.REQUEST_SHIELD_REGEN,
    payload: { shipId: attacker.id },
    id: 's1', seq: 1
  });
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.UNDO_LAST_ACTION, payload: {}, id: 'u1', seq: 1
  });
  room.handle(pa.player.id, {
    type: MSG_TYPE.C2S.END_TURN, payload: {}, id: 'e1', seq: 1
  });

  const errs = findMsg(connA, MSG_TYPE.S2C.ERROR).filter(m => m.payload.code === 3001);
  console.log(`    [数据] 船体: ${hullBefore} -> ${attacker.hull}, 护盾: ${shieldBefore} -> ${attacker.shield}`);
  console.log(`    [数据] "不是你的回合"错误数: ${errs.length}/4`);

  if (errs.length !== 4) {
    throw new Error(`回归失败: 期望4次拒绝，实际 ${errs.length} 次`);
  }
  if (attacker.hull !== hullBefore || attacker.shield !== shieldBefore) {
    throw new Error('回归失败: A在B回合内居然修改了自己的舰艇状态');
  }
});

console.log('\n=== 回归测试结束 ===\n');
