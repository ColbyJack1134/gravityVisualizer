const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 720}});
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await page.goto((process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href) + '?motion=fixed&ui=1');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed, null, {timeout: 180000});
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    await page.evaluate(() => { GravityDemo.setSuspended(true); GravityDemo.paused = true; });
    const builds = await page.evaluate(() => GravityDemo.cacheBuilds);
    await page.evaluate(() => {
      for (const [id, value] of [['camera-roll', -20], ['framing', 15], ['framing-y', -10]]) {
        const input = document.getElementById(id); input.value = value;
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
    });
    await page.waitForFunction(n => GravityDemo.cacheBuilds > n, builds);
    assert.deepEqual(await page.evaluate(() => [GravityDemo.cacheBuilds,
      Math.round(GravityDemo.cacheRoll * 180 / Math.PI), ...GravityDemo.cacheFraming]), [builds + 1, -20, .15, -.1]);
    for (const scene of [
      {width: 1280, height: 720, radius: 33, distance: 37, elevation: 18, roll: 15, x: .03, y: .1},
      {width: 1280, height: 720, radius: 33, distance: 32, elevation: 5, roll: -30, x: -.35, y: .2},
      {width: 960, height: 270, radius: 22, distance: 85, elevation: 80, roll: 30, x: .35, y: -.2},
      {width: 375, height: 812, radius: 33, distance: 37, elevation: 18, roll: -30, x: -.35, y: -.2},
      {width: 640, height: 360, radius: 33, distance: 10, elevation: 5, roll: 180, x: -1, y: 1},
      {width: 640, height: 180, radius: 33, distance: 150, elevation: 80, roll: -180, x: 1, y: -1},
      {width: 300, height: 600, radius: 33, distance: 150, elevation: -45, roll: 180, x: -1, y: -1}
    ]) {
      await page.setViewportSize({width: scene.width, height: scene.height});
      await page.waitForTimeout(200);
      const result = await page.evaluate(async scene => {
        const d = GravityDemo, gl = d.gl;
        d.applySettings({cloudRadius: scene.radius, distance: scene.distance, elevation: scene.elevation,
          roll: scene.roll * Math.PI / 180, framing: scene.x, framingY: scene.y});
        while (d.job) { d.advanceTrace(); await new Promise(r => setTimeout(r, 0)); }
        d.simTime = 0; d.allocateParticles(); d.updateParticles(0, d.fadeSeconds);
        for (let i = 0; i < 200; i++) d.updateParticles(.2, .02);
        d.deposit(); d.shade(); d.present();
        window.cameraImage = d.canvas.toDataURL();
        const original = d.programs.composite;
        const source = GravityShaders.composite;
        const probe = d.program(GravityShaders.fullscreen, source.slice(0, source.lastIndexOf('void main(){')) +
          'void main(){color=vec4(viewUV(uv),0.,1.);}');
        const target = d.texture(d.canvas.width, d.canvas.height, gl.RGBA32F), framebuffer = d.fbo([target]);
        const points = [[0, 0], [d.canvas.width - 1, 0], [0, d.canvas.height - 1],
          [d.canvas.width - 1, d.canvas.height - 1], [Math.floor(d.canvas.width / 2), Math.floor(d.canvas.height / 2)]];
        let minimumMargin = 1, maxRayError = 0;
        const builds = d.cacheBuilds, savedOffset = d.spectrum.offset;
        for (let time = 0; time <= 200; time += 5) {
          d.cameraTime = time;
          for (const sign of [-1, 1]) {
            d.spectrum.offset = () => [sign * .008, -sign * .006, sign * .0025];
            d.programs.composite = probe; d.present();
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); d.quad();
            const roll = gl.getUniform(probe.p, gl.getUniformLocation(probe.p, 'uRoll'));
            const framing = gl.getUniform(probe.p, gl.getUniformLocation(probe.p, 'uFraming'));
            for (const [x, y] of points) {
              const sample = new Float32Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, sample);
              minimumMargin = Math.min(minimumMargin, sample[0], sample[1], 1 - sample[0], 1 - sample[1]);
              const aspect = d.canvas.width / d.canvas.height;
              const rotate = (x, y, a) => [Math.cos(a) * x + Math.sin(a) * y, -Math.sin(a) * x + Math.cos(a) * y];
              const expected = rotate(((x + .5) / d.canvas.width - .5) * aspect - framing[0],
                (y + .5) / d.canvas.height - .5 - framing[1], roll + d.cacheRoll);
              const actual = rotate((sample[0] - .5) * aspect * d.overscan - d.cacheFraming[0],
                (sample[1] - .5) * d.overscan - d.cacheFraming[1], d.cacheRoll);
              maxRayError = Math.max(maxRayError, Math.hypot(actual[0] - expected[0], actual[1] - expected[1]));
            }
          }
        }
        d.programs.composite = original; d.spectrum.offset = savedOffset; d.cameraTime = 0; d.present();
        gl.deleteProgram(probe.p); gl.deleteTexture(target); gl.deleteFramebuffer(framebuffer);
        return {scene, minimumMargin, maxRayError, reused: builds === d.cacheBuilds,
          render: [d.rw, d.rh], overscan: d.overscan, rays: d.diagnostics(), error: gl.getError()};
      }, scene);
      assert.ok(result.minimumMargin >= .035, 'Animated corners must stay inside the unfaded image');
      assert.ok(result.maxRayError < 1e-6, 'Camera rebasing must preserve the requested view');
      assert.ok(result.reused); assert.equal(result.rays.invalid, 0); assert.equal(result.rays.budget, 0); assert.equal(result.error, 0);
      results.push(result);
      if (scene.width === 1280 && scene.roll === 15) {
        assert.equal(result.overscan, 1.2); assert.deepEqual(result.render, [832, 468]);
        const image = await page.evaluate(() => cameraImage);
        fs.writeFileSync('test-results/camera-cutoff-fixed.png', Buffer.from(image.split(',')[1], 'base64'));
      }
    }
    await page.setViewportSize({width: 480, height: 240});
    await page.waitForTimeout(200);
    assert.deepEqual(await page.locator('#elevation').evaluate(el => [el.min, el.max]), ['-180', '180']);
    await page.locator('.camera-advanced summary').click();
    for (const spinning of [false, true]) {
      await page.evaluate(spinning => GravityDemo.applySettings({spinning, spin: .95, distance: 32,
        roll: 0, framing: 0, framingY: 0}), spinning);
      for (const elevation of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
        await page.locator('#elevation').fill(String(elevation));
        await page.locator('#elevation').dispatchEvent('input');
        await page.waitForFunction(value => Math.abs(90 - GravityDemo.camera.theta * 180 / Math.PI - value) < 1e-6, elevation);
        const result = await page.evaluate(async () => {
          const d = GravityDemo;
          while (d.job) { d.advanceTrace(); await new Promise(r => setTimeout(r, 0)); }
          d.deposit(); d.shade(); d.present();
          return {elevation: 90 - d.camera.theta * 180 / Math.PI, spinning: d.spinning,
            rays: d.diagnostics(), error: d.gl.getError()};
        });
        assert.equal(await page.locator('#elevation-value').textContent(), elevation + '°');
        assert.equal(result.error, 0); assert.equal(result.rays.invalid, 0); assert.equal(result.rays.budget, 0); assert.equal(result.rays.other, 0);
        assert.ok(result.rays.captured > 0 && result.rays.escaped > 0);
        results.push(result);
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: extended clouds, camera framing, tilt extremes, portrait/ultrawide coverage, full elevation orbit and animation without retracing.');
  } finally {
    fs.mkdirSync('test-results', {recursive: true});
    fs.writeFileSync('test-results/camera-browser-results.json', JSON.stringify({results, errors}, null, 2));
    await context.close(); await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
