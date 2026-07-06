import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurações da cópia
// Chave OpenSSH do usuário (compatível com scp)
const keyPath = `"C:\\Users\\gilla\\OneDrive\\Área de Trabalho\\marketpix\\Oracle\\ssh-key-2021-12-10.key"`;

const localFile = path.join(__dirname, 'payldr.js');
const localPackage = path.join(__dirname, 'package.json');
const localHtml = path.join(__dirname, 'cadastro.html');
const localDb = path.join(__dirname, 'db.js');
const remoteDestDir = 'ubuntu@144.22.213.47:/home/ubuntu/dev/payldr/';

// Comando SCP de etapa única para múltiplos arquivos
const scpCommand = `scp -i ${keyPath} "${localFile}" "${localPackage}" "${localHtml}" "${localDb}" ${remoteDestDir}`;

// Comandos SSH
const npmInstallCommand = `ssh -i ${keyPath} ubuntu@144.22.213.47 "cd /home/ubuntu/dev/payldr && sudo npm install"`;
const pm2RestartCommand = `ssh -i ${keyPath} ubuntu@144.22.213.47 "sudo pm2 restart all"`;

console.log(`Iniciando transferência dos arquivos (payldr.js, package.json, cadastro.html, db.js) via SCP...`);
console.log(`Executando: ${scpCommand}\n`);

exec(scpCommand, (scpError, scpStdout, scpStderr) => {
  if (scpError) {
    console.error(`❌ Erro na transferência de arquivos via SCP: ${scpError.message}`);
    console.error(`Detalhes: ${scpStderr}`);
    return;
  }
  console.log('✅ Todos os arquivos foram copiados com sucesso em uma única etapa!');

  console.log('\n🔄 Iniciando instalação das dependências (npm install) no servidor...');
  console.log(`Executando remoto: ${npmInstallCommand}\n`);

  exec(npmInstallCommand, (npmError, npmStdout, npmStderr) => {
    if (npmError) {
      console.error(`❌ Erro ao instalar dependências no servidor: ${npmError.message}`);
      console.error(`Detalhes: ${npmStderr}`);
      return;
    }
    if (npmStderr) {
      console.log(`Aviso do npm: ${npmStderr}`);
    }
    console.log(`Saída do npm install:\n${npmStdout}`);
    console.log('✅ Dependências instaladas com sucesso!');

    console.log('\n🔄 Reiniciando os processos no servidor com PM2...');
    console.log(`Executando remoto: ${pm2RestartCommand}\n`);

    exec(pm2RestartCommand, (pm2Error, pm2Stdout, pm2Stderr) => {
      if (pm2Error) {
        console.error(`❌ Erro ao reiniciar PM2 no servidor: ${pm2Error.message}`);
        console.error(`Detalhes: ${pm2Stderr}`);
        return;
      }
      if (pm2Stderr) {
        console.log(`Aviso do PM2: ${pm2Stderr}`);
      }
      console.log(`Saída do PM2:\n${pm2Stdout}`);
      console.log('✅ Deploy e reinício do servidor concluídos com sucesso!');
    });
  });
});
