const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 480, height: 240}});
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?motion=fixed');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    await page.evaluate(() => { GravityDemo.setSuspended(true); GravityDemo.paused = true; GravityDemo.applySettings({spinning: true, cloudThickness: .15}); });
    for (const settings of [
      {cloudRadius: 22, elevation: 5}, {cloudRadius: 33, elevation: 18},
      {cloudRadius: 33, elevation: 5}, {cloudRadius: 11, elevation: 80},
      {cloudRadius: 33, elevation: 5, spin: .95, distance: 32},
      {cloudRadius: 33, elevation: 5, spinning: false, distance: 85}
    ]) {
      const row = await page.evaluate(async settings => {
        const d = GravityDemo, gl = d.gl;
        d.applySettings(settings);
        d.simTime = 0; d.allocateParticles(); d.updateParticles(0, d.fadeSeconds);
        for (let i = 0; i < 200; i++) d.updateParticles(.2, .02);
        const progress = [];
        while (d.job) {
          d.advanceTrace(); progress.push(d.job ? d.job.next / d.job.total : 1);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        d.deposit();
        const tile = d.rayTiles[0], tail = tile.tail;
        const image = () => {
          d.shade(); gl.bindFramebuffer(gl.FRAMEBUFFER, d.hdrFbo); gl.readBuffer(gl.COLOR_ATTACHMENT0);
          const pixels = new Float32Array(d.rw * d.rh * 4);
          gl.readPixels(0, 0, d.rw, d.rh, gl.RGBA, gl.FLOAT, pixels);
          return pixels;
        };
        const fixed = image(); tile.tail = null; const clipped = image(); tile.tail = tail;
        // A full-frame cache independently checks the packed continuation lookup.
        const layers = 256, reference = {row: 0, ...d.allocatePathCache(d.rw, d.rh, layers),
          sky: tile.sky, tailIndex: tile.tailIndex};
        gl.viewport(0, 0, d.rw, d.rh);
        for (let slice = 0; slice < layers; slice++) {
          const write = slice % 2, read = 1 - write;
          gl.bindFramebuffer(gl.FRAMEBUFFER, reference.stateFbo[write]);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, reference.pathX, 0, slice);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, reference.pathP, 0, slice);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
          d.use(d.programs.trace); d.cameraUniforms(); d.i('uSlice', slice);
          d.bind('uStateX', reference.stateX[read], 0); d.bind('uStateP', reference.stateP[read], 1); d.quad();
          if (slice % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        d.rayTiles = [reference]; d.slices = layers;
        const expected = image();
        d.rayTiles = [tile]; d.slices = 64;
        let error = 0, missing = 0, restored = 0, energy = 0;
        for (let i = 0; i < fixed.length; i++) {
          error += Math.abs(fixed[i] - expected[i]); energy += Math.abs(expected[i]);
          missing += Math.abs(clipped[i] - expected[i]);
          if (i % 4 === 3 && expected[i] > clipped[i] + .005) restored++;
        }
        return {settings, relativeError: error / energy, clippedError: missing / energy, restored,
          tail: tail ? {count: tail.count, slices: tail.slices, records: tail.width * tail.height * tail.slices} : null,
          baseRecords: tile.width * tile.height * 64, rays: d.diagnostics(),
          monotonic: progress.every((value, i) => i === 0 || value >= progress[i - 1]), glError: gl.getError()};
      }, settings);
      results.push(row); console.log(JSON.stringify(row));
      assert.equal(row.glError, 0);
      assert.equal(row.rays.invalid, 0);
      assert.equal(row.rays.budget, 0);
      assert.ok(row.monotonic, 'Loading progress must not move backwards');
      assert.ok(row.relativeError < .0001, 'Packed rays must match a full-frame continuation');
      assert.ok(!row.tail || row.tail.slices + 64 < 256, 'Reference must cover the complete path');
      if (settings.cloudRadius >= 22 && settings.elevation <= 18) {
        assert.ok(row.restored > 20, 'Continuation must restore the light lost at the cutoff');
        assert.ok(row.clippedError > .001, 'The original 64-segment limit must fail this regression');
      }
    }
    assert.deepEqual(errors, []);
    fs.mkdirSync('test-results', {recursive: true});
    fs.writeFileSync('test-results/clipping-browser-results.json', JSON.stringify(results, null, 2));
    console.log('PASS: complete cloud paths at low elevation, extended radius, spin extremes and camera distances.');
  } finally {
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
