#!/usr/bin/env node
/**
 * scripts/bench-video.mjs — mede o vídeo da câmera (ou da tela) numa rede ruim de mentira.
 *
 * Sobe o Vcall, um coturn e um proxy de rede ruim por pessoa
 * (scripts/rede-ruim.mjs), força toda a mídia pelo TURN e abre N pessoas
 * numa sala, todas com a mesma câmera falsa: um vídeo com o número do quadro
 * gravado num código de barras no canto. A cada segundo lê as estatísticas
 * de quem recebe; a cada 3 s captura um quadro recebido, lê o número dele e,
 * no fim, calcula o PSNR contra o quadro original (ffmpeg). Assim dá para
 * comparar codecs e ajustes pela imagem que chega, não pelo QP de cada um.
 *
 *   node scripts/bench-video.mjs --rede casa --pessoas 2 --segundos 45
 *   --trials WebRTC-FlexFEC-03/Enabled/...   simula o app de mesa (desktop/webrtc.js)
 *   --qps 60                                 câmera que captura a 60 qps
 *   --video arquivo.y4m                      outra câmera falsa (1280×720, com o código de barras)
 *
 * Redes: fibra, casa, 4g, ruim (scripts/rede-ruim.mjs). Precisa de coturn
 * (turnserver) e ffmpeg. A câmera falsa é um .y4m que o Chromium repete em
 * laço; sem --video, ele é gerado na pasta temporária (uma vez, ~400 MB):
 * fundo suave, um quadro detalhado se mexendo como uma cabeça, granulado de
 * sensor, e o número do quadro em binário no canto (10 blocos de 40 px).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { abrirPorta, REDES } from "./rede-ruim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? process.argv[i + 1] : padrao;
};
const QPS = Number(arg("qps", 30));
const VIDEO = arg("video") || gerarVideo(QPS);
const REDE = arg("rede", "casa");
const PESSOAS = Number(arg("pessoas", 2));
const SEGUNDOS = Number(arg("segundos", 45));
const AQUECER = Number(arg("aquecer", 8));
const ROTULO = arg("rotulo", "medida");
const SAIDA = path.resolve(arg("saida", path.join(root, "bench-saida")), `${ROTULO}-${REDE}-${PESSOAS}p`);
const PORTA = Number(arg("porta", 3992));
/** Field trials do Chromium (as mesmas que o app de mesa pode ligar). */
const TRIALS = arg("trials", "");
const TURN_PORTA = 34790;
const SEGREDO = "segredo-do-bench";

/** A câmera falsa padrão: 300 quadros (10 s a 30 qps, 5 s a 60). */
function gerarVideo(qps) {
  const arq = path.join(os.tmpdir(), `vcall-bench-camera-${qps}.y4m`);
  if (existsSync(arq)) return arq;
  let bits = "";
  for (let i = 0; i < 10; i++) bits += `,drawbox=x=${i * 48 + 8}:y=8:w=40:h=40:color=white:t=fill:enable='mod(floor(n/${2 ** i}),2)'`;
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `gradients=size=1280x720:rate=${qps}:speed=${0.12 / qps}:n=4`,
      "-f", "lavfi", "-i", `testsrc2=size=520x560:rate=${qps}`,
      "-filter_complex", `[0:v][1:v]overlay=x='380+120*sin(t*0.9)':y='110+25*sin(t*1.7)',noise=alls=5:allf=t,drawbox=x=0:y=0:w=496:h=56:color=black:t=fill${bits},format=yuv420p`,
      "-frames:v", "300", "-f", "yuv4mpegpipe", arq,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    console.error("não deu para gerar a câmera falsa (ffmpeg instalado?)");
    process.exit(2);
  }
  return arq;
}
const rede = REDES[REDE];
if (!rede) {
  console.error(`rede desconhecida: ${REDE} (${Object.keys(REDES).join(", ")})`);
  process.exit(2);
}
mkdirSync(SAIDA, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- infraestrutura ---------------- */

const turn = spawn(
  "turnserver",
  [
    "-n", "--no-cli", "--no-tls", "--no-dtls", "--log-file=stdout",
    "--listening-ip=127.0.0.1", "--relay-ip=127.0.0.1", `--listening-port=${TURN_PORTA}`,
    "--min-port=49400", "--max-port=49900",
    "--use-auth-secret", `--static-auth-secret=${SEGREDO}`, "--realm=vcall.bench",
    "--allow-loopback-peers", "--fingerprint", "--no-multicast-peers",
  ],
  { stdio: "ignore" },
);
const servidor = spawn("node", ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORTA),
    NODE_ENV: "production",
    LOG_LEVEL: "error",
    TURN_URLS: `turn:127.0.0.1:${TURN_PORTA}?transport=udp`,
    TURN_SECRET: SEGREDO,
    ICE_TRANSPORT_POLICY: "relay",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const portas = await Promise.all(
  Array.from({ length: PESSOAS }, (_, i) =>
    abrirPorta({ porta: 34800 + i, turn: { host: "127.0.0.1", porta: TURN_PORTA }, subida: rede, descida: rede }),
  ),
);
await espera(1200);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${path.resolve(VIDEO)}`,
    "--autoplay-policy=no-user-gesture-required",
    // Sem isto o Chromium em segundo plano economiza quadros nas abas escondidas.
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    ...(TRIALS ? [`--force-fieldtrials=${TRIALS}`] : []),
  ],
});

async function abrir(i) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  // Cada pessoa fala com o TURN pela própria porta do proxy (a própria "internet").
  await page.route("**/ice", async (route) => {
    const r = await route.fetch();
    const cfg = await r.json();
    for (const s of cfg.iceServers || []) {
      const urls = [].concat(s.urls).map((u) => (String(u).startsWith("turn") ? `turn:127.0.0.1:${portas[i].porta}?transport=udp` : u));
      s.urls = urls.filter((u) => u.startsWith("turn"));
    }
    cfg.iceServers = cfg.iceServers.filter((s) => s.urls.length);
    cfg.iceTransportPolicy = "relay";
    await route.fulfill({ response: r, json: cfg });
  });
  await page.goto(`http://localhost:${PORTA}/#bench-video-sala-abcdefghij`, { waitUntil: "networkidle" });
  await page.fill("#nameInput", `P${i}`);
  await page.click("#joinBtn");
  await page.waitForSelector("#dock:not([hidden])", { timeout: 15_000 });
  return page;
}

/* ---------------- medição ---------------- */

/** Estatísticas de cada câmera recebida por esta página, e da própria câmera enviada. */
const ler = (page) =>
  page.evaluate(async () => {
    const out = { rx: {}, tx: {} };
    for (const [id, peer] of window.vcall.mesh.peers) {
      const rec = peer.tx.cam?.receiver;
      if (rec) {
        const st = await rec.getStats();
        st.forEach((r) => {
          if (r.type !== "inbound-rtp" || r.kind !== "video") return;
          const codec = st.get(r.codecId)?.mimeType || null;
          out.rx[id] = {
            t: r.timestamp, codec, dec: r.decoderImplementation || null,
            frames: r.framesDecoded || 0, w: r.frameWidth || 0, h: r.frameHeight || 0,
            freezes: r.freezeCount || 0, freezeS: r.totalFreezesDuration || 0, pauseS: r.totalPausesDuration || 0,
            qpSum: r.qpSum || 0, bytes: r.bytesReceived || 0, lost: r.packetsLost || 0, pkts: r.packetsReceived || 0,
            jb: r.jitterBufferDelay || 0, jbN: r.jitterBufferEmittedCount || 0,
            nack: r.nackCount || 0, pli: r.pliCount || 0, keys: r.keyFramesDecoded || 0, dropped: r.framesDropped || 0,
            fec: r.fecPacketsReceived || 0, fecDesc: r.fecPacketsDiscarded || 0, rtx: r.retransmittedPacketsReceived || 0,
          };
        });
      }
      const snd = peer.tx.cam?.sender;
      if (snd) {
        const st = await snd.getStats();
        st.forEach((r) => {
          if (r.type !== "outbound-rtp" || r.kind !== "video") return;
          out.tx[id] = {
            alvo: r.targetBitrate || 0, w: r.frameWidth || 0, h: r.frameHeight || 0, fps: r.framesPerSecond || 0,
            lim: r.qualityLimitationReason || "none", enc: r.encoderImplementation || null, svc: r.scalabilityMode || null,
            frames: r.framesEncoded || 0, encS: r.totalEncodeTime || 0, rtxBytes: r.retransmittedBytesSent || 0,
            bytes: r.bytesSent || 0,
            cam60: !!peer.camera60, codecPedido: peer.codecCamera || null,
            disp: window.vcall.stats?.get(id)?.transport?.availableOutgoing ?? null,
            fonteQps: window.vcall.stats?.get(id)?.outbound?.cam?.sourceFps ?? null,
          };
        });
      }
    }
    return out;
  });

/**
 * Captura um quadro recebido de cada câmera, no tamanho original do vídeo
 * de teste, e lê o número do quadro no código de barras do canto.
 */
const capturar = (page) =>
  page.evaluate(async () => {
    const res = [];
    for (const [id, peer] of window.vcall.mesh.peers) {
      const track = peer.tx.cam?.receiver?.track;
      if (!track || track.readyState !== "live") continue;
      window.__bench ||= {};
      let v = window.__bench[id];
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.srcObject = new MediaStream([track]);
        await v.play().catch(() => {});
        window.__bench[id] = v;
      }
      if (!v.videoWidth) continue;
      const c = new OffscreenCanvas(1280, 720);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(v, 0, 0, 1280, 720);
      const px = g.getImageData(0, 0, 496, 56).data;
      let n = 0;
      for (let b = 0; b < 10; b++) {
        const x = b * 48 + 28;
        const o = (28 * 496 + x) * 4;
        if (px[o] + px[o + 1] + px[o + 2] > 3 * 128) n |= 1 << b;
      }
      const blob = await c.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      res.push({ id, quadro: n, w: v.videoWidth, h: v.videoHeight, png: btoa(s) });
    }
    return res;
  });

const amostras = [];
const capturas = [];
let paginas = [];
try {
  paginas = [];
  for (let i = 0; i < PESSOAS; i++) {
    paginas.push(await abrir(i));
    await espera(400);
  }
  await Promise.all(
    paginas.map((p) =>
      p.waitForFunction(
        (n) => window.vcall.mesh.peers.size === n && [...window.vcall.mesh.peers.values()].every((x) => x.connectionState === "connected"),
        PESSOAS - 1,
        { timeout: 40_000 },
      ),
    ),
  );
  const nomes = await Promise.all(paginas.map((p) => p.evaluate(() => window.vcall.mesh.selfId)));
  console.log(`[${ROTULO}] ${PESSOAS} pessoas na rede "${REDE}" conectadas; aquecendo ${AQUECER} s`);
  await espera(AQUECER * 1000);

  for (let s = 0; s < SEGUNDOS; s++) {
    const t0 = Date.now();
    const leituras = await Promise.all(paginas.map(ler));
    amostras.push({ s, leituras });
    if (s % 3 === 1) {
      const cs = await Promise.all(paginas.map(capturar));
      cs.forEach((lista, quem) => lista.forEach((c) => capturas.push({ s, quem, ...c })));
    }
    await espera(Math.max(0, 1000 - (Date.now() - t0)));
  }

  /* ---------------- resumo ---------------- */
  const porFluxo = new Map(); // "quem<-de" -> lista de leituras
  amostras.forEach(({ leituras }) =>
    leituras.forEach((l, quem) => {
      for (const [de, r] of Object.entries(l.rx)) {
        const k = `${nomes[quem]}<-${de}`;
        if (!porFluxo.has(k)) porFluxo.set(k, []);
        porFluxo.get(k).push(r);
      }
    }),
  );
  const txDe = (de, para) => amostras.map(({ leituras }) => leituras[nomes.indexOf(de)]?.tx?.[para]).filter(Boolean);

  const fluxos = [];
  for (const [k, lista] of porFluxo) {
    const [para, de] = k.split("<-");
    const qps = [];
    for (let i = 1; i < lista.length; i++) qps.push(((lista[i].frames - lista[i - 1].frames) * 1000) / Math.max(1, lista[i].t - lista[i - 1].t));
    const a = lista[0];
    const z = lista.at(-1);
    const dur = (z.t - a.t) / 1000;
    const quadros = z.frames - a.frames;
    const ord = [...qps].sort((x, y) => x - y);
    const tx = txDe(de, para);
    const lims = {};
    tx.forEach((x) => (lims[x.lim] = (lims[x.lim] || 0) + 1));
    fluxos.push({
      fluxo: k,
      codec: z.codec,
      encoder: tx.at(-1)?.enc,
      qpsMedio: +(quadros / dur).toFixed(1),
      qpsP10: +(ord[Math.floor(ord.length * 0.1)] ?? 0).toFixed(1),
      segundosAbaixoDe15qps: qps.filter((q) => q < 15).length,
      congeladoS: +(z.freezeS - a.freezeS).toFixed(2),
      congelamentos: z.freezes - a.freezes,
      alturaMedia: Math.round(lista.reduce((s, r) => s + r.h, 0) / lista.length),
      trocasDeResolucao: lista.filter((r, i) => i && r.h !== lista[i - 1].h).length,
      kbps: Math.round(((z.bytes - a.bytes) * 8) / dur / 1000),
      perdaPct: +(((z.lost - a.lost) * 100) / Math.max(1, z.pkts - a.pkts + (z.lost - a.lost))).toFixed(2),
      jitterBufferMs: z.jbN - a.jbN ? Math.round(((z.jb - a.jb) / (z.jbN - a.jbN)) * 1000) : null,
      qpMedio: quadros ? +((z.qpSum - a.qpSum) / quadros).toFixed(1) : null,
      plis: z.pli - a.pli,
      fec: z.fec - a.fec,
      rtx: z.rtx - a.rtx,
      svc: tx.at(-1)?.svc || null,
      quadrosChave: z.keys - a.keys,
      limitacao: lims,
    });
  }

  // PSNR de cada quadro capturado contra o original (sem a faixa do código de barras).
  const psnrs = [];
  for (const c of capturas) {
    if (c.quadro >= 300) continue;
    const arq = path.join(SAIDA, `q-${c.s}-${c.quem}-${c.id}-${c.quadro}.png`);
    writeFileSync(arq, Buffer.from(c.png, "base64"));
    const r = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-i", arq, "-i", path.resolve(VIDEO), "-lavfi", `[1:v]select=eq(n\\,${c.quadro}),crop=1280:660:0:60[ref];[0:v]crop=1280:660:0:60,format=yuv420p[rx];[rx][ref]psnr`, "-frames:v", "1", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const m = /average:([\d.]+|inf)/.exec(r.stderr || "");
    const v = m ? (m[1] === "inf" ? 99 : Number(m[1])) : null;
    if (v != null && v > 12) psnrs.push({ fluxo: `${nomes[c.quem]}<-${c.id}`, s: c.s, quadro: c.quadro, h: c.h, psnr: v });
  }
  for (const f of fluxos) {
    const lista = psnrs.filter((p) => p.fluxo === f.fluxo).map((p) => p.psnr);
    f.psnrMedio = lista.length ? +(lista.reduce((s, x) => s + x, 0) / lista.length).toFixed(2) : null;
    f.psnrMin = lista.length ? +Math.min(...lista).toFixed(2) : null;
    f.capturas = lista.length;
  }

  const resumo = { rotulo: ROTULO, trials: TRIALS || null, rede: REDE, perfil: rede, pessoas: PESSOAS, segundos: SEGUNDOS, fluxos };
  writeFileSync(path.join(SAIDA, "resumo.json"), JSON.stringify({ ...resumo, amostras, psnrs, contadores: portas.map((p) => p.contadores()) }, null, 1));
  console.log(JSON.stringify(resumo, null, 1));
} finally {
  await browser.close().catch(() => {});
  servidor.kill();
  turn.kill();
  for (const p of portas) p.fechar();
}
