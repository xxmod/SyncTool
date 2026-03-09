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

`build.bat` 会读取根目录 `.env`，并把默认值写入 exe（build-time 注入）：

- `DEFAULT_SERVER_PORT`：服务端默认监听端口（例如 `9000`）
- `DEFAULT_SERVER_ADDR`：客户端默认连接地址（例如 `ws://192.168.1.49:9000/ws` 或 `wss://your-domain/ws`）

示例：

```env
DEFAULT_SERVER_PORT=9000
DEFAULT_SERVER_ADDR=ws://192.168.1.49:9000/ws
```

构建：

```bat
build.bat
```

构建后的 `synctool-client.exe` 与 `synctool-server.exe` 在不传参数时会使用注入后的默认值。

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
