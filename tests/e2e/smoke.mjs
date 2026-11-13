// Smoke test against a running app (default http://localhost:5173): the Earth globe names a country and a city, the Mars globe finds Olympus Mons at its real height, the Moon globe draws, the fly-to reaches the
// south-pole view, a site report appears, and clicking the terrain picks a new site.
// Landers: the list, filters, cards with routes and 3D models, and the close-up ground, on Mars and on the Moon.
// Usage: node tests/e2e/smoke.mjs [url] [screenshot-prefix]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5173/?view=globe&t=2028-03-03T00:00:00.000Z&lat=-89.68&lon=-166';
const shots = process.argv[3];
const errors = [];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
// Reduced motion: the panel's cards hold still (Playwright only clicks what has stopped moving) and the opening is a
// short fade instead of the flight.
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// Solar system first: the planets draw, then flying to the Moon lands on the globe. The Earth comes first.
await page.goto(url.replace('view=globe', 'view=solar'), { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="solar-map"] canvas', { timeout: 60_000 });
await page.getByLabel('Date and time (UTC)').waitFor({ timeout: 5_000 });
if (
  (await page.getByRole('heading', { name: 'Landing site' }).count()) +
  (await page.getByText('Play a lunar day').count())
)
  throw new Error('Moon controls are showing on the solar-system view');
await page.waitForTimeout(2500);
if (shots) await page.screenshot({ path: `${shots}-solar.png` });
// Earth: the globe, then a country by search, then a city by clicking its label.
await page.getByRole('button', { name: 'Earth', exact: true }).first().click();
await page.waitForSelector('[data-testid="earth-map"] canvas', { timeout: 60_000 });
await page.getByText('Egypt', { exact: true }).first().waitFor({ timeout: 60_000 });
// The Moon's landing controls stay with the Moon views; the header's date is on every view.
await page.getByLabel('Date and time (UTC)').waitFor({ timeout: 5_000 });
if (
  (await page.getByRole('heading', { name: 'Landing site' }).count()) +
  (await page.getByText('Play a lunar day').count())
)
  throw new Error('Moon controls are showing on the Earth view');
for (const name of ['Natural Earth', 'Blue Marble: Next Generation', 'Black Marble 2016'])
  await page.getByRole('link', { name }).first().waitFor({ timeout: 5_000 });
await page.waitForTimeout(1500);
if (shots) await page.screenshot({ path: `${shots}-earth.png` });
await page.getByRole('combobox', { name: 'Find a country' }).fill('Lebanon');
await page.keyboard.press('Enter');
await page.getByTestId('earth-country').getByText('Lebanon').waitFor({ timeout: 10_000 });
await page.waitForTimeout(2200);
await page.getByRole('button', { name: 'Zoom in' }).click();
await page.getByText('Beirut', { exact: true }).first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(600);
if (shots) await page.screenshot({ path: `${shots}-earth-country.png` });
const beirut = await page.getByText('Beirut', { exact: true }).first().boundingBox();
await page.mouse.click(beirut.x - 2, beirut.y + beirut.height / 2);
await page.getByTestId('earth-city').getByText('Beirut').waitFor({ timeout: 10_000 });
await page.getByRole('navigation').getByText('Beirut').waitFor({ timeout: 5_000 });
await page.getByRole('button', { name: 'Zoom in' }).click();
await page.waitForTimeout(800);
if (shots) await page.screenshot({ path: `${shots}-earth-city.png` });
await page.getByRole('button', { name: 'Day and night' }).click();
await page.getByRole('button', { name: 'Whole Earth' }).click();
await page.waitForTimeout(2200);
if (shots) await page.screenshot({ path: `${shots}-earth-night.png` });
await page.getByRole('button', { name: 'Solar system' }).click();
await page.waitForSelector('[data-testid="solar-map"] canvas', { timeout: 60_000 });
await page.waitForTimeout(1500);
// Mars: the relief globe, a volcano by search with its real height, a landing-site crater, then the real-Sun line.
await page.getByRole('button', { name: 'Mars', exact: true }).first().click();
await page.waitForSelector('[data-testid="mars-map"] canvas', { timeout: 60_000 });
await page.getByText('Valles Marineris', { exact: true }).first().waitFor({ timeout: 60_000 });
await page.getByLabel('Date and time (UTC)').waitFor({ timeout: 5_000 });
if (
  (await page.getByRole('heading', { name: 'Landing site' }).count()) +
  (await page.getByText('Play a lunar day').count())
)
  throw new Error('Moon controls are showing on the Mars view');
for (const name of ['Solar System Scope', 'MEGDR', 'IAU Gazetteer of Planetary Nomenclature'])
  await page.getByRole('link', { name }).first().waitFor({ timeout: 5_000 });
await page.waitForTimeout(3500);
if (shots) await page.screenshot({ path: `${shots}-mars.png` });
await page.getByRole('combobox', { name: 'Find a feature' }).fill('Olympus Mons');
await page.keyboard.press('Enter');
await page.getByTestId('mars-feature').getByText('Olympus Mons').waitFor({ timeout: 10_000 });
await page
  .getByTestId('mars-elevation')
  .getByText(/m above the areoid/)
  .waitFor({ timeout: 30_000 });
const elevationText = await page.getByTestId('mars-elevation').textContent();
const olympusM = Number(elevationText.match(/-?[\d,]+/)[0].replace(/,/g, ''));
if (!(olympusM > 18_000 && olympusM < 22_000)) throw new Error(`Olympus Mons reads ${olympusM} m`);
await page.waitForTimeout(2500);
if (shots) await page.screenshot({ path: `${shots}-mars-olympus.png` });
await page.getByRole('combobox', { name: 'Find a feature' }).fill('Jezero');
await page.keyboard.press('Enter');
await page.getByTestId('mars-feature').getByText('Jezero').waitFor({ timeout: 10_000 });
await page.getByRole('navigation').getByText('Jezero').waitFor({ timeout: 5_000 });
await page.waitForTimeout(2500);
if (shots) await page.screenshot({ path: `${shots}-mars-jezero.png` });
await page.getByRole('button', { name: 'Day and night' }).click();
await page.getByRole('button', { name: 'Whole Mars' }).click();
await page.waitForTimeout(2500);
if (shots) await page.screenshot({ path: `${shots}-mars-night.png` });
// Landers on Mars: the list and its filters, a card with the rover's distance and a 3D model, the close-up ground.
const noMoonControls = async (where) => {
  if (
    (await page.getByRole('heading', { name: 'Landing site' }).count()) +
    (await page.getByText('Play a lunar day').count())
  )
    throw new Error(`Moon controls are showing on the ${where}`);
};
await page.getByTestId('side-landers').click();
await page.getByTestId('lander-list').waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: 'Next and planned' }).click();
await page.getByTestId('mission-rosalind').waitFor({ timeout: 5_000 });
if (await page.getByTestId('mission-curiosity').count()) throw new Error('Curiosity is listed as next or planned');
await page.getByRole('button', { name: 'All', exact: true }).click();
await page.getByTestId('mission-perseverance').click();
await page.getByTestId('mission-card').getByText('45.25 km').waitFor({ timeout: 10_000 });
await page.getByText(/^NASA 3D model/).waitFor({ timeout: 30_000 });
await page.getByText('NASA 3D Resources, free and without copyright').waitFor({ timeout: 5_000 });
await page.waitForTimeout(4000);
if (shots) await page.screenshot({ path: `${shots}-mars-lander.png` });
await page.getByTestId('open-site').click();
await page.waitForSelector('[data-testid="site-map"] canvas', { timeout: 60_000 });
await page.getByRole('navigation').getByText('Perseverance, close up').waitFor({ timeout: 5_000 });
await page.getByTestId('pin-ingenuity').waitFor({ state: 'visible', timeout: 30_000 });
await noMoonControls('Mars close-up');
await page.waitForTimeout(3500);
if (shots) await page.screenshot({ path: `${shots}-mars-site.png` });
await page.getByRole('button', { name: 'Back to the globe' }).click();
await page.waitForSelector('[data-testid="mars-map"] canvas', { timeout: 60_000 });
// Every 3D model on Mars reads and draws (Viking, the Mars rovers' shared model, Ingenuity).
for (const id of ['viking1', 'spirit', 'ingenuity']) {
  await page.getByRole('button', { name: /All landings/ }).click();
  await page.getByTestId(`mission-${id}`).click();
  await page.getByText(/^NASA 3D model/).waitFor({ timeout: 30_000 });
  if (await page.getByText('The 3D model could not be loaded.').count())
    throw new Error(`The ${id} model did not load`);
}
await page.getByRole('button', { name: /All landings/ }).click();
await page.getByRole('button', { name: 'Solar system' }).click();
await page.waitForSelector('[data-testid="solar-map"] canvas', { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Moon', exact: true }).first().click();
await page.waitForSelector('[data-testid="globe-map"] canvas', { timeout: 60_000 });
await page.getByRole('heading', { name: 'Landing site' }).waitFor({ timeout: 5_000 });
await page.waitForTimeout(3000);
if (shots) await page.screenshot({ path: `${shots}-globe.png` });
// Landers on the Moon: Apollo 11 with its 3D model, its close-up ground with Surveyor 5 on it, then back.
await page.getByTestId('lander-list').waitFor({ timeout: 5_000 });
await page.getByTestId('mission-apollo11').click();
await page.getByText(/^NASA 3D model/).waitFor({ timeout: 30_000 });
if (await page.getByText('The 3D model could not be loaded.').count()) throw new Error('The Apollo model did not load');
await page.getByTestId('open-site').click();
await page.waitForSelector('[data-testid="site-map"] canvas', { timeout: 60_000 });
await page.getByTestId('pin-surveyor5').waitFor({ state: 'visible', timeout: 30_000 });
await noMoonControls('Moon close-up');
await page.waitForTimeout(3500);
if (shots) await page.screenshot({ path: `${shots}-moon-site.png` });
await page.getByRole('button', { name: 'Back to the globe' }).click();
await page.waitForSelector('[data-testid="globe-map"] canvas', { timeout: 60_000 });
await page.getByRole('button', { name: /All landings/ }).click();
await page.waitForTimeout(1500);
if (shots) await page.screenshot({ path: `${shots}-moon-landers.png` });

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

// A lander in the polar region opens the landing-site check there, and a shared link opens a lander's card.
await page.getByRole('navigation').getByRole('button', { name: 'Moon' }).click();
await page.waitForSelector('[data-testid="globe-map"] canvas', { timeout: 60_000 });
await page.getByTestId('side-landers').click();
await page.getByTestId('mission-im2').click();
await page.getByRole('button', { name: 'Plan this site in 3D' }).click();
await page.waitForSelector('[data-testid="pole-map"] canvas', { timeout: 60_000 });
const planned = Number(new URL(page.url()).searchParams.get('lat'));
if (Math.abs(planned + 84.79) > 0.01) throw new Error(`Plan this site went to latitude ${planned}`);
await page.goto(`${new URL(url).origin}/?view=mars&mission=curiosity`, { waitUntil: 'networkidle' });
await page.getByTestId('mission-card').getByText('38.16 km').waitFor({ timeout: 30_000 });

if (errors.length) {
  console.error(`FAIL: console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
console.log(process.exitCode ? 'smoke test failed' : `smoke test passed: picked ${new URL(page.url()).search}`);
await browser.close();
