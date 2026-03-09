# SyncTool (Go)

一个包含服务端与客户端的空格同步工具：

- 客户端连接到指定服务端 WebSocket 地址（`ws://` 或 `wss://`）
- 客户端全局检测空格按下
- 当任意客户端按下空格后，上报服务端
- 服务端通知所有其他已连接客户端
- 其他客户端收到通知后，模拟按下空格

> 当前实现重点支持 Windows（基于 Win32 API）。网络层使用 HTTP WebSocket，支持通过反向代理接入 HTTPS（即客户端使用 `wss://`）。

## 项目结构

- `cmd/server/main.go`：服务端
- `cmd/client/main.go`：客户端
- `internal/protocol/protocol.go`：消息协议
- `internal/client/keyboard_windows.go`：Windows 键盘检测/模拟

## 运行环境

- Go 1.22+
- Windows（客户端键盘功能）

## 启动服务端

```bash
go run ./cmd/server -listen :9000
```

参数：

- `-listen`：监听地址，默认 `:9000`
- `-ws-path`：WebSocket 路径，默认 `/ws`

## 启动客户端

```bash
go run ./cmd/client -server ws://127.0.0.1:9000/ws
```

参数：

- `-server`：服务端 WebSocket 地址，默认 `ws://127.0.0.1:9000/ws`
- `-name`：客户端显示名（可选）

## 通过 .env 构建默认配置

`build.go` 会读取根目录 `.env`，并把默认值写入构建产物（build-time 注入）：

- `DEFAULT_SERVER_PORT`：服务端默认监听端口（例如 `9000`）
- `DEFAULT_SERVER_ADDR`：客户端默认连接地址（例如 `ws://192.168.1.49:9000/ws` 或 `wss://your-domain/ws`）

示例：

```env
DEFAULT_SERVER_PORT=9000
DEFAULT_SERVER_ADDR=ws://192.168.1.49:9000/ws
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
- `synctool-client-linux-amd64`

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
2. 启动 2 个或以上客户端。
3. 在任意一个客户端所在机器上按下空格。
4. 观察：
   - 当前客户端上报事件到服务端
   - 服务端广播给其他客户端
   - 其他客户端执行一次空格模拟按键

## 注意事项

- 客户端对“模拟产生的空格”有短暂抑制窗口，避免循环触发风暴。
- 如果你要跨平台支持（Linux/macOS）全局按键与模拟，需要替换对应平台实现。

## 油猴脚本（Bilibili / Emby）

已提供脚本：`scripts/bilibili-emby-sync.user.js`

用途：

- 在浏览器内读取 `<video>` 的 `currentTime/paused/playbackRate`
- 通过 WebSocket 上报到本项目服务端
- 其他用户自动跳转到该进度并同步播放/暂停状态

安装：

1. 安装 Tampermonkey。
2. 新建脚本并粘贴 `scripts/bilibili-emby-sync.user.js` 内容。
3. 打开 B 站或 Emby 播放页，按 `F12` 在控制台配置：

```javascript
window.synctool.setServer('ws://你的服务端:9000/ws')
window.synctool.setRoom('room-1')
window.synctool.setName('user-a')
```

4. 刷新页面生效。

操作：

- 主控按键：`Ctrl+Shift+S` 发送当前进度状态
- 也支持本地 `seek/pause/play/ratechange` 自动广播

协议新增：

- `type: "sync_state"`
- 主要字段：`room/currentTime/paused/rate/url/from/at`

说明：

- 服务端会将 `sync_state` 广播给其他在线客户端。
- 客户端按 `room` 过滤消息，不同房间互不影响。
