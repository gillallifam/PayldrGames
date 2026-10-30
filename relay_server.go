package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Channel Constants (Canal)
// 6 bits = até 64 canais possíveis (0x00 a 0x3F)
const (
	ChanInput   uint8 = 0x00 // Inputs de controle em tempo real (60 FPS, sem garantia)
	ChanCommand uint8 = 0x01 // Comandos do jogo (Pause, Coin, Reset, Select)
	ChanChat    uint8 = 0x02 // Mensagens de texto entre os jogadores
	ChanPing    uint8 = 0x03 // Sincronização / Medição de RTT
	ChanState   uint8 = 0x04 // Checksum de desync / Estado do jogo
)

// Header layout (5 Bytes mínimos):
// [0..1] 2 Bytes: RoomID (uint16 big-endian)
// [2]    1 Byte:  Player & Channel Pack:
//                 - Bits 0..2: Player ID (0 a 7 - até 8 jogadores)
//                 - Bits 3..7: Channel ID (0 a 31 - até 32 canais)
// [3..4] 2 Bytes: Sequence Number / Frame (uint16 big-endian)
// [5..N] Payload do Canal (Inputs, texto de chat, comando, etc.)
const (
	HeaderSize    = 5
	MaxPacketSize = 512
	MaxPlayers    = 8
	PlayerTimeout = 5 * time.Second
)

// Player represents an active player in a room.
type Player struct {
	ID       uint8
	Addr     *net.UDPAddr
	LastSeen time.Time
}

// Room represents an active room with up to MaxPlayers.
type Room struct {
	mu      sync.RWMutex
	ID      uint16
	Players map[uint8]*Player
}

// RoomManager coordinates all active rooms thread-safely.
type RoomManager struct {
	mu    sync.RWMutex
	rooms map[uint16]*Room
}

func NewRoomManager() *RoomManager {
	return &RoomManager{
		rooms: make(map[uint16]*Room),
	}
}

// GetOrCreateRoom returns an existing room or creates a new one.
func (rm *RoomManager) GetOrCreateRoom(roomID uint16) *Room {
	rm.mu.RLock()
	room, exists := rm.rooms[roomID]
	rm.mu.RUnlock()
	if exists {
		return room
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()
	room, exists = rm.rooms[roomID]
	if !exists {
		room = &Room{
			ID:      roomID,
			Players: make(map[uint8]*Player, MaxPlayers),
		}
		rm.rooms[roomID] = room
	}
	return room
}

// UpdatePlayer updates or adds a player in the room. Returns the player list for forwarding.
func (r *Room) UpdateAndGetOthers(playerID uint8, addr *net.UDPAddr, now time.Time) []*net.UDPAddr {
	r.mu.Lock()
	defer r.mu.Unlock()

	p, exists := r.Players[playerID]
	if !exists {
		if len(r.Players) < MaxPlayers {
			r.Players[playerID] = &Player{
				ID:       playerID,
				Addr:     addr,
				LastSeen: now,
			}
		}
	} else {
		p.LastSeen = now
		// Update address in case client port changed (NAT rebinding)
		if !p.Addr.IP.Equal(addr.IP) || p.Addr.Port != addr.Port {
			p.Addr = addr
		}
	}

	// Targets excluding sender
	targets := make([]*net.UDPAddr, 0, len(r.Players))
	for id, pl := range r.Players {
		if id != playerID {
			targets = append(targets, pl.Addr)
		}
	}
	return targets
}

// CleanupInactivePlayers sweeps rooms and removes players inactive for more than timeout.
func (rm *RoomManager) CleanupInactivePlayers(timeout time.Duration) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	now := time.Now()
	for roomID, room := range rm.rooms {
		room.mu.Lock()
		for id, player := range room.Players {
			if now.Sub(player.LastSeen) > timeout {
				delete(room.Players, id)
				log.Printf("[Room %d] Player %d timed out and removed", roomID, id)
			}
		}
		empty := len(room.Players) == 0
		room.mu.Unlock()

		if empty {
			delete(rm.rooms, roomID)
			log.Printf("[Room %d] Empty room cleaned up", roomID)
		}
	}
}

// Config holds runtime configuration
type Config struct {
	Port         int
	Region       string
	CentralAPI   string
	PublicIP     string
	ReportPublic bool
	Verbose      bool
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}

type RegisterPayload struct {
	IP       string   `json:"ip"`
	Port     int      `json:"port"`
	Region   string   `json:"region"`
	Channels []string `json:"channels"`
}

func sendHeartbeat(cfg Config) {
	if cfg.CentralAPI == "" {
		return
	}

	payload := RegisterPayload{
		IP:       cfg.PublicIP,
		Port:     cfg.Port,
		Region:   cfg.Region,
		Channels: []string{"input", "command", "chat", "ping", "state"},
	}

	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[Heartbeat] Error marshaling payload: %v", err)
		return
	}

	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Post(cfg.CentralAPI, "application/json", bytes.NewBuffer(data))
	if err != nil {
		log.Printf("[Heartbeat] Failed to register at %s: %v", cfg.CentralAPI, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[Heartbeat] Central API returned status: %d", resp.StatusCode)
	}
}

// Helpers para empacotar e desempacotar Player e Canal no Byte 2:
// Bits 0..2: PlayerID (0 a 7 - até 8 jogadores)
// Bits 3..7: ChannelID (0 a 31 - até 32 canais)
func UnpackPlayerAndChannel(b byte) (playerID uint8, channelID uint8) {
	playerID = b & 0x07         // Pega os 3 bits inferiores (0 a 7)
	channelID = (b >> 3) & 0x1F // Pega os 5 bits superiores (0 a 31)
	return
}

func PackPlayerAndChannel(playerID uint8, channelID uint8) byte {
	return (playerID & 0x07) | ((channelID & 0x1F) << 3)
}

func ChannelName(ch uint8) string {
	switch ch {
	case ChanInput:
		return "INPUT"
	case ChanCommand:
		return "COMMAND"
	case ChanChat:
		return "CHAT"
	case ChanPing:
		return "PING"
	case ChanState:
		return "STATE"
	default:
		return fmt.Sprintf("CHAN_%d", ch)
	}
}

func main() {
	portFlag := flag.Int("port", getEnvInt("RELAY_PORT", 8080), "UDP listening port")
	regionFlag := flag.String("region", getEnv("RELAY_REGION", "sa-east-1"), "Server region code")
	apiFlag := flag.String("api", getEnv("CENTRAL_API_URL", ""), "Central Matchmaking API URL (optional)")
	publicIPFlag := flag.String("ip", getEnv("PUBLIC_IP", "127.0.0.1"), "Server advertised IP for central registration")
	verboseFlag := flag.Bool("v", false, "Enable verbose logging for non-input channels (commands/chat)")
	flag.Parse()

	cfg := Config{
		Port:       *portFlag,
		Region:     *regionFlag,
		CentralAPI: *apiFlag,
		PublicIP:   *publicIPFlag,
		Verbose:    *verboseFlag,
	}

	log.Printf("Starting Multi-Channel Relay Server on UDP :%d (Region: %s)...", cfg.Port, cfg.Region)
	log.Printf("Channels active: 0=INPUT, 1=COMMAND, 2=CHAT, 3=PING, 4=STATE (Bit-packed zero byte overhead)")

	listenAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil {
		log.Fatalf("Failed to resolve UDP address: %v", err)
	}

	conn, err := net.ListenUDP("udp", listenAddr)
	if err != nil {
		log.Fatalf("Failed to listen on UDP: %v", err)
	}
	defer conn.Close()

	// High-performance buffer pool (MaxPacketSize per buffer)
	bufPool := sync.Pool{
		New: func() any {
			b := make([]byte, MaxPacketSize)
			return &b
		},
	}

	roomManager := NewRoomManager()

	// Auto-Registration & Heartbeat Ticker
	if cfg.CentralAPI != "" {
		log.Printf("Central API configured: %s. Sending initial registration...", cfg.CentralAPI)
		sendHeartbeat(cfg)

		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				sendHeartbeat(cfg)
			}
		}()
	} else {
		log.Println("No CENTRAL_API_URL configured. Running standalone relay mode.")
	}

	// Cleanup routine for idle/disconnected players
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			roomManager.CleanupInactivePlayers(PlayerTimeout)
		}
	}()

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Println("\nShutting down Relay Server gracefully...")
		conn.Close()
		os.Exit(0)
	}()

	log.Println("Multi-Channel UDP loop active. Ready to route packets.")

	// Zero-allocation high-performance UDP loop
	for {
		bufPtr := bufPool.Get().(*[]byte)
		buffer := *bufPtr

		n, remoteAddr, err := conn.ReadFromUDP(buffer)
		if err != nil {
			bufPool.Put(bufPtr)
			if netErr, ok := err.(net.Error); ok && !netErr.Temporary() {
				break
			}
			continue
		}

		// Garante que o pacote tenha no mínimo 5 bytes de cabeçalho
		if n < HeaderSize {
			bufPool.Put(bufPtr)
			continue
		}

		// Extração ultrarrápida (Zero GC):
		// [0..1] Room ID
		// [2]    Player ID (2 bits) & Channel ID (6 bits)
		// [3..4] Sequence / Frame Number
		roomID := binary.BigEndian.Uint16(buffer[0:2])
		playerID, channelID := UnpackPlayerAndChannel(buffer[2])

		now := time.Now()
		room := roomManager.GetOrCreateRoom(roomID)
		targets := room.UpdateAndGetOthers(playerID, remoteAddr, now)

		if cfg.Verbose && channelID != ChanInput {
			log.Printf("[Room %d] Chan: %s from Player %d (%d bytes) -> %d peers",
				roomID, ChannelName(channelID), playerID, n, len(targets))
		}

		// Encaminhamento direto para os outros participantes da sala
		payloadToSend := buffer[:n]
		for _, target := range targets {
			_, _ = conn.WriteToUDP(payloadToSend, target)
		}

		bufPool.Put(bufPtr)
	}
}
