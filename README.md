# 弈间 · 在线五子棋

React + Vite 网页和 Node.js WebSocket 服务。房间号用于邀请对手；房间状态保存在运行中的服务内存中。

## 本地运行

需要 Node.js 22.12 或更新版本，以及 pnpm 11.25。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发页面默认运行在 `http://localhost:5173`，WebSocket 服务运行在端口 `3001`。

## 发布到 Render

项目根目录的 `render.yaml` 已配置 Node 服务、新加坡区域、免费实例、构建命令、启动命令和 `/health` 健康检查。

1. 将项目推送到 GitHub 私有仓库。
2. 在 Render 控制台选择 **New → Blueprint**，连接该仓库并应用 `render.yaml`。
3. 等首次部署完成后，用 Render 提供的 HTTPS 地址在微信中打开并测试。

免费服务空闲时会休眠；实例重启会清空房间。跨境网络访问效果需要在实际微信环境中确认。
