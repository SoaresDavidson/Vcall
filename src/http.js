/**
 * src/http.js — servidor de arquivos estáticos e endpoints de apoio.
 *
 * Sem framework: o app tem poucas rotas e um diretório público. O que importa
 * aqui é rigor — caminhos normalizados, CSP restrita, compressão e cache
 * coerente com o ciclo de vida de cada arquivo.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { iceConfiguration } from "./ice.js";
import { VERSION } from "./version.js";
import { ehDaRede } from "./rede.js";
import { ROTA_CURTA, origemPublica, paginaDoConvite } from "./convite.js";
import { log } from "./logger.js";
import { proxySfuHttp } from "./sfu.js";
import { proxyCinema } from "./cinema.js";

/**
 * Raiz do projeto.
 *
 * `import.meta.url` só existe em módulos ESM. Dentro do executável o código foi
 * convertido para CommonJS e ele vira `undefined`, o que fazia o programa
 * morrer antes de imprimir qualquer coisa. Ali não há árvore de arquivos para
 * apontar mesmo — a interface está embutida e as variáveis vêm do ambiente —,
 * então cair para o diretório do executável é a resposta certa.
 */
function projectRoot() {
  try {
    const url = import.meta?.url;
    if (url) return path.resolve(path.dirname(fileURLToPath(url)), "..");
  } catch {
    /* formato sem import.meta */
  }
  return path.dirname(process.execPath);
}

const root = projectRoot();
const publicDir = path.join(root, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".txt"]);

/**
 * CSP fechada: nenhum script externo, nenhuma conexão fora da própria origem.
 * Os ícones e avatares são servidos localmente justamente para que esta
 * política possa continuar assim.
 */
const CSP = [
  "default-src 'self'",
  /*
   * 'wasm-unsafe-eval' libera SÓ a compilação de WebAssembly (o reconhecedor
   * de fala offline das legendas, public/vendor/vosk.js). Não libera eval()
   * nem script inline: continua valendo apenas código servido por aqui.
   */
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  /*
   * Antes era "'self' ws: wss:", e esse curinga anulava boa parte da proteção:
   * `ws:` sem host libera QUALQUER servidor WebSocket. Um script injetado por
   * uma falha de XSS poderia abrir um socket para fora e escoar o que quisesse
   * da chamada. `'self'` já cobre o WebSocket da mesma origem em todos os
   * navegadores atuais — que é o único ao qual este app se conecta.
   */
  // `vcall-fala:` é o esquema interno do app de mesa que entrega o modelo de
  // reconhecimento de fala guardado no computador (desktop/fala.js). Fora do
  // app ele não existe e não leva a lugar nenhum.
  "connect-src 'self' vcall-fala:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // `navigate-to` foi retirado da especificação e os navegadores hoje apenas
  // reclamam dela no console; `form-action 'none'` acima já cobre o caso que
  // importava aqui.
].join("; ");

/*
 * `upgrade-insecure-requests` SÓ quando a página chegou por HTTPS.
 *
 * Antes ia sempre. Chrome e Firefox isentam localhost dessa regra, mas o
 * Safari não: numa página aberta por http (rede local, ou localhost), ele
 * trocava cada CSS, script e ícone para https no mesmo endereço — que não
 * existe — e a chamada abria em branco. Sobre HTTPS a diretiva continua
 * valendo; sobre http ela não tinha para onde "subir" mesmo.
 */
const CSP_HTTPS = `${CSP}; upgrade-insecure-requests`;

/** Páginas com endereço limpo que não são o app principal. */
const ROTAS_FIXAS = {
  "/abrir": "/abrir.html",
  "/abrir/": "/abrir.html",
  // O QR do QuizzV: o token de pareamento vai no fragmento, nunca na URL.
  "/quizzv": "/quizzv.html",
  "/quizzv/": "/quizzv.html",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Uma aba aberta por este site não recebe referência de volta para a janela.
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
  // Necessário para câmera, microfone e captura de tela funcionarem.
  "Permissions-Policy":
    "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(), payment=()",
};

/**
 * Cabeçalhos da resposta, já considerando se a conexão chegou por HTTPS.
 *
 * O HSTS só faz sentido — e só é obedecido — sobre HTTPS. Por trás de um túnel
 * ou de um proxy, o TLS termina lá fora e aqui o socket é texto puro; quem diz
 * a verdade é o `x-forwarded-proto`, em que só confiamos com TRUST_PROXY
 * ligado. Vai sem `includeSubDomains` e sem `preload` de propósito: são as
 * duas partes difíceis de desfazer se o domínio mudar de uso depois.
 */
function headersFor(req) {
  const proto = config.trustProxy ? String(req.headers["x-forwarded-proto"] || "") : "";
  const secure = req.socket.encrypted === true || proto.split(",")[0].trim() === "https";
  if (!secure) return SECURITY_HEADERS;
  return {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": CSP_HTTPS,
    "Strict-Transport-Security": "max-age=31536000",
  };
}

/** Cache de metadados (etag + tamanho) para não reler o disco a cada request. */
const metaCache = new Map();

async function statFile(abs) {
  const cached = metaCache.get(abs);
  const st = await fsp.stat(abs);
  // Uma pasta não é servível. Sem esta guarda, o fluxo seguiria e o
  // createReadStream falharia com EISDIR já depois dos cabeçalhos enviados,
  // derrubando a conexão sem explicação nenhuma para o navegador.
  if (!st.isFile()) {
    const err = new Error("não é um arquivo");
    err.code = "ENOTFILE";
    throw err;
  }
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const hash = createHash("sha1");
  hash.update(`${st.size}-${st.mtimeMs}`);
  const meta = { mtimeMs: st.mtimeMs, size: st.size, etag: `W/"${hash.digest("hex").slice(0, 16)}"` };
  metaCache.set(abs, meta);
  return meta;
}

function cacheControl(ext, pathname) {
  if (pathname === "/" || ext === ".html") return "no-cache";
  // vendor/ e assets/ mudam raramente e são regenerados por script.
  if (pathname.startsWith("/vendor/") || pathname.startsWith("/assets/")) {
    return config.dev ? "no-cache" : "public, max-age=604800";
  }
  /*
   * O código do app (js/, css/) é sempre revalidado: o ETag responde 304 sem
   * corpo, então custa só a ida e volta. Com uma hora de cache, quem abria o
   * app logo depois de atualizar recebia o index.html novo com o main.js da
   * versão anterior guardado — e os jogos novos simplesmente não apareciam.
   */
  return "no-cache";
}

/**
 * Resolve o caminho do request dentro de public/, barrando travessia.
 *
 * O caminho de uma URL é sempre POSIX — separado por "/" — mesmo quando o
 * servidor roda no Windows. Por isso ele é decomposto em segmentos aqui, em
 * vez de passar por `path.normalize`: no Windows essa função converte "/" em
 * "\", e a comparação com "/" para detectar a raiz falha em silêncio. O
 * resultado era o servidor tentar entregar a própria pasta `public` como se
 * fosse um arquivo — a leitura falhava, a conexão caía, e o navegador mostrava
 * "a página não funciona" com o servidor aparentemente no ar.
 *
 * Decompor em segmentos também é a forma mais segura de barrar travessia:
 * qualquer ".." é descartado antes de tocar no sistema de arquivos.
 */
function resolveSafe(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // percentuais inválidos
  }
  if (decoded.includes("\0")) return null;

  const segments = [];
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    // Uma barra invertida num segmento só pode ser tentativa de travessia.
    if (part.includes("\\")) return null;
    segments.push(part);
  }

  const abs = segments.length ? path.join(publicDir, ...segments) : path.join(publicDir, "index.html");
  // Confirmação final, já com separadores do sistema.
  const rel = path.relative(publicDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

function pickEncoding(req, ext, size) {
  if (!COMPRESSIBLE.has(ext) || size < 1024) return null;
  const accept = String(req.headers["accept-encoding"] || "");
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return null;
}

/**
 * @param {object} opts
 * @param {object|null} opts.registry
 * @param {((req, res, url, headers) => boolean|Promise<boolean>)|null} opts.control
 *   Gancho para rotas privadas do aplicativo desktop (ligar e desligar o
 *   túnel). Recebe a requisição antes de tudo e devolve `true` se já a
 *   respondeu. Fica fora deste arquivo de propósito: é código que só existe
 *   quando o app roda como executável, e o servidor web puro não deve nem
 *   conhecer a existência dele.
 */
export function createHttpServer({
  registry = null,
  control = null,
  assets = null,
  trustTailscale = config.trustTailscale,
  rede = null,
  pessoa = null,
} = {}) {
  const daRede = (req) => ehDaRede(req, { trustTailscale, trustProxy: config.trustProxy });
  const server = http.createServer(async (req, res) => {
    // A sinalização do SFU de quem transmite (só no app de mesa).
    if (proxySfuHttp(req, res)) return;
    // Os vídeos do "Assistir junto", de quem hospeda (src/cinema.js).
    if (registry && (await proxyCinema(req, res, registry))) return;
    const SEC = headersFor(req);
    const method = req.method || "GET";

    // O controle é o único que pode responder a POST; o resto do servidor
    // serve arquivos e não tem nada para receber.
    if (control && (await control(req, res, SEC))) return;

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { ...SEC, Allow: "GET, HEAD" });
      return res.end();
    }

    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400, SEC);
      return res.end();
    }
    const pathname = url.pathname;

    // --- endpoints -------------------------------------------------------
    if (pathname === "/ice") {
      const body = JSON.stringify(await iceConfiguration());
      res.writeHead(200, {
        ...SEC,
        "Content-Type": MIME[".json"],
        "Cache-Control": "no-store",
      });
      return res.end(method === "HEAD" ? undefined : body);
    }

    /**
     * Diretório de salas públicas para o painel inicial.
     *
     * Só entra aqui o que foi publicado de propósito: salas privadas — o
     * padrão — nunca aparecem, porque o id delas é o próprio segredo.
     */
    if (pathname === "/api/rooms") {
      const daqui = daRede(req);
      const rooms = registry ? registry.directory({ rede: daqui }) : [];
      res.writeHead(200, {
        ...SEC,
        "Content-Type": MIME[".json"],
        "Cache-Control": "no-store",
      });
      return res.end(
        method === "HEAD"
          ? undefined
          : // `servidor` identifica um Vcall para quem procura computadores na tailnet;
            // `pessoa` (nome e avatar de quem usa o app) só sai para a tailnet.
            JSON.stringify({
              servidor: "vcall",
              versao: VERSION?.version || null,
              rooms,
              stats: registry?.stats() || null,
              pessoa: (daqui && pessoa?.()) || null,
            }),
      );
    }

    /*
     * As chamadas de todos os computadores com Vcall na rede Tailscale. Quem
     * junta é o app de mesa (desktop/rede.js); aqui só se decide quem pode
     * ver: a própria máquina e quem chegou pela tailnet. Para o resto (o
     * túnel do Cloudflare, a internet) a rota não existe.
     */
    if (pathname === "/api/rede") {
      if (!rede || !daRede(req)) {
        res.writeHead(404, { ...SEC, "Content-Type": MIME[".json"] });
        return res.end(method === "HEAD" ? undefined : JSON.stringify({ disponivel: false }));
      }
      let corpo;
      try {
        corpo = await rede(req);
      } catch (err) {
        corpo = { disponivel: false, erro: String(err?.message || err) };
      }
      res.writeHead(200, { ...SEC, "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      return res.end(method === "HEAD" ? undefined : JSON.stringify(corpo));
    }

    /*
     * Link curto do convite: /c/CODIGO. A página é a do /abrir, com a prévia
     * desta chamada (nome, quem chamou, imagem da marca) para o WhatsApp
     * mostrar o cartão no lugar do link comprido. Ver src/convite.js.
     */
    const curto = ROTA_CURTA.exec(pathname);
    if (curto) {
      let sala = registry?.byCode(curto[1]) || null;
      // "Na minha rede" não existe para quem chega pelo link público.
      if (sala && sala.visibility === "rede" && !daRede(req)) sala = null;
      let html;
      try {
        html = assets ? assets.get("/abrir.html").toString("utf8") : await fsp.readFile(path.join(publicDir, "abrir.html"), "utf8");
      } catch {
        res.writeHead(404, SEC);
        return res.end();
      }
      const corpo = paginaDoConvite(html, { sala, origem: origemPublica(req), codigo: curto[1].toUpperCase() });
      res.writeHead(200, { ...SEC, "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      return res.end(method === "HEAD" ? undefined : corpo);
    }

    /** Resolve um código curto (VC-XXXXXX) no id longo da sala. */
    if (pathname.startsWith("/api/code/")) {
      const code = pathname.slice("/api/code/".length);
      const room = registry?.byCode(decodeURIComponent(code));
      const body = room
        ? { ok: true, id: room.id, name: room.name, locked: room.locked, size: room.size }
        : { ok: false };
      res.writeHead(room ? 200 : 404, {
        ...SEC,
        "Content-Type": MIME[".json"],
        "Cache-Control": "no-store",
      });
      return res.end(method === "HEAD" ? undefined : JSON.stringify(body));
    }

    if (pathname === "/healthz") {
      res.writeHead(200, { ...SEC, "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      return res.end(
        JSON.stringify({
          ok: true,
          uptime: Math.round(process.uptime()),
          ...VERSION,
          ...(registry?.stats() || {}),
        }),
      );
    }

    // --- arquivos estáticos ---------------------------------------------

    /*
     * Dentro do executável não existe pasta public/: os arquivos foram
     * embutidos no binário e chegam aqui por `assets`. Responder da memória é,
     * de quebra, mais rápido — some uma leitura de disco por requisição.
     */
    /*
     * /abrir é a página do convite que vai pelo WhatsApp: um endereço https
     * que abre o aplicativo (vcall://) ou cai no navegador. Tem arquivo
     * próprio; as demais rotas sem extensão continuam indo para o app.
     */
    const caminho = ROTAS_FIXAS[pathname] || pathname;

    if (assets) {
      const rota = caminho === "/" ? "/index.html" : caminho;
      // Rotas do app (links de sala) não têm extensão e caem no index.html.
      const alvo = assets.has(rota) ? rota : path.extname(rota) ? null : "/index.html";
      if (!alvo) {
        res.writeHead(404, { ...SEC, "Content-Type": MIME[".txt"] });
        return res.end("não encontrado");
      }
      const buf = assets.get(alvo);
      const ext2 = path.extname(alvo).toLowerCase();
      const etag = `W/"${buf.length.toString(16)}-${VERSION.build}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ...SEC, ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        ...SEC,
        "Content-Type": MIME[ext2] || "application/octet-stream",
        "Cache-Control": cacheControl(ext2, alvo),
        "Content-Length": buf.length,
        ETag: etag,
      });
      return res.end(method === "HEAD" ? undefined : buf);
    }

    let abs = resolveSafe(caminho);
    if (!abs) {
      res.writeHead(400, SEC);
      return res.end();
    }

    let ext = path.extname(abs).toLowerCase();
    let meta;
    try {
      meta = await statFile(abs);
    } catch {
      // Rotas do app (links de sala) caem no index.html.
      if (!ext) {
        abs = path.join(publicDir, "index.html");
        ext = ".html";
        try {
          meta = await statFile(abs);
        } catch {
          res.writeHead(404, SEC);
          return res.end("não encontrado");
        }
      } else {
        res.writeHead(404, { ...SEC, "Content-Type": MIME[".txt"] });
        return res.end("não encontrado");
      }
    }

    if (req.headers["if-none-match"] === meta.etag) {
      res.writeHead(304, { ...SEC, ETag: meta.etag });
      return res.end();
    }

    const headers = {
      ...SEC,
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControl(ext, pathname),
      ETag: meta.etag,
      Vary: "Accept-Encoding",
    };

    const encoding = pickEncoding(req, ext, meta.size);
    if (encoding) headers["Content-Encoding"] = encoding;
    else headers["Content-Length"] = String(meta.size);

    res.writeHead(200, headers);
    if (method === "HEAD") return res.end();

    const stream = fs.createReadStream(abs);
    stream.on("error", () => res.destroy());
    if (encoding === "br") {
      stream.pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })).pipe(res);
    } else if (encoding === "gzip") {
      stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      stream.pipe(res);
    }
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  log.debug("servidor http pronto", assets ? { interface: "embutida" } : { publicDir });
  return server;
}
