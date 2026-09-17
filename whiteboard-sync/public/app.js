'use strict';

/* ===========================================================================
 * 直播白板低延迟同步 - 前端
 *
 * 关键设计：
 *  1. 双缓冲：offCanvas 承载历史笔迹；mainCanvas 每帧 drawImage 历史 + 当前笔迹
 *  2. 本地预提交：pointerdown 立即渲染，pointerup 才把整笔发给服务端
 *  3. 贝塞尔平滑：相邻点中点为终点、中间点为控制点做 quadraticCurveTo
 *  4. 幂等去重：seenStrokeIds 防止断线重发 / 重连同步导致的重复渲染
 *  5. 指数退避重连 + lastSeq 增量补齐断线期间笔迹
 * ========================================================================= */

// ------------------------------ DOM ------------------------------
const $ = (id) => document.getElementById(id);

const joinScreen = $('joinScreen');
const joinForm = $('joinForm');
const roomInput = $('roomInput');
const nameInput = $('nameInput');
const app = $('app');
const roomLabel = $('roomLabel');
const userLabel = $('userLabel');
const boardWrap = $('boardWrap');
const mainCanvas = $('mainCanvas');
const mainCtx = mainCanvas.getContext('2d');

const colorsBox = $('colors');
const widthInput = $('widthInput');
const widthValue = $('widthValue');
const statusDot = $('statusDot');
const statusText = $('statusText');
const seqText = $('seqText');

// ------------------------------ 状态 ------------------------------
const userId = getOrCreateUserId();
let roomId = null;

// 网络状态：online（已连接）/ connecting（连接中/重连中）/ offline（离线）
let connState = 'offline';
let ws = null;
let reconnectAttempts = 0;
let everConnected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let watchdogTimer = null;
let lastMessageAt = 0;

// 已被服务端确认前的本地笔迹（断线期间积压，重连后重发，服务端按 strokeId 幂等去重）
const pending = new Map();
let lastSeq = 0;

// 画板
const offCanvas = document.createElement('canvas'); // 离屏：历史缓冲
const offCtx = offCanvas.getContext('2d');
const strokes = [];                               // 历史笔迹（用于 resize 重建）
const seenStrokeIds = new Set();                  // 幂等去重
let cssWidth = 0;
let cssHeight = 0;
let dpr = 1;

// 当前正在书写的笔迹
let drawing = false;
let currentStroke = null;

// 工具
let color = '#1f2937';
let width = 4;

// 远端笔迹渲染合批
let renderQueued = false;
const remoteQueue = [];

// ------------------------------ 工具函数 ------------------------------
function getOrCreateUserId() {
  let id = null;
  try {
    id = localStorage.getItem('wb_user_id');
  } catch (_) { /* 隐私模式等场景忽略 */ }
  if (!id) {
    id = 'u-' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('wb_user_id', id); } catch (_) { /* noop */ }
  }
  return id;
}

function createStrokeId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function setStatus(state) {
  connState = state;
  statusDot.classList.remove('online', 'connecting', 'offline');
  if (state === 'online') {
    statusDot.classList.add('online');
    statusText.textContent = '已连接';
  } else if (state === 'connecting') {
    statusDot.classList.add('connecting');
    statusText.textContent = everConnected ? '重连中…' : '连接中…';
  } else {
    statusDot.classList.add('offline');
    statusText.textContent = '离线';
  }
}

function updateSeqText() {
  seqText.textContent = `seq ${lastSeq}`;
}

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.warn('[send] failed:', err);
    }
  }
  return false;
}

// ------------------------------ Canvas 初始化 / 双缓冲 ------------------------------
function resizeCanvas() {
  const rect = boardWrap.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  cssWidth = w;
  cssHeight = h;
  dpr = Math.min(window.devicePixelRatio || 1, 3);

  // 调整主 Canvas（保留当前笔迹像素意义不大，直接按矢量点重绘）
  mainCanvas.width = Math.round(w * dpr);
  mainCanvas.height = Math.round(h * dpr);

  // 调整离屏 Canvas，并把历史笔迹全部重放重建
  offCanvas.width = Math.round(w * dpr);
  offCanvas.height = Math.round(h * dpr);

  mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  rebuildHistory();
  renderMain();
}

function rebuildHistory() {
  offCtx.clearRect(0, 0, cssWidth, cssHeight);
  for (const stroke of strokes) {
    paintStroke(offCtx, stroke);
  }
}

/**
 * 重绘主 Canvas：先画离屏历史，再由调用方叠加当前笔迹。
 */
function renderMain() {
  mainCtx.clearRect(0, 0, cssWidth, cssHeight);
  mainCtx.drawImage(offCanvas, 0, 0, cssWidth, cssHeight);
}

// ------------------------------ 笔迹绘制（贝塞尔平滑） ------------------------------
function applyStyle(ctx, strokeOrStyle) {
  ctx.strokeStyle = strokeOrStyle.color;
  ctx.fillStyle = strokeOrStyle.color;
  ctx.lineWidth = strokeOrStyle.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
}

function midPoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 完整绘制一笔（离屏重放 / 远端笔迹使用）。
 * 平滑算法：相邻点中点作为曲线终点，中间点作为控制点做二次贝塞尔插值，
 * 消除直接 lineTo 的折线感。
 */
function paintStroke(ctx, stroke) {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  applyStyle(ctx, stroke);
  ctx.beginPath();

  if (pts.length === 1) {
    // 点按：画一个圆点
    ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.moveTo(pts[0].x, pts[0].y);

  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    // 先用第一段中点落第一笔
    let m = midPoint(pts[0], pts[1]);
    ctx.lineTo(m.x, m.y);
    // p_i 作为控制点，(p_i, p_{i+1}) 的中点作为终点
    for (let i = 1; i < pts.length - 1; i++) {
      m = midPoint(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    // 收尾连到最后一个点，避免最后一段缺角
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  ctx.stroke();
}

/**
 * 增量绘制当前笔迹（pointermove 中调用，只画最新一小段，保证跟手）。
 * 与 paintStroke 的中点贝塞尔算法保持一致；配合 round cap，段间无缝。
 */
function paintIncrementSegment() {
  const pts = currentStroke.points;
  const n = pts.length;
  if (n < 2) return;

  applyStyle(mainCtx, currentStroke);

  if (n === 2) {
    const m = midPoint(pts[0], pts[1]);
    mainCtx.lineTo(m.x, m.y);
    mainCtx.stroke();
    // 下一段从中点开始，避免重复描边旧路径
    mainCtx.beginPath();
    mainCtx.moveTo(m.x, m.y);
  } else {
    const ctrl = pts[n - 2];
    const m = midPoint(pts[n - 2], pts[n - 1]);
    mainCtx.quadraticCurveTo(ctrl.x, ctrl.y, m.x, m.y);
    mainCtx.stroke();
    mainCtx.beginPath();
    mainCtx.moveTo(m.x, m.y);
  }
}

function finishIncrementStroke() {
  const pts = currentStroke.points;
  if (pts.length >= 2) {
    applyStyle(mainCtx, currentStroke);
    mainCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    mainCtx.stroke();
    mainCtx.beginPath();
  }
}

// ------------------------------ 远端操作 ------------------------------
function applyOp(op) {
  if (!op || typeof op.seq !== 'number') return;
  if (!op.strokeId || seenStrokeIds.has(op.strokeId)) {
    // 幂等：断线重发 / sync 重放 / 自己笔迹回流，均不重复绘制
    lastSeq = Math.max(lastSeq, op.seq);
    updateSeqText();
    return;
  }
  applyOpInternal(op, false);
  lastSeq = Math.max(lastSeq, op.seq);
  updateSeqText();
}

/**
 * 把一条操作加入历史并安排合并渲染。
 * @param {boolean} bulk 是否处于 reset 批量重放（批量时由调用方统一推进 lastSeq）
 */
function applyOpInternal(op, bulk) {
  if (!op.strokeId || seenStrokeIds.has(op.strokeId)) return;

  const stroke = {
    strokeId: op.strokeId,
    userId: op.userId,
    color: op.color,
    width: op.width,
    points: op.points
  };

  seenStrokeIds.add(op.strokeId);
  strokes.push(stroke);
  remoteQueue.push(stroke);
  if (!bulk) scheduleRemoteComposite();
}
function scheduleRemoteComposite() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (remoteQueue.length === 0) return;

    // 1. 合并进离屏历史
    for (const stroke of remoteQueue) {
      paintStroke(offCtx, stroke);
    }

    if (drawing) {
      // 2a. 正在书写时不能清空主 Canvas（会擦掉当前笔迹），
      //     直接把远端笔迹叠画到主 Canvas；当前笔结束合并离屏后像素完全重合，无重影
      for (const stroke of remoteQueue) {
        paintStroke(mainCtx, stroke);
      }
    } else {
      // 2b. 空闲：用离屏历史整体重绘主 Canvas
      renderMain();
    }
    remoteQueue.length = 0;
  });
}

// ------------------------------ 指针事件（鼠标/触控笔/触摸屏） ------------------------------
function getPoint(e) {
  const rect = mainCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

mainCanvas.addEventListener('pointerdown', (e) => {
  // 仅主键 / 笔尖 / 触摸响应
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();

  try { mainCanvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }

  drawing = true;
  currentStroke = {
    strokeId: createStrokeId(),
    userId,
    color,
    width,
    points: [getPoint(e)]
  };

  // 本地预提交：落笔瞬间立即渲染，不等待服务端
  renderMain();
  applyStyle(mainCtx, currentStroke);
  mainCtx.beginPath();
  mainCtx.moveTo(currentStroke.points[0].x, currentStroke.points[0].y);
  // 单点先显示一个圆点（点按场景）
  mainCtx.arc(currentStroke.points[0].x, currentStroke.points[0].y, width / 2, 0, Math.PI * 2);
  mainCtx.fill();
  // 重建路径起点，arc 会改变当前路径
  mainCtx.beginPath();
  mainCtx.moveTo(currentStroke.points[0].x, currentStroke.points[0].y);
});

mainCanvas.addEventListener('pointermove', (e) => {
  if (!drawing || !currentStroke) return;
  e.preventDefault();

  // 合并浏览器收集的高频坐标事件，触控笔/触摸屏下更顺滑
  const events = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length
    ? e.getCoalescedEvents()
    : [e];

  for (const ev of events) {
    const p = getPoint(ev);
    const last = currentStroke.points[currentStroke.points.length - 1];
    // 过滤完全重复的点
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    currentStroke.points.push(p);
    paintIncrementSegment();
  }
});

function endStroke(e) {
  if (!drawing || !currentStroke) return;
  if (e) e.preventDefault();
  drawing = false;

  try { mainCanvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }

  finishIncrementStroke();

  const stroke = currentStroke;
  currentStroke = null;
  commitLocalStroke(stroke);
}

mainCanvas.addEventListener('pointerup', endStroke);
mainCanvas.addEventListener('pointercancel', endStroke);
// 指针意外离开（如系统弹窗打断）也安全收笔
window.addEventListener('pointerup', (e) => {
  if (drawing && e.target !== mainCanvas) endStroke(e);
});

// 长按 / 右键不弹菜单
mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * 本地笔迹提交：
 *  1. 立即合并进离屏历史（零网络等待）
 *  2. 主 Canvas 用离屏重绘（自己的笔迹绝不因服务端回流而画第二次）
 *  3. 加入 pending 队列并发送；未收到 ack 前断线会在重连后重发
 */
function commitLocalStroke(stroke) {
  seenStrokeIds.add(stroke.strokeId);
  strokes.push(stroke);
  paintStroke(offCtx, stroke);
  renderMain();

  pending.set(stroke.strokeId, stroke);
  const delivered = sendMsg({ type: 'stroke', stroke });
  if (!delivered) {
    console.info('[offline] stroke queued locally:', stroke.strokeId);
  }
}

// ------------------------------ 工具栏 ------------------------------
colorsBox.addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch');
  if (!btn) return;
  color = btn.dataset.color;
  colorsBox.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === btn));
});

widthInput.addEventListener('input', () => {
  width = Number(widthInput.value);
  widthValue.textContent = String(width);
});

// ------------------------------ 网络：连接 / 心跳 / 指数退避重连 ------------------------------
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  console.log(`[ws] connecting ${url} (attempt ${reconnectAttempts})`);

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error('[ws] construct failed:', err);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', () => {
    console.log('[ws] open, joining room:', roomId, 'lastSeq =', lastSeq);
    // 握手后加入房间（首次全量 / 重连带 lastSeq 增量）
    sendMsg({
      type: 'join',
      roomId,
      userId,
      lastSeq,
      name: nameInput.value.trim()
    });
    startHeartbeat();
  });

  socket.addEventListener('message', (ev) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'joined':
        reconnectAttempts = 0;
        everConnected = true;
        setStatus('online');
        console.log('[ws] joined, server lastSeq =', msg.lastSeq);
        flushPending();
        break;

      case 'sync':
        handleSync(msg);
        break;

      case 'op':
        applyOp(msg.op);
        break;

      case 'ack':
        // 本地已预提交渲染，ack 不触发重绘，仅推进 lastSeq / 清理待发队列
        pending.delete(msg.strokeId);
        // 标记已入库：以后断线重连的增量 sync 再带回这笔时可幂等跳过
        if (msg.strokeId) seenStrokeIds.add(msg.strokeId);
        lastSeq = Math.max(lastSeq, msg.seq);
        updateSeqText();
        break;

      case 'pong':
        break;

      case 'error':
        console.warn('[server error]', msg.message);
        break;
    }
  });

  socket.addEventListener('close', () => {
    stopTimers();
    if (ws === socket) ws = null;
    setStatus(navigator.onLine ? 'connecting' : 'offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // close 事件会紧随其后，统一在 close 中重连
    try { socket.close(); } catch (_) { /* noop */ }
  });

  lastMessageAt = Date.now();
  startWatchdog();
}

function handleSync(msg) {
  const ops = Array.isArray(msg.ops) ? msg.ops.slice().sort((a, b) => a.seq - b.seq) : [];

  if (msg.reset) {
    // 首次加入 / 刷新：以服务端 OpLog 为准，全量重放。
    // 注意：先在“保留 seenStrokeIds”的状态下消费服务端操作——
    // 这样本地预提交但未 ack 的笔迹在重放中命中早退分支时，不会错误推进 lastSeq。
    strokes.length = 0;
    remoteQueue.length = 0;
    offCtx.clearRect(0, 0, cssWidth, cssHeight);

    let serverMaxSeq = 0;
    for (const op of ops) {
      serverMaxSeq = Math.max(serverMaxSeq, op.seq);
      if (op.strokeId && seenStrokeIds.has(op.strokeId)) {
        // 极端情况：本地预提交笔迹已在 OpLog 中（ack 丢失等）。
        // 这里不绘制，交由下面的 pending 保留逻辑统一补回，避免重复。
        continue;
      }
      applyOpInternal(op, true);
    }

    // 服务端 OpLog 之外的本地笔迹（典型：首连尚未成功时画的），
    // reset 已清空 strokes，这里全部重新保留并显示；
    // joined 后的 flushPending 会把它们发给服务端入库。
    const present = new Set(strokes.map((s) => s.strokeId));
    for (const local of Array.from(pending.values())) {
      if (!present.has(local.strokeId)) {
        present.add(local.strokeId);
        strokes.push(local);
        remoteQueue.push(local);
      }
    }
    if (remoteQueue.length) scheduleRemoteComposite();

    // 最后再把 seq 对齐到服务端权威值（绝不能被本地笔迹的早退分支抬高）
    lastSeq = serverMaxSeq;
  } else {
    for (const op of ops) {
      applyOp(op); // 重连增量：靠 seenStrokeIds 幂等
    }
  }

  updateSeqText();
  console.log(`[sync] ${msg.reset ? 'full' : 'incremental'} replay ${ops.length} op(s), lastSeq=${lastSeq}`);
}

function flushPending() {
  if (pending.size === 0) return;
  console.log(`[ws] flushing ${pending.size} locally queued stroke(s)`);
  // 复制一份发送；ack 到达后从 pending 移除；仍失败则保留到下次重连
  for (const stroke of Array.from(pending.values())) {
    sendMsg({ type: 'stroke', stroke });
  }
}

function scheduleReconnect() {
  if (!roomId) return; // 未加入房间不重连
  if (reconnectTimer) return;

  // 指数退避：500ms, 1s, 2s ... 上限 10s，加随机抖动防止群炸
  const base = Math.min(500 * Math.pow(2, reconnectAttempts), 10000);
  const delay = base + Math.random() * 300;
  reconnectAttempts += 1;

  console.log(`[ws] reconnect in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startHeartbeat() {
  stopTimers();
  // 应用层 ping（协议层由 ws 库/浏览器自动处理 ping/pong；这里双重保险并刷新服务端活跃时间）
  heartbeatTimer = setInterval(() => {
    sendMsg({ type: 'ping', ts: Date.now() });
  }, 20000);
}

function startWatchdog() {
  // 40s 收不到任何消息判定死连接，强制重连
  watchdogTimer = setInterval(() => {
    if (Date.now() - lastMessageAt > 40000) {
      console.warn('[ws] watchdog timeout, force reconnect');
      if (ws) {
        try { ws.close(); } catch (_) { /* noop */ }
      }
    }
  }, 10000);
}

function stopTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

// 浏览器网络状态
window.addEventListener('online', () => {
  console.log('[net] online');
  if (roomId && (!ws || ws.readyState !== WebSocket.OPEN)) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = Math.max(reconnectAttempts - 1, 0);
    connect();
  }
});

window.addEventListener('offline', () => {
  console.log('[net] offline');
  setStatus('offline');
});

// ------------------------------ 加入房间 ------------------------------
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const rid = roomInput.value.trim();
  if (!rid) return;

  roomId = rid;
  joinScreen.classList.add('hidden');
  app.classList.remove('hidden');
  roomLabel.textContent = rid;
  userLabel.textContent = `${nameInput.value.trim() || '匿名'} · ${userId}`;

  // 容器从 display:none 变为可见后立即校正尺寸
  requestAnimationFrame(() => {
    resizeCanvas();
    connect();
  });
});

// 回车提交之外，聚焦房间输入框
roomInput.focus();

// ------------------------------ 尺寸自适应 ------------------------------
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resizeCanvas()).observe(boardWrap);
}
window.addEventListener('resize', () => resizeCanvas());
// 设备旋转 / 折叠屏
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));
