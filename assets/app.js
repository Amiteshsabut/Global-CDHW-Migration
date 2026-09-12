"use strict";

const WINDOWS = [
  "1982-1986", "1987-1991", "1992-1996", "1997-2001",
  "2002-2006", "2007-2011", "2012-2016", "2017-2019"
];
const WINDOW_COLORS = [
  "#ffffcc", "#ffeda0", "#fed976", "#feb24c",
  "#fd8d3c", "#fc4e2a", "#e31a1c", "#800026"
];
const DENSITY_COLORS = ["#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#8c2d04"];
const CHANGE_NEG = ["#eff3ff", "#bdd7e7", "#6baed6", "#2171b5"];
const CHANGE_POS = ["#fff5eb", "#fdd0a2", "#f16913", "#a63603"];
const SINGLE_COLORS = ["#ffffe5", "#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#993404"];
const BIVAR_COLORS = [
  "#f5f1df", "#f3bd78", "#d36a3b",
  "#b9d4cf", "#b69a77", "#a64d48",
  "#78aeb5", "#706478", "#4a213c"
];

const METRICS = {
  CROPLAND: { title: "Cropland", unit: "%", transform: v => v * 100, format: v => `${fmt(v * 100, 1)}%` },
  PASTURE: { title: "Pasture", unit: "%", transform: v => v * 100, format: v => `${fmt(v * 100, 1)}%` },
  POP2000: { title: "Population (2000)", unit: "people", transform: v => v, format: v => compact(v) },
  GDP: { title: "GDP (2017 international $, PPP)", unit: "$", transform: v => v, format: v => currencyCompact(v) },
  CISI_NORM: { title: "Critical Infrastructure Exposure Index", unit: "0–1", transform: v => v, format: v => fmt(v, 2) },
};
const MIGRATION_FIELDS = {
  TRK_RECENT: "Recent track burden",
  TRK_TOTAL: "Total track burden",
  TRK_CHANGE: "Change in track burden",
  TRK_YRS: "Years with migration",
};
const REGIONS = {
  "Global": [[-58, -180], [84, 180]],
  "North America": [[5, -170], [82, -50]],
  "South America": [[-58, -92], [15, -30]],
  "Europe": [[34, -25], [72, 45]],
  "Africa": [[-38, -20], [38, 55]],
  "Asia": [[-10, 25], [82, 180]],
  "Oceania": [[-50, 105], [5, 180]],
};

const state = {
  tab: "tracks",
  summary: null,
  tracks: null,
  corridors: null,
  exposure: null,
  rasters: {},
  map: null,
  base: null,
  activeLayer: null,
  trackPoints: null,
  chart: null,
  trackWindow: "all",
  trackOpacity: .70,
  showTrackPoints: false,
  densityMode: "recent",
  densityOpacity: .88,
  corridorWindow: WINDOWS[0],
  corridorTimer: null,
  selectedPathway: null,
  exposureMetric: "CROPLAND",
  exposureMode: "joint",
  migrationField: "TRK_RECENT",
};

const $ = id => document.getElementById(id);
const numeric = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const num = v => numeric(v) ? Number(v) : null;
const fmt = (v, d = 0) => numeric(v) ? Number(v).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
const pct = v => numeric(v) ? `${fmt(Number(v) * 100, 1)}%` : "—";
const compact = v => {
  if (!numeric(v)) return "—";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return fmt(n, 0);
};
const currencyCompact = v => numeric(v) ? `$${compact(v)}` : "—";
const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);

function quantile(values, q) {
  const a = values.filter(numeric).map(Number).sort((x, y) => x - y);
  if (!a.length) return 0;
  const p = (a.length - 1) * q, i = Math.floor(p), r = p - i;
  return a[i + 1] !== undefined ? a[i] + r * (a[i + 1] - a[i]) : a[i];
}
function median(values) { return quantile(values, .5); }
function palette(colors, t) {
  const x = Math.max(0, Math.min(.999999, Number(t) || 0));
  return colors[Math.floor(x * colors.length)];
}
function setStatus(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function setText(id, value) { $(id).textContent = value; }

window.addEventListener("DOMContentLoaded", init);

async function init() {
  setupMap();
  bindUI();
  WINDOWS.forEach(w => {
    $("trackWindow").insertAdjacentHTML("beforeend", `<option value="${w}">${w}</option>`);
    $("corridorWindow").insertAdjacentHTML("beforeend", `<option value="${w}">${w}</option>`);
  });
  try {
    state.summary = await fetchJSON("data/summary.json");
    state.tracks = await fetchJSON(state.summary.files.tracks);
    await loadRasters();
    if (state.summary.corridors?.available && state.summary.files.corridors) {
      state.corridors = await fetchJSON(state.summary.files.corridors);
    }
    if (state.summary.exposure?.available && state.summary.files.exposure) {
      state.exposure = await fetchJSON(state.summary.files.exposure);
    }
    if (!state.summary.corridors?.available) document.querySelector('[data-tab="corridors"]').disabled = true;
    if (!state.summary.exposure?.available) document.querySelector('[data-tab="exposure"]').disabled = true;
    if (!state.summary.exposure?.population_available) {
      const b = document.querySelector('[data-metric="POP2000"]');
      if (b) b.disabled = true;
    }
    setStatus("Ready");
    render();
  } catch (err) {
    console.error(err);
    setStatus("Data could not be loaded", true);
  }
}

function setupMap() {
  state.map = L.map("map", {
    center: [18, 0], zoom: 2, minZoom: 1, maxZoom: 8,
    maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1, worldCopyJump: false, preferCanvas: true,
  });
  state.base = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, noWrap: true,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  }).addTo(state.map);
  state.map.fitBounds(REGIONS.Global, { padding: [8, 8] });
}

function bindUI() {
  document.querySelectorAll(".main-tab").forEach(btn => btn.addEventListener("click", () => {
    if (btn.disabled) return;
    stopCorridorAnimation();
    document.querySelectorAll(".main-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    clearMapLayers();
    render();
  }));
  $("regionSelect").addEventListener("change", e => fitRegion(e.target.value));
  $("resetView").addEventListener("click", () => { $("regionSelect").value = "Global"; fitRegion("Global"); });
  $("trackWindow").addEventListener("change", e => { state.trackWindow = e.target.value; renderTracks(); updateTrackKpis(); });
  $("trackOpacity").addEventListener("input", e => {
    state.trackOpacity = Number(e.target.value) / 100; setText("trackOpacityValue", `${e.target.value}%`);
    if (state.tab === "tracks") renderTracks();
  });
  $("showTrackPoints").addEventListener("change", e => { state.showTrackPoints = e.target.checked; if (state.tab === "tracks") renderTracks(); });
  document.querySelectorAll("#densityMode button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll("#densityMode button").forEach(b => b.classList.remove("active")); btn.classList.add("active");
    state.densityMode = btn.dataset.density; if (state.tab === "density") renderDensity();
  }));
  $("densityOpacity").addEventListener("input", e => {
    state.densityOpacity = Number(e.target.value) / 100; setText("densityOpacityValue", `${e.target.value}%`);
    if (state.activeLayer?.setOpacity) state.activeLayer.setOpacity(state.densityOpacity);
  });
  $("corridorWindow").addEventListener("change", e => { state.corridorWindow = e.target.value; state.selectedPathway = null; if (state.tab === "corridors") renderCorridors(); });
  $("animateCorridors").addEventListener("click", toggleCorridorAnimation);
  document.querySelectorAll("#metricTabs button").forEach(btn => btn.addEventListener("click", () => {
    if (btn.disabled) return;
    document.querySelectorAll("#metricTabs button").forEach(b => b.classList.remove("active")); btn.classList.add("active");
    state.exposureMetric = btn.dataset.metric; if (state.tab === "exposure") renderExposure();
  }));
  document.querySelectorAll("#exposureMode button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll("#exposureMode button").forEach(b => b.classList.remove("active")); btn.classList.add("active");
    state.exposureMode = btn.dataset.mode; if (state.tab === "exposure") renderExposure();
  }));
  $("migrationField").addEventListener("change", e => { state.migrationField = e.target.value; if (state.tab === "exposure") renderExposure(); });
}

function fitRegion(name) { state.map.fitBounds(REGIONS[name] || REGIONS.Global, { padding: [8, 8] }); }

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cannot load ${url}`);
  return r.json();
}
async function loadRasters() {
  const f = state.summary.files;
  const [early, recent, change] = await Promise.all([
    loadGeoRaster(f.early_density), loadGeoRaster(f.recent_density), loadGeoRaster(f.change_density)
  ]);
  state.rasters = { early, recent, change };
}
async function loadGeoRaster(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`Cannot load ${url}`);
  return parseGeoraster(await r.arrayBuffer());
}

function clearMapLayers() {
  if (state.activeLayer && state.map.hasLayer(state.activeLayer)) state.map.removeLayer(state.activeLayer);
  if (state.trackPoints && state.map.hasLayer(state.trackPoints)) state.map.removeLayer(state.trackPoints);
  state.activeLayer = null; state.trackPoints = null;
}

function showControls(tab) {
  ["trackControls", "densityControls", "corridorControls", "exposureControls"].forEach(id => $(id).classList.add("hidden"));
  const target = { tracks: "trackControls", density: "densityControls", corridors: "corridorControls", exposure: "exposureControls" }[tab];
  if (target) $(target).classList.remove("hidden");
}

function render() {
  if (!state.summary) return;
  showControls(state.tab);
  if (state.tab === "tracks") renderTracks();
  if (state.tab === "density") renderDensity();
  if (state.tab === "corridors") renderCorridors();
  if (state.tab === "exposure") renderExposure();
}

function setKpis(items) {
  items.forEach((x, i) => {
    setText(`kpi${i+1}Label`, x.label); setText(`kpi${i+1}Value`, x.value); setText(`kpi${i+1}Note`, x.note || "");
  });
}

function trackColor(windowName) {
  const i = WINDOWS.indexOf(windowName);
  return WINDOW_COLORS[i >= 0 ? i : WINDOW_COLORS.length - 1];
}
function trackFeatures() {
  return state.tracks.features.filter(f => state.trackWindow === "all" || f.properties?.window === state.trackWindow);
}
function renderTracks() {
  clearMapLayers();
  setText("mapEyebrow", "GLOBAL MIGRATION"); setText("mapTitle", "Observed CDHW Migration Tracks");
  setText("profileEyebrow", "TRACK PROFILE"); setText("profileTitle", "Select a migration track");
  $("profileBody").innerHTML = `<p class="placeholder">Click a track to inspect its start year, five-year window, path length, net displacement, direction, and number of track positions.</p>`;
  const features = trackFeatures();
  state.activeLayer = L.geoJSON({ type: "FeatureCollection", features }, {
    style: f => ({ color: trackColor(f.properties?.window), weight: 1.35, opacity: state.trackOpacity, lineCap: "round", lineJoin: "round" }),
    pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 2, color: trackColor(f.properties?.window), weight: 1, fillOpacity: .8 }),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindTooltip(`${esc(p.track_id || "Track")} · ${esc(p.start_year)}`, { className: "dashboard-tip", sticky: true });
      layer.on("mouseover", () => layer.setStyle?.({ weight: 3, opacity: 1 }));
      layer.on("mouseout", () => layer.setStyle?.({ weight: 1.35, opacity: state.trackOpacity }));
      layer.on("click", () => showTrackProfile(p));
    }
  }).addTo(state.map);
  if (state.showTrackPoints) state.trackPoints = buildTrackPoints(features).addTo(state.map);
  renderTrackLegend(); updateTrackKpis(); drawAnnualChart(); setStatus(`${fmt(features.length)} tracks displayed`);
}
function buildTrackPoints(features) {
  const group = L.layerGroup();
  features.forEach(f => {
    const g = f.geometry, c = trackColor(f.properties?.window);
    const parts = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [];
    parts.forEach(part => part.forEach(xy => {
      if (xy.length >= 2) L.circleMarker([xy[1], xy[0]], { radius: 1.5, color: c, weight: 0, fillColor: c, fillOpacity: .75 }).addTo(group);
    }));
  });
  return group;
}
function renderTrackLegend() {
  $("legend").innerHTML = `<div class="legend-title">Track start window</div><div class="legend-items">${WINDOWS.map((w,i) => `<span class="legend-item"><i style="background:${WINDOW_COLORS[i]}"></i>${w}</span>`).join("")}</div>`;
}
function updateTrackKpis() {
  const s = state.summary.tracks, features = trackFeatures();
  const lens = features.map(f => num(f.properties?.path_length_km)).filter(numeric);
  const current = state.trackWindow === "all" ? "1982–2019" : state.trackWindow;
  setKpis([
    { label: "Tracks displayed", value: fmt(features.length), note: current },
    { label: "Early-period tracks", value: fmt(s.early_count), note: "1982–2000" },
    { label: "Recent-period tracks", value: fmt(s.recent_count), note: "2001–2019" },
    { label: "Median path length", value: `${fmt(median(lens), 0)} km`, note: current },
  ]);
}
function showTrackProfile(p) {
  setText("profileTitle", p.track_id || "Migration track");
  $("profileBody").innerHTML = `
    <div class="profile-hero"><span>Start year</span><strong>${esc(p.start_year)}</strong><span class="class-badge">${esc(p.window || "")}</span></div>
    <div class="profile-grid">
      <div><span>Path length</span><b>${fmt(p.path_length_km,0)} km</b></div>
      <div><span>Net displacement</span><b>${fmt(p.net_displacement_km,0)} km</b></div>
      <div><span>Direction</span><b>${esc(p.direction || "—")}</b></div>
      <div><span>Bearing</span><b>${numeric(p.mean_bearing_deg) ? `${fmt(p.mean_bearing_deg,1)}°` : "—"}</b></div>
      <div><span>Track positions</span><b>${fmt(p.n_positions)}</b></div>
      <div><span>Track ID</span><b>${esc(p.track_id || "—")}</b></div>
    </div>`;
}

function densityColor(value, max) {
  if (!numeric(value) || Number(value) <= 0 || max <= 0) return null;
  return palette(DENSITY_COLORS, Number(value) / max);
}
function changeColor(value, maxAbs) {
  if (!numeric(value) || maxAbs <= 0) return null;
  const v = Number(value); if (Math.abs(v) < maxAbs * .005) return "rgba(255,255,255,0)";
  return v < 0 ? palette(CHANGE_NEG, Math.abs(v) / maxAbs) : palette(CHANGE_POS, v / maxAbs);
}
function makeRasterLayer(raster, colorFn) {
  return new GeoRasterLayer({ georaster: raster, opacity: state.densityOpacity, resolution: 256, zIndex: 300, pixelValuesToColorFn: v => colorFn(v?.[0]) });
}
function renderDensity() {
  clearMapLayers();
  const mode = state.densityMode, ds = state.summary.density;
  setText("mapEyebrow", "SPATIAL INTENSITY");
  if (mode === "change") {
    setText("mapTitle", "Change in Migration-Track Density, 2001–2019 minus 1982–2000");
    state.activeLayer = makeRasterLayer(state.rasters.change, v => changeColor(v, ds.change_color_abs_max)).addTo(state.map);
    $("legend").innerHTML = rampLegend("Change in track count", "linear-gradient(90deg,#2171b5,#bdd7e7,#f7f7f7,#fdd0a2,#a63603)", `−${fmt(ds.change_color_abs_max,1)}`, `+${fmt(ds.change_color_abs_max,1)}`);
  } else {
    const period = mode === "early" ? "1982–2000" : "2001–2019";
    setText("mapTitle", `Cumulative Migration-Track Density — ${period}`);
    state.activeLayer = makeRasterLayer(state.rasters[mode], v => densityColor(v, ds.density_color_max)).addTo(state.map);
    $("legend").innerHTML = rampLegend("Cumulative track count", "linear-gradient(90deg,#fff7bc,#fec44f,#fe9929,#ec7014,#8c2d04)", "0", fmt(ds.density_color_max,1));
  }
  const n = ds.native_stats;
  setKpis([
    { label: "Early track-count sum", value: compact(n.early.sum), note: "native grid" },
    { label: "Recent track-count sum", value: compact(n.recent.sum), note: "native grid" },
    { label: "Recent positive cells", value: fmt(n.recent.positive_cells), note: "cells with migration" },
    { label: "Maximum recent count", value: fmt(n.recent.max,1), note: "native grid" },
  ]);
  setText("profileEyebrow", "DENSITY SUMMARY"); setText("profileTitle", "Migration-track density");
  $("profileBody").innerHTML = `<div class="profile-section"><h4>Period comparison</h4>
    <div class="profile-row"><span>1982–2000 sum</span><b>${compact(n.early.sum)}</b></div>
    <div class="profile-row"><span>2001–2019 sum</span><b>${compact(n.recent.sum)}</b></div>
    <div class="profile-row"><span>Recent maximum</span><b>${fmt(n.recent.max,1)}</b></div>
    <div class="profile-row"><span>Display resolution</span><b>${fmt(ds.display_resolution_deg,3)}°</b></div></div>`;
  drawDensityChart(); setStatus("Density layer ready");
}
function rampLegend(title, gradient, lo, hi) {
  return `<div class="legend-title">${esc(title)}</div><div class="ramp" style="background:${gradient}"></div><div class="ramp-labels"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>`;
}

function corridorPathways(windowName) {
  const seen = new Map();
  (state.corridors?.features || []).forEach(f => {
    const p = f.properties || {};
    if (p.window === windowName && p.pathway_id && !seen.has(p.pathway_id)) seen.set(p.pathway_id, p);
  });
  return [...seen.values()];
}
function renderCorridors() {
  clearMapLayers();
  if (!state.corridors) { setStatus("Corridor data unavailable", true); return; }
  setText("mapEyebrow", "FIVE-YEAR PATHWAYS"); setText("mapTitle", `CDHW Migration Corridors — ${state.corridorWindow}`);
  const features = state.corridors.features.filter(f => f.properties?.window === state.corridorWindow);
  state.activeLayer = L.geoJSON({ type: "FeatureCollection", features }, {
    style: f => corridorStyle(f.properties || {}),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      layer.bindTooltip(`${esc(p.pathway_id || "Pathway")} · ${fmt(p.associated_events)} events`, { className: "dashboard-tip", sticky: true });
      layer.on("click", () => { state.selectedPathway = p.pathway_id; highlightPathway(); showCorridorProfile(p); });
    }
  }).addTo(state.map);
  highlightPathway();
  const paths = corridorPathways(state.corridorWindow);
  const lengths = paths.map(p => num(p.data_path_length_km)).filter(numeric);
  const widths = paths.map(p => num(p.median_width50_km)).filter(numeric);
  const assoc = paths.reduce((s,p) => s + (num(p.associated_events) || 0), 0);
  setKpis([
    { label: "Pathways", value: fmt(paths.length), note: state.corridorWindow },
    { label: "Associated events", value: fmt(assoc), note: "unique pathway totals" },
    { label: "Median pathway length", value: `${fmt(median(lengths),0)} km`, note: state.corridorWindow },
    { label: "Median 50% width", value: `${fmt(median(widths),0)} km`, note: "corridor concentration" },
  ]);
  $("legend").innerHTML = `<div class="legend-title">Containment envelopes</div><div class="legend-items"><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.20"></i>90%</span><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.40"></i>50%</span><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.72"></i>20%</span></div>`;
  if (!state.selectedPathway) {
    setText("profileEyebrow", "CORRIDOR PROFILE"); setText("profileTitle", "Select a migration corridor");
    $("profileBody").innerHTML = `<p class="placeholder">Click a corridor to inspect pathway rank, associated events, path length, corridor widths, direction, directional dominance, and transition probability.</p>`;
  }
  drawCorridorChart(paths); setStatus(`${fmt(paths.length)} pathways in ${state.corridorWindow}`);
}
function corridorStyle(p) {
  const color = p.pathway_color || p.fill_color || "#cf6b34";
  if (p.feature_type === "guide_rail") return { color: "#353b37", weight: 1.15, opacity: .68, dashArray: "4 3" };
  const level = Number(p.containment_level || 90);
  const opacity = level === 20 ? .56 : level === 50 ? .28 : .12;
  const selected = state.selectedPathway && p.pathway_id === state.selectedPathway;
  return { color: selected ? "#17231c" : color, weight: selected ? 2.2 : .75, fillColor: color, fillOpacity: selected ? Math.min(.72, opacity + .12) : opacity };
}
function highlightPathway() {
  if (!state.activeLayer?.eachLayer) return;
  state.activeLayer.eachLayer(layer => {
    if (!layer.feature) return;
    layer.setStyle?.(corridorStyle(layer.feature.properties || {}));
  });
}
function showCorridorProfile(p) {
  setText("profileEyebrow", "CORRIDOR PROFILE"); setText("profileTitle", p.pathway_id || "Migration corridor");
  $("profileBody").innerHTML = `
    <div class="profile-hero"><span>Five-year window</span><strong>${esc(p.window || "—")}</strong><span class="class-badge">Rank ${fmt(p.rank)}</span></div>
    <div class="profile-grid">
      <div><span>Associated events</span><b>${fmt(p.associated_events)}</b></div>
      <div><span>Path length</span><b>${fmt(p.data_path_length_km,0)} km</b></div>
      <div><span>50% width</span><b>${fmt(p.median_width50_km,0)} km</b></div>
      <div><span>90% width</span><b>${fmt(p.median_width90_km,0)} km</b></div>
      <div><span>Direction</span><b>${esc(p.direction || "—")}</b></div>
      <div><span>Mean bearing</span><b>${numeric(p.mean_bearing_deg) ? `${fmt(p.mean_bearing_deg,1)}°` : "—"}</b></div>
    </div>
    <div class="profile-section"><h4>Pathway organization</h4>
      <div class="profile-row"><span>Directional dominance</span><b>${pct(p.directional_dominance)}</b></div>
      <div class="profile-row"><span>Transition probability</span><b>${pct(p.transition_probability)}</b></div>
      <div class="profile-row"><span>20% width</span><b>${fmt(p.median_width20_km,0)} km</b></div>
      <div class="profile-row"><span>Guide-rail offset</span><b>${fmt(p.guide_rail_offset_km,0)} km</b></div>
    </div>`;
}
function toggleCorridorAnimation() {
  if (state.corridorTimer) { stopCorridorAnimation(); return; }
  $("animateCorridors").classList.add("playing"); $("animateCorridors").textContent = "■ Stop animation";
  state.corridorTimer = setInterval(() => {
    let i = WINDOWS.indexOf(state.corridorWindow); state.corridorWindow = WINDOWS[(i + 1) % WINDOWS.length];
    $("corridorWindow").value = state.corridorWindow; state.selectedPathway = null; renderCorridors();
  }, 1400);
}
function stopCorridorAnimation() {
  if (state.corridorTimer) clearInterval(state.corridorTimer);
  state.corridorTimer = null;
  $("animateCorridors")?.classList.remove("playing"); if ($("animateCorridors")) $("animateCorridors").textContent = "▶ Animate windows";
}

function exposureFeatures() { return state.exposure?.features || []; }
function metricValue(p) { return num(p?.[state.exposureMetric]); }
function migrationValue(p) { return num(p?.[state.migrationField]); }
function transformedMetric(v) { return METRICS[state.exposureMetric].transform(v); }
function tertile(value, q1, q2) { if (!numeric(value)) return null; return Number(value) <= q1 ? 0 : Number(value) <= q2 ? 1 : 2; }
function exposureBreaks() {
  const vals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric);
  return [quantile(vals, 1/3), quantile(vals, 2/3)];
}
function migrationBreaks() {
  let vals = exposureFeatures().map(f => migrationValue(f.properties || {})).filter(numeric);
  const pos = vals.filter(v => v > 0); if (pos.length >= 3) vals = pos;
  return [quantile(vals, 1/3), quantile(vals, 2/3)];
}
function bivarIndex(migration, exposure, mb, eb) {
  const x = tertile(migration, mb[0], mb[1]), y = tertile(exposure, eb[0], eb[1]);
  return x === null || y === null ? null : y * 3 + x;
}
function renderExposure() {
  clearMapLayers();
  if (!state.exposure) { setStatus("Exposure data unavailable", true); return; }
  const def = METRICS[state.exposureMetric];
  const eb = exposureBreaks(), mb = migrationBreaks();
  const singleVals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric);
  const singleRange = [quantile(singleVals, .03), quantile(singleVals, .97)];
  setText("mapEyebrow", state.exposureMode === "joint" ? "BIVARIATE EXPOSURE" : "ADM1 EXPOSURE");
  setText("mapTitle", state.exposureMode === "joint" ? `${MIGRATION_FIELDS[state.migrationField]} × ${def.title}` : def.title);
  state.activeLayer = L.geoJSON(state.exposure, {
    style: f => exposureStyle(f.properties || {}, eb, mb, singleRange),
    onEachFeature: (f, layer) => {
      const p = f.properties || {}, val = metricValue(p);
      layer.bindTooltip(`${esc(p.shapeName || "ADM1")} · ${def.format(val)}`, { className: "dashboard-tip", sticky: true });
      layer.on("mouseover", () => layer.setStyle({ weight: 1.6, color: "#252b27" }));
      layer.on("mouseout", () => layer.setStyle(exposureStyle(p, eb, mb, singleRange)));
      layer.on("click", () => showExposureProfile(p, eb, mb));
    }
  }).addTo(state.map);
  renderExposureLegend(def, eb, mb); updateExposureKpis(def, eb, mb); drawExposureChart(def, mb);
  setText("profileEyebrow", "REGIONAL PROFILE"); setText("profileTitle", "Select an ADM1 region");
  $("profileBody").innerHTML = `<p class="placeholder">Click a first-order administrative region to inspect migration burden together with cropland, pasture, population, GDP, and critical-infrastructure exposure.</p>`;
  setStatus(`${fmt(exposureFeatures().length)} ADM1 regions`);
}
function exposureStyle(p, eb, mb, singleRange) {
  const v = metricValue(p); if (!numeric(v)) return { color: "#d4d4cc", weight: .45, fillColor: "#efeee8", fillOpacity: .45 };
  let fill;
  if (state.exposureMode === "joint") {
    const idx = bivarIndex(migrationValue(p), v, mb, eb); fill = idx === null ? "#efeee8" : BIVAR_COLORS[idx];
  } else {
    const lo = singleRange?.[0] ?? v, hi = singleRange?.[1] ?? v;
    fill = palette(SINGLE_COLORS, (v - lo) / Math.max(hi - lo, 1e-12));
  }
  return { color: "#8d938c", weight: .45, fillColor: fill, fillOpacity: .87 };
}
function renderExposureLegend(def, eb, mb) {
  if (state.exposureMode === "single") {
    const vals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric);
    const lo = quantile(vals,.03), hi = quantile(vals,.97);
    $("legend").innerHTML = rampLegend(def.title, "linear-gradient(90deg,#ffffe5,#fee391,#fe9929,#ec7014,#993404)", def.format(lo), def.format(hi));
    return;
  }
  const cells = [];
  for (let y = 2; y >= 0; y--) for (let x = 0; x < 3; x++) cells.push(`<i style="background:${BIVAR_COLORS[y*3+x]}"></i>`);
  $("legend").innerHTML = `<div class="legend-title">${esc(def.title)} (low → high) × migration (low → high)</div><div class="bivar-legend">${cells.join("")}</div><div class="bivar-caption">33rd / 66th percentile joint classes</div>`;
}
function updateExposureKpis(def, eb, mb) {
  const feats = exposureFeatures();
  const vals = feats.map(f => metricValue(f.properties || {})).filter(numeric);
  const highHigh = feats.filter(f => bivarIndex(migrationValue(f.properties||{}), metricValue(f.properties||{}), mb, eb) === 8).length;
  const recent = feats.map(f => num(f.properties?.TRK_RECENT)).filter(numeric);
  setKpis([
    { label: "ADM1 regions", value: fmt(feats.length), note: "global first-order units" },
    { label: `Median ${def.title}`, value: def.format(median(vals)), note: "across valid regions" },
    { label: "High migration–high exposure", value: fmt(highHigh), note: "upper joint class" },
    { label: "Median recent track burden", value: fmt(median(recent),2), note: "2001–2019" },
  ]);
}
function classWord(i) { return ["Low", "Moderate", "High"][i] || "—"; }
function showExposureProfile(p, eb, mb) {
  const def = METRICS[state.exposureMetric], v = metricValue(p), m = migrationValue(p), idx = bivarIndex(m, v, mb, eb);
  const joint = idx === null ? "No joint class" : `${classWord(idx % 3)} migration–${classWord(Math.floor(idx / 3))} exposure`;
  setText("profileEyebrow", "ADM1 REGION PROFILE"); setText("profileTitle", `${p.shapeName || "Region"}${p.shapeGroup ? `, ${p.shapeGroup}` : ""}`);
  $("profileBody").innerHTML = `
    <div class="profile-hero"><span>${esc(def.title)}</span><strong>${esc(def.format(v))}</strong><span class="class-badge">${esc(joint)}</span></div>
    <div class="profile-grid">
      <div><span>Recent track burden</span><b>${fmt(p.TRK_RECENT,2)}</b></div>
      <div><span>Total track burden</span><b>${fmt(p.TRK_TOTAL,2)}</b></div>
      <div><span>Track-burden change</span><b>${numeric(p.TRK_CHANGE) && Number(p.TRK_CHANGE)>0 ? "+" : ""}${fmt(p.TRK_CHANGE,2)}</b></div>
      <div><span>Years with migration</span><b>${fmt(p.TRK_YRS)}</b></div>
    </div>
    <div class="profile-section"><h4>Exposure context</h4>
      <div class="profile-row"><span>Cropland</span><b>${METRICS.CROPLAND.format(num(p.CROPLAND))}</b></div>
      <div class="profile-row"><span>Pasture</span><b>${METRICS.PASTURE.format(num(p.PASTURE))}</b></div>
      <div class="profile-row"><span>Population (2000)</span><b>${METRICS.POP2000.format(num(p.POP2000))}</b></div>
      <div class="profile-row"><span>GDP (2017 international $, PPP)</span><b>${METRICS.GDP.format(num(p.GDP))}</b></div>
      <div class="profile-row"><span>Critical infrastructure index</span><b>${METRICS.CISI_NORM.format(num(p.CISI_NORM))}</b></div>
    </div>`;
}

function destroyChart() { if (state.chart) { state.chart.destroy(); state.chart = null; } }
function chartBaseOptions() {
  return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false }, ticks: { color: "#677069", font: { size: 9 } } },
              y: { beginAtZero: true, grid: { color: "rgba(100,110,100,.12)" }, ticks: { color: "#677069", font: { size: 9 } } } } };
}
function drawAnnualChart() {
  destroyChart(); setText("chartEyebrow", "TEMPORAL DISTRIBUTION"); setText("chartTitle", "Annual CDHW Migration Events");
  const a = state.summary.tracks.annual;
  state.chart = new Chart($("sideChart"), { type: "line", data: { labels: a.map(d=>d.year), datasets: [{ data: a.map(d=>d.events), borderColor: "#8b2f24", backgroundColor: "rgba(207,107,52,.12)", fill: true, tension: .22, pointRadius: 1.6, borderWidth: 2 }] }, options: chartBaseOptions() });
}
function drawDensityChart() {
  destroyChart(); setText("chartEyebrow", "PERIOD COMPARISON"); setText("chartTitle", "Cumulative Migration-Track Count");
  const n = state.summary.density.native_stats;
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: ["1982–2000", "2001–2019"], datasets: [{ data: [n.early.sum, n.recent.sum], backgroundColor: ["#dfad69", "#9a4b31"] }] }, options: chartBaseOptions() });
}
function drawCorridorChart(paths) {
  destroyChart(); setText("chartEyebrow", "PATHWAY ACTIVITY"); setText("chartTitle", `Associated Events — ${state.corridorWindow}`);
  const rows = [...paths].sort((a,b)=>(num(b.associated_events)||0)-(num(a.associated_events)||0)).slice(0,10);
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: rows.map(p => String(p.pathway_id||"").replace(/^.*_P/,"P")), datasets: [{ data: rows.map(p=>num(p.associated_events)||0), backgroundColor: rows.map(p=>p.pathway_color||"#cf6b34") }] }, options: chartBaseOptions() });
}
function drawExposureChart(def, mb) {
  destroyChart(); setText("chartEyebrow", "MIGRATION–EXPOSURE GRADIENT"); setText("chartTitle", `${def.title} by Migration-Burden Class`);
  const groups = [[],[],[]];
  exposureFeatures().forEach(f => {
    const p=f.properties||{}, m=migrationValue(p), v=metricValue(p); if(!numeric(m)||!numeric(v)) return;
    const g=tertile(m,mb[0],mb[1]); groups[g].push(transformedMetric(v));
  });
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: ["Low", "Moderate", "High"], datasets: [{ data: groups.map(g=>median(g)), backgroundColor: ["#b9d4cf", "#b69a77", "#681b3b"] }] }, options: chartBaseOptions() });
}
