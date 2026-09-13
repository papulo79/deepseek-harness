# Agent Note: Web GUI 的 LAN 移动端配对

Status: implemented

[English](2026-09-10-lan-mobile-pairing.md) | 中文

## 问题

Web GUI 最初只是 loopback 表层：`dsh web` 绑定 `127.0.0.1`，CLI 直接拒绝 `--host 0.0.0.0`。想让同一网络中的手机驱动同一个具备工具能力的 Session 的操作者，只能转发端口，或把进程启动令牌——一个进程级 bearer 凭据——粘贴进手机浏览器，于是它会留在地址栏、历史记录和任何书签里。现有的浏览器会话 cookie 已经把已认证浏览器限定在某个 authority 上；缺的是一种在不交出进程凭据的前提下接纳手机的方式。

## 决策

`dsh web --host 0.0.0.0` 是受支持且明确的主动选择。loopback 仍是默认值，CLI 本身不添加主机校验：解析出的值直接写入 webserver 配置项，其 schemastery `host` 字面量联合类型是唯一有效性真源，其他任何值都会让加载显式失败。服务器完成绑定后，Web 运行时只采样一次本机所有非 internal 的 IPv4 地址，把它们加入 `/api` 的 Host/Origin 栅栏，并以干净的 LAN URL 加六位 PIN 的形式打印；loopback URL 仍保留进程 token 及其原有交换流程。

`dsh-client-connection` 负责配对，因为它本就负责浏览器认证。当 `config.pairing.authorities` 非空时，它为每个进程生成一个六位 PIN（由根应用上下文持有，可跨 Connection 热重载保留），并注册精确的 `POST /pair` 路由。Host 与配对 authority 匹配、对 dist 根路径发起的未认证 `GET` 会收到一个不含 PIN 的极简 HTML 表单；其他未认证的 index 请求仍得到普通的 401。该路由先应用 Host/Origin 栅栏，把请求体限制在 1024 字节，要求 `application/x-www-form-urlencoded` 请求体中恰好有一个 `pin` 字段，并使用现有的恒定时间比较进行校验。比对成功即签发与本地 token 交换相同的、签名且绑定 authority 的 cookie，因此已配对的手机与本地浏览器汇聚到同一条认证路径。同一对端地址失败五次（`maxFailedAttempts`）后，该地址会被锁定五分钟（`lockoutMilliseconds`），期间收到 429 且不校验 PIN；所有对端合计失败 `maxTotalFailedAttempts` 次（默认 50）后配对会停止，直到进程重启，从而约束轮换源地址的对端集合。

Web 组合把 `ctx.webRuntime.lanAddresses` 作为配对 authority 传入，因此只有 CLI 绑定了所有接口且至少探测到一个 LAN 地址时才存在配对。仅当 LAN URL 与 `ctx.connection.pairing` 同时存在时，Web 运行时才打印 PIN，并且绝不替换本地 token URL。

## 验证

[`browser-auth.host.spec.ts`](../../../../packages/client/connection/tests/browser-auth.host.spec.ts) 固定表单、PIN 比较、按对端限流、锁定到期，以及缺少 authority 或对端地址时的拒绝行为。[`node-half.host.spec.ts`](../../../../packages/client/connection/tests/node-half.host.spec.ts) 固定路由的 403/405/413/400 响应、PIN 默认值与加载期 authority 校验。[`frontend-static.spec.ts`](../../../../packages/host/frontend-static/tests/frontend-static.spec.ts) 通过真实 Loader 组合启动，经 HTTP 提供配对页、交换 PIN，并用签发的 cookie 提供 shell。[`web-app.spec.ts`](../../../../packages/bundle/web-app/tests/web-app.spec.ts) 与 [`startup.spec.ts`](../../../../packages/bundle/web-app/tests/startup.spec.ts) 固定 URL 行与被接受的标志。

## 曾考虑的替代方案

**把启动令牌放进 LAN URL。** 不予采纳：该 URL 会把进程 bearer 凭据留在手机的地址栏、历史记录与书签中，截图或分享链接都会泄露它。

**在现有 token 查询参数上接受 PIN。** 不予采纳：交换流程占用 `GET /`，而且可见的查询值同样会被日志与书签记录。POST 表单让 PIN 不进入 URL 与浏览器历史。

**允许任何 `trustedHosts` authority 配对。** 不予采纳：`--trusted-host` 用于让部署服务某个具名 authority，操作者可能添加它而并不打算将其作为 LAN 配对端点。配对只使用派生出的 LAN 字面量，即其严格子集。

**用 IP 地址认证手机。** 不予采纳：DHCP 租约不是身份，对端地址只作为限流键。

## 后果

配对不新增任何权限：有效 PIN 得到的 cookie 与本地 token 交换已签发的完全相同，无效 PIN 得到 401 或 429。PIN 只存在于内存并随进程结束而失效，因此重启会改变它，网络变化也需要重启才能重新公告。

监听器仍不提供 TLS。在不可信网络中，PIN 与会话 cookie 以明文传输，因此全接口绑定是操作者明确承担的风险，而不是加固过的远程部署。对端状态是以源地址为键的无界映射；在交换式 LAN 上，对端无法廉价伪造 TCP 源地址，因此其规模上限是能到达该端口的不同对端数量。`--trusted-host` 绝不授予身份，LAN PIN 流程也不改变 [Host/Origin 栅栏](2026-07-28-api-browser-trust-boundary.zh.md)或[浏览器令牌交换](2026-08-24-browser-token-authentication.zh.md)。
