#!/usr/bin/env python3
"""Formel 1 -> TRMNL-Webhook.

Nächstes Rennen mit allen Sessions (Zürcher Zeit) und Countdown,
Podium des letzten Rennens, Fahrer- und Team-WM.
Daten: Jolpica F1 API (Nachfolger von Ergast), kostenlos, ohne Key.

Nur Standardbibliothek, Python 3.9+.

Umgebungsvariable:
  TRMNL_F1_WEBHOOK_URL  Webhook-URL des F1-Plugins

Aufruf:
  python3 f1_fetch.py            # abrufen und senden
  python3 f1_fetch.py --dry-run  # nur JSON ausgeben
  python3 f1_fetch.py --sample   # Beispieldaten, kein Netz nötig
"""

import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Zurich")
API = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "trmnl-zuerich-dashboard-f1/1.0"
MAX_PAYLOAD = 5000
WOCHENTAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
MONATE = ["Jan.", "Feb.", "März", "April", "Mai", "Juni", "Juli",
          "Aug.", "Sept.", "Okt.", "Nov.", "Dez."]

GP_NAMEN = {
    "Australian": "Australien", "Chinese": "China", "Japanese": "Japan", "Bahrain": "Bahrain",
    "Saudi Arabian": "Saudi-Arabien", "Miami": "Miami", "Emilia Romagna": "Emilia-Romagna",
    "Monaco": "Monaco", "Spanish": "Spanien", "Barcelona-Catalunya": "Barcelona", "Canadian": "Kanada",
    "Austrian": "Österreich", "British": "Grossbritannien", "Belgian": "Belgien",
    "Hungarian": "Ungarn", "Dutch": "Niederlande", "Italian": "Italien", "Azerbaijan": "Aserbaidschan",
    "Singapore": "Singapur", "United States": "USA", "Mexico City": "Mexiko", "São Paulo": "Brasilien",
    "Las Vegas": "Las Vegas", "Qatar": "Katar", "Abu Dhabi": "Abu Dhabi",
}
SESSIONS = [
    ("FirstPractice", "Training 1"), ("SecondPractice", "Training 2"),
    ("ThirdPractice", "Training 3"), ("SprintQualifying", "Sprint-Quali"),
    ("SprintShootout", "Sprint-Quali"), ("Sprint", "Sprint"), ("Qualifying", "Qualifying"),
]


# ---------------------------------------------------------------- Daten

def api(path):
    req = urllib.request.Request(f"{API}/{path}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)["MRData"]


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def wikidata_claims(wiki_url):
    """Wikidata-Eigenschaften zum (englischen) Wikipedia-Artikel."""
    try:
        title = urllib.parse.unquote(wiki_url.rsplit("/wiki/", 1)[1])
        q = urllib.parse.urlencode({"action": "query", "prop": "pageprops", "titles": title,
                                    "redirects": 1, "format": "json", "formatversion": 2})
        page = get_json(f"https://en.wikipedia.org/w/api.php?{q}")["query"]["pages"][0]
        qid = page["pageprops"]["wikibase_item"]
        return get_json(f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json")["entities"][qid]["claims"]
    except Exception:
        return {}


def track_map(claims, width=320):
    """Streckenkarte: Wikidata-Eigenschaft P15 -> Bild auf Commons."""
    try:
        filename = claims["P15"][0]["mainsnak"]["datavalue"]["value"]
        return ("https://commons.wikimedia.org/wiki/Special:FilePath/"
                f"{urllib.parse.quote(filename.replace(' ', '_'))}?width={width}")
    except Exception:
        return ""


def wiki_image(wiki_url, width=320):
    """Ersatz: Hauptbild des Wikipedia-Artikels (bei Rennstrecken meist die Streckenkarte)."""
    try:
        title = urllib.parse.quote(urllib.parse.unquote(wiki_url.rsplit("/wiki/", 1)[1]).replace(" ", "_"))
        summary = get_json(f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}?redirect=true")
        src = (summary.get("originalimage") or summary.get("thumbnail") or {}).get("source", "")
        if src.lower().endswith(".svg") and "/thumb/" not in src:
            name = src.rsplit("/", 1)[1]
            return f"https://commons.wikimedia.org/wiki/Special:FilePath/{name}?width={width}"
        return src if ".svg" in src.lower() else ""
    except Exception:
        return ""


def track_length_km(claims):
    """Streckenlänge: Wikidata-Eigenschaft P2043 (in km oder m)."""
    try:
        v = claims["P2043"][0]["mainsnak"]["datavalue"]["value"]
        amount = float(v["amount"])
        return amount / 1000 if v["unit"].endswith("Q11573") else amount   # Q11573 = Meter
    except Exception:
        return None


def lap_seconds(t):
    m, _, sec = t.rpartition(":")
    return (int(m) * 60 if m else 0) + float(sec)


def api_all(path, key="RaceTable"):
    races, offset = [], 0
    while True:
        data = api(f"{path}?limit=100&offset={offset}")
        races += data[key]["Races"]
        offset += 100
        if offset >= int(data["total"]):
            return races


OPENF1 = "https://api.openf1.org/v1"


def openf1(endpoint, **params):
    """OpenF1-Abfrage; Filter wie 'date>=' als Schlüssel möglich. Max. 3 Anfragen/s."""
    time.sleep(0.4)
    query = "&".join(f"{k}={urllib.parse.quote(str(v), safe=':-.')}" for k, v in params.items())
    return get_json(f"{OPENF1}/{endpoint}?{query}")


def simplify(points, target=120):
    step = max(1, len(points) // target)
    return points[::step]


def track_outline(race_date):
    """Streckenverlauf aus den GPS-Daten einer schnellen Rennrunde (OpenF1, Daten ab 2023).

    Gibt {"pfad": SVG-Pfad, "vb": viewBox} zurück oder None.
    """
    try:
        year = int(race_date[:4])
        meeting = next(m for m in openf1("meetings", year=year)
                       if m["date_start"][:10] <= race_date <= m["date_end"][:10])
        past = sorted((m for m in openf1("meetings", circuit_key=meeting["circuit_key"])
                       if m["date_end"][:10] < race_date and not m.get("is_cancelled")),
                      key=lambda m: m["date_start"])
        for old in reversed(past):
            sessions = openf1("sessions", meeting_key=old["meeting_key"], session_name="Race")
            if not sessions:
                continue
            sk = sessions[0]["session_key"]
            laps = [l for l in openf1("laps", session_key=sk, lap_number=10)
                    if l.get("lap_duration") and l.get("date_start")]
            if not laps:
                continue
            lap = min(laps, key=lambda l: l["lap_duration"])
            start = dt.datetime.fromisoformat(lap["date_start"])
            end = start + dt.timedelta(seconds=lap["lap_duration"])
            pts = [(p["x"], p["y"]) for p in openf1("location", session_key=sk,
                                                      driver_number=lap["driver_number"],
                                                      **{"date>": start.isoformat(), "date<": end.isoformat()})
                   if p.get("x") is not None]
            if len(pts) < 50:
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            scale = 200 / max(w, h)
            path = [(round((x - min(xs)) * scale), round((max(ys) - y) * scale)) for x, y in simplify(pts)]
            d = "M" + " L".join(f"{x} {y}" for x, y in path) + " Z"
            return {"pfad": d, "vb": f"-8 -8 {round(w * scale) + 16} {round(h * scale) + 16}",
                    "start_x": path[0][0], "start_y": path[0][1]}
    except Exception:
        pass
    return None


def circuit_facts(circuit):
    """Fakten zur Strecke aus der F1-Historie (Jolpica) und Wikidata."""
    if "_sample" in circuit:
        return circuit["_sample"]
    cid = circuit["circuitId"]
    claims = wikidata_claims(circuit.get("url", "")) if circuit.get("url") else {}
    facts = {"bild": track_map(claims) or wiki_image(circuit.get("url", "")), "laenge": "", "runden": "", "distanz": "", "erster_gp": "",
             "austragungen": "", "vorjahr": "", "rekordsieger": "", "rundenrekord": "", "rekord_von": ""}
    length = track_length_km(claims)
    if length:
        facts["laenge"] = f"{length:.3f}".replace(".", ",") + " km"
    try:
        wins = api_all(f"circuits/{cid}/results/1/")
        if wins:
            facts["erster_gp"] = wins[0]["season"]
            facts["austragungen"] = str(len(wins))
            last = wins[-1]
            facts["vorjahr"] = f'{last["Results"][0]["Driver"]["familyName"]} ({last["season"]})'
            laps = last["Results"][0].get("laps")
            if laps:
                facts["runden"] = laps
                if length:
                    facts["distanz"] = f"{int(laps) * length:.0f} km"
            count = {}
            for r in wins:
                name = r["Results"][0]["Driver"]["familyName"]
                count[name] = count.get(name, 0) + 1
            top = max(count.items(), key=lambda kv: kv[1])
            if top[1] > 1:
                facts["rekordsieger"] = f"{top[0]} ({top[1]}×)"
    except Exception:
        pass
    try:
        best = None
        for r in api_all(f"circuits/{cid}/fastest/1/results/"):
            res = r["Results"][0]
            t = res.get("FastestLap", {}).get("Time", {}).get("time")
            if t and (best is None or lap_seconds(t) < best[0]):
                best = (lap_seconds(t), t, f'{res["Driver"]["familyName"]} ({r["season"]})')
        if best:
            facts["rundenrekord"], facts["rekord_von"] = best[1], best[2]
    except Exception:
        pass
    return facts


LAENDER = {
    "British": "Grossbritannien", "Dutch": "Niederlande", "Monegasque": "Monaco", "Spanish": "Spanien",
    "Australian": "Australien", "Mexican": "Mexiko", "German": "Deutschland", "French": "Frankreich",
    "Canadian": "Kanada", "Thai": "Thailand", "Japanese": "Japan", "Italian": "Italien",
    "New Zealander": "Neuseeland", "Brazilian": "Brasilien", "Argentine": "Argentinien",
    "Argentinian": "Argentinien", "Finnish": "Finnland", "American": "USA", "Danish": "Dänemark",
    "Chinese": "China", "Swiss": "Schweiz", "Austrian": "Österreich", "Belgian": "Belgien",
}
WINNER_DAYS = 3   # so viele Tage nach einem Rennen zeigt die Karte den Sieger


def api_total(path):
    try:
        return int(api(f"{path}?limit=1")["total"])
    except Exception:
        return None


def driver_facts(did):
    """Karriere-Zahlen über die Gesamtanzahl passender Einträge (je eine kleine Abfrage)."""
    facts = {
        "rennen": api_total(f"drivers/{did}/results/"),
        "siege": api_total(f"drivers/{did}/results/1/"),
        "poles": api_total(f"drivers/{did}/qualifying/1/"),
    }
    places = [api_total(f"drivers/{did}/results/{p}/") for p in (2, 3)]
    facts["podien"] = None if facts["siege"] is None or None in places else facts["siege"] + sum(places)
    return {k: ("–" if v is None else str(v)) for k, v in facts.items()}


def build_focus(last, standings, now, facts_fn=driver_facts):
    """Nach einem Rennen der Sieger, sonst täglich ein anderer Fahrer aus dem WM-Feld."""
    if not standings:
        return None
    winner = None
    if last and last.get("Results"):
        days = (now.date() - dt.date.fromisoformat(last["date"])).days
        if 0 <= days <= WINNER_DAYS:
            winner = last["Results"][0]["Driver"]["driverId"]
    if winner:
        entry = next((s for s in standings if s["Driver"]["driverId"] == winner), standings[0])
        titel = f"Sieger · {gp_name(last['raceName'])}"
    else:
        entry = standings[now.date().toordinal() % len(standings)]
        titel = "Fahrer im Fokus"
    d = entry["Driver"]
    age = ""
    if d.get("dateOfBirth"):
        born = dt.date.fromisoformat(d["dateOfBirth"])
        age = str(now.year - born.year - ((now.month, now.day) < (born.month, born.day)))
    return {
        "titel": titel,
        "name": f'{d["givenName"]} {d["familyName"]}',
        "nummer": d.get("permanentNumber", ""),
        "team": entry["Constructors"][-1]["name"] if entry.get("Constructors") else "",
        "land": LAENDER.get(d.get("nationality", ""), d.get("nationality", "")),
        "alter": age,
        "wm_pos": entry.get("position", entry.get("positionText", "")),
        "punkte": entry["points"].removesuffix(".0"),
        "saison_siege": entry.get("wins", "0"),
        **facts_fn(d["driverId"]),
    }


def fetch_all():
    nxt = api("current/next/races/")["RaceTable"]["Races"]
    last = api("current/last/results/")["RaceTable"]["Races"]
    drivers = api("current/driverstandings/")["StandingsTable"]["StandingsLists"]
    teams = []
    return (nxt[0] if nxt else None, last[0] if last else None,
            drivers[0]["DriverStandings"] if drivers else [],
            [])


# ------------------------------------------------------------ Aufbereiten

def gp_name(race_name):
    key = race_name.replace(" Grand Prix", "").strip()
    return "GP " + GP_NAMEN.get(key, key)


def to_local(obj):
    """{date, time} (UTC) -> datetime in Zürich; ohne Uhrzeit: None."""
    if not obj or "date" not in obj or "time" not in obj:
        return None
    utc = dt.datetime.fromisoformat(f'{obj["date"]}T{obj["time"].replace("Z", "+00:00")}')
    return utc.astimezone(TZ)


def fmt_session(when):
    return f"{WOCHENTAGE[when.weekday()]} {when:%H:%M}"


def fmt_date(d):
    return f"{WOCHENTAGE[d.weekday()]}, {d.day}. {MONATE[d.month - 1]}"


def countdown(start, now):
    if start is None:
        return ""
    days = (start.date() - now.date()).days
    if start < now:
        return "läuft" if now - start < dt.timedelta(hours=2) else "vorbei"
    if days == 0:
        return "heute"
    if days == 1:
        return "morgen"
    return f"in {days} Tagen"


def build_next(race, now):
    if not race:
        return None
    start = to_local({"date": race["date"], "time": race.get("time", "")}) if race.get("time") else None
    sessions = []
    seen = set()
    for key, label in SESSIONS:
        when = to_local(race.get(key))
        if when and label not in seen:
            seen.add(label)
            sessions.append((when, label))
    if start:
        sessions.append((start, "Rennen"))
    sessions.sort()
    loc = race["Circuit"]["Location"]
    return {
        "name": gp_name(race["raceName"]),
        "strecke": race["Circuit"]["circuitName"],
        "strecke_info": circuit_facts(race["Circuit"]),
        "strecke_form": track_outline(race["date"]) if "_sample" not in race["Circuit"] else race["Circuit"].get("_form"),
        "ort": loc["locality"],
        "runde": race["round"],
        "datum": fmt_date(start or dt.date.fromisoformat(race["date"])),
        "start": f"{start:%H:%M}" if start else "",
        "countdown": countdown(start, now),
        "cd_zahl": str((start.date() - now.date()).days) if start and (start.date() - now.date()).days >= 2 else "",
        "sprint": any(l == "Sprint" for _, l in sessions),
        "sessions": [{"name": l, "zeit": fmt_session(w), "vorbei": w < now} for w, l in sessions],
        "als_naechstes": next(({"name": l, "zeit": fmt_session(w)} for w, l in sessions if w >= now),
                              {"name": "", "zeit": ""}),
    }


def build_last(race):
    if not race:
        return None
    podium = []
    for r in race.get("Results", [])[:3]:
        d = r["Driver"]
        podium.append({
            "pos": r["position"],
            "fahrer": d["familyName"],
            "team": r["Constructor"]["name"],
        })
    return {"name": gp_name(race["raceName"]), "podium": podium}


def build_drivers(standings, n=10):
    out = []
    for s in standings[:n]:
        d = s["Driver"]
        out.append({
            "pos": s.get("position", s.get("positionText", "")),
            "fahrer": d["familyName"],
            "code": d.get("code", d["familyName"][:3].upper()),
            "team": s["Constructors"][-1]["name"] if s.get("Constructors") else "",
            "punkte": s["points"].removesuffix(".0"),
        })
    return out


def build_teams(standings, n=5):
    return [{"pos": s.get("position", s.get("positionText", "")), "team": s["Constructor"]["name"],
             "punkte": s["points"].removesuffix(".0")} for s in standings[:n]]


def build_payload(nxt, last, drivers, teams, now, facts_fn=None):
    facts_fn = facts_fn or driver_facts
    data = {
        "stand": now.strftime("%H:%M"),
        "saison": (nxt or last or {}).get("season", str(now.year)),
        "naechstes": build_next(nxt, now),
        "letztes": build_last(last),
        "fahrer": build_drivers(drivers),
        "fokus": build_focus(last, drivers, now, facts_fn),
    }
    while len(json.dumps({"merge_variables": data}, ensure_ascii=False).encode()) > MAX_PAYLOAD \
            and len(data["fahrer"]) > 5:
        data["fahrer"].pop()
    return data


# --------------------------------------------------------------- Beispiel

def sample_data(now):
    day = lambda n: (now + dt.timedelta(days=n)).strftime("%Y-%m-%d")
    nxt = {
        "season": str(now.year), "round": "21", "raceName": "São Paulo Grand Prix", "date": day(8), "time": "17:00:00Z",
        "Circuit": {"circuitId": "interlagos", "circuitName": "Autódromo José Carlos Pace",
                    "Location": {"locality": "São Paulo", "country": "Brazil"},
                    "_sample": {"bild": "", "laenge": "4,309 km", "runden": "71", "distanz": "306 km",
                                "erster_gp": "1973", "austragungen": "42", "vorjahr": "Norris (2025)",
                                "rekordsieger": "Prost (6×)", "rundenrekord": "1:10.540",
                                "rekord_von": "Bottas (2018)"},
                    "_form": {"pfad": "M20 150 L60 165 L170 160 Q200 150 195 110 L180 50 Q170 25 145 40 L115 75 Q100 90 88 65 L70 30 Q55 12 38 30 L22 80 Q12 120 20 150 Z",
                              "vb": "-8 -8 216 186", "start_x": 20, "start_y": 150}},
        "FirstPractice": {"date": day(6), "time": "14:30:00Z"},
        "SprintQualifying": {"date": day(6), "time": "18:30:00Z"},
        "Sprint": {"date": day(7), "time": "14:00:00Z"},
        "Qualifying": {"date": day(7), "time": "18:00:00Z"},
    }
    drv = lambda g, f, c, t: {"givenName": g, "familyName": f, "code": c, "_t": t, "driverId": f.lower(),
                               "permanentNumber": "4", "nationality": "British", "dateOfBirth": "1999-11-13"}
    people = [drv("Lando", "Norris", "NOR", "McLaren"), drv("Oscar", "Piastri", "PIA", "McLaren"),
              drv("Max", "Verstappen", "VER", "Red Bull"), drv("George", "Russell", "RUS", "Mercedes"),
              drv("Charles", "Leclerc", "LEC", "Ferrari"), drv("Lewis", "Hamilton", "HAM", "Ferrari"),
              drv("Kimi", "Antonelli", "ANT", "Mercedes"), drv("Alexander", "Albon", "ALB", "Williams"),
              drv("Nico", "Hülkenberg", "HUL", "Audi"), drv("Isack", "Hadjar", "HAD", "Racing Bulls")]
    last = {"season": str(now.year), "raceName": "Mexico City Grand Prix", "date": day(-6),
            "Results": [{"position": str(i + 1), "Driver": p, "Constructor": {"name": p["_t"]}}
                        for i, p in enumerate([people[0], people[4], people[2]])]}
    pts = [357, 356, 321, 258, 210, 146, 97, 73, 41, 39]
    drivers = [{"position": str(i + 1), "points": str(pts[i]), "wins": "6" if i == 0 else "1", "Driver": p, "Constructors": [{"name": p["_t"]}]}
               for i, p in enumerate(people)]
    teams = [{"position": str(i + 1), "points": str(x), "Constructor": {"name": n}}
             for i, (n, x) in enumerate([("McLaren", 713), ("Mercedes", 355), ("Ferrari", 356),
                                         ("Red Bull", 346), ("Williams", 111)])]
    return nxt, last, drivers, teams


# ------------------------------------------------------------------ Main

def main():
    args = set(sys.argv[1:])
    now = dt.datetime.now(TZ)
    nxt, last, drivers, teams = sample_data(now) if "--sample" in args else fetch_all()
    facts_fn = (lambda _id: {"rennen": "152", "siege": "11", "poles": "15", "podien": "44"}) \
        if "--sample" in args else None
    data = build_payload(nxt, last, drivers, teams, now, facts_fn)
    body = json.dumps({"merge_variables": data}, ensure_ascii=False).encode()

    if "--dry-run" in args or "--sample" in args:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        print(f"\n# Payload: {len(body)} Bytes", file=sys.stderr)
        return

    url = os.environ.get("TRMNL_F1_WEBHOOK_URL")
    if not url:
        sys.exit("TRMNL_F1_WEBHOOK_URL fehlt.")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        print(f"TRMNL: {resp.status}, {len(body)} Bytes gesendet")


if __name__ == "__main__":
    main()
