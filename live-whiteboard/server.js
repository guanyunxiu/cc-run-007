'use strict';

/**
 * 直播白板低延迟同步 —— 服务端
 *
 * 技术栈：Node.js 内置 http(静态资源) + ws(WebSocket 长连接)
 *
 * 设计要点：
 *  - 全双工长连接 + 心跳(ping/pong) + 断线检测清理
 *  - roomId -> Room { clients, oplog }，房间不存在自动创建
 *  - 每个房间独立 OpLog，seq 从 1 开始单调递增、连续不乱序
 *  - 笔迹广播给“其他”成员，发送者只收 ack（本地已预提交，不重复渲染）
 *  - 新成员 / 重连成员凭 lastSeq 拉取增量；服务端对 strokeId 去重（at-least-once 安全）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 常量 ----------
const HEARTBEAT_INTERVAL_MS = 30_000; // 定时 ping
const CLIENT_TIMEOUT_MS = 65_000;     // 超过该时间没任何回应判定为死连接

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 房间 / OpLog ----------
/**
 * Room {
 *   id: string,
 *   clients: Set<ClientMeta>,  // ClientMeta 即 ws 上的扩展字段对象
 *   oplog: Op[],
 * }
 * Op { seq, roomId, userId, strokeId, color, size, points:[{x,y}], ts }
 */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, clients: new Set(), oplog: [] };
    rooms.set(roomId, room);
    console.log(`[room] 创建房间: ${roomId}`);
  }
  return room;
}

function nextSeq(room) {
  // 从 1 开始单调递增；房间内串行写入，天然无竞争
  const seq = room.oplog.length + 1;
  return seq;
}

function logOp(room, op) {
  console.log(
    `[op] room=${room.id} seq=${op.seq} user=${op.userId} stroke=${op.strokeId} ` +
      `points=${op.points.length} color=${op.color} size=${op.size} ts=${op.ts}`
  );
}

// ---------- 静态资源服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // 防目录穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = { userId: null, roomId: null };
  ws.lastSeen = Date.now();

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastSeen = Date.now();
  });

  ws.on('message', (raw) => {
    ws.lastSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 非法 JSON 直接忽略
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------- 消息处理 ----------
function handleMessage(ws, msg) {
  switch (msg && msg.type) {
    case 'join':
      onJoin(ws, msg);
      break;
    case 'stroke':
      onStroke(ws, msg);
      break;
    case 'sync':
      onSync(ws, msg);
      break;
    case 'ping': // 客户端也可以主动 ping（app 层心跳）
      send(ws, { type: 'pong', ts: Date.now() });
      break;
    default:
      break;
  }
}

function onJoin(ws, msg) {
  const roomId = sanitizeId(msg.roomId);
  const userId = sanitizeId(msg.userId) || `u_${Math.random().toString(36).slice(2, 8)}`;
  if (!roomId) {
    send(ws, { type: 'error', message: 'roomId 不能为空' });
    return;
  }

  // 重复加入：先离开旧房间
  leaveRoom(ws);

  const room = getOrCreateRoom(roomId);
  ws.meta = { userId, roomId };
  room.clients.add(ws);

  // 增量同步：lastSeq 之后的操作；不传 / 0 则给全量（用于刷新恢复）
  const lastSeq = Number.isFinite(msg.lastSeq) ? Math.max(0, Math.floor(msg.lastSeq)) : 0;
  const since = room.oplog.filter((op) => op.seq > lastSeq);

  send(ws, {
    type: 'joined',
    roomId,
    userId,
    lastSeq: room.oplog.length ? room.oplog[room.oplog.length - 1].seq : 0,
    peers: room.clients.size,
    ops: since,
  });

  // 通知房间内其他人在线人数变化
  broadcastPresence(room);

  console.log(
    `[join] user=${userId} room=${roomId} peers=${room.clients.size} ` +
      `回放 ops=${since.length}(lastSeq=${lastSeq})`
  );
}

function onStroke(ws, msg) {
  const { userId, roomId } = ws.meta;
  if (!roomId) {
    send(ws, { type: 'error', message: '尚未加入房间' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) return;

  const strokeId = sanitizeId(msg.strokeId);
  const color = typeof msg.color === 'string' ? msg.color.slice(0, 32) : '#1f2937';
  const size = Number.isFinite(msg.size) ? Math.min(50, Math.max(0.5, msg.size)) : 3;
  const points = Array.isArray(msg.points) ? msg.points.filter(isValidPoint).slice(0, 5000) : [];

  if (!strokeId || points.length === 0) return; // 丢弃非法笔迹

  // 幂等：断线重连重发同一 strokeId 不重复落库、不重复广播
  const existed = room.oplog.find((op) => op.strokeId === strokeId);
  if (existed) {
    send(ws, { type: 'ack', strokeId, seq: existed.seq, duplicate: true });
    return;
  }

  const op = {
    seq: nextSeq(room),
    roomId,
    userId: userId || 'anonymous',
    strokeId,
    color,
    size,
    points,
    ts: Date.now(),
  };
  room.oplog.push(op);
  logOp(room, op);

  // 发送者：只回 ack，不回 stroke（本地已预提交，防止重影）
  send(ws, { type: 'ack', strokeId, seq: op.seq });

  // 其他成员：广播完整操作
  for (const client of room.clients) {
    if (client !== ws) send(client, { type: 'stroke', op });
  }
}

function onSync(ws, msg) {
  const { roomId } = ws.meta;
  if (!roomId) {
    send(ws, { type: 'error', message: '尚未加入房间' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) return;

  const lastSeq = Number.isFinite(msg.lastSeq) ? Math.max(0, Math.floor(msg.lastSeq)) : 0;
  const ops = room.oplog.filter((op) => op.seq > lastSeq);
  send(ws, {
    type: 'sync',
    roomId,
    lastSeq: room.oplog.length ? room.oplog[room.oplog.length - 1].seq : 0,
    ops,
  });
}

function leaveRoom(ws) {
  const { roomId } = ws.meta || {};
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      // 房间无人时仍保留 OpLog（刷新/短暂掉线恢复用），不销毁
      console.log(`[leave] room=${roomId} 暂无成员（保留 oplog ${room.oplog.length} 条）`);
    }
    broadcastPresence(room);
  }
  ws.meta = { userId: null, roomId: null };
}

function broadcastPresence(room) {
  for (const client of room.clients) {
    send(client, { type: 'presence', roomId: room.id, peers: room.clients.size });
  }
}

function sanitizeId(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, 64);
}

function isValidPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

// ---------- 心跳：定时 ping + 死连接清理 ----------
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (!ws.isAlive || now - (ws.lastSeen || 0) > CLIENT_TIMEOUT_MS) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    ws.isAlive = false; // 等待 pong 翻回 true
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  直播白板低延迟同步服务已启动');
  console.log(`  本机访问:   http://localhost:${PORT}/`);
  console.log(`  局域网访问: http://<本机IP>:${PORT}/`);
  console.log('  WebSocket:  /ws');
  console.log('==============================================');
});

module.exports = { server, rooms };
