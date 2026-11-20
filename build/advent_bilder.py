#!/usr/bin/env python3
"""Adventskalender: alte, gemeinfreie Weihnachtspostkarten von Wikimedia Commons holen,
auf die Vorderseite zuschneiden, in Graustufen umwandeln und nach _site/advent/ legen.
Schon geholte Bilder liegen im Actions-Cache (state/advent/) und werden nicht nochmals geladen."""

import io, json, os, shutil, sys, time, urllib.parse, urllib.request
from PIL import Image, ImageOps

HIER = os.path.dirname(os.path.abspath(__file__))
WURZEL = os.path.dirname(HIER)
CACHE = os.path.join(WURZEL, "state", "advent")
ZIEL = os.path.join(WURZEL, "_site", "advent")
UA = "tolino-dashboard/1.0 (privates Familien-Dashboard; GitHub Actions)"

os.makedirs(CACHE, exist_ok=True)
os.makedirs(ZIEL, exist_ok=True)
bilder = json.load(open(os.path.join(HIER, "advent.json"), encoding="utf-8"))
fehler = 0
for b in bilder:
    name = f"{b['tag']:02d}.jpg"
    pfad = os.path.join(CACHE, name)
    if not os.path.exists(pfad):
        url = "https://commons.wikimedia.org/wiki/Special:FilePath/" + urllib.parse.quote(b["datei"]) + "?width=1280"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                bild = Image.open(io.BytesIO(r.read()))
            bild.load()
            x, y, w, h = b["ausschnitt"]
            W, H = bild.size
            bild = bild.crop((round(x * W), round(y * H), round((x + w) * W), round((y + h) * H)))
            bild = ImageOps.autocontrast(ImageOps.grayscale(bild), cutoff=1)
            bild.thumbnail((900, 900))
            bild.save(pfad, "JPEG", quality=82, optimize=True)
            print(f"{name}: geholt ({bild.size[0]}×{bild.size[1]})")
            time.sleep(1)  # Wikimedia schonen
        except Exception as e:
            fehler += 1
            print(f"{name}: nicht geholt – {e}", file=sys.stderr)
            continue
    shutil.copy(pfad, os.path.join(ZIEL, name))
print(f"Adventsbilder bereit, {fehler} Fehler")
