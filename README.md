# EMOS 订阅网关

EMOS 登录核验萝卜余额，**严格大于门槛（默认 500，可在后台改）**才能进控制台、领取每人专属的订阅链接。节点流量取自 1e.lol 探针的整机总流量，不做每人用量统计。

当前版本：**v1.5.3**（2026-11-26）

零依赖 Node.js（Node ≥ 18），不用 `npm install`。单文件 `server.js` + `config/` + `manage.sh`。

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

`update` 只更新代码文件，`.env` 和 `config/`（节点、设置）原样保留，更新前自动备份到 `backups/`（只留最近 10 个）。完整命令见 `./manage.sh help`。旧版 `manage.sh` 的 `update` 若报 `There is no tracking information`，先用 `curl -fsSL https://raw.githubusercontent.com/MechanicF/emos-sub/main/manage.sh -o manage.sh && chmod +x manage.sh && ./manage.sh update` 换新版再跑。

## 怎么用

### 用户：控制台 `/`

点“用 EMOS 账号登录”，跳到 EMOS 登录，回来后服务端验 token，萝卜 > 门槛放行。备用登录：手动粘贴 EMOS Bearer Token。

控制台从上到下：统计行（萝卜 / 节点 / 订阅访问）→ 节点表 → 订阅卡（一条订阅链接 + 一键导入 + 刷新/停用/退出登录）。

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

**FlClash 没节点先查三点：**① 用控制台那条唯一的订阅链接（不带 `client` 参数）；② token 有效期 24 小时，过期或刷新后旧链接失效，重新登录；③ 服务器端口放行，浏览器能打开订阅地址看到 YAML 才算通。

响应头带 `Subscription-Userinfo`（节点总流量，到期本月底 23:59），`Cache-Control: private, no-store`；Clash 另带 `profile-update-interval: 24`。反代须透传 User-Agent。探针拉取失败时用内置样本值兜底并注明。VLESS Encryption（`mlkem768x25519plus`）是 Xray 功能，原版 sing-box 可能导入失败，建议用 Xray 核心客户端。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `ADMIN_TOKEN` | （必填） | 后台口令；未设后台返回 503 |
| `PUBLIC_URL` | （空） | 公开域名，如 `https://sub.example.com`；订阅链接和 EMOS 回调都以它为准，生产配 HTTPS |
| `CARROT_THRESHOLD` | 500 | 萝卜门槛，须严格大于此值 |
| `SHARE_TTL_HOURS` | 24 | 分享有效期（小时），0 = 永不过期 |
| `PROBE_CACHE_SECONDS` | 30 | 探针缓存（秒） |
| `EMOS_APP_NAME` | emos-sub | EMOS `/link` 登录页显示的应用名 |
| `TRUST_PROXY` | auto | 是否信任 `X-Forwarded-For`：`auto` 只信任本机/内网来源；`1` 总是信任；`0` 永不信任 |
| `PROBE_URL` | https://1e.lol/api/nodes | 探针接口地址 |
| `DEMO_ENABLED` | （空） | 仅测试：设 `1` 才允许演示登录 |

后台“设置”页可改门槛、有效期、命名规则、探针缓存，写 `settings.json` 立即生效。优先级：环境变量 > `settings.json` > 默认值。

节点放 `config/nodes.json`（协议链接 + 地区 + 探针 id + 到期 `expires_at`，可空）。后台增删改节点原子写入并留 `.bak`，立即生效，不用重启。

## 安全

- 后台口令：同一 IP 连错 5 次锁 15 分钟（第 6 次起 429），输对清零；比较用 `timingSafeEqual`。
- 限流：`/api/auth` 和 EMOS 跳转每 IP 10 分钟 30 次；订阅端点每 IP 每分钟 120 次。
- 萝卜掉下门槛立即吊销：订阅取用时最多 10 分钟核验一次；核验失败当场删会话和链接；EMOS 临时挂掉不断订阅，只推迟 60 秒再核验。
- 每人一个有效登录，新登录吊销旧会话和旧链接；刷新订阅也要先核验萝卜。
- 会话和分享落盘到 `config/state.json`（0600，git 忽略，随备份走），重启/更新后订阅照常用；文件里有活的 EMOS token，别提交、别外发。
- Cookie 都是 HttpOnly + SameSite=Lax，https 下自动加 Secure；响应带 nosniff / no-referrer / DENY 安全头。

## 接口

- `GET /` 控制台；`GET /admin` 后台
- `GET /auth/emos` → EMOS `/link` 登录；`GET /auth/emos/callback` → 回调核验
- `POST /api/auth` 登录；`POST /api/logout` 退出
- `GET /api/nodes` 节点 + 探针流量；`GET /api/sub-link` 当前订阅地址；`POST /api/sub/refresh` 轮换；`POST /api/sub/disable` 停用
- `GET /c/?token=&client=`、`GET /sub/:token` 订阅内容；`GET /health` 健康检查；`GET /api/public-settings` 当前门槛
- 后台：`POST /api/admin/login|logout`、`GET /api/admin/health`、`/api/admin/nodes`（增删改 + `/parse`、`/reorder`）、`/api/admin/shares`（刷新/停用/启用/吊销/全部吊销）、`/api/admin/settings`

## 测试

```bash
node test/check-pages.js   # 启动真服务跑回归（60 项）：实发页面脚本校验、订阅结构、限流、吊销流程、重启落盘等
```

## 版本历史

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
