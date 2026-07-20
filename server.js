const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname)));

const GRID = 20;
const MAP_COLS = 200;
const MAP_ROWS = 200;
const TICK_MS = 100;
const BOOST_TICK_MS = 55;
const BOOST_COST = 1;
const MIN_BOOST_SCORE = 5;
const FOOD_COUNT = 120;
const MAX_FOOD = 500;
const DROP_FOOD_RATIO = 0.6;
const MAX_PLAYERS = 50;
const SPAWN_MARGIN = 20;

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

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function spawnFood(x, y) {
  return {
    x: x !== undefined ? x : randInt(MAP_COLS),
    y: y !== undefined ? y : randInt(MAP_ROWS),
  };
}

function isOccupied(x, y) {
  for (const p of players.values()) {
    if (p.alive && p.segments.some((s) => s.x === x && s.y === y)) return true;
  }
  return false;
}

function spawnPlayer(id, color) {
  const sx = randInt(MAP_COLS - SPAWN_MARGIN * 2) + SPAWN_MARGIN;
  const sy = randInt(MAP_ROWS - SPAWN_MARGIN * 2) + SPAWN_MARGIN;
  const dx = [-1, 0, 1, 0][randInt(4)];
  const dy = [0, -1, 0, 1][randInt(4)];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push({ x: sx - dx * i, y: sy - dy * i });
  }
  return {
    id,
    name: 'Player',
    segments,
    dir: { x: dx || 1, y: dy },
    color: color % PALETTE.length,
    alive: true,
    score: 0,
    boosting: false,
    pendingDir: null,
    ws: null,
    deathNotified: false,
  };
}

function collidesWithAny(x, y, excludeId) {
  for (const p of players.values()) {
    if (p.id !== excludeId && p.alive && p.segments.some((s) => s.x === x && s.y === y)) return true;
  }
  return false;
}

function dropFoodFromSnake(p) {
  const dropCount = Math.floor(p.segments.length * DROP_FOOD_RATIO);
  if (dropCount === 0) return;
  const step = Math.max(1, Math.floor(p.segments.length / dropCount));
  let placed = 0;
  for (let i = 0; i < p.segments.length && placed < dropCount; i += step) {
    if (foods.length < MAX_FOOD) {
      foods.push(spawnFood(p.segments[i].x, p.segments[i].y));
      placed++;
    }
  }
}

function movePlayer(p) {
  if (!p.alive) return false;

  if (p.pendingDir) {
    if (!(p.pendingDir.x === -p.dir.x && p.pendingDir.y === -p.dir.y)) {
      p.dir = { ...p.pendingDir };
    }
    p.pendingDir = null;
  }

  const head = { x: p.segments[0].x + p.dir.x, y: p.segments[0].y + p.dir.y };

  if (head.x < 0 || head.x >= MAP_COLS || head.y < 0 || head.y >= MAP_ROWS) {
    p.alive = false;
    dropFoodFromSnake(p);
    return false;
  }

  if (collidesWithAny(head.x, head.y, p.id)) {
    p.alive = false;
    dropFoodFromSnake(p);
    return false;
  }

  p.segments.unshift(head);

  const fi = foods.findIndex((f) => f.x === head.x && f.y === head.y);
  if (fi !== -1) {
    foods.splice(fi, 1);
    if (foods.length < MAX_FOOD) foods.push(spawnFood());
    p.score++;
    return true;
  }

  if (p.boosting && p.segments.length > 2) {
    const dropped = p.segments.pop();
    if (foods.length < MAX_FOOD) {
      foods.push(spawnFood(dropped.x, dropped.y));
    }
  } else {
    p.segments.pop();
  }
  return false;
}

function buildWorldState() {
  const snakes = [];
  for (const p of players.values()) {
    if (p.alive) {
      snakes.push({
        id: p.id,
        name: p.name,
        segments: p.segments,
        dir: p.dir,
        color: p.color,
        score: p.score,
        boosting: p.boosting,
      });
    }
  }
  return { snakes, foods };
}

function buildPartialState() {
  const snakes = [];
  for (const p of players.values()) {
    if (p.alive) {
      snakes.push({
        id: p.id,
        segments: p.segments,
        dir: p.dir,
        color: p.color,
        score: p.score,
        boosting: p.boosting,
      });
    }
  }
  return { snakes, foods };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

function broadcastLeaderboard() {
  const entries = [];
  for (const p of players.values()) {
    if (p.alive) {
      entries.push({ id: p.id, name: p.name, score: p.score, len: p.segments.length });
    }
  }
  entries.sort((a, b) => b.len - a.len);
  broadcast({ type: 'leaderboard', entries: entries.slice(0, 10) });
}

function initFood() {
  foods = [];
  for (let i = 0; i < FOOD_COUNT; i++) {
    let f;
    do { f = spawnFood(); } while (isOccupied(f.x, f.y));
    foods.push(f);
  }
}

let tickCount = 0;

function gameLoop() {
  tickCount++;

  for (const p of players.values()) {
    if (p.alive && p.boosting && p.score >= MIN_BOOST_SCORE) {
      p.score -= BOOST_COST;
      if (p.score < 0) p.score = 0;
    } else if (p.boosting) {
      p.boosting = false;
    }
  }

  for (const p of players.values()) {
    if (p.alive) movePlayer(p);
  }

  const state = buildPartialState();
  broadcast({ type: 'state', ...state });

  if (tickCount % 10 === 0) {
    broadcastLeaderboard();
  }

  for (const p of players.values()) {
    if (!p.alive && !p.deathNotified && p.ws && p.ws.readyState === 1) {
      p.deathNotified = true;
      p.ws.send(JSON.stringify({ type: 'died', score: p.score }));
    }
  }

  const ms = [...players.values()].some((p) => p.alive && p.boosting) ? BOOST_TICK_MS : TICK_MS;
  setTimeout(gameLoop, ms);
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

      ws.send(JSON.stringify({
        type: 'welcome',
        id,
        config: { GRID, MAP_COLS, MAP_ROWS },
        palette: PALETTE,
      }));

      broadcast({ type: 'playerJoin', id, name, color: p.color });
      broadcastLeaderboard();
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === 'input') {
      const nd = msg.dir;
      if (nd && typeof nd.x === 'number' && typeof nd.y === 'number') {
        if (Math.abs(nd.x) <= 1 && Math.abs(nd.y) <= 1) {
          p.pendingDir = { x: nd.x, y: nd.y };
        }
      }
    }

    if (msg.type === 'boost') {
      if (p.score >= MIN_BOOST_SCORE) {
        p.boosting = !!msg.on;
      } else {
        p.boosting = false;
      }
    }

    if (msg.type === 'respawn') {
      if (!p.alive) {
        const np = spawnPlayer(id, p.color);
        np.name = p.name;
        np.ws = ws;
        np.deathNotified = false;
        Object.assign(p, np);
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    if (p) {
      p.alive = false;
      dropFoodFromSnake(p);
      players.delete(id);
      broadcast({ type: 'playerLeave', id });
      broadcastLeaderboard();
    }
  });
});

initFood();
gameLoop();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Snake.io server running on port ${PORT}`);
});
