const assert=require('node:assert/strict');
const A=require('../src/audio.js');
const sampleRate=48000,fftSize=4096,dt=1/60;
function tone(hz,db=-19){
  const fft=new Float32Array(fftSize/2).fill(-Infinity),bin=Math.round(hz*fftSize/sampleRate);
  // A small spectral peak exercises weighted band/bin overlap and leakage.
  fft[bin]=db;fft[bin-1]=fft[bin+1]=db-10;return fft;
}
function drive(fft,seconds=1){const s=new A.Spectrum();for(let i=0;i<seconds/dt;i++)s.update(dt,fft,sampleRate,fftSize);return s;}
for(const hz of [70,440,1200,6500]){
  const s=drive(tone(hz)),peak=s.levels.indexOf(Math.max(...s.levels));
  assert.ok(Math.abs(Math.log(A.centers[peak]/hz))<.3,`Wrong band for ${hz} Hz: ${A.centers[peak]}`);
  assert.ok(s.levels[peak]>.7);
  if(hz===70){assert.ok(A.hues[peak]>.7&&A.hues[peak]<.8);assert.ok(s.bass>.7);}
  if(hz===6500){assert.ok(A.hues[peak]<.035);assert.ok(s.bass<.001);assert.equal(s.shake,0);}
}
const quiet=drive(tone(70,-90));assert.equal(quiet.energy,0);assert.equal(quiet.shake,0);
const pulse=new A.Spectrum();let peakShake=0;
for(let i=0;i<18;i++){pulse.update(dt,tone(70,-14));peakShake=Math.max(peakShake,pulse.shake);}
assert.ok(peakShake>.6,'Strong bass onset must visibly kick the camera');
for(let i=0;i<120;i++)pulse.update(dt,null);
assert.ok(pulse.shake<.001&&pulse.energy<.001,'Playback pause/silence must settle');
for(const step of [1/30,1/60,1/144]){
  const s=new A.Spectrum();for(let i=0;i<Math.round(.6/step);i++)s.update(step,tone(70));
  assert.ok(Math.abs(s.bass-drive(tone(70),.6).bass)<.005,'Envelope must be independent of display frame rate');
}
for(const hz of [35,440,1200,6500]){
  for(const rate of [44100,48000,96000]){
    const s=new A.Spectrum(),fft=new Float32Array(2048).fill(-Infinity);fft[Math.round(hz*4096/rate)]=-18;
    s.readFFT(fft,rate,4096);const peak=s.targets.indexOf(Math.max(...s.targets));
    assert.ok(Math.abs(A.centers[peak]-hz)<Math.max(hz*.3,rate/4096),'Use actual audio sample rate');
  }
}
assert.ok(Array.from(A.hues).every((h,i)=>h>=0&&h<1&&(i===0||h<A.hues[i-1])));
for(const step of [1/30,1/60,1/144]){
  const s=new A.Spectrum();
  const advance=(seconds,fft)=>{for(let i=0;i<Math.round(seconds/step);i++)s.update(step,fft);};
  advance(1,tone(440));const active=s.driven;
  advance(3,null);assert.ok(Math.abs(s.driven-active)<1e-5,'Hold audio brightness for three seconds of silence');
  advance(3,null);assert.ok(Math.abs(s.driven-active*.5)<.002,'Halfway back to idle after six seconds total');
  advance(3,null);assert.ok(s.driven<1e-5,'Return fully to regular brightness after nine seconds');
  advance(.5,tone(440));assert.ok(s.driven>.95,'New music promptly resumes the response');
  advance(4,null);advance(.2,tone(440));const resumed=s.driven;advance(3,null);
  assert.ok(resumed>.95&&Math.abs(s.driven-resumed)<1e-5,'An intervening sound resets the silence wait');
  assert.equal(s.shake,0,'Idle fallback must not create camera shake');
}
assert.equal(drive(null,12).driven,0,'A silent source starts at regular brightness');
console.log('PASS: frequency isolation, noise gate, bass shake, frame/sample-rate handling, and three-second/six-second silence recovery.');

const mix = (...spectra) => Float32Array.from(spectra[0], (_, i) => Math.max(...spectra.map(s => s[i])));
const bassAndMelody = mix(tone(70, -18), tone(1000, -38), tone(6000, -46));
const bandAt = hz => Array.from(A.centers).reduce((best, x, i) => Math.abs(Math.log(x / hz)) < Math.abs(Math.log(A.centers[best] / hz)) ? i : best, 0);
const balanced = new A.Spectrum(), unbalanced = new A.Spectrum();unbalanced.balance = 0;
for (let i = 0; i < 600; i++) { balanced.update(dt, bassAndMelody); unbalanced.update(dt, bassAndMelody); }
const ratio = s => s.levels[bandAt(6000)] / s.levels[bandAt(70)];
assert.ok(ratio(balanced) > ratio(unbalanced) * 1.8, 'Balancing reveals quiet highs beside sustained bass');
assert.ok(balanced.levels[bandAt(1000)] > .6 && balanced.levels[bandAt(6000)] > .45);
assert.ok(Math.max(...balanced.attacks) < .001 && balanced.shake < .001, 'A held tone must not keep retriggering');
balanced.balance = 0;
for (let i = 0; i < 60; i++) {
  balanced.update(dt, bassAndMelody);
  assert.ok(Math.max(...balanced.attacks) < .001, 'Changing balance must not synthesize attacks');
}
const afterPause = new A.Spectrum();
for (let i = 0; i < 3600; i++) afterPause.update(dt, tone(70, -90), sampleRate, fftSize, 3);
assert.equal(afterPause.energy, 0);assert.equal(afterPause.driven, 0);assert.equal(afterPause.shake, 0);
for (const step of [1/30, 1/60, 1/144]) {
  const s = new A.Spectrum();
  for (let i = 0; i < Math.round(2 / step); i++) s.update(step, tone(70));
  const before = Math.max(...s.attacks);
  s.update(step, mix(tone(70), tone(6000, -35)));
  assert.ok(before < .001 && s.attacks[bandAt(6000)] > .4, 'Quiet treble attacks remain distinct from held bass');
  assert.ok(s.shake < .001, 'Treble onset must not retrigger the bass camera');
}
for (const step of [.25, .5, 1]) {
  const s = new A.Spectrum();s.update(1, tone(440));
  for (let elapsed = 0; elapsed < 6; elapsed += step) s.update(step, null);
  assert.ok(Math.abs(s.driven - .5) < .002, 'Audio recovery must use elapsed time during slow frames');
  for (let elapsed = 0; elapsed < 3; elapsed += step) s.update(step, null);
  assert.equal(s.driven, 0);
  assert.ok(s.energy < .001 && s.shake === 0);
}

console.log('PASS: adaptive balance, noise immunity, independent attacks, sustained-bass stability and elapsed-time recovery.');

const normalize = new A.AutoSensitivity();
const feedPeak = (seconds, amplitude, fps = 60) => {
  for (let i = 0; i < Math.round(seconds * fps); i++) normalize.update(1 / fps, amplitude);
};
feedPeak(2, 0.16);
assert.ok(Math.abs(normalize.gain - 0.25) < 1e-5);
feedPeak(9.8, 0.008);
assert.ok(normalize.gain < 0.251, 'A loud peak stays in the ten-second window');
const beforeExpiry = normalize.gain;
feedPeak(0.4, 0.008);
assert.ok(normalize.gain > beforeExpiry && normalize.gain < 0.5, 'Peak expiry raises gain gradually');
feedPeak(12, 0.008);
assert.ok(normalize.gain > 4.9 && normalize.gain <= 5.001);
feedPeak(0.6, 0.16);
assert.ok(normalize.gain < 0.26, 'Gain falls quickly when a louder passage starts');
const heldGain = normalize.gain;
feedPeak(20, 0);
assert.equal(normalize.gain, heldGain, 'Silence must not increase sensitivity');

const automatic = new A.Spectrum(); automatic.autoSensitivity = true;
const amplitudes = new Float32Array(A.COUNT);
const feedBands = (seconds, amplitude) => {
  amplitudes.fill(0); amplitudes[2] = amplitude;
  for (let i = 0; i < Math.round(seconds * 60); i++) automatic.updateBands(1 / 60, amplitudes, 2.5);
};
feedBands(20, 0.0012);
assert.ok(automatic.effectiveGain > 5.99 && automatic.effectiveGain <= 6);
feedBands(12, 0.0008);
assert.ok(automatic.energy < 1e-10);
assert.equal(automatic.driven, 0, 'Maximum automatic gain must not promote background noise into audio');
assert.ok(automatic.shake < 1e-10);
automatic.autoSensitivity = false;
feedBands(0.1, 0.04);
assert.equal(automatic.effectiveGain, 2.5, 'Manual sensitivity replaces automatic gain');
automatic.autoSensitivity = true;
feedBands(15, 0.04);
assert.ok(Math.abs(automatic.effectiveGain - 1) < 0.001, 'Automatic gain does not multiply the saved manual value');
automatic.reset();
assert.equal(automatic.sensitivity.peak, 0); assert.equal(automatic.sensitivity.gain, 1);
assert.equal(automatic.autoSensitivity, true);
feedBands(1, 0.16); feedBands(3, 0.008);
let recoveryShake = 0;
for (let i = 0; i < 15 * 60; i++) {
  automatic.updateBands(1 / 60, amplitudes, 2.5);
  recoveryShake = Math.max(recoveryShake, automatic.shake);
}
assert.ok(recoveryShake < 0.001, 'Gain recovery on held bass must not invent new attacks');
const gains = [];
for (const fps of [20, 30, 60, 144]) {
  normalize.reset(); feedPeak(1, 0.16, fps); feedPeak(13, 0.008, fps);
  gains.push(normalize.gain);
}
assert.ok(Math.max(...gains) - Math.min(...gains) < 0.08, 'Rolling gain follows elapsed seconds across frame rates');
console.log('PASS: ten-second automatic sensitivity, gain limits, smoothing, silence gating, manual override and reset.');
