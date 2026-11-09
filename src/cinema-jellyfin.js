/**
 * src/cinema-jellyfin.js — fonte do "Assistir junto": o Jellyfin de quem
 * hospeda (o contrato das fontes está em src/cinema.js).
 *
 * A CHAVE fica só aqui. Ela dá acesso de administrador ao Jellyfin: o proxy
 * põe o cabeçalho de autenticação e o navegador nunca a vê.
 *
 * UMA BIBLIOTECA SÓ. Com JELLYFIN_BIBLIOTECA, a sala enxerga só aquela
 * biblioteca: a busca começa nela, e um vídeo de fora é recusado mesmo que
 * alguém descubra o id dele. Sem ela, vale tudo o que a chave enxerga — e o
 * servidor avisa no log, porque uma biblioteca de vídeos pessoais apareceria
 * para os convidados.
 *
 * O VÍDEO vai como está (static=true): o navegador pede pedaços por Range e
 * pula para qualquer ponto sem o Jellyfin transcodificar nada.
 */
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { log } from "./logger.js";

const ID_RE = /^[a-f0-9]{32}$/;
const RAIZ_VALE_MS = 60_000;
const PERMITIDO_VALE_MS = 10 * 60_000;

const ligada = () => Boolean(config.jellyfin.url && config.jellyfin.key);
if (ligada() && !config.jellyfin.biblioteca) {
  log.warn("Assistir junto: JELLYFIN_BIBLIOTECA vazio, a sala enxerga TODAS as bibliotecas do Jellyfin");
}

/** Pedido ao Jellyfin, com a chave posta aqui. */
function pedir(caminho, { headers = {} } = {}) {
  const alvo = new URL(caminho, config.jellyfin.url);
  const mod = alvo.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(alvo, { method: "GET", headers: { ...headers, Authorization: `MediaBrowser Token="${config.jellyfin.key}"` } }, resolve);
    req.setTimeout(15_000, () => req.destroy(new Error("o Jellyfin não respondeu")));
    req.on("error", reject);
    req.end();
  });
}

async function pedirJson(caminho) {
  const volta = await pedir(caminho);
  if (volta.statusCode !== 200) {
    volta.resume();
    throw new Error(`o Jellyfin respondeu ${volta.statusCode}`);
  }
  let texto = "";
  for await (const parte of volta) {
    texto += parte;
    if (texto.length > 4 * 1024 * 1024) throw new Error("resposta grande demais");
  }
  return JSON.parse(texto || "{}");
}

/* ------------------------- a biblioteca permitida ------------------------- */

let raiz = { id: "", vale: 0 };
/** id do vídeo -> até quando a conferência vale */
const permitidos = new Map();

/** O id da biblioteca escolhida, ou "" quando vale tudo. */
async function idDaRaiz() {
  const nome = config.jellyfin.biblioteca;
  if (!nome) return "";
  if (raiz.id && raiz.vale > Date.now()) return raiz.id;
  const pastas = await pedirJson("/Library/VirtualFolders");
  const achada = (Array.isArray(pastas) ? pastas : []).find((p) => String(p.Name || "").toLowerCase() === nome.toLowerCase());
  if (!achada || !ID_RE.test(achada.ItemId || "")) throw new Error(`a biblioteca "${nome}" não existe no Jellyfin`);
  raiz = { id: achada.ItemId, vale: Date.now() + RAIZ_VALE_MS };
  return raiz.id;
}

/** O vídeo está dentro da biblioteca permitida? */
async function permitido(id) {
  const r = await idDaRaiz();
  if (!r) return true;
  if ((permitidos.get(id) || 0) > Date.now()) return true;
  const q = new URLSearchParams({ Ids: id, ParentId: r, Recursive: "true", Limit: "1" });
  const dados = await pedirJson(`/Items?${q}`);
  const ok = (dados.Items || []).some((i) => i.Id === id);
  if (ok) {
    if (permitidos.size > 5000) permitidos.clear();
    permitidos.set(id, Date.now() + PERMITIDO_VALE_MS);
  }
  return ok;
}

/* ------------------------------- a fonte ------------------------------- */

export const fonteJellyfin = {
  id: "jellyfin",
  nome: "Jellyfin",
  ligada,

  async itens({ busca }) {
    const q = new URLSearchParams({
      IncludeItemTypes: "Movie,Episode,Video,MusicVideo",
      Recursive: "true",
      Limit: "40",
      SortBy: "SortName",
      Fields: "RunTimeTicks",
    });
    const r = await idDaRaiz();
    if (r) q.set("ParentId", r);
    if (busca) q.set("searchTerm", busca);
    const dados = await pedirJson(`/Items?${q}`);
    // Só o que a tela usa: nada cru do Jellyfin passa adiante.
    return (dados.Items || [])
      .filter((i) => ID_RE.test(i.Id))
      .map((i) => ({ id: i.Id, nome: String(i.Name || "Sem título").slice(0, 200), tipo: "video", segundos: Math.round((i.RunTimeTicks || 0) / 1e7) }));
  },

  async video(id, req, res) {
    if (!ID_RE.test(id) || !(await permitido(id))) return false;
    const range = req.headers.range;
    const volta = await pedir(`/Videos/${id}/stream?static=true`, { headers: range ? { Range: range } : {} });
    const passa = {};
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      if (volta.headers[h]) passa[h] = volta.headers[h];
    }
    res.writeHead(volta.statusCode || 502, { ...passa, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") {
      volta.resume();
      res.end();
      return true;
    }
    volta.pipe(res);
    res.on("close", () => volta.destroy());
    return true;
  },
};
