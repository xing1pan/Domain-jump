/**
 * 加载 playwright-core 与浏览器可执行文件。
 *
 * 默认按常规方式解析 `playwright-core`（需要先 `npm i -D playwright-core`）。
 * 如果你的环境里它是装在别处，可以用环境变量指定：
 *
 *   PLAYWRIGHT_CORE=file:///abs/path/to/playwright-core/index.mjs
 *   CHROME_PATH=/abs/path/to/chrome.exe
 */
import { existsSync } from 'node:fs';

const DEFAULT_CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export async function loadChromium() {
  const spec = process.env.PLAYWRIGHT_CORE || 'playwright-core';
  const mod = await import(spec);
  return (mod.chromium || mod.default?.chromium);
}

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return DEFAULT_CHROME.find((p) => existsSync(p));
}

export async function launch() {
  const chromium = await loadChromium();
  const executablePath = chromePath();
  // 没找到本机 Chrome 就交给 playwright 自带的浏览器
  return chromium.launch(executablePath ? { executablePath } : {});
}
