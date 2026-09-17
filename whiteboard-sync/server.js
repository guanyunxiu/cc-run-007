'use strict';

/**
 * 直播白板低延迟同步 - 服务端
 * 技术栈：Node.js 原生 http（静态文件） + ws（WebSocket）
 *
 * 能力：
 *  1. 房间自动创建 / 多客户端加入（roomId -> Set<ws>）
 *  2. 每房间 OpLog，seq 从 1 开始单调递增
 *  3. 笔迹操作广播；发送者收到 ack（不阻塞，客户端已本地预提交）
 *  4. 新成员收到全量历史；重连成员按 lastSeq 增量补齐
 *  5. 心跳：服务端 ping，客户端 pong；超时/无 pong 清理连接
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HEARTBEAT_INTERVAL_MS = 15000; // 每 15s ping 一次
const CLIENT_TIMEOUT_MS = 45000;     // 45s 无任何消息判定死亡
const MAX_OPLOG = 10000;             // 每房间最多保留操作数（防止无限增长）

/**
 * rooms: Map<roomId, {
 *   clients: Set<client>,
 *   ops: Array<op>           // OpLog，按 seq 升序
 * }>
 *
 * client: { ws, userId, roomId, lastSeen, alive }
 */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: new Set(), ops: [] };
    rooms.set(roomId, room);
    console.log(`[room] created: ${roomId}`);
  }
  return room;
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function nowTs() {
  return Date.now();
}

function isValidStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return false;
  if (typeof stroke.strokeId !== 'string' || !stroke.strokeId) return false;
  if (typeof stroke.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(stroke.color)) return false;
  const width = Number(stroke.width);
  if (!Number.isFinite(width) || width <= 0 || width > 100) return false;
  if (!Array.isArray(stroke.points) || stroke.points.length === 0) return false;
  if (stroke.points.length > 20000) return false;
  for (const p of stroke.points) {
    if (!p || typeof p !== 'object') return false;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  }
  return true;
}

/**
 * 客户端加入/切换房间。
 * 首次加入：发送 joined + 全量 OpLog
 * 重连加入（带 lastSeq）：发送 joined + lastSeq 之后的增量操作
 */
function handleJoin(client, msg) {
  const roomId = String(msg.roomId || '').trim();
  if (!roomId || roomId.length > 64) {
    sendJSON(client.ws, { type: 'error', message: 'invalid roomId' });
    return;
  }

  // 同一连接切换房间：先离开旧房间
  leaveRoom(client);

  const userId = String(msg.userId || '').slice(0, 64) || 'anon';
  client.userId = userId;
  client.roomId = roomId;

  const room = getOrCreateRoom(roomId);
  room.clients.add(client);

  const lastSeq = Number.isFinite(msg.lastSeq) ? Math.floor(msg.lastSeq) : 0;
  const missed = lastSeq > 0 ? room.ops.filter((op) => op.seq > lastSeq) : room.ops.slice();

  sendJSON(client.ws, {
    type: 'joined',
    roomId,
    userId,
    lastSeq: room.ops.length ? room.ops[room.ops.length - 1].seq : 0
  });

  // 历史 / 缺失操作通过 sync 消息批量下发
  sendJSON(client.ws, {
    type: 'sync',
    reset: lastSeq === 0,
    ops: missed
  });

  console.log(
    `[join] room=${roomId} user=${userId} members=${room.clients.size} ` +
    `ops=${room.ops.length} replay=${missed.length}${lastSeq > 0 ? `(since ${lastSeq})` : '(full)'}`
  );
}

function leaveRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (room) {
    room.clients.delete(client);
    if (room.clients.size === 0) {
      // 房间为空时仍保留 OpLog，方便用户刷新/短暂掉线后恢复
      console.log(`[room] empty (oplog retained, ${room.ops.length} ops): ${client.roomId}`);
    }
  }
  client.roomId = null;
}

/**
 * 处理一笔完整笔迹：
 *  - 幂等：相同 (roomId, strokeId) 不重复入库、不重复广播
 *  - 分配服务端单调递增 seq
 */
function handleStroke(client, msg) {
  if (!client.roomId) {
    sendJSON(client.ws, { type: 'error', message: 'join a room first' });
    return;
  }
  const stroke = msg.stroke;
  if (!isValidStroke(stroke)) {
    sendJSON(client.ws, { type: 'error', message: 'invalid stroke', clientStrokeId: stroke && stroke.strokeId });
    return;
  }

  const room = rooms.get(client.roomId);
  const senderUserId = typeof stroke.userId === 'string' && stroke.userId ? stroke.userId : client.userId;

  // 幂等保护（同一笔可能因客户端重发到达两次）
  const existed = room.ops.find((op) => op.strokeId === stroke.strokeId);
  if (existed) {
    sendJSON(client.ws, {
      type: 'ack',
      strokeId: stroke.strokeId,
      seq: existed.seq
    });
    return;
  }

  const seq = room.ops.length === 0 ? 1 : room.ops[room.ops.length - 1].seq + 1;

  const op = {
    seq,
    roomId: client.roomId,
    userId: senderUserId,
    strokeId: stroke.strokeId,
    color: stroke.color,
    width: Number(stroke.width),
    points: stroke.points.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
    ts: nowTs()
  };

  room.ops.push(op);
  if (room.ops.length > MAX_OPLOG) {
    room.ops.splice(0, room.ops.length - MAX_OPLOG);
  }

  // 给发送者确认（本地已经预提交渲染，ack 只用于推进 lastSeq / 清理离线队列）
  sendJSON(client.ws, { type: 'ack', strokeId: op.strokeId, seq: op.seq });

  // 广播给同房间其他成员
  const broadcast = { type: 'op', op };
  for (const other of room.clients) {
    if (other !== client) {
      sendJSON(other.ws, broadcast);
    }
  }

  console.log(
    `[op] seq=${op.seq} room=${op.roomId} user=${op.userId} ` +
    `stroke=${op.strokeId} points=${op.points.length} broadcast=${room.clients.size - 1}`
  );
}

/* ----------------------------- HTTP 静态服务 ----------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 查询房间 OpLog（便于测试/观察 seq）
  if (url.pathname === '/api/room') {
    const roomId = url.searchParams.get('roomId');
    const room = rooms.get(roomId);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'room not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      roomId,
      members: room.clients.size,
      count: room.ops.length,
      ops: room.ops
    }));
    return;
  }

  if (url.pathname === '/api/rooms') {
    const summary = [];
    for (const [roomId, room] of rooms) {
      summary.push({
        roomId,
        members: room.clients.size,
        count: room.ops.length,
        lastSeq: room.ops.length ? room.ops[room.ops.length - 1].seq : 0
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // 只允许访问 public 目录内的文件
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ------------------------------- WebSocket ------------------------------- */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = {
    id: crypto.randomBytes(6).toString('hex'),
    ws,
    userId: null,
    roomId: null,
    lastSeen: nowTs(),
    alive: true
  };

  ws.on('pong', () => {
    client.lastSeen = nowTs();
    client.alive = true;
  });

  ws.on('message', (raw) => {
    client.lastSeen = nowTs();
    client.alive = true;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      sendJSON(ws, { type: 'error', message: 'invalid json' });
      return;
    }

    switch (msg.type) {
      case 'join':
        handleJoin(client, msg);
        break;
      case 'stroke':
        handleStroke(client, msg);
        break;
      case 'ping':
        // 应用层心跳（协议层 ping 之外的兜底，任意消息都会刷新 lastSeen）
        sendJSON(ws, { type: 'pong', ts: nowTs() });
        break;
      default:
        sendJSON(ws, { type: 'error', message: `unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
    console.log(`[disconnect] user=${client.userId || '-'} room=${client.roomId || '-'}`);
  });

  ws.on('error', (err) => {
    console.error('[ws error]', err.message);
    try { ws.terminate(); } catch (_) { /* noop */ }
    leaveRoom(client);
  });
});

// 心跳 + 死亡连接清理
const heartbeatTimer = setInterval(() => {
  const now = nowTs();
  for (const ws of wss.clients) {
    // client 对象挂载在 connection 闭包中，通过 readyState + ping 统一处理
    if (ws.readyState !== ws.OPEN) {
      try { ws.terminate(); } catch (_) { /* noop */ }
      continue;
    }
    try {
      ws.ping();
    } catch (_) {
      try { ws.terminate(); } catch (_) { /* noop */ }
    }
  }
  // 超时未活跃的连接（pong/消息均会刷新 lastSeen）
  for (const [roomId, room] of rooms) {
    for (const client of room.clients) {
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) {
        console.warn(`[timeout] terminating user=${client.userId} room=${roomId}`);
        try { client.ws.terminate(); } catch (_) { /* noop */ }
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  Whiteboard sync server started');
  console.log(`  HTTP : http://localhost:${PORT}/`);
  console.log(`  WS   : ws://<host>:${PORT}/ws?roomId=<id>`);
  console.log(`  OpLog: GET http://localhost:${PORT}/api/room?roomId=<id>`);
  console.log('==============================================');
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
