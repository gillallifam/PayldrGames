package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

// Estruturas de Modelo
type User struct {
	ID        int64   `json:"id"`
	Name      *string `json:"name"`
	Email     *string `json:"email"`
	Username  *string `json:"username"`
	Password  string  `json:"-"`
	Status    string  `json:"status"`
	Type      string  `json:"type"`
	HostID    *string `json:"hostId"`
	CanHost   *string `json:"canHost"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type Game struct {
	ID             int64   `json:"id"`
	Nome           string  `json:"nome"`
	ManualID       *string `json:"manual_id"`
	URL            string  `json:"url"`
	Imagem         string  `json:"imagem"`
	ImagemRetrato  *string `json:"imagem_retrato"`
	ImagemPaisagem *string `json:"imagem_paisagem"`
	Status         string  `json:"status"`
	CreatedAt      string  `json:"created_at"`
}

type SSEClient struct {
	id       string
	flusher  http.Flusher
	writer   io.Writer
	isClosed bool
	gameID   string
	isHost   bool
	isPriv   bool
	msgChan  chan string
}

// Hub SSE e Pending Requests
type Hub struct {
	mu              sync.RWMutex
	hosters         map[string]*SSEClient
	seeders         map[string]*SSEClient
	pendingRequests map[string]chan map[string]interface{}
	tempPrivHosts   map[string]bool
}

var (
	db       *sql.DB
	hub      = &Hub{
		hosters:         make(map[string]*SSEClient),
		seeders:         make(map[string]*SSEClient),
		pendingRequests: make(map[string]chan map[string]interface{}),
		tempPrivHosts:   make(map[string]bool),
	}
	staticDir string
)

func init() {
	rand.Seed(time.Now().UnixNano())
}

func generateID(length int) string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

func generateCustomID() string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	const digits = "0123456789"

	for {
		p1 := make([]byte, 3)
		for i := range p1 {
			p1[i] = letters[rand.Intn(len(letters))]
		}
		p2 := make([]byte, 4)
		for i := range p2 {
			p2[i] = digits[rand.Intn(len(digits))]
		}
		p3 := make([]byte, 5)
		for i := range p3 {
			p3[i] = digits[rand.Intn(len(digits))]
		}
		candidate := fmt.Sprintf("%s-%s-%s", string(p1), string(p2), string(p3))

		hub.mu.RLock()
		_, hasHost := hub.hosters[candidate]
		_, hasSeeder := hub.seeders[candidate]
		hub.mu.RUnlock()

		if !hasHost && !hasSeeder {
			return candidate
		}
	}
}

func logConnection(tipo, clientID, evento string) {
	if db == nil {
		return
	}
	_, err := db.Exec("INSERT INTO conexoes (tipo, client_id, evento) VALUES (?, ?, ?)", tipo, clientID, evento)
	if err != nil {
		log.Printf("Erro ao gravar conexão no SQLite: %v", err)
	}
}

func calculateElo(ratingA, ratingB float64, actualScoreA float64, kFactor float64) int {
	expectedScoreA := 1.0 / (1.0 + math.Pow(10, (ratingB-ratingA)/400.0))
	newRatingA := math.Round(ratingA + kFactor*(actualScoreA-expectedScoreA))
	if newRatingA < 0 {
		return 0
	}
	return int(newRatingA)
}

func getEloTier(elo int) string {
	if elo >= 1200 {
		return "Mestre"
	}
	if elo >= 900 {
		return "Diamante"
	}
	if elo >= 600 {
		return "Ouro"
	}
	if elo >= 300 {
		return "Prata"
	}
	return "Bronze"
}

func deleteGameZip(gameURL string) {
	if gameURL == "" {
		return
	}
	idx := strings.Index(gameURL, "/payldr/static/")
	if idx == -1 {
		return
	}
	filename := gameURL[idx+len("/payldr/static/"):]
	if q := strings.IndexAny(filename, "?#"); q != -1 {
		filename = filename[:q]
	}
	filePath := filepath.Join(staticDir, filename)
	if _, err := os.Stat(filePath); err == nil {
		if removeErr := os.Remove(filePath); removeErr == nil {
			log.Printf("[File Cleanup] Deletado ZIP antigo: %s", filePath)
		} else {
			log.Printf("[File Cleanup] Erro ao deletar arquivo: %s (%v)", filePath, removeErr)
		}
	}
}

// Inicialização do Banco de Dados SQLite
func initDatabase() error {
	var err error
	db, err = sql.Open("sqlite", "./payldr.db")
	if err != nil {
		return err
	}

	// WAL mode
	if _, err := db.Exec("PRAGMA journal_mode = WAL;"); err != nil {
		log.Printf("PRAGMA journal_mode warning: %v", err)
	}

	schema := `
	CREATE TABLE IF NOT EXISTS conexoes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tipo TEXT,
		client_id TEXT,
		evento TEXT,
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS jogos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		nome TEXT NOT NULL UNIQUE,
		url TEXT NOT NULL,
		imagem TEXT NOT NULL,
		imagem_retrato TEXT NULL,
		imagem_paisagem TEXT NULL,
		status TEXT DEFAULT 'active',
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NULL,
		email TEXT NULL UNIQUE,
		username TEXT NULL UNIQUE,
		password TEXT NOT NULL,
		status TEXT DEFAULT 'active',
		type TEXT DEFAULT 'guest',
		hostId TEXT NULL,
		canHost DATETIME NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS rankings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		game_id TEXT NOT NULL,
		elo_rating INTEGER DEFAULT 0,
		wins INTEGER DEFAULT 0,
		losses INTEGER DEFAULT 0,
		favorite_character TEXT DEFAULT '',
		tier TEXT DEFAULT 'Bronze',
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(username, game_id)
	);

	CREATE TABLE IF NOT EXISTS match_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		game_id TEXT NOT NULL,
		host_username TEXT NOT NULL,
		guest_username TEXT NOT NULL,
		winner_username TEXT NOT NULL,
		host_character TEXT DEFAULT '',
		guest_character TEXT DEFAULT '',
		host_score INTEGER DEFAULT 0,
		guest_score INTEGER DEFAULT 0,
		duration_seconds INTEGER DEFAULT 0,
		elo_change INTEGER DEFAULT 0,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS character_rankings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		game_id TEXT NOT NULL,
		character_name TEXT NOT NULL,
		elo_rating INTEGER DEFAULT 1200,
		wins INTEGER DEFAULT 0,
		losses INTEGER DEFAULT 0,
		tier TEXT DEFAULT 'Bronze',
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(username, game_id, character_name)
	);

	CREATE TABLE IF NOT EXISTS chat_messages (
		id TEXT PRIMARY KEY,
		room TEXT NOT NULL DEFAULT 'global',
		sender TEXT NOT NULL,
		avatar TEXT DEFAULT NULL,
		text TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_chat_room_created ON chat_messages(room, created_at);
	`
	if _, err := db.Exec(schema); err != nil {
		return err
	}

	// Migrações dinâmicas
	alterCols := []struct {
		table string
		col   string
		query string
	}{
		{"users", "username", "ALTER TABLE users ADD COLUMN username TEXT UNIQUE NULL"},
		{"users", "type", "ALTER TABLE users ADD COLUMN type TEXT DEFAULT 'guest'"},
		{"users", "hostId", "ALTER TABLE users ADD COLUMN hostId TEXT"},
		{"users", "canHost", "ALTER TABLE users ADD COLUMN canHost DATETIME"},
		{"jogos", "status", "ALTER TABLE jogos ADD COLUMN status TEXT DEFAULT 'active'"},
		{"jogos", "manual_id", "ALTER TABLE jogos ADD COLUMN manual_id TEXT"},
		{"jogos", "imagem_retrato", "ALTER TABLE jogos ADD COLUMN imagem_retrato TEXT"},
		{"jogos", "imagem_paisagem", "ALTER TABLE jogos ADD COLUMN imagem_paisagem TEXT"},
	}

	for _, ac := range alterCols {
		rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", ac.table))
		if err == nil {
			hasCol := false
			for rows.Next() {
				var cid int
				var name, ctype string
				var notnull, pk int
				var dfltValue interface{}
				_ = rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk)
				if strings.EqualFold(name, ac.col) {
					hasCol = true
					break
				}
			}
			rows.Close()
			if !hasCol {
				_, _ = db.Exec(ac.query)
			}
		}
	}
	_, _ = db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jogos_nome ON jogos(nome)")

	// Seed de usuários se vazio
	var userCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount); err == nil && userCount == 0 {
		defPass, _ := bcrypt.GenerateFromPassword([]byte("payldr123"), 10)
		testPass, _ := bcrypt.GenerateFromPassword([]byte("MySecurePassword123!"), 10)
		futureDate := time.Now().AddDate(1, 0, 0).Format("2006-01-02 15:04:05")

		_, _ = db.Exec("INSERT INTO users (username, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?)",
			"host1", string(defPass), "host", "easynet-room-8827", futureDate)
		_, _ = db.Exec("INSERT INTO users (username, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?)",
			"guest1", string(defPass), "guest", "", nil)
		_, _ = db.Exec("INSERT INTO users (name, email, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?, ?)",
			"Test User", "test_user_1783297086780@example.com", string(testPass), "host", "test-host-id", futureDate)
		log.Println("Usuários padrão semeados com sucesso no SQLite.")
	}

	// Seed de jogos se vazio
	var gameCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM jogos").Scan(&gameCount); err == nil && gameCount == 0 {
		_, _ = db.Exec("INSERT INTO jogos (nome, url, imagem, status) VALUES (?, ?, ?, ?)",
			"Ikemen GO", "https://github.com/ikemen-go/ikemen-go/releases/download/v0.98.2/Ikemen_GO-v0.98.2-win64.zip", "ikemen_base", "active")
		_, _ = db.Exec("INSERT INTO jogos (nome, url, imagem, status) VALUES (?, ?, ?, ?)",
			"Street Fighter", "https://devserver.marketpix.com.br:9710/payldr/static/street_fighter.zip", "street_fighter", "active")
		log.Println("Jogos padrão semeados com sucesso no SQLite.")
	}

	return nil
}

// Middleware de Autenticação Básica (Admin)
func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authUser := os.Getenv("ADMIN_USER")
		if authUser == "" {
			authUser = "admin"
		}
		authPass := os.Getenv("ADMIN_PASS")
		if authPass == "" {
			authPass = "payldr123"
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Basic ") {
			w.Header().Set("WWW-Authenticate", `Basic realm="PayldrGames Admin"`)
			http.Error(w, "Acesso não autorizado.", http.StatusUnauthorized)
			return
		}

		payload, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(authHeader, "Basic "))
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Basic realm="PayldrGames Admin"`)
			http.Error(w, "Credenciais inválidas.", http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(string(payload), ":", 2)
		if len(parts) != 2 || parts[0] != authUser || parts[1] != authPass {
			w.Header().Set("WWW-Authenticate", `Basic realm="PayldrGames Admin"`)
			http.Error(w, "Credenciais inválidas.", http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

// CORS Middleware
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Helper JSON
func jsonResponse(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(data)
}

// Heartbeat SSE Loop
func startHeartbeat() {
	ticker := time.NewTicker(20 * time.Second)
	go func() {
		for range ticker.C {
			hub.mu.Lock()
			for id, c := range hub.hosters {
				select {
				case c.msgChan <- ": ping\n\n":
				default:
					c.isClosed = true
					delete(hub.hosters, id)
					go logConnection("hoster", id, "desconectou_ping")
				}
			}
			for id, c := range hub.seeders {
				select {
				case c.msgChan <- ": ping\n\n":
				default:
					c.isClosed = true
					delete(hub.seeders, id)
					go logConnection("seeder", id, "desconectou_ping")
				}
			}
			hub.mu.Unlock()
		}
	}()
}

// Manipulador SSE de Conexão Hoster
func handleHosterConnection(hostID string, isPrivate bool, w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()

	gameID := r.URL.Query().Get("gameId")

	client := &SSEClient{
		id:      hostID,
		flusher: flusher,
		writer:  w,
		gameID:  gameID,
		isHost:  true,
		isPriv:  isPrivate,
		msgChan: make(chan string, 100),
	}

	hub.mu.Lock()
	if isPrivate {
		hub.tempPrivHosts[hostID] = true
	}
	hub.hosters[hostID] = client
	hub.mu.Unlock()

	log.Printf("Hoster ligado: %s (privado: %v) para o jogo: %s", hostID, isPrivate, gameID)
	logConnection("hoster", hostID, "conectou")

	initMsg, _ := json.Marshal(map[string]string{
		"tipo":     "SISTEMA",
		"mensagem": fmt.Sprintf("Ligado como %s", hostID),
	})
	fmt.Fprintf(w, "data: %s\n\n", initMsg)
	flusher.Flush()

	notify := r.Context().Done()
	go func() {
		<-notify
		hub.mu.Lock()
		if cur, exists := hub.hosters[hostID]; exists && cur == client {
			delete(hub.hosters, hostID)
			log.Printf("Hoster desligado: %s", hostID)
			go logConnection("hoster", hostID, "desconectou")
		}
		hub.mu.Unlock()
		client.isClosed = true
	}()

	for msg := range client.msgChan {
		if client.isClosed {
			break
		}
		_, err := fmt.Fprint(w, msg)
		if err != nil {
			break
		}
		flusher.Flush()
	}
}

// Manipulador SSE de Conexão Seeder
func handleSeederConnection(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	seederID := "seeder-" + generateID(8)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()

	client := &SSEClient{
		id:      seederID,
		flusher: flusher,
		writer:  w,
		msgChan: make(chan string, 100),
	}

	hub.mu.Lock()
	hub.seeders[seederID] = client
	hub.mu.Unlock()

	log.Printf("Seeder ligado (auto-gerado): %s", seederID)
	logConnection("seeder", seederID, "conectou")

	initMsg, _ := json.Marshal(map[string]string{
		"tipo":     "ID_ATRIBUITO",
		"seederId": seederID,
		"mensagem": fmt.Sprintf("Ligado como %s", seederID),
	})
	fmt.Fprintf(w, "data: %s\n\n", initMsg)
	flusher.Flush()

	notify := r.Context().Done()
	go func() {
		<-notify
		hub.mu.Lock()
		if cur, exists := hub.seeders[seederID]; exists && cur == client {
			delete(hub.seeders, seederID)
			log.Printf("Seeder desligado: %s", seederID)
			go logConnection("seeder", seederID, "desconectou")
		}
		hub.mu.Unlock()
		client.isClosed = true
	}()

	for msg := range client.msgChan {
		if client.isClosed {
			break
		}
		_, err := fmt.Fprint(w, msg)
		if err != nil {
			break
		}
		flusher.Flush()
	}
}

// ==========================================
// CHAT & SIGNALING WEBSOCKET IMPLEMENTATION
// ==========================================

type WSClient struct {
	conn        *websocket.Conn
	mu          sync.Mutex
	currentRoom string
	username    string
	avatar      *string
	hostID      string
	guestID     string
	isAlive     bool
}

func (c *WSClient) safeSendJSON(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

type ActiveHoster struct {
	client    *WSClient
	gameID    string
	username  string
	isPrivate bool
}

type ActiveGuest struct {
	client       *WSClient
	targetHostID string
}

type PendingOffer struct {
	guestID   string
	hostID    string
	timestamp int64
}

type ChatSignalManager struct {
	mu            sync.RWMutex
	rooms         map[string]map[*WSClient]bool
	activeHosters map[string]*ActiveHoster
	activeGuests  map[string]*ActiveGuest
	pendingOffers map[string]*PendingOffer
	allClients    map[*WSClient]bool
}

var (
	wsUpgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	chatSignalMgr = &ChatSignalManager{
		rooms:         make(map[string]map[*WSClient]bool),
		activeHosters: make(map[string]*ActiveHoster),
		activeGuests:  make(map[string]*ActiveGuest),
		pendingOffers: make(map[string]*PendingOffer),
		allClients:    make(map[*WSClient]bool),
	}
)

func (m *ChatSignalManager) joinRoom(client *WSClient, room string) {
	m.leaveCurrentRoom(client)
	m.mu.Lock()
	client.currentRoom = room
	if m.rooms[room] == nil {
		m.rooms[room] = make(map[*WSClient]bool)
	}
	m.rooms[room][client] = true
	m.mu.Unlock()

	m.broadcastPresence(room)
}

func (m *ChatSignalManager) leaveCurrentRoom(client *WSClient) {
	m.mu.Lock()
	oldRoom := client.currentRoom
	if oldRoom != "" && m.rooms[oldRoom] != nil {
		delete(m.rooms[oldRoom], client)
		if len(m.rooms[oldRoom]) == 0 {
			delete(m.rooms, oldRoom)
		}
	}
	client.currentRoom = ""
	m.mu.Unlock()

	if oldRoom != "" {
		m.broadcastPresence(oldRoom)
	}
}

func (m *ChatSignalManager) broadcastToRoom(room string, payload interface{}) {
	m.mu.RLock()
	clientsMap, ok := m.rooms[room]
	if !ok || len(clientsMap) == 0 {
		m.mu.RUnlock()
		return
	}
	clients := make([]*WSClient, 0, len(clientsMap))
	for c := range clientsMap {
		clients = append(clients, c)
	}
	m.mu.RUnlock()

	for _, c := range clients {
		_ = c.safeSendJSON(payload)
	}
}

func (m *ChatSignalManager) broadcastPresence(room string) {
	m.mu.RLock()
	clientsMap, ok := m.rooms[room]
	if !ok {
		m.mu.RUnlock()
		return
	}
	count := len(clientsMap)
	usersMap := make(map[string]bool)
	for c := range clientsMap {
		if c.username != "" {
			usersMap[c.username] = true
		}
	}
	users := make([]string, 0, len(usersMap))
	for u := range usersMap {
		users = append(users, u)
	}
	clients := make([]*WSClient, 0, count)
	for c := range clientsMap {
		clients = append(clients, c)
	}
	m.mu.RUnlock()

	payload := map[string]interface{}{
		"event":       "presence_update",
		"room":        room,
		"onlineCount": count,
		"users":       users,
	}

	for _, c := range clients {
		_ = c.safeSendJSON(payload)
	}
}

func (m *ChatSignalManager) getActiveHostersMap() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	res := make(map[string]string)
	for id, h := range m.activeHosters {
		if !h.isPrivate {
			res[id] = h.gameID
		}
	}
	return res
}

func (m *ChatSignalManager) sendHostersList(client *WSClient) {
	_ = client.safeSendJSON(map[string]interface{}{
		"event":   "hosters_updated",
		"hosters": m.getActiveHostersMap(),
	})
}

func (m *ChatSignalManager) broadcastHostersUpdate() {
	m.mu.RLock()
	clients := make([]*WSClient, 0, len(m.allClients))
	for c := range m.allClients {
		clients = append(clients, c)
	}
	hosters := make(map[string]string)
	for id, h := range m.activeHosters {
		if !h.isPrivate {
			hosters[id] = h.gameID
		}
	}
	m.mu.RUnlock()

	payload := map[string]interface{}{
		"event":   "hosters_updated",
		"hosters": hosters,
	}
	for _, c := range clients {
		_ = c.safeSendJSON(payload)
	}
}

func (m *ChatSignalManager) cleanupClient(client *WSClient) {
	m.leaveCurrentRoom(client)

	m.mu.Lock()
	delete(m.allClients, client)

	hostID := client.hostID
	isHost := hostID != "" && m.activeHosters[hostID] != nil && m.activeHosters[hostID].client == client
	if isHost {
		delete(m.activeHosters, hostID)
		log.Printf("[Signal WS] Host desconectado/fechado: %s. Limpando sala imediatamente.", hostID)
	}

	guestID := client.guestID
	if guestID != "" && m.activeGuests[guestID] != nil && m.activeGuests[guestID].client == client {
		delete(m.activeGuests, guestID)
	}
	m.mu.Unlock()

	if isHost {
		m.broadcastHostersUpdate()
	}
}

func (m *ChatSignalManager) startChatCleanupJob() {
	go func() {
		for {
			time.Sleep(1 * time.Hour)
			res, err := db.Exec("DELETE FROM chat_messages WHERE created_at < datetime('now', '-24 hours')")
			if err == nil {
				if aff, _ := res.RowsAffected(); aff > 0 {
					log.Printf("[Chat Cleanup] %d mensagens expiradas (>24h) foram expurgadas.", aff)
				}
			}
		}
	}()
}

func (m *ChatSignalManager) startHeartbeatJob() {
	go func() {
		for {
			time.Sleep(30 * time.Second)
			m.mu.RLock()
			clients := make([]*WSClient, 0, len(m.allClients))
			for c := range m.allClients {
				clients = append(clients, c)
			}
			m.mu.RUnlock()

			for _, c := range clients {
				c.mu.Lock()
				if !c.isAlive {
					c.mu.Unlock()
					m.cleanupClient(c)
					_ = c.conn.Close()
					continue
				}
				c.isAlive = false
				_ = c.conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(5*time.Second))
				c.mu.Unlock()
			}
		}
	}()
}

func fetchRoomHistory(room string) []map[string]interface{} {
	rows, err := db.Query(`
		SELECT id, room, sender, avatar, text, CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS timestamp
		FROM chat_messages
		WHERE room = ? AND created_at >= datetime('now', '-24 hours')
		ORDER BY created_at ASC
		LIMIT 100
	`, room)
	if err != nil {
		return []map[string]interface{}{}
	}
	defer rows.Close()

	var history []map[string]interface{}
	for rows.Next() {
		var id, r, sender, text string
		var avatar sql.NullString
		var ts int64
		_ = rows.Scan(&id, &r, &sender, &avatar, &text, &ts)
		var av interface{}
		if avatar.Valid {
			av = avatar.String
		}
		history = append(history, map[string]interface{}{
			"id":        id,
			"room":      r,
			"sender":    sender,
			"avatar":    av,
			"text":      text,
			"timestamp": ts,
		})
	}
	if history == nil {
		history = []map[string]interface{}{}
	}
	return history
}

func handleWsMessage(client *WSClient, raw []byte) {
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		_ = client.safeSendJSON(map[string]interface{}{
			"event":   "error",
			"message": "Payload JSON inválido.",
		})
		return
	}

	action, _ := data["action"].(string)
	if action == "" {
		action, _ = data["event"].(string)
	}

	switch action {
	case "auth", "join_room":
		newRoom, _ := data["room"].(string)
		if newRoom == "" {
			newRoom = "global"
		}
		newRoom = strings.TrimSpace(newRoom)

		if u, ok := data["username"].(string); ok && u != "" {
			if len(u) > 50 {
				u = u[:50]
			}
			client.username = strings.TrimSpace(u)
		}
		if av, ok := data["avatar"].(string); ok && av != "" {
			if len(av) > 255 {
				av = av[:255]
			}
			avStr := strings.TrimSpace(av)
			client.avatar = &avStr
		}

		chatSignalMgr.joinRoom(client, newRoom)

		history := fetchRoomHistory(newRoom)
		_ = client.safeSendJSON(map[string]interface{}{
			"event":    "room_joined",
			"room":     newRoom,
			"username": client.username,
			"history":  history,
		})

	case "send_message":
		room, _ := data["room"].(string)
		if room == "" {
			room = client.currentRoom
		}
		if room == "" {
			room = "global"
		}
		room = strings.TrimSpace(room)

		sender, _ := data["sender"].(string)
		if sender == "" {
			sender = client.username
		}
		if sender == "" {
			sender = "Anônimo"
		}
		sender = strings.TrimSpace(sender)
		if len(sender) > 50 {
			sender = sender[:50]
		}

		var avatar *string
		if av, ok := data["avatar"].(string); ok && av != "" {
			avStr := strings.TrimSpace(av)
			if len(avStr) > 255 {
				avStr = avStr[:255]
			}
			avatar = &avStr
		} else {
			avatar = client.avatar
		}

		text, _ := data["text"].(string)
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		if len(text) > 280 {
			text = text[:280]
		}

		msgID := fmt.Sprintf("msg-%d-%s", time.Now().UnixMilli(), generateID(6))
		ts := time.Now().UnixMilli()

		_, err := db.Exec("INSERT INTO chat_messages (id, room, sender, avatar, text) VALUES (?, ?, ?, ?, ?)",
			msgID, room, sender, avatar, text)
		if err != nil {
			log.Printf("[Chat WS] Erro ao salvar mensagem no SQLite: %v", err)
		}

		var avVal interface{}
		if avatar != nil {
			avVal = *avatar
		}
		broadcastPayload := map[string]interface{}{
			"event": "new_message",
			"room":  room,
			"message": map[string]interface{}{
				"id":        msgID,
				"room":      room,
				"sender":    sender,
				"avatar":    avVal,
				"text":      text,
				"timestamp": ts,
			},
		}
		chatSignalMgr.broadcastToRoom(room, broadcastPayload)

	case "register_host":
		hostID, _ := data["hostId"].(string)
		hostID = strings.TrimSpace(hostID)
		gameID, _ := data["gameId"].(string)
		gameID = strings.TrimSpace(gameID)
		username, _ := data["username"].(string)
		if username == "" {
			username = client.username
		}
		if username == "" {
			username = "Host"
		}
		username = strings.TrimSpace(username)
		isPrivate, _ := data["isPrivate"].(bool)

		if hostID == "" {
			_ = client.safeSendJSON(map[string]interface{}{
				"event":   "signal_error",
				"message": "hostId obrigatório.",
			})
			return
		}

		client.hostID = hostID
		chatSignalMgr.mu.Lock()
		chatSignalMgr.activeHosters[hostID] = &ActiveHoster{
			client:    client,
			gameID:    gameID,
			username:  username,
			isPrivate: isPrivate,
		}
		chatSignalMgr.mu.Unlock()

		log.Printf("[Signal WS] Host registrado: %s (jogo: %s, user: %s)", hostID, gameID, username)
		_ = client.safeSendJSON(map[string]interface{}{
			"event":  "host_registered",
			"hostId": hostID,
			"gameId": gameID,
		})
		chatSignalMgr.broadcastHostersUpdate()

	case "unregister_host":
		hostID, _ := data["hostId"].(string)
		if hostID == "" {
			hostID = client.hostID
		}
		hostID = strings.TrimSpace(hostID)
		if hostID != "" {
			chatSignalMgr.mu.Lock()
			if chatSignalMgr.activeHosters[hostID] != nil {
				delete(chatSignalMgr.activeHosters, hostID)
				log.Printf("[Signal WS] Host cancelado/removido: %s", hostID)
			}
			chatSignalMgr.mu.Unlock()

			_ = client.safeSendJSON(map[string]interface{}{
				"event":  "host_unregistered",
				"hostId": hostID,
			})
			chatSignalMgr.broadcastHostersUpdate()
		}

	case "send_offer":
		targetHostID, _ := data["targetHostId"].(string)
		if targetHostID == "" {
			targetHostID, _ = data["hostId"].(string)
		}
		targetHostID = strings.TrimSpace(targetHostID)

		guestID, _ := data["guestId"].(string)
		guestID = strings.TrimSpace(guestID)

		payload := data["payload"]
		if payload == nil {
			payload = data["sdp"]
		}
		if payload == nil {
			payload = data["dados"]
		}

		reqID, _ := data["requestId"].(string)
		if reqID == "" {
			reqID = fmt.Sprintf("req-%d-%s", time.Now().UnixMilli(), generateID(5))
		}

		if targetHostID == "" || guestID == "" || payload == nil {
			_ = client.safeSendJSON(map[string]interface{}{
				"event":   "signal_error",
				"message": "targetHostId, guestId e payload são obrigatórios.",
			})
			return
		}

		client.guestID = guestID
		chatSignalMgr.mu.Lock()
		chatSignalMgr.activeGuests[guestID] = &ActiveGuest{
			client:       client,
			targetHostID: targetHostID,
		}

		targetHost := chatSignalMgr.activeHosters[targetHostID]
		if targetHost == nil {
			chatSignalMgr.mu.Unlock()
			_ = client.safeSendJSON(map[string]interface{}{
				"event":     "offer_failed",
				"requestId": reqID,
				"message":   fmt.Sprintf("Host %s está offline ou indisponível.", targetHostID),
			})
			return
		}

		chatSignalMgr.pendingOffers[reqID] = &PendingOffer{
			guestID:   guestID,
			hostID:    targetHostID,
			timestamp: time.Now().UnixMilli(),
		}
		chatSignalMgr.mu.Unlock()

		_ = targetHost.client.safeSendJSON(map[string]interface{}{
			"event":     "incoming_offer",
			"requestId": reqID,
			"guestId":   guestID,
			"dados":     payload,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		})
		log.Printf("[Signal WS] Oferta WebRTC de '%s' enviada para o Host '%s' (reqID: %s)", guestID, targetHostID, reqID)

	case "send_answer":
		targetGuestID, _ := data["targetGuestId"].(string)
		if targetGuestID == "" {
			targetGuestID, _ = data["guestId"].(string)
		}
		targetGuestID = strings.TrimSpace(targetGuestID)

		reqID, _ := data["requestId"].(string)
		reqID = strings.TrimSpace(reqID)

		payload := data["payload"]
		if payload == nil {
			payload = data["sdp"]
		}
		if payload == nil {
			payload = data["dados"]
		}

		if targetGuestID == "" || payload == nil {
			_ = client.safeSendJSON(map[string]interface{}{
				"event":   "signal_error",
				"message": "targetGuestId e payload são obrigatórios.",
			})
			return
		}

		chatSignalMgr.mu.Lock()
		targetGuest := chatSignalMgr.activeGuests[targetGuestID]
		delete(chatSignalMgr.pendingOffers, reqID)
		chatSignalMgr.mu.Unlock()

		if targetGuest == nil {
			log.Printf("[Signal WS] Falha ao entregar resposta: Guest '%s' offline.", targetGuestID)
			return
		}

		_ = targetGuest.client.safeSendJSON(map[string]interface{}{
			"event":     "offer_answered",
			"requestId": reqID,
			"origem":    "hoster",
			"dados":     payload,
		})
		log.Printf("[Signal WS] Resposta SDP do Host enviada com sucesso para '%s'", targetGuestID)

	case "get_hosters":
		chatSignalMgr.sendHostersList(client)

	case "ping":
		_ = client.safeSendJSON(map[string]interface{}{
			"event": "pong",
			"time":  time.Now().UnixMilli(),
		})
	}
}

func handleWebSocketConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS Upgrade Error] %v", err)
		return
	}

	client := &WSClient{
		conn:        conn,
		currentRoom: "global",
		username:    "Anônimo",
		isAlive:     true,
	}

	chatSignalMgr.mu.Lock()
	chatSignalMgr.allClients[client] = true
	chatSignalMgr.mu.Unlock()

	chatSignalMgr.joinRoom(client, "global")
	chatSignalMgr.sendHostersList(client)

	conn.SetPongHandler(func(string) error {
		client.mu.Lock()
		client.isAlive = true
		client.mu.Unlock()
		return nil
	})

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		client.mu.Lock()
		client.isAlive = true
		client.mu.Unlock()
		handleWsMessage(client, msg)
	}

	chatSignalMgr.cleanupClient(client)
	_ = conn.Close()
}


func main() {
	_ = godotenv.Load("payldr.env")

	port := os.Getenv("API_PORT")
	if port == "" {
		port = "9610"
	}
	environment := strings.ToUpper(os.Getenv("ENVIRONMENT"))
	if environment == "" {
		environment = "LOCAL"
	}

	curDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("Erro ao obter diretório atual: %v", err)
	}
	staticDir = filepath.Join(curDir, "static")
	_ = os.MkdirAll(staticDir, 0755)

	if err := initDatabase(); err != nil {
		log.Fatalf("Erro ao inicializar banco SQLite: %v", err)
	}
	log.Println("Banco de dados SQLite inicializado com sucesso.")

	startHeartbeat()
	chatSignalMgr.startChatCleanupJob()
	chatSignalMgr.startHeartbeatJob()

	mux := http.NewServeMux()

	// WebSockets (Chat & P2P Signaling)
	wsHandler := func(w http.ResponseWriter, r *http.Request) {
		handleWebSocketConnection(w, r)
	}
	mux.HandleFunc("/ws/chat", wsHandler)
	mux.HandleFunc("/payldr/ws/chat", wsHandler)
	mux.HandleFunc("/payldr/ws/signal", wsHandler)
	mux.HandleFunc("/ws/signal", wsHandler)

	// Chat REST Routes
	mux.HandleFunc("/payldr/chat/history", func(w http.ResponseWriter, r *http.Request) {
		room := r.URL.Query().Get("room")
		if room == "" {
			room = "global"
		}
		history := fetchRoomHistory(room)
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"success":  true,
			"messages": history,
		})
	})

	mux.HandleFunc("/payldr/chat/send", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Room   string  `json:"room"`
			Sender string  `json:"sender"`
			Avatar *string `json:"avatar"`
			Text   string  `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Sender) == "" || strings.TrimSpace(body.Text) == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{
				"success": false,
				"message": "Remetente e texto são obrigatórios.",
			})
			return
		}

		room := strings.TrimSpace(body.Room)
		if room == "" {
			room = "global"
		}
		sender := strings.TrimSpace(body.Sender)
		if len(sender) > 50 {
			sender = sender[:50]
		}
		text := strings.TrimSpace(body.Text)
		if len(text) > 280 {
			text = text[:280]
		}
		msgID := fmt.Sprintf("msg-%d-%s", time.Now().UnixMilli(), generateID(6))
		ts := time.Now().UnixMilli()

		_, err := db.Exec("INSERT INTO chat_messages (id, room, sender, avatar, text) VALUES (?, ?, ?, ?, ?)",
			msgID, room, sender, body.Avatar, text)
		if err != nil {
			log.Printf("[Chat REST] Erro ao salvar mensagem no SQLite: %v", err)
			jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{
				"success": false,
				"error":   err.Error(),
			})
			return
		}

		var avVal interface{}
		if body.Avatar != nil {
			avVal = *body.Avatar
		}
		msgObj := map[string]interface{}{
			"id":        msgID,
			"room":      room,
			"sender":    sender,
			"avatar":    avVal,
			"text":      text,
			"timestamp": ts,
		}

		chatSignalMgr.broadcastToRoom(room, map[string]interface{}{
			"event":   "new_message",
			"room":    room,
			"message": msgObj,
		})

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"message": msgObj,
		})
	})

	// Static files
	fs := http.StripPrefix("/payldr/static/", http.FileServer(http.Dir(staticDir)))
	mux.Handle("/payldr/static/", fs)

	// Status
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"service": "api",
			"status":  "on",
			"time":    time.Now().UnixMilli(),
		})
	})

	// SSE Hosters & Seeders
	mux.HandleFunc("/payldr/hoster/private/", func(w http.ResponseWriter, r *http.Request) {
		hostID := strings.TrimPrefix(r.URL.Path, "/payldr/hoster/private/")
		if hostID == "" {
			http.Error(w, "Host ID required", http.StatusBadRequest)
			return
		}
		handleHosterConnection(hostID, true, w, r)
	})

	mux.HandleFunc("/payldr/hoster/", func(w http.ResponseWriter, r *http.Request) {
		hostID := strings.TrimPrefix(r.URL.Path, "/payldr/hoster/")
		if hostID == "" {
			http.Error(w, "Host ID required", http.StatusBadRequest)
			return
		}
		handleHosterConnection(hostID, false, w, r)
	})

	mux.HandleFunc("/payldr/seeder", func(w http.ResponseWriter, r *http.Request) {
		handleSeederConnection(w, r)
	})

	mux.HandleFunc("/payldr/seeders", func(w http.ResponseWriter, r *http.Request) {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		keys := make([]string, 0, len(hub.seeders))
		for k := range hub.seeders {
			keys = append(keys, k)
		}
		jsonResponse(w, http.StatusOK, keys)
	})

	mux.HandleFunc("/payldr/hosters", func(w http.ResponseWriter, r *http.Request) {
		res := chatSignalMgr.getActiveHostersMap()

		hub.mu.RLock()
		for id, h := range hub.hosters {
			if !h.isPriv {
				res[id] = h.gameID
			}
		}
		hub.mu.RUnlock()

		jsonResponse(w, http.StatusOK, res)
	})

	mux.HandleFunc("/payldr/hoster-game/", func(w http.ResponseWriter, r *http.Request) {
		hostID := strings.TrimPrefix(r.URL.Path, "/payldr/hoster-game/")
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		if h, ok := hub.hosters[hostID]; ok {
			jsonResponse(w, http.StatusOK, map[string]string{"gameId": h.gameID})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]string{"gameId": ""})
	})

	mux.HandleFunc("/payldr/host/private/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hostID := strings.TrimPrefix(r.URL.Path, "/payldr/host/private/")
		hub.mu.Lock()
		hub.tempPrivHosts[hostID] = true
		hub.mu.Unlock()
		log.Printf("Host marcado como privado temporariamente: %s", hostID)
		jsonResponse(w, http.StatusOK, map[string]bool{"sucesso": true})
	})

	mux.HandleFunc("/payldr/generate-id", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]string{"id": generateCustomID()})
	})

	// Guest Send & Reply
	mux.HandleFunc("/payldr/guest/send", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var body struct {
			GuestID string      `json:"guestId"`
			HostID  string      `json:"hostId"`
			Payload interface{} `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.GuestID == "" || body.HostID == "" || body.Payload == nil {
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "Campos incompletos."})
			return
		}

		hub.mu.RLock()
		targetClient, hasHost := hub.hosters[body.HostID]
		if !hasHost {
			targetClient, hasHost = hub.seeders[body.HostID]
		}
		hub.mu.RUnlock()

		if !hasHost || targetClient == nil {
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "Hoster/Seeder offline ou não encontrado."})
			return
		}

		reqID := generateID(10)
		replyChan := make(chan map[string]interface{}, 1)

		hub.mu.Lock()
		hub.pendingRequests[reqID] = replyChan
		hub.mu.Unlock()

		defer func() {
			hub.mu.Lock()
			delete(hub.pendingRequests, reqID)
			hub.mu.Unlock()
		}()

		eventMap := map[string]interface{}{
			"requestId": reqID,
			"origem":    body.GuestID,
			"dados":     body.Payload,
			"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		}
		eventJSON, _ := json.Marshal(eventMap)

		select {
		case targetClient.msgChan <- fmt.Sprintf("data: %s\n\n", eventJSON):
		default:
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "Falha ao enviar para hoster/seeder."})
			return
		}

		select {
		case respData := <-replyChan:
			jsonResponse(w, http.StatusOK, map[string]interface{}{
				"sucesso": true,
				"origem":  "hoster",
				"dados":   respData,
			})
		case <-time.After(30 * time.Second):
			w.WriteHeader(http.StatusGatewayTimeout)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"sucesso":  false,
				"mensagem": "Timeout: O hoster/seeder não respondeu.",
			})
		case <-r.Context().Done():
			log.Printf("[Server] Conexão do guest para requestId %s interrompida", reqID)
		}
	})

	mux.HandleFunc("/payldr/reply", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			RequestID    string                 `json:"requestId"`
			ResponseData map[string]interface{} `json:"responseData"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "Dados inválidos."})
			return
		}

		hub.mu.RLock()
		replyChan, exists := hub.pendingRequests[body.RequestID]
		hub.mu.RUnlock()

		if !exists {
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "A requisição expirou, foi cancelada ou não existe."})
			return
		}

		select {
		case replyChan <- body.ResponseData:
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true, "mensagem": "Entregue."})
		default:
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": false, "mensagem": "Canal cheio ou já respondido."})
		}
	})

	// Login & Register
	mux.HandleFunc("/payldr/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Password == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"success": false, "mensagem": "Usuário e senha são obrigatórios."})
			return
		}

		var u User
		err := db.QueryRow("SELECT id, username, password, type, hostId, canHost FROM users WHERE username = ? OR email = ?", body.Username, body.Username).
			Scan(&u.ID, &u.Username, &u.Password, &u.Type, &u.HostID, &u.CanHost)
		if err != nil {
			jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "mensagem": "Credenciais inválidas."})
			return
		}

		if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(body.Password)); err != nil {
			jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{"success": false, "mensagem": "Credenciais inválidas."})
			return
		}

		finalType := "guest"
		if u.CanHost != nil && *u.CanHost != "" {
			layout := "2006-01-02 15:04:05"
			canHostDate, err := time.Parse(layout, *u.CanHost)
			if err != nil {
				canHostDate, _ = time.Parse(time.RFC3339, *u.CanHost)
			}
			if !canHostDate.IsZero() && canHostDate.After(time.Now()) {
				finalType = "host"
			}
		}

		hostIDVal := ""
		if u.HostID != nil {
			hostIDVal = *u.HostID
		}
		canHostVal := ""
		if u.CanHost != nil {
			canHostVal = *u.CanHost
		}

		usernameVal := ""
		if u.Username != nil {
			usernameVal = *u.Username
		}

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"profile": map[string]interface{}{
				"username": usernameVal,
				"type":     finalType,
				"hostId":   hostIDVal,
				"canHost":  canHostVal,
			},
		})
	})

	mux.HandleFunc("/payldr/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Username string `json:"username"`
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Email == "" || body.Password == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Usuário, e-mail e senha são obrigatórios."})
			return
		}

		var existingID int64
		err := db.QueryRow("SELECT id FROM users WHERE username = ? OR email = ?", body.Username, body.Email).Scan(&existingID)
		if err == nil {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Nome de usuário ou e-mail já cadastrado."})
			return
		}

		hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
		_, err = db.Exec("INSERT INTO users (username, email, password, type, hostId, canHost) VALUES (?, ?, ?, 'guest', '', NULL)",
			body.Username, body.Email, string(hash))
		if err != nil {
			jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro interno ao registrar usuário."})
			return
		}

		jsonResponse(w, http.StatusCreated, map[string]interface{}{"sucesso": true, "mensagem": "Usuário registrado com sucesso."})
	})

	// Páginas HTML Administrativas
	mux.HandleFunc("/payldr/games/register", authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "cadastro.html")
	}))

	mux.HandleFunc("/payldr/users", authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "users.html")
	}))

	// API Games
	mux.HandleFunc("/payldr/api/games", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			includeAll := r.URL.Query().Get("all") == "true"
			query := "SELECT id, nome, manual_id, url, imagem, imagem_retrato, imagem_paisagem, status, created_at FROM jogos"
			if !includeAll {
				query += " WHERE status = 'active'"
			}
			query += " ORDER BY created_at DESC"

			rows, err := db.Query(query)
			if err != nil {
				jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao buscar jogos."})
				return
			}
			defer rows.Close()

			var games []Game
			for rows.Next() {
				var g Game
				_ = rows.Scan(&g.ID, &g.Nome, &g.ManualID, &g.URL, &g.Imagem, &g.ImagemRetrato, &g.ImagemPaisagem, &g.Status, &g.CreatedAt)
				games = append(games, g)
			}
			if games == nil {
				games = []Game{}
			}
			jsonResponse(w, http.StatusOK, games)
			return
		}

		if r.Method == http.MethodPost {
			var nome, manualID, gameURL, status string

			contentType := r.Header.Get("Content-Type")
			if strings.HasPrefix(contentType, "multipart/form-data") {
				err := r.ParseMultipartForm(2048 << 20) // 2GB
				if err != nil {
					jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": fmt.Sprintf("Erro de upload: %v", err)})
					return
				}
				nome = r.FormValue("nome")
				manualID = strings.TrimSpace(r.FormValue("manual_id"))
				gameURL = r.FormValue("url")
				status = r.FormValue("status")

				file, header, fileErr := r.FormFile("zipFile")
				if fileErr == nil && file != nil {
					defer file.Close()
					ext := filepath.Ext(header.Filename)
					fileName := fmt.Sprintf("game-%d-%d%s", time.Now().UnixNano(), rand.Intn(1e9), ext)
					targetPath := filepath.Join(staticDir, fileName)

					out, err := os.Create(targetPath)
					if err == nil {
						defer out.Close()
						_, _ = io.Copy(out, file)
						scheme := "http"
						if r.TLS != nil {
							scheme = "https"
						}
						gameURL = fmt.Sprintf("%s://%s/payldr/static/%s", scheme, r.Host, fileName)
					}
				}
			} else {
				var body struct {
					Nome     string `json:"nome"`
					ManualID string `json:"manual_id"`
					URL      string `json:"url"`
					Status   string `json:"status"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				nome = body.Nome
				manualID = strings.TrimSpace(body.ManualID)
				gameURL = body.URL
				status = body.Status
			}

			if status == "" {
				status = "active"
			}

			if nome == "" || gameURL == "" {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Nome e URL/Arquivo ZIP são obrigatórios."})
				return
			}

			var existsID int64
			if err := db.QueryRow("SELECT id FROM jogos WHERE nome = ?", nome).Scan(&existsID); err == nil {
				deleteGameZip(gameURL)
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Já existe um jogo cadastrado com este nome."})
				return
			}

			res, err := db.Exec("INSERT INTO jogos (nome, manual_id, url, imagem, imagem_retrato, imagem_paisagem, status) VALUES (?, ?, ?, '', '', '', ?)",
				nome, manualID, gameURL, status)
			if err != nil {
				deleteGameZip(gameURL)
				jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao cadastrar jogo no banco."})
				return
			}

			id, _ := res.LastInsertId()
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true, "id": id})
			return
		}

		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	})

	// Atualizar e Deletar Jogo por ID
	mux.HandleFunc("/payldr/api/games/", func(w http.ResponseWriter, r *http.Request) {
		idStr := strings.TrimPrefix(r.URL.Path, "/payldr/api/games/")
		if idStr == "" {
			http.Error(w, "ID missing", http.StatusBadRequest)
			return
		}

		if r.Method == http.MethodDelete {
			var oldURL string
			err := db.QueryRow("SELECT url FROM jogos WHERE id = ?", idStr).Scan(&oldURL)
			if err != nil {
				jsonResponse(w, http.StatusNotFound, map[string]interface{}{"sucesso": false, "mensagem": "Jogo não encontrado."})
				return
			}
			deleteGameZip(oldURL)
			_, _ = db.Exec("DELETE FROM jogos WHERE id = ?", idStr)
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true})
			return
		}

		if r.Method == http.MethodPut {
			var oldURL string
			err := db.QueryRow("SELECT url FROM jogos WHERE id = ?", idStr).Scan(&oldURL)
			if err != nil {
				jsonResponse(w, http.StatusNotFound, map[string]interface{}{"sucesso": false, "mensagem": "Jogo não encontrado."})
				return
			}

			var nome, manualID, gameURL, status string
			contentType := r.Header.Get("Content-Type")

			if strings.HasPrefix(contentType, "multipart/form-data") {
				_ = r.ParseMultipartForm(2048 << 20)
				nome = r.FormValue("nome")
				manualID = strings.TrimSpace(r.FormValue("manual_id"))
				gameURL = r.FormValue("url")
				status = r.FormValue("status")

				file, header, fileErr := r.FormFile("zipFile")
				if fileErr == nil && file != nil {
					defer file.Close()
					ext := filepath.Ext(header.Filename)
					fileName := fmt.Sprintf("game-%d-%d%s", time.Now().UnixNano(), rand.Intn(1e9), ext)
					targetPath := filepath.Join(staticDir, fileName)

					out, err := os.Create(targetPath)
					if err == nil {
						defer out.Close()
						_, _ = io.Copy(out, file)
						scheme := "http"
						if r.TLS != nil {
							scheme = "https"
						}
						gameURL = fmt.Sprintf("%s://%s/payldr/static/%s", scheme, r.Host, fileName)
						deleteGameZip(oldURL)
					}
				} else if gameURL != "" && oldURL != gameURL {
					deleteGameZip(oldURL)
				}
			} else {
				var body struct {
					Nome     string `json:"nome"`
					ManualID string `json:"manual_id"`
					URL      string `json:"url"`
					Status   string `json:"status"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				nome = body.Nome
				manualID = strings.TrimSpace(body.ManualID)
				gameURL = body.URL
				status = body.Status
				if gameURL != "" && oldURL != gameURL {
					deleteGameZip(oldURL)
				}
			}

			if gameURL == "" {
				gameURL = oldURL
			}
			if status == "" {
				status = "active"
			}

			var conflictID int64
			err = db.QueryRow("SELECT id FROM jogos WHERE nome = ? AND id != ?", nome, idStr).Scan(&conflictID)
			if err == nil {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Já existe outro jogo cadastrado com este nome."})
				return
			}

			_, err = db.Exec("UPDATE jogos SET nome = ?, manual_id = ?, url = ?, status = ? WHERE id = ?",
				nome, manualID, gameURL, status, idStr)
			if err != nil {
				jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao atualizar jogo no banco."})
				return
			}

			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true})
			return
		}

		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	})

	// Legacy Cadastro de Jogos
	mux.HandleFunc("/payldr/jogos/cadastro", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Nome           string `json:"nome"`
			URL            string `json:"url"`
			Imagem         string `json:"imagem"`
			ImagemRetrato  string `json:"imagem_retrato"`
			ImagemPaisagem string `json:"imagem_paisagem"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Nome == "" || body.URL == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Preencha os campos obrigatórios."})
			return
		}

		finalRetrato := body.ImagemRetrato
		if finalRetrato == "" {
			finalRetrato = body.Imagem
		}
		finalPaisagem := body.ImagemPaisagem
		if finalPaisagem == "" {
			finalPaisagem = body.Imagem
		}
		mainImagem := finalRetrato
		if mainImagem == "" {
			mainImagem = finalPaisagem
		}
		if mainImagem == "" {
			mainImagem = body.Imagem
		}

		res, err := db.Exec("INSERT INTO jogos (nome, url, imagem, imagem_retrato, imagem_paisagem) VALUES (?, ?, ?, ?, ?)",
			body.Nome, body.URL, mainImagem, finalRetrato, finalPaisagem)
		if err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Já existe um jogo cadastrado com este nome ou erro no banco."})
			return
		}
		lastID, _ := res.LastInsertId()
		jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true, "id": lastID})
	})

	// API Users (Admin)
	mux.HandleFunc("/payldr/api/users", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			rows, err := db.Query("SELECT id, name, email, username, status, type, hostId, canHost, created_at, updated_at FROM users ORDER BY created_at DESC")
			if err != nil {
				jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao buscar usuários."})
				return
			}
			defer rows.Close()

			var users []User
			for rows.Next() {
				var u User
				_ = rows.Scan(&u.ID, &u.Name, &u.Email, &u.Username, &u.Status, &u.Type, &u.HostID, &u.CanHost, &u.CreatedAt, &u.UpdatedAt)
				users = append(users, u)
			}
			if users == nil {
				users = []User{}
			}
			jsonResponse(w, http.StatusOK, users)
			return
		}

		if r.Method == http.MethodPost {
			var body struct {
				Username string  `json:"username"`
				Name     *string `json:"name"`
				Email    *string `json:"email"`
				Password string  `json:"password"`
				Status   string  `json:"status"`
				HostID   *string `json:"hostId"`
				CanHost  *string `json:"canHost"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.Password == "" {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Username e senha são obrigatórios."})
				return
			}

			if body.Status == "" {
				body.Status = "active"
			}

			hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
			res, err := db.Exec(`INSERT INTO users (username, name, email, password, type, status, hostId, canHost) 
				VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)`,
				body.Username, body.Name, body.Email, string(hash), body.Status, body.HostID, body.CanHost)
			if err != nil {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Nome de usuário ou e-mail já cadastrado."})
				return
			}
			lastID, _ := res.LastInsertId()
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true, "id": lastID})
			return
		}

		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	})

	mux.HandleFunc("/payldr/api/users/", func(w http.ResponseWriter, r *http.Request) {
		idStr := strings.TrimPrefix(r.URL.Path, "/payldr/api/users/")
		if idStr == "" {
			http.Error(w, "ID missing", http.StatusBadRequest)
			return
		}

		if r.Method == http.MethodDelete {
			res, err := db.Exec("DELETE FROM users WHERE id = ?", idStr)
			if err != nil {
				jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao deletar usuário."})
				return
			}
			rowsAffected, _ := res.RowsAffected()
			if rowsAffected == 0 {
				jsonResponse(w, http.StatusNotFound, map[string]interface{}{"sucesso": false, "mensagem": "Usuário não encontrado."})
				return
			}
			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true})
			return
		}

		if r.Method == http.MethodPut {
			var body struct {
				Username string  `json:"username"`
				Name     *string `json:"name"`
				Email    *string `json:"email"`
				Password *string `json:"password"`
				Status   string  `json:"status"`
				HostID   *string `json:"hostId"`
				CanHost  *string `json:"canHost"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Username é obrigatório."})
				return
			}
			if body.Status == "" {
				body.Status = "active"
			}

			var err error
			if body.Password != nil && strings.TrimSpace(*body.Password) != "" {
				hash, _ := bcrypt.GenerateFromPassword([]byte(*body.Password), 10)
				_, err = db.Exec(`UPDATE users 
					SET username = ?, name = ?, email = ?, password = ?, status = ?, hostId = ?, canHost = ?, updated_at = CURRENT_TIMESTAMP 
					WHERE id = ?`,
					body.Username, body.Name, body.Email, string(hash), body.Status, body.HostID, body.CanHost, idStr)
			} else {
				_, err = db.Exec(`UPDATE users 
					SET username = ?, name = ?, email = ?, status = ?, hostId = ?, canHost = ?, updated_at = CURRENT_TIMESTAMP 
					WHERE id = ?`,
					body.Username, body.Name, body.Email, body.Status, body.HostID, body.CanHost, idStr)
			}

			if err != nil {
				jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Nome de usuário ou e-mail já cadastrado em outra conta."})
				return
			}

			jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true})
			return
		}

		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	})

	// Match Result & Rankings
	mux.HandleFunc("/payldr/match-result", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			GameID          string `json:"gameId"`
			HostUsername    string `json:"hostUsername"`
			GuestUsername   string `json:"guestUsername"`
			WinnerUsername  string `json:"winnerUsername"`
			HostCharacter   string `json:"hostCharacter"`
			GuestCharacter  string `json:"guestCharacter"`
			HostScore       int    `json:"hostScore"`
			GuestScore      int    `json:"guestScore"`
			DurationSeconds int    `json:"durationSeconds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.GameID == "" || req.HostUsername == "" || req.GuestUsername == "" || req.WinnerUsername == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"sucesso": false, "mensagem": "Parâmetros obrigatórios ausentes."})
			return
		}

		// Ranking do Host
		var hostElo int
		err := db.QueryRow("SELECT elo_rating FROM rankings WHERE username = ? AND game_id = ?", req.HostUsername, req.GameID).Scan(&hostElo)
		if err != nil {
			_, _ = db.Exec("INSERT INTO rankings (username, game_id, elo_rating, wins, losses, favorite_character, tier) VALUES (?, ?, 0, 0, 0, ?, 'Bronze')",
				req.HostUsername, req.GameID, req.HostCharacter)
			hostElo = 0
		}

		// Ranking do Guest
		var guestElo int
		err = db.QueryRow("SELECT elo_rating FROM rankings WHERE username = ? AND game_id = ?", req.GuestUsername, req.GameID).Scan(&guestElo)
		if err != nil {
			_, _ = db.Exec("INSERT INTO rankings (username, game_id, elo_rating, wins, losses, favorite_character, tier) VALUES (?, ?, 0, 0, 0, ?, 'Bronze')",
				req.GuestUsername, req.GameID, req.GuestCharacter)
			guestElo = 0
		}

		isHostWinner := strings.EqualFold(req.WinnerUsername, req.HostUsername)
		actualHostScore := 0.0
		actualGuestScore := 1.0
		if isHostWinner {
			actualHostScore = 1.0
			actualGuestScore = 0.0
		}

		newHostElo := calculateElo(float64(hostElo), float64(guestElo), actualHostScore, 32)
		newGuestElo := calculateElo(float64(guestElo), float64(hostElo), actualGuestScore, 32)
		hostEloChange := newHostElo - hostElo
		guestEloChange := newGuestElo - guestElo
		newHostTier := getEloTier(newHostElo)
		newGuestTier := getEloTier(newGuestElo)

		hostWinAdd := 0
		hostLossAdd := 1
		guestWinAdd := 1
		guestLossAdd := 0
		if isHostWinner {
			hostWinAdd = 1
			hostLossAdd = 0
			guestWinAdd = 0
			guestLossAdd = 1
		}

		_, _ = db.Exec(`UPDATE rankings 
			SET elo_rating = ?, wins = wins + ?, losses = losses + ?, 
			    favorite_character = CASE WHEN ? != '' THEN ? ELSE favorite_character END, 
			    tier = ?, updated_at = CURRENT_TIMESTAMP 
			WHERE username = ? AND game_id = ?`,
			newHostElo, hostWinAdd, hostLossAdd, req.HostCharacter, req.HostCharacter, newHostTier, req.HostUsername, req.GameID)

		_, _ = db.Exec(`UPDATE rankings 
			SET elo_rating = ?, wins = wins + ?, losses = losses + ?, 
			    favorite_character = CASE WHEN ? != '' THEN ? ELSE favorite_character END, 
			    tier = ?, updated_at = CURRENT_TIMESTAMP 
			WHERE username = ? AND game_id = ?`,
			newGuestElo, guestWinAdd, guestLossAdd, req.GuestCharacter, req.GuestCharacter, newGuestTier, req.GuestUsername, req.GameID)

		// Histórico
		_, _ = db.Exec(`INSERT INTO match_history (game_id, host_username, guest_username, winner_username, host_character, guest_character, host_score, guest_score, duration_seconds, elo_change)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			req.GameID, req.HostUsername, req.GuestUsername, req.WinnerUsername, req.HostCharacter, req.GuestCharacter, req.HostScore, req.GuestScore, req.DurationSeconds, hostEloChange)

		// Character Rankings
		if req.HostCharacter != "" {
			var charElo int
			err := db.QueryRow("SELECT elo_rating FROM character_rankings WHERE username = ? AND game_id = ? AND LOWER(character_name) = LOWER(?)", req.HostUsername, req.GameID, req.HostCharacter).Scan(&charElo)
			if err != nil {
				_, _ = db.Exec("INSERT INTO character_rankings (username, game_id, character_name, elo_rating, wins, losses, tier) VALUES (?, ?, ?, 0, 0, 0, 'Bronze')", req.HostUsername, req.GameID, req.HostCharacter)
				charElo = 0
			}
			newCharElo := calculateElo(float64(charElo), float64(hostElo), actualHostScore, 32)
			_, _ = db.Exec(`UPDATE character_rankings SET elo_rating = ?, wins = wins + ?, losses = losses + ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ? AND game_id = ? AND LOWER(character_name) = LOWER(?)`,
				newCharElo, hostWinAdd, hostLossAdd, getEloTier(newCharElo), req.HostUsername, req.GameID, req.HostCharacter)
		}

		if req.GuestCharacter != "" {
			var charElo int
			err := db.QueryRow("SELECT elo_rating FROM character_rankings WHERE username = ? AND game_id = ? AND LOWER(character_name) = LOWER(?)", req.GuestUsername, req.GameID, req.GuestCharacter).Scan(&charElo)
			if err != nil {
				_, _ = db.Exec("INSERT INTO character_rankings (username, game_id, character_name, elo_rating, wins, losses, tier) VALUES (?, ?, ?, 0, 0, 0, 'Bronze')", req.GuestUsername, req.GameID, req.GuestCharacter)
				charElo = 0
			}
			newCharElo := calculateElo(float64(charElo), float64(guestElo), actualGuestScore, 32)
			_, _ = db.Exec(`UPDATE character_rankings SET elo_rating = ?, wins = wins + ?, losses = losses + ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ? AND game_id = ? AND LOWER(character_name) = LOWER(?)`,
				newCharElo, guestWinAdd, guestLossAdd, getEloTier(newCharElo), req.GuestUsername, req.GameID, req.GuestCharacter)
		}

		// Recalcular mains
		var topHostChar string
		if err := db.QueryRow(`SELECT character_name FROM character_rankings WHERE username = ? AND game_id = ? ORDER BY (wins + losses) DESC, elo_rating DESC LIMIT 1`, req.HostUsername, req.GameID).Scan(&topHostChar); err == nil && topHostChar != "" {
			_, _ = db.Exec("UPDATE rankings SET favorite_character = ? WHERE username = ? AND game_id = ?", topHostChar, req.HostUsername, req.GameID)
		}
		var topGuestChar string
		if err := db.QueryRow(`SELECT character_name FROM character_rankings WHERE username = ? AND game_id = ? ORDER BY (wins + losses) DESC, elo_rating DESC LIMIT 1`, req.GuestUsername, req.GameID).Scan(&topGuestChar); err == nil && topGuestChar != "" {
			_, _ = db.Exec("UPDATE rankings SET favorite_character = ? WHERE username = ? AND game_id = ?", topGuestChar, req.GuestUsername, req.GameID)
		}

		log.Printf("[Ranking] Partida registrada no %s: %s (%d ELO) vs %s (%d ELO). Vencedor: %s",
			req.GameID, req.HostUsername, newHostElo, req.GuestUsername, newGuestElo, req.WinnerUsername)

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"sucesso":  true,
			"mensagem": "Resultado da partida registrado com sucesso!",
			"host":     map[string]interface{}{"username": req.HostUsername, "elo": newHostElo, "eloChange": hostEloChange, "tier": newHostTier},
			"guest":    map[string]interface{}{"username": req.GuestUsername, "elo": newGuestElo, "eloChange": guestEloChange, "tier": newGuestTier},
		})
	})

	mux.HandleFunc("/payldr/ranking", func(w http.ResponseWriter, r *http.Request) {
		gameID := r.URL.Query().Get("gameId")
		character := strings.TrimSpace(r.URL.Query().Get("character"))

		type RankRow struct {
			Username          string  `json:"username"`
			GameID            string  `json:"game_id"`
			FavoriteCharacter string  `json:"favorite_character"`
			EloRating         int     `json:"elo_rating"`
			Wins              int     `json:"wins"`
			Losses            int     `json:"losses"`
			Tier              string  `json:"tier"`
			Winrate           float64 `json:"winrate"`
		}

		var query string
		var args []interface{}

		if character != "" {
			query = `SELECT username, game_id, character_name, elo_rating, wins, losses, tier,
					 ROUND((wins * 100.0 / CASE WHEN (wins + losses) = 0 THEN 1 ELSE (wins + losses) END), 1) as winrate
					 FROM character_rankings
					 WHERE LOWER(character_name) = LOWER(?) AND elo_rating > 0`
			args = append(args, character)
			if gameID != "" {
				query += " AND game_id = ?"
				args = append(args, gameID)
			}
		} else {
			query = `SELECT username, game_id, favorite_character, elo_rating, wins, losses, tier,
					 ROUND((wins * 100.0 / CASE WHEN (wins + losses) = 0 THEN 1 ELSE (wins + losses) END), 1) as winrate
					 FROM rankings
					 WHERE elo_rating > 0`
			if gameID != "" {
				query += " AND game_id = ?"
				args = append(args, gameID)
			}
		}
		query += " ORDER BY elo_rating DESC, wins DESC"

		rows, err := db.Query(query, args...)
		if err != nil {
			jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "mensagem": "Erro ao buscar ranking."})
			return
		}
		defer rows.Close()

		var results []RankRow
		for rows.Next() {
			var rr RankRow
			_ = rows.Scan(&rr.Username, &rr.GameID, &rr.FavoriteCharacter, &rr.EloRating, &rr.Wins, &rr.Losses, &rr.Tier, &rr.Winrate)
			results = append(results, rr)
		}
		if results == nil {
			results = []RankRow{}
		}

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"sucesso": true,
			"ranking": results,
		})
	})

	mux.HandleFunc("/payldr/characters", func(w http.ResponseWriter, r *http.Request) {
		gameID := r.URL.Query().Get("gameId")
		query := "SELECT DISTINCT character_name FROM character_rankings WHERE elo_rating > 0"
		var args []interface{}
		if gameID != "" {
			query += " AND game_id = ?"
			args = append(args, gameID)
		}
		query += " ORDER BY character_name ASC"

		rows, err := db.Query(query, args...)
		if err != nil {
			jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"sucesso": false, "characters": []string{}})
			return
		}
		defer rows.Close()

		var chars []string
		for rows.Next() {
			var c string
			_ = rows.Scan(&c)
			chars = append(chars, c)
		}
		if chars == nil {
			chars = []string{}
		}
		jsonResponse(w, http.StatusOK, map[string]interface{}{"sucesso": true, "characters": chars})
	})

	mux.HandleFunc("/payldr/player-stats/", func(w http.ResponseWriter, r *http.Request) {
		username := strings.TrimPrefix(r.URL.Path, "/payldr/player-stats/")
		if username == "" {
			http.Error(w, "Username missing", http.StatusBadRequest)
			return
		}

		type RankEntry struct {
			ID                int64  `json:"id"`
			Username          string `json:"username"`
			GameID            string `json:"game_id"`
			EloRating         int    `json:"elo_rating"`
			Wins              int    `json:"wins"`
			Losses            int    `json:"losses"`
			FavoriteCharacter string `json:"favorite_character"`
			Tier              string `json:"tier"`
			UpdatedAt         string `json:"updated_at"`
		}

		type MatchEntry struct {
			ID              int64  `json:"id"`
			GameID          string `json:"game_id"`
			HostUsername    string `json:"host_username"`
			GuestUsername   string `json:"guest_username"`
			WinnerUsername  string `json:"winner_username"`
			HostCharacter   string `json:"host_character"`
			GuestCharacter  string `json:"guest_character"`
			HostScore       int    `json:"host_score"`
			GuestScore      int    `json:"guest_score"`
			DurationSeconds int    `json:"duration_seconds"`
			EloChange       int    `json:"elo_change"`
			CreatedAt       string `json:"created_at"`
		}

		rRows, err := db.Query("SELECT id, username, game_id, elo_rating, wins, losses, favorite_character, tier, updated_at FROM rankings WHERE username = ?", username)
		var rankings []RankEntry
		if err == nil {
			defer rRows.Close()
			for rRows.Next() {
				var re RankEntry
				_ = rRows.Scan(&re.ID, &re.Username, &re.GameID, &re.EloRating, &re.Wins, &re.Losses, &re.FavoriteCharacter, &re.Tier, &re.UpdatedAt)
				rankings = append(rankings, re)
			}
		}
		if rankings == nil {
			rankings = []RankEntry{}
		}

		mRows, err := db.Query(`SELECT id, game_id, host_username, guest_username, winner_username, host_character, guest_character, host_score, guest_score, duration_seconds, elo_change, created_at 
			FROM match_history 
			WHERE host_username = ? OR guest_username = ? 
			ORDER BY created_at DESC LIMIT 20`, username, username)
		var history []MatchEntry
		if err == nil {
			defer mRows.Close()
			for mRows.Next() {
				var me MatchEntry
				_ = mRows.Scan(&me.ID, &me.GameID, &me.HostUsername, &me.GuestUsername, &me.WinnerUsername, &me.HostCharacter, &me.GuestCharacter, &me.HostScore, &me.GuestScore, &me.DurationSeconds, &me.EloChange, &me.CreatedAt)
				history = append(history, me)
			}
		}
		if history == nil {
			history = []MatchEntry{}
		}

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"sucesso":  true,
			"username": username,
			"rankings": rankings,
			"history":  history,
		})
	})

	handler := corsMiddleware(mux)
	addr := "0.0.0.0:" + port

	log.Printf("[%s] Payldr server listening on %s (HTTP)", environment, addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
