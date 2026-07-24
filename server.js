const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
app.use(express.static(path.join(__dirname)));

const MAP_W = 4000;
const MAP_H = 4000;
const BASE_SPEED = 120;
const BOOST_SPEED = 220;
const ROTATION_SPEED = 3.0;
const HEAD_RADIUS = 10;
let SEGMENT_RADIUS = 13.125;
const addgrown = 0.5;
const MAX_SEGMENT_RADIUS = 200;
const SEGMENT_OVERLAP_RATIO = 0.70;
let BASE_SEGMENT_DISTANCE = SEGMENT_RADIUS * 2 * (1 - SEGMENT_OVERLAP_RATIO);
const PICKUP_RADIUS = 14;
const FOOD_COUNT = 150;
const MAX_FOOD = 500;
const BOOST_COST_PER_SEC = 10;
const MIN_BOOST_SCORE = 5;
const DROP_FOOD_RATIO = 1.0;
const MAX_PLAYERS = 30;
const SPAWN_MARGIN = 300;
const MAX_SEGMENTS = 200;
const ORB_COLORS = ['#ff4d6d', '#ff9f1c', '#ffe66d', '#2ec4b6', '#4cc9f0', '#7b2cbf', '#f72585'];

const SKIN_IDS = new Set(['flamengo', 'palmeiras', 'sao-paulo', 'fluminense', 'corinthians', 'vasco', 'santos', 'gremio', 'internacional']);
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

function growSegmentRadius(items) {
  SEGMENT_RADIUS = clamp(SEGMENT_RADIUS + addgrown * items, 0, MAX_SEGMENT_RADIUS);
  BASE_SEGMENT_DISTANCE = SEGMENT_RADIUS * 2 * (1 - SEGMENT_OVERLAP_RATIO);
  HEAD_COL_SQ = (HEAD_RADIUS + SEGMENT_RADIUS) * (HEAD_RADIUS + SEGMENT_RADIUS);
}

function followLeader(segments, headAngle) {
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    const dx = prev.x - curr.x;
    const dy = prev.y - curr.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let direction;
    if (dist > 0.001) {
      direction = Math.atan2(dy, dx);
    } else {
      const leaderAngle = i === 1
        ? headAngle
        : Math.atan2(segments[i - 2].y - prev.y, segments[i - 2].x - prev.x);
      direction = leaderAngle;
    }
    curr.x = prev.x - Math.cos(direction) * BASE_SEGMENT_DISTANCE;
    curr.y = prev.y - Math.sin(direction) * BASE_SEGMENT_DISTANCE;
  }
}

function addTailSegment(segments, fallbackAngle) {
  const tail = segments[segments.length - 1];
  const beforeTail = segments[segments.length - 2];
  const tailAngle = beforeTail
    ? Math.atan2(beforeTail.y - tail.y, beforeTail.x - tail.x)
    : fallbackAngle;
  segments.push({
    x: tail.x - Math.cos(tailAngle) * BASE_SEGMENT_DISTANCE,
    y: tail.y - Math.sin(tailAngle) * BASE_SEGMENT_DISTANCE,
  });
}

function spawnFood(x, y, isDrop) {
  return {
    x: x !== undefined ? x : Math.random() * MAP_W,
    y: y !== undefined ? y : Math.random() * MAP_H,
    color: ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)],
    isDrop: !!isDrop,
  };
}

function initFood() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) foods.push(spawnFood());
}

function spawnPlayer(id, color) {
  const angle = Math.random() * Math.PI * 2;
  const sx = SPAWN_MARGIN + Math.random() * (MAP_W - SPAWN_MARGIN * 2);
  const sy = SPAWN_MARGIN + Math.random() * (MAP_H - SPAWN_MARGIN * 2);

  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push({
      x: sx - Math.cos(angle) * BASE_SEGMENT_DISTANCE * i,
      y: sy - Math.sin(angle) * BASE_SEGMENT_DISTANCE * i,
    });
  }

  return {
    id, name: 'Player',
    headX: sx, headY: sy,
    angle, targetAngle: angle,
    segments,
    color: color % PALETTE.length,
    skinId: 'flamengo',
    alive: true, score: 0, boosting: false,
    ws: null, deathNotified: false,
  };
}

function dropFoodFromSnake(p) {
  const count = Math.floor(p.segments.length * DROP_FOOD_RATIO);
  if (count === 0) return;
  const step = Math.max(1, Math.floor(p.segments.length / count));
  let placed = 0;
  for (let i = 0; i < p.segments.length && placed < count; i += step) {
    if (foods.length < MAX_FOOD) {
      foods.push(spawnFood(p.segments[i].x, p.segments[i].y, true));
      placed++;
    }
  }
}

const PICKUP_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
let HEAD_COL_SQ = (HEAD_RADIUS + SEGMENT_RADIUS) * (HEAD_RADIUS + SEGMENT_RADIUS);

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

  p.segments[0].x = p.headX;
  p.segments[0].y = p.headY;
  followLeader(p.segments, p.angle);

  if (p.headX <= 0 || p.headX >= MAP_W || p.headY <= 0 || p.headY >= MAP_H) {
    p.alive = false;
    dropFoodFromSnake(p);
    return;
  }

  for (const other of players.values()) {
    if (other.id === p.id || !other.alive) continue;
    for (let i = 1; i < other.segments.length; i++) {
      const seg = other.segments[i];
      if (distSq(p.headX, p.headY, seg.x, seg.y) < HEAD_COL_SQ) {
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
    growSegmentRadius(ate);
    for (let a = 0; a < ate && p.segments.length < MAX_SEGMENTS; a++) {
      addTailSegment(p.segments, p.angle);
    }
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
        id: p.id, name: p.name,
        x: Math.round(p.headX * 10) / 10,
        y: Math.round(p.headY * 10) / 10,
        skinId: p.skinId,
        angle: Math.round(p.angle * 1000) / 1000,
        color: p.color,
        score: Math.round(p.score),
        boosting: p.boosting,
        segments: p.segments.map(s => ({
          x: Math.round(s.x * 10) / 10,
          y: Math.round(s.y * 10) / 10,
        })),
      });
    }
  }
  broadcast({
    type: 'state',
    snakes,
    segmentRadius: Math.round(SEGMENT_RADIUS * 1000) / 1000,
    foods: foods.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), color: f.color, isDrop: f.isDrop })),
  });

  if (tickCount % 10 === 0) {
    const entries = [];
    for (const p of players.values()) {
      if (p.alive) {
        entries.push({
          id: p.id, name: p.name,
          score: Math.round(p.score),
          len: p.segments.length,
        });
      }
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
      const skinId = typeof msg.skinId === 'string' && SKIN_IDS.has(msg.skinId) ? msg.skinId : 'flamengo';
      const p = spawnPlayer(id, color);
      p.name = name;
      p.skinId = skinId;
      p.ws = ws;
      players.set(id, p);
      ws.send(JSON.stringify({ type: 'welcome', id, config: { MAP_W, MAP_H } }));
      broadcast({ type: 'playerJoin', id, name, color: p.color });
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === 'angle' && Number.isFinite(msg.angle)) {
      p.targetAngle = msg.angle;
    }

    if (msg.type === 'boost') {
      p.boosting = p.score >= MIN_BOOST_SCORE ? !!msg.on : false;
    }

    if (msg.type === 'respawn' && !p.alive) {
      const np = spawnPlayer(id, p.color);
      np.name = p.name;
      np.skinId = p.skinId;
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
