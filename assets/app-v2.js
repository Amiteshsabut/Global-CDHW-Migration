const state = {
  summary: null,
  tracks: null,
  view: "tracks",
  split: 50,
  maps: {},
  basemaps: {},
  trackLayers: { left: null, right: null },
  pointLayers: { left: null, right: null },
  rasterLayers: { left: null, right: null },
  rasters: {},
  trackOpacity: 0.70,
  densityOpacity: 0.88,
  showPoints: false,
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

const YEAR_BOUNDS = [1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020];

const YEAR_LABELS = [
  "1980–1985",
  "1985–1990",
  "1990–1995",
  "1995–2000",
  "2000–2005",
  "2005–2010",
  "2010–2015",
  "2015–2020"
];

const YEAR_COLORS = [
  "#efe7d8",
  "#d9c39e",
  "#a99273",
  "#e5d476",
  "#a9e66e",
  "#29c86f",
  "#11a5e8",
  "#313695"
];

const DENSITY_COLORS = [
  "#fffdf0",
  "#fff0b2",
  "#fed976",
  "#feb24c",
  "#fd8d3c",
  "#e6550d",
  "#a63603",
  "#6b2500"
];

const CHANGE_NEG = [
  "#f2edf7",
  "#dadaeb",
  "#bcbddc",
  "#9e9ac8",
  "#756bb1",
  "#54278f"
];

const CHANGE_POS = [
  "#fff7ec",
  "#fee8c8",
  "#fdbb84",
  "#fc8d59",
  "#e34a33",
  "#b30000"
];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupMaps();
  bindControls();
  setupDivider();
  buildYearLegend();

  try {
    setStatus("Loading…");

    state.summary = await fetchJSON("data/summary.json");
    state.tracks = await fetchJSON("data/tracks.geojson");

    await loadRasters();

    updateSummary();
    drawCharts();
    renderView();

    setStatus("Ready");
  } catch (err) {
    console.error(err);

    setStatus("Data missing", true);

    document.getElementById("mapSubtitle").textContent =
      "Processed dashboard data are missing. Check the latest GitHub Actions build.";
  }
}

function setupMaps() {
  const options = {
    center: [22, 0],
    zoom: 2,
    minZoom: 1,
    maxZoom: 8,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1.0,
    worldCopyJump: false,
    preferCanvas: true,
  };

  state.maps.left = L.map("mapLeft", options);

  state.maps.right = L.map("mapRight", {
    ...options,
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  });

  // ==========================================================
  // BASEMAP
  // Uses standard OpenStreetMap tiles.
  // No CARTO API key is required.
  // ==========================================================
  const tileUrl = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

  const tileOptions = {
    maxZoom: 19,
    noWrap: true,
    attribution: "&copy; OpenStreetMap contributors"
  };

  state.basemaps.left = L.tileLayer(
    tileUrl,
    tileOptions
  ).addTo(state.maps.left);

  state.basemaps.right = L.tileLayer(
    tileUrl,
    tileOptions
  ).addTo(state.maps.right);

  state.maps.left.fitBounds(
    REGIONS.Global,
    { padding: [6, 6] }
  );

  syncRight();

  state.maps.left.on(
    "move zoom",
    syncRight
  );

  state.maps.left.on(
    "mousemove",
    event => {
      document.getElementById("readout").textContent =
        `${event.latlng.lat.toFixed(2)}°, ${event.latlng.lng.toFixed(2)}°`;
    }
  );
}

function syncRight() {
  state.maps.right.setView(
    state.maps.left.getCenter(),
    state.maps.left.getZoom(),
    {
      animate: false,
      reset: true
    }
  );
}

function bindControls() {
  document
    .getElementById("regionSelect")
    .addEventListener(
      "change",
      event => {
        state.maps.left.fitBounds(
          REGIONS[event.target.value] || REGIONS.Global,
          { padding: [8, 8] }
        );
      }
    );

  document
    .getElementById("resetView")
    .addEventListener(
      "click",
      () => {
        document.getElementById("regionSelect").value = "Global";

        state.maps.left.fitBounds(
          REGIONS.Global,
          { padding: [8, 8] }
        );

        setSplit(50);
      }
    );

  document
    .querySelectorAll(".view-btn")
    .forEach(
      button => {
        button.addEventListener(
          "click",
          () => {
            document
              .querySelectorAll(".view-btn")
              .forEach(
                b => b.classList.remove("active")
              );

            button.classList.add("active");

            state.view = button.dataset.view;

            renderView();
          }
        );
      }
    );

  document
    .getElementById("trackOpacity")
    .addEventListener(
      "input",
      event => {
        state.trackOpacity =
          Number(event.target.value) / 100;

        document.getElementById(
          "trackOpacityValue"
        ).textContent =
          `${event.target.value}%`;

        refreshTrackStyles();
      }
    );

  document
    .getElementById("densityOpacity")
    .addEventListener(
      "input",
      event => {
        state.densityOpacity =
          Number(event.target.value) / 100;

        document.getElementById(
          "densityOpacityValue"
        ).textContent =
          `${event.target.value}%`;

        ["left", "right"].forEach(
          side => {
            const layer =
              state.rasterLayers[side];

            if (layer && layer.setOpacity) {
              layer.setOpacity(
                state.densityOpacity
              );
            }
          }
        );
      }
    );

  document
    .getElementById("showTrackPoints")
    .addEventListener(
      "change",
      event => {
        state.showPoints =
          event.target.checked;

        if (state.view === "tracks") {
          renderTracks();
        }
      }
    );
}

function setupDivider() {
  const shell =
    document.getElementById("mapShell");

  const divider =
    document.getElementById("divider");

  let dragging = false;

  divider.addEventListener(
    "pointerdown",
    event => {
      dragging = true;

      divider.setPointerCapture(
        event.pointerId
      );
    }
  );

  divider.addEventListener(
    "pointermove",
    event => {
      if (
        !dragging ||
        state.view === "change"
      ) {
        return;
      }

      const rect =
        shell.getBoundingClientRect();

      const percentage =
        (
          (event.clientX - rect.left) /
          rect.width
        ) * 100;

      setSplit(
        Math.max(
          5,
          Math.min(
            95,
            percentage
          )
        )
      );
    }
  );

  divider.addEventListener(
    "pointerup",
    event => {
      dragging = false;

      try {
        divider.releasePointerCapture(
          event.pointerId
        );
      } catch (_) {}
    }
  );

  window.addEventListener(
    "resize",
    () => {
      state.maps.left.invalidateSize();
      state.maps.right.invalidateSize();

      setSplit(state.split);
    }
  );
}

function setSplit(percentage) {
  state.split = percentage;

  document.getElementById(
    "mapRight"
  ).style.clipPath =
    `inset(0 0 0 ${percentage}%)`;

  document.getElementById(
    "divider"
  ).style.left =
    `${percentage}%`;
}

function buildYearLegend() {
  const container =
    document.getElementById(
      "yearLegendItems"
    );

  container.innerHTML = "";

  YEAR_LABELS.forEach(
    (label, index) => {
      const item =
        document.createElement("div");

      item.className =
        "year-item";

      item.innerHTML = `
        <span
          class="year-swatch"
          style="background:${YEAR_COLORS[index]}"
        ></span>
        <span>${label}</span>
      `;

      container.appendChild(item);
    }
  );
}

async function loadRasters() {
  const files =
    state.summary.files;

  const [
    early,
    recent,
    change
  ] = await Promise.all([
    loadGeoRaster(
      files.early_density
    ),
    loadGeoRaster(
      files.recent_density
    ),
    loadGeoRaster(
      files.change_density
    )
  ]);

  state.rasters.early = early;
  state.rasters.recent = recent;
  state.rasters.change = change;
}

async function loadGeoRaster(url) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Cannot load ${url}`
    );
  }

  return parseGeoraster(
    await response.arrayBuffer()
  );
}

function clearLayers() {
  ["left", "right"].forEach(
    side => {
      for (
        const group of [
          "trackLayers",
          "pointLayers",
          "rasterLayers"
        ]
      ) {
        const layer =
          state[group][side];

        if (
          layer &&
          state.maps[side].hasLayer(layer)
        ) {
          state.maps[side].removeLayer(
            layer
          );
        }

        state[group][side] = null;
      }
    }
  );
}

function renderView() {
  clearLayers();

  const rightMap =
    document.getElementById(
      "mapRight"
    );

  const divider =
    document.getElementById(
      "divider"
    );

  const rightLabel =
    document.getElementById(
      "labelRight"
    );

  const leftLabel =
    document.getElementById(
      "labelLeft"
    );

  const yearLegend =
    document.getElementById(
      "yearLegend"
    );

  const densityLegend =
    document.getElementById(
      "densityLegend"
    );

  const trackControls =
    document.getElementById(
      "trackControls"
    );

  const densityControls =
    document.getElementById(
      "densityControls"
    );

  if (state.view === "tracks") {
    rightMap.classList.remove("hidden");
    divider.classList.remove("hidden");
    rightLabel.classList.remove("hidden");

    leftLabel.textContent =
      "1982–2000";

    rightLabel.textContent =
      "2001–2019";

    yearLegend.classList.remove("hidden");
    densityLegend.classList.add("hidden");

    trackControls.classList.remove("hidden");
    densityControls.classList.add("hidden");

    document.getElementById(
      "mapTitle"
    ).textContent =
      "Migration trajectories";

    document.getElementById(
      "mapSubtitle"
    ).textContent =
      "Drag the divider to compare event trajectories from 1982–2000 and 2001–2019.";

    document.getElementById(
      "mapNoteText"
    ).textContent =
      "Tracks come directly from Daily_Summary_CDHW_Events.xlsx. Colors represent event start year. Dateline crossings are split to avoid false trans-global lines.";

    renderTracks();
  }

  if (state.view === "density") {
    rightMap.classList.remove("hidden");
    divider.classList.remove("hidden");
    rightLabel.classList.remove("hidden");

    leftLabel.textContent =
      "1982–2000";

    rightLabel.textContent =
      "2001–2019";

    yearLegend.classList.add("hidden");
    densityLegend.classList.remove("hidden");

    trackControls.classList.add("hidden");
    densityControls.classList.remove("hidden");

    document.getElementById(
      "mapTitle"
    ).textContent =
      "Migration-track density";

    document.getElementById(
      "mapSubtitle"
    ).textContent =
      "The same color scale is used for both periods.";

    document.getElementById(
      "mapNoteText"
    ).textContent =
      "The native migration grid is bilinearly resampled only for display. Period statistics still use the original grid.";

    renderDensity();
  }

  if (state.view === "change") {
    rightMap.classList.add("hidden");
    divider.classList.add("hidden");
    rightLabel.classList.add("hidden");

    leftLabel.textContent =
      "2001–2019 minus 1982–2000";

    yearLegend.classList.add("hidden");
    densityLegend.classList.remove("hidden");

    trackControls.classList.add("hidden");
    densityControls.classList.remove("hidden");

    document.getElementById(
      "mapTitle"
    ).textContent =
      "Change in migration-track count";

    document.getElementById(
      "mapSubtitle"
    ).textContent =
      "Positive values indicate more track counts in 2001–2019; negative values indicate fewer.";

    document.getElementById(
      "mapNoteText"
    ).textContent =
      "Change is calculated on the original aligned grid and then resampled only for visualization.";

    renderChange();
  }
}

function renderTracks() {
  ["left", "right"].forEach(
    side => {
      if (
        state.trackLayers[side] &&
        state.maps[side].hasLayer(
          state.trackLayers[side]
        )
      ) {
        state.maps[side].removeLayer(
          state.trackLayers[side]
        );
      }

      if (
        state.pointLayers[side] &&
        state.maps[side].hasLayer(
          state.pointLayers[side]
        )
      ) {
        state.maps[side].removeLayer(
          state.pointLayers[side]
        );
      }
    }
  );

  const earlyFeatures =
    state.tracks.features.filter(
      feature =>
        feature.properties.start_year <= 2000
    );

  const recentFeatures =
    state.tracks.features.filter(
      feature =>
        feature.properties.start_year >= 2001
    );

  state.trackLayers.left =
    L.geoJSON(
      {
        type: "FeatureCollection",
        features: earlyFeatures
      },
      {
        style:
          feature =>
            trackStyle(feature),

        pointToLayer:
          (feature, latlng) =>
            L.circleMarker(
              latlng,
              {
                radius: 2,
                color: yearColor(
                  feature.properties.start_year
                ),
                weight: 1,
                fillOpacity: .7
              }
            )
      }
    ).addTo(
      state.maps.left
    );

  state.trackLayers.right =
    L.geoJSON(
      {
        type: "FeatureCollection",
        features: recentFeatures
      },
      {
        style:
          feature =>
            trackStyle(feature),

        pointToLayer:
          (feature, latlng) =>
            L.circleMarker(
              latlng,
              {
                radius: 2,
                color: yearColor(
                  feature.properties.start_year
                ),
                weight: 1,
                fillOpacity: .7
              }
            )
      }
    ).addTo(
      state.maps.right
    );

  if (state.showPoints) {
    state.pointLayers.left =
      makeDailyPointLayer(
        earlyFeatures
      ).addTo(
        state.maps.left
      );

    state.pointLayers.right =
      makeDailyPointLayer(
        recentFeatures
      ).addTo(
        state.maps.right
      );
  }
}

function trackStyle(feature) {
  return {
    color:
      yearColor(
        feature.properties.start_year
      ),
    weight: 1.1,
    opacity: state.trackOpacity,
    lineCap: "round",
    lineJoin: "round"
  };
}

function refreshTrackStyles() {
  ["left", "right"].forEach(
    side => {
      if (state.trackLayers[side]) {
        state.trackLayers[side].setStyle(
          feature =>
            trackStyle(feature)
        );
      }
    }
  );
}

function makeDailyPointLayer(features) {
  const group =
    L.layerGroup();

  features.forEach(
    feature => {
      if (
        feature.geometry.type !==
        "LineString"
      ) {
        return;
      }

      const color =
        yearColor(
          feature.properties.start_year
        );

      feature.geometry.coordinates.forEach(
        ([lon, lat]) => {
          L.circleMarker(
            [lat, lon],
            {
              radius: 1.25,
              color,
              weight: 0,
              fillColor: color,
              fillOpacity:
                Math.min(
                  1,
                  state.trackOpacity + .1
                )
            }
          ).addTo(group);
        }
      );
    }
  );

  return group;
}

function yearColor(year) {
  for (
    let i = 0;
    i < YEAR_BOUNDS.length - 1;
    i++
  ) {
    if (
      year >= YEAR_BOUNDS[i] &&
      year < YEAR_BOUNDS[i + 1]
    ) {
      return YEAR_COLORS[i];
    }
  }

  return YEAR_COLORS[
    YEAR_COLORS.length - 1
  ];
}

function renderDensity() {
  const max =
    state.summary.display
      .density_color_max;

  setupDensityLegend(
    "Cumulative migration-track count",
    "linear-gradient(90deg,#fffdf0,#fff0b2,#fed976,#feb24c,#fd8d3c,#e6550d,#a63603,#6b2500)",
    "0",
    fmt(max)
  );

  state.rasterLayers.left =
    makeRasterLayer(
      state.rasters.early,
      value =>
        densityColor(
          value,
          max
        ),
      state.densityOpacity
    ).addTo(
      state.maps.left
    );

  state.rasterLayers.right =
    makeRasterLayer(
      state.rasters.recent,
      value =>
        densityColor(
          value,
          max
        ),
      state.densityOpacity
    ).addTo(
      state.maps.right
    );
}

function renderChange() {
  const maxAbs =
    state.summary.display
      .change_color_abs_max;

  setupDensityLegend(
    "Change in migration-track count",
    "linear-gradient(90deg,#54278f,#9e9ac8,#eeeeF2,#fff7ec,#fc8d59,#b30000)",
    `−${fmt(maxAbs)}`,
    `+${fmt(maxAbs)}`
  );

  state.rasterLayers.left =
    makeRasterLayer(
      state.rasters.change,
      value =>
        changeColor(
          value,
          maxAbs
        ),
      state.densityOpacity
    ).addTo(
      state.maps.left
    );
}

function setupDensityLegend(
  title,
  gradient,
  minValue,
  maxValue
) {
  document.getElementById(
    "densityLegendTitle"
  ).textContent =
    title;

  document.getElementById(
    "densityRamp"
  ).style.background =
    gradient;

  document.getElementById(
    "densityMin"
  ).textContent =
    minValue;

  document.getElementById(
    "densityMax"
  ).textContent =
    maxValue;
}

function makeRasterLayer(
  raster,
  colorFunction,
  opacity
) {
  return new GeoRasterLayer({
    georaster: raster,
    opacity,
    resolution: 256,
    zIndex: 300,

    pixelValuesToColorFn:
      values => {
        const value =
          values?.[0];

        return colorFunction(
          value
        );
      }
  });
}

function densityColor(
  value,
  max
) {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    max <= 0
  ) {
    return null;
  }

  return palette(
    DENSITY_COLORS,
    clamp(
      value / max,
      0,
      1
    )
  );
}

function changeColor(
  value,
  maxAbs
) {
  if (
    !Number.isFinite(value) ||
    maxAbs <= 0
  ) {
    return null;
  }

  if (
    Math.abs(value) <
    maxAbs * .005
  ) {
    return "rgba(255,255,255,0)";
  }

  if (value < 0) {
    return palette(
      CHANGE_NEG,
      clamp(
        Math.abs(value) / maxAbs,
        0,
        1
      )
    );
  }

  return palette(
    CHANGE_POS,
    clamp(
      value / maxAbs,
      0,
      1
    )
  );
}

function palette(
  colors,
  t
) {
  if (t <= 0) {
    return colors[0];
  }

  if (t >= 1) {
    return colors[
      colors.length - 1
    ];
  }

  const x =
    t *
    (colors.length - 1);

  const index =
    Math.floor(x);

  const fraction =
    x - index;

  const a =
    rgb(colors[index]);

  const b =
    rgb(
      colors[index + 1]
    );

  return `rgb(${
    Math.round(
      a.r +
      (b.r - a.r) *
      fraction
    )
  },${
    Math.round(
      a.g +
      (b.g - a.g) *
      fraction
    )
  },${
    Math.round(
      a.b +
      (b.b - a.b) *
      fraction
    )
  })`;
}

function rgb(hex) {
  const h =
    hex.replace("#", "");

  return {
    r: parseInt(
      h.slice(0, 2),
      16
    ),
    g: parseInt(
      h.slice(2, 4),
      16
    ),
    b: parseInt(
      h.slice(4, 6),
      16
    )
  };
}

function updateSummary() {
  const summary =
    state.summary;

  const early =
    summary.events.early_count;

  const recent =
    summary.events.recent_count;

  document.getElementById(
    "earlyEvents"
  ).textContent =
    fmt(early);

  document.getElementById(
    "recentEvents"
  ).textContent =
    fmt(recent);

  document.getElementById(
    "eventChange"
  ).textContent =
    pctChange(
      early,
      recent
    );

  document.getElementById(
    "cellChange"
  ).textContent =
    pctChange(
      summary.native_stats.early.sum,
      summary.native_stats.recent.sum
    );

  document.getElementById(
    "cropOverlap"
  ).textContent =
    `${
      summary.landuse.cropland
        .recent_overlap_pct
        .toFixed(1)
    }%`;

  document.getElementById(
    "pastureOverlap"
  ).textContent =
    `${
      summary.landuse.pasture
        .recent_overlap_pct
        .toFixed(1)
    }%`;
}

function drawCharts() {
  const annual =
    state.summary.events.annual;

  const years =
    annual.map(
      item => item.year
    );

  const counts =
    annual.map(
      item => item.events
    );

  new Chart(
    document.getElementById(
      "annualChart"
    ),
    {
      type: "line",

      data: {
        labels: years,

        datasets: [{
          data: counts,
          label: "Events",
          borderColor: "#0f766e",
          backgroundColor:
            "rgba(15,118,110,.10)",
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          tension: .18
        }]
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,

        plugins: {
          legend: {
            display: false
          }
        },

        scales: {
          x: {
            grid: {
              display: false
            },

            ticks: {
              maxTicksLimit: 6,
              font: {
                size: 9
              },
              color: "#6f7d89"
            }
          },

          y: {
            beginAtZero: true,

            ticks: {
              precision: 0,
              font: {
                size: 9
              },
              color: "#6f7d89"
            },

            grid: {
              color:
                "rgba(100,115,130,.12)"
            }
          }
        }
      }
    }
  );

  const landuse =
    state.summary.landuse;

  new Chart(
    document.getElementById(
      "landuseChart"
    ),
    {
      type: "bar",

      data: {
        labels: [
          "Cropland",
          "Pasture"
        ],

        datasets: [
          {
            label: "1982–2000",

            data: [
              landuse.cropland
                .early_weighted_mean,

              landuse.pasture
                .early_weighted_mean
            ],

            backgroundColor:
              "#9bc6bf"
          },

          {
            label: "2001–2019",

            data: [
              landuse.cropland
                .recent_weighted_mean,

              landuse.pasture
                .recent_weighted_mean
            ],

            backgroundColor:
              "#0f766e"
          }
        ]
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,

        plugins: {
          legend: {
            labels: {
              boxWidth: 9,

              font: {
                size: 9
              }
            }
          }
        },

        scales: {
          x: {
            grid: {
              display: false
            },

            ticks: {
              font: {
                size: 9
              }
            }
          },

          y: {
            beginAtZero: true,

            title: {
              display: true,
              text:
                "Land-use-weighted mean track count",
              font: {
                size: 9
              }
            },

            ticks: {
              font: {
                size: 9
              }
            }
          }
        }
      }
    }
  );
}

function pctChange(
  early,
  recent
) {
  if (
    !Number.isFinite(early) ||
    early === 0 ||
    !Number.isFinite(recent)
  ) {
    return "—";
  }

  const change =
    (
      (recent - early) /
      early
    ) * 100;

  return `${
    change >= 0
      ? "+"
      : ""
  }${change.toFixed(1)}%`;
}

function fmt(number) {
  const n =
    Number(number);

  if (
    !Number.isFinite(n)
  ) {
    return "—";
  }

  if (
    Math.abs(n) >= 1e6
  ) {
    return `${
      (n / 1e6).toFixed(2)
    }M`;
  }

  if (
    Math.abs(n) >= 1e3
  ) {
    return `${
      (n / 1e3).toFixed(1)
    }k`;
  }

  if (
    Math.abs(n) >= 100
  ) {
    return n.toFixed(0);
  }

  if (
    Math.abs(n) >= 10
  ) {
    return n.toFixed(1);
  }

  return n
    .toFixed(2)
    .replace(
      /\.00$/,
      ""
    );
}

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}

async function fetchJSON(url) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `${url}: ${response.status}`
    );
  }

  return response.json();
}

function setStatus(
  text,
  error = false
) {
  const element =
    document.getElementById(
      "status"
    );

  element.textContent =
    text;

  element.classList.toggle(
    "error",
    error
  );
}
