import dotenv from "dotenv"
import cors from "cors"
import express from "express"
import fetch from "cross-fetch"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import bcrypt from "bcryptjs"
import dbPool from "./db.js"

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: 'payldr.env' })
let PORT = process.env.API_PORT || 9610;
let ENVIRONMENT = (process.env.ENVIRONMENT || 'LOCAL').toUpperCase();

// Helper to format dates to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS)
function formatMySQLDate(dateInput) {
    if (!dateInput) return null;
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Inicialização Assíncrona do Banco de Dados
async function initDatabase() {
    // Inicializa a tabela de conexões se não existir
    dbPool.exec(`
        CREATE TABLE IF NOT EXISTS conexoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT,
            client_id TEXT,
            evento TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Inicializa a tabela de jogos se não existir
    dbPool.exec(`
        CREATE TABLE IF NOT EXISTS jogos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            imagem TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Inicializa a tabela de usuários se não existir
    dbPool.exec(`
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
        )
    `);

    // Migrações para garantir que colunas novas existam caso a tabela tenha sido criada na estrutura antiga
    const columns = dbPool.pragma('table_info(users)');
    const colNames = columns.map(c => c.name);

    if (!colNames.includes('username')) {
        try { dbPool.exec("ALTER TABLE users ADD COLUMN username TEXT UNIQUE NULL"); } catch (e) {}
    }
    if (!colNames.includes('type')) {
        try { dbPool.exec("ALTER TABLE users ADD COLUMN type TEXT DEFAULT 'guest'"); } catch (e) {}
    }
    if (!colNames.includes('hostId')) {
        try { dbPool.exec("ALTER TABLE users ADD COLUMN hostId TEXT"); } catch (e) {}
    }
    if (!colNames.includes('canHost')) {
        try { dbPool.exec("ALTER TABLE users ADD COLUMN canHost DATETIME"); } catch (e) {}
    }

    // Migração para a tabela de jogos (adicionar coluna status)
    const gameColumns = dbPool.pragma('table_info(jogos)');
    const gameColNames = gameColumns.map(c => c.name);
    if (!gameColNames.includes('status')) {
        try { dbPool.exec("ALTER TABLE jogos ADD COLUMN status TEXT DEFAULT 'active'"); } catch (e) {}
    }
    try {
        dbPool.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jogos_nome ON jogos(nome)");
    } catch (e) {}

    // Seed de usuários padrão se a tabela estiver vazia
    const userCount = dbPool.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
        const defaultHostPass = bcrypt.hashSync('payldr123', 10);
        const defaultGuestPass = bcrypt.hashSync('payldr123', 10);
        const testUserPass = bcrypt.hashSync('MySecurePassword123!', 10);
        
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);
        const futureDateString = futureDate.toISOString();

        dbPool.prepare('INSERT INTO users (username, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?)').run(
            'host1', defaultHostPass, 'host', 'easynet-room-8827', futureDateString
        );
        dbPool.prepare('INSERT INTO users (username, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?)').run(
            'guest1', defaultGuestPass, 'guest', '', null
        );
        dbPool.prepare('INSERT INTO users (name, email, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?, ?)').run(
            'Test User', 'test_user_1783297086780@example.com', testUserPass, 'host', 'test-host-id', futureDateString
        );
        console.log('Usuários padrão semeados com sucesso no SQLite (host1 / guest1 / Test User).');
    }

    // Seed de jogos padrão se a tabela de jogos estiver vazia
    const gameCount = dbPool.prepare('SELECT COUNT(*) as count FROM jogos').get().count;
    if (gameCount === 0) {
        dbPool.prepare('INSERT INTO jogos (nome, url, imagem, status) VALUES (?, ?, ?, ?)').run(
            'Ikemen GO', 'https://github.com/ikemen-go/ikemen-go/releases/download/v0.98.2/Ikemen_GO-v0.98.2-win64.zip', 'ikemen_base', 'active'
        );
        dbPool.prepare('INSERT INTO jogos (nome, url, imagem, status) VALUES (?, ?, ?, ?)').run(
            'Street Fighter', 'https://devserver.marketpix.com.br:9710/payldr/static/street_fighter.zip', 'street_fighter', 'active'
        );
        console.log('Jogos padrão semeados com sucesso no SQLite.');
    }
}


let server = null;
let app = express();
app.use(cors());
app.use(express.json({ extended: true }));

// Servir arquivos estáticos do diretório /static
const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) {
    fs.mkdirSync(staticDir, { recursive: true });
}
app.use('/payldr/static', express.static(staticDir));

// Configuração do Multer para upload de arquivos zip
import multer from 'multer';
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, staticDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'game-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.toLowerCase().endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos .zip são permitidos!'), false);
        }
    }
});

// Helper para deletar arquivos ZIP locais antigos de jogos
function deleteGameZip(gameUrl) {
    if (!gameUrl) return;
    const match = gameUrl.match(/\/payldr\/static\/([^/?#]+)/);
    if (match) {
        const filename = match[1];
        const filePath = path.join(staticDir, filename);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`[File Cleanup] Deletado ZIP antigo: ${filePath}`);
            } catch (err) {
                console.error(`[File Cleanup] Erro ao deletar arquivo: ${err.message}`);
            }
        }
    }
}

const authMiddleware = (req, res, next) => {
    const authUser = process.env.ADMIN_USER || 'admin';
    const authPass = process.env.ADMIN_PASS || 'payldr123';

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="PayldrGames Admin"');
        return res.status(401).send('Acesso não autorizado.');
    }

    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    if (user === authUser && pass === authPass) {
        return next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="PayldrGames Admin"');
        return res.status(401).send('Credenciais inválidas.');
    }
};

const generateId = (len = 10) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const hosters = {};
const seeders = {};
const pendingRequests = {};
const tempPrivateHosts = new Set();

setInterval(() => {
    for (const hostId in hosters) {
        try {
            hosters[hostId].res.write(': ping\n\n');
        } catch (e) {
            delete hosters[hostId];
            try {
                dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'desconectou_ping')").run(hostId);
            } catch (err) {}
        }
    }
    for (const seederId in seeders) {
        try {
            seeders[seederId].write(': ping\n\n');
        } catch (e) {
            delete seeders[seederId];
            try {
                dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'desconectou_ping')").run(seederId);
            } catch (err) {}
        }
    }
}, 20000);


app.get("/status", async function (req, res) {
    console.log("Status");
    return res.json({ service: "api", status: "on", time: Date.now() })
})

function handleHosterConnection(hostId, isPrivate, req, res) {
    if (isPrivate) {
        tempPrivateHosts.add(hostId);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const gameId = req.query.gameId || "";
    hosters[hostId] = { res, private: isPrivate, gameId };
    console.log(`Hoster ligado: ${hostId} (privado: ${isPrivate}) para o jogo: ${gameId}`);
    try {
        dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'conectou')").run(hostId);
    } catch (err) {
        console.error("Erro ao gravar conexao hoster no SQLite:", err.message);
    }

    res.write(`data: ${JSON.stringify({ tipo: 'SISTEMA', mensagem: `Ligado como ${hostId}` })}\n\n`);

    req.on('close', async () => {
        console.log(`Hoster desligado: ${hostId}`);
        delete hosters[hostId];
        try {
            dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'desconectou')").run(hostId);
        } catch (err) {
            console.error("Erro ao gravar desconexao hoster no SQLite:", err.message);
        }
    });
}

app.get('/payldr/hoster/private/:hostId', async (req, res) => {
    const { hostId } = req.params;
    handleHosterConnection(hostId, true, req, res);
});

app.get('/payldr/hoster/:hostId', async (req, res) => {
    const { hostId } = req.params;
    handleHosterConnection(hostId, false, req, res);
});

app.get('/payldr/seeder', async (req, res) => {
    const seederId = "seeder-" + generateId(8);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    seeders[seederId] = res;
    console.log(`Seeder ligado (auto-gerado): ${seederId}`);
    try {
        dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'conectou')").run(seederId);
    } catch (err) {
        console.error("Erro ao gravar conexao seeder no SQLite:", err.message);
    }

    res.write(`data: ${JSON.stringify({ tipo: 'ID_ATRIBUITO', seederId: seederId, mensagem: `Ligado como ${seederId}` })}\n\n`);

    req.on('close', async () => {
        console.log(`Seeder desligado: ${seederId}`);
        delete seeders[seederId];
        try {
            dbPool.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'desconectou')").run(seederId);
        } catch (err) {
            console.error("Erro ao gravar desconexao seeder no SQLite:", err.message);
        }
    });
});

app.get('/payldr/seeders', (req, res) => {
    return res.json(Object.keys(seeders));
});

app.get('/payldr/hosters', (req, res) => {
    const result = {};
    for (const id in hosters) {
        if (!hosters[id].private) {
            result[id] = hosters[id].gameId || "";
        }
    }
    return res.json(result);
});

app.get('/payldr/hoster-game/:hostId', (req, res) => {
    const { hostId } = req.params;
    const host = hosters[hostId];
    if (host) {
        return res.json({ gameId: host.gameId || "" });
    }
    return res.json({ gameId: "" });
});

app.post('/payldr/host/private/:hostId', (req, res) => {
    const { hostId } = req.params;
    tempPrivateHosts.add(hostId);
    console.log(`Host marcado como privado temporariamente: ${hostId}`);
    return res.json({ sucesso: true });
});

app.get('/payldr/generate-id', (req, res) => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    let newId;
    do {
        const part1 = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
        const part2 = Array.from({ length: 4 }, () => digits[Math.floor(Math.random() * digits.length)]).join('');
        const part3 = Array.from({ length: 5 }, () => digits[Math.floor(Math.random() * digits.length)]).join('');
        newId = `${part1}-${part2}-${part3}`;
    } while (hosters[newId] || seeders[newId]);
    return res.json({ id: newId });
});

app.post('/payldr/guest/send', (req, res) => {
    const { guestId, hostId, payload } = req.body;
    console.log(`[Server] Recebido /guest/send de ${guestId} para host ${hostId}`);

    if (!guestId || !hostId || !payload) {
        console.log(`[Server] /guest/send falhou: campos incompletos`);
        return res.status(200).json({ sucesso: false, mensagem: 'Campos incompletos.' });
    }

    const targetObj = hosters[hostId] || seeders[hostId];
    if (!targetObj) {
        console.log(`[Server] /guest/send falhou: hoster/seeder ${hostId} offline`);
        return res.status(200).json({ sucesso: false, mensagem: 'Hoster/Seeder offline ou não encontrado.' });
    }

    const targetRes = targetObj.res || targetObj;

    const requestId = generateId(10);
    console.log(`[Server] Gerado requestId: ${requestId} para a requisição`);

    pendingRequests[requestId] = res;

    res.on('close', () => {
        if (!res.writableEnded && pendingRequests[requestId]) {
            console.log(`[Server] Conexão do guest para requestId ${requestId} interrompida pelo cliente`);
            delete pendingRequests[requestId];
        }
    });

    const evento = {
        requestId,
        origem: guestId,
        dados: payload,
        timestamp: new Date().toISOString()
    };

    console.log(`[Server] Enviando evento para o hoster/seeder ${hostId}`);
    targetRes.write(`data: ${JSON.stringify(evento)}\n\n`);

    setTimeout(() => {
        if (pendingRequests[requestId]) {
            console.log(`[Server] Timeout para requestId ${requestId}`);
            pendingRequests[requestId].status(504).json({
                sucesso: false,
                mensagem: 'Timeout: O hoster/seeder não respondeu.'
            });
            delete pendingRequests[requestId];
        }
    }, 30000);
});

app.post('/payldr/reply', (req, res) => {
    const { requestId, responseData } = req.body;
    console.log(`[Server] Recebido /reply para requestId: ${requestId}`);

    const guestRes = pendingRequests[requestId];

    if (!guestRes) {
        console.log(`[Server] /reply falhou: requestId ${requestId} não encontrado ou expirado`);
        return res.status(200).json({
            sucesso: false,
            mensagem: 'A requisição expirou, foi cancelada ou não existe.'
        });
    }

    console.log(`[Server] Respondendo ao guestRes para requestId: ${requestId}`);
    guestRes.status(200).json({
        sucesso: true,
        origem: 'hoster',
        dados: responseData
    });

    delete pendingRequests[requestId];
    console.log(`[Server] Finalizando resposta /reply`);
    res.status(200).json({ sucesso: true, mensagem: 'Entregue.' });
});

app.post('/payldr/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`[Auth] Login attempt for user: ${username}`);

    if (!username || !password) {
        return res.status(400).json({ success: false, mensagem: 'Usuário e senha são obrigatórios.' });
    }

    try {
        const user = dbPool.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
        if (!user) {
            return res.status(401).json({ success: false, mensagem: 'Credenciais inválidas.' });
        }

        const match = bcrypt.compareSync(password, user.password);
        if (!match) {
            return res.status(401).json({ success: false, mensagem: 'Credenciais inválidas.' });
        }

        // Determina se o usuário pode ser host baseado na data canHost (se está no futuro ou igual a hoje)
        let finalType = 'guest';
        if (user.canHost) {
            const canHostDate = new Date(user.canHost);
            if (canHostDate >= new Date()) {
                finalType = 'host';
            }
        }

        console.log(`[Auth] Login successful: ${username} (canHost expires: ${user.canHost}, returning type: ${finalType})`);
        return res.status(200).json({
            success: true,
            profile: {
                username: user.username,
                type: finalType,
                hostId: user.hostId || '',
                canHost: user.canHost || ''
            }
        });
    } catch (err) {
        console.error('[Auth] Error logging in:', err.message);
        return res.status(500).json({ success: false, mensagem: 'Erro interno ao realizar login.' });
    }
});

app.post('/payldr/register', async (req, res) => {
    const { username, email, password } = req.body;
    console.log(`[Auth] Registration request for user: ${username} (email: ${email})`);

    if (!username || !password || !email) {
        return res.status(400).json({ sucesso: false, mensagem: 'Usuário, e-mail e senha são obrigatórios.' });
    }

    try {
        const existing = dbPool.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
        if (existing) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome de usuário ou e-mail já cadastrado.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const userType = 'guest';
        const userHostId = '';
        // Set canHost to null by default (inactive until activated later)
        const userCanHost = null;

        dbPool.prepare('INSERT INTO users (username, email, password, type, hostId, canHost) VALUES (?, ?, ?, ?, ?, ?)').run(
            username,
            email,
            hashedPassword,
            userType,
            userHostId,
            userCanHost
        );

        console.log(`[Auth] User registered successfully: ${username}`);
        return res.status(201).json({ sucesso: true, mensagem: 'Usuário registrado com sucesso.' });
    } catch (err) {
        console.error('[Auth] Error registering user:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao registrar usuário.' });
    }
});

app.get('/payldr/games/register', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    try {
        const htmlPath = path.join(__dirname, 'cadastro.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.send(html);
    } catch (err) {
        console.error('Erro ao carregar cadastro.html:', err.message);
        res.status(500).send('Erro interno do servidor ao carregar a página.');
    }
});

app.get('/payldr/users', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    try {
        const htmlPath = path.join(__dirname, 'users.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.send(html);
    } catch (err) {
        console.error('Erro ao carregar users.html:', err.message);
        res.status(500).send('Erro interno do servidor ao carregar a página.');
    }
});

app.post('/payldr/jogos/cadastro', async (req, res) => {
    const { nome, url, imagem } = req.body;
    if (!nome || !url || !imagem) {
        return res.status(400).json({ sucesso: false, mensagem: 'Preencha todos os campos.' });
    }

    try {
        const existing = dbPool.prepare('SELECT id FROM jogos WHERE nome = ?').get(nome);
        if (existing) {
            return res.status(400).json({ sucesso: false, mensagem: 'Já existe um jogo cadastrado com este nome.' });
        }

        const info = dbPool.prepare('INSERT INTO jogos (nome, url, imagem) VALUES (?, ?, ?)').run(nome, url, imagem);
        return res.status(200).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (err) {
        console.error('Erro ao cadastrar jogo no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao salvar no banco.' });
    }
});

// APIs REST para Gerenciamento de Jogos
app.get('/payldr/api/games', async (req, res) => {
    try {
        const includeAll = req.query.all === 'true';
        let query = 'SELECT * FROM jogos';
        if (!includeAll) {
            query += " WHERE status = 'active'";
        }
        query += ' ORDER BY created_at DESC';
        const rows = dbPool.prepare(query).all();
        return res.status(200).json(rows);
    } catch (err) {
        console.error('Erro ao listar jogos do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar jogos no banco.' });
    }
});

app.post('/payldr/api/games', (req, res, next) => {
    upload.single('zipFile')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ sucesso: false, mensagem: `Erro de upload: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ sucesso: false, mensagem: err.message });
        }
        next();
    });
}, async (req, res) => {
    const { nome, url, imagem, status } = req.body;
    let gameUrl = url;
    if (req.file) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        gameUrl = `${baseUrl}/payldr/static/${req.file.filename}`;
    }

    if (!nome || !gameUrl) {
        return res.status(400).json({ sucesso: false, mensagem: 'Nome e URL/Arquivo ZIP são obrigatórios.' });
    }

    try {
        const existing = dbPool.prepare('SELECT id FROM jogos WHERE nome = ?').get(nome);
        if (existing) {
            if (req.file) {
                deleteGameZip(gameUrl);
            }
            return res.status(400).json({ sucesso: false, mensagem: 'Já existe um jogo cadastrado com este nome.' });
        }

        const info = dbPool.prepare('INSERT INTO jogos (nome, url, imagem, status) VALUES (?, ?, ?, ?)').run(nome, gameUrl, imagem || '', status || 'active');
        return res.status(200).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (err) {
        console.error('Erro ao cadastrar jogo no SQLite:', err.message);
        if (req.file) {
            deleteGameZip(gameUrl);
        }
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar jogo no banco.' });
    }
});

app.put('/payldr/api/games/:id', (req, res, next) => {
    upload.single('zipFile')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ sucesso: false, mensagem: `Erro de upload: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ sucesso: false, mensagem: err.message });
        }
        next();
    });
}, async (req, res) => {
    const { id } = req.params;
    const { nome, url, imagem, status } = req.body;

    try {
        const oldGame = dbPool.prepare('SELECT url FROM jogos WHERE id = ?').get(id);
        if (!oldGame) {
            if (req.file) {
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                deleteGameZip(`${baseUrl}/payldr/static/${req.file.filename}`);
            }
            return res.status(404).json({ sucesso: false, mensagem: 'Jogo não encontrado.' });
        }

        let gameUrl = url;
        if (req.file) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            gameUrl = `${baseUrl}/payldr/static/${req.file.filename}`;
            deleteGameZip(oldGame.url);
        } else if (url && oldGame.url !== url) {
            deleteGameZip(oldGame.url);
        }

        if (!nome || !gameUrl) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome e URL/Arquivo ZIP são obrigatórios.' });
        }

        const existing = dbPool.prepare('SELECT id FROM jogos WHERE nome = ? AND id != ?').get(nome, id);
        if (existing) {
            if (req.file) {
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                deleteGameZip(`${baseUrl}/payldr/static/${req.file.filename}`);
            }
            return res.status(400).json({ sucesso: false, mensagem: 'Já existe outro jogo cadastrado com este nome.' });
        }

        const info = dbPool.prepare('UPDATE jogos SET nome = ?, url = ?, imagem = ?, status = ? WHERE id = ?').run(nome, gameUrl, imagem || '', status || 'active', id);
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao atualizar jogo no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar jogo no banco.' });
    }
});

app.delete('/payldr/api/games/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const game = dbPool.prepare('SELECT url FROM jogos WHERE id = ?').get(id);
        if (!game) {
            return res.status(404).json({ sucesso: false, mensagem: 'Jogo não encontrado.' });
        }

        deleteGameZip(game.url);

        const info = dbPool.prepare('DELETE FROM jogos WHERE id = ?').run(id);
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: 'Jogo não encontrado.' });
        }
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao deletar jogo do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao deletar jogo no banco.' });
    }
});

// APIs REST para Gerenciamento de Usuários
app.get('/payldr/api/users', async (req, res) => {
    try {
        const rows = dbPool.prepare('SELECT id, name, email, username, status, type, hostId, canHost, created_at, updated_at FROM users ORDER BY created_at DESC').all();
        return res.status(200).json(rows);
    } catch (err) {
        console.error('Erro ao listar usuários do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários no banco.' });
    }
});

app.post('/payldr/api/users', async (req, res) => {
    const { username, name, email, password, status, hostId, canHost } = req.body;
    if (!username || !password) {
        return res.status(400).json({ sucesso: false, mensagem: 'Username e senha são obrigatórios.' });
    }

    try {
        // Verifica se usuário ou email já existem
        const existing = dbPool.prepare("SELECT id FROM users WHERE username = ? OR (email = ? AND email IS NOT NULL AND email != '')").get(username, email || '');
        if (existing) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome de usuário ou e-mail já cadastrado.' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const formattedCanHost = formatMySQLDate(canHost);

        const info = dbPool.prepare(`
            INSERT INTO users (username, name, email, password, type, status, hostId, canHost) 
            VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)
        `).run(username, name || null, email || null, hashedPassword, status || 'active', hostId || null, formattedCanHost);

        return res.status(200).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (err) {
        console.error('Erro ao cadastrar usuário no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário no banco.' });
    }
});

app.put('/payldr/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const { username, name, email, password, type, status, hostId, canHost } = req.body;
    if (!username) {
        return res.status(400).json({ sucesso: false, mensagem: 'Username é obrigatório.' });
    }

    try {
        // Verifica se username ou email choca com outro usuário
        const existing = dbPool.prepare("SELECT id FROM users WHERE (username = ? OR (email = ? AND email IS NOT NULL AND email != '')) AND id != ?").get(username, email || '', id);
        if (existing) {
            return res.status(400).json({ sucesso: false, mensagem: 'Nome de usuário ou e-mail já cadastrado em outra conta.' });
        }

        const formattedCanHost = formatMySQLDate(canHost);

        let info;
        if (password && password.trim() !== '') {
            const hashedPassword = bcrypt.hashSync(password, 10);
            info = dbPool.prepare(`
                UPDATE users 
                SET username = ?, name = ?, email = ?, password = ?, status = ?, hostId = ?, canHost = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `).run(username, name || null, email || null, hashedPassword, status || 'active', hostId || null, formattedCanHost, id);
        } else {
            info = dbPool.prepare(`
                UPDATE users 
                SET username = ?, name = ?, email = ?, status = ?, hostId = ?, canHost = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `).run(username, name || null, email || null, status || 'active', hostId || null, formattedCanHost, id);
        }

        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: 'Usuário não encontrado.' });
        }
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao atualizar usuário no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar usuário no banco.' });
    }
});

app.delete('/payldr/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const info = dbPool.prepare('DELETE FROM users WHERE id = ?').run(id);
        
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: 'Usuário não encontrado.' });
        }
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao deletar usuário do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao deletar usuário no banco.' });
    }
});

async function getCerts() {
    const authName = process.env.CERT_AUTH_NAME;
    const authPass = process.env.CERT_AUTH_PASS;

    let headers = new fetch.Headers();
    headers.set('Authorization', 'Basic ' + Buffer.from(`${authName}:${authPass}`).toString('base64'));

    let certData = await fetch(`https://certdist.marketpix.com.br:8443/cert`, {
        method: 'GET',
        headers: headers
    })
    return certData.json()
}

async function startAsync() {
    console.log("startAsync");
    try {
        // Inicializa tabelas no MySQL antes do servidor começar a escutar
        await initDatabase();
        console.log("Banco de dados MySQL inicializado.");

        switch (ENVIRONMENT) {
            case "LOCAL":
            case "DEVON":
                app.listen(PORT, "0.0.0.0")
                console.log(`${ENVIRONMENT} on port ${PORT}`);
                break;

            case "PROD": {
                let certData = null;

                while (!certData) {
                    try {
                        certData = await getCerts();
                    } catch (err) {
                        console.error("Falha ao obter certificados na inicialização. Retentando em alguns segundos...", err.message);
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                }

                let https = await import('https');
                let httpsOptions = {
                    key: certData.priv,
                    cert: certData.cert
                };
                server = https.createServer(httpsOptions, app);
                server.listen(PORT, "0.0.0.0")
                console.log(`${ENVIRONMENT} https on port ${PORT}`);

                startCertRenewalScheduler();
                break;
            }
            default:
                throw new Error("Environment not selected.")
        }
    } catch (error) {
        console.error(error);
    }
}

function startCertRenewalScheduler() {
    setInterval(async () => {
        console.log("Iniciando verificação periódica para renovação do certificado SSL...");
        try {
            const certData = await getCerts();
            server.setSecureContext({
                key: certData.priv,
                cert: certData.cert
            });
            console.log("Certificados SSL atualizados dinamicamente com sucesso!");
        } catch (error) {
            console.error("Falha ao renovar o certificado SSL automaticamente:", error.message);
        }
    }, 24 * 60 * 60 * 1000);
}

startAsync();
