// Holt alle Daten fürs Tolino-Dashboard und legt sie unter _site/<DASHBOARD_KEY>/data.json ab.
// Der Workflow lädt _site danach per SFTP auf den eigenen Webspace.
// Läuft in GitHub Actions (siehe .github/workflows/dashboard.yml).
// Geheimnisse kommen als Umgebungsvariablen aus den GitHub-Secrets.

const fs = require("fs");
const path = require("path");
const { run } = require("./serverless.js");

const env = (k, d = "") => (process.env[k] || d).trim();
const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "_site");
const STATE = path.join(ROOT, "state", "state.json"); // Netatmo-Tokens, über den Actions-Cache weitergereicht

// ---------- ÖV: Abfahrten ab Bahnhof Wiedikon (Zug + Tram/Bus) ----------
// Die Seite blendet vergangene Abfahrten selbst aus, darum genügend Abfahrten im Voraus holen.
async function oev(stationen) {
  const listen = await Promise.all(stationen.map(async st => {
    const url = `https://transport.opendata.ch/v1/stationboard?station=${encodeURIComponent(st)}&limit=40`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status} ${st}`);
    const d = await res.json();
    return (d.stationboard || []).map(a => {
      const plan = Date.parse(a.stop?.departure || "");
      const prog = Date.parse(a.stop?.prognosis?.departure || "");
      return {
        linie: `${a.category || ""}${a.number && a.category !== a.number ? a.number : ""}`.replace(/^(T|B)(\d)/, "$2"),
        typ: a.category === "T" ? "tram" : a.category === "B" ? "bus" : "zug",
        ziel: (a.to || "").replace(/^Zürich,\s*/, ""),
        plan: plan || 0,
        ab: prog || plan || 0,
        delay: a.stop?.delay || 0,
        gleis: a.stop?.prognosis?.platform || a.stop?.platform || "",
        halt: st,
      };
    }).filter(a => a.plan);
  }));
  return listen.flat().sort((a, b) => a.ab - b.ab);
}

// ---------- Verbindungen von zuhause zu einem Ziel (z. B. Flughafen) ----------
const dauerMin = d => { const m = /(\d+)d(\d+):(\d+)/.exec(d || ""); return m ? (+m[1]) * 1440 + (+m[2]) * 60 + (+m[3]) : null; };
function verbindungKurz(c) {
  const ab = (c.from?.prognosis?.departure && Date.parse(c.from.prognosis.departure)) || (c.from?.departureTimestamp || 0) * 1000;
  return {
    plan: (c.from?.departureTimestamp || 0) * 1000,
    ab,
    an: (c.to?.arrivalTimestamp || 0) * 1000,
    dauer: dauerMin(c.duration),
    umsteigen: c.transfers || 0,
    delay: c.from?.delay || 0,
    teile: (c.sections || []).map(s => s.journey ? {
      linie: `${s.journey.category || ""}${s.journey.number && s.journey.category !== s.journey.number ? s.journey.number : ""}`.replace(/^(T|B)(\d)/, "$2"),
      typ: s.journey.category === "T" ? "tram" : s.journey.category === "B" ? "bus" : "zug",
      von: (s.departure?.station?.name || "").replace(/^Zürich,\s*/, ""),
      bis: (s.arrival?.station?.name || "").replace(/^Zürich,\s*/, ""),
      ab: (s.departure?.departureTimestamp || 0) * 1000,
      gleis: s.departure?.prognosis?.platform || s.departure?.platform || "",
    } : { fuss: Math.round((s.walk?.duration || 0) / 60) }).filter(t => !t.fuss || t.fuss > 0),
  };
}
// Mehrere Start-Haltestellen; optional mit Fussweg in Minuten: "Zürich, Binz=6"
async function verbindungen(starts, nach) {
  const fehler = [];
  const listen = await Promise.all(starts.map(async st => {
    try {
      const url = `https://transport.opendata.ch/v1/connections?from=${encodeURIComponent(st.name)}&to=${encodeURIComponent(nach)}&limit=6`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const d = await res.json();
      return (d.connections || []).map(verbindungKurz).filter(c => c.ab)
        .map(c => ({ ...c, start: st.name.replace(/^Zürich,\s*/, ""), fuss: st.fuss }));
    } catch (e) { fehler.push(`${st.name}: ${e.message}`); return []; }
  }));
  const alle = listen.flat().sort((a, b) => (a.ab - a.fuss * 60000) - (b.ab - b.fuss * 60000));
  if (!alle.length) throw new Error(fehler.join("; ") || "keine Verbindungen");
  return { starts, nach, verbindungen: alle, warnung: fehler.join("; ") };
}

async function main() {
  const key = env("DASHBOARD_KEY");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error("Secret DASHBOARD_KEY fehlt oder ist zu kurz (mind. 16 Zeichen, nur Buchstaben/Ziffern/-/_)");

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { /* erster Lauf */ }

  const input = {
    plz: env("PLZ", "8055"),
    ort: env("ORT", "Zürich"),
    kalender_1: env("KALENDER_1"),
    kalender_2: env("KALENDER_2"),
    news_feed: env("NEWS_FEED", "https://www.srf.ch/news/bnf/rss/19032223"),
    pollen_arten: env("POLLEN_ARTEN", "Hasel, Erle, Birke, Esche, Gräser, Beifuss, Ambrosia"),
    pollen_station: env("POLLEN_STATION", "PZH"),
    netatmo_client_id: env("NETATMO_CLIENT_ID"),
    netatmo_client_secret: env("NETATMO_CLIENT_SECRET"),
    netatmo_refresh_token: env("NETATMO_REFRESH_TOKEN"),
    trmnl: { state: state.trmnl || state },
  };

  const stationen = env("OEV_STATIONEN", "Zürich Wiedikon;Zürich, Bahnhof Wiedikon").split(";").map(s => s.trim()).filter(Boolean);
  const routeVon = env("ROUTE_VON", "Zürich, Höfliweg;Zürich, Goldbrunnenplatz;Zürich, Binz").split(";").map(x => {
    const [name, fuss] = x.split("=");
    return { name: name.trim(), fuss: Math.max(0, parseInt(fuss, 10) || 0) };
  }).filter(x => x.name);
  const routeNach = env("ROUTE_NACH", "Zürich Flughafen");
  const [daten, abfahrten, route] = await Promise.all([
    run(input),
    oev(stationen).catch(e => ({ fehler: e.message })),
    verbindungen(routeVon, routeNach).catch(e => ({ fehler: e.message })),
  ]);

  // Antwortet eine Quelle nicht, den letzten guten Stand (höchstens 3 Std. alt) weiterverwenden,
  // damit z. B. das Wetter nicht einfach verschwindet. Im Dashboard steht dann «älterer Stand».
  const letzte = state.letzte || {};
  const jetzt = Date.now();
  for (const k of ["wetter", "ausblick", "abfall", "kalender", "news", "netatmo", "pollen"]) {
    if (daten[k]) letzte[k] = { ts: jetzt, wert: daten[k] };
    else if (letzte[k] && jetzt - letzte[k].ts < 3 * 3600e3) {
      daten[k] = letzte[k].wert;
      (daten.aelter = daten.aelter || []).push(k);
    }
  }

  // Netatmo-Tokens und letzte Werte für den nächsten Lauf aufheben, aber nicht veröffentlichen
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ trmnl: daten.trmnl_state || {}, letzte }));
  delete daten.trmnl_state;

  if (Array.isArray(abfahrten)) daten.oev = { stationen, abfahrten };
  else { daten.oev = null; daten.fehler.push(`oev: ${abfahrten.fehler}`); }
  if (route.verbindungen) daten.route = route;
  else { daten.route = null; daten.fehler.push(`route: ${route.fehler}`); }
  // Sport (vom Schritt «Sport holen» in state/ abgelegt)
  const lies = name => {
    try {
      return { ...JSON.parse(fs.readFileSync(path.join(ROOT, "state", `${name}.json`), "utf8")),
               ts: +fs.readFileSync(path.join(ROOT, "state", `${name}.ts`), "utf8") * 1000 };
    } catch { return null; }
  };
  daten.sport = { f1: lies("f1"), bayern: lies("bayern") };
  daten.stand = Date.now();

  fs.mkdirSync(path.join(SITE, key), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(SITE, "index.html"));
  fs.writeFileSync(path.join(SITE, key, "data.json"), JSON.stringify(daten));
  fs.writeFileSync(path.join(SITE, "robots.txt"), "User-agent: *\nDisallow: /\n");
  // Apache (cyon): kein Ordner-Listing, nicht in Suchmaschinen, Seite und data.json nie aus dem Cache
  fs.writeFileSync(path.join(SITE, ".htaccess"), [
    "Options -Indexes",
    "<IfModule mod_headers.c>",
    '  Header set X-Robots-Tag "noindex, nofollow"',
    '  <FilesMatch "\\.(json|html)$">',
    '    Header set Cache-Control "no-store"',
    "  </FilesMatch>",
    "</IfModule>", ""].join("\n"));

  const kb = (JSON.stringify(daten).length / 1024).toFixed(1);
  console.log(`data.json geschrieben (${kb} KB). Fehler: ${daten.fehler.length ? daten.fehler.join(" | ") : "keine"}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
