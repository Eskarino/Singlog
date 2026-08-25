#!/usr/bin/env python3
"""
Analyse un export JSON de l'analyseur de justesse (courbe continue ou export complet).
Usage: python3 analyse_pitch.py fichier.json
"""
import json, sys, statistics as st

def load(path):
    data = json.load(open(path))
    readings = data["readings"]
    # normalise: certains exports ont "noteNum", d'autres seulement "cents"/"note"
    for r in readings:
        if "noteNum" not in r and "note" in r:
            pass  # pas de courbe continue dispo, segmentation seule possible
    return readings

def segments(readings, gap=0.15):
    segs, cur = [], [readings[0]]
    for r in readings[1:]:
        if r["t"] - cur[-1]["t"] > gap:
            segs.append(cur); cur = [r]
        else:
            cur.append(r)
    segs.append(cur)
    return segs

def find_glitches(readings, threshold=4):
    """Sauts isolés : >threshold demi-tons des DEUX voisins proches en temps."""
    out = []
    for i in range(1, len(readings) - 1):
        a, b, c = readings[i - 1], readings[i], readings[i + 1]
        if "noteNum" not in b: continue
        if b["t"] - a["t"] < 0.1 and c["t"] - b["t"] < 0.1:
            if abs(b["noteNum"] - a["noteNum"]) > threshold and abs(b["noteNum"] - c["noteNum"]) > threshold:
                out.append(b)
    return out

def clean(readings, window=4, threshold=6):
    """Retire les points dont noteNum s'écarte de la médiane locale (artefacts de lissage)."""
    if not readings or "noteNum" not in readings[0]:
        return readings
    vals = [r["noteNum"] for r in readings]
    result = []
    for i, r in enumerate(readings):
        lo, hi = max(0, i - window), min(len(readings), i + window + 1)
        med = st.median(vals[lo:hi])
        if abs(r["noteNum"] - med) <= threshold:
            result.append(r)
    return result

def report(path):
    readings = load(path)
    print(f"{len(readings)} lectures, {readings[-1]['t']:.1f}s")

    if "noteNum" in readings[0]:
        glitches = find_glitches(readings)
        print(f"\nGlitches isolés détectés : {len(glitches)}")
        for g in glitches:
            print(f"  t={g['t']:.2f}  freq={g['freq_hz']:.1f}Hz  noteNum={g['noteNum']:.2f}")

        cleaned = clean(readings)
        if len(cleaned) < len(readings):
            print(f"({len(readings) - len(cleaned)} points retirés par nettoyage médian avant les stats)")

        for seg in segments(cleaned):
            vals = [p["noteNum"] for p in seg]
            print(f"t=[{seg[0]['t']:.2f}-{seg[-1]['t']:.2f}] n={len(seg):3d}  "
                  f"mean={st.mean(vals):6.2f}  range={max(vals)-min(vals):5.2f}  sd={st.pstdev(vals):5.2f}")

        def to_cents(n):
            r = round(n); return (n - r) * 100
        cents = [to_cents(p["noteNum"]) for p in cleaned]
    else:
        cents = [r["cents"] for r in readings if r.get("cents") is not None]
        for seg in segments(readings):
            vals = [p["cents"] for p in seg if p.get("cents") is not None]
            if not vals: continue
            print(f"t=[{seg[0]['t']:.2f}-{seg[-1]['t']:.2f}] n={len(vals):3d}  "
                  f"mean={st.mean(vals):6.1f}c  sd={st.pstdev(vals):5.1f}c")

    print(f"\n--- Stats globales ---")
    print(f"mean: {st.mean(cents):.1f}c   mean abs: {st.mean([abs(c) for c in cents]):.1f}c   sd: {st.pstdev(cents):.1f}c")
    for th in (10, 15, 25):
        pct = sum(1 for c in cents if abs(c) <= th) / len(cents) * 100
        print(f"% dans ±{th}c: {pct:.1f}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 analyse_pitch.py fichier.json"); sys.exit(1)
    report(sys.argv[1])
