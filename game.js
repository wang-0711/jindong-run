(() => {
'use strict';

/* ============================================================
   金东快跑 —— 真实透视跑酷
   ------------------------------------------------------------
   这一版把"跑道"和"人物"放进同一个物理系统里：

   1) 摄像机位于玩家身后 6 米、离地约 1.75 米，所有物体用
      小孔成像投影：k = D0 / d，屏幕纵向位置与横向偏移都由 k
      决定。于是远处的东西自然变小、变慢、向灭点收拢，近处的
      东西飞速掠过，而不是原来那种"整屏匀速平移"的假透视。

   2) 跑道上的所有标记（车道虚线、路缘石、沥青斑块、护栏、
      路灯、树木）都按"世界距离"滚动，滚动量严格等于这一帧
      真实跑过的米数。人在跑、地在动，两者是同一个速度。

   3) 人物步频由位移决定（每 2.15 米落一步），落脚瞬间才扬起
      尘土、地面阴影、摄像机轻微起伏；跑道滚多少，脚就迈多少，
      不会出现"原地滑步"。

   4) 跳跃/下蹲是真实的高度（米）与重力（g≈15.5），碰撞用
      世界坐标的立体方块判定，不再用放大的屏幕像素框硬凑。
   ============================================================ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    this.moveTo(x + rr, y);
    this.arcTo(x + w, y, x + w, y + h, rr);
    this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr);
    this.arcTo(x, y, x + w, y, rr);
    this.closePath();
    return this;
  };
}

const startScreen = document.getElementById('startScreen');
const endScreen = document.getElementById('endScreen');
const startBtn = document.getElementById('startBtn');
const restartBtn = document.getElementById('restartBtn');
const finalScore = document.getElementById('finalScore');
const finalDist = document.getElementById('finalDist');
const bestText = document.getElementById('bestText');

/* ---------------- 数学小工具 ---------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const pickOne = (arr) => arr[(Math.random() * arr.length) | 0];

/* ---------------- 视口 ---------------- */
let W = 1, H = 1, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ============================================================
   相机与透视投影
   ------------------------------------------------------------
   D0   ：玩家（也是角色脚底）到摄像机的距离，单位米
   hz   ：地平线（灭点）在屏幕上的高度比例
   feet ：玩家脚底在屏幕上的高度比例
   k(d) = D0 / d  —— 距离 d 处 1 米对应的像素 = ppm * k(d)
   ============================================================ */
const D0 = 6.0;
const LANE_W = 2.35;            // 车道宽（米）
const ROAD_HALF = LANE_W * 1.5; // 三车道半宽
const HERO_H = 1.78;            // 角色身高（米）
const HERO_W = 1.42;
const HERO_DEPTH = 0.62;
const SLIDE_H = 0.80;           // 下蹲时的身体高度（米）
const GRAV = 15.5;              // 重力加速度
const JUMP_V0 = 6.2;            // 起跳初速度 → 最高约 1.24 米，滞空约 0.8 秒
const SLIDE_DUR = 0.62;
const FLY_DUR = 6.0;
const FLY_H = 3.2;
const SPEED_START = 6.8;
const SPEED_MAX = 13.2;
const SPAWN_D = 74;             // 物件在玩家前方多远生成（米）
const NEAR_D = 3.0;             // 近处裁切
const FAR_D = 240;              // 远处裁切

const horizonY = () => H * 0.285;
const feetY = () => H * 0.735;
const laneGapPx = () => Math.min(W * 0.30, 190);
const ppm = () => laneGapPx() / LANE_W;              // 玩家深度处 1 米 = 多少像素
const scaleAt = (d) => D0 / (d > 0.5 ? d : 0.5);      // 透视缩放
const yAt = (d) => horizonY() + (feetY() - horizonY()) * scaleAt(d);
const xAt = (x, d) => W * 0.5 + x * ppm() * scaleAt(d);
const laneX = (lane) => (lane - 1) * LANE_W;

/* ---------------- 障碍物规格（米） ----------------
   bottom / top 是障碍在竖直方向占据的高度区间，用来做真实碰撞：
   low  矮栏 0~0.72    → 起跳（脚底高过 0.72）即可越过
   high 横梁 1.22~2.45 → 只能下蹲钻过（蹲下身高 0.80）
   full 木箱 0~1.28    → 跳不过也钻不过，只能换道
   ------------------------------------------------ */
const OBST = {
  low:  { w: 2.05, depth: 0.34, bottom: 0.00, top: 0.88 },
  high: { w: 2.45, depth: 0.40, bottom: 1.05, top: 2.55 },
  full: { w: 1.80, depth: 0.90, bottom: 0.00, top: 1.58 },
};

/* ---------------- 贴图 ---------------- */
const sprite = { hero: null, chaser: null, heroArt: null, heroAspect: 1.135, chaserAspect: 1.842 };

function loadSprite(src, key, defAspect, bottomFade) {
  const img = new Image();
  img.onload = () => {
    if (!img.width || !img.height) return;
    sprite[key] = img;
    sprite[key + 'Aspect'] = img.height / img.width;
    // 玩家照只拍到大腿，直接贴地会有一道生硬的横切边；把底部渐隐掉，读作"腿没入暗处"
    if (bottomFade) {
      try {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g2 = c.getContext('2d');
        g2.drawImage(img, 0, 0);
        const fh = Math.max(4, img.height * bottomFade);
        const grd = g2.createLinearGradient(0, img.height - fh, 0, img.height);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(0.55, 'rgba(0,0,0,0.55)');
        grd.addColorStop(1, 'rgba(0,0,0,1)');
        g2.globalCompositeOperation = 'destination-out';
        g2.fillStyle = grd;
        g2.fillRect(0, img.height - fh, img.width, fh);
        sprite[key + 'Art'] = c;
      } catch (e) { sprite[key + 'Art'] = null; }
    }
  };
  img.onerror = () => { sprite[key] = null; };
  img.src = src;
}
loadSprite('玩家.png', 'hero', 1.135, 0.15);
loadSprite('反派.png', 'chaser', 1.842, 0.08);

/* ---------------- 最高分 ---------------- */
function loadBest() {
  try { return parseInt(localStorage.getItem('nailong_best') || '0', 10) || 0; }
  catch (e) { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem('nailong_best', String(v)); } catch (e) { /* file:// 下可能被禁用 */ }
}

/* 预渲染的软边尘土贴图：比每帧建径向渐变便宜得多 */
const dustSprite = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(198,186,164,1)');
  rg.addColorStop(0.45, 'rgba(186,174,152,0.55)');
  rg.addColorStop(1, 'rgba(176,164,142,0)');
  g.fillStyle = rg;
  g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
  return c;
})();

/* 预渲染的云：边缘柔和的积云，避免一片片生硬的白圆 */
const cloudSprite = (() => {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const puffs = [
    [64, 76, 40], [104, 60, 34], [146, 66, 36], [186, 78, 27],
    [86, 88, 34], [128, 90, 38], [166, 92, 30],
  ];
  for (let i = 0; i < puffs.length; i++) {
    const x = puffs[i][0], y = puffs[i][1], r = puffs[i][2];
    const rg = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
    rg.addColorStop(0, 'rgba(255,255,255,0.92)');
    rg.addColorStop(0.5, 'rgba(250,252,255,0.62)');
    rg.addColorStop(1, 'rgba(236,244,252,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // 底部稍暗，像被地面反光照亮
  const lg = g.createLinearGradient(0, 60, 0, 118);
  lg.addColorStop(0, 'rgba(196,214,232,0)');
  lg.addColorStop(1, 'rgba(186,206,226,0.30)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = lg;
  g.fillRect(0, 0, 256, 128);
  return c;
})();

/* ---------------- 游戏状态 ---------------- */
const Game = {
  state: 'menu',              // menu | playing | over
  score: 0,
  distance: 0,
  coins: 0,
  best: loadBest(),
  speed: SPEED_START,
  travel: 0,                  // 累计跑过的米数（所有滚动的唯一依据）
  time: 0,

  objects: [],
  props: [],
  particles: [],
  clouds: [],
  texture: [],

  spawnMeter: 6,              // 还差多少米生成下一排
  propMeter: 5,
  lastDouble: false,

  binbin: 'hidden',           // hidden | chasing
  gapM: 0.45,                 // 彬彬贴在玩家身后多少米
  chX: 0,                     // 彬彬的横向位置（有跟随延迟）
  chSide: 1,                  // 彬彬在玩家哪一侧跑
  chaseT: 0,
  chaseMax: 5,
  armed: false,
  raid: false,
  raidTimer: 15,
  bombTimer: 0,

  alertText: '',
  alertT: 0,
  shake: 0,
  flash: 0,
};

const player = {
  lane: 1,
  x: 0, vx: 0,
  y: 0, vy: 0,               // y = 离地高度（米）
  jumping: false,
  sliding: false, slideT: 0,
  stunned: false, stunT: 0, stunDur: 0.28,
  shield: false, shieldT: 0, shieldDur: 5,
  magnet: false, magnetT: 0, magnetDur: 6,
  flying: false, flyT: 0,
  invuln: 0,
  tilt: 0,
  step: 0,                   // 步态相位（弧度）
  lastStep: -1,
  bobPx: 0,
};

const effects = [
  { key: 'magnet', name: '磁铁', color: '#f72585', char: '🧲' },
  { key: 'shield', name: '护盾', color: '#4cc9f0', char: '🛡' },
  { key: 'fly',    name: '飞行', color: '#80ed99', char: '✈' },
];

/* ---------------- 场景初始化 ---------------- */
function initClouds() {
  Game.clouds = [];
  for (let i = 0; i < 7; i++) {
    Game.clouds.push({ x: rand(0, 1), y: rand(0.03, 0.20), s: rand(0.5, 1.35), sp: rand(0.004, 0.013) });
  }
}

function initTexture() {
  Game.texture = [];
  for (let i = 0; i < 110; i++) {
    const light = Math.random() < 0.4;
    const a = (light ? rand(0.012, 0.032) : rand(0.018, 0.045)).toFixed(3);
    Game.texture.push({
      x: rand(-ROAD_HALF + 0.1, ROAD_HALF - 0.5),
      d: rand(0, 210),
      len: rand(0.4, 1.8),
      wid: rand(0.1, 0.5),
      style: light ? 'rgba(255,248,230,' + a + ')' : 'rgba(12,14,16,' + a + ')',
    });
  }

  // 路肩草丛：贴着硬路肩外侧长，用来提供近处的速度参照
  Game.grass = [];
  for (let i = 0; i < 64; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const g0 = rand(0.3, 1);
    Game.grass.push({
      x: side * rand(4.85, 8.6),
      d: rand(0, 64),
      h: rand(0.14, 0.42),
      c: 'rgba(' + (60 + (g0 * 46) | 0) + ',' + (104 + (g0 * 52) | 0) + ',' + (48 + (g0 * 34) | 0) + ',0.85)',
      seed: Math.random() * 6.283,
    });
  }
}

function makeProp(d) {
  const r = Math.random();
  let type = 'tree';
  if (r < 0.26) type = 'lamp';
  else if (r < 0.48) type = 'bush';
  else if (r < 0.6) type = 'rock';
  else if (r < 0.7) type = 'sign';
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = side * (type === 'lamp' ? rand(5.9, 6.4) : rand(6.4, 11));
  return { type, x, d, seed: Math.random() };
}

function seedProps() {
  Game.props = [];
  for (let i = 0; i < 30; i++) Game.props.push(makeProp(rand(4, 125)));
}

/* ---------------- 开局 / 结束 ---------------- */
function reset() {
  player.lane = 1;
  player.x = 0; player.vx = 0;
  player.y = 0; player.vy = 0;
  player.jumping = false;
  player.sliding = false; player.slideT = 0;
  player.stunned = false; player.stunT = 0;
  player.shield = false; player.shieldT = 0;
  player.magnet = false; player.magnetT = 0;
  player.flying = false; player.flyT = 0;
  player.invuln = 0;
  player.tilt = 0;
  player.step = 0;
  player.lastStep = -1;
  player.bobPx = 0;

  Game.score = 0;
  Game.distance = 0;
  Game.coins = 0;
  Game.speed = SPEED_START;
  Game.travel = 0;
  Game.time = 0;
  Game.objects = [];
  Game.particles = [];
  Game.spawnMeter = 6;
  Game.propMeter = 4;
  Game.lastDouble = false;

  Game.binbin = 'hidden';
  Game.gapM = 0.45;
  Game.chX = 0;
  Game.chSide = 1;
  Game.chaseT = 0;
  Game.chaseMax = 5;
  Game.armed = false;
  Game.raid = false;
  Game.raidTimer = rand(12, 20);
  Game.bombTimer = 0;

  Game.alertText = '';
  Game.alertT = 0;
  Game.shake = 0;
  Game.flash = 0;

  seedProps();
}

function startGame() {
  reset();
  Game.state = 'playing';
  startScreen.classList.add('hidden');
  endScreen.classList.add('hidden');
}

function endGame() {
  if (Game.state === 'over') return;
  Game.state = 'over';
  Game.best = Math.max(Game.best, Math.floor(Game.score));
  saveBest(Game.best);
  finalScore.textContent = String(Math.floor(Game.score));
  finalDist.textContent = String(Math.floor(Game.distance));
  bestText.textContent = '最高分 ' + Game.best;
  Game.gapM = 2.4;           // 彬彬贴到身后，画面上真的"抓住"了
  Game.chX = player.x;
  Game.shake = 16;
  Game.flash = 0.35;
  setTimeout(() => endScreen.classList.remove('hidden'), 620);
}

startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', startGame);

/* ---------------- 输入 ---------------- */
function canAct() {
  return Game.state === 'playing' && !player.stunned;
}

function moveLeft() {
  if (!canAct()) return;
  if (player.lane > 0) player.lane--;
}
function moveRight() {
  if (!canAct()) return;
  if (player.lane < 2) player.lane++;
}
function jump() {
  if (!canAct()) return;
  if (player.flying || player.jumping || player.sliding) return;
  if (player.y > 0.02) return;
  player.jumping = true;
  player.vy = JUMP_V0;
  player.y = 0.001;
}
function slide() {
  if (!canAct()) return;
  if (player.flying) return;
  if (player.y > 0.05) return;      // 空中不能下蹲
  player.sliding = true;
  player.slideT = 0;
  player.jumping = false;
  player.vy = 0;
  slideDust();
}

window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(k) >= 0) e.preventDefault();
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') moveLeft();
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') moveRight();
  else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') jump();
  else if (k === 'ArrowDown' || k === 's' || k === 'S') slide();
});

let touchStart = null;
function onTouchStart(e) {
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}
function onTouchEnd(e) {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (Math.max(adx, ady) < 24) jump();
  else if (adx > ady) { if (dx > 0) moveRight(); else moveLeft(); }
  else { if (dy > 0) slide(); else jump(); }
  touchStart = null;
}
canvas.addEventListener('touchstart', onTouchStart, { passive: true });
canvas.addEventListener('touchend', onTouchEnd, { passive: true });

/* ============================================================
   生成
   ============================================================ */
function shuffleLanes() {
  const a = [0, 1, 2];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function makeObstacle(kind, lane, d) {
  const s = OBST[kind];
  return {
    type: 'obstacle', kind, lane, x: laneX(lane), d,
    w: s.w, depth: s.depth, bottom: s.bottom, top: s.top,
    hit: false,
  };
}

function spawnRow() {
  const roll = Math.random();
  if (roll < 0.46) {
    // 障碍排：最多堵两条道，而且上一排堵两条时这一排只堵一条
    const two = !Game.lastDouble && Math.random() < 0.34;
    const lanes = shuffleLanes().slice(0, two ? 2 : 1);
    for (let i = 0; i < lanes.length; i++) {
      Game.objects.push(makeObstacle(pickOne(['low', 'high', 'full']), lanes[i], SPAWN_D));
    }
    Game.lastDouble = two;
  } else if (roll < 0.68) {
    const lane = (Math.random() * 3) | 0;
    const n = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      Game.objects.push({
        type: 'coin', lane, x: laneX(lane), d: SPAWN_D + i * 3.4,
        h: 1.0, spin: Math.random() * 6.283,
      });
    }
    Game.lastDouble = false;
  } else if (roll < 0.84) {
    const lane = (Math.random() * 3) | 0;
    for (let i = 0; i < 3; i++) {
      Game.objects.push({
        type: 'bottle', lane, x: laneX(lane), d: SPAWN_D + i * 3.6,
        h: 1.0, spin: Math.random() * 6.283,
      });
    }
    Game.lastDouble = false;
  } else {
    const eff = pickOne(effects);
    const lane = (Math.random() * 3) | 0;
    Game.objects.push({
      type: 'power', kind: eff.key, lane, x: laneX(lane), d: SPAWN_D, h: 1.2, got: false,
    });
    Game.lastDouble = false;
  }
}

/* ============================================================
   效果 / 拾取 / 撞击
   ============================================================ */
function applyPower(kind) {
  player.invuln = Math.max(player.invuln, 0.2);
  if (kind === 'magnet') { player.magnet = true; player.magnetT = 0; }
  else if (kind === 'shield') { player.shield = true; player.shieldT = 0; }
  else if (kind === 'fly') {
    player.flying = true;
    player.flyT = 0;
    player.jumping = false;
    player.vy = 0;
    burst(player.x, D0, 0.8, '128,237,153', 20, 1.6);
  }
}

function collectCoin() {
  Game.coins += 1;
  Game.score += 10;
  burst(player.x, D0, 1.0, '255,210,63', 8, 1.2);
}

function collectBottle() {
  Game.score += 5;
  burst(player.x, D0, 1.0, '255,224,138', 10, 1.2);
}

/* 撞击：第一次只是被彬彬盯上（5 秒），期间再撞就被抓住 */
function crash(o) {
  if (player.invuln > 0 || player.flying) return;

  if (player.shield) {
    o.dead = true;
    burst(o.x, o.d, 0.6, '76,201,240', 18, 1.6);
    Game.shake = 5;
    Game.flash = 0.12;
    return;
  }

  if (!Game.armed) {
    o.dead = true;
    Game.armed = true;
    Game.shake = 7;
    Game.flash = 0.2;
    player.stunned = true;
    player.stunT = 0;
    if (Game.binbin === 'hidden') {
      Game.binbin = 'chasing';
      Game.chaseT = 5;
      Game.chaseMax = 5;
      Game.gapM = 0.45;
      Game.chX = player.x;
      Game.chSide = player.x > 0 ? -1 : 1;
      Game.alertText = '⚠ 彬彬追回来了！5 秒内别再撞';
      Game.alertT = 2.2;
    } else {
      Game.alertText = '⚠ 他就在你身后，稳住！';
      Game.alertT = 1.5;
    }
    burst(player.x, D0, 0.9, '255,143,163', 16, 1.6);
    return;
  }

  o.dead = true;
  Game.shake = 16;
  Game.flash = 0.5;
  burst(player.x, D0, 0.9, '255,107,107', 26, 2.0);
  endGame();
}

/* 世界坐标的立体碰撞：先比纵深，再比横向，最后比高度 */
function obstacleHit(o) {
  if (o.hit || player.invuln > 0 || player.flying) return false;
  const depthPad = HERO_DEPTH * 0.5 + o.depth * 0.5;
  if (Math.abs(o.d - D0) > depthPad) return false;
  const latPad = HERO_W * 0.42 + o.w * 0.5;
  if (Math.abs(o.x - player.x) > latPad) return false;
  const pBot = player.y;
  const pTop = player.y + (player.sliding ? SLIDE_H : HERO_H);
  if (pTop <= o.bottom || pBot >= o.top) return false;
  return true;
}

/* ============================================================
   粒子（全部活在世界坐标里，会随跑道一起后退）
   ============================================================ */
function burst(x, d, h, rgb, n, spread) {
  for (let i = 0; i < n; i++) {
    Game.particles.push({
      x: x + rand(-0.3, 0.3) * spread,
      d: d + rand(-0.2, 0.2),
      h: h + rand(-0.2, 0.35),
      vx: rand(-2.2, 2.2) * spread,
      vd: rand(-1.2, 2.4),
      vh: rand(0.6, 3.4),
      life: rand(0.4, 0.85), t: 0,
      size: rand(0.05, 0.14),
      rgb, kind: 'spark',
    });
  }
}

function footDust(side) {
  for (let i = 0; i < 3; i++) {
    Game.particles.push({
      x: player.x + side * rand(0.12, 0.42),
      d: D0 - 0.2,
      h: rand(0.02, 0.12),
      vx: side * rand(0.2, 0.9) + rand(-0.2, 0.2),
      vd: rand(0.4, 1.6),
      vh: rand(0.25, 0.9),
      life: rand(0.32, 0.55), t: 0,
      size: rand(0.16, 0.34),
      rgb: '168,155,135', kind: 'dust',
    });
  }
}

function slideDust() {
  for (let i = 0; i < 10; i++) {
    Game.particles.push({
      x: player.x + rand(-0.5, 0.5),
      d: D0 - 0.15,
      h: rand(0.02, 0.3),
      vx: rand(-1.6, 1.6),
      vd: rand(1.2, 3.2),
      vh: rand(0.2, 1.2),
      life: rand(0.35, 0.6), t: 0,
      size: rand(0.2, 0.45),
      rgb: '172,160,140', kind: 'dust',
    });
  }
}

function onLand() {
  footDust(-1);
  footDust(1);
  Game.shake = Math.max(Game.shake, 2.2);
}

/* ============================================================
   更新
   ============================================================ */
function update(dt) {
  Game.time += dt;

  let ds = 0;
  if (Game.state === 'playing') {
    const target = Math.min(SPEED_START + Game.distance * 0.0035, SPEED_MAX);
    Game.speed = damp(Game.speed, target, 0.9, dt);
    ds = Game.speed * dt;
    Game.distance += ds;
    Game.score += ds * 1.35;
  } else if (Game.state === 'menu') {
    Game.speed = 2.4;
    ds = Game.speed * dt;
  }

  Game.travel += ds;

  // 步态相位与位移绑定：每 2.15 米落一步，所以脚永远踩在原地
  if (ds > 0) player.step += (ds / 2.15) * Math.PI;

  const idx = Math.floor(player.step / Math.PI);
  if (idx !== player.lastStep) {
    player.lastStep = idx;
    if (Game.state === 'playing' && !player.flying && !player.jumping &&
        !player.sliding && player.y < 0.05) {
      footDust(idx % 2 === 0 ? -1 : 1);
    }
  }

  const amp = 3.2 * clamp(Game.speed / 7.5, 0.6, 1.7);
  player.bobPx = -Math.abs(Math.sin(player.step)) * amp;

  scrollWorld(ds);
  updateParticles(dt, ds);
  updateClouds(dt);

  if (Game.shake > 0) Game.shake = Math.max(0, Game.shake - dt * 30);
  if (Game.flash > 0) Game.flash = Math.max(0, Game.flash - dt * 1.6);
  if (Game.alertT > 0) Game.alertT -= dt;

  if (Game.state !== 'playing') return;

  updatePlayer(dt, ds);
  if (Game.state !== 'playing') return;
  updateChase(dt);
  if (Game.state !== 'playing') return;

  // —— 生成节奏：按"米"而不是按"秒"，速度越快间隔越宽，反应时间不变
  Game.spawnMeter -= ds;
  if (Game.spawnMeter <= 0) {
    spawnRow();
    const interval = clamp(1.22 - Game.distance * 0.00022, 0.82, 1.22) * rand(0.9, 1.12);
    Game.spawnMeter = Game.speed * interval;
  }

  Game.propMeter -= ds;
  if (Game.propMeter <= 0) {
    Game.props.push(makeProp(rand(105, 130)));
    Game.propMeter = rand(3.6, 7.2);
  }

  updateObjects(dt, ds);

  // 效果计时（突袭期间冻结）
  if (!Game.raid) {
    if (player.shield) {
      player.shieldT += dt;
      if (player.shieldT >= player.shieldDur) player.shield = false;
    }
    if (player.magnet) {
      player.magnetT += dt;
      if (player.magnetT >= player.magnetDur) player.magnet = false;
    }
  }
}

function updatePlayer(dt, ds) {
  // ---- 横向：临界阻尼弹簧，换道约 0.3 秒，带一点惯性和侧倾 ----
  const tx = laneX(player.lane);
  player.vx += ((tx - player.x) * 115 - player.vx * 21.5) * dt;
  player.x += player.vx * dt;
  player.tilt = clamp(player.vx * 0.055, -0.22, 0.22);

  // ---- 垂直：跳跃/飞行/落地 ----
  if (player.flying) {
    player.flyT += dt;
    player.y = damp(player.y, FLY_H, 5.0, dt);
    player.vy = 0;
    if (player.flyT >= FLY_DUR) {
      player.flying = false;
      Game.alertText = '飞行结束，准备落地';
      Game.alertT = 1.3;
    }
  } else if (player.y > 0 || player.vy > 0) {
    player.vy -= GRAV * dt;
    player.y += player.vy * dt;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      if (player.jumping) {
        player.jumping = false;
        onLand();
      }
    }
  }

  if (player.sliding) {
    player.slideT += dt;
    if (player.slideT >= SLIDE_DUR) player.sliding = false;
  }
  if (player.stunned) {
    player.stunT += dt;
    if (player.stunT >= player.stunDur) player.stunned = false;
  }
  if (player.invuln > 0) player.invuln -= dt;

  // 掉出屏幕外的保护（理论上不会发生）
  if (player.x < -LANE_W * 2.2) player.x = -LANE_W * 2.2;
  if (player.x > LANE_W * 2.2) player.x = LANE_W * 2.2;
}

function updateChase(dt) {
  if (Game.binbin === 'chasing') {
    Game.chaseT -= dt;
    const p = 1 - clamp(Game.chaseT / Game.chaseMax, 0, 1);
    // 越追越近：从玩家身后半米一路贴到一米五
    Game.gapM = lerp(0.45, 1.45, Math.pow(p, 0.9));

    // 他始终在玩家侧后方，被玩家挤到边线就换到另一侧
    if (player.x > 0.85 && Game.chSide > 0) Game.chSide = -1;
    else if (player.x < -0.85 && Game.chSide < 0) Game.chSide = 1;
    const tx = clamp(player.x + Game.chSide * 2.05, -2.95, 2.95);
    Game.chX = damp(Game.chX, tx, 3.4, dt);

    if (Game.chaseT <= 0) {
      const wasRaid = Game.raid;
      Game.binbin = 'hidden';
      Game.raid = false;
      Game.armed = false;
      Game.gapM = 0.45;
      Game.raidTimer = rand(12, 20);
      Game.alertText = wasRaid ? '彬彬突袭结束，安全！' : '彬彬放弃了，安全！';
      Game.alertT = 1.8;
      Game.flash = 0.1;
    }
  } else {
    Game.raidTimer -= dt;
    if (Game.raidTimer <= 0) startRaid();
  }

  // 突袭期间：彬彬往前方路面扔炸弹（炸弹落在世界里，会跟着跑道逼近）
  if (Game.raid) {
    Game.bombTimer -= dt;
    if (Game.bombTimer <= 0) {
      const lane = Math.random() < 0.62 ? player.lane : ((Math.random() * 3) | 0);
      Game.objects.push({
        type: 'bomb', lane, x: laneX(lane), d: 26 + rand(0, 8),
        h: 4, t: 0, vy: 0,
      });
      Game.bombTimer = rand(0.95, 1.7);
    }
  }
}

function startRaid() {
  Game.binbin = 'chasing';
  Game.raid = true;
  Game.chaseT = 20;
  Game.chaseMax = 20;
  Game.gapM = 0.45;
  Game.chX = player.x;
  Game.chSide = player.x > 0 ? -1 : 1;
  player.shield = false; player.shieldT = 0;
  player.magnet = false; player.magnetT = 0;
  if (player.flying) {
    player.flying = false;
    player.vy = 0;
  }
  player.invuln = 0;
  Game.bombTimer = 1.2;
  Game.alertText = '⚠ 彬彬突袭！效果全消，小心炸弹';
  Game.alertT = 2.4;
  Game.shake = 8;
  Game.flash = 0.2;
}

function scrollWorld(ds) {
  if (ds <= 0) return;
  for (let i = Game.props.length - 1; i >= 0; i--) {
    Game.props[i].d -= ds;
    if (Game.props[i].d < NEAR_D - 1) Game.props.splice(i, 1);
  }
}

function updateObjects(dt, ds) {
  const mag = player.magnet && !Game.raid && !player.stunned;

  for (let i = Game.objects.length - 1; i >= 0; i--) {
    const o = Game.objects[i];
    o.d -= ds;

    // ---- 炸弹：抛物线落地，之后躺在地面上等玩家跑过去 ----
    if (o.type === 'bomb') {
      o.t += dt;
      if (o.t < 0.55) {
        const u = o.t / 0.55;
        o.h = lerp(4.2, 0.35, u * u);
      } else {
        o.h = 0.35;
      }
      if (!o.dead && Math.abs(o.d - D0) < 0.75 && Math.abs(o.x - player.x) < 1.15) {
        if (player.y < 0.62 && !player.flying) {
          o.dead = true;
          burst(o.x, D0, 0.4, '255,120,60', 30, 2.2);
          Game.shake = 18;
          Game.flash = 0.55;
          endGame();
          return;
        }
      }
      if (o.dead || o.d < NEAR_D - 0.5) Game.objects.splice(i, 1);
      continue;
    }

    // ---- 磁铁吸金币/奶瓶 ----
    if (mag && (o.type === 'coin' || o.type === 'bottle') &&
        o.d > D0 - 1 && o.d < D0 + 24) {
      o.x = damp(o.x, player.x, 7, dt);
    }

    if (o.type === 'obstacle') {
      if (obstacleHit(o)) {
        o.hit = true;
        crash(o);
        if (Game.state !== 'playing') return;
      }
    } else if (Math.abs(o.d - D0) < 1.0 &&
               Math.abs(o.x - player.x) < 1.05) {
      if (o.type === 'coin' && !o.got) {
        o.got = true; o.dead = true; collectCoin();
      } else if (o.type === 'bottle' && !o.got) {
        o.got = true; o.dead = true; collectBottle();
      } else if (o.type === 'power' && !o.got) {
        if (Game.raid) {
          Game.alertText = '技能球被彬彬锁定了！';
          Game.alertT = 1.2;
        } else {
          o.got = true; o.dead = true; applyPower(o.kind);
        }
      }
    }

    if (o.dead || o.d < NEAR_D - 0.5) Game.objects.splice(i, 1);
  }
}

function updateParticles(dt, moved) {
  for (let i = Game.particles.length - 1; i >= 0; i--) {
    const p = Game.particles[i];
    p.t += dt;
    p.d += p.vd * dt - moved;
    p.x += p.vx * dt;
    p.h += p.vh * dt;
    p.vh -= 7.5 * dt;
    if (p.h < 0) { p.h = 0; p.vh = 0; }
    if (p.t >= p.life || p.d < NEAR_D - 0.6) Game.particles.splice(i, 1);
  }
}

function updateClouds(dt) {
  for (let i = 0; i < Game.clouds.length; i++) {
    const c = Game.clouds[i];
    c.x += c.sp * dt;
    if (c.x > 1.15) c.x = -0.15;
  }
}

/* ============================================================
   渲染辅助
   ============================================================ */
/* 地面上的一段梯形（世界横向 x1..x2，纵深 d1..d2，d2 更远） */
function fillQuad(x1, x2, d1, d2, style) {
  const P = ppm();
  const k1 = scaleAt(d1), k2 = scaleAt(d2);
  const cxp = W * 0.5, hy = horizonY(), dy = feetY() - hy;
  const y1 = hy + dy * k1, y2 = hy + dy * k2;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(cxp + x1 * P * k1, y1);
  ctx.lineTo(cxp + x2 * P * k1, y1);
  ctx.lineTo(cxp + x2 * P * k2, y2);
  ctx.lineTo(cxp + x1 * P * k2, y2);
  ctx.closePath();
  ctx.fill();
}

/* 垂直于视线方向的立面（护栏、挡板） */
function fillWall(x, h1, h2, d1, d2, style) {
  const P = ppm();
  const k1 = scaleAt(d1), k2 = scaleAt(d2);
  const cxp = W * 0.5, hy = horizonY(), dy = feetY() - hy;
  const yb1 = hy + dy * k1, yb2 = hy + dy * k2;
  const xa = cxp + x * P * k1, xb = cxp + x * P * k2;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(xa, yb1 - h1 * P * k1);
  ctx.lineTo(xa, yb1 - h2 * P * k1);
  ctx.lineTo(xb, yb2 - h2 * P * k2);
  ctx.lineTo(xb, yb2 - h1 * P * k2);
  ctx.closePath();
  ctx.fill();
}

/* 落地阴影：太阳在右上方，所以影子偏左下 */
function shadowEllipse(sx, sy, rx, ry, a) {
  if (a <= 0.01 || rx < 0.5) return;
  ctx.save();
  ctx.fillStyle = 'rgba(18,12,8,' + a.toFixed(3) + ')';
  ctx.beginPath();
  ctx.ellipse(sx - rx * 0.42, sy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ============================================================
   天空
   ============================================================ */
function drawSky() {
  const gy = horizonY();
  const g = ctx.createLinearGradient(0, 0, 0, gy + H * 0.2);
  g.addColorStop(0, '#2f7fc4');
  g.addColorStop(0.35, '#63aee6');
  g.addColorStop(0.72, '#a9d5ee');
  g.addColorStop(1, '#e6f1f7');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, gy + H * 0.2);

  // 太阳 + 光晕
  const sx = W * 0.79, sy = H * 0.12;
  const sr = Math.min(W, H) * 0.048;
  const sg = ctx.createRadialGradient(sx, sy, sr * 0.3, sx, sy, sr * 5);
  sg.addColorStop(0, 'rgba(255,249,222,0.95)');
  sg.addColorStop(0.14, 'rgba(255,238,178,0.5)');
  sg.addColorStop(0.42, 'rgba(255,232,160,0.16)');
  sg.addColorStop(1, 'rgba(255,232,160,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(sx, sy, sr * 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,252,235,0.98)';
  ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();

  for (let i = 0; i < Game.clouds.length; i++) {
    const c = Game.clouds[i];
    drawCloud(W * c.x, H * c.y, c.s);
  }

  drawHills(gy);
}

function drawCloud(x, y, s) {
  const w = 256 * s, h = 128 * s;
  ctx.drawImage(cloudSprite, x - w * 0.5, y - h * 0.5, w, h);
}

/* 远山：两层视差，跑动时缓慢横移 */
function drawHills(gy) {
  const layers = [
    { off: Game.travel * 1.1, color: '#a9c7b6', amp: 0.085, period: 780, phase: 1.7 },
    { off: Game.travel * 2.6, color: '#8fb69c', amp: 0.055, period: 470, phase: 4.2 },
  ];
  for (let L = 0; L < layers.length; L++) {
    const o = layers[L];
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.moveTo(-30, gy + 4);
    for (let x = -30; x <= W + 30; x += 10) {
      const t = (x + o.off) / o.period * Math.PI * 2;
      const hh = (Math.sin(t + o.phase) * 0.5 + 0.5) * H * o.amp +
                 Math.sin(t * 2.7 + o.phase * 1.7) * H * o.amp * 0.22;
      ctx.lineTo(x, gy - hh);
    }
    ctx.lineTo(W + 30, gy + 4);
    ctx.closePath();
    ctx.fill();
  }
}

/* ============================================================
   跑道
   ============================================================ */
function drawRoad() {
  const gy = horizonY();
  const P = ppm();

  // 草地（远处偏灰、近处偏绿，避免整块死板的纯色）
  const gg = ctx.createLinearGradient(0, gy, 0, H);
  gg.addColorStop(0, '#c2d3bd');
  gg.addColorStop(0.12, '#a3c295');
  gg.addColorStop(0.45, '#7aa868');
  gg.addColorStop(0.8, '#5e8f52');
  gg.addColorStop(1, '#4c7c45');
  ctx.fillStyle = gg;
  ctx.fillRect(0, gy - 1, W, H - gy + 1);

  // 修剪过的草皮条纹：每 5 米一道，跟着跑道滚，近处能明显感到速度
  const sP = 5;
  const sOff = Game.travel % sP;
  for (let i = 0; i < 26; i++) {
    const d1 = sP - sOff + i * sP;
    if (d1 > 92) break;
    const d2 = d1 + sP * 0.5;
    if (d2 <= NEAR_D) continue;
    const a = Math.max(d1, NEAR_D);
    fillQuad(-34, 34, a, d2, 'rgba(255,255,255,0.075)');
  }

  // 光的方向：右侧向阳偏暖，左侧背光压暗
  const sunG = ctx.createLinearGradient(0, 0, W, 0);
  sunG.addColorStop(0, 'rgba(24,48,30,0.16)');
  sunG.addColorStop(0.45, 'rgba(24,48,30,0.02)');
  sunG.addColorStop(1, 'rgba(255,238,196,0.10)');
  ctx.fillStyle = sunG;
  ctx.fillRect(0, gy, W, H - gy);

  // 草丛：几片细叶，贴地生长
  for (let i = 0; i < Game.grass.length; i++) {
    const t = Game.grass[i];
    let d = (t.d - Game.travel) % 64;
    if (d < 0) d += 64;
    if (d < NEAR_D || d > 30) continue;
    const k = scaleAt(d);
    const sx = xAt(t.x, d);
    const sy = yAt(d);
    const hh = t.h * P * k;
    if (hh < 1.6) continue;
    const baseW = Math.max(0.9, 0.045 * P * k);
    const lean = Math.sin(t.seed + Game.travel * 1.7) * hh * 0.34;
    ctx.globalAlpha = clamp((30 - d) / 12, 0, 1);
    ctx.fillStyle = t.c;
    ctx.beginPath();
    for (let b = 0; b < 5; b++) {
      const f = b / 4 - 0.5;
      const bx = sx + f * hh * 0.5;
      const tipX = bx + f * hh * 0.3 + lean * (0.35 + Math.abs(f));
      const tipY = sy - hh * (0.62 + 0.38 * (1 - Math.abs(f)));
      ctx.moveTo(bx - baseW * 0.5, sy);
      ctx.lineTo(bx + baseW * 0.5, sy);
      ctx.lineTo(tipX, tipY);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 碎石路肩
  const grav = ctx.createLinearGradient(0, gy, 0, H);
  grav.addColorStop(0, '#b6aca0');
  grav.addColorStop(1, '#8b8075');
  fillQuad(-4.7, -ROAD_HALF, NEAR_D, 150, grav);
  fillQuad(ROAD_HALF, 4.7, NEAR_D, 150, grav);

  // 沥青主体
  const ag = ctx.createLinearGradient(0, gy, 0, H);
  ag.addColorStop(0, '#9ba2aa');
  ag.addColorStop(0.22, '#848b94');
  ag.addColorStop(0.6, '#646b74');
  ag.addColorStop(1, '#4c535b');
  fillQuad(-ROAD_HALF, ROAD_HALF, NEAR_D, FAR_D * 2, ag);

  // 沥青斑块 / 补丁（跟着跑道一起滚）
  for (let i = 0; i < Game.texture.length; i++) {
    const f = Game.texture[i];
    let d = (f.d - Game.travel) % 210;
    if (d < 0) d += 210;
    if (d < NEAR_D + 2 || d > 45) continue;
    const kk = scaleAt(d);
    if (f.wid * P * kk < 0.8) continue;
    if (f.len * P * kk > 80) continue;   // 太近会糊成一块大光斑
    fillQuad(f.x, f.x + f.wid, d, d + f.len, f.style);
  }

  // 轮胎磨痕（车道中心两侧的深色带，位置固定）
  for (let l = -1; l <= 1; l++) {
    const c = l * LANE_W;
    fillQuad(c - 0.62, c - 0.24, NEAR_D, 130, 'rgba(0,0,0,0.05)');
    fillQuad(c + 0.24, c + 0.62, NEAR_D, 130, 'rgba(0,0,0,0.05)');
  }

  // 车道虚线：世界坐标周期 9 米，长度 3.6 米
  const dashP = 9, dashLen = 3.6, dashW = 0.13;
  const off = Game.travel % dashP;
  for (let i = 0; i < 26; i++) {
    const d1 = dashP - off + i * dashP;
    if (d1 > 140) break;
    const a = Math.max(d1, NEAR_D);
    const b = d1 + dashLen;
    if (b <= NEAR_D) continue;
    for (let s = -1; s <= 1; s += 2) {
      const x = s * LANE_W * 0.5;
      fillQuad(x - dashW / 2, x + dashW / 2, a, b, 'rgba(248,248,242,0.82)');
    }
  }

  // 两侧实线
  fillQuad(-ROAD_HALF + 0.08, -ROAD_HALF + 0.20, NEAR_D, 160, 'rgba(248,248,242,0.85)');
  fillQuad(ROAD_HALF - 0.20, ROAD_HALF - 0.08, NEAR_D, 160, 'rgba(248,248,242,0.85)');

  // 红白路缘石：1.9 米一块，跟着跑道滚动
  const cPeriod = 1.9;
  const cOff = Game.travel % cPeriod;
  for (let i = 0; i < 40; i++) {
    const d1 = cPeriod - cOff + i * cPeriod;
    if (d1 > 70) break;
    const a = Math.max(d1, NEAR_D);
    const d2 = d1 + cPeriod;
    if (d2 <= NEAR_D) continue;
    const red = Math.floor((Game.travel + d1) / cPeriod) % 2 === 0;
    const style = red ? '#d94336' : '#f1efe7';
    fillQuad(-ROAD_HALF - 0.02, -ROAD_HALF - 0.30, a, d2, style);
    fillQuad(ROAD_HALF + 0.02, ROAD_HALF + 0.30, a, d2, style);
  }

  drawGuardrail(-1);
  drawGuardrail(1);
}

function drawGuardrail(side) {
  const x = side * 4.95;
  fillWall(x, 0.16, 0.26, NEAR_D, 80, 'rgba(58,62,66,0.35)');        // 贴地阴影
  fillWall(x, 0.44, 0.56, NEAR_D, 80, 'rgba(150,157,163,0.92)');    // 护栏下沿暗面
  fillWall(x, 0.56, 0.74, NEAR_D, 80, 'rgba(196,201,206,0.95)');    // 护栏主面
  fillWall(x, 0.74, 0.80, NEAR_D, 80, 'rgba(226,229,232,0.9)');     // 护栏高光

  const P = ppm();
  const per = 4.0;
  const off = Game.travel % per;
  for (let i = 0; i < 24; i++) {
    const d = per - off + i * per;
    if (d > 62 || d < NEAR_D) continue;
    const k = scaleAt(d);
    const sx = xAt(x, d);
    const sy = yAt(d);
    const hgt = 0.80 * P * k;
    const wid = Math.max(1, 0.1 * P * k);
    ctx.fillStyle = 'rgba(104,110,116,0.95)';
    ctx.fillRect(sx - wid / 2, sy - hgt, wid, hgt);
  }
}

/* 远处的空气透视：从天空一路过渡到地面，不留硬边 */
function drawHaze() {
  const gy = horizonY();
  const up = H * 0.10, dn = H * 0.20;
  const g = ctx.createLinearGradient(0, gy - up, 0, gy + dn);
  g.addColorStop(0, 'rgba(214,232,242,0)');
  g.addColorStop(up / (up + dn) * 0.55, 'rgba(214,232,242,0.35)');
  g.addColorStop(up / (up + dn), 'rgba(216,233,242,0.82)');
  g.addColorStop(1, 'rgba(216,233,242,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, gy - up, W, up + dn);
}

/* ============================================================
   场景物件（按纵深从远到近绘制）
   ============================================================ */
function drawScene() {
  const items = [];
  for (let i = 0; i < Game.props.length; i++) {
    const p = Game.props[i];
    if (p.d > NEAR_D && p.d < 135) items.push({ d: p.d, t: 0, o: p });
  }
  for (let i = 0; i < Game.objects.length; i++) {
    const o = Game.objects[i];
    if (o.d > NEAR_D && o.d < 135) items.push({ d: o.d, t: 1, o: o });
  }
  items.sort((a, b) => b.d - a.d);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === 0) drawProp(it.o);
    else drawObject(it.o);
  }
}

function drawProp(p) {
  const d = p.d;
  const k = scaleAt(d);
  const P = ppm();
  const sx = xAt(p.x, d);
  const sy = yAt(d);
  if (sx < -W * 0.6 || sx > W * 1.6) return;

  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;

  ctx.save();
  ctx.globalAlpha = fade;
  shadowEllipse(sx, sy, (p.type === 'tree' ? 1.7 : 1.0) * P * k, 0.22 * P * k, 0.22 * fade);
  ctx.translate(sx, sy);
  ctx.scale(k, k);

  if (p.type === 'tree') {
    const th = (1.9 + p.seed * 1.0) * P;
    const r = (1.25 + p.seed * 0.4) * P;
    // 树干：背光侧压暗，受光侧提亮
    ctx.fillStyle = '#5b3d26';
    ctx.fillRect(-0.12 * P, -th, 0.24 * P, th);
    ctx.fillStyle = '#7d5735';
    ctx.fillRect(-0.02 * P, -th, 0.09 * P, th);

    // 树冠：暗部 → 中间调 → 受光面，三层错位叠出体积
    const cy = -th - r * 0.3;
    const clump = (cx, cyy, rr, col) => {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cyy, rr, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - rr * 0.8, cyy + rr * 0.3, rr * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + rr * 0.85, cyy + rr * 0.18, rr * 0.62, 0, Math.PI * 2); ctx.fill();
    };
    clump(0, cy, r, '#2c6636');
    clump(r * 0.1, cy - r * 0.14, r * 0.84, '#3f8a40');
    clump(r * 0.24, cy - r * 0.3, r * 0.58, '#5aac4d');
    ctx.fillStyle = 'rgba(168,220,126,0.5)';
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.35;
      ctx.beginPath();
      ctx.ellipse(r * (0.2 + Math.cos(a) * 0.55), cy - r * (0.15 + Math.sin(a) * 0.55),
        r * 0.16, r * 0.11, a, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (p.type === 'bush') {
    const r = (0.55 + p.seed * 0.35) * P;
    ctx.fillStyle = '#2f6b36';
    ctx.beginPath(); ctx.ellipse(-r * 0.85, -r * 0.65, r, r * 0.85, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(r * 0.75, -r * 0.5, r * 0.9, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3f8f45';
    ctx.beginPath(); ctx.ellipse(0, -r * 1.1, r * 1.05, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(140,205,110,0.5)';
    ctx.beginPath(); ctx.ellipse(r * 0.35, -r * 1.35, r * 0.5, r * 0.34, -0.5, 0, Math.PI * 2); ctx.fill();
  } else if (p.type === 'rock') {
    const r = (0.45 + p.seed * 0.4) * P;
    ctx.fillStyle = '#8d9199';
    ctx.beginPath(); ctx.ellipse(0, -r * 0.55, r, r * 0.72, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a9adb5';
    ctx.beginPath(); ctx.ellipse(-r * 0.25, -r * 0.8, r * 0.55, r * 0.4, -0.3, 0, Math.PI * 2); ctx.fill();
  } else if (p.type === 'lamp') {
    const lh = (5.8 + p.seed * 0.8) * P;
    const dir = p.x < 0 ? 1 : -1;
    ctx.fillStyle = '#4d545b';
    ctx.fillRect(-0.075 * P, -lh, 0.15 * P, lh);
    ctx.fillRect(dir > 0 ? 0 : -2.1 * P, -lh, 2.1 * P, 0.12 * P);
    ctx.fillStyle = '#33393f';
    ctx.beginPath();
    ctx.roundRect(dir > 0 ? 1.75 * P : -2.15 * P, -lh - 0.03 * P, 0.55 * P, 0.22 * P, 0.1 * P);
    ctx.fill();
    // 白天灯也是暖色的玻璃片
    ctx.fillStyle = 'rgba(255,236,170,0.55)';
    ctx.fillRect(dir > 0 ? 1.8 * P : -2.1 * P, -lh + 0.02 * P, 0.45 * P, 0.05 * P);
  } else {
    // 路牌
    const sh = 2.1 * P;
    ctx.fillStyle = '#8b9299';
    ctx.fillRect(-0.06 * P, -sh, 0.12 * P, sh);
    ctx.fillStyle = '#f2f4f6';
    ctx.beginPath(); ctx.roundRect(-0.75 * P, -sh - 0.05 * P, 1.5 * P, 0.62 * P, 0.06 * P); ctx.fill();
    ctx.fillStyle = '#c93b32';
    ctx.fillRect(-0.75 * P, -sh + 0.02 * P, 1.5 * P, 0.09 * P);
  }

  ctx.restore();
}

function drawObject(o) {
  if (o.type === 'obstacle') drawObstacle(o);
  else if (o.type === 'coin') drawCoin(o);
  else if (o.type === 'bottle') drawBottle(o);
  else if (o.type === 'power') drawPower(o);
  else if (o.type === 'bomb') drawBomb(o);
}

function drawObstacle(o) {
  const d = o.d;
  const k = scaleAt(d);
  const P = ppm();
  const sx = xAt(o.x, d);
  const sy = yAt(d);
  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;

  shadowEllipse(sx, sy, o.w * 0.52 * P * k, 0.2 * P * k, 0.3 * fade);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(sx, sy);
  ctx.scale(k, k);

  const wpx = o.w * P;

  if (o.kind === 'low') {
    const top = o.top * P;
    // 立柱
    ctx.fillStyle = '#9aa1a8';
    ctx.fillRect(-wpx / 2, -top, 0.10 * P, top);
    ctx.fillRect(wpx / 2 - 0.10 * P, -top, 0.10 * P, top);
    // 红白斜纹横杆
    const barH = 0.22 * P;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-wpx / 2, -top, wpx, barH);
    ctx.clip();
    const seg = wpx / 9;
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = i % 2 ? '#f3f1e6' : '#d63b30';
      ctx.fillRect(-wpx / 2 + i * seg, -top, seg + 0.5, barH);
    }
    ctx.restore();
    // 下横杆 + 反光条
    ctx.fillStyle = '#bcc2c8';
    ctx.fillRect(-wpx / 2, -0.30 * P, wpx, 0.07 * P);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(-wpx / 2, -top + 0.02 * P, wpx, 0.03 * P);
  } else if (o.kind === 'high') {
    const top = o.top * P;
    const bot = o.bottom * P;
    // 两侧立柱
    ctx.fillStyle = '#8b939a';
    ctx.fillRect(-wpx / 2, -top, 0.15 * P, top);
    ctx.fillRect(wpx / 2 - 0.15 * P, -top, 0.15 * P, top);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(-wpx / 2 + 0.11 * P, -top, 0.04 * P, top);
    // 横梁（危险条纹）
    const beamH = (top - bot);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-wpx / 2, -top, wpx, beamH);
    ctx.clip();
    ctx.fillStyle = '#f0c419';
    ctx.fillRect(-wpx / 2, -top, wpx, beamH);
    ctx.fillStyle = '#2f3338';
    const step = 0.42 * P;
    for (let x = -wpx / 2 - beamH; x < wpx / 2; x += step * 2) {
      ctx.beginPath();
      ctx.moveTo(x, -top);
      ctx.lineTo(x + step, -top);
      ctx.lineTo(x + step + beamH, -top + beamH);
      ctx.lineTo(x + beamH, -top + beamH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // 下沿高光
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-wpx / 2, -top, wpx, 0.03 * P);
  } else {
    // 木箱
    const hpx = o.top * P;
    ctx.fillStyle = '#c08850';
    ctx.fillRect(-wpx / 2, -hpx, wpx, hpx);
    // 板缝
    ctx.fillStyle = 'rgba(120,74,34,0.35)';
    for (let i = 1; i < 4; i++) {
      ctx.fillRect(-wpx / 2, -hpx + (hpx / 4) * i, wpx, 0.035 * P);
    }
    ctx.fillStyle = '#a86f3c';
    ctx.fillRect(-wpx / 2, -hpx, wpx, 0.14 * P);
    ctx.strokeStyle = '#7d5226';
    ctx.lineWidth = 0.06 * P;
    ctx.strokeRect(-wpx / 2, -hpx, wpx, hpx);
    ctx.beginPath();
    ctx.moveTo(-wpx / 2, -hpx);
    ctx.lineTo(wpx / 2, 0);
    ctx.moveTo(wpx / 2, -hpx);
    ctx.lineTo(-wpx / 2, 0);
    ctx.stroke();
    // 顶面受光
    ctx.fillStyle = 'rgba(255,233,190,0.28)';
    ctx.fillRect(-wpx / 2, -hpx, wpx, 0.08 * P);
  }

  ctx.restore();
}

function drawCoin(o) {
  const d = o.d, k = scaleAt(d), P = ppm();
  const sx = xAt(o.x, d), sy = yAt(d);
  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;
  const bob = Math.sin(Game.time * 3.2 + o.spin) * 0.07;
  shadowEllipse(sx, sy, 0.34 * P * k, 0.1 * P * k, 0.22 * fade);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(sx, sy - (o.h + bob) * P * k);
  ctx.scale(k, k);
  const r = 0.3 * P;
  const sq = Math.abs(Math.cos(Game.time * 4 + o.spin));

  // 光晕
  const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
  glow.addColorStop(0, 'rgba(255,214,80,0.45)');
  glow.addColorStop(1, 'rgba(255,214,80,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.scale(0.22 + 0.78 * sq, 1);
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.15, 0, 0, r);
  g.addColorStop(0, '#fff8d0');
  g.addColorStop(0.5, '#ffd23f');
  g.addColorStop(1, '#d99417');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#b97b12';
  ctx.lineWidth = Math.max(1, r * 0.11);
  ctx.stroke();
  ctx.fillStyle = '#a86f0c';
  ctx.font = 'bold ' + (r * 1.0).toFixed(1) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('¥', 0, r * 0.06);
  ctx.restore();
  ctx.restore();
}

function drawBottle(o) {
  const d = o.d, k = scaleAt(d), P = ppm();
  const sx = xAt(o.x, d), sy = yAt(d);
  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;
  const bob = Math.sin(Game.time * 3 + o.spin) * 0.06;
  shadowEllipse(sx, sy, 0.26 * P * k, 0.08 * P * k, 0.2 * fade);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(sx, sy - (o.h + bob) * P * k);
  ctx.scale(k, k);
  const u = P * 0.01;    // 1 单位 ≈ 1 厘米
  ctx.fillStyle = '#f6fbff';
  ctx.beginPath(); ctx.roundRect(-14 * u, -4 * u, 28 * u, 34 * u, 6 * u); ctx.fill();
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath(); ctx.roundRect(-8 * u, -14 * u, 16 * u, 12 * u, 3 * u); ctx.fill();
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.roundRect(-7 * u, 4 * u, 14 * u, 20 * u, 4 * u); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(0, -2 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawPower(o) {
  const d = o.d, k = scaleAt(d), P = ppm();
  const sx = xAt(o.x, d), sy = yAt(d);
  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;
  let eff = effects[0];
  for (let i = 0; i < effects.length; i++) if (effects[i].key === o.kind) eff = effects[i];
  const locked = Game.raid;
  const bob = Math.sin(Game.time * 3.4) * 0.08;
  shadowEllipse(sx, sy, 0.3 * P * k, 0.09 * P * k, 0.18 * fade);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(sx, sy - (o.h + bob) * P * k);
  ctx.scale(k, k);
  const r = 0.34 * P;
  const pulse = 0.55 + Math.sin(Game.time * 6) * 0.25;

  ctx.globalAlpha = fade * (locked ? 0.18 : pulse * 0.45);
  ctx.fillStyle = locked ? '#888' : eff.color;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = fade;

  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
  if (locked) {
    g.addColorStop(0, '#c9c9c9');
    g.addColorStop(0.4, '#8f8f8f');
    g.addColorStop(1, '#4d4d4d');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.4, eff.color);
    g.addColorStop(1, eff.color);
  }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.stroke();

  ctx.fillStyle = locked ? 'rgba(255,255,255,0.3)' : '#fff';
  ctx.font = 'bold ' + (r * 1.0).toFixed(1) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(eff.char, 0, r * 0.05);
  if (locked) {
    ctx.font = 'bold ' + (r * 0.9).toFixed(1) + 'px sans-serif';
    ctx.fillText('🔒', r * 0.7, r * 0.9);
  }
  ctx.restore();
}

function drawBomb(o) {
  const d = o.d, k = scaleAt(d), P = ppm();
  const sx = xAt(o.x, d), sy = yAt(d);
  const fade = clamp((135 - d) / 28, 0, 1);
  if (fade <= 0.02) return;

  // 落点警示圈
  const pulse = 0.3 + Math.abs(Math.sin(Game.time * 8)) * 0.4;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.strokeStyle = 'rgba(255,70,40,' + (0.55 * pulse + 0.25).toFixed(3) + ')';
  ctx.lineWidth = Math.max(1, 0.05 * P * k);
  ctx.beginPath();
  ctx.ellipse(sx, sy, 0.85 * P * k, 0.3 * P * k, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  shadowEllipse(sx, sy, 0.3 * P * k, 0.09 * P * k, 0.3 * fade);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(sx, sy - Math.max(0.15, o.h) * P * k);
  ctx.scale(k, k);
  const r = 0.2 * P;
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#5f5f5f');
  g.addColorStop(1, '#0c0c0c');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.4, r * 0.24, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r * 0.3, -r * 0.9);
  ctx.quadraticCurveTo(r * 0.8, -r * 1.5, r * 1.2, -r * 1.25);
  ctx.stroke();
  ctx.lineCap = 'butt';
  const fx = r * 1.2;
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(fx, -r * 1.25, r * 0.22 + Math.random() * r * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ff6b35';
  ctx.beginPath(); ctx.arc(fx, -r * 1.25, r * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ============================================================
   玩家
   ============================================================ */
function drawPlayer() {
  const P = ppm();
  const sx = xAt(player.x, D0);
  const gy = yAt(D0);                 // 玩家脚底所在的屏幕高度

  const bob = (player.y > 0.02 ? 0 : player.bobPx);
  const squash = player.sliding ? 0.72 : 1;
  const hpx = HERO_H * P * squash;
  const aspect = sprite.hero ? sprite.heroAspect : 1.135;
  const wpx = (HERO_H * P / aspect) * (player.sliding ? 1.14 : 1);
  const fy = gy + bob - player.y * P;

  // 地面阴影：跳得越高越小越淡
  const hNorm = clamp(player.y / 3.6, 0, 1);
  const shScale = 1 - hNorm * 0.55;
  shadowEllipse(sx, gy + 2, 0.46 * P * shScale, 0.13 * P * shScale, (0.42 - hNorm * 0.26));

  // 贴地接触阴影：把"照片只到大腿"的切边压进地面
  if (player.y < 0.08) {
    const cg = ctx.createRadialGradient(sx, fy + 2, 1, sx, fy + 2, 0.34 * P);
    cg.addColorStop(0, 'rgba(10,10,12,0.5)');
    cg.addColorStop(1, 'rgba(10,10,12,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(sx, fy + 2, 0.34 * P, 0.10 * P, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 飞行时身后的小翅膀
  if (player.flying || player.y > 1.2) {
    const flap = Math.sin(Game.time * 18) * 0.5;
    ctx.save();
    ctx.translate(sx, gy + bob - player.y * P - hpx * 0.62);
    for (let s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.scale(s, 1);
      ctx.rotate(-0.45 + flap * 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(150,215,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0.55 * P, -0.3 * P, 0.75 * P, 0.28 * P, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // 护盾
  if (player.shield) {
    const remain = clamp(1 - player.shieldT / player.shieldDur, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.18 + 0.16 * remain;
    ctx.fillStyle = '#4cc9f0';
    ctx.beginPath(); ctx.ellipse(sx, fy - hpx * 0.5, wpx * 0.62, hpx * 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.5 + 0.4 * remain;
    ctx.strokeStyle = '#7fe0ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  // 无敌帧闪烁
  const blink = (player.invuln > 0 && !player.shield && Math.floor(Game.time * 16) % 2 === 0) ? 0.55 : 1;

  ctx.save();
  ctx.globalAlpha = blink;
  ctx.translate(sx, fy);
  ctx.rotate(player.tilt * 0.5 + (player.sliding ? -0.22 : 0));
  if (player.stunned) ctx.rotate(Math.sin(Game.time * 42) * 0.05);

  const heroImg = sprite.heroArt || sprite.hero;
  if (heroImg) {
    // 逆光轮廓：深色衣服压在深色沥青上时靠这一圈冷光把人物"抠"出来
    ctx.save();
    ctx.shadowColor = 'rgba(196,226,255,0.95)';
    ctx.shadowBlur = Math.max(7, hpx * 0.10);
    ctx.drawImage(heroImg, -wpx / 2, -hpx, wpx, hpx);
    ctx.restore();
    ctx.drawImage(heroImg, -wpx / 2, -hpx, wpx, hpx);
  } else {
    drawFallbackHero(wpx, hpx);
  }
  ctx.restore();

  // 名牌
  if (!player.sliding) {
    const tagY = fy - hpx - 10;
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = '金东';
    const tw = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(10,16,24,0.5)';
    ctx.beginPath();
    ctx.roundRect(sx - tw / 2, tagY - 19, tw, 20, 10);
    ctx.fill();
    ctx.fillStyle = '#9be7a4';
    ctx.fillText(label, sx, tagY - 3);
    ctx.restore();
  }

  // 踉跄星星
  if (player.stunned) {
    ctx.save();
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 3;
    ctx.translate(sx, fy - hpx * 0.95);
    ctx.rotate(Math.sin(Game.time * 20) * 0.25);
    for (let i = 0; i < 3; i++) {
      const a = Game.time * 7 + i * 2.09;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 22, Math.sin(a) * 7, 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* 贴图丢失时的兜底：一只圆滚滚的奶龙 */
function drawFallbackHero(wpx, hpx) {
  const s = hpx / 118;
  ctx.save();
  ctx.scale(s, s);
  const bob = 0;
  ctx.fillStyle = '#ffd93b';
  ctx.beginPath(); ctx.ellipse(0, -54, 46, 50, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fffbe8';
  ctx.beginPath(); ctx.ellipse(0, -28, 30, 30, 0, 0, Math.PI * 2); ctx.fill();
  for (let side = -1; side <= 1; side += 2) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(side * 19, -70, 14, 15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2c2418';
    ctx.beginPath(); ctx.ellipse(side * 19 + 2, -69, 9.5, 11, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#f7a800';
  ctx.beginPath(); ctx.roundRect(-30, -22, 20, 22, 8); ctx.fill();
  ctx.beginPath(); ctx.roundRect(10, -22, 20, 22, 8); ctx.fill();
  ctx.restore();
}

/* ============================================================
   追捕者：真的站在玩家身后的跑道上
   ============================================================ */
function drawChaser() {
  if (Game.binbin !== 'chasing') return;
  if (Game.state !== 'playing' && Game.state !== 'over') return;
  const d = D0 - Game.gapM;
  if (d < 2.2) return;
  const k = scaleAt(d);
  const P = ppm();
  const sx = xAt(Game.chX, d);
  const sy = yAt(d);
  if (sy > H + 260) return;

  const alpha = clamp((Game.chaseMax - Game.chaseT) / 0.25, 0, 1) * clamp(Game.chaseT / 0.35, 0, 1);
  if (alpha <= 0.01) return;

  const hpx = HERO_H * P * k;
  const aspect = sprite.chaser ? sprite.chaserAspect : 1.842;
  const wpx = hpx / aspect;
  const stepPhase = player.step + 1.1;
  const bob = -Math.abs(Math.sin(stepPhase)) * 3.2 * k * 0.6;

  ctx.save();
  ctx.globalAlpha = alpha;
  shadowEllipse(sx, sy + 2, 0.5 * P * k, 0.14 * P * k, 0.32);

  // 逼近时的红色危险气息
  if (Game.gapM > 0.95) {
    const r = clamp((Game.gapM - 0.95) / 0.5, 0, 1);
    const rg = ctx.createRadialGradient(sx, sy - hpx * 0.5, 8, sx, sy - hpx * 0.5, hpx * 0.62);
    rg.addColorStop(0, 'rgba(220,40,40,' + (0.15 * r).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(220,40,40,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(sx, sy - hpx * 0.5, hpx * 0.62, 0, Math.PI * 2); ctx.fill();
  }

  ctx.translate(sx, sy + bob);
  ctx.rotate(Math.sin(stepPhase * 0.5) * 0.02);
  const chImg = sprite.chaserArt || sprite.chaser;
  if (chImg) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,190,190,0.9)';
    ctx.shadowBlur = Math.max(6, hpx * 0.08);
    ctx.drawImage(chImg, -wpx / 2, -hpx, wpx, hpx);
    ctx.restore();
    ctx.drawImage(chImg, -wpx / 2, -hpx, wpx, hpx);
  } else {
    drawFallbackHero(wpx, hpx);
  }
  ctx.restore();

  // 名牌
  if (sy - hpx > -40) {
    const tagY = sy - hpx - 6;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = '团支书彬彬';
    const tw = ctx.measureText(label).width + 18;
    ctx.fillStyle = 'rgba(10,16,24,0.55)';
    ctx.beginPath();
    ctx.roundRect(sx - tw / 2, tagY - 21, tw, 22, 11);
    ctx.fill();
    ctx.fillStyle = '#ff8fa3';
    ctx.fillText(label, sx, tagY - 3);
    ctx.restore();
  }
}

/* ============================================================
   粒子
   ============================================================ */
function drawParticles() {
  const P = ppm();
  for (let i = 0; i < Game.particles.length; i++) {
    const p = Game.particles[i];
    if (p.d < NEAR_D - 0.5) continue;
    const k = scaleAt(p.d);
    const sx = xAt(p.x, p.d);
    const sy = yAt(p.d) - p.h * P * k;
    const lifeR = 1 - p.t / p.life;
    if (p.kind === 'dust') {
      const r = p.size * P * k * (1.7 - lifeR * 0.7);
      if (r < 0.6) continue;
      ctx.save();
      ctx.globalAlpha = 0.30 * lifeR;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(dustSprite, sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    } else {
      const r = p.size * P * k;
      if (r < 0.4) continue;
      ctx.save();
      ctx.globalAlpha = 0.95 * lifeR;
      ctx.fillStyle = 'rgb(' + p.rgb + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ============================================================
   速度感 / 危险气氛
   ============================================================ */
function drawSpeedFx() {
  const sp = clamp((Game.speed - 8.6) / 4.4, 0, 1);
  if (sp > 0.03) {
    const cx = W * 0.5, cy = yAt(220);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Game.time * 0.35;
      const rr = Math.min(W, H) * (0.40 + (i % 4) * 0.06);
      const len = (26 + (i % 5) * 22) * sp;
      const x1 = cx + Math.cos(a) * rr;
      const y1 = cy + Math.sin(a) * rr * 0.55;
      const x2 = cx + Math.cos(a) * (rr + len);
      const y2 = cy + Math.sin(a) * (rr + len) * 0.55;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.05 * sp).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.restore();
  }

  // 彬彬贴身时的红色暗角
  if (Game.binbin === 'chasing' && Game.gapM > 0.95) {
    const r = clamp((Game.gapM - 0.95) / 0.5, 0, 1);
    const g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.28,
                                        W / 2, H * 0.55, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(120,0,0,0)');
    g.addColorStop(1, 'rgba(120,0,0,' + (0.42 * r).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

/* ============================================================
   HUD
   ============================================================ */
function drawHUD() {
  const pad = 16;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // 左上角半透明底板，避免白字压在淡色天空上看不清
  ctx.fillStyle = 'rgba(8,14,22,0.42)';
  ctx.beginPath();
  ctx.roundRect(pad - 11, pad - 9, 236, 118, 14);
  ctx.fill();

  // 跑动距离
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillText('跑动距离', pad + 1, pad + 1);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillText('跑动距离', pad, pad);

  ctx.font = 'bold 34px sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillText(Math.floor(Game.distance) + ' m', pad + 2, pad + 17);
  ctx.fillStyle = '#ffe066';
  ctx.fillText(Math.floor(Game.distance) + ' m', pad, pad + 15);

  // 速度
  const kmh = (Game.speed * 3.6).toFixed(0);
  ctx.font = 'bold 14px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('时速 ' + kmh + ' km/h', pad, pad + 60);

  // 金币 / 分数
  const cy2 = pad + 84;
  let lx = pad;
  const cg = ctx.createRadialGradient(lx + 8, cy2 + 7, 1, lx + 9, cy2 + 9, 10);
  cg.addColorStop(0, '#fff3b0');
  cg.addColorStop(0.6, '#ffd23f');
  cg.addColorStop(1, '#d99216');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(lx + 9, cy2 + 9, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#b97b12';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#9c6708';
  ctx.textAlign = 'center';
  ctx.fillText('¥', lx + 9, cy2 + 3);
  ctx.textAlign = 'left';
  lx += 22;

  ctx.font = 'bold 17px sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillText('x ' + Game.coins, lx + 1, cy2 + 1);
  ctx.fillStyle = '#fff';
  ctx.fillText('x ' + Game.coins, lx, cy2);
  lx += 16 + ctx.measureText('x ' + Game.coins).width + 16;

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillText('分数 ' + Math.floor(Game.score), lx + 1, cy2 + 1);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillText('分数 ' + Math.floor(Game.score), lx, cy2);

  // 追逐倒计时条
  if (Game.binbin === 'chasing') {
    const bw = Math.min(W * 0.46, 320);
    const bx = W - bw - pad;
    const by = pad + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(bx - 3, by - 3, bw + 6, 18);
    const frac = clamp(Game.chaseT / Game.chaseMax, 0, 1);
    ctx.fillStyle = Game.raid ? '#c1121f' : '#ff6b6b';
    ctx.fillRect(bx, by, bw * frac, 12);
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText((Game.raid ? '突袭 ' : '彬彬 ') + Math.max(0, Game.chaseT).toFixed(1) + 's', bx - 8, by - 4);
    ctx.textAlign = 'left';
  }

  // 状态图标
  let iconY = pad + 34;
  const iconX = W - pad - 22;
  const drawIcon = (txt) => {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(iconX, iconY + 9, 15, 0, Math.PI * 2); ctx.fill();
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, iconX, iconY + 10);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    iconY += 34;
  };
  if (player.shield) drawIcon('🛡' + Math.max(0, player.shieldDur - player.shieldT).toFixed(1));
  if (player.magnet) drawIcon('🧲' + Math.max(0, player.magnetDur - player.magnetT).toFixed(1));
  if (player.flying) drawIcon('✈' + Math.max(0, Math.ceil(FLY_DUR - player.flyT)));

  // 中央提示
  if (Game.alertT > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(Game.alertT / 0.45, 0, 1);
    ctx.font = 'bold 23px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(Game.alertText, W / 2 + 2, H * 0.18 + 2);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(Game.alertText, W / 2, H * 0.18);
    ctx.restore();
  }

  ctx.restore();
}

/* ============================================================
   主绘制
   ============================================================ */
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  drawSky();

  ctx.save();
  const camBob = player.bobPx * 0.22 + (Game.state === 'playing' ? 0 : 0);
  const shakeX = Game.shake > 0 ? rand(-Game.shake, Game.shake) : 0;
  const shakeY = Game.shake > 0 ? rand(-Game.shake, Game.shake) : 0;
  ctx.translate(shakeX, shakeY + camBob);

  drawRoad();
  drawScene();
  drawHaze();
  drawParticles();
  drawPlayer();
  drawChaser();

  ctx.restore();

  drawSpeedFx();

  if (Game.state === 'playing') drawHUD();

  if (Game.flash > 0) {
    ctx.fillStyle = 'rgba(220,40,40,' + (Game.flash * 0.5).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }
}

/* ---------------- 主循环 ---------------- */
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

initClouds();
initTexture();
reset();
requestAnimationFrame(loop);

})();
