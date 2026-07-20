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

  const GRID = 20;
  const MAP_COLS = 200;
  const MAP_ROWS = 200;
  const MAP_W = MAP_COLS * GRID;
  const MAP_H = MAP_ROWS * GRID;
  const TICK_MS = 100;
  const BOOST_TICK_MS = 55;
  const BOOST_COST = 1;
  const MIN_BOOST_SCORE = 5;
  const BOT_COUNT = 7;
  const FOOD_COUNT = 80;
  const MAX_FOOD = 300;
  const DROP_FOOD_RATIO = 0.6;
  const MAX_SEGMENT_SIZE = 30;
  const MIN_SEGMENT_SIZE = 16;
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

  const PALETTE = [
    { name: 'Green',    primary: '#00cc66', dark: '#009944' },
    { name: 'Blue',     primary: '#3399ff', dark: '#2277cc' },
    { name: 'Red',      primary: '#ff4444', dark: '#cc2222' },
    { name: 'Orange',   primary: '#ff8800', dark: '#cc6600' },
    { name: 'Pink',     primary: '#ff55cc', dark: '#cc33aa' },
    { name: 'Purple',   primary: '#aa55ff', dark: '#8833cc' },
    { name: 'Cyan',     primary: '#00ddcc', dark: '#00aa99' },
    { name: 'Yellow',   primary: '#ffdd00', dark: '#ccaa00' },
    { name: 'Lime',     primary: '#aaff00', dark: '#88cc00' },
    { name: 'White',    primary: '#eeeeee', dark: '#bbbbbb' },
    { name: 'Coral',    primary: '#ff7777', dark: '#cc4444' },
    { name: 'Teal',     primary: '#00bfa5', dark: '#009977' },
  ];

  let viewW, viewH;
  let snake, direction, nextDirection;
  let score, highScore, loopId, running;
  let bots, foods, playerAlive;
  let boosting, boostCooldown;
  let playerColorIdx;

  let gameMode = 'single';
  let ws = null;
  let myId = null;
  let remoteSnakes = [];
  let remoteFoods = [];
  let wsConnected = false;
  let pendingJoin = false;

  highScore = +(localStorage.getItem('snake-io-hs') || 0);
  highScoreEl.textContent = `Best: ${highScore}`;

  playerColorIdx = +(localStorage.getItem('snake-io-color') || 0);
  if (playerColorIdx < 0 || playerColorIdx >= PALETTE.length) playerColorIdx = 0;

  playerNameInput.value = localStorage.getItem('snake-io-name') || '';

  function buildColorPicker() {
    colorSwatches.innerHTML = '';
    PALETTE.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'color-swatch' + (i === playerColorIdx ? ' selected' : '');
      el.style.background = c.primary;
      el.title = c.name;
      el.addEventListener('click', () => {
        playerColorIdx = i;
        localStorage.setItem('snake-io-color', i);
        colorSwatches.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        el.classList.add('selected');
      });
      colorSwatches.appendChild(el);
    });
  }
  buildColorPicker();

  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      gameMode = btn.dataset.mode;
      modeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (gameMode === 'multi' && !wsConnected) {
        preconnectMultiplayer();
      }
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

  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function segmentSize(length) {
    const t = Math.min(length / 60, 1);
    return MIN_SEGMENT_SIZE + (MAX_SEGMENT_SIZE - MIN_SEGMENT_SIZE) * t;
  }

  function spawnSnake(startX, startY, len) {
    const s = [];
    const dx = [-1, 0, 1, 0][randInt(4)];
    const dy = [0, -1, 0, 1][randInt(4)];
    for (let i = 0; i < len; i++) {
      s.push({ x: startX - dx * i, y: startY - dy * i });
    }
    return {
      segments: s,
      dir: { x: dx || 1, y: dy },
      nextDir: { x: dx || 1, y: dy },
      alive: true,
      color: 0,
      boosting: false,
      boostCooldown: 0,
    };
  }

  function spawnFood(x, y) {
    return {
      x: x !== undefined ? x : randInt(MAP_COLS),
      y: y !== undefined ? y : randInt(MAP_ROWS),
      pulse: Math.random() * Math.PI * 2,
    };
  }

  function isOccupied(x, y) {
    if (snake.segments.some((s) => s.x === x && s.y === y)) return true;
    for (const b of bots) {
      if (b.alive && b.segments.some((s) => s.x === x && s.y === y)) return true;
    }
    return false;
  }

  function init() {
    const cx = Math.floor(MAP_COLS / 2);
    const cy = Math.floor(MAP_ROWS / 2);
    snake = {
      segments: [
        { x: cx, y: cy },
        { x: cx - 1, y: cy },
        { x: cx - 2, y: cy },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      alive: true,
      color: playerColorIdx,
      boosting: false,
      boostCooldown: 0,
    };
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
    score = 0;
    boosting = false;
    boostCooldown = 0;
    playerAlive = true;
    scoreEl.textContent = `Score: ${score}`;

    bots = [];
    for (let i = 0; i < BOT_COUNT; i++) {
      const bx = randInt(MAP_COLS - 20) + 10;
      const by = randInt(MAP_ROWS - 20) + 10;
      const b = spawnSnake(bx, by, 4);
      b.color = i % PALETTE.length;
      bots.push(b);
    }

    foods = [];
    for (let i = 0; i < FOOD_COUNT; i++) {
      let f;
      do { f = spawnFood(); } while (isOccupied(f.x, f.y));
      foods.push(f);
    }
  }

  function collidesWithAny(x, y, exclude) {
    if (snake !== exclude && snake.segments.some((s) => s.x === x && s.y === y)) return true;
    for (const b of bots) {
      if (b.alive && b !== exclude && b.segments.some((s) => s.x === x && s.y === y)) return true;
    }
    return false;
  }

  function dropFoodFromSnake(s) {
    const dropCount = Math.floor(s.segments.length * DROP_FOOD_RATIO);
    if (dropCount === 0) return;
    const step = Math.max(1, Math.floor(s.segments.length / dropCount));
    let placed = 0;
    for (let i = 0; i < s.segments.length && placed < dropCount; i += step) {
      if (foods.length < MAX_FOOD) {
        foods.push(spawnFood(s.segments[i].x, s.segments[i].y));
        placed++;
      }
    }
  }

  function moveSnake(s, dir) {
    if (!s.alive) return false;
    s.dir = { ...dir };
    const head = { x: s.segments[0].x + dir.x, y: s.segments[0].y + dir.y };

    if (head.x < 0 || head.x >= MAP_COLS || head.y < 0 || head.y >= MAP_ROWS) {
      s.alive = false;
      dropFoodFromSnake(s);
      return false;
    }
    if (collidesWithAny(head.x, head.y, s)) {
      s.alive = false;
      dropFoodFromSnake(s);
      return false;
    }

    s.segments.unshift(head);

    const fi = foods.findIndex((f) => f.x === head.x && f.y === head.y);
    if (fi !== -1) {
      foods.splice(fi, 1);
      if (foods.length < MAX_FOOD) foods.push(spawnFood());
      return true;
    }

    if (s.boosting && s.segments.length > 2) {
      const dropped = s.segments.pop();
      if (foods.length < MAX_FOOD) {
        foods.push(spawnFood(dropped.x, dropped.y));
      }
    } else {
      s.segments.pop();
    }
    return false;
  }

  function botAI(bot) {
    if (!bot.alive) return;
    const head = bot.segments[0];
    let best = null;
    let bestDist = Infinity;
    for (const f of foods) {
      const d = manhattan(head, f);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }

    let dx = 0, dy = 0;
    if (best) {
      dx = Math.sign(best.x - head.x);
      dy = Math.sign(best.y - head.y);
      if (dx !== 0 && dy !== 0) {
        if (Math.random() < 0.5) dx = 0; else dy = 0;
      }
    }

    if (Math.random() < 0.08) {
      const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
      const pick = dirs[randInt(4)];
      dx = pick.x;
      dy = pick.y;
    }

    if (dx === -bot.dir.x && dy === -bot.dir.y) {
      dx = bot.dir.x;
      dy = bot.dir.y;
    }

    if (dx === 0 && dy === 0) {
      dx = bot.dir.x;
      dy = bot.dir.y;
    }

    const nx = head.x + dx;
    const ny = head.y + dy;
    if (nx < 1 || nx >= MAP_COLS - 1 || ny < 1 || ny >= MAP_ROWS - 1) {
      const safe = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]
        .find((d) => {
          const tx = head.x + d.x;
          const ty = head.y + d.y;
          return tx >= 0 && tx < MAP_COLS && ty >= 0 && ty < MAP_ROWS && !collidesWithAny(tx, ty, bot);
        });
      if (safe) { dx = safe.x; dy = safe.y; }
    }

    if (dx === -bot.dir.x && dy === -bot.dir.y) {
      dx = bot.dir.x; dy = bot.dir.y;
    }

    bot.nextDir = { x: dx, y: dy };

    if (bot.boostCooldown > 0) {
      bot.boostCooldown--;
      bot.boosting = false;
    } else if (bot.segments.length > 6 && bestDist > 15 && Math.random() < 0.03) {
      bot.boosting = true;
    } else if (bot.boosting && (bestDist < 5 || bot.segments.length <= 4)) {
      bot.boosting = false;
      bot.boostCooldown = 30;
    }
  }

  function updateSingle() {
    if (playerAlive) {
      if (boosting && score >= MIN_BOOST_SCORE) {
        snake.boosting = true;
        score -= BOOST_COST;
        if (score < 0) score = 0;
        scoreEl.textContent = `Score: ${score}`;
      } else {
        snake.boosting = false;
        boosting = false;
      }

      direction = { ...nextDirection };
      const ate = moveSnake(snake, direction);
      if (ate) {
        score++;
        scoreEl.textContent = `Score: ${score}`;
        if (foods.length < MAX_FOOD) foods.push(spawnFood());
      }
      if (!snake.segments.length || !snake.alive) {
        playerAlive = false;
      }
    }

    for (const bot of bots) {
      botAI(bot);
    }
    for (const bot of bots) {
      if (bot.alive) {
        moveSnake(bot, bot.nextDir);
      }
    }

    for (const bot of bots) {
      if (!bot.alive) {
        const bx = randInt(MAP_COLS - 20) + 10;
        const by = randInt(MAP_ROWS - 20) + 10;
        const nb = spawnSnake(bx, by, 4);
        nb.color = bot.color;
        Object.assign(bot, nb);
      }
    }

    if (!playerAlive) {
      gameOverSingle();
    }
  }

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

    ws.onopen = () => {
      wsConnected = true;
      statusMsg.textContent = 'Connected! Press Play to join.';
      if (pendingJoin) {
        pendingJoin = false;
        joinMultiplayer();
      }
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      wsConnected = false;
      if (gameMode === 'multi') {
        statusMsg.textContent = 'Disconnected. Reconnecting...';
        setTimeout(() => {
          if (gameMode === 'multi') preconnectMultiplayer();
        }, 2000);
      } else {
        statusMsg.textContent = '';
      }
    };

    ws.onerror = () => {
      statusMsg.textContent = 'Connection failed';
    };
  }

  function joinMultiplayer() {
    const name = playerNameInput.value.trim() || 'Player';
    localStorage.setItem('snake-io-name', name);

    if (!wsConnected || !ws || ws.readyState !== 1) {
      pendingJoin = true;
      preconnectMultiplayer();
      return;
    }

    pendingJoin = false;
    ws.send(JSON.stringify({ type: 'join', color: playerColorIdx, name }));
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
        const me = remoteSnakes.find((s) => s.id === myId);
        if (me) {
          snake.segments = me.segments;
          snake.dir = me.dir;
          snake.color = me.color;
          snake.alive = true;
          score = me.score;
          scoreEl.textContent = `Score: ${score}`;
        }
        break;

      case 'leaderboard':
        if (msg.entries) {
          const top = msg.entries.slice(0, 8);
          leaderboardEl.innerHTML = '<b>Leaderboard</b><br/>' +
            top.map((e, i) => {
              const label = e.id === myId ? ' (You)' : '';
              return `${i + 1}. ${e.name}${label} — ${e.len}`;
            }).join('<br/>');
        }
        break;

      case 'died':
        playerAlive = false;
        score = msg.score || 0;
        gameOverMulti();
        break;

      case 'playerJoin':
        break;

      case 'playerLeave':
        break;

      case 'error':
        statusMsg.textContent = msg.message || 'Server error';
        break;
    }
  }

  function sendInput() {
    try {
      if (ws && ws.readyState === 1 && playerAlive) {
        ws.send(JSON.stringify({ type: 'input', dir: nextDirection }));
      }
    } catch (e) {}
  }

  function sendBoost(on) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'boost', on }));
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

  // ==================== RENDERING ====================

  function getCamera() {
    const s = gameMode === 'multi' ? snake : snake;
    if (!s || !s.segments || !s.segments.length) return { x: 0, y: 0 };
    const hx = s.segments[0].x * GRID + GRID / 2;
    const hy = s.segments[0].y * GRID + GRID / 2;
    const cx = Math.max(viewW / 2, Math.min(MAP_W - viewW / 2, hx));
    const cy = Math.max(viewH / 2, Math.min(MAP_H - viewH / 2, hy));
    return { x: cx - viewW / 2, y: cy - viewH / 2 };
  }

  function drawGrid(cam) {
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 0.5;
    const startX = Math.floor(cam.x / GRID) * GRID;
    const startY = Math.floor(cam.y / GRID) * GRID;
    for (let x = startX; x <= cam.x + viewW + GRID; x += GRID) {
      ctx.beginPath();
      ctx.moveTo(x - cam.x, 0);
      ctx.lineTo(x - cam.x, viewH);
      ctx.stroke();
    }
    for (let y = startY; y <= cam.y + viewH + GRID; y += GRID) {
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

  function drawSnakeSegs(segs, colorIdx, isPlayer, cam, segCount, isBoosting) {
    if (!Array.isArray(segs) || !segs.length) return;
    const pal = PALETTE[colorIdx] || PALETTE[0];
    const sz = segmentSize(segCount);

    segs.forEach((seg, i) => {
      if (!seg || typeof seg.x !== 'number' || typeof seg.y !== 'number') return;
      const sx = seg.x * GRID - cam.x;
      const sy = seg.y * GRID - cam.y;
      if (sx + GRID < -40 || sx > viewW + 40 || sy + GRID < -40 || sy > viewH + 40) return;

      const ratio = 1 - i / segs.length;
      const pr = parseInt(pal.primary.slice(1, 3), 16);
      const pg = parseInt(pal.primary.slice(3, 5), 16);
      const pb = parseInt(pal.primary.slice(5, 7), 16);
      const dr = parseInt(pal.dark.slice(1, 3), 16);
      const dg = parseInt(pal.dark.slice(3, 5), 16);
      const db = parseInt(pal.dark.slice(5, 7), 16);
      const f = ratio;
      ctx.fillStyle = `rgb(${Math.floor(pr * f + dr * (1 - f))}, ${Math.floor(pg * f + dg * (1 - f))}, ${Math.floor(pb * f + db * (1 - f))})`;

      if (isPlayer) {
        ctx.shadowColor = isBoosting ? '#ffaa00' : pal.primary;
        ctx.shadowBlur = i === 0 ? 14 : 0;
      }

      const offset = (GRID - sz) / 2;
      ctx.beginPath();
      ctx.roundRect(sx + offset, sy + offset, sz, sz, sz * 0.25);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (i === 0) {
        const eyeSize = sz * 0.18;
        const pupilSize = eyeSize * 0.5;
        const ex1 = sx + GRID * 0.3;
        const ex2 = sx + GRID * 0.7;
        const ey = sy + GRID * 0.35;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(ex1, ey, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(ex1, ey, pupilSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey, pupilSize, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function drawFoodList(foodList, cam) {
    if (!Array.isArray(foodList)) return;
    for (const f of foodList) {
      if (!f || typeof f.x !== 'number' || typeof f.y !== 'number') continue;
      const fx = f.x * GRID - cam.x;
      const fy = f.y * GRID - cam.y;
      if (fx + GRID < 0 || fx > viewW || fy + GRID < 0 || fy > viewH) continue;

      if (f.pulse !== undefined) f.pulse += 0.05;
      const pulsePhase = f.pulse !== undefined ? f.pulse : 0;
      const pulse = 1 + Math.sin(pulsePhase) * 0.15;

      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.arc(
        fx + GRID / 2,
        fy + GRID / 2,
        (GRID / 2 - 2) * pulse,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function updateLeaderboardSingle() {
    const entries = [];
    if (playerAlive && snake.segments.length) {
      entries.push({ name: 'You', len: snake.segments.length });
    }
    bots.forEach((b, i) => {
      if (b.alive && b.segments.length) {
        entries.push({ name: `Bot ${i + 1}`, len: b.segments.length });
      }
    });
    entries.sort((a, b) => b.len - a.len);
    const top = entries.slice(0, 5);
    leaderboardEl.innerHTML = '<b>Leaderboard</b><br/>' +
      top.map((e, i) => `${i + 1}. ${e.name} — ${e.len}`).join('<br/>');
  }

  function drawBoostBar() {
    if (!boostBar) return;
    const pct = boosting && score >= MIN_BOOST_SCORE ? 1 : boosting ? 0 : 1;
    boostBar.style.width = (pct * 100) + '%';
    boostBar.style.background = boosting ? '#ffaa00' : '#00ff88';
  }

  function drawSingle() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, viewW, viewH);
    const cam = getCamera();
    drawGrid(cam);
    drawBorder(cam);
    drawFoodList(foods, cam);
    for (const bot of bots) {
      if (bot.alive) {
        drawSnakeSegs(bot.segments, bot.color, false, cam, bot.segments.length, false);
      }
    }
    if (playerAlive) {
      drawSnakeSegs(snake.segments, snake.color, true, cam, snake.segments.length, snake.boosting);
    }
    updateLeaderboardSingle();
    drawBoostBar();
  }

  function drawMulti() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, viewW, viewH);
    const cam = getCamera();
    drawGrid(cam);
    drawBorder(cam);
    drawFoodList(remoteFoods, cam);
    if (Array.isArray(remoteSnakes)) {
      for (const rs of remoteSnakes) {
        if (rs && rs.id !== myId && Array.isArray(rs.segments) && rs.segments.length) {
          drawSnakeSegs(rs.segments, rs.color, false, cam, rs.segments.length, rs.boosting);
        }
      }
    }
    if (playerAlive && snake && Array.isArray(snake.segments) && snake.segments.length) {
      drawSnakeSegs(snake.segments, snake.color, true, cam, snake.segments.length, boosting);
    }
    drawBoostBar();
  }

  // ==================== GAME LOOPS ====================

  function loopSingle() {
    updateSingle();
    if (!running) return;
    try { drawSingle(); } catch (e) { console.error('drawSingle error', e); }
    const tick = (snake && snake.boosting) ? BOOST_TICK_MS : TICK_MS;
    loopId = setTimeout(loopSingle, tick);
  }

  function loopMulti() {
    if (!running) return;
    if (playerAlive) {
      direction = { ...nextDirection };
      sendInput();
    }
    try { drawMulti(); } catch (e) { console.error('drawMulti error', e); }
    loopId = setTimeout(loopMulti, 33);
  }

  function startSinglePlayer() {
    clearTimeout(loopId);
    init();
    running = true;
    overlay.classList.remove('active');
    drawSingle();
    loopId = setTimeout(loopSingle, TICK_MS);
  }

  function startMultiplayer() {
    clearTimeout(loopId);
    remoteSnakes = [];
    remoteFoods = [];
    myId = null;
    snake = { segments: [{ x: 100, y: 100 }], dir: { x: 1, y: 0 }, color: playerColorIdx, alive: true };
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
    score = 0;
    boosting = false;
    playerAlive = false;
    running = true;
    scoreEl.textContent = `Score: ${score}`;
    joinMultiplayer();
    overlay.classList.remove('active');
    loopId = setTimeout(loopMulti, 33);
  }

  function gameOverSingle() {
    if (!running) return;
    running = false;
    clearTimeout(loopId);
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('snake-io-hs', highScore);
      highScoreEl.textContent = `Best: ${highScore}`;
    }
    overlayMessage.innerHTML = `Game Over! Score: ${score}<br/>Hold <b>Space</b> or <b>Shift</b> to boost (costs points)<br/>Bigger score = bigger snake`;
    startBtn.textContent = 'Play Again';
    overlay.classList.add('active');
  }

  function gameOverMulti() {
    if (!running) return;
    running = false;
    clearTimeout(loopId);
    overlayMessage.innerHTML = `Game Over! Score: ${score}`;
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
      loopId = setTimeout(loopMulti, 33);
      return;
    }
    if (gameMode === 'single') {
      startSinglePlayer();
    } else {
      startMultiplayer();
    }
  }

  // ==================== INPUT ====================

  document.addEventListener('keydown', (e) => {
    if (!playerAlive) return;
    const key = e.key.toLowerCase();

    if (key === ' ' || key === 'shift') {
      if (score >= MIN_BOOST_SCORE) {
        boosting = true;
        if (gameMode === 'multi') sendBoost(true);
      }
      e.preventDefault();
      return;
    }

    const dirMap = {
      arrowup: { x: 0, y: -1 }, w: { x: 0, y: -1 },
      arrowdown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
      arrowleft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
      arrowright: { x: 1, y: 0 }, d: { x: 1, y: 0 },
    };
    const nd = dirMap[key];
    if (nd && !(nd.x === -direction.x && nd.y === -direction.y)) {
      nextDirection = nd;
      e.preventDefault();
    }
  });

  document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key === ' ' || key === 'shift') {
      boosting = false;
      if (gameMode === 'multi') sendBoost(false);
    }
  });

  // Touch joystick
  let touchId = null;
  let touchCenter = { x: 0, y: 0 };
  const JOY_RADIUS = 50;
  let boostTouchId = null;

  function handleTouchStart(e) {
    if (!running || !playerAlive) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      const inBottom = t.clientY > viewH * 0.5;
      if (inBottom && touchId === null) {
        touchId = t.identifier;
        touchCenter = { x: t.clientX, y: t.clientY };
        joystickBase.style.left = (t.clientX - 60) + 'px';
        joystickBase.style.top = (t.clientY - 60) + 'px';
        joystickBase.classList.add('active');
      } else if (!inBottom && boostTouchId === null) {
        boostTouchId = t.identifier;
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
    for (const t of e.changedTouches) {
      if (t.identifier !== touchId) continue;
      const dx = t.clientX - touchCenter.x;
      const dy = t.clientY - touchCenter.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const clamped = Math.min(d, JOY_RADIUS);
      const angle = Math.atan2(dy, dx);
      const kx = Math.cos(angle) * clamped;
      const ky = Math.sin(angle) * clamped;

      joystickKnob.style.transform = `translate(${kx}px, ${ky}px)`;

      if (d > 10) {
        let ndx = 0, ndy = 0;
        if (Math.abs(dx) > Math.abs(dy)) {
          ndx = Math.sign(dx);
        } else {
          ndy = Math.sign(dy);
        }
        if (!(ndx === -direction.x && ndy === -direction.y) && (ndx !== 0 || ndy !== 0)) {
          nextDirection = { x: ndx, y: ndy };
        }
      }
    }
  }

  function handleTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === touchId) {
        touchId = null;
        joystickBase.classList.remove('active');
        joystickKnob.style.transform = 'translate(0, 0)';
      }
      if (t.identifier === boostTouchId) {
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

  startBtn.addEventListener('click', startGame);
})();
