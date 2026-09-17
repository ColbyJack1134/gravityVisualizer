const assert=require('node:assert/strict'),A=require('../src/audio.js'),C=require('../src/palette.js');
const colors=p=>Array.from(p.writeColors(A.hues,new Float32Array(A.COUNT*3)));
const close=(a,b,t=1e-6)=>assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);
const p=new C.Palette(),baseline=colors(p);
assert.ok(baseline[2]>baseline[1]&&baseline.at(-3)>baseline.at(-1),'Default violet bass/red highs');
p.setOffset(1);colors(p).forEach((v,i)=>close(v,baseline[i]));
p.setOffset(.5);const shifted=colors(p);assert.ok(shifted[1]>shifted[0]&&shifted[1]>shifted[2],'Half-turn shifts bass into green');
p.setSaturation(0);colors(p).forEach(v=>close(v,1));
p.setMode('solid');p.setSolid('#12abef');const solid=colors(p);
for(let i=3;i<solid.length;i++)close(solid[i],solid[i%3]);
p.setMode('custom');p.custom.stops=['#ff0000','#0000ff'];
let custom=colors(p);close(custom[0],1);close(custom[2],0);close(custom.at(-3),0);close(custom.at(-1),1);
p.setOffset(.5);custom=colors(p);close(custom[0],0);close(custom[2],1);close(custom.at(-3),1);
p.setOffset(0);p.setAnimated(true);p.setSpeed(1);p.advance(30);close(p.custom.offset,.5);
p.advance(30);close(p.custom.offset,0);p.setSpeed(-1);p.advance(15);close(p.custom.offset,.75);
p.advance(30,true);close(p.custom.offset,.75);
p.setAnimated(false);p.advance(30);close(p.custom.offset,.75);
p.setMode('hsv');close(p.hsv.offset,.5);p.setMode('custom');close(p.custom.offset,.75);
for(let i=0;i<10;i++)p.addStop();assert.equal(p.custom.stops.length,6);
for(let i=0;i<10;i++)p.removeStop(0);assert.equal(p.custom.stops.length,2);
for(const step of [1/30,1/60,1/144]){
  const q=new C.Palette();q.setAnimated(true);q.setSpeed(-.5);
  for(let i=0;i<Math.round(12/step);i++)q.advance(step);close(q.hsv.offset,.9,1e-9);
}
p.setOffset(1-1e-6);const left=colors(p);p.setOffset(1e-6);const right=colors(p);
left.forEach((v,i)=>close(v,right[i],.00002));
console.log('PASS: solid/HSV/custom palettes, saturation, cyclic offsets, stop limits, independent settings and timed/reversed/paused drift.');

const idle = new C.Palette(), audio = new C.Palette();
idle.apply({mode:'solid',solid:'#ffffff'});
const idleColors=colors(idle),audioColors=colors(audio),mixed=new Float32Array(A.COUNT*3);
assert.ok(idleColors.every(v=>v===1));
assert.deepEqual(Array.from(C.blend(idleColors,audioColors,0,mixed)),idleColors);
assert.deepEqual(Array.from(C.blend(idleColors,audioColors,1,mixed)),audioColors);
C.blend(idleColors,audioColors,.5,mixed);
mixed.forEach((v,i)=>close(v,(idleColors[i]+audioColors[i])/2));
idle.apply({mode:'custom',custom:{stops:['#ff0000','#0000ff'],offset:.3,speed:-1,animated:true}});
audio.apply({hsv:{offset:.6,speed:1,animated:true}});
idle.advance(6); audio.advance(6);
close(idle.custom.offset,.2); close(audio.hsv.offset,.7);
idle.advance(6,true); audio.advance(6,true);
close(idle.custom.offset,.2); close(audio.hsv.offset,.7);
assert.deepEqual(audio.custom.stops,['#23D183','#1DCA97','#17C2AB','#12BBC0','#0CB3D4','#06ACE8']);
console.log('PASS: independent idle/audio palettes and linear-light crossfade endpoints.');

const weighted = new C.Palette();
weighted.apply({mode:'weighted',weighted:{stops:['#ff0000','#00ff00','#0000ff'],weights:[20,60,20]}});
const sample = (p, n = 10000) => p.writeSamples(A.hues, new Float32Array(n * 3));
const population = samples => {
  const counts = [0,0,0];
  for (let i=0;i<samples.length;i+=3) {
    const channels=Array.from(samples.subarray(i,i+3));
    counts[channels.indexOf(Math.max(...channels))]++;
  }
  return counts;
};
assert.deepEqual(population(sample(weighted)),[2000,6000,2000]);
weighted.setWeight(1,70);
assert.deepEqual(weighted.weighted.weights,[15,70,15]);
assert.deepEqual(population(sample(weighted)),[1500,7000,1500]);
weighted.apply({weighted:{weights:[1,98,1]}});
assert.deepEqual(population(sample(weighted)),[100,9800,100],'Small color shares must survive beyond the 24 audio bands');
weighted.setWeight(0,100);
assert.deepEqual(weighted.weighted.weights,[100,0,0]);
assert.deepEqual(population(sample(weighted)),[10000,0,0]);
weighted.setWeight(0,0);
assert.deepEqual(weighted.weighted.weights,[0,50,50]);
assert.deepEqual(population(sample(weighted)),[0,5000,5000],'Zero-weight colors must not leak into transitions');
weighted.apply({weighted:{weights:[0,0,0]}});
assert.equal(weighted.weighted.weights.reduce((a,b)=>a+b),100);
assert.ok(sample(weighted).every(Number.isFinite));
const validWeights=weighted.weighted.weights.slice();
weighted.apply({weighted:{weights:[-1,Infinity,NaN]}});
assert.deepEqual(weighted.weighted.weights,validWeights);
weighted.setWeight(-1,50);weighted.setWeight(1,NaN);
assert.deepEqual(weighted.weighted.weights,validWeights);
weighted.apply({weighted:{weights:[20,60,20]}});
const stationary=sample(weighted,1000);
weighted.advance(30);
assert.deepEqual(sample(weighted,1000),stationary,'The stellar preset must not cycle colors while idle');
weighted.setAnimated(true);weighted.setSpeed(1);weighted.advance(30);
const rotated=sample(weighted,1000);
for(let i=0;i<1000;i++)for(let c=0;c<3;c++)close(rotated[i*3+c],stationary[((i+500)%1000)*3+c]);
weighted.advance(30,true);close(weighted.weighted.offset,.5);
weighted.setSpeed(-1);weighted.advance(15);close(weighted.weighted.offset,.25);
for(let i=0;i<10;i++)weighted.addStop();
assert.equal(weighted.weighted.stops.length,6);
assert.equal(weighted.weighted.weights.reduce((a,b)=>a+b),100);
for(let i=0;i<10;i++)weighted.removeStop(0);
assert.equal(weighted.weighted.stops.length,2);
assert.equal(weighted.weighted.weights.reduce((a,b)=>a+b),100);
assert.deepEqual(weighted.custom.stops,new C.Palette().custom.stops);
for(const mode of ['solid','hsv','custom']) {
  const q=new C.Palette();q.setMode(mode);q.setOffset(.37);
  const bands=colors(q), samples=sample(q,A.COUNT*64);
  for(let i=0;i<A.COUNT*64;i++)for(let c=0;c<3;c++)
    close(samples[i*3+c],bands[Math.floor(i/64)*3+c]);
}
console.log('PASS: weighted color shares, rare colors, zero weights, normalization, independent stops and cyclic sampling.');
