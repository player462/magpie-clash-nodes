# magpie-clash-nodes

**在 magpie 原生窗口里选用 Clash / mihomo 梯子节点**：给整个供应商、或同一供应商的每个账号，分别指定不同节点。一个插件、一个页面，不装额外服务。

```powershell
magpie plugin add github:player462/magpie-clash-nodes
```

装好后，magpie 侧栏 **Plugins** 组会多出一个「**梯子节点**」标签页（跟随窗口浅色/深色主题）。

## 功能

页面从上到下就三块：

1. **控制行**：`供应商` 下拉 + `节点` 下拉 + `按账号分配` 开关 + `应用` / `还原`
   - 不勾「按账号分配」：选中的节点作用到**整个供应商**
   - 勾选后：展开该供应商的每个账号，**每个账号一个节点下拉**；顶部节点下拉可先把所有账号统一填一遍，再单独调个别账号
2. **可用节点池**（折叠区）：勾选哪些 Clash 节点可用（持久记住，不勾 = 全部）；显示每个节点的延迟彩丸（绿 <300ms / 黄 <800ms / 橙 <1500ms / 红 ≥1500ms）与端口号
   - **⚡ 测全部延迟**：一键测所有节点
   - **保存并同步端口**：按勾选重建本地端口实例
   - Clash 换订阅后自动提示「N 个已失效 / N 个新节点」，点保存即同步
3. **状态行**：每次操作的结果反馈

写入是 magpie 原生的 `providers.json`（供应商级 `proxy`、账号级 `accountProxies`），magpie **每个请求都会重读**，改完即生效，无需重启。`还原` 恢复这次会话改过的一切。

### 账号分配会记住
- 切到别的供应商再切回来，**已保存的账号节点会原样恢复**，并自动打开「按账号分配」。
- 还没点「应用」的改动也按供应商分别保留，切走再回来不会丢；行尾会标「待应用」。
- 只提交你实际改过的行，没动过的账号绝不被清空。
- 原先选的节点从池子里消失时，那一行会标红并提示「节点已失效」，同时给出「自动匹配可用节点」按钮，点一下再应用即可。

### 其他细节
- 自动过滤 magpie 里「账号名 = 供应商名」的占位登录（例如 ZCode 会写一条 `user: "ZCode"` 的假账号）。
- 每个节点**固定端口**（记录在 `ports.json`），换订阅 / 重建实例都不会让某个账号悄悄走到别的节点。
- 插件启动时自动拉起节点端口实例；实例意外退出会自动重建。

## 依赖与说明

- **Clash Party / mihomo 正在运行**（通过其 Windows 命名管道外部控制器通信；Clash Verge 等 TCP 控制器也支持，`MIHOMO_HOST/PORT/SECRET` 环境变量可指定）。
- 勾选节点保存后，会启动一个**独立的 mihomo 实例**，把每个池内节点绑到 `127.0.0.1:18001+` 的一个本地 HTTP 端口——**不动**你正在用的 7890 / 系统代理 / TUN / 订阅。实例若意外退出，下次任何分配操作会自动重建（状态做活性检测，不谎报）。
- 账号列表读取 magpie 的 `logins.json` + `providers.json`；也可用配套 CLI 刷新缓存（可选）。
- 所有状态存在 `~/.config/magpie/clash-nodes/`，卸载插件即弃。

## 工作原理（为什么页面长这样）

magpie 插件页跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 的 iframe 里：没有 fetch、没有内联脚本。页面与插件的唯一通道是 `magpie.options.set()`（触发 Bun 插件 host 重载）：

```
页面 options.set({cmd, cmdId}) → host 执行命令 → 重写 page/state.js → 页面动态加载 state.js 读回
```

`index.html` 由 `build.mjs` 生成：bridge 与 app 以 `data:` URL 内嵌（magpie web 的 CSP hash 与内联文本不匹配，`data:` 是其明确允许的通道；桌面端则走原生相对路径脚本，`data:` 仅在 `window.magpie` 缺失时兜底）。

## 开发

```powershell
# 改 page/app.js 或 page/template.html 后：
node build.mjs
magpie plugin off github:player462/magpie-clash-nodes ; magpie plugin on github:player462/magpie-clash-nodes
```

`lib/` 是零依赖 Node/Bun 代码（mihomo 命名管道控制器、每节点监听实例、providers.json 读写）。

## 致谢与许可

- `page/bridge.js` 取自 [yetone/magpie](https://github.com/yetone/magpie)（MIT），是 magpie 为插件页提供的官方桥接。
- 本插件 [MIT](LICENSE) © player462。magpie 是 [yetone](https://github.com/yetone) 的作品。
