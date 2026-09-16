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
  const results = { date: new Date().toISOString(), checks: [] };
  fs.mkdirSync('test-results', { recursive: true });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const ready = async () => {
    await page.waitForFunction(
      () => window.GravityDemo?.cacheReady || !document.getElementById('error').hidden,
      null,
      { timeout: 180000 }
    );
    assert.equal(
      await page.locator('#error').isVisible(),
      false,
      await page.locator('#error-text').textContent()
    );
  };
  try {
    await page.goto(
      (process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) +
        '?motion=fixed&ui=1'
    );
    await ready();
    assert.equal(
      await page.locator('#audio-response, #reveal-controls, #audio-mapping, #visual-test').count(),
      0
    );
    await page.evaluate(() => {
      const d = GravityDemo;
      cancelAnimationFrame(d.raf);
      d.paused = true;
      d.updateParticles(0, d.fadeSeconds);
      d.palette.hsv.animated = false;
      d.palette.setOffset(0);
      d.refreshPalette(true);
      const hash = (bytes) => {
        let h = 5381;
        for (const byte of bytes) h = (Math.imul(h, 33) + byte) >>> 0;
        return h;
      };
      window.responseProbe = {
        read(buffer, length) {
          const gl = d.gl,
            values = new Float32Array(length);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.getBufferSubData(gl.ARRAY_BUFFER, 0, values);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          return values;
        },
        physics() {
          return this.read(d.particleBuffers[d.particleIndex], d.count * d.particleStride);
        },
        state() {
          return hash(new Uint8Array(this.physics().buffer));
        },
        pixels() {
          const gl = d.gl;
          d.deposit();
          d.shade();
          d.present();
          const bytes = new Uint8Array(d.canvas.width * d.canvas.height * 4);
          gl.readPixels(0, 0, d.canvas.width, d.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          return bytes;
        },
        image() {
          return hash(this.pixels());
        }
      };
      d.spectrum.levels.fill(0.35);
      d.spectrum.attacks.fill(0);
      d.spectrum.driven = 1;
      d.refreshPalette(true);
    });
    const original = await page.evaluate(() => ({
      state: responseProbe.state(),
      cache: GravityDemo.cacheBuilds,
      camera: JSON.stringify(GravityDemo.camera)
    }));
    results.counts = await page.evaluate(() => {
      const d = GravityDemo,
        gl = d.gl,
        original = d.programs.deposit;
      d.programs.deposit = d.program(GravityShaders.depositVertex, GravityShaders.depositFragment, [
        'vWeight',
        'vColor'
      ]);
      const tf = gl.createTransformFeedback(),
        buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, d.count * 64, gl.DYNAMIC_READ);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const capture = (level) => {
        d.spectrum.levels.fill(level);
        const draw = gl.drawArraysInstanced;
        gl.drawArraysInstanced = () => {};
        try {
          d.deposit();
        } finally {
          gl.drawArraysInstanced = draw;
        }
        gl.bindVertexArray(d.particleVAOs[d.particleIndex]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArraysInstanced(gl.POINTS, 0, d.count, 4);
        gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.bindVertexArray(null);
        const data = responseProbe.read(buffer, d.count * 16),
          weights = new Float32Array(d.count);
        for (let n = 0; n < 4; n++)
          for (let i = 0; i < d.count; i++) weights[i] += data[(n * d.count + i) * 4];
        return { data, weights };
      };
      const full = capture(1),
        rows = [],
        previous = new Float32Array(d.count);
      for (const level of [0, 0.25, 0.5, 0.75, 1]) {
        const sample = capture(level);
        let eligible = 0,
          lit = 0,
          partial = 0,
          changedColor = 0,
          reversed = 0;
        for (let i = 0; i < d.count; i++) {
          if (full.weights[i] <= 1e-8) continue;
          eligible++;
          const ratio = sample.weights[i] / full.weights[i];
          if (ratio > 0.5) lit++;
          if (ratio > 0.0001 && ratio < 0.9999) partial++;
          if (sample.weights[i] < previous[i]) reversed++;
          previous[i] = sample.weights[i];
          for (let c = 1; c <= 3; c++) if (sample.data[i * 4 + c] !== full.data[i * 4 + c]) changedColor++;
        }
        rows.push({ level, fraction: lit / eligible, partial: partial / eligible, changedColor, reversed });
      }
      gl.deleteProgram(d.programs.deposit.p);
      gl.deleteBuffer(buffer);
      gl.deleteTransformFeedback(tf);
      d.programs.deposit = original;
      d.spectrum.levels.fill(0.2);
      return rows;
    });
    for (const row of results.counts) {
      assert.ok(Math.abs(row.level - row.fraction) < 0.025);
      assert.ok(row.partial < 0.065);
      assert.equal(row.changedColor, 0);
      assert.equal(row.reversed, 0);
    }
    assert.equal(results.counts[0].fraction, 0);
    assert.equal(results.counts.at(-1).fraction, 1);
    results.checks.push(
      'GPU count proportions, constant audio brightness, narrow soft transition, monotonic selection and zero/full endpoints'
    );

    for (const mode of ['solid', 'custom', 'hsv']) {
      await page.locator('#color-mode').selectOption(mode);
      await page.evaluate(() => {
        GravityDemo.spectrum.driven = 1;
        responseProbe.image();
      });
      assert.equal(await page.evaluate(() => GravityDemo.gl.getError()), 0);
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        state: responseProbe.state(),
        cache: GravityDemo.cacheBuilds,
        camera: JSON.stringify(GravityDemo.camera)
      })),
      original
    );
    await page.evaluate(() => {
      const d = GravityDemo,
        extension = d.gl.getExtension('WEBGL_lose_context');
      responseProbe.contextExtension = extension;
      d.raf = requestAnimationFrame((t) => d.frame(t));
      extension.loseContext();
    });
    await page.waitForFunction(() => GravityDemo.lost);
    await page.evaluate(() => responseProbe.contextExtension.restoreContext());
    await page.waitForFunction(() => !GravityDemo.lost && GravityDemo.cacheReady, null, { timeout: 180000 });
    assert.equal(
      await page.evaluate(() => {
        GravityDemo.deposit();
        GravityDemo.shade();
        GravityDemo.present();
        return GravityDemo.gl.getError();
      }),
      0
    );
    assert.deepEqual(errors, []);
    results.checks.push(
      'Soft count only, all palettes, unchanged physics and ray cache, and context restoration'
    );
    results.passed = true;
    fs.writeFileSync('test-results/response-browser-results.json', JSON.stringify(results, null, 2));
    console.log('PASS', results.checks, results.counts);
  } finally {
    if (!results.passed)
      fs.writeFileSync(
        'test-results/response-browser-failure.json',
        JSON.stringify({ ...results, errors }, null, 2)
      );
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
