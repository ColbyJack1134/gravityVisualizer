const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const out=path.resolve('test-results');fs.mkdirSync(out,{recursive:true});
function wav(hz,pulsed=false){
  const rate=48000,n=rate*6,b=Buffer.alloc(44+n*2);
  b.write('RIFF');b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++){
    const t=i/rate,phase=t%.6,envelope=pulsed?Math.min(1,phase/.004)*Math.exp(-phase*10):Math.min(1,t/.01);
    b.writeInt16LE(Math.round(17000*envelope*Math.sin(2*Math.PI*hz*t)),44+2*i);
  }
  return b;
}
(async()=>{
  const browser=process.env.GRAVITY_CDP?await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    :await chromium.launch({channel:process.env.GRAVITY_CHANNEL||'chrome',headless:true,args:['--enable-webgl','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1920,height:1080}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const results={date:new Date().toISOString(),tones:[],checks:[]};
  try{
    const url=process.env.GRAVITY_URL||pathToFileURL(path.resolve('gravity-demo.html')).href;
    await page.goto(url+'?motion=fixed&ui=1');
    await page.waitForFunction(()=>window.GravityDemo?.cacheReady||window.GravityDemo?.failed,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>GravityDemo.failed),false);
    await page.evaluate(()=>{GravityDemo.updateParticles(0,GravityDemo.fadeSeconds);GravityDemo.paused=true;GravityDemo.cameraTime=0;GravityDemo.orbitAngle=0;});
    assert.deepEqual(await page.evaluate(()=>[GravityDemo.framing,GravityDemo.framingY]),[.03,.1]);
    const builds=await page.evaluate(()=>GravityDemo.cacheBuilds);
    assert.equal(await page.locator('#music').isVisible(),true);
    assert.equal(await page.locator('#music').evaluate(e=>e.paused&&!e.autoplay&&e.currentTime===0),true,'Demo track starts paused');
    assert.equal(await page.locator('#audio-name').textContent(),'Cipher');
    assert.equal(await page.locator('#audio-credit').isVisible(),true);
    assert.equal(await page.evaluate(()=>GravityDemo.audioContext),null,'Audio context waits for playback');
    await page.waitForFunction(()=>Number.isFinite(document.getElementById('music').duration));
    await page.locator('#music').evaluate(e=>e.play());
    await page.waitForFunction(()=>GravityDemo.audioContext?.state==='running'&&GravityDemo.spectrum.driven>.5&&GravityDemo.audioEnergy>.01,null,{timeout:15000});
    await page.locator('#music').evaluate(e=>e.pause());
    results.checks.push('Bundled Cipher starts paused, decodes, and drives the analyzer on playback');
    const load=async(hz,pulsed=false)=>{
      await page.locator('#audio-file').setInputFiles({name:`${hz}${pulsed?'-pulses':''}.wav`,mimeType:'audio/wav',buffer:wav(hz,pulsed)});
      assert.equal(await page.locator('#music').evaluate(e=>e.paused),true,'Local files start paused');
      assert.equal(await page.locator('#audio-credit').isVisible(),false,'Local music replaces the demo credit');
      await page.locator('#music').evaluate(e=>e.play());
      await page.waitForFunction(()=>GravityDemo.audioContext?.state==='running'&&!document.getElementById('music').paused);
    };
    for(const hz of [70,1200,6500]){
      await load(hz);
      await page.waitForFunction(()=>GravityDemo.spectrum.driven>.995&&Math.max(...GravityDemo.spectrum.attacks)<.01);
      const sample=await page.evaluate(()=>{
        const d=GravityDemo,A=GravityAudio,gl=d.gl;
        d.deposit();d.shade();d.present();
        const pixels=new Uint8Array(d.canvas.width*d.canvas.height*4);
        gl.readPixels(0,0,d.canvas.width,d.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const rgb=[0,0,0];let count=0,saturation=0;
        for(let i=0;i<pixels.length;i+=4){
          const max=Math.max(pixels[i],pixels[i+1],pixels[i+2]),min=Math.min(pixels[i],pixels[i+1],pixels[i+2]);
          if(max<55)continue;
          for(let c=0;c<3;c++)rgb[c]+=pixels[i+c];count++;saturation+=(max-min)/max;
        }
        const levels=Array.from(d.spectrum.levels),peak=levels.indexOf(Math.max(...levels));
        return {frequency:A.centers[peak],hue:A.hues[peak],levels,bass:d.audioBass,shake:d.spectrum.shake,driven:d.spectrum.driven,
          rgb:rgb.map(v=>v/Math.max(1,count)),saturation:saturation/Math.max(1,count),litPixels:count};
      });
      results.tones.push({hz,...sample});
      assert.ok(Math.abs(Math.log(sample.frequency/hz))<.3,`FFT peak for ${hz} Hz`);
      assert.ok(sample.litPixels>500,'An active band must visibly light the particles');
      assert.ok(sample.saturation>.75,'Active particles must retain strong saturation');
      if(hz===70){assert.ok(sample.rgb[2]>sample.rgb[0]*1.3&&sample.rgb[2]>sample.rgb[1]*2,'Bass should render violet');assert.ok(sample.bass>.65);}
      if(hz===6500){assert.ok(sample.rgb[0]>sample.rgb[2]*2&&sample.rgb[0]>sample.rgb[1]*2,'Highs should render red');assert.ok(sample.shake<.001&&sample.bass<.001,'High frequencies must not shake the camera');}
      await page.evaluate(()=>GravityDemo.toggleUI());
      await page.screenshot({path:path.join(out,`spectrum-${hz}.png`)});
      await page.evaluate(()=>GravityDemo.toggleUI());
    }
    results.checks.push('Real WAV/FFT frequency isolation and rendered violet/mid/red responses with high saturation');
    await page.evaluate(()=>{GravityDemo.paused=false;GravityDemo.speed=0;GravityDemo.cameraMotion='gentle';});
    await load(70,true);
    const movement=await page.evaluate(async()=>{
      const d=GravityDemo;let peakShake=0,maxPixels=0;
      const measure=()=>{
        const location=d.gl.getUniformLocation(d.programs.composite.p,'uFraming');
        const actual=d.gl.getUniform(d.programs.composite.p,location);
        const x=d.framing+.028*Math.sin(d.cameraTime*.09),y=d.framingY+.012*Math.sin(d.cameraTime*.12);
        maxPixels=Math.max(maxPixels,Math.hypot(actual[0]-x,actual[1]-y)*d.canvas.height);
        peakShake=Math.max(peakShake,d.spectrum.shake);
      };
      const start=performance.now();
      while(performance.now()-start<3200){await new Promise(requestAnimationFrame);measure();}
      return {peakShake,maxPixels};
    });
    results.movement=movement;
    assert.ok(movement.peakShake>.35&&movement.maxPixels>1.5,'Strong bass pulses must cause visible camera movement');
    assert.ok(movement.maxPixels<12,'Camera shake must remain bounded');
    const suppressed=await page.evaluate(()=>{
      const d=GravityDemo;d.spectrum.shake=1;
      const error=()=>{d.present();const gl=d.gl,p=d.programs.composite.p,framing=gl.getUniform(p,gl.getUniformLocation(p,'uFraming'));
        return Math.hypot(framing[0]-d.framing-.028*Math.sin(d.cameraTime*.09),framing[1]-d.framingY-.012*Math.sin(d.cameraTime*.12))*d.canvas.height;};
      const old=d.shakeStrength;d.shakeStrength=0;const disabled=error();d.shakeStrength=old;
      d.cameraMotion='fixed';const held=error();d.cameraMotion='gentle';d.paused=true;const paused=error();d.paused=false;
      return {disabled,held,paused};
    });
    assert.ok(Object.values(suppressed).every(v=>v<.001),'Disabled, held and paused cameras must not shake');
    assert.equal(await page.evaluate(()=>GravityDemo.cacheBuilds),builds,'Audio and shake must reuse the light cache');
    await page.evaluate(()=>document.getElementById('music').pause());
    await page.waitForFunction(()=>GravityDemo.spectrum.energy<.001&&GravityDemo.spectrum.shake<.001,null,{timeout:5000});
    assert.equal(await page.locator('#auto-sensitivity').isChecked(),true);
    assert.equal(await page.locator('#audio-gain').isVisible(),false);
    await page.locator('#auto-sensitivity').uncheck();
    await page.locator('#audio-gain').fill('1.6');await page.locator('#audio-gain').dispatchEvent('input');
    await page.locator('#bass-shake').fill('0');await page.locator('#bass-shake').dispatchEvent('input');
    assert.deepEqual(await page.evaluate(()=>[GravityDemo.audioGain,GravityDemo.shakeStrength]),[1.6,0]);
    await page.locator('#auto-sensitivity').check();
    assert.equal(await page.locator('#audio-gain').isVisible(),false);
    await page.locator('#auto-sensitivity').uncheck();
    assert.equal(await page.locator('#audio-gain').inputValue(),'1.6');
    assert.equal(await page.evaluate(()=>GravityDemo.spectrum.autoSensitivity),false);
    results.suppressed=suppressed;
    results.checks.push('Bass-only onset camera movement, bounded displacement, mute/hold/pause/disable behavior and no retracing');
    results.checks.push('Sensitivity and bass-shake controls');assert.deepEqual(errors,[]);results.passed=true;
    fs.writeFileSync(path.join(out,'audio-browser-results.json'),JSON.stringify(results,null,2));
    console.log('PASS',results.checks,movement,results.tones.map(t=>({hz:t.hz,frequency:t.frequency,saturation:t.saturation,rgb:t.rgb})));
  }finally{if(!results.passed)fs.writeFileSync(path.join(out,'audio-browser-failure.json'),JSON.stringify({...results,errors},null,2));await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
