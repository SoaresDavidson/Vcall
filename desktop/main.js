/**
 * desktop/main.js — o aplicativo de mesa do Vcall (Electron), Windows e Linux.
 *
 * Uma janela própria, com motor embutido: não abre o navegador da pessoa, não
 * depende de qual navegador ela tem, e a chamada funciona igual em qualquer
 * máquina — é o mesmo modelo de Discord, Slack e Teams.
 *
 * O app SOBE O PRÓPRIO SERVIDOR em 127.0.0.1 e a janela carrega dele:
 *
 *   - câmera, microfone e tela exigem origem segura, e `http://127.0.0.1`
 *     conta como segura; `file://` não;
 *   - a política de segurança de conteúdo é a mesma da versão web, sem
 *     exceção criada só para o desktop;
 *   - o túnel do Cloudflare (link público) aponta para esse mesmo servidor.
 *
 * PORTA FIXA (7718, com recuo). O navegador guarda nome, avatar, volumes e
 * preferências por ORIGEM, e a origem inclui a porta: com porta sorteada a
 * cada abertura, a pessoa perderia tudo toda vez que abrisse o app.
 */
import { app, BrowserWindow, Menu, dialog, desktopCapturer, globalShortcut, ipcMain, nativeTheme, net, protocol, screen, session, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpServer } from "../src/http.js";
import { attachSignaling } from "../src/signaling.js";
import { RoomRegistry } from "../src/rooms.js";
import { hostControl } from "./guard.js";
import { Tunnel } from "./tunnel.js";
import { LinkTailscale } from "./tailscale.js";
import { lerTurn, salvarTurn, visaoDoTurn } from "./turn.js";
import { definirTurnLocal } from "../src/ice.js";
import { definirSfu } from "../src/sfu.js";
import { Sfu } from "./sfu.js";
import { RedeVcall, limparPessoa } from "./rede.js";
import { conferir } from "./atualizacao.js";
import * as atualizador from "./atualizador.js";
import * as github from "./github.js";
import { ESQUEMA, destinoDoLink, linkDosArgumentos, registrarEsquema } from "./protocol.js";
import { descreverFontes, montarResposta, sessaoWayland, umPorVez, somDoComputadorNaLista } from "./captura.js";
import { argsParaX11, executavelParaRegistrar, modoDeReabrir, opcoesDeExibicao } from "./linux.js";
import { descartarWhisper, ESQUEMA_FALA, MODELOS, nomeDoModelo, prepararModelo, prepararWhisper, responderModelo, WHISPER, WHISPER_PADRAO } from "./fala.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(__dirname, "..", "public", "assets", "icon-512.png");
const PORTAS = [7718, 7719, 7720, 0];

/** Segredo desta execução: libera o painel do túnel só para a nossa janela. */
const TOKEN = randomBytes(24).toString("base64url");

let win = null;
let baseUrl = "";
let tunnel = null;
/** O link pela rede Tailscale da pessoa (`tailscale serve`), quando pedido. */
let linkTs = null;
/** O LiveKit de quem transmite (desktop/sfu.js); liga sob demanda. */
let sfu = null;
/** Sobe o link do Tailscale (usado pelo Convidar e pelo "sempre disponível"). */
let ligarTailscale = async () => null;

/*
 * "Deixar este computador disponível na minha rede Tailscale": guardado em
 * rede.json, na pasta do app. Ligado, o link do Tailscale sobe sozinho ao
 * abrir o Vcall, e o celular consegue criar chamadas aqui a qualquer hora.
 */
const arquivoRede = () => path.join(app.getPath("userData"), "rede.json");
function lerPrefRede() {
  try {
    return { sempre: false, ...JSON.parse(readFileSync(arquivoRede(), "utf8")) };
  } catch {
    return { sempre: false };
  }
}
function gravarPrefRede(pref) {
  try {
    mkdirSync(path.dirname(arquivoRede()), { recursive: true });
    writeFileSync(arquivoRede(), JSON.stringify(pref));
  } catch (err) {
    registrar("rede-pref-falhou", { erro: String(err?.message || err) });
  }
}
/* "Servidor TURN" das configurações (desktop/turn.js). */
const arquivoTurn = () => path.join(app.getPath("userData"), "turn.json");

/** Destino pedido por link antes de a janela existir. */
let pendente = null;
/** Origens de salas de outras pessoas que o usuário abriu por convite. */
const origensConfiaveis = new Set();

/*
 * Ajustes do motor para um app de chamada:
 *  - áudio remoto toca sem exigir clique (a janela é nossa; não é um site
 *    tentando tocar som sozinho) — evita a chamada começar muda;
 *  - a janela minimizada continua recebendo e mandando vídeo em tempo real.
 */
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
if (process.platform === "linux") {
  // A captura pelo PipeWire (portal do Wayland) já vem ligada no Electron:
  // o `WebRTCPipeWireCapturer` saiu do Chromium no M133 e não fazia nada.
  // Atenção: o Chromium só lê UM `enable-features`; junte tudo num valor só.
  // XWayland quando houver: reabre já com a opção na linha de comando, antes
  // de qualquer janela, sem sair do processo (no AppImage, sair desmonta a
  // pasta do app e a cópia reaberta não sobe). Ver modoDeReabrir em linux.js.
  const x11 = argsParaX11();
  if (x11) {
    if (modoDeReabrir() === "execve") {
      process.execve(process.execPath, [process.execPath, ...x11], process.env);
    } else {
      app.relaunch({ args: x11, execPath: process.env.APPIMAGE || process.execPath });
      app.exit(0);
    }
  }
  for (const [chave, valor] of opcoesDeExibicao()) app.commandLine.appendSwitch(chave, valor);
}

/*
 * Esquema interno de onde a página busca o modelo de reconhecimento de fala
 * (desktop/fala.js). Precisa ser registrado antes de o app ficar pronto, e
 * com `supportFetchAPI` para o worker do Vosk conseguir baixá-lo.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: ESQUEMA_FALA, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/* ==================================================================== *
 * Registro de ocorrências
 * ==================================================================== */

/*
 * Quando a janela cai (processo de renderização encerrado pelo sistema, falta
 * de memória, driver de vídeo), a pessoa só vê que "caiu da chamada". Este
 * arquivo guarda o motivo real, para diagnosticar sem adivinhação:
 *   Windows: %APPDATA%\Vcall\logs\vcall.log
 *   Linux:   ~/.config/Vcall/logs/vcall.log
 */
function registrar(evento, dados = {}) {
  try {
    const pasta = app.getPath("logs");
    mkdirSync(pasta, { recursive: true });
    appendFileSync(path.join(pasta, "vcall.log"), `${JSON.stringify({ t: new Date().toISOString(), evento, ...dados })}\n`);
  } catch {
    /* sem disco para log não é motivo para derrubar nada */
  }
}

/*
 * Windows 11: com a janela do Vcall minimizada, o sistema põe o processo em
 * modo de economia (EcoQoS) e ignora o pedido de timer fino. A captura de
 * tela roda neste processo (thread desktopCaptureThread do Chromium), e caía
 * de ~43 para ~20 qps (medido). O Chromium só protege a GPU e o áudio, e o
 * Electron não expõe SetProcessInformation: um PowerShell desliga as duas
 * economias para este processo, uma vez, na primeira captura. O Windows
 * guarda a escolha até o processo acabar.
 */
let economiaDesligada = false;
function semEconomiaDoWindows() {
  if (process.platform !== "win32" || economiaDesligada) return;
  economiaDesligada = true;
  const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class VcallEco {
  [StructLayout(LayoutKind.Sequential)] public struct S { public uint V; public uint C; public uint E; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool h, int p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessInformation(IntPtr h, int c, ref S s, int n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static bool Desligar(int pid) {
    IntPtr h = OpenProcess(0x0200, false, pid);
    if (h == IntPtr.Zero) return false;
    S s = new S { V = 1, C = 1 | 4, E = 0 }; // EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION, ambas desligadas
    bool ok = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(s));
    CloseHandle(h);
    return ok;
  }
}
'@
[VcallEco]::Desligar(${process.pid})`;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 30_000 },
    (err, saida) => registrar("sem-economia", { ok: !err && /True/.test(String(saida)), erro: err ? String(err.message || err).slice(0, 160) : undefined }),
  );
}

/* ==================================================================== *
 * Servidor embutido
 * ==================================================================== */

function escutar(server, porta) {
  return new Promise((resolve) => {
    const falhou = () => resolve(null);
    server.once("error", falhou);
    server.listen(porta, "127.0.0.1", () => {
      server.removeListener("error", falhou);
      resolve(server.address().port);
    });
  });
}

async function subirServidor() {
  const registry = new RoomRegistry();
  let porta = 0;
  // Nome e avatar de quem usa o app; a página avisa (ação "perfil").
  let pessoa = null;
  let abrindoTunel = null;
  definirTurnLocal(lerTurn(arquivoTurn()));

  const control = hostControl({
    token: TOKEN,
    abertas: {
      // A página pergunta "estou no app?" e recebe o token do painel do túnel.
      hello: async () => ({ app: true, token: TOKEN, porta, batimento: 60_000 }),
      // No Electron a vida do app é a vida da janela; o batimento não decide nada.
      vivo: async () => ({ ok: true }),
      tchau: async () => ({ ok: true }),
    },
    acoes: {
      status: async () => ({
        estado: tunnel?.state || "parado",
        url: tunnel?.url || null,
        porta,
        tailscale: {
          estado: linkTs?.state || "parado",
          url: linkTs?.url || null,
          habilitar: linkTs?.habilitar || null,
          erro: linkTs?.erro || null,
        },
      }),

      /*
       * Verificação de versão. Estava só no caminho antigo (SEA), então no
       * aplicativo de verdade a rota devolvia 404 e o bloco "Atualizações"
       * das configurações nunca respondia.
       */
      // Para a lista da rede Tailscale mostrar quem está neste computador.
      perfil: async (url) => {
        const q = url.searchParams;
        pessoa = limparPessoa({ nome: q.get("nome"), avatar: { style: q.get("estilo"), seed: q.get("semente") } });
        return { ok: true };
      },

      atualizacao: async (url) => conferir({ forcar: url.searchParams.get("forcar") === "1", atual: app.getVersion() }),

      // O túnel já sobe ao criar a sala: um pedido no meio disso espera o
      // mesmo túnel, em vez de derrubá-lo e começar outro.
      "tunnel/abrir": async () => {
        if (tunnel?.url && tunnel.state === "pronto") return { estado: "pronto", url: tunnel.url };
        abrindoTunel ??= ligarTunel().finally(() => (abrindoTunel = null));
        return { estado: "pronto", url: await abrindoTunel };
      },
      // Link novo sem sair da chamada: o túnel atual cai e outro sobe.
      "tunnel/renovar": async () => ({ estado: "pronto", url: await ligarTunel() }),
      "tunnel/fechar": async () => {
        tunnel?.stop();
        return { estado: "parado", url: null };
      },

      /*
       * Link pela rede Tailscale. "conferir" só olha (instalado? conectado?),
       * para o Convidar mostrar a opção do jeito certo antes de qualquer clique.
       */
      "tailscale/conferir": async () => LinkTailscale.conferir(),
      "tailscale/abrir": async () => {
        if (linkTs?.url && linkTs.state === "pronto") return { estado: "pronto", url: linkTs.url };
        // Um pedido que ainda está esperando (o HTTPS sendo ligado) não começa outro.
        if (linkTs && ["conferindo", "habilitar", "verificando"].includes(linkTs.state)) {
          return { estado: linkTs.state, url: null, habilitar: linkTs.habilitar };
        }
        return { estado: "pronto", url: await ligarTailscale() };
      },

      // Servidor TURN: sem parâmetros só lê; com `tipo`, salva e já vale para a próxima chamada.
      "turn/config": async (url) => {
        const q = url.searchParams;
        if (!q.has("tipo")) return visaoDoTurn(lerTurn(arquivoTurn()));
        const r = salvarTurn(arquivoTurn(), Object.fromEntries(["tipo", "url", "urls", "usuario", "senha", "segredo"].map((k) => [k, q.get(k) || ""])));
        return r.erro ? { code: 400, erro: r.erro } : r.turn;
      },

      // "Sempre disponível na rede": lê ou muda (e já liga ou desliga o link).
      "rede/config": async (url) => {
        const valor = url.searchParams.get("sempre");
        if (valor === "1" || valor === "0") {
          gravarPrefRede({ ...lerPrefRede(), sempre: valor === "1" });
          if (valor === "1" && linkTs?.state !== "pronto") ligarTailscale().catch(() => {});
        }
        return lerPrefRede();
      },

      /*
       * Entrar numa chamada de outro computador da rede, nesta janela. Passa
       * pela mesma conferência dos links vcall:// (https e id de sala
       * válido): uma página não leva a janela para qualquer lugar.
       */
      abrir: async (url) => {
        const destino = destinoDoLink(`${ESQUEMA}://join?u=${encodeURIComponent(url.searchParams.get("u") || "")}`);
        if (destino?.tipo !== "remoto") return { code: 400, erro: "endereço de sala inválido" };
        setImmediate(() => abrirDestino(destino));
        return { ok: true };
      },
      "tailscale/fechar": async () => {
        linkTs?.stop();
        return { estado: "parado", url: null };
      },
    },
  });

  /*
   * Sobe um túnel novo e confere que o link abre. Se o primeiro endereço não
   * responder (acontece com o túnel rápido), tenta outro uma vez antes de
   * desistir — a pessoa via um link morto e só resolvia fechando o app.
   */
  async function ligarTunel() {
    for (let tentativa = 1; ; tentativa += 1) {
      tunnel?.stop();
      tunnel = new Tunnel(porta);
      try {
        return await tunnel.start();
      } catch (err) {
        registrar("tunel-falhou", { tentativa, erro: String(err?.message || err) });
        if (tentativa >= 2) throw err;
      }
    }
  }

  ligarTailscale = async () => {
    linkTs?.stop({ silencioso: true });
    linkTs = new LinkTailscale(porta);
    try {
      return await linkTs.start();
    } catch (err) {
      registrar("tailscale-falhou", { erro: String(err?.message || err) });
      throw err;
    }
  };
  const rede = new RedeVcall({
    eu: () => ({ url: linkTs?.state === "pronto" ? linkTs.url : null, salas: registry.directory({ rede: true }), pessoa }),
  });
  const server = createHttpServer({ registry, control, trustTailscale: true, rede: () => rede.listar(), pessoa: () => pessoa });
  // O link público do app é o cloudflared nesta mesma máquina: o endereço
  // real de cada convidado vem no CF-Connecting-IP. Pelo Tailscale, no
  // X-Forwarded-For que o `tailscale serve` põe (só endereços da tailnet).
  attachSignaling(server, { registry, trustCloudflare: true, trustTailscale: true });
  // O SFU só liga quando a janela deste app pede para transmitir por ele.
  sfu = new Sfu();
  sfu.on("caiu", (d) => registrar("sfu-caiu", d));
  definirSfu({
    porta: () => sfu.porta,
    ligar: () => sfu.ligar().catch((err) => (registrar("sfu-falhou", { erro: String(err?.message || err) }), Promise.reject(err))),
    ficha: (...a) => sfu.ficha(...a),
  });

  for (const p of PORTAS) {
    const obtida = await escutar(server, p);
    if (obtida) {
      porta = obtida;
      return `http://127.0.0.1:${porta}`;
    }
  }
  throw new Error("nenhuma porta disponível");
}

/* ==================================================================== *
 * Janela
 * ==================================================================== */

/** Endereço para um destino de link (ou a tela inicial). */
function enderecoPara(destino) {
  if (destino?.tipo === "remoto") {
    origensConfiaveis.add(new URL(destino.url).origin);
    return destino.url;
  }
  return `${baseUrl}/?host=${TOKEN}${destino?.room ? `#${destino.room}` : ""}`;
}

function abrirDestino(destino) {
  if (!destino) return;
  if (!win) {
    pendente = destino;
    return;
  }
  win.loadURL(enderecoPara(destino));
  focar();
}

function focar() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const origemPermitida = (url) => {
  try {
    const o = new URL(url).origin;
    return o === baseUrl || origensConfiaveis.has(o);
  } catch {
    return false;
  }
};

/** Cores da barra de título seguindo o tema da página. */
/*
 * Os botões de janela sobre a página.
 *
 * `titleBarStyle: "hidden"` tira a barra de título inteira e deixa só os três
 * botões flutuando no canto — é o que o modo `--app=` do Chromium não
 * consegue fazer, e o motivo de o executável ter migrado para cá.
 *
 * Fundo transparente de propósito: quem pinta aquela faixa é a própria
 * página, então ela acompanha o tema e a paleta sem o Electron saber de nada.
 * Só o símbolo (o traço do minimizar, o X) precisa de cor, e ela segue os
 * neutros de texto da paleta Tinta.
 */
function coresDaBarra(escuro) {
  return escuro
    ? { color: "#00000000", symbolColor: "#a8b1c2", height: 40 }
    : { color: "#00000000", symbolColor: "#3c4654", height: 40 };
}

/** Código HTTP (positivo) ou de rede do Chromium (negativo) → tipo da tela de erro. */
function tipoDoErro(codigo) {
  if (codigo === -106) return "internet"; // ERR_INTERNET_DISCONNECTED
  if (codigo === -7 || codigo === -118 || codigo === 504 || codigo === 524) return "demora";
  if (codigo < 0 || codigo === 502 || codigo === 503 || codigo === 530 || (codigo >= 520 && codigo <= 527)) return "tunel";
  return "servidor";
}

function criarJanela() {
  const escuro = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Vcall",
    icon: ICON,
    backgroundColor: "#0b0722",
    // Sem moldura do sistema: a interface vai até o topo e os botões de
    // minimizar/maximizar/fechar ficam por cima, nativos, com a cor do tema.
    titleBarStyle: "hidden",
    titleBarOverlay: coresDaBarra(escuro),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // Chamada não pode desacelerar só porque a janela saiu da frente.
      backgroundThrottling: false,
    },
  });

  // A página já nasce com a intro animada por cima: mostrar no primeiro
  // quadro pintado evita a janela branca/vazia antes do conteúdo.
  win.once("ready-to-show", () => win.show());

  /*
   * O link de outra pessoa não abriu (túnel fechado, sem internet): a nossa
   * tela de erro, na paleta da pessoa, no lugar da página da Cloudflare ou da
   * tela cinza do Chromium.
   */
  const mostrarErro = (url, codigo) => {
    if (!win || !/^https?:/.test(url) || url.startsWith(baseUrl)) return;
    const busca = new URLSearchParams({ tipo: tipoDoErro(codigo), codigo: String(codigo), url });
    win.loadURL(`${baseUrl}/erro.html?${busca}`);
  };
  win.webContents.on("did-navigate", (_e, url, codigo) => {
    if (codigo >= 500) mostrarErro(url, codigo);
  });
  win.webContents.on("did-fail-load", (_e, codigo, _descricao, url, principal) => {
    if (principal && codigo !== -3) mostrarErro(url, codigo); // -3: navegação cancelada
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // A mini-janela (Document Picture-in-Picture) é aberta pela própria página,
    // sem endereço: é um documento em branco que ela mesma preenche.
    if (!url || url === "about:blank") return { action: "allow" };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!origemPermitida(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Atalhos de desenvolvedor só em desenvolvimento.
  if (app.isPackaged) {
    win.webContents.on("before-input-event", (e, input) => {
      if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i") e.preventDefault();
    });
  }

  win.on("closed", () => {
    win = null;
    fecharSobreposicao();
    globalShortcut.unregisterAll();
  });

  /*
   * A janela caiu (o processo de renderização morreu). Antes a pessoa ficava
   * com uma tela branca e "caía da chamada" sem saber por quê. Agora o motivo
   * vai para o log e a janela volta sozinha para a mesma sala — a sala está
   * no endereço (#id), então basta recarregar.
   */
  let quedas = 0;
  win.webContents.on("render-process-gone", (_e, detalhes) => {
    registrar("janela-caiu", { motivo: detalhes.reason, codigo: detalhes.exitCode });
    if (detalhes.reason === "clean-exit" || !win) return;
    quedas += 1;
    if (quedas > 3) {
      dialog.showErrorBox(
        "O Vcall parou de responder",
        `A janela fechou sozinha várias vezes seguidas. Feche e abra o Vcall de novo. Se continuar, mande este arquivo para o suporte: ${path.join(app.getPath("logs"), "vcall.log")}`,
      );
      return;
    }
    setTimeout(() => win?.webContents.reload(), 400);
  });
  win.webContents.on("did-finish-load", () => {
    // Uma carga completa depois de um tempo estável zera a contagem.
    setTimeout(() => (quedas = 0), 60_000);
  });

  const alvo = pendente;
  pendente = null;
  win.loadURL(enderecoPara(alvo));
}

ipcMain.on("vcall:tema", (_e, escuro) => {
  try {
    win?.setTitleBarOverlay(coresDaBarra(!!escuro));
  } catch {
    /* plataforma sem sobreposição (macOS) */
  }
});
/*
 * Mini-janela. O Electron anuncia a Document Picture-in-Picture API mas não a
 * implementa (a janela nasce e morre no mesmo instante), então o modo
 * compacto é a própria janela: encolhe, vai para o canto da tela e fica por
 * cima de tudo. Os vídeos continuam os mesmos — nada é recriado.
 */
let tamanhoNormal = null;
ipcMain.handle("vcall:mini", (_e, ligar) => {
  if (!win) return false;
  if (ligar && !tamanhoNormal) {
    tamanhoNormal = { bounds: win.getBounds(), max: win.isMaximized() };
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const w = 400;
    const h = 280;
    win.setMinimumSize(280, 190);
    win.setBounds({ x: workArea.x + workArea.width - w - 24, y: workArea.y + workArea.height - h - 24, width: w, height: h }, true);
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setTitleBarOverlay?.({ height: 30 });
  } else if (!ligar && tamanhoNormal) {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setMinimumSize(900, 600);
    win.setBounds(tamanhoNormal.bounds, true);
    if (tamanhoNormal.max) win.maximize();
    win.setTitleBarOverlay?.({ height: 40 });
    tamanhoNormal = null;
    focar();
  }
  return true;
});

/* ==================================================================== *
 * Modo jogo: sobreposição + atalhos globais
 * ==================================================================== */

/*
 * Como o overlay do Discord: uma janelinha transparente, sempre por cima de
 * tudo (inclusive do jogo em modo janela/sem bordas), que não rouba o foco e
 * deixa os cliques passarem. Mostra quem está na chamada apagadinho e acende
 * quem está falando. Ela só desenha: o estado vem da janela da chamada.
 *
 * Os atalhos globais funcionam com o jogo em foco — o que um atalho de
 * página nunca faria. Só existem enquanto o modo jogo está ligado, para não
 * roubar Ctrl+Shift+M/O de outros programas o tempo todo.
 */
let sobreposicao = null;
let cantoSobreposicao = "tl";
const ATALHO_MIC = "CommandOrControl+Shift+M";
const ATALHO_SOBREPOSICAO = "CommandOrControl+Shift+O";

function posicaoSobreposicao(canto, w, h) {
  const { workArea: a } = screen.getPrimaryDisplay();
  const m = 16;
  const x = canto.endsWith("r") ? a.x + a.width - w - m : a.x + m;
  const y = canto.startsWith("b") ? a.y + a.height - h - m : a.y + m;
  return { x, y };
}

function abrirSobreposicao(canto = cantoSobreposicao) {
  cantoSobreposicao = canto;
  const w = 260;
  const h = 460;
  if (sobreposicao && !sobreposicao.isDestroyed()) {
    sobreposicao.setBounds({ ...posicaoSobreposicao(canto, w, h), width: w, height: h });
    sobreposicao.webContents.send("vcall:canto", canto);
    return;
  }
  sobreposicao = new BrowserWindow({
    width: w,
    height: h,
    ...posicaoSobreposicao(canto, w, h),
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: "Vcall — sobreposição",
    webPreferences: {
      preload: path.join(__dirname, "preload-sobreposicao.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  sobreposicao.setAlwaysOnTop(true, "screen-saver");
  sobreposicao.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  sobreposicao.setIgnoreMouseEvents(true);
  sobreposicao.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  sobreposicao.webContents.on("will-navigate", (e) => e.preventDefault());
  sobreposicao.once("ready-to-show", () => sobreposicao?.showInactive());
  // O canto de agora, não o desta chamada: um pedido que chega com a janela
  // ainda carregando manda a mensagem para o nada. E vai no did-finish-load,
  // não no ready-to-show: o script da página é um módulo e roda depois da
  // primeira pintura, então no ready-to-show ainda não havia quem ouvisse e a
  // sobreposição ficava no canto padrão (o teste do canto falhava às vezes no CI).
  sobreposicao.webContents.once("did-finish-load", () => sobreposicao?.webContents.send("vcall:canto", cantoSobreposicao));
  sobreposicao.on("closed", () => (sobreposicao = null));
  sobreposicao.loadURL(`${baseUrl}/sobreposicao.html`);
}

function fecharSobreposicao() {
  if (sobreposicao && !sobreposicao.isDestroyed()) sobreposicao.close();
  sobreposicao = null;
}

function ligarAtalhosGlobais(ligar) {
  globalShortcut.unregister(ATALHO_MIC);
  globalShortcut.unregister(ATALHO_SOBREPOSICAO);
  if (!ligar) return { mic: false, sobreposicao: false };
  const mic = globalShortcut.register(ATALHO_MIC, () => win?.webContents.send("vcall:atalho", "mic"));
  const sob = globalShortcut.register(ATALHO_SOBREPOSICAO, () => {
    if (sobreposicao && !sobreposicao.isDestroyed()) {
      if (sobreposicao.isVisible()) sobreposicao.hide();
      else sobreposicao.showInactive();
    } else {
      abrirSobreposicao();
    }
  });
  return { mic, sobreposicao: sob };
}

ipcMain.handle("vcall:modo-jogo", (e, pedido) => {
  if (!win || e.sender !== win.webContents) return null;
  const ligar = !!pedido?.ligar;
  const canto = ["tl", "tr", "bl", "br"].includes(pedido?.canto) ? pedido.canto : "tl";
  if (ligar) abrirSobreposicao(canto);
  else fecharSobreposicao();
  return ligarAtalhosGlobais(ligar);
});

// Estado da chamada para a sobreposição desenhar. Só a janela da chamada
// fala por este canal, e só a sobreposição recebe.
ipcMain.on("vcall:sobreposicao-estado", (e, estado) => {
  if (!win || e.sender !== win.webContents) return;
  if (sobreposicao && !sobreposicao.isDestroyed()) sobreposicao.webContents.send("vcall:estado", estado);
});

/*
 * Atualização automática (desktop/atualizador.js). Só a página do próprio app
 * fala com este canal: uma sala de outra pessoa, aberta por convite, não
 * reinicia o seu Vcall.
 */
/*
 * A tela de erro (public/erro.html) pergunta se a sala de outra pessoa voltou
 * antes de abrir de novo — senão ela piscaria a cada tentativa. Só a página
 * do próprio app pode perguntar, e só por endereço https: ninguém usa o
 * processo principal para sondar a rede local.
 */
ipcMain.handle("vcall:sondar", async (e, alvo) => {
  let origem = "";
  try {
    origem = new URL(e.senderFrame?.url || "").origin;
  } catch {
    /* recusa abaixo */
  }
  if (origem !== baseUrl) throw new Error("origem não autorizada");
  let url;
  try {
    url = new URL(String(alvo));
  } catch {
    return 0;
  }
  if (url.protocol !== "https:") return 0;
  try {
    const r = await fetch(url.origin + "/healthz", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return r.status;
  } catch {
    return 0;
  }
});

ipcMain.handle("vcall:atualizacao", (e, acao) => {
  let origem = "";
  try {
    origem = new URL(e.senderFrame?.url || "").origin;
  } catch {
    /* sem origem: recusa abaixo */
  }
  if (origem !== baseUrl) throw new Error("origem não autorizada");
  if (acao === "verificar") return atualizador.verificar();
  if (acao === "instalar") return atualizador.instalar();
  return atualizador.estadoAtual();
});

/*
 * O kanban do GitHub no Planning Poker (desktop/github.js). Só a página do
 * próprio app usa o seu token: a sala de outra pessoa não lê nem grava nos
 * seus projetos.
 */
ipcMain.handle("vcall:github", (e, pedido) => {
  let origem = "";
  try {
    origem = new URL(e.senderFrame?.url || "").origin;
  } catch {
    /* sem origem: recusa abaixo */
  }
  if (origem !== baseUrl) return { erro: "O GitHub só conecta na sala aberta pelo seu próprio Vcall." };
  return github.pedir(String(pedido?.acao || ""), pedido?.dados);
});

ipcMain.handle("vcall:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
}));

/* ==================================================================== *
 * Permissões de mídia
 * ==================================================================== */

/*
 * Sem cache HTTP para o servidor local. A interface vem de 127.0.0.1, da
 * memória deste mesmo processo: guardar cópia em disco não economiza nada. E
 * custava caro — uma entrada corrompida (app fechado à força) fazia o servidor
 * responder "304, use a sua cópia" para uma cópia quebrada, e a página abria
 * sem uma folha de estilo: telas ocultas aparecendo e ícones gigantes.
 * (A opção `disable-http-cache` do Chromium é ignorada pelo Electron.)
 */
function semCache() {
  const ses = session.defaultSession;
  const filtro = { urls: [`${baseUrl}/*`] };
  ses.webRequest.onBeforeSendHeaders(filtro, ({ requestHeaders }, cb) => {
    delete requestHeaders["If-None-Match"];
    delete requestHeaders["If-Modified-Since"];
    cb({ requestHeaders });
  });
  ses.webRequest.onHeadersReceived(filtro, ({ responseHeaders }, cb) => {
    for (const k of Object.keys(responseHeaders)) if (k.toLowerCase() === "cache-control") delete responseHeaders[k];
    cb({
      responseHeaders: {
        ...responseHeaders,
        "Cache-Control": ["no-store"],
        /*
         * Isolamento de origem: libera o SharedArrayBuffer, e com ele o
         * Whisper (legendas) usa vários núcleos em vez de um — a legenda sai
         * em uma fração do tempo. `credentialless` em vez de `require-corp`:
         * nada de fora é carregado com credenciais, e nada do que já funciona
         * deixa de carregar por falta de um cabeçalho CORP.
         */
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Embedder-Policy": ["credentialless"],
      },
    });
  });
  // O que ficou guardado por versões anteriores também sai.
  return ses.clearCache().catch(() => {});
}

function permissoes() {
  const ses = session.defaultSession;
  const liberadas = new Set(["media", "display-capture", "clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen"]);

  // O padrão do Electron é conceder tudo a qualquer página; aqui, só à nossa
  // origem e às salas que o usuário abriu por convite.
  ses.setPermissionRequestHandler((contents, permissao, callback) => {
    callback(liberadas.has(permissao) && origemPermitida(contents.getURL()));
  });
  ses.setPermissionCheckHandler((_c, permissao, origem) => liberadas.has(permissao) && origemPermitida(origem));

  /*
   * Compartilhar tela.
   *
   * O que estava errado antes, e o que cada linha daqui resolve:
   *
   * 1. SÓ A TELA INTEIRA. O handler pegava sempre a primeira tela e ignorava
   *    o que a pessoa queria mostrar. (`useSystemPicker` só existe no macOS 15;
   *    no Windows e no Linux ele é ignorado em silêncio.) Agora a página
   *    mostra um seletor próprio, com miniaturas de telas E janelas
   *    (`vcall:fontes`), e avisa aqui qual foi a escolha (`vcall:escolher`).
   *
   * 2. LINUX SEM COMPARTILHAR. A resposta levava `audio: undefined`, e o
   *    Electron recusa a chave presente com valor vazio ("audio must be a
   *    WebFrameMain, loopback or loopbackWithMute"). O erro caía no catch, que
   *    chamava o callback de novo ("called more than once") — e a captura
   *    ficava pendurada para sempre. Agora a chave só existe quando tem valor,
   *    e o callback é chamado uma única vez, aconteça o que acontecer.
   *
   * 3. SOM NAS TRANSMISSÕES. O "loopback" do Windows captura TODO o som do
   *    computador, inclusive as vozes da própria chamada — quem estava do
   *    outro lado ouvia a si mesmo de volta. O som agora é opcional,
   *    desligado por padrão, e só vai quando a pessoa pede.
   */
  // Só a nossa página e as salas abertas por convite falam com estes canais.
  const doApp = (e) => origemPermitida(e.senderFrame?.url || "");

  // Sem miniaturas a lista sai em ~0,6 s; com elas, 3,5 a 4,5 s (medido no
  // Windows com 12 janelas). O seletor pede as duas e mostra a rápida antes.
  ipcMain.handle("vcall:fontes", async (e, { miniaturas = true } = {}) => {
    if (!doApp(e)) throw new Error("origem não autorizada");
    if (sessaoWayland()) return { portal: true, audio: somDoComputadorNaLista(process.platform), fontes: [] };
    const fontes = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: miniaturas ? { width: 320, height: 200 } : { width: 0, height: 0 },
      fetchWindowIcons: true,
    });
    return {
      portal: false,
      audio: somDoComputadorNaLista(process.platform),
      fontes: descreverFontes(fontes, { propria: win?.getMediaSourceId?.() }),
    };
  });

  /*
   * Legendas no app: o modelo de reconhecimento de fala (desktop/fala.js).
   * Baixado uma vez por idioma, com progresso, e entregue à página pelo
   * esquema vcall-fala:// — só arquivos desta pasta, só com nome válido.
   */
  const pastaFala = path.join(app.getPath("userData"), "fala");
  ses.protocol.handle(ESQUEMA_FALA, (req) => responderModelo(pastaFala, req.url));
  const preparando = new Map();
  ipcMain.handle("vcall:fala-preparar", async (e, lang) => {
    if (!doApp(e)) throw new Error("origem não autorizada");
    const idioma = MODELOS[lang] ? lang : "pt-BR";
    if (!preparando.has(idioma)) {
      const tarefa = prepararModelo({
        pasta: pastaFala,
        lang: idioma,
        baixar: (url) => net.fetch(url),
        progresso: (p) => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send("vcall:fala-progresso", { lang: idioma, p });
        },
      })
        .then(() => ({ url: `${ESQUEMA_FALA}://modelo/${idioma}.tar.gz`, lang: idioma }))
        .catch((err) => {
          registrar("modelo-fala-falhou", { lang: idioma, erro: String(err?.message || err) });
          throw err;
        })
        .finally(() => preparando.delete(idioma));
      preparando.set(idioma, tarefa);
    }
    return preparando.get(idioma);
  });

  /*
   * Whisper: o reconhecedor bom. Um download por tamanho de modelo, com
   * progresso; depois, só leitura do disco pelo esquema interno.
   */
  const preparandoWhisper = new Map();
  ipcMain.handle("vcall:whisper-preparar", async (e, nivel) => {
    if (!doApp(e)) throw new Error("origem não autorizada");
    const n = WHISPER[nivel] ? nivel : WHISPER_PADRAO;
    if (!preparandoWhisper.has(n)) {
      const tarefa = prepararWhisper({
        pasta: pastaFala,
        nivel: n,
        baixar: (url) => net.fetch(url),
        progresso: (p) => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send("vcall:fala-progresso", { whisper: n, p });
        },
      })
        .then((r) => ({ base: `${ESQUEMA_FALA}://modelo/whisper/`, modelo: r.repo, nivel: n, curto: r.curto, dtype: r.dtype, folgaS: r.folgaS }))
        .catch((err) => {
          registrar("whisper-falhou", { nivel: n, erro: String(err?.message || err) });
          throw err;
        })
        .finally(() => preparandoWhisper.delete(n));
      preparandoWhisper.set(n, tarefa);
    }
    return preparandoWhisper.get(n);
  });
  ipcMain.handle("vcall:whisper-descartar", async (e, nivel) => {
    if (!doApp(e)) return false;
    await descartarWhisper(pastaFala, WHISPER[nivel] ? nivel : WHISPER_PADRAO).catch(() => {});
    return true;
  });

  ipcMain.handle("vcall:fala-descartar", async (e, lang) => {
    if (!doApp(e)) return false;
    await unlink(path.join(pastaFala, nomeDoModelo(lang))).catch(() => {});
    return true;
  });

  let escolha = null;
  ipcMain.handle("vcall:escolher", (e, pedido) => {
    if (!doApp(e)) return false;
    escolha = pedido?.id ? { id: String(pedido.id), audio: !!pedido.audio, ate: Date.now() + 20_000 } : null;
    return true;
  });

  /*
   * 4. O APP CAÍA NO LINUX. Duas causas, tratadas em lugares diferentes:
   *    - fechar ou cancelar o seletor do sistema (portal) derrubava o processo
   *      inteiro: bug do Electron até a 34 (electron/electron#45198), corrigido
   *      ao subir a versão do Electron;
   *    - dois pedidos ao mesmo tempo abriam duas sessões do portal disputando o
   *      PipeWire. Agora é um pedido por vez, e o que chega no meio é recusado.
   */
  const vezDeCaptura = umPorVez();
  ses.setDisplayMediaRequestHandler(
    async (pedido, callback) => {
      semEconomiaDoWindows();
      let respondido = false;
      const vez = vezDeCaptura.pegar();
      let prazo = 0;
      const responder = (resposta) => {
        if (respondido) return;
        respondido = true;
        clearTimeout(prazo);
        if (vez !== null) vezDeCaptura.soltar(vez);
        try {
          callback(resposta);
        } catch (err) {
          registrar("captura-recusada", { erro: String(err?.message || err) });
        }
      };
      if (vez === null) {
        registrar("captura-em-andamento");
        responder({});
        return;
      }
      // Portal que nunca responde: recusa depois de um tempo, para a próxima
      // tentativa não ficar presa atrás desta.
      prazo = setTimeout(() => {
        registrar("captura-sem-resposta");
        responder({});
      }, 125_000);

      const atual = escolha && escolha.ate > Date.now() ? escolha : null;
      escolha = null;
      try {
        // No Wayland a própria chamada abre o portal do sistema, que devolve
        // só o que a pessoa escolheu lá.
        const fontes = await desktopCapturer.getSources({
          types: atual?.id?.startsWith("window:") || sessaoWayland() ? ["screen", "window"] : ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        responder(montarResposta({ fontes, escolha: atual, pedido, plataforma: process.platform }));
      } catch (err) {
        registrar("captura-falhou", { erro: String(err?.message || err) });
        responder({});
      }
    },
    { useSystemPicker: true },
  );
}

/* ==================================================================== *
 * Ciclo de vida
 * ==================================================================== */

if (!app.requestSingleInstanceLock()) {
  // Já existe um Vcall aberto: ele recebe o link (evento second-instance).
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const destino = destinoDoLink(linkDosArgumentos(argv));
    if (destino) abrirDestino(destino);
    else focar();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(ESQUEMA, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(ESQUEMA);
    }
    // Linux sem pacote instalado (AppImage, .tar.gz): o .desktop do usuário
    // é o que faz o link vcall:// dos convites abrir este app.
    const exeLinux = app.isPackaged ? executavelParaRegistrar() : null;
    if (exeLinux) {
      registrarEsquema(exeLinux, { icone: await readFile(ICON).catch(() => null) }).then((ok) =>
        registrar("esquema-linux", { ok, exe: exeLinux }),
      );
    }
    if (process.platform === "linux" && app.commandLine.hasSwitch("no-sandbox")) {
      registrar("sem-sandbox", { motivo: "sem user namespaces nem chrome-sandbox setuid (scripts/linux/vcall.sh)" });
    }

    try {
      baseUrl = await subirServidor();
    } catch (err) {
      dialog.showErrorBox("Não foi possível iniciar o Vcall", `Algo impediu o Vcall de abrir. Reinicie o computador e tente de novo.

Detalhe: ${err?.message || err}`);
      app.quit();
      return;
    }

    await semCache();
    permissoes();
    // Disponível na rede Tailscale desde que o app abre, se a pessoa pediu.
    if (lerPrefRede().sempre) ligarTailscale().catch(() => {});
    pendente = destinoDoLink(linkDosArgumentos(process.argv));
    criarJanela();
    atualizador.iniciar({ registrar });
  });

  // GPU, rede, áudio, captura: quando um processo auxiliar cai, o Chromium pode
  // levar o app junto ("GPU process isn't usable"). Fica o motivo no registro.
  app.on("child-process-gone", (_e, d) => {
    registrar("processo-caiu", { tipo: d.type, motivo: d.reason, codigo: d.exitCode, nome: d.name || d.serviceName || null });
  });

  // Com uma versão nova já baixada e conferida, fechar o Vcall é a hora de
  // instalar (Windows e AppImage) — sem interromper chamada nenhuma.
  app.on("window-all-closed", () => {
    if (!atualizador.aoFechar()) app.quit();
  });

  // O túnel é a parte exposta à internet: cai junto com o app, sempre. O link
  // do Tailscale também (e, mesmo que o app morra sem passar aqui, o
  // `tailscale serve` em primeiro plano se desfaz sozinho com o processo).
  app.on("before-quit", () => (tunnel?.stop(), linkTs?.stop({ silencioso: true }), sfu?.parar()));
  app.on("will-quit", () => globalShortcut.unregisterAll());
  process.on("exit", () => (tunnel?.stop(), linkTs?.stop({ silencioso: true }), sfu?.parar()));
}
