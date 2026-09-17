const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'dist/media/idle.mp4' },
  seconds: { type: 'string' },
  fps: { type: 'string', default: '60' },
  music: { type: 'boolean', default: false },
  preset: { type: 'string' },
  green: { type: 'boolean', default: false }
} });
const root = path.resolve(__dirname, '..');
const output = path.resolve(values.output), raw = output.replace(/\.mp4$/, '') + '.h264';
const fps = Number(values.fps), seconds = Number(values.seconds || 8);
if (![30, 60].includes(fps) || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Use 30 or 60 FPS and a positive duration.');
const settings = values.preset ? JSON.parse(fs.readFileSync(path.resolve(values.preset), 'utf8')).settings : {};
if (values.green) settings.idlePalette = { mode: 'custom', custom: { animated: false } };
fs.mkdirSync(path.dirname(output), { recursive: true });

(async () => {
  const browser = process.env.GRAVITY_CDP
    ? await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    : await chromium.launch({ channel: process.env.GRAVITY_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  let file;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(process.env.GRAVITY_URL || pathToFileURL(path.join(root, 'gravity-demo.html')).href);
    await page.waitForFunction(() => window.GravityDemo, null, { timeout: 180000 });
    await page.evaluate(settings => {
      const d = GravityDemo;
      d.setSuspended(true);
      d.applySettings({ ...settings, quality: 'native', fpsLimit: 0 });
      d.onAudio = d.onPalette = d.onStats = null;
    }, settings);
    const source = await page.evaluate(async ({ fps, seconds, music, limit }) => {
      const d = GravityDemo;
      while (d.job) {
        for (let i = 0; i < 4 && d.job; i++) d.advanceTrace();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!d.cacheReady || d.failed) throw new Error('Native ray cache failed.');
      const config = { codec: 'avc1.64002a', width: 1920, height: 1080, framerate: fps,
        bitrate: 40000000, hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', avc: { format: 'annexb' } };
      if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('H.264 encoding is unavailable.');
      window.renderConfig = config;
      let duration = seconds, songDuration = 0;
      if (music) {
        const bytes = await (await fetch(document.getElementById('music').src)).arrayBuffer();
        const decoder = new OfflineAudioContext(2, 1, 44100);
        const song = await decoder.decodeAudioData(bytes);
        songDuration = song.duration;
        duration = limit ? Math.min(seconds, songDuration + 5) : songDuration + 5;
        const audio = new OfflineAudioContext(2, Math.ceil(duration * song.sampleRate), song.sampleRate);
        const source = audio.createBufferSource(); source.buffer = song;
        const main = audio.createAnalyser(), attack = audio.createAnalyser();
        main.fftSize = 4096; attack.fftSize = 1024;
        main.smoothingTimeConstant = attack.smoothingTimeConstant = 0;
        source.connect(main); source.connect(attack); main.connect(audio.destination); attack.connect(audio.destination);
        source.start(2);
        const frames = Math.ceil(duration * fps), bands = new Float32Array(frames * 48);
        const bins = new Float32Array(2048), attacks = new Float32Array(512), probe = new GravityAudio.Spectrum();
        let paused = audio.suspend(0);
        const finished = audio.startRendering();
        for (let frame = 0; frame < frames; frame++) {
          await paused;
          main.getFloatFrequencyData(bins); attack.getFloatFrequencyData(attacks);
          probe.readFFT(bins, song.sampleRate, 4096);
          bands.set(probe.frequency.amplitudes, frame * 48);
          probe.readFFT(attacks, song.sampleRate, 1024);
          bands.set(probe.frequency.amplitudes, frame * 48 + 24);
          if (frame + 1 < frames) paused = audio.suspend((frame + 1) / fps);
          await audio.resume();
        }
        await finished;
        window.renderBands = bands;
      }
      d.allocateParticles();
      for (let i = 0; i < 4 * fps; i++) {
        d.simTime += d.speed / fps;
        d.updateParticles(d.speed / fps, 1 / fps);
      }
      d.spectrum.reset();
      d.cameraTime = d.orbitAngle = 0;
      window.requestAnimationFrame = () => 0;
      d.suspended = false; d.paused = false;
      d.lastPresentation = d.lastFrame = 1000 - 1000 / fps;
      d.audioInput = { update(spectrum, dt, gain) {
        const start = window.renderFrame * 48;
        if (window.renderBands) spectrum.updateBands(dt, renderBands.subarray(start, start + 24), gain, renderBands.subarray(start + 24, start + 48));
        else spectrum.update(dt, null);
      } };
      return { width: 1920, height: 1080, fps, frames: Math.ceil(duration * fps), songDuration,
        quality: d.quality, renderSize: [d.rw, d.rh], particles: d.count, starDetail: d.starDetail,
        coreSizing: d.coreSizing, renderer: d.rendererName };
    }, { fps, seconds, music: values.music, limit: !!values.seconds });
    console.log('Rendering', source);
    file = fs.openSync(raw, 'w');
    await page.exposeFunction('writeVideo', encoded => fs.writeSync(file, Buffer.from(encoded, 'base64')));
    await page.evaluate(() => {
      window.videoWrites = Promise.resolve();
      window.videoError = null;
      window.videoEncoder = new VideoEncoder({
        output(chunk) {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          let binary = '';
          for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
          const encoded = btoa(binary);
          window.videoWrites = videoWrites.then(() => writeVideo(encoded));
        },
        error(error) { window.videoError = error.message; }
      });
      videoEncoder.configure(renderConfig);
    });
    const started = Date.now();
    for (let start = 0; start < source.frames; start += 60) {
      await page.evaluate(async ({ start, end, fps }) => {
        for (let frame = start; frame < end; frame++) {
          window.renderFrame = frame;
          GravityDemo.frame(1000 + frame * 1000 / fps);
          if (GravityDemo.failed || videoError) throw new Error(videoError || 'Rendering failed.');
          const image = new VideoFrame(GravityDemo.canvas, { timestamp: Math.round(frame * 1000000 / fps), duration: Math.round(1000000 / fps) });
          videoEncoder.encode(image, { keyFrame: frame % (2 * fps) === 0 }); image.close();
          if (videoEncoder.encodeQueueSize > 2)
            await new Promise(resolve => videoEncoder.addEventListener('dequeue', resolve, { once: true }));
        }
        await videoWrites;
        if (GravityDemo.gl.getError()) throw new Error('WebGL error while rendering.');
      }, { start, end: Math.min(source.frames, start + 60), fps });
      if (start % 600 === 0 || start + 60 >= source.frames)
        console.log(`${Math.min(source.frames, start + 60)}/${source.frames} frames, ${Math.round((Date.now() - started) / 1000)} seconds elapsed`);
    }
    await page.evaluate(async () => { await videoEncoder.flush(); await videoWrites; videoEncoder.close(); });
    fs.closeSync(file); file = undefined;
    if (errors.length) throw new Error(errors.join('\n'));
    source.duration = source.frames / fps;
    source.renderSeconds = (Date.now() - started) / 1000;
    fs.writeFileSync(output.replace(/\.mp4$/, '') + '.json', JSON.stringify(source, null, 2) + '\n');
    const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-r', String(fps), '-i', raw];
    if (values.music) args.push('-i', path.join(root, 'assets/chill-day.mp3'), '-af', `adelay=2000:all=1,apad=whole_dur=${source.duration}`, '-c:a', 'aac', '-b:a', '320k');
    args.push('-c:v', 'copy', '-bsf:v', `setts=ts=N/(${fps}*TB)`, '-t', String(source.duration), '-movflags', '+faststart', output);
    const mux = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    if (mux.status !== 0) throw new Error('Video mux failed.');
    fs.unlinkSync(raw);
    console.log('Saved', output);
  } finally {
    if (file !== undefined) fs.closeSync(file);
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
