# 弈间 · 在线五子棋

可在微信内置浏览器打开的双人 H5 五子棋网站。React + TypeScript 网页和 Node.js WebSocket 服务部署在同一个实例，支持 15×15 棋盘、房间邀请、实时同步、悔棋协商、认输、重开与断线恢复。

## 发布并获取微信可打开的链接

[点击在 Render 部署本仓库](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fltwyz55-a11y%2Fgomoku-online)

1. 打开上述入口，在 Render 登录账号并授权访问本 GitHub 仓库。
2. 按页面提示创建 Blueprint，确认 `gomoku-online` 为 **Free** 方案。配置已包含新加坡区域、Node.js 24.21.0、安装、构建、自动测试及健康检查。
3. 等服务显示 **Live**，复制其 `https://…onrender.com` 公网地址。本文没有预填网址，以免将未创建的服务误认为已经上线。
4. 将公网地址发送到微信。甲打开后填写昵称、创建房间，再把邀请链接或六位房间号发给乙。乙打开同一网址、填写昵称并加入房间。
5. 甲执黑先行。手机切到后台后回来会尝试重连；刷新同一标签页可以恢复座位。

也可在 Render 选择 **New → Blueprint**，连接 `ltwyz55-a11y/gomoku-online` 的 `main` 分支。源码已公开。`render.yaml` 会随提交触发自动部署；重新部署会清空内存中的房间。

官方说明：[部署按钮](https://render.com/docs/deploy-to-render)、[免费服务限制](https://render.com/docs/free)。

## 本地开发与生产检查

使用 Node.js 22.13 或更高版本（小于 25，推荐 24）与 pnpm 11.25.0。

```sh
npx --yes pnpm@11.25.0 install --frozen-lockfile
pnpm dev
```

访问 `http://localhost:5173/`。开发页面通过代理连接端口 3001 的 `/ws`。`localhost` 仅指当前设备，不能发给另一台手机使用。

```sh
pnpm build
pnpm test
pnpm start
```

生产模式访问 `http://localhost:3001/`，`GET /health` 返回 `{"status":"ok"}`。`PORT` 可覆盖端口。生产网页使用同源 `/ws`，HTTPS 页面自动使用 WSS。`pnpm preview` 仅预览静态文件，联机验证请使用 `pnpm start`。

## 目录与规则

- `server.js`：HTTP 网页、健康检查、房间和权威棋局状态。
- `src/useRoom.ts`：连接保活、指数退避重连、会话恢复与操作超时处理。
- `src/main.tsx`、`src/style.css`：中文页面、触控棋盘和邀请流程。
- `tests/server.test.mjs`：通过真实 WebSocket 验证对局规则、断线和错误输入。
- `render.yaml`：单实例 Render 免费服务部署配置。

黑棋先行，任意方向连成五子或更多获胜，无禁手。只能申请撤回自己刚下的一子，需要对方同意；协商期间暂停落子。重开需要双方同意。主动离开会结束房间。

每名掉线玩家分别保留座位两分钟，任一玩家超时则关闭房间；已连接的另一方会收到提示。重连凭据存于当前标签页的 sessionStorage，两窗口可独立对局。清除网站数据或关闭标签页后重新打开，不能保证恢复原座位。服务重启后的失效房间会显示明确提示。

## 验收状态（2026-10-16）

- 已通过：TypeScript 与生产构建；8 项服务端集成测试，涵盖满员/失效房间、双方落子同步、非法/重复操作、双向悔棋、认输、重开、四种五连方向、225 步平局、替换旧连接、断线恢复与超时清理。
- 待完成：Render 账号连接、实际云端首次部署与 HTTPS/WSS 检查。
- 待实机验收：两台手机分别用微信打开公网地址，完成邀请、对弈、悔棋、重开及切换网络恢复。当前执行环境阻止自动化 Chrome 启动，因此未声称移动端视觉和触控验收通过。

免费实例可能休眠，唤醒需要等待；房间只存在服务内存中，服务重启会清空。海外线路在中国大陆的实际效果需用目标设备验收。本项目按单实例运行，不适合直接增加实例数。
