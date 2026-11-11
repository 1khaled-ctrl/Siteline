# packages/engine: the three.js scene

Owner: 3D world.

- Plain three.js, mounted inside one React component. No react-three-fiber.
- Keep positions as float64 kilometres on the CPU. Each frame, subtract the camera position before writing 32-bit values for the GPU (a floating origin), and keep the logarithmic depth buffer on. Jitter usually means some helper or the picking code skipped this.
- Talk to the UI only through the shared store's four events: `site/selected`, `time/changed`, `layer/toggled` and `camera/flyTo`.
- Far view: one globe per world with colour, height and normal maps. Near view: 3D Tiles through 3d-tiles-renderer. The globe shader hides the area under loaded tiles.
- Picking: a three-mesh-bvh ray cast returns `{ latDeg, lonDeg, heightM }`.
- Fly-to takes 2 to 4 seconds, eases in and out, and never passes through the ground. With `prefers-reduced-motion` it becomes a cut.
- Budgets:
  - 30 fps on a mid-range laptop at 1080p.
  - GPU memory under 1 GB on laptops and under 400 MB on phones.
  - Tile cache under 1 GB on laptops and under 256 MB on phones. Dispose geometries and textures when tiles unload.
- Load MapLibre, the models and other heavy pieces on demand. First-load JavaScript stays under 400 KB gzipped.
