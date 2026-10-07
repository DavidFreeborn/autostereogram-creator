// Refresh the website's shared shell from a local checkout, without touching the editor.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const site = process.argv[2];
if (!site) throw new Error('Pass the website checkout path.');
const font = await readFile(path.join(site, 'public/fonts/eb-garamond/eb-garamond-v33-normal-latin.woff2'));
const shared = await readFile(path.join(site, 'src/styles/tool-shell.css'), 'utf8');
const custom = `/* Tool-specific styles */
:root { --paper:#fff; --ink:#222; --muted:#61666b; --rule:#d0d0d0; --serif:var(--tool-serif); --sans:var(--tool-sans); }
.tool-page #stage { height:calc(100dvh - 254px); }
.tool-page #stage.has-tool-options { height:calc(100dvh - 313px); }
.tool-page .tool-methodology { margin:16px 20px; padding:12px 0; max-width:76ch; }
.tool-page .tool-methodology summary { font-weight:400; }
.tool-page .tool-methodology a { color:var(--accent); }
@media(max-width:820px) {
  .tool-page h1 { font-size:26px; }
  .tool-page #stage { height:clamp(340px,58dvh,620px); }
  .tool-page #stage.has-tool-options { height:clamp(310px,51dvh,560px); }
}
@media(max-width:600px) { .tool-page .app-header h1 { font-size:25px; } }
`;
const shell = `<style id="tool-shell">@font-face{font-family:"EB Garamond";font-style:normal;font-weight:400 800;font-display:swap;src:url(data:font/woff2;base64,${font.toString('base64')}) format("woff2");}\n${shared.trim()}\n${custom}</style>`;
let html = await readFile('index.html', 'utf8');
html = html.includes('<style id="tool-shell">')
  ? html.replace(/<style id="tool-shell">[\s\S]*?<\/style>/, () => shell)
  : html.replace('</head>', () => `${shell}\n</head>`);
await writeFile('index.html', html);
await writeFile('EB-GARAMOND-OFL.txt', await readFile(path.join(site, 'public/fonts/eb-garamond/OFL.txt')));
console.log('Updated shared tool shell and bundled font licence.');
