# Novidades da 3.23

## 3.23.1: jogo sem perder quadros com a placa de vídeo

- **A placa de vídeo não cai mais para o processador:** a imagem enviada sai
  sempre com largura e altura pares, que o codificador da placa exige. Com um
  jogo ocupando o processador, a tela foi de 9–32 para 53–59 quadros por
  segundo.
- **Prioridade de transmissão no Windows:** ao compartilhar, o Vcall sobe a
  própria prioridade, e o jogo não deixa mais a captura esperando.
- **Se a placa cair mesmo assim, ela volta** sozinha, em segundos.

## 3.23.0: placa de vídeo e volta rápida da qualidade

- **Configurações › Transmissão:** Automático, Placa de vídeo, Processador
  ou Leve (VP8, para PC fraco). Com um jogo ocupando o processador, a tela
  pela placa ficou em 60 quadros por segundo em 1080p; pelo processador,
  7,7. Quando o Windows só libera a placa com o sandbox da GPU desligado, o
  Vcall avisa do risco e pergunta antes.
- **A imagem volta logo:** depois de uma queda de internet, a imagem volta
  ao tamanho de antes em ~4,5 s (antes, ~26 s). Com o processador apertado,
  o Vcall não corta mais quadros nem banda até o piso.
- **120 quadros por segundo** com monitor de 120 Hz ou mais e o codificador
  da placa. Em monitor de 60 Hz, o teto é 60.

→ [Compartilhar a tela](Compartilhar-a-tela)
