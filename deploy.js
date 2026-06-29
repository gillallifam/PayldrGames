import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurações da cópia
// Chave OpenSSH do usuário (compatível com scp)
const keyPath = `"C:\\Users\\gilla\\OneDrive\\Área de Trabalho\\marketpix\\Oracle\\ssh-key-2021-12-10.key"`;
const localFile = path.join(__dirname, 'payldr.js');
const remoteDest = 'ubuntu@144.22.213.47:/home/ubuntu/dev/payldr/payldr.js';

// Comando SCP usando a ferramenta nativa
const scpCommand = `scp -i ${keyPath} "${localFile}" ${remoteDest}`;

// Comando SSH para reiniciar o PM2 usando privilégios de root (já que o PM2 do servidor roda sob o usuário root)
const restartCommand = `ssh -i ${keyPath} ubuntu@144.22.213.47 "sudo pm2 restart all"`;

console.log(`Iniciando transferência do arquivo payldr.js via SCP...`);
console.log(`Executando: ${scpCommand}\n`);

exec(scpCommand, (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Erro na transferência: ${error.message}`);
    return;
  }
  if (stderr) {
    console.log(`Aviso do SCP: ${stderr}`);
  }
  console.log(`Saída do SCP: ${stdout}`);
  console.log('✅ Arquivo payldr.js copiado com sucesso!');

  console.log('\n🔄 Iniciando reinício dos processos no servidor com PM2...');
  console.log(`Executando remoto: ${restartCommand}\n`);

  exec(restartCommand, (sshError, sshStdout, sshStderr) => {
    if (sshError) {
      console.error(`❌ Erro ao reiniciar PM2 no servidor: ${sshError.message}`);
      console.error(`Detalhes: ${sshStderr}`);
      return;
    }
    if (sshStderr) {
      console.log(`Aviso do SSH: ${sshStderr}`);
    }
    console.log(`Saída do PM2:\n${sshStdout}`);
    console.log('✅ Deploy e reinício do servidor concluídos com sucesso!');
  });
});
