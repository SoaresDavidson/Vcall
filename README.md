<p align="center">
  <img src="public/assets/logo-wordmark.png" alt="Vcall" width="380">
</p>

<p align="center">
  <b>Chamadas de vídeo diretas de um computador para o outro — criptografadas, sem conta e sem intermediário.</b>
</p>

<p align="center">
  <a href="https://github.com/victor-kauan-coder/Vcall/releases/latest"><img alt="Baixar" src="https://img.shields.io/github/v/release/victor-kauan-coder/Vcall?label=baixar&color=dd2f6b"></a>
  <a href="https://github.com/victor-kauan-coder/Vcall/actions/workflows/ci.yml"><img alt="Testes" src="https://github.com/victor-kauan-coder/Vcall/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/victor-kauan-coder/Vcall/wiki"><img alt="Wiki" src="https://img.shields.io/badge/wiki-documentação-453c72"></a>
</p>

<p align="center">
  <img src="docs/wiki/imagens/painel-claro.png" alt="Painel inicial do Vcall" width="820">
</p>

Salas de vídeo em malha ponto a ponto, criptografadas fim a fim, com
compartilhamento de tela e de janelas, canvas colaborativo infinito, legendas,
moderação e aplicativo para Windows e Linux.

O servidor apresenta os participantes uns aos outros e para por aí. Áudio,
vídeo, tela, canvas e arquivos vão direto de um computador ao outro, cifrados
por DTLS-SRTP; o texto do chat passa pela sinalização sem ser guardado. Nenhum
conteúdo de conversa fica em disco.

## Baixar

| Sistema | Arquivo |
| --- | --- |
| Windows 10/11 | `VcallSetup-3.19.0.exe` |
| Fedora, openSUSE, RHEL | `Vcall-3.19.0-x86_64.rpm` |
| Arch, Manjaro, EndeavourOS | `Vcall-3.19.0-x64.pacman` |
| Ubuntu, Debian, Mint, Pop!_OS | `Vcall-3.19.0-amd64.deb` |
| Qualquer Linux | `Vcall-3.19.0-x86_64.AppImage` ou `.tar.gz` |

Tudo em **[Releases](https://github.com/victor-kauan-coder/Vcall/releases/latest)** ·
passo a passo na **[wiki](https://github.com/victor-kauan-coder/Vcall/wiki/Instalacao)** ·
o que mudou na **[3.19.0](docs/release/v3.19.0.md)**.

## Recursos

- Vídeo, voz e tela ponto a ponto, até 16 pessoas, sem conta e sem limite de tempo
- **Voz que aguenta rede ruim**: redundância (RED), FEC e DTX no Opus
- **Relé**: se a conexão direta entre duas pessoas cai, uma terceira repassa; quem tem internet fraca manda o vídeo uma vez só, para um computador forte da sala
- **Servidor TURN nas configurações** do app, com botão Testar, para quem está no 4G ou na rede da empresa
- Compartilhar **uma janela** ou a tela inteira, com nitidez ou fluidez
- Canvas colaborativo infinito e anotação sobre a tela
- **Jogos**: Desenha e Adivinha, Stop!, Quiz, Mímica, Quem sou eu?, Roda de perguntas, Duas verdades e uma mentira, Palavras-código, Jogo da velha, Lig 4, Forca, Jogo da memória, Roleta e dados, e os de equipe (Planning Poker, Retrospectiva, Daily)
- **Reações e sinais**: reações com combo e chuva; sinais que ficam no quadrinho (Sim, Não, Mais devagar, Não estou ouvindo, Já volto)
- Chat com arquivos de até 25 MB, entregues inteiros
- Legendas com **Whisper** no app (no seu computador) e **transcrição ao vivo** com busca e .srt
- **Supressão de ruído por IA** e sensibilidade de entrada, como no Discord
- Trocar a janela compartilhada **sem parar** a transmissão
- Moderação: silenciar, remover, trancar a sala, **sala de espera**, fila de mãos
- Convite clicável no **WhatsApp** que abre direto no app
- Link pela sua rede **Tailscale**: privado, com HTTPS, e um caminho a mais para a mídia em redes que bloqueiam a conexão direta
- **Chamadas ativas de toda a rede Tailscale** na tela inicial, chamadas "Na minha rede" e criar chamadas pelo celular
- **Foco na voz** (quem fala acende, quem está calado apaga) e **modo jogo** com sobreposição e atalhos globais
- **Dois visuais**: o Vcall de sempre ou o **Empresa**, sóbrio como Teams e Meet, com a mesma paleta e a troca na hora
- App para **Windows** e **Linux** (AppImage, .deb, .rpm, pacman, .tar.gz)

<p align="center">
  <img src="docs/wiki/imagens/moderacao.png" alt="Chamada com moderação" width="820">
</p>

> **Só quer rodar?** Veja **[COMECE-AQUI.md](COMECE-AQUI.md)** — são dois
> comandos. Este README é para quem vai mexer no código.

---

## Rodando

```bash
npm install        # 1 pacote, menos de um segundo
npm start          # http://localhost:3000
```

Para desenvolver, instale também as ferramentas (ícones, avatares, testes):

```bash
npm install --include=dev
npm run dev        # recarrega o servidor a cada alteração
npm test           # estática + servidor + dois navegadores + interface + túnel
npm run vendor     # regenera o sprite de ícones e o pacote de avatares
```

As devDependencies ficam desativadas por padrão (`.npmrc` com `omit=dev`)
porque uma delas baixa navegadores, e nada disso é necessário para rodar: os
ícones e avatares já vêm gerados em `public/vendor/`.

Câmera, microfone e captura de tela só funcionam em **HTTPS** ou em
`localhost` — é uma exigência do navegador, não do aplicativo.

### Deixando outras pessoas entrarem

O jeito mais rápido é um túnel, que já resolve o HTTPS:

```bash
npm start
cloudflared tunnel --url http://localhost:3000
```

O túnel carrega a página e a sinalização. A mídia continua indo direto de um
navegador ao outro, fora dele — por isso **o túnel não substitui o TURN**.
Detalhes e verificação em **[TUNEL.md](TUNEL.md)**.

---

## Configuração

**O `.env` é opcional.** Sem nenhuma configuração o sistema sobe e funciona em
`localhost` — só não terá TURN, o que faz diferença quando alguém entra de uma
rede corporativa ou de 4G.

Para configurar, copie o exemplo e edite:

```bash
cp .env.example .env          # Linux e macOS
copy .env.example .env        # Windows
```

O `npm start` lê esse arquivo sozinho (`--env-file-if-exists`), e ignora se ele
não existir. Variáveis exportadas no ambiente têm precedência — útil em Docker,
Railway, Render e afins, onde você define tudo no painel e não usa `.env`.

Tudo é configurável por variável de ambiente; nada precisa ser editado no
código.

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `PORT` | `3000` | Porta do servidor |
| `MAX_PEERS` | `8` | Participantes por sala |
| `TURN_URLS` | — | Endereços do TURN, separados por vírgula |
| `TURN_SECRET` | — | Segredo compartilhado do coturn (`use-auth-secret`) |
| `TURN_USER` / `TURN_PASS` | — | Alternativa com senha fixa (só para testar) |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | — | Cloudflare Realtime TURN |
| `TURN_API_URL` / `TURN_API_TOKEN` | — | Provedor que entrega `iceServers` por REST (Metered, Xirsys…) |
| `TURN_TTL` | `21600` | Validade das credenciais temporárias, em segundos |
| `STUN_URLS` | STUN do Google | Servidores STUN |
| `ICE_TRANSPORT_POLICY` | `all` | `relay` força o uso do TURN (útil para testar) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Sobre o TURN

Sem TURN, cerca de 8 a 15% das chamadas simplesmente **não conectam**: redes
corporativas, CGNAT de operadora móvel e firewalls simétricos bloqueiam a
conexão direta, e o STUN sozinho não resolve.

**Dá para resolver de graça, e bem.** Duas opções sem custo:

```bash
# 1. Metered Open Relay — 20 GB/mês grátis, cinco minutos de configuração
TURN_API_URL="https://SEUAPP.metered.live/api/v1/turn/credentials?apiKey=CHAVE" npm start

# 2. coturn próprio — de graça no Oracle Cloud Always Free (10 TB/mês de
#    saída, região em São Paulo). É a melhor opção: qualidade de produção,
#    custo zero. O servidor gera credenciais que expiram; o segredo nunca
#    chega ao navegador.
TURN_URLS="turn:turn.exemplo.com:3478?transport=udp,turns:turn.exemplo.com:5349" \
TURN_SECRET=$(openssl rand -hex 32) npm start
```

Evite `TURN_USER`/`TURN_PASS` em produção: o `/ice` é público, então uma senha
fixa ali vira um relay aberto às suas custas.

**[TURN.md](TURN.md)** traz o passo a passo completo: Oracle Always Free,
Metered, instalação do coturn,
`turnserver.conf` comentado, certificado TLS, firewall, como testar e o que
fazer quando não funciona.

---

## Arquitetura

```
server.js                 entrada: HTTP + sinalização
src/
  config.js               configuração
  ice.js                  STUN/TURN e credenciais temporárias
  http.js                 arquivos estáticos, CSP, compressão, cache
  protocol.js             contrato de sinalização e validação
  rooms.js                registro de salas em memória
  signaling.js            servidor WebSocket
  logger.js
public/
  index.html
  css/   tokens · base · app · board
  js/
    lib/     dom · emitter · util
    core/    signaling · peer · mesh · media · screen · tuning · stats · vad · audio-graph
    ui/      theme · lobby · stage · panel · dock · avatars · audio · photo · toast
    features/whiteboard
  vendor/  icons.svg (Lucide) · avatars.js (DiceBear)
scripts/
  vendor.mjs      gera o sprite de ícones e o pacote de avatares
  check.mjs       verificação estática
  e2e.mjs         teste com dois navegadores reais
  proxy-test.mjs  teste atrás de um túnel HTTPS
```

A regra de dependência é de mão única: `core/` não conhece o DOM, `ui/` não
conhece WebRTC, e `main.js` é o único lugar onde os dois se encontram. Dá para
testar a lógica de conexão sem uma tela — é o que o `e2e.mjs` faz.

### O caminho da mídia

```
Alice ──── WebSocket (só SDP e ICE) ────► servidor ────► Bruno
  └────────── DTLS-SRTP, áudio/vídeo/tela/dados ──────────┘
```

Numa malha, cada pessoa mantém uma conexão com cada outra. É o que permite
criptografia fim a fim sem servidor de mídia — e é também por isso que o limite
é de 8 participantes: com N pessoas, cada uma codifica o vídeo N−1 vezes.
Passar disso exige um SFU no meio, e aí a conversa deixa de ser fim a fim.

---

## Como o compartilhamento de tela foi resolvido

Este era o ponto que não funcionava. As causas, e o que foi feito:

**1. Renegociação no meio da chamada.** Ligar a tela criava uma linha de mídia
nova, o que dispara uma renegociação; quando os dois lados negociavam ao mesmo
tempo, a negociação travava e a tela chegava preta — ou só num sentido.

→ As quatro linhas (microfone, câmera, tela, áudio da tela) são criadas **uma
vez**, antes da primeira oferta. Ligar e desligar qualquer coisa depois disso é
só `replaceTrack`: sem linha nova, sem renegociação, sem conflito.

**2. Linhas órfãs.** Pela especificação, uma linha criada com `addTransceiver`
nunca é reaproveitada para casar com uma linha da oferta remota. Com os dois
lados criando as suas, cada navegador terminava com oito linhas — quatro
enviando para o vazio.

→ Só quem oferta cria as linhas. Quem responde **adota** as que chegaram na
oferta e vira a direção para `sendrecv` antes de montar a resposta. Resultado:
quatro linhas, os mesmos identificadores nas duas pontas, uma única negociação.
O teste automatizado verifica isso.

**3. O encoder achatando o texto.** O padrão do navegador é encolher a imagem
quando a banda aperta — péssimo para código e slides, que ficam ilegíveis.

→ `contentHint = "text"` e `degradationPreference = "maintain-resolution"`:
a resolução é preservada e o que cai é a taxa de quadros. Quem compartilha
vídeo ou animação troca para o perfil de movimento, que faz o inverso. Os
parâmetros são **reaplicados a cada negociação concluída**, porque o Chrome os
zera quando alguém entra ou sai da sala.

**4. Codec errado.** VP9 custa cerca de metade da banda de VP8 e H.264 para o
mesmo texto a 1080p.

→ Todos os codecs ficam negociados na linha da tela, e cada um escolhe o seu
na hora de compartilhar (`encodings[0].codec`, sem renegociar): AV1 ou VP9
quando a placa de vídeo codifica por hardware; sem isso, H.264 para vídeo e
jogo e VP9 para texto. A lista mantém `rtx` — removê-la desliga a
retransmissão e produz exatamente o congelamento que se estava tentando evitar.

**5. Orçamento de banda.** Cada conexão estima a banda sozinha e não sabe das
outras. Numa malha, todas tentam ocupar o mesmo enlace de subida ao mesmo
tempo.

→ Há um teto central, dividido pelo número de participantes, e um controle
adaptativo que lê o `getStats` a cada dois segundos: desce rápido quando falta
banda ou sobra carga de CPU, sobe devagar. A tela tem prioridade alta e a
câmera baixa, senão o alocador reparte igual e a tela some. Dois cuidados: a
dois não há teto (a estimativa do Chrome não passa muito do que já se envia, e
usá-la como teto prendia a tela), e `qualityLimitationReason: "bandwidth"` só
conta como rede cheia quando a estimativa não cobre o teto — o Chrome dá o
mesmo motivo quando o próprio encoder encolhe a imagem.

**7. Preso em 30 qps.** Sem pedir, a captura sai a 30 quadros por segundo e a
conexão começa estimando 300 kbps.

→ A captura pede 120 qps, o máximo do Chromium: ela não passa da taxa do
monitor nem repete quadro, então um monitor de 60 Hz dá 60 e um de 120 ou 144
Hz dá 120. A dois, vídeo e jogo começam em 60 e sobem até 120 qps (e 14 Mbps)
quando a conexão passa de ~8 Mbps: com menos, 1080p120 congelava a imagem.
Texto e câmera param em 60, e com mais gente tudo volta a no máximo 60. A conexão começa em
1,5 Mbps (`x-google-start-bitrate`), e a câmera já nasce em 720p em vez de 180p. O relé
que repete o último quadro da tela parada roda num worker: na thread da
página, cada engasgo da interface custava quadros.

**6. Detalhes que quebram na prática.** `min` e `exact` são proibidos nas
restrições de captura; o Firefox ignora `frameRate` na captura mas aceita na
trilha; `monitorTypeSurfaces: "exclude"` com `displaySurface: "monitor"` lança
erro; trocar de janela no meio muda a resolução sem encerrar a trilha; e o
`<video>` só deve ser ligado quando a trilha sai de `muted`, senão fica preto
para sempre. Todos estão tratados, com o porquê comentado no código.

---

## O que o sistema faz

**Chamada**

- Antessala com prévia da câmera, escolha de dispositivo, nome e avatar
- Até 8 participantes, malha P2P criptografada
- Destaque automático: a tela compartilhada ou quem está falando
- Fixar participante, tela cheia por ladrilho, grade igualitária
- Reconexão automática: reinício de ICE com período de tolerância e recuo
  progressivo, mais reconexão da sinalização

**Compartilhamento de tela**

- Perfis de nitidez (texto/código/slides) e de fluidez (vídeo/animação)
- Até 1080p a 60 quadros por segundo, descendo sozinho com mais gente na sala
- Qualidade selecionável: automática, 1080p até 120 qps, 720p60 para rede fraca, 720p econômica
- Áudio do sistema em trilha própria, sem o processamento de voz que destrói música
- Anotação colaborativa por cima da tela

**Quadro branco**

- Caneta, marca-texto, linha, seta, retângulo, elipse, texto, borracha
- Ponteiro laser com o nome e a cor de quem aponta
- Vetorial: desfazer por autor, nitidez em qualquer tela, exportação em PNG
- Coordenadas normalizadas — todos veem a mesma coisa no mesmo lugar,
  do monitor de 27" ao celular
- Sincronizado pelo canal de dados P2P; o servidor só entra como plano B
- Traço transmitido enquanto é desenhado, não só no final

**Jogos de equipe** ([wiki](docs/wiki/Jogos-de-equipe.md))

- Planning Poker com votos escondidos até revelar, média, mediana,
  concordância, histórias com estimativa, CSV, cronômetro, revelação
  automática, espectador e cinco baralhos (inclui o voto de confiança)
- Retrospectiva em três fases (escrever às cegas, votar com 3 pontos,
  discutir), quatro modelos, plano de ação e exportação em Markdown
- Daily com ordem sorteada e o mesmo tempo para cada pessoa
- Estado compartilhado em mapa LWW com relógio de Lamport: converge com
  mensagens fora de ordem ou repetidas, e quem chega no meio recebe tudo; o
  voto só sai do computador de quem votou na hora de revelar

**Qualidade**

- A câmera sobe para a resolução que a banda permite: o codificador escolhia
  a resolução pela estimativa do começo da chamada e nunca a revisava
- Tela parada não pisca: o vídeo segura o último quadro enquanto a trilha
  recebida fica "muda" entre um quadro repetido e outro
- Rota da mídia no painel: direta, direta pela rede Tailscale, ou via TURN
  ([wiki](docs/wiki/Tailscale.md))
- Indicador de rede por participante, no próprio ladrilho
- Painel com latência, perda, banda, resolução real enviada e recebida, codec,
  custo de codificação, congelamentos e rota (direta ou via TURN)
- Detecção de quem está falando: contorno no ladrilho e barra de intensidade
  ao lado do nome, com histerese para o destaque não piscar
- Supressão de ruído e cancelamento de eco, desligáveis para música

**Conversa e presença**

- Volume por participante, de 0 a 150%, direto no quadradinho de cada um
- Volume geral e escolha de alto-falante nas configurações
- Foto de perfil própria (recortada e comprimida no navegador) ou avatar gerado
- Chat com agrupamento por autor e links clicáveis
- Levantar a mão, reações
- Lista de pessoas com estado de cada uma
- Anfitrião com sucessão automática

**Interface**

- Tema claro e escuro derivados da paleta da marca, além do modo do sistema
- Ícones SVG do [Lucide](https://lucide.dev) e avatares SVG do
  [DiceBear](https://dicebear.com) — nenhum emoji, nenhum ícone improvisado
- Atalhos: `M` microfone · `V` câmera · `S` tela · `Q` quadro · `K` jogos ·
  `H` mão · `C` conversa · `P` pessoas · `L` layout · `Espaço` falar enquanto
  pressiona
- Responsivo de verdade: em telas estreitas o essencial fica na barra e o resto
  vai para o menu "mais"

---

## Privacidade e segurança

- Mídia e dados são cifrados fim a fim (DTLS-SRTP). O servidor não tem as chaves.
- O identificador da sala tem 128 bits aleatórios e vive no fragmento da URL —
  a parte depois do `#`, **que o navegador nunca envia ao servidor**.
- Salas existem só em memória e desaparecem com o último participante.
- Avatares trafegam como `{estilo, semente}` e são desenhados no navegador;
  nenhuma imagem é enviada.
- CSP fechada: nenhum script, fonte ou conexão externa. É por isso que ícones e
  avatares são servidos localmente.
- Toda mensagem de sinalização é validada e limitada em tamanho e frequência.
- O texto do chat é inserido como nó de texto, nunca como HTML.

Limite conhecido: o servidor de sinalização vê quem está em qual sala e quando.
Ele não vê o conteúdo de nada.

---

## Testes

```bash
npm run check                 # estático + servidor + correções da 3.1 (segundos)
node scripts/fixes-test.mjs   # servidor real: senha, reconexão, moderação, sala de espera…
node scripts/e2e.mjs          # dois navegadores de verdade
node scripts/ui-test.mjs      # 58 verificações clicando na interface
node scripts/proxy-test.mjs   # atrás de um túnel HTTPS
xvfb-run -a sh -c 'openbox & node scripts/desktop-test.mjs'   # app de mesa (Linux)
CHROMIUM_PATH=/caminho/do/chrome node scripts/e2e.mjs
```

Tudo roda no GitHub Actions a cada push (`.github/workflows/ci.yml`); o
`release.yml` gera os instaladores de Windows e Linux e publica a Release.
Detalhes em [Para desenvolvedores](docs/wiki/Para-desenvolvedores.md).

O teste de ponta a ponta sobe o servidor, abre dois navegadores com mídia
falsa, entra na mesma sala e verifica: descoberta, conexão P2P, quadros
chegando nos dois sentidos, ladrilhos montados dos dois lados, compartilhamento
de tela sem criar linha de mídia nova, tela decodificada do outro lado, perfil
de codificação aplicado, quadro branco pelo canal de dados, chat, os dois temas
e a saída limpa de um participante.

---

## Licenças de terceiros

- [Lucide](https://lucide.dev) — ícones, licença ISC
- [DiceBear](https://dicebear.com) — avatares, licença MIT
- [ws](https://github.com/websockets/ws) — WebSocket, licença MIT
- [vosk-browser](https://github.com/ccoreilly/vosk-browser) / [Vosk](https://alphacephei.com/vosk/) — reconhecimento de fala offline, licença Apache-2.0

Os arquivos em `public/vendor/` são gerados por `npm run vendor` a partir
dessas bibliotecas.
