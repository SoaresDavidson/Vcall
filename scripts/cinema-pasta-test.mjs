#!/usr/bin/env node
/**
 * scripts/cinema-pasta-test.mjs — a fonte "Pasta de vídeos" do Assistir
 * junto (src/cinema-pasta.js) pelo servidor de verdade, com a ficha de quem
 * está na sala.
 *
 * A pasta de teste tem vídeos de mentira (só bytes), uma subpasta, um arquivo
 * oculto, um .txt e um atalho para um vídeo que mora FORA da pasta.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const PORT = 3112;
const TMP = mkdtempSync(path.join(os.tmpdir(), "vcall-pasta-"));
const PASTA = path.join(TMP, "videos");
const FORA = path.join(TMP, "fora");
const BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
mkdirSync(path.join(PASTA, "Serie", "T1"), { recursive: true });
mkdirSync(path.join(PASTA, ".segredos"));
mkdirSync(FORA);
writeFileSync(path.join(PASTA, "Filme Ação.mp4"), BYTES);
writeFileSync(path.join(PASTA, "clipe.webm"), BYTES);
writeFileSync(path.join(PASTA, "Serie", "ep1.mkv"), BYTES);
writeFileSync(path.join(PASTA, "Serie", "T1", "ep2.mov"), BYTES);
writeFileSync(path.join(PASTA, ".oculto.mp4"), BYTES);
writeFileSync(path.join(PASTA, ".segredos", "x.mp4"), BYTES);
writeFileSync(path.join(PASTA, "notas.txt"), "nada de vídeo");
writeFileSync(path.join(FORA, "proibido.mp4"), BYTES);
symlinkSync(path.join(FORA, "proibido.mp4"), path.join(PASTA, "atalho.mp4"));
symlinkSync(FORA, path.join(PASTA, "pasta-de-fora"));
symlinkSync(path.join(PASTA, "clipe.webm"), path.join(PASTA, "atalho-interno.webm"));

// A pasta é lida na importação, como no servidor real.
process.env.PASTA_VIDEOS = PASTA;
const { createHttpServer } = await import("../src/http.js");
const { attachSignaling } = await import("../src/signaling.js");
const { RoomRegistry } = await import("../src/rooms.js");
const { definirPasta, pastaAtual } = await import("../src/cinema-pasta.js");

let passou = 0;
const ok = (nome) => {
  passou += 1;
  console.log(`✓ ${nome}`);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const registry = new RoomRegistry();
const server = createHttpServer({ registry });
attachSignaling(server, { registry, graca: 300 });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${PORT}`;

function entrar(sala, sessao) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: BASE } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", room: sala, session: sessao, device: `aparelho${sessao}`, profile: { name: sessao.slice(0, 8) } })));
    ws.on("message", (d) => {
      if (JSON.parse(String(d)).t === "welcome") resolve(ws);
    });
    ws.on("error", reject);
  });
}
const fichaDe = async (sala, sessao) =>
  (await (await fetch(`${BASE}/cinema/ficha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sala, sessao }) })).json()).ficha;
const itensDe = async (ficha, params = "") => {
  const r = await fetch(`${BASE}/cinema/pasta/itens?f=${ficha}${params}`);
  return { status: r.status, itens: (await r.json()).itens };
};
const nomes = (itens) => itens.map((i) => `${i.tipo}:${i.nome}`);

const SALA = "salapastadevideos0001";
const SESSAO = "sessaopasta00000000001";

try {
  const ws = await entrar(SALA, SESSAO);
  const resposta = await (await fetch(`${BASE}/cinema/ficha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sala: SALA, sessao: SESSAO }) })).json();
  const ficha = resposta.ficha;
  assert.ok(resposta.fontes.some((f) => f.id === "pasta" && f.nome === "Pasta de vídeos"));
  ok("com a pasta definida, a fonte aparece na ficha");

  /* --------------------------- itens e grupos --------------------------- */
  const raiz = await itensDe(ficha);
  assert.equal(raiz.status, 200);
  assert.deepEqual(nomes(raiz.itens), ["grupo:Serie", "video:atalho-interno", "video:clipe", "video:Filme Ação"]);
  for (const i of raiz.itens) {
    assert.match(i.id, /^[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(i).sort(), ["id", "nome", "tipo"]);
  }
  const texto = JSON.stringify(raiz.itens);
  assert.ok(!texto.includes(TMP) && !texto.includes("videos"), "o caminho não vai ao navegador");
  ok("a raiz lista subpastas como grupo e vídeos, sem caminhos");

  assert.ok(!nomes(raiz.itens).some((n) => /oculto|segredos|notas|proibido|atalho:|atalho$|fora/.test(n)));
  ok("oculto, .txt e atalho para fora não aparecem");

  const serie = raiz.itens.find((i) => i.nome === "Serie");
  const dentroDaSerie = await itensDe(ficha, `&pai=${serie.id}`);
  assert.deepEqual(nomes(dentroDaSerie.itens), ["grupo:T1", "video:ep1"]);
  const t1 = dentroDaSerie.itens.find((i) => i.nome === "T1");
  assert.deepEqual(nomes((await itensDe(ficha, `&pai=${t1.id}`)).itens), ["video:ep2"]);
  ok("abrir um grupo (pai) lista só o que há dentro dele");

  /* ------------------------------- busca ------------------------------- */
  assert.deepEqual(nomes((await itensDe(ficha, "&busca=EP")).itens), ["video:ep1", "video:ep2"]);
  assert.deepEqual(nomes((await itensDe(ficha, "&busca=acao")).itens), ["video:Filme Ação"], "sem diferenciar acento nem maiúscula");
  assert.deepEqual((await itensDe(ficha, "&busca=oculto")).itens, []);
  assert.deepEqual((await itensDe(ficha, "&busca=proibido")).itens, []);
  ok("a busca é recursiva e não acha oculto nem o que está fora");

  /* ----------------------------- travessia ----------------------------- */
  assert.equal((await itensDe(ficha, "&pai=" + "0".repeat(32))).status, 404);
  assert.equal((await itensDe(ficha, "&pai=../..")).status, 400);
  assert.equal((await itensDe(ficha, "&pai=%2e%2e%2f%2e%2e")).status, 400);
  const clipe = raiz.itens.find((i) => i.nome === "clipe");
  assert.equal((await itensDe(ficha, `&pai=${clipe.id}`)).status, 404, "um vídeo não é pasta");
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${"1".repeat(32)}?f=${ficha}`)).status, 404);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${serie.id}?f=${ficha}`)).status, 404, "pasta não é vídeo");
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${Buffer.from(path.join(FORA, "proibido.mp4")).toString("base64url")}?f=${ficha}`)).status, 404);
  const cru = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port: PORT, path: `/cinema/pasta/video/../../etc/passwd?f=${ficha}` }, (r) => (r.resume(), resolve(r.statusCode))),
  );
  assert.equal(cru, 404);
  ok("pai e id inventados, caminho como id e ../ não levam a lugar nenhum");

  // O atalho para fora tem o mesmo id que teria se fosse arquivo da pasta: o
  // id é do caminho relativo, então dá para calcular e tentar.
  const { createHash } = await import("node:crypto");
  const idAtalho = createHash("sha256").update("atalho.mp4").digest("hex").slice(0, 32);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${idAtalho}?f=${ficha}`)).status, 404);
  const idPastaFora = createHash("sha256").update("pasta-de-fora").digest("hex").slice(0, 32);
  assert.equal((await itensDe(ficha, `&pai=${idPastaFora}`)).status, 404);
  const idOculto = createHash("sha256").update(".oculto.mp4").digest("hex").slice(0, 32);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${idOculto}?f=${ficha}`)).status, 404);
  const idTxt = createHash("sha256").update("notas.txt").digest("hex").slice(0, 32);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${idTxt}?f=${ficha}`)).status, 404);
  ok("mesmo sabendo o id certo, symlink para fora, oculto e extensão proibida são recusados");

  /* ------------------------------ o vídeo ------------------------------ */
  const url = `${BASE}/cinema/pasta/video/${clipe.id}?f=${ficha}`;
  const inteiro = await fetch(url);
  assert.equal(inteiro.status, 200);
  assert.equal(inteiro.headers.get("content-type"), "video/webm");
  assert.equal(inteiro.headers.get("cache-control"), "no-store");
  assert.equal(inteiro.headers.get("x-content-type-options"), "nosniff");
  assert.equal(inteiro.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await inteiro.arrayBuffer()), BYTES);
  ok("sem Range: 200 com o arquivo inteiro, tipo pela extensão, no-store e nosniff");

  const parte = await fetch(url, { headers: { Range: "bytes=100-199" } });
  assert.equal(parte.status, 206);
  assert.equal(parte.headers.get("content-range"), "bytes 100-199/5000");
  assert.equal(parte.headers.get("content-length"), "100");
  assert.deepEqual(Buffer.from(await parte.arrayBuffer()), BYTES.subarray(100, 200));
  const cauda = await fetch(url, { headers: { Range: "bytes=4900-" } });
  assert.equal(cauda.status, 206);
  assert.equal(cauda.headers.get("content-range"), "bytes 4900-4999/5000");
  const final = await fetch(url, { headers: { Range: "bytes=-10" } });
  assert.deepEqual(Buffer.from(await final.arrayBuffer()), BYTES.subarray(4990));
  const alem = await fetch(url, { headers: { Range: "bytes=0-99999" } });
  assert.equal(alem.status, 206);
  assert.equal(alem.headers.get("content-range"), "bytes 0-4999/5000");
  ok("Range pede um pedaço, a cauda, os últimos bytes e é limitado ao tamanho: 206");

  for (const faixa of ["bytes=5000-", "bytes=9000-9999", "bytes=300-200", "bytes=-0"]) {
    const r = await fetch(url, { headers: { Range: faixa } });
    assert.equal(r.status, 416, faixa);
    assert.equal(r.headers.get("content-range"), "bytes */5000");
    await r.arrayBuffer();
  }
  ok("Range fora do tamanho: 416 com Content-Range */tamanho");

  const cabeca = await fetch(url, { method: "HEAD" });
  assert.equal(cabeca.status, 200);
  assert.equal(cabeca.headers.get("content-length"), "5000");
  assert.equal((await cabeca.arrayBuffer()).byteLength, 0);
  const mkv = raiz.itens.length && (await itensDe(ficha, `&pai=${serie.id}`)).itens.find((i) => i.nome === "ep1");
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${mkv.id}?f=${ficha}`, { method: "HEAD" })).headers.get("content-type"), "video/x-matroska");
  ok("HEAD responde os cabeçalhos sem corpo; .mkv tem o seu tipo");

  const interno = raiz.itens.find((i) => i.nome === "atalho-interno");
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${interno.id}?f=${ficha}`)).status, 200);
  ok("atalho que aponta para dentro da pasta continua valendo");

  /* ----------------------- quem sai da sala perde ----------------------- */
  const outra = await entrar(SALA, "sessaodequemsai000000001");
  const fichaDeQuemSai = await fichaDe(SALA, "sessaodequemsai000000001");
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${clipe.id}?f=${fichaDeQuemSai}`, { headers: { Range: "bytes=0-9" } })).status, 206);
  outra.send(JSON.stringify({ t: "leave" }));
  outra.close();
  await espera(150);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${clipe.id}?f=${fichaDeQuemSai}`)).status, 403);
  assert.equal((await itensDe(fichaDeQuemSai)).status, 403);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${clipe.id}?f=${ficha}`)).status, 200, "quem ficou continua vendo");
  ok("a ficha de quem saiu da sala deixa de valer na hora");

  /* ---------------------------- trocar a pasta ---------------------------- */
  definirPasta(path.join(PASTA, "Serie"));
  assert.equal(pastaAtual(), path.join(PASTA, "Serie"));
  assert.deepEqual(nomes((await itensDe(ficha)).itens), ["grupo:T1", "video:ep1"]);
  assert.equal((await fetch(`${BASE}/cinema/pasta/video/${clipe.id}?f=${ficha}`)).status, 404, "o vídeo da pasta antiga some");
  definirPasta("");
  assert.equal((await fetch(`${BASE}/cinema/pasta/itens?f=${ficha}`)).status, 404, "desligada, a fonte não existe");
  assert.deepEqual((await (await fetch(`${BASE}/cinema/ficha`, { method: "POST", body: JSON.stringify({ sala: SALA, sessao: SESSAO }) })).json()).fontes, []);
  definirPasta(path.join(TMP, "nao-existe"));
  assert.equal((await fetch(`${BASE}/cinema/pasta/itens?f=${ficha}`)).status, 404, "pasta que sumiu desliga a fonte");
  ok("definirPasta troca, desliga e ignora pasta que não existe, sem reiniciar");

  ws.send(JSON.stringify({ t: "leave" }));
  ws.close();
  console.log(`\n${passou} verificações da pasta de vídeos passaram.`);
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
