import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkPagesBuild(directory = 'dist/client') {
  const root = resolve(directory);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  if (!scripts.length || scripts.some((src) => !/^\/assets\/[^?#]+\.js(?:[?#].*)?$/.test(src))) {
    throw new Error(
      'Pages must publish the compiled dist/client directory, never /src/main.tsx or the repository root.',
    );
  }
  for (const source of scripts) statSync(join(root, source.split(/[?#]/)[0]));
  let files = 0;
  function inspect(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) throw new Error(`A deployment artifact cannot be a symlink: ${name}`);
      if (
        ['server', 'data', '.git', 'node_modules', 'tests', 'e2e'].includes(entry.name) ||
        entry.name.startsWith('.env')
      ) {
        throw new Error(`Private/source material found in the Pages output: ${name}`);
      }
      if (entry.isDirectory()) inspect(path);
      else {
        if (
          ['.ts', '.tsx', '.sqlite', '.sql', '.pem', '.key'].includes(extname(name)) ||
          /\.sqlite-(?:wal|shm)$/.test(name)
        ) {
          throw new Error(`Do not publish private or uncompiled files: ${name}`);
        }
        files++;
      }
    }
  }
  inspect(root);
  return { directory: root, files, compiled_entrypoints: scripts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkPagesBuild(process.argv[2]), null, 2));
}
