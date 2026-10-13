// DiamondStats Backend — servidor real que consulta la MLB Stats API
// (gratuita, sin llave: https://statsapi.mlb.com) y sirve datos frescos
// a la app, en vez de que alguien tenga que traerlos a mano.
//
// Cómo funciona:
// 1. Cada endpoint del frontend (standings, roster, pitchers) le pega a
//    ESTE servidor, no directo a MLB — así evitamos el bloqueo de CORS
//    que tiene el navegador para llamar APIs externas desde un artifact.
// 2. Este servidor sí puede llamar a statsapi.mlb.com libremente, porque
//    corre en Node, no en el navegador.
// 3. Los resultados se cachean en memoria por 15 minutos (CACHE_TTL_MS)
//    para no golpear la API de MLB en cada clic del usuario.

import express from "express";
import cors from "cors";

const app = express();
app.use(cors()); // permite que tu frontend (en otro dominio) le pegue a este servidor
app.use(express.json()); // para poder leer el body de las peticiones POST

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const cache = new Map();

// Calcula la fecha de "hoy" en la zona horaria del Este de EE.UU. (la que
// usa MLB oficialmente para definir su calendario del día) — usar UTC
// directo hacía que la app mostrara los juegos de MAÑANA cuando todavía
// era de noche hoy en EE.UU., porque UTC ya había cruzado la medianoche.
function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// ---- Conexión a Supabase (base de datos real de predicciones) ----
// La llave "publishable"/anon está diseñada para usarse así, del lado del
// servidor o del cliente — no es secreta, solo permite lo que las reglas
// de la base de datos autoricen.
const SUPABASE_URL = "https://apshtslmuynimzvxnmla.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwc2h0c2xtdXluaW16dnhubWxhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1Nzg5MjQsImV4cCI6MjEwMjE1NDkyNH0.3DWpv_GZsAxtx0-O8z90RuyfzlCT-YlxkxhIQZltoSA";
const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// Nombres reales de las 6 divisiones de MLB, por su id oficial en la
// MLB Stats API (confirmado en vivo vía /standings?leagueId=103,104).
const MLB_DIVISION_NAMES = {
  200: "AL Oeste", 201: "AL Este", 202: "AL Central",
  203: "NL Oeste", 204: "NL Este", 205: "NL Central",
};
const MLB_LEAGUE_NAMES = { 103: "Liga Americana", 104: "Liga Nacional" };

// IDs oficiales de los 30 equipos en la MLB Stats API
const TEAM_IDS = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, ATH: 133, PHI: 143,
  PIT: 134, SD: 135, SF: 137, SEA: 136, STL: 138, TB: 139, TEX: 140,
  TOR: 141, WSH: 120,
};
const TEAM_ID_TO_CODE = Object.fromEntries(Object.entries(TEAM_IDS).map(([code, id]) => [id, code]));

// Coordenadas aproximadas (nivel ciudad, suficiente para clima) de los 30
// estadios reales — usadas para consultar el clima real de cada partido.
const STADIUM_COORDS = {
  ARI: { lat: 33.4453, lon: -112.0667 }, ATL: { lat: 33.8908, lon: -84.4678 },
  BAL: { lat: 39.2839, lon: -76.6218 }, BOS: { lat: 42.3467, lon: -71.0972 },
  CHC: { lat: 41.9484, lon: -87.6553 }, CWS: { lat: 41.8299, lon: -87.6338 },
  CIN: { lat: 39.0979, lon: -84.5082 }, CLE: { lat: 41.4962, lon: -81.6852 },
  COL: { lat: 39.7559, lon: -104.9942 }, DET: { lat: 42.3390, lon: -83.0485 },
  HOU: { lat: 29.7573, lon: -95.3555 }, KC: { lat: 39.0517, lon: -94.4803 },
  LAA: { lat: 33.8003, lon: -117.8827 }, LAD: { lat: 34.0739, lon: -118.2400 },
  MIA: { lat: 25.7781, lon: -80.2196 }, MIL: { lat: 43.0280, lon: -87.9712 },
  MIN: { lat: 44.9817, lon: -93.2775 }, NYM: { lat: 40.7571, lon: -73.8458 },
  NYY: { lat: 40.8296, lon: -73.9262 }, ATH: { lat: 38.5802, lon: -121.5133 },
  PHI: { lat: 39.9061, lon: -75.1665 }, PIT: { lat: 40.4469, lon: -80.0057 },
  SD: { lat: 32.7073, lon: -117.1566 }, SF: { lat: 37.7786, lon: -122.3893 },
  SEA: { lat: 47.5914, lon: -122.3325 }, STL: { lat: 38.6226, lon: -90.1928 },
  TB: { lat: 27.7683, lon: -82.6534 }, TEX: { lat: 32.7473, lon: -97.0842 },
  TOR: { lat: 43.6414, lon: -79.3894 }, WSH: { lat: 38.8730, lon: -77.0074 },
};

// Traduce el "weather code" estándar (WMO) que usa Open-Meteo a una
// descripción y emoji simples.
function describeWeatherCode(code) {
  if (code === 0) return { desc: "Despejado", icon: "☀️" };
  if (code <= 2) return { desc: "Parcialmente nublado", icon: "⛅" };
  if (code === 3) return { desc: "Nublado", icon: "☁️" };
  if (code <= 48) return { desc: "Neblina", icon: "🌫️" };
  if (code <= 57) return { desc: "Llovizna", icon: "🌦️" };
  if (code <= 67) return { desc: "Lluvia", icon: "🌧️" };
  if (code <= 77) return { desc: "Nieve", icon: "🌨️" };
  if (code <= 82) return { desc: "Chubascos", icon: "🌦️" };
  if (code <= 99) return { desc: "Tormenta", icon: "⛈️" };
  return { desc: "Sin datos", icon: "🌡️" };
}

// Convierte una etiqueta de punto cardinal ("NW") a grados aproximados —
// el Servicio Meteorológico Nacional (NWS) da la dirección como texto, no
// en grados, así que hacemos la conversión inversa para dibujar la flecha.
function compassToDeg(label) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const i = dirs.indexOf(label);
  return i === -1 ? 0 : i * 22.5;
}

// Trae el clima real vía el National Weather Service (gobierno de EE.UU.,
// gratis, sin llave, y sin el problema de límites por IP compartida que
// tiene Open-Meteo en hosting gratuito). Solo cubre EE.UU. — Toronto usa
// Open-Meteo como respaldo, siendo el único equipo fuera de EE.UU.
async function fetchWeatherNWS(lat, lon, cacheKey, gameTimeISO) {
  // Cacheamos el pronóstico CRUDO completo (todas las horas), no el
  // resultado ya elegido — así, sin importar qué hora de juego pida cada
  // llamada, siempre se calcula fresco cuál período le corresponde,
  // incluso si dos juegos distintos en el mismo estadio (doble cartelera)
  // piden horas distintas el mismo rato.
  const rawCacheKey = `${cacheKey}-raw`;
  let forecast = cache.get(rawCacheKey)?.data;
  if (!forecast || Date.now() - cache.get(rawCacheKey).time >= WEATHER_CACHE_TTL_MS) {
    const headers = { "User-Agent": "DiamondStatsApp (proyecto personal de estadisticas MLB)" };
    const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
    const pointsRes = await fetch(pointsUrl, { headers });
    if (!pointsRes.ok) throw new Error(`Error ${pointsRes.status} consultando ${pointsUrl}`);
    const points = await pointsRes.json();
    const hourlyUrl = points.properties.forecastHourly;

    const forecastRes = await fetch(hourlyUrl, { headers });
    if (!forecastRes.ok) throw new Error(`Error ${forecastRes.status} consultando ${hourlyUrl}`);
    forecast = await forecastRes.json();
    cache.set(rawCacheKey, { data: forecast, time: Date.now() });
  }

  // Si nos dan la hora real del primer lanzamiento, buscamos el período
  // del pronóstico por hora más cercano a ESA hora — no solo "ahora
  // mismo". Esto importa de verdad para juegos que empiezan varias horas
  // después de que se consulta el clima (ej. juego nocturno consultado
  // en la tarde).
  let period = forecast.properties.periods[0];
  if (gameTimeISO) {
    const gameTime = new Date(gameTimeISO).getTime();
    let closest = period;
    let closestDiff = Math.abs(new Date(period.startTime).getTime() - gameTime);
    for (const p of forecast.properties.periods) {
      const diff = Math.abs(new Date(p.startTime).getTime() - gameTime);
      if (diff < closestDiff) {
        closest = p;
        closestDiff = diff;
      }
    }
    period = closest;
  }
  const now = period;

  const windMph = parseFloat(now.windSpeed) || 0; // viene como texto "10 mph"
  return {
    tempF: now.temperature,
    humidity: now.relativeHumidity?.value ?? null,
    windMph,
    windDir: now.windDirection,
    windDirDeg: compassToDeg(now.windDirection),
    pop: now.probabilityOfPrecipitation?.value ?? 0,
    description: now.shortForecast,
    icon: iconForForecast(now.shortForecast),
    forecastFor: now.startTime, // hora real a la que corresponde este pronóstico, para mostrarlo honestamente
  };
}

// Traduce la descripción corta del NWS a un ícono simple.
function iconForForecast(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("thunder") || t.includes("storm")) return "⛈️";
  if (t.includes("snow")) return "🌨️";
  if (t.includes("rain") || t.includes("shower")) return "🌧️";
  if (t.includes("fog")) return "🌫️";
  if (t.includes("cloud") && t.includes("mostly")) return "☁️";
  if (t.includes("cloud")) return "⛅";
  if (t.includes("clear") || t.includes("sunny")) return "☀️";
  return "🌤️";
}

// Convierte grados de dirección del viento (0-360) a un punto cardinal
// legible, tipo "NNW".
function windDirectionLabel(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

async function cachedFetch(key, url, ttlMs = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error ${res.status} consultando ${url}`);
  const data = await res.json();
  cache.set(key, { data, time: Date.now() });
  return data;
}

const WEATHER_CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutos — el clima no cambia tan rápido, y así evitamos el límite de Open-Meteo

// ---- GET /api/standings ----
// Récords reales de los 30 equipos, actualizados en vivo.
app.get("/api/standings", async (req, res) => {
  try {
    const data = await cachedFetch(
      "standings",
      `${MLB_API}/standings?leagueId=103,104&season=${new Date().getFullYear()}`
    );
    const teams = [];
    for (const record of data.records) {
      for (const t of record.teamRecords) {
        teams.push({
          teamId: t.team.id,
          name: t.team.name,
          w: t.wins,
          l: t.losses,
          wpct: parseFloat(t.winningPercentage),
          runsScored: t.runsScored ?? null,
          runsAllowed: t.runsAllowed ?? null,
        });
      }
    }
    res.json({ updated: new Date().toISOString(), teams });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/hitters ----
// Trae el split REAL de un jugador contra zurdos y derechos. El formato
// correcto de la MLB API es stats=statSplits con UN sitCode por llamada
// (probamos combinarlos con coma y con stats=season, ninguno funcionaba —
// esta es la combinación que sí responde con el split real). Se cachea
// por jugador y situación para no repetir la llamada en cada visita.
async function fetchOneSplit(personId, sitCode) {
  try {
    const data = await cachedFetch(
      `split-${personId}-${sitCode}`,
      `${MLB_API}/people/${personId}/stats?stats=statSplits&group=hitting&sitCodes=${sitCode}`
    );
    const block = data.stats?.[0]?.splits?.[0]?.stat;
    if (!block || block.atBats == null || block.atBats < 15) return null; // muestra muy chica, mejor no mostrarla
    return {
      ab: block.atBats,
      avg: block.avg != null ? parseFloat(block.avg) : null,
      ops: block.ops != null ? parseFloat(block.ops) : null,
    };
  } catch {
    return null; // si falla para un jugador puntual, no rompe el resto del equipo
  }
}
async function fetchPlayerSplits(personId) {
  const [vsL, vsR, day, night] = await Promise.all([
    fetchOneSplit(personId, "vl"),
    fetchOneSplit(personId, "vr"),
    fetchOneSplit(personId, "d"),
    fetchOneSplit(personId, "n"),
  ]);
  return { vsL, vsR, vsDay: day, vsNight: night };
}

// ---- Ajuste real de BABIP: temporada vs. carrera ----
// El promedio de bateo se ve afectado por suerte real (BABIP), pero a
// diferencia de los pitchers, los bateadores SÍ tienen control real
// sobre su BABIP (uno rápido de contacto sostiene BABIP alto de verdad,
// uno lento de poder lo tiene bajo de verdad) — por eso NO se corrige
// hacia el promedio de LIGA, sino hacia el promedio de CARRERA de ESE
// bateador específico. Solo se ajusta la parte de jonrones para afuera
// (que no depende de BABIP), dejando ponches y jonrones como valores
// reales observados esta temporada (esos sí son habilidad estable).
async function fetchBabipAdjustedAvg(personId, seasonStats) {
  try {
    const data = await cachedFetch(
      `career-hitting-${personId}`,
      `${MLB_API}/people/${personId}/stats?stats=career&group=hitting`,
      24 * 60 * 60 * 1000 // 24h — las estadísticas de carrera casi no cambian de un día a otro
    );
    const career = data.stats?.[0]?.splits?.[0]?.stat;
    // Se requiere muestra de carrera real y suficiente (200+ turnos) —
    // sin eso, no hay un "nivel personal" confiable con qué comparar.
    if (!career?.atBats || career.atBats < 200) return null;

    const seasonBIP = seasonStats.atBats - (seasonStats.strikeOuts ?? 0) - (seasonStats.homeRuns ?? 0);
    const careerBIP = career.atBats - (career.strikeOuts ?? 0) - (career.homeRuns ?? 0);
    if (seasonBIP <= 0 || careerBIP <= 0) return null;

    const seasonBabip = (seasonStats.hits - (seasonStats.homeRuns ?? 0)) / seasonBIP;
    const careerBabip = (career.hits - (career.homeRuns ?? 0)) / careerBIP;

    // Punto de estabilización real (~400 bolas en juego), basado en
    // investigación sabermétrica sobre cuándo el BABIP de un bateador
    // se vuelve confiable — con poca muestra esta temporada, pesa más
    // su nivel real de carrera; con mucha, pesa más lo de este año.
    const STABILIZATION_POINT = 400;
    const seasonWeight = seasonBIP / (seasonBIP + STABILIZATION_POINT);
    const blendedBabip = seasonBabip * seasonWeight + careerBabip * (1 - seasonWeight);

    const blendedNonHrHits = blendedBabip * seasonBIP;
    const blendedTotalHits = blendedNonHrHits + (seasonStats.homeRuns ?? 0);
    return blendedTotalHits / seasonStats.atBats;
  } catch {
    return null;
  }
}

// El objeto "probablePitcher" que devuelve el calendario NO incluye su
// mano de lanzar por defecto — hay que pedirla aparte, igual que hicimos
// con los splits de los bateadores.
async function fetchPitcherHand(personId) {
  try {
    const data = await cachedFetch(`hand-${personId}`, `${MLB_API}/people/${personId}`);
    return data.people?.[0]?.pitchHand?.code || null;
  } catch {
    return null;
  }
}

// El hydrate anidado "probablePitcher(stats(...))" NO funciona de verdad
// — la respuesta de la MLB API no trae stats adentro, aunque se lo
// pidamos (confirmado con un diagnóstico real). Igual que con la mano,
// la solución real es una llamada separada y dedicada por pitcher.
// Convierte el formato real de entradas lanzadas de MLB ("123.1" =
// 123 entradas + 1 out = 123.333, NO 123.1 decimal) a un número decimal
// correcto.
function parseInningsPitched(ipStr) {
  if (ipStr == null) return null;
  const ip = parseFloat(ipStr);
  const whole = Math.floor(ip);
  const outs = Math.round((ip - whole) * 10); // 0, 1, o 2
  return whole + outs / 3;
}

// ERA real, mezclado con FIP real (70% FIP + 30% ERA) — evidencia real
// de múltiples fuentes profesionales confirma que FIP predice mejor el
// futuro que ERA solo, porque ERA se ve afectado por suerte (BABIP) y
// la defensa del equipo, mientras FIP solo mide lo que el pitcher
// controla directamente: ponches, bases por bola, y jonrones.
// Constante de FIP aproximada (~3.10), estándar en la era moderna.
async function fetchPitcherEra(personId) {
  try {
    const season = new Date().getFullYear();
    const data = await cachedFetch(
      `era-${personId}-${season}`,
      `${MLB_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat?.era) return null;
    const era = parseFloat(stat.era);

    const ip = parseInningsPitched(stat.inningsPitched);
    if (!ip || ip <= 0) return era; // sin entradas suficientes para calcular FIP real, se usa solo ERA

    const FIP_CONSTANT = 3.10;
    const hr = stat.homeRuns ?? 0;
    const bb = stat.baseOnBalls ?? 0;
    const hbp = stat.hitBatsmen ?? 0;
    const k = stat.strikeOuts ?? 0;
    const fip = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + FIP_CONSTANT;

    return fip * 0.7 + era * 0.3;
  } catch {
    return null;
  }
}

// Bateadores reales de un equipo con sus stats actuales de temporada.
app.get("/api/team/:code/hitters", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const data = await cachedFetch(
      `hitters-${teamId}`,
      `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting))`
    );
    const rawHitters = data.roster
      .filter((p) => p.position.abbreviation !== "P")
      .map((p) => {
        const s = p.person.stats?.[0]?.splits?.[0]?.stat || {};
        return {
          id: p.person.id,
          name: p.person.fullName,
          pos: p.position.abbreviation,
          bats: p.person.batSide?.code || null, // "L" | "R" | "S" (switch) | null si no viene
          g: s.gamesPlayed, ab: s.atBats, h: s.hits,
          doubles: s.doubles, triples: s.triples, hr: s.homeRuns,
          rbi: s.rbi, strikeOuts: s.strikeOuts,
          avg: s.avg != null ? parseFloat(s.avg) : null,
          obp: s.obp != null ? parseFloat(s.obp) : null,
          slg: s.slg != null ? parseFloat(s.slg) : null,
          ops: s.ops != null ? parseFloat(s.ops) : null,
        };
      })
      .filter((p) => p.ab > 0 && p.avg != null && !Number.isNaN(p.avg));

    // Trae el split real de cada bateador en paralelo (uno por jugador).
    // El ajuste de BABIP se movió a un endpoint aparte, bajo demanda
    // (/api/player/:id/babip-adjusted) — consultarlo para el roster
    // COMPLETO de todos los equipos jugando hoy era muy pesado para
    // Picks del día, que necesita a todos, no solo a los 2 de un juego.
    const splitsResults = await Promise.all(rawHitters.map((p) => fetchPlayerSplits(p.id)));
    const hitters = rawHitters.map((p, i) => ({
      ...p,
      vsL: splitsResults[i].vsL, vsR: splitsResults[i].vsR,
      vsDay: splitsResults[i].vsDay, vsNight: splitsResults[i].vsNight,
    }));

    res.json({ updated: new Date().toISOString(), hitters });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/pitchers ----
// Pitchers reales de un equipo con sus stats actuales de temporada.
app.get("/api/team/:code/pitchers", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const data = await cachedFetch(
      `pitchers-${teamId}`,
      `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=pitching))`
    );
    const pitchers = data.roster
      .filter((p) => p.position.abbreviation === "P")
      .map((p) => {
        const s = p.person.stats?.[0]?.splits?.[0]?.stat || {};
        return {
          name: p.person.fullName,
          pos: p.position.abbreviation,
          throws: p.person.pitchHand?.code || null, // "L" | "R" | null si no viene
          g: s.gamesPlayed, gs: s.gamesStarted,
          w: s.wins, l: s.losses, so: s.strikeOuts,
          era: s.era != null ? parseFloat(s.era) : null,
          whip: s.whip != null ? parseFloat(s.whip) : null,
          ip: s.inningsPitched, k9: s.strikeoutsPer9Inn != null ? parseFloat(s.strikeoutsPer9Inn) : null,
        };
      })
      .filter((p) => p.ip && parseFloat(p.ip) > 0);
    res.json({ updated: new Date().toISOString(), pitchers });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/probable-pitchers?date=YYYY-MM-DD ----
// Abridores probables REALES para una fecha específica — esto es lo que
// resuelve el "próxima fase" que quedó pendiente en el prototipo: ya no
// es el as de referencia, es quien de verdad lanza ese día.
app.get("/api/probable-pitchers", async (req, res) => {
  const date = req.query.date || todayET();
  try {
    const data = await cachedFetch(
      `probables-${date}`,
      `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`
    );
    const pitcherInfo = async (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null, id: null };
      const [hand, era] = await Promise.all([
        p.pitchHand?.code ? Promise.resolve(p.pitchHand.code) : (p.id ? fetchPitcherHand(p.id) : Promise.resolve(null)),
        p.id ? fetchPitcherEra(p.id) : Promise.resolve(null),
      ]);
      return { name: p.fullName, hand, era, id: p.id ?? null };
    };
    const rawGames = data.dates?.[0]?.games || [];
    const games = await Promise.all(
      rawGames.map(async (g) => {
        const home = await pitcherInfo(g.teams.home.probablePitcher);
        const away = await pitcherInfo(g.teams.away.probablePitcher);
        return {
          home: g.teams.home.team.name,
          away: g.teams.away.team.name,
          venue: g.venue?.name,
          time: g.gameDate,
          homePitcher: home.name, homePitcherHand: home.hand, homePitcherEra: home.era, homePitcherId: home.id,
          awayPitcher: away.name, awayPitcherHand: away.hand, awayPitcherEra: away.era, awayPitcherId: away.id,
        };
      })
    );
    res.json({ date, updated: new Date().toISOString(), games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DiamondStats backend corriendo en puerto ${PORT}`));

// ---- GET /api/games/today ----
// Lista de todos los juegos reales programados para hoy (o la fecha que se
// pida), con el ID de juego (gamePk) que se necesita para pedir su
// alineación después.
app.get("/api/games/today", async (req, res) => {
  const date = req.query.date || todayET();
  try {
    const data = await cachedFetch(
      `games-today-${date}`,
      `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`
    );
    const pitcherInfo = async (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null, id: null };
      const [hand, era] = await Promise.all([
        p.pitchHand?.code ? Promise.resolve(p.pitchHand.code) : (p.id ? fetchPitcherHand(p.id) : Promise.resolve(null)),
        p.id ? fetchPitcherEra(p.id) : Promise.resolve(null),
      ]);
      return { name: p.fullName, hand, era, id: p.id ?? null };
    };
    const rawGames = data.dates?.[0]?.games || [];
    const games = await Promise.all(
      rawGames.map(async (g) => ({
        gamePk: g.gamePk,
        home: g.teams.home.team.name,
        homeCode: TEAM_ID_TO_CODE[g.teams.home.team.id] || null,
        away: g.teams.away.team.name,
        awayCode: TEAM_ID_TO_CODE[g.teams.away.team.id] || null,
        venue: g.venue?.name,
        time: g.gameDate,
        dayNight: g.dayNight, // "day" | "night" — dato real de MLB, no calculado por nosotros
        status: g.status?.detailedState || null,
        homePitcher: await pitcherInfo(g.teams.home.probablePitcher),
        awayPitcher: await pitcherInfo(g.teams.away.probablePitcher),
      }))
    );
    res.json({ date, updated: new Date().toISOString(), games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/game/:gamePk/lineup ----
// Alineación titular real de ambos equipos para un juego específico.
// IMPORTANTE: las alineaciones oficiales normalmente se publican solo
// ~2 horas antes del primer lanzamiento — si el juego es más tarde, esto
// puede venir vacío todavía, y se lo dejamos explícito en la respuesta.
app.get("/api/game/:gamePk/lineup", async (req, res) => {
  const { gamePk } = req.params;
  try {
    const data = await cachedFetch(
      `lineup-${gamePk}`,
      `${MLB_API}/game/${gamePk}/boxscore`
    );
    const buildLineup = (teamSide) => {
      const team = data.teams?.[teamSide];
      if (!team) return [];
      const order = team.battingOrder || [];
      return order
        .map((playerId) => team.players?.[`ID${playerId}`])
        .filter(Boolean)
        .map((p) => ({
          name: p.person?.fullName,
          pos: p.position?.abbreviation,
        }));
    };
    const home = buildLineup("home");
    const away = buildLineup("away");
    res.json({
      gamePk,
      updated: new Date().toISOString(),
      available: home.length > 0 || away.length > 0,
      home,
      away,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/weather/:code ----
// Clima real ahora mismo en el estadio de ese equipo — usa Open-Meteo
// (gratuita, sin llave, como la MLB Stats API).
app.get("/api/weather/:code", async (req, res) => {
  const code = req.params.code.toUpperCase();
  const coords = STADIUM_COORDS[code];
  if (!coords) return res.status(404).json({ error: "Código de equipo no reconocido" });
  const gameTime = req.query.gameTime || null; // ISO real del primer lanzamiento, si se conoce

  try {
    let data;
    if (code === "TOR") {
      // Único equipo fuera de EE.UU. — el NWS no cubre Canadá, usa Open-Meteo.
      // Pide el pronóstico POR HORA (no solo "ahora") para poder elegir la
      // hora real del juego, igual que hacemos con NWS.
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2`;
      const raw = await cachedFetch(`weather-${code}`, url, WEATHER_CACHE_TTL_MS);
      const times = raw.hourly.time;
      let idx = 0;
      if (gameTime) {
        const gameMs = new Date(gameTime).getTime();
        let closestDiff = Infinity;
        times.forEach((t, i) => {
          const diff = Math.abs(new Date(t).getTime() - gameMs);
          if (diff < closestDiff) { closestDiff = diff; idx = i; }
        });
      }
      const w = describeWeatherCode(raw.hourly.weather_code[idx]);
      data = {
        tempF: raw.hourly.temperature_2m[idx], humidity: raw.hourly.relative_humidity_2m[idx], windMph: raw.hourly.wind_speed_10m[idx],
        windDir: windDirectionLabel(raw.hourly.wind_direction_10m[idx]), windDirDeg: raw.hourly.wind_direction_10m[idx],
        pop: raw.hourly.precipitation_probability[idx], description: w.desc, icon: w.icon,
        forecastFor: times[idx],
      };
    } else {
      data = await fetchWeatherNWS(coords.lat, coords.lon, `weather-${code}`, gameTime);
    }
    res.json({ updated: new Date().toISOString(), ...data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/situational ----
// Récord REAL del equipo desglosado por día/noche y por día de la semana,
// calculado a partir de su calendario completo de la temporada (no es un
// dato inventado — se cuenta juego por juego, con el resultado real).
app.get("/api/team/:code/situational", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const season = new Date().getFullYear();
    const [data, standingsData] = await Promise.all([
      cachedFetch(
        `situational-${teamId}-${season}`,
        `${MLB_API}/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R&hydrate=team`,
        60 * 60 * 1000 // 1 hora — el calendario/resultados no cambian a cada rato
      ),
      // Mismo caché "standings" que ya usan /api/standings y /strength-of-schedule.
      cachedFetch("standings", `${MLB_API}/standings?leagueId=103,104&season=${season}`),
    ]);

    // Mapa real equipo → división/liga, sacado de los 6 grupos de standings
    // (no es una tabla adivinada — viene de la MLB Stats API en vivo).
    const teamDivision = {};
    for (const record of standingsData.records || []) {
      for (const t of record.teamRecords) {
        teamDivision[t.team.id] = { divisionId: record.division.id, leagueId: record.league.id };
      }
    }
    const own = teamDivision[teamId] || null;

    const games = (data.dates || []).flatMap((d) => d.games).filter((g) => g.status?.abstractGameState === "Final");
    // Ordenamos por fecha real, del más viejo al más reciente — necesario
    // para poder tomar los últimos 10 de verdad, sin depender de que la
    // API ya los devuelva en ese orden.
    games.sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

    const dayRecord = { w: 0, l: 0 };
    const nightRecord = { w: 0, l: 0 };
    const weekdayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const byWeekday = Object.fromEntries(weekdayNames.map((n) => [n, { w: 0, l: 0 }]));

    for (const g of games) {
      const isHome = g.teams.home.team.id === teamId;
      const won = isHome ? g.teams.home.isWinner : g.teams.away.isWinner;
      if (won == null) continue;
      const bucket = won ? "w" : "l";

      const isDay = g.dayNight === "day";
      (isDay ? dayRecord : nightRecord)[bucket]++;

      const weekday = weekdayNames[new Date(g.gameDate).getDay()];
      byWeekday[weekday][bucket]++;
    }

    // Récord real de los últimos 10 juegos — su "forma reciente", que
    // puede ser muy distinta a su récord de toda la temporada.
    const finishedGames = games.filter((g) => {
      const isHome = g.teams.home.team.id === teamId;
      return (isHome ? g.teams.home.isWinner : g.teams.away.isWinner) != null;
    });
    const lastTen = finishedGames.slice(-10);
    const last10Record = { w: 0, l: 0 };
    for (const g of lastTen) {
      const isHome = g.teams.home.team.id === teamId;
      const won = isHome ? g.teams.home.isWinner : g.teams.away.isWinner;
      last10Record[won ? "w" : "l"]++;
    }

    // Racha REAL actual — juegos consecutivos ganando o perdiendo, desde
    // el más reciente hacia atrás. Es distinto al récord de últimos 10:
    // un equipo puede ir 6-4 en sus últimos 10, pero venir de ganar los
    // últimos 3 seguidos (una racha real, con más peso que un promedio).
    let currentStreak = { type: null, count: 0 };
    for (let i = finishedGames.length - 1; i >= 0; i--) {
      const g = finishedGames[i];
      const isHome = g.teams.home.team.id === teamId;
      const won = isHome ? g.teams.home.isWinner : g.teams.away.isWinner;
      const type = won ? "W" : "L";
      if (currentStreak.type === null) {
        currentStreak = { type, count: 1 };
      } else if (currentStreak.type === type) {
        currentStreak.count++;
      } else {
        break;
      }
    }

    // Récord real de casa y ruta esta temporada — algunos equipos son
    // genuinamente mucho mejores en su propio estadio que fuera de casa.
    const homeRecord = { w: 0, l: 0 };
    const awayRecord = { w: 0, l: 0 };
    for (const g of games) {
      const isHome = g.teams.home.team.id === teamId;
      const won = isHome ? g.teams.home.isWinner : g.teams.away.isWinner;
      if (won == null) continue;
      (isHome ? homeRecord : awayRecord)[won ? "w" : "l"]++;
    }

    // Récord real desglosado por la división del RIVAL de cada juego, y por
    // si ese rival es de la misma liga (intraliga) o de la otra (interliga).
    // Esto es lo que permite responder, para el partido de hoy específico,
    // "¿cómo le ha ido de verdad contra la división de su rival de hoy?" —
    // en vez de solo su récord general, que puede venir inflado o deflado
    // por jugar mucho contra una división floja o dura.
    const recordByDivision = {};
    const recordByLeague = { sameLeague: { w: 0, l: 0 }, interleague: { w: 0, l: 0 } };
    for (const g of games) {
      const isHome = g.teams.home.team.id === teamId;
      const won = isHome ? g.teams.home.isWinner : g.teams.away.isWinner;
      if (won == null) continue;
      const opponentId = isHome ? g.teams.away.team.id : g.teams.home.team.id;
      const opp = teamDivision[opponentId];
      if (!opp) continue;
      const bucket = won ? "w" : "l";
      if (!recordByDivision[opp.divisionId]) {
        recordByDivision[opp.divisionId] = { name: MLB_DIVISION_NAMES[opp.divisionId] || `División ${opp.divisionId}`, w: 0, l: 0 };
      }
      recordByDivision[opp.divisionId][bucket]++;
      if (own && opp.leagueId === own.leagueId) recordByLeague.sameLeague[bucket]++;
      else recordByLeague.interleague[bucket]++;
    }

    res.json({
      updated: new Date().toISOString(), season, dayRecord, nightRecord, byWeekday, last10Record, currentStreak,
      homeRecord, awayRecord, recordByDivision, recordByLeague,
      ownDivisionId: own?.divisionId ?? null,
      ownDivisionName: own ? (MLB_DIVISION_NAMES[own.divisionId] || null) : null,
      ownLeagueId: own?.leagueId ?? null,
      ownLeagueName: own ? (MLB_LEAGUE_NAMES[own.leagueId] || null) : null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/bullpen ----
// Calidad REAL del bullpen de un equipo — promedio de ERA y WHIP de sus
// relevistas (no del abridor), ponderado por entradas lanzadas. Antes el
// modelo solo evaluaba al abridor; esto agrega el resto del juego.
app.get("/api/team/:code/bullpen", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const data = await cachedFetch(
      `pitchers-${teamId}`, // reutiliza el mismo caché que /pitchers, mismos datos crudos
      `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=pitching))`
    );
    const relievers = data.roster
      .filter((p) => p.position.abbreviation === "P")
      .map((p) => {
        const s = p.person.stats?.[0]?.splits?.[0]?.stat || {};
        const ip = parseInningsPitched(s.inningsPitched);
        const era = s.era != null ? parseFloat(s.era) : null;
        // Mismo principio real de FIP + ERA (70/30) que ya usamos para
        // abridores — un relevista con suerte/mala defensa detrás no
        // debería verse mejor o peor de lo que realmente es.
        let blendedEra = era;
        if (era != null && ip && ip > 0) {
          const FIP_CONSTANT = 3.10;
          const fip = (13 * (s.homeRuns ?? 0) + 3 * ((s.baseOnBalls ?? 0) + (s.hitBatsmen ?? 0)) - 2 * (s.strikeOuts ?? 0)) / ip + FIP_CONSTANT;
          blendedEra = fip * 0.7 + era * 0.3;
        }
        return {
          id: p.person.id, name: p.person.fullName,
          g: s.gamesPlayed || 0, gs: s.gamesStarted || 0,
          era: blendedEra,
          whip: s.whip != null ? parseFloat(s.whip) : null,
          ip: ip || 0,
          saves: s.saves || 0,
        };
      })
      // Relevista = casi nunca abre juegos (permite alguna apertura de emergencia)
      .filter((p) => p.g > 0 && p.gs / p.g < 0.3 && p.ip > 0 && p.era != null && p.whip != null);

    const totalIP = relievers.reduce((sum, p) => sum + p.ip, 0);
    const bullpenERA = totalIP > 0 ? relievers.reduce((sum, p) => sum + p.era * p.ip, 0) / totalIP : null;
    const bullpenWHIP = totalIP > 0 ? relievers.reduce((sum, p) => sum + p.whip * p.ip, 0) / totalIP : null;

    // ---- Cerrador real y su fatiga ----
    // El cerrador se identifica como el relevista con más saves reales
    // esta temporada (mínimo 1) — sin adivinar, solo evidencia. Se revisa
    // su gameLog real para ver en cuántos de los últimos 3 días
    // CALENDARIO lanzó — 2 o más es una señal real de fatiga, aunque su
    // ERA de temporada sea buena.
    let closer = null;
    const closerCandidate = relievers.filter((p) => p.saves > 0).sort((a, b) => b.saves - a.saves)[0];
    if (closerCandidate) {
      const season = new Date().getFullYear();
      const logData = await cachedFetch(
        `pitcher-gamelog-${closerCandidate.id}-${season}`,
        `${MLB_API}/people/${closerCandidate.id}/stats?stats=gameLog&group=pitching&season=${season}`,
        3 * 60 * 60 * 1000
      ).catch(() => null);
      const splits = logData?.stats?.[0]?.splits || [];
      const appearanceDates = new Set(splits.map((s) => s.date));
      const today = new Date();
      let daysWorkedLast3 = 0;
      for (let i = 1; i <= 3; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        if (appearanceDates.has(d.toISOString().slice(0, 10))) daysWorkedLast3++;
      }
      closer = {
        name: closerCandidate.name, saves: closerCandidate.saves,
        daysWorkedLast3, fatigued: daysWorkedLast3 >= 2,
      };
    }

    res.json({
      updated: new Date().toISOString(),
      relieverCount: relievers.length,
      totalIP: Math.round(totalIP * 10) / 10,
      bullpenERA: bullpenERA != null ? Math.round(bullpenERA * 100) / 100 : null,
      bullpenWHIP: bullpenWHIP != null ? Math.round(bullpenWHIP * 100) / 100 : null,
      closer,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Quita filas repetidas del mismo partido (misma fecha + local + visitante) antes
// de calcular precisión: el guardado hace "revisar y luego insertar", y dos
// aperturas simultáneas (lista + detalle) pueden meter el mismo juego dos
// veces e inflar el conteo. Se queda con la primera fila de cada partido.
function dedupeGames(rows) {
  if (!Array.isArray(rows)) return rows;
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.game_date}|${r.home_code}|${r.away_code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- POST /api/predictions/save ----
// Guarda la predicción real de un partido en la base de datos, para poder
// compararla después contra el resultado real. Evita duplicados: si ya
// existe una predicción guardada para ese partido y fecha, no la repite.
app.post("/api/predictions/save", async (req, res) => {
  const { game_date, home_code, away_code, home_win_prob } = req.body || {};
  if (!game_date || !home_code || !away_code || home_win_prob == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía una predicción para este partido" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, home_win_prob }]),
    });
    if (!insertRes.ok) throw new Error(`Supabase insert error ${insertRes.status}`);
    res.json({ saved: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/predictions/check ----
// Revisa las predicciones de días anteriores que todavía no se compararon
// contra el resultado real (checked_at es nulo), busca el resultado real
// del partido en la MLB API, y guarda quién ganó de verdad.
app.post("/api/predictions/check", async (req, res) => {
  try {
    const pendingUrl = `${SUPABASE_URL}/rest/v1/predictions?checked_at=is.null&game_date=lt.${todayET()}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        const data = await cachedFetch(
          `results-${pred.game_date}`,
          `${MLB_API}/schedule?sportId=1&date=${pred.game_date}`,
          60 * 60 * 1000
        );
        const games = data.dates?.[0]?.games || [];
        const match = games.find(
          (g) =>
            TEAM_ID_TO_CODE[g.teams.home.team.id] === pred.home_code &&
            TEAM_ID_TO_CODE[g.teams.away.team.id] === pred.away_code &&
            g.status?.abstractGameState === "Final"
        );
        if (!match) return false; // el juego todavía no terminó, o no se encontró — se revisa después

        const winner = match.teams.home.isWinner ? pred.home_code : pred.away_code;
        await fetch(`${SUPABASE_URL}/rest/v1/predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_winner: winner, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/predictions/accuracy ----
// Calcula qué tan bien calibrado está el modelo, usando SOLO predicciones
// ya comparadas contra el resultado real. Dos métricas:
// - Precisión simple: de las veces que el modelo dio >50% a un equipo,
//   ¿qué % de esas veces ganó de verdad ese equipo?
// - Brier Score: la métrica estándar de calibración (más bajo = mejor;
//   0 es predicción perfecta, 0.25 es "no mejor que adivinar al azar").
app.get("/api/predictions/accuracy", async (req, res) => {
  try {
    // Parámetro opcional ?since=YYYY-MM-DD — filtra solo predicciones de
    // esa fecha en adelante. Útil para comparar "todo el historial" vs.
    // "solo desde que se aplicó la corrección de calibración", sin mezclar
    // datos viejos (sin corregir) con nuevos en el mismo promedio.
    const since = req.query.since;
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, brierScore: null, recent: [], calibration: [] });
    }

    let correctFavorite = 0;
    let brierSum = 0;
    for (const row of rows) {
      const predictedFavorite = row.home_win_prob >= 0.5 ? row.home_code : row.away_code;
      if (predictedFavorite === row.actual_winner) correctFavorite++;

      const actualHomeWon = row.actual_winner === row.home_code ? 1 : 0;
      brierSum += Math.pow(row.home_win_prob - actualHomeWon, 2);
    }

    // ---- Calibración real por rangos de confianza ----
    // Para cada predicción, la probabilidad del FAVORITO (no siempre el
    // local) — así podemos ver: de todas las veces que el modelo dijo
    // "70-80% de confianza", ¿ganó el favorito real ese % de las veces?
    // Si el % real es MENOR al rango, el modelo está sobreconfiado ahí.
    // Si es MAYOR, está subconfiado (podría haber dado más confianza).
    const buckets = [
      { label: "50-60%", min: 0.5, max: 0.6 },
      { label: "60-70%", min: 0.6, max: 0.7 },
      { label: "70-80%", min: 0.7, max: 0.8 },
      { label: "80-90%", min: 0.8, max: 0.9 },
      { label: "90%+", min: 0.9, max: 1.01 },
    ];
    const calibration = buckets.map(({ label, min, max }) => {
      const inBucket = rows.filter((r) => {
        const favProb = r.home_win_prob >= 0.5 ? r.home_win_prob : 1 - r.home_win_prob;
        return favProb >= min && favProb < max;
      });
      if (inBucket.length === 0) return { label, count: 0, predictedAvg: null, actualRate: null };
      let favWon = 0;
      let probSum = 0;
      for (const r of inBucket) {
        const favProb = r.home_win_prob >= 0.5 ? r.home_win_prob : 1 - r.home_win_prob;
        const favorite = r.home_win_prob >= 0.5 ? r.home_code : r.away_code;
        probSum += favProb;
        if (r.actual_winner === favorite) favWon++;
      }
      return {
        label,
        count: inBucket.length,
        predictedAvg: probSum / inBucket.length,
        actualRate: favWon / inBucket.length,
      };
    });

    res.json({
      totalChecked: rows.length,
      accuracy: correctFavorite / rows.length,
      brierScore: brierSum / rows.length,
      calibration,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        homeWinProb: r.home_win_prob, actualWinner: r.actual_winner,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/player/:id/streak ----
// Racha REAL de juegos consecutivos con al menos un hit, calculada del
// historial real de juegos del jugador (no una estimación) — cuenta hacia
// atrás desde su juego más reciente hasta encontrar uno sin hit.
app.get("/api/player/:id/streak", async (req, res) => {
  try {
    const season = new Date().getFullYear();
    const data = await cachedFetch(
      `gamelog-${req.params.id}-${season}`,
      `${MLB_API}/people/${req.params.id}/stats?stats=gameLog&group=hitting&season=${season}`,
      60 * 60 * 1000 // 1 hora
    );
    const splits = data.stats?.[0]?.splits || [];
    // El gameLog viene en orden cronológico ascendente — lo recorremos
    // desde el más reciente (al final) hacia atrás.
    let hitStreak = 0;
    let coldStreak = 0;
    for (let i = splits.length - 1; i >= 0; i--) {
      const hits = splits[i].stat?.hits ?? 0;
      const ab = splits[i].stat?.atBats ?? 0;
      if (ab === 0) continue; // no jugó ese día (ej. relevo/descanso), no rompe la racha
      if (hits > 0) {
        if (coldStreak > 0) break; // ya veníamos contando fría, esta rompe esa cuenta
        hitStreak++;
      } else {
        if (hitStreak > 0) break; // ya veníamos contando caliente, esta rompe esa cuenta
        coldStreak++;
      }
    }

    // Promedio de bateo REAL de los últimos 10 juegos jugados (no
    // calendario) — la forma reciente, distinta del promedio de toda la
    // temporada. Usa los mismos datos del gameLog que ya se cargaron.
    const gamesWithAtBats = splits.filter((s) => (s.stat?.atBats ?? 0) > 0);
    const recentGames = gamesWithAtBats.slice(-10);
    const recentAtBats = recentGames.reduce((sum, s) => sum + (s.stat?.atBats ?? 0), 0);
    const recentHits = recentGames.reduce((sum, s) => sum + (s.stat?.hits ?? 0), 0);
    const recentAvg = recentAtBats > 0 ? recentHits / recentAtBats : null;
    const recentGamesPlayed = recentGames.length;

    res.json({ streak: hitStreak, hitStreak, coldStreak, recentAvg, recentGames: recentGamesPlayed });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/strength-of-schedule ----
// Fuerza real del calendario jugado esta temporada — el promedio del
// win% ACTUAL (de hoy, no de cuando se jugó cada partido) de todos los
// rivales que este equipo ya enfrentó. Un equipo puede tener buen récord
// solo por jugar mucho contra su propia división si esta es floja, o
// verse "peor" de lo que es por jugar seguido contra rivales fuertes de
// otras divisiones — esto corrige esa distorsión real, sin adivinar,
// contando partido por partido contra quién jugó de verdad.
app.get("/api/team/:code/strength-of-schedule", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const season = new Date().getFullYear();
    const [scheduleData, standingsData] = await Promise.all([
      // Mismo caché que ya usa /situational — mismos datos crudos, no se
      // repite la llamada a la MLB API.
      cachedFetch(
        `situational-${teamId}-${season}`,
        `${MLB_API}/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R&hydrate=team`,
        60 * 60 * 1000
      ),
      cachedFetch("standings", `${MLB_API}/standings?leagueId=103,104&season=${season}`),
    ]);

    const wpctByTeamId = {};
    for (const record of standingsData.records) {
      for (const t of record.teamRecords) wpctByTeamId[t.team.id] = parseFloat(t.winningPercentage);
    }

    const games = (scheduleData.dates || [])
      .flatMap((d) => d.games)
      .filter((g) => g.status?.abstractGameState === "Final");

    let sum = 0, count = 0;
    for (const g of games) {
      const opponentId = g.teams.home.team.id === teamId ? g.teams.away.team.id : g.teams.home.team.id;
      const oppWpct = wpctByTeamId[opponentId];
      if (oppWpct != null) { sum += oppWpct; count++; }
    }

    res.json({
      avgOpponentWinPct: count > 0 ? sum / count : null,
      gamesPlayed: count,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/mlb-predictor/:homeCode/:awayCode ----
// Predictor real de ESPN para MLB — su propio modelo, que ya combina
// calidad real del abridor, bateo del equipo, y factor de parque.
// Confirmado real con una consulta directa (campo "gameProjection" por
// equipo). Se usa como referencia externa independiente junto a nuestro
// propio modelo de 9+ factores — promediar dos modelos hechos por
// separado reduce el error de cualquiera de los dos solo ("ensembling",
// principio estadístico real, no una corazonada). Primero hay que
// encontrar el ID de evento REAL de ESPN para este partido específico
// (es un sistema de IDs distinto al gamePk de MLB Stats API), buscando
// en su scoreboard del día por los códigos de equipo.
app.get("/api/mlb-predictor/:homeCode/:awayCode", async (req, res) => {
  const { homeCode, awayCode } = req.params;
  const date = req.query.date || todayET();
  try {
    const dateParam = date.replace(/-/g, "");
    const scoreboard = await cachedFetch(
      `espn-mlb-scoreboard-${date}`,
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`,
      15 * 60 * 1000
    );
    const events = scoreboard.events || [];
    const match = events.find((e) => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      return home?.team?.abbreviation === homeCode.toUpperCase() && away?.team?.abbreviation === awayCode.toUpperCase();
    });
    if (!match) return res.json({ found: false, homeWinProb: null, awayWinProb: null });

    const eventId = match.id;
    const data = await cachedFetch(
      `espn-mlb-predictor-${eventId}`,
      `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${eventId}/competitions/${eventId}/predictor?lang=en&region=us`,
      6 * 60 * 60 * 1000
    );
    const findProj = (side) => {
      const stats = data?.[side]?.statistics || [];
      const stat = stats.find((s) => s.name === "gameProjection");
      return stat?.value != null ? stat.value / 100 : null;
    };
    res.json({
      found: true,
      homeWinProb: findProj("homeTeam"),
      awayWinProb: findProj("awayTeam"),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/matchup/:homeCode/:awayCode/headtohead ----
// Récord REAL de enfrentamientos entre estos dos equipos específicos, esta
// temporada — no es un promedio genérico, es cómo les ha ido de verdad el
// uno contra el otro.
app.get("/api/matchup/:homeCode/:awayCode/headtohead", async (req, res) => {
  const homeId = TEAM_IDS[req.params.homeCode.toUpperCase()];
  const awayId = TEAM_IDS[req.params.awayCode.toUpperCase()];
  if (!homeId || !awayId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const season = new Date().getFullYear();
    const data = await cachedFetch(
      `schedule-${homeId}-${season}`,
      `${MLB_API}/schedule?sportId=1&teamId=${homeId}&season=${season}&gameType=R&hydrate=team,linescore`,
      60 * 60 * 1000 // 1 hora
    );
    const games = (data.dates || [])
      .flatMap((d) => d.games)
      .filter((g) => g.status?.abstractGameState === "Final")
      .filter((g) => g.teams.home.team.id === awayId || g.teams.away.team.id === awayId);

    const record = { homeTeamWins: 0, awayTeamWins: 0 };
    // Línea de referencia fija (~8.5), basada en el promedio real de
    // carreras combinadas de MLB esta temporada — la misma que usa el
    // modelo de Over/Under de cada partido.
    const REFERENCE_LINE = 8.5;
    let overCount = 0, underCount = 0, totalRunsSum = 0, scoredGames = 0;
    const gameDetails = [];

    for (const g of games) {
      const homeTeamIsHomeInThisGame = g.teams.home.team.id === homeId;
      const homeTeamWon = homeTeamIsHomeInThisGame ? g.teams.home.isWinner : g.teams.away.isWinner;
      if (homeTeamWon != null) {
        if (homeTeamWon) record.homeTeamWins++;
        else record.awayTeamWins++;
      }

      const homeScore = g.teams.home.score;
      const awayScore = g.teams.away.score;
      if (homeScore != null && awayScore != null) {
        const total = homeScore + awayScore;
        totalRunsSum += total;
        scoredGames++;
        if (total > REFERENCE_LINE) overCount++;
        else underCount++;
      }

      // Abridores reales de ESE juego específico — vía boxscore, cacheado
      // igual que todo lo demás, para no golpear la MLB API de más.
      let homeStarter = null, awayStarter = null;
      try {
        const box = await cachedFetch(`boxscore-${g.gamePk}`, `${MLB_API}/game/${g.gamePk}/boxscore`, 24 * 60 * 60 * 1000);
        const homePitcherId = box.teams?.home?.pitchers?.[0];
        const awayPitcherId = box.teams?.away?.pitchers?.[0];
        homeStarter = homePitcherId ? box.teams.home.players?.[`ID${homePitcherId}`]?.person?.fullName || null : null;
        awayStarter = awayPitcherId ? box.teams.away.players?.[`ID${awayPitcherId}`]?.person?.fullName || null : null;
      } catch { /* si falla el boxscore de un juego viejo, seguimos sin sus abridores */ }

      gameDetails.push({
        date: g.gameDate?.slice(0, 10) || null,
        homeCode: TEAM_ID_TO_CODE[g.teams.home.team.id] || null,
        awayCode: TEAM_ID_TO_CODE[g.teams.away.team.id] || null,
        homeScore, awayScore,
        homeStarter, awayStarter,
      });
    }

    res.json({
      updated: new Date().toISOString(), season, gamesPlayed: games.length, ...record,
      games: gameDetails,
      overUnder: {
        referenceLine: REFERENCE_LINE,
        overCount, underCount,
        avgTotalRuns: scoredGames > 0 ? Math.round((totalRunsSum / scoredGames) * 100) / 100 : null,
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/picks/save ----
// Guarda los picks del día (bateadores y equipos) en la base de datos,
// para poder comparar después contra lo que de verdad pasó. Evita
// duplicados: si ya existe un pick guardado para esa fecha/tipo/nombre,
// no lo repite.
app.post("/api/picks/save", async (req, res) => {
  const picks = req.body?.picks;
  if (!Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: "Se esperaba un arreglo 'picks'" });
  }
  try {
    // Por cada combinación real de fecha+tipo en este guardado, primero
    // se borran los picks de HOY que aún NO se han revisado (checked_at
    // nulo) — así, si más tarde sale la alineación real y cambia quién
    // es el mejor candidato, el guardado se actualiza de verdad en vez
    // de dejar el pick viejo (posiblemente de alguien que ni jugó) y
    // agregar el nuevo aparte. Los picks YA revisados nunca se tocan —
    // alterar un resultado histórico ya calificado sería deshonesto.
    const dateTypeKeys = new Set(picks.map((p) => `${p.pick_date}|${p.pick_type}`));
    for (const key of dateTypeKeys) {
      const [pick_date, pick_type] = key.split("|");
      await fetch(
        `${SUPABASE_URL}/rest/v1/daily_picks?pick_date=eq.${pick_date}&pick_type=eq.${pick_type}&checked_at=is.null`,
        { method: "DELETE", headers: supabaseHeaders }
      ).catch(() => {});
    }

    let saved = 0;
    for (const p of picks) {
      const { pick_date, pick_type, player_id, player_name, team_code, predicted_prob } = p;
      if (!pick_date || !pick_type || !player_name || !team_code || predicted_prob == null) continue;

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_picks`, {
        method: "POST",
        headers: { ...supabaseHeaders, Prefer: "return=representation" },
        body: JSON.stringify([{ pick_date, pick_type, player_id: player_id || null, player_name, team_code, predicted_prob }]),
      });
      if (insertRes.ok) saved++;
    }
    res.json({ saved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/picks/check ----
// Revisa los picks de días anteriores que todavía no se compararon, y
// busca el resultado REAL: para bateadores, si consiguió al menos un hit
// ese día específico; para equipos, si ganaron ese día específico.
app.post("/api/picks/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/daily_picks?checked_at=is.null&pick_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    // Se revisan TODOS en paralelo, no uno por uno en serie — con
    // cientos de picks acumulados, en serie tardaba muchísimo más.
    const results = await Promise.all(
      pending.map(async (pick) => {
        let success = null;

        if (pick.pick_type === "batter" && pick.player_id) {
          try {
            const season = new Date(pick.pick_date).getFullYear();
            const data = await cachedFetch(
              `gamelog-${pick.player_id}-${season}`,
              `${MLB_API}/people/${pick.player_id}/stats?stats=gameLog&group=hitting&season=${season}`,
              60 * 60 * 1000
            );
            const splits = data.stats?.[0]?.splits || [];
            const gameThatDay = splits.find((s) => s.date === pick.pick_date);
            if (gameThatDay) success = (gameThatDay.stat?.hits ?? 0) > 0;
          } catch { /* se revisa en otra ronda */ }
        } else if (pick.pick_type === "single" && pick.player_id) {
          try {
            const season = new Date(pick.pick_date).getFullYear();
            const data = await cachedFetch(
              `gamelog-${pick.player_id}-${season}`,
              `${MLB_API}/people/${pick.player_id}/stats?stats=gameLog&group=hitting&season=${season}`,
              60 * 60 * 1000
            );
            const splits = data.stats?.[0]?.splits || [];
            const gameThatDay = splits.find((s) => s.date === pick.pick_date);
            if (gameThatDay) {
              const s = gameThatDay.stat;
              const singles = (s?.hits ?? 0) - (s?.doubles ?? 0) - (s?.triples ?? 0) - (s?.homeRuns ?? 0);
              success = singles > 0;
            }
          } catch { /* se revisa en otra ronda */ }
        } else if (pick.pick_type === "team") {
          try {
            const teamId = TEAM_IDS[pick.team_code];
            if (teamId) {
              const data = await cachedFetch(
                `schedule-day-${teamId}-${pick.pick_date}`,
                `${MLB_API}/schedule?sportId=1&teamId=${teamId}&date=${pick.pick_date}`,
                60 * 60 * 1000
              );
              const game = (data.dates?.[0]?.games || []).find((g) => g.status?.abstractGameState === "Final");
              if (game) {
                const isHome = game.teams.home.team.id === teamId;
                success = isHome ? game.teams.home.isWinner : game.teams.away.isWinner;
              }
            }
          } catch { /* se revisa en otra ronda */ }
        }

        if (success == null) return false; // aún no hay resultado real, se deja pendiente
        await fetch(`${SUPABASE_URL}/rest/v1/daily_picks?id=eq.${pick.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_success: success, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/picks/accuracy ----
// Precisión real de los Picks del día, separada entre bateadores y
// equipos — de las veces que la app dijo "este bateador va a dar hit" o
// "este equipo va a ganar", ¿qué tan seguido pasó de verdad?
app.get("/api/picks/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD: mide solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}`.replace("game_date", "pick_date") : "";
    const url = `${SUPABASE_URL}/rest/v1/daily_picks?checked_at=not.is.null${sinceFilter}&select=*&order=pick_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(rows)) throw new Error("Respuesta inesperada de Supabase");

    const summarize = (type) => {
      const filtered = rows.filter((r) => r.pick_type === type);
      if (filtered.length === 0) return { total: 0, accuracy: null, avgPredicted: null };
      const successes = filtered.filter((r) => r.actual_success === true).length;
      // avgPredicted: probabilidad promedio que dio el modelo — si es mucho
      // mayor que la precisión real, el modelo está sobreconfiado.
      const avgPredicted = filtered.reduce((x, r) => x + (r.predicted_prob || 0), 0) / filtered.length;
      return { total: filtered.length, accuracy: successes / filtered.length, avgPredicted };
    };

    res.json({
      batters: summarize("batter"),
      singles: summarize("single"),
      teams: summarize("team"),
      recent: rows.slice(0, 20).map((r) => ({
        date: r.pick_date, type: r.pick_type, name: r.player_name, team: r.team_code,
        prob: r.predicted_prob, success: r.actual_success,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/rest?date=YYYY-MM-DD ----
// Descanso REAL de un equipo antes de su juego de una fecha específica —
// cuántos días de descanso tuvo, si el juego anterior fue de día o de
// noche (para detectar el clásico "getaway day": jugar de noche y al
// día siguiente de día, con poco descanso real), y si cambió de estadio
// (señal de que viajaron, no solo que jugaron seguido en casa).
app.get("/api/team/:code/rest", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });
  const targetDate = req.query.date || todayET();

  try {
    // Trae los últimos 6 días antes de la fecha objetivo, suficiente para
    // encontrar el juego anterior real incluso si tuvieron 2-3 días libres.
    const start = new Date(targetDate);
    start.setDate(start.getDate() - 6);
    const startStr = start.toISOString().slice(0, 10);
    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() - 1);
    const endStr = endDate.toISOString().slice(0, 10);

    const data = await cachedFetch(
      `rest-${teamId}-${targetDate}`,
      `${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${endStr}`,
      60 * 60 * 1000
    );
    const games = (data.dates || [])
      .flatMap((d) => d.games)
      .filter((g) => g.status?.abstractGameState === "Final")
      .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

    if (games.length === 0) {
      return res.json({ daysRested: null, lastGameDayNight: null, sameVenue: null, note: "Sin juegos recientes encontrados (posible inicio de temporada o descanso largo)" });
    }

    const lastGame = games[games.length - 1];
    const lastGameDate = new Date(lastGame.gameDate).toISOString().slice(0, 10);
    const daysRested = Math.round((new Date(targetDate) - new Date(lastGameDate)) / (1000 * 60 * 60 * 24)) - 1;
    const isHome = lastGame.teams.home.team.id === teamId;

    res.json({
      daysRested: Math.max(0, daysRested), // 0 = jugaron ayer (back-to-back), 1 = tuvieron 1 día libre, etc.
      lastGameDayNight: lastGame.dayNight,
      lastGameVenue: lastGame.venue?.name || null,
      lastGameWasHome: isHome,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/overunder/save ----
// Guarda la predicción real de Over/Under de un partido — evita
// duplicados igual que /api/predictions/save.
app.post("/api/overunder/save", async (req, res) => {
  const { game_date, home_code, away_code, line, over_prob, expected_runs } = req.body || {};
  if (!game_date || !home_code || !away_code || line == null || over_prob == null || expected_runs == null) {
    console.error("[overunder/save] Faltan datos:", req.body);
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/overunder_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía una predicción de Over/Under para este partido" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/overunder_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, line, over_prob, expected_runs }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[overunder/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[overunder/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/overunder/check ----
// Revisa predicciones de Over/Under de días anteriores sin comparar, y
// busca el marcador final real para saber si de verdad pasó Over o Under.
app.post("/api/overunder/check", async (req, res) => {
  try {
    const pendingUrl = `${SUPABASE_URL}/rest/v1/overunder_predictions?checked_at=is.null&game_date=lt.${todayET()}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        const homeId = TEAM_IDS[pred.home_code];
        if (!homeId) return false;
        const data = await cachedFetch(
          `schedule-day-${homeId}-${pred.game_date}`,
          `${MLB_API}/schedule?sportId=1&teamId=${homeId}&date=${pred.game_date}`,
          60 * 60 * 1000
        );
        const games = data.dates?.[0]?.games || [];
        const match = games.find(
          (g) =>
            TEAM_ID_TO_CODE[g.teams.away.team.id] === pred.away_code &&
            g.status?.abstractGameState === "Final" &&
            g.teams.home.score != null && g.teams.away.score != null
        );
        if (!match) return false;

        const totalRuns = match.teams.home.score + match.teams.away.score;
        const result = totalRuns > pred.line ? "over" : totalRuns < pred.line ? "under" : "push";

        await fetch(`${SUPABASE_URL}/rest/v1/overunder_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_total_runs: totalRuns, actual_result: result, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/overunder/accuracy ----
// Precisión real de las predicciones de Over/Under, con calibración por
// rango de confianza — misma idea que /api/predictions/accuracy.
app.get("/api/overunder/accuracy", async (req, res) => {
  try {
    const since = req.query.since;
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/overunder_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, recent: [], calibration: [] });
    }

    // Solo cuenta predicciones donde el juego no empujó exacto a la línea
    // (push) — un push no es ni acierto ni fallo real de dirección.
    const decisive = rows.filter((r) => r.actual_result !== "push");
    let correct = 0;
    for (const r of decisive) {
      const predictedSide = r.over_prob >= 0.5 ? "over" : "under";
      if (predictedSide === r.actual_result) correct++;
    }

    const buckets = [
      { label: "50-60%", min: 0.5, max: 0.6 },
      { label: "60-70%", min: 0.6, max: 0.7 },
      { label: "70-80%", min: 0.7, max: 0.8 },
      { label: "80%+", min: 0.8, max: 1.01 },
    ];
    const calibration = buckets.map(({ label, min, max }) => {
      const inBucket = decisive.filter((r) => {
        const sideProb = r.over_prob >= 0.5 ? r.over_prob : 1 - r.over_prob;
        return sideProb >= min && sideProb < max;
      });
      if (inBucket.length === 0) return { label, count: 0, predictedAvg: null, actualRate: null };
      let sideWon = 0;
      let probSum = 0;
      for (const r of inBucket) {
        const sideProb = r.over_prob >= 0.5 ? r.over_prob : 1 - r.over_prob;
        const predictedSide = r.over_prob >= 0.5 ? "over" : "under";
        probSum += sideProb;
        if (r.actual_result === predictedSide) sideWon++;
      }
      return { label, count: inBucket.length, predictedAvg: probSum / inBucket.length, actualRate: sideWon / inBucket.length };
    });

    res.json({
      totalChecked: decisive.length,
      accuracy: decisive.length > 0 ? correct / decisive.length : null,
      calibration,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        line: r.line, overProb: r.over_prob, expectedRuns: r.expected_runs,
        actualTotalRuns: r.actual_total_runs, actualResult: r.actual_result,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NFL — usa la API "oculta" de ESPN (site.api.espn.com) ----
// No es una API oficial de ESPN (no tiene documentación pública ni
// garantía de soporte), pero es real, gratuita, sin llave, y confirmada
// funcionando con datos actuales — usada de forma estable por proyectos
// de la comunidad desde hace años. A diferencia de MLB Stats API (100%
// oficial), esto podría cambiar sin aviso — se cachea agresivamente para
// no depender de ella en cada clic.
// ==========================================================================

const ESPN_NFL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_NFL_STANDINGS = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings?seasontype=2";

// Mapa real equipo → división/conferencia de NFL, construido en vivo desde
// la jerarquía oficial de grupos de la ESPN Core API (conferencia → 4
// divisiones cada una → equipos de cada división). No es una tabla
// adivinada de memoria — se arma con IDs reales de ESPN, y se cachea 24h
// porque la alineación de divisiones no cambia durante la temporada.
async function getNflDivisionMap() {
  const cacheKey = "nfl-division-map";
  const ttlMs = 24 * 60 * 60 * 1000;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;

  const season = new Date().getFullYear();
  const groupUrl = (id) =>
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/groups/${id}?lang=en&region=us`;
  const childrenUrl = (id) =>
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/groups/${id}/children?limit=50`;
  const teamsUrl = (id) =>
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/groups/${id}/teams?lang=en&region=us`;

  // Todo esto se dispara EN PARALELO (conferencias, sus hijos, y las 8
  // divisiones con su nombre + equipos) — antes iba secuencial y por eso
  // tardaba varios segundos la primera vez; ahora son ~2 rondas de red.
  const [afc, nfc] = await Promise.all([
    fetch(groupUrl(8)).then((r) => r.json()),
    fetch(groupUrl(7)).then((r) => r.json()),
  ]);
  const conferences = [
    { id: 8, abbr: afc.abbreviation || "AFC" },
    { id: 7, abbr: nfc.abbreviation || "NFC" },
  ];

  const childrenByConf = await Promise.all(
    conferences.map((conf) => fetch(childrenUrl(conf.id)).then((r) => r.json()).then((data) => ({ conf, data })))
  );

  const divisionJobs = [];
  for (const { conf, data } of childrenByConf) {
    const divisionIds = (data.items || [])
      .map((it) => it.$ref?.match(/groups\/(\d+)\?/)?.[1])
      .filter(Boolean);
    for (const divId of divisionIds) divisionJobs.push({ conf, divId });
  }

  const divisionResults = await Promise.all(
    divisionJobs.map(({ conf, divId }) =>
      Promise.all([fetch(groupUrl(divId)).then((r) => r.json()), fetch(teamsUrl(divId)).then((r) => r.json())]).then(
        ([divInfo, teamsList]) => ({ conf, divId, divInfo, teamsList })
      )
    )
  );

  const map = {};
  for (const { conf, divId, divInfo, teamsList } of divisionResults) {
    for (const t of teamsList.items || []) {
      const teamId = t.$ref?.match(/teams\/(\d+)\?/)?.[1];
      if (teamId) {
        map[teamId] = { conferenceId: conf.id, conference: conf.abbr, divisionId: divId, divisionName: divInfo.name || null };
      }
    }
  }
  cache.set(cacheKey, { data: map, time: Date.now() });
  return map;
}

// ---- GET /api/nfl/games ----
// Calendario real de la semana actual de NFL (o la semana que se pida),
// con marcador y estado real de cada partido.
app.get("/api/nfl/games", async (req, res) => {
  try {
    const weekParam = req.query.week ? `?week=${req.query.week}` : "";
    const data = await cachedFetch(
      `nfl-games-${req.query.week || "current"}`,
      `${ESPN_NFL_SCOREBOARD}${weekParam}`,
      15 * 60 * 1000
    );
    const games = (data.events || []).map((e) => {
      const comp = e.competitions[0];
      const home = comp.competitors.find((c) => c.homeAway === "home");
      const away = comp.competitors.find((c) => c.homeAway === "away");
      return {
        id: e.id,
        date: comp.date,
        venue: comp.venue?.fullName || null,
        homeCode: home.team.abbreviation,
        homeName: home.team.displayName,
        homeScore: home.score != null ? parseInt(home.score) : null,
        awayCode: away.team.abbreviation,
        awayName: away.team.displayName,
        awayScore: away.score != null ? parseInt(away.score) : null,
        status: comp.status.type.description,
        completed: comp.status.type.completed,
      };
    });
    res.json({ week: data.week?.number ?? null, games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/standings ----
// Tabla real de posiciones de NFL — récord, diferencial de puntos, y
// racha actual de cada equipo, separado por conferencia.
app.get("/api/nfl/standings", async (req, res) => {
  try {
    const data = await cachedFetch("nfl-standings", ESPN_NFL_STANDINGS, 60 * 60 * 1000);
    const teams = [];
    for (const conf of data.children || []) {
      for (const entry of conf.standings?.entries || []) {
        const statByType = Object.fromEntries((entry.stats || []).map((s) => [s.type, s]));
        teams.push({
          id: entry.team.id,
          code: entry.team.abbreviation,
          name: entry.team.displayName,
          wins: statByType.wins?.value ?? 0,
          losses: statByType.losses?.value ?? 0,
          ties: statByType.ties?.value ?? 0,
          winPercent: statByType.winpercent?.value ?? 0,
          pointsFor: statByType.pointsfor?.value ?? 0,
          pointsAgainst: statByType.pointsagainst?.value ?? 0,
          streak: statByType.streak?.displayValue ?? null,
          conference: conf.abbreviation,
        });
      }
    }
    teams.sort((a, b) => b.winPercent - a.winPercent);
    res.json({ teams });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/team/:teamId/injuries ----
// Estado real de lesiones del roster completo de un equipo — el roster
// de ESPN ya trae el estado de cada jugador lesionado directo (sin
// tener que saltar entre varias páginas). Se ordena con los QB primero,
// porque es la posición que más cambia una predicción.
app.get("/api/nfl/team/:teamId/injuries", async (req, res) => {
  const { teamId } = req.params;
  try {
    const data = await cachedFetch(
      `nfl-roster-${teamId}`,
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`,
      30 * 60 * 1000
    );
    const injured = [];
    for (const group of data.athletes || []) {
      for (const p of group.items || []) {
        if (p.injuries && p.injuries.length > 0) {
          injured.push({
            name: p.fullName,
            position: p.position?.abbreviation || "?",
            status: p.injuries[0].status,
            date: p.injuries[0].date,
          });
        }
      }
    }
    injured.sort((a, b) => (a.position === "QB" ? -1 : b.position === "QB" ? 1 : 0));
    res.json({ injured });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/player/:id/matchup-splits ----
// Desglose real de hits de un bateador: casa vs ruta (esta temporada),
// contra el equipo rival de hoy (vsTeam), y contra el pitcher específico
// de hoy en toda su carrera (vsPlayer) — la MLB Stats API ya provee los
// tres, vía sitCodes y stats=vsTeam/vsPlayer.
app.get("/api/player/:id/matchup-splits", async (req, res) => {
  const { id } = req.params;
  const { opposingTeamCode, opposingPitcherId } = req.query;
  const opposingTeamId = TEAM_IDS[opposingTeamCode] || null;
  const season = new Date().getFullYear();

  // De una lista de juegos, cuenta en cuántos tuvo al menos 1 del tipo
  // pedido — mismo formato que "Hit en 15 de los últimos 17 juegos".
  // "field" es una función que recibe el stat del juego y devuelve el
  // conteo de ese tipo específico (hit o sencillo).
  const countGames = (games, field) => {
    const withStat = games.filter((g) => field(g.stat) > 0).length;
    return { count: withStat, total: games.length, pct: games.length > 0 ? withStat / games.length : null };
  };
  const hitsOf = (s) => s?.hits ?? 0;
  const singlesOf = (s) => (s?.hits ?? 0) - (s?.doubles ?? 0) - (s?.triples ?? 0) - (s?.homeRuns ?? 0);

  const buildBreakdown = (allGames, field, vsPitcherStat) => {
    const recent = countGames(allGames.slice(0, 17), field);
    let vsTeam = null;
    if (opposingTeamCode) {
      // Robusto ante distintos nombres de campo que la API pueda usar
      // para identificar al rival de ese juego — probamos ID numérico
      // (más confiable) y abreviación como respaldo, ambos sobre el
      // campo "opponent" (nunca "team", que es el equipo del propio
      // jugador, no el rival).
      const vsTeamGames = allGames.filter((g) => {
        const opp = g.opponent;
        return (opposingTeamId && opp?.id === opposingTeamId) || opp?.abbreviation === opposingTeamCode;
      }).slice(0, 5);
      vsTeam = { ...countGames(vsTeamGames, field), teamCode: opposingTeamCode };
    }
    const home = countGames(allGames.filter((g) => g.isHome === true).slice(0, 7), field);
    const away = countGames(allGames.filter((g) => g.isHome === false).slice(0, 7), field);
    let vsPitcher = null;
    if (opposingPitcherId) vsPitcher = { hits: field(vsPitcherStat || {}), atBats: vsPitcherStat?.atBats ?? 0 };
    return { recent, vsTeam, home, away, vsPitcher };
  };

  try {
    const logData = await cachedFetch(
      `gamelog-${id}-${season}`,
      `${MLB_API}/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`,
      30 * 60 * 1000
    );
    // El gameLog viene en orden cronológico ASCENDENTE (más viejo primero)
    // — mismo dato ya confirmado real en /api/player/:id/streak. Lo
    // invertimos para trabajar del más reciente hacia atrás.
    const allGames = (logData.stats?.[0]?.splits || []).filter((g) => (g.stat?.atBats ?? 0) > 0).reverse();

    // vs pitcher específico: en toda su carrera (no solo esta temporada),
    // porque enfrentar al MISMO pitcher varias veces en un año es raro.
    // Se trae UNA sola vez y se reutiliza para hit y sencillo.
    let vsPitcherStat = null;
    if (opposingPitcherId) {
      const vsPitcherData = await cachedFetch(
        `splits-vspitcher-${id}-${opposingPitcherId}`,
        `${MLB_API}/people/${id}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${opposingPitcherId}`,
        60 * 60 * 1000
      ).catch(() => null);
      vsPitcherStat = vsPitcherData?.stats?.[0]?.splits?.[0]?.stat || null;
    }

    res.json({
      hit: buildBreakdown(allGames, hitsOf, vsPitcherStat),
      single: buildBreakdown(allGames, singlesOf, vsPitcherStat),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/team/:teamId/stats ----
// Estadísticas reales de equipo — el dato clave es el diferencial de
// balón (turnOverDifferential), una de las métricas más predictivas en
// NFL, a menudo más que el récord solo.
app.get("/api/nfl/team/:teamId/stats", async (req, res) => {
  const { teamId } = req.params;
  const season = new Date().getFullYear();
  try {
    const data = await cachedFetch(
      `nfl-team-stats-${teamId}-${season}`,
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/${teamId}/statistics`,
      60 * 60 * 1000
    );
    const misc = data.splits?.categories?.find((c) => c.name === "miscellaneous");
    const findStat = (name) => misc?.stats?.find((s) => s.name === name)?.value ?? null;
    res.json({
      turnoverDifferential: findStat("turnOverDifferential"),
      totalTakeaways: findStat("totalTakeaways"),
      totalGiveaways: findStat("totalGiveaways"),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/game/:eventId/fpi ----
// FPI real de ESPN (Football Power Index) para este partido específico —
// su propio modelo predictivo, maduro y calibrado con años de fuerza de
// roster, no solo los 2-3 partidos de esta temporada. Confirmado real con
// una consulta directa: da margen de victoria esperado y % de victoria
// por equipo. Se usa como referencia externa para no confiar ciegamente
// en nuestro propio cálculo cuando hay poca muestra de temporada — mismo
// principio de regresión que ya usamos en MLB con el BABIP, pero acá
// regresionando hacia un punto de referencia informado (el FPI) en vez
// de un neutral 50/50.
app.get("/api/nfl/game/:eventId/fpi", async (req, res) => {
  const { eventId } = req.params;
  const { homeTeamId, awayTeamId } = req.query;
  if (!homeTeamId || !awayTeamId) {
    return res.status(400).json({ error: "Se requieren homeTeamId y awayTeamId" });
  }
  try {
    const fetchOne = async (teamId) => {
      const data = await cachedFetch(
        `nfl-fpi-${eventId}-${teamId}`,
        `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/powerindex/${teamId}`,
        6 * 60 * 60 * 1000 // 6h — el FPI no cambia mucho durante la semana
      );
      const stats = Object.fromEntries((data.stats || []).map((s) => [s.name, s.value]));
      return {
        winProb: stats.gameprojection != null ? stats.gameprojection / 100 : null,
        predPointDiff: stats.teampredptdiff ?? null,
      };
    };
    const [home, away] = await Promise.all([
      fetchOne(homeTeamId).catch(() => ({ winProb: null, predPointDiff: null })),
      fetchOne(awayTeamId).catch(() => ({ winProb: null, predPointDiff: null })),
    ]);
    res.json({ home, away });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/team/:teamId/strength-of-schedule ----
// Mismo principio real que en MLB: promedio del win% ACTUAL de todos los
// rivales que este equipo ya enfrentó esta temporada, contado partido
// por partido de su calendario real — no una suposición sobre qué tan
// dura "debería" ser su división.
app.get("/api/nfl/team/:teamId/strength-of-schedule", async (req, res) => {
  const { teamId } = req.params;
  const season = new Date().getFullYear();
  const REGULAR_SEASON_START = new Date("2026-09-09T00:00:00Z");
  try {
    const [scheduleData, standingsData] = await Promise.all([
      cachedFetch(
        `nfl-schedule-${teamId}-${season}`, // mismo caché que ya usa headtohead/home-away-record
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/schedule?season=${season}`,
        60 * 60 * 1000
      ),
      cachedFetch("nfl-standings", ESPN_NFL_STANDINGS, 60 * 60 * 1000),
    ]);

    const wpctByTeamId = {};
    for (const conf of standingsData.children || []) {
      for (const entry of conf.standings?.entries || []) {
        const statByType = Object.fromEntries((entry.stats || []).map((s) => [s.type, s]));
        wpctByTeamId[entry.team.id] = statByType.winpercent?.value ?? null;
      }
    }

    const games = (scheduleData.events || []).filter((e) => {
      const comp = e.competitions?.[0];
      return comp?.status?.type?.completed && new Date(e.date) >= REGULAR_SEASON_START;
    });

    let sum = 0, count = 0;
    for (const e of games) {
      const comp = e.competitions[0];
      const opponent = comp.competitors?.find((c) => c.id !== teamId);
      const oppWpct = opponent ? wpctByTeamId[opponent.id] : null;
      if (oppWpct != null) { sum += oppWpct; count++; }
    }

    res.json({
      avgOpponentWinPct: count > 0 ? sum / count : null,
      gamesPlayed: count,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/headtohead/:teamId1/:teamId2 ----
// Historial real cara a cara entre dos equipos ESTA temporada — en NFL
// casi siempre son 0 o 1 juegos previos (2 solo si son rivales de
// división), a diferencia de MLB. Se revisa el calendario real de uno
// de los dos equipos, filtrando los juegos contra el otro.
app.get("/api/nfl/headtohead/:teamId1/:teamId2", async (req, res) => {
  const { teamId1, teamId2 } = req.params;
  const season = new Date().getFullYear();
  // Fecha real de inicio de la temporada REGULAR 2026 — hay que
  // actualizar este valor cada año. Sin este filtro, el calendario de
  // ESPN también trae juegos de pretemporada (donde juegan suplentes y
  // nadie compite en serio), que no deben contar como historial real.
  const REGULAR_SEASON_START = new Date("2026-09-09T00:00:00Z");
  try {
    const data = await cachedFetch(
      `nfl-schedule-${teamId1}-${season}`,
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId1}/schedule?season=${season}`,
      60 * 60 * 1000
    );
    const games = (data.events || []).filter((e) => {
      const comp = e.competitions?.[0];
      const opponent = comp?.competitors?.find((c) => c.id !== teamId1);
      return opponent?.id === teamId2 && comp?.status?.type?.completed && new Date(e.date) >= REGULAR_SEASON_START;
    });
    let team1Wins = 0, team2Wins = 0;
    for (const g of games) {
      const comp = g.competitions[0];
      const team1Comp = comp.competitors.find((c) => c.id === teamId1);
      if (team1Comp?.winner) team1Wins++;
      else if (team1Comp?.winner === false) team2Wins++;
    }
    res.json({ gamesPlayed: games.length, team1Wins, team2Wins });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Coordenadas y techo real de los 32 estadios de NFL ----
// roofed: true = techo cerrado o fijo (el clima NO afecta el juego).
// Confirmado con conocimiento general de cada estadio — si alguno
// cambiara de estadio o de tipo de techo, se corrige aquí.
const NFL_STADIUM_COORDS = {
  ARI: { lat: 33.5276, lon: -112.2626, roofed: true },
  ATL: { lat: 33.7554, lon: -84.4008, roofed: true },
  BAL: { lat: 39.2780, lon: -76.6227, roofed: false },
  BUF: { lat: 42.7738, lon: -78.7870, roofed: false },
  CAR: { lat: 35.2258, lon: -80.8528, roofed: false },
  CHI: { lat: 41.8623, lon: -87.6167, roofed: false },
  CIN: { lat: 39.0955, lon: -84.5160, roofed: false },
  CLE: { lat: 41.5061, lon: -81.6995, roofed: false },
  DAL: { lat: 32.7473, lon: -97.0945, roofed: true },
  DEN: { lat: 39.7439, lon: -105.0201, roofed: false },
  DET: { lat: 42.3400, lon: -83.0456, roofed: true },
  GB: { lat: 44.5013, lon: -88.0622, roofed: false },
  HOU: { lat: 29.6847, lon: -95.4107, roofed: true },
  IND: { lat: 39.7601, lon: -86.1639, roofed: true },
  JAX: { lat: 30.3239, lon: -81.6373, roofed: false },
  KC: { lat: 39.0489, lon: -94.4839, roofed: false },
  LV: { lat: 36.0909, lon: -115.1833, roofed: true },
  LAC: { lat: 33.9535, lon: -118.3392, roofed: true },
  LAR: { lat: 33.9535, lon: -118.3392, roofed: true },
  MIA: { lat: 25.9580, lon: -80.2389, roofed: false },
  MIN: { lat: 44.9737, lon: -93.2577, roofed: true },
  NE: { lat: 42.0909, lon: -71.2643, roofed: false },
  NO: { lat: 29.9511, lon: -90.0812, roofed: true },
  NYG: { lat: 40.8135, lon: -74.0745, roofed: false },
  NYJ: { lat: 40.8135, lon: -74.0745, roofed: false },
  PHI: { lat: 39.9008, lon: -75.1675, roofed: false },
  PIT: { lat: 40.4468, lon: -80.0158, roofed: false },
  SEA: { lat: 47.5952, lon: -122.3316, roofed: false },
  SF: { lat: 37.4032, lon: -121.9698, roofed: false },
  TB: { lat: 27.9759, lon: -82.5033, roofed: false },
  TEN: { lat: 36.1665, lon: -86.7713, roofed: false },
  WSH: { lat: 38.9076, lon: -76.8645, roofed: false },
};

// ---- GET /api/nfl/weather/:code ----
// Clima real del estadio, para la hora específica del primer saque —
// reutiliza la misma función fetchWeatherNWS que ya usa MLB, solo con
// las coordenadas correctas de cada estadio de NFL.
app.get("/api/nfl/weather/:code", async (req, res) => {
  const code = req.params.code.toUpperCase();
  const coords = NFL_STADIUM_COORDS[code];
  if (!coords) return res.status(404).json({ error: "Código de equipo no reconocido" });
  if (coords.roofed) return res.json({ roofed: true });
  const gameTime = req.query.gameTime || null;

  try {
    const data = await fetchWeatherNWS(coords.lat, coords.lon, `nfl-weather-${code}`, gameTime);
    res.json({ roofed: false, updated: new Date().toISOString(), ...data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/nfl/overunder/save ----
app.post("/api/nfl/overunder/save", async (req, res) => {
  const { game_date, week, home_code, away_code, line, over_prob, expected_total } = req.body || {};
  if (!game_date || !home_code || !away_code || line == null || over_prob == null || expected_total == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nfl_overunder_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nfl_overunder_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, week: week || null, home_code, away_code, line, over_prob, expected_total }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nfl/overunder/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nfl/overunder/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/nfl/overunder/check ----
// Revisa predicciones pendientes buscando el marcador final real en la
// semana correspondiente del calendario de ESPN.
app.post("/api/nfl/overunder/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nfl_overunder_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        if (pred.week == null) return false;
        const events = await cachedFetch(
          `nfl-games-check-${pred.week}`,
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${pred.week}`,
          15 * 60 * 1000
        ).then((d) => d.events || []);
        const match = events.find((e) => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find((c) => c.homeAway === "home");
          const away = comp?.competitors?.find((c) => c.homeAway === "away");
          return home?.team?.abbreviation === pred.home_code && away?.team?.abbreviation === pred.away_code && comp?.status?.type?.completed;
        });
        if (!match) return false;

        const comp = match.competitions[0];
        const home = comp.competitors.find((c) => c.homeAway === "home");
        const away = comp.competitors.find((c) => c.homeAway === "away");
        const totalPoints = parseInt(home.score) + parseInt(away.score);
        const result = totalPoints > pred.line ? "over" : totalPoints < pred.line ? "under" : "push";

        await fetch(`${SUPABASE_URL}/rest/v1/nfl_overunder_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_total_points: totalPoints, actual_result: result, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/overunder/accuracy ----
app.get("/api/nfl/overunder/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nfl_overunder_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, recent: [] });
    }
    const decisive = rows.filter((r) => r.actual_result !== "push");
    let correct = 0;
    for (const r of decisive) {
      const predictedSide = r.over_prob >= 0.5 ? "over" : "under";
      if (predictedSide === r.actual_result) correct++;
    }
    res.json({
      totalChecked: decisive.length,
      accuracy: decisive.length > 0 ? correct / decisive.length : null,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        line: r.line, overProb: r.over_prob, expectedTotal: r.expected_total,
        actualTotalPoints: r.actual_total_points, actualResult: r.actual_result,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/team/:teamId/home-away-record ----
// Récord real de casa y ruta de un equipo esta temporada — algunos
// equipos son genuinamente mucho mejores en su propio estadio. Usa el
// mismo calendario real que ya usamos para cara a cara.
app.get("/api/nfl/team/:teamId/home-away-record", async (req, res) => {
  const { teamId } = req.params;
  const season = new Date().getFullYear();
  // Mismo filtro real de temporada regular — sin esto, contaría juegos
  // de pretemporada (suplentes, sin competir en serio) como si fueran
  // récord real.
  const REGULAR_SEASON_START = new Date("2026-09-09T00:00:00Z");
  try {
    const [data, divisionMap] = await Promise.all([
      cachedFetch(
        `nfl-schedule-${teamId}-${season}`,
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/schedule?season=${season}`,
        60 * 60 * 1000
      ),
      getNflDivisionMap(),
    ]);
    const homeRecord = { w: 0, l: 0 };
    const awayRecord = { w: 0, l: 0 };

    // Récord real desglosado por la división del RIVAL de cada juego, y por
    // si ese rival es de la misma conferencia o de la otra — mismo espíritu
    // que el desglose por división de MLB, para responder "¿cómo le ha ido
    // de verdad contra la división del rival de hoy?" en vez de solo su
    // récord general (que puede estar inflado/deflado por jugar mucho
    // contra su propia división, floja o dura).
    const recordByDivision = {};
    const recordByConference = { sameConference: { w: 0, l: 0 }, interconference: { w: 0, l: 0 } };
    const own = divisionMap[teamId] || null;

    for (const e of data.events || []) {
      const comp = e.competitions?.[0];
      if (!comp?.status?.type?.completed || new Date(e.date) < REGULAR_SEASON_START) continue;
      const self = comp.competitors?.find((c) => c.id === teamId);
      if (!self || self.winner == null) continue;
      const bucket = self.winner ? "w" : "l";
      (self.homeAway === "home" ? homeRecord : awayRecord)[bucket]++;

      const opponent = comp.competitors?.find((c) => c.id !== teamId);
      const opp = opponent ? divisionMap[opponent.id] : null;
      if (opp) {
        if (!recordByDivision[opp.divisionId]) {
          recordByDivision[opp.divisionId] = { name: opp.divisionName || `División ${opp.divisionId}`, w: 0, l: 0 };
        }
        recordByDivision[opp.divisionId][bucket]++;
        if (own && opp.conferenceId === own.conferenceId) recordByConference.sameConference[bucket]++;
        else recordByConference.interconference[bucket]++;
      }
    }

    res.json({
      homeRecord, awayRecord, recordByDivision, recordByConference,
      ownDivisionId: own?.divisionId ?? null,
      ownDivisionName: own?.divisionName ?? null,
      ownConferenceId: own?.conferenceId ?? null,
      ownConference: own?.conference ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nfl/team/:teamId/skill-stats ----
// Yardas reales por juego (temporada) y probabilidad de touchdown (vía
// Poisson, mismo principio que usamos para jonrones en MLB) de los
// jugadores ofensivos reales — QB, RB, WR, TE — de un equipo. Solo
// incluye jugadores con uso real esta temporada (no ceros).
app.get("/api/nfl/team/:teamId/skill-stats", async (req, res) => {
  const { teamId } = req.params;
  const season = new Date().getFullYear();
  let loggedSample = false;
  try {
    const roster = await cachedFetch(
      `nfl-roster-${teamId}`,
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`,
      30 * 60 * 1000
    );
    const skillPlayers = [];
    for (const group of roster.athletes || []) {
      for (const p of group.items || []) {
        const pos = p.position?.abbreviation;
        if (["QB", "RB", "WR", "TE"].includes(pos)) {
          skillPlayers.push({ id: p.id, name: p.fullName, position: pos });
        }
      }
    }

    const results = await Promise.all(
      skillPlayers.map(async (p) => {
        const statsData = await cachedFetch(
          `nfl-player-stats-${p.id}-${season}`,
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/athletes/${p.id}/statistics/0`,
          60 * 60 * 1000
        ).catch((err) => { console.error(`[nfl/skill-stats] Fetch falló para ${p.name} (${p.id}):`, err.message); return null; });
        if (!statsData) return null;

        const categories = statsData.splits?.categories || [];
        if (!loggedSample) {
          loggedSample = true;
          console.error(
            `[nfl/skill-stats] Muestra real para ${p.name} (${p.position}):`,
            JSON.stringify(categories.map((c) => ({ name: c.name, stats: (c.stats || []).map((s) => s.name) })))
          );
        }
        if (categories.length === 0) {
          console.error(`[nfl/skill-stats] Sin categorías para ${p.name} (${p.id}). Respuesta cruda:`, JSON.stringify(statsData).slice(0, 500));
        }
        const findStat = (catName, statName) => {
          const cat = categories.find((c) => c.name === catName);
          return cat?.stats?.find((s) => s.name === statName)?.value ?? null;
        };

        let statLine = null;
        if (p.position === "QB") {
          const passYds = findStat("passing", "passingYards");
          const passTds = findStat("passing", "passingTouchdowns");
          const gp = findStat("passing", "gamesPlayed") ?? findStat("passing", "teamGamesPlayed");
          if (!passYds || !gp) return null;
          statLine = { type: "passing", ydsPerGame: passYds / gp, tdPerGame: (passTds ?? 0) / gp };
        } else if (p.position === "RB") {
          const rushYds = findStat("rushing", "rushingYards");
          const rushTds = findStat("rushing", "rushingTouchdowns");
          const gp = findStat("rushing", "gamesPlayed") ?? findStat("rushing", "teamGamesPlayed");
          if (!rushYds || !gp) return null;
          statLine = { type: "rushing", ydsPerGame: rushYds / gp, tdPerGame: (rushTds ?? 0) / gp };
        } else {
          const recYds = findStat("receiving", "receivingYards");
          const recTds = findStat("receiving", "receivingTouchdowns");
          const gp = findStat("receiving", "gamesPlayed") ?? findStat("receiving", "teamGamesPlayed");
          if (!recYds || !gp) return null;
          statLine = { type: "receiving", ydsPerGame: recYds / gp, tdPerGame: (recTds ?? 0) / gp };
        }

        // Probabilidad de al menos 1 TD vía Poisson — mismo principio
        // real que ya usamos para jonrones en MLB.
        const tdProbability = 1 - Math.exp(-statLine.tdPerGame);

        return { id: p.id, name: p.name, position: p.position, ydsPerGame: statLine.ydsPerGame, type: statLine.type, tdProbability };
      })
    );

    res.json({ players: results.filter(Boolean) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/player/:id/babip-adjusted ----
// Ajuste real de BABIP bajo demanda — se llama solo para los
// candidatos finales ya filtrados (no para el roster completo), para
// no hacer lento a Picks del día, que necesita a todos los equipos
// jugando hoy, no solo a 2.
app.get("/api/player/:id/babip-adjusted", async (req, res) => {
  const { atBats, hits, homeRuns, strikeOuts } = req.query;
  const seasonStats = {
    atBats: parseFloat(atBats), hits: parseFloat(hits),
    homeRuns: parseFloat(homeRuns), strikeOuts: parseFloat(strikeOuts),
  };
  if (!seasonStats.atBats) return res.status(400).json({ error: "Faltan datos de temporada" });
  const babipAdjustedAvg = await fetchBabipAdjustedAvg(req.params.id, seasonStats);
  res.json({ babipAdjustedAvg });
});

// ---- GET /api/team/:code/platoon-split ----
// Desempeño REAL del equipo (no una suposición genérica) contra zurdos
// o derechos esta temporada — compara su OPS real contra esa mano
// específica frente a su OPS real de toda la temporada, para saber si
// este equipo en particular es genuinamente mejor o peor contra esa
// mano, más allá de cuántos bateadores zurdos/derechos tenga en el
// roster.
app.get("/api/team/:code/platoon-split", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  const hand = req.query.hand === "L" ? "vl" : req.query.hand === "R" ? "vr" : null;
  if (!teamId || !hand) return res.status(400).json({ error: "Faltan datos requeridos" });

  try {
    const season = new Date().getFullYear();
    const [seasonData, splitData] = await Promise.all([
      cachedFetch(`team-season-hitting-${teamId}-${season}`, `${MLB_API}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`, 60 * 60 * 1000),
      cachedFetch(`team-platoon-${teamId}-${hand}-${season}`, `${MLB_API}/teams/${teamId}/stats?stats=statSplits&group=hitting&sitCodes=${hand}&season=${season}`, 60 * 60 * 1000),
    ]);
    const seasonOps = seasonData.stats?.[0]?.splits?.[0]?.stat?.ops != null ? parseFloat(seasonData.stats[0].splits[0].stat.ops) : null;
    const splitOps = splitData.stats?.[0]?.splits?.[0]?.stat?.ops != null ? parseFloat(splitData.stats[0].splits[0].stat.ops) : null;
    if (seasonOps == null || splitOps == null) return res.json({ opsDelta: null });

    res.json({ seasonOps, splitOps, opsDelta: splitOps - seasonOps });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/team/:code/lineup-strength ----
// Fuerza REAL de la alineación confirmada de hoy, comparada contra el
// promedio del roster completo — si un equipo tiene descansando a sus
// mejores bateadores hoy, es genuinamente más débil ese día específico,
// aunque su récord de temporada sea bueno. Reutiliza el mismo caché que
// /api/team/:code/hitters y /api/game/:gamePk/lineup, sin duplicar
// consultas nuevas a la MLB API.
app.get("/api/team/:code/lineup-strength", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  const { gamePk } = req.query;
  if (!teamId || !gamePk) return res.status(400).json({ error: "Faltan datos requeridos" });

  try {
    const rosterData = await cachedFetch(
      `hitters-${teamId}`,
      `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting))`
    );
    const rosterHitters = rosterData.roster
      .filter((p) => p.position.abbreviation !== "P")
      .map((p) => {
        const s = p.person.stats?.[0]?.splits?.[0]?.stat || {};
        return { name: p.person.fullName, ab: s.atBats ?? 0, ops: s.ops != null ? parseFloat(s.ops) : null };
      })
      .filter((p) => p.ab >= 20 && p.ops != null);

    if (rosterHitters.length === 0) return res.json({ opsDelta: null });
    const rosterAvgOps = rosterHitters.reduce((sum, p) => sum + p.ops, 0) / rosterHitters.length;

    const boxscore = await cachedFetch(`lineup-${gamePk}`, `${MLB_API}/game/${gamePk}/boxscore`);
    const isHome = teamId === boxscore.teams?.home?.team?.id;
    const teamSide = isHome ? boxscore.teams?.home : boxscore.teams?.away;
    const battingOrder = teamSide?.battingOrder || [];
    if (battingOrder.length === 0) return res.json({ opsDelta: null }); // alineación aún no publicada

    const confirmedNames = new Set(
      battingOrder.map((id) => teamSide.players?.[`ID${id}`]?.person?.fullName).filter(Boolean)
    );
    const confirmedHitters = rosterHitters.filter((p) => confirmedNames.has(p.name));
    if (confirmedHitters.length === 0) return res.json({ opsDelta: null });
    const confirmedAvgOps = confirmedHitters.reduce((sum, p) => sum + p.ops, 0) / confirmedHitters.length;

    res.json({ opsDelta: confirmedAvgOps - rosterAvgOps, confirmedCount: confirmedHitters.length, rosterCount: rosterHitters.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NFL: Backtesting de probabilidad de ganar ----
// ==========================================================================

app.post("/api/nfl/predictions/save", async (req, res) => {
  const { game_date, week, home_code, away_code, home_win_prob } = req.body || {};
  if (!game_date || !home_code || !away_code || home_win_prob == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nfl_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nfl_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, week: week || null, home_code, away_code, home_win_prob }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nfl/predictions/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nfl/predictions/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/nfl/predictions/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nfl_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        if (pred.week == null) return false;
        const events = await cachedFetch(
          `nfl-games-check-${pred.week}`,
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${pred.week}`,
          15 * 60 * 1000
        ).then((d) => d.events || []);
        const match = events.find((e) => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find((c) => c.homeAway === "home");
          const away = comp?.competitors?.find((c) => c.homeAway === "away");
          return home?.team?.abbreviation === pred.home_code && away?.team?.abbreviation === pred.away_code && comp?.status?.type?.completed;
        });
        if (!match) return false;
        const comp = match.competitions[0];
        const home = comp.competitors.find((c) => c.homeAway === "home");
        const away = comp.competitors.find((c) => c.homeAway === "away");
        const winner = parseInt(home.score) > parseInt(away.score) ? pred.home_code : pred.away_code;

        await fetch(`${SUPABASE_URL}/rest/v1/nfl_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_winner: winner, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nfl/predictions/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD para medir solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nfl_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, brierScore: null, recent: [] });
    }
    let correctFavorite = 0;
    let brierSum = 0;
    for (const row of rows) {
      const predictedFavorite = row.home_win_prob >= 0.5 ? row.home_code : row.away_code;
      if (predictedFavorite === row.actual_winner) correctFavorite++;
      const actualHomeWon = row.actual_winner === row.home_code ? 1 : 0;
      brierSum += Math.pow(row.home_win_prob - actualHomeWon, 2);
    }
    res.json({
      totalChecked: rows.length,
      accuracy: correctFavorite / rows.length,
      brierScore: brierSum / rows.length,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        homeWinProb: r.home_win_prob, actualWinner: r.actual_winner,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NFL: Backtesting de Picks del día (equipo + touchdown) ----
// ==========================================================================

app.post("/api/nfl/picks/save", async (req, res) => {
  const picks = req.body?.picks;
  if (!Array.isArray(picks) || picks.length === 0) {
    console.error("[nfl/picks/save] Arreglo de picks vacío o inválido:", JSON.stringify(req.body).slice(0, 300));
    return res.status(400).json({ error: "Se esperaba un arreglo 'picks'" });
  }
  console.error(`[nfl/picks/save] Recibidos ${picks.length} picks:`, JSON.stringify(picks).slice(0, 500));
  try {
    const dateTypeKeys = new Set(picks.map((p) => `${p.pick_date}|${p.pick_type}`));
    for (const key of dateTypeKeys) {
      const [pick_date, pick_type] = key.split("|");
      await fetch(
        `${SUPABASE_URL}/rest/v1/nfl_daily_picks?pick_date=eq.${pick_date}&pick_type=eq.${pick_type}&checked_at=is.null`,
        { method: "DELETE", headers: supabaseHeaders }
      ).catch(() => {});
    }
    let saved = 0;
    for (const p of picks) {
      const { pick_date, week, pick_type, player_id, player_name, team_code, predicted_prob } = p;
      if (!pick_date || !pick_type || !player_name || !team_code || predicted_prob == null) {
        console.error("[nfl/picks/save] Pick descartado por faltarle datos:", JSON.stringify(p));
        continue;
      }
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nfl_daily_picks`, {
        method: "POST",
        headers: { ...supabaseHeaders, Prefer: "return=representation" },
        body: JSON.stringify([{ pick_date, week: week || null, pick_type, player_id: player_id || null, player_name, team_code, predicted_prob }]),
      });
      if (insertRes.ok) {
        saved++;
      } else {
        const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
        console.error(`[nfl/picks/save] Supabase insert error ${insertRes.status}:`, bodyText);
      }
    }
    res.json({ saved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Revisa resultados reales de picks pendientes — equipo (¿ganó?) y TD
// (¿anotó?, buscando en el boxscore real del juego). La estructura
// exacta del boxscore de jugador de ESPN no se pudo confirmar en vivo
// hoy — si falla, se revisa en otra ronda sin romper nada.
app.post("/api/nfl/picks/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nfl_daily_picks?checked_at=is.null&pick_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pick) => {
        if (pick.week == null) return false;
        const events = await cachedFetch(
          `nfl-games-check-${pick.week}`,
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${pick.week}`,
          15 * 60 * 1000
        ).then((d) => d.events || []);

        const match = events.find((e) => {
          const comp = e.competitions?.[0];
          const teamInGame = (comp?.competitors || []).find((c) => c.team?.abbreviation === pick.team_code);
          return teamInGame && comp?.status?.type?.completed;
        });
        if (!match) return false;

        let success = null;
        if (pick.pick_type === "team") {
          const comp = match.competitions[0];
          const teamComp = comp.competitors.find((c) => c.team?.abbreviation === pick.team_code);
          success = teamComp?.winner === true;
        } else if (pick.pick_type === "td" && pick.player_id) {
          try {
            const summary = await cachedFetch(
              `nfl-summary-${match.id}`,
              `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${match.id}`,
              60 * 60 * 1000
            );
            const boxPlayers = summary.boxscore?.players || [];
            let found = false, scoredTd = false;
            for (const teamBlock of boxPlayers) {
              for (const statCategory of teamBlock.statistics || []) {
                for (const athlete of statCategory.athletes || []) {
                  if (String(athlete.athlete?.id) === String(pick.player_id)) {
                    found = true;
                    const labels = (statCategory.labels || []).map((l) => l.toUpperCase());
                    const stats = athlete.stats || [];
                    labels.forEach((label, idx) => {
                      if (label.includes("TD") && parseInt(stats[idx]) > 0) scoredTd = true;
                    });
                  }
                }
              }
            }
            if (found) success = scoredTd;
          } catch { /* se revisa en otra ronda */ }
        }

        if (success == null) return false;
        await fetch(`${SUPABASE_URL}/rest/v1/nfl_daily_picks?id=eq.${pick.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_success: success, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nfl/picks/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD
    const sinceFilter = since ? `&pick_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nfl_daily_picks?checked_at=not.is.null${sinceFilter}&select=*&order=pick_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
    const summarize = (type) => {
      const filtered = rows.filter((r) => r.pick_type === type);
      if (filtered.length === 0) return { accuracy: null, total: 0 };
      const correct = filtered.filter((r) => r.actual_success === true).length;
      return { accuracy: correct / filtered.length, total: filtered.length };
    };
    res.json({
      teams: summarize("team"),
      td: summarize("td"),
      recent: rows.slice(0, 20).map((r) => ({
        date: r.pick_date, type: r.pick_type, name: r.player_name, team: r.team_code,
        prob: r.predicted_prob, success: r.actual_success,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL — Fase 1 (juegos reales, probabilidad de ganar, fuerza de
// calendario, récord por división/conferencia). API pública y oficial de
// la NHL (api-web.nhle.com) — gratuita, sin llave, sin límite de tasa
// conocido. Sin predictor propio de ESPN para NHL (se verificó en vivo:
// el endpoint de predictor de ESPN no existe para hockey), así que ese
// factor simplemente no se usa aquí, en vez de inventarlo. Pendiente para
// una siguiente fase: portero titular real (el factor más grande en
// hockey, equivalente al abridor en MLB), Over/Under, y backtesting real
// guardado en Supabase — todavía no implementados.
// ==========================================================================

const NHL_API = "https://api-web.nhle.com/v1";

// ---- GET /api/nhl/games ----
// Juegos reales de una fecha (hoy por defecto), con su tipo real
// (pretemporada/temporada regular/playoffs) — esto importa mucho ahora
// mismo: en pretemporada juegan muchos suplentes y prospectos, así que el
// resultado NO refleja la fuerza real del equipo titular.
app.get("/api/nhl/games", async (req, res) => {
  try {
    const date = req.query.date || todayET();
    const data = await cachedFetch(`nhl-schedule-${date}`, `${NHL_API}/schedule/${date}`, 15 * 60 * 1000);
    const day = (data.gameWeek || []).find((d) => d.date === date);
    const games = (day?.games || []).map((g) => ({
      id: g.id,
      gameType: g.gameType, // 1 = pretemporada, 2 = temporada regular, 3 = playoffs
      isPreseason: g.gameType === 1,
      startTimeUTC: g.startTimeUTC,
      venue: g.venue?.default || null,
      gameState: g.gameState, // FUT | LIVE | OFF (final)
      awayCode: g.awayTeam?.abbrev,
      awayName: g.awayTeam?.commonName?.default || g.awayTeam?.abbrev,
      awayId: g.awayTeam?.id,
      awayScore: g.awayTeam?.score ?? null,
      homeCode: g.homeTeam?.abbrev,
      homeName: g.homeTeam?.commonName?.default || g.homeTeam?.abbrev,
      homeId: g.homeTeam?.id,
      homeScore: g.homeTeam?.score ?? null,
    }));
    res.json({ date, games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nhl/standings ----
// Tabla real de posiciones — récord, % de puntos (la medida real de
// fuerza en NHL, porque una derrota en tiempo extra/shootout vale medio
// punto, a diferencia de una derrota en tiempo regular), casa/ruta, y
// últimos 10, todo directo de la API oficial de NHL (no hay que calcularlo
// a mano, a diferencia de MLB/NFL). Si la temporada regular 2026-27 aún no
// arrancó, esto devuelve la última temporada regular completa como
// referencia real — no inventa ceros ni una tabla vacía.
// Promedios REALES de la liga para casa/ruta, medidos de los récords de
// todos los equipos: % de victorias de local, y % de puntos de local, de
// visitante y total (para descontar la ventaja de casa de la liga del
// ajuste casa/ruta de cada equipo — si no, se cuenta dos veces).
function computeNhlLeagueSplits(rawTeams) {
  let hw = 0, hl = 0, ho = 0, rw = 0, rl = 0, ro = 0;
  for (const t of rawTeams) {
    hw += t.homeWins || 0; hl += t.homeLosses || 0; ho += t.homeOtLosses || 0;
    rw += t.roadWins || 0; rl += t.roadLosses || 0; ro += t.roadOtLosses || 0;
  }
  const homeGames = hw + hl + ho, roadGames = rw + rl + ro;
  if (homeGames === 0 || roadGames === 0) return null;
  const homePtsPct = (hw + 0.5 * ho) / homeGames;
  const roadPtsPct = (rw + 0.5 * ro) / roadGames;
  return {
    homeGames,
    homeWinRate: hw / homeGames, // victorias de local / juegos de local
    homePtsPct, roadPtsPct,
    overallPtsPct: (hw + 0.5 * ho + rw + 0.5 * ro) / (homeGames + roadGames),
  };
}

app.get("/api/nhl/standings", async (req, res) => {
  try {
    const data = await cachedFetch("nhl-standings", `${NHL_API}/standings/now`, 60 * 60 * 1000);
    const teams = (data.standings || []).map((t) => ({
      code: t.teamAbbrev?.default,
      name: t.teamCommonName?.default || t.teamName?.default,
      fullName: t.teamName?.default || null, // nombre completo real (ej. "Toronto Maple Leafs") — necesario para emparejar con el evento de ESPN al buscar el portero titular
      wins: t.wins, losses: t.losses, otLosses: t.otLosses,
      gamesPlayed: t.gamesPlayed,
      points: t.points, winPctg: t.winPctg, pointPctg: t.pointPctg,
      goalFor: t.goalFor, goalAgainst: t.goalAgainst, goalDifferential: t.goalDifferential,
      divisionName: t.divisionName, conferenceName: t.conferenceName,
      homeWins: t.homeWins, homeLosses: t.homeLosses, homeOtLosses: t.homeOtLosses,
      roadWins: t.roadWins, roadLosses: t.roadLosses, roadOtLosses: t.roadOtLosses,
      l10Wins: t.l10Wins, l10Losses: t.l10Losses, l10OtLosses: t.l10OtLosses,
      streakCode: t.streakCode, streakCount: t.streakCount,
      seasonId: t.seasonId,
    }));
    teams.sort((a, b) => (b.pointPctg ?? 0) - (a.pointPctg ?? 0));

    // Splits de liga: de la temporada actual si ya hay muestra suficiente
    // (≥400 juegos de local); si no (inicio de temporada: ruido enorme),
    // de la última temporada regular completa — mismos datos oficiales,
    // tomados al final de la temporada anterior.
    // Temporada anterior COMPLETA (mismo endpoint oficial, tomado en la fecha
    // en que terminó la temporada regular según /standings-season). Sirve
    // para (1) los splits de liga cuando la actual tiene poca muestra y
    // (2) el "prior" de cada equipo, que el frontend mezcla con la
    // temporada actual cuando hay pocos juegos.
    const seasonStart = Number(String(teams[0]?.seasonId || "").slice(0, 4));
    let prevStandings = null;
    let priorSeasonId = null;
    if (seasonStart) {
      try {
        priorSeasonId = `${seasonStart - 1}${seasonStart}`;
        let endDate = `${seasonStart}-04-10`; // respaldo si no se encuentra la fecha real
        try {
          const seasons = await cachedFetch("nhl-standings-seasons", `${NHL_API}/standings-season`, 24 * 60 * 60 * 1000);
          const found = (seasons.seasons || []).find((x) => String(x.id) === priorSeasonId);
          if (found?.standingsEnd) endDate = found.standingsEnd;
        } catch { /* usa la fecha de respaldo */ }
        const prev = await cachedFetch(`nhl-standings-prev-${endDate}`, `${NHL_API}/standings/${endDate}`, 24 * 60 * 60 * 1000);
        if ((prev.standings || []).length > 0) prevStandings = prev.standings;
      } catch { /* sin prior: el frontend usa solo la temporada actual */ }
    }
    if (prevStandings) {
      const priorByCode = {};
      for (const t of prevStandings) {
        const c = t.teamAbbrev?.default;
        if (c) priorByCode[c] = { pointPctg: t.pointPctg, gamesPlayed: t.gamesPlayed, goalFor: t.goalFor, goalAgainst: t.goalAgainst };
      }
      for (const t of teams) t.prior = priorByCode[t.code] || null;
    }

    // Splits de liga: de la temporada actual si ya hay muestra suficiente
    // (≥400 juegos de local); si no (inicio de temporada: ruido enorme),
    // de la última temporada regular completa.
    let league = computeNhlLeagueSplits(data.standings || []);
    let leagueSource = "temporada actual";
    if ((!league || league.homeGames < 400) && prevStandings) {
      const prevLeague = computeNhlLeagueSplits(prevStandings);
      if (prevLeague && prevLeague.homeGames >= 400) { league = prevLeague; leagueSource = "temporada anterior completa"; }
    }
    res.json({ teams, seasonId: teams[0]?.seasonId ?? null, priorSeasonId, league, leagueSource });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nhl/team/:code/schedule-analysis ----
// Fuerza real de calendario (promedio del % de puntos de los rivales ya
// enfrentados esta temporada de referencia) + récord real desglosado por
// la división/conferencia del RIVAL de cada juego — mismo principio que
// ya usamos en MLB y NFL. Usa la MISMA temporada que reporta
// /standings/now, así que si la 2026-27 todavía no tiene suficientes
// juegos reales, cae de forma honesta en la última temporada regular
// completa, en vez de fallar o devolver un número vacío.
app.get("/api/nhl/team/:code/schedule-analysis", async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const standingsData = await cachedFetch("nhl-standings", `${NHL_API}/standings/now`, 60 * 60 * 1000);
    const teams = standingsData.standings || [];
    const seasonId = teams[0]?.seasonId;
    if (!seasonId) return res.status(502).json({ error: "No se pudo determinar la temporada real de referencia" });

    const infoByCode = {};
    for (const t of teams) {
      const abbrev = t.teamAbbrev?.default;
      if (!abbrev) continue;
      infoByCode[abbrev] = { winPctg: t.pointPctg ?? t.winPctg, divisionName: t.divisionName, conferenceName: t.conferenceName };
    }
    const own = infoByCode[code] || null;

    const scheduleData = await cachedFetch(
      `nhl-schedule-season-${code}-${seasonId}`,
      `${NHL_API}/club-schedule-season/${code}/${seasonId}`,
      60 * 60 * 1000
    );
    const games = (scheduleData.games || []).filter((g) => g.gameType === 2 && g.gameState === "OFF");

    let sosSum = 0, sosCount = 0;
    const recordByDivision = {};
    const recordByConference = { sameConference: { w: 0, l: 0 }, interconference: { w: 0, l: 0 } };

    for (const g of games) {
      const isHome = g.homeTeam?.abbrev === code;
      const self = isHome ? g.homeTeam : g.awayTeam;
      const opp = isHome ? g.awayTeam : g.homeTeam;
      if (self?.score == null || opp?.score == null || self.score === opp.score) continue; // la NHL no tiene empates reales (se define en OT/shootout)
      const won = self.score > opp.score;
      const bucket = won ? "w" : "l";

      const oppInfo = infoByCode[opp.abbrev];
      if (oppInfo?.winPctg != null) { sosSum += oppInfo.winPctg; sosCount++; }
      if (oppInfo?.divisionName) {
        if (!recordByDivision[oppInfo.divisionName]) recordByDivision[oppInfo.divisionName] = { name: oppInfo.divisionName, w: 0, l: 0 };
        recordByDivision[oppInfo.divisionName][bucket]++;
        if (own && oppInfo.conferenceName === own.conferenceName) recordByConference.sameConference[bucket]++;
        else recordByConference.interconference[bucket]++;
      }
    }

    res.json({
      avgOpponentWinPct: sosCount > 0 ? sosSum / sosCount : null,
      gamesPlayed: sosCount,
      recordByDivision, recordByConference,
      ownDivisionName: own?.divisionName ?? null,
      ownConferenceName: own?.conferenceName ?? null,
      seasonId,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL — Fase 2: portero titular real + Over/Under ----
// La NHL oficial NO publica el portero titular confirmado antes del
// partido (se verificó en vivo); ESPN sí lo hace (campo "probables", con
// estado Confirmed/Expected), así que se usa ESPN solo para ESO — el
// nombre y si está confirmado o solo se espera — y luego se busca a ese
// portero en las estadísticas REALES y oficiales de la NHL de su propio
// equipo (mismo principio que ya usamos: nunca inventar un número,
// siempre cruzar con la fuente oficial). Los eventos de ESPN y NHL usan
// IDs de equipo distintos, así que se emparejan por el nombre completo
// real del equipo (ej. "Toronto Maple Leafs"), no por abreviación —
// varias abreviaciones no coinciden entre las dos APIs (NJ vs NJD, LA vs
// LAK, etc.), y esto evita ese problema de raíz.
// ==========================================================================

// Save % promedio real de la liga en la temporada 2023-24 (.903) — fuente:
// StatMuse, sobre 79,025 tiros reales de toda la NHL
// (https://www.statmuse.com/nhl/ask/nhl-league-average-goalie-save-percentage-in-2024).
// Se usa como línea base para medir qué tan bueno/malo es un portero
// específico, igual que ya hacemos con el ERA promedio de liga en MLB.
const NHL_LEAGUE_AVG_SAVE_PCT = 0.903;

async function findEspnProbableGoalie(homeFullName, awayFullName, date) {
  const dateParam = date.replace(/-/g, "");
  const scoreboard = await cachedFetch(
    `espn-nhl-scoreboard-${date}`,
    `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${dateParam}`,
    15 * 60 * 1000
  );
  const events = scoreboard.events || [];
  const norm = (s) => (s || "").toLowerCase().trim();
  const match = events.find((e) => {
    const comp = e.competitions?.[0];
    const names = (comp?.competitors || []).map((c) => norm(c.team?.displayName));
    return names.includes(norm(homeFullName)) && names.includes(norm(awayFullName));
  });
  if (!match) return { home: null, away: null };

  const comp = match.competitions[0];
  const getProbable = (homeAway) => {
    const competitor = comp.competitors.find((c) => c.homeAway === homeAway);
    const probable = (competitor?.probables || []).find((p) => p.name === "probableStartingGoalie");
    if (!probable) return null;
    return { name: probable.athlete?.fullName || null, status: probable.status?.name || null };
  };
  return { home: getProbable("home"), away: getProbable("away") };
}

async function getRealGoalieStats(code, seasonId, goalieName) {
  if (!goalieName) return null;
  const data = await cachedFetch(
    `nhl-club-stats-${code}-${seasonId}`,
    `${NHL_API}/club-stats/${code}/${seasonId}/2`,
    60 * 60 * 1000
  );
  const norm = (s) => (s || "").toLowerCase().trim();
  const target = norm(goalieName);
  const found = (data.goalies || []).find((g) => {
    const full = `${g.firstName?.default || ""} ${g.lastName?.default || ""}`;
    return norm(full) === target || target.includes(norm(g.lastName?.default));
  });
  if (!found) return null;
  return {
    id: found.playerId ?? null,
    name: `${found.firstName?.default || ""} ${found.lastName?.default || ""}`.trim(),
    gamesPlayed: found.gamesPlayed ?? null,
    savePercentage: found.savePercentage ?? null,
    goalsAgainstAverage: found.goalsAgainstAverage ?? null,
    wins: found.wins ?? null,
    losses: found.losses ?? null,
  };
}

// ---- GET /api/nhl/goalies/:homeCode/:awayCode ----
app.get("/api/nhl/goalies/:homeCode/:awayCode", async (req, res) => {
  const homeCode = req.params.homeCode.toUpperCase();
  const awayCode = req.params.awayCode.toUpperCase();
  const date = req.query.date || todayET();
  const { homeName, awayName } = req.query;
  if (!homeName || !awayName) {
    return res.status(400).json({ error: "Se requieren homeName y awayName (nombre completo real del equipo) para emparejar con ESPN" });
  }
  try {
    const standingsData = await cachedFetch("nhl-standings", `${NHL_API}/standings/now`, 60 * 60 * 1000);
    const seasonId = standingsData.standings?.[0]?.seasonId;
    if (!seasonId) return res.status(502).json({ error: "No se pudo determinar la temporada real de referencia" });

    const probables = await findEspnProbableGoalie(homeName, awayName, date);
    const [homeStats, awayStats] = await Promise.all([
      getRealGoalieStats(homeCode, seasonId, probables.home?.name).catch(() => null),
      getRealGoalieStats(awayCode, seasonId, probables.away?.name).catch(() => null),
    ]);

    res.json({
      home: probables.home ? { ...probables.home, stats: homeStats } : null,
      away: probables.away ? { ...probables.away, stats: awayStats } : null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL: Backtesting real — mismo principio que ya usamos en MLB/NFL:
// se guarda la predicción ANTES de saberse el resultado, y se revisa
// después contra el marcador real de la API oficial de NHL (no ESPN aquí
// — ya tenemos el resultado real directo de la misma fuente que usamos
// para /api/nhl/games, sin necesidad de una segunda fuente). Los juegos
// de pretemporada NO se guardan (el frontend los filtra antes de llamar a
// /save) porque no miden nada real sobre la fuerza real del equipo
// titular.
// ==========================================================================

// ---- POST /api/nhl/predictions/save ----
app.post("/api/nhl/predictions/save", async (req, res) => {
  const { game_date, home_code, away_code, home_win_prob } = req.body || {};
  if (!game_date || !home_code || !away_code || home_win_prob == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nhl_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nhl_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, home_win_prob }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nhl/predictions/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nhl/predictions/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/nhl/predictions/check ----
app.post("/api/nhl/predictions/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nhl_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        const data = await cachedFetch(`nhl-schedule-${pred.game_date}`, `${NHL_API}/schedule/${pred.game_date}`, 15 * 60 * 1000);
        const day = (data.gameWeek || []).find((d) => d.date === pred.game_date);
        const match = (day?.games || []).find(
          (g) => g.homeTeam?.abbrev === pred.home_code && g.awayTeam?.abbrev === pred.away_code && (g.gameState === "OFF" || g.gameState === "FINAL")
        );
        if (!match) return false;
        const winner = match.homeTeam.score > match.awayTeam.score ? pred.home_code : pred.away_code;

        await fetch(`${SUPABASE_URL}/rest/v1/nhl_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_winner: winner, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nhl/predictions/accuracy ----
app.get("/api/nhl/predictions/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD: mide solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nhl_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, brierScore: null, recent: [] });
    }
    let correctFavorite = 0;
    let brierSum = 0;
    for (const row of rows) {
      const predictedFavorite = row.home_win_prob >= 0.5 ? row.home_code : row.away_code;
      if (predictedFavorite === row.actual_winner) correctFavorite++;
      const actualHomeWon = row.actual_winner === row.home_code ? 1 : 0;
      brierSum += Math.pow(row.home_win_prob - actualHomeWon, 2);
    }
    res.json({
      totalChecked: rows.length,
      accuracy: correctFavorite / rows.length,
      brierScore: brierSum / rows.length,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        homeWinProb: r.home_win_prob, actualWinner: r.actual_winner,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/nhl/overunder/save ----
app.post("/api/nhl/overunder/save", async (req, res) => {
  const { game_date, home_code, away_code, line, over_prob, expected_total } = req.body || {};
  if (!game_date || !home_code || !away_code || line == null || over_prob == null || expected_total == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nhl_overunder_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) {
      return res.json({ saved: false, reason: "ya existía" });
    }
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nhl_overunder_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, line, over_prob, expected_total }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nhl/overunder/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nhl/overunder/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- POST /api/nhl/overunder/check ----
app.post("/api/nhl/overunder/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nhl_overunder_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());

    const results = await Promise.all(
      pending.map(async (pred) => {
        const data = await cachedFetch(`nhl-schedule-${pred.game_date}`, `${NHL_API}/schedule/${pred.game_date}`, 15 * 60 * 1000);
        const day = (data.gameWeek || []).find((d) => d.date === pred.game_date);
        const match = (day?.games || []).find(
          (g) => g.homeTeam?.abbrev === pred.home_code && g.awayTeam?.abbrev === pred.away_code && (g.gameState === "OFF" || g.gameState === "FINAL")
        );
        if (!match) return false;
        const totalGoals = match.homeTeam.score + match.awayTeam.score;
        const result = totalGoals > pred.line ? "over" : totalGoals < pred.line ? "under" : "push";

        await fetch(`${SUPABASE_URL}/rest/v1/nhl_overunder_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_total_goals: totalGoals, actual_result: result, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nhl/overunder/accuracy ----
app.get("/api/nhl/overunder/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD: mide solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nhl_overunder_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, recent: [] });
    }
    const decisive = rows.filter((r) => r.actual_result !== "push");
    let correct = 0;
    for (const r of decisive) {
      const predictedSide = r.over_prob >= 0.5 ? "over" : "under";
      if (predictedSide === r.actual_result) correct++;
    }
    res.json({
      totalChecked: decisive.length,
      accuracy: decisive.length > 0 ? correct / decisive.length : null,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        line: r.line, overProb: r.over_prob, expectedTotal: r.expected_total,
        actualTotalGoals: r.actual_total_goals, actualResult: r.actual_result,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL — Picks del día: equipo favorito + goleador real. Mismo
// principio que ya usamos en NFL (TD) y MLB (jonrón): probabilidad real
// vía Poisson sobre la tasa de goles por juego REAL de esta temporada —
// nunca un número inventado. Con la temporada recién empezada (1-2
// juegos por jugador todavía), esa tasa es ruidosa — se muestra
// gamesPlayed real para que el usuario vea la muestra con la que se
// calculó, igual que ya se hace con otras probabilidades tempranas.
// ==========================================================================

// ---- GET /api/nhl/team/:code/skater-stats ----
app.get("/api/nhl/team/:code/skater-stats", async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const standingsData = await cachedFetch("nhl-standings", `${NHL_API}/standings/now`, 60 * 60 * 1000);
    const seasonId = standingsData.standings?.[0]?.seasonId;
    if (!seasonId) return res.status(502).json({ error: "No se pudo determinar la temporada real de referencia" });

    const data = await cachedFetch(
      `nhl-club-stats-${code}-${seasonId}`,
      `${NHL_API}/club-stats/${code}/${seasonId}/2`,
      60 * 60 * 1000
    );
    const skaters = (data.skaters || []).filter((s) => s.positionCode !== "G" && (s.gamesPlayed || 0) > 0);

    const players = skaters.map((s) => {
      const goalsPerGame = s.goals / s.gamesPlayed;
      // Probabilidad real de al menos 1 gol vía Poisson — mismo
      // principio que ya usamos para TD (NFL) y jonrones (MLB).
      const goalProbability = 1 - Math.exp(-goalsPerGame);
      // Asistencias y puntos (goles + asistencias): mismo principio —
      // Poisson sobre su tasa real por juego esta temporada.
      const assistsPerGame = (s.assists || 0) / s.gamesPlayed;
      const pointsPerGame = (s.points || 0) / s.gamesPlayed;
      return {
        id: s.playerId,
        name: `${s.firstName?.default || ""} ${s.lastName?.default || ""}`.trim(),
        position: s.positionCode,
        gamesPlayed: s.gamesPlayed,
        goals: s.goals,
        goalsPerGame,
        goalProbability,
        assists: s.assists || 0,
        assistProbability: 1 - Math.exp(-assistsPerGame),
        points: s.points || 0,
        pointProbability: 1 - Math.exp(-pointsPerGame),
      };
    });

    res.json({ players });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL: Backtesting de Picks del día (equipo + goleador) — mismo
// principio que nfl_daily_picks. El resultado de equipo se revisa contra
// la propia API oficial de NHL (ya tenemos el marcador real ahí). El
// gol de jugador se revisa contra el boxscore de juego de la NHL
// (gamecenter/{id}/boxscore) — su estructura exacta de stats por
// jugador no se pudo confirmar en vivo hoy, así que si falla, se
// revisa en otra ronda sin romper nada (mismo principio que ya
// aplicamos en NFL para el TD).
// ==========================================================================

app.post("/api/nhl/picks/save", async (req, res) => {
  const picks = req.body?.picks;
  if (!Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: "Se esperaba un arreglo 'picks'" });
  }
  try {
    const dateTypeKeys = new Set(picks.map((p) => `${p.pick_date}|${p.pick_type}`));
    for (const key of dateTypeKeys) {
      const [pick_date, pick_type] = key.split("|");
      await fetch(
        `${SUPABASE_URL}/rest/v1/nhl_daily_picks?pick_date=eq.${pick_date}&pick_type=eq.${pick_type}&checked_at=is.null`,
        { method: "DELETE", headers: supabaseHeaders }
      ).catch(() => {});
    }
    let saved = 0;
    for (const p of picks) {
      const { pick_date, pick_type, player_id, player_name, team_code, predicted_prob } = p;
      if (!pick_date || !pick_type || !player_name || !team_code || predicted_prob == null) continue;
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nhl_daily_picks`, {
        method: "POST",
        headers: { ...supabaseHeaders, Prefer: "return=representation" },
        body: JSON.stringify([{ pick_date, pick_type, player_id: player_id || null, player_name, team_code, predicted_prob }]),
      });
      if (insertRes.ok) {
        saved++;
      } else {
        const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
        console.error(`[nhl/picks/save] Supabase insert error ${insertRes.status}:`, bodyText);
      }
    }
    res.json({ saved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/nhl/picks/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nhl_daily_picks?checked_at=is.null&pick_date=lt.${today}&select=*`;
    const pendingRaw = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(pendingRaw)) {
      console.error("[nhl/picks/check] Respuesta inesperada de Supabase (¿falta la tabla nhl_daily_picks?):", JSON.stringify(pendingRaw).slice(0, 300));
      return res.json({ checked: 0, updated: 0 });
    }
    const pending = pendingRaw;

    const results = await Promise.all(
      pending.map(async (pick) => {
        const data = await cachedFetch(`nhl-schedule-${pick.pick_date}`, `${NHL_API}/schedule/${pick.pick_date}`, 15 * 60 * 1000);
        const day = (data.gameWeek || []).find((d) => d.date === pick.pick_date);
        const match = (day?.games || []).find(
          (g) =>
            (g.gameState === "OFF" || g.gameState === "FINAL") &&
            (g.homeTeam?.abbrev === pick.team_code || g.awayTeam?.abbrev === pick.team_code)
        );
        if (!match) return false;

        let success = null;
        if (pick.pick_type === "team") {
          const isHome = match.homeTeam?.abbrev === pick.team_code;
          const teamScore = isHome ? match.homeTeam.score : match.awayTeam.score;
          const oppScore = isHome ? match.awayTeam.score : match.homeTeam.score;
          success = teamScore > oppScore;
        } else if (["goal", "assist", "point"].includes(pick.pick_type) && pick.player_id) {
          try {
            const box = await cachedFetch(`nhl-boxscore-${match.id}`, `${NHL_API}/gamecenter/${match.id}/boxscore`, 60 * 60 * 1000);
            const stats = box.playerByGameStats || {};
            const allSkaters = [
              ...(stats.homeTeam?.forwards || []), ...(stats.homeTeam?.defense || []),
              ...(stats.awayTeam?.forwards || []), ...(stats.awayTeam?.defense || []),
            ];
            const found = allSkaters.find((s) => String(s.playerId) === String(pick.player_id));
            if (found) {
              // gol = al menos 1 gol; asistencia = al menos 1 asistencia;
              // punto = al menos 1 gol o asistencia (campo "points" del
              // boxscore oficial de la NHL).
              const field = pick.pick_type === "goal" ? "goals" : pick.pick_type === "assist" ? "assists" : "points";
              success = (found[field] || 0) > 0;
            }
          } catch { /* se revisa en otra ronda */ }
        }

        if (success == null) return false;
        await fetch(`${SUPABASE_URL}/rest/v1/nhl_daily_picks?id=eq.${pick.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_success: success, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    const updated = results.filter(Boolean).length;
    res.json({ checked: pending.length, updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nhl/picks/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD
    const sinceFilter = since ? `&pick_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nhl_daily_picks?checked_at=not.is.null${sinceFilter}&select=*&order=pick_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(rows)) {
      console.error("[nhl/picks/accuracy] Respuesta inesperada de Supabase (¿falta la tabla nhl_daily_picks?):", JSON.stringify(rows).slice(0, 300));
      const empty = { accuracy: null, total: 0 };
      return res.json({ teams: empty, goal: empty, assist: empty, point: empty, recent: [] });
    }
    const summarize = (type) => {
      const filtered = rows.filter((r) => r.pick_type === type);
      if (filtered.length === 0) return { accuracy: null, total: 0 };
      const correct = filtered.filter((r) => r.actual_success === true).length;
      return { accuracy: correct / filtered.length, total: filtered.length };
    };
    res.json({
      teams: summarize("team"),
      goal: summarize("goal"),
      assist: summarize("assist"),
      point: summarize("point"),
      recent: rows.slice(0, 20).map((r) => ({
        date: r.pick_date, type: r.pick_type, name: r.player_name, team: r.team_code,
        prob: r.predicted_prob, success: r.actual_success,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nhl/backtest-status ----
// Diagnóstico: cuántas predicciones hay realmente guardadas / pendientes
// de revisar en cada tabla de backtesting de NHL, y si alguna tabla no
// existe en Supabase (en cuyo caso nada se estaría guardando).
app.get("/api/nhl/backtest-status", async (req, res) => {
  const tables = {
    predictions: "nhl_predictions",
    overunder: "nhl_overunder_predictions",
    picks: "nhl_daily_picks",
  };
  try {
    const entries = await Promise.all(
      Object.entries(tables).map(async ([key, table]) => {
        try {
          const rows = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,checked_at`, { headers: supabaseHeaders }).then((r) => r.json());
          if (!Array.isArray(rows)) return [key, { exists: false, total: 0, pending: 0 }];
          return [key, { exists: true, total: rows.length, pending: rows.filter((r) => r.checked_at == null).length }];
        } catch {
          return [key, { exists: false, total: 0, pending: 0 }];
        }
      })
    );
    res.json(Object.fromEntries(entries));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NBA — Fase 1 (juegos reales, tabla de posiciones, probabilidad de
// ganar, fuerza de calendario, descanso/back-to-back, backtesting). Fuente:
// la API pública de ESPN para NBA (verificada en vivo): scoreboard con
// récords y marcadores, standings con puntos a favor/en contra y récord
// casa/ruta/últimos 10, y calendario por equipo. Mismo principio que ya
// usamos en MLB/NFL/NHL: cada número viene de una fuente real, nunca
// inventado. Pendiente (Fase 2): lesiones/alineación real (el factor más
// grande en NBA, el equivalente al portero en NHL) + Over/Under + Picks
// de jugadores.
// ==========================================================================

const ESPN_NBA_SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const ESPN_NBA_V2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba";

// "31-9" -> { w: 31, l: 9 }
function parseNbaRecord(summary) {
  const m = /^(\d+)-(\d+)/.exec(summary || "");
  return m ? { w: Number(m[1]), l: Number(m[2]) } : null;
}

// Fecha YYYY-MM-DD -> YYYYMMDD (formato del parámetro dates de ESPN)
function espnDateParam(date) {
  return date.replace(/-/g, "");
}

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mapNbaEvent(e) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");
  const seasonType = e.season?.type ?? null; // 1 = pretemporada, 2 = regular, 3 = playoffs
  const statusName = comp?.status?.type?.name || e.status?.type?.name || null;
  const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    id: e.id,
    startTime: e.date,
    seasonType,
    isPreseason: seasonType === 1,
    status: statusName, // STATUS_SCHEDULED | STATUS_IN_PROGRESS | STATUS_FINAL ...
    completed: !!comp?.status?.type?.completed,
    venue: comp?.venue?.fullName || null,
    awayCode: away?.team?.abbreviation, awayName: away?.team?.shortDisplayName || away?.team?.name || away?.team?.displayName,
    awayFullName: away?.team?.displayName || null, awayId: away?.team?.id, awayScore: num(away?.score),
    homeCode: home?.team?.abbreviation, homeName: home?.team?.shortDisplayName || home?.team?.name || home?.team?.displayName,
    homeFullName: home?.team?.displayName || null, homeId: home?.team?.id, homeScore: num(home?.score),
    awayWinner: away?.winner === true, homeWinner: home?.winner === true,
  };
}

// ---- GET /api/nba/games?date=YYYY-MM-DD ----
app.get("/api/nba/games", async (req, res) => {
  try {
    const date = req.query.date || todayET();
    const data = await cachedFetch(`nba-scoreboard-${date}`, `${ESPN_NBA_SITE}/scoreboard?dates=${espnDateParam(date)}`, 5 * 60 * 1000);
    const games = (data.events || []).map(mapNbaEvent);
    res.json({ date, games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nba/standings ----
// Posiciones reales. Incluye puntos a favor/en contra por juego (base de
// la Expectativa Pitagórica), récord casa/ruta, últimos 10 y racha.
// leagueHomeWinPct se MIDE de los récords casa/ruta reales de los 30
// equipos de la misma temporada (no un número citado de memoria).
app.get("/api/nba/standings", async (req, res) => {
  try {
    const data = await cachedFetch("nba-standings", `${ESPN_NBA_V2}/standings`, 60 * 60 * 1000);
    const teams = [];
    let seasonYear = null, seasonDisplayName = null;
    for (const conf of data.children || []) {
      seasonYear = seasonYear ?? conf.standings?.season ?? null;
      seasonDisplayName = seasonDisplayName ?? conf.standings?.seasonDisplayName ?? null;
      for (const entry of conf.standings?.entries || []) {
        const stat = (name) => entry.stats?.find((s) => s.name === name);
        const val = (name) => stat(name)?.value ?? null;
        const rec = (name) => parseNbaRecord(stat(name)?.summary || stat(name)?.displayValue);
        const home = rec("Home"), road = rec("Road"), l10 = rec("Last Ten Games");
        teams.push({
          id: entry.team?.id,
          code: entry.team?.abbreviation,
          name: entry.team?.shortDisplayName || entry.team?.name,
          fullName: entry.team?.displayName || null,
          conference: conf.name || conf.abbreviation || null,
          wins: val("wins"), losses: val("losses"), winPct: val("winPercent"),
          avgPointsFor: val("avgPointsFor"), avgPointsAgainst: val("avgPointsAgainst"),
          differential: val("differential"),
          homeWins: home?.w ?? null, homeLosses: home?.l ?? null,
          roadWins: road?.w ?? null, roadLosses: road?.l ?? null,
          l10Wins: l10?.w ?? null, l10Losses: l10?.l ?? null,
          streak: stat("streak")?.displayValue ?? null,
        });
      }
    }
    teams.sort((a, b) => (b.winPct ?? 0) - (a.winPct ?? 0));
    const homeShare = (list) => {
      let hw = 0, hl = 0;
      for (const t of list) { hw += t.homeWins || 0; hl += t.homeLosses || 0; }
      return { games: hw + hl, pct: hw + hl > 0 ? hw / (hw + hl) : null };
    };
    // Ventaja de casa de la liga MEDIDA: de la temporada de estas
    // posiciones si ya hay muestra suficiente (≥400 juegos de local); si
    // no (inicio de temporada: ruido enorme), de la temporada anterior
    // completa (misma API de ESPN con ?season=año-1).
    let { games, pct } = homeShare(teams);
    let leagueHomeSource = seasonDisplayName;
    if (games < 400 && seasonYear) {
      try {
        const prev = await cachedFetch(`nba-standings-${seasonYear - 1}`, `${ESPN_NBA_V2}/standings?season=${seasonYear - 1}`, 24 * 60 * 60 * 1000);
        const prevTeams = [];
        let prevName = null;
        for (const conf of prev.children || []) {
          prevName = prevName ?? conf.standings?.seasonDisplayName ?? null;
          for (const entry of conf.standings?.entries || []) {
            const hs = entry.stats?.find((x) => x.name === "Home");
            const rec = parseNbaRecord(hs?.summary || hs?.displayValue);
            if (rec) prevTeams.push({ homeWins: rec.w, homeLosses: rec.l });
          }
        }
        const p = homeShare(prevTeams);
        if (p.games >= 400) { pct = p.pct; games = p.games; leagueHomeSource = prevName; }
      } catch { /* se queda con lo que haya */ }
    }
    res.json({
      teams,
      seasonYear, seasonDisplayName,
      leagueHomeWinPct: games >= 400 ? pct : null,
      leagueHomeSource,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nba/team/:id/schedule-analysis ----
// Fuerza real de calendario: promedio del % de victorias de los rivales ya
// enfrentados en la temporada de referencia (la misma que reporta
// /standings — si la 2026-27 aún no tiene juegos de temporada regular,
// cae honestamente en la última completa).
app.get("/api/nba/team/:id/schedule-analysis", async (req, res) => {
  const teamId = String(req.params.id);
  try {
    const standings = await cachedFetch("nba-standings", `${ESPN_NBA_V2}/standings`, 60 * 60 * 1000);
    const winPctById = {};
    let seasonYear = null, seasonDisplayName = null;
    for (const conf of standings.children || []) {
      seasonYear = seasonYear ?? conf.standings?.season ?? null;
      seasonDisplayName = seasonDisplayName ?? conf.standings?.seasonDisplayName ?? null;
      for (const entry of conf.standings?.entries || []) {
        const wp = entry.stats?.find((s) => s.name === "winPercent")?.value;
        if (entry.team?.id != null && wp != null) winPctById[String(entry.team.id)] = wp;
      }
    }
    if (!seasonYear) return res.status(502).json({ error: "No se pudo determinar la temporada real de referencia" });

    const sched = await cachedFetch(
      `nba-team-schedule-${teamId}-${seasonYear}`,
      `${ESPN_NBA_SITE}/teams/${teamId}/schedule?season=${seasonYear}&seasontype=2`,
      60 * 60 * 1000
    );
    let sosSum = 0, sosCount = 0;
    const totals = []; // puntos totales (ambos equipos) de cada juego terminado
    for (const e of sched.events || []) {
      const comp = e.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      const opp = (comp.competitors || []).find((c) => String(c.team?.id) !== teamId);
      const self = (comp.competitors || []).find((c) => String(c.team?.id) === teamId);
      const wp = opp ? winPctById[String(opp.team?.id)] : null;
      if (wp != null) { sosSum += wp; sosCount++; }
      const a = Number(self?.score?.value ?? self?.score), b = Number(opp?.score?.value ?? opp?.score);
      if (Number.isFinite(a) && Number.isFinite(b) && a + b > 0) totals.push(a + b);
    }
    // Desviación estándar REAL de los totales de este equipo en la
    // temporada de referencia (medida, no citada) — base del Over/Under.
    let avgTotal = null, totalSD = null;
    if (totals.length >= 20) {
      avgTotal = totals.reduce((x, y) => x + y, 0) / totals.length;
      totalSD = Math.sqrt(totals.reduce((x, y) => x + Math.pow(y - avgTotal, 2), 0) / (totals.length - 1));
    }
    res.json({
      avgOpponentWinPct: sosCount > 0 ? sosSum / sosCount : null,
      gamesPlayed: sosCount,
      avgTotal, totalSD, totalGames: totals.length,
      seasonYear, seasonDisplayName,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- GET /api/nba/rest?date=YYYY-MM-DD ----
// Equipos que jugaron AYER (día anterior en hora del Este) — para detectar
// el segundo juego de un back-to-back con el calendario real, sin
// suposiciones. Devuelve los códigos que jugaron y si fue pretemporada.
app.get("/api/nba/rest", async (req, res) => {
  try {
    const date = req.query.date || todayET();
    const prev = shiftDate(date, -1);
    const data = await cachedFetch(`nba-scoreboard-${prev}`, `${ESPN_NBA_SITE}/scoreboard?dates=${espnDateParam(prev)}`, 30 * 60 * 1000);
    const playedYesterday = new Set();
    for (const g of (data.events || []).map(mapNbaEvent)) {
      if (g.isPreseason) continue; // en pretemporada los titulares casi no juegan: no cuenta como carga real
      if (g.homeCode) playedYesterday.add(g.homeCode);
      if (g.awayCode) playedYesterday.add(g.awayCode);
    }
    res.json({ date, previousDate: prev, playedYesterday: [...playedYesterday] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NBA: Backtesting real — se guarda la predicción ANTES del juego y se
// revisa después contra el marcador real de ESPN. Los juegos de
// pretemporada NO se guardan (no miden la fuerza real del equipo titular).
// ==========================================================================

app.post("/api/nba/predictions/save", async (req, res) => {
  const { game_date, home_code, away_code, home_win_prob } = req.body || {};
  if (!game_date || !home_code || !away_code || home_win_prob == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nba_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) return res.json({ saved: false, reason: "ya existía" });
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nba_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, home_win_prob }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nba/predictions/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nba/predictions/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/nba/predictions/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nba_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(pending)) {
      console.error("[nba/predictions/check] Respuesta inesperada de Supabase (¿falta la tabla nba_predictions?):", JSON.stringify(pending).slice(0, 300));
      return res.json({ checked: 0, updated: 0 });
    }
    const results = await Promise.all(
      pending.map(async (pred) => {
        const data = await cachedFetch(`nba-scoreboard-${pred.game_date}`, `${ESPN_NBA_SITE}/scoreboard?dates=${espnDateParam(pred.game_date)}`, 15 * 60 * 1000);
        const match = (data.events || []).map(mapNbaEvent).find(
          (g) => g.homeCode === pred.home_code && g.awayCode === pred.away_code && g.completed
        );
        if (!match || match.homeScore == null || match.awayScore == null || match.homeScore === match.awayScore) return false;
        const winner = match.homeScore > match.awayScore ? pred.home_code : pred.away_code;
        await fetch(`${SUPABASE_URL}/rest/v1/nba_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_winner: winner, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    res.json({ checked: pending.length, updated: results.filter(Boolean).length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nba/predictions/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD: mide solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nba_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ totalChecked: 0, accuracy: null, brierScore: null, recent: [] });
    }
    let correct = 0, brierSum = 0;
    for (const row of rows) {
      const fav = row.home_win_prob >= 0.5 ? row.home_code : row.away_code;
      if (fav === row.actual_winner) correct++;
      brierSum += Math.pow(row.home_win_prob - (row.actual_winner === row.home_code ? 1 : 0), 2);
    }
    res.json({
      totalChecked: rows.length,
      accuracy: correct / rows.length,
      brierScore: brierSum / rows.length,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        homeWinProb: r.home_win_prob, actualWinner: r.actual_winner,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nba/backtest-status", async (req, res) => {
  try {
    const summarize = async (table) => {
      try {
        const rows = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,checked_at`, { headers: supabaseHeaders }).then((r) => r.json());
        if (!Array.isArray(rows)) return { exists: false, total: 0, pending: 0 };
        return { exists: true, total: rows.length, pending: rows.filter((r) => r.checked_at == null).length };
      } catch {
        return { exists: false, total: 0, pending: 0 };
      }
    };
    const [predictions, overunder, picks] = await Promise.all([summarize("nba_predictions"), summarize("nba_overunder_predictions"), summarize("nba_daily_picks")]);
    res.json({ predictions, overunder, picks });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NBA — Fase 2: lesiones reales + Over/Under ----
// Lesiones: reporte real de ESPN (Out / Day-To-Day) cruzado con las
// estadísticas REALES de cada jugador en la temporada de referencia
// (minutos por juego y PER, de la API de ESPN). Valor de un jugador:
// Box Plus/Minus (BPM) en puntos por 100 posesiones sobre el promedio de
// la liga, con la escala oficial de Basketball-Reference (+8 = MVP, +4 =
// consideración All-Star, -2 = nivel de reemplazo). ESPN no publica BPM,
// así que se ESTIMA a partir de PER con una interpolación lineal
// (PER 15 = promedio = BPM 0; un PER de MVP ~29 = BPM +8 → pendiente
// ~0.53). Es una aproximación, no un dato oficial: se dice en pantalla.
// Puntos perdidos por juego ≈ (BPM estimado − (-2)) × (minutos/48), solo
// si es mejor que reemplazo. (Por 100 posesiones ≈ por juego: el ritmo de
// la NBA ronda las 100 posesiones.) Peso por estatus: Out = 1.0,
// Day-To-Day = 0.5 (decisión SUBJETIVA, se evaluará con el backtesting).
// ==========================================================================

const NBA_PER_TO_BPM_SLOPE = 0.53;
const NBA_REPLACEMENT_BPM = -2.0; // Basketball-Reference
const NBA_MIN_GAMES_FOR_PLAYER_STATS = 20; // con menos juegos el PER es muy ruidoso

function extractAthleteId(a) {
  if (!a) return null;
  if (a.id) return String(a.id);
  for (const l of a.links || []) {
    const m = /\/id\/(\d+)/.exec(l.href || "");
    if (m) return m[1];
  }
  const m2 = /\/(\d+)\.png/.exec(a.headshot?.href || "");
  return m2 ? m2[1] : null;
}

async function getNbaPlayerValue(athleteId, seasonYear) {
  try {
    const data = await cachedFetch(
      `nba-player-stats-${athleteId}-${seasonYear}`,
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${seasonYear}/types/2/athletes/${athleteId}/statistics/0`,
      60 * 60 * 1000
    );
    const stat = (cat, name) => data.splits?.categories?.find((c) => c.name === cat)?.stats?.find((x) => x.name === name)?.value ?? null;
    return {
      gamesPlayed: stat("general", "gamesPlayed"),
      avgMinutes: stat("general", "avgMinutes"),
      per: stat("general", "PER"),
      avgPoints: stat("offensive", "avgPoints"),
    };
  } catch {
    return null;
  }
}

// ---- GET /api/nba/game-injuries?homeId=&awayId= ----
app.get("/api/nba/game-injuries", async (req, res) => {
  const { homeId, awayId } = req.query;
  if (!homeId || !awayId) return res.status(400).json({ error: "Se requieren homeId y awayId" });
  try {
    const standings = await cachedFetch("nba-standings", `${ESPN_NBA_V2}/standings`, 60 * 60 * 1000);
    const seasonYear = standings.children?.[0]?.standings?.season;
    const inj = await cachedFetch("nba-injuries", `${ESPN_NBA_SITE}/injuries`, 10 * 60 * 1000);

    const buildTeam = async (teamId) => {
      const group = (inj.injuries || []).find((g) => String(g.id) === String(teamId));
      const entries = (group?.injuries || []).slice(0, 12);
      const players = await Promise.all(
        entries.map(async (e) => {
          const status = e.status || e.type?.description || null; // "Out" | "Day-To-Day"
          const athleteId = extractAthleteId(e.athlete);
          const stats = athleteId && seasonYear ? await getNbaPlayerValue(athleteId, seasonYear) : null;
          const reliable = stats && stats.per != null && stats.avgMinutes != null && (stats.gamesPlayed || 0) >= NBA_MIN_GAMES_FOR_PLAYER_STATS;
          let lostPoints = 0, bpmEstimate = null;
          if (reliable) {
            bpmEstimate = NBA_PER_TO_BPM_SLOPE * (stats.per - 15);
            const valueOverReplacement = Math.max(0, bpmEstimate - NBA_REPLACEMENT_BPM);
            const weight = status === "Out" ? 1.0 : status === "Day-To-Day" ? 0.5 : 0;
            lostPoints = valueOverReplacement * (stats.avgMinutes / 48) * weight;
          }
          return {
            name: e.athlete?.displayName || null,
            position: e.athlete?.position?.abbreviation || null,
            status,
            injury: [e.details?.type, e.details?.detail].filter(Boolean).join(" · ") || null,
            returnDate: e.details?.returnDate || null,
            hasStats: !!reliable,
            gamesPlayed: stats?.gamesPlayed ?? null,
            avgMinutes: stats?.avgMinutes ?? null,
            avgPoints: stats?.avgPoints ?? null,
            per: stats?.per ?? null,
            bpmEstimate,
            lostPoints,
          };
        })
      );
      players.sort((a, b) => b.lostPoints - a.lostPoints);
      return { players, lostPoints: players.reduce((x, p) => x + p.lostPoints, 0) };
    };

    const [home, away] = await Promise.all([buildTeam(homeId), buildTeam(awayId)]);
    res.json({ home, away, seasonYear });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NBA: Backtesting real de Over/Under ----
// ==========================================================================

app.post("/api/nba/overunder/save", async (req, res) => {
  const { game_date, home_code, away_code, line, over_prob, expected_total } = req.body || {};
  if (!game_date || !home_code || !away_code || line == null || over_prob == null || expected_total == null) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  try {
    const checkUrl = `${SUPABASE_URL}/rest/v1/nba_overunder_predictions?game_date=eq.${game_date}&home_code=eq.${home_code}&away_code=eq.${away_code}&select=id`;
    const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length > 0) return res.json({ saved: false, reason: "ya existía" });
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nba_overunder_predictions`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
      body: JSON.stringify([{ game_date, home_code, away_code, line, over_prob, expected_total }]),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(() => "(sin cuerpo)");
      console.error(`[nba/overunder/save] Supabase insert error ${insertRes.status}:`, bodyText);
      throw new Error(`Supabase insert error ${insertRes.status}: ${bodyText}`);
    }
    res.json({ saved: true });
  } catch (err) {
    console.error("[nba/overunder/save] Error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/nba/overunder/check", async (req, res) => {
  try {
    const today = todayET();
    const pendingUrl = `${SUPABASE_URL}/rest/v1/nba_overunder_predictions?checked_at=is.null&game_date=lt.${today}&select=*`;
    const pending = await fetch(pendingUrl, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(pending)) {
      console.error("[nba/overunder/check] Respuesta inesperada de Supabase (¿falta la tabla nba_overunder_predictions?):", JSON.stringify(pending).slice(0, 300));
      return res.json({ checked: 0, updated: 0 });
    }
    const results = await Promise.all(
      pending.map(async (pred) => {
        const data = await cachedFetch(`nba-scoreboard-${pred.game_date}`, `${ESPN_NBA_SITE}/scoreboard?dates=${espnDateParam(pred.game_date)}`, 15 * 60 * 1000);
        const match = (data.events || []).map(mapNbaEvent).find(
          (g) => g.homeCode === pred.home_code && g.awayCode === pred.away_code && g.completed
        );
        if (!match || match.homeScore == null || match.awayScore == null) return false;
        const total = match.homeScore + match.awayScore;
        const result = total > pred.line ? "over" : total < pred.line ? "under" : "push";
        await fetch(`${SUPABASE_URL}/rest/v1/nba_overunder_predictions?id=eq.${pred.id}`, {
          method: "PATCH",
          headers: supabaseHeaders,
          body: JSON.stringify({ actual_total_points: total, actual_result: result, checked_at: new Date().toISOString() }),
        });
        return true;
      })
    );
    res.json({ checked: pending.length, updated: results.filter(Boolean).length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nba/overunder/accuracy", async (req, res) => {
  try {
    const since = req.query.since; // opcional ?since=YYYY-MM-DD: mide solo después de un cambio de modelo
    const sinceFilter = since ? `&game_date=gte.${since}` : "";
    const url = `${SUPABASE_URL}/rest/v1/nba_overunder_predictions?checked_at=not.is.null${sinceFilter}&select=*&order=game_date.desc`;
    const rows = dedupeGames(await fetch(url, { headers: supabaseHeaders }).then((r) => r.json()));
    if (!Array.isArray(rows) || rows.length === 0) return res.json({ totalChecked: 0, accuracy: null, recent: [] });
    const decisive = rows.filter((r) => r.actual_result !== "push");
    let correct = 0;
    for (const r of decisive) {
      if ((r.over_prob >= 0.5 ? "over" : "under") === r.actual_result) correct++;
    }
    res.json({
      totalChecked: decisive.length,
      accuracy: decisive.length > 0 ? correct / decisive.length : null,
      recent: rows.slice(0, 15).map((r) => ({
        date: r.game_date, home: r.home_code, away: r.away_code,
        line: r.line, overProb: r.over_prob, expectedTotal: r.expected_total,
        actualTotalPoints: r.actual_total_points, actualResult: r.actual_result,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NBA — Fase 3: Picks del día de jugadores ----
// SOLO con datos verificados en vivo en ESPN:
//  - Plantilla: teams/{id}/roster (id, nombre, posición).
//  - Promedios de temporada (core API): juegos, minutos, puntos, rebotes,
//    asistencias, dobles-dobles y triples-dobles REALES de la temporada.
//  - Resultado real: boxscore del juego (summary?event=) con puntos,
//    rebotes, asistencias, robos y tapones por jugador.
// La probabilidad de doble-doble / triple-doble es la FRECUENCIA REAL de la
// temporada (dobles-dobles ÷ juegos jugados). No se ajusta por rival,
// minutos de hoy ni ritmo: esa limitación se muestra en pantalla. Los picks
// de "X+ puntos/rebotes/asistencias" necesitan la distribución juego por
// juego y el registro por juego de ESPN no se pudo verificar completo, así
// que NO se inventa una desviación estándar: queda para la Fase 3b.
// ==========================================================================

async function getNbaPlayerFull(athleteId, seasonYear) {
  const one = async (year) => {
    try {
      const data = await cachedFetch(
        `nba-player-full-${athleteId}-${year}`,
        `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${year}/types/2/athletes/${athleteId}/statistics/0`,
        6 * 60 * 60 * 1000
      );
      const stat = (cat, name) => data.splits?.categories?.find((c) => c.name === cat)?.stats?.find((x) => x.name === name)?.value ?? null;
      return {
        season: year,
        gamesPlayed: stat("general", "gamesPlayed"),
        avgMinutes: stat("general", "avgMinutes"),
        avgPoints: stat("offensive", "avgPoints"),
        avgRebounds: stat("general", "avgRebounds"),
        avgAssists: stat("offensive", "avgAssists"),
        doubleDouble: stat("general", "doubleDouble"),
        tripleDouble: stat("general", "tripleDouble"),
      };
    } catch {
      return null;
    }
  };
  const cur = await one(seasonYear);
  if (cur && (cur.gamesPlayed || 0) >= NBA_MIN_GAMES_FOR_PLAYER_STATS) return cur;
  // Pocos juegos esta temporada (inicio de campaña): se usa la anterior si tiene muestra.
  const prev = await one(seasonYear - 1);
  if (prev && (prev.gamesPlayed || 0) >= NBA_MIN_GAMES_FOR_PLAYER_STATS) return prev;
  return cur || prev;
}

// ---- GET /api/nba/team/:id/players ----
app.get("/api/nba/team/:id/players", async (req, res) => {
  const teamId = req.params.id;
  try {
    const standings = await cachedFetch("nba-standings", `${ESPN_NBA_V2}/standings`, 60 * 60 * 1000);
    const seasonYear = standings.children?.[0]?.standings?.season;
    if (!seasonYear) return res.status(502).json({ error: "No se pudo determinar la temporada de referencia" });

    const roster = await cachedFetch(`nba-roster-${teamId}`, `${ESPN_NBA_SITE}/teams/${teamId}/roster`, 6 * 60 * 60 * 1000);
    const flat = [];
    for (const a of roster.athletes || []) {
      if (Array.isArray(a.items)) flat.push(...a.items);
      else flat.push(a);
    }

    // Lesionados reales (ESPN): "Out" se excluye de los picks; "Day-To-Day" se marca.
    const inj = await cachedFetch("nba-injuries", `${ESPN_NBA_SITE}/injuries`, 10 * 60 * 1000);
    const group = (inj.injuries || []).find((g) => String(g.id) === String(teamId));
    const statusById = {};
    for (const e of group?.injuries || []) {
      const id = extractAthleteId(e.athlete);
      if (id) statusById[id] = e.status || e.type?.description || null;
    }

    const players = (
      await Promise.all(
        flat.map(async (a) => {
          const id = extractAthleteId(a);
          if (!id) return null;
          const st = await getNbaPlayerFull(id, seasonYear);
          const gp = st?.gamesPlayed || 0;
          const reliable = gp >= NBA_MIN_GAMES_FOR_PLAYER_STATS;
          return {
            id,
            name: a.displayName || a.fullName || null,
            position: a.position?.abbreviation || null,
            status: statusById[id] || null,
            season: st?.season ?? null,
            gamesPlayed: gp,
            hasStats: reliable,
            avgMinutes: st?.avgMinutes ?? null,
            avgPoints: st?.avgPoints ?? null,
            avgRebounds: st?.avgRebounds ?? null,
            avgAssists: st?.avgAssists ?? null,
            doubleDoubleProb: reliable && st.doubleDouble != null ? st.doubleDouble / gp : null,
            tripleDoubleProb: reliable && st.tripleDouble != null ? st.tripleDouble / gp : null,
          };
        })
      )
    ).filter(Boolean);

    res.json({ teamId, seasonYear, players });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Diagnóstico para la Fase 3b: forma real del registro por juego ----
app.get("/api/nba/debug/gamelog/:id", async (req, res) => {
  try {
    const year = req.query.season || "";
    const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${req.params.id}/gamelog${year ? `?season=${year}` : ""}`;
    const d = await fetch(url).then((r) => r.json());
    const firstCat = d.seasonTypes?.[0]?.categories?.[0];
    res.json({
      topKeys: Object.keys(d),
      labels: d.labels,
      seasonTypes: (d.seasonTypes || []).map((s) => ({ name: s.displayName, categories: (s.categories || []).length })),
      firstCategoryKeys: firstCat ? Object.keys(firstCat) : null,
      firstEventSample: firstCat?.events?.[0] || null,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Fase 3b: registro REAL juego por juego (temporada regular) ----
// Estructura verificada en vivo: seasonTypes[] (displayName con "Regular
// Season") -> categories[] (uno por mes) -> events[{eventId, stats[]}], con
// las columnas descritas por el arreglo "labels" (MIN, REB, AST, PTS, ...).
// Se cuentan solo juegos donde jugó (MIN > 0).
async function getNbaGameValues(athleteId, season) {
  try {
    const d = await cachedFetch(
      `nba-gamelog-${athleteId}-${season}`,
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/gamelog?season=${season}`,
      6 * 60 * 60 * 1000
    );
    const labels = d.labels || [];
    const iMin = labels.indexOf("MIN"), iReb = labels.indexOf("REB"), iAst = labels.indexOf("AST"), iPts = labels.indexOf("PTS");
    if ([iMin, iReb, iAst, iPts].some((i) => i < 0)) return null;
    const seen = new Set();
    const out = { pts: [], reb: [], ast: [] };
    for (const st of d.seasonTypes || []) {
      if (!/regular season/i.test(st.displayName || "")) continue;
      for (const cat of st.categories || []) {
        for (const ev of cat.events || []) {
          if (seen.has(ev.eventId)) continue;
          seen.add(ev.eventId);
          const num = (i) => { const n = Number(ev.stats?.[i]); return Number.isFinite(n) ? n : null; };
          const min = num(iMin), reb = num(iReb), ast = num(iAst), pts = num(iPts);
          if (!min || min <= 0 || reb == null || ast == null || pts == null) continue; // no jugó
          out.pts.push(pts); out.reb.push(reb); out.ast.push(ast);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ---- GET /api/nba/player/:id/game-values?season=YYYY ----
app.get("/api/nba/player/:id/game-values", async (req, res) => {
  try {
    const season = req.query.season;
    if (!season) return res.status(400).json({ error: "Se requiere season" });
    const v = await getNbaGameValues(req.params.id, season);
    if (!v) return res.json({ games: 0, values: null });
    res.json({ games: v.pts.length, values: v });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Backtesting de picks de jugadores NBA ----
app.post("/api/nba/picks/save", async (req, res) => {
  const picks = req.body?.picks;
  if (!Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: "Se esperaba un arreglo 'picks'" });
  }
  try {
    const dateTypeKeys = new Set(picks.map((p) => `${p.pick_date}|${p.pick_type}`));
    for (const key of dateTypeKeys) {
      const [pick_date, pick_type] = key.split("|");
      await fetch(
        `${SUPABASE_URL}/rest/v1/nba_daily_picks?pick_date=eq.${pick_date}&pick_type=eq.${pick_type}&checked_at=is.null`,
        { method: "DELETE", headers: supabaseHeaders }
      ).catch(() => {});
    }
    let saved = 0;
    for (const p of picks) {
      const { pick_date, pick_type, player_id, player_name, team_code, predicted_prob } = p;
      if (!pick_date || !["team", "dd", "td", "pts", "reb", "ast"].includes(pick_type) || !team_code || predicted_prob == null) continue;
      const row = { pick_date, pick_type, player_id: player_id || null, player_name: player_name || team_code, team_code, predicted_prob };
      if (p.threshold != null) row.threshold = Number(p.threshold); // solo si existe, para no romper si la columna aún no se creó
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/nba_daily_picks`, {
        method: "POST",
        headers: { ...supabaseHeaders, Prefer: "return=representation" },
        body: JSON.stringify([row]),
      });
      if (insertRes.ok) saved++;
      else console.error(`[nba/picks/save] Supabase insert error ${insertRes.status}:`, await insertRes.text().catch(() => "(sin cuerpo)"));
    }
    res.json({ saved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/nba/picks/check", async (req, res) => {
  try {
    const pendingRaw = await fetch(`${SUPABASE_URL}/rest/v1/nba_daily_picks?checked_at=is.null&pick_date=lt.${todayET()}&select=*`, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(pendingRaw)) {
      console.error("[nba/picks/check] Respuesta inesperada de Supabase (¿falta la tabla nba_daily_picks?):", JSON.stringify(pendingRaw).slice(0, 300));
      return res.json({ checked: 0, updated: 0 });
    }
    const results = await Promise.all(
      pendingRaw.map(async (pick) => {
        try {
          const day = await cachedFetch(`nba-scoreboard-${pick.pick_date}`, `${ESPN_NBA_SITE}/scoreboard?dates=${espnDateParam(pick.pick_date)}`, 15 * 60 * 1000);
          const match = (day.events || []).map(mapNbaEvent).find((g) => g.completed && (g.homeCode === pick.team_code || g.awayCode === pick.team_code));
          if (!match) return false;

          let success = null;
          let voided = false;
          if (pick.pick_type === "team") {
            const isHome = match.homeCode === pick.team_code;
            success = isHome ? match.homeWinner : match.awayWinner;
          } else if (["dd", "td", "pts", "reb", "ast"].includes(pick.pick_type) && pick.player_id) {
            const sum = await cachedFetch(`nba-summary-${match.id}`, `${ESPN_NBA_SITE}/summary?event=${match.id}`, 24 * 60 * 60 * 1000);
            let entry = null, keys = null;
            for (const t of sum.boxscore?.players || []) {
              const block = t.statistics?.[0];
              const found = (block?.athletes || []).find((x) => String(x.athlete?.id) === String(pick.player_id));
              if (found) { entry = found; keys = block.keys; break; }
            }
            if (!entry || !keys) return false; // sin boxscore todavía: se revisa en otra ronda
            if (entry.didNotPlay || !entry.stats || entry.stats.length === 0) {
              voided = true; // no jugó: no cuenta ni a favor ni en contra
            } else {
              const val = (k) => { const i = keys.indexOf(k); const n = i >= 0 ? Number(entry.stats[i]) : 0; return Number.isFinite(n) ? n : 0; };
              if (pick.pick_type === "dd" || pick.pick_type === "td") {
                const cats = ["points", "rebounds", "assists", "steals", "blocks"].filter((k) => val(k) >= 10).length;
                success = pick.pick_type === "dd" ? cats >= 2 : cats >= 3;
              } else {
                if (pick.threshold == null) return false; // sin umbral guardado no se puede revisar
                const key = pick.pick_type === "pts" ? "points" : pick.pick_type === "reb" ? "rebounds" : "assists";
                success = val(key) >= Number(pick.threshold);
              }
            }
          }
          if (success == null && !voided) return false;
          await fetch(`${SUPABASE_URL}/rest/v1/nba_daily_picks?id=eq.${pick.id}`, {
            method: "PATCH",
            headers: supabaseHeaders,
            body: JSON.stringify({ actual_success: voided ? null : success, checked_at: new Date().toISOString() }),
          });
          return true;
        } catch {
          return false;
        }
      })
    );
    res.json({ checked: pendingRaw.length, updated: results.filter(Boolean).length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/nba/picks/accuracy", async (req, res) => {
  try {
    const rows = await fetch(`${SUPABASE_URL}/rest/v1/nba_daily_picks?checked_at=not.is.null${req.query.since ? `&pick_date=gte.${req.query.since}` : ""}&select=*&order=pick_date.desc`, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(rows)) {
      const empty = { accuracy: null, total: 0 };
      return res.json({ teams: empty, dd: empty, td: empty, pts: empty, reb: empty, ast: empty, recent: [] });
    }
    const counted = rows.filter((r) => r.actual_success !== null && r.actual_success !== undefined); // sin los que no jugaron
    const summarize = (type) => {
      const f = counted.filter((r) => r.pick_type === type);
      if (f.length === 0) return { accuracy: null, total: 0 };
      return { accuracy: f.filter((r) => r.actual_success === true).length / f.length, avgPredicted: f.reduce((x, r) => x + (r.predicted_prob || 0), 0) / f.length, total: f.length };
    };
    res.json({
      teams: summarize("team"), dd: summarize("dd"), td: summarize("td"), pts: summarize("pts"), reb: summarize("reb"), ast: summarize("ast"),
      voided: rows.length - counted.length,
      recent: counted.slice(0, 20).map((r) => ({ date: r.pick_date, type: r.pick_type, name: r.player_name, team: r.team_code, prob: r.predicted_prob, threshold: r.threshold ?? null, success: r.actual_success })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- Ventaja de casa MEDIDA de la liga (MLB y NFL) ----
// Antes se usaban constantes fijas (MLB 0.024, NFL 0.032). Ahora se mide de
// los récords oficiales de casa de todos los equipos, igual que en NHL/NBA:
// % de victorias de local = victorias de local ÷ juegos de local de la liga.
// ==========================================================================

// MLB: standings oficiales de la MLB, splitRecords tipo "home" (verificado en
// vivo: 30 equipos, 2026 completo = 1,284 victorias y 1,145 derrotas de local).
app.get("/api/mlb/league-home", async (req, res) => {
  try {
    const sumYear = async (year) => {
      const data = await cachedFetch(`mlb-league-home-${year}`, `${MLB_API}/standings?leagueId=103,104&season=${year}`, 6 * 60 * 60 * 1000);
      let w = 0, l = 0;
      for (const rec of data.records || []) {
        for (const t of rec.teamRecords || []) {
          const home = (t.records?.splitRecords || []).find((x) => x.type === "home");
          if (home) { w += home.wins || 0; l += home.losses || 0; }
        }
      }
      return { w, l };
    };
    const year = Number(todayET().slice(0, 4));
    let { w, l } = await sumYear(year);
    let source = "temporada actual";
    if (w + l < 1000) { // inicio de temporada: muestra muy chica
      const prev = await sumYear(year - 1);
      if (prev.w + prev.l >= 1000) { w = prev.w; l = prev.l; source = "temporada anterior completa"; }
    }
    res.json({ homeWinPct: w + l > 0 ? w / (w + l) : null, games: w + l, source });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// NFL: ESPN standings, stat tipo "home" con summary "W-L" o "W-L-T" (verificado
// en vivo con la temporada 2025). Se suman las últimas 3 temporadas (la actual,
// aunque vaya incompleta, y las 2 anteriores) para tener muestra suficiente
// (una sola temporada son solo 272 juegos, ruido de ±3%). Los empates cuentan
// medio triunfo.
app.get("/api/nfl/league-home", async (req, res) => {
  try {
    const today = todayET();
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const seasonNow = m >= 8 ? y : y - 1;
    let w = 0, games = 0, used = [];
    for (const season of [seasonNow, seasonNow - 1, seasonNow - 2]) {
      try {
        const data = await cachedFetch(`nfl-league-home-${season}`, `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${season}`, 6 * 60 * 60 * 1000);
        let sw = 0, sg = 0;
        for (const conf of data.children || []) {
          for (const entry of conf.standings?.entries || []) {
            const home = (entry.stats || []).find((s) => s.type === "home");
            const m2 = /^(\d+)-(\d+)(?:-(\d+))?/.exec(home?.summary || home?.displayValue || "");
            if (!m2) continue;
            const hw = Number(m2[1]), hl = Number(m2[2]), ht = Number(m2[3] || 0);
            sw += hw + ht * 0.5;
            sg += hw + hl + ht;
          }
        }
        if (sg > 0) { w += sw; games += sg; used.push(season); }
      } catch { /* se salta esa temporada */ }
    }
    res.json({ homeWinPct: games > 0 ? w / games : null, games, seasons: used });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- MLB: historial REAL de un abridor contra un equipo (varias temporadas) ----
// Fuente verificada en vivo: MLB Stats API, people/{id}/stats?stats=gameLog&
// group=pitching&season=YYYY -> por juego: oponente, isHome, gamesStarted,
// wins, losses (la decisión DEL PITCHER, no el marcador del equipo),
// inningsPitched (string "7.2" = 7 2/3), earnedRuns, strikeOuts.
// ATENCIÓN: el campo "era" de cada juego es el ERA ACUMULADO de la
// temporada hasta ese día, NO el de ese juego; por eso el ERA se calcula
// aquí con carreras limpias e innings.
// ==========================================================================
function mlbInningsToNumber(ip) {
  const s = String(ip ?? "0");
  const [whole, frac] = s.split(".");
  return Number(whole || 0) + Number(frac || 0) / 3;
}

app.get("/api/pitcher/:id/vs-team/:oppCode", async (req, res) => {
  const oppId = TEAM_IDS[String(req.params.oppCode).toUpperCase()];
  if (!oppId) return res.status(404).json({ error: "Código de equipo no reconocido" });
  const pitcherId = req.params.id;
  const nSeasons = Math.min(8, Math.max(1, Number(req.query.seasons) || 5));
  try {
    const thisYear = Number(todayET().slice(0, 4));
    const years = Array.from({ length: nSeasons }, (_, i) => thisYear - i);
    const logs = await Promise.all(
      years.map((y) =>
        cachedFetch(`pitcher-gamelog-${pitcherId}-${y}`, `${MLB_API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${y}`, 6 * 60 * 60 * 1000)
          .catch(() => null)
      )
    );
    const blank = () => ({ starts: 0, wins: 0, losses: 0, ip: 0, er: 0, k: 0 });
    const all = blank(), vs = blank(), vsHome = blank(), vsRoad = blank();
    const seasonsWithData = [];
    logs.forEach((d, i) => {
      const splits = d?.stats?.[0]?.splits || [];
      let any = false;
      for (const sp of splits) {
        const st = sp.stat || {};
        if (Number(st.gamesStarted) !== 1) continue; // solo aperturas, no relevos
        any = true;
        const add = (t) => {
          t.starts++; t.wins += Number(st.wins) || 0; t.losses += Number(st.losses) || 0;
          t.ip += mlbInningsToNumber(st.inningsPitched); t.er += Number(st.earnedRuns) || 0; t.k += Number(st.strikeOuts) || 0;
        };
        add(all);
        if (sp.opponent?.id === oppId) {
          add(vs);
          add(sp.isHome ? vsHome : vsRoad);
        }
      }
      if (any) seasonsWithData.push(years[i]);
    });
    const era = (t) => (t.ip > 0 ? (t.er * 9) / t.ip : null);
    const pack = (t) => ({ starts: t.starts, wins: t.wins, losses: t.losses, noDecision: t.starts - t.wins - t.losses, ip: Math.round(t.ip * 10) / 10, er: t.er, k: t.k, era: era(t) });
    res.json({
      pitcherId, opponent: String(req.params.oppCode).toUpperCase(), seasons: seasonsWithData,
      overall: pack(all), vsTeam: pack(vs), vsTeamAtHome: pack(vsHome), vsTeamOnRoad: pack(vsRoad),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ==========================================================================
// ---- NHL: historial REAL de un portero contra un equipo (varias temporadas) ----
// Fuente verificada en vivo: NHL API web, player/{id}/game-log/{YYYYYYYY}/2
// (temporada regular) -> por juego: opponentAbbrev, homeRoadFlag (H/R),
// gamesStarted, decision (W/L/O), shotsAgainst, goalsAgainst, toi "MM:SS".
// SV% y GAA se calculan aquí sumando tiros y goles (no promediando
// porcentajes por juego).
// ==========================================================================
app.get("/api/nhl/goalie/:id/vs-team/:oppCode", async (req, res) => {
  const goalieId = String(req.params.id).replace(/\D/g, "");
  const opp = String(req.params.oppCode).toUpperCase();
  if (!goalieId) return res.status(400).json({ error: "ID de portero inválido" });
  const nSeasons = Math.min(8, Math.max(1, Number(req.query.seasons) || 5));
  try {
    const standingsData = await cachedFetch("nhl-standings", `${NHL_API}/standings/now`, 60 * 60 * 1000);
    const curId = standingsData.standings?.[0]?.seasonId;
    if (!curId) return res.status(502).json({ error: "No se pudo determinar la temporada real de referencia" });
    const startYear = Number(String(curId).slice(0, 4));
    const seasonIds = Array.from({ length: nSeasons }, (_, i) => `${startYear - i}${startYear - i + 1}`);
    const logs = await Promise.all(
      seasonIds.map((sid) =>
        cachedFetch(`nhl-goalie-gamelog-${goalieId}-${sid}`, `${NHL_API}/player/${goalieId}/game-log/${sid}/2`, 6 * 60 * 60 * 1000).catch(() => null)
      )
    );
    const blank = () => ({ starts: 0, wins: 0, losses: 0, otl: 0, sa: 0, ga: 0, min: 0 });
    const all = blank(), vs = blank(), vsHome = blank(), vsRoad = blank();
    const seasonsWithData = [];
    logs.forEach((d, i) => {
      let any = false;
      for (const g of d?.gameLog || []) {
        if (Number(g.gamesStarted) !== 1) continue; // solo aperturas, no relevos
        any = true;
        const [mm, ss] = String(g.toi || "0:0").split(":");
        const minutes = Number(mm || 0) + Number(ss || 0) / 60;
        const add = (t) => {
          t.starts++;
          if (g.decision === "W") t.wins++; else if (g.decision === "L") t.losses++; else if (g.decision === "O") t.otl++;
          t.sa += Number(g.shotsAgainst) || 0; t.ga += Number(g.goalsAgainst) || 0; t.min += minutes;
        };
        add(all);
        if (String(g.opponentAbbrev).toUpperCase() === opp) {
          add(vs);
          add(g.homeRoadFlag === "H" ? vsHome : vsRoad);
        }
      }
      if (any) seasonsWithData.push(seasonIds[i]);
    });
    const pack = (t) => ({
      starts: t.starts, wins: t.wins, losses: t.losses, otLosses: t.otl,
      noDecision: t.starts - t.wins - t.losses - t.otl,
      shotsAgainst: t.sa, goalsAgainst: t.ga,
      savePct: t.sa > 0 ? 1 - t.ga / t.sa : null,
      gaa: t.min > 0 ? (t.ga * 60) / t.min : null,
    });
    res.json({
      goalieId, opponent: opp, seasons: seasonsWithData,
      overall: pack(all), vsTeam: pack(vs), vsTeamAtHome: pack(vsHome), vsTeamOnRoad: pack(vsRoad),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
