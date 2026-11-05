#!/usr/bin/env node
/**
 * scripts/desktop-test.mjs — o aplicativo de mesa (Electron) de verdade.
 *
 * Abre o Vcall como app, entra numa sala com um participante no Chromium e
 * confere o que só existe no app:
 *
 *   - o seletor próprio lista telas E janelas (antes: só a tela inteira);
 *   - compartilhar uma JANELA específica chega ao outro lado;
 *   - compartilhar a tela inteira funciona no Linux (antes: travava por causa
 *     de `audio: undefined`) e mostra o aviso no lugar do efeito espelho;
 *   - a legenda offline carrega o reconhecedor (WebAssembly, sem eval) e
 *     busca o modelo pelo esquema interno.
 *
 * No Linux precisa de uma tela (Xvfb) e de um gerenciador de janelas para as
 * janelas aparecerem na lista:
 *
 *   xvfb-run -a sh -c 'openbox & node scripts/desktop-test.mjs'
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultados = [];
const check = (nome, ok, detalhe = "") => {
  resultados.push({ nome, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Um Tailscale de mentira (scripts/fixtures/tailscale-falso.mjs) com HTTPS
 * de verdade: o certificado é gerado aqui e o app confia nele pelo
 * NODE_EXTRA_CA_CERTS, como confiaria no da Let's Encrypt que o Tailscale usa.
 */
const tsDir = mkdtempSync(path.join(os.tmpdir(), "vcall-ts-"));
const tsCert = path.join(tsDir, "ts.crt");
const tsKey = path.join(tsDir, "ts.key");
let tsOk = true;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=maquina.tail1234.ts.net",
    "-addext", "subjectAltName=DNS:maquina.tail1234.ts.net,DNS:outra-maquina.tail1234.ts.net", "-keyout", tsKey, "-out", tsCert], { stdio: "ignore" });
  chmodSync(path.join(root, "scripts", "fixtures", "tailscale-falso.mjs"), 0o755);
} catch {
  tsOk = false;
}

// O microfone do app é um .wav com uma frase falada: a legenda é testada
// com fala de verdade, do microfone até o texto.
const app = await electron.launch({
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.join(root, "scripts", "fixtures", "fala-teste.wav")}`,
    "desktop/main.js",
  ],
  cwd: root,
  env: {
    ...process.env,
    ...(tsOk
      ? {
          VCALL_TAILSCALE: path.join(root, "scripts", "fixtures", "tailscale-falso.mjs"),
          VCALL_TS_FALSO_CERT: tsCert,
          VCALL_TS_FALSO_KEY: tsKey,
          // 443 "ocupada" (e sem ser root não daria mesmo): o app tem de ir para a 8443.
          VCALL_TS_FALSO_443: "1",
          VCALL_TS_FALSO_HABILITAR: "1",
          NODE_EXTRA_CA_CERTS: tsCert,
        }
      : {}),
  },
});
const win = await app.firstWindow();
const erros = [];
win.on("pageerror", (e) => erros.push(process.env.DEBUG_STACK ? e.stack : e.message));
let browser;

try {
  await win.waitForLoadState("domcontentloaded");
  await espera(2000);
  const base = new URL(win.url()).origin;
  const sala = `desktop-${Date.now().toString(36)}-abcdefghij`;
  await win.evaluate((r) => {
    location.hash = r;
    location.reload();
  }, sala);
  await espera(2500);
  await win.fill("#nameInput", "Desktop");
  await win.click("#joinBtn");
  await win.waitForSelector("#dock:not([hidden])", { timeout: 15_000 });

  // O outro participante: um Chromium com janela (para aparecer na lista).
  browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const web = await ctx.newPage();
  await web.goto(`${base}/#${sala}`, { waitUntil: "load" });
  await espera(1500);
  await web.fill("#nameInput", "Web");
  await web.click("#joinBtn");
  await web.waitForSelector("#dock:not([hidden])");
  await win.waitForFunction(() => [...window.vcall.mesh.peers.values()].some((p) => p.connectionState === "connected"), null, { timeout: 25_000 });
  check("o app de mesa conecta com um navegador", true);

  /* -- seletor de telas e janelas -- */
  await win.click('[aria-label="Compartilhar tela"]');
  await win.waitForSelector(".share__fontes", { timeout: 5000 });
  await espera(2500);
  const abas = await win.evaluate(() => [...document.querySelectorAll(".share__pilula[data-tipo]")].map((b) => b.dataset.tipo));
  await win.click('.share__pilula[data-tipo="window"]');
  await espera(300);
  const janelas = await win.evaluate(() => [...document.querySelectorAll(".share__fonte")].map((b) => b.getAttribute("aria-label")));
  await win.click('.share__pilula[data-tipo="screen"]');
  await espera(300);
  const telas = await win.evaluate(() => [...document.querySelectorAll(".share__fonte")].map((b) => b.getAttribute("aria-label")));
  check("o seletor tem as abas Janelas e Telas inteiras", abas.includes("window") && abas.includes("screen"));
  check("lista as telas", telas.length >= 1, telas.join(", "));
  check("lista as janelas abertas (e não a do próprio Vcall)", janelas.length >= 1 && !janelas.includes("Vcall"), janelas.join(", ") || "nenhuma");

  /* -- compartilhar uma janela -- */
  await win.click('.share__pilula[data-tipo="window"]');
  await espera(200);
  const temJanela = (await win.locator(".share__fonte").count()) > 0;
  if (temJanela) {
    await win.locator(".share__fonte").first().click();
    await win.click(".share__acoes .btn--primary");
    await espera(3500);
    const s = await win.evaluate(() => window.vcall.screen.videoTrack?.getSettings?.() || null);
    check("compartilha UMA janela (não a tela inteira)", s?.displaySurface === "window", s ? `${s.width}×${s.height} ${s.displaySurface}` : "sem captura");
    const chegou = await web
      .waitForFunction(() => [...document.querySelectorAll(".tile")].some((t) => t.dataset.kind === "screen"), null, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    check("a janela compartilhada aparece para o outro participante", chegou);

    // Trocar para a tela inteira SEM parar: quem assiste não perde o ladrilho.
    await web.evaluate(() => {
      window.__saiu = 0;
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.removedNodes) if (n.dataset?.kind === "screen") window.__saiu++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await win.click('.tile[data-tile="self:screen"] [aria-label="Trocar o que estou mostrando"]', { force: true });
    await win.waitForSelector(".share__fontes", { timeout: 5000 });
    await espera(1500);
    await win.click('.share__pilula[data-tipo="screen"]');
    await espera(200);
    await win.click(".share__acoes .btn--primary");
    await espera(3500);
    const depois = await win.evaluate(() => ({
      ativo: window.vcall.screen.active,
      tipo: window.vcall.screen.videoTrack?.getSettings?.().displaySurface,
    }));
    const saiu = await web.evaluate(() => window.__saiu);
    check("troca de janela para tela inteira sem parar a transmissão", depois.ativo && depois.tipo === "monitor" && saiu === 0, JSON.stringify({ ...depois, saiu }));
    await win.evaluate(() => window.vcall.screen.stop("user"));
    await espera(1500);
  } else {
    await win.click(".share__acoes .btn--ghost");
    check("compartilha UMA janela (não a tela inteira)", false, "nenhuma janela listada — rode com um gerenciador de janelas (openbox)");
  }

  /* -- compartilhar a tela inteira -- */
  await win.click('[aria-label="Compartilhar tela"]');
  await espera(2000);
  await win.click('.share__pilula[data-tipo="screen"]');
  await espera(200);
  await win.click(".share__acoes .btn--primary");
  await espera(3500);
  const ativa = await win.evaluate(() => window.vcall.screen.active);
  check("compartilhar a tela inteira funciona (antes travava no Linux)", ativa);
  const aviso = await win.evaluate(() => !!document.querySelector(".tile__present"));
  check("tela inteira: aviso no lugar da prévia (sem efeito espelho)", aviso);
  const conectado = await win.evaluate(() => [...window.vcall.mesh.peers.values()].every((p) => p.connectionState === "connected"));
  check("compartilhar não derruba a chamada", conectado);
  await win.evaluate(() => window.vcall.screen.stop("user"));

  /* -- legendas com Whisper: microfone de verdade (um .wav com fala) -- */
  // O modelo "rápido" (base). No CI ele é baixado do Hugging Face como seria
  // para qualquer pessoa; sem rede, VCALL_WHISPER_LOCAL aponta uma cópia.
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  if (process.env.VCALL_WHISPER_LOCAL) {
    const destino = path.join(userData, "fala", "whisper", "Xenova", "whisper-base");
    mkdirSync(destino, { recursive: true });
    cpSync(process.env.VCALL_WHISPER_LOCAL, destino, { recursive: true });
  }
  await win.evaluate(() => {
    localStorage.setItem("vcall:captions:nivel", JSON.stringify("rapida"));
    window.vcall.captions.nivel = "rapida";
  });
  const isolada = await win.evaluate(() => self.crossOriginIsolated);
  check("app isolado (COOP/COEP): o Whisper pode usar vários núcleos", isolada === true);

  // FlexFEC (desktop/webrtc.js): o app oferece correção de perda no vídeo.
  const flexfec = await win.evaluate(async () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver("video");
    const o = await pc.createOffer();
    pc.close();
    return /flexfec-03\/90000/.test(o.sdp);
  });
  check("o app de mesa oferece FlexFEC no vídeo (perda sem esperar retransmissão)", flexfec === true);
  if (!(await win.evaluate(() => window.vcall.media.micEnabled))) await win.keyboard.press("m");
  await win.click('[aria-label="Legendar minha fala"]');
  const inicio = Date.now();
  let fala = null;
  // O .wav toca em laço e a legenda liga num ponto qualquer dele: a primeira
  // frase pode ser só o fim da gravação. Vale a primeira frase inteira.
  let todas = [];
  while (Date.now() - inicio < 150_000 && !fala) {
    await espera(1000);
    todas = await win.evaluate(() => window.vcall.captions.transcript.map((t) => t.text));
    fala = todas.find((t) => /dia|todos|reuni|come/i.test(t)) || null;
  }
  const avisos = await win.evaluate(() => [...document.querySelectorAll(".toast span")].map((x) => x.textContent).join(" | "));
  check(
    "legenda no app: o Whisper reconhece a fala do microfone (sem sair do computador)",
    !!fala,
    fala ? `"${fala}" em ${Math.round((Date.now() - inicio) / 1000)} s (${todas.length} frase(s))` : `${JSON.stringify(todas)} ${avisos.slice(0, 120)}`,
  );
  const naTela = await win.evaluate(() => !!document.querySelector(".caption .caption__text")?.textContent);
  const naAba = await win.evaluate(() => window.vcall.captions.transcript.length);
  check("a legenda aparece na tela e entra na transcrição", naTela || naAba > 0, `${naAba} fala(s)`);
  const chegou = fala
    ? await web
        .waitForFunction((t) => window.vcall.captions.transcript.some((x) => x.text === t), fala, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  check("o outro participante recebe a legenda como texto", chegou);
  await win.click('[aria-label="Parar de legendar minha fala"]').catch(() => {});

  /* -- visualizador de imagem: o X não pode ficar sob os botões da janela -- */
  const geo = await win.evaluate(async () => {
    const png = await new Promise((r) => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      c.toBlob(r, "image/png");
    });
    const { abrirVisualizador } = await import("/js/ui/lightbox.js");
    abrirVisualizador({ url: URL.createObjectURL(png), blob: png, name: "foto.png", mime: "image/png" });
    await new Promise((r) => setTimeout(r, 400));
    const x = document.querySelector('.lightbox [aria-label="Fechar"]').getBoundingClientRect();
    const area = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    const alto = area?.height || 40;
    const drag = getComputedStyle(document.querySelector(".lightbox__barra")).getPropertyValue("-webkit-app-region");
    return { top: x.top, right: x.right, alto, limite: area ? area.x + area.width : innerWidth, drag };
  });
  check(
    "visualizador: o X fica abaixo dos botões da janela e fora da faixa de arrastar",
    geo.top >= geo.alto && geo.right <= geo.limite && geo.drag.trim() !== "drag",
    JSON.stringify(geo),
  );
  await win.click('.lightbox [aria-label="Fechar"]');
  await espera(300);
  check("visualizador: o X fecha", !(await win.evaluate(() => !!document.querySelector(".lightbox"))));

  /* -- modo jogo: sobreposição transparente com quem está na chamada -- */
  // Começa desligado (a preferência sobrevive entre execuções do teste).
  await win.evaluate(() => window.vcall.setModoJogo(false, { avisar: false }));
  await espera(500);
  const antes = app.windows().length;
  await win.evaluate(() => localStorage.setItem("vcall:modo-jogo:canto", JSON.stringify("tr")));
  await win.evaluate(() => window.vcall.setModoJogo(true, { avisar: false }));
  const atalhos = await win.evaluate(() => window.vcallDesktop.modoJogo(true, "tr"));
  let sobre = null;
  for (let i = 0; i < 20 && !sobre; i++) {
    await espera(250);
    sobre = app.windows().find((w) => w.url().endsWith("/sobreposicao.html")) || null;
  }
  check("modo jogo abre a sobreposição por cima dos jogos", !!sobre, `${antes} → ${app.windows().length} janelas`);
  check("modo jogo registra os atalhos globais (ou avisa que não deu)", atalhos && typeof atalhos.mic === "boolean", JSON.stringify(atalhos));
  if (sobre) {
    const nomes = await sobre
      .waitForFunction(() => document.querySelectorAll(".p").length >= 2, null, { timeout: 5000 })
      .then(() => sobre.evaluate(() => [...document.querySelectorAll(".p .nome")].map((n) => n.textContent)))
      .catch(() => []);
    check("a sobreposição lista quem está na chamada", nomes.length >= 2, nomes.join(", "));
    const canto = await sobre.evaluate(() => document.body.dataset.canto);
    check("a sobreposição fica no canto escolhido", canto === "tr", canto);
  }
  await win.evaluate(() => window.vcall.setModoJogo?.(false, { avisar: false }));
  await espera(600);
  check("desligar o modo jogo fecha a sobreposição", !app.windows().some((w) => w.url().endsWith("/sobreposicao.html")));

  /* -- link pela rede Tailscale -- */
  if (tsOk) {
    await win.click("#inviteBtn");
    const apareceu = await win
      .waitForSelector("#hostTailscale:not([hidden]) #tsBtn", { timeout: 8000 })
      .then(() => true, () => false);
    check("o Convidar oferece o link pelo Tailscale quando ele está instalado", apareceu);
    await win.click("#tsBtn");
    const pediuHttps = await win
      .waitForSelector("#tsHabilitar:not([hidden])", { timeout: 8000 })
      .then(() => true, () => false);
    check("rede sem HTTPS: mostra o botão para ligar e espera", pediuHttps);
    const link = await win
      .waitForFunction(() => document.querySelector("#tsLink").value || null, null, { timeout: 20_000 })
      .then((h) => h.jsonValue(), () => "");
    check(
      "o link sai sozinho depois de ligado, na 8443 (a 443 estava ocupada)",
      /^https:\/\/maquina\.tail1234\.ts\.net:8443\/#/.test(link),
      link || "sem link",
    );
    const convite = await win.evaluate(() => document.querySelector("#appLink").value);
    check("sem túnel, o convite do WhatsApp usa o link do Tailscale", convite.includes("maquina.tail1234.ts.net"), convite);
    await win.keyboard.press("Escape");

    // Alguém da tailnet entra pelo link (o nome resolve para cá, como o MagicDNS faria).
    const doTs = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--host-resolver-rules=MAP maquina.tail1234.ts.net 127.0.0.1",
        "--no-proxy-server",
      ],
    });
    try {
      const pg = await (await doTs.newContext({ permissions: ["camera", "microphone"], ignoreHTTPSErrors: true })).newPage();
      await pg.goto(link, { waitUntil: "load" });
      await pg.fill("#nameInput", "Tailnet");
      await pg.click("#joinBtn");
      await pg.waitForSelector("#dock:not([hidden])", { timeout: 15_000 });
      const entrou = await win
        .waitForFunction(() => [...window.vcall.mesh.peers.values()].filter((p) => p.connectionState === "connected").length >= 2, null, { timeout: 25_000 })
        .then(() => true, () => false);
      check("quem entra pelo link do Tailscale chega na chamada (sinalização pelo serve)", entrou);
      const painel = await pg.evaluate(async () => (await fetch("/__host/hello")).status);
      check("pelo link do Tailscale, o painel do anfitrião não existe", painel === 404, `HTTP ${painel}`);
    } finally {
      await doTs.close().catch(() => {});
    }
    // A rede: a varredura acha o outro computador com Vcall e ignora o celular.
    const rede = await win.evaluate(async () => {
      // Até ~40 s: o outro computador pode ter sido visto "sem Vcall" na
      // abertura do app (antes do link existir), e fica 30 s de fora.
      for (let i = 0; i < 80; i++) {
        const r = await (await fetch("/api/rede")).json();
        if (r.computadores?.length > 1) return r;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      return (await fetch("/api/rede")).json();
    });
    const nomes = (rede.computadores || []).map((c) => `${c.curto}${c.eu ? "*" : ""}`);
    check("a rede acha os computadores com Vcall (e ignora o celular sem Vcall)", nomes.join() === "maquina*,outra-maquina", nomes.join());
    const outro = (rede.computadores || []).find((c) => c.curto === "outra-maquina");
    check("o outro computador vem com o endereço certo", outro?.url === "https://outra-maquina.tail1234.ts.net:8443", outro?.url || "");

    // Configurações › Rede Tailscale: a opção fica guardada.
    await win.click('[aria-label="Configurações"]').catch(() => win.keyboard.press("Control+,"));
    // Rede e servidor de apoio ficam no "Avançado", fechado por padrão.
    await win.locator("#settingsModal details.avancado > summary").click({ timeout: 8000 }).catch(() => {});
    const caixa = win.locator("#settingsModal label", { hasText: "Deixar este computador disponível" }).locator("input[type=checkbox]");
    const temOpcao = await caixa.waitFor({ timeout: 8000 }).then(() => true, () => false);
    check("as configurações têm 'Deixar este computador disponível na rede Tailscale'", temOpcao);
    if (temOpcao) {
      await caixa.check();
      await espera(800);
      const guardada = await win.evaluate(async () => {
        const t = sessionStorage.getItem("vcall:host-token");
        return (await (await fetch(`/__host/rede/config?t=${t}`)).json()).sempre;
      });
      check("ligar a opção fica guardado (o link sobe sozinho ao abrir o app)", guardada === true);
      await caixa.uncheck();
      await espera(500);
    }

    // Configurações › Servidor TURN: salvar pela tela vale no /ice, e o segredo não volta.
    const blocoTurn = win.locator("#settingsModal [data-turn]");
    const temTurn = await blocoTurn.waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("as configurações têm 'Servidor TURN'", temTurn);
    if (temTurn) {
      await blocoTurn.locator("select").selectOption("segredo");
      await blocoTurn.locator('input[aria-label="Endereços do servidor"]').fill("turn:turn.exemplo.com:3478, turns:turn.exemplo.com:5349?transport=tcp");
      await blocoTurn.locator('input[aria-label="Segredo"]').fill("segredo-do-desktop-test");
      await blocoTurn.locator("button", { hasText: "Salvar" }).click();
      await espera(800);
      const r = await win.evaluate(async () => {
        const t = sessionStorage.getItem("vcall:host-token");
        const visao = await (await fetch(`/__host/turn/config?t=${t}`)).json();
        const ice = await (await fetch("/ice", { cache: "no-store" })).json();
        return { visao, ice };
      });
      const turnNoIce = r.ice.iceServers.find((s) => [].concat(s.urls).some((u) => String(u).startsWith("turns:turn.exemplo.com")));
      check("salvar o TURN pela tela vale no /ice (credencial temporária)", r.ice.hasTurn && !!turnNoIce?.credential, r.ice.turnMode);
      check("o segredo do TURN não volta para a página", !JSON.stringify(r.visao).includes("segredo-do-desktop-test") && r.visao.temSegredo === true);
      await blocoTurn.locator("select").selectOption("nenhum");
      await blocoTurn.locator("button", { hasText: "Salvar" }).click();
      await espera(600);
      const desligado = await win.evaluate(async () => (await (await fetch("/ice", { cache: "no-store" })).json()).hasTurn);
      check("desligar o TURN pela tela tira ele do /ice", desligado === false);
    }
    await win.keyboard.press("Escape");
    const invalido = await win.evaluate(async () => {
      const t = sessionStorage.getItem("vcall:host-token");
      return (await fetch(`/__host/abrir?t=${t}&u=${encodeURIComponent("http://exemplo.com/")}`)).status;
    });
    check("entrar em outro computador só aceita endereço de sala de verdade", invalido === 400, `HTTP ${invalido}`);

    await win.click("#inviteBtn");
    await win.click("#tsFechar");
    const fechou = await win.waitForFunction(() => !document.querySelector("#tsLink").value, null, { timeout: 5000 }).then(() => true, () => false);
    await espera(500);
    const aindaAberta = await new Promise((r) => {
      const sk = net.connect(8443, "127.0.0.1");
      sk.on("connect", () => (sk.destroy(), r(true)));
      sk.on("error", () => r(false));
    });
    check("desligar o link do Tailscale para de publicar (o serve morre junto)", fechou && !aindaAberta, aindaAberta ? "a 8443 continua aberta" : "");
    await win.keyboard.press("Escape");
  } else {
    console.log("  (sem openssl: pulando o link pelo Tailscale)");
  }

  check("nenhum erro de JavaScript no app", erros.length === 0, erros.slice(0, 2).join(" | "));
} catch (err) {
  check("execução sem exceção", false, err?.message || String(err));
} finally {
  await browser?.close().catch(() => {});
  await app.close().catch(() => {});
}

/*
 * Sessão Wayland com XWayland, como no Fedora/Ubuntu GNOME, abrindo como o
 * AppImage abre: um processo pai que espera o app e desmonta a pasta quando
 * ele sai. Antes o app saía para se reabrir com --ozone-platform=x11, a pasta
 * sumia e a cópia nova não subia. Agora o mesmo processo (mesmo PID) vira o
 * novo, com a opção, e abre a janela.
 */
if (process.platform === "linux" && process.env.DISPLAY) {
  console.log("\nLinux: sessão Wayland, aberto como AppImage");
  const perfil = mkdtempSync(path.join(os.tmpdir(), "vcall-wayland-"));
  const binario = path.join(root, "node_modules", "electron", "dist", "electron");
  const env = { ...process.env, XDG_SESSION_TYPE: "wayland", XDG_CONFIG_HOME: perfil, APPIMAGE: "/tmp/Vcall-teste.AppImage", APPDIR: root };
  delete env.WAYLAND_DISPLAY;
  const filho = spawn(binario, ["--no-sandbox", "desktop/main.js"], { cwd: root, env, stdio: "ignore" });
  let saiu = false;
  filho.on("exit", () => (saiu = true));
  await espera(9000);
  let linha = "";
  try {
    linha = readFileSync(`/proc/${filho.pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    /* já saiu */
  }
  let tipos = "";
  try {
    tipos = execFileSync("ps", ["-eo", "args"]).toString().split("\n").filter((l) => l.startsWith(binario)).join("\n");
  } catch {
    /* sem ps */
  }
  check("o processo não sai para se reabrir (a pasta do AppImage continua montada)", !saiu);
  check("o mesmo processo segue pelo XWayland (--ozone-platform=x11)", linha.includes("--ozone-platform=x11"), linha.slice(0, 120));
  check("e abre a janela (renderizador no ar)", tipos.includes("--type=renderer"));
  filho.kill();
}

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações do app de mesa passaram.`);
process.exit(falhas ? 1 : 0);
