const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
function interruptedTone(){
  const rate=48000,n=rate*18,b=Buffer.alloc(44+n*2);
  b.write('RIFF');b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++){const t=i/rate,level=t<1||t>=14?15000:0;b.writeInt16LE(Math.round(level*Math.sin(2*Math.PI*70*t)),44+2*i);}
  return b;
}
(async()=>{
  const browser=process.env.GRAVITY_CDP?await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    :await chromium.launch({channel:process.env.GRAVITY_CHANNEL||'chrome',headless:true,args:['--enable-webgl','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1920,height:1080}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const results={date:new Date().toISOString(),checks:[]};fs.mkdirSync('test-results',{recursive:true});
  const set=async(id,value)=>page.locator('#'+id).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
  try{
    await page.goto((process.env.GRAVITY_URL||pathToFileURL(path.resolve('gravity-demo.html')).href)+'?motion=fixed&ui=1');
    await page.waitForFunction(()=>window.GravityDemo?.cacheReady||window.GravityDemo?.failed,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>GravityDemo.failed),false);
    assert.deepEqual(await page.evaluate(()=>[GravityDemo.sharpness,GravityDemo.fadeSeconds]),[1,3]);
    await page.evaluate(()=>{
      GravityDemo.paused=true;
      for(const palette of [GravityDemo.palette,GravityDemo.idlePalette]){
        palette.hsv.animated=false;palette.custom.animated=false;
      }
    });
    results.lifecycle=await page.evaluate(()=>{
      const d=GravityDemo,gl=d.gl,P=GravityPhysics,S=GravityShaders,original=d.programs.deposit,originalCount=d.count,originalMaterial=d.material;
      d.count=16;d.allocateParticles();d.material=1;d.spectrum.driven=0;
      d.programs.deposit=d.program(S.depositVertex,S.depositFragment,['vWeight']);
      const tf=gl.createTransformFeedback(),buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,16,gl.DYNAMIC_READ);gl.bindBuffer(gl.ARRAY_BUFFER,null);
      const x=[12,0,.075],m=P.massiveMomentum(x,[0,.28,0],d.a());
      const write=(remaining,birth,death)=>{
        gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);
        gl.bufferSubData(gl.ARRAY_BUFFER,0,new Float32Array([...x,remaining,...m.p,m.pt,birth,death]));gl.bindBuffer(gl.ARRAY_BUFFER,null);
      };
      const state=()=>{const data=new Float32Array(d.particleStride);gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,null);return Array.from(data);};
      const weight=()=>{
        const draw=gl.drawArraysInstanced;gl.drawArraysInstanced=()=>{};try{d.deposit();}finally{gl.drawArraysInstanced=draw;}
        gl.bindVertexArray(d.particleVAOs[d.particleIndex]);gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,tf);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,buffer);
        gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArraysInstanced(gl.POINTS,0,1,4);gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,null);gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null);gl.bindVertexArray(null);
        const data=new Float32Array(4);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,null);return data.reduce((a,b)=>a+b,0);
      };
      write(200,3,-1);const full=weight();write(200,0,-1);const birth=[weight()/full];
      d.updateParticles(0,1.5);birth.push(weight()/full);d.updateParticles(0,1.5);birth.push(weight()/full);
      write(30,3,-1);d.updateParticles(0,0);const death=[weight()/full];
      d.updateParticles(0,1.5);death.push(weight()/full);const middle=state();
      d.speed=24;const beforeSpeed=weight()/full;d.updateParticles(0,1.5);death.push(weight()/full);
      const expired=state();d.updateParticles(0,.01);const recycled=state(),newborn=weight();
      d.updateParticles(0,1.5);const halfReborn=weight();d.updateParticles(0,1.5);const fullReborn=weight();
      d.fadeSeconds=0;write(100,0,-1);const disabled=weight()/full;d.fadeSeconds=3;
      const error=gl.getError();gl.deleteProgram(d.programs.deposit.p);gl.deleteBuffer(buffer);gl.deleteTransformFeedback(tf);
      d.programs.deposit=original;d.count=originalCount;d.material=originalMaterial;d.speed=10;d.allocateParticles();d.updateParticles(0,3);
      return {birth,death,beforeSpeed,middle,expired,recycled,newborn,rebirthRatio:halfReborn/fullReborn,disabled,error};
    });
    const life=results.lifecycle;
    for(const [actual,expected]of[[life.birth,[0,.5,1]],[life.death,[1,.5,0]]])actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<.0001));
    assert.ok(Math.abs(life.beforeSpeed-.5)<.0001&&Math.abs(life.rebirthRatio-.5)<.0001);
    assert.deepEqual(life.middle.slice(0,3),life.expired.slice(0,3),'Timed recycling waits until invisible');
    assert.notDeepEqual(life.expired.slice(0,3),life.recycled.slice(0,3),'Particle relocates after fade');
    assert.equal(life.newborn,0);assert.ok(Math.abs(life.disabled-1)<.0001);assert.equal(life.error,0);
    results.checks.push('GPU three-second fade-in/out, invisible relocation, smooth rebirth, speed-change continuity and disable control');

    assert.equal(await page.evaluate(()=>GravityDemo.idlePalette.solid),'#ffffff');
    assert.ok(await page.evaluate(()=>GravityDemo.paletteColors.every(v=>v===1)));
    await page.locator('#palette-target').selectOption('idle');
    await page.evaluate(()=>{GravityDemo.syncUI();});
    const builds=await page.evaluate(()=>GravityDemo.cacheBuilds);
    const pixels=()=>page.evaluate(()=>{
      const d=GravityDemo,gl=d.gl;d.deposit();d.shade();d.present();const bytes=new Uint8Array(d.canvas.width*d.canvas.height*4);
      gl.readPixels(0,0,d.canvas.width,d.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      const rgb=[0,0,0];let count=0,hash=5381;
      for(let i=0;i<bytes.length;i+=4){for(let j=0;j<3;j++)hash=(Math.imul(hash,33)+bytes[i+j])>>>0;if(Math.max(bytes[i],bytes[i+1],bytes[i+2])>55){count++;for(let j=0;j<3;j++)rgb[j]+=bytes[i+j];}}
      return {hash,rgb:rgb.map(v=>v/Math.max(1,count)),litPixels:count};
    });
    await page.locator('#color-mode').selectOption('solid');await set('solid-color','#00ccff');
    const solid=await pixels();assert.ok(solid.rgb[2]>solid.rgb[0]*4&&solid.rgb[1]>solid.rgb[0]*4&&solid.litPixels>500);
    await page.screenshot({path:'test-results/palette-solid-controls.png'});
    await page.locator('#color-mode').selectOption('hsv');await set('palette-saturation',0);
    const gray=await pixels();assert.ok(Math.max(...gray.rgb)-Math.min(...gray.rgb)<2,'Zero saturation renders neutral particles');
    await set('palette-saturation',100);const initial=await pixels();await set('palette-offset',50);
    assert.notEqual((await pixels()).hash,initial.hash,'HSV offset reaches the rendered image');
    await page.locator('#color-mode').selectOption('custom');assert.equal(await page.locator('#custom-colors input').count(),6);
    for(let i=0;i<4;i++)await page.locator('#custom-colors button').last().click();
    assert.equal(await page.locator('#custom-colors input').count(),2);assert.equal(await page.locator('#custom-colors button').first().isDisabled(),true);
    for(let i=0;i<2;i++)await page.locator('#custom-colors input').nth(i).evaluate(input=>{input.value='#ff2200';input.dispatchEvent(new Event('input',{bubbles:true}));});
    const red=await pixels();assert.ok(red.rgb[0]>red.rgb[1]*3&&red.rgb[0]>red.rgb[2]*3,'Custom stops reach the GPU');
    for(let i=0;i<4;i++)await page.locator('#add-color').click();assert.equal(await page.locator('#add-color').isDisabled(),true);
    const customColors=['#31006f','#8600ff','#ff0077','#ff4400','#ffd000','#ffffff'];
    for(let i=0;i<6;i++)await page.locator('#custom-colors input').nth(i).evaluate((input,color)=>{input.value=color;input.dispatchEvent(new Event('input',{bubbles:true}));},customColors[i]);
    await set('palette-offset',20);await page.locator('#palette-animate').check();await set('palette-speed',1);
    const stopped=await page.evaluate(()=>GravityDemo.idlePalette.custom.offset);await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>GravityDemo.idlePalette.custom.offset),stopped,'Pause freezes palette drift');
    await page.evaluate(()=>{GravityDemo.paused=false;GravityDemo.speed=0;});await page.waitForTimeout(700);
    const moved=await page.evaluate(()=>GravityDemo.idlePalette.custom.offset);assert.ok(moved>stopped);
    await set('palette-speed',-1);await page.waitForTimeout(350);assert.ok(await page.evaluate(v=>GravityDemo.idlePalette.custom.offset<v,moved));
    await page.locator('#palette-animate').uncheck();const held=await page.evaluate(()=>GravityDemo.idlePalette.custom.offset);
    await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>GravityDemo.idlePalette.custom.offset),held);
    await page.screenshot({path:'test-results/palette-custom-controls.png'});
    await page.evaluate(()=>GravityDemo.toggleUI());await page.screenshot({path:'test-results/palette-custom.png'});
    await page.evaluate(()=>GravityDemo.toggleUI());
    await page.locator('#color-mode').selectOption('hsv');assert.equal(await page.evaluate(()=>GravityDemo.idlePalette.hsv.offset),.5);
    await set('palette-offset',0);await set('palette-speed',1);await page.locator('#palette-animate').check();
    await page.waitForTimeout(350);assert.ok(await page.evaluate(()=>GravityDemo.idlePalette.hsv.offset>0));
    await page.locator('#palette-animate').uncheck();await set('palette-offset',0);
    const idleBefore=await page.evaluate(()=>({stops:GravityDemo.idlePalette.custom.stops,offset:GravityDemo.idlePalette.hsv.offset}));
    await page.locator('#palette-target').selectOption('audio');
    await page.locator('#color-mode').selectOption('solid');await set('solid-color','#00ff00');
    assert.deepEqual(await page.evaluate(()=>({stops:GravityDemo.idlePalette.custom.stops,offset:GravityDemo.idlePalette.hsv.offset})),idleBefore);
    await page.locator('#palette-target').selectOption('idle');
    await page.locator('#color-mode').selectOption('solid');await set('solid-color','#ffffff');
    assert.equal(await page.evaluate(()=>GravityDemo.palette.solid),'#00ff00');
    assert.equal(await page.evaluate(()=>GravityDemo.cacheBuilds),builds);
    results.palette={solid,gray,red};results.checks.push('Actual solid/HSV/custom colors, saturation, 2–6 stops, independent offsets, forward/reverse animation, pause/hold and no retracing');

    await page.evaluate(()=>{GravityDemo.paused=true;GravityDemo.cameraTime=0;GravityDemo.orbitAngle=0;});
    const regular=await pixels();
    await page.locator('#audio-file').setInputFiles({name:'tone-silence-tone.wav',mimeType:'audio/wav',buffer:interruptedTone()});
    assert.equal(await page.locator('#music').evaluate(e=>e.paused),true);
    await page.locator('#music').evaluate(e=>e.play());
    await page.waitForFunction(()=>GravityDemo.spectrum.driven>.95&&GravityDemo.audioBass>.5,null,{timeout:15000});
    const activeColors=await page.evaluate(()=>Array.from(GravityDemo.paletteColors));
    assert.ok(activeColors.every((v,i)=>Math.abs(v-(i%3===1?1:0))<.05),'Audio palette reaches the GPU');
    await page.waitForFunction(()=>GravityDemo.spectrum.silenceSeconds>=2.6);
    const waiting=await page.evaluate(()=>GravityDemo.spectrum.driven);assert.ok(waiting>.98);
    await page.waitForFunction(()=>GravityDemo.spectrum.silenceSeconds>=6);
    const midway=await page.evaluate(()=>GravityDemo.spectrum.driven);assert.ok(midway>.44&&midway<.53);
    assert.ok(await page.evaluate(()=>{
      const r=GravityDemo,gl=r.gl;r.deposit();
      const colors=gl.getUniform(r.programs.deposit.p,gl.getUniformLocation(r.programs.deposit.p,'uBandColors[0]'));
      return colors.every((v,i)=>Math.abs(v-(i%3===1?1:1-r.spectrum.driven))<1e-5);
    }),'GPU palette blends through the silence transition');
    await page.waitForFunction(()=>GravityDemo.spectrum.silenceSeconds>=9.1);
    assert.equal(await page.evaluate(()=>GravityDemo.spectrum.driven),0);
    assert.ok(await page.evaluate(()=>GravityDemo.paletteColors.every(v=>v===1)));
    const idle=await pixels();assert.equal(idle.hash,regular.hash,'Silent audio mode must return to the exact regular image');
    await page.waitForFunction(()=>document.getElementById('music').currentTime>=14&&GravityDemo.spectrum.driven>.95,null,{timeout:15000});
    assert.notEqual((await pixels()).hash,regular.hash,'New audible content resumes rendering response');
    results.silence={waiting,midway,idleMatchesRegular:true};results.checks.push('Real tone/silence/tone WAV: 3-second wait, 6-second blend to exact regular image, automatic audio resumption');
    await page.locator('#music').evaluate(e=>e.pause());
    await set('particle-fade',2);assert.equal(await page.evaluate(()=>GravityDemo.fadeSeconds),2);await set('particle-fade',3);
    assert.deepEqual(errors,[]);results.passed=true;
    fs.writeFileSync('test-results/features-browser-results.json',JSON.stringify(results,null,2));console.log('PASS',results.checks,results.silence);
  }finally{
    if(!results.passed)fs.writeFileSync('test-results/features-browser-failure.json',JSON.stringify({...results,errors},null,2));
    await context.close();await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
