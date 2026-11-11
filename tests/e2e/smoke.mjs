// Smoke test against a running app (default http://localhost:5173): the Moon globe draws, the fly-to reaches the
// south-pole view, a site report appears, and clicking the terrain picks a new site.
// Usage: node tests/e2e/smoke.mjs [url] [screenshot-prefix]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5173/?view=globe&t=2028-03-03T00:00:00.000Z&lat=-89.68&lon=-166';
const shots = process.argv[3];
const errors = [];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// Solar system first: the planets draw, then flying to the Moon lands on the globe.
await page.goto(url.replace('view=globe', 'view=solar'), { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="solar-map"] canvas', { timeout: 60_000 });
await page.waitForTimeout(2500);
if (shots) await page.screenshot({ path: `${shots}-solar.png` });
await page.getByRole('button', { name: 'Moon', exact: true }).first().click();
await page.waitForSelector('[data-testid="globe-map"] canvas', { timeout: 60_000 });
await page.waitForTimeout(3000);
if (shots) await page.screenshot({ path: `${shots}-globe.png` });

await page.getByRole('button', { name: 'Fly to the south pole' }).click();
await page.waitForSelector('[data-testid="pole-map"] canvas', { timeout: 60_000 });
await page.getByText(/^(✓ |✗ |\? )?(Pass|Fail|Not decided yet)$/).waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
if (shots) await page.screenshot({ path: `${shots}-pole.png` });

const before = new URL(page.url()).searchParams.get('lat');
const box = await page.locator('[data-testid="pole-map"]').boundingBox();
await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.55);
await page.waitForFunction((lat) => new URL(location.href).searchParams.get('lat') !== lat, before, {
  timeout: 30_000,
});

// Layers, pinning and compare, best-spot search.
await page.getByRole('button', { name: 'Long-term Sun' }).click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /^Pin to compare/ }).click();
await page.getByText(/^1 pinned site$/).waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: 'Find the best spots in Malapert Massif' }).click();
await page.getByText(/^1\. /).waitFor({ timeout: 60_000 });
await page.getByRole('button', { name: '▶ Play a lunar day' }).click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: '❚❚ Pause' }).click();
if (shots) await page.screenshot({ path: `${shots}-layers.png` });

if (errors.length) {
  console.error(`FAIL: console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
console.log(process.exitCode ? 'smoke test failed' : `smoke test passed: picked ${new URL(page.url()).search}`);
await browser.close();
