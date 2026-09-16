(function () {
  'use strict';
  const $ = (id) => document.getElementById(id),
    P = GravityPhysics,
    S = GravityShaders;
  const defaultCamera = { theta: (72 * Math.PI) / 180, phi: -Math.PI / 2, distance: 37 };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  class Demo {
    constructor() {
      this.canvas = $('universe');
      this.spinning = true;
      this.spin = 0.25;
      this.material = 0.3;
      this.exposure = 1.7;
      this.sharpness = 1;
      this.starDensity = 1;
      this.cloudDensity = 1;
      this.speed = 10;
      this.count = 65536;
      this.quality = 'balanced';
      this.fpsLimit = 60;
      this.fadeSeconds = 3;
      this.particleStride = 10;
      this.camera = { ...defaultCamera };
      this.cameraMotion = 'gentle';
      this.cameraTime = 0;
      this.orbitAngle = 0;
      this.motionStrength = 0.55;
      this.roll = (15 * Math.PI) / 180;
      this.framing = 0.03;
      this.framingY = 0.1;
      this.overscan = 1.2;
      this.cacheBuilds = 0;
      this.paused = false;
      this.failed = false;
      this.lost = false;
      this.simTime = 0;
      this.audioEnergy = 0;
      this.audioBass = 0;
      this.audioContext = null;
      this.audioURL = null;
      this.spectrum = new GravityAudio.Spectrum();
      this.audioGain = 1;
      this.sustainStrength = 1;
      this.shakeStrength = 0.7;
      this.palette = new GravityPalette.Palette();
      this.paletteColors = new Float32Array(GravityAudio.COUNT * 3);
      this.paletteRevision = -1;
      this.lastPresentation = 0;
      this.fpsSamples = [];
      this.measuredFPS = 0;
      this.gpuMs = null;
      this.frames = 0;
      this.cacheTextures = [];
      this.cacheFbos = [];
      this.renderTextures = [];
      this.renderFbos = [];
      this.job = null;
      this.cacheReady = false;
      this.gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      });
      if (!this.gl) throw new Error('WebGL2 is unavailable.');
      this.bindUI();
      this.createSpectrumUI();
      this.refreshPalette(true);
      this.renderColorStops();
      this.readParameters();
      this.initializeGL();
      this.syncUI();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
    initializeGL() {
      const gl = this.gl;
      if (!gl.getExtension('EXT_color_buffer_float'))
        throw new Error('This GPU/browser does not expose floating-point WebGL2 render targets.');
      gl.getExtension('EXT_float_blend');
      this.timerExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.pendingQuery = null;
      this.programs = {
        trace: this.program(S.fullscreen, S.volumeTrace),
        finish: this.program(S.fullscreen, S.volumeFinish),
        update: this.program(S.particleUpdate, S.emptyFragment, ['vPosition', 'vMomentum', 'vLifecycle']),
        deposit: this.program(S.depositVertex, S.depositFragment),
        shade: this.program(S.fullscreen, S.volumeShade),
        blur: this.program(S.fullscreen, S.blur),
        composite: this.program(S.fullscreen, S.composite)
      };
      this.fullscreenVAO = gl.createVertexArray();
      this.feedback = gl.createTransformFeedback();
      this.particleBuffers = [];
      this.particleVAOs = [];
      // Restored contexts cannot delete handles belonging to the lost context.
      this.emission = null;
      this.velocity = null;
      this.emissionFBO = null;
      this.cacheTextures = [];
      this.cacheFbos = [];
      this.renderTextures = [];
      this.renderFbos = [];
      this.allocateParticles();
      this.allocateEmission();
      this.resize(true);
      this.rendererName = gl.getParameter(gl.RENDERER);
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (debug) this.rendererName = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    }
    program(vertex, fragment, varyings) {
      const gl = this.gl,
        p = gl.createProgram();
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment]
      ]) {
        const shader = gl.createShader(kind);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          gl.deleteProgram(p);
          throw new Error('Shader compilation failed: ' + log);
        }
        gl.attachShader(p, shader);
        gl.deleteShader(shader);
      }
      if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error('Shader linking failed: ' + gl.getProgramInfoLog(p));
      return { p, uniforms: new Map() };
    }
    use(program) {
      this.current = program;
      this.gl.useProgram(program.p);
    }
    loc(name) {
      const p = this.current;
      if (!p.uniforms.has(name)) p.uniforms.set(name, this.gl.getUniformLocation(p.p, name));
      return p.uniforms.get(name);
    }
    f(name, v) {
      this.gl.uniform1f(this.loc(name), v);
    }
    i(name, v) {
      this.gl.uniform1i(this.loc(name), v);
    }
    v2(name, v) {
      this.gl.uniform2fv(this.loc(name), v);
    }
    v3(name, v) {
      this.gl.uniform3fv(this.loc(name), v);
    }
    bind(name, texture, unit, target) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target || gl.TEXTURE_2D, texture);
      this.i(name, unit);
    }
    texture(width, height, format, linear = false, layers = 0) {
      const gl = this.gl,
        t = gl.createTexture(),
        target = layers ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
      gl.bindTexture(target, t);
      if (layers) gl.texStorage3D(target, 1, format, width, height, layers);
      else gl.texStorage2D(target, 1, format, width, height);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    fbo(textures) {
      const gl = this.gl,
        fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      textures.forEach((t, i) =>
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)
      );
      gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('The requested floating-point framebuffer is unsupported.');
      return fbo;
    }
    quad() {
      this.gl.bindVertexArray(this.fullscreenVAO);
      this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    }
    destroy(textures, fbos) {
      for (const t of textures) this.gl.deleteTexture(t);
      for (const f of fbos) this.gl.deleteFramebuffer(f);
      textures.length = 0;
      fbos.length = 0;
    }
    allocateParticles() {
      const gl = this.gl;
      for (const b of this.particleBuffers) gl.deleteBuffer(b);
      for (const a of this.particleVAOs) gl.deleteVertexArray(a);
      this.particleBuffers = [];
      this.particleVAOs = [];
      this.particleIndex = 0;
      this.simTime = 0;
      const initial = new Float32Array(this.count * this.particleStride),
        stride = this.particleStride * 4;
      for (let i = 0; i < 2; i++) {
        const buffer = gl.createBuffer(),
          vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_COPY);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 32);
        this.particleBuffers.push(buffer);
        this.particleVAOs.push(vao);
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.updateParticles(0);
    }
    allocateEmission() {
      const gl = this.gl;
      if (this.emission) gl.deleteTexture(this.emission);
      if (this.velocity) gl.deleteTexture(this.velocity);
      if (this.emissionFBO) gl.deleteFramebuffer(this.emissionFBO);
      this.volumeGrid = [512, 512, 64];
      this.volumeExtent = [24, 24, 4.8];
      this.emissionWidth = this.volumeGrid[0] * 8;
      this.emissionHeight = this.volumeGrid[1] * (this.volumeGrid[2] / 8);
      this.emission = this.texture(this.emissionWidth, this.emissionHeight, gl.RGBA16F, true);
      this.velocity = this.texture(this.emissionWidth, this.emissionHeight, gl.RGBA16F, true);
      this.emissionFBO = this.fbo([this.emission, this.velocity]);
    }
    resize(force = false) {
      const dpr = Math.min(devicePixelRatio || 1, 1.5),
        width = Math.max(16, Math.round(innerWidth * dpr)),
        height = Math.max(16, Math.round(innerHeight * dpr));
      if (!force && width === this.canvas.width && height === this.canvas.height) return;
      this.canvas.width = width;
      this.canvas.height = height;
      this.prepareCache(true);
    }
    a() {
      return this.spinning ? this.spin : 0;
    }
    cameraUniforms() {
      const { theta, phi, distance } = this.camera;
      const pos = [
        distance * Math.sin(theta) * Math.cos(phi),
        distance * Math.sin(theta) * Math.sin(phi),
        distance * Math.cos(theta)
      ];
      const forward = P.normalize(pos.map((v) => -v)),
        right = P.normalize(cross(forward, [0, 0, 1])),
        up = P.normalize(cross(right, forward));
      this.observerEnergy = 1 / Math.sqrt(1 - P.metric(pos, this.a()).f);
      this.v3('uCamera', pos);
      this.v3('uForward', forward);
      this.v3('uRight', right);
      this.v3('uUp', up);
      this.f('uAspect', this.canvas.width / this.canvas.height);
      this.f('uTanFov', Math.tan((28 * Math.PI) / 180) * this.overscan);
      this.f('uSpin', this.a());
      this.f('uHorizon', P.horizon(this.a()));
      this.f('uISCO', P.isco(this.a()));
      this.f('uObserverEnergy', this.observerEnergy);
    }
    prepareCache(resizeTargets = false) {
      if (this.lost || this.failed) return;
      this.cacheBuilds++;
      const gl = this.gl,
        scale = { draft: 0.4, balanced: 0.65, high: 0.85, native: 1 }[this.quality];
      let rw = Math.round(this.canvas.width * scale),
        rh = Math.round(this.canvas.height * scale);
      const cap = { draft: 260000, balanced: 750000, high: 1100000, native: 1600000 }[this.quality];
      const shrink = Math.min(1, Math.sqrt(cap / (rw * rh)));
      rw = Math.round(rw * shrink);
      rh = Math.round(rh * shrink);
      rw = Math.max(16, rw);
      rh = Math.max(16, rh);
      if (rw !== this.rw || rh !== this.rh || resizeTargets) {
        this.rw = rw;
        this.rh = rh;
        this.allocateRenderTargets();
      }
      this.destroy(this.cacheTextures, this.cacheFbos);
      this.cacheReady = false;
      const cache = (format = gl.RGBA32F, layers = 0) => {
        const t = this.texture(rw, rh, format, false, layers);
        this.cacheTextures.push(t);
        return t;
      };
      this.sky = cache();
      this.slices = 64;
      this.pathX = cache(gl.RGBA16F, this.slices);
      this.pathP = cache(gl.RGBA16F, this.slices);
      this.stateX = [cache(), cache()];
      this.stateP = [cache(), cache()];
      this.stateFbo = [
        this.fbo([this.stateX[0], this.stateP[0]]),
        this.fbo([this.stateX[1], this.stateP[1]])
      ];
      this.finishFbo = this.fbo([this.sky]);
      this.cacheFbos.push(...this.stateFbo, this.finishFbo);
      this.job = { next: 0, total: this.slices + 1 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.lastPresentation = 0;
      this.fpsSamples = [];
      $('resolution').textContent = rw + ' × ' + rh;
      $('trace-status').hidden = false;
      $('trace-text').textContent = 'Preparing the view';
      this.traceProgress(0);
    }
    allocateRenderTargets() {
      const gl = this.gl;
      this.destroy(this.renderTextures, this.renderFbos);
      this.hdr = this.texture(this.rw, this.rh, gl.RGBA16F, true);
      this.hdrFbo = this.fbo([this.hdr]);
      this.bw = Math.max(8, Math.floor(this.rw / 3));
      this.bh = Math.max(8, Math.floor(this.rh / 3));
      this.bloom = [
        this.texture(this.bw, this.bh, gl.RGBA16F, true),
        this.texture(this.bw, this.bh, gl.RGBA16F, true)
      ];
      this.bloomFbo = this.bloom.map((t) => this.fbo([t]));
      this.renderTextures.push(this.hdr, ...this.bloom);
      this.renderFbos.push(this.hdrFbo, ...this.bloomFbo);
      for (const fbo of this.renderFbos) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    traceProgress(progress) {
      $('trace-progress').style.width = Math.round(progress * 100) + '%';
      $('trace-percent').textContent = Math.round(progress * 100) + '%';
    }
    advanceTrace() {
      const gl = this.gl,
        job = this.job;
      if (!job) return;
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, this.rw, this.rh);
      if (job.next < this.slices) {
        const write = job.next % 2,
          read = 1 - write;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFbo[write]);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, this.pathX, 0, job.next);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, this.pathP, 0, job.next);
        gl.drawBuffers([
          gl.COLOR_ATTACHMENT0,
          gl.COLOR_ATTACHMENT1,
          gl.COLOR_ATTACHMENT2,
          gl.COLOR_ATTACHMENT3
        ]);
        this.use(this.programs.trace);
        this.cameraUniforms();
        this.i('uSlice', job.next);
        this.bind('uStateX', this.stateX[read], 0);
        this.bind('uStateP', this.stateP[read], 1);
        this.quad();
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.finishFbo);
        this.use(this.programs.finish);
        this.cameraUniforms();
        const read = (this.slices - 1) % 2;
        this.bind('uStateX', this.stateX[read], 0);
        this.bind('uStateP', this.stateP[read], 1);
        this.quad();
      }
      job.next++;
      this.traceProgress(job.next / job.total);
      if (job.next >= job.total) {
        this.job = null;
        this.cacheReady = true;
        $('trace-status').hidden = true;
        this.fpsSamples = [];
      }
    }
    updateParticles(dt, realDt = dt / Math.max(this.speed, 0.001)) {
      const gl = this.gl;
      this.use(this.programs.update);
      this.f('uSpin', this.a());
      this.f('uHorizon', P.horizon(this.a()));
      this.f('uISCO', P.isco(this.a()));
      this.f('uDt', dt);
      this.f('uSeed', 1 + this.simTime * 0.017);
      this.f('uRealDt', realDt);
      this.f('uFadeSeconds', this.fadeSeconds);
      this.f('uTimeScale', this.speed);
      const next = 1 - this.particleIndex;
      gl.bindVertexArray(this.particleVAOs[this.particleIndex]);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.particleBuffers[next]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);
      this.particleIndex = next;
    }
    deposit() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.emissionFBO);
      gl.viewport(0, 0, this.emissionWidth, this.emissionHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.use(this.programs.deposit);
      this.f('uSpin', this.a());
      this.f('uISCO', P.isco(this.a()));
      this.f('uParticleWeight', (8 * 65536) / this.count);
      this.i('uBandCount', this.spectrum.levels.length);
      this.gl.uniform1fv(this.loc('uBands[0]'), this.spectrum.levels);
      this.f('uSustainStrength', this.sustainStrength);
      this.gl.uniform3fv(this.loc('uBandColors[0]'), this.paletteColors);
      this.f('uFadeSeconds', this.fadeSeconds);
      this.f('uAudioDriven', this.spectrum.driven);
      this.f('uMaterial', this.material);
      this.v3('uVolumeGrid', this.volumeGrid);
      this.v3('uVolumeExtent', this.volumeExtent);
      gl.bindVertexArray(this.particleVAOs[this.particleIndex]);
      gl.drawArraysInstanced(gl.POINTS, 0, this.count, 4);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }
    shade() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFbo);
      gl.viewport(0, 0, this.rw, this.rh);
      this.use(this.programs.shade);
      this.f('uSpin', this.a());
      this.f('uBrightness', 1.1);
      this.f('uStarDensity', this.starDensity);
      this.f('uCloudDensity', this.cloudDensity);
      this.v3('uVolumeGrid', this.volumeGrid);
      this.v3('uVolumeExtent', this.volumeExtent);
      this.f('uOrbitAngle', this.orbitAngle);
      this.f('uObserverEnergy', this.observerEnergy);
      this.bind('uSky', this.sky, 0);
      this.bind('uEmission', this.emission, 1);
      this.bind('uPathX', this.pathX, 2, gl.TEXTURE_2D_ARRAY);
      this.bind('uPathP', this.pathP, 3, gl.TEXTURE_2D_ARRAY);
      this.bind('uVelocity', this.velocity, 4);
      this.i('uSlices', this.slices);
      this.quad();
      this.use(this.programs.blur);
      gl.viewport(0, 0, this.bw, this.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[0]);
      this.bind('uImage', this.hdr, 0);
      this.i('uExtract', 1);
      this.v2('uDirection', [1 / this.rw, 0]);
      this.quad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[1]);
      this.bind('uImage', this.bloom[0], 0);
      this.i('uExtract', 0);
      this.v2('uDirection', [0, 1 / this.bh]);
      this.quad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[0]);
      this.bind('uImage', this.bloom[1], 0);
      this.v2('uDirection', [1 / this.bw, 0]);
      this.quad();
    }
    present() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.use(this.programs.composite);
      this.bind('uImage', this.hdr, 0);
      this.bind('uBloom', this.bloom[0], 1);
      // Transform filtered radiance, not discrete ray-cache coordinates.
      const aspect = this.canvas.width / this.canvas.height;
      const shake = this.spectrum.offset(
        this.paused || this.cameraMotion === 'fixed' ? 0 : this.shakeStrength
      );
      this.f(
        'uRoll',
        (this.roll + 0.035 * Math.sin(this.cameraTime * 0.13)) * Math.min(1, 1.8 / aspect) + shake[2]
      );
      this.f('uViewAspect', aspect);
      this.f('uOverscan', this.overscan);
      this.v2('uFraming', [
        this.framing + 0.028 * Math.sin(this.cameraTime * 0.09) + shake[0],
        this.framingY + 0.012 * Math.sin(this.cameraTime * 0.12) + shake[1]
      ]);
      this.f('uExposure', this.exposure);
      this.f('uGlow', 0.1);
      this.f('uSharpness', this.sharpness);
      this.quad();
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
    refreshPalette(force = false) {
      if (force || this.paletteRevision !== this.palette.revision) {
        this.palette.writeColors(GravityAudio.hues, this.paletteColors);
        this.paletteRevision = this.palette.revision;
      } else return;
      if (force || this.frames % 4 === 0) {
        const colors = this.bandBars.map((bar, i) => {
          const color = GravityPalette.css(Array.from(this.paletteColors.subarray(i * 3, i * 3 + 3)));
          bar.style.background = color;
          return color;
        });
        $('palette-preview').style.background = 'linear-gradient(to right,' + colors.join(',') + ')';
        if (this.palette.gradient) {
          const percent = this.palette.gradient.offset * 100;
          $('palette-offset').value = percent;
          $('palette-offset-value').textContent = percent.toFixed(0) + '%';
        }
      }
    }
    syncPaletteUI() {
      const p = this.palette,
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
      this.palette.custom.stops.forEach((color, index) => {
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
          this.palette.setStop(index, input.value);
          this.refreshPalette(true);
        });
        label.append(input);
        row.append(label);
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.type = 'button';
        remove.disabled = this.palette.custom.stops.length <= 2;
        remove.setAttribute('aria-label', 'Remove gradient color ' + (index + 1));
        remove.addEventListener('click', () => {
          this.palette.removeStop(index);
          this.renderColorStops();
          this.syncPaletteUI();
          this.refreshPalette(true);
        });
        row.append(remove);
        container.append(row);
      });
    }
    updateAudio(dt) {
      let bins = null,
        attacks = null;
      if (this.analyser && !$('music').paused && !$('music').ended) {
        this.analyser.getFloatFrequencyData(this.audioBins);
        this.attackAnalyser.getFloatFrequencyData(this.attackBins);
        bins = this.audioBins;
        attacks = this.attackBins;
      }
      this.spectrum.update(dt, bins, this.audioContext?.sampleRate, 4096, this.audioGain, {
        attacks,
        attackSize: 1024
      });
      this.audioEnergy = this.spectrum.energy;
      this.audioBass = this.spectrum.bass;
      if (this.frames % 4 === 0) {
        const height = $('spectrum-bars').clientHeight;
        this.bandBars.forEach((bar, i) => {
          bar.style.height = Math.max(1, Math.round(height * (0.04 + 0.96 * this.spectrum.levels[i]))) + 'px';
          bar.style.opacity = 0.65 + 0.35 * this.spectrum.attacks[i];
        });
      }
    }
    pollTimer() {
      if (!this.pendingQuery || !this.timerExtension) return;
      const gl = this.gl;
      if (gl.getQueryParameter(this.pendingQuery, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT))
          this.gpuMs = gl.getQueryParameter(this.pendingQuery, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(this.pendingQuery);
        this.pendingQuery = null;
      }
    }
    frame(now) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
      if (this.failed || this.lost) return;
      if (this.fpsLimit && now - this.lastPresentation < 1000 / this.fpsLimit - 0.7) return;
      const frameDelta = this.lastPresentation ? (now - this.lastPresentation) / 1000 : 1 / 60;
      this.lastPresentation = now;
      const dt = Math.min(frameDelta, 0.0667);
      this.frames++;
      try {
        this.pollTimer();
        if (this.job) {
          this.advanceTrace();
          this.present();
          return;
        }
        if (!this.cacheReady) return;
        let timing = false;
        if (this.timerExtension && !this.pendingQuery && this.frames % 30 === 0) {
          this.pendingQuery = this.gl.createQuery();
          this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, this.pendingQuery);
          timing = true;
        }
        this.updateAudio(frameDelta);
        this.palette.advance(dt, this.paused);
        this.refreshPalette();
        if (!this.paused) {
          this.simTime += dt * this.speed;
          this.updateParticles(dt * this.speed, dt);
          if (this.cameraMotion !== 'fixed') {
            const response = this.cameraMotion === 'music' ? 1 + this.audioBass * 1.5 : 1;
            this.cameraTime += dt * response;
            this.orbitAngle =
              (this.orbitAngle + dt * (0.012 + 0.032 * this.motionStrength) * response) % (Math.PI * 2);
          }
        }
        this.deposit();
        this.shade();
        this.present();
        if (timing) this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        this.fpsSamples.push(frameDelta);
        if (this.fpsSamples.length > 45) this.fpsSamples.shift();
        if (this.frames % 10 === 0) {
          this.measuredFPS = this.fpsSamples.length / this.fpsSamples.reduce((a, b) => a + b, 0);
          $('fps').textContent = Math.round(this.measuredFPS);
          $('gpu-time').textContent = this.gpuMs === null ? 'Unavailable' : this.gpuMs.toFixed(1) + ' ms';
        }
      } catch (error) {
        this.fail(error);
      }
    }
    setSpin(on, value = this.spin) {
      this.spinning = on;
      this.spin = Math.max(0.05, Math.min(0.95, value));
      this.allocateParticles();
      this.prepareCache();
      this.syncUI();
    }
    reset() {
      this.camera = { ...defaultCamera };
      this.cameraTime = 0;
      this.orbitAngle = 0;
      this.allocateParticles();
      this.prepareCache();
      this.syncUI();
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
      $('quality').value = this.quality;
      $('particles').value = this.count;
      $('material').value = Math.round(this.material * 100);
      $('material-value').textContent = Math.round(this.material * 100) + '%';
      $('exposure').value = this.exposure;
      $('exposure-value').textContent = this.exposure.toFixed(1) + '×';
      $('sharpness').value = Math.round(this.sharpness * 100);
      $('sharpness-value').textContent = Math.round(this.sharpness * 100) + '%';
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
        ['star-density', this.starDensity],
        ['cloud-density', this.cloudDensity]
      ]) {
        $(id).value = Math.round(value * 100);
        $(id + '-value').textContent = Math.round(value * 100) + '%';
      }
      $('audio-gain').value = this.audioGain;
      $('audio-gain-value').textContent = this.audioGain.toFixed(1) + '×';
      $('bass-shake').value = this.shakeStrength * 100;
      $('bass-shake-value').textContent = Math.round(this.shakeStrength * 100) + '%';
      $('elevation').value = Math.round(90 - (this.camera.theta * 180) / Math.PI);
      $('elevation-value').textContent = $('elevation').value + '°';
      $('distance').value = this.camera.distance;
      $('distance-value').textContent = Math.round(this.camera.distance);
    }
    togglePause() {
      this.paused = !this.paused;
      $('pause').textContent = this.paused ? 'Resume' : 'Pause';
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
        this.analyser.connect(this.audioContext.destination);
        this.attackAnalyser = this.audioContext.createAnalyser();
        this.attackAnalyser.fftSize = 1024;
        this.attackAnalyser.smoothingTimeConstant = 0;
        this.attackBins = new Float32Array(this.attackAnalyser.frequencyBinCount);
        this.mediaSource.connect(this.attackAnalyser);
      }
      await this.audioContext.resume();
    }
    loadAudio(file) {
      if (!file) return;
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
      for (const b of document.querySelectorAll('[data-metric]'))
        b.addEventListener('click', () => this.setSpin(b.dataset.metric === 'spin'));
      let spinTimeout;
      $('spin').addEventListener('input', (e) => {
        $('spin-value').textContent = Number(e.target.value).toFixed(2);
        clearTimeout(spinTimeout);
        spinTimeout = setTimeout(() => this.setSpin(true, Number(e.target.value)), 180);
      });
      $('material').addEventListener('input', (e) => {
        this.material = Number(e.target.value) / 100;
        $('material-value').textContent = e.target.value + '%';
      });
      $('exposure').addEventListener('input', (e) => {
        this.exposure = Number(e.target.value);
        $('exposure-value').textContent = this.exposure.toFixed(1) + '×';
      });
      $('sharpness').addEventListener('input', (e) => {
        this.sharpness = Number(e.target.value) / 100;
        $('sharpness-value').textContent = e.target.value + '%';
      });
      $('particle-fade').addEventListener('input', (e) => {
        this.fadeSeconds = Number(e.target.value);
        $('particle-fade-value').textContent = this.fadeSeconds.toFixed(1) + ' s';
      });
      $('color-mode').addEventListener('change', (e) => {
        this.palette.setMode(e.target.value);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('solid-color').addEventListener('input', (e) => {
        this.palette.setSolid(e.target.value);
        this.refreshPalette(true);
      });
      $('palette-saturation').addEventListener('input', (e) => {
        this.palette.setSaturation(Number(e.target.value) / 100);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('palette-offset').addEventListener('input', (e) => {
        this.palette.setOffset(Number(e.target.value) / 100);
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('palette-animate').addEventListener('change', (e) => {
        this.palette.setAnimated(e.target.checked);
        this.syncPaletteUI();
      });
      $('palette-speed').addEventListener('input', (e) => {
        this.palette.setSpeed(Number(e.target.value));
        this.syncPaletteUI();
      });
      $('add-color').addEventListener('click', () => {
        this.palette.addStop();
        this.renderColorStops();
        this.syncPaletteUI();
        this.refreshPalette(true);
      });
      $('speed').addEventListener('input', (e) => {
        this.speed = Number(e.target.value);
        $('speed-value').textContent = this.speed + '×';
      });
      $('camera-motion').addEventListener('change', (e) => {
        this.cameraMotion = e.target.value;
      });
      $('camera-amount').addEventListener('input', (e) => {
        this.motionStrength = Number(e.target.value) / 100;
      });
      $('camera-roll').addEventListener('input', (e) => {
        this.roll = (Number(e.target.value) * Math.PI) / 180;
        $('roll-value').textContent = e.target.value + '°';
      });
      $('framing').addEventListener('input', (e) => {
        this.framing = Number(e.target.value) / 100;
      });
      $('framing-y').addEventListener('input', (e) => {
        this.framingY = Number(e.target.value) / 100;
      });
      const percentageControls = {
        'audio-balance': (value) => {
          this.spectrum.balance = value;
        },
        'sustained-light': (value) => {
          this.sustainStrength = value;
        },
        'star-density': (value) => {
          this.starDensity = value;
        },
        'cloud-density': (value) => {
          this.cloudDensity = value;
        }
      };
      for (const [id, set] of Object.entries(percentageControls))
        $(id).addEventListener('input', (e) => {
          set(Number(e.target.value) / 100);
          $(id + '-value').textContent = e.target.value + '%';
        });
      $('audio-gain').addEventListener('input', (e) => {
        this.audioGain = Number(e.target.value);
        $('audio-gain-value').textContent = this.audioGain.toFixed(1) + '×';
      });
      $('bass-shake').addEventListener('input', (e) => {
        this.shakeStrength = Number(e.target.value) / 100;
        $('bass-shake-value').textContent = e.target.value + '%';
      });
      let cameraTimeout;
      for (const name of ['elevation', 'distance'])
        $(name).addEventListener('input', (e) => {
          if (name === 'elevation') this.camera.theta = ((90 - Number(e.target.value)) * Math.PI) / 180;
          else this.camera.distance = Number(e.target.value);
          $(name + '-value').textContent = e.target.value + (name === 'elevation' ? '°' : '');
          clearTimeout(cameraTimeout);
          cameraTimeout = setTimeout(() => this.prepareCache(), 250);
        });
      $('particles').addEventListener('change', (e) => {
        this.count = Number(e.target.value);
        this.allocateParticles();
      });
      $('quality').addEventListener('change', (e) => {
        this.quality = e.target.value;
        this.prepareCache();
      });
      $('fps-limit').addEventListener('change', (e) => {
        this.fpsLimit = Number(e.target.value);
        this.fpsSamples = [];
      });
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
      $('audio-file').addEventListener('change', (e) => {
        this.loadAudio(e.target.files[0]);
        e.target.value = '';
      });
      $('music').addEventListener('seeking', () => this.spectrum.reset());
      $('music').addEventListener('error', () => {
        $('audio-name').textContent = 'This audio file could not be decoded. Try MP3, WAV, or Ogg.';
      });
      $('music').addEventListener('play', () => {
        this.initializeAudio().catch((error) =>
          this.controlError('Audio analysis unavailable: ' + error.message)
        );
      });
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => this.resize(), 150);
      });
      document.addEventListener('visibilitychange', () => {
        this.lastPresentation = 0;
        this.fpsSamples = [];
      });
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
        this.job = null;
        $('trace-status').hidden = false;
        $('trace-text').textContent = 'Graphics context suspended';
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        try {
          this.initializeGL();
        } catch (error) {
          this.fail(error);
        }
      });
    }
    readParameters() {
      const q = new URLSearchParams(location.search);
      if (q.get('spin') === '0') this.spinning = false;
      if (['draft', 'balanced', 'high', 'native'].includes(q.get('quality'))) this.quality = q.get('quality');
      if (q.get('motion') === 'fixed') this.cameraMotion = 'fixed';
      if (q.get('ui') === '1') this.toggleUI();
    }
    stats() {
      return {
        ready: this.cacheReady,
        spin: this.a(),
        particles: this.count,
        quality: this.quality,
        width: this.rw,
        height: this.rh,
        fps: this.measuredFPS,
        gpuMs: this.gpuMs,
        renderer: this.rendererName,
        paused: this.paused,
        simTime: this.simTime,
        audioEnergy: this.audioEnergy,
        audioBass: this.audioBass,
        audioBands: Array.from(this.spectrum.levels),
        audioAttacks: Array.from(this.spectrum.attacks),
        bassShake: this.spectrum.shake,
        cameraMotion: this.cameraMotion,
        cameraDistance: this.camera.distance,
        framing: [this.framing, this.framingY],
        overscan: this.overscan,
        starDensity: this.starDensity,
        cloudDensity: this.cloudDensity,
        orbitAngle: this.orbitAngle,
        cacheBuilds: this.cacheBuilds,
        failed: this.failed,
        lost: this.lost,
        traceProgress: this.job ? this.job.next / this.job.total : 1
      };
    }
    diagnostics() {
      const gl = this.gl,
        fb = this.finishFbo;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const data = new Float32Array(this.rw * this.rh * 4);
      gl.readPixels(0, 0, this.rw, this.rh, gl.RGBA, gl.FLOAT, data);
      const result = { captured: 0, escaped: 0, budget: 0, invalid: 0, other: 0 };
      for (let i = 3; i < data.length; i += 4) {
        const v = Math.round(data[i]);
        result[
          v === 1 ? 'captured' : v === 2 ? 'escaped' : v === 3 ? 'budget' : v === 4 ? 'invalid' : 'other'
        ]++;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return result;
    }
    fail(error) {
      this.failed = true;
      console.error(error);
      $('error').hidden = false;
      $('error-text').textContent = error.message;
      $('trace-status').hidden = true;
    }
  }
  setTimeout(() => {
    try {
      window.GravityDemo = new Demo();
    } catch (error) {
      console.error(error);
      $('error').hidden = false;
      $('error-text').textContent = error.message;
      $('trace-status').hidden = true;
    }
  }, 30);
})();
