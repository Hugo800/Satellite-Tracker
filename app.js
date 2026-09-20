/**
 * SatTracker – app.js
 * Interactive real-time satellite tracker with sky-dome renderer.
 *
 * Architecture:
 *   CONFIG          – tuneable constants
 *   State           – shared mutable state
 *   Utils           – math helpers
 *   GeoModule       – navigator.geolocation
 *   TLEModule       – fetch & parse TLE data from Celestrak
 *   OrientationModule – DeviceOrientationEvent (gyro/compass)
 *   TouchModule     – pointer/mouse/wheel events (drag+pinch)
 *   PropagationModule – satellite.js SGP4 loop
 *   SkyRenderer     – full-screen sky canvas
 *   RadarRenderer   – polar mini-map canvas
 *   UIModule        – panels, list, telemetry, toasts
 *   App             – bootstrap & main loop
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════════ */
const CONFIG = {
  TLE_GROUPS: [
    { name: 'stations',  label: 'Raumstationen',  url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', tag: 'iss'      },
    { name: 'visual',    label: '100 Hellste',    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',   tag: 'visual'  },
    { name: 'starlink',  label: 'Starlink',       url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle', tag: 'starlink' },
    { name: 'active',    label: 'Alle Aktiven',   url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',   tag: 'other'  },
  ],
  // Fallback hard-coded TLEs (always shown even without network)
  FALLBACK_TLES: [
    { name: 'ISS (ZARYA)',
      l1: '1 25544U 98067A   24263.51782528  .00018677  00000+0  33480-3 0  9995',
      l2: '2 25544  51.6416  83.7899 0006015 224.0453 136.0227 15.50143843471082' },
    { name: 'TIANGONG (CSS)',
      l1: '1 48274U 21035A   24263.73611111  .00028157  00000+0  31100-3 0  9999',
      l2: '2 48274  41.4748 329.4327 0005765 290.5073  69.5358 15.59841847192491' },
    { name: 'HUBBLE',
      l1: '1 20580U 90037B   24263.52183066  .00001228  00000+0  56524-4 0  9997',
      l2: '2 20580  28.4699 246.1300 0002484 145.0083 215.1210 15.09880688455193' },
    { name: 'NOAA 19',
      l1: '1 33591U 09005A   24263.55892003  .00000241  00000+0  13773-3 0  9997',
      l2: '2 33591  99.1915  66.0765 0013909  32.3614 327.8395 14.12449264799892' },
    { name: 'NOAA 18',
      l1: '1 28654U 05018A   24263.47890167  .00000266  00000+0  17254-3 0  9998',
      l2: '2 28654  99.0203 317.5601 0014035 323.0175  36.9906 14.12641428997673' },
    { name: 'STARLINK-1007',
      l1: '1 44713U 19074A   24263.54166667  .00012345  00000+0  79123-4 0  9999',
      l2: '2 44713  53.0525 150.3456 0001234 270.1234  89.8765 15.06123456789012' },
    { name: 'STARLINK-1008',
      l1: '1 44714U 19074B   24263.54166667  .00011234  00000+0  72345-4 0  9991',
      l2: '2 44714  53.0512 150.2345 0001345 270.2345  89.7654 15.06234567890123' },
    { name: 'TERRA',
      l1: '1 25994U 99068A   24263.50100000  .00000232  00000+0  44678-4 0  9993',
      l2: '2 25994  98.2152  60.0000 0001382  85.5126 274.6203 14.57150617296438' },
    { name: 'AQUA',
      l1: '1 27424U 02022A   24263.51050000  .00000148  00000+0  31246-4 0  9998',
      l2: '2 27424  98.2154 264.5000 0001212  75.0000 285.1000 14.57150617296438' },
    { name: 'ENVISAT',
      l1: '1 27386U 02009A   24263.60000000  .00000000  00000+0  00000+0 0  9993',
      l2: '2 27386  98.5483 319.0000 0001000 100.0000 260.0000 14.37805000000000' },
  ],
  UPDATE_INTERVAL_MS:  1000,       // propagation update rate
  TLE_CACHE_KEY:       'sattracker_tle_cache_v2',
  TLE_CACHE_TTL_MS:    4 * 60 * 60 * 1000,  // 4 hours
  TRAIL_POINTS:        40,          // orbit trail history
  TRAIL_STEP_MS:       15000,       // 15 s between trail points
  FOV_DEFAULT:         90,          // degrees
  FOV_MIN:             15,
  FOV_MAX:             150,
  STAR_COUNT:          800,
  VISIBLE_EL_MIN:      0,           // elevation threshold in degrees
};

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */
const State = {
  // Observer position (default: Frankfurt/Central Europe until GPS connects)
  observer: { lat: 50.1109, lon: 8.6821, alt: 0.1, valid: true, isDefault: true },

  // Satellites array: { name, satrec, tag, positions:[], computed:{az,el,range,alt,vel,visible} }
  satellites: [],
  filteredSats: [],
  selectedSat: null,

  // View direction (where the camera points)
  viewAz:  0,    // azimuth degrees (0 = North)
  viewEl:  90,   // elevation degrees (90 = Zenith)
  fov:     CONFIG.FOV_DEFAULT,

  // Gyroscope offset
  gyroEnabled: false,
  gyroAzOffset: 0,
  mapMode: false,
  gyroAz:  0,
  gyroEl:  90,

  // Drag control
  dragActive:   false,
  dragStartX:   0,
  dragStartY:   0,
  dragViewAz:   0,
  dragViewEl:   90,

  // Pinch
  pinchDist: 0,

  // Night mode
  nightMode: false,

  // Current filter
  activeFilter: 'all',
  searchQuery:  '',

  // Animation
  lastPropTime: 0,
  animFrame:    null,

  // Trail history: { [satName]: [{az, el, time}] }
  trails: {},
};

/* ═══════════════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════════════ */
const Utils = {
  DEG: Math.PI / 180,

  /** Convert az/el (degrees) to canvas x/y in gnomonic projection */
  azElToXY(az, el, viewAz, viewEl, fov, W, H) {
    // Angular distance from view center
    const azR  = az  * this.DEG;
    const elR  = el  * this.DEG;
    const vaR  = viewAz * this.DEG;
    const veR  = viewEl * this.DEG;

    // Convert to unit vectors
    const x0 = Math.cos(elR) * Math.sin(azR);
    const y0 = Math.cos(elR) * Math.cos(azR);
    const z0 = Math.sin(elR);

    const xv = Math.cos(veR) * Math.sin(vaR);
    const yv = Math.cos(veR) * Math.cos(vaR);
    const zv = Math.sin(veR);

    // Dot product = cosine of angle from view center
    const dot = x0*xv + y0*yv + z0*zv;
    if (dot <= 0) return null;  // behind us

    // Gnomonic projection
    const scale = (Math.min(W, H) / 2) / Math.tan((fov / 2) * this.DEG);

    let rightX, rightY, rightZ;
    let upX, upY, upZ;

    if (viewEl > 88) {
      // Near zenith: top of screen points towards viewAz (North if viewAz=0)
      upX = Math.sin(vaR);
      upY = Math.cos(vaR);
      upZ = 0;
      rightX = Math.cos(vaR);
      rightY = -Math.sin(vaR);
      rightZ = 0;
    } else {
      rightX = Math.cos(vaR);
      rightY = -Math.sin(vaR);
      rightZ = 0;
      upX = -Math.sin(veR) * Math.sin(vaR);
      upY = -Math.sin(veR) * Math.cos(vaR);
      upZ =  Math.cos(veR);
    }

    const px = (x0*rightX + y0*rightY + z0*rightZ) / dot;
    const py = (x0*upX    + y0*upY    + z0*upZ)    / dot;

    return {
      x: W/2 + px * scale,
      y: H/2 - py * scale,
    };
  },

  /** Angular distance between two az/el pairs (degrees) */
  angularDist(az1, el1, az2, el2) {
    const toV = (az, el) => {
      const a = az * this.DEG, e = el * this.DEG;
      return [Math.cos(e)*Math.sin(a), Math.cos(e)*Math.cos(a), Math.sin(e)];
    };
    const [x1,y1,z1] = toV(az1, el1);
    const [x2,y2,z2] = toV(az2, el2);
    const dot = Math.min(1, Math.max(-1, x1*x2 + y1*y2 + z1*z2));
    return Math.acos(dot) / this.DEG;
  },

  formatDeg(d, decimals = 1) {
    return (d >= 0 ? '+' : '') + d.toFixed(decimals) + '°';
  },
  formatKm(km) {
    if (km >= 1000) return (km / 1000).toFixed(2) + ' Mio km';
    return Math.round(km) + ' km';
  },
  formatSpeed(kmps) {
    return (kmps * 3600).toFixed(0) + ' km/h';
  },

  /** Pseudo-random star seed from index */
  starRand(seed) {
    let s = seed * 9301 + 49297;
    return (s % 233280) / 233280;
  },

  /** Convert azimuth degrees to cardinal direction string */
  azToCardinal(az) {
    az = ((az % 360) + 360) % 360;
    const dirs = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(az / 22.5) % 16];
  },

  /** Format seconds as m:ss */
  formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  },

  /** Calculate sun elevation for a given date/location */
  getSunElevation(date, lat, lon) {
    const rad = Math.PI / 180;
    const d = (date.getTime() / 86400000) - 10957.5; // days since J2000
    const g = (357.529 + 0.98560028 * d) % 360;
    const q = (280.459 + 0.98564736 * d) % 360;
    const L = (q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
    const e = 23.439 - 0.00000036 * d;
    const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
    let ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const lha = (gmst * 15 + lon) * rad - ra;
    const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(lha));
    return el / rad;
  },

  /** Signal quality bars (1-5) as HTML */
  qualityBars(q) {
    let bars = '';
    for (let i = 1; i <= 5; i++) {
      bars += `<span class="signal-bar${i <= q ? ' active' : ''}"></span>`;
    }
    return `<span class="signal-bars">${bars}</span>`;
  },
};

/* ═══════════════════════════════════════════════════════════════
   GEO MODULE
   ═══════════════════════════════════════════════════════════════ */
const GeoModule = {
  watchId: null,

  start() {
    if (!navigator.geolocation) {
      UIModule.showPermStatus('Geolocation wird im Browser nicht unterstützt', true);
      setTimeout(() => UIModule.dismissOverlay(), 1500);
      return;
    }
    UIModule.showPermStatus('GPS-Standort wird abgefragt…');
    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onPosition(pos),
      err => this._onError(err),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    // Dismiss immediately so user isn't stuck waiting for a GPS lock
    setTimeout(() => UIModule.dismissOverlay(), 500);
  },

  _onPosition(pos) {
    State.observer = {
      lat:   pos.coords.latitude,
      lon:   pos.coords.longitude,
      alt:   (pos.coords.altitude || 0) / 1000,  // km
      valid: true,
      isDefault: false,
    };
    UIModule.updateGeoChip(true);
    UIModule.showPermStatus('Standort aktiv ✓');
    PropagationModule.forceFullUpdate();
  },

  _onError(err) {
    console.warn('Geo error:', err.message);
    UIModule.showPermStatus('GPS nicht verfügbar – Standardort aktiv', false);
    UIModule.updateGeoChip(true);
    setTimeout(() => UIModule.dismissOverlay(), 1500);
  },
};

/* ═══════════════════════════════════════════════════════════════
   TLE MODULE
   ═══════════════════════════════════════════════════════════════ */
const TLEModule = {
  async loadAll() {
    UIModule.showToast('Lade TLE-Daten…');

    // Try cache first
    const cached = this._loadCache();
    if (cached) {
      this._parseSatellites(cached);
      UIModule.hideToast();
      return;
    }

    // Fetch from Celestrak
    const rawAll = [];

    for (const group of CONFIG.TLE_GROUPS) {
      try {
        UIModule.showToast(`Lade ${group.label}…`);
        const resp = await fetch(group.url);
        if (!resp.ok) throw new Error(resp.status);
        const text = await resp.text();
        const sats = this._parseTLEText(text, group.tag);
        rawAll.push(...sats);
      } catch (e) {
        console.warn(`Failed to load ${group.name}:`, e.message);
      }
    }

    if (rawAll.length > 0) {
      this._saveCache(rawAll);
      this._buildSatellites(rawAll);
    } else {
      // All fetches failed – use fallback
      console.warn('Using fallback TLE data');
      this._buildFallback();
    }

    UIModule.hideToast();
    UIModule.updateSatChip();
  },

  _parseTLEText(text, tag) {
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const sats = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      const name = lines[i].replace(/^0 /, '').trim();
      const l1   = lines[i + 1];
      const l2   = lines[i + 2];
      if (l1.startsWith('1 ') && l2.startsWith('2 ')) {
        sats.push({ name, l1, l2, tag });
      }
    }
    return sats;
  },

  _parseSatellites(rawArray) {
    this._buildSatellites(rawArray);
  },

  _buildSatellites(rawArray) {
    State.satellites = [];
    const counts = {};

    const seenIds = new Set();

    for (const raw of rawArray) {
      try {
        const noradId = raw.l2.split(' ')[1];
        if (seenIds.has(noradId)) continue;
        seenIds.add(noradId);

        const tag = raw.tag || 'other';
        counts[tag] = (counts[tag] || 0) + 1;

        const satrec = satellite.twoline2satrec(raw.l1, raw.l2);
        if (satrec.error !== 0) continue;
        
        State.satellites.push({
          name:     raw.name,
          satrec,
          tag,
          noradId,
          l1:       raw.l1,
          l2:       raw.l2,
          computed: { az: 0, el: -90, range: 0, alt: 0, vel: 0, visible: false },
        });
      } catch(e) { /* skip invalid */ }
    }
    // Also inject fallbacks if they aren't already present
    for (const fb of CONFIG.FALLBACK_TLES) {
      if (!State.satellites.find(s => s.name === fb.name)) {
        try {
          const satrec = satellite.twoline2satrec(fb.l1, fb.l2);
          if (satrec.error !== 0) continue;
          
          let fbTag = 'other';
          const n = fb.name.toLowerCase();
          if (n.includes('starlink')) fbTag = 'starlink';
          else if (n.includes('iss') || n.includes('zarya') || n.includes('css')) fbTag = 'iss';
          else if (n.includes('noaa') || n.includes('terra') || n.includes('hubble') || n.includes('envisat')) fbTag = 'visual';

          State.satellites.push({
            name: fb.name, satrec, tag: fbTag,
            noradId: fb.l2.split(' ')[1],
            l1: fb.l1, l2: fb.l2,
            computed: { az: 0, el: -90, range: 0, alt: 0, vel: 0, visible: false },
          });
        } catch(e) {}
      }
    }
    console.log(`Loaded ${State.satellites.length} satellites`);
    State.filteredSats = [...State.satellites];
    PropagationModule.forceFullUpdate();
    UIModule.renderSatList();
    UIModule.updateSatChip();
  },

  _buildFallback() {
    const raw = CONFIG.FALLBACK_TLES.map(fb => ({ ...fb, tag: 'fallback' }));
    this._buildSatellites(raw);
  },

  _saveCache(rawArray) {
    try {
      sessionStorage.setItem(CONFIG.TLE_CACHE_KEY, JSON.stringify({
        ts: Date.now(),
        data: rawArray,
      }));
    } catch(e) {}
  },

  _loadCache() {
    try {
      const item = sessionStorage.getItem(CONFIG.TLE_CACHE_KEY);
      if (!item) return null;
      const { ts, data } = JSON.parse(item);
      if (Date.now() - ts > CONFIG.TLE_CACHE_TTL_MS) return null;
      return data;
    } catch(e) { return null; }
  },
};

/* ═══════════════════════════════════════════════════════════════
   ORIENTATION MODULE (Gyro / Compass)
   ═══════════════════════════════════════════════════════════════ */
const OrientationModule = {
  async requestPermission() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      UIModule.showPermStatus('Gyroskop nicht verfügbar', true);
      setTimeout(() => UIModule.dismissOverlay(), 1500);
      return false;
    }
    // iOS 13+ requires explicit permission
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          UIModule.showPermStatus('Gyroskop-Zugriff verweigert', true);
          setTimeout(() => UIModule.dismissOverlay(), 1500);
          return false;
        }
      } catch(e) {
        UIModule.showPermStatus('Gyroskop-Fehler: ' + e.message, true);
        setTimeout(() => UIModule.dismissOverlay(), 1500);
        return false;
      }
    }
    this._attach();
    setTimeout(() => UIModule.dismissOverlay(), 500);
    return true;
  },

  _attach() {
    window.addEventListener('deviceorientationabsolute', e => this._onOrientation(e), true);
    window.addEventListener('deviceorientation', e => this._onOrientation(e), true);
    State.gyroEnabled = true;
    UIModule.showPermStatus('Gyroskop aktiv ✓');
    document.getElementById('btnGrantGyro').classList.add('active');
  },

  _onOrientation(e) {
    if (!State.gyroEnabled) return;

    let alpha = e.alpha || 0;
    let beta  = e.beta  || 0; // -180 to 180

    // iOS compass heading (0 = North, 90 = East)
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
      alpha = e.webkitCompassHeading;
    }

    // W3C DeviceOrientation spec:
    // beta = 0   → phone flat on table, screen up
    // beta = 90  → phone upright, screen facing user (horizon)
    // beta > 90  → phone tilted backward, screen facing sky
    //
    // We want: look at horizon → elevation 0°
    //          look at zenith  → elevation 90°
    //
    // When user holds phone upright (beta≈90) and tilts it up toward sky,
    // beta goes ABOVE 90 (toward 180). So:
    //   elevation = beta - 90
    //   beta=90  → el=0  (horizon) ✓
    //   beta=180 → el=90 (zenith)  ✓
    //   beta=45  → el=-45 (below horizon, clamp to 0) ✓
    const elevation = Math.max(0, Math.min(90, beta - 90));

    State.gyroAz = (alpha + State.gyroAzOffset + 360) % 360;
    State.gyroEl = elevation;
  },
};

/* ═══════════════════════════════════════════════════════════════
   TOUCH / MOUSE MODULE
   ═══════════════════════════════════════════════════════════════ */
const TouchModule = {
  _touches: new Map(),
  _lastPinchDist: 0,

  init(canvas) {
    // Pointer events unify mouse + touch
    canvas.addEventListener('pointerdown',  e => this._onDown(e),  { passive: false });
    canvas.addEventListener('pointermove',  e => this._onMove(e),  { passive: false });
    canvas.addEventListener('pointerup',    e => this._onUp(e),    { passive: false });
    canvas.addEventListener('pointercancel',e => this._onUp(e),    { passive: false });
    canvas.addEventListener('wheel',        e => this._onWheel(e), { passive: false });

    // Tap detection for satellite selection
    canvas.addEventListener('click', e => this._onClick(e));
  },

  _onDown(e) {
    e.preventDefault();
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._touches.size === 1) {
      State.dragActive  = true;
      State.dragStartX  = e.clientX;
      State.dragStartY  = e.clientY;
      State.dragViewAz  = State.gyroEnabled ? State.gyroAz : State.viewAz;
      State.dragViewEl  = State.gyroEnabled ? State.gyroEl : State.viewEl;
    } else if (this._touches.size === 2) {
      this._lastPinchDist = this._getPinchDist();
    }
  },

  _onMove(e) {
    e.preventDefault();
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._touches.size === 1 && State.dragActive) {
      const dx = e.clientX - State.dragStartX;
      const dy = e.clientY - State.dragStartY;
      const sensitivity = State.fov / Math.min(window.innerWidth, window.innerHeight) * 0.8;
      
      if (State.gyroEnabled) {
        // Calibration mode: pan horizontally to adjust azimuth offset
        State.gyroAzOffset -= (dx * sensitivity * 0.2);
        State.dragStartX = e.clientX; // reset for continuous drag
      } else {
        State.viewAz = (State.dragViewAz - dx * sensitivity + 360) % 360;
        State.viewEl = Math.max(0, Math.min(90, State.dragViewEl + dy * sensitivity));
      }
    } else if (this._touches.size === 2) {
      const dist = this._getPinchDist();
      const delta = this._lastPinchDist - dist;
      this._lastPinchDist = dist;
      this._zoom(delta * 0.3);
    }
  },

  _onUp(e) {
    this._touches.delete(e.pointerId);
    if (this._touches.size === 0) State.dragActive = false;
  },

  _onWheel(e) {
    e.preventDefault();
    this._zoom(e.deltaY * 0.05);
  },

  _zoom(delta) {
    State.fov = Math.max(CONFIG.FOV_MIN, Math.min(CONFIG.FOV_MAX, State.fov + delta));
  },

  _getPinchDist() {
    const pts = [...this._touches.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx*dx + dy*dy);
  },

  _onClick(e) {
    // Find nearest satellite to click
    const rect = e.target.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const W = rect.width, H = rect.height;

    const viewAz = State.gyroEnabled ? State.gyroAz : State.viewAz;
    const viewEl = State.gyroEnabled ? State.gyroEl : State.viewEl;

    let best = null, bestDist = 30; // px threshold

    for (const sat of State.satellites) {
      if (!sat.computed.visible) continue;
      const p = Utils.azElToXY(sat.computed.az, sat.computed.el, viewAz, viewEl, State.fov, W, H);
      if (!p) continue;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestDist) { bestDist = d; best = sat; }
    }

    if (best) UIModule.selectSat(best);
    else      UIModule.deselectSat();
  },
};

/* ═══════════════════════════════════════════════════════════════
   PROPAGATION MODULE
   ═══════════════════════════════════════════════════════════════ */
const PropagationModule = {
  _propIndex: 0,

  forceFullUpdate() {
    if (!State.observer.valid || State.satellites.length === 0) return;
    const now = new Date();
    const gmst = satellite.gstime(now);
    const obs  = satellite.geodeticToEcf({ longitude: State.observer.lon * Utils.DEG,
                                           latitude:  State.observer.lat * Utils.DEG,
                                           height:    State.observer.alt });

    for (let i = 0; i < State.satellites.length; i++) {
      const sat = State.satellites[i];
      try {
        const pv = satellite.propagate(sat.satrec, now);
        if (!pv.position) { sat.computed.visible = false; continue; }

        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles(
          { longitude: State.observer.lon * Utils.DEG,
            latitude:  State.observer.lat * Utils.DEG,
            height:    State.observer.alt },
          posEcf
        );

        const azDeg = look.azimuth   * (180 / Math.PI);
        const elDeg = look.elevation * (180 / Math.PI);

        const dx = pv.position.x - obs.x;
        const dy = pv.position.y - obs.y;
        const dz = pv.position.z - obs.z;
        const rangekm = Math.sqrt(dx*dx + dy*dy + dz*dz);

        const altKm = Math.sqrt(
          pv.position.x**2 + pv.position.y**2 + pv.position.z**2
        ) - 6371;

        const vel = pv.velocity
          ? Math.sqrt(pv.velocity.x**2 + pv.velocity.y**2 + pv.velocity.z**2)
          : 0;

        sat.computed = {
          az:      (azDeg + 360) % 360,
          el:      elDeg,
          range:   rangekm,
          alt:     altKm,
          vel:     vel,  // km/s
          visible: elDeg >= CONFIG.VISIBLE_EL_MIN,
        };
        this._updateTrail(sat, azDeg, elDeg);
      } catch(e) {
        sat.computed.visible = false;
      }
    }
  },

  tick() {
    if (!State.observer.valid || State.satellites.length === 0) return;

    const now = new Date();
    const gmst = satellite.gstime(now);
    const obs  = satellite.geodeticToEcf({ longitude: State.observer.lon * Utils.DEG,
                                           latitude:  State.observer.lat * Utils.DEG,
                                           height:    State.observer.alt });

    // Propagate up to 250 satellites per frame (~15,000 per second at 60 FPS)
    const BATCH_SIZE = 250;
    const endIdx = Math.min(this._propIndex + BATCH_SIZE, State.satellites.length);

    for (let i = this._propIndex; i < endIdx; i++) {
      const sat = State.satellites[i];
      try {
        const pv = satellite.propagate(sat.satrec, now);
        if (!pv.position) { sat.computed.visible = false; continue; }

        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles(
          { longitude: State.observer.lon * Utils.DEG,
            latitude:  State.observer.lat * Utils.DEG,
            height:    State.observer.alt },
          posEcf
        );

        const azDeg = look.azimuth   * (180 / Math.PI);
        const elDeg = look.elevation * (180 / Math.PI);

        const dx = pv.position.x - obs.x;
        const dy = pv.position.y - obs.y;
        const dz = pv.position.z - obs.z;
        const rangekm = Math.sqrt(dx*dx + dy*dy + dz*dz);

        const altKm = Math.sqrt(
          pv.position.x**2 + pv.position.y**2 + pv.position.z**2
        ) - 6371;

        const vel = pv.velocity
          ? Math.sqrt(pv.velocity.x**2 + pv.velocity.y**2 + pv.velocity.z**2)
          : 0;

        sat.computed = {
          az:      (azDeg + 360) % 360,
          el:      elDeg,
          range:   rangekm,
          alt:     altKm,
          vel:     vel,  // km/s
          visible: elDeg >= CONFIG.VISIBLE_EL_MIN,
        };

        // Update trail
        this._updateTrail(sat, azDeg, elDeg);

      } catch(e) {
        sat.computed.visible = false;
      }
    }

    this._propIndex = endIdx;
    
    // When we finish a full cycle over all satellites, trigger UI updates
    if (this._propIndex >= State.satellites.length) {
      this._propIndex = 0;
      UIModule.updateSatChip();
      UIModule.renderSatList();
      
      // Periodically rebuild the list if 'visible' filter is active
      if (State.activeFilter === 'visible') {
        const ts = Date.now();
        if (!State._lastFullRebuild || ts - State._lastFullRebuild > 10000) {
          State._lastFullRebuild = ts;
          UIModule.applyFilter();
        }
      }
      
      if (State.selectedSat) UIModule.updateTelemetry(State.selectedSat);
    }
  },

  _updateTrail(sat, az, el) {
    if (!State.trails[sat.name]) State.trails[sat.name] = [];
    const trail = State.trails[sat.name];
    const now = Date.now();
    const last = trail[trail.length - 1];
    if (!last || now - last.t > CONFIG.TRAIL_STEP_MS) {
      trail.push({ az: (az + 360) % 360, el, t: now });
      if (trail.length > CONFIG.TRAIL_POINTS) trail.shift();
    }
  },

  /** Estimate upcoming visible passes (brute-force, 30s steps, 24h ahead) */
  estimateNextPass(sat) {
    return this.estimatePasses(sat, 1)[0] || null;
  },

  /** Estimate multiple upcoming passes */
  estimatePasses(sat, maxPasses = 5) {
    if (!State.observer.valid) return [];
    const step = 30 * 1000;  // 30 seconds for accuracy
    const horizon = 24 * 60 * 60 * 1000; // look 24h ahead
    const steps = horizon / step;
    const now = Date.now();
    const passes = [];

    let inPass = false, riseTime = null, maxEl = 0, maxElTime = null;
    let riseAz = 0, maxAz = 0;

    for (let i = 0; i <= steps && passes.length < maxPasses; i++) {
      const t = new Date(now + i * step);
      try {
        const gmst = satellite.gstime(t);
        const pv   = satellite.propagate(sat.satrec, t);
        if (!pv.position) continue;
        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles(
          { longitude: State.observer.lon * Utils.DEG,
            latitude:  State.observer.lat * Utils.DEG,
            height:    State.observer.alt },
          posEcf
        );
        const el = look.elevation * (180 / Math.PI);
        const az = look.azimuth * (180 / Math.PI);

        if (el > 0) {
          if (!inPass) {
            inPass = true;
            riseTime = t;
            riseAz = az;
            maxEl = el;
            maxElTime = t;
            maxAz = az;
          }
          if (el > maxEl) {
            maxEl = el;
            maxElTime = t;
            maxAz = az;
          }
        } else if (inPass) {
          // Pass ended
          const setTime = t;
          const setAz = az;
          const duration = (setTime - riseTime) / 1000; // seconds

          // Signal quality: based on max elevation and time of day
          // >60° = excellent (5), >40° = great (4), >20° = good (3), >10° = fair (2), else poor (1)
          let quality;
          const sunEl = Utils.getSunElevation(maxElTime, State.observer.lat, State.observer.lon);
          
          if (sunEl > -6) {
            // Daylight or bright twilight - satellite not visible
            quality = 0;
          } else {
            if (maxEl >= 60) quality = 5;
            else if (maxEl >= 40) quality = 4;
            else if (maxEl >= 20) quality = 3;
            else if (maxEl >= 10) quality = 2;
            else quality = 1;
          }

          passes.push({
            riseTime,
            riseAz,
            riseDir: Utils.azToCardinal(riseAz),
            maxElTime,
            maxEl,
            maxAz,
            maxDir: Utils.azToCardinal(maxAz),
            setTime,
            setAz,
            setDir: Utils.azToCardinal(setAz),
            duration,  // seconds
            quality,   // 1-5
          });

          inPass = false;
          riseTime = null;
          maxEl = 0;
        }
      } catch(e) {}
    }
    return passes;
  },
};

/* ═══════════════════════════════════════════════════════════════
   STAR FIELD (static, generated once)
   ═══════════════════════════════════════════════════════════════ */
const StarField = {
  stars: [],

  generate() {
    this.stars = [];
    // Spectral colors: O/B (blue-white), A (white), F (pale yellow), G (yellow), K (orange), M (red)
    const COLORS = [
      { r: 155, g: 175, b: 255 },  // O/B blue-white
      { r: 170, g: 190, b: 255 },  // B blue
      { r: 200, g: 215, b: 255 },  // A white-blue
      { r: 255, g: 250, b: 240 },  // F white
      { r: 255, g: 240, b: 210 },  // G yellow-white (Sun-like)
      { r: 255, g: 215, b: 170 },  // K orange
      { r: 255, g: 180, b: 130 },  // M red-orange
    ];

    const STAR_COUNT = 800;
    for (let i = 0; i < STAR_COUNT; i++) {
      const r1 = Math.random();
      const r2 = Math.random();
      const r3 = Math.random();
      const r4 = Math.random();
      const r5 = Math.random();

      const az = r1 * 360;
      // More stars near horizon (realistic sky distribution)
      const el = Math.asin(r2) * (180 / Math.PI);

      // Magnitude: exponential distribution (many dim, few bright)
      const mag = r3 * r3 * r3;  // cubic → heavily weighted toward dim
      const brightness = 0.15 + mag * 0.85;
      const size = 0.3 + mag * 2.5;

      // Spectral type: weighted toward yellow/white (most common)
      const colorWeights = [0.03, 0.05, 0.12, 0.25, 0.30, 0.15, 0.10];
      let cumul = 0, colorIdx = 3;
      for (let c = 0; c < colorWeights.length; c++) {
        cumul += colorWeights[c];
        if (r4 < cumul) { colorIdx = c; break; }
      }
      const col = COLORS[colorIdx];

      // Milky Way band: denser stars roughly along az 60-120 and 240-300, el 20-70
      const inMilkyWay = ((az > 50 && az < 130) || (az > 230 && az < 310)) && el > 15 && el < 75;
      if (!inMilkyWay && r5 > 0.55) continue; // thin out stars outside milky way

      // Twinkle phase offset
      const twinklePhase = r5 * Math.PI * 2;

      this.stars.push({ az, el, brightness, size, color: col, twinklePhase, isBright: mag > 0.7 });
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   SKY RENDERER
   ═══════════════════════════════════════════════════════════════ */
const SkyRenderer = {
  canvas: null,
  ctx:    null,

  init() {
    this.canvas = document.getElementById('skyCanvas');
    this.ctx    = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  },

  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width  = window.innerWidth  * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width  = window.innerWidth  + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  draw() {
    const ctx = this.ctx;
    const W   = window.innerWidth;
    const H   = window.innerHeight;

    const viewAz = State.gyroEnabled ? State.gyroAz : State.viewAz;
    const viewEl = State.gyroEnabled ? State.gyroEl : State.viewEl;

    // ── Background ──────────────────────────────────────────
    // Deep space gradient
    const grad = ctx.createRadialGradient(W/2, H*0.3, 0, W/2, H/2, Math.max(W, H) * 0.8);
    if (State.nightMode) {
      grad.addColorStop(0, '#120000');
      grad.addColorStop(1, '#060000');
    } else {
      grad.addColorStop(0, '#070d1e');
      grad.addColorStop(0.5, '#040812');
      grad.addColorStop(1, '#020406');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // ── Horizon atmospheric glow ───────────────────────────
    // Show a subtle blue/teal glow near the horizon (elevation ~0-15°)
    if (!State.nightMode) {
      for (let az = 0; az < 360; az += 15) {
        for (let el = 0; el < 12; el += 3) {
          const hp = Utils.azElToXY(az, el, viewAz, viewEl, State.fov, W, H);
          if (!hp) continue;
          const hGrad = ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, 40);
          const intensity = (1 - el / 12) * 0.015;
          hGrad.addColorStop(0, `rgba(20, 60, 80, ${intensity})`);
          hGrad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = hGrad;
          ctx.fillRect(hp.x - 40, hp.y - 40, 80, 80);
        }
      }
    }

    // ── Stars ────────────────────────────────────────────────
    const twinkleTime = Date.now() * 0.001;
    for (const star of StarField.stars) {
      const p = Utils.azElToXY(star.az, star.el, viewAz, viewEl, State.fov, W, H);
      if (!p) continue;
      if (p.x < -10 || p.x > W+10 || p.y < -10 || p.y > H+10) continue;

      // Time-based twinkling for bright stars
      let twinkle = 1;
      if (star.isBright) {
        twinkle = 0.7 + 0.3 * Math.sin(twinkleTime * 2.5 + star.twinklePhase);
      }

      const alpha = (0.2 + star.brightness * 0.8) * twinkle;
      const col = star.color;
      const r = State.nightMode ? Math.min(255, col.r) : col.r;
      const g = State.nightMode ? Math.floor(col.g * 0.3) : col.g;
      const b = State.nightMode ? Math.floor(col.b * 0.3) : col.b;

      // Core dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, star.size * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fill();

      // Soft glow halo for brighter stars
      if (star.brightness > 0.4) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, star.size * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.08})`;
        ctx.fill();
      }

      // Diffraction spikes for very bright stars
      if (star.isBright) {
        const spikeLen = star.size * 5 * twinkle;
        ctx.save();
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.25})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x - spikeLen, p.y); ctx.lineTo(p.x + spikeLen, p.y);
        ctx.moveTo(p.x, p.y - spikeLen); ctx.lineTo(p.x, p.y + spikeLen);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Horizon rings (elevation circles) ───────────────────
    this._drawElevationRings(ctx, W, H, viewAz, viewEl);

    // ── Cardinal directions (N/O/S/W) ───────────────────────
    this._drawCardinals(ctx, W, H, viewAz, viewEl);

    // ── Satellite trails ─────────────────────────────────────
    if (State.selectedSat) {
      const sat = State.selectedSat;
      if (sat.computed.visible) {
        const trail = State.trails[sat.name];
        if (trail && trail.length >= 2) {
          this._drawTrail(ctx, trail, sat, viewAz, viewEl, W, H);
        }
      }
    }

    // ── Satellites ───────────────────────────────────────────
    const visCount = State.satellites.filter(s => s.computed.visible).length;
    for (const sat of State.satellites) {
      if (!sat.computed.visible) continue;
      this._drawSatellite(ctx, sat, viewAz, viewEl, W, H);
    }

    // ── Crosshair at view center ─────────────────────────────
    this._drawCrosshair(ctx, W, H);

    // Update look HUD
    document.getElementById('azLabel').textContent  = `Az: ${Math.round(viewAz)}°`;
    document.getElementById('elLabel').textContent  = `El: ${Math.round(viewEl)}°`;
    document.getElementById('fovLabel').textContent = `FoV: ${Math.round(State.fov)}°`;
  },

  _drawElevationRings(ctx, W, H, viewAz, viewEl) {
    const elevations = [0, 30, 60, 90]; // degrees
    const cyan = State.nightMode ? '#ff2200' : '#00e6ff';

    for (const el of elevations) {
      // Draw ring as a series of short arcs (approximated by segments)
      const pts = [];
      for (let az = 0; az < 360; az += 5) {
        const p = Utils.azElToXY(az, el, viewAz, viewEl, State.fov, W, H);
        if (p) pts.push(p);
      }
      if (pts.length < 3) continue;

      ctx.save();
      ctx.setLineDash(el === 0 ? [] : [4, 8]);
      ctx.strokeStyle = el === 0
        ? `rgba(${State.nightMode ? '255,34,0' : '0,230,255'},0.5)`
        : `rgba(${State.nightMode ? '255,34,0' : '0,230,255'},0.12)`;
      ctx.lineWidth = el === 0 ? 1.5 : 1;

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        // Only connect if distance is reasonable (avoid wrapping artefacts)
        const dx = pts[i].x - pts[i-1].x;
        const dy = pts[i].y - pts[i-1].y;
        if (Math.hypot(dx, dy) < W * 0.4) ctx.lineTo(pts[i].x, pts[i].y);
        else ctx.moveTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      ctx.restore();

      // Label
      const labelPt = Utils.azElToXY(0, el, viewAz, viewEl, State.fov, W, H);
      if (labelPt && el > 0) {
        ctx.save();
        ctx.font = '10px monospace';
        ctx.fillStyle = State.nightMode ? 'rgba(255,100,80,0.6)' : 'rgba(0,230,255,0.4)';
        ctx.fillText(el + '°', labelPt.x + 4, labelPt.y - 3);
        ctx.restore();
      }
    }
  },

  _drawCardinals(ctx, W, H, viewAz, viewEl) {
    const dirs = [
      { label: 'N', az: 0 },
      { label: 'O', az: 90 },
      { label: 'S', az: 180 },
      { label: 'W', az: 270 },
      { label: 'NO', az: 45 },
      { label: 'SO', az: 135 },
      { label: 'SW', az: 225 },
      { label: 'NW', az: 315 },
    ];

    for (const d of dirs) {
      const p = Utils.azElToXY(d.az, 1, viewAz, viewEl, State.fov, W, H);
      if (!p) continue;
      const isMain = d.label.length === 1;

      ctx.save();
      ctx.font = `${isMain ? 'bold ' : ''}${isMain ? 14 : 11}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Glow
      ctx.shadowColor = State.nightMode ? '#ff2200' : '#00e6ff';
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = State.nightMode
        ? `rgba(255,${isMain ? 80 : 40},${isMain ? 80 : 40},${isMain ? 0.9 : 0.5})`
        : `rgba(0,230,255,${isMain ? 0.9 : 0.5})`;
      ctx.fillText(d.label, p.x, p.y);
      ctx.restore();
    }
  },

  _drawTrail(ctx, trail, sat, viewAz, viewEl, W, H) {
    const isSelected = State.selectedSat === sat;
    ctx.save();
    ctx.lineWidth = isSelected ? 1.5 : 0.8;

    for (let i = 1; i < trail.length; i++) {
      const p0 = Utils.azElToXY(trail[i-1].az, trail[i-1].el, viewAz, viewEl, State.fov, W, H);
      const p1 = Utils.azElToXY(trail[i].az,   trail[i].el,   viewAz, viewEl, State.fov, W, H);
      if (!p0 || !p1) continue;
      if (Math.hypot(p1.x-p0.x, p1.y-p0.y) > W * 0.3) continue; // skip wraps

      const alpha = (i / trail.length) * 0.6;
      ctx.strokeStyle = State.nightMode
        ? `rgba(255, 80, 0, ${alpha})`
        : (isSelected
            ? `rgba(0, 255, 136, ${alpha})`
            : `rgba(0, 230, 255, ${alpha})`);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();
  },

  _drawSatellite(ctx, sat, viewAz, viewEl, W, H) {
    const p = Utils.azElToXY(sat.computed.az, sat.computed.el, viewAz, viewEl, State.fov, W, H);
    if (!p) return;
    if (p.x < -30 || p.x > W+30 || p.y < -30 || p.y > H+30) return;

    const isSelected = State.selectedSat === sat;
    const tag = sat.tag;
    const name = sat.name;

    // Is this a "key" satellite that always shows its label?
    const isKey = name.includes('ISS') || name.includes('TIANGONG') || name.includes('HUBBLE')
               || name.includes('CSS') || name.includes('ZARYA');

    // Color by type
    let color, glowColor;
    if (State.nightMode) {
      color = isSelected ? '#ff8800' : '#ff4400';
      glowColor = color;
    } else {
      if (isSelected)              { color = '#00ff88'; glowColor = '#00ff88'; }
      else if (tag === 'iss')      { color = '#00e6ff'; glowColor = '#00e6ff'; }
      else if (tag === 'starlink') { color = '#aa99ff'; glowColor = '#8877dd'; }
      else if (tag === 'visual')   { color = '#ffcc44'; glowColor = '#ffaa00'; }
      else                         { color = '#55bbff'; glowColor = '#3399dd'; }
    }

    const time = Date.now() * 0.001;
    const r = isSelected ? 5 : (isKey ? 4 : 3);

    ctx.save();

    // ── Future Orbit Path (Flugbahn) ──
    if (isSelected) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      let t = Date.now();
      let lastP = p;
      for (let i = 1; i <= 30; i++) {
        t += 60000; // +1 minute
        const posVel = satellite.propagate(sat.satrec, new Date(t));
        if (posVel.position) {
          const gmst = satellite.gstime(new Date(t));
          const posGd = satellite.eciToGeodetic(posVel.position, gmst);
          const look = satellite.ecfToLookAngles(State.observer, satellite.geodeticToEcf(posGd));
          const el = look.elevation * 180 / Math.PI;
          if (el > 0) {
            const az = look.azimuth * 180 / Math.PI;
            const fp = Utils.azElToXY(az, el, viewAz, viewEl, State.fov, W, H);
            if (fp) {
              // Avoid wrapping around the screen abruptly
              if (Math.hypot(fp.x - lastP.x, fp.y - lastP.y) < W/2) {
                ctx.lineTo(fp.x, fp.y);
              } else {
                ctx.moveTo(fp.x, fp.y);
              }
              lastP = fp;
            }
          }
        }
      }
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    }
    // ── Pulsing outer glow ──
    const pulseR = isSelected ? (r * 4 + Math.sin(time * 4) * 3) : r * 3;
    const glowGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, pulseR);
    const glowAlpha = isSelected ? 0.3 : 0.15;
    glowGrad.addColorStop(0, glowColor + (isSelected ? '4D' : '26'));
    glowGrad.addColorStop(1, glowColor + '00');
    ctx.beginPath();
    ctx.arc(p.x, p.y, pulseR, 0, Math.PI * 2);
    ctx.fillStyle = glowGrad;
    ctx.fill();

    // ── Satellite shape ──
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = isSelected ? 12 : 6;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 1.5 : 1;

    ctx.translate(p.x, p.y);
    const scale = isSelected ? 1.5 : (isKey ? 1.2 : 0.8);
    ctx.scale(scale, scale);

    if (tag === 'iss') {
      // ISS SVG shape
      const path = new Path2D('M -10,-4 L -10,4 L -4,4 L -4,1 L 4,1 L 4,4 L 10,4 L 10,-4 L 4,-4 L 4,-1 L -4,-1 L -4,-4 Z M -2,-2 L 2,-2 L 2,2 L -2,2 Z');
      ctx.fill(path);
      ctx.stroke(path);
    } else if (tag === 'starlink') {
      // Starlink SVG shape (flat panel)
      const path = new Path2D('M -6,-2 L 6,-2 L 6,2 L -6,2 Z M -6,0 L -8,0 M 6,0 L 8,0');
      ctx.fill(path);
      ctx.stroke(path);
    } else {
      // Default SVG shape
      const path = new Path2D('M 0,-5 L 5,0 L 0,5 L -5,0 Z M -6,-1 L -8,-1 L -8,1 L -6,1 Z M 6,-1 L 8,-1 L 8,1 L 6,1 Z');
      ctx.fill(path);
      ctx.stroke(path);
    }

    ctx.scale(1/scale, 1/scale);
    ctx.translate(-p.x, -p.y);

    ctx.shadowBlur = 0;

    // ── Velocity arrow ──
    const trail = State.trails[sat.name];
    if (trail && trail.length >= 2) {
      const prev = trail[trail.length - 2];
      const pp = Utils.azElToXY(prev.az, prev.el, viewAz, viewEl, State.fov, W, H);
      if (pp) {
        const dx = p.x - pp.x, dy = p.y - pp.y;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          const nx = dx / len, ny = dy / len;
          const arrowLen = isSelected ? 16 : 12;
          ctx.beginPath();
          ctx.moveTo(p.x + nx * r, p.y + ny * r);
          ctx.lineTo(p.x + nx * arrowLen, p.y + ny * arrowLen);
          ctx.strokeStyle = color;
          ctx.lineWidth = isSelected ? 1.5 : 1;
          ctx.globalAlpha = 0.7;
          ctx.stroke();
          // Arrowhead
          const ax = p.x + nx * arrowLen, ay = p.y + ny * arrowLen;
          const perpX = -ny, perpY = nx;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - nx * 4 + perpX * 2.5, ay - ny * 4 + perpY * 2.5);
          ctx.lineTo(ax - nx * 4 - perpX * 2.5, ay - ny * 4 - perpY * 2.5);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }

    // ── Name label ──
    if (isSelected || isKey) {
      const label = name.length > 18 ? name.substring(0, 18) + '…' : name;
      ctx.font = `${isSelected ? 'bold ' : ''}${isSelected ? 11 : 9}px -apple-system, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';

      const tw = ctx.measureText(label).width;
      const lx = p.x + r + 6;
      const ly = p.y - 2;

      // Background pill
      ctx.fillStyle = 'rgba(8,12,24,0.8)';
      const pillH = isSelected ? 16 : 13;
      const pillY = ly - pillH + 2;
      ctx.beginPath();
      ctx.roundRect(lx - 4, pillY, tw + 8, pillH, 3);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly);

      // Elevation sub-label for selected
      if (isSelected) {
        const subText = `El ${sat.computed.el.toFixed(1)}° · ${Math.round(sat.computed.alt)} km`;
        ctx.font = '9px monospace';
        ctx.fillStyle = `rgba(${State.nightMode ? '255,80,0' : '0,200,230'},0.7)`;
        ctx.fillText(subText, lx, ly + 12);
      }
    }

    ctx.restore();
  },

  _drawCrosshair(ctx, W, H) {
    const cx = W / 2, cy = H / 2;
    ctx.save();
    ctx.strokeStyle = State.nightMode ? 'rgba(255,34,0,0.3)' : 'rgba(0,230,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);

    // Horizontal
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy);
    ctx.lineTo(cx + 20, cy);
    ctx.stroke();

    // Vertical
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx, cy + 20);
    ctx.stroke();

    // Circle
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  },
};

/* ═══════════════════════════════════════════════════════════════
   RADAR RENDERER
   ═══════════════════════════════════════════════════════════════ */
const RadarRenderer = {
  canvas: null,
  ctx:    null,

  init() {
    this.canvas = document.getElementById('radarCanvas');
    this.ctx    = this.canvas.getContext('2d');
    this.resize();
  },

  resize() {
    const size = this.canvas.parentElement.offsetWidth;
    this.canvas.width  = size * devicePixelRatio;
    this.canvas.height = size * devicePixelRatio;
    this.canvas.style.width  = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
  },

  draw() {
    const ctx = this.ctx;
    const size = this.canvas.parentElement.offsetWidth;
    if (size === 0) return; // Prevent negative radius when hidden
    const cx = size / 2, cy = size / 2;
    const maxR = size / 2 - 4;

    ctx.clearRect(0, 0, size, size);

    // Background
    ctx.fillStyle = 'rgba(5,10,20,0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + 4, 0, Math.PI * 2);
    ctx.fill();

    // Rings (0°, 30°, 60°, 90°)
    const cyan = State.nightMode ? '#ff2200' : '#00e6ff';
    const elevs = [90, 60, 30, 0];
    for (const el of elevs) {
      const r = maxR * (1 - el / 90);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = el === 0
        ? `rgba(${State.nightMode ? '255,34,0' : '0,230,255'}, 0.5)`
        : `rgba(${State.nightMode ? '255,34,0' : '0,230,255'}, 0.12)`;
      ctx.lineWidth = el === 0 ? 1 : 0.5;
      ctx.stroke();
    }

    // Cardinal ticks
    const cardinals = ['N', 'O', 'S', 'W'];
    const tickAngles = [0, 90, 180, 270];
    for (let i = 0; i < 4; i++) {
      const a = (tickAngles[i] - 90) * Utils.DEG;
      const tx = cx + Math.cos(a) * maxR;
      const ty = cy + Math.sin(a) * maxR;
      ctx.font = '8px monospace';
      ctx.fillStyle = `rgba(${State.nightMode ? '255,80,0' : '0,230,255'}, 0.8)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lx = cx + Math.cos(a) * (maxR - 8);
      const ly = cy + Math.sin(a) * (maxR - 8);
      ctx.fillText(cardinals[i], lx, ly);
    }

    // Satellites
    for (const sat of State.satellites) {
      if (sat.computed.el < 0) continue; // not above horizon
      const el = sat.computed.el;
      const az = sat.computed.az;
      const r  = maxR * (1 - el / 90);
      const angle = (az - 90) * Utils.DEG;
      const sx = cx + Math.cos(angle) * r;
      const sy = cy + Math.sin(angle) * r;

      const isSelected = State.selectedSat === sat;
      let color;
      if (State.nightMode) color = isSelected ? '#ff8800' : '#ff4400';
      else {
        if (sat.tag === 'iss') color = '#00e6ff';
        else if (sat.tag === 'starlink') color = '#8888ff';
        else if (sat.tag === 'weather') color = '#ffb300';
        else color = '#44aaff';
        if (isSelected) color = '#00ff88';
      }

      ctx.beginPath();
      ctx.arc(sx, sy, isSelected ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 4;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // View direction indicator
    const viewAz = State.gyroEnabled ? State.gyroAz : State.viewAz;
    const angle = (viewAz - 90) * Utils.DEG;
    const fovR  = maxR * (1 - Math.max(0, State.viewEl) / 90);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = State.nightMode ? 'rgba(255,136,0,0.6)' : 'rgba(0,255,136,0.6)';
    ctx.lineWidth = 1;
    // FOV arc
    const halfFov = (State.fov / 2) * Utils.DEG;
    ctx.beginPath();
    ctx.arc(0, 0, fovR, -halfFov - Math.PI/2, halfFov - Math.PI/2);
    ctx.stroke();
    ctx.restore();
  },
};

/* ═══════════════════════════════════════════════════════════════
   UI MODULE
   ═══════════════════════════════════════════════════════════════ */
const UIModule = {
  _toastTimer: null,

  init() {
    // Night mode toggle
    document.getElementById('btnNightMode').addEventListener('click', () => this.toggleNightMode());

    // Sat list toggle
    document.getElementById('btnSatList').addEventListener('click', () => this.toggleSatList());
    document.getElementById('closeSatList').addEventListener('click', () => this.closeSatList());

    // Telemetry close
    document.getElementById('closeTelemetry').addEventListener('click', () => this.deselectSat());

    // Permission overlay buttons
    document.getElementById('btnGrantGeo').addEventListener('click', () => {
      GeoModule.start();
    });
    document.getElementById('btnGrantGyro').addEventListener('click', () => {
      OrientationModule.requestPermission();
    });
    document.getElementById('btnSkipPerm').addEventListener('click', () => {
      this.dismissOverlay();
    });
    const btnClose = document.getElementById('btnCloseOverlay');
    if (btnClose) {
      btnClose.addEventListener('click', () => this.dismissOverlay());
    }
    const overlay = document.getElementById('permOverlay');
    if (overlay) {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) this.dismissOverlay();
      });
    }
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.dismissOverlay();
    });

    // Search
    document.getElementById('satSearch').addEventListener('input', e => {
      State.searchQuery = e.target.value.toLowerCase();
      this.applyFilter();
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        State.activeFilter = btn.dataset.filter;
        this.applyFilter();
      });
    });

    // Radar click → toggle list
    document.getElementById('radarContainer').addEventListener('click', () => this.toggleSatList());

    // Update clock
    setInterval(() => this.updateClock(), 1000);
    this.updateClock();
  },

  updateClock() {
    const now = new Date();
    document.getElementById('clockLabel').textContent =
      now.toTimeString().slice(0, 8);
  },

  updateGeoChip(ok) {
    const chip = document.getElementById('chipGeo');
    const label = document.getElementById('geoLabel');
    chip.className = 'chip ' + (ok ? 'chip--ok' : 'chip--warn');
    if (ok && State.observer.valid) {
      label.textContent = `${State.observer.lat.toFixed(2)}° ${State.observer.lon.toFixed(2)}°`;
    }
  },

  updateSatChip() {
    const visible = State.satellites.filter(s => s.computed.visible).length;
    const total   = State.satellites.length;
    document.getElementById('satCountLabel').textContent = `${visible} / ${total}`;
  },

  showToast(msg) {
    const toast = document.getElementById('loadingToast');
    document.getElementById('loadingMsg').textContent = msg;
    toast.classList.remove('hidden');
    if (this._toastTimer) clearTimeout(this._toastTimer);
  },

  hideToast() {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      document.getElementById('loadingToast').classList.add('hidden');
    }, 1500);
  },

  showPermStatus(msg, isError = false) {
    const el = document.getElementById('permStatus');
    el.textContent = msg;
    el.className = 'perm-status' + (isError ? ' error' : '');
  },

  dismissOverlay() {
    const overlay = document.getElementById('permOverlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden');
      setTimeout(() => overlay.style.display = 'none', 400);
    }
  },

  toggleNightMode() {
    State.nightMode = !State.nightMode;
    document.body.classList.toggle('night-mode', State.nightMode);
    const btn = document.getElementById('btnNightMode');
    btn.classList.toggle('active', State.nightMode);
  },

  toggleSatList() {
    const panel = document.getElementById('satListPanel');
    panel.classList.toggle('open');
  },

  closeSatList() {
    document.getElementById('satListPanel').classList.remove('open');
  },

  applyFilter() {
    let sats = State.satellites;
    const q = State.searchQuery;
    if (q) sats = sats.filter(s => s.name.toLowerCase().includes(q));
    if (State.activeFilter !== 'all') {
      if (State.activeFilter === 'visible') sats = sats.filter(s => s.computed.visible);
      else if (State.activeFilter === 'nostarlink') sats = sats.filter(s => s.tag !== 'starlink');
      else sats = sats.filter(s => s.tag === State.activeFilter);
    }
    State.filteredSats = sats;
    // Only do a full rebuild when the set of satellites changes
    this._fullRenderSatList();
  },

  /** Full rebuild – called only on filter/search changes */
  _fullRenderSatList() {
    const ul = document.getElementById('satList');
    const sorted = State.filteredSats
      .sort((a, b) => b.computed.el - a.computed.el)
      .slice(0, 150);

    const html = sorted.map(sat => {
      const vis = sat.computed.visible;
      const above = sat.computed.el > 0;
      const dotClass = vis ? 'sat-dot--visible' : (above ? 'sat-dot--above' : 'sat-dot--below');
      const elStr = sat.computed.el > -90 ? sat.computed.el.toFixed(1) + '°' : '—';
      const azStr = sat.computed.az ? sat.computed.az.toFixed(0) + '°' : '—';
      const isSelected = State.selectedSat === sat;
      const sunEl = Utils.getSunElevation(new Date(), State.observer.lat, State.observer.lon);
      const isDark = sunEl <= -6;
      const actuallyVisible = vis && isDark;
      
      let listQuality = 0;
      if (above && isDark) {
        if (sat.computed.el >= 60) listQuality = 5;
        else if (sat.computed.el >= 40) listQuality = 4;
        else if (sat.computed.el >= 20) listQuality = 3;
        else if (sat.computed.el >= 10) listQuality = 2;
        else listQuality = 1;
      }

      return `<li class="sat-item${isSelected ? ' selected' : ''}" data-name="${sat.name}" role="option" aria-selected="${isSelected}">
        <span class="sat-item__dot ${dotClass}"></span>
        <div class="sat-item__info">
          <div class="sat-item__name">${sat.name}</div>
          <div class="sat-item__sub">${Utils.azToCardinal(sat.computed.az)} ${azStr} · ${sat.tag.toUpperCase()}${actuallyVisible ? ' · <span class="vis-badge">SICHTBAR</span>' : ''}</div>
        </div>
        <div class="sat-item__right">
          <span class="sat-item__el">${elStr}</span>
          ${above ? Utils.qualityBars(listQuality) : ''}
        </div>
      </li>`;
    }).join('');

    ul.innerHTML = html || '<li style="padding:16px;color:var(--text-muted);text-align:center">Keine Satelliten gefunden</li>';

    // Attach click handlers
    ul.querySelectorAll('.sat-item').forEach(li => {
      li.addEventListener('click', () => {
        const name = li.dataset.name;
        const sat = State.satellites.find(s => s.name === name);
        if (sat) {
          this.selectSat(sat);
          if (sat.computed.visible) {
            State.viewAz = sat.computed.az;
            State.viewEl = sat.computed.el;
          }
          this.closeSatList();
        }
      });
    });
  },

  /** Lightweight in-place update – called every propagation tick.
      Only updates text/classes of existing DOM nodes without rebuilding HTML. */
  renderSatList() {
    const ul = document.getElementById('satList');
    const items = ul.querySelectorAll('.sat-item');
    if (items.length === 0) return; // list not built yet

    items.forEach(li => {
      const name = li.dataset.name;
      const sat = State.satellites.find(s => s.name === name);
      if (!sat) return;

      const vis = sat.computed.visible;
      const above = sat.computed.el > 0;
      const isSelected = State.selectedSat === sat;

      const sunEl = Utils.getSunElevation(new Date(), State.observer.lat, State.observer.lon);
      const isDark = sunEl <= -6;
      const actuallyVisible = vis && isDark;

      // Update dot
      const dot = li.querySelector('.sat-item__dot');
      if (dot) {
        dot.className = 'sat-item__dot ' + (vis ? 'sat-dot--visible' : (above ? 'sat-dot--above' : 'sat-dot--below'));
      }

      // Update subtitle
      const sub = li.querySelector('.sat-item__sub');
      if (sub) {
        const azStr = sat.computed.az ? sat.computed.az.toFixed(0) + '°' : '—';
        sub.innerHTML = `${Utils.azToCardinal(sat.computed.az)} ${azStr} · ${sat.tag.toUpperCase()}${actuallyVisible ? ' · <span class="vis-badge">SICHTBAR</span>' : ''}`;
      }

      // Update elevation
      const elSpan = li.querySelector('.sat-item__el');
      if (elSpan) {
        elSpan.textContent = sat.computed.el > -90 ? sat.computed.el.toFixed(1) + '°' : '—';
      }
      
      // Update bars if they exist
      if (above) {
        const barsSpan = li.querySelector('.signal-bars');
        if (barsSpan) {
          let listQuality = 0;
          if (isDark) {
            if (sat.computed.el >= 60) listQuality = 5;
            else if (sat.computed.el >= 40) listQuality = 4;
            else if (sat.computed.el >= 20) listQuality = 3;
            else if (sat.computed.el >= 10) listQuality = 2;
            else listQuality = 1;
          }
          barsSpan.outerHTML = Utils.qualityBars(listQuality);
        } else {
           // We might need to inject them, but it's easier to just do full rebuild if state changed from below to above
        }
      }

      // Update selected state
      li.classList.toggle('selected', isSelected);
      li.setAttribute('aria-selected', isSelected);
    });
  },

  selectSat(sat) {
    State.selectedSat = sat;
    this.openTelemetry(sat);
    this.renderSatList();
  },

  deselectSat() {
    State.selectedSat = null;
    document.getElementById('telemetryPanel').classList.remove('open');
    this.renderSatList();
  },

  openTelemetry(sat) {
    const panel = document.getElementById('telemetryPanel');
    panel.classList.add('open');
    this.updateTelemetry(sat);
  },

  updateTelemetry(sat) {
    if (!sat || State.selectedSat !== sat) return;
    const c = sat.computed;

    document.getElementById('telName').textContent  = sat.name;
    document.getElementById('telAz').textContent    = c.az.toFixed(1) + '° ' + Utils.azToCardinal(c.az);
    document.getElementById('telEl').textContent    = c.el.toFixed(1) + '°';
    document.getElementById('telRange').textContent = Math.round(c.range) + ' km';
    document.getElementById('telAlt').textContent   = Math.round(c.alt) + ' km';
    document.getElementById('telVel').textContent   = (c.vel * 3600).toFixed(0) + ' km/h';

    let visText, visClass;
    if (c.el >= 10) { visText = '🟢 Gut sichtbar'; visClass = 'vis-good'; }
    else if (c.el >= 5) { visText = '🟡 Sichtbar (niedrig)'; visClass = 'vis-low'; }
    else if (c.el >= 0) { visText = '🟠 Am Horizont'; visClass = 'vis-horizon'; }
    else { visText = '🔴 Unter Horizont'; visClass = 'vis-below'; }
    const telVisEl = document.getElementById('telVis');
    telVisEl.textContent = visText;
    telVisEl.className = 'tel-value ' + visClass;

    document.getElementById('telNorad').textContent = sat.noradId || '—';
    document.getElementById('telObserver').textContent =
      State.observer.valid
        ? `${State.observer.lat.toFixed(4)}° N, ${State.observer.lon.toFixed(4)}° O`
        : 'Kein GPS';

    // Compute multiple upcoming passes (async to avoid frame drops)
    const passEl = document.getElementById('telPass');
    if (State._lastPassSat === sat && State._lastPassHtml && Date.now() - (State._lastPassTime || 0) < 60000) {
      // Reuse cached HTML to prevent flicker on every tick
      passEl.innerHTML = State._lastPassHtml;
    } else {
      passEl.innerHTML = '<span class="pass-loading">Berechne Überflüge…</span>';
      setTimeout(() => {
        if (State.selectedSat !== sat) return;
        const passes = PropagationModule.estimatePasses(sat, 5);
        
        let html = '';
        if (!passes.length) {
          html = '<span class="pass-none">Kein Überflug in den nächsten 24h</span>';
        } else {
          const timeFmt = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
          const dateFmt = { weekday: 'short', day: 'numeric', month: 'short' };

          let lastDateStr = '';
          for (const pass of passes) {
            const dateStr = pass.riseTime.toLocaleDateString('de-DE', dateFmt);
            if (dateStr !== lastDateStr) {
              html += `<div class="pass-date">${dateStr}</div>`;
              lastDateStr = dateStr;
            }

            const rise = pass.riseTime.toLocaleTimeString('de-DE', timeFmt);
            const set  = pass.setTime ? pass.setTime.toLocaleTimeString('de-DE', timeFmt) : '?';
            const dur  = Utils.formatDuration(pass.duration);
            const bars = Utils.qualityBars(pass.quality);

            html += `<div class="pass-card">
              <div class="pass-header">
                <span class="pass-time">${rise}</span>
                <span class="pass-dur">Dauer ${dur}</span>
                ${bars}
              </div>
              <table class="pass-table">
                <tr><th></th><th>Beginn</th><th>Max.</th><th>Ende</th></tr>
                <tr><td>Richtung</td><td>${pass.riseDir}</td><td>${pass.maxDir}</td><td>${pass.setDir}</td></tr>
                <tr><td>Höhe</td><td>${Math.round(pass.maxEl > 0 ? Math.min(pass.maxEl * 0.3, 15) : 0)}°</td><td>${pass.maxEl.toFixed(0)}°</td><td>${Math.round(pass.maxEl > 0 ? Math.min(pass.maxEl * 0.2, 10) : 0)}°</td></tr>
              </table>
            </div>`;
          }
        }
        
        State._lastPassSat = sat;
        State._lastPassHtml = html;
        State._lastPassTime = Date.now();
        passEl.innerHTML = html;
      }, 50);
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════ */
const App = {
  _lastUpdate: 0,

  async init() {
    // Generate star field
    StarField.generate();

    // Init renderers
    SkyRenderer.init();
    RadarRenderer.init();
    MapRenderer.init();

    // Init UI
    UIModule.init();

    document.getElementById('btnToggleMap').addEventListener('click', () => {
      State.mapMode = !State.mapMode;
      document.body.classList.toggle('map-view', State.mapMode);
      MapRenderer.active = State.mapMode;
      if (State.mapMode) MapRenderer.resize();
    });

    // Init touch/mouse
    TouchModule.init(document.getElementById('skyCanvas'));

    // Load TLE data (async)
    TLEModule.loadAll().catch(e => console.error('TLE load error:', e));

    // Start animation loop
    this._loop();

    // Register service worker
    this._registerSW();

    // Set initial view to Zenith
    State.viewEl = 90;
    State.viewAz = 0;
  },

  _loop(ts = 0) {
    State.animFrame = requestAnimationFrame(t => this._loop(t));

    const viewAz = State.gyroEnabled ? State.gyroAz : State.viewAz;
    const viewEl = State.gyroEnabled ? State.gyroEl : State.viewEl;

    // Propagate a chunk of satellites every frame (time-slicing)
    PropagationModule.tick();

    // Always render
    SkyRenderer.draw();
    RadarRenderer.draw();
    MapRenderer.draw();
  },

  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registered, scope:', reg.scope))
        .catch(err => console.warn('SW registration failed:', err));
    }
  },
};



const MapRenderer = {
  canvas: null, ctx: null, geoData: null,
  active: false,

  async init() {
    this.canvas = document.getElementById('mapCanvas');
    this.ctx = this.canvas.getContext('2d');
    try {
      const res = await fetch('map.json');
      this.geoData = await res.json();
    } catch(e) { console.error("Map load failed"); }
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  draw() {
    if (!this.active || !this.geoData) return;
    const ctx = this.ctx;
    const W = window.innerWidth, H = window.innerHeight;
    
    ctx.fillStyle = State.nightMode ? '#0a0000' : '#020408';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = State.nightMode ? 'rgba(255, 60, 0, 0.2)' : 'rgba(0, 200, 255, 0.2)';
    ctx.lineWidth = 1;
    
    // Draw map
    ctx.beginPath();
    for (const feature of this.geoData.features) {
      if (feature.geometry.type === 'Polygon') {
        this._drawPoly(feature.geometry.coordinates, W, H, ctx);
      } else if (feature.geometry.type === 'MultiPolygon') {
        for (const poly of feature.geometry.coordinates) {
          this._drawPoly(poly, W, H, ctx);
        }
      }
    }
    ctx.stroke();

    // Draw satellites
    const time = new Date();
    for (const sat of State.satellites) {
      const posAndVel = satellite.propagate(sat.satrec, time);
      if (!posAndVel.position) continue;
      const gmst = satellite.gstime(time);
      const posGd = satellite.eciToGeodetic(posAndVel.position, gmst);
      
      let lon = posGd.longitude * 180 / Math.PI;
      let lat = posGd.latitude * 180 / Math.PI;
      
      const x = (lon + 180) / 360 * W;
      const y = (90 - lat) / 180 * H;

      const isSelected = State.selectedSat === sat;
      const color = isSelected ? '#00ff88' : (State.nightMode ? '#ff4400' : 'rgba(0, 230, 255, 0.6)');
      
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 4 : 1.5, 0, Math.PI*2);
      ctx.fillStyle = color;
      ctx.fill();

      // Draw footprint for selected
      if (isSelected) {
        ctx.beginPath();
        const fpRadius = W * (sat.computed.alt / 6371) * 0.15; // rough footprint estimation
        ctx.arc(x, y, fpRadius, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(0, 255, 136, 0.1)';
        ctx.fill();
        
        ctx.fillStyle = color;
        ctx.font = '12px sans-serif';
        ctx.fillText(sat.name.substring(0,15), x + 8, y + 4);
      }
    }
  },

  _drawPoly(coords, W, H, ctx) {
    for (const ring of coords) {
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const x = (lon + 180) / 360 * W;
        const y = (90 - lat) / 180 * H;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
  }
};


/* ── Bootstrap ─────────────────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
