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

async function cachedFetch(key, url) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API error ${res.status} en ${url}`);
  const data = await res.json();
  cache.set(key, { data, time: Date.now() });
  return data;
}

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
// Bateadores reales de un equipo con sus stats actuales de temporada.
app.get("/api/team/:code/hitters", async (req, res) => {
  const teamId = TEAM_IDS[req.params.code.toUpperCase()];
  if (!teamId) return res.status(404).json({ error: "Código de equipo no reconocido" });

  try {
    const data = await cachedFetch(
      `hitters-${teamId}`,
      `${MLB_API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting))`
    );
    const hitters = data.roster
      .filter((p) => p.position.abbreviation !== "P")
      .map((p) => {
        const s = p.person.stats?.[0]?.splits?.[0]?.stat || {};
        return {
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
    const pitcherInfo = (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null };
      const s = p.stats?.find((st) => st.group?.displayName === "pitching")?.splits?.[0]?.stat;
      return {
        name: p.fullName,
        hand: p.pitchHand?.code || null,
        era: s?.era != null ? parseFloat(s.era) : null,
      };
    };
    const games = (data.dates?.[0]?.games || []).map((g) => ({
      home: g.teams.home.team.name,
      away: g.teams.away.team.name,
      venue: g.venue?.name,
      time: g.gameDate,
      homePitcher: pitcherInfo(g.teams.home.probablePitcher).name,
      homePitcherHand: pitcherInfo(g.teams.home.probablePitcher).hand,
      homePitcherEra: pitcherInfo(g.teams.home.probablePitcher).era,
      awayPitcher: pitcherInfo(g.teams.away.probablePitcher).name,
      awayPitcherHand: pitcherInfo(g.teams.away.probablePitcher).hand,
      awayPitcherEra: pitcherInfo(g.teams.away.probablePitcher).era,
    }));
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
    const pitcherInfo = (p) => {
      if (!p) return { name: "Por confirmar", hand: null, era: null };
      const s = p.stats?.find((st) => st.group?.displayName === "pitching")?.splits?.[0]?.stat;
      return {
        name: p.fullName,
        hand: p.pitchHand?.code || null,
        era: s?.era != null ? parseFloat(s.era) : null,
      };
    };
    const games = (data.dates?.[0]?.games || []).map((g) => ({
      gamePk: g.gamePk,
      home: g.teams.home.team.name,
      homeCode: TEAM_ID_TO_CODE[g.teams.home.team.id] || null,
      away: g.teams.away.team.name,
      awayCode: TEAM_ID_TO_CODE[g.teams.away.team.id] || null,
      venue: g.venue?.name,
      time: g.gameDate,
      status: g.status?.detailedState || null,
      homePitcher: pitcherInfo(g.teams.home.probablePitcher),
      awayPitcher: pitcherInfo(g.teams.away.probablePitcher),
    }));
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
