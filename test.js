import fetch from 'cross-fetch';
import dotenv from 'dotenv';
dotenv.config({ path: 'payldr.env' });

const url = process.env.TEST_URL || 'http://localhost';
const port = process.env.TEST_PORT || '9710';
const hostId = process.env.TEST_HOST_ID || 'test-host-123';
const guestId = process.env.TEST_GUEST_ID || 'test-guest-456';
const baseUrl = `${url}:${port}`;

async function runDetailedTest() {
    console.log(`\x1b[36;1m==================================================\x1b[0m`);
    console.log(`\x1b[36;1m          INICIANDO TESTE DE FLUXO DETALHADO      \x1b[0m`);
    console.log(`\x1b[36;1m==================================================\x1b[0m`);
    console.log(`\x1b[33mServidor de Destino:\x1b[0m ${baseUrl}`);
    console.log(`\x1b[33mHost ID:\x1b[0m ${hostId}`);
    console.log(`\x1b[33mGuest ID:\x1b[0m ${guestId}\n`);

    let hostConnected = false;
    let sseController = new AbortController();
    
    // Promessa para garantir que o Host terminou de responder antes do Host finalizar
    let hostResponsePromiseResolver;
    const hostResponsePromise = new Promise(resolve => {
        hostResponsePromiseResolver = resolve;
    });

    // --- FASE 1: HOST INICIA ---
    console.log(`\x1b[35m[Fase 1: Host Inicia]\x1b[0m Estabelecendo conexão persistente SSE do Host...`);
    const hostUrl = `${baseUrl}/payldr/hoster/${hostId}`;
    
    let hostResponse;
    try {
        hostResponse = await fetch(hostUrl, { signal: sseController.signal });
        if (!hostResponse.ok) {
            throw new Error(`HTTP ${hostResponse.status} - ${hostResponse.statusText}`);
        }
    } catch (err) {
        console.error(`\x1b[31m[Fase 1 - Falha]\x1b[0m Não foi possível conectar o Host:`, err.message);
        console.log(`Dica: Verifique se o servidor está ativo em ${baseUrl}.`);
        process.exit(1);
    }

    const reader = hostResponse.body;
    reader.setEncoding('utf8');
    let buffer = '';

    // Ouvinte de dados do Host
    reader.on('data', async (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Mantém a linha incompleta no buffer

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                try {
                    const event = JSON.parse(dataStr);

                    if (event.tipo === 'SISTEMA') {
                        console.log(`\x1b[32m[Host]\x1b[0m Conexão confirmada pelo servidor: "${event.mensagem}"`);
                        hostConnected = true;
                        
                        // Passar para a Fase 2 (Guest envia mensagem)
                        runGuestPhase();
                        continue;
                    }

                    if (event.requestId) {
                        // --- FASE 3: HOST RESPONDE ---
                        console.log(`\n\x1b[35m[Fase 3: Host Responde]\x1b[0m Host recebeu requisição com ID \x1b[33m${event.requestId}\x1b[0m`);
                        console.log(`\x1b[32m[Host]\x1b[0m Lendo mensagem do Guest: \x1b[32m"${event.dados}"\x1b[0m`);
                        
                        const replyPayload = {
                            requestId: event.requestId,
                            responseData: {
                                status: 'sucesso',
                                mensagem: `Resposta processada pelo Host para: "${event.dados}"`,
                                timestamp: new Date().toISOString()
                            }
                        };

                        console.log(`\x1b[32m[Host]\x1b[0m Enviando resposta (POST /payldr/reply)...`);
                        const replyRes = await fetch(`${baseUrl}/payldr/reply`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(replyPayload)
                        });
                        const replyResult = await replyRes.json();
                        console.log(`\x1b[32m[Host]\x1b[0m Confirmação de entrega do reply pelo servidor:`, JSON.stringify(replyResult));
                        
                        hostResponsePromiseResolver();
                    }
                } catch (e) {
                    // Ignora pings ou dados inválidos
                }
            }
        }
    });

    // --- FASE 2: GUEST CONECTA / ENVIA MSG ---
    async function runGuestPhase() {
        console.log(`\n\x1b[35m[Fase 2: Guest Conecta/Envia Msg]\x1b[0m Guest conectando e enviando payload (POST /payldr/guest/send)...`);
        
        const payloadData = {
            guestId: guestId,
            hostId: hostId,
            payload: 'Payload do Guest - Teste de Fluxo Completo'
        };

        try {
            const guestRes = await fetch(`${baseUrl}/payldr/guest/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadData)
            });

            // Aguarda a resposta (bloqueado até o Host responder e o servidor retornar)
            const guestResult = await guestRes.json();
            
            // --- FASE 4: GUEST DESCONECTA ---
            console.log(`\n\x1b[35m[Fase 4: Guest Desconecta]\x1b[0m Guest recebeu a resposta do servidor e fechou a requisição.`);
            console.log(`\x1b[34m[Guest]\x1b[0m Dados da Resposta:`);
            console.log(JSON.stringify(guestResult, null, 2));

            // Aguardar a fase de resposta do Host finalizar completamente
            await hostResponsePromise;
            
            // --- FASE 5: HOST FINALIZA ---
            console.log(`\n\x1b[35m[Fase 5: Host Finaliza]\x1b[0m Desconectando Host do Stream SSE...`);
            sseController.abort();
            console.log(`\x1b[32m[Host]\x1b[0m Conexão SSE encerrada.`);
            
            console.log(`\n\x1b[32;1m==================================================\x1b[0m`);
            console.log(`\x1b[32;1m      TESTE DE INTEGRAÇÃO CONCLUÍDO COM SUCESSO    \x1b[0m`);
            console.log(`\x1b[32;1m==================================================\x1b[0m`);
            process.exit(0);
        } catch (err) {
            console.error(`\n\x1b[31;1m[TESTE FALHOU]\x1b[0m Ocorreu um erro no fluxo:`, err.message);
            sseController.abort();
            process.exit(1);
        }
    }

    // Timeout de segurança
    setTimeout(() => {
        if (!hostConnected) {
            console.error(`\n\x1b[31;1m[TESTE FALHOU]\x1b[0m Timeout: Conexão do Host demorou mais de 10s.`);
            sseController.abort();
            process.exit(1);
        }
    }, 10000);
}

runDetailedTest();
