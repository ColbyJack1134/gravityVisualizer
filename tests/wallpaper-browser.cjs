const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const project = require('../wallpaper/project.json');

(async () => {
  fs.mkdirSync('test-results', { recursive: true });
  const browser = process.env.GRAVITY_CDP
    ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({ channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript((properties) => {
    window.audioRegistrations = 0;
    window.wallpaperRegisterAudioListener = (listener) => {
      window.audioRegistrations++;
      window.deliverAudio = listener;
    };
    let listener;
    Object.defineProperty(window, 'wallpaperPropertyListener', {
      get: () => listener,
      set: (value) => {
        listener = value;
        listener.applyUserProperties(properties);
        listener.applyGeneralProperties({ fps: 30 });
        listener.setPaused(false);
      }
    });
  }, project.general.properties);
  const page = await context.newPage(), errors = [], network = [];
  const results = { date: new Date().toISOString(), checks: [] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  const ready = async () => {
    await page.waitForFunction(() => GravityWallpaper.renderer?.cacheReady || GravityWallpaper.renderer?.failed, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.failed), false);
  };
  const apply = async values => {
    await page.evaluate(values => wallpaperPropertyListener.applyUserProperties(Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { value }])
    )), values);
    await page.waitForTimeout(200);
  };
  try {
    await page.goto(process.env.GRAVITY_WALLPAPER_URL || pathToFileURL(path.resolve('dist/wallpaper-engine/index.html')).href);
    await ready();
    const defaults = await page.evaluate(() => {
      const r = GravityWallpaper.renderer;
      return { stats: r.stats(), framing: [r.framing, r.framingY], fps: r.fpsLimit,
        material: r.material, exposure: r.exposure, sharpness: r.sharpness, fade: r.fadeSeconds,
        animated: r.palette.hsv.animated, colors: r.palette.custom.stops.map(c => c.toUpperCase()), registrations: audioRegistrations };
    });
    assert.equal(defaults.stats.cacheBuilds, 1, 'Early settings must precede the first cache allocation');
    assert.equal(defaults.stats.particles, 65536); assert.equal(defaults.stats.spin, 0.25);
    assert.deepEqual(defaults.framing, [0.03, 0.1]); assert.equal(defaults.fps, 30);
    assert.equal(defaults.material, 0.3); assert.equal(defaults.exposure, 1.7);
    assert.equal(defaults.sharpness, 1); assert.equal(defaults.fade, 3); assert.equal(defaults.animated, true);
    assert.deepEqual(defaults.colors, ['#23D183', '#1DCA97', '#17C2AB', '#12BBC0', '#0CB3D4', '#06ACE8']);
    assert.equal(defaults.registrations, 1);
    assert.equal(await page.locator('audio, button, input, select, aside').count(), 0);
    assert.equal(await page.locator('#error').isVisible(), false);
    results.checks.push('Early native settings, exact defaults, one audio listener, and no web controls or media');

    await apply({ stardensity: 0, clouddensity: 0, framing: 0, framingy: 0, sharpness: 0,
      particlefade: 0, audiobalance: 0, bassshake: 0, hsvanimate: false, paused: true,
      colormode: 'solid', solidcolor: '1 0 0', cameramotion: 'fixed' });
    const zero = await page.evaluate(() => {
      const r = GravityWallpaper.renderer;
      r.deposit(); r.shade(); r.present();
      const gl = r.gl, p = r.programs.shade.p;
      return { values: [r.starDensity, r.cloudDensity, r.framing, r.framingY, r.sharpness, r.fadeSeconds, r.spectrum.balance, r.shakeStrength],
        stars: gl.getUniform(p, gl.getUniformLocation(p, 'uStarDensity')), clouds: gl.getUniform(p, gl.getUniformLocation(p, 'uCloudDensity')),
        animated: r.palette.hsv.animated, paused: r.paused, colors: Array.from(r.paletteColors), builds: r.cacheBuilds };
    });
    assert.ok(zero.values.every(v => v === 0)); assert.equal(zero.stars, 0); assert.equal(zero.clouds, 0);
    assert.equal(zero.animated, false); assert.equal(zero.paused, true); assert.equal(zero.builds, 1);
    zero.colors.forEach((v, i) => assert.equal(v, i % 3 === 0 ? 1 : 0));
    const hsvOffset = await page.evaluate(() => GravityWallpaper.renderer.palette.hsv.offset);
    await apply({ colormode: 'custom', customcount: 2, customcolor1: '0 1 0', customcolor6: '1 0 1', customoffset: 50, customanimate: false, customspeed: -1 });
    assert.deepEqual(await page.evaluate(() => GravityWallpaper.renderer.palette.custom.stops), ['#00ff00', '#1dca97']);
    await apply({ customcount: 6 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.palette.custom.stops[5]), '#ff00ff');
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.palette.custom.offset), 0.5);
    await apply({ colormode: 'hsv' });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.palette.hsv.offset), hsvOffset);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.cacheBuilds), 1);
    results.checks.push('Partial and zero/false settings reach GPU uniforms; colors, retained stops and independent offsets reuse rays');

    await apply({ spinning: false, elevation: 25, distance: 45, particles: '16384', quality: 'draft' });
    await ready();
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.cacheBuilds), 2, 'One property batch retraces once');
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.count), 16384);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.a()), 0);
    await apply({ exposure: NaN, distance: Infinity, particles: 'invalid', quality: 'invalid', solidcolor: 'not a color' });
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.exposure, GravityWallpaper.renderer.camera.distance, GravityWallpaper.renderer.count, GravityWallpaper.renderer.quality]), [1.7, 45, 16384, 'draft']);
    results.checks.push('Coalesced geometry updates, particle allocation and invalid-value rejection');

    await apply({ bassshake: 70, audiobalance: 75 });
    const frozen = await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl, data = new Float32Array(100);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.particleBuffers[r.particleIndex]); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      window.frozenParticles = Array.from(data);
      window.hostAudioTimer = setInterval(() => { const samples = new Float32Array(128); samples[4] = samples[68] = 0.8; deliverAudio(samples); }, 1000 / 30);
      return { time: r.simTime, builds: r.cacheBuilds };
    });
    await page.waitForFunction(() => GravityWallpaper.renderer.spectrum.driven > 0.95 && GravityWallpaper.renderer.audioBass > 0.5);
    await page.waitForTimeout(2000);
    assert.ok(await page.evaluate(() => GravityWallpaper.renderer.spectrum.shake < 0.001));
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.simTime), frozen.time);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.cacheBuilds), frozen.builds);
    assert.equal(await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl, data = new Float32Array(100);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.particleBuffers[r.particleIndex]); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return data.every((v, i) => v === frozenParticles[i]);
    }), true);
    await page.evaluate(() => { clearInterval(hostAudioTimer); wallpaperPropertyListener.applyGeneralProperties({ fps: 10 }); });
    await page.waitForFunction(() => GravityWallpaper.renderer.spectrum.silenceSeconds > 9.1, null, { timeout: 14000 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.spectrum.driven), 0);
    results.checks.push('Live host audio drives visibility without changing physics; held bass settles; stale audio recovers at 10 FPS');

    await page.evaluate(() => wallpaperPropertyListener.setPaused(true));
    const stopped = await page.evaluate(() => [GravityWallpaper.renderer.frames, GravityWallpaper.renderer.simTime]);
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.frames, GravityWallpaper.renderer.simTime]), stopped);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.raf), null);
    await page.evaluate(() => { wallpaperPropertyListener.applyGeneralProperties({ fps: 30 }); wallpaperPropertyListener.setPaused(false); });
    await apply({ paused: false });
    const resumed = await page.evaluate(() => GravityWallpaper.renderer.simTime);
    await page.waitForTimeout(300);
    const advanced = await page.evaluate(t => GravityWallpaper.renderer.simTime - t, resumed);
    assert.ok(advanced > 0 && advanced < 5, 'Resume must not integrate the suspended interval');
    for (const fps of [15, 30]) {
      await page.evaluate(fps => wallpaperPropertyListener.applyGeneralProperties({ fps }), fps);
      const before = await page.evaluate(() => GravityWallpaper.renderer.frames);
      await page.waitForTimeout(1100);
      const measured = (await page.evaluate(() => GravityWallpaper.renderer.frames) - before) / 1.1;
      assert.ok(measured <= fps + 2 && measured >= fps * 0.7, `Frame cap ${fps}: measured ${measured}`);
    }
    await page.evaluate(() => wallpaperPropertyListener.applyGeneralProperties({ fps: 0 }));
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.fpsLimit), 0);
    await page.evaluate(() => wallpaperPropertyListener.applyGeneralProperties({ fps: 30 }));
    results.checks.push('Host suspension stops rendering, resume resets clocks, and frame caps change live');

    await page.setViewportSize({ width: 3840, height: 1080 }); await page.waitForTimeout(250); await ready();
    assert.ok(await page.evaluate(() => GravityWallpaper.renderer.rw * GravityWallpaper.renderer.rh < 261000));
    await apply({ material: 45, exposure: 2, stardensity: 200, clouddensity: 25 });
    const snapshot = await page.evaluate(() => [GravityWallpaper.renderer.material, GravityWallpaper.renderer.exposure, GravityWallpaper.renderer.starDensity, GravityWallpaper.renderer.cloudDensity]);
    await page.evaluate(() => { window.loss = GravityWallpaper.renderer.gl.getExtension('WEBGL_lose_context'); loss.loseContext(); });
    await page.waitForFunction(() => GravityWallpaper.renderer.lost);
    await apply({ framingy: 11.5 });
    await page.evaluate(() => loss.restoreContext()); await ready();
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.material, GravityWallpaper.renderer.exposure, GravityWallpaper.renderer.starDensity, GravityWallpaper.renderer.cloudDensity]), snapshot);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.framingY), 0.115);
    await page.evaluate(() => GravityWallpaper.start());
    assert.equal(await page.evaluate(() => audioRegistrations), 1);
    results.checks.push('Spanning viewport and context restoration preserve settings and the single audio subscription');
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    results.passed = true;
    console.log('PASS', results.checks);
  } finally {
    fs.writeFileSync('test-results/wallpaper-browser-results.json', JSON.stringify({ ...results, errors }, null, 2));
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
