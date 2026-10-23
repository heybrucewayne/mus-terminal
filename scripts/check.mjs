import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';

for (const directory of ['api','assets','scripts','tests']) {
  for (const name of await readdir(directory)) {
    if (!/\.m?js$/.test(name)) continue;
    const result = spawnSync(process.execPath,['--check',`${directory}/${name}`],{encoding:'utf8'});
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  }
}
const html = await readFile('index.html','utf8');
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
for (const match of html.matchAll(/(?:src|href)="(assets\/[^"#]+)"/g)) await readFile(match[1]);
console.log('All JavaScript syntax and HTML asset references passed.');
