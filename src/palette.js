(function (root) {
  'use strict';
  const wrap = (x) => ((x % 1) + 1) % 1;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const validHex = (value) => /^#[0-9a-f]{6}$/i.test(value);
  const linear = (rgb) => rgb.map((v) => Math.pow(v, 2.2));
  const stellarColors = ['#ffc38a', '#ffe0bd', '#fff4ea', '#cadcff'];
  const stellarWeights = [15, 15, 60, 10];
  function shares(weights, total = 100) {
    const sum = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map(w => total * (sum > 0 ? w / sum : 1 / weights.length));
    const result = exact.map(Math.floor);
    const order = exact.map((v, i) => i).sort((a, b) => (exact[b] - result[b]) - (exact[a] - result[a]));
    const remaining = total - result.reduce((a, b) => a + b, 0);
    for (let i = 0; i < remaining; i++) result[order[i]]++;
    return result;
  }
  function hexRGB(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
  function hsv(h, s) {
    return [0, 2 / 3, 1 / 3].map((shift) => 1 - s + s * clamp(Math.abs(wrap(h + shift) * 6 - 3) - 1));
  }
  function css(linearRGB) {
    return (
      '#' +
      linearRGB
        .map((v) =>
          Math.round(Math.pow(clamp(v), 1 / 2.2) * 255)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    );
  }
  function blend(idle, audio, amount, out) {
    const t = clamp(amount);
    for (let i = 0; i < out.length; i++) out[i] = idle[i] + (audio[i] - idle[i]) * t;
    return out;
  }
  class Palette {
    constructor() {
      this.mode = 'hsv';
      this.solid = '#aa44ff';
      this.saturation = 1;
      this.hsv = { offset: 0, animated: true, speed: 0.5 };
      this.custom = {
        offset: 0,
        animated: true,
        speed: 0.5,
        stops: ['#23D183', '#1DCA97', '#17C2AB', '#12BBC0', '#0CB3D4', '#06ACE8']
      };
      this.weighted = {
        offset: 0, animated: false, speed: 0.5,
        stops: stellarColors.slice(), weights: stellarWeights.slice()
      };
      this.revision = 0;
    }
    get gradient() {
      return this.mode === 'solid' ? null : this[this.mode];
    }
    get editableGradient() {
      return this.mode === 'weighted' ? this.weighted : this.custom;
    }
    apply(settings) {
      if (settings.mode !== undefined) this.setMode(settings.mode);
      if (typeof settings.solid === 'string') this.setSolid(settings.solid);
      if (Number.isFinite(settings.saturation)) this.setSaturation(settings.saturation);
      for (const mode of ['hsv', 'custom', 'weighted']) {
        const changes = settings[mode];
        if (!changes || typeof changes !== 'object') continue;
        const gradient = this[mode];
        if (Number.isFinite(changes.offset)) gradient.offset = wrap(changes.offset);
        if (Number.isFinite(changes.speed)) gradient.speed = Math.max(-3, Math.min(3, changes.speed));
        if (typeof changes.animated === 'boolean') gradient.animated = changes.animated;
        if (mode !== 'hsv' && Array.isArray(changes.stops) &&
            changes.stops.length >= 2 && changes.stops.length <= 6 &&
            changes.stops.every((color) => typeof color === 'string' && validHex(color)))
          gradient.stops = changes.stops.slice();
        if (mode === 'weighted') {
          const weights = Array.isArray(changes.weights) && changes.weights.length === gradient.stops.length &&
            changes.weights.every(v => Number.isFinite(v) && v >= 0) ? changes.weights : gradient.weights;
          gradient.weights = shares(gradient.stops.map((_, i) => weights[i] ?? 0));
        }
        this.revision++;
      }
    }
    setMode(mode) {
      if (['solid', 'hsv', 'custom', 'weighted'].includes(mode)) {
        this.mode = mode;
        this.revision++;
      }
    }
    setSolid(hex) {
      if (validHex(hex)) {
        this.solid = hex;
        this.revision++;
      }
    }
    setSaturation(value) {
      this.saturation = clamp(value);
      this.revision++;
    }
    setOffset(value) {
      if (this.gradient) {
        this.gradient.offset = wrap(value);
        this.revision++;
      }
    }
    setAnimated(value) {
      if (this.gradient) this.gradient.animated = Boolean(value);
    }
    setSpeed(value) {
      if (this.gradient) this.gradient.speed = Math.max(-3, Math.min(3, value));
    }
    setStop(index, hex) {
      if (index >= 0 && index < this.editableGradient.stops.length && validHex(hex)) {
        this.editableGradient.stops[index] = hex;
        this.revision++;
      }
    }
    setWeight(index, value) {
      const weights = this.weighted.weights;
      if (!Number.isInteger(index) || index < 0 || index >= weights.length || !Number.isFinite(value)) return;
      const share = Math.round(clamp(value / 100) * 100);
      const rest = shares(weights.filter((_, i) => i !== index), 100 - share);
      rest.splice(index, 0, share);
      this.weighted.weights = rest;
      this.revision++;
    }
    addStop() {
      if (this.editableGradient.stops.length >= 6) return;
      const stops = this.editableGradient.stops,
        a = linear(hexRGB(stops.at(-1))),
        b = linear(hexRGB(stops[0]));
      stops.push(css(a.map((v, i) => (v + b[i]) / 2)));
      if (this.mode === 'weighted') {
        this.weighted.weights.push(0);
        this.setWeight(stops.length - 1, Math.round(100 / stops.length));
      }
      this.revision++;
    }
    removeStop(index) {
      if (this.editableGradient.stops.length > 2 && index >= 0 && index < this.editableGradient.stops.length) {
        this.editableGradient.stops.splice(index, 1);
        if (this.mode === 'weighted') {
          this.weighted.weights.splice(index, 1);
          this.weighted.weights = shares(this.weighted.weights);
        }
        this.revision++;
      }
    }
    advance(dt, paused = false) {
      const g = this.gradient;
      if (!paused && g?.animated && g.speed !== 0 && dt > 0) {
        g.offset = wrap(g.offset + (dt * g.speed) / 60);
        this.revision++;
      }
    }
    writeColors(hues, out) {
      if (this.mode === 'weighted') return this.writeSamples(hues, out);
      const stops = this.mode === 'custom' ? this.custom.stops.map((c) => linear(hexRGB(c))) : null;
      const solid = this.mode === 'solid' ? linear(hexRGB(this.solid)) : null;
      for (let band = 0; band < hues.length; band++) {
        let color;
        if (solid) color = solid;
        else if (this.mode === 'hsv') color = linear(hsv(hues[band] + this.hsv.offset, this.saturation));
        else {
          // Reserve one segment to close the loop when animating the offset.
          const position =
            wrap(((band / (hues.length - 1)) * (stops.length - 1)) / stops.length + this.custom.offset) *
            stops.length;
          const index = Math.floor(position),
            fraction = position - index;
          const a = stops[index],
            b = stops[(index + 1) % stops.length];
          color = a.map((v, i) => v + (b[i] - v) * fraction);
        }
        out.set(color, band * 3);
      }
      return out;
    }
    writeSamples(hues, out) {
      const count = out.length / 3;
      if (this.mode !== 'weighted') {
        const bands = this.writeColors(hues, new Float32Array(hues.length * 3));
        for (let i = 0; i < count; i++) {
          const band = Math.min(hues.length - 1, Math.floor(i * hues.length / count));
          for (let c = 0; c < 3; c++) out[i * 3 + c] = bands[band * 3 + c];
        }
        return out;
      }
      const g = this.weighted;
      const stops = g.stops.map((c, i) => ({ color: linear(hexRGB(c)), width: g.weights[i] / 100 }))
        .filter(stop => stop.width > 0);
      for (let i = 0; i < count; i++) {
        const position = wrap((i + .5) / count + g.offset);
        let start = 0;
        for (let j = 0; j < stops.length; j++) {
          const current = stops[j], end = start + current.width;
          if (position < end || j === stops.length - 1) {
            const previous = stops[(j + stops.length - 1) % stops.length], next = stops[(j + 1) % stops.length];
            const leading = .2 * Math.min(previous.width, current.width);
            const trailing = .2 * Math.min(current.width, next.width);
            let a = current.color, b = a, t = 0;
            if (position < start + leading) {
              a = previous.color;
              t = (position - start + leading) / (2 * leading);
            } else if (position > end - trailing) {
              b = next.color;
              t = (position - end + trailing) / (2 * trailing);
            }
            t = clamp(t); t *= t * (3 - 2 * t);
            for (let channel = 0; channel < 3; channel++)
              out[i * 3 + channel] = a[channel] + (b[channel] - a[channel]) * t;
            break;
          }
          start = end;
        }
      }
      return out;
    }
  }
  const api = { Palette, blend, wrap, hsv, hexRGB, css };
  root.GravityPalette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
