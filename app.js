/* =========================================================================
   DAhYO — free web DAW. Vanilla JS + Web Audio API. No backend, 100% free.
   Pro Tools-style: arrange + mixer views, buses, aux tracks, sends,
   per-track I/O, built-in plugin suite, WAV export, metronome.
   ========================================================================= */
'use strict';

/* -------------------------------------------------------------------------
   TUNE WORKLET — real-time Auto-Tune-style pitch correction.
   1. Autocorrelation pitch detection on 2048-sample blocks (monophonic).
   2. Detected pitch quantized to nearest note of key/scale -> target pitch.
   3. Dual-tap modulated-delay pitch shifter applies the correction ratio:
      delay ramps at slope s => pitch multiplied by (1 - s); the second tap
      runs antiphase with a Hann crossfade so wraps happen at zero gain.
   Honest limits:
   - Monophonic sources only (vocals, bass, 808s). Chords smear.
   - Cleanest within ~±200 cents; larger shifts add warble artifacts.
   - ~43ms latency by design (2048-sample max delay).
-------------------------------------------------------------------------- */
const TUNE_WORKLET_CODE = `
class TuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.RING = 4096;
    this.DMAX = 2048;
    this.ring = new Float32Array(this.RING);
    this.wp = 0;
    this.phi = 0.25;
    this.anBuf = new Float32Array(2048);
    this.anCount = 0;
    this.detected = 0;
    this.target = 0;
    this.ratio = 1;
    this.speed = 0.65;
    this.key = 0;
    this.scale = [0,2,4,5,7,9,11];
    this.bypass = false;
    this.msgTick = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.speed !== undefined) this.speed = d.speed;
      if (d.key !== undefined) this.key = d.key;
      if (d.scale !== undefined) this.scale = d.scale;
      if (d.bypass !== undefined) this.bypass = d.bypass;
    };
  }
  detectPitch() {
    const buf = this.anBuf, N = buf.length;
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.02) return 0;
    let c0 = 0;
    for (let i = 0; i < N; i++) c0 += buf[i] * buf[i];
    if (c0 < 1e-9) return 0;
    const minLag = Math.max(2, Math.floor(this.sr / 1200));
    const maxLag = Math.min(N - 2, Math.floor(this.sr / 70));
    let bestLag = -1, bestCorr = 0.45;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < N - lag; i++) c += buf[i] * buf[i + lag];
      c /= c0;
      if (c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    if (bestLag < 0) return 0;
    let y1 = 0, y2 = 0, y3 = 0;
    for (let i = 0; i < N - bestLag - 1; i++) y2 += buf[i] * buf[i + bestLag];
    if (bestLag > minLag) for (let i = 0; i < N - bestLag - 2; i++) y1 += buf[i] * buf[i + bestLag - 1];
    if (bestLag < maxLag) for (let i = 0; i < N - bestLag - 2; i++) y3 += buf[i] * buf[i + bestLag + 1];
    const denom = y1 - 2 * y2 + y3;
    let shift = 0;
    if (denom !== 0) shift = 0.5 * (y1 - y3) / denom;
    return this.sr / (bestLag + shift);
  }
  nearestScale(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const allowed = {};
    for (let s = 0; s < this.scale.length; s++) allowed[(this.scale[s] + this.key) % 12] = 1;
    let bestM = Math.round(midi), bestD = 99;
    for (let m = Math.floor(midi) - 7; m <= Math.ceil(midi) + 7; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (allowed[pc]) { const d = Math.abs(m - midi); if (d < bestD) { bestD = d; bestM = m; } }
    }
    return 440 * Math.pow(2, (bestM - 69) / 12);
  }
  readDelay(d) {
    let p = this.wp - 1 - d;
    p = ((p % this.RING) + this.RING) % this.RING;
    const i0 = Math.floor(p), i1 = (i0 + 1) % this.RING, f = p - i0;
    return this.ring[i0] * (1 - f) + this.ring[i1] * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length, DMAX = this.DMAX;
    for (let n = 0; n < N; n++) {
      const x = inp ? inp[n] : 0;
      this.ring[this.wp] = x;
      this.wp = (this.wp + 1) % this.RING;
      this.anBuf[this.anCount++] = x;
      if (this.anCount >= 2048) { this.anCount = 0; this.detected = this.detectPitch(); }
      let want = 1;
      if (!this.bypass && this.detected > 0) {
        this.target = this.nearestScale(this.detected);
        want = this.target / this.detected;
        if (want < 0.5) want = 0.5;
        if (want > 2) want = 2;
      } else { this.target = 0; }
      const tc = 0.004 + (1 - this.speed) * (1 - this.speed) * 0.28;
      const k = 1 - Math.exp(-1 / (tc * this.sr));
      this.ratio += (want - this.ratio) * k;
      this.phi += (1 - this.ratio) / DMAX;
      this.phi -= Math.floor(this.phi);
      const u1 = this.phi;
      const u2 = u1 >= 0.5 ? u1 - 0.5 : u1 + 0.5;
      const t1 = this.readDelay(DMAX * u1);
      const t2 = this.readDelay(DMAX * u2);
      const s1 = Math.sin(Math.PI * u1), s2 = Math.sin(Math.PI * u2);
      out[n] = t1 * s1 * s1 + t2 * s2 * s2;
    }
    if (++this.msgTick >= 12) {
      this.msgTick = 0;
      this.port.postMessage({ detected: this.detected, target: this.target });
    }
    return true;
  }
}
registerProcessor('dahyo-tune', TuneProcessor);
`;

// Noise gate as an AudioWorklet: envelope-followed downward expansion.
// Original DSP written for DAhYO — threshold/attack/release/range.
const GATE_WORKLET_CODE = `
class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0; this.g = 1;
    this.thDb = -40; this.atk = 0.003; this.rel = 0.2; this.rangeDb = -60;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.threshold !== undefined) this.thDb = d.threshold;
      if (d.attack !== undefined) this.atk = d.attack;
      if (d.release !== undefined) this.rel = d.release;
      if (d.range !== undefined) this.rangeDb = d.range;
      if (d.bypass !== undefined) this.bp = !!d.bypass;
    };
    this.bp = true;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    if (this.bp) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[c % inp.length]);
      return true;
    }
    const thL = Math.pow(10, this.thDb / 20);
    const rL = Math.pow(10, this.rangeDb / 20);
    const cA = Math.exp(-1 / (Math.max(0.0005, this.atk) * sampleRate));
    const cR = Math.exp(-1 / (Math.max(0.005, this.rel) * sampleRate));
    const nCh = Math.min(inp.length, out.length);
    for (let c = 0; c < nCh; c++) {
      const id = inp[c], od = out[c];
      for (let i = 0; i < od.length; i++) {
        const s = id[i], a = Math.abs(s);
        const ce = a > this.env ? cA : cR;
        this.env = ce * this.env + (1 - ce) * a;
        const target = this.env > thL ? 1 : rL;
        const cg = target > this.g ? cA : cR;
        this.g = cg * this.g + (1 - cg) * target;
        od[i] = s * this.g;
      }
    }
    return true;
  }
}
registerProcessor('dahyo-gate', GateProcessor);
`;

/* ------------------------------- state ---------------------------------- */
const SCALES = {
  major:     [0,2,4,5,7,9,11],
  minor:     [0,2,3,5,7,8,10],
  chromatic: [0,1,2,3,4,5,6,7,8,9,10,11],
  majPent:   [0,2,4,7,9],
  minPent:   [0,3,5,7,10],
};
const KEY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const STORE_KEY = 'dahyo-session-v2';
const SESSION_MAP_KEY = 'dahyo-sessions-v1';   // named sessions: { name: sessionData }
const TPL_KEY = 'dahyo-vocal-chains-v1';        // user vocal-chain templates
const IDB_NAME = 'dahyo-db', IDB_STORE = 'clips';

/* ------------------------- factory vocal chains --------------------------
   Original DAhYO presets — sensible starting points, not copies of anything.
   Each holds a full FX-chain snapshot: tune/eq/comp/delay/verb params. */
function factoryChains() {
  return [
    {
      id: 'factory-clean', factory: true, name: 'Clean Modern Vocal',
      params: {
        tune:  { on: true,  speed: 0.8,  key: 0, scale: 'major' },
        eq:    { on: true,  low: -2, mid: 1.5, high: 3 },
        comp:  { on: true,  threshold: -18, ratio: 3 },
        delay: { on: false, time: 0.32, feedback: 0.35, mix: 0.25 },
        verb:  { on: true,  mix: 0.18, size: 1.0 },
      },
    },
    {
      id: 'factory-hard', factory: true, name: 'Heavy Auto-Tune',
      params: {
        tune:  { on: true,  speed: 0.08, key: 0, scale: 'minor' },
        eq:    { on: true,  low: -3, mid: 2, high: 4 },
        comp:  { on: true,  threshold: -20, ratio: 4 },
        delay: { on: true,  time: 0.28, feedback: 0.3, mix: 0.2 },
        verb:  { on: true,  mix: 0.25, size: 1.2 },
      },
    },
    {
      id: 'factory-rnb', factory: true, name: 'Warm R&B',
      params: {
        tune:  { on: true,  speed: 0.55, key: 0, scale: 'major' },
        eq:    { on: true,  low: 2, mid: 1, high: 1.5 },
        comp:  { on: true,  threshold: -16, ratio: 2.5 },
        delay: { on: true,  time: 0.38, feedback: 0.35, mix: 0.22 },
        verb:  { on: true,  mix: 0.3, size: 1.4 },
      },
    },
  ];
}

/* ------------------------- IndexedDB audio store -------------------------
   Audio blobs (imports, recorded takes, demo WAV) live here, keyed by
   clipId. Session JSON in localStorage holds everything else. */
let _idbWarned = false;
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      let req;
      try {
        if (typeof indexedDB === 'undefined') throw new Error('no-indexeddb');
        req = indexedDB.open(IDB_NAME, 1);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'clipId' });
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error || new Error('idb-open-failed'));
    });
  },
  _store(mode) {
    return this.open().then(db => new Promise((res, rej) => {
      try {
        const tx = db.transaction(IDB_STORE, mode);
        tx.onerror = () => rej(tx.error || new Error('idb-tx-failed'));
        res(tx.objectStore(IDB_STORE));
      } catch (e) { rej(e); }
    }));
  },
  async putClip(clipId, blob, name) {
    try {
      const st = await this._store('readwrite');
      await new Promise((res, rej) => {
        const r = st.put({ clipId, blob, name: name || '', savedAt: Date.now() });
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      });
      return true;
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String((e && e.message) || '')))) {
        toast('Browser storage is full — new audio may not survive a reload. Delete old sessions or free up space.');
      } else if (!_idbWarned) {
        _idbWarned = true;
        toast('Audio persistence is unavailable here — sessions will keep settings only.');
      }
      return false;
    }
  },
  async getClip(clipId) {
    try {
      const st = await this._store('readonly');
      const rec = await new Promise((res, rej) => {
        const r = st.get(clipId);
        r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      });
      return rec && rec.blob ? rec : null;
    } catch (e) { return null; }
  },
  async deleteClips(ids) {
    if (!ids || !ids.length) return;
    try {
      const st = await this._store('readwrite');
      await Promise.all(ids.map(id => new Promise((res) => {
        try { const r = st.delete(id); r.onsuccess = () => res(); r.onerror = () => res(); }
        catch (e) { res(); }
      })));
    } catch (e) {}
  },
  async allKeys() {
    try {
      const st = await this._store('readonly');
      return await new Promise((res, rej) => {
        const r = st.getAllKeys();
        r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
      });
    } catch (e) { return []; }
  },
};

// Persist any in-memory clip audio not yet stored (fire-and-forget).
function persistClipBlobs() {
  for (const tr of S.tracks) {
    for (const clip of tr.clips || []) {
      if (clip.buffer && !clip.missing && !clip._blobSaved) {
        clip._blobSaved = true; // mark first — retry next save if the put fails
        let wav = null;
        try { wav = encodeWAV(clip.buffer); } catch (e) { clip._blobSaved = false; continue; }
        idb.putClip(clip.id, wav, clip.name).then(ok => { if (!ok) clip._blobSaved = false; });
      }
    }
  }
}

// Restore decoded audio for clips whose blobs are in IndexedDB.
async function restoreClipAudio() {
  await ensureCtx();
  let restored = 0;
  for (const tr of S.tracks) {
    for (const clip of tr.clips || []) {
      if (clip.buffer) continue; // already in memory (fresh import/record this session)
      const rec = await idb.getClip(clip.id);
      if (!rec) { clip.missing = true; continue; }
      try {
        const ab = await rec.blob.arrayBuffer();
        const buf = await S.ctx.decodeAudioData(ab);
        clip.buffer = buf;
        clip.peaks = computePeaks(buf);
        clip.duration = buf.duration;
        clip.missing = false;
        clip._blobSaved = true;
        restored++;
      } catch (e) { clip.missing = true; /* user can re-import */ }
    }
  }
  return restored;
}

const S = {
  ctx: null, tuneOK: false, gateOK: false,
  tracks: [], auxes: [], buses: [],
  master: { vol: 0.9 },
  masterIn: null, masterGain: null, masterAnL: null, masterAnR: null,
  G: null, // live routing graph {masterIn, busNodes:Map, auxInputs:Map}
  playing: false, recording: false,
  playStartCtx: 0, playStartPos: 0, duration: 0,
  loop: false, metro: false, bpm: 140, timesig: 4,
  metroTimer: null, metroNext: 0, metroBeat: 0,
  selId: null, // selected channel id
  selClipId: null, // selected clip id (timeline)
  markers: [], // {id, pos, name}
  sessionName: null, // name of the loaded named session (null = unsaved)
  pxPerSec: 90,
  sources: [], mediaRec: null, recChunks: [], recTrack: null,
  io: { inputs: [], outputs: [], inputId: 'default', outputId: 'default', inputMode: 'music', sessionRate: 44100 },
  punch: { on: false, in: 0, out: 8 }, // punch in/out region (seconds)
  snap: { on: true, div: 'beat' }, // snap-to-grid
  countIn: 0, // count-in bars before recording (0/1/2)
  artists: [], artistId: null, // per-artist learning profiles
  voice: { on: false, rec: null, last: '', restartTimer: 0 },
  masterChain: null, // mastering chain params (lazy default)
  view: 'arrange',
  meterPeaks: new Map(), // channelId -> {l, r, hl, hr}
};

let _uid = 1;
function uid(p) { return p + '_' + (_uid++) + '_' + Date.now().toString(36); }

/* ------------------------------- utils ---------------------------------- */
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function dbToGain(db) { return Math.pow(10, db / 20); }
function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return m + ':' + sec.toFixed(1).padStart(4, '0');
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  $('status-msg').textContent = msg;
}
function status(msg) { $('status-msg').textContent = msg; }

/* ------------------------------ undo / redo ------------------------------
   Snapshot-based history. pushUndo(label) captures the full session JSON +
   live AudioBuffer references BEFORE a mutating edit; undo/redo restore it.
   Snapshots are cheap (buffers shared by reference) and capped at 60. */
const Undo = {
  stack: [], redo: [],
  push(label) {
    try {
      const buffers = new Map();
      for (const tr of S.tracks) for (const c of tr.clips || []) if (c.buffer) buffers.set(c.id, c.buffer);
      this.stack.push({ label: label || 'Edit', session: JSON.stringify(sessionData()), buffers });
      if (this.stack.length > 60) this.stack.shift();
      this.redo.length = 0;
      syncUndoButtons();
    } catch (e) {}
  },
  canUndo() { return this.stack.length > 0; },
  canRedo() { return this.redo.length > 0; },
};
function syncUndoButtons() {
  const u = $('btn-undo'), r = $('btn-redo');
  if (u) u.disabled = !Undo.canUndo();
  if (r) r.disabled = !Undo.canRedo();
  if (u) u.title = Undo.canUndo() ? 'Undo: ' + Undo.stack[Undo.stack.length - 1].label + ' (Ctrl/Cmd+Z)' : 'Undo (Ctrl/Cmd+Z)';
  if (r) r.title = Undo.canRedo() ? 'Redo: ' + Undo.redo[Undo.redo.length - 1].label + ' (Ctrl/Cmd+Shift+Z)' : 'Redo (Ctrl/Cmd+Shift+Z)';
}
async function restoreUndoSnapshot(snap) {
  const wasPlaying = S.playing;
  if (wasPlaying) stop();
  if (S.recording) stopRecording(true);
  teardownChannels();
  S.tracks = []; S.auxes = []; S.buses = [];
  let data;
  try { data = JSON.parse(snap.session); }
  catch (e) { toast('Could not restore that step.'); return; }
  applySessionData(data);
  // re-attach live audio buffers captured in the snapshot
  for (const tr of S.tracks) for (const c of tr.clips || []) {
    const b = snap.buffers.get(c.id);
    if (b) {
      c.buffer = b; c.missing = false; c.duration = b.duration;
      if (!c.peaks) { try { c.peaks = computePeaks(b); } catch (e) {} }
    } else if (!c.missing) {
      c.missing = true; // buffer was never captured (shouldn't happen) — honest fallback
    }
  }
  try {
    await ensureCtx();
    buildLiveGraph();
  } catch (e) { toast('Audio engine hiccup — try again.'); return; }
  S.selClipId = null;
  $('bpm').value = S.bpm;
  $('timesig').value = String(S.timesig);
  updateDuration();
  renderHeaders(); renderMixer(); renderInspector(); renderIO(); renderSessions();
  drawTimeline(); syncUndoButtons();
  saveSession();
}
async function doUndo() {
  if (!Undo.canUndo()) { toast('Nothing to undo.'); return; }
  const cur = { label: 'state', session: JSON.stringify(sessionData()), buffers: new Map() };
  for (const tr of S.tracks) for (const c of tr.clips || []) if (c.buffer) cur.buffers.set(c.id, c.buffer);
  Undo.redo.push(cur);
  const snap = Undo.stack.pop();
  await restoreUndoSnapshot(snap);
  toast('Undid: ' + snap.label);
}
async function doRedo() {
  if (!Undo.canRedo()) { toast('Nothing to redo.'); return; }
  const cur = { label: 'state', session: JSON.stringify(sessionData()), buffers: new Map() };
  for (const tr of S.tracks) for (const c of tr.clips || []) if (c.buffer) cur.buffers.set(c.id, c.buffer);
  Undo.stack.push(cur);
  const snap = Undo.redo.pop();
  await restoreUndoSnapshot(snap);
  toast('Redid: ' + snap.label);
}
// Coalesced gesture undo for knobs/sliders/faders: snapshot once per drag.
function undoableGesture(elm, label) {
  if (!elm || elm._undoWired) return;
  elm._undoWired = true;
  let armed = false;
  elm.addEventListener('pointerdown', () => { armed = false; }, true);
  elm.addEventListener('input', () => {
    if (!armed) { armed = true; try { Undo.push(label); } catch (e) {} }
  }, true);
  const reset = () => { armed = false; };
  elm.addEventListener('pointerup', reset, true);
  elm.addEventListener('pointercancel', reset, true);
}

/* FX chain order (Pro Tools-style insert order):
   Tune -> EQ -> De-Esser -> Gate -> Comp -> Saturate -> Chorus -> Flanger
   -> Delay -> Ping-Pong -> Reverb -> Tremolo -> Filter -> Widener -> Limiter */
const FX_KEYS = ['tune','eq','deess','gate','comp','sat','chorus','flang','delay','ppd','verb','trem','filt','wide','lim'];
const FX_LABELS = {
  tune:'Tune', eq:'EQ', deess:'DeEss', gate:'Gate', comp:'Comp', sat:'Sat',
  chorus:'Cho', flang:'Fla', delay:'Dly', ppd:'PP', verb:'Verb', trem:'Trem',
  filt:'Filt', wide:'Wide', lim:'Lim',
};
function defaultParams() {
  return {
    vol: 0.8, pan: 0, muted: false, solo: false,
    sendALvl: 0, sendADest: null, sendBLvl: 0, sendBDest: null,
    tune:  { on: false, speed: 0.65, key: 0, scale: 'major' },
    eq:    { on: true, lowF: 220, lowG: 0, pm1F: 1200, pm1Q: 0.9, pm1G: 0, pm2F: 4500, pm2Q: 0.9, pm2G: 0, highF: 6500, highG: 0 },
    deess: { on: false, freq: 6500, threshold: -24 },
    gate:  { on: false, threshold: -40, attack: 0.003, release: 0.2, range: 60 },
    comp:  { on: false, threshold: -18, ratio: 3, style: 'clean' },
    sat:   { on: false, drive: 0.4, tone: 6500 },
    chorus:{ on: false, rate: 1.2, depth: 0.5, mix: 0.35, sync: false },
    flang: { on: false, rate: 0.4, depth: 0.6, feedback: 0.5, mix: 0.35, sync: false },
    delay: { on: false, time: 0.32, feedback: 0.35, mix: 0.25, sync: false },
    ppd:   { on: false, time: 0.32, feedback: 0.35, mix: 0.25, sync: false },
    verb:  { on: false, mix: 0.3, size: 1.0, type: 'hall' },
    trem:  { on: false, rate: 4, depth: 0.5, sync: false },
    filt:  { on: false, rate: 0.8, depth: 0.7, base: 800, q: 4, sync: false },
    wide:  { on: false, width: 1.3 },
    lim:   { on: false, threshold: -3, release: 0.1 },
    rack:  { on: false, modules: [] },
  };
}

/* --------------------------- audio context ------------------------------ */
// Rebuild the whole audio engine (e.g. after changing session sample rate).
async function resetAudioEngine() {
  for (const id of Object.keys(S.monStreams || {})) {
    const m = S.monStreams[id];
    try { m.src.disconnect(); } catch (e) {}
    try { m.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }
  S.monStreams = {};
  for (const ch of allChannels()) { ch.monitoring = false; ch.nodes = null; ch._rackMods = null; }
  try { if (S.ctx) await S.ctx.close(); } catch (e) {}
  S.ctx = null; S.tuneOK = false; S.gateOK = false; S.masterFX = null; S.mchain = null;
  await ensureCtx();
  renderHeaders();
  toast('Audio engine running at ' + (S.ctx.sampleRate / 1000).toFixed(1) + ' kHz.');
}

async function ensureCtx() {
  if (S.ctx) {
    if (S.ctx.state === 'suspended') await S.ctx.resume();
    return S.ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('Web Audio is not supported in this browser.'); throw new Error('no webaudio'); }
  // session sample rate (44.1/48/96 kHz where the device allows)
  let ctx = null;
  const wantRate = S.io.sessionRate || 44100;
  try { ctx = new AC({ latencyHint: 'interactive', sampleRate: wantRate }); }
  catch (e) { ctx = new AC({ latencyHint: 'interactive' }); }
  S.ctx = ctx;

  // master path: masterIn -> master inserts (EQ/Comp/Lim) -> masterGain (fader)
  //            -> mastering chain (MEQ/multiband/imager/maximizer, A/B-able) -> destination
  // meters tap post-everything, so they reflect the full mix.
  S.masterIn = ctx.createGain();
  S.masterGain = ctx.createGain();
  S.masterGain.gain.value = S.master.vol;
  S.masterFX = {};
  let mHead = S.masterIn;
  for (const type of ['eq', 'comp', 'lim']) {
    const built = buildRackModuleNodes(ctx, type, true);
    const slot = makeSlot(ctx, () => built.ins, false);
    S.masterFX[type] = { slot, nd: built.nd };
    mHead.connect(slot.in); mHead = slot.out;
  }
  mHead.connect(S.masterGain);
  S.mchain = buildMasteringNodes(ctx);
  S.masterGain.connect(S.mchain.slot.in);
  S.mchain.slot.out.connect(ctx.destination);
  const mSplit = ctx.createChannelSplitter(2);
  S.masterAnL = ctx.createAnalyser(); S.masterAnR = ctx.createAnalyser();
  for (const a of [S.masterAnL, S.masterAnR]) { a.fftSize = 512; a.smoothingTimeConstant = 0.4; }
  S.mchain.slot.out.connect(mSplit);
  mSplit.connect(S.masterAnL, 0); mSplit.connect(S.masterAnR, 1);
  applyMasterFX(); applyMastering();

  // tune worklet
  try {
    const blob = new Blob([TUNE_WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    S.tuneOK = true;
  } catch (e) { S.tuneOK = false; }

  // gate worklet (noise gate) — optional; FX bypasses cleanly without it
  try {
    const blob = new Blob([GATE_WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    S.gateOK = true;
  } catch (e) { S.gateOK = false; }

  // restore saved output device
  if (S.io.outputId && S.io.outputId !== 'default' && ctx.setSinkId) {
    try { await ctx.setSinkId(S.io.outputId); } catch (e) { /* keep default */ }
  }

  buildLiveGraph();
  return ctx;
}

function buildLiveGraph() {
  const ctx = S.ctx;
  // buses
  for (const b of S.buses) {
    if (!b.node) b.node = ctx.createGain();
  }
  // channels
  for (const ch of [...S.tracks, ...S.auxes]) {
    if (!ch.nodes) ch.nodes = makeChannelNodes(ctx, ch, { meters: true, tuneOK: S.tuneOK, gateOK: S.gateOK });
    applyParamsToNodes(ch, ch.nodes);
  }
  S.G = {
    masterIn: S.masterIn,
    busNodes: new Map(S.buses.map(b => [b.id, b.node])),
    auxInputs: new Map(S.auxes.map(a => [a.id, a.nodes.input])),
  };
  for (const ch of [...S.tracks, ...S.auxes]) routeChannel(ch, ch.nodes, S.G);
  for (const b of S.buses) routeBus(b, S.G);
  // refresh any EQ curves now that live filter nodes exist
  for (const ch of [...S.tracks, ...S.auxes]) {
    if (ch._eqCanvas && ch._eqCanvas.isConnected) drawEQCurve(ch);
  }
}


/* ------------------------- channel node factory --------------------------
   Chain per channel (audio track or aux):
   input -> [mono-ize] -> tune -> eq -> deess -> gate -> comp -> sat
         -> chorus -> flanger -> delay -> pingpong -> verb -> trem -> filt
         -> wide -> lim -> fader -> pan -> mute -> out (routable)
   Slots are either 'insert' (dry/wet crossfade on bypass) or 'additive'
   (dry always passes, wet adds at mix level).
--------------------------------------------------------------------------- */
function setSatCurve(shaper, k) {
  // tanh drive curve; k -> 0 is transparent, higher k = more grit
  const n = 256, curve = new Float32Array(n);
  const tk = Math.tanh(Math.max(0.001, k));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / tk;
  }
  try { shaper.curve = curve; } catch (e) {}
}
function makeSlot(ctx, buildInsert, additive) {
  const inp = ctx.createGain(), out = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  wet.gain.value = 0; // start bypassed until params are applied
  inp.connect(dry); dry.connect(out);
  const ins = buildInsert();
  if (ins && ins.in && ins.out) { inp.connect(ins.in); ins.out.connect(wet); }
  wet.connect(out);
  let mixVal = 0.5;
  const hasInsert = !!(ins && ins.in && ins.out);
  const slot = {
    in: inp, out, _bypassed: true,
    setBypassed(b, t) {
      const tt = (t === undefined) ? ctx.currentTime : t;
      slot._bypassed = b;
      if (!hasInsert) {
        // effect unavailable (e.g. worklet failed): always pass dry
        dry.gain.setTargetAtTime(1, tt, 0.015);
        wet.gain.setTargetAtTime(0, tt, 0.015);
        return;
      }
      if (additive) {
        dry.gain.setTargetAtTime(1, tt, 0.015);
        wet.gain.setTargetAtTime(b ? 0 : mixVal, tt, 0.015);
      } else {
        dry.gain.setTargetAtTime(b ? 1 : 0, tt, 0.015);
        wet.gain.setTargetAtTime(b ? 0 : 1, tt, 0.015);
      }
    },
    setMix(m, t) {
      mixVal = m;
      if (additive && !slot._bypassed) {
        wet.gain.setTargetAtTime(m, (t === undefined) ? ctx.currentTime : t, 0.02);
      }
    },
  };
  return slot;
}

function makeReverbImpulse(ctx, seconds, type) {
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
  const imp = ctx.createBuffer(2, len, rate);
  const decay = type === 'plate' ? 3.4 : 2.6; // plate: tighter, denser
  for (let c = 0; c < 2; c++) {
    const d = imp.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const v = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      if (type === 'plate') { lp += 0.25 * (v - lp); d[i] = v * 0.6 + lp * 0.9; } // plate: darker-dense body
      else d[i] = v;
    }
  }
  return imp;
}

function makeChannelNodes(ctx, ch, opts) {
  const { meters = false, tuneOK = true, gateOK = true } = opts || {};
  const P = ch.params;
  const n = {};
  const input = ctx.createGain();
  n.input = input;
  let head = input;

  // mono-ize for mono channels: sum L+R -> dual-mono
  if (ch.format === 'mono') {
    const split = ctx.createChannelSplitter(2);
    const sum = ctx.createGain();
    const merge = ctx.createChannelMerger(2);
    head.connect(split); split.connect(sum, 0); split.connect(sum, 1);
    sum.connect(merge, 0, 0); sum.connect(merge, 0, 1);
    head = merge;
  }

  // TUNE (insert). Hard-bypassed when the worklet is unavailable.
  n.tuneSlot = makeSlot(ctx, () => {
    if (!tuneOK) return null;
    const wp = new AudioWorkletNode(ctx, 'dahyo-tune');
    wp.port.onmessage = (e) => { if (ch._tuneMsg) ch._tuneMsg(e.data); };
    n.tuneNode = wp;
    return { in: wp, out: wp };
  }, false);
  n.tuneNode = n.tuneNode || null;
  head.connect(n.tuneSlot.in); head = n.tuneSlot.out;

  // EQ — 4-band parametric (insert): low shelf, 2 peaking mids, high shelf
  n.eqLow = ctx.createBiquadFilter();  n.eqLow.type = 'lowshelf';  n.eqLow.frequency.value = 220;
  n.eqP1 = ctx.createBiquadFilter();   n.eqP1.type = 'peaking';    n.eqP1.frequency.value = 1200; n.eqP1.Q.value = 0.9;
  n.eqP2 = ctx.createBiquadFilter();   n.eqP2.type = 'peaking';    n.eqP2.frequency.value = 4500; n.eqP2.Q.value = 0.9;
  n.eqHigh = ctx.createBiquadFilter(); n.eqHigh.type = 'highshelf'; n.eqHigh.frequency.value = 6500;
  n.eqSlot = makeSlot(ctx, () => {
    n.eqLow.connect(n.eqP1); n.eqP1.connect(n.eqP2); n.eqP2.connect(n.eqHigh);
    return { in: n.eqLow, out: n.eqHigh };
  }, false);
  head.connect(n.eqSlot.in); head = n.eqSlot.out;

  // DE-ESSER (insert) — split-band: lows pass dry, sibilant highs get compressed
  n.deessLP = ctx.createBiquadFilter(); n.deessLP.type = 'lowpass'; n.deessLP.frequency.value = 6500;
  n.deessHP = ctx.createBiquadFilter(); n.deessHP.type = 'highpass'; n.deessHP.frequency.value = 6500;
  n.deessComp = ctx.createDynamicsCompressor();
  n.deessComp.ratio.value = 6; n.deessComp.attack.value = 0.002;
  n.deessComp.release.value = 0.12; n.deessComp.knee.value = 6;
  n.deessIn = ctx.createGain(); n.deessMix = ctx.createGain();
  n.deessIn.connect(n.deessLP); n.deessLP.connect(n.deessMix);
  n.deessIn.connect(n.deessHP); n.deessHP.connect(n.deessComp); n.deessComp.connect(n.deessMix);
  n.deessSlot = makeSlot(ctx, () => ({ in: n.deessIn, out: n.deessMix }), false);
  head.connect(n.deessSlot.in); head = n.deessSlot.out;

  // GATE (insert, AudioWorklet) — hard-bypassed when the worklet is unavailable
  n.gateSlot = makeSlot(ctx, () => {
    if (!gateOK) return null;
    const wp = new AudioWorkletNode(ctx, 'dahyo-gate');
    n.gateNode = wp;
    return { in: wp, out: wp };
  }, false);
  n.gateNode = n.gateNode || null;
  head.connect(n.gateSlot.in); head = n.gateSlot.out;

  // VOCAL RACK (insert slot) — serial sub-chain of vocal modules; bypassed when empty/off
  n.rackIn = ctx.createGain(); n.rackOut = ctx.createGain();
  n.rackIn.connect(n.rackOut);
  n.rackSlot = makeSlot(ctx, () => ({ in: n.rackIn, out: n.rackOut }), false);
  head.connect(n.rackSlot.in); head = n.rackSlot.out;
  rebuildRackChain(ch, gateOK);

  // COMPRESSOR (insert) + vintage color stage
  n.comp = ctx.createDynamicsCompressor();
  n.compColor = ctx.createWaveShaper();
  setSatCurve(n.compColor, 0.04);
  n.comp.connect(n.compColor);
  n.compSlot = makeSlot(ctx, () => ({ in: n.comp, out: n.compColor }), false);
  head.connect(n.compSlot.in); head = n.compSlot.out;

  // SATURATION (insert) — waveshaper drive + tone control
  n.satShaper = ctx.createWaveShaper();
  setSatCurve(n.satShaper, 0.4 * 6);
  n.satTone = ctx.createBiquadFilter(); n.satTone.type = 'lowpass'; n.satTone.frequency.value = 6500;
  n.satShaper.connect(n.satTone);
  n.satSlot = makeSlot(ctx, () => ({ in: n.satShaper, out: n.satTone }), false);
  head.connect(n.satSlot.in); head = n.satSlot.out;

  // CHORUS (additive) — dual modulated delays, stereo spread
  n.choSplit = ctx.createChannelSplitter(2);
  n.choD1 = ctx.createDelay(0.1); n.choD1.delayTime.value = 0.018;
  n.choD2 = ctx.createDelay(0.1); n.choD2.delayTime.value = 0.023;
  n.choLFO = ctx.createOscillator(); n.choLFO.frequency.value = 1.2;
  n.choLFO2 = ctx.createOscillator(); n.choLFO2.frequency.value = 1.36;
  n.choDepth = ctx.createGain(); n.choDepth.gain.value = 0.004;
  n.choDepth2 = ctx.createGain(); n.choDepth2.gain.value = 0.005;
  n.choLFO.connect(n.choDepth); n.choDepth.connect(n.choD1.delayTime);
  n.choLFO2.connect(n.choDepth2); n.choDepth2.connect(n.choD2.delayTime);
  n.choMerge = ctx.createChannelMerger(2);
  n.choSplit.connect(n.choD1, 0); n.choSplit.connect(n.choD2, 1);
  n.choD1.connect(n.choMerge, 0, 0); n.choD2.connect(n.choMerge, 0, 1);
  try { n.choLFO.start(); n.choLFO2.start(); } catch (e) {}
  n.chorusSlot = makeSlot(ctx, () => ({ in: n.choSplit, out: n.choMerge }), true);
  head.connect(n.chorusSlot.in); head = n.chorusSlot.out;

  // FLANGER (additive) — short modulated delay with feedback
  n.flD = ctx.createDelay(0.05); n.flD.delayTime.value = 0.004;
  n.flLFO = ctx.createOscillator(); n.flLFO.frequency.value = 0.4;
  n.flDepth = ctx.createGain(); n.flDepth.gain.value = 0.002;
  n.flFb = ctx.createGain(); n.flFb.gain.value = 0.5;
  n.flLFO.connect(n.flDepth); n.flDepth.connect(n.flD.delayTime);
  n.flD.connect(n.flFb); n.flFb.connect(n.flD);
  try { n.flLFO.start(); } catch (e) {}
  n.flangSlot = makeSlot(ctx, () => ({ in: n.flD, out: n.flD }), true);
  head.connect(n.flangSlot.in); head = n.flangSlot.out;

  // DELAY — additive (time / feedback / mix)
  n.dlNode = ctx.createDelay(2.0);
  n.dlFb = ctx.createGain();
  n.dlWet = ctx.createGain();
  n.dlNode.connect(n.dlFb); n.dlFb.connect(n.dlNode); // feedback loop (DelayNode breaks the cycle)
  n.dlNode.connect(n.dlWet);
  n.delaySlot = makeSlot(ctx, () => ({ in: n.dlNode, out: n.dlWet }), true);
  head.connect(n.delaySlot.in); head = n.delaySlot.out;

  // PING-PONG DELAY (additive) — echoes bounce left/right
  n.ppA = ctx.createDelay(2.0); n.ppA.delayTime.value = 0.32;
  n.ppB = ctx.createDelay(2.0); n.ppB.delayTime.value = 0.32;
  n.ppFb = ctx.createGain(); n.ppFb.gain.value = 0.35;
  n.ppWetL = ctx.createGain(); n.ppWetR = ctx.createGain();
  n.ppMerge = ctx.createChannelMerger(2);
  n.ppA.connect(n.ppWetL); n.ppWetL.connect(n.ppMerge, 0, 0);
  n.ppB.connect(n.ppWetR); n.ppWetR.connect(n.ppMerge, 0, 1);
  n.ppA.connect(n.ppFb); n.ppFb.connect(n.ppB);
  n.ppB.connect(n.ppFb); n.ppFb.connect(n.ppA);
  n.ppdSlot = makeSlot(ctx, () => ({ in: n.ppA, out: n.ppMerge }), true);
  head.connect(n.ppdSlot.in); head = n.ppdSlot.out;

  // REVERB — additive, generated stereo impulse (hall / plate)
  n.conv = ctx.createConvolver();
  try { n.conv.buffer = makeReverbImpulse(ctx, 2.2 * (P.verb.size || 1), P.verb.type || 'hall'); } catch (e) {}
  n.verbSlot = makeSlot(ctx, () => ({ in: n.conv, out: n.conv }), true);
  head.connect(n.verbSlot.in); head = n.verbSlot.out;

  // TREMOLO (insert) — LFO volume pulsing
  n.trGain = ctx.createGain(); n.trGain.gain.value = 0.75;
  n.trLFO = ctx.createOscillator(); n.trLFO.frequency.value = 4;
  n.trDepth = ctx.createGain(); n.trDepth.gain.value = 0.25;
  n.trLFO.connect(n.trDepth); n.trDepth.connect(n.trGain.gain);
  try { n.trLFO.start(); } catch (e) {}
  n.tremSlot = makeSlot(ctx, () => ({ in: n.trGain, out: n.trGain }), false);
  head.connect(n.tremSlot.in); head = n.tremSlot.out;

  // AUTO-FILTER / WAH (insert) — LFO-swept bandpass
  n.fiFilt = ctx.createBiquadFilter(); n.fiFilt.type = 'bandpass';
  n.fiFilt.frequency.value = 800; n.fiFilt.Q.value = 4;
  n.fiLFO = ctx.createOscillator(); n.fiLFO.frequency.value = 0.8;
  n.fiDepth = ctx.createGain(); n.fiDepth.gain.value = 560;
  n.fiLFO.connect(n.fiDepth); n.fiDepth.connect(n.fiFilt.frequency);
  try { n.fiLFO.start(); } catch (e) {}
  n.filtSlot = makeSlot(ctx, () => ({ in: n.fiFilt, out: n.fiFilt }), false);
  head.connect(n.filtSlot.in); head = n.filtSlot.out;

  // STEREO WIDENER (insert) — mid/side matrix
  n.wdSplit = ctx.createChannelSplitter(2);
  n.wdMA = ctx.createGain(); n.wdMA.gain.value = 0.5;
  n.wdMB = ctx.createGain(); n.wdMB.gain.value = 0.5;
  n.wdSA = ctx.createGain(); n.wdSA.gain.value = 0.5;
  n.wdSB = ctx.createGain(); n.wdSB.gain.value = -0.5;
  n.wdMid = ctx.createGain(); n.wdSide = ctx.createGain();
  n.wideSide = ctx.createGain(); n.wideSide.gain.value = 1.3;
  n.wdOutL = ctx.createGain(); n.wdOutR = ctx.createGain();
  n.wdNeg = ctx.createGain(); n.wdNeg.gain.value = -1;
  n.wdMerge = ctx.createChannelMerger(2);
  n.wdSplit.connect(n.wdMA, 0); n.wdSplit.connect(n.wdMB, 1);
  n.wdSplit.connect(n.wdSA, 0); n.wdSplit.connect(n.wdSB, 1);
  n.wdMA.connect(n.wdMid); n.wdMB.connect(n.wdMid);
  n.wdSA.connect(n.wdSide); n.wdSB.connect(n.wdSide);
  n.wdMid.connect(n.wdOutL); n.wdMid.connect(n.wdOutR);
  n.wdSide.connect(n.wideSide);
  n.wideSide.connect(n.wdOutL);
  n.wideSide.connect(n.wdNeg); n.wdNeg.connect(n.wdOutR);
  n.wdOutL.connect(n.wdMerge, 0, 0); n.wdOutR.connect(n.wdMerge, 0, 1);
  n.wideSlot = makeSlot(ctx, () => ({ in: n.wdSplit, out: n.wdMerge }), false);
  head.connect(n.wideSlot.in); head = n.wideSlot.out;

  // LIMITER (insert) — final safety net, loud without clipping
  n.lim = ctx.createDynamicsCompressor();
  n.lim.ratio.value = 20; n.lim.attack.value = 0.002; n.lim.knee.value = 0;
  n.limSlot = makeSlot(ctx, () => ({ in: n.lim, out: n.lim }), false);
  head.connect(n.limSlot.in); head = n.limSlot.out;

  // fader -> pan -> mute -> out ; sends + meters tap post-mute (post-fader)
  n.fader = ctx.createGain();
  n.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  n.muteG = ctx.createGain();
  n.out = ctx.createGain();
  n.sendA = ctx.createGain(); n.sendA.gain.value = 0;
  n.sendB = ctx.createGain(); n.sendB.gain.value = 0;
  head.connect(n.fader); n.fader.connect(n.pan); n.pan.connect(n.muteG);
  n.muteG.connect(n.out);
  n.muteG.connect(n.sendA); n.muteG.connect(n.sendB);

  if (meters) {
    const split = ctx.createChannelSplitter(2);
    n.anL = ctx.createAnalyser(); n.anR = ctx.createAnalyser();
    for (const a of [n.anL, n.anR]) { a.fftSize = 512; a.smoothingTimeConstant = 0.35; }
    n.muteG.connect(split); split.connect(n.anL, 0); split.connect(n.anR, 1);
    n._meterBuf = new Float32Array(512);
  }
  return n;
}

/* --------------------- params -> nodes (live & export) ------------------- */
function pushTuneParams(ch, nodes) {
  const wp = nodes.tuneNode;
  if (!wp) return;
  const T = ch.params.tune;
  try {
    wp.port.postMessage({
      speed: T.speed, key: T.key,
      scale: SCALES[T.scale] || SCALES.major,
      bypass: !T.on,
    });
  } catch (e) {}
}

function pushGateParams(ch, nodes) {
  const wp = nodes.gateNode;
  if (!wp) return;
  const G = ch.params.gate;
  try {
    wp.port.postMessage({
      threshold: G.threshold, attack: G.attack, release: G.release,
      range: G.range, bypass: !G.on,
    });
  } catch (e) {}
}

function applyParamsToNodes(ch, nodes) {
  if (ch.isMaster) { applyMasterFX(ch); return; }
  const P = ch.params, ctx = nodes.fader.context, t = ctx.currentTime;
  const anySolo = [...S.tracks, ...S.auxes].some(c => c.params.solo);
  const audible = !P.muted && !(anySolo && !P.solo);
  nodes.fader.gain.setTargetAtTime(P.vol * P.vol, t, 0.02);
  if (nodes.pan.pan) nodes.pan.pan.setTargetAtTime(P.pan, t, 0.02);
  nodes.muteG.gain.setTargetAtTime(audible ? 1 : 0, t, 0.015);
  nodes.sendA.gain.setTargetAtTime(P.sendALvl, t, 0.02);
  nodes.sendB.gain.setTargetAtTime(P.sendBLvl, t, 0.02);
  const bpm = S.bpm || 120;
  const dotted8 = (60 / bpm) * 0.75; // dotted-eighth at project tempo
  // fx chain: Tune -> EQ -> DeEss -> Gate -> Comp -> Sat -> Chorus -> Flanger
  //         -> Delay -> PingPong -> Verb -> Tremolo -> Filter -> Widener -> Limiter
  nodes.tuneSlot.setBypassed(!P.tune.on, t);
  pushTuneParams(ch, nodes);
  nodes.eqSlot.setBypassed(!P.eq.on, t);
  nodes.eqLow.frequency.setTargetAtTime(P.eq.lowF, t, 0.02);
  nodes.eqLow.gain.setTargetAtTime(P.eq.lowG, t, 0.02);
  nodes.eqP1.frequency.setTargetAtTime(P.eq.pm1F, t, 0.02);
  nodes.eqP1.Q.setTargetAtTime(P.eq.pm1Q, t, 0.02);
  nodes.eqP1.gain.setTargetAtTime(P.eq.pm1G, t, 0.02);
  nodes.eqP2.frequency.setTargetAtTime(P.eq.pm2F, t, 0.02);
  nodes.eqP2.Q.setTargetAtTime(P.eq.pm2Q, t, 0.02);
  nodes.eqP2.gain.setTargetAtTime(P.eq.pm2G, t, 0.02);
  nodes.eqHigh.frequency.setTargetAtTime(P.eq.highF, t, 0.02);
  nodes.eqHigh.gain.setTargetAtTime(P.eq.highG, t, 0.02);
  nodes.deessSlot.setBypassed(!P.deess.on, t);
  nodes.deessLP.frequency.setTargetAtTime(P.deess.freq, t, 0.02);
  nodes.deessHP.frequency.setTargetAtTime(P.deess.freq, t, 0.02);
  nodes.deessComp.threshold.setTargetAtTime(P.deess.threshold, t, 0.02);
  nodes.gateSlot.setBypassed(!P.gate.on, t);
  pushGateParams(ch, nodes);
  nodes.compSlot.setBypassed(!P.comp.on, t);
  nodes.comp.threshold.setTargetAtTime(P.comp.threshold, t, 0.02);
  nodes.comp.ratio.setTargetAtTime(P.comp.ratio, t, 0.02);
  if (P.comp.style === 'vintage') {
    nodes.comp.attack.setTargetAtTime(0.03, t, 0.02);
    nodes.comp.release.setTargetAtTime(0.4, t, 0.02);
  } else {
    nodes.comp.attack.setTargetAtTime(0.003, t, 0.02);
    nodes.comp.release.setTargetAtTime(0.12, t, 0.02);
  }
  setSatCurve(nodes.compColor, P.comp.style === 'vintage' ? 0.7 : 0.04);
  nodes.satSlot.setBypassed(!P.sat.on, t);
  setSatCurve(nodes.satShaper, P.sat.drive * 6);
  nodes.satTone.frequency.setTargetAtTime(P.sat.tone, t, 0.02);
  // chorus (sync = half-note wobble at project tempo)
  const chRate = P.chorus.sync ? bpm / 120 : P.chorus.rate;
  nodes.chorusSlot.setMix(P.chorus.mix, t);
  nodes.chorusSlot.setBypassed(!P.chorus.on, t);
  nodes.choLFO.frequency.setTargetAtTime(chRate, t, 0.02);
  nodes.choLFO2.frequency.setTargetAtTime(chRate * 1.13, t, 0.02);
  nodes.choDepth.gain.setTargetAtTime(P.chorus.depth * 0.008, t, 0.02);
  nodes.choDepth2.gain.setTargetAtTime(P.chorus.depth * 0.010, t, 0.02);
  // flanger
  const flRate = P.flang.sync ? bpm / 240 : P.flang.rate;
  nodes.flangSlot.setMix(P.flang.mix, t);
  nodes.flangSlot.setBypassed(!P.flang.on, t);
  nodes.flLFO.frequency.setTargetAtTime(flRate, t, 0.02);
  nodes.flDepth.gain.setTargetAtTime(P.flang.depth * 0.0035, t, 0.02);
  nodes.flFb.gain.setTargetAtTime(Math.min(0.85, P.flang.feedback), t, 0.02);
  // delay
  const dTime = P.delay.sync ? dotted8 : P.delay.time;
  nodes.delaySlot.setMix(P.delay.mix * 1.3, t);
  nodes.delaySlot.setBypassed(!P.delay.on, t);
  nodes.dlNode.delayTime.setTargetAtTime(Math.min(1.9, Math.max(0.01, dTime)), t, 0.02);
  nodes.dlFb.gain.setTargetAtTime(Math.min(0.9, P.delay.feedback), t, 0.02);
  // ping-pong
  const ppTime = P.ppd.sync ? dotted8 : P.ppd.time;
  nodes.ppdSlot.setMix(P.ppd.mix * 1.3, t);
  nodes.ppdSlot.setBypassed(!P.ppd.on, t);
  nodes.ppA.delayTime.setTargetAtTime(Math.min(1.9, Math.max(0.01, ppTime)), t, 0.02);
  nodes.ppB.delayTime.setTargetAtTime(Math.min(1.9, Math.max(0.01, ppTime)), t, 0.02);
  nodes.ppFb.gain.setTargetAtTime(Math.min(0.9, P.ppd.feedback), t, 0.02);
  // reverb
  nodes.verbSlot.setMix(0.1 + P.verb.mix * 1.6, t);
  nodes.verbSlot.setBypassed(!P.verb.on, t);
  // tremolo (sync = 8th-note pulse)
  const trRate = P.trem.sync ? bpm / 30 : P.trem.rate;
  nodes.tremSlot.setBypassed(!P.trem.on, t);
  nodes.trLFO.frequency.setTargetAtTime(trRate, t, 0.02);
  nodes.trDepth.gain.setTargetAtTime(P.trem.depth / 2, t, 0.02);
  nodes.trGain.gain.setTargetAtTime(1 - P.trem.depth / 2, t, 0.02);
  // auto-filter wah (sync = quarter-note sweep)
  const fRate = P.filt.sync ? bpm / 60 : P.filt.rate;
  nodes.filtSlot.setBypassed(!P.filt.on, t);
  nodes.fiLFO.frequency.setTargetAtTime(fRate, t, 0.02);
  nodes.fiDepth.gain.setTargetAtTime(P.filt.depth * P.filt.base, t, 0.02);
  nodes.fiFilt.frequency.setTargetAtTime(P.filt.base, t, 0.02);
  nodes.fiFilt.Q.setTargetAtTime(P.filt.q, t, 0.02);
  // widener
  nodes.wideSlot.setBypassed(!P.wide.on, t);
  nodes.wideSide.gain.setTargetAtTime(P.wide.width, t, 0.02);
  // limiter
  nodes.limSlot.setBypassed(!P.lim.on, t);
  nodes.lim.threshold.setTargetAtTime(P.lim.threshold, t, 0.02);
  nodes.lim.release.setTargetAtTime(P.lim.release, t, 0.02);
  // vocal rack slot
  const R = P.rack;
  nodes.rackSlot.setBypassed(!R || !R.on || !rackHasModules(ch), t);
  if (ch._rackMods) for (const m of ch._rackMods) applyRackModuleNodes(m.spec.type, m.nd, m.spec.params, t);
}

/* ------------------------------- vocal rack -------------------------------
   "Vocal Rack" — ONE plugin in the library list. Inserting it opens the rack
   window: a serial sub-chain of vocal modules (gate/de-esser/EQ/comp/
   saturator/doubler/widener) living in their own insert slot between the
   channel's gate and compressor. Modules reorder (up/down), bypass, add and
   remove; each keeps full controls + Auto. Original DAhYO DSP throughout. */
const RACK_TYPES = {
  gate:    { name: 'Gate',     desc: 'Cuts hiss between phrases' },
  deess:   { name: 'De-Esser', desc: 'Tames harsh S sounds' },
  eq:      { name: 'Rack EQ',   desc: '4-band tone shaping' },
  comp:    { name: 'Comp',     desc: 'Evens out the vocal' },
  sat:     { name: 'Saturate', desc: 'Warmth and grit' },
  doubler: { name: 'Doubler',  desc: 'Thickens with tiny doubles' },
  wide:    { name: 'Widener',  desc: 'Stereo spread' },
};
const RACK_PRESETS = {
  lead:   { name: 'Lead Vocal',        modules: ['gate', 'deess', 'eq', 'comp', 'sat'] },
  adlib:  { name: 'Ad-libs',           modules: ['deess', 'eq', 'comp', 'doubler'] },
  stacks: { name: 'Stacked Harmonies', modules: ['eq', 'comp', 'doubler', 'wide'] },
  radio:  { name: 'Radio Voice',       modules: ['gate', 'eq', 'comp', 'sat'] },
};
function rackModuleDefaults(type) {
  if (type === 'doubler') return { mix: 0.35, width: 0.6, rate: 0.9 };
  return JSON.parse(JSON.stringify(defaultParams()[type]));
}
// Build one module's node set. Returns {nd, ins:{in,out}} or null (gate w/o worklet).
function buildRackModuleNodes(ctx, type, gateOK) {
  const nd = {};
  let ins = null;
  if (type === 'gate') {
    if (!gateOK) return null;
    const wp = new AudioWorkletNode(ctx, 'dahyo-gate');
    nd.wp = wp; ins = { in: wp, out: wp };
  } else if (type === 'deess') {
    nd.lp = ctx.createBiquadFilter(); nd.lp.type = 'lowpass'; nd.lp.frequency.value = 6500;
    nd.hp = ctx.createBiquadFilter(); nd.hp.type = 'highpass'; nd.hp.frequency.value = 6500;
    nd.cp = ctx.createDynamicsCompressor();
    nd.cp.ratio.value = 6; nd.cp.attack.value = 0.002; nd.cp.release.value = 0.12; nd.cp.knee.value = 6;
    nd.in = ctx.createGain(); nd.mix = ctx.createGain();
    nd.in.connect(nd.lp); nd.lp.connect(nd.mix);
    nd.in.connect(nd.hp); nd.hp.connect(nd.cp); nd.cp.connect(nd.mix);
    ins = { in: nd.in, out: nd.mix };
  } else if (type === 'eq') {
    nd.low = ctx.createBiquadFilter(); nd.low.type = 'lowshelf'; nd.low.frequency.value = 220;
    nd.p1 = ctx.createBiquadFilter(); nd.p1.type = 'peaking'; nd.p1.frequency.value = 1200; nd.p1.Q.value = 0.9;
    nd.p2 = ctx.createBiquadFilter(); nd.p2.type = 'peaking'; nd.p2.frequency.value = 4500; nd.p2.Q.value = 0.9;
    nd.high = ctx.createBiquadFilter(); nd.high.type = 'highshelf'; nd.high.frequency.value = 6500;
    nd.low.connect(nd.p1); nd.p1.connect(nd.p2); nd.p2.connect(nd.high);
    ins = { in: nd.low, out: nd.high };
  } else if (type === 'comp') {
    nd.cp = ctx.createDynamicsCompressor();
    nd.col = ctx.createWaveShaper(); setSatCurve(nd.col, 0.04);
    nd.cp.connect(nd.col);
    ins = { in: nd.cp, out: nd.col };
  } else if (type === 'sat') {
    nd.sh = ctx.createWaveShaper(); setSatCurve(nd.sh, 2.4);
    nd.tone = ctx.createBiquadFilter(); nd.tone.type = 'lowpass'; nd.tone.frequency.value = 6500;
    nd.sh.connect(nd.tone);
    ins = { in: nd.sh, out: nd.tone };
  } else if (type === 'doubler') {
    nd.in = ctx.createGain(); nd.out = ctx.createGain();
    nd.dry = ctx.createGain();
    nd.split = ctx.createChannelSplitter(2);
    nd.dL = ctx.createDelay(0.1); nd.dL.delayTime.value = 0.018;
    nd.dR = ctx.createDelay(0.1); nd.dR.delayTime.value = 0.026;
    nd.lfo1 = ctx.createOscillator(); nd.lfo1.frequency.value = 0.8;
    nd.lfo2 = ctx.createOscillator(); nd.lfo2.frequency.value = 1.1;
    nd.dp1 = ctx.createGain(); nd.dp1.gain.value = 0.004;
    nd.dp2 = ctx.createGain(); nd.dp2.gain.value = 0.004;
    nd.lfo1.connect(nd.dp1); nd.dp1.connect(nd.dL.delayTime);
    nd.lfo2.connect(nd.dp2); nd.dp2.connect(nd.dR.delayTime);
    nd.merge = ctx.createChannelMerger(2);
    nd.wet = ctx.createGain(); nd.wet.gain.value = 0.35;
    nd.in.connect(nd.dry); nd.dry.connect(nd.out);
    nd.in.connect(nd.split);
    nd.split.connect(nd.dL, 0); nd.split.connect(nd.dR, 1);
    nd.dL.connect(nd.merge, 0, 0); nd.dR.connect(nd.merge, 0, 1);
    nd.merge.connect(nd.wet); nd.wet.connect(nd.out);
    try { nd.lfo1.start(); nd.lfo2.start(); } catch (e) {}
    ins = { in: nd.in, out: nd.out };
  } else if (type === 'lim') {
    nd.cp = ctx.createDynamicsCompressor();
    nd.cp.ratio.value = 20; nd.cp.attack.value = 0.002; nd.cp.knee.value = 0;
    ins = { in: nd.cp, out: nd.cp };
  } else if (type === 'wide') {
    nd.split = ctx.createChannelSplitter(2);
    nd.mA = ctx.createGain(); nd.mA.gain.value = 0.5;
    nd.mB = ctx.createGain(); nd.mB.gain.value = 0.5;
    nd.sA = ctx.createGain(); nd.sA.gain.value = 0.5;
    nd.sB = ctx.createGain(); nd.sB.gain.value = -0.5;
    nd.mid = ctx.createGain(); nd.side = ctx.createGain();
    nd.sideG = ctx.createGain(); nd.sideG.gain.value = 1.3;
    nd.oL = ctx.createGain(); nd.oR = ctx.createGain();
    nd.neg = ctx.createGain(); nd.neg.gain.value = -1;
    nd.merge = ctx.createChannelMerger(2);
    nd.split.connect(nd.mA, 0); nd.split.connect(nd.mB, 1);
    nd.split.connect(nd.sA, 0); nd.split.connect(nd.sB, 1);
    nd.mA.connect(nd.mid); nd.mB.connect(nd.mid);
    nd.sA.connect(nd.side); nd.sB.connect(nd.side);
    nd.mid.connect(nd.oL); nd.mid.connect(nd.oR);
    nd.side.connect(nd.sideG);
    nd.sideG.connect(nd.oL); nd.sideG.connect(nd.neg); nd.neg.connect(nd.oR);
    nd.oL.connect(nd.merge, 0, 0); nd.oR.connect(nd.merge, 0, 1);
    ins = { in: nd.split, out: nd.merge };
  }
  return ins ? { nd, ins } : null;
}
function applyRackModuleNodes(type, nd, P, t) {
  if (!nd || !P) return;
  if (type === 'gate') {
    try { nd.wp.port.postMessage({ threshold: P.threshold, attack: P.attack, release: P.release, range: P.range, bypass: false }); } catch (e) {}
  } else if (type === 'deess') {
    nd.lp.frequency.setTargetAtTime(P.freq, t, 0.02);
    nd.hp.frequency.setTargetAtTime(P.freq, t, 0.02);
    nd.cp.threshold.setTargetAtTime(P.threshold, t, 0.02);
  } else if (type === 'eq') {
    nd.low.frequency.setTargetAtTime(P.lowF, t, 0.02); nd.low.gain.setTargetAtTime(P.lowG, t, 0.02);
    nd.p1.frequency.setTargetAtTime(P.pm1F, t, 0.02); nd.p1.Q.setTargetAtTime(P.pm1Q, t, 0.02); nd.p1.gain.setTargetAtTime(P.pm1G, t, 0.02);
    nd.p2.frequency.setTargetAtTime(P.pm2F, t, 0.02); nd.p2.Q.setTargetAtTime(P.pm2Q, t, 0.02); nd.p2.gain.setTargetAtTime(P.pm2G, t, 0.02);
    nd.high.frequency.setTargetAtTime(P.highF, t, 0.02); nd.high.gain.setTargetAtTime(P.highG, t, 0.02);
  } else if (type === 'comp') {
    nd.cp.threshold.setTargetAtTime(P.threshold, t, 0.02);
    nd.cp.ratio.setTargetAtTime(P.ratio, t, 0.02);
    if (P.style === 'vintage') { nd.cp.attack.setTargetAtTime(0.03, t, 0.02); nd.cp.release.setTargetAtTime(0.4, t, 0.02); }
    else { nd.cp.attack.setTargetAtTime(0.003, t, 0.02); nd.cp.release.setTargetAtTime(0.12, t, 0.02); }
    setSatCurve(nd.col, P.style === 'vintage' ? 0.7 : 0.04);
  } else if (type === 'sat') {
    setSatCurve(nd.sh, P.drive * 6);
    nd.tone.frequency.setTargetAtTime(P.tone, t, 0.02);
  } else if (type === 'doubler') {
    nd.wet.gain.setTargetAtTime(P.mix, t, 0.02);
    nd.dp1.gain.setTargetAtTime(P.width * 0.006, t, 0.02);
    nd.dp2.gain.setTargetAtTime(P.width * 0.007, t, 0.02);
    nd.lfo1.frequency.setTargetAtTime(P.rate, t, 0.02);
    nd.lfo2.frequency.setTargetAtTime(P.rate * 1.31, t, 0.02);
  } else if (type === 'wide') {
    nd.sideG.gain.setTargetAtTime(P.width, t, 0.02);
  } else if (type === 'lim') {
    nd.cp.threshold.setTargetAtTime(P.threshold, t, 0.02);
    nd.cp.release.setTargetAtTime(P.release, t, 0.02);
  }
}
// (Re)build the rack sub-chain wiring for a channel. Structural changes only;
// param tweaks go through applyRackModuleNodes.
function rebuildRackChain(ch, gateOK) {
  const nodes = ch.nodes;
  if (!nodes || !nodes.rackIn) return;
  const ctx = nodes.rackIn.context, t = ctx.currentTime;
  if (ch._rackMods) for (const m of ch._rackMods) {
    try { m.ins.in.disconnect(); } catch (e) {}
    try { m.ins.out.disconnect(); } catch (e) {}
  }
  try { nodes.rackIn.disconnect(); } catch (e) {}
  ch._rackMods = [];
  const R = ch.params.rack;
  let head = nodes.rackIn;
  for (const spec of ((R && R.modules) || [])) {
    if (!spec.on) continue;
    const built = buildRackModuleNodes(ctx, spec.type, gateOK);
    if (!built) continue;
    try { head.connect(built.ins.in); } catch (e) { continue; }
    head = built.ins.out;
    ch._rackMods.push({ spec, nd: built.nd, ins: built.ins });
    applyRackModuleNodes(spec.type, built.nd, spec.params, t);
  }
  try { head.connect(nodes.rackOut); } catch (e) {}
}
function rackHasModules(ch) {
  const R = ch.params.rack;
  return !!(R && R.modules && R.modules.some(m => m.on));
}

function applyChannelParams(ch) {
  if (ch.isMaster) { applyMasterFX(); return; }
  if (ch.nodes) applyParamsToNodes(ch, ch.nodes);
  syncChannelMeters(ch);
}

/* ------------------------------ routing ---------------------------------- */
function destNodeFor(ch, G) {
  if (ch.output === 'master' || !ch.output) return G.masterIn;
  return G.busNodes.get(ch.output) || G.masterIn;
}

function routeChannel(ch, nodes, G) {
  try { nodes.out.disconnect(); } catch (e) {}
  nodes.out.connect(destNodeFor(ch, G));
  routeSend(ch, nodes, 'A', G);
  routeSend(ch, nodes, 'B', G);
}

function routeSend(ch, nodes, which, G) {
  const g = which === 'A' ? nodes.sendA : nodes.sendB;
  try { g.disconnect(); } catch (e) {}
  const destId = which === 'A' ? ch.params.sendADest : ch.params.sendBDest;
  if (!destId) return;
  if (G.busNodes.has(destId)) g.connect(G.busNodes.get(destId));
  else if (G.auxInputs.has(destId)) g.connect(G.auxInputs.get(destId));
}

function routeBus(bus, G) {
  const node = G.busNodes.get(bus.id);
  if (!node) return;
  try { node.disconnect(); } catch (e) {}
  if (bus.output && bus.output !== 'master' && G.auxInputs.has(bus.output)) {
    node.connect(G.auxInputs.get(bus.output));
  } else {
    node.connect(G.masterIn);
  }
}

function rerouteAll() {
  if (!S.G) return;
  for (const ch of [...S.tracks, ...S.auxes]) routeChannel(ch, ch.nodes, S.G);
  for (const b of S.buses) routeBus(b, S.G);
}

// channels feeding a given aux (for display)
function busesFeedingAux(auxId) {
  return S.buses.filter(b => b.output === auxId);
}

/* --------------------------- channel management -------------------------- */
function allChannels() { return [...S.tracks, ...S.auxes]; }
function getChannel(id) {
  if (id === 'master') return getMasterCh();
  return allChannels().find(c => c.id === id) || null;
}

function addAudioTrack(opts) {
  const o = opts || {};
  if (!o._noUndo) Undo.push('Add track');
  const n = S.tracks.length + 1;
  const tr = {
    id: uid('tr'), kind: 'audio',
    name: o.name || ('Audio ' + n),
    format: o.format || 'stereo',
    input: o.input || 'default',
    output: o.output || 'master',
    clips: [], recArmed: false,
    params: defaultParams(),
    nodes: null,
  };
  S.tracks.push(tr);
  if (S.ctx) {
    tr.nodes = makeChannelNodes(S.ctx, tr, { meters: true, tuneOK: S.tuneOK });
    applyParamsToNodes(tr, tr.nodes);
    rebuildLiveRoutingMaps();
    routeChannel(tr, tr.nodes, S.G);
  }
  if (!S.selId) S.selId = tr.id;
  renderHeaders(); renderMixer(); renderInspector(); renderIORouting();
  saveSession();
  return tr;
}

function addAuxTrack(opts) {
  const o = opts || {};
  if (!o._noUndo) Undo.push('Add aux');
  const n = S.auxes.length + 1;
  const aux = {
    id: uid('aux'), kind: 'aux',
    name: o.name || ('Aux ' + n),
    format: o.format || 'stereo',
    output: 'master',
    params: defaultParams(),
    nodes: null, busId: null,
  };
  // auto-create a bus already routed to this aux's input
  const bus = addBus({ name: aux.name + ' In', format: aux.format, silent: true });
  bus.output = aux.id;
  aux.busId = bus.id;
  S.auxes.push(aux);
  if (S.ctx) {
    aux.nodes = makeChannelNodes(S.ctx, aux, { meters: true, tuneOK: S.tuneOK });
    applyParamsToNodes(aux, aux.nodes);
    rebuildLiveRoutingMaps();
    routeChannel(aux, aux.nodes, S.G);
    routeBus(bus, S.G);
  }
  S.selId = aux.id;
  renderHeaders(); renderMixer(); renderInspector(); renderIO();
  saveSession();
  toast(aux.name + ' created — send any track to "' + bus.name + '" for instant FX throws.');
  return aux;
}

function addBus(opts) {
  const o = opts || {};
  const bus = {
    id: uid('bus'),
    name: o.name || ('Bus ' + (S.buses.length + 1)),
    format: o.format || 'stereo',
    output: 'master',
    node: null,
  };
  S.buses.push(bus);
  if (S.ctx && !o.deferNode) {
    bus.node = S.ctx.createGain();
    rebuildLiveRoutingMaps();
    routeBus(bus, S.G);
  }
  if (!o.silent) { renderIO(); renderInspector(); renderMixer(); saveSession(); }
  return bus;
}

function rebuildLiveRoutingMaps() {
  if (!S.ctx) return;
  S.G = {
    masterIn: S.masterIn,
    busNodes: new Map(S.buses.map(b => [b.id, b.node])),
    auxInputs: new Map(S.auxes.filter(a => a.nodes).map(a => [a.id, a.nodes.input])),
  };
}

function deleteChannel(id) {
  const ti = S.tracks.findIndex(t => t.id === id);
  const ai = S.auxes.findIndex(a => a.id === id);
  const ch = ti >= 0 ? S.tracks[ti] : S.auxes[ai];
  if (!ch) return;
  Undo.push('Delete ' + (ch.kind === 'aux' ? 'aux' : 'track'));
  stopSourcesOnChannel(ch);
  if (ch.nodes) {
    try { ch.nodes.input.disconnect(); } catch (e) {}
    ['tuneSlot','eqSlot','compSlot','delaySlot','verbSlot'].forEach(k => {
      try { ch.nodes[k].in.disconnect(); ch.nodes[k].out.disconnect(); } catch (e) {}
    });
  }
  if (ti >= 0) S.tracks.splice(ti, 1); else S.auxes.splice(ai, 1);
  // clear sends / bus outputs that pointed at the deleted channel
  for (const c of allChannels()) {
    if (c.params.sendADest === id) { c.params.sendADest = null; c.params.sendALvl = 0; }
    if (c.params.sendBDest === id) { c.params.sendBDest = null; c.params.sendBLvl = 0; }
  }
  for (const b of S.buses) if (b.output === id) b.output = 'master';
  // if it was an aux, delete its auto bus too (if no other routing uses it)
  if (ch.kind === 'aux' && ch.busId) deleteBus(ch.busId, true);
  if (S.selId === id) S.selId = (S.tracks[0] || S.auxes[0] || {}).id || null;
  rebuildLiveRoutingMaps(); rerouteAll();
  renderHeaders(); renderMixer(); renderInspector(); renderIO();
  saveSession();
}

function deleteBus(id, quiet) {
  const i = S.buses.findIndex(b => b.id === id);
  if (i < 0) return;
  if (!quiet) Undo.push('Delete bus');
  const bus = S.buses[i];
  if (bus.node) { try { bus.node.disconnect(); } catch (e) {} }
  S.buses.splice(i, 1);
  // reroute anything pointing at it
  for (const ch of allChannels()) {
    if (ch.output === id) ch.output = 'master';
    if (ch.params.sendADest === id) { ch.params.sendADest = null; ch.params.sendALvl = 0; }
    if (ch.params.sendBDest === id) { ch.params.sendBDest = null; ch.params.sendBLvl = 0; }
    if (ch.kind === 'aux' && ch.busId === id) ch.busId = null;
  }
  rebuildLiveRoutingMaps(); rerouteAll();
  if (!quiet) { renderIO(); renderInspector(); renderMixer(); saveSession(); toast('Bus deleted — routing reset to Master.'); }
}

/* ------------------------------- clips ----------------------------------- */
function computePeaks(buffer, n = 400) {
  const d = buffer.getChannelData(0), peaks = new Float32Array(n);
  const step = Math.max(1, Math.floor(d.length / n));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const start = i * step, end = Math.min(d.length, start + step);
    for (let j = start; j < end; j += 7) { const a = Math.abs(d[j]); if (a > m) m = a; }
    peaks[i] = m;
  }
  return peaks;
}

/*__ANALYZE_BEGIN__*/
/* ==================== audio analysis (pure DSP — no DOM) ====================
   Used by: import-time BPM/key finder, and every plugin's "Auto" button.
   All functions take an AudioBuffer and return plain data. Testable in Node. */
function _fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = t;
      }
    }
  }
}
function _monoDownsample(buffer, targetRate, maxSecs) {
  const sr = buffer.sampleRate, nCh = buffer.numberOfChannels;
  const total = Math.floor(Math.min(buffer.duration, maxSecs || 90) * sr);
  const step = Math.max(1, sr / targetRate);
  const outLen = Math.max(1, Math.floor(total / step));
  const out = new Float32Array(outLen);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < outLen; i++) {
    const idx = Math.min(total - 1, Math.floor(i * step));
    let s = 0;
    for (let c = 0; c < nCh; c++) s += chans[c][idx];
    out[i] = s / nCh;
  }
  return { data: out, rate: targetRate };
}
function _db(v) { return 20 * Math.log10(Math.max(1e-7, v)); }

function analyzeLevels(buffer) {
  const { data } = _monoDownsample(buffer, 8000, 60);
  let peak = 0, sum = 0;
  const frames = [], F = 1024;
  for (let i = 0; i < data.length; i += F) {
    let e = 0; const n = Math.min(F, data.length - i);
    for (let j = 0; j < n; j++) { const s = data[i + j]; e += s * s; const a = Math.abs(s); if (a > peak) peak = a; }
    e = Math.sqrt(e / Math.max(1, n));
    frames.push(e); sum += e;
  }
  if (!frames.length) return { peakDb: -96, rmsDb: -96, noiseFloorDb: -96, crestDb: 0 };
  frames.sort((a, b) => a - b);
  const noiseFloor = frames[Math.floor(frames.length * 0.1)] || 1e-6;
  const rms = sum / frames.length || 1e-6;
  const peakDb = _db(peak), rmsDb = _db(rms);
  return { peakDb, rmsDb, noiseFloorDb: _db(noiseFloor), crestDb: Math.max(0, peakDb - rmsDb) };
}

function analyzeTempo(buffer) {
  const { data, rate } = _monoDownsample(buffer, 11025, 90);
  const N = 1024, H = 512, half = N / 2;
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(half);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const env = [];
  let first = true;
  for (let off = 0; off + N <= data.length; off += H) {
    for (let i = 0; i < N; i++) { re[i] = data[off + i] * win[i]; im[i] = 0; }
    _fft(re, im);
    let flux = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.hypot(re[k], im[k]) / half;
      const w = 1 + (k / half) * 3; // drums/transients live up high
      if (!first) { const d = m - prev[k]; if (d > 0) flux += d * w; }
      prev[k] = m;
    }
    first = false;
    env.push(flux);
  }
  if (env.length < 40) return { bpm: 0, confidence: 0 };
  let mean = 0; for (const v of env) mean += v; mean /= env.length;
  let peak = 0;
  const e2 = env.map(v => { const x = Math.max(0, v - mean); if (x > peak) peak = x; return x; });
  if (peak < 1e-9) return { bpm: 0, confidence: 0 };
  const fps = rate / H;
  const minLag = Math.max(2, Math.floor(fps * 60 / 200)), maxLag = Math.ceil(fps * 60 / 50);
  const ac = new Float32Array(maxLag + 1);
  let bestLag = 0, bestVal = -1, acMean = 0, cnt = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < e2.length; i++) s += e2[i] * e2[i + lag];
    ac[lag] = s; acMean += s; cnt++;
    if (s > bestVal) { bestVal = s; bestLag = lag; }
  }
  if (bestLag === 0) return { bpm: 0, confidence: 0 };
  acMean /= Math.max(1, cnt);
  // octave disambiguation: prefer a musically sensible tempo when close in strength
  const cand = [bestLag];
  if (bestLag * 2 <= maxLag) cand.push(bestLag * 2);
  if (Math.floor(bestLag / 2) >= minLag) cand.push(Math.floor(bestLag / 2));
  let chosen = bestLag, chosenVal = bestVal;
  for (const l of cand) {
    const b = 60 * fps / l;
    if (b >= 80 && b <= 160 && ac[l] > chosenVal * 0.82) { chosen = l; chosenVal = ac[l]; }
  }
  let lag = chosen; // parabolic interpolation for sub-frame accuracy
  if (chosen > minLag && chosen < maxLag) {
    const a = ac[chosen - 1], b = ac[chosen], c = ac[chosen + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) lag = chosen + 0.5 * (a - c) / den;
  }
  const bpm = 60 * fps / lag;
  const conf = Math.min(1, Math.max(0, (bestVal / (acMean + 1e-12) - 1) / 8));
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(conf * 100) / 100 };
}

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function analyzeKey(buffer) {
  const { data, rate } = _monoDownsample(buffer, 22050, 90);
  const N = 4096, H = 2048;
  const re = new Float32Array(N), im = new Float32Array(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const chroma = new Float32Array(12);
  let frames = 0;
  for (let off = 0; off + N <= data.length; off += H) {
    for (let i = 0; i < N; i++) { re[i] = data[off + i] * win[i]; im[i] = 0; }
    _fft(re, im);
    for (let k = 2; k < N / 2; k++) {
      const f = k * rate / N;
      if (f < 55 || f > 4200) continue;
      const mag = Math.hypot(re[k], im[k]);
      if (mag <= 0) continue;
      const pc = (((Math.round(12 * Math.log2(f / 440)) + 9) % 12) + 12) % 12;
      chroma[pc] += Math.log1p(mag * 40);
    }
    frames++;
  }
  if (!frames) return { key: 0, scale: 'major', name: 'C', confidence: 0 };
  const corr = (a, b) => {
    let sa = 0, sb = 0;
    for (let i = 0; i < 12; i++) { sa += a[i]; sb += b[i]; }
    sa /= 12; sb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { const x = a[i] - sa, y = b[i] - sb; num += x * y; da += x * x; db += y * y; }
    return num / (Math.sqrt(da * db) + 1e-12);
  };
  let best = { key: 0, scale: 'major', score: -2 }, second = -2;
  for (let k = 0; k < 12; k++) {
    const pm = [], pn = [];
    for (let i = 0; i < 12; i++) { pm.push(KS_MAJOR[(i - k + 12) % 12]); pn.push(KS_MINOR[(i - k + 12) % 12]); }
    const sm = corr(chroma, pm), sn = corr(chroma, pn);
    for (const [sc, scl] of [[sm, 'major'], [sn, 'minor']]) {
      if (sc > best.score) { second = best.score; best = { key: k, scale: scl, score: sc }; }
      else if (sc > second) second = sc;
    }
  }
  const conf = Math.min(1, Math.max(0, (best.score - second) * 2.5));
  return {
    key: best.key, scale: best.scale,
    name: KEY_NAMES[best.key] + (best.scale === 'minor' ? ' minor' : ''),
    confidence: Math.round(conf * 100) / 100,
  };
}

function _avgSpectrum(buffer, rate, n, hop, maxSecs) {
  const { data, rate: r } = _monoDownsample(buffer, rate, maxSecs);
  const re = new Float32Array(n), im = new Float32Array(n);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  const avg = new Float32Array(n / 2);
  let frames = 0;
  for (let off = 0; off + n <= data.length; off += hop) {
    for (let i = 0; i < n; i++) { re[i] = data[off + i] * win[i]; im[i] = 0; }
    _fft(re, im);
    for (let k = 0; k < n / 2; k++) avg[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames) for (let k = 0; k < avg.length; k++) avg[k] /= frames;
  return { avg, rate: r, n };
}

// Harsh resonant peaks: local maxima with prominence, 150 Hz – 12 kHz
function analyzeResonances(buffer, count) {
  const { avg, rate, n } = _avgSpectrum(buffer, 22050, 8192, 4096, 60);
  const half = avg.length;
  const db = new Float32Array(half);
  for (let k = 0; k < half; k++) db[k] = _db(avg[k] / half + 1e-9);
  const sm = new Float32Array(half); // smoothed
  for (let k = 0; k < half; k++) {
    let s = 0, c = 0;
    for (let j = -4; j <= 4; j++) { const q = k + j; if (q >= 0 && q < half) { s += db[q]; c++; } }
    sm[k] = s / c;
  }
  const loF = 150, hiF = 12000;
  const peaks = [];
  for (let k = 2; k < half - 2; k++) {
    const f = k * rate / n;
    if (f < loF || f > hiF) continue;
    if (sm[k] > sm[k - 1] && sm[k] >= sm[k + 1] && sm[k] > sm[k - 2] && sm[k] >= sm[k + 2]) {
      // prominence vs surrounding median
      let med = 0, c = 0;
      for (let j = -14; j <= 14; j += 2) { const q = k + j; if (q >= 0 && q < half && Math.abs(j) > 4) { med += sm[q]; c++; } }
      med /= Math.max(1, c);
      const prom = sm[k] - med;
      if (prom > 5) peaks.push({ freq: Math.round(f), prom: Math.round(prom * 10) / 10 });
    }
  }
  peaks.sort((a, b) => b.prom - a.prom);
  // de-duplicate neighbors (keep strongest within 8% of each other)
  const out = [];
  for (const p of peaks) {
    if (out.length >= (count || 3)) break;
    if (out.some(q => Math.abs(q.freq - p.freq) / p.freq < 0.08)) continue;
    out.push(p);
  }
  return out;
}

// Sibilance: strongest band-energy peak between 4 and 10 kHz
function analyzeSibilance(buffer) {
  const { avg, rate, n } = _avgSpectrum(buffer, 22050, 8192, 4096, 60);
  const centers = [4000, 5000, 6300, 8000, 10000];
  let bestF = 6300, bestE = -1;
  for (const fc of centers) {
    let e = 0, c = 0;
    for (let k = 1; k < avg.length; k++) {
      const f = k * rate / n;
      if (f >= fc * 0.84 && f <= fc * 1.19) { e += avg[k] * avg[k]; c++; }
    }
    e = c ? e / c : 0;
    if (e > bestE) { bestE = e; bestF = fc; }
  }
  return { freq: bestF };
}

function analyzeStereo(buffer) {
  if (buffer.numberOfChannels < 2) return { correlation: 1 };
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  const n = Math.min(L.length, R.length, Math.floor(buffer.sampleRate * 30));
  let sLL = 0, sRR = 0, sLR = 0;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) { sLL += L[i] * L[i]; sRR += R[i] * R[i]; sLR += L[i] * R[i]; }
  const corr = sLR / (Math.sqrt(sLL * sRR) + 1e-12);
  return { correlation: Math.max(-1, Math.min(1, Math.round(corr * 100) / 100)) };
}

// Which audio should Auto analyze? Selected clip first, else first clip on the channel.
function getAnalysisBuffer(ch) {
  if (!ch || ch.kind !== 'audio') return null;
  const clips = ch.clips || [];
  const sel = clips.find(c => c.id === S.selClipId);
  const pick = (sel && sel.buffer && !sel.missing) ? sel : clips.find(c => c.buffer && !c.missing);
  return pick ? pick.buffer : null;
}
/*__ANALYZE_END__*/

/* ================= auto mode + per-artist learning ========================
   Every plugin's "Auto" analyzes the track's audio and sets smart starting
   params. DAhYO also keeps a local artist profile that records the deltas
   between Auto's suggestion and what the artist actually keeps — so Auto
   gets smarter for that artist over time. Stored in localStorage. */
const PARAM_BOUNDS = {
  tune: { speed: [0, 1] },
  eq: { lowF: [40, 800], lowG: [-12, 12], pm1F: [120, 12000], pm1Q: [0.3, 8], pm1G: [-12, 12], pm2F: [120, 12000], pm2Q: [0.3, 8], pm2G: [-12, 12], highF: [2000, 18000], highG: [-12, 12] },
  deess: { freq: [3000, 12000], threshold: [-48, -6] },
  gate: { threshold: [-60, -10], attack: [0.001, 0.2], release: [0.02, 1], range: [0, 60] },
  comp: { threshold: [-48, 0], ratio: [1, 20] },
  sat: { drive: [0, 1], tone: [800, 16000] },
  chorus: { mix: [0, 1], depth: [0, 1], rate: [0.05, 8] },
  flang: { mix: [0, 1], depth: [0, 1], rate: [0.05, 8], feedback: [0, 0.85] },
  delay: { time: [0.02, 1.9], feedback: [0, 0.9], mix: [0, 1] },
  ppd: { time: [0.02, 1.9], feedback: [0, 0.9], mix: [0, 1] },
  verb: { mix: [0, 1], size: [0.3, 2] },
  trem: { rate: [0.1, 20], depth: [0, 1] },
  filt: { base: [100, 4000], depth: [0, 1], rate: [0.05, 8], q: [0.5, 12] },
  wide: { width: [0, 2.5] },
  lim: { threshold: [-24, 0], release: [0.01, 0.5] },
  doubler: { mix: [0, 1], width: [0, 1], rate: [0.1, 4] },
};
function boundsFor(key) { return PARAM_BOUNDS[key.replace(/^rack:/, '')] || {}; }
function clampTo(key, param, v) {
  const b = boundsFor(key)[param];
  return b ? Math.min(b[1], Math.max(b[0], v)) : v;
}
function loadArtists() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem('dahyo.artists.v1') || 'null'); } catch (e) {}
  S.artists = (data && data.artists && data.artists.length) ? data.artists : [{ id: 'a-' + Date.now().toString(36), name: 'Dee', learn: {}, audio: { n: 0, peakDb: -12, rmsDb: -24 } }];
  S.artistId = (data && data.artistId) || S.artists[0].id;
  if (!S.artists.some(a => a.id === S.artistId)) S.artistId = S.artists[0].id;
}
function saveArtists() {
  try { localStorage.setItem('dahyo.artists.v1', JSON.stringify({ artists: S.artists, artistId: S.artistId })); } catch (e) {}
}
function currentArtist() {
  return S.artists.find(a => a.id === S.artistId) || S.artists[0];
}
function learnedOffset(key, param) {
  const a = currentArtist();
  if (!a || !a.learn || !a.learn[key] || !a.learn[key][param]) return 0;
  const e = a.learn[key][param];
  return e.n >= 2 ? e.mean : 0;
}
function learnDelta(key, param, delta) {
  const a = currentArtist();
  if (!a || !isFinite(delta) || Math.abs(delta) > 1000) return;
  a.learn = a.learn || {};
  const L = a.learn[key] || (a.learn[key] = {});
  const e = L[param] || (L[param] = { n: 0, mean: 0 });
  e.n = Math.min(e.n + 1, 500);
  e.mean += (delta - e.mean) / e.n;
}
// Snapshot what the artist kept vs what Auto suggested. Called on stop/save.
function snapshotLearn() {
  let dirty = false;
  const snap = (key, P) => {
    if (!P || !P._autoWas) return;
    for (const k of Object.keys(P._autoWas)) {
      if (typeof P[k] !== 'number' || typeof P._autoWas[k] !== 'number') continue;
      learnDelta(key, k, P[k] - P._autoWas[k]);
      dirty = true;
    }
    delete P._autoWas;
  };
  for (const ch of allChannels()) {
    if (!ch.params) continue;
    for (const key of FX_KEYS) snap(key, ch.params[key]);
    for (const m of ((ch.params.rack && ch.params.rack.modules) || [])) snap('rack:' + m.type, m.params);
  }
  if (dirty) saveArtists();
}
// Auto: analyze the track's audio and set smart starting params for one plugin.
// P = params object to fill (defaults to ch.params[key]); onDone applies+refreshes.
function autoFX(ch, key, P, onDone, quiet) {
  P = P || ch.params[key];
  const buf = getAnalysisBuffer(ch);
  if (!buf) {
    if (!quiet) toast('Auto needs audio on this track first — import or record something, then tap Auto.');
    return false;
  }
  const done = onDone || (() => { ensureCtx().then(() => applyChannelParams(ch)); saveSession(); renderInspector(); });
  const lv = analyzeLevels(buf);
  const a = currentArtist();
  if (a) { // remember what this artist's audio looks like
    a.audio = a.audio || { n: 0, peakDb: -12, rmsDb: -24 };
    const A = a.audio; A.n = Math.min(A.n + 1, 500);
    A.peakDb += (lv.peakDb - A.peakDb) / A.n;
    A.rmsDb += (lv.rmsDb - A.rmsDb) / A.n;
  }
  let msg = '';
  const base = key.replace(/^rack:/, '');
  if (base === 'tune') {
    const k = analyzeKey(buf);
    P.key = k.key; P.scale = k.scale;
    msg = 'Key sounds like ' + k.name + ' — Tune locked to it.';
  } else if (base === 'eq') {
    const res = analyzeResonances(buf, 2);
    if (res[0]) { P.pm1F = clampTo(key, 'pm1F', res[0].freq); P.pm1G = -Math.min(7, 2 + res[0].prom / 4); P.pm1Q = 2.5; }
    if (res[1]) { P.pm2F = clampTo(key, 'pm2F', res[1].freq); P.pm2G = -Math.min(6, 2 + res[1].prom / 5); P.pm2Q = 3; }
    msg = res.length ? 'Cut harsh spots at ' + res.map(r => r.freq + ' Hz').join(' & ') + '.' : 'No harsh spots found — EQ left flat.';
  } else if (base === 'comp') {
    P.threshold = clampTo(key, 'threshold', lv.rmsDb - 6);
    P.ratio = 3;
    msg = 'Threshold set from your level (' + Math.round(lv.rmsDb) + ' dB average).';
  } else if (base === 'deess') {
    const s = analyzeSibilance(buf);
    P.freq = clampTo(key, 'freq', s.freq); P.threshold = -24;
    msg = 'Sibilance lives around ' + (s.freq / 1000).toFixed(1) + ' kHz.';
  } else if (base === 'gate') {
    P.threshold = clampTo(key, 'threshold', lv.noiseFloorDb + 6);
    msg = 'Cutoff set just above your noise floor (' + Math.round(lv.noiseFloorDb) + ' dB).';
  } else if (base === 'lim') {
    P.threshold = clampTo(key, 'threshold', Math.min(-1, lv.peakDb - 1));
    msg = 'Ceiling catching just your tallest peaks.';
  } else if (base === 'delay' || base === 'ppd') {
    P.sync = true;
    msg = 'Locked to project tempo (' + S.bpm + ' BPM, dotted-8th).';
  } else if (base === 'trem' || base === 'chorus' || base === 'flang' || base === 'filt') {
    P.sync = true;
    msg = 'Wobble locked to project tempo (' + S.bpm + ' BPM).';
  } else if (base === 'verb') {
    P.mix = 0.22;
    msg = 'Starting with a tasteful amount of room.';
  } else if (base === 'sat') {
    P.drive = clampTo(key, 'drive', Math.min(0.6, Math.max(0.08, 0.5 - lv.crestDb / 60)));
    msg = 'Drive matched to how punchy the track is.';
  } else if (base === 'wide') {
    const st = analyzeStereo(buf);
    P.width = st.correlation > 0.7 ? 1.6 : 1.2;
    msg = st.correlation > 0.7 ? 'Track is narrow — widened it up.' : 'Track already has width — gentle touch.';
  } else if (base === 'doubler') {
    P.mix = 0.35; P.width = 0.6; P.rate = 0.9;
    msg = 'Doubles dialed in for thickness.';
  }
  // fold in what this artist usually keeps (learned offsets)
  let learned = 0;
  for (const k of Object.keys(P)) {
    if (typeof P[k] !== 'number' || k[0] === '_') continue;
    const off = learnedOffset(key, k);
    if (off) { P[k] = clampTo(key, k, P[k] + off); learned++; }
  }
  P._autoWas = {};
  for (const k of Object.keys(P)) if (typeof P[k] === 'number' && k[0] !== '_') P._autoWas[k] = P[k];
  P._autoAt = Date.now();
  saveArtists();
  done();
  toast('⚡ Auto' + (learned ? ' (tuned to how you like it)' : '') + ': ' + msg);
  return true;
}

async function importFiles(files, targetTrack) {
  await ensureCtx();
  Undo.push('Import audio');
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(wav|mp3|ogg|m4a|flac|aif|aiff)$/i.test(f.name)) {
      toast('Skipped ' + f.name + ' — not an audio file.'); continue;
    }
    if (f.size > 300 * 1024 * 1024) {
      toast('Skipped ' + f.name + ' — over the 300 MB import limit. Trim it first and try again.');
      continue;
    }
    try {
      const ab = await f.arrayBuffer();
      const buf = await S.ctx.decodeAudioData(ab);
      const format = buf.numberOfChannels > 1 ? 'stereo' : 'mono';
      let tr = targetTrack;
      if (!tr || tr.kind !== 'audio') {
        tr = addAudioTrack({ name: f.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'Import', format, _noUndo: true });
      }
      const clip = {
        id: uid('clip'), name: f.name.slice(0, 32),
        buffer: buf, start: tr.clips.length ? Math.max(...tr.clips.map(c => c.start + c.duration)) : 0,
        offset: 0, duration: buf.duration, peaks: computePeaks(buf),
        fadeIn: 0, fadeOut: 0,
      };
      tr.clips.push(clip);
      // persist the original file bytes — survives reload via IndexedDB
      try { idb.putClip(clip.id, f, clip.name).then(ok => { if (ok) clip._blobSaved = true; }); } catch (e) {}
      updateDuration();
      status('Imported "' + clip.name + '" → ' + tr.name + ' (' + format + ')');
      if (!S._analyzedBuf) S._analyzedBuf = buf; // first imported file → BPM/key finder
    } catch (e) { toast('Could not decode ' + f.name); }
  }
  drawTimeline(); renderHeaders(); saveSession();
  // auto BPM + key finder on the first imported file
  if (S._analyzedBuf) {
    const buf = S._analyzedBuf; S._analyzedBuf = null;
    setTimeout(() => analyzeImportedBuffer(buf), 60);
  }
}

// Auto BPM + key finder: runs on the first audio file imported, shows a modal
// with detected tempo/key and one-tap "apply to project tempo".
function analyzeImportedBuffer(buf) {
  let tempo = { bpm: 0, confidence: 0 }, key = { name: '—', confidence: 0 };
  try { tempo = analyzeTempo(buf); } catch (e) {}
  try { key = analyzeKey(buf); } catch (e) {}
  S._lastAnalysis = { tempo, key };
  const t = $('an-bpm'), k = $('an-key');
  if (t) t.textContent = tempo.bpm ? tempo.bpm.toFixed(1) + ' BPM' : 'not sure';
  if (k) k.textContent = key.name || '—';
  const tc = $('an-bpm-conf'), kc = $('an-key-conf');
  if (tc) tc.textContent = tempo.bpm ? Math.round(tempo.confidence * 100) + '% sure' : '';
  if (kc) kc.textContent = key.confidence ? Math.round(key.confidence * 100) + '% sure' : '';
  const use = $('an-use');
  if (use) {
    use.disabled = !tempo.bpm;
    use.textContent = tempo.bpm ? 'Use ' + tempo.bpm.toFixed(1) + ' BPM as project tempo' : 'No tempo found';
  }
  openModal('modal-analyze');
}

function updateDuration() {
  let d = 0;
  for (const tr of S.tracks) for (const c of tr.clips) d = Math.max(d, c.start + c.duration);
  S.duration = Math.max(d, 8);
  $('time-total') && ($('time-total').textContent = fmtTime(S.duration));
}

/* ------------------------- clip fades & markers --------------------------
   Every clip carries fadeIn/fadeOut (seconds). Playback and WAV export both
   render them through a per-clip gain envelope — what you hear is what you
   export. Markers live on the timeline ruler: click to jump, double-click to
   rename, right-click to delete. */
function applyFadeEnvelope(gainParam, clip, when, skip) {
  const dur = Math.max(0.01, clip.duration - skip);
  const fi = Math.min(clip.fadeIn || 0, clip.duration / 2);
  const fo = Math.min(clip.fadeOut || 0, clip.duration / 2);
  try {
    gainParam.setValueAtTime(0.0001, when);
    const effFi = Math.max(0, fi - skip);
    if (effFi > 0.004) gainParam.linearRampToValueAtTime(1, when + effFi);
    else gainParam.setValueAtTime(1, when);
    if (fo > 0.004 && dur > fo + 0.01) {
      const ds = when + Math.max(effFi, dur - fo);
      gainParam.setValueAtTime(1, ds);
      gainParam.linearRampToValueAtTime(0.0001, when + dur);
    }
  } catch (e) {}
}

function addMarker() {
  const pos = curPos();
  Undo.push('Add marker');
  const n = S.markers.length + 1;
  S.markers.push({ id: uid('mk'), pos, name: 'Marker ' + n });
  S.markers.sort((a, b) => a.pos - b.pos);
  drawTimeline(); saveSession();
  toast('Marker added at ' + fmtTime(pos) + ' — double-click to rename.');
}
function jumpToMarker(m) {
  const was = S.playing;
  if (was) stop();
  S.playStartPos = Math.min(Math.max(0, m.pos), S.duration);
  if (was) play(S.playStartPos); else drawTimeline();
}
function renameMarker(m) {
  const nn = prompt('Marker name:', m.name);
  if (nn && nn.trim()) { Undo.push('Rename marker'); m.name = nn.trim().slice(0, 24); drawTimeline(); saveSession(); }
}
function deleteMarker(m) {
  Undo.push('Delete marker');
  S.markers = S.markers.filter(x => x.id !== m.id);
  drawTimeline(); saveSession();
  toast('Marker deleted.');
}

/* ------------------------------ transport -------------------------------- */
function curPos() {
  if (!S.ctx) return 0;
  return S.playing ? S.playStartPos + (S.ctx.currentTime - S.playStartCtx) : S.playStartPos;
}

function stopAllSources() {
  for (const s of S.sources) { try { s.onended = null; s.stop(); } catch (e) {} }
  S.sources = [];
}

function stopSourcesOnChannel(ch) {
  S.sources = S.sources.filter(s => {
    if (s._chId === ch.id) { try { s.onended = null; s.stop(); } catch (e) {} return false; }
    return true;
  });
}

async function play(fromPos) {
  await ensureCtx();
  if (S._playGuard) return; // rapid Space presses can't double-schedule
  S._playGuard = true;
  try {
    stopAllSources();
    const pos = (fromPos === undefined) ? S.playStartPos : fromPos;
    const t0 = S.ctx.currentTime + 0.08;
    S.playStartCtx = t0; S.playStartPos = pos;
    let any = false;
    for (const tr of S.tracks) {
      if (!tr.nodes || !tr.clips.length) continue;
      for (const clip of tr.clips) {
        if (clip.missing || !clip.buffer) continue;
        const clipEnd = clip.start + clip.duration;
        if (clipEnd <= pos) continue;
        const src = S.ctx.createBufferSource();
        src.buffer = clip.buffer;
        const fg = S.ctx.createGain(); // per-clip fade envelope
        src.connect(fg); fg.connect(tr.nodes.input);
        src._chId = tr.id;
        const skip = Math.max(0, pos - clip.start);
        const when = t0 + Math.max(0, clip.start - pos);
        try {
          applyFadeEnvelope(fg.gain, clip, when, skip);
          src.start(when, clip.offset + skip, clip.duration - skip);
          src.onended = () => {
            S.sources = S.sources.filter(x => x !== src);
            if (!S.sources.length && S.playing && !S.recording) {
              if (S.loop) play(0);
              else stop();
            }
          };
          S.sources.push(src); any = true;
        } catch (e) {}
      }
    }
    S.playing = true;
    $('btn-play').classList.add('on');
    $('btn-play').textContent = '⏸';
    status(any ? 'Playing…' : 'Playing (no clips at playhead)');
  } finally {
    S._playGuard = false;
  }
}

function stop() {
  stopAllSources();
  if (S.recording) stopRecording(true);
  S.playing = false;
  S.playStartPos = curPos();
  snapshotLearn(); // fold "what the artist kept" into their learning profile
  if (S.ctx && S.playStartPos > S.duration) S.playStartPos = 0;
  $('btn-play').classList.remove('on');
  $('btn-play').textContent = '▶';
  drawTimeline();
}

function togglePlay() { S.playing ? stop() : play(); }
function backToStart() { const was = S.playing; stop(); S.playStartPos = 0; if (was) play(0); else drawTimeline(); }

/* ------------------------------ recording -------------------------------- */
/* ------------------------- input: monitor + record path --------------------
   Record path audit: the mic goes STRAIGHT to the recorder — no nodes touch
   it. "Music (clean)" mode (default) requests the mic with all browser voice
   processing OFF (no echo cancellation / noise suppression / auto-gain), so
   music records with no artifacts. "Voice (processed)" keeps the browser's
   cleanup for spoken word. Input meters tap the raw stream pre-everything. */
S.monStreams = {};
function inputConstraints(ch) {
  let devId = (ch && ch.input) || S.io.inputId;
  if (!devId || devId === 'session') devId = S.io.inputId;
  const base = (devId && devId !== 'default') ? { deviceId: { exact: devId } } : {};
  if (S.io.inputMode === 'voice')
    return Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, base);
  return Object.assign({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }, base);
}
async function toggleMonitor(ch) {
  if (S.monStreams[ch.id]) { stopMonitor(ch); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Live monitoring is not supported in this browser.'); return; }
  await ensureCtx();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: inputConstraints(ch) });
    const src = S.ctx.createMediaStreamSource(stream);
    src.connect(ch.nodes.input); // hear it through the channel's FX chain
    const an = S.ctx.createAnalyser(); an.fftSize = 512; // pre-everything level tap
    src.connect(an);
    S.monStreams[ch.id] = { stream, src, an, buf: new Float32Array(512) };
    ch.monitoring = true;
    renderHeaders();
    toast('🔊 Hearing the input on ' + ch.name + ' — use headphones to avoid feedback.');
  } catch (e) { toast('Microphone blocked — allow mic access to monitor.'); }
}
function stopMonitor(ch) {
  const m = S.monStreams[ch.id];
  if (m) {
    try { m.src.disconnect(); } catch (e) {}
    try { m.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    delete S.monStreams[ch.id];
  }
  if (ch) { ch.monitoring = false; renderHeaders(); }
}
function drawInputMeters() {
  for (const ch of S.tracks) {
    const cv = ch._inMeterCanvas;
    const m = S.monStreams[ch.id];
    if (!cv || !cv.isConnected || !m) continue;
    const x = cv.getContext('2d'), W = cv.width, H = cv.height;
    m.an.getFloatTimeDomainData(m.buf);
    let p = 0;
    for (let i = 0; i < m.buf.length; i += 4) { const a = Math.abs(m.buf[i]); if (a > p) p = a; }
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
    const h = Math.min(1, p) * H;
    x.fillStyle = p >= 1 ? '#ff5252' : p > 0.7 ? '#ffd23e' : '#35d07f';
    x.fillRect(0, H - h, W, h);
  }
}

async function toggleRecord() {
  if (S.recording) { stopRecording(false); return; }
  const tr = S.tracks.find(t => t.recArmed && t.kind === 'audio') || S.tracks.find(t => t.kind === 'audio');
  if (!tr) { toast('Create an audio track first, then arm it (●) to record.'); return; }
  tr.recArmed = true;
  await ensureCtx();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording is not supported in this browser.'); return; }
  if (typeof MediaRecorder === 'undefined') { toast('Recording is not supported in this browser.'); return; }
  // count-in: metronome clicks before the take starts
  if (S.countIn > 0 && !S.playing) await playCountIn(S.countIn);
  let stream;
  try {
    // clean music path by default: no browser voice processing on the way in
    stream = await navigator.mediaDevices.getUserMedia({ audio: inputConstraints(tr) });
  } catch (e) { toast('Microphone blocked — allow mic access to record.'); return; }
  // Safari records mp4, Chrome/Edge/Firefox record webm — take whatever the browser supports.
  const mime = ['audio/webm', 'audio/mp4'].find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  S.recChunks = []; S.recTrack = tr; S.mediaRec = rec;
  rec.ondataavailable = (e) => { if (e.data.size) S.recChunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    if (!S.recChunks.length) return;
    const blob = new Blob(S.recChunks, { type: rec.mimeType || 'audio/webm' });
    try {
      const ab = await blob.arrayBuffer();
      const buf = await S.ctx.decodeAudioData(ab);
      const recStart = S.playStartPosAtRec || 0;
      const { buffer: tbuf, start: tstart } = applyPunchTrim(buf, recStart);
      const clip = {
        id: uid('clip'), name: 'Take ' + (tr.clips.length + 1),
        buffer: tbuf, start: tstart,
        offset: 0, duration: tbuf.duration, peaks: computePeaks(tbuf),
        fadeIn: 0, fadeOut: 0,
      };
      tr.clips.push(clip);
      // persist the recorded take — survives reload via IndexedDB
      try { idb.putClip(clip.id, blob, clip.name).then(ok => { if (ok) clip._blobSaved = true; }); } catch (e) {}
      updateDuration(); drawTimeline(); renderHeaders(); saveSession();
      toast('Take recorded → ' + tr.name);
    } catch (e) { toast('Recording could not be decoded.'); }
    S.recChunks = [];
  };
  S.playStartPosAtRec = curPos();
  try { rec.start(); }
  catch (e) { toast('Recording could not start — try again.'); return; }
  S.recording = true;
  $('btn-rec').classList.add('on');
  status('● Recording on ' + tr.name + ' (input: ' + inputLabel(tr.input) + ')');
  if (!S.playing) play(S.playStartPos);
}

function stopRecording(cancelled) {
  if (S.mediaRec && S.mediaRec.state !== 'inactive') {
    try { S.mediaRec.stop(); } catch (e) {}
  }
  S.recording = false; S.mediaRec = null;
  $('btn-rec').classList.remove('on');
  if (cancelled) status('Recording discarded.');
}

// Count-in: metronome bars before the take starts.
function playCountIn(bars) {
  status('Count-in: ' + bars + ' bar' + (bars > 1 ? 's' : '') + '…');
  return new Promise((resolve) => {
    const spb = 60 / S.bpm, beats = Math.max(1, Math.round(bars * S.timesig));
    const t0 = S.ctx.currentTime + 0.06;
    for (let b = 0; b < beats; b++) {
      const osc = S.ctx.createOscillator(), g = S.ctx.createGain();
      osc.frequency.value = b % S.timesig === 0 ? 1600 : 1000;
      g.gain.setValueAtTime(0.0001, t0 + b * spb);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + b * spb + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + b * spb + 0.06);
      osc.connect(g); g.connect(S.ctx.destination);
      osc.start(t0 + b * spb); osc.stop(t0 + b * spb + 0.08);
    }
    setTimeout(resolve, beats * spb * 1000 + 150);
  });
}
// Punch in/out region: keep only the audio between the punch points.
function applyPunchTrim(buf, recStart) {
  if (!S.punch.on) return { buffer: buf, start: recStart };
  const inT = Math.max(0, S.punch.in - recStart), outT = Math.min(buf.duration, S.punch.out - recStart);
  if (outT - inT < 0.1) { toast('Punch region missed the take — kept the full take.'); return { buffer: buf, start: recStart }; }
  const sr = buf.sampleRate, a = Math.floor(inT * sr), b = Math.min(buf.length, Math.ceil(outT * sr));
  const nb = S.ctx.createBuffer(buf.numberOfChannels, Math.max(1, b - a), sr);
  for (let c = 0; c < buf.numberOfChannels; c++) nb.getChannelData(c).set(buf.getChannelData(c).subarray(a, b));
  toast('🥊 Punched in — kept ' + (S.punch.in).toFixed(1) + 's → ' + (S.punch.out).toFixed(1) + 's.');
  return { buffer: nb, start: recStart + a / sr };
}
// Manual punch (voice commands / hands-free): drop in/out while rolling.
async function punchInNow() {
  if (S.recording) return;
  const tr = S.tracks.find(t => t.recArmed && t.kind === 'audio') || S.tracks.find(t => t.kind === 'audio');
  if (!tr) { toast('Arm a track first, then punch in.'); return; }
  status('🥊 Punching in…');
  await toggleRecord();
}
function punchOutNow() {
  if (!S.recording) return;
  stopRecording(false);
  status('🥊 Punched out — take kept, still rolling.');
}

/* ------------------------------ metronome -------------------------------- */
function metroTick() {
  if (!S.metro || !S.ctx || !S.playing) return;
  const spb = 60 / S.bpm;
  while (S.metroNext < S.ctx.currentTime + 0.15) {
    const beat = S.metroBeat % S.timesig;
    const osc = S.ctx.createOscillator(), g = S.ctx.createGain();
    osc.frequency.value = beat === 0 ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, S.metroNext);
    g.gain.exponentialRampToValueAtTime(0.5, S.metroNext + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, S.metroNext + 0.06);
    osc.connect(g); g.connect(S.ctx.destination);
    osc.start(S.metroNext); osc.stop(S.metroNext + 0.08);
    S.metroNext += spb; S.metroBeat++;
  }
}
function setMetro(on) {
  S.metro = on;
  $('btn-metro').classList.toggle('on', on);
  if (on && S.ctx) {
    S.metroNext = S.ctx.currentTime + 0.05;
    S.metroBeat = 0;
    clearInterval(S.metroTimer);
    S.metroTimer = setInterval(metroTick, 40);
  } else clearInterval(S.metroTimer);
}

/* ------------------------------ WAV export ------------------------------- */
function encodeWAV(buffer, bits, dither) {
  bits = bits === 24 ? 24 : 16;
  const nCh = 2, sr = buffer.sampleRate, n = buffer.length;
  const bps = bits / 8;
  const bytes = 44 + n * nCh * bps;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * bps, true); v.setUint16(32, nCh * bps, true); v.setUint16(34, bits, true);
  wstr(36, 'data'); v.setUint32(40, n * nCh * bps, true);
  const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  let o = 44;
  const lsb = Math.pow(2, -(bits - 1));
  for (let i = 0; i < n; i++) {
    for (const chd of [L, R]) {
      let s = Math.max(-1, Math.min(1, chd[i]));
      if (dither) s += ((Math.random() * 2 - 1) + (Math.random() * 2 - 1)) * 0.5 * lsb; // TPDF dither
      s = Math.max(-1, Math.min(1, s));
      if (bits === 24) {
        const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
        v.setUint8(o, q & 0xFF); v.setUint8(o + 1, (q >> 8) & 0xFF); v.setUint8(o + 2, (q >> 16) & 0xFF);
        o += 3;
      } else {
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function exportWAV(opts) {
  opts = opts || {};
  const mastered = opts.mastered !== false;
  const bits = opts.bits === 24 ? 24 : 16;
  const sr = opts.sr || S.io.sessionRate || 44100;
  const hasAudio = S.tracks.some(t => t.clips.some(c => !c.missing && c.buffer));
  if (!hasAudio) { toast('Nothing to export — import or record some audio first.'); return; }
  toast('Rendering ' + (mastered ? 'mastered' : 'premaster') + ' mix…');
  const dur = Math.max(1, S.duration + 2.5);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) { toast('Mix export is not supported in this browser.'); return; }
  const off = new OAC(2, Math.ceil(dur * sr), sr);

  let tuneOK = false, gateOK = false;
  try {
    const blob = new Blob([TUNE_WORKLET_CODE], { type: 'application/javascript' });
    await off.audioWorklet.addModule(URL.createObjectURL(blob));
    tuneOK = true;
  } catch (e) {}
  try {
    const blob = new Blob([GATE_WORKLET_CODE], { type: 'application/javascript' });
    await off.audioWorklet.addModule(URL.createObjectURL(blob));
    gateOK = true;
  } catch (e) {}

  const G = { masterIn: off.createGain(), busNodes: new Map(), auxInputs: new Map() };
  const masterGain = off.createGain();
  masterGain.gain.value = S.master.vol;
  // master inserts (offline render honors them)
  let mHead = G.masterIn;
  const MP = getMasterCh().params;
  for (const type of ['eq', 'comp', 'lim']) {
    const built = buildRackModuleNodes(off, type, true);
    const slot = makeSlot(off, () => built.ins, false);
    slot.setBypassed(!MP[type].on, 0);
    applyRackModuleNodes(type, built.nd, MP[type], 0);
    mHead.connect(slot.in); mHead = slot.out;
  }
  mHead.connect(masterGain);
  // mastering chain (offline render honors it; premaster bypasses it)
  const MC = masterChain();
  const mc = buildMasteringNodes(off);
  mc.slot.setBypassed(!mastered || !MC.on, 0);
  applyRackModuleNodes('eq', mc.meq, MC.meq, 0);
  applyMultiband(mc.mb, MC.mb, 0);
  applyRackModuleNodes('wide', mc.img, MC.img, 0);
  applyRackModuleNodes('lim', mc.max, MC.max, 0);
  mc.makeup.gain.value = Math.pow(10, MC.max.makeup / 20);
  masterGain.connect(mc.slot.in);
  mc.slot.out.connect(off.destination);

  for (const b of S.buses) G.busNodes.set(b.id, off.createGain());

  const nodeMap = new Map();
  for (const ch of allChannels()) {
    const nodes = makeChannelNodes(off, ch, { meters: false, tuneOK, gateOK });
    applyParamsToNodes(ch, nodes);
    nodeMap.set(ch.id, nodes);
    G.auxInputs.set(ch.id, nodes.input);
    // schedule clips
    if (ch.kind === 'audio') {
      for (const clip of ch.clips) {
        if (clip.missing || !clip.buffer) continue;
        const src = off.createBufferSource();
        src.buffer = clip.buffer;
        const fg = off.createGain(); // per-clip fade envelope — export matches playback
        src.connect(fg); fg.connect(nodes.input);
        try {
          applyFadeEnvelope(fg.gain, clip, clip.start, 0);
          src.start(clip.start, clip.offset, clip.duration);
        } catch (e) {}
      }
    }
  }
  for (const ch of allChannels()) routeChannel(ch, nodeMap.get(ch.id), G);
  for (const b of S.buses) routeBus(b, G);

  try {
    const rendered = await off.startRendering();
    const blob = encodeWAV(rendered, bits, MC.dither.on && mastered);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dahyo-mix-' + (mastered ? 'mastered' : 'premaster') + '-' + Math.round(sr / 1000) + 'k-' + bits + 'bit.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast((mastered ? 'Mastered' : 'Premaster') + ' mix exported — ' + a.download);
  } catch (e) { toast('Export failed: ' + e.message); }
}
function openExport() {
  const er = $('exp-rate'); if (er) er.value = String(S.io.sessionRate || 44100);
  openModal('modal-export');
}

/* ============================== UI components ============================ */
function createKnob(label, min, max, val, fmt, onInput, title) {
  const wrap = el('div', 'knob');
  if (title) wrap.title = title;
  const c = document.createElement('canvas');
  c.width = 60; c.height = 60;
  const lab = el('div', 'kl', label);
  const kval = el('div', 'kv', fmt(val));
  wrap.append(c, lab, kval);
  let v = val, startY = null, startV = 0;
  function draw() {
    const x = c.getContext('2d'), W = 60, cx = 30, cy = 32, r = 22;
    x.clearRect(0, 0, W, 60);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    x.lineWidth = 5; x.lineCap = 'round';
    x.strokeStyle = '#242c37';
    x.beginPath(); x.arc(cx, cy, r, a0, a1); x.stroke();
    const f = (v - min) / (max - min || 1);
    x.strokeStyle = '#2f9dff';
    x.beginPath(); x.arc(cx, cy, r, a0, a0 + (a1 - a0) * f); x.stroke();
    const ang = a0 + (a1 - a0) * f;
    x.strokeStyle = '#d9e0ea'; x.lineWidth = 3;
    x.beginPath();
    x.moveTo(cx, cy);
    x.lineTo(cx + Math.cos(ang) * (r - 4), cy + Math.sin(ang) * (r - 4));
    x.stroke();
  }
  function setNV(nv, fire) {
    v = Math.min(max, Math.max(min, nv));
    kval.textContent = fmt(v); draw();
    if (fire !== false) onInput(v);
  }
  c.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startV = v;
    c.setPointerCapture(e.pointerId); e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    setNV(startV + ((startY - e.clientY) / 130) * (max - min));
  });
  const end = () => { startY = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  draw();
  undoableGesture(c, 'FX knob: ' + (title || label));
  return { el: wrap, set: (nv, fire) => setNV(nv, fire), get: () => v };
}

function sliderRow(label, min, max, step, val, fmt, onInput, title) {
  const row = el('div', 'srow');
  const lab = el('label', '', label);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  if (title) inp.title = title;
  const out = el('output', '', fmt(val));
  inp.addEventListener('input', () => { out.textContent = fmt(parseFloat(inp.value)); onInput(parseFloat(inp.value)); });
  row.append(lab, inp, out);
  undoableGesture(inp, 'FX: ' + (title || label));
  return { row, set(v) { inp.value = v; out.textContent = fmt(v); } };
}

function bypassBtn(fx, onToggle, title) {
  const b = el('button', 'bypass' + (fx.on ? ' off' : ''), fx.on ? 'ON' : 'OFF');
  b.title = title || 'Click to bypass / engage';
  b.onclick = () => {
    Undo.push(fx.on ? 'Bypass FX' : 'Engage FX');
    fx.on = !fx.on;
    b.textContent = fx.on ? 'ON' : 'OFF';
    b.classList.toggle('off', fx.on);
    onToggle(); saveSession();
  };
  return b;
}

function syncChannelMeters(ch) {
  ch._meter = { l: 0, r: 0, pl: 0, pr: 0 };
}

function inputLabel(id) {
  if (!id || id === 'session') return 'Session default';
  if (id === 'default') return 'System default';
  const d = S.io.inputs.find(d => d.deviceId === id);
  return d ? (d.label || 'Mic') : 'Mic';
}

/* ------------------------- vocal chain templates -------------------------
   Save a channel's full FX chain (Tune→EQ→Comp→Delay→Reverb params + bypass
   states) as a named template; apply it to any channel in one click.
   Factory chains ship built-in; user chains live in localStorage. */
function getTemplates() {
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const list = factoryChains().map(f => ({ id: f.id, factory: true, name: f.name, params: deep(f.params) }));
  let user = [];
  try { user = JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) {}
  for (const u of user) {
    if (u && u.id && u.name && u.params) list.push({ id: u.id, name: String(u.name).slice(0, 40), params: deep(u.params) });
  }
  return list;
}

function saveUserTemplates(userList) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(userList)); } catch (e) {}
  scheduleFolderAutosave(); // templates ride along in the folder as vocal-chains.json
}

function applyTemplate(ch, tpl) {
  Undo.push('Apply vocal chain');
  const dp0 = defaultParams();
  for (const k of FX_KEYS) {
    ch.params[k] = tpl.params[k]
      ? JSON.parse(JSON.stringify(tpl.params[k]))
      : JSON.parse(JSON.stringify(dp0[k]));
  }
  ensureCtx().then(() => {
    // reverb impulse depends on size — regenerate for the new chain
    if (ch.nodes) { try { ch.nodes.conv.buffer = makeReverbImpulse(S.ctx, 2.2 * ch.params.verb.size); } catch (e) {} }
    applyChannelParams(ch);
    renderInspector();
  });
  saveSession();
  toast('Chain "' + tpl.name + '" → ' + ch.name);
}

function vocalChainBlock(ch) {
  const box = el('div', 'ins-block');
  box.append(el('h3', '', 'Vocal Chain'));
  const row = el('div', 'srow');
  row.append(el('label', '', 'Template'));
  const sel = document.createElement('select');
  sel.title = 'Pick a saved vocal chain to apply to this channel';
  sel.append(new Option('Choose a chain…', ''));
  for (const t of getTemplates()) sel.append(new Option(t.name + (t.factory ? ' ★' : ''), t.id));
  row.append(sel);
  const apply = el('button', 'abtn', 'Apply');
  apply.title = 'Apply the selected chain to this channel';
  apply.onclick = () => {
    const tpl = getTemplates().find(t => t.id === sel.value);
    if (!tpl) { toast('Pick a chain first.'); return; }
    applyTemplate(ch, tpl);
  };
  row.append(apply);
  box.append(row);
  const row2 = el('div', 'srow');
  row2.append(el('label', '', 'My chains'));
  const saveBtn = el('button', 'abtn ghost', 'Save current…');
  saveBtn.title = 'Save this channel\'s FX chain as a reusable template';
  saveBtn.onclick = () => {
    const name = prompt('Name this vocal chain:', ch.name + ' chain');
    if (!name || !name.trim()) return;
    const clean = name.trim().slice(0, 40);
    let user = [];
    try { user = JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) {}
    const ix = user.findIndex(u => u.name === clean);
    const rec = {
      id: ix >= 0 ? user[ix].id : uid('tpl'),
      name: clean,
      params: JSON.parse(JSON.stringify({ tune: ch.params.tune, eq: ch.params.eq, comp: ch.params.comp, delay: ch.params.delay, verb: ch.params.verb })),
    };
    if (ix >= 0) { if (!confirm('Overwrite "' + clean + '"?')) return; user[ix] = rec; }
    else user.push(rec);
    saveUserTemplates(user);
    renderInspector();
    toast('Chain "' + clean + '" saved.');
  };
  row2.append(saveBtn);
  box.append(row2);
  // manage (rename/delete) row for user templates
  const row3 = el('div', 'srow');
  row3.append(el('label', '', 'Manage'));
  const msel = document.createElement('select');
  msel.title = 'Pick one of your saved chains to rename or delete';
  msel.append(new Option('My chains…', ''));
  let user = [];
  try { user = JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) {}
  for (const u of user) msel.append(new Option(u.name, u.id));
  const ren = el('button', 'abtn ghost', 'Rename');
  ren.onclick = () => {
    const u = user.find(x => x.id === msel.value);
    if (!u) { toast('Pick one of your chains first.'); return; }
    const nn = prompt('Rename chain:', u.name);
    if (!nn || !nn.trim()) return;
    u.name = nn.trim().slice(0, 40);
    saveUserTemplates(user); renderInspector();
  };
  const del = el('button', 'abtn danger', 'Delete');
  del.onclick = () => {
    const u = user.find(x => x.id === msel.value);
    if (!u) { toast('Pick one of your chains first.'); return; }
    if (!confirm('Delete chain "' + u.name + '"?')) return;
    saveUserTemplates(user.filter(x => x.id !== u.id));
    renderInspector();
    toast('Chain deleted.');
  };
  row3.append(msel, ren, del);
  box.append(row3);
  box.append(el('div', 'fxnote', 'Chains snapshot Tune → Reverb (settings + bypass). ★ = built-in DAhYO chains. Apply to any vocal track in one click.'));
  return box;
}

/* ----------------------------- track headers --------------------------- */
function renderHeaders() {
  const box = $('track-headers');
  box.innerHTML = '';
  for (const ch of allChannels()) {
    const d = el('div', 'th' + (S.selId === ch.id ? ' sel' : '') + (ch.recArmed ? ' armed' : ''));
    d.title = ch.kind === 'aux' ? 'Aux track — receives from buses' : 'Audio track';
    const nm = el('div', 'th-name', ch.name);
    nm.title = 'Double-click to rename';
    nm.ondblclick = (e) => {
      e.stopPropagation();
      const nn = prompt('Track name:', ch.name);
      if (nn && nn.trim()) { ch.name = nn.trim().slice(0, 32); renderHeaders(); renderMixer(); renderInspector(); saveSession(); }
    };
    const sub = el('div', 'th-sub');
    if (ch.kind === 'aux') sub.append(el('span', 'badge aux', 'AUX'));
    sub.append(el('span', 'badge ' + ch.format, ch.format === 'mono' ? 'M' : 'ST'));
    const ioTxt = el('span', 'dim', (ch.kind === 'audio' ? 'in:' + inputLabel(ch.input).slice(0, 10) : 'bus in') + ' → ' + outLabel(ch.output));
    sub.append(ioTxt);
    const btns = el('div', 'th-btns');
    const m = el('button', 'mini m' + (ch.params.muted ? ' on' : ''), 'M');
    m.title = 'Mute (M mutes selected track)';
    m.onclick = (e) => { e.stopPropagation(); Undo.push(ch.params.muted ? 'Unmute track' : 'Mute track'); ensureCtx().then(() => { ch.params.muted = !ch.params.muted; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); }); };
    const s = el('button', 'mini s' + (ch.params.solo ? ' on' : ''), 'S');
    s.title = 'Solo (S solos selected track)';
    s.onclick = (e) => { e.stopPropagation(); Undo.push(ch.params.solo ? 'Unsolo track' : 'Solo track'); ensureCtx().then(() => { ch.params.solo = !ch.params.solo; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); }); };
    btns.append(m, s);
    if (ch.kind === 'audio') {
      const arm = el('button', 'mini arm' + (ch.recArmed ? ' on' : ''), '●');
      arm.title = 'Arm for recording (R arms selected track)';
      arm.onclick = (e) => { e.stopPropagation(); Undo.push(ch.recArmed ? 'Disarm track' : 'Arm track'); ch.recArmed = !ch.recArmed; renderHeaders(); saveSession(); };
      btns.append(arm);
      const mon = el('button', 'mini mon' + (ch.monitoring ? ' on' : ''), '🔊');
      mon.title = ch.monitoring ? 'Stop hearing the input' : 'Hear the input live (use headphones to avoid feedback)';
      mon.onclick = (e) => { e.stopPropagation(); toggleMonitor(ch); };
      btns.append(mon);
      // true pre-everything input meter (taps the raw mic stream)
      const im = document.createElement('canvas');
      im.className = 'inmeter'; im.width = 8; im.height = 40;
      im.title = 'Input level — straight from the mic, before any effects';
      im.style.display = (ch.recArmed || ch.monitoring) ? '' : 'none';
      ch._inMeterCanvas = im;
      btns.append(im);
    }
    const dup = el('button', 'mini', '⧉');
    dup.title = 'Duplicate track (clips, FX, routing, fader/pan)';
    dup.onclick = (e) => { e.stopPropagation(); duplicateChannel(id); };
    btns.append(dup);
    const del = el('button', 'mini del', '✕');
    del.title = 'Delete ' + (ch.kind === 'aux' ? 'aux + its bus' : 'track');
    del.onclick = (e) => { e.stopPropagation(); if (confirm('Delete "' + ch.name + '"?')) deleteChannel(ch.id); };
    btns.append(del);
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 1.25; vol.step = 0.01; vol.value = ch.params.vol;
    vol.title = 'Volume';
    vol.onclick = (e) => e.stopPropagation();
    undoableGesture(vol, 'Volume change');
    vol.oninput = () => { ch.params.vol = parseFloat(vol.value); ensureCtx().then(() => applyChannelParams(ch)); saveSession(); if (S.view === 'mixer') syncMixerFader(ch); };
    d.append(nm, sub, btns, vol);
    d.onclick = () => { S.selId = ch.id; renderHeaders(); renderMixer(); renderInspector(); };
    box.append(d);
  }
  if (!allChannels().length) {
    box.append(el('div', 'ins-empty', 'No tracks yet — hit ＋ Track or drop in audio.'));
  }
  // master track lane — the whole mix, with its own inserts
  const md = el('div', 'th master' + (S.selId === 'master' ? ' sel' : ''));
  md.title = 'Master track — the whole mix. Click for master inserts (EQ, compressor, limiter).';
  md.append(el('div', 'th-name', 'Master'));
  const msub = el('div', 'th-sub');
  msub.append(el('span', 'badge master', 'MSTR'), el('span', 'dim', 'the whole mix → speakers'));
  md.append(msub);
  md.onclick = () => { S.selId = 'master'; renderHeaders(); renderMixer(); renderInspector(); };
  box.append(md);
}

function outLabel(id) {
  if (!id || id === 'master') return 'Master';
  const b = S.buses.find(b => b.id === id);
  if (b) return b.name.slice(0, 12);
  const a = S.auxes.find(a => a.id === id);
  return a ? a.name.slice(0, 12) : '?';
}

function refreshMutes() {
  for (const ch of allChannels()) applyChannelParams(ch);
  drawTimeline();
}

/* ------------------------------ snap to grid ------------------------------
   Clips snap to grid divisions when snap is on, move freely when off. */
function snapDivSec() {
  const spb = 60 / (S.bpm || 120);
  const divs = { bar: spb * (S.timesig || 4), beat: spb, '8th': spb / 2, '16th': spb / 4 };
  return divs[S.snap.div] || spb;
}
function snapTime(t) {
  if (!S.snap.on) return t;
  const g = snapDivSec();
  return Math.round(t / g) * g;
}
function setSnapUI() {
  const b = $('btn-snap');
  if (b) { b.classList.toggle('on', S.snap.on); b.textContent = S.snap.on ? '🧲 Snap' : 'Snap off'; }
  const d = $('snap-div');
  if (d) d.value = S.snap.div;
}

/* ------------------------------- timeline ------------------------------ */
const tl = { canvas: null, x: null, lanes: [] };
const MARK_H = 18, RULER_H = 22;

function laneHeight() { return 64; }
function rulerTop() { return MARK_H + RULER_H; }

function clipGeom(clip, pps) {
  const cx = clip.start * pps, cw = Math.max(4, clip.duration * pps);
  return { cx, cw };
}
// Which fade handle (if any) is under mx for this clip: 'in' | 'out' | null
function fadeHandleAt(mx, cx, cw, clip, pps) {
  const fiW = Math.min(clip.fadeIn || 0, clip.duration / 2) * pps;
  const foW = Math.min(clip.fadeOut || 0, clip.duration / 2) * pps;
  if (Math.abs(mx - (cx + fiW)) < 8) return 'in';
  if (Math.abs(mx - (cx + cw - foW)) < 8) return 'out';
  return null;
}
function drawClipFades(x, clip, cx, cw, y, lh, pps) {
  const fi = Math.min(clip.fadeIn || 0, clip.duration / 2) * pps;
  const fo = Math.min(clip.fadeOut || 0, clip.duration / 2) * pps;
  const top = y + 6, bot = y + lh - 6;
  x.fillStyle = 'rgba(4,6,9,0.55)';
  if (fi > 1) { x.beginPath(); x.moveTo(cx, top); x.lineTo(cx + fi, top); x.lineTo(cx, bot); x.closePath(); x.fill(); }
  if (fo > 1) { x.beginPath(); x.moveTo(cx + cw, top); x.lineTo(cx + cw - fo, top); x.lineTo(cx + cw, bot); x.closePath(); x.fill(); }
  // grab handles — always visible so fades are discoverable
  x.fillStyle = 'rgba(255,176,46,0.85)';
  x.fillRect(cx + fi - 1.5, top, 3, bot - top);
  x.fillRect(cx + cw - fo - 1.5, top, 3, bot - top);
}

function drawTimeline() {
  try {
    const cv = tl.canvas, x = tl.x;
    if (!cv || !x) return;
    const wrap = $('timeline-wrap');
    const Wvis = wrap.clientWidth, H = wrap.clientHeight;
    const pps = S.pxPerSec;
    const needW = Math.max(Wvis, Math.ceil(S.duration * pps) + 80);
    if (cv.width !== needW || cv.height !== H) { cv.width = needW; cv.height = H; }
    cv.style.width = needW + 'px';
    const W = needW;
    x.clearRect(0, 0, W, H);
    tl.lanes = [];
    // marker lane
    x.fillStyle = '#0b0e13'; x.fillRect(0, 0, W, MARK_H);
    x.font = '9px sans-serif'; x.textBaseline = 'top'; x.textAlign = 'left';
    for (const m of S.markers) {
      const mx = m.pos * pps;
      x.fillStyle = '#ffb02e';
      x.beginPath(); x.moveTo(mx, 2); x.lineTo(mx + 7, 6); x.lineTo(mx, 10); x.closePath(); x.fill();
      x.fillStyle = '#c98a1e';
      x.fillText(m.name.slice(0, 18), mx + 9, 4);
    }
    // ruler
    x.fillStyle = '#0d1015'; x.fillRect(0, MARK_H, W, RULER_H);
    x.fillStyle = '#8b95a5';
    const spb = 60 / S.bpm, beats = Math.ceil(W / pps / spb) + 2;
    for (let b = 0; b <= beats; b++) {
      const px = b * spb * pps;
      x.strokeStyle = b % S.timesig === 0 ? '#2c3542' : '#1a2029';
      x.beginPath(); x.moveTo(px, MARK_H); x.lineTo(px, MARK_H + RULER_H); x.stroke();
      if (b % S.timesig === 0) x.fillText((b / S.timesig + 1), px + 3, MARK_H + 4);
    }
    // lanes
    const lh = laneHeight();
    let y = rulerTop();
    for (const ch of allChannels()) {
      tl.lanes.push({ ch, y, h: lh });
      x.fillStyle = ch.id === S.selId ? '#10151d' : '#0a0d12';
      x.fillRect(0, y, W, lh);
      x.strokeStyle = '#1a2029'; x.beginPath(); x.moveTo(0, y + lh); x.lineTo(W, y + lh); x.stroke();
      if (ch.kind === 'aux') {
        x.fillStyle = '#3a3f4a'; x.font = '11px sans-serif';
        x.fillText('AUX — receives from buses, no clips', 10, y + 26);
      } else {
        for (const clip of ch.clips) {
          const { cx, cw } = clipGeom(clip, pps);
          x.fillStyle = clip.missing ? '#3a2f1a' : '#12395e';
          x.strokeStyle = clip.missing ? '#8a6a2a' : '#2f9dff';
          x.lineWidth = 1;
          roundRect(x, cx, y + 6, cw, lh - 12, 5); x.fill(); x.stroke();
          if (clip.id === S.selClipId) {
            x.strokeStyle = '#ffb02e'; x.lineWidth = 2;
            roundRect(x, cx - 1, y + 5, cw + 2, lh - 10, 6); x.stroke();
            x.lineWidth = 1;
          }
          if (clip.peaks && !clip.missing) {
            x.fillStyle = '#7cc4ff';
            const n = clip.peaks.length;
            for (let i = 0; i < n; i++) {
              const px = cx + (i / n) * cw, ph = clip.peaks[i] * (lh - 20);
              x.fillRect(px, y + lh / 2 - ph / 2, Math.max(1, cw / n - 0.5), ph);
            }
          } else if (clip.missing) {
            x.fillStyle = '#8a6a2a'; x.font = '10px sans-serif';
            x.fillText('re-import audio', cx + 6, y + 26);
          }
          drawClipFades(x, clip, cx, cw, y, lh, pps);
          x.fillStyle = '#d9e0ea'; x.font = '10px sans-serif';
          x.fillText(clip.name.slice(0, 24), cx + 6, y + 10);
        }
      }
      y += lh;
    }
    // master meter footer — the whole mix at a glance (peaks read live here)
    if (S.masterAnL) {
      const mbuf = S._masterMeterBuf || (S._masterMeterBuf = new Float32Array(512));
      const mm = S._masterMeter || (S._masterMeter = { l: 0, r: 0, pl: 0, pr: 0 });
      mm.l = readPeak(S.masterAnL, mbuf); mm.r = readPeak(S.masterAnR, mbuf);
      if (mm.l >= 1 || mm.r >= 1) S._masterClip = true;
      const mh = 14, my0 = H - mh;
      x.fillStyle = '#0b0e13'; x.fillRect(0, my0, W, mh);
      const bw = Math.max(40, W - 110);
      x.fillStyle = '#8b95a5'; x.font = '9px sans-serif'; x.textAlign = 'left';
      x.fillText('MASTER', 6, my0 + 4);
      x.fillStyle = mm.l >= 1 ? '#ff5252' : '#35d07f';
      x.fillRect(52, my0 + 2, Math.min(1, mm.l) * bw, 4);
      x.fillStyle = mm.r >= 1 ? '#ff5252' : '#2f9dff';
      x.fillRect(52, my0 + 8, Math.min(1, mm.r) * bw, 4);
      if (S._masterClip) { x.fillStyle = '#ff5252'; x.fillText('CLIP — reset in Mixer', W - 108, my0 + 4); }
    }
    // playhead
    const pos = curPos(), px = pos * pps;
    x.strokeStyle = '#ffb02e'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke();
    x.lineWidth = 1;
  } catch (e) { /* the timeline must never white-screen */ }
}

function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function laneAtPoint(my) {
  return tl.lanes.find(l => my >= l.y && my < l.y + l.h) || null;
}
function laneAt(e) {
  const r = tl.canvas.getBoundingClientRect();
  return laneAtPoint(e.clientY - r.top);
}
function clampFade(v, clip) {
  return Math.min(Math.max(0, v), clip.duration / 2);
}
function selectedClip() {
  const ch = getChannel(S.selId);
  if (!ch || ch.kind !== 'audio') return null;
  const clip = ch.clips.find(c => c.id === S.selClipId);
  return clip ? { ch, clip } : null;
}
function deleteSelectedClip() {
  const sel = selectedClip();
  if (!sel) return;
  Undo.push('Delete clip');
  sel.ch.clips = sel.ch.clips.filter(c => c.id !== sel.clip.id);
  S.selClipId = null;
  try { idb.deleteClips([sel.clip.id]); } catch (e) {}
  updateDuration(); drawTimeline(); renderHeaders(); saveSession();
  toast('Clip deleted — Ctrl/Cmd+Z to undo.');
}

function seekFromEvent(e) {
  const r = tl.canvas.getBoundingClientRect();
  const pos = Math.max(0, (e.clientX - r.left) / S.pxPerSec);
  const was = S.playing;
  if (was) stop();
  S.playStartPos = Math.min(pos, S.duration);
  if (was) play(S.playStartPos);
  drawTimeline();
}

function initTimeline() {
  tl.canvas = $('timeline'); tl.x = tl.canvas.getContext('2d');
  const cv = tl.canvas;
  let mode = null; // 'seek' | 'move' | 'fade-in' | 'fade-out'
  let dragClip = null, moved = false, downX = 0, startVal = 0;

  const evXY = (e) => {
    const r = cv.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };
  const clipHitAt = (mx, my) => {
    const lane = laneAtPoint(my);
    if (!lane || lane.ch.kind !== 'audio') return null;
    const pps = S.pxPerSec;
    for (const clip of lane.ch.clips) {
      const { cx, cw } = clipGeom(clip, pps);
      if (mx >= cx - 4 && mx <= cx + cw + 4 && my >= lane.y + 4 && my < lane.y + lane.h - 4)
        return { ch: lane.ch, clip, lane, cx, cw };
    }
    return null;
  };
  const markerHitAt = (mx, my) => {
    if (my > MARK_H) return null;
    const pps = S.pxPerSec;
    for (const m of S.markers) if (Math.abs(mx - m.pos * pps) < 14) return m;
    return null;
  };

  cv.addEventListener('pointerdown', (e) => {
    try {
      const { mx, my } = evXY(e);
      downX = mx; moved = false; dragClip = null; mode = null;
      const mk = markerHitAt(mx, my);
      if (mk) { jumpToMarker(mk); return; }
      const hit = clipHitAt(mx, my);
      if (hit) {
        const { ch, clip, cx, cw } = hit;
        S.selId = ch.id; S.selClipId = clip.id;
        renderHeaders(); renderMixer(); renderInspector(); drawTimeline();
        const h = fadeHandleAt(mx, cx, cw, clip, S.pxPerSec);
        if (h) { mode = h === 'in' ? 'fade-in' : 'fade-out'; startVal = h === 'in' ? (clip.fadeIn || 0) : (clip.fadeOut || 0); }
        else { mode = 'move'; startVal = clip.start; }
        dragClip = clip;
        try { cv.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        return;
      }
      mode = 'seek';
      const lane = laneAtPoint(my);
      if (lane) {
        S.selId = lane.ch.id; S.selClipId = null;
        renderHeaders(); renderMixer(); renderInspector(); drawTimeline();
      }
      seekFromEvent(e);
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    } catch (err) {}
  });
  cv.addEventListener('pointermove', (e) => {
    try {
      if (!mode) { // hover cursor affordance for fade handles
        const { mx, my } = evXY(e);
        const hit = clipHitAt(mx, my);
        cv.style.cursor = (hit && fadeHandleAt(mx, hit.cx, hit.cw, hit.clip, S.pxPerSec)) ? 'ew-resize' : '';
        return;
      }
      const { mx } = evXY(e);
      const pps = S.pxPerSec, dx = (mx - downX) / pps;
      if (mode === 'seek') { seekFromEvent(e); return; }
      if (!dragClip) return;
      if (!moved && Math.abs(mx - downX) < 4) return;
      if (!moved) { moved = true; Undo.push(mode === 'move' ? 'Move clip' : 'Clip fade'); }
      if (mode === 'move') {
        dragClip.start = Math.max(0, snapTime(startVal + dx));
        updateDuration();
      } else if (mode === 'fade-in') {
        dragClip.fadeIn = clampFade(startVal + dx, dragClip);
      } else if (mode === 'fade-out') {
        dragClip.fadeOut = clampFade(startVal - dx, dragClip);
      }
      drawTimeline();
    } catch (err) {}
  });
  const endDrag = () => {
    try {
      if (moved && dragClip) { updateDuration(); saveSession(); drawTimeline(); }
    } catch (err) {}
    mode = null; dragClip = null; moved = false;
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('dblclick', (e) => {
    try {
      const r = cv.getBoundingClientRect();
      const mk = markerHitAt(e.clientX - r.left, e.clientY - r.top);
      if (mk) renameMarker(mk);
    } catch (err) {}
  });
  cv.addEventListener('contextmenu', (e) => {
    try {
      const r = cv.getBoundingClientRect();
      const mk = markerHitAt(e.clientX - r.left, e.clientY - r.top);
      if (mk) { e.preventDefault(); deleteMarker(mk); }
    } catch (err) {}
  });
  // drag & drop import
  const wrap = $('timeline-wrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!e.dataTransfer.files.length) return;
    const lane = laneAt(e);
    const target = lane && lane.ch.kind === 'audio' ? lane.ch : null;
    importFiles(e.dataTransfer.files, target);
  });
  window.addEventListener('resize', drawTimeline);
}

/* ------------------------------ zoom ------------------------------------- */
function zoomAt(factor) {
  S.pxPerSec = Math.min(800, Math.max(10, S.pxPerSec * factor));
  drawTimeline(); saveSession();
}
function zoomIn() { zoomAt(1.4); }
function zoomOut() { zoomAt(1 / 1.4); }
function zoomFit() {
  const w = ($('timeline-wrap').clientWidth || 800) - 80;
  if (S.duration > 0) S.pxPerSec = Math.min(800, Math.max(10, w / S.duration));
  drawTimeline(); saveSession();
  toast('Zoom fit — whole session in view.');
}

/* --------------------------- duplicate channel --------------------------- */
function duplicateChannel(id) {
  const ch = getChannel(id);
  if (!ch) return;
  Undo.push('Duplicate ' + ch.kind);
  const data = JSON.parse(JSON.stringify(serializeChannel(ch)));
  data.id = ch.kind === 'aux' ? uid('aux') : uid('tr');
  data.name = (ch.name + ' copy').slice(0, 32);
  const newClipIds = (data.clips || []).map(() => uid('clip'));
  (data.clips || []).forEach((c, i) => { c.id = newClipIds[i]; });
  const dup = hydrateChannel(data);
  // share audio buffers by reference; blobs persist lazily under the new ids
  (dup.clips || []).forEach((c, i) => {
    const o = ch.clips[i];
    if (o && o.buffer && !o.missing) { c.buffer = o.buffer; c.peaks = o.peaks; c.missing = false; c._blobSaved = false; }
  });
  if (ch.kind === 'aux' && ch.busId) {
    const ob = S.buses.find(b => b.id === ch.busId);
    if (ob) {
      const nb = addBus({ name: ob.name + ' copy', format: ob.format, silent: true });
      nb.output = dup.id;
      dup.busId = nb.id;
    }
  }
  const arr = ch.kind === 'aux' ? S.auxes : S.tracks;
  arr.splice(arr.indexOf(ch) + 1, 0, dup);
  if (S.ctx) {
    dup.nodes = makeChannelNodes(S.ctx, dup, { meters: true, tuneOK: S.tuneOK });
    applyParamsToNodes(dup, dup.nodes);
    rebuildLiveRoutingMaps();
    routeChannel(dup, dup.nodes, S.G);
    if (dup.busId) { const nb = S.buses.find(b => b.id === dup.busId); if (nb) { nb.node = S.ctx.createGain(); rebuildLiveRoutingMaps(); routeBus(nb, S.G); } }
  }
  S.selId = dup.id;
  renderHeaders(); renderMixer(); renderInspector(); renderIO();
  updateDuration(); drawTimeline(); saveSession();
  toast('Duplicated "' + ch.name + '" → "' + dup.name + '".');
}

/* ------------------------------ inspector -------------------------------- */
function renderInspector() {
  const ch = getChannel(S.selId);
  $('ins-title').textContent = ch ? ch.name + (ch.kind === 'aux' ? '  (AUX)' : '') : 'No channel selected';
  const body = $('ins-body');
  body.innerHTML = '';
  if (!ch) { body.append(el('div', 'ins-empty', 'Select a track or aux to shape its sound.')); return; }
  if (ch.isMaster) { renderMasterInspector(ch, body); return; }
  const P = ch.params;

  // ---- channel strip head ----
  const head = el('div', 'ins-block');
  head.append(el('h3', '', 'Channel'));
  const nameRow = el('div', 'srow');
  nameRow.append(el('label', '', 'Name'));
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.value = ch.name; nameInp.maxLength = 32;
  nameInp.title = 'Channel name';
  nameInp.onchange = () => { ch.name = nameInp.value.trim().slice(0, 32) || ch.name; renderHeaders(); renderMixer(); renderInspector(); saveSession(); };
  nameRow.append(nameInp);
  head.append(nameRow);
  const fmtRow = el('div', 'srow');
  fmtRow.append(el('label', '', 'Format'));
  fmtRow.append(el('span', 'dim', (ch.kind === 'aux' ? 'Aux' : 'Audio') + ' · ' + ch.format));
  head.append(fmtRow);

  // routing
  const routRow = el('div', 'srow');
  routRow.append(el('label', '', 'Output →'));
  const outSel = document.createElement('select');
  outSel.className = 'io-sel'; outSel.title = 'Where this channel sends its audio';
  outSel.append(new Option('Master', 'master'));
  for (const b of S.buses) outSel.append(new Option('Bus: ' + b.name, b.id));
  outSel.value = ch.output || 'master';
  outSel.onchange = () => {
    Undo.push('Routing change');
    ensureCtx().then(() => { ch.output = outSel.value; routeChannel(ch, ch.nodes, S.G); renderHeaders(); renderMixer(); renderIO(); saveSession(); });
  };
  routRow.append(outSel);
  head.append(routRow);

  if (ch.kind === 'audio') {
    const inRow = el('div', 'srow');
    inRow.append(el('label', '', 'Input'));
    const inSel = document.createElement('select');
    inSel.className = 'io-sel'; inSel.title = 'Microphone / interface used when recording on this track';
    inSel.append(new Option('System default', 'default'));
    for (const d of S.io.inputs) inSel.append(new Option(d.label || 'Input', d.deviceId));
    inSel.value = ch.input || 'default';
    inSel.onchange = () => { Undo.push('Input change'); ch.input = inSel.value; renderHeaders(); saveSession(); };
    inRow.append(inSel);
    head.append(inRow);
    const impRow = el('div', 'srow');
    impRow.append(el('label', '', 'Clips'));
    const impBtn = el('button', 'abtn', 'Import audio…');
    impBtn.title = 'Import an audio file onto this track (or drag & drop it on the timeline)';
    impBtn.onclick = () => { S._importTarget = ch.id; $('file-input').click(); };
    impRow.append(impBtn);
    head.append(impRow);
  } else {
    const feeders = busesFeedingAux(ch.id);
    const fRow = el('div', 'srow');
    fRow.append(el('label', '', 'Inputs'));
    fRow.append(el('span', 'dim', feeders.length ? feeders.map(b => b.name).join(', ') : '— (route a bus here)'));
    head.append(fRow);
  }
  body.append(head);

  // ---- sends ----
  const sends = el('div', 'ins-block');
  sends.append(el('h3', '', 'Sends'));
  sends.append(makeSendRow(ch, 'A'));
  sends.append(makeSendRow(ch, 'B'));
  const sendNote = el('div', 'fxnote', 'Post-fader sends → any bus or aux. Classic move: Send A → reverb aux, Send B → delay aux.');
  sends.append(sendNote);
  body.append(sends);

  // ---- selected clip ----
  const clipUI = clipBlock(ch);
  if (clipUI) body.append(clipUI);

  // ---- vocal chain templates ----
  body.append(vocalChainBlock(ch));

  // ---- fx ----
  body.append(fxChainBar(ch));
  body.append(fxTune(ch));
  body.append(fxEQ(ch));
  body.append(fxDeess(ch));
  body.append(fxGate(ch));
  body.append(fxComp(ch));
  body.append(fxSat(ch));
  body.append(fxChorus(ch));
  body.append(fxFlang(ch));
  body.append(fxDelay(ch));
  body.append(fxPpd(ch));
  body.append(fxVerb(ch));
  body.append(fxTrem(ch));
  body.append(fxFilt(ch));
  body.append(fxWide(ch));
  body.append(fxLim(ch));
}

/* Master track inspector: mix-bus inserts (EQ / Comp / Limiter). */
function renderMasterInspector(ch, body) {
  const head = el('div', 'ins-block');
  head.append(el('h3', '', 'Master — the whole mix'));
  head.append(el('div', 'fxnote', 'Inserts on the mix bus, before the mastering chain. The Master view (top) holds the full mastering engine.'));
  head.append(sliderRow('Volume', 0, 1.25, 0.01, S.master.vol, v => Math.round(v * 100) + '%',
    (v) => { S.master.vol = v; if (S.ctx) S.masterGain.gain.setTargetAtTime(v, S.ctx.currentTime, 0.02); saveSession(); renderMixer(); },
    'Master volume').row);
  body.append(head);
  body.append(fxEQ(ch));
  body.append(fxComp(ch));
  body.append(fxLim(ch));
}

/* Selected-clip editor: precise start + fades + delete (complements the
   timeline drag handles). */
function clipBlock(ch) {
  const sel = selectedClip();
  if (!sel || sel.ch.id !== ch.id) return null;
  const clip = sel.clip;
  const box = el('div', 'ins-block');
  box.append(el('h3', '', 'Clip'));
  const nm = el('div', 'srow');
  nm.append(el('label', '', 'Name'));
  const ni = document.createElement('input');
  ni.type = 'text'; ni.value = clip.name; ni.maxLength = 32;
  ni.title = 'Clip name';
  undoOnceOnFocus(ni, 'Rename clip');
  ni.onchange = () => { clip.name = ni.value.trim().slice(0, 32) || clip.name; drawTimeline(); saveSession(); };
  nm.append(ni);
  box.append(nm);
  const st = el('div', 'srow');
  st.append(el('label', '', 'Start (s)'));
  const si = document.createElement('input');
  si.type = 'number'; si.min = 0; si.step = 0.1; si.value = clip.start.toFixed(2);
  si.title = 'Clip start time in seconds';
  undoOnceOnFocus(si, 'Move clip');
  si.onchange = () => {
    const v = parseFloat(si.value);
    if (isNaN(v) || v < 0) { si.value = clip.start.toFixed(2); return; }
    clip.start = v; updateDuration(); drawTimeline(); saveSession();
  };
  st.append(si);
  box.append(st);
  const fr = el('div', 'srow');
  fr.append(el('label', '', 'Fade in/out'));
  const fi = document.createElement('input');
  fi.type = 'number'; fi.min = 0; fi.step = 0.05; fi.value = (clip.fadeIn || 0).toFixed(2);
  fi.title = 'Fade-in seconds (drag the amber handles on the clip too)';
  const fo = document.createElement('input');
  fo.type = 'number'; fo.min = 0; fo.step = 0.05; fo.value = (clip.fadeOut || 0).toFixed(2);
  fo.title = 'Fade-out seconds';
  undoOnceOnFocus(fi, 'Clip fade'); undoOnceOnFocus(fo, 'Clip fade');
  const applyF = () => {
    const a = parseFloat(fi.value), b = parseFloat(fo.value);
    const maxF = clip.duration / 2;
    clip.fadeIn = isNaN(a) ? 0 : Math.min(Math.max(0, a), maxF);
    clip.fadeOut = isNaN(b) ? 0 : Math.min(Math.max(0, b), maxF);
    fi.value = clip.fadeIn.toFixed(2); fo.value = clip.fadeOut.toFixed(2);
    drawTimeline(); saveSession();
  };
  fi.onchange = applyF; fo.onchange = applyF;
  fr.append(fi, fo);
  box.append(fr);
  const dr = el('div', 'srow');
  const del = el('button', 'abtn danger', 'Delete clip');
  del.title = 'Delete this clip (Ctrl/Cmd+Z undoes)';
  del.onclick = deleteSelectedClip;
  dr.append(del);
  box.append(dr);
  box.append(el('div', 'fxnote', 'Tip: drag a clip to move it, drag its amber edge handles for fades, ←/→ nudge it.'));
  return box;
}
// Snapshot-once-per-focus for text/number inputs (undo support).
function undoOnceOnFocus(input, label) {
  if (!input || input._undoWired) return;
  input._undoWired = true;
  input.addEventListener('focus', () => { try { Undo.push(label); } catch (e) {} });
}

function busOptions(sel, allowNone, excludeId) {
  sel.innerHTML = '';
  if (allowNone) sel.append(new Option('— none —', ''));
  for (const b of S.buses) sel.append(new Option('Bus: ' + b.name + (b.format === 'mono' ? ' (M)' : ''), b.id));
  for (const a of S.auxes) {
    if (a.id === excludeId) continue; // no self-sends (feedback)
    sel.append(new Option('Aux: ' + a.name, a.id));
  }
}

function makeSendRow(ch, which) {
  const P = ch.params;
  const key = 'send' + which;
  const row = el('div', 'send-row');
  row.append(el('span', 'sl', 'Send ' + which));
  const dest = document.createElement('select');
  dest.title = 'Send ' + which + ' destination (bus or aux)';
  busOptions(dest, true, ch.id);
  dest.value = P[key + 'Dest'] || '';
  dest.onchange = () => {
    Undo.push('Send routing');
    ensureCtx().then(() => {
      P[key + 'Dest'] = dest.value || null;
      if (P[key + 'Dest'] && P[key + 'Lvl'] === 0) P[key + 'Lvl'] = 0.5;
      routeSend(ch, ch.nodes, which, S.G);
      renderInspector(); saveSession();
    });
  };
  const knob = createKnob('Lvl', 0, 1, P[key + 'Lvl'],
    v => Math.round(v * 100) + '%',
    (v) => { P[key + 'Lvl'] = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); },
    'Send ' + which + ' level');
  row.append(dest, knob.el);
  return row;
}

/* ------------------------------ FX panels ------------------------------- */
function openModal(id) { const m = $(id); if (m) m.hidden = false; }
function closeModal(id) { const m = $(id); if (m) m.hidden = true; }

// Plain-language value formatters shared by plugin panels.
const fDb = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const fPct = v => Math.round(v * 100) + '%';
const fHz = v => v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz';
const fMs = v => (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' ms';
const FX_TITLES = {
  tune: 'Tune — pitch correction, gentle polish to hard effect',
  eq: 'EQ — 4-band tone shaping',
  deess: 'De-Esser — tames harsh S sounds',
  gate: 'Noise Gate — cuts hiss between phrases',
  comp: 'Compressor — evens out louds and quiets',
  sat: 'Saturator — warmth and grit',
  chorus: 'Chorus — thick shimmery movement',
  flang: 'Flanger — jet-plane sweep',
  delay: 'Echo — classic repeating delay',
  ppd: 'Ping-Pong Delay — echoes bounce left and right',
  verb: 'Reverb — hall and plate spaces',
  trem: 'Tremolo — rhythmic volume pulsing',
  filt: 'Auto-Filter — wah-style sweeping filter',
  wide: 'Stereo Widener — mid/side spread, mono-safe',
  lim: 'Limiter — loud without clipping',
};
// Plugin panel shell: collapse, ⚡ Auto, bypass. Returns {box, body}.
function fxShell(key, title, fx, ch, note) {
  S._fxCollapsed = S._fxCollapsed || {};
  const box = el('div', 'ins-block fx');
  box.dataset.fx = key;
  const h = el('h3', 'fxhead');
  const ck = ch.id + ':' + key;
  const chev = el('button', 'fxchev', S._fxCollapsed[ck] ? '▸' : '▾');
  chev.title = 'Collapse / expand this plugin';
  const nm = el('span', 'fxname', title);
  nm.title = 'Click to collapse / expand';
  nm.style.cursor = 'pointer';
  const auto = el('button', 'abtn auto', '⚡ Auto');
  auto.title = 'Analyze this track and set smart starting settings — then tweak everything by hand';
  auto.onclick = () => autoFX(ch, key);
  h.append(chev, nm, el('span', 'spacer'), auto,
    bypassBtn(fx, () => ensureCtx().then(() => applyChannelParams(ch)), title + ': click to bypass / engage'));
  box.append(h);
  if (note) box.append(el('div', 'fxnote', note));
  const body = el('div', 'fx-body');
  box.append(body);
  const setC = (c) => { S._fxCollapsed[ck] = !!c; chev.textContent = c ? '▸' : '▾'; body.style.display = c ? 'none' : ''; };
  chev.onclick = () => setC(!S._fxCollapsed[ck]);
  nm.onclick = () => setC(!S._fxCollapsed[ck]);
  setC(!!S._fxCollapsed[ck]);
  return { box, body };
}
function fxApply(ch) { ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }
// Tempo-sync toggle used by time-based plugins.
function syncToggle(ch, P, label) {
  const b = el('button', 'abtn ghost syncbtn' + (P.sync ? ' on' : ''), P.sync ? '🔗 Tempo sync: ON' : '🔗 Tempo sync: off');
  b.title = (label || 'Lock to the project tempo') + ' (' + S.bpm + ' BPM) — the knob below is ignored while sync is on';
  b.onclick = () => { Undo.push('FX tempo sync'); P.sync = !P.sync; fxApply(ch); renderInspector(); };
  return b;
}
function segControl(opts, value, onPick, title) {
  const w = el('div', 'seg');
  for (const [val, label] of opts) {
    const b = el('button', 'segbtn' + (val === value ? ' on' : ''), label);
    if (title) b.title = title;
    b.onclick = () => onPick(val);
    w.append(b);
  }
  return w;
}
function scrollToFX(key) {
  requestAnimationFrame(() => {
    const b = document.querySelector('[data-fx="' + key + '"]');
    if (b) {
      b.scrollIntoView({ behavior: 'smooth', block: 'start' });
      b.classList.add('flash');
      setTimeout(() => b.classList.remove('flash'), 900);
    }
  });
}

// --- TUNE ---
function fxTune(ch) {
  const T = ch.params.tune;
  const { box, body } = fxShell('tune', 'Tune', T, ch, 'Pitch correction. ⚡ Auto hears the key of your track. Monophonic sources (vocals, bass) — chords will smear.');
  if (S.ctx && !S.tuneOK) {
    body.append(el('div', 'fxnote warn', 'Pitch correction needs AudioWorklet, which this browser does not support — Tune is bypassed here. Everything else works normally.'));
  }
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  body.append(cv);
  ch._tuneCanvas = cv;
  ch._tuneMsg = (d) => { ch._tuneData = d; };
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Retune', 0, 1, T.speed,
    v => v < 0.25 ? 'Hard' : v < 0.6 ? Math.round(v * 100) + '' : v < 0.85 ? 'Chill' : 'Natural',
    (v) => { T.speed = v; ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); },
    'Retune speed — left is hard T-Pain style, right is transparent').el);
  const keyWrap = el('div', 'knob');
  keyWrap.title = 'Correction key — ⚡ Auto detects this for you';
  const keyLab = el('div', 'kl', 'Key');
  const keySel = document.createElement('select');
  KEY_NAMES.forEach((kn, i) => keySel.append(new Option(kn, i)));
  keySel.value = T.key;
  keySel.onchange = () => { Undo.push('FX: Tune key'); T.key = parseInt(keySel.value); ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); };
  keyWrap.append(keyLab, keySel);
  const scWrap = el('div', 'knob');
  scWrap.title = 'Correction scale — ⚡ Auto detects this for you';
  const scLab = el('div', 'kl', 'Scale');
  const scSel = document.createElement('select');
  Object.keys(SCALES).forEach(k => scSel.append(new Option(k, k)));
  scSel.value = T.scale;
  scSel.onchange = () => { Undo.push('FX: Tune scale'); T.scale = scSel.value; ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); };
  scWrap.append(scLab, scSel);
  kr.append(keyWrap, scWrap);
  body.append(kr);
  return box;
}

function drawTuneNeedle(ch) {
  const cv = ch._tuneCanvas;
  if (!cv || !cv.isConnected) return;
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  const d = ch._tuneData;
  x.fillStyle = '#0a0d12'; x.fillRect(0, 0, W, H);
  // scale arc
  x.strokeStyle = '#242c37'; x.lineWidth = 8;
  x.beginPath(); x.arc(W / 2, H - 8, 52, Math.PI, 2 * Math.PI); x.stroke();
  // center tick
  x.strokeStyle = '#35d07f'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(W / 2, H - 8 - 58); x.lineTo(W / 2, H - 8 - 46); x.stroke();
  x.fillStyle = '#8b95a5'; x.font = '9px sans-serif'; x.textAlign = 'center';
  x.fillText('-50¢', W / 2 - 52, H - 14);
  x.fillText('+50¢', W / 2 + 52, H - 14);
  if (d && d.detected > 0 && d.target > 0) {
    const cents = 1200 * Math.log2(d.detected / d.target);
    const cl = Math.max(-50, Math.min(50, cents));
    const ang = Math.PI + (cl + 50) / 100 * Math.PI;
    x.strokeStyle = Math.abs(cents) < 6 ? '#35d07f' : '#ffb02e';
    x.lineWidth = 3;
    x.beginPath(); x.moveTo(W / 2, H - 8);
    x.lineTo(W / 2 + Math.cos(ang) * 52, H - 8 + Math.sin(ang) * 52); x.stroke();
    x.fillStyle = '#d9e0ea'; x.font = '10px sans-serif';
    const note = KEY_NAMES[Math.round(69 + 12 * Math.log2(d.target / 440)) % 12];
    x.fillText(d.detected.toFixed(1) + ' Hz → ' + note + ' (' + (cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢)', W / 2, 14);
  } else {
    x.fillStyle = '#3a3f4a'; x.font = '10px sans-serif';
    x.fillText(TUNE_NEEDLE_IDLE, W / 2, 16);
  }
}
const TUNE_NEEDLE_IDLE = 'sing or play — needle shows live correction';

// --- EQ (4-band parametric) ---
function fxEQ(ch) {
  const E = ch.params.eq;
  const { box, body } = fxShell('eq', 'EQ', E, ch, '4-band tone shaping. ⚡ Auto finds harsh ringing frequencies and cuts them. Boost lows for weight, cut mud at 300–500 Hz, add air on top.');
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  body.append(cv);
  ch._eqCanvas = cv;
  const eqRow = (label, fKey, fMin, fMax, fFmt, gKey, qKey) => {
    const wrap = el('div', 'eqband');
    wrap.append(el('div', 'eqband-t', label));
    const fr = sliderRow('Freq', fMin, fMax, 1, E[fKey], fFmt,
      (v) => { E[fKey] = v; fxApply(ch); drawEQCurve(ch); }, label + ' frequency').row;
    const gr = sliderRow('Gain', -12, 12, 0.5, E[gKey], fDb,
      (v) => { E[gKey] = v; fxApply(ch); drawEQCurve(ch); }, label + ' boost/cut').row;
    wrap.append(fr, gr);
    if (qKey) {
      const qr = sliderRow('Focus', 0.3, 8, 0.1, E[qKey], v => 'Q ' + v.toFixed(1),
        (v) => { E[qKey] = v; fxApply(ch); drawEQCurve(ch); }, label + ' width — narrow cuts surgically, wide shapes tone').row;
      wrap.append(qr);
    }
    return wrap;
  };
  body.append(eqRow('Low', 'lowF', 40, 800, fHz, 'lowG'));
  body.append(eqRow('Mid 1', 'pm1F', 120, 12000, fHz, 'pm1G', 'pm1Q'));
  body.append(eqRow('Mid 2', 'pm2F', 120, 12000, fHz, 'pm2G', 'pm2Q'));
  body.append(eqRow('High', 'highF', 2000, 18000, fHz, 'highG'));
  requestAnimationFrame(() => drawEQCurve(ch));
  return box;
}

function drawEQCurve(ch) {
  const cv = ch._eqCanvas;
  if (!cv || !cv.isConnected || !ch.nodes) return;
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#0a0d12'; x.fillRect(0, 0, W, H);
  const N = 72, freq = new Float32Array(N), mag = new Float32Array(N), phase = new Float32Array(N);
  for (let i = 0; i < N; i++) freq[i] = 40 * Math.pow(20000 / 40, i / (N - 1));
  const { eqLow, eqP1, eqP2, eqHigh } = ch.nodes;
  try {
    const m1 = new Float32Array(N), m2 = new Float32Array(N), m3 = new Float32Array(N), m4 = new Float32Array(N);
    const p = new Float32Array(N);
    eqLow.getFrequencyResponse(freq, m1, p);
    eqP1.getFrequencyResponse(freq, m2, p);
    eqP2.getFrequencyResponse(freq, m3, p);
    eqHigh.getFrequencyResponse(freq, m4, p);
    for (let i = 0; i < N; i++) mag[i] = m1[i] * m2[i] * m3[i] * m4[i];
  } catch (e) { return; }
  const dbAt = (m) => 20 * Math.log10(Math.max(1e-4, m));
  // grid
  x.strokeStyle = '#1a2029'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
  // curve
  x.strokeStyle = '#2f9dff'; x.lineWidth = 2.5; x.beginPath();
  for (let i = 0; i < N; i++) {
    const db = Math.max(-18, Math.min(18, dbAt(mag[i])));
    const py = H / 2 - (db / 18) * (H / 2 - 6);
    const px = (i / (N - 1)) * W;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.stroke();
  // fill
  x.lineTo(W, H / 2); x.lineTo(0, H / 2); x.closePath();
  x.fillStyle = 'rgba(47,157,255,.12)'; x.fill();
  x.fillStyle = '#8b95a5'; x.font = '9px sans-serif'; x.textAlign = 'left';
  x.fillText('40Hz', 4, H - 4); x.fillText('20kHz', W - 34, H - 4);
}

// --- COMPRESSOR (clean / vintage) ---
function fxComp(ch) {
  const C = ch.params.comp;
  const { box, body } = fxShell('comp', 'Compressor', C, ch, 'Evens out louds and quiets, glues the sound. ⚡ Auto sets the threshold from your level. Vintage adds warm color and slower, musical squeeze.');
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  body.append(cv);
  ch._compCanvas = cv;
  body.append(segControl([['clean', 'Clean'], ['vintage', 'Vintage']], C.style,
    (v) => { Undo.push('FX: Comp style'); C.style = v; fxApply(ch); renderInspector(); },
    'Clean = transparent modern squeeze. Vintage = warm color, slower attack, musical release.'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Threshold', -48, 0, C.threshold, v => v.toFixed(0) + ' dB',
    (v) => { C.threshold = v; fxApply(ch); }, 'Level where compression kicks in — lower = more squeeze').el);
  kr.append(createKnob('Ratio', 1, 20, C.ratio, v => v.toFixed(1) + ':1',
    (v) => { C.ratio = v; fxApply(ch); }, 'How hard it squeezes past the threshold').el);
  body.append(kr);
  body.append(el('div', 'fxnote dim', C.style === 'vintage'
    ? 'Vintage: slow 30 ms attack, 400 ms release, warm saturation color.'
    : 'Clean: fast 3 ms attack, 120 ms release, transparent.'));
  return box;
}

function drawCompGR(ch) {
  const cv = ch._compCanvas;
  if (!cv || !cv.isConnected || !ch.nodes) return;
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#0a0d12'; x.fillRect(0, 0, W, H);
  let gr = 0;
  try { gr = ch.nodes.comp.reduction || 0; } catch (e) {}
  gr = Math.min(0, gr); // negative dB
  const w = Math.min(W, (-gr / 24) * W);
  const grad = x.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#35d07f'); grad.addColorStop(0.6, '#ffd23e'); grad.addColorStop(1, '#ff5252');
  x.fillStyle = grad;
  x.fillRect(0, H / 2 - 12, w, 24);
  x.fillStyle = '#8b95a5'; x.font = '10px sans-serif'; x.textAlign = 'left';
  x.fillText('GR', 6, 14);
  x.fillStyle = '#ffb02e'; x.textAlign = 'right';
  x.fillText(gr.toFixed(1) + ' dB', W - 6, 14);
  x.fillStyle = '#3a3f4a'; x.textAlign = 'left';
  x.fillText('gain reduction — the harder it works, the more the bar fills', 6, H - 6);
}

// --- DELAY ---
function fxDelay(ch) {
  const D = ch.params.delay;
  const { box, body } = fxShell('delay', 'Echo', D, ch, 'Classic repeating echo. ⚡ Auto locks it to your project tempo. Short times thicken, long times bounce.');
  body.append(syncToggle(ch, D, 'Lock echo repeats to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Time', 0.03, 1.5, D.time, v => Math.round(v * 1000) + 'ms',
    (v) => { D.time = v; fxApply(ch); }, 'Delay time — ignored while tempo sync is on').el);
  kr.append(createKnob('Repeats', 0, 0.9, D.feedback, fPct,
    (v) => { D.feedback = v; fxApply(ch); }, 'Repeats — careful past 70%').el);
  kr.append(createKnob('Mix', 0, 1, D.mix, fPct,
    (v) => { D.mix = v; fxApply(ch); }, 'How loud the echo sits').el);
  body.append(kr);
  return box;
}

// --- PING-PONG DELAY ---
function fxPpd(ch) {
  const D = ch.params.ppd;
  const { box, body } = fxShell('ppd', 'Ping-Pong Delay', D, ch, 'Echoes bounce left ↔ right. ⚡ Auto locks it to your project tempo. Needs a stereo track to ping-pong.');
  body.append(syncToggle(ch, D, 'Lock bounce to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Time', 0.03, 1.5, D.time, v => Math.round(v * 1000) + 'ms',
    (v) => { D.time = v; fxApply(ch); }, 'Bounce time — ignored while tempo sync is on').el);
  kr.append(createKnob('Repeats', 0, 0.9, D.feedback, fPct,
    (v) => { D.feedback = v; fxApply(ch); }, 'How many bounces').el);
  kr.append(createKnob('Mix', 0, 1, D.mix, fPct,
    (v) => { D.mix = v; fxApply(ch); }, 'How loud the bounces sit').el);
  body.append(kr);
  return box;
}

// --- REVERB (hall / plate) ---
function fxVerb(ch) {
  const V = ch.params.verb;
  const { box, body } = fxShell('verb', 'Reverb', V, ch, 'Generated studio space. Put it on an aux and feed it with Send A for classic throws.');
  body.append(segControl([['hall', 'Hall'], ['plate', 'Plate']], V.type,
    (v) => {
      Undo.push('FX: Reverb type'); V.type = v;
      ensureCtx().then(() => {
        if (ch.nodes) { try { ch.nodes.conv.buffer = makeReverbImpulse(S.ctx, 2.2 * V.size, V.type); } catch (e) {} }
        saveSession(); renderInspector();
      });
    }, 'Hall = big natural room. Plate = dense, smooth studio classic.'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Mix', 0, 1, V.mix, fPct,
    (v) => { V.mix = v; fxApply(ch); }, 'How much room you hear').el);
  kr.append(createKnob('Size', 0.3, 2, V.size, v => v < 0.8 ? 'Room' : v < 1.4 ? 'Hall' : 'Cathedral',
    (v) => {
      V.size = v;
      ensureCtx().then(() => {
        if (ch.nodes) { try { ch.nodes.conv.buffer = makeReverbImpulse(S.ctx, 2.2 * v, V.type); } catch (e) {} }
        saveSession();
      });
    }, 'Room size — regenerates the space').el);
  body.append(kr);
  return box;
}

// --- DE-ESSER ---
function fxDeess(ch) {
  const D = ch.params.deess;
  const { box, body } = fxShell('deess', 'De-Esser', D, ch, 'Tames harsh S and T sounds without dulling the vocal. ⚡ Auto finds where your sibilance lives.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Trouble spot', 3000, 12000, D.freq, fHz,
    (v) => { D.freq = v; fxApply(ch); }, 'The frequency where the harsh S lives').el);
  kr.append(createKnob('Tame amount', -48, -6, D.threshold, v => v.toFixed(0) + ' dB',
    (v) => { D.threshold = v; fxApply(ch); }, 'Lower = grabs more of the harshness').el);
  body.append(kr);
  return box;
}

// --- NOISE GATE ---
function fxGate(ch) {
  const G = ch.params.gate;
  const { box, body } = fxShell('gate', 'Noise Gate', G, ch, 'Cuts background hiss, hum and bleed between phrases. ⚡ Auto sets the cutoff just above your noise floor.');
  if (S.ctx && !S.gateOK) {
    body.append(el('div', 'fxnote warn', 'Gate needs AudioWorklet, which this browser does not support — it is bypassed here.'));
  }
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Cutoff', -60, -10, G.threshold, v => v.toFixed(0) + ' dB',
    (v) => { G.threshold = v; fxApply(ch); }, 'Silence below this level gets cut').el);
  kr.append(createKnob('Opens in', 0.001, 0.2, G.attack, fMs,
    (v) => { G.attack = v; fxApply(ch); }, 'How fast the gate opens — too fast can click').el);
  body.append(kr);
  const kr2 = el('div', 'knob-row');
  kr2.append(createKnob('Closes in', 0.02, 1, G.release, v => Math.round(v * 1000) + ' ms',
    (v) => { G.release = v; fxApply(ch); }, 'How fast the gate closes after sound stops').el);
  kr2.append(createKnob('Cut depth', 0, 60, G.range, v => v.toFixed(0) + ' dB',
    (v) => { G.range = v; fxApply(ch); }, 'How much it turns down when closed').el);
  body.append(kr2);
  return box;
}

// --- SATURATOR ---
function fxSat(ch) {
  const St = ch.params.sat;
  const { box, body } = fxShell('sat', 'Saturator', St, ch, 'Warmth, grit and harmonics — from gentle tape-style glow to aggressive distortion.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Grit', 0, 1, St.drive, fPct,
    (v) => { St.drive = v; fxApply(ch); }, 'How hard it saturates').el);
  kr.append(createKnob('Brightness', 800, 16000, St.tone, fHz,
    (v) => { St.tone = v; fxApply(ch); }, 'Tames harsh top-end from the saturation').el);
  body.append(kr);
  return box;
}

// --- CHORUS ---
function fxChorus(ch) {
  const C = ch.params.chorus;
  const { box, body } = fxShell('chorus', 'Chorus', C, ch, 'Thick, shimmery movement — like doubled guitars or wide synth pads. ⚡ Auto locks the wobble to tempo.');
  body.append(syncToggle(ch, C, 'Lock the wobble to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Wobble', 0.05, 8, C.rate, v => v.toFixed(2) + ' Hz',
    (v) => { C.rate = v; fxApply(ch); }, 'Wobble speed — ignored while tempo sync is on').el);
  kr.append(createKnob('Depth', 0, 1, C.depth, fPct,
    (v) => { C.depth = v; fxApply(ch); }, 'How deep the wobble goes').el);
  kr.append(createKnob('Mix', 0, 1, C.mix, fPct,
    (v) => { C.mix = v; fxApply(ch); }, 'How much chorus you hear').el);
  body.append(kr);
  return box;
}

// --- FLANGER ---
function fxFlang(ch) {
  const F = ch.params.flang;
  const { box, body } = fxShell('flang', 'Flanger', F, ch, 'Jet-plane whoosh sweep. ⚡ Auto locks the sweep to tempo.');
  body.append(syncToggle(ch, F, 'Lock the sweep to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Sweep', 0.05, 8, F.rate, v => v.toFixed(2) + ' Hz',
    (v) => { F.rate = v; fxApply(ch); }, 'Sweep speed — ignored while tempo sync is on').el);
  kr.append(createKnob('Depth', 0, 1, F.depth, fPct,
    (v) => { F.depth = v; fxApply(ch); }, 'How wide the sweep goes').el);
  body.append(kr);
  const kr2 = el('div', 'knob-row');
  kr2.append(createKnob('Whoosh', 0, 0.85, F.feedback, fPct,
    (v) => { F.feedback = v; fxApply(ch); }, 'Feedback — more = stronger jet effect').el);
  kr2.append(createKnob('Mix', 0, 1, F.mix, fPct,
    (v) => { F.mix = v; fxApply(ch); }, 'How much flanger you hear').el);
  body.append(kr2);
  return box;
}

// --- TREMOLO ---
function fxTrem(ch) {
  const T = ch.params.trem;
  const { box, body } = fxShell('trem', 'Tremolo', T, ch, 'Rhythmic volume pulsing — from gentle shimmer to choppy helicopter. ⚡ Auto locks the pulse to tempo.');
  body.append(syncToggle(ch, T, 'Lock the pulse to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Pulse', 0.1, 20, T.rate, v => v.toFixed(2) + ' Hz',
    (v) => { T.rate = v; fxApply(ch); }, 'Pulse speed — ignored while tempo sync is on').el);
  kr.append(createKnob('Depth', 0, 1, T.depth, fPct,
    (v) => { T.depth = v; fxApply(ch); }, 'How deep the volume dips').el);
  body.append(kr);
  return box;
}

// --- AUTO-FILTER / WAH ---
function fxFilt(ch) {
  const F = ch.params.filt;
  const { box, body } = fxShell('filt', 'Auto-Filter', F, ch, 'Wah-style sweeping filter — funky rhythmic sweeps. ⚡ Auto locks the sweep to tempo.');
  body.append(syncToggle(ch, F, 'Lock the sweep to the project tempo'));
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Center', 100, 4000, F.base, fHz,
    (v) => { F.base = v; fxApply(ch); }, 'Where the sweep is centered').el);
  kr.append(createKnob('Sweep', 0, 1, F.depth, fPct,
    (v) => { F.depth = v; fxApply(ch); }, 'How far it sweeps').el);
  body.append(kr);
  const kr2 = el('div', 'knob-row');
  kr2.append(createKnob('Speed', 0.05, 8, F.rate, v => v.toFixed(2) + ' Hz',
    (v) => { F.rate = v; fxApply(ch); }, 'Sweep speed — ignored while tempo sync is on').el);
  kr2.append(createKnob('Sharp', 0.5, 12, F.q, v => 'Q ' + v.toFixed(1),
    (v) => { F.q = v; fxApply(ch); }, 'Resonance — higher = more vocal-like wah').el);
  body.append(kr2);
  return box;
}

// --- STEREO WIDENER ---
function fxWide(ch) {
  const W = ch.params.wide;
  const { box, body } = fxShell('wide', 'Stereo Widener', W, ch, 'Mid/side spread — pushes the sides wider while the center stays put. ⚡ Auto reads how wide your track already is. Mono-safe: collapsing to mono loses nothing.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Width', 0, 2.5, W.width, v => v.toFixed(2) + '×',
    (v) => { W.width = v; fxApply(ch); }, '1 = untouched, higher = wider').el);
  body.append(kr);
  return box;
}

// --- LIMITER ---
function fxLim(ch) {
  const L = ch.params.lim;
  const { box, body } = fxShell('lim', 'Limiter', L, ch, 'Final safety net — catches peaks so the mix gets loud without clipping. ⚡ Auto sets the ceiling from your tallest peaks.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Ceiling', -24, 0, L.threshold, v => v.toFixed(1) + ' dB',
    (v) => { L.threshold = v; fxApply(ch); }, 'Nothing passes this level — lower = louder, denser').el);
  kr.append(createKnob('Release', 0.01, 0.5, L.release, v => Math.round(v * 1000) + ' ms',
    (v) => { L.release = v; fxApply(ch); }, 'How fast it lets go after catching a peak').el);
  body.append(kr);
  return box;
}

/* ------------------------- mastering engine ------------------------------
   Dedicated mastering view + chain: Mastering EQ -> Multiband compressor ->
   Stereo imager -> Maximizer (limiter + makeup) -> Dither (at export).
   All original DAhYO DSP. A/B bypass compares mastered vs unmastered mix. */
function defaultMasterChain() {
  const dp = defaultParams();
  return {
    on: true,
    meq: Object.assign({ on: true }, JSON.parse(JSON.stringify(dp.eq))),
    mb: { on: true, xlow: 250, xhigh: 4000, lThr: -12, mThr: -12, hThr: -12, ratio: 2.5, attack: 0.01, release: 0.15 },
    img: { on: true, width: 1.2 },
    max: { on: true, threshold: -1, release: 0.08, makeup: 0 },
    dither: { on: true },
  };
}
function masterChain() {
  if (!S.masterChain) S.masterChain = defaultMasterChain();
  return S.masterChain;
}
const MASTER_TEMPLATES = {
  streaming: { name: 'Streaming Loud', desc: 'Competitive loudness for Spotify/Apple — clean and controlled',
    set: { mb: { lThr: -14, mThr: -14, hThr: -16, ratio: 3 }, img: { width: 1.25 }, max: { threshold: -1, makeup: 2 } } },
  club: { name: 'Club / DJ', desc: 'Big low-end, extra punch for loud systems',
    set: { meq: { lowG: 1.5 }, mb: { lThr: -10, mThr: -14, hThr: -16, ratio: 3.5 }, max: { threshold: -0.5, makeup: 3 } } },
  warm: { name: 'Warm Analog', desc: 'Gentle glue, soft top — vintage character',
    set: { meq: { highG: -1 }, mb: { lThr: -12, mThr: -12, hThr: -12, ratio: 2, attack: 0.03, release: 0.3 }, max: { threshold: -1.5, makeup: 1 } } },
  radio: { name: 'Radio Ready', desc: 'Tight, bright, forward vocal — cuts through',
    set: { meq: { pm2G: 1, highG: 0.5 }, mb: { lThr: -16, mThr: -12, hThr: -12, ratio: 3 }, img: { width: 1.15 }, max: { threshold: -1, makeup: 2.5 } } },
  acoustic: { name: 'Acoustic / Dynamic', desc: 'Barely-there mastering — keeps every dynamic',
    set: { mb: { lThr: -6, mThr: -6, hThr: -6, ratio: 1.5 }, img: { width: 1.05 }, max: { threshold: -1, makeup: 0 } } },
};
function applyMasterTemplate(tkey) {
  const t = MASTER_TEMPLATES[tkey];
  if (!t) return;
  Undo.push('Mastering template: ' + t.name);
  const C = masterChain();
  for (const [stage, vals] of Object.entries(t.set)) Object.assign(C[stage], vals);
  C.on = true;
  applyMastering(); saveSession(); renderMastering();
  toast('Mastering: "' + t.name + '" — every knob still tweakable.');
}
// 3-band crossover compressor (12 dB/oct splits)
function buildMultiband(ctx) {
  const nd = {};
  nd.in = ctx.createGain(); nd.out = ctx.createGain();
  nd.lpL = ctx.createBiquadFilter(); nd.lpL.type = 'lowpass';
  nd.hpM = ctx.createBiquadFilter(); nd.hpM.type = 'highpass';
  nd.lpM = ctx.createBiquadFilter(); nd.lpM.type = 'lowpass';
  nd.hpH = ctx.createBiquadFilter(); nd.hpH.type = 'highpass';
  nd.cL = ctx.createDynamicsCompressor(); nd.cM = ctx.createDynamicsCompressor(); nd.cH = ctx.createDynamicsCompressor();
  nd.in.connect(nd.lpL); nd.lpL.connect(nd.cL); nd.cL.connect(nd.out);
  nd.in.connect(nd.hpM); nd.hpM.connect(nd.lpM); nd.lpM.connect(nd.cM); nd.cM.connect(nd.out);
  nd.in.connect(nd.hpH); nd.hpH.connect(nd.cH); nd.cH.connect(nd.out);
  return nd;
}
function applyMultiband(nd, P, t) {
  nd.lpL.frequency.setTargetAtTime(P.xlow, t, 0.02);
  nd.hpM.frequency.setTargetAtTime(P.xlow, t, 0.02);
  nd.lpM.frequency.setTargetAtTime(P.xhigh, t, 0.02);
  nd.hpH.frequency.setTargetAtTime(P.xhigh, t, 0.02);
  const bands = [[nd.cL, P.lThr], [nd.cM, P.mThr], [nd.cH, P.hThr]];
  for (const [c, thr] of bands) {
    c.threshold.setTargetAtTime(thr, t, 0.02);
    c.ratio.setTargetAtTime(P.ratio, t, 0.02);
    c.attack.setTargetAtTime(P.attack, t, 0.02);
    c.release.setTargetAtTime(P.release, t, 0.02);
  }
}
function buildMasteringNodes(ctx) {
  const meq = buildRackModuleNodes(ctx, 'eq', true);
  const mb = buildMultiband(ctx);
  const img = buildRackModuleNodes(ctx, 'wide', true);
  const max = buildRackModuleNodes(ctx, 'lim', true);
  const makeup = ctx.createGain();
  meq.ins.out.connect(mb.in); mb.out.connect(img.ins.in);
  img.ins.out.connect(max.ins.in); max.ins.out.connect(makeup);
  const slot = makeSlot(ctx, () => ({ in: meq.ins.in, out: makeup }), false);
  return { slot, meq: meq.nd, mb, img: img.nd, max: max.nd, makeup };
}
function applyMastering() {
  const C = masterChain();
  if (!S.ctx || !S.mchain) return;
  const t = S.ctx.currentTime, M = S.mchain;
  M.slot.setBypassed(!C.on, t);
  applyRackModuleNodes('eq', M.meq, C.meq, t);
  applyMultiband(M.mb, C.mb, t);
  applyRackModuleNodes('wide', M.img, C.img, t);
  applyRackModuleNodes('lim', M.max, C.max, t);
  M.makeup.gain.setTargetAtTime(Math.pow(10, C.max.makeup / 20), t, 0.02);
}
// Master track: dedicated lane + mixer strip with its own inserts (EQ/Comp/Lim).
function getMasterCh() {
  if (!S.master.params) {
    const dp = defaultParams();
    S.master.params = {
      eq: JSON.parse(JSON.stringify(dp.eq)),
      comp: JSON.parse(JSON.stringify(dp.comp)),
      lim: JSON.parse(JSON.stringify(dp.lim)),
    };
  }
  return { id: 'master', kind: 'master', name: 'Master', format: 'stereo', params: S.master.params, nodes: null, isMaster: true, clips: [] };
}
function applyMasterFX() {
  const P = getMasterCh().params;
  if (!S.ctx || !S.masterFX) return;
  const t = S.ctx.currentTime;
  for (const type of ['eq', 'comp', 'lim']) {
    const M = S.masterFX[type];
    M.slot.setBypassed(!P[type].on, t);
    applyRackModuleNodes(type, M.nd, P[type], t);
  }
}

/* ------------------------- plugin library browser --------------------------
   Pro Tools-style insert picker: type-to-search by name, browse by category.
   Clicking a plugin engages it on the selected channel — and runs Auto first
   (no generic defaults) when there is audio to analyze. */
const PLUGIN_CATS = ['All', 'EQ', 'Dynamics', 'Reverb', 'Delay', 'Pitch', 'Modulation', 'Saturation', 'Utility', 'Vocal'];
const PLUGIN_CATALOG = [
  { key: 'tune',   name: 'Tune',            cat: 'Pitch',      desc: 'Pitch correction — gentle polish to hard effect' },
  { key: 'eq',     name: 'Parametric EQ',   cat: 'EQ',         desc: '4-band tone shaping — cut mud, add air' },
  { key: 'deess',  name: 'De-Esser',        cat: 'Dynamics',   desc: 'Tames harsh S and T sounds' },
  { key: 'gate',   name: 'Noise Gate',      cat: 'Dynamics',   desc: 'Cuts hiss and bleed between phrases' },
  { key: 'comp',   name: 'Compressor',      cat: 'Dynamics',   desc: 'Evens out louds and quiets — clean or vintage color' },
  { key: 'sat',    name: 'Saturator',       cat: 'Saturation', desc: 'Warmth, grit and harmonics' },
  { key: 'chorus', name: 'Chorus',          cat: 'Modulation', desc: 'Thick, shimmery doubling movement' },
  { key: 'flang',  name: 'Flanger',         cat: 'Modulation', desc: 'Jet-plane whoosh sweep' },
  { key: 'delay',  name: 'Echo',            cat: 'Delay',      desc: 'Classic repeating echo, tempo-syncable' },
  { key: 'ppd',    name: 'Ping-Pong Delay', cat: 'Delay',      desc: 'Echoes bounce left and right' },
  { key: 'verb',   name: 'Reverb',          cat: 'Reverb',     desc: 'Hall and plate spaces, generated in the box' },
  { key: 'trem',   name: 'Tremolo',         cat: 'Modulation', desc: 'Rhythmic volume pulsing' },
  { key: 'filt',   name: 'Auto-Filter',     cat: 'Modulation', desc: 'Wah-style sweeping filter' },
  { key: 'wide',   name: 'Stereo Widener',  cat: 'Utility',    desc: 'Mid/side spread — mono-safe' },
  { key: 'lim',    name: 'Limiter',         cat: 'Dynamics',   desc: 'Final safety net — loud without clipping' },
  { key: 'rack',   name: 'Vocal Rack',      cat: 'Vocal',      desc: 'Stacked vocal chain in one window — gate, de-esser, EQ, comp & more' },
];
function openPluginBrowser(ch) {
  if (!ch || ch.isMaster) { toast('Pick a track or aux first, then add a plugin.'); return; }
  S._browserCh = ch.id;
  S._browserCat = 'All';
  const s = $('plugin-search'); if (s) s.value = '';
  renderPluginBrowser();
  openModal('modal-plugins');
  setTimeout(() => { const si = $('plugin-search'); if (si) si.focus(); }, 60);
}
function renderPluginBrowser() {
  const ch = getChannel(S._browserCh);
  const q = (($('plugin-search') || {}).value || '').toLowerCase().trim();
  const cat = S._browserCat || 'All';
  const cats = $('plugin-cats'); cats.innerHTML = '';
  for (const c of PLUGIN_CATS) {
    const b = el('button', 'catchip' + (c === cat ? ' on' : ''), c);
    b.onclick = () => { S._browserCat = c; renderPluginBrowser(); };
    cats.append(b);
  }
  const list = $('plugin-list'); list.innerHTML = '';
  let n = 0;
  for (const p of PLUGIN_CATALOG) {
    if (cat !== 'All' && p.cat !== cat) continue;
    if (q && !(p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q))) continue;
    n++;
    const isOn = p.key === 'rack' ? !!(ch && ch.params.rack.on) : !!(ch && ch.params[p.key] && ch.params[p.key].on);
    const row = el('button', 'plugin-row');
    const top = el('div', 'prow-top');
    top.append(el('b', '', p.name), el('span', 'pcat', p.cat), el('span', 'spacer'),
      el('span', 'pstate' + (isOn ? ' on' : ''), isOn ? 'ON' : 'off'));
    row.append(top, el('div', 'dim small', p.desc));
    row.onclick = () => engagePlugin(ch, p.key);
    list.append(row);
  }
  if (!n) list.append(el('div', 'dim pad', 'No plugins match — try another search.'));
}
// Insert path: engaging a plugin runs Auto first (analyzes the track) instead
// of sitting on generic defaults. Falls back to defaults when no audio yet.
function engagePlugin(ch, key) {
  if (!ch) return;
  if (key === 'rack') { closeModal('modal-plugins'); openRack(ch, true); return; }
  const P = ch.params[key];
  if (!P) return;
  const fresh = !P.on;
  P.on = true;
  closeModal('modal-plugins');
  if (fresh) { autoFX(ch, key); scrollToFX(key); }
  else { ensureCtx().then(() => applyChannelParams(ch)); saveSession(); renderInspector(); scrollToFX(key); }
}
// Insert-slot chip bar above the plugin panels (Pro Tools-style inserts row).
function fxChainBar(ch) {
  const bar = el('div', 'fxchain');
  bar.append(el('span', 'fxchain-label', 'Inserts'));
  for (const key of FX_KEYS) {
    const P = ch.params[key];
    const c = el('button', 'fxchip' + (P.on ? ' on' : ''), FX_LABELS[key]);
    c.title = FX_TITLES[key] + ' — click to ' + (P.on ? 'jump to its controls' : 'add it (Auto-tunes to this track first)');
    c.onclick = () => { if (P.on) scrollToFX(key); else openPluginBrowser(ch); };
    bar.append(c);
  }
  const rk = el('button', 'fxchip' + (ch.params.rack.on ? ' on' : ''), 'Rack');
  rk.title = 'Vocal Rack — stacked vocal chain in one window';
  rk.onclick = () => openRack(ch, false);
  bar.append(rk);
  const add = el('button', 'fxchip add', '+ Plugin');
  add.title = 'Open the plugin library — search by name or browse by category';
  add.onclick = () => openPluginBrowser(ch);
  bar.append(add);
  return bar;
}

/* ------------------------------ vocal rack UI ---------------------------- */
const RACK_CONTROLS = {
  gate: [
    ['threshold', 'Cutoff', -60, -10, v => v.toFixed(0) + ' dB', 'Silence below this level gets cut'],
    ['attack', 'How fast it opens', 0.001, 0.2, fMs, 'Too fast can click'],
    ['release', 'How fast it closes', 0.02, 1, v => Math.round(v * 1000) + ' ms', ''],
    ['range', 'Cut depth', 0, 60, v => v.toFixed(0) + ' dB', 'How much it turns down when closed'],
  ],
  deess: [
    ['freq', 'Trouble spot', 3000, 12000, fHz, 'Where the harsh S lives'],
    ['threshold', 'Tame amount', -48, -6, v => v.toFixed(0) + ' dB', 'Lower grabs more harshness'],
  ],
  eq: [
    ['lowF', 'Low freq', 40, 800, fHz, ''], ['lowG', 'Low tone', -12, 12, fDb, ''],
    ['pm1F', 'Mid 1 freq', 120, 12000, fHz, ''], ['pm1Q', 'Mid 1 focus', 0.3, 8, v => 'Q ' + v.toFixed(1), ''],
    ['pm1G', 'Mid 1', -12, 12, fDb, ''],
    ['pm2F', 'Mid 2 freq', 120, 12000, fHz, ''], ['pm2Q', 'Mid 2 focus', 0.3, 8, v => 'Q ' + v.toFixed(1), ''],
    ['pm2G', 'Mid 2', -12, 12, fDb, ''],
    ['highF', 'High freq', 2000, 18000, fHz, ''], ['highG', 'High tone (air)', -12, 12, fDb, ''],
  ],
  comp: [
    ['threshold', 'Squeeze starts at', -48, 0, v => v.toFixed(0) + ' dB', ''],
    ['ratio', 'Squeeze amount', 1, 20, v => v.toFixed(1) + ':1', ''],
  ],
  sat: [
    ['drive', 'Grit', 0, 1, fPct, 'How hard it saturates'],
    ['tone', 'Brightness', 800, 16000, fHz, 'Tames harsh top-end'],
  ],
  doubler: [
    ['mix', 'Double loudness', 0, 1, fPct, ''],
    ['width', 'Wobble amount', 0, 1, fPct, ''],
    ['rate', 'Wobble speed', 0.1, 4, v => v.toFixed(2) + ' Hz', ''],
  ],
  wide: [['width', 'How wide', 0, 2.5, v => v.toFixed(2) + '×', '1 = untouched']],
};
function applyRackModuleLive(ch, mod) {
  ensureCtx().then(() => {
    const m = (ch._rackMods || []).find(x => x.spec === mod);
    if (m && S.ctx) applyRackModuleNodes(m.spec.type, m.nd, m.spec.params, S.ctx.currentTime);
    saveSession();
  });
}
function openRack(ch, isInsert) {
  if (!ch || ch.isMaster) { toast('The Vocal Rack lives on tracks and auxes — pick one first.'); return; }
  S._rackCh = ch.id;
  if (isInsert && !rackHasModules(ch)) {
    // auto-first: load the Lead Vocal stack and Auto-tune every module
    ch.params.rack.on = true;
    ch.params.rack.modules = RACK_PRESETS.lead.modules.map(t => ({ id: uid('rm'), type: t, on: true, params: rackModuleDefaults(t) }));
    ensureCtx().then(() => { rebuildRackChain(ch, S.gateOK); applyChannelParams(ch); });
    const mods = ch.params.rack.modules;
    if (getAnalysisBuffer(ch)) {
      let i = 0;
      const step = () => {
        if (i >= mods.length) { saveSession(); renderRack(); renderInspector(); return; }
        const m = mods[i++];
        autoFX(ch, 'rack:' + m.type, m.params, () => { applyRackModuleLive(ch, m); step(); }, true);
      };
      step();
      toast('⚡ Vocal Rack inserted — Auto-tuning every module to this track…');
    } else {
      toast('Vocal Rack loaded with the Lead Vocal stack — add audio, then tap ⚡ Auto on each module.');
      saveSession();
    }
  }
  renderRack();
  openModal('modal-rack');
}
function loadRackPreset(ch, pkey) {
  const pr = RACK_PRESETS[pkey];
  if (!pr) return;
  Undo.push('Rack preset: ' + pr.name);
  ch.params.rack.on = true;
  ch.params.rack.modules = pr.modules.map(t => ({ id: uid('rm'), type: t, on: true, params: rackModuleDefaults(t) }));
  ensureCtx().then(() => { rebuildRackChain(ch, S.gateOK); applyChannelParams(ch); });
  const mods = ch.params.rack.modules;
  if (getAnalysisBuffer(ch)) {
    let i = 0;
    const step = () => {
      if (i >= mods.length) { saveSession(); renderRack(); renderInspector(); return; }
      const m = mods[i++];
      autoFX(ch, 'rack:' + m.type, m.params, () => { applyRackModuleLive(ch, m); step(); }, true);
    };
    step();
    toast('⚡ "' + pr.name + '" loaded — Auto-tuning every module…');
  } else {
    toast('"' + pr.name + '" loaded — add audio, then tap ⚡ Auto on each module.');
    saveSession();
  }
  renderRack();
}
function renderRack() {
  const ch = getChannel(S._rackCh);
  const wrap = $('rack-modules');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!ch) { wrap.append(el('div', 'dim pad', 'Pick a track first.')); return; }
  $('rack-title').textContent = 'Vocal Rack — ' + ch.name;
  const mods = ch.params.rack.modules || [];
  const psel = $('rack-preset');
  if (psel && psel.options.length <= 1) {
    for (const [k, p] of Object.entries(RACK_PRESETS)) psel.append(new Option(p.name, k));
  }
  mods.forEach((mod, idx) => {
    const T = RACK_TYPES[mod.type] || { name: mod.type, desc: '' };
    const card = el('div', 'rackmod' + (mod.on ? '' : ' off'));
    const head = el('div', 'rm-head');
    head.append(el('span', 'rm-pos', String(idx + 1)));
    const nm = el('b', '', T.name);
    head.append(nm, el('span', 'dim small', T.desc), el('span', 'spacer'));
    const up = el('button', 'abtn ghost tiny', '▲');
    up.title = 'Move earlier in the chain';
    up.onclick = () => {
      if (idx === 0) return;
      Undo.push('Reorder rack');
      [mods[idx - 1], mods[idx]] = [mods[idx], mods[idx - 1]];
      ensureCtx().then(() => rebuildRackChain(ch, S.gateOK));
      saveSession(); renderRack();
    };
    const dn = el('button', 'abtn ghost tiny', '▼');
    dn.title = 'Move later in the chain';
    dn.onclick = () => {
      if (idx === mods.length - 1) return;
      Undo.push('Reorder rack');
      [mods[idx + 1], mods[idx]] = [mods[idx], mods[idx + 1]];
      ensureCtx().then(() => rebuildRackChain(ch, S.gateOK));
      saveSession(); renderRack();
    };
    const auto = el('button', 'abtn auto tiny', '⚡ Auto');
    auto.title = 'Analyze this track and set smart starting settings for this module';
    auto.onclick = () => autoFX(ch, 'rack:' + mod.type, mod.params,
      () => { applyRackModuleLive(ch, mod); saveSession(); renderRack(); });
    const byp = el('button', 'bypass' + (mod.on ? ' off' : ''), mod.on ? 'ON' : 'OFF');
    byp.title = 'Bypass this module';
    byp.onclick = () => {
      Undo.push(mod.on ? 'Bypass rack module' : 'Engage rack module');
      mod.on = !mod.on;
      ensureCtx().then(() => { rebuildRackChain(ch, S.gateOK); applyChannelParams(ch); });
      saveSession(); renderRack(); renderInspector();
    };
    const del = el('button', 'abtn ghost tiny danger', '✕');
    del.title = 'Remove this module';
    del.onclick = () => {
      Undo.push('Remove rack module');
      mods.splice(idx, 1);
      ensureCtx().then(() => { rebuildRackChain(ch, S.gateOK); applyChannelParams(ch); });
      saveSession(); renderRack(); renderInspector();
    };
    head.append(up, dn, auto, byp, del);
    card.append(head);
    const bd = el('div', 'rm-body');
    if (mod.type === 'comp') {
      bd.append(segControl([['clean', 'Clean'], ['vintage', 'Vintage']], mod.params.style,
        (v) => { mod.params.style = v; applyRackModuleLive(ch, mod); renderRack(); }, 'Clean or vintage color'));
    }
    for (const [key, label, min, max, fmt, hint] of (RACK_CONTROLS[mod.type] || [])) {
      const step = (max - min) > 50 ? 1 : 0.01;
      const { row } = sliderRow(label, min, max, step, mod.params[key], fmt,
        (v) => { mod.params[key] = v; applyRackModuleLive(ch, mod); }, hint || label);
      bd.append(row);
    }
    card.append(bd);
    wrap.append(card);
  });
  if (!mods.length) wrap.append(el('div', 'dim pad', 'Empty rack — pick a starter stack above, or add modules below.'));
}

/* ------------------------------- mixer ----------------------------------- */
function renderMixer() {
  const box = $('strips');
  box.innerHTML = '';
  for (const ch of allChannels()) box.append(makeStrip(ch));
  box.append(makeMasterStrip());
}

function makeStrip(ch) {
  const s = el('div', 'strip' + (S.selId === ch.id ? ' sel' : ''));
  s.title = ch.kind === 'aux' ? 'Aux track' : 'Audio track';
  const nm = el('div', 'sname', ch.name);
  nm.title = 'Double-click to rename';
  nm.ondblclick = (e) => {
    e.stopPropagation();
    const nn = prompt('Channel name:', ch.name);
    if (nn && nn.trim()) { ch.name = nn.trim().slice(0, 32); renderHeaders(); renderMixer(); renderInspector(); saveSession(); }
  };
  const meter = document.createElement('canvas');
  meter.className = 'meter'; meter.width = 44; meter.height = 150;
  meter.title = 'Post-fader level';
  ch._meterCanvas = meter;
  const led = el('button', 'clipled', '');
  led.title = 'Clip light — lights up if the signal clips, click to reset';
  led.onclick = (e) => { e.stopPropagation(); ch._clip = false; led.classList.remove('lit'); };
  ch._clipLed = led;
  const fader = document.createElement('input');
  fader.type = 'range'; fader.className = 'fader';
  fader.min = 0; fader.max = 1.25; fader.step = 0.01; fader.value = ch.params.vol;
  fader.setAttribute('orient', 'vertical');
  fader.title = ch.name + ' volume fader';
  fader.oninput = () => {
    ch.params.vol = parseFloat(fader.value);
    ensureCtx().then(() => applyChannelParams(ch));
    saveSession();
  };
  undoableGesture(fader, 'Fader: ' + ch.name);
  ch._mixerFader = fader;
  const pan = createKnob('Pan', -1, 1, ch.params.pan,
    v => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100),
    (v) => { ch.params.pan = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); },
    ch.name + ' pan');
  const msrow = el('div', 'msrow');
  const m = el('button', 'mini m' + (ch.params.muted ? ' on' : ''), 'M');
  m.title = 'Mute ' + ch.name + ' (M mutes selected)';
  m.onclick = (e) => { e.stopPropagation(); Undo.push(ch.params.muted ? 'Unmute track' : 'Mute track'); ensureCtx().then(() => { ch.params.muted = !ch.params.muted; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); }); };
  const sb = el('button', 'mini s' + (ch.params.solo ? ' on' : ''), 'S');
  sb.title = 'Solo ' + ch.name + ' (S solos selected)';
  sb.onclick = (e) => { e.stopPropagation(); Undo.push(ch.params.solo ? 'Unsolo track' : 'Solo track'); ensureCtx().then(() => { ch.params.solo = !ch.params.solo; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); }); };
  msrow.append(m, sb);
  const iolab = el('div', 'iolab',
    (ch.kind === 'audio' ? inputLabel(ch.input === 'session' ? S.io.inputId : ch.input) : busesFeedingAux(ch.id).map(b => b.name).join('+') || 'no input') +
    '\n→ ' + outLabel(ch.output));
  iolab.title = 'Input → output routing';
  s.append(nm, led, meter, fader, pan.el, msrow, iolab);
  s.onclick = () => { S.selId = ch.id; renderHeaders(); renderMixer(); renderInspector(); };
  return s;
}

function syncMixerFader(ch) {
  if (ch._mixerFader && ch._mixerFader.isConnected) ch._mixerFader.value = ch.params.vol;
}

function makeMasterStrip() {
  const s = el('div', 'strip master');
  s.title = 'Master output';
  s.append(el('div', 'sname', 'Master'));
  const meter = document.createElement('canvas');
  meter.className = 'meter'; meter.width = 44; meter.height = 150;
  meter.title = 'Master level (post-fader)';
  S._masterMeterCanvas = meter;
  const led = el('button', 'clipled', '');
  led.title = 'Master clip light — lights up if the mix clips, click to reset';
  led.onclick = (e) => { e.stopPropagation(); S._masterClip = false; led.classList.remove('lit'); };
  S._masterClipLed = led;
  const fader = document.createElement('input');
  fader.type = 'range'; fader.className = 'fader';
  fader.min = 0; fader.max = 1.25; fader.step = 0.01; fader.value = S.master.vol;
  fader.setAttribute('orient', 'vertical');
  fader.title = 'Master volume';
  fader.oninput = () => {
    S.master.vol = parseFloat(fader.value);
    if (S.ctx) S.masterGain.gain.setTargetAtTime(S.master.vol, S.ctx.currentTime, 0.02);
    saveSession();
  };
  undoableGesture(fader, 'Master fader');
  const fxB = el('button', 'abtn ghost tiny', 'FX');
  fxB.title = 'Master inserts — EQ, compressor and limiter on the whole mix';
  fxB.onclick = () => { S.selId = 'master'; renderHeaders(); renderMixer(); renderInspector(); setView('arrange'); };
  s.append(led, meter, fader, fxB, el('div', 'iolab', '→ speakers'));
  return s;
}

function paintMeter(cv, l, r, pl, pr, clip) {
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
  const pairs = [[l, pl, 4], [r, pr, W / 2 + 1]];
  for (const [v, pk, bx] of pairs) {
    const bw = W / 2 - 5;
    const h = Math.min(1, v) * (H - 8);
    const grad = x.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, '#35d07f'); grad.addColorStop(0.75, '#ffd23e'); grad.addColorStop(1, '#ff5252');
    x.fillStyle = grad;
    x.fillRect(bx, H - 4 - h, bw, h);
    // peak hold
    const ph = Math.min(1, pk) * (H - 8);
    x.fillStyle = pk >= 0.99 ? '#ff5252' : '#ffd23e';
    x.fillRect(bx, H - 5 - ph, bw, 2);
  }
}

function readPeak(an, buf) {
  an.getFloatTimeDomainData(buf);
  let p = 0;
  for (let i = 0; i < buf.length; i += 2) { const a = Math.abs(buf[i]); if (a > p) p = a; }
  return p;
}

function drawMeters() {
  for (const ch of allChannels()) {
    const cv = ch._meterCanvas;
    if (!cv || !cv.isConnected || !ch.nodes || !ch.nodes.anL) continue;
    const buf = ch.nodes._meterBuf;
    const m = ch._meter || (ch._meter = { l: 0, r: 0, pl: 0, pr: 0 });
    m.l = readPeak(ch.nodes.anL, buf);
    m.r = readPeak(ch.nodes.anR, buf);
    m.pl = Math.max(m.pl - 0.01, m.l);
    m.pr = Math.max(m.pr - 0.01, m.r);
    if (m.l >= 1 || m.r >= 1) ch._clip = true; // clip LED latches
    if (ch._clipLed) ch._clipLed.classList.toggle('lit', !!ch._clip);
    paintMeter(cv, m.l, m.r, m.pl, m.pr);
  }
  const mc = S._masterMeterCanvas;
  if (mc && mc.isConnected && S.masterAnL) {
    const m = S._masterMeter || (S._masterMeter = { l: 0, r: 0, pl: 0, pr: 0 });
    const buf = S._masterMeterBuf || (S._masterMeterBuf = new Float32Array(512));
    m.l = readPeak(S.masterAnL, buf);
    m.r = readPeak(S.masterAnR, buf);
    m.pl = Math.max(m.pl - 0.01, m.l);
    m.pr = Math.max(m.pr - 0.01, m.r);
    if (m.l >= 1 || m.r >= 1) S._masterClip = true;
    if (S._masterClipLed) S._masterClipLed.classList.toggle('lit', !!S._masterClip);
    paintMeter(mc, m.l, m.r, m.pl, m.pr);
  }
  drawInputMeters();
}

/* ------------------------------- I/O panel ------------------------------ */
function openIO() {
  $('modal-io').hidden = false;
  renderIO();
  refreshIODevices();
}
function closeIO() { $('modal-io').hidden = true; }

async function refreshIODevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) { renderIO(); return; }
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    st.getTracks().forEach(t => t.stop());
  } catch (e) { /* labels may stay empty; devices still listed */ }
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    S.io.inputs = devs.filter(d => d.kind === 'audioinput');
    S.io.outputs = devs.filter(d => d.kind === 'audiooutput');
  } catch (e) {}
  renderIO();
}

function ioRow(label, active, btnText, onBtn) {
  const row = el('div', 'io-dev' + (active ? ' active' : ''));
  const g = el('span', 'grow', label);
  g.title = label;
  row.append(g);
  if (active) row.append(el('span', 'badge', 'IN USE'));
  else if (onBtn) { const b = el('button', 'abtn ghost', btnText); b.onclick = onBtn; row.append(b); }
  return row;
}

function renderIO() {
  // inputs
  const ii = $('io-inputs'); ii.innerHTML = '';
  ii.append(ioRow('System default input', S.io.inputId === 'default', 'Use', () => { S.io.inputId = 'default'; renderIO(); renderHeaders(); renderMixer(); saveSession(); }));
  for (const d of S.io.inputs) {
    const id = d.deviceId;
    ii.append(ioRow(d.label || 'Microphone ' + id.slice(0, 6), S.io.inputId === id, 'Use',
      () => { S.io.inputId = id; renderIO(); renderHeaders(); renderMixer(); saveSession(); toast('Default input set.'); }));
  }
  if (!S.io.inputs.length) ii.append(el('div', 'dim small', 'No microphones found — connect one and reopen I/O.'));
  // input mode: clean music vs processed voice
  const imode = el('div', 'io-dev');
  imode.append(el('span', 'grow', 'Input mode'));
  const imSel = document.createElement('select');
  imSel.title = 'Music (clean) records with no browser processing — no artifacts. Voice (processed) keeps the browser cleanup for spoken word.';
  imSel.append(new Option('🎵 Music (clean) — no processing', 'music'));
  imSel.append(new Option('🎙 Voice (processed)', 'voice'));
  imSel.value = S.io.inputMode || 'music';
  imSel.onchange = () => {
    S.io.inputMode = imSel.value; saveSession();
    toast(S.io.inputMode === 'music'
      ? '🎵 Music mode — mic records clean, no browser processing.'
      : '🎙 Voice mode — browser noise cleanup on.');
  };
  imode.append(imSel);
  ii.append(imode);
  // session sample rate
  const srate = el('div', 'io-dev');
  srate.append(el('span', 'grow', 'Session quality'));
  const srSel = document.createElement('select');
  srSel.title = 'Project sample rate — higher = more detail, more CPU. Restarts the audio engine.';
  for (const [v, l] of [[44100, '44.1 kHz — CD quality'], [48000, '48 kHz — video standard'], [96000, '96 kHz — high resolution']])
    srSel.append(new Option(l, v));
  srSel.value = String(S.io.sessionRate || 44100);
  srSel.onchange = () => {
    const v = parseInt(srSel.value);
    if (v === S.io.sessionRate) return;
    if (!confirm('Switch session quality to ' + (v / 1000) + ' kHz? The audio engine restarts.')) { srSel.value = String(S.io.sessionRate); return; }
    S.io.sessionRate = v; saveSession();
    resetAudioEngine();
  };
  srate.append(srSel);
  ii.append(srate);
  // outputs
  const io = $('io-outputs'); io.innerHTML = '';
  const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  io.append(ioRow('System default output', S.io.outputId === 'default', 'Use', () => setOutputDevice('default')));
  for (const d of S.io.outputs) {
    const id = d.deviceId;
    io.append(ioRow(d.label || 'Output ' + id.slice(0, 6), S.io.outputId === id, 'Use', () => setOutputDevice(id)));
  }
  if (!canSink) io.append(el('div', 'dim small', 'This browser cannot switch outputs (setSinkId unsupported) — using system default.'));
  // buses
  const bl = $('io-buses'); bl.innerHTML = '';
  for (const b of S.buses) {
    const row = el('div', 'io-dev');
    row.append(el('span', 'grow', b.name));
    row.append(el('span', 'badge ' + b.format, b.format === 'mono' ? 'M' : 'ST'));
    const outSel = document.createElement('select');
    outSel.title = 'Bus "' + b.name + '" output';
    outSel.append(new Option('→ Master', 'master'));
    for (const a of S.auxes) {
      if (a.output === b.id) continue; // would create a feedback loop
      outSel.append(new Option('→ Aux: ' + a.name, a.id));
    }
    outSel.value = b.output || 'master';
    outSel.onchange = () => { Undo.push('Bus routing'); ensureCtx().then(() => { b.output = outSel.value; routeBus(b, S.G); renderIORouting(); renderMixer(); saveSession(); }); };
    const del = el('button', 'abtn danger', '✕');
    del.title = 'Delete bus';
    del.onclick = () => { if (confirm('Delete bus "' + b.name + '"? Tracks/sends using it reset to Master.')) deleteBus(b.id); };
    row.append(outSel, del);
    bl.append(row);
  }
  if (!S.buses.length) bl.append(el('div', 'dim small', 'No buses yet — create one, or add an Aux track (auto-creates its bus).'));
  renderIORouting();
}

function renderIORouting() {
  const box = $('io-routing');
  if (!box) return;
  box.innerHTML = '';
  for (const ch of allChannels()) {
    const row = el('div', 'io-route');
    row.append(el('span', 'rn', (ch.kind === 'aux' ? 'AUX · ' : '') + ch.name));
    if (ch.kind === 'audio') {
      const inSel = makeInputSelect(ch);
      inSel.onchange = () => { ch.input = inSel.value; renderHeaders(); renderMixer(); saveSession(); };
      row.append(inSel);
    } else {
      const feeders = busesFeedingAux(ch.id);
      row.append(el('span', 'dim small', feeders.length ? feeders.map(b => b.name).join(', ') : '—'));
    }
    const outSel = document.createElement('select');
    outSel.title = ch.name + ' output';
    outSel.append(new Option('→ Master', 'master'));
    for (const b of S.buses) outSel.append(new Option('→ Bus: ' + b.name, b.id));
    outSel.value = ch.output || 'master';
    outSel.onchange = () => { ensureCtx().then(() => { ch.output = outSel.value; routeChannel(ch, ch.nodes, S.G); renderHeaders(); renderMixer(); renderIORouting(); saveSession(); }); };
    row.append(outSel);
    box.append(row);
  }
  if (!allChannels().length) box.append(el('div', 'dim small', 'No channels yet.'));
}

function makeInputSelect(ch) {
  const sel = document.createElement('select');
  sel.title = ch.name + ' recording input';
  sel.append(new Option('Session default', 'session'));
  sel.append(new Option('System default', 'default'));
  for (const d of S.io.inputs) sel.append(new Option(d.label || 'Mic', d.deviceId));
  sel.value = ch.input || 'session';
  return sel;
}

async function setOutputDevice(id) {
  S.io.outputId = id;
  if (S.ctx && S.ctx.setSinkId) {
    try { await S.ctx.setSinkId(id === 'default' ? '' : id); toast('Output switched.'); }
    catch (e) { toast('Could not switch output: ' + e.message); }
  }
  renderIO(); saveSession();
}

/* ---------------------------- new track dialog --------------------------- */
function openNewTrack() {
  const n = S.tracks.length + S.auxes.length + 1;
  $('nt-name').value = 'Audio ' + n;
  $('modal-newtrack').hidden = false;
  setTimeout(() => $('nt-name').select(), 50);
}
function closeNewTrack() { $('modal-newtrack').hidden = true; }

function createFromDialog() {
  const name = $('nt-name').value.trim().slice(0, 32) || 'Track';
  const type = document.querySelector('input[name=nt-type]:checked').value;
  const format = document.querySelector('input[name=nt-format]:checked').value;
  closeNewTrack();
  if (type === 'aux') addAuxTrack({ name, format });
  else addAudioTrack({ name, format });
  setView('arrange');
}

/* ------------------------------ view toggle ------------------------------ */
function setView(v) {
  S.view = v;
  $('view-arrange').classList.toggle('active', v === 'arrange');
  $('view-mixer').classList.toggle('active', v === 'mixer');
  $('view-master').classList.toggle('active', v === 'master');
  $('arrange-view').hidden = v !== 'arrange';
  $('mixer-view').hidden = v !== 'mixer';
  $('master-view').hidden = v !== 'master';
  if (v === 'mixer') renderMixer();
  else if (v === 'master') renderMastering();
  else { renderHeaders(); renderInspector(); drawTimeline(); }
}

/* --------------------------- mastering view UI --------------------------- */
function renderMastering() {
  const C = masterChain();
  // templates
  const tw = $('mast-templates'); tw.innerHTML = '';
  tw.append(el('span', 'mast-label', 'Start from:'));
  for (const [k, t] of Object.entries(MASTER_TEMPLATES)) {
    const b = el('button', 'abtn ghost', t.name);
    b.title = t.desc + ' — every knob stays tweakable after loading';
    b.onclick = () => applyMasterTemplate(k);
    tw.append(b);
  }
  // A/B
  const ab = $('btn-mast-bypass');
  ab.textContent = C.on ? 'A/B: Mastered' : 'A/B: Unmastered';
  ab.classList.toggle('on', C.on);
  ab.title = C.on ? 'Click to hear the unmastered mix (bypass the whole mastering chain)' : 'Click to hear the mastered mix';
  // chain stages left → right
  const cw = $('mast-chain'); cw.innerHTML = '';
  cw.append(mastEQStage(C), mastMBStage(C), mastImgStage(C), mastMaxStage(C));
  // dither
  const dw = $('mast-dither'); dw.innerHTML = '';
  const dlab = el('label', 'dither-row');
  const dcb = document.createElement('input');
  dcb.type = 'checkbox'; dcb.checked = !!C.dither.on;
  dcb.onchange = () => { C.dither.on = dcb.checked; saveSession(); };
  dlab.append(dcb, el('span', '', 'Dither on export'), el('span', 'dim small', ' — silky fade-outs, no digital grit at 16-bit'));
  dw.append(dlab);
}
function mastStageShell(title, P, note) {
  const box = el('div', 'mstage');
  const h = el('div', 'mstage-h');
  h.append(el('b', '', title), el('span', 'spacer'),
    bypassBtn(P, () => { ensureCtx().then(() => applyMastering()); }, title + ' bypass'));
  box.append(h);
  if (note) box.append(el('div', 'fxnote', note));
  return box;
}
function mastEQStage(C) {
  const E = C.meq;
  const box = mastStageShell('Mastering EQ', E, 'Final tone — gentle moves, the mix is already balanced.');
  const mk = (label, key, min, max, fmt) => sliderRow(label, min, max, key.includes('Q') ? 0.1 : key.includes('F') ? 1 : 0.5, E[key], fmt,
    (v) => { E[key] = v; ensureCtx().then(() => applyMastering()); saveSession(); }, label).row;
  box.append(mk('Low freq', 'lowF', 40, 800, fHz), mk('Low', 'lowG', -6, 6, fDb));
  box.append(mk('Mid 1 freq', 'pm1F', 120, 12000, fHz), mk('Mid 1 Q', 'pm1Q', 0.3, 8, v => 'Q ' + v.toFixed(1)), mk('Mid 1', 'pm1G', -6, 6, fDb));
  box.append(mk('Mid 2 freq', 'pm2F', 120, 12000, fHz), mk('Mid 2 Q', 'pm2Q', 0.3, 8, v => 'Q ' + v.toFixed(1)), mk('Mid 2', 'pm2G', -6, 6, fDb));
  box.append(mk('High freq', 'highF', 2000, 18000, fHz), mk('High (air)', 'highG', -6, 6, fDb));
  return box;
}
function mastMBStage(C) {
  const P = C.mb;
  const box = mastStageShell('Multiband', P, 'Compresses lows, mids and highs separately — glue without pumping.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Low/Mid', 80, 800, P.xlow, fHz, (v) => { P.xlow = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Low/mid crossover').el);
  kr.append(createKnob('Mid/High', 1000, 10000, P.xhigh, fHz, (v) => { P.xhigh = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Mid/high crossover').el);
  kr.append(createKnob('Ratio', 1, 6, P.ratio, v => v.toFixed(1) + ':1', (v) => { P.ratio = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Squeeze for all bands').el);
  box.append(kr);
  box.append(sliderRow('Low squeeze at', -30, 0, 1, P.lThr, v => v.toFixed(0) + ' dB', (v) => { P.lThr = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Low band threshold').row);
  box.append(sliderRow('Mid squeeze at', -30, 0, 1, P.mThr, v => v.toFixed(0) + ' dB', (v) => { P.mThr = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Mid band threshold').row);
  box.append(sliderRow('High squeeze at', -30, 0, 1, P.hThr, v => v.toFixed(0) + ' dB', (v) => { P.hThr = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'High band threshold').row);
  return box;
}
function mastImgStage(C) {
  const P = C.img;
  const box = mastStageShell('Stereo Image', P, 'Widens the finished mix — mono-safe.');
  box.append(createKnob('Width', 0, 2, P.width, v => v.toFixed(2) + '×', (v) => { P.width = v; ensureCtx().then(() => applyMastering()); saveSession(); }, '1 = untouched').el);
  return box;
}
function mastMaxStage(C) {
  const P = C.max;
  const box = mastStageShell('Maximizer', P, 'Final loudness — ceiling plus makeup gain.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Ceiling', -6, 0, P.threshold, v => v.toFixed(1) + ' dB', (v) => { P.threshold = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Nothing passes this').el);
  kr.append(createKnob('Loudness', 0, 6, P.makeup, v => '+' + v.toFixed(1) + ' dB', (v) => { P.makeup = v; ensureCtx().then(() => applyMastering()); saveSession(); }, 'Makeup gain into the ceiling').el);
  box.append(kr);
  return box;
}
// Big loudness meters: peak + RMS + LUFS-style integrated estimate.
function drawMasterMeters() {
  const cv = $('mast-meter');
  if (!cv || !cv.isConnected || !S.masterAnL) return;
  const buf = S._mastBuf || (S._mastBuf = new Float32Array(512));
  S.masterAnL.getFloatTimeDomainData(buf);
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; sum += buf[i] * buf[i]; }
  const rms = Math.sqrt(sum / buf.length);
  // LUFS-style integrated estimate: 3 s sliding window, absolute + relative gates
  S._loud = S._loud || { blocks: [], acc: 0 };
  S._loudTick = (S._loudTick || 0) + 1;
  if (S._loudTick % 12 === 0) {
    S._loud.blocks.push(sum / buf.length);
    if (S._loud.blocks.length > 36) S._loud.blocks.shift(); // ~3 s at 12 blocks/s… actually ~0.43s/block
    const gated = S._loud.blocks.filter(e => 10 * Math.log10(e + 1e-12) > -70);
    let lufs = -70;
    if (gated.length) {
      const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
      const rel = gated.filter(e => 10 * Math.log10(e + 1e-12) > (-0.691 + 10 * Math.log10(mean + 1e-12)) - 10);
      const m2 = rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : mean;
      lufs = -0.691 + 10 * Math.log10(m2 + 1e-12);
    }
    S._loud.val = lufs;
  }
  const x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
  const db = (v) => 20 * Math.log10(Math.max(1e-6, v));
  const bar = (frac, y, h, col) => {
    const w = Math.max(0, Math.min(1, frac)) * W;
    x.fillStyle = col; x.fillRect(0, y, w, h);
  };
  bar((db(peak) + 60) / 60, 8, 18, peak >= 1 ? '#ff5252' : '#35d07f');
  bar((db(rms) + 60) / 60, 34, 18, '#2f9dff');
  x.fillStyle = '#8b95a5'; x.font = '11px sans-serif'; x.textAlign = 'left';
  x.fillText('PEAK', 6, 22); x.fillText('RMS', 6, 48);
  const sp = $('mast-peak'), sr2 = $('mast-rms'), sl = $('mast-lufs');
  if (sp) sp.textContent = (peak >= 1 ? 'CLIP ' : '') + db(peak).toFixed(1) + ' dB';
  if (sr2) sr2.textContent = db(rms).toFixed(1) + ' dB';
  if (sl) sl.textContent = (S._loud.val !== undefined ? S._loud.val.toFixed(1) : '— —') + ' LUFS*';
}

/* ------------------------------ persistence ------------------------------ */
function serializeChannel(ch) {
  return {
    id: ch.id, kind: ch.kind, name: ch.name, format: ch.format,
    input: ch.input, output: ch.output, busId: ch.busId || null,
    params: JSON.parse(JSON.stringify(ch.params)),
    clips: (ch.clips || []).map(c => ({
      id: c.id, name: c.name, start: c.start, offset: c.offset,
      duration: c.duration, missing: !c.buffer,
      fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    })),
  };
}

function sessionData() {
  return {
    v: 3, bpm: S.bpm, timesig: S.timesig, masterVol: S.master.vol,
    masterParams: S.master.params || null,
    masterChain: S.masterChain || null,
    pxPerSec: S.pxPerSec,
    markers: (S.markers || []).map(m => ({ id: m.id, pos: m.pos, name: m.name })),
    io: { inputId: S.io.inputId, outputId: S.io.outputId, inputMode: S.io.inputMode, sessionRate: S.io.sessionRate },
    punch: S.punch, snap: S.snap, countIn: S.countIn,
    sessionName: S.sessionName || null,
    tracks: S.tracks.map(serializeChannel),
    auxes: S.auxes.map(serializeChannel),
    buses: S.buses.map(b => ({ id: b.id, name: b.name, format: b.format, output: b.output })),
    selId: S.selId,
  };
}

function saveSession() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sessionData()));
  } catch (e) {}
  persistClipBlobs(); // fire-and-forget: audio blobs -> IndexedDB
  scheduleFolderAutosave(); // debounced: .dahyo file -> device folder (if enabled)
}

function hydrateChannel(c) {
  const ch = {
    id: c.id, kind: c.kind, name: c.name, format: c.format || 'stereo',
    input: c.input || 'session', output: c.output || 'master',
    busId: c.busId || null,
    clips: (c.clips || []).map(cl => ({
      ...cl, buffer: null, peaks: null, missing: cl.missing !== false,
      fadeIn: cl.fadeIn || 0, fadeOut: cl.fadeOut || 0,
    })),
    recArmed: false, params: Object.assign(defaultParams(), c.params || {}),
    nodes: null,
  };
  // deep-merge fx params (in case of version drift)
  const dp = defaultParams();
  for (const k of FX_KEYS) ch.params[k] = Object.assign({}, dp[k], ch.params[k] || {});
  if (!ch.params.rack || !Array.isArray(ch.params.rack.modules)) ch.params.rack = { on: false, modules: [] };
  // migrate legacy 3-band EQ {low,mid,high} gains -> 4-band parametric
  const E = ch.params.eq;
  if (typeof E.low === 'number' || typeof E.mid === 'number' || typeof E.high === 'number') {
    ch.params.eq = Object.assign({}, dp.eq, {
      lowG: E.low || 0, pm1G: E.mid || 0, highG: E.high || 0,
    });
  }
  return ch;
}

function applySessionData(data) {
  S.bpm = data.bpm || 140; S.timesig = data.timesig || 4;
  S.master.vol = data.masterVol !== undefined ? data.masterVol : 0.9;
  S.pxPerSec = Math.min(800, Math.max(10, data.pxPerSec || 90));
  S.markers = Array.isArray(data.markers)
    ? data.markers.filter(m => m && typeof m.pos === 'number').map(m => ({
        id: m.id || uid('mk'), pos: Math.max(0, m.pos), name: String(m.name || 'Marker').slice(0, 24),
      }))
    : [];
  S.sessionName = data.sessionName || null;
  if (data.io) {
    S.io.inputId = data.io.inputId || 'default'; S.io.outputId = data.io.outputId || 'default';
    S.io.inputMode = data.io.inputMode || 'music'; S.io.sessionRate = data.io.sessionRate || 44100;
  }
  if (data.masterParams) S.master.params = data.masterParams;
  if (data.masterChain) S.masterChain = data.masterChain;
  if (data.punch) S.punch = data.punch;
  if (data.snap) S.snap = data.snap;
  if (typeof data.countIn === 'number') S.countIn = data.countIn;
  S.buses = (data.buses || []).map(b => ({ id: b.id, name: b.name, format: b.format || 'stereo', output: b.output || 'master', node: null }));
  S.tracks = (data.tracks || []).map(hydrateChannel);
  S.auxes = (data.auxes || []).map(hydrateChannel);
  S.selId = data.selId || (S.tracks[0] || S.auxes[0] || {}).id || null;
}

function loadSession() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return false; }
  if (!data || (data.v !== 2 && data.v !== 3)) return false;
  try { applySessionData(data); }
  catch (e) {
    console.warn('Corrupt autosave ignored:', e);
    return false;
  }
  return true;
}

/* ------------------------- named session manager ------------------------- */
function namedSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_MAP_KEY)) || {}; }
  catch (e) { return {}; }
}
function writeNamedSessions(map) {
  try { localStorage.setItem(SESSION_MAP_KEY, JSON.stringify(map)); } catch (e) {}
}

function allClipIdsOf(data) {
  const ids = [];
  for (const ch of [...(data.tracks || []), ...(data.auxes || [])])
    for (const c of ch.clips || []) ids.push(c.id);
  return ids;
}

// Delete IndexedDB blobs no longer referenced by the autosave or any named session.
async function gcClipBlobs() {
  let keep = new Set();
  try {
    const auto = JSON.parse(localStorage.getItem(STORE_KEY));
    if (auto) allClipIdsOf(auto).forEach(id => keep.add(id));
  } catch (e) {}
  const map = namedSessions();
  for (const k of Object.keys(map)) allClipIdsOf(map[k]).forEach(id => keep.add(id));
  const keys = await idb.allKeys();
  const orphaned = keys.filter(k => !keep.has(k));
  await idb.deleteClips(orphaned);
}

function saveNamedSession(name) {
  name = (name || '').trim().slice(0, 40);
  if (!name) return;
  S.sessionName = name; // set BEFORE snapshotting so the stored copy knows its name
  const map = namedSessions();
  map[name] = Object.assign(sessionData(), { savedAt: Date.now() });
  writeNamedSessions(map);
  saveSession(); // also refresh the autosave slot
  gcClipBlobs();
  renderSessions();
}

function deleteNamedSession(name) {
  const map = namedSessions();
  if (!map[name]) return;
  delete map[name];
  writeNamedSessions(map);
  if (S.sessionName === name) S.sessionName = null;
  saveSession();
  gcClipBlobs();
  renderSessions();
  toast('Session "' + name + '" deleted.');
}

function renameNamedSession(name) {
  const map = namedSessions();
  if (!map[name]) return;
  const nn = prompt('Rename session:', name);
  if (!nn) return;
  const clean = nn.trim().slice(0, 40);
  if (!clean || clean === name) return;
  if (map[clean] && !confirm('"' + clean + '" already exists — overwrite it?')) return;
  map[clean] = map[name];
  delete map[name];
  writeNamedSessions(map);
  if (S.sessionName === name) { S.sessionName = clean; saveSession(); }
  renderSessions();
}

// Tear down live channel nodes (for switching sessions while ctx exists).
function teardownChannels() {
  stopAllSources();
  if (S.recording) stopRecording(true);
  for (const ch of allChannels()) {
    if (ch.nodes) {
      try { ch.nodes.input.disconnect(); } catch (e) {}
      for (const k of ['tuneSlot', 'eqSlot', 'compSlot', 'delaySlot', 'verbSlot']) {
        try { ch.nodes[k].in.disconnect(); ch.nodes[k].out.disconnect(); } catch (e) {}
      }
    }
    ch.nodes = null;
  }
  for (const b of S.buses) { if (b.node) { try { b.node.disconnect(); } catch (e) {} } b.node = null; }
}

async function loadNamedSession(name) {
  const map = namedSessions();
  const data = map[name];
  if (!data) { toast('Session not found.'); return; }
  Undo.push('Load session');
  await activateSessionData(data, 'Loaded "' + name + '"');
}

function newEmptySession() {
  if (!confirm('Start a new empty session? Unsaved work in the current one stays in autosave only if you saved it as named.')) return;
  S.playing = false;
  teardownChannels();
  S.tracks = []; S.auxes = []; S.buses = [];
  S.selId = null; S.selClipId = null; S.markers = []; S.sessionName = null;
  S.bpm = 140; S.timesig = 4; S.playStartPos = 0; S.duration = 8; S.pxPerSec = 90;
  if (S.ctx) buildLiveGraph();
  $('bpm').value = S.bpm; $('timesig').value = String(S.timesig);
  updateDuration();
  renderHeaders(); renderMixer(); renderInspector(); renderIO(); renderSessions();
  drawTimeline();
  saveSession();
  closeSessions();
  toast('New empty session.');
}

function renderSessions() {
  const box = $('sess-list');
  if (!box) return;
  box.innerHTML = '';
  const map = namedSessions();
  const names = Object.keys(map).sort((a, b) => (map[b].savedAt || 0) - (map[a].savedAt || 0));
  const cur = el('div', 'dim small', S.sessionName
    ? 'Editing: "' + S.sessionName + '" — Save overwrites it.'
    : 'Editing an unsaved session — autosave keeps it in this browser until you name it.');
  box.append(cur);
  if (!names.length) {
    box.append(el('div', 'dim small', 'No named sessions yet. Name this one to keep it forever.'));
    return;
  }
  for (const name of names) {
    const row = el('div', 'io-dev' + (S.sessionName === name ? ' active' : ''));
    const g = el('span', 'grow', name);
    const d = map[name];
    const nClips = allClipIdsOf(d).length;
    g.title = name + ' — saved ' + (d.savedAt ? new Date(d.savedAt).toLocaleString() : 'unknown') +
      ' — ' + d.tracks.length + ' tracks, ' + nClips + ' clips';
    row.append(g);
    if (S.sessionName === name) row.append(el('span', 'badge', 'OPEN'));
    const load = el('button', 'abtn', 'Load');
    load.title = 'Load "' + name + '" (audio restores from this browser)';
    load.onclick = () => loadNamedSession(name);
    const ren = el('button', 'abtn ghost', 'Rename');
    ren.onclick = () => renameNamedSession(name);
    const del = el('button', 'abtn danger', '✕');
    del.title = 'Delete "' + name + '" and its audio';
    del.onclick = () => { if (confirm('Delete session "' + name + '"? Its audio is removed from this browser.')) deleteNamedSession(name); };
    row.append(load, ren, del);
    box.append(row);
  }
}

function openSessions() {
  $('modal-sessions').hidden = false;
  renderSessions();
  renderFolderRow();
}
function closeSessions() { $('modal-sessions').hidden = true; }

/* ============ .dahyo session files + device Sessions folder ==============
   A .dahyo file is a ZIP (stored entries, no compression) containing:
     manifest.json        { app:'dahyo', fileV:1, savedAt, session:<sessionData v2>, templates:[...] }
     audio/<clipId>.wav   one WAV per audio clip referenced by the session
   The same writer backs manual Export, folder auto-save, and Import.
   Everything is validated on import — corrupt files always produce a clear
   error, never a silent failure. */
const DAHYO_FILE_V = 1;

const CRC_TBL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TBL[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime() {
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())) & 0xFFFF;
  return { dosTime, dosDate };
}
// Minimal ZIP writer — stored (uncompressed) entries only. Pure function.
function zipStore(files) {
  const enc = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime();
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameU8 = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); // method 0 = stored
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameU8.length, true); lh.setUint16(28, 0, true);
    locals.push(lh.buffer, nameU8, data);
    central.push({ nameU8, crc, size: data.length, offset });
    offset += 30 + nameU8.length + data.length;
  }
  const cdStart = offset, cdParts = [];
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, c.crc, true); cd.setUint32(20, c.size, true); cd.setUint32(24, c.size, true);
    cd.setUint16(28, c.nameU8.length, true);
    cd.setUint32(42, c.offset, true);
    cdParts.push(cd.buffer, c.nameU8);
  }
  let cdSize = 0;
  for (const p of cdParts) cdSize += p.byteLength !== undefined ? p.byteLength : p.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true); end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, cdStart, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  const push = (x) => {
    const u = x instanceof ArrayBuffer ? new Uint8Array(x) : (x instanceof Uint8Array ? x : new Uint8Array(x));
    out.set(u, p); p += u.length;
  };
  locals.forEach(push); cdParts.forEach(push); push(end.buffer);
  return new Blob([out], { type: 'application/zip' });
}
// Minimal ZIP reader — parses local headers, verifies CRCs. Throws Error with a
// human-readable message for anything invalid. Deflate entries are decompressed
// via DecompressionStream when the browser supports it.
async function unzipStore(blob) {
  let buf;
  try { buf = new Uint8Array(await blob.arrayBuffer()); }
  catch (e) { throw new Error('Could not read the file.'); }
  if (buf.length < 4) throw new Error('Not a valid .dahyo file (too small).');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true);
  const entries = [];
  let p = 0;
  while (p + 30 <= buf.length) {
    const sig = u32(p);
    if (sig === 0x06054b50 || sig === 0x02014b50) break; // central dir / end — done
    if (sig !== 0x04034b50) throw new Error('Not a valid .dahyo file (bad data).');
    const method = u16(p + 8), csize = u32(p + 18);
    const nl = u16(p + 26), elen = u16(p + 28);
    const name = dec.decode(buf.subarray(p + 30, p + 30 + nl));
    const ds = p + 30 + nl + elen;
    if (ds + csize > buf.length) throw new Error('Corrupt .dahyo file (truncated data).');
    let data = buf.slice(ds, ds + csize);
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This .dahyo file uses compression this browser cannot read.');
      try {
        const raw = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        data = new Uint8Array(raw);
      } catch (e) { throw new Error('Corrupt .dahyo file (could not decompress "' + name + '").'); }
    } else if (method !== 0) {
      throw new Error('Unsupported .dahyo entry in "' + name + '".');
    }
    if (crc32(data) !== u32(p + 14)) throw new Error('Corrupt .dahyo file (checksum failed in "' + name + '").');
    entries.push({ name, data });
    p = ds + csize;
  }
  if (!entries.length) throw new Error('Not a valid .dahyo file (empty).');
  return entries;
}

function sanitizeFileName(n) {
  return ((n || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'session');
}
function userTemplatesRaw() {
  try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) { return []; }
}
function buildDahyoManifest() {
  return {
    app: 'dahyo', fileV: DAHYO_FILE_V, savedAt: Date.now(),
    session: sessionData(),
    templates: userTemplatesRaw(),
  };
}
// Returns null when valid, or a human-readable reason string when not.
function validateDahyoManifest(m) {
  if (!m || typeof m !== 'object') return 'the file is not a session file';
  if (m.app !== 'dahyo') return 'not a DAhYO session file';
  if (m.fileV !== DAHYO_FILE_V) return 'made by a newer DAhYO — update to open it';
  const s = m.session;
  if (!s || typeof s !== 'object' || s.v !== 2) return 'session data is missing or incompatible';
  if (!Array.isArray(s.tracks) || !Array.isArray(s.auxes)) return 'session tracks are missing';
  return null;
}
function findClipById(id) {
  for (const ch of allChannels()) for (const c of ch.clips || []) if (c.id === id) return c;
  return null;
}
// Gather WAV blobs for every clip id in the session (IndexedDB first,
// then in-memory encode as fallback). Missing audio is simply skipped —
// the manifest already marks those clips missing.
async function collectSessionAudio(data, onProgress) {
  const ids = allClipIdsOf(data);
  const out = [];
  let i = 0;
  for (const id of ids) {
    i++;
    if (onProgress) { try { onProgress(i, ids.length); } catch (e) {} }
    let rec = null;
    try { rec = await idb.getClip(id); } catch (e) {}
    if (!rec) {
      const clip = findClipById(id);
      if (clip && clip.buffer && !clip.missing) {
        try {
          const wav = encodeWAV(clip.buffer);
          await idb.putClip(id, wav, clip.name);
          rec = await idb.getClip(id);
        } catch (e) {}
      }
    }
    if (rec && rec.blob) out.push({ clipId: id, name: rec.name || id, blob: rec.blob });
  }
  return out;
}
// Build the complete .dahyo file bytes for the CURRENT session.
async function buildDahyoFile(onProgress) {
  const manifest = buildDahyoManifest();
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }];
  const audios = await collectSessionAudio(manifest.session, onProgress);
  for (const a of audios) {
    files.push({ name: 'audio/' + a.clipId + '.wav', data: new Uint8Array(await a.blob.arrayBuffer()) });
  }
  return { blob: zipStore(files), clipCount: audios.length, sessionName: manifest.session.sessionName };
}
function setFileStatus(msg, isErr) {
  const st = $('sess-file-status');
  if (!st) return;
  st.textContent = msg || '';
  st.classList.toggle('err', !!isErr);
}
// Manual export — downloads "<session>.dahyo".
async function exportSessionFile() {
  try {
    setFileStatus('Packing session…');
    const { blob, clipCount, sessionName } = await buildDahyoFile(
      (i, n) => setFileStatus('Packing audio ' + i + '/' + n + '…'));
    const fname = sanitizeFileName(sessionName || 'dahyo-session') + '.dahyo';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    setFileStatus('Exported ' + fname + ' (' + clipCount + ' audio clip' + (clipCount === 1 ? '' : 's') + ').');
  } catch (e) {
    setFileStatus('Export failed: ' + (e && e.message ? e.message : e), true);
  }
}
// Shared "open this session data" core: used by named-session load AND file import.
async function activateSessionData(data, doneMsg) {
  try {
    if (!data || typeof data !== 'object' || !Array.isArray(data.tracks))
      throw new Error('Session data is unreadable (missing tracks).');
    S.playing = false;
    if (S.recording) stopRecording(true);
    teardownChannels();
    S.tracks = []; S.auxes = []; S.buses = [];
    applySessionData(data);
    await ensureCtx();
    const n = await restoreClipAudio();
    $('bpm').value = S.bpm;
    $('timesig').value = String(S.timesig);
    S.selClipId = null;
    updateDuration();
    renderHeaders(); renderMixer(); renderInspector(); renderIO(); renderSessions();
    drawTimeline();
    saveSession(); // autosave slot now mirrors the opened session
    closeSessions();
    toast(doneMsg + (n ? ' — ' + n + ' audio clip' + (n === 1 ? '' : 's') + ' restored.' : '.'));
  } catch (e) {
    toast('Could not open that session (' + (e && e.message ? e.message : 'unknown error') + ') — your current work is untouched.');
  }
}
// Manual import — parses, validates, restores audio + templates, opens the session.
async function importSessionFile(file) {
  setFileStatus('Reading ' + file.name + '…');
  try {
    if (!/\.dahyo$/i.test(file.name || '')) throw new Error('Please choose a .dahyo session file.');
    const entries = await unzipStore(file);
    const manEntry = entries.find(e => e.name === 'manifest.json');
    if (!manEntry) throw new Error('Not a valid .dahyo file (manifest missing).');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(manEntry.data)); }
    catch (e) { throw new Error('Corrupt .dahyo file (manifest unreadable).'); }
    const prob = validateDahyoManifest(manifest);
    if (prob) throw new Error('Cannot open this file: ' + prob + '.');
    const data = manifest.session;
    let nAudio = 0;
    for (const e of entries) {
      const m = /^audio\/(.+)\.wav$/.exec(e.name);
      if (!m) continue;
      try {
        const ok = await idb.putClip(m[1], new Blob([e.data], { type: 'audio/wav' }), m[1]);
        if (ok) nAudio++;
      } catch (err) {}
    }
    // Merge templates additively — never clobber the user's existing chains.
    if (Array.isArray(manifest.templates) && manifest.templates.length) {
      const cur = userTemplatesRaw();
      const ids = new Set(cur.map(t => t && t.id));
      let added = 0;
      for (const t of manifest.templates) {
        if (t && t.id && t.name && t.params && !ids.has(t.id)) {
          cur.push({ id: t.id, name: String(t.name).slice(0, 40), params: t.params });
          ids.add(t.id); added++;
        }
      }
      if (added) saveUserTemplates(cur);
    }
    setFileStatus('Opening session…');
    Undo.push('Import session file');
    await activateSessionData(data, 'Imported "' + (data.sessionName || file.name) + '"');
    setFileStatus('Imported ' + file.name + ' (' + nAudio + ' audio file' + (nAudio === 1 ? '' : 's') + ').');
  } catch (e) {
    setFileStatus('Import failed: ' + (e && e.message ? e.message : e), true);
  }
}

/* ---------------- device Sessions folder (File System Access API) --------
   When the browser supports it, DAhYO auto-saves every session as a real
   .dahyo file inside a "DAhYO Sessions" folder the user picks — plus a
   vocal-chains.json for templates. Nothing is ever written without the
   user's explicit folder choice. Unsupported browsers keep everything in
   browser storage with one honest notice. */
const PREFS_DB = 'dahyo-prefs', PREFS_STORE = 'kv';
const folderPrefs = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') throw new Error('no-indexeddb');
        const req = indexedDB.open(PREFS_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(PREFS_STORE)) db.createObjectStore(PREFS_STORE, { keyPath: 'k' });
        };
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error || new Error('prefs-open-failed'));
      } catch (e) { reject(e); }
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        try {
          const tx = db.transaction(PREFS_STORE, 'readonly');
          const r = tx.objectStore(PREFS_STORE).get(k);
          r.onsuccess = () => res(r.result ? r.result.v : undefined);
          r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      });
    } catch (e) { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => {
        try {
          const tx = db.transaction(PREFS_STORE, 'readwrite');
          const r = tx.objectStore(PREFS_STORE).put({ k, v });
          r.onsuccess = () => res(); r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      });
      return true;
    } catch (e) { return false; }
  },
};
const Folder = {
  supported: (typeof window !== 'undefined') && !!window.showDirectoryPicker,
  dir: null,          // FileSystemDirectoryHandle for "DAhYO Sessions"
  mode: 'unknown',    // 'folder' | 'browser'
  status: '',
  askedThisLaunch: false,
};
function setFolderStatus(msg) {
  Folder.status = msg || '';
  renderFolderRow();
}
function renderFolderRow() {
  const row = $('sess-folder-row');
  if (!row) return;
  row.innerHTML = '';
  if (!Folder.supported) {
    row.append(el('div', '', 'Device folders aren\u2019t supported in this browser — sessions stay safe in this browser\u2019s storage on this device.'));
    return;
  }
  if (Folder.mode === 'folder' && Folder.dir) {
    row.append(el('span', '', 'Auto-saving .dahyo files to your DAhYO Sessions folder' + (Folder.status ? ' — ' + Folder.status : '.')));
    const ch = el('button', 'abtn ghost', 'Change folder');
    ch.title = 'Pick a different save folder';
    ch.onclick = () => chooseSessionsFolder(true);
    row.append(ch);
  } else if (Folder.mode === 'browser') {
    row.append(el('span', '', 'Sessions stay in this browser.'));
    const en = el('button', 'abtn ghost', 'Use a device folder');
    en.title = 'Auto-save sessions as files on this device';
    en.onclick = () => chooseSessionsFolder(true);
    row.append(en);
  } else {
    // permission lost / needs reconnect
    row.append(el('span', '', Folder.status || 'Sessions folder needs permission.'));
    const rc = el('button', 'abtn', 'Reconnect folder');
    rc.onclick = () => reconnectFolder();
    const off = el('button', 'abtn ghost', 'Use browser instead');
    off.onclick = async () => { await folderPrefs.set('folderMode', 'browser'); Folder.mode = 'browser'; setFolderStatus(''); };
    row.append(rc, off);
  }
}
// First-run friendly prompt. Called from a user gesture OR skipped if decided.
async function chooseSessionsFolder(fromButton) {
  if (!Folder.supported) return;
  try {
    const picked = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dahyo-sessions' });
    const sub = await picked.getDirectoryHandle('DAhYO Sessions', { create: true });
    await folderPrefs.set('folderHandle', sub);
    await folderPrefs.set('folderMode', 'folder');
    Folder.dir = sub; Folder.mode = 'folder';
    $('modal-folder').hidden = true;
    toast('DAhYO Sessions folder ready — sessions now auto-save as files.');
    setFolderStatus('connected');
    scheduleFolderAutosave();
  } catch (e) {
    // User cancelled the picker — respect it quietly.
    if (e && e.name === 'AbortError') { if (fromButton) setFolderStatus(''); return; }
    toast('Could not use that folder: ' + (e && e.message ? e.message : e));
  }
}
async function reconnectFolder() {
  try {
    const h = await folderPrefs.get('folderHandle');
    if (!h) throw new Error('no saved folder');
    const perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('permission denied');
    const sub = await h.getDirectoryHandle('DAhYO Sessions', { create: false }).catch(() => null);
    Folder.dir = sub || h;
    Folder.mode = 'folder';
    await folderPrefs.set('folderMode', 'folder');
    setFolderStatus('reconnected');
    toast('Sessions folder reconnected.');
    scheduleFolderAutosave();
  } catch (e) {
    setFolderStatus('Still no access — pick the folder again or use browser storage.');
    renderFolderRow();
  }
}
async function initFolderOnLaunch() {
  if (!Folder.supported) {
    Folder.mode = 'browser';
    // One honest notice per launch; the sessions modal row explains it persistently.
    setTimeout(() => toast('This browser can\u2019t use device folders — sessions stay in this browser.'), 1500);
    return;
  }
  const mode = await folderPrefs.get('folderMode');
  if (mode === 'browser') { Folder.mode = 'browser'; return; }
  const h = await folderPrefs.get('folderHandle');
  if (h) {
    try {
      const q = await h.queryPermission({ mode: 'readwrite' });
      if (q === 'granted') {
        const sub = await h.getDirectoryHandle('DAhYO Sessions', { create: false }).catch(() => null);
        Folder.dir = sub || h; Folder.mode = 'folder';
        setFolderStatus('connected');
        scheduleFolderAutosave();
        return;
      }
    } catch (e) {}
    // Handle saved but permission not granted — ask via the row, not a popup.
    Folder.mode = 'unknown';
    setFolderStatus('Saved folder found — permission needed to keep auto-saving.');
    return;
  }
  if (!Folder.askedThisLaunch && mode !== 'folder') {
    Folder.askedThisLaunch = true;
    $('modal-folder').hidden = false; // friendly first-run choice
  }
}
let _folderTimer = null;
function scheduleFolderAutosave() {
  if (!Folder.supported || Folder.mode !== 'folder' || !Folder.dir) return;
  clearTimeout(_folderTimer);
  _folderTimer = setTimeout(writeFolderAutosave, 2000);
}
async function writeFolderAutosave() {
  if (Folder.mode !== 'folder' || !Folder.dir) return;
  try {
    let perm = 'granted';
    try { perm = await Folder.dir.queryPermission({ mode: 'readwrite' }); } catch (e) {}
    if (perm !== 'granted') {
      try { perm = await Folder.dir.requestPermission({ mode: 'readwrite' }); } catch (e) { perm = 'denied'; }
    }
    if (perm !== 'granted') {
      Folder.mode = 'unknown';
      setFolderStatus('Folder permission was revoked.');
      toast('DAhYO lost access to the Sessions folder — reconnect it in Sessions.');
      return;
    }
    const { blob, sessionName } = await buildDahyoFile();
    const fname = sanitizeFileName(sessionName || 'autosave') + '.dahyo';
    const fh = await Folder.dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    // templates ride along as a small JSON file
    try {
      const th = await Folder.dir.getFileHandle('vocal-chains.json', { create: true });
      const tw = await th.createWritable();
      await tw.write(JSON.stringify({ app: 'dahyo', templates: userTemplatesRaw(), savedAt: Date.now() }, null, 1));
      await tw.close();
    } catch (e) {}
    const t = new Date();
    setFolderStatus('saved ' + fname + ' at ' + t.toLocaleTimeString());
  } catch (e) {
    setFolderStatus('auto-save failed: ' + (e && e.message ? e.message : e));
  }
}

/* -------------------------------- demo ----------------------------------- */
async function addDemo() {
  await ensureCtx();
  const sr = S.ctx.sampleRate, beat = 60 / S.bpm, dur = beat * 16;
  const buf = S.ctx.createBuffer(2, Math.ceil(dur * sr), sr);
  for (let chn = 0; chn < 2; chn++) {
    const d = buf.getChannelData(chn);
    const kick = (t) => {
      const n0 = Math.floor(t * sr);
      for (let i = 0; i < sr * 0.35 && n0 + i < d.length; i++) {
        const tt = i / sr, f = 45 + 120 * Math.exp(-tt * 30);
        d[n0 + i] += Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 9) * 0.9;
      }
    };
    const hat = (t, open) => {
      const n0 = Math.floor(t * sr), len = Math.floor(sr * (open ? 0.18 : 0.05));
      for (let i = 0; i < len && n0 + i < d.length; i++) {
        d[n0 + i] += (Math.random() * 2 - 1) * Math.exp(-i / len * 6) * 0.25;
      }
    };
    const bass = (t, f, len) => {
      const n0 = Math.floor(t * sr);
      for (let i = 0; i < sr * len && n0 + i < d.length; i++) {
        const tt = i / sr;
        d[n0 + i] += Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 2.2) * 0.55;
      }
    };
    for (let bar = 0; bar < 4; bar++) {
      const bt = bar * beat * 4;
      for (let b = 0; b < 4; b++) kick(bt + b * beat);
      for (let h = 0; h < 8; h++) hat(bt + h * beat / 2, h % 4 === 2);
      const roots = [55, 55, 65.41, 49];
      bass(bt, roots[bar], beat * 3.4);
    }
  }
  const tr = addAudioTrack({ name: 'Demo Beat', format: 'stereo' });
  const clip = { id: uid('clip'), name: 'demo-groove', buffer: buf, start: 0, offset: 0, duration: dur, peaks: computePeaks(buf), fadeIn: 0, fadeOut: 0 };
  tr.clips.push(clip);
  // persist the generated groove as WAV so the demo session reloads too
  try { idb.putClip(clip.id, encodeWAV(buf), clip.name).then(ok => { if (ok) clip._blobSaved = true; }); } catch (e) {}
  updateDuration(); drawTimeline(); renderHeaders();
  toast('Demo beat added — hit play (Space).');
}

/* ------------------------------ main loop -------------------------------- */
function tick() {
  requestAnimationFrame(tick);
  try {
    $('time-display').textContent = fmtTime(curPos());
    if (S.view === 'arrange') {
      drawTimeline();
      // keep the playhead on screen while rolling
      if (S.playing) {
        const wrap = $('timeline-wrap');
        const px = curPos() * S.pxPerSec;
        if (px < wrap.scrollLeft || px > wrap.scrollLeft + wrap.clientWidth - 60)
          wrap.scrollLeft = Math.max(0, px - 100);
      }
      const ch = getChannel(S.selId);
      if (ch) { drawTuneNeedle(ch); drawCompGR(ch); }
    } else if (S.view === 'mixer') {
      drawMeters();
    } else if (S.view === 'master') {
      drawMasterMeters();
    }
  } catch (e) { /* render loop never kills the app */ }
}

/* ------------------------- AI Engineer (voice commands) --------------------
   Hands-free mode for self-recording: while ON, the mic feeds ONLY the Web
   Speech API (Chrome/Edge) for commands — it never records audio. The heard
   command + what it did are shown every time. */
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice commands need Chrome or Edge — this browser has no speech recognition.'); return; }
  if (S.voice.on) { stopVoice(); return; }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) continue;
      const text = (r[0].transcript || '').trim();
      if (text) handleVoiceCommand(text);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopVoice(); toast('Mic blocked — allow microphone access for voice commands.');
    }
  };
  rec.onend = () => {
    if (S.voice.on) {
      clearTimeout(S.voice.restartTimer);
      S.voice.restartTimer = setTimeout(() => { try { S.voice.rec.start(); } catch (e) {} }, 350);
    }
  };
  S.voice.rec = rec; S.voice.on = true;
  try { rec.start(); }
  catch (e) { stopVoice(); toast('Could not start voice recognition.'); return; }
  $('btn-voice').classList.add('on');
  const vh = $('voice-heard');
  if (vh) { vh.hidden = false; vh.textContent = '🎙 Listening — mic is only used for commands while this is on.'; }
  toast('🎙 AI Engineer listening — say "record", "play", "punch in"…');
}
function stopVoice() {
  S.voice.on = false;
  clearTimeout(S.voice.restartTimer);
  try { if (S.voice.rec) S.voice.rec.stop(); } catch (e) {}
  S.voice.rec = null;
  const b = $('btn-voice'); if (b) b.classList.remove('on');
  const vh = $('voice-heard'); if (vh) vh.hidden = true;
}
function voiceHeard(text, did) {
  S.voice.last = text;
  const vh = $('voice-heard');
  if (vh) vh.textContent = '🎙 "' + text + '" → ' + did;
  toast('🎙 "' + text + '" → ' + did);
}
function setLoop(v) {
  S.loop = !!v;
  const b = $('btn-loop'); if (b) b.classList.toggle('on', S.loop);
  status(S.loop ? 'Loop on — whole project repeats.' : 'Loop off.');
  saveSession();
}
function selectTrack(d) {
  const chs = allChannels();
  if (!chs.length) return;
  let i = chs.findIndex(c => c.id === S.selId);
  i = i < 0 ? 0 : (i + d + chs.length) % chs.length;
  S.selId = chs[i].id; S.selClipId = null;
  renderHeaders(); renderMixer(); renderInspector();
}
function deleteLastTake() {
  if (S.recording) { stopRecording(true); return 'take discarded'; }
  const tr = S.recTrack || S.tracks.find(t => t.kind === 'audio');
  if (!tr || !tr.clips.length) return 'no take to delete';
  Undo.push('Delete take');
  tr.clips.pop();
  updateDuration(); drawTimeline(); renderHeaders(); saveSession();
  return 'last take deleted';
}
function handleVoiceCommand(raw) {
  const t = ' ' + raw.toLowerCase().replace(/[.,!?]/g, '').trim() + ' ';
  const has = (...ws) => ws.some(w => t.includes(' ' + w + ' '));
  if (has('take it from the top')) { ensureCtx().then(() => { backToStart(); play(0); }); return voiceHeard(raw, 'playing from the top'); }
  if (has('punch in')) { punchInNow(); return voiceHeard(raw, 'punching in'); }
  if (has('punch out')) { punchOutNow(); return voiceHeard(raw, 'punched out — take kept'); }
  if (has('start recording') || has('start record') || has('record')) {
    if (!S.recording) toggleRecord(); return voiceHeard(raw, 'recording');
  }
  if (has('delete take')) return voiceHeard(raw, deleteLastTake());
  if (has('keep take')) { if (S.recording) stopRecording(false); return voiceHeard(raw, 'take kept'); }
  if (has('loop on')) { setLoop(true); return voiceHeard(raw, 'loop on'); }
  if (has('loop off')) { setLoop(false); return voiceHeard(raw, 'loop off'); }
  if (has('metronome on')) { ensureCtx().then(() => setMetro(true)); return voiceHeard(raw, 'metronome on'); }
  if (has('metronome off')) { ensureCtx().then(() => setMetro(false)); return voiceHeard(raw, 'metronome off'); }
  if (has('count in') || has('countin')) {
    S.countIn = 1; setCountInUI(); saveSession();
    return voiceHeard(raw, 'count-in on (1 bar)');
  }
  if (has('next track')) { selectTrack(1); return voiceHeard(raw, 'next track'); }
  if (has('previous track')) { selectTrack(-1); return voiceHeard(raw, 'previous track'); }
  if (has('go back')) { backToStart(); return voiceHeard(raw, 'back to start'); }
  if (has('undo')) { doUndo(); return voiceHeard(raw, 'undone'); }
  if (t.trim() === 'stop' || has('stop')) { stop(); return voiceHeard(raw, 'stopped'); }
  if (has('pause')) { stop(); return voiceHeard(raw, 'paused'); }
  if (has('play')) { ensureCtx().then(() => play()); return voiceHeard(raw, 'playing'); }
  return voiceHeard(raw, 'didn\u2019t catch that — try "play", "record", "punch in"');
}

/* ------------------------- movable transport ------------------------------
   Docks at the top by default; undock to a floating draggable window. */
function loadTransportPos() {
  try { return JSON.parse(localStorage.getItem('dahyo.transport.pos') || 'null') || { x: window.innerWidth - 420, y: 64 }; }
  catch (e) { return { x: 200, y: 64 }; }
}
function setTransportDocked(docked) {
  const tp = $('transport');
  tp.classList.toggle('undocked', !docked);
  if (docked) { tp.style.left = ''; tp.style.top = ''; }
  else {
    const pos = loadTransportPos();
    tp.style.left = Math.max(0, pos.x) + 'px'; tp.style.top = Math.max(0, pos.y) + 'px';
  }
  const b = $('btn-undock');
  b.textContent = docked ? '⧉' : '📌';
  b.title = docked ? 'Undock transport — floating draggable window' : 'Dock transport back to the top';
  try { localStorage.setItem('dahyo.transport', JSON.stringify({ undocked: !docked })); } catch (e) {}
}
function initTransportDrag() {
  const tp = $('transport'), grip = $('transport-grip');
  if (!tp || !grip) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    if (!tp.classList.contains('undocked')) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = tp.getBoundingClientRect(); ox = r.left; oy = r.top;
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tp.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
    tp.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
  });
  const end = () => {
    if (!dragging) return; dragging = false;
    try { localStorage.setItem('dahyo.transport.pos', JSON.stringify({ x: parseInt(tp.style.left) || 0, y: parseInt(tp.style.top) || 0 })); } catch (e) {}
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}
function setCountInUI() {
  const b = $('btn-countin');
  if (!b) return;
  b.classList.toggle('on', S.countIn > 0);
  b.textContent = S.countIn === 0 ? '1-2-3' : '⏳' + S.countIn;
  b.title = S.countIn === 0 ? 'Count-in off — click for 1 bar' : 'Count-in: ' + S.countIn + ' bar' + (S.countIn > 1 ? 's' : '') + ' — click to change';
}

/* ------------------------- artist profile selector ----------------------- */
function learnedUses(a) {
  let n = 0;
  for (const k of Object.keys(a.learn || {})) for (const p of Object.keys(a.learn[k])) n += (a.learn[k][p] || {}).n || 0;
  return n;
}
function renderArtistSel() {
  const wrap = $('artist-sel-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const sel = document.createElement('select');
  sel.id = 'artist-sel';
  sel.title = 'Artist profile — Auto learns how each artist likes things and gets smarter over time';
  for (const a of S.artists) sel.append(new Option(a.name, a.id));
  sel.value = S.artistId;
  sel.onchange = () => {
    S.artistId = sel.value; saveArtists(); renderArtistSel();
    const a = currentArtist();
    const n = learnedUses(a);
    toast('👤 ' + a.name + (n ? ' — Auto tuned by ' + n + ' past tweaks.' : ' — Auto starts learning their taste.'));
  };
  const add = el('button', 'abtn ghost tiny', '+');
  add.title = 'Add an artist profile';
  add.onclick = () => {
    const name = prompt('Artist name:', '');
    if (!name || !name.trim()) return;
    const a = { id: 'a-' + Date.now().toString(36), name: name.trim().slice(0, 24), learn: {}, audio: { n: 0, peakDb: -12, rmsDb: -24 } };
    S.artists.push(a); S.artistId = a.id; saveArtists(); renderArtistSel();
    toast('👤 ' + a.name + ' — Auto starts learning their taste.');
  };
  const lab = el('span', 'dim small', '👤');
  lab.title = 'Artist profile — Auto learns per artist';
  wrap.append(lab, sel, add);
}

/* --------------------------------- init ---------------------------------- */
function updatePunchUI() {
  const b = $('btn-punch');
  if (b) b.classList.toggle('on', S.punch.on);
  const t = $('punch-times');
  if (t) t.textContent = S.punch.on ? ('in ' + S.punch.in.toFixed(1) + 's → out ' + S.punch.out.toFixed(1) + 's') : '';
}

function init() {
  const had = loadSession();
  loadArtists(); renderArtistSel();
  $('bpm').value = S.bpm;
  $('timesig').value = String(S.timesig);
  initTimeline();
  renderHeaders(); renderMixer(); renderInspector(); updateDuration();

  $('btn-play').onclick = () => ensureCtx().then(togglePlay);
  $('btn-stop').onclick = () => ensureCtx().then(stop);
  $('btn-rw').onclick = () => ensureCtx().then(backToStart);
  $('btn-rec').onclick = () => toggleRecord();
  $('btn-undo').onclick = () => doUndo();
  $('btn-redo').onclick = () => doRedo();
  $('btn-mark').onclick = () => addMarker();
  $('zoom-in').onclick = () => zoomIn();
  $('zoom-out').onclick = () => zoomOut();
  $('zoom-fit').onclick = () => zoomFit();
  $('btn-loop').onclick = () => {
    S.loop = !S.loop;
    $('btn-loop').classList.toggle('on', S.loop);
    status(S.loop ? 'Loop on — whole project repeats.' : 'Loop off.');
  };
  $('btn-metro').onclick = () => ensureCtx().then(() => setMetro(!S.metro));
  $('bpm').onchange = (e) => { S.bpm = Math.min(240, Math.max(40, parseInt(e.target.value) || 140)); e.target.value = S.bpm; saveSession(); };
  $('timesig').onchange = (e) => { S.timesig = parseInt(e.target.value); saveSession(); };

  $('view-arrange').onclick = () => setView('arrange');
  $('view-mixer').onclick = () => setView('mixer');
  $('view-master').onclick = () => setView('master');

  // transport extras: count-in, voice AI engineer, undock
  $('btn-countin').onclick = () => {
    S.countIn = S.countIn >= 2 ? 0 : S.countIn + 1;
    setCountInUI(); saveSession();
    toast(S.countIn === 0 ? 'Count-in off.' : 'Count-in: ' + S.countIn + ' bar' + (S.countIn > 1 ? 's' : '') + ' before recording.');
  };
  $('btn-voice').onclick = () => toggleVoice();
  $('btn-undock').onclick = () => setTransportDocked($('transport').classList.contains('undocked'));
  initTransportDrag();
  try {
    const docked = JSON.parse(localStorage.getItem('dahyo.transport') || 'null');
    if (docked && docked.undocked) setTransportDocked(false);
  } catch (e) {}
  setCountInUI();

  // edit toolbar: snap + punch
  $('btn-snap').onclick = () => { S.snap.on = !S.snap.on; setSnapUI(); saveSession(); status(S.snap.on ? 'Snap on — clips snap to ' + S.snap.div + 's.' : 'Snap off — clips move freely.'); };
  $('snap-div').onchange = (e) => { S.snap.div = e.target.value; setSnapUI(); saveSession(); };
  $('btn-punch').onclick = () => {
    S.punch.on = !S.punch.on;
    if (S.punch.on && S.punch.out <= S.punch.in) S.punch.out = S.punch.in + 4;
    updatePunchUI(); saveSession();
    toast(S.punch.on ? '🥊 Punch on — takes keep only ' + S.punch.in.toFixed(1) + 's → ' + S.punch.out.toFixed(1) + 's.' : 'Punch off — full takes.');
  };
  $('punch-setin').onclick = () => { S.punch.in = curPos(); if (S.punch.out <= S.punch.in) S.punch.out = S.punch.in + 4; S.punch.on = true; updatePunchUI(); saveSession(); toast('Punch in at ' + S.punch.in.toFixed(1) + 's.'); };
  $('punch-setout').onclick = () => { S.punch.out = curPos(); if (S.punch.out <= S.punch.in) S.punch.in = Math.max(0, S.punch.out - 4); S.punch.on = true; updatePunchUI(); saveSession(); toast('Punch out at ' + S.punch.out.toFixed(1) + 's.'); };
  setSnapUI(); updatePunchUI();

  // analyze modal (BPM/key finder)
  $('an-use').onclick = () => {
    const a = S._lastAnalysis;
    if (a && a.tempo.bpm) {
      Undo.push('Apply detected tempo');
      S.bpm = Math.round(a.tempo.bpm); $('bpm').value = S.bpm;
      if (a.key && a.key.key !== undefined) {
        for (const ch of allChannels()) { if (ch.params.tune) { ch.params.tune.key = a.key.key; ch.params.tune.scale = a.key.scale; } }
        toast('Tempo ' + S.bpm + ' BPM + key ' + a.key.name + ' applied — Tune plugins follow the key.');
      } else toast('Project tempo set to ' + S.bpm + ' BPM.');
      saveSession();
    }
    closeModal('modal-analyze');
  };
  $('an-dismiss').onclick = () => closeModal('modal-analyze');
  $('modal-analyze').addEventListener('click', (e) => { if (e.target.id === 'modal-analyze') closeModal('modal-analyze'); });

  // plugin library
  $('plugin-search').addEventListener('input', renderPluginBrowser);
  $('plugins-close').onclick = () => closeModal('modal-plugins');
  $('modal-plugins').addEventListener('click', (e) => { if (e.target.id === 'modal-plugins') closeModal('modal-plugins'); });

  // vocal rack
  $('rack-close').onclick = () => closeModal('modal-rack');
  $('modal-rack').addEventListener('click', (e) => { if (e.target.id === 'modal-rack') closeModal('modal-rack'); });
  $('rack-preset').onchange = (e) => { const ch = getChannel(S._rackCh); if (ch && e.target.value) loadRackPreset(ch, e.target.value); e.target.value = ''; };
  const radd = $('rack-add-sel');
  for (const [k, t] of Object.entries(RACK_TYPES)) radd.append(new Option(t.name + ' — ' + t.desc, k));
  $('rack-add').onclick = () => {
    const ch = getChannel(S._rackCh);
    if (!ch || !radd.value) return;
    Undo.push('Add rack module');
    ch.params.rack.on = true;
    const mod = { id: uid('rm'), type: radd.value, on: true, params: rackModuleDefaults(radd.value) };
    ch.params.rack.modules.push(mod);
    ensureCtx().then(() => { rebuildRackChain(ch, S.gateOK); applyChannelParams(ch); });
    // auto-first for rack modules too
    autoFX(ch, 'rack:' + mod.type, mod.params, () => { applyRackModuleLive(ch, mod); saveSession(); renderRack(); renderInspector(); }, true);
    saveSession(); renderRack();
  };

  // mastering view
  $('btn-mast-bypass').onclick = () => {
    const C = masterChain();
    Undo.push(C.on ? 'Bypass mastering' : 'Engage mastering');
    C.on = !C.on;
    ensureCtx().then(() => applyMastering());
    saveSession(); renderMastering();
    toast(C.on ? 'Mastered ✓' : 'Unmastered — raw mix (A/B).');
  };
  $('btn-exp-mastered').onclick = () => ensureCtx().then(() => exportWAV({ mastered: true, bits: 16 }));
  $('btn-exp-premaster').onclick = () => ensureCtx().then(() => exportWAV({ mastered: false, bits: 16 }));

  // export modal
  $('exp-cancel').onclick = () => closeModal('modal-export');
  $('modal-export').addEventListener('click', (e) => { if (e.target.id === 'modal-export') closeModal('modal-export'); });
  $('exp-go').onclick = () => {
    closeModal('modal-export');
    ensureCtx().then(() => exportWAV({
      mastered: $('exp-version').value === 'mastered',
      bits: parseInt($('exp-bits').value),
      sr: parseInt($('exp-rate').value),
    }));
  };

  $('btn-addtrack').onclick = openNewTrack;
  $('nt-cancel').onclick = closeNewTrack;
  $('nt-create').onclick = createFromDialog;
  $('modal-newtrack').addEventListener('click', (e) => { if (e.target.id === 'modal-newtrack') closeNewTrack(); });

  $('btn-demo').onclick = addDemo;
  $('btn-io').onclick = openIO;
  $('io-close').onclick = closeIO;
  $('modal-io').addEventListener('click', (e) => { if (e.target.id === 'modal-io') closeIO(); });
  $('bus-add-btn').onclick = () => {
    const name = $('bus-name').value.trim().slice(0, 24) || ('Bus ' + (S.buses.length + 1));
    Undo.push('Add bus');
    addBus({ name, format: $('bus-format').value });
    $('bus-name').value = '';
    toast('Bus "' + name + '" created.');
  };

  $('btn-sessions').onclick = openSessions;
  $('btn-help').onclick = () => { $('modal-help').hidden = false; };
  $('help-close').onclick = () => { $('modal-help').hidden = true; };
  $('modal-help').addEventListener('click', (e) => { if (e.target.id === 'modal-help') $('modal-help').hidden = true; });
  $('sess-close').onclick = closeSessions;
  $('modal-sessions').addEventListener('click', (e) => { if (e.target.id === 'modal-sessions') closeSessions(); });
  $('sess-save').onclick = quickSave;
  $('sess-saveas').onclick = () => {
    const name = prompt('Name this session:', S.sessionName ? S.sessionName + ' copy' : 'My Session');
    if (name && name.trim()) { saveNamedSession(name); toast('Session "' + name.trim().slice(0, 40) + '" saved — audio included.'); }
  };
  $('sess-new').onclick = () => { Undo.push('New session'); newEmptySession(); };
  $('sess-export').onclick = exportSessionFile;
  $('sess-import').onclick = () => $('dahyo-file-input').click();
  $('dahyo-file-input').onchange = (e) => {
    if (e.target.files && e.target.files[0]) importSessionFile(e.target.files[0]);
    e.target.value = '';
  };
  // drag-and-drop .dahyo files onto the sessions modal
  const sessModal = $('modal-sessions');
  sessModal.addEventListener('dragover', (e) => { e.preventDefault(); });
  sessModal.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importSessionFile(f);
  });
  $('folder-choose').onclick = () => chooseSessionsFolder(true);
  $('folder-browser').onclick = async () => {
    await folderPrefs.set('folderMode', 'browser');
    Folder.mode = 'browser';
    $('modal-folder').hidden = true;
    renderFolderRow();
    toast('Sessions will stay in this browser. You can still export .dahyo files anytime.');
  };
  $('btn-export').onclick = () => ensureCtx().then(openExport);
  $('file-input').onchange = (e) => {
    const target = getChannel(S._importTarget) || getChannel(S.selId);
    S._importTarget = null;
    importFiles(e.target.files, target && target.kind === 'audio' ? target : null);
    e.target.value = '';
  };

  /* ------------------------- Pro Tools-style shortcuts -----------------------
     Space = play/stop · Enter = play from start · Ctrl/Cmd+S = save ·
     Ctrl/Cmd+Z / Shift+Z = undo/redo · R = arm selected · M = mute selected ·
     S = solo selected · ←/→ = nudge playhead or selected clip · ↑/↓ = track
     selection · L = loop. Plain letters are ignored while typing in a field
     or while a modal is open. */
  function selectedChannel() { return getChannel(S.selId); }
  function quickSave() {
    if (S.sessionName) { saveNamedSession(S.sessionName); toast('Session "' + S.sessionName + '" saved — audio included.'); }
    else {
      const name = prompt('Name this session:', 'My Session');
      if (name && name.trim()) { saveNamedSession(name.trim().slice(0, 40)); toast('Session "' + name.trim() + '" saved — audio included.'); }
    }
  }
  function toggleArmSelected() {
    const ch = selectedChannel();
    if (!ch || ch.kind !== 'audio') { toast('Select an audio track first, then R arms it.'); return; }
    Undo.push(ch.recArmed ? 'Disarm track' : 'Arm track');
    ch.recArmed = !ch.recArmed;
    renderHeaders(); saveSession();
    toast(ch.recArmed ? '● "' + ch.name + '" armed — hit the record button to roll.' : '"' + ch.name + '" disarmed.');
  }
  function toggleMuteSelected() {
    const ch = selectedChannel();
    if (!ch) { toast('No track selected.'); return; }
    Undo.push(ch.params.muted ? 'Unmute track' : 'Mute track');
    ensureCtx().then(() => { ch.params.muted = !ch.params.muted; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); });
  }
  function toggleSoloSelected() {
    const ch = selectedChannel();
    if (!ch) { toast('No track selected.'); return; }
    Undo.push(ch.params.solo ? 'Unsolo track' : 'Solo track');
    ensureCtx().then(() => { ch.params.solo = !ch.params.solo; refreshMutes(); renderHeaders(); renderMixer(); saveSession(); });
  }
  function nudgeClipOrPlayhead(dir, big) {
    const sel = selectedClip();
    if (sel) {
      Undo.push('Nudge clip');
      sel.clip.start = Math.max(0, sel.clip.start + dir * (big ? 1 : 0.1));
      updateDuration(); drawTimeline(); saveSession();
      return;
    }
    const spb = 60 / S.bpm, step = big ? spb * S.timesig : spb;
    const was = S.playing;
    if (was) stop();
    S.playStartPos = Math.max(0, Math.min(S.duration, S.playStartPos + dir * step));
    if (was) play(S.playStartPos); else drawTimeline();
  }
  function selectAdjacent(d) {
    const all = allChannels();
    if (!all.length) { toast('No tracks yet — hit ＋ Track.'); return; }
    let i = all.findIndex(c => c.id === S.selId);
    i = i < 0 ? 0 : Math.min(all.length - 1, Math.max(0, i + d));
    S.selId = all[i].id; S.selClipId = null;
    renderHeaders(); renderMixer(); renderInspector(); drawTimeline();
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    const modalOpen = !$('modal-newtrack').hidden || !$('modal-io').hidden || !$('modal-sessions').hidden || !$('modal-help').hidden;
    const mod = e.ctrlKey || e.metaKey;
    // mod-key combos always work (even in fields / modals)
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && e.code === 'KeyS') { e.preventDefault(); quickSave(); return; }
    if (mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) { e.preventDefault(); zoomIn(); return; }
    if (mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) { e.preventDefault(); zoomOut(); return; }
    if (mod && e.code === 'Digit0') { e.preventDefault(); zoomFit(); return; }
    if (modalOpen) {
      if (e.code === 'Escape') { closeNewTrack(); closeIO(); closeSessions(); $('modal-help').hidden = true; }
      return;
    }
    if (inField) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        ensureCtx().then(togglePlay);
        break;
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        ensureCtx().then(() => { if (S.playing) stop(); S.playStartPos = 0; play(0); });
        break;
      case 'KeyR': toggleArmSelected(); break;
      case 'KeyM': toggleMuteSelected(); break;
      case 'KeyS': toggleSoloSelected(); break;
      case 'KeyL': $('btn-loop').click(); break;
      case 'ArrowLeft':
        e.preventDefault();
        nudgeClipOrPlayhead(-1, e.shiftKey);
        break;
      case 'ArrowRight':
        e.preventDefault();
        nudgeClipOrPlayhead(1, e.shiftKey);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectAdjacent(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        selectAdjacent(1);
        break;
    }
  });

  // audio unlock on first gesture (mobile browsers)
  const unlock = () => { ensureCtx().catch(() => {}); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);

  // global safety net — every failure gets a human message, never a white screen
  window.addEventListener('error', (e) => {
    try { toast('Something hiccuped (' + (e.message || 'unknown error') + ') — your session is autosaved, keep working.'); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { toast('Something hiccuped (' + ((e.reason && e.reason.message) || 'async error') + ') — your session is autosaved, keep working.'); } catch (_) {}
  });
  // reload mid-session shouldn't lose anything: autosave covers back/forward
  window.addEventListener('beforeunload', () => { try { saveSession(); } catch (e) {} });

  setView('arrange');
  syncUndoButtons();
  requestAnimationFrame(tick);
  requestAnimationFrame(() => { try { drawTimeline(); } catch (e) {} }); // paint the grid on load
  initFolderOnLaunch(); // device Sessions folder (or honest fallback notice)
  if (had) {
    status('Session restored — bringing back audio…');
    // decode persisted audio in the background; the suspended context decodes fine
    ensureCtx()
      .then(() => restoreClipAudio())
      .then(n => {
        updateDuration(); drawTimeline(); renderHeaders();
        status(n
          ? 'Session restored — ' + n + ' audio clip' + (n > 1 ? 's' : '') + ' recovered from this browser.'
          : 'Session restored — settings back. Clips marked "re-import audio" were never saved with audio in this browser.');
      })
      .catch(() => { status('Session restored — settings back. Audio restore unavailable.'); });
  }
  else status('Welcome to DAhYO — free forever. Hit ＋ Track to start, or drop in a beat.');
}

document.addEventListener('DOMContentLoaded', init);
