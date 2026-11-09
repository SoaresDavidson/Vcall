/**
 * src/jellyfin.prototipo.js — PROTÓTIPO, descartável. Não é código de produção.
 *
 * Pergunta que este arquivo responde: os convidados conseguem tocar um vídeo
 * do Jellyfin de quem hospeda pelo próprio endereço da sala (túnel, Tailscale,
 * rede local), sem envio prévio, com play/pausa/posição iguais para todos?
 *
 * Mesmo desenho de src/sfu.js: um serviço local do host (o Jellyfin em
 * localhost:8096) aparece em /jellyfin/ no endereço da sala.
 *
 * Regras que o protótipo testa:
 *   - A chave da API do Jellyfin nunca sai do servidor: o proxy põe o
 *     cabeçalho de autenticação, e o navegador nunca vê a chave.
 *   - Lista fechada de rotas: busca, vídeo (com Range) e capa. O resto do
 *     Jellyfin (administração, usuários, biblioteca crua) não é alcançável.
 *   - Só quem está na sala recebe uma ficha: a sessão da aba precisa estar na
 *     sala no registro do servidor (RoomRegistry.bySession).
 *   - A sincronização do player fica aqui, em memória, com SSE. Na versão de
 *     verdade ela iria pelo canal `board` da malha, como os jogos.
 *
 * Liga com JELLYFIN_URL e JELLYFIN_KEY no ambiente. Sem eles, nada acontece.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

const CAMINHO = "/jellyfin";
const ID_RE = /^[a-f0-9]{32}$/;
const FICHA_RE = /^[A-Za-z0-9_-]{32}$/;
const VALIDADE_MS = 6 * 60 * 60 * 1000;

const URL_BASE = process.env.JELLYFIN_URL || "";
const CHAVE = process.env.JELLYFIN_KEY || "";

/** ficha -> { sala, expira } */
const fichas = new Map();
/** sala -> { estado, ouvintes:Set<res> } */
const salas = new Map();

export const jellyfinLigado = () => Boolean(URL_BASE && CHAVE);

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
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
  if (!sala || sala.members.size === 0) return null;
  return f.sala;
}

/** Pedido ao Jellyfin com a chave posta aqui. */
function aoJellyfin(caminho, { headers = {} } = {}) {
  const alvo = new URL(caminho, URL_BASE);
  const mod = alvo.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(alvo, {
      method: "GET",
      headers: { ...headers, Authorization: `MediaBrowser Token="${CHAVE}"` },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

async function lerJson(volta) {
  let texto = "";
  for await (const parte of volta) texto += parte;
  return JSON.parse(texto);
}

function estadoDe(sala) {
  if (!salas.has(sala)) {
    salas.set(sala, {
      estado: { item: null, nome: "", tocando: false, posicao: 0, em: Date.now(), rev: 0, por: "" },
      ouvintes: new Set(),
    });
  }
  return salas.get(sala);
}

function espalhar(sala) {
  const s = estadoDe(sala);
  const linha = `data: ${JSON.stringify({ ...s.estado, agora: Date.now() })}\n\n`;
  for (const res of s.ouvintes) res.write(linha);
}

async function lerCorpo(req, limite = 2048) {
  let texto = "";
  for await (const parte of req) {
    texto += parte;
    if (texto.length > limite) throw new Error("grande demais");
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
  if (!req.url?.startsWith(`${CAMINHO}/`)) return false;
  if (!jellyfinLigado()) {
    res.writeHead(404).end();
    return true;
  }
  const url = new URL(req.url, "http://localhost");
  const rota = url.pathname.slice(CAMINHO.length);
  const metodo = req.method || "GET";

  try {
    // Troca: sessão da aba na sala -> ficha. A sessão não vai em URL de vídeo.
    if (rota === "/ficha" && metodo === "POST") {
      const { sala, sessao } = await lerCorpo(req);
      const quem = registry.get(String(sala || ""))?.bySession(String(sessao || ""));
      if (!quem) return json(res, 403, { erro: "fora da sala" }), true;
      const ficha = randomBytes(24).toString("base64url");
      fichas.set(ficha, { sala, expira: Date.now() + VALIDADE_MS });
      return json(res, 200, { ficha }), true;
    }

    const ficha = url.searchParams.get("f") || "";
    const sala = salaDaFicha(ficha, registry);
    if (!sala) return json(res, 403, { erro: "ficha inválida" }), true;

    if (rota === "/itens" && metodo === "GET") {
      const busca = (url.searchParams.get("busca") || "").slice(0, 80);
      const q = new URLSearchParams({
        searchTerm: busca,
        IncludeItemTypes: "Movie,Episode,Video",
        Recursive: "true",
        Limit: "20",
        Fields: "RunTimeTicks",
      });
      const volta = await aoJellyfin(`/Items?${q}`);
      if (volta.statusCode !== 200) return json(res, 502, { erro: `jellyfin ${volta.statusCode}` }), true;
      const dados = await lerJson(volta);
      // Só o que a página usa; nada cru do Jellyfin passa.
      const itens = (dados.Items || [])
        .filter((i) => ID_RE.test(i.Id))
        .map((i) => ({ id: i.Id, nome: String(i.Name || "").slice(0, 200), segundos: Math.round((i.RunTimeTicks || 0) / 1e7) }));
      return json(res, 200, { itens }), true;
    }

    const video = rota.match(/^\/video\/([a-f0-9]{32})$/);
    if (video && (metodo === "GET" || metodo === "HEAD")) {
      // Arquivo direto (static=true): o navegador pede pedaços por Range e
      // a posição pode pular para qualquer lugar sem transcodificar.
      const headers = req.headers.range ? { Range: req.headers.range } : {};
      const volta = await aoJellyfin(`/Videos/${video[1]}/stream?static=true`, { headers });
      const passa = {};
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
        if (volta.headers[h]) passa[h] = volta.headers[h];
      }
      res.writeHead(volta.statusCode || 502, { ...passa, "Cache-Control": "no-store" });
      if (metodo === "HEAD") return volta.resume(), res.end(), true;
      volta.pipe(res);
      req.on("close", () => volta.destroy());
      return true;
    }

    // Sincronização: SSE para ouvir, POST para mandar.
    if (rota === "/estado" && metodo === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const s = estadoDe(sala);
      s.ouvintes.add(res);
      res.write(`data: ${JSON.stringify({ ...s.estado, agora: Date.now() })}\n\n`);
      const batida = setInterval(() => res.write(": ok\n\n"), 15000);
      req.on("close", () => (clearInterval(batida), s.ouvintes.delete(res)));
      return true;
    }

    if (rota === "/comando" && metodo === "POST") {
      const c = await lerCorpo(req);
      const s = estadoDe(sala);
      const e = s.estado;
      const pos = Number.isFinite(c.posicao) ? Math.max(0, c.posicao) : e.posicao;
      if (c.acao === "item" && ID_RE.test(c.item || "")) {
        Object.assign(e, { item: c.item, nome: String(c.nome || "").slice(0, 200), tocando: false, posicao: 0 });
      } else if (c.acao === "tocar") {
        Object.assign(e, { tocando: true, posicao: pos });
      } else if (c.acao === "pausar") {
        Object.assign(e, { tocando: false, posicao: pos });
      } else if (c.acao === "buscar") {
        Object.assign(e, { posicao: pos });
      } else {
        return json(res, 400, { erro: "ação desconhecida" }), true;
      }
      e.em = Date.now();
      e.rev += 1;
      e.por = String(c.por || "").slice(0, 40);
      espalhar(sala);
      return json(res, 200, { rev: e.rev }), true;
    }

    return json(res, 404, { erro: "rota fora da lista" }), true;
  } catch (err) {
    if (!res.headersSent) json(res, 502, { erro: String(err.message || err) });
    else res.destroy();
    return true;
  }
}
