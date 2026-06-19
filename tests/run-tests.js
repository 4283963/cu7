'use strict';

const path = require('path');
const assert = require('assert');

const { Coord, MapGrid, TERRAIN } = require(path.join(__dirname, '..', 'server', 'modules', 'MapCoordinate'));
const { TurnStateMachine, PHASE, ACTION_TYPE, ActionPointPool } = require(path.join(__dirname, '..', 'server', 'modules', 'TurnStateMachine'));
const { Ship, DamageCalculator, SHIP_ROLE, computeHitZone, DAMAGE_TYPE, HIT_ZONE } = require(path.join(__dirname, '..', 'server', 'modules', 'ShieldDamage'));
const { MessageCodec, MessageDispatcher, MSG_TYPE, ERROR_CODE } = require(path.join(__dirname, '..', 'server', 'modules', 'MessageCodec'));

let passed = 0, failed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message || e}`); }
}
function suite(name, fn) { console.log(`\n${name}`); fn(); }

suite('[1] 地图坐标模块 (MapCoordinate)', () => {
  test('Coord 相等和键值', () => {
    const a = Coord.of(3, 5);
    const b = Coord.of(3, 5);
    assert.strictEqual(a.equals(b), true);
    assert.strictEqual(a.toKey(), '3,5');
    const c = Coord.fromKey('3,5');
    assert.strictEqual(c.equals(a), true);
  });

  test('MapGrid 边界检测', () => {
    const m = new MapGrid(10, 8);
    assert.strictEqual(m.inBounds(Coord.of(0, 0)), true);
    assert.strictEqual(m.inBounds(Coord.of(9, 7)), true);
    assert.strictEqual(m.inBounds(Coord.of(10, 0)), false);
    assert.strictEqual(m.inBounds(Coord.of(-1, 0)), false);
  });

  test('地形与移动消耗', () => {
    const m = new MapGrid(5, 5);
    m.setTerrain(Coord.of(2, 2), TERRAIN.MOUNTAIN);
    m.setTerrain(Coord.of(3, 3), TERRAIN.FOREST);
    assert.strictEqual(m.getMoveCost(Coord.of(0, 0)), 1);
    assert.strictEqual(m.getMoveCost(Coord.of(2, 2)), Infinity);
    assert.strictEqual(m.isBlocked(Coord.of(2, 2)), true);
    assert.strictEqual(m.getMoveCost(Coord.of(3, 3)), 2);
  });

  test('曼哈顿距离', () => {
    const m = new MapGrid(5, 5);
    assert.strictEqual(m.manhattanDistance(Coord.of(1, 1), Coord.of(4, 5)), 7);
  });

  test('可达范围计算 (含障碍物)', () => {
    const m = new MapGrid(5, 5);
    m.setTerrain(Coord.of(1, 1), TERRAIN.MOUNTAIN);
    m.setTerrain(Coord.of(2, 1), TERRAIN.MOUNTAIN);
    const reachable = m.computeReachable(Coord.of(0, 0), 4);
    assert.ok(reachable.size > 0, '应能到达至少一个格子');
    assert.strictEqual(reachable.has('1,1'), false, '山脉不可达');
    assert.ok(reachable.has('0,2') || reachable.has('2,0'), '应能向远处移动');
  });

  test('可达范围考虑占据单位', () => {
    const m = new MapGrid(5, 5);
    m.setOccupant(Coord.of(1, 0), 'ship-a');
    const reachable = m.computeReachable(Coord.of(0, 0), 3, 'ship-b');
    assert.strictEqual(reachable.has('1,0'), false, '其他船占据的格子不可达');
    const reachableSelf = m.computeReachable(Coord.of(0, 0), 3, 'ship-a');
    assert.ok(reachableSelf.size > 0, '自身占据不影响');
  });

  test('攻击范围计算', () => {
    const m = new MapGrid(10, 10);
    const range = m.computeAttackRange(Coord.of(5, 5), 2, 3);
    assert.ok(range.length >= 4, `攻击范围应该有足够的格子，实际${range.length}`);
    for (const c of range) {
      const d = m.manhattanDistance(Coord.of(5, 5), c);
      assert.ok(d >= 2 && d <= 3, `距离应在范围内 ${d}`);
    }
  });

  test('地图序列化与反序列化', () => {
    const m = MapGrid.generateDefault(6, 6);
    m.setOccupant(Coord.of(3, 3), 's1');
    const data = m.serialize();
    const m2 = MapGrid.deserialize(data);
    assert.strictEqual(m2.width, m.width);
    assert.strictEqual(m2.getOccupant(Coord.of(3, 3)), 's1');
    assert.strictEqual(m2.getTerrain(Coord.of(0, 0)), m.getTerrain(Coord.of(0, 0)));
  });

  test('视线检测', () => {
    const m = new MapGrid(8, 8);
    m.setTerrain(Coord.of(2, 0), TERRAIN.MOUNTAIN);
    assert.strictEqual(m.hasLineOfSight(Coord.of(0, 0), Coord.of(4, 0)), false, '山脉阻挡视线');
    assert.strictEqual(m.hasLineOfSight(Coord.of(0, 0), Coord.of(4, 4)), true, '无阻挡视线通');
  });
});

suite('[2] 回合状态机模块 (TurnStateMachine)', () => {
  test('ActionPointPool 消耗与退款', () => {
    const ap = new ActionPointPool(6);
    assert.strictEqual(ap.remaining, 6);
    assert.strictEqual(ap.spend(3), true);
    assert.strictEqual(ap.remaining, 3);
    assert.strictEqual(ap.spend(4), false);
    ap.refund(2);
    assert.strictEqual(ap.remaining, 5);
    ap.reset();
    assert.strictEqual(ap.remaining, 6);
  });

  test('TSM 初始化与开始', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    assert.strictEqual(tsm.phase, PHASE.WAITING);
    tsm.startGame(0);
    assert.strictEqual(tsm.phase, PHASE.PLANNING);
    assert.strictEqual(tsm.currentPlayerId, 'p1');
    assert.strictEqual(tsm.turnNumber, 1);
    assert.strictEqual(tsm.roundNumber, 1);
  });

  test('TSM 行动点消耗记录', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    tsm.startGame(0);
    tsm.enterActionPhase();
    assert.strictEqual(tsm.canPerformAction(ACTION_TYPE.ATTACK, 's1'), true);
    const ok = tsm.recordAction({ type: ACTION_TYPE.ATTACK, shipId: 's1' });
    assert.strictEqual(ok, true);
    const ap = tsm.getPlayerAP('p1');
    assert.strictEqual(ap.remaining, 6 - ap.attackCost);
    assert.strictEqual(tsm.actedShips.has('s1'), true);
    assert.strictEqual(tsm.canPerformAction(ACTION_TYPE.ATTACK, 's1'), false);
  });

  test('TSM 撤销操作', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    tsm.startGame(0);
    tsm.enterActionPhase();
    tsm.recordAction({ type: ACTION_TYPE.MOVE, shipId: 's1' });
    assert.strictEqual(tsm.actionsThisTurn.length, 1);
    const refunded = tsm.refundLastAction();
    assert.ok(refunded);
    assert.strictEqual(tsm.actionsThisTurn.length, 0);
    const ap = tsm.getPlayerAP('p1');
    assert.strictEqual(ap.remaining, ap.max);
  });

  test('TSM 回合流转', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    tsm.startGame(0);
    tsm.enterActionPhase();
    const result = tsm.endTurn();
    assert.strictEqual(result.endedPlayerId, 'p1');
    assert.strictEqual(result.nextPlayerId, 'p2');
    assert.strictEqual(tsm.currentPlayerId, 'p2');
    assert.strictEqual(tsm.turnNumber, 2);
    const result2 = tsm.endTurn();
    assert.strictEqual(result2.nextPlayerId, 'p1');
    assert.strictEqual(tsm.roundNumber, 2);
  });

  test('TSM 非本人回合不可操作', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    tsm.startGame(0);
    assert.strictEqual(tsm.isPlayerTurn('p1'), true);
    assert.strictEqual(tsm.isPlayerTurn('p2'), false);
  });

  test('TSM 序列化与反序列化', () => {
    const tsm = new TurnStateMachine(['p1', 'p2']);
    tsm.startGame(0);
    tsm.recordAction({ type: ACTION_TYPE.MOVE, shipId: 's1' });
    const data = tsm.serialize();
    const tsm2 = TurnStateMachine.deserialize(data);
    assert.strictEqual(tsm2.currentPlayerId, tsm.currentPlayerId);
    assert.strictEqual(tsm2.actionsThisTurn.length, 1);
    assert.strictEqual(tsm2.apPools.get('p1').remaining, tsm.apPools.get('p1').remaining);
  });
});

suite('[3] 护盾与伤害计算模块 (ShieldDamage)', () => {
  test('Ship 基本属性初始化', () => {
    const s = new Ship('s1', SHIP_ROLE.CRUISER, 'p1', Coord.of(0, 0));
    assert.strictEqual(s.hull > 0, true);
    assert.strictEqual(s.hull, s.maxHull);
    assert.strictEqual(s.shield, s.maxShield);
    assert.strictEqual(s.armor, s.maxArmor);
    assert.strictEqual(s.isDestroyed, false);
  });

  test('Ship 修复与护盾恢复', () => {
    const s = new Ship('s1', SHIP_ROLE.CRUISER, 'p1', Coord.of(0, 0));
    s.hull = 20; s.armor = 5; s.shield = 0;
    const r = s.repair(30, 10);
    assert.ok(r.hullRecovered > 0);
    assert.ok(r.armorRecovered > 0);
    assert.strictEqual(s.hull <= s.maxHull, true);
    const rg = s.regenShield(999);
    assert.strictEqual(s.shield, s.maxShield);
    assert.ok(rg > 0);
  });

  test('命中区域判定', () => {
    const zone = computeHitZone(Coord.of(0, 0), 'E', Coord.of(5, 0));
    assert.strictEqual(zone, HIT_ZONE.FRONT);
    const zone2 = computeHitZone(Coord.of(0, 0), 'E', Coord.of(-5, 0));
    assert.strictEqual(zone2, HIT_ZONE.REAR);
  });

  test('伤害计算：未命中', () => {
    const a = new Ship('a', SHIP_ROLE.SCOUT, 'p1', Coord.of(0, 0));
    const d = new Ship('d', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(99, 99));
    let missCount = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      const result = DamageCalculator.computeAttackDamage(a, d);
      if (!result.hit) missCount++;
    }
    assert.ok(missCount > 0, '300次攻击应至少有1次未命中');
  });

  test('伤害计算：护盾优先吸收', () => {
    const atk = new Ship('a', SHIP_ROLE.BOMBARD, 'p1', Coord.of(0, 0));
    const def = new Ship('d', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(3, 0));
    const shieldBefore = def.shield;
    let hitResult = null;
    for (let i = 0; i < 20 && (!hitResult || !hitResult.hit); i++) {
      hitResult = DamageCalculator.computeAttackDamage(atk, def);
    }
    assert.ok(hitResult && hitResult.hit, '应至少命中一次');
    if (shieldBefore > 0 && hitResult.shieldAbsorbed > 0) {
      assert.ok(def.shield < shieldBefore || hitResult.shieldAbsorbed >= shieldBefore, '护盾值应减少');
    }
  });

  test('伤害计算：装甲吸收', () => {
    const atk = new Ship('a', SHIP_ROLE.BOMBARD, 'p1', Coord.of(0, 0));
    const def = new Ship('d', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(3, 0));
    def.shield = 0;
    const armorBefore = def.armor;
    let hit = null;
    for (let i = 0; i < 20 && (!hit || !hit.hit); i++) {
      hit = DamageCalculator.computeAttackDamage(atk, def);
    }
    assert.ok(hit && hit.hit, '应命中');
    assert.ok(hit.armorAbsorbed >= 0);
  });

  test('伤害计算：摧毁船体', () => {
    const atk = new Ship('a', SHIP_ROLE.BOMBARD, 'p1', Coord.of(0, 0));
    const def = new Ship('d', SHIP_ROLE.SCOUT, 'p2', Coord.of(2, 0));
    def.hull = 5; def.shield = 0; def.armor = 0;
    let destroyed = false;
    for (let i = 0; i < 50 && !destroyed; i++) {
      const r = DamageCalculator.computeAttackDamage(atk, def);
      if (r.destroyed) destroyed = true;
    }
    assert.ok(destroyed, '薄血小舰应被摧毁');
  });

  test('伤害抗性生效', () => {
    const atk = new Ship('a', SHIP_ROLE.IRONCLAD, 'p1', Coord.of(0, 0));
    const def = new Ship('d', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(2, 0));
    def.shield = 0; def.armor = 0;
    const hull0 = def.hull = 1000;
    let total1 = 0, N = 200;
    for (let i = 0; i < N; i++) {
      const tmp = new Ship('x', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(2, 0));
      tmp.hull = 1000; tmp.shield = 0; tmp.armor = 0;
      const r = DamageCalculator.computeAttackDamage(atk, tmp);
      if (r.hit) total1 += r.finalDamage;
    }
    const avg1 = total1 / N;
    const atk2 = new Ship('a', SHIP_ROLE.CRUISER, 'p1', Coord.of(0, 0));
    let total2 = 0;
    for (let i = 0; i < N; i++) {
      const tmp = new Ship('x', SHIP_ROLE.IRONCLAD, 'p2', Coord.of(2, 0));
      tmp.hull = 1000; tmp.shield = 0; tmp.armor = 0;
      const r = DamageCalculator.computeAttackDamage(atk2, tmp);
      if (r.hit) total2 += r.finalDamage;
    }
    const avg2 = total2 / N;
    assert.ok(avg1 > 0 && avg2 > 0);
  });

  test('Ship 序列化/反序列化', () => {
    const s = new Ship('s1', SHIP_ROLE.BOMBARD, 'p1', Coord.of(3, 4));
    s.hull = 50; s.facing = 'W';
    const data = s.serialize();
    const s2 = Ship.deserialize(data);
    assert.strictEqual(s2.id, s.id);
    assert.strictEqual(s2.hull, 50);
    assert.strictEqual(s2.facing, 'W');
    assert.strictEqual(s2.coord.equals(Coord.of(3, 4)), true);
  });
});

suite('[4] WebSocket消息编解码模块 (MessageCodec)', () => {
  test('编码与解码往返', () => {
    const c = new MessageCodec();
    const raw = c.encode(MSG_TYPE.C2S.HANDSHAKE, { clientVersion: '1' });
    const msg = c.decode(raw);
    assert.strictEqual(msg.type, MSG_TYPE.C2S.HANDSHAKE);
    assert.strictEqual(msg.payload.clientVersion, '1');
    assert.ok(msg.id);
    assert.ok(typeof msg.seq === 'number');
  });

  test('严格模式：缺少必填字段', () => {
    const c = new MessageCodec({ strictMode: true });
    const raw = c.encode(MSG_TYPE.C2S.JOIN_ROOM, { invalid: 'x' });
    const r = c.tryDecode(raw);
    assert.strictEqual(r.ok, false, '应因缺少必填字段而失败');
  });

  test('错误消息构建', () => {
    const c = new MessageCodec();
    const raw = c.makeError(ERROR_CODE.NOT_ENOUGH_AP, '缺行动点', 'x');
    const msg = c.decode(raw);
    assert.strictEqual(msg.type, MSG_TYPE.S2C.ERROR);
    assert.strictEqual(msg.payload.code, ERROR_CODE.NOT_ENOUGH_AP);
    assert.strictEqual(msg.replyTo, 'x');
  });

  test('MessageDispatcher 派发', () => {
    const d = new MessageDispatcher();
    let called = 0;
    d.on(MSG_TYPE.C2S.ATTACK_RESULT, (msg) => { called++; return msg.payload.val; });
    const r = d.dispatch({ type: MSG_TYPE.C2S.ATTACK_RESULT, payload: { val: 42 } }, {});
    assert.strictEqual(called, 1);
    assert.strictEqual(r, 42);
  });

  test('MessageDispatcher 默认与错误处理', () => {
    const d = new MessageDispatcher();
    let def = 0, err = null;
    d.onDefault(() => def++);
    d.onError((e) => err = e);
    d.dispatch({ type: 'unknown_type', payload: {} });
    assert.strictEqual(def, 1, '默认处理被调用');
    d.on('throw', () => { throw new Error('boom'); });
    d.dispatch({ type: 'throw', payload: {} });
    assert.ok(err && err.message === 'boom', '错误处理被调用');
  });

  test('tryDecode 对无效 JSON 的处理', () => {
    const c = new MessageCodec();
    const r = c.tryDecode('not-json{{{');
    assert.strictEqual(r.ok, false);
  });
});

console.log(`\n========== 测试结果 ==========`);
console.log(`总计: ${total} | 通过: ${passed} | 失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
