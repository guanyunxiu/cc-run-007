# 直播白板低延迟同步

原生 HTML/CSS/JS + Canvas 前端，Node.js + `ws` 后端。零构建、零前端框架，开箱即跑。

## 功能一览

**前端**

- Pointer Events（`pointerdown/move/up/cancel`），同时支持鼠标、触控笔、触摸屏；`touch-action: none` + 指针捕获保证移动中不丢点
- `quadraticCurveTo` 三点中点插值贝塞尔平滑，不画折线；轻点画圆点
- 本地预提交：落笔即渲染，`pointerup` 才发整笔；发送者不接收自己笔迹的广播，靠 `strokeId` 去重，无重影
- 双缓冲 Canvas：离屏 canvas 存历史，主 canvas 每帧 `drawImage` 历史 + 当前笔迹，rAF 合帧
- 状态指示：已连接 / 连接中 / 重连中 / 离线；指数退避（500ms 翻倍，上限 10s，±20% 抖动）自动重连
- 重连后按 `lastSeq` 增量补齐；刷新后全量重放 OpLog 恢复白板
- 发送可靠性：笔迹在收到服务端 `ack` 前保留在待发队列，断线重连自动重发（服务端按 `strokeId` 幂等去重）
- 高清屏适配（devicePixelRatio），窗口缩放保留历史内容
- 颜色 / 线宽选择、房间号、昵称、在线人数、已同步 seq、待发送计数

**后端**

- `ws` WebSocket 全双工长连接，服务端 30s 定时 `ping`，`pong` 心跳 + 65s 超时清理死连接
- `roomId -> { clients, oplog }` 映射，房间不存在自动创建，多客户端同房
- 每房间独立 OpLog，`seq` 从 1 开始单调递增、连续不乱序
- 笔迹落库后：发送者只收 `ack`（不阻塞、不回环），其他成员收到完整 `stroke` 广播
- `joined` 携带全量/增量历史（按 `lastSeq`），另支持 `sync` 主动拉取
- `strokeId` 幂等：重发不重复落库、不重复广播（返回 `duplicate: true` 的 ack）
- 内置静态资源服务（含目录穿越防护），一个端口同时提供页面和 WebSocket
- 服务端控制台打印每个房间的每条操作日志

## 目录结构

```
live-whiteboard/
├── package.json
├── server.js              # Node.js 服务端：HTTP 静态服务 + ws 长连接 + 房间/OpLog/心跳
├── public/
│   ├── index.html         # 加入房间页 + 白板页
│   ├── style.css
│   └── app.js             # Canvas 双缓冲、贝塞尔平滑、预提交、重连同步
└── test/
    └── run-tests.js       # 端到端自动化测试（拉起真实服务端，零第三方框架）
```

## 启动命令

```bash
cd live-whiteboard
npm install        # 仅依赖 ws
npm start          # 默认端口 8080，可用 PORT=3000 npm start 改端口
```

浏览器打开：

- 本机：`http://localhost:8080/`
- 局域网（手机/另一台电脑）：`http://<本机局域网IP>:8080/`

## 手动测试步骤

1. 两个浏览器窗口（或一台电脑 + 一部手机）都打开页面，输入相同房间号（如 `room-101`），点「加入房间」。
2. 右上角状态变为绿色 **已连接**，出现白板；两侧在线人数均为 2。
3. A 端按下鼠标/触控笔/手指书写：笔迹落笔即现，线条平滑无折角。
4. B 端在几十毫秒内看到相同笔迹（颜色、线宽、形状一致）；B 画 A 看同理。
5. 刷新任一窗口：重新加入后白板从 OpLog 完整恢复，内容与刷新前一致。
6. 断线重连测试：
   - 直接在终端 `Ctrl+C` 停掉服务端 → 页面状态变橙色 **重连中**（持续指数退避重试）；
   - 重新 `npm start` → 客户端自动连上、状态回到 **已连接**，期间不丢白板；
   - 断网时状态变红色 **离线**，恢复网络后自动重连。
7. 服务端控制台实时打印 `[op] room=... seq=N ...`，同一房间 seq 严格 1、2、3… 递增。
8. 状态栏可观察「已同步 seq」水位与「待发送」队列（断线时笔迹留在队列，重连后自动发出）。

> 注：OpLog 目前存内存（房间空了也保留，供刷新/短暂掉线恢复）；重启服务端进程后历史清空。如需持久化可在 `onStroke` 落库处接 Redis/数据库。

## 自动化测试

```bash
npm test
```

会拉起一个真实服务端（端口 8791，可用 `TEST_PORT` 覆盖），通过 ws 客户端验证 44 项断言：

- 静态资源服务（/、app.js、style.css）
- 加入房间、presence 在线人数
- 笔迹广播：对端实时收到；发送者只收 ack、不收自己的回环广播
- seq 从 1 开始、房间内连续递增；操作携带颜色/线宽/点集/时间戳/userId
- 全量 OpLog 重放（模拟刷新）
- `lastSeq` 增量同步与 `sync` 拉取（模拟断线重连补缺）
- 同一 `strokeId` 重发幂等：不重复落库、不二次广播
- 3 客户端 × 3 笔并发：每人 ack 与广播数量精确、seq 严格 1..9、笔迹不重复
- 非法 JSON / 空笔迹被安全忽略

## 消息协议

| 方向 | type | 关键字段 | 说明 |
|---|---|---|---|
| C→S | `join` | `roomId, userId, lastSeq?` | 加入/重连；`lastSeq` 之后的操作随 `joined` 返回 |
| C→S | `stroke` | `strokeId, color, size, points:[{x,y}]` | 提交一整笔（pointerup 后） |
| C→S | `sync` | `lastSeq` | 主动拉增量 |
| C→S | `ping` | — | 应用层心跳（服务端另有 ws 层 ping） |
| S→C | `joined` | `roomId, userId, peers, lastSeq, ops[]` | 握手确认 + 历史重放 |
| S→C | `stroke` | `op{seq,roomId,userId,strokeId,color,size,points,ts}` | 他人笔迹广播 |
| S→C | `ack` | `strokeId, seq, duplicate?` | 自己笔迹的确认，不触发渲染 |
| S→C | `presence` | `peers` | 房间在线人数变化 |
| S→C | `sync` | `lastSeq, ops[]` | 增量拉取响应 |
| S→C | `error` | `message` | 错误提示 |

## 低延迟设计要点

- **预提交**：渲染零网络等待，网络只影响“别人何时看到”，不影响自己书写手感
- **双缓冲 + rAF**：历史层一次性位图拷贝，每帧只重画当前一笔，点数再多也不重放全量
- **整笔发送**：pointerup 才发一条消息，避免逐点广播造成的消息风暴与抖动；点集本身保留移动全路径
- **只广播给他人**：发送者收 ack 即可，省去回环流量，也从机制上杜绝重影
- **指数退避重连 + 增量补齐 + 幂等重发**：弱网下不丢笔、不重笔
