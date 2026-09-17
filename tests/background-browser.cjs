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
  const page = await context.newPage(),
    errors = [];
  const results = { date: new Date().toISOString() };
  fs.mkdirSync('test-results', { recursive: true });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const set = async (id, value) => {
    await page.locator('#' + id).fill(String(value));
    await page.locator('#' + id).dispatchEvent('input');
    assert.equal(await page.locator('#' + id + '-value').textContent(), value + '%');
  };
  try {
    await page.goto(
      (process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) +
        '?motion=fixed&ui=1'
    );
    await page.waitForFunction(
      () => window.GravityDemo?.cacheReady || !document.getElementById('error').hidden,
      null,
      { timeout: 180000 }
    );
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [GravityDemo.starDensity, GravityDemo.cloudDensity]), [1, 1]);
    await page.evaluate(() => {
      const d = GravityDemo,
        gl = d.gl;
      cancelAnimationFrame(d.raf);
      d.paused = true;
      d.updateParticles(0, d.fadeSeconds);
      d.spectrum.driven = 1;
      d.spectrum.levels.fill(0);
      d.deposit();
      const state = () => {
        const data = new Float32Array(d.count * d.particleStride);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return data;
      };
      gl.bindFramebuffer(gl.FRAMEBUFFER, d.rayTiles[0].finishFbo);
      const sky = new Float32Array(d.rw * d.rh * 4);
      gl.readPixels(0, 0, d.rw, d.rh, gl.RGBA, gl.FLOAT, sky);
      window.backgroundProbe = {
        cache: d.cacheBuilds,
        physics: state(),
        state,
        sky,
        read() {
          d.shade();
          d.present();
          gl.bindFramebuffer(gl.FRAMEBUFFER, d.hdrFbo);
          const pixels = new Float32Array(d.rw * d.rh * 4);
          gl.readPixels(0, 0, d.rw, d.rh, gl.RGBA, gl.FLOAT, pixels);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return pixels;
        },
        capture(name) {
          this[name] = this.read();
        },
        compare(name, reference) {
          let energy = 0,
            lit = 0,
            decreased = 0,
            capturedDifference = 0;
          for (let i = 0; i < this[name].length; i += 4) {
            let delta = 0;
            for (let c = 0; c < 3; c++) {
              const change = this[name][i + c] - this[reference][i + c];
              assertFinite(change);
              delta += change;
              if (change < -1e-7) decreased++;
              if (this.sky[i + 3] === 1) capturedDifference = Math.max(capturedDifference, Math.abs(change));
            }
            energy += delta;
            if (delta > 1e-5) lit++;
          }
          return { energy, lit, decreased, capturedDifference };
        }
      };
      function assertFinite(value) {
        if (!Number.isFinite(value)) throw new Error('Nonfinite background radiance');
      }
    });
    for (const [name, stars, clouds] of [
      ['empty', 0, 0],
      ['stars', 100, 0],
      ['moreStars', 500, 0],
      ['clouds', 0, 100],
      ['moreClouds', 0, 500]
    ]) {
      await set('star-density', stars);
      await set('cloud-density', clouds);
      await page.evaluate((name) => backgroundProbe.capture(name), name);
    }
    results.layers = await page.evaluate(() => {
      const p = backgroundProbe;
      return Object.fromEntries(
        ['stars', 'moreStars', 'clouds', 'moreClouds'].map((name) => [name, p.compare(name, 'empty')])
      );
    });
    for (const layer of Object.values(results.layers)) {
      assert.ok(layer.energy > 0 && layer.lit > 0);
      assert.equal(layer.decreased, 0);
      assert.equal(layer.capturedDifference, 0, 'Background light must not appear inside captured rays');
    }
    assert.ok(
      results.layers.moreStars.lit > results.layers.stars.lit * 2,
      'Higher star density must add stars'
    );
    assert.ok(
      results.layers.moreClouds.energy > results.layers.clouds.energy * 2,
      'Higher cloud density must thicken the clouds'
    );
    assert.equal(
      await page.evaluate(() => backgroundProbe.compare('moreStars', 'stars').decreased),
      0,
      'Adding stars must preserve existing ones'
    );
    assert.equal(await page.evaluate(() => backgroundProbe.compare('moreClouds', 'clouds').decreased), 0);
    for (const [name, stars, clouds] of [
      ['background-default', 100, 100],
      ['background-dense', 500, 500],
      ['background-clear', 0, 0]
    ]) {
      await set('star-density', stars);
      await set('cloud-density', clouds);
      await page.evaluate(() => {
        GravityDemo.spectrum.driven = 0;
        GravityDemo.deposit();
        GravityDemo.shade();
        GravityDemo.present();
        document.getElementById('star-density').scrollIntoView({ block: 'center' });
      });
      await page.screenshot({ path: 'test-results/' + name + '.png' });
    }
    assert.ok(
      await page.evaluate(() => backgroundProbe.state().every((v, i) => v === backgroundProbe.physics[i]))
    );
    assert.equal(
      await page.evaluate(() => GravityDemo.cacheBuilds),
      await page.evaluate(() => backgroundProbe.cache)
    );
    await set('star-density', 250);
    await set('cloud-density', 25);
    await page.evaluate(() => {
      const d = GravityDemo;
      backgroundProbe.extension = d.gl.getExtension('WEBGL_lose_context');
      d.raf = requestAnimationFrame((t) => d.frame(t));
      backgroundProbe.extension.loseContext();
    });
    await page.waitForFunction(() => GravityDemo.lost);
    await page.evaluate(() => backgroundProbe.extension.restoreContext());
    await page.waitForFunction(() => !GravityDemo.lost && GravityDemo.cacheReady, null, { timeout: 180000 });
    assert.deepEqual(
      await page.evaluate(() => {
        const d = GravityDemo,
          gl = d.gl;
        d.shade();
        d.present();
        return ['uStarDensity', 'uCloudDensity'].map((name) =>
          gl.getUniform(d.programs.shade.p, gl.getUniformLocation(d.programs.shade.p, name))
        );
      }),
      [2.5, 0.25]
    );
    assert.equal(await page.evaluate(() => GravityDemo.gl.getError()), 0);
    assert.deepEqual(errors, []);
    results.passed = true;
    fs.writeFileSync('test-results/background-browser-results.json', JSON.stringify(results, null, 2));
    console.log(
      'PASS: independent sky layers, added stars, cloud opacity, captured-ray masking, unchanged physics/cache and context restoration.',
      results.layers
    );
  } finally {
    if (!results.passed)
      fs.writeFileSync(
        'test-results/background-browser-failure.json',
        JSON.stringify({ ...results, errors }, null, 2)
      );
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
