# Novidades da 3.23

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
