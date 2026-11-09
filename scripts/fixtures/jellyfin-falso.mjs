#!/usr/bin/env node
/**
 * scripts/fixtures/jellyfin-falso.mjs — PROTÓTIPO. Um Jellyfin de mentira.
 *
 * Responde só às rotas que o proxy do protótipo usa, no mesmo formato do
 * Jellyfin 10.x: GET /Items?searchTerm=... e GET /Videos/{id}/stream?static=true
 * (com Range). Recusa sem a chave, como o real.
 *
 * Uso: node scripts/fixtures/jellyfin-falso.mjs <porta> <chave> <video.mp4>
 * Cada pedido é registrado em stdout, para conferir o que chegou aqui.
 */
import { createReadStream, statSync } from "node:fs";
import http from "node:http";

const [porta, chave, arquivo] = process.argv.slice(2);
const ITEM = { Id: "0123456789abcdef0123456789abcdef", Name: "Vídeo de teste (Big Buck Bunny falso)", Type: "Movie" };
const tamanho = statSync(arquivo).size;

function autenticado(req) {
  const a = req.headers.authorization || "";
  return a.includes(`Token="${chave}"`) || req.headers["x-emby-token"] === chave;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    console.log(`[jellyfin-falso] ${req.method} ${url.pathname}${url.search} range=${req.headers.range || "-"} auth=${autenticado(req)}`);
    if (!autenticado(req)) return res.writeHead(401).end();

    if (url.pathname === "/Items") {
      const busca = (url.searchParams.get("searchTerm") || "").toLowerCase();
      const itens = ITEM.Name.toLowerCase().includes(busca) ? [{ ...ITEM, RunTimeTicks: 30 * 1e7 }] : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ Items: itens, TotalRecordCount: itens.length }));
    }

    if (url.pathname === `/Videos/${ITEM.Id}/stream`) {
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      if (!r) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": tamanho, "Accept-Ranges": "bytes" });
        return createReadStream(arquivo).pipe(res);
      }
      const ini = r[1] ? Number(r[1]) : tamanho - Number(r[2]);
      const fim = r[1] && r[2] ? Math.min(Number(r[2]), tamanho - 1) : tamanho - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": fim - ini + 1,
        "Content-Range": `bytes ${ini}-${fim}/${tamanho}`,
        "Accept-Ranges": "bytes",
      });
      return createReadStream(arquivo, { start: ini, end: fim }).pipe(res);
    }

    // Uma rota "perigosa" que o proxy não deve deixar passar.
    if (url.pathname === "/Users") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{ Name: "admin", Policy: { IsAdministrator: true } }]));
    }
    res.writeHead(404).end();
  })
  .listen(Number(porta), "127.0.0.1", () => console.log(`[jellyfin-falso] ouvindo em ${porta}`));
