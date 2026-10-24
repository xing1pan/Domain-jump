import { parseConfig, clientConfig } from './config.js';
import { renderPage } from './page.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/** 探测端点响应：必须极小、不可缓存、且允许跨域计时 */
const PROBE_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  'access-control-allow-origin': '*',
  'timing-allow-origin': '*',
  'x-probe': 'cf-domain-jump',
  'x-content-type-options': 'nosniff',
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
  'access-control-max-age': '86400',
};

const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="9" fill="#2563eb"/>` +
  `<path d="M17.6 4 8 18h6.4L13.6 28 24 14h-6.4z" fill="#fff"/></svg>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function configErrorPage(missing) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>配置缺失</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fb;
color:#0f172a;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
.box{max-width:560px;background:#fff;border:1px solid #e7ebf3;border-radius:16px;padding:28px;
box-shadow:0 20px 55px -24px rgba(15,23,42,.3)}h1{margin:0 0 12px;font-size:18px}
code{background:#f1f5f9;padding:2px 6px;border-radius:5px;font-size:13px}
pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto;font-size:12.5px}</style>
</head><body><div class="box"><h1>尚未配置目标域名</h1>
<p>请在 Cloudflare Worker 的 <code>设置 → 变量和密钥</code>（或 <code>wrangler.toml</code> 的 <code>[vars]</code>）中添加环境变量 <code>DOMAINS</code>：</p>
<pre>DOMAINS = "https://a.example.com, https://b.example.com"</pre>
<p>当前缺失：<code>${missing}</code></p></div></body></html>`,
    { status: 500, headers: HTML_HEADERS }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD, OPTIONS', ...CORS_HEADERS },
      });
    }

    const cfg = parseConfig(env || {});

    // —— 探测端点（本 Worker 部署到任意域名上都能被探测） ——
    if (url.pathname === cfg.probePath || url.pathname === '/__probe') {
      return new Response('ok', { status: 200, headers: PROBE_HEADERS });
    }

    // —— 图标：既能当 favicon，也能当备用探测目标 ——
    if (url.pathname === '/favicon.ico' || url.pathname === '/__icon.svg') {
      return new Response(ICON_SVG, {
        status: 200,
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'timing-allow-origin': '*',
        },
      });
    }

    // —— 健康检查 / 调试接口 ——
    if (url.pathname === '/__health') {
      return new Response('ok', { status: 200, headers: PROBE_HEADERS });
    }
    // —— 调试接口：默认关闭，避免暴露域名清单 ——
    if (url.pathname === '/__targets.json') {
      if (!cfg.debug) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
      return json({ ok: true, count: cfg.targets.length, targets: cfg.targets, cfg: clientConfig(cfg) });
    }

    // —— 跳转页 ——
    if (!cfg.targets.length) return configErrorPage('DOMAINS');

    const html = renderPage({ targets: cfg.targets, cfg, url });
    return new Response(html, { status: 200, headers: HTML_HEADERS });
  },
};
