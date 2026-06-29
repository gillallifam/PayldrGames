import fetch from 'cross-fetch';
import dotenv from 'dotenv';
dotenv.config({ path: 'payldr.env' });

const url = process.env.TEST_URL || 'http://localhost';
const port = process.env.TEST_PORT || '9710';
const hostId = process.env.TEST_HOST_ID || 'test-host-123';
const baseUrl = `${url}:${port}`;

async function startHost() {
    console.log(`\n\x1b[36m[Host]\x1b[0m Iniciando Host com ID: \x1b[33m${hostId}\x1b[0m`);
    console.log(`\x1b[36m[Host]\x1b[0m Conectando em: \x1b[35m${baseUrl}/payldr/hoster/${hostId}\x1b[0m`);
    
    try {
        const response = await fetch(`${baseUrl}/payldr/hoster/${hostId}`);
        if (!response.ok) {
            throw new Error(`Erro na conexão: ${response.status} ${response.statusText}`);
        }
        
        console.log(`\x1b[32m[Host]\x1b[0m Conexão estabelecida com sucesso! Aguardando requisições...\x1b[0m`);

        const reader = response.body;
        reader.setEncoding('utf8');
        
        let buffer = '';
        reader.on('data', async (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Mantém a última linha incompleta no buffer
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();
                    try {
                        const event = JSON.parse(dataStr);
                        
                        if (event.tipo === 'SISTEMA') {
                            console.log(`\x1b[36m[Host - Sistema]\x1b[0m ${event.mensagem}`);
                            continue;
                        }
                        
                        if (event.requestId) {
                            console.log(`\n\x1b[32m[Host - Requisição Recebida]\x1b[0m`);
                            console.log(`  ID Requisição: \x1b[33m${event.requestId}\x1b[0m`);
                            console.log(`  Origem (Guest): \x1b[33m${event.origem}\x1b[0m`);
                            console.log(`  Payload: \x1b[32m"${event.dados}"\x1b[0m`);
                            console.log(`  Timestamp: ${event.timestamp}`);
                            
                            // Responder à requisição
                            const replyPayload = {
                                requestId: event.requestId,
                                responseData: {
                                    status: 'sucesso',
                                    mensagem: `Host processou o payload "${event.dados}" com sucesso!`,
                                    timestamp: new Date().toISOString()
                                }
                            };
                            
                            console.log(`\x1b[36m[Host]\x1b[0m Enviando resposta para /payldr/reply...`);
                            
                            const replyRes = await fetch(`${baseUrl}/payldr/reply`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(replyPayload)
                            });
                            
                            const replyResult = await replyRes.json();
                            console.log(`\x1b[36m[Host]\x1b[0m Confirmação de entrega:`, replyResult.sucesso ? `\x1b[32mSucesso\x1b[0m` : `\x1b[31mFalha\x1b[0m (${replyResult.mensagem})`);
                        }
                    } catch (e) {
                        // Ignora mensagens que não sejam JSON válidos ou pings
                    }
                }
            }
        });
        
        reader.on('end', () => {
            console.log(`\x1b[31m[Host]\x1b[0m Conexão encerrada pelo servidor. Tentando reconectar em 5 segundos...`);
            setTimeout(startHost, 5000);
        });
        
        reader.on('error', (err) => {
            console.error(`\x1b[31m[Host - Erro no Stream]\x1b[0m`, err.message);
            setTimeout(startHost, 5000);
        });
        
    } catch (error) {
        console.error(`\x1b[31m[Host - Falha de Conexão]\x1b[0m`, error.message);
        console.log(`Tentando reconectar em 5 segundos...`);
        setTimeout(startHost, 5000);
    }
}

startHost();
