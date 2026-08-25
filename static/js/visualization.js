const canvas = document.getElementById('history');
const ctx2d = canvas.getContext('2d');
const pitchCanvas = document.getElementById('pitchCurve');
const pitchCtx = pitchCanvas.getContext('2d');
const spectrumCanvas = document.getElementById('spectrum');
const spectrumCtx = spectrumCanvas.getContext('2d');

// Both the history strip and the continuous pitch curve scroll at this same
// speed (same seconds-per-canvas-width), so a note lines up vertically
// between the two instead of drifting at different rates.
const TREND_WINDOW_SECONDS = 12;

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

// windowStart/windowEnd map linearly to the left/right edges of the canvas —
// windowEnd doesn't have to be "now" and windowStart doesn't have to be
// windowEnd minus the trend window: replay uses a window that straddles the
// playhead (1s behind, 3s ahead) instead of one that ends at "now", which is
// why this isn't just a single (now, duration) pair.
function drawTimeAxis(ctx, w, h, plotH, windowStart, windowEnd){
  const windowSeconds = windowEnd - windowStart;
  const step = niceTimeStep(windowSeconds, 5);
  const xFor = t => ((t - windowStart) / windowSeconds) * w;
  const startTick = Math.ceil(windowStart / step) * step;
  ctx.font = "20px monospace";
  ctx.textAlign = "center";
  for (let t = startTick; t <= windowEnd + 1e-6; t += step){
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

function drawHistory(windowStart, windowEnd, data = history, playheadT = null){
  const w = canvas.width, h = canvas.height;
  const plotH = h - AXIS_H;
  const windowSeconds = windowEnd - windowStart;
  ctx2d.clearRect(0,0,w,h);

  // center line
  ctx2d.strokeStyle = "#2a2f2b";
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, plotH/2); ctx2d.lineTo(w, plotH/2);
  ctx2d.stroke();

  const xFor = t => ((t - windowStart) / windowSeconds) * w;
  const barW = Math.max(w / (windowSeconds * 30), 1.5); // ~30fps budget worth of slots
  data.forEach(p => {
    if (p.silent || p.cents === null || p.t < windowStart || p.t > windowEnd) return;
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

  drawTimeAxis(ctx2d, w, h, plotH, windowStart, windowEnd);
}

function drawPitchCurve(windowStart, windowEnd, data = history, playheadT = null){
  const w = pitchCanvas.width, h = pitchCanvas.height;
  const plotH = h - AXIS_H;
  pitchCtx.clearRect(0,0,w,h);

  const recent = data.filter(p => p.t >= windowStart && p.t <= windowEnd && !p.silent && p.noteNum != null);
  if (recent.length < 2){
    pitchCtx.fillStyle = "#4a4f4a";
    pitchCtx.font = "13px monospace";
    pitchCtx.fillText("en attente de voix…", 14, plotH/2);
    drawTimeAxis(pitchCtx, w, h, plotH, windowStart, windowEnd);
    return;
  }

  // vertical range: center on the data, pad by a few semitones
  let minN = Math.min(...recent.map(p => p.noteNum));
  let maxN = Math.max(...recent.map(p => p.noteNum));
  minN = Math.floor(minN) - 2;
  maxN = Math.ceil(maxN) + 2;
  const span = Math.max(maxN - minN, 4);

  const yFor = n => plotH - ((n - minN) / span) * plotH;
  const xFor = t => ((t - windowStart) / (windowEnd - windowStart)) * w;

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

  drawTimeAxis(pitchCtx, w, h, plotH, windowStart, windowEnd);
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
