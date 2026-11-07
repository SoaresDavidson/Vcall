/**
 * desktop/webrtc.js — o que o aplicativo de mesa liga no WebRTC do Chromium.
 *
 * FlexFEC (RFC 8627): pacotes de correção que deixam quem recebe refazer um
 * pacote de vídeo perdido na hora, sem esperar a retransmissão (uma volta
 * inteira pela rede: 100 a 400 ms de imagem parada a cada perda). O Chromium
 * já sabe receber, mas só oferece e envia com estas field trials. O ULPFEC,
 * que vem ligado, não é usado junto com o NACK, então sem isto o vídeo não
 * tinha correção nenhuma.
 *
 * Medido com scripts/bench-video.mjs (câmera, 2 pessoas, 35 s congelado):
 *                                              sem FlexFEC   com FlexFEC
 *   4G, VP8 (2,5 Mbps, 2% de perda por ponta)  2,7 s         0,0 s
 *   4G, VP9                                    1,9 s         0,7 s
 *   internet ruim, VP9 (1 Mbps, 4% por ponta)  17,1 s        10,4 s
 *
 * Só vale entre dois apps de mesa: a FlexFEC entra na negociação quando as
 * duas pontas a oferecem. Com quem entra pelo navegador, nada muda.
 */
export const TRIALS_WEBRTC = "WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/";

/**
 * Opções do Chromium para o codificador escolhido em Configurações ›
 * Transmissão (tuning.MODOS_CODIFICADOR). Valem só a partir da próxima vez
 * que o app abrir: o Chromium lê a linha de comando uma vez.
 *
 *   gpu   sem o sandbox da GPU, só quando a pessoa confirmou: em alguns
 *         Windows, com o sandbox ligado, nenhum codificador da placa aparece
 *         (medido num notebook Intel + RTX 2050; sem ele surgem o VP9 e o
 *         H.264 do Quick Sync). O Chromium considera esse sandbox uma
 *         proteção crítica. Forçar a GPU dedicada não ajuda: o Chromium
 *         escolheu o codificador da Intel mesmo desenhando na NVIDIA, e só
 *         poria o Vcall para disputar a placa do jogo.
 *         Medido, 1080p60 com 10 threads ocupadas (o jogo): VP9 por software
 *         7,7 qps; VP9 da placa 60 qps.
 *   cpu   desliga a codificação pela placa: tudo pelo processador.
 */
export function opcoesDoCodificador({ modo = "auto", semSandbox = false } = {}) {
  if (modo === "gpu") return semSandbox ? ["disable-gpu-sandbox"] : [];
  if (modo === "cpu") return ["disable-accelerated-video-encode"];
  return [];
}
