const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const P = require('../src/physics.js');
const context = vm.createContext({window: {}, GravityPhysics: P, GravityShaders: {},
  GravityAudio: require('../src/audio.js'), GravityPalette: require('../src/palette.js')});
vm.runInContext(fs.readFileSync(require.resolve('../src/app.js'), 'utf8'), context);
const d = new context.window.GravityRenderer({width: 1280, height: 720, getContext: () => ({})});
d.cacheRoll = 0; d.cacheFraming = [0, 0]; d.volumeScale = 1; d.rw = 832; d.rh = 468;
let uniforms;
d.f = d.v2 = d.v3 = (name, value) => { uniforms[name] = value; };
const view = elevation => {
  d.applySettings({elevation}); uniforms = {}; d.cameraUniforms();
  return Object.fromEntries(Object.entries(uniforms).map(([key, value]) => [key, Array.isArray(value) ? Array.from(value) : value]));
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
for (const spinning of [false, true]) {
  d.spinning = spinning;
  for (const phi of [-Math.PI / 2, 0, .7]) {
    d.camera.phi = phi;
    for (const elevation of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
      const u = view(elevation), axes = [u.uForward, u.uRight, u.uUp];
      close(90 - d.camera.theta * 180 / Math.PI, elevation);
      close(P.length(u.uCamera), 40);
      close(P.dot(u.uForward, u.uCamera), -40);
      for (const axis of axes) { assert.ok(axis.every(Number.isFinite)); close(P.length(axis), 1); }
      for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) close(P.dot(axes[i], axes[j]), 0);
      assert.ok(Number.isFinite(u.uObserverEnergy));
    }
    for (const pole of [-90, 90]) {
      const before = view(pole - .001), after = view(pole + .001);
      for (const axis of ['uForward', 'uRight', 'uUp']) assert.ok(distance(before[axis], after[axis]) < .00004, 'Orientation must remain continuous across a pole');
    }
    const start = view(-180), end = view(180);
    for (const key of ['uCamera', 'uForward', 'uRight', 'uUp']) assert.ok(distance(start[key], end[key]) < 1e-12, 'A full orbit must return to the same view');
  }
}
d.camera.phi = -Math.PI / 2;
for (const [angle, position, up] of [[0, [0, -40, 0], [0, 0, 1]], [90, [0, 0, 40], [0, 1, 0]],
  [-90, [0, 0, -40], [0, -1, 0]], [180, [0, 40, 0], [0, 0, -1]]]) {
  const u = view(angle);
  assert.ok(distance(u.uCamera, position) < 1e-12); assert.ok(distance(u.uUp, up) < 1e-12);
}
view(181); close(90 - d.camera.theta * 180 / Math.PI, 180);
view(-181); close(90 - d.camera.theta * 180 / Math.PI, -180);
const theta = d.camera.theta;
for (const elevation of [NaN, Infinity, -Infinity]) { view(elevation); assert.equal(d.camera.theta, theta); }
console.log('PASS: full elevation orbit, finite orthonormal camera axes, continuous poles, inverted views and bounds.');
d.applySettings({continuousTracing: true, floatingCamera: true, cameraMotion: 'gentle', paused: false});
for (const tilt of [0, 30, 89, 90]) for (const rotation of [0, 75, 360]) {
  d.applySettings({orbitTilt: tilt, orbitRotation: rotation, orbitNear: 32, orbitFar: 85});
  const alpha = (rotation - 90) * Math.PI / 180, inclination = tilt * Math.PI / 180;
  const normal = [Math.sin(alpha) * Math.sin(inclination), -Math.cos(alpha) * Math.sin(inclination), Math.cos(inclination)];
  for (let step = 0; step <= 48; step++) {
    d.orbitPhase = step * Math.PI / 24;
    uniforms = {}; d.cameraUniforms();
    const position = uniforms.uCamera;
    close(P.dot(normal, position), 0);
    const secondFocus = [-53 * Math.cos(alpha), -53 * Math.sin(alpha), 0];
    close(P.length(position) + distance(position, secondFocus), 117);
    assert.ok(uniforms.uRight.every(Number.isFinite) && uniforms.uUp.every(Number.isFinite));
  }
  d.orbitPhase = 0; close(d.cameraView().distance, 32);
  d.orbitPhase = Math.PI; close(d.cameraView().distance, 85);
}
d.applySettings({orbitTilt: 30, orbitRotation: 0, orbitNear: 36, orbitFar: 48, orbitSpeed: 2});
d.orbitPhase = .7;
const originalView = {...d.cameraView()};
d.advanceCamera(5);
const phase = d.orbitPhase;
d.applySettings({orbitSpeed: -2}); close(d.orbitPhase, phase);
d.advanceCamera(5);
for (const key of ['theta', 'phi', 'distance']) close(d.cameraView()[key], originalView[key]);
d.applySettings({orbitSpeed: 0});
const stopped = [d.orbitPhase, d.cameraTime]; d.advanceCamera(10);
assert.deepEqual([d.orbitPhase, d.cameraTime], stopped);
d.applySettings({orbitNear: 60}); close(d.orbitFar, 60);
d.applySettings({orbitFar: 40}); close(d.orbitNear, 40);
for (const key of ['orbitTilt', 'orbitRotation', 'orbitNear', 'orbitFar', 'orbitSpeed']) {
  const saved = d[key]; d.applySettings({[key]: NaN}); close(d[key], saved);
}
console.log('PASS: inclined ellipses, distance bounds, polar views, signed speed, reversal without jumps and stopped motion.');
