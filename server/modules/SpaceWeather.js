'use strict';

const { DAMAGE_TYPE } = require('./ShieldDamage');

const SPACE_WEATHER = Object.freeze({
  NORMAL: 'normal',
  STRONG_RADIATION: 'strong_radiation',
  NEBULA: 'nebula',
  SOLAR_FLARE: 'solar_flare'
});

const WEATHER_DEF = Object.freeze({
  [SPACE_WEATHER.NORMAL]: {
    name: '宇宙晴空',
    icon: '✨',
    description: '天气正常，无特殊效果',
    damageAdjust: {
      [DAMAGE_TYPE.KINETIC]: 0,
      [DAMAGE_TYPE.ENERGY]: 0,
      [DAMAGE_TYPE.EXPLOSIVE]: 0,
      [DAMAGE_TYPE.PIERCING]: 0
    },
    shieldRegenMultiplier: 1.0,
    accuracyAdjust: 0
  },
  [SPACE_WEATHER.STRONG_RADIATION]: {
    name: '强辐射风暴',
    icon: '☢️',
    description: '能量武器被辐射干扰，伤害 -2',
    damageAdjust: {
      [DAMAGE_TYPE.KINETIC]: 0,
      [DAMAGE_TYPE.ENERGY]: -2,
      [DAMAGE_TYPE.EXPLOSIVE]: 0,
      [DAMAGE_TYPE.PIERCING]: 0
    },
    shieldRegenMultiplier: 1.0,
    accuracyAdjust: 0
  },
  [SPACE_WEATHER.NEBULA]: {
    name: '星云弥漫',
    icon: '🌫️',
    description: '能见度下降，动能/穿甲武器伤害 -1',
    damageAdjust: {
      [DAMAGE_TYPE.KINETIC]: -1,
      [DAMAGE_TYPE.ENERGY]: 0,
      [DAMAGE_TYPE.EXPLOSIVE]: 0,
      [DAMAGE_TYPE.PIERCING]: -1
    },
    shieldRegenMultiplier: 1.0,
    accuracyAdjust: -0.05
  },
  [SPACE_WEATHER.SOLAR_FLARE]: {
    name: '太阳耀斑',
    icon: '☀️',
    description: '电磁活动剧烈，护盾回复效率 -50%，能量武器伤害 +1',
    damageAdjust: {
      [DAMAGE_TYPE.KINETIC]: 0,
      [DAMAGE_TYPE.ENERGY]: +1,
      [DAMAGE_TYPE.EXPLOSIVE]: 0,
      [DAMAGE_TYPE.PIERCING]: 0
    },
    shieldRegenMultiplier: 0.5,
    accuracyAdjust: 0
  }
});

const WEATHER_CYCLE_ORDER = [
  SPACE_WEATHER.NORMAL,
  SPACE_WEATHER.STRONG_RADIATION,
  SPACE_WEATHER.NEBULA,
  SPACE_WEATHER.SOLAR_FLARE,
  SPACE_WEATHER.NORMAL,
  SPACE_WEATHER.STRONG_RADIATION
];

const WEATHER_CHANGE_INTERVAL = 3;

class SpaceWeatherSystem {
  constructor() {
    this.currentWeather = SPACE_WEATHER.NORMAL;
    this.turnsInCurrentWeather = 0;
    this.weatherHistory = [{ weather: this.currentWeather, turn: 1 }];
  }

  get definition() {
    return WEATHER_DEF[this.currentWeather];
  }

  get name() {
    return this.definition.name;
  }

  get icon() {
    return this.definition.icon;
  }

  get description() {
    return this.definition.description;
  }

  getDamageAdjust(damageType) {
    const adj = this.definition.damageAdjust;
    return (adj && adj[damageType]) || 0;
  }

  getShieldRegenMultiplier() {
    return this.definition.shieldRegenMultiplier || 1.0;
  }

  getAccuracyAdjust() {
    return this.definition.accuracyAdjust || 0;
  }

  advanceTurn(currentGlobalTurn) {
    this.turnsInCurrentWeather++;
    let changed = null;
    if (this.turnsInCurrentWeather >= WEATHER_CHANGE_INTERVAL) {
      changed = this._pickNextWeather(currentGlobalTurn);
      this.turnsInCurrentWeather = 0;
      this.weatherHistory.push({ weather: this.currentWeather, turn: currentGlobalTurn });
      if (this.weatherHistory.length > 20) this.weatherHistory.shift();
    }
    return changed;
  }

  _pickNextWeather(currentGlobalTurn) {
    const idx = Math.floor(currentGlobalTurn / WEATHER_CHANGE_INTERVAL) % WEATHER_CYCLE_ORDER.length;
    const next = WEATHER_CYCLE_ORDER[idx];
    if (next !== this.currentWeather) {
      const old = this.currentWeather;
      this.currentWeather = next;
      return { oldWeather: old, newWeather: this.currentWeather };
    }
    return null;
  }

  setWeather(weather) {
    if (!WEATHER_DEF[weather]) throw new Error('无效天气类型');
    const old = this.currentWeather;
    this.currentWeather = weather;
    this.turnsInCurrentWeather = 0;
    return { oldWeather: old, newWeather: this.currentWeather };
  }

  serialize() {
    return {
      currentWeather: this.currentWeather,
      turnsInCurrentWeather: this.turnsInCurrentWeather,
      weatherHistory: [...this.weatherHistory]
    };
  }

  static deserialize(data) {
    const sys = new SpaceWeatherSystem();
    sys.currentWeather = data.currentWeather;
    sys.turnsInCurrentWeather = data.turnsInCurrentWeather;
    sys.weatherHistory = data.weatherHistory ? [...data.weatherHistory] : [];
    return sys;
  }
}

module.exports = {
  SPACE_WEATHER,
  WEATHER_DEF,
  WEATHER_CHANGE_INTERVAL,
  SpaceWeatherSystem
};
