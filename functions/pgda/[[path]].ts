/**
 * The slope reads LOLA's 10 m south pole terrain from NASA's PGDA server, a few tiles at a time. NASA lets no other
 * site's page read the file (no CORS), so on the deployed site (Cloudflare Pages) the app's byte-range reads come here
 * and pass through, as the dev server's proxy does for `corepack pnpm dev` (apps/web/vite.config.ts). Only that one
 * file, and only reads. It sits at the repository's root because the Pages project builds from there.
 */
const ORIGIN = 'https://pgda.gsfc.nasa.gov';
const FILE = '/data/LOLA_20mpp/LDEM_83S_10MPP_ADJ.TIF';
const PASSED = ['Accept-Ranges', 'Content-Length', 'Content-Range', 'Content-Type', 'ETag', 'Last-Modified'];

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (new URL(request.url).pathname !== `/pgda${FILE}`) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const range = request.headers.get('Range');
  const upstream = await fetch(`${ORIGIN}${FILE}`, {
    method: request.method,
    headers: range ? { Range: range } : {},
    // The file is 5.1 GB: going round Cloudflare's cache keeps it from fetching all of it to answer one range.
    cache: 'no-store',
  });
  const headers = new Headers();
  for (const name of PASSED) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The file never changes, so the browser keeps the tiles it has read; a failure is never kept.
  if (upstream.ok) headers.set('Cache-Control', 'public, max-age=604800, immutable');
  return new Response(upstream.body, { status: upstream.status, headers });
}
