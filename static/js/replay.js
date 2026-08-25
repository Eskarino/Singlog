const replayBtn = document.getElementById('replayBtn');
const replayIcon = document.getElementById('replayIcon');
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
// Restart/rewind glyph — a circular arrow, spun via CSS while playing (see .icon-btn.spinning).
const REWIND_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';

// During playback the charts show a window around the playhead instead of
// the whole session: 1s of what just played plus 3s of what's coming, with
// the "now" line fixed a quarter of the way across (1 / (1+3) = 25%) instead
// of sweeping across a static full-session view.
const REPLAY_LOOKBACK_SECONDS = 1;
const REPLAY_LOOKAHEAD_SECONDS = 3;

function setReplayIcon(playing){
  replayIcon.innerHTML = playing ? REWIND_ICON : PLAY_ICON;
  replayBtn.classList.toggle('spinning', playing);
}
setReplayIcon(false);

let mediaRecorder = null;
let recordedChunks = [];
let lastRecordingBlob = null;
let replaying = false;
let replayRafId = null;
let activeReplaySource = null;
let activeReplayCtx = null;

replayBtn.addEventListener('click', () => {
  if (replaying){
    stopReplay();
  } else if (lastRecordingBlob){
    playReplay();
  }
});

// Records raw audio in parallel with live pitch detection, purely for the
// "replay" feature — not used for any pitch analysis (that stays live).
function startRecording(mediaStream){
  recordedChunks = [];
  lastRecordingBlob = null;
  replayBtn.disabled = true;
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = mimeCandidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  try {
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    mediaRecorder = null; // replay just won't be available this session
  }
}

function stopRecording(){
  if (mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.onstop = () => {
      lastRecordingBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      replayBtn.disabled = sessionLog.filter(e => !e.silent).length === 0;
    };
    mediaRecorder.stop();
  }
}

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
  setReplayIcon(false);
  toggleBtn.disabled = false;
  statusEl.textContent = "";
  statusEl.classList.remove('live');
  noteNameEl.textContent = "—";
  noteOctEl.textContent = "";
  freqValEl.textContent = "0.0 Hz";
  centsLabelEl.innerHTML = "écart : <b>—</b>";
  needleEl.style.left = "50%";
  needleEl.style.background = "var(--amber)";
  spectrumCtx.clearRect(0,0,spectrumCanvas.width,spectrumCanvas.height);
  const fullDuration = sessionLog.length ? sessionLog[sessionLog.length - 1].t : 0;
  drawHistory(0, fullDuration, sessionLog, 0);
  drawPitchCurve(0, fullDuration, sessionLog, 0);
}

async function playReplay(){
  replaying = true;
  setReplayIcon(true);
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
    replaying = false; setReplayIcon(false); toggleBtn.disabled = false;
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
    // scrolling window straddling the playhead, not the whole session
    drawHistory(elapsed - REPLAY_LOOKBACK_SECONDS, elapsed + REPLAY_LOOKAHEAD_SECONDS, sessionLog, elapsed);
    drawPitchCurve(elapsed - REPLAY_LOOKBACK_SECONDS, elapsed + REPLAY_LOOKAHEAD_SECONDS, sessionLog, elapsed);

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
    setReplayIcon(false);
    toggleBtn.disabled = false;
    statusEl.textContent = "";
    statusEl.classList.remove('live');
    drawHistory(0, fullDuration, sessionLog);
    drawPitchCurve(0, fullDuration, sessionLog);
    spectrumCtx.clearRect(0,0,spectrumCanvas.width,spectrumCanvas.height);
    playCtx.close();
    activeReplaySource = null;
    activeReplayCtx = null;
  }

  replaySource.onended = finishReplay;
  replaySource.start();
  tick();
}
