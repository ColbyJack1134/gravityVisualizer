const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 960, height: 720}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?quality=draft&motion=fixed&ui=1');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    await page.evaluate(() => { GravityDemo.setSuspended(true); GravityDemo.applySettings({continuousTracing: true}); });
    const edit = async (id, value, key = 'Enter') => {
      const button = page.locator(`#${id}-number`).locator('..').locator('.slider-value');
      await button.click();
      await page.locator(`#${id}-number`).fill(value);
      await page.locator(`#${id}-number`).press(key);
    };
    assert.equal(await page.locator('.slider-number').count(), await page.locator('input[type="range"]').count());
    await edit('exposure', '2.3');
    assert.equal(await page.evaluate(() => GravityDemo.exposure), 2.3);
    assert.equal(await page.locator('#exposure-value').textContent(), '2.3×');
    await edit('exposure', '999');
    assert.equal(await page.evaluate(() => GravityDemo.exposure), 3);
    await edit('exposure', '0.34');
    assert.equal(await page.evaluate(() => GravityDemo.exposure), .3);
    await edit('exposure', '2', 'Escape');
    await edit('exposure', '');
    assert.equal(await page.evaluate(() => GravityDemo.exposure), .3);
    await edit('exposure', '1.7', 'Tab');
    assert.equal(await page.evaluate(() => GravityDemo.exposure), 1.7);
    await edit('framing-y', '-25.5');
    await page.waitForFunction(() => GravityDemo.framingY === -.255);
    assert.equal(await page.locator('#framing-y-number').locator('..').locator('output').textContent(), '-25.5');
    await page.locator('#manual-camera-controls summary').click();
    await edit('distance', '12');
    await page.waitForFunction(() => GravityDemo.camera.distance === 12);
    await page.locator('#distance').fill('47');
    await page.locator('#distance').dispatchEvent('input');
    await page.waitForFunction(() => GravityDemo.camera.distance === 47);
    await page.getByRole('button', {name: 'Edit Distance', exact: true}).click();
    assert.equal(await page.locator('#distance-number').inputValue(), '47');
    await page.locator('#distance-number').press('Escape');
    await page.locator('#floating-camera').check();
    await edit('orbit-near', '60');
    assert.deepEqual(await page.evaluate(() => [GravityDemo.orbitNear, GravityDemo.orbitFar]), [60, 60]);
    assert.equal(await page.locator('#orbit-far-value').textContent(), '60');
    await edit('orbit-speed', '-3.7');
    assert.equal(await page.evaluate(() => GravityDemo.orbitSpeed), -3.7);
    assert.equal(await page.getByRole('button', {name: 'Edit Movement', exact: true}).isVisible(), false);
    const speedButton = page.locator('#palette-speed-number').locator('..').locator('button');
    assert.equal(await speedButton.isDisabled(), true);
    await page.locator('#palette-animate').check();
    assert.equal(await speedButton.isDisabled(), false);
    await edit('palette-speed', '-1.25');
    assert.equal(await page.evaluate(() => GravityDemo.editedPalette.gradient.speed), -1.25);
    await page.getByRole('button', {name: 'Edit Offset', exact: true}).click();
    await page.locator('#palette-offset-number').fill('23.4');
    await page.evaluate(() => { GravityDemo.frames = 0; GravityDemo.syncPalettePreview(true); });
    assert.equal(await page.locator('#palette-offset-number').inputValue(), '23.4');
    await page.locator('#palette-offset-number').press('Enter');
    assert.ok(Math.abs(await page.evaluate(() => GravityDemo.editedPalette.gradient.offset) - .234) < 1e-10);
    assert.deepEqual(errors, []);
    console.log('PASS: every slider has an editor; typing, stepping, limits, blur, cancellation, disabled state, live palettes and camera synchronization.');
  } finally {
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
