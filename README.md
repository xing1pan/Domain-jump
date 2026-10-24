# cf-domain-jump

一个跑在 Cloudflare Workers 上的**多域名测速跳转页**。

用户访问这个页面后，浏览器会并发探测环境变量里配置的每一个域名，挑出**对你当前网络延迟最低**的那个，然后自动跳过去。也可以给域名配优先级，让某个域名在「没那么慢」的前提下优先胜出，见[优先级](#优先级让某个域名优先被选中)一节。

界面上**只显示加载动画和进度条，不展示任何域名**——用户看到的就是一个简洁的品牌开屏页，测速在后台静默完成。

---

## 工作原理

```
用户浏览器 ──► Worker 跳转页 (go.example.com)
                  │
                  │ ① 返回 HTML（logo + 加载环 + 进度条）
                  │    目标域名列表内联在脚本里，不渲染到界面
                  ▼
              页面 JS 并发探测（用户看不到）
                  ├── hk.example.com/__probe  →  41 ms  ✅ 最快
                  ├── sg.example.com/__probe  →  88 ms
                  └── us.example.com/__probe  →  173 ms
                  │
                  │ ② 进度条走满 → 加载环变绿勾 → 写入 localStorage 缓存
                  ▼
              location.replace('https://hk.example.com/...')
```

**为什么测速必须在浏览器端做：** Worker 运行在 Cloudflare 的边缘节点上。如果让 Worker 去测各域名延迟，测到的是「边缘机房 → 你的服务器」的速度，和真实用户所在位置毫无关系。只有浏览器发起的探测，才真正反映**用户当前网络**到各节点的可达延迟。

**测量方式：** 对每个域名发起 `fetch(url, { mode: 'no-cors', cache: 'no-store' })`，用 `performance.now()` 计时。跨域探测走 `no-cors` 不读响应体，只测「往返建立连接 + 拿到首字节」的时间，因此目标域名不需要配置 CORS。

**抗抖动：** 每个域名先跑 1 次预热（建立 DNS / TCP / TLS），再跑 `MEASURE_ROUNDS` 轮正式测量，**取多轮中的最小值**作为成绩——最小值代表该节点在你的网络下「最快能到多少」，比平均值更能反映真实可达速度。页面还会 `<link rel="preconnect">` 提前和各域名建连，让正式测量更接近纯 RTT。

**界面反馈：** 用户能看到的只有三样东西——旋转加载环、进度条（按已完成探测步数推进）、以及结束时的绿色对勾。全程不出现任何域名。

> ⚠️ **关于「不暴露域名」的边界：** 域名列表内联在页面 HTML 里（浏览器必须拿到它才能探测）。所以界面上看不到，但**查看网页源代码仍能看到**。这是客户端测速架构的必然结果，任何前端混淆都只是障眼法。如果这也不能接受，只能改成服务端按 IP 粗选（用 Cloudflare 的 `request.cf.colo` / `continent` 就近跳转），代价是精度大幅下降。

---

## 目录结构

```
cf-domain-jump/
├── wrangler.toml             # Worker 配置（变量不写这里，走控制台）
├── .dev.vars.example         # 本地调试变量模板，复制为 .dev.vars 使用
├── package.json
├── src/
│   ├── index.js              # Worker 入口（路由：跳转页 / 探测端点 / 调试接口）
│   ├── config.js             # 环境变量解析与容错
│   └── page.js               # 跳转页 HTML/CSS/JS（含客户端测速逻辑）
├── scripts/
│   ├── build-preview.mjs     # 生成纯静态界面预览
│   ├── browser.mjs           # 无头浏览器加载（playwright-core + 本机 Chrome）
│   ├── shots.mjs             # 给预览页各状态截图
│   └── e2e.mjs               # 真实浏览器验证「测速 → 选最快 → 跳转」全链路
├── test/config.test.js       # 配置解析单元测试
└── preview/
    ├── index.html            # 生成的预览（演示模式，不联网）
    └── shot-*.png            # 预览截图
```

---

## 快速开始

```bash
npm install
npx wrangler login
npm run dev        # 本地调试 http://localhost:8787
npm run deploy     # 部署到 Cloudflare
```

部署后，变量在 **Cloudflare 控制台 → Workers 和 Pages → cf-domain-jump → 设置 → 变量和密钥 → 添加变量** 里配置，保存即生效，不用重新部署。

> `wrangler.toml` 里的 `[vars]` 已整段注释，并加了 `keep_vars = true`。
> 这两件事配合起来才能保证：以后每次 `wrangler deploy` 都不会用空的绑定列表覆盖掉你在控制台配的变量。

本地调试时，把变量写进项目根目录的 `.dev.vars`（可参考 `.dev.vars.example`，该文件已被 `.gitignore` 忽略）：

```bash
cp .dev.vars.example .dev.vars
# 然后编辑 .dev.vars，填上 DOMAINS
npm run dev
```

---

## 环境变量

**配置位置：Cloudflare 控制台 → Workers 和 Pages → 选中 Worker → 设置 → 变量和密钥 → 添加变量。**
只有 `DOMAINS` 是必填的，其余不配就走默认值。

所有值都按**字符串**解析（布尔写 `"true"`/`"false"`），非法值会自动回落到默认值，不会让 Worker 报错。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOMAINS` | *(必填)* | 目标域名列表，见下方语法 |
| `DOMAINS_JSON` | — | JSON 形式的高级配置，**优先级高于 `DOMAINS`** |
| `SELECTION_MODE` | `speed` | 选择策略：`speed` / `priority` / `strict`，见「优先级」一节 |
| `PRIORITY_TOLERANCE` | `30` | `priority` 模式下优先节点最多允许比最快的慢多少（百分比） |
| `PROBE_PATH` | `/__probe` | 探测路径 |
| `PROBE_FALLBACK_PATH` | `/favicon.ico` | 主探测路径不可用时的备用路径，设 `off` 关闭 |
| `MEASURE_ROUNDS` | `3` | 每域名正式测量轮数（1–10，不含预热） |
| `MEASURE_TIMEOUT` | `2500` | 单次探测超时（毫秒，200–15000） |
| `MEASURE_GAP` | `100` | 轮次间隔（毫秒） |
| `CACHE_TTL` | `300` | 测速结果缓存秒数；命中缓存则直接跳转，不再测速 |
| `PRESERVE_PATH` | `true` | 跳转时保留原路径、查询参数与 hash |
| `RESPECT_SAVE_DATA` | `true` | 用户开启省流模式时跳过测速，直接用兜底线路 |
| `AUTO_REDIRECT` | `true` | 测速完成后自动跳转；设为 `false` 则显示「立即前往」按钮 |
| `RESULT_DELAY` | `900` | 出结果后停留多少毫秒再跳（让用户看到绿色对勾） |
| `MAX_WAIT` | `6000` | 测速整体最长等待毫秒数，超时就用已知最好结果/兜底线路 |
| `FALLBACK_INDEX` | `auto` | 全部节点都探测失败时用哪个目标。`auto` = 取优先级最高的，也可填固定下标 `0`/`1`/`2` |
| `ALLOW_QUERY_TARGET` | `true` | 允许 `?__to=N` 手动强制指定节点 |
| `SHOW_TARGET` | `false` | 是否在页面上显示最终选中的域名。**默认 false，只跳转不暴露** |
| `BRAND_NAME` | `天才程序员` | 页面主标题 |
| `SUBTITLE` | `正在检测最快线路…` | 副标题 / 提示语 |
| `LOGO_URL` | *(模板内置 logo)* | 页面 logo 图片地址，加载失败会自动回落到内置图标 |
| `FOOTER_TEXT` | *(空)* | 页脚文案 |
| `ACCENT_COLOR` | `#2563eb` | 主题色（加载环、进度条） |
| `DEBUG` | `false` | 是否开放 `/__targets.json` 调试接口。**默认关闭，避免暴露域名清单** |
| `DEMO` | `false` | 演示模式：不真实探测、不跳转（用于预览 UI） |

兼容别名：`DOMAINS` 也可写成 `TARGET_DOMAINS` / `TARGETS` / `ORIGINS`。

### `DOMAINS` 语法

逗号或换行分隔，每条支持用 `|` 追加可选属性：

```
https://hk.example.com
hk.example.com                                 # 省略协议时自动补 https://
https://sg.example.com|/__probe|新加坡节点       # |探测路径|展示名
https://us.example.com|/__probe|美西节点|10      # 再追加 |优先级
https://cn.example.com/app                      # 支持带路径前缀
```

也可用 JSON 写：

```json
[{ "url": "https://a.com", "probe": "/p", "label": "甲", "priority": 10 }, "https://b.com"]
```

---

## 优先级：让某个域名优先被选中

默认是**纯比速度**——谁快跳谁。但很多时候业务上希望「优先走主站，除非它慢到不可接受」。给域名加上第 4 段优先级（数字越大越优先，默认 `0`，可为负数），再选一个策略即可。

```toml
DOMAINS = """
https://main.example.com|/__probe|主站|10
https://backup.example.com|/__probe|备用|0
https://free.example.com|/__probe|免费线路|-5
"""
SELECTION_MODE = "priority"
```

### 三种策略

| `SELECTION_MODE` | 行为 | 适合场景 |
| --- | --- | --- |
| `speed`（默认） | 完全按延迟，`priority` 字段被忽略 | 只想让用户最快打开 |
| `priority` | 最高优先级的**可达**节点胜；但它若比全局最快慢超过 `PRIORITY_TOLERANCE`%，就让位给最快的 | 想主站优先，但不能牺牲体验 |
| `strict` | 最高优先级的**可达**节点胜，完全不看延迟 | 计费/合规要求必须走指定线路 |

### 举几个例子

假设甲（优先级 10）、乙（优先级 0），`PRIORITY_TOLERANCE = 30`：

| 实测延迟 | 策略 | 结果 | 原因 |
| --- | --- | --- | --- |
| 甲 30ms，乙 25ms | `priority` | **甲** | 甲只慢 20%，在 30% 容忍度内 |
| 甲 190ms，乙 25ms | `priority` | **乙** | 甲慢了 660%，超出容忍度，让位 |
| 甲 190ms，乙 25ms | `strict` | **甲** | 严格模式不看速度 |
| 甲 超时，乙 25ms | `priority` / `strict` | **乙** | 甲不可达，降级到下一优先级层 |

几个细节：

- **同优先级内部仍然比速度。** 给三个域名都设 `priority = 0`，行为就退化成纯比速度。
- **降级是分层的。** 高优先级层只要有一个可达，就绝不会跳到低优先级层，哪怕低层快得多（`priority` 模式下仍受容忍度约束）。
- **页面文案会自动说实话。** 选中的是最快节点时说「已找到最快线路」，选中的是优先级更高但略慢的节点时说「已为你选好线路」。
- **`PRIORITY_TOLERANCE = 0`** 等价于「只有优先节点正好最快时才选它」，配合 `strict` 用没意义。
- **全部不可达时**，`FALLBACK_INDEX = "auto"`（默认）会跳到优先级最高的那个。

---

## ⚠️ 关键一步：在目标域名上提供探测端点

**探测端点必须存在于每个目标域名上**，否则该域名会被判定为「超时」而永不入选。

这个端点只需要**极小、不可缓存、允许跨域计时**。本项目的 Worker 自带 `/__probe`，
所以最省事的做法是：**把同一份 Worker 部署到每一个目标域名上**，它自己就能应答探测。

### Cloudflare Worker / Pages

```toml
# wrangler.toml
routes = [{ pattern = "hk.example.com", custom_domain = true }]
```

### Nginx

```nginx
location = /__probe {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Timing-Allow-Origin "*" always;
    add_header Cache-Control "no-store" always;
    access_log off;
    default_type text/plain;
    return 200 "ok";
}
```

### Vercel（`api/__probe.js`）

```js
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Timing-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('ok');
}
```

> 如果某个域名实在加不了探测端点，可以把 `PROBE_FALLBACK_PATH` 留成 `/favicon.ico`——
> 只要该域名有 favicon 就能被探测到（精度略低于专用端点，但足以区分快慢）。

---

## 调试参数

在跳转页 URL 后追加：

| 参数 | 作用 |
| --- | --- |
| `?__measure=1` | 忽略缓存，强制重新测速 |
| `?__to=2` | 跳过测速，强制跳到第 3 个目标（需 `ALLOW_QUERY_TARGET=true`） |
| `?__noredirect=1` | 只显示测速结果，不自动跳转 |

内置接口：

| 路径 | 说明 |
| --- | --- |
| `/__probe` | 探测端点（同时也是健康检查） |
| `/__health` | 返回 `ok` |
| `/__targets.json` | 返回解析后的目标域名与配置。**需设置 `DEBUG=true` 才开放**，否则返回 404 |
| `/favicon.ico` | 返回极小的 SVG 图标 |

---

## 设计取舍与注意事项

- **优先级是「软约束」还是「硬约束」，由你选。** `priority` 模式给速度留了让步空间（默认 30%），`strict` 模式则完全牺牲速度。选 `strict` 前要想清楚：优先节点哪怕 2 秒才响应，用户也会被送过去。
- **同优先级内部仍然比速度。** 所以「全部 priority = 0」的行为和升级前完全一致，老配置不需要改。
- **域名列表藏在界面之下，但仍在页面源码里。** 浏览器必须拿到域名才能探测，所以「用户看不到」只能做到界面层面。查看源代码 / Network 面板仍能看到清单。真要彻底隐藏，只能改成服务端按 IP 就近跳转（用 `request.cf.colo` / `continent`），代价是精度从「实测延迟」降级为「地理猜测」。
- **界面只给三样反馈：** 旋转加载环、按探测步数推进的进度条、结束时的绿色对勾。全程不出现任何域名——包括成功时也只说「已找到最快线路」。
- **`MAX_WAIT` 是防呆阀。** 某个节点如果一直卡到 `MEASURE_TIMEOUT`，最坏情况会拖慢整体；超过 `MAX_WAIT` 就直接用已经测到的最好结果（或 `FALLBACK_INDEX`）跳走，不让用户干等。
- **防死循环。** 如果测出来的最快节点就是你当前访问的域名（例如 Worker 同时部署在多个目标域名上），页面会显示「你当前访问的已是最快节点」并停止跳转。另外用 `sessionStorage` 记了一个跳转次数，连续跳转 2 次后强制停下并显示「立即前往」按钮。
- **缓存会掩盖网络变化。** `CACHE_TTL` 默认 300 秒。用户换网络（比如从 Wi-Fi 切到 4G）后 5 分钟内仍会走缓存结果，这是速度与准确性的权衡；想更实时可以调小或设为 `0`。
- **`performance.now()` 有精度上限。** 出于安全考虑，浏览器会把计时器精度限制在 0.1–2 ms，所以 40 ms 级别的结果有 1–2 ms 误差。对「选节点」这个用途完全够用。
- **并行 vs 串行。** 各域名并行探测，同一域名内多轮串行，避免带宽争抢影响公平性。探测请求体积极小（几十字节），带宽占用可忽略。
- **暗色模式。** 跟随系统 `prefers-color-scheme` 自动切换。暗色下 logo 的深色部分会糊进背景，因此自动垫了一层白色圆形底板。
- **页面本身不缓存**（`Cache-Control: no-store`），并且带 `noindex` 防止被搜索引擎收录跳转页。
- **未配置 `DOMAINS` 时会返回 500 和一个带说明的提示页**，不会静默失败。

---

## 本地开发与测试

```bash
npm test            # 配置解析单元测试（21 项）
npm run preview     # 生成 preview/index.html，用浏览器打开可查看界面与动效
npm run dev         # wrangler 本地调试
```

`preview/index.html` 是**演示模式**产物：不会发起真实网络请求，也不会真的跳转，
只会模拟一组延迟数据把整个交互动效跑一遍，方便调样式。

另外两个基于无头浏览器的验证脚本（需要 `npm i`，会用本机 Chrome）：

```bash
npm run shots   # 给预览页的几个状态截图 -> preview/shot-*.png
npm run e2e     # 真实浏览器跑通「测速 → 选节点 → 跳转」全链路并断言结果
```

`npm run e2e` 会本地起一个 http 服务吐出 Worker 渲染的真实页面，拦截三个目标域名的探测请求
注入不同延迟（含「不可达」），逐个场景断言最终落地域名。目前覆盖 7 个场景：

```
✅ speed 默认：纯比速度                         → b（25ms 最快）
✅ priority：优先节点慢太多 → 让位              → b
✅ priority：优先节点只慢一点点 → 仍选它        → a
✅ priority：优先节点不可达 → 降级到下一层      → b
✅ strict：无视速度，只认优先级                 → a（600ms 也认）
✅ strict：优先节点不可达 → 次优先              → b
✅ 全部不可达 → 兜底到优先级最高的              → a

7/7 场景通过
```
