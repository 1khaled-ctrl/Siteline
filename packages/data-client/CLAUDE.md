# packages/data-client: loaders

Proposed owner: Data and missions, since they write the formats this package reads.

- This package loads 3D Tiles, PMTiles layers, horizon-mask tiles and ephemeris tables. Read each format exactly as the pipeline writes it: the pipeline is the spec, so a format change touches both in one PR.
- Horizon tiles are 16 × 16 points, each with 720 azimuths stored as int16 hundredths of a degree, gzipped. Unpack them with `DecompressionStream`.
- Ephemeris tables are Float32 binary with a JSON header (frame, start, step, kernels, checksum). Check the checksum and the frame before using one.
- Read the current data version from `manifest.json`. Paths on R2 are versioned and never change.
