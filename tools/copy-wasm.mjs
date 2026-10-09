// Copies the MediaPipe runtime out of node_modules into public/ so the app
// can be hosted as plain static files, with nothing fetched from a CDN.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'mediapipe');

await mkdir(to, { recursive: true });
const wanted = (await readdir(from)).filter(
  (name) => name.startsWith('vision_wasm_internal') || name.startsWith('vision_wasm_nosimd_internal'),
);
await Promise.all(wanted.map((name) => cp(join(from, name), join(to, name))));
console.log(`mediapipe runtime: ${wanted.length} files -> public/mediapipe`);
