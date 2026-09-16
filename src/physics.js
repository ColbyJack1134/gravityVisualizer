/* Dimensionless Kerr–Schild coordinates: G = M = c = 1, signature -+++. */
(function (root) {
  'use strict';
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const length = (a) => Math.sqrt(dot(a, a));
  const scale = (a, s) => a.map((v) => v * s);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const normalize = (a) => scale(a, 1 / length(a));
  function metric(x, a) {
    const aa = a * a,
      u = dot(x, x) - aa,
      d = Math.sqrt(u * u + 4 * aa * x[2] * x[2]);
    const r = Math.sqrt(Math.max((u + d) * 0.5, 1e-12));
    const r2 = r * r,
      den = r2 + aa,
      w = r2 * r2 + aa * x[2] * x[2];
    const l = [(r * x[0] + a * x[1]) / den, (r * x[1] - a * x[0]) / den, x[2] / r];
    const f = (2 * r * r2) / w;
    const dr = x.map((v, i) => (v * (1 + u / d) + (i === 2 ? (2 * aa * x[2]) / d : 0)) / (2 * r));
    const df = dr.map((v, i) => f * ((3 * v) / r - (4 * r * r2 * v + (i === 2 ? 2 * aa * x[2] : 0)) / w));
    return { r, l, f, dr, df };
  }
  function flow(x, p, pt, a) {
    const { r, l, f, dr, df } = metric(x, a),
      den = r * r + a * a;
    const s = x[0] * p[0] + x[1] * p[1],
      num = r * s + a * (x[1] * p[0] - x[0] * p[1]);
    const coeff = s / den - (2 * r * num) / (den * den) - (x[2] * p[2]) / (r * r);
    const grad = dr.map(
      (v, i) => coeff * v + [(r * p[0] - a * p[1]) / den, (a * p[0] + r * p[1]) / den, p[2] / r][i]
    );
    const q = -pt + dot(l, p);
    return {
      x: p.map((v, i) => v - f * q * l[i]),
      p: df.map((v, i) => 0.5 * v * q * q + f * q * grad[i]),
      t: -pt + f * q
    };
  }
  function hamiltonian(x, p, pt, a) {
    const { l, f } = metric(x, a),
      q = -pt + dot(l, p);
    return 0.5 * (dot(p, p) - pt * pt - f * q * q);
  }
  function photon(x, n, a) {
    const { l, f } = metric(x, a),
      s = Math.sqrt(1 - f),
      nl = dot(n, l);
    return n.map((v, i) => v / s + ((1 / (s * s) - 1 / s) * nl - f / (s * s)) * l[i]);
  }
  function massiveMomentum(x, v, a) {
    const { l, f } = metric(x, a),
      lv = 1 + dot(l, v);
    const inv = 1 / Math.sqrt(1 - dot(v, v) - f * lv * lv);
    return { p: v.map((q, i) => (q + f * l[i] * lv) * inv), pt: (-1 + f * lv) * inv };
  }
  function step(x, p, pt, a, h, coordinateTime = false) {
    const rhs = (x, p) => {
      const f = flow(x, p, pt, a);
      if (coordinateTime) {
        f.x = scale(f.x, 1 / f.t);
        f.p = scale(f.p, 1 / f.t);
      }
      return f;
    };
    const k1 = rhs(x, p),
      k2 = rhs(add(x, scale(k1.x, h / 2)), add(p, scale(k1.p, h / 2)));
    const k3 = rhs(add(x, scale(k2.x, h / 2)), add(p, scale(k2.p, h / 2)));
    const k4 = rhs(add(x, scale(k3.x, h)), add(p, scale(k3.p, h)));
    return {
      x: x.map((v, i) => v + (h * (k1.x[i] + 2 * k2.x[i] + 2 * k3.x[i] + k4.x[i])) / 6),
      p: p.map((v, i) => v + (h * (k1.p[i] + 2 * k2.p[i] + 2 * k3.p[i] + k4.p[i])) / 6)
    };
  }
  function isco(a) {
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    return 3 + z2 - Math.sign(a) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  }
  root.GravityPhysics = {
    dot,
    length,
    scale,
    add,
    normalize,
    metric,
    flow,
    hamiltonian,
    photon,
    massiveMomentum,
    step,
    isco,
    horizon: (a) => 1 + Math.sqrt(1 - a * a)
  };
  if (typeof module !== 'undefined') module.exports = root.GravityPhysics;
})(globalThis);
