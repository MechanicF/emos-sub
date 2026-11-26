# EMOS 订阅网关

EMOS 登录核验萝卜余额，**严格大于门槛（默认 500，可在后台改）**才能进入控制台、领取每人专属的订阅链接。节点流量取自 1e.lol 探针的整机总流量，不做每人用量统计。

当前版本：**v1.5.2**（2026-11-26）

零依赖 Node.js（Node ≥ 18），不用 `npm install`。单文件 `server.js` + `config/` + `manage.sh`。

## 快速开始

```bash
git clone https://github.com/MechanicF/emos-sub.git
cd emos-sub
PORT=3000 ADMIN_TOKEN=你的口令 node server.js
```

- 控制台：`http://127.0.0.1:3000/`；后台：`http://127.0.0.1:3000/admin`。
- 不设 `ADMIN_TOKEN` 也能启动控制台，但后台接口返回 503，`/admin` 会显示未配置提示和重新启动的命令。
- 后台运行：`PORT=3000 ADMIN_TOKEN=你的口令 nohup node server.js > server.log 2>&1 &`，或用仓库里的 `./start.sh`（会检查 Node 版本和端口占用）。

服务器部署建议用 `./manage.sh`（见下一节）。

## 部署与更新（manage.sh）

```bash
./manage.sh install --port 3000 --public-url https://sub.example.com   # 安装并启动（默认 /opt/emos-sub）
./manage.sh status        # 运行状态、端口、健康检查、节点数、版本
./manage.sh start|stop|restart
./manage.sh port 8080     # 改端口并重启
./manage.sh autostart on|off   # 开机自启（systemd；无 systemd 的机器用 cron @reboot）
./manage.sh logs [-f]     # 看日志 / 实时跟随
./manage.sh update        # 备份配置 → 拉取最新代码 → 重启
./manage.sh backup        # 备份 .env + config/
./manage.sh config        # 查看当前配置（口令只显示前 4 位）
./manage.sh set-token <新口令>   # 改后台口令并重启
./manage.sh set-url <域名>      # 改公开域名并重启
./manage.sh health        # 健康检查
./manage.sh uninstall     # 先备份配置，确认后停服务并删除
```

完整命令见 `./manage.sh help`。`install` 不给 `--admin-token` 时会随机生成后台口令并只显示一次；配置存在安装目录的 `.env`（600 权限）。

**更新**：`./manage.sh update` 只更新代码文件（`server.js`、`manage.sh`、`start.sh`、模板、`test/`），`.env` 和 `config/`（节点、设置）原样保留，更新前自动备份到 `backups/`（只留最近 10 个）。

旧版 `manage.sh` 的 `update` 用 `git pull`，安装目录没设 upstream 时会报 `There is no tracking information` 而失败。遇到这句报错，先用下面这行把 `manage.sh` 换成新版，再跑 `update`：

```bash
curl -fsSL https://raw.githubusercontent.com/MechanicF/emos-sub/main/manage.sh -o manage.sh && chmod +x manage.sh && ./manage.sh update
```

## 怎么用

### 用户：控制台 `/`

1. 点“用 EMOS 账号登录”，跳到 EMOS（emos.best）登录，登录完自动跳回本站；服务端验 token（`sign/check` + `carrot/current`），萝卜 > 门槛放行。备用登录：手动粘贴 EMOS Bearer Token。
2. 控制台从上到下是：**统计行**（萝卜 / 节点 / 订阅访问）→ **节点表** → **订阅卡**（一条订阅链接 + 一键导入 + 刷新/停用/退出登录）。登录后登录卡片自动隐藏。
3. **节点表**各列：节点、到期、状态、今日、本月已用 / 限额。“到期”列显示到期日和剩余天数，14 天内和已过期标红，没填显示 —。到期时间默认自动取探针的 `expires_at`，手动填的优先覆盖。每台的流量就是探针上那台服务器的实际流量（整机网卡总流量）。
4. 订阅链接每人专属，绑定 EMOS `user_id`，可刷新（旧链接立即失效）或停用。

### 站长：后台 `/admin`

输入 `ADMIN_TOKEN` 登录。管理节点（粘贴链接 → 解析预览 → 保存）、分享链接（查看、刷新、停用/启用、吊销、全部吊销）、设置。后台不能凭空给某人发分享链接，分享只由用户登录后自动创建。后台节点表能看到每个节点的探针对应关系（控制台不显示）。

### 界面

深色（默认）/ 浅色两套主题，右上角按钮切换，选择存在浏览器 `localStorage`（`emos-theme`），控制台和后台共用，刷新后保留。单文件内联样式，无外部字体/CDN。

**手机端**（≤640px）：节点表不再是横向滚动的宽表格，每台节点变成一张卡片，名字在上，下面按“到期 / 状态 / 今日 / 本月已用·限额”分行带标签显示，数字不再截断或换行；顶栏收进一行（标题缩小、版本号隐藏、主题按钮靠右）；统计卡 2×2 排列。桌面端仍是表格。

## 订阅格式

每人只有一条订阅链接（sublinkPro 风格）：`GET /c/?token=<shareToken>`，不带 `client` 参数，服务端按请求方的 User-Agent 自动返回对应格式；浏览器打开它显示说明页（同样只有一条链接）。想手动指定格式可以加 `?client=<格式>`（`/sub/:token?format=<格式>` 同样可用）。

| 客户端（按 UA 识别） | 返回格式 |
| --- | --- |
| FlClash、Clash、mihomo、Clash Verge | Clash YAML |
| sing-box、Hiddify、Karing | sing-box JSON |
| Surge | Surge 配置 |
| Shadowrocket、Loon、Egern、Stash、Quantumult、NekoBox 等 | hy2 / vless 链接列表 |
| 其他 / 未知 UA | 链接列表 |

`?client=` 可取值：`clash` / `mihomo`、`sing-box` / `json`、`surge`、`v2ray` / `b64`（base64 订阅）、`uri` / `links`（链接列表）。

支持 `hy2://`、`hysteria2://`、`vless://`（含 REALITY 与 VLESS Encryption）。命名规则默认 `[$Flag] $LinkCountryName - $Name`，重名自动加序号。

**Clash 分流（ACL4SSR AdblockPlus）：** Clash 输出用的就是 ACL4SSR 的 `ACL4SSR_AdblockPlus.ini` 那套规则。注意这个 `.ini` 本身不是 Clash YAML 模板，是 Sub-Store/ACL 定义（`ruleset=<分组>,<规则列表>` + `custom_proxy_group=`）；服务端按它合并生成 Clash 配置：15 个规则列表（去广告、应用净化、微软、苹果、国外媒体、电报、国内直连等）变成 `rule-providers`（客户端从 `raw.githubusercontent.com/ACL4SSR/ACL4SSR` 拉取，每天更新一次），分组沿用 `.ini` 里的名字和顺序（🚀 节点选择、♻️ 自动选择、🌍 国外媒体、📲 电报信息、Ⓜ️ 微软服务、🍎 苹果服务、🎯 全球直连、🛑 全球拦截、🍃 应用净化、🆎 AdBlock、🐟 漏网之鱼），最后 `GEOIP,CN` 直连、`MATCH` 走漏网之鱼。模板文件在 `config/templates/clash.yaml`（占位 `{{PROXIES}}` `{{GROUPS}}` `{{RULE_PROVIDERS}}` `{{RULES}}`），删掉会回退到 `server.js` 里的内置模板。

**FlClash 没节点时先查这三点：** ① 必须用控制台里那条唯一的订阅链接（`/c/?token=...`，不带 `client` 参数，FlClash 的 UA 会自动识别为 Clash）；不要用 `?format=singbox` 的 JSON 链接或通用链接；② 链接里的 token 有效期 24 小时，过期或在控制台点了“刷新订阅链接”后旧链接立即失效，重新登录拿新的；③ 服务器端口要在防火墙放行，浏览器能打开订阅地址并看到 YAML 才算通。已用 mihomo v1.19.34（FlClash 同款核心）`mihomo -t` 验过实发 Clash 配置：2 个节点（VLESS REALITY + hy2）+ 11 个分组 + 15 个 rule-providers + 17 条规则全部通过；`GEOIP,CN` 需要客户端自带 GeoIP 数据库（FlClash 自带）。

响应头带节点总流量的 `Subscription-Userinfo`（到期时间为本月底 23:59），`Cache-Control: private, no-store`；Clash 另带 `profile-update-interval: 24`。反代须透传 User-Agent。

**流量说明：** 探针返回的是整台服务器的网卡总流量，无法拆分到单条节点或单人；控制台只做节点总流量，不做每人用量。探针拉取失败时用内置样本值兜底并在页面注明。

**VLESS 注意：** `encryption=mlkem768x25519plus...` 是 Xray 功能，原版 sing-box 无此字段可能导入失败，建议用 Xray 核心客户端。

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
| `TRUST_PROXY` | auto | 是否信任 `X-Forwarded-For` 取客户端 IP（用于限流/记录）：`auto` 仅当来源是可信代理地址（本机/内网/IPv6 本地段）时信任——反代部署行为不变、公网直连不再被伪造 XFF 绕过限流；`1` 总是信任（旧行为）；`0` 永不信任（直连加固） |
| `PROBE_URL` | https://1e.lol/api/nodes | 探针接口地址；一般不用改，便于自建/测试 |
| `DEMO_ENABLED` | （空） | 仅本地测试用：设为 `1` 才允许演示登录（`POST /api/auth {carrot}`）；正式部署保持关闭 |

后台“设置”页可改门槛、有效期、命名规则、探针缓存，写 `settings.json` 立即生效。优先级：启动时环境变量 > `settings.json` > 默认值。

## 本地加固（v1.5.2，第三方审查后合入）

以下为 v1.5.2 合入的加固（另一位 AI 审查后提出，NEP 逐行核对过 diff、跑过回归才合进来），不改功能：

- **XFF 伪造防护**：`clientIp()` 默认只在来源为本机/内网（`TRUST_PROXY=auto`）时采信 `X-Forwarded-For`，公网直连不再能被伪造 XFF 绕过按 IP 限流。反代部署（nginx 在本机/内网）行为完全不变；需要旧行为可设 `TRUST_PROXY=1`。
- **探针失败负缓存 + 合并并发**：探针挂掉后失败结果缓存 60 秒（不再每个请求都等满 10 秒超时）；缓存过期瞬间的并发请求合并为一次上游拉取。输出/标记（`probe_source`）不变。
- **后台登录失败计数清扫**：每小时连同其它过期数据一起清理，避免长期运行的缓慢内存增长。
- **页面预渲染**：控制台/后台的 `{{VERSION}}` 在启动时替换一次，不再每请求做整页字符串替换（输出字节不变）。

节点放在 `config/nodes.json`（每条：协议链接 + 地区 + 对应的探针 id，可空 + 到期时间 `expires_at`，如 `"2027-11-14"`，可空）。到期时间默认自动取探针的 `expires_at`（1e.lol 探针每台都有，个别没填的显示 —）；手动填的 `expires_at` 会覆盖探针的值。后台添加/编辑节点会原子写入该文件并留 `.bak`，立即生效，不用重启；后台节点表“到期”列同样显示有效到期日，来自探针的标“探针”。

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

## 安全说明（防破解）

- **后台口令防爆破**：同一 IP 连续 5 次输错口令后锁定 15 分钟（第 6 次起返回 429），输对一次清零。口令比较用 `timingSafeEqual`（登录接口和 `X-Admin-Token` 头都一样），不怕计时攻击。口令建议只用字母数字。
- **登录/订阅限流**：`/api/auth` 和 EMOS 跳转每 IP 10 分钟 30 次（每次登录要调两次 EMOS 接口，不限流会被当成 EMOS 查询代理）；订阅端点 `/c/`、`/sub/` 每 IP 每分钟 120 次。订阅 token 本身是 128 位随机数，猜不出来。
- **萝卜掉下去立即吊销**：订阅每次取用时最多 10 分钟核验一次萝卜；一旦核验发现萝卜 ≤ 门槛（或 EMOS token 失效 401/403），整个会话和订阅链接当场删除，用户必须重新登录。EMOS 临时挂掉（网络错误/5xx）时不断订阅，只推迟 60 秒再核验。
- **重复登录吊销旧会话**：每人同时只留一个有效登录，新登录会把旧会话和旧订阅链接一起废掉（“每人一条订阅链接”就是这么保证的）。
- **刷新订阅也要重新核验**：`/api/sub/refresh` 在核验窗口过期时会先查一次萝卜，萝卜不够或 token 失效就拒绝；所以“停用/吊销”不是摆设，绕不过刷新。
- **后台“停用/吊销”不是封号**：它只杀掉当前这条链接；只要用户萝卜还 > 门槛，重新登录就能拿到新链接。想彻底不让某人用，只能把他萝卜门槛之外的资格断掉（EMOS 侧）或改门槛。
- **防崩溃**：请求处理全是 `await` 的，任何一个请求出错都只返回 500，不会打崩整个进程；畸形 cookie、坏订阅模板、Host 注入都经过回归测试验证（`test/check-pages.js`）。
- **Cookie**：`emos_session` / `admin_session` 都是 HttpOnly + SameSite=Lax；公开地址是 https 时自动加 Secure。当前 IP 直连 http 的部署没有 Secure 可加，上域名 + HTTPS 后自动生效。
- **安全头**：所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`，HTML 页面另带 `X-Frame-Options: DENY`（防点击劫持）。
- **会话清扫**：过期会话/分享/后台会话每小时清扫一次，不会一直占内存；待处理的 EMOS 登录 uuid 最多留 1000 条。
- **Host 头校验**：Host 只允许域名/端口字符，拼不出订阅链接里的注入；订阅说明页的转义也覆盖了引号。
- **节点名/密码里的 `$`**：命名规则和订阅模板的占位替换都用函数式替换，名字或密码里有 `$&`、`$$` 等也不会串改内容（以前会把 `$&` 换成占位符本身，悄悄改坏名字和密码）。

## 开发注意

- **模板字面量转义**：`server.js` 里两个整页 HTML 是 JS 模板字面量，页面 JS 里的 `\'`、`\"`、`\n` 会被模板字面量吃掉反斜杠，导致发给浏览器的脚本语法错误、整页 JS 瘫痪。页面 JS 需要反斜杠转义时，源码里必须写双反斜杠（`\\'`、`\\"`、`\\n`）。另注意：工具输出里看到的 `\"` 可能是显示层转义，真凭据以字节为准（`ord()` / `repr()` 核对）。
- **回归测试**：`node test/check-pages.js` 会启动真服务，拉 `/` 和 `/admin` 的实发页面，把全部 `<script>` 拿出来 `node --check`；还会走演示登录拿 Clash / sing-box 订阅，检查 Clash 里有 proxies、rule-providers、RULE-SET，sing-box 能解析出 outbounds；另有单元测试（月末 expire、端口、REALITY）和副本服测试（限流、崩溃抵抗、Host 注入、`$` 名字）与 mock EMOS 吊销流程，共 39 项。不要只 `node --check server.js`，服务端能过不代表浏览器收到的脚本能过。改完页面 JS 或订阅输出必须跑它。Clash 配置另可用 mihomo 校验：`mihomo -t -f <导出的 clash.yaml>`（含 `GEOIP,CN` 的完整配置需要客户端自带 GeoIP 数据库才能过 `-t`）。
- 演示登录默认关闭，仅本地测试用 `DEMO_ENABLED=1` 开启。
- **会话与分享落盘**：登录会话、订阅分享、后台会话都存在 `config/state.json`（0600 权限，git 忽略，`manage.sh backup` 会一起备份），重启/更新后订阅地址照常能用，不用重新登录。文件里有活的 EMOS token，绝不要提交、不要发给别人。登录、刷新、停用、吊销、退出时立即写盘；订阅访问次数/最后 IP 每 30 秒批量写一次；正在进行的 EMOS 登录（10 分钟有效）和限流计数不落盘，重启后重新登录即可。

## 版本历史

### v1.5.2 — 2026-11-26

- **合入第三方审查的加固**：另一位 AI 审了 v1.5.1 的代码，NEP 逐行核对 diff 后合进来（只合了 `server.js`、`README.md`、`test/check-pages.js`；对方 zip 里带的服务器真配置 `nodes.json`/`settings.json`/`state.json` 一个字都没进仓库）。内容：(1) XFF 伪造防护——`clientIp()` 默认只在来源为本机/内网（`TRUST_PROXY=auto`）时采信 `X-Forwarded-For`，公网直连不再能被伪造 XFF 绕过按 IP 限流；反代部署（nginx 在本机/内网）行为完全不变；需要旧行为可设 `TRUST_PROXY=1`；(2) 探针失败负缓存——之前 v1.4.0 的注释说失败也缓存，实际有旧数据那支没更新缓存时间，探针一挂每个请求都等满 10 秒超时；现在失败结果缓存 60 秒（`PROBE_FAIL_CACHE_MS`），另加 singleflight 合并缓存过期瞬间的并发拉取；(3) 每小时清扫连同清理过期的后台登录失败计数；(4) 控制台/后台的 `{{VERSION}}` 启动时替换一次；(5) `PROBE_URL` 可配环境变量。回归测试新增 9 项（7 个 XFF 单测 + 探针负缓存端到端），60 项全过。注意：若以后前面挂了公网 IP 的反代/CDN 再靠 XFF 区分用户，需显式设 `TRUST_PROXY=1`，否则所有用户会共用一个限流桶

### v1.5.1 — 2026-11-26

- **修了后台改门槛后前端不变的 bug**：控制台各处门槛都是写死的 500（副标题、未达标卡片、统计标签、已达标文案、未达标提示、/link 回跳报错），后台改成 1500 后，1000 萝卜的用户被拦下，提示却显示“还差 0 才到 501 (> 500)”——那句里的 501/500 是写死的，`Math.max(0, 501-1000)` 被截成 0；手动登录那路也一样，未达标提示写死 501，短缺数却是服务端按新门槛算的。现在：新增公开接口 `GET /api/public-settings`（无需登录，门槛本来就显示在副标题里），控制台加载时取回 live 门槛填进所有展示位；手动登录的未达标提示直接用服务端返回的 `threshold`；/link 回跳地址里带上 `&threshold=`，报错页优先用它；吊销报错和订阅说明页里的 500 也都改成 live 门槛；服务端 `reason` 从写死的 `carrot<=500` 改成 `carrot_insufficient`。回归测试新增：后台改门槛到 1500 → 公开接口、未达标响应（threshold 1500 / shortfall 501）都跟上、控制台不再含写死的 501/500 → 恢复 500；另有 /link 回跳端到端（取 uuid → 回调 → 302 地址带 `carrot=1000&threshold=1500`）。51 项全过（44 旧 + 7 新），无头浏览器实测两张截图：手动登录未达标卡显示“还差 501 才到 1501 (> 1500)”、副标题变成“萝卜 > 1500”，回跳报错显示“萝卜不够：当前 1000，还差 501 才到 1501 (> 1500)”

### v1.5.0 — 2026-11-26

- **修了更新后订阅失效的问题**：之前会话和订阅分享只存在内存里，`manage.sh update` 一重启服务，所有订阅地址立刻失效、所有人都要重新登录。现在登录会话、订阅分享、后台会话都落盘到 `config/state.json`（0600 权限，git 忽略，备份会一起带走），启动时读回，过期或无主的分享丢弃；更新/重启后订阅地址照常能用。登录、刷新、停用、吊销、退出时立即写盘；订阅访问次数/最后 IP 每 30 秒批量写一次；停止服务时（SIGTERM/SIGINT）先刷盘再退出。正在进行的 EMOS 登录和限流计数不落盘。回归测试新增重启实测（登录 → 杀进程 → 重启 → 旧订阅、旧会话、旧后台会话全都还能用）+ 状态文件 0600 权限和 git 忽略断言，44 项全过

### v1.4.5 — 2026-11-26

- 去掉控制台顶栏下面的说明文字（“萝卜 > 500 才能进入控制台；节点流量为探针整机总流量。”），标题下面直接就是统计行；标题里的副标题（“EMOS 登录 · 萝卜 > 500 解锁订阅”）保留

### v1.4.4 — 2026-11-26

- 拿掉控制台顶部的“总流量”统计卡（统计行回到萝卜 / 节点 / 订阅访问三张）。每台节点的流量仍在节点表里（今日 / 本月已用）；订阅响应头的 `Subscription-Userinfo` 也照旧，只算已配节点的本月流量之和——实测核对过，订阅头的数就是 `nodes.json` 里那几台节点的和，不是整个探针（演示配置 3 台：已用 119 GB / 限额 10 TB；整个探针 20 台是已用 384 GB / 限额 23.88 TB）

### v1.4.3 — 2026-11-26

- 总流量现在是各节点实际流量之和：顶部统计多了一张“总流量”卡，显示全部节点本月已用流量的合计（探针的真实值相加，不在探针里的节点不计入；全部没有流量数据时显示 —）。注意探针的 `total_rx/total_tx` 就是本月累计值，和“本月已用”是同一个数，所以没给每台单独加一列，避免重复
- 手机端重做：节点表在窄屏（≤640px）不再是横向滚动的宽表格，每台节点变成一张卡片，名字在上，下面按“到期 / 状态 / 今日 / 本月已用·限额”分行显示，数字不再被截断或换行；顶栏在一行内排布（标题缩小、版本号隐藏、主题按钮靠右），统计卡 2×2 排列。桌面端表格不变

### v1.4.2 — 2026-11-26

- 前端视觉精修（控制台 + 后台 + 订阅说明页）：底色更深、极光更丰富（加了紫色光斑）、整页罩了一层很淡的网格；顶部多了一条 2px 渐变细线；卡片圆角 20px、内边距更大、加了顶部高光；标题字号 23px 加粗；统计数字 26px、标签前多了渐变圆点；表格行高更松、表头字号更小；订阅链接那一行改成渐变底色描边，更醒目；输入框底色更透、聚焦光圈更柔；流量条改细（6px）。功能和文案一个没动

### v1.4.1 — 2026-11-26

- 控制台节点表不再显示节点说明和探针对应关系：名字下面那行“地区 · 探针：名字 #id”没了，表格上方的来源说明也没了，标题也由“节点 · 总流量（探针）”简化为“节点 · 总流量”。后台不受影响，站长在 /admin 里照样能看到探针对应关系

### v1.4.0 — 2026-11-26（全量复核 + 防破解）

- **修了两个会打崩服务的 bug**：请求处理漏了 `await`，任何异步错误都变成未处理异常直接杀进程（畸形 cookie、坏模板都已实测打崩过）；现已全量 `await` + 兜底日志，单请求出错只返回 500
- **修了门禁绕过**：萝卜掉下 500 后，旧代码因先更新核验时间再判断，白送 10 分钟订阅；现在核验失败当场删除会话和分享，且刷新订阅也要重新核验
- **重复登录吊销旧会话**：每人只留一个有效登录和一条订阅链接
- **限流**：后台登录 5 次失败锁 IP 15 分钟；`/api/auth`、EMOS 跳转、订阅端点按 IP 限流
- **修了月末 expire 算错**：服务器时区是 UTC 时，每月 30/31 号 16:30 UTC 之后 expire 会算成已过去的月底；现按上海时间算
- **修了订阅模板 `$` 注入**：节点名/密码含 `$&` 会被模板占位替换串改（实测 `A$&B` 变成了 `A{{PROXIES}}B`）；命名规则和模板替换全部改函数式
- 探针挂掉时加负缓存（不再每次请求等满 10 秒超时）；`/c` 不带斜杠也能用；端口校验（0 和 >65535 的链接直接拒绝）；REALITY 没 pbk 的链接解析时拒绝（以前静默降级成普通 TLS）；畸形 cookie 跳过不报错；超大请求体直接拒绝；Host 非法字符回退到本机地址
- `manage.sh`：systemd 服务改用 node 绝对路径（nvm 装的 node 以前找不到）；备份只留最近 10 个；`.env` 写值加引号（口令含空格/`$`/引号不再写坏）；`update` 也更新 `test/`
- 测试：`test/check-pages.js` 增加单元测试（月末 expire、端口、REALITY）和回归测试（mock EMOS 吊销流程、限流、崩溃抵抗、Host 注入、`$` 名字），共 35 项全过；`EMOS_BASE` / `CARROT_RECHECK_MS` 可用环境变量覆盖，方便测试

### v1.3.2 — 2026-11-26

- 控制台节点表精简：去掉 CPU / 运行时间列和状态里的实时上下行速率，只留节点、到期、状态、今日、本月已用/限额（监控细节看探针即可）

### v1.3.1 — 2026-11-26

- 到期时间改从探针自动读取：1e.lol 探针每台节点都带 `expires_at`，控制台和后台没手动填的节点直接显示探针的到期日；手动填的 `expires_at` 仍优先覆盖探针值（探针没给的显示 —）
- “一键导入 sing-box”按钮改名“一键导入”（点的还是 sing-box 的 `sing-box://import-remote-profile` 导入链接，FlClash 等请复制订阅链接粘贴）

### v1.3.0 — 2026-11-26

- 控制台布局调整：节点信息（总流量表）在上，订阅相关在下
- 节点增加到期时间：`nodes.json` 每条可填 `expires_at`（`YYYY-MM-DD`），后台添加/编辑节点时有“到期时间”输入框；控制台“到期”列显示到期日和剩余天数，14 天内和已过期标红，未填显示 —

### v1.2.0 — 2026-11-26

- 订阅链接整合成一条：控制台和浏览器说明页都只显示 `/c/?token=...`，服务端按 User-Agent 自动识别客户端（FlClash / Clash Verge → Clash，sing-box / Hiddify / Karing → JSON，Surge → Surge 配置，Shadowrocket、Loon 等 → 链接列表）；`?client=` / `?format=` 仍可手动指定格式
- 回归测试增加 UA 嗅探检查（FlClash UA → Clash YAML，sing-box UA → JSON，浏览器 UA → 说明页）

### v1.1.0 — 2026-11-26

- Clash 输出改用 ACL4SSR AdblockPlus 规则（15 个 rule-providers + 11 个分组 + `GEOIP,CN` + `MATCH`，分组与 `.ini` 同名同序）
- 修复 FlClash 加订阅没节点的问题：实发 Clash 配置已用 mihomo v1.19.34 `mihomo -t` 校验通过（VLESS REALITY + hy2 两种节点形状）；README 增加 FlClash 排查三点
- 回归测试 `test/check-pages.js` 增加订阅结构检查（Clash 含 proxies / rule-providers / RULE-SET，sing-box 能解析）

### v1.0.0 — 2026-11-26（正式版）

- EMOS `/link` 跳转登录 + 回调核验（萝卜 > 500），备用 Token 登录；每人专属订阅链接，可刷新/吊销
- 后台管理：节点增删改、分享管理、设置，改动立即生效
- 订阅按客户端分流（sublinkPro 风格 `/c/?token=&client=`），hy2 / VLESS（含 REALITY）解析
- 节点总流量来自 1e.lol 探针；深色/浅色主题切换
- `manage.sh` 控制脚本：安装、卸载、改端口、状态、开机自启、日志、更新、备份
- 修复：页面脚本因模板字面量转义失效导致后台空白、前台登录后无变化；旧版 `update` 的 `git pull` 失败问题
