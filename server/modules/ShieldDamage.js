'use strict';

const DAMAGE_TYPE = Object.freeze({
  KINETIC: 'kinetic',
  ENERGY: 'energy',
  EXPLOSIVE: 'explosive',
  PIERCING: 'piercing'
});

const HIT_ZONE = Object.freeze({
  FRONT: 'front',
  SIDE: 'side',
  REAR: 'rear',
  CRITICAL: 'critical'
});

const SHIP_ROLE = Object.freeze({
  IRONCLAD: 'ironclad',
  CRUISER: 'cruiser',
  SCOUT: 'scout',
  BOMBARD: 'bombard'
});

const SHIP_STAT_DEFS = Object.freeze({
  [SHIP_ROLE.IRONCLAD]: {
    name: '铁甲舰',
    maxHull: 120,
    maxArmor: 30,
    maxShield: 20,
    shieldRegenPerTurn: 5,
    baseMoveRange: 3,
    baseAttackMinRange: 1,
    baseAttackMaxRange: 3,
    baseDamage: 22,
    accuracy: 0.85,
    critChance: 0.08,
    damageType: DAMAGE_TYPE.KINETIC,
    resistances: {
      [DAMAGE_TYPE.KINETIC]: 0.25,
      [DAMAGE_TYPE.ENERGY]: 0.0,
      [DAMAGE_TYPE.EXPLOSIVE]: 0.3,
      [DAMAGE_TYPE.PIERCING]: -0.1
    },
    armorMultiplier: {
      [HIT_ZONE.FRONT]: 1.5,
      [HIT_ZONE.SIDE]: 1.0,
      [HIT_ZONE.REAR]: 0.6,
      [HIT_ZONE.CRITICAL]: 0.0
    }
  },
  [SHIP_ROLE.CRUISER]: {
    name: '巡洋舰',
    maxHull: 90,
    maxArmor: 18,
    maxShield: 30,
    shieldRegenPerTurn: 8,
    baseMoveRange: 4,
    baseAttackMinRange: 1,
    baseAttackMaxRange: 4,
    baseDamage: 18,
    accuracy: 0.9,
    critChance: 0.1,
    damageType: DAMAGE_TYPE.ENERGY,
    resistances: {
      [DAMAGE_TYPE.KINETIC]: 0.1,
      [DAMAGE_TYPE.ENERGY]: 0.3,
      [DAMAGE_TYPE.EXPLOSIVE]: 0.1,
      [DAMAGE_TYPE.PIERCING]: 0.0
    },
    armorMultiplier: {
      [HIT_ZONE.FRONT]: 1.3,
      [HIT_ZONE.SIDE]: 1.0,
      [HIT_ZONE.REAR]: 0.7,
      [HIT_ZONE.CRITICAL]: 0.0
    }
  },
  [SHIP_ROLE.SCOUT]: {
    name: '侦察舰',
    maxHull: 60,
    maxArmor: 8,
    maxShield: 15,
    shieldRegenPerTurn: 6,
    baseMoveRange: 6,
    baseAttackMinRange: 1,
    baseAttackMaxRange: 2,
    baseDamage: 14,
    accuracy: 0.95,
    critChance: 0.15,
    damageType: DAMAGE_TYPE.PIERCING,
    resistances: {
      [DAMAGE_TYPE.KINETIC]: 0.0,
      [DAMAGE_TYPE.ENERGY]: 0.15,
      [DAMAGE_TYPE.EXPLOSIVE]: -0.1,
      [DAMAGE_TYPE.PIERCING]: 0.2
    },
    armorMultiplier: {
      [HIT_ZONE.FRONT]: 1.2,
      [HIT_ZONE.SIDE]: 1.0,
      [HIT_ZONE.REAR]: 0.8,
      [HIT_ZONE.CRITICAL]: 0.0
    }
  },
  [SHIP_ROLE.BOMBARD]: {
    name: '轰击舰',
    maxHull: 80,
    maxArmor: 22,
    maxShield: 10,
    shieldRegenPerTurn: 3,
    baseMoveRange: 2,
    baseAttackMinRange: 3,
    baseAttackMaxRange: 6,
    baseDamage: 32,
    accuracy: 0.7,
    critChance: 0.2,
    damageType: DAMAGE_TYPE.EXPLOSIVE,
    resistances: {
      [DAMAGE_TYPE.KINETIC]: 0.15,
      [DAMAGE_TYPE.ENERGY]: 0.0,
      [DAMAGE_TYPE.EXPLOSIVE]: 0.4,
      [DAMAGE_TYPE.PIERCING]: -0.15
    },
    armorMultiplier: {
      [HIT_ZONE.FRONT]: 1.4,
      [HIT_ZONE.SIDE]: 0.9,
      [HIT_ZONE.REAR]: 0.5,
      [HIT_ZONE.CRITICAL]: 0.0
    }
  }
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function computeHitZone(attackerCoord, attackerFacing, targetCoord) {
  const dx = targetCoord.x - attackerCoord.x;
  const dy = targetCoord.y - attackerCoord.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < 1 && absDy < 1) return HIT_ZONE.FRONT;

  let isFront = false;
  switch (attackerFacing) {
    case 'N': isFront = dy < 0 && absDy >= absDx; break;
    case 'S': isFront = dy > 0 && absDy >= absDx; break;
    case 'E': isFront = dx > 0 && absDx >= absDy; break;
    case 'W': isFront = dx < 0 && absDx >= absDy; break;
    default: isFront = absDx > absDy; break;
  }

  const absDiff = Math.abs(absDx - absDy);
  const isSide = absDiff <= Math.max(1, Math.floor((absDx + absDy) * 0.25));

  if (isSide && !isFront) return HIT_ZONE.SIDE;
  if (isFront) return HIT_ZONE.FRONT;
  return HIT_ZONE.REAR;
}

class DamageCalculator {
  static rollAccuracy(accuracy, terrainBonus = 0, weatherAccuracyAdjust = 0) {
    const effective = clamp(accuracy + terrainBonus * 0.03 + weatherAccuracyAdjust, 0.05, 0.98);
    return Math.random() < effective;
  }

  static rollCritical(critChance) {
    return Math.random() < critChance;
  }

  static computeAttackDamage(attacker, defender, context = {}) {
    const result = {
      hit: false,
      crit: false,
      hitZone: HIT_ZONE.FRONT,
      rawDamage: 0,
      shieldAbsorbed: 0,
      armorAbsorbed: 0,
      resistanceReduction: 0,
      finalDamage: 0,
      defenderHpBefore: defender ? defender.hull : 0,
      defenderHpAfter: defender ? defender.hull : 0,
      defenderShieldBefore: defender ? defender.shield : 0,
      defenderShieldAfter: defender ? defender.shield : 0,
      defenderArmorBefore: defender ? defender.armor : 0,
      defenderArmorAfter: defender ? defender.armor : 0,
      destroyed: false,
      defenseBonus: 0,
      terrainShieldBonus: 0,
      weatherDamageAdjust: 0,
      log: []
    };

    if (!attacker || !defender) {
      result.log.push('攻击者或目标无效');
      return result;
    }

    const atkStats = SHIP_STAT_DEFS[attacker.role] || SHIP_STAT_DEFS[SHIP_ROLE.CRUISER];
    const defStats = SHIP_STAT_DEFS[defender.role] || SHIP_STAT_DEFS[SHIP_ROLE.CRUISER];

    result.defenderHpBefore = defender.hull;
    result.defenderShieldBefore = defender.shield;
    result.defenderArmorBefore = defender.armor;

    const terrainDef = context.terrainDefenseBonus || 0;
    result.defenseBonus = terrainDef;

    const terrainShieldBonus = context.terrainShieldBonus || 0;
    result.terrainShieldBonus = terrainShieldBonus;

    const weatherDamageAdjust = context.weatherDamageAdjust || 0;
    result.weatherDamageAdjust = weatherDamageAdjust;
    const weatherAccuracyAdjust = context.weatherAccuracyAdjust || 0;

    const accuracy = context.hitChance !== undefined ? context.hitChance : atkStats.accuracy;
    const baseDamage = context.weaponDamage !== undefined ? context.weaponDamage : atkStats.baseDamage;
    const damageType = context.weaponDamageType !== undefined ? context.weaponDamageType : atkStats.damageType;

    const hitRoll = this.rollAccuracy(accuracy, -terrainDef, weatherAccuracyAdjust);
    if (!hitRoll) {
      result.hit = false;
      result.log.push(`攻击未命中 (精度${(accuracy * 100).toFixed(0)}% + 地形修正 + 天气修正)`);
      return result;
    }
    result.hit = true;

    if (context.attackerCoord && context.attackerFacing && context.targetCoord) {
      result.hitZone = computeHitZone(context.attackerCoord, context.attackerFacing, context.targetCoord);
    } else {
      const roll = Math.random();
      if (roll < 0.5) result.hitZone = HIT_ZONE.FRONT;
      else if (roll < 0.8) result.hitZone = HIT_ZONE.SIDE;
      else result.hitZone = HIT_ZONE.REAR;
    }

    result.crit = this.rollCritical(atkStats.critChance);
    if (result.crit) result.hitZone = HIT_ZONE.CRITICAL;

    let dmg = baseDamage;
    if (context.distance !== undefined && context.distance > atkStats.baseAttackMaxRange * 0.7) {
      dmg = Math.floor(dmg * 0.85);
    }
    if (context.chargeBonus) {
      dmg = Math.floor(dmg * (1 + context.chargeBonus));
    }
    const critMultiplier = result.crit ? 1.8 : 1.0;
    dmg = Math.round(dmg * critMultiplier);

    if (weatherDamageAdjust !== 0) {
      dmg = Math.max(0, dmg + weatherDamageAdjust);
      result.log.push(`天气修正: 伤害 ${weatherDamageAdjust > 0 ? '+' : ''}${weatherDamageAdjust}`);
    }

    result.rawDamage = dmg;
    result.log.push(`命中! 命中区域: ${result.hitZone}${result.crit ? ' [暴击!]' : ''}, 基础伤害: ${dmg}`);

    const resists = defStats.resistances || {};
    const resistMult = 1 - (resists[damageType] || 0);
    const resistedDamage = Math.round(dmg * (1 - resistMult));
    dmg = Math.round(dmg * resistMult);
    result.resistanceReduction = resistedDamage;
    if (resistedDamage !== 0) {
      result.log.push(`抗性调整: ${defStats.name}对${damageType}伤害抗性 ${((resists[damageType] || 0) * 100).toFixed(0)}%, 减免${resistedDamage}`);
    }

    if (terrainShieldBonus !== 0) {
      result.log.push(`地形护盾: ${terrainShieldBonus > 0 ? '+' : ''}${terrainShieldBonus}`);
    }
    const effectiveShield = Math.max(0, defender.shield + terrainShieldBonus);
    result.effectiveShield = effectiveShield;
    if (effectiveShield > 0) {
      const absorbed = Math.min(effectiveShield, dmg);
      const actualShieldDrain = Math.min(defender.shield, absorbed);
      defender.shield -= actualShieldDrain;
      dmg -= absorbed;
      result.shieldAbsorbed = absorbed;
      result.log.push(`护盾吸收: ${absorbed}, 剩余护盾: ${defender.shield}`);
    }

    if (dmg > 0 && defender.armor > 0 && result.hitZone !== HIT_ZONE.CRITICAL) {
      const armorMult = defStats.armorMultiplier[result.hitZone] || 1.0;
      const effectiveArmor = Math.max(0, defender.armor * armorMult);
      const armorAbs = Math.min(effectiveArmor, Math.floor(dmg * 0.6));
      const armorDmg = Math.min(defender.armor, Math.ceil(armorAbs * 0.5));
      defender.armor -= armorDmg;
      dmg -= armorAbs;
      dmg = Math.max(0, dmg);
      result.armorAbsorbed = armorAbs;
      result.log.push(`装甲吸收: ${armorAbs} (区域系数x${armorMult.toFixed(1)}), 装甲损耗: ${armorDmg}`);
    }

    result.finalDamage = dmg;
    if (dmg > 0) {
      defender.hull = Math.max(0, defender.hull - dmg);
      result.log.push(`船体受损: ${dmg}, 剩余船体: ${defender.hull}/${defStats.maxHull}`);
    }

    result.defenderHpAfter = defender.hull;
    result.defenderShieldAfter = defender.shield;
    result.defenderArmorAfter = defender.armor;

    if (defender.hull <= 0) {
      result.destroyed = true;
      result.log.push(`舰艇被摧毁!`);
    }

    return result;
  }
}

class Ship {
  constructor(id, role, ownerId, coord) {
    this.id = id;
    this.role = role;
    this.ownerId = ownerId;
    this.coord = coord.clone();
    this.facing = 'N';

    const def = SHIP_STAT_DEFS[role] || SHIP_STAT_DEFS[SHIP_ROLE.CRUISER];
    this.maxHull = def.maxHull;
    this.maxArmor = def.maxArmor;
    this.maxShield = def.maxShield;
    this.shieldRegenPerTurn = def.shieldRegenPerTurn;
    this.baseMoveRange = def.baseMoveRange;
    this.baseAttackMinRange = def.baseAttackMinRange;
    this.baseAttackMaxRange = def.baseAttackMaxRange;

    this.hull = def.maxHull;
    this.armor = def.maxArmor;
    this.shield = def.maxShield;

    this.hasAttackedThisTurn = false;
    this.hasMovedThisTurn = false;
    this.buffs = [];
    this.debuffs = [];
  }

  get isDestroyed() {
    return this.hull <= 0;
  }

  get definition() {
    return SHIP_STAT_DEFS[this.role];
  }

  get hullPercent() {
    return this.hull / this.maxHull;
  }

  regenShield(amount = null, multiplier = 1.0) {
    const baseAmount = amount !== null ? amount : this.shieldRegenPerTurn;
    const amt = Math.round(baseAmount * multiplier);
    const before = this.shield;
    this.shield = Math.min(this.maxShield, this.shield + amt);
    return this.shield - before;
  }

  repair(hullAmount, armorAmount = 0) {
    const hullBefore = this.hull;
    const armorBefore = this.armor;
    this.hull = Math.min(this.maxHull, this.hull + (hullAmount | 0));
    this.armor = Math.min(this.maxArmor, this.armor + (armorAmount | 0));
    return {
      hullRecovered: this.hull - hullBefore,
      armorRecovered: this.armor - armorBefore
    };
  }

  resetTurnState() {
    this.hasAttackedThisTurn = false;
    this.hasMovedThisTurn = false;
  }

  applyDamageResult(damageResult) {
    this.hull = damageResult.defenderHpAfter;
    this.shield = damageResult.defenderShieldAfter;
    this.armor = damageResult.defenderArmorAfter;
  }

  moveTo(newCoord, newFacing = null) {
    this.coord = newCoord.clone();
    if (newFacing) this.facing = newFacing;
    this.hasMovedThisTurn = true;
  }

  serialize() {
    return {
      id: this.id,
      role: this.role,
      ownerId: this.ownerId,
      coord: { x: this.coord.x, y: this.coord.y },
      facing: this.facing,
      maxHull: this.maxHull,
      maxArmor: this.maxArmor,
      maxShield: this.maxShield,
      shieldRegenPerTurn: this.shieldRegenPerTurn,
      baseMoveRange: this.baseMoveRange,
      baseAttackMinRange: this.baseAttackMinRange,
      baseAttackMaxRange: this.baseAttackMaxRange,
      hull: this.hull,
      armor: this.armor,
      shield: this.shield,
      hasAttackedThisTurn: this.hasAttackedThisTurn,
      hasMovedThisTurn: this.hasMovedThisTurn,
      buffs: [...this.buffs],
      debuffs: [...this.debuffs],
      isDestroyed: this.isDestroyed
    };
  }

  static deserialize(data) {
    const { Coord } = require('./MapCoordinate');
    const s = new Ship(data.id, data.role, data.ownerId, Coord.of(data.coord.x, data.coord.y));
    s.facing = data.facing;
    s.maxHull = data.maxHull;
    s.maxArmor = data.maxArmor;
    s.maxShield = data.maxShield;
    s.shieldRegenPerTurn = data.shieldRegenPerTurn;
    s.baseMoveRange = data.baseMoveRange;
    s.baseAttackMinRange = data.baseAttackMinRange;
    s.baseAttackMaxRange = data.baseAttackMaxRange;
    s.hull = data.hull;
    s.armor = data.armor;
    s.shield = data.shield;
    s.hasAttackedThisTurn = data.hasAttackedThisTurn;
    s.hasMovedThisTurn = data.hasMovedThisTurn;
    s.buffs = data.buffs || [];
    s.debuffs = data.debuffs || [];
    return s;
  }
}

module.exports = {
  DAMAGE_TYPE,
  HIT_ZONE,
  SHIP_ROLE,
  SHIP_STAT_DEFS,
  computeHitZone,
  DamageCalculator,
  Ship
};
