#!/usr/bin/env node
// Builds data/trails.geojson from OpenStreetMap (Overpass API).
// Optional elevation from Open Topo Data (SRTM 30m).
//
// Usage:
//   node scripts/build-data.mjs                 # fetch from Overpass
//   node scripts/build-data.mjs --input raw.json  # use a saved Overpass response
//   node scripts/build-data.mjs --no-elevation  # skip elevation lookups
//
// Data © OpenStreetMap contributors, ODbL 1.0.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/trails.geojson");
const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const INPUT = inputIdx >= 0 ? args[inputIdx + 1] : null;
const ELEVATION = !args.includes("--no-elevation");

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Whole island of Cyprus (both sides), as a bounding box.
const BBOX = "34.50,32.20,35.75,34.65";

// 1) All hiking / foot route relations (nature trails, E4, local networks).
// 2) Named paths that look like trails but are not part of any route relation.
const QUERY = `
[out:json][timeout:240];
(
  relation["route"~"^(hiking|foot)$"](${BBOX});
)->.routes;
way(r.routes)->.routeWays;
(
  way["highway"~"^(path|footway|track)$"]["name"~"[Tt]rail|[Mm]onopati|Μονοπάτι|μονοπάτι|Patika|Patikası"](${BBOX});
  - .routeWays;
)->.namedWays;
(.routes; .namedWays;);
out geom;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass() {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Querying ${url} (attempt ${attempt})...`);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "cykes-trail-builder/1.0 (+https://github.com)",
          },
          body: "data=" + encodeURIComponent(QUERY),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements?.length) throw new Error("empty response");
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`  failed: ${e.message}`);
        await sleep(5000 * attempt);
      }
    }
  }
  throw lastErr;
}

// ---------- geometry helpers ----------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function dist([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const lineLength = (line) => line.reduce((s, p, i) => (i ? s + dist(line[i - 1], p) : 0), 0);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;

// Join way segments end-to-end into as few lines as possible.
function stitch(segments) {
  const pool = segments.filter((s) => s.length > 1).map((s) => s.slice());
  const lines = [];
  while (pool.length) {
    let line = pool.shift();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const head = line[0];
        const tail = line[line.length - 1];
        if (same(tail, s[0])) line = line.concat(s.slice(1));
        else if (same(tail, s[s.length - 1])) line = line.concat(s.slice(0, -1).reverse());
        else if (same(head, s[s.length - 1])) line = s.slice(0, -1).concat(line);
        else if (same(head, s[0])) line = s.slice(1).reverse().concat(line);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    lines.push(line);
  }
  return lines.sort((a, b) => lineLength(b) - lineLength(a));
}

// Douglas-Peucker simplification (tolerance in degrees, ~5 m).
function simplify(points, tol = 0.00005) {
  if (points.length < 3) return points;
  const sq = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [x1, y1] = points[a], [x2, y2] = points[b];
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      let t = len ? ((x - x1) * dx + (y - y1) * dy) / len : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx - x, ey = y1 + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d > max) { max = d; idx = i; }
    }
    if (max > sq) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Points every `step` metres along a line (for elevation sampling).
function sampleAlong(line, n) {
  const total = lineLength(line);
  if (total === 0) return [line[0]];
  const step = total / (n - 1);
  const out = [line[0]];
  let acc = 0, next = step;
  for (let i = 1; i < line.length && out.length < n - 1; i++) {
    const seg = dist(line[i - 1], line[i]);
    while (acc + seg >= next && out.length < n - 1) {
      const t = seg ? (next - acc) / seg : 0;
      out.push([
        line[i - 1][0] + t * (line[i][0] - line[i - 1][0]),
        line[i - 1][1] + t * (line[i][1] - line[i - 1][1]),
      ]);
      next += step;
    }
    acc += seg;
  }
  out.push(line[line.length - 1]);
  return out;
}

// ---------- classification ----------
// Rough regions of Cyprus, checked in order.
function regionFor([lon, lat]) {
  const d = (a, b) => dist([lon, lat], [b, a]) / 1000;
  if (lon < 32.42 && lat > 34.96) return "Akamas";
  if (d(34.936, 32.863) < 24) return "Troodos";
  if (lat > 35.24 && lon > 32.9) return "Kyrenia range";
  if (lon > 33.85) return "Famagusta & Cape Greco";
  const centres = [
    ["Paphos", 34.82, 32.5],
    ["Limassol", 34.74, 33.05],
    ["Larnaca", 34.88, 33.55],
    ["Nicosia", 35.12, 33.3],
    ["Troodos", 34.94, 32.86],
  ];
  let best = centres[0][0], bd = Infinity;
  for (const [name, la, lo] of centres) {
    const x = d(la, lo);
    if (x < bd) { bd = x; best = name; }
  }
  return best;
}

const SAC = {
  hiking: "easy",
  mountain_hiking: "moderate",
  demanding_mountain_hiking: "hard",
  alpine_hiking: "hard",
  demanding_alpine_hiking: "hard",
  difficult_alpine_hiking: "hard",
};

function difficultyFor(tags, km, ascent) {
  const explicit = (tags.difficulty || tags["trail_difficulty"] || "").toLowerCase();
  if (/easy|εύκολ|^1$/.test(explicit)) return { level: "easy", source: "osm" };
  if (/moderate|medium|μέτρ|^2$/.test(explicit)) return { level: "moderate", source: "osm" };
  if (/hard|difficult|δύσκ|^3$/.test(explicit)) return { level: "hard", source: "osm" };
  if (SAC[tags.sac_scale]) return { level: SAC[tags.sac_scale], source: "osm" };
  // Estimate: a mix of distance and climbing.
  const effort = km + (ascent ?? 0) / 100;
  if (km > 40) return { level: "hard", source: "estimate" };
  if (effort < 6) return { level: "easy", source: "estimate" };
  if (effort < 15) return { level: "moderate", source: "estimate" };
  return { level: "hard", source: "estimate" };
}

function nameFor(tags, type, id) {
  return (
    tags["name:en"] || tags.name || tags.ref ||
    (tags.from && tags.to ? `${tags.from} - ${tags.to}` : null) ||
    `Unnamed ${type === "relation" ? "route" : "path"} ${id}`
  );
}

// ---------- elevation ----------
async function lookupElevations(points) {
  // Open Topo Data: max 100 points per call, 1 call per second.
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const locs = chunk.map(([lo, la]) => `${round(la, 5)},${round(lo, 5)}`).join("|");
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs}`);
        if (res.status === 429) { await sleep(3000 * attempt); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        json.results.forEach((r, j) => { out[i + j] = r.elevation; });
        ok = true;
      } catch (e) {
        console.warn(`  elevation chunk failed: ${e.message}`);
        await sleep(2000 * attempt);
      }
    }
    if (!ok) throw new Error("elevation service unavailable");
    await sleep(1100);
  }
  return out;
}

function elevationStats(profile) {
  const valid = profile.filter((e) => e != null);
  if (valid.length < 2) return null;
  // Light smoothing removes SRTM noise before summing climbs.
  const sm = valid.map((_, i) => {
    const w = valid.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  let up = 0, down = 0;
  for (let i = 1; i < sm.length; i++) {
    const d = sm[i] - sm[i - 1];
    if (d > 0) up += d; else down -= d;
  }
  return {
    ascent: Math.round(up),
    descent: Math.round(down),
    minEle: Math.round(Math.min(...valid)),
    maxEle: Math.round(Math.max(...valid)),
  };
}

// ---------- main ----------
async function main() {
  const raw = INPUT ? JSON.parse(await readFile(INPUT, "utf8")) : await fetchOverpass();
  console.log(`Got ${raw.elements.length} OSM elements`);

  const trails = [];
  for (const el of raw.elements) {
    const tags = el.tags || {};
    let segments = [];
    if (el.type === "relation") {
      segments = (el.members || [])
        .filter((m) => m.type === "way" && m.geometry && !/^(platform|stop)/.test(m.role || ""))
        .map((m) => m.geometry.filter(Boolean).map((p) => [p.lon, p.lat]));
    } else if (el.type === "way" && el.geometry) {
      segments = [el.geometry.map((p) => [p.lon, p.lat])];
    }
    const lines = stitch(segments).map((l) => simplify(l).map(([x, y]) => [round(x), round(y)]));
    if (!lines.length) continue;
    const lengthM = lines.reduce((s, l) => s + lineLength(l), 0);
    if (lengthM < 300) continue; // skip tiny fragments
    // Skip the island-wide long-distance relations' super-routes with no own ways.
    trails.push({ el, tags, lines, lengthM });
  }

  // Merge plain named ways that share a name (one trail split into many ways).
  const merged = [];
  const byName = new Map();
  for (const t of trails) {
    if (t.el.type === "way" && t.tags.name) {
      const key = t.tags.name.trim().toLowerCase();
      if (byName.has(key)) {
        const m = byName.get(key);
        m.lines = stitch(m.lines.concat(t.lines));
        m.lengthM += t.lengthM;
        continue;
      }
      byName.set(key, t);
    }
    merged.push(t);
  }
  console.log(`${merged.length} trails after cleanup`);

  // Elevation profiles (40 samples along the main line).
  let elevationOk = ELEVATION;
  if (ELEVATION) {
    try {
      const all = [];
      const ranges = [];
      for (const t of merged) {
        const n = Math.max(10, Math.min(60, Math.round(t.lengthM / 250)));
        const pts = sampleAlong(t.lines[0], n);
        ranges.push([all.length, pts.length]);
        all.push(...pts);
      }
      console.log(`Looking up ${all.length} elevation points...`);
      const ele = await lookupElevations(all);
      merged.forEach((t, i) => {
        const [s, n] = ranges[i];
        t.profile = ele.slice(s, s + n).map((e) => (e == null ? null : Math.round(e)));
      });
    } catch (e) {
      console.warn(`Elevation skipped: ${e.message}`);
      elevationOk = false;
    }
  }

  const features = merged.map((t) => {
    const { el, tags, lines, lengthM } = t;
    const km = lengthM / 1000;
    const stats = t.profile ? elevationStats(t.profile) : null;
    const diff = difficultyFor(tags, km, stats?.ascent);
    const start = lines[0][0];
    const end = lines[0][lines[0].length - 1];
    return {
      type: "Feature",
      id: `${el.type[0]}${el.id}`,
      properties: {
        id: `${el.type[0]}${el.id}`,
        osm: `${el.type}/${el.id}`,
        name: nameFor(tags, el.type, el.id),
        nameLocal: tags.name && tags["name:en"] && tags.name !== tags["name:en"] ? tags.name : null,
        ref: tags.ref || null,
        network: tags.network || null,
        operator: tags.operator || null,
        description: tags["description:en"] || tags.description || null,
        website: tags.website || tags.url || null,
        lengthKm: Math.round(km * 10) / 10,
        loop: dist(start, end) < 150,
        region: regionFor(start),
        difficulty: diff.level,
        difficultySource: diff.source,
        start,
        ...(stats || {}),
        profile: t.profile && stats ? t.profile : null,
      },
      geometry:
        lines.length === 1
          ? { type: "LineString", coordinates: lines[0] }
          : { type: "MultiLineString", coordinates: lines },
    };
  });

  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  const fc = {
    type: "FeatureCollection",
    generated: new Date().toISOString(),
    source: "© OpenStreetMap contributors (ODbL)",
    elevation: elevationOk ? "SRTM 30m via Open Topo Data" : null,
    features,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(fc));
  console.log(`Wrote ${features.length} trails to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
