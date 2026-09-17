'use strict';

/**
 * 端到端自动化测试（零第三方测试框架，直接用 ws 客户端连真实服务端）
 *
 * 覆盖：
 *  1. 静态资源服务
 *  2. 房间加入 / presence
 *  3. 笔迹广播：A 发 → B 收；发送者只收 ack，不收自己的 stroke（无重影）
 *  4. seq 从 1 开始、房间内单调递增连续
 *  5. OpLog 全量重放（刷新恢复）
 *  6. lastSeq 增量同步（断线重连补缺）
 *  7. 同一 strokeId 重发：幂等，不重复落库 / 不重复广播
 *  8. 多人同时书写：每人 seq 连续、内容一致、互不重复
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || 8791;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

async function section(name, fn) {
  console.log(`\n▶ ${name}`);
  await fn();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 测试用 ws 客户端 ----------
function makeClient() {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters[0];
    if (w && w.pred(msg)) {
      waiters.shift();
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });

  const client = {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    open: () => new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    close: () =>
      new Promise((res) => {
        if (ws.readyState === WebSocket.CLOSED) return res();
        ws.once('close', res);
        ws.close();
      }),
    /** 等待下一条满足条件的消息（含历史收件箱） */
    waitFor: (pred, timeout = 3000) =>
      new Promise((resolve, reject) => {
        const idx = inbox.findIndex(pred);
        if (idx >= 0) return resolve(inbox.splice(idx, 1)[0]);
        const timer = setTimeout(() => {
          waiters.splice(waiters.findIndex((x) => x.timer === timer), 1);
          reject(new Error('waitFor 超时'));
        }, timeout);
        waiters.push({ pred, resolve, reject, timer });
      }),
    inbox,
  };
  return client;
}

function joinRoom(client, roomId, userId, lastSeq) {
  const p = client.waitFor((m) => m.type === 'joined');
  client.send({ type: 'join', roomId, userId, lastSeq });
  return p;
}

function stroke(strokeId, points, extra = {}) {
  return {
    type: 'stroke',
    strokeId,
    color: extra.color || '#1f2937',
    size: extra.size || 3,
    points,
  };
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE_URL}${urlPath}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

// ---------- 启动服务端 ----------
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    child.stdout.on('data', (d) => {
      if (d.toString().includes('服务已启动') && !started) {
        started = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (code) => {
      if (!started) reject(new Error(`服务端启动失败 code=${code}`));
    });
  });
}

// ---------- 主流程 ----------
async function main() {
  console.log('启动真实服务端…');
  const serverProc = await startServer();
  await sleep(100);

  try {
    // 1. 静态资源
    await section('静态资源服务', async () => {
      const index = await httpGet('/');
      assert(index.status === 200, 'GET / 返回 200');
      assert(index.body.includes('直播白板'), 'index.html 内容正确');
      const app = await httpGet('/app.js');
      assert(app.status === 200 && app.body.includes('quadraticCurveTo'), 'app.js 已提供且含贝塞尔平滑代码');
      const css = await httpGet('/style.css');
      assert(css.status === 200, 'style.css 已提供');
    });

    // 2. 房间 / presence / 广播 / ack
    await section('房间、广播与 ack', async () => {
      const A = makeClient();
      const B = makeClient();
      await A.open();
      await B.open();

      const ja = await joinRoom(A, 'room-101', 'userA');
      assert(ja.roomId === 'room-101', 'A 加入成功，收到 joined');
      assert(ja.peers === 1, '房间第 1 人 peers=1');
      assert(Array.isArray(ja.ops) && ja.ops.length === 0, '空房间无历史操作');

      const jb = await joinRoom(B, 'room-101', 'userB');
      assert(jb.peers === 2, 'B 加入后 peers=2');

      const presA = await A.waitFor((m) => m.type === 'presence' && m.peers === 2);
      assert(!!presA, 'A 收到 presence 更新 peers=2');

      // A 画一笔
      A.send(stroke('s-a1', [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], { color: '#ef4444', size: 4 }));
      const ackA = await A.waitFor((m) => m.type === 'ack' && m.strokeId === 's-a1');
      assert(ackA.seq === 1, 'A 收到 ack，seq=1');

      const gotB = await B.waitFor((m) => m.type === 'stroke' && m.op.strokeId === 's-a1');
      assert(gotB.op.seq === 1, 'B 收到 A 的笔迹 seq=1');
      assert(gotB.op.userId === 'userA', '广播携带 userId');
      assert(gotB.op.color === '#ef4444' && gotB.op.size === 4, '广播携带颜色与线宽');
      assert(gotB.op.points.length === 3 && typeof gotB.op.ts === 'number', '广播携带点集与时间戳');
      assert(!A.inbox.some((m) => m.type === 'stroke'), 'A 没收到自己笔迹的广播（无重影）');

      // B 画一笔
      B.send(stroke('s-b1', [{ x: 10, y: 10 }, { x: 20, y: 20 }], { color: '#3b82f6' }));
      const ackB = await B.waitFor((m) => m.type === 'ack' && m.strokeId === 's-b1');
      assert(ackB.seq === 2, 'B 收到 ack，seq=2');
      const gotA = await A.waitFor((m) => m.type === 'stroke' && m.op.strokeId === 's-b1');
      assert(gotA.op.seq === 2, 'A 收到 B 的笔迹 seq=2');

      // A 再画一笔，确认 seq 连续递增
      A.send(stroke('s-a2', [{ x: 5, y: 5 }]));
      const ackA2 = await A.waitFor((m) => m.type === 'ack' && m.strokeId === 's-a2');
      assert(ackA2.seq === 3, 'seq 在房间内连续递增到 3');

      await A.close();
      await B.close();
    });

    // 3. OpLog 全量重放（刷新恢复）
    await section('OpLog 全量重放（模拟刷新）', async () => {
      const C = makeClient();
      await C.open();
      const jc = await joinRoom(C, 'room-101', 'userC'); // 房间仍在，oplog 保留
      assert(jc.ops.length === 3, '新连接拿到房间全部 3 条历史');
      assert(jc.ops.map((o) => o.seq).join(',') === '1,2,3', '历史 seq 为 1,2,3 顺序不乱');
      assert(
        jc.ops.map((o) => o.strokeId).join(',') === 's-a1,s-b1,s-a2',
        '历史笔迹顺序与写入一致'
      );
      assert(jc.lastSeq === 3, 'joined 返回 lastSeq=3');
      await C.close();
    });

    // 4. 增量同步（断线重连补缺）
    await section('lastSeq 增量同步（断线重连）', async () => {
      // D 以 lastSeq=2 重连
      const D = makeClient();
      await D.open();
      const jd = await joinRoom(D, 'room-101', 'userD', 2);
      assert(jd.ops.length === 1, 'lastSeq=2 只回 1 条缺失操作');
      assert(jd.ops[0].strokeId === 's-a2' && jd.ops[0].seq === 3, '缺失操作正是 seq=3');
      assert(jd.lastSeq === 3, '增量同步后水位 lastSeq=3');

      // sync 消息路径也验证一遍
      D.send({ type: 'sync', roomId: 'room-101', lastSeq: 1 });
      const sync = await D.waitFor((m) => m.type === 'sync');
      assert(sync.ops.length === 2 && sync.ops[0].seq === 2 && sync.ops[1].seq === 3, 'sync 拉取 seq>1 的 2 条操作');
      await D.close();
    });

    // 5. 幂等重发（断线期间重发同一笔）
    await section('strokeId 幂等去重', async () => {
      const E = makeClient();
      const F = makeClient();
      await E.open();
      await F.open();
      await joinRoom(E, 'room-dup', 'userE');
      await joinRoom(F, 'room-dup', 'userF');
      await F.waitFor((m) => m.type === 'presence');

      const pts = [{ x: 1, y: 1 }, { x: 9, y: 9 }];
      E.send(stroke('s-dup', pts));
      const ack1 = await E.waitFor((m) => m.type === 'ack' && m.strokeId === 's-dup');
      const f1 = await F.waitFor((m) => m.type === 'stroke' && m.op.strokeId === 's-dup');
      assert(ack1.seq === 1 && f1.op.seq === 1, '首笔正常落库 seq=1');

      // 模拟重连后重发：同一 strokeId 再发一次
      E.send(stroke('s-dup', pts));
      const ack2 = await E.waitFor(
        (m) => m.type === 'ack' && m.strokeId === 's-dup' && m.duplicate === true
      );
      assert(!!ack2, '重复笔迹收到 duplicate ack');
      assert(ack2.seq === 1, 'duplicate ack 仍返回原 seq=1');

      await sleep(200);
      const dupBroadcasts = F.inbox.filter((m) => m.type === 'stroke' && m.op.strokeId === 's-dup');
      assert(dupBroadcasts.length === 0, '重复笔迹没有二次广播（对端不重影）');
      await E.close();
      await F.close();

      // 新成员查看 room-dup 历史只有 1 条
      const G = makeClient();
      await G.open();
      const jg = await joinRoom(G, 'room-dup', 'userG');
      assert(jg.ops.length === 1 && jg.ops[0].strokeId === 's-dup', 'OpLog 中重复笔迹只存 1 条');
      await G.close();
    });

    // 6. 多人同时书写
    await section('多人同时书写：seq 连续、内容完整', async () => {
      const room = 'room-multi';
      const clients = [];
      for (let i = 0; i < 3; i++) {
        const c = makeClient();
        await c.open();
        await joinRoom(c, room, `u${i}`);
        clients.push(c);
      }
      await sleep(100); // 等 presence 噪音落袋
      for (const c of clients) c.inbox.length = 0;

      // 每人 3 笔，几乎同时发出
      const N = 3;
      for (let round = 0; round < N; round++) {
        for (let i = 0; i < clients.length; i++) {
          clients[i].send(stroke(`s-u${i}-r${round}`, [{ x: i, y: round }]));
        }
      }
      // 等所有人收齐 9 条广播 + 3 条 ack
      await sleep(500);

      for (let i = 0; i < clients.length; i++) {
        const acks = clients[i].inbox.filter((m) => m.type === 'ack').length;
        // 自己 3 笔全收到 ack
        assert(acks === N, `客户端 u${i} 收到自己 ${N} 条 ack（实际 ${acks}）`);
        const others = clients[i].inbox.filter((m) => m.type === 'stroke');
        assert(others.length === N * 2, `客户端 u${i} 收到其他人 ${N * 2} 条笔迹（实际 ${others.length}）`);
        // 没有任何自己的笔迹被广播回来
        assert(
          !others.some((m) => m.op.strokeId.startsWith(`s-u${i}-`)),
          `客户端 u${i} 未收到自己笔迹的回环广播`
        );
      }

      // 最终一致性：新成员看到 9 条 op，seq 恰好 1..9
      const H = makeClient();
      await H.open();
      const jh = await joinRoom(H, room, 'latecomer');
      assert(jh.ops.length === 9, `并发后 OpLog 共 9 条（实际 ${jh.ops.length}）`);
      const seqs = jh.ops.map((o) => o.seq);
      assert(seqs.join(',') === Array.from({ length: 9 }, (_, i) => i + 1).join(','), 'seq 严格 1..9 无重复无乱序');
      const ids = new Set(jh.ops.map((o) => o.strokeId));
      assert(ids.size === 9, '9 条笔迹 strokeId 互不重复');
      await H.close();
      for (const c of clients) await c.close();
    });

    // 7. 空笔迹 / 非法消息不崩溃
    await section('健壮性', async () => {
      const I = makeClient();
      await I.open();
      await joinRoom(I, 'room-edge', 'userI');
      I.ws.send('不是 JSON');
      I.send({ type: 'stroke', strokeId: '', points: [] });
      I.send(stroke('s-ok', [{ x: 1, y: 1 }]));
      const ack = await I.waitFor((m) => m.type === 'ack' && m.strokeId === 's-ok');
      assert(ack.seq === 1, '非法消息被忽略，合法笔迹正常 seq=1');
      await I.close();
    });
  } finally {
    serverProc.kill();
  }

  console.log(`\n========================================`);
  console.log(`结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) {
    console.error('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
