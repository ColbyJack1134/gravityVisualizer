const assert=require('node:assert/strict');
const P=require('../src/physics.js');
const close=(actual,expected,tol,label)=>assert.ok(Math.abs(actual-expected)<tol,`${label}: ${actual} vs ${expected}`);
const norm=P.length;
const rotate=(v,a)=>[Math.cos(a)*v[0]-Math.sin(a)*v[1],Math.sin(a)*v[0]+Math.cos(a)*v[1],v[2]];

// This symmetry permits the continuous camera orbit without rebuilding rays.
for(const spin of [0,.25,.95]){
  const x=[7,3,2],p=[.4,-.6,.3],angle=.73,rx=rotate(x,angle),rp=rotate(p,angle);
  close(P.hamiltonian(rx,rp,1,spin),P.hamiltonian(x,p,1,spin),1e-12,'Axial Hamiltonian symmetry');
  const f=P.flow(x,p,1,spin),rf=P.flow(rx,rp,1,spin);
  for(const component of ['x','p']){
    const expected=rotate(f[component],angle);
    for(let i=0;i<3;i++)close(rf[component][i],expected[i],1e-12,'Rotated geodesic flow');
  }
}

close(P.horizon(0),2,1e-12,'Schwarzschild horizon');
close(P.isco(0),6,1e-12,'Schwarzschild ISCO');
close(P.isco(.85),2.6321006858,1e-8,'Kerr ISCO');

for(const spin of [0,.5,.85,.95]){
  for(const x of [[12,4,2],[3,2,1],[-5,8,-3]]){
    const p=[.4,-.3,.8],pt=-1.2,flow=P.flow(x,p,pt,spin),eps=1e-5;
    for(let i=0;i<3;i++){
      const xp=x.slice(),xm=x.slice();xp[i]+=eps;xm[i]-=eps;
      const derivative=-(P.hamiltonian(xp,p,pt,spin)-P.hamiltonian(xm,p,pt,spin))/(2*eps);
      close(flow.p[i],derivative,1e-8,'Analytic Hamiltonian gradient');
    }
    const n=P.normalize([.2,-.7,-.6]),photon=P.photon(x,n,spin);
    close(P.hamiltonian(x,photon,1,spin),0,1e-10,'Initial photon null constraint');
  }
}

function traceImpact(b,spin=0){
  let x=[0,0,100],theta=Math.asin(b*Math.sqrt(1-2/100)/100),p=P.photon(x,[Math.sin(theta),0,-Math.cos(theta)],spin);
  let maxRelativeError=0;
  for(let i=0;i<8000;i++){
    const r=P.metric(x,spin).r;
    if(r<P.horizon(spin)+.005)return {capture:true,maxRelativeError};
    assert.ok(P.dot(p,p)<1e10,'Photon integration stays finite outside the horizon');
    if(r>140)return {capture:false,maxRelativeError};
    const flow=P.flow(x,p,1,spin),h=Math.min(1,Math.max(.0001,.06*(r-P.horizon(spin))))/Math.max(norm(flow.x),1);
    ({x,p}=P.step(x,p,1,spin,h));
    maxRelativeError=Math.max(maxRelativeError,Math.abs(P.hamiltonian(x,p,1,spin))/(1+P.dot(p,p)));
  }
  throw new Error('Ray did not terminate');
}
const critical=3*Math.sqrt(3);
assert.equal(traceImpact(critical-.02).capture,true,'Below critical impact parameter must be captured');
const escape=traceImpact(critical+.02);assert.equal(escape.capture,false,'Above critical impact parameter must escape');
assert.ok(escape.maxRelativeError<2e-5,'Null constraint must remain bounded');

function orbit(spin,dt){
  const r=10,rho=Math.sqrt(r*r+spin*spin),omega=1/(r**1.5+spin);
  let x=[rho,0,0];const initial=P.massiveMomentum(x,[0,rho*omega,0],spin);let p=initial.p;
  const pt=initial.pt,startH=P.hamiltonian(x,p,pt,spin);
  close(startH,-.5,1e-12,'Massive-particle normalization');
  for(let i=0;i<Math.round(100/dt);i++)({x,p}=P.step(x,p,pt,spin,dt,true));
  return {radialError:Math.abs(P.metric(x,spin).r-r),energyError:Math.abs(P.hamiltonian(x,p,pt,spin)+.5)};
}
for(const spin of [0,.85]){
  const result=orbit(spin,.08);
  assert.ok(result.radialError<1e-7,`Stable circular orbit at spin ${spin}: ${JSON.stringify(result)}`);
  assert.ok(result.energyError<1e-10,'Timelike constraint drift');
}
console.log('PASS: horizons and ISCO, analytic gradients, null initialization, critical capture boundary, circular orbits, and axial camera symmetry.');
