(function (root) {
  'use strict';
  const COUNT = 24,
    MIN_HZ = 30,
    MAX_HZ = 16000;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const follow = (from, to, dt, attack, release) =>
    from + (to - from) * (1 - Math.exp(-dt / (to > from ? attack : release)));
  const levelOf = (amplitude) => Math.pow(clamp((20 * Math.log10(Math.max(1e-9, amplitude)) + 62) / 44), 1.1);
  const edges = Float64Array.from(
    { length: COUNT + 1 },
    (_, i) => MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / COUNT)
  );
  const centers = Float64Array.from({ length: COUNT }, (_, i) => Math.sqrt(edges[i] * edges[i + 1]));
  const hues = Float32Array.from(centers, (hz) =>
    hz < 160
      ? 0.78 - (0.08 * Math.log(hz / MIN_HZ)) / Math.log(160 / MIN_HZ)
      : hz < 4000
        ? 0.7 - (0.665 * Math.log(hz / 160)) / Math.log(4000 / 160)
        : 0.035 * (1 - Math.log(hz / 4000) / Math.log(MAX_HZ / 4000))
  );
  function readBands(db, sampleRate, fftSize, out) {
    out.fill(0);
    if (!db) return;
    const binHz = sampleRate / fftSize;
    for (let band = 0; band < COUNT; band++) {
      let power = 0,
        weight = 0,
        peak = 0;
      const lo = edges[band] / binHz,
        hi = Math.min(edges[band + 1] / binHz, db.length - 0.5);
      // Fractional coverage includes bass bands narrower than one FFT bin.
      for (
        let bin = Math.max(1, Math.ceil(lo - 0.5));
        bin <= Math.min(db.length - 1, Math.floor(hi + 0.5));
        bin++
      ) {
        const w = Math.max(0, Math.min(hi, bin + 0.5) - Math.max(lo, bin - 0.5));
        const p = Number.isFinite(db[bin]) ? Math.pow(10, db[bin] / 10) : 0;
        power += w * p;
        weight += w;
        peak = Math.max(peak, p * w);
      }
      out[band] = weight > 0 ? 0.65 * Math.sqrt(peak) + 0.35 * Math.sqrt(power / weight) : 0;
    }
  }

  class AutoSensitivity {
    constructor() {
      this.peaks = new Float32Array(101);
      this.times = new Float64Array(101);
      this.reset();
    }
    reset() {
      this.peaks.fill(0);
      this.times.fill(-Infinity);
      this.time = 0;
      this.bucket = -1;
      this.gain = 1;
      this.peak = 0;
    }
    update(dt, amplitude) {
      this.time += dt;
      const bucket = Math.floor(this.time * 10 + 1e-9), index = bucket % this.peaks.length;
      // Ten seconds of peaks in 100 ms buckets, without per-frame allocations.
      if (bucket !== this.bucket) {
        if (bucket - this.bucket >= this.peaks.length) {
          this.peaks.fill(0);
          this.times.fill(-Infinity);
        }
        this.peaks[index] = 0;
        this.bucket = bucket;
      }
      if (amplitude >= this.peaks[index]) {
        this.peaks[index] = amplitude;
        this.times[index] = this.time;
      }
      this.peak = 0;
      for (let i = 0; i < this.peaks.length; i++)
        if (this.time - this.times[i] <= 10) this.peak = Math.max(this.peak, this.peaks[i]);
      if (amplitude >= 0.001) {
        const target = Math.max(0.25, Math.min(6, 0.04 / this.peak));
        this.gain = Math.exp(follow(Math.log(this.gain), Math.log(target), dt, 2, 0.12));
      }
      return this.gain;
    }
  }

  class ResponseBank {
    constructor() {
      for (const name of [
        'amplitudes',
        'fastAmplitudes',
        'rawLevels',
        'targets',
        'levels',
        'average',
        'attackBase',
        'attacks'
      ])
        this[name] = new Float32Array(COUNT);
      this.reset();
    }
    reset() {
      for (const name of [
        'amplitudes',
        'fastAmplitudes',
        'rawLevels',
        'targets',
        'levels',
        'attackBase',
        'attacks'
      ])
        this[name].fill(0);
      this.average.fill(0.025);
    }
    update(dt, gain, balance) {
      for (let i = 0; i < this.levels.length; i++) {
        const amplitude = this.amplitudes[i],
          raw = levelOf(amplitude * gain);
        this.rawLevels[i] = raw;
        // Freeze the reference below the noise gate; never normalize silence upward.
        if (raw > 0.025) this.average[i] = follow(this.average[i], amplitude, dt, 2, 5);
        const adaptive = Math.max(0.4, Math.min(4, 0.04 / Math.max(this.average[i], 0.004)));
        const tilt = Math.max(0.85, Math.min(1.6, Math.pow(centers[i] / 250, 0.1)));
        const adjusted = levelOf(amplitude * gain * Math.pow(adaptive * tilt, balance));
        this.targets[i] = adjusted * clamp(raw / 0.1);
        this.levels[i] = follow(this.levels[i], this.targets[i], dt, 0.028, 0.2);
        const fast = levelOf(this.fastAmplitudes[i] * gain);
        const onset = clamp((fast - this.attackBase[i] - 0.055) * 3);
        this.attackBase[i] = follow(this.attackBase[i], fast, dt, 0.075, 0.16);
        this.attacks[i] = Math.max(this.attacks[i] * Math.exp(-dt / 0.16), onset);
      }
    }
  }

  class Spectrum {
    constructor() {
      this.frequency = new ResponseBank();
      this.sensitivity = new AutoSensitivity();
      this.autoSensitivity = false;
      this.silenceThreshold = 0;
      this.balance = 0.75;
      this.reset();
    }
    get levels() {
      return this.frequency.levels;
    }
    get targets() {
      return this.frequency.targets;
    }
    get attacks() {
      return this.frequency.attacks;
    }
    reset() {
      this.frequency.reset();
      this.sensitivity.reset();
      this.effectiveGain = 1;
      this.energy = 0;
      this.bass = 0;
      this.shake = 0;
      this.time = 0;
      this.driven = 0;
      this.silenceSeconds = 0;
      this.silenceFrom = 0;
      this.signalPresent = false;
    }
    readFFT(db, sampleRate, fftSize, gain = 1) {
      readBands(db, sampleRate, fftSize, this.frequency.amplitudes);
      for (let i = 0; i < COUNT; i++)
        this.frequency.targets[i] = levelOf(this.frequency.amplitudes[i] * gain);
    }
    update(dt, db, sampleRate = 48000, fftSize = 4096, gain = 1, analysis = {}) {
      this.readFFT(db, sampleRate, fftSize, gain);
      readBands(
        analysis.attacks === undefined ? db : analysis.attacks,
        sampleRate,
        analysis.attackSize || fftSize,
        this.frequency.fastAmplitudes
      );
      this.advance(dt, gain);
    }
    updateBands(dt, amplitudes, gain = 1, attacks = amplitudes) {
      for (let i = 0; i < COUNT; i++) {
        this.frequency.amplitudes[i] = Number.isFinite(amplitudes?.[i]) ? clamp(amplitudes[i]) : 0;
        this.frequency.fastAmplitudes[i] = Number.isFinite(attacks?.[i]) ? clamp(attacks[i]) : 0;
      }
      this.advance(dt, gain);
    }
    advance(dt, gain) {
      dt = Math.max(0, dt);
      this.time += dt;
      const amplitude = Math.max(...this.frequency.amplitudes, ...this.frequency.fastAmplitudes);
      // Gate the input before sensitivity can amplify background noise.
      const audible = amplitude > this.silenceThreshold;
      if (!audible) {
        this.frequency.amplitudes.fill(0);
        this.frequency.fastAmplitudes.fill(0);
      }
      const automaticGain = this.sensitivity.update(dt, audible ? amplitude : 0);
      if (this.autoSensitivity) gain = automaticGain;
      this.effectiveGain = gain;
      this.frequency.update(dt, gain, this.balance);
      if (audible) {
        this.driven = follow(this.driven, 1, dt, 0.15, 0.25);
        this.silenceSeconds = 0;
        this.signalPresent = true;
      } else {
        if (this.silenceSeconds === 0) this.silenceFrom = this.driven;
        this.signalPresent = false;
        this.silenceSeconds += dt;
        const t = clamp((this.silenceSeconds - 3) / 6);
        this.driven = this.silenceFrom * (1 - t * t * (3 - 2 * t));
      }
      let energy = 0,
        bass = 0,
        kick = 0;
      for (const level of this.levels) energy += level * level;
      for (let i = 0; i < COUNT; i++)
        if (centers[i] < 160) {
          bass = Math.max(bass, this.frequency.rawLevels[i]);
          kick = Math.max(
            kick,
            this.frequency.attacks[i] * clamp((this.frequency.rawLevels[i] - 0.48) / 0.32)
          );
        }
      this.energy = Math.sqrt(energy / this.levels.length);
      this.bass = bass;
      this.shake = Math.max(this.shake * Math.exp(-dt / 0.1), 0.65 * kick);
    }
    offset(strength = 1) {
      const a = this.shake * strength,
        t = this.time;
      return [
        a * 0.008 * (0.65 * Math.sin(t * 57) + 0.35 * Math.sin(t * 83 + 1.2)),
        a * 0.006 * (0.65 * Math.sin(t * 65 + 0.7) + 0.35 * Math.sin(t * 91)),
        a * 0.0025 * Math.sin(t * 48 + 0.3)
      ];
    }
  }
  const api = { Spectrum, AutoSensitivity, COUNT, edges, centers, hues };
  root.GravityAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
