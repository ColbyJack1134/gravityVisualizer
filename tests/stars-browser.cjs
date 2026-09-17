const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP
    ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({ channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const slider = async (id, value) => {
    await page.locator('#' + id).fill(String(value));
    await page.locator('#' + id).dispatchEvent('input');
    assert.equal(await page.locator('#' + id + '-value').textContent(), value + '%');
  };
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) +
      '?motion=fixed&ui=1');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed,
      null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    assert.equal(await page.locator('#star-appearance').inputValue(), 'compact');
    assert.equal(await page.locator('#star-detail').inputValue(), 'standard');
    assert.equal(await page.locator('#core-sizing').inputValue(), 'fixed');
    assert.deepEqual(await page.locator('#star-appearance option').allTextContents(), ['Compact', 'Soft']);
    assert.equal(await page.locator('#star-definition-controls').isVisible(), true);
    await page.evaluate(() => {
      const d = GravityDemo, gl = d.gl;
      d.setSuspended(true);
      d.paused = true;
      d.updateParticles(0, d.fadeSeconds);
      d.deposit(); d.shade();
      const state = () => {
        const data = new Float32Array(d.count * d.particleStride);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return data;
      };
      window.starProbe = {
        cache: d.cacheBuilds, physics: state(), state,
        capture(name) {
          d.present();
          const pixels = new Uint8Array(d.canvas.width * d.canvas.height * 4);
          gl.readPixels(0, 0, d.canvas.width, d.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          this[name] = pixels;
        },
        difference(a, b) {
          return this[a].reduce((sum, v, i) => sum + Math.abs(v - this[b][i]), 0);
        },
        same(a, b) {
          return this[a].every((v, i) => Math.abs(v - this[b][i]) <= 2) &&
            this.difference(a, b) / this[a].length < .001;
        }
      };
    });
    await page.locator('#star-appearance').selectOption('soft');
    assert.equal(await page.locator('#star-definition-controls').isVisible(), false);
    await page.evaluate(() => starProbe.capture('soft'));
    await page.locator('#star-appearance').selectOption('compact');
    assert.equal(await page.locator('#star-definition-controls').isVisible(), true);
    await slider('star-definition', 75);
    await page.evaluate(() => starProbe.capture('compact'));
    assert.ok(await page.evaluate(() => starProbe.difference('soft', 'compact')) > 100000);
    await page.locator('#core-sizing').selectOption('adaptive');
    await page.evaluate(() => starProbe.capture('adaptive'));
    assert.ok(await page.evaluate(() => starProbe.difference('compact', 'adaptive')) > 10000);
    await page.locator('#core-sizing').selectOption('fixed');
    await page.evaluate(() => starProbe.capture('fixed'));
    assert.ok(await page.evaluate(() => starProbe.same('compact', 'fixed')));
    await slider('star-definition', 0);
    await page.evaluate(() => starProbe.capture('zero'));
    assert.ok(await page.evaluate(() => starProbe.same('soft', 'zero')));
    await page.locator('#star-appearance').selectOption('soft');
    await page.evaluate(() => starProbe.capture('restored'));
    assert.ok(await page.evaluate(() => starProbe.same('soft', 'restored')));
    assert.ok(await page.evaluate(() => starProbe.state().every((v, i) => v === starProbe.physics[i])));
    assert.equal(await page.evaluate(() => GravityDemo.cacheBuilds === starProbe.cache), true);
    await page.locator('#star-detail').selectOption('fine');
    await page.evaluate(() => { GravityDemo.deposit(); GravityDemo.shade(); starProbe.capture('fine'); });
    assert.deepEqual(await page.evaluate(() => GravityDemo.volumeGrid), [768, 768, 16]);
    assert.ok(await page.evaluate(() => starProbe.difference('soft', 'fine')) > 100000);
    await page.locator('#star-detail').selectOption('standard');
    await page.evaluate(() => { GravityDemo.deposit(); GravityDemo.shade(); starProbe.capture('standard'); });
    assert.ok(await page.evaluate(() => starProbe.same('soft', 'standard')));
    assert.ok(await page.evaluate(() => starProbe.state().every((v, i) => v === starProbe.physics[i])));
    assert.equal(await page.evaluate(() => GravityDemo.cacheBuilds === starProbe.cache), true);

    const profiles = await page.evaluate(() => {
      const d = GravityDemo, gl = d.gl;
      const saved = Object.fromEntries(['overscan', 'roll', 'cameraTime', 'framing', 'framingY',
        'sharpness', 'starDefinition', 'coreSizing'].map(key => [key, d[key]]));
      Object.assign(d, { overscan: 1, roll: 0, cameraTime: 0, framing: 0, framingY: 0,
        sharpness: 1, starDefinition: 1 });
      const data = new Float32Array(d.rw * d.rh * 4), rows = [];
      const readSize = 80, pixels = new Uint8Array(readSize * readSize * 4);
      function source(sigma, phase, foreground = true) {
        data.fill(0);
        for (let y = d.rh / 2 - 20; y < d.rh / 2 + 20; y++)
          for (let x = d.rw / 2 - 20; x < d.rw / 2 + 20; x++) {
            const light = 0.2 * Math.exp(-((x + .5 - d.rw / 2 - phase) ** 2 +
              (y + .5 - d.rh / 2) ** 2) / (2 * sigma * sigma));
            data.set([light, light * .45, light * .08, foreground ? light : 0], (y * d.rw + x) * 4);
          }
        gl.bindTexture(gl.TEXTURE_2D, d.hdr);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, d.rw, d.rh, gl.RGBA, gl.FLOAT, data);
      }
      function profile() {
        d.present();
        gl.readPixels(d.canvas.width / 2 - readSize / 2, d.canvas.height / 2 - readSize / 2,
          readSize, readSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let light = 0, peak = 0, cx = 0, cy = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const v = (pixels[i] / 255) ** 2.2;
          light += v; peak = Math.max(peak, v);
          cx += v * (i / 4 % readSize); cy += v * Math.floor(i / 4 / readSize);
        }
        cx /= light; cy /= light;
        let spread = 0;
        for (let i = 0; i < pixels.length; i += 4)
          spread += (pixels[i] / 255) ** 2.2 * ((i / 4 % readSize - cx) ** 2 +
            (Math.floor(i / 4 / readSize) - cy) ** 2);
        return { light, peak, width: Math.sqrt(spread / light), cx };
      }
      for (const sigma of [0.9, 1.8, 4.5]) for (const mode of ['soft', 'compact', 'adaptive']) {
        d.starAppearance = mode === 'soft' ? 'soft' : 'compact';
        d.coreSizing = mode === 'adaptive' ? 'adaptive' : 'fixed';
        const values = [];
        for (let step = 0; step <= 16; step++) {
          source(sigma, step / 16);
          values.push(profile());
        }
        rows.push({ sigma, mode, values });
      }
      source(1.8, .5, false);
      d.starAppearance = 'soft'; profile(); const background = pixels.slice();
      d.starAppearance = 'compact'; d.coreSizing = 'adaptive'; profile();
      const backgroundDifference = pixels.reduce((sum, v, i) => sum + Math.abs(v - background[i]), 0);
      Object.assign(d, saved);
      d.deposit(); d.shade();
      return { rows, backgroundDifference };
    });
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/stars-browser-results.json', JSON.stringify(profiles, null, 2));
    const variation = values => Math.max(...values) / Math.min(...values) - 1;
    for (const row of profiles.rows) {
      row.fluxVariation = variation(row.values.map(v => v.light));
      assert.ok(row.fluxVariation < .08, `${row.mode} pulses as a ${row.sigma}-pixel core moves`);
      assert.ok(row.values.every(v => Number.isFinite(v.width) && v.light > 0));
      for (let i = 1; i < row.values.length; i++)
        assert.ok(row.values[i].cx > row.values[i - 1].cx, 'A moving core must not snap between pixels');
      if (row.mode === 'compact') {
        const soft = profiles.rows.find(v => v.sigma === row.sigma && v.mode === 'soft');
        assert.ok(row.values[8].width < soft.values[8].width, 'Compact must tighten the light profile');
      }
      if (row.mode === 'adaptive' && row.sigma === 4.5) {
        const fixed = profiles.rows.find(v => v.sigma === row.sigma && v.mode === 'compact');
        assert.ok(row.values[8].width < fixed.values[8].width * .95, 'Adaptive sizing must tighten large cores');
      }
    }
    assert.equal(profiles.backgroundDifference, 0, 'Foreground styles must preserve background-only light');
    await page.evaluate(() => {
      GravityDemo.applySettings({ starAppearance: 'compact', starDefinition: .65, coreSizing: 'adaptive', starDetail: 'fine' });
      GravityDemo.setSuspended(false);
      window.contextRecovery = GravityDemo.gl.getExtension('WEBGL_lose_context');
      contextRecovery.loseContext();
    });
    await page.waitForFunction(() => GravityDemo.lost);
    await page.evaluate(() => contextRecovery.restoreContext());
    await page.waitForFunction(() => !GravityDemo.lost && GravityDemo.cacheReady, null, { timeout: 180000 });
    assert.deepEqual(await page.evaluate(() => {
      const d = GravityDemo;
      d.present();
      return [d.starAppearance, d.starDefinition, d.coreSizing, d.starDetail, d.volumeGrid, d.gl.getError()];
    }), ['compact', .65, 'adaptive', 'fine', [768, 768, 16], 0]);
    assert.equal(await page.locator('#star-appearance').inputValue(), 'compact');
    assert.deepEqual(errors, []);
    fs.writeFileSync('test-results/stars-browser-results.json', JSON.stringify(profiles, null, 2));
    console.log('PASS: star controls, baseline restore, compact profiles, continuous motion, background isolation and context recovery.');
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
