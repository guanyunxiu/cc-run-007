# 直播白板低延迟同步

原生 HTML/CSS/JS + Canvas 前端，Node.js + ws 后端。
支持鼠标 / 触控笔 / 触摸屏自由书写、贝塞尔平滑、本地预提交、双缓冲、断线指数退避重连与缺失笔迹自动补齐。

## 目录结构

```
whiteboard-sync/
├── package.json        # 依赖与启动脚本（仅依赖 ws）
├── server.js           # Node.js HTTP 静态服务 + WebSocket 服务（房间/OpLog/心跳/广播）
├── test-smoke.js       # 协议层冒烟测试（seq、广播、ack、同步、幂等、房间隔离）
├── test-frontend.js    # 前端状态机测试（预提交、双缓冲、平滑、重连补齐）
├── server.log          # 运行时日志（gitignore）
└── public/
    ├── index.html      # 加入房间页 + 白板页结构
    ├── style.css       # 样式（状态灯、工具栏、touch-action 等）
    └── app.js          # Canvas 绘制 / pointer 事件 / 双缓冲 / 重连同步
```

## 启动

要求 Node.js >= 16（内置 `crypto.randomUUID`、`URL` 等）。

```bash
cd whiteboard-sync
npm install
npm start          # 或 node server.js
```

看到以下输出即成功：

```
Whiteboard sync server started
  HTTP : http://localhost:8080/
  WS   : ws://<host>:8080/ws
  OpLog: GET http://localhost:8080/api/room?roomId=<id>
```

浏览器打开：

- 本机：<http://localhost:8080/>
- 局域网另一台设备：`http://<本机局域网IP>:8080/`（服务端默认监听 `0.0.0.0`）

自定义端口：`PORT=3000 npm start`

## 功能与实现对应关系

| 需求 | 实现位置 |
| --- | --- |
| pointerdown/move/up/cancel，鼠标/笔/触摸 | `public/app.js` pointer 事件段，`touch-action:none`，`getCoalescedEvents()` 高频点合并 |
| 贝塞尔平滑（中点为终点、中间点为控制点） | `paintStroke()` / `paintIncrementSegment()` 中 `quadraticCurveTo` |
| 本地预提交、不重复渲染 | `pointerdown` 立即画；`commitLocalStroke()` 先合入离屏再发消息；`seenStrokeIds` 幂等；自己收不到自己笔迹的广播 |
| 双缓冲 Canvas | 离屏 `offCanvas` 存历史；主 Canvas 每帧 `drawImage(offscreen)` 后叠当前笔迹 |
| 已连接 / 重连中 / 离线 | 工具栏状态灯：绿/橙闪烁/红；`setStatus()` |
| 指数退避重连 | `scheduleReconnect()`：500ms 起指数增长、上限 10s、随机抖动；`online` 事件立即重连 |
| 心跳与断线检测 | 服务端每 15s 协议层 `ping`，客户端 45s 无活跃则 `terminate`；另有 20s 应用层 ping 和客户端 40s watchdog |
| 房间创建/加入、roomId 映射 | `server.js` `rooms: Map<roomId, {clients, ops}>`，不存在自动创建 |
| 单调 seq、广播、ack | `handleStroke()` 每房间 `seq` 从 1 开始；发送者收 `ack`，其他人收 `op` |
| OpLog 与新成员全量/重连增量 | 加入时带 `lastSeq`：`reset:true` 全量，否则只回 `seq > lastSeq` |
| 断线期间笔迹不丢 | 未 ack 笔迹进 `pending`，重连 `joined` 后重发；服务端按 `strokeId` 幂等 |

## 消息协议（JSON over WebSocket，路径 `/ws`）

客户端 → 服务端：

```jsonc
{ "type": "join",   "roomId": "live-101", "userId": "u-xxx", "lastSeq": 0 }
{ "type": "stroke", "stroke": { "strokeId": "uuid", "userId": "u-xxx",
                                "color": "#1f2937", "width": 4,
                                "points": [{"x":1,"y":2}] } }
{ "type": "ping", "ts": 1700000000000 }
```

服务端 → 客户端：

```jsonc
{ "type": "joined", "roomId": "live-101", "userId": "u-xxx", "lastSeq": 3 }
{ "type": "sync",   "reset": true,  "ops": [ /* 全量 OpLog */ ] }
{ "type": "sync",   "reset": false, "ops": [ /* seq > lastSeq 的增量 */ ] }
{ "type": "op",     "op": { "seq": 4, "roomId": "...", "userId": "...",
                            "strokeId": "...", "color": "...", "width": 4,
                            "points": [...], "ts": 1700000000000 } }
{ "type": "ack",    "strokeId": "uuid", "seq": 4 }
{ "type": "pong" }
{ "type": "error",  "message": "..." }
```

## 手动测试步骤

### 1. 双人实时同步

1. 启动服务端。
2. 浏览器 A、B 都打开 <http://localhost:8080/>，输入相同房间号（如 `live-101`）加入。
3. 两端状态灯变绿，显示“已连接”。
4. A 端书写：落笔即见（本地预提交，零等待），B 端几乎实时出现相同笔迹。
5. B 端书写，A 端同样实时收到；线条为平滑贝塞尔曲线，无折线感。
6. 右上角 `seq` 两端最终一致。

### 2. 刷新恢复

任一端按 F5 刷新 → 重新加入同一房间 → 服务端全量下发 OpLog，白板恢复刷新前内容。

### 3. 断线重连与补齐

- **断网模拟**：Chrome DevTools → Network 切 Offline；状态变红“离线”，此时仍可在本地书写（乐观显示）。
- 恢复网络：状态先变橙“重连中…”，指数退避后自动变绿“已连接”；断线期间笔迹自动补齐到其他端，本端也不重复。
- **服务端重启**：直接 `Ctrl+C` 停掉 `node server.js`，状态进入“重连中…”；重新 `npm start`，客户端自动重连并按 `lastSeq` 增量同步。
  > 注：OpLog 保存在内存中，**进程重启后历史会清空**（重连客户端会以服务端为准 reset 重放）；持久化可后续接入 Redis/数据库。

### 4. 观察 seq 与 OpLog

- 服务端控制台实时打印：`[op] seq=1 room=... user=... stroke=... points=... broadcast=N`，seq 严格递增。
- HTTP 接口：

```bash
curl http://localhost:8080/api/rooms
curl http://localhost:8080/api/room?roomId=live-101
```

### 5. 局域网多设备

手机/平板与电脑连同一 Wi-Fi，访问 `http://<电脑IP>:8080/`，输入同一房间号即可互相同步；同 Wi-Fi 下延迟通常为个位数~几十毫秒，本地预提交后书写感知延迟接近 0。

## 自动化测试

```bash
npm start                 # 终端 1：保持服务端运行
node test-smoke.js        # 终端 2：26 项协议测试
node test-frontend.js     # 22 项前端状态机测试（含真实断线重连补齐）
```

`test-smoke.js` 覆盖：双客户端广播、ack、seq 单调递增、重复笔迹幂等不重广播、新成员全量历史、`lastSeq` 增量、断线补齐、房间隔离、非法消息、静态文件与 HTTP API、应用层 ping/pong。

`test-frontend.js` 覆盖：预提交即时渲染、pointermove 贝塞尔增量段、收笔合并离屏、自己笔迹只画一次、远端 op 合批一次重绘、重复 op 幂等、增量/全量 sync、断线状态切换、指数退避自动重连、离线笔迹重发后服务端 OpLog 可查。

## 设计要点说明

- **为什么 pointerup 才发送**：整笔点集一次入库/广播，服务端只需一条 op、一个 seq，天然不会出现半包乱序；书写过程中的流畅度完全由本地预提交保证。
- **为什么自己不会重影**：发送者不接收自己笔迹的广播（服务端广播时跳过发送者），且任何回流路径（sync/重发 ack）都以 `strokeId` 幂等。
- **为什么书写中收到远端笔迹也不闪**：远端笔迹先合入离屏；若当前正在书写，主 Canvas 不清屏，只把远端笔迹叠画一次，当前笔结束后整体重绘，像素重合。
- **低延迟**：落笔到上屏是纯本地 Canvas 操作（<1 帧）；网络只影响“别人看到”的时间，不影响自己跟手。
