# EMOS 订阅网关 · 原型

零依赖 Node.js（Node ≥ 18），不用 `npm install`。

## 一键运行（端口自定义）

```bash
git clone https://github.com/MechanicF/emos-sub.git
cd emos-sub
# 一键启动：PORT 改成你想要的端口，ADMIN_TOKEN 是后台口令
PORT=3000 ADMIN_TOKEN=你的口令 node server.js
# 换个端口就改 PORT，比如 8080：
# PORT=8080 ADMIN_TOKEN=你的口令 node server.js
```

- 默认端口 `3000`，不设 `PORT` 就是 3000；`PORT` 只认数字，设错了会报错退出。
- 启动后：用户控制台 `http://127.0.0.1:<端口>/`，后台 `http://127.0.0.1:<端口>/admin`。
- 后台不设 `ADMIN_TOKEN` 也能启动用户控制台，但 `/admin` 会返回 503。
- 后台运行（断开终端也不停）：`PORT=3000 ADMIN_TOKEN=你的口令 nohup node server.js > server.log 2>&1 &`
- 也可以用仓库里的脚本：`PORT=3000 ADMIN_TOKEN=你的口令 ./start.sh`（脚本会检查 Node 版本、端口是否被占用，没设 `ADMIN_TOKEN` 时会提示只启动用户控制台）。

## 控制脚本（manage.sh）

服务器上部署用 `./manage.sh`，不用每次手敲命令：

```bash
./manage.sh install --port 3000 --public-url https://sub.example.com   # 安装并启动（默认 /opt/emos-sub）
./manage.sh status        # 运行状态、端口、健康检查、节点数、版本
./manage.sh port 8080     # 改端口并重启
./manage.sh autostart on  # 开机自启（systemd；无 systemd 的机器用 cron @reboot）
./manage.sh logs -f       # 看日志 / 实时跟随
./manage.sh update        # 备份配置后 git pull 最新代码并重启
./manage.sh backup        # 备份 .env + config/
./manage.sh set-token <新口令>   # 改后台口令并重启
./manage.sh set-url <域名>      # 改公开域名并重启
./manage.sh uninstall     # 先备份配置，确认后停服务并删除
```

完整命令见 `./manage.sh help`。`install` 不给 `--admin-token` 时会随机生成一个后台口令并只显示一次；配置存在安装目录的 `.env`（600 权限）。

## 运行（手动）

```bash
node server.js
# 默认 http://127.0.0.1:3000 ，改端口：PORT=3001 node server.js
# 带后台管理：ADMIN_TOKEN=你的口令 node server.js
#   （后台在 http://127.0.0.1:3000/admin；不设 ADMIN_TOKEN 时后台接口返回 503）
```

## 流程（已锁定的范围）

1. 用户登录：点控制台上的“用 EMOS 账号登录”，跳到 EMOS（`emos.best/link?uuid=…&name=emos-sub&url=…`）登录，登录完 EMOS 把浏览器跳回本站回调，服务端核验后发会话（详见“EMOS 登录（/link 跳转回调）”一节）。备用：手动粘贴 EMOS Bearer Token，或演示模式直接填萝卜数。
2. 核验：真实模式调 `https://emos.best/api/carrot/current`
   （`Authorization: Bearer <token>`）和 `/api/sign/check` 取 `user_id`；
   只有萝卜 **> 500（严格大于）** 才放行，≤ 500 返回 `ok:false, reason:carrot<=500, shortfall`，
   控制台只显示余额和还差多少，节点和订阅链接全部隐藏。
3. 控制台：显示萝卜余额、节点列表、每人专属订阅链接
   `https://你的域名/c/?token=<随机token>&client=<客户端>`（sublinkPro 风格，
   另见 `/sub/<token>`），sing-box JSON、Clash YAML、Surge、通用链接各一个，
   以及一键导入 `sing-box://import-remote-profile?url=<sing-box订阅地址>`。
   分享链接默认 24 小时有效（`SHARE_TTL_HOURS` 环境变量可改，0 = 永不过期），
   绑定 EMOS `user_id`，可刷新轮换、可停用。
4. 订阅：`GET /c/?token=<token>&client=<client>` 或 `GET /sub/:token`
   按客户端自动识别返回可用格式（见下节）。
   真实会话每 10 分钟重新核验一次萝卜，掉到 ≤ 500 就返回 403、链接失效。

## EMOS 登录（/link 跳转回调）

控制台顶部是“用 EMOS 账号登录”按钮，点一下跳到 EMOS 登录页
（`https://emos.best/link?uuid=<随机>&name=emos-sub&url=<回跳地址>`），
登录完 EMOS 把浏览器跳回网关的 `/auth/emos/callback`，回跳地址带 `?token=`，
网关在服务端用 token 调 `GET /api/sign/check` 确认本人，再调
`GET /api/carrot/current` 核萝卜，> 500 才发 session 和订阅链接。

回跳地址（callback）怎么定，优先级：

1. 环境变量 `PUBLIC_URL`（如 `https://sub.example.com`）——生产部署必须设这个。
   只写域名不写 scheme 也行，会自动补 `https://`；带路径（如 `https://sub.example.com/x`）
   启动时直接报错退出，因为那不是合法的回跳根地址；尾斜杠自动去掉。
2. 没设 `PUBLIC_URL` 时用请求 Host 头拼：反代场景认 `X-Forwarded-Proto`
   （可能是逗号列表，取第一个），否则按连接是否加密定 http/https。
   回跳只需**用户浏览器**能访问，不需要 EMOS 服务器能连进来，所以本机测试
   `http://127.0.0.1:3000/auth/emos/callback` 能用，远程用户必须配公网域名。
3. 订阅链接（`/sub/`、`/c/`）用的也是同一个根地址，和回跳地址保持一致。

自查回跳地址（不用真的登录）：`GET /api/auth/emos/login-url` 返回
`{login_url, callback, app_name}`，看 `callback` 是不是你预期的域名。
`GET /auth/emos` 每次都会生成一个新的待处理 uuid（10 分钟有效、用一次就废），
所以不要拿 `login-url` 接口返回的链接去和 `/auth/emos` 跳转的链接比 uuid，
两个是一样格式、不同的一次性值。

uuid 回传未验证：EMOS 文档没写回跳时带不带回 `uuid`。回跳带了 `uuid` 但对不上
待处理表 → `bad_state`；没带也接受（token 本身还要服务端核验，伪造回跳登不进来）。
`?token=` 是主参数，`?access_token=` 是备用别名；token 若在 URL `#hash` 里服务端
看不到，会报 `no_token`（目前没见过这种回跳）。

主登录方式，不用弹窗、不用用户手动复制 token。参考实现是真实 EMOS 客户端
somebyteorg/emos_music：登录按钮不做弹窗，直接
`window.location.href = getEmosLoginUrl(window.location.origin)`，
其中 `getEmosLoginUrl` 拼出：

```
GET https://emos.best/link?uuid=<crypto.randomUUID()>&name=<应用名>&url=<回调地址>
```

本站的实现（`server.js` 里的 `/auth/emos`、`/auth/emos/callback`）：

1. 点控制台上的“用 EMOS 账号登录” → `GET /auth/emos`：服务端生成
   `uuid = crypto.randomUUID()`，存进内存待处理登录表（10 分钟有效，
   用一次就删），然后 302 跳到
   `https://emos.best/link?uuid=<uuid>&name=emos-sub&url=<回调地址>`。
   `name` 默认 `emos-sub`，可用环境变量 `EMOS_APP_NAME` 改。
2. 用户在 EMOS 登录后，EMOS 把浏览器重定向回回调地址
   `GET /auth/emos/callback?token=<token>`（也接受 `?access_token=` 作为
   备用别名，`?token=` 优先）。token 只在 URL 查询串里——服务端看不到
   URL 的 `#hash` 部分，如果 EMOS 哪天把 token 放 hash 里，回调会报
   `no_token`，到时再处理。
3. 回调先验 `uuid`：回跳里带了 `uuid` 但和待处理表里对不上（或已过期）
   → 跳回 `/?emos_error=bad_state`，不接受；回跳里没带 `uuid` 也接受，
   因为 emos-api 的 Postman 文件里 link 登录跳转没有响应示例，
   **EMOS 是否回传 uuid 是未验证的**——token 本身下面还要服务端核验，
   伪造的回跳登不进来。
4. 服务端核验 token：`GET https://emos.best/api/sign/check`
   （`Authorization: Bearer <token>`），非 200 或 `is_sign !== true`
   → `/?emos_error=not_signed_in`。注意：sign/check 只返回
   `{is_sign, user_id}`，不返回 token；这里用它确认 token 是有效的登录。
   有个坑：如果 EMOS 的 `is_sign` 意思是“今天已签到”而不是“已登录”，
   那今天还没签到的有效用户也会被挡在这里，错误页会提示先去 EMOS
   签到；如果 Simon 实测发现有效用户被挡，把这步放宽成“只看非 200”。
5. 再调 `GET https://emos.best/api/carrot/current` 取萝卜：
   ≤ 500 → `/?emos_error=carrot_insufficient&carrot=<n>`，
   控制台显示“还差 X 到 501”，和手动登录一样；> 500 才放行。
6. 放行后走和 `POST /api/auth` 完全同一条会话签发逻辑（共用
   `issueUserSession`，不复制代码）：创建 session + 每人专属分享链接，
   发一个 HttpOnly 会话 cookie（`emos_session`，24 小时），302 跳回 `/`，
   URL 是干净的——token 不出现在跳转地址里、不渲染进页面、不写日志，
   只存在内存 session 里，和手动粘贴 token 的流程一样。
   控制台打开时如果 cookie 还有效，会自动恢复成已登录状态，不用重新点。

错误码（控制台打开时会显示中文提示，然后用 `history.replaceState`
把查询串清掉）：

| `?emos_error=` | 意思 |
|---|---|
| `no_token` | EMOS 回跳里没带 token |
| `bad_state` | 回跳的 uuid 和待处理登录对不上（或已过期 10 分钟） |
| `not_signed_in` | sign/check 未通过（token 无效，或今天还没在 EMOS 签到） |
| `carrot_insufficient` | 萝卜 ≤ 500，附带 `&carrot=<n>`，控制台算还差多少 |

备用登录（控制台登录卡片下方，标明“备用”）：手动粘贴 EMOS Bearer Token
（`POST /api/auth {token}`）和演示填萝卜数（`{carrot}`），本地测试、
或 `/link` 跳转出问题时用。演示不调 EMOS，只走内存 session。

`GET /api/auth/emos/login-url` 直接返回当前请求的登录跳转地址
`{login_url}`（测试 / 调试用，不用登录）。

## 订阅格式（sublinkPro 风格：/c/ + client 参数）

同一个分享 token，两种入口，同一套分流：

- `GET /c/?token=<token>&client=<client>`（sublinkPro 的 consume 端点）
- `GET /sub/<token>?format=<client>`（`?format=` 是 `client` 的别名；`client=` 优先）

| client 值 | 返回 | 适用客户端 |
|---|---|---|
| `clash` | Clash YAML | Clash / ClashMeta |
| `mihomo` | Clash YAML（同 clash） | mihomo |
| `sing-box` / `singbox` / `json` | sing-box JSON（mixed 入站 127.0.0.1:7890，hy2 + vless 节点 + `PROXY` selector + `AUTO` urltest，分流：私有 IP 直连，其余走 PROXY） | sing-box / Hiddify / Karing |
| `v2ray` | base64 编码的节点链接列表（hy2 + vless 原链接） | 通用订阅客户端 |
| `uri` | 纯文本节点链接，一行一条（`text/plain; charset=utf-8`），hy2 和 vless 原链接（仅 fragment 换成显示名） | Shadowrocket / Loon / Egern / Stash / Surfboard / QuanX 等 |
| `surge` | Surge 配置（`#!MANAGED-CONFIG … interval=86400` 开头） | Surge |
| `links`（= `uri`）、`b64`（= `v2ray`） | 同上 | 别名 |

不带 `client=` / `?format=` 时按 User-Agent 判断：含 `sing-box / singbox / hiddify / karing`
→ JSON；含 `clash / mihomo / clashmeta / verge` → YAML；含 `surge` → Surge；
含 `shadowrocket / nekobox / v2ray / streisand / loon / egern / stash / surfboard / quanx / quantumult`
→ hy2 链接列表；**浏览器直接打开（Mozilla + Chrome/Firefox/Safari）→ 返回 HTML
说明页，列出各格式的 `/c/` 链接，不直接给 JSON**，避免用户在浏览器里看到一堆 JSON
不知道怎么用。

注意：`loon / egern / stash / surfboard / shadowrocket / quanx` 在 sublinkPro 里是
Sub-Store 扩展输出，需要 Sub-Store sidecar 做完整格式转换；**本原型没有 Sub-Store，
对这些客户端只返回通用的 hy2 URI 列表**，不假装做了完整转换。它们大多能直接导入
hy2 链接，所以够用；要原生 Loon / QuanX 配置格式，以后再接 Sub-Store。

### hy2 链接解析

`hy2://` 和 `hysteria2://` 都接受。userinfo 只 percent-decode 一次：

- `hy2://user:pass@host:port` → 密码就是完整的 `user:pass`
- `hy2://user%3Apass@host:port` → 同样解成 `user:pass`（URL 解析器会把 `%3A` 留在
  username 里，decode 一次才还原成冒号）
- `hy2://onlypass@host:port` → 密码 `onlypass`

保留的参数：`sni`、`insecure`、`obfs`、`obfs-password`、`pinSHA256`、`ports`
（端口跳跃范围，如 `20000-50000`，Clash 输出里保留为 `ports:` 字段；sing-box
出站没有 ports 范围字段，只用首选端口，范围仍保留在 URI 输出里）、`hop-interval`。

### VLESS 支持（REALITY + VLESS Encryption）

节点配置改用通用字段 `link`（`hy2://`、`hysteria2://`、`vless://` 都接受），
`hy2_link` 仍兼容。`probe_node_id` 可为 `null`——不在探针里的节点（如自建
VLESS）流量字段全部为 `null`，不在控制台里编造数值；`Subscription-Userinfo`
求和时跳过这类节点。

`vless://<uuid>@<host>:<port>?<query>#<name>` 解析并原样保留的参数：
`encryption`、`flow`、`security`、`sni`、`fp`、`pbk`、`sid`、`type`、`path`、
`host`、`serviceName`、`mode`、`alpn`、`spx`、`pqv`、`support-x25519mlkem768`。

REALITY 字段保留规则（照 sublinkPro）：

- `support-x25519mlkem768`：`true` / `1` → `true`，`false` / `0` → `false`，
  **没写就是没写**，Clash `reality-opts` 里不出现该字段，绝不默认补一个值。
- `spx` / `pqv`：有则分别映射为 Clash `reality-opts` 的 `spider-x` /
  `mldsa65-verify`，URI 输出里原链接自带；没有就不存在，不编造。
- `pbk` / `sid`：sing-box 出站 `tls.reality.public_key` / `short_id`，
  Clash `reality-opts.public-key` / `short-id`，Surge `reality-public-key` /
  `reality-short-id`（设了 public-key 即启用 REALITY，隐含 TLS）。

各格式里的 VLESS：

| 格式 | VLESS 写法 |
|---|---|
| sing-box JSON | `type: vless` 出站：`uuid`、`flow`、`encryption`（原样保留，见下）、`tls`（`server_name` = sni，`utls.fingerprint` = fp，`reality` = pbk/sid）；`type=ws/grpc/xhttp` 时加 `transport` |
| Clash / mihomo YAML | `type: vless`，`uuid`、`network`、`tls`、`flow`、`servername`、`client-fingerprint`、`reality-opts`（含 `support-x25519mlkem768` / `spider-x` / `mldsa65-verify`，有才写）；ws 加 `ws-opts`，grpc 加 `grpc-opts` |
| URI / v2ray | 原 vless 链接（仅 fragment 换成显示名；显示名本身就是原 fragment 时等同原链接） |
| Surge | `Name = vless, host, port, username=<uuid>, flow=..., sni=..., client-fingerprint=..., reality-public-key=..., reality-short-id=..., encryption=...`（Surge 官方手册格式，iOS 6.0.0+ / Mac 6.12.0+） |

⚠️ `encryption`（VLESS Encryption，如 `mlkem768x25519plus.native.0rtt.…`）
在 sing-box JSON 里**原样保留，不静默丢弃**。但注意：上游 stock sing-box
目前还没有 `vless` 出站的 `encryption` 字段（它是 Xray 的功能，sing-box
的 sing-box-lx / TodayCore 等 fork 才支持该字段）；用 stock sing-box 导入
含 `encryption` 的节点可能被拒。带 VLESS Encryption 的节点建议用 Xray
核心客户端（v2rayN / v2rayNG / Hiddify 等）或支持该字段的 sing-box fork。
`support-x25519mlkem768` 在 sing-box 里也没有对应字段——sing-box 对支持的
uTLS 指纹自动应用混合 PQ 密钥交换，所以 sing-box 输出里不写它（Clash 里写）。

### 节点命名（NodeNameRule）

`config/nodes.json` 里可配 `name_rule`，默认 `"[$Flag] $LinkCountryName - $Name"`。
变量：`$Flag`（国家代码转旗帜 emoji，如 HK → 🇭🇰）、`$LinkCountryName`
（HK→香港、US→美国、JP→日本、SG→新加坡、KR→韩国、GB→英国，未列出的用代码本身）、
`$Name`（节点名去掉 `· ` 前的地区前缀，如 `US · Nuyek` → `Nuyek`）、`$Protocol`
（`hy2` 或 `vless`，按链接 scheme 定）、`$Index`（节点在列表里的序号，从 0 起）、`$DuplicateIndex`（同名节点
的去重序号：第一个 0、第二个 1……）。命名只用在所有订阅输出里，控制台仍显示
配置里的原名。
**例外：节点名本身已以旗帜 emoji 开头（如 vless 链接自带的 `🇭🇰 reality-1-v4`），
直接保留原名，不再按规则叠加一个旗帜**（否则会出现两个旗帜）。

### 分享链接管理

每个用户登录后得到一条分享记录（sublinkPro 风格）：

```json
{ "token": "…", "user_id": "…", "created_at": 0, "expires_at": 0,
  "enabled": true, "access_count": 0, "last_ip": "…",
  "last_user_agent": "…", "last_access_at": 0 }
```

- 默认有效期 24 小时，`SHARE_TTL_HOURS` 环境变量可改，`0` = 永不过期
  （仅指分享记录本身；登录 session 仍是 24 小时，过期要重新登录）。
- `POST /api/sub/refresh`（需 `X-Session`）：轮换 token，**旧 token 立即 403**，
  返回新的一套订阅链接；控制台有“刷新订阅链接”按钮。
- `POST /api/sub/disable`（需 `X-Session`）：停用当前分享，`/sub` 和 `/c/` 都返回
  403，直到重新登录生成新的分享记录。
- 每次拉取订阅都会记 `access_count` / `last_ip` / `last_user_agent` /
  `last_access_at`，`/api/sub-link` 返回里能看到。

订阅响应头（所有格式都有）：

```
Cache-Control: private, no-store
Subscription-Userinfo: upload=<各节点 month_tx 之和>; download=<各节点 month_rx 之和>; total=<各节点 traffic_limit 之和>; expire=<本月最后一天 23:59 的 Unix 时间戳>
profile-update-interval: 24   ← 仅 Clash / mihomo 响应
```

- `upload / download / total` 都是**节点总流量**（探针里映射节点的本月上行 / 下行 /
  限额之和），**不是每人用量**——探针给的是整台服务器网卡的流量，分不出某个用户。
- `traffic_limit` 为 0 的节点不计入 `total`；如果所有节点 `total` 都是 0，
  头里不带 `total` 字段（只发 upload / download / expire）。
- `expire` 是本月底 23:59:59（Asia/Shanghai，UTC+8），不是订阅 token 的 24 小时有效期——
  token 本身仍按登录后 24 小时过期，萝卜掉下 500 也会提前失效。

## 演示

- 演示 600：进控制台，能看到节点和订阅链接。
- 演示 400：显示未达标，还差 101（到 501），节点和链接隐藏。
- 真实登录：先在演示里跑通，再点“用 EMOS 账号登录”走 /link 跳转实测。
  手动粘贴 token 只是备用。**不要把 token 发到聊天里**，
  也不要把别人的 token 贴进来；这个原型只把 token 存在内存里，重启就丢。

## 换成自己的节点

编辑 `config/nodes.json`，每条：

```json
{ "key": "hy2-hk-01", "name": "HK · 你的节点名", "region": "HK",
  "link": "hysteria2://密码@域名:端口?sni=域名&obfs=salamander&obfs-password=xxx#名字",
  "probe_node_id": 20, "probe_name": "伤心的云" }
```

- `link`：通用链接字段，`hy2://` / `hysteria2://` / `vless://` 都接受；
  旧字段 `hy2_link` 仍可用。VLESS 示例：
  `vless://<uuid>@<host>:443?encryption=mlkem768x25519plus.native.0rtt.…&flow=xtls-rprx-vision&security=reality&sni=…&fp=chrome&pbk=…&sid=…&support-x25519mlkem768=true&type=tcp#名字`
  （网关解析成 sing-box `vless` 出站 / Clash `vless` 代理，见上节）。
- `probe_node_id`：探针 `https://1e.lol/api/nodes` 里的 `id`，用 id 别用名字（名字会改）。
  模板里是真实 id：Nuyek=2（US）、Raksmart=22（US）、伤心的云=20（HK），
  但 `hy2_link` 是占位（`demo.invalid` / `DEMO-CHANGE-ME`），连不上，必须换。
  **不在探针里的节点写 `"probe_node_id": null`**，流量字段为 `null`，不要编一个
  假的 id 或假流量。
- `name_rule`：订阅里显示的节点名规则，默认 `"[$Flag] $LinkCountryName - $Name"`，
  变量见上节；改完重启 `node server.js`。
- 模板文件：`config/templates/clash.yaml`（占位 `{{PROXIES}}` `{{GROUPS}}` `{{RULES}}`）
  和 `config/templates/singbox.json`（占位 `{{OUTBOUNDS}}`，另有 `{{PROXY_TAGS_JSON}}`
  `{{DEFAULT_TAG}}` 备用）。删掉模板文件会回退到 server.js 里的内置模板；
  改模板不用改代码，重启生效。

## 后台管理（/admin）

用户控制台（`GET /`）只能看节点、拿自己的订阅；**加节点、管分享、改设置都在后台**，
后台地址 `http://你的域名/admin`。

### 登录

启动时必须设环境变量（没有默认值，不设就进不去）：

```bash
ADMIN_TOKEN=你的口令 node server.js
```

打开 `/admin`，输入口令登录。登录后发一个随机 HttpOnly cookie 会话（24 小时，
只存内存）；API 调用也可以在请求头里带 `X-Admin-Token: <ADMIN_TOKEN 或登录后的会话 id>`。
没有设置 `ADMIN_TOKEN` 时，所有 `/api/admin/*` 接口返回 **503**（含明确提示），
`/admin` 页面也会显示“后台未配置”。

口令只用来登录，不会写进任何文件、日志或聊天记录；也不要把它放进 URL 里。

### 添加节点（步骤）

1. 打开后台 → 节点区，粘贴节点链接（`hy2://` / `hysteria2://` / `vless://`）。
2. 点 **解析预览**：先看到解析出来的协议、服务器、端口、sni、名字等，确认无误再保存，
   不要盲目保存（解析失败会直接报错，不会入库）。
3. 填显示名（可空，默认用链接里的名字）、地区代码（如 `JP`）、探针 id（可空，
   不在探针里的节点留空，流量显示为 `null`）。
4. 点 **保存节点**：立刻写入 `config/nodes.json`（先写临时文件再重命名，旧版本保留为
   `config/nodes.json.bak`），订阅输出立即生效，**不用重启**。

其他节点操作：**编辑**（改链接会重新解析；只改名字/地区/探针 id 不动链接）、
**删除**（需确认，订阅里立刻去掉）、**↑ / ↓ 排序**（订阅里的节点顺序跟着走）。

节点也可以继续直接改 `config/nodes.json`（改完重启生效）；后台改和手改不要同时进行，
以后台最后一次保存为准。

### 分享链接管理

列表里每条分享显示：token（只显示前 6 位 + `…`）、user_id、创建/到期时间、
启用状态、访问次数、最后 IP / 访问时间。操作：

- **刷新**：换一个新 token，旧链接立即失效；
- **停用 / 启用**：停用后订阅返回 403，用户重新登录才能恢复；
- **吊销**：直接删除这条分享记录；
- **全部吊销**：所有订阅立即失效，所有用户都要重新登录。

注意：分享是用户 EMOS 登录后自动创建的（每人一条，绑定 `user_id`），
**后台不能凭空给某人发一条分享**——没有 user_id 就没有分享。

### 设置

后台设置区可改（保存后立即生效，不用重启）：

| 设置 | 默认 | 说明 |
|---|---|---|
| 萝卜门槛 `carrot_threshold` | 500 | 萝卜必须 `>` 此值才放行 |
| 分享有效期 `share_ttl_hours` | 24 | 小时，0 = 永不过期 |
| 节点命名规则 `name_rule` | `[$Flag] $LinkCountryName - $Name` | 见“节点命名”一节 |
| 探针缓存 `probe_cache_seconds` | 30 | 秒 |

设置存在 `config/settings.json`（后台第一次保存时创建）。
**优先级：启动时环境变量（`CARROT_THRESHOLD` / `SHARE_TTL_HOURS` /
`PROBE_CACHE_SECONDS`）> `config/settings.json` > 默认值。**
也就是说，后台改完立即生效，但如果启动时设了对应的环境变量，下次重启会以
环境变量为准（保存时会提示这一点）。`name_rule` 没有环境变量，只看 settings.json
（没有 settings.json 时看 nodes.json 里的 `name_rule`）。

## 流量字段怎么来的（只做节点总流量）

网关每 30 秒缓存一次 `GET https://1e.lol/api/nodes`，只返回映射过的节点，
不返回未映射的服务器、价格、到期日。

- 实时：`metrics.net_rx / net_tx`（B/s）
- 今日：`day_rx + day_tx`
- 本月：`month_used`，限额 `traffic_limit`，剩余 = 限额 − 已用，
  `traffic_mode` 是 `sum`（上下行加一起算），重置日 `traffic_reset_day` 为 1 号
- CPU / 运行时间：`metrics.cpu / uptime`

**限制（按设计）：探针流量是整台服务器网卡的流量，不是单条节点的流量，
也不是某个用户的用量。** 同一台机器上还跑面板、WebDAV、系统更新，全算在一起；
一台机器挂两个节点也分不开。只想要“节点还剩多少流量、现在堵不堵”，这条路够了；
想要每人用量，需要面板 / hy2 鉴权计流，不在这个原型里。
不在探针里的节点（`probe_node_id: null`）流量全部为 `null`。

## 临时测试说明（VLESS / hy2 混用测试，2026-11-26）

Simon 给了两条真实测试链接（一条 VLESS REALITY、一条 hy2），只用**临时配置**
跑过测试，**没有写进 `config/nodes.json`**——仓库里的 nodes.json 仍是
`demo.invalid` / `DEMO-CHANGE-ME` 占位。测试链接的 uuid / 密码 / pbk /
encryption 密钥也没有写进任何永久文件或日志，汇报时只给前 4 位打码。

## 刻意没从 sublinkPro 抄的东西（超出 EMOS 门禁范围）

- **完整面板 / 用户系统**：sublinkPro 是机场订阅系统，有后台、用户、套餐；
  这里只有一个站长后台（`ADMIN_TOKEN` 登录，见“后台管理”一节），用来加节点、
  管分享、改设置；用户身份就是 EMOS `user_id`，不另外建一套账号。
- **测速、机场导入、链式代理、TG 机器人**：和门禁无关，不做。
- **Sub-Store sidecar**：只在需要原生 Loon / QuanX / Stash 等扩展格式时才值得接；
  现在对这些客户端返回通用 hy2 URI 列表，够用。
- **X-HWID 设备数限制**：sublinkPro 里是 opt-in 的；这里不做——订阅 token
  本来就按 EMOS `user_id` 一人一条，刷新即失效、停用即失效，已经能管住
  转发；以后要限设备再加（在分享记录里记 HWID 白名单）。
- **每人用量统计**：按锁定范围不做。`Subscription-Userinfo` 和控制台显示的
  都是节点总流量（探针整台服务器的流量），不是个人用量。

## 未做 / 待确认

- EMOS `/link` 登录跳转已接好（`GET /auth/emos` → EMOS 登录 →
  `GET /auth/emos/callback`，见“EMOS 登录”一节），但**还没用 Simon 自己的
  EMOS 号端到端实测过**：重点确认两点，一是 EMOS 回跳到底带不带 `uuid`
  回来（文档没写，代码里两种情况都处理了），二是 `sign/check` 的 `is_sign`
  是“已登录”还是“今天已签到”（如果有效用户被挡，见 README 里那节的说明，
  放宽成只看非 200）。手动粘贴 token 和演示模式仍可作为备用。
- Token / 会话 / 分享记录只存内存：重启失效，没有数据库；生产要换成 SQLite + 落盘 + HTTPS。
- 订阅地址现在是 `http://host/sub/...`：生产必须上 HTTPS 域名（sing-box 客户端、
  尤其是 iOS，要求订阅走 HTTPS），并配反代；**反代必须原样透传 User-Agent**，
  否则订阅分流会按错格式返回，也不要跨设备缓存订阅响应
  （响应头已是 `Cache-Control: private, no-store`）。
- 探针拉取失败时：网关用一份标注为 `sample-fallback` 的示例快照兜底，
  前端会显示“示例数据，非实时”，不要把它当成真实流量。

## 接口一览

- `GET /` 控制台页面（主登录是“用 EMOS 账号登录”，备用是手动粘贴 token / 演示；回跳错误 `?emos_error=` 会在页面上显示中文提示）
- `GET /auth/emos` → 302 跳到 EMOS `/link?uuid=…&name=emos-sub&url=…` 登录
- `GET /auth/emos/callback` → EMOS 登录回跳：验 token（sign/check + carrot），放行则发 HttpOnly 会话 cookie 并 302 回 `/`；失败则 302 回 `/?emos_error=…`
- `GET /api/auth/emos/login-url` → `{login_url}`（当前请求的登录跳转地址，调试用）
- `POST /api/auth` `{token}` 或 `{carrot}` → `{ok, gated, carrot, session, sub_token, sub_url, sub_urls, share, import_url}`（备用登录）
- `GET /api/nodes` 头 `X-Session: <session>` 或回调发的 HttpOnly cookie → 节点 + 探针总流量
- `GET /api/sub-link` 头 `X-Session` → `{sub_url, sub_urls, import_url, share}`
- `POST /api/sub/refresh` 头 `X-Session` → 轮换分享 token，旧 token 立即失效
- `POST /api/sub/disable` 头 `X-Session` → 停用分享，重新登录才能恢复
- `GET /c/?token=<token>&client=<client>` → sublinkPro 风格，按 client / UA 分流
  （`clash | mihomo | sing-box | json | v2ray | uri | surge`，`links`=`uri`，`b64`=`v2ray`）
- `GET /sub/:token` → 同上，`?format=` 是 `client` 的别名；浏览器 → HTML 说明页；
  token 无效 / 停用 / 过期 / 萝卜掉下 500 → 403；响应头带节点总流量的
  `Subscription-Userinfo`，`Cache-Control: private, no-store`，Clash 另带
  `profile-update-interval: 24`
- `GET /health` → `{ok, nodes}`
- 后台（需 `ADMIN_TOKEN`，见“后台管理”一节）：
  - `GET /admin` → 后台页面（未登录显示登录框；未设 `ADMIN_TOKEN` 显示未配置）
  - `POST /api/admin/login` `{token}` → HttpOnly cookie 会话；`POST /api/admin/logout`
  - `GET /api/admin/nodes` → 节点列表（含解析出的协议/服务器/端口/探针状态）
  - `POST /api/admin/nodes/parse` `{link}` → 解析预览（不保存）
  - `POST /api/admin/nodes` `{link, name, region, probe_node_id, key?}` → 添加节点并写入 `nodes.json`
  - `PUT /api/admin/nodes/:key` `{name, region, probe_node_id, link}` → 编辑节点
  - `DELETE /api/admin/nodes/:key` → 删除节点
  - `POST /api/admin/nodes/reorder` `{keys:[...]}` → 调整节点顺序
  - `GET /api/admin/shares` → 分享列表（token 只显示前 6 位）
  - `POST /api/admin/shares/:id/refresh` → 轮换 token；`POST /api/admin/shares/:id/enable|disable`；
    `DELETE /api/admin/shares/:id` → 吊销；`POST /api/admin/shares/revoke-all` → 全部吊销
  - `GET /api/admin/settings` / `PUT /api/admin/settings` → 查看 / 修改设置（写 `settings.json`）
  - `GET /api/admin/health` → 节点数、分享数、会话数、探针状态
