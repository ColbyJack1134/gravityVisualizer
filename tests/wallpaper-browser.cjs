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
        brightness: [r.brightnessMin, r.brightnessMax], radius: r.cloudRadius, dimming: r.radialDimming,
        animated: r.palette.hsv.animated, colors: r.palette.custom.stops.map(c => c.toUpperCase()), registrations: audioRegistrations,
        idle: [r.idlePalette.mode, r.idlePalette.weighted.animated, r.idlePalette.weighted.weights],
        rendered: Array.from(r.paletteColors), auto: r.spectrum.autoSensitivity,
        showIdleParticles: r.showIdleParticles, silenceThreshold: r.spectrum.silenceThreshold };
    });
    assert.equal(defaults.stats.cacheBuilds, 1, 'Early settings must precede the first cache allocation');
    assert.equal(defaults.stats.particles, 65536); assert.equal(defaults.stats.spin, 0.5);
    assert.deepEqual(defaults.framing, [0.03, 0.1]); assert.equal(defaults.fps, 30);
    assert.equal(defaults.material, 0.3); assert.equal(defaults.exposure, 1.7);
    assert.deepEqual(defaults.brightness.map(v => Math.round(v * 100)), [65, 140]); assert.equal(defaults.radius, 22);
    assert.equal(defaults.dimming, .5);
    for (const percent of [0, 50, 100]) {
      await apply({radialdimming: percent});
      assert.equal(await page.evaluate(() => {
        const r = GravityWallpaper.renderer; r.deposit();
        return r.gl.getUniform(r.programs.deposit.p, r.gl.getUniformLocation(r.programs.deposit.p, 'uRadialDimming'));
      }), percent / 100);
    }
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.cacheBuilds), defaults.stats.cacheBuilds);
    assert.equal(defaults.sharpness, 1); assert.equal(defaults.fade, 3); assert.equal(defaults.animated, true);
    assert.deepEqual(defaults.colors, ['#23D183', '#1DCA97', '#17C2AB', '#12BBC0', '#0CB3D4', '#06ACE8']);
    assert.equal(defaults.registrations, 1);
    assert.deepEqual(defaults.idle, ['weighted', false, [8, 12, 60, 20]]);
    assert.ok(defaults.rendered.some(v => v < .99));
    assert.equal(defaults.auto, true);
    assert.equal(defaults.showIdleParticles, true);
    assert.equal(defaults.silenceThreshold, 0);
    await apply({ silencecutoff: 0.2 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.spectrum.silenceThreshold), 0.002);
    await apply({ silencecutoff: 0 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.spectrum.silenceThreshold), 0);
    await apply({ showidleparticles: false });
    assert.equal(await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl; r.deposit();
      return gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uIdleParticles'));
    }), 0);
    await apply({ showidleparticles: true });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.showIdleParticles), true);
    const properties = project.general.properties;
    assert.deepEqual(Object.values(properties).filter(p => p.type === 'group').map(p => p.text),
      ['General', 'Audio', 'Audio colors', 'Idle colors', 'Background', 'Camera', 'Black hole', 'Material and light', 'Performance']);
    const condition = (key, values) => Function(...Object.keys(properties), 'return ' + properties[key].condition)(
      ...Object.entries(properties).map(([key, p]) => ({ ...p, value: Object.hasOwn(values, key) ? values[key] : p.value })));
    assert.equal(condition('audiogain', { autosensitivity: true }), false);
    assert.equal(condition('audiogain', { autosensitivity: false }), true);
    assert.equal(condition('idlesolidcolor', {}), false); assert.equal(condition('idlehsvspeed', {}), false);
    assert.equal(condition('idleweightedweight3', {}), true);
    assert.equal(condition('idlecustomcolor6', { idlecolormode: 'custom', idlecustomcount: 2 }), false);
    const audioWeighted=await page.evaluate(()=>JSON.stringify(GravityWallpaper.renderer.palette.weighted));
    await apply({idleweightedcount:3,idleweightedweight1:20,idleweightedweight2:60,idleweightedweight3:20,
      idleweightedcolor1:'1 0 0',idleweightedcolor2:'0 1 0',idleweightedcolor3:'0 0 1',idleweightedcolor6:'1 0 1'});
    assert.deepEqual(await page.evaluate(()=>GravityWallpaper.renderer.idlePalette.weighted.weights),[20,60,20]);
    assert.deepEqual(await page.evaluate(()=>GravityWallpaper.renderer.idlePalette.weighted.stops),['#ff0000','#00ff00','#0000ff']);
    await apply({idleweightedweight1:0,idleweightedweight2:100,idleweightedweight3:0});
    assert.ok(await page.evaluate(()=>{
      const r=GravityWallpaper.renderer;r.refreshPalette(true);r.deposit();
      return r.idleSamples.every((v,i)=>v===(i%3===1?1:0));
    }));
    await apply({idleweightedcount:6});
    assert.equal(await page.evaluate(()=>GravityWallpaper.renderer.idlePalette.weighted.stops[5]),'#ff00ff');
    assert.equal(await page.evaluate(()=>JSON.stringify(GravityWallpaper.renderer.palette.weighted)),audioWeighted);
    assert.equal(await page.evaluate(()=>GravityWallpaper.renderer.cacheBuilds),defaults.stats.cacheBuilds);
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
        animated: r.palette.hsv.animated, paused: r.paused, colors: Array.from(r.audioColors), builds: r.cacheBuilds };
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

    const audioPalette = await page.evaluate(() => JSON.stringify(GravityWallpaper.renderer.palette));
    await apply({ idlecolormode: 'custom', idlecustomcount: 2, idlecustomcolor1: '0 0 1', idlecustomcolor6: '1 1 0',
      idlecustomoffset: 25, idlecustomspeed: -2, idlecustomanimate: false });
    assert.equal(await page.evaluate(() => JSON.stringify(GravityWallpaper.renderer.palette)), audioPalette);
    assert.deepEqual(await page.evaluate(() => GravityWallpaper.renderer.idlePalette.custom.stops), ['#0000ff', '#1dca97']);
    await apply({ idlecustomcount: 6 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.idlePalette.custom.stops[5]), '#ffff00');
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.idlePalette.custom.offset), 0.25);
    await apply({ colormode: 'solid', solidcolor: '1 0 0', idlecolormode: 'solid', idlesolidcolor: '0 0 1' });
    const blends = await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl;
      const samples = [0, 0.5, 1].map(amount => {
        r.spectrum.driven = amount; r.refreshPalette(); r.deposit();
        return Array.from(gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uBandColors[0]')));
      });
      r.spectrum.reset(); r.refreshPalette();
      return samples;
    });
    blends.forEach((colors, row) => colors.forEach((value, i) =>
      assert.ok(Math.abs(value - (i % 3 === 0 ? row / 2 : i % 3 === 2 ? 1 - row / 2 : 0)) < 1e-6)));
    await apply({ colormode: 'hsv', idlesolidcolor: '1 1 1' });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.cacheBuilds), 1);
    results.checks.push('Independent native idle/audio palettes, retained hidden stops, and linear-light blends reach GPU uniforms without retracing');

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
    await apply({ autosensitivity: false, audiogain: 2.3 });
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.spectrum.effectiveGain), 2.3);
    await apply({ autosensitivity: true });
    assert.ok(await page.evaluate(() => GravityWallpaper.renderer.spectrum.effectiveGain < 1));
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.audioGain), 2.3);
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
    assert.ok(await page.evaluate(() => GravityWallpaper.renderer.paletteColors.every(v => v === 1)));
    assert.ok(await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl; r.deposit();
      return gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uBandColors[0]')).every(v => v === 1);
    }));
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
      const before = await page.evaluate(() => ({ frames: GravityWallpaper.renderer.frames, time: performance.now() }));
      await page.waitForTimeout(1100);
      const after = await page.evaluate(() => ({ frames: GravityWallpaper.renderer.frames, time: performance.now() }));
      const measured = (after.frames - before.frames) * 1000 / (after.time - before.time);
      assert.ok(measured <= fps + 2 && measured >= fps * 0.7, `Frame cap ${fps}: measured ${measured}`);
    }
    await page.evaluate(() => wallpaperPropertyListener.applyGeneralProperties({ fps: 0 }));
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.fpsLimit), 0);
    await page.evaluate(() => wallpaperPropertyListener.applyGeneralProperties({ fps: 30 }));
    results.checks.push('Host suspension stops rendering, resume resets clocks, and frame caps change live');

    await page.setViewportSize({ width: 3840, height: 1080 }); await page.waitForTimeout(250); await ready();
    assert.ok(await page.evaluate(() => GravityWallpaper.renderer.rw * GravityWallpaper.renderer.rh < 261000));
    await apply({ material: 45, exposure: 2, stardensity: 200, clouddensity: 25, paused: true,
      cloudradius: 150, brightnessmin: 80, brightnessmax: 180, radialdimming: 50,
      idlecolormode: 'weighted', idleweightedcount: 3, idleweightedweight1: 20, idleweightedweight2: 60, idleweightedweight3: 20 });
    await ready();
    const snapshot = await page.evaluate(() => [GravityWallpaper.renderer.material, GravityWallpaper.renderer.exposure, GravityWallpaper.renderer.starDensity, GravityWallpaper.renderer.cloudDensity]);
    await page.evaluate(() => { window.loss = GravityWallpaper.renderer.gl.getExtension('WEBGL_lose_context'); loss.loseContext(); });
    await page.waitForFunction(() => GravityWallpaper.renderer.lost);
    await apply({ framingy: 11.5 });
    await page.evaluate(() => loss.restoreContext()); await ready();
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.material, GravityWallpaper.renderer.exposure, GravityWallpaper.renderer.starDensity, GravityWallpaper.renderer.cloudDensity]), snapshot);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.framingY), 0.115);
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.cloudRadius,
      GravityWallpaper.renderer.brightnessMin, GravityWallpaper.renderer.brightnessMax]), [33, .8, 1.8]);
    assert.equal(await page.evaluate(() => GravityWallpaper.renderer.radialDimming), .5);
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.palette.mode, GravityWallpaper.renderer.idlePalette.solid,
      GravityWallpaper.renderer.spectrum.autoSensitivity, GravityWallpaper.renderer.audioGain]), ['hsv', '#ffffff', true, 2.3]);
    assert.deepEqual(await page.evaluate(() => [GravityWallpaper.renderer.idlePalette.mode,
      GravityWallpaper.renderer.idlePalette.weighted.weights]), ['weighted', [20, 60, 20]]);
    assert.ok(await page.evaluate(() => {
      const r = GravityWallpaper.renderer, gl = r.gl; r.deposit();
      const range = gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uBrightnessRange'));
      if (gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uRadialDimming')) !== .5) return false;
      if (Math.abs(range[0] - .8) > 1e-6 || Math.abs(range[1] - 1.8) > 1e-6 ||
          gl.getUniform(r.programs.deposit.p, gl.getUniformLocation(r.programs.deposit.p, 'uCloudRadius')) !== 33) return false;
      const framebuffer = r.fbo([r.paletteTexture]), colors = new Float32Array(r.paletteSamples.length);
      gl.readPixels(0, 0, r.paletteSampleCount, 1, gl.RGBA, gl.FLOAT, colors);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(framebuffer);
      return gl.getError() === 0 && colors.every((value, i) => value === r.paletteSamples[i]);
    }), 'Context recovery restores the weighted palette texture');
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
