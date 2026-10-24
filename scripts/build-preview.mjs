/**
 * 生成一份纯静态的界面预览（preview/index.html）。
 * 演示模式不会发起真实网络请求、也不会跳转，只用于查看 UI 与动效。
 *
 *   node scripts/build-preview.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { renderPage } from '../src/page.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  DOMAINS: [
    'https://hk.example.com|/__probe|香港 · 亚洲优化',
    'https://sg.example.com|/__probe|新加坡 · 东南亚',
    'https://us-west.example.com|/__probe|美西 · 洛杉矶',
  ].join(', '),
  BRAND_NAME: '天才程序员',
  SUBTITLE: '正在检测最快线路…',
  FOOTER_TEXT: '本页面仅用于演示界面效果',
  ACCENT_COLOR: '#2563eb',
  DEMO: 'true',
  // 演示模式下故意拉长一点，方便看清进度条与成功动效
  MEASURE_ROUNDS: '3',
  RESULT_DELAY: '1400',
};

const cfg = parseConfig(env);
const html = renderPage({ targets: cfg.targets, cfg });

await mkdir(join(root, 'preview'), { recursive: true });
await writeFile(join(root, 'preview', 'index.html'), html, 'utf8');

console.log('预览已生成：preview/index.html');
console.log('目标域名：', cfg.targets.map((t) => `${t.label} <${t.url}>`).join('\n          '));
