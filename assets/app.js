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
  CROPLAND: { title: "Cropland", transform: v => v * 100, format: v => numeric(v) ? `${fmt(v * 100, 1)}%` : "—" },
  PASTURE: { title: "Pasture", transform: v => v * 100, format: v => numeric(v) ? `${fmt(v * 100, 1)}%` : "—" },
  GDP: { title: "GDP (2017 international $, PPP)", axisTitle: "GDP", transform: v => numeric(v) && Number(v) > 0 ? Math.log10(Number(v)) : null, format: v => currencyCompact(v) },
  CISI_NORM: { title: "Critical Infrastructure Exposure Index", axisTitle: "CISI", transform: v => v, format: v => fmt(v, 2) },
};
const MIGRATION_FIELDS = {
  TRK_RECENT: "Recent track burden",
  TRK_TOTAL: "Total track burden",
  TRK_CHANGE: "Change in track burden",
  TRK_YRS: "Years with migration",
};

const state = {
  tab: "tracks",
  summary: null,
  world: null,
  tracks: null,
  corridors: null,
  exposure: null,
  rasters: {},
  rasterImages: {},
  chart: null,
  projection: null,
  path: null,
  svg: null,
  baseZoom: null,
  dataZoom: null,
  overlay: null,
  zoom: null,
  zoomTransform: d3.zoomIdentity,
  mapWidth: 1200,
  mapHeight: 720,
  trackWindow: "all",
  trackOpacity: .70,
  showTrackPoints: false,
  densityMode: "recent",
  densityOpacity: .88,
  corridorWindow: "all",
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
const compact = v => {
  if (!numeric(v)) return "—";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return fmt(n, 0);
};
const currencyCompact = v => numeric(v) ? `$${compact(v)}` : "—";
const superscript = n => String(n).replace(/-/g, "⁻").replace(/0/g,"⁰").replace(/1/g,"¹").replace(/2/g,"²").replace(/3/g,"³").replace(/4/g,"⁴").replace(/5/g,"⁵").replace(/6/g,"⁶").replace(/7/g,"⁷").replace(/8/g,"⁸").replace(/9/g,"⁹");
const powerLabel = e => `10${superscript(e)}`;
const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
const pct = v => numeric(v) ? `${fmt(Number(v) * 100, 1)}%` : "—";

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
function setText(id, value) { $(id).textContent = value; }
function setStatus(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function setKpis(items) {
  items.forEach((x, i) => {
    setText(`kpi${i+1}Label`, x.label);
    setText(`kpi${i+1}Value`, x.value);
    setText(`kpi${i+1}Note`, x.note || "");
  });
}
function setProfile(eyebrow, title, html) {
  setText("profileEyebrow", eyebrow);
  setText("profileTitle", title);
  $("profileBody").innerHTML = html;
}

window.addEventListener("DOMContentLoaded", init);

async function init() {
  $("corridorWindow").insertAdjacentHTML("beforeend", '<option value="all">All years, 1982–2019</option>');
  WINDOWS.forEach(w => {
    $("trackWindow").insertAdjacentHTML("beforeend", `<option value="${w}">${w}</option>`);
    $("corridorWindow").insertAdjacentHTML("beforeend", `<option value="${w}">${w}</option>`);
  });
  bindUI();
  setupMapFramework();
  try {
    setStatus("Loading dashboard data…");
    state.summary = await fetchJSON("data/summary.json");
    state.world = await fetchJSON(state.summary.files.world || "data/world_continents.geojson");
    state.tracks = await fetchJSON(state.summary.files.tracks);
    await loadRasters();
    if (state.summary.corridors?.available && state.summary.files.corridors) state.corridors = await fetchJSON(state.summary.files.corridors);
    if (state.summary.exposure?.available && state.summary.files.exposure) state.exposure = await fetchJSON(state.summary.files.exposure);
    if (!state.summary.corridors?.available) document.querySelector('[data-tab="corridors"]').disabled = true;
    if (!state.summary.exposure?.available) document.querySelector('[data-tab="exposure"]').disabled = true;
    resizeMap(true);
    render();
    setStatus("Ready");
    new ResizeObserver(() => resizeMap(false)).observe($("map"));
  } catch (err) {
    console.error(err);
    setStatus("Data could not be loaded", true);
  }
}

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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cannot load ${url}`);
  return parseGeoraster(await r.arrayBuffer());
}

function setupMapFramework() {
  state.svg = d3.select("#mapSvg");
  state.baseZoom = state.svg.append("g").attr("class", "base-zoom");
  state.dataZoom = state.svg.append("g").attr("class", "data-zoom");
  state.overlay = state.svg.append("g").attr("class", "ui-overlay");

  state.zoom = d3.zoom().scaleExtent([1, 10]).on("zoom", event => {
    state.zoomTransform = event.transform;
    state.baseZoom.attr("transform", event.transform);
    state.dataZoom.attr("transform", event.transform);
  });
  state.svg.call(state.zoom).on("dblclick.zoom", null);
  $("zoomIn").addEventListener("click", () => state.svg.transition().duration(220).call(state.zoom.scaleBy, 1.35));
  $("zoomOut").addEventListener("click", () => state.svg.transition().duration(220).call(state.zoom.scaleBy, 1 / 1.35));
  $("zoomHome").addEventListener("click", () => resetZoom());
}

function resizeMap(initial = false) {
  if (!state.world) return;
  const rect = $("map").getBoundingClientRect();
  const w = Math.max(700, Math.floor(rect.width));
  const h = Math.max(560, Math.floor(rect.height));
  if (!initial && Math.abs(w - state.mapWidth) < 4 && Math.abs(h - state.mapHeight) < 4) return;
  state.mapWidth = w;
  state.mapHeight = h;
  state.svg.attr("viewBox", `0 0 ${w} ${h}`);
  state.projection = d3.geoRobinson().precision(.2).fitExtent([[28, 24], [w - 28, h - 24]], state.world);
  state.path = d3.geoPath(state.projection);
  state.rasterImages = {};
  drawBaseMap();
  resetZoom(false);
  render();
}

function drawBaseMap() {
  state.baseZoom.selectAll("*").remove();
  state.baseZoom.append("path").datum({ type: "Sphere" }).attr("class", "map-sphere").attr("d", state.path);
  state.baseZoom.append("path").datum(d3.geoGraticule10()).attr("class", "graticule").attr("d", state.path);
  state.baseZoom.append("g").selectAll("path").data(state.world.features || []).join("path")
    .attr("class", "continent").attr("d", state.path);
}

function resetZoom(animate = true) {
  const target = animate ? state.svg.transition().duration(320) : state.svg;
  target.call(state.zoom.transform, d3.zoomIdentity);
}

function fitRegion(name) {
  if (!state.world || name === "Global") { resetZoom(); return; }
  const features = (state.world.features || []).filter(f => f.properties?.CONTINENT === name);
  if (!features.length) return;
  const fc = { type: "FeatureCollection", features };
  const [[x0, y0], [x1, y1]] = state.path.bounds(fc);
  const dx = Math.max(1, x1 - x0), dy = Math.max(1, y1 - y0);
  const s = Math.min(8, .88 / Math.max(dx / state.mapWidth, dy / state.mapHeight));
  const tx = state.mapWidth / 2 - s * (x0 + x1) / 2;
  const ty = state.mapHeight / 2 - s * (y0 + y1) / 2;
  state.svg.transition().duration(420).call(state.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(s));
}

function bindUI() {
  document.querySelectorAll(".main-tab").forEach(btn => btn.addEventListener("click", () => {
    if (btn.disabled) return;
    stopCorridorAnimation();
    document.querySelectorAll(".main-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    render();
  }));
  $("regionSelect").addEventListener("change", e => fitRegion(e.target.value));
  $("resetView").addEventListener("click", () => { $("regionSelect").value = "Global"; resetZoom(); });
  $("trackWindow").addEventListener("change", e => { state.trackWindow = e.target.value; if (state.tab === "tracks") renderTracks(); });
  $("trackOpacity").addEventListener("input", e => {
    state.trackOpacity = Number(e.target.value) / 100;
    setText("trackOpacityValue", `${e.target.value}%`);
    if (state.tab === "tracks") renderTracks();
  });
  $("showTrackPoints").addEventListener("change", e => { state.showTrackPoints = e.target.checked; if (state.tab === "tracks") renderTracks(); });
  document.querySelectorAll("#densityMode button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll("#densityMode button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.densityMode = btn.dataset.density;
    if (state.tab === "density") renderDensity();
  }));
  $("densityOpacity").addEventListener("input", e => {
    state.densityOpacity = Number(e.target.value) / 100;
    setText("densityOpacityValue", `${e.target.value}%`);
    if (state.tab === "density") renderDensity();
  });
  $("corridorWindow").addEventListener("change", e => {
    state.corridorWindow = e.target.value;
    state.selectedPathway = null;
    if (state.tab === "corridors") renderCorridors();
  });
  $("animateCorridors").addEventListener("click", toggleCorridorAnimation);
  document.querySelectorAll("#metricTabs button").forEach(btn => btn.addEventListener("click", () => {
    if (btn.disabled) return;
    document.querySelectorAll("#metricTabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.exposureMetric = btn.dataset.metric;
    if (state.tab === "exposure") renderExposure();
  }));
  document.querySelectorAll("#exposureMode button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll("#exposureMode button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.exposureMode = btn.dataset.mode;
    if (state.tab === "exposure") renderExposure();
  }));
  $("migrationField").addEventListener("change", e => { state.migrationField = e.target.value; if (state.tab === "exposure") renderExposure(); });
}

function showControls(tab) {
  ["trackControls", "densityControls", "corridorControls", "exposureControls"].forEach(id => $(id).classList.add("hidden"));
  const target = { tracks: "trackControls", density: "densityControls", corridors: "corridorControls", exposure: "exposureControls" }[tab];
  if (target) $(target).classList.remove("hidden");
}
function clearDataLayers() { state.dataZoom.selectAll("*").remove(); tooltipHide(); }
function setMapBackdropForTab() {
  const exposureOnly = state.tab === "exposure";
  // Exposure is a thematic ADM1 map, not a physical basemap. Keep a clean
  // white Robinson sphere and remove continents/graticules so the exposure
  // polygons are the only geography competing for attention.
  state.baseZoom.select(".map-sphere")
    .attr("fill", exposureOnly ? "#ffffff" : "#e4ecee")
    .attr("stroke", exposureOnly ? "#2f3a34" : "#a8b3af")
    .attr("stroke-width", exposureOnly ? 1.05 : .8);
  state.baseZoom.select(".graticule").style("display", exposureOnly ? "none" : null);
  state.baseZoom.selectAll(".continent").style("display", exposureOnly ? "none" : null);
}

function render() {
  if (!state.summary || !state.path) return;
  showControls(state.tab);
  setMapBackdropForTab();
  if (state.tab === "tracks") renderTracks();
  if (state.tab === "density") renderDensity();
  if (state.tab === "corridors") renderCorridors();
  if (state.tab === "exposure") renderExposure();
}

function tooltipShow(html, event) {
  $("mapTooltip").innerHTML = html;
  $("mapTooltip").classList.remove("hidden");
  tooltipMove(event);
}
function tooltipMove(event) {
  const r = $("map").getBoundingClientRect();
  const tip = $("mapTooltip");
  tip.style.left = `${Math.min(r.width - 220, Math.max(10, event.clientX - r.left + 14))}px`;
  tip.style.top = `${Math.min(r.height - 80, Math.max(10, event.clientY - r.top + 14))}px`;
}
function tooltipHide() { $("mapTooltip").classList.add("hidden"); }

function trackColor(windowName) {
  const i = WINDOWS.indexOf(windowName);
  return WINDOW_COLORS[i >= 0 ? i : WINDOW_COLORS.length - 1];
}
function trackFeatures() {
  return (state.tracks?.features || []).filter(f => state.trackWindow === "all" || f.properties?.window === state.trackWindow);
}
function lineCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return geometry.coordinates || [];
  if (geometry.type === "MultiLineString") return (geometry.coordinates || []).flat();
  if (geometry.type === "Point") return [geometry.coordinates];
  return [];
}

const trackContinentCache = new Map();

function trackContinent(feature) {
  if (!feature || !state.world) return "—";

  const key = feature.properties?.track_id || feature;
  if (trackContinentCache.has(key)) return trackContinentCache.get(key);

  const coords = lineCoordinates(feature.geometry)
    .filter(xy => Array.isArray(xy) && xy.length >= 2 && numeric(xy[0]) && numeric(xy[1]));

  const counts = new Map();
  const continents = state.world.features || [];

  for (const xy of coords) {
    const hit = continents.find(f => {
      try { return d3.geoContains(f, [Number(xy[0]), Number(xy[1])]); }
      catch (_) { return false; }
    });
    const name = hit?.properties?.CONTINENT || hit?.properties?.continent || hit?.properties?.Continent;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }

  let result = "—";
  if (counts.size) {
    result = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } else {
    try {
      const c = d3.geoCentroid(feature);
      const hit = continents.find(f => d3.geoContains(f, c));
      result = hit?.properties?.CONTINENT || hit?.properties?.continent || hit?.properties?.Continent || "—";
    } catch (_) {}
  }

  trackContinentCache.set(key, result);
  return result;
}
function renderTracks() {
  clearDataLayers();
  const features = trackFeatures();
  setText("mapEyebrow", "GLOBAL MIGRATION");
  setText("mapTitle", state.trackWindow === "all" ? "Observed CDHW Migration Tracks" : `Observed CDHW Migration Tracks — ${state.trackWindow.replace("-", "–")}`);
  const g = state.dataZoom.append("g").attr("class", "data-layer track-layer");
  g.selectAll("path").data(features).join("path")
    .attr("class", "track-path")
    .attr("d", state.path)
    .attr("stroke", d => trackColor(d.properties?.window))
    .attr("stroke-width", 2.15)
    .attr("opacity", state.trackOpacity)
    .on("mouseenter", function(event, d) {
      d3.select(this).attr("stroke-width", 4).attr("opacity", 1);
      const p = d.properties || {};
      const continent = trackContinent(d);
      tooltipShow(`<b>${esc(continent)}</b><br>${esc(p.start_year)} · ${esc((p.window || "").replace("-", "–"))}`, event);
    })
    .on("mousemove", tooltipMove)
    .on("mouseleave", function() { d3.select(this).attr("stroke-width", 2.15).attr("opacity", state.trackOpacity); tooltipHide(); })
    .on("click", (_, d) => showTrackProfile(d));
  if (state.showTrackPoints) {
    const pts = [];
    features.forEach(f => lineCoordinates(f.geometry).forEach(xy => pts.push({ xy, p: f.properties || {} })));
    g.selectAll("circle.track-point").data(pts).join("circle")
      .attr("class", "track-point")
      .attr("cx", d => state.projection(d.xy)?.[0])
      .attr("cy", d => state.projection(d.xy)?.[1])
      .attr("r", 1.45)
      .attr("fill", d => trackColor(d.p.window))
      .attr("opacity", .78);
  }
  renderTrackLegend();
  updateTrackKpis();
  showTrackOverview(features);
  drawAnnualChart();
  setStatus(`${fmt(features.length)} tracks displayed`);
}
function renderTrackLegend() {
  $("legend").innerHTML = `<div class="legend-title">Track start window</div><div class="legend-items">${WINDOWS.map((w, i) => `<span class="legend-item"><i style="background:${WINDOW_COLORS[i]}"></i>${w.replace("-", "–")}</span>`).join("")}</div>`;
}
function updateTrackKpis() {
  const s = state.summary.tracks, features = trackFeatures();
  const lens = features.map(f => num(f.properties?.path_length_km)).filter(numeric);
  const current = state.trackWindow === "all" ? "1982–2019" : state.trackWindow.replace("-", "–");
  setKpis([
    { label: "Tracks displayed", value: fmt(features.length), note: current },
    { label: "Early-period tracks", value: fmt(s.early_count), note: "1982–2000" },
    { label: "Recent-period tracks", value: fmt(s.recent_count), note: "2001–2019" },
    { label: "Median path length", value: `${fmt(median(lens), 0)} km`, note: current },
  ]);
}

function showTrackOverview(features) {
  const rows = features || [];
  const lengths = rows.map(f => num(f.properties?.path_length_km)).filter(numeric);
  const displacements = rows.map(f => num(f.properties?.net_displacement_km)).filter(numeric);
  const positions = rows.map(f => num(f.properties?.n_positions)).filter(numeric);
  const years = [...new Set(rows.map(f => Number(f.properties?.start_year)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const directions = rows.map(f => f.properties?.direction).filter(Boolean);
  const counts = new Map();
  directions.forEach(d => counts.set(d, (counts.get(d) || 0) + 1));
  const dominant = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0];
  const longestFeature = [...rows].sort((a,b)=>(num(b.properties?.path_length_km)||0)-(num(a.properties?.path_length_km)||0))[0] || null;
  const longest = longestFeature?.properties || {};
  const longestContinent = longestFeature ? trackContinent(longestFeature) : "—";
  const label = state.trackWindow === "all" ? "GLOBAL TRACK OVERVIEW" : "WINDOW OVERVIEW";
  const title = state.trackWindow === "all" ? "Global migration statistics" : `Migration statistics — ${state.trackWindow.replace("-", "–")}`;
  setProfile(label, title, `
    <div class="profile-hero"><span>Tracks displayed</span><strong>${fmt(rows.length)}</strong><span class="class-badge">${state.trackWindow === "all" ? "1982–2019" : esc(state.trackWindow.replace("-", "–"))}</span></div>
    <div class="profile-grid">
      <div><span>Median path length</span><b>${fmt(median(lengths),0)} km</b></div>
      <div><span>Median displacement</span><b>${fmt(median(displacements),0)} km</b></div>
      <div><span>Median positions</span><b>${fmt(median(positions),0)}</b></div>
      <div><span>Start years represented</span><b>${fmt(years.length)}</b></div>
      <div><span>Dominant direction</span><b>${esc(dominant?.[0] || "—")}</b></div>
      <div><span>Longest path</span><b>${numeric(longest.path_length_km) ? `${fmt(longest.path_length_km,0)} km` : "—"}</b></div>
    </div>
    <div class="profile-section"><h4>Interactive track inspection</h4>
      <div class="profile-row"><span>Longest-track continent</span><b>${esc(longestContinent)}</b></div>
      <div class="profile-row"><span>Time span</span><b>${years.length ? `${years[0]}–${years[years.length-1]}` : "—"}</b></div>
      <div class="profile-row"><span>Most common direction</span><b>${dominant ? `${esc(dominant[0])} (${fmt(dominant[1])} tracks)` : "—"}</b></div>
    </div>
    <p class="placeholder" style="margin-top:12px">Click any migration track on the map to replace this overview with its individual trajectory profile.</p>`);
}

function showTrackProfile(feature) {
  const p = feature?.properties || {};
  const continent = trackContinent(feature);
  setProfile("TRACK PROFILE", continent === "—" ? "Migration track" : continent, `
    <div class="profile-hero"><span>Start year</span><strong>${esc(p.start_year)}</strong><span class="class-badge">${esc((p.window || "").replace("-", "–"))}</span></div>
    <div class="profile-grid">
      <div><span>Path length</span><b>${fmt(p.path_length_km,0)} km</b></div>
      <div><span>Net displacement</span><b>${fmt(p.net_displacement_km,0)} km</b></div>
      <div><span>Direction</span><b>${esc(p.direction || "—")}</b></div>
      <div><span>Bearing</span><b>${numeric(p.mean_bearing_deg) ? `${fmt(p.mean_bearing_deg,1)}°` : "—"}</b></div>
      <div><span>Track positions</span><b>${fmt(p.n_positions)}</b></div>
      <div><span>Continent</span><b>${esc(continent)}</b></div>
    </div>`);
}

function densityColor(value, max) {
  if (!numeric(value) || Number(value) <= 0 || max <= 0) return null;
  return palette(DENSITY_COLORS, Number(value) / max);
}
function changeColor(value, maxAbs) {
  if (!numeric(value) || maxAbs <= 0) return null;
  const v = Number(value);
  if (Math.abs(v) < maxAbs * .005) return null;
  return v < 0 ? palette(CHANGE_NEG, Math.abs(v) / maxAbs) : palette(CHANGE_POS, v / maxAbs);
}
function hexRgba(color, alpha = 220) {
  if (!color) return [0,0,0,0];
  const c = d3.color(color);
  return c ? [c.r, c.g, c.b, alpha] : [0,0,0,0];
}
function rasterSample(r, lon, lat) {
  if (!r || lon < r.xmin || lon > r.xmax || lat < r.ymin || lat > r.ymax) return null;
  const col = Math.max(0, Math.min(r.width - 1, Math.floor((lon - r.xmin) / (r.xmax - r.xmin) * r.width)));
  const row = Math.max(0, Math.min(r.height - 1, Math.floor((r.ymax - lat) / (r.ymax - r.ymin) * r.height)));
  const v = r.values?.[0]?.[row]?.[col];
  return numeric(v) ? Number(v) : null;
}
async function rasterImage(mode) {
  const key = `${mode}-${state.mapWidth}x${state.mapHeight}`;
  if (state.rasterImages[key]) return state.rasterImages[key];
  const r = state.rasters[mode], ds = state.summary.density;
  const scale = .58;
  const w = Math.max(500, Math.floor(state.mapWidth * scale)), h = Math.max(320, Math.floor(state.mapHeight * scale));
  const proj = d3.geoRobinson().precision(.2).fitExtent([[28*scale,24*scale],[w-28*scale,h-24*scale]], state.world);

  // First paint the raster onto a transparent off-screen canvas.
  const raw = document.createElement("canvas"); raw.width = w; raw.height = h;
  const rawCtx = raw.getContext("2d"), img = rawCtx.createImageData(w, h), a = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ll = proj.invert([x + .5, y + .5]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90 || Math.abs(ll[0]) > 180) continue;
      const v = rasterSample(r, ll[0], ll[1]);
      const color = mode === "change" ? changeColor(v, ds.change_color_abs_max) : densityColor(v, ds.density_color_max);
      if (!color) continue;
      const [rr,gg,bb,aa] = hexRgba(color, 225), i = (y*w+x)*4;
      a[i] = rr; a[i+1] = gg; a[i+2] = bb; a[i+3] = aa;
    }
  }
  rawCtx.putImageData(img,0,0);

  // Clip the raster exactly to the Robinson sphere. This prevents rectangular
  // raster edges from appearing outside the curved projection boundary.
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.beginPath();
  d3.geoPath(proj, ctx)({ type: "Sphere" });
  ctx.clip();
  ctx.drawImage(raw, 0, 0);
  ctx.restore();

  const url = canvas.toDataURL("image/png");
  state.rasterImages[key] = url;
  return url;
}

async function renderDensity() {
  clearDataLayers();
  const mode = state.densityMode, ds = state.summary.density, n = ds.native_stats;
  setText("mapEyebrow", mode === "change" ? "SPATIAL CHANGE" : "SPATIAL INTENSITY");
  if (mode === "change") {
    setText("mapTitle", "Change in Migration-Track Density, 2001–2019 minus 1982–2000");
    const img = await rasterImage("change");
    if (state.tab !== "density" || state.densityMode !== "change") return;
    state.dataZoom.append("image").attr("class", "raster-image").attr("href", img).attr("width", state.mapWidth).attr("height", state.mapHeight).attr("opacity", state.densityOpacity);
    $("legend").innerHTML = rampLegend("Change in track count", "linear-gradient(90deg,#2171b5,#bdd7e7,#f7f7f7,#fdd0a2,#a63603)", `−${fmt(ds.change_color_abs_max,1)}`, `+${fmt(ds.change_color_abs_max,1)}`);
  } else {
    const period = mode === "early" ? "1982–2000" : "2001–2019";
    setText("mapTitle", `Cumulative Migration-Track Density — ${period}`);
    const img = await rasterImage(mode);
    if (state.tab !== "density" || state.densityMode !== mode) return;
    state.dataZoom.append("image").attr("class", "raster-image").attr("href", img).attr("width", state.mapWidth).attr("height", state.mapHeight).attr("opacity", state.densityOpacity);
    $("legend").innerHTML = rampLegend("Cumulative track count", "linear-gradient(90deg,#fff7bc,#fec44f,#fe9929,#ec7014,#8c2d04)", "0", fmt(ds.density_color_max,1));
  }
  setKpis([
    { label: "Early track-count sum", value: compact(n.early.sum), note: "native grid" },
    { label: "Recent track-count sum", value: compact(n.recent.sum), note: "native grid" },
    { label: "Recent positive cells", value: fmt(n.recent.positive_cells), note: "cells with migration" },
    { label: "Maximum recent count", value: fmt(n.recent.max,1), note: "native grid" },
  ]);
  const selectedStats = mode === "early" ? n.early : mode === "recent" ? n.recent : n.change;
  const periodLabel = mode === "early" ? "1982–2000" : mode === "recent" ? "2001–2019" : "Recent − early";
  const sumChange = n.early.sum ? ((n.recent.sum - n.early.sum) / n.early.sum) * 100 : null;
  setProfile("DENSITY SUMMARY", `Migration density — ${periodLabel}`, `
    <div class="profile-hero"><span>${mode === "change" ? "Net change sum" : "Cumulative track-count sum"}</span><strong>${compact(selectedStats.sum)}</strong><span class="class-badge">${esc(periodLabel)}</span></div>
    <div class="profile-grid">
      <div><span>Maximum cell count</span><b>${fmt(selectedStats.max,1)}</b></div>
      <div><span>Mean cell value</span><b>${fmt(selectedStats.mean,2)}</b></div>
      <div><span>Positive cells</span><b>${fmt(selectedStats.positive_cells)}</b></div>
      <div><span>Median positive</span><b>${fmt(selectedStats.median_positive,2)}</b></div>
      <div><span>90th percentile</span><b>${fmt(selectedStats.p90_positive,1)}</b></div>
      <div><span>95th percentile</span><b>${fmt(selectedStats.p95_positive,1)}</b></div>
    </div>
    <div class="profile-section"><h4>Period comparison</h4>
      <div class="profile-row"><span>1982–2000 sum</span><b>${compact(n.early.sum)}</b></div>
      <div class="profile-row"><span>2001–2019 sum</span><b>${compact(n.recent.sum)}</b></div>
      <div class="profile-row"><span>Relative change</span><b>${numeric(sumChange) ? `${sumChange >= 0 ? "+" : ""}${fmt(sumChange,1)}%` : "—"}</b></div>
      <div class="profile-row"><span>Recent / early ratio</span><b>${n.early.sum ? `${fmt(n.recent.sum / n.early.sum,2)}×` : "—"}</b></div>
      <div class="profile-row"><span>Display resolution</span><b>${fmt(ds.display_resolution_deg,3)}°</b></div>
    </div>`);
  drawDensityChart();
  setStatus("Density layer ready");
}
function rampLegend(title, gradient, lo, hi) {
  return `<div class="legend-title">${esc(title)}</div><div class="ramp" style="background:${gradient}"></div><div class="ramp-labels"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>`;
}

function corridorWindowLabel() {
  return state.corridorWindow === "all" ? "1982–2019" : state.corridorWindow.replace("-", "–");
}
function corridorFeatureKey(p) {
  return `${p?.window || ""}::${p?.pathway_id || ""}`;
}
function corridorPathways(windowName) {
  const seen = new Map();
  (state.corridors?.features || []).forEach(f => {
    const p = f.properties || {};
    const key = corridorFeatureKey(p);
    if ((windowName === "all" || p.window === windowName) && p.pathway_id && !seen.has(key)) seen.set(key, p);
  });
  return [...seen.values()];
}
function corridorVisual(p) {
  if (p.feature_type === "guide_rail") return { stroke: "#29342d", strokeWidth: 1.4, strokeOpacity: .72, fill: "none", fillOpacity: 0, dash: "5 4" };
  const level = Number(p.containment_level || 90), selected = state.selectedPathway && corridorFeatureKey(p) === state.selectedPathway;
  const probabilityStyle = {
    90: { fill: "#fee8c8", opacity: .62 },
    50: { fill: "#fdbb84", opacity: .76 },
    20: { fill: "#d94701", opacity: .90 },
  }[level] || { fill: "#fdbb84", opacity: .72 };
  return {
    stroke: selected ? "#101713" : probabilityStyle.fill,
    strokeWidth: selected ? 2.3 : .9,
    strokeOpacity: selected ? 1 : .96,
    fill: probabilityStyle.fill,
    fillOpacity: selected ? 1 : probabilityStyle.opacity,
    dash: null,
  };
}
function renderCorridors() {
  clearDataLayers();
  if (!state.corridors) { setStatus("Corridor data unavailable", true); return; }
  const periodLabel = corridorWindowLabel();
  const allYears = state.corridorWindow === "all";
  setText("mapEyebrow", allYears ? "ALL-YEAR PATHWAYS" : "FIVE-YEAR PATHWAYS");
  setText("mapTitle", `CDHW Migration Corridors — ${periodLabel}`);
  const features = state.corridors.features
    .filter(f => allYears || f.properties?.window === state.corridorWindow)
    .sort((a, b) => {
      const drawOrder = p => p?.feature_type === "guide_rail" ? 3 : ({ 90: 0, 50: 1, 20: 2 }[Number(p?.containment_level)] ?? 1);
      return drawOrder(a.properties) - drawOrder(b.properties);
    });
  const g = state.dataZoom.append("g").attr("class", "data-layer corridor-layer");
  g.selectAll("path").data(features).join("path")
    .attr("class", "corridor-path")
    .attr("d", state.path)
    .attr("fill", d => corridorVisual(d.properties || {}).fill)
    .attr("fill-opacity", d => corridorVisual(d.properties || {}).fillOpacity)
    .attr("stroke", d => corridorVisual(d.properties || {}).stroke)
    .attr("stroke-width", d => corridorVisual(d.properties || {}).strokeWidth)
    .attr("stroke-opacity", d => corridorVisual(d.properties || {}).strokeOpacity)
    .attr("stroke-dasharray", d => corridorVisual(d.properties || {}).dash)
    .on("mouseenter", (event, d) => {
      const p = d.properties || {};
      const envelope = p.feature_type === "guide_rail" ? "Directional guide rail" : `${fmt(p.containment_level)}% containment envelope`;
      tooltipShow(`<b>${esc(p.pathway_id || "Pathway")}</b><br>${esc(envelope)}<br>${fmt(p.associated_events)} associated events`, event);
    })
    .on("mousemove", tooltipMove)
    .on("mouseleave", tooltipHide)
    .on("click", (_, d) => { state.selectedPathway = corridorFeatureKey(d.properties || {}); showCorridorProfile(d.properties || {}); renderCorridors(); });
  const paths = corridorPathways(state.corridorWindow);
  const lengths = paths.map(p => num(p.data_path_length_km)).filter(numeric);
  const widths = paths.map(p => num(p.median_width50_km)).filter(numeric);
  const assoc = paths.reduce((s,p) => s + (num(p.associated_events) || 0), 0);
  setKpis([
    { label: "Pathways", value: fmt(paths.length), note: periodLabel },
    { label: "Associated events", value: fmt(assoc), note: "pathway totals" },
    { label: "Median pathway length", value: `${fmt(median(lengths),0)} km`, note: periodLabel },
    { label: "Median 50% width", value: `${fmt(median(widths),0)} km`, note: "corridor concentration" },
  ]);
  $("legend").innerHTML = `<div class="legend-title">Containment envelopes · ${periodLabel}</div><div class="legend-items"><span class="legend-item"><i style="height:10px;background:#fee8c8"></i>90%</span><span class="legend-item"><i style="height:10px;background:#fdbb84"></i>50%</span><span class="legend-item"><i style="height:10px;background:#d94701"></i>20%</span></div>`;
  if (!state.selectedPathway) showCorridorOverview(paths);
  drawCorridorChart(paths);
  setStatus(`${fmt(paths.length)} pathways in ${periodLabel}`);
}
function showCorridorOverview(paths) {
  const rows = paths || [];
  const lengths = rows.map(p => num(p.data_path_length_km)).filter(numeric);
  const w20 = rows.map(p => num(p.median_width20_km)).filter(numeric);
  const w50 = rows.map(p => num(p.median_width50_km)).filter(numeric);
  const w90 = rows.map(p => num(p.median_width90_km)).filter(numeric);
  const transitions = rows.map(p => num(p.transition_probability)).filter(numeric);
  const dominance = rows.map(p => num(p.directional_dominance)).filter(numeric);
  const associated = rows.reduce((sum,p) => sum + (num(p.associated_events) || 0), 0);
  const directions = new Map();
  rows.forEach(p => { if (p.direction) directions.set(p.direction, (directions.get(p.direction)||0)+1); });
  const dominant = [...directions.entries()].sort((a,b)=>b[1]-a[1])[0];
  const top = [...rows].sort((a,b)=>(num(b.associated_events)||0)-(num(a.associated_events)||0))[0] || {};
  const periodLabel = corridorWindowLabel();
  setProfile("CORRIDOR SUMMARY", `Corridor statistics — ${periodLabel}`, `
    <div class="profile-hero"><span>Migration pathways</span><strong>${fmt(rows.length)}</strong><span class="class-badge">${esc(periodLabel)}</span></div>
    <div class="profile-grid">
      <div><span>Associated events</span><b>${fmt(associated)}</b></div>
      <div><span>Median path length</span><b>${fmt(median(lengths),0)} km</b></div>
      <div><span>Median 20% width</span><b>${fmt(median(w20),0)} km</b></div>
      <div><span>Median 50% width</span><b>${fmt(median(w50),0)} km</b></div>
      <div><span>Median 90% width</span><b>${fmt(median(w90),0)} km</b></div>
      <div><span>Dominant direction</span><b>${esc(dominant?.[0] || "—")}</b></div>
    </div>
    <div class="profile-section"><h4>Pathway organization</h4>
      <div class="profile-row"><span>Median directional dominance</span><b>${pct(median(dominance))}</b></div>
      <div class="profile-row"><span>Median transition probability</span><b>${pct(median(transitions))}</b></div>
      <div class="profile-row"><span>Most active pathway</span><b>${esc(top.pathway_id || "—")}</b></div>
      <div class="profile-row"><span>Events on most active pathway</span><b>${fmt(top.associated_events)}</b></div>
    </div>
    <p class="placeholder" style="margin-top:12px">Click any corridor on the map to replace this summary with its individual pathway profile.</p>`);
}

function showCorridorProfile(p) {
  setProfile("CORRIDOR PROFILE", p.pathway_id || "Migration corridor", `
    <div class="profile-hero"><span>Five-year window</span><strong>${esc((p.window || "—").replace("-", "–"))}</strong><span class="class-badge">Rank ${fmt(p.rank)}</span></div>
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
    </div>`);
}
function toggleCorridorAnimation() {
  if (state.corridorTimer) { stopCorridorAnimation(); return; }
  $("animateCorridors").classList.add("playing");
  $("animateCorridors").textContent = "■ Stop animation";
  state.corridorTimer = setInterval(() => {
    let i = WINDOWS.indexOf(state.corridorWindow);
    state.corridorWindow = WINDOWS[(i + 1) % WINDOWS.length];
    $("corridorWindow").value = state.corridorWindow;
    state.selectedPathway = null;
    if (state.tab === "corridors") renderCorridors();
  }, 1400);
}
function stopCorridorAnimation() {
  if (state.corridorTimer) clearInterval(state.corridorTimer);
  state.corridorTimer = null;
  if ($("animateCorridors")) { $("animateCorridors").classList.remove("playing"); $("animateCorridors").textContent = "▶ Animate windows"; }
}

function exposureFeatures() {
  const feats = state.exposure?.features || [];
  // A malformed/reversed spherical polygon can be interpreted by d3-geo as
  // "the whole globe except this region". Such a feature paints the entire
  // Robinson sphere with one exposure color. ADM1 units are far smaller than
  // a hemisphere, so reject only impossible spherical areas.
  return feats.filter(f => {
    try {
      const a = d3.geoArea(f);
      return Number.isFinite(a) && a >= 0 && a < 0.5;
    } catch (_) {
      return false;
    }
  });
}
function metricValue(p) { return num(p?.[state.exposureMetric]); }
function migrationValue(p) { return num(p?.[state.migrationField]); }
function transformedMetric(v) { return METRICS[state.exposureMetric].transform(v); }
function tertile(value, q1, q2) { if (!numeric(value)) return null; return Number(value) <= q1 ? 0 : Number(value) <= q2 ? 1 : 2; }
function exposureBreaks() { const vals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric); return [quantile(vals, 1/3), quantile(vals, 2/3)]; }
function migrationBreaks() { let vals = exposureFeatures().map(f => migrationValue(f.properties || {})).filter(numeric); const pos = vals.filter(v => v > 0); if (pos.length >= 3) vals = pos; return [quantile(vals, 1/3), quantile(vals, 2/3)]; }
function bivarIndex(migration, exposure, mb, eb) { const x = tertile(migration, mb[0], mb[1]), y = tertile(exposure, eb[0], eb[1]); return x === null || y === null ? null : y * 3 + x; }
function exposureFill(p, eb, mb, singleRange) {
  const v = metricValue(p); if (!numeric(v)) return "#f4f2ea";
  if (state.exposureMode === "joint") { const idx = bivarIndex(migrationValue(p), v, mb, eb); return idx === null ? "#efeee8" : BIVAR_COLORS[idx]; }
  const tv = transformedMetric(v);
  const lo = singleRange?.[0] ?? tv, hi = singleRange?.[1] ?? tv;
  return palette(SINGLE_COLORS, (tv - lo) / Math.max(hi - lo, 1e-12));
}
function renderExposure() {
  clearDataLayers();
  if (!state.exposure) { setStatus("Exposure data unavailable", true); return; }
  const def = METRICS[state.exposureMetric], eb = exposureBreaks(), mb = migrationBreaks();
  const singleVals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric);
  const displayVals = singleVals.map(transformedMetric).filter(numeric);
  const singleRange = [quantile(displayVals, .03), quantile(displayVals, .97)];
  setText("mapEyebrow", state.exposureMode === "joint" ? "BIVARIATE EXPOSURE" : "ADM1 EXPOSURE");
  setText("mapTitle", state.exposureMode === "joint" ? `${MIGRATION_FIELDS[state.migrationField]} × ${def.title}` : def.title);
  const g = state.dataZoom.append("g").attr("class", "data-layer");
  g.selectAll("path").data(exposureFeatures()).join("path")
    .attr("class", "exposure-region")
    .attr("d", state.path)
    .attr("fill", d => exposureFill(d.properties || {}, eb, mb, singleRange))
    .attr("fill-opacity", .97)
    .attr("stroke", "#737b74")
    .attr("stroke-width", .62)
    .on("mouseenter", function(event, d) { d3.select(this).attr("stroke", "#1f2b23").attr("stroke-width", 1.5); const p = d.properties || {}; tooltipShow(`<b>${esc(p.shapeName || "ADM1")}</b><br>${esc(def.title)}: ${esc(def.format(metricValue(p)))}`, event); })
    .on("mousemove", tooltipMove)
    .on("mouseleave", function() { d3.select(this).attr("stroke", "#737b74").attr("stroke-width", .62); tooltipHide(); })
    .on("click", (_, d) => showExposureProfile(d.properties || {}, eb, mb));
  renderExposureLegend(def); updateExposureKpis(def, eb, mb); drawExposureChart(def, mb);
  showExposureOverview(def, eb, mb);
  setStatus(`${fmt(exposureFeatures().length)} ADM1 regions`);
}
function showExposureOverview(def, eb, mb) {
  const feats = exposureFeatures();
  const vals = feats.map(f => metricValue(f.properties || {})).filter(numeric);
  const migration = feats.map(f => migrationValue(f.properties || {})).filter(numeric);
  const highHigh = feats.filter(f => bivarIndex(migrationValue(f.properties||{}), metricValue(f.properties||{}), mb, eb) === 8).length;
  const valid = vals.length;
  setProfile("GLOBAL EXPOSURE SUMMARY", def.title, `
    <div class="profile-hero"><span>Valid ADM1 regions</span><strong>${fmt(valid)}</strong><span class="class-badge">${fmt(feats.length)} total regions</span></div>
    <div class="profile-grid">
      <div><span>Median exposure</span><b>${esc(def.format(median(vals)))}</b></div>
      <div><span>33rd percentile</span><b>${esc(def.format(eb[0]))}</b></div>
      <div><span>66th percentile</span><b>${esc(def.format(eb[1]))}</b></div>
      <div><span>High–high regions</span><b>${fmt(highHigh)}</b></div>
      <div><span>Median migration burden</span><b>${fmt(median(migration),2)}</b></div>
      <div><span>Regions with data</span><b>${fmt(valid)}</b></div>
    </div>
    <div class="profile-section"><h4>Joint-class thresholds</h4>
      <div class="profile-row"><span>Exposure 33rd / 66th</span><b>${esc(def.format(eb[0]))} / ${esc(def.format(eb[1]))}</b></div>
      <div class="profile-row"><span>Migration 33rd / 66th</span><b>${fmt(mb[0],2)} / ${fmt(mb[1],2)}</b></div>
    </div>
    <p class="placeholder" style="margin-top:12px">Click an ADM1 region to replace this global summary with its regional migration–exposure profile.</p>`);
}

function renderExposureLegend(def) {
  const vals = exposureFeatures().map(f => metricValue(f.properties || {})).filter(numeric);
  const q33 = quantile(vals, 1/3), q66 = quantile(vals, 2/3);
  if (state.exposureMode === "single") {
    if (state.exposureMetric === "GDP") {
      const positive = vals.filter(v => v > 0);
      const lo = quantile(positive, .03), hi = quantile(positive, .97);
      const e0 = Math.ceil(Math.log10(Math.max(lo, 1)));
      const e1 = Math.floor(Math.log10(Math.max(hi, 1)));
      const ticks = [];
      for (let e = e0; e <= e1; e++) ticks.push(`<span>${powerLabel(e)}</span>`);
      $("legend").innerHTML = `<div class="legend-title">${esc(def.title)} · logarithmic scale</div>
        <div class="ramp" style="background:linear-gradient(90deg,#ffffe5,#fee391,#fe9929,#ec7014,#993404)"></div>
        <div class="ramp-labels log-ramp-labels">${ticks.join("")}</div>
        <div class="threshold-note"><b>33rd:</b> ${esc(def.format(q33))} &nbsp; <b>66th:</b> ${esc(def.format(q66))}</div>`;
    } else {
      const lo = quantile(vals, .03), hi = quantile(vals, .97);
      $("legend").innerHTML = `${rampLegend(def.title, "linear-gradient(90deg,#ffffe5,#fee391,#fe9929,#ec7014,#993404)", def.format(lo), def.format(hi))}
        <div class="threshold-note"><b>33rd:</b> ${esc(def.format(q33))} &nbsp; <b>66th:</b> ${esc(def.format(q66))}</div>`;
    }
    return;
  }
  const cells = [];
  for (let y = 2; y >= 0; y--) for (let x = 0; x < 3; x++) cells.push(`<i style="background:${BIVAR_COLORS[y*3+x]}"></i>`);
  $("legend").innerHTML = `<div class="legend-title">${esc(def.title)} × ${esc(MIGRATION_FIELDS[state.migrationField])}</div>
    <div class="bivar-axis-layout">
      <div class="bivar-y-axis">
        <span>HIGH</span>
        <b>${esc(def.axisTitle || def.title)}</b>
        <span>LOW</span>
      </div>
      <div class="bivar-matrix-wrap">
        <div class="bivar-legend">${cells.join("")}</div>
        <div class="bivar-x-axis">
          <span>LOW</span>
          <b>Migration burden</b>
          <span>HIGH</span>
        </div>
      </div>
    </div>`;
}

function updateExposureKpis(def, eb, mb) {
  const feats = exposureFeatures(), vals = feats.map(f => metricValue(f.properties || {})).filter(numeric), highHigh = feats.filter(f => bivarIndex(migrationValue(f.properties||{}), metricValue(f.properties||{}), mb, eb) === 8).length, recent = feats.map(f => num(f.properties?.TRK_RECENT)).filter(numeric);
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
  setProfile("ADM1 REGION PROFILE", `${p.shapeName || "Region"}${p.shapeGroup ? `, ${p.shapeGroup}` : ""}`, `
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
      <div class="profile-row"><span>GDP (2017 international $, PPP)</span><b>${METRICS.GDP.format(num(p.GDP))}</b></div>
      <div class="profile-row"><span>Critical infrastructure index</span><b>${METRICS.CISI_NORM.format(num(p.CISI_NORM))}</b></div>
    </div>`);
}

function destroyChart() { if (state.chart) { state.chart.destroy(); state.chart = null; } }
function chartBaseOptions() {
  return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: "#677069", font: { size: 9 } } }, y: { beginAtZero: true, grid: { color: "rgba(100,110,100,.12)" }, ticks: { color: "#677069", font: { size: 9 } } } } };
}
function drawAnnualChart() {
  destroyChart(); setText("chartEyebrow", "TEMPORAL DISTRIBUTION"); setText("chartTitle", "Annual CDHW Migration Events");
  const a = state.summary.tracks.annual;
  state.chart = new Chart($("sideChart"), { type: "line", data: { labels: a.map(d => d.year), datasets: [{ data: a.map(d => d.events), borderColor: "#8b2f24", backgroundColor: "rgba(207,107,52,.12)", fill: true, tension: .22, pointRadius: 1.6, borderWidth: 2 }] }, options: chartBaseOptions() });
}
function drawDensityChart() {
  destroyChart(); setText("chartEyebrow", "PERIOD COMPARISON"); setText("chartTitle", "Cumulative Migration-Track Count");
  const n = state.summary.density.native_stats;
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: ["1982–2000", "2001–2019"], datasets: [{ data: [n.early.sum, n.recent.sum], backgroundColor: ["#dfad69", "#9a4b31"] }] }, options: chartBaseOptions() });
}
function drawCorridorChart(paths) {
  destroyChart(); setText("chartEyebrow", "PATHWAY ACTIVITY"); setText("chartTitle", `Associated Events — ${corridorWindowLabel()}`);
  const rows = [...paths].sort((a,b)=>(num(b.associated_events)||0)-(num(a.associated_events)||0)).slice(0,10);
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: rows.map(p => String(p.pathway_id||"").replace(/^.*_P/,"P")), datasets: [{ data: rows.map(p=>num(p.associated_events)||0), backgroundColor: rows.map(p=>p.pathway_color||"#cf6b34") }] }, options: chartBaseOptions() });
}
function drawExposureChart(def, mb) {
  destroyChart(); setText("chartEyebrow", "MIGRATION–EXPOSURE GRADIENT"); setText("chartTitle", `${def.title} by Migration-Burden Class`);
  const groups = [[],[],[]];
  exposureFeatures().forEach(f => { const p=f.properties||{}, m=migrationValue(p), v=metricValue(p); if(!numeric(m)||!numeric(v)) return; const g=tertile(m,mb[0],mb[1]); groups[g].push(transformedMetric(v)); });
  state.chart = new Chart($("sideChart"), { type: "bar", data: { labels: ["Low", "Moderate", "High"], datasets: [{ data: groups.map(g=>median(g)), backgroundColor: ["#b9d4cf", "#b69a77", "#681b3b"] }] }, options: chartBaseOptions() });
}
