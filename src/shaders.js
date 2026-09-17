(function (root) {
  'use strict';
  const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
`;
  const common = `
const float PI=3.141592653589793;
// Integer mixing preserves entropy for large particle IDs.
float hash(float v){uint x=floatBitsToUint(v);x^=x>>16;x*=0x7feb352du;x^=x>>15;x*=0x846ca68bu;x^=x>>16;return float(x>>8)*(1./16777216.);}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float n=dot(i,vec3(1.,57.,113.));
return mix(mix(mix(hash(n),hash(n+1.),f.x),mix(hash(n+57.),hash(n+58.),f.x),f.y),mix(mix(hash(n+113.),hash(n+114.),f.x),mix(hash(n+170.),hash(n+171.),f.x),f.y),f.z);}
// Weights sum to one across four cells, conserving light as particles move.
float cubicWeight(float x){
  x=abs(x);
  if(x<1.)return (4.-6.*x*x+3.*x*x*x)/6.;
  return pow(max(2.-x,0.),3.)/6.;
}
// Kerr–Schild inverse metric eta - f l^mu l^nu. All derivatives are analytic.
void metric(vec3 x,float a,out float r,out float f,out vec3 l,out vec3 dr,out vec3 df){
  float aa=a*a,u=dot(x,x)-aa,d=sqrt(max(u*u+4.*aa*x.z*x.z,1e-12));
  r=sqrt(max(.5*(u+d),1e-8));
  float rr=r*r,den=rr+aa,w=max(rr*rr+aa*x.z*x.z,1e-10);
  l=vec3(r*x.x+a*x.y,r*x.y-a*x.x,0.)/den;l.z=x.z/r;
  f=2.*r*rr/w;
  dr=(x*(1.+u/d)+vec3(0.,0.,2.*aa*x.z/d))/(2.*r);
  df=f*(3.*dr/r-(4.*r*rr*dr+vec3(0.,0.,2.*aa*x.z))/w);
}
float radius(vec3 x,float a){float u=dot(x,x)-a*a;return sqrt(max(.5*(u+sqrt(u*u+4.*a*a*x.z*x.z)),1e-8));}
void flow(vec3 x,vec3 p,float pt,float a,out vec3 dx,out vec3 dp,out float dt){
  float r,f;vec3 l,dr,df;metric(x,a,r,f,l,dr,df);
  float den=r*r+a*a,s=dot(x.xy,p.xy),num=r*s+a*(x.y*p.x-x.x*p.y);
  float c=s/den-2.*r*num/(den*den)-x.z*p.z/(r*r);
  vec3 grad=c*dr+vec3((r*p.x-a*p.y)/den,(a*p.x+r*p.y)/den,p.z/r);
  float q=-pt+dot(l,p);
  dx=p-f*q*l; dp=.5*df*q*q+f*q*grad; dt=-pt+f*q;
}
vec3 photon(vec3 x,vec3 n,float a){
  float r,f;vec3 l,dr,df;metric(x,a,r,f,l,dr,df);
  float s=sqrt(max(1.-f,1e-4));
  return n/s+((1./(s*s)-1./s)*dot(n,l)-f/(s*s))*l;
}
void rk4(inout vec3 x,inout vec3 p,inout float t,float pt,float a,float h){
  vec3 x1,p1,x2,p2,x3,p3,x4,p4;float t1,t2,t3,t4;
  flow(x,p,pt,a,x1,p1,t1);
  flow(x+.5*h*x1,p+.5*h*p1,pt,a,x2,p2,t2);
  flow(x+.5*h*x2,p+.5*h*p2,pt,a,x3,p3,t3);
  flow(x+h*x3,p+h*p3,pt,a,x4,p4,t4);
  x+=h*(x1+2.*x2+2.*x3+x4)/6.; p+=h*(p1+2.*p2+2.*p3+p4)/6.;
  t+=h*(t1+2.*t2+2.*t3+t4)/6.;
}
float stepSize(vec3 x,vec3 p,float a,float horizon,float cap){
  vec3 dx,dp;float dt;flow(x,p,1.,a,dx,dp,dt);
  float r=radius(x,a);
  // Bound radial approach separately from the growing angular speed near the horizon.
  float rr=r*r;
  vec3 dr=r*vec3(rr*x.xy,(rr+a*a)*x.z)/(rr*rr+a*a*x.z*x.z);
  float spatial=min(cap,max(.022,.12*(r-horizon+.35)))/max(length(dx),1.);
  float radial=.12*(r-horizon)/max(abs(dot(dr,dx)),.001);
  return min(spatial,radial);
}
`;
  const fullscreen =
    header +
    `out vec2 uv;void main(){vec2 q=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=q;gl_Position=vec4(q*2.-1.,0.,1.);}`;
  const rayUniforms = `
in vec2 uv;
uniform vec3 uCamera,uRight,uUp,uForward;
uniform float uAspect,uTanFov,uSpin,uHorizon,uISCO,uObserverEnergy;
uniform vec2 uRaySize;uniform float uRayRow;
vec3 rayDirection(){vec2 q=(gl_FragCoord.xy+vec2(0.,uRayRow))/uRaySize*2.-1.;return normalize(uForward+q.x*uAspect*uTanFov*uRight+q.y*uTanFov*uUp);}
`;
  const volumeTrace =
    header +
    common +
    rayUniforms +
    `
uniform sampler2D uStateX,uStateP;
uniform int uSlice;
uniform float uVolumeScale;
layout(location=0) out vec4 stateX;
layout(location=1) out vec4 stateP;
layout(location=2) out vec4 pathX;
layout(location=3) out vec4 pathP;
void main(){
  vec4 sx=texture(uStateX,uv),sp=texture(uStateP,uv);
  vec3 x=uSlice==0?uCamera:sx.xyz,p=uSlice==0?photon(x,rayDirection(),uSpin):sp.xyz;
  float status=uSlice==0?0.:sx.w,t=uSlice==0?0.:sp.w;
  vec3 middle=x,mp=p;float travelled=0.;
  // Skip empty space; spend the path cache on the finite-thickness disk.
  for(int i=0;i<400;i++){
    if(status!=0.)break;
    float r=radius(x,uSpin);
    if(r<uHorizon+.006){status=1.;break;}
    if(dot(p,p)>1e10){status=4.;break;}
    if(r>max(75.,length(uCamera)+5.)){status=2.;break;}
    bool inside=abs(x.z)<4.8*uVolumeScale&&length(x.xy)<24.*uVolumeScale&&r>uISCO*.82;
    vec3 old=x;
    float h=stepSize(x,p,uSpin,uHorizon,inside?.25*uVolumeScale:1.0);
    rk4(x,p,t,1.,uSpin,h);
    if(inside){
      middle=x;mp=p;travelled=length(x-old);old=x;
      rk4(x,p,t,1.,uSpin,stepSize(x,p,uSpin,uHorizon,.25*uVolumeScale));
      travelled+=length(x-old);break;
    }
    if(any(isnan(x))||any(isnan(p))){status=4.;break;}
  }
  stateX=vec4(x,status);stateP=vec4(p,t);
  pathX=vec4(middle,status!=0.&&travelled==0.?-1.:travelled);pathP=vec4(clamp(mp,vec3(-60000.),vec3(60000.)),0.);
}
`;
  const volumeFinish =
    header +
    common +
    rayUniforms +
    `
uniform sampler2D uStateX,uStateP;
out vec4 sky;
void main(){
  vec4 sx=texture(uStateX,uv),sp=texture(uStateP,uv);vec3 x=sx.xyz,p=sp.xyz;float t=sp.w,status=sx.w;
  for(int i=0;i<1536;i++){
    if(status!=0.)break;
    float r=radius(x,uSpin);
    if(r<uHorizon+.006){status=1.;break;}
    if(dot(p,p)>1e10){status=4.;break;}
    if(r>max(75.,length(uCamera)+5.)){status=2.;break;}
    rk4(x,p,t,1.,uSpin,stepSize(x,p,uSpin,uHorizon,1.8));
    if(any(isnan(x))||any(isnan(p))){status=4.;break;}
  }
  if(status==0.)status=3.;
  vec3 dx,dp;float dt;flow(x,p,1.,uSpin,dx,dp,dt);sky=vec4(normalize(dx),status);
}
`;
  const particleUpdate =
    header +
    common +
    `
layout(location=0) in vec4 aPosition;
layout(location=1) in vec4 aMomentum;
layout(location=2) in vec2 aLifecycle;
out vec4 vPosition;out vec4 vMomentum;out vec2 vLifecycle;
uniform float uSpin,uHorizon,uISCO,uDt,uSeed,uRealDt,uFadeSeconds,uTimeScale;
uniform float uCloudRadius;
void spawn(out vec3 x,out vec3 p,out float pt,out float age){
  float id=float(gl_VertexID),s=id*1.718+uSeed*13.13;
  float r=mix(uISCO+1.,uCloudRadius,pow(hash(s+.1),.72)),angle=hash(s+7.)*2.*PI;
  float rho=sqrt(r*r+uSpin*uSpin);
  x=vec3(cos(angle)*rho,sin(angle)*rho,(hash(s+9.)-.5)*.025);
  vec3 tangent=vec3(-sin(angle),cos(angle),0.);
  float inc=(hash(s+13.)-.5)*.32+.035*sin(r*.4);
  float node=hash(s+18.)*2.*PI;
  vec3 axis=vec3(cos(node),sin(node),0.);
  x=x*cos(inc)+cross(axis,x)*sin(inc)+axis*dot(axis,x)*(1.-cos(inc));
  tangent=tangent*cos(inc)+cross(axis,tangent)*sin(inc)+axis*dot(axis,tangent)*(1.-cos(inc));
  float rr,f;vec3 l,dr,df;metric(x,uSpin,rr,f,l,dr,df);
  float omega=1./(pow(rr,1.5)+uSpin);
  vec3 velocity=tangent*(rho*omega)*mix(.9,1.,hash(s+22.))-.009*normalize(x);
  float lv=1.+dot(l,velocity),norm=1.-dot(velocity,velocity)-f*lv*lv;
  if(norm<.02){velocity*=.65;lv=1.+dot(l,velocity);norm=1.-dot(velocity,velocity)-f*lv*lv;}
  float ut=inversesqrt(max(norm,.01));
  p=(velocity+f*l*lv)*ut;pt=(-1.+f*lv)*ut;age=90.+hash(s+28.)*240.;
}
void main(){
  vec3 x=aPosition.xyz,p=aMomentum.xyz;float age=aPosition.w,pt=aMomentum.w;
  vec2 life=aLifecycle;
  float r=radius(x,uSpin);
  bool initial=age<=0.&&life.x==0.&&life.y==0.;
  bool expired=uFadeSeconds<=0.?age<=0.:life.y>=uFadeSeconds;
  if(initial||expired||r<uHorizon+.025||r>uCloudRadius+8.||any(isnan(x))||dot(p,p)>1e7){
    spawn(x,p,pt,age);life=vec2(0.,-1.);
  }
  else{
    // Fade in real seconds, even if the time scale changes during expiry.
    if(life.y<0.&&age<=uFadeSeconds*uTimeScale)life.y=0.;
    life.x=min(life.x+uRealDt,max(uFadeSeconds,0.));
    if(life.y>=0.)life.y+=uRealDt;
    for(int i=0;i<4;i++){
      float h=uDt*.25;vec3 dx,dp;float dt;flow(x,p,pt,uSpin,dx,dp,dt);
      vec3 mx=x+.5*h*dx/max(dt,.05),mp=p+.5*h*dp/max(dt,.05);
      flow(mx,mp,pt,uSpin,dx,dp,dt);x+=h*dx/max(dt,.05);p+=h*dp/max(dt,.05);
    }
    age=max(0.,age-uDt);
  }
  vPosition=vec4(x,age);vMomentum=vec4(p,pt);vLifecycle=life;
}
`;
  const emptyFragment = header + `out vec4 color;void main(){color=vec4(0.);}`;
  const depositVertex =
    header +
    common +
    `
layout(location=0) in vec4 aPosition;
layout(location=1) in vec4 aMomentum;
layout(location=2) in vec2 aLifecycle;
uniform float uSpin,uISCO,uMaterial,uParticleWeight,uFadeSeconds;
uniform float uCloudRadius;uniform vec2 uBrightnessRange;
uniform float uBands[24],uAudioDriven,uIdleParticles;
uniform int uBandCount;
uniform float uSustainStrength;
uniform vec3 uBandColors[24];
uniform sampler2D uPalette;uniform int uWeightedPalette;
uniform vec3 uVolumeGrid,uVolumeExtent;
out vec3 vColor;out float vWeight;out vec3 vVelocity;out float vTime;
flat out vec2 vCenter;flat out float vKernelMass;
void main(){
  vec3 x=aPosition.xyz;float r=radius(x,uSpin);
  float random=hash(float(gl_VertexID)+.8);
  vWeight=smoothstep(random-.035,random+.035,uMaterial)*uParticleWeight;
  if(uFadeSeconds>0.){
    float birth=smoothstep(0.,uFadeSeconds,aLifecycle.x);
    float death=aLifecycle.y<0.?1.:1.-smoothstep(0.,uFadeSeconds,aLifecycle.y);
    vWeight*=birth*death;
  }
  float inner=uISCO*.86;
  vWeight*=smoothstep(inner,inner+.55,r)*(1.-smoothstep(uCloudRadius,uCloudRadius+1.,r));
  float heat=pow(uISCO/max(r,uISCO),.65);
  float kind=hash(float(gl_VertexID)+37.2);
  float palettePosition=hash(float(gl_VertexID)+81.3);
  int band=int(palettePosition*float(uBandCount));
  float level=uBands[band];
  int colorIndex=int(palettePosition*float(textureSize(uPalette,0).x));
  vec3 tint=uWeightedPalette==1?texelFetch(uPalette,ivec2(colorIndex,0),0).rgb:uBandColors[band];
  vColor=tint*(.28+1.9*heat)*mix(uBrightnessRange.x,uBrightnessRange.y,kind);
  float amount=clamp(level*uSustainStrength,0.,1.);
  float rank=hash(float(gl_VertexID)+113.9);
  float visibility=smoothstep(rank-.025,rank+.025,mix(-.025,1.025,amount));
  vWeight*=mix(uIdleParticles,visibility,uAudioDriven);
  vColor*=mix(.70,1.725,uAudioDriven);
  vWeight*=mix(.18,1.8,pow(hash(float(gl_VertexID)+51.),2.));
  vColor*=pow(heat,1.4);
  vec3 dx,dp;float dt;flow(x,aMomentum.xyz,aMomentum.w,uSpin,dx,dp,dt);
  // Four-velocity supports the Doppler contraction with photon momentum.
  vVelocity=dx;vTime=dt;
  vKernelMass=.108*pow(mix(3.0,4.4,kind),2.);
  vec3 q=(x/(uVolumeExtent*2.)+.5)*uVolumeGrid-.5;
  float layer=floor(q.z)-1.+float(gl_InstanceID);
  vWeight*=cubicWeight(q.z-layer);
  if(layer<0.||layer>=uVolumeGrid.z||any(lessThan(q.xy,vec2(2.)))||any(greaterThan(q.xy,uVolumeGrid.xy-3.)))vWeight=0.;
  float columns=8.;vec2 tile=vec2(mod(layer,columns),floor(layer/columns));
  vCenter=tile*uVolumeGrid.xy+q.xy+.5;
  // Evaluate at the original position to avoid point-rasterization snapping.
  vec2 atlas=(tile*uVolumeGrid.xy+floor(q.xy)+1.)/vec2(uVolumeGrid.x*columns,uVolumeGrid.y*(uVolumeGrid.z/columns));
  gl_Position=vec4(atlas*2.-1.,0.,1.);gl_PointSize=4.;
}
`;
  const depositFragment =
    header +
    common +
    `
in vec3 vColor,vVelocity;in float vWeight,vTime;
flat in vec2 vCenter;flat in float vKernelMass;
layout(location=0) out vec4 color;
layout(location=1) out vec4 velocity;
void main(){
vec2 delta=gl_FragCoord.xy-vCenter;
float kernel=cubicWeight(delta.x)*cubicWeight(delta.y)*vKernelMass;
float g=kernel*vWeight;
color=vec4(vColor*g,g);velocity=vec4(vVelocity*g,vTime*g);}
`;
  const skyCode = `
uniform float uStarDensity,uCloudDensity;
vec3 background(vec3 direction){
  vec3 d=normalize(direction);vec2 q=vec2(atan(d.y,d.x)/(2.*PI)+.5,asin(clamp(d.z,-1.,1.))/PI+.5);
  vec2 grid=q*vec2(640.,320.),cell=floor(grid);float seed=dot(cell,vec2(1.,1543.));
  vec2 center=vec2(hash(seed+3.),hash(seed+5.));vec2 delta=fract(grid)-center;
  float footprint=max(length(fwidth(grid)),.12),width=clamp(footprint*.32,.08,.3),star=exp(-dot(delta,delta)/(width*width));
  star*=(uStarDensity>0.?step(1.-.0045*uStarDensity,hash(seed)):0.)
    *pow(hash(seed+8.),3.)*.18*min(1.,.3/footprint);
  vec3 tint=mix(vec3(.57,.73,1.),vec3(1.,.72,.46),hash(seed+9.));
  float band=exp(-pow(dot(d,normalize(vec3(.2,.6,1.)))*6.,2.));
  float dust=noise3(d*9.)*.65+noise3(d*25.)*.35;
  float cloud=uCloudDensity>0.?1.-pow(1.-band*pow(dust,3.),uCloudDensity):0.;
  return vec3(.00013,.0002,.00035)+tint*star+vec3(.0012,.0017,.0032)*cloud;
}
`;
  const viewCode = `
uniform float uOrbitAngle,uRoll,uViewAspect,uOverscan;
uniform vec2 uFraming;
vec3 orbit(vec3 v){float c=cos(uOrbitAngle),s=sin(uOrbitAngle);return vec3(c*v.x-s*v.y,s*v.x+c*v.y,v.z);}
vec2 viewUV(vec2 p){
  vec2 q=(p-.5)*vec2(uViewAspect,1.)-uFraming;
  float c=cos(uRoll),s=sin(uRoll);q=mat2(c,-s,s,c)*q;
  return .5+q/vec2(uViewAspect,1.)/uOverscan;
}
`;
  const volumeShade =
    header +
    common +
    skyCode +
    viewCode +
    `
in vec2 uv;out vec4 color;
uniform sampler2DArray uPathX,uPathP;
uniform sampler2D uSky,uEmission,uVelocity;
uniform float uSpin,uBrightness,uObserverEnergy,uCacheRow;
uniform int uSlices;
uniform vec3 uVolumeGrid,uVolumeExtent;
vec4 volume(sampler2D atlas,vec3 position){
  vec3 q=(position/(uVolumeExtent*2.)+.5)*uVolumeGrid-.5;
  if(any(lessThan(q,vec3(0.)))||any(greaterThan(q,uVolumeGrid-1.)))return vec4(0.);
  // Cubic reconstruction keeps particle profiles smooth across cell boundaries.
  vec3 base=floor(q),f=q-base;
  vec3 w0=pow(1.-f,vec3(3.))/6.,w3=f*f*f/6.;
  vec3 w1=(4.-6.*f*f+3.*f*f*f)/6.,w2=1.-w0-w1-w3;
  vec2 g0=w0.xy+w1.xy,g1=w2.xy+w3.xy;
  vec2 a=clamp(base.xy-.5+w1.xy/g0,vec2(.5),uVolumeGrid.xy-.5);
  vec2 b=clamp(base.xy+1.5+w3.xy/g1,vec2(.5),uVolumeGrid.xy-.5);
  vec2 dims=vec2(uVolumeGrid.x*8.,uVolumeGrid.y*(uVolumeGrid.z/8.));
  vec4 wz=vec4(w0.z,w1.z,w2.z,w3.z),sum=vec4(0.);
  for(int k=0;k<4;k++){
    float z=clamp(base.z-1.+float(k),0.,uVolumeGrid.z-1.);
    vec2 tile=vec2(mod(z,8.),floor(z/8.))*uVolumeGrid.xy;
    sum+=wz[k]*(texture(atlas,(tile+a)/dims)*g0.x*g0.y
      +texture(atlas,(tile+vec2(b.x,a.y))/dims)*g1.x*g0.y
      +texture(atlas,(tile+vec2(a.x,b.y))/dims)*g0.x*g1.y
      +texture(atlas,(tile+b)/dims)*g1.x*g1.y);
  }
  return sum;
}
void main(){
  vec2 lookup=vec2(uv.x,(gl_FragCoord.y-uCacheRow)/float(textureSize(uPathX,0).y));
  if(any(lessThan(lookup,vec2(0.)))||any(greaterThan(lookup,vec2(1.)))){color=vec4(.00013,.0002,.00035,0.);return;}
  vec3 sum=vec3(0.);float trans=1.;
  for(int i=0;i<64;i++){
    if(i>=uSlices||trans<.012)break;
    vec4 path=texture(uPathX,vec3(lookup,float(i)));path.xyz=orbit(path.xyz);
    if(path.w<0.)break;
    if(path.w<.00001)continue;
    vec3 p=orbit(texture(uPathP,vec3(lookup,float(i))).xyz);
    float r,f;vec3 l,dr,df;metric(path.xyz,uSpin,r,f,l,dr,df);
    vec3 direction=normalize(p-f*(-1.+dot(l,p))*l);
    vec3 cells=abs(direction)*path.w*uVolumeGrid/(uVolumeExtent*2.);
    // Bound spacing in all directions, including diagonal rays.
    int samples=clamp(int(ceil(length(cells)*.625)),1,4);
    for(int j=0;j<4;j++){
      if(j>=samples||trans<.012)break;
      vec3 position=path.xyz+direction*((float(j)+.5)/float(samples)-.5)*path.w;
      vec4 e=volume(uEmission,position);
      if(e.a<.0001)continue;
      vec4 velocities=volume(uVelocity,position);
      float g=clamp(uObserverEnergy*e.a/max(velocities.w+dot(velocities.xyz,p),.05*e.a),.08,3.);
      float alpha=1.-exp(-e.a*path.w/float(samples)*.22);
      vec3 light=e.rgb/max(e.a,.001)*pow(g,3.)*uBrightness;
      sum+=trans*alpha*light;trans*=1.-alpha;
    }
  }
  float foreground=max(sum.r,max(sum.g,sum.b));
  vec4 sky=texture(uSky,lookup);
  if(sky.w>1.5&&sky.w<2.5)sum+=trans*background(orbit(sky.xyz));
  float edge=min(min(uv.x,uv.y),min(1.-uv.x,1.-uv.y));
  float fade=smoothstep(0.,.035,edge);
  color=vec4(mix(vec3(.00013,.0002,.00035),sum,fade),foreground*fade);
}
`;
  const starAppearance =
    header +
    `
in vec2 uv;out vec4 color;uniform sampler2D uImage;
uniform float uDefinition;uniform vec2 uCoreRadius;
void main(){
  vec4 c=texture(uImage,uv);
  float left=texture(uImage,uv-vec2(uCoreRadius.x,0.)).a;
  float right=texture(uImage,uv+vec2(uCoreRadius.x,0.)).a;
  float down=texture(uImage,uv-vec2(0.,uCoreRadius.y)).a;
  float up=texture(uImage,uv+vec2(0.,uCoreRadius.y)).a;
  float nw=texture(uImage,uv+vec2(-1.,1.)*uCoreRadius).a;
  float ne=texture(uImage,uv+uCoreRadius).a;
  float sw=texture(uImage,uv-uCoreRadius).a;
  float se=texture(uImage,uv+vec2(1.,-1.)*uCoreRadius).a;
  float surround=left+right+down+up+nw+ne+sw+se;
  float peak=max(c.r,max(c.g,c.b));
  float contrast=(c.a-surround/8.)/max(c.a,.0005);
  float detail=.5*(contrast+sqrt(contrast*contrast+.04));
  float gain=mix(1.,.45+2.75*detail,uDefinition);
  c.rgb*=1.+clamp(c.a/max(peak,1e-7),0.,1.)*(gain-1.);
  color=vec4(c.rgb,1.);
}
`;
  const blur =
    header +
    `
in vec2 uv;out vec4 color;uniform sampler2D uImage;uniform vec2 uDirection;uniform int uExtract;
void main(){
  vec3 c=vec3(0.);
  if(uExtract==1){
    vec2 texel=1./vec2(textureSize(uImage,0));
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++)c+=texture(uImage,uv+vec2(x,y)*texel).rgb/9.;
    c=max(c-vec3(.55),vec3(0.));
  }else{
    float weight=0.;
    for(int i=-6;i<=6;i++){float w=exp(-float(i*i)/12.5);c+=texture(uImage,uv+uDirection*float(i)).rgb*w;weight+=w;}
    c/=weight;
  }
  color=vec4(c,1.);
}
`;
  const composite =
    header +
    viewCode +
    `
in vec2 uv;out vec4 color;uniform sampler2D uImage,uBloom;uniform float uExposure,uGlow,uSharpness;
vec3 aces(vec3 v){return clamp((v*(2.51*v+.03))/(v*(2.43*v+.59)+.14),0.,1.);}
vec3 reconstruct(vec2 coord){
  // Catmull–Rom reconstruction with nine bilinear taps.
  vec2 size=vec2(textureSize(uImage,0)),p=coord*size-.5,base=floor(p),f=p-base;
  vec2 w0=f*(-.5+f*(1.-.5*f)),w1=1.+f*f*(-2.5+1.5*f);
  vec2 w2=f*(.5+f*(2.-1.5*f)),w3=f*f*(-.5+.5*f),w12=w1+w2;
  vec2 a=(base-.5)/size,b=(base+.5+w2/w12)/size,c=(base+2.5)/size;
  vec3 sum=texture(uImage,vec2(a.x,a.y)).rgb*w0.x*w0.y
    +texture(uImage,vec2(b.x,a.y)).rgb*w12.x*w0.y
    +texture(uImage,vec2(c.x,a.y)).rgb*w3.x*w0.y
    +texture(uImage,vec2(a.x,b.y)).rgb*w0.x*w12.y
    +texture(uImage,vec2(b.x,b.y)).rgb*w12.x*w12.y
    +texture(uImage,vec2(c.x,b.y)).rgb*w3.x*w12.y
    +texture(uImage,vec2(a.x,c.y)).rgb*w0.x*w3.y
    +texture(uImage,vec2(b.x,c.y)).rgb*w12.x*w3.y
    +texture(uImage,vec2(c.x,c.y)).rgb*w3.x*w3.y;
  // Bound negative-lobe overshoot by the four actual neighboring pixels.
  ivec2 lo=ivec2(base),hi=textureSize(uImage,0)-1;
  vec3 q0=texelFetch(uImage,clamp(lo,ivec2(0),hi),0).rgb;
  vec3 q1=texelFetch(uImage,clamp(lo+ivec2(1,0),ivec2(0),hi),0).rgb;
  vec3 q2=texelFetch(uImage,clamp(lo+ivec2(0,1),ivec2(0),hi),0).rgb;
  vec3 q3=texelFetch(uImage,clamp(lo+ivec2(1),ivec2(0),hi),0).rgb;
  return clamp(sum,min(min(q0,q1),min(q2,q3)),max(max(q0,q1),max(q2,q3)));
}
float value(vec3 c){return max(c.r,max(c.g,c.b));}
vec3 sharpen(vec3 c,vec2 coord){
  if(uSharpness<=0.)return c;
  vec2 texel=1./vec2(textureSize(uImage,0));
  float surrounding=.25*(value(texture(uImage,coord+vec2(texel.x,0.)).rgb)
    +value(texture(uImage,coord-vec2(texel.x,0.)).rgb)
    +value(texture(uImage,coord+vec2(0.,texel.y)).rgb)
    +value(texture(uImage,coord-vec2(0.,texel.y)).rgb));
  float peak=value(c);
  // A shared RGB gain preserves hue; suppress contrast near black.
  float detail=clamp((peak-surrounding)/max(peak,.002),-.4,.6);
  return c*(1.+uSharpness*detail*smoothstep(.0005,.008,peak));
}
void main(){
vec2 lookup=viewUV(uv);
vec3 c=sharpen(reconstruct(lookup),lookup)+texture(uBloom,lookup).rgb*uGlow;
if(any(lessThan(lookup,vec2(0.)))||any(greaterThan(lookup,vec2(1.))))c=vec3(.00013,.0002,.00035);
// Compress all channels by the same factor to preserve hue.
c=max(c,vec3(0.));float peak=max(c.r,max(c.g,c.b));
c*=aces(vec3(peak*uExposure)).r/max(peak,1e-7);
c=pow(c,vec3(1./2.2));float vignette=1.-.14*dot(uv-.5,uv-.5);color=vec4(c*vignette,1.);}
`;
  root.GravityShaders = {
    fullscreen,
    volumeTrace,
    volumeFinish,
    particleUpdate,
    emptyFragment,
    depositVertex,
    depositFragment,
    volumeShade,
    starAppearance,
    blur,
    composite
  };
})(globalThis);
