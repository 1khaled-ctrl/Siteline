import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * URL prefix -> local folder, for running with a local pipeline. With DATA_BASE_URL set to the R2 bucket's public URL
 * the app reads the same files from there instead: the bucket holds pipeline/out under out/ and pipeline/raw/landfall
 * under raw/landfall/ (see .github/workflows/pipeline.yml). VITE_DATA_URL and VITE_ASSETS_URL still override each one.
 */
const MOUNTS: [string, string][] = [
  ['/data', fileURLToPath(new URL('../../pipeline/out', import.meta.url))],
  ['/landfall', fileURLToPath(new URL('../../pipeline/raw/landfall', import.meta.url))],
];

function localData(): Plugin {
  return {
    name: 'siteline-local-data',
    configureServer(server) {
      for (const [prefix, root] of MOUNTS) {
        server.middlewares.use(prefix, (req, res, next) => {
          const file = resolve(root, `.${decodeURIComponent((req.url ?? '/').split('?')[0])}`);
          if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
          res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          createReadStream(file).pipe(res);
        });
      }
    },
  };
}

/**
 * NASA's PGDA server, for LOLA's 10 m south pole terrain (the slope): it lets no other site's page read the file, so
 * the dev server passes the app's byte-range reads through to it.
 */
const PGDA_PROXY = {
  '/pgda': {
    target: 'https://pgda.gsfc.nasa.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/pgda/, ''),
  },
};

export default defineConfig(({ mode }) => {
  // Read from the shell or from apps/web/.env.local (git ignores it), with no prefix filter.
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.DATA_BASE_URL?.replace(/\/+$/, '');
  return {
    plugins: [react(), tailwindcss(), localData()],
    // The sound libraries load on the first tap and the GeoTIFF reader with the first slope, not with the app; named
    // here, the dev server bundles them up front instead of finding them mid-session and reloading the page.
    optimizeDeps: { include: ['tone', 'howler', 'geotiff'] },
    server: { proxy: PGDA_PROXY },
    // The physics worker is a module worker; built as one too, it can leave the GeoTIFF reader in a chunk of its own
    // that loads with the first slope, rather than with the app.
    worker: { format: 'es' },
    define: base
      ? {
          'import.meta.env.VITE_DATA_URL': JSON.stringify(env.VITE_DATA_URL || `${base}/out`),
          'import.meta.env.VITE_ASSETS_URL': JSON.stringify(env.VITE_ASSETS_URL || `${base}/raw/landfall`),
        }
      : {},
  };
});
