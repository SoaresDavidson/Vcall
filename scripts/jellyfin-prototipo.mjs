#!/usr/bin/env node
/**
 * scripts/jellyfin-prototipo.mjs — PROTÓTIPO. Sobe tudo e confere o proxy.
 *
 *   npm run prototipo:jellyfin            Jellyfin falso + servidor + checagens,
 *                                         depois fica no ar para testar no navegador
 *   JELLYFIN_URL=http://127.0.0.1:8096 JELLYFIN_KEY=<chave> npm run prototipo:jellyfin
 *                                         usa um Jellyfin de verdade (sem as checagens
 *                                         que dependem do item falso)
 *   --checar                              só as checagens, e sai
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soChecar = process.argv.includes("--checar");
const PORTA = 3077;
const BASE = `http://127.0.0.1:${PORTA}`;
const real = Boolean(process.env.JELLYFIN_URL);
const filhos = [];
const sair = (code) => (filhos.forEach((f) => f.kill()), process.exit(code));
process.on("SIGINT", () => sair(0));

let jellyfinUrl = process.env.JELLYFIN_URL;
let chave = process.env.JELLYFIN_KEY;
if (!real) {
  const pasta = path.join(raiz, ".cache-prototipo-jellyfin");
  const video = path.join(pasta, "teste.mp4");
  if (!existsSync(video)) {
    mkdirSync(pasta, { recursive: true });
    console.log("gerando vídeo de teste com ffmpeg…");
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", video,
    ]);
  }
  chave = "chave-secreta-do-host-0000000000";
  jellyfinUrl = "http://127.0.0.1:18096";
  filhos.push(spawn(process.execPath, [path.join(raiz, "scripts/fixtures/jellyfin-falso.mjs"), "18096", chave, video], { stdio: "inherit" }));
}

const servidor = spawn(process.execPath, [path.join(raiz, "server.js")], {
  env: { ...process.env, PORT: String(PORTA), HOST: "127.0.0.1", JELLYFIN_URL: jellyfinUrl, JELLYFIN_KEY: chave, LOG_LEVEL: "warn" },
  stdio: "inherit",
});
filhos.push(servidor);

async function esperar() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("servidor não subiu");
}

const resultados = [];
const confere = (nome, ok, detalhe = "") => {
  resultados.push(ok);
  console.log(`${ok ? "OK  " : "FALHA"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};

function entrar(sala, sessao) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORTA}`, { headers: { Origin: BASE } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", room: sala, session: sessao, profile: { name: "teste" } })));
    ws.on("message", (d) => JSON.parse(d).t === "welcome" && resolve(ws));
    ws.on("error", reject);
  });
}

const fichaDe = (sala, sessao) =>
  fetch(`${BASE}/jellyfin/ficha`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sala, sessao }) });

async function checar() {
  const sala = "prototipojellyfin0001";
  const sessao = "sessaodeteste000000000001";

  confere("ficha recusada para quem não está na sala", (await fichaDe(sala, sessao)).status === 403);

  const ws = await entrar(sala, sessao);
  const r = await fichaDe(sala, sessao);
  const { ficha } = await r.json();
  confere("ficha emitida para quem entrou pela sinalização", r.status === 200 && Boolean(ficha));
  confere("ficha de outra sessão continua recusada", (await fichaDe(sala, "outrasessao0000000000001")).status === 403);

  confere("vídeo sem ficha recusado", (await fetch(`${BASE}/jellyfin/video/0123456789abcdef0123456789abcdef`)).status === 403);
  confere("rota fora da lista bloqueada (/Users do Jellyfin)", (await fetch(`${BASE}/jellyfin/Users?f=${ficha}`)).status === 404);
  // fetch normaliza "../"; o pedido cru chega ao servidor como foi escrito.
  const cru = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port: PORTA, path: `/jellyfin/video/../../Users?f=${ficha}` }, (r) => (r.resume(), resolve(r.statusCode))),
  );
  confere("caminho com travessia bloqueado", cru === 404, `status ${cru}`);

  const busca = await fetch(`${BASE}/jellyfin/itens?f=${ficha}&busca=${real ? "" : "teste"}`);
  const corpo = await busca.text();
  const { itens } = JSON.parse(corpo);
  confere("busca devolve itens", busca.status === 200 && itens.length > 0, `${itens.length} item(ns)`);
  confere("chave do Jellyfin não aparece na resposta da busca", !corpo.includes(chave));

  const id = itens[0]?.id;
  if (id) {
    const v = await fetch(`${BASE}/jellyfin/video/${id}?f=${ficha}`, { headers: { Range: "bytes=1000000-1000999" } });
    const pedaco = await v.arrayBuffer();
    const cabecalhos = JSON.stringify([...v.headers]);
    confere("vídeo atende Range (pular para o meio)", v.status === 206 && pedaco.byteLength === 1000, `${v.status}, ${pedaco.byteLength} bytes, ${v.headers.get("content-range")}`);
    confere("chave não aparece nos cabeçalhos do vídeo", !cabecalhos.includes(chave));
  }

  // Sincronização: dois ouvintes, um manda, os dois recebem.
  const ws2 = await entrar(sala, "sessaodeteste000000000002");
  const ficha2 = (await (await fichaDe(sala, "sessaodeteste000000000002")).json()).ficha;
  const recebidos = [];
  const ouvir = async (f) => {
    const resp = await fetch(`${BASE}/jellyfin/estado?f=${f}`);
    const leitor = resp.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) return;
        for (const l of dec.decode(value).split("\n")) if (l.startsWith("data: ")) recebidos.push({ f, e: JSON.parse(l.slice(6)) });
      }
    })();
    return leitor;
  };
  const l1 = await ouvir(ficha);
  const l2 = await ouvir(ficha2);
  const manda = (c) => fetch(`${BASE}/jellyfin/comando?f=${ficha2}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
  await manda({ acao: "item", item: id || "0123456789abcdef0123456789abcdef", nome: "x", por: "b" });
  await manda({ acao: "tocar", posicao: 12.5, por: "b" });
  await new Promise((r) => setTimeout(r, 200));
  const ultimoDe = (f) => recebidos.filter((x) => x.f === f).at(-1)?.e;
  confere(
    "comando de uma pessoa chega às duas",
    ultimoDe(ficha)?.tocando && ultimoDe(ficha2)?.tocando && ultimoDe(ficha).posicao === 12.5,
    `rev ${ultimoDe(ficha)?.rev}`,
  );

  // Quando todos saem, as fichas da sala deixam de valer.
  l1.cancel();
  l2.cancel();
  // Saída normal ("leave"). Uma queda sem aviso tem 20 s de graça antes de sair.
  for (const w of [ws, ws2]) w.send(JSON.stringify({ t: "leave" })), w.close();
  await new Promise((r) => setTimeout(r, 300));
  const depois = (await fetch(`${BASE}/jellyfin/itens?f=${ficha}&busca=a`)).status;
  confere("ficha perde a validade quando a sala esvazia", depois === 403, `status ${depois}`);
}

await esperar();
try {
  await checar();
} catch (err) {
  confere("checagens rodaram", false, err.message);
}
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} checagens passaram`);
if (soChecar) sair(falhas ? 1 : 0);

console.log(`\nNo ar. Abra em duas abas (mesmo #sala):\n  ${BASE}/jellyfin-prototipo.html#minhasaladeteste0001\nCtrl+C para parar.`);
