# Voice Analyzer

Analyseur de justesse vocale en temps réel. Détection de hauteur par
autocorrélation et analyse post-session (segments, glitches, stats), le tout
entièrement en JS dans le navigateur. Site statique pur : aucun backend,
aucune dépendance externe hormis la police Google Fonts.

## Fichiers

- `index.html` — structure de la page (UI : contrôles, jauge, canvases,
  stats, footer). Charge `static/style.css` et les scripts de `static/js/`.
- `static/style.css` — tout le CSS (thème, jauge, canvases, stats).
- `static/js/` — logique front-end en JS vanilla, en scripts globaux classiques
  (pas de modules, pas de bundler) chargés dans cet ordre par `index.html` :
  - `pitch-detection.js` — algo pur : autocorrélation (ACF2+), lissage médian,
    continuité d'octave. Aucun accès DOM.
  - `visualization.js` — dessin des canvases (historique, courbe de hauteur,
    spectre) et l'axe des temps partagé.
  - `replay.js` — enregistrement audio brut (MediaRecorder) et relecture du
    dernier sample.
  - `analyse.js` — bouton "Analyser la session" : segmentation par silences,
    détection de glitches isolés, nettoyage médian, stats en cents. Tourne
    entièrement sur `sessionLog`, aucun appel réseau.
  - `main.js` — orchestration : état partagé (`history`, `sessionLog`,
    `audioCtx`...), démarrage/arrêt du micro, boucle `requestAnimationFrame`.
  Ces fichiers partagent le scope global (comme dans une seule balise
  `<script>`) — l'ordre de chargement dans `index.html` doit rester cohérent
  avec les dépendances entre fichiers.

## Lancer l'app

Ouvrir `index.html` dans un navigateur, ou le servir avec n'importe quel
serveur statique (Live Server, `python -m http.server`, ou directement
l'hébergement final). Aucune installation, aucun backend requis.

## Architecture : pourquoi tout est en JS

- La capture micro et la détection de pitch en temps réel (Web Audio API)
  n'ont jamais pu être ailleurs que côté navigateur — c'est la seule partie
  qui a accès au flux micro en direct.
- L'analyse post-session (segments, glitches, stats globales) a d'abord été
  écrite en Python (plus simple à prototyper), puis portée en JS pour que
  l'app tourne entièrement sur un hébergement statique bon marché (objectif :
  OVH), sans backend à maintenir ni langage serveur à faire tourner.
