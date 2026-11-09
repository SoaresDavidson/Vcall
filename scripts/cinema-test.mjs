#!/usr/bin/env node
/**
 * scripts/cinema-test.mjs — o "Assistir junto": quem pode ver o quê
 * (src/cinema.js), a fonte Jellyfin (src/cinema-jellyfin.js) e a lógica do
 * player compartilhado (public/js/features/cinema.js).
 *
 * Um Jellyfin de mentira roda aqui mesmo, respondendo como o 10.x/12.x nas
 * rotas que a fonte usa e recusando quem não traz a chave. Ele tem duas
 * bibliotecas, "Filmes" e "Pessoal"; a sala só pode enxergar a primeira.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";

const CHAVE = "chave-do-jellyfin-de-teste-0000000";
const FILMES = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PESSOAL = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILME = "0123456789abcdef0123456789abcdef";
const PRIVADO = "fedcba9876543210fedcba9876543210";
const VIDEO = Buffer.alloc(2_000_000, 7);
const PORTA_JF = 3196;
const PORT = 3098;

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

const ITENS = [
  { Id: FILME, Name: "Filme de teste", RunTimeTicks: 90 * 1e7, pai: FILMES },
  { Id: PRIVADO, Name: "Vídeo pessoal", RunTimeTicks: 30 * 1e7, pai: PESSOAL },
];
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
    const busca = (url.searchParams.get("searchTerm") || "").toLowerCase();
    const achados = ITENS.filter((i) => (!pai || i.pai === pai) && (!ids || i.Id === ids) && (!busca || i.Name.toLowerCase().includes(busca)));
    return enviarJson({ Items: [...achados.map(({ pai: _, ...i }) => i), { Id: "nao-e-um-id", Name: "x" }], TotalRecordCount: achados.length });
  }
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
  assert.deepEqual(fontes, [{ id: "jellyfin", nome: "Jellyfin" }]);
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
  const busca = await fetch(`${BASE}/cinema/jellyfin/itens?f=${ficha}&busca=`);
  const textoBusca = await busca.text();
  assert.equal(busca.status, 200);
  assert.deepEqual(JSON.parse(textoBusca).itens, [{ id: FILME, nome: "Filme de teste", tipo: "video", segundos: 90 }]);
  assert.ok(!textoBusca.includes(CHAVE));
  ok("a lista mostra só a biblioteca escolhida, com id, nome, tipo e duração");

  assert.equal(await status(`/cinema/jellyfin/video/${PRIVADO}?f=${ficha}`), 404);
  ok("vídeo de outra biblioteca é recusado mesmo com o id certo");

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
  assert.deepEqual(daSala.fontes, [{ id: "jellyfin", nome: "Jellyfin" }]);
  assert.equal(daSala.disponivel, true);
  assert.deepEqual(itens.map((i) => [i.fonte, i.id, i.tipo]), [["jellyfin", FILME, "video"]]);
  assert.match(await daSala.enderecoDoVideo(itens[0]), new RegExp(`^/cinema/jellyfin/video/${FILME}\\?f=`));
  de_novo.ws.close();
  ok("a lógica do player pega ficha e fontes, lista a biblioteca e monta o endereço do vídeo");

  console.log(`\n${passou} verificações do Assistir junto passaram.`);
} finally {
  server.close();
  jellyfin.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
