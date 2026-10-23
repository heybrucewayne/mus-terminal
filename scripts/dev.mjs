import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.png':'image/png', '.jpeg':'image/jpeg', '.svg':'image/svg+xml' };
const apiNames = new Set(['market','quote','history','economic','forecast','trenches']);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!apiNames.has(name)) { response.writeHead(404); response.end('Not found'); return; }
      const { default:handler } = await import(pathToFileURL(resolve(root,'api',`${name}.js`)).href);
      request.query = Object.fromEntries(url.searchParams);
      response.status = code => { response.statusCode = code; return response; };
      response.json = payload => { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(payload)); };
      await handler(request, response);
      return;
    }
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405,{Allow:'GET, HEAD'}); response.end(); return; }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(root, '.' + pathname);
    const relative = path.slice(root.length + 1);
    // The preview server must never expose .env, source tests or system files.
    if (!path.startsWith(root + sep) || relative.split(sep).some(part => part.startsWith('.'))
      || !['index.html','favicon.png'].includes(relative) && !relative.startsWith('assets' + sep) && !relative.startsWith('backgrounds' + sep)) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const content = await readFile(path);
    response.writeHead(200,{'Content-Type':(types[extname(path)] || 'application/octet-stream') + (['.html','.js','.css','.mjs'].includes(extname(path)) ? '; charset=utf-8' : ''),'Cache-Control':'no-store'});
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end('Request could not be completed');
  }
}).listen(port,'127.0.0.1', () => console.log(`MUS Terminal 2.0 · http://127.0.0.1:${port}`));
