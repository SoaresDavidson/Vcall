#!/usr/bin/env node
/**
 * scripts/cinema-test.mjs — o "Assistir junto": quem pode ver o quê
 * (src/cinema.js), a fonte Jellyfin (src/cinema-jellyfin.js) e a lógica do
 * player compartilhado (public/js/features/cinema.js).
 *
 * Um Jellyfin de mentira roda aqui mesmo, respondendo como o 10.x/12.x nas
 * rotas que a fonte usa e recusando quem não traz a chave. Ele tem duas
 * bibliotecas, "Filmes" (um filme e uma série com temporada e episódios, com
 * capa e legenda) e "Pessoal"; a sala só pode enxergar a primeira.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";

const CHAVE = "chave-do-jellyfin-de-teste-0000000";
const FILMES = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PESSOAL = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILME = "0123456789abcdef0123456789abcdef";
const PRIVADO = "fedcba9876543210fedcba9876543210";
const SERIE = "1111111111111111111111111111111a";
const TEMP = "1111111111111111111111111111111b";
const EP1 = "1111111111111111111111111111111c";
const EP2 = "1111111111111111111111111111111d";
const SERIE_PRIVADA = "2222222222222222222222222222222a";
const EP_PRIVADO = "2222222222222222222222222222222b";
const CAPA_FALSA = "3333333333333333333333333333333a"; // a "imagem" é uma página HTML
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOlá\n";
const VIDEO = Buffer.alloc(2_000_000, 7);
const PORTA_JF = 3122;
const PORT = 3121;

// A configuração é lida na importação: o ambiente vem antes.
process.env.JELLYFIN_URL = `http://127.0.0.1:${PORTA_JF}`;
process.env.JELLYFIN_KEY = CHAVE;
process.env.JELLYFIN_BIBLIOTECA = "filmes"; // sem diferenciar maiúsculas
const { createHttpServer } = await import("../src/http.js");
const { attachSignaling } = await import("../src/signaling.js");
const { RoomRegistry } = await import("../src/rooms.js");
const { Cinema } = await import("../public/js/features/cinema.js");
const { EstadoJogos } = await import("../public/js/features/jogos.js");

let passou = 0;
const ok = (nome) => {
  passou += 1;
  console.log(`✓ ${nome}`);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------- o Jellyfin de mentira ---------------------- */

const pedidosImagem = [];
const CAPA = { Primary: "tag" };
const ITENS = [
  { Id: FILME, Name: "Filme de teste", Type: "Movie", RunTimeTicks: 90 * 1e7, ImageTags: CAPA, Overview: "Uma sinopse.", pai: FILMES },
  { Id: SERIE, Name: "Série de teste", Type: "Series", ImageTags: CAPA, pai: FILMES },
  { Id: TEMP, Name: "Season 1", Type: "Season", IndexNumber: 1, SeriesId: SERIE, ImageTags: {}, pai: SERIE },
  { Id: EP2, Name: "Segundo", Type: "Episode", IndexNumber: 2, ParentIndexNumber: 1, SeasonId: TEMP, RunTimeTicks: 20 * 1e7, ImageTags: CAPA, pai: TEMP },
  { Id: EP1, Name: "Primeiro", Type: "Episode", IndexNumber: 1, ParentIndexNumber: 1, SeasonId: TEMP, RunTimeTicks: 20 * 1e7, ImageTags: CAPA, Overview: "O começo.", pai: TEMP, Segredo: "x" },
  { Id: CAPA_FALSA, Name: "Capa falsa", Type: "Movie", RunTimeTicks: 1e7, ImageTags: CAPA, pai: FILMES },
  { Id: PRIVADO, Name: "Vídeo pessoal", Type: "Video", RunTimeTicks: 30 * 1e7, ImageTags: CAPA, pai: PESSOAL },
  { Id: SERIE_PRIVADA, Name: "Série pessoal", Type: "Series", ImageTags: CAPA, pai: PESSOAL },
  { Id: EP_PRIVADO, Name: "Episódio pessoal", Type: "Episode", IndexNumber: 1, SeasonId: SERIE_PRIVADA, ImageTags: CAPA, pai: SERIE_PRIVADA },
];
const FLUXOS = [
  { Type: "Subtitle", Index: 0, Language: "por", DisplayTitle: "Portuguese - SUBRIP - External", IsTextSubtitleStream: true, Path: "/segredo/legenda.srt" },
  { Type: "Video", Index: 1, Codec: "h264" },
  { Type: "Subtitle", Index: 3, DisplayTitle: "Imagem - PGS", IsTextSubtitleStream: false },
];
const filhosDe = (id, recursivo) => ITENS.filter((i) => i.pai === id).flatMap((i) => (recursivo ? [i, ...filhosDe(i.Id, true)] : [i]));
const pedidosAoJellyfin = [];
const jellyfin = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  pedidosAoJellyfin.push(url.pathname);
  if (!(req.headers.authorization || "").includes(`Token="${CHAVE}"`)) return res.writeHead(401).end();
  const enviarJson = (v) => (res.writeHead(200, { "Content-Type": "application/json" }), res.end(JSON.stringify(v)));
  if (url.pathname === "/Library/VirtualFolders") {
    return enviarJson([
      { Name: "Filmes", ItemId: FILMES, CollectionType: "movies" },
      { Name: "Pessoal", ItemId: PESSOAL, CollectionType: "homevideos" },
    ]);
  }
  if (url.pathname === "/Items") {
    const pai = url.searchParams.get("ParentId");
    const ids = url.searchParams.get("Ids");
    const tipos = (url.searchParams.get("IncludeItemTypes") || "").split(",").filter(Boolean);
    const busca = (url.searchParams.get("searchTerm") || "").toLowerCase();
    const base = pai ? filhosDe(pai, url.searchParams.get("Recursive") === "true") : ITENS;
    const achados = base.filter((i) => (!ids || i.Id === ids) && (!tipos.length || tipos.includes(i.Type)) && (!busca || i.Name.toLowerCase().includes(busca)));
    if (url.searchParams.get("SortBy")?.startsWith("ParentIndexNumber")) achados.sort((a, b) => (a.IndexNumber || 0) - (b.IndexNumber || 0));
    const fluxos = (url.searchParams.get("Fields") || "").includes("MediaStreams");
    return enviarJson({
      Items: [...achados.map(({ pai: _, ...i }) => (fluxos ? { ...i, MediaStreams: FLUXOS } : i)), { Id: "nao-e-um-id", Name: "x", Type: "Movie" }, { Id: "4444444444444444444444444444444a", Name: "Foto", Type: "Photo" }],
      TotalRecordCount: achados.length,
    });
  }
  const imagem = url.pathname.match(/^\/Items\/([a-f0-9]{32})\/Images\/Primary$/);
  if (imagem) {
    pedidosImagem.push(url.search);
    if (imagem[1] === CAPA_FALSA) return res.writeHead(200, { "Content-Type": "text/html" }).end("<script>alert(1)</script>");
    return res.writeHead(200, { "Content-Type": "image/png", "X-Interno": CHAVE }).end(PNG);
  }
  const legenda = url.pathname.match(/^\/Videos\/([a-f0-9]{32})\/[a-f0-9]{32}\/Subtitles\/(\d+)\/Stream\.vtt$/);
  if (legenda) return res.writeHead(200, { "Content-Type": "text/vtt" }).end(VTT);
  const video = url.pathname.match(/^\/Videos\/([a-f0-9]{32})\/stream$/);
  if (video) {
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const ini = r ? Number(r[1]) : 0;
    const fim = r && r[2] ? Number(r[2]) : VIDEO.length - 1;
    res.writeHead(r ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": fim - ini + 1,
      "Accept-Ranges": "bytes",
      ...(r ? { "Content-Range": `bytes ${ini}-${fim}/${VIDEO.length}` } : {}),
      // Cabeçalho que o Jellyfin real não manda, mas que não pode vazar se mandar.
      "X-Interno": CHAVE,
    });
    return res.end(VIDEO.subarray(ini, fim + 1));
  }
  if (url.pathname === "/Users") return enviarJson([{ Name: "admin" }]);
  res.writeHead(404).end();
});
await new Promise((r) => jellyfin.listen(PORTA_JF, "127.0.0.1", r));

/* --------------------------- a sala --------------------------- */

const registry = new RoomRegistry();
const server = createHttpServer({ registry });
attachSignaling(server, { registry, graca: 300 });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PORT}`;

function entrar(sala, sessao, hostKey = undefined) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: BASE } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", room: sala, session: sessao, hostKey, device: `aparelho${sessao}`, profile: { name: sessao.slice(0, 8) } })));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "welcome") resolve({ ws, id: m.you.id });
    });
    ws.on("error", reject);
  });
}
const pedirFicha = (sala, sessao) => fetch(`${BASE}/cinema/ficha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sala, sessao }) });
const fichaDe = async (sala, sessao) => (await (await pedirFicha(sala, sessao)).json()).ficha;
const status = async (caminho, init) => (await fetch(`${BASE}${caminho}`, init)).status;

const SALA = "salaassistirjunto0001";
const HOST = "sessaodoanfitriao0000001";
const CONVIDADO = "sessaodoconvidado0000001";

try {
  /* ----------------------------- ficha ----------------------------- */
  assert.equal((await pedirFicha(SALA, HOST)).status, 403);
  ok("sem estar na sala, não há ficha");

  const anfitriao = await entrar(SALA, HOST, "chavedoanfitriao00000001");
  const r = await pedirFicha(SALA, HOST);
  assert.equal(r.status, 200);
  const { ficha, fontes } = await r.json();
  assert.match(ficha, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(fontes, [{ id: "jellyfin", nome: "Jellyfin", legendas: true }]);
  ok("quem entrou pela sinalização recebe a ficha e a lista de fontes");

  assert.equal((await pedirFicha(SALA, "outrasessao00000000000001")).status, 403);
  assert.equal((await pedirFicha("outrasala0000000000001", HOST)).status, 403);
  ok("sessão de fora ou sala errada continuam sem ficha");

  /* ----------------------------- rotas ----------------------------- */
  assert.equal(await status("/cinema/jellyfin/itens"), 403);
  assert.equal(await status(`/cinema/jellyfin/video/${FILME}?f=inventada000000000000000000000000`), 403);
  ok("sem ficha válida, nada da biblioteca");

  const antes = pedidosAoJellyfin.length;
  assert.equal(await status(`/cinema/jellyfin/Users?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/outra/itens?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/jellyfin/video/${FILME}/mais?f=${ficha}`), 404);
  const cru = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port: PORT, path: `/cinema/jellyfin/video/../../Users?f=${ficha}` }, (res) => (res.resume(), resolve(res.statusCode))),
  );
  assert.equal(cru, 404);
  assert.equal(await status(`/cinema/jellyfin/video/${FILME}?f=${ficha}`, { method: "DELETE" }), 405);
  assert.equal(pedidosAoJellyfin.length, antes, "nada fora da lista pode chegar ao Jellyfin");
  ok("rota fora da lista, fonte desconhecida, travessia e método errado nem chegam ao Jellyfin");

  /* ---------------------- só a biblioteca escolhida ---------------------- */
  const listar = async (q) => {
    const r = await fetch(`${BASE}/cinema/jellyfin/itens?f=${ficha}&${q}`);
    const texto = await r.text();
    assert.ok(!texto.includes(CHAVE));
    return { status: r.status, itens: r.status === 200 ? JSON.parse(texto).itens : null, texto };
  };
  const primeiro = await listar("busca=");
  assert.equal(primeiro.status, 200);
  assert.deepEqual(primeiro.itens, [
    { id: FILME, nome: "Filme de teste", tipo: "video", segundos: 90, imagem: true, sinopse: "Uma sinopse." },
    { id: SERIE, nome: "Série de teste", tipo: "grupo", imagem: true },
    { id: CAPA_FALSA, nome: "Capa falsa", tipo: "video", segundos: 1, imagem: true },
  ]);
  ok("o primeiro nível mostra só a biblioteca escolhida: filme (video) e série (grupo), com capa, e nada de foto ou id estranho");

  assert.deepEqual((await listar(`pai=${SERIE}`)).itens, [{ id: TEMP, nome: "Season 1", tipo: "grupo" }]);
  const eps = await listar(`pai=${TEMP}`);
  assert.deepEqual(eps.itens, [
    { id: EP1, nome: "1. Primeiro", tipo: "video", segundos: 20, imagem: true, sinopse: "O começo.", pai: TEMP },
    { id: EP2, nome: "2. Segundo", tipo: "video", segundos: 20, imagem: true, pai: TEMP },
  ]);
  assert.ok(!eps.texto.includes("Segredo") && !eps.texto.includes("/segredo"), "nada cru do Jellyfin");
  assert.equal((await listar(`pai=${FILMES}`)).status, 200, "a própria biblioteca pode ser o pai");
  ok("série → temporada → episódios, na ordem do número, com 1. Título e só os campos que a tela usa");

  assert.deepEqual((await listar("busca=prim")).itens.map((i) => i.id), [EP1]);
  assert.deepEqual((await listar("busca=e")).itens.map((i) => i.id).sort(), [EP1, EP2, FILME, SERIE].sort());
  assert.deepEqual((await listar("busca=pessoal")).itens, []);
  ok("a busca acha filmes, séries e episódios, e só dentro da biblioteca");

  for (const fora of [SERIE_PRIVADA, PESSOAL, PRIVADO, EP_PRIVADO]) assert.equal((await listar(`pai=${fora}`)).status, 404, `pai ${fora}`);
  assert.equal((await listar("pai=../../Users")).status, 400);
  ok("pai de fora da biblioteca (série, a outra biblioteca, vídeo) é recusado");

  const capa = await fetch(`${BASE}/cinema/jellyfin/imagem/${FILME}?f=${ficha}`);
  assert.equal(capa.status, 200);
  assert.equal(capa.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await capa.arrayBuffer()), PNG);
  assert.equal(capa.headers.get("x-interno"), null);
  assert.ok(pedidosImagem.at(-1).includes("maxWidth=400"), "pede a capa redimensionada");
  assert.equal(await status(`/cinema/jellyfin/imagem/${EP1}?f=${ficha}`), 200, "capa de episódio");
  ok("a capa vem redimensionada, sem cabeçalho da chave");

  assert.equal(await status(`/cinema/jellyfin/imagem/${PRIVADO}?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/jellyfin/imagem/${SERIE_PRIVADA}?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/jellyfin/imagem/${CAPA_FALSA}?f=${ficha}`), 404, "só Content-Type de imagem passa");
  assert.equal(await status(`/cinema/jellyfin/imagem/${FILME}`), 403);
  ok("capa de fora da biblioteca, que não é imagem ou sem ficha é recusada");

  const leg = await fetch(`${BASE}/cinema/jellyfin/legendas/${EP1}?f=${ficha}`);
  const textoLeg = await leg.text();
  assert.equal(leg.status, 200);
  assert.deepEqual(JSON.parse(textoLeg).legendas, [{ indice: 0, nome: "Portuguese - SUBRIP - External" }]);
  assert.ok(!textoLeg.includes("/segredo"), "o caminho do arquivo não sai");
  const vtt = await fetch(`${BASE}/cinema/jellyfin/legenda/${EP1}/0?f=${ficha}`);
  assert.equal(vtt.status, 200);
  assert.match(vtt.headers.get("content-type"), /^text\/vtt/);
  assert.equal(await vtt.text(), VTT);
  ok("a lista de legendas e o WebVTT de um episódio chegam, só as de texto");

  assert.equal(await status(`/cinema/jellyfin/legenda/${EP1}/3?f=${ficha}`), 404, "legenda de imagem (PGS) não é servida");
  assert.equal(await status(`/cinema/jellyfin/legenda/${EP1}/abc?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/jellyfin/legenda/${EP1}/0/0?f=${ficha}`), 404);
  for (const fora of [PRIVADO, EP_PRIVADO]) {
    assert.equal(await status(`/cinema/jellyfin/legendas/${fora}?f=${ficha}`), 404);
    assert.equal(await status(`/cinema/jellyfin/legenda/${fora}/0?f=${ficha}`), 404);
  }
  assert.equal(await status(`/cinema/jellyfin/legendas/${EP1}`), 403);
  assert.equal(await status(`/cinema/jellyfin/legenda/${EP1}/0?f=inventada000000000000000000000000`), 403);
  ok("legenda inexistente, de imagem, de fora da biblioteca ou sem ficha é recusada");

  // Fonte sem legenda (a pasta de vídeos): não implementa, e a rota responde 404.
  const { fonteJellyfin } = await import("../src/cinema-jellyfin.js");
  const { legendas, legenda } = fonteJellyfin;
  delete fonteJellyfin.legendas;
  delete fonteJellyfin.legenda;
  assert.equal(await status(`/cinema/jellyfin/legendas/${EP1}?f=${ficha}`), 404);
  assert.equal(await status(`/cinema/jellyfin/legenda/${EP1}/0?f=${ficha}`), 404);
  Object.assign(fonteJellyfin, { legendas, legenda });
  ok("fonte que não implementa legenda responde 404 nas rotas de legenda");

  const v = await fetch(`${BASE}/cinema/jellyfin/video/${FILME}?f=${ficha}`, { headers: { Range: "bytes=1000000-1000999" } });
  const pedaco = Buffer.from(await v.arrayBuffer());
  assert.equal(v.status, 206);
  assert.equal(pedaco.length, 1000);
  assert.equal(v.headers.get("content-range"), `bytes 1000000-1000999/${VIDEO.length}`);
  assert.equal(v.headers.get("x-interno"), null);
  assert.ok(![...v.headers.values()].some((h) => h.includes(CHAVE)));
  ok("o vídeo da biblioteca atende Range e nenhum cabeçalho leva a chave");

  /* ------------------- a ficha é da pessoa, não da sala ------------------- */
  const convidado = await entrar(SALA, CONVIDADO);
  const fichaDoConvidado = await fichaDe(SALA, CONVIDADO);
  assert.equal(await status(`/cinema/jellyfin/itens?f=${fichaDoConvidado}`), 200);
  anfitriao.ws.send(JSON.stringify({ t: "moderate", action: "kick", target: convidado.id }));
  await espera(200);
  assert.equal(await status(`/cinema/jellyfin/itens?f=${fichaDoConvidado}`), 403);
  assert.equal(await status(`/cinema/jellyfin/video/${FILME}?f=${fichaDoConvidado}`), 403);
  assert.equal(await status(`/cinema/jellyfin/itens?f=${ficha}`), 200, "quem ficou continua vendo");
  ok("removido pelo anfitrião perde o acesso na hora, com a sala ainda cheia");

  const outro = await entrar(SALA, "sessaodequemsai000000001");
  const fichaDeQuemSai = await fichaDe(SALA, "sessaodequemsai000000001");
  outro.ws.send(JSON.stringify({ t: "leave" }));
  outro.ws.close();
  await espera(150);
  assert.equal(await status(`/cinema/jellyfin/itens?f=${fichaDeQuemSai}`), 403);
  ok("quem sai da chamada perde o acesso na hora");

  anfitriao.ws.send(JSON.stringify({ t: "leave" }));
  anfitriao.ws.close();
  await espera(150);
  assert.equal(await status(`/cinema/jellyfin/itens?f=${ficha}`), 403);
  ok("com a sala vazia, nenhuma ficha vale");

  /* ------------------------- o player ------------------------- */
  let relogioServidor = 1_000_000;
  const estadoA = new EstadoJogos({ eu: "a" });
  const estadoB = new EstadoJogos({ eu: "b" });
  estadoA.on("enviar", (lote) => estadoB.aplicar(lote));
  estadoB.on("enviar", (lote) => estadoA.aplicar(lote));
  const opcoes = { agora: () => relogioServidor, sala: () => SALA, sessao: () => HOST };
  const ana = new Cinema(estadoA, opcoes);
  const bia = new Cinema(estadoB, opcoes);

  ana.escolher({ fonte: "jellyfin", id: FILME, nome: "Filme de teste", segundos: 90 });
  assert.deepEqual([bia.item().fonte, bia.item().id], ["jellyfin", FILME]);
  assert.equal(bia.tempo().tocando, false);
  bia.tocar(10);
  relogioServidor += 5_000;
  assert.equal(ana.posicaoAgora(), 15);
  assert.equal(bia.posicaoAgora(), 15);
  ok("play de uma pessoa vale para a outra, no mesmo ponto");

  ana.irPara(60);
  assert.equal(bia.tempo().tocando, true, "pular não pausa");
  relogioServidor += 2_000;
  assert.equal(bia.posicaoAgora(), 62);
  bia.pausar(62);
  relogioServidor += 30_000;
  assert.equal(ana.posicaoAgora(), 62);
  ok("pular e pausar seguem para todos; pausado, o ponto não anda");

  ana.tocar(85);
  relogioServidor += 60_000;
  assert.equal(bia.posicaoAgora(), 90, "não passa do fim do vídeo");
  ok("o ponto para no fim do vídeo");

  const estadoC = new EstadoJogos({ eu: "c" });
  estadoC.aplicar(estadoA.instantaneo());
  const caio = new Cinema(estadoC, opcoes);
  assert.equal(caio.posicaoAgora(), ana.posicaoAgora());
  ok("quem chega no meio cai no mesmo ponto");

  bia.escolher({ fonte: "../x", id: FILME, nome: "x" });
  assert.equal(ana.item().fonte, "jellyfin", "fonte inválida não entra no estado");
  bia.fechar();
  assert.equal(ana.item(), null);
  ok("fonte inválida é ignorada; tirar o vídeo tira para todos");

  // A lógica conversa com o servidor de verdade: ficha, fontes, biblioteca e vídeo.
  const de_novo = await entrar(SALA, HOST);
  const daSala = new Cinema(new EstadoJogos({ eu: "d" }), { ...opcoes, agora: Date.now, buscar: (u, o) => fetch(new URL(u, BASE), o) });
  const itens = await daSala.biblioteca({ fonte: "jellyfin" });
  assert.deepEqual(daSala.fontes, [{ id: "jellyfin", nome: "Jellyfin", legendas: true }]);
  assert.equal(daSala.disponivel, true);
  assert.deepEqual(itens.map((i) => [i.fonte, i.id, i.tipo]), [["jellyfin", FILME, "video"], ["jellyfin", SERIE, "grupo"], ["jellyfin", CAPA_FALSA, "video"]]);
  assert.match(await daSala.enderecoDoVideo(itens[0]), new RegExp(`^/cinema/jellyfin/video/${FILME}\\?f=`));
  assert.match(daSala.enderecoDaImagem(itens[0]), new RegExp(`^/cinema/jellyfin/imagem/${FILME}\\?f=`));
  assert.deepEqual(await daSala.legendas({ fonte: "jellyfin", id: EP1 }), [{ indice: 0, nome: "Portuguese - SUBRIP - External" }]);
  assert.deepEqual(await daSala.legendas({ fonte: "jellyfin", id: PRIVADO }), [], "de fora da biblioteca: nada");
  assert.match(daSala.enderecoDaLegenda({ fonte: "jellyfin", id: EP1 }, 0), new RegExp(`^/cinema/jellyfin/legenda/${EP1}/0\\?f=`));
  ok("a lógica do player pega ficha e fontes, lista a biblioteca, monta os endereços do vídeo, da capa e da legenda");

  /* ---- próximo episódio: todos terminam quase juntos, o estado final é um só ---- */
  const rede = { agora: () => relogioServidor, sala: () => SALA, sessao: () => HOST, buscar: (u, o) => fetch(new URL(u, BASE), o) };
  const eA = new EstadoJogos({ eu: "a" });
  const eB = new EstadoJogos({ eu: "b" });
  const eC = new EstadoJogos({ eu: "c" });
  const ligar = (x, ...outros) => x.on("enviar", (lote) => outros.forEach((o) => o.aplicar(lote)));
  ligar(eA, eB, eC);
  ligar(eB, eA, eC);
  ligar(eC, eA, eB);
  const [pA, pB, pC] = [new Cinema(eA, rede), new Cinema(eB, rede), new Cinema(eC, rede)];
  const [ep1, ep2] = (await pA.biblioteca({ fonte: "jellyfin", pai: TEMP })).filter((i) => i.tipo === "video");
  pA.escolher(ep1);
  assert.deepEqual([pB.item().pai, pB.item().img, pB.item().sin, pB.item().seg], [TEMP, true, "O começo.", 20], "o item leva temporada, capa e sinopse para a sala");
  pA.tocar(19);
  const fim = pA.item();
  const rodada = await Promise.all([pA.avancar(fim), pB.avancar(fim), pC.avancar(fim)]);
  assert.equal(rodada.filter(Boolean).length, 1, "só uma pessoa escreve o próximo");
  for (const p of [pA, pB, pC]) {
    assert.equal(p.item().id, EP2);
    assert.equal(p.tempo().tocando, true);
    assert.equal(p.tempo().pos, 0);
  }
  ok("três pessoas terminam o episódio juntas: o seguinte entra para todos, uma vez só");

  assert.equal(await pB.avancar(fim), false);
  assert.equal(pB.item().id, EP2, "quem termina atrasado não pula o episódio 2");
  ok("quem termina depois que outro já avançou não faz nada");

  pA.tocar(19);
  assert.equal(await pA.avancar(pA.item()), false);
  assert.equal(pA.item().id, EP2);
  assert.equal(pB.tempo().tocando, false, "sem seguinte, só para no fim");
  assert.equal(pB.tempo().pos, 20);
  ok("no último episódio da temporada, o vídeo só pausa no fim");

  pA.escolher(itens[0]);
  assert.equal(await pA.avancar(pA.item()), false);
  assert.equal(pB.item().id, FILME, "filme (sem temporada) não avança");
  de_novo.ws.close();
  ok("filme não tem próximo");

  console.log(`\n${passou} verificações do Assistir junto passaram.`);
} finally {
  server.close();
  jellyfin.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
