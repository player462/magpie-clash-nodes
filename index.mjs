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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(magpie.magpieDir(), 'clash-nodes');
const STATE_JSON = path.join(DIR, 'plugin-state.json');
const LAST_CMD = path.join(DIR, 'plugin-last-cmd.json');
const STATE_FILES = [path.join(HERE, 'page', 'state.js')];

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
function effectivePool(pool, currentNames) {
  if (!pool.length) return currentNames;
  const eff = pool.filter((n) => currentNames.includes(n));
  return eff.length ? eff : currentNames; // every pooled name vanished: fall back wide
}

async function collect(c, error) {
  const st = await c.state();
  let r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // never report a dead instance as ready — clear the stale state file
    await router.stopRouter({ quiet: true }).catch(() => {});
    r = router.routerStatus();
  }
  const pool = readPool();
  const currentNames = st.nodes.map((n) => n.name);
  const eff = effectivePool(pool, currentNames);
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
    mainGroup: st.mainGroup,
    current: st.groups.find((g) => g.name === st.mainGroup)?.now || '',
    groups: st.groups.map((g) => ({ name: g.name, type: g.type, now: g.now, nodes: g.nodes })),
    nodes: st.nodes,
    pool,
    poolEffective: eff,
    drift,
    staleInstance,
    router: r,
    providers,
    accounts,
    error: error || null,
  };
}

/** Node ports must exist, be alive, and match the pool before an assignment lands. */
async function ensureRouter(c) {
  const st = await c.state();
  const eff = effectivePool(readPool(), st.nodes.map((n) => n.name));
  const r = router.routerStatus();
  if (r.running && !(await router.instanceAlive())) {
    // state file says running but the mihomo died: clear the lie, respawn
    await router.stopRouter({ quiet: true }).catch(() => {});
  } else if (r.running && JSON.stringify(Object.keys(r.mapping || {}).sort()) === JSON.stringify(eff.slice().sort())) {
    return r;
  } else if (r.running) {
    await router.stopRouter({ quiet: true }).catch(() => {});
  }
  return await router.startRouter(eff);
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
      const st = await c.state();
      await c.withDelays(st, { concurrency: 10 });
      return { ok: true, message: '测速完成', at: now() };
    }

    case 'start': {
      const st = await c.state();
      const currentNames = st.nodes.map((n) => n.name);
      const names = cmd.nodes?.length
        ? cmd.nodes.filter((n) => currentNames.includes(n))
        : effectivePool(readPool(), currentNames);
      const s = await router.startRouter(names, {
        basePort: cmd.basePort, controllerPort: cmd.controllerPort,
      });
      return { ok: true, message: `已就绪 ${names.length} 个节点端口（pid ${s.pid}）`, at: now() };
    }

    case 'setPool': {
      const st = await c.state();
      const currentNames = st.nodes.map((n) => n.name);
      const names = (cmd.nodes || []).filter((n) => currentNames.includes(n));
      writePool(names);
      const eff = effectivePool(names, currentNames);
      const prev = router.routerStatus();
      const same = prev.running &&
        JSON.stringify(Object.keys(prev.mapping || {}).sort()) === JSON.stringify(eff.slice().sort());
      if (!same) await router.startRouter(eff);
      return {
        ok: true,
        message: names.length ? `节点池已保存：${eff.length} 个节点可用` : '节点池已清空：全部节点可用',
        at: now(),
      };
    }

    case 'stop':
      await router.stopRouter({ quiet: true });
      return { ok: true, message: '已停止节点实例', at: now() };

    case 'assign': {
      const rr = await ensureRouter(c);
      const st = await c.state();
      const delays = Object.fromEntries(st.nodes.map((n) => [n.name, n.delay]));
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
      const st = await c.state();
      const delays = Object.fromEntries(st.nodes.map((n) => [n.name, n.delay]));
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
  let last = prev.last || null;
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
