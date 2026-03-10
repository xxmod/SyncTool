# SyncTool (Go)

一个服务端 + 油猴脚本（Bilibili/Emby）的视频同步工具：

- 网页端通过 WebSocket 连接服务端（`ws://` 或 `wss://`）
- 通过房间隔离同步 `currentTime/paused/playbackRate`
- 支持手动同步快捷键与播放行为自动同步

> 网络层使用 HTTP WebSocket，支持通过反向代理接入 HTTPS（即油猴脚本使用 `wss://`）。

## 项目结构

- `cmd/server/main.go`：服务端
- `internal/protocol/protocol.go`：消息协议
- `scripts/sync.user.js`：Bilibili/Emby 油猴同步脚本

## 运行环境

- Go 1.22+

## 启动服务端

```bash
go run ./cmd/server -listen :9000
```

参数：

- `-listen`：监听地址，默认 `:9000`
- `-ws-path`：WebSocket 路径，默认 `/ws`
- `-room-count`：房间数量，默认读取构建注入值（形如 `room-1 ... room-N`）

## 通过 .env 构建默认配置

`build.go` 会读取根目录 `.env`，并把默认值写入构建产物（build-time 注入）：

- `DEFAULT_SERVER_PORT`：服务端默认监听端口（例如 `9000`）
- `DEFAULT_SERVER_ROOM_COUNT`：服务端默认房间数（例如 `3`）

示例：

```env
DEFAULT_SERVER_PORT=9000
DEFAULT_SERVER_ROOM_COUNT=3
```

构建：

```bash
go run ./build.go
```

按架构控制构建（示例）：

```bash
go run ./build.go -amd64=true -arm64=false
```

默认会构建以下平台：

- `windows/amd64`、`windows/arm64`
- `linux/amd64`、`linux/arm64`
- `darwin/amd64`、`darwin/arm64`

产物在 `bin/` 下，命名示例：

- `synctool-server-windows-amd64.exe`

如果 `go run ./build.go` 在 Windows 报错：

`exec: "...\\build": executable file not found in %PATH%`

通常是当前终端被设置了 `GOOS=linux` / `GOARCH=amd64`。先清理再运行：

```powershell
Remove-Item Env:GOOS -ErrorAction SilentlyContinue
Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
go run .\build.go
```

## 测试方式

1. 启动 1 个服务端。
2. 在 2 个浏览器页面安装并连接油猴脚本到同一房间。
3. 在任意一端触发播放/暂停/拖动或按 `Ctrl+Shift+S`。
4. 观察另一端状态与进度同步。

## 注意事项

- 同步是房间级别的，跨房间互不影响。
- 建议通过反向代理暴露 `wss://`，避免浏览器混合内容限制。

## 油猴脚本（Bilibili / Emby）

已提供脚本：`scripts/sync.user.js`

用途：

- 在浏览器内读取 `<video>` 的 `currentTime/paused/playbackRate`
- 通过 WebSocket 上报到本项目服务端
- 其他用户自动跳转到该进度并同步播放/暂停状态

安装：

1. 安装 Tampermonkey。
2. 新建脚本并粘贴 `scripts/sync.user.js` 内容。
3. 打开 B 站或 Emby 播放页，右上角会出现控制窗口：

- 可填写服务器地址并重连
- 可拉取房间列表
- 可选择房间并 `Join/Leave`
- 可手动 `Hide` 窗口（全屏时自动隐藏）

4. 也可以在控制台配置：

```javascript
window.synctool.setServer('ws://你的服务端:9000/ws')
window.synctool.setRoom('room-1')
window.synctool.setName('user-a')
```

5. 刷新页面生效。

操作：

- 主控按键：`Ctrl+Shift+S` 发送当前进度状态
- 也支持本地 `seek/pause/play/ratechange` 自动广播

协议新增：

- `type: "sync_state"`
- 主要字段：`room/currentTime/paused/rate/url/from/at`

说明：

- 服务端会将 `sync_state` 广播给其他在线客户端。
- 房间内同步，跨房间互不影响。
- 支持 `list_rooms` / `join_room` / `leave_room`，可自由进出房间。

## GitHub 一键安装油猴脚本

仓库已提供工作流：`.github/workflows/userscript-pages.yml`

作用：

- 当你 push 到 `main/master` 后，自动把 `scripts/sync.user.js` 发布到 GitHub Pages。
- 自动生成安装页（`pages/index.html`）。

你需要做一次设置：

1. 打开 GitHub 仓库 `Settings`。
2. 进入 `Pages`。
3. `Source` 选择 `GitHub Actions`。

发布后可用地址：

- 安装页：`https://<你的用户名>.github.io/<仓库名>/`
- 直接安装链接：`https://<你的用户名>.github.io/<仓库名>/sync.user.js`

在安装页点击“一键安装 sync.user.js”即可像油叉那样直接安装。
