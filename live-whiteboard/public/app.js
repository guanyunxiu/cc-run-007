'use strict';

/**
 * 直播白板低延迟同步 —— 前端
 *
 * 关键设计：
 *  1. 双缓冲 Canvas：offscreen(历史) + main(当前笔迹)，每帧 drawImage 历史再画当前笔迹
 *  2. quadraticCurveTo 三点中点插值平滑，不画折线
 *  3. 本地预提交：pointerdown 即刻渲染，pointerup 才发送整笔；自己的笔迹靠 strokeId 去重不重绘
 *  4. WebSocket 指数退避重连；joined 时按 lastSeq 增量重放 OpLog
 *  5. 发送可靠性：笔迹停留在 pending 队列直到收到 ack；断线重连重发，服务端按 strokeId 幂等去重
 */

// ---------------- 工具 / 身份 ----------------
const $ = (id) => document.getElementById(id);

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getUserId() {
  let id = localStorage.getItem('wb_userId');
  if (!id) {
    id = uid('u');
    localStorage.setItem('wb_userId', id);
  }
  return id;
}

// ---------------- DOM ----------------
const joinView = $('joinView');
const boardView = $('boardView');
const roomInput = $('roomInput');
const nameInput = $('nameInput');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const canvas = $('board');
const ctx = canvas.getContext('2d');
const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');

const statusPill = $('statusPill');
const statusText = $('statusText');
const roomTag = $('roomTag');
const peerTag = $('peerTag');
const userIdTag = $('userIdTag');
const seqTag = $('seqTag');
const pendingTag = $('pendingTag');
const sizeRange = $('sizeRange');
const sizeValue = $('sizeValue');
const colorPalette = $('colorPalette');

// ---------------- 白板状态 ----------------
const state = {
  userId: getUserId(),
  userName: '',
  roomId: '',
  color: '#1f2937',
  size: 3,

  // 双缓冲
  cssWidth: 0,
  cssHeight: 0,
  dpr: 1,

  // 当前正在书写的笔迹（仅主 canvas 绘制）
  drawing: false,
  pointerId: null,
  currentStroke: null,

  // 同步
  lastSeq: 0,
  appliedStrokeIds: new Set(), // 所有已合并到离屏 canvas 的 strokeId（含自己的预提交）
};

// ---------------- 双缓冲 Canvas 适配 ----------------
function resizeBoard() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  // 旧内容快照（resize / DPR 变化时保留历史）
  const oldW = offscreen.width;
  const oldH = offscreen.height;
  let snapshot = null;
  if (oldW > 0 && oldH > 0) {
    snapshot = document.createElement('canvas');
    snapshot.width = oldW;
    snapshot.height = oldH;
    snapshot.getContext('2d').drawImage(offscreen, 0, 0);
  }

  for (const c of [canvas, offscreen]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }

  const t = (c) => {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
  };
  t(ctx);
  t(offCtx);

  state.cssWidth = w;
  state.cssHeight = h;
  state.dpr = dpr;

  if (snapshot) {
    // 旧快照是旧 DPR 下的物理像素，按 CSS 坐标等比重绘
    offCtx.drawImage(snapshot, 0, 0, oldW / state.dpr, oldH / state.dpr);
  }
  scheduleRender();
}

// ---------------- 渲染调度（rAF 合帧，低延迟不卡顿） ----------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  ctx.clearRect(0, 0, state.cssWidth, state.cssHeight);
  // 1) 离屏历史
  ctx.drawImage(offscreen, 0, 0, state.cssWidth, state.cssHeight);
  // 2) 当前正在书写的笔迹（只画在主 canvas 上）
  if (state.drawing && state.currentStroke) {
    paintStroke(ctx, state.currentStroke);
  }
}

/**
 * 贝塞尔平滑笔迹：
 * 相邻点中点作为二次贝塞尔曲线终点，中间点作为控制点。
 * 不使用 lineTo 连折线。
 */
function paintStroke(c, stroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;

  c.strokeStyle = stroke.color;
  c.fillStyle = stroke.color;
  c.lineWidth = stroke.size;

  // 单点（轻点）：画圆点
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }

  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);

  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    // 控制点 = 中间点 pts[i]，终点 = pts[i] 与 pts[i+1] 的中点
    c.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  // 收尾到最后一个点
  const last = pts[pts.length - 1];
  c.lineTo(last.x, last.y);
  c.stroke();
}

/** 笔迹完成（本地/远端通用）：合并进离屏历史 canvas */
function mergeToHistory(stroke) {
  paintStroke(offCtx, stroke);
}

// ---------------- 指针绘制（鼠标 / 触控笔 / 触摸屏） ----------------
function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: +(e.clientX - rect.left).toFixed(2),
    y: +(e.clientY - rect.top).toFixed(2),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!net.joined) return;
  // 只跟踪第一根指针，避免多指干扰
  if (state.drawing) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  state.drawing = true;
  state.pointerId = e.pointerId;
  state.currentStroke = {
    strokeId: uid('s'),
    userId: state.userId,
    color: state.color,
    size: state.size,
    points: [pointFromEvent(e)],
  };
  // 本地预提交：落笔即渲染，不等待服务端
  scheduleRender();
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing || e.pointerId !== state.pointerId) return;
  e.preventDefault();

  const p = pointFromEvent(e);
  const pts = state.currentStroke.points;
  const last = pts[pts.length - 1];
  // 过滤微小抖动点（>=1px 才记录），平滑同时减少数据量
  if (Math.abs(p.x - last.x) < 1 && Math.abs(p.y - last.y) < 1) return;
  pts.push(p);
  scheduleRender(); // 实时跟手
});

function finishStroke(e) {
  if (!state.drawing || e.pointerId !== state.pointerId) return;
  e.preventDefault();

  const stroke = state.currentStroke;
  state.drawing = false;
  state.pointerId = null;
  state.currentStroke = null;

  // 1) 合并到离屏历史
  state.appliedStrokeIds.add(stroke.strokeId); // 自己的笔迹先标记，服务端回发/重放时不重复绘制
  mergeToHistory(stroke);
  // 2) 整笔发送（预提交已完成，不阻塞渲染）
  enqueueStroke(stroke);
  scheduleRender();
}

canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('resize', resizeBoard);

// ---------------- 网络层 ----------------
const net = {
  ws: null,
  connected: false, // TCP 层已连接
  joined: false, // 已完成房间握手
  manuallyClosed: false,
  attempt: 0, // 重连次数（指数退避）
  reconnectTimer: null,
  pingTimer: null,

  // 可靠发送队列：收到 ack 才移除；断线期间继续保留，重连后重发（服务端幂等）
  pending: [],
  inFlight: new Set(),
};

function setStatus(kind, text) {
  statusPill.className = `status-pill ${kind}`;
  statusText.textContent = text;
}

function connect() {
  clearTimeout(net.reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  net.ws = ws;

  if (!navigator.onLine) {
    setStatus('offline', '离线（网络不可用）');
  } else if (net.attempt === 0 && !net.connected) {
    setStatus('connecting', '连接中…');
  } else {
    setStatus('reconnecting', `重连中…（第 ${net.attempt + 1} 次）`);
  }

  ws.addEventListener('open', () => {
    net.connected = true;
    net.attempt = 0;
    // 握手加入房间，带上 lastSeq 让服务端只回增量
    ws.send(
      JSON.stringify({
        type: 'join',
        roomId: state.roomId,
        userId: state.userId,
        userName: state.userName,
        lastSeq: state.lastSeq,
      })
    );
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    net.connected = false;
    net.joined = false;
    net.inFlight.clear(); // 可能未送达，重连后允许重发
    clearInterval(net.pingTimer);
    if (net.manuallyClosed) return;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close 事件会紧随其后，统一在 close 里重连
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (net.manuallyClosed) return;
  if (!navigator.onLine) {
    setStatus('offline', '离线（网络不可用）');
  } else {
    setStatus('reconnecting', `重连中…（第 ${net.attempt + 1} 次）`);
  }
  // 指数退避：500ms 起，翻倍，上限 10s，加 ±20% 抖动
  const base = Math.min(500 * 2 ** net.attempt, 10_000);
  const delay = Math.round(base * (0.8 + Math.random() * 0.4));
  net.attempt += 1;
  clearTimeout(net.reconnectTimer);
  net.reconnectTimer = setTimeout(() => {
    if (navigator.onLine) connect();
    else scheduleReconnect();
  }, delay);
}

window.addEventListener('offline', () => {
  if (!net.manuallyClosed) setStatus('offline', '离线（网络不可用）');
});
window.addEventListener('online', () => {
  if (!net.manuallyClosed && !net.connected) {
    net.attempt = 0;
    connect();
  }
});

// ---------------- 消息处理 ----------------
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      net.joined = true;
      setStatus('connected', '已连接');
      setPeers(msg.peers);
      // 重放缺失 OpLog（刷新后为全量；重连后为 lastSeq 之后的增量）
      for (const op of msg.ops) applyRemoteOp(op, true);
      seqTag.textContent = state.lastSeq;
      flushPending();
      break;
    }
    case 'stroke': {
      applyRemoteOp(msg.op, false);
      break;
    }
    case 'ack': {
      // 服务端确认：移除待发队列。重复提交也会收到 ack（duplicate=true）
      net.pending = net.pending.filter((s) => s.strokeId !== msg.strokeId);
      net.inFlight.delete(msg.strokeId);
      updatePendingUI();
      if (typeof msg.seq === 'number') {
        // 自己的笔迹已经预提交，只更新水位，不重绘
        state.lastSeq = Math.max(state.lastSeq, msg.seq);
        seqTag.textContent = state.lastSeq;
      }
      break;
    }
    case 'sync': {
      for (const op of msg.ops) applyRemoteOp(op, true);
      seqTag.textContent = state.lastSeq;
      break;
    }
    case 'presence': {
      setPeers(msg.peers);
      break;
    }
    case 'error': {
      console.warn('[server error]', msg.message);
      break;
    }
    default:
      break;
  }
}

/** 应用一条远端操作：按 strokeId 幂等去重，合并进离屏历史 */
function applyRemoteOp(op, fromReplay) {
  if (!op || !op.strokeId) return;

  if (typeof op.seq === 'number') {
    state.lastSeq = Math.max(state.lastSeq, op.seq);
  }

  // 自己预提交过 / 之前已经应用过 → 只更新 seq 水位，绝不重复渲染
  if (state.appliedStrokeIds.has(op.strokeId)) return;
  state.appliedStrokeIds.add(op.strokeId);

  const stroke = {
    strokeId: op.strokeId,
    userId: op.userId,
    color: op.color,
    size: op.size,
    points: op.points,
  };
  mergeToHistory(stroke); // 远端笔迹直接进历史层
  if (!fromReplay || state.drawing) scheduleRender();
}

// ---------------- 待发队列 / 可靠发送 ----------------
function enqueueStroke(stroke) {
  net.pending.push(stroke);
  updatePendingUI();
  flushPending();
}

function flushPending() {
  if (!net.connected || !net.joined) return;
  for (const stroke of net.pending) {
    if (net.inFlight.has(stroke.strokeId)) continue;
    net.ws.send(
      JSON.stringify({
        type: 'stroke',
        strokeId: stroke.strokeId,
        color: stroke.color,
        size: stroke.size,
        points: stroke.points,
      })
    );
    net.inFlight.add(stroke.strokeId);
  }
  updatePendingUI();
}

function updatePendingUI() {
  pendingTag.textContent = `待发送：${net.pending.length}`;
  pendingTag.classList.toggle('pending', net.pending.length > 0);
}

function setPeers(n) {
  peerTag.textContent = `👤 ${n}`;
}

// ---------------- 加入 / 离开房间 ----------------
function resetBoardState() {
  state.lastSeq = 0;
  state.appliedStrokeIds.clear();
  state.drawing = false;
  state.currentStroke = null;
  net.pending = [];
  net.inFlight.clear();
  net.attempt = 0;
  offCtx.clearRect(0, 0, state.cssWidth, state.cssHeight);
  ctx.clearRect(0, 0, state.cssWidth, state.cssHeight);
  seqTag.textContent = '0';
  updatePendingUI();
}

function joinRoom() {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    roomInput.focus();
    return;
  }
  state.roomId = roomId;
  state.userName = nameInput.value.trim();
  net.manuallyClosed = false;

  joinView.classList.add('hidden');
  boardView.classList.remove('hidden');

  roomTag.textContent = `# ${roomId}`;
  userIdTag.textContent = `用户：${state.userName || state.userId}`;

  // 等布局完成后再按真实尺寸建缓冲
  requestAnimationFrame(() => {
    resizeBoard();
    resetBoardState();
    connect();
  });
}

function leaveRoom() {
  net.manuallyClosed = true;
  clearTimeout(net.reconnectTimer);
  clearInterval(net.pingTimer);
  if (net.ws) {
    try {
      net.ws.close();
    } catch {
      /* ignore */
    }
  }
  net.connected = false;
  net.joined = false;
  boardView.classList.add('hidden');
  joinView.classList.remove('hidden');
  setStatus('connecting', '连接中…');
}

joinBtn.addEventListener('click', joinRoom);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
leaveBtn.addEventListener('click', leaveRoom);

// ---------------- 工具栏 ----------------
colorPalette.addEventListener('click', (e) => {
  const btn = e.target.closest('.color');
  if (!btn) return;
  state.color = btn.dataset.color;
  colorPalette.querySelectorAll('.color').forEach((b) => b.classList.toggle('active', b === btn));
});

sizeRange.addEventListener('input', () => {
  state.size = parseFloat(sizeRange.value);
  sizeValue.textContent = state.size;
});

// 初始化
sizeValue.textContent = sizeRange.value;
roomInput.value = localStorage.getItem('wb_lastRoom') || '';
roomInput.focus();
