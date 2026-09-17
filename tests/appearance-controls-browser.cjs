const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 720}});
  const page = await context.newPage(), errors = [], results = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const ready = async () => {
    await page.waitForFunction(() => GravityDemo?.cacheReady || GravityDemo?.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
  };
  const slider = async (id, value) => {
    await page.locator('#' + id).fill(String(value));
    await page.locator('#' + id).dispatchEvent('input');
  };
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?motion=fixed&ui=1');
    await ready();
    assert.deepEqual(await page.evaluate(() => [GravityDemo.brightnessMin, GravityDemo.brightnessMax, GravityDemo.cloudRadius]), [.65, 1.4, 22]);
    assert.equal(await page.locator('#radial-dimming').inputValue(), '50');
    for (const id of ['cloud-thickness', 'edge-softness']) assert.equal(await page.locator('#' + id).inputValue(), '100');
    for (const [id, section] of [['brightness-min', 'Star appearance'], ['brightness-max', 'Star appearance'], ['radial-dimming', 'Star appearance'], ['cloud-radius', 'Material & light'], ['cloud-thickness', 'Material & light'], ['edge-softness', 'Material & light']])
      assert.equal(await page.locator('#' + id).evaluate(el => el.closest('section').querySelector('h2').textContent), section);
    await page.evaluate(() => {
      const d = GravityDemo; d.paused = true; d.updateParticles(0, d.fadeSeconds);
      window.appearanceState = {emission: d.emission, velocity: d.velocity, builds: d.cacheBuilds,
        particles: d.particleBuffers.slice(), width: d.emissionWidth, height: d.emissionHeight};
    });
    results.brightness = await page.evaluate(() => {
      const d = GravityDemo, gl = d.gl, original = d.programs.deposit;
      const program = d.program(GravityShaders.depositVertex, GravityShaders.depositFragment, ['vColor', 'vWeight']);
      const feedback = gl.createTransformFeedback(), buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, d.count * 16, gl.DYNAMIC_READ); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      d.programs.deposit = program;
      const capture = (min, max, radialDimming = 1, edgeSoftness = 1) => {
        d.applySettings({brightnessMin: min, brightnessMax: max, radialDimming, edgeSoftness}); d.deposit();
        gl.bindVertexArray(d.particleVAOs[d.particleIndex]); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer); gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, d.count); gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null); gl.bindVertexArray(null);
        const values = new Float32Array(d.count * 4); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, values); gl.bindBuffer(gl.ARRAY_BUFFER, null); return values;
      };
      const initial = capture(.65, 1.4), one = capture(1, 1), two = capture(2, 2), zero = capture(0, 0), restored = capture(.65, 1.4);
      let minimum = Infinity, maximum = 0, error = 0, weightsUnchanged = true, black = true, stable = true;
      for (let i = 0; i < one.length; i++) {
        if (i % 4 === 3) weightsUnchanged &&= one[i] === two[i] && one[i] === zero[i];
        else {
          error = Math.max(error, Math.abs(two[i] - 2 * one[i])); black &&= zero[i] === 0;
          if (one[i] > 1e-5) { const ratio = initial[i] / one[i]; minimum = Math.min(minimum, ratio); maximum = Math.max(maximum, ratio); }
        }
        stable &&= initial[i] === restored[i];
      }
      const savedPalette = {mode: d.idlePalette.mode, solid: d.idlePalette.solid};
      d.idlePalette.apply({mode: 'solid', solid: '#ffffff'}); d.refreshPalette(true);
      const full = capture(1, 1), reduced = capture(1, 1, .5), off = capture(1, 1, 0);
      let uniformOff = true, between = true, sameWeight = true, lifted = 0;
      for (let i = 0; i < off.length; i++) {
        if (i % 4 === 3) sameWeight &&= off[i] === full[i] && off[i] === reduced[i];
        else {
          uniformOff &&= Math.abs(off[i] - 1.526) < 1e-5;
          between &&= full[i] <= reduced[i] + 1e-6 && reduced[i] <= off[i] + 1e-6;
          if (reduced[i] > full[i] + .01) lifted++;
        }
      }
      d.idlePalette.apply(savedPalette); d.refreshPalette(true);
      const dimmingRestored = capture(.65, 1.4).every((value, i) => value === initial[i]);
      const material = d.material; d.material = 1;
      const positions = new Float32Array(d.particleStride * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, positions);
      for (const [i, r] of [8, GravityPhysics.isco(d.a()) * .86 + .2, d.cloudRadius + .25].entries())
        positions.set([Math.sqrt(r * r + d.a() * d.a()), 0, 0], i * d.particleStride);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const softEdge = capture(1, 1), sharpEdge = capture(1, 1, 1, 0), restoredEdge = capture(1, 1);
      const edges = {soft: [3, 7, 11].map(i => softEdge[i]), sharp: [3, 7, 11].map(i => sharpEdge[i]),
        restored: softEdge.every((v, i) => v === restoredEdge[i])};
      d.applySettings({material, brightnessMin: .65, brightnessMax: 1.4});
      d.programs.deposit = original; gl.deleteProgram(program.p); gl.deleteBuffer(buffer); gl.deleteTransformFeedback(feedback);
      return {minimum, maximum, error, weightsUnchanged, black, stable, uniformOff, between, lifted, sameWeight, dimmingRestored, edges, glError: gl.getError()};
    });
    assert.ok(results.brightness.minimum >= .64999 && results.brightness.minimum < .66);
    assert.ok(results.brightness.maximum <= 1.40001 && results.brightness.maximum > 1.39);
    assert.ok(results.brightness.error < 1e-6 && results.brightness.weightsUnchanged && results.brightness.black && results.brightness.stable);
    assert.equal(results.brightness.glError, 0);
    assert.ok(results.brightness.uniformOff && results.brightness.between && results.brightness.sameWeight && results.brightness.dimmingRestored);
    assert.ok(results.brightness.lifted > 10000);
    const {soft, sharp, restored} = results.brightness.edges;
    assert.ok(soft[0] > 0 && sharp[0] === soft[0], 'Edge softness preserves interior material');
    assert.ok(sharp[1] > soft[1] && soft[1] > 0, 'A sharper inner edge narrows the fade');
    assert.ok(sharp[2] === 0 && soft[2] > 0, 'A sharper outer edge removes the extended fade');
    assert.ok(restored, 'Restoring edge softness restores the same emission');
    for (const percent of [0, 50, 100]) {
      await slider('radial-dimming', percent);
      assert.equal(await page.locator('#radial-dimming-value').textContent(), percent + '%');
      assert.equal(await page.evaluate(() => {
        const d = GravityDemo; d.deposit();
        return d.gl.getUniform(d.programs.deposit.p, d.gl.getUniformLocation(d.programs.deposit.p, 'uRadialDimming'));
      }), percent / 100);
    }
    for (const percent of [0, 50, 100]) {
      await slider('edge-softness', percent);
      assert.equal(await page.locator('#edge-softness-value').textContent(), percent + '%');
      assert.equal(await page.evaluate(() => {
        const d = GravityDemo; d.deposit();
        return d.gl.getUniform(d.programs.deposit.p, d.gl.getUniformLocation(d.programs.deposit.p, 'uEdgeSoftness'));
      }), percent / 100);
    }
    await slider('brightness-min', 200);
    assert.equal(await page.locator('#brightness-max').inputValue(), '200');
    await slider('brightness-max', 50);
    assert.equal(await page.locator('#brightness-min').inputValue(), '50');
    await slider('brightness-max', 140); await slider('brightness-min', 65);
    assert.ok(await page.evaluate(() => GravityDemo.cacheBuilds === appearanceState.builds &&
      GravityDemo.particleBuffers.every((value, i) => value === appearanceState.particles[i])));
    results.radius = [];
    for (const percent of [150, 60, 100]) {
      const before = await page.evaluate(() => GravityDemo.cacheBuilds);
      await slider('cloud-radius', percent);
      await page.waitForFunction(builds => GravityDemo.cacheBuilds > builds, before);
      await ready();
      const radius = await page.evaluate(() => {
        const d = GravityDemo, gl = d.gl, data = new Float32Array(d.count * d.particleStride);
        gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data); gl.bindBuffer(gl.ARRAY_BUFFER, null);
        let min = Infinity, max = 0, outer = 0;
        for (let i = 0; i < data.length; i += d.particleStride) {
          const r = GravityPhysics.metric(Array.from(data.subarray(i, i + 3)), d.a()).r;
          min = Math.min(min, r); max = Math.max(max, r); if (r > 24) outer++;
        }
        d.updateParticles(0, d.fadeSeconds); d.deposit(); d.shade(); d.present();
        const pixels = new Uint8Array(d.canvas.width * d.canvas.height * 4); gl.readPixels(0, 0, d.canvas.width, d.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let lit = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 40) lit++;
        return {radius: d.cloudRadius, min, max, outer, lit, count: d.count, builds: d.cacheBuilds,
          extent: d.volumeExtent, cells: d.volumeExtent.map((v, i) => 2 * v / d.volumeGrid[i]),
          sameTextures: d.emission === appearanceState.emission && d.velocity === appearanceState.velocity &&
            d.emissionWidth === appearanceState.width && d.emissionHeight === appearanceState.height,
          traceScale: gl.getUniform(d.programs.trace.p, gl.getUniformLocation(d.programs.trace.p, 'uVolumeScale')), error: gl.getError()};
      });
      assert.ok(Math.abs(radius.radius - percent * .22) < 1e-6);
      assert.ok(radius.max <= radius.radius + .02 && radius.max > radius.radius - .1);
      assert.ok(radius.min > 5 && radius.lit > 1000);
      assert.equal(radius.count, 65536); assert.equal(radius.builds, before + 1); assert.equal(radius.sameTextures, true);
      assert.ok(Math.max(...radius.cells) - Math.min(...radius.cells) < 1e-8);
      assert.equal(radius.traceScale, Math.max(1, percent / 100)); assert.equal(radius.error, 0);
      if (percent === 150) assert.ok(radius.outer > 10000 && radius.extent[0] > 34);
      results.radius.push(radius);
      await page.screenshot({path: `test-results/cloud-radius-${percent}.png`});
      if (percent === 150) {
        const recycling = await page.evaluate(() => {
          const d = GravityDemo, gl = d.gl;
          const place = x => {
            const position = [x, 0, 0], momentum = GravityPhysics.massiveMomentum(position, [0, .15, 0], d.a());
            gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([...position, 200, ...momentum.p, momentum.pt, 3, -1]));
            gl.bindBuffer(gl.ARRAY_BUFFER, null); d.updateParticles(0, 0);
            const data = new Float32Array(d.particleStride); gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data); gl.bindBuffer(gl.ARRAY_BUFFER, null); return Array.from(data);
          };
          return {inside: place(31), outside: place(42)};
        });
        assert.deepEqual(recycling.inside.slice(0, 4), [31, 0, 0, 200]);
        assert.ok(Math.hypot(...recycling.outside.slice(0, 3)) < 33.1);
        assert.equal(recycling.outside[8], 0);
      }
    }
    await page.evaluate(() => {
      const d = GravityDemo; d.simTime = 0; d.allocateParticles(); d.updateParticles(0, d.fadeSeconds);
      window.readShape = () => {
        const data = new Float32Array(d.count * d.particleStride), gl = d.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, d.particleBuffers[d.particleIndex]); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data); gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return data;
      };
      window.originalShape = readShape();
    });
    const builds = await page.evaluate(() => GravityDemo.cacheBuilds);
    results.thickness = [];
    for (const percent of [0, 25, 100]) {
      await slider('cloud-thickness', percent);
      await page.waitForFunction(value => GravityDemo.cloudThickness === value / 100, percent);
      assert.equal(await page.locator('#cloud-thickness-value').textContent(), percent + '%');
      const shape = await page.evaluate(percent => {
        const d = GravityDemo, data = readShape();
        let z2 = 0, baseZ2 = 0, visible = true;
        for (let i = 0; i < data.length; i += d.particleStride) {
          z2 += data[i + 2] ** 2; baseZ2 += originalShape[i + 2] ** 2;
          visible &&= data[i + 8] >= d.fadeSeconds;
        }
        if (percent === 0) for (let i = 0; i < 200; i++) d.updateParticles(.2, .02);
        const planar = percent !== 0 || readShape().every((v, i) => i % d.particleStride !== 2 || Math.abs(v) < 1e-7);
        d.deposit(); d.shade(); d.present();
        return {percent, heightRatio: Math.sqrt(z2 / baseZ2), visible, planar, count: d.count,
          restored: data.every((v, i) => v === originalShape[i]), builds: d.cacheBuilds, error: d.gl.getError()};
      }, percent);
      assert.ok(Math.abs(shape.heightRatio - percent / 100) < .01);
      assert.ok(shape.visible && shape.planar); assert.equal(shape.error, 0);
      assert.equal(shape.count, 65536); assert.equal(shape.builds, builds);
      if (percent === 100) assert.ok(shape.restored, '100% restores the original particle distribution');
      results.thickness.push(shape);
      await page.screenshot({path: `test-results/cloud-thickness-${percent}.png`});
    }
    const valid = await page.evaluate(() => [GravityDemo.cloudRadius, GravityDemo.brightnessMin, GravityDemo.brightnessMax, GravityDemo.cloudThickness, GravityDemo.edgeSoftness]);
    await page.evaluate(() => GravityDemo.applySettings({cloudRadius: NaN, brightnessMin: Infinity, brightnessMax: NaN, cloudThickness: NaN, edgeSoftness: Infinity}));
    assert.deepEqual(await page.evaluate(() => [GravityDemo.cloudRadius, GravityDemo.brightnessMin, GravityDemo.brightnessMax, GravityDemo.cloudThickness, GravityDemo.edgeSoftness]), valid);
    assert.deepEqual(errors, []);
    results.passed = true;
    console.log('PASS: brightness, radius, orbital thickness, edge softness, baseline restoration and live controls.');
  } finally {
    fs.mkdirSync('test-results', {recursive: true});
    fs.writeFileSync('test-results/appearance-controls-results.json', JSON.stringify({...results, errors}, null, 2));
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
