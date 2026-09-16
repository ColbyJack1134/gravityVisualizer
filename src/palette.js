(function (root) {
  'use strict';
  const wrap = (x) => ((x % 1) + 1) % 1;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const validHex = (value) => /^#[0-9a-f]{6}$/i.test(value);
  const linear = (rgb) => rgb.map((v) => Math.pow(v, 2.2));
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
      this.revision = 0;
    }
    get gradient() {
      return this.mode === 'solid' ? null : this[this.mode];
    }
    setMode(mode) {
      if (['solid', 'hsv', 'custom'].includes(mode)) {
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
      if (index >= 0 && index < this.custom.stops.length && validHex(hex)) {
        this.custom.stops[index] = hex;
        this.revision++;
      }
    }
    addStop() {
      if (this.custom.stops.length >= 6) return;
      const stops = this.custom.stops,
        a = linear(hexRGB(stops.at(-1))),
        b = linear(hexRGB(stops[0]));
      stops.push(css(a.map((v, i) => (v + b[i]) / 2)));
      this.revision++;
    }
    removeStop(index) {
      if (this.custom.stops.length > 2 && index >= 0 && index < this.custom.stops.length) {
        this.custom.stops.splice(index, 1);
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
  }
  const api = { Palette, wrap, hsv, hexRGB, css };
  root.GravityPalette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
