const replayBtn = document.getElementById('replayBtn');
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
