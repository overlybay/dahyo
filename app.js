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
  ctx: null, tuneOK: false,
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
  io: { inputs: [], outputs: [], inputId: 'default', outputId: 'default' },
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

function defaultParams() {
  return {
    vol: 0.8, pan: 0, muted: false, solo: false,
    sendALvl: 0, sendADest: null, sendBLvl: 0, sendBDest: null,
    tune:  { on: false, speed: 0.65, key: 0, scale: 'major' },
    eq:    { on: true,  low: 0, mid: 0, high: 0 },
    comp:  { on: false, threshold: -18, ratio: 3 },
    delay: { on: false, time: 0.32, feedback: 0.35, mix: 0.25 },
    verb:  { on: false, mix: 0.3, size: 1.0 },
  };
}

/* --------------------------- audio context ------------------------------ */
async function ensureCtx() {
  if (S.ctx) {
    if (S.ctx.state === 'suspended') await S.ctx.resume();
    return S.ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('Web Audio is not supported in this browser.'); throw new Error('no webaudio'); }
  const ctx = new AC({ latencyHint: 'interactive' });
  S.ctx = ctx;

  // master chain: masterIn -> masterGain -> splitter -> analysers ; masterGain -> destination
  S.masterIn = ctx.createGain();
  S.masterGain = ctx.createGain();
  S.masterGain.gain.value = S.master.vol;
  const mSplit = ctx.createChannelSplitter(2);
  S.masterAnL = ctx.createAnalyser(); S.masterAnR = ctx.createAnalyser();
  for (const a of [S.masterAnL, S.masterAnR]) { a.fftSize = 512; a.smoothingTimeConstant = 0.4; }
  S.masterIn.connect(S.masterGain);
  S.masterGain.connect(ctx.destination);
  S.masterGain.connect(mSplit);
  mSplit.connect(S.masterAnL, 0); mSplit.connect(S.masterAnR, 1);

  // tune worklet
  try {
    const blob = new Blob([TUNE_WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    S.tuneOK = true;
  } catch (e) { S.tuneOK = false; }

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
    if (!ch.nodes) ch.nodes = makeChannelNodes(ctx, ch, { meters: true, tuneOK: S.tuneOK });
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
   input -> [mono-ize] -> tune -> eq -> comp -> delay -> verb
         -> fader -> pan -> mute -> out (routable)
                            mute -> sendA, sendB (post-fader sends)
                            mute -> meter split -> analysers (post-fader)
   Chain order: Tune -> EQ -> Compressor -> Delay -> Reverb.
   Slots are either 'insert' (tune/eq/comp: dry/wet crossfade on bypass)
   or 'additive' (delay/verb: dry always passes, wet adds at mix level).
--------------------------------------------------------------------------- */
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

function makeReverbImpulse(ctx, seconds) {
  const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
  const imp = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = imp.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return imp;
}

function makeChannelNodes(ctx, ch, opts) {
  const { meters = false, tuneOK = true } = opts || {};
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

  // EQ — 3 band (insert)
  n.eqLow = ctx.createBiquadFilter();  n.eqLow.type = 'lowshelf';  n.eqLow.frequency.value = 220;
  n.eqMid = ctx.createBiquadFilter();  n.eqMid.type = 'peaking';   n.eqMid.frequency.value = 1200; n.eqMid.Q.value = 0.9;
  n.eqHigh = ctx.createBiquadFilter(); n.eqHigh.type = 'highshelf'; n.eqHigh.frequency.value = 6500;
  n.eqSlot = makeSlot(ctx, () => {
    n.eqLow.connect(n.eqMid); n.eqMid.connect(n.eqHigh);
    return { in: n.eqLow, out: n.eqHigh };
  }, false);
  head.connect(n.eqSlot.in); head = n.eqSlot.out;

  // COMPRESSOR (insert)
  n.comp = ctx.createDynamicsCompressor();
  n.compSlot = makeSlot(ctx, () => ({ in: n.comp, out: n.comp }), false);
  head.connect(n.compSlot.in); head = n.compSlot.out;

  // DELAY — additive (time / feedback / mix)
  n.dlNode = ctx.createDelay(2.0);
  n.dlFb = ctx.createGain();
  n.dlWet = ctx.createGain();
  n.dlNode.connect(n.dlFb); n.dlFb.connect(n.dlNode); // feedback loop (DelayNode breaks the cycle)
  n.dlNode.connect(n.dlWet);
  n.delaySlot = makeSlot(ctx, () => ({ in: n.dlNode, out: n.dlWet }), true);
  head.connect(n.delaySlot.in); head = n.delaySlot.out;

  // REVERB — additive, generated stereo impulse
  n.conv = ctx.createConvolver();
  try { n.conv.buffer = makeReverbImpulse(ctx, 2.2 * (P.verb.size || 1)); } catch (e) {}
  n.verbSlot = makeSlot(ctx, () => ({ in: n.conv, out: n.conv }), true);
  head.connect(n.verbSlot.in); head = n.verbSlot.out;

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

function applyParamsToNodes(ch, nodes) {
  const P = ch.params, ctx = nodes.fader.context, t = ctx.currentTime;
  const anySolo = [...S.tracks, ...S.auxes].some(c => c.params.solo);
  const audible = !P.muted && !(anySolo && !P.solo);
  nodes.fader.gain.setTargetAtTime(P.vol * P.vol, t, 0.02);
  if (nodes.pan.pan) nodes.pan.pan.setTargetAtTime(P.pan, t, 0.02);
  nodes.muteG.gain.setTargetAtTime(audible ? 1 : 0, t, 0.015);
  nodes.sendA.gain.setTargetAtTime(P.sendALvl, t, 0.02);
  nodes.sendB.gain.setTargetAtTime(P.sendBLvl, t, 0.02);
  // fx chain: Tune -> EQ -> Comp -> Delay -> Reverb
  nodes.tuneSlot.setBypassed(!P.tune.on, t);
  pushTuneParams(ch, nodes);
  nodes.eqSlot.setBypassed(!P.eq.on, t);
  nodes.eqLow.gain.setTargetAtTime(P.eq.low, t, 0.02);
  nodes.eqMid.gain.setTargetAtTime(P.eq.mid, t, 0.02);
  nodes.eqHigh.gain.setTargetAtTime(P.eq.high, t, 0.02);
  nodes.compSlot.setBypassed(!P.comp.on, t);
  nodes.comp.threshold.setTargetAtTime(P.comp.threshold, t, 0.02);
  nodes.comp.ratio.setTargetAtTime(P.comp.ratio, t, 0.02);
  nodes.delaySlot.setMix(P.delay.mix * 1.3, t);
  nodes.delaySlot.setBypassed(!P.delay.on, t);
  nodes.dlNode.delayTime.setTargetAtTime(Math.min(1.9, Math.max(0.01, P.delay.time)), t, 0.02);
  nodes.dlFb.gain.setTargetAtTime(Math.min(0.9, P.delay.feedback), t, 0.02);
  nodes.verbSlot.setMix(0.1 + P.verb.mix * 1.6, t);
  nodes.verbSlot.setBypassed(!P.verb.on, t);
}

function applyChannelParams(ch) {
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
function getChannel(id) { return allChannels().find(c => c.id === id) || null; }

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
    } catch (e) { toast('Could not decode ' + f.name); }
  }
  drawTimeline(); renderHeaders(); saveSession();
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
  if (S.ctx && S.playStartPos > S.duration) S.playStartPos = 0;
  $('btn-play').classList.remove('on');
  $('btn-play').textContent = '▶';
  drawTimeline();
}

function togglePlay() { S.playing ? stop() : play(); }
function backToStart() { const was = S.playing; stop(); S.playStartPos = 0; if (was) play(0); else drawTimeline(); }

/* ------------------------------ recording -------------------------------- */
async function toggleRecord() {
  if (S.recording) { stopRecording(false); return; }
  const tr = S.tracks.find(t => t.recArmed && t.kind === 'audio') || S.tracks.find(t => t.kind === 'audio');
  if (!tr) { toast('Create an audio track first, then arm it (●) to record.'); return; }
  tr.recArmed = true;
  await ensureCtx();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording is not supported in this browser.'); return; }
  if (typeof MediaRecorder === 'undefined') { toast('Recording is not supported in this browser.'); return; }
  let stream;
  try {
    let devId = tr.input;
    if (!devId || devId === 'session') devId = S.io.inputId;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: (devId && devId !== 'default') ? { deviceId: { exact: devId } } : true,
    });
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
      const clip = {
        id: uid('clip'), name: 'Take ' + (tr.clips.length + 1),
        buffer: buf, start: S.playStartPosAtRec || 0,
        offset: 0, duration: buf.duration, peaks: computePeaks(buf),
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
  S.playStartPosAtRec = S.playStartPos;
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
function encodeWAV(buffer) {
  const nCh = 2, sr = buffer.sampleRate, n = buffer.length;
  const bytes = 44 + n * nCh * 2;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, n * nCh * 2, true);
  const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const chd of [L, R]) {
      const s = Math.max(-1, Math.min(1, chd[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function exportWAV() {
  const hasAudio = S.tracks.some(t => t.clips.some(c => !c.missing && c.buffer));
  if (!hasAudio) { toast('Nothing to export — import or record some audio first.'); return; }
  toast('Rendering mix…');
  const sr = 44100;
  const dur = Math.max(1, S.duration + 2.5);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) { toast('Mix export is not supported in this browser.'); return; }
  const off = new OAC(2, Math.ceil(dur * sr), sr);

  let tuneOK = false;
  try {
    const blob = new Blob([TUNE_WORKLET_CODE], { type: 'application/javascript' });
    await off.audioWorklet.addModule(URL.createObjectURL(blob));
    tuneOK = true;
  } catch (e) {}

  const G = { masterIn: off.createGain(), busNodes: new Map(), auxInputs: new Map() };
  const masterGain = off.createGain();
  masterGain.gain.value = S.master.vol;
  G.masterIn.connect(masterGain); masterGain.connect(off.destination);

  for (const b of S.buses) G.busNodes.set(b.id, off.createGain());

  const nodeMap = new Map();
  for (const ch of allChannels()) {
    const nodes = makeChannelNodes(off, ch, { meters: false, tuneOK });
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
    const blob = encodeWAV(rendered);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dahyo-mix.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Mix exported — dahyo-mix.wav');
  } catch (e) { toast('Export failed: ' + e.message); }
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
  for (const k of ['tune', 'eq', 'comp', 'delay', 'verb']) {
    ch.params[k] = JSON.parse(JSON.stringify(tpl.params[k]));
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
        dragClip.start = Math.max(0, startVal + dx);
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
  body.append(fxTune(ch));
  body.append(fxEQ(ch));
  body.append(fxComp(ch));
  body.append(fxDelay(ch));
  body.append(fxVerb(ch));
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
function fxShell(title, fx, ch, note) {
  const box = el('div', 'ins-block');
  const h = el('h3');
  h.append(el('span', 'fxname', title));
  h.append(el('span', 'spacer'));
  h.append(bypassBtn(fx, () => ensureCtx().then(() => applyChannelParams(ch)), title + ' bypass'));
  box.append(h);
  if (note) box.append(el('div', 'fxnote', note));
  return box;
}

// --- TUNE ---
function fxTune(ch) {
  const T = ch.params.tune;
  const box = fxShell('Tune', T, ch, 'Auto-Tune-style pitch correction. Monophonic sources (vocals, bass) — chords will smear.');
  if (S.ctx && !S.tuneOK) {
    box.append(el('div', 'fxnote warn', 'Pitch correction needs AudioWorklet, which this browser does not support — Tune is bypassed here. Everything else works normally.'));
  }
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  box.append(cv);
  ch._tuneCanvas = cv;
  ch._tuneMsg = (d) => { ch._tuneData = d; };
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Retune', 0, 1, T.speed,
    v => v < 0.25 ? 'Hard' : v < 0.6 ? Math.round(v * 100) + '' : v < 0.85 ? 'Chill' : 'Natural',
    (v) => { T.speed = v; ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); },
    'Retune speed — left is hard T-Pain style, right is transparent').el);
  const keyWrap = el('div', 'knob');
  keyWrap.title = 'Correction key';
  const keyLab = el('div', 'kl', 'Key');
  const keySel = document.createElement('select');
  KEY_NAMES.forEach((kn, i) => keySel.append(new Option(kn, i)));
  keySel.value = T.key;
  keySel.onchange = () => { Undo.push('FX: Tune key'); T.key = parseInt(keySel.value); ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); };
  keyWrap.append(keyLab, keySel);
  const scWrap = el('div', 'knob');
  scWrap.title = 'Correction scale';
  const scLab = el('div', 'kl', 'Scale');
  const scSel = document.createElement('select');
  Object.keys(SCALES).forEach(k => scSel.append(new Option(k, k)));
  scSel.value = T.scale;
  scSel.onchange = () => { Undo.push('FX: Tune scale'); T.scale = scSel.value; ensureCtx().then(() => pushTuneParams(ch, ch.nodes)); saveSession(); };
  scWrap.append(scLab, scSel);
  kr.append(keyWrap, scWrap);
  box.append(kr);
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

// --- EQ ---
function fxEQ(ch) {
  const E = ch.params.eq;
  const box = fxShell('EQ', E, ch, '3-band equalizer. Boost lows for weight, cut mud around 300–500 Hz, air on top.');
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  box.append(cv);
  ch._eqCanvas = cv;
  const kr = el('div', 'knob-row');
  const mk = (label, key, title) => createKnob(label, -15, 15, E[key],
    v => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB',
    (v) => { E[key] = v; ensureCtx().then(() => applyChannelParams(ch)); drawEQCurve(ch); saveSession(); }, title);
  kr.append(mk('Low', 'low', 'Low shelf @ 220 Hz').el, mk('Mid', 'mid', 'Peaking @ 1.2 kHz').el, mk('High', 'high', 'High shelf @ 6.5 kHz').el);
  box.append(kr);
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
  const { eqLow, eqMid, eqHigh } = ch.nodes;
  try {
    const m1 = new Float32Array(N), m2 = new Float32Array(N), m3 = new Float32Array(N);
    const p = new Float32Array(N);
    eqLow.getFrequencyResponse(freq, m1, p);
    eqMid.getFrequencyResponse(freq, m2, p);
    eqHigh.getFrequencyResponse(freq, m3, p);
    for (let i = 0; i < N; i++) mag[i] = m1[i] * m2[i] * m3[i];
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

// --- COMPRESSOR ---
function fxComp(ch) {
  const C = ch.params.comp;
  const box = fxShell('Compressor', C, ch, 'Tames peaks and glues the sound. Lower threshold = more squeeze.');
  const cv = document.createElement('canvas');
  cv.className = 'fxviz'; cv.width = 260; cv.height = 84;
  box.append(cv);
  ch._compCanvas = cv;
  const { row: r1 } = sliderRow('Threshold', -48, 0, 1, C.threshold, v => v.toFixed(0) + ' dB',
    (v) => { C.threshold = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'Level where compression kicks in');
  const { row: r2 } = sliderRow('Ratio', 1, 20, 0.5, C.ratio, v => v.toFixed(1) + ':1',
    (v) => { C.ratio = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'How hard it squeezes past the threshold');
  box.append(r1, r2);
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
  const box = fxShell('Delay', D, ch, 'Echo. Short times thicken, long times bounce — ride the mix for throws.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Time', 0.03, 1.5, D.time, v => Math.round(v * 1000) + 'ms',
    (v) => { D.time = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'Delay time').el);
  kr.append(createKnob('Feedback', 0, 0.9, D.feedback, v => Math.round(v * 100) + '%',
    (v) => { D.feedback = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'Repeats — careful past 70%').el);
  kr.append(createKnob('Mix', 0, 1, D.mix, v => Math.round(v * 100) + '%',
    (v) => { D.mix = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'Wet/dry mix').el);
  box.append(kr);
  return box;
}

// --- REVERB ---
function fxVerb(ch) {
  const V = ch.params.verb;
  const box = fxShell('Reverb', V, ch, 'Generated studio room. Put it on an aux and feed it with Send A for classic throws.');
  const kr = el('div', 'knob-row');
  kr.append(createKnob('Mix', 0, 1, V.mix, v => Math.round(v * 100) + '%',
    (v) => { V.mix = v; ensureCtx().then(() => applyChannelParams(ch)); saveSession(); }, 'Wet/dry mix').el);
  kr.append(createKnob('Size', 0.3, 2, V.size, v => v < 0.8 ? 'Room' : v < 1.4 ? 'Hall' : 'Cathedral',
    (v) => {
      V.size = v;
      ensureCtx().then(() => {
        if (ch.nodes) { try { ch.nodes.conv.buffer = makeReverbImpulse(S.ctx, 2.2 * v); } catch (e) {} }
        saveSession();
      });
    }, 'Room size — regenerates the impulse').el);
  box.append(kr);
  return box;
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
  s.append(nm, meter, fader, pan.el, msrow, iolab);
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
  s.append(meter, fader, el('div', 'iolab', '→ speakers'));
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
    paintMeter(mc, m.l, m.r, m.pl, m.pr);
  }
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
  $('arrange-view').hidden = v !== 'arrange';
  $('mixer-view').hidden = v !== 'mixer';
  if (v === 'mixer') renderMixer();
  else { renderHeaders(); renderInspector(); drawTimeline(); }
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
    v: 2, bpm: S.bpm, timesig: S.timesig, masterVol: S.master.vol,
    pxPerSec: S.pxPerSec,
    markers: (S.markers || []).map(m => ({ id: m.id, pos: m.pos, name: m.name })),
    io: { inputId: S.io.inputId, outputId: S.io.outputId },
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
  for (const k of ['tune', 'eq', 'comp', 'delay', 'verb']) ch.params[k] = Object.assign(dp[k], ch.params[k] || {});
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
  if (data.io) { S.io.inputId = data.io.inputId || 'default'; S.io.outputId = data.io.outputId || 'default'; }
  S.buses = (data.buses || []).map(b => ({ id: b.id, name: b.name, format: b.format || 'stereo', output: b.output || 'master', node: null }));
  S.tracks = (data.tracks || []).map(hydrateChannel);
  S.auxes = (data.auxes || []).map(hydrateChannel);
  S.selId = data.selId || (S.tracks[0] || S.auxes[0] || {}).id || null;
}

function loadSession() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return false; }
  if (!data || data.v !== 2) return false;
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
    } else {
      drawMeters();
    }
  } catch (e) { /* render loop never kills the app */ }
}

/* --------------------------------- init ---------------------------------- */
function init() {
  const had = loadSession();
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
  $('btn-export').onclick = () => ensureCtx().then(exportWAV);
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
