(function () {
  'use strict';
  const numbers = {
    audiogain: ['audioGain', 1], audiobalance: ['balance', 0.01],
    sustainedamount: ['sustainStrength', 0.01], bassshake: ['shakeStrength', 0.01],
    stardensity: ['starDensity', 0.01], clouddensity: ['cloudDensity', 0.01],
    movement: ['motionStrength', 0.01], tilt: ['roll', Math.PI / 180],
    framing: ['framing', 0.01], framingy: ['framingY', 0.01],
    elevation: ['elevation', 1], distance: ['distance', 1], spin: ['spin', 1],
    material: ['material', 0.01], exposure: ['exposure', 1], sharpness: ['sharpness', 0.01],
    particlefade: ['fadeSeconds', 1], timescale: ['speed', 1], particles: ['count', 1]
  };
  function color(value) {
    if (typeof value !== 'string') return null;
    const rgb = value.trim().split(/\s+/).map(Number);
    if (rgb.length !== 3 || !rgb.every(Number.isFinite)) return null;
    return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  }
  const host = {
    renderer: null,
    pending: {},
    fps: 30,
    paused: false,
    registered: false,
    applyUserProperties(properties) {
      if (!properties || typeof properties !== 'object') return;
      for (const [key, property] of Object.entries(properties)) {
        if (property && typeof property === 'object' && Object.hasOwn(property, 'value'))
          this.pending[key] = property.value;
      }
      if (this.renderer) {
        clearTimeout(this.settingsTimer);
        this.settingsTimer = setTimeout(() => this.flush(), 120);
      }
    },
    applyGeneralProperties(properties) {
      if (typeof properties?.fps !== 'number' || !Number.isFinite(properties.fps)) return;
      this.fps = Math.max(0, Math.min(360, properties.fps));
      this.renderer?.applySettings({ fpsLimit: this.fps });
    },
    setPaused(paused) {
      if (typeof paused !== 'boolean') return;
      this.paused = paused;
      this.renderer?.setSuspended(paused);
    },
    flush() {
      if (!this.renderer) return;
      clearTimeout(this.settingsTimer);
      const values = this.pending, settings = {}, palette = {};
      this.pending = {};
      for (const [key, [field, scale]] of Object.entries(numbers)) {
        const value = values[key];
        if (value !== undefined && value !== '' && (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)))
          settings[field] = Number(value) * scale;
      }
      for (const key of ['spinning', 'paused'])
        if (typeof values[key] === 'boolean') settings[key] = values[key];
      if (values.quality !== undefined) settings.quality = values.quality;
      if (values.cameramotion !== undefined) settings.cameraMotion = values.cameramotion;
      if (values.colormode !== undefined) palette.mode = values.colormode;
      const solid = color(values.solidcolor);
      if (solid) palette.solid = solid;
      if (typeof values.saturation === 'number' && Number.isFinite(values.saturation))
        palette.saturation = values.saturation / 100;
      for (const mode of ['hsv', 'custom']) {
        const changes = {};
        if (typeof values[mode + 'offset'] === 'number') changes.offset = values[mode + 'offset'] / 100;
        if (typeof values[mode + 'speed'] === 'number') changes.speed = values[mode + 'speed'];
        if (typeof values[mode + 'animate'] === 'boolean') changes.animated = values[mode + 'animate'];
        if (Object.keys(changes).length) palette[mode] = changes;
      }
      let colorsChanged = false;
      if (Number.isFinite(values.customcount)) {
        this.customCount = Math.max(2, Math.min(6, Math.round(values.customcount)));
        colorsChanged = true;
      }
      for (let i = 0; i < 6; i++) {
        const hex = color(values['customcolor' + (i + 1)]);
        if (hex) {
          this.customStops[i] = hex;
          colorsChanged = true;
        }
      }
      if (colorsChanged) palette.custom = { ...palette.custom, stops: this.customStops.slice(0, this.customCount) };
      if (Object.keys(palette).length) settings.palette = palette;
      try {
        this.renderer.applySettings(settings);
      } catch (error) {
        this.renderer.fail(error);
      }
    },
    start() {
      if (this.renderer) return;
      try {
        this.audio = new GravityWallpaperAudio();
        if (!this.registered && typeof window.wallpaperRegisterAudioListener === 'function') {
          this.registered = true;
          window.wallpaperRegisterAudioListener((samples) => {
            if (!this.paused) this.audio.receive(samples);
          });
        }
        this.renderer = new GravityRenderer(document.getElementById('universe'));
        this.renderer.audioInput = this.audio;
        this.renderer.onError = showError;
        this.customStops = this.renderer.palette.custom.stops.slice();
        this.customCount = this.customStops.length;
        this.flush();
        this.renderer.applySettings({ fpsLimit: this.fps });
        this.renderer.setSuspended(this.paused);
        this.renderer.start();
      } catch (error) {
        console.error(error);
        showError(error);
      }
    }
  };
  function showError(error) {
    document.getElementById('error').hidden = false;
    document.getElementById('error').textContent = error.message;
  }
  window.GravityWallpaper = host;
  window.wallpaperPropertyListener = {
    applyUserProperties: (properties) => host.applyUserProperties(properties),
    applyGeneralProperties: (properties) => host.applyGeneralProperties(properties),
    setPaused: (paused) => host.setPaused(paused)
  };
})();
