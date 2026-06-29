import fetch from 'cross-fetch';
import dotenv from 'dotenv';
dotenv.config({ path: 'payldr.env' });

const url = process.env.TEST_URL || 'http://localhost';
const port = process.env.TEST_PORT || '9710';
const hostId = process.env.TEST_HOST_ID || 'test-host-123';
const guestId = process.env.TEST_GUEST_ID || 'test-guest-456';
const baseUrl = `${url}:${port}`;

async function sendTestPayload() {
    const payloadContent = process.argv.slice(2).join(' ') || 'Olá Mundo! Teste de payload p2p';
    
    console.log(`\n\x1b[34m[Guest]\x1b[0m Iniciando envio de payload...`);
    console.log(`\x1b[34m[Guest]\x1b[0m Hoster de Destino: \x1b[33m${hostId}\x1b[0m`);
    console.log(`\x1b[34m[Guest]\x1b[0m ID do Guest: \x1b[33m${guestId}\x1b[0m`);
    console.log(`\x1b[34m[Guest]\x1b[0m Payload a ser enviado: \x1b[32m"${payloadContent}"\x1b[0m`);
    console.log(`\x1b[34m[Guest]\x1b[0m Enviando POST para: \x1b[35m${baseUrl}/payldr/guest/send\x1b[0m\n`);
    
    try {
        const response = await fetch(`${baseUrl}/payldr/guest/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                guestId: guestId,
                hostId: hostId,
                payload: payloadContent
            })
        });
        
        const result = await response.json();
        
        console.log(`\x1b[34m[Guest - Resposta Recebida]\x1b[0m`);
        console.log(JSON.stringify(result, null, 2));
        
        if (result.sucesso) {
            console.log(`\n\x1b[32m[Guest - Sucesso]\x1b[0m Comunicação de ponta a ponta concluída!`);
        } else {
            console.log(`\n\x1b[31m[Guest - Falha]\x1b[0m Ocorreu um problema: ${result.mensagem}`);
        }
    } catch (error) {
        console.error(`\n\x1b[31m[Guest - Erro]\x1b[0m Falha na requisição:`, error.message);
    }
}

sendTestPayload();
