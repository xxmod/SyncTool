package main

import (
	"bufio"
	"flag"
	"log"
	"net"
	"os"
	"sync/atomic"
	"time"

	iclient "synctool/internal/client"
	"synctool/internal/protocol"
)

func main() {
	serverAddr := flag.String("server", "127.0.0.1:9000", "server address")
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
	conn, err := net.Dial("tcp", serverAddr)
	if err != nil {
		return err
	}
	defer conn.Close()

	log.Printf("connected to %s as %s", serverAddr, displayName)

	if err := writeMessage(conn, protocol.Message{Type: protocol.TypeHello, Name: displayName}); err != nil {
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
				if err := writeMessage(conn, protocol.Message{Type: protocol.TypeSpace, At: now.UnixMilli()}); err != nil {
					close(stop)
					return err
				}
			}
			lastDown = down
		}
	}
}

func readLoop(conn net.Conn, errCh chan<- error, stop <-chan struct{}, suppressUntilNs *int64) {
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		select {
		case <-stop:
			return
		default:
		}

		msg, err := protocol.Decode(sc.Bytes())
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
	if err := sc.Err(); err != nil {
		errCh <- err
		return
	}
	errCh <- net.ErrClosed
}

func writeMessage(conn net.Conn, msg protocol.Message) error {
	payload, err := protocol.Encode(msg)
	if err != nil {
		return err
	}
	_, err = conn.Write(payload)
	return err
}
