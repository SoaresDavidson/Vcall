/**
 * src/cinema-pasta.js — fonte do "Assistir junto": uma pasta de vídeos do
 * computador de quem hospeda (o contrato das fontes está em src/cinema.js).
 *
 * O CAMINHO nunca sai daqui. O navegador só conhece ids opacos (os 32
 * primeiros hex do sha256 do caminho RELATIVO à pasta): quem tem uma ficha
 * não descobre onde os arquivos moram, nem consegue montar um id para um
 * arquivo que a lista não mostrou — o id é resolvido percorrendo a própria
 * pasta, nunca lendo um caminho vindo de fora.
 *
 * SÓ DENTRO DA PASTA. Todo arquivo e subpasta passa por realpath e é
 * recusado se o destino real ficar fora da pasta escolhida. Isso vale
 * também para atalho (symlink) que aponta para fora: o nome está dentro, o
 * conteúdo não. Atalho que aponta para dentro é aceito. Arquivos e pastas
 * ocultos (começam com ".") e extensões fora da lista não existem para a sala.
 *
 * A PASTA vem de PASTA_VIDEOS, mas `config` é congelado e o app de mesa
 * deixa a pessoa trocar a pasta sem reabrir: por isso ela mora num `let`
 * aqui, com um setter (definirPasta).
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const TIPOS = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
};
const PROFUNDIDADE_MAX = 6;
const ARQUIVOS_MAX = 20_000;
const BUSCA_MAX = 200;

let pasta = config.pastaVideos || "";

/** id -> { real, tipo }, preenchido a cada leitura de pasta. */
const indice = new Map();

/** Troca a pasta (o app de mesa chama ao escolher ou desligar). "" desliga. */
export function definirPasta(caminho) {
  pasta = caminho ? path.resolve(String(caminho)) : "";
  indice.clear();
}
export const pastaAtual = () => pasta;

const ligada = () => {
  if (!pasta) return false;
  try {
    return statSync(pasta).isDirectory();
  } catch {
    return false;
  }
};

const idDe = (relativo) => createHash("sha256").update(relativo.split(path.sep).join("/")).digest("hex").slice(0, 32);
const dentro = (raiz, alvo) => {
  const r = path.relative(raiz, alvo);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};
const normalizar = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Lê uma pasta e devolve as entradas que a sala pode ver: { id, nome, tipo,
 * real }. `raiz` é o realpath da pasta escolhida.
 */
async function ler(raiz, dir) {
  let entradas;
  try {
    entradas = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const saida = [];
  for (const e of entradas) {
    if (e.name.startsWith(".")) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!e.isDirectory() && !(ext in TIPOS)) continue;
    let real;
    let st;
    try {
      real = await realpath(path.join(dir, e.name));
      if (!dentro(raiz, real)) continue; // symlink para fora
      st = await stat(real);
    } catch {
      continue;
    }
    // O id vem do caminho pelo qual a pessoa chegou, não do destino do atalho.
    const id = idDe(path.relative(raiz, path.join(dir, e.name)));
    if (st.isDirectory()) saida.push({ id, nome: e.name, tipo: "grupo", real });
    else if (st.isFile() && ext in TIPOS) saida.push({ id, nome: path.basename(e.name, path.extname(e.name)), tipo: "video", real });
  }
  if (indice.size > 50_000) indice.clear();
  for (const s of saida) indice.set(s.id, { real: s.real, tipo: s.tipo });
  return saida;
}

const ordenar = (a, b) =>
  (a.tipo === b.tipo ? 0 : a.tipo === "grupo" ? -1 : 1) || a.nome.localeCompare(b.nome, undefined, { numeric: true, sensitivity: "base" });
const publico = ({ id, nome, tipo }) => ({ id, nome, tipo });

/**
 * Percorre a árvore em largura, com limite de profundidade e de arquivos,
 * chamando `ver` em cada entrada; `ver` devolve false para parar.
 */
async function percorrer(raiz, ver) {
  let arquivos = 0;
  const fila = [[raiz, 0]];
  while (fila.length) {
    const [dir, nivel] = fila.shift();
    for (const e of await ler(raiz, dir)) {
      if (++arquivos > ARQUIVOS_MAX) return;
      if (ver(e) === false) return;
      if (e.tipo === "grupo" && nivel + 1 < PROFUNDIDADE_MAX) fila.push([e.real, nivel + 1]);
    }
  }
}

/** Acha a entrada de um id: pelo índice (conferindo que ainda existe) ou varrendo. */
async function achar(raiz, id) {
  const confere = async (v) => {
    try {
      const real = await realpath(v.real);
      return dentro(raiz, real) ? { ...v, real } : null;
    } catch {
      return null;
    }
  };
  const guardado = indice.get(id);
  if (guardado) {
    const ok = await confere(guardado);
    if (ok) return ok;
    indice.delete(id);
  }
  await percorrer(raiz, (e) => e.id !== id);
  const v = indice.get(id);
  return v ? confere(v) : null;
}

const raizReal = async () => (ligada() ? realpath(pasta).catch(() => null) : null);

async function itens({ busca = "", pai = "" } = {}) {
  const raiz = await raizReal();
  if (!raiz) return [];
  if (busca) {
    const q = normalizar(busca);
    const achados = [];
    await percorrer(raiz, (e) => {
      if (e.tipo === "video" && normalizar(e.nome).includes(q)) achados.push(e);
      return achados.length < BUSCA_MAX;
    });
    return achados.sort(ordenar).map(publico);
  }
  let dir = raiz;
  if (pai) {
    const p = await achar(raiz, pai);
    // `pai` que não é uma pasta daqui: null, e o roteador responde 404.
    if (!p || p.tipo !== "grupo") return null;
    dir = p.real;
  }
  return (await ler(raiz, dir)).sort(ordenar).map(publico);
}

/** "bytes=a-b" -> [ini, fim] | "invalido" | null (sem Range, ou formato que ignoramos). */
function lerRange(cab, tamanho) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((cab || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let ini;
  let fim;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalido";
    ini = Math.max(0, tamanho - n);
    fim = tamanho - 1;
  } else {
    ini = Number(m[1]);
    fim = m[2] === "" ? tamanho - 1 : Math.min(Number(m[2]), tamanho - 1);
  }
  return ini >= tamanho || ini > fim ? "invalido" : [ini, fim];
}

async function video(id, req, res) {
  const raiz = await raizReal();
  if (!raiz) return false;
  const v = await achar(raiz, id);
  if (!v || v.tipo !== "video") return false;
  const tamanho = (await stat(v.real)).size;
  const cabecalhos = {
    "Content-Type": TIPOS[path.extname(v.real).toLowerCase()] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const r = lerRange(req.headers.range, tamanho);
  if (r === "invalido") {
    res.writeHead(416, { ...cabecalhos, "Content-Range": `bytes */${tamanho}` }).end();
    return true;
  }
  const [ini, fim] = r || [0, tamanho - 1];
  res.writeHead(r ? 206 : 200, {
    ...cabecalhos,
    "Content-Length": tamanho === 0 ? 0 : fim - ini + 1,
    ...(r ? { "Content-Range": `bytes ${ini}-${fim}/${tamanho}` } : {}),
  });
  if (req.method === "HEAD" || tamanho === 0) return res.end(), true;
  const fluxo = createReadStream(v.real, { start: ini, end: fim });
  fluxo.on("error", () => res.destroy());
  res.on("close", () => fluxo.destroy());
  fluxo.pipe(res);
  return true;
}

export const fontePasta = { id: "pasta", nome: "Pasta de vídeos", ligada, itens, video };
