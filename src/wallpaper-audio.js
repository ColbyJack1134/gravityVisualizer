(function (root) {
  'use strict';
  const A = root.GravityAudio || require('./audio.js');
  const magnitude = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  class WallpaperAudio {
    constructor(clock = () => performance.now()) {
      this.clock = clock;
      this.stereo = new Float32Array(128);
      this.mono = new Float32Array(64);
      this.bands = new Float32Array(A.COUNT);
      this.peaks = new Float32Array(A.COUNT);
      this.callbacks = 0;
      this.reset();
    }
    reset() {
      this.stereo.fill(0);
      this.mono.fill(0);
      this.bands.fill(0);
      this.peaks.fill(0);
      this.receivedAt = -Infinity;
    }
    receive(samples) {
      if (!samples || samples.length !== 128) return;
      this.callbacks++;
      this.receivedAt = this.clock();
      for (let i = 0; i < 128; i++) this.stereo[i] = magnitude(samples[i]);
      for (let i = 0; i < 64; i++)
        this.mono[i] = Math.hypot(this.stereo[i], this.stereo[i + 64]) / Math.SQRT2;
      // Host bands are ordered magnitudes, not linear FFT bins or decibels.
      for (let band = 0; band < A.COUNT; band++) {
        const lo = band * 64 / A.COUNT, hi = (band + 1) * 64 / A.COUNT;
        let power = 0, peak = 0;
        for (let bin = Math.floor(lo); bin < Math.ceil(hi); bin++) {
          const weight = Math.min(hi, bin + 1) - Math.max(lo, bin);
          power += weight * this.mono[bin] ** 2;
          peak = Math.max(peak, this.mono[bin] * Math.sqrt(weight));
        }
        this.bands[band] = 0.08 * (0.65 * peak + 0.35 * Math.sqrt(power / (hi - lo)));
        this.peaks[band] = Math.max(this.peaks[band], this.bands[band]);
      }
    }
    update(spectrum, dt, gain) {
      const fresh = this.clock() - this.receivedAt <= 250;
      spectrum.updateBands(dt, fresh ? this.peaks : null, gain);
      // Keep the latest sample between callbacks; preserve shorter peaks until consumed.
      this.peaks.set(this.bands);
    }
  }
  root.GravityWallpaperAudio = WallpaperAudio;
  if (typeof module !== 'undefined' && module.exports) module.exports = WallpaperAudio;
})(globalThis);
