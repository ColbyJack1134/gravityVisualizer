(function () {
  'use strict';
  const P = GravityPhysics, S = GravityShaders;
  const defaultCamera = { theta: (85 * Math.PI) / 180, phi: -Math.PI / 2, distance: 37 };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.spinning = false;
      this.spin = 0.5;
      this.material = 0.3;
      this.cloudRadius = 26.4;
      this.cloudThickness = 0.01;
      this.exposure = 1.7;
      this.sharpness = 1;
      this.starAppearance = 'compact';
      this.starDefinition = 0.7;
      this.brightnessMin = 0.65;
      this.brightnessMax = 1.4;
      this.radialDimming = 0.5;
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
      this.roll = (10 * Math.PI) / 180;
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
      this.spectrum = new GravityAudio.Spectrum();
      this.spectrum.autoSensitivity = true;
      this.audioGain = 1;
      this.sustainStrength = 1;
      this.showIdleParticles = true;
      this.shakeStrength = 0.7;
      this.palette = new GravityPalette.Palette();
      this.idlePalette = new GravityPalette.Palette();
      this.idlePalette.apply({ mode: 'weighted', solid: '#ffffff' });
      this.paletteColors = new Float32Array(GravityAudio.COUNT * 3);
      this.audioColors = new Float32Array(GravityAudio.COUNT * 3);
      this.idleColors = new Float32Array(GravityAudio.COUNT * 3);
      this.paletteSampleCount = GravityAudio.COUNT * 64;
      this.audioSamples = new Float32Array(this.paletteSampleCount * 3);
      this.idleSamples = new Float32Array(this.paletteSampleCount * 3);
      this.paletteSamples = new Float32Array(this.paletteSampleCount * 4);
      this.paletteRevision = -1;
      this.idlePaletteRevision = -1;
      this.paletteMix = -1;
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
      this.suspended = false;
      this.started = false;
      this.lastFrame = null;
      this.frameBudget = 0;
    }
    start() {
      if (this.started) return;
      this.bindLifecycle();
      this.initializeGL();
      this.refreshPalette(true);
      this.started = true;
      if (!this.suspended) this.raf = requestAnimationFrame((t) => this.frame(t));
    }
    resetClock() {
      this.lastPresentation = 0;
      this.lastFrame = null;
      this.frameBudget = 0;
      this.fpsSamples = [];
    }
    setSuspended(value) {
      if (this.suspended === value) return;
      this.suspended = value;
      cancelAnimationFrame(this.raf);
      this.raf = null;
      this.resetClock();
      this.audioInput?.reset?.();
      this.spectrum.reset();
      this.audioEnergy = this.audioBass = 0;
      if (!value && this.started && !this.failed && !this.lost)
        this.raf = requestAnimationFrame((t) => this.frame(t));
    }
    bindLifecycle() {
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => this.resize(), 150);
      });
      document.addEventListener('visibilitychange', () => this.resetClock());
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.lost = true;
        this.job = null;
        this.cacheReady = false;
        cancelAnimationFrame(this.raf);
        this.raf = null;
        this.onTrace?.(0, 'Graphics context suspended');
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        try {
          this.initializeGL();
          this.resetClock();
          if (!this.suspended) this.raf = requestAnimationFrame((t) => this.frame(t));
        } catch (error) {
          this.fail(error);
        }
      });
    }
    applySettings(settings) {
      const oldSpin = this.a(), oldCount = this.count, oldQuality = this.quality;
      const oldTheta = this.camera.theta, oldDistance = this.camera.distance;
      const oldRadius = this.cloudRadius, oldThickness = this.cloudThickness;
      const oldRoll = this.roll, oldFraming = this.framing, oldFramingY = this.framingY;
      const ranges = {
        spin: [0.05, 0.95], material: [0.1, 1], exposure: [0.3, 3], sharpness: [0, 1],
        starDefinition: [0, 1], brightnessMin: [0, 4], brightnessMax: [0, 4], cloudRadius: [11, 33],
        radialDimming: [0, 1],
        cloudThickness: [0, 1],
        starDensity: [0, 5], cloudDensity: [0, 5], speed: [1, 24], fadeSeconds: [0, 6],
        motionStrength: [0, 1], roll: [-Math.PI / 6, Math.PI / 6],
        framing: [-0.35, 0.35], framingY: [-0.2, 0.2], audioGain: [0.3, 3],
        sustainStrength: [0, 1], shakeStrength: [0, 1], fpsLimit: [0, 360]
      };
      for (const [key, [min, max]] of Object.entries(ranges)) {
        if (typeof settings[key] === 'number' && Number.isFinite(settings[key]))
          this[key] = Math.max(min, Math.min(max, settings[key]));
      }
      if (this.brightnessMin > this.brightnessMax) {
        if (Number.isFinite(settings.brightnessMin)) this.brightnessMax = this.brightnessMin;
        else this.brightnessMin = this.brightnessMax;
      }
      for (const key of ['spinning', 'paused', 'showIdleParticles'])
        if (typeof settings[key] === 'boolean') this[key] = settings[key];
      if ([16384, 32768, 65536, 131072, 262144, 524288].includes(settings.count))
        this.count = settings.count;
      if (['draft', 'balanced', 'high', 'native'].includes(settings.quality))
        this.quality = settings.quality;
      if (['gentle', 'music', 'fixed'].includes(settings.cameraMotion))
        this.cameraMotion = settings.cameraMotion;
      if (['compact', 'soft'].includes(settings.starAppearance))
        this.starAppearance = settings.starAppearance;
      if (typeof settings.elevation === 'number' && Number.isFinite(settings.elevation))
        this.camera.theta = ((90 - Math.max(5, Math.min(80, settings.elevation))) * Math.PI) / 180;
      if (typeof settings.distance === 'number' && Number.isFinite(settings.distance))
        this.camera.distance = Math.max(32, Math.min(85, settings.distance));
      if (typeof settings.balance === 'number' && Number.isFinite(settings.balance))
        this.spectrum.balance = Math.max(0, Math.min(1, settings.balance));
      if (typeof settings.autoSensitivity === 'boolean') this.spectrum.autoSensitivity = settings.autoSensitivity;
      if (typeof settings.silenceThreshold === 'number' && Number.isFinite(settings.silenceThreshold))
        this.spectrum.silenceThreshold = Math.max(0, Math.min(0.1, settings.silenceThreshold));
      if (settings.palette || settings.idlePalette) {
        if (settings.palette) this.palette.apply(settings.palette);
        if (settings.idlePalette) this.idlePalette.apply(settings.idlePalette);
        this.refreshPalette(true);
      }
      if (Object.hasOwn(settings, 'fpsLimit')) this.resetClock();
      if (this.started && !this.lost && !this.failed) {
        if (oldRadius !== this.cloudRadius) this.updateVolumeExtent();
        if (oldSpin !== this.a() || oldCount !== this.count || oldRadius !== this.cloudRadius || oldThickness !== this.cloudThickness) {
          this.allocateParticles();
          if (this.paused) this.updateParticles(0, this.fadeSeconds);
        }
        if (oldSpin !== this.a() || oldQuality !== this.quality ||
            oldTheta !== this.camera.theta || oldDistance !== this.camera.distance || oldRadius !== this.cloudRadius ||
            oldRoll !== this.roll || oldFraming !== this.framing || oldFramingY !== this.framingY) this.prepareCache();
      }
      this.onSettings?.();
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
        volumeComposite: this.program(S.fullscreen, S.volumeComposite),
        stars: this.program(S.fullscreen, S.starAppearance),
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
      this.paletteTexture = this.texture(this.paletteSampleCount, 1, gl.RGBA32F);
      this.paletteTextureDirty = true;
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
      this.volumeGrid = [512, 512, 104];
      this.updateVolumeExtent();
      this.emissionWidth = this.volumeGrid[0] * 8;
      this.emissionHeight = this.volumeGrid[1] * (this.volumeGrid[2] / 8);
      this.emission = this.texture(this.emissionWidth, this.emissionHeight, gl.RGBA16F, true);
      this.velocity = this.texture(this.emissionWidth, this.emissionHeight, gl.RGBA16F, true);
      this.emissionFBO = this.fbo([this.emission, this.velocity]);
    }
    updateVolumeExtent() {
      this.volumeScale = Math.max(1, this.cloudRadius / 22);
      this.volumeExtent = this.volumeGrid.map(cells => cells * (24 / 512) * this.volumeScale);
    }
    resize(force = false) {
      const dpr = devicePixelRatio || 1,
        width = Math.max(16, Math.round(innerWidth * dpr)),
        height = Math.max(16, Math.round(innerHeight * dpr));
      if (!force && width === this.canvas.width && height === this.canvas.height) return;
      this.canvas.width = width;
      this.canvas.height = height;
      this.prepareCache(true);
    }
    renderSize() {
      const { width, height } = this.canvas;
      if (this.quality === 'native') {
        // Preserve display density after cropping the camera margin.
        return [Math.ceil(width * this.overscan), Math.ceil(height * this.overscan)];
      }
      const scale = { draft: 0.4, balanced: 0.65, high: 0.85 }[this.quality];
      const cap = { draft: 260000, balanced: 750000, high: 1100000 }[this.quality];
      const density = Math.min(scale, Math.sqrt(cap / (width * height)));
      return [Math.max(16, Math.round(width * density)), Math.max(16, Math.round(height * density))];
    }
    a() {
      return this.spinning ? this.spin : 0;
    }
    cameraUniforms(row = 0) {
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
      this.f('uCacheRoll', this.cacheRoll);
      this.v2('uCacheFraming', this.cacheFraming.map(v => v / this.overscan));
      this.f('uSpin', this.a());
      this.f('uHorizon', P.horizon(this.a()));
      this.f('uISCO', P.isco(this.a()));
      this.f('uVolumeScale', this.volumeScale);
      this.f('uObserverEnergy', this.observerEnergy);
      this.v2('uRaySize', [this.rw, this.rh]);
      this.f('uRayRow', row);
    }
    prepareCache(resizeTargets = false) {
      if (this.lost || this.failed) return;
      this.cacheBuilds++;
      const aspect = this.canvas.width / this.canvas.height;
      this.cacheRoll = this.roll * Math.min(1, 1.8 / aspect);
      this.cacheFraming = [this.framing, this.framingY];
      const angle = .035 * Math.min(1, 1.8 / aspect) + .0025;
      const s = Math.sin(angle), c = 1 - Math.cos(angle);
      const x = Math.abs(this.framing), y = Math.abs(this.framingY);
      // Keep animated corners inside the filtered camera margin.
      const marginX = aspect / 2 + s / 2 + c * x + s * y + .036 + s * .018;
      const marginY = .5 + s * aspect / 2 + s * x + c * y + .018 + s * .036;
      this.overscan = Math.max(1.2, 2 * marginX / aspect / .93, 2 * marginY / .93);
      const gl = this.gl;
      const [rw, rh] = this.renderSize();
      if (rw !== this.rw || rh !== this.rh || resizeTargets) {
        this.rw = rw;
        this.rh = rh;
        this.allocateRenderTargets();
      }
      this.destroy(this.cacheTextures, this.cacheFbos);
      this.cacheReady = false;
      this.slices = 64;
      // Bound allocations and keep derivative quads inside each tile.
      const rows = Math.max(2, 2 * Math.floor(512 * 1024 * 1024 / (rw * this.slices * 8 * 2)));
      this.rayTiles = [];
      for (let row = 0; row < rh; row += rows) {
        const height = Math.min(rows, rh - row);
        const tile = { row, ...this.allocatePathCache(rw, height, this.slices) };
        tile.sky = this.texture(rw, height, gl.RGBA32F);
        tile.tailIndex = this.texture(rw, height, gl.RGBA32F);
        tile.finishFbo = this.fbo([tile.sky, tile.tailIndex]);
        this.cacheTextures.push(tile.sky, tile.tailIndex);
        this.cacheFbos.push(tile.finishFbo);
        this.rayTiles.push(tile);
      }
      this.job = { tile: 0, slice: 0, tail: false, next: 0, total: (this.slices + 2) * this.rayTiles.length };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.lastPresentation = 0;
      this.fpsSamples = [];
      this.onTrace?.(0, 'Loading');
    }
    allocatePathCache(width, height, slices) {
      const gl = this.gl;
      const cache = (layers = 0) => {
        const t = this.texture(width, height, layers ? gl.RGBA16F : gl.RGBA32F, false, layers);
        this.cacheTextures.push(t);
        return t;
      };
      const path = { width, height, slices, pathX: cache(slices), pathP: cache(slices),
        stateX: [cache(), cache()], stateP: [cache(), cache()] };
      path.stateFbo = [this.fbo([path.stateX[0], path.stateP[0]]), this.fbo([path.stateX[1], path.stateP[1]])];
      this.cacheFbos.push(...path.stateFbo);
      return path;
    }
    prepareContinuation(tile) {
      const gl = this.gl, size = tile.width * tile.height * 4;
      const index = new Float32Array(size), selected = [];
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(0, 0, tile.width, tile.height, gl.RGBA, gl.FLOAT, index);
      let slices = 0;
      for (let i = 0; i < size; i += 4) {
        if (index[i] <= 0) continue;
        slices = Math.max(slices, index[i]);
        selected.push(i);
        index[i] = selected.length;
      }
      if (!selected.length) return;
      if (slices > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
        throw new Error('This view requires more ray-path layers than the GPU supports.');
      const states = [new Float32Array(size), new Float32Array(size)];
      gl.bindFramebuffer(gl.FRAMEBUFFER, tile.stateFbo[(this.slices - 1) % 2]);
      for (let i = 0; i < 2; i++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.readPixels(0, 0, tile.width, tile.height, gl.RGBA, gl.FLOAT, states[i]);
      }
      const width = Math.min(512, selected.length), height = Math.ceil(selected.length / width);
      const tail = this.allocatePathCache(width, height, slices);
      tail.count = selected.length;
      tail.sources = this.texture(width, height, gl.RGBA32F);
      tail.image = this.texture(width, height, gl.RGBA32F);
      tail.imageFbo = this.fbo([tail.image]);
      this.cacheTextures.push(tail.sources, tail.image);
      this.cacheFbos.push(tail.imageFbo);
      const sources = new Float32Array(width * height * 4);
      selected.forEach((offset, i) => sources.set([offset / 4 % tile.width,
        Math.floor(offset / 4 / tile.width) + tile.row], i * 4));
      gl.bindTexture(gl.TEXTURE_2D, tail.sources);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, sources);
      // Pack only rays with uncached volume samples.
      for (const [component, texture] of [tail.stateX[1], tail.stateP[1]].entries()) {
        const data = new Float32Array(width * height * 4);
        for (let i = 0; i < width * height; i++) data[i * 4 + 3] = component === 0 ? 1 : 0;
        selected.forEach((offset, i) => data.set(states[component].subarray(offset, offset + 4), i * 4));
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
      }
      gl.bindTexture(gl.TEXTURE_2D, tile.tailIndex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tile.width, tile.height, gl.RGBA, gl.FLOAT, index);
      tile.tail = tail;
    }
    allocateRenderTargets() {
      const gl = this.gl;
      this.destroy(this.renderTextures, this.renderFbos);
      this.hdr = this.texture(this.rw, this.rh, gl.RGBA16F, true);
      this.hdrFbo = this.fbo([this.hdr]);
      this.materialBase = this.texture(this.rw, this.rh, gl.RGBA32F);
      this.materialBaseFbo = this.fbo([this.materialBase]);
      this.starImage = null;
      this.displayImage = this.hdr;
      this.bw = Math.max(8, Math.floor(this.rw / 3));
      this.bh = Math.max(8, Math.floor(this.rh / 3));
      this.bloom = [
        this.texture(this.bw, this.bh, gl.RGBA16F, true),
        this.texture(this.bw, this.bh, gl.RGBA16F, true)
      ];
      this.bloomFbo = this.bloom.map((t) => this.fbo([t]));
      this.renderTextures.push(this.hdr, this.materialBase, ...this.bloom);
      this.renderFbos.push(this.hdrFbo, this.materialBaseFbo, ...this.bloomFbo);
      for (const fbo of this.renderFbos) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    advanceTrace() {
      const gl = this.gl,
        job = this.job;
      if (!job) return;
      const tile = this.rayTiles[job.tile], path = job.tail ? tile.tail : tile;
      const slice = job.slice;
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, path.width, path.height);
      if (slice < path.slices) {
        const write = slice % 2,
          read = 1 - write;
        gl.bindFramebuffer(gl.FRAMEBUFFER, path.stateFbo[write]);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, path.pathX, 0, slice);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, path.pathP, 0, slice);
        gl.drawBuffers([
          gl.COLOR_ATTACHMENT0,
          gl.COLOR_ATTACHMENT1,
          gl.COLOR_ATTACHMENT2,
          gl.COLOR_ATTACHMENT3
        ]);
        this.use(this.programs.trace);
        this.cameraUniforms(tile.row);
        this.i('uSlice', job.tail ? this.slices + slice : slice);
        this.bind('uStateX', path.stateX[read], 0);
        this.bind('uStateP', path.stateP[read], 1);
        this.quad();
        job.slice++;
        if (job.tail && job.slice === path.slices) {
          job.tile++; job.slice = 0; job.tail = false;
        }
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tile.finishFbo);
        this.use(this.programs.finish);
        this.cameraUniforms(tile.row);
        const read = (this.slices - 1) % 2;
        this.bind('uStateX', tile.stateX[read], 0);
        this.bind('uStateP', tile.stateP[read], 1);
        this.quad();
        this.prepareContinuation(tile);
        job.slice = 0;
        if (tile.tail) job.tail = true;
        else job.tile++;
      }
      job.next = job.tile * (this.slices + 2) + (job.tail ? this.slices + 1 + job.slice / tile.tail.slices : job.slice);
      this.onTrace?.(job.next / job.total);
      if (job.tile === this.rayTiles.length) {
        this.job = null;
        this.cacheReady = true;
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
      this.f('uCloudRadius', this.cloudRadius);
      this.f('uCloudThickness', this.cloudThickness);
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
      this.f('uCloudRadius', this.cloudRadius);
      this.v2('uBrightnessRange', [this.brightnessMin, this.brightnessMax]);
      this.f('uRadialDimming', this.radialDimming);
      // Keep particle mass fixed as volume cells grow.
      this.f('uParticleWeight', (12.8 * 65536) / (this.count * this.volumeScale ** 3));
      this.i('uBandCount', this.spectrum.levels.length);
      this.gl.uniform1fv(this.loc('uBands[0]'), this.spectrum.levels);
      this.f('uSustainStrength', this.sustainStrength);
      this.gl.uniform3fv(this.loc('uBandColors[0]'), this.paletteColors);
      this.i('uWeightedPalette', this.palette.mode === 'weighted' || this.idlePalette.mode === 'weighted' ? 1 : 0);
      this.bind('uPalette', this.paletteTexture, 0);
      if (this.paletteTextureDirty) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.paletteSampleCount, 1, gl.RGBA, gl.FLOAT, this.paletteSamples);
        this.paletteTextureDirty = false;
      }
      this.f('uFadeSeconds', this.fadeSeconds);
      this.f('uAudioDriven', this.spectrum.driven);
      this.f('uIdleParticles', this.showIdleParticles ? 1 : 0);
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.materialBaseFbo);
      gl.viewport(0, 0, this.rw, this.rh);
      this.use(this.programs.shade);
      this.f('uSpin', this.a());
      this.f('uBrightness', 1.1);
      this.v3('uVolumeGrid', this.volumeGrid);
      this.v3('uVolumeExtent', this.volumeExtent);
      this.f('uOrbitAngle', this.orbitAngle);
      this.f('uObserverEnergy', this.observerEnergy);
      this.bind('uEmission', this.emission, 1);
      this.bind('uVelocity', this.velocity, 4);
      this.bind('uBase', this.hdr, 0);
      this.bind('uSources', this.paletteTexture, 5);
      this.i('uContinuation', 0);
      this.i('uSlices', this.slices);
      gl.enable(gl.SCISSOR_TEST);
      for (const tile of this.rayTiles) {
        gl.scissor(0, tile.row, this.rw, tile.height);
        this.f('uCacheRow', tile.row);
        this.bind('uPathX', tile.pathX, 2, gl.TEXTURE_2D_ARRAY);
        this.bind('uPathP', tile.pathP, 3, gl.TEXTURE_2D_ARRAY);
        this.quad();
      }
      gl.disable(gl.SCISSOR_TEST);
      this.i('uContinuation', 1);
      this.f('uCacheRow', 0);
      this.bind('uBase', this.materialBase, 0);
      for (const {tail} of this.rayTiles) {
        if (!tail) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, tail.imageFbo);
        gl.viewport(0, 0, tail.width, tail.height);
        this.i('uSlices', tail.slices);
        this.bind('uSources', tail.sources, 5);
        this.bind('uPathX', tail.pathX, 2, gl.TEXTURE_2D_ARRAY);
        this.bind('uPathP', tail.pathP, 3, gl.TEXTURE_2D_ARRAY);
        this.quad();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFbo);
      gl.viewport(0, 0, this.rw, this.rh);
      this.use(this.programs.volumeComposite);
      this.f('uStarDensity', this.starDensity);
      this.f('uCloudDensity', this.cloudDensity);
      this.f('uOrbitAngle', this.orbitAngle);
      this.bind('uBase', this.materialBase, 0);
      gl.enable(gl.SCISSOR_TEST);
      for (const tile of this.rayTiles) {
        gl.scissor(0, tile.row, this.rw, tile.height);
        this.f('uCacheRow', tile.row);
        this.i('uContinuation', tile.tail ? 1 : 0);
        this.bind('uSky', tile.sky, 1);
        this.bind('uTailIndex', tile.tailIndex, 2);
        this.bind('uContinuationImage', tile.tail?.image || this.materialBase, 3);
        this.quad();
      }
      gl.disable(gl.SCISSOR_TEST);
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
    styleStars() {
      const gl = this.gl;
      this.displayImage = this.hdr;
      if (this.starAppearance === 'soft' || this.starDefinition === 0) return;
      if (!this.starImage) {
        this.starImage = this.texture(this.rw, this.rh, gl.RGBA16F, true);
        this.starFbo = this.fbo([this.starImage]);
        this.renderTextures.push(this.starImage);
        this.renderFbos.push(this.starFbo);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.starFbo);
      gl.viewport(0, 0, this.rw, this.rh);
      this.use(this.programs.stars);
      this.bind('uImage', this.hdr, 0);
      this.f('uDefinition', this.starDefinition);
      this.v2('uCoreRadius', [3 * this.canvas.height / this.canvas.width / 1080 / this.overscan,
        3 / 1080 / this.overscan]);
      this.quad();
      this.displayImage = this.starImage;
    }
    present() {
      const gl = this.gl;
      this.styleStars();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.use(this.programs.composite);
      this.bind('uImage', this.displayImage, 0);
      this.bind('uBloom', this.bloom[0], 1);
      // Transform filtered radiance, not discrete ray-cache coordinates.
      const aspect = this.canvas.width / this.canvas.height;
      const shake = this.spectrum.offset(
        this.paused || this.cameraMotion === 'fixed' ? 0 : this.shakeStrength
      );
      this.f(
        'uRoll',
        (this.roll + 0.035 * Math.sin(this.cameraTime * 0.13)) * Math.min(1, 1.8 / aspect) + shake[2] - this.cacheRoll
      );
      this.f('uViewAspect', aspect);
      this.f('uOverscan', this.overscan);
      this.v2('uCacheFraming', this.cacheFraming);
      this.v2('uFraming', [
        this.framing + 0.028 * Math.sin(this.cameraTime * 0.09) + shake[0],
        this.framingY + 0.012 * Math.sin(this.cameraTime * 0.12) + shake[1]
      ]);
      this.f('uExposure', this.exposure);
      this.f('uGlow', 0.1);
      this.f('uSharpness', this.sharpness);
      this.quad();
    }
    refreshPalette(force = false) {
      const audioChanged = this.paletteRevision !== this.palette.revision;
      const idleChanged = this.idlePaletteRevision !== this.idlePalette.revision;
      if (force || audioChanged) {
        this.palette.writeColors(GravityAudio.hues, this.audioColors);
        this.palette.writeSamples(GravityAudio.hues, this.audioSamples);
        this.paletteRevision = this.palette.revision;
      }
      if (force || idleChanged) {
        this.idlePalette.writeColors(GravityAudio.hues, this.idleColors);
        this.idlePalette.writeSamples(GravityAudio.hues, this.idleSamples);
        this.idlePaletteRevision = this.idlePalette.revision;
      }
      if (!force && !audioChanged && !idleChanged && this.paletteMix === this.spectrum.driven) return;
      this.paletteMix = this.spectrum.driven;
      GravityPalette.blend(this.idleColors, this.audioColors, this.paletteMix, this.paletteColors);
      for (let i = 0; i < this.paletteSampleCount; i++) {
        for (let c = 0; c < 3; c++) {
          const index = i * 3 + c;
          this.paletteSamples[i * 4 + c] = this.idleSamples[index] +
            (this.audioSamples[index] - this.idleSamples[index]) * this.paletteMix;
        }
        this.paletteSamples[i * 4 + 3] = 1;
      }
      this.paletteTextureDirty = true;
      this.onPalette?.(force);
    }
    updateAudio(dt) {
      if (this.audioInput) this.audioInput.update(this.spectrum, dt, this.audioGain);
      else this.spectrum.update(dt, null);
      this.audioEnergy = this.spectrum.energy;
      this.audioBass = this.spectrum.bass;
      this.onAudio?.();
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
      this.raf = null;
      if (this.failed || this.lost || this.suspended) return;
      this.raf = requestAnimationFrame((t) => this.frame(t));
      const interval = this.fpsLimit > 0 ? 1000 / this.fpsLimit : 0;
      this.frameBudget += this.lastFrame === null ? interval : now - this.lastFrame;
      this.lastFrame = now;
      if (interval && this.frameBudget < interval - 0.1) return;
      this.frameBudget = interval ? Math.max(0, this.frameBudget - interval) % interval : 0;
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
        this.idlePalette.advance(dt, this.paused);
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
          this.onStats?.();
        }
      } catch (error) {
        this.fail(error);
      }
    }
    setSpin(on, value = this.spin) {
      this.applySettings({ spinning: on, spin: value });
    }
    reset() {
      this.camera = { ...defaultCamera };
      this.cameraTime = 0;
      this.orbitAngle = 0;
      this.allocateParticles();
      this.prepareCache();
      this.onSettings?.();
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
        autoSensitivity: this.spectrum.autoSensitivity,
        audioGain: this.spectrum.effectiveGain,
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
      const gl = this.gl;
      const result = { captured: 0, escaped: 0, budget: 0, invalid: 0, other: 0 };
      for (const tile of this.rayTiles) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tile.finishFbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        const data = new Float32Array(this.rw * tile.height * 4);
        gl.readPixels(0, 0, this.rw, tile.height, gl.RGBA, gl.FLOAT, data);
        for (let i = 3; i < data.length; i += 4) {
          const v = Math.round(data[i]);
          result[
            v === 1 ? 'captured' : v === 2 ? 'escaped' : v === 3 ? 'budget' : v === 4 ? 'invalid' : 'other'
          ]++;
        }
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return result;
    }
    fail(error) {
      this.failed = true;
      cancelAnimationFrame(this.raf);
      this.raf = null;
      console.error(error);
      this.onError?.(error);
    }
  }
  window.GravityRenderer = Renderer;
})();
