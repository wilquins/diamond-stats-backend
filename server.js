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
async function fetchWeatherNWS(lat, lon, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.time < WEATHER_CACHE_TTL_MS) return hit.data;

  const headers = { "User-Agent": "DiamondStatsApp (proyecto personal de estadisticas MLB)" };
  const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
  const pointsRes = await fetch(pointsUrl, { headers });
  if (!pointsRes.ok) throw new Error(`Error ${pointsRes.status} consultando ${pointsUrl}`);
  const points = await pointsRes.json();
  const hourlyUrl = points.properties.forecastHourly;

  const forecastRes = await fetch(hourlyUrl, { headers });
  if (!forecastRes.ok) throw new Error(`Error ${forecastRes.status} consultando ${hourlyUrl}`);
  const forecast = await forecastRes.json();
  const now = forecast.properties.periods[0];

  const windMph = parseFloat(now.windSpeed) || 0; // viene como texto "10 mph"
  const data = {
    tempF: now.temperature,
    humidity: now.relativeHumidity?.value ?? null,
    windMph,
    windDir: now.windDirection,
    windDirDeg: compassToDeg(now.windDirection),
    pop: now.probabilityOfPrecipitation?.value ?? 0,
    description: now.shortForecast,
    icon: iconForForecast(now.shortForecast),
  };
  cache.set(cacheKey, { data, time: Date.now() });
  return data;
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
      `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(stats(type=season,group=pitching))`
    );
    const pitcherInfo = async (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null };
      const s = p.stats?.find((st) => st.group?.displayName === "pitching")?.splits?.[0]?.stat;
      const hand = p.pitchHand?.code || (p.id ? await fetchPitcherHand(p.id) : null);
      return {
        name: p.fullName,
        hand,
        era: s?.era != null ? parseFloat(s.era) : null,
      };
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
          homePitcher: home.name, homePitcherHand: home.hand, homePitcherEra: home.era,
          awayPitcher: away.name, awayPitcherHand: away.hand, awayPitcherEra: away.era,
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
      `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(stats(type=season,group=pitching))`
    );
    const pitcherInfo = async (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null };
      const s = p.stats?.find((st) => st.group?.displayName === "pitching")?.splits?.[0]?.stat;
      const hand = p.pitchHand?.code || (p.id ? await fetchPitcherHand(p.id) : null);
      return {
        name: p.fullName,
        hand,
        era: s?.era != null ? parseFloat(s.era) : null,
      };
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

  try {
    let data;
    if (code === "TOR") {
      // Único equipo fuera de EE.UU. — el NWS no cubre Canadá, usa Open-Meteo.
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph`;
      const raw = await cachedFetch(`weather-${code}`, url, WEATHER_CACHE_TTL_MS);
      const c = raw.current;
      const w = describeWeatherCode(c.weather_code);
      data = {
        tempF: c.temperature_2m, humidity: c.relative_humidity_2m, windMph: c.wind_speed_10m,
        windDir: windDirectionLabel(c.wind_direction_10m), windDirDeg: c.wind_direction_10m,
        pop: c.precipitation_probability, description: w.desc, icon: w.icon,
      };
    } else {
      data = await fetchWeatherNWS(coords.lat, coords.lon, `weather-${code}`);
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

    res.json({ updated: new Date().toISOString(), season, dayRecord, nightRecord, byWeekday, last10Record });
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
        return {
          g: s.gamesPlayed || 0, gs: s.gamesStarted || 0,
          era: s.era != null ? parseFloat(s.era) : null,
          whip: s.whip != null ? parseFloat(s.whip) : null,
          ip: s.inningsPitched != null ? parseFloat(s.inningsPitched) : 0,
        };
      })
      // Relevista = casi nunca abre juegos (permite alguna apertura de emergencia)
      .filter((p) => p.g > 0 && p.gs / p.g < 0.3 && p.ip > 0 && p.era != null && p.whip != null);

    const totalIP = relievers.reduce((sum, p) => sum + p.ip, 0);
    const bullpenERA = totalIP > 0 ? relievers.reduce((sum, p) => sum + p.era * p.ip, 0) / totalIP : null;
    const bullpenWHIP = totalIP > 0 ? relievers.reduce((sum, p) => sum + p.whip * p.ip, 0) / totalIP : null;

    res.json({
      updated: new Date().toISOString(),
      relieverCount: relievers.length,
      totalIP: Math.round(totalIP * 10) / 10,
      bullpenERA: bullpenERA != null ? Math.round(bullpenERA * 100) / 100 : null,
      bullpenWHIP: bullpenWHIP != null ? Math.round(bullpenWHIP * 100) / 100 : null,
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
    let updated = 0;

    for (const pred of pending) {
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
      if (!match) continue; // el juego todavía no terminó, o no se encontró — se revisa después

      const winner = match.teams.home.isWinner ? pred.home_code : pred.away_code;
      await fetch(`${SUPABASE_URL}/rest/v1/predictions?id=eq.${pred.id}`, {
        method: "PATCH",
        headers: supabaseHeaders,
        body: JSON.stringify({ actual_winner: winner, checked_at: new Date().toISOString() }),
      });
      updated++;
    }
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
    const url = `${SUPABASE_URL}/rest/v1/predictions?checked_at=not.is.null&select=*&order=game_date.desc`;
    const rows = await fetch(url, { headers: supabaseHeaders }).then((r) => r.json());
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
    let streak = 0;
    for (let i = splits.length - 1; i >= 0; i--) {
      const hits = splits[i].stat?.hits ?? 0;
      const ab = splits[i].stat?.atBats ?? 0;
      if (ab === 0) continue; // no jugó ese día (ej. relevo/descanso), no rompe la racha
      if (hits > 0) streak++;
      else break;
    }
    res.json({ streak });
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
    }

    res.json({
      updated: new Date().toISOString(), season, gamesPlayed: games.length, ...record,
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
    let updated = 0;

    for (const pick of pending) {
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

      if (success == null) continue; // aún no hay resultado real, se deja pendiente
      await fetch(`${SUPABASE_URL}/rest/v1/daily_picks?id=eq.${pick.id}`, {
        method: "PATCH",
        headers: supabaseHeaders,
        body: JSON.stringify({ actual_success: success, checked_at: new Date().toISOString() }),
      });
      updated++;
    }
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

// ---- TEMPORAL: GET /api/debug/raw-schedule ----
// Solo para diagnosticar por qué el ERA de los abridores probables sale
// null — muestra la respuesta CRUDA de la MLB API, sin que nuestro
// código la procese. Se puede borrar una vez resuelto.
app.get("/api/debug/raw-schedule", async (req, res) => {
  const date = req.query.date || todayET();
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(stats(type=season,group=pitching))`;
  const r = await fetch(url);
  const text = await r.text();
  res.status(r.status).type("application/json").send(text);
});
