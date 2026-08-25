#!/usr/bin/env python3
"""
Serveur local pour l'analyseur de justesse.

Sert la page HTML et expose une petite API que la page appelle après chaque
enregistrement pour sauvegarder le JSON sur disque et lancer analyse_pitch.py
dessus. Ne contient aucune logique d'analyse elle-même — tout ça reste dans
analyse_pitch.py, ce fichier ne fait que l'appeler et gérer le disque/HTTP.

Usage: python server.py   (ou double-clic sur run_server.bat)
"""
import contextlib
import io
import json
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

import analyse_pitch

BASE_DIR = Path(__file__).resolve().parent
HTML_FILE = "index.html"
HOST = "127.0.0.1"
PORT = 5000

app = Flask(__name__)


def save_and_analyze(payload, filename):
    path = BASE_DIR / filename
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    report_text, error = None, None
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            analyse_pitch.report(str(path))
        report_text = buf.getvalue()
    except Exception as e:
        error = str(e)

    return {"saved_to": str(path), "report": report_text, "error": error}


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, HTML_FILE)


@app.route("/api/save-sample", methods=["POST"])
def save_sample():
    return jsonify(save_and_analyze(request.get_json(force=True), "json_last_sample.json"))


@app.route("/api/save-curve", methods=["POST"])
def save_curve():
    return jsonify(save_and_analyze(request.get_json(force=True), "json_last_sample_curve.json"))


if __name__ == "__main__":
    print(f"Analyseur de justesse — http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False)
