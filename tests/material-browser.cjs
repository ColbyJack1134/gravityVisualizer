const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const spread=values=>Math.max(...values)/Math.min(...values)-1;
(async()=>{
  const browser=process.env.GRAVITY_CDP?await chromium.connectOverCDP(process.env.GRAVITY_CDP)
    :await chromium.launch({channel:process.env.GRAVITY_CHANNEL||'chrome',headless:true,args:['--enable-webgl']});
  const context=await browser.newContext({viewport:{width:1280,height:720}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  try{
    await page.goto((process.env.GRAVITY_URL||pathToFileURL(path.resolve('gravity-demo.html')).href)+'?motion=fixed');
    await page.waitForFunction(()=>window.GravityDemo?.cacheReady||window.GravityDemo?.failed,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>GravityDemo.failed),false);
    const result=await page.evaluate(()=>{
      const d=GravityDemo,gl=d.gl,P=GravityPhysics,S=GravityShaders;cancelAnimationFrame(d.raf);
      d.paused=true;d.material=1;d.spectrum.driven=0;
      // Probe the production kernel without duplicating its math.
      d.programs.deposit=d.program(S.depositVertex,S.depositFragment,['vWeight','vColor']);
      const feedback=gl.createTransformFeedback(),buffer=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,256,gl.DYNAMIC_READ);gl.bindBuffer(gl.ARRAY_BUFFER,null);
      function deposit(position,id=0,time=0,strength=1){
        d.simTime=time;
        const omega=1/(12**1.5+d.a()),mom=P.massiveMomentum(position,[-position[1]*omega,position[0]*omega,0],d.a());
        gl.bindBuffer(gl.ARRAY_BUFFER,d.particleBuffers[d.particleIndex]);
        gl.bufferSubData(gl.ARRAY_BUFFER,id*d.particleStride*4,new Float32Array([...position,1000,...mom.p,mom.pt,d.fadeSeconds,-1]));gl.bindBuffer(gl.ARRAY_BUFFER,null);
        const draw=gl.drawArraysInstanced;let instances=0;
        gl.drawArraysInstanced=(mode,first,count,n)=>{instances=n;};
        try{d.deposit();}finally{gl.drawArraysInstanced=draw;}
        d.f('uParticleWeight',strength);gl.bindVertexArray(d.particleVAOs[d.particleIndex]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,feedback);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,buffer);
        gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArraysInstanced(gl.POINTS,id,1,instances);
        gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,null);gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null);
        const attrs=new Float32Array(instances*4);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.getBufferSubData(gl.ARRAY_BUFFER,0,attrs);gl.bindBuffer(gl.ARRAY_BUFFER,null);
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);gl.drawArraysInstanced(gl.POINTS,id,1,instances);gl.disable(gl.BLEND);gl.bindVertexArray(null);
        const q=position.map((v,i)=>(v/(2*d.volumeExtent[i])+.5)*d.volumeGrid[i]-.5),base=q.map(Math.floor);
        let sum=0,weight=0;
        for(let i=0;i<attrs.length;i+=4)weight+=attrs[i];
        for(let z=base[2]-2;z<=base[2]+3;z++){
          const pixels=new Float32Array(12*12*4);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.readPixels((z%8)*d.volumeGrid[0]+base[0]-5,Math.floor(z/8)*d.volumeGrid[1]+base[1]-5,12,12,gl.RGBA,gl.FLOAT,pixels);
          for(let i=3;i<pixels.length;i+=4)sum+=pixels[i];
        }
        return {sum,weight,color:attrs[1]+attrs[2]+attrs[3],normalized:sum/weight};
      }
      const phaseRows=[];
      for(const id of [0,1,37])for(let axis=0;axis<3;axis++){
        const values=[];
        for(let step=0;step<=16;step++){
          const position=[12,0,.075];position[axis]+=step/16*2*d.volumeExtent[axis]/d.volumeGrid[axis];
          values.push(deposit(position,id));
        }
        phaseRows.push({id,axis:'xyz'[axis],values});
      }
      const clock=[0,2,10,30,60,120].map(t=>deposit([12,0,.075],0,t));

      // Known segments isolate volume sampling from ray integration.
      const width=48,layers=64,positions=new Float32Array(width*width*layers*4),momenta=new Float32Array(positions.length);
      for(let s=0;s<layers;s++)for(let y=0;y<width;y++)for(let x=0;x<width;x++)
        positions.set([10.25+s*.5,((x+.5)/width-.5)*1.2,((y+.5)/width-.5)*1.2,s<8?.5:-1],((s*width+y)*width+x)*4);
      const tx=d.texture(width,width,gl.RGBA32F,false,layers),tp=d.texture(width,width,gl.RGBA32F,false,layers);
      for(const [texture,data]of[[tx,positions],[tp,momenta]]){
        gl.bindTexture(gl.TEXTURE_2D_ARRAY,texture);gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,width,width,layers,gl.RGBA,gl.FLOAT,data);
      }
      const sky=d.texture(1,1,gl.RGBA32F);gl.bindTexture(gl.TEXTURE_2D,sky);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,1,1,gl.RGBA,gl.FLOAT,new Float32Array([0,0,0,1]));
      const image=d.texture(width,width,gl.RGBA32F),fbo=d.fbo([image]);
      function flux(){
        gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.viewport(0,0,width,width);d.use(d.programs.shade);
        d.i('uSlices',64);d.f('uSpin',0);d.f('uBrightness',1);d.f('uObserverEnergy',1);d.f('uOrbitAngle',0);
        d.v3('uVolumeGrid',d.volumeGrid);d.v3('uVolumeExtent',d.volumeExtent);
        d.bind('uPathX',tx,0,gl.TEXTURE_2D_ARRAY);d.bind('uPathP',tp,1,gl.TEXTURE_2D_ARRAY);d.bind('uSky',sky,2);d.bind('uEmission',d.emission,3);
        // p_i=0 and velocity.w=emission.a give g=1: exclude Doppler changes.
        d.bind('uVelocity',d.emission,4);d.quad();
        const pixels=new Float32Array(width*width*4);gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.readPixels(0,0,width,width,gl.RGBA,gl.FLOAT,pixels);
        let sum=0;for(let i=0;i<pixels.length;i+=4)sum+=pixels[i]+pixels[i+1]+pixels[i+2];return sum;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,d.emissionFBO);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      const background=flux(),rayRows=[];
      for(let axis=0;axis<3;axis++){
        const values=[];
        for(let step=0;step<=16;step++){
          const position=[12,0,.075];position[axis]+=step/16*2*d.volumeExtent[axis]/d.volumeGrid[axis];
          const source=deposit(position,0,0,4),light=flux()-background;
          values.push({light,normalized:light/(source.color*source.weight)});
        }
        rayRows.push({axis:'xyz'[axis],values});
      }
      return {renderer:d.rendererName,phaseRows,clock,rayRows,glError:gl.getError()};
    });
    for(const row of result.phaseRows)assert.ok(spread(row.values.map(v=>v.normalized))<.002,`Particle ${row.id} loses light crossing ${row.axis} cells`);
    assert.ok(spread(result.clock.map(v=>v.sum))<.00001,'Audio-off material must not flicker as the simulation clock advances');
    for(const row of result.rayRows){
      assert.ok(row.values.every(v=>v.light>.01),'Probe must produce visible particle light');
      assert.ok(spread(row.values.map(v=>v.normalized))<.03,`Ray samples miss a moving particle along ${row.axis}`);
    }
    assert.equal(result.glError,0);assert.deepEqual(errors,[]);
    result.date=new Date().toISOString();result.passed=true;
    result.depositionVariation=Math.max(...result.phaseRows.map(r=>spread(r.values.map(v=>v.normalized))));
    result.rayVariation=Math.max(...result.rayRows.map(r=>spread(r.values.map(v=>v.normalized))));
    fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/material-browser-results.json',JSON.stringify(result,null,2));
    console.log('PASS: subcell energy conservation, audio-off clock invariance, actual volume-ray integration.',
      {depositionVariation:result.depositionVariation,rayVariation:result.rayVariation});
  }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
