Este é o plano de desenvolvimento estruturado para criar o seu Servidor Relay de Inputs em Go. O objetivo é construir uma arquitetura minimalista, com alocação zero de memória no loop principal (uso mínimo do Garbage Collector) e suporte a Auto-Registro em uma API Central.

📋 Visão Geral da Arquitetura do Pacote UDP

Para manter o processamento do servidor próximo de zero, utilizaremos um cabeçalho binário fixo de 5 bytes no início de cada pacote enviado pelos clientes:

Tamanho	Tipo de Dado	Função
2 Bytes	uint16	ID da Sala (Identifica qual grupo deve receber o dado)
1 Byte	uint8	Player ID (Bits 0..2: 0 a 7) e Channel ID (Bits 3..7: 0 a 31)
2 Bytes	uint16	Sequence Number / Frame (Controle de ordem para o Rollback local)
Restante	bytes	Payload do Canal (Inputs, Comandos, Chat, Ping, Estado)

Canais Suportados (0 a 31 - total de 32 canais):
- 0x00: INPUT (Inputs de botões e direcionais @ 60 FPS)
- 0x01: COMMAND (Pausa, Coin, Reset, Seleção de jogo)
- 0x02: CHAT (Mensagens de texto in-game)
- 0x03: PING (Medição de RTT / Sincronismo)
- 0x04: STATE (Checksum de sincronia / Detecção de desync)
- 0x05 a 0x1F: Reservados para novos canais livres (voz, lobby, spectator, etc.)


🗺️ Fase 1: Modelagem de Dados e Estrutura das Salas

Como o servidor precisa gerenciar quem está em qual sala de forma assíncrona, utilizaremos estruturas com travas de leitura/escrita (sync.RWMutex) para evitar condições de corrida (race conditions).
1. Definição da Entidade Jogador (Player):
	• Armazenar o endereço de rede (*net.UDPAddr).
	• Armazenar o ID numérico do jogador (uint8).
	• Armazenar o timestamp do último pacote recebido (para limpeza por timeout).
2. Definição da Entidade Sala (Room):
	• Lista ou array fixo de até 4 jogadores.
	• Mutex exclusivo por sala para não travar o servidor inteiro quando uma sala for modificada.
3. Gerenciador Global de Salas (RoomManager):
	• Um mapa em Go (map[uint16]*Room) mapeando o ID da sala para a estrutura correspondente.

🚀 Fase 2: O Loop UDP de Alta Performance (Alocação Zero)

Esta é a alma do servidor. O loop escuta uma única porta UDP e despacha os bytes sem gerar lixo para o GC.
1. Inicialização do sync.Pool:
	• Pré-alocar arrays de bytes de tamanho fixo (ex: 256 bytes) para reutilização contínua.
2. Loop Principal (ReadFromUDP):
	• Pegar um buffer do pool.
	• Ler o pacote vindo da rede.
	• Extrair os primeiros 3 bytes (ID da Sala e ID do Jogador) usando operações de bit (bit shifting) ou o pacote encoding/binary.
3. Rotina de Encaminhamento Rápido:
	• Buscar a sala correspondente no RoomManager.
	• Iterar pelos jogadores ativos daquela sala.
	• Disparar WriteToUDP diretamente para os endereços dos outros jogadores, ignorando o IP de origem.
	• Devolver o buffer original para o sync.Pool.

🌐 Fase 3: Auto-Registro e Ciclo de Vida (Heartbeat)

Para permitir a descoberta geográfica de servidores, o relay precisa interagir com a sua API Central de Matchmaking.
1. Rotina de Inicialização (Boot):
	• O servidor inicia, lê suas configurações (Porta UDP, Região, URL da API Central).
	• Faz uma requisição HTTP POST para a API Central notificando sua presença:json
{ "ip": "186.X.X.X", "port": 8080, "region": "sa-east-1" }
Use code with caution.
2. Mecanismo de Vida (Heartbeat Go-routine):
	• Criar um ticker em Go (time.NewTicker) que dispara a cada 10 segundos.
	• Envia um sinal leve de "estou vivo" para a API Central.
3. Limpeza Local Contínua (Garbage Collection de Conexões):
	• Criar uma rotina paralela que varre o mapa de salas a cada poucos segundos.
	• Se um jogador não enviar inputs por mais de 5 segundos, ele é removido da sala automaticamente para liberar espaço.