/**
 * src/jellyfin.js — o Jellyfin de quem hospeda, no endereço da sala.
 *
 * "Assistir junto" toca vídeos da biblioteca Jellyfin de quem hospeda. A sala
 * já mora no computador dessa pessoa (app de mesa), então o vídeo não precisa
 * ser enviado antes: cada participante pede ao servidor da sala, que repassa
 * ao Jellyfin local. O mesmo caminho do SFU (src/sfu.js): o serviço local
 * aparece em /jellyfin/ e atravessa o túnel e o Tailscale sem porta nova.
 *
 * O que fica protegido aqui, e por quê:
 *
 *   CHAVE   A chave da API do Jellyfin dá acesso de administrador. Ela só
 *           existe neste processo: o proxy põe o cabeçalho de autenticação
 *           e o navegador nunca a vê.
 *   ROTAS   Lista fechada: buscar itens e ler o arquivo do vídeo (com Range,
 *           para pular para qualquer ponto). Usuários, configurações e o
 *           resto do Jellyfin não são alcançáveis por aqui.
 *   QUEM    Só quem está na sala recebe uma ficha: a sessão da aba precisa
 *           constar no registro da sala. A ficha (e não a sessão) vai nas
 *           URLs de vídeo, e deixa de valer quando a sala esvazia.
 *
 * Play, pausa e posição NÃO passam por aqui: vão pelo estado compartilhado
 * dos jogos, entre os participantes (public/js/features/cinema.js).
 *
 * Liga com JELLYFIN_URL e JELLYFIN_KEY. Sem eles, /jellyfin/ responde 404.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";

export const CAMINHO = "/jellyfin";
const ID_RE = /^[a-f0-9]{32}$/;
const FICHA_RE = /^[A-Za-z0-9_-]{32}$/;
const VALIDADE_MS = 12 * 60 * 60 * 1000;
const MAX_FICHAS = 2000;

/** ficha -> { sala, expira } */
const fichas = new Map();

export const jellyfinLigado = () => Boolean(config.jellyfin.url && config.jellyfin.key);

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

function esquecerVencidas() {
  const agora = Date.now();
  for (const [f, v] of fichas) if (v.expira < agora) fichas.delete(f);
}

/** A sala da ficha, se a ficha vale e a sala ainda tem gente. */
function salaDaFicha(ficha, registry) {
  if (!FICHA_RE.test(ficha || "")) return null;
  const f = fichas.get(ficha);
  if (!f || f.expira < Date.now()) {
    fichas.delete(ficha);
    return null;
  }
  const sala = registry.get(f.sala);
  if (!sala || sala.members.size === 0) {
    fichas.delete(ficha);
    return null;
  }
  return f.sala;
}

/** Pedido ao Jellyfin, com a chave posta aqui. */
function aoJellyfin(caminho, { headers = {} } = {}) {
  const alvo = new URL(caminho, config.jellyfin.url);
  const mod = alvo.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(alvo, { method: "GET", headers: { ...headers, Authorization: `MediaBrowser Token="${config.jellyfin.key}"` } }, resolve);
    req.setTimeout(15_000, () => req.destroy(new Error("o Jellyfin não respondeu")));
    req.on("error", reject);
    req.end();
  });
}

async function lerJson(fluxo, limite = 2 * 1024 * 1024) {
  let texto = "";
  for await (const parte of fluxo) {
    texto += parte;
    if (texto.length > limite) throw new Error("resposta grande demais");
  }
  return JSON.parse(texto || "{}");
}

/**
 * Trata /jellyfin/*. Devolve true se a requisição era daqui.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("./rooms.js").RoomRegistry} registry
 */
export async function proxyJellyfin(req, res, registry) {
  if (req.url !== CAMINHO && !req.url?.startsWith(`${CAMINHO}/`)) return false;
  if (!jellyfinLigado()) {
    res.writeHead(404, { "Cache-Control": "no-store" }).end();
    return true;
  }
  const url = new URL(req.url, "http://localhost");
  const rota = url.pathname.slice(CAMINHO.length);
  const metodo = req.method || "GET";

  try {
    // Sessão da aba na sala -> ficha. A sessão nunca vai numa URL.
    if (rota === "/ficha" && metodo === "POST") {
      const { sala, sessao } = await lerJson(req, 1024);
      const quem = registry.get(String(sala || ""))?.bySession(String(sessao || ""));
      if (!quem) return json(res, 403, { erro: "fora da sala" }), true;
      esquecerVencidas();
      if (fichas.size >= MAX_FICHAS) return json(res, 503, { erro: "fichas demais" }), true;
      const ficha = randomBytes(24).toString("base64url");
      fichas.set(ficha, { sala, expira: Date.now() + VALIDADE_MS });
      return json(res, 200, { ficha }), true;
    }

    if (metodo !== "GET" && metodo !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return true;
    }
    if (!salaDaFicha(url.searchParams.get("f"), registry)) return json(res, 403, { erro: "ficha inválida" }), true;

    if (rota === "/itens") {
      const q = new URLSearchParams({
        IncludeItemTypes: "Movie,Episode,Video,MusicVideo",
        Recursive: "true",
        Limit: "40",
        SortBy: "SortName",
        Fields: "RunTimeTicks",
      });
      const busca = (url.searchParams.get("busca") || "").trim().slice(0, 80);
      if (busca) q.set("searchTerm", busca);
      const volta = await aoJellyfin(`/Items?${q}`);
      if (volta.statusCode !== 200) {
        volta.resume();
        return json(res, 502, { erro: `o Jellyfin respondeu ${volta.statusCode}` }), true;
      }
      const dados = await lerJson(volta);
      // Só o que a tela usa: nada cru do Jellyfin passa adiante.
      const itens = (dados.Items || [])
        .filter((i) => ID_RE.test(i.Id))
        .map((i) => ({ id: i.Id, nome: String(i.Name || "Sem título").slice(0, 200), segundos: Math.round((i.RunTimeTicks || 0) / 1e7) }));
      return json(res, 200, { itens }), true;
    }

    const video = rota.match(/^\/video\/([a-f0-9]{32})$/);
    if (video) {
      // O arquivo como está (static=true): o navegador pede pedaços por Range
      // e pula para qualquer ponto sem o Jellyfin transcodificar nada.
      const range = req.headers.range;
      const volta = await aoJellyfin(`/Videos/${video[1]}/stream?static=true`, { headers: range ? { Range: range } : {} });
      const passa = {};
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
        if (volta.headers[h]) passa[h] = volta.headers[h];
      }
      res.writeHead(volta.statusCode || 502, { ...passa, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (metodo === "HEAD") return volta.resume(), res.end(), true;
      volta.pipe(res);
      res.on("close", () => volta.destroy());
      return true;
    }

    return json(res, 404, { erro: "rota fora da lista" }), true;
  } catch (err) {
    if (!res.headersSent) json(res, 502, { erro: String(err?.message || err) });
    else res.destroy();
    return true;
  }
}
