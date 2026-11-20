// Kopie aus trmnl-zuerich-dashboard/serverless.js, angepasst fürs Tolino-Dashboard:
// Termine 30 Tage/25 Stück, Start/Ende als Epoch, 12 News mit Vorspann.
// TRMNL Serverless (Node 20) – holt alle Quellen und liefert nur die Felder, die das Markup braucht.
// Ergebnis-Variablen: abfall, wetter, pollen, ausblick, kalender, netatmo, news, meteoschweiz, quellen, fehler, zeit
// Saved State: trmnl_state.netatmo (Netatmo-Tokens, siehe unten)


function field(input, key, fallback) {
  const cf = input?.trmnl?.plugin_settings?.custom_fields_values
    ?? input?.plugin_settings?.custom_fields_values
    ?? input?.custom_fields_values
    ?? {};
  const v = input?.[key] ?? cf[key];
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2200), headers: { "User-Agent": "TRMNL-Dashboard" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2200), headers: { "User-Agent": "TRMNL-Dashboard" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// ---------- Zürcher Zeit ohne Locale-/ICU-Abhängigkeit ----------
// Nimmt den Offset von TRMNL (trmnl.user.utc_offset), sonst Schweizer Sommerzeit-Regel.
function zurichOffsetSec(nowMs) {
  const y = new Date(nowMs).getUTCFullYear();
  const lastSunday = m => { const d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); };
  return nowMs >= lastSunday(2) && nowMs < lastSunday(9) ? 7200 : 3600; // Ende März bis Ende Oktober, jeweils 01:00 UTC
}
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WD_VOLL = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
function datumsKopf(today) {
  const d = new Date(today + "T12:00:00Z");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)));
  const kw = 1 + Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 / 7); // ISO-Woche über den Donnerstag
  return { wochentag: WD_VOLL[d.getUTCDay()], titel: `${d.getUTCDate()}. ${MONATE[d.getUTCMonth()]}`, kw };
}
function zurichNow(input) {
  const nowMs = Date.now();
  const given = Number(input?.trmnl?.user?.utc_offset ?? input?.user?.utc_offset);
  const off = Number.isFinite(given) && given !== 0 ? given : zurichOffsetSec(nowMs);
  const local = new Date(nowMs + off * 1000).toISOString(); // "YYYY-MM-DDTHH:MM:..."
  return { today: local.slice(0, 10), hour: Number(local.slice(11, 13)), hourKey: local.slice(0, 13) };
}

// ---------- Abfall (nur nächster Termin, alle Arten an diesem Tag) ----------
const WASTE = { waste: "Kehricht", paper: "Papier", cardboard: "Karton", organic: "Grüngut", special: "Sonderabfall",
  mobile: "Mobile Sammlung", incombustibles: "Unbrennbares", chipping: "Häckseldienst", metal: "Altmetall",
  etram: "E-Tram", cargotram: "Cargo-Tram", textile: "Textilien" };
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

async function abfall(plz, today, hour) {
  const d = await getJson(`https://openerz.metaodi.ch/api/calendar?region=zurich&area=${encodeURIComponent(plz)}&start=${today}&sort=date&limit=8`);
  // Abfuhr ist morgens; ab 10 Uhr ist der heutige Termin vorbei → nächsten zeigen
  const list = (d.result || []).filter(e => !(e.date === today && hour >= 10));
  if (!list.length) return null;
  const date = list[0].date;
  const same = list.filter(e => e.date === date);
  const tage = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
  const dt = new Date(date + "T12:00:00Z");
  return {
    date, tage,
    wann: tage <= 0 ? "HEUTE" : tage === 1 ? "MORGEN" : `${WD[dt.getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}.`,
    arten: same.map(e => WASTE[e.waste_type] || e.waste_type).join(", "),
    station: same.map(e => e.station).filter(Boolean).join(", "),
  };
}

// ---------- Wetter ----------
const iconKind = c => c == null ? "cloud" : c <= 1 ? "sun" : c === 2 ? "partly" : c === 3 ? "cloud" : c <= 48 ? "fog" :
  c <= 67 ? "rain" : c <= 77 ? "snow" : c <= 82 ? "shower" : c <= 86 ? "snow" : "storm";

// Ort oder PLZ → Koordinaten (Open-Meteo Geocoding). Fallback: Zürich.
async function geocode(ort) {
  const fallback = { lat: "47.364", lon: "8.505", name: "Zürich" };
  if (!ort) return fallback;
  const d = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(ort)}&count=1&language=de&countryCode=CH&format=json`
  );
  const r = d.results?.[0];
  return r ? { lat: r.latitude, lon: r.longitude, name: r.name } : { ...fallback, name: `${ort}?` };
}

const fmtDuration = sec => `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;

async function wetter(geo) {
  const { lat, lon, name } = geo;
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=Europe%2FZurich`;
  const [d, licht] = await Promise.all([
    getJson(
      base +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&hourly=temperature_2m,precipitation_probability,precipitation,uv_index` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset` +
      `&forecast_hours=12&forecast_days=2`
    ),
    // Tageslänge gestern und heute für den Vergleich
    getJson(base + `&daily=daylight_duration&past_days=1&forecast_days=1`).catch(() => null),
  ]);

  const uv_max = Math.round(Math.max(0, ...(d.hourly?.uv_index || []).map(v => v || 0)));
  const [gestern, heute] = licht?.daily?.daylight_duration || [];
  const delta = heute && gestern ? Math.round(heute - gestern) : null; // Sekunden
  const deltaTxt = delta === null ? "" :
    `${delta < 0 ? "−" : "+"}${Math.floor(Math.abs(delta) / 60)}' ${String(Math.abs(delta) % 60).padStart(2, "0")}"`;

  return {
    ort: name, current: d.current, hourly: d.hourly, daily: d.daily,
    icon: iconKind(d.current?.weather_code),
    uv_max,
    licht: {
      auf: (d.daily?.sunrise?.[0] || "").slice(11, 16),
      unter: (d.daily?.sunset?.[0] || "").slice(11, 16),
      dauer: heute ? fmtDuration(heute) : "",
      delta: deltaTxt,
    },
  };
}

// ---------- Pollen ----------
// heute: Messung MeteoSchweiz (Mittel der letzten 24 Stunden), sonst Open-Meteo-Prognose
// morgen: Prognose Open-Meteo (CAMS Europa); für Hasel, Esche, Buche, Eiche gibt es keine Prognose
// Schwellen in Pollen/m³ für: schwach, mässig, stark, sehr stark (angelehnt an gängige Pollenwarnstufen).
const POLLEN = {
  hazel:   { name: "Hasel",    keys: ["hasel", "hazel"],                 om: null,      ms: "cory", stufen: [1, 11, 70, 300] },
  alder:   { name: "Erle",     keys: ["erle", "alder"],                  om: "alder",   ms: "alnu", stufen: [1, 11, 70, 300] },
  birch:   { name: "Birke",    keys: ["birke", "birch"],                 om: "birch",   ms: "betu", stufen: [1, 11, 70, 300] },
  ash:     { name: "Esche",    keys: ["esche", "ash"],                   om: null,      ms: "frax", stufen: [1, 11, 70, 300] },
  beech:   { name: "Buche",    keys: ["buche", "beech"],                 om: null,      ms: "fagu", stufen: [1, 11, 70, 300] },
  oak:     { name: "Eiche",    keys: ["eiche", "oak"],                   om: null,      ms: "quer", stufen: [1, 11, 70, 300] },
  grass:   { name: "Gräser",   keys: ["gras", "gräser", "graeser", "grass"], om: "grass", ms: "poac", stufen: [1, 20, 50, 150] },
  mugwort: { name: "Beifuss",  keys: ["beifuss", "beifuß", "mugwort"],   om: "mugwort", ms: null,   stufen: [1, 6, 15, 50] },
  ragweed: { name: "Ambrosia", keys: ["ambrosia", "ragweed"],            om: "ragweed", ms: null,   stufen: [1, 6, 11, 40] },
  olive:   { name: "Olive",    keys: ["olive"],                          om: "olive",   ms: null,   stufen: [1, 11, 70, 300] },
};
const STUFEN_TXT = ["keine", "schwach", "mässig", "stark", "sehr stark"];
const stufe = (wert, s) => s.filter(g => wert >= g).length;

async function pollenPrognose(geo, wanted, today, nowHour) {
  const omKeys = wanted.map(([, p]) => p.om).filter(Boolean);
  if (!omKeys.length) return {};
  const d = await getJson(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&hourly=${omKeys.map(k => `${k}_pollen`).join(",")}&forecast_days=2&timezone=Europe%2FZurich`
  );
  const times = d.hourly?.time || [], out = {};
  for (const k of omKeys) {
    const vals = d.hourly?.[`${k}_pollen`] || [];
    let heute = 0, morgen = 0;
    times.forEach((t, i) => {
      const v = vals[i] || 0;
      if (t.startsWith(today)) { if (t.slice(0, 13) >= nowHour) heute = Math.max(heute, v); }
      else morgen = Math.max(morgen, v);
    });
    out[k] = { heute, morgen };
  }
  return out;
}

async function pollen(geo, arten, today, nowHour, station, fehler) {
  const wanted = Object.entries(POLLEN).filter(([, p]) => !arten || p.keys.some(k => arten.toLowerCase().includes(k)));
  if (!wanted.length) return { aktiv: false, arten: [], max: 0, max_txt: "keine" };
  const [prog, mess] = await Promise.allSettled([
    pollenPrognose(geo, wanted, today, nowHour),
    wanted.some(([, p]) => p.ms) ? msPollen(station) : Promise.resolve(null),
  ]);
  if (prog.status === "rejected") fehler.push(`pollen (Open-Meteo): ${prog.reason?.message || prog.reason}`);
  if (mess.status === "rejected") fehler.push(`pollen (MeteoSchweiz): ${mess.reason?.message || mess.reason}`);
  const P = prog.status === "fulfilled" ? prog.value : {};
  const M = mess.status === "fulfilled" ? mess.value : null;
  if (prog.status === "rejected" && !M) throw new Error("keine Pollendaten");

  const list = wanted.map(([, p]) => {
    let gemessen = M && p.ms && M.werte[p.ms] != null ? M.werte[p.ms] : null;
    if (gemessen != null && gemessen < 3) gemessen = 0;   // Rauschgrenze: vereinzelte Körner ausserhalb der Saison
    const heuteWert = gemessen ?? (p.om && P[p.om] ? P[p.om].heute : null);
    const morgenWert = p.om && P[p.om] ? P[p.om].morgen : null;
    const sh = heuteWert == null ? 0 : stufe(heuteWert, p.stufen);
    const sm = morgenWert == null ? 0 : stufe(morgenWert, p.stufen);
    return { name: p.name, wert: heuteWert == null ? null : Math.round(heuteWert), gemessen: gemessen != null,
      heute: sh, heute_txt: heuteWert == null ? "–" : STUFEN_TXT[sh],
      morgen: sm, morgen_txt: morgenWert == null ? "–" : STUFEN_TXT[sm], morgen_na: morgenWert == null };
  }).filter(p => p.wert != null || !p.morgen_na)
    .sort((a, b) => b.heute - a.heute || b.morgen - a.morgen);

  const max = Math.max(0, ...list.map(p => p.heute));
  const aktiv = list.some(p => p.heute > 0 || p.morgen > 0);
  return { aktiv, arten: list, max, max_txt: STUFEN_TXT[max],
    quelle_ms: !!M, station: M ? M.station : null, stand: M ? M.stand : null, ms_debug: M ? M.debug : null };
}

// ---------- MeteoSchweiz Open Data (Quelle: MeteoSchweiz) ----------
// Lokalprognose: eine CSV pro Parameter mit allen ~6000 Orten der Schweiz. Wir nehmen nur die kleinen
// Tagesdateien (Min/Max, Niederschlag, Wettersymbol); die Stundendateien (~30 MB) sind für Serverless zu gross.
// Pollen: Messwerte der Station (z. B. PZH = Zürich), stündlich, Datei «now».
const MS_FC = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-local-forecasting";
const MS_POLLEN = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-pollen";
const MS_TAGESPARAM = { max: "tre200dx", min: "tre200dn", regen: "rka150d0", symbol: "jp2000d0" };

async function getLatin1(url, timeout = 3500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "TRMNL-Dashboard" } });
  if (!res.ok) throw new Error(`${res.status} ${url.split("/").pop()}`);
  return Buffer.from(await res.arrayBuffer()).toString("latin1");
}

// CSV (Semikolon) → { head: [kleingeschrieben], rows: Iterator über Zeilen-Arrays }
function csvHead(text) {
  const nl = text.indexOf("\n");
  const head = text.slice(0, nl < 0 ? text.length : nl).replace(/^﻿/, "").replace(/\r$/, "").split(";").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
  return { head, body: nl < 0 ? "" : text.slice(nl + 1) };
}
const col = (head, ...res) => { for (const re of res) { const i = head.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
const num = v => { if (v == null) return null; v = String(v).trim().replace(/^"|"$/g, ""); if (v === "" || v === "-") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Datumswert → "YYYY-MM-DD" (unterstützt 202610240000, 2026-10-24…, 24.10.2026 …)
function msDate(v) {
  v = String(v || "").trim().replace(/^"|"$/g, "");
  let m;
  if ((m = v.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/))) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
function msDateTimeMs(v) {
  v = String(v || "").trim().replace(/^"|"$/g, "");
  let m;
  if ((m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if ((m = v.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/))) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return null;
}

// Punkt für eine Postleitzahl aus ogd-local-forecasting_meta_point.csv suchen
async function msPunkt(plz) {
  const { head, body } = csvHead(await getLatin1(`${MS_FC}/ogd-local-forecasting_meta_point.csv`, 3000));
  const iId = col(head, /^point_id$/), iTyp = col(head, /^point_type_id$/);
  const iPlz = col(head, /postal|plz|zip/), iName = col(head, /^point_name$/, /name/);
  const iTypTxt = col(head, /point_type_(de|en)$/, /point_type_(?!id)/);
  if (iId < 0) throw new Error(`meta_point: Spalte point_id fehlt (${head.join(",")})`);
  let best = null;
  for (const line of body.split("\n")) {
    if (!line.includes(plz)) continue;
    const f = line.replace(/\r$/, "").split(";").map(x => x.trim().replace(/^"|"$/g, ""));
    const hit = (iPlz >= 0 && f[iPlz] === plz) || (iName >= 0 && (f[iName] === plz || f[iName].startsWith(plz + " ")));
    if (!hit) continue;
    const istPlz = iTypTxt >= 0 ? /post|zip|plz/i.test(f[iTypTxt]) : true;
    const cand = { pid: f[iId], typ: iTyp >= 0 ? f[iTyp] : null, name: iName >= 0 ? f[iName] : plz };
    if (istPlz) return cand;
    best = best || cand;
  }
  if (!best) throw new Error(`meta_point: PLZ ${plz} nicht gefunden`);
  return best;
}

// Neuesten verfügbaren Prognoselauf finden (Läufe stündlich, Zeit in UTC)
async function msLauf(param) {
  const now = Date.now();
  const kandidaten = [0, 1, 2, 3, 4, 5].map(k => {
    const t = new Date(now - k * 3600000);
    const ymd = `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}`;
    const stamp = `${ymd}${pad2(t.getUTCHours())}00`;
    return { stamp, url: (p) => `${MS_FC}/${ymd}-ch/vnut12.lssw.${stamp}.${p}.csv` };
  });
  const tests = await Promise.all(kandidaten.map(k =>
    fetch(k.url(param), { method: "HEAD", signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false)));
  const i = tests.findIndex(Boolean);
  if (i < 0) throw new Error("kein Prognoselauf der letzten 6 Stunden gefunden");
  return kandidaten[i];
}

// Werte eines Punktes aus einer Parameter-Datei → { "YYYY-MM-DD": wert }
function msWerte(text, param, punkt) {
  const { head, body } = csvHead(text);
  const iId = col(head, /^point_id$/), iTyp = col(head, /^point_type_id$/);
  const iDat = col(head, /^date$/, /date|time|zeit/);
  let iVal = head.indexOf(param.toLowerCase());
  if (iVal < 0) iVal = head.length - 1;
  if (iId < 0 || iDat < 0) throw new Error(`${param}: Spalten unklar (${head.join(",")})`);
  const out = {};
  for (const line of body.split("\n")) {
    if (!line.includes(punkt.pid)) continue;
    const f = line.replace(/\r$/, "").split(";");
    if (f[iId].trim().replace(/^"|"$/g, "") !== punkt.pid) continue;
    if (iTyp >= 0 && punkt.typ && f[iTyp].trim().replace(/^"|"$/g, "") !== punkt.typ) continue;
    const d = msDate(f[iDat]), v = num(f[iVal]);
    if (d && v != null) out[d] = v;
  }
  return out;
}

async function msTage(plz) {
  const [punkt, lauf] = await Promise.all([msPunkt(plz), msLauf(MS_TAGESPARAM.max)]);
  const keys = Object.keys(MS_TAGESPARAM);
  const texte = await Promise.all(keys.map(k => getLatin1(lauf.url(MS_TAGESPARAM[k]))));
  const werte = {};
  keys.forEach((k, i) => { werte[k] = msWerte(texte[i], MS_TAGESPARAM[k], punkt); });
  const tage = Object.keys(werte.max).sort().map(date => ({
    date, max: werte.max[date], min: werte.min[date] ?? null, regen: werte.regen[date] ?? null, symbol: werte.symbol[date] ?? null }));
  if (!tage.length) throw new Error(`keine Tageswerte für Punkt ${punkt.pid}`);
  return { tage, lauf: lauf.stamp, punkt };
}

// MeteoSchweiz-Wettersymbole (1–42 Tag, 101–142 Nacht) → unsere Piktogramme
function msIcon(code) {
  if (code == null) return null;
  const c = code > 100 ? code - 100 : code;
  if (c === 1) return "sun";
  if ([2, 3, 26].includes(c)) return "partly";
  if ([4, 5, 27, 35].includes(c)) return "cloud";
  if (c === 28) return "fog";
  if ([6, 9, 29, 32, 33].includes(c)) return "shower";
  if ([14, 17, 20].includes(c)) return "rain";
  if ([7, 8, 10, 11, 15, 16, 18, 19, 21, 22, 30, 31, 34].includes(c)) return "snow";
  if ([12, 13, 23, 24, 25, 36, 37, 38, 39, 40, 41, 42].includes(c)) return "storm";
  return null;
}
const ICON_TXT = { sun: "Sonnig", partly: "Wolkig", cloud: "Bedeckt", fog: "Nebel", shower: "Schauer", rain: "Regen", snow: "Schnee", storm: "Gewitter" };

// MeteoSchweiz-Tageswerte in Wetter und Ausblick übernehmen (Open-Meteo bleibt, wo nichts passt)
function msZusammenfuehren(out, ms, today) {
  const omMax = {};
  (out.ausblick?.tage || []).forEach(t => { omMax[t.date] = t.max; });
  if (out.wetter?.daily?.temperature_2m_max?.[0] != null) omMax[today] = out.wetter.daily.temperature_2m_max[0];
  // Ob Tageswerte am Tagesbeginn oder -ende datiert sind, ist nicht dokumentiert: Variante mit besserer Übereinstimmung nehmen
  const plus = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
  const passung = shift => {
    const diffs = ms.tage.map(t => omMax[plus(t.date, shift)] == null ? null : Math.abs(omMax[plus(t.date, shift)] - t.max)).filter(x => x != null);
    return diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : Infinity;
  };
  const shift = passung(-1) < passung(0) - 0.5 ? -1 : 0;
  const byDate = {};
  ms.tage.forEach(t => { byDate[plus(t.date, shift)] = t; });

  const h = byDate[today];
  if (h && out.wetter?.daily) {
    if (h.max != null) out.wetter.daily.temperature_2m_max[0] = h.max;
    if (h.min != null) out.wetter.daily.temperature_2m_min[0] = h.min;
    out.wetter.quelle_tag = "MeteoSchweiz";
  }
  let n = 0;
  (out.ausblick?.tage || []).forEach(t => {
    const m = byDate[t.date];
    if (!m) return;
    n++;
    if (m.max != null) t.max = Math.round(m.max);
    if (m.min != null) t.min = Math.round(m.min);
    if (m.regen != null) {
      const r = m.regen;
      t.regen_txt = r < 0.1 ? "0 mm" : r < 1 ? "<1 mm" : `${Math.round(r)} mm`;
      t.regen_hi = r >= 2;
    }
    const ic = msIcon(m.symbol);
    if (ic) { t.icon = ic; t.txt = ICON_TXT[ic]; }
    t.quelle = "MeteoSchweiz";
  });
  return { lauf: ms.lauf, punkt: ms.punkt.pid, punkt_typ: ms.punkt.typ, verschiebung: shift, tage_uebernommen: n, heute: !!h };
}

// Pollen-Messwerte einer Station: Mittel der letzten 24 Stundenwerte je Pollenart
async function msPollen(station) {
  const st = station.toLowerCase();
  const { head, body } = csvHead(await getLatin1(`${MS_POLLEN}/${st}/ogd-pollen_${st}_h_now.csv`, 3000));
  const iTs = col(head, /reference_timestamp/, /timestamp|date|time|zeit/);
  if (iTs < 0) throw new Error(`Pollen: Zeitspalte fehlt (${head.join(",")})`);
  const gattungen = ["cory", "alnu", "betu", "frax", "fagu", "quer", "poac"];
  const idx = {};
  for (const g of gattungen) {
    const cands = head.map((h, i) => [h, i]).filter(([h]) => h.includes(g));
    const best = cands.find(([h]) => /h0$/.test(h)) || cands[0];
    if (best) idx[g] = best[1];
  }
  if (!Object.keys(idx).length) throw new Error(`Pollen: keine bekannten Spalten (${head.join(",")})`);
  const rows = body.split("\n").map(l => l.replace(/\r$/, "").split(";")).filter(f => f.length > 1)
    .map(f => ({ t: msDateTimeMs(f[iTs]), f })).filter(r => r.t != null).sort((a, b) => a.t - b.t);
  const werte = {};
  for (const [g, i] of Object.entries(idx)) {
    const v = rows.map(r => num(r.f[i])).filter(x => x != null).slice(-24);
    werte[g] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }
  const last = rows.length ? rows[rows.length - 1].t : null;
  return { station: station.toUpperCase(), werte, stand: last ? new Date(last).toISOString() : null,
    debug: Object.fromEntries(Object.entries(idx).map(([g, i]) => [g, head[i]])) };
}

// ---------- Ausblick (wenn keine Pollen): nächste Tage, Feiertag, Mond ----------
const WD_LANG = WD;
const kurzWetter = c =>
  c <= 1 ? "Sonnig" : c === 2 ? "Wolkig" : c === 3 ? "Bedeckt" : c <= 48 ? "Nebel" : c <= 57 ? "Niesel" :
  c <= 67 ? "Regen" : c <= 77 ? "Schnee" : c <= 82 ? "Schauer" : c <= 86 ? "Schnee" : "Gewitter";
const tageBis = (date, today) => Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
const labelDatum = date => { const d = new Date(date + "T12:00:00Z"); return `${WD_LANG[d.getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}.`; };

async function naechsteTage(geo) {
  const d = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&timezone=Europe%2FZurich` +
    `&daily=weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max&forecast_days=5`
  );
  const t = d.daily || {};
  return (t.time || []).slice(1, 5).map((date, j) => {
    const i = j + 1, dt = new Date(date + "T12:00:00Z");
    const regen = t.precipitation_probability_max?.[i] ?? 0;
    return { date, wd: WD_LANG[dt.getUTCDay()], txt: kurzWetter(t.weather_code?.[i] ?? 3), icon: iconKind(t.weather_code?.[i]),
      min: Math.round(t.temperature_2m_min?.[i] ?? 0), max: Math.round(t.temperature_2m_max?.[i] ?? 0),
      regen, regen_txt: `${regen}%`, regen_hi: regen >= 50, quelle: "Open-Meteo" };
  });
}

async function feiertag(today) {
  const bis = new Date(Date.parse(today) + 366 * 86400000).toISOString().slice(0, 10);
  const d = await getJson(
    `https://openholidaysapi.org/PublicHolidays?countryIsoCode=CH&subdivisionCode=CH-ZH&languageIsoCode=DE&validFrom=${today}&validTo=${bis}`
  );
  const h = (Array.isArray(d) ? d : []).filter(x => x.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (!h) return null;
  const name = (h.name || []).find(n => n.language === "DE")?.text || h.name?.[0]?.text || "Feiertag";
  const tage = tageBis(h.startDate, today);
  return { name, tage, wann: tage === 1 ? "morgen" : labelDatum(h.startDate) };
}

function mond(nowMs, today) {
  const SYN = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14); // Neumond als Referenz
  const age = (((nowMs - ref) / 86400000) % SYN + SYN) % SYN;   // Tage seit letztem Neumond
  const phasen = ["Neumond", "zunehmende Sichel", "erstes Viertel", "zunehmender Mond", "Vollmond", "abnehmender Mond", "letztes Viertel", "abnehmende Sichel"];
  const phase = phasen[Math.floor(((age / SYN) * 8 + 0.5)) % 8];
  const bisVoll = (SYN / 2 - age + SYN) % SYN, bisNeu = SYN - age;
  const [naechster, tageGenau] = bisVoll < bisNeu ? ["Vollmond", bisVoll] : ["Neumond", bisNeu];
  const date = new Date(nowMs + tageGenau * 86400000).toISOString().slice(0, 10);
  const tage = Math.max(0, tageBis(date, today));
  return { phase, naechster, tage, wann: tage === 0 ? "heute" : tage === 1 ? "morgen" : labelDatum(date) };
}

async function ausblick(geo, today) {
  const [tage, fei] = await Promise.allSettled([naechsteTage(geo), feiertag(today)]);
  return {
    tage: tage.status === "fulfilled" ? tage.value : [],
    feiertag: fei.status === "fulfilled" ? fei.value : null,
    mond: mond(Date.now(), today),
  };
}

// ---------- Kalender (Google «Privatadresse im iCal-Format») ----------
const KAL_TAGE = 30;      // so weit voraus
const KAL_MAX = 25;       // so viele Termine maximal liefern

const unesc = v => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
const pad2 = n => String(n).padStart(2, "0");
const DAYS_ICS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Lokale Zürcher Wanduhrzeit → Epoch (ms)
function localToEpoch(y, mo, d, h = 0, mi = 0, se = 0) {
  const wall = Date.UTC(y, mo, d, h, mi, se);
  return wall - zurichOffsetSec(wall - 3600000) * 1000;
}
// Epoch → lokale Komponenten
function epochToLocal(ms) {
  const t = new Date(ms + zurichOffsetSec(ms) * 1000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), se: t.getUTCSeconds() };
}
// ICS-Datumswert → { ms, allday, local }
function parseIcsDate(val, params) {
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  if (!m[4] || /VALUE=DATE(?!-)/.test(params)) return { allday: true, local: { y, mo, d, h: 0, mi: 0, se: 0 }, ms: localToEpoch(y, mo, d) };
  const [h, mi, se] = [+m[4], +m[5], +m[6]];
  if (m[7]) { const ms = Date.UTC(y, mo, d, h, mi, se); return { allday: false, ms, local: epochToLocal(ms) }; }
  // TZID oder «floating»: als Zürcher Zeit behandeln (für Schweizer Kalender passend)
  return { allday: false, local: { y, mo, d, h, mi, se }, ms: localToEpoch(y, mo, d, h, mi, se) };
}

function parseEvents(ics) {
  const text = ics.replace(/\r?\n[ \t]/g, "");
  const events = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const ev = { exdates: [] };
    for (const line of body.split(/\r?\n/)) {
      const i = line.indexOf(":"); if (i < 0) continue;
      const head = line.slice(0, i), val = line.slice(i + 1);
      const [name, ...ps] = head.split(";"); const params = ps.join(";");
      switch (name.toUpperCase()) {
        case "SUMMARY": ev.titel = unesc(val); break;
        case "LOCATION": ev.ort = unesc(val); break;
        case "UID": ev.uid = val.trim(); break;
        case "STATUS": ev.status = val.trim().toUpperCase(); break;
        case "DTSTART": ev.start = parseIcsDate(val, params); break;
        case "DTEND": ev.end = parseIcsDate(val, params); break;
        case "DURATION": {
          const d = val.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
          if (d) ev.durMs = ((+d[1] || 0) * 7 * 86400 + (+d[2] || 0) * 86400 + (+d[3] || 0) * 3600 + (+d[4] || 0) * 60 + (+d[5] || 0)) * 1000;
          break;
        }
        case "RRULE": ev.rrule = Object.fromEntries(val.split(";").map(kv => kv.split("="))); break;
        case "EXDATE": for (const v of val.split(",")) { const x = parseIcsDate(v, params); if (x) ev.exdates.push(x.ms); } break;
        case "RECURRENCE-ID": ev.recId = parseIcsDate(val, params)?.ms; break;
      }
    }
    if (ev.start && ev.status !== "CANCELLED") events.push(ev);
    else if (ev.start && ev.recId) events.push(ev); // abgesagte Einzeltermine einer Serie trotzdem merken
  }
  return events;
}

// Serientermine aufklappen (DAILY, WEEKLY, MONTHLY, YEARLY mit INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY)
function expand(ev, fromMs, toMs) {
  const dur = ev.end ? ev.end.ms - ev.start.ms : ev.durMs ?? (ev.start.allday ? 86400000 : 0);
  const mk = ms => ({ ms, dur });
  if (!ev.rrule) return [mk(ev.start.ms)];

  const r = ev.rrule, freq = r.FREQ, interval = +(r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseIcsDate(r.UNTIL, "").ms + (r.UNTIL.length === 8 ? 86399999 : 0) : Infinity;
  const L = ev.start.local, out = [];
  let n = 0;
  const push = (y, mo, d) => {
    const ms = ev.start.allday ? localToEpoch(y, mo, d) : localToEpoch(y, mo, d, L.h, L.mi, L.se);
    if (ms < ev.start.ms) return true;
    if (ms > until || n >= count || ms > toMs) return false;
    n++;
    if (ms + dur >= fromMs && !ev.exdates.some(x => Math.abs(x - ms) < 60000)) out.push(mk(ms));
    return true;
  };
  const byday = r.BYDAY ? r.BYDAY.split(",").map(x => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return { nth: m && m[1] ? +m[1] : 0, wd: m ? DAYS_ICS.indexOf(m[2]) : -1 }; }) : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null;

  for (let step = 0; step < 3000; step++) {
    let cont = true;
    if (freq === "DAILY") {
      const t = new Date(Date.UTC(L.y, L.mo, L.d + step * interval));
      cont = push(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    } else if (freq === "WEEKLY") {
      const startDow = new Date(Date.UTC(L.y, L.mo, L.d)).getUTCDay();
      const monday = Date.UTC(L.y, L.mo, L.d - ((startDow + 6) % 7) + step * 7 * interval);
      const days = (byday ? byday.map(b => b.wd) : [startDow]).map(wd => (wd + 6) % 7).sort((a, b) => a - b);
      for (const off of days) { const t = new Date(monday + off * 86400000); if (!(cont = push(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()))) break; }
    } else if (freq === "MONTHLY") {
      const base = new Date(Date.UTC(L.y, L.mo + step * interval, 1));
      const y = base.getUTCFullYear(), mo = base.getUTCMonth(), dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let ds = [];
      if (byday && byday.some(b => b.nth)) {
        for (const b of byday) {
          const all = []; for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === b.wd) all.push(d);
          const d = b.nth > 0 ? all[b.nth - 1] : all[all.length + b.nth]; if (d) ds.push(d);
        }
      } else ds = (bymd || [L.d]).map(d => (d < 0 ? dim + d + 1 : d)).filter(d => d >= 1 && d <= dim);
      for (const d of ds.sort((a, b) => a - b)) if (!(cont = push(y, mo, d))) break;
    } else if (freq === "YEARLY") {
      const y = L.y + step * interval;
      if (new Date(Date.UTC(y, L.mo, L.d)).getUTCMonth() === L.mo) cont = push(y, L.mo, L.d);
    } else break;
    if (!cont) break;
  }
  return out;
}

const fmtHM = ms => { const l = epochToLocal(ms); return `${pad2(l.h)}:${pad2(l.mi)}`; };
const localDate = ms => { const l = epochToLocal(ms); return `${l.y}-${pad2(l.mo + 1)}-${pad2(l.d)}`; };

async function kalender(quellen, today) {
  const nowMs = Date.now(), toMs = nowMs + KAL_TAGE * 86400000;
  const all = [], fehler = [];
  await Promise.all(quellen.map(async (q, qi) => {
    try {
      const res = await fetch(q.url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = parseEvents(await res.text());
      // Einzeln geänderte/abgesagte Termine einer Serie ersetzen die Serien-Instanz
      const overrides = new Set(events.filter(e => e.recId).map(e => `${e.uid}|${e.recId}`));
      for (const ev of events) {
        if (ev.status === "CANCELLED") continue;
        for (const o of expand(ev, nowMs, toMs)) {
          if (!ev.recId && overrides.has(`${ev.uid}|${o.ms}`)) continue;
          if (o.ms + o.dur <= nowMs || o.ms > toMs) continue;
          all.push({ ...o, ev, kal: q.name });
        }
      }
    } catch (e) { fehler.push(`Kalender ${qi + 1}: ${e.message}`); }  // URL bewusst nicht ausgeben (geheim)
  }));
  if (fehler.length && !all.length) throw new Error(fehler.join("; "));

  all.sort((a, b) => (a.ev.start.allday === b.ev.start.allday ? a.ms - b.ms : localDate(a.ms) === localDate(b.ms) ? (a.ev.start.allday ? -1 : 1) : a.ms - b.ms));
  const items = all.slice(0, KAL_MAX).map(({ ms, dur, ev, kal }) => {
    const allday = ev.start.allday;
    const tagDatum = allday && ms < nowMs ? today : localDate(ms);
    const tage = Math.round((Date.parse(tagDatum) - Date.parse(today)) / 86400000);
    const endDate = localDate(ms + dur - 1);
    const laufend = ms <= nowMs && nowMs < ms + dur;
    return {
      titel: ev.titel || "(ohne Titel)",
      ort: (ev.ort || "").split(",")[0],
      kal,
      ganztags: allday,
      tag: tage <= 0 ? "Heute" : tage === 1 ? "Morgen" : labelDatum(tagDatum),
      wd: tage <= 0 ? "Heute" : tage === 1 ? "Morgen" : WD[new Date(tagDatum + "T12:00:00Z").getUTCDay()],
      datum: `${tagDatum.slice(8, 10)}.${tagDatum.slice(5, 7)}.`,
      hl: tage <= 1,
      tag_key: tagDatum,
      zeit: allday ? "ganztags" : fmtHM(ms),
      bis: allday ? (endDate > tagDatum ? `bis ${labelDatum(endDate)}` : "") : fmtHM(ms + dur),
      start: ms, ende: ms + dur,
      in_min: laufend ? 0 : Math.round((ms - nowMs) / 60000),
      laufend,
    };
  });
  // Hauptermin: erster Termin mit Uhrzeit (laufend oder als Nächstes), sonst der erste überhaupt
  const hi = Math.max(0, items.findIndex(t => !t.ganztags));
  const hero = items[hi] || null;
  if (hero) {
    const m = hero.in_min;
    hero.label = hero.laufend && !hero.ganztags ? "Jetzt" : hero.wd === "Heute" || hero.wd === "Morgen" ? hero.wd : `${hero.wd} ${hero.datum}`;
    hero.countdown = hero.ganztags ? (hero.bis || "ganztags")
      : hero.laufend ? `bis ${hero.bis}`
      : `bis ${hero.bis} · ` + (m < 60 ? `in ${m} Min.` : m < 36 * 60 ? `in ${Math.round(m / 60)} Std.` : `in ${Math.round(m / 1440)} Tagen`);
  }
  const rest = items.filter((_, i) => i !== hi);
  return { hero, rest, termine: items, warnung: fehler.join("; ") };
}

// ---------- Netatmo (Hauptstation innen + Aussenmodul) ----------
// Netatmo erneuert bei jedem Token-Refresh auch den Refresh-Token und macht den alten ungültig.
// Darum merkt sich die Funktion die Tokens im Saved State von TRMNL (trmnl_state.netatmo).
// Wird im Formular ein neuer Refresh-Token eingetragen, hat dieser Vorrang (erkannt am Fingerabdruck).
const ntFp = s => (s ? s.slice(-8) : "");

async function netatmoToken(cfg, alt, neu) {
  const formNeu = !!cfg.refresh && ntFp(cfg.refresh) !== alt.fp;
  for (const k of Object.keys(neu)) delete neu[k];
  Object.assign(neu, formNeu ? { fp: ntFp(cfg.refresh) } : alt);
  if (!formNeu && alt.at && alt.exp > Date.now() + 120000) return alt.at; // Access-Token noch gültig
  const rt = formNeu ? cfg.refresh : (alt.rt || cfg.refresh);
  if (!rt) throw new Error("Refresh-Token fehlt im Formular");
  const res = await fetch("https://api.netatmo.com/oauth2/token", {
    method: "POST", signal: AbortSignal.timeout(3000),
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cfg.id, client_secret: cfg.secret }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Anmeldung ${res.status} ${j.error || ""} – neuen Refresh-Token ins Formular eintragen`);
  // Neue Tokens sofort festhalten; sie werden am Ende in jedem Fall gespeichert
  Object.assign(neu, { rt: j.refresh_token || rt, at: j.access_token, exp: Date.now() + (j.expires_in || 10800) * 1000 });
  return j.access_token;
}

async function netatmo(cfg, alt, neu) {
  if (!cfg.id || !cfg.secret) return null;
  const hole = at => fetch("https://api.netatmo.com/api/getstationsdata?get_favorites=false", {
    signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${at}` },
  });
  let res = await hole(await netatmoToken(cfg, alt, neu));
  if (res.status === 401 || res.status === 403) {          // Access-Token doch ungültig → einmal neu holen
    res = await hole(await netatmoToken(cfg, { ...neu, at: null, exp: 0 }, neu));
  }
  if (!res.ok) throw new Error(`Daten ${res.status}`);
  const dev = (await res.json()).body?.devices?.[0];
  if (!dev) throw new Error("keine Wetterstation im Konto");

  const fmt = v => (typeof v === "number" ? v.toFixed(1).replace(".", ",").replace("-", "−") : "–");
  const rnd = v => (typeof v === "number" ? String(Math.round(v)).replace("-", "−") : "–");
  const trend = t => (t === "up" ? "↑" : t === "down" ? "↓" : "");
  const werte = (d, ok) => (ok && d ? {
    temp: fmt(d.Temperature), trend: trend(d.temp_trend), feuchte: d.Humidity ?? "–",
    min: rnd(d.min_temp), max: rnd(d.max_temp), ts: d.time_utc || 0,
  } : null);

  const D = dev.dashboard_data;
  const mod = (dev.modules || []).find(m => m.type === "NAModule1");
  const innen = werte(D, dev.reachable !== false);
  const aussen = mod ? werte(mod.dashboard_data, mod.reachable !== false) : null;
  const co2 = typeof D?.CO2 === "number" ? D.CO2 : null;
  const ts = Math.max(innen?.ts || 0, aussen?.ts || 0);
  return {
    innen, aussen,
    aussen_fehlt: !mod ? "kein Modul" : !aussen ? "nicht erreichbar" : "",
    aussen_akku_tief: !!mod && typeof mod.battery_percent === "number" && mod.battery_percent < 15,
    co2, co2_stufe: co2 == null ? "–" : co2 < 1000 ? "gut" : co2 < 1400 ? "mässig" : "lüften!", co2_hoch: co2 != null && co2 >= 1400,
    ts, veraltet: ts > 0 && Date.now() / 1000 - ts > 1800,
  };
}

// ---------- News ----------
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .trim();
}

async function news(feed) {
  const xml = await getText(feed);
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].slice(0, 12);
  return items.map(m => {
    const tag = t => decode((m[0].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [, ""])[1]);
    const pubDate = tag("pubDate");
    // Vorspann in Grossbuchstaben wie «DIE NEUESTEN ENTWICKLUNGEN - » entfernen
    const title = tag("title").replace(/^[A-ZÄÖÜ0-9][A-ZÄÖÜ0-9 ,.'’«»"&/+-]{5,}\s+[-–—:]\s+/, "");
    return { title, lead: tag("description").slice(0, 400), pubDate, ts: Math.floor(Date.parse(pubDate) / 1000) || 0 };
  });
}

// ---------- Einstieg ----------
async function run(input) {
  const { today, hour, hourKey } = zurichNow(input);
  const plz = field(input, "plz", "8055");
  const ort = field(input, "ort", "Zürich");
  const quellen = [1, 2]
    .map(i => ({ url: field(input, `kalender_${i}`, "").replace(/^webcal:/i, "https:"), name: field(input, `kalender_${i}_name`, "") }))
    .filter(q => /^https?:\/\//i.test(q.url));
  const feed = field(input, "news_feed", "https://www.srf.ch/news/bnf/rss/19032223");
  const arten = field(input, "pollen_arten", "");
  const station = field(input, "pollen_station", "PZH").replace(/[^A-Za-z]/g, "").slice(0, 3) || "PZH";
  const fehler = [];
  const ntCfg = { id: field(input, "netatmo_client_id", ""), secret: field(input, "netatmo_client_secret", ""), refresh: field(input, "netatmo_refresh_token", "") };
  const state = input?.trmnl?.state || {};
  const ntAlt = state.netatmo || {};
  const ntNeu = { ...ntAlt };

  const geo = geocode(ort).catch(() => ({ lat: "47.364", lon: "8.505", name: "Zürich" }));
  const jobs = {
    abfall: abfall(plz, today, hour),
    wetter: geo.then(wetter),
    pollen: geo.then(g => pollen(g, arten, today, hourKey, station, fehler)),
    meteoschweiz: msTage(plz),
    ausblick: geo.then(g => ausblick(g, today)),
    kalender: quellen.length ? kalender(quellen, today) : Promise.resolve(null),
    news: news(feed),
    netatmo: netatmo(ntCfg, ntAlt, ntNeu),
  };
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(Object.values(jobs));

  const out = { fehler, zeit: { heute: today, stunde: hour, ...datumsKopf(today) } };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out[names[i]] = r.value;
    else { out[names[i]] = null; out.fehler.push(`${names[i]}: ${r.reason?.message || r.reason}`); }
  });
  // MeteoSchweiz-Tageswerte über Open-Meteo legen; ohne MeteoSchweiz bleibt alles bei Open-Meteo
  if (out.meteoschweiz) {
    try { out.meteoschweiz = msZusammenfuehren(out, out.meteoschweiz, today); }
    catch (e) { out.fehler.push(`meteoschweiz: ${e.message}`); out.meteoschweiz = null; }
  }
  out.quellen = [out.meteoschweiz || out.pollen?.quelle_ms ? "MeteoSchweiz" : null, "Open-Meteo"].filter(Boolean).join(", ");
  // Saved State immer vollständig zurückschreiben (was fehlt, wäre beim nächsten Lauf weg)
  out.trmnl_state = { ...state, netatmo: ntNeu };
  return out;
}

module.exports = { run };
