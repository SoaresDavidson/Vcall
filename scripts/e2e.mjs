#!/usr/bin/env node
/**
 * scripts/e2e.mjs — teste de ponta a ponta com dois navegadores reais.
 *
 * Sobe o servidor, abre duas abas do Chromium com câmera e microfone falsos,
 * entra na mesma sala e verifica que a conexão P2P realmente se estabelece,
 * que o vídeo flui nos dois sentidos, que a troca para compartilhamento de
 * tela acontece sem renegociar linhas de mídia e que o quadro branco
 * sincroniza pelo canal de dados.
 *
 * Roda com: node scripts/e2e.mjs
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3999;
const URL_BASE = `http://localhost:${PORT}`;
const ROOM = "e2e-room-para-teste-abcdef";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */

const server = spawn("node", ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", LOG_LEVEL: "warn" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[servidor] ${d}`));
await wait(900);

const browser = await chromium.launch({
  // Usa o Chromium já presente no ambiente quando existir, para não baixar nada.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--allow-running-insecure-content",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const consoleErrors = [];

async function openClient(name) {
  const ctx = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 1280, height: 860 },
  });
  // Guarda os sockets da sinalização, para o teste poder derrubar um.
  await ctx.addInitScript(() => {
    const W = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        window.__sockets.push(this);
      }
    };
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${name}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${name}] pageerror: ${e.message}`));

  await page.goto(`${URL_BASE}/#${ROOM}`, { waitUntil: "networkidle" });
  await page.fill("#nameInput", name);
  await page.click("#joinBtn");
  await page.waitForSelector("#dock:not([hidden])", { timeout: 10_000 });
  return { ctx, page };
}

try {
  console.log("\nAbrindo dois participantes na mesma sala…");
  const a = await openClient("Alice");
  await wait(600);
  const b = await openClient("Bruno");

  /* -- 1. ambos entraram e se enxergam ---------------------------- */
  await a.page.waitForFunction(() => window.vcall?.mesh.peers.size === 1, { timeout: 15_000 });
  await b.page.waitForFunction(() => window.vcall?.mesh.peers.size === 1, { timeout: 15_000 });
  check("os dois participantes se descobrem pela sinalização", true);

  /* -- 2. conexão P2P estabelecida -------------------------------- */
  const connected = async (page) =>
    page.waitForFunction(
      () => [...window.vcall.mesh.peers.values()].every((p) => p.connectionState === "connected"),
      { timeout: 25_000 },
    );
  await Promise.all([connected(a.page), connected(b.page)]);
  check("conexão P2P (DTLS/ICE) estabelecida nos dois sentidos", true);

  /* -- 3. papéis das linhas de mídia ------------------------------ */
  const mids = await a.page.evaluate(() => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    return Object.fromEntries(Object.entries(peer.tx).map(([role, tx]) => [role, tx.mid]));
  });
  const midsOk =
    mids.mic != null && mids.cam != null && mids.screen != null && mids.screenAudio != null &&
    new Set(Object.values(mids)).size === 4;
  check("quatro linhas de mídia fixas e distintas", midsOk, JSON.stringify(mids));

  /* -- 4. vídeo realmente chegando -------------------------------- */
  await wait(3000);
  const framesFor = (page) =>
    page.evaluate(async () => {
      const peer = [...window.vcall.mesh.peers.values()][0];
      const stats = await peer.pc.getStats();
      let frames = 0;
      let bytes = 0;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          frames += r.framesDecoded || 0;
          bytes += r.bytesReceived || 0;
        }
      });
      return { frames, bytes };
    });
  const [fa, fb] = await Promise.all([framesFor(a.page), framesFor(b.page)]);
  check("Alice recebe quadros de vídeo de Bruno", fa.frames > 0, `${fa.frames} quadros, ${fa.bytes} B`);
  check("Bruno recebe quadros de vídeo de Alice", fb.frames > 0, `${fb.frames} quadros, ${fb.bytes} B`);

  /* -- 4b. voz: RED negociado e áudio chegando --------------------- */
  const voz = (page) =>
    page.evaluate(async () => {
      const peer = [...window.vcall.mesh.peers.values()][0];
      const sender = peer.tx.mic.sender;
      let enviados = 0;
      (await sender.getStats()).forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "audio") enviados += r.packetsSent || 0;
      });
      // As estatísticas do Chrome dizem "opus" mesmo com RED por fora; o
      // codec em uso é o primeiro dos parâmetros negociados.
      const mime = sender.getParameters().codecs?.[0]?.mimeType || "";
      const fmtp = peer.pc.remoteDescription.sdp.split("\r\n").filter((l) => /^a=fmtp:\d+ .*useinbandfec/.test(l));
      return { mime, enviados, fmtp: fmtp[0] || "" };
    });
  const [va, vb] = await Promise.all([voz(a.page), voz(b.page)]);
  check("voz com redundância (RED) nos dois sentidos", /red/i.test(va.mime) && /red/i.test(vb.mime), `${va.mime} / ${vb.mime}`);
  check("voz com FEC e DTX pedidos ao Opus", /usedtx=1/.test(va.fmtp) && /usedtx=1/.test(vb.fmtp), va.fmtp);
  check("pacotes de voz saindo", va.enviados > 0 && vb.enviados > 0, `${va.enviados} / ${vb.enviados}`);

  /* -- 5. ladrilhos remotos montados ------------------------------ */
  const tileIds = (page) =>
    page.evaluate(() => [...document.querySelectorAll(".tile")].map((n) => n.dataset.tile));
  const [ta, tb] = await Promise.all([tileIds(a.page), tileIds(b.page)]);
  check("Alice vê o ladrilho dela e o de Bruno", ta.length === 2, ta.join(", "));
  check(
    "Bruno, que entrou depois, vê o ladrilho de quem já estava na sala",
    tb.length === 2,
    tb.join(", "),
  );

  /* -- 6. compartilhamento de tela SEM renegociar linha de mídia -- */
  const beforeMid = (await a.page.evaluate(() => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    return peer.pc.getTransceivers().length;
  }));

  await a.page.evaluate(async () => {
    // Injeta uma trilha sintética no lugar do getDisplayMedia, que não pode
    // ser acionado sem interação real num navegador sem interface.
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    let i = 0;
    setInterval(() => {
      i += 1;
      ctx.fillStyle = i % 2 ? "#fd4d87" : "#110c3a";
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#fff";
      ctx.font = "48px sans-serif";
      ctx.fillText(`quadro ${i}`, 60, 120);
    }, 40);
    const stream = canvas.captureStream(30);
    window.vcall.screen.stream = stream;
    window.vcall.screen.videoTrack = stream.getVideoTracks()[0];
    window.vcall.screen.videoTrack.contentHint = "text";
    window.vcall.screen.emit("change", window.vcall.screen.snapshot());
  });

  // Como no Discord: Bruno vê "Assistir", e a tela não sai da Alice até ele clicar.
  await b.page.waitForSelector(".tile__assistir", { timeout: 15_000 });
  await wait(1500);
  const antesDeAssistir = await a.page.evaluate(() => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    return { pausada: peer.telaPausada, ativa: peer.tx.screen.sender.getParameters().encodings?.[0]?.active };
  });
  check(
    "quem não clicou em Assistir não recebe a tela (o envio fica desligado)",
    antesDeAssistir.pausada === true && antesDeAssistir.ativa === false,
    JSON.stringify(antesDeAssistir),
  );
  await b.page.click(".tile__assistir");

  await b.page.waitForFunction(
    () => {
      const peer = [...window.vcall.mesh.peers.values()][0];
      return !!peer.remote.screen;
    },
    { timeout: 15_000 },
  );

  const afterMid = await a.page.evaluate(
    () => [...window.vcall.mesh.peers.values()][0].pc.getTransceivers().length,
  );
  check(
    "compartilhar tela não cria linha de mídia nova (sem renegociação)",
    beforeMid === afterMid,
    `${beforeMid} → ${afterMid}`,
  );

  await wait(3500);
  const screenIn = await b.page.evaluate(async () => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    const track = peer.tx.screen.receiver.track;
    // getStats() do receptor devolve só os relatórios daquela trilha — sem
    // depender de o navegador expor `mid` nos relatórios de RTP.
    const stats = await peer.tx.screen.receiver.getStats();
    let out = null;
    stats.forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") out = r;
    });
    return out
      ? { frames: out.framesDecoded, w: out.frameWidth, h: out.frameHeight, track: track?.readyState }
      : null;
  });
  check(
    "a tela compartilhada chega decodificada do outro lado",
    !!screenIn && screenIn.frames > 0,
    screenIn ? `${screenIn.frames} quadros, ${screenIn.w}×${screenIn.h}` : "nenhuma trilha",
  );

  /* -- 7. parâmetros do encoder aplicados ------------------------- */
  const params = await a.page.evaluate(() => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    const p = peer.tx.screen.sender.getParameters();
    return {
      degradation: p.degradationPreference,
      maxBitrate: p.encodings?.[0]?.maxBitrate,
      hint: peer.tx.screen.sender.track?.contentHint,
    };
  });
  check(
    "perfil de codificação da tela aplicado (nitidez preservada)",
    params.degradation === "maintain-resolution" && params.maxBitrate > 0 && params.hint === "text",
    JSON.stringify(params),
  );

  /* -- 8. quadro branco pelo canal de dados ----------------------- */
  await a.page.evaluate(() => {
    const peer = [...window.vcall.mesh.peers.values()][0];
    return new Promise((res) => {
      if (peer.board.readyState === "open") return res();
      peer.board.addEventListener("open", res, { once: true });
      setTimeout(res, 5000);
    });
  });

  // Arma o ouvinte SEM esperar, senão o envio só aconteceria depois do timeout.
  const boardPromise = b.page.evaluate(
    () =>
      new Promise((res) => {
        const off = window.vcall.mesh.on("board", (e) => {
          off();
          res(e.via || true);
        });
        setTimeout(() => res(false), 8000);
      }),
  );
  await wait(300);
  await a.page.evaluate(() => {
    window.vcall.mesh.broadcastBoard({
      type: "add",
      op: {
        id: "teste-1",
        by: window.vcall.mesh.selfId,
        type: "pen",
        color: "#fd4d87",
        width: 4,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.6, y: 0.5 },
        ],
      },
    });
  });
  const boardVia = await boardPromise;
  check("operação do quadro branco chega ao outro participante", !!boardVia, `via ${boardVia}`);

  /* -- 9. ÁUDIO: existe saída e há sinal de verdade? -------------- */

  // O dispositivo falso do Chromium gera um tom contínuo, então um medidor
  // ligado na saída tem de acusar energia. É a diferença entre "a trilha
  // chegou" e "está realmente saindo som".
  const audioState = await b.page.evaluate(async () => {
    const peerId = [...window.vcall.mesh.peers.keys()][0];
    const dbg = window.vcall.audio.debug();
    // Mede por ~1s e fica com o pico.
    let peak = 0;
    for (let i = 0; i < 20; i += 1) {
      const level = window.vcall.audio.meter(peerId, "mic");
      if (level != null) peak = Math.max(peak, level);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ...dbg, peak, peerId };
  });

  check(
    "existe uma saída de áudio para a voz do outro participante",
    audioState.outputs.some((o) => o.key.endsWith(":mic")),
    audioState.outputs.map((o) => o.key).join(", ") || "nenhuma",
  );
  check(
    "a saída de áudio está tocando (não pausada, não muda)",
    audioState.outputs.some((o) => o.key.endsWith(":mic") && !o.paused && o.gain > 0),
    JSON.stringify(audioState.outputs.find((o) => o.key.endsWith(":mic")) || {}),
  );
  check(
    "há sinal de áudio medido na saída",
    audioState.peak > 0.001,
    `pico ${audioState.peak.toFixed(4)} · contexto ${audioState.contextState}`,
  );

  // Volume por participante: o original tinha, e voltou.
  const volOk = await b.page.evaluate(() => {
    const peerId = [...window.vcall.mesh.peers.keys()][0];
    const mic = () => window.vcall.audio.debug().outputs.find((o) => o.key.endsWith(":mic"));
    const a100 = mic();
    window.vcall.audio.setVolume(peerId, 1.5);
    const after = mic();
    const at150 = after?.gain;
    const modos = { a100: `${a100?.mode}${a100?.muted ? " mudo" : ""}`, a150: after?.mode };
    window.vcall.audio.setVolume(peerId, 0);
    const muted = window.vcall.audio.debug().outputs.find((o) => o.key.endsWith(":mic"))?.gain;
    window.vcall.audio.setVolume(peerId, 1);
    return { at150, muted, modos, voltou: mic()?.mode, hasSlider: !!document.querySelector(".vol__slider") };
  });
  // O cancelamento de eco do Chrome só enxerga o som que sai por um elemento
  // <audio>: tocada pelo Web Audio, a voz voltava pelo microfone de quem ouvia.
  check(
    "a voz sai pelo <audio> (o cancelamento de eco enxerga); Web Audio só acima de 100%",
    volOk.modos.a100 === "element" && volOk.modos.a150 === "webaudio" && volOk.voltou === "element",
    JSON.stringify(volOk.modos),
  );
  check(
    "volume por participante funciona de 0 a 150%",
    volOk.at150 > 1.2 && volOk.muted === 0 && volOk.hasSlider,
    `150% → ganho ${volOk.at150?.toFixed(2)}, mudo → ${volOk.muted}, controle na tela: ${volOk.hasSlider}`,
  );

  /* -- 9c. avatares: nenhum id repetido na página ------------------ */

  // `id` é global no documento. Dois avatares com o mesmo `id="viewboxMask"`
  // fazem a máscara de um apontar para o outro, e o desenho some — com o SVG
  // inteirinho no DOM, o que torna o bug difícil de enxergar.
  const avatarIds = await b.page.evaluate(() => {
    const all = [];
    for (const svg of document.querySelectorAll(".avatar svg")) {
      for (const node of svg.querySelectorAll("[id]")) all.push(node.id);
    }
    const dup = all.filter((v, i) => all.indexOf(v) !== i);
    // E as referências têm de apontar para algo que existe.
    let quebradas = 0;
    for (const el of document.querySelectorAll(".avatar svg *")) {
      // url(#id) em qualquer atributo de pintura...
      for (const attr of ["mask", "fill", "stroke", "clip-path", "filter"]) {
        const v = el.getAttribute(attr);
        const m = v && /^url\(#([^)]+)\)$/.exec(v);
        // ...e só em href é que "#id" aparece sozinho (fill="#fd4d87" é cor).
        if (m && !document.getElementById(m[1])) quebradas += 1;
      }
      for (const attr of ["href", "xlink:href"]) {
        const v = el.getAttribute(attr);
        if (v && v.startsWith("#") && !document.getElementById(v.slice(1))) quebradas += 1;
      }
    }
    return { total: all.length, dup: [...new Set(dup)], quebradas };
  });
  check(
    "cada avatar tem identificadores internos próprios",
    avatarIds.dup.length === 0 && avatarIds.quebradas === 0,
    `${avatarIds.total} ids, ${avatarIds.dup.length} repetidos, ${avatarIds.quebradas} referências quebradas`,
  );

  /* -- 9b. chat --------------------------------------------------- */
  await a.page.evaluate(() => window.vcall.mesh.sendChat("olá do teste automatizado"));
  await b.page.waitForFunction(
    () => [...document.querySelectorAll(".msg__text")].some((n) => n.textContent.includes("teste automatizado")),
    { timeout: 8000 },
  );
  check("mensagem de chat entregue e renderizada", true);

  /* -- 10. tema claro e escuro ------------------------------------ */
  for (const mode of ["dark", "light"]) {
    await b.page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
    await wait(500);
    await b.page.screenshot({ path: path.join(root, `.e2e-tela-${mode}.png`) });
  }
  // E com o quadro branco aberto ao lado dos vídeos.
  await b.page.click('[data-id="board"]');
  await wait(250);
  await b.page.click(".popover__item");
  await wait(800);
  for (const mode of ["dark", "light"]) {
    await b.page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
    await wait(500);
    await b.page.screenshot({ path: path.join(root, `.e2e-quadro-${mode}.png`) });
  }
  check("capturas de tela e quadro nos dois temas geradas", true);

  /* -- 10b. queda da sinalização não derruba a mídia -------------- */
  // Antes, quem reconectava ganhava um id novo e os outros fechavam a conexão
  // direta com ela: cada oscilação do túnel cortava áudio e vídeo.
  const idB = await b.page.evaluate(() => window.vcall.mesh.selfId);
  await a.page.evaluate(() => {
    window.__parAntes = [...window.vcall.mesh.peers.values()][0];
    window.__removidos = 0;
    window.vcall.mesh.on("peer-removed", () => window.__removidos++);
  });
  await b.page.evaluate(() => window.__sockets.at(-1).close(4000, "teste")); // o mesmo que o alarme do ping faz
  await b.page.waitForFunction(() => window.__sockets.length > 1 && window.__sockets.at(-1).readyState === 1, { timeout: 15_000 });
  await wait(1500);
  const f1 = await framesFor(a.page);
  await wait(1500);
  const f2 = await framesFor(a.page);
  const depois = await a.page.evaluate(() => {
    const par = [...window.vcall.mesh.peers.values()][0];
    return { mesmo: par === window.__parAntes, removidos: window.__removidos, estado: par?.connectionState };
  });
  const idB2 = await b.page.evaluate(() => window.vcall.mesh.selfId);
  check(
    "queda da sinalização não derruba a mídia (mesmo id, mesma conexão)",
    idB2 === idB && depois.mesmo && depois.removidos === 0 && depois.estado === "connected" && f2.frames > f1.frames,
    `id ${idB === idB2 ? "igual" : "mudou"}, conexão ${depois.mesmo ? "mantida" : "refeita"}, ${f2.frames - f1.frames} quadros em 1,5 s`,
  );

  /* -- 11. saída limpa -------------------------------------------- */
  await b.ctx.close();
  await a.page.waitForFunction(() => window.vcall.mesh.peers.size === 0, { timeout: 10_000 });
  check("saída de um participante é propagada", true);

  const realErrors = consoleErrors.filter(
    (e) => !/favicon|ERR_|NotAllowedError|play\(\)/i.test(e),
  );
  check("nenhum erro de JavaScript no console", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await a.ctx.close();
} catch (err) {
  check("execução do teste", false, err.message);
  console.error(err);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
process.exit(failed.length ? 1 : 0);
