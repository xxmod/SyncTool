package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"synctool/internal/protocol"
)

type client struct {
	id   string
	name string
	conn net.Conn
	wmu  sync.Mutex
}

type hub struct {
	mu      sync.RWMutex
	clients map[string]*client
}

func newHub() *hub {
	return &hub{clients: make(map[string]*client)}
}

func (h *hub) add(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c.id] = c
}

func (h *hub) remove(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, id)
}

func (h *hub) broadcastExclude(senderID string, msg protocol.Message) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for id, c := range h.clients {
		if id == senderID {
			continue
		}
		if err := sendMessage(c, msg); err != nil {
			log.Printf("broadcast to %s failed: %v", id, err)
		}
	}
}

func sendMessage(c *client, msg protocol.Message) error {
	payload, err := protocol.Encode(msg)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.conn.Write(payload)
	return err
}

var seq uint64

func nextClientID() string {
	n := atomic.AddUint64(&seq, 1)
	return fmt.Sprintf("c-%d", n)
}

func main() {
	listenAddr := flag.String("listen", ":9000", "server listen address")
	flag.Parse()

	ln, err := net.Listen("tcp", *listenAddr)
	if err != nil {
		log.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	h := newHub()
	log.Printf("server listening at %s", *listenAddr)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept failed: %v", err)
			continue
		}
		go handleConn(h, conn)
	}
}

func handleConn(h *hub, conn net.Conn) {
	id := nextClientID()
	c := &client{id: id, conn: conn, name: id}
	h.add(c)
	log.Printf("client connected: %s (%s)", c.id, conn.RemoteAddr().String())

	defer func() {
		h.remove(c.id)
		_ = conn.Close()
		log.Printf("client disconnected: %s", c.id)
	}()

	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		line := sc.Bytes()
		msg, err := protocol.Decode(line)
		if err != nil {
			log.Printf("decode failed from %s: %v", c.id, err)
			continue
		}

		switch msg.Type {
		case protocol.TypeHello:
			if msg.Name != "" {
				c.name = msg.Name
			}
			log.Printf("hello: %s as %s", c.id, c.name)

		case protocol.TypeSpace:
			trigger := protocol.Message{
				Type: protocol.TypeTrigger,
				From: c.name,
				At:   time.Now().UnixMilli(),
			}
			log.Printf("space event from %s (%s)", c.id, c.name)
			h.broadcastExclude(c.id, trigger)

		default:
			log.Printf("unknown message type from %s: %s", c.id, msg.Type)
		}
	}

	if err := sc.Err(); err != nil {
		log.Printf("read failed from %s: %v", c.id, err)
	}
}
