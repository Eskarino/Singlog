const NOTE_NAMES = ['Do','Do#','Ré','Ré#','Mi','Fa','Fa#','Sol','Sol#','La','La#','Si'];

// 4096 was tried to give low notes more periods per window, but with more
// periods in the buffer the harmonic-bias correction below starts locking
// onto 2x the true period on some notes, reporting half the real frequency.
// 2048 is the stable value.
const PITCH_FFT_SIZE = 2048;

function noteNumToLabel(noteNum){
  const rounded = Math.round(noteNum);
  const cents = (noteNum - rounded) * 100;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name, octave, cents };
}

let centsBuffer = []; // recent raw cents readings, for median smoothing
const SMOOTH_WINDOW = 6;

function smoothedNoteNum(rawNoteNum){
  centsBuffer.push(rawNoteNum);
  if (centsBuffer.length > SMOOTH_WINDOW) centsBuffer.shift();
  const sorted = [...centsBuffer].sort((a,b) => a-b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Octave-continuity anchor (see autoCorrelate below) and smoothing buffer,
// tracked across frames so a note holds steady instead of re-settling from
// scratch every frame.
let lastFreq = null;
let lastVoicedAt = null;
// Below this, a rejected frame is treated as a micro-glitch (a consonant, a
// single noisy frame) rather than a real pause — most gaps between voiced
// stretches are 30-200ms, well inside a sung phrase, yet wiping the anchor
// on every one of them meant the very next (unprotected, unsmoothed) raw
// estimate displayed immediately, producing a visible jump right when
// voicing resumed. Matches the 0.15s breath-cut threshold used for the
// visual curve (see visualization.js).
const CONTINUITY_RESET_SECONDS = 0.15;

function resetPitchContinuity(){
  centsBuffer = [];
  lastFreq = null;
  lastVoicedAt = null;
}

function markVoicedFrame(now, freq){
  lastFreq = freq;
  lastVoicedAt = now;
}

function markUnvoicedFrame(now){
  if (lastVoicedAt === null || now - lastVoicedAt > CONTINUITY_RESET_SECONDS){
    centsBuffer = []; // don't let smoothing bleed across silence gaps
    lastFreq = null;  // don't let octave-continuity lock onto a stale pre-silence pitch
  }
}

// Autocorrelation pitch detection (ACF2+) with three corrections that matter
// specifically for singing voice (not just clean instrument tones):
//
// 1. Harmonic bias: for a weak/breathy fundamental (common on low chest-
//    voice notes), a strong harmonic can out-correlate the true, longer-lag
//    fundamental — the raw "tallest peak" search then reports a pitch that's
//    a fixed ratio too high (not even a clean octave, e.g. ~10x), which the
//    narrow octave-continuity window below can't catch. Since a harmonic's
//    peak always sits at a SHORTER lag than the true period, prefer the
//    longest-lag peak that's still nearly as strong as the global max.
// 2. Octave-continuity: the singing voice has strong harmonics, so the
//    global correlation peak often sits at a harmonic/subharmonic of the
//    true fundamental instead of the fundamental itself. If a nearly-as-
//    strong peak exists near the previous frame's pitch, prefer it — this
//    is the standard fix for the "note jumps an octave" failure mode.
// 3. Confidence gate: reject frames where even the best peak is a weak
//    fraction of perfect self-correlation (breath noise, consonants,
//    silence) instead of reporting a spurious note.
// Thresholds tuned against real captured voice/silence data (see git history
// for the readings behind each value) rather than guessed.
const RMS_SILENCE_THRESHOLD = 0.002; // below: true silence/background noise
const CONFIDENCE_THRESHOLD = 0.35; // below: too noisy/unvoiced to trust
const HARMONIC_MATCH_RATIO = 0.9; // how strong a subharmonic candidate must be, relative to the global peak, to override it
const OCTAVE_CONTINUITY_RATIO = 0.85; // how strong a peak near the previous pitch must be to override the global peak
const MIN_SUNG_FREQ = 50, MAX_SUNG_FREQ = 300; // outside this, it's not a plausible sung note

function autoCorrelate(buf, sampleRate, lastFreq){
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < RMS_SILENCE_THRESHOLD) return -1;

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++){ if (Math.abs(buf[i]) < thres){ r1 = i; break; } }
  for (let i = 1; i < SIZE / 2; i++){ if (Math.abs(buf[SIZE - i]) < thres){ r2 = SIZE - i; break; } }

  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++){
    for (let i = 0; i < n - lag; i++){
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (d < n - 1 && c[d] > c[d+1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++){
    if (c[i] > maxVal){ maxVal = c[i]; maxPos = i; }
  }
  if (maxPos <= 0) return -1;

  // Confidence: how strong is the best periodicity peak vs. perfect
  // self-correlation at lag 0.
  const confidence = maxVal / c[0];
  if (confidence < CONFIDENCE_THRESHOLD) return -1;

  // Harmonic bias correction: the global peak (maxPos) may be a harmonic of
  // the true fundamental rather than the fundamental itself, in which case
  // the true period sits at an exact integer multiple of maxPos's lag.
  // Check those specific candidate lags (2x, 3x, ...) instead of scanning
  // freely from the far end of the buffer for "any point that's ~90% as
  // strong" — that unconstrained scan could latch onto an unrelated tall
  // peak (buffer-edge noise, an onset transient right after a pause) with
  // no harmonic relationship to maxPos at all, reporting a bogus pitch.
  let T0 = maxPos;
  for (let mult = 2; mult * maxPos < n; mult++){
    const candidate = mult * maxPos;
    let localMax = -1, localPos = -1;
    for (let i = Math.max(0, candidate - 2); i <= Math.min(n - 1, candidate + 2); i++){
      if (c[i] > localMax){ localMax = c[i]; localPos = i; }
    }
    if (localMax >= HARMONIC_MATCH_RATIO * maxVal){ T0 = localPos; break; }
  }

  // Octave-continuity correction: look for a comparably strong peak
  // near where we'd expect the previous pitch to land, and prefer it.
  if (lastFreq){
    const expectedLag = sampleRate / lastFreq;
    const window = Math.max(4, Math.round(expectedLag * 0.12));
    let localMax = -1, localPos = -1;
    for (let i = Math.max(d, Math.round(expectedLag - window)); i <= Math.min(n - 1, Math.round(expectedLag + window)); i++){
      if (c[i] > localMax){ localMax = c[i]; localPos = i; }
    }
    if (localPos > 0 && localMax >= OCTAVE_CONTINUITY_RATIO * maxVal) T0 = localPos;
  }

  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2*x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2*a);

  const freq = sampleRate / T0;
  if (freq < MIN_SUNG_FREQ || freq > MAX_SUNG_FREQ) return -1;
  return freq;
}
