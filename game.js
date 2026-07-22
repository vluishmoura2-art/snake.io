(() => {
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const overlayMessage = document.getElementById('overlay-message');
  const startBtn = document.getElementById('start-btn');
  const scoreEl = document.getElementById('score');
  const highScoreEl = document.getElementById('high-score');
  const leaderboardEl = document.getElementById('leaderboard');
  const boostBar = document.getElementById('boost-fill');
  const joystickZone = document.getElementById('joystick-zone');
  const joystickBase = document.getElementById('joystick-base');
  const joystickKnob = document.getElementById('joystick-knob');
  const colorSwatches = document.getElementById('color-swatches');
  const modeBtns = document.querySelectorAll('.mode-btn');
  const playerNameInput = document.getElementById('player-name');
  const statusMsg = document.getElementById('status-msg');

  const MAP_W = 4000;
  const MAP_H = 4000;
  const BASE_SPEED = 120;
  const BOOST_SPEED = 220;
  const ROTATION_SPEED = 3.0;
  const RECORD_INTERVAL = 4;
  const SPACING_SAMPLES = 3;
  const MAX_HISTORY = 1000;
  const HEAD_RADIUS = 10;
  const SEGMENT_RADIUS = 8;
  const PICKUP_RADIUS = 14;
  const FOOD_COUNT = 150;
  const MAX_FOOD = 500;
  const BOOST_COST_PER_SEC = 10;
  const MIN_BOOST_SCORE = 5;
  const DROP_FOOD_RATIO = 0.6;
  const BOT_COUNT = 7;
  const MAX_SEGMENTS = 200;
  const SPAWN_MARGIN = 300;
  const MIN_SEG_RADIUS = 4;
  const MAX_SEG_RADIUS = 12;
  const GRID_LINE_SPACING = 100;

  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

  const PALETTE = [
    { name: 'Green',  primary: '#00cc66', dark: '#009944' },
    { name: 'Blue',   primary: '#3399ff', dark: '#2277cc' },
    { name: 'Red',    primary: '#ff4444', dark: '#cc2222' },
    { name: 'Orange', primary: '#ff8800', dark: '#cc6600' },
    { name: 'Pink',   primary: '#ff55cc', dark: '#cc33aa' },
    { name: 'Purple', primary: '#aa55ff', dark: '#8833cc' },
    { name: 'Cyan',   primary: '#00ddcc', dark: '#00aa99' },
    { name: 'Yellow', primary: '#ffdd00', dark: '#ccaa00' },
    { name: 'Lime',   primary: '#aaff00', dark: '#88cc00' },
    { name: 'White',  primary: '#eeeeee', dark: '#bbbbbb' },
    { name: 'Coral',  primary: '#ff7777', dark: '#cc4444' },
    { name: 'Teal',   primary: '#00bfa5', dark: '#009977' },
  ];

  let viewW, viewH;
  let score, highScore, running, animFrameId;
  let playerAlive, boosting;
  let playerColorIdx;
  let lastTime = 0;

  let gameMode = 'single';
  let ws = null;
  let myId = null;
  let wsConnected = false;
  let pendingJoin = false;
  let remoteSnakes = [];
  let remoteFoods = [];

  let headX, headY, angle, targetAngle, segCount;
  let snakeHistory, lastRecordX, lastRecordY;
  let bots, foods;

  const keys = {};
  let mouseActive = false;

  highScore = +(localStorage.getItem('snake-io-hs') || 0);
  highScoreEl.textContent = 'Best: ' + highScore;
  playerColorIdx = +(localStorage.getItem('snake-io-color') || 0);
  if (playerColorIdx < 0 || playerColorIdx >= PALETTE.length) playerColorIdx = 0;
  playerNameInput.value = localStorage.getItem('snake-io-name') || '';

  function buildColorPicker() {
    colorSwatches.innerHTML = '';
    PALETTE.forEach(function(c, i) {
      const el = document.createElement('div');
      el.className = 'color-swatch' + (i === playerColorIdx ? ' selected' : '');
      el.style.background = c.primary;
      el.title = c.name;
      el.addEventListener('click', function() {
        playerColorIdx = i;
        localStorage.setItem('snake-io-color', i);
        colorSwatches.querySelectorAll('.color-swatch').forEach(function(s) { s.classList.remove('selected'); });
        el.classList.add('selected');
      });
      colorSwatches.appendChild(el);
    });
  }
  buildColorPicker();

  modeBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      gameMode = btn.dataset.mode;
      modeBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (gameMode === 'multi' && !wsConnected) preconnectMultiplayer();
    });
  });

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ==================== RING BUFFER ====================

  function createHistory(cap) {
    return { buf: new Float32Array(cap * 2), head: 0, count: 0, capacity: cap };
  }

  function pushHistory(h, x, y) {
    h.buf[h.head * 2] = x;
    h.buf[h.head * 2 + 1] = y;
    h.head = (h.head + 1) % h.capacity;
    if (h.count < h.capacity) h.count++;
  }

  function getHistory(h, index) {
    if (index >= h.count) return null;
    const i = (h.head - 1 - index + h.capacity) % h.capacity;
    return { x: h.buf[i * 2], y: h.buf[i * 2 + 1] };
  }

  // ==================== UTILITIES ====================

  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function distSq(x1, y1, x2, y2) {
    var dx = x1 - x2, dy = y1 - y2;
    return dx * dx + dy * dy;
  }

  function randFloat(lo, hi) { return lo + Math.random() * (hi - lo); }

  // ==================== HISTORY RECORDING ====================

  function recordHistory(hist, x, y, lastX, lastY) {
    var dx = x - lastX;
    var dy = y - lastY;
    if (dx * dx + dy * dy >= RECORD_INTERVAL * RECORD_INTERVAL) {
      pushHistory(hist, x, y);
      return { lx: x, ly: y };
    }
    return { lx: lastX, ly: lastY };
  }

  // ==================== COMPUTE SEGMENTS ====================

  function computeSegs(hist, count) {
    var segs = [];
    for (var i = 0; i < count; i++) {
      var pos = getHistory(hist, (i + 1) * SPACING_SAMPLES);
      if (!pos) break;
      segs.push({ x: pos.x, y: pos.y });
    }
    return segs;
  }

  // ==================== FOOD ====================

  function spawnFood(x, y) {
    return {
      x: x !== undefined ? x : randFloat(50, MAP_W - 50),
      y: y !== undefined ? y : randFloat(50, MAP_H - 50),
    };
  }

  function dropFoodFromHistory(hist, segCount) {
    var count = Math.floor(segCount * DROP_FOOD_RATIO);
    if (count === 0) return;
    var step = Math.max(1, Math.floor(segCount / count));
    var placed = 0;
    for (var i = 0; i < segCount && placed < count; i += step) {
      var pos = getHistory(hist, (i + 1) * SPACING_SAMPLES);
      if (pos && foods.length < MAX_FOOD) {
        foods.push(spawnFood(pos.x, pos.y));
        placed++;
      }
    }
  }

  // ==================== HEAD COLLISION ====================

  var HEAD_COL_SQ = (HEAD_RADIUS + SEGMENT_RADIUS) * (HEAD_RADIUS + SEGMENT_RADIUS);
  var PICKUP_SQ = PICKUP_RADIUS * PICKUP_RADIUS;

  function headHitsSegments(hist, segCount, startIdx) {
    for (var i = startIdx; i < segCount; i++) {
      var pos = getHistory(hist, i * SPACING_SAMPLES);
      if (pos && distSq(headX, headY, pos.x, pos.y) < HEAD_COL_SQ) return true;
    }
    return false;
  }

  // ==================== INIT SINGLE PLAYER ====================

  function initSinglePlayer() {
    headX = MAP_W / 2;
    headY = MAP_H / 2;
    angle = Math.random() * Math.PI * 2;
    targetAngle = angle;
    segCount = 4;
    snakeHistory = createHistory(MAX_HISTORY);
    for (var i = 1; i <= segCount * SPACING_SAMPLES + 4; i++) {
      pushHistory(snakeHistory,
        headX - Math.cos(angle) * RECORD_INTERVAL * i,
        headY - Math.sin(angle) * RECORD_INTERVAL * i
      );
    }
    lastRecordX = headX;
    lastRecordY = headY;
    score = 0;
    boosting = false;
    playerAlive = true;
    scoreEl.textContent = 'Score: 0';

    bots = [];
    for (var b = 0; b < BOT_COUNT; b++) {
      var bAngle = Math.random() * Math.PI * 2;
      var bx = randFloat(SPAWN_MARGIN, MAP_W - SPAWN_MARGIN);
      var by = randFloat(SPAWN_MARGIN, MAP_H - SPAWN_MARGIN);
      var bHist = createHistory(MAX_HISTORY);
      for (var j = 1; j <= 4 * SPACING_SAMPLES + 4; j++) {
        pushHistory(bHist,
          bx - Math.cos(bAngle) * RECORD_INTERVAL * j,
          by - Math.sin(bAngle) * RECORD_INTERVAL * j
        );
      }
      bots.push({
        headX: bx, headY: by, angle: bAngle, targetAngle: bAngle,
        history: bHist, lastRecordX: bx, lastRecordY: by,
        segmentCount: 4, color: b % PALETTE.length,
        alive: true, score: 0, boosting: false, boostCooldown: 0,
      });
    }

    foods = [];
    for (var f = 0; f < FOOD_COUNT; f++) {
      foods.push(spawnFood());
    }
  }

  // ==================== PLAYER UPDATE ====================

  function updatePlayer(dt) {
    if (!playerAlive) return;

    var diff = angleDiff(angle, targetAngle);
    var maxTurn = ROTATION_SPEED * dt;
    if (Math.abs(diff) > maxTurn) diff = Math.sign(diff) * maxTurn;
    angle += diff;

    if (boosting && score >= MIN_BOOST_SCORE) {
      score -= BOOST_COST_PER_SEC * dt;
      if (score < 0) score = 0;
    } else if (boosting) {
      boosting = false;
    }

    var speed = boosting ? BOOST_SPEED : BASE_SPEED;
    headX += Math.cos(angle) * speed * dt;
    headY += Math.sin(angle) * speed * dt;
    headX = clamp(headX, 0, MAP_W);
    headY = clamp(headY, 0, MAP_H);

    var rec = recordHistory(snakeHistory, headX, headY, lastRecordX, lastRecordY);
    lastRecordX = rec.lx;
    lastRecordY = rec.ly;

    if (headX <= 0 || headX >= MAP_W || headY <= 0 || headY >= MAP_H) {
      diePlayer();
      return;
    }

    if (headHitsSegments(snakeHistory, segCount, 4)) {
      diePlayer();
      return;
    }

    for (var b = 0; b < bots.length; b++) {
      var bot = bots[b];
      if (!bot.alive) continue;
      if (headHitsSegments(bot.history, bot.segmentCount, 1)) {
        diePlayer();
        return;
      }
    }

    var ate = 0;
    for (var i = foods.length - 1; i >= 0; i--) {
      if (distSq(headX, headY, foods[i].x, foods[i].y) < PICKUP_SQ) {
        foods.splice(i, 1);
        ate++;
        if (foods.length < MAX_FOOD) foods.push(spawnFood());
      }
    }
    if (ate > 0) {
      segCount = Math.min(segCount + ate, MAX_SEGMENTS);
      score += ate;
    }

    scoreEl.textContent = 'Score: ' + Math.round(score);
  }

  function diePlayer() {
    playerAlive = false;
    dropFoodFromHistory(snakeHistory, segCount);
    gameOverSingle();
  }

  // ==================== BOT AI ====================

  function updateBot(bot, dt) {
    if (!bot.alive) return;

    var bestDist = Infinity;
    var bestAngle = 0;
    for (var i = 0; i < foods.length; i++) {
      var d = distSq(bot.headX, bot.headY, foods[i].x, foods[i].y);
      if (d < bestDist) {
        bestDist = d;
        bestAngle = Math.atan2(foods[i].y - bot.headY, foods[i].x - bot.headX);
      }
    }

    var futureX = bot.headX + Math.cos(bot.targetAngle) * 150;
    var futureY = bot.headY + Math.sin(bot.targetAngle) * 150;
    if (futureX < 150 || futureX > MAP_W - 150 || futureY < 150 || futureY > MAP_H - 150) {
      bot.targetAngle = Math.atan2(MAP_H / 2 - bot.headY, MAP_W / 2 - bot.headX);
    } else {
      bot.targetAngle = bestAngle;
    }

    if (Math.random() < 0.015) {
      bot.targetAngle += (Math.random() - 0.5) * 1.2;
    }

    var diff = angleDiff(bot.angle, bot.targetAngle);
    var maxTurn = ROTATION_SPEED * dt;
    if (Math.abs(diff) > maxTurn) diff = Math.sign(diff) * maxTurn;
    bot.angle += diff;

    if (bot.boostCooldown > 0) {
      bot.boostCooldown -= dt;
      bot.boosting = false;
    } else if (bot.segmentCount > 6 && bestDist > 225 && Math.random() < 0.03) {
      bot.boosting = true;
    } else if (bot.boosting && (bestDist < 25 || bot.segmentCount <= 4)) {
      bot.boosting = false;
      bot.boostCooldown = 3;
    }

    var speed = bot.boosting ? BOOST_SPEED : BASE_SPEED;
    bot.headX += Math.cos(bot.angle) * speed * dt;
    bot.headY += Math.sin(bot.angle) * speed * dt;
    bot.headX = clamp(bot.headX, 0, MAP_W);
    bot.headY = clamp(bot.headY, 0, MAP_H);

    var rec = recordHistory(bot.history, bot.headX, bot.headY, bot.lastRecordX, bot.lastRecordY);
    bot.lastRecordX = rec.lx;
    bot.lastRecordY = rec.ly;

    if (bot.headX <= 0 || bot.headX >= MAP_W || bot.headY <= 0 || bot.headY >= MAP_H) {
      respawnBot(bot);
      return;
    }

    for (var s = 4; s < bot.segmentCount; s++) {
      var pos = getHistory(bot.history, s * SPACING_SAMPLES);
      if (pos && distSq(bot.headX, bot.headY, pos.x, pos.y) < HEAD_COL_SQ) {
        respawnBot(bot);
        return;
      }
    }

    if (playerAlive) {
      for (var si = 1; si < segCount; si++) {
        var sp = getHistory(snakeHistory, si * SPACING_SAMPLES);
        if (sp && distSq(bot.headX, bot.headY, sp.x, sp.y) < HEAD_COL_SQ) {
          respawnBot(bot);
          return;
        }
      }
      if (headHitsSegments(bot.history, bot.segmentCount, 1)) {
        diePlayer();
        return;
      }
    }

    var ate = 0;
    for (var fi = foods.length - 1; fi >= 0; fi--) {
      if (distSq(bot.headX, bot.headY, foods[fi].x, foods[fi].y) < PICKUP_SQ) {
        foods.splice(fi, 1);
        ate++;
        if (foods.length < MAX_FOOD) foods.push(spawnFood());
      }
    }
    if (ate > 0) {
      bot.segmentCount = Math.min(bot.segmentCount + ate, MAX_SEGMENTS);
      bot.score += ate;
    }
  }

  function respawnBot(bot) {
    var a = Math.random() * Math.PI * 2;
    var x = randFloat(SPAWN_MARGIN, MAP_W - SPAWN_MARGIN);
    var y = randFloat(SPAWN_MARGIN, MAP_H - SPAWN_MARGIN);
    var h = createHistory(MAX_HISTORY);
    for (var i = 1; i <= 4 * SPACING_SAMPLES + 4; i++) {
      pushHistory(h, x - Math.cos(a) * RECORD_INTERVAL * i, y - Math.sin(a) * RECORD_INTERVAL * i);
    }
    bot.headX = x;
    bot.headY = y;
    bot.angle = a;
    bot.targetAngle = a;
    bot.history = h;
    bot.lastRecordX = x;
    bot.lastRecordY = y;
    bot.segmentCount = 4;
    bot.alive = true;
    bot.score = 0;
    bot.boosting = false;
    bot.boostCooldown = 0;
  }

  // ==================== RENDERING ====================

  function getCamera(followX, followY) {
    var cx = clamp(followX, viewW / 2, MAP_W - viewW / 2);
    var cy = clamp(followY, viewH / 2, MAP_H - viewH / 2);
    return { x: cx - viewW / 2, y: cy - viewH / 2 };
  }

  function drawGrid(cam) {
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 0.5;
    var startX = Math.floor(cam.x / GRID_LINE_SPACING) * GRID_LINE_SPACING;
    var startY = Math.floor(cam.y / GRID_LINE_SPACING) * GRID_LINE_SPACING;
    for (var x = startX; x <= cam.x + viewW + GRID_LINE_SPACING; x += GRID_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x - cam.x, 0);
      ctx.lineTo(x - cam.x, viewH);
      ctx.stroke();
    }
    for (var y = startY; y <= cam.y + viewH + GRID_LINE_SPACING; y += GRID_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(0, y - cam.y);
      ctx.lineTo(viewW, y - cam.y);
      ctx.stroke();
    }
  }

  function drawBorder(cam) {
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 4;
    ctx.strokeRect(-cam.x, -cam.y, MAP_W, MAP_H);
  }

  function drawSnakeByData(segs, colorIdx, isPlayer, cam, totalSegs, isBoosting, hx, hy, hAngle) {
    if (typeof hx !== 'number' || typeof hy !== 'number') return;
    var pal = PALETTE[colorIdx] || PALETTE[0];
    var pr = parseInt(pal.primary.slice(1, 3), 16);
    var pg = parseInt(pal.primary.slice(3, 5), 16);
    var pb = parseInt(pal.primary.slice(5, 7), 16);
    var dr = parseInt(pal.dark.slice(1, 3), 16);
    var dg = parseInt(pal.dark.slice(3, 5), 16);
    var db = parseInt(pal.dark.slice(5, 7), 16);

    if (Array.isArray(segs)) {
      for (var i = segs.length - 1; i >= 0; i--) {
        var seg = segs[i];
        if (!seg || typeof seg.x !== 'number' || typeof seg.y !== 'number') continue;
        var sx = seg.x - cam.x;
        var sy = seg.y - cam.y;
        if (sx < -20 || sx > viewW + 20 || sy < -20 || sy > viewH + 20) continue;

        var ratio = totalSegs > 1 ? 1 - (i / (totalSegs - 1)) * 0.5 : 1;
        ctx.fillStyle = 'rgb(' + Math.floor(pr * ratio + dr * (1 - ratio)) + ',' +
          Math.floor(pg * ratio + dg * (1 - ratio)) + ',' +
          Math.floor(pb * ratio + db * (1 - ratio)) + ')';

        var segR = totalSegs > 1
          ? MAX_SEG_RADIUS - (i / (totalSegs - 1)) * (MAX_SEG_RADIUS - MIN_SEG_RADIUS)
          : MAX_SEG_RADIUS;

        ctx.beginPath();
        ctx.arc(sx, sy, segR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    var hxs = hx - cam.x;
    var hys = hy - cam.y;
    if (hxs < -30 || hxs > viewW + 30 || hys < -30 || hys > viewH + 30) return;

    if (isPlayer) {
      ctx.shadowColor = isBoosting ? '#ffaa00' : pal.primary;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = pal.primary;
    ctx.beginPath();
    ctx.arc(hxs, hys, HEAD_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (typeof hAngle !== 'number') hAngle = 0;
    var eyeOff = HEAD_RADIUS * 0.35;
    var eyeR = HEAD_RADIUS * 0.28;
    var pupilR = eyeR * 0.55;
    var fwdX = Math.cos(hAngle);
    var fwdY = Math.sin(hAngle);
    var perpX = -fwdY;
    var perpY = fwdX;

    var e1x = hxs + fwdX * eyeOff + perpX * eyeOff * 0.6;
    var e1y = hys + fwdY * eyeOff + perpY * eyeOff * 0.6;
    var e2x = hxs + fwdX * eyeOff - perpX * eyeOff * 0.6;
    var e2y = hys + fwdY * eyeOff - perpY * eyeOff * 0.6;

    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(e1x, e1y, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(e2x, e2y, eyeR, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(e1x + fwdX * 1.5, e1y + fwdY * 1.5, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(e2x + fwdX * 1.5, e2y + fwdY * 1.5, pupilR, 0, Math.PI * 2); ctx.fill();
  }

  function drawFoodList(foodList, cam) {
    if (!Array.isArray(foodList)) return;
    var now = performance.now();
    for (var i = 0; i < foodList.length; i++) {
      var f = foodList[i];
      if (!f || typeof f.x !== 'number' || typeof f.y !== 'number') continue;
      var fx = f.x - cam.x;
      var fy = f.y - cam.y;
      if (fx < -20 || fx > viewW + 20 || fy < -20 || fy > viewH + 20) continue;

      var pulse = 1 + Math.sin(now / 300 + f.x * 0.1) * 0.2;
      var r = (PICKUP_RADIUS * 0.45) * pulse;

      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawBoostBar() {
    if (!boostBar) return;
    var maxDisplay = 50;
    var pct = Math.min(score / maxDisplay, 1);
    boostBar.style.width = (pct * 100) + '%';
    boostBar.style.background = boosting ? '#ffaa00' : '#00ff88';
  }

  function updateLeaderboardSingle() {
    var entries = [];
    if (playerAlive) {
      entries.push({ name: 'You', len: segCount });
    }
    for (var i = 0; i < bots.length; i++) {
      if (bots[i].alive) {
        entries.push({ name: 'Bot ' + (i + 1), len: bots[i].segmentCount });
      }
    }
    entries.sort(function(a, b) { return b.len - a.len; });
    var top = entries.slice(0, 5);
    leaderboardEl.innerHTML = '<b>Leaderboard</b><br/>' +
      top.map(function(e, i) { return (i + 1) + '. ' + e.name + ' \u2014 ' + e.len; }).join('<br/>');
  }

  function drawFrameSingle() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, viewW, viewH);
    var cam = getCamera(headX, headY);
    drawGrid(cam);
    drawBorder(cam);
    drawFoodList(foods, cam);
    for (var i = 0; i < bots.length; i++) {
      var bot = bots[i];
      if (!bot.alive) continue;
      var botSegs = computeSegs(bot.history, bot.segmentCount);
      drawSnakeByData(botSegs, bot.color, false, cam, bot.segmentCount, bot.boosting, bot.headX, bot.headY, bot.angle);
    }
    if (playerAlive) {
      var playerSegs = computeSegs(snakeHistory, segCount);
      drawSnakeByData(playerSegs, playerColorIdx, true, cam, segCount, boosting, headX, headY, angle);
    }
    updateLeaderboardSingle();
    drawBoostBar();
  }

  function drawFrameMulti() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, viewW, viewH);
    var cam = getCamera(headX, headY);
    drawGrid(cam);
    drawBorder(cam);
    drawFoodList(remoteFoods, cam);
    if (Array.isArray(remoteSnakes)) {
      for (var i = 0; i < remoteSnakes.length; i++) {
        var rs = remoteSnakes[i];
        if (!rs || rs.id === myId) continue;
        if (!Array.isArray(rs.segments) || !rs.segments.length) continue;
        drawSnakeByData(rs.segments, rs.color, false, cam, rs.segments.length, rs.boosting, rs.x, rs.y, rs.angle);
      }
    }
    if (playerAlive && myId) {
      var me = null;
      if (Array.isArray(remoteSnakes)) {
        for (var j = 0; j < remoteSnakes.length; j++) {
          if (remoteSnakes[j].id === myId) { me = remoteSnakes[j]; break; }
        }
      }
      if (me && Array.isArray(me.segments)) {
        drawSnakeByData(me.segments, me.color, true, cam, me.segments.length, boosting, me.x, me.y, me.angle);
      }
    }
    drawBoostBar();
  }

  // ==================== GAME LOOPS ====================

  function loopSingle(timestamp) {
    if (!running) return;
    if (lastTime === 0) lastTime = timestamp;
    var dt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;

    computeKeyboardTarget();
    updatePlayer(dt);
    for (var i = 0; i < bots.length; i++) {
      updateBot(bots[i], dt);
    }

    try { drawFrameSingle(); } catch (e) { console.error('drawSingle error', e); }
    animFrameId = requestAnimationFrame(loopSingle);
  }

  function loopMulti(timestamp) {
    if (!running) return;
    if (lastTime === 0) lastTime = timestamp;
    lastTime = timestamp;

    computeKeyboardTarget();
    sendAngle();

    try { drawFrameMulti(); } catch (e) { console.error('drawMulti error', e); }
    animFrameId = requestAnimationFrame(loopMulti);
  }

  function startSinglePlayer() {
    cancelAnimationFrame(animFrameId);
    initSinglePlayer();
    running = true;
    lastTime = 0;
    overlay.classList.remove('active');
    animFrameId = requestAnimationFrame(loopSingle);
  }

  function startMultiplayer() {
    cancelAnimationFrame(animFrameId);
    remoteSnakes = [];
    remoteFoods = [];
    myId = null;
    headX = MAP_W / 2;
    headY = MAP_H / 2;
    angle = 0;
    targetAngle = 0;
    segCount = 4;
    score = 0;
    boosting = false;
    playerAlive = false;
    running = true;
    scoreEl.textContent = 'Score: 0';
    joinMultiplayer();
    overlay.classList.remove('active');
    lastTime = 0;
    animFrameId = requestAnimationFrame(loopMulti);
  }

  function gameOverSingle() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(animFrameId);
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('snake-io-hs', highScore);
      highScoreEl.textContent = 'Best: ' + highScore;
    }
    overlayMessage.innerHTML = 'Game Over! Score: ' + Math.round(score) +
      '<br/>Hold <b>Space</b> or <b>Shift</b> to boost (costs points)' +
      '<br/>Bigger score = bigger snake';
    startBtn.textContent = 'Play Again';
    overlay.classList.add('active');
  }

  function gameOverMulti() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(animFrameId);
    overlayMessage.innerHTML = 'Game Over! Score: ' + Math.round(score);
    startBtn.textContent = 'Respawn';
    overlay.classList.add('active');
  }

  function startGame() {
    if (gameMode === 'multi' && wsConnected && myId) {
      sendRespawn();
      playerAlive = true;
      running = true;
      boosting = false;
      overlay.classList.remove('active');
      lastTime = 0;
      animFrameId = requestAnimationFrame(loopMulti);
      return;
    }
    if (gameMode === 'single') {
      startSinglePlayer();
    } else {
      startMultiplayer();
    }
  }

  // ==================== KEYBOARD INPUT ====================

  function computeKeyboardTarget() {
    var kx = 0, ky = 0;
    if (keys['arrowleft'] || keys['a']) kx -= 1;
    if (keys['arrowright'] || keys['d']) kx += 1;
    if (keys['arrowup'] || keys['w']) ky -= 1;
    if (keys['arrowdown'] || keys['s']) ky += 1;
    if ((kx !== 0 || ky !== 0) && !mouseActive) {
      targetAngle = Math.atan2(ky, kx);
    }
  }

  document.addEventListener('keydown', function(e) {
    keys[e.key.toLowerCase()] = true;
    if (!playerAlive) return;
    var key = e.key.toLowerCase();
    if (key === ' ' || key === 'shift') {
      if (score >= MIN_BOOST_SCORE) {
        boosting = true;
        if (gameMode === 'multi') sendBoost(true);
      }
      e.preventDefault();
    }
  });

  document.addEventListener('keyup', function(e) {
    keys[e.key.toLowerCase()] = false;
    var key = e.key.toLowerCase();
    if (key === ' ' || key === 'shift') {
      boosting = false;
      if (gameMode === 'multi') sendBoost(false);
    }
  });

  // ==================== MOUSE INPUT ====================

  canvas.addEventListener('mousemove', function(e) {
    if (!playerAlive || !running) return;
    mouseActive = true;
    if (gameMode === 'single') {
      var cam = getCamera(headX, headY);
      var worldX = e.clientX + cam.x;
      var worldY = e.clientY + cam.y;
      targetAngle = Math.atan2(worldY - headY, worldX - headX);
    } else if (gameMode === 'multi') {
      var camM = getCamera(headX, headY);
      var wx = e.clientX + camM.x;
      var wy = e.clientY + camM.y;
      targetAngle = Math.atan2(wy - headY, wx - headX);
    }
  });

  canvas.addEventListener('mousedown', function(e) {
    if (!playerAlive || !running) return;
    if (e.button === 0) {
      if (score >= MIN_BOOST_SCORE) {
        boosting = true;
        if (gameMode === 'multi') sendBoost(true);
      }
    }
  });

  canvas.addEventListener('mouseup', function(e) {
    if (e.button === 0) {
      boosting = false;
      if (gameMode === 'multi') sendBoost(false);
    }
  });

  canvas.addEventListener('mouseleave', function() {
    mouseActive = false;
  });

  // ==================== TOUCH INPUT ====================

  var touchId = null;
  var touchCenter = { x: 0, y: 0 };
  var JOY_RADIUS = 65;
  var boostTouchId = null;

  function getJoystickCenter() {
    var rect = joystickBase.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function handleTouchStart(e) {
    if (!running || !playerAlive) return;
    e.preventDefault();
    for (var t = 0; t < e.changedTouches.length; t++) {
      var touch = e.changedTouches[t];
      var inBottom = touch.clientY > viewH * 0.5;
      if (inBottom && touchId === null) {
        touchId = touch.identifier;
        touchCenter = getJoystickCenter();
        joystickBase.classList.add('active');
      } else if (!inBottom && boostTouchId === null) {
        boostTouchId = touch.identifier;
        if (score >= MIN_BOOST_SCORE) {
          boosting = true;
          if (gameMode === 'multi') sendBoost(true);
        }
      }
    }
  }

  function handleTouchMove(e) {
    if (!running || !playerAlive) return;
    e.preventDefault();
    for (var t = 0; t < e.changedTouches.length; t++) {
      var touch = e.changedTouches[t];
      if (touch.identifier !== touchId) continue;
      var dx = touch.clientX - touchCenter.x;
      var dy = touch.clientY - touchCenter.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var clamped = Math.min(d, JOY_RADIUS);
      var joyAngle = Math.atan2(dy, dx);
      var kx = Math.cos(joyAngle) * clamped;
      var ky = Math.sin(joyAngle) * clamped;

      joystickKnob.style.transform = 'translate(' + kx + 'px,' + ky + 'px)';

      if (d > 10) {
        mouseActive = false;
        targetAngle = joyAngle;
      }
    }
  }

  function handleTouchEnd(e) {
    e.preventDefault();
    for (var t = 0; t < e.changedTouches.length; t++) {
      var touch = e.changedTouches[t];
      if (touch.identifier === touchId) {
        touchId = null;
        joystickBase.classList.remove('active');
        joystickKnob.style.transform = 'translate(0, 0)';
      }
      if (touch.identifier === boostTouchId) {
        boostTouchId = null;
        boosting = false;
        if (gameMode === 'multi') sendBoost(false);
      }
    }
  }

  joystickZone.addEventListener('touchstart', handleTouchStart, { passive: false });
  joystickZone.addEventListener('touchmove', handleTouchMove, { passive: false });
  joystickZone.addEventListener('touchend', handleTouchEnd, { passive: false });
  joystickZone.addEventListener('touchcancel', handleTouchEnd, { passive: false });

  // ==================== MULTIPLAYER ====================

  function preconnectMultiplayer() {
    if (ws && ws.readyState <= 1) return;
    statusMsg.textContent = 'Connecting to server...';
    wsConnected = false;

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      statusMsg.textContent = 'Connection failed';
      return;
    }

    ws.onopen = function() {
      wsConnected = true;
      statusMsg.textContent = 'Connected! Press Play to join.';
      if (pendingJoin) {
        pendingJoin = false;
        joinMultiplayer();
      }
    };

    ws.onmessage = function(evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      handleServerMessage(msg);
    };

    ws.onclose = function() {
      wsConnected = false;
      if (gameMode === 'multi') {
        statusMsg.textContent = 'Disconnected. Reconnecting...';
        setTimeout(function() {
          if (gameMode === 'multi') preconnectMultiplayer();
        }, 2000);
      } else {
        statusMsg.textContent = '';
      }
    };

    ws.onerror = function() {
      statusMsg.textContent = 'Connection failed';
    };
  }

  function joinMultiplayer() {
    var name = playerNameInput.value.trim() || 'Player';
    localStorage.setItem('snake-io-name', name);

    if (!wsConnected || !ws || ws.readyState !== 1) {
      pendingJoin = true;
      preconnectMultiplayer();
      return;
    }

    pendingJoin = false;
    ws.send(JSON.stringify({ type: 'join', color: playerColorIdx, name: name }));
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        statusMsg.textContent = '';
        running = true;
        playerAlive = true;
        overlay.classList.remove('active');
        break;

      case 'state':
        remoteSnakes = msg.snakes || [];
        remoteFoods = msg.foods || [];
        var me = null;
        for (var i = 0; i < remoteSnakes.length; i++) {
          if (remoteSnakes[i].id === myId) { me = remoteSnakes[i]; break; }
        }
        if (me) {
          headX = me.x;
          headY = me.y;
          angle = me.angle;
          segCount = me.segments ? me.segments.length : 0;
          score = me.score;
          scoreEl.textContent = 'Score: ' + Math.round(score);
        }
        break;

      case 'leaderboard':
        if (msg.entries) {
          var top = msg.entries.slice(0, 8);
          leaderboardEl.innerHTML = '<b>Leaderboard</b><br/>' +
            top.map(function(e, i) {
              var label = e.id === myId ? ' (You)' : '';
              return (i + 1) + '. ' + e.name + label + ' \u2014 ' + e.len;
            }).join('<br/>');
        }
        break;

      case 'died':
        playerAlive = false;
        score = msg.score || 0;
        gameOverMulti();
        break;

      case 'playerJoin':
      case 'playerLeave':
        break;

      case 'error':
        statusMsg.textContent = msg.message || 'Server error';
        break;
    }
  }

  function sendAngle() {
    try {
      if (ws && ws.readyState === 1 && playerAlive) {
        ws.send(JSON.stringify({ type: 'angle', angle: targetAngle }));
      }
    } catch (e) {}
  }

  function sendBoost(on) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'boost', on: on }));
      }
    } catch (e) {}
  }

  function sendRespawn() {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'respawn' }));
      }
    } catch (e) {}
  }

  // ==================== START ====================

  startBtn.addEventListener('click', startGame);
})();
