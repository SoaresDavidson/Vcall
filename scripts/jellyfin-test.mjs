#!/usr/bin/env node
/**
 * scripts/jellyfin-test.mjs — o "Assistir junto": o proxy do Jellyfin de quem
 * hospeda (src/jellyfin.js) e a lógica do player compartilhado
 * (public/js/features/cinema.js).
 *
 * Um Jellyfin de mentira roda aqui mesmo, respondendo como o 10.x/12.x nas
 * rotas que o proxy usa e recusando quem não traz a chave. O teste confere o
 * que importa: a chave nunca chega ao navegador, só quem está na sala recebe
 * ficha, só a lista fechada de rotas passa, o vídeo atende Range, e o ponto do
 * vídeo é o mesmo para todos (relógio do servidor, não o de cada um).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";

const CHAVE = "chave-do-jellyfin-de-teste-0000000";
const ITEM = "0123456789abcdef0123456789abcdef";
const VIDEO = Buffer.alloc(2_000_000, 7);
const PORTA_JF = 3196;
const PORT = 3098;

// A configuração é lida na importação: o ambiente vem antes.
process.env.JELLYFIN_URL = `http://127.0.0.1:${PORTA_JF}`;
process.env.JELLYFIN_KEY = CHAVE;
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

const pedidosAoJellyfin = [];
const jellyfin = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  pedidosAoJellyfin.push(url.pathname);
  if (!(req.headers.authorization || "").includes(`Token="${CHAVE}"`)) return res.writeHead(401).end();
  if (url.pathname === "/Items") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ Items: [{ Id: ITEM, Name: "Filme de teste", RunTimeTicks: 90 * 1e7 }, { Id: "nao-e-um-id", Name: "x" }] }));
  }
  if (url.pathname === `/Videos/${ITEM}/stream`) {
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
  if (url.pathname === "/Users") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('[{"Name":"admin"}]');
  }
  res.writeHead(404).end();
});
await new Promise((r) => jellyfin.listen(PORTA_JF, "127.0.0.1", r));

/* --------------------------- a sala --------------------------- */

const registry = new RoomRegistry();
const server = createHttpServer({ registry });
attachSignaling(server, { registry, graca: 300 });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PORT}`;

function entrar(sala, sessao) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: BASE } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", room: sala, session: sessao, profile: { name: "teste" } })));
    ws.on("message", (d) => JSON.parse(String(d)).t === "welcome" && resolve(ws));
    ws.on("error", reject);
  });
}
const pedirFicha = (sala, sessao) => fetch(`${BASE}/jellyfin/ficha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sala, sessao }) });

const SALA = "salaassistirjunto0001";
const SESSAO = "sessaoassistirjunto000001";

try {
  /* ----------------------------- ficha ----------------------------- */
  assert.equal((await pedirFicha(SALA, SESSAO)).status, 403);
  ok("sem estar na sala, não há ficha");

  const ws = await entrar(SALA, SESSAO);
  const r = await pedirFicha(SALA, SESSAO);
  assert.equal(r.status, 200);
  const { ficha } = await r.json();
  assert.match(ficha, /^[A-Za-z0-9_-]{32}$/);
  ok("quem entrou pela sinalização recebe a ficha");

  assert.equal((await pedirFicha(SALA, "outrasessao00000000000001")).status, 403);
  assert.equal((await pedirFicha("outrasala0000000000001", SESSAO)).status, 403);
  ok("sessão de fora ou sala errada continuam sem ficha");

  /* ----------------------------- rotas ----------------------------- */
  assert.equal((await fetch(`${BASE}/jellyfin/itens`)).status, 403);
  assert.equal((await fetch(`${BASE}/jellyfin/video/${ITEM}?f=inventada000000000000000000000000`)).status, 403);
  ok("sem ficha válida, nada da biblioteca");

  const antes = pedidosAoJellyfin.length;
  assert.equal((await fetch(`${BASE}/jellyfin/Users?f=${ficha}`)).status, 404);
  const cru = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port: PORT, path: `/jellyfin/video/../../Users?f=${ficha}` }, (res) => (res.resume(), resolve(res.statusCode))),
  );
  assert.equal(cru, 404);
  assert.equal((await fetch(`${BASE}/jellyfin/video/${ITEM}?f=${ficha}`, { method: "DELETE" })).status, 405);
  assert.equal(pedidosAoJellyfin.length, antes, "nada fora da lista pode chegar ao Jellyfin");
  ok("rota fora da lista, travessia e método errado nem chegam ao Jellyfin");

  const busca = await fetch(`${BASE}/jellyfin/itens?f=${ficha}&busca=filme`);
  const textoBusca = await busca.text();
  assert.equal(busca.status, 200);
  assert.deepEqual(JSON.parse(textoBusca).itens, [{ id: ITEM, nome: "Filme de teste", segundos: 90 }]);
  assert.ok(!textoBusca.includes(CHAVE));
  ok("a busca devolve só id, nome e duração (item com id estranho fica de fora)");

  const v = await fetch(`${BASE}/jellyfin/video/${ITEM}?f=${ficha}`, { headers: { Range: "bytes=1000000-1000999" } });
  const pedaco = Buffer.from(await v.arrayBuffer());
  assert.equal(v.status, 206);
  assert.equal(pedaco.length, 1000);
  assert.equal(v.headers.get("content-range"), `bytes 1000000-1000999/${VIDEO.length}`);
  assert.equal(v.headers.get("x-interno"), null);
  assert.ok(![...v.headers.values()].some((h) => h.includes(CHAVE)));
  ok("o vídeo atende Range e nenhum cabeçalho leva a chave");

  /* ------------------- a sala esvazia, a ficha cai ------------------- */
  ws.send(JSON.stringify({ t: "leave" }));
  ws.close();
  await espera(150);
  assert.equal((await fetch(`${BASE}/jellyfin/itens?f=${ficha}`)).status, 403);
  ok("a ficha deixa de valer quando a sala esvazia");

  /* ------------------------- o player ------------------------- */
  let relogioServidor = 1_000_000;
  const estadoA = new EstadoJogos({ eu: "a" });
  const estadoB = new EstadoJogos({ eu: "b" });
  estadoA.on("enviar", (lote) => estadoB.aplicar(lote));
  estadoB.on("enviar", (lote) => estadoA.aplicar(lote));
  const ana = new Cinema(estadoA, { agora: () => relogioServidor, sala: () => SALA, sessao: () => SESSAO });
  const bia = new Cinema(estadoB, { agora: () => relogioServidor, sala: () => SALA, sessao: () => SESSAO });

  ana.escolher({ id: ITEM, nome: "Filme de teste", segundos: 90 });
  assert.equal(bia.item().id, ITEM);
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

  // Quem chega no meio recebe só o estado e calcula o mesmo ponto.
  const estadoC = new EstadoJogos({ eu: "c" });
  estadoC.aplicar(estadoA.instantaneo());
  const caio = new Cinema(estadoC, { agora: () => relogioServidor, sala: () => SALA, sessao: () => SESSAO });
  assert.equal(caio.posicaoAgora(), ana.posicaoAgora());
  ok("quem chega no meio cai no mesmo ponto");

  bia.fechar();
  assert.equal(ana.item(), null);
  ok("tirar o vídeo tira para todos");

  // A lógica conversa com o servidor de verdade: ficha, biblioteca e vídeo.
  const ws2 = await entrar(SALA, SESSAO);
  const daSala = new Cinema(new EstadoJogos({ eu: "d" }), {
    agora: Date.now,
    sala: () => SALA,
    sessao: () => SESSAO,
    buscar: (u, o) => fetch(new URL(u, BASE), o),
  });
  const itens = await daSala.biblioteca("");
  assert.equal(itens[0]?.id, ITEM);
  assert.equal(daSala.disponivel, true);
  assert.match(await daSala.enderecoDoVideo(ITEM), new RegExp(`^/jellyfin/video/${ITEM}\\?f=`));
  ws2.close();
  ok("a lógica do player pega ficha, lista a biblioteca e monta o endereço do vídeo");

  console.log(`\n${passou} verificações do Assistir junto passaram.`);
} finally {
  server.close();
  jellyfin.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
