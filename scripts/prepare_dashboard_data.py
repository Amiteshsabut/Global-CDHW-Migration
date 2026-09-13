"""Build web-ready data for the Global CDHW Migration Observatory.

Required inputs
---------------
raw_data/events/tracks.geojson
raw_data/migration/Migration_TrackCount_1982.tif ... Migration_TrackCount_2019.tif

Optional but recommended
------------------------
raw_data/corridors/CDHW_5yr_variable_width_corridors_dashboard.geojson
raw_data/exposure/Global_ADM1_Exposure_Migration_web.geojson
    OR raw_data/exposure/Global_ADM1_Exposure_Migration.geojson
raw_data/population/gpw_v4_population_count_rev11_2000_1_deg.tif

The script enriches track geometry with migration metrics, builds period-density
rasters, copies five-year corridor data, creates a compact ADM1 exposure layer,
and writes one summary.json consumed by the dashboard.
"""
from __future__ import annotations

from pathlib import Path
import json
import math
import re
import shutil

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from rasterio.mask import mask as rio_mask
from rasterio.windows import from_bounds as window_from_bounds, bounds as window_bounds

try:
    from shapely.geometry import shape as shp_shape, mapping as shp_mapping, box as shp_box
except Exception:
    shp_shape = None
    shp_mapping = None
    shp_box = None

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "data"

TRACKS_FILE = REPO_ROOT / "raw_data" / "events" / "tracks.geojson"
MIGRATION_DIR = REPO_ROOT / "raw_data" / "migration"
POPULATION_FILE = REPO_ROOT / "raw_data" / "population" / "gpw_v4_population_count_rev11_2000_1_deg.tif"
BASEMAP_FILE = REPO_ROOT / "raw_data" / "basemap" / "World_Continents_Web.geojson"

CORRIDOR_CANDIDATES = [
    REPO_ROOT / "raw_data" / "corridors" / "CDHW_5yr_variable_width_corridors_dashboard.geojson",
    REPO_ROOT / "raw_data" / "CDHW_5yr_variable_width_corridors_dashboard.geojson",
    REPO_ROOT / "raw_data" / "events" / "CDHW_5yr_variable_width_corridors_dashboard.geojson",
]
EXPOSURE_CANDIDATES = [
    REPO_ROOT / "raw_data" / "exposure" / "Global_ADM1_Exposure_Migration_web.geojson",
    REPO_ROOT / "raw_data" / "exposure" / "Global_ADM1_Exposure_Migration.geojson",
    REPO_ROOT / "raw_data" / "Global_ADM1_Exposure_Migration_web.geojson",
    REPO_ROOT / "raw_data" / "Global_ADM1_Exposure_Migration.geojson",
]

EARLY_YEARS = range(1982, 2001)
RECENT_YEARS = range(2001, 2020)
ALL_YEARS = range(1982, 2020)
FIVE_YEAR_WINDOWS = [
    (1982, 1986), (1987, 1991), (1992, 1996), (1997, 2001),
    (2002, 2006), (2007, 2011), (2012, 2016), (2017, 2019),
]
DISPLAY_RES_DEG = 0.25
NODATA = -9999.0
EXPOSURE_SIMPLIFY_DEG = 0.05


def first_existing(paths):
    return next((p for p in paths if p.exists()), None)


def window_for_year(year: int) -> str:
    for start, end in FIVE_YEAR_WINDOWS:
        if start <= int(year) <= end:
            return f"{start}-{end}"
    return "Other"


def haversine_km(lon1, lat1, lon2, lat2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def initial_bearing(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def cardinal_direction(deg):
    labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return labels[int((deg + 22.5) // 45) % 8]


def line_parts(geometry):
    if not geometry:
        return []
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if gtype == "LineString":
        return [coords]
    if gtype == "MultiLineString":
        return coords
    if gtype == "Point":
        return [[coords]]
    return []


def track_metrics(geometry):
    parts = [p for p in line_parts(geometry) if p]
    flat = [xy for part in parts for xy in part if len(xy) >= 2]
    if not flat:
        return {"n_positions": 0, "path_length_km": 0.0, "net_displacement_km": 0.0,
                "mean_bearing_deg": None, "direction": "—"}
    length = 0.0
    for part in parts:
        for a, b in zip(part[:-1], part[1:]):
            length += haversine_km(float(a[0]), float(a[1]), float(b[0]), float(b[1]))
    start, end = flat[0], flat[-1]
    net = haversine_km(float(start[0]), float(start[1]), float(end[0]), float(end[1]))
    bearing = initial_bearing(float(start[0]), float(start[1]), float(end[0]), float(end[1])) if len(flat) > 1 else None
    return {
        "n_positions": len(flat),
        "path_length_km": round(length, 2),
        "net_displacement_km": round(net, 2),
        "mean_bearing_deg": None if bearing is None else round(bearing, 1),
        "direction": "—" if bearing is None else cardinal_direction(bearing),
    }


def prepare_tracks():
    if not TRACKS_FILE.exists():
        raise FileNotFoundError(f"Missing required track file: {TRACKS_FILE}")
    with TRACKS_FILE.open("r", encoding="utf-8") as f:
        geojson = json.load(f)
    if geojson.get("type") != "FeatureCollection":
        raise ValueError("tracks.geojson must be a FeatureCollection")

    annual = {y: 0 for y in ALL_YEARS}
    by_window = {f"{a}-{b}": 0 for a, b in FIVE_YEAR_WINDOWS}
    enriched = []
    lengths = []

    for idx, feature in enumerate(geojson.get("features", []), start=1):
        props = dict(feature.get("properties") or {})
        if "start_year" not in props:
            raise KeyError(f"Track feature {idx} has no start_year")
        year = int(props["start_year"])
        if year not in annual:
            raise ValueError(f"Track start_year {year} is outside 1982-2019")
        props.setdefault("track_id", f"CDHW-{idx:04d}")
        props["start_year"] = year
        props["window"] = window_for_year(year)
        metrics = track_metrics(feature.get("geometry"))
        props.update(metrics)
        lengths.append(metrics["path_length_km"])
        annual[year] += 1
        by_window[props["window"]] += 1
        enriched.append({"type": "Feature", "properties": props, "geometry": feature.get("geometry")})

    out = {"type": "FeatureCollection", "features": enriched}
    with (OUTPUT_DIR / "tracks.geojson").open("w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    total = len(enriched)
    early = sum(annual[y] for y in EARLY_YEARS)
    recent = sum(annual[y] for y in RECENT_YEARS)
    return {
        "total": total,
        "early_count": int(early),
        "recent_count": int(recent),
        "annual": [{"year": y, "events": annual[y]} for y in ALL_YEARS],
        "five_year": [{"window": k, "events": int(v)} for k, v in by_window.items()],
        "median_path_length_km": float(np.median(lengths)) if lengths else 0.0,
    }


def find_migration_files():
    files = {}
    for p in MIGRATION_DIR.glob("Migration_TrackCount_*.tif"):
        m = re.search(r"(\d{4})$", p.stem)
        if m:
            files[int(m.group(1))] = p
    missing = [y for y in ALL_YEARS if y not in files]
    if missing:
        raise FileNotFoundError("Missing annual migration rasters: " + ", ".join(map(str, missing)))
    return files


def read_raster(path):
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float64")
        profile = src.profile.copy()
        transform, crs, nodata = src.transform, src.crs, src.nodata
    valid = np.isfinite(arr)
    if nodata is not None and np.isfinite(nodata):
        valid &= arr != nodata
    return np.where(valid, arr, np.nan), profile, transform, crs


def check_same_grid(reference, current, year):
    rp, rt, rc = reference
    p, t, c = current
    if p["width"] != rp["width"] or p["height"] != rp["height"]:
        raise ValueError(f"Raster dimensions differ in {year}")
    if t != rt:
        raise ValueError(f"Raster transform differs in {year}")
    if c != rc:
        raise ValueError(f"Raster CRS differs in {year}")


def stats(arr):
    vals = arr[np.isfinite(arr)]
    if vals.size == 0:
        return {"sum": 0.0, "mean": 0.0, "max": 0.0, "positive_cells": 0}
    return {"sum": float(vals.sum()), "mean": float(vals.mean()), "max": float(vals.max()),
            "positive_cells": int((vals > 0).sum())}


def build_period_rasters(files):
    early, recent, reference = [], [], None
    for year in ALL_YEARS:
        arr, profile, transform, crs = read_raster(files[year])
        if reference is None:
            reference = (profile, transform, crs)
        else:
            check_same_grid(reference, (profile, transform, crs), year)
        (early if year <= 2000 else recent).append(arr)
    early_stack, recent_stack = np.stack(early), np.stack(recent)
    early_sum, recent_sum = np.nansum(early_stack, axis=0), np.nansum(recent_stack, axis=0)
    early_sum[np.all(~np.isfinite(early_stack), axis=0)] = np.nan
    recent_sum[np.all(~np.isfinite(recent_stack), axis=0)] = np.nan
    return {"early": early_sum, "recent": recent_sum, "change": recent_sum - early_sum,
            "profile": reference[0], "transform": reference[1], "crs": reference[2]}


def display_grid():
    return (from_origin(-180.0, 90.0, DISPLAY_RES_DEG, DISPLAY_RES_DEG),
            int(round(360 / DISPLAY_RES_DEG)), int(round(180 / DISPLAY_RES_DEG)))


def reproject_for_display(src_array, src_transform, src_crs):
    if src_crs is None:
        raise ValueError("Migration rasters have no CRS")
    dst_transform, width, height = display_grid()
    dst = np.full((height, width), NODATA, dtype="float32")
    src = np.where(np.isfinite(src_array), src_array, NODATA).astype("float32")
    reproject(source=src, destination=dst, src_transform=src_transform, src_crs=src_crs,
              src_nodata=NODATA, dst_transform=dst_transform, dst_crs="EPSG:4326",
              dst_nodata=NODATA, resampling=Resampling.bilinear)
    return np.where(dst == NODATA, np.nan, dst), dst_transform


def write_display_tif(path, array, transform):
    arr = np.where(np.isfinite(array), array, NODATA).astype("float32")
    profile = {"driver": "GTiff", "height": arr.shape[0], "width": arr.shape[1], "count": 1,
               "dtype": "float32", "crs": "EPSG:4326", "transform": transform,
               "nodata": NODATA, "compress": "DEFLATE", "predictor": 2, "tiled": True,
               "blockxsize": 256, "blockysize": 256}
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)


def robust_limits(early, recent, change):
    positive = np.concatenate([early[np.isfinite(early) & (early > 0)], recent[np.isfinite(recent) & (recent > 0)]])
    density_max = float(np.nanpercentile(positive, 99)) if positive.size else 1.0
    abs_change = np.abs(change[np.isfinite(change)])
    change_max = float(np.nanpercentile(abs_change, 99)) if abs_change.size else 1.0
    return max(density_max, 1e-9), max(change_max, 1e-9)


def prepare_density():
    files = find_migration_files()
    native = build_period_rasters(files)
    early, tx = reproject_for_display(native["early"], native["transform"], native["crs"])
    recent, _ = reproject_for_display(native["recent"], native["transform"], native["crs"])
    change, _ = reproject_for_display(native["change"], native["transform"], native["crs"])
    write_display_tif(OUTPUT_DIR / "density_1982_2000_display.tif", early, tx)
    write_display_tif(OUTPUT_DIR / "density_2001_2019_display.tif", recent, tx)
    write_display_tif(OUTPUT_DIR / "change_2001_2019_minus_1982_2000_display.tif", change, tx)
    dmax, cmax = robust_limits(native["early"], native["recent"], native["change"])
    return {"native_stats": {"early": stats(native["early"]), "recent": stats(native["recent"]), "change": stats(native["change"])},
            "density_color_max": dmax, "change_color_abs_max": cmax, "display_resolution_deg": DISPLAY_RES_DEG}


def prepare_corridors():
    src = first_existing(CORRIDOR_CANDIDATES)
    if src is None:
        return {"available": False, "windows": [], "pathway_counts": {}, "pathways": 0}
    with src.open("r", encoding="utf-8") as f:
        gj = json.load(f)
    if gj.get("type") != "FeatureCollection":
        raise ValueError("Corridor GeoJSON must be a FeatureCollection")
    shutil.copyfile(src, OUTPUT_DIR / "corridors.geojson")
    unique = {}
    for feature in gj.get("features", []):
        p = feature.get("properties") or {}
        pid = p.get("pathway_id")
        if pid and pid not in unique:
            unique[pid] = p
    windows = [f"{a}-{b}" for a, b in FIVE_YEAR_WINDOWS]
    counts = {w: sum(1 for p in unique.values() if p.get("window") == w) for w in windows}
    associated = {w: int(sum(float(p.get("associated_events") or 0) for p in unique.values() if p.get("window") == w)) for w in windows}
    return {"available": True, "windows": windows, "pathway_counts": counts,
            "associated_events": associated, "pathways": len(unique)}


def _round_coords(value, digits=5):
    if isinstance(value, (list, tuple)):
        if len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            return [round(float(value[0]), digits), round(float(value[1]), digits)] + [
                round(float(x), digits) if isinstance(x, (int, float)) else x for x in value[2:]
            ]
        return [_round_coords(x, digits) for x in value]
    return value


def _unwrap_ring_longitudes(ring):
    """Return a copy of a ring with longitudes unwrapped across the dateline.

    A ring that crosses +/-180 can otherwise look like a nearly world-spanning
    polygon in simple lon/lat signed-area calculations.  Unwrapping makes the
    winding test local and stable for Siberian / Arctic island polygons.
    """
    if not ring:
        return []
    first = list(ring[0])
    out = [first]
    prev = float(first[0])

    for pt0 in ring[1:]:
        pt = list(pt0)
        lon = float(pt[0])
        # Shift by 360-degree multiples so this vertex is closest to the
        # previous unwrapped longitude.
        k = round((prev - lon) / 360.0)
        lon_u = lon + 360.0 * k
        pt[0] = lon_u
        out.append(pt)
        prev = lon_u

    return out


def _ring_signed_area(ring):
    """Signed lon/lat area after dateline unwrapping. Positive = CCW."""
    if not ring or len(ring) < 4:
        return 0.0

    work = _unwrap_ring_longitudes(ring)
    area = 0.0
    for i in range(len(work)):
        x1, y1 = work[i][0], work[i][1]
        x2, y2 = work[(i + 1) % len(work)][0], work[(i + 1) % len(work)][1]
        area += float(x1) * float(y2) - float(x2) * float(y1)
    return area / 2.0


def _d3_ring_sum(ring):
    """Return the signed spherical ring sum used by d3-geo.

    For a small polygon exterior that d3-geo renders normally, this value is
    positive. A negative value makes d3 interpret that ring as the spherical
    complement (almost the whole globe). This catches tiny Arctic/Siberian
    components where planar lon/lat winding can appear correct but d3's
    spherical interpretation is reversed.
    """
    if not ring or len(ring) < 4:
        return 0.0

    rad = math.pi / 180.0
    quarter_pi = math.pi / 4.0

    lam_prev = float(ring[0][0]) * rad
    phi0 = float(ring[0][1]) * rad / 2.0 + quarter_pi
    cos_phi0 = math.cos(phi0)
    sin_phi0 = math.sin(phi0)
    total = 0.0

    def step(lon, lat, lam0, cos0, sin0):
        lam = float(lon) * rad
        phi = float(lat) * rad / 2.0 + quarter_pi
        dlam = lam - lam0
        sign = 1.0 if dlam >= 0 else -1.0
        adlam = sign * dlam
        cos_phi = math.cos(phi)
        sin_phi = math.sin(phi)
        k = sin0 * sin_phi
        u = cos0 * cos_phi + k * math.cos(adlam)
        v = k * sign * math.sin(adlam)
        return math.atan2(v, u), lam, cos_phi, sin_phi

    for pt in ring[1:]:
        add, lam_prev, cos_phi0, sin_phi0 = step(
            pt[0], pt[1], lam_prev, cos_phi0, sin_phi0
        )
        total += add

    # Explicitly close to the first vertex, matching d3-geo.
    add, _, _, _ = step(
        ring[0][0], ring[0][1], lam_prev, cos_phi0, sin_phi0
    )
    total += add
    return total


def _rewind_polygon_for_d3(poly):
    """Normalize one Polygon for d3-geo's spherical winding convention.

    d3-geo expects:
      * exterior ring: clockwise
      * interior holes: counter-clockwise

    This is especially important for large Russian MultiPolygons such as
    Sakha Republic (Yakutia), where one incorrectly wound island/component can
    make d3 interpret the *whole ADM1 feature* as the complement of itself.
    """
    if not poly:
        return None

    out = []
    for j, ring0 in enumerate(poly):
        if not ring0 or len(ring0) < 4:
            continue

        ring = [list(pt) for pt in ring0 if len(pt) >= 2]
        if len(ring) < 4:
            continue

        # Make sure the ring is explicitly closed.
        if ring[0][0] != ring[-1][0] or ring[0][1] != ring[-1][1]:
            ring.append(list(ring[0]))

        unique_xy = {
            (round(float(pt[0]), 12), round(float(pt[1]), 12))
            for pt in ring
        }
        if len(unique_xy) < 3:
            continue

        a = _ring_signed_area(ring)
        if abs(a) < 1e-14:
            continue

        # First normalize the ordinary planar winding.
        should_reverse_planar = (j == 0 and a > 0) or (j > 0 and a < 0)
        if should_reverse_planar:
            ring.reverse()

        # Then apply the actual d3-geo spherical winding test. This is the
        # critical step for tiny high-latitude components such as one island
        # piece inside Sakha Republic: planar winding can look correct while
        # d3 still interprets the ring as the complement of the globe.
        d3sum = _d3_ring_sum(ring)
        should_reverse_spherical = (j == 0 and d3sum < 0) or (j > 0 and d3sum > 0)
        if should_reverse_spherical:
            ring.reverse()

        # Re-close after reversal to guard against malformed source rings.
        if ring[0][0] != ring[-1][0] or ring[0][1] != ring[-1][1]:
            ring.append(list(ring[0]))

        out.append(ring)

    return out if out else None


def normalize_geometry_for_d3(geometry):
    if not geometry:
        return geometry
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        poly = _rewind_polygon_for_d3(coords)
        return {"type": "Polygon", "coordinates": poly} if poly else None
    if gtype == "MultiPolygon":
        polys = []
        for poly0 in coords or []:
            poly = _rewind_polygon_for_d3(poly0)
            if poly:
                polys.append(poly)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    return geometry


def simplify_geometry(geometry):
    """Simplify ADM1 geometry and normalize winding both before and after.

    Normalizing twice is intentional:
      1. fixes malformed source MultiPolygon pieces before Shapely sees them;
      2. fixes any ring orientation changed by simplify()/mapping().

    This prevents valid Siberian ADM1 regions such as Sakha Republic and
    Yamalo-Nenets Autonomous Okrug from being rejected by the browser map.
    """
    if not geometry:
        return None

    normalized_source = normalize_geometry_for_d3(geometry)
    if normalized_source is None:
        return None

    if shp_shape is None:
        return normalized_source

    try:
        geom_obj = shp_shape(normalized_source)
        if geom_obj.is_empty:
            return None

        # Repair invalid polygon topology when Shapely can do so safely.
        if not geom_obj.is_valid:
            try:
                geom_obj = geom_obj.buffer(0)
            except Exception:
                pass
        if geom_obj.is_empty:
            return None

        geom_obj = geom_obj.simplify(
            EXPOSURE_SIMPLIFY_DEG,
            preserve_topology=True,
        )
        geom = shp_mapping(geom_obj)

        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            # Do not emit GeometryCollections into the ADM1 web layer.
            return normalized_source

        rounded = {
            "type": geom["type"],
            "coordinates": _round_coords(geom["coordinates"]),
        }
        return normalize_geometry_for_d3(rounded)

    except Exception:
        return normalized_source


def population_for_geometry(src, geometry):
    """Area-weight population-count raster cells into one ADM1 polygon.

    This is preferable to simply assigning whole 1-degree cells to small ADM1
    regions. The fractional overlap is computed within each source raster cell.
    """
    try:
        if shp_shape is None or shp_box is None:
            out, _ = rio_mask(src, [geometry], crop=True, filled=False, indexes=1, all_touched=True)
            vals = np.ma.asarray(out).compressed()
            vals = vals[np.isfinite(vals) & (vals >= 0)]
            return float(vals.sum()) if vals.size else None

        geom = shp_shape(geometry)
        if geom.is_empty:
            return None
        left, bottom, right, top = geom.bounds
        w = window_from_bounds(left, bottom, right, top, transform=src.transform)
        w = w.round_offsets().round_lengths()
        # Clip window to raster extent.
        col0 = max(0, int(w.col_off)); row0 = max(0, int(w.row_off))
        col1 = min(src.width, col0 + max(1, int(w.width)))
        row1 = min(src.height, row0 + max(1, int(w.height)))
        if col1 <= col0 or row1 <= row0:
            return None
        from rasterio.windows import Window
        win = Window(col0, row0, col1-col0, row1-row0)
        arr = src.read(1, window=win, masked=True)
        total = 0.0
        used = False
        for rr in range(arr.shape[0]):
            for cc in range(arr.shape[1]):
                if np.ma.is_masked(arr[rr, cc]):
                    continue
                value = float(arr[rr, cc])
                if not np.isfinite(value) or value < 0:
                    continue
                cell_win = Window(col0 + cc, row0 + rr, 1, 1)
                x0, y0, x1, y1 = window_bounds(cell_win, src.transform)
                cell = shp_box(x0, y0, x1, y1)
                if not geom.intersects(cell):
                    continue
                inter = geom.intersection(cell)
                if inter.is_empty or cell.area <= 0:
                    continue
                fraction = max(0.0, min(1.0, inter.area / cell.area))
                total += value * fraction
                used = True
        return float(total) if used else None
    except Exception:
        return None


def metric_stats(features, key):
    vals = []
    for ft in features:
        v = (ft.get("properties") or {}).get(key)
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if np.isfinite(v):
            vals.append(v)
    if not vals:
        return {"n": 0, "min": None, "median": None, "max": None, "q33": None, "q66": None}
    a = np.asarray(vals, dtype=float)
    return {"n": int(a.size), "min": float(np.min(a)), "median": float(np.median(a)), "max": float(np.max(a)),
            "q33": float(np.quantile(a, 1/3)), "q66": float(np.quantile(a, 2/3))}


def prepare_exposure():
    src_path = first_existing(EXPOSURE_CANDIDATES)
    if src_path is None:
        return {"available": False, "feature_count": 0, "population_available": False, "metrics": {}}
    with src_path.open("r", encoding="utf-8") as f:
        gj = json.load(f)
    if gj.get("type") != "FeatureCollection":
        raise ValueError("ADM1 exposure GeoJSON must be a FeatureCollection")

    keep = ["shapeGroup", "shapeName", "shapeID", "shapeType", "ADM1_ID", "FOREST", "CROPLAND", "PASTURE",
            "GDP", "CISI", "CISI_NORM", "TRK_EARLY", "TRK_RECENT", "TRK_TOTAL", "TRK_CHANGE", "TRK_MEAN", "TRK_MAX", "TRK_YRS"]
    out_features = []
    try:
        for ft in gj.get("features", []):
            props0 = ft.get("properties") or {}
            # Antarctica can be encoded as a dateline-spanning polygon that D3
            # interprets as the spherical complement in Robinson projection.
            # It has no meaningful exposure context for this dashboard, so omit
            # it to prevent the giant globe-filling polygon seen in the browser.
            if str(props0.get("shapeGroup") or "").upper() == "ATA" or str(props0.get("shapeName") or "").strip().lower() == "antarctica":
                continue
            props = {k: props0.get(k) for k in keep if k in props0}
            source_geom = ft.get("geometry")
            geom = simplify_geometry(source_geom)
            if geom is None:
                continue

            # Diagnostic: these very large Russian MultiPolygons previously
            # exposed winding problems in d3-geo. Keep them and report that
            # they survived preprocessing.
            if str(props.get("shapeGroup") or "").upper() == "RUS" and str(props.get("shapeName") or "") in {
                "Sakha Republic",
                "Yamalo-Nenets Autonomous Okrug",
            }:
                print(
                    f"    geometry check OK: {props.get('shapeName')} "
                    f"({geom.get('type')}, "
                    f"{len(geom.get('coordinates') or [])} polygon part(s))"
                )

            out_features.append({"type": "Feature", "properties": props, "geometry": geom})
    finally:
        pass

    out = {"type": "FeatureCollection", "features": out_features}
    with (OUTPUT_DIR / "adm1_exposure.geojson").open("w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    keys = ["CROPLAND", "PASTURE", "GDP", "CISI_NORM", "TRK_EARLY", "TRK_RECENT", "TRK_TOTAL", "TRK_CHANGE", "TRK_YRS"]
    metrics = {k: metric_stats(out_features, k) for k in keys}
    return {"available": True, "feature_count": len(out_features),
            "population_available": False, "metrics": metrics}



def prepare_basemap():
    if not BASEMAP_FILE.exists():
        raise FileNotFoundError(
            f"Missing clean Robinson basemap input: {BASEMAP_FILE}\n"
            "Upload World_Continents_Web.geojson to raw_data/basemap/."
        )
    with BASEMAP_FILE.open("r", encoding="utf-8") as f:
        gj = json.load(f)
    if gj.get("type") != "FeatureCollection":
        raise ValueError("World_Continents_Web.geojson must be a FeatureCollection")
    with (OUTPUT_DIR / "world_continents.geojson").open("w", encoding="utf-8") as f:
        json.dump(gj, f, separators=(",", ":"))
    return {"available": True, "feature_count": len(gj.get("features", []))}


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print("1/6 Preparing clean world basemap...")
    basemap_summary = prepare_basemap()
    print("2/6 Preparing migration tracks...")
    track_summary = prepare_tracks()
    print("3/6 Preparing migration density rasters...")
    density_summary = prepare_density()
    print("4/6 Preparing five-year corridors...")
    corridor_summary = prepare_corridors()
    print("5/6 Preparing ADM1 exposure layer...")
    exposure_summary = prepare_exposure()
    print("6/6 Writing dashboard summary...")

    summary = {
        "periods": {"early": "1982-2000", "recent": "2001-2019", "full": "1982-2019"},
        "five_year_windows": [f"{a}-{b}" for a, b in FIVE_YEAR_WINDOWS],
        "basemap": basemap_summary,
        "tracks": track_summary,
        "density": density_summary,
        "corridors": corridor_summary,
        "exposure": exposure_summary,
        "files": {
            "world": "data/world_continents.geojson",
            "tracks": "data/tracks.geojson",
            "early_density": "data/density_1982_2000_display.tif",
            "recent_density": "data/density_2001_2019_display.tif",
            "change_density": "data/change_2001_2019_minus_1982_2000_display.tif",
            "corridors": "data/corridors.geojson" if corridor_summary["available"] else None,
            "exposure": "data/adm1_exposure.geojson" if exposure_summary["available"] else None,
        },
    }
    with (OUTPUT_DIR / "summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print("DONE")
    print("Tracks:", track_summary["total"])
    print("Corridor pathways:", corridor_summary["pathways"])
    print("ADM1 regions:", exposure_summary["feature_count"])
    print("Population available:", exposure_summary["population_available"])


if __name__ == "__main__":
    main()
