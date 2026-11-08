#!/usr/bin/env node
/**
 * scripts/ui-test.mjs — as correções da 3.1 em navegadores de verdade.
 *
 * Sobe o servidor, abre participantes no Chromium com câmera, microfone e
 * tela falsos, e confere na interface — clicando como uma pessoa — cada
 * problema que foi relatado e corrigido. Complementa o e2e.mjs (conexão e
 * mídia) e o fixes-test.mjs (servidor, sem navegador).
 *
 *   node scripts/ui-test.mjs
 *   CHROMIUM_PATH=/caminho/do/chrome node scripts/ui-test.mjs
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), "vcall-ui-"));

const resultados = [];
const check = (nome, ok, detalhe = "") => {
  resultados.push({ nome, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const novaSala = (n) => `ui-${n}-${randomBytes(9).toString("base64url")}`;

const server = spawn("node", ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "error" },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[servidor] ${d}`));
await espera(900);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const errosJs = [];

async function participante(nome, sala, { antes = null, viewport = { width: 1280, height: 820 } } = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport });
  if (antes) await ctx.addInitScript(antes);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errosJs.push(`[${nome}] ${e.message}`));
  await page.goto(`${BASE}/#${sala}`, { waitUntil: "networkidle" });
  await page.fill("#nameInput", nome);
  await page.click("#joinBtn");
  return page;
}
const noDock = (p) => p.waitForSelector("#dock:not([hidden])", { timeout: 15_000 });
/** Abre um jogo pelo menu de jogos (K, e o cartão do jogo). */
const irPara = async (p, jogo) => {
  if (await p.evaluate(() => !document.querySelector(".jogos"))) await p.keyboard.press("k");
  await p.waitForSelector(".jogos");
  if (await p.evaluate(() => !!document.querySelector(".jogos__voltar:not([hidden])"))) await p.click(".jogos__voltar");
  await p.click(`.hub__jogo[data-id="${jogo}"]`);
};
const sim = (promessa) => promessa.then(
  () => true,
  () => false,
);
const conectados = (p, n) =>
  p.waitForFunction(
    (n) => [...window.vcall.mesh.peers.values()].filter((x) => x.connectionState === "connected").length === n,
    n,
    { timeout: 25_000 },
  );

try {
  /* ================================================================ *
   * 1. Perfil, pessoas e diálogos
   * ================================================================ */
  console.log("\nPerfil, lista de pessoas e diálogos");
  {
    const sala = novaSala("perfil");
    const a = await participante("Alice", sala);
    await noDock(a);
    const b = await participante("Bruno", sala);
    await noDock(b);
    await conectados(a, 1);

    await a.click('[aria-label="Pessoas"]');
    await espera(300);
    const linhas = await a.locator(".person").count();
    check("a aba Pessoas mostra todo mundo ao abrir (antes abria vazia)", linhas === 2, `${linhas} pessoas`);

    await a.locator(".person__main").first().click();
    await espera(400);
    const aberto = await a.evaluate(() => document.querySelector("#settingsModal").open);
    check("clicar no próprio nome abre o perfil", aberto);

    await a.click(".profileEdit__avatar");
    await espera(300);
    const aindaAberto = await a.evaluate(() => document.querySelector("#settingsModal").open);
    const grade = await a.locator(".profileEdit__grid .avatarPicker__option").count();
    check("clicar no avatar abre a grade e o perfil NÃO some", aindaAberto && grade >= 5, `${grade} opções`);

    await a.locator(".profileEdit__grid .avatarPicker__option").nth(3).click();
    const avatarA = await a.evaluate(() => window.vcall.mesh.self.avatar);
    await b.waitForFunction(
      (esperado) => [...window.vcall.mesh.profiles.values()].some((p) => p.avatar?.style === esperado.style && p.avatar?.seed === esperado.seed),
      avatarA,
      { timeout: 5000 },
    );
    check("a troca de avatar chega aos outros na hora", true, avatarA.style);

    const foco = await a.evaluate(() => document.activeElement?.getAttribute("role"));
    check("o foco continua no avatar escolhido depois da troca", foco === "radio", foco || "sem foco");
    await a.keyboard.press("p"); // atalho de Pessoas: com o diálogo aberto, não pode agir
    await espera(150);
    const painelAberto = await a.evaluate(() => !document.querySelector(".panel").hidden);
    check("com o diálogo aberto, as teclas não vazam para a chamada", painelAberto);
    await a.evaluate(() => {
      window.__k = [];
      const d = document.querySelector("#settingsModal");
      d.addEventListener("cancel", (e) => window.__k.push(`cancel prevented=${e.defaultPrevented}`));
      document.addEventListener("keydown", (e) => window.__k.push(`key ${e.key} ${e.target.tagName} prevented=${e.defaultPrevented}`), true);
    });
    await a.keyboard.press("Escape");
    const fechou = await a
      .waitForFunction(() => !document.querySelector("#settingsModal").open, null, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (!fechou) console.log("    eventos:", await a.evaluate(() => JSON.stringify(window.__k)));
    check("Esc fecha o diálogo (antes o atalho engolia a tecla)", fechou);

    await a.context().close();
    await b.context().close();
  }

  /* ================================================================ *
   * 2. Canvas, transmissão e avisos
   * ================================================================ */
  console.log("\nCanvas, transmissão de tela e avisos");
  {
    const sala = novaSala("tela");
    const contaAvisos = () => {
      window.__avisos = [];
      const ligar = () =>
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("toast")) window.__avisos.push(n.textContent);
        }).observe(document.body, { childList: true, subtree: true });
      if (document.body) ligar();
      else document.addEventListener("DOMContentLoaded", ligar);
    };
    const a = await participante("Alice", sala, { antes: contaAvisos });
    await noDock(a);
    const b = await participante("Bruno", sala, { antes: contaAvisos });
    await noDock(b);
    await conectados(a, 1);
    await conectados(b, 1);
    await espera(1500);

    // Bruno desenha 30 traços com o canvas da Alice fechado.
    await b.click('[aria-label="Quadro branco"]');
    await b.locator(".popover .dock__item, .popover button").first().click();
    await espera(500);
    const cv = await b.locator("#spotlight canvas").first().boundingBox();
    for (let i = 0; i < 30; i++) {
      await b.mouse.move(cv.x + 100 + i * 8, cv.y + 120);
      await b.mouse.down();
      await b.mouse.move(cv.x + 140 + i * 8, cv.y + 200, { steps: 4 });
      await b.mouse.up();
    }
    await espera(1200);
    const desenhando = await a.evaluate(() => window.__avisos.filter((t) => /desenhando no canvas/.test(t)).length);
    check("'Fulano está desenhando' aparece UMA vez, não a cada traço", desenhando === 1, `${desenhando} aviso(s) para 30 traços`);
    await b.keyboard.press("Escape");

    const somFalso = await a.evaluate(() => window.__avisos.filter((t) => /som da tela/.test(t)).length);
    check("sem aviso falso de 'compartilhando o som da tela'", somFalso === 0);

    // Duas transmissões seguidas na mesma chamada.
    const tela = async (n) => {
      await a.evaluate(() => window.vcall.screen.start({ withAudio: false }));
      const ok = await b
        .waitForFunction(() => [...document.querySelectorAll(".tile")].some((t) => t.dataset.kind === "screen"), null, { timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      await a.evaluate(() => window.vcall.screen.stop("user"));
      await b
        .waitForFunction(() => ![...document.querySelectorAll(".tile")].some((t) => t.dataset.kind === "screen"), null, { timeout: 8000 })
        .catch(() => {});
      return ok;
    };
    const primeira = await tela(1);
    const segunda = await tela(2);
    check("a tela aparece do outro lado na 1ª transmissão", primeira);
    check("e também na 2ª (antes o ladrilho não nascia mais)", segunda);

    const conectadoAinda = await a.evaluate(() => [...window.vcall.mesh.peers.values()].every((p) => p.connectionState === "connected"));
    check("transmitir não derruba a chamada", conectadoAinda);

    await a.context().close();
    await b.context().close();
  }

  /* ================================================================ *
   * 3. Arquivos na conversa
   * ================================================================ */
  console.log("\nArquivos na conversa");
  {
    const sala = novaSala("arq");
    const capturar = () => {
      const orig = URL.createObjectURL.bind(URL);
      window.__blobs = [];
      URL.createObjectURL = (b) => {
        window.__blobs.push(b);
        return orig(b);
      };
    };
    const a = await participante("Alice", sala);
    await noDock(a);
    const b = await participante("Bruno", sala, { antes: capturar });
    await noDock(b);
    await conectados(a, 1);
    await espera(1000);
    await a.click('[aria-label="Conversa"]');

    for (const tamanho of [300_000, 3_000_000, 12_000_000]) {
      const nome = `anexo-${tamanho}.bin`;
      const dados = randomBytes(tamanho);
      const arquivo = path.join(tmp, nome);
      writeFileSync(arquivo, dados);
      const hash = createHash("sha256").update(dados).digest("hex");
      await a.setInputFiles(".composer input[type=file]", arquivo);
      const chegou = await b
        .waitForFunction((t) => window.__blobs.some((x) => x.size === t), tamanho, { timeout: 90_000 })
        .then(() => true)
        .catch(() => false);
      let igual = false;
      if (chegou) {
        const h = await b.evaluate(async (t) => {
          const blob = window.__blobs.find((x) => x.size === t);
          const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
        }, tamanho);
        igual = h === hash;
      }
      check(`arquivo de ${(tamanho / 1e6).toFixed(1)} MB chega inteiro e idêntico`, chegou && igual, chegou ? (igual ? "sha256 igual" : "conteúdo diferente") : "não chegou");
    }
    // Um .html malicioso: aparece como texto, nunca é interpretado.
    const html = path.join(tmp, "armadilha.html");
    writeFileSync(html, '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>ola');
    await a.setInputFiles(".composer input[type=file]", html);
    await b.waitForFunction(() => document.querySelector('[data-file][title*="armadilha"]'), null, { timeout: 15_000 });
    await b.click('[aria-label="Conversa"]').catch(() => {});
    await espera(400);
    await b.locator('[data-file][title*="armadilha"]').click();
    await b.waitForSelector(".lightbox__texto", { timeout: 5000 });
    await b.waitForFunction(() => !/carregando/.test(document.querySelector(".lightbox__texto").textContent), null, { timeout: 5000 });
    const texto = await b.evaluate(() => document.querySelector(".lightbox__texto").textContent);
    const xss = await b.evaluate(() => window.__xss === 1);
    check("arquivo de texto recebido abre no visualizador (antes: 'não consegui ler')", texto.includes("ola"), texto.slice(0, 40));
    check("um .html recebido aparece como texto e NÃO executa script", !xss);

    await a.context().close();
    await b.context().close();
  }

  /* ================================================================ *
   * 4. Moderação e sala de espera
   * ================================================================ */
  console.log("\nModeração e sala de espera");
  {
    const sala = novaSala("mod");
    const a = await participante("Alice", sala);
    await noDock(a);
    const b = await participante("Bruno", sala);
    await noDock(b);
    await conectados(a, 1);

    await a.click('[aria-label="Pessoas"]');
    await espera(300);
    const temFaixa = await a.locator(".people__host").count();
    const bSemFaixa = await b.evaluate(() => (document.querySelector('[aria-label="Pessoas"]').click(), 0));
    await espera(300);
    const faixaNoBruno = await b.locator(".people__host").count();
    check("só o anfitrião vê os controles de moderação", temFaixa === 1 && faixaNoBruno === 0 && bSemFaixa === 0);

    await a.click('.person__acao[aria-label^="Silenciar"]');
    await espera(900);
    check("anfitrião silencia o microfone de outra pessoa", !(await b.evaluate(() => window.vcall.media.micEnabled)));

    await a.click(".people__acao >> text=Trancar sala");
    await espera(400);
    const c = await participante("Carla", sala);
    await c.waitForSelector(".waitRoom", { timeout: 8000 });
    await a.waitForSelector(".knock", { timeout: 8000 });
    check("sala trancada: quem chega espera e o anfitrião recebe o pedido", true);
    await a.click(".knock .btn--primary");
    await noDock(c);
    await c.waitForFunction(() => !document.querySelector(".waitRoom") && window.vcall.mesh.peers.size === 2, null, { timeout: 15_000 });
    check("'Deixar entrar' coloca a pessoa na chamada", true);

    await a.click('.person__acao[aria-label^="Remover"] >> nth=0');
    await a.click("dialog[open] .btn--danger");
    const removida = await Promise.race([
      b.waitForSelector(".leave__title", { timeout: 8000 }).then(() => "Bruno"),
      c.waitForSelector(".leave__title", { timeout: 8000 }).then(() => "Carla"),
    ]).catch(() => null);
    check("remover tira a pessoa da chamada com aviso claro", !!removida, removida || "");

    await a.context().close();
    await b.context().close();
    await c.context().close();
  }

  /* ================================================================ *
   * 5. Balão da chamada a dois
   * ================================================================ */
  console.log("\nTransições");
  {
    const sala = novaSala("duo");
    const a = await participante("Alice", sala);
    await noDock(a);
    const b = await participante("Bruno", sala);
    await noDock(b);
    await conectados(a, 1);
    await espera(800);
    const duo = await a.evaluate(() => document.querySelector("#stage").classList.contains("stage--duo") && !!document.querySelector(".floatSelf .tile"));
    check("chamada a dois: o próprio vídeo vira um balão flutuante", duo);
    // Espera o ladrilho terminar de deslizar para dentro do balão: durante a
    // animação ele ainda está visualmente em outro lugar.
    await a.waitForFunction(() => document.getAnimations().every((x) => x.playState !== "running" || x.effect?.getTiming?.().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
    await espera(300);
    const f = await a.locator(".floatSelf").boundingBox();
    await a.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
    await a.mouse.down();
    for (let i = 1; i <= 10; i++) await a.mouse.move(f.x + f.width / 2 - i * 80, f.y + f.height / 2 - i * 45, { steps: 2 });
    await a.mouse.up();
    await espera(900);
    const canto = await a.evaluate(() => document.querySelector(".floatSelf").dataset.corner);
    check("arrastar o balão leva ele ao canto mais próximo", canto === "tl", canto);
    await b.context().close();
    await a.waitForFunction(() => !document.querySelector("#stage").classList.contains("stage--duo"), null, { timeout: 10_000 });
    check("quando a outra pessoa sai, o balão volta para o palco", true);
    await a.context().close();
  }

  /* ================================================================ *
   * 5b. Foco na voz e volume por pessoa
   * ================================================================ */
  console.log("\nFoco na voz");
  {
    const sala = novaSala("foco");
    const a = await participante("Alice", sala);
    await noDock(a);
    const b = await participante("Bruno", sala);
    await noDock(b);
    const c = await participante("Carla", sala);
    await noDock(c);
    await conectados(a, 2);
    for (const p of [a, b, c]) await p.keyboard.press("m");
    await espera(1500);
    await a.keyboard.press("g");
    await espera(500);
    const [id1, id2] = await a.evaluate(() => [...window.vcall.mesh.peers.keys()]);
    await a.evaluate((id) => window.vcall.stage.get(id, "cam").setSpeaking(true), id1);
    // Passar o mouse acende o quadro de propósito: o mouse sai de cima de
    // todos (ele fica onde foi o último clique, o "Entrar na sala").
    await a.mouse.move(2, 2);
    await espera(500);
    const op = await a.evaluate(
      ([x, y]) => ({
        foco: document.querySelector("#stage").classList.contains("stage--foco"),
        fala: +getComputedStyle(document.querySelector(`.tile[data-tile="${x}:cam"]`)).opacity,
        quieto: +getComputedStyle(document.querySelector(`.tile[data-tile="${y}:cam"]`)).opacity,
        eu: +getComputedStyle(document.querySelector('.tile[data-tile="self:cam"]')).opacity,
      }),
      [id1, id2],
    );
    check("G liga o foco na voz: quem fala acende, quem está quieto fica apagado", op.foco && op.fala > 0.95 && op.quieto < 0.6, JSON.stringify(op));
    check("o próprio ladrilho não fica 'falando' com o microfone mudo", op.eu < 0.6);
    const lembra = await a.evaluate(() => JSON.parse(localStorage.getItem("vcall:foco-voz")));
    check("a preferência do foco fica guardada", lembra === true);

    const vol = await a.evaluate((id) => {
      const t = window.vcall.stage.get(id, "cam");
      const ler = () => {
        const v = document.querySelector(`.tile[data-tile="${id}:cam"] .vol`);
        return { acesas: v.style.getPropertyValue("--acesas") || getComputedStyle(v).getPropertyValue("--acesas"), boost: v.classList.contains("is-boost"), pct: v.querySelector(".vol__pct").textContent };
      };
      t.setVolume(1.5);
      const alto = ler();
      t.setVolume(0);
      const mudo = ler();
      return { alto, mudo, barras: document.querySelectorAll(`.tile[data-tile="${id}:cam"] .vol__rampa i`).length };
    }, id2);
    check("volume: rampa de barras própria acende conforme o nível", vol.barras === 10 && +vol.alto.acesas === 10 && vol.alto.boost && vol.alto.pct === "150%", JSON.stringify(vol));
    check("volume: no zero a rampa apaga e mostra 'mudo'", +vol.mudo.acesas === 0 && vol.mudo.pct === "mudo");
    await a.keyboard.press("g");
    await espera(300);
    check("G de novo desliga o foco", !(await a.evaluate(() => document.querySelector("#stage").classList.contains("stage--foco"))));
    for (const p of [a, b, c]) await p.context().close();
  }

  /* ================================================================ *
   * 5c. Tela parada, troca de fonte e economia de banda
   * ================================================================ */
  console.log("\nQualidade da câmera");
  {
    // A causa da "chamada ruim": o encoder escolhia a resolução com a
    // estimativa de banda do começo (~300 kbps) e ficava nela a chamada
    // inteira — 480×270 a 640×360 com banda de sobra. O monitor destrava.
    const sala = novaSala("qualidade");
    const a = await participante("Ana", sala);
    await noDock(a);
    const b = await participante("Bia", sala);
    await noDock(b);
    await conectados(a, 1);
    for (const p of [a, b]) await p.evaluate(async () => { if (!window.vcall.media.camEnabled) await window.vcall.media.setCam(true); });
    const ler = () =>
      a.evaluate(async () => {
        const peer = [...window.vcall.mesh.peers.values()][0];
        let o = null;
        (await peer.getStats()).forEach((x) => {
          if (x.type === "outbound-rtp" && x.kind === "video" && x.mid === "1") o = { w: x.frameWidth, fps: x.framesPerSecond, lim: x.qualityLimitationReason };
        });
        return o;
      });
    let r = null;
    for (let i = 0; i < 15 && !(r?.w >= 1152); i++) {
      await espera(2000);
      r = await ler();
    }
    check("câmera chega a 720p com banda sobrando (antes ficava presa em 360p)", r?.w >= 1152, JSON.stringify(r));
    await a.context().close();
    await b.context().close();
  }

  console.log("\nJogos de equipe (pelo menu de jogos)");
  {
    const sala = novaSala("jogos");
    const a = await participante("Ana", sala);
    await noDock(a);
    const b = await participante("Bia", sala);
    await noDock(b);
    await conectados(a, 1);
    await espera(800);
    await a.keyboard.press("k");
    await a.waitForSelector(".hub");
    const noMenu = await a.evaluate(() => ({ jogos: document.querySelectorAll(".hub__jogo").length, prateleiras: [...document.querySelectorAll(".hub__prateleira h3")].map((h) => h.textContent) }));
    check("K abre o menu de jogos, com as prateleiras", noMenu.jogos >= 16 && noMenu.prateleiras.includes("Festa") && noMenu.prateleiras.includes("Equipe ágil"), `${noMenu.jogos} jogos · ${noMenu.prateleiras.join(", ")}`);
    await a.click('.hub__jogo[data-id="poker"]');
    await a.waitForSelector(".poker");
    const aviso = await b
      .waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("abriu o Planning Poker")), null, { timeout: 5000 })
      .then(() => true, () => false);
    check("quem abre o Planning Poker avisa os outros, com botão de participar", aviso);
    await b.click(".toast >> text=Participar");
    await b.waitForSelector(".jogos");

    await a.fill(".poker__nova", "Login com Google\nTela de perfil");
    await a.press(".poker__nova", "Enter");
    await b.waitForFunction(() => document.querySelectorAll(".poker__item").length === 2, null, { timeout: 5000 });
    await a.click('.carta--mao[aria-label="Carta 5"]');
    await b.click('.carta--mao[aria-label="Carta 8"]');
    await a.waitForFunction(() => [...document.querySelectorAll(".assento")].every((x) => x.getAttribute("aria-label").endsWith(": votou")), null, { timeout: 5000 });
    const vazou = await a.evaluate(() => JSON.stringify(window.vcall.jogosEstado.instantaneo()).includes('"8"'));
    check("antes de revelar todos veem quem votou, e o voto da outra pessoa não chegou", !vazou);
    await b.click(".poker__revelar");
    await a.waitForSelector(".poker__resumo", { timeout: 8000 });
    const cartas = await a.evaluate(() => [...document.querySelectorAll(".assento")].map((x) => x.getAttribute("aria-label")).sort());
    const resumo = await b.evaluate(() => document.querySelector(".poker__resumo")?.textContent || "");
    check("revelar mostra as cartas e o resumo nos dois", cartas.join() === "Ana: 5,Bia: 8" && resumo.includes("6,5"), `${cartas} · ${resumo}`);
    await a.click(".poker__salvar .jogos__chip >> text=8");
    await b.waitForFunction(() => document.querySelector(".poker__item .poker__estimativa")?.textContent === "8", null, { timeout: 5000 });
    check("salvar a estimativa grava na história e passa para a próxima", await b.evaluate(() => document.querySelector(".poker__item.is-atual")?.textContent.includes("Tela de perfil")));

    // Retrospectiva: o texto dos outros fica escondido até a votação.
    await irPara(a, "retro");
    await irPara(b, "retro");
    await b.fill('.coluna[data-col="1"] textarea', "Reuniões longas demais");
    await b.press('.coluna[data-col="1"] textarea', "Enter");
    await a.waitForFunction(() => document.querySelectorAll(".nota").length === 1, null, { timeout: 5000 });
    const escondida = await a.evaluate(() => document.querySelector(".nota__texto").classList.contains("is-oculta") && !document.body.textContent.includes("Reuniões longas"));
    await a.click(".retro__fase >> text=Votar");
    await a.waitForFunction(() => document.body.textContent.includes("Reuniões longas demais"), null, { timeout: 5000 }).catch(() => {});
    const aparece = await a.evaluate(() => document.querySelector(".nota__texto")?.textContent === "Reuniões longas demais");
    check("Retro: nota escondida enquanto se escreve, visível na votação", escondida && aparece);

    // Quem entra depois recebe o estado inteiro.
    const c = await participante("Caio", sala);
    await noDock(c);
    await conectados(c, 2);
    const recebeu = await c
      .waitForFunction(() => window.vcall.jogosEstado.ler("r/fase") === "votar" && [...window.vcall.jogosEstado.com("p/h/")].length === 2, null, { timeout: 8000 })
      .then(() => true, () => false);
    check("quem entra depois recebe o jogo em andamento", recebeu);

    // Daily: a mesma ordem para todo mundo.
    await irPara(a, "daily");
    await a.click(".daily__vazio >> text=Sortear ordem");
    await irPara(c, "daily");
    const ordem = (p) => p.evaluate(() => [...document.querySelectorAll(".daily__item")].map((x) => x.textContent.replace(/\d+:\d+$/, "")).join("|"));
    await c.waitForFunction(() => document.querySelectorAll(".daily__item").length === 3, null, { timeout: 5000 });
    check("Daily: ordem sorteada igual para todos", (await ordem(a)) === (await ordem(c)), await ordem(c));
    for (const p of [a, b, c]) await p.context().close();

    // Celular, sozinho na sala: o painel tem largura (antes ficava com 0 px).
    const m = await participante("Duda", novaSala("jogos-cel"), { viewport: { width: 390, height: 820 } });
    await noDock(m);
    await m.keyboard.press("k");
    await m.waitForSelector(".jogos .hub");
    const largura = await m.evaluate(() => document.querySelector(".jogos").getBoundingClientRect().width);
    check("no celular, sozinho, os jogos ocupam a tela (antes 0 px)", largura > 300, `${Math.round(largura)} px`);
    await m.context().close();
  }

  console.log("\nJogos de festa e de tabuleiro");
  {
    const sala = novaSala("festa");
    const a = await participante("Ana", sala);
    await noDock(a);
    const b = await participante("Bia", sala);
    await noDock(b);
    const c = await participante("Caio", sala);
    await noDock(c);
    await conectados(a, 2);
    await conectados(c, 2);
    await espera(800);
    const todos = [a, b, c];
    const ids = await Promise.all(todos.map((p) => p.evaluate(() => window.vcall.mesh.selfId)));

    // Desenha e Adivinha
    for (const p of todos) await irPara(p, "desenho");
    await a.click(".jg-abertura__acoes .btn--primary");
    await a.waitForFunction(() => window.vcall.jogos.desenho.r?.fase === "escolhendo", null, { timeout: 5000 });
    const dz = todos[ids.indexOf(await a.evaluate(() => window.vcall.jogos.desenho.r.de))];
    const adivinham = todos.filter((p) => p !== dz);
    await dz.waitForSelector(".desenho__escolha input");
    await dz.fill(".desenho__escolha input", "guarda-chuva");
    await dz.press(".desenho__escolha input", "Enter");
    await adivinham[0].waitForFunction(() => window.vcall.jogos.desenho.fase() === "jogando", null, { timeout: 5000 });
    const vazou = await adivinham[0].evaluate(() => JSON.stringify(window.vcall.jogosEstado.instantaneo()).toLowerCase().includes("chuva"));
    check("Desenho: a palavra não sai do computador de quem desenha", !vazou);
    const tela = await dz.locator(".desenho__tela").boundingBox();
    await dz.mouse.move(tela.x + 60, tela.y + 60);
    await dz.mouse.down();
    await dz.mouse.move(tela.x + 260, tela.y + 180, { steps: 10 });
    await dz.mouse.up();
    const traco = await sim(adivinham[1].waitForFunction(() => window.vcall.jogos.desenho.tracos.size === 1 && [...window.vcall.jogos.desenho.tracos.values()][0].p.length >= 8, null, { timeout: 5000 }));
    check("Desenho: o traço chega aos outros pelo canal direto", traco);
    await adivinham[0].fill(".desenho__palpite", "guarda chuvo");
    await adivinham[0].press(".desenho__palpite", "Enter");
    const quase = await sim(adivinham[0].waitForSelector(".desenho__conversa .is-quase", { timeout: 4000 }));
    check("Desenho: quem chega perto vê 'está quase'", quase);
    await adivinham[0].fill(".desenho__palpite", "Guarda Chuva");
    await adivinham[0].press(".desenho__palpite", "Enter");
    const acerto = await sim(adivinham[1].waitForSelector(".desenho__conversa .is-acertou", { timeout: 4000 }));
    const semPalavra = !(await adivinham[1].evaluate(() => document.querySelector(".desenho__conversa").textContent.toLowerCase().includes("chuva")));
    check("Desenho: o acerto aparece para todos, sem revelar a palavra", acerto && semPalavra);
    const d = await participante("Duda", sala);
    await noDock(d);
    await conectados(d, 3);
    const recebeu = await sim(d.waitForFunction(() => window.vcall.jogos.desenho.tracos.size === 1, null, { timeout: 8000 }));
    check("Desenho: quem entra no meio recebe o desenho até ali", recebeu);
    await d.context().close();
    await espera(500);

    // Stop
    for (const p of todos) await irPara(p, "stop");
    await b.click(".jg-abertura__acoes .btn--primary");
    await a.waitForSelector(".stop__grade input");
    const letra = await a.evaluate(() => window.vcall.jogos.stop.r.letra);
    const campos = a.locator(".stop__grade input");
    const n = await campos.count();
    for (let i = 0; i < n; i += 1) await campos.nth(i).fill(`${letra}abc${i}`);
    await b.waitForSelector(".stop__grade input");
    await b.locator(".stop__grade input").first().fill(`${letra}abc0`);
    await c.waitForSelector(".stop__grade input");
    await c.locator(".stop__grade input").nth(1).fill(`${letra}xyz`);
    const antes = await c.evaluate(() => [...window.vcall.jogosEstado.com("st/a/")].length);
    check("Stop: ninguém vê as respostas dos outros antes do STOP", antes === 0);
    await a.click(".stop__botao");
    const tabela = await sim(c.waitForFunction(() => document.querySelectorAll(".stop__tabela tbody tr").length === 3, null, { timeout: 6000 }));
    check("Stop: o STOP para todo mundo e as respostas aparecem", tabela);
    for (const p of [b, c]) await p.locator(".stop__tabela button.stop__celula").filter({ hasText: `${letra}abc1` }).first().click();
    const anulada = await sim(a.waitForFunction((t) => [...document.querySelectorAll(".stop__tabela td.is-invalida")].some((td) => td.textContent.includes(t)), `${letra}abc1`, { timeout: 5000 }));
    check("Stop: a maioria anula uma resposta inventada", anulada);

    // Roda de perguntas: votos escondidos até todo mundo votar
    for (const p of todos) await irPara(p, "roda");
    await a.click(".jg-abertura__acoes .btn--primary");
    for (const p of todos) await p.waitForSelector(".roda__lado");
    await a.click(".roda__lado--a");
    await b.click(".roda__lado--b");
    await espera(400);
    const escondido = await c.evaluate(() => [...window.vcall.jogosEstado.com("rp/val/")].length === 0);
    await c.click(".roda__lado--a");
    const revelou = await sim(a.waitForSelector(".roda__pct", { timeout: 6000 }));
    check("Roda: votos escondidos até todos votarem, e revela sozinha", escondido && revelou);

    // Quiz
    for (const p of todos) await irPara(p, "quiz");
    await a.click(".jg-abertura__acoes .btn--primary");
    for (const p of todos) await p.waitForSelector(".quiz__opcao", { timeout: 9000 });
    const certa = await a.evaluate(() => window.vcall.jogos.quiz.pergunta().certa);
    await a.locator(".quiz__opcao").nth(certa).click();
    await b.locator(".quiz__opcao").nth((certa + 1) % 4).click();
    await c.locator(".quiz__opcao").nth(certa).click();
    const certaVisivel = await sim(b.waitForSelector(".quiz__opcao.is-certa", { timeout: 5000 }));
    const placarQuiz = await b.evaluate(() => [...document.querySelectorAll(".quiz__lado .jg-placar__item")].map((x) => x.textContent.replace(/\s+/g, " ")));
    check("Quiz: todos responderam, a certa aparece e o placar soma", certaVisivel && placarQuiz.length === 3, placarQuiz.join(" | "));

    // Velha contra o computador
    await irPara(a, "velha");
    await a.click('button:has-text("Jogar contra o computador")');
    await a.locator(".velha__casa").nth(4).click();
    const respondeu = await sim(a.waitForFunction(() => [...window.vcall.jogos.velha.partida().t].filter((x) => x !== " ").length === 2, null, { timeout: 4000 }));
    check("Velha: o computador responde a jogada", respondeu);

    // Roleta: o mesmo resultado para todo mundo
    for (const p of todos) await irPara(p, "sorteios");
    await b.click('button:has-text("Girar")');
    await espera(5200);
    const sorteados = await Promise.all(todos.map((p) => p.evaluate(() => document.querySelector(".roleta__vencedor strong")?.textContent || "")));
    check("Roleta: o mesmo sorteado na tela de todos", !!sorteados[0] && sorteados.every((x) => x === sorteados[0]), sorteados.join(", "));
    for (const p of todos) await p.context().close();
  }

  console.log("\nReações e sinais");
  {
    const sala = novaSala("reacoes");
    const a = await participante("Ana", sala);
    await noDock(a);
    const b = await participante("Bia", sala);
    await noDock(b);
    const c = await participante("Caio", sala);
    await noDock(c);
    await conectados(a, 2);
    await conectados(c, 2);
    await espera(1000);

    // Combo: cinco cliques rápidos viram ×5 nos dois lados, em poucas mensagens.
    await b.evaluate(() => {
      window.__combos = [];
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains("reacaoCombo") && window.__combos.push(n.textContent)))).observe(document.body, { subtree: true, childList: true });
    });
    await a.keyboard.press("r");
    await a.waitForSelector(".popover--reactions .reagirBotao");
    const botoes = await a.locator(".reagirBotao").count();
    check("o menu de reagir tem a grade de reações e os sinais", botoes >= 18 && (await a.locator(".reagirSinal").count()) >= 7, `${botoes} reações`);
    for (let i = 0; i < 5; i += 1) await a.click('.reagirBotao[aria-label="Amei"]');
    await b.waitForFunction(() => window.__combos.includes("×5"), null, { timeout: 4000 }).catch(() => {});
    const combos = await b.evaluate(() => window.__combos);
    check("cinco cliques chegam como ×5 do outro lado (antes ×2)", combos.includes("×5"), combos.join(" "));
    const selo = await b.evaluate(() => !!document.querySelector(".tile .tile__reacao.is-on"));
    check("a reação marca o quadrinho de quem reagiu", selo);

    // Chuva: a mesma reação de três pessoas.
    await espera(1600);
    for (const p of [a, b, c]) {
      await p.keyboard.press("Escape");
      await p.keyboard.press("r");
      await p.click('.reagirBotao[aria-label="Festa"]');
    }
    await espera(700);
    const noAr = await a.evaluate(() => document.querySelectorAll(".reacaoVoo").length);
    check("três pessoas com a mesma reação fazem chover na chamada", noAr >= 15, `${noAr} no ar`);

    // Teclado: com o menu aberto, 1 a 9 reagem direto.
    await espera(2500);
    await c.keyboard.press("2");
    const doTeclado = await a
      .waitForFunction(() => document.querySelectorAll(".reacaoVoo").length > 0, null, { timeout: 3000 })
      .then(() => true, () => false);
    check("com o menu aberto, um número reage direto", doTeclado);

    // Sinais: votação rápida com placar e etiquetas no quadrinho.
    const sinal = async (p, nome) => {
      await p.keyboard.press("Escape");
      await p.keyboard.press("r");
      await p.click(`.reagirSinal:has-text("${nome}")`);
      await p.keyboard.press("Escape");
    };
    await sinal(a, "Sim");
    await sinal(b, "Sim");
    await sinal(c, "Não");
    await c.waitForFunction(() => document.querySelectorAll(".placarItem").length === 2, null, { timeout: 4000 }).catch(() => {});
    const placar = await c.evaluate(() => [...document.querySelectorAll(".placarItem")].map((x) => x.getAttribute("aria-label")));
    check("Sim e Não viram um placar para todos", placar.some((x) => x.startsWith("Sim: 2")) && placar.some((x) => x.startsWith("Não: 1")), placar.join(" · "));
    const etiquetas = await c.evaluate(() => document.querySelectorAll(".tile__sinais .sinal").length);
    check("os sinais ficam como etiqueta no quadrinho", etiquetas === 3, `${etiquetas} etiquetas`);
    await sinal(b, "Já volto");
    await sinal(c, "Não estou ouvindo");
    const ausente = await a
      .waitForFunction(() => document.querySelectorAll(".tile.is-ausente").length === 1, null, { timeout: 4000 })
      .then(() => true, () => false);
    check("\"Já volto\" esmaece o quadrinho", ausente);
    const aviso = await a
      .waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Caio não está ouvindo")), null, { timeout: 4000 })
      .then(() => true, () => false);
    check("\"Não estou ouvindo\" avisa a chamada", aviso);

    // Quem chega depois vê os sinais de quem já estava.
    const d = await participante("Duda", sala);
    await noDock(d);
    await conectados(d, 3);
    const viu = await d
      .waitForFunction(() => document.querySelectorAll(".tile__sinais .sinal").length >= 4, null, { timeout: 8000 })
      .then(() => true, () => false);
    check("quem entra depois recebe os sinais que já estavam ligados", viu);
    for (const p of [a, b, c, d]) await p.context().close();
  }

  console.log("\nRede Tailscale no painel");
  {
    // A lista da rede vem do app de mesa; aqui ela é simulada na rota.
    const ID_ANA = "planningdaana-0123456789";
    const rede = {
      disponivel: true,
      tailnet: "time",
      computadores: [
        { eu: true, curto: "este", url: null, salas: [] },
        {
          eu: false,
          curto: "notebook-ana",
          url: "https://notebook-ana.tail1.ts.net:8443",
          salas: [{ id: ID_ANA, code: "ABC123", name: "Planning da Ana", visibility: "rede", size: 3, max: 16, host: { name: "Ana", avatar: null } }],
        },
        { eu: false, curto: "pc-sala", url: "https://pc-sala.tail1.ts.net", salas: [], pessoa: { nome: "Bia", avatar: { style: "thumbs", seed: "bia" } } },
      ],
    };
    const abrirPainel = async (viewport) => {
      const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport });
      const pg = await ctx.newPage();
      pg.on("pageerror", (e) => errosJs.push(`[painel] ${e.message}`));
      await pg.route("**/api/rede", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(rede) }));
      return pg;
    };
    const pg = await abrirPainel({ width: 1280, height: 820 });
    await pg.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await pg.waitForSelector(".dashPc", { timeout: 15_000 });
    const linha = await pg.locator(".dashRoom", { hasText: "Planning da Ana" }).textContent();
    const pcs = await pg.locator(".dashPc__nome").allTextContents();
    check("as chamadas dos outros computadores da rede aparecem em Ao vivo agora", linha.includes("em notebook-ana") && linha.includes("só na rede"), linha.replace(/\s+/g, " ").slice(0, 80));
    check("os computadores da rede aparecem com Criar aqui", pcs.join() === "notebook-ana,Bia", pcs.join());
    const bia = await pg.locator(".dashPc", { hasText: "Bia" }).evaluate((n) => ({ avatar: !!n.querySelector(".dashPc__quem .avatar svg"), maquina: n.querySelector(".dashPc__n").textContent }));
    check("com quem está no computador: avatar, nome e a máquina embaixo", bia.avatar && bia.maquina === "pc-sala · livre", JSON.stringify(bia));

    // Entrar numa chamada de outro computador: vai até ele (no navegador, navegando).
    let foiPara = "";
    await pg.route("https://notebook-ana.tail1.ts.net:8443/**", (r) => ((foiPara = r.request().url()), r.fulfill({ body: "ok" })));
    await pg.locator(".dashRoom", { hasText: "Planning da Ana" }).locator("button", { hasText: "Entrar" }).click();
    await pg.waitForURL(/notebook-ana/, { timeout: 5000 }).catch(() => {});
    check("Entrar leva até o computador da chamada", pg.url() === `https://notebook-ana.tail1.ts.net:8443/#${ID_ANA}`, pg.url());

    // Criar: o ingresso da tela inicial. Com rede, "Na minha rede" existe e vem marcada.
    await pg.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await pg.waitForSelector(".dashPc");
    await pg.waitForSelector('.dash__privacy [data-valor="rede"]');
    const opcoes = await pg.locator(".dash__privacy .privacy").evaluateAll((bs) => bs.map((b) => `${b.querySelector("strong").textContent}:${b.getAttribute("aria-checked")}`));
    check("na rede, criar oferece 'Na minha rede', já marcada", opcoes.includes("Na minha rede:true"), opcoes.join(" · "));
    await pg.fill(".bilhete__principal input[type=text]", "Do time");
    await pg.click(".bilhete__chamar");
    // A antessala entra com uma transição e, ao montar, preenche o nome com o
    // guardado: um nome digitado antes disso se perde. Escreve de novo até o
    // botão acender.
    await pg.waitForSelector("#lobby:not([hidden]) #joinBtn", { timeout: 10_000 });
    for (let i = 0; i < 20; i++) {
      await pg.fill("#nameInput", "Bia");
      if (await pg.evaluate(() => !document.querySelector("#joinBtn").disabled)) break;
      await espera(250);
    }
    await pg.click("#joinBtn");
    await noDock(pg);
    const outra = await (await browser.newContext()).newPage();
    await outra.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const vistas = await outra.evaluate(async () => {
      const ver = async (h) => (await (await fetch("/api/rooms", { headers: h })).json()).rooms.map((r) => r.name);
      return { daRede: await ver({}), peloTunel: await ver({ "cf-connecting-ip": "203.0.113.9" }) };
    });
    check(
      "sala 'Na minha rede' aparece para a rede e some para quem vem pelo link público",
      vistas.daRede.includes("Do time") && !vistas.peloTunel.includes("Do time"),
      JSON.stringify(vistas),
    );
    await outra.context().close();
    await pg.context().close();

    // "Criar aqui" de outro computador chega como ?criar=1#sala: abre o criar com esse id.
    const ID_NOVA = "criadapelarede-0123456789";
    const c = await abrirPainel({ width: 390, height: 820 });
    await c.goto(`${BASE}/?criar=1#${ID_NOVA}`, { waitUntil: "networkidle" });
    const pronto = await c.waitForSelector(".bilhete.is-pedido", { timeout: 8000 }).then(() => true, () => false);
    check("?criar=1 deixa o ingresso pronto para criar (em vez da antessala de convidado)", pronto);
    await c.fill(".bilhete__principal input[type=text]", "Do celular");
    await c.click(".bilhete__chamar");
    await c.waitForSelector("#lobby:not([hidden]) #joinBtn", { timeout: 10_000 });
    check("a chamada criada usa o id que veio do outro computador", (await c.evaluate(() => location.hash)) === `#${ID_NOVA}`);
    await c.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await c.waitForSelector(".dashPc");
    const vaza = await c.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check("no celular, o painel com a rede cabe na tela (sem rolar para o lado)", !vaza);
    await c.screenshot({ path: path.join(tmp, "painel-rede-celular.png") });
    await c.context().close();
  }

  console.log("\nTransmissão estável");
  {
    const sala = novaSala("estavel");
    // Captura "estilo Linux": um quadro quando começa e nada mais enquanto a
    // tela não muda. Era isso que fazia a tela "cair e voltar" do outro lado.
    const telaParada = () => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement("canvas");
        c.width = window.__largura || 1280;
        c.height = 720;
        const g = c.getContext("2d");
        g.fillStyle = window.__cor || "#3355ff";
        g.fillRect(0, 0, c.width, c.height);
        const s = c.captureStream(0);
        const t = s.getVideoTracks()[0];
        setTimeout(() => t.requestFrame(), 300);
        return s;
      };
    };
    const contar = () => {
      window.__tela = { entrou: 0, saiu: 0 };
      // Conta ladrilhos novos e os que saem da página. Mudar de lugar (convite
      // na grade -> destaque depois de Assistir) não é sumir e voltar.
      const vistos = new WeakSet();
      const ligar = () =>
        new MutationObserver((ms) => {
          for (const m of ms) {
            for (const n of m.addedNodes) if (n.dataset?.kind === "screen" && !vistos.has(n)) vistos.add(n), window.__tela.entrou++;
            for (const n of m.removedNodes) if (n.dataset?.kind === "screen" && !n.isConnected) window.__tela.saiu++;
          }
        }).observe(document.body, { childList: true, subtree: true });
      if (document.body) ligar();
      else document.addEventListener("DOMContentLoaded", ligar);
    };
    const a = await participante("Linux", sala, { antes: telaParada });
    await noDock(a);
    const b = await participante("Eu", sala, { antes: contar });
    await noDock(b);
    await conectados(b, 1);
    await a.evaluate(() => window.vcall.screen.start({ withAudio: false }));
    // Como no Discord: o Eu vê o convite, sem imagem, e o Linux não manda a tela até ele clicar.
    await b.waitForSelector(".tile__assistir", { timeout: 12_000 });
    await espera(1500);
    const semAssistir = await b.evaluate(() => !!document.querySelector('.tile[data-kind="screen"] video')?.srcObject);
    const envioAntes = await a.evaluate(() => [...window.vcall.mesh.peers.values()][0].tx.screen.sender.getParameters().encodings[0].active);
    check("a tela de outra pessoa chega como convite: 'Assistir', sem imagem e sem envio (como no Discord)", !semAssistir && envioAntes === false, `imagem ${semAssistir}, envio ${envioAntes}`);
    await b.click(".tile__assistir");
    // Olha a imagem a cada meio segundo, não só no fim: a trilha recebida de
    // uma tela parada fica "muda" entre um quadro repetido e outro, e o
    // ladrilho trocava a imagem pelo avatar e voltava. Uma amostra só pegava
    // isso por sorte.
    let viu = false;
    let sumiu = 0;
    for (let i = 0; i < 24; i++) {
      await espera(500);
      const w = await b.evaluate(() => document.querySelector('.tile[data-kind="screen"] video')?.videoWidth || 0);
      if (w === 1280) viu = true;
      else if (viu) sumiu += 1;
    }
    const r = await b.evaluate(() => {
      const v = document.querySelector('.tile[data-kind="screen"] video');
      return { ...window.__tela, largura: v?.videoWidth || 0 };
    });
    check("tela parada por 12 s continua no ar (antes sumia e voltava)", r.entrou === 1 && r.saiu === 0, JSON.stringify(r));
    check("a imagem da tela parada chega e não pisca (o <video> segura o último quadro)", viu && sumiu === 0 && r.largura === 1280, `${r.largura}px, sumiu ${sumiu}× em 12 s`);

    await a.evaluate(() => {
      window.__largura = 960;
      window.__cor = "#ff5533";
      return window.vcall.screen.switchSource({ withAudio: false });
    });
    const trocou = await b
      .waitForFunction(() => document.querySelector('.tile[data-kind="screen"] video')?.videoWidth === 960, null, { timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    const r2 = await b.evaluate(() => window.__tela);
    check("trocar o que é mostrado não interrompe a transmissão", trocou && r2.saiu === 0 && (await a.evaluate(() => window.vcall.screen.active)), JSON.stringify(r2));

    // Economia: a janela do Eu fica escondida — o Linux para de mandar câmera.
    await b.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const pausou = await a
      .waitForFunction(() => [...window.vcall.mesh.peers.values()].every((p) => p.camPausada), null, { timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    const parametro = await a.evaluate(() => [...window.vcall.mesh.peers.values()][0].tx.cam.sender.getParameters().encodings[0].active);
    check("janela escondida: os outros param de mandar câmera (economia de banda)", pausou && parametro === false);
    await b.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const voltou = await a
      .waitForFunction(() => [...window.vcall.mesh.peers.values()].every((p) => !p.camPausada), null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("voltou a olhar: a câmera volta na hora", voltou);

    // Parar de assistir: volta o convite e o Linux desliga o envio da tela para o Eu.
    await b.hover('.tile[data-kind="screen"]');
    await b.click('.tile[data-kind="screen"] [data-acao="eye-off"]');
    const parou = await sim(
      a.waitForFunction(() => [...window.vcall.mesh.peers.values()][0].tx.screen.sender.getParameters().encodings[0].active === false, null, { timeout: 8000 }),
    );
    const convite = await b.evaluate(() => !!document.querySelector('.tile[data-kind="screen"] .tile__assistir'));
    check("'Parar de assistir' volta ao convite e a tela deixa de ser enviada", parou && convite);

    // Celular: assiste e põe a tela em tela cheia (antes o botão nem aparecia no telefone).
    const c = await participante("Celular", sala, { viewport: { width: 390, height: 820 } });
    await noDock(c);
    await c.waitForSelector(".tile__assistir", { timeout: 15_000 });
    await c.click(".tile__assistir");
    const chegou = await sim(c.waitForFunction(() => document.querySelector('.tile[data-kind="screen"] video')?.videoWidth > 0, null, { timeout: 15_000 }));
    const botoes = await c.evaluate(() => {
      const visivel = (s) => {
        const b = document.querySelector(`.tile[data-kind="screen"] ${s}`);
        return !!b && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0;
      };
      return { cheia: visivel('[data-acao="maximize-2"]'), parar: visivel('[data-acao="eye-off"]'), fixar: visivel('[data-acao="pin"]') };
    });
    check("no celular, a tela assistida mostra tela cheia e parar de assistir (sem fixar)", chegou && botoes.cheia && botoes.parar && !botoes.fixar, JSON.stringify(botoes));
    await c.click('.tile[data-kind="screen"] [data-acao="maximize-2"]');
    const cheia = await sim(c.waitForFunction(() => document.fullscreenElement?.dataset.kind === "screen", null, { timeout: 5000 }));
    check("o botão põe a tela compartilhada em tela cheia no celular", cheia);
    await c.screenshot({ path: path.join(tmp, "tela-cheia-celular.png") });
    await c.context().close();
    await a.context().close();
    await b.context().close();
  }

  /* ================================================================ *
   * 5d. Readmitir quem foi removido
   * ================================================================ */
  console.log("\nReadmitir");
  {
    const sala = novaSala("readmitir");
    const a = await participante("Anfitriã", sala);
    await noDock(a);
    const ctxB = await browser.newContext({ permissions: ["camera", "microphone"] });
    const b = await ctxB.newPage();
    b.on("pageerror", (e) => errosJs.push(`[Bia] ${e.message}`));
    await b.goto(`${BASE}/#${sala}`, { waitUntil: "networkidle" });
    await b.fill("#nameInput", "Bia");
    await b.click("#joinBtn");
    await noDock(b);
    await conectados(a, 1);
    await a.click('[aria-label="Pessoas"]');
    await a.click('[aria-label="Remover da sala: Bia"]');
    await a.click(".modal .btn--danger");
    await b.waitForSelector(".leave", { timeout: 10_000 });
    const lista = await a
      .waitForSelector('.people__removidos [aria-label="Deixar Bia voltar"]', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("o anfitrião vê quem removeu, na lista de Pessoas", lista);
    // Antes de liberar, a volta é recusada.
    const tentar = async () => {
      await b.click(".leave .btn--primary");
      await b.waitForSelector("#joinBtn", { timeout: 10_000 });
      await espera(600);
      await b.click("#joinBtn");
    };
    await tentar();
    await b.waitForSelector(".leave", { timeout: 10_000 });
    const barrada = await b.evaluate(() => /removido/i.test(document.querySelector(".leave__title")?.textContent || ""));
    check("sem liberação, quem foi removido não volta", barrada);
    await a.click('[aria-label="Deixar Bia voltar"]');
    await espera(800);
    await tentar();
    const entrou = await b
      .waitForSelector("#dock:not([hidden])", { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check("'Deixar voltar' + 'Tentar entrar de novo': a pessoa volta para a sala", entrou);
    await a.context().close();
    await ctxB.close();
  }

  /* ================================================================ *
   * 6. Legendas (Web Speech simulado)
   * ================================================================ */
  console.log("\nLegendas da própria fala");
  {
    // Um reconhecedor falso, controlado pelo teste, no lugar do do Chrome.
    const falso = () => {
      class FakeSR {
        constructor() {
          window.__sr = this;
          window.__srStarts = (window.__srStarts || 0) + 1;
        }
        start() {
          this.rodando = true;
        }
        stop() {
          this.rodando = false;
          this.onend?.();
        }
      }
      window.SpeechRecognition = FakeSR;
      window.webkitSpeechRecognition = FakeSR;
      window.__falar = (partes) => {
        const results = partes.map(([t, fin]) => Object.assign([{ transcript: t }], { isFinal: fin }));
        window.__sr.onresult({ resultIndex: 0, results });
      };
    };
    const sala = novaSala("leg");
    const a = await participante("Alice", sala, { antes: falso });
    await noDock(a);
    check("idioma padrão das legendas é pt-BR", (await a.evaluate(() => window.vcall.captions.lang)) === "pt-BR");
    await a.click('[aria-label="Legendar minha fala"]');
    await espera(200);
    await a.evaluate(() => window.__falar([["bom dia", false], ["a todos", false]]));
    const parcial = await a.evaluate(() => document.querySelector(".caption__text")?.textContent);
    check("pedaços do palpite são juntados (antes a legenda piscava só o fim)", parcial === "bom dia a todos", parcial);
    await a.evaluate(() => window.__sr.onend());
    await espera(100);
    const transcrito = await a.evaluate(() => window.vcall.captions.transcript.map((t) => t.text));
    check("frase em andamento não se perde quando o reconhecedor reinicia", transcrito.includes("bom dia a todos"), JSON.stringify(transcrito));
    await a.evaluate(() => document.querySelector('[aria-label="Mais opções"]')?.click());
    await espera(300);
    await a.getByText("Transcrição ao vivo").click();
    await espera(400);
    const naAba = await a.evaluate(() => [...document.querySelectorAll(".transcricao__texto")].map((x) => x.textContent));
    check("a aba Transcrição mostra o que foi dito, ao vivo", naAba.some((t) => t.includes("bom dia a todos")), JSON.stringify(naAba));
    await a.fill(".transcricao__busca", "dia");
    await espera(200);
    const marcado = await a.evaluate(() => document.querySelector(".transcricao__texto mark")?.textContent);
    check("a busca na transcrição destaca o termo", marcado === "dia", marcado || "");
    await a.fill(".transcricao__busca", "");
    await espera(400);
    const inicios = await a.evaluate(() => window.__srStarts);
    await a.click('[aria-label="Microfone ligado"]');
    await espera(300);
    const pausado = await a.evaluate(() => window.__sr?.rodando === false || window.__srStarts === undefined);
    check("microfone mudo pausa a legenda (nada vaza no mudo)", pausado, `inícios: ${inicios}`);
    await a.context().close();
  }

  /* ================================================================ *
   * 7. Convite pelo WhatsApp
   * ================================================================ */
  console.log("\nConvite pelo WhatsApp");
  {
    const sala = novaSala("convite");
    const p = await browser.newPage();
    await p.goto(`${BASE}/abrir#${sala}`, { waitUntil: "domcontentloaded" });
    await espera(400);
    const hrefs = await p.evaluate(() => ({ app: document.querySelector("#abrirApp").href, nav: document.querySelector("#noNavegador").href }));
    check(
      "/abrir leva ao aplicativo (vcall://) e oferece o navegador",
      hrefs.app.startsWith("vcall://join?u=") && hrefs.nav.endsWith(`/#${sala}`),
    );
    const cel = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile" });
    const pc = await cel.newPage();
    let intent = "";
    pc.on("request", (r) => {
      if (r.url().startsWith("intent://")) intent = r.url();
    });
    await pc.goto(`${BASE}/abrir#${sala}`, { waitUntil: "domcontentloaded" });
    await pc.waitForURL(`**/#${sala}`, { timeout: 8000 }).catch(() => {});
    check(
      "no Android, o convite abre o aplicativo (intent:// com volta para o navegador)",
      intent.startsWith("intent://join?u=") && intent.includes(encodeURIComponent(`/#${sala}`)), // o resto (#Intent;package=…) não vai na requisição; está no fixes-test
      intent,
    );
    await pc.waitForURL(`**/#${sala}`, { timeout: 8000 }).catch(() => {});
    check("no Android sem o aplicativo, /abrir segue para a sala no navegador", pc.url().endsWith(`/#${sala}`));
    await cel.close();

    const a = await participante("Alice", sala);
    await noDock(a);
    await a.click("#inviteBtn");
    const convite = await a.inputValue("#appLink");
    check("o convite do WhatsApp é o link curto /c/CODIGO", /\/c\/[A-Z0-9]{6}$/.test(convite), convite);

    // O que o WhatsApp lê: a prévia da chamada, com imagem em endereço absoluto.
    const previa = await (await fetch(convite, { headers: { "User-Agent": "WhatsApp/2.23", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "rio-azul.trycloudflare.com" } })).text();
    const img = /og:image" content="([^"]+)"/.exec(previa)?.[1] || "";
    check(
      "o link curto traz a prévia do WhatsApp (título, descrição, imagem grande em https)",
      /og:title" content="[^"]+· Vcall"/.test(previa) && /Toque para entrar/.test(previa) && img === "https://rio-azul.trycloudflare.com/assets/convite.jpg" && previa.includes('summary_large_image'),
      img,
    );
    const imagem = await fetch(`${BASE}/assets/convite.jpg`);
    check("a imagem da prévia existe e é leve (o WhatsApp despreza imagem grande)", imagem.ok && Number(imagem.headers.get("content-length")) < 300_000, imagem.headers.get("content-length"));
    const viaCurto = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile" });
    const pcurto = await viaCurto.newPage();
    await pcurto.goto(convite);
    await pcurto.waitForURL(`**/#${sala}`, { timeout: 8000 }).catch(() => {});
    check("tocar no link curto leva para a chamada", pcurto.url().endsWith(`/#${sala}`), pcurto.url());
    await pcurto.goto(`${BASE}/c/ZZZZZZ`);
    const encerrado = await pcurto.textContent("#titulo");
    check("link curto de chamada que acabou diz que acabou", /encerrada/i.test(encerrado || ""), encerrado);
    await viaCurto.close();
    await p.close();
    await a.context().close();
  }

  check("nenhum erro de JavaScript nas páginas", errosJs.length === 0, errosJs.slice(0, 3).join(" | "));
} catch (err) {
  check("execução sem exceção", false, err?.message || String(err));
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
