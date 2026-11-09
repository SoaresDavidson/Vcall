/**
 * src/cinema.js — o "Assistir junto" no servidor da sala: quem pode ver o
 * quê, e de onde vem o vídeo.
 *
 * A sala mora no computador de quem hospeda (app de mesa). Os vídeos também:
 * cada participante pede ao servidor da sala, que lê de uma FONTE local —
 * o Jellyfin de quem hospeda (src/cinema-jellyfin.js), e outras que se
 * encaixem do mesmo jeito. Nada é enviado antes; o navegador pede só o
 * trecho que vai tocar (Range).
 *
 * QUEM: a ficha
 *
 * Só quem está na sala vê alguma coisa. A aba troca a própria sessão (a do
 * join) por uma ficha, e cada pedido confere de novo que AQUELA sessão ainda
 * está na sala. Saiu, caiu de vez ou foi removida pelo anfitrião: a ficha
 * para de valer no mesmo instante, mesmo com a sala cheia. A ficha, e não a
 * sessão, é que vai nas URLs de vídeo (que aparecem em logs de proxy).
 *
 * O QUÊ: a fonte
 *
 * Cada fonte expõe só três coisas, e o resto do serviço por trás dela não é
 * alcançável daqui:
 *
 *   itens({ busca, pai })  -> [{ id, nome, tipo: "video"|"grupo", segundos?, imagem? }]
 *                            "grupo" é algo que se abre (série, temporada,
 *                            pasta): o cliente pede de novo com `pai` = id.
 *   video(id, req, res)    -> responde o arquivo, com Range. Recusa (false)
 *                            o que não é dela.
 *   imagem?(id, req, res)  -> capa, se a fonte tiver.
 *
 * ROTAS (todas exigem ficha, menos a que a emite)
 *
 *   POST /cinema/ficha                  { sala, sessao } -> { ficha, fontes }
 *   GET  /cinema/<fonte>/itens?f=&busca=&pai=
 *   GET  /cinema/<fonte>/video/<id>?f=
 *   GET  /cinema/<fonte>/imagem/<id>?f=
 *
 * Play, pausa e posição NÃO passam por aqui: vão pelo estado compartilhado
 * dos jogos, entre os participantes (public/js/features/cinema.js).
 */
import { randomBytes } from "node:crypto";
import { fonteJellyfin } from "./cinema-jellyfin.js";

export const CAMINHO = "/cinema";
const FICHA_RE = /^[A-Za-z0-9_-]{32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FONTE_RE = /^[a-z]{1,24}$/;
const VALIDADE_MS = 12 * 60 * 60 * 1000;
const MAX_FICHAS = 2000;

/** As fontes conhecidas. Só as `ligada()` aparecem para a sala. */
const FONTES = [fonteJellyfin];

/** ficha -> { sala, sessao, expira } */
const fichas = new Map();

export const fontesLigadas = () => FONTES.filter((f) => f.ligada());

export function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

export async function lerJson(fluxo, limite = 2 * 1024 * 1024) {
  let texto = "";
  for await (const parte of fluxo) {
    texto += parte;
    if (texto.length > limite) throw new Error("grande demais");
  }
  return JSON.parse(texto || "{}");
}

function esquecerVencidas() {
  const agora = Date.now();
  for (const [f, v] of fichas) if (v.expira < agora) fichas.delete(f);
}

/**
 * A pessoa desta sessão está na sala e não foi removida? Quem o anfitrião
 * remove ainda fica alguns segundos no registro (a mesma tolerância de quem
 * só caiu), mas o aparelho já está banido: isso basta para cortar o acesso.
 */
function naSala(registry, sala, sessao) {
  const room = registry.get(sala);
  const p = room?.bySession(sessao);
  return Boolean(p && !room.isBanned(p.device));
}

/** A ficha vale se não venceu e a pessoa dela ainda está na sala. */
function fichaValida(ficha, registry) {
  if (!FICHA_RE.test(ficha || "")) return false;
  const f = fichas.get(ficha);
  if (!f) return false;
  if (f.expira < Date.now() || !naSala(registry, f.sala, f.sessao)) {
    fichas.delete(ficha);
    return false;
  }
  return true;
}

/**
 * Trata /cinema/*. Devolve true se a requisição era daqui.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("./rooms.js").RoomRegistry} registry
 */
export async function proxyCinema(req, res, registry) {
  if (req.url !== CAMINHO && !req.url?.startsWith(`${CAMINHO}/`)) return false;
  const url = new URL(req.url, "http://localhost");
  const partes = url.pathname.slice(CAMINHO.length + 1).split("/");
  const metodo = req.method || "GET";

  try {
    if (partes.length === 1 && partes[0] === "ficha") {
      if (metodo !== "POST") return res.writeHead(405, { Allow: "POST" }).end(), true;
      const { sala, sessao } = await lerJson(req, 1024);
      if (!naSala(registry, String(sala || ""), String(sessao || ""))) return json(res, 403, { erro: "fora da sala" }), true;
      esquecerVencidas();
      if (fichas.size >= MAX_FICHAS) return json(res, 503, { erro: "fichas demais" }), true;
      const ficha = randomBytes(24).toString("base64url");
      fichas.set(ficha, { sala: String(sala), sessao: String(sessao), expira: Date.now() + VALIDADE_MS });
      return json(res, 200, { ficha, fontes: fontesLigadas().map((f) => ({ id: f.id, nome: f.nome })) }), true;
    }

    if (metodo !== "GET" && metodo !== "HEAD") return res.writeHead(405, { Allow: "GET, HEAD" }).end(), true;
    if (!fichaValida(url.searchParams.get("f"), registry)) return json(res, 403, { erro: "ficha inválida" }), true;

    const [nomeFonte, rota, id, ...sobra] = partes;
    const fonte = FONTE_RE.test(nomeFonte || "") ? fontesLigadas().find((f) => f.id === nomeFonte) : null;
    if (!fonte || sobra.length) return json(res, 404, { erro: "rota fora da lista" }), true;

    if (rota === "itens" && id === undefined) {
      const busca = (url.searchParams.get("busca") || "").trim().slice(0, 80);
      const pai = url.searchParams.get("pai") || "";
      if (pai && !ID_RE.test(pai)) return json(res, 400, { erro: "pai inválido" }), true;
      return json(res, 200, { itens: await fonte.itens({ busca, pai }) }), true;
    }
    if ((rota === "video" || (rota === "imagem" && fonte.imagem)) && ID_RE.test(id || "")) {
      const atendeu = await fonte[rota](id, req, res);
      if (!atendeu && !res.headersSent) json(res, 404, { erro: "não é desta fonte" });
      return true;
    }
    return json(res, 404, { erro: "rota fora da lista" }), true;
  } catch (err) {
    if (!res.headersSent) json(res, 502, { erro: String(err?.message || err) });
    else res.destroy();
    return true;
  }
}
