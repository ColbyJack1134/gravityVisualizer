const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = process.env.GRAVITY_CDP
    ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    window.captureMode = 'audio';
    window.captureStreams = [];
    window.connections = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...args) {
      connections.push([this, target]);
      return connect.call(this, target, ...args);
    };
    window.mockCapture = async options => {
      window.captureOptions = options;
      if (captureMode === 'cancel') throw new DOMException('Canceled', 'NotAllowedError');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);
      const stream = canvas.captureStream(1);
      if (captureMode !== 'no-audio') {
        window.generatorContext ||= new AudioContext();
        await generatorContext.resume();
        const oscillator = generatorContext.createOscillator(), volume = generatorContext.createGain();
        const destination = generatorContext.createMediaStreamDestination();
        oscillator.frequency.value = 1000;
        volume.gain.value = .15;
        oscillator.connect(volume); volume.connect(destination); oscillator.start();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
      }
      captureStreams.push(stream);
      if (captureMode === 'pending') return new Promise(resolve => { window.finishCapture = () => resolve(stream); });
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = mockCapture;
  });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const capture = async () => {
    await page.locator('#computer-audio').click();
    await page.waitForFunction(() => GravityDemo.captureStream && !GravityDemo.capturePending);
  };
  const stopped = async () => {
    assert.equal(await page.evaluate(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
    assert.equal(await page.evaluate(() => GravityDemo.captureSource), null);
    assert.equal(await page.locator('#file-audio').isVisible(), true);
    assert.equal(await page.locator('#computer-audio').textContent(), 'Computer audio');
  };
  try {
    const url = process.env.GRAVITY_URL || pathToFileURL(path.resolve('gravity-demo.html')).href;
    await page.goto(url + '?quality=draft&motion=fixed&ui=1');
    await page.waitForFunction(() => window.GravityDemo?.cacheReady || window.GravityDemo?.failed, null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => GravityDemo.failed), false);
    const builds = await page.evaluate(() => GravityDemo.cacheBuilds);
    await page.locator('#music').evaluate(element => element.play());
    await page.waitForFunction(() => GravityDemo.spectrum.driven > .9);
    await capture();
    await page.waitForFunction(() => GravityDemo.spectrum.energy > .05 && GravityDemo.spectrum.driven > .95);
    assert.equal(await page.locator('#file-audio').isVisible(), false);
    assert.equal(await page.locator('#capture-status').isVisible(), true);
    assert.equal(await page.locator('#music').evaluate(element => element.paused), true);
    assert.equal(await page.locator('#computer-audio').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => connections.filter(([from]) => from === GravityDemo.captureSource)
      .map(([, to]) => to === GravityDemo.analyser || to === GravityDemo.attackAnalyser)), [true, true]);
    assert.equal(await page.evaluate(() => connections.some(([from]) => from === GravityDemo.analyser || from === GravityDemo.attackAnalyser)), false);
    assert.equal(await page.evaluate(() => captureOptions.systemAudio), 'include');
    assert.equal(await page.evaluate(() => captureOptions.audio.suppressLocalAudioPlayback), false);
    const frequency = await page.evaluate(() => GravityAudio.centers[GravityDemo.spectrum.levels.indexOf(Math.max(...GravityDemo.spectrum.levels))]);
    assert.ok(Math.abs(Math.log(frequency / 1000)) < .3);
    checks.push('Captured MediaStream drives the real FFT without routing captured sound to speakers');

    await page.evaluate(() => { GravityDemo.captureStream.getAudioTracks()[0].enabled = false; });
    await page.waitForFunction(() => GravityDemo.spectrum.silenceSeconds > .3);
    await page.evaluate(() => { GravityDemo.captureStream.getAudioTracks()[0].enabled = true; });
    await page.waitForFunction(() => GravityDemo.spectrum.signalPresent);
    fs.mkdirSync('test-results', { recursive: true });
    await page.locator('#controls').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: 'test-results/computer-audio.png' });
    await page.locator('#computer-audio').click();
    await stopped();
    await page.waitForFunction(() => GravityDemo.spectrum.silenceSeconds > .3);
    assert.equal(await page.locator('#music').evaluate(element => element.paused), true);
    await capture();
    await page.evaluate(() => {
      const track = GravityDemo.captureStream.getVideoTracks()[0];
      track.stop(); track.dispatchEvent(new Event('ended'));
    });
    await stopped();
    checks.push('Track mute, resume, explicit stop and browser sharing stop clean up capture without autoplay');

    await capture();
    await page.locator('#audio-file').setInputFiles(path.resolve('assets/chill-day.mp3'));
    await stopped();
    assert.equal(await page.locator('#audio-name').textContent(), 'chill-day.mp3');
    assert.equal(await page.locator('#music').evaluate(element => element.paused), true);
    await page.locator('#music').evaluate(element => element.play());
    for (const mode of ['no-audio', 'cancel']) {
      await page.evaluate(mode => { window.captureMode = mode; }, mode);
      await page.locator('#computer-audio').click();
      await page.waitForFunction(() => !GravityDemo.capturePending);
      await stopped();
      assert.equal(await page.locator('#audio-error').isVisible(), true);
      assert.equal(await page.locator('#music').evaluate(element => element.paused), false);
    }
    checks.push('File selection releases capture; canceled or audio-free sharing preserves local playback');

    await page.evaluate(() => { window.captureMode = 'pending'; });
    await page.locator('#computer-audio').click();
    await page.waitForFunction(() => typeof finishCapture === 'function');
    assert.equal(await page.locator('#computer-audio').isDisabled(), true);
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); finishCapture(); });
    await page.waitForFunction(() => captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    await stopped();
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = undefined; });
    await page.locator('#computer-audio').click();
    assert.match(await page.locator('#audio-error').textContent(), /supported browser/);
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = mockCapture; window.captureMode = 'audio'; });
    await capture();
    assert.equal(await page.locator('#audio-error').isVisible(), false);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await stopped();
    assert.equal(await page.evaluate(() => GravityDemo.cacheBuilds), builds);
    assert.deepEqual(errors, []);
    checks.push('Late permission result is released after navigation; unsupported input and retries work without retracing');
    console.log('PASS', checks);
    fs.writeFileSync('test-results/capture-browser-results.json', JSON.stringify({ passed: true, checks }, null, 2));
  } finally {
    await context.close(); await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
