const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP
    ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({ channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage(), errors = [], rows = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?motion=fixed');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    await page.evaluate(() => { GravityDemo.setSuspended(true); GravityDemo.paused = true; });
    for (const thickness of [0, .01, .15, .5, 1]) for (const radius of [11, 33]) for (const spin of [0, .95]) {
      const row = await page.evaluate(({ thickness, radius, spin }) => {
        const d = GravityDemo, gl = d.gl;
        d.applySettings({ cloudThickness: thickness, cloudRadius: radius, spinning: spin !== 0, spin });
        const particles = new Float32Array(d.count * d.particleStride);
        let maxZ = 0;
        for (let frame = 0; frame < 1000; frame++) {
          d.updateParticles(.4, .04);
          if (frame % 40 !== 39) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]);
          gl.getBufferSubData(gl.ARRAY_BUFFER, 0, particles);
          for (let i = 0; i < particles.length; i += d.particleStride)
            maxZ = Math.max(maxZ, Math.abs(particles[i + 2]));
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return { thickness, radius, spin, maxZ, grid: d.volumeGrid, extent: d.volumeExtent,
          cell: 2 * d.volumeExtent[0] / d.volumeGrid[0], error: gl.getError() };
      }, { thickness, radius, spin });
      rows.push(row);
      assert.equal(row.error, 0);
      assert.ok(Number.isFinite(row.maxZ));
      if (row.grid[2] < 104)
        assert.ok(row.maxZ + 4 * row.cell < row.extent[2], 'Cropped layers must contain the full particle and reconstruction kernels');
    }
    const comparison = await page.evaluate(() => {
      const d = GravityDemo, gl = d.gl;
      d.applySettings({ cloudThickness: .01, cloudRadius: 26.4, spinning: false });
      while (d.job) d.advanceTrace();
      for (let i = 0; i < 200; i++) d.updateParticles(.2, .02);
      const capture = () => {
        d.deposit(); d.shade();
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.hdrFbo);
        const pixels = new Float32Array(d.rw * d.rh * 4);
        gl.readPixels(0, 0, d.rw, d.rh, gl.RGBA, gl.FLOAT, pixels);
        return pixels;
      };
      const before = capture(), grid = d.volumeGrid.slice();
      const dimensions = d.volumeDimensions;
      d.volumeDimensions = () => [512, 512, 104];
      d.allocateEmission();
      const after = capture();
      d.volumeDimensions = dimensions;
      d.allocateEmission();
      let error = 0, light = 0, maxDifference = 0;
      before.forEach((v, i) => {
        const delta = Math.abs(v - after[i]); error += delta; light += Math.abs(after[i]);
        maxDifference = Math.max(maxDifference, delta);
      });
      return { grid, relativeError: error / light, maxDifference, error: gl.getError() };
    });
    assert.deepEqual(comparison.grid, [512, 512, 16]);
    assert.ok(comparison.relativeError < .002, 'Thin allocation must preserve the full-volume image');
    assert.ok(comparison.maxDifference < .02);
    assert.equal(comparison.error, 0);
    assert.deepEqual(errors, []);
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/volume-browser-results.json', JSON.stringify({ rows, comparison }, null, 2));
    console.log('PASS: thin-volume image equivalence and 400 seconds of orbits across thickness, radius and spin extremes.');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
