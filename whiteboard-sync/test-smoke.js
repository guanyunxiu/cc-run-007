'use strict';
/* 冒烟测试：node test-smoke.js（需先启动服务端，或本脚本自动拉起） */
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}

function connect() {
  return new WebSocket(URL);
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function once(ws, type, predicate = null, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), timeout);
    ws.on('message', function on(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === type && (!predicate || predicate(msg))) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(msg);
      }
    });
  });
}

function collect(ws, type, count, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const got = [];
    const t = setTimeout(() => reject(new Error(`timeout collecting ${type}, got ${got.length}/${count}`)), timeout);
    ws.on('message', function on(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === type) {
        got.push(msg);
        if (got.length >= count) {
          clearTimeout(t);
          ws.off('message', on);
          resolve(got);
        }
      }
    });
  });
}

function stroke(strokeId, color = '#1f2937', width = 4) {
  return {
    strokeId, userId: 'tester', color, width,
    points: [{ x: 1, y: 1 }, { x: 5, y: 4 }, { x: 10, y: 2 }, { x: 20, y: 9 }]
  };
}

async function joined(ws, roomId, lastSeq = 0, userId) {
  const j = once(ws, 'joined');
  const s = once(ws, 'sync');
  send(ws, { type: 'join', roomId, userId, lastSeq });
  return { joined: await j, sync: await s };
}

async function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const room = 'smoke-' + Date.now();

  // ---------- 1. A、B 加入 ----------
  console.log('\n[1] A/B join same room');
  const a = connect();
  const b = connect();
  await new Promise((r) => { let n = 0; [a, b].forEach((ws) => ws.on('open', () => ++n === 2 && r())); });

  const ja = await joined(a, room, 0, 'A');
  const jb = await joined(b, room, 0, 'B');
  assert(ja.sync.reset === true && Array.isArray(ja.sync.ops) && ja.sync.ops.length === 0, 'A first join: reset full sync, empty oplog');
  assert(jb.sync.ops.length === 0, 'B join: empty oplog');

  // ---------- 2. A 发一笔：A 收 ack(seq=1)，B 收 op(seq=1) ----------
  console.log('\n[2] A sends stroke');
  const pAck1 = once(a, 'ack', (m) => m.strokeId === 's1');
  const pOp1 = once(b, 'op', (m) => m.op.strokeId === 's1');
  send(a, { type: 'stroke', stroke: stroke('s1', '#ef4444', 6) });
  const ack1 = await pAck1;
  const op1 = (await pOp1).op;
  assert(ack1.seq === 1, 'A gets ack seq=1');
  assert(op1.seq === 1 && op1.roomId === room && op1.userId === 'tester', 'B gets broadcast op seq=1 with room metadata and stroke userId');
  assert(op1.color === '#ef4444' && op1.width === 6 && op1.points.length === 4 && typeof op1.ts === 'number',
    'op carries color/width/points/timestamp');

  // ---------- 3. B 发一笔：seq=2 ----------
  console.log('\n[3] B sends stroke');
  const pOp2 = once(a, 'op', (m) => m.op.strokeId === 's2');
  send(b, { type: 'stroke', stroke: stroke('s2', '#2563eb', 3) });
  const ack2 = await once(b, 'ack', (m) => m.strokeId === 's2');
  const op2 = (await pOp2).op;
  assert(ack2.seq === 2, 'B gets ack seq=2');
  assert(op2.seq === 2, 'A gets broadcast op seq=2 (monotonic)');

  // ---------- 4. 幂等：重发 s1，不应重复入库，seq 仍是 1，不产生广播 ----------
  console.log('\n[4] duplicate stroke resend is idempotent');
  let bGotExtra = false;
  const extraHandler = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'op' && m.op.strokeId === 's1') bGotExtra = true;
  };
  b.on('message', extraHandler);
  const ack1b = await (new Promise((resolve) => {
    once(a, 'ack', (m) => m.strokeId === 's1').then(resolve);
    send(a, { type: 'stroke', stroke: stroke('s1') });
  }));
  await new Promise((r) => setTimeout(r, 300));
  b.off('message', extraHandler);
  assert(ack1b.seq === 1, 'duplicate resend returns same seq=1');
  assert(!bGotExtra, 'duplicate resend is not rebroadcast');

  // ---------- 5. 新成员 C：全量 OpLog ----------
  console.log('\n[5] new member C gets full history');
  const c = connect();
  await new Promise((r) => c.on('open', r));
  const jc = await joined(c, room, 0, 'C');
  assert(jc.joined.lastSeq === 2, 'joined.lastSeq = 2');
  assert(jc.sync.reset === true, 'C gets reset=true full sync');
  assert(jc.sync.ops.map((o) => o.seq).join(',') === '1,2', 'C replays seq [1,2] in order');
  assert(jc.sync.ops[0].strokeId === 's1' && jc.sync.ops[1].strokeId === 's2', 'history order s1,s2');

  // ---------- 6. 模拟重连：D 带 lastSeq=1 只收增量 ----------
  console.log('\n[6] reconnect with lastSeq=1 gets only missing ops');
  const d = connect();
  await new Promise((r) => d.on('open', r));
  const jd = await joined(d, room, 1, 'D');
  assert(jd.sync.reset === false, 'incremental sync reset=false');
  assert(jd.sync.ops.length === 1 && jd.sync.ops[0].seq === 2 && jd.sync.ops[0].strokeId === 's2',
    'D only receives seq=2');

  // lastSeq=2：无缺失
  const d2 = connect();
  await new Promise((r) => d2.on('open', r));
  const jd2 = await joined(d2, room, 2, 'D2');
  assert(jd2.sync.ops.length === 0, 'lastSeq=2 catches up: no missing ops');

  // ---------- 7. 断线期间笔迹补齐 ----------
  console.log('\n[7] missing ops while offline are backfilled on reconnect');
  d2.close();
  send(a, { type: 'stroke', stroke: stroke('s3', '#16a34a', 2) });
  await once(b, 'op', (m) => m.op.strokeId === 's3');
  const d3 = connect();
  await new Promise((r) => d3.on('open', r));
  const jd3 = await joined(d3, room, 2, 'D3');
  assert(jd3.sync.ops.length === 1 && jd3.sync.ops[0].seq === 3 && jd3.sync.ops[0].strokeId === 's3',
    'reconnect after offline backfills seq=3');

  // ---------- 8. 房间隔离 ----------
  console.log('\n[8] room isolation');
  const e = connect();
  await new Promise((r) => e.on('open', r));
  const je = await joined(e, room + '-other', 0, 'E');
  assert(je.sync.ops.length === 0, 'other room has independent empty oplog');
  const leaked = [];
  e.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'op') leaked.push(m);
  });
  send(a, { type: 'stroke', stroke: stroke('s4') });
  await once(b, 'op', (m) => m.op.strokeId === 's4');
  await new Promise((r) => setTimeout(r, 200));
  assert(leaked.length === 0, 'stroke in room A is not broadcast to other room');

  // ---------- 9. 无效消息 / 未加入房间 ----------
  console.log('\n[9] error handling');
  const err = once(e, 'error');
  send(e, { type: 'stroke', stroke: { strokeId: 'bad', color: '#fff', width: 1, points: [] } });
  assert((await err).message.includes('invalid'), 'empty points stroke rejected');

  const f = connect();
  await new Promise((r) => f.on('open', r));
  const err2 = once(f, 'error');
  send(f, { type: 'stroke', stroke: stroke('no-room') });
  assert(!!(await err2), 'stroke before join rejected');

  // ---------- 10. HTTP 静态与 API ----------
  console.log('\n[10] HTTP');
  const index = await httpGet('/');
  assert(index.status === 200 && index.body.includes('<canvas'), 'GET / serves index.html with canvas');
  const api = await httpGet(`/api/room?roomId=${room}`);
  const apiJson = JSON.parse(api.body);
  assert(api.status === 200 && apiJson.count === 4 && apiJson.ops.map((o) => o.seq).join(',') === '1,2,3,4',
    `GET /api/room shows 4 ops with monotonic seq (got ${apiJson.count})`);
  const roomsApi = await httpGet('/api/rooms');
  assert(roomsApi.status === 200 && JSON.parse(roomsApi.body).some((r) => r.roomId === room), 'GET /api/rooms lists room');
  const missing = await httpGet('/api/room?roomId=nope-xyz');
  assert(missing.status === 404, 'unknown room -> 404');

  // 心跳 pong
  const pong = once(a, 'pong');
  send(a, { type: 'ping' });
  assert(!!(await pong), 'application ping/pong works');

  [a, b, c, d, d3, e, f].forEach((ws) => { try { ws.close(); } catch (_) {} });

  console.log(`\n========================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
