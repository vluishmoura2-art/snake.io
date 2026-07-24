(() => {
  var canvas = document.getElementById('game-canvas');
  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('overlay');
  var overlayMessage = document.getElementById('overlay-message');
  var startBtn = document.getElementById('start-btn');
  var scoreEl = document.getElementById('score');
  var highScoreEl = document.getElementById('high-score');
  var leaderboardEl = document.getElementById('leaderboard');
  var boostBar = document.getElementById('boost-fill');
  var joystickZone = document.getElementById('joystick-zone');
  var joystickBase = document.getElementById('joystick-base');
  var joystickKnob = document.getElementById('joystick-knob');
  var colorSwatches = document.getElementById('color-swatches');
  var modeBtns = document.querySelectorAll('.mode-btn');
  var playerNameInput = document.getElementById('player-name');
  var statusMsg = document.getElementById('status-msg');

  var MAP_W = 4000;
  var MAP_H = 4000;
  var BASE_SPEED = 120;
  var BOOST_SPEED = 220;
  var ROTATION_SPEED = 3.0;
  var HEAD_RADIUS = 10;
  var SEGMENT_RADIUS = 13.125;
  var SEGMENT_OVERLAP_RATIO = 0.70;
  var BASE_SEGMENT_DISTANCE = SEGMENT_RADIUS * 2 * (1 - SEGMENT_OVERLAP_RATIO);
  var PICKUP_RADIUS = 14;
  var FOOD_COUNT = 150;
  var MAX_FOOD = 500;
  var BOOST_COST_PER_SEC = 10;
  var MIN_BOOST_SCORE = 5;
  var DROP_FOOD_RATIO = 1.0;
  var BOT_COUNT = 7;
  var MAX_SEGMENTS = 200;
  var SPAWN_MARGIN = 300;
  var SEG_RADIUS = 13.125;
  var GRID_SPACING = 100;

  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

  var PALETTE = [
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
    { name: 'Teal',   primary: '#00bfa5', dark: '#009977' }
  ];

  var SKINS = [
    { id: 'classic',  name: 'Classic',  spikes: null, scales: null, tail: 'round', head: 'default' },
    { id: 'spiky',    name: 'Spiky',    spikes: { count: 2, len: 0.55, width: 0.25 }, scales: null, tail: 'stinger', head: 'fangs' },
    { id: 'scaly',    name: 'Scaly',    spikes: null, scales: { freq: 0.5, opacity: 0.18 }, tail: 'round', head: 'default' },
    { id: 'armored',  name: 'Armored',  spikes: { count: 1, len: 0.3, width: 0.5 }, scales: { freq: 0.7, opacity: 0.12 }, tail: 'stinger', head: 'horns' },
    { id: 'serpent',  name: 'Serpent',  spikes: null, scales: { freq: 0.35, opacity: 0.22 }, tail: 'forked', head: 'fangs' },
    { id: 'royal',    name: 'Royal',    spikes: { count: 3, len: 0.4, width: 0.18 }, scales: null, tail: 'stinger', head: 'horns' },
  ];

  var viewW, viewH;
  var score, highScore, running, animFrameId;
  var playerAlive, boosting;
  var playerColorIdx;
  var lastTime = 0;
  var gameMode = 'single';
  var ws = null;
  var myId = null;
  var wsConnected = false;
  var pendingJoin = false;
  var remoteSnakes = [];
  var remoteFoods = [];
  var headX, headY, angle, targetAngle;
  var playerSegments;
  var bots, foods;
  var keys = {};
  var mouseActive = false;
  var playerSkinIdx = 0;

  highScore = +(localStorage.getItem('snake-io-hs') || 0);
  highScoreEl.textContent = 'Best: ' + highScore;
  playerColorIdx = +(localStorage.getItem('snake-io-color') || 0);
  if (playerColorIdx < 0 || playerColorIdx >= PALETTE.length) playerColorIdx = 0;
  playerNameInput.value = localStorage.getItem('snake-io-name') || '';

  function buildColorPicker() {
    colorSwatches.innerHTML = '';
    PALETTE.forEach(function(c, i) {
      var el = document.createElement('div');
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

  var skinSwatches = document.getElementById('skin-swatches');
  function buildSkinPicker() {
    skinSwatches.innerHTML = '';
    SKINS.forEach(function(s, i) {
      var btn = document.createElement('button');
      btn.className = 'skin-btn' + (i === playerSkinIdx ? ' active' : '');
      btn.textContent = s.name;
      btn.addEventListener('click', function() {
        playerSkinIdx = i;
        skinSwatches.querySelectorAll('.skin-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
      skinSwatches.appendChild(btn);
    });
  }
  buildSkinPicker();

  modeBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      gameMode = btn.dataset.mode;
      modeBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (gameMode === 'multi' && !wsConnected) preconnectMultiplayer();
    });
  });

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function angleDiff(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function distSq(x1, y1, x2, y2) { var dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; }
  function randFloat(lo, hi) { return lo + Math.random() * (hi - lo); }

  function createSegments(x, y, ang, count) {
    var segs = [];
    for (var i = 0; i < count; i++) {
      segs.push({
        x: x - Math.cos(ang) * BASE_SEGMENT_DISTANCE * i,
        y: y - Math.sin(ang) * BASE_SEGMENT_DISTANCE * i
      });
    }
    return segs;
  }

  function followLeader(segments, headAngle) {
    for (var i = 1; i < segments.length; i++) {
      var prev = segments[i - 1];
      var curr = segments[i];
      var dx = prev.x - curr.x;
      var dy = prev.y - curr.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var direction;
      if (dist > 0.001) {
        direction = Math.atan2(dy, dx);
      } else {
        var leaderAngle = i === 1
          ? headAngle
          : Math.atan2(segments[i - 2].y - prev.y, segments[i - 2].x - prev.x);
        direction = leaderAngle;
      }
      curr.x = prev.x - Math.cos(direction) * BASE_SEGMENT_DISTANCE;
      curr.y = prev.y - Math.sin(direction) * BASE_SEGMENT_DISTANCE;
    }
  }

  function addTailSegment(segments, fallbackAngle) {
    var tail = segments[segments.length - 1];
    var beforeTail = segments[segments.length - 2];
    var tailAngle = beforeTail
      ? Math.atan2(beforeTail.y - tail.y, beforeTail.x - tail.x)
      : fallbackAngle;
    segments.push({
      x: tail.x - Math.cos(tailAngle) * BASE_SEGMENT_DISTANCE,
      y: tail.y - Math.sin(tailAngle) * BASE_SEGMENT_DISTANCE
    });
  }

  function spawnFood(x, y) {
    return {
      x: x !== undefined ? x : randFloat(50, MAP_W - 50),
      y: y !== undefined ? y : randFloat(50, MAP_H - 50)
    };
  }

  function dropFoodFromSegments(segs) {
    var count = Math.floor(segs.length * DROP_FOOD_RATIO);
    if (count === 0) return;
    var step = Math.max(1, Math.floor(segs.length / count));
    var placed = 0;
    for (var i = 0; i < segs.length && placed < count; i += step) {
      if (foods.length < MAX_FOOD) { foods.push(spawnFood(segs[i].x, segs[i].y)); placed++; }
    }
  }

  var PICKUP_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
  var HEAD_COL_SQ = (HEAD_RADIUS + SEGMENT_RADIUS) * (HEAD_RADIUS + SEGMENT_RADIUS);

  function headHitsSegments(segs, startIdx) {
    for (var i = startIdx; i < segs.length; i++) {
      if (distSq(headX, headY, segs[i].x, segs[i].y) < HEAD_COL_SQ) return true;
    }
    return false;
  }

  function initSinglePlayer() {
    headX = MAP_W / 2;
    headY = MAP_H / 2;
    angle = Math.random() * Math.PI * 2;
    targetAngle = angle;
    playerSegments = createSegments(headX, headY, angle, 4);
    score = 0;
    boosting = false;
    playerAlive = true;
    scoreEl.textContent = 'Score: 0';

    bots = [];
    for (var b = 0; b < BOT_COUNT; b++) {
      var bA = Math.random() * Math.PI * 2;
      var bx = randFloat(SPAWN_MARGIN, MAP_W - SPAWN_MARGIN);
      var by = randFloat(SPAWN_MARGIN, MAP_H - SPAWN_MARGIN);
      bots.push({
        headX: bx, headY: by, angle: bA, targetAngle: bA,
        segments: createSegments(bx, by, bA, 4),
        color: b % PALETTE.length,
        skinIdx: Math.floor(Math.random() * SKINS.length),
        alive: true, score: 0, boosting: false, boostCooldown: 0
      });
    }
    foods = [];
    for (var f = 0; f < FOOD_COUNT; f++) foods.push(spawnFood());
  }

  function updatePlayer(dt) {
    if (!playerAlive) return;
    var diff = angleDiff(angle, targetAngle);
    var maxTurn = ROTATION_SPEED * dt;
    if (Math.abs(diff) > maxTurn) diff = Math.sign(diff) * maxTurn;
    angle += diff;

    if (boosting && score >= MIN_BOOST_SCORE) {
      score -= BOOST_COST_PER_SEC * dt;
      if (score < 0) score = 0;
    } else if (boosting) { boosting = false; }

    var speed = boosting ? BOOST_SPEED : BASE_SPEED;
    headX += Math.cos(angle) * speed * dt;
    headY += Math.sin(angle) * speed * dt;
    headX = clamp(headX, 0, MAP_W);
    headY = clamp(headY, 0, MAP_H);

    playerSegments[0].x = headX;
    playerSegments[0].y = headY;
    followLeader(playerSegments, angle);

    if (headX <= 0 || headX >= MAP_W || headY <= 0 || headY >= MAP_H) { diePlayer(); return; }
    for (var b = 0; b < bots.length; b++) {
      if (bots[b].alive && headHitsSegments(bots[b].segments, 1)) { diePlayer(); return; }
    }

    var ate = 0;
    for (var i = foods.length - 1; i >= 0; i--) {
      if (distSq(headX, headY, foods[i].x, foods[i].y) < PICKUP_SQ) {
        foods.splice(i, 1); ate++;
        if (foods.length < MAX_FOOD) foods.push(spawnFood());
      }
    }
    if (ate > 0) {
      for (var a = 0; a < ate && playerSegments.length < MAX_SEGMENTS; a++) {
        addTailSegment(playerSegments, angle);
      }
      score += ate;
    }
    scoreEl.textContent = 'Score: ' + Math.round(score);
  }

  function diePlayer() {
    playerAlive = false;
    dropFoodFromSegments(playerSegments);
    gameOverSingle();
  }

  function updateBot(bot, dt) {
    if (!bot.alive) return;
    var bestDist = Infinity, bestAngle = 0;
    for (var i = 0; i < foods.length; i++) {
      var d = distSq(bot.headX, bot.headY, foods[i].x, foods[i].y);
      if (d < bestDist) { bestDist = d; bestAngle = Math.atan2(foods[i].y - bot.headY, foods[i].x - bot.headX); }
    }
    var futureX = bot.headX + Math.cos(bot.targetAngle) * 150;
    var futureY = bot.headY + Math.sin(bot.targetAngle) * 150;
    if (futureX < 150 || futureX > MAP_W - 150 || futureY < 150 || futureY > MAP_H - 150) {
      bot.targetAngle = Math.atan2(MAP_H / 2 - bot.headY, MAP_W / 2 - bot.headX);
    } else { bot.targetAngle = bestAngle; }
    if (Math.random() < 0.015) bot.targetAngle += (Math.random() - 0.5) * 1.2;

    var diff = angleDiff(bot.angle, bot.targetAngle);
    var maxTurn = ROTATION_SPEED * dt;
    if (Math.abs(diff) > maxTurn) diff = Math.sign(diff) * maxTurn;
    bot.angle += diff;

    if (bot.boostCooldown > 0) { bot.boostCooldown -= dt; bot.boosting = false; }
    else if (bot.segments.length > 6 && bestDist > 225 && Math.random() < 0.03) { bot.boosting = true; }
    else if (bot.boosting && (bestDist < 25 || bot.segments.length <= 4)) { bot.boosting = false; bot.boostCooldown = 3; }

    var speed = bot.boosting ? BOOST_SPEED : BASE_SPEED;
    bot.headX += Math.cos(bot.angle) * speed * dt;
    bot.headY += Math.sin(bot.angle) * speed * dt;
    bot.headX = clamp(bot.headX, 0, MAP_W);
    bot.headY = clamp(bot.headY, 0, MAP_H);

    bot.segments[0].x = bot.headX;
    bot.segments[0].y = bot.headY;
    followLeader(bot.segments, bot.angle);

    if (bot.headX <= 0 || bot.headX >= MAP_W || bot.headY <= 0 || bot.headY >= MAP_H) { respawnBot(bot); return; }
    if (playerAlive) {
      for (var si = 1; si < playerSegments.length; si++) {
        if (distSq(bot.headX, bot.headY, playerSegments[si].x, playerSegments[si].y) < HEAD_COL_SQ) { respawnBot(bot); return; }
      }
      if (headHitsSegments(bot.segments, 1)) { diePlayer(); return; }
    }
    var ate = 0;
    for (var fi = foods.length - 1; fi >= 0; fi--) {
      if (distSq(bot.headX, bot.headY, foods[fi].x, foods[fi].y) < PICKUP_SQ) {
        foods.splice(fi, 1); ate++;
        if (foods.length < MAX_FOOD) foods.push(spawnFood());
      }
    }
    if (ate > 0) {
      for (var ai = 0; ai < ate && bot.segments.length < MAX_SEGMENTS; ai++) {
        addTailSegment(bot.segments, bot.angle);
      }
      bot.score += ate;
    }
  }

  function respawnBot(bot) {
    dropFoodFromSegments(bot.segments);
    var a = Math.random() * Math.PI * 2;
    var x = randFloat(SPAWN_MARGIN, MAP_W - SPAWN_MARGIN);
    var y = randFloat(SPAWN_MARGIN, MAP_H - SPAWN_MARGIN);
    bot.headX = x; bot.headY = y; bot.angle = a; bot.targetAngle = a;
    bot.segments = createSegments(x, y, a, 4);
    bot.alive = true; bot.score = 0; bot.boosting = false; bot.boostCooldown = 0;
  }
  function getCamera(followX, followY) {
    var cx = clamp(followX, viewW / 2, MAP_W - viewW / 2);
    var cy = clamp(followY, viewH / 2, MAP_H - viewH / 2);
    return { x: cx - viewW / 2, y: cy - viewH / 2 };
  }

  function drawGrid(cam) {
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 0.5;
    var startX = Math.floor(cam.x / GRID_SPACING) * GRID_SPACING;
    var startY = Math.floor(cam.y / GRID_SPACING) * GRID_SPACING;
    for (var x = startX; x <= cam.x + viewW + GRID_SPACING; x += GRID_SPACING) {
      ctx.beginPath(); ctx.moveTo(x - cam.x, 0); ctx.lineTo(x - cam.x, viewH); ctx.stroke();
    }
    for (var y = startY; y <= cam.y + viewH + GRID_SPACING; y += GRID_SPACING) {
      ctx.beginPath(); ctx.moveTo(0, y - cam.y); ctx.lineTo(viewW, y - cam.y); ctx.stroke();
    }
  }

  function drawBorder(cam) {
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 4;
    ctx.strokeRect(-cam.x, -cam.y, MAP_W, MAP_H);
  }

  function drawSpikes(segR, spikeDef) {
    if (!spikeDef) return;
    var count = spikeDef.count;
    var spikeLen = segR * spikeDef.len;
    var spikeW = segR * spikeDef.width;
    var span = segR * 0.7;
    for (var side = -1; side <= 1; side += 2) {
      for (var j = 0; j < count; j++) {
        var offset = count === 1 ? 0 : (j / (count - 1) * 2 - 1) * span;
        ctx.beginPath();
        ctx.moveTo(offset - spikeW * 0.5, 0);
        ctx.lineTo(offset + spikeW * 0.5, 0);
        ctx.lineTo(offset, -spikeLen * side);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function drawScales(segR, scaleDef) {
    if (!scaleDef) return;
    var spacing = segR * scaleDef.freq;
    ctx.globalAlpha = scaleDef.opacity;
    for (var x = -segR + spacing * 0.5; x < segR; x += spacing) {
      for (var side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.arc(x, side * segR * 0.25, segR * 0.32, 0, Math.PI, side < 0);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawTailTip(segR, darkColor, tailStyle) {
    if (tailStyle === 'stinger') {
      ctx.beginPath();
      ctx.moveTo(segR * 0.4, -segR * 0.3);
      ctx.lineTo(segR * 0.4, segR * 0.3);
      ctx.lineTo(segR * 1.4, 0);
      ctx.closePath();
      ctx.fill();
    } else if (tailStyle === 'forked') {
      ctx.beginPath();
      ctx.moveTo(-segR * 0.2, 0);
      ctx.lineTo(segR * 0.6, -segR * 0.7);
      ctx.lineTo(segR * 0.8, -segR * 0.3);
      ctx.lineTo(segR * 0.4, 0);
      ctx.lineTo(segR * 0.8, segR * 0.3);
      ctx.lineTo(segR * 0.6, segR * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawHeadFeatures(segR, rot, headStyle, pal) {
    var fwdX = 1;
    var fwdY = 0;
    var perpX = 0;
    var perpY = 1;

    if (headStyle === 'horns') {
      ctx.fillStyle = pal.dark;
      for (var side = -1; side <= 1; side += 2) {
        var hx = -segR * 0.2;
        var hy = side * segR * 0.55;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - segR * 0.7, hy + side * segR * 0.4);
        ctx.lineTo(hx - segR * 0.5, hy);
        ctx.closePath();
        ctx.fill();
      }
    }

    var eyeOff = segR * 0.35;
    var eyeR = segR * 0.28;
    var pupilR = eyeR * 0.55;
    var e1x = fwdX * eyeOff + perpX * eyeOff * 0.6;
    var e1y = fwdY * eyeOff + perpY * eyeOff * 0.6;
    var e2x = fwdX * eyeOff - perpX * eyeOff * 0.6;
    var e2y = fwdY * eyeOff - perpY * eyeOff * 0.6;

    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(e1x, e1y, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(e2x, e2y, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(e1x + fwdX * 1.5, e1y + fwdY * 1.5, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(e2x + fwdX * 1.5, e2y + fwdY * 1.5, pupilR, 0, Math.PI * 2); ctx.fill();

    if (headStyle === 'fangs') {
      ctx.fillStyle = '#fff';
      for (var fs = -1; fs <= 1; fs += 2) {
        var fx = fwdX * segR * 0.6 + perpX * segR * 0.2 * fs;
        var fy = fwdY * segR * 0.6 + perpY * segR * 0.2 * fs;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + fwdX * segR * 0.35 + perpX * segR * 0.08 * fs, fy + fwdY * segR * 0.35 + perpY * segR * 0.08 * fs);
        ctx.lineTo(fx + perpX * segR * 0.06 * fs, fy + perpY * segR * 0.06 * fs);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function drawSnakeByData(segs, colorIdx, isPlayer, cam, isBoosting, hx, hy, hAngle, skinIdx) {
    if (!Array.isArray(segs) || !segs.length) return;
    if (typeof hx !== 'number' || typeof hy !== 'number') return;

    var pal = PALETTE[colorIdx] || PALETTE[0];
    var pr = parseInt(pal.primary.slice(1, 3), 16);
    var pg = parseInt(pal.primary.slice(3, 5), 16);
    var pb = parseInt(pal.primary.slice(5, 7), 16);
    var dr = parseInt(pal.dark.slice(1, 3), 16);
    var dg = parseInt(pal.dark.slice(3, 5), 16);
    var db = parseInt(pal.dark.slice(5, 7), 16);
    var n = segs.length;
    var skin = SKINS[skinIdx || 0] || SKINS[0];
    var now = performance.now();

    for (var i = n - 1; i >= 0; i--) {
      var seg = segs[i];
      if (!seg || typeof seg.x !== 'number' || typeof seg.y !== 'number') continue;
      var sx = seg.x - cam.x;
      var sy = seg.y - cam.y;
      if (sx < -40 || sx > viewW + 40 || sy < -40 || sy > viewH + 40) continue;

      var t = n > 1 ? i / (n - 1) : 0;
      var segR = SEG_RADIUS;

      var colorRatio = 1 - t * 0.5;
      var r = Math.floor(pr * colorRatio + dr * (1 - colorRatio));
      var g = Math.floor(pg * colorRatio + dg * (1 - colorRatio));
      var b = Math.floor(pb * colorRatio + db * (1 - colorRatio));

      var rot;
      if (i === 0) { rot = hAngle; }
      else { var prev = segs[i - 1]; rot = Math.atan2(prev.y - seg.y, prev.x - seg.x); }

      if (isPlayer && i === 0) {
        ctx.shadowColor = isBoosting ? '#ffaa00' : pal.primary;
        ctx.shadowBlur = 14;
      }

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(rot);

      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.beginPath();
      ctx.arc(0, 0, segR, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgb(' + Math.floor(r * 0.7) + ',' + Math.floor(g * 0.7) + ',' + Math.floor(b * 0.7) + ')';
      ctx.lineWidth = Math.max(1, segR * 0.12);

      if (skin.spikes && i > 0 && i < n - 1) {
        ctx.fillStyle = 'rgb(' + Math.floor(r * 0.85) + ',' + Math.floor(g * 0.85) + ',' + Math.floor(b * 0.85) + ')';
        drawSpikes(segR, skin.spikes);
      }

      if (skin.scales && i > 0) {
        drawScales(segR, skin.scales);
      }

      if (i === n - 1 && skin.tail !== 'round') {
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        drawTailTip(segR, pal.dark, skin.tail);
      }

      if (i === 0) {
        drawHeadFeatures(segR, rot, skin.head, pal);
      }

      ctx.restore();
      ctx.shadowBlur = 0;
    }
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
      var r = PICKUP_RADIUS * 0.45 * pulse;
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
    var pct = Math.min(score / 50, 1);
    boostBar.style.width = (pct * 100) + '%';
    boostBar.style.background = boosting ? '#ffaa00' : '#00ff88';
  }

  function updateLeaderboardSingle() {
    var entries = [];
    if (playerAlive) entries.push({ name: 'You', len: playerSegments.length });
    for (var i = 0; i < bots.length; i++) {
      if (bots[i].alive) entries.push({ name: 'Bot ' + (i + 1), len: bots[i].segments.length });
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
      if (bot.alive) drawSnakeByData(bot.segments, bot.color, false, cam, bot.boosting, bot.headX, bot.headY, bot.angle, bot.skinIdx || 0);
    }
    if (playerAlive) drawSnakeByData(playerSegments, playerColorIdx, true, cam, boosting, headX, headY, angle, playerSkinIdx);
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
        if (!rs || rs.id === myId || !Array.isArray(rs.segments) || !rs.segments.length) continue;
        drawSnakeByData(rs.segments, rs.color, false, cam, rs.boosting, rs.x, rs.y, rs.angle, rs.skinIdx || 0);
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
        drawSnakeByData(me.segments, me.color, true, cam, boosting, me.x, me.y, me.angle, playerSkinIdx);
      }
    }
    drawBoostBar();
  }

  function loopSingle(timestamp) {
    if (!running) return;
    if (lastTime === 0) lastTime = timestamp;
    var dt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;
    computeKeyboardTarget();
    updatePlayer(dt);
    for (var i = 0; i < bots.length; i++) updateBot(bots[i], dt);
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
    playerSegments = createSegments(headX, headY, 0, 4);
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
    if (gameMode === 'single') startSinglePlayer();
    else startMultiplayer();
  }

  function computeKeyboardTarget() {
    var kx = 0, ky = 0;
    if (keys['arrowleft'] || keys['a']) kx -= 1;
    if (keys['arrowright'] || keys['d']) kx += 1;
    if (keys['arrowup'] || keys['w']) ky -= 1;
    if (keys['arrowdown'] || keys['s']) ky += 1;
    if ((kx !== 0 || ky !== 0) && !mouseActive) targetAngle = Math.atan2(ky, kx);
  }

  document.addEventListener('keydown', function(e) {
    keys[e.key.toLowerCase()] = true;
    if (!playerAlive) return;
    var key = e.key.toLowerCase();
    if (key === ' ' || key === 'shift') {
      if (score >= MIN_BOOST_SCORE) { boosting = true; if (gameMode === 'multi') sendBoost(true); }
      e.preventDefault();
    }
  });

  document.addEventListener('keyup', function(e) {
    keys[e.key.toLowerCase()] = false;
    var key = e.key.toLowerCase();
    if (key === ' ' || key === 'shift') { boosting = false; if (gameMode === 'multi') sendBoost(false); }
  });

  canvas.addEventListener('mousemove', function(e) {
    if (!playerAlive || !running) return;
    mouseActive = true;
    var cam = getCamera(headX, headY);
    var wx = e.clientX + cam.x;
    var wy = e.clientY + cam.y;
    targetAngle = Math.atan2(wy - headY, wx - headX);
  });

  canvas.addEventListener('mousedown', function(e) {
    if (!playerAlive || !running) return;
    if (e.button === 0 && score >= MIN_BOOST_SCORE) {
      boosting = true;
      if (gameMode === 'multi') sendBoost(true);
    }
  });

  canvas.addEventListener('mouseup', function(e) {
    if (e.button === 0) { boosting = false; if (gameMode === 'multi') sendBoost(false); }
  });

  canvas.addEventListener('mouseleave', function() { mouseActive = false; });

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
        if (score >= MIN_BOOST_SCORE) { boosting = true; if (gameMode === 'multi') sendBoost(true); }
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
      if (d > 10) { mouseActive = false; targetAngle = joyAngle; }
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

  function preconnectMultiplayer() {
    if (ws && ws.readyState <= 1) return;
    statusMsg.textContent = 'Connecting to server...';
    wsConnected = false;
    try { ws = new WebSocket(WS_URL); } catch (e) { statusMsg.textContent = 'Connection failed'; return; }

    ws.onopen = function() {
      wsConnected = true;
      statusMsg.textContent = 'Connected! Press Play to join.';
      if (pendingJoin) { pendingJoin = false; joinMultiplayer(); }
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
        setTimeout(function() { if (gameMode === 'multi') preconnectMultiplayer(); }, 2000);
      } else { statusMsg.textContent = ''; }
    };
    ws.onerror = function() { statusMsg.textContent = 'Connection failed'; };
  }

  function joinMultiplayer() {
    var name = playerNameInput.value.trim() || 'Player';
    localStorage.setItem('snake-io-name', name);
    if (!wsConnected || !ws || ws.readyState !== 1) { pendingJoin = true; preconnectMultiplayer(); return; }
    pendingJoin = false;
    ws.send(JSON.stringify({ type: 'join', color: playerColorIdx, name: name, skinIdx: playerSkinIdx }));
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
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'boost', on: on })); } catch (e) {}
  }

  function sendRespawn() {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'respawn' })); } catch (e) {}
  }

  startBtn.addEventListener('click', startGame);
})();
