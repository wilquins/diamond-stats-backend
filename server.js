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
          rbi: s.rbi,
          avg: s.avg != null ? parseFloat(s.avg) : null,
          obp: s.obp != null ? parseFloat(s.obp) : null,
          slg: s.slg != null ? parseFloat(s.slg) : null,
          ops: s.ops != null ? parseFloat(s.ops) : null,
        };
      })
      .filter((p) => p.ab > 0 && p.avg != null && !Number.isNaN(p.avg));

    // Trae el split real de cada bateador en paralelo (uno por jugador).
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
    const data = await cachedFetch(
      `situational-${teamId}-${season}`,
      `${MLB_API}/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R&hydrate=team`,
      60 * 60 * 1000 // 1 hora — el calendario/resultados no cambian a cada rato
    );

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

    res.json({ updated: new Date().toISOString(), season, dayRecord, nightRecord, byWeekday, last10Record, currentStreak, homeRecord, awayRecord });
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
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
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
    let saved = 0;
    for (const p of picks) {
      const { pick_date, pick_type, player_id, player_name, team_code, predicted_prob } = p;
      if (!pick_date || !pick_type || !player_name || !team_code || predicted_prob == null) continue;

      const checkUrl = `${SUPABASE_URL}/rest/v1/daily_picks?pick_date=eq.${pick_date}&pick_type=eq.${pick_type}&player_name=eq.${encodeURIComponent(player_name)}&select=id`;
      const existing = await fetch(checkUrl, { headers: supabaseHeaders }).then((r) => r.json());
      if (Array.isArray(existing) && existing.length > 0) continue;

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
    const url = `${SUPABASE_URL}/rest/v1/daily_picks?checked_at=not.is.null&select=*&order=pick_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
    if (!Array.isArray(rows)) throw new Error("Respuesta inesperada de Supabase");

    const summarize = (type) => {
      const filtered = rows.filter((r) => r.pick_type === type);
      if (filtered.length === 0) return { total: 0, accuracy: null };
      const successes = filtered.filter((r) => r.actual_success === true).length;
      return { total: filtered.length, accuracy: successes / filtered.length };
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
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
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
const ESPN_NFL_STANDINGS = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings";

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
    const url = `${SUPABASE_URL}/rest/v1/nfl_overunder_predictions?checked_at=not.is.null&select=*&order=game_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
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
    const data = await cachedFetch(
      `nfl-schedule-${teamId}-${season}`,
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/schedule?season=${season}`,
      60 * 60 * 1000
    );
    const homeRecord = { w: 0, l: 0 };
    const awayRecord = { w: 0, l: 0 };
    for (const e of data.events || []) {
      const comp = e.competitions?.[0];
      if (!comp?.status?.type?.completed || new Date(e.date) < REGULAR_SEASON_START) continue;
      const self = comp.competitors?.find((c) => c.id === teamId);
      if (!self || self.winner == null) continue;
      const bucket = self.winner ? "w" : "l";
      (self.homeAway === "home" ? homeRecord : awayRecord)[bucket]++;
    }
    res.json({ homeRecord, awayRecord });
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
