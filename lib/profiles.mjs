// Read every subscription Clash Party keeps, not only the active one, and
// merge their `proxies:` lists into one catalogue our own mihomo instance can
// serve. Profile YAML is subscription output: either block style
//
//   proxies:
//     - name: 香港01
//       type: hysteria2
//
// or flow style (common for remote subscriptions):
//
//   proxies:
//     - { name: '香港01', type: hysteria2, server: ..., port: 40001 }
//
// We only need each item's raw text and its name/type, then rewrite the name
// with a per-subscription prefix so two airports may both have "香港01".
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isAdNode, regionOf } from './nodes.mjs';

export function mihomoPartyDir() {
  return process.env.MIHOMO_PARTY_DIR ||
    path.join(os.homedir(), 'AppData', 'Roaming', 'mihomo-party');
}
export function profilesDir() { return path.join(mihomoPartyDir(), 'profiles'); }
export function profileIndexPath() { return path.join(mihomoPartyDir(), 'profile.yaml'); }

/** Subscription list from profile.yaml, in file order. */
export function listProfiles() {
  let text = '';
  try { text = fs.readFileSync(profileIndexPath(), 'utf8'); } catch { return []; }
  const current = (text.match(/^current:\s*(\S+)/m) || [])[1] || '';
  const items = [];
  const re = /^\s*-\s+id:\s*(\S+)\s*\r?\n\s*name:\s*([^\r\n]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1].trim();
    let name = m[2].trim().replace(/^['"]|['"]$/g, '');
    const file = path.join(profilesDir(), `${id}.yaml`);
    let exists = false;
    let updatedAt = 0;
    try { const st = fs.statSync(file); exists = st.isFile(); updatedAt = st.mtimeMs; } catch { exists = false; }
    if (!exists) continue;
    items.push({ id, name, file, updatedAt, active: id === current });
  }
  // disambiguate duplicate subscription names (two "一元机场")
  const seen = {};
  for (const p of items) {
    const base = p.name || p.id;
    seen[base] = (seen[base] || 0) + 1;
    p.label = seen[base] > 1 ? `${base} (${seen[base]})` : base;
  }
  return items;
}

/** Split the raw `proxies:` section into one string per list item. */
export function extractProxies(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  if (start < 0) return [];
  const items = [];
  let cur = null;
  let curIndent = '';
  const push = () => { if (cur !== null) { items.push(cur); cur = null; } };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;      // next top-level key
    if (!line.trim()) { if (cur !== null) cur += '\n' + line; continue; }
    const item = line.match(/^(\s*)-\s+/);
    if (item) {
      // a new item starts at the list's own indent, not a nested list
      if (cur === null || item[1].length <= curIndent.length) {
        push();
        curIndent = item[1];
        cur = line;
        continue;
      }
    }
    if (cur !== null) cur += '\n' + line;
  }
  push();
  // flow items are one line; strip trailing blanks
  return items.map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim());
}

function unquote(s) {
  s = String(s || '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}
function quoteYaml(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/** name/type of one raw item, flow or block style. */
export function proxyMeta(raw) {
  const first = raw.split(/\r?\n/)[0];
  const flow = /^\s*-\s*\{/.test(first);
  const scope = flow ? first : raw;
  const nameM = flow
    ? scope.match(/\bname:\s*'((?:[^']|'')*)'/) || scope.match(/\bname:\s*"([^"]*)"/) || scope.match(/\bname:\s*([^,}]+)/)
    : scope.match(/^\s*-\s*name:\s*(.+)$/m);
  const typeM = flow
    ? scope.match(/\btype:\s*([^,}\s]+)/)
    : scope.match(/^\s+type:\s*(.+)$/m);
  return {
    flow,
    name: unquote(nameM ? (nameM[1] || nameM[2] || nameM[3] || '') : ''),
    type: typeM ? unquote(typeM[1]) : '',
  };
}

/** Rewrite the item's name in place. */
export function renameProxy(raw, newName) {
  const first = raw.split(/\r?\n/)[0];
  if (/^\s*-\s*\{/.test(first)) {
    const replaced = first.replace(/(\bname:\s*)(?:'(?:[^']|'')*'|"[^"]*"|[^,}]+)/, `$1${quoteYaml(newName)}`);
    return [replaced, ...raw.split(/\r?\n/).slice(1)].join('\n');
  }
  return raw.replace(/^(\s*-\s*name:\s*).+$/m, `$1${quoteYaml(newName)}`);
}

/**
 * Normalize one raw list item to exactly two spaces of indentation under
 * `proxies:`. Different airports indent their list items differently (0/2/4
 * spaces); concatenating raw blocks from several profiles then produces
 * invalid YAML such as `- {…}\n    - {…}`. Nested lines keep their relative
 * indentation to the item marker.
 */
export function normalizeProxyBlock(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!lines.length || !lines[0].trim()) return '';
  const indentOf = (line) => (line.match(/^\s*/) || [''])[0].length;
  const base = indentOf(lines[0]);
  return lines.map((line, i) => {
    if (!line.trim()) return '';
    if (i === 0) return '  ' + line.trimStart();
    const extra = Math.max(0, indentOf(line) - base);
    return '  ' + ' '.repeat(extra) + line.trimStart();
  }).join('\n');
}

/**
 * One subscription's usable nodes.
 * Returns [{ name (prefixed), originalName, type, region, profileId, profileName, raw }]
 */
export function profileNodes(profile) {
  let text = '';
  try { text = fs.readFileSync(profile.file, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const raw of extractProxies(text)) {
    const meta = proxyMeta(raw);
    if (!meta.name || !meta.type) continue;
    if (isAdNode(meta.name)) continue;
    const name = `${profile.label} · ${meta.name}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      originalName: meta.name,
      type: meta.type,
      region: regionOf(meta.name),
      profileId: profile.id,
      profileName: profile.label,
      raw: normalizeProxyBlock(renameProxy(raw, name)),
    });
  }
  return out;
}

/** Merge selected subscriptions. `ids` empty = all. */
export function loadCatalogue(ids = []) {
  const all = listProfiles();
  const chosen = ids.length ? all.filter((p) => ids.includes(p.id)) : all;
  const chosenIds = new Set(chosen.map((p) => p.id));
  const nodes = [];
  const blocks = [];
  const counts = {};
  for (const p of all) {
    const list = profileNodes(p);
    counts[p.id] = list.length;
    if (!chosenIds.has(p.id)) continue;
    for (const n of list) {
      nodes.push(n);
      blocks.push(n.raw);
    }
  }
  nodes.sort((a, b) =>
    a.profileName.localeCompare(b.profileName, 'zh') ||
    a.region.localeCompare(b.region, 'zh') ||
    a.name.localeCompare(b.name, 'zh'));
  return { profiles: all, chosen: chosen.map((p) => p.id), nodes, blocks, counts };
}
