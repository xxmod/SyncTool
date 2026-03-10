package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"synctool/internal/protocol"
)

var buildDefaultServerPort string
var buildDefaultRoomCount string

type client struct {
	id   string
	name string
	room string
	conn *websocket.Conn
	wmu  sync.Mutex
}

type hub struct {
	mu              sync.RWMutex
	clients         map[string]*client
	rooms           []string
	roomDesiredPlay map[string]bool
}

func newHub(rooms []string) *hub {
	return &hub{
		clients:         make(map[string]*client),
		rooms:           rooms,
		roomDesiredPlay: make(map[string]bool),
	}
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

func (h *hub) removeAndGetRoom(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.clients[id]
	if !ok {
		return ""
	}
	room := c.room
	delete(h.clients, id)
	return room
}

func (h *hub) broadcastExcludeInRoom(senderID, room string, msg protocol.Message) {
	h.mu.RLock()
	targets := make([]*client, 0, len(h.clients))
	for id, c := range h.clients {
		if id == senderID {
			continue
		}
		if c.room != room {
			continue
		}
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		if err := sendMessage(c, msg); err != nil {
			log.Printf("broadcast to %s failed: %v", c.id, err)
		}
	}
}

func (h *hub) broadcastInRoom(room string, msg protocol.Message) {
	h.mu.RLock()
	targets := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.room != room {
			continue
		}
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		if err := sendMessage(c, msg); err != nil {
			log.Printf("broadcast to %s failed: %v", c.id, err)
		}
	}
}

func (h *hub) isValidRoom(room string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, r := range h.rooms {
		if r == room {
			return true
		}
	}
	return false
}

func (h *hub) roomList() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]string, len(h.rooms))
	copy(out, h.rooms)
	return out
}

func (h *hub) changeRoom(id, room string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.clients[id]
	if !ok {
		return false
	}
	c.room = room
	return true
}

func (h *hub) getClientRoom(id string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[id]
	if !ok {
		return ""
	}
	return c.room
}

func (h *hub) setRoomDesiredPlaying(room string, playing bool) {
	if room == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.roomDesiredPlay[room] = playing
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
	roomCount := flag.Int("room-count", defaultRoomCount(), "room count, generated as room-1..room-N")
	flag.Parse()
	if *roomCount < 1 {
		log.Fatalf("room-count must be >= 1")
	}

	h := newHub(makeRooms(*roomCount))
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

	log.Printf("server listening at %s, ws endpoint %s, rooms=%d", *listenAddr, *wsPath, *roomCount)
	if err := http.ListenAndServe(*listenAddr, mux); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func makeRooms(count int) []string {
	rooms := make([]string, 0, count)
	for i := 1; i <= count; i++ {
		rooms = append(rooms, fmt.Sprintf("room-%d", i))
	}
	return rooms
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

func defaultRoomCount() int {
	v := strings.TrimSpace(buildDefaultRoomCount)
	if v == "" {
		return 3
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 3
	}
	return n
}

func handleWS(h *hub, upgrader *websocket.Upgrader, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade failed: %v", err)
		return
	}

	id := nextClientID()
	defaultRoom := h.roomList()[0]
	c := &client{id: id, conn: conn, name: id, room: defaultRoom}
	h.add(c)
	log.Printf("client connected: %s (%s)", c.id, r.RemoteAddr)

	defer func() {
		leftRoom := h.removeAndGetRoom(c.id)
		h.broadcastExcludeInRoom(c.id, leftRoom, protocol.Message{
			Type: protocol.TypeOffline,
			From: c.name,
			Room: leftRoom,
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
			room := h.getClientRoom(c.id)
			log.Printf("hello: %s as %s", c.id, c.name)
			_ = sendMessage(c, protocol.Message{Type: protocol.TypeList, Rooms: h.roomList(), Room: room, At: time.Now().UnixMilli()})
			_ = sendMessage(c, protocol.Message{Type: protocol.TypeJoined, Room: room, Rooms: h.roomList(), At: time.Now().UnixMilli()})

		case protocol.TypeList:
			room := h.getClientRoom(c.id)
			_ = sendMessage(c, protocol.Message{Type: protocol.TypeList, Rooms: h.roomList(), Room: room, At: time.Now().UnixMilli()})

		case protocol.TypeJoin:
			if !h.isValidRoom(msg.Room) {
				_ = sendMessage(c, protocol.Message{Type: protocol.TypeError, Error: "invalid room", Rooms: h.roomList(), Room: c.room, At: time.Now().UnixMilli()})
				continue
			}
			h.changeRoom(c.id, msg.Room)
			joinedRoom := h.getClientRoom(c.id)
			log.Printf("client %s joined %s", c.id, joinedRoom)
			_ = sendMessage(c, protocol.Message{Type: protocol.TypeJoined, Room: joinedRoom, Rooms: h.roomList(), At: time.Now().UnixMilli()})

		case protocol.TypeLeave:
			h.changeRoom(c.id, "")
			log.Printf("client %s left room", c.id)
			_ = sendMessage(c, protocol.Message{Type: protocol.TypeJoined, Room: "", Rooms: h.roomList(), At: time.Now().UnixMilli()})

		case protocol.TypeSync:
			room := h.getClientRoom(c.id)
			if room == "" {
				continue
			}
			h.setRoomDesiredPlaying(room, !msg.Paused)
			msg.From = c.name
			msg.Room = room
			if msg.At == 0 {
				msg.At = time.Now().UnixMilli()
			}
			log.Printf("sync_state from %s (%s), room=%s, t=%.3f, paused=%t", c.id, c.name, msg.Room, msg.CurrentTime, msg.Paused)
			h.broadcastExcludeInRoom(c.id, room, msg)

		default:
			log.Printf("unknown message type from %s: %s", c.id, msg.Type)
		}
	}
}
