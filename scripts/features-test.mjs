#!/usr/bin/env node
/**
 * scripts/features-test.mjs — verificação das partes testáveis fora do navegador.
 *
 * Não abre navegador: exercita a geometria do canvas, o desfazer/refazer e a
 * remontagem de arquivos — os três lugares onde um erro passa despercebido
 * até alguém ver a nota com o texto cortado, o Ctrl+Z apagando o que não devia
 * ou um anexo que chega corrompido.
 *
 *   node scripts/features-test.mjs
 */
import assert from "node:assert/strict";

// O módulo toca o DOM só dentro de métodos, mas as dependências que ele
// importa mexem em `document` ao carregar. Um esboço mínimo basta.
const noop = () => {};
const stubNode = new Proxy(
  { style: {}, dataset: {}, classList: { add: noop, remove: noop }, setAttribute: noop, append: noop },
  { get: (t, k) => (k in t ? t[k] : noop) },
);
globalThis.document = {
  createElement: () => stubNode,
  createElementNS: () => stubNode,
  createTextNode: () => stubNode,
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: noop };

const { bounds, hits, wrapText, readableInk, constrain } = await import("../public/js/features/canvas.js");

/* -- caixa envolvente de nota e texto -- */
const note = { type: "note", x: 10, y: 20, w: 100, h: 80, text: "oi", size: 16 };
assert.deepEqual(bounds(note), { x: 10, y: 20, w: 100, h: 80 });
assert.ok(hits(note, { x: 50, y: 50 }, 2), "ponto dentro da nota tem de acertar");
assert.ok(!hits(note, { x: 500, y: 50 }, 2), "ponto longe da nota não pode acertar");

/* -- quebra de linha -- */
// Métrica falsa: cada caractere mede 10. Torna a conta previsível.
const ctx = { measureText: (s) => ({ width: s.length * 10 }) };
assert.deepEqual(wrapText(ctx, "abc def ghi", 80), ["abc def", "ghi"]);
assert.deepEqual(wrapText(ctx, "linha1\nlinha2", 1000), ["linha1", "linha2"]);
// Uma palavra maior que a largura não pode virar linha vazia nem sumir.
assert.deepEqual(wrapText(ctx, "supercalifragilistico", 50), ["supercalifragilistico"]);

/* -- tinta legível sobre o papel da nota -- */
assert.equal(readableInk("#ffd166"), "#101014", "papel amarelo pede tinta escura");
assert.equal(readableInk("#b98bff"), "#ffffff", "papel roxo pede tinta clara");
assert.equal(readableInk("var(--board-ink)"), "#101014", "cor não-hexadecimal cai no padrão");

/* -- Shift travando a forma -- */
const sq = constrain({ x: 0, y: 0 }, { x: 100, y: 30 }, "rect");
assert.deepEqual(sq, { x: 100, y: 100 }, "quadrado usa o maior lado");
const neg = constrain({ x: 0, y: 0 }, { x: -80, y: -10 }, "ellipse");
assert.deepEqual(neg, { x: -80, y: -80 }, "o sinal do arrasto tem de ser mantido");
const diag = constrain({ x: 0, y: 0 }, { x: 100, y: 5 }, "line");
assert.ok(Math.abs(diag.y) < 1e-9 && Math.abs(diag.x - 100.12) < 0.5, "linha quase reta cai em 0°");

console.log("✓ canvas: geometria, quebra de linha, contraste e travas de Shift");

/* -- desfazer e refazer --
 * A pilha guarda o que foi feito; desfazer executa o inverso. Escrevê-la ao
 * contrário faz Ctrl+Z virar um nada e Ctrl+Shift+Z apagar o conteúdo — foi
 * exatamente o que aconteceu antes desta verificação existir. */
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = noop;
const { InfiniteCanvas } = await import("../public/js/features/canvas.js");

const c = new InfiniteCanvas({ selfId: "eu", selfName: "Eu", getRoster: () => [] });
const id = "eu-obj-1";
c.add({ id, by: "eu", seq: 1, rev: 1, type: "note", x: 0, y: 0, w: 100, h: 80, text: "" },
  { local: false, record: true });
assert.equal(c.objects.size, 1);

c.apply("eu", { type: "noop" }); // ruído: mensagem desconhecida não pode quebrar nada
assert.equal(c.objects.size, 1, "uma mensagem desconhecida não pode mexer na cena");

// Alterar uma propriedade e desfazer tem de voltar ao valor anterior — foi
// aqui que a pilha escrita ao contrário reaplicava o valor novo.
c.selection.add(id);
c.setColor("#37d399");
assert.equal(c.objects.get(id).color, "#37d399");
assert.ok(c.undo(), "desfazer a mudança de cor");
assert.equal(c.objects.get(id).color, null, "desfazer devolve a cor que havia antes");
assert.ok(c.redo(), "refazer a mudança de cor");
assert.equal(c.objects.get(id).color, "#37d399", "refazer aplica a cor de novo");
assert.ok(c.undo());
c.selection.clear();

assert.ok(c.undo(), "desfazer a criação tem de funcionar");
assert.equal(c.objects.size, 0, "desfazer a criação apaga o objeto");
assert.ok(c.redo(), "refazer tem de funcionar");
assert.equal(c.objects.size, 1, "refazer recria o objeto");
assert.equal(c.objects.get(id).type, "note", "refazer recria o objeto igual");
assert.equal(c.undo(), true);
assert.equal(c.undo(), false, "pilha vazia não desfaz mais nada");

console.log("✓ canvas: desfazer e refazer nos dois sentidos");

/* -- remontagem de arquivos --
 * A recepção junta pedaços numerados. Contar pedaços repetidos como novos faz
 * a contagem bater o total com buracos no meio, e o arquivo sai corrompido sem
 * nenhum erro visível — é o tipo de falha que só aparece no computador do
 * outro, horas depois. */
let ultimoBlob = null;
globalThis.URL.createObjectURL = (b) => {
  ultimoBlob = b;
  return "blob:teste";
};
const { FileTransfer, formatSize } = await import("../public/js/features/transfer.js");

const t = new FileTransfer({ selfId: "eu" });
const recebidos = [];
t.on("file", (f) => recebidos.push(f));

const conteudo = "arquivo de teste com acento: ação";
const b64 = Buffer.from(conteudo, "utf8").toString("base64");
const meio = Math.ceil(b64.length / 2);

// Mensagem que não é dela tem de ser devolvida, senão engoliria as operações
// do canvas que passam pelo mesmo canal.
assert.equal(t.apply("a", { type: "add", op: {} }), false, "operação do canvas não é arquivo");
assert.equal(t.apply("a", { type: "file-chunk", id: "x", i: 0 }), true, "pedaço sem início é dela, e é descartado");

t.apply("a", { type: "file-begin", id: "f1", meta: { name: "t.txt", size: 32, mime: "text/plain" }, total: 2 });
t.apply("a", { type: "file-chunk", id: "f1", i: 1, total: 2, data: b64.slice(meio) });
t.apply("a", { type: "file-chunk", id: "f1", i: 1, total: 2, data: b64.slice(meio) }); // repetido
assert.equal(recebidos.length, 0, "um pedaço repetido não pode completar o arquivo");
t.apply("a", { type: "file-chunk", id: "f1", i: 0, total: 2, data: b64.slice(0, meio) });
assert.equal(recebidos.length, 1, "arquivo completo depois do último pedaço que faltava");
assert.equal(recebidos[0].name, "t.txt");
assert.equal(await ultimoBlob.text(), conteudo, "o conteúdo remontado tem de ser idêntico ao original");

// Arquivo grande demais é recusado na chegada, não só no envio: o remetente
// pode ser uma versão antiga do app.
t.apply("a", { type: "file-begin", id: "f2", meta: { name: "g", size: 999e6 }, total: 1 });
t.apply("a", { type: "file-chunk", id: "f2", i: 0, total: 1, data: b64 });
assert.equal(recebidos.length, 1, "arquivo acima do teto não entra");

assert.equal(formatSize(512), "512 B");
assert.equal(formatSize(2048), "2 kB");
assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");

console.log("✓ arquivos: pedaços fora de ordem, repetidos e acima do limite");

/* -- sincronização do canvas: traços fantasma --
 * O pedaço de um traço pode chegar DEPOIS do "add" que o encerra: o caminho
 * pelo servidor é mais lento que o DataChannel e a ordem entre os dois não é
 * garantida. Sem a guarda, esse pedaço atrasado recriava um traço "em
 * andamento" que nunca terminava — ficava desenhado na tela até recarregar. */
const c2 = new InfiniteCanvas({ selfId: "eu", selfName: "Eu", getRoster: () => [] });
const traco = {
  id: "outro-t1", by: "outro", seq: 5, rev: 1, type: "pen",
  color: "#fff", width: 2, alpha: 1, rotation: 0,
  points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
};
c2.apply("outro", { type: "add", op: traco });
assert.equal(c2.objects.size, 1);
c2.apply("outro", {
  type: "stroke-chunk", id: "outro-t1", by: "outro", seq: 5,
  tool: "pen", color: "#fff", width: 2, from: 0, points: [{ x: 99, y: 99 }],
});
assert.equal(c2.objects.size, 1, "o pedaço atrasado não pode criar um segundo traço");
assert.deepEqual(
  c2.objects.get("outro-t1").points.at(-1),
  { x: 10, y: 10 },
  "e não pode alterar o traço que já virou objeto",
);

// A cena de quem reconecta FUNDE com a local em vez de substituí-la: cada lado
// desenhou enquanto o canal esteve fechado, e nada pode ser perdido.
c2.apply("outro", {
  type: "scene", clock: 9,
  objects: [traco, { ...traco, id: "outro-t2", seq: 6 }],
});
assert.equal(c2.objects.size, 2, "a cena recebida soma o que falta sem duplicar o que já existe");

console.log("✓ canvas: pedaço atrasado não vira fantasma, cena funde sem perder desenho");

/* -- grade de vídeo em salas grandes --
 * `auto-fit` com largura mínima fixa só olha a largura: numa tela larga com
 * dezesseis pessoas ele fazia onze colunas e duas linhas, e cada ladrilho saía
 * em retrato estreito — a pior forma possível para vídeo, que é deitado. */
const { bestColumns } = await import("../public/js/ui/stage.js");

// 1280x620 é uma janela de notebook comum, já descontadas barra e controles.
assert.equal(bestColumns(16, 1280, 620), 4, "dezesseis pessoas cabem em 4x4");
assert.equal(bestColumns(9, 1280, 620), 3, "nove em 3x3");
assert.equal(bestColumns(2, 1280, 620), 2, "duas lado a lado");
assert.equal(bestColumns(1, 1280, 620), 1);

// Tela alta e estreita (celular deitado ao contrário): mais linhas, não mais colunas.
assert.ok(bestColumns(6, 400, 900) <= 2, "numa tela estreita a grade empilha");

// Não pode devolver número inválido com medidas degeneradas.
assert.equal(bestColumns(4, 0, 0), 1);
assert.equal(bestColumns(0, 1280, 620), 1);

// A forma escolhida tem de ficar perto de 16:9 e nunca em retrato extremo.
for (const n of [5, 7, 11, 13, 16]) {
  const cols = bestColumns(n, 1280, 620);
  const prop = 1280 / cols / (620 / Math.ceil(n / cols));
  assert.ok(prop > 0.9, `com ${n} pessoas o ladrilho não pode ficar em retrato (${prop.toFixed(2)})`);
}

console.log("✓ grade: colunas escolhidas pela proporção, sem ladrilho em retrato");

/* -- imagem é fundo, não rabisco --
 * Escrever sobre uma foto e depois corrigir com a borracha não pode levar a
 * foto junto. Quem quiser tirar a imagem usa selecionar + Delete, que é o
 * caminho explícito. */
const c3 = new InfiniteCanvas({ selfId: "eu", selfName: "Eu", getRoster: () => [] });

const imagem = {
  id: "img1", by: "eu", seq: 1, rev: 1, type: "image",
  x: 0, y: 0, w: 200, h: 200, rotation: 0, alpha: 1, src: "",
};
const risco = {
  id: "risco1", by: "eu", seq: 2, rev: 1, type: "pen",
  color: "#fff", width: 4, alpha: 1, rotation: 0,
  points: [{ x: 50, y: 50 }, { x: 60, y: 60 }],
};
c3.objects.set(imagem.id, imagem);
c3.objects.set(risco.id, risco);

// A borracha passa exatamente por cima dos dois.
c3.apagarParaTeste({ x: 55, y: 55 });
assert.ok(c3.objects.has("img1"), "a borracha NÃO pode apagar a imagem");
assert.ok(!c3.objects.has("risco1"), "mas apaga o que foi escrito em cima dela");

// O caminho explícito continua funcionando.
c3.selection.add("img1");
c3.deleteSelection();
assert.ok(!c3.objects.has("img1"), "selecionar e apagar remove a imagem");

console.log("✓ canvas: a borracha apaga o traço e preserva a imagem embaixo");

/* -- fone Bluetooth em modo viva-voz -- */
const { isHandsFree } = await import("../public/js/ui/handsfree.js");
for (const rotulo of [
  "Headset (WH-1000XM4 Hands-Free AG Audio)",
  "Padrão - Fone de ouvido (JBL Tune 510BT Hands-Free)",
  "Headset Head Unit (HSP/HFP)",
  "Microfone (Galaxy Buds Viva-voz)",
]) assert.ok(isHandsFree(rotulo), `viva-voz não reconhecido: ${rotulo}`);
for (const rotulo of ["Microfone (Realtek(R) Audio)", "USB Headset Microphone", "Microphone Array (Intel® Smart Sound)", ""])
  assert.ok(!isHandsFree(rotulo), `falso positivo: ${rotulo}`);
console.log("✓ áudio: detecta o microfone Bluetooth em modo viva-voz sem confundir com fone USB");

/* -- orçamento de banda: a soma não pode estourar o enlace -- */
const { meshBudget } = await import("../public/js/core/tuning.js");

// Enlace folgado: o piso por par cabe e vale.
const folgado = meshBudget(4, { uplink: 20_000_000 });
assert.ok(folgado.screen >= 600_000, "com banda sobrando, o piso de tela vale");

/*
 * Enlace apertado — o caso que derrubava a chamada ao compartilhar tela.
 * Quatro pares num enlace de 1,5 Mbps: o piso de 600 kbps por par prometeria
 * 2,4 Mbps de subida e entupiria o roteador. A soma tem de caber.
 */
const apertado = meshBudget(4, { uplink: 1_500_000 });
assert.ok(
  apertado.screen * 4 <= 1_500_000,
  `a soma dos tetos de tela (${apertado.screen * 4}) estourou o enlace de 1,5 Mbps`,
);
assert.ok(
  (apertado.screen + apertado.camera) * 4 <= 1_500_000,
  "tela e câmera juntas também precisam caber no enlace",
);

// Mais gente na sala, menos banda por par — nunca o contrário.
let anterior = Infinity;
for (const n of [1, 2, 4, 8, 16]) {
  const b = meshBudget(n, { uplink: 6_000_000 });
  assert.ok(b.screen <= anterior, `o teto subiu de ${anterior} para ${b.screen} com ${n} pares`);
  anterior = b.screen;
}
console.log("✓ rede: o orçamento da malha cabe no enlace medido, com ou sem gente na sala");

/* -- voz: FEC, DTX e estéreo pedidos ao Opus de quem envia -- */
const { ajustarOpus } = await import("../public/js/core/tuning.js");
const sdpRemoto = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 63 111",
  "a=mid:0",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:3",
  "a=rtpmap:111 opus/48000/2",
  "",
].join("\r\n");
const papeis = { 0: "mic", 1: "cam", 3: "screenAudio" };
const ajustado = ajustarOpus(sdpRemoto, (mid) => papeis[mid]);
const fmtps = ajustado.split("\r\n").filter((l) => l.startsWith("a=fmtp:111"));
assert.equal(fmtps.length, 2, "cada linha de áudio tem o seu fmtp do Opus");
assert.equal(fmtps[0], "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0", "microfone: FEC + DTX, o resto preservado");
assert.match(fmtps[1], /stereo=1;sprop-stereo=1;maxaveragebitrate=128000/, "áudio da tela: estéreo e taxa alta");
assert.match(fmtps[1], /usedtx=0/, "áudio da tela sem DTX");
assert.ok(ajustado.includes("a=fmtp:63 111/111"), "a linha do RED fica intacta");
assert.ok(ajustado.includes("a=rtpmap:96 VP8/90000\r\n"), "o vídeo fica intacto");
assert.equal(ajustarOpus(sdpRemoto, () => undefined), sdpRemoto, "sem papel conhecido, nada muda");
console.log("✓ voz: FEC e DTX no microfone, estéreo no áudio da tela, o resto da descrição intacto");

/* -- vídeo: 60 qps, banda inicial e degraus por tamanho de sala -- */
{
  const { ajustarInicioVideo, cameraParaSala, cpuCeiling, meshBudget: orcamento, PROFILES } = await import("../public/js/core/tuning.js");
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 45",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:97 rtx/90000",
    "a=fmtp:97 apt=96",
    "a=rtpmap:98 VP9/90000",
    "a=fmtp:98 profile-id=0",
    "a=rtpmap:45 AV1/90000",
    "",
  ].join("\r\n");
  const v = ajustarInicioVideo(sdp, 1500);
  assert.ok(v.includes("a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=1500"), "VP8 sem fmtp ganha um");
  assert.ok(v.includes("a=fmtp:98 profile-id=0;x-google-start-bitrate=1500"), "VP9 mantém o perfil");
  assert.ok(v.includes("a=fmtp:45 x-google-start-bitrate=1500"), "AV1 também");
  assert.ok(v.includes("a=fmtp:97 apt=96\r\n"), "rtx fica intacto");
  assert.ok(v.includes("a=fmtp:111 minptime=10\r\n"), "áudio fica intacto");
  assert.equal(ajustarInicioVideo(v, 1500), v, "aplicar de novo não duplica");

  assert.equal(orcamento(1, { uplink: 3_000_000 }).screen, PROFILES.screenMotion.maxBitrate, "a dois, a estimativa da própria conexão não vira teto");
  assert.equal(cameraParaSala(1).maxFramerate, 30, "câmera a 30 qps: com a mesma banda, cada quadro tem o dobro de bits");
  assert.equal(PROFILES.camera.maxFramerateComBanda, 60, "a dois e com banda sobrando, sobe para 60 (stats.js)");
  assert.ok(PROFILES.camera.maxBitrateComBanda > cameraParaSala(1).maxBitrate, "e ganha mais banda para os 60");
  assert.ok(cameraParaSala(2).maxFramerate <= 30, "com mais gente, a câmera fica em 30 ou menos");
  assert.equal(cpuCeiling(1, 8).maxFramerate, 120, "a dois, a tela pode ir a 120 qps");
  assert.equal(cpuCeiling(2, 8).maxFramerate, 60, "duas cópias: no máximo 60");
  assert.ok(cpuCeiling(6, 8).maxFramerate <= 24, "CPU apertada: a tela desce");
  assert.equal(PROFILES.screenText.maxFramerate, 60, "texto fica em 60");
  console.log("✓ vídeo: até 120 qps a dois, banda inicial pedida no SDP, e degraus que descem com a sala");
}

/* -- câmera: VP9 quando a máquina dá conta, VP8 quando não -- */
{
  const { codecDaCamera } = await import("../public/js/core/tuning.js");
  const com = (o) => ({ nucleos: 8, celular: false, hardware: async () => false, suporta: () => true, ...o });
  assert.equal(await codecDaCamera(1, com()), "video/VP9", "a dois, com 8 núcleos: VP9 por software");
  assert.equal(await codecDaCamera(2, com()), "video/VP9", "duas cópias ainda cabem");
  assert.equal(await codecDaCamera(3, com()), "video/VP8", "três cópias por software: VP8, que custa 2–3× menos");
  assert.equal(await codecDaCamera(5, com({ hardware: async (m) => m === "video/VP9" })), "video/VP9", "com VP9 na placa de vídeo, sempre VP9");
  assert.equal(await codecDaCamera(1, com({ nucleos: 2 })), "video/VP8", "máquina de 2 núcleos fica no VP8");
  assert.equal(await codecDaCamera(1, com({ celular: true })), "video/VP8", "celular sem VP9 na placa fica no VP8");
  assert.equal(await codecDaCamera(1, com({ suporta: () => false })), "video/VP8", "navegador sem VP9");
  console.log("✓ câmera: VP9 quando a placa ou o processador dão conta, VP8 nos outros casos");
}

/* -- a imagem enviada sai com largura e altura pares (o codificador da placa recusa ímpares) -- */
{
  const { escalaPar } = await import("../public/js/core/tuning.js");
  const parNosDoisJeitos = (v) => Math.floor(v) % 2 === 0 && Math.round(v) % 2 === 0;
  for (const [w, h, e] of [[1541, 875, 1], [1541, 875, 1.25], [1901, 1080, 1], [1233, 700, 1], [1366, 768, 1.5], [3441, 1441, 2]]) {
    const r = escalaPar(w, h, e);
    assert.ok(r >= e && r < e * 1.1, `${w}x${h}: a escala ${r} só cresce um pouco`);
    assert.ok(parNosDoisJeitos(w / r) && parNosDoisJeitos(h / r), `${w}x${h} @${e}: saiu ${w / r}x${h / r}`);
  }
  assert.equal(escalaPar(1920, 1080, 1), 1, "1080p já é par: não mexe");
  assert.equal(escalaPar(1920, 1080, 1.5), 1.5, "720p também");
  console.log("✓ tela: largura e altura enviadas sempre pares, para a placa de vídeo não cair no software");
}

/* -- Configurações › Transmissão: placa de vídeo, processador ou leve -- */
{
  const { codecDaTela, codecDaCamera } = await import("../public/js/core/tuning.js");
  const { opcoesDoCodificador } = await import("../desktop/webrtc.js");
  const sem = { hardware: async () => false, suporta: () => true };
  const vp9NaPlaca = { hardware: async (m) => m === "video/VP9", suporta: () => true };
  assert.equal(await codecDaTela("motion", { ...sem, modo: "leve" }), "video/VP8", "leve: VP8 na tela");
  assert.equal(await codecDaTela("text", { ...sem, modo: "leve" }), "video/VP8");
  assert.equal(await codecDaTela("motion", { ...vp9NaPlaca, modo: "cpu" }), "video/VP9", "processador: VP9, mesmo com a placa disponível");
  assert.equal(await codecDaTela("motion", { ...vp9NaPlaca, modo: "gpu" }), "video/VP9", "placa: o VP9 da placa (com o jogo ocupando a CPU: 60 qps em 1080p; o H.264 da placa caía para 540p)");
  assert.equal(await codecDaTela("motion", { hardware: async (m) => m === "video/AV1", suporta: () => true, modo: "gpu" }), "video/AV1", "placa com AV1: AV1");
  assert.equal(await codecDaTela("text", { ...sem, modo: "auto" }), "video/VP9", "automático: como antes");
  assert.equal(await codecDaCamera(1, { nucleos: 8, celular: false, hardware: async () => true, suporta: () => true, modo: "leve" }), "video/VP8", "leve: câmera no VP8");

  assert.deepEqual(opcoesDoCodificador({ modo: "auto" }), []);
  assert.deepEqual(opcoesDoCodificador({ modo: "leve" }), [], "leve não mexe na placa");
  assert.deepEqual(opcoesDoCodificador({ modo: "gpu" }), [], "placa que aparece com o sandbox: nada a mudar");
  assert.deepEqual(opcoesDoCodificador({ modo: "gpu", semSandbox: true }), ["disable-gpu-sandbox"], "sem sandbox só com a confirmação");
  assert.deepEqual(opcoesDoCodificador({ modo: "cpu", semSandbox: true }), ["disable-accelerated-video-encode"], "processador religa o sandbox e desliga a placa");
  console.log("✓ transmissão: placa de vídeo (sandbox só confirmado), processador ou leve (VP8)");
}

/* -- tela: VP9 quando o H.264 sai por software, e Fluidez quando a imagem não para -- */
{
  const { codecMelhorQueOSoftware, pedeFluidez } = await import("../public/js/core/tuning.js");
  const sw = { modo: "motion", codec: "H264", hardware: false, negociados: ["video/VP9", "video/H264"] };
  assert.equal(codecMelhorQueOSoftware(sw), "video/VP9", "Fluidez com OpenH264: troca para o VP9");
  assert.equal(codecMelhorQueOSoftware({ ...sw, hardware: true }), null, "H.264 na placa de vídeo fica");
  assert.equal(codecMelhorQueOSoftware({ ...sw, hardware: null }), null, "sem saber se é placa, não mexe");
  assert.equal(codecMelhorQueOSoftware({ ...sw, codec: "VP9" }), null, "já no VP9");
  assert.equal(codecMelhorQueOSoftware({ ...sw, modo: "text" }), null, "a Nitidez já usa VP9");
  assert.equal(codecMelhorQueOSoftware({ ...sw, negociados: ["video/H264"] }), null, "o outro lado não fala VP9");

  assert.ok(pedeFluidez({ fonteQps: 60, qps: 22, bps: 6_000_000 }), "jogo na Nitidez: 60 capturados, 22 enviados");
  assert.ok(pedeFluidez({ fonteQps: 30, qps: 18, bps: 2_000_000 }), "vídeo a 30 qps também conta");
  assert.ok(pedeFluidez({ fonteQps: 60, qps: 55, bps: 5_000_000 }), "55 de 60 a 5 Mbps: imagem andando (medido: 51–71% dos segundos fluidos)");
  assert.ok(!pedeFluidez({ fonteQps: 60, qps: 60, bps: 200_000 }), "tela parada capturada a 60 (X11): quadro repetido quase não custa");
  assert.ok(!pedeFluidez({ fonteQps: 60, qps: 58, bps: 1_500_000 }), "rolando um documento: o encoder acompanha e gasta pouco");
  assert.ok(!pedeFluidez({ fonteQps: 8, qps: 2, bps: 4_000_000 }), "tela quase parada (digitando) não é movimento");
  assert.ok(!pedeFluidez({ fonteQps: null, qps: null }), "sem medida, nada");
  console.log("✓ tela: VP9 quando o H.264 sai por software, e Fluidez quando a imagem anda");
}

/* -- relé: a sala ajuda quem tem conexão ruim -- */
const { planejarRele } = await import("../public/js/core/rele.js");
const sala = (spec) => {
  const ids = Object.keys(spec);
  const info = new Map();
  for (const [id, s] of Object.entries(spec)) info.set(id, { cpu: 8, movel: false, fraco: false, ...s, ok: new Set(s.ok ?? ids.filter((x) => x !== id)) });
  return { ids, info };
};

// Ana e Bruno sem conexão direta; Carla (forte) ligada aos dois resgata tudo, nos dois sentidos.
{
  const { ids, info } = sala({ ana: { ok: ["carla", "davi"] }, bruno: { ok: ["carla", "davi"] }, carla: {}, davi: { cpu: 2 } });
  const plano = planejarRele({ ids, info, quebrados: [["ana", "bruno"]] });
  assert.deepEqual(
    plano.map((p) => `${p.h}:${p.de}>${p.para}:${p.papeis.join(",")}`).sort(),
    ["carla:ana>bruno:mic,cam,screen,screenAudio", "carla:bruno>ana:mic,cam,screen,screenAudio"],
    "o resgate vai pelo terceiro mais forte, com voz e vídeo nos dois sentidos",
  );
}
// Sem ninguém ligado aos dois, não há plano (e nada é desligado).
{
  const { ids, info } = sala({ ana: { ok: ["carla"] }, bruno: { ok: [] }, carla: { ok: ["ana"] } });
  assert.equal(planejarRele({ ids, info, quebrados: [["ana", "bruno"]] }).length, 0, "sem caminho reserva, sem plano");
}
// Subida fraca: o vídeo vai uma vez ao ajudante forte, que repassa para os outros. Voz continua direta.
{
  const { ids, info } = sala({ ana: { fraco: true }, bruno: {}, carla: { cpu: 16 }, davi: {} });
  const plano = planejarRele({ ids, info });
  assert.ok(plano.every((p) => p.h === "carla" && p.de === "ana"), "o mais forte ajuda quem é fraco");
  assert.deepEqual(plano.map((p) => p.para).sort(), ["bruno", "davi"], "o ajudante repassa para todos os outros");
  assert.ok(plano.every((p) => p.papeis.join() === "cam,screen"), "só vídeo: a voz não ganha atraso");
}
// Celular em sala de 4+ manda vídeo uma vez só; em sala de 3, não.
{
  const quatro = sala({ ana: { movel: true }, bruno: {}, carla: {}, davi: {} });
  assert.ok(planejarRele(quatro).some((p) => p.de === "ana"), "celular em sala de 4 é ajudado");
  const tres = sala({ ana: { movel: true }, bruno: {}, carla: {} });
  assert.equal(planejarRele(tres).length, 0, "em sala de 3 o celular manda direto");
}
// Celular e fraco nunca ajudam; cada ajudante tem teto de origens (metade dos núcleos).
{
  const { ids, info } = sala({ a: { fraco: true }, b: { fraco: true }, c: { fraco: true }, d: { cpu: 4 }, e: { movel: true } });
  const plano = planejarRele({ ids, info });
  const ajudantes = new Set(plano.map((p) => p.h));
  assert.deepEqual([...ajudantes], ["d"], "só o computador forte ajuda");
  assert.equal(new Set(plano.map((p) => p.de)).size, 2, "4 núcleos: duas origens no máximo");
}
// Mais gente forte, mais ajuda: com dois ajudantes, três fracos são atendidos.
{
  const { ids, info } = sala({ a: { fraco: true }, b: { fraco: true }, c: { fraco: true }, d: { cpu: 4 }, e: { cpu: 4 } });
  assert.equal(new Set(planejarRele({ ids, info }).map((p) => p.de)).size, 3, "dois ajudantes dão conta de três fracos");
}
console.log("✓ relé: resgate de par sem conexão, ajuda a quem tem subida fraca e teto por ajudante");

// Avatar "Vcall": mesma semente, mesmo rosto (é só a semente que trafega).
{
  const { avatarVcall } = await import("../public/js/ui/avatar-vcall.js");
  assert.equal(avatarVcall("ana-123"), avatarVcall("ana-123"), "a mesma semente desenha o mesmo avatar");
  const rostos = new Set(Array.from({ length: 40 }, (_, i) => avatarVcall(`s${i}`)));
  assert.ok(rostos.size >= 38, "sementes diferentes dão rostos diferentes");
  assert.match(avatarVcall(""), /^<svg[^>]*viewBox="0 0 128 128"[\s\S]*<\/svg>$/, "semente vazia ainda desenha");
}
console.log("✓ avatar Vcall: determinístico e variado");

// Avatares de paisagem: cada cena é um estilo que o servidor aceita e desenha
// sempre a mesma vista para a mesma semente.
{
  const { avatarPaisagem, CENAS, estiloDaCena, cenaDoEstilo } = await import("../public/js/ui/avatar-paisagem.js");
  const { normalizeAvatar } = await import("../src/protocol.js");
  for (const cena of CENAS) {
    const estilo = estiloDaCena(cena);
    assert.equal(cenaDoEstilo(estilo), cena, `${estilo} volta para ${cena}`);
    assert.deepEqual(normalizeAvatar({ style: estilo, seed: "ana" }), { style: estilo, seed: "ana" }, `o servidor aceita ${estilo}`);
    assert.equal(avatarPaisagem(cena, "ana"), avatarPaisagem(cena, "ana"), `${cena}: a mesma semente, a mesma vista`);
    assert.match(avatarPaisagem(cena, ""), /^<svg[^>]*viewBox="0 0 128 128"[\s\S]*<\/svg>$/, `${cena}: semente vazia ainda desenha`);
    const vistas = new Set(Array.from({ length: 12 }, (_, i) => avatarPaisagem(cena, `s${i}`)));
    assert.ok(vistas.size >= 11, `${cena}: sementes diferentes dão vistas diferentes`);
  }
}
console.log("✓ avatar de paisagem: dez cenas, determinísticas e aceitas pelo servidor");
