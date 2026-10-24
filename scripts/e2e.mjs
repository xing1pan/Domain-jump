/**
 * 端到端验证：用真实浏览器跑「测速 → 选节点 → 跳转」的完整链路。
 *
 * 本地起一个 http 服务吐出 Worker 渲染的真实页面（非演示模式），
 * 再用 playwright 拦截对三个目标域名的探测请求，注入不同延迟，
 * 最后断言页面确实跳到了预期域名。
 *
 * 覆盖：speed / priority / strict 三种选择策略，以及全部不可达时的兜底。
 *
 *   node scripts/e2e.mjs
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch } from './browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: worker } = await import('../src/index.js');

const HOSTS = {
  a: 'a.example.com',
  b: 'b.example.com',
  c: 'c.example.com',
};
const LABELS = { a: '甲', b: '乙', c: '丙' };

/**
 * 每个场景：延迟（null = 不可达）、优先级、额外的环境变量、期望落地的 key
 */
const SCENARIOS = [
  {
    name: 'speed 默认：纯比速度',
    lat: { a: 190, b: 25, c: 120 },
    prio: { a: 0, b: 0, c: 0 },
    env: {},
    expect: 'b',
    why: '没设优先级，最快者胜',
  },
  {
    name: 'priority：优先节点慢太多 → 让位',
    lat: { a: 190, b: 25, c: 120 },
    prio: { a: 10, b: 0, c: 0 },
    env: { SELECTION_MODE: 'priority', PRIORITY_TOLERANCE: '30' },
    expect: 'b',
    why: '甲 190ms 比最快 25ms 慢 660%，超出 30% 容忍度',
  },
  {
    name: 'priority：优先节点只慢一点点 → 仍选它',
    lat: { a: 30, b: 25, c: 120 },
    prio: { a: 10, b: 0, c: 0 },
    env: { SELECTION_MODE: 'priority', PRIORITY_TOLERANCE: '30' },
    expect: 'a',
    why: '甲 30ms 比最快 25ms 只慢 20%，在容忍度内',
  },
  {
    name: 'priority：优先节点不可达 → 降级到下一层',
    lat: { a: null, b: 25, c: 120 },
    prio: { a: 10, b: 0, c: 0 },
    env: { SELECTION_MODE: 'priority' },
    expect: 'b',
    why: '甲探测超时，只能在剩余节点里取最快的',
  },
  {
    name: 'strict：无视速度，只认优先级',
    lat: { a: 600, b: 25, c: 120 },
    prio: { a: 10, b: 0, c: 0 },
    env: { SELECTION_MODE: 'strict' },
    expect: 'a',
    why: '严格模式只要可达就选优先级最高的',
  },
  {
    name: 'strict：优先节点不可达 → 次优先',
    lat: { a: null, b: 120, c: 25 },
    prio: { a: 10, b: 5, c: 0 },
    env: { SELECTION_MODE: 'strict' },
    expect: 'b',
    why: '甲挂了，乙优先级高于丙，即使丙更快',
  },
  {
    name: '全部不可达 → 兜底到优先级最高的',
    lat: { a: null, b: null, c: null },
    prio: { a: 7, b: 0, c: 0 },
    env: { SELECTION_MODE: 'priority' },
    expect: 'a',
    why: 'FALLBACK_INDEX 未指定，取优先级最高的甲',
  },
];

function domainsFor(prio) {
  return ['a', 'b', 'c']
    .map((k) => `https://${HOSTS[k]}|/__probe|${LABELS[k]}|${prio[k]}`)
    .join(', ');
}

function baseEnv(scenario) {
  return {
    DOMAINS: domainsFor(scenario.prio),
    MEASURE_ROUNDS: '2',
    MEASURE_GAP: '20',
    RESULT_DELAY: '250',
    CACHE_TTL: '0',
    MAX_WAIT: '8000',
    BRAND_NAME: '天才程序员',
    ...scenario.env,
  };
}

/* ---------------- 本地 http 服务：吐出 Worker 渲染的真实页面 ---------------- */
let currentEnv = {};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const r = await worker.fetch(new Request(url.href, { method: req.method }), currentEnv);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const browser = await launch();
const results = [];

for (const sc of SCENARIOS) {
  currentEnv = baseEnv(sc);

  const ctx = await browser.newContext({ viewport: { width: 760, height: 620 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  let landed = null;

  await page.route(/^https:\/\/[a-z]\.example\.com(\/.*)?$/, async (route) => {
    const u = new URL(route.request().url());
    const key = Object.keys(HOSTS).find((k) => HOSTS[k] === u.hostname);

    if (u.pathname === '/__probe' || u.pathname === '/favicon.ico') {
      const ms = sc.lat[key];
      if (ms === null || ms === undefined) return route.abort();
      await new Promise((r) => setTimeout(r, ms));
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
        body: 'ok',
      });
    }

    landed = key;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>LANDED</h1>' });
  });

  await page.goto(pageUrl);

  // 抓一下出结果那一刻的提示语。
  // 用固定间隔轮询（默认的 rAF 轮询在 headless 下会被节流，容易错过短暂的 done 状态）
  let tip = '';
  try {
    await page.waitForFunction(() => document.body.classList.contains('done'), {
      timeout: 8000,
      polling: 30,
    });
    tip = await page.textContent('#tip');
  } catch {
    tip = '(未捕捉到)';
  }

  await page
    .waitForFunction(() => location.hostname.endsWith('example.com'), { timeout: 8000 })
    .catch(() => {});

  const ok = landed === sc.expect && errors.length === 0;
  results.push({ name: sc.name, landed, expect: sc.expect, ok, tip, why: sc.why, errors });

  await ctx.close();
}

await browser.close();
server.close();

/* ---------------- 输出 ---------------- */
let pass = 0;
for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  const got = r.landed ? HOSTS[r.landed] : '(未跳转)';
  console.log(`${mark} ${r.name}`);
  console.log(`   期望 ${HOSTS[r.expect]}  实际 ${got}`);
  console.log(`   提示语「${r.tip}」 — ${r.why}`);
  if (r.errors.length) console.log(`   JS 报错: ${r.errors.join(' | ')}`);
  if (r.ok) pass++;
}
console.log('');
console.log(`${pass}/${results.length} 场景通过`);

process.exit(pass === results.length ? 0 : 1);
