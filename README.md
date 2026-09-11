# Global Compound Drought–Heatwave Migration Observatory

This repository is configured so that **GitHub itself preprocesses the GeoTIFFs and deploys the dashboard**. You do not need to run the preprocessing script on your computer.

## Dashboard comparison

- **Early period:** 1982–2000
- **Recent period:** 2001–2019
- **Change:** 2001–2019 minus 1982–2000

The dashboard provides a draggable period-comparison map, a recent-minus-early change map, annual 1982–2019 trend, population/cropland/pasture context layers, opacity controls, continent zooms, and grid-cell inspection.

## Put your data in these three folders

### `raw_data/migration/`

Copy:

```text
Migration_TrackCount_1982.tif
Migration_TrackCount_1983.tif
...
Migration_TrackCount_2019.tif
```

### `raw_data/population/`

Copy the GPW 2000 GeoTIFF whose filename begins with:

```text
gpw_v4_population_count_rev11_2000
```

### `raw_data/landuse/`

Copy:

```text
Cropland2000_5m.tif
Pasture2000_5m.tif
```

## Upload to GitHub

Upload the **contents of this folder to the root of one GitHub repository**.

Then open:

**Settings → Pages → Source → GitHub Actions**

The included workflow `.github/workflows/deploy-pages.yml` automatically:

1. installs the Python dependencies;
2. sums annual migration rasters for 1982–2000;
3. sums annual migration rasters for 2001–2019;
4. calculates recent minus early;
5. prepares web display copies of population/cropland/pasture;
6. generates `summary.json` and `annual_summary.csv`;
7. deploys the finished dashboard to GitHub Pages.

## Important

The GeoTIFF source data are **not bundled in this ZIP** because they are currently only on your local `D:` drive and were not uploaded to this ChatGPT conversation.

Once those rasters are copied into `raw_data/`, the repository is designed to be uploaded directly to GitHub.
