/* Landfall physics engine: Sun and Earth geometry from any lunar site, terrain horizons
   from NASA LOLA elevation data, and basic physics for every planet.
   Uses astronomy-engine (global `Astronomy`) for planetary positions and IAU rotation models. */
((root) => {
  const A = root.Astronomy;
  const DEG = Math.PI / 180;
  const AU_KM = 149597870.7;
  const C_KMS = 299792.458;
  const R_MOON_M = 1737400;
  const SUN_RADIUS_KM = 695700;

  /* ---------- small vector helpers ---------- */
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => {
    const n = norm(a);
    return [a[0] / n, a[1] / n, a[2] / n];
  };
  const mulM = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];

  /* Rotation from J2000 equatorial (EQJ) to a body's fixed frame, IAU convention:
     M = Rz(W) * Rx(90 - dec) * Rz(90 + ra). */
  function eqjToFixed(body, time) {
    const ax = A.RotationAxis(body, time);
    const a = (90 + ax.ra * 15) * DEG,
      d = (90 - ax.dec) * DEG,
      w = ax.spin * DEG;
    const ca = Math.cos(a),
      sa = Math.sin(a),
      cd = Math.cos(d),
      sd = Math.sin(d),
      cw = Math.cos(w),
      sw = Math.sin(w);
    // Rz(a)
    const A1 = [ca, sa, 0, -sa, ca, 0, 0, 0, 1];
    // Rx(d)
    const B1 = [1, 0, 0, 0, cd, sd, 0, -sd, cd];
    // Rz(w)
    const C1 = [cw, sw, 0, -sw, cw, 0, 0, 0, 1];
    return matMul(C1, matMul(B1, A1));
  }
  function matMul(P, Q) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = P[i * 3] * Q[j] + P[i * 3 + 1] * Q[3 + j] + P[i * 3 + 2] * Q[6 + j];
      }
    return r;
  }
  const transpose = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

  /* Sun and Earth seen from the Moon's centre, in Moon-fixed axes (km). */
  function moonSunEarth(date) {
    const t = A.MakeTime(date);
    const gm = A.GeoMoon(t); // Earth -> Moon, AU, EQJ
    const eh = A.HelioVector(A.Body.Earth, t); // Sun -> Earth, AU, EQJ
    const M = eqjToFixed(A.Body.Moon, t);
    const sun = mulM(M, [-(eh.x + gm.x) * AU_KM, -(eh.y + gm.y) * AU_KM, -(eh.z + gm.z) * AU_KM]);
    const earth = mulM(M, [-gm.x * AU_KM, -gm.y * AU_KM, -gm.z * AU_KM]);
    return { sun, earth };
  }

  /* Time series of Sun/Earth vectors (Moon-fixed, km) from start for `days`, every `stepH` hours. */
  function moonSeries(startDate, days, stepH) {
    const n = Math.floor((days * 24) / stepH) + 1;
    const sun = new Float64Array(n * 3),
      earth = new Float64Array(n * 3),
      t = new Float64Array(n);
    const t0 = startDate.getTime();
    for (let i = 0; i < n; i++) {
      const ms = t0 + i * stepH * 3600e3;
      const g = moonSunEarth(new Date(ms));
      sun.set(g.sun, i * 3);
      earth.set(g.earth, i * 3);
      t[i] = ms;
    }
    return { n, stepH, t0, t, sun, earth };
  }

  /* Local frame at a lunar site (lat/lon in degrees, height in metres above the 1737.4 km sphere). */
  function siteFrame(latDeg, lonDeg, hM) {
    const la = latDeg * DEG,
      lo = lonDeg * DEG;
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const east = [-Math.sin(lo), Math.cos(lo), 0];
    const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    const rKm = (R_MOON_M + (hM || 0)) / 1000;
    return { lat: latDeg, lon: lonDeg, up, east, north, pos: [up[0] * rKm, up[1] * rKm, up[2] * rKm] };
  }
  function azEl(v, f) {
    const u = unit(v);
    const el = Math.asin(Math.max(-1, Math.min(1, dot(u, f.up)))) / DEG;
    let az = Math.atan2(dot(u, f.east), dot(u, f.north)) / DEG;
    if (az < 0) az += 360;
    return { az, el };
  }

  /* ---------- polar stereographic DEM (LOLA LDEM_75S_240M crop, 1200 m) ---------- */
  function makeDem(int16, n, pixM, scale) {
    const h = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) h[i] = int16[i] * scale;
    const half = (n - 1) / 2;
    const dem = {
      n,
      pixM,
      h,
      half,
      halfExtentM: half * pixM,
      // metres in the polar plane -> fractional line/sample
      heightAt(x, y) {
        const s = x / pixM + half,
          l = half - y / pixM;
        if (s < 0 || l < 0 || s > n - 1 || l > n - 1) return NaN;
        const s0 = Math.floor(s),
          l0 = Math.floor(l);
        const s1 = Math.min(s0 + 1, n - 1),
          l1 = Math.min(l0 + 1, n - 1);
        const fs = s - s0,
          fl = l - l0;
        const a = h[l0 * n + s0],
          b = h[l0 * n + s1],
          c = h[l1 * n + s0],
          d = h[l1 * n + s1];
        return (a * (1 - fs) + b * fs) * (1 - fl) + (c * (1 - fs) + d * fs) * fl;
      },
    };
    return dem;
  }
  function latLonToXY(latDeg, lonDeg) {
    const rho = 2 * R_MOON_M * Math.tan(Math.PI / 4 + (latDeg * DEG) / 2);
    return { x: rho * Math.sin(lonDeg * DEG), y: rho * Math.cos(lonDeg * DEG) };
  }
  function xyToLatLon(x, y) {
    const rho = Math.hypot(x, y);
    let lon = Math.atan2(x, y) / DEG;
    if (lon < 0) lon += 360;
    return { lat: (2 * Math.atan(rho / (2 * R_MOON_M)) - Math.PI / 2) / DEG, lon };
  }

  /* Horizon elevation (degrees) for 360 grid bearings, from terrain, with lunar curvature.
     Grid bearing phi relates to local azimuth A by phi = lon + A (south polar stereographic). */
  function horizonMask(dem, x0, y0, opts) {
    const o = Object.assign({ nAz: 360, obsHeightM: 2, maxDistM: 320000, nearM: 2 * dem.pixM }, opts || {});
    const h0 = dem.heightAt(x0, y0);
    const r0 = R_MOON_M + h0 + o.obsHeightM;
    const out = new Float32Array(o.nAz);
    for (let i = 0; i < o.nAz; i++) {
      const phi = (i * 2 * Math.PI) / o.nAz,
        sx = Math.sin(phi),
        sy = Math.cos(phi);
      let best = -Math.PI / 2,
        s = o.nearM;
      while (s <= o.maxDistM) {
        const ht = dem.heightAt(x0 + s * sx, y0 + s * sy);
        if (ht !== ht) break; // NaN: left the map
        const th = s / R_MOON_M,
          rt = R_MOON_M + ht;
        const el = Math.atan2(rt * Math.cos(th) - r0, rt * Math.sin(th));
        if (el > best) best = el;
        s += s < 60000 ? dem.pixM / 2 : dem.pixM;
      }
      out[i] = best / DEG;
    }
    return { mask: out, h0 };
  }
  function maskAt(mask, phiDeg) {
    const n = mask.length,
      p = ((((phiDeg % 360) + 360) % 360) * n) / 360;
    const i0 = Math.floor(p) % n,
      i1 = (i0 + 1) % n,
      f = p - Math.floor(p);
    return mask[i0] * (1 - f) + mask[i1] * f;
  }
  /* Fraction of the solar disk above a horizon: d = sun centre elevation minus horizon, r = disk radius. */
  function diskFraction(d, r) {
    if (d >= r) return 1;
    if (d <= -r) return 0;
    const c = -d / r; // horizon line position in units of r
    return (Math.acos(c) - c * Math.sqrt(1 - c * c)) / Math.PI;
  }

  /* Slope (degrees) at x,y from the DEM over one pixel baseline. */
  function slopeAt(dem, x, y) {
    const d = dem.pixM;
    const dzdx = (dem.heightAt(x + d, y) - dem.heightAt(x - d, y)) / (2 * d);
    const dzdy = (dem.heightAt(x, y + d) - dem.heightAt(x, y - d)) / (2 * d);
    return Math.atan(Math.hypot(dzdx, dzdy)) / DEG;
  }

  /* Full site analysis over a precomputed series. */
  function analyzeSite(dem, series, lat, lon, opts) {
    const o = Object.assign({ obsHeightM: 2, stayHours: 156, startIndex: 0 }, opts || {});
    const p = latLonToXY(lat, lon);
    const hz = horizonMask(dem, p.x, p.y, { obsHeightM: o.obsHeightM });
    const f = siteFrame(lat, lon, hz.h0 + o.obsHeightM);
    const n = series.n;
    const sunFrac = new Float32Array(n),
      earthUp = new Uint8Array(n);
    const sunAz = new Float32Array(n),
      sunEl = new Float32Array(n),
      earthAz = new Float32Array(n),
      earthEl = new Float32Array(n);
    let earthDist = 0;
    for (let i = 0; i < n; i++) {
      const s = [series.sun[i * 3], series.sun[i * 3 + 1], series.sun[i * 3 + 2]];
      const sd = norm(s);
      const ae = azEl(s, f);
      const rSun = Math.asin(SUN_RADIUS_KM / sd) / DEG;
      sunAz[i] = ae.az;
      sunEl[i] = ae.el;
      sunFrac[i] = diskFraction(ae.el - maskAt(hz.mask, lon + ae.az), rSun);
      const ev = [
        series.earth[i * 3] - f.pos[0],
        series.earth[i * 3 + 1] - f.pos[1],
        series.earth[i * 3 + 2] - f.pos[2],
      ];
      const ee = azEl(ev, f);
      earthAz[i] = ee.az;
      earthEl[i] = ee.el;
      earthUp[i] = ee.el > maskAt(hz.mask, lon + ee.az) ? 1 : 0;
      if (i === o.startIndex) earthDist = norm(ev);
    }
    const stepH = series.stepH,
      i0 = o.startIndex;
    const stats = summarize(sunFrac, earthUp, i0, n, stepH, o.stayHours);
    return Object.assign(
      {
        lat,
        lon,
        x: p.x,
        y: p.y,
        elevationM: hz.h0,
        slopeDeg: slopeAt(dem, p.x, p.y),
        horizon: hz.mask,
        sunFrac,
        earthUp,
        sunAz,
        sunEl,
        earthAz,
        earthEl,
        signalDelayS: earthDist / C_KMS,
        gravity: 1.62,
        obsHeightM: o.obsHeightM,
      },
      stats,
    );
  }

  function runs(arr, test, i0, i1) {
    let best = 0,
      cur = 0;
    for (let i = i0; i < i1; i++) {
      if (test(arr[i])) {
        cur++;
        if (cur > best) best = cur;
      } else cur = 0;
    }
    return best;
  }
  function summarize(sunFrac, earthUp, i0, n, stepH, stayHours) {
    const stayN = Math.round(stayHours / stepH);
    const winEnd = Math.max(i0 + 1, n - stayN); // window over which landing days are judged
    let sunSum = 0,
      litCount = 0,
      earthCount = 0;
    const iEnd = Math.min(n, i0 + Math.round((30 * 24) / stepH));
    for (let i = i0; i < iEnd; i++) {
      sunSum += sunFrac[i];
      if (sunFrac[i] >= 0.5) litCount++;
      earthCount += earthUp[i];
    }
    const m = iEnd - i0;
    const lit = (v) => v >= 0.5;
    const res = {
      sunPct: (100 * sunSum) / m,
      sunHalfPct: (100 * litCount) / m,
      earthPct: (100 * earthCount) / m,
      longestSunH: runs(sunFrac, lit, i0, iEnd) * stepH,
      longestDarkH: runs(sunFrac, (v) => v < 0.5, i0, iEnd) * stepH,
      longestEarthH: runs(earthUp, (v) => v === 1, i0, iEnd) * stepH,
      longestNoEarthH: runs(earthUp, (v) => v === 0, i0, iEnd) * stepH,
    };
    // next change of state from the start
    const litNow = lit(sunFrac[i0]);
    let k = i0;
    while (k < n && lit(sunFrac[k]) === litNow) k++;
    res.sunNow = litNow;
    res.sunChangeH = k < n ? (k - i0) * stepH : null;
    const eNow = earthUp[i0] === 1;
    k = i0;
    while (k < n && (earthUp[k] === 1) === eNow) k++;
    res.earthNow = eNow;
    res.earthChangeH = k < n ? (k - i0) * stepH : null;
    // 6.5-day stay test from the start, and the first day in the window that passes
    const stayOk = (s) => {
      let sunOk = true,
        earthOk = true,
        sunCnt = 0,
        earthCnt = 0;
      for (let i = s; i <= s + stayN && i < n; i++) {
        if (!lit(sunFrac[i])) sunOk = false;
        else sunCnt++;
        if (earthUp[i] !== 1) earthOk = false;
        else earthCnt++;
      }
      return { sunOk, earthOk, sunShare: sunCnt / (stayN + 1), earthShare: earthCnt / (stayN + 1) };
    };
    res.stay = stayOk(i0);
    res.firstGoodStartH = null;
    for (let s = i0; s < winEnd; s += Math.max(1, Math.round(6 / stepH))) {
      const r = stayOk(s);
      if (r.sunOk && r.earthOk) {
        res.firstGoodStartH = (s - i0) * stepH;
        break;
      }
    }
    return res;
  }

  /* ---------- planets ---------- */
  const BODIES = {
    Sun: {
      r: 695700,
      gm: 1.32712440018e11,
      dayH: 609.12,
      kind: 'star',
      temp: '5,500 °C at the visible surface',
      surface: 'none (plasma)',
    },
    Mercury: {
      r: 2439.7,
      gm: 22031.9,
      dayH: 1407.5,
      solarDayH: 4222.6,
      kind: 'rocky',
      temp: '−173 to 427 °C',
      surface: 'solid, no air',
    },
    Venus: {
      r: 6051.8,
      gm: 324858.6,
      dayH: -5832.6,
      solarDayH: 2802.0,
      kind: 'rocky',
      temp: '464 °C, 92 bar of CO2',
      surface: 'solid, crushing air',
    },
    Earth: {
      r: 6371.0,
      gm: 398600.4,
      dayH: 23.934,
      solarDayH: 24,
      kind: 'rocky',
      temp: 'about 15 °C average',
      surface: 'solid and ocean, 1 bar',
    },
    Moon: {
      r: 1737.4,
      gm: 4902.8,
      dayH: 655.7,
      solarDayH: 708.7,
      kind: 'rocky',
      temp: '−173 to 127 °C (equator); below −230 °C in polar shadow',
      surface: 'solid, no air',
    },
    Mars: {
      r: 3389.5,
      gm: 42828.4,
      dayH: 24.623,
      solarDayH: 24.66,
      kind: 'rocky',
      temp: 'about −63 °C average, 0.006 bar CO2',
      surface: 'solid, thin air',
    },
    Jupiter: {
      r: 69911,
      gm: 126686534,
      dayH: 9.925,
      kind: 'giant',
      temp: 'about −110 °C at the cloud tops',
      surface: 'no solid surface',
    },
    Saturn: {
      r: 58232,
      gm: 37931187,
      dayH: 10.55,
      kind: 'giant',
      temp: 'about −140 °C at the cloud tops',
      surface: 'no solid surface',
    },
    Uranus: {
      r: 25362,
      gm: 5793939,
      dayH: -17.24,
      kind: 'giant',
      temp: 'about −195 °C at the cloud tops',
      surface: 'no solid surface',
    },
    Neptune: {
      r: 24622,
      gm: 6836529,
      dayH: 16.11,
      kind: 'giant',
      temp: 'about −200 °C at the cloud tops',
      surface: 'no solid surface',
    },
  };
  function bodyFacts(name, date) {
    const b = BODIES[name];
    const t = A.MakeTime(date);
    const g = (b.gm / (b.r * b.r)) * 1000; // m/s^2
    const vesc = Math.sqrt((2 * b.gm) / b.r);
    let sunDistAU = null,
      earthDistKm = null;
    if (name !== 'Sun') {
      const hv =
        name === 'Moon'
          ? (() => {
              const e = A.HelioVector(A.Body.Earth, t),
                m = A.GeoMoon(t);
              return { x: e.x + m.x, y: e.y + m.y, z: e.z + m.z };
            })()
          : A.HelioVector(A.Body[name], t);
      sunDistAU = Math.hypot(hv.x, hv.y, hv.z);
      if (name !== 'Earth') {
        const e = A.HelioVector(A.Body.Earth, t);
        earthDistKm = Math.hypot(hv.x - e.x, hv.y - e.y, hv.z - e.z) * AU_KM;
      }
    } else {
      const e = A.HelioVector(A.Body.Earth, t);
      earthDistKm = Math.hypot(e.x, e.y, e.z) * AU_KM;
    }
    return {
      name,
      kind: b.kind,
      radiusKm: b.r,
      gravity: g,
      escapeKms: vesc,
      dayH: b.dayH,
      solarDayH: b.solarDayH || null,
      temp: b.temp,
      surface: b.surface,
      sunDistAU,
      solarFlux: sunDistAU ? 1361 / (sunDistAU * sunDistAU) : null,
      earthDistKm,
      lightTimeS: earthDistKm ? earthDistKm / C_KMS : null,
    };
  }
  /* Sun (and Earth) above the local horizon at a spot on any body, ignoring terrain. */
  function spotSky(name, latDeg, lonDeg, date) {
    const t = A.MakeTime(date);
    const body = A.Body[name];
    const M = eqjToFixed(body, t);
    let bodyHelio;
    if (name === 'Moon') {
      const e = A.HelioVector(A.Body.Earth, t),
        m = A.GeoMoon(t);
      bodyHelio = [e.x + m.x, e.y + m.y, e.z + m.z];
    } else {
      const v = A.HelioVector(body, t);
      bodyHelio = [v.x, v.y, v.z];
    }
    const e = A.HelioVector(A.Body.Earth, t);
    const sunV = mulM(M, [-bodyHelio[0], -bodyHelio[1], -bodyHelio[2]]);
    const f = siteFrame(latDeg, lonDeg, 0);
    const sun = azEl(sunV, f);
    let earth = null;
    if (name !== 'Earth') {
      const ev = mulM(M, [e.x - bodyHelio[0], e.y - bodyHelio[1], e.z - bodyHelio[2]]);
      earth = azEl(ev, f);
    }
    return { sun, earth };
  }
  /* Sun direction in a body's fixed frame (unit), for globe lighting. */
  function sunDirFixed(name, date) {
    const t = A.MakeTime(date);
    const M = eqjToFixed(A.Body[name], t);
    let bh;
    if (name === 'Moon') {
      const e = A.HelioVector(A.Body.Earth, t),
        m = A.GeoMoon(t);
      bh = [e.x + m.x, e.y + m.y, e.z + m.z];
    } else {
      const v = A.HelioVector(A.Body[name], t);
      bh = [v.x, v.y, v.z];
    }
    return unit(mulM(M, [-bh[0], -bh[1], -bh[2]]));
  }

  /* ---------- Earth -> Mars transfer (Lambert, universal variables, prograde, 0 revolutions) ---------- */
  const MU_SUN = 1.32712440018e11; // km^3/s^2
  function stumpC(z) {
    return z > 1e-6 ? (1 - Math.cos(Math.sqrt(z))) / z : z < -1e-6 ? (Math.cosh(Math.sqrt(-z)) - 1) / -z : 0.5;
  }
  function stumpS(z) {
    if (z > 1e-6) {
      const s = Math.sqrt(z);
      return (s - Math.sin(s)) / (s * s * s);
    }
    if (z < -1e-6) {
      const s = Math.sqrt(-z);
      return (Math.sinh(s) - s) / (s * s * s);
    }
    return 1 / 6;
  }
  function lambert(r1, r2, tof, mu) {
    const R1 = norm(r1),
      R2 = norm(r2);
    const cr = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    let dth = Math.acos(Math.max(-1, Math.min(1, dot(r1, r2) / (R1 * R2))));
    if (cr[2] < 0) dth = 2 * Math.PI - dth; // prograde
    const Acoef = Math.sin(dth) * Math.sqrt((R1 * R2) / (1 - Math.cos(dth)));
    const y = (z) => R1 + R2 + (Acoef * (z * stumpS(z) - 1)) / Math.sqrt(stumpC(z));
    const F = (z) => {
      const yy = y(z);
      if (yy < 0) return NaN;
      return (yy / stumpC(z)) ** 1.5 * stumpS(z) + Acoef * Math.sqrt(yy) - Math.sqrt(mu) * tof;
    };
    // bracket z then bisect (robust)
    let lo = -4 * Math.PI * Math.PI,
      hi = 4 * Math.PI * Math.PI - 1e-6;
    let flo = F(lo);
    let tries = 0;
    while ((flo !== flo || flo > 0) && tries < 200) {
      lo += 0.1;
      flo = F(lo);
      tries++;
    }
    const fhi = F(hi);
    if (!(flo < 0 && fhi > 0)) return null;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2,
        fm = F(mid);
      if (fm !== fm) {
        lo = mid;
        continue;
      }
      if (fm > 0) hi = mid;
      else lo = mid;
    }
    const z = (lo + hi) / 2,
      yy = y(z);
    const f = 1 - yy / R1,
      g = Acoef * Math.sqrt(yy / mu),
      gd = 1 - yy / R2;
    const v1 = [(r2[0] - f * r1[0]) / g, (r2[1] - f * r1[1]) / g, (r2[2] - f * r1[2]) / g];
    const v2 = [(gd * r2[0] - r1[0]) / g, (gd * r2[1] - r1[1]) / g, (gd * r2[2] - r1[2]) / g];
    return { v1, v2 };
  }
  const KMS_PER_AUD = AU_KM / 86400;
  function stateKm(body, date) {
    const s = A.HelioState(body, A.MakeTime(date));
    return {
      r: [s.x * AU_KM, s.y * AU_KM, s.z * AU_KM],
      v: [s.vx * KMS_PER_AUD, s.vy * KMS_PER_AUD, s.vz * KMS_PER_AUD],
    };
  }
  /* Porkchop grid: departure from `start` for `spanDays`, time of flight between tofMin and tofMax. */
  function marsPorkchop(start, spanDays, depStep, tofMin, tofMax, tofStep) {
    const deps = [],
      tofs = [];
    for (let d = 0; d <= spanDays; d += depStep) deps.push(d);
    for (let t = tofMin; t <= tofMax; t += tofStep) tofs.push(t);
    const c3 = new Float32Array(deps.length * tofs.length).fill(NaN);
    const vinf = new Float32Array(deps.length * tofs.length).fill(NaN);
    let best = null;
    const t0 = start.getTime();
    for (let i = 0; i < deps.length; i++) {
      const dd = new Date(t0 + deps[i] * 864e5);
      const E = stateKm(A.Body.Earth, dd);
      for (let j = 0; j < tofs.length; j++) {
        const ad = new Date(dd.getTime() + tofs[j] * 864e5);
        const M = stateKm(A.Body.Mars, ad);
        const sol = lambert(E.r, M.r, tofs[j] * 86400, MU_SUN);
        if (!sol) continue;
        const dv1 = [sol.v1[0] - E.v[0], sol.v1[1] - E.v[1], sol.v1[2] - E.v[2]];
        const dv2 = [sol.v2[0] - M.v[0], sol.v2[1] - M.v[1], sol.v2[2] - M.v[2]];
        const C3 = dot(dv1, dv1),
          vi = norm(dv2);
        c3[i * tofs.length + j] = C3;
        vinf[i * tofs.length + j] = vi;
        if (!best || C3 < best.c3) best = { c3: C3, vinfArr: vi, dep: dd, arr: ad, tof: tofs[j] };
      }
    }
    return { deps, tofs, c3, vinf, best, start };
  }

  root.LandfallEngine = {
    DEG,
    AU_KM,
    R_MOON_M,
    BODIES,
    eqjToFixed,
    moonSunEarth,
    moonSeries,
    siteFrame,
    azEl,
    makeDem,
    latLonToXY,
    xyToLatLon,
    horizonMask,
    maskAt,
    diskFraction,
    slopeAt,
    analyzeSite,
    summarize,
    bodyFacts,
    spotSky,
    sunDirFixed,
    lambert,
    marsPorkchop,
    stateKm,
    transpose,
    mulM,
    unit,
    dot,
    norm,
  };
})(typeof window !== 'undefined' ? window : globalThis);
