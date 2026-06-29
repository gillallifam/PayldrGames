import dotenv from "dotenv"
import cors from "cors"
import express from "express"
import fetch from "cross-fetch"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: 'payldr.env' })
let PORT = process.env.API_PORT || 9610;
let ENVIRONMENT = (process.env.ENVIRONMENT || 'LOCAL').toUpperCase();

const db = new Database('payldr.db');

// Inicializa a tabela de conexões se não existir
db.prepare(`
    CREATE TABLE IF NOT EXISTS conexoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT,
        client_id TEXT,
        evento TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

// Inicializa a tabela de jogos se não existir
db.prepare(`
    CREATE TABLE IF NOT EXISTS jogos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        url TEXT NOT NULL,
        imagem TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();


let server = null;
let app = express();
app.use(cors());
app.use(express.json({ extended: true }));

const generateId = (len = 10) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const hosters = {};
const seeders = {};
const pendingRequests = {};

setInterval(() => {
    for (const hostId in hosters) {
        try {
            hosters[hostId].write(': ping\n\n');
        } catch (e) {
            delete hosters[hostId];
            try {
                db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'desconectou_ping')").run(hostId);
            } catch (err) {}
        }
    }
    for (const seederId in seeders) {
        try {
            seeders[seederId].write(': ping\n\n');
        } catch (e) {
            delete seeders[seederId];
            try {
                db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'desconectou_ping')").run(seederId);
            } catch (err) {}
        }
    }
}, 20000);


app.get("/status", async function (req, res) {
    console.log("Status");
    return res.json({ service: "api", status: "on", time: Date.now() })
})

app.get('/payldr/hoster/:hostId', (req, res) => {
    const { hostId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    hosters[hostId] = res;
    console.log(`Hoster ligado: ${hostId}`);
    try {
        db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'conectou')").run(hostId);
    } catch (err) {
        console.error("Erro ao gravar conexao hoster no SQLite:", err.message);
    }

    res.write(`data: ${JSON.stringify({ tipo: 'SISTEMA', mensagem: `Ligado como ${hostId}` })}\n\n`);

    req.on('close', () => {
        console.log(`Hoster desligado: ${hostId}`);
        delete hosters[hostId];
        try {
            db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('hoster', ?, 'desconectou')").run(hostId);
        } catch (err) {
            console.error("Erro ao gravar desconexao hoster no SQLite:", err.message);
        }
    });
});

app.get('/payldr/seeder/:seederId', (req, res) => {
    const { seederId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    seeders[seederId] = res;
    console.log(`Seeder ligado: ${seederId}`);
    try {
        db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'conectou')").run(seederId);
    } catch (err) {
        console.error("Erro ao gravar conexao seeder no SQLite:", err.message);
    }

    res.write(`data: ${JSON.stringify({ tipo: 'SISTEMA', mensagem: `Ligado como ${seederId}` })}\n\n`);

    req.on('close', () => {
        console.log(`Seeder desligado: ${seederId}`);
        delete seeders[seederId];
        try {
            db.prepare("INSERT INTO conexoes (tipo, client_id, evento) VALUES ('seeder', ?, 'desconectou')").run(seederId);
        } catch (err) {
            console.error("Erro ao gravar desconexao seeder no SQLite:", err.message);
        }
    });
});

app.get('/payldr/seeders', (req, res) => {
    return res.json(Object.keys(seeders));
});

app.get('/payldr/hosters', (req, res) => {
    return res.json(Object.keys(hosters));
});

app.post('/payldr/guest/send', (req, res) => {
    const { guestId, hostId, payload } = req.body;
    console.log(`[Server] Recebido /guest/send de ${guestId} para host ${hostId}`);

    if (!guestId || !hostId || !payload) {
        console.log(`[Server] /guest/send falhou: campos incompletos`);
        return res.status(200).json({ sucesso: false, mensagem: 'Campos incompletos.' });
    }

    const targetRes = hosters[hostId] || seeders[hostId];
    if (!targetRes) {
        console.log(`[Server] /guest/send falhou: hoster/seeder ${hostId} offline`);
        return res.status(200).json({ sucesso: false, mensagem: 'Hoster/Seeder offline ou não encontrado.' });
    }

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

app.get('/payldr/games/register', (req, res) => {
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

// APIs REST para Gerenciamento de Jogos
app.get('/payldr/api/games', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM jogos ORDER BY created_at DESC').all();
        return res.status(200).json(rows);
    } catch (err) {
        console.error('Erro ao listar jogos do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar jogos no banco.' });
    }
});

app.post('/payldr/api/games', (req, res) => {
    const { nome, url, imagem } = req.body;
    if (!nome || !url) {
        return res.status(400).json({ sucesso: false, mensagem: 'Nome e URL são obrigatórios.' });
    }

    try {
        const stmt = db.prepare('INSERT INTO jogos (nome, url, imagem) VALUES (?, ?, ?)');
        const info = stmt.run(nome, url, imagem || '');
        return res.status(200).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (err) {
        console.error('Erro ao cadastrar jogo no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar jogo no banco.' });
    }
});

app.put('/payldr/api/games/:id', (req, res) => {
    const { id } = req.params;
    const { nome, url, imagem } = req.body;
    if (!nome || !url) {
        return res.status(400).json({ sucesso: false, mensagem: 'Nome e URL são obrigatórios.' });
    }

    try {
        const stmt = db.prepare('UPDATE jogos SET nome = ?, url = ?, imagem = ? WHERE id = ?');
        const info = stmt.run(nome, url, imagem || '', id);
        
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: 'Jogo não encontrado.' });
        }
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao atualizar jogo no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar jogo no banco.' });
    }
});

app.delete('/payldr/api/games/:id', (req, res) => {
    const { id } = req.params;
    try {
        const stmt = db.prepare('DELETE FROM jogos WHERE id = ?');
        const info = stmt.run(id);
        
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: 'Jogo não encontrado.' });
        }
        return res.status(200).json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao deletar jogo do SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao deletar jogo no banco.' });
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
