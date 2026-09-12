"""
Prepare data for the Global Compound Drought–Heatwave (CDHW)
Migration Observatory.

Required raw files
------------------
raw_data/migration/
    Migration_TrackCount_1982.tif ... Migration_TrackCount_2019.tif

raw_data/events/
    tracks.geojson

raw_data/landuse/
    Cropland2000_5m.tif
    Pasture2000_5m.tif

Notes
-----
- Migration trajectories and event start years are read directly from
  raw_data/events/tracks.geojson.
- Daily_Summary_CDHW_Events.xlsx is NOT required by this script because the
  current Excel file does not contain a Date column.
- 1982–2000 and 2001–2019 raster statistics use the ORIGINAL annual raster
  grid.
- Bilinear interpolation is used ONLY to make smoother web-display rasters.
- Cropland and pasture are NOT plotted as map overlays. They are regridded
  to the native migration grid only for summary statistics.
- Population is not used.
"""

from __future__ import annotations

from pathlib import Path
import json
import re

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject


# =============================================================================
# PATHS
# =============================================================================

REPO_ROOT = Path(__file__).resolve().parents[1]

MIGRATION_DIR = REPO_ROOT / "raw_data" / "migration"
TRACKS_FILE = REPO_ROOT / "raw_data" / "events" / "tracks.geojson"

LANDUSE_DIR = REPO_ROOT / "raw_data" / "landuse"
CROPLAND_TIF = LANDUSE_DIR / "Cropland2000_5m.tif"
PASTURE_TIF = LANDUSE_DIR / "Pasture2000_5m.tif"

OUTPUT_DIR = REPO_ROOT / "data"

EARLY_YEARS = range(1982, 2001)
RECENT_YEARS = range(2001, 2020)
ALL_YEARS = range(1982, 2020)

# Display only. Change to 0.125 for a smoother but larger web raster.
DISPLAY_RES_DEG = 0.25

# Leave None for automatic robust limits.
# Example:
# DENSITY_COLOR_MAX = 20
# CHANGE_COLOR_ABS_MAX = 15
DENSITY_COLOR_MAX = None
CHANGE_COLOR_ABS_MAX = None

NODATA = -9999.0


# =============================================================================
# TRACKS / EVENT SUMMARY
# =============================================================================

def load_tracks_geojson():
    """
    Load already-prepared migration trajectories from tracks.geojson.

    The current tracks.geojson contains one feature per migration event and
    each feature has a `start_year` property. The complete FeatureCollection
    is copied to data/tracks.geojson for use by the web dashboard.
    """

    if not TRACKS_FILE.exists():
        raise FileNotFoundError(
            f"Missing:\n{TRACKS_FILE}\n\n"
            "Upload tracks.geojson to raw_data/events/."
        )

    with TRACKS_FILE.open("r", encoding="utf-8") as f:
        geojson = json.load(f)

    if geojson.get("type") != "FeatureCollection":
        raise ValueError(
            "tracks.geojson must be a GeoJSON FeatureCollection."
        )

    features = geojson.get("features", [])

    if not features:
        raise ValueError("tracks.geojson contains no features.")

    years = []

    for i, feature in enumerate(features):
        props = feature.get("properties") or {}

        if "start_year" not in props:
            raise KeyError(
                f"Feature {i} does not contain 'start_year' in properties."
            )

        try:
            year = int(props["start_year"])
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Invalid start_year in feature {i}: {props.get('start_year')!r}"
            ) from exc

        if year < 1982 or year > 2019:
            raise ValueError(
                f"start_year {year} in feature {i} is outside 1982–2019."
            )

        geometry = feature.get("geometry")
        if not geometry or geometry.get("type") not in {
            "Point",
            "LineString",
            "MultiLineString",
        }:
            raise ValueError(
                f"Feature {i} has unsupported or missing geometry: "
                f"{None if not geometry else geometry.get('type')}"
            )

        years.append(year)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Copy the exact migration trajectories to the generated dashboard data.
    with (OUTPUT_DIR / "tracks.geojson").open("w", encoding="utf-8") as f:
        json.dump(geojson, f, separators=(",", ":"))

    annual = [
        {
            "year": int(year),
            "events": int(sum(y == year for y in years)),
        }
        for year in ALL_YEARS
    ]

    early_count = int(sum(1982 <= y <= 2000 for y in years))
    recent_count = int(sum(2001 <= y <= 2019 for y in years))

    print(f"Loaded {len(features)} migration tracks.")
    print(f"Early events (1982-2000): {early_count}")
    print(f"Recent events (2001-2019): {recent_count}")

    return {
        "early_count": early_count,
        "recent_count": recent_count,
        "annual": annual,
    }


# =============================================================================
# MIGRATION RASTERS
# =============================================================================

def find_migration_files():
    files = {}

    if not MIGRATION_DIR.exists():
        raise FileNotFoundError(
            f"Missing migration directory:\n{MIGRATION_DIR}"
        )

    for p in MIGRATION_DIR.glob("Migration_TrackCount_*.tif"):
        m = re.search(r"(\d{4})$", p.stem)
        if m:
            files[int(m.group(1))] = p

    missing = [year for year in ALL_YEARS if year not in files]

    if missing:
        raise FileNotFoundError(
            "Missing annual migration rasters: "
            + ", ".join(map(str, missing))
        )

    return files


def read_raster(path):
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float64")
        profile = src.profile.copy()
        transform = src.transform
        crs = src.crs
        nodata = src.nodata

    valid = np.isfinite(arr)

    if nodata is not None and np.isfinite(nodata):
        valid &= arr != nodata

    arr = np.where(valid, arr, np.nan)

    return arr, profile, transform, crs


def check_same_grid(reference, current, year):
    rp, rt, rc = reference
    p, t, c = current

    if p["width"] != rp["width"] or p["height"] != rp["height"]:
        raise ValueError(f"Raster dimensions differ in {year}.")

    if t != rt:
        raise ValueError(f"Raster transform differs in {year}.")

    if c != rc:
        raise ValueError(f"Raster CRS differs in {year}.")


def stats(arr):
    vals = arr[np.isfinite(arr)]

    if vals.size == 0:
        return {
            "sum": 0.0,
            "mean": 0.0,
            "max": 0.0,
            "positive_cells": 0,
        }

    return {
        "sum": float(vals.sum()),
        "mean": float(vals.mean()),
        "max": float(vals.max()),
        "positive_cells": int((vals > 0).sum()),
    }


def build_period_rasters(files):
    early = []
    recent = []
    reference = None

    for year in ALL_YEARS:
        arr, profile, transform, crs = read_raster(files[year])

        if reference is None:
            reference = (profile, transform, crs)
        else:
            check_same_grid(
                reference,
                (profile, transform, crs),
                year,
            )

        if year <= 2000:
            early.append(arr)
        else:
            recent.append(arr)

    early_stack = np.stack(early)
    recent_stack = np.stack(recent)

    early_sum = np.nansum(early_stack, axis=0)
    recent_sum = np.nansum(recent_stack, axis=0)

    early_sum[np.all(~np.isfinite(early_stack), axis=0)] = np.nan
    recent_sum[np.all(~np.isfinite(recent_stack), axis=0)] = np.nan

    change = recent_sum - early_sum

    return {
        "early": early_sum,
        "recent": recent_sum,
        "change": change,
        "profile": reference[0],
        "transform": reference[1],
        "crs": reference[2],
    }


# =============================================================================
# WEB DISPLAY RASTERS
# =============================================================================

def display_grid():
    width = int(round(360.0 / DISPLAY_RES_DEG))
    height = int(round(180.0 / DISPLAY_RES_DEG))
    transform = from_origin(
        -180.0,
        90.0,
        DISPLAY_RES_DEG,
        DISPLAY_RES_DEG,
    )
    return transform, width, height


def reproject_for_display(src_array, src_transform, src_crs):
    if src_crs is None:
        raise ValueError(
            "Migration rasters have no CRS. Assign the correct CRS to the "
            "source rasters before generating the dashboard."
        )

    dst_transform, width, height = display_grid()

    dst = np.full(
        (height, width),
        NODATA,
        dtype="float32",
    )

    src = np.where(
        np.isfinite(src_array),
        src_array,
        NODATA,
    ).astype("float32")

    reproject(
        source=src,
        destination=dst,
        src_transform=src_transform,
        src_crs=src_crs,
        src_nodata=NODATA,
        dst_transform=dst_transform,
        dst_crs="EPSG:4326",
        dst_nodata=NODATA,
        resampling=Resampling.bilinear,
    )

    dst = np.where(dst == NODATA, np.nan, dst)

    return dst, dst_transform


def write_display_tif(path, array, transform):
    arr = np.where(
        np.isfinite(array),
        array,
        NODATA,
    ).astype("float32")

    profile = {
        "driver": "GTiff",
        "height": arr.shape[0],
        "width": arr.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": NODATA,
        "compress": "DEFLATE",
        "predictor": 2,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
    }

    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)


# =============================================================================
# LAND-USE SUMMARY
# =============================================================================

def regrid_landuse_to_native(path, dst_shape, dst_transform, dst_crs):
    if not path.exists():
        raise FileNotFoundError(f"Missing land-use file:\n{path}")

    if dst_crs is None:
        raise ValueError("Native migration grid has no CRS.")

    dst = np.full(
        dst_shape,
        NODATA,
        dtype="float32",
    )

    with rasterio.open(path) as src:
        if src.crs is None:
            raise ValueError(f"Land-use raster has no CRS: {path}")

        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            dst_nodata=NODATA,
            resampling=Resampling.average,
        )

    return np.where(dst == NODATA, np.nan, dst).astype("float64")


def summarize_landuse(track, weights):
    valid = (
        np.isfinite(track)
        & np.isfinite(weights)
        & (weights > 0)
    )

    if not valid.any():
        return {
            "weighted_mean": 0.0,
            "overlap_pct": 0.0,
        }

    t = track[valid]
    w = weights[valid]

    denom = float(w.sum())

    weighted_mean = (
        float(np.sum(t * w) / denom)
        if denom > 0
        else 0.0
    )

    overlap_pct = (
        float(100.0 * w[t > 0].sum() / denom)
        if denom > 0
        else 0.0
    )

    return {
        "weighted_mean": weighted_mean,
        "overlap_pct": overlap_pct,
    }


def robust_limits(early, recent, change):
    positive = np.concatenate([
        early[np.isfinite(early) & (early > 0)],
        recent[np.isfinite(recent) & (recent > 0)],
    ])

    if DENSITY_COLOR_MAX is not None:
        density_max = float(DENSITY_COLOR_MAX)
    elif positive.size:
        density_max = float(np.nanpercentile(positive, 99))
    else:
        density_max = 1.0

    absolute_change = np.abs(change[np.isfinite(change)])

    if CHANGE_COLOR_ABS_MAX is not None:
        change_max = float(CHANGE_COLOR_ABS_MAX)
    elif absolute_change.size:
        change_max = float(np.nanpercentile(absolute_change, 99))
    else:
        change_max = 1.0

    return max(density_max, 1e-9), max(change_max, 1e-9)


# =============================================================================
# MAIN
# =============================================================================

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("1/5 Reading migration trajectories from tracks.geojson...")
    event_summary = load_tracks_geojson()

    print("2/5 Building native 1982-2000 and 2001-2019 migration rasters...")
    files = find_migration_files()
    native = build_period_rasters(files)

    print("3/5 Making smooth web-display rasters...")
    early_display, display_transform = reproject_for_display(
        native["early"],
        native["transform"],
        native["crs"],
    )
    recent_display, _ = reproject_for_display(
        native["recent"],
        native["transform"],
        native["crs"],
    )
    change_display, _ = reproject_for_display(
        native["change"],
        native["transform"],
        native["crs"],
    )

    write_display_tif(
        OUTPUT_DIR / "density_1982_2000_display.tif",
        early_display,
        display_transform,
    )
    write_display_tif(
        OUTPUT_DIR / "density_2001_2019_display.tif",
        recent_display,
        display_transform,
    )
    write_display_tif(
        OUTPUT_DIR / "change_2001_2019_minus_1982_2000_display.tif",
        change_display,
        display_transform,
    )

    print("4/5 Calculating cropland/pasture summaries...")
    crop = regrid_landuse_to_native(
        CROPLAND_TIF,
        native["early"].shape,
        native["transform"],
        native["crs"],
    )
    pasture = regrid_landuse_to_native(
        PASTURE_TIF,
        native["early"].shape,
        native["transform"],
        native["crs"],
    )

    crop_early = summarize_landuse(native["early"], crop)
    crop_recent = summarize_landuse(native["recent"], crop)

    pasture_early = summarize_landuse(native["early"], pasture)
    pasture_recent = summarize_landuse(native["recent"], pasture)

    density_max, change_max = robust_limits(
        native["early"],
        native["recent"],
        native["change"],
    )

    print("5/5 Writing summary.json...")
    summary = {
        "periods": {
            "early": "1982–2000",
            "recent": "2001–2019",
        },
        "events": event_summary,
        "native_stats": {
            "early": stats(native["early"]),
            "recent": stats(native["recent"]),
            "change": stats(native["change"]),
        },
        "landuse": {
            "cropland": {
                "early_weighted_mean": crop_early["weighted_mean"],
                "recent_weighted_mean": crop_recent["weighted_mean"],
                "early_overlap_pct": crop_early["overlap_pct"],
                "recent_overlap_pct": crop_recent["overlap_pct"],
            },
            "pasture": {
                "early_weighted_mean": pasture_early["weighted_mean"],
                "recent_weighted_mean": pasture_recent["weighted_mean"],
                "early_overlap_pct": pasture_early["overlap_pct"],
                "recent_overlap_pct": pasture_recent["overlap_pct"],
            },
        },
        "display": {
            "density_color_max": density_max,
            "change_color_abs_max": change_max,
            "display_resolution_deg": DISPLAY_RES_DEG,
            "interpolation": "bilinear display only",
        },
        "files": {
            "early_density": "data/density_1982_2000_display.tif",
            "recent_density": "data/density_2001_2019_display.tif",
            "change_density": "data/change_2001_2019_minus_1982_2000_display.tif",
            "tracks": "data/tracks.geojson",
        },
    }

    with (OUTPUT_DIR / "summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    pd.DataFrame(event_summary["annual"]).to_csv(
        OUTPUT_DIR / "annual_event_counts.csv",
        index=False,
    )

    print("\nDONE")
    print("Early events:", event_summary["early_count"])
    print("Recent events:", event_summary["recent_count"])
    print("Density color max:", density_max)
    print("Change color abs max:", change_max)


if __name__ == "__main__":
    main()
