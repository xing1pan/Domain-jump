import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, clientConfig } from '../src/config.js';

test('逗号分隔的简单列表', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com, https://b.com' });
  assert.equal(cfg.targets.length, 2);
  assert.equal(cfg.targets[0].url, 'https://a.com');
  assert.equal(cfg.targets[0].origin, 'https://a.com');
  assert.equal(cfg.targets[0].label, 'a.com');
  assert.equal(cfg.targets[0].probe, '/__probe');
});

test('换行分隔 + 自动补 https + 竖线扩展属性', () => {
  const cfg = parseConfig({
    DOMAINS: `
      hk.example.com|/ping|香港节点
      https://sg.example.com|/ping|新加坡节点|3
      https://us.example.com/app
    `,
  });
  assert.equal(cfg.targets.length, 3);
  assert.equal(cfg.targets[0].url, 'https://hk.example.com');
  assert.equal(cfg.targets[0].probe, '/ping');
  assert.equal(cfg.targets[0].label, '香港节点');
  assert.equal(cfg.targets[1].priority, 3);
  assert.equal(cfg.targets[2].url, 'https://us.example.com/app');
  assert.equal(cfg.targets[2].basePath, '/app');
  assert.equal(cfg.targets[2].origin, 'https://us.example.com');
});

test('去重：同一域名只保留第一个', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com, a.com, https://a.com/' });
  assert.equal(cfg.targets.length, 1);
});

test('非法条目被丢弃，不影响其他条目', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com, , not-a-domain, ftp://x.com, https://b.com' });
  assert.deepEqual(cfg.targets.map((t) => t.host), ['a.com', 'b.com']);
});

test('布尔 / 数字从字符串解析', () => {
  const cfg = parseConfig({
    DOMAINS: 'https://a.com',
    PRESERVE_PATH: 'false',
    AUTO_REDIRECT: '0',
    CACHE_TTL: '60',
    MEASURE_ROUNDS: '5',
    MEASURE_TIMEOUT: '900',
  });
  assert.equal(cfg.preservePath, false);
  assert.equal(cfg.autoRedirect, false);
  assert.equal(cfg.cacheTtl, 60);
  assert.equal(cfg.rounds, 5);
  assert.equal(cfg.timeout, 900);
});

test('默认值', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com' });
  assert.equal(cfg.probePath, '/__probe');
  assert.equal(cfg.probeFallbackPath, '/favicon.ico');
  assert.equal(cfg.rounds, 3);
  assert.equal(cfg.timeout, 2500);
  assert.equal(cfg.cacheTtl, 300);
  assert.equal(cfg.preservePath, true);
  assert.equal(cfg.autoRedirect, true);
  assert.equal(cfg.fallbackIndex, null); // auto：取优先级最高的
  assert.equal(cfg.selectionMode, 'speed');
  assert.equal(cfg.priorityTolerance, 30);
  assert.equal(cfg.maxWait, 6000);
  assert.equal(cfg.showTarget, false);
  assert.equal(cfg.brand, '天才程序员');
  assert.equal(cfg.demo, false);
  assert.ok(cfg.logo.startsWith('https://'));
});

test('页面外观与显示选项可配置', () => {
  const cfg = parseConfig({
    DOMAINS: 'https://a.com',
    BRAND_NAME: '我的站点',
    TIP_TEXT: '正在加速…',
    LOGO_URL: 'https://cdn.example.com/logo.png',
    SHOW_TARGET: 'true',
    MAX_WAIT: '3000',
    FOOTER_TEXT: '© 2026',
  });
  assert.equal(cfg.brand, '我的站点');
  assert.equal(cfg.subtitle, '正在加速…');
  assert.equal(cfg.logo, 'https://cdn.example.com/logo.png');
  assert.equal(cfg.showTarget, true);
  assert.equal(cfg.maxWait, 3000);
  assert.equal(cfg.footer, '© 2026');
});

test('PROBE_FALLBACK_PATH 设为 off 时禁用备用路径', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com', PROBE_FALLBACK_PATH: 'off' });
  assert.equal(cfg.probeFallbackPath, '');
});

test('自定义探测路径自动补前导斜杠', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com', PROBE_PATH: 'ping' });
  assert.equal(cfg.probePath, '/ping');
  assert.equal(cfg.targets[0].probe, '/ping');
});

test('DOMAINS_JSON 支持对象数组', () => {
  const cfg = parseConfig({
    DOMAINS_JSON: JSON.stringify([
      { url: 'https://a.com', probe: '/p', label: '甲' },
      'https://b.com',
    ]),
  });
  assert.equal(cfg.targets.length, 2);
  assert.equal(cfg.targets[0].label, '甲');
  assert.equal(cfg.targets[0].probe, '/p');
  assert.equal(cfg.targets[1].url, 'https://b.com');
});

test('DOMAINS_JSON 优先级高于 DOMAINS', () => {
  const cfg = parseConfig({
    DOMAINS: 'https://x.com',
    DOMAINS_JSON: JSON.stringify(['https://y.com']),
  });
  assert.deepEqual(cfg.targets.map((t) => t.host), ['y.com']);
});

test('空配置不抛异常', () => {
  const cfg = parseConfig({});
  assert.deepEqual(cfg.targets, []);
  assert.deepEqual(parseConfig().targets, []);
});

test('数字越界被夹紧', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com', MEASURE_ROUNDS: '999', MEASURE_TIMEOUT: '1' });
  assert.equal(cfg.rounds, 10);
  assert.equal(cfg.timeout, 200);
});

test('clientConfig 只暴露浏览器需要的字段', () => {
  const client = clientConfig(parseConfig({ DOMAINS: 'https://a.com' }));
  assert.ok('probePath' in client);
  assert.ok('rounds' in client);
  assert.ok('selectionMode' in client);
  assert.ok('priorityTolerance' in client);
  assert.ok(!('targets' in client));
  assert.ok(!('accent' in client));
});

/* ------------------------------ 优先级 ------------------------------ */

test('第 4 段解析为优先级，默认 0', () => {
  const cfg = parseConfig({
    DOMAINS: 'https://a.com|/p|主站|10, https://b.com|/p|备用, https://c.com|/p|降级|-5',
  });
  assert.deepEqual(cfg.targets.map((t) => t.priority), [10, 0, -5]);
});

test('优先级越界被夹紧到 [-999, 999]', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com|/p|x|99999, https://b.com|/p|y|-99999' });
  assert.equal(cfg.targets[0].priority, 999);
  assert.equal(cfg.targets[1].priority, -999);
});

test('非法优先级回落到 0', () => {
  const cfg = parseConfig({ DOMAINS: 'https://a.com|/p|x|abc' });
  assert.equal(cfg.targets[0].priority, 0);
});

test('DOMAINS_JSON 里可以用 priority 或 weight', () => {
  const cfg = parseConfig({
    DOMAINS_JSON: JSON.stringify([
      { url: 'https://a.com', priority: 8 },
      { url: 'https://b.com', weight: 3 },
    ]),
  });
  assert.equal(cfg.targets[0].priority, 8);
  assert.equal(cfg.targets[1].priority, 3);
});

test('SELECTION_MODE 解析与别名', () => {
  const mode = (v) => parseConfig({ DOMAINS: 'https://a.com', SELECTION_MODE: v }).selectionMode;
  assert.equal(mode('speed'), 'speed');
  assert.equal(mode('fastest'), 'speed');
  assert.equal(mode('priority'), 'priority');
  assert.equal(mode('balanced'), 'priority');
  assert.equal(mode('prefer'), 'priority');
  assert.equal(mode('strict'), 'strict');
  assert.equal(mode('forced'), 'strict');
  assert.equal(mode('STRICT'), 'strict');
  assert.equal(mode('随便写的'), 'speed'); // 非法值回落到 speed
});

test('PRIORITY_TOLERANCE 解析', () => {
  assert.equal(parseConfig({ DOMAINS: 'https://a.com' }).priorityTolerance, 30);
  assert.equal(parseConfig({ DOMAINS: 'https://a.com', PRIORITY_TOLERANCE: '0' }).priorityTolerance, 0);
  assert.equal(parseConfig({ DOMAINS: 'https://a.com', PRIORITY_TOLERANCE: '150' }).priorityTolerance, 150);
});

test('FALLBACK_INDEX 支持 auto 与固定下标', () => {
  assert.equal(parseConfig({ DOMAINS: 'https://a.com' }).fallbackIndex, null);
  assert.equal(parseConfig({ DOMAINS: 'https://a.com', FALLBACK_INDEX: 'auto' }).fallbackIndex, null);
  assert.equal(parseConfig({ DOMAINS: 'https://a.com', FALLBACK_INDEX: '2' }).fallbackIndex, 2);
  assert.equal(parseConfig({ DOMAINS: 'https://a.com', FALLBACK_INDEX: '0' }).fallbackIndex, 0);
});
