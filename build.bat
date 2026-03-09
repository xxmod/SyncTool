@echo off
setlocal

if not exist .\bin mkdir .\bin

if exist .env (
	for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
		if not "%%A"=="" if not "%%A:~0,1"=="#" set "%%A=%%B"
	)
)

if "%DEFAULT_SERVER_PORT%"=="" set "DEFAULT_SERVER_PORT=9000"
if "%DEFAULT_SERVER_ADDR%"=="" set "DEFAULT_SERVER_ADDR=ws://127.0.0.1:9000/ws"

go build -ldflags "-X main.buildDefaultServerPort=%DEFAULT_SERVER_PORT%" -o .\bin\synctool-server.exe .\cmd\server
if errorlevel 1 exit /b 1

go build -ldflags "-X main.buildDefaultServerAddr=%DEFAULT_SERVER_ADDR%" -o .\bin\synctool-client.exe .\cmd\client
if errorlevel 1 exit /b 1

echo Build done.
echo Server default port: %DEFAULT_SERVER_PORT%
echo Client default addr: %DEFAULT_SERVER_ADDR%