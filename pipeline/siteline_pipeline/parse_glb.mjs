// Parses model files the way the app does: `node parse_glb.mjs <file.json> ...`
//
// Each file is JSON holding one base64 string of a binary glTF, `{"b64": "..."}`. Like packages/engine/src/modelView.ts,
// this decodes it and hands it to three.js's GLTFLoader.parse with no Draco, Meshopt or KTX2 decoder. The three.js is
// the one packages/engine depends on (after `pnpm install`), or, on a machine without the app's packages, the one in
// the folder THREE_DIR names, which must be the same version. Node has no image decoder, so images are not decoded:
// their bytes are checked to be the type the file says, and each becomes an empty texture. Everything else (geometry,
// quantisation, materials, extensions) goes through the loader as in the browser.
//
// Prints one JSON line per file, {"file", "ok", "error", "meshes", "triangles"}, and exits 1 if any file failed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePackage = path.resolve(here, '../../packages/engine/package.json');
const wanted = JSON.parse(readFileSync(enginePackage, 'utf8')).dependencies.three;

function threeDir() {
  if (process.env.THREE_DIR) return path.resolve(process.env.THREE_DIR);
  try {
    return path.dirname(path.dirname(createRequire(enginePackage).resolve('three')));
  } catch {
    console.error(
      `three.js is not installed for packages/engine: run "corepack pnpm install", or set THREE_DIR to a folder holding three@${wanted}`,
    );
    process.exit(2);
  }
}

const dir = threeDir();
const version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
if (version !== wanted) {
  console.error(`three.js in ${dir} is ${version}; the app uses ${wanted}`);
  process.exit(2);
}
const THREE = await import(pathToFileURL(path.join(dir, 'build/three.module.js')).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(dir, 'examples/jsm/loaders/GLTFLoader.js')).href);

const MAGIC = {
  'image/webp': (b) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8,
};

/** Images are checked, not decoded: Node cannot decode them, and the browser's decoding is not what is being tested. */
function noImageDecoding(parser) {
  parser.loadImageSource = async (sourceIndex) => {
    const image = parser.json.images[sourceIndex];
    if (image.bufferView === undefined) throw new Error(`image ${sourceIndex} is not inside the file`);
    const view = await parser.getDependency('bufferView', image.bufferView);
    const check = MAGIC[image.mimeType];
    if (!check) throw new Error(`image ${sourceIndex} is ${image.mimeType ?? 'of no type'}`);
    if (!check(new Uint8Array(view))) throw new Error(`image ${sourceIndex} is not the ${image.mimeType} it says it is`);
    return new THREE.Texture();
  };
  return { name: 'siteline_no_image_decoding' };
}

async function parse(file) {
  const holder = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof holder?.b64 !== 'string' || Object.keys(holder).length !== 1) throw new Error('the file is not {"b64": "..."}');
  // As modelView.ts does: atob, then the bytes' buffer.
  const buffer = Uint8Array.from(atob(holder.b64), (c) => c.charCodeAt(0)).buffer;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const loader = new GLTFLoader();
    loader.register(noImageDecoding);
    const gltf = await new Promise((resolve, reject) => loader.parse(buffer.slice(0), '', resolve, reject));
    // The loader only warns about a required extension it does not know; the app would then show it wrongly.
    const unknown = warnings.find((w) => w.includes('Unknown extension'));
    if (unknown) throw new Error(unknown);
    let meshes = 0;
    let triangles = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes += 1;
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    if (meshes === 0) throw new Error('the scene has no meshes');
    return { meshes, triangles };
  } finally {
    console.warn = warn;
  }
}

let failed = false;
for (const file of process.argv.slice(2)) {
  try {
    const { meshes, triangles } = await parse(file);
    console.log(JSON.stringify({ file, ok: true, error: null, meshes, triangles }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ file, ok: false, error: String(error?.message ?? error), meshes: 0, triangles: 0 }));
  }
}
process.exit(failed ? 1 : 0);
