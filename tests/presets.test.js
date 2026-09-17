const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const legacy = require('../presets/legacy.json');

function load(directory, native) {
  const canvas = { getContext: () => ({}) };
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    document: { getElementById: () => canvas }, cancelAnimationFrame() {} });
  context.window = context;
  const page = fs.readFileSync(directory + '/index.html', 'utf8');
  const project = JSON.parse(fs.readFileSync(directory + '/project.json', 'utf8'));
  for (const [, script] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script, context);
    if (context.GravityRenderer) context.GravityRenderer.prototype.start = function () {};
    if (context.wallpaperPropertyListener && !context.GravityRenderer && native)
      context.wallpaperPropertyListener.applyUserProperties(project.general.properties);
  }
  return { host: context.GravityWallpaper, project };
}
function equal(actual, expected, key) {
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) < 1e-8, key);
  else if (typeof expected === 'string') assert.equal(actual.toLowerCase(), expected.toLowerCase(), key);
  else if (expected && typeof expected === 'object')
    for (const field of Object.keys(expected)) equal(actual[field], expected[field], key + '.' + field);
  else assert.equal(actual, expected, key);
}
for (const native of [false, true]) {
  const { host, project } = load('dist/wallpaper-engine-legacy', native), d = host.renderer;
  assert.equal(d.failed, false);
  for (const [key, expected] of Object.entries(legacy.settings)) {
    let actual = d[key];
    if (key === 'elevation') actual = 90 - d.camera.theta * 180 / Math.PI;
    if (key === 'distance') actual = d.camera.distance;
    if (['balance', 'autoSensitivity', 'silenceThreshold'].includes(key)) actual = d.spectrum[key];
    if (key !== 'fpsLimit') equal(actual, expected, key);
  }
  assert.equal(project.title, 'Gravity Legacy [Audio Visualizer]');
  host.applyUserProperties({ material: { value: 80 }, stardetail: { value: 'fine' }, idlecolormode: { value: 'solid' } });
  host.flush();
  assert.equal(d.material, .8); assert.equal(d.starDetail, 'fine'); assert.equal(d.idlePalette.mode, 'solid');
}
const { host, project } = load('dist/wallpaper-engine', true);
assert.equal(project.title, 'Gravity [Audio Visualizer]');
assert.equal(host.renderer.starDetail, 'fine'); assert.equal(host.renderer.coreSizing, 'adaptive');
console.log('PASS: standalone and native Legacy defaults match the saved preset; user properties take precedence.');
