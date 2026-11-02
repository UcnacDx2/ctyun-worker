# ctyun-worker

天翼云电脑保活与点数任务，从 [CtYun-Keeper](https://github.com/vay1314/CtYun-Keeper)（Go）移植成 TypeScript，跑在 Cloudflare Workers 上（不用 Docker、不用 WASM）。

**目标**：云电脑被平台判空闲自动关机之前把会话续上，一直保活到手动停止。

## 保活怎么跑的

```
面板「开启保活」→ accounts.keepalive=1
      ↓
Durable Object KeepaliveScheduler（单例 "global"）
      ↓ alarm 每 20 分钟醒一次
runKeepaliveRound → 对每个 keepalive=1 的账号并行 runPulse
      ↓
runClink：网页身份登录 → 取连接信息 → WS 握手 → REDQ 应答
          → 收 103 → 回 userInfo + mainClientLoginInfo + 104 → 5 秒心跳
      ↓ 激活后再挂 15 秒就收工（PULSE_SECONDS 只是平台反应慢时的封顶）
      ↓
写 last_result（面板可见）+ 排下一轮 alarm
```

一轮实际约 **21 秒**（登录握手 ~6s + 激活后 15s），不是把 60 秒挂满。

- **手动停止**：面板关掉开关 → `keepalive=0` → 运行中的会话在 10 秒内读到并主动退出，同时删掉下一轮 alarm
- 全程没有 cron trigger：**免费版每账号只有 5 个 cron，这个账号已经用满**，所以用 DO alarm 自调度
- **抢锁**：`last_pulse_at` 锁窗口是 `封顶时长 + 2 分钟`，比一轮更长。开启保活**不清锁**（那轮可能正在跑，清了就会放进第二个会话互踢），只有停止才清
- **看门狗**：`GET /api/keepalive` 顺手检查——开着保活但最后一轮脉冲已经过了 `PULSE_INTERVAL_MINUTES + 5 分钟`，说明闹钟被部署或 DO 回收掐断了，就地重排一个。所以**每次部署后打开一次面板**，链路就会自己接上
- 中断痕迹：一轮被掐断时 `last_result` 会停在 `running`，面板超过「封顶时长 + 3 分钟」就显示「中断」而不是一直「建立中」

### 频率与时长

公众版云电脑的规则是**断开连接 1 小时后自动休眠，24 小时后自动关机**。要防的是「被判空闲」，
不是要一直占着 —— 只要每次连接的间隔短于 1 小时就够了。

另一头，**平台要的是「连接信号」，不是时长**：收到 `103` 就等于进桌面的登录握手已经完成，
所以激活之后不用继续挂着，再停十几秒收工即可。`PULSE_SECONDS` 因此退化成「平台反应慢时的封顶」。

改这三个值不用改代码，动 `wrangler.jsonc` 的 vars 再 deploy：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PULSE_INTERVAL_MINUTES` | `20` | 两轮之间隔多久（分钟） |
| `PULSE_AFTER_ACTIVATE_SECONDS` | `15` | 激活之后再保持多少秒就收工 |
| `PULSE_SECONDS` | `60` | 一轮的封顶时长（秒），防止平台迟迟不回 103 时挂太久 |

看门狗阈值跟着 `PULSE_INTERVAL_MINUTES` 走，改完不用另外同步。

**别把封顶调太小**：实测 10 秒会翻车 —— `103` 不是立刻回的，偶尔要十几秒，太短就会「握手发了但没等到 103」，
那一轮算不算数就说不清了。20 秒左右比较稳。

实测一轮完整记录：

```
保活会话建立中（激活后保持 15s，最长 60s）
→ 云机 2368**** 天翼云电脑精英版 / 网页身份登录 ✅ / 连接信息 ✅ sh9b-deskmgr.ctyun.cn:9011
→ WebSocket 握手 ✅ / 握手帧 + initialPayload 已发 / 收到 103 → 已回登录帧
→ 已激活，再保持 15s 后收工 → heldSeconds 21.1
→ 另一次：保持 86.9s 后「检测到保活开关已关闭，主动退出」（手动停止）
```

**没验到的部分**：平台的休眠倒计时没有对外接口可以读 —— `connectApiUrl.statusPath` 指向的
`/api/desktop/client/status` 实测一直回 `52060 获取桌面连接信息超时或失败`（Go 版里这个方法也没人调用，
是个死方法）。所以「短信号够不够」只能靠行为观察：云机的 `useStatusText` 会不会从「运行中」变掉。
代码里保留了 `GET /api/accounts/:id/dstatus` 这个探针，平台哪天改了就能直接读。

## 接口

| 能力 | 接口 | 状态 |
| --- | --- | --- |
| 手动登录并存账号 | `POST /api/login` | ✅ |
| 账号列表 / 删除 | `GET /api/accounts`、`DELETE /api/accounts/:id` | ✅ |
| 开关保活 | `POST /api/accounts/:id/keepalive` `{enabled}` | ✅ |
| 调度器状态（下次唤醒 / 上轮结果） | `GET /api/keepalive` | ✅ |
| 云电脑列表 / 开关机 / 重启 | `GET .../desktops`、`POST .../power` | ✅ |
| 每日任务 / 积分 / 商品 | `GET .../tasks`、`.../points`、`.../rewards` | ✅ |
| 兑换下单 | `POST .../order` | ✅ 代码就位，未真兑 |
| 取 Clink 连接信息 | `POST .../connect` | ✅ 会先走一次网页登录刷新会话 |
| 手动跑一次保活会话 | `GET .../clink?seconds=N` | ✅ 激活后 `N` 秒收工 |
| 桌面状态探针 | `GET .../dstatus` | ⚠️ 平台恒回 `52060`，留着备用 |
| 连通性探针 | `GET .../probe` | ✅ |
| 日志 | `GET /api/logs`、`GET .../logs` | ✅ |
| 健康检查（含 MD5 自测） | `GET /api/health` | ✅ |

## 面板

`public/index.html`，复用 Go 版 `app/web/static` 的 `app.css` / `theme.js` / 图标字体，页面对应：

| 页面 | 内容 |
| --- | --- |
| 仪表盘 | 账号数、保活中数量、下次唤醒时间、每个账号最近一次脉冲（建立中 / 已激活 / 未激活 / 失败） |
| 账号管理 | 添加账号（手机号+密码，自动过图形验证码）、开关保活、删除 |
| 云机管理 | 云机列表、状态、开机 / 重启 / 关机 |
| 任务中心 | 今日任务进度、当前积分 |
| 日志中心 | 全账号最近 200 条运行日志 |

## 两个身份，别混用

平台 Web 客户端与原生客户端是两套鉴权，混用会拿到 `40010`：

- **原生身份**（`CTG-*` 头，`deviceType=25`，SHA-256 大写签名）：登录、云机列表、积分、任务、兑换
- **网页身份**（`ctg-*` 头，`deviceType=60`，MD5 大写签名）：取 Clink 连接信息、开关机

## 协议要点（Clink）

1. `fetch()` 的 URL 不能用 `wss://` —— workerd 只认 `https://` + `Upgrade: websocket` 头；用 `wss://` 报 `Fetch API cannot load`
2. 握手帧的 `host`/`port` 必须是 `connect` 返回的**内网**主机端口，`servername = host:port`；填 LVS 主机名会被立刻断开
3. 握手帧的 `ca`/`cert`/`key` 必须填真实 PEM，空字符串会被立刻断开；证书是 SHECA 签发的 `*.ctyun.cn`，链完整，**不需要跳过校验**
4. REDQ 挑战：`RSA modpow(模数在 challenge[48:177]，指数在 [179:181]) + SHA-1 MGF1` → 回 132 字节应答。不回就没有 103，会话不算激活
5. 二进制帧可能以 `Blob` 到达，不 `arrayBuffer()` 的话长度读成 0B
6. 帧格式：`uint16 类型 + uint32 长度 + 载荷`；`4` 回 `3`，`3` 回 `1`，心跳 `7` 每 5 秒

## 踩过的坑（登录）

1. 图形验证码必须带 `captchaCodeKey`，key 在验证码响应的 `CTG-CAPTCHA-KEY` 响应头里
2. 首次登录不带验证码，平台回 `51040` 才去取码；识别错回 `51030`，换一张重试；`51031/51032` 同属验证码类
3. `51050 用户名或密码错误` 就是账号名写错了，别去怀疑密码哈希
4. 网页身份的验证码尺寸是 `width=85&height=36&mode=auto`（原生是 `100x40` 且带 `userInfo`），图越小越容易识别错，要重试
5. 原生登录口令是 `sha256(sha256(明文) + challengeCode)`，只提交 `password`

## 与 Go 版的差异

| 项 | Go 版 | 这里 |
| --- | --- | --- |
| 定时 | cron / 每任务调度 | Durable Object alarm（cron 配额已满） |
| 存储 | SQLite + AES-256-CBC + 自写 PKCS7 | D1 + AES-GCM（WebCrypto，带认证标签） |
| 管理密码 | argon2 | PBKDF2（Workers 没有 argon2），本移植版暂未做登录态 |
| 云机画面 | `/desktop-relay` + `/desktop-view` 反代 | **未移植** |
| 系统设置 / 自更新 / setup | 有 | **未移植** |

## 部署

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy bash deploy.sh
```

本机部署如果卡在 `fetch failed`，挂代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 npx wrangler deploy
```

本地开发：

```bash
node node_modules/wrangler/bin/wrangler.js dev --port 8787
```

## 线上地址

部署完是 `https://<worker 名>.<你的子域>.workers.dev`；想用自有域名就在 `wrangler.jsonc` 里加 `routes`（见 `wrangler.example.jsonc`）。

国内直连 Cloudflare 时通时不通，失败先重试，或者给 `wrangler` 挂代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 npx wrangler deploy
```

## 运行成本

脉冲是一问一答式的短连接 + 20 分钟一次、一轮约 21 秒，不常亮，所以量很小：每个账号一小时 3 轮、一天 72 轮，
一轮 2 条 HTTP（登录/连接）+ 1 条 WebSocket。Durable Object 的 alarm 每次唤醒算 1 次 DO 请求，
一天 72 次 —— 免费额度（DO 10 万请求/天、13 万 GB-s/天）连零头都用不到。

真正吃额度的是 **常亮**：一条 WS 挂满 24 小时约 33 万 GB-s/月，接近付费版 40 万 GB-s 的免费额度。
所以这里刻意不常亮，只在关机判定之前把连接续上。
