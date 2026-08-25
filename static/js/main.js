let audioCtx, analyser, mediaStream, rafId, freqData;
let running = false;
let history = []; // rolling display window, kept in sync with TREND_WINDOW_SECONDS
let sessionLog = []; // full take, for replay/analysis — not trimmed
let sessionStart = 0;
const buf = new Float32Array(PITCH_FFT_SIZE);

const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const noteNameEl = document.getElementById('noteName');
const noteOctEl = document.getElementById('noteOct');
const freqValEl = document.getElementById('freqVal');
const needleEl = document.getElementById('needle');
const centsLabelEl = document.getElementById('centsLabel');
const statInTune = document.getElementById('statInTune');
const statAvg = document.getElementById('statAvg');
const statBias = document.getElementById('statBias');

toggleBtn.addEventListener('click', () => {
  if (!running) start(); else stop();
});

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

  startRecording(mediaStream);

  running = true;
  toggleBtn.textContent = "Arrêter";
  toggleBtn.classList.add('active');
  statusEl.textContent = "En écoute";
  statusEl.classList.add('live');
  analyseBtn.disabled = true;
  analyseStatus.textContent = "";
  analyseReport.classList.remove('visible');
  pitchCtx.clearRect(0,0,pitchCanvas.width,pitchCanvas.height);
  history = [];
  sessionLog = [];
  resetPitchContinuity();
  sessionStart = performance.now() / 1000;
  loop();
}

function stop(){
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  stopRecording();
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
  analyseBtn.disabled = sessionLog.filter(e => !e.silent && e.noteNum != null).length === 0;

  // freeze the FULL session (not just the trailing live window) onto both charts
  const fullDuration = sessionLog.length ? sessionLog[sessionLog.length - 1].t : 0;
  drawHistory(fullDuration, fullDuration, sessionLog);
  drawPitchCurve(fullDuration, fullDuration, sessionLog);
}

function loop(){
  if (!running) return;
  analyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, audioCtx.sampleRate, lastFreq);
  const now = performance.now() / 1000;

  if (freq > 0){
    markVoicedFrame(now, freq);
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
  } else {
    markUnvoicedFrame(now);
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
  history = history.filter(p => nowRel - p.t <= TREND_WINDOW_SECONDS);
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
