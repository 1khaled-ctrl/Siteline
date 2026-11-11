import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** URL prefix -> local folder. Deployed builds read the same paths from R2 via VITE_DATA_URL and VITE_TERRAIN_URL. */
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

export default defineConfig({
  plugins: [react(), tailwindcss(), localData()],
});
