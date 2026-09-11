Global Migration Dataset

Overview
This directory contains annual gridded datasets of compound drought–heatwave (CDHW) migration track counts for the period 1982–2019.

The dataset consists of 38 annual GeoTIFF files, with one raster for each year. The annual rasters were generated from the processed 5° × 5° migration-track-count dataset used in the CDHW migration analysis.

Directory
Global_Migration_Dataset/

Files
Annual files follow the naming convention:

Migration_TrackCount_YYYY.tif

where YYYY is the corresponding year.

Examples:
Migration_TrackCount_1982.tif
Migration_TrackCount_1983.tif
Migration_TrackCount_1984.tif
...
Migration_TrackCount_2018.tif
Migration_TrackCount_2019.tif

A total of 38 GeoTIFF files are provided.

Variable
Migration Track Count

The raster value represents the number of identified CDHW migration tracks associated with each 5° × 5° geographical grid cell during the corresponding year.

A value of 0 indicates that no migration track was recorded for that grid cell during that year.

Spatial Information
Coordinate reference system: WGS 84 / EPSG:4326
Spatial resolution: 5° × 5°
Coordinate system: geographic longitude–latitude
Longitude units: degrees east
Latitude units: degrees north
Raster format: GeoTIFF (.tif)

The longitude and latitude coordinates of the original tabular dataset represent the centers of the corresponding 5° × 5° grid cells.

Temporal Coverage
1982–2019

Temporal resolution: annual

Each GeoTIFF represents migration-track counts for a single year.

Missing Data
Missing or unavailable raster cells are encoded using:

-9999

This value should be treated as NoData and should not be interpreted as zero migration activity.

Source Data
The annual GeoTIFF files were generated from the processed migration-track-count table:

TrackCount.xlsx

The source table contains grid-cell coordinates followed by annual migration-track counts:

Longitude | Latitude | 1982 | 1983 | ... | 2019

Data Processing
For each year:
1. Annual migration-track counts were extracted from TrackCount.xlsx.
2. Values were assigned to their corresponding 5° × 5° longitude–latitude grid cells.
3. Grid-cell coordinates were treated as cell centers.
4. The annual grid was exported as a georeferenced GeoTIFF in EPSG:4326.
5. Missing grid cells were assigned the NoData value -9999.


Software Compatibility
The GeoTIFF files can be opened with standard GIS and scientific software, including QGIS, ArcGIS Pro, Python (rasterio, xarray, rioxarray), R (terra, raster), MATLAB, and GDAL-compatible software.

Citation
When using these data, please cite the associated research article and dataset DOI.

Contact
For questions regarding the data, processing, or interpretation, please contact amitesh@tamu.edu or amiteshsabut7@gmail.com.
