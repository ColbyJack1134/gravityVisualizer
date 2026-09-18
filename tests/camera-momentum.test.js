const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({window: {}, document: {}, setTimeout() {},
  GravityPhysics: require('../src/physics.js'), GravityShaders: {},
  GravityAudio: require('../src/audio.js'), GravityPalette: require('../src/palette.js')});
vm.runInContext(fs.readFileSync(require.resolve('../src/app.js'), 'utf8'), context);
context.GravityRenderer = context.window.GravityRenderer;
vm.runInContext(fs.readFileSync(require.resolve('../src/web.js'), 'utf8')
  .replace('  setTimeout(() => {', '  window.WebDemo = WebDemo;\n  setTimeout(() => {'), context);
const handlers = new Map();
let captured = false;
const canvas = {
  getContext: () => ({}),
  addEventListener(type, handler) { handlers.set(type, handler); },
  setPointerCapture() { captured = true; },
  hasPointerCapture() { return captured; },
  releasePointerCapture() { captured = false; handlers.get('lostpointercapture')(); }
};
const d = new context.GravityRenderer(canvas);
Object.setPrototypeOf(d, context.window.WebDemo.prototype);
d.syncViewUI = d.allocateParticles = d.prepareCache = () => {};
d.applySettings({continuousTracing: true, cameraMotion: 'fixed'});
d.bindCameraInput();
const pointer = (type, timeStamp, clientX = 0, clientY = 0) =>
  handlers.get(type)({type, timeStamp, clientX, clientY, button: 0, pointerId: 1});
const fling = (release = 'pointerup', delay = 0) => {
  pointer('pointerdown', 0);
  pointer('pointermove', 20, 10, 5);
  pointer(release, 20 + delay, 10, 5);
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
fling();
const released = {...d.camera};
assert.ok(d.cameraMomentum.x < 0 && d.cameraMomentum.y < 0);
d.advanceCamera(.05);
assert.ok(d.camera.phi < released.phi && d.camera.theta < released.theta);
const firstStep = released.phi - d.camera.phi;
const next = d.camera.phi;
d.advanceCamera(.05);
assert.ok(next - d.camera.phi < firstStep);
for (let i = 0; i < 180; i++) d.advanceCamera(1 / 60);
assert.equal(d.cameraMomentum, null);
const stopped = d.camera.phi;
d.advanceCamera(1);
assert.equal(d.camera.phi, stopped);
const travel = fps => {
  d.reset(); fling();
  const start = d.camera.phi;
  for (let i = 0; i < fps; i++) d.advanceCamera(1 / fps);
  return d.camera.phi - start;
};
close(travel(30), travel(144));
fling('pointerup', 150);
assert.equal(d.cameraMomentum, null);
fling('pointercancel');
assert.equal(d.cameraMomentum, null);
fling(); pointer('pointerdown', 30);
assert.equal(d.cameraMomentum, null);
pointer('lostpointercapture', 40);
assert.equal(d.cameraMomentum, null);
fling(); d.reset();
assert.equal(d.cameraMomentum, null);
fling(); d.resetClock();
assert.equal(d.cameraMomentum, null);
for (const settings of [{paused: true}, {cameraMotion: 'gentle'}, {floatingCamera: true},
  {continuousTracing: false}, {elevation: 20}, {distance: 50}]) {
  d.applySettings({paused: false, cameraMotion: 'fixed', floatingCamera: false, continuousTracing: true});
  fling(); d.applySettings(settings);
  assert.equal(d.cameraMomentum, null);
}
d.applySettings({continuousTracing: true, floatingCamera: true, cameraMotion: 'gentle'});
d.orbitPhase = 1;
fling();
close(d.cameraMomentum.x, -3.75);
close(d.cameraMomentum.y, -.875);
for (const direction of [-1, 1]) {
  const boundary = direction === 1 ? -Math.PI / 2 : 3 * Math.PI / 2;
  d.camera.theta = boundary;
  pointer('pointerdown', 0);
  pointer('pointermove', 20, 0, direction * 10);
  pointer('pointerup', 20, 0, direction * 10);
  const expected = boundary - direction * .035;
  close(Math.sin(d.camera.theta), Math.sin(expected));
  close(Math.cos(d.camera.theta), Math.cos(expected));
  close(d.cameraMomentum.y, -direction * 1.75);
  d.camera.theta = boundary;
  d.advanceCamera(.05);
  const coasted = boundary - direction * 1.75 * (1 - Math.exp(-.2)) / 4;
  close(Math.sin(d.camera.theta), Math.sin(coasted));
  close(Math.cos(d.camera.theta), Math.cos(coasted));
  assert.ok(d.camera.theta >= -Math.PI / 2 && d.camera.theta < 3 * Math.PI / 2);
  close(d.cameraMomentum.y, -direction * 1.75 * Math.exp(-.2));
}
d.applySettings({continuousTracing: false});
const inactive = {...d.camera};
fling(); d.advanceCamera(.1);
assert.deepEqual({...d.camera}, inactive);
console.log('PASS: drag sensitivity, momentum, decay, frame-rate independence, release timing, cancellation, camera modes and elevation wrapping.');
