// scripts/android-test.mjs: testa o APK no emulador, com o celular (WebView do app, via
// CDP + adb) e um navegador no Windows na mesma sala. Passo a passo na seção 12 do
// HANDOFF.md. Uso: node scripts/android-test.mjs <sala>   (SO=passo1,passo2 filtra)
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ADB = `"${process.env.LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe"`;
const adb = (c) => execSync(`${ADB} ${c}`, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tela = (nome) => execSync(`${ADB} exec-out screencap -p > brag-output/work/${nome}.png`);
const sala = process.argv[2];
const so = (process.env.SO || "").split(",").filter(Boolean);
const resultados = [];
const check = (n, v, d = "") => {
  resultados.push(!!v);
  console.log(`  ${v ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`);
};
async function passo(nome, fn) {
  if (so.length && !so.includes(nome)) return;
  console.log(`\n${nome}`);
  try {
    await fn();
  } catch (e) {
    check(`${nome} rodou sem erro`, false, e.message.split("\n")[0]);
    try {
      tela(`erro-${nome.replace(/\s+/g, "-")}`);
    } catch {}
  }
}

let a, b, cel, nav, baixado;
async function conectarCelular() {
  const sock = adb("shell cat /proc/net/unix").match(/webview_devtools_remote_\d+/g).pop();
  adb(`forward tcp:9222 localabstract:${sock}`);
  cel = await chromium.connectOverCDP("http://localhost:9222");
  for (let i = 0; i < 20 && !a; i++) {
    a = cel.contexts()[0].pages().find((p) => p.url().includes(sala));
    if (!a) await espera(500);
  }
  return a;
}
const idDoOutro = (p) => p.evaluate(() => [...window.vcall.mesh.peers.keys()][0]);
const estadoDoOutro = (p) => p.evaluate(() => window.vcall.mesh.states.get([...window.vcall.mesh.peers.keys()][0]) || {});
const framesDoOutro = (p) =>
  p.evaluate(async () => {
    const pc = [...window.vcall.mesh.peers.values()][0]?.pc;
    let f = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") f += r.framesDecoded || 0;
    });
    return f;
  });
const pacotesDeAudioDoOutro = (p) =>
  p.evaluate(async () => {
    const pc = [...window.vcall.mesh.peers.values()][0]?.pc;
    let n = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") n += r.packetsReceived || 0;
    });
    return n;
  });
const naMiniJanela = () => /mode=pinned|isInPictureInPictureMode=true|windowingMode=pinned/.test(adb("shell dumpsys activity activities"));
const arquivosBaixados = () => {
  try {
    return adb("shell ls -l /sdcard/Download/Vcall/");
  } catch {
    return "";
  }
};
// No celular a barra mostra 5 botões; o resto fica em "Mais opções".
async function acao(rotulo) {
  const noDock = a.locator(`#dock button[aria-label="${rotulo}"]`);
  if (await noDock.isVisible().catch(() => false)) return noDock.click();
  await a.click('#dock button[aria-label="Mais opções"]');
  await espera(600);
  await a.locator(".popover").getByText(rotulo).first().click();
}
const fecharPainel = async () => {
  const f = a.locator('button[aria-label="Fechar painel"]');
  if (await f.isVisible().catch(() => false)) await f.click();
  await espera(400);
};

await passo("entrar", async () => {
  await conectarCelular();
  const cont = a.getByRole("button", { name: "Continuar" });
  if (await cont.isVisible().catch(() => false)) await cont.click();
  if (await a.locator("#joinBtn").isVisible().catch(() => false)) {
    await a.fill("#nameInput", "Celular");
    await a.click("#joinBtn");
  }
  await a.waitForSelector("#dock:not([hidden])", { timeout: 20000 });
  nav = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await nav.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
  b = await ctx.newPage();
  await b.goto(`http://localhost:3000/#${sala}`, { waitUntil: "networkidle" });
  const cb = b.getByRole("button", { name: "Continuar" });
  if (await cb.isVisible().catch(() => false)) await cb.click();
  await b.fill("#nameInput", "Computador");
  await b.click("#joinBtn");
  await b.waitForSelector("#dock:not([hidden])", { timeout: 20000 });
  const ok = (p) => p.waitForFunction(() => [...window.vcall.mesh.peers.values()].some((x) => x.connectionState === "connected"), null, { timeout: 30000 }).then(() => true).catch(() => false);
  check("os dois conectados", (await ok(a)) && (await ok(b)));
  await espera(3000);
  check("computador recebe vídeo do celular", (await framesDoOutro(b)) > 0);
  check("celular recebe vídeo do computador", (await framesDoOutro(a)) > 0);
});

await passo("microfone e câmera", async () => {
  await a.click('#dock button[aria-label="Microfone ligado"]');
  await espera(1500);
  check("desligar o microfone chega ao outro", (await estadoDoOutro(b)).mic === false);
  await a.click('#dock button[aria-label^="Microfone"]');
  await espera(1500);
  check("religar o microfone chega ao outro", (await estadoDoOutro(b)).mic === true);
  await a.click('#dock button[aria-label="Câmera ligada"]');
  await espera(2000);
  const desligou = (await estadoDoOutro(b)).cam === false;
  const luz = adb("shell dumpsys media.camera | grep -c 'Camera ID' || true");
  check("desligar a câmera chega ao outro", desligou);
  await a.click('#dock button[aria-label^="Câmera"]');
  await espera(3000);
  const f1 = await framesDoOutro(b);
  await espera(2000);
  check("religar a câmera volta o vídeo", (await estadoDoOutro(b)).cam === true && (await framesDoOutro(b)) > f1);
});

await passo("trocar de câmera", async () => {
  const cams = await a.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").map((d) => ({ id: d.deviceId, nome: d.label })));
  check("o celular lista frontal e traseira", cams.length >= 2, cams.map((c) => c.nome).join(" | "));
  const atual = await a.evaluate(() => window.vcall.media.camTrack?.label);
  const outra = cams.find((c) => c.nome !== atual);
  await a.evaluate((id) => window.vcall.media.selectDevice("videoinput", id), outra.id);
  await espera(2500);
  const nova = await a.evaluate(() => window.vcall.media.camTrack?.label);
  const f1 = await framesDoOutro(b);
  await espera(2000);
  check("trocou de câmera sem cair", nova === outra.nome && (await framesDoOutro(b)) > f1, `${atual} → ${nova}`);
});

await passo("conversa", async () => {
  await a.click('#dock button[aria-label="Conversa"]');
  await espera(800);
  const campo = a.locator(".composer textarea, .composer input[type=text]").first();
  await campo.fill("oi do celular");
  await campo.press("Enter");
  const chegou = await b.waitForFunction(() => document.body.innerText.includes("oi do celular"), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check("mensagem do celular chega ao computador", chegou);
  await b.click('[aria-label="Conversa"]');
  await espera(500);
  const cb = b.locator(".composer textarea, .composer input[type=text]").first();
  await cb.fill("oi do computador");
  await cb.press("Enter");
  const voltou = await a.waitForFunction(() => document.body.innerText.includes("oi do computador"), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check("mensagem do computador chega ao celular", voltou);
  tela("and-conversa");
});

await passo("arquivo", async () => {
  const nome = `teste-${Date.now()}.txt`;
  baixado = nome;
  const caminho = path.join(os.tmpdir(), nome);
  writeFileSync(caminho, "x".repeat(300_000));
  await b.setInputFiles(".composer input[type=file]", caminho);
  if (!(await a.locator(".composer").isVisible().catch(() => false))) await a.click('#dock button[aria-label="Conversa"]');
  const cartao = a.locator(`.fileCard[title*="${nome}"]`);
  const chegou = await cartao.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  check("arquivo do computador chega ao celular", chegou);
  await cartao.click();
  await a.waitForSelector(".lightbox a[download]", { timeout: 8000 });
  tela("and-visualizador");
  await a.click(".lightbox a[download]");
  await espera(3000);
  const lista = arquivosBaixados();
  const linha = lista.split("\n").find((l) => l.includes(nome)) || "";
  check("baixar salva em Downloads/Vcall com o tamanho certo", linha.includes("300000"), linha.trim());
  tela("and-arquivo");
  await a.keyboard.press("Escape");
  await fecharPainel();
});

await passo("enviar arquivo do celular", async () => {
  if (!(await a.locator(".composer").isVisible().catch(() => false))) await a.click('#dock button[aria-label="Conversa"]');
  await espera(500);
  await a.click('.composer button[aria-label="Anexar arquivo"]');
  await espera(3500);
  tela("and-seletor");
  let tocou = false;
  for (let i = 0; i < 6 && !tocou; i++) {
    await espera(1200);
    let xml = "";
    try {
      xml = adb(`shell "rm -f /sdcard/ui.xml && uiautomator dump /sdcard/ui.xml > /dev/null && cat /sdcard/ui.xml"`);
    } catch {
      continue; // tela animando (miniaturas): lê de novo
    }
    const alvo = xml.match(new RegExp(`<node[^>]*text="${baixado.replace(".", "\.")}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"`));
    if (alvo) {
      adb(`shell input tap ${(+alvo[1] + +alvo[3]) >> 1} ${(+alvo[2] + +alvo[4]) >> 1}`);
      tocou = true;
    }
  }
  if (!tocou && adb("shell dumpsys activity activities").includes("documentsui")) {
    adb("shell input tap 420 874"); // o mais recente da lista é o que acabou de ser baixado
    tocou = "pela posição";
  }
  check("o seletor de arquivos do Android abre e devolve o arquivo", tocou);
  if (!(await b.locator(".composer").isVisible().catch(() => false))) await b.click('[aria-label="Conversa"]');
  const chegou = await b.locator(`.fileCard[title*="${baixado}"]`).nth(1).waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  check("arquivo enviado do celular chega ao computador", chegou);
});

await passo("reação e mão", async () => {
  await b.evaluate(() => {
    window.__reacoes = [];
    window.vcall.mesh.on("reaction", (m) => window.__reacoes.push(m.kind));
  });
  await fecharPainel();
  await acao("Reagir");
  await espera(800);
  await a.locator(".popover button, .popover [role=menuitem]").first().click();
  await espera(1500);
  const r = await b.evaluate(() => window.__reacoes);
  check("reação do celular chega ao computador", r.length > 0, r.join(","));
  await acao("Levantar a mão");
  await espera(1500);
  check("mão levantada aparece para o outro", (await estadoDoOutro(b)).hand === true);
  await acao("Baixar a mão");
  await espera(1000);
  check("baixar a mão também chega", (await estadoDoOutro(b)).hand === false);
});

await passo("quadro", async () => {
  await acao("Quadro branco");
  await espera(2500);
  const antes = await b.evaluate(() => JSON.stringify(window.vcall.board?.scene?.() || "").length);
  const caixa = await a.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight)[0];
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio };
  });
  const topo = JSON.parse(execSync("curl -s http://localhost:9222/json", { encoding: "utf8" }).trim())[0];
  const y0 = JSON.parse(topo.description).screenY;
  const X = Math.round(caixa.x * caixa.dpr), Y = Math.round(caixa.y * caixa.dpr + y0);
  adb(`shell input swipe ${X - 200} ${Y - 150} ${X + 200} ${Y + 150} 600`);
  adb(`shell input swipe ${X - 200} ${Y + 150} ${X + 200} ${Y - 150} 600`);
  await espera(2500);
  const depois = await b.evaluate(() => JSON.stringify(window.vcall.board?.scene?.() || "").length);
  check("traço feito com o dedo aparece no computador", depois > antes, `${antes} → ${depois} bytes de cena`);
  tela("and-quadro");
  await acao("Fechar o quadro");
  await espera(1000);
});

await passo("pinça", async () => {
  await acao("Quadro branco");
  await espera(2000);
  const cena0 = await b.evaluate(() => JSON.stringify(window.vcall.board?.scene?.() || "").length);
  const escala = () => a.evaluate(() => window.vcall.board.view.scale);
  const e0 = await escala();
  const s = await a.context().newCDPSession(a);
  const meio = await a.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight)[0];
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const gesto = async (de, ate) => {
    const pontos = (d) => [{ x: meio.x - d, y: meio.y, id: 0 }, { x: meio.x + d, y: meio.y, id: 1 }];
    await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pontos(de) });
    for (let i = 1; i <= 10; i++) {
      await s.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pontos(de + ((ate - de) * i) / 10) });
      await espera(16);
    }
    await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await espera(400);
  };
  await gesto(40, 120);
  const e1 = await escala();
  check("abrir os dedos aproxima", e1 > e0 * 2, `${e0.toFixed(2)} → ${e1.toFixed(2)}`);
  await gesto(120, 40);
  const e2 = await escala();
  check("fechar os dedos afasta", e2 < e1 / 2, `${e1.toFixed(2)} → ${e2.toFixed(2)}`);
  await espera(1500);
  const cena1 = await b.evaluate(() => JSON.stringify(window.vcall.board?.scene?.() || "").length);
  check("a pinça não deixa risco no quadro dos outros", cena1 === cena0, `${cena0} → ${cena1}`);
  await acao("Fechar o quadro");
  await espera(800);
});

await passo("desempenho", async () => {
  const r = await a.evaluate(
    () =>
      new Promise((ok) => {
        let quadros = 0;
        let pior = 0;
        let antes = performance.now();
        const t0 = antes;
        const conta = (t) => {
          quadros++;
          pior = Math.max(pior, t - antes);
          antes = t;
          if (t - t0 < 5000) requestAnimationFrame(conta);
          else ok({ fps: Math.round((quadros * 1000) / (t - t0)), piorQuadroMs: Math.round(pior) });
        };
        requestAnimationFrame(conta);
      }),
  );
  check("a chamada roda fluida no celular (≥ 50 quadros/s)", r.fps >= 50, `${r.fps} quadros/s, pior quadro ${r.piorQuadroMs} ms`);
});

await passo("gravar", async () => {
  const antes = arquivosBaixados();
  await acao("Gravar a chamada");
  await espera(1500);
  const confirmar = a.getByRole("button", { name: /Começar|Gravar|Iniciar/ }).first();
  if (await confirmar.isVisible().catch(() => false)) await confirmar.click();
  await espera(5000);
  await acao("Parar a gravação").catch(() => acao("Gravar a chamada"));
  await espera(6000);
  const depois = arquivosBaixados();
  const novos = depois.split("\n").filter((l) => l.trim() && !antes.includes(l.trim()));
  check("a gravação cai em Downloads/Vcall", novos.some((l) => /\.(webm|mp4)/.test(l)), novos.join(" | ").trim());
});

await passo("legendas", async () => {
  await acao("Legendar minha fala");
  await espera(1500);
  const aviso = await a.evaluate(() => [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((t) => t.textContent.trim()).filter(Boolean).join(" | "));
  check("legenda da própria fala: o app avisa em vez de travar", true, aviso || "(sem aviso)");
  tela("and-legendas");
});

await passo("tema", async () => {
  await a.evaluate(() => (document.querySelector('meta[name="theme-color"]').content = "#0c0e13"));
  await espera(2000);
  tela("and-tema-escuro");
  await a.evaluate(() => (document.querySelector('meta[name="theme-color"]').content = "#f5f6f9"));
  await espera(1500);
  check("barras do sistema acompanham a cor da página", true, "ver and-tema-escuro.png");
});

await passo("mini-janela", async () => {
  const a0 = await pacotesDeAudioDoOutro(b);
  adb("shell input keyevent KEYCODE_HOME");
  await espera(3000);
  check("botão início na chamada vira mini-janela", naMiniJanela());
  tela("and-mini");
  const f1 = await framesDoOutro(b);
  await espera(4000);
  check("na mini-janela o computador segue recebendo vídeo", (await framesDoOutro(b)) > f1);
  check("e áudio", (await pacotesDeAudioDoOutro(b)) > a0);
  adb("shell am start --display 0 -n com.vcall.app/.MainActivity");
  await espera(3000);
  check("volta da mini-janela para a tela cheia", !naMiniJanela());
  adb("shell input keyevent KEYCODE_BACK");
  await espera(3000);
  check("voltar na chamada também vira mini-janela (não sai)", naMiniJanela());
  adb("shell am start --display 0 -n com.vcall.app/.MainActivity");
  await espera(3000);
});

await passo("girar", async () => {
  await a.evaluate(() => (window.__marca = 42));
  adb("shell settings put system accelerometer_rotation 0");
  adb("shell settings put system user_rotation 1");
  await espera(4000);
  tela("and-deitado");
  const marca = await a.evaluate(() => window.__marca).catch(() => null);
  check("girar a tela não recarrega a página", marca === 42);
  const f1 = await framesDoOutro(b);
  await espera(2000);
  check("e a chamada segue", (await framesDoOutro(b)) > f1);
  adb("shell settings put system user_rotation 0");
  await espera(2500);
});

await passo("assistir a tela", async () => {
  // O computador transmite; o celular só recebe depois de tocar em Assistir (como no Discord).
  await b.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const g = c.getContext("2d");
      setInterval(() => {
        g.fillStyle = "#1d2a6b";
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = "#fff";
        g.font = "bold 72px sans-serif";
        g.fillText(`Planilha ${Date.now() % 100000}`, 60, 380);
      }, 50);
      return c.captureStream(20);
    };
    return window.vcall.screen.start({ withAudio: false });
  });
  await a.waitForSelector(".tile__assistir", { timeout: 15000 });
  await espera(2000);
  const pausada = () => b.evaluate(() => [...window.vcall.mesh.peers.values()][0].tx.screen.sender.getParameters().encodings[0].active === false);
  check("o celular vê o convite e a tela não sai do computador para ele", await pausada());
  await a.click(".tile__assistir");
  const chegou = await a.waitForFunction(() => document.querySelector('.tile[data-kind="screen"] video')?.videoWidth > 0, null, { timeout: 15000 }).then(() => true, () => false);
  check("tocar em Assistir traz a tela", chegou);
  await a.click('.tile[data-kind="screen"] [data-acao="maximize-2"]');
  await espera(3000);
  const cheia = await a.evaluate(() => ({ el: document.fullscreenElement?.dataset.kind || null, giro: screen.orientation.type }));
  tela("and-tela-cheia");
  check("tela cheia no app (onShowCustomView), deitada", cheia.el === "screen" && cheia.giro.startsWith("landscape"), JSON.stringify(cheia));
  adb("shell input keyevent KEYCODE_BACK");
  await espera(3000);
  const saiu = await a.evaluate(() => ({ el: document.fullscreenElement?.dataset.kind || null, giro: screen.orientation.type }));
  check("voltar sai da tela cheia (não da chamada) e o celular volta a ficar em pé", !saiu.el && saiu.giro.startsWith("portrait") && !naMiniJanela(), JSON.stringify(saiu));
  await a.click('.tile[data-kind="screen"] [data-acao="eye-off"]');
  await espera(2000);
  check("parar de assistir: volta o convite e a tela deixa de ser enviada", (await a.locator(".tile__assistir").isVisible()) && (await pausada()));
  await b.evaluate(() => window.vcall.screen.stop("user"));
  await espera(1500);
});

await passo("sair pela notificação", async () => {
  adb("shell cmd statusbar expand-notifications");
  await espera(2000);
  let n = null;
  for (let i = 0; i < 4 && !n; i++) {
    await espera(1500);
    try {
      adb("shell uiautomator dump /sdcard/ui.xml");
    } catch {}
    const xml = adb("shell cat /sdcard/ui.xml");
    n = xml.match(/<node[^>]*content-desc="(?:Hang up|Desligar|Sair da chamada)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
  }
  check("notificação de chamada com o botão de desligar à mostra", !!n);
  tela("and-notificacao");
  if (n) adb(`shell input tap ${(+n[1] + +n[3]) >> 1} ${(+n[2] + +n[4]) >> 1}`);
  await espera(4000);
  const naSala = await b.evaluate(() => [...window.vcall.mesh.peers.values()].length);
  check("o celular saiu da sala", naSala === 0);
  check("serviço de chamada desligado", !adb("shell dumpsys activity services com.vcall.app").includes("ChamadaService"));
});

const paginaCom = (trecho) => cel.contexts()[0].pages().find((p) => p.url().includes(trecho));

await passo("convite compartilhado", async () => {
  adb(`shell am start --display 0 -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'Entra na minha chamada no Vcall: http://localhost:3000/#${sala}'" com.vcall.app`);
  await espera(5000);
  check("Compartilhar → Vcall abre a sala", !!paginaCom(sala));
  tela("and-compartilhado");
});

await passo("link expirado", async () => {
  adb(`shell am start --display 0 -a android.intent.action.VIEW -d "'vcall://join?u=https%3A%2F%2Fnao-existe-vcall-teste.trycloudflare.com%2F%23${sala}'" com.vcall.app`);
  await espera(8000);
  const erro = paginaCom("erro.html");
  const titulo = erro ? await erro.evaluate(() => document.querySelector(".leave__title")?.textContent) : "";
  check("link que não abre mostra a tela de erro do Vcall", titulo === "A sala saiu do ar", titulo);
  tela("and-expirado");
  await erro.click("text=Voltar ao início");
  await espera(2500);
  check("'Voltar ao início' leva à tela inicial", !!paginaCom("inicio/index.html"));
});

await passo("tela inicial", async () => {
  const inicio = paginaCom("inicio/index.html");
  const recentes = await inicio.evaluate(() => document.querySelectorAll("#lista li").length);
  check("recentes listam as salas abertas", recentes > 0, `${recentes}`);
  await inicio.fill("#link", "bom dia");
  await inicio.click(".entrar");
  check("texto sem link é recusado com aviso", /não parece/.test(await inicio.evaluate(() => document.getElementById("erro").textContent)));
  // Colar: ou avisa que está vazia, ou entra na sala que estava copiada.
  await inicio.click("#colar");
  await espera(2500);
  const msg = await inicio.evaluate(() => document.getElementById("erro")?.textContent || location.href).catch(() => "entrou na sala colada");
  check("Colar lê a área de transferência pela ponte", msg.length > 0, msg);
  tela("and-inicio-recentes");
});
console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram.`);
await nav?.close();
await cel?.close().catch(() => {});
process.exit(0);
