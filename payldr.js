import dotenv from "dotenv"
import cors from "cors"
import express from "express"
import fetch from "cross-fetch"
import tls from "tls"

dotenv.config({ path: 'payldr.env' })
let PORT = process.env.API_PORT || 9610;
let ENVIRONMENT = (process.env.ENVIRONMENT || 'LOCAL').toUpperCase();

let server = null;
let app = express();
app.use(cors());
app.use(express.json({ extended: true }));

const generateId = (len = 10) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const hosters = {};
const pendingRequests = {};

setInterval(() => {
    for (const hostId in hosters) {
        try {
            hosters[hostId].write(': ping\n\n');
        } catch (e) {
            delete hosters[hostId];
        }
    }
}, 20000);

app.get('/payldr/hoster/:hostId', (req, res) => {
    const { hostId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    hosters[hostId] = res;
    console.log(`Hoster ligado: ${hostId}`);

    res.write(`data: ${JSON.stringify({ tipo: 'SISTEMA', mensagem: `Ligado como ${hostId}` })}\n\n`);

    req.on('close', () => {
        console.log(`Hoster desligado: ${hostId}`);
        delete hosters[hostId];
    });
});

app.post('/payldr/visitor/send', (req, res) => {
    const { visitorId, hostId, payload } = req.body;

    if (!visitorId || !hostId || !payload) {
        return res.status(200).json({ sucesso: false, mensagem: 'Campos incompletos.' });
    }

    const hostRes = hosters[hostId];
    if (!hostRes) {
        return res.status(200).json({ sucesso: false, mensagem: 'Hoster offline ou não encontrado.' });
    }

    const requestId = generateId(10);

    pendingRequests[requestId] = res;

    req.on('close', () => {
        if (pendingRequests[requestId]) {
            delete pendingRequests[requestId];
        }
    });

    const evento = {
        requestId,
        origem: visitorId,
        dados: payload,
        timestamp: new Date().toISOString()
    };

    hostRes.write(`data: ${JSON.stringify(evento)}\n\n`);

    setTimeout(() => {
        if (pendingRequests[requestId]) {
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

    const visitorRes = pendingRequests[requestId];

    if (!visitorRes) {
        return res.status(200).json({
            sucesso: false,
            mensagem: 'A requisição expirou, foi cancelada ou não existe.'
        });
    }

    visitorRes.status(200).json({
        sucesso: true,
        origem: 'hoster',
        dados: responseData
    });

    delete pendingRequests[requestId];
    res.status(200).json({ sucesso: true, mensagem: 'Entregue.' });
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
            const secureContext = tls.createSecureContext({
                key: certData.priv,
                cert: certData.cert
            });
            server.setSecureContext(secureContext);
            console.log("Certificados SSL atualizados dinamicamente com sucesso!");
        } catch (error) {
            console.error("Falha ao renovar o certificado SSL automaticamente:", error.message);
        }
    }, 24 * 60 * 60 * 1000);
}

startAsync();
