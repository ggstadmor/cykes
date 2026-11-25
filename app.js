/* Cykes - hiking trails in Cyprus. Plain JS + Leaflet, no build step. */
{
  const COLORS = { easy: "#2f9a5a", moderate: "#e0a030", hard: "#c8402f" };
  const SELECTED = "#d9673f";
  const DIFF_LABEL = { easy: "Easy", moderate: "Moderate", hard: "Hard" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const state = { trails: [], filtered: [], diff: new Set(), selected: null, me: null };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("cykes:" + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("cykes:" + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, preferCanvas: false }).setView([34.95, 33.2], 9);
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution: 'Map: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM',
  });
  const base = { "Street map": osm, "Topographic": topo };
  (base[store.get("base")] || topo).addTo(map);
  L.control.layers(base, null, { position: "topright" }).addTo(map);
  map.on("baselayerchange", (e) => store.set("base", e.name));
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

  const trailLayer = L.layerGroup().addTo(map);
  let selectedLayer = null;
  let startMarker = null;
  let meMarker = null;

  const styleFor = (t) => ({ color: COLORS[t.properties.difficulty], weight: 4, opacity: 0.85, lineCap: "round" });

  // ---------- helpers ----------
  const km = (n) => (n < 10 ? n.toFixed(1) : Math.round(n)) + " km";
  function hikingTime(p) {
    // Walking at 4 km/h plus 1 hour per 600 m of climbing.
    const h = p.lengthKm / 4 + (p.ascent || 0) / 600;
    if (h < 1) return Math.max(15, Math.round((h * 60) / 15) * 15) + " min";
    const r = Math.round(h * 2) / 2;
    return (r % 1 ? r.toFixed(1) : r) + " h";
  }
  function haversine([lon1, lat1], [lon2, lat2]) {
    const r = (d) => (d * Math.PI) / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- data ----------
  async function load() {
    try {
      const res = await fetch("data/trails.geojson", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const fc = await res.json();
      state.trails = fc.features;
      state.generated = fc.generated;
      if (fc.generated) {
        $("#dataDate").textContent = "Trail data last updated " + new Date(fc.generated).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) + ".";
      }
    } catch (e) {
      $("#count").textContent = "Could not load trails.";
      $("#list").innerHTML = '<li class="empty">The trail data did not load. Please refresh the page.</li>';
      return;
    }
    for (const t of state.trails) {
      const p = t.properties;
      p._search = [p.name, p.nameLocal, p.ref, p.network, p.region, p.description, p.operator].filter(Boolean).join(" ").toLowerCase();
      t._layer = L.geoJSON(t, { style: () => styleFor(t) });
      t._layer.bindTooltip(esc(p.name), { sticky: true, className: "trail-tip" });
      t._layer.on("click", () => select(p.id));
      t._layer.on("mouseover", () => { if (state.selected?.properties.id !== p.id) t._layer.setStyle({ weight: 7, opacity: 1 }); });
      t._layer.on("mouseout", () => { if (state.selected?.properties.id !== p.id) t._layer.setStyle(styleFor(t)); });
    }
    const regions = [...new Set(state.trails.map((t) => t.properties.region))].sort();
    $("#region").insertAdjacentHTML("beforeend", regions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join(""));

    // Restore last filters.
    const f = store.get("filters");
    if (f) {
      $("#q").value = f.q || "";
      if (regions.includes(f.region)) $("#region").value = f.region;
      $("#length").value = f.length || "";
      $("#sort").value = f.sort === "near" ? "name" : f.sort || "name";
      (f.diff || []).forEach((d) => state.diff.add(d));
      document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", state.diff.has(c.dataset.diff)));
    }
    apply();
    route();
  }

  // ---------- filtering ----------
  function apply() {
    const q = $("#q").value.trim().toLowerCase();
    const region = $("#region").value;
    const [lo, hi] = ($("#length").value || "0-99999").split("-").map(Number);
    const sort = $("#sort").value;
    store.set("filters", { q, region, length: $("#length").value, sort, diff: [...state.diff] });

    state.filtered = state.trails.filter((t) => {
      const p = t.properties;
      if (q && !q.split(/\s+/).every((w) => p._search.includes(w))) return false;
      if (region && p.region !== region) return false;
      if (state.diff.size && !state.diff.has(p.difficulty)) return false;
      if (p.lengthKm < lo || p.lengthKm >= hi) return false;
      return true;
    });
    const by = {
      name: (a, b) => a.properties.name.localeCompare(b.properties.name),
      short: (a, b) => a.properties.lengthKm - b.properties.lengthKm,
      long: (a, b) => b.properties.lengthKm - a.properties.lengthKm,
      near: (a, b) => (a._dist ?? 1e9) - (b._dist ?? 1e9),
    };
    if (sort === "near" && state.me) state.trails.forEach((t) => (t._dist = haversine(state.me, t.properties.start)));
    state.filtered.sort(by[sort] || by.name);

    trailLayer.clearLayers();
    state.filtered.forEach((t) => trailLayer.addLayer(t._layer));
    renderList();
  }

  function renderList() {
    const n = state.filtered.length;
    $("#count").textContent = `${n} ${n === 1 ? "trail" : "trails"}`;
    if (!n) {
      $("#list").innerHTML = '<li class="empty">No trails match these filters.<br><button type="button" class="btn" id="clearF">Clear filters</button></li>';
      $("#clearF").onclick = clearFilters;
      return;
    }
    $("#list").innerHTML = state.filtered.map((t) => {
      const p = t.properties;
      const bits = [km(p.lengthKm), DIFF_LABEL[p.difficulty], p.region];
      if (p.ascent != null) bits.splice(1, 0, `↑${p.ascent} m`);
      if (t._dist != null && $("#sort").value === "near") bits.push(`${t._dist.toFixed(t._dist < 10 ? 1 : 0)} km away`);
      return `<li><button type="button" class="item" data-id="${esc(p.id)}">
        <span class="bar" style="background:${COLORS[p.difficulty]}"></span>
        <span><h3>${esc(p.name)}</h3><p>${bits.map(esc).join(" · ")}</p></span>
      </button></li>`;
    }).join("");
  }

  function clearFilters() {
    $("#q").value = ""; $("#region").value = ""; $("#length").value = "";
    state.diff.clear();
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    apply();
  }

  // ---------- selection ----------
  function select(id, { fit = true } = {}) {
    const t = state.trails.find((x) => x.properties.id === id);
    if (!t) return;
    if (state.selected) state.selected._layer.setStyle(styleFor(state.selected));
    state.selected = t;
    if (selectedLayer) map.removeLayer(selectedLayer);
    selectedLayer = L.layerGroup([
      L.geoJSON(t, { style: { color: "#fff", weight: 10, opacity: 0.9 }, interactive: false }),
      L.geoJSON(t, { style: { color: SELECTED, weight: 6, opacity: 1 }, interactive: false }),
    ]).addTo(map);
    if (startMarker) map.removeLayer(startMarker);
    const [lon, lat] = t.properties.start;
    startMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: "", html: '<div class="start-pin"></div>', iconSize: [30, 30], iconAnchor: [15, 30] }),
      title: "Trail start",
    }).addTo(map).bindTooltip("Start", { direction: "top", offset: [0, -28] });
    if (fit) {
      const pad = window.innerWidth > 760 ? [40, 40] : [20, 20];
      map.fitBounds(t._layer.getBounds(), { padding: pad, maxZoom: 15 });
    }
    renderDetail(t);
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  }

  function deselect() {
    if (selectedLayer) map.removeLayer(selectedLayer);
    if (startMarker) map.removeLayer(startMarker);
    selectedLayer = startMarker = null;
    state.selected = null;
    $("#detailView").hidden = true;
    $("#listView").hidden = false;
    document.querySelector(".app").classList.remove("detail");
    history.replaceState(null, "", location.pathname + location.search);
  }

  function profileSvg(p) {
    const pr = (p.profile || []).filter((e) => e != null);
    if (pr.length < 2) return "";
    const W = 320, H = 110, padL = 34, padB = 16, padT = 8;
    const min = Math.min(...pr), max = Math.max(...pr);
    const span = Math.max(20, max - min);
    const x = (i) => padL + (i / (pr.length - 1)) * (W - padL - 4);
    const y = (e) => padT + (1 - (e - min) / span) * (H - padT - padB);
    const line = pr.map((e, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(e).toFixed(1)}`).join("");
    const area = `${line}L${x(pr.length - 1).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;
    return `<div class="profile"><h3>Elevation profile</h3>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation from ${min} to ${max} metres">
        <path d="${area}" fill="${SELECTED}" opacity="0.18"/>
        <path d="${line}" fill="none" stroke="${SELECTED}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <text class="ax" x="0" y="${y(max) + 4}">${max} m</text>
        <text class="ax" x="0" y="${y(min)}">${min} m</text>
        <text class="ax" x="${padL}" y="${H - 2}">0</text>
        <text class="ax" x="${W - 4}" y="${H - 2}" text-anchor="end">${esc(km(p.lengthKm))}</text>
      </svg></div>`;
  }

  function renderDetail(t) {
    const p = t.properties;
    const [lon, lat] = p.start;
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
    const osmUrl = `https://www.openstreetmap.org/${p.osm}`;
    const badges = [
      `<span class="badge"><i class="${p.difficulty}"></i>${DIFF_LABEL[p.difficulty]}${p.difficultySource === "estimate" ? " (estimated)" : ""}</span>`,
      `<span class="badge">${esc(p.region)}</span>`,
      `<span class="badge">${p.loop ? "Loop" : "One way"}</span>`,
      p.network ? `<span class="badge">${esc({ iwn: "International", nwn: "National", rwn: "Regional", lwn: "Local" }[p.network] || p.network)} route</span>` : "",
      p.ref ? `<span class="badge">Ref ${esc(p.ref)}</span>` : "",
    ].join("");
    const stats = [
      [km(p.lengthKm), "Length"],
      [hikingTime(p), "Walking time (approx.)"],
      p.ascent != null ? [`${p.ascent} m`, "Total climb"] : null,
      p.maxEle != null ? [`${p.maxEle} m`, "Highest point"] : null,
    ].filter(Boolean);
    $("#detailView").innerHTML = `
      <button type="button" class="back" id="backBtn"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>All trails</button>
      <h2 class="d-title">${esc(p.name)}</h2>
      ${p.nameLocal ? `<p class="d-local">${esc(p.nameLocal)}</p>` : ""}
      <div class="badges">${badges}</div>
      <div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join("")}</div>
      ${profileSvg(p)}
      <div class="actions">
        <a class="btn primary" href="${nav}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 21 3l-8 18-2-8-8-2Z" fill="currentColor"/></svg>Navigate to start</a>
        <div class="two">
          <button type="button" class="btn" id="gpxBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>GPX file</button>
          <button type="button" class="btn" id="shareBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Share</button>
        </div>
      </div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      <p class="note">Start point: ${lat.toFixed(5)}, ${lon.toFixed(5)}.
        ${p.website ? `<a href="${esc(/^https?:/.test(p.website) ? p.website : "https://" + p.website)}" target="_blank" rel="noopener">Official page</a> · ` : ""}
        <a href="${osmUrl}" target="_blank" rel="noopener">View or fix on OpenStreetMap</a></p>
      <p class="note">Walking time is a rough guide. Check conditions before you go and carry plenty of water.</p>`;
    $("#listView").hidden = true;
    $("#detailView").hidden = false;
    $("#panel").scrollTop = 0;
    document.querySelector(".app").classList.add("detail");
    setTimeout(() => map.invalidateSize(), 50);
    $("#backBtn").onclick = deselect;
    $("#gpxBtn").onclick = () => downloadGpx(t);
    $("#shareBtn").onclick = () => share(t);
  }

  // ---------- GPX ----------
  function downloadGpx(t) {
    const p = t.properties;
    const g = t.geometry;
    const lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    const x = (s) => esc(s);
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cykes" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(p.name)}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright></metadata>
  <wpt lat="${p.start[1]}" lon="${p.start[0]}"><name>Start: ${x(p.name)}</name></wpt>
  <trk><name>${x(p.name)}</name><src>https://www.openstreetmap.org/${p.osm}</src>
${lines.map((l) => `    <trkseg>\n${l.map(([lo, la]) => `      <trkpt lat="${la}" lon="${lo}"/>`).join("\n")}\n    </trkseg>`).join("\n")}
  </trk>
</gpx>`;
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = p.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() + ".gpx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function share(t) {
    const url = location.origin + location.pathname + "#" + t.properties.id;
    try {
      if (navigator.share) { await navigator.share({ title: t.properties.name, url }); return; }
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (e) {
      if (e?.name !== "AbortError") toast(url);
    }
  }

  // ---------- location ----------
  function locate(thenSort) {
    if (!navigator.geolocation) { toast("Location is not available in this browser"); return; }
    $("#locateBtn").classList.add("on");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.me = [pos.coords.longitude, pos.coords.latitude];
        if (meMarker) map.removeLayer(meMarker);
        meMarker = L.marker([state.me[1], state.me[0]], {
          icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
          interactive: false,
        }).addTo(map);
        if (!thenSort) map.setView([state.me[1], state.me[0]], Math.max(map.getZoom(), 12));
        apply();
      },
      () => {
        $("#locateBtn").classList.remove("on");
        toast("Could not get your location");
        if (thenSort) { $("#sort").value = "name"; apply(); }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ---------- routing (#r123 share links) ----------
  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && state.trails.some((t) => t.properties.id === id)) select(id);
    else if (state.selected) deselect();
  }

  // ---------- events ----------
  let qTimer;
  $("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(apply, 120); });
  $("#region").addEventListener("change", () => {
    apply();
    if (state.filtered.length) map.fitBounds(L.featureGroup(state.filtered.map((t) => t._layer)).getBounds(), { padding: [30, 30] });
  });
  $("#length").addEventListener("change", apply);
  $("#sort").addEventListener("change", () => {
    if ($("#sort").value === "near" && !state.me) locate(true);
    else apply();
  });
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      const d = c.dataset.diff;
      state.diff.has(d) ? state.diff.delete(d) : state.diff.add(d);
      c.setAttribute("aria-pressed", state.diff.has(d));
      apply();
    })
  );
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest(".item");
    if (b) select(b.dataset.id);
  });
  $("#list").addEventListener("mouseover", (e) => {
    const b = e.target.closest(".item");
    const t = b && state.trails.find((x) => x.properties.id === b.dataset.id);
    if (t) t._layer.setStyle({ weight: 7, opacity: 1 });
  });
  $("#list").addEventListener("mouseout", (e) => {
    const b = e.target.closest(".item");
    const t = b && state.trails.find((x) => x.properties.id === b.dataset.id);
    if (t) t._layer.setStyle(styleFor(t));
  });
  $("#locateBtn").addEventListener("click", () => locate(false));
  $("#home").addEventListener("click", (e) => {
    e.preventDefault();
    deselect();
    map.setView([34.95, 33.2], 9);
  });
  $("#aboutBtn").addEventListener("click", () => $("#about").showModal());
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected && !$("#about").open) deselect(); });

  load();
}
