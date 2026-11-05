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
