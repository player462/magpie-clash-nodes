/**
 * Build page/index.html from template + bridge.js + app.js.
 *
 * Two magpie surfaces need different script delivery:
 *  - Desktop app: magpie inlines the relative <script src> and its CSP hashes
 *    match, so the native path works. It may not allow `script-src data:`.
 *  - `magpie web`: the inliner appends a newline to inlined text while hashing
 *    the raw file, so those scripts are blocked; its CSP does allow data:.
 *
 * So the page ships the native relative scripts first, plus one data: URL
 * bootstrap that only fires when `window.magpie` is missing (i.e. the native
 * scripts were blocked). Where data: is disallowed the bootstrap is simply
 * ignored and the native path stands. Re-run after editing app.js/template.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(dir, 'page');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const read = (f) => fs.readFileSync(path.join(page, f), 'utf8');

const boot = [
  '(function(){if(window.magpie)return;',
  "var b=document.createElement('script');",
  `b.src='data:text/javascript;base64,${b64(read('bridge.js'))}';`,
  `var a=document.createElement('script');`,
  `a.src='data:text/javascript;base64,${b64(read('app.js'))}';`,
  'b.onload=function(){document.body.appendChild(a);};',
  'b.onerror=function(){reportMissing();};',
  'document.head.appendChild(b);',
  'function reportMissing(){var s=document.getElementById("status");if(s){s.textContent="脚本被页面安全策略拦截（native 与 data: 都不可用）";s.className="cn-status bad";}}',
  '})();',
].join('\n');

const html = read('template.html').replace(
  '__FALLBACK__',
  `data:text/javascript;base64,${b64(boot)}`,
);
fs.writeFileSync(path.join(page, 'index.html'), html);
console.log('built page/index.html', Buffer.byteLength(html), 'bytes');
