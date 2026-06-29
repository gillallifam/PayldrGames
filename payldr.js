import dotenv from "dotenv"
import cors from "cors"
import express from "express"
import fetch from "cross-fetch"
import Database from "better-sqlite3"

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

app.post('/payldr/guest/send', (req, res) => {
    const { guestId, hostId, payload } = req.body;
    console.log(`[Server] Recebido /guest/send de ${guestId} para host ${hostId}`);

    if (!guestId || !hostId || !payload) {
        console.log(`[Server] /guest/send falhou: campos incompletos`);
        return res.status(200).json({ sucesso: false, mensagem: 'Campos incompletos.' });
    }

    const hostRes = hosters[hostId];
    if (!hostRes) {
        console.log(`[Server] /guest/send falhou: hoster ${hostId} offline`);
        return res.status(200).json({ sucesso: false, mensagem: 'Hoster offline ou não encontrado.' });
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

    console.log(`[Server] Enviando evento para o hoster ${hostId}`);
    hostRes.write(`data: ${JSON.stringify(evento)}\n\n`);

    setTimeout(() => {
        if (pendingRequests[requestId]) {
            console.log(`[Server] Timeout para requestId ${requestId}`);
            pendingRequests[requestId].status(504).json({
                sucesso: false,
                mensagem: 'Timeout: O hoster não respondeu.'
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

app.get('/payldr/jogos/cadastro', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cadastro de Jogo - PayldrGames</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Outfit', sans-serif;
        }

        body {
            background: radial-gradient(circle at 50% 50%, #1a1528 0%, #0d0b14 100%);
            color: #f3f0ff;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
            overflow-x: hidden;
        }

        .blob {
            position: absolute;
            width: 300px;
            height: 300px;
            background: #8b5cf6;
            filter: blur(150px);
            opacity: 0.15;
            border-radius: 50%;
            z-index: 0;
            pointer-events: none;
        }
        .blob-1 { top: 10%; left: 10%; background: #3b82f6; }
        .blob-2 { bottom: 10%; right: 10%; }

        .container {
            position: relative;
            z-index: 10;
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 24px;
            padding: 40px;
            width: 100%;
            max-width: 480px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
            animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        h1 {
            font-size: 2rem;
            font-weight: 800;
            text-align: center;
            margin-bottom: 8px;
            background: linear-gradient(135deg, #a78bfa 0%, #60a5fa 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.5px;
        }

        p.subtitle {
            text-align: center;
            color: #94a3b8;
            font-size: 0.95rem;
            margin-bottom: 32px;
            font-weight: 300;
        }

        .form-group {
            margin-bottom: 24px;
            display: flex;
            flex-direction: column;
        }

        label {
            font-size: 0.85rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
            color: #a78bfa;
            transition: color 0.3s;
        }

        .input-wrapper {
            position: relative;
        }

        input {
            width: 100%;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 14px 16px;
            border-radius: 12px;
            color: #fff;
            font-size: 1rem;
            font-weight: 400;
            outline: none;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        input:focus {
            border-color: #8b5cf6;
            box-shadow: 0 0 15px rgba(139, 92, 246, 0.25);
            background: rgba(0, 0, 0, 0.4);
        }

        button {
            width: 100%;
            background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
            border: none;
            padding: 16px;
            border-radius: 12px;
            color: white;
            font-size: 1.05rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);
            margin-top: 8px;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(139, 92, 246, 0.5);
            filter: brightness(1.1);
        }

        button:active {
            transform: translateY(1px);
        }

        .toast {
            position: fixed;
            bottom: -100px;
            left: 50%;
            transform: translateX(-50%);
            padding: 16px 28px;
            border-radius: 12px;
            font-weight: 600;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
            z-index: 100;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .toast.show {
            bottom: 30px;
        }

        .toast-success {
            background: #10b981;
            color: #fff;
        }

        .toast-error {
            background: #ef4444;
            color: #fff;
        }
    </style>
</head>
<body>
    <div class="blob blob-1"></div>
    <div class="blob blob-2"></div>

    <div class="container">
        <h1>Novo Jogo</h1>
        <p class="subtitle">Cadastre os detalhes do jogo no banco do PayldrGames</p>

        <form id="gameForm">
            <div class="form-group">
                <label for="nome">Nome do Jogo</label>
                <div class="input-wrapper">
                    <input type="text" id="nome" name="nome" placeholder="Ex: Ikemen GO" required>
                </div>
            </div>

            <div class="form-group">
                <label for="url">URL do Jogo</label>
                <div class="input-wrapper">
                    <input type="url" id="url" name="url" placeholder="Ex: https://..." required>
                </div>
            </div>

            <div class="form-group">
                <label for="imagem">URL da Imagem</label>
                <div class="input-wrapper">
                    <input type="url" id="imagem" name="imagem" placeholder="Ex: https://.../capa.jpg" required>
                </div>
            </div>

            <button type="submit">Cadastrar Jogo</button>
        </form>
    </div>

    <div id="toast" class="toast"></div>

    <script>
        const form = document.getElementById('gameForm');
        const toast = document.getElementById('toast');

        function showToast(message, type = 'success') {
            toast.innerText = message;
            toast.className = 'toast show ' + (type === 'success' ? 'toast-success' : 'toast-error');
            setTimeout(() => {
                toast.className = 'toast';
            }, 3000);
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = form.querySelector('button');
            submitBtn.disabled = true;
            submitBtn.innerText = 'Enviando...';

            const payload = {
                nome: document.getElementById('nome').value,
                url: document.getElementById('url').value,
                imagem: document.getElementById('imagem').value
            };

            try {
                const response = await fetch('/payldr/jogos/cadastro', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();
                if (response.ok && result.sucesso) {
                    showToast('Jogo cadastrado com sucesso!', 'success');
                    form.reset();
                } else {
                    showToast(result.mensagem || 'Erro ao cadastrar jogo', 'error');
                }
            } catch (err) {
                showToast('Erro de rede ao conectar ao servidor', 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Cadastrar Jogo';
            }
        });
    </script>
</body>
</html>
    `);
});

app.post('/payldr/jogos/cadastro', (req, res) => {
    const { nome, url, imagem } = req.body;
    if (!nome || !url || !imagem) {
        return res.status(400).json({ sucesso: false, mensagem: 'Preencha todos os campos.' });
    }

    try {
        const stmt = db.prepare('INSERT INTO jogos (nome, url, imagem) VALUES (?, ?, ?)');
        const info = stmt.run(nome, url, imagem);
        return res.status(200).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (err) {
        console.error('Erro ao cadastrar jogo no SQLite:', err.message);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao salvar no banco.' });
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
