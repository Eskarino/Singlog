const NOTE_NAMES = ['Do','Do#','Ré','Ré#','Mi','Fa','Fa#','Sol','Sol#','La','La#','Si'];

let audioCtx, analyser, mediaStream, rafId, freqData;
let running = false;
let history = []; // rolling 30s window, for the display strip
let sessionLog = []; // full take, for export — not trimmed
const HISTORY_SECONDS = 30;

const toggleBtn = document.getElementById('toggleBtn');
const replayBtn = document.getElementById('replayBtn');
let mediaRecorder = null;
let recordedChunks = [];
let lastRecordingBlob = null;
let replaying = false;
let replayRafId = null;
let activeReplaySource = null;
let activeReplayCtx = null;
const statusEl = document.getElementById('status');
const noteNameEl = document.getElementById('noteName');
const noteOctEl = document.getElementById('noteOct');
const freqValEl = document.getElementById('freqVal');
const needleEl = document.getElementById('needle');
const centsLabelEl = document.getElementById('centsLabel');
const canvas = document.getElementById('history');
const ctx2d = canvas.getContext('2d');
const pitchCanvas = document.getElementById('pitchCurve');
const pitchCtx = pitchCanvas.getContext('2d');
const spectrumCanvas = document.getElementById('spectrum');
const spectrumCtx = spectrumCanvas.getContext('2d');
const statInTune = document.getElementById('statInTune');
const statAvg = document.getElementById('statAvg');
const statBias = document.getElementById('statBias');

toggleBtn.addEventListener('click', () => {
  if (!running) start(); else stop();
});

replayBtn.addEventListener('click', () => {
  if (replaying){
    stopReplay();
  } else if (lastRecordingBlob){
    playReplay();
  }
});

// Manual stop: cuts playback immediately and resets the playhead to 0,
// instead of forcing a wait for the recording to finish on its own.
function stopReplay(){
  if (replayRafId) cancelAnimationFrame(replayRafId);
  if (activeReplaySource){
    activeReplaySource.onended = null; // don't also fire the natural-end handler
    try { activeReplaySource.stop(); } catch(e){}
  }
  if (activeReplayCtx) activeReplayCtx.close();
  activeReplaySource = null;
  activeReplayCtx = null;

  replaying = false;
  replayBtn.textContent = "Replay le dernier sample";
  toggleBtn.disabled = false;
  statusEl.textContent = "Micro coupé";
  statusEl.classList.remove('live');
  noteNameEl.textContent = "—";
  noteOctEl.textContent = "";
  freqValEl.textContent = "0.0 Hz";
  centsLabelEl.innerHTML = "écart : <b>—</b>";
  needleEl.style.left = "50%";
  needleEl.style.background = "var(--amber)";
  spectrumCtx.clearRect(0,0,spectrumCanvas.width,spectrumCanvas.height);
  const fullDuration = sessionLog.length ? sessionLog[sessionLog.length - 1].t : 0;
  drawHistory(fullDuration, fullDuration, sessionLog, 0);
  drawPitchCurve(fullDuration, fullDuration, sessionLog, 0);
}

async function playReplay(){
  replaying = true;
  replayBtn.textContent = "Stop";
  toggleBtn.disabled = true;
  statusEl.textContent = "Relecture…";
  statusEl.classList.add('live');

  const playCtx = new (window.AudioContext || window.webkitAudioContext)();
  activeReplayCtx = playCtx;
  const arrBuf = await lastRecordingBlob.arrayBuffer();
  let audioBuffer;
  try {
    audioBuffer = await playCtx.decodeAudioData(arrBuf);
  } catch (e) {
    statusEl.textContent = "Relecture impossible (format non supporté par ce navigateur)";
    statusEl.classList.remove('live');
    replaying = false; replayBtn.textContent = "Replay le dernier sample"; toggleBtn.disabled = false;
    playCtx.close();
    activeReplayCtx = null;
    return;
  }

  const replaySource = playCtx.createBufferSource();
  replaySource.buffer = audioBuffer;
  activeReplaySource = replaySource;
  const replayAnalyser = playCtx.createAnalyser();
  replayAnalyser.fftSize = 2048;
  const replayFreqData = new Uint8Array(replayAnalyser.frequencyBinCount);
  replaySource.connect(replayAnalyser);
  replayAnalyser.connect(playCtx.destination);

  const fullDuration = sessionLog.length ? sessionLog[sessionLog.length - 1].t : 0;
  const startCtxTime = playCtx.currentTime;

  function tick(){
    const elapsed = playCtx.currentTime - startCtxTime;
    if (elapsed >= audioBuffer.duration || elapsed >= fullDuration){
      finishReplay();
      return;
    }
    // playhead + frozen full-session charts underneath it
    drawHistory(fullDuration, fullDuration, sessionLog, elapsed);
    drawPitchCurve(fullDuration, fullDuration, sessionLog, elapsed);

    // live-looking readout, sourced from the nearest logged frame (not re-detected)
    const nearest = sessionLog.reduce((best, p) =>
      Math.abs(p.t - elapsed) < Math.abs(best.t - elapsed) ? p : best, sessionLog[0]);
    if (nearest && !nearest.silent){
      noteNameEl.textContent = nearest.note.replace(/\d+$/, '');
      noteOctEl.textContent = nearest.note.match(/\d+$/) ? nearest.note.match(/\d+$/)[0] : '';
      freqValEl.textContent = nearest.freq.toFixed(1) + " Hz";
      updateNeedle(nearest.cents);
    }

    // real FFT of the audio as it actually plays back
    replayAnalyser.getByteFrequencyData(replayFreqData);
    drawSpectrumFrom(replayFreqData, playCtx.sampleRate);

    replayRafId = requestAnimationFrame(tick);
  }

  function finishReplay(){
    if (replayRafId) cancelAnimationFrame(replayRafId);
    replaying = false;
    replayBtn.textContent = "Replay le dernier sample";
    toggleBtn.disabled = false;
    statusEl.textContent = "Micro coupé";
    statusEl.classList.remove('live');
    drawHistory(fullDuration, fullDuration, sessionLog);
    drawPitchCurve(fullDuration, fullDuration, sessionLog);
    spectrumCtx.clearRect(0,0,spectrumCanvas.width,spectrumCanvas.height);
    playCtx.close();
    activeReplaySource = null;
    activeReplayCtx = null;
  }

  replaySource.onended = finishReplay;
  replaySource.start();
  tick();
}

async function start(){
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false
    }});
  }catch(e){
    statusEl.textContent = "Accès micro refusé ou indisponible";
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = PITCH_FFT_SIZE;
  source.connect(analyser);
  freqData = new Uint8Array(analyser.frequencyBinCount);

  // Record raw audio in parallel, purely for the "replay" feature — not used
  // for any pitch analysis (that stays live, from the analyser above).
  recordedChunks = [];
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = mimeCandidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  try {
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    mediaRecorder = null; // replay just won't be available this session
  }

  running = true;
  toggleBtn.textContent = "Arrêter";
  toggleBtn.classList.add('active');
  statusEl.textContent = "En écoute";
  statusEl.classList.add('live');
  replayBtn.disabled = true;
  lastRecordingBlob = null;
  pitchCtx.clearRect(0,0,pitchCanvas.width,pitchCanvas.height);
  history = [];
  sessionLog = [];
  centsBuffer = [];
  lastFreq = null;
  lastVoicedAt = null;
  sessionStart = performance.now() / 1000;
  loop();
}

function stop(){
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.onstop = () => {
      lastRecordingBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      replayBtn.disabled = sessionLog.filter(e => !e.silent).length === 0;
    };
    mediaRecorder.stop();
  }
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  toggleBtn.textContent = "Démarrer";
  toggleBtn.classList.remove('active');
  statusEl.textContent = "Micro coupé";
  statusEl.classList.remove('live');
  noteNameEl.textContent = "—";
  noteOctEl.textContent = "";
  freqValEl.textContent = "0.0 Hz";
  centsLabelEl.innerHTML = "écart : <b>—</b>";
  needleEl.style.left = "50%";
  needleEl.style.background = "var(--amber)";
  spectrumCtx.clearRect(0,0,spectrumCanvas.width,spectrumCanvas.height);

  // freeze the FULL session (not just the trailing live window) onto both charts
  const fullDuration = sessionLog.length ? sessionLog[sessionLog.length - 1].t : 0;
  drawHistory(fullDuration, fullDuration, sessionLog);
  drawPitchCurve(fullDuration, fullDuration, sessionLog);
}

let sessionStart = 0;
// 4096 was tried to give low notes more periods per window, but with more
// periods in the buffer the harmonic-bias correction below starts locking
// onto 2x the true period on some notes, reporting half the real frequency.
// 2048 is the stable value.
const PITCH_FFT_SIZE = 2048;
const buf = new Float32Array(PITCH_FFT_SIZE);
let lastFreq = null;
let lastVoicedAt = null;
// Below this, a rejected frame is treated as a micro-glitch (a consonant, a
// single noisy frame) rather than a real pause — most gaps between voiced
// stretches are 30-200ms, well inside a sung phrase, yet every one of them
// was wiping the octave-continuity anchor and the smoothing buffer; the very
// next (unprotected, unsmoothed) raw estimate would then display immediately,
// producing a visible jump right when voicing resumed. Matches the 0.15s
// breath-cut threshold already used for the visual curve.
const CONTINUITY_RESET_SECONDS = 0.15;
let centsBuffer = []; // recent raw cents readings, for median smoothing
const SMOOTH_WINDOW = 6;

function smoothedNoteNum(rawNoteNum){
  centsBuffer.push(rawNoteNum);
  if (centsBuffer.length > SMOOTH_WINDOW) centsBuffer.shift();
  const sorted = [...centsBuffer].sort((a,b) => a-b);
  return sorted[Math.floor(sorted.length / 2)];
}

function loop(){
  if (!running) return;
  analyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, audioCtx.sampleRate, lastFreq);
  if (freq > 0) lastFreq = freq;
  const now = performance.now() / 1000;

  if (freq > 0){
    const rawNoteNum = 12 * Math.log2(freq / 440) + 69;
    const noteNum = smoothedNoteNum(rawNoteNum);
    const { name, octave, cents } = noteNumToLabel(noteNum);
    noteNameEl.textContent = name;
    noteOctEl.textContent = octave;
    freqValEl.textContent = freq.toFixed(1) + " Hz";
    updateNeedle(cents);
    const entry = { t: +(now - sessionStart).toFixed(2), cents: +cents.toFixed(1), freq: +freq.toFixed(2), note: name + octave, noteNum, silent:false };
    history.push(entry);
    sessionLog.push(entry);
    lastVoicedAt = now;
  } else {
    // Only wipe continuity/smoothing state after a real pause — a lone
    // rejected frame mid-phrase shouldn't cost the next frame its anchor.
    if (lastVoicedAt === null || now - lastVoicedAt > CONTINUITY_RESET_SECONDS){
      centsBuffer = []; // don't let smoothing bleed across silence gaps
      lastFreq = null;  // don't let octave-continuity lock onto a stale pre-silence pitch
    }
    noteNameEl.textContent = "—";
    noteOctEl.textContent = "";
    freqValEl.textContent = "…";
    centsLabelEl.innerHTML = "écart : <b>—</b>";
    needleEl.style.left = "50%";
    needleEl.style.background = "var(--amber-dim)";
    const entry = { t: +(now - sessionStart).toFixed(2), cents: null, freq: null, note: null, silent:true };
    history.push(entry);
    sessionLog.push(entry);
  }

  const nowRel = now - sessionStart;
  history = history.filter(p => nowRel - p.t <= HISTORY_SECONDS);
  drawHistory(nowRel);
  drawPitchCurve(nowRel);
  drawSpectrum();
  updateStats();

  rafId = requestAnimationFrame(loop);
}

function updateNeedle(cents){
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = 50 + (clamped / 50) * 50;
  needleEl.style.left = pct + "%";
  let color = "var(--green)";
  if (Math.abs(cents) > 15) color = "var(--amber)";
  if (Math.abs(cents) > 35) color = "var(--red)";
  needleEl.style.background = color;
  const sign = cents > 0 ? "+" : "";
  centsLabelEl.innerHTML = `écart : <b>${sign}${cents.toFixed(0)}¢</b> ${cents>0 ? '(trop haut)' : cents<0 ? '(trop bas)' : ''}`;
}

function noteNumToLabel(noteNum){
  const rounded = Math.round(noteNum);
  const cents = (noteNum - rounded) * 100;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name, octave, cents };
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

// Reserved band (in internal canvas px) at the bottom of history/pitchCurve
// for the seconds axis, kept out of the plotted area so labels never overlap
// bars or the pitch line.
const AXIS_H = 30;

// Picks a round tick step (1,2,5,10,15,20,30,60...s) so that at most maxTicks
// labels ever show at once, regardless of the window's duration.
function niceTimeStep(windowSeconds, maxTicks){
  const candidates = [1,2,5,10,15,20,30,60,90,120,180,300,600,900,1800,3600];
  for (const step of candidates){
    if (windowSeconds / step <= maxTicks) return step;
  }
  return candidates[candidates.length - 1];
}

function drawTimeAxis(ctx, w, h, plotH, now, windowSeconds){
  const step = niceTimeStep(windowSeconds, 5);
  const xFor = t => w - ((now - t) / windowSeconds) * w;
  const startTick = Math.ceil((now - windowSeconds) / step) * step;
  ctx.font = "20px monospace";
  ctx.textAlign = "center";
  for (let t = startTick; t <= now + 1e-6; t += step){
    if (t < -1e-6) continue; // no data before session start
    const x = xFor(t);
    if (x < 6 || x > w - 6) continue;
    ctx.strokeStyle = "#2a2f2b";
    ctx.beginPath();
    ctx.moveTo(x, plotH); ctx.lineTo(x, plotH + 5);
    ctx.stroke();
    ctx.fillStyle = "#8a8f89";
    ctx.fillText(Math.round(t) + "s", x, h - 8);
  }
  ctx.textAlign = "left";
}

function drawHistory(now, windowSeconds = HISTORY_SECONDS, data = history, playheadT = null){
  const w = canvas.width, h = canvas.height;
  const plotH = h - AXIS_H;
  ctx2d.clearRect(0,0,w,h);

  // center line
  ctx2d.strokeStyle = "#2a2f2b";
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, plotH/2); ctx2d.lineTo(w, plotH/2);
  ctx2d.stroke();

  const xFor = t => w - ((now - t) / windowSeconds) * w;
  const barW = Math.max(w / (windowSeconds * 30), 1.5); // ~30fps budget worth of slots
  data.forEach(p => {
    if (p.silent || p.cents === null || now - p.t > windowSeconds) return;
    const x = xFor(p.t);
    const clamped = Math.max(-50, Math.min(50, p.cents));
    const y = plotH/2 - (clamped/50) * (plotH/2 - 6);
    let color = "#4fd67a";
    if (Math.abs(p.cents) > 15) color = "#ffb000";
    if (Math.abs(p.cents) > 35) color = "#ff5d5d";
    ctx2d.fillStyle = color;
    ctx2d.fillRect(x, Math.min(y, plotH/2), barW, Math.abs(plotH/2 - y) || 2);
  });

  if (playheadT != null){
    const x = xFor(playheadT);
    ctx2d.strokeStyle = "#ffffff";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0); ctx2d.lineTo(x, plotH);
    ctx2d.stroke();
  }

  drawTimeAxis(ctx2d, w, h, plotH, now, windowSeconds);
}

const PITCH_CURVE_SECONDS = 12;

function drawPitchCurve(now, windowSeconds = PITCH_CURVE_SECONDS, data = history, playheadT = null){
  const w = pitchCanvas.width, h = pitchCanvas.height;
  const plotH = h - AXIS_H;
  pitchCtx.clearRect(0,0,w,h);

  const recent = data.filter(p => now - p.t <= windowSeconds && !p.silent && p.noteNum != null);
  if (recent.length < 2){
    pitchCtx.fillStyle = "#4a4f4a";
    pitchCtx.font = "13px monospace";
    pitchCtx.fillText("en attente de voix…", 14, plotH/2);
    drawTimeAxis(pitchCtx, w, h, plotH, now, windowSeconds);
    return;
  }

  // vertical range: center on the data, pad by a few semitones
  let minN = Math.min(...recent.map(p => p.noteNum));
  let maxN = Math.max(...recent.map(p => p.noteNum));
  minN = Math.floor(minN) - 2;
  maxN = Math.ceil(maxN) + 2;
  const span = Math.max(maxN - minN, 4);

  const yFor = n => plotH - ((n - minN) / span) * plotH;
  const xFor = t => w - ((now - t) / windowSeconds) * w;

  // horizontal gridlines + note labels, one per semitone in range
  pitchCtx.font = "22px monospace";
  pitchCtx.textAlign = "left";
  for (let n = Math.ceil(minN); n <= Math.floor(maxN); n++){
    const y = yFor(n);
    const { name, octave } = noteNumToLabel(n);
    const isNatural = !name.includes('#');
    pitchCtx.strokeStyle = isNatural ? "#2c3128" : "#1e2219";
    pitchCtx.beginPath();
    pitchCtx.moveTo(0, y); pitchCtx.lineTo(w, y);
    pitchCtx.stroke();
    pitchCtx.fillStyle = "#8a8f89";
    const labelY = y < 12 ? y + 16 : y - 4; // flip below the line if too close to the top edge
    pitchCtx.fillText(name + octave, 4, labelY);
  }

  // the continuous pitch line itself, split into segments at gaps (breaths)
  pitchCtx.lineWidth = 2.5;
  pitchCtx.strokeStyle = "#ffb000";
  pitchCtx.shadowColor = "rgba(255,176,0,0.5)";
  pitchCtx.shadowBlur = 4;
  pitchCtx.beginPath();
  let penDown = false;
  let prevT = null;
  for (const p of recent){
    const x = xFor(p.t), y = yFor(p.noteNum);
    if (!penDown || (prevT !== null && p.t - prevT > 0.15)){
      pitchCtx.moveTo(x, y);
      penDown = true;
    } else {
      pitchCtx.lineTo(x, y);
    }
    prevT = p.t;
  }
  pitchCtx.stroke();
  pitchCtx.shadowBlur = 0;

  if (playheadT != null){
    const x = xFor(playheadT);
    pitchCtx.strokeStyle = "#ffffff";
    pitchCtx.lineWidth = 2;
    pitchCtx.beginPath();
    pitchCtx.moveTo(x, 0); pitchCtx.lineTo(x, plotH);
    pitchCtx.stroke();
  }

  drawTimeAxis(pitchCtx, w, h, plotH, now, windowSeconds);
}

function drawSpectrum(){
  if (!analyser || !freqData) return;
  analyser.getByteFrequencyData(freqData);
  drawSpectrumFrom(freqData, audioCtx.sampleRate);
}

function drawSpectrumFrom(data, sampleRate){
  const w = spectrumCanvas.width, h = spectrumCanvas.height;
  spectrumCtx.clearRect(0,0,w,h);

  // Focus on the vocally-relevant range (~50Hz-2000Hz) rather than the
  // full Nyquist range, since almost nothing sung lives above that.
  const maxFreq = 2000;
  const maxBin = Math.min(data.length, Math.round(maxFreq / (sampleRate / 2) * data.length));

  const barW = w / maxBin;
  for (let i = 0; i < maxBin; i++){
    const v = data[i] / 255; // 0..1
    const barH = v * h;
    const hue = 45 - v * 45; // amber (low) -> reddish (loud/near clipping)
    spectrumCtx.fillStyle = `hsl(${hue}, 90%, ${45 + v*15}%)`;
    spectrumCtx.fillRect(i * barW, h - barH, Math.max(barW - 0.5, 1), barH);
  }

  // frequency axis labels
  spectrumCtx.fillStyle = "#5a6058";
  spectrumCtx.font = "10px monospace";
  [100, 250, 500, 1000, 1500, 2000].forEach(f => {
    if (f > maxFreq) return;
    const x = (f / maxFreq) * w;
    spectrumCtx.fillText(f + "Hz", Math.min(x, w - 40), h - 4);
  });
}

function updateStats(){
  const voiced = history.filter(p => !p.silent && p.cents !== null);
  if (voiced.length === 0){
    statInTune.textContent = "—";
    statAvg.textContent = "—";
    statBias.textContent = "—";
    return;
  }
  const inTune = voiced.filter(p => Math.abs(p.cents) <= 15).length;
  statInTune.textContent = Math.round(100 * inTune / voiced.length) + "%";

  const avgAbs = voiced.reduce((s,p) => s + Math.abs(p.cents), 0) / voiced.length;
  statAvg.textContent = avgAbs.toFixed(0);

  const meanSigned = voiced.reduce((s,p) => s + p.cents, 0) / voiced.length;
  if (Math.abs(meanSigned) < 5) statBias.textContent = "stable";
  else statBias.textContent = meanSigned > 0 ? "trop haut" : "trop bas";
}

window.addEventListener('beforeunload', () => { if (running) stop(); });
