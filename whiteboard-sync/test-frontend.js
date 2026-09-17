'use strict';
/*
 * 前端逻辑测试（无浏览器环境）：
 * 用轻量 DOM / Canvas2D stub 加载真实的 public/app.js，WebSocket 走真实 ws 连接本地服务端，
 * 模拟 pointerdown/move/up 与服务端消息，验证：
 *   - 本地预提交：pointerdown 后立即绘制，pointerup 才发送 stroke
 *   - 双缓冲：历史走离屏，主 Canvas 每帧 drawImage
 *   - 贝塞尔平滑：增量段产生 quadraticCurveTo
 *   - 自己笔迹不重复渲染；远端 op 幂等不闪烁
 *   - reset 全量重放 / 增量补齐 / lastSeq 推进
 */
const fs = require('fs');
const path = require('path');
const RealWS = require('ws');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => sleep(25);

/* ---------------- Canvas2D 录制 stub ---------------- */
function makeCtx2d(label, log) {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', globalAlpha: 1,
    setTransform() {}, clearRect() {},
    beginPath() { log.push(`${label}.beginPath`); },
    moveTo(x, y) { log.push(`${label}.moveTo(${x},${y})`); },
    lineTo(x, y) { log.push(`${label}.lineTo(${x},${y})`); },
    quadraticCurveTo(cx, cy, x, y) { log.push(`${label}.quad(${cx},${cy}->${x},${y})`); },
    arc() { log.push(`${label}.arc`); },
    fill() { log.push(`${label}.fill`); },
    stroke() { log.push(`${label}.stroke`); },
    drawImage() { log.push(`${label}.drawImage(OFFSCREEN)`); }
  };
}

function makeCanvas(id, log) {
  const listeners = {};
  return {
    id, width: 0, height: 0, style: {},
    getContext: () => makeCtx2d(id, log),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    _emit(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
    classList: { add() {}, remove() {}, toggle() {} }
  };
}

function makeEl(id) {
  const listeners = {};
  return {
    id, value: id === 'roomInput' ? 'room-x' : (id === 'widthInput' ? '4' : ''),
    textContent: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    closest() { return null; },
    querySelectorAll: () => [],
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    _emit(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); }
  };
}

/* ---------------- 全局环境 ---------------- */
const drawLog = [];
const mainCanvas = makeCanvas('MAIN', drawLog);
const els = {};
[
  'joinScreen', 'joinForm', 'roomInput', 'nameInput', 'app', 'roomLabel',
  'userLabel', 'boardWrap', 'colors', 'widthInput', 'widthValue',
  'statusDot', 'statusText', 'seqText'
].forEach((id) => (els[id] = makeEl(id)));

const store = {};
let liveSocket = null;

global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};
global.window = { addEventListener() {}, devicePixelRatio: 1 };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.document = {
  getElementById(id) {
    if (id === 'mainCanvas') return mainCanvas;
    return els[id] || makeEl(id);
  },
  createElement(tag) {
    if (tag === 'canvas') return makeCanvas('OFF', drawLog);
    return makeEl(tag);
  }
};
global.navigator = { onLine: true };
global.location = { protocol: 'http:', host: 'localhost:8080' };

// 捕获 app.js 创建的 socket，便于向其注入服务端消息
const PORT = process.env.PORT || 8080;
global.WebSocket = class extends RealWS {
  constructor(_url) {
    super(`ws://localhost:${PORT}/ws`);
    liveSocket = this;
  }
  dispatchFromTest(obj) {
    // ws 的 addEventListener('message') 包装器会消费 (data) 生成 ev.data
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
};

// 单次加载真实前端代码
(0, eval)(fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8'));

/* ---------------- 模拟 pointer ---------------- */
function pointer(type, x, y, button = 0) {
  mainCanvas._emit(type, {
    type, button, pointerId: 1, clientX: x, clientY: y,
    preventDefault() {},
    getCoalescedEvents() { return [{ clientX: x, clientY: y }]; }
  });
}

async function run() {
  // 1) 提交加入表单 -> 连接 + join
  els.joinForm._emit('submit', { preventDefault() {} });
  await sleep(250);
  assert(store['wb_user_id'], 'userId persisted to localStorage');
  assert(!!liveSocket && liveSocket.readyState === RealWS.OPEN, 'websocket connected after join');

  // 2) pointerdown 立即本地渲染（预提交）
  drawLog.length = 0;
  pointer('pointerdown', 10, 10);
  await nextFrame();
  assert(drawLog.some((l) => l === 'MAIN.drawImage(OFFSCREEN)'), 'pointerdown composites history immediately (pre-commit)');
  assert(drawLog.some((l) => l === 'MAIN.fill'), 'dot painted instantly, zero wait for server ack');

  // 3) pointermove 走二次贝塞尔增量段
  pointer('pointermove', 20, 14);
  pointer('pointermove', 30, 8);
  pointer('pointermove', 40, 16);
  const quads = drawLog.filter((l) => l.startsWith('MAIN.quad'));
  assert(quads.length >= 2, `live move uses quadraticCurveTo segments (got ${quads.length})`);
  assert(drawLog.some((l) => l.startsWith('MAIN.quad')), 'no polyline: midpoint bezier smoothing applied');

  // 4) pointerup：合并离屏 + 发送 stroke
  drawLog.length = 0;
  pointer('pointerup', 40, 16);
  await nextFrame();
  assert(drawLog.some((l) => l.startsWith('OFF.moveTo')), 'finished stroke merged into offscreen buffer');
  assert(drawLog.some((l) => l === 'MAIN.drawImage(OFFSCREEN)'), 'main canvas recomposites from offscreen after commit');

  // 5) 等服务端 ack：自己的笔迹只画一次，不重影
  await sleep(200);
  const offPaints = drawLog.filter((l) => l === 'OFF.beginPath').length;
  assert(offPaints === 1, `own stroke painted exactly once (got ${offPaints}), no duplicate render`);

  // 6) 远端 op：渲染一次
  drawLog.length = 0;
  liveSocket.dispatchFromTest({
    type: 'op',
    op: {
      seq: 50, roomId: 'room-x', userId: 'remote', strokeId: 'remote-1',
      color: '#ef4444', width: 3,
      points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }], ts: Date.now()
    }
  });
  await nextFrame();
  assert(drawLog.some((l) => l.startsWith('OFF.quad')), 'remote stroke rendered with bezier smoothing');
  assert(drawLog.filter((l) => l === 'MAIN.drawImage(OFFSCREEN)').length === 1, 'remote op triggers one recomposite frame');

  // 7) 重复 op 幂等
  drawLog.length = 0;
  liveSocket.dispatchFromTest({ type: 'op', op: { seq: 50, strokeId: 'remote-1', color: '#000', width: 1, points: [{ x: 0, y: 0 }] } });
  await nextFrame();
  assert(drawLog.length === 0, 'duplicate strokeId ignored (idempotent, no flicker)');

  // 8) 断线增量补齐
  drawLog.length = 0;
  liveSocket.dispatchFromTest({
    type: 'sync', reset: false,
    ops: [
      { seq: 60, strokeId: 'miss-1', color: '#2563eb', width: 2, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] },
      { seq: 61, strokeId: 'miss-2', color: '#16a34a', width: 2, points: [{ x: 2, y: 2 }, { x: 6, y: 6 }] }
    ]
  });
  await nextFrame();
  assert(drawLog.some((l) => l === 'MAIN.drawImage(OFFSCREEN)'), 'incremental sync backfills missing strokes');
  assert(els.seqText.textContent === 'seq 61', `lastSeq advanced to 61 (got "${els.seqText.textContent}")`);

  drawLog.length = 0;
  liveSocket.dispatchFromTest({ type: 'sync', reset: false, ops: [{ seq: 60, strokeId: 'miss-1', color: '#000', width: 1, points: [] }] });
  await nextFrame();
  assert(drawLog.length === 0, 're-synced known strokeId skipped');

  // 9) 刷新后 reset 全量重放
  drawLog.length = 0;
  liveSocket.dispatchFromTest({
    type: 'sync', reset: true,
    ops: [
      { seq: 1, strokeId: 'h1', color: '#000', width: 2, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
      { seq: 2, strokeId: 'h2', color: '#f00', width: 2, points: [{ x: 4, y: 4 }, { x: 5, y: 5 }] }
    ]
  });
  await nextFrame();
  assert(drawLog.some((l) => l === 'OFF.moveTo(1,1)'), 'reset sync replays history onto offscreen');
  assert(drawLog.some((l) => l === 'MAIN.drawImage(OFFSCREEN)'), 'reset sync recomposites main canvas');
  assert(els.seqText.textContent === 'seq 2', `reset aligns lastSeq to server value 2 (got "${els.seqText.textContent}")`);

  // 10) 断线期间本地笔迹：socket 关闭后提交一笔，立即上屏并入 pending（不报错）
  const http = require('http');
  const apiRoom = () => new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/api/room?roomId=room-x`, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });

  const oldSocket = liveSocket;
  oldSocket.close();
  await sleep(120);
  assert(els.statusText.textContent === '重连中…', `status shows reconnecting (got "${els.statusText.textContent}")`);

  // 断线期间画一笔：本地立即可见，发送失败进入 pending
  drawLog.length = 0;
  pointer('pointerdown', 80, 80);
  pointer('pointermove', 90, 90);
  pointer('pointerup', 100, 85);
  await nextFrame();
  assert(drawLog.some((l) => l === 'MAIN.fill'), 'offline stroke still rendered instantly (optimistic)');

  // 等待指数退避后自动重连（首跳 500ms + 抖动）
  let reconnected = false;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (liveSocket !== oldSocket && liveSocket.readyState === RealWS.OPEN && els.statusText.textContent === '已连接') {
      reconnected = true;
      break;
    }
  }
  assert(reconnected, 'auto reconnect with exponential backoff succeeded, status back to 已连接');

  // 离线笔迹被重发，服务端 OpLog 中应能查到
  let found = false;
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const info = await apiRoom();
    found = (info.ops || []).some((op) => op.points[0].x === 80 && op.points[0].y === 80);
    if (found) break;
  }
  assert(found, 'offline-drawn stroke flushed after reconnect and persisted in server OpLog');

  console.log(`\n========================================`);
  console.log(`FRONTEND RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error('FRONTEND TEST CRASHED:', err); process.exit(1); });
