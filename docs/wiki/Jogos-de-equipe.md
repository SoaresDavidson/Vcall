# Jogos de equipe

Três rituais de Scrum dentro da própria chamada, sem abrir outro site, sem
conta e sem convite extra: **Planning Poker**, **Retrospectiva** e **Daily**.
Todo mundo que está na sala já está na mesa.

Para abrir: botão **🎲 Jogos de equipe** na barra (ou tecla **`K`**). Quem
abre avisa a sala: os outros recebem *"Victor abriu o Planning Poker"* com o
botão **Participar**. Os vídeos continuam na faixa ao lado.

Fechar os jogos (o **X** no canto) fecha só para você, e o jogo continua para
os outros. Quem entra no meio recebe tudo como está: histórias, votos já
revelados, notas e a ordem da Daily.

## Planning Poker

![Planning Poker com as cartas viradas](imagens/poker-votando.png)

1. **Histórias**: escreva na lista ao lado e tecle Enter. Dá para colar várias
   de uma vez, uma por linha. Clique numa história para votar nela.
2. **Votar**: escolha uma carta. Clicar de novo na mesma carta tira o voto.
   Os outros veem só que você votou (o verso da carta), nunca o valor.
3. **Revelar cartas**: qualquer pessoa revela. Uma contagem curta (3, 2, 1) e
   as cartas viram para todos ao mesmo tempo.
4. **Resultado**: média, mediana, concordância e um gráfico de quantos votaram
   em cada carta. A carta menor e a maior ficam destacadas, para quem votou
   nelas explicar o porquê. Se todo mundo votou igual, tem confete.
5. **Salvar a estimativa**: clique numa das cartas sugeridas (a destacada é a
   mais perto da média). A estimativa vai para a história e a mesa passa
   sozinha para a próxima.

![Cartas reveladas, com média, mediana e concordância](imagens/poker-revelado.png)

### Opções da mesa

| Opção | O que faz |
| --- | --- |
| **Baralho** | Fibonacci, Fibonacci modificada (½, 20, 40, 100), Tamanhos de camiseta (PP a XGG), Potências de 2 e **Confiança** (punho de 5, para o voto de confiança no fim da sprint) |
| **Auto** | Revela sozinho quando todo mundo votou |
| **Assistir** | Você não conta na votação (bom para o PO ou o Scrum Master) |
| **Cronômetro** | 1, 2, 3 ou 5 minutos de discussão, o mesmo relógio para todos |
| **CSV / Copiar** | Leva as histórias com as estimativas para a planilha ou o Jira |

Passe o mouse sobre alguém na mesa e jogue um emoji 👏🎉😂🤔☕🔥: ele voa do
seu lugar até o da pessoa.

### Histórias do GitHub Projects

No app de mesa, o botão **GitHub** embaixo da lista de histórias traz as US
direto do quadro (kanban) de um GitHub Project:

1. **Conectar**: gere um token clássico no GitHub (o botão **Abrir o GitHub**
   já abre a página com os escopos `project`, `repo` e `read:org` marcados) e
   cole no Vcall. O token fica cifrado no computador e só o seu Vcall usa, nas
   salas abertas por ele. **Sair** apaga o token.
2. **Projeto**: aparecem os seus projetos e os das suas organizações, o último
   usado primeiro. Dá também para colar o endereço
   (`github.com/orgs/empresa/projects/3`).
3. **US**: escolha a coluna (com quantos cards tem em cada uma) e marque as US.
   Vêm marcadas as que ainda não têm estimativa; as que já estão na mesa não
   entram de novo. Cada linha mostra quantas subtarefas já foram fechadas.

Na mesa, a US em votação mostra o tipo, as etiquetas e os responsáveis da
issue, o link para o card e três abas: **Subtarefas** (as sub-issues, com o que
já foi fechado), a **checklist** do corpo da issue (com o nome do título de
cima, em geral "Critérios de aceite") e a **Descrição**. Cada pessoa abre e
fecha as abas para si.

Ao salvar a estimativa, o número vai para o campo escolhido no projeto (um
campo de número, como *Estimate*), não importa quem salvou: quem importou é
que grava, pelo computador dele.

#### Subtarefas com nota

As sub-issues abertas de cada US entram na lista logo abaixo dela, recuadas,
e cada uma tem a própria votação, com a descrição e os critérios dela. Ao
salvar a US, a mesa passa para a primeira subtarefa. A nota vai para o quadro
como a da US; se a subtarefa ainda não estava no quadro, ela entra na coluna
da US.

A aba **Subtarefas** mostra a nota de cada uma (ou **Votar**, para levar a
votação até ela) e a soma das notas, para comparar com a estimativa da US.

Quem estima só as US desmarca **Votar também as subtarefas** na hora de
importar.

#### Dividir uma US grande

Se a US (ou uma subtarefa) ficou grande demais, o botão **Dividir** cria
sub-issues novas embaixo dela, no GitHub, sem sair da chamada. Dá para
preencher o que se preenche ao criar uma issue lá:

- título e descrição (com um atalho que insere **Critérios de aceite**);
- responsáveis e etiquetas;
- tipo (nos repositórios de organização que usam tipos de issue);
- marco (já vem o da US);
- coluna e estimativa no quadro (ou **Votar depois**).

Com **Criar outra depois desta** marcado, o formulário limpa o título e a
descrição e mantém o resto, para criar várias seguidas. Cada uma entra na mesa
logo abaixo da US. Só quem importou a US vê o botão, porque é o GitHub dele que
cria as issues.

## Retrospectiva

Três fases, sempre iguais para todo mundo. Qualquer pessoa pode passar de uma
para a outra.

1. **Escrever**: cada um escreve nas colunas. **Ninguém lê a nota dos
   outros** nesta fase (aparecem borradas), para ninguém se influenciar. Em cima
   aparece quantas notas cada pessoa já escreveu.
2. **Votar**: as notas aparecem para todos. Cada pessoa tem **3 pontos** para
   distribuir (pode pôr mais de um na mesma nota). Os pontos dos outros só
   aparecem na discussão.
3. **Discutir**: os pontos aparecem, e as notas mais votadas sobem. Embaixo fica
   o **plano de ação**: escreva quem faz o quê e marque quando estiver feito.

![Fase de escrita: as notas dos outros ficam borradas](imagens/retro-escrever.png)

![Retrospectiva na fase de discussão, com o plano de ação](imagens/retro-discutir.png)

Modelos: **Começar · Parar · Continuar**, **Bom · Melhorar · Ideias**, **4Ls**
(gostei, aprendi, faltou, desejei) e **Feliz · Triste · Bravo**. No fim,
**Copiar** ou **.md** levam a retrospectiva inteira em Markdown, pronta para a
wiki do time.

## Daily

**Sortear ordem** embaralha quem fala (sorteio de verdade, igual para todos).
**Começar a daily** liga o relógio: cada pessoa tem o mesmo tempo (1, 1:30, 2
ou 3 minutos), e o anel em volta do avatar esvazia. Faltando 15 segundos ele
fica laranja; estourou, fica vermelho, pulsa e conta o tempo a mais.

**Próximo** passa a vez (se duas pessoas clicarem juntas, avança uma vez só).
No fim aparece quanto durou a daily e quem passou do tempo.

![Daily com o relógio de quem está falando](imagens/daily.png)

## Privacidade e leveza

- Tudo vai pelo mesmo canal direto e cifrado do canvas, de computador para
  computador. Só se esse canal ainda não abriu com alguém a sinalização repassa
  a mensagem, sem guardar nada.
- **O voto fica no seu computador até alguém revelar.** Antes disso, os outros
  recebem só "votou". Na Retrospectiva é igual: o texto da nota só sai do seu
  computador quando a sala passa para a votação.
- O estado é um mapa que se junta sozinho (cada valor tem um relógio, e vence o
  mais novo). Mensagens fora de ordem ou repetidas dão o mesmo resultado em
  todo mundo.
- Nada fica rodando à toa: o painel só redesenha o que mudou, e o relógio de
  250 ms só liga durante uma contagem, um cronômetro ou a Daily.

## Atalhos

| Tecla | Ação |
| --- | --- |
| `K` | Abre ou fecha os jogos |
| `Enter` | Adiciona a história, a nota ou a ação |
| `Shift` + `Enter` | Quebra a linha numa nota |
