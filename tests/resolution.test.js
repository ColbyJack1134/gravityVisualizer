const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {}, GravityPhysics: {}, GravityShaders: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8'), context);
const renderer = Object.create(context.window.GravityRenderer.prototype);
renderer.canvas = { width: 0, height: 0 };
renderer.overscan = 1.2;
const rebuilds = [];
renderer.prepareCache = (force) => rebuilds.push(force);

function viewport(width, height, dpr = 1) {
  Object.assign(context, { innerWidth: width, innerHeight: height, devicePixelRatio: dpr });
  renderer.resize();
}
function size(quality) {
  renderer.quality = quality;
  return Array.from(renderer.renderSize());
}

viewport(1920, 1080);
assert.deepEqual(renderer.canvas, { width: 1920, height: 1080 });
assert.deepEqual(size('native'), [2304, 1296], 'Native includes the camera margin at display density');
assert.deepEqual(size('balanced'), [1155, 650], 'Balanced retains its existing 1080p budget');

viewport(1920, 1080, 2);
assert.deepEqual(renderer.canvas, { width: 3840, height: 2160 }, 'Retina output must not stop at DPR 1.5');
assert.deepEqual(size('native'), [4608, 2592], 'Native must not inherit the old 1.6-million-pixel cap');

viewport(3840, 1080);
assert.deepEqual(size('native'), [4608, 1296], 'Spanning displays retain full vertical detail');

for (const [width, height] of [[1920, 1080], [3840, 2160], [3440, 1440], [1080, 1920], [3839, 1079], [375, 812]]) {
  viewport(width, height);
  for (const quality of ['draft', 'balanced', 'high', 'native']) {
    const [rw, rh] = size(quality);
    assert.ok(Number.isInteger(rw) && Number.isInteger(rh));
    assert.ok(Math.abs(rw * height - rh * width) <= width + height,
      `${quality} preserves ${width}:${height} to within whole-pixel rounding`);
    if (quality === 'native') {
      assert.ok(rw / renderer.overscan >= width && rh / renderer.overscan >= height,
        'The visible native image must never be enlarged from fewer samples');
    } else {
      const cap = { draft: 260000, balanced: 750000, high: 1100000 }[quality];
      assert.ok(rw * rh <= cap + rw + rh, `${quality} keeps its performance budget`);
    }
  }
}

const previous = rebuilds.length;
renderer.resize();
assert.equal(rebuilds.length, previous, 'An unchanged viewport does not rebuild the cache');
renderer.resize(true);
assert.equal(rebuilds.length, previous + 1, 'Context recovery can force a rebuild');
assert.ok(rebuilds.every(Boolean), 'Resizing also reallocates presentation targets');
console.log('PASS: native display density, camera margin, uncapped high-DPI output, aspect ratios and resize reuse.');
