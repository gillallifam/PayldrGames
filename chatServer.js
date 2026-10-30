import { WebSocketServer, WebSocket } from 'ws';

const rooms = new Map();

// Mapas em memória para sinalização P2P WebSockets
const activeHosters = new Map(); // hostId -> { ws, gameId, username, isPrivate }
const activeGuests = new Map();  // guestId -> { ws, targetHostId }
const pendingOffers = new Map(); // requestId -> { guestId, hostId, timestamp }

/**
 * Inicializa o servidor de Chat e Sinalização P2P via WebSockets.
 */
export function initChatServer(server, app, dbPool) {
    // 1. Garante que a tabela chat_messages exista no SQLite
    try {
        dbPool.exec(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                room TEXT NOT NULL DEFAULT 'global',
                sender TEXT NOT NULL,
                avatar TEXT DEFAULT NULL,
                text TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_chat_room_created ON chat_messages(room, created_at);
        `);
        console.log('[Chat/Signal] Tabela chat_messages pronta no SQLite.');
    } catch (err) {
        console.error('[Chat/Signal] Erro ao verificar tabela chat_messages:', err);
    }

    // 2. Inicia o job de limpeza horária de mensagens antigas
    startChatCleanupJob(dbPool);

    // 3. Registra endpoints REST (histórico, envio de fallback e consulta de hosters)
    registerRestRoutes(app, dbPool);

    // 4. WebSocket Server anexado ao servidor HTTP/HTTPS
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        const url = request.url || '';
        if (url.startsWith('/ws/chat') || url.startsWith('/payldr/ws/chat') || url.startsWith('/payldr/ws/signal') || url.startsWith('/ws/signal')) {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        }
    });

    wss.on('connection', (ws, req) => {
        ws.currentRoom = 'global';
        ws.username = 'Anônimo';
        ws.avatar = null;
        ws.isAlive = true;
        ws.hostId = null;
        ws.guestId = null;

        joinRoom(ws, 'global');

        // Envia imediatamente a lista de hosters ativos para o cliente recém-conectado
        sendHostersList(ws);

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                handleWsMessage(ws, data, dbPool, wss);
            } catch (err) {
                console.error('[WS] Erro ao processar mensagem JSON:', err);
                ws.send(JSON.stringify({ event: 'error', message: 'Payload JSON inválido.' }));
            }
        });

        ws.on('close', () => {
            cleanupClient(ws, wss);
        });

        ws.on('error', (err) => {
            console.error(`[WS] Erro no socket (${ws.username}):`, err.message);
            cleanupClient(ws, wss);
        });
    });

    // Heartbeat a cada 30 segundos
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) {
                cleanupClient(ws, wss);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => {
        clearInterval(heartbeatInterval);
    });

    console.log('[Chat/Signal] Servidor unificado WebSockets inicializado em /payldr/ws/chat e /payldr/ws/signal');
}

function cleanupClient(ws, wss) {
    leaveCurrentRoom(ws);

    // Se o cliente era um Host, remove sua sala e notifica todos
    if (ws.hostId && activeHosters.has(ws.hostId)) {
        console.log(`[Signal WS] Host desconectado/fechado: ${ws.hostId}. Limpando sala imediatamente.`);
        activeHosters.delete(ws.hostId);
        broadcastHostersUpdate(wss);
    }

    // Se o cliente era um Guest, remove registro
    if (ws.guestId && activeGuests.has(ws.guestId)) {
        activeGuests.delete(ws.guestId);
    }
}

function startChatCleanupJob(dbPool) {
    purgeOldMessages(dbPool);
    setInterval(() => {
        purgeOldMessages(dbPool);
    }, 60 * 60 * 1000);
}

function purgeOldMessages(dbPool) {
    try {
        const stmt = dbPool.prepare("DELETE FROM chat_messages WHERE created_at < datetime('now', '-24 hours')");
        const info = stmt.run();
        if (info.changes > 0) {
            console.log(`[Chat Cleanup] ${info.changes} mensagens expiradas (>24h) foram expurgadas.`);
        }
    } catch (err) {
        console.error('[Chat Cleanup] Erro ao expurgar mensagens antigas:', err.message);
    }
}

function handleWsMessage(ws, data, dbPool, wss) {
    const action = data.action || data.event;

    switch (action) {
        // --- CHAT ACTIONS ---
        case 'auth':
        case 'join_room': {
            const newRoom = (data.room || 'global').trim();
            if (data.username) ws.username = String(data.username).trim().slice(0, 50);
            if (data.avatar) ws.avatar = String(data.avatar).trim().slice(0, 255);

            joinRoom(ws, newRoom);

            const history = fetchRoomHistory(dbPool, newRoom);
            ws.send(JSON.stringify({
                event: 'room_joined',
                room: newRoom,
                username: ws.username,
                history
            }));
            break;
        }

        case 'send_message': {
            const room = (data.room || ws.currentRoom || 'global').trim();
            const sender = (data.sender || ws.username || 'Anônimo').trim().slice(0, 50);
            const avatar = data.avatar || ws.avatar || null;
            const text = (data.text || '').trim().slice(0, 280);

            if (!text) return;

            const msgId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const timestamp = Date.now();

            try {
                const stmt = dbPool.prepare(
                    'INSERT INTO chat_messages (id, room, sender, avatar, text) VALUES (?, ?, ?, ?, ?)'
                );
                stmt.run(msgId, room, sender, avatar, text);
            } catch (err) {
                console.error('[Chat WS] Erro ao salvar mensagem no SQLite:', err);
            }

            const broadcastPayload = {
                event: 'new_message',
                room,
                message: {
                    id: msgId,
                    room,
                    sender,
                    avatar,
                    text,
                    timestamp
                }
            };
            broadcastToRoom(room, broadcastPayload);
            break;
        }

        // --- P2P SIGNALING ACTIONS ---
        case 'register_host': {
            const hostId = String(data.hostId || '').trim();
            const gameId = String(data.gameId || '').trim();
            const username = String(data.username || ws.username || 'Host').trim();
            const isPrivate = Boolean(data.isPrivate);

            if (!hostId) {
                ws.send(JSON.stringify({ event: 'signal_error', message: 'hostId obrigatório.' }));
                return;
            }

            ws.hostId = hostId;
            activeHosters.set(hostId, {
                ws,
                gameId,
                username,
                isPrivate
            });

            console.log(`[Signal WS] Host registrado: ${hostId} (jogo: ${gameId}, user: ${username})`);
            ws.send(JSON.stringify({ event: 'host_registered', hostId, gameId }));
            broadcastHostersUpdate(wss);
            break;
        }

        case 'unregister_host': {
            const hostId = String(data.hostId || ws.hostId || '').trim();
            if (hostId && activeHosters.has(hostId)) {
                activeHosters.delete(hostId);
                console.log(`[Signal WS] Host cancelado/removido: ${hostId}`);
                ws.send(JSON.stringify({ event: 'host_unregistered', hostId }));
                broadcastHostersUpdate(wss);
            }
            break;
        }

        case 'send_offer': {
            const targetHostId = String(data.targetHostId || data.hostId || '').trim();
            const guestId = String(data.guestId || '').trim();
            const payload = data.payload || data.sdp || data.dados;
            const requestId = data.requestId || `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

            if (!targetHostId || !guestId || !payload) {
                ws.send(JSON.stringify({ event: 'signal_error', message: 'targetHostId, guestId e payload são obrigatórios.' }));
                return;
            }

            ws.guestId = guestId;
            activeGuests.set(guestId, { ws, targetHostId });

            const targetHost = activeHosters.get(targetHostId);
            if (!targetHost || targetHost.ws.readyState !== WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    event: 'offer_failed',
                    requestId,
                    message: `Host ${targetHostId} está offline ou indisponível.`
                }));
                return;
            }

            pendingOffers.set(requestId, { guestId, hostId: targetHostId, timestamp: Date.now() });

            // Encaminha a oferta diretamente para o Host via WebSocket
            targetHost.ws.send(JSON.stringify({
                event: 'incoming_offer',
                requestId,
                guestId,
                dados: payload,
                timestamp: new Date().toISOString()
            }));

            console.log(`[Signal WS] Oferta WebRTC de '${guestId}' enviada para o Host '${targetHostId}' (reqID: ${requestId})`);
            break;
        }

        case 'send_answer': {
            const targetGuestId = String(data.targetGuestId || data.guestId || '').trim();
            const requestId = String(data.requestId || '').trim();
            const payload = data.payload || data.sdp || data.dados;

            if (!targetGuestId || !payload) {
                ws.send(JSON.stringify({ event: 'signal_error', message: 'targetGuestId e payload são obrigatórios.' }));
                return;
            }

            const targetGuest = activeGuests.get(targetGuestId);
            if (!targetGuest || targetGuest.ws.readyState !== WebSocket.OPEN) {
                console.log(`[Signal WS] Falha ao entregar resposta: Guest '${targetGuestId}' offline.`);
                return;
            }

            // Encaminha a resposta SDP diretamente para o Guest
            targetGuest.ws.send(JSON.stringify({
                event: 'offer_answered',
                requestId,
                origem: 'hoster',
                dados: payload
            }));

            pendingOffers.delete(requestId);
            console.log(`[Signal WS] Resposta SDP do Host enviada com sucesso para '${targetGuestId}'`);
            break;
        }

        case 'get_hosters': {
            sendHostersList(ws);
            break;
        }

        case 'ping': {
            ws.send(JSON.stringify({ event: 'pong', time: Date.now() }));
            break;
        }

        default:
            break;
    }
}

function joinRoom(ws, room) {
    leaveCurrentRoom(ws);
    ws.currentRoom = room;

    if (!rooms.has(room)) {
        rooms.set(room, new Set());
    }
    rooms.get(room).add(ws);

    broadcastPresence(room);
}

function leaveCurrentRoom(ws) {
    const room = ws.currentRoom;
    if (room && rooms.has(room)) {
        rooms.get(room).delete(ws);
        if (rooms.get(room).size === 0) {
            rooms.delete(room);
        } else {
            broadcastPresence(room);
        }
    }
}

function broadcastToRoom(room, payload) {
    if (!rooms.has(room)) return;
    const jsonStr = JSON.stringify(payload);
    for (const client of rooms.get(room)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(jsonStr);
        }
    }
}

function broadcastPresence(room) {
    if (!rooms.has(room)) return;
    const clients = rooms.get(room);
    const count = clients.size;
    const users = Array.from(clients).map(c => c.username).filter(Boolean);

    const payload = JSON.stringify({
        event: 'presence_update',
        room,
        onlineCount: count,
        users: Array.from(new Set(users))
    });

    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

function getActiveHostersMap() {
    const result = {};
    for (const [id, data] of activeHosters.entries()) {
        if (!data.isPrivate) {
            result[id] = data.gameId || "";
        }
    }
    return result;
}

function sendHostersList(ws) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            event: 'hosters_updated',
            hosters: getActiveHostersMap()
        }));
    }
}

function broadcastHostersUpdate(wss) {
    const payload = JSON.stringify({
        event: 'hosters_updated',
        hosters: getActiveHostersMap()
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function fetchRoomHistory(dbPool, room) {
    try {
        const stmt = dbPool.prepare(`
            SELECT id, room, sender, avatar, text, strftime('%s', created_at) * 1000 AS timestamp
            FROM chat_messages
            WHERE room = ? AND created_at >= datetime('now', '-24 hours')
            ORDER BY created_at ASC
            LIMIT 100
        `);
        return stmt.all(room) || [];
    } catch (err) {
        console.error('[Chat] Erro ao buscar histórico da sala:', err);
        return [];
    }
}

function registerRestRoutes(app, dbPool) {
    app.get('/payldr/chat/history', (req, res) => {
        const room = req.query.room || 'global';
        const history = fetchRoomHistory(dbPool, room);
        res.json({ success: true, messages: history });
    });

    app.post('/payldr/chat/send', (req, res) => {
        const { room = 'global', sender, avatar, text } = req.body;
        if (!sender || !text || !text.trim()) {
            return res.status(400).json({ success: false, message: 'Remetente e texto são obrigatórios.' });
        }

        const cleanText = text.trim().slice(0, 280);
        const msgId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const timestamp = Date.now();

        try {
            const stmt = dbPool.prepare(
                'INSERT INTO chat_messages (id, room, sender, avatar, text) VALUES (?, ?, ?, ?, ?)'
            );
            stmt.run(msgId, room, sender, avatar || null, cleanText);

            const message = {
                id: msgId,
                room,
                sender,
                avatar: avatar || null,
                text: cleanText,
                timestamp
            };

            broadcastToRoom(room, {
                event: 'new_message',
                room,
                message
            });

            res.json({ success: true, message });
        } catch (err) {
            console.error('[Chat REST] Erro ao salvar mensagem:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Endpoint REST para compatibilidade retroativa
    app.get('/payldr/hosters', (req, res) => {
        return res.json(getActiveHostersMap());
    });
}
