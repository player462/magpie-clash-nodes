/**
 * magpie plugin host for the Clash nodes page/panel.
 *
 * The page and the provider panel run in magpie's sandboxed iframes: no fetch,
 * no inline scripts, no frames of their own. Their only channel to us is
 * `magpie.options.set()` (which reloads this host). So:
 *
 *   page  --options.set({cmd, cmdId})-->  magpie  -->  this host restarts
 *   host  --executes cmd, rewrites page/state.js + panel/state.js-->  page
 *   page  --<script src="state.js?v=…">-->  fresh state
 *
 * `cmdId` is deduplicated by plugin-last-cmd.json, so a reload never repeats
 * a command. All the real work (mihomo named-pipe controller, per-node
 * listeners, providers.json) lives in ./lib — the same zero-dependency code
 * the standalone clash-nodes CLI uses. Bun supports node:net pipes here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from './lib/controller.mjs';
import * as router from './lib/router.mjs';
import * as magpie from './lib/magpie.mjs';
import * as accountsLib from './lib/accounts.mjs';
import * as profiles from './lib/profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(magpie.magpieDir(), 'clash-nodes');
const STATE_JSON = path.join(DIR, 'plugin-state.json');
const LAST_CMD = path.join(DIR, 'plugin-last-cmd.json');
const STATE_FILES = [path.join(HERE, 'page', 'state.js')];
const PROFILES_FILE = path.join(DIR, 'profiles.json');
const DELAYS_FILE = path.join(DIR, 'delays.json');
const PORTS_MIGRATED = path.join(DIR, 'ports-v2.flag');

const now = () => new Date().toISOString();

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function writeStateJs(state) {
  const text = `window.__CLASH_NODES_STATE__ = ${JSON.stringify(state)};\n`;
  for (const file of STATE_FILES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

// The user's checked pool of usable nodes, kept across restarts. Empty = all.
const POOL_FILE = path.join(DIR, 'pool.json');
function readPool() {
  const j = readJson(POOL_FILE, {});
  return Array.isArray(j.nodes) ? j.nodes.filter((n) => typeof n === 'string' && n) : [];
}
function writePool(names) { writeJson(POOL_FILE, { nodes: names, at: Date.now() }); }

// Which Clash Party subscriptions take part. Missing file = only the active one.
function readSelectedProfiles() {
  const j = readJson(PROFILES_FILE, null);
  if (j && Array.isArray(j.profiles)) return j.profiles.filter((x) => typeof x === 'string');
  const all = profiles.listProfiles();
  const act = all.find((p) => p.active);
  if (!act) return [];
  // Freeze the first choice: a later change of Clash's active profile must not
  // silently move which subscription this plugin serves.
  writeSelectedProfiles([act.id]);
  return [act.id];
}
function writeSelectedProfiles(ids) { writeJson(PROFILES_FILE, { profiles: ids, at: Date.now() }); }

// Older versions used bare node names; multi-subscription names are prefixed
// ("一元机场 · 香港01"). Carry the old port and pool choices over so saved
// account proxies keep pointing at the same physical node.
function migrateLegacyNames(cat) {
  try {
    const active = (cat.profiles.find((p) => p.active) || {}).id || '';
    const byOrig = new Map();
    for (const n of cat.nodes) {
      const cur = byOrig.get(n.originalName);
      if (!cur || n.profileId === active) byOrig.set(n.originalName, n.name);
    }
    const pf = router.portsPath();
    const ports = readJson(pf, {});
    let changed = false;
    for (const n of cat.nodes) {
      if (ports[n.name] === undefined && ports[n.originalName] !== undefined) {
        ports[n.name] = ports[n.originalName];
        changed = true;
      }
    }
    if (changed) writeJson(pf, ports);
    const pool = readPool();
    if (pool.length) {
      const next = pool.map((x) => byOrig.get(x) || x);
      if (next.join('\u0000') !== pool.join('\u0000')) writePool(next);
    }
  } catch { /* migration is best effort */ }
}

// One-time repair of ports.json. Older versions stored bare node names; the
// first multi-subscription attempt also allocated prefixed names on top of
// them. Keep only the legacy port each active-subscription node had, so the
// URLs already written into magpie's accountProxies still reach that node.
function ensurePortsMigrated(cat) {  if (fs.existsSync(PORTS_MIGRATED)) return;
  try {
    const pf = router.portsPath();
    const ports = readJson(pf, {});
    const legacy = {};
    for (const [k, v] of Object.entries(ports)) if (!k.includes('·')) legacy[k] = v;
    if (Object.keys(legacy).length) {
      const active = (cat.profiles.find((p) => p.active) || {}).id || '';
      const next = {};
      for (const n of cat.nodes) {
        if (n.profileId === active && legacy[n.originalName] !== undefined) next[n.name] = legacy[n.originalName];
      }
      writeJson(pf, next);
    }
    fs.writeFileSync(PORTS_MIGRATED, new Date().toISOString());
  } catch { /* best effort */ }
}

function loadCatalogue() {
  let cat;
  try { cat = profiles.loadCatalogue(readSelectedProfiles()); }
  catch { cat = { profiles: [], chosen: [], nodes: [], blocks: [] }; }
  if (cat.nodes.length) { ensurePortsMigrated(cat); migrateLegacyNames(cat); }
  return cat;
}
function readDelays() { return readJson(DELAYS_FILE, {}); }
function writeDelays(map) { writeJson(DELAYS_FILE, map); }

// Starting one listener per node of a 700-node subscription would cost far
// more than it is worth. When nothing is checked, cap the default pool and
// balance it across subscriptions instead of taking the first N alphabetically.
const MAX_DEFAULT_LISTENERS = 120;
function effectivePool(pool, nodes) {
  const list = (nodes || []).map((x) => (typeof x === 'string' ? { name: x, profile: '' } : x));
  const names = list.map((x) => x.name);
  if (pool.length) {
    const eff = pool.filter((n) => names.includes(n));
    return eff.length ? eff : names;
  }
  if (names.length <= MAX_DEFAULT_LISTENERS) return names;
  const groups = new Map();
  for (const n of list) {
    const k = n.profile || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n.name);
  }
  const out = [];
  for (let i = 0; out.length < MAX_DEFAULT_LISTENERS; i++) {
    let added = false;
    for (const arr of groups.values()) {
      if (i < arr.length) {
        out.push(arr[i]);
        added = true;
        if (out.length >= MAX_DEFAULT_LISTENERS) break;
      }
    }
    if (!added) break;
  }
  return out;
}

async function collect(c, error) {
  let st = null;
  try { st = await c.state(); } catch (e) { if (!error) error = e?.message || String(e); }
  let r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // never report a dead instance as ready — clear the stale state file
    await router.stopRouter({ quiet: true }).catch(() => {});
    r = router.routerStatus();
  }
  const cat = loadCatalogue();
  const useProfiles = cat.nodes.length > 0;
  const delayMap = readDelays();
  const nodes = useProfiles
    ? cat.nodes.map((n) => ({
        name: n.name, originalName: n.originalName, type: n.type, region: n.region, alive: true,
        delay: typeof delayMap[n.name] === 'number' ? delayMap[n.name] : null,
        profile: n.profileName, profileId: n.profileId,
      }))
    : (st ? st.nodes : []);
  const pool = readPool();
  const currentNames = nodes.map((n) => n.name);
  const eff = effectivePool(pool, nodes);
  const poolTruncated = !pool.length && nodes.length > MAX_DEFAULT_LISTENERS;
  const drift = pool.length ? {
    missing: pool.filter((n) => !currentNames.includes(n)),
    added: currentNames.filter((n) => !pool.includes(n)),
  } : { missing: [], added: [] };
  const staleInstance = r.running &&
    JSON.stringify(Object.keys(r.mapping || {}).sort()) !== JSON.stringify(eff.slice().sort());
  let providers = [];
  try { providers = magpie.describe(magpie.readProviders(), r.mapping || {}); } catch { /* magpie absent */ }
  let accounts = [];
  try {
    const list = accountsLib.readAccountCache() || accountsLib.listAccounts();
    accounts = accountsLib.describeAccounts(list, r.mapping || {});
  } catch { /* no accounts */ }
  return {
    generatedAt: now(),
    controller: await c.target().catch(() => null),
    version: await c.version().catch(() => ''),
    mainGroup: st ? st.mainGroup : '',
    current: st ? (st.groups.find((g) => g.name === st.mainGroup)?.now || '') : '',
    groups: st ? st.groups.map((g) => ({ name: g.name, type: g.type, now: g.now, nodes: g.nodes })) : [],
    profiles: cat.profiles.map((p) => ({ id: p.id, label: p.label, active: p.active, updatedAt: p.updatedAt || 0 })),
    profileChosen: cat.chosen,
    multiProfile: useProfiles,
    nodes,
    pool,
    poolEffective: eff,
    poolTruncated,
    drift,
    staleInstance,
    router: r,
    providers,
    accounts,
    error: error || null,
  };
}

/** Node ports must exist, be alive, and match the pool before an assignment lands. */
/** Running instance already serves exactly these names on their saved ports? */
function mappingMatches(r, names) {
  if (!r.running) return false;
  const map = r.mapping || {};
  if (JSON.stringify(Object.keys(map).sort()) !== JSON.stringify(names.slice().sort())) return false;
  const desired = readJson(router.portsPath(), {});
  return names.every((n) => desired[n] === undefined || map[n] === desired[n]);
}

async function ensureRouter(c) {
  const cat = loadCatalogue();
  let sourceNodes;
  let blockMap = null;
  if (cat.nodes.length) {
    sourceNodes = cat.nodes;
    blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
  } else {
    const st = await c.state();
    sourceNodes = st.nodes;
  }
  const eff = effectivePool(readPool(), sourceNodes);
  const r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // state file says running but the mihomo died: clear the lie, respawn
    await router.stopRouter({ quiet: true }).catch(() => {});
  } else if (mappingMatches(r, eff)) {
    return r;
  } else if (r.running) {
    await router.stopRouter({ quiet: true }).catch(() => {});
  }
  const proxyBlocks = blockMap ? eff.map((n) => blockMap[n]).filter(Boolean) : undefined;
  return await router.startRouter(eff, { proxyBlocks });
}

async function execute(cmd, c) {
  let r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    await router.stopRouter({ quiet: true }).catch(() => {});
    r = router.routerStatus();
  }
  switch (cmd.do) {
    case 'refresh':
      return { ok: true, message: '已刷新', at: now() };

    case 'select': {
      const group = await c.selectMain(cmd.node, cmd.group);
      if (cmd.drop) await c.dropConnections();
      return { ok: true, message: `已切换 ${group} → ${cmd.node}`, at: now() };
    }

    case 'test': {
      const rr = await ensureRouter(c);
      const names = Object.keys(rr.mapping || {});
      const delays = await router.testDelays(names, { controllerPort: rr.controllerPort, concurrency: 8 });
      writeDelays({ ...readDelays(), ...delays });
      const ok = Object.values(delays).filter((v) => typeof v === 'number').length;
      return { ok: true, message: `测速完成：${ok}/${names.length} 个节点可用`, at: now() };
    }

    case 'start': {
      const cat = loadCatalogue();
      const sourceNodes = cat.nodes.length ? cat.nodes : (await c.state()).nodes;
      const currentNames = sourceNodes.map((n) => n.name);
      const names = cmd.nodes?.length
        ? cmd.nodes.filter((n) => currentNames.includes(n))
        : effectivePool(readPool(), sourceNodes);
      const blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
      const proxyBlocks = cat.nodes.length ? names.map((n) => blockMap[n]).filter(Boolean) : undefined;
      const s = await router.startRouter(names, {
        basePort: cmd.basePort, controllerPort: cmd.controllerPort, proxyBlocks,
      });
      return { ok: true, message: `已就绪 ${names.length} 个节点端口（pid ${s.pid}）`, at: now() };
    }

    case 'setPool': {
      const cat = loadCatalogue();
      const sourceNodes = cat.nodes.length ? cat.nodes : (await c.state()).nodes;
      const currentNames = sourceNodes.map((n) => n.name);
      const names = (cmd.nodes || []).filter((n) => currentNames.includes(n));
      writePool(names);
      const eff = effectivePool(names, sourceNodes);
      const prev = router.routerStatus();
      const same = mappingMatches(prev, eff);
      if (!same) {
        const blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
        const proxyBlocks = cat.nodes.length ? eff.map((n) => blockMap[n]).filter(Boolean) : undefined;
        await router.startRouter(eff, { proxyBlocks });
      }
      return {
        ok: true,
        message: names.length ? `节点池已保存：${eff.length} 个节点可用` : '节点池已清空：全部节点可用',
        at: now(),
      };
    }

    case 'setProfiles': {
      const ids = (cmd.profiles || []).filter((x) => typeof x === 'string');
      writeSelectedProfiles(ids);
      const cat = loadCatalogue();
      const valid = new Set(cat.nodes.map((n) => n.name));
      const kept = readPool().filter((n) => valid.has(n));
      writePool(kept);
      const names = effectivePool(kept, cat.nodes);
      const blockMap = Object.fromEntries(cat.nodes.map((n) => [n.name, n.raw]));
      const proxyBlocks = names.map((n) => blockMap[n]).filter(Boolean);
      await router.startRouter(names, { proxyBlocks });
      return {
        ok: true,
        message: ids.length ? `已启用 ${ids.length} 个订阅：${cat.nodes.length} 个节点` : `已启用全部 ${cat.profiles.length} 个订阅：${cat.nodes.length} 个节点`,
        at: now(),
      };
    }

    case 'stop':
      await router.stopRouter({ quiet: true });
      return { ok: true, message: '已停止节点实例', at: now() };

    case 'assign': {
      const rr = await ensureRouter(c);
      const delays = readDelays();
      let providers = magpie.listProviders();
      if (cmd.providerIds?.length) providers = providers.filter((p) => cmd.providerIds.includes(p.id));
      const plan = magpie.buildPlan({
        providers, mapping: rr.mapping, delays,
        strategy: cmd.strategy || 'spread', selectedNodes: cmd.nodes || [],
      });
      const out = magpie.applyPlan(plan);
      return { ok: true, message: `已分配 ${out.applied.length} 个供应商`, at: now() };
    }

    case 'assignProvider': {
      await ensureRouter(c);
      magpie.applyPlan({ [cmd.id]: cmd.proxy ?? '' });
      return { ok: true, message: `${cmd.id} → ${cmd.proxy || '跟随全局'}`, at: now() };
    }

    case 'assignAccount': {
      await ensureRouter(c);
      magpie.applyAccountPlans({ [cmd.id]: { [cmd.account]: cmd.proxy ?? '' } });
      return { ok: true, message: `${cmd.id} / ${cmd.account} → ${cmd.proxy || '跟随供应商'}`, at: now() };
    }

    case 'assignAccountPlans': {
      await ensureRouter(c);
      const plans = cmd.plans || {};
      const count = Object.values(plans).reduce((n, m) => n + Object.keys(m || {}).length, 0);
      magpie.applyAccountPlans(plans);
      return { ok: true, message: `已为 ${count} 个账号指定节点`, at: now() };
    }

    case 'assignAccounts': {
      const rr = await ensureRouter(c);
      const list = accountsLib.readAccountCache() || accountsLib.listAccounts();
      const delays = readDelays();
      const plan = accountsLib.buildAccountPlan({
        accounts: list, mapping: rr.mapping, delays,
        strategy: cmd.strategy || 'spread',
        selectedNodes: cmd.nodes || [],
        providerIds: cmd.providerIds || [],
        only: cmd.only || [],
      });
      const count = Object.values(plan).reduce((n, m) => n + Object.keys(m).length, 0);
      magpie.applyAccountPlans(plan);
      return { ok: true, message: `已为 ${count} 个账号分配节点`, at: now() };
    }

    case 'restore': {
      const out = magpie.restore();
      return { ok: true, message: `已还原 ${out.restored.length} 个供应商`, at: now() };
    }

    default:
      throw new Error(`未知命令: ${cmd.do}`);
  }
}

async function run(options) {
  const prev = readJson(STATE_JSON, {});
  let error = null;
  // A message from an earlier session is not news: show one only when this
  // run actually executed a command.
  let last = null;
  const c = createController({ group: options.group || '' });

  try {
    const cmd = options.cmd;
    const done = readJson(LAST_CMD, {});
    if (cmd && options.cmdId && done.id !== options.cmdId) {
      try { last = await execute(cmd, c); }
      catch (e) { error = e?.message || String(e); last = { ok: false, message: error, at: now() }; }
      writeJson(LAST_CMD, { id: options.cmdId, at: Date.now() });
    }
  } catch (e) { error = e?.message || String(e); }

  // Keep the per-node ports alive across magpie restarts: assignments in
  // providers.json point at them, so a dead instance means broken providers.
  if (options.autoStart !== false) {
    try { await ensureRouter(c); }
    catch (e) { if (!error) error = `节点端口自动准备失败：${e?.message || e}`; }
  }

  let state;
  try { state = await collect(c, error); }
  catch (e) {
    state = { ...prev, generatedAt: now(), error: e?.message || String(e) };
  }
  state.last = last;
  writeJson(STATE_JSON, state);
  writeStateJs(state);
  return state;
}

/** Only this function is exported: magpie calls every exported function as a plugin. */
export const ClashNodesPlugin = async (_input, options = {}) => {
  try { await run(options || {}); } catch { /* never break plugin init */ }
  return {};
};
