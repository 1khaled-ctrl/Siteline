# pipeline/: Python 3.13 with uv

Owners by step: Data and missions owns fetch, inspect, align, merge, derive, tile, check and upload. Orbits owns `ephemeris.py`, and Terrain and light owns `horizon.py`.

- Every input file has a config in `configs/*.yaml` with its URL, size, sha256, licence, citation and dataset id. The fetch step verifies the checksum.
- `raw/` and `out/` never go in git. Small outputs (missions.json, regions.geojson, test points) go in `data/`.
- Use windowed reads on big rasters. Never load the 4.8 GB 10 m DEM whole.
- Run `gdalinfo` on every file first to check its projection, nodata value and scale. The 118 m LOLA GeoTIFF needs `gdal_translate -ot Float32 -unscale` before its values are metres.
- Polar data stay in LOLA's south polar stereographic grid. Use bilinear resampling for continuous values and nearest for masks.
- Every run writes a manifest listing its inputs, checksums, licences and git commit.
- Upload to R2 under a new versioned path (`/vN/...`) with `Cache-Control: public, max-age=31536000, immutable`. Never overwrite a published version.
- Use Ruff, mypy and pytest. Golden values written to `tests/reference/` come from SPICE or published papers, and the script that produced them is committed alongside.
