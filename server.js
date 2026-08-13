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

const MLB_API = "https://statsapi.mlb.com/api/v1";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const cache = new Map();

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
  const date = req.query.date || new Date().toISOString().slice(0, 10);
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
  const date = req.query.date || new Date().toISOString().slice(0, 10);
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

    res.json({ updated: new Date().toISOString(), season, dayRecord, nightRecord, byWeekday });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
