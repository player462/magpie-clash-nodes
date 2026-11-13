/* One magpie page. The plugin host rewrites state.js after every command; this
   page reloads it as an external script (CSP-friendly) and keeps per-provider
   edits in `drafts` so switching the provider dropdown never loses them. */
(function () {
  'use strict';

  var S = {};
  var sending = false;
  var currentId = '';
  var drafts = {};           // providerId -> { perAccount, provider, accounts: {key: value} }
  var openProfiles = {};     // subscription id -> expanded?
  var $ = function (id) { return document.getElementById(id); };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setStatus(text, ok) {
    var el = $('status');
    el.textContent = text || '';
    el.className = 'cn-status' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  }
  function loadState() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'state.js?v=' + Date.now();
      s.onload = function () { resolve(window.__CLASH_NODES_STATE__ || {}); s.remove(); };
      s.onerror = function () { reject(new Error('state.js 未能加载')); s.remove(); };
      document.head.appendChild(s);
    });
  }
  async function send(cmd, opts) {
    opts = opts || {};
    if (sending) return false;
    sending = true;
    var waitMs = opts.waitMs || 9000;
    var all = document.querySelectorAll('#app button');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    var btn = opts.busyBtn ? document.querySelector(opts.busyBtn) : $('apply');
    var old = btn ? btn.textContent : '';
    if (btn && opts.busyText) btn.textContent = opts.busyText;
    setStatus(opts.busyStatus || '正在应用…');
    try {
      var before = S.generatedAt;
      var o = (await magpie.options.get()) || {};
      await magpie.options.set(Object.assign({}, o, {
        cmd: cmd, cmdId: Date.now() + '-' + Math.random().toString(36).slice(2, 9),
      }));
      var deadline = Date.now() + waitMs;
      for (;;) {
        await wait(1200);
        try {
          var s2 = await loadState();
          if (s2.generatedAt && s2.generatedAt !== before) { S = s2; break; }
        } catch (e) { /* transient while the host restarts */ }
        if (Date.now() > deadline) {
          try { S = await loadState(); } catch (e2) { /* keep old */ }
          break;
        }
      }
      if (opts.clearDraftFor) delete drafts[opts.clearDraftFor];
      render();
      setStatus(S.last ? S.last.message : (S.error || '完成'), S.error ? false : (S.last ? S.last.ok : true));
      return true;
    } catch (e) {
      setStatus('失败: ' + (e && e.message ? e.message : e), false);
      return false;
    } finally {
      sending = false;
      for (var j = 0; j < all.length; j++) all[j].disabled = false;
      if (btn) btn.textContent = old;
    }
  }

  // ---------- data helpers ----------
  function providerOf(id) {
    return (S.providers || []).filter(function (p) { return p.id === id; })[0] || null;
  }
  function providerName(id) {
    var p = providerOf(id);
    return p ? (p.name || p.id) : id;
  }
  function accountsOf(id) {
    return (S.accounts || []).filter(function (a) { return a.providerId === id; });
  }
  function accountByKey(id, key) {
    return accountsOf(id).filter(function (a) { return a.key === key; })[0] || null;
  }
  function savedProviderProxy(id) {
    var p = providerOf(id);
    return p ? (p.proxy || '') : '';
  }
  function savedAccountProxy(id, key) {
    var a = accountByKey(id, key);
    return a ? (a.proxy || '') : '';
  }
  function draftFor(id) {
    if (!drafts[id]) drafts[id] = { perAccount: null, provider: null, accounts: {} };
    return drafts[id];
  }
  function perAccountOn(id) {
    var d = drafts[id];
    if (d && d.perAccount !== null) return d.perAccount;
    // a provider that already has per-account proxies opens in account mode,
    // so switching away and back lands on the saved choices
    return accountsOf(id).some(function (a) { return !!a.proxy; });
  }
  function nodeEntries() {
    var r = S.router || {};
    if (!r.running) return [];
    var byName = {};
    (S.nodes || []).forEach(function (n) { byName[n.name] = n; });
    return Object.keys(r.mapping || {}).map(function (name) {
      var n = byName[name] || {};
      return {
        name: name,
        originalName: n.originalName || name,
        url: 'http://127.0.0.1:' + r.mapping[name],
        region: n.region || '其他',
        profile: n.profile || '',
        delay: n.delay,
      };
    });
  }
  function urlInPool(url) {
    return nodeEntries().some(function (n) { return n.url === url; });
  }
  function nodeNameOf(url) {
    var hit = nodeEntries().filter(function (n) { return n.url === url; })[0];
    return hit ? hit.name : '';
  }
  function isStaleSaved(url) {
    return !!url && url !== 'direct' && !urlInPool(url);
  }

  function nodeOptions(current, mode) {
    var follow = mode === 'provider' ? '跟随全局（不指定）'
      : mode === 'batch' ? '批量设置所有账号…'
      : '跟随供应商';
    var h = '<option value=""' + (!current ? ' selected' : '') + '>' + esc(follow) + '</option>' +
      '<option value="direct"' + (current === 'direct' ? ' selected' : '') + '>⇢ 直连（不走梯子）</option>';
    if (current && current !== 'direct' && !urlInPool(current)) {
      h += '<option value="' + esc(current) + '" selected>⚠ 节点已失效（' +
        esc(String(current).replace(/^https?:\/\//, '')) + '）</option>';
    }
    var groups = {};
    nodeEntries().forEach(function (n) {
      var d = n.delay == null ? '' : ' · ' + n.delay + 'ms';
      var dot = n.delay == null ? '○' : n.delay < 300 ? '●' : n.delay < 1000 ? '◐' : '○';
      var label = dot + ' ' + esc(n.originalName || n.name) + d;
      var opt = '<option value="' + esc(n.url) + '"' + (current === n.url ? ' selected' : '') + '>' + label + '</option>';
      var g = (n.profile ? n.profile + ' · ' : '') + n.region;
      (groups[g] = groups[g] || []).push(opt);
    });
    Object.keys(groups).sort().forEach(function (g) {
      h += '<optgroup label="' + esc(g) + '">' + groups[g].join('') + '</optgroup>';
    });
    return h;
  }

  // ---------- dirty state ----------
  function changedAccounts(id) {
    var d = drafts[id];
    if (!d) return [];
    return Object.keys(d.accounts).filter(function (key) {
      return d.accounts[key] !== savedAccountProxy(id, key);
    });
  }
  function isDirty(id) {
    if (!id) return false;
    var d = drafts[id];
    if (!d) return false;
    var providerChanged = d.provider !== null && d.provider !== savedProviderProxy(id);
    return providerChanged || changedAccounts(id).length > 0;
  }
  function paintDirty() {
    var el = $('dirty');
    if (!el) return;
    el.hidden = !isDirty(currentId);
  }

  // ---------- rendering ----------
  function renderBar() {
    var ps = $('providerSelect'), ns = $('nodeSelect');
    var sig = (S.providers || []).map(function (p) { return p.id; }).join('|');
    if (ps.dataset.sig !== sig) {
      ps.innerHTML = (S.providers || []).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>';
      }).join('');
      ps.dataset.sig = sig;
    }
    if (!currentId || !(S.providers || []).some(function (p) { return p.id === currentId; })) {
      currentId = (S.providers || [])[0] ? (S.providers[0].id) : '';
    }
    if (currentId) ps.value = currentId;

    var d = draftFor(currentId);
    var on = perAccountOn(currentId);
    $('perAccount').checked = on;
    $('nodeLabel').textContent = on ? '批量设置' : '节点';
    ns.innerHTML = nodeOptions(d.provider !== null ? d.provider : savedProviderProxy(currentId),
      on ? 'batch' : 'provider');
    if (!on) ns.value = d.provider !== null ? d.provider : savedProviderProxy(currentId);
    else ns.value = '';
    ns.disabled = nodeEntries().length === 0;
    paintDirty();
  }

  function delayPill(n) {
    if (n.delay == null) return '<i class="cn-delay">—</i>';
    var cls = n.delay < 300 ? ' fast' : n.delay < 800 ? ' mid' : n.delay < 1500 ? ' slow' : ' bad';
    return '<i class="cn-delay' + cls + '">' + n.delay + 'ms</i>';
  }

  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderPicker() {
    var sum = $('poolSummary'), body = $('poolBody');
    var names = S.nodes || [];
    var pool = S.pool || [];
    var poolAll = (S.poolMode || 'selected') === 'all';
    var inPool = function (name) { return poolAll || pool.indexOf(name) >= 0; };
    var drift = S.drift || { missing: [], added: [] };
    var inst = (S.router && S.router.running && S.router.nodes) || [];
    var profs = S.profiles || [];
    var chosen = S.profileChosen || [];
    var allChosen = !chosen.length;
    var selected = profs.filter(function (p) { return allChosen || chosen.indexOf(p.id) >= 0; });

    var profHtml = '';
    if (profs.length) {
      profHtml = '<div class="cn-profiles"><span class="cn-prof-title">订阅</span>' + profs.map(function (p) {
        var on = allChosen || chosen.indexOf(p.id) >= 0;
        var count = (S.profileCounts && S.profileCounts[p.id] != null)
          ? S.profileCounts[p.id]
          : names.filter(function (n) { return n.profileId === p.id; }).length;
        return '<label class="cn-prof' + (on ? ' on' : '') + '" title="更新于 ' + esc(fmtTime(p.updatedAt) || '未知') + '">' +
          '<input type="checkbox" data-kind="profile" data-id="' + esc(p.id) + '"' + (on ? ' checked' : '') + '>' +
          esc(p.label) + (p.active ? '<em class="cn-sub-now">当前</em>' : '') + '<i>' + count + '</i></label>';
      }).join('') +
        '<button type="button" class="cn-btn ghost cn-prof-save" data-act="profiles-save">应用订阅</button></div>';
    }

    var blocks = (selected.length ? selected : [{ id: '', label: '当前订阅', updatedAt: 0 }]).map(function (p) {
      var list = names.filter(function (n) { return (n.profileId || '') === p.id; });
      if (!list.length) return '';
      var picked = list.filter(function (n) { return inPool(n.name); }).length;
      var open = openProfiles[p.id] !== undefined ? openProfiles[p.id] : selected.length === 1;
      var byRegion = {};
      list.forEach(function (n) { (byRegion[n.region] = byRegion[n.region] || []).push(n); });
      var inner = '';
      Object.keys(byRegion).sort().forEach(function (rg) {
        var arr = byRegion[rg];
        var sel = arr.filter(function (n) { return inPool(n.name); }).length;
        inner += '<div class="cn-region"><span class="cn-region-name">' + esc(rg) + '</span>' +
          '<span class="cn-region-count">' + (sel ? sel + ' / ' : '') + arr.length + '</span></div>';
        arr.forEach(function (n) {
          var pickedNode = inPool(n.name);
          var port = inst.indexOf(n.name) >= 0 ? (S.router.mapping[n.name] || '') : '';
          inner += '<label class="cn-pick' + (pickedNode ? ' on' : '') + '">' +
            '<input type="checkbox" data-kind="pick" data-node="' + esc(n.name) + '"' + (pickedNode ? ' checked' : '') + '>' +
            '<span class="cn-pick-name" title="' + esc(n.name) + '">' + esc(n.originalName || n.name) + '</span>' +
            delayPill(n) +
            (port ? '<i class="cn-port">:' + port + '</i>' : '') +
            '</label>';
        });
      });
      return '<details class="cn-prof-block" data-prof="' + esc(p.id) + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="cn-prof-name">' + esc(p.label) + '</span>' +
        '<span class="cn-prof-stat">' + list.length + ' 个节点' + (picked ? ' · 已选 ' + picked : '') + '</span>' +
        (p.updatedAt ? '<span class="cn-prof-time">更新 ' + esc(fmtTime(p.updatedAt)) + '</span>' : '') +
        '</summary><div class="cn-grid">' + inner + '</div></details>';
    }).join('');

    var flags = [];
    if (profs.length) flags.push('<span class="cn-flag">' + selected.length + ' / ' + profs.length + ' 个订阅</span>');
    if (drift.missing.length) flags.push('<span class="cn-flag bad">' + drift.missing.length + ' 个节点已失效</span>');
    if (S.staleInstance) flags.push('<span class="cn-flag bad">端口待同步</span>');
    sum.innerHTML = '<span class="cn-sum-title">可用节点池</span>' +
      '<span class="cn-sum-count">' + (poolAll ? '全部 ' + names.length : (pool.length ? '已选 ' + pool.length : '未选择')) +
      (poolAll ? '' : ' / ' + names.length) + '</span>' +
      flags.join('');
    body.innerHTML = profHtml +
      '<p class="cn-note">这是一个白名单：勾选哪些节点，插件就只开哪些本地端口；一个都不勾选就一个节点也不可用。供应商和账号的下拉只从池子里选。Clash 更新订阅后点右上「刷新」即可读到新节点。</p>' +
      (S.poolTruncated ? '<div class="cn-warn"><span>这个订阅节点很多，首次默认勾选了 ' + (S.poolEffective || []).length +
        ' 个均衡节点。需要更多请在下面勾选后保存。</span></div>' : '') +
      '<div class="cn-prof-blocks">' + blocks + '</div>' +
      '<div class="cn-actions">' +
      '<button type="button" class="cn-btn primary" data-act="pool-save">保存并同步端口</button>' +
      '<button type="button" class="cn-btn" data-act="pool-test">⚡ 测全部延迟</button>' +
      '<button type="button" class="cn-btn ghost" data-act="pool-all">全选</button>' +
      '<button type="button" class="cn-btn ghost" data-act="pool-none">清空</button>' +
      '<button type="button" class="cn-btn ghost" data-act="pool-use-all">使用全部节点</button>' +
      '</div>';
  }

  function pickedFromDom() {
    var out = [];
    var boxes = $('poolBody').querySelectorAll('input[data-kind="pick"]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].dataset.node);
    return out;
  }

  function renderDetail() {
    var id = currentId;
    var detail = $('detail');
    var accs = accountsOf(id);
    var p = providerOf(id) || {};
    var d = draftFor(id);
    var on = perAccountOn(id);

    if (!nodeEntries().length) {
      detail.innerHTML = '<div class="cn-empty-state">' +
        '<div class="cn-empty-title">还没有可用的节点端口</div>' +
        '<p class="cn-note">先在「可用节点池」勾选节点并点「保存并同步端口」，就能在这里给供应商和账号指派节点。不会动 Clash 正在用的 7890 端口。</p>' +
        '<button type="button" class="cn-btn primary" data-act="start">一键准备节点端口</button></div>';
      return;
    }

    if (!on) {
      var cur = savedProviderProxy(id);
      var stale = p.stale || isStaleSaved(cur);
      detail.innerHTML = '<div class="cn-card">' +
        '<div class="cn-card-head"><h2>' + esc(providerName(id)) + ' · 整个供应商</h2>' +
        '<span class="cn-tag' + (cur ? ' on' : '') + '">' + esc(p.node || '全局代理') + '</span></div>' +
        (stale ? '<div class="cn-warn"><span>原先指定的节点已失效（' +
          esc(String(cur).replace(/^https?:\/\//, '')) + '），请重新选择后点「应用」。</span>' +
          '<button type="button" class="cn-warn-fix" data-act="fix-stale">改用第一个可用节点</button></div>' : '') +
        '<p class="cn-note">' + (accs.length
          ? '这个供应商的 ' + accs.length + ' 个账号都跟随这里的设置。要给某个账号单独指定，打开「按账号分配」。'
          : '这个供应商没有可单独分配的账号。') + '</p>' +
        '</div>';
      return;
    }

    var staleCount = accs.filter(function (a) { return a.stale; }).length;
    var rows = accs.map(function (a, i) {
      var saved = savedAccountProxy(id, a.key);
      var value = d.accounts[a.key] !== undefined ? d.accounts[a.key] : saved;
      var changed = value !== saved;
      var isStale = a.stale;
      var shown = a.node || '跟随供应商';
      return '<tr class="' + (isStale ? 'stale ' : '') + (changed ? 'changed' : '') + '">' +
        '<td class="cn-idx">' + (i + 1) + '</td>' +
        '<td class="cn-acc"><div class="cn-acc-name">' + esc(a.label) +
        (a.active ? '<span class="cn-mini on">使用中</span>' : '') + '</div>' +
        (a.plan ? '<div class="cn-acc-sub">' + esc(a.plan) + '</div>' : '') + '</td>' +
        '<td class="cn-cur"><span class="cn-tag' + (isStale ? ' bad' : a.node && a.node !== '跟随供应商' ? ' on' : '') + '">' +
        (isStale ? '⚠ ' : '') + esc(shown) + '</span></td>' +
        '<td class="cn-target"><select data-kind="account-select" data-account="' + esc(a.key) + '">' +
        nodeOptions(value, 'account') + '</select>' +
        (changed ? '<span class="cn-pending">待应用</span>' : '') + '</td></tr>';
    }).join('');

    detail.innerHTML = '<div class="cn-card">' +
      '<div class="cn-card-head"><h2>' + esc(providerName(id)) + ' · 按账号</h2>' +
      '<span class="cn-count">' + accs.length + ' 个账号</span></div>' +
      (staleCount ? '<div class="cn-warn"><span>' + staleCount + ' 个账号原先的节点已失效，请重新选择后点「应用」。</span>' +
        '<button type="button" class="cn-warn-fix" data-act="fix-stale">自动匹配可用节点</button></div>' : '') +
      (accs.length
        ? '<table class="cn-table"><thead><tr><th class="cn-idx">#</th><th>账号</th><th>现在走</th><th>改成</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="cn-note">这个供应商没有可单独分配的账号。</p>') +
      '<p class="cn-note cn-card-foot">只提交你改过的行；没动过的账号保持原来的节点。</p>' +
      '</div>';
  }

  function render() {
    renderBar();
    renderPicker();
    renderDetail();
    var r = S.router || {};
    var drift = S.drift || { missing: [], added: [] };
    var bad = !!S.staleInstance || drift.missing.length > 0;
    var badge = r.running ? (r.nodes || []).length + ' 个节点就绪' : '节点未就绪';
    if (S.multiProfile && (S.profiles || []).length) {
      badge = (S.profiles || []).length + ' 个订阅 · ' + (S.nodes || []).length + ' 个节点' + (r.running ? ' · 就绪' : '');
    }
    if (bad) badge += ' · 需同步';
    $('badge').textContent = badge;
    $('badge').className = 'cn-chip' + (r.running && !bad ? ' on' : bad ? ' bad' : '');
    var lastOk = S.last && S.last.at && (Date.now() - Date.parse(S.last.at) < 5 * 60 * 1000);
    if (lastOk) setStatus(S.last.message, S.last.ok);
    else if (S.error) setStatus(S.error, false);
    else setStatus('');
    paintDirty();
  }

  // ---------- actions ----------
  function apply() {
    var id = currentId;
    if (!id) return;
    var on = perAccountOn(id);
    var d = draftFor(id);
    if (on) {
      var changed = changedAccounts(id);
      if (!changed.length) { setStatus('没有需要应用的更改。', true); return; }
      var plans = {};
      plans[id] = {};
      changed.forEach(function (key) { plans[id][key] = d.accounts[key]; });
      send({ do: 'assignAccountPlans', plans: plans }, { clearDraftFor: id, busyStatus: '正在应用 ' + changed.length + ' 个账号…' });
    } else {
      var value = d.provider !== null ? d.provider : savedProviderProxy(id);
      if (d.provider === null || d.provider === savedProviderProxy(id)) {
        setStatus('没有需要应用的更改。', true);
        return;
      }
      send({ do: 'assignProvider', id: id, proxy: value }, { clearDraftFor: id });
    }
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.dataset || !t.dataset.act) return;
    switch (t.dataset.act) {
      case 'start': send({ do: 'start' }); break;
      case 'refresh':
        send({ do: 'refresh' }, { waitMs: 15000, busyBtn: '[data-act="refresh"]', busyText: '刷新中…', busyStatus: '正在重新读取 Clash 订阅与节点…' });
        break;
      case 'pool-save':
        send({ do: 'setPool', nodes: pickedFromDom() }, { busyBtn: '[data-act="pool-save"]', busyText: '保存中…' });
        break;
      case 'profiles-save': {
        var boxes = $('poolBody').querySelectorAll('input[data-kind="profile"]');
        var ids = [];
        for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) ids.push(boxes[i].dataset.id);
        var all = (S.profiles || []).length;
        send({ do: 'setProfiles', profiles: ids.length === all ? [] : ids }, {
          waitMs: 15000, busyBtn: '[data-act="profiles-save"]', busyText: '切换中…',
          busyStatus: '正在按所选订阅重建节点端口…',
        });
        break;
      }
      case 'pool-test':
        send({ do: 'test' }, { waitMs: 28000, busyBtn: '[data-act="pool-test"]', busyText: '测速中…', busyStatus: '正在测全部节点延迟（约 10–20 秒）…' });
        break;
      case 'pool-all':
        Array.prototype.forEach.call($('poolBody').querySelectorAll('input[data-kind="pick"]'), function (b) { b.checked = true; });
        break;
      case 'pool-none':
        Array.prototype.forEach.call($('poolBody').querySelectorAll('input[data-kind="pick"]'), function (b) { b.checked = false; });
        break;
      case 'pool-use-all':
        if (window.confirm && !window.confirm('把所有订阅的所有节点都开成本地端口？节点多时会占用较多内存和端口。')) return;
        send({ do: 'setPool', mode: 'all' }, { waitMs: 30000, busyBtn: '[data-act="pool-use-all"]', busyText: '正在开启全部节点…' });
        break;
      case 'fix-stale': {
        var id = currentId;
        var d = draftFor(id);
        var nodes = nodeEntries();
        if (!nodes.length) { setStatus('没有可用节点，请先在节点池里保存。', false); break; }
        if (perAccountOn(id)) {
          var fixed = 0;
          accountsOf(id).forEach(function (a) {
            if (!a.stale) return;
            var providerProxy = savedProviderProxy(id);
            d.accounts[a.key] = (providerProxy && providerProxy !== 'direct' && urlInPool(providerProxy))
              ? providerProxy : nodes[0].url;
            fixed++;
          });
          renderDetail(); paintDirty();
          setStatus('已为 ' + fixed + ' 个失效账号选好替代节点，点「应用」生效。', true);
        } else {
          d.provider = nodes[0].url;
          renderBar(); renderDetail(); paintDirty();
          setStatus('已选第一个可用节点，点「应用」生效。', true);
        }
        break;
      }
    }
  }

  function onChange(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.dataset && t.dataset.kind === 'pick') {
      var n = $('poolBody').querySelectorAll('input[data-kind="pick"]:checked').length;
      var b = $('poolSummary').querySelector('.cn-sum-count');
      if (b) b.textContent = (n ? '已选 ' + n : '未选择') + ' / ' + (S.nodes || []).length;
      return;
    }
    if (t.dataset && t.dataset.kind === 'profile') {
      var lab = t.closest('label');
      if (lab) lab.classList.toggle('on', t.checked);
      return;
    }
    var id = currentId;
    if (!id) return;
    var d = draftFor(id);

    if (t.id === 'perAccount') {
      d.perAccount = !!t.checked;
      renderBar(); renderDetail();
      setStatus(t.checked ? '给每个账号选节点；顶部下拉可批量填充，再单独调整。' : '', true);
      return;
    }
    if (t.id === 'providerSelect') {
      currentId = t.value;
      render();
      return;
    }
    if (t.id === 'nodeSelect') {
      if (perAccountOn(id)) {
        if (!t.value) return;
        // bulk fill: every account gets this node, still only in the draft
        accountsOf(id).forEach(function (a) { d.accounts[a.key] = t.value; });
        t.value = '';
        renderDetail(); paintDirty();
        setStatus('已批量填入 ' + accountsOf(id).length + ' 个账号，点「应用」生效。', true);
      } else {
        d.provider = t.value;
        paintDirty();
      }
      return;
    }
    if (t.dataset.kind === 'account-select') {
      d.accounts[t.dataset.account] = t.value;
      renderDetail(); paintDirty();
    }
  }

  async function main() {
    await magpie.ready;
    try { await magpie.read('providers:list', {}); } catch (e) { /* optional read */ }
    $('app').addEventListener('click', onClick);
    $('app').addEventListener('change', onChange);
    $('poolBody').addEventListener('toggle', function (ev) {
      var d = ev.target;
      if (d && d.dataset && d.dataset.prof !== undefined) openProfiles[d.dataset.prof] = !!d.open;
    }, true);
    $('apply').addEventListener('click', apply);
    $('restore').addEventListener('click', function () {
      if (window.confirm && !window.confirm('把所有供应商和账号的节点设置恢复成本来的样子？')) return;
      drafts = {};
      send({ do: 'restore' });
    });
    S = await loadState();
    render();
    setStatus(''); // a message from an earlier session is not news
  }
  main().catch(function (e) { setStatus('启动失败: ' + (e && e.message ? e.message : e), false); });
})();
