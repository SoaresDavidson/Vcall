# Compartilhar a tela

Clique em **Compartilhar tela** (`S`).

## No aplicativo (Windows e Linux X11)

O Vcall mostra a lista de verdade: **cada janela aberta** e **cada tela**, com
miniatura. Escolha e clique em **Compartilhar** (ou dê dois cliques).

![Escolher uma janela](imagens/seletor-janelas.png)

![Escolher uma tela](imagens/seletor-telas.png)

- **Janela:** os outros veem só aquele programa, mesmo que você mexa em outros.
- **Tela inteira:** tudo o que aparece no monitor. A sua própria prévia fica
  escondida atrás de um aviso para não criar o efeito "sala de espelhos" (que
  pesava no processador e na rede e podia derrubar a chamada). Dá para ver a
  prévia em **Ver prévia**.

![Compartilhando a tela inteira](imagens/tela-inteira.png)

## No Linux com Wayland (Fedora, Ubuntu, Arch com GNOME/KDE)

A lista é do **sistema** (xdg-desktop-portal). Ao clicar em Compartilhar, a
janela do GNOME/KDE aparece — escolha a tela ou a janela ali. Se ela não
aparecer, veja [Instalação → Wayland](Instalacao#compartilhar-tela-no-wayland-gnome-kde-plasma-sway-hyprland).

## No navegador

O navegador mostra a lista dele (é uma regra de segurança: nenhum site pode
ver suas janelas sem você escolher). O Vcall já abre essa lista na aba certa.

## Trocar o que está sendo mostrado, sem parar

Compartilhando uma janela e quer mostrar outra (ou a tela inteira)? Clique em
**Trocar** (ícone de setas) no seu ladrilho de tela, ou em **⋯ → Opções de
compartilhamento → Trocar o que estou mostrando…**. Escolha a nova janela, a
tela, o som, a prioridade e a resolução, e clique em **Trocar agora**. A
transmissão **não é interrompida**: quem está assistindo continua no mesmo
ladrilho e passa a ver a nova escolha. A prioridade (nitidez ou fluidez) e a
resolução também mudam na hora, pelo menu da seta ao lado do botão de tela.

## Tela parada não cai mais

A captura de tela (principalmente no Linux) só envia imagem quando algo muda
na tela. Com um slide parado, nenhum dado saía, e do outro lado a tela
**sumia e voltava** sem parar. Desde a 3.3 o Vcall repete a última imagem
enquanto a tela estiver parada: a transmissão fica estável e quem entra no
meio já vê a tela na hora.

## Prioridade da imagem

| Opção | Use para | O que acontece quando a rede aperta |
| --- | --- | --- |
| **Nitidez** | Texto, código, planilhas, slides | Perde quadros, mas o texto continua legível |
| **Fluidez** | Vídeo, animação, jogo | Perde resolução, mas não engasga |

A resolução (1080p/720p) e a prioridade podem ser trocadas durante a
transmissão pela setinha ao lado do botão.

No aplicativo, escolher a janela do YouTube, Twitch, Netflix ou de um player
de vídeo já liga a **Fluidez**, a menos que você escolha a prioridade à mão.
Para o resto (um jogo, um vídeo no meio de uma página), a Nitidez passa
sozinha para a Fluidez quando a imagem não para e começa a engasgar, e o
Vcall avisa. Escolhida à mão, a prioridade não muda.
Não minimize a janela compartilhada: o Windows não captura janela minimizada,
e a imagem congela para quem assiste. Se isso acontecer, o Vcall avisa.

Sem codificador de vídeo na placa, a Fluidez usa o VP9 pelo processador:
em 1080p se o computador tem 8 threads ou mais e dá conta, senão em 720p.

### Placa de vídeo ou processador

Em **Configurações › Transmissão** você escolhe por onde a tela é codificada:
**Automático**, **Placa de vídeo** (para jogar e transmitir ao mesmo tempo:
o jogo pode ocupar o processador e a transmissão não engasga),
**Processador** ou **Leve (VP8)**, para PC fraco. Placa e processador valem
depois de reabrir o Vcall.

Em alguns Windows, o codificador da placa só aparece com o sandbox da GPU
desligado, uma proteção do Chromium. Nesse caso o Vcall avisa do risco e só
desliga a proteção se você confirmar. Voltar para Automático ou Processador
liga a proteção de novo.

Na Fluidez a janela é capturada no tamanho dela (até 1440p), e quem reduz a
imagem é o codificador. Reduzir dentro da captura prendia o vídeo em ~45
quadros por segundo. O som do computador, quando compartilhado, espera a
imagem por até 250 ms para chegar sincronizado. Se a imagem engasgar, o som
segue sem esperar.

A tela sai em 1080p a até **120 quadros por segundo** no modo Fluidez, quando
o monitor de quem transmite é de 120 Hz ou mais e a internet aguenta (começa em
60 e sobe em alguns segundos); num monitor de 60 Hz saem 60, e no Linux
também (o PipeWire não entrega mais que isso). Texto e slides ficam em 60, onde a nitidez vale mais que quadros a
mais. Com mais gente na sala cada pessoa recebe uma cópia, tudo fica em no
máximo 60, e a qualidade desce sozinha conforme a internet e o computador de
quem transmite.

### Sala de 3 ou mais pelo aplicativo de mesa

Quem transmite pelo aplicativo de mesa para 3 ou mais pessoas codifica a
tela uma vez só. Um servidor de mídia (LiveKit) dentro do próprio app
repassa a imagem para cada pessoa, cifrada de ponta a ponta: ele não
consegue ver a imagem. A tela sai em duas camadas, até 1080p a 3,5 Mbps e
uma de 360p, e cada pessoa recebe a que cabe na conexão dela.

Quantas pessoas cabem depende da sua internet de **subida**: cada uma usa
até ~3,7 Mbps. Com 70 Mbps, ficam ~16 pessoas. Quem não consegue se
conectar ao seu PC (operadora com CGNAT, por exemplo) continua recebendo
direto, como numa sala pequena.

Pela internet, com pouca banda de envio, vídeo e jogo diminuem a imagem
(1080p, 720p, 540p…) em vez de perder quadros: fica menos nítido, mas fluido.
A imagem volta a crescer poucos segundos depois de a conexão melhorar, e só
espera mais quando a internet fica indo e voltando. O modo de texto nunca
diminui, para a letra continuar legível.

## Som

**Desligado por padrão.** Ligue "Compartilhar o som do computador" só quando
for mostrar vídeo ou música, e **use fones**: no Windows o som capturado é o
do computador inteiro, e sem fone as vozes da própria chamada voltam para os
outros como eco. No Linux o sistema não oferece captura de som por janela, e
a opção não aparece.
