# Voice Analyzer

Analyseur de justesse vocale en temps réel. Détection de hauteur par
autocorrélation dans le navigateur, plus une étape d'analyse post-session
(segments, glitches, stats) côté Python.

## Fichiers

- `index.html` — structure de la page (UI : contrôles, jauge, canvases,
  stats, footer). Charge `static/style.css` et `static/app.js`.
- `static/style.css` — tout le CSS (thème, jauge, canvases, stats). Aucune
  dépendance externe hormis la police Google Fonts.
- `static/app.js` — toute la logique front-end en JS vanilla : capture micro,
  détection de pitch par autocorrélation, dessin jauge/historique/spectre/
  courbe de hauteur, export JSON, replay. Servi tel quel, aucun bundler.
- `server.py` — petit serveur Flask. Sert `index.html` (et `static/` via le
  serveur de fichiers statiques par défaut de Flask) et expose l'API que la page
  appelle pour sauvegarder un export sur disque et lancer l'analyse dessus.
  Ne contient aucune logique d'analyse : il appelle `analyse_pitch.py`.
- `analyse_pitch.py` — script d'analyse pur (segmentation par silences,
  détection de glitches isolés, nettoyage médian, stats en cents). Utilisable
  seul en CLI (`python analyse_pitch.py fichier.json`) ou importé par
  `server.py`. Ne rien y ajouter qui dépende de Flask/HTTP — il doit rester
  autonome et testable en ligne de commande.
- `run_server.bat` — lanceur double-clic : installe Flask si besoin, démarre
  `server.py`, ouvre `http://127.0.0.1:5000` dans le navigateur.

## Lancer l'app

Double-clic sur `run_server.bat`, ou :

```
python server.py
```

puis ouvrir `http://127.0.0.1:5000`. La page doit être servie depuis ce
serveur (pas ouverte en double-clic direct) pour que les boutons
d'enregistrement passent par l'API — sinon ils retombent automatiquement sur
un téléchargement navigateur classique (voir `saveViaApiOrDownload` dans le
HTML).

## Architecture : pourquoi ce découpage

- La capture micro et la détection de pitch en temps réel (Web Audio API)
  doivent rester côté navigateur — c'est la seule partie qui a accès au flux
  micro en direct. Ça ne migrera jamais côté Python.
- L'analyse post-session (segments, glitches, stats globales) est en Python
  pur dans `analyse_pitch.py`, complètement indépendante du serveur, pour
  pouvoir être relancée à la main sur n'importe quel export JSON.
- `server.py` est la seule couche qui touche à Flask/HTTP/disque. Il fait le
  pont : reçoit le JSON de la page, l'écrit dans le dossier du projet
  (`json_last_sample.json` / `json_last_sample_curve.json`), appelle
  `analyse_pitch.report()` en capturant sa sortie, et renvoie le tout à la
  page pour affichage.

## API

- `POST /api/save-sample` — body : export JSON standard (`readings` avec
  `note`/`freq_hz`/`cents`). Sauvegarde dans `json_last_sample.json`.
- `POST /api/save-curve` — body : export courbe continue (`readings` avec
  `noteNum` en demi-tons). Sauvegarde dans `json_last_sample_curve.json`.
- Les deux renvoient `{ saved_to, report, error }` — `report` est le texte
  généré par `analyse_pitch.report()`, affiché tel quel dans la page.
