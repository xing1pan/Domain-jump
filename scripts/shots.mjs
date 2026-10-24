import { launch } from './browser.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = pathToFileURL(join(root, 'preview', 'index.html')).href;

const shots = [
  { name: 'loading', at: 420, theme: 'light' },
  { name: 'done', at: 1750, theme: 'light' },
  { name: 'dark-done', at: 1750, theme: 'dark' },
  { name: 'noredirect', at: 1750, theme: 'light', query: '?__noredirect=1' },
];

const browser = await launch();

for (const shot of shots) {
  const ctx = await browser.newContext({
    viewport: { width: 760, height: 620 },
    deviceScaleFactor: 2,
    colorScheme: shot.theme,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(target + (shot.query || ''));
  await page.waitForTimeout(shot.at);
  const tip = await page.textContent('#tip');
  const btnVisible = await page.evaluate(() => {
    const b = document.getElementById('go');
    return getComputedStyle(b).opacity !== '0' && b.getBoundingClientRect().height > 0;
  });
  await page.screenshot({ path: join(root, 'preview', `shot-${shot.name}.png`) });
  console.log(`${shot.name}: tip="${tip}" 按钮可见=${btnVisible} errors=${errors.length ? errors.join(' | ') : '无'}`);
  await ctx.close();
}

await browser.close();
