package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"synctool/internal/protocol"
)

var buildDefaultServerPort string

type client struct {
	id   string
	name string
	conn *websocket.Conn
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
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

var seq uint64

func nextClientID() string {
	n := atomic.AddUint64(&seq, 1)
	return fmt.Sprintf("c-%d", n)
}

func main() {
	listenAddr := flag.String("listen", defaultListenAddr(), "server listen address")
	wsPath := flag.String("ws-path", "/ws", "websocket endpoint path")
	flag.Parse()

	h := newHub()
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc(*wsPath, func(w http.ResponseWriter, r *http.Request) {
		handleWS(h, &upgrader, w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("synctool server ok\n"))
	})

	log.Printf("server listening at %s, ws endpoint %s", *listenAddr, *wsPath)
	if err := http.ListenAndServe(*listenAddr, mux); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func defaultListenAddr() string {
	port := strings.TrimSpace(buildDefaultServerPort)
	if port == "" {
		return ":9000"
	}
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}

func handleWS(h *hub, upgrader *websocket.Upgrader, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade failed: %v", err)
		return
	}

	id := nextClientID()
	c := &client{id: id, conn: conn, name: id}
	h.add(c)
	log.Printf("client connected: %s (%s)", c.id, r.RemoteAddr)

	defer func() {
		h.remove(c.id)
		h.broadcastExclude(c.id, protocol.Message{
			Type: protocol.TypeOffline,
			From: c.name,
			At:   time.Now().UnixMilli(),
		})
		_ = conn.Close()
		log.Printf("client disconnected: %s", c.id)
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		msg, err := protocol.Decode(data)
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
			trigger := protocol.Message{Type: protocol.TypeTrigger, From: c.name, At: time.Now().UnixMilli()}
			log.Printf("space event from %s (%s)", c.id, c.name)
			h.broadcastExclude(c.id, trigger)

		case protocol.TypeSync:
			msg.From = c.name
			if msg.At == 0 {
				msg.At = time.Now().UnixMilli()
			}
			log.Printf("sync_state from %s (%s), room=%s, t=%.3f, paused=%t", c.id, c.name, msg.Room, msg.CurrentTime, msg.Paused)
			h.broadcastExclude(c.id, msg)

		default:
			log.Printf("unknown message type from %s: %s", c.id, msg.Type)
		}
	}
}
