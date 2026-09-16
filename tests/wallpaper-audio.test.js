const assert = require('node:assert/strict');
const A = require('../src/audio.js');
const WallpaperAudio = require('../src/wallpaper-audio.js');
const samples = (index, value, side = 'both') => {
  const data = new Float32Array(128);
  if (side !== 'right') data[index] = value;
  if (side !== 'left') data[index + 64] = value;
  return data;
};
let now = 0;
const input = new WallpaperAudio(() => now), spectrum = new A.Spectrum();
const run = (seconds, data, fps = 60) => {
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    now += 1000 / fps;
    if (data) input.receive(data);
    input.update(spectrum, 1 / fps, 1);
  }
};
let previous = -1;
for (let index = 0; index < 64; index++) {
  input.reset();
  input.receive(samples(index, 0.8));
  const peak = input.bands.indexOf(Math.max(...input.bands));
  assert.ok(peak >= previous, 'Host frequency ordering must remain monotonic');
  previous = peak;
}
assert.equal(previous, 23);
input.reset(); input.receive(samples(4, 0.6, 'left')); const left = Array.from(input.bands);
input.reset(); input.receive(samples(4, 0.6, 'right')); assert.deepEqual(Array.from(input.bands), left);
input.reset(); input.receive(samples(4, 0.6));
assert.ok(Math.abs(Math.max(...input.bands) / Math.max(...left) - Math.SQRT2) < 1e-6);
input.reset(); input.receive(samples(4, 8)); const clipped = Array.from(input.bands);
input.reset(); input.receive(samples(4, 1)); assert.deepEqual(Array.from(input.bands), clipped);
input.reset(); input.receive(samples(4, NaN)); assert.ok(input.bands.every(v => v === 0));
input.receive(samples(4, -1)); assert.ok(input.bands.every(v => v === 0));
input.receive([1, 2]); assert.ok(input.bands.every(v => v === 0));
run(5, samples(4, 0.00001));
assert.ok(spectrum.driven > 0.99, 'Quiet host audio prevents idle by default');
assert.equal(Math.max(...spectrum.levels), 0);
spectrum.ignoreQuietAudio = true; run(10, samples(4, 0.00001));
assert.equal(spectrum.driven, 0); assert.equal(Math.max(...spectrum.levels), 0);
spectrum.ignoreQuietAudio = false; run(0.6, samples(4, 0.00001));
assert.ok(spectrum.driven > 0.97, 'Disabling the gate resumes quiet host audio');
run(10, null); assert.equal(spectrum.driven, 0, 'Missing host callbacks still return to idle');
input.reset(); spectrum.reset();
input.receive(samples(4, 1)); input.receive(new Float32Array(128)); input.update(spectrum, 1 / 30, 1);
assert.ok(spectrum.energy > 0 && spectrum.shake > 0, 'A transient between frames must survive until consumed');
run(3, samples(4, 0.8));
assert.ok(spectrum.bass > 0.5 && spectrum.shake < 0.001, 'Held bass must settle');
run(2.8, null); assert.ok(spectrum.driven > 0.98, 'Stale input enters the silence wait');
run(3.5, null); assert.ok(spectrum.driven > 0.3 && spectrum.driven < 0.6);
run(3.5, null); assert.equal(spectrum.driven, 0); assert.ok(spectrum.energy < 0.001);
run(0.6, samples(4, 0.8)); assert.ok(spectrum.driven > 0.97, 'New audio restores response');
const levels = [];
for (const fps of [20, 30, 60, 144]) {
  let clock = 0, callback = 0;
  const source = new WallpaperAudio(() => clock), response = new A.Spectrum();
  for (let frame = 0; frame < fps * 4; frame++) {
    clock = frame * 1000 / fps;
    if (clock >= callback) { source.receive(samples(30, 0.4)); callback = clock + 1000 / 30 - 0.01; }
    source.update(response, 1 / fps, 1);
  }
  levels.push(Math.max(...response.levels));
  assert.ok(response.bass === 0 && response.shake === 0);
}
assert.ok(Math.max(...levels) - Math.min(...levels) < 0.005);
input.reset(); assert.equal(input.receivedAt, -Infinity); assert.ok(input.peaks.every(v => v === 0));
console.log('PASS: host stereo mapping, ordering, noise gate, clipping, transient retention, stale audio, silence recovery and frame-rate independence.');
