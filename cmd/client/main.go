package main

import (
	"flag"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	iclient "synctool/internal/client"
	"synctool/internal/protocol"
)

var buildDefaultServerAddr string

func main() {
	serverAddr := flag.String("server", defaultServerAddr(), "websocket server address, e.g. ws://127.0.0.1:9000/ws")
	name := flag.String("name", "", "client display name")
	flag.Parse()

	displayName := *name
	if displayName == "" {
		hostname, err := os.Hostname()
		if err != nil || hostname == "" {
			displayName = "client"
		} else {
			displayName = hostname
		}
	}

	for {
		if err := runClient(*serverAddr, displayName); err != nil {
			log.Printf("client disconnected: %v", err)
		}
		log.Printf("reconnecting in 2s...")
		time.Sleep(2 * time.Second)
	}
}

func runClient(serverAddr, displayName string) error {
	conn, _, err := websocket.DefaultDialer.Dial(serverAddr, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	log.Printf("connected to %s as %s", serverAddr, displayName)

	var writeMu sync.Mutex
	if err := writeMessage(conn, &writeMu, protocol.Message{Type: protocol.TypeHello, Name: displayName}); err != nil {
		return err
	}

	stop := make(chan struct{})
	readErr := make(chan error, 1)
	var suppressUntilNs int64
	go readLoop(conn, readErr, stop, &suppressUntilNs)

	pollTicker := time.NewTicker(15 * time.Millisecond)
	defer pollTicker.Stop()

	var lastDown bool
	for {
		select {
		case err := <-readErr:
			close(stop)
			return err

		case <-pollTicker.C:
			now := time.Now()
			down, err := iclient.IsSpaceDown()
			if err != nil {
				close(stop)
				return err
			}

			if now.UnixNano() < atomic.LoadInt64(&suppressUntilNs) {
				lastDown = down
				continue
			}

			if down && !lastDown {
				if err := writeMessage(conn, &writeMu, protocol.Message{Type: protocol.TypeSpace, At: now.UnixMilli()}); err != nil {
					close(stop)
					return err
				}
			}
			lastDown = down
		}
	}
}

func readLoop(conn *websocket.Conn, errCh chan<- error, stop <-chan struct{}, suppressUntilNs *int64) {
	for {
		select {
		case <-stop:
			return
		default:
		}

		_, data, err := conn.ReadMessage()
		if err != nil {
			errCh <- err
			return
		}

		msg, err := protocol.Decode(data)
		if err != nil {
			log.Printf("decode failed: %v", err)
			continue
		}

		if msg.Type != protocol.TypeTrigger {
			continue
		}

		atomic.StoreInt64(suppressUntilNs, time.Now().Add(300*time.Millisecond).UnixNano())
		if err := iclient.SimulateSpacePress(); err != nil {
			log.Printf("simulate space failed: %v", err)
			continue
		}
		log.Printf("received trigger from %s, simulated space", msg.From)
	}
}

func writeMessage(conn *websocket.Conn, mu *sync.Mutex, msg protocol.Message) error {
	payload, err := protocol.Encode(msg)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, payload)
}

func defaultServerAddr() string {
	if buildDefaultServerAddr != "" {
		return buildDefaultServerAddr
	}
	return "ws://127.0.0.1:9000/ws"
}
