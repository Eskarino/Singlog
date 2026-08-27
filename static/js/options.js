// Central toggle state for the options menu. Read by main.js (smoothing,
// octave-continuity) and analyse.js (portamento/vibrato exclusion from
// stats) — kept here instead of inside those files so pitch-detection.js
// stays a pure algorithm with no notion of user-facing settings.
const options = {
  smoothing: true,
  octaveContinuity: true,
  ignorePortamento: true,
  ignoreVibrato: true,
};

function bindOption(id, key){
  const el = document.getElementById(id);
  el.checked = options[key];
  el.addEventListener('change', () => { options[key] = el.checked; });
}

bindOption('optSmoothing', 'smoothing');
bindOption('optOctaveContinuity', 'octaveContinuity');
bindOption('optIgnorePortamento', 'ignorePortamento');
bindOption('optIgnoreVibrato', 'ignoreVibrato');

// Tap-to-open info bubbles: no hover reliance since this menu is mainly used
// on phones. Only one open at a time, closes on any tap outside it.
document.querySelectorAll('.option-row .info-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = btn.closest('.option-row');
    const wasOpen = row.classList.contains('tooltip-open');
    document.querySelectorAll('.option-row.tooltip-open').forEach(r => r.classList.remove('tooltip-open'));
    if (!wasOpen) row.classList.add('tooltip-open');
  });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.option-row.tooltip-open').forEach(r => r.classList.remove('tooltip-open'));
});
