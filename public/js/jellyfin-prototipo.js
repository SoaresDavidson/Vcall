/**
 * public/js/jellyfin-prototipo.js — PROTÓTIPO, descartável.
 *
 * 1. Entra na sala pela sinalização de verdade (join com uma sessão desta aba).
 * 2. Troca a sessão por uma ficha em POST /jellyfin/ficha.
 * 3. Busca e toca o vídeo por /jellyfin/video/<id>?f=<ficha> (Range, direto do
 *    Jellyfin do host, sem envio prévio).
 * 4. Qualquer um mexe no player: play/pausa/posição vão para /jellyfin/comando
 *    e voltam para todos por SSE em /jellyfin/estado.
 */
const $ = (s) => document.querySelector(s);
const player = $("#player");
const registro = $("#registro");

const sala = location.hash.slice(1) || `prototipo-jellyfin-${Math.random().toString(36).slice(2, 10)}`;
if (!location.hash) location.hash = sala;
const sessao = crypto.randomUUID().replaceAll("-", "");
const nome = `aba-${sessao.slice(0, 4)}`;

let ficha = "";
let offset = 0; // relógio do servidor - relógio daqui
let ultimo = null;

function log(texto) {
  registro.textContent = `${new Date().toLocaleTimeString()} ${texto}\n${registro.textContent}`.slice(0, 4000);
}

function entrarNaSala() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", room: sala, session: sessao, profile: { name: nome } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === "welcome") resolve(ws);
      if (m.t === "error") reject(new Error(m.error));
    };
    ws.onerror = () => reject(new Error("sinalização falhou"));
    // Mantém viva: a sala some se a conexão cair.
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "ping" })), 15000);
  });
}

async function comando(c) {
  await fetch(`/jellyfin/comando?f=${ficha}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...c, por: nome }),
  });
}

function posicaoAlvo(e) {
  if (!e.tocando) return e.posicao;
  const agoraServidor = Date.now() + offset;
  return e.posicao + (agoraServidor - e.em) / 1000;
}

async function aplicar(e) {
  ultimo = e;
  $("#estado").textContent = JSON.stringify({ ...e, alvo: posicaoAlvo(e).toFixed(2), local: player.currentTime.toFixed(2) }, null, 2);
  if (!e.item) return;
  {
    const src = `/jellyfin/video/${e.item}?f=${ficha}`;
    if (!player.src.endsWith(src)) {
      player.src = src;
      await new Promise((r) => player.addEventListener("loadedmetadata", r, { once: true }));
      log(`carregou ${e.nome}`);
    }
    const alvo = posicaoAlvo(e);
    if (Math.abs(player.currentTime - alvo) > 0.5) player.currentTime = alvo;
    if (e.tocando && player.paused) await player.play().catch((err) => log(`autoplay bloqueado: clique no play (${err.name})`));
    if (!e.tocando && !player.paused) player.pause();
  }
}

// Eco: o evento só vira comando se o player divergir do estado da sala.
// (Um freio por tempo engolia o play de verdade dado logo depois de carregar.)
player.addEventListener("play", () => ultimo && !ultimo.tocando && comando({ acao: "tocar", posicao: player.currentTime }));
player.addEventListener("pause", () => ultimo?.tocando && !player.ended && comando({ acao: "pausar", posicao: player.currentTime }));
player.addEventListener("seeked", () => ultimo && Math.abs(player.currentTime - posicaoAlvo(ultimo)) > 0.6 && comando({ acao: "buscar", posicao: player.currentTime }));

$("#busca").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const r = await fetch(`/jellyfin/itens?f=${ficha}&busca=${encodeURIComponent($("#termo").value)}`);
  const { itens = [] } = await r.json();
  $("#itens").replaceChildren(
    ...itens.map((i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = `▶ ${i.nome} (${i.segundos}s)`;
      b.onclick = () => comando({ acao: "item", item: i.id, nome: i.nome });
      li.append(b);
      return li;
    }),
  );
  log(`busca: ${itens.length} item(ns)`);
});

try {
  await entrarNaSala();
  $("#quem").textContent = `Você é ${nome}, na sala ${sala}`;
  const r = await fetch("/jellyfin/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sala, sessao }),
  });
  ({ ficha } = await r.json());
  log(`ficha recebida (${r.status})`);
  const fonte = new EventSource(`/jellyfin/estado?f=${ficha}`);
  fonte.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    offset = e.agora - Date.now();
    if (e.rev !== ultimo?.rev) log(`estado rev ${e.rev} por ${e.por || "-"}: ${e.tocando ? "tocando" : "pausado"} em ${e.posicao.toFixed(1)}s`);
    aplicar(e);
  };
} catch (err) {
  $("#quem").textContent = `Falhou: ${err.message}`;
}
