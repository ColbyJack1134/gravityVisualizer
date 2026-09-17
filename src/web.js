(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  class WebDemo extends GravityRenderer {
    constructor() {
      super($('universe'));
      this.paletteTarget = 'audio';
      this.audioContext = null;
      this.audioURL = null;
      this.captureStream = null;
      this.captureSource = null;
      this.capturePending = false;
      this.captureEpoch = 0;
      this.audioInput = { update: (spectrum, dt, gain) => this.readAudio(spectrum, dt, gain) };
      this.onPalette = (force) => this.syncPalettePreview(force);
      this.onAudio = () => this.syncSpectrum();
      this.onSettings = () => this.syncUI();
      this.onStats = () => {
        $('fps').textContent = Math.round(this.measuredFPS);
        $('gpu-time').textContent = this.gpuMs === null ? 'Unavailable' : this.gpuMs.toFixed(1) + ' ms';
      };
      this.onTrace = (progress, message) => {
        $('trace-status').hidden = progress >= 1;
        if (message) $('trace-text').textContent = message;
        $('trace-progress').style.width = Math.round(progress * 100) + '%';
        $('trace-percent').textContent = Math.round(progress * 100) + '%';
        $('resolution').textContent = this.rw + ' × ' + this.rh;
        $('output-resolution').textContent = this.canvas.width + ' × ' + this.canvas.height;
      };
      this.onError = showError;
      this.bindUI();
      this.createSpectrumUI();
      this.renderColorStops();
      this.readParameters();
      this.start();
      this.syncUI();
    }
    syncPalettePreview(force) {
      if (force || this.frames % 4 === 0) {
        const preview = this.paletteTarget === 'idle' ? this.idleColors : this.audioColors;
        const colors = this.bandBars.map((bar, i) => {
          bar.style.background = GravityPalette.css(Array.from(this.audioColors.subarray(i * 3, i * 3 + 3)));
          return GravityPalette.css(Array.from(preview.subarray(i * 3, i * 3 + 3)));
        });
        $('palette-preview').style.background = 'linear-gradient(to right,' + colors.join(',') + ')';
        if (this.editedPalette.gradient) {
          const percent = this.editedPalette.gradient.offset * 100;
          $('palette-offset').value = percent;
          $('palette-offset-value').textContent = percent.toFixed(0) + '%';
        }
      }
    }
    readAudio(spectrum, dt, gain) {
      let bins = null,
        attacks = null;
      const active = this.captureStream
        ? this.captureStream.getAudioTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted)
        : !$('music').paused && !$('music').ended;
      if (this.analyser && active) {
        this.analyser.getFloatFrequencyData(this.audioBins);
        this.attackAnalyser.getFloatFrequencyData(this.attackBins);
        bins = this.audioBins;
        attacks = this.attackBins;
      }
      spectrum.update(dt, bins, this.audioContext?.sampleRate, 4096, gain, {
        attacks,
        attackSize: 1024
      });
    }
    syncSpectrum() {
      if (this.frames % 4 === 0) {
        const height = $('spectrum-bars').clientHeight;
        this.bandBars.forEach((bar, i) => {
          bar.style.height = Math.max(1, Math.round(height * (0.04 + 0.96 * this.spectrum.levels[i]))) + 'px';
          bar.style.opacity = 0.65 + 0.35 * this.spectrum.attacks[i];
        });
      }
    }
    createSpectrumUI() {
      const labels = Array.from(GravityAudio.centers, (hz) => Math.round(hz) + ' Hz');
      $('spectrum-bars').replaceChildren();
      this.bandBars = labels.map((label) => {
        const bar = document.createElement('span');
        bar.title = label;
        $('spectrum-bars').append(bar);
        return bar;
      });
    }
    get editedPalette() {
      return this.paletteTarget === 'idle' ? this.idlePalette : this.palette;
    }
    syncPaletteUI() {
      const p = this.editedPalette,
        g = p.gradient;
      $('color-mode').value = p.mode;
      $('solid-controls').hidden = p.mode !== 'solid';
      $('hsv-controls').hidden = p.mode !== 'hsv';
      $('custom-controls').hidden = p.mode !== 'custom';
      $('gradient-controls').hidden = !g;
      $('solid-color').value = p.solid;
      $('palette-saturation').value = p.saturation * 100;
      $('palette-saturation-value').textContent = Math.round(p.saturation * 100) + '%';
      if (g) {
        $('palette-offset').value = g.offset * 100;
        $('palette-offset-value').textContent = Math.round(g.offset * 100) + '%';
        $('palette-animate').checked = g.animated;
        $('palette-speed').value = g.speed;
        $('palette-speed').disabled = !g.animated;
        $('palette-speed-value').textContent = g.speed.toFixed(2) + ' cycles/min';
      }
      $('add-color').disabled = p.custom.stops.length >= 6;
    }
    renderColorStops() {
      const container = $('custom-colors');
      container.replaceChildren();
      this.editedPalette.custom.stops.forEach((color, index) => {
        const row = document.createElement('div');
        row.className = 'color-stop';
        const label = document.createElement('label');
        label.textContent = 'Color ' + (index + 1);
        const input = document.createElement('input');
        input.type = 'color';
        input.value = color;
        input.dataset.stop = index;
        input.setAttribute('aria-label', 'Gradient color ' + (index + 1));
        input.addEventListener('input', () => {
          this.editedPalette.setStop(index, input.value);
          this.refreshPalette(true);
        });
        label.append(input);
        row.append(label);
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.type = 'button';
        remove.disabled = this.editedPalette.custom.stops.length <= 2;
        remove.setAttribute('aria-label', 'Remove gradient color ' + (index + 1));
        remove.addEventListener('click', () => {
          this.editedPalette.removeStop(index);
          this.renderColorStops();
          this.syncPaletteUI();
          this.refreshPalette(true);
        });
        row.append(remove);
        container.append(row);
      });
    }
    syncUI() {
      for (const b of document.querySelectorAll('[data-metric]')) {
        const on = (b.dataset.metric === 'spin') === this.spinning;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on);
      }
      $('spin').disabled = !this.spinning;
      $('spin').value = this.spin;
      $('spin-value').textContent = this.a().toFixed(2);
      $('pause').textContent = this.paused ? 'Resume' : 'Pause';
      $('camera-amount').value = this.motionStrength * 100;
      $('camera-roll').value = this.roll * 180 / Math.PI;
      $('roll-value').textContent = Math.round(this.roll * 180 / Math.PI) + '°';
      $('fps-limit').value = this.fpsLimit;
      $('quality').value = this.quality;
      $('particles').value = this.count;
      $('material').value = Math.round(this.material * 100);
      $('material-value').textContent = Math.round(this.material * 100) + '%';
      $('exposure').value = this.exposure;
      $('exposure-value').textContent = this.exposure.toFixed(1) + '×';
      $('sharpness').value = Math.round(this.sharpness * 100);
      $('sharpness-value').textContent = Math.round(this.sharpness * 100) + '%';
      $('star-appearance').value = this.starAppearance;
      $('star-definition-controls').hidden = this.starAppearance === 'soft';
      $('particle-fade').value = this.fadeSeconds;
      $('particle-fade-value').textContent = this.fadeSeconds.toFixed(1) + ' s';
      this.syncPaletteUI();
      $('speed').value = this.speed;
      $('speed-value').textContent = this.speed + '×';
      $('camera-motion').value = this.cameraMotion;
      $('framing').value = this.framing * 100;
      $('framing-y').value = this.framingY * 100;
      for (const [id, value] of [
        ['audio-balance', this.spectrum.balance],
        ['sustained-light', this.sustainStrength],
        ['star-definition', this.starDefinition],
        ['star-density', this.starDensity],
        ['cloud-density', this.cloudDensity]
      ]) {
        $(id).value = Math.round(value * 100);
        $(id + '-value').textContent = Math.round(value * 100) + '%';
      }
      $('audio-gain').value = this.audioGain;
      $('audio-gain-value').textContent = this.audioGain.toFixed(1) + '×';
      $('auto-sensitivity').checked = this.spectrum.autoSensitivity;
      $('silence-cutoff').value = this.spectrum.silenceThreshold * 100;
      $('silence-cutoff-value').textContent = this.spectrum.silenceThreshold > 0
        ? (this.spectrum.silenceThreshold * 100).toFixed(1) + '%' : 'Off';
      $('show-idle-particles').checked = this.showIdleParticles;
      $('manual-sensitivity').hidden = this.spectrum.autoSensitivity;
      $('bass-shake').value = this.shakeStrength * 100;
      $('bass-shake-value').textContent = Math.round(this.shakeStrength * 100) + '%';
      $('elevation').value = Math.round(90 - (this.camera.theta * 180) / Math.PI);
      $('elevation-value').textContent = $('elevation').value + '°';
      $('distance').value = this.camera.distance;
      $('distance-value').textContent = Math.round(this.camera.distance);
    }
    togglePause() {
      this.applySettings({ paused: !this.paused });
    }
    toggleUI() {
      const hidden = !$('controls').hidden;
      $('controls').hidden = hidden;
      $('quick-controls').hidden = !hidden;
      $('show-ui').setAttribute('aria-expanded', !hidden);
      $(hidden ? 'show-ui' : 'hide-ui').focus();
    }
    async fullscreen() {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) {
        if ($('controls').hidden) this.toggleUI();
        this.controlError('Fullscreen is unavailable in this browser window.');
      }
    }
    controlError(message) {
      $('control-error').textContent = message;
      $('control-error').hidden = false;
    }
    async initializeAudio() {
      if (!this.audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContext();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 4096;
        this.analyser.smoothingTimeConstant = 0;
        this.audioBins = new Float32Array(this.analyser.frequencyBinCount);
        this.mediaSource = this.audioContext.createMediaElementSource($('music'));
        this.mediaSource.connect(this.analyser);
        this.mediaSource.connect(this.audioContext.destination);
        this.attackAnalyser = this.audioContext.createAnalyser();
        this.attackAnalyser.fftSize = 1024;
        this.attackAnalyser.smoothingTimeConstant = 0;
        this.attackBins = new Float32Array(this.attackAnalyser.frequencyBinCount);
        this.mediaSource.connect(this.attackAnalyser);
      }
      await this.audioContext.resume();
    }
    syncCaptureUI() {
      const capturing = !!this.captureStream;
      $('computer-audio').textContent = this.capturePending ? 'Connecting…' : capturing ? 'Stop capture' : 'Computer audio';
      $('computer-audio').setAttribute('aria-pressed', capturing);
      $('computer-audio').disabled = this.capturePending;
      $('audio-file-button').disabled = this.capturePending;
      $('file-audio').hidden = capturing;
      $('capture-status').hidden = !capturing;
    }
    audioError(message = '') {
      $('audio-error').textContent = message;
      $('audio-error').hidden = !message;
    }
    async startComputerAudio() {
      if (this.capturePending || this.captureStream) return;
      this.audioError();
      if (!navigator.mediaDevices?.getDisplayMedia) {
        this.audioError('Computer audio needs a supported browser such as Chrome or Edge over HTTPS or localhost.');
        return;
      }
      const epoch = ++this.captureEpoch;
      this.capturePending = true;
      this.syncCaptureUI();
      let stream, source;
      try {
        const capture = navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'monitor', frameRate: 1 },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
          systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include'
        });
        const [shared, initialized] = await Promise.allSettled([capture, this.initializeAudio()]);
        if (shared.status === 'fulfilled') stream = shared.value;
        if (epoch !== this.captureEpoch) {
          stream?.getTracks().forEach(track => track.stop());
          return;
        }
        if (shared.status === 'rejected') throw shared.reason;
        if (initialized.status === 'rejected') throw initialized.reason;
        if (!stream.getAudioTracks().some(track => track.readyState === 'live'))
          throw new Error('No audio was shared. Try again and enable audio sharing for a screen or tab.');
        source = this.audioContext.createMediaStreamSource(stream);
        // Analyze captured audio without playing it a second time.
        source.connect(this.analyser);
        source.connect(this.attackAnalyser);
        this.captureStream = stream;
        this.captureSource = source;
        $('music').pause();
        this.spectrum.reset();
        for (const track of stream.getTracks()) track.addEventListener('ended', () => {
          if (this.captureStream === stream) this.stopComputerAudio();
        });
      } catch (error) {
        source?.disconnect();
        stream?.getTracks().forEach(track => track.stop());
        if (epoch === this.captureEpoch) this.audioError(error.name === 'NotAllowedError'
          ? 'Audio sharing was canceled or blocked. Choose Computer audio to try again.'
          : error.message || 'Computer audio is unavailable in this browser.');
      } finally {
        if (epoch === this.captureEpoch) {
          this.capturePending = false;
          this.syncCaptureUI();
        }
      }
    }
    stopComputerAudio() {
      this.captureEpoch++;
      this.capturePending = false;
      const stream = this.captureStream;
      this.captureStream = null;
      this.captureSource?.disconnect();
      this.captureSource = null;
      stream?.getTracks().forEach(track => track.stop());
      this.syncCaptureUI();
    }
    loadAudio(file) {
      if (!file) return;
      this.stopComputerAudio();
      this.audioError();
      const music = $('music');
      music.pause();
      this.spectrum.reset();
      if (this.audioURL) URL.revokeObjectURL(this.audioURL);
      this.audioURL = URL.createObjectURL(file);
      music.src = this.audioURL;
      $('audio-name').textContent = file.name;
      $('audio-credit').hidden = true;
    }
    bindUI() {
      $('auto-sensitivity').addEventListener('change', (event) =>
        this.applySettings({ autoSensitivity: event.target.checked }));
      $('show-idle-particles').addEventListener('change', (event) =>
        this.applySettings({ showIdleParticles: event.target.checked }));
      $('palette-target').addEventListener('change', (event) => {
        this.paletteTarget = event.target.value;
        this.renderColorStops();
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      for (const b of document.querySelectorAll('[data-metric]'))
        b.addEventListener('click', () => this.setSpin(b.dataset.metric === 'spin'));
      let spinTimeout;
      $('spin').addEventListener('input', (e) => {
        $('spin-value').textContent = Number(e.target.value).toFixed(2);
        clearTimeout(spinTimeout);
        spinTimeout = setTimeout(() => this.setSpin(true, Number(e.target.value)), 180);
      });
      $('color-mode').addEventListener('change', (e) => {
        this.editedPalette.setMode(e.target.value);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('solid-color').addEventListener('input', (e) => {
        this.editedPalette.setSolid(e.target.value);
        this.refreshPalette(true);
      });
      $('palette-saturation').addEventListener('input', (e) => {
        this.editedPalette.setSaturation(Number(e.target.value) / 100);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('palette-offset').addEventListener('input', (e) => {
        this.editedPalette.setOffset(Number(e.target.value) / 100);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('palette-animate').addEventListener('change', (e) => {
        this.editedPalette.setAnimated(e.target.checked);
        this.syncPaletteUI();
      });
      $('palette-speed').addEventListener('input', (e) => {
        this.editedPalette.setSpeed(Number(e.target.value));
        this.syncPaletteUI();
      });
      $('add-color').addEventListener('click', () => {
        this.editedPalette.addStop();
        this.renderColorStops();
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      const controls = {
        material: ['material', 0.01], exposure: ['exposure', 1], sharpness: ['sharpness', 0.01],
        'star-definition': ['starDefinition', 0.01],
        'particle-fade': ['fadeSeconds', 1], speed: ['speed', 1],
        'camera-amount': ['motionStrength', 0.01], 'camera-roll': ['roll', Math.PI / 180],
        framing: ['framing', 0.01], 'framing-y': ['framingY', 0.01],
        'audio-balance': ['balance', 0.01], 'sustained-light': ['sustainStrength', 0.01],
        'star-density': ['starDensity', 0.01], 'cloud-density': ['cloudDensity', 0.01],
        'audio-gain': ['audioGain', 1], 'bass-shake': ['shakeStrength', 0.01],
        'silence-cutoff': ['silenceThreshold', 0.01]
      };
      for (const [id, [key, scale]] of Object.entries(controls))
        $(id).addEventListener('input', (event) => this.applySettings({ [key]: Number(event.target.value) * scale }));
      $('camera-motion').addEventListener('change', (event) =>
        this.applySettings({ cameraMotion: event.target.value }));
      $('star-appearance').addEventListener('change', (event) =>
        this.applySettings({ starAppearance: event.target.value }));
      let cameraTimeout;
      let cameraChanges = {};
      for (const name of ['elevation', 'distance'])
        $(name).addEventListener('input', (event) => {
          cameraChanges[name] = Number(event.target.value);
          $(name + '-value').textContent = event.target.value + (name === 'elevation' ? '°' : '');
          clearTimeout(cameraTimeout);
          cameraTimeout = setTimeout(() => {
            this.applySettings(cameraChanges);
            cameraChanges = {};
          }, 250);
        });
      $('particles').addEventListener('change', (event) =>
        this.applySettings({ count: Number(event.target.value) }));
      $('quality').addEventListener('change', (event) =>
        this.applySettings({ quality: event.target.value }));
      $('fps-limit').addEventListener('change', (event) =>
        this.applySettings({ fpsLimit: Number(event.target.value) }));
      $('pause').addEventListener('click', () => this.togglePause());
      $('reset').addEventListener('click', () => this.reset());
      $('hide-ui').addEventListener('click', () => this.toggleUI());
      $('show-ui').addEventListener('click', () => this.toggleUI());
      $('fullscreen').addEventListener('click', () => this.fullscreen());
      $('quick-fullscreen').addEventListener('click', () => this.fullscreen());
      document.addEventListener('fullscreenchange', () => {
        const label = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
        $('fullscreen').textContent = label;
        $('quick-fullscreen').textContent = label;
      });
      $('audio-file-button').addEventListener('click', () => $('audio-file').click());
      $('computer-audio').addEventListener('click', () => {
        if (this.captureStream) this.stopComputerAudio();
        else this.startComputerAudio();
      });
      window.addEventListener('pagehide', () => this.stopComputerAudio());
      $('audio-file').addEventListener('change', (e) => {
        this.loadAudio(e.target.files[0]);
        e.target.value = '';
      });
      $('music').addEventListener('seeking', () => this.spectrum.reset());
      $('music').addEventListener('error', () => {
        $('audio-name').textContent = 'This audio file could not be decoded. Try MP3, WAV, or Ogg.';
      });
      $('music').addEventListener('play', () => {
        this.stopComputerAudio();
        this.audioError();
        this.initializeAudio().catch((error) =>
          this.controlError('Audio analysis unavailable: ' + error.message)
        );
      });
    }
    readParameters() {
      const q = new URLSearchParams(location.search);
      if (q.get('spin') === '0') this.spinning = false;
      if (['draft', 'balanced', 'high', 'native'].includes(q.get('quality'))) this.quality = q.get('quality');
      if (q.get('motion') === 'fixed') this.cameraMotion = 'fixed';
      if (q.get('ui') === '1') this.toggleUI();
    }
  }
  function showError(error) {
    $('error').hidden = false;
    $('error-text').textContent = error.message;
    $('trace-status').hidden = true;
  }
  setTimeout(() => {
    try {
      window.GravityDemo = new WebDemo();
    } catch (error) {
      console.error(error);
      showError(error);
    }
  }, 30);
})();
