'use strict';

(function () {
  const SS = window.SteamShip;
  const { GameClient, MSG_TYPE, TERRAIN_STYLE, SHIP_STYLE, PHASE, manhattan, computeReachableClient, reconstructPath, buildCoordKey } = SS;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    lobby: $('#lobby'),
    game: $('#game'),
    nameInput: $('#nameInput'),
    serverUrl: $('#serverUrl'),
    joinRoomId: $('#joinRoomId'),
    btnJoin: $('#btnJoin'),
    btnCreate: $('#btnCreate'),
    lobbyStatus: $('#lobbyStatus'),
    roomInfo: $('#roomInfo'),
    turnNum: $('#turnNum'),
    phaseName: $('#phaseName'),
    playerList: $('#playerList'),
    myShips: $('#myShips'),
    apNum: $('#apNum'),
    shipDetail: $('#shipDetail'),
    cmdAttack: $('#cmdAttack'),
    cmdRepair: $('#cmdRepair'),
    cmdShield: $('#cmdShield'),
    cmdUndo: $('#cmdUndo'),
    cmdEndTurn: $('#cmdEndTurn'),
    battleLog: $('#battleLog'),
    chatLog: $('#chatLog'),
    chatForm: $('#chatForm'),
    chatInput: $('#chatInput'),
    mapCanvas: $('#mapCanvas'),
    overlayCanvas: $('#overlayCanvas'),
    cellTooltip: $('#cellTooltip'),
    pingStatus: $('#pingStatus'),
    turnStatus: $('#turnStatus'),
    playerStatus: $('#playerStatus'),
    gameOverModal: $('#gameOverModal'),
    gameOverTitle: $('#gameOverTitle'),
    gameOverText: $('#gameOverText'),
    btnReturnToLobby: $('#btnReturnToLobby')
  };

  const client = new GameClient();
  const renderer = new SS.CanvasRenderer(el.mapCanvas, el.overlayCanvas);

  let pendingMode = 'none';
  let animStart = 0;

  function init() {
    const host = window.location.host || 'localhost:8080';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    el.serverUrl.value = el.serverUrl.value || `${proto}://${host}`;
    el.nameInput.value = el.nameInput.value || ('CMD' + Math.floor(Math.random() * 900 + 100));

    el.btnJoin.addEventListener('click', () => onJoin(false));
    el.btnCreate.addEventListener('click', () => onJoin(true));
    el.btnReturnToLobby.addEventListener('click', returnToLobby);

    el.cmdAttack.addEventListener('click', onCmdAttack);
    el.cmdRepair.addEventListener('click', onCmdRepair);
    el.cmdShield.addEventListener('click', onCmdShield);
    el.cmdUndo.addEventListener('click', onCmdUndo);
    el.cmdEndTurn.addEventListener('click', onCmdEndTurn);

    el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = el.chatInput.value.trim();
      if (!msg) return;
      client.chat(msg);
      el.chatInput.value = '';
    });

    el.mapCanvas.addEventListener('mousemove', onCanvasMouseMove);
    el.mapCanvas.addEventListener('mouseleave', () => { renderer.setHover(null, null); hideTooltip(); });
    el.mapCanvas.addEventListener('click', onCanvasClick);
    el.mapCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearSelection();
    });

    window.addEventListener('resize', resizeCanvases);
    bindClientEvents();
    startAnimationLoop();
  }

  async function onJoin(createNew) {
    const name = el.nameInput.value.trim() || '指挥官';
    const url = el.serverUrl.value.trim();
    if (!url) return setLobbyStatus('请输入服务器地址', true);
    setLobbyStatus('连接中...');
    try {
      await client.connect(url);
    } catch (e) {
      console.error(e);
      return setLobbyStatus('连接失败: ' + (e.message || e), true);
    }
    try {
      let resp;
      if (createNew) {
        resp = await client.createRoom(name);
      } else {
        const roomId = el.joinRoomId.value.trim().toUpperCase();
        resp = roomId ? await client.joinRoom(roomId, name) : await client.createRoom(name);
      }
      el.lobbyStatus.textContent = '';
      showGame();
      setStatusBar(resp.payload);
      logBattle('sys', `加入房间 [${resp.payload.roomName || resp.payload.roomId}] 成功，等待对手...`);
      client.sync();
      startPingLoop();
    } catch (e) {
      console.error(e);
      setLobbyStatus('操作失败: ' + (e.reason || e.message || e), true);
    }
  }

  function setLobbyStatus(text, isError = false) {
    el.lobbyStatus.textContent = text;
    el.lobbyStatus.style.color = isError ? '#f87171' : '#94a3b8';
  }

  function showGame() {
    el.lobby.classList.add('hidden');
    el.game.classList.remove('hidden');
    resizeCanvases();
  }

  function returnToLobby() {
    location.reload();
  }

  function setStatusBar(joinResp) {
    if (joinResp && joinResp.playerName) {
      el.playerStatus.textContent = joinResp.playerName;
      el.playerStatus.className = 'pill pill-info';
    }
  }

  function bindClientEvents() {
    client.on('room_joined', () => client.sync());
    client.on('room_state', (s) => {
      if (s.canStart && client.me && s.players && s.players.length >= 2) {
        logBattle('sys', '双方就位，3秒后自动开始...');
        setTimeout(() => client.startGame().catch(() => {}), 1800);
      }
    });
    client.on('game_started', () => {
      logBattle('good', '⚓ 战斗开始！');
      pendingMode = 'none';
    });
    client.on('turn_start', (t) => {
      logBattle('sys', `第 ${t.turnNumber} 回合开始 - 第 ${t.roundNumber} 轮`);
      if (t.playerId === client.me.playerId) logBattle('good', '🟢 这是你的回合');
      else logBattle('warn', '🔴 对手行动中');
      pendingMode = 'none';
    });
    client.on('phase_change', (p) => updateTurnStatus(p.phase));
    client.on('move_result', (m) => {
      const name = playerName(m.playerId);
      logBattle('sys', `${name} 的舰艇移动到 (${coordLabel(m.to.x, m.to.y)})`);
      playMoveAnim(m);
    });
    client.on('attack_result', (a) => {
      const dmg = a.damage || {};
      const attacker = client.getShip(a.attackerId);
      const target = client.getShip(a.targetId);
      const name = playerName(a.playerId);
      const tgtName = target ? (SHIP_STYLE[target.role] || { name: target.role }).name : '目标';
      if (!dmg.hit) {
        logBattle('warn', `${name} 的 ${SHIP_STYLE[attacker.role].name} 攻击未命中`);
      } else {
        const tag = dmg.crit ? ' 【暴击】' : '';
        const zone = dmg.hitZone || '';
        logBattle(dmg.destroyed ? 'bad' : 'warn',
          `${name} 的${SHIP_STYLE[attacker.role].name}命中${tgtName}${tag}(${zone})，船体伤害 ${dmg.finalDamage}，护盾吸收 ${dmg.shieldAbsorbed}，装甲吸收 ${dmg.armorAbsorbed}${dmg.destroyed ? ' - 目标已摧毁！💥' : ''}`);
      }
      playAttackAnim(a);
    });
    client.on('repair_result', (r) => {
      logBattle('good', `${playerName(r.playerId)} 的舰艇修复 船体+${r.hullRecovered} 装甲+${r.armorRecovered}`);
    });
    client.on('shield_regen_result', (r) => {
      logBattle('good', `${playerName(r.playerId)} 的舰艇护盾恢复 +${r.recovered}`);
    });
    client.on('ship_destroyed', (s) => {
      logBattle('bad', `💥 舰艇被摧毁 (${playerName(s.ownerId)})`);
    });
    client.on('game_over', (g) => {
      const win = g.winner === client.me.playerId;
      el.gameOverTitle.textContent = win ? '🏆 胜利！' : '💀 失败';
      el.gameOverText.textContent = win ? '你的蒸汽舰队统治了战场！' : '你的舰队已全军覆没...';
      el.gameOverModal.classList.remove('hidden');
      logBattle(win ? 'good' : 'bad', win ? '战斗胜利！' : '战斗失败');
    });
    client.on('state_sync', (s) => onStateSync(s));
    client.on('chat', (m) => {
      const div = document.createElement('div');
      div.className = 'chat-entry';
      const color = client.state ? (client.state.players.find(p => p.id === m.playerId) || {}).color || '#888' : '#888';
      div.innerHTML = `<span class="ch-name" style="color:${color}">${escapeHtml(m.playerName)}</span>: <span class="ch-msg">${escapeHtml(m.message)}</span>`;
      el.chatLog.appendChild(div);
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
    });
    client.on('server_error', (e) => {
      logBattle('bad', `错误: ${e.reason} [${e.code}]`);
    });
    client.on('latency', (ms) => {
      el.pingStatus.textContent = `Ping: ${ms}ms`;
      el.pingStatus.className = 'pill ' + (ms < 80 ? 'pill-active' : ms < 200 ? 'pill-neutral' : 'pill-waiting');
    });
    client.on('disconnected', () => {
      logBattle('sys', '与服务器断开连接');
      el.turnStatus.textContent = '断开';
      el.turnStatus.className = 'pill pill-danger';
    });
  }

  function onStateSync(s) {
    renderer.setState(s, client.me ? client.me.playerId : null);
    if (s.tsm) {
      el.turnNum.textContent = `${s.turnNumber} (轮 ${s.roundNumber})`;
      el.phaseName.textContent = phaseLabel(s.tsm.phase);
      updateTurnStatus(s.tsm.phase);
    }
    renderPlayerList(s);
    renderMyShips(s);
    renderAPBars(s);
    renderShipDetail(s);
    updateCommandButtons(s);
    updateRoomInfo(s);
  }

  function updateTurnStatus(phase) {
    const isMine = client.isMyTurn;
    if (!client.state || !client.state.tsm) {
      el.turnStatus.textContent = '等待开始';
      el.turnStatus.className = 'pill pill-waiting';
      return;
    }
    if (phase === PHASE.GAME_OVER) { el.turnStatus.textContent = '战斗结束'; el.turnStatus.className = 'pill pill-danger'; return; }
    if (isMine) {
      el.turnStatus.textContent = '你的回合';
      el.turnStatus.className = 'pill pill-active';
    } else {
      el.turnStatus.textContent = '对手回合';
      el.turnStatus.className = 'pill pill-waiting';
    }
  }

  function updateRoomInfo(s) {
    if (!client.me) return;
    el.roomInfo.innerHTML = `<div>房间: <b>${escapeHtml(s.roomName || client.me.roomId || '')}</b></div>`;
  }

  function renderPlayerList(s) {
    el.playerList.innerHTML = '';
    for (const p of s.players || []) {
      const isMe = client.me && client.me.playerId === p.id;
      const isCur = s.tsm && s.players[s.tsm.currentPlayerIndex] && s.players[s.tsm.currentPlayerIndex].id === p.id;
      const card = document.createElement('div');
      card.className = 'player-card' + (isCur ? ' active' : '') + (isMe ? ' me' : '');
      const livingShips = (s.ships || []).filter(sh => sh.ownerId === p.id && !sh.isDestroyed).length;
      const totalShips = (s.ships || []).filter(sh => sh.ownerId === p.id).length;
      card.innerHTML = `
        <span class="player-dot" style="background:${p.color}"></span>
        <div class="player-meta">
          <div class="player-name">${escapeHtml(p.name)}${isMe ? ' <span style="color:#22d3ee;font-size:10px">我</span>' : ''}${isCur ? ' <span style="color:#22c55e;font-size:10px">行动中</span>' : ''}</div>
          <div class="player-tag">${livingShips}/${totalShips} 艘 · ${p.id.slice(0, 5)}...</div>
        </div>
      `;
      el.playerList.appendChild(card);
    }
  }

  function renderMyShips(s) {
    el.myShips.innerHTML = '';
    const my = (s.ships || []).filter(sh => client.me && sh.ownerId === client.me.playerId);
    for (const ship of my) {
      const card = document.createElement('div');
      card.className = 'ship-card' + (ship.id === renderer.selectedShipId ? ' selected' : '') + (ship.isDestroyed ? ' disabled' : '');
      const style = SHIP_STYLE[ship.role] || {};
      const pct = Math.max(0, ship.hull / ship.maxHull);
      const color = pct > 0.5 ? '#22c55e' : pct > 0.25 ? '#eab308' : '#ef4444';
      const player = client.me;
      card.innerHTML = `
        <div class="ship-icon" style="background:${player ? player.color : '#888'};color:#0f172a">${style.name ? style.name[0] : '?'}</div>
        <div class="ship-meta">
          <div class="ship-name">${style.name || ship.role} ${ship.isDestroyed ? '💀' : (ship.hasAttackedThisTurn ? '🎯' : (ship.hasMovedThisTurn ? '🚢' : ''))}</div>
          <div class="ship-hp-line"><div class="ship-hp-fill" style="width:${(pct * 100).toFixed(0)}%;background:${color}"></div></div>
        </div>
      `;
      if (!ship.isDestroyed) {
        card.addEventListener('click', () => {
          client.selectShip(ship.id).catch(() => {});
          renderer.setSelectedShip(ship.id);
          pendingMode = 'none';
          onStateSync(client.state);
        });
      }
      el.myShips.appendChild(card);
    }
    if (my.length === 0) {
      const div = document.createElement('div');
      div.style.cssText = 'color:#64748b;font-size:12px;text-align:center;padding:14px';
      div.textContent = '暂无舰艇';
      el.myShips.appendChild(div);
    }
  }

  function renderAPBars(s) {
    if (!s.tsm || !client.me) { el.apNum.textContent = '- / -'; return; }
    const ap = s.apPools && s.apPools[client.me.playerId];
    if (!ap) { el.apNum.textContent = '- / -'; return; }
    el.apNum.textContent = `${ap.remaining} / ${ap.max}`;
  }

  function renderShipDetail(s) {
    const id = renderer.selectedShipId;
    if (!id) { el.shipDetail.className = 'ship-detail empty'; el.shipDetail.textContent = '请选择一艘我方舰艇'; return; }
    const ship = (s.ships || []).find(sh => sh.id === id);
    if (!ship) { el.shipDetail.className = 'ship-detail empty'; el.shipDetail.textContent = '未找到'; return; }
    const style = SHIP_STYLE[ship.role] || {};
    const player = (s.players || []).find(p => p.id === ship.ownerId);
    const ownerColor = player ? player.color : '#888';
    el.shipDetail.className = 'ship-detail';
    const bar = (label, cur, max, color) => {
      const pct = max > 0 ? Math.max(0, cur / max) : 0;
      return `<div class="ship-stat-bar">
        <span class="label">${label}</span>
        <div class="track"><div class="fill" style="width:${(pct * 100).toFixed(0)}%;background:${color}"></div></div>
        <span class="value">${cur} / ${max}</span>
      </div>`;
    };
    const terrain = (s.map.terrains || {})[buildCoordKey(ship.coord.x, ship.coord.y)] || 'plain';
    const terrainStyle = TERRAIN_STYLE[terrain] || {};
    el.shipDetail.innerHTML = `
      <div class="sd-header">
        <div class="sd-icon" style="background:${style.color || '#888'};border:2px solid ${ownerColor}">${style.name ? style.name[0] : '?'}</div>
        <div style="flex:1">
          <div class="sd-title">${style.name || ship.role}</div>
          <div class="sd-role">位置: ${coordLabel(ship.coord.x, ship.coord.y)} · 朝向: ${facingLabel(ship.facing)} · 地形: ${terrainStyle.name || terrain}</div>
        </div>
      </div>
      ${bar('船体', ship.hull, ship.maxHull, ship.hull / ship.maxHull > 0.5 ? '#22c55e' : ship.hull / ship.maxHull > 0.25 ? '#eab308' : '#ef4444')}
      ${bar('护盾', ship.shield, ship.maxShield, '#06b6d4')}
      ${bar('装甲', ship.armor, ship.maxArmor, '#a8a29e')}
      <div class="stat-grid">
        <div class="stat-cell"><div class="sl">机动</div><div class="sv">${ship.baseMoveRange}</div></div>
        <div class="stat-cell"><div class="sl">射程</div><div class="sv">${ship.baseAttackMinRange}-${ship.baseAttackMaxRange}</div></div>
        <div class="stat-cell"><div class="sl">状态</div><div class="sv">${ship.isDestroyed ? '已损毁' : (ship.hasAttackedThisTurn ? '已攻击' : '待命')}</div></div>
        <div class="stat-cell"><div class="sl">每回合护盾</div><div class="sv">+${ship.shieldRegenPerTurn}</div></div>
      </div>
    `;
  }

  function updateCommandButtons(s) {
    const id = renderer.selectedShipId;
    const ship = id ? (s.ships || []).find(sh => sh.id === id) : null;
    const isMyTurn = client.isMyTurn;
    const isMine = client.me && ship && ship.ownerId === client.me.playerId;
    const ap = s.apPools && client.me ? s.apPools[client.me.playerId] : null;

    el.cmdAttack.disabled = !(isMyTurn && isMine && ship && !ship.isDestroyed && !ship.hasAttackedThisTurn && ap && ap.remaining >= ap.attackCost);
    el.cmdRepair.disabled = !(isMyTurn && isMine && ship && !ship.isDestroyed && ap && ap.remaining >= ap.repairCost);
    el.cmdShield.disabled = !(isMyTurn && isMine && ship && !ship.isDestroyed && ap && ap.remaining >= ap.shieldRegenCost);
    el.cmdUndo.disabled = !(isMyTurn && s.tsm && s.tsm.actionsThisTurn && s.tsm.actionsThisTurn.length > 0 && s.tsm.actionsThisTurn[s.tsm.actionsThisTurn.length - 1].playerId === client.me.playerId);
    el.cmdEndTurn.disabled = !isMyTurn;

    el.cmdAttack.textContent = pendingMode === 'attack' ? '🎯 选择攻击目标...' : '⚔ 攻击';
    el.cmdAttack.style.background = pendingMode === 'attack' ? 'rgba(239,68,68,0.2)' : '';
    el.cmdAttack.style.borderColor = pendingMode === 'attack' ? '#ef4444' : '';
  }

  function onCmdAttack() {
    if (pendingMode === 'attack') { pendingMode = 'none'; updateCommandButtons(client.state); return; }
    pendingMode = 'attack';
    logBattle('sys', '请点击红色范围内的敌舰进行攻击，右键取消');
    updateCommandButtons(client.state);
  }
  function onCmdRepair() {
    const id = renderer.selectedShipId; if (!id) return;
    client.repair(id, 18, 10).then(() => {
      logBattle('good', '修复指令已发送');
    }).catch((e) => logBattle('bad', '修复失败: ' + (e.reason || e.message)));
  }
  function onCmdShield() {
    const id = renderer.selectedShipId; if (!id) return;
    client.shieldRegen(id).then(() => {
      logBattle('good', '护盾强化指令已发送');
    }).catch((e) => logBattle('bad', '护盾强化失败: ' + (e.reason || e.message)));
  }
  function onCmdUndo() {
    client.undo().then(() => {
      logBattle('sys', '已撤销上一步操作');
    }).catch((e) => logBattle('bad', '撤销失败: ' + (e.reason || e.message)));
  }
  function onCmdEndTurn() {
    pendingMode = 'none';
    client.endTurn().then(() => {
      logBattle('sys', '回合结束');
    }).catch((e) => logBattle('bad', '结束回合失败: ' + (e.reason || e.message)));
  }

  function clearSelection() {
    pendingMode = 'none';
    if (client.state) updateCommandButtons(client.state);
  }

  function onCanvasMouseMove(e) {
    if (!client.state) return;
    const rect = el.mapCanvas.getBoundingClientRect();
    const scaleX = el.mapCanvas.width / rect.width;
    const scaleY = el.mapCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const cell = renderer.pxToCell(px, py);
    if (!cell) { renderer.setHover(null, null); hideTooltip(); return; }
    renderer.setHover(cell.x, cell.y);
    showTooltip(e.clientX, e.clientY, cell);
  }

  function showTooltip(cx, cy, cell) {
    if (!client.state) return;
    const map = client.state.map;
    const terr = (map.terrains || {})[buildCoordKey(cell.x, cell.y)] || 'plain';
    const ts = TERRAIN_STYLE[terr] || {};
    const occ = (map.occupied || {})[buildCoordKey(cell.x, cell.y)];
    const ship = occ ? (client.state.ships || []).find(s => s.id === occ) : null;
    let html = `<div class="tt-title">${coordLabel(cell.x, cell.y)}</div>`;
    html += `<div class="tt-row">地形: ${ts.name || terr}${isFinite(ts.cost) ? ` (移动消耗${ts.cost})` : ' (不可通行)'}</div>`;
    if (ship) {
      const st = SHIP_STYLE[ship.role] || {};
      const player = (client.state.players || []).find(p => p.id === ship.ownerId);
      html += `<div class="tt-row" style="color:${player ? player.color : '#888'}">${st.name || ship.role}${ship.isDestroyed ? '💀' : ''}</div>`;
      html += `<div class="tt-row">船体 ${ship.hull}/${ship.maxHull} · 盾 ${ship.shield}/${ship.maxShield}</div>`;
    }
    el.cellTooltip.innerHTML = html;
    el.cellTooltip.classList.remove('hidden');
    const top = cy - el.cellTooltip.offsetHeight - 14;
    el.cellTooltip.style.left = (cx + 14) + 'px';
    el.cellTooltip.style.top = (top < 10 ? cy + 14 : top) + 'px';
  }
  function hideTooltip() { el.cellTooltip.classList.add('hidden'); }

  function onCanvasClick(e) {
    if (!client.state || !client.isMyTurn) return;
    const rect = el.mapCanvas.getBoundingClientRect();
    const scaleX = el.mapCanvas.width / rect.width;
    const scaleY = el.mapCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const cell = renderer.pxToCell(px, py);
    if (!cell) return;

    const key = buildCoordKey(cell.x, cell.y);
    const ship = (client.state.ships || []).find(s => !s.isDestroyed && s.coord.x === cell.x && s.coord.y === cell.y);

    if (pendingMode === 'attack' && ship) {
      const selShip = client.getShip(renderer.selectedShipId);
      if (selShip && ship.ownerId !== selShip.ownerId) {
        const d = manhattan(selShip.coord, ship.coord);
        if (d >= selShip.baseAttackMinRange && d <= selShip.baseAttackMaxRange) {
          client.attack(selShip.id, ship.id).then(() => {
            pendingMode = 'none';
            updateCommandButtons(client.state);
          }).catch((err) => logBattle('bad', '攻击失败: ' + (err.reason || err.message)));
          return;
        } else {
          logBattle('warn', `目标超出攻击范围 (${d}/${selShip.baseAttackMaxRange})`);
          return;
        }
      }
    }

    if (ship && client.me && ship.ownerId === client.me.playerId) {
      client.selectShip(ship.id).catch(() => {});
      renderer.setSelectedShip(ship.id);
      pendingMode = 'none';
      onStateSync(client.state);
      return;
    }

    const selShip = client.getShip(renderer.selectedShipId);
    if (selShip && !selShip.hasAttackedThisTurn) {
      const reachable = computeReachableClient(client.state.map, selShip.coord, selShip.baseMoveRange, selShip.id);
      const path = reconstructPath(reachable, cell);
      if (path && path.length > 1) {
        client.move(selShip.id, path.map(p => ({ x: p.x, y: p.y }))).then(() => {
          logBattle('sys', `移动至 ${coordLabel(cell.x, cell.y)}`);
          renderer.setHover(null, null);
        }).catch((err) => logBattle('bad', '移动失败: ' + (err.reason || err.message)));
        return;
      }
    }
  }

  function playAttackAnim(a) {
    const atk = client.getShip(a.attackerId);
    const tgt = client.getShip(a.targetId);
    if (!atk || !tgt) return;
    const from = renderer.cellToPx(atk.coord.x, atk.coord.y);
    const to = renderer.cellToPx(tgt.coord.x, tgt.coord.y);
    const color = (a.damage && a.damage.hit) ? '#f87171' : '#94a3b8';
    renderer.addLaser(from.x, from.y, to.x, to.y, color);
    if (a.damage && a.damage.hit) {
      setTimeout(() => renderer.addExplosion(to.x, to.y, a.damage.crit ? '#fbbf24' : '#ef4444'), 180);
    }
  }

  function playMoveAnim() { /* 路径可视化已在 renderer 中实现 */ }

  function startAnimationLoop() {
    animStart = performance.now();
    let last = animStart;
    const loop = (t) => {
      const dt = (t - last) / 1000;
      last = t;
      renderer.animate(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function resizeCanvases() {
    const wrap = el.mapCanvas.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const mw = client.state && client.state.map ? client.state.map.width : 12;
    const mh = client.state && client.state.map ? client.state.map.height : 10;
    renderer.resize(w, h, mw, mh);
    renderer.render();
  }

  function startPingLoop() {
    client.ping();
    setInterval(() => { if (client.ws && client.ws.readyState === 1) client.ping(); }, 5000);
  }

  function logBattle(kind, text) {
    const div = document.createElement('div');
    div.className = 'log-entry ' + (kind || '');
    div.textContent = `[${timeLabel()}] ${text}`;
    el.battleLog.appendChild(div);
    el.battleLog.scrollTop = el.battleLog.scrollHeight;
  }

  /* 辅助 */
  function playerName(pid) {
    if (client.me && client.me.playerId === pid) return '你';
    if (!client.state) return pid;
    const p = (client.state.players || []).find(x => x.id === pid);
    return p ? p.name : pid;
  }
  function phaseLabel(p) {
    return ({ waiting: '等待', planning: '规划', action: '行动', resolution: '结算', turn_end: '回合结束', game_over: '结束' })[p] || p;
  }
  function coordLabel(x, y) { return `${String.fromCharCode(65 + x)}${y + 1}`; }
  function facingLabel(f) { return ({ N: '北', S: '南', E: '东', W: '西' })[f] || f; }
  function timeLabel() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  document.addEventListener('DOMContentLoaded', init);
})();
