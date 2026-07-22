const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname)));

const MAP_W = 4000;
const MAP_H = 4000;
const BASE_SPEED = 120;
const BOOST_SPEED = 220;
const ROTATION_SPEED = 3.0;
const RECORD_INTERVAL = 4;
const SEGMENT_SPACING = 12;
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
const MAX_PLAYERS = 30;
const SPAWN_MARGIN = 300;
const MAX_SEGMENTS = 200;

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

let nextId = 1;
const players = new Map();
let foods = [];

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
function clearHistory(h) { h.head = 0; h.count = 0; }

function distSq(x1, y1, x2, y2) {
  const dx = x1 - x2, dy = y1 - y2;
  return dx * dx + dy * dy;
}

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function spawnFood(x, y) {
  return {
    x: x !== undefined ? x : Math.random() * MAP_W,
    y: y !== undefined ? y : Math.random() * MAP_H,
  };
}

function initFood() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) foods.push(spawnFood());
}

function initSnakeHistory(h, x, y, angle, count) {
  for (let i = 1; i <= count * SPACING_SAMPLES + 4; i++) {
    pushHistory(h, x - Math.cos(angle) * RECORD_INTERVAL * i, y - Math.sin(angle) * RECORD_INTERVAL * i);
  }
}

function spawnPlayer(id, color) {
  const angle = Math.random() * Math.PI * 2;
  const sx = SPAWN_MARGIN + Math.random() * (MAP_W - SPAWN_MARGIN * 2);
  const sy = SPAWN_MARGIN + Math.random() * (MAP_H - SPAWN_MARGIN * 2);
  const history = createHistory(MAX_HISTORY);
  initSnakeHistory(history, sx, sy, angle, 10);
  return {
    id, name: 'Player', headX: sx, headY: sy, angle, targetAngle: angle,
    history, lastRecordX: sx, lastRecordY: sy,
    segmentCount: 4, color: color % PALETTE.length,
    alive: true, score: 0, boosting: false, ws: null, deathNotified: false,
  };
}

function recordHistory(p) {
  const dx = p.headX - p.lastRecordX;
  const dy = p.headY - p.lastRecordY;
  if (dx * dx + dy * dy >= RECORD_INTERVAL * RECORD_INTERVAL) {
    pushHistory(p.history, p.headX, p.headY);
    p.lastRecordX = p.headX;
    p.lastRecordY = p.headY;
  }
}

function computeSegments(history, segCount) {
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const pos = getHistory(history, (i + 1) * SPACING_SAMPLES);
    if (!pos) break;
    segs.push({ x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 });
  }
  return segs;
}

function dropFoodFromSnake(p) {
  const count = Math.floor(p.segmentCount * DROP_FOOD_RATIO);
  if (count === 0) return;
  const step = Math.max(1, Math.floor(p.segmentCount / count));
  let placed = 0;
  for (let i = 0; i < p.segmentCount && placed < count; i += step) {
    const pos = getHistory(p.history, (i + 1) * SPACING_SAMPLES);
    if (pos && foods.length < MAX_FOOD) {
      foods.push(spawnFood(pos.x, pos.y));
      placed++;
    }
  }
}

const PICKUP_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const HEAD_COL_SQ = (HEAD_RADIUS + SEGMENT_RADIUS) ** 2;

function updatePlayer(p, dt) {
  if (!p.alive) return;

  let diff = angleDiff(p.angle, p.targetAngle);
  const maxTurn = ROTATION_SPEED * dt;
  if (Math.abs(diff) > maxTurn) diff = Math.sign(diff) * maxTurn;
  p.angle += diff;

  if (p.boosting && p.score >= MIN_BOOST_SCORE) {
    p.score -= BOOST_COST_PER_SEC * dt;
    if (p.score < 0) p.score = 0;
  } else if (p.boosting) {
    p.boosting = false;
  }

  const speed = p.boosting ? BOOST_SPEED : BASE_SPEED;
  p.headX += Math.cos(p.angle) * speed * dt;
  p.headY += Math.sin(p.angle) * speed * dt;
  p.headX = clamp(p.headX, 0, MAP_W);
  p.headY = clamp(p.headY, 0, MAP_H);
  recordHistory(p);

  if (p.headX <= 0 || p.headX >= MAP_W || p.headY <= 0 || p.headY >= MAP_H) {
    p.alive = false;
    dropFoodFromSnake(p);
    return;
  }

  for (let i = 4; i < p.segmentCount; i++) {
    const pos = getHistory(p.history, i * SPACING_SAMPLES);
    if (pos && distSq(p.headX, p.headY, pos.x, pos.y) < HEAD_COL_SQ) {
      p.alive = false;
      dropFoodFromSnake(p);
      return;
    }
  }

  for (const other of players.values()) {
    if (other.id === p.id || !other.alive) continue;
    for (let i = 1; i < other.segmentCount; i++) {
      const pos = getHistory(other.history, i * SPACING_SAMPLES);
      if (pos && distSq(p.headX, p.headY, pos.x, pos.y) < HEAD_COL_SQ) {
        p.alive = false;
        dropFoodFromSnake(p);
        return;
      }
    }
  }

  let ate = 0;
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    if (distSq(p.headX, p.headY, f.x, f.y) < PICKUP_SQ) {
      foods.splice(i, 1);
      ate++;
      if (foods.length < MAX_FOOD) foods.push(spawnFood());
    }
  }
  if (ate > 0) {
    p.segmentCount = Math.min(p.segmentCount + ate, MAX_SEGMENTS);
    p.score += ate;
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

let tickCount = 0;
let lastTick = Date.now();

function gameLoop() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  tickCount++;

  for (const p of players.values()) {
    if (p.alive) updatePlayer(p, dt);
  }

  const snakes = [];
  for (const p of players.values()) {
    if (p.alive) {
      snakes.push({
        id: p.id, name: p.name, x: Math.round(p.headX * 10) / 10,
        y: Math.round(p.headY * 10) / 10, angle: Math.round(p.angle * 1000) / 1000,
        color: p.color, score: Math.round(p.score), boosting: p.boosting,
        segments: computeSegments(p.history, p.segmentCount),
      });
    }
  }
  broadcast({ type: 'state', snakes, foods: foods.map(f => ({ x: Math.round(f.x), y: Math.round(f.y) })) });

  if (tickCount % 10 === 0) {
    const entries = [];
    for (const p of players.values()) {
      if (p.alive) entries.push({ id: p.id, name: p.name, score: Math.round(p.score), len: p.segmentCount });
    }
    entries.sort((a, b) => b.len - a.len);
    broadcast({ type: 'leaderboard', entries: entries.slice(0, 10) });
  }

  for (const p of players.values()) {
    if (!p.alive && !p.deathNotified && p.ws && p.ws.readyState === 1) {
      p.deathNotified = true;
      p.ws.send(JSON.stringify({ type: 'died', score: Math.round(p.score) }));
    }
  }

  setTimeout(gameLoop, 16);
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server full' }));
    ws.close();
    return;
  }
  const id = nextId++;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const color = typeof msg.color === 'number' ? msg.color : 0;
      const name = typeof msg.name === 'string' ? msg.name.slice(0, 16) : 'Player';
      const p = spawnPlayer(id, color);
      p.name = name;
      p.ws = ws;
      players.set(id, p);
      ws.send(JSON.stringify({ type: 'welcome', id, config: { MAP_W, MAP_H } }));
      broadcast({ type: 'playerJoin', id, name, color: p.color });
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === 'angle' && typeof msg.angle === 'number') {
      p.targetAngle = msg.angle;
    }

    if (msg.type === 'boost') {
      p.boosting = p.score >= MIN_BOOST_SCORE ? !!msg.on : false;
    }

    if (msg.type === 'respawn' && !p.alive) {
      const np = spawnPlayer(id, p.color);
      np.name = p.name;
      np.ws = ws;
      Object.assign(p, np);
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    if (p) {
      p.alive = false;
      dropFoodFromSnake(p);
      players.delete(id);
      broadcast({ type: 'playerLeave', id });
    }
  });
});

initFood();
gameLoop();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Snake.io server running on port ${PORT}`));
