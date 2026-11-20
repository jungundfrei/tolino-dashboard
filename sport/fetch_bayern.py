#!/usr/bin/env python3
"""
FC Bayern für TRMNL

Zwei Bereiche: Bundesliga und Champions League – je nächstes Spiel, letztes
Spiel und ein kleiner Tabellenausschnitt. Oben die Form aus allen Wettbewerben.

Daten: football-data.org (Spiele, Tabellen, Wappen) und OpenLigaDB
(Torschützen der Bundesliga-Spiele). Versand per Webhook an ein privates
TRMNL-Plugin.

Umgebungsvariablen:
  FOOTBALL_DATA_TOKEN  API-Token von football-data.org (gratis)
  TRMNL_WEBHOOK_URL    Webhook-URL des privaten TRMNL-Plugins

Aufruf:
  python fetch_bayern.py            # Daten holen und an TRMNL senden
  python fetch_bayern.py --dry-run  # nur das JSON anzeigen, nichts senden
"""
import json
import os
import sys
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

API = "https://api.football-data.org/v4"
TEAM_ID = 5  # FC Bayern München bei football-data.org
TZ = ZoneInfo("Europe/Zurich")
TAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
LIVE = {"IN_PLAY", "PAUSED", "LIVE"}
OFFEN = {"SCHEDULED", "TIMED"} | LIVE
NAMEN = {TEAM_ID: "FC Bayern"}
TABELLEN_ZEILEN = 6   # Bundesliga-Ausschnitt, Bayern möglichst mittig
TOPSKORER = 4         # Bayern-Spieler in der Topskorer-Liste
WAPPEN_PREFIX = "https://crests.football-data.org/"
OPENLIGA = "https://api.openligadb.de"
OPENLIGA_BAYERN = 40  # FC Bayern bei OpenLigaDB
PARTIKEL = {"de", "van", "von", "der", "di", "da", "ter", "le", "dos"}
MAX_PAYLOAD = 2000    # Bytes; Webhook-Limit bei TRMNL (TRMNL+ erlaubt mehr)

# Rückennummern: football-data liefert sie oft gar nicht oder veraltet.
# Diese Liste hat Vorrang – bitte bei Kaderwechseln auf fcbayern.com prüfen.
# Schlüssel = Nachname wie auf dem Display (Gross/Klein und Akzente egal).
RUECKENNUMMERN = {
    "Neuer": 1, "Upamecano": 2, "Kim": 3, "Tah": 4, "Kimmich": 6,
    "Gnabry": 7, "Goretzka": 8, "Kane": 9, "Musiala": 10, "Jackson": 11,
    "Díaz": 14, "Olise": 17, "Davies": 19, "Guerreiro": 22,
    "Laimer": 27, "Karl": 42, "Pavlović": 45,
}

RUNDEN = {
    "PLAYOFFS": "Playoffs",
    "LAST_16": "Achtelfinal",
    "QUARTER_FINALS": "Viertelfinal",
    "SEMI_FINALS": "Halbfinal",
    "FINAL": "Final",
}


# ---------------------------------------------------------------- Helfer

def api(pfad, token, **params):
    r = requests.get(f"{API}{pfad}", headers={"X-Auth-Token": token},
                     params=params, timeout=20)
    r.raise_for_status()
    return r.json()


# Kurznamen von football-data, die als Spitzname daherkommen -> lesbarer Name.
# Bei Bedarf einfach ergänzen: "Kurzname laut API": "Anzeige".
KURZNAMEN = {
    "Atleti": "Atlético Madrid",
}


def teamname(team):
    name = (NAMEN.get(team.get("id")) or team.get("shortName")
            or team.get("name") or "?")
    return KURZNAMEN.get(name, name)


def wappen(team):
    """Wappen-Dateiname kurz ("86.png"); das Template setzt den Pfad davor."""
    url = team.get("crest") or ""
    return url[len(WAPPEN_PREFIX):] if url.startswith(WAPPEN_PREFIX) else ""


def anstoss(m):
    return datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00")).astimezone(TZ)


def code(m):
    return (m.get("competition") or {}).get("code")


def bayern_heim(m):
    return m["homeTeam"].get("id") == TEAM_ID


def gegner_team(m):
    return m["awayTeam"] if bayern_heim(m) else m["homeTeam"]


def runde(m):
    if m.get("stage") in RUNDEN:
        return RUNDEN[m["stage"]]
    if m.get("matchday"):
        return f"{m['matchday']}. Spieltag"
    return ""


def datum(dt):
    return f"{TAGE[dt.weekday()]} {dt.day}.{dt.month}."


def countdown(dt, jetzt):
    tage = (dt.date() - jetzt.date()).days
    if tage <= 0:
        return "heute"
    if tage == 1:
        return "morgen"
    return f"in {tage} Tagen"


def tore(m):
    """Tore aus Bayern-Sicht (eigene, gegner) plus Zusatz n.V./n.E."""
    s = m.get("score") or {}
    zusatz = {"EXTRA_TIME": " n.V.", "PENALTY_SHOOTOUT": " n.E."}.get(s.get("duration"), "")
    reg = s.get("regularTime")
    if reg and reg.get("home") is not None:
        ext = s.get("extraTime") or {}
        h = reg["home"] + (ext.get("home") or 0)
        a = reg["away"] + (ext.get("away") or 0)
    else:
        ft = s.get("fullTime") or {}
        h, a = ft.get("home"), ft.get("away")
    if h is None or a is None:
        return None, None, zusatz
    return (h, a, zusatz) if bayern_heim(m) else (a, h, zusatz)


def resultat(m):
    """S / U / N aus Bayern-Sicht."""
    winner = (m.get("score") or {}).get("winner")
    if winner == "DRAW":
        return "U"
    if winner in ("HOME_TEAM", "AWAY_TEAM"):
        return "S" if (winner == "HOME_TEAM") == bayern_heim(m) else "N"
    eigene, fremde, _ = tore(m)
    if eigene is None:
        return "?"
    return "S" if eigene > fremde else "N" if eigene < fremde else "U"


def saison(jetzt):
    return jetzt.year if jetzt.month >= 7 else jetzt.year - 1


# ---------------------------------------------------------------- Spiele

def naechstes_spiel(m, jetzt):
    dt = anstoss(m)
    d = {
        "heim": teamname(m["homeTeam"]),
        "gast": teamname(m["awayTeam"]),
        "hw": wappen(m["homeTeam"]),
        "gw": wappen(m["awayTeam"]),
        "runde": runde(m),
        "datum": datum(dt),
        # SCHEDULED = Anstosszeit noch nicht fixiert
        "zeit": "Zeit offen" if m.get("status") == "SCHEDULED" else dt.strftime("%H:%M"),
    }
    if m.get("status") in LIVE:
        eigene, fremde, _ = tore(m)
        h, a = (eigene, fremde) if bayern_heim(m) else (fremde, eigene)
        d["live"] = True
        d["stand"] = f"{h or 0}:{a or 0}"  # Heim:Gast, passend zur Anzeige
    return d


def letztes_spiel(m):
    eigene, fremde, zusatz = tore(m)
    return {
        "gegner": teamname(gegner_team(m)),
        "ow": wappen(gegner_team(m)),
        "ort": "vs" if bayern_heim(m) else "@",
        "runde": runde(m),
        "datum": datum(anstoss(m)),
        "ergebnis": f"{eigene}:{fremde}{zusatz}" if eigene is not None else "–",
        "res": resultat(m),
    }


# ---------------------------------------------------------------- Tabelle

def tabelle(standings):
    """Ausschnitt um Bayern; sucht in allen Gesamttabellen (Ligaphase/Gruppen)."""
    for s in standings.get("standings", []):
        if s.get("type") != "TOTAL":
            continue
        zeilen = s.get("table") or []
        i = next((k for k, z in enumerate(zeilen)
                  if (z.get("team") or {}).get("id") == TEAM_ID), None)
        if i is None:
            continue
        start = max(0, min(i - (TABELLEN_ZEILEN - 1) // 2, len(zeilen) - TABELLEN_ZEILEN))
        out = []
        # Kurze Schlüssel: 12 Zeilen müssen unter das 2-KB-Webhook-Limit passen.
        # Die Bayern-Zeile erkennt das Template an p == platz.
        for z in zeilen[start:start + TABELLEN_ZEILEN]:
            td = z.get("goalDifference", 0)
            out.append({
                "p": z["position"],
                "t": teamname(z["team"]),
                "w": wappen(z["team"]),
                "d": f"+{td}" if td > 0 else str(td),
                "k": z.get("points", 0),
            })
        return out, zeilen[i]
    return [], None


# ---------------------------------------------------------------- Torschützen

def nachname(name):
    """'Harry Kane' -> 'Kane', 'Matthijs de Ligt' -> 'de Ligt'."""
    teile = (name or "").split()
    if len(teile) < 2:
        return name or "?"
    if len(teile) >= 3 and teile[-2].lower() in PARTIKEL:
        return " ".join(teile[-2:])
    return teile[-1]


def openliga_tore(m):
    """Tore eines Bundesliga-Spiels von OpenLigaDB, in Spielreihenfolge."""
    if code(m) != "BL1" or not m.get("matchday"):
        return None
    s = saison(anstoss(m))
    r = requests.get(f"{OPENLIGA}/getmatchdata/bl1/{s}/{m['matchday']}", timeout=20)
    r.raise_for_status()
    for sp in r.json():
        t1 = (sp.get("team1") or {}).get("teamId")
        t2 = (sp.get("team2") or {}).get("teamId")
        if OPENLIGA_BAYERN not in (t1, t2):
            continue
        bayern_ist_team1 = t1 == OPENLIGA_BAYERN
        liste, vorher = [], (0, 0)
        goals = sorted(sp.get("goals") or [],
                       key=lambda g: (g.get("scoreTeam1") or 0) + (g.get("scoreTeam2") or 0))
        for g in goals:
            stand = (g.get("scoreTeam1") or 0, g.get("scoreTeam2") or 0)
            team1_traf = stand[0] > vorher[0]  # welcher Zähler ist gestiegen?
            vorher = stand
            liste.append({
                "name": nachname(g.get("goalGetterName")),
                "min": g.get("matchMinute"),
                "bayern": team1_traf == bayern_ist_team1,
                "et": bool(g.get("isOwnGoal")),
                "elf": bool(g.get("isPenalty")),
                "stand": stand if bayern_ist_team1 else stand[::-1],
            })
        return liste
    return None


def tor_detail(t):
    minute = f"{t['min']}'" if t.get("min") else ""
    zusatz = " (ET)" if t["et"] else " (P)" if t["elf"] else ""
    return f"{minute}{zusatz}"


def siegtor(liste, eigene_end, fremde_end):
    """Das Tor, mit dem Bayern endgültig in Führung ging."""
    if eigene_end is None or eigene_end <= fremde_end:
        return None
    return next((t for t in liste
                 if t["bayern"] and t["stand"][0] == fremde_end + 1), None)


def torschuetzen(m):
    """{'scorer': "Kane 12', 55' (P), Musiala 78'", 'siegtor': "Kane 55' (P)"}"""
    try:
        liste = openliga_tore(m)
    except (requests.RequestException, ValueError) as e:
        print(f"Torschützen nicht verfügbar: {e}", file=sys.stderr)
        return {}
    if not liste:
        return {}
    gruppen = {}
    for t in liste:
        if t["bayern"]:
            gruppen.setdefault(t["name"], []).append(tor_detail(t))
    d = {"scorer": ", ".join(f"{n} {', '.join(x for x in mins if x)}".strip()
                             for n, mins in gruppen.items())}
    eigene, fremde, _ = tore(m)
    st = siegtor(liste, eigene, fremde)
    if st:
        d["siegtor"] = f"{st['name']} {tor_detail(st)}".strip()
    return d


# ---------------------------------------------------------------- Topskorer

def _schluessel(name):
    n = unicodedata.normalize("NFKD", name or "")
    return "".join(c for c in n if not unicodedata.combining(c)).lower()


_NUMMERN = {_schluessel(k): v for k, v in RUECKENNUMMERN.items()}


def rueckennummer(name, api_nr):
    """Eigene Liste vor API. Eine API-Nummer, die laut Liste einem anderen
    Spieler gehört (z. B. noch die Nummer vom alten Verein), wird verworfen."""
    k = _schluessel(name)
    if k in _NUMMERN:
        return _NUMMERN[k]
    if api_nr in _NUMMERN.values():
        return None
    return api_nr


POSITIONEN = {"Offence": "Sturm", "Midfield": "Mittelfeld",
              "Defence": "Abwehr", "Goalkeeper": "Tor"}


def position(spieler):
    """Position auf Deutsch, aus 'section' oder notfalls aus 'position'."""
    if spieler.get("section") in POSITIONEN:
        return POSITIONEN[spieler["section"]]
    p = (spieler.get("position") or "").lower()
    if "goal" in p:
        return "Tor"
    if "forward" in p or "wing" in p or "striker" in p or "offence" in p:
        return "Sturm"
    if "midfield" in p:
        return "Mittelfeld"
    if "back" in p or "defen" in p:
        return "Abwehr"
    return ""


def topskorer(scorers_json):
    """Die besten Bayern-Skorer (Tore + Vorlagen) der Bundesliga mit Statistik.

    football-data listet nur Spieler mit mindestens einem Tor. Der Liga-Rang
    bezieht sich auf die Torschützenliste der ganzen Bundesliga (bei
    Torgleichheit teilen sich Spieler den Rang).
    """
    alle = scorers_json.get("scorers", [])
    tore_liga = [s.get("goals") or 0 for s in alle]
    bayern = []
    for s in alle:
        if (s.get("team") or {}).get("id") != TEAM_ID:
            continue
        g = s.get("goals") or 0
        a = s.get("assists") or 0
        spieler = s.get("player") or {}
        name = nachname(spieler.get("name"))
        bayern.append({
            "n": name,
            "nr": rueckennummer(name, spieler.get("shirtNumber")),  # None -> Initialen
            "pos": position(spieler),
            "t": g,
            "v": a,
            "sp": s.get("playedMatches") or 0,
            "p": s.get("penalties") or 0,
            "r": 1 + sum(1 for x in tore_liga if x > g),  # Rang Torschützenliste
        })
    bayern.sort(key=lambda x: (x["t"] + x["v"], x["t"]), reverse=True)
    bayern = bayern[:TOPSKORER]
    maximum = max([x["t"] + x["v"] for x in bayern] + [1])
    for x in bayern:
        # Balkenlängen in Prozent: Tore (schwarz) und Vorlagen (schraffiert)
        x["bt"] = round(100 * x["t"] / maximum)
        x["bv"] = round(100 * x["v"] / maximum)
    return bayern


# ---------------------------------------------------------------- Ablauf

def bereich(spiele, wb, standings_json, jetzt, torinfo=None):
    """Ein Wettbewerb: nächstes Spiel, letztes Spiel, Tabellenausschnitt."""
    eigene = [m for m in spiele if code(m) == wb]
    vorbei = [m for m in eigene if m.get("status") == "FINISHED"]
    offen = [m for m in eigene if m.get("status") in OFFEN]
    d = {
        "n": naechstes_spiel(offen[0], jetzt) if offen else None,
        "l": letztes_spiel(vorbei[-1]) if vorbei else None,
    }
    if d["l"] and torinfo:
        d["l"].update(torinfo)
    tab, bayern = tabelle(standings_json) if standings_json else ([], None)
    d["tab"] = tab
    if bayern:
        d["platz"] = bayern["position"]
        d["pkt"] = bayern.get("points", 0)
    return d


def baue_payload(spiele_json, bl_standings, cl_standings, jetzt, torinfo=None,
                 scorers_json=None):
    spiele = sorted(spiele_json.get("matches", []), key=lambda m: m["utcDate"])
    vorbei = [m for m in spiele if m.get("status") == "FINISHED"]
    cl = bereich(spiele, "CL", cl_standings, jetzt)
    cl.pop("tab", None)  # CL kompakt: nur Platz/Punkte, keine Tabelle
    return {
        "stand": jetzt.strftime("%d.%m. %H:%M"),
        "form": [resultat(m) for m in vorbei[-5:]],
        "bl": bereich(spiele, "BL1", bl_standings, jetzt, torinfo),
        "cl": cl,
        "top": topskorer(scorers_json) if scorers_json else [],
    }


def hole_tabelle(wb, token):
    try:
        return api(f"/competitions/{wb}/standings", token)
    except requests.RequestException as e:
        print(f"Tabelle {wb} nicht verfügbar: {e}", file=sys.stderr)
        return None


def main():
    dry = "--dry-run" in sys.argv
    token = os.environ.get("FOOTBALL_DATA_TOKEN")
    webhook = os.environ.get("TRMNL_WEBHOOK_URL")
    if not token:
        sys.exit("FOOTBALL_DATA_TOKEN fehlt.")

    jetzt = datetime.now(TZ)
    spiele_json = api(f"/teams/{TEAM_ID}/matches", token, season=saison(jetzt))
    bl = hole_tabelle("BL1", token)
    cl = hole_tabelle("CL", token)

    bl_vorbei = sorted((m for m in spiele_json.get("matches", [])
                        if code(m) == "BL1" and m.get("status") == "FINISHED"),
                       key=lambda m: m["utcDate"])
    torinfo = torschuetzen(bl_vorbei[-1]) if bl_vorbei else {}

    try:
        scorers_json = api("/competitions/BL1/scorers", token, limit=100)
    except requests.RequestException as e:
        print(f"Topskorer nicht verfügbar: {e}", file=sys.stderr)
        scorers_json = None

    payload = baue_payload(spiele_json, bl, cl, jetzt, torinfo, scorers_json)
    body = json.dumps({"merge_variables": payload}, ensure_ascii=False)
    groesse = len(body.encode("utf-8"))

    if dry or not webhook:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"\nPayload: {groesse} Bytes", file=sys.stderr)
        if not webhook and not dry:
            print("TRMNL_WEBHOOK_URL fehlt – nichts gesendet.", file=sys.stderr)
        return

    if groesse > MAX_PAYLOAD:
        print(f"Warnung: Payload {groesse} Bytes > {MAX_PAYLOAD}", file=sys.stderr)

    r = requests.post(webhook, data=body.encode("utf-8"),
                      headers={"Content-Type": "application/json"}, timeout=20)
    print(f"TRMNL: HTTP {r.status_code} ({groesse} Bytes)")
    r.raise_for_status()


if __name__ == "__main__":
    main()
