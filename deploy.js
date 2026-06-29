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

const localPackage = path.join(__dirname, 'package.json');
const remoteDestPackage = 'ubuntu@144.22.213.47:/home/ubuntu/dev/payldr/package.json';

// Comandos SCP
const scpCommand = `scp -i ${keyPath} "${localFile}" ${remoteDest}`;
const scpPackageCommand = `scp -i ${keyPath} "${localPackage}" ${remoteDestPackage}`;

// Comandos SSH separados
const npmInstallCommand = `ssh -i ${keyPath} ubuntu@144.22.213.47 "cd /home/ubuntu/dev/payldr && sudo npm install"`;
const pm2RestartCommand = `ssh -i ${keyPath} ubuntu@144.22.213.47 "sudo pm2 restart all"`;

console.log(`Iniciando transferência do arquivo package.json via SCP...`);
console.log(`Executando: ${scpPackageCommand}\n`);

exec(scpPackageCommand, (packageError, packageStdout, packageStderr) => {
  if (packageError) {
    console.error(`❌ Erro na transferência do package.json: ${packageError.message}`);
    return;
  }
  console.log(`✅ Arquivo package.json copiado com sucesso!`);

  console.log(`\nIniciando transferência do arquivo payldr.js via SCP...`);
  console.log(`Executando: ${scpCommand}\n`);

  exec(scpCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Erro na transferência do payldr.js: ${error.message}`);
      return;
    }
    console.log('✅ Arquivo payldr.js copiado com sucesso!');

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
});
