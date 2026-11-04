#!/usr/bin/env node
/**
 * scripts/quizzv-e2e.mjs — o Quiz com o celular (QuizzV), de ponta a ponta.
 *
 * Duas pessoas na chamada (navegadores de verdade) e um "celular com o
 * QuizzV" (um cliente WebSocket que fala o mesmo protocolo do app). Prova o
 * caminho inteiro: QR no Quiz → o celular carrega um quiz da biblioteca → os
 * outros recebem o convite → o celular começa → resposta pelo celular e pelo
 * clique → revelação com a explicação → página /quizzv para quem não tem o
 * app → pódio.
 *
 * Chromium por padrão. Para os outros motores:
 *   QUIZ_BROWSERS=chromium,edge,firefox,webkit node scripts/quizzv-e2e.mjs
 * (Firefox e WebKit: `npx playwright install firefox webkit` uma vez.)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pw from "playwright";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3996;
const URL_BASE = `http://localhost:${PORT}`;
const MOTORES = String(process.env.QUIZ_BROWSERS || "chromium").split(",").map((s) => s.trim()).filter(Boolean);

let falhas = 0;
const check = (motor, nome, ok, detalhe = "") => {
  if (!ok) falhas += 1;
  console.log(`  ${ok ? "✓" : "✗"} [${motor}] ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const QUIZ = {
  titulo: "Capitais do Nordeste",
  perguntas: [
    { texto: "Capital do Piauí?", opcoes: ["Teresina", "Parnaíba", "Picos"], correta: 0, explicacao: "Teresina é a capital desde 1852." },
    { texto: "Qual NÃO é capital?", opcoes: ["Natal", "Recife", "Campina Grande", "Maceió", "Aracaju"], correta: 2 },
    { texto: "Salvador fica na Bahia.", opcoes: ["Verdadeiro", "Falso"], correta: 0 },
  ],
};

/** Um "celular" falando o protocolo do QuizzV. */
function celular(token) {
  const ws = new WebSocket(URL_BASE.replace(/^http/, "ws"));
  const vistas = [];
  const esperas = [];
  const msgs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    msgs.push(m);
    if (m.t === "quiz-vista") vistas.push(m.v);
    for (const e of [...esperas]) if (e.pred(m)) (esperas.splice(esperas.indexOf(e), 1), e.ok(m));
  });
  const c = {
    ws,
    vistas,
    pedir: (a) => ws.send(JSON.stringify({ t: "quiz-do-celular", a })),
    // Esquece o que já chegou: as próximas esperas só valem para mensagens novas.
    limpar: () => (msgs.length = 0),
    esperar: (pred, ms = 10_000) =>
      new Promise((ok, falha) => {
        const achada = msgs.find(pred);
        if (achada) return ok(achada);
        esperas.push({ pred, ok });
        setTimeout(() => falha(new Error("o celular não recebeu o que esperava")), ms);
      }),
    vista: (pred, ms) => c.esperar((m) => m.t === "quiz-vista" && pred(m.v), ms).then((m) => m.v),
  };
  ws.on("open", () => ws.send(JSON.stringify({ t: "quiz-ola", token, v: 1, app: "teste-e2e" })));
  return c;
}

function argsDe(motor) {
  // Edge é Chromium com outro canal — e é o navegador que já vem no Windows.
  if (motor === "edge") return { ...argsDe("chromium"), executablePath: undefined, channel: "msedge" };
  if (motor === "chromium") {
    return {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    };
  }
  if (motor === "firefox") {
    return { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 } };
  }
  return {};
}

async function rodar(motor) {
  console.log(`\nQuiz com o QuizzV em ${motor}…`);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[servidor] ${d}`));
  await wait(900);

  const browser = await pw[motor === "edge" ? "chromium" : motor].launch(argsDe(motor));
  /*
   * O WebKit do Playwright no Windows vem sem WebRTC (nem MediaStream
   * existe), então a CHAMADA não abre nele — no Safari de verdade abre. Aí a
   * chamada roda no Chromium e o WebKit faz o papel que mais importa para o
   * Safari aqui: o iPhone abrindo a página do QR para responder.
   */
  const semWebRtc = motor === "webkit";
  const browserChamada = semWebRtc ? await pw.chromium.launch(argsDe("chromium")) : browser;
  const erros = [];
  const ROOM = `quizzv-e2e-${motor}-${Math.random().toString(36).slice(2, 12)}`;

  async function entrar(nome) {
    const ctx = await browserChamada.newContext({
      viewport: { width: 1280, height: 860 },
      ...(motor === "firefox" ? {} : { permissions: ["camera", "microphone"] }),
    });
    // A janela de permissões da primeira visita não é o assunto deste teste.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("vcall:perms:v1", "true");
      } catch {
        /* sem armazenamento */
      }
    });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && erros.push(`[${nome}] ${m.text()}`));
    page.on("pageerror", (e) => erros.push(`[${nome}] pageerror: ${e.message}`));
    await page.goto(`${URL_BASE}/#${ROOM}`, { waitUntil: "load" });
    await page.fill("#nameInput", nome);
    await page.click("#joinBtn");
    await page.waitForSelector("#dock:not([hidden])", { timeout: 15_000 });
    await page.waitForFunction(() => !!window.vcall?.mesh.selfId, null, { timeout: 15_000 });
    return { ctx, page, nome };
  }

  /** Abre o QR pelo diálogo e devolve o link (em localhost, pela saída "mostrar mesmo assim"). */
  async function linkDoQr(page, abrir) {
    await abrir();
    await page.waitForSelector("#quizzvModal[open]", { timeout: 5000 });
    const aviso = page.locator("#quizzvBody button", { hasText: "Mostrar o código mesmo assim" });
    let avisou = false;
    if (await aviso.isVisible().catch(() => false)) {
      avisou = true;
      await aviso.click();
    }
    await page.waitForSelector("#quizzvModal[open] .quizzvQr path", { timeout: 8000 });
    const link = await page.inputValue("#quizzvBody input");
    const d = await page.getAttribute("#quizzvModal .quizzvQr path", "d");
    return { link, avisou, qr: (d || "").length > 200 };
  }

  try {
    const alice = await entrar("Alice");
    const bruno = await entrar("Bruno");
    await alice.page.waitForFunction(() => window.vcall.mesh.peers.size === 1, null, { timeout: 15_000 });

    /* -- Alice abre o Quiz e pareia o celular -------------------------- */
    await alice.page.keyboard.press("k");
    await alice.page.click('.hub__jogo[data-id="quiz"]');
    await alice.page.waitForSelector(".jg-abertura", { timeout: 5000 });
    const { link, avisou, qr } = await linkDoQr(alice.page, () => alice.page.getByRole("button", { name: "Usar um quiz do meu QuizzV" }).click());
    check(motor, "em localhost, o diálogo avisa que o celular não alcança o endereço", avisou);
    const u = new URL(link);
    check(motor, "o QR é desenhado aqui mesmo e aponta para /quizzv desta chamada", qr && u.origin === URL_BASE && u.pathname === "/quizzv");
    const cel = celular(u.hash.slice(1));
    const ola = await cel.esperar((m) => m.t === "quiz-conectado");
    check(motor, "o QuizzV pareia em nome de quem leu o QR", ola.voce.nome === "Alice");
    await alice.page.waitForSelector("#quizzvBody .quizzvPar__status.is-ok", { timeout: 5000 });
    check(motor, "o diálogo mostra o celular conectado", true);
    await alice.page.keyboard.press("Escape");
    await alice.page.waitForSelector(".quizzv__botao.is-ligado", { timeout: 5000 });
    check(motor, "o Quiz mostra o celular ligado no topo", true);
    const lobbyCel = await cel.vista((v) => v.fase === "lobby");
    check(motor, "o celular recebe a primeira vista (lobby)", !!lobbyCel);
    check(motor, "o celular não vira um participante de vídeo", (await bruno.page.evaluate(() => window.vcall.mesh.peers.size)) === 1);

    /* -- o celular carrega um quiz da biblioteca ----------------------- */
    cel.pedir({ tipo: "carregar", quiz: QUIZ, tempo: 30, qtd: 0 });
    await alice.page.waitForSelector(".jg-abertura__titulo:text('Capitais do Nordeste')", { timeout: 8000 });
    check(motor, "o quiz do celular aparece no lobby do Quiz", true);
    const lobbyQv = await cel.vista((v) => v.fase === "lobby" && v.quizzv);
    check(motor, "o celular sabe que o quiz chegou", lobbyQv.quizzv.titulo === QUIZ.titulo);
    // Bruno recebe o convite ("Alice abriu o Quiz") e participa.
    await bruno.page.getByRole("button", { name: "Participar" }).click({ timeout: 8000 });
    await bruno.page.waitForSelector(".jg-abertura__titulo:text('Capitais do Nordeste')", { timeout: 8000 });
    check(motor, "os outros recebem o convite e veem o mesmo quiz", true);

    /* -- começar pelo celular ----------------------------------------- */
    cel.pedir({ tipo: "comecar" });
    const pergunta = await cel.vista((v) => v.fase === "pergunta", 12_000);
    check(motor, "o celular começa a partida e recebe a pergunta", pergunta.pergunta.texto === "Capital do Piauí?");
    check(motor, "o celular não recebe o gabarito antes da hora", pergunta.pergunta.certa === undefined);
    await bruno.page.waitForSelector(".quiz__opcao", { timeout: 8000 });
    check(motor, "três alternativas, na ordem do QuizzV", (await bruno.page.locator(".quiz__opcao").allTextContents()).map((t) => t.replace(/^[A-E]/, "").trim()).join("|") === "Teresina|Parnaíba|Picos");

    cel.pedir({ tipo: "responder", k: 0, e: 0 });
    await alice.page.waitForSelector(".quiz__opcao.is-minha", { timeout: 5000 });
    check(motor, "responder no celular marca a resposta de Alice na tela dela", (await alice.page.locator(".quiz__opcao--vermelho.is-minha").count()) === 1);
    await bruno.page.click(".quiz__opcao--amarelo");
    await bruno.page.waitForSelector(".quiz__opcao.is-certa", { timeout: 6000 });
    check(motor, "todos responderam: revela na hora", true);
    const explicacao = await bruno.page.textContent(".quiz__explicacao");
    check(motor, "a explicação do QuizzV aparece na revelação", explicacao.includes("1852"));
    const revelada = await cel.vista((v) => v.fase === "revelada");
    check(motor, "o celular vê a certa, os pontos e o lugar", revelada.pergunta.certa === 0 && revelada.minha.certo && revelada.minha.pontos > 0 && revelada.eu.pos === 1);

    /* -- página /quizzv: Bruno responde pelo navegador do celular ------ */
    const { link: linkBruno } = await linkDoQr(bruno.page, () => bruno.page.click(".quizzv__botao"));
    await bruno.page.keyboard.press("Escape");
    const ctxCel = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: motor !== "firefox" });
    const pagCel = await ctxCel.newPage();
    pagCel.on("pageerror", (e) => erros.push(`[celular] pageerror: ${e.message}`));
    await pagCel.goto(linkBruno, { waitUntil: "load" });
    const href = await pagCel.getAttribute("#abrirApp", "href");
    check(motor, "a página do QR oferece abrir no QuizzV", href.startsWith("quizzv://vcall?u=") && href.includes(encodeURIComponent(URL_BASE)));
    await pagCel.click("#noNavegador");
    await pagCel.waitForSelector(".qvp__opcao", { timeout: 8000 });
    // A partida pode já ter seguido sozinha (6 s depois da revelação): vale qualquer pergunta dela.
    const naTela = (await pagCel.textContent(".qvp__pergunta")) || "";
    check(motor, "pelo navegador do celular, entra direto na partida", QUIZ.perguntas.some((q) => q.texto === naTela.trim()), naTela.slice(0, 40));

    cel.pedir({ tipo: "proxima" });
    await pagCel.waitForSelector(".qvp__opcao--4", { timeout: 12_000 });
    // A chamada recebe a pergunta pelo próprio canal, não junto com o celular: contar na hora falhava às vezes no WebKit.
    await bruno.page.waitForSelector(".quiz__opcao--roxo", { timeout: 6000 }).catch(() => {});
    check(motor, "pergunta com cinco alternativas (até a E)", (await bruno.page.locator(".quiz__opcao--roxo").count()) === 1);
    await pagCel.click(".qvp__opcao--2");
    await bruno.page.waitForSelector(".quiz__opcao--amarelo.is-minha", { timeout: 6000 });
    check(motor, "responder na página do celular marca a resposta de Bruno na chamada", true);
    await alice.page.click(".quiz__opcao--azul");
    await pagCel.waitForSelector(".qvp__status.is-certo", { timeout: 6000 });
    check(motor, "a página do celular mostra o acerto", true);

    /* -- até o pódio ---------------------------------------------------- */
    await pagCel.click("text=Próxima pergunta");
    await alice.page.waitForSelector(".quiz__pergunta:text('Salvador fica na Bahia.')", { timeout: 12_000 });
    await alice.page.waitForSelector(".quiz__opcao--azul:not(.is-certa):not(.is-errada)", { timeout: 6000 });
    check(motor, "verdadeiro ou falso: duas alternativas", (await alice.page.locator(".quiz__opcao").count()) === 2);
    cel.pedir({ tipo: "responder", k: 2, e: 1 });
    await bruno.page.click(".quiz__opcao--vermelho");
    await bruno.page.waitForSelector(".quiz__opcao.is-certa", { timeout: 6000 });
    cel.pedir({ tipo: "proxima" });
    const fim = await cel.vista((v) => v.fase === "fim", 12_000);
    await bruno.page.waitForSelector(".jg-podio, .podio, [class*='podio']", { timeout: 8000 });
    const titulo = await bruno.page.textContent("body");
    check(motor, "pódio com o nome do quiz", titulo.includes("Fim de “Capitais do Nordeste”!"));
    check(motor, "o celular recebe o placar final", fim.placar.length === 2 && fim.placar[0].nome === "Bruno");
    await pagCel.waitForSelector(".qvp__placar", { timeout: 6000 });

    /* -- o Quiz de sempre continua lá ---------------------------------- */
    await bruno.page.getByRole("button", { name: "Trocar tema" }).click();
    await bruno.page.getByRole("button", { name: "Usar as perguntas do Vcall" }).click();
    await alice.page.waitForSelector(".jg-abertura .jogos__select", { timeout: 6000 });
    check(motor, "dá para voltar às perguntas do Vcall", (await alice.page.getByRole("button", { name: /Usar “Capitais do Nordeste” \(QuizzV\)/ }).count()) === 1);

    /* -- com pausa: depois de revelar, o tempo para no placar ----------- */
    cel.limpar();
    cel.pedir({ tipo: "carregar", quiz: QUIZ, tempo: 30, qtd: 0, pausa: true });
    const lobbyPausa = await cel.vista((v) => v.fase === "lobby" && v.quizzv?.pausa);
    check(motor, "o celular sabe que este quiz tem pausa", !!lobbyPausa);
    cel.pedir({ tipo: "comecar" });
    await cel.vista((v) => v.fase === "pergunta" && v.k === 0, 12_000);
    cel.pedir({ tipo: "responder", k: 0, e: 0 });
    await bruno.page.waitForSelector(".quiz__opcao:not(.is-certa):not(.is-errada)", { timeout: 8000 });
    await bruno.page.click(".quiz__opcao--amarelo");
    await cel.vista((v) => v.fase === "revelada" && v.k === 0 && v.pausa);
    await alice.page.waitForSelector(".quiz__pausa", { timeout: 6000 });
    check(motor, "a tela avisa que o tempo está parado", (await alice.page.textContent(".quiz__pausa")).includes("Tempo parado"));
    await wait(8000); // sem pausa, a próxima viria sozinha em 6 s
    cel.limpar();
    const pedida = cel.vista(() => true);
    cel.pedir({ tipo: "vista" }); // pede a vista de agora
    const parada = await pedida;
    check(motor, "com pausa, a próxima não vem sozinha", parada.fase === "revelada" && parada.k === 0, `${parada.fase} ${parada.k}`);
    cel.pedir({ tipo: "proxima" });
    const seguinte = await cel.vista((v) => v.k === 1 && (v.fase === "preparar" || v.fase === "pergunta"), 8000);
    check(motor, "o toque em Próxima continua a partida", !!seguinte);
    cel.pedir({ tipo: "encerrar" });

    const relevantes = erros.filter((e) => !/favicon|service worker|sw\.js|getUserMedia|NotAllowedError|NotFoundError|Permission|ICE failed/i.test(e));
    check(motor, "nenhum erro de JavaScript", relevantes.length === 0, relevantes.slice(0, 3).join(" | "));
    cel.ws.close();
  } catch (err) {
    check(motor, "fluxo completo", false, err.message.split("\n").slice(0, 3).join(" "));
    for (const [i, c] of [...browser.contexts(), ...(semWebRtc ? browserChamada.contexts() : [])].entries()) {
      for (const pg of c.pages()) await pg.screenshot({ path: path.join(root, `.quizzv-falha-${motor}-${i}.png`) }).catch(() => {});
    }
    if (erros.length) console.log("    erros no console:", erros.slice(0, 5));
  } finally {
    await browser.close();
    if (semWebRtc) await browserChamada.close();
    server.kill();
    await wait(300);
  }
}

for (const motor of MOTORES) await rodar(motor);
console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : "\nQuiz com o QuizzV: tudo certo.");
process.exit(falhas ? 1 : 0);
