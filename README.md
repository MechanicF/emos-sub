# EMOS 订阅网关

EMOS 登录核验萝卜余额，**严格大于门槛（默认 500，可在后台改）**才能进控制台、领取每人专属的订阅链接。节点流量取自 1e.lol 探针的整机总流量，不做每人用量统计。

当前版本：**v1.5.15**（2026-11-28，节点解锁检测版）

零依赖 Node.js（Node ≥ 18），不用 `npm install`。`server.js` + `unlock.js`（解锁探测）+ `config/` + `manage.sh`。解锁检测需要额外的 mihomo 二进制（见下）。

`config/nodes.json` 已被 git 忽略（后台保存后含真实节点凭证）。首次启动会自动从 `config/nodes.example.json` 生成一份 0600 的副本；升级不会覆盖它。

## 快速开始

```bash
git clone https://github.com/MechanicF/emos-sub.git
cd emos-sub
PORT=3000 ADMIN_TOKEN=你的口令 node server.js
```

- 控制台：`http://127.0.0.1:3000/`；后台：`http://127.0.0.1:3000/admin`。
- 不设 `ADMIN_TOKEN` 也能启动，但后台返回 503。
- 后台运行：`./start.sh`（检查 Node 版本和端口），或 `nohup node server.js > server.log 2>&1 &`。

服务器部署建议用 `./manage.sh`。

## 部署与更新（manage.sh）

```bash
./manage.sh install --port 3000 --public-url https://sub.example.com  # 安装并启动（默认 /opt/emos-sub）
./manage.sh status        # 状态、端口、健康、节点数、版本
./manage.sh start|stop|restart
./manage.sh port 8080     # 改端口并重启
./manage.sh autostart on|off   # 开机自启（systemd；无 systemd 用 cron @reboot）
./manage.sh logs [-f]     # 日志
./manage.sh update        # 备份配置 → 拉最新代码 → 重启
./manage.sh backup        # 备份 .env + config/
./manage.sh config        # 查看配置（口令只显示前 4 位）
./manage.sh set-token <新口令>   # 改后台口令并重启
./manage.sh set-url <域名>      # 改公开域名并重启
./manage.sh health        # 健康检查
./manage.sh uninstall     # 先备份，确认后停服务并删除
```

`update` 只更新代码文件，`.env` 和 `config/`（节点、设置）原样保留，更新前自动备份到 `backups/`（只留最近 10 个，权限 0600）。节点模板 `config/nodes.example.json` 随代码更新，真实 `nodes.json` 不参与版本控制。完整命令见 `./manage.sh help`。旧版 `manage.sh` 的 `update` 若报 `There is no tracking information`，先用 `curl -fsSL https://raw.githubusercontent.com/MechanicF/emos-sub/main/manage.sh -o manage.sh && chmod +x manage.sh && ./manage.sh update` 换新版再跑。

## 节点解锁检测（v1.5.15）

参考 [ZeroDeng01/sublinkPro](https://github.com/ZeroDeng01/sublinkPro) 的解锁检测实现，控制台节点表新增「解锁」列：点「解锁」展开该节点当前 7 项服务的可用状态（Netflix / Disney+ / YouTube Premium / OpenAI / Gemini / Claude / 巴哈姆特动画疯），带地区码与状态色标。

**原理**：用独立的 mihomo 二进制为每个节点建立真实代理连接，从该出口发服务级探针，判定逻辑移植自 sublinkPro 的 `services/unlock/`。结果按节点 `key` 缓存到 `config/unlock.json`（0600、git 忽略），**每 24 小时后台全量刷新一次**，服务启动时也会延迟触发一次首检。控制台读的是缓存，不实时打节点，所以展开是秒开。

**启用步骤**：

```
./manage.sh install-mihomo          # 从 GitHub Release 下载对应平台二进制到安装目录
# 在 .env 中加：
UNLOCK_ENABLED=1
```

可选环境变量：`MIHOMO_BIN`（二进制路径，默认安装目录下的 `mihomo`）、`MIHOMO_VERSION`（默认 `v1.19.11`）、`EMOS_UNLOCK_FILE`（结果文件，默认 `config/unlock.json`）。不设 `UNLOCK_ENABLED=1` 时功能完全关闭，不下载、不启动任何子进程。

**注意**：
- mihomo 是唯一的外部二进制依赖；Node 侧仍零依赖、不用 `npm install`
- 探测走节点真实出口，节点不可用时该项标记 `error`，不影响订阅与流量功能
- `partial` 表示部分能力（如仅官方原创内容）；节点不可用时该项标记 `error`
- `manage.sh update` 会同步更新 `unlock.js`

## 怎么用

### 用户：控制台 `/`

点“用 EMOS 账号登录”，跳到 EMOS 登录，回来后服务端验 token，萝卜 > 门槛放行。控制台只保留这一种登录入口。

控制台从上到下：统计行（萝卜 / 节点 / 订阅访问）→ 节点表 → 订阅卡（一条订阅链接 + 复制 + 轮换/停用/退出登录）。订阅地址右侧的「复制」会把链接复制到剪贴板，粘贴到客户端即可；原本重复的「一键导入」已移除，也不再自动跳 `sing-box://` 深链（未注册该协议的浏览器会卡住）。节点表每 30 秒自动刷新，控制台不再提供手动「刷新流量」按钮。服务端按会话状态直接渲染首屏（会话 Cookie 是 HttpOnly，前端无法自行判断），已登录用户刷新页面不会闪出登录界面；该页面带 `Cache-Control: no-store`，避免被代理缓存串号。

节点表：节点、到期、状态、今日、本月已用 / 限额。到期默认取探针的 `expires_at`，手动填的优先；14 天内和已过期标红。每台流量是探针上那台服务器的整机网卡总流量。

订阅链接每人专属，绑定 EMOS `user_id`，可刷新（旧链接立即失效）或停用。

### 站长：后台 `/admin`

输 `ADMIN_TOKEN` 登录。管理节点（粘贴链接 → 解析预览 → 保存）、分享链接（查看、刷新、停用/启用、吊销、全部吊销）、设置。分享只由用户登录后自动创建，后台不能凭空发。后台节点表能看到探针对应关系（控制台不显示）。

### 界面

深色（默认）/浅色切换，右上角按钮，选择存浏览器。手机端（≤640px）节点表变卡片布局，统计卡 2×2。

## 订阅格式

每人一条链接：`GET /c/?token=<shareToken>`，服务端按 User-Agent 自动返回对应格式；浏览器打开显示说明页。手动指定：`?client=<格式>`。

| 客户端 | 返回格式 |
| --- | --- |
| FlClash、Clash、mihomo、Clash Verge | Clash YAML |
| sing-box、Hiddify、Karing | sing-box JSON |
| Surge | Surge 配置 |
| Shadowrocket、Loon 等 | hy2 / vless 链接列表 |
| 其他 | 链接列表 |

`?client=` 可取值：`clash`、`sing-box` / `json`、`surge`、`v2ray` / `b64`、`uri` / `links`。

支持 `hy2://`、`hysteria2://`、`vless://`（含 REALITY）。命名规则默认 `[$Flag] $LinkCountryName - $Name`，重名自动加序号。Clash 分流用 ACL4SSR AdblockPlus 规则（15 个 rule-providers + 11 个分组，`GEOIP,CN` 直连、`MATCH` 漏网之鱼），模板在 `config/templates/clash.yaml`。

**FlClash 没节点先查三点：**① 用控制台那条唯一的订阅链接（不带 `client` 参数）；② 链接默认永不过期（后台可设有效期），刷新 / 轮换后旧链接才失效；③ 服务器端口放行，浏览器能打开订阅地址看到 YAML 才算通。

响应头带 `Subscription-Userinfo`（节点总流量，到期本月底 23:59），`Cache-Control: private, no-store`；Clash 另带 `profile-update-interval: 24`。反代须透传 User-Agent。探针拉取失败时用内置样本值兜底并注明。VLESS Encryption（`mlkem768x25519plus`）是 Xray 功能，原版 sing-box 可能导入失败，建议用 Xray 核心客户端。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `ADMIN_TOKEN` | （必填） | 后台口令；未设后台返回 503 |
| `PUBLIC_URL` | （空） | 公开域名，如 `https://sub.example.com`；订阅链接和 EMOS 回调都以它为准，生产配 HTTPS |
| `CARROT_THRESHOLD` | 500 | 萝卜门槛，须严格大于此值 |
| `SHARE_TTL_HOURS` | 0 | 分享有效期（小时），0 = 永不过期 |
| `PROBE_CACHE_SECONDS` | 30 | 探针缓存（秒） |
| `EMOS_APP_NAME` | emos-sub | EMOS `/link` 登录页显示的应用名 |
| `TRUST_PROXY` | auto | 是否信任转发头里的客户端 IP：`auto` 只信任本机/内网来源；`1` 总是信任；`0` 永不信任 |
| `TRUST_PROXY_HOPS` | 1 | 可信反代层数：从 `X-Forwarded-For` 链右往左取值，客户端伪造的前缀无效。单级反代填 1，CDN + Nginx 填 2 |
| `TRUST_PROXY_IPS` | （空） | 精确指定可信反代来源（逗号分隔 IP 或 IPv4 CIDR，如 `127.0.0.1,172.17.0.0/16`）；设置后 `auto` 只信任这些来源 |
| `CLIENT_IP_HEADER` | （空） | 指定优先读取的转发头（如 `cf-connecting-ip`）；默认顺序 `X-Forwarded-For → X-Real-IP → CF-Connecting-IP → True-Client-IP → X-Client-IP → Forwarded` |
| `PROBE_URL` | https://1e.lol/api/nodes | 探针接口地址 |
| `EMOS_BASE` | https://emos.best | EMOS API 地址 |
| `CARROT_RECHECK_MS` | 600000 | 订阅取用时余额复核间隔（毫秒） |
| `CARROT_GRACE_MS` | 86400000 | EMOS 不可达时允许继续服务的**硬上限**（毫秒），超时强制吊销 |
| `PROBE_FAIL_CACHE_MS` | 60000 | 探针失败后的负缓存时长（毫秒） |
| `EMOS_STATE_FILE` | config/state.json | 会话/分享落盘位置 |
| `ADMIN_LOGIN_MAX_FAILS` / `ADMIN_LOGIN_LOCK_MS` | 5 / 900000 | 后台口令连错次数与锁定时长（毫秒） |
| `DEMO_ENABLED` | （空） | 仅测试：设 `1` 才允许演示登录（`NODE_ENV=production` 时强制忽略） |
| `UNLOCK_ENABLED` | （空） | 设 `1` 启用节点解锁检测（需先装 mihomo） |
| `MIHOMO_BIN` | 安装目录/mihomo | mihomo 二进制路径 |
| `MIHOMO_VERSION` | v1.19.11 | `install-mihomo` 下载的版本 |
| `EMOS_UNLOCK_FILE` | config/unlock.json | 解锁结果缓存位置 |

后台“设置”页可改门槛、有效期、命名规则、探针缓存，写 `settings.json` 立即生效。优先级：环境变量 > `settings.json` > 默认值。

节点放 `config/nodes.json`（首次启动由 `nodes.example.json` 生成，git 忽略、权限 0600；协议链接 + 地区 + 探针 id + 到期 `expires_at`，可空）。后台增删改节点原子写入（0600）并留 `.bak`，立即生效，不用重启。

## 安全

- 后台口令：同一 IP 连错 5 次锁 15 分钟（第 6 次起 429），输对清零；比较用 `timingSafeEqual`。
- 限流：`/api/auth` 和 EMOS 跳转每 IP 10 分钟 30 次；订阅端点每 IP 每分钟 120 次。
- 萝卜掉下门槛立即吊销：订阅取用时最多 10 分钟核验一次；核验失败当场停用链接（记录保留，重新登录可恢复同一条链接）；EMOS token 失效（401/403）或临时挂掉不断订阅，只进 24 小时宽限并推迟 60 秒再核验，宽限耗尽才停用。
- 每人一个有效登录，新登录结束旧控制台会话，但订阅链接不变（重新登录复用同一条链接；自己或管理员停用的链接除外，重新登录会换新链接）。刷新订阅也要先核验萝卜。
- EMOS 身份强制校验：`sign/check` 失败即拒绝登录，绝不再退化成共享的 `unknown` 用户（否则一人登录会踢掉所有人）。
- 管理员吊销 / 停用后，用户**不能**靠「刷新订阅链接」自助复活，必须重新登录；管理员主动刷新或启用可恢复。
- EMOS 故障时的 `stale` 宽限有硬上限（`CARROT_GRACE_MS`，默认 24 小时），超时强制吊销，不会无限续期。
- 会话和分享落盘到 `config/state.json`（0600，git 忽略，随备份走），重启/更新后订阅照常用；文件里有活的 EMOS token，别提交、别外发。备份包以 `umask 077` 生成、权限 0600；卸载时备份失败会中止删除。
- Cookie 都是 HttpOnly + SameSite=Lax，https 下自动加 Secure；响应带 nosniff / no-referrer / DENY 安全头。

## 反向代理与真实客户端 IP

反代会终止 TCP 连接，本服务看到的 `socket.remoteAddress` 永远是反代自己（常见 `::ffff:127.0.0.1`）。**如果分享列表的「最后 IP」全是这个值，说明反代没有传客户端 IP 头**，或只传了旧版本不支持的头（现在 `X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP`、`X-Client-IP`、RFC 7239 `Forwarded` 都支持）。服务无法凭空还原真实 IP，反代必须把原地址写进请求头。

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name sub.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 关键：用 $proxy_add_x_forwarded_for 追加对端地址，
        # 不要只透传 $http_x_forwarded_for（那样客户端可伪造）。
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy 2

```caddy
sub.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 默认就会追加 `X-Forwarded-For` 并带上 `X-Forwarded-Proto`，一般无需额外配置。

### 多层代理 / CDN

`X-Forwarded-For` 是一条链：`客户端, 代理1, 代理2`。本服务按 `TRUST_PROXY_HOPS`（默认 1）**从右往左**取值，取的是反代实际看到的地址，客户端伪造的前缀不生效。CDN + Nginx 两级时设 `TRUST_PROXY_HOPS=2`；Cloudflare 可另设 `CLIENT_IP_HEADER=cf-connecting-ip` 优先读它。非 IP 值（如 `unknown`）会被丢弃，`::ffff:` 前缀与 IPv6 区域标识会规范化。

### 安全边界

转发头在直连时是客户端可伪造的，所以只在「连接来自可信反代」时才采信：

- 默认 `TRUST_PROXY=auto` 信任 loopback / 内网来源（本机 Nginx、Docker bridge 等）；
- 反代走公网 IP、或想收紧范围时用 `TRUST_PROXY_IPS=反代IP或CIDR`；
- **端口若直接暴露到公网，务必保持 `auto` 或 `0`，不要设 `TRUST_PROXY=1`**，否则任何人都能靠伪造头绕过按 IP 限流。

systemd 部署在 `/etc/systemd/system/emos-sub.service` 的 `[Service]` 段加：

```ini
Environment=TRUST_PROXY=auto
Environment=TRUST_PROXY_HOPS=1
```

改完 `systemctl daemon-reload && systemctl restart emos-sub`。

### 自查

登录后台 →「设置」Tab →「反代 IP 诊断」→ 点「检查来源 IP」；或：

```bash
curl -s -H 'X-Admin-Token: 你的口令' https://sub.example.com/api/admin/ip-check
```

返回里看三个字段：`peer`（TCP 对端）、`headers`（反代传了哪些头）、`resolved`（最终采用的 IP）。若 `source` 是 `peer` 且 `headers` 全为 `null`，就是反代没传头，按上面配置补上；`hint` 会直接给出对应建议。此接口需要后台鉴权，只回显 IP 相关头。

## 接口

- `GET /` 控制台；`GET /admin` 后台
- `GET /auth/emos` → EMOS `/link` 登录；`GET /auth/emos/callback` → 回调核验
- `POST /api/auth` 登录（接口保留供程序调用与回归测试，控制台不再提供粘贴 Token 入口）；`POST /api/logout` 退出
- `GET /api/nodes` 节点 + 探针流量；`GET /api/unlock` 节点解锁缓存（需登录）；`GET /api/sub-link` 当前订阅地址；`POST /api/sub/refresh` 轮换；`POST /api/sub/disable` 停用
- `GET /c/?token=&client=`、`GET /sub/:token` 订阅内容；`GET /health` 健康检查；`GET /api/public-settings` 当前门槛
- 后台：`POST /api/admin/login|logout`、`GET /api/admin/health`、`/api/admin/nodes`（增删改 + `/parse`、`/reorder`）、`/api/admin/shares`（刷新/停用/启用/吊销/全部吊销 `/revoke-all`）、`/api/admin/settings`、`GET /api/admin/ip-check`（反代来源 IP 诊断，需鉴权）
- 辅助：`GET /api/auth/emos/login-url`、`GET /api/public-settings`；`X-Forwarded-Proto` 只接受 `http`/`https` 且仅信任代理来源

## 测试

```bash
node test/check-pages.js   # 启动真服务跑回归（76 项）：实发页面脚本校验、订阅结构、限流、吊销流程、重启落盘等
node test/check-fixes.js   # 安全回归（57 项）：身份绑定、吊销不可复活、门禁硬上限、XFP 白名单、413、探针标签、% 解析、事件委托、反代 IP、订阅不断链（v1.5.13）、会话过期不删分享 + 重登刷新过期分享（v1.5.14）、解锁链接解析/配置生成/接口鉴权/CONNECT 隧道（v1.5.15）
```

## 版本历史

- **v1.5.15**：节点解锁检测版 — 参考 sublinkPro 新增 7 项流媒体/AI 解锁检测（Netflix / Disney+ / YouTube Premium / OpenAI / Gemini / Claude / 巴哈姆特），用独立 mihomo 二进制建真实节点代理、Node 侧零依赖通过 CONNECT 隧道发探针；结果按节点 key 缓存到 `config/unlock.json`，每 24H 后台全量刷新；控制台节点表加「解锁」列，点击展开看状态/地区，`manage.sh install-mihomo` 下载二进制。NEP 优化：单节点内 7 项检测并行（Promise.all）；服务端退出时清理残留 mihomo 子进程；`install-mihomo` 增加 `-v` 自检（确认真是 mihomo 才留）；去掉从未返回的 `reachable` 状态；补 CONNECT 隧道端到端测试
- **v1.5.14**：v1.5.13 补漏版 — 修 v1.5.13 漏掉的两处：会话过期时 `getSession()` 还在删分享（控制台 24 小时后一刷新就杀掉所有客户端链接），已去掉；分享 TTL 到期后重登复用旧 `expires_at` 造成永久 403 死锁，重登时刷新有效期。另加两处加固：`/auth/emos/callback` 补 30 次/10 分钟限流（每次命中调 2 次 EMOS）；`NODE_ENV=production` 时强制忽略 `DEMO_ENABLED=1` 并告警（演示登录绕过门槛）
- **v1.5.13**：订阅不断链版 — 修“同一条链接 A 客户端更新后别的客户端 403”：分享默认永不过期（SHARE_TTL_HOURS 默认 0，原 24 小时）；链接不再绑定 24 小时登录会话（会话过期、退出登录都不杀链接）；重新登录复用同一条链接（系统停用的重新登录可恢复，用户/管理员停用的除外）；EMOS token 失效（401/403）改走 24 小时宽限而非立即吊销；宽限在每次取用时强制执行；后台分享表显示停用原因（用户/管理员/系统）；SESSION_TTL_MS 可配
- **v1.5.12**：反代真实 IP 版 — 客户端 IP 从转发链右往左取（默认 1 级反代），伪造 XFF 前缀失效；支持 X-Real-IP / CF-Connecting-IP / True-Client-IP / Forwarded，`::ffff:` 与脏值规范化；新增 TRUST_PROXY_HOPS / TRUST_PROXY_IPS / CLIENT_IP_HEADER；后台「设置」Tab 加反代 IP 诊断（GET /api/admin/ip-check，需鉴权）；README 补 Nginx/Caddy 配置
- **v1.5.11**：服务端首屏版 — 服务端按会话直接渲染控制台首屏（登录卡隐藏、萝卜/订阅链接已填好），已登录刷新不再闪登录界面；接口并行拉取，失效会话切回登录并提示；页面带 no-store 防代理串号
- **v1.5.10**：去手动刷新版 — 删掉控制台「刷新流量」按钮，节点表本来就每 30 秒自动刷新
- **v1.5.9**：单复制入口版 — 删掉与“复制”重复的「一键导入」按钮，控制台只剩一个复制入口；复制逻辑带“链接还没准备好”兜底；测试断言同步改成单复制入口
- **v1.5.8**：登录与导入版 — 控制台去掉手动粘贴 Token 登录，只留 EMOS /link 一种入口；“一键导入”改成复制订阅链接到剪贴板（不再跳 `sing-box://` 深链）；复制加 execCommand 兜底，HTTP 下也能复制；登录卡收窄居中
- **v1.5.7**：界面打磨版 — 修流量条宽度丢 `%` 单位的 bug（之前所有条子都按满格渲染）；订阅说明页垂直居中；后台上下箭头换 SVG 图标；节点协议格改 `.tag`；数字列右对齐 + 等宽字体；停用按钮改红色、退出改文字链接
- **v1.5.6**：视觉重做版 — 控制台、后台与订阅说明页共用一套 `UI_CSS` 设计语言（近黑底 + 青色点缀、等宽数字、扁平卡片）；按钮文案收短；功能与接口不变
- **v1.5.5**：安全修复版 — EMOS 身份强制校验（不再退化为 `unknown`）；管理员吊销/停用后必须重新登录；EMOS 故障宽限加硬上限；`X-Forwarded-Proto` 白名单 + 代理信任；超大 body 返回 413 而非断连；探针二次失败标签修正；节点/备份文件 0600 且 `nodes.json` 改为 git 忽略 + example 模板；后台表格改事件委托；未编码 `%` 不再吞掉节点；探针流量按机器去重；订阅响应补安全头；全局异常累计 5 次退出让 systemd 干净重启
- **v1.5.4**：后台改成 Tab 分区（节点/分享/设置，吸顶 + 记忆上次 Tab）；健康信息行卡片化、表格空状态和消息提示美化
- **v1.5.3**：合入三项优化（订阅 body 缓存、吊销同步 session、排序校验）；另修 `/api/sub-link`：无有效分享时返回 410，不再给 `.../sub/null` 死链接
- **v1.5.2**：合入第三方审查加固（XFF 伪造防护、探针失败负缓存 60 秒 + 并发合并、后台失败计数清扫、页面预渲染、`PROBE_URL` 可配）
- **v1.5.1**：门槛改成 live 值（控制台不再写死 500；新增 `GET /api/public-settings`；回跳地址带 `&threshold=`）
- **v1.5.0**：会话/分享落盘 `config/state.json`，更新重启后订阅不再失效
- **v1.4.5**：去掉控制台顶栏说明文字
- **v1.4.4**：拿掉“总流量”统计卡
- **v1.4.3**：总流量按实际节点算；手机端节点表改卡片布局
- **v1.4.2**：前端视觉精修
- **v1.4.1**：控制台隐藏节点说明和探针对应关系
- **v1.4.0**：全量复核 + 防破解（修崩溃 bug、门禁绕过、`$` 注入、月末 expire、限流）
- **v1.3.x**：节点表在上、订阅在下；到期时间（探针自动取，手动优先）；节点表精简
- **v1.2.0**：订阅链接合一，按 UA 自适应
- **v1.1.0**：Clash 输出改用 ACL4SSR AdblockPlus 规则
- **v1.0.0**：正式版（EMOS `/link` 登录、后台、单链接订阅、主题切换）
