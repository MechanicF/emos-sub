# EMOS 订阅网关

EMOS 登录核验萝卜余额，超过 500 才能进入控制台、领取专属订阅链接。节点流量取自 1e.lol 探针的整机总流量，不做每人用量统计。

当前版本：**v1.0.0**（2026-11-26）

零依赖 Node.js（Node ≥ 18），不用 `npm install`。

## 快速开始

```bash
git clone https://github.com/MechanicF/emos-sub.git
cd emos-sub
PORT=3000 ADMIN_TOKEN=你的口令 node server.js
```

- 控制台：`http://127.0.0.1:3000/`；后台：`http://127.0.0.1:3000/admin`。
- 不设 `ADMIN_TOKEN` 也能启动控制台，但后台接口返回 503，`/admin` 会显示未配置提示和重新启动的命令。
- 后台运行：`PORT=3000 ADMIN_TOKEN=你的口令 nohup node server.js > server.log 2>&1 &`，或用仓库里的 `./start.sh`（会检查 Node 版本和端口占用）。

服务器部署建议用 `./manage.sh`（见下）。

## 更新

```bash
cd emos-sub            # 或安装目录 /opt/emos-sub
./manage.sh update     # 备份配置 → 拉取最新代码 → 重启
./manage.sh status     # 查看程序版本（v1.0.0）、git 提交、运行状态、端口、健康检查
```

`update` 只更新代码文件（`server.js`、`manage.sh`、`start.sh`、模板），`.env` 和 `config/`（节点、设置）原样保留，更新前自动备份到 `backups/`。

旧版 `manage.sh` 的 `update` 用 `git pull`，安装目录没设 upstream 时会报 `There is no tracking information` 而失败。遇到这句报错，先用下面这行把 `manage.sh` 换成新版，再跑 `update`：

```bash
curl -fsSL https://raw.githubusercontent.com/MechanicF/emos-sub/main/manage.sh -o manage.sh && chmod +x manage.sh && ./manage.sh update
```

## 控制脚本（manage.sh）

```bash
./manage.sh install --port 3000 --public-url https://sub.example.com   # 安装并启动（默认 /opt/emos-sub）
./manage.sh status        # 运行状态、端口、健康检查、节点数、版本
./manage.sh start|stop|restart
./manage.sh port 8080     # 改端口并重启
./manage.sh autostart on|off   # 开机自启（systemd；无 systemd 的机器用 cron @reboot）
./manage.sh logs [-f]     # 看日志 / 实时跟随
./manage.sh update        # 备份配置后更新代码并重启
./manage.sh backup        # 备份 .env + config/
./manage.sh config        # 查看当前配置（口令只显示前 4 位）
./manage.sh set-token <新口令>   # 改后台口令并重启
./manage.sh set-url <域名>      # 改公开域名并重启
./manage.sh health        # 健康检查
./manage.sh uninstall     # 先备份配置，确认后停服务并删除
```

完整命令见 `./manage.sh help`。`install` 不给 `--admin-token` 时会随机生成后台口令并只显示一次；配置存在安装目录的 `.env`（600 权限）。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口，只认数字 |
| `ADMIN_TOKEN` | （必填，无默认） | 后台口令；未设则后台接口返回 503 |
| `PUBLIC_URL` | （空） | 公开域名，如 `https://sub.example.com`；订阅链接和 EMOS 回调地址都以它为准。生产必须配 HTTPS |
| `CARROT_THRESHOLD` | 500 | 萝卜门槛，须严格大于此值 |
| `SHARE_TTL_HOURS` | 24 | 分享有效期（小时），0 = 永不过期 |
| `PROBE_CACHE_SECONDS` | 30 | 探针缓存（秒） |
| `EMOS_APP_NAME` | emos-sub | EMOS `/link` 登录页显示的应用名 |
| `DEMO_ENABLED` | （空） | 仅本地测试用：设为 `1` 才允许演示登录（`POST /api/auth {carrot}`）；正式部署保持关闭 |

后台“设置”页可改门槛、有效期、命名规则、探针缓存，写 `settings.json` 立即生效。优先级：启动时环境变量 > `settings.json` > 默认值。

节点放在 `config/nodes.json`（每条：协议链接 + 地区 + 对应的探针 id，可空）。后台添加/编辑节点会原子写入该文件并留 `.bak`，立即生效，不用重启。

## 使用

**用户（控制台 `/`）：**

1. 点“用 EMOS 账号登录”，跳到 EMOS（emos.best）登录，登录完自动跳回本站；服务端验 token（`sign/check` + `carrot/current`），萝卜 > 500 放行。
2. 控制台显示节点总流量（探针）和三条订阅链接：sing-box / Clash / Surge，另有通用链接（hy2 / vless 列表）和一键导入 sing-box。
3. 订阅链接每人专属，绑定 EMOS `user_id`，可刷新（旧链接立即失效）或停用。登录后登录卡片自动隐藏，右上角“退出登录”结束会话。
4. 备用登录：手动粘贴 EMOS Bearer Token。

**站长（后台 `/admin`）：**

输入 `ADMIN_TOKEN` 登录。管理节点（粘贴链接 → 解析预览 → 保存）、分享链接（查看、刷新、停用/启用、吊销、全部吊销）、设置。后台不能凭空给某人发分享链接，分享只由用户登录后自动创建。

**界面：** 深色（默认）/ 浅色两套主题，右上角按钮切换，选择存在浏览器 `localStorage`，控制台和后台共用，刷新后保留。单文件内联样式，无外部字体/CDN。

## 订阅格式

消费地址（sublinkPro 风格）：`GET /c/?token=<shareToken>&client=<client>`，`client` 按 User-Agent 自动识别，也可强制指定；`/sub/:token?format=` 同样可用。浏览器打开订阅地址会显示说明页。

| client | 格式 |
| --- | --- |
| `sing-box` / `json` | sing-box JSON |
| `clash` / `mihomo` | Clash YAML |
| `surge` | Surge 配置 |
| `v2ray` / `b64` | base64 订阅 |
| `uri` / `links` | hy2 / vless 链接列表 |

支持 `hy2://`、`hysteria2://`、`vless://`（含 REALITY 与 VLESS Encryption）。命名规则默认 `[$Flag] $LinkCountryName - $Name`，重名自动加序号。

响应头带节点总流量的 `Subscription-Userinfo`（到期时间为本月底 23:59），`Cache-Control: private, no-store`；Clash 另带 `profile-update-interval: 24`。反代须透传 User-Agent。

**流量说明：** 探针返回的是整台服务器的网卡总流量，无法拆分到单条节点或单人；控制台只做节点总流量，不做每人用量。探针拉取失败时用内置样本值兜底并在页面注明。

**VLESS 注意：** `encryption=mlkem768x25519plus...` 是 Xray 功能，原版 sing-box 无此字段可能导入失败，建议用 Xray 核心客户端。

## 接口一览

- `GET /` 控制台；`GET /admin` 后台页面
- `GET /auth/emos` → 302 到 EMOS `/link` 登录；`GET /auth/emos/callback` → 回调核验后发 HttpOnly 会话 cookie，失败跳 `/?emos_error=...`
- `GET /api/auth/emos/login-url` → 当前登录跳转地址（调试用）
- `POST /api/auth` `{token}` → 登录；`POST /api/logout` → 退出
- `GET /api/nodes`（`X-Session` 或 cookie）→ 节点 + 探针总流量
- `GET /api/sub-link` → 当前分享的订阅地址；`POST /api/sub/refresh` → 轮换；`POST /api/sub/disable` → 停用
- `GET /c/?token=&client=`、`GET /sub/:token` → 订阅内容
- `GET /health` → `{ok, version, nodes}`
- 后台：`POST /api/admin/login`、`POST /api/admin/logout`、`GET /api/admin/health`、`GET|POST|PUT|DELETE /api/admin/nodes`（含 `/parse`、`/reorder`）、`GET /api/admin/shares`（刷新/停用/启用/吊销/全部吊销）、`GET|PUT /api/admin/settings`

## 版本历史

### v1.0.0 — 2026-11-26（正式版）

- EMOS `/link` 跳转登录 + 回调核验（萝卜 > 500），备用 Token 登录；每人专属订阅链接，可刷新/吊销
- 后台管理：节点增删改、分享管理、设置，改动立即生效
- 订阅按客户端分流（sublinkPro 风格 `/c/?token=&client=`），hy2 / VLESS（含 REALITY）解析
- 节点总流量来自 1e.lol 探针；深色/浅色主题切换
- `manage.sh` 控制脚本：安装、卸载、改端口、状态、开机自启、日志、更新、备份
- 修复：页面脚本因模板字面量转义失效导致后台空白、前台登录后无变化；旧版 `update` 的 `git pull` 失败问题

## 开发注意

- **模板字面量转义**：`server.js` 里两个整页 HTML 是 JS 模板字面量，页面 JS 里的 `\'`、`\"`、`\n` 会被模板字面量吃掉反斜杠，导致发给浏览器的脚本语法错误、整页 JS 瘫痪。页面 JS 需要反斜杠转义时，源码里必须写双反斜杠（`\\'`、`\\"`、`\\n`）。
- **回归测试**：`node test/check-pages.js` 会启动真服务，拉 `/` 和 `/admin` 的实发页面，把全部 `<script>` 拿出来 `node --check`。不要只 `node --check server.js`，服务端能过不代表浏览器收到的脚本能过。改完页面 JS 必须跑它。
- 演示登录默认关闭，仅本地测试用 `DEMO_ENABLED=1` 开启。
- 会话与分享只存内存，重启失效；生产如需持久化，改用 SQLite 落盘，并配好 HTTPS 与反代透传 User-Agent。
