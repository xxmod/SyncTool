package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type target struct {
	goos   string
	goarch string
}

func main() {
	arm64 := flag.Bool("arm64", true, "build arm64 targets")
	amd64 := flag.Bool("amd64", true, "build amd64 targets")
	flag.Parse()

	if !*arm64 && !*amd64 {
		fatal("at least one architecture must be enabled")
	}

	envMap := loadDotEnv(".env")
	defaultPort := firstNonEmpty(envMap["DEFAULT_SERVER_PORT"], "9000")
	defaultAddr := firstNonEmpty(envMap["DEFAULT_SERVER_ADDR"], "ws://127.0.0.1:9000/ws")
	defaultRoomCount := firstNonEmpty(envMap["DEFAULT_SERVER_ROOM_COUNT"], "3")

	if err := os.MkdirAll("bin", 0o755); err != nil {
		fatalf("create bin dir failed: %v", err)
	}

	arches := make([]string, 0, 2)
	if *amd64 {
		arches = append(arches, "amd64")
	}
	if *arm64 {
		arches = append(arches, "arm64")
	}

	oses := []string{"windows", "linux", "darwin"}
	targets := make([]target, 0, len(oses)*len(arches))
	for _, goos := range oses {
		for _, goarch := range arches {
			targets = append(targets, target{goos: goos, goarch: goarch})
		}
	}

	for _, t := range targets {
		serverName := binName("synctool-server", t.goos, t.goarch)
		clientName := binName("synctool-client", t.goos, t.goarch)

		serverPath := filepath.Join("bin", serverName)
		clientPath := filepath.Join("bin", clientName)

		fmt.Printf("Building %s/%s server -> %s\n", t.goos, t.goarch, serverPath)
		err := goBuild(
			t,
			serverPath,
			"./cmd/server",
			"-X main.buildDefaultServerPort="+defaultPort+" -X main.buildDefaultRoomCount="+defaultRoomCount,
		)
		if err != nil {
			fatalf("build server for %s/%s failed: %v", t.goos, t.goarch, err)
		}

		fmt.Printf("Building %s/%s client -> %s\n", t.goos, t.goarch, clientPath)
		err = goBuild(t, clientPath, "./cmd/client", "-X main.buildDefaultServerAddr="+defaultAddr)
		if err != nil {
			fatalf("build client for %s/%s failed: %v", t.goos, t.goarch, err)
		}
	}

	fmt.Println("Build finished.")
	fmt.Printf("Injected defaults: DEFAULT_SERVER_PORT=%s, DEFAULT_SERVER_ADDR=%s, DEFAULT_SERVER_ROOM_COUNT=%s\n", defaultPort, defaultAddr, defaultRoomCount)
}

func goBuild(t target, outPath, pkg, ldflags string) error {
	cmd := exec.Command("go", "build", "-ldflags", ldflags, "-o", outPath, pkg)
	cmd.Env = append(os.Environ(),
		"CGO_ENABLED=0",
		"GOOS="+t.goos,
		"GOARCH="+t.goarch,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func binName(prefix, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("%s-%s-%s%s", prefix, goos, goarch, ext)
}

func loadDotEnv(path string) map[string]string {
	result := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return result
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		k := strings.TrimSpace(parts[0])
		v := strings.TrimSpace(parts[1])
		if k != "" {
			result[k] = v
		}
	}
	return result
}

func firstNonEmpty(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func fatalf(format string, a ...any) {
	fatal(fmt.Sprintf(format, a...))
}
