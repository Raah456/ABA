// Builds dist/demo.html: the whole app (server logic + SQLite) running in one browser page with demo data.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const shims = {
  'node:sqlite': 'shim-sqlite.js', 'node:crypto': 'shim-crypto.js', 'node:fs': 'shim-fs.js',
  'node:path': 'shim-path.js', express: 'shim-express.js',
};
const shimPlugin = {
  name: 'shims',
  setup(build) {
    build.onResolve({ filter: /^(node:(sqlite|crypto|fs|path)|express)$/ }, (a) => ({ path: path.join(here, shims[a.path]) }));
  },
};
const out = await esbuild.build({
  entryPoints: [path.join(here, 'entry.js')], bundle: true, format: 'esm', write: false, minify: true,
  target: 'es2022', plugins: [shimPlugin], define: { 'process.env.DEMO_MODE': '"1"' }, logLevel: 'warning',
});
const js = out.outputFiles[0].text;
const sql = fs.readFileSync(path.join(here, '../../node_modules/sql.js/dist/sql-asm-memory-growth.js'), 'utf8');
let css = fs.readFileSync(path.join(here, '../../public/styles.css'), 'utf8');

// Theme: the viewer can force light or dark; keep "system" working too.
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkEnd = css.indexOf('\n}\n', darkStart) + 3;
const darkBlock = css.slice(darkStart, darkEnd);
const tokens = darkBlock.slice(darkBlock.indexOf('{', darkBlock.indexOf(':root')) + 1, darkBlock.lastIndexOf('}', darkBlock.lastIndexOf('}') - 1));
css = css.slice(0, darkStart)
  + `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {${tokens}}\n}\n:root[data-theme="dark"] {${tokens}}\n`
  + css.slice(darkEnd);
css += `
body { background: var(--bg); }
#app > p.muted { padding: 24px 16px; }
.demo-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; justify-content: center; padding: 7px 16px;
  background: var(--accent-soft); color: var(--accent); font-size: 0.82rem; border-bottom: 1px solid var(--border); }
.demo-bar button { background: none; border: 1px solid currentColor; color: inherit; border-radius: 6px; padding: 2px 9px; font: inherit; cursor: pointer; }

`;
const html = `<title>ABA Practice Platform</title>
<style>${css}</style>
<div class="demo-bar" role="note"><span><strong>Demo</strong> · every client and staff member is made up · your changes stay in this browser only</span><button type="button" id="reset-demo">Reset demo data</button></div>
<div id="app"><p class="muted">Loading the demo…</p></div>
<script>${sql.replace(/<\/script/gi, '<\\/script')}</script>
<script type="module">${js.replace(/<\/script/gi, '<\\/script')}
document.getElementById('reset-demo').addEventListener('click', () => window.resetDemo());</script>
`;
const outDir = path.join(here, '../../dist');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'demo.html'), html);
console.log(`Wrote dist/demo.html (${Math.round(html.length / 1024)} KB). Open it in any browser; it needs no server.`);
