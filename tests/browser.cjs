const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const P=require('../src/physics.js');
const benchmark=process.argv.includes('--benchmark');
const out=path.resolve('test-results');fs.mkdirSync(out,{recursive:true});
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

// Smaller steps and double precision provide a reference independent of GLSL execution.
function referenceRay(camera,spin,u,v,aspect,overscan=1.2){
  const {theta,phi,distance}=camera;
  let x=[distance*Math.sin(theta)*Math.cos(phi),distance*Math.sin(theta)*Math.sin(phi),distance*Math.cos(theta)];
  const forward=P.normalize(x.map(q=>-q)),right=P.normalize(cross(forward,[0,0,1])),up=P.normalize(cross(right,forward));
  const fov=Math.tan(28*Math.PI/180)*overscan;
  const n=P.normalize(forward.map((q,i)=>q+(2*u-1)*aspect*fov*right[i]+(2*v-1)*fov*up[i]));
  let p=P.photon(x,n,spin);
  for(let i=0;i<20000;i++){
    const r=P.metric(x,spin).r;
    if(r<P.horizon(spin)+.006)return {status:1};
    if(P.dot(p,p)>1e10)throw new Error('Reference ray became unstable outside the horizon');
    if(r>Math.max(75,distance+5))return {status:2,direction:P.normalize(P.flow(x,p,1,spin).x)};
    const flow=P.flow(x,p,1,spin),dr=P.metric(x,spin).dr;
    const spatial=Math.min(.35,Math.max(.004,.035*(r-P.horizon(spin)+.35)))/Math.max(1,P.length(flow.x));
    const radial=.035*(r-P.horizon(spin))/Math.max(Math.abs(P.dot(dr,flow.x)),.001);
    const h=Math.min(spatial,radial);
    ({x,p}=P.step(x,p,1,spin,h));
  }
  throw new Error('Reference ray exhausted its step budget');
}

function tone(){
  const rate=22050,n=rate*8,b=Buffer.alloc(44+n*2);
  b.write('RIFF');b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++)b.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*90*i/rate)),44+2*i);
  return b;
}

(async()=>{
  const browser=process.env.GRAVITY_CDP
    ?await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    :await chromium.launch({channel:process.env.GRAVITY_CHANNEL||'chrome',headless:true,args:['--enable-webgl','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await context.newPage(),errors=[],network=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'||/INVALID_(OPERATION|VALUE|ENUM)/.test(m.text()))errors.push(m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  const ready=async()=>{
    await page.waitForFunction(()=>window.GravityDemo?.cacheReady||window.GravityDemo?.failed,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>GravityDemo.failed),false);
  };
  const results={date:new Date().toISOString(),browser:browser.version(),rows:[],checks:[]};
  try{
    const url=process.env.GRAVITY_URL||pathToFileURL(path.resolve('gravity-demo.html')).href;
    await page.goto(url+'?ui=1&motion=fixed');await ready();
    assert.deepEqual(await page.evaluate(()=>[GravityDemo.spin,GravityDemo.exposure,GravityDemo.speed,GravityDemo.material]),[.25,1.7,10,.3]);
    const sizes=benchmark?[{width:1920,height:1080},{width:3840,height:1080}]:[{width:1920,height:1080}];
    for(const size of sizes){
      await page.setViewportSize(size);await page.waitForTimeout(250);
      for(const spin of [false,true]){
        const start=Date.now();
        await page.evaluate(spin=>GravityDemo.setSpin(spin),spin);await ready();
        const traceMs=Date.now()-start;
        await page.waitForTimeout(benchmark?4000:1000);
        const stats=await page.evaluate(()=>GravityDemo.stats()),rays=await page.evaluate(()=>GravityDemo.diagnostics());
        assert.equal(rays.invalid,0,'Nonfinite ray state');assert.equal(rays.other,0,'Uninitialized ray cache');
        assert.ok(rays.captured>0&&rays.escaped>0);assert.ok(rays.budget/(stats.width*stats.height)<.0001,'Too many unfinished rays');
        if(!spin){
          const r=stats.cameraDistance;
          const sine=3*Math.sqrt(3)*Math.sqrt(1-2/r)/r,tangent=sine/Math.sqrt(1-sine*sine),fov=Math.tan(28*Math.PI/180)*stats.overscan;
          let expected=0;
          for(let y=0;y<stats.height;y++){
            const yy=((y+.5)/stats.height*2-1)*fov,square=tangent*tangent-yy*yy;
            if(square<=0)continue;
            const xx=Math.sqrt(square)/(size.width/size.height*fov);
            expected+=Math.floor(stats.width*(1+xx)/2-.5)-Math.ceil(stats.width*(1-xx)/2-.5)+1;
          }
          assert.ok(Math.abs(rays.captured-expected)<=4,`Analytic shadow: ${rays.captured} versus ${expected} pixels`);
        }
        const samples=await page.evaluate(()=>{
          const d=GravityDemo,gl=d.gl,points=[[.5,.5],[.5,.56],[.56,.5],[.5,.65],[.65,.5],[.18,.27]];
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER,d.finishFbo);gl.readBuffer(gl.COLOR_ATTACHMENT0);
          const samples=points.map(([u,v])=>{const x=Math.floor(u*d.rw),y=Math.floor(v*d.rh),data=new Float32Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.FLOAT,data);return {u:(x+.5)/d.rw,v:(y+.5)/d.rh,data:Array.from(data)};});
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);return {samples,camera:d.camera,aspect:d.canvas.width/d.canvas.height};
        });
        let worstDirectionError=0;
        for(const sample of samples.samples){
          const ref=referenceRay(samples.camera,stats.spin,sample.u,sample.v,samples.aspect,stats.overscan);
          assert.equal(Math.round(sample.data[3]),ref.status,`GPU/reference ray classification at spin ${stats.spin}`);
          if(ref.status===2){const error=P.length(ref.direction.map((v,i)=>v-sample.data[i]));worstDirectionError=Math.max(worstDirectionError,error);assert.ok(error<.003,`GPU/reference direction error ${error}`);}
        }
        const row={viewport:size,traceMs,...stats,rays,worstDirectionError};results.rows.push(row);console.log(JSON.stringify(row));
        if(size.width===1920)await page.screenshot({path:path.join(out,`disk-${spin?'kerr':'schwarzschild'}.png`)});
      }
    }
    results.checks.push('Spinning and non-spinning disk; GPU rays versus smaller-step CPU reference');

    await page.evaluate(()=>{GravityDemo.reset();GravityDemo.paused=true;});await ready();
    const unique=await page.evaluate(()=>{
      const d=GravityDemo,gl=d.gl,data=new Float32Array(d.count*d.particleStride);gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);
      gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,null);
      const unique=new Set();let z2=0;for(let i=0;i<data.length;i+=d.particleStride){unique.add(data[i]+','+data[i+1]+','+data[i+2]);z2+=data[i+2]*data[i+2];}return {unique:unique.size,count:d.count,zRMS:Math.sqrt(z2/d.count)};
    });
    assert.ok(unique.unique>unique.count*.99,`${unique.unique} distinct particles`);assert.ok(unique.zRMS>.4,'The tilted material must have actual height');results.checks.push(`${unique.unique} distinct GPU particles; volume height RMS ${unique.zRMS.toFixed(2)} M`);

    const orbit=await page.evaluate(()=>{
      const d=GravityDemo,P=GravityPhysics,gl=d.gl,originalCount=d.count;d.count=16;d.allocateParticles();const data=new Float32Array(16*d.particleStride);
      for(let i=0;i<16;i++){
        const r=10,rho=Math.sqrt(r*r+d.a()*d.a()),angle=i*2*Math.PI/16,omega=1/(r**1.5+d.a());
        const x=[rho*Math.cos(angle),rho*Math.sin(angle),0],m=P.massiveMomentum(x,[-x[1]*omega,x[0]*omega,0],d.a());
        data.set([...x,10000,...m.p,m.pt,d.fadeSeconds,-1],i*d.particleStride);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);gl.bufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,null);
      for(let i=0;i<1000;i++)d.updateParticles(.1);
      gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,null);
      let radialError=0,massShellError=0;
      for(let i=0;i<16;i++){const offset=i*d.particleStride,x=Array.from(data.slice(offset,offset+3)),p=Array.from(data.slice(offset+4,offset+7));radialError=Math.max(radialError,Math.abs(P.metric(x,d.a()).r-10));massShellError=Math.max(massShellError,Math.abs(P.hamiltonian(x,p,data[offset+7],d.a())+.5));}
      d.count=originalCount;d.allocateParticles();return {radialError,massShellError};
    });
    assert.ok(orbit.radialError<.002&&orbit.massShellError<.00002,JSON.stringify(orbit));results.gpuOrbit=orbit;
    results.checks.push('GPU circular-orbit radial and mass-shell error bounded over 100 time units');

    await page.evaluate(()=>{GravityDemo.paused=false;});await page.locator('#pause').click();
    const time=await page.evaluate(()=>GravityDemo.simTime);await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>GravityDemo.simTime),time);await page.locator('#pause').click();
    await page.waitForFunction(t=>GravityDemo.simTime>t,time);
    await page.locator('#hide-ui').click();assert.equal(await page.locator('.controls').isVisible(),false);
    const controlsState=await page.evaluate(()=>[GravityDemo.cacheBuilds,GravityDemo.paused,GravityDemo.spinning,document.fullscreenElement!==null]);
    await page.locator('#universe').click();
    for(const key of ['h','r','b','f','1','2','3','Space'])await page.keyboard.press(key);
    assert.deepEqual(await page.evaluate(()=>[GravityDemo.cacheBuilds,GravityDemo.paused,GravityDemo.spinning,document.fullscreenElement!==null]),controlsState,'Removed hotkeys must have no effect');
    assert.equal(await page.locator('.controls').isVisible(),false);
    await page.locator('#show-ui').click();assert.equal(await page.locator('.controls').isVisible(),true);
    assert.equal(await page.locator('[data-view], #audio-source, #notes, header, footer').count(),0);
    assert.equal(await page.locator('#music').evaluate(e=>e.paused&&!e.autoplay),true);
    results.checks.push('Single scene, file-only audio, button-operated controls and no legacy hotkeys');
    const builds=await page.evaluate(()=>GravityDemo.cacheBuilds);
    await page.locator('#camera-motion').selectOption('gentle');
    const before=await page.evaluate(()=>GravityDemo.orbitAngle);await page.waitForTimeout(1800);
    assert.ok(await page.evaluate(x=>GravityDemo.orbitAngle>x,before));assert.equal(await page.evaluate(()=>GravityDemo.cacheBuilds),builds);
    const hold=await page.evaluate(()=>{
      const d=GravityDemo,gl=d.gl;d.paused=true;
      const sample=()=>{d.shade();d.present();const pixels=new Uint8Array(128*128*4);gl.readPixels(Math.floor(d.canvas.width*.55),Math.floor(d.canvas.height*.4),128,128,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let hash=5381;for(const byte of pixels)hash=(Math.imul(hash,33)+byte)>>>0;return hash;};
      const before=sample();d.cameraMotion='fixed';const after=sample();d.paused=false;return {before,after};
    });
    assert.equal(hold.after,hold.before,'Holding the camera must not snap the framing');
    await page.locator('#camera-motion').selectOption('fixed');
    const stopped=await page.evaluate(()=>GravityDemo.orbitAngle);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>GravityDemo.orbitAngle),stopped);
    await page.locator('.camera-advanced summary').click();
    await page.locator('#elevation').fill('26');await page.locator('#elevation').dispatchEvent('input');
    await page.waitForFunction(b=>GravityDemo.cacheBuilds>b,builds);await ready();
    assert.ok(Math.abs(await page.evaluate(()=>GravityDemo.camera.theta)-(64*Math.PI/180))<.0001);
    // The escape radius must stay beyond the observer.
    await page.evaluate(()=>{GravityDemo.camera.distance=85;GravityDemo.prepareCache();});await ready();
    assert.ok((await page.evaluate(()=>GravityDemo.diagnostics())).captured>0);results.checks.push('Pause/resume, controls, continuous orbit without retracing, camera hold, elevation and maximum distance');

    await page.locator('#audio-file').setInputFiles({name:'test-tone.wav',mimeType:'audio/wav',buffer:tone()});
    assert.equal(await page.locator('#music').evaluate(e=>e.paused),true,'Choosing music must not autoplay');
    await page.locator('#music').evaluate(e=>e.play());
    await page.waitForFunction(()=>GravityDemo.audioContext?.state==='running'&&GravityDemo.audioBass>.05,null,{timeout:15000});
    results.audio={energy:await page.evaluate(()=>GravityDemo.audioEnergy),bass:await page.evaluate(()=>GravityDemo.audioBass)};
    await page.locator('#music').evaluate(e=>e.pause());await page.waitForFunction(()=>GravityDemo.audioBass<.005);
    assert.equal(await page.locator('#music').evaluate(e=>e.paused),true);results.checks.push('Local WAV decoding, Web Audio analyser response and decay to silence');

    if(benchmark){
      await page.locator('.performance-settings summary').click();
      await page.locator('#particles').selectOption('524288');await page.waitForTimeout(5000);
      results.rows.push({viewport:{width:3840,height:1080},...(await page.evaluate(()=>GravityDemo.stats()))});
      console.log('524k',JSON.stringify(results.rows.at(-1)));
      await page.locator('#particles').selectOption('65536');await page.locator('#fps-limit').selectOption('30');await page.waitForTimeout(3000);
      const fps=await page.evaluate(()=>GravityDemo.measuredFPS);assert.ok(fps<32);results.checks.push(`30 FPS cap (${fps.toFixed(1)} measured)`);
    }
    await page.evaluate(()=>{GravityDemo.contextTestExtension=GravityDemo.gl.getExtension('WEBGL_lose_context');GravityDemo.contextTestExtension.loseContext();});
    await page.waitForFunction(()=>GravityDemo.lost);await page.waitForTimeout(150);
    await page.evaluate(()=>GravityDemo.contextTestExtension.restoreContext());await page.waitForFunction(()=>!GravityDemo.lost);await ready();
    results.checks.push('WebGL context loss and restoration');
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);results.checks.push('No JavaScript/WebGL errors or HTTP requests');
    results.passed=true;
    fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));
    console.log('PASS',results.checks,results.gpuOrbit,results.audio);
  }finally{
    if(!results.passed)fs.writeFileSync(path.join(out,'browser-failure.json'),JSON.stringify({...results,errors},null,2));
    await context.close();await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
