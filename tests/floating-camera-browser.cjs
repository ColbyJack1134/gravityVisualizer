const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 480, height: 270}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?motion=fixed');
    await page.waitForFunction(() => GravityDemo.cacheReady || GravityDemo.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    const comparison = await page.evaluate(() => {
      const d = GravityDemo, gl = d.gl;
      d.setSuspended(true); d.paused = true;
      d.updateParticles(0, d.fadeSeconds); d.deposit(); d.shade(); d.present();
      const before = new Uint8Array(d.canvas.width * d.canvas.height * 4);
      gl.readPixels(0, 0, d.canvas.width, d.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, before);
      const camera = {...d.camera}, simTime = d.simTime;
      const checkbox = document.getElementById('floating-camera');
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
      d.shade(); d.present();
      const after = new Uint8Array(before.length);
      gl.readPixels(0, 0, d.canvas.width, d.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, after);
      let error = 0, light = 0;
      for (let i = 0; i < before.length; i++) if (i % 4 !== 3) {
        error += Math.abs(before[i] - after[i]); light += before[i];
      }
      return {relativeError: error / light, light, job: d.job, cameraUnchanged: JSON.stringify(camera) === JSON.stringify(d.camera),
        simulationUnchanged: simTime === d.simTime, glError: gl.getError(), renderer: d.rendererName};
    });
    console.log('Cached/continuous comparison:', comparison);
    assert.equal(comparison.job, null);
    assert.equal(comparison.glError, 0);
    assert.ok(comparison.cameraUnchanged && comparison.simulationUnchanged);
    assert.ok(comparison.light > 1000 && comparison.relativeError < .05);
    const movement = await page.evaluate(() => {
      const d = GravityDemo, views = [];
      const builds = d.cacheBuilds;
      for (const time of [0, 12, 30, 60, 90]) {
        d.floatingTime = time; d.orbitAngle = time * .03;
        views.push(d.cameraView()); d.shade(); d.present();
      }
      return {views, builds: d.cacheBuilds - builds, job: d.job, error: d.gl.getError()};
    });
    assert.equal(movement.builds, 0); assert.equal(movement.job, null); assert.equal(movement.error, 0);
    for (const key of ['theta', 'phi', 'distance']) assert.ok(new Set(movement.views.map(view => view[key])).size > 1);
    await page.evaluate(() => {
      const d = GravityDemo;
      d.applySettings({elevation: 35, distance: 48, spinning: true, spin: .8});
      d.shade(); d.present();
    });
    assert.equal(await page.evaluate(() => GravityDemo.job), null);
    await page.evaluate(() => {
      const d = GravityDemo;
      d.applySettings({cameraMotion: 'gentle', paused: false}); d.setSuspended(false);
    });
    await page.waitForFunction(() => GravityDemo.floatingTime > 90.2);
    await page.evaluate(() => GravityDemo.applySettings({paused: true}));
    const paused = await page.evaluate(() => GravityDemo.cameraView());
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => GravityDemo.cameraView()), paused);
    await page.evaluate(() => GravityDemo.applySettings({paused: false}));
    await page.evaluate(() => GravityDemo.applySettings({cameraMotion: 'fixed'}));
    const held = await page.evaluate(() => GravityDemo.cameraView());
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => GravityDemo.cameraView()), held);
    await page.evaluate(() => {
      const extension = GravityDemo.gl.getExtension('WEBGL_lose_context');
      extension.loseContext(); setTimeout(() => extension.restoreContext(), 100);
    });
    await page.waitForFunction(() => !GravityDemo.lost && GravityDemo.cacheReady && GravityDemo.programs.continuous);
    assert.equal(await page.locator('#floating-camera').isChecked(), true);
    await page.evaluate(() => GravityDemo.applySettings({floatingCamera: false}));
    await page.waitForFunction(() => GravityDemo.cacheReady || GravityDemo.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    assert.equal(await page.locator('#floating-camera').isChecked(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: live tracing, matching fixed view, movement, settings, pause, hold, context recovery and cached-mode restoration.');
  } finally {
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
