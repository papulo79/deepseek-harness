# Agent Note: 面向每个已认证浏览器的 Host 设置

Status: implemented

[English](2026-09-15-host-settings-for-authenticated-browsers.md) | 中文

## 问题

Web 客户端按页面位置决定 Host 持久化：`ui-settings` 读取 `ctx.remote.$host.isLoopback`，并对其他任何 authority 选择 `'memory'`。dist 根路径与 `/api` 共用同一道浏览器会话校验，因此任何能加载出来的页面都已对本 Host 完成认证；位置从来不是这道闸门所暗示的认证信号。经 LAN PIN 配对（[LAN 移动端配对](2026-09-10-lan-mobile-pairing.zh.md)）获准的浏览器因而拿到一个终态不可用的 settings 镜像：Models 页面报 `settings are unavailable in this browser`，Plugins 分区提供不出任何可配置 namespace，theme、locale 与引导确认偏好也停留在进程内——尽管 API 本身会服务它们。

## 决策

`dsh-client-ui-settings` 无条件解析为 `persistence: 'host'`。Host 持久化跟随读取页面的浏览器会话，而不是服务该页面的 authority。`'memory'` 仍是该机制的另一取值：镜像、scope 控制器与 welcome store 都保留各自的内存分支，供真正想让全部偏好留在进程内的组合使用，但没有随附组合选择它。`isLoopback` 恰好失去一个使用方：`ui-settings-general` 中打开 Host 原生文档的操作仍仅限回环，因为在 Host 桌面编辑器中打开文件本身就是位置相关的行为。

更早的 [Host 支撑的偏好决策](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)为非 loopback 页面选定了位置闸门；本笔记取代其中该部分，其余部分继续有效。

## 验证

`packages/client/ui-settings/tests/plugin.client.spec.ts` 固定了非 loopback 的 `$host` 仍会读取 Host 文档；`ui-theme`、`ui-settings-general` 与 `ui-settings-models` 的 apply 规格固定了非 loopback 页面会加载并写入 Host 设置。内存模式机制仍在 `settings-mirror.client.spec.ts`、`settings-scope.client.spec.ts` 与 `welcome-store.client.spec.ts` 中直接受测。

## 曾考虑的替代方案

**把配对后的 LAN 页面当作回环。** 否决：`connection.isLoopback` 回答的是载体是否抵达本地 Host，而配对流程不授予这种身份。放宽它还会把位置相关的原生文档打开操作暴露给手机。

**在连接 ready 帧中新增 paired／trusted-remote 事实。** 否决：settings 文档已由与 `/api` 相同的浏览器会话把关，因此这一额外的 wire 事实只会重述每个已加载页面已证明的事情，并且会改动两个 face 与两个 SDK 共同承载的握手。

**保留按 Host 的远程设置开关。** 否决：唯一的非 loopback 组合就是带 PIN 配对的显式 `--host 0.0.0.0` 选项，再加一个开关只会引入一个当前没有消费方的配置状态。

## 后果

配对后的 LAN 浏览器会编辑与回环页面相同的 `$DSH_HOME/settings.yaml`，包括 Models 页面写入的提供方分节，其 theme、locale 与引导确认也会跨刷新保留。对操作者的影响是：任何在本 Host 上持有有效会话的浏览器都能修改持久化模型配置，正如它本就能驱动会运行工具的会话。只有 Host 原生文档操作在非回环下仍不可用。
