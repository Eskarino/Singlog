const analyseBtn = document.getElementById('analyseBtn');
const analyseStatus = document.getElementById('analyseStatus');
const analyseReport = document.getElementById('analyseReport');

// Looks for a few objective, describable patterns in the session (drift
// while holding a note, regular oscillation/vibrato, overall sharp/flat
// bias) instead of dumping raw per-note stats — entirely client-side on
// sessionLog, no network call, so this works on plain static hosting.

function mean(arr){ return arr.reduce((s,v) => s + v, 0) / arr.length; }
function pstdev(arr){ const m = mean(arr); return Math.sqrt(mean(arr.map(v => (v - m) ** 2))); }
function median(arr){
  const s = [...arr].sort((a,b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Least-squares slope of ys against xs.
function linregress(xs, ys){
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++){ num += (xs[i]-mx)*(ys[i]-my); den += (xs[i]-mx)**2; }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope*mx };
}

// Groups consecutive readings into one run per actually-held note: a new
// group starts at a silence gap (a breath) OR whenever the nearest semitone
// changes — so several notes sung back-to-back without a pause each get
// analyzed separately instead of being averaged together into one
// meaningless blob (their mean/spread would just reflect the melody).
function groupIntoNotes(readings, gap = 0.15){
  const groups = [];
  let cur = [readings[0]];
  let curRounded = Math.round(readings[0].noteNum);
  for (let i = 1; i < readings.length; i++){
    const r = readings[i];
    const rounded = Math.round(r.noteNum);
    if (r.t - cur[cur.length - 1].t > gap || rounded !== curRounded){
      groups.push(cur);
      cur = [r];
      curRounded = rounded;
    } else {
      cur.push(r);
    }
  }
  groups.push(cur);
  return groups;
}

// Drops points whose noteNum strays too far from the local median — smoothing
// artifacts rather than real pitch, kept out of the stats below.
function cleanMedian(readings, window = 4, threshold = 6){
  const vals = readings.map(r => r.noteNum);
  const result = [];
  for (let i = 0; i < readings.length; i++){
    const lo = Math.max(0, i - window), hi = Math.min(readings.length, i + window + 1);
    const med = median(vals.slice(lo, hi));
    if (Math.abs(readings[i].noteNum - med) <= threshold) result.push(readings[i]);
  }
  return result;
}

function toCents(noteNum){
  const rounded = Math.round(noteNum);
  return (noteNum - rounded) * 100;
}

const TRANSITION_WINDOW_SECONDS = 0.15; // local window (each side) used to judge held-vs-gliding pitch
// Total peak-to-trough range (max-min, not +/-) allowed within that window for a
// point to still count as "held". Sized around +/-35c (natural vibrato/jitter
// commonly swings +/-15-25c) so a real held note doesn't get misread as a
// portamento just for wobbling normally.
const HELD_BAND_CENTS = 70;

// For each reading, looks at a small time-window around it and checks how far
// the actual (continuous, unrounded) pitch moved — a real held note stays
// inside a narrow band even with vibrato, while a portamento/glissando sweeps
// well past it. Flagging these lets the stats below skip the glide instead of
// scoring it as pitch instability.
function classifyTransitions(readings, windowSec = TRANSITION_WINDOW_SECONDS, bandCents = HELD_BAND_CENTS){
  return readings.map((r, i) => {
    let lo = i, hi = i;
    while (lo > 0 && r.t - readings[lo - 1].t <= windowSec) lo--;
    while (hi < readings.length - 1 && readings[hi + 1].t - r.t <= windowSec) hi++;
    const local = readings.slice(lo, hi + 1).map(p => p.noteNum);
    const rangeCents = (Math.max(...local) - Math.min(...local)) * 100;
    return rangeCents > bandCents;
  });
}

const MIN_NOTE_FRAMES = 6; // ~100-200ms depending on frame rate — shorter runs are transitions, not held notes
const DRIFT_MIN_TOTAL_CENTS = 8; // net pitch change over the note's duration to call it "drift" rather than noise
const VIBRATO_MIN_AMP_CENTS = 8; // below this, it's measurement jitter, not an audible wobble
const VIBRATO_RATE_MIN_HZ = 2.5, VIBRATO_RATE_MAX_HZ = 9; // plausible range for vocal vibrato/wobble
const VIBRATO_MAX_INTERVAL_CV = 0.5; // how regular the oscillation must be (coefficient of variation of half-cycle lengths)

// For one held note: fits a trend line to its cents-deviation-from-pitch
// over time (drift), then looks at what's left after removing that trend
// (residual) for a regular back-and-forth oscillation (vibrato) via
// zero-crossings — a real vibrato crosses its own mean at a fairly steady
// rate, unlike random jitter.
function analyzeNote(note){
  const ts = note.map(p => p.t);
  const cents = note.map(p => toCents(p.noteNum));
  const duration = ts[ts.length - 1] - ts[0];

  const { slope, intercept } = linregress(ts, cents); // cents per second
  const totalDrift = slope * duration;
  const residual = ts.map((t,i) => cents[i] - (slope*t + intercept));

  const crossingTimes = [];
  for (let i = 1; i < residual.length; i++){
    if ((residual[i-1] < 0 && residual[i] >= 0) || (residual[i-1] > 0 && residual[i] <= 0)){
      crossingTimes.push(ts[i]);
    }
  }

  // Amplitude of what's left after the drift trend is removed — computed
  // regardless of regularity, so a wobble that fails the vibrato-regularity
  // test below isn't just silently dropped (that used to leave no signal at
  // all to distinguish a rock-steady note from an uncontrolled shaky one).
  const ampCents = pstdev(residual) * Math.SQRT2; // RMS -> amplitude estimate for a roughly sinusoidal wobble

  let vibrato = null;
  if (crossingTimes.length >= 4){
    const intervals = [];
    for (let i = 1; i < crossingTimes.length; i++) intervals.push(crossingTimes[i] - crossingTimes[i-1]);
    const meanInterval = mean(intervals);
    const cv = pstdev(intervals) / meanInterval;
    const rateHz = 1 / (2 * meanInterval); // two half-cycles (crossings) per full oscillation
    if (cv < VIBRATO_MAX_INTERVAL_CV && rateHz >= VIBRATO_RATE_MIN_HZ && rateHz <= VIBRATO_RATE_MAX_HZ && ampCents >= VIBRATO_MIN_AMP_CENTS){
      vibrato = { rateHz, ampCents };
    }
  }

  // A wobble big enough to hear but too irregular/wrong-rate to be a
  // controlled vibrato is a real stability issue (usually breath support),
  // not a technique — keep it as its own category rather than lumping it
  // in with "no vibrato found".
  const instability = (!vibrato && ampCents >= VIBRATO_MIN_AMP_CENTS) ? { ampCents } : null;

  return { n: note.length, duration, totalDrift, vibrato, instability };
}

function buildReport(readings){
  const lines = [];
  lines.push(`${readings.length} lectures, ${readings[readings.length - 1].t.toFixed(1)}s`);

  const cleaned = cleanMedian(readings);
  if (cleaned.length === 0){
    lines.push('', 'Pas assez de points stables pour calculer des stats.');
    return lines.join('\n');
  }
  if (cleaned.length < readings.length){
    lines.push(`(${readings.length - cleaned.length} points retirés par nettoyage médian avant les stats)`);
  }

  // Portamento/transition filtering: only points that look like an actually
  // held pitch feed the note grouping and stats below — a glide between
  // notes shouldn't count as pitch instability just because it crosses
  // several semitones quickly.
  let heldReadings = cleaned;
  if (options.ignorePortamento){
    const transitionFlags = classifyTransitions(cleaned);
    heldReadings = cleaned.filter((_, i) => !transitionFlags[i]);
    const transitionCount = transitionFlags.filter(Boolean).length;
    if (transitionCount > 0){
      lines.push(`(${transitionCount} points identifiés comme portamento/transition, exclus des stats de justesse)`);
    }
    if (heldReadings.length === 0) heldReadings = cleaned; // whole take was gliding — fall back rather than report nothing
  }

  const noteGroups = heldReadings.length ? groupIntoNotes(heldReadings) : [];
  const analyzed = noteGroups.map(group => ({ group, stats: analyzeNote(group) }));
  const notes = analyzed.map(a => a.stats).filter(a => a.n >= MIN_NOTE_FRAMES);

  // Vibrato exclusion: notes with a clearly detected, regular vibrato aren't
  // dropped from the report, but their oscillation shouldn't drag down the
  // global justesse stats below — that's the "controlled artistic choice,
  // not an error" distinction the option is meant to express.
  let globalReadings = heldReadings;
  if (options.ignoreVibrato){
    globalReadings = analyzed.flatMap(a => (a.stats.vibrato && a.stats.n >= MIN_NOTE_FRAMES) ? [] : a.group);
    if (globalReadings.length === 0) globalReadings = heldReadings;
    if (globalReadings.length < heldReadings.length){
      lines.push(`(${heldReadings.length - globalReadings.length} points sur notes avec vibrato détecté, exclus des stats de justesse globale)`);
    }
  }

  const cents = globalReadings.map(p => toCents(p.noteNum));

  // Classify each pattern once here; both the "Conseils" and "Tendances"
  // sections below read from these same results instead of re-deriving them.
  const bias = mean(cents);
  const biasSignificant = Math.abs(bias) >= 5;
  const biasDirection = bias > 0 ? 'haut' : 'bas';

  let driftDirection = null, driftCount = 0;
  let instabilityNotes = [], vibratoNotes = [];
  let majority = 0;
  if (notes.length > 0){
    majority = Math.max(2, Math.ceil(notes.length * 0.3));
    const drifting = notes.filter(nt => Math.abs(nt.totalDrift) >= DRIFT_MIN_TOTAL_CENTS);
    const up = drifting.filter(nt => nt.totalDrift > 0).length;
    const down = drifting.filter(nt => nt.totalDrift < 0).length;
    if (up >= majority && up > down){ driftDirection = 'up'; driftCount = up; }
    else if (down >= majority && down > up){ driftDirection = 'down'; driftCount = down; }

    instabilityNotes = notes.filter(nt => nt.instability);
    if (instabilityNotes.length < majority) instabilityNotes = [];
    vibratoNotes = notes.filter(nt => nt.vibrato);
    if (vibratoNotes.length < majority) vibratoNotes = [];
  }

  // --- Conseils ---
  const tips = [];
  if (biasSignificant){
    tips.push(biasDirection === 'haut'
      ? "Tu chantes globalement trop haut : essaie de moins pousser le son, détends la mâchoire et le larynx plutôt que de forcer vers l'aigu."
      : "Tu chantes globalement trop bas : renforce le soutien de ta respiration — l'air doit porter activement la note plutôt que de la laisser retomber.");
  }
  if (driftDirection === 'up'){
    tips.push("Ta hauteur monte en cours de note tenue : garde un débit d'air constant, évite de pousser de plus en plus fort vers la fin de la note.");
  } else if (driftDirection === 'down'){
    tips.push("Ta hauteur descend en cours de note tenue : tiens le soutien respiratoire jusqu'au bout, ne le relâche pas avant la fin de la note.");
  }
  if (instabilityNotes.length > 0){
    tips.push("Ta hauteur est irrégulière sur certaines notes tenues (pas un vibrato régulier) : travaille le soutien du souffle — tiens une voyelle stable sur des notes longues pour muscler ça.");
  }
  lines.push('', '--- Conseils ---');
  if (tips.length > 0){
    lines.push(...tips);
  } else {
    lines.push("Rien de particulier à corriger sur cette session — continue comme ça.");
  }

  lines.push('', '--- Tendances ---');

  if (biasSignificant){
    lines.push(`Justesse globale : tu chantes en moyenne ${Math.abs(bias).toFixed(1)}c trop ${biasDirection}.`);
  } else {
    lines.push("Justesse globale : stable, pas de biais net.");
  }

  if (notes.length === 0){
    lines.push("Pas assez de notes tenues assez longtemps pour analyser dérive, stabilité ou vibrato.");
  } else {
    if (driftDirection === 'up'){
      lines.push(`Dérive : ta hauteur a tendance à monter en cours de note (${driftCount}/${notes.length} notes tenues touchées).`);
    } else if (driftDirection === 'down'){
      lines.push(`Dérive : ta hauteur a tendance à descendre en cours de note (${driftCount}/${notes.length} notes tenues touchées).`);
    } else {
      lines.push("Dérive : pas de tendance systématique à monter/descendre sur les notes tenues.");
    }

    if (instabilityNotes.length > 0){
      const avgAmp = mean(instabilityNotes.map(nt => nt.instability.ampCents));
      lines.push(
        `Stabilité : hauteur irrégulière (pas un vibrato régulier) sur ${instabilityNotes.length}/${notes.length} notes tenues ` +
        `(~${avgAmp.toFixed(0)}c) — souvent lié à un manque de soutien du souffle.`
      );
    } else {
      lines.push("Stabilité : notes tenues globalement stables.");
    }

    if (vibratoNotes.length > 0){
      const avgRate = mean(vibratoNotes.map(nt => nt.vibrato.rateHz));
      const avgAmp = mean(vibratoNotes.map(nt => nt.vibrato.ampCents));
      lines.push(
        `Vibrato : oscillation régulière détectée sur ${vibratoNotes.length}/${notes.length} notes tenues ` +
        `(~${avgRate.toFixed(1)}Hz, ~${avgAmp.toFixed(0)}c d'amplitude) — volontaire ou pas, à toi de juger.`
      );
    } else {
      lines.push("Vibrato : pas d'oscillation régulière marquée.");
    }
  }

  lines.push('', '--- Stats globales ---');
  lines.push(`mean: ${mean(cents).toFixed(1)}c   mean abs: ${mean(cents.map(Math.abs)).toFixed(1)}c   sd: ${pstdev(cents).toFixed(1)}c`);
  for (const th of [10, 15, 25]){
    const pct = cents.filter(c => Math.abs(c) <= th).length / cents.length * 100;
    lines.push(`% dans ±${th}c: ${pct.toFixed(1)}`);
  }

  return lines.join('\n');
}

analyseBtn.addEventListener('click', () => {
  const voicedOnly = sessionLog.filter(e => !e.silent && e.noteNum != null);
  if (voicedOnly.length === 0){
    analyseStatus.textContent = "Rien à analyser — chante quelque chose d'abord.";
    analyseReport.classList.remove('visible');
    return;
  }

  const readings = voicedOnly.map(e => ({ t: e.t, freq: e.freq, noteNum: e.noteNum }));
  analyseStatus.textContent = `Analyse de ${readings.length} points, ${readings[readings.length - 1].t.toFixed(1)}s.`;
  analyseReport.textContent = buildReport(readings);
  analyseReport.classList.add('visible');
});
