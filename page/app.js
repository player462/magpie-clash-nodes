/* One magpie page, two dropdowns. The plugin host writes state.js after every
   command; this page reloads that file through an external <script> (allowed
   by the page's CSP) instead of inlining it in <head>. */
(function () {
  'use strict';

  var S = {};
  var sending = false;
  var perAccount = false;
  var $ = function (id) { return document.getElementById(id); };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setStatus(text, ok) {
    var el = $('status');
    el.textContent = text;
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
    if (sending) return;
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
      // the host rewrites state.js when it is done; poll until it lands
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
      render();
      setStatus(S.last ? S.last.message : (S.error || '完成'), S.error ? false : (S.last ? S.last.ok : true));
    } catch (e) {
      setStatus('失败: ' + (e && e.message ? e.message : e), false);
    } finally {
      sending = false;
      for (var j = 0; j < all.length; j++) all[j].disabled = false;
      if (btn) btn.textContent = old;
    }
  }

  function nodeEntries() {
    var r = S.router || {};
    if (!r.running) return [];
    var byName = {};
    (S.nodes || []).forEach(function (n) { byName[n.name] = n; });
    return Object.keys(r.mapping || {}).map(function (name) {
      var n = byName[name] || {};
      return {
        name: name, url: 'http://127.0.0.1:' + r.mapping[name],
        region: n.region || '其他', delay: n.delay,
      };
    });
  }
  function nodeOptions(current, followLabel) {
    var h = '<option value=""' + (!current ? ' selected' : '') + '>' + esc(followLabel) + '</option>' +
      '<option value="direct"' + (current === 'direct' ? ' selected' : '') + '>⇋ 直连（不走梯子）</option>';
    var groups = {};
    nodeEntries().forEach(function (n) {
      var d = n.delay == null ? '' : ' · ' + n.delay + 'ms';
      var dot = n.delay == null ? '○' : n.delay < 300 ? '●' : n.delay < 1000 ? '◐' : '○';
      var label = dot + ' ' + esc(n.region) + ' — ' + esc(n.name) + d;
      var opt = '<option value="' + esc(n.url) + '"' + (current === n.url ? ' selected' : '') + '>' + label + '</option>';
      (groups[n.region] = groups[n.region] || []).push(opt);
    });
    Object.keys(groups).sort().forEach(function (g) {
      h += '<optgroup label="' + esc(g) + '">' + groups[g].join('') + '</optgroup>';
    });
    return h;
  }
  function providerName(id) {
    var p = (S.providers || []).filter(function (x) { return x.id === id; })[0];
    return p ? (p.name || p.id) : id;
  }

  function renderControls() {
    var ns = $('nodeSelect'), ps = $('providerSelect');
    var keepNode = ns.value, keepProvider = ps.value;
    ns.innerHTML = nodeOptions(keepNode, perAccount ? '跟随供应商' : '跟随全局');
    ps.innerHTML = (S.providers || []).map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>';
    }).join('');
    if (keepNode) ns.value = keepNode;
    if (keepProvider) ps.value = keepProvider;
    if (!ps.value && (S.providers || []).length) ps.value = S.providers[0].id;
    ns.disabled = nodeEntries().length === 0;
  }

  function delayPill(n) {
    if (n.delay == null) return '<i class="cn-delay">—</i>';
    var cls = n.delay < 300 ? ' fast' : n.delay < 800 ? ' mid' : n.delay < 1500 ? ' slow' : ' bad';
    return '<i class="cn-delay' + cls + '">' + n.delay + 'ms</i>';
  }

  function renderPicker() {
    var sum = $('poolSummary'), body = $('poolBody');
    var names = S.nodes || [];
    var pool = S.pool || [];
    var drift = S.drift || { missing: [], added: [] };
    var inst = (S.router && S.router.running && S.router.nodes) || [];
    var byRegion = {};
    names.forEach(function (n) { (byRegion[n.region] = byRegion[n.region] || []).push(n); });
    var parts = [];
    Object.keys(byRegion).sort().forEach(function (rg) {
      var list = byRegion[rg];
      var picked = list.filter(function (n) { return pool.indexOf(n.name) >= 0; }).length;
      parts.push('<div class="cn-region">' + esc(rg) +
        ' <span>' + (picked ? picked + '/' : '') + list.length + '</span></div>');
      list.forEach(function (n) {
        var inPool = pool.indexOf(n.name) >= 0;
        var port = inst.indexOf(n.name) >= 0 ? (S.router.mapping[n.name] || '') : '';
        parts.push('<label class="cn-pick' + (inPool ? ' on' : '') + '">' +
          '<input type="checkbox" data-kind="pick" data-node="' + esc(n.name) + '"' + (inPool ? ' checked' : '') + '>' +
          '<span title="' + esc(n.name) + '">' + esc(n.name) + '</span>' +
          delayPill(n) +
          (port ? '<i class="cn-port">:' + port + '</i>' : '') +
          '</label>');
      });
    });
    sum.innerHTML = '可用节点池 <b>' + (pool.length ? '已选 ' + pool.length : '全部') + '</b>' +
      ' <span class="cn-dim">/ ' + names.length + ' 个节点</span>' +
      (drift.missing.length ? ' <span class="cn-badtext">· ' + drift.missing.length + ' 个已失效</span>' : '') +
      (drift.added.length ? ' <span class="cn-oktext">· ' + drift.added.length + ' 个新节点</span>' : '') +
      (S.staleInstance ? ' <span class="cn-badtext">· 端口待同步</span>' : '');
    body.innerHTML =
      '<p class="cn-muted">勾选的节点才会开成本地端口，供应商和账号的下拉只从池子里选；不勾 = 全部可用。Clash 换订阅后这里会提示增减，点保存即同步。</p>' +
      '<div class="cn-grid">' + parts.join('') + '</div>' +
      '<div class="cn-actions">' +
      '<button type="button" class="cn-primary" data-act="pool-save">保存节点池并同步端口</button>' +
      '<button type="button" data-act="pool-test">⚡ 测全部延迟</button>' +
      '<button type="button" data-act="pool-all">全选</button>' +
      '<button type="button" data-act="pool-none">清空</button>' +
      '</div>';
  }

  function pickedFromDom() {
    var out = [];
    var boxes = $('poolBody').querySelectorAll('input[data-kind="pick"]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].dataset.node);
    return out;
  }

  function renderDetail() {
    var id = $('providerSelect').value;
    var accs = (S.accounts || []).filter(function (a) { return a.providerId === id; });
    var p = (S.providers || []).filter(function (x) { return x.id === id; })[0] || {};
    var detail = $('detail');

    if (!nodeEntries().length) {
      detail.innerHTML = '<div class="cn-card"><h2>还没有可选的节点</h2>' +
        '<p>给梯子里的节点各开一个本地端口后，就能在这里给供应商和账号指派节点。这不会动 Clash 正在用的 7890 端口。</p>' +
        '<div class="cn-actions"><button type="button" class="cn-primary" data-act="start">一键准备节点端口</button></div></div>';
      return;
    }

    if (perAccount) {
      var rows = accs.map(function (a, i) {
        return '<tr><td class="cn-dim">' + (i + 1) + '</td>' +
          '<td class="cn-name">' + esc(a.label) + (a.active ? ' <span class="cn-tag on">使用中</span>' : '') + '</td>' +
          '<td><span class="cn-tag' + (a.node && a.node !== '跟随供应商' ? ' on' : '') + '">' + esc(a.node || '跟随供应商') + '</span></td>' +
          '<td><select data-kind="account-select" data-account="' + esc(a.key) + '">' +
          nodeOptions(a.proxy || '', '跟随供应商') + '</select></td></tr>';
      }).join('');
      detail.innerHTML = '<div class="cn-card"><h2>' + esc(providerName(id)) + ' 的账号各走各的节点</h2>' +
        '<p>改完点「应用」一次生效；账号选「跟随供应商」则不单独设。顶部节点下拉可以先把所有账号填成同一个节点，再单独调个别账号。</p>' +
        (rows ? '<table><thead><tr><th>#</th><th>账号</th><th>现在走</th><th>改成</th></tr></thead><tbody>' + rows + '</tbody></table>'
              : '<p class="cn-empty">这个供应商没有可单独分配的账号——整个供应商的设置已在上面生效。</p>') +
        '</div>';
      return;
    }

    detail.innerHTML = '<div class="cn-card"><h2>' + esc(providerName(id)) + ' · 整个供应商</h2>' +
      '<p>现在走：<b class="' + (p.node && p.node !== '全局代理' && p.node !== '跟随供应商' ? 'cn-now' : '') + '">' + esc(p.node || '全局代理') + '</b>' +
      (accs.length ? '，' + accs.length + ' 个账号都跟着这个设置走。要给某个账号单独指派节点，勾选「按账号分配」。' : '。') +
      '</p></div>';
  }

  function render() {
    renderControls();
    renderPicker();
    renderDetail();
    var r = S.router || {};
    var drift = S.drift || { missing: [], added: [] };
    var badge = r.running ? (r.nodes || []).length + ' 个节点就绪 · 梯子当前 ' + (S.current || '—')
      : '节点未就绪，应用时自动准备';
    if (drift.missing.length || drift.added.length || S.staleInstance) badge += ' · 节点池有变化';
    $('badge').textContent = badge;
    $('badge').className = 'cn-pill' + (r.running && !S.staleInstance && !drift.missing.length ? ' on' : '');
    if (S.last) setStatus(S.last.message, S.last.ok);
    else if (S.error) setStatus(S.error, false);
    else setStatus('');
  }

  function apply() {
    var id = $('providerSelect').value;
    if (!id) return;
    if (perAccount) {
      var plans = {};
      var selects = $('detail').querySelectorAll('[data-kind="account-select"]');
      var changed = 0;
      for (var i = 0; i < selects.length; i++) {
        // only send rows the user actually touched, so an untouched
        // "follow" row never wipes an existing per-account setting
        var sel = selects[i];
        plans[id] = plans[id] || {};
        plans[id][sel.dataset.account] = sel.value;
        if (sel.value) changed++;
      }
      if (!changed) { setStatus('没有勾选任何节点——留空的账号会继续跟随供应商。确认要全部跟随就直接应用。', true); }
      send({ do: 'assignAccountPlans', plans: plans });
    } else {
      var v = $('nodeSelect').value;
      send({ do: 'assignProvider', id: id, proxy: v });
      var label = v === '' ? '跟随全局' : v === 'direct' ? '直连' : $('nodeSelect').options[$('nodeSelect').selectedIndex].text;
      setStatus('把 ' + providerName(id) + ' 设为 ' + label + '…');
    }
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.dataset || !t.dataset.act) return;
    switch (t.dataset.act) {
      case 'start':
        send({ do: 'start' });
        break;
      case 'pool-save':
        send({ do: 'setPool', nodes: pickedFromDom() }, { busyBtn: '[data-act="pool-save"]', busyText: '保存中…' });
        break;
      case 'pool-test':
        send({ do: 'test' }, { waitMs: 25000, busyBtn: '[data-act="pool-test"]', busyText: '测速中…', busyStatus: '正在测全部节点延迟（约 10–20 秒）…' });
        break;
      case 'pool-all': {
        var boxes = $('poolBody').querySelectorAll('input[data-kind="pick"]');
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
        break;
      }
      case 'pool-none': {
        var boxes2 = $('poolBody').querySelectorAll('input[data-kind="pick"]');
        for (var j = 0; j < boxes2.length; j++) boxes2[j].checked = false;
        break;
      }
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.dataset && t.dataset.kind === 'pick') {
      var poolBody = $('poolBody');
      var n = poolBody.querySelectorAll('input[data-kind="pick"]:checked').length;
      var sum = $('poolSummary');
      var b = sum.querySelector('b');
      if (b) b.textContent = n ? '已选 ' + n : '全部';
      return;
    }
    if (t.id === 'perAccount') {
      perAccount = !!t.checked;
      var ns = $('nodeSelect');
      // The top dropdown's empty value means different things in the two
      // modes; keep whichever the user is looking at honest.
      ns.options[0].textContent = perAccount ? '跟随供应商' : '跟随全局';
      renderControls(); renderDetail();
      if (perAccount) setStatus('给每个账号选节点；顶部节点下拉可先统一填一遍，再单独调。', true);
    }
    if (t.id === 'providerSelect') renderDetail();
    if (t.id === 'nodeSelect' && perAccount && t.value) {
      var selects = $('detail').querySelectorAll('[data-kind="account-select"]');
      var m = 0;
      for (var i = 0; i < selects.length; i++) { selects[i].value = t.value; m++; }
      if (m) setStatus('已把 ' + m + ' 个账号填成同一个节点，点「应用」生效。', true);
    }
  }

  async function main() {
    await magpie.ready;
    try { await magpie.read('providers:list', {}); } catch (e) { /* optional read */ }
    $('app').addEventListener('click', onClick);
    $('app').addEventListener('change', onChange);
    $('apply').addEventListener('click', apply);
    $('restore').addEventListener('click', function () {
      if (window.confirm && !window.confirm('把所有供应商和账号的节点设置恢复成本来的样子？')) return;
      send({ do: 'restore' });
    });
    S = await loadState();
    render();
  }
  main().catch(function (e) { setStatus('启动失败: ' + (e && e.message ? e.message : e), false); });
})();
