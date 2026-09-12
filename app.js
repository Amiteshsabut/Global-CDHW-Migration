"use strict";

const WINDOWS = [
  "1982-1986", "1987-1991", "1992-1996", "1997-2001",
  "2002-2006", "2007-2011", "2012-2016", "2017-2019"
];
const WINDOW_LABELS = WINDOWS.map(w => w.replace("-", "–"));
const WINDOW_COLORS = [
  "#fff7bc", "#fee391", "#fec44f", "#fe9929",
  "#ec7014", "#e6550d", "#cb181d", "#7f0000"
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
  CROPLAND: { title: "Cropland", transform: v => v * 100, format: v => `${fmt(v * 100, 1)}%` },
  PASTURE: { title: "Pasture", transform: v => v * 100, format: v => `${fmt(v * 100, 1)}%` },
  POP2000: { title: "Population (2000)", transform: v => v, format: v => compact(v) },
  GDP: { title: "GDP (2017 international $, PPP)", transform: v => v, format: v => currencyCompact(v) },
  CISI_NORM: { title: "Critical Infrastructure Exposure Index", transform: v => v, format: v => fmt(v, 2) },
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
  leftZoom: null,
  rightZoom: null,
  fullZoom: null,
  overlay: null,
  zoom: null,
  zoomTransform: d3.zoomIdentity,
  mapWidth: 1200,
  mapHeight: 720,
  split: 50,
  trackA: 0,
  trackB: 7,
  trackOpacity: .82,
  showTrackPoints: false,
  densityMode: "compare",
  densityOpacity: .88,
  corridorIndex: 0,
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
function setText(id, value) { $(id).textContent = value; }
function setStatus(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function windowLabel(i) { return WINDOW_LABELS[Math.max(0, Math.min(7, Number(i) || 0))]; }

window.addEventListener("DOMContentLoaded", init);

async function init() {
  buildCorridorTicks();
  bindUI();
  setupMapFramework();
  try {
    setStatus("Loading dashboard data…");
    state.summary = await fetchJSON("data/summary.json");
    state.world = await fetchJSON(state.summary.files.world || "data/world_continents.geojson");
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
  const defs = state.svg.append("defs");
  defs.append("clipPath").attr("id", "leftClip").append("rect").attr("id", "leftClipRect");
  defs.append("clipPath").attr("id", "rightClip").append("rect").attr("id", "rightClipRect");
  state.baseZoom = state.svg.append("g").attr("class", "base-zoom");
  state.leftZoom = state.svg.append("g").attr("clip-path", "url(#leftClip)").append("g").attr("class", "left-zoom");
  state.rightZoom = state.svg.append("g").attr("clip-path", "url(#rightClip)").append("g").attr("class", "right-zoom");
  state.fullZoom = state.svg.append("g").attr("class", "full-zoom");
  state.overlay = state.svg.append("g").attr("class", "ui-overlay");

  state.zoom = d3.zoom().scaleExtent([1, 10]).on("zoom", event => {
    state.zoomTransform = event.transform;
    [state.baseZoom, state.leftZoom, state.rightZoom, state.fullZoom].forEach(g => g.attr("transform", event.transform));
  });
  state.svg.call(state.zoom).on("dblclick.zoom", null);

  $("zoomIn").addEventListener("click", () => state.svg.transition().duration(250).call(state.zoom.scaleBy, 1.35));
  $("zoomOut").addEventListener("click", () => state.svg.transition().duration(250).call(state.zoom.scaleBy, 1 / 1.35));
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
  updateClipRects();
  resetZoom(false);
  render();
}

function drawBaseMap() {
  state.baseZoom.selectAll("*").remove();
  state.baseZoom.append("path").datum({type:"Sphere"}).attr("class", "map-sphere").attr("d", state.path);
  state.baseZoom.append("path").datum(d3.geoGraticule10()).attr("class", "graticule").attr("d", state.path);
  state.baseZoom.append("g").selectAll("path").data(state.world.features || []).join("path")
    .attr("class", "continent").attr("d", state.path);
}

function resetZoom(animate = true) {
  const t = animate ? state.svg.transition().duration(350) : state.svg;
  t.call(state.zoom.transform, d3.zoomIdentity);
}

function fitRegion(name) {
  if (!state.world) return;
  if (name === "Global") { resetZoom(); return; }
  const features = (state.world.features || []).filter(f => f.properties?.CONTINENT === name);
  if (!features.length) return;
  const fc = { type:"FeatureCollection", features };
  const [[x0,y0],[x1,y1]] = state.path.bounds(fc);
  const dx = Math.max(1, x1-x0), dy = Math.max(1, y1-y0);
  const s = Math.min(8, .88 / Math.max(dx/state.mapWidth, dy/state.mapHeight));
  const tx = state.mapWidth/2 - s*(x0+x1)/2;
  const ty = state.mapHeight/2 - s*(y0+y1)/2;
  state.svg.transition().duration(450).call(state.zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(s));
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

  $("trackWindowA").addEventListener("input", e => {
    state.trackA = Number(e.target.value); setText("trackWindowALabel", windowLabel(state.trackA)); if (state.tab === "tracks") renderTracks();
  });
  $("trackWindowB").addEventListener("input", e => {
    state.trackB = Number(e.target.value); setText("trackWindowBLabel", windowLabel(state.trackB)); if (state.tab === "tracks") renderTracks();
  });
  $("trackOpacity").addEventListener("input", e => {
    state.trackOpacity = Number(e.target.value)/100; setText("trackOpacityValue", `${e.target.value}%`); if (state.tab === "tracks") renderTracks();
  });
  $("showTrackPoints").addEventListener("change", e => { state.showTrackPoints = e.target.checked; if (state.tab === "tracks") renderTracks(); });

  document.querySelectorAll("#densityMode button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll("#densityMode button").forEach(b => b.classList.remove("active")); btn.classList.add("active");
    state.densityMode = btn.dataset.density; if (state.tab === "density") renderDensity();
  }));
  $("densityOpacity").addEventListener("input", e => {
    state.densityOpacity = Number(e.target.value)/100; setText("densityOpacityValue", `${e.target.value}%`); if (state.tab === "density") renderDensity();
  });

  $("corridorWindow").addEventListener("input", e => {
    state.corridorIndex = Number(e.target.value); state.selectedPathway = null; setText("corridorWindowLabel", windowLabel(state.corridorIndex)); if (state.tab === "corridors") renderCorridors();
  });
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

function buildCorridorTicks() {
  $("corridorTicks").innerHTML = WINDOWS.map((w,i) => `<span>${i===0?"1982":i===7?"2019":"•"}</span>`).join("");
}

function showControls(tab) {
  ["trackControls","densityControls","corridorControls","exposureControls"].forEach(id => $(id).classList.add("hidden"));
  const target = {tracks:"trackControls",density:"densityControls",corridors:"corridorControls",exposure:"exposureControls"}[tab];
  if (target) $(target).classList.remove("hidden");
}
function clearDataLayers() {
  [state.leftZoom,state.rightZoom,state.fullZoom].forEach(g => g.selectAll("*").remove());
  state.overlay.selectAll("*").remove();
}
function render() {
  if (!state.summary || !state.world || !state.path) return;
  showControls(state.tab);
  if (state.tab === "tracks") renderTracks();
  if (state.tab === "density") renderDensity();
  if (state.tab === "corridors") renderCorridors();
  if (state.tab === "exposure") renderExposure();
}

function setKpis(items) {
  items.forEach((x,i) => { setText(`kpi${i+1}Label`,x.label); setText(`kpi${i+1}Value`,x.value); setText(`kpi${i+1}Note`,x.note||""); });
}
function setProfile(eyebrow,title,html) { setText("profileEyebrow",eyebrow); setText("profileTitle",title); $("profileBody").innerHTML=html; }
function tooltipShow(html,event) {
  const el=$("mapTooltip"); el.innerHTML=html; el.classList.remove("hidden");
  el.style.left=`${Math.min(window.innerWidth-280,event.clientX+14)}px`; el.style.top=`${Math.min(window.innerHeight-120,event.clientY+14)}px`;
}
function tooltipMove(event) {
  const el=$("mapTooltip"); if(el.classList.contains("hidden")) return;
  el.style.left=`${Math.min(window.innerWidth-280,event.clientX+14)}px`; el.style.top=`${Math.min(window.innerHeight-120,event.clientY+14)}px`;
}
function tooltipHide(){ $("mapTooltip").classList.add("hidden"); }

function updateClipRects() {
  const x = state.mapWidth * state.split / 100;
  d3.select("#leftClipRect").attr("x",0).attr("y",0).attr("width",x).attr("height",state.mapHeight);
  d3.select("#rightClipRect").attr("x",x).attr("y",0).attr("width",state.mapWidth-x).attr("height",state.mapHeight);
}
function updateSwipePosition() {
  updateClipRects();
  const x=state.mapWidth*state.split/100, y=state.mapHeight/2;
  state.overlay.select(".swipe-line").attr("x1",x).attr("x2",x);
  state.overlay.select(".swipe-handle").attr("cx",x).attr("cy",y);
  state.overlay.select(".swipe-text").attr("x",x).attr("y",y+4);
}
function drawSwipeDivider(leftLabel,rightLabel) {
  updateClipRects();
  const x=state.mapWidth*state.split/100, y=state.mapHeight/2;
  state.overlay.append("line").attr("class","swipe-line").attr("x1",x).attr("x2",x).attr("y1",0).attr("y2",state.mapHeight);
  const handle=state.overlay.append("circle").attr("class","swipe-handle").attr("cx",x).attr("cy",y).attr("r",18);
  state.overlay.append("text").attr("class","swipe-text").attr("x",x).attr("y",y+4).text("↔");
  state.overlay.append("text").attr("class","swipe-label").attr("x",16).attr("y",28).text(leftLabel);
  state.overlay.append("text").attr("class","swipe-label").attr("x",state.mapWidth-16).attr("y",28).attr("text-anchor","end").text(rightLabel);
  const drag=d3.drag().on("drag",event=>{
    state.split=Math.max(8,Math.min(92,100*event.x/state.mapWidth));
    updateSwipePosition();
  });
  handle.call(drag);
  state.overlay.select(".swipe-line").call(drag);
}

function renderTrackLegend() {
  const a=WINDOWS[state.trackA], b=WINDOWS[state.trackB];
  $("legend").innerHTML=`<div class="legend-title">Track start window</div><div class="legend-items">${WINDOWS.map((w,i)=>`<span class="legend-item ${(w===a||w===b)?"active-window":""}"><i style="background:${WINDOW_COLORS[i]}"></i>${WINDOW_LABELS[i]}</span>`).join("")}</div>`;
}
function trackWindowFeatures(index){ const w=WINDOWS[index]; return (state.tracks?.features||[]).filter(f=>f.properties?.window===w); }
function drawTrackLayer(group,features,index) {
  const color=WINDOW_COLORS[index];
  const g=group.append("g").attr("class","data-layer track-layer");
  g.selectAll("path").data(features).join("path")
    .attr("class","track-path").attr("d",state.path).attr("stroke",color).attr("stroke-width",2.25).attr("opacity",state.trackOpacity)
    .on("mouseenter",function(event,d){d3.select(this).attr("stroke-width",4.2).attr("opacity",1); const p=d.properties||{}; tooltipShow(`<b>${esc(p.track_id||"Track")}</b><br>${esc(p.start_year)} · ${esc(p.window||"")}`,event);})
    .on("mousemove",tooltipMove).on("mouseleave",function(){d3.select(this).attr("stroke-width",2.25).attr("opacity",state.trackOpacity);tooltipHide();})
    .on("click",(_,d)=>showTrackProfile(d.properties||{}));
  if(state.showTrackPoints){
    const pts=[];
    features.forEach(f=>lineCoordinates(f.geometry).forEach(xy=>pts.push({xy,p:f.properties||{}})));
    g.selectAll("circle.track-point").data(pts).join("circle").attr("class","track-point")
      .attr("cx",d=>state.projection(d.xy)?.[0]).attr("cy",d=>state.projection(d.xy)?.[1]).attr("r",1.4).attr("fill",color).attr("opacity",.75);
  }
}
function lineCoordinates(geometry){
  if(!geometry) return [];
  if(geometry.type==="LineString") return geometry.coordinates||[];
  if(geometry.type==="MultiLineString") return (geometry.coordinates||[]).flat();
  if(geometry.type==="Point") return [geometry.coordinates];
  return [];
}
function renderTracks() {
  clearDataLayers();
  const fa=trackWindowFeatures(state.trackA), fb=trackWindowFeatures(state.trackB);
  drawTrackLayer(state.leftZoom,fa,state.trackA); drawTrackLayer(state.rightZoom,fb,state.trackB);
  drawSwipeDivider(windowLabel(state.trackA),windowLabel(state.trackB));
  setText("mapEyebrow","FIVE-YEAR COMPARISON");
  setText("mapTitle",`CDHW Migration Tracks — ${windowLabel(state.trackA)} vs ${windowLabel(state.trackB)}`);
  renderTrackLegend();
  const lens=[...fa,...fb].map(f=>num(f.properties?.path_length_km)).filter(numeric);
  const diff=fb.length-fa.length;
  setKpis([
    {label:"Window A tracks",value:fmt(fa.length),note:windowLabel(state.trackA)},
    {label:"Window B tracks",value:fmt(fb.length),note:windowLabel(state.trackB)},
    {label:"Track difference",value:`${diff>0?"+":""}${fmt(diff)}`,note:"B minus A"},
    {label:"Median path length",value:`${fmt(median(lens),0)} km`,note:"selected windows"},
  ]);
  setProfile("TRACK PROFILE","Select a migration track",`<p class="placeholder">Drag the center divider to compare the two five-year windows. Click any track to inspect its path length, displacement, direction, bearing, and number of positions.</p>`);
  drawAnnualChart(); setStatus(`${fmt(fa.length+fb.length)} tracks in the two selected windows`);
}
function showTrackProfile(p){
  setProfile("TRACK PROFILE",p.track_id||"Migration track",`
    <div class="profile-hero"><span>Start year</span><strong>${esc(p.start_year)}</strong><span class="class-badge">${esc((p.window||"").replace("-","–"))}</span></div>
    <div class="profile-grid">
      <div><span>Path length</span><b>${fmt(p.path_length_km,0)} km</b></div><div><span>Net displacement</span><b>${fmt(p.net_displacement_km,0)} km</b></div>
      <div><span>Direction</span><b>${esc(p.direction||"—")}</b></div><div><span>Bearing</span><b>${numeric(p.mean_bearing_deg)?`${fmt(p.mean_bearing_deg,1)}°`:"—"}</b></div>
      <div><span>Track positions</span><b>${fmt(p.n_positions)}</b></div><div><span>Track ID</span><b>${esc(p.track_id||"—")}</b></div>
    </div>`);
}

function densityColor(value,max){ if(!numeric(value)||Number(value)<=0||max<=0)return null; return palette(DENSITY_COLORS,Number(value)/max); }
function changeColor(value,maxAbs){
  if(!numeric(value)||maxAbs<=0)return null; const v=Number(value); if(Math.abs(v)<maxAbs*.005)return null;
  return v<0?palette(CHANGE_NEG,Math.abs(v)/maxAbs):palette(CHANGE_POS,v/maxAbs);
}
function hexRgba(color,alpha=220){ if(!color)return [0,0,0,0]; const c=d3.color(color); return c?[c.r,c.g,c.b,alpha]:[0,0,0,0]; }
function rasterSample(r,lon,lat){
  if(!r||lon<r.xmin||lon>r.xmax||lat<r.ymin||lat>r.ymax)return null;
  const col=Math.max(0,Math.min(r.width-1,Math.floor((lon-r.xmin)/(r.xmax-r.xmin)*r.width)));
  const row=Math.max(0,Math.min(r.height-1,Math.floor((r.ymax-lat)/(r.ymax-r.ymin)*r.height)));
  const v=r.values?.[0]?.[row]?.[col]; return numeric(v)?Number(v):null;
}
async function rasterImage(mode){
  const key=`${mode}-${state.mapWidth}x${state.mapHeight}`; if(state.rasterImages[key])return state.rasterImages[key];
  const r=state.rasters[mode], ds=state.summary.density;
  const s=.56, w=Math.max(500,Math.floor(state.mapWidth*s)), h=Math.max(320,Math.floor(state.mapHeight*s));
  const proj=d3.geoRobinson().precision(.2).fitExtent([[28*s,24*s],[w-28*s,h-24*s]],state.world);
  const canvas=document.createElement("canvas"); canvas.width=w; canvas.height=h; const ctx=canvas.getContext("2d"); const img=ctx.createImageData(w,h); const a=img.data;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const ll=proj.invert([x+.5,y+.5]); if(!ll)continue;
      const v=rasterSample(r,ll[0],ll[1]); const color=mode==="change"?changeColor(v,ds.change_color_abs_max):densityColor(v,ds.density_color_max); if(!color)continue;
      const [rr,gg,bb,aa]=hexRgba(color,225),i=(y*w+x)*4; a[i]=rr;a[i+1]=gg;a[i+2]=bb;a[i+3]=aa;
    }
  }
  ctx.putImageData(img,0,0); const url=canvas.toDataURL("image/png"); state.rasterImages[key]=url; return url;
}
async function renderDensity(){
  clearDataLayers();
  const ds=state.summary.density, n=ds.native_stats;
  if(state.densityMode==="compare"){
    setText("mapEyebrow","PERIOD COMPARISON"); setText("mapTitle","Migration-Track Density — 1982–2000 vs 2001–2019");
    const [early,recent]=await Promise.all([rasterImage("early"),rasterImage("recent")]); if(state.tab!=="density"||state.densityMode!=="compare")return;
    state.leftZoom.append("image").attr("class","raster-image").attr("href",early).attr("width",state.mapWidth).attr("height",state.mapHeight).attr("opacity",state.densityOpacity);
    state.rightZoom.append("image").attr("class","raster-image").attr("href",recent).attr("width",state.mapWidth).attr("height",state.mapHeight).attr("opacity",state.densityOpacity);
    drawSwipeDivider("1982–2000","2001–2019");
    $("legend").innerHTML=rampLegend("Cumulative migration-track count","linear-gradient(90deg,#fff7bc,#fec44f,#fe9929,#ec7014,#8c2d04)","0",fmt(ds.density_color_max,1));
  } else {
    setText("mapEyebrow","SPATIAL CHANGE"); setText("mapTitle","Change in Migration-Track Density — 2001–2019 minus 1982–2000");
    const img=await rasterImage("change"); if(state.tab!=="density"||state.densityMode!=="change")return;
    state.fullZoom.append("image").attr("class","raster-image").attr("href",img).attr("width",state.mapWidth).attr("height",state.mapHeight).attr("opacity",state.densityOpacity);
    $("legend").innerHTML=rampLegend("Change in track count","linear-gradient(90deg,#2171b5,#bdd7e7,#f7f7f7,#fdd0a2,#a63603)",`−${fmt(ds.change_color_abs_max,1)}`,`+${fmt(ds.change_color_abs_max,1)}`);
  }
  setKpis([
    {label:"Early track-count sum",value:compact(n.early.sum),note:"1982–2000"},{label:"Recent track-count sum",value:compact(n.recent.sum),note:"2001–2019"},
    {label:"Recent positive cells",value:fmt(n.recent.positive_cells),note:"cells with migration"},{label:"Recent maximum",value:fmt(n.recent.max,1),note:"native grid"}
  ]);
  setProfile("DENSITY SUMMARY","Migration-track density",`<div class="profile-section"><h4>Period comparison</h4><div class="profile-row"><span>1982–2000 sum</span><b>${compact(n.early.sum)}</b></div><div class="profile-row"><span>2001–2019 sum</span><b>${compact(n.recent.sum)}</b></div><div class="profile-row"><span>Recent maximum</span><b>${fmt(n.recent.max,1)}</b></div><div class="profile-row"><span>Display resolution</span><b>${fmt(ds.display_resolution_deg,3)}°</b></div></div>`);
  drawDensityChart(); setStatus("Density layer ready");
}
function rampLegend(title,gradient,lo,hi){return `<div class="legend-title">${esc(title)}</div><div class="ramp" style="background:${gradient}"></div><div class="ramp-labels"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>`;}

function corridorPathways(windowName){
  const seen=new Map(); (state.corridors?.features||[]).forEach(f=>{const p=f.properties||{}; if(p.window===windowName&&p.pathway_id&&!seen.has(p.pathway_id))seen.set(p.pathway_id,p);}); return [...seen.values()];
}
function corridorStyle(p){
  const color=p.pathway_color||p.fill_color||"#cf6b34"; if(p.feature_type==="guide_rail")return {stroke:"#29342d",strokeWidth:1.4,strokeOpacity:.72,fill:"none",fillOpacity:0,dash:"5 4"};
  const level=Number(p.containment_level||90), selected=state.selectedPathway&&p.pathway_id===state.selectedPathway;
  const opacity=level===20?.62:level===50?.34:.15;
  return {stroke:selected?"#101713":color,strokeWidth:selected?2.3:.8,strokeOpacity:selected?1:.92,fill:color,fillOpacity:selected?Math.min(.78,opacity+.12):opacity,dash:null};
}
function renderCorridors(){
  clearDataLayers(); if(!state.corridors){setStatus("Corridor data unavailable",true);return;}
  const win=WINDOWS[state.corridorIndex]; setText("corridorWindowLabel",windowLabel(state.corridorIndex)); setText("mapEyebrow","FIVE-YEAR PATHWAYS"); setText("mapTitle",`CDHW Migration Corridors — ${windowLabel(state.corridorIndex)}`);
  const features=state.corridors.features.filter(f=>f.properties?.window===win), g=state.fullZoom.append("g").attr("class","data-layer");
  g.selectAll("path").data(features).join("path").attr("class","corridor-feature").attr("d",state.path)
    .attr("fill",d=>corridorStyle(d.properties||{}).fill).attr("fill-opacity",d=>corridorStyle(d.properties||{}).fillOpacity)
    .attr("stroke",d=>corridorStyle(d.properties||{}).stroke).attr("stroke-width",d=>corridorStyle(d.properties||{}).strokeWidth)
    .attr("stroke-opacity",d=>corridorStyle(d.properties||{}).strokeOpacity).attr("stroke-dasharray",d=>corridorStyle(d.properties||{}).dash)
    .on("mouseenter",(event,d)=>{const p=d.properties||{};tooltipShow(`<b>${esc(p.pathway_id||"Pathway")}</b><br>${fmt(p.associated_events)} associated events`,event);})
    .on("mousemove",tooltipMove).on("mouseleave",tooltipHide).on("click",(_,d)=>{state.selectedPathway=d.properties?.pathway_id;showCorridorProfile(d.properties||{});renderCorridors();});
  const paths=corridorPathways(win), lengths=paths.map(p=>num(p.data_path_length_km)).filter(numeric), widths=paths.map(p=>num(p.median_width50_km)).filter(numeric), assoc=paths.reduce((s,p)=>s+(num(p.associated_events)||0),0);
  setKpis([{label:"Pathways",value:fmt(paths.length),note:windowLabel(state.corridorIndex)},{label:"Associated events",value:fmt(assoc),note:"pathway totals"},{label:"Median pathway length",value:`${fmt(median(lengths),0)} km`,note:windowLabel(state.corridorIndex)},{label:"Median 50% width",value:`${fmt(median(widths),0)} km`,note:"corridor concentration"}]);
  $("legend").innerHTML=`<div class="legend-title">Containment envelopes · ${windowLabel(state.corridorIndex)}</div><div class="legend-items"><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.18"></i>90%</span><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.38"></i>50%</span><span class="legend-item"><i style="height:10px;background:#cf6b34;opacity:.72"></i>20%</span></div>`;
  if(!state.selectedPathway)setProfile("CORRIDOR PROFILE","Select a migration corridor",`<p class="placeholder">Move the five-year slider to examine corridor evolution. Click a pathway to inspect associated events, length, corridor widths, direction, directional dominance, and transition probability.</p>`);
  drawCorridorChart(paths); setStatus(`${fmt(paths.length)} pathways in ${windowLabel(state.corridorIndex)}`);
}
function showCorridorProfile(p){
  setProfile("CORRIDOR PROFILE",p.pathway_id||"Migration corridor",`<div class="profile-hero"><span>Five-year window</span><strong>${esc((p.window||"—").replace("-","–"))}</strong><span class="class-badge">Rank ${fmt(p.rank)}</span></div><div class="profile-grid"><div><span>Associated events</span><b>${fmt(p.associated_events)}</b></div><div><span>Path length</span><b>${fmt(p.data_path_length_km,0)} km</b></div><div><span>50% width</span><b>${fmt(p.median_width50_km,0)} km</b></div><div><span>90% width</span><b>${fmt(p.median_width90_km,0)} km</b></div><div><span>Direction</span><b>${esc(p.direction||"—")}</b></div><div><span>Bearing</span><b>${numeric(p.mean_bearing_deg)?`${fmt(p.mean_bearing_deg,1)}°`:"—"}</b></div></div><div class="profile-section"><div class="profile-row"><span>Directional dominance</span><b>${fmt(p.directional_dominance,2)}</b></div><div class="profile-row"><span>Transition probability</span><b>${numeric(p.transition_probability)?fmt(p.transition_probability,2):"—"}</b></div></div>`);
}
function toggleCorridorAnimation(){
  if(state.corridorTimer){stopCorridorAnimation();return;}
  $("animateCorridors").classList.add("playing"); $("animateCorridors").textContent="■ Stop animation";
  state.corridorTimer=setInterval(()=>{state.corridorIndex=(state.corridorIndex+1)%WINDOWS.length; $("corridorWindow").value=state.corridorIndex; setText("corridorWindowLabel",windowLabel(state.corridorIndex)); state.selectedPathway=null; if(state.tab==="corridors")renderCorridors();},1500);
}
function stopCorridorAnimation(){if(state.corridorTimer)clearInterval(state.corridorTimer);state.corridorTimer=null; if($("animateCorridors")){ $("animateCorridors").classList.remove("playing"); $("animateCorridors").textContent="▶ Animate windows"; }}

function exposureFeatures(){return state.exposure?.features||[];}
function metricValue(p){return num(p?.[state.exposureMetric]);}
function migrationValue(p){return num(p?.[state.migrationField]);}
function transformedMetric(v){return METRICS[state.exposureMetric].transform(v);}
function tertile(value,q1,q2){if(!numeric(value))return null;return Number(value)<=q1?0:Number(value)<=q2?1:2;}
function exposureBreaks(){const vals=exposureFeatures().map(f=>metricValue(f.properties||{})).filter(numeric);return[quantile(vals,1/3),quantile(vals,2/3)];}
function migrationBreaks(){let vals=exposureFeatures().map(f=>migrationValue(f.properties||{})).filter(numeric);const pos=vals.filter(v=>v>0);if(pos.length>=3)vals=pos;return[quantile(vals,1/3),quantile(vals,2/3)];}
function bivarIndex(migration,exposure,mb,eb){const x=tertile(migration,mb[0],mb[1]),y=tertile(exposure,eb[0],eb[1]);return x===null||y===null?null:y*3+x;}
function exposureFill(p,eb,mb,singleRange){
  const v=metricValue(p); if(!numeric(v))return "#efeee8";
  if(state.exposureMode==="joint"){const idx=bivarIndex(migrationValue(p),v,mb,eb);return idx===null?"#efeee8":BIVAR_COLORS[idx];}
  const lo=singleRange?.[0]??v,hi=singleRange?.[1]??v;return palette(SINGLE_COLORS,(v-lo)/Math.max(hi-lo,1e-12));
}
function renderExposure(){
  clearDataLayers(); if(!state.exposure){setStatus("Exposure data unavailable",true);return;}
  const def=METRICS[state.exposureMetric],eb=exposureBreaks(),mb=migrationBreaks(),singleVals=exposureFeatures().map(f=>metricValue(f.properties||{})).filter(numeric),singleRange=[quantile(singleVals,.03),quantile(singleVals,.97)];
  setText("mapEyebrow",state.exposureMode==="joint"?"BIVARIATE EXPOSURE":"ADM1 EXPOSURE"); setText("mapTitle",state.exposureMode==="joint"?`${MIGRATION_FIELDS[state.migrationField]} × ${def.title}`:def.title);
  const g=state.fullZoom.append("g").attr("class","data-layer");
  g.selectAll("path").data(exposureFeatures()).join("path").attr("class","exposure-region").attr("d",state.path).attr("fill",d=>exposureFill(d.properties||{},eb,mb,singleRange)).attr("fill-opacity",.9).attr("stroke","#8f978f").attr("stroke-width",.5)
    .on("mouseenter",function(event,d){d3.select(this).attr("stroke","#1f2b23").attr("stroke-width",1.5);const p=d.properties||{};tooltipShow(`<b>${esc(p.shapeName||"ADM1")}</b><br>${esc(def.title)}: ${esc(def.format(metricValue(p)))}`,event);})
    .on("mousemove",tooltipMove).on("mouseleave",function(event,d){d3.select(this).attr("stroke","#8f978f").attr("stroke-width",.5);tooltipHide();}).on("click",(_,d)=>showExposureProfile(d.properties||{},eb,mb));
  renderExposureLegend(def); updateExposureKpis(def,eb,mb); drawExposureChart(def,mb);
  setProfile("REGIONAL PROFILE","Select an ADM1 region",`<p class="placeholder">Click a first-order administrative region to inspect migration burden together with cropland, pasture, population, GDP, and critical-infrastructure exposure.</p>`);
  setStatus(`${fmt(exposureFeatures().length)} ADM1 regions`);
}
function renderExposureLegend(def){
  if(state.exposureMode==="single"){const vals=exposureFeatures().map(f=>metricValue(f.properties||{})).filter(numeric),lo=quantile(vals,.03),hi=quantile(vals,.97);$("legend").innerHTML=rampLegend(def.title,"linear-gradient(90deg,#ffffe5,#fee391,#fe9929,#ec7014,#993404)",def.format(lo),def.format(hi));return;}
  const cells=[];for(let y=2;y>=0;y--)for(let x=0;x<3;x++)cells.push(`<i style="background:${BIVAR_COLORS[y*3+x]}"></i>`);$("legend").innerHTML=`<div class="legend-title">${esc(def.title)} (low → high) × migration (low → high)</div><div class="bivar-legend">${cells.join("")}</div><div class="bivar-caption">33rd / 66th percentile joint classes</div>`;
}
function updateExposureKpis(def,eb,mb){
  const feats=exposureFeatures(),vals=feats.map(f=>metricValue(f.properties||{})).filter(numeric),highHigh=feats.filter(f=>bivarIndex(migrationValue(f.properties||{}),metricValue(f.properties||{}),mb,eb)===8).length,recent=feats.map(f=>num(f.properties?.TRK_RECENT)).filter(numeric);
  setKpis([{label:"ADM1 regions",value:fmt(feats.length),note:"global first-order units"},{label:`Median ${def.title}`,value:def.format(median(vals)),note:"across valid regions"},{label:"High migration–high exposure",value:fmt(highHigh),note:"upper joint class"},{label:"Median recent track burden",value:fmt(median(recent),2),note:"2001–2019"}]);
}
function classWord(i){return["Low","Moderate","High"][i]||"—";}
function showExposureProfile(p,eb,mb){
  const def=METRICS[state.exposureMetric],v=metricValue(p),m=migrationValue(p),idx=bivarIndex(m,v,mb,eb),joint=idx===null?"No joint class":`${classWord(idx%3)} migration–${classWord(Math.floor(idx/3))} exposure`;
  setProfile("ADM1 REGION PROFILE",`${p.shapeName||"Region"}${p.shapeGroup?`, ${p.shapeGroup}`:""}`,`<div class="profile-hero"><span>${esc(def.title)}</span><strong>${esc(def.format(v))}</strong><span class="class-badge">${esc(joint)}</span></div><div class="profile-grid"><div><span>Recent track burden</span><b>${fmt(p.TRK_RECENT,2)}</b></div><div><span>Total track burden</span><b>${fmt(p.TRK_TOTAL,2)}</b></div><div><span>Track-burden change</span><b>${numeric(p.TRK_CHANGE)&&Number(p.TRK_CHANGE)>0?"+":""}${fmt(p.TRK_CHANGE,2)}</b></div><div><span>Years with migration</span><b>${fmt(p.TRK_YRS)}</b></div></div><div class="profile-section"><h4>Exposure context</h4><div class="profile-row"><span>Cropland</span><b>${METRICS.CROPLAND.format(num(p.CROPLAND))}</b></div><div class="profile-row"><span>Pasture</span><b>${METRICS.PASTURE.format(num(p.PASTURE))}</b></div><div class="profile-row"><span>Population (2000)</span><b>${METRICS.POP2000.format(num(p.POP2000))}</b></div><div class="profile-row"><span>GDP (2017 international $, PPP)</span><b>${METRICS.GDP.format(num(p.GDP))}</b></div><div class="profile-row"><span>Critical infrastructure index</span><b>${METRICS.CISI_NORM.format(num(p.CISI_NORM))}</b></div></div>`);
}

function destroyChart(){if(state.chart){state.chart.destroy();state.chart=null;}}
function chartBaseOptions(){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:"#677069",font:{size:9}}},y:{beginAtZero:true,grid:{color:"rgba(100,110,100,.12)"},ticks:{color:"#677069",font:{size:9}}}}};}
function drawAnnualChart(){
  destroyChart();setText("chartEyebrow","TEMPORAL DISTRIBUTION");setText("chartTitle","Annual CDHW Migration Events");const a=state.summary.tracks.annual;
  state.chart=new Chart($("sideChart"),{type:"line",data:{labels:a.map(d=>d.year),datasets:[{data:a.map(d=>d.events),borderColor:"#8b2f24",backgroundColor:"rgba(207,107,52,.12)",fill:true,tension:.22,pointRadius:1.5,borderWidth:2}]},options:chartBaseOptions()});
}
function drawDensityChart(){destroyChart();setText("chartEyebrow","PERIOD COMPARISON");setText("chartTitle","Cumulative Migration-Track Count");const n=state.summary.density.native_stats;state.chart=new Chart($("sideChart"),{type:"bar",data:{labels:["1982–2000","2001–2019"],datasets:[{data:[n.early.sum,n.recent.sum],backgroundColor:["#dfad69","#9a4b31"]}]},options:chartBaseOptions()});}
function drawCorridorChart(paths){destroyChart();setText("chartEyebrow","PATHWAY ACTIVITY");setText("chartTitle",`Associated Events — ${windowLabel(state.corridorIndex)}`);const rows=[...paths].sort((a,b)=>(num(b.associated_events)||0)-(num(a.associated_events)||0)).slice(0,10);state.chart=new Chart($("sideChart"),{type:"bar",data:{labels:rows.map(p=>String(p.pathway_id||"").replace(/^.*_P/,"P")),datasets:[{data:rows.map(p=>num(p.associated_events)||0),backgroundColor:rows.map(p=>p.pathway_color||"#cf6b34")}]},options:chartBaseOptions()});}
function drawExposureChart(def,mb){destroyChart();setText("chartEyebrow","MIGRATION–EXPOSURE GRADIENT");setText("chartTitle",`${def.title} by Migration-Burden Class`);const groups=[[],[],[]];exposureFeatures().forEach(f=>{const p=f.properties||{},m=migrationValue(p),v=metricValue(p);if(!numeric(m)||!numeric(v))return;const g=tertile(m,mb[0],mb[1]);groups[g].push(transformedMetric(v));});state.chart=new Chart($("sideChart"),{type:"bar",data:{labels:["Low","Moderate","High"],datasets:[{data:groups.map(g=>median(g)),backgroundColor:["#b9d4cf","#b69a77","#681b3b"]}]},options:chartBaseOptions()});}
