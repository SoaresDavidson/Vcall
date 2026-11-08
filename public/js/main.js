/**
 * main.js — a costura.
 *
 * Este arquivo não implementa nada: ele liga os módulos. Mídia, pares,
 * estatísticas e quadro vivem em `core/` e `features/`, sem saber que existe
 * uma tela; a UI vive em `ui/`, sem saber o que é um transceiver. Aqui os dois
 * lados se encontram.
 */
import { $, el, icon, on } from "./lib/dom.js";
import { env, formatDuration, isRoomId, newRoomId, prefs, throttle } from "./lib/util.js";

import { Signaling } from "./core/signaling.js";
import { LocalMedia, describeMediaError } from "./core/media.js";
import { ScreenShare, SCREEN_QUALITY, describeScreenError } from "./core/screen.js";
import { Mesh } from "./core/mesh.js";

import { Theme, duo } from "./ui/theme.js";
import { PALETAS } from "./ui/paletas.js";
import { Lobby } from "./ui/lobby.js";
import { Stage } from "./ui/stage.js";
import { Panel } from "./ui/panel.js";
import { Dock } from "./ui/dock.js";
import { Chuva, Combo, ComboRemoto, DO_ANTIGO, REACOES, Sinais, validar as validarReacao } from "./features/reacoes.js";
import { CamadaReacoes, montarMenu as montarMenuDeReacoes } from "./ui/reacoes.js";
import { toast, chime } from "./ui/toast.js";
import { avatarEl, colorFor, defaultAvatar, isPhoto, semCartum } from "./ui/avatars.js";
import { ilustracao } from "./ui/ilustracao.js";
import { montarTelaDeErro } from "./ui/tela-erro.js";
import { RemoteAudio } from "./ui/audio.js";
import { closeAudio } from "./core/audio-graph.js";
import { InfiniteCanvas } from "./features/canvas.js";
import { createBoardNotice } from "./features/board-notice.js";
import { Captions, captionsSupported, idiomaPadrao } from "./features/captions.js";
import { CallRecorder, canRecord } from "./features/recorder.js";
import { FileTransfer, MAX_FILE, formatSize } from "./features/transfer.js";
import { HostPanel } from "./features/host.js";
import { pedirPermissoes, revisarPermissoes } from "./ui/permissions.js";
import { escolherCompartilhamento } from "./ui/sharesheet.js";
import { profileSection } from "./ui/profile-editor.js";
import { Dashboard, copy, linkFor, modal } from "./ui/dashboard.js";
import { definirModoDoCodificador, modoDoCodificador, placaCodificaH264 } from "./core/tuning.js";
import { linkCurto, linkWhatsApp } from "./lib/invite.js";
import { installMotion, magnifyDock, playIntro, swap, stagger } from "./ui/motion.js";
import { MiniCall } from "./ui/minicall.js";
import { watchHandsFree } from "./ui/handsfree.js";
import { Daily, EstadoJogos, JOGOS, Poker, Retro, comArtigo, pedacosDoEstado } from "./features/jogos.js";
import { KanbanGithub } from "./features/github.js";
import { Codigo, Desenho, DuasVerdades, Mimica, QuemSouEu, Quiz, Roda, Stop } from "./features/festa.js";
import { Forca, Lig4, Memoria, Sorteios, Velha } from "./features/tabuleiro.js";
import { PainelJogos } from "./ui/jogos.js";
import { PonteQuizzV, linkDePareamento, linkDoQuizzv, qrSvg } from "./features/quizzv.js";
import { logoQuizzv, nomeQuizzv } from "./ui/quizzv-marca.js";

// Antes de qualquer tela ser montada: é ele que anima o que aparece.
installMotion();

/* ================================================================== *
 * Estado do aplicativo
 * ================================================================== */

const theme = new Theme();
const media = new LocalMedia();
const screen = new ScreenShare();
const signaling = new Signaling();
const mesh = new Mesh({ signaling, media, screen });

/**
 * Saída de áudio. Receber a trilha não produz som: ela precisa ser ligada a
 * uma saída, e é isto que faz.
 */
const audio = new RemoteAudio();

/** Legendas ao vivo, gravação local e anexos: recursos da chamada, não da mídia. */
const captions = new Captions({
  lang: idiomaPadrao(prefs.get("captions:lang", null)),
  nivel: prefs.get("captions:nivel", "equilibrada"),
});
document.documentElement.dataset.legenda = prefs.get("captions:tamanho", "m");
// O motor offline (app de mesa) ouve o MESMO microfone da chamada.
captions.micTrack = () => media.micTrack;
const recorder = new CallRecorder();
const transfer = new FileTransfer();

/** Controle do túnel. Inerte fora do aplicativo de mesa. */
const host = new HostPanel();

/** "Fulano está desenhando no canvas": uma vez por chamada, não a cada traço. */
const boardNotice = createBoardNotice();
const shouldAnnounceBoard = (op) => boardNotice.shouldAnnounce(op);

const app = {
  room: null,
  roomMeta: null,
  roomName: "",
  roomCode: "",
  roomPass: "",
  profile: null,
  joined: false,
  hand: false,
  boardMode: null, // null | "board" | "annotate"
  timerId: 0,
  startedAt: 0,
  maxPeers: 16,
  /** Avisos do sistema quando a aba está em segundo plano. */
  notify: prefs.get("notify", false),
};

let stage;
let panel;
let dock;
let board;

/* ================================================================== *
 * Início
 * ================================================================== */

mesh.vad.setThreshold(prefs.get("vad:threshold", 0.055));

theme.bindButton($("#themeBtn"));
theme.bindButton($("#themeBtn2"));

const hashRoom = location.hash.slice(1);
/*
 * `?criar=1#sala`: alguém, em outro computador da rede Tailscale, pediu para
 * criar uma chamada AQUI. A sala ainda não existe: em vez da antessala de
 * convidado, abre o "Criar nova call" (nome, quem vê) já com esse id.
 */
const criarAqui = new URLSearchParams(location.search).get("criar") === "1" && isRoomId(hashRoom);
if (criarAqui) history.replaceState(null, "", location.pathname);
const isGuest = isRoomId(hashRoom) && !criarAqui;
app.room = isRoomId(hashRoom) ? hashRoom : newRoomId();

const lobby = new Lobby({ media, theme, onJoin: enterCall });
let dashboard = null;

/**
 * Duas portas de entrada. Quem chega por link (ou pelo protocolo vcall:// do
 * aplicativo desktop) já sabe para onde vai e passa direto à antessala. Quem
 * abre o app sem destino vê primeiro o painel de chamadas ativas — criar uma
 * sala às cegas era a única opção antes, e não é a mais comum.
 */
/*
 * A tela de permissões vem antes de tudo, e só na primeira vez. Pedir câmera e
 * microfone no meio da entrada na sala — que é quando o navegador pergunta por
 * conta própria — faz a pessoa clicar em "Bloquear" por reflexo, e a chamada
 * começa muda sem explicação.
 */
// Depois da intro: a janela de permissões por cima da logo animada esconderia as duas.
const introPronta = new Promise((r) =>
  document.getElementById("intro") ? document.addEventListener("vcall:intro-done", r, { once: true }) : r(),
);
introPronta.then(pedirPermissoes).then((resultado) => {
  // Os nomes dos dispositivos ("Webcam HD da Logitech") só chegam depois de uma
  // permissão concedida; antes disso a lista vem com rótulos vazios. Reler
  // agora é o que faz a antessala mostrar os aparelhos pelo nome de verdade.
  if (resultado) media.enumerate();
});

if (isGuest) {
  showLobby({ isGuest: true });
} else {
  $("#lobby").hidden = true;
  dashboard = new Dashboard({
    onEnter: ({ roomId, pass, meta, roomName, isNew }) => {
      // No app de mesa a sala nova já nasce com o link público: o túnel sobe
      // enquanto a pessoa ajeita câmera e nome na antessala. Se falhar, o
      // Convidar mostra o erro e o botão de gerar outro, como antes.
      if (isNew && host.disponivel) host.abrirTunel().catch(() => {});
      app.room = roomId;
      app.roomPass = pass || "";
      app.roomMeta = meta || null;
      app.roomName = roomName || "";
      history.replaceState(null, "", `#${roomId}`);
      swap(() => {
        dashboard.hide();
        dashboard = null;
        showLobby({ isGuest: !meta });
      });
    },
    nome: app.profile?.name || "",
    theme,
    onSettings: () => openSettings({ naRecepcao: true }),
    irPara: irParaOutroComputador,
  });
  dashboard.mount($(".app"));
  if (criarAqui) dashboard.abrirCriar({ roomId: hashRoom });
}

/**
 * Ir para uma chamada (ou para o "criar") em OUTRO computador da rede.
 *
 * Cada lugar tem seu jeito: no app de mesa a janela só navega pelo próprio
 * app (que confere o endereço); no app do Android, um link vcall:// faz o app
 * abrir a chamada nele mesmo, em vez de jogar a pessoa no navegador; no
 * navegador comum, é só navegar.
 */
function irParaOutroComputador(url) {
  if (host.disponivel) {
    host.abrir(url).catch(() => location.assign(url));
    return;
  }
  if (document.documentElement.classList.contains("vcall-android")) {
    // O app do Android só repassa o endereço e a sala; o "?criar=1" se perde.
    // Para criar, ele vai à tela inicial do outro computador, onde está o botão.
    const u = new URL(url);
    const alvo = u.searchParams.get("criar") === "1" ? `${u.origin}/` : url;
    location.href = `vcall://join?u=${encodeURIComponent(alvo)}`;
    return;
  }
  location.assign(url);
}
playIntro();

function showLobby({ isGuest: guest }) {
  $("#lobby").hidden = false;
  lobby.mount(document, { isGuest: guest, sala: app.roomName, aprovar: !!app.roomMeta?.aprovar });
  stagger($("#lobby").querySelectorAll(".lobby__papel, .lobby__canhoto"), { delay: 60, gap: 90 });
}

if (!env.canShareScreen) {
  console.info("[vcall] este navegador não oferece captura de tela");
}

/* ================================================================== *
 * Entrar na chamada
 * ================================================================== */

/**
 * Conta ao app de mesa quem está neste computador, para os outros da rede
 * Tailscale verem o nome e o avatar. Foto não sai daqui: vai o avatar
 * desenhado de reserva.
 */
function contarPerfil() {
  if (!host.disponivel) return;
  const avatar = prefs.get("avatar", null);
  const desenho = isPhoto(avatar) ? { style: prefs.get("avatar:style", null), seed: prefs.get("avatar:seed", null) } : avatar;
  host.perfil(prefs.get("name", ""), desenho);
}

async function enterCall(profile) {
  app.profile = profile;
  app.joined = true;
  contarPerfil();

  if (location.hash.slice(1) !== app.room) {
    history.replaceState(null, "", `#${app.room}`);
  }

  await swap(() => {
    lobby.hide();
    // O brilho da marca é da antessala; dentro da chamada ele some.
    document.body.classList.add("na-chamada");
    $("#topbar").hidden = false;
    $("#stage").hidden = false;
    $("#dock").hidden = false;

    buildStage();
    buildPanel();
    buildDock();
    buildBoard();
    wireCaptions();
    wireRecorder();
    wireTransfer();
    bindShortcuts();
    startTimer();
  });
  stagger($("#dock").querySelectorAll(".ctrl"), { gap: 22, y: 18, blur: 0 });
  watchHandsFree(media);

  // O contexto de áudio só pode começar depois de um gesto do usuário — e
  // clicar em "entrar" é esse gesto.
  mesh.vad.resume();
  audio.resume();

  wireMesh();

  await mesh.join({
    room: app.room,
    profile,
    state: { mic: media.micEnabled, cam: media.camEnabled, screen: false, hand: false, board: false },
    meta: app.roomMeta,
    pass: app.roomPass,
  });
}

/* ================================================================== *
 * Palco
 * ================================================================== */

function buildStage() {
  stage = new Stage({
    root: $("#stage"),
    gridEl: $("#grid"),
    spotlightEl: $("#spotlight"),
    onPin: () => refreshBoardHost(),
  });

  const self = stage.ensure("self", "cam", {
    name: `${app.profile.name} (você)`,
    avatar: app.profile.avatar,
    self: true,
  });
  self.setCamera(media.camEnabled ? media.stream : null);
  self.setMic(media.micEnabled);
  self.setQuality("good");
  buildWaiting();

  media.on("change", () => {
    const tile = stage.get("self", "cam");
    if (!tile) return;
    tile.setCamera(media.camEnabled ? media.stream : null);
    tile.setMic(media.micEnabled);
    syncDockMedia();
  });
}

/**
 * Sala de espera: enquanto só você está na chamada, o palco mostra o código
 * da sala, os atalhos para convidar e alguém esperando ao lado de um
 * quadrinho vazio — em vez do seu próprio rosto em tela cheia, que é o que a
 * pessoa menos precisa ver. Some sozinha quando a primeira pessoa entra.
 */
function buildWaiting() {
  const code = el("span.waiting__code", { text: app.roomCode || "······" });
  const box = el("section.waiting", { id: "waiting", "aria-label": "Aguardando participantes", hidden: true }, [
    ilustracao("sala-vazia", { largura: 300, altura: 225 }),
    el("h2.waiting__title", {}, duo("Só você por aqui, por enquanto", "Sua reunião está pronta")),
    el("p.waiting__lead", {}, duo(
      "Mande o link ou dite o código. A chamada começa no instante em que alguém entrar.",
      "Compartilhe o link ou o código com quem vai participar.",
    )),
    el("button.waiting__codeBtn", {
      type: "button",
      "aria-label": "Copiar código da sala",
      onClick: () => copy(app.roomCode || "", "Código copiado"),
    }, [code, icon("copy", { size: "sm" })]),
    el("div.waiting__actions", {}, [
      el("button.btn.btn--primary.btn--lg", { type: "button", onClick: copiarLinkDaReuniao }, [
        icon("link"),
        el("span", {}, duo("Copiar link da sala", "Copiar link da reunião")),
      ]),
      el("button.btn.btn--lg", { type: "button", onClick: () => openInvite() }, [
        icon("user-plus"),
        el("span", { text: "Mais formas de convidar" }),
      ]),
    ]),
  ]);
  box._code = code;
  $("#stageMain").prepend(box);
}

function syncWaiting(alone) {
  const box = $("#waiting");
  if (!box) return;
  if (app.roomCode) box._code.textContent = app.roomCode;
  if (box.hidden === !alone) return;
  // A troca é uma reorganização de layout: a transição de tela explica que o
  // seu vídeo foi para o lado (ou voltou para a grade).
  swap(() => {
    box.hidden = !alone;
    $("#stage").classList.toggle("stage--alone", alone);
    stage?.relayout();
  });
  if (alone) stagger(box.querySelectorAll(".waiting__title, .waiting__lead, .waiting__codeBtn, .waiting__actions"), { delay: 120, gap: 60 });
}

/* ================================================================== *
 * Painel
 * ================================================================== */

function buildPanel() {
  panel = new Panel({
    onSend: (text) => {
      mesh.sendChat(text);
      panel.addMessage({
        id: mesh.selfId || "self",
        name: app.profile.name,
        avatar: app.profile.avatar,
        text,
        self: true,
      });
    },
    onClose: () => panel.setOpen(false),
    onFiles: (files) => sendFiles(files),
    // Clicar numa pessoa da lista: você mesmo abre o seu perfil; os outros
    // vão para o destaque (e clicar de novo tira).
    onPerson: (p) => {
      if (p.self) {
        openSettings();
        return;
      }
      const id = stage.tileId(p.id, "cam");
      if (stage.tiles.has(id)) stage.togglePin(id);
    },
    onChange: ({ open, tab, unread }) => {
      // A lista de pessoas só era desenhada quando alguém entrava ou saía:
      // abrir a aba numa sala estável mostrava um painel em branco. Agora ela
      // é desenhada ao abrir, com quem já está na sala.
      if (open && tab === "people" && panel) renderPeopleNow();
      if (open && tab === "stats" && panel) {
        panel.renderStats(mesh.stats.samples, mesh.roster(), { history: (id) => mesh.stats.historyFor(id) });
      }
      dock?.update("chat", { active: open && tab === "chat", badge: unread });
      dock?.update("people", { active: open && tab === "people" });
      dock?.update("stats", { active: open && tab === "stats" });
    },
  });
  $("#stage").append(panel.node);
  panel.animate = (fn) => (stage ? stage.animateChange(fn) : fn());

  // Transcrição ao vivo: o que já foi dito nesta chamada, e o que vier.
  for (const t of captions.transcript) panel.addTranscript(t);
  panel.setTranscriptActions([
    {
      iconName: "copy",
      label: "Copiar tudo",
      onClick: () => {
        const texto = captions.asText();
        if (!texto) return toast("Nada foi legendado nesta chamada ainda.", { tone: "info" });
        copy(texto, "Transcrição copiada");
      },
    },
    { iconName: "download", label: "Baixar (.txt)", onClick: () => baixarTranscricao("txt") },
    { iconName: "captions", label: "Baixar como legenda (.srt)", onClick: () => baixarTranscricao("srt") },
  ]);
}

/** Salva a transcrição: texto corrido (.txt) ou legenda para vídeo (.srt). */
function baixarTranscricao(formato = "txt") {
  const texto = formato === "srt" ? captions.asSrt() : captions.asText();
  if (!texto) {
    toast("Nada foi legendado nesta chamada ainda.", { tone: "info" });
    return;
  }
  const blob = new Blob([texto], { type: formato === "srt" ? "application/x-subrip" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const a = el("a", { href: url, download: `vcall-transcricao-${carimbo}.${formato}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ================================================================== *
 * Moderação (anfitrião)
 * ================================================================== */

/**
 * Tempo de fala de cada um, medido pelo mesmo detector de voz que acende o
 * contorno de quem fala. Fica só nesta tela: não trafega pela rede.
 */
const falas = new Map(); // id -> { total, desde }
function marcarFala(id, falando) {
  const f = falas.get(id) || { total: 0, desde: 0 };
  if (falando && !f.desde) f.desde = performance.now();
  if (!falando && f.desde) {
    f.total += performance.now() - f.desde;
    f.desde = 0;
  }
  falas.set(id, f);
}
function tempoDeFala(id) {
  const f = falas.get(id);
  if (!f) return 0;
  return f.total + (f.desde ? performance.now() - f.desde : 0);
}

/** Desenha a lista de pessoas, com os controles de anfitrião quando cabe. */
function renderPeopleNow(lista = mesh.roster()) {
  const roster = lista.map((p) => ({ ...p, falaMs: tempoDeFala(p.id) }));
  const mod = mesh.isHost
    ? {
        onLowerHand: (p) => mesh.moderate("lower-hand", p.id),
        closed: !!mesh.roomInfo?.closed,
        onMute: (p) => {
          mesh.moderate("mute", p.id);
          toast(`Pedido enviado: ${p.name} foi silenciado`, { tone: "ok", ms: 2200, key: "mod" });
        },
        onCamOff: (p) => {
          mesh.moderate("cam-off", p.id);
          toast(`Câmera de ${p.name} desligada`, { tone: "ok", ms: 2200, key: "mod" });
        },
        onKick: (p) => confirmKick(p),
        onMuteAll: () => {
          mesh.moderate("mute-all");
          toast("Todos foram silenciados", { tone: "ok", ms: 2200, key: "mod" });
        },
        onLock: (fechar) => mesh.moderate(fechar ? "lock" : "unlock"),
        banned: mesh.banned,
        onUnban: (b) => mesh.moderate("unban", b.id),
      }
    : null;
  panel.renderPeople(roster, mod);
}

/** Remover alguém é definitivo nesta sala: pede confirmação antes. */
function confirmKick(p) {
  const dlg = el("dialog.modal");
  const remover = el("button.btn.btn--danger", { type: "button" }, [icon("user-x", { size: "sm" }), el("span", { text: "Remover" })]);
  const cancelar = el("button.btn.btn--ghost", { type: "button", text: "Cancelar" });
  dlg.append(
    el("div.modal__card", {}, [
      el("div.modal__head", {}, [el("h2.modal__title", { text: `Remover ${p.name || "participante"}?` })]),
      el("div.modal__body", {}, [
        el("p.muted", {
          text: "A pessoa sai da chamada na hora e não consegue voltar pelo mesmo aparelho — até você deixar, em Pessoas → Removidos.",
        }),
        el("div.row", { style: { justifyContent: "flex-end", gap: "var(--sp-2)" } }, [cancelar, remover]),
      ]),
    ]),
  );
  const fechar = () => (dlg.close(), dlg.remove());
  cancelar.addEventListener("click", fechar);
  dlg.addEventListener("close", () => dlg.remove());
  remover.addEventListener("click", () => {
    mesh.moderate("kick", p.id);
    fechar();
  });
  document.body.append(dlg);
  dlg.showModal();
  cancelar.focus();
}

function wireModeration() {
  mesh.on("moderated", (m) => {
    const por = m.by || "O anfitrião";
    if (m.action === "mute") {
      if (media.micEnabled) {
        media.setMic(false);
        syncDockMedia();
      }
      toast(`${por} silenciou o seu microfone. Ligue de novo quando quiser falar.`, {
        tone: "info",
        ms: 5000,
        key: "mod-mute",
      });
    } else if (m.action === "cam-off") {
      if (media.camEnabled) media.setCam(false).then(syncDockMedia);
      toast(`${por} desligou a sua câmera.`, { tone: "info", ms: 5000, key: "mod-cam" });
    } else if (m.action === "lower-hand") {
      if (app.hand) toggleHand();
      toast(`${por} baixou a sua mão.`, { tone: "info", ms: 3000, key: "mod-hand" });
    } else if (m.action === "kick") {
      leaveCall({ motivo: "kicked", por });
    } else if (m.action === "kicked") {
      panel.addSystem(`${m.name || "Alguém"} foi removido da sala por ${por}`);
    }
  });

  mesh.on("banned", ({ list, readmitted }) => {
    if (readmitted) {
      toast(`${readmitted} pode voltar: é só abrir o link da sala de novo`, { tone: "ok", ms: 4000, key: "unban" });
    } else if (mesh.isHost && list.length) {
      // Recém-removido: um "desfazer" na hora, para o clique errado.
      const ultimo = [...list].sort((a, b) => b.at - a.at)[0];
      if (ultimo && Date.now() - ultimo.at < 5000) {
        toast(`${ultimo.name || "A pessoa"} foi removido da sala`, {
          tone: "info",
          ms: 6000,
          key: "kick-undo",
          action: { label: "Deixar voltar", onClick: () => mesh.moderate("unban", ultimo.id) },
        });
      }
    }
    if (panel.open && panel.tab === "people") renderPeopleNow();
  });

  mesh.on("room-closed", ({ closed, by }) => {
    toast(closed ? `${by || "O anfitrião"} trancou a sala: ninguém novo entra` : `${by || "O anfitrião"} destrancou a sala`, {
      tone: "info",
      ms: 3500,
      key: "room-closed",
    });
    if (panel.open && panel.tab === "people") renderPeopleNow();
  });

  mesh.on("host", ({ self }) => {
    if (self) toast("Você é o anfitrião desta sala", { tone: "ok", ms: 2600, key: "host" });
    if (panel.open && panel.tab === "people") renderPeopleNow();
  });

  mesh.on("speaking", ({ id, speaking }) => marcarFala(id, speaking));

  /* -- sala de espera: quem espera -- */
  mesh.on("waiting", (m) => mostrarEspera(true, m?.name || app.roomName));
  mesh.on("joined", () => mostrarEspera(false));

  /* -- sala de espera: o anfitrião decide -- */
  mesh.on("knock", (k) => {
    mostrarBatida(k);
    chime("join");
    notify("Alguém quer entrar", `${k.name} está na sala de espera`);
  });
  mesh.on("knock-gone", ({ id }) => {
    const card = document.querySelector(`.knock[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add("is-leaving");
    setTimeout(() => card.remove(), 200);
  });
}

/* ================================================================== *
 * Foco na voz e modo jogo
 * ================================================================== */

/** Quem está falando agora (ids do mesh, inclusive o próprio). */
const falandoAgora = new Set();

/**
 * Foco na voz: quem está calado fica apagadinho e quem fala acende — como o
 * overlay do Discord, dentro da própria chamada. Vale para qualquer um, no
 * navegador ou no app. Tecla G.
 */
function setFocoVoz(on) {
  app.focoVoz = !!on;
  prefs.set("foco-voz", app.focoVoz);
  $("#stage")?.classList.toggle("stage--foco", app.focoVoz);
  return app.focoVoz;
}

/** Monta e manda à sobreposição (app de mesa) o retrato da sala. */
const enviarSobreposicao = throttle(() => {
  if (!app.modoJogo || !window.vcallDesktop?.estadoSobreposicao || !mesh.selfId) return;
  const pessoas = mesh.roster().map((p) => ({
    id: p.id,
    nome: p.name || "Convidado",
    avatar: p.avatar || null,
    falando: falandoAgora.has(p.id),
    mudo: !p.state?.mic,
    eu: !!p.self,
  }));
  window.vcallDesktop.estadoSobreposicao({ pessoas });
}, 80);

/**
 * Modo jogo (app de mesa): a sobreposição transparente por cima do jogo e os
 * atalhos globais Ctrl+Shift+M (microfone) e Ctrl+Shift+O (sobreposição).
 */
async function setModoJogo(on, { avisar = true } = {}) {
  const desktop = window.vcallDesktop;
  if (!desktop?.modoJogo) return false;
  app.modoJogo = !!on;
  prefs.set("modo-jogo", app.modoJogo);
  const r = await desktop.modoJogo(app.modoJogo, prefs.get("modo-jogo:canto", "tl")).catch(() => null);
  if (app.modoJogo) {
    // A janela nova precisa do retrato completo logo de cara.
    setTimeout(() => enviarSobreposicao(), 400);
    setTimeout(() => enviarSobreposicao(), 1200);
    if (avisar) {
      const semAtalho = r && (!r.mic || !r.sobreposicao);
      toast(
        semAtalho
          ? "Modo jogo ligado. Algum programa já usa Ctrl+Shift+M ou O — os atalhos globais não foram registrados."
          : "Modo jogo ligado · Ctrl+Shift+M liga/desliga o microfone e Ctrl+Shift+O mostra/esconde a sobreposição, mesmo dentro do jogo.",
        { tone: semAtalho ? "warn" : "ok", ms: 6500, key: "modo-jogo" },
      );
    }
  } else if (avisar) {
    toast("Modo jogo desligado", { tone: "info", ms: 2000, key: "modo-jogo" });
  }
  return app.modoJogo;
}

/**
 * Janela escondida (minimizada, outra aba, jogo em tela cheia) por mais de
 * alguns segundos: os outros param de mandar câmera para cá. Voz e tela
 * continuam. Com a mini-janela aberta a pessoa ainda está assistindo: nada muda.
 */
function wireEconomia() {
  let timer = 0;
  const avaliar = () => {
    clearTimeout(timer);
    const assistindo = !document.hidden || !!app.mini?.open;
    if (assistindo) mesh.verVideo(true);
    else timer = setTimeout(() => mesh.verVideo(!!app.mini?.open), 5000);
  };
  document.addEventListener("visibilitychange", avaliar);
  avaliar();
}

function wireModoJogo() {
  setFocoVoz(prefs.get("foco-voz", false));

  mesh.on("speaking", ({ id, speaking }) => {
    if (speaking) falandoAgora.add(id);
    else falandoAgora.delete(id);
    enviarSobreposicao();
  });
  mesh.on("roster", () => enviarSobreposicao());
  mesh.on("self-state", () => enviarSobreposicao());
  mesh.on("peer-removed", ({ id }) => falandoAgora.delete(id));

  const desktop = window.vcallDesktop;
  if (!desktop?.modoJogo) return;
  mesh.on("joined", ({ reconnected }) => {
    if (!reconnected && prefs.get("modo-jogo", false)) setModoJogo(true, { avisar: false });
  });
  desktop.aoAtalho?.((acao) => {
    if (acao !== "mic" || !app.joined || app.left) return;
    media.toggleMic();
    syncDockMedia();
    toast(media.micEnabled ? "Microfone ligado" : "Microfone mudo", { tone: "info", ms: 1200, key: "atalho-mic" });
  });
}

/** A fila: quem pediu para entrar espera aqui, por cima do palco, até ser aceito. */
function mostrarEspera(on, sala = "") {
  let tela = $(".waitRoom");
  if (!on) {
    tela?.remove();
    return;
  }
  if (tela) return;
  tela = el("div.waitRoom", { role: "status", "aria-live": "polite" }, [
    el("div.waitRoom__card", {}, [
      el("span.waitRoom__marca", {}, [el("img", { src: "/assets/logo-mark.png", alt: "", width: 22, height: 22 }), el("span", { text: "Vcall" })]),
      el("h2", { text: "Pedindo para entrar" }),
      sala ? el("p.waitRoom__sala", { text: `Sala “${sala}”` }) : null,
      el("p", { text: "Quem está na sala já sabe que você chegou. Assim que aceitarem, você entra." }),
      el("div.waitRoom__pulse", { "aria-hidden": "true" }, [el("i"), el("i"), el("i")]),
      el("button.btn.btn--ghost", { type: "button", onClick: () => leaveCall() }, [icon("log-out", { size: "sm" }), el("span", { text: "Desistir" })]),
    ]),
  ]);
  document.body.append(tela);
}

/** Cartão "Fulano quer entrar" para o anfitrião, com as duas respostas. */
function mostrarBatida(k) {
  let pilha = $(".knocks");
  if (!pilha) {
    pilha = el("div.knocks", { "aria-live": "polite" });
    document.body.append(pilha);
  }
  if (pilha.querySelector(`[data-id="${CSS.escape(k.id)}"]`)) return;
  const responder = (acao) => {
    mesh.moderate(acao, k.id);
    card.classList.add("is-leaving");
    setTimeout(() => card.remove(), 200);
  };
  const card = el("div.knock", { dataset: { id: k.id }, role: "alertdialog", "aria-label": `${k.name} quer entrar` }, [
    avatarEl(k.avatar, { title: k.name }),
    el("div.knock__texto", {}, [el("strong.truncate", { text: k.name || "Convidado" }), el("span", { text: "quer entrar na sala" })]),
    el("div.knock__acoes", {}, [
      el("button.btn.btn--ghost", { type: "button", onClick: () => responder("deny") }, [el("span", { text: "Recusar" })]),
      el("button.btn.btn--primary", { type: "button", onClick: () => responder("admit") }, [el("span", { text: "Deixar entrar" })]),
    ]),
  ]);
  pilha.append(card);
}

/* ================================================================== *
 * Arquivos na conversa
 * ================================================================== */

async function sendFiles(files) {
  for (const f of files) {
    if (f.size > MAX_FILE) {
      toast(`“${f.name}” tem ${formatSize(f.size)} — o limite por arquivo é ${formatSize(MAX_FILE)}.`, {
        tone: "warn",
        ms: 6000,
      });
      continue;
    }
    if (!mesh.peers.size) {
      toast("Não há mais ninguém na sala para receber o arquivo.", { tone: "warn" });
      return;
    }
    const sent = await transfer.send(f);
    if (!sent) continue;
    const { envio, ...arquivo } = sent;
    panel.addFile({
      id: mesh.selfId || "self",
      name: app.profile.name,
      avatar: app.profile.avatar,
      file: arquivo,
      self: true,
    });
    panel.setFileProgress(arquivo.id, 0.02);
    // O próximo arquivo espera este terminar: dois ao mesmo tempo só dividem
    // a mesma rede e deixam os dois mais lentos.
    const { falhou } = await envio;
    panel.setFileProgress(arquivo.id, 1);
    if (falhou.length) {
      const nomes = falhou.map((id) => mesh.profiles.get(id)?.name || "um participante").join(", ");
      toast(`“${arquivo.name}” não chegou para ${nomes} — a conexão direta caiu no meio. Tente de novo.`, {
        tone: "warn",
        ms: 7000,
      });
    }
  }
}

function wireTransfer() {
  // O arquivo segue o mesmo caminho das imagens do canvas: canal de carga
  // pesada, fatiado, com espera de buffer entre os pedaços.
  // `sender` espera cada pedaço sair antes do próximo (fila por participante).
  transfer.sender = (payload) => mesh.broadcastBlob(payload);

  transfer.on("start", ({ id, from, meta }) => {
    const profile = mesh.profiles.get(from) || {};
    panel.addFile({
      id: from,
      name: profile.name || "Alguém",
      avatar: profile.avatar,
      file: { ...meta, url: "", mime: meta.mime },
      at: meta.at,
    });
    panel.setFileProgress(id, 0.02);
  });

  transfer.on("progress", ({ id, sent, total }) => {
    panel.setFileProgress(id, Math.max(0.02, sent / total));
  });

  transfer.on("file", (file) => {
    // O cartão já está na conversa desde o "file-begin"; agora ele ganha o
    // endereço do arquivo pronto e a barra de progresso sai.
    panel.completeFile(file.id, file.url, file.blob);
    const who = mesh.profiles.get(file.from)?.name || "Alguém";
    notify(`${who} enviou um arquivo`, file.name);
    if (!panel.open || panel.tab !== "chat") {
      toast(`${who} enviou “${file.name}”`, {
        tone: "info",
        key: "file",
        action: { label: "Abrir", onClick: () => panel.setOpen(true, "chat") },
      });
    }
  });

  transfer.on("error", ({ reason, file }) => {
    toast(
      reason === "too-large"
        ? `“${file?.name || "O arquivo"}” passa do limite de ${formatSize(MAX_FILE)}.`
        : "Um arquivo chegou corrompido.",
      { tone: "warn" },
    );
  });

  mesh.on("peer-removed", ({ id }) => transfer.forget(id));
}

/* ================================================================== *
 * Controles
 * ================================================================== */

function buildDock() {
  dock = new Dock($("#dock"));

  const g1 = dock.group();
  dock.add(g1, {
    id: "mic",
    icon: "mic",
    label: "Microfone",
    shortcut: "M",
    kind: "toggle",
    on: media.micEnabled,
    onClick: () => {
      media.toggleMic();
      syncDockMedia();
    },
  });
  dock.add(g1, {
    id: "cam",
    icon: "video",
    label: "Câmera",
    shortcut: "V",
    kind: "toggle",
    on: media.camEnabled,
    onClick: async () => {
      await media.toggleCam();
      syncDockMedia();
    },
  });

  dock.add(g1, {
    id: "deafen",
    icon: "volume-2",
    label: "Silenciar tudo",
    shortcut: "D",
    kind: "toggle",
    // "on" = ouvindo. Começava em false, e o botão nascia vermelho como se o
    // som estivesse cortado — toggleDeafen() já usa esta mesma convenção.
    on: true,
    onClick: () => toggleDeafen(),
  });

  const g2 = dock.group();
  if (env.canShareScreen) {
    dock.add(g2, {
      id: "screen",
      icon: "screen-share",
      label: "Compartilhar tela",
      shortcut: "S",
      onClick: () => toggleScreen(),
    });
    dock.add(g2, {
      id: "screenOpts",
      icon: "chevron-down",
      label: "Opções de compartilhamento",
      className: "ctrl--slim",
      onClick: () => openScreenMenu(),
    });
    dock.get("screenOpts").style.width = "30px";
  }

  dock.add(g2, {
    id: "board",
    icon: "pencil",
    label: "Quadro branco",
    shortcut: "Q",
    onClick: () => openBoardMenu(),
  });
  dock.add(g2, {
    id: "jogos",
    icon: "dices",
    label: "Jogos",
    shortcut: "K",
    onClick: () => abrirMenuJogos(),
  });

  const g3 = dock.group();
  dock.add(g3, {
    id: "hand",
    icon: "hand",
    label: "Levantar a mão",
    shortcut: "H",
    onClick: () => toggleHand(),
  });
  dock.add(g3, {
    id: "react",
    icon: "smile",
    label: "Reagir",
    shortcut: "R",
    onClick: () => openReactionMenu(),
  });
  dock.add(g3, {
    id: "captions",
    icon: "eye-off",
    label: "Legendar minha fala",
    shortcut: "T",
    onClick: () => toggleCaptions(),
  });
  if (canRecord) {
    dock.add(g3, {
      id: "record",
      icon: "radio",
      label: "Gravar a chamada",
      onClick: () => toggleRecording(),
    });
  }

  const g4 = dock.group();
  dock.add(g4, {
    id: "chat",
    icon: "message-square",
    label: "Conversa",
    shortcut: "C",
    onClick: () => panel.toggle("chat"),
  });
  dock.add(g4, {
    id: "people",
    icon: "users",
    label: "Pessoas",
    shortcut: "P",
    onClick: () => panel.toggle("people"),
  });
  dock.add(g4, {
    id: "stats",
    icon: "activity",
    label: "Qualidade da chamada",
    onClick: () => panel.toggle("stats"),
  });
  dock.add(g4, {
    id: "layout",
    icon: "layout-grid",
    label: "Alternar layout",
    shortcut: "L",
    onClick: () => {
      const next = stage.setLayout(stage.layout === "auto" ? "grid" : "auto");
      dock.update("layout", {
        iconName: next === "grid" ? "layout-grid" : "presentation",
        label: next === "grid" ? "Grade igualitária" : "Destaque automático",
      });
      toast(next === "grid" ? "Todos no mesmo tamanho" : "Destaque automático ligado", { tone: "info", ms: 1800 });
    },
  });
  dock.add(g4, {
    id: "settings",
    icon: "settings",
    label: "Configurações",
    onClick: () => openSettings(),
  });
  // Só aparece em telas estreitas (ver app.css): reúne o que não cabe na barra.
  dock.add(g4, {
    id: "more",
    icon: "more-vertical",
    label: "Mais opções",
    onClick: () => openMoreMenu(),
  });

  const g5 = dock.group();
  if (MiniCall.supported) {
    const mini = (app.mini = new MiniCall({
      stage,
      state: () => ({ mic: media.micEnabled, cam: media.camEnabled }),
      press: (id) => dock.get(id)?.click(),
      title: () => (app.roomName ? `Vcall · ${app.roomName}` : "Vcall"),
    }));
    mini.onClose = () => dock.update("mini", { active: false });
    dock.add(g5, {
      id: "mini",
      icon: "picture-in-picture-2",
      label: "Mini-janela flutuante",
      shortcut: "J",
      onClick: async () => {
        try {
          await mini.toggle();
          dock.update("mini", { active: mini.open });
        } catch {
          toast("Não foi possível abrir a mini-janela agora.", { tone: "warn" });
        }
      },
    });
  }
  dock.add(g5, {
    id: "leave",
    icon: "phone-off",
    label: "Sair da chamada",
    className: "ctrl--hangup",
    onClick: () => leaveCall(),
  });

  syncDockMedia();
  magnifyDock(dock.node);
}

function openMoreMenu() {
  dock.openPopover("more", (pop, close) => {
    const item = (iconName, label, fn, checked = null) =>
      pop.append(Dock.item({ iconName, label, checked, onClick: () => (close(), fn()) }));

    // No celular a barra guarda só cinco botões: o que ela esconde
    // precisa reaparecer aqui, senão fica inalcançável.
    if (matchMedia("(max-width: 820px)").matches) {
      item(
        "pencil",
        app.boardMode ? "Fechar o quadro" : "Quadro branco",
        () => (app.boardMode ? closeBoard() : openBoard("board")),
        !!app.boardMode,
      );
      item(
        audio.deafened ? "volume-x" : "volume-2",
        audio.deafened ? "Voltar a ouvir" : "Silenciar tudo",
        toggleDeafen,
        audio.deafened,
      );
      pop.append(el("div.popover__sep"));
    }
    item("hand", app.hand ? "Baixar a mão" : "Levantar a mão", toggleHand, app.hand);
    item("eye", "Foco na voz · G", () => setFocoVoz(!app.focoVoz), !!app.focoVoz);
    item("captions", "Transcrição ao vivo", () => panel.setOpen(true, "transcript"));
    item("dices", jogos?.aberto ? "Fechar os jogos · K" : "Jogos · K", () => (jogos?.aberto ? fecharJogos() : abrirJogos()), !!jogos?.aberto);
    if (window.vcallDesktop?.modoJogo) item("zap", "Modo jogo (sobreposição)", () => setModoJogo(!app.modoJogo), !!app.modoJogo);
    item("smile", "Reagir", () => {
      // Reabre como menu de reações, ancorado no mesmo botão.
      setTimeout(() => openReactionMenu("more"), 0);
    });
    item("eye", captions.enabled ? "Parar de legendar" : "Legendar minha fala", toggleCaptions, captions.enabled);
    if (canRecord) {
      item("radio", recorder.recording ? "Parar a gravação" : "Gravar a chamada", toggleRecording, recorder.recording);
    }
    pop.append(el("div.popover__sep"));
    item("users", "Pessoas", () => panel.setOpen(true, "people"));
    item("activity", "Qualidade da chamada", () => panel.setOpen(true, "stats"));
    item("layout-grid", "Alternar layout", () => dock.get("layout")?.click());
    if (env.canShareScreen) item("monitor", "Opções de compartilhamento", () => openScreenMenu("more"));
    pop.append(el("div.popover__sep"));
    item("circle-help", "Atalhos do teclado", openShortcuts);
    item("settings", "Configurações", () => openSettings());
  });
}

/* ================================================================== *
 * Folha de atalhos
 *
 * Um app de chamada tem atalho para quase tudo e ninguém decora nenhum. A
 * lista sai daqui e não de um texto no README porque é aqui que ela é
 * procurada — no meio da reunião.
 * ================================================================== */

const SHORTCUTS = [
  ["Chamada", [
    ["M", "Ligar e desligar o microfone"],
    ["Espaço", "Falar enquanto segura (com o microfone mudo)"],
    ["V", "Ligar e desligar a câmera"],
    ["S", "Compartilhar a tela"],
    ["D", "Silenciar todo mundo para você"],
    ["H", "Levantar e baixar a mão"],
    ["R", "Reagir (com o menu aberto, 1 a 9 reagem direto)"],
    ["T", "Legendar sua fala"],
  ]],
  ["Tela e painéis", [
    ["C", "Conversa"],
    ["P", "Pessoas"],
    ["L", "Alternar o layout"],
    ["J", "Mini-janela flutuante, por cima dos outros programas"],
    ["G", "Foco na voz: apagar quem está calado"],
    ["Ctrl+Shift+M", "Microfone, mesmo dentro de um jogo (app, modo jogo)"],
    ["Ctrl+Shift+O", "Mostrar/esconder a sobreposição (app, modo jogo)"],
    ["Q", "Abrir e fechar o canvas"],
    ["K", "Jogos: festa, tabuleiro, sorteios e os de equipe (Planning Poker, Retro, Daily)"],
    ["?", "Esta lista"],
    ["Esc", "Fechar o que estiver aberto"],
  ]],
  ["Canvas", [
    ["1 – 0", "Escolher a ferramenta"],
    ["N", "Nota adesiva"],
    ["I", "Conta-gotas"],
    ["G", "Preencher formas"],
    ["X", "Encaixar na malha"],
    ["F", "Enquadrar tudo"],
    ["Espaço", "Arrastar o plano"],
    ["Ctrl + roda", "Zoom"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Desfazer e refazer"],
    ["Ctrl+C / V / D", "Copiar, colar, duplicar"],
    ["Ctrl+A", "Selecionar tudo"],
    ["Setas", "Empurrar a seleção (Shift: dez vezes mais)"],
    ["[ e ]", "Mandar para trás, trazer à frente"],
    ["Shift ao desenhar", "Travar quadrado, círculo e 45°"],
  ]],
];

function openShortcuts() {
  const body = $("#settingsBody");
  body.replaceChildren();
  $("#settingsTitle").textContent = "Atalhos do teclado";

  for (const [title, rows] of SHORTCUTS) {
    body.append(
      el("div.stack", {}, [
        el("h3", { text: title, style: { fontSize: "var(--text-md)" } }),
        el(
          "div.keysheet",
          {},
          rows.map(([key, what]) =>
            el("div.keysheet__row", {}, [
              el("kbd.keysheet__key", { text: key }),
              el("span", { text: what }),
            ]),
          ),
        ),
      ]),
    );
  }
  // -- atualizacao --
  if (host.disponivel) section("Atualizações", [blocoDeAtualizacao()]);

  $("#settingsModal").showModal();
  animarEntradaDoDialogo($("#settingsModal"));
}

/**
 * A entrada do diálogo.
 *
 * `showModal()` não dispara animação de entrada sozinho quando o diálogo já
 * existe no documento — o navegador só troca o estado. Reaplicar a animação
 * à mão é o que faz a segunda abertura parecer com a primeira.
 */
function animarEntradaDoDialogo(dialogo) {
  const card = dialogo?.querySelector(".modal__card");
  if (!card || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  card.style.animation = "none";
  // Força o navegador a recalcular antes de devolver a animação.
  void card.offsetWidth;
  card.style.animation = "";
}

/** Três barrinhas de voz, para qualquer espera do app. */
export function carga(texto = "") {
  const barras = el("span.carga", { "aria-hidden": "true" }, [el("i"), el("i"), el("i"), el("i")]);
  if (!texto) return barras;
  return el("div.cargaTela", { role: "status", "aria-live": "polite" }, [
    barras,
    el("span.cargaTela__texto", { text: texto }),
  ]);
}

/** A fileira de botões claro / escuro / sistema, com o rótulo. */
function themeRowDeConfiguracoes() {
  const linha = el("div.row.temaLinha", { role: "group", "aria-label": "Tema" });
  for (const [mode, label, iconName] of [
    ["system", "Sistema", "laptop"],
    ["light", "Claro", "sun"],
    ["dark", "Escuro", "moon"],
  ]) {
    const b = el("button.btn", {
      type: "button",
      class: theme.mode === mode ? "btn--primary" : "",
      onClick: () => {
        theme.set(mode);
        for (const outro of linha.children) outro.classList.remove("btn--primary");
        b.classList.add("btn--primary");
      },
    });
    b.append(icon(iconName, { size: "sm" }), el("span", { text: label }));
    linha.append(b);
  }
  return el("div.stack", {}, [el("div.field__label", { text: "Tema" }), linha]);
}

/**
 * Os botões de paleta.
 *
 * Cada botão MOSTRA a paleta em vez de nomeá-la: três faixas com o fundo, a
 * superfície e o acento daquela escolha. Uma lista de nomes — "Tinta",
 * "Ametista", "Carvão" — obrigaria a escolher no escuro e trocar cinco vezes
 * até achar a certa.
 *
 * A troca é imediata e sem recarregar: o CSS inteiro pende de um único
 * atributo no <html>.
 */
function seletorDePaletas() {
  const grade = el("div.paletaGrade", { role: "radiogroup", "aria-label": "Paleta de cores" });

  for (const p of PALETAS) {
    const botao = el("button.paletaOpcao", {
      type: "button",
      role: "radio",
      "aria-checked": String(theme.paleta === p.id),
      "data-paleta-amostra": p.id,
      title: p.descricao,
      onClick: () => {
        theme.setPaleta(p.id);
        for (const outro of grade.children) {
          outro.setAttribute("aria-checked", String(outro.dataset.paletaAmostra === p.id));
        }
        toast(`Paleta ${p.nome}`, { tone: "ok", ms: 1600, key: "paleta" });
      },
    });
    botao.append(
      el("span.paletaOpcao__amostra", { "aria-hidden": "true" }, [
        el("i.paletaOpcao__fundo"),
        el("i.paletaOpcao__superficie"),
        el("i.paletaOpcao__acento"),
      ]),
      el("span.paletaOpcao__nome", { text: p.nome }),
    );
    grade.append(botao);
  }

  return el("div.stack", {}, [
    el("div.field__label", { text: "Paleta" }),
    grade,
    el("div.field__hint", { text: "A paleta vale nos dois visuais, com o tema claro ou o escuro." }),
  ]);
}

/**
 * O visual: a cara do Vcall ou a de programa de empresa.
 *
 * Como as paletas, cada opção mostra o que é em vez de só nomear: uma
 * miniatura da forma (cantos, títulos, botão) desenhada com as cores da
 * paleta ligada, que vale para os dois visuais.
 */
function seletorDeVisual() {
  const grade = el("div.visualGrade", { role: "radiogroup", "aria-label": "Visual" });
  const opcoes = [
    ["vcall", "Vcall", "Expressivo, com o ingresso e o anel de quem fala."],
    ["empresa", "Empresa", "Sóbrio, para reuniões de trabalho."],
  ];
  for (const [id, nome, descricao] of opcoes) {
    const botao = el("button.visualOpcao", {
      type: "button",
      role: "radio",
      "aria-checked": String(theme.visual === id),
      dataset: { visualAmostra: id },
      onClick: () => {
        theme.setVisual(id);
        for (const outro of grade.children) {
          outro.setAttribute("aria-checked", String(outro.dataset.visualAmostra === id));
        }
        toast(`Visual ${nome}`, { tone: "ok", ms: 1600, key: "visual" });
      },
    });
    botao.append(
      el("span.visualOpcao__amostra", { "aria-hidden": "true" }, [
        el("i.visualOpcao__barra"),
        el("i.visualOpcao__titulo"),
        el("i.visualOpcao__linha"),
        el("i.visualOpcao__botao"),
      ]),
      el("span.visualOpcao__texto", {}, [
        el("strong", { text: nome }),
        el("small", { text: descricao }),
      ]),
    );
    grade.append(botao);
  }
  return el("div.stack", {}, [el("div.field__label", { text: "Visual" }), grade]);
}

/**
 * Aviso discreto de versão nova, uma vez por abertura.
 *
 * Deliberadamente sem ação automática e sem janela modal: quem abriu o
 * programa quer entrar numa chamada, não fazer manutenção. No app que se
 * atualiza sozinho, o aviso só vem quando a versão nova já está baixada e
 * conferida — e diz quando ela entra. Onde ele só sabe avisar, aponta as
 * configurações.
 */
function avisarDeAtualizacao() {
  const api = window.vcallDesktop?.atualizacao;
  if (api) {
    let avisada = null;
    api.aoMudar((s) => {
      if (!s?.versao || avisada === s.versao) return;
      if (s.fase === "pronta") {
        avisada = s.versao;
        const texto =
          s.modo === "sozinho"
            ? `Versão ${s.versao} baixada. Ela é instalada quando você fechar o Vcall.`
            : `Versão ${s.versao} baixada. Instale em Configurações › Atualizações.`;
        toast(texto, { tone: "info", ms: 10000, key: "atualizacao" });
      } else if (s.fase === "aviso") {
        avisada = s.versao;
        toast(`Versão ${s.versao} disponível — veja em Configurações › Atualizações.`, { tone: "info", ms: 9000, key: "atualizacao" });
      }
    });
    return;
  }
  setTimeout(async () => {
    try {
      const r = await host.atualizacao();
      if (!r?.tem) return;
      toast(`Versão ${r.versao} disponível — veja em Configurações › Atualizações.`, {
        tone: "info",
        ms: 9000,
      });
    } catch {
      /* sem internet ou GitHub fora do ar: não é assunto de quem vai ligar */
    }
  }, 6000);
}

/**
 * O bloco "Atualizações" das configurações.
 *
 * Só aparece dentro do executável: no navegador comum quem atualiza a página
 * é o próprio servidor, e um botão de atualizar programa não teria o que
 * fazer. No app que se atualiza sozinho ele mostra o andamento (procurando,
 * baixando, conferindo a assinatura, pronta) e oferece reiniciar na hora.
 */
/**
 * "Rede Tailscale" nas configurações do app de mesa: deixar este computador
 * sempre disponível na rede (o link do Tailscale sobe sozinho ao abrir o
 * Vcall), para o celular e os outros computadores criarem chamadas aqui.
 */
function blocoDaRede() {
  const caixa = el("input", { type: "checkbox", "aria-describedby": "redeDica" });
  const dica = el("div.field__hint", { id: "redeDica", text: "Conferindo o Tailscale…" });
  const endereco = el("input.input.mono", { type: "text", readonly: true, hidden: true, "aria-label": "Endereço deste computador na rede" });
  const copiar = el("button.btn", { type: "button", hidden: true, onClick: () => copy(endereco.value, "Endereço copiado") }, [
    icon("copy", { size: "sm" }),
    el("span", { text: "Copiar" }),
  ]);
  const bloco = el("div.stack", {}, [
    el("label.row", {}, [
      caixa,
      el("div", {}, [
        el("div", { text: "Deixar este computador disponível na minha rede Tailscale" }),
        el("div.field__hint", { text: "O link do Tailscale sobe sozinho ao abrir o Vcall. Assim dá para criar chamadas aqui pelo celular, a qualquer hora." }),
      ]),
    ]),
    el("div.row", {}, [endereco, copiar]),
    dica,
  ]);

  const pintar = () => {
    const c = host.tsConferido;
    const pronto = host.ts.estado === "pronto" && host.ts.url;
    endereco.hidden = copiar.hidden = !pronto;
    if (pronto) endereco.value = `${host.ts.url}/`;
    caixa.disabled = !!c && !c.instalado;
    dica.textContent = !c
      ? "Conferindo o Tailscale…"
      : !c.instalado || !c.pronto
        ? c.mensagem || "O Tailscale não está pronto neste computador."
        : pronto
          ? "No celular, com o Tailscale ligado, abra este endereço no app do Vcall (ou no navegador) e toque em “Criar nova call”."
          : caixa.checked
            ? "Ligando o link do Tailscale…"
            : "Desligado: o celular só entra quando você gerar o link no Convidar.";
  };
  caixa.addEventListener("change", async () => {
    caixa.disabled = true;
    try {
      await host.configRede(caixa.checked);
      // O link leva alguns segundos para subir (e o certificado, na 1ª vez).
      if (caixa.checked) {
        let n = 0;
        const t = setInterval(() => {
          if (!bloco.isConnected || host.ts.estado === "pronto" || ++n > 40) return clearInterval(t);
          host.status().catch(() => {});
        }, 1500);
      }
    } catch {
      toast("Não consegui mudar a opção agora.", { tone: "warn" });
    }
    caixa.disabled = false;
    pintar();
  });
  host.configRede().then((r) => ((caixa.checked = !!r?.sempre), pintar())).catch(() => {});
  host.conferirTailscale().then(pintar);
  const ouvir = () => (bloco.isConnected ? pintar() : host.off?.("status", ouvir));
  host.on("status", ouvir);
  pintar();
  return bloco;
}

/**
 * "Servidor TURN" nas configurações do app de mesa. Sem ele, quem está atrás
 * de 4G com CGNAT, Wi-Fi de empresa ou faculdade às vezes não conecta. No app
 * instalado não há .env: a escolha fica guardada aqui (desktop/turn.js) e
 * vale para todos que entram nas chamadas deste computador.
 */
function blocoDoTurn() {
  const tipo = el("select.input", { "aria-label": "Servidor de apoio" }, [
    el("option", { value: "nenhum", text: "Nenhum (o normal para quase todo mundo)" }),
    el("option", { value: "api", text: "Link de um provedor (Metered, Xirsys…)" }),
    el("option", { value: "segredo", text: "Servidor próprio, com segredo (coturn)" }),
    el("option", { value: "fixo", text: "Servidor próprio, com usuário e senha" }),
  ]);
  const url = el("input.input.mono", { type: "url", placeholder: "https://SEUAPP.metered.live/api/v1/turn/credentials?apiKey=…", "aria-label": "Link do provedor" });
  const urls = el("input.input.mono", { type: "text", placeholder: "turn:turn.exemplo.com:3478, turns:turn.exemplo.com:5349?transport=tcp", "aria-label": "Endereços do servidor" });
  const usuario = el("input.input", { type: "text", placeholder: "Usuário", "aria-label": "Usuário", autocomplete: "off" });
  const senha = el("input.input", { type: "password", placeholder: "Senha", "aria-label": "Senha", autocomplete: "new-password" });
  const segredo = el("input.input", { type: "password", placeholder: "Segredo (static-auth-secret)", "aria-label": "Segredo", autocomplete: "new-password" });
  const salvar = el("button.btn.btn--primary", { type: "button", text: "Salvar" });
  const testar = el("button.btn", { type: "button", text: "Testar" });
  const dica = el("div.field__hint", { text: "Para quem não consegue conectar em redes de empresa, faculdade ou de algumas operadoras de 4G: a chamada passa por um servidor de apoio (TURN) só quando a conexão direta não dá, e continua criptografada. Se você não sabe o que é, deixe em “Nenhum”." });
  const linhas = {
    api: el("div.stack", {}, [url]),
    segredo: el("div.stack", {}, [urls, segredo]),
    fixo: el("div.stack", {}, [usuario, senha]),
  };
  const bloco = el("div.stack", { "data-turn": "" }, [tipo, linhas.api, linhas.segredo, linhas.fixo, el("div.row", {}, [salvar, testar]), dica]);

  let salvo = { tipo: "nenhum" };
  const mostrar = () => {
    const t = tipo.value;
    linhas.api.hidden = t !== "api";
    linhas.segredo.hidden = t !== "segredo" && t !== "fixo";
    segredo.hidden = t !== "segredo";
    linhas.fixo.hidden = t !== "fixo";
    // Os endereços servem aos dois modos com servidor próprio: ficam no mesmo lugar.
    if (t === "fixo") linhas.segredo.after(linhas.fixo);
    testar.disabled = t === "nenhum";
  };
  const preencher = (v) => {
    salvo = v || { tipo: "nenhum" };
    tipo.value = salvo.tipo;
    urls.value = (salvo.urls || []).join(", ");
    usuario.value = salvo.usuario || "";
    url.placeholder = salvo.host ? `Salvo: ${salvo.host} (cole outro link para trocar)` : url.placeholder;
    senha.placeholder = salvo.temSegredo && salvo.tipo === "fixo" ? "Senha salva (deixe vazio para manter)" : "Senha";
    segredo.placeholder = salvo.temSegredo && salvo.tipo === "segredo" ? "Segredo salvo (deixe vazio para manter)" : "Segredo (static-auth-secret)";
    mostrar();
  };
  tipo.addEventListener("change", mostrar);
  salvar.addEventListener("click", async () => {
    salvar.disabled = true;
    try {
      const v = await host.configTurn({
        tipo: tipo.value,
        url: url.value.trim(),
        urls: urls.value.trim(),
        usuario: usuario.value.trim(),
        senha: senha.value,
        segredo: segredo.value,
      });
      url.value = senha.value = segredo.value = "";
      preencher(v);
      toast(v.tipo === "nenhum" ? "Servidor de apoio desligado." : "Servidor de apoio salvo. Vale a partir da próxima chamada.", { tone: "ok" });
    } catch (err) {
      toast(err.message || "Não consegui salvar.", { tone: "warn" });
    }
    salvar.disabled = false;
  });
  testar.addEventListener("click", async () => {
    testar.disabled = true;
    dica.textContent = "Testando o servidor…";
    const r = await testarTurn();
    dica.textContent = r.ok
      ? `Funcionando: o servidor respondeu em ${r.ms} ms (${r.endereco}).`
      : r.motivo;
    testar.disabled = false;
  });
  host.configTurn().then(preencher).catch(() => (dica.textContent = "Não consegui ler esta configuração."));
  mostrar();
  return bloco;
}

/**
 * "Transmissão" nas configurações: por onde a tela e a câmera são codificadas
 * (tuning.MODOS_CODIFICADOR). No navegador só dá para escolher o codec leve;
 * placa e processador são opções do app de mesa, que valem ao reabrir
 * (desktop/webrtc.opcoesDoCodificador).
 *
 * "Placa de vídeo" numa máquina em que o Windows não mostra o codificador da
 * placa com o sandbox da GPU ligado: o Vcall avisa do risco e só abre sem a
 * proteção se a pessoa confirmar. Escolher outro modo religa a proteção.
 */
function blocoDoCodificador() {
  const opcoes = [
    ["auto", "Automático (recomendado)"],
    ...(host.disponivel ? [["gpu", "Placa de vídeo"], ["cpu", "Processador"]] : []),
    ["leve", "Leve (VP8, para PC fraco)"],
  ];
  const sel = el("select.input", { "aria-label": "Codificar a transmissão pelo" }, opcoes.map(([value, text]) => el("option", { value, text })));
  const dica = el("div.field__hint");
  const reabrir = el("button.btn", { type: "button", text: "Reabrir o Vcall agora", hidden: true });
  const bloco = el("div.stack", { "data-codificador": "" }, [el("div.field__label", { text: "Codificar a transmissão pelo" }), sel, dica, reabrir]);
  const textos = {
    auto: "O Vcall escolhe: a placa de vídeo quando ela codifica, senão o processador.",
    gpu: "Pelo codificador da placa de vídeo (Quick Sync, NVENC ou AMF, o que o Windows oferecer): o jogo pode ocupar o processador sem a transmissão engasgar.",
    cpu: "Tudo pelo processador, em VP9: mais nítido por bit, mas disputa o processador com o jogo.",
    leve: "VP8 em até 720p, o mais leve para o processador. Para PC fraco.",
  };
  let estado = null;
  const pintar = () => {
    const extra = [];
    if (estado?.semSandboxAgora) extra.push("A proteção (sandbox) da placa de vídeo está desligada.");
    extra.push(estado?.reiniciar ? "Vale depois de reabrir o Vcall." : "Vale a partir da próxima transmissão.");
    dica.textContent = [textos[sel.value], ...extra].join(" ");
    reabrir.hidden = !estado?.reiniciar;
  };
  const avisarSandbox = () =>
    new Promise((resolve) => {
      let sim = false;
      modal({
        title: "Usar a placa de vídeo",
        body: [
          el("p", { text: "Neste computador, o Windows só libera o codificador da placa de vídeo para o Vcall com o sandbox da GPU desligado." }),
          el("p.muted", { text: "O sandbox é uma proteção do Chromium, o motor do Vcall: se uma página maliciosa explorar uma falha da placa de vídeo, ele impede que ela saia do app. Sem ele, o risco é maior. Para religar, volte a codificação para Automático ou Processador." }),
        ],
        confirm: "Desligar a proteção e usar a placa",
        onConfirm: () => (sim = true),
        onClose: () => resolve(sim),
      });
    });
  sel.addEventListener("change", async () => {
    const modo = sel.value;
    const antes = modoDoCodificador();
    if (!host.disponivel) {
      definirModoDoCodificador(modo);
      return pintar();
    }
    sel.disabled = true;
    try {
      // Sem o sandbox agora, a placa codifica *por causa* disso: continua sem.
      let semSandbox = !!estado?.semSandboxAgora;
      if (modo === "gpu" && !semSandbox && !(await placaCodificaH264())) {
        semSandbox = await avisarSandbox();
        if (!semSandbox) {
          sel.value = antes;
          return pintar();
        }
      }
      estado = await host.configCodificador({ modo, semSandbox: modo === "gpu" && semSandbox ? "1" : "0" });
      definirModoDoCodificador(modo);
      pintar();
    } catch (err) {
      sel.value = antes;
      toast(err.message || "Não consegui mudar a opção agora.", { tone: "warn" });
    } finally {
      sel.disabled = false;
    }
  });
  reabrir.addEventListener("click", async () => {
    if (mesh.peers.size && !window.confirm("Reabrir o Vcall agora tira você desta chamada. Reabrir mesmo assim?")) return;
    reabrir.disabled = true;
    await host.reiniciar().catch(() => (reabrir.disabled = false));
  });
  sel.value = modoDoCodificador();
  if (host.disponivel) {
    host
      .configCodificador()
      .then((r) => {
        estado = r;
        sel.value = r.modo;
        definirModoDoCodificador(r.modo);
        pintar();
      })
      .catch(pintar);
  }
  pintar();
  return bloco;
}

/**
 * Testa o TURN que está valendo agora (o que o /ice entrega): pede um
 * candidato "relay" de verdade. Se ele vem, o servidor autenticou e alocou um
 * caminho de repasse — é o que uma chamada vai usar quando precisar.
 */
async function testarTurn({ limiteMs = 8000 } = {}) {
  let cfg;
  try {
    cfg = await (await fetch("/ice", { cache: "no-store" })).json();
  } catch {
    return { ok: false, motivo: "Não consegui ler a configuração de conexão." };
  }
  const servidores = (cfg.iceServers || []).filter((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));
  if (!servidores.length) return { ok: false, motivo: "Nenhum servidor de apoio está valendo. Salve antes de testar (ou confira o link do provedor)." };
  const inicio = performance.now();
  const pc = new RTCPeerConnection({ iceServers: servidores, iceTransportPolicy: "relay" });
  try {
    pc.createDataChannel("teste");
    const achou = new Promise((resolve) => {
      pc.addEventListener("icecandidate", ({ candidate }) => {
        if (candidate?.type === "relay" || / typ relay /.test(candidate?.candidate || "")) resolve(candidate);
        if (!candidate) resolve(null);
      });
      setTimeout(() => resolve(null), limiteMs);
    });
    await pc.setLocalDescription(await pc.createOffer());
    const c = await achou;
    if (!c) return { ok: false, motivo: "O servidor não respondeu. Confira o endereço, a senha ou o segredo, e se as portas dele estão liberadas (3478, 5349 e 49152–65535/UDP)." };
    return { ok: true, endereco: c.address || c.candidate.split(" ")[4], ms: Math.round(performance.now() - inicio) };
  } finally {
    pc.close();
  }
}

function blocoDeAtualizacao() {
  const api = window.vcallDesktop?.atualizacao;
  if (!api) return blocoDeAtualizacaoSoAviso();

  const estado = el("div.field__hint", { text: "Conferindo…" });
  const barra = el("progress", { max: 100, value: 0, hidden: true, style: { width: "100%" } });
  const verificar = el("button.btn", { type: "button", text: "Verificar agora" });
  const instalar = el("button.btn.btn--primary", { type: "button", text: "Reiniciar e atualizar", hidden: true });
  const baixar = el("a.btn", { target: "_blank", rel: "noopener noreferrer", text: "Baixar pelo site", hidden: true });

  let bloco = null;
  let visto = false;
  let parar = null;
  const pintar = (s) => {
    // Fechou as configurações: o próximo aviso desliga a escuta.
    if (bloco?.isConnected) visto = true;
    else if (visto) return parar?.();
    if (!s) return;
    barra.hidden = s.fase !== "baixando";
    barra.value = s.progresso || 0;
    instalar.hidden = s.fase !== "pronta";
    baixar.hidden = !(s.fase === "aviso" || s.fase === "erro");
    if (s.url) baixar.href = s.url;
    verificar.disabled = ["procurando", "baixando", "conferindo"].includes(s.fase);
    const textos = {
      parado: `Versão instalada: ${s.atual}.`,
      procurando: "Procurando atualizações…",
      baixando: `Baixando a versão ${s.versao}… ${s.progresso || 0}%`,
      conferindo: `Conferindo a assinatura da versão ${s.versao}…`,
      pronta:
        s.modo === "sozinho"
          ? `Versão ${s.versao} pronta. Ela é instalada quando você fechar o Vcall — ou agora, reiniciando.`
          : `Versão ${s.versao} pronta. Ao reiniciar, o Vcall fecha, o sistema pede a sua senha para instalar e o Vcall abre de novo na versão nova.`,
      atual: `Você está na versão mais recente (${s.atual}).`,
      aviso: `Versão ${s.versao} disponível. Você está na ${s.atual}. Esta instalação não se atualiza sozinha: baixe pelo site.`,
      erro: `Não deu para atualizar agora (${s.erro}). Versão instalada: ${s.atual}.`,
    };
    estado.textContent = textos[s.fase] || textos.parado;
  };

  parar = api.aoMudar(pintar);
  api.estado().then(pintar).catch(() => {});
  verificar.addEventListener("click", () => api.verificar().then(pintar).catch(() => {}));
  instalar.addEventListener("click", () => {
    instalar.disabled = true;
    api.instalar().catch(() => (instalar.disabled = false));
  });

  bloco = el("div.stack", {}, [estado, barra, el("div.row", {}, [verificar, instalar, baixar])]);
  return bloco;
}

/** Versão antiga do bloco: só confere e aponta a página de download. */
function blocoDeAtualizacaoSoAviso() {
  const estado = el("div.field__hint", { text: "Conferindo…" });
  const notas = el("div.field__hint", { style: { opacity: "0.7" } });
  const baixar = el("a.btn.btn--primary", {
    target: "_blank",
    rel: "noopener noreferrer",
    text: "Baixar a nova versão",
    hidden: true,
  });
  const botao = el("button.btn", { type: "button", text: "Verificar agora" });

  const pintar = (r) => {
    notas.textContent = "";
    baixar.hidden = true;
    if (r?.erro) {
      estado.textContent = `Não deu para conferir agora. Confira a internet e tente de novo. Versão instalada: ${r.atual}.`;
      return;
    }
    if (r?.tem) {
      estado.textContent = `Versão ${r.versao} disponível. Você está na ${r.atual}.`;
      baixar.href = r.url;
      baixar.hidden = false;
      // As notas do GitHub vêm em Markdown; como texto puro já informam.
      if (r.notas) notas.textContent = r.notas.replace(/<[^>]*>/g, " ").slice(0, 300);
      return;
    }
    estado.textContent = `Você está na versão mais recente (${r?.atual || "?"}).`;
  };

  const conferir = async (forcar) => {
    botao.disabled = true;
    estado.textContent = forcar ? "Conferindo…" : "Conferindo…";
    try {
      pintar(await host.atualizacao({ forcar }));
    } catch (err) {
      estado.textContent = "Não deu para conferir agora. Confira a internet e tente de novo.";
    } finally {
      botao.disabled = false;
    }
  };

  botao.addEventListener("click", () => conferir(true));
  conferir(false);

  return el("div.stack", {}, [estado, notas, el("div.row", {}, [botao, baixar])]);
}

/**
 * Modo surdo: corta a saída de áudio de todos os participantes de uma vez.
 *
 * É diferente de baixar o volume geral: ao desligar, cada pessoa volta ao
 * volume individual que tinha. E é diferente de mutar o próprio microfone —
 * por isso, quando a pessoa fica surda, o microfone também é desligado: falar
 * sem ouvir a resposta é a pior das duas situações, e é o que todo aplicativo
 * de chamada faz neste caso.
 */
function toggleDeafen() {
  const deaf = audio.toggleDeafen();
  dock.update("deafen", {
    on: !deaf,
    active: deaf,
    iconName: deaf ? "volume-x" : "volume-2",
    label: deaf ? "Voltar a ouvir" : "Silenciar tudo",
  });
  if (deaf && media.micEnabled) {
    app.micBeforeDeafen = true;
    media.setMic(false);
    syncDockMedia();
  } else if (!deaf && app.micBeforeDeafen) {
    app.micBeforeDeafen = false;
    media.setMic(true);
    syncDockMedia();
  }
  toast(
    deaf
      ? "Você não está ouvindo ninguém (e seu microfone foi desligado)"
      : "Áudio de volta",
    { tone: "info", ms: 2400, key: "deafen" },
  );
}

/** Instala o controle de volume num ladrilho remoto. */
function addVolumeTo(tile, peerId, name) {
  if (!tile || tile.self || tile.volumeEl) return;
  // Mutar aqui é local: só este computador para de ouvir essa pessoa; os
  // outros participantes continuam escutando-a normalmente.
  tile.addVolume({
    name,
    value: audio.volumeFor(peerId),
    onChange: (v) => audio.setVolume(peerId, v),
    onToggle: () => {
      const v = audio.toggleMute(peerId);
      toast(
        v === 0 ? `${name} silenciado só para você` : `${name} audível de novo`,
        { tone: "info", ms: 2000, key: `mute-${peerId}` },
      );
    },
  });
}

function syncDockMedia() {
  dock?.update("mic", {
    on: media.micEnabled,
    iconName: media.micEnabled ? "mic" : "mic-off",
    label: media.micEnabled ? "Microfone ligado" : "Microfone mudo",
  });
  dock?.update("cam", {
    on: media.camEnabled,
    iconName: media.camEnabled ? "video" : "video-off",
    label: media.camEnabled ? "Câmera ligada" : "Câmera desligada",
  });
  if (mesh.selfId) mesh.publishState();
}

/* ================================================================== *
 * Compartilhamento de tela
 * ================================================================== */

async function toggleScreen(opts = {}) {
  if (screen.active) {
    screen.stop("user");
    return;
  }

  /*
   * O painel próprio vem primeiro; a janela do navegador vem depois e é
   * obrigatória — nenhuma página consegue listar as suas janelas ou escolher
   * uma sozinha. O que o painel faz é decidir COMO perguntar: a escolha de
   * tela/janela/aba vira a preferência `displaySurface`, e o seletor do
   * navegador já abre na aba certa em vez de a pessoa ter que procurar.
   */
  // No app de mesa a lista de telas e janelas é nossa (desktop/main.js).
  const desktop = window.vcallDesktop?.fontes ? window.vcallDesktop : null;
  const escolha = opts.pular ? null : await escolherCompartilhamento({ podeAudio: true, desktop });
  if (!opts.pular && !escolha) return; // desistiu no painel

  try {
    // Avisa o processo principal do que foi escolhido ANTES de pedir a
    // captura: é ele quem responde ao getDisplayMedia no app de mesa.
    if (desktop && escolha) await desktop.escolherFonte(escolha.fonte || "", escolha.withAudio);
    await screen.start({
      quality: escolha?.quality || prefs.get("screen:quality", "auto"),
      mode: escolha?.mode || screen.mode,
      modoFixo: !!escolha?.modoFixo,
      // Sem painel (atalho direto), sem som: o som só vai quando pedido.
      withAudio: escolha ? escolha.withAudio : false,
      surface: escolha?.surface || null,
      ...opts,
    });
  } catch (err) {
    // Falhar ao compartilhar nunca tira ninguém da chamada: só avisa.
    if (err?.name !== "NotAllowedError") toast(describeScreenError(err), { tone: "warn" });
  }
}

/**
 * Troca o que está sendo mostrado — outra janela, outra tela, com ou sem som —
 * sem parar a transmissão: quem assiste continua no mesmo ladrilho.
 */
async function trocarFonte() {
  if (!screen.active) return toggleScreen();
  const desktop = window.vcallDesktop?.fontes ? window.vcallDesktop : null;
  const escolha = await escolherCompartilhamento({ podeAudio: true, desktop, trocando: true });
  if (!escolha) return;
  try {
    if (desktop) await desktop.escolherFonte(escolha.fonte || "", escolha.withAudio);
    await screen.switchSource({
      quality: escolha.quality || screen.quality,
      mode: escolha.mode || screen.mode,
      modoFixo: !!escolha.modoFixo,
      withAudio: escolha.withAudio,
      surface: escolha.surface || null,
    });
  } catch (err) {
    if (err?.name !== "NotAllowedError") toast(describeScreenError(err), { tone: "warn" });
  }
}

function openScreenMenu(ownerId = "screenOpts") {
  dock.openPopover(ownerId, (pop, close) => {
    pop.append(el("div.popover__label", { text: "Qualidade" }));
    const current = prefs.get("screen:quality", "auto");
    for (const [id, q] of Object.entries(SCREEN_QUALITY)) {
      pop.append(
        Dock.item({
          iconName: "monitor",
          label: q.label,
          checked: current === id,
          onClick: async () => {
            prefs.set("screen:quality", id);
            if (screen.active) await screen.setQuality(id);
            close();
            toast(`Qualidade: ${q.label}`, { tone: "info", ms: 1600 });
          },
        }),
      );
    }

    pop.append(el("div.popover__sep"), el("div.popover__label", { text: "O que você está mostrando" }));
    for (const [mode, label, iconName] of [
      ["text", "Texto, código ou slides", "type"],
      ["motion", "Vídeo ou animação", "zap"],
    ]) {
      pop.append(
        Dock.item({
          iconName,
          label,
          checked: screen.mode === mode,
          onClick: () => {
            screen.setMode(mode);
            close();
            toast(
              mode === "text"
                ? "Priorizando nitidez: a imagem para de perder detalhe quando a rede aperta"
                : "Priorizando fluidez: a imagem fica menor antes de engasgar",
              { tone: "info", ms: 3200 },
            );
          },
        }),
      );
    }

    if (screen.active) {
      pop.append(
        el("div.popover__sep"),
        Dock.item({
          iconName: "refresh-cw",
          label: "Trocar o que estou mostrando…",
          onClick: () => {
            close();
            trocarFonte();
          },
        }),
        Dock.item({
          iconName: "screen-share-off",
          label: "Parar de compartilhar",
          onClick: () => {
            screen.stop("user");
            close();
          },
        }),
      );
    }
  });
}

screen.on("start", () => {
  dock?.update("screen", {
    active: true,
    iconName: "screen-share-off",
    label: "Parar de compartilhar",
  });

  const tile = stage.ensure("self", "screen", {
    name: `Sua tela`,
    avatar: app.profile.avatar,
    self: true,
  });
  tile.setStream(screen.stream);
  tile.setMic(true);
  tile.setQuality("good");
  if (!tile.botaoTrocar) {
    tile.botaoTrocar = tile.addAction({ iconName: "refresh-cw", label: "Trocar o que estou mostrando", onClick: () => trocarFonte() });
  }
  // Tela inteira: nada de prévia ao vivo (efeito espelho). Janela: a prévia
  // fica, porque não tem como a janela conter a chamada.
  const superficie = screen.videoTrack?.getSettings?.().displaySurface || screen.surface;
  tile.setPresenting(superficie === "monitor");
  stage.relayout();

  const s = screen.settings;
  const detail = s?.width ? `${s.width}×${s.height} a ${Math.round(s.frameRate || 0)} fps` : "";
  toast(`Compartilhando sua tela${detail ? ` · ${detail}` : ""}`, { tone: "ok" });

  // Só avisa sobre o som quando a pessoa pediu som e ele não veio.
  if (screen.wantedAudio && !screen.audioTrack) {
    toast(
      window.vcallDesktop
        ? "O som do computador não foi capturado: não achei a saída de som neste sistema. A tela vai sem som."
        : "O som não foi capturado. No Chrome, marque “Compartilhar áudio” na janela de seleção; no Firefox e no Safari isso ainda não existe.",
      { tone: "info", ms: 6000, key: "screen-audio" },
    );
  }
});

screen.on("fluidez-auto", () => {
  toast("A imagem está em movimento: passei para Fluidez, para não engasgar. Dá para voltar à Nitidez no menu da tela.", { tone: "info", ms: 5000 });
});

screen.on("switch", () => {
  const tile = stage.get("self", "screen");
  if (tile) {
    tile.setStream(screen.stream);
    const superficie = screen.videoTrack?.getSettings?.().displaySurface || screen.surface;
    tile.setPresenting(superficie === "monitor");
  }
  const s = screen.settings;
  const detalhe = s?.width ? ` · ${s.width}×${s.height}` : "";
  toast(`Transmissão trocada, sem interromper${detalhe}`, { tone: "ok", ms: 2600, key: "screen-switch" });
});

screen.on("stop", ({ reason }) => {
  dock?.update("screen", { active: false, iconName: "screen-share", label: "Compartilhar tela" });
  stage.remove("self", "screen");
  if (app.boardMode === "annotate") closeBoard();
  if (reason === "browser") toast("Compartilhamento encerrado", { tone: "info", ms: 2000 });
});

screen.on("surface", (s) => {
  // A resolução mudou no meio do caminho (o usuário trocou de janela). O teto
  // do encoder já foi reavaliado em core/screen.js; aqui só se atualiza a
  // prévia. Sem aviso na tela: ele disparava logo no começo de todo
  // compartilhamento e era só mais uma notificação pulando.
  const tile = stage.get("self", "screen");
  if (tile) tile.setPresenting((s.displaySurface || screen.surface) === "monitor");
});

screen.on("error", (err) => {
  if (err?.name !== "NotAllowedError") toast(describeScreenError(err), { tone: "warn" });
});

/* ================================================================== *
 * Quadro branco
 * ================================================================== */

function buildBoard() {
  board = new InfiniteCanvas({
    selfId: mesh.selfId || "self",
    selfName: app.profile.name,
    getRoster: () => mesh.roster(),
  });

  board.on("op", (op) => mesh.broadcastBoard(op));
  board.on("cursor", (payload) => mesh.broadcastCursor(payload));
  // Imagens vão pelo canal de carga pesada, fatiadas, para não travar os
  // deltas de desenho de quem está no meio de um traço.
  board.on("blob", (payload) => mesh.broadcastBlob(payload));
  board.on("error", () => toast("Não consegui ler essa imagem.", { tone: "warn" }));
  board.on("sync-request", (peerId) => {
    // Só um participante responde, senão quem chega recebe N cópias.
    const ids = mesh.roster().map((p) => p.id).filter((id) => id !== peerId);
    if (ids.sort()[0] !== mesh.selfId) return;
    mesh.peers.get(peerId)?.sendBoard(board.scene());
  });

  /*
   * Reconciliação quando o canal (re)abre.
   *
   * Enquanto o canal esteve fechado — queda de rede, reconstrução da conexão —
   * cada lado continuou desenhando sem que o outro visse. Trocar a cena aqui
   * junta os dois desenhos: `apply("scene")` funde em vez de substituir, e
   * cada objeto tem id único por autor, então nada é sobrescrito nem duplicado.
   * Sem isto, os dois canvas ficavam permanentemente diferentes e a única
   * saída era limpar tudo.
   */
  mesh.on("board-channel", ({ id }) => {
    if (!board?.objects.size) return;
    mesh.peers.get(id)?.sendBoard(board.scene());
  });
}

/* ================================================================== *
 * Jogos: festa, tabuleiro, sorteios e os de equipe (Poker, Retro, Daily)
 * ================================================================== */

/*
 * O estado dos jogos vive desde o começo da chamada, mesmo com a mesa
 * fechada: assim quem abre depois já encontra os votos, as notas e a ordem
 * da daily de todo mundo. Ele vai e vem pelo canal do quadro (features/jogos.js).
 */
const jogosEstado = new EstadoJogos({ eu: "?" });
const meuNome = () => app.profile?.name || "";
const jogosPoker = new Poker(jogosEstado, { nome: meuNome });
/** Cards do GitHub Projects no Poker: só no app de mesa, que é quem fala com o GitHub. */
const jogosGithub = new KanbanGithub(jogosEstado, jogosPoker, window.vcallDesktop?.github || null, (texto, tom = "info") =>
  toast(texto, { tone: tom, ms: 3200, key: "github" }),
);
const jogosRetro = new Retro(jogosEstado, { nome: meuNome });
const jogosDaily = new Daily(jogosEstado);
/** A lógica de cada jogo de festa e de tabuleiro (features/festa.js e features/tabuleiro.js). */
const jogosLogicas = {
  desenho: new Desenho(jogosEstado, { nome: meuNome }),
  stop: new Stop(jogosEstado, { nome: meuNome }),
  quiz: new Quiz(jogosEstado, { nome: meuNome }),
  mimica: new Mimica(jogosEstado, { nome: meuNome }),
  quemsoueu: new QuemSouEu(jogosEstado, { nome: meuNome }),
  roda: new Roda(jogosEstado, { nome: meuNome }),
  verdades: new DuasVerdades(jogosEstado, { nome: meuNome }),
  codigo: new Codigo(jogosEstado, { nome: meuNome }),
  velha: new Velha(jogosEstado, { nome: meuNome }),
  lig4: new Lig4(jogosEstado, { nome: meuNome }),
  forca: new Forca(jogosEstado, { nome: meuNome }),
  memoria: new Memoria(jogosEstado, { nome: meuNome }),
  sorteios: new Sorteios(jogosEstado, { nome: meuNome }),
};
let jogos = null;
/** O celular com o QuizzV como controle do Quiz (features/quizzv.js). */
let quizzv = null;

function pessoasDosJogos() {
  return mesh.roster().map((p) => ({ id: p.id, nome: p.name || "Convidado", avatar: p.avatar, eu: !!p.self }));
}

function baixarTexto(texto, nome, tipo = "text/plain") {
  const url = URL.createObjectURL(new Blob([texto], { type: `${tipo};charset=utf-8` }));
  const a = el("a", { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function wireJogos() {
  const definirEu = () => {
    if (mesh.selfId) jogosEstado.eu = mesh.selfId;
  };
  mesh.on("joined", definirEu);
  definirEu();
  quizzv = new PonteQuizzV({
    signaling,
    quiz: jogosLogicas.quiz,
    pessoas: pessoasDosJogos,
    eu: () => mesh.selfId || "",
    nome: meuNome,
    abrirQuiz: () => abrirJogos("quiz"),
    parear: () => openQuizzvDialog(),
  });
  quizzv.on("aviso", ({ texto, tom }) => toast(texto, { tone: tom, ms: 2600, key: "quizzv" }));
  quizzv.on("mudou", () => {
    if (quizzvUi.dialogoAberto) renderPareamento();
  });
  jogos = new PainelJogos({
    estado: jogosEstado,
    poker: jogosPoker,
    github: jogosGithub,
    retro: jogosRetro,
    daily: jogosDaily,
    pessoas: pessoasDosJogos,
    aoEmoji: (para, e) => {
      mesh.broadcastBoard({ type: "jogo-emoji", para, e }, { fallback: false });
      jogos.voarEmoji(mesh.selfId, para, e);
    },
    aoFechar: () => fecharJogos(),
    logicas: jogosLogicas,
    aoEscolher: (id) => abrirJogos(id),
    quizzv,
    // A câmera de alguém, do mesmo fluxo que já chega no quadrinho (Mímica, Quem sou eu?).
    videoDe: (id) => stage?.get(id === mesh.selfId ? "self" : id, "cam")?.video?.srcObject || null,
    baixar: baixarTexto,
    copiar: (texto, aviso) => copy(texto, aviso),
    avisar: (texto, tom = "info") => toast(texto, { tone: tom, ms: 2600, key: "jogos" }),
  });
  // Cada jogada sai para todos; com o canal direto fechado, pelo servidor.
  jogosEstado.on("enviar", (lote) => mesh.broadcastBoard({ type: "jogo", o: lote }));
  jogosEstado.on("mudou", (chaves) => {
    if (chaves.includes("jogo")) avisarJogo();
    if (chaves.some((k) => k.startsWith("qz/"))) quizzv.enviar();
  });
  // Quem chega vê os meus sinais (Já volto, Sim…) sem eu precisar repetir.
  mesh.on("board-channel", ({ id }) => {
    const meus = sinaisChamada.de(mesh.selfId);
    if (meus.length) mesh.peers.get(id)?.sendBoard({ type: "sinal", s: meus });
  });
  // Quem chega (ou volta) recebe tudo, em pedaços que cabem no canal.
  mesh.on("board-channel", ({ id }) => {
    if (jogosEstado.vazio) return;
    const tudo = jogosEstado.instantaneo();
    for (const pedaco of pedacosDoEstado(tudo)) mesh.peers.get(id)?.sendBoard({ type: "jogo", o: pedaco });
    // E, se eu estou desenhando, o desenho até agora (depois do estado: o canal entrega em ordem).
    for (const d of jogosLogicas.desenho.paraQuemChegou()) mesh.peers.get(id)?.sendBoard({ type: "jogo-ev", j: "dz", d });
  });
  /*
   * Traços e palpites do Desenha e Adivinha não entram no estado (seriam
   * milhares de chaves): vão direto pelo canal. Os pedaços de traço vão só
   * pelo canal direto; o traço inteiro, no fim, tem a volta pelo servidor.
   */
  jogosLogicas.desenho.on("evento", (d) => {
    const { rapido, ...resto } = d;
    mesh.broadcastBoard({ type: "jogo-ev", j: "dz", d: resto }, { fallback: !rapido });
  });
  // As tarefas automáticas do jogo da sala (acabar o tempo, revelar, passar
  // a vez) rodam mesmo com a mesa fechada: quem cuida delas pode não estar olhando.
  setInterval(() => {
    if (!mesh.selfId) return;
    jogosLogicas[jogosEstado.ler("jogo")]?.manter?.(pessoasDosJogos());
    quizzv.tique();
  }, 1000);
  mesh.on("roster", () => jogos?.atualizar());
}

let fecharAvisoDeJogo = null;

/** Alguém abriu um jogo: um aviso com "Participar" — ninguém é arrastado. */
function avisarJogo() {
  const qual = jogosEstado.ler("jogo");
  const autor = jogosEstado.mapa.get("jogo")?.a;
  if (!qual || !JOGOS[qual] || autor === mesh.selfId || jogos?.aberto) return;
  const nome = mesh.profiles.get(autor)?.name || "Alguém";
  dock?.update("jogos", { badge: 1 });
  fecharAvisoDeJogo = toast(`${nome} abriu ${comArtigo(qual)}`, {
    tone: "info",
    ms: 9000,
    key: "jogo-aberto",
    action: { label: "Participar", onClick: () => abrirJogos(qual) },
  });
}

/**
 * Abre a mesa de jogos. Sem jogo dado, volta ao que esta pessoa via por
 * último (ou ao menu de jogos). Escolher um jogo avisa a sala.
 */
function abrirJogos(jogo = jogos?.jogo || "hub") {
  if (!jogos) return;
  closeBoard();
  if (!jogos.aberto) {
    stage.setBoard(true);
    jogos.montar($("#spotlight"), jogo);
  } else {
    jogos.mostrar(jogo);
  }
  dock.update("jogos", { active: true, badge: 0, label: "Fechar os jogos" });
  // Quem já abriu a mesa não precisa mais do convite para participar.
  fecharAvisoDeJogo?.();
  fecharAvisoDeJogo = null;
  // Avisa a sala (uma chave só; quem já está no mesmo jogo não é avisado de novo).
  if (JOGOS[jogo] && jogosEstado.ler("jogo") !== jogo) jogosEstado.definir([["jogo", jogo]]);
}

function fecharJogos() {
  if (!jogos?.aberto) return;
  jogos.desmontar();
  stage?.setBoard(false);
  dock?.update("jogos", { active: false, label: "Jogos" });
}

/* ------------------------------------------------------------------ *
 * Pareamento do celular (QuizzV)
 *
 * O QR leva o endereço desta chamada e um token que só vale para esta
 * pessoa. Tudo passa pelo próprio servidor da chamada (pelo mesmo túnel ou
 * pela mesma rede): nenhum serviço de terceiros no meio.
 * ------------------------------------------------------------------ */

const quizzvUi = { dialogoAberto: false, mesmoAssim: false, dono: null };

/**
 * De onde o celular consegue chegar até este servidor.
 *
 * No aplicativo de mesa a página é servida em 127.0.0.1 — que, no celular, é
 * o próprio celular. Ali vale o endereço público do túnel, ou o do Tailscale.
 * Sem nenhum dos dois, um endereço local não serve para outro aparelho, e é
 * melhor dizer isso do que mostrar um QR que não leva a lugar nenhum.
 */
function origemParaCelular() {
  for (const url of [host.url, host.ts?.url]) {
    if (!url) continue;
    try {
      return { origem: new URL(url).origin, via: url === host.url ? "tunel" : "tailscale" };
    } catch {
      /* endereço estranho: tenta o próximo */
    }
  }
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname);
  // "Mostrar mesmo assim": emulador com adb reverse, ou /quizzv aberto aqui mesmo.
  if (local && !quizzvUi.mesmoAssim) return { origem: null, motivo: "local" };
  return { origem: location.origin, via: location.protocol === "http:" ? "rede" : "pagina" };
}

function openQuizzvDialog() {
  const dlg = $("#quizzvModal");
  if (!dlg || !quizzv) return;
  quizzvUi.dialogoAberto = true;
  dlg.addEventListener("close", () => (quizzvUi.dialogoAberto = false), { once: true });
  // O título com a marca do app do outro lado.
  const titulo = $("#quizzvTitulo");
  if (titulo && !titulo.querySelector(".quizzvLogo")) {
    titulo.classList.add("quizzvTitulo");
    titulo.replaceChildren(logoQuizzv({ tamanho: 28 }), el("span", { text: "Quiz pelo celular com o" }), nomeQuizzv());
  }
  quizzv.pedirToken();
  renderPareamento();
  if (!dlg.open) dlg.showModal();
  animarEntradaDoDialogo(dlg);
}

function renderPareamento() {
  const body = $("#quizzvBody");
  if (!body || !quizzv) return;
  body.replaceChildren();
  const { origem, motivo, via } = origemParaCelular();

  if (!origem) {
    const acoes = el("div.row", { style: { gap: "var(--sp-2)", flexWrap: "wrap" } });
    if (host.disponivel) {
      acoes.append(
        el("button.btn.btn--primary", {
          type: "button",
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await host.abrirTunel();
            } catch {
              toast("Não consegui abrir o link público agora.", { tone: "warn" });
            }
            renderPareamento();
          },
        }, [icon("link"), el("span", { text: "Gerar link público" })]),
      );
    }
    if (motivo === "local") {
      acoes.append(
        el("button.btn.btn--ghost", {
          type: "button",
          onClick: () => {
            quizzvUi.mesmoAssim = true;
            renderPareamento();
          },
        }, [el("span", { text: "Mostrar o código mesmo assim" })]),
      );
    }
    body.append(
      el("p", { text: "Este endereço só funciona neste computador — o celular não chega até ele." }),
      el("p.muted", {
        text: host.disponivel
          ? "Gere o link público da chamada (ou ligue o Tailscale nas configurações) e o código aparece aqui."
          : "Abra a chamada pelo endereço da rede ou do túnel (o mesmo que você manda aos convidados) e tente de novo.",
      }),
      acoes,
    );
    return;
  }

  if (!quizzv.token) {
    body.append(carga("Gerando o código…"));
    return;
  }

  const link = linkDePareamento(origem, quizzv.token);
  const status = quizzv.conectado
    ? el("p.quizzvPar__status.is-ok", {}, [icon("check", { size: "sm" }), el("span", { text: "Celular conectado. Escolha o quiz no QuizzV." })])
    : el("p.quizzvPar__status", {}, [carga(), el("span", { text: "Esperando o celular…" })]);
  const celularAqui = env.isTouch && matchMedia("(max-width: 820px)").matches;

  body.append(
    el("div.quizzvPar", {}, [
      el("div.quizzvPar__qr", {}, [qrSvg(link)]),
      el("div.quizzvPar__lado", {}, [
        el("ol.quizzvPar__passos", {}, [
          el("li", { text: "No celular, abra o QuizzV e toque em “Vcall”." }),
          el("li", { text: "Aponte a câmera para este código." }),
          el("li", { text: "Escolha um quiz e toque em Começar — ou só responda, se outra pessoa estiver conduzindo." }),
        ]),
        status,
      ]),
    ]),
    el("details.quizzvPar__mais", {}, [
      el("summary", { text: "Sem câmera? Mande o link para o celular" }),
      el("p.muted", {
        text: "Tocado no celular, o link abre o QuizzV já conectado a esta chamada — ou uma página para responder pelo navegador. Ele vale só para você: quem tiver o link responde em seu nome.",
      }),
      el("div.row", { style: { gap: "var(--sp-2)" } }, [
        el("input.input", { value: link, readOnly: true, "aria-label": "Link de pareamento", onFocus: (e) => e.target.select() }),
        el("button.btn", { type: "button", onClick: () => copy(link, "Link copiado") }, [icon("copy"), el("span", { text: "Copiar" })]),
      ]),
      celularAqui
        ? el("a.btn.btn--primary", { href: linkDoQuizzv(origem, quizzv.token) }, [icon("smartphone"), el("span", { text: "Abrir no QuizzV deste celular" })])
        : null,
    ]),
    via === "rede"
      ? el("p.muted.quizzvPar__nota", { text: "Endereço da rede local: o celular precisa estar no mesmo Wi-Fi que este computador." })
      : via === "tailscale"
        ? el("p.muted.quizzvPar__nota", { text: "Endereço do Tailscale: o celular precisa estar com o Tailscale ligado." })
        : null,
  );
}


function abrirMenuJogos() {
  if (jogos?.aberto) fecharJogos();
  else abrirJogos();
}

function openBoardMenu() {
  dock.openPopover("board", (pop, close) => {
    pop.append(
      Dock.item({
        iconName: "pencil",
        label: "Canvas colaborativo",
        checked: app.boardMode === "board",
        onClick: () => {
          close();
          app.boardMode === "board" ? closeBoard() : openBoard("board");
        },
      }),
    );
    const canAnnotate = screen.active || [...mesh.states.values()].some((s) => s.screen);
    pop.append(
      Dock.item({
        iconName: "highlighter",
        label: canAnnotate ? "Anotar sobre a tela" : "Anotar (nenhuma tela em exibição)",
        checked: app.boardMode === "annotate",
        onClick: () => {
          close();
          if (!canAnnotate) {
            toast("Compartilhe uma tela primeiro para poder anotar sobre ela.", { tone: "info" });
            return;
          }
          app.boardMode === "annotate" ? closeBoard() : openBoard("annotate");
        },
      }),
    );
    if (app.boardMode) {
      pop.append(
        el("div.popover__sep"),
        Dock.item({ iconName: "image", label: "Inserir imagem ou canvas salvo", onClick: () => (close(), board.openImagePicker()) }),
        Dock.item({ iconName: "maximize", label: "Enquadrar tudo · F", onClick: () => (close(), board.fitAll()) }),
        Dock.item({ iconName: "undo-2", label: "Desfazer · Ctrl+Z", onClick: () => (close(), board.undo()) }),
        Dock.item({ iconName: "redo-2", label: "Refazer · Ctrl+Shift+Z", onClick: () => (close(), board.redo()) }),
        Dock.item({ iconName: "download", label: "Baixar como PNG", onClick: () => (close(), board.exportPng()) }),
        Dock.item({ iconName: "save", label: "Salvar o canvas (para abrir depois)", onClick: () => (close(), board.exportJson()) }),
        Dock.item({ iconName: "x", label: "Fechar canvas", onClick: () => (close(), closeBoard()) }),
      );
    }
  });
}

function openBoard(mode) {
  closeBoard();
  fecharJogos();
  app.boardMode = mode;
  boardNotice.seen();

  // O quadro ocupa o lugar do destaque, não a tela inteira: quem desenha
  // continua vendo os outros na faixa ao lado. No modo anotação ele é uma
  // camada transparente sobre a tela que já está em destaque.
  if (mode === "board") stage.setBoard(true);
  board.mount($("#spotlight"), { mode });

  dock.update("board", { active: true, label: mode === "board" ? "Fechar canvas" : "Parar de anotar" });
  mesh.publishState({ board: true });

  // Pede o estado atual a quem já estava no quadro.
  mesh.broadcastBoard({ type: "hello" });
  // A dica de atalhos também é uma vez só: quem abre e fecha o canvas várias
  // vezes numa chamada não precisa reler o mesmo texto a cada abertura.
  if (!app.boardTipShown?.[mode]) {
    app.boardTipShown = { ...app.boardTipShown, [mode]: true };
    toast(
      mode === "board"
        ? "Canvas aberto · espaço arrasta, Ctrl+roda dá zoom, N cria nota, Ctrl+Z desfaz"
        : "Anotando sobre a tela",
      { tone: "info", ms: 4000, key: "board-tip" },
    );
  }
}

function closeBoard() {
  if (!app.boardMode) return;
  app.boardMode = null;
  board?.unmount();
  stage?.setBoard(false);
  dock?.update("board", { active: false, label: "Canvas colaborativo" });
  mesh.publishState({ board: false });
}

/**
 * Se a tela que estava em destaque some, a camada de anotação perde o que
 * anotava — fecha em vez de ficar sobrando sobre outra coisa.
 */
function refreshBoardHost() {
  if (app.boardMode !== "annotate" || !board?.mounted) return;
  const stillSharing = screen.active || [...mesh.states.values()].some((s) => s.screen);
  if (!stillSharing) closeBoard();
}

/* ================================================================== *
 * Legendas ao vivo
 * ================================================================== */

function wireCaptions() {
  // Dentro de #stageMain, não de #stage: é o #stageMain que tem posição
  // relativa e cobre só a área de vídeo. Ancorado no #stage, o bloco cai no
  // rodapé da janela, atrás da barra de controles.
  captions.mount($("#stageMain"));

  /*
   * O reconhecedor entrega um palpite novo a cada palavra — várias vezes por
   * segundo. Mandar cada um deles para a rede inundava a sinalização e
   * estourava o limite de mensagens do servidor, que fechava a conexão. Agora
   * o palpite é limitado a um a cada 350 ms e NÃO usa o caminho pelo servidor:
   * legenda parcial que chega atrasada não serve para nada, e a frase final
   * vem logo atrás de qualquer jeito.
   */
  const sendInterim = throttle((text, confirmado = 0) => {
    mesh.broadcastBoard({ type: "caption", text: text.slice(0, 300), final: false, c: Math.min(confirmado, 300) }, { fallback: false });
  }, 350);

  captions.on("local", ({ text, final, confirmado = 0 }) => {
    // A própria fala aparece na sua tela e vai para os outros como texto.
    captions.show(mesh.selfId || "self", {
      name: `${app.profile.name} (você)`,
      text,
      final,
      color: colorFor(mesh.selfId || "self"),
      avatar: app.profile.avatar,
      confirmado,
    });
    // A frase encerrada vai inteira e com direito ao plano B: é ela que entra
    // na transcrição de quem está do outro lado.
    if (final) mesh.broadcastBoard({ type: "caption", text: text.slice(0, 300), final: true });
    else sendInterim(text, confirmado);
  });

  // Whisper: enquanto a frase é reconhecida, a pessoa vê que está sendo ouvida.
  captions.on("falando", (on) => {
    if (on) captions.ouvindo(mesh.selfId || "self", { name: `${app.profile.name} (você)`, color: colorFor(mesh.selfId || "self"), avatar: app.profile.avatar });
  });
  captions.on("linha", (item) => panel?.addTranscript(item));

  captions.on("state", (on) => {
    dock?.update("captions", {
      active: on,
      iconName: on ? "eye" : "eye-off",
      label: on ? "Parar de legendar minha fala" : "Legendar minha fala",
    });
  });

  captions.on("error", (err) => {
    const texto =
      err === "not-allowed" || err === "service-not-allowed"
        ? "O navegador não liberou o reconhecimento de fala. Verifique a permissão do microfone."
        : err === "network"
          ? "O reconhecimento de fala do navegador precisa de internet e não respondeu. Tente de novo em instantes."
          : err === "audio-capture"
            ? "Nenhum microfone disponível para a legenda."
            : `Legendas interrompidas: ${String(err).replace(/\.+$/, "")}.`;
    toast(texto, { tone: "warn", key: "captions", ms: 6000 });
  });

  // App de mesa: o reconhecedor offline baixa o modelo do idioma na primeira vez.
  captions.on("status", ({ fase, p }) => {
    if (fase === "baixando") {
      toast(`Preparando as legendas (só na primeira vez)… ${Math.round((p || 0) * 100)}%`, {
        tone: "info",
        key: "fala",
        ms: 60_000,
      });
    } else if (fase === "carregando") {
      toast("Preparando as legendas…", { tone: "info", key: "fala", ms: 30_000 });
    } else if (fase === "reserva") {
      toast("As legendas vão funcionar num modo mais simples, um pouco menos preciso.", { tone: "warn", key: "fala", ms: 5000 });
    } else if (fase === "pronto") {
      toast("Legendas ligadas. A sua fala é reconhecida aqui mesmo, sem sair do computador.", {
        tone: "ok",
        key: "fala",
        ms: 3500,
      });
    }
  });

  // Microfone mudo = legenda em pausa (nada do que é dito no mudo vai para a
  // sala). Trocar de microfone religa o reconhecedor na trilha nova.
  let ultimaTrilha = media.micTrack;
  media.on("change", () => {
    captions.setPaused(!media.micEnabled);
    if (captions.enabled && media.micTrack && media.micTrack !== ultimaTrilha && window.vcallDesktop) {
      captions.stop();
      captions.start();
    }
    ultimaTrilha = media.micTrack;
  });
  captions.setPaused(!media.micEnabled);
}

function toggleCaptions() {
  if (!captionsSupported) {
    toast(
      /VcallAndroid/.test(navigator.userAgent)
        ? "O app do celular não transcreve a sua fala, mas você continua LENDO as legendas de quem ligar o recurso."
        : "Este navegador não transcreve fala. No Chrome ou no Edge funciona — e mesmo aqui você continua LENDO as legendas de quem ligar o recurso.",
      { tone: "info", ms: 7000 },
    );
    return;
  }
  const on = captions.toggle();
  // No app de mesa o aviso vem do próprio reconhecedor (baixando, pronto).
  if (on && window.vcallDesktop) return;
  toast(
    on
      ? media.micEnabled
        ? "Legendando sua fala. Todos na sala leem o que você diz."
        : "Legenda ligada — ela começa quando você ligar o microfone."
      : "Legendas desligadas.",
    { tone: "info", ms: 3000, key: "captions" },
  );
}

/* ================================================================== *
 * Gravação local
 * ================================================================== */

function wireRecorder() {
  recorder.on("state", ({ recording }) => {
    dock?.update("record", {
      active: recording,
      label: recording ? "Parar a gravação" : "Gravar a chamada",
    });
    document.body.classList.toggle("is-recording", recording);
  });

  recorder.on("done", ({ blob, ext }) => {
    const url = URL.createObjectURL(blob);
    const name = `vcall-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast(`Gravação salva (${formatSize(blob.size)}) em ${name}`, { tone: "ok", ms: 7000 });
  });

  recorder.on("error", (err) => {
    toast("Não consegui gravar a chamada. Tente de novo.", { tone: "warn", ms: 6000 });
  });
}

function toggleRecording() {
  if (!canRecord) {
    toast("Este navegador não grava mídia.", { tone: "warn" });
    return;
  }
  if (recorder.recording) {
    recorder.stop();
    return;
  }

  // Grava o que está em destaque; sem destaque, a própria câmera. É a trilha
  // que o mosaico teria como assunto principal, sem o custo de recompor N
  // vídeos num canvas a cada quadro.
  const featured = stage.featured() || stage.get("self", "cam");
  const videoTrack =
    featured?.video?.srcObject?.getVideoTracks?.().find((t) => t.readyState === "live") || null;

  const audioStreams = [media.stream, screen.stream, ...audio.streams()].filter(Boolean);

  const ok = recorder.start({ video: videoTrack, audioStreams });
  if (!ok) return;
  toast(
    videoTrack
      ? "Gravando nesta máquina. Avise os outros — eles não são notificados automaticamente."
      : "Gravando só o áudio (não há vídeo em destaque). Avise os outros.",
    { tone: "warn", ms: 8000 },
  );
}

/* ================================================================== *
 * Avisos do sistema
 *
 * Só quando a aba está em segundo plano: notificar alguém sobre algo que já
 * está na tela dela é só barulho.
 * ================================================================== */

function notify(title, body) {
  if (!app.notify || document.visibilityState === "visible") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "/assets/icon-192.png", tag: "vcall" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* alguns navegadores só permitem por Service Worker; ignorado */
  }
}

async function setNotifications(want) {
  if (!("Notification" in window)) {
    toast("Este navegador não tem avisos de sistema.", { tone: "warn" });
    return false;
  }
  if (!want) {
    app.notify = false;
    prefs.set("notify", false);
    return false;
  }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  app.notify = perm === "granted";
  prefs.set("notify", app.notify);
  if (!app.notify) toast("Os avisos ficaram bloqueados nas permissões do site.", { tone: "warn" });
  return app.notify;
}

/* ================================================================== *
 * Mão levantada e reações
 * ================================================================== */

function toggleHand() {
  app.hand = !app.hand;
  mesh.publishState({ hand: app.hand });
  dock.update("hand", { active: app.hand, label: app.hand ? "Baixar a mão" : "Levantar a mão" });
  stage.get("self", "cam")?.setHand(app.hand);
  if (app.hand) toast("Você levantou a mão", { tone: "info", ms: 2000 });
}

/*
 * Reações e sinais (features/reacoes.js, ui/reacoes.js). Vão pelo canal
 * direto da chamada; cliques repetidos viram combo, e a mesma reação de três
 * pessoas vira chuva. Sinais (Sim, Não, Mais devagar…) ficam no quadrinho.
 */
const sinaisChamada = new Sinais();
const chuvaDeReacoes = new Chuva();
const comboDeReacoes = new Combo((id, n) => mesh.broadcastBoard({ type: "reacao", r: id, n }, { fallback: true }));
const combosDosOutros = new ComboRemoto();
const camadaReacoes = new CamadaReacoes({
  quadro: (p) => stage?.get(p === mesh.selfId ? "self" : p, "cam")?.node || null,
  nome: (p) => (p === mesh.selfId ? "Você" : mesh.profiles.get(p)?.name || "Alguém"),
  palco: () => $("#stage"),
});
let menuDeReacoes = null;

function openReactionMenu(dono = "react") {
  dock.openPopover(
    dono,
    (pop) => {
      menuDeReacoes = montarMenuDeReacoes(pop, {
        aoReagir: (id) => reagir(id),
        aoSinal: (id) => alternarSinal(id),
        meusSinais: () => sinaisChamada.de(mesh.selfId),
      });
    },
    { className: "popover--reactions" },
  );
}

function reagir(id) {
  if (!mesh.selfId) return;
  const combo = comboDeReacoes.soltar(id);
  mostrarReacao(mesh.selfId, id, { combo });
}

function mostrarReacao(pessoa, id, { n = 1, combo = 1 } = {}) {
  camadaReacoes.voar(pessoa, id, { n, combo });
  if (chuvaDeReacoes.registrar(id, pessoa)) camadaReacoes.chover(id);
}

function alternarSinal(id) {
  if (!mesh.selfId) return;
  const ids = sinaisChamada.alternar(mesh.selfId, id);
  mesh.broadcastBoard({ type: "sinal", s: ids }, { fallback: true });
  menuDeReacoes?.pintar(ids);
}

function pintarSinais(pessoa, ids) {
  camadaReacoes.sinais(pessoa, ids);
  camadaReacoes.placar(sinaisChamada.porSinal());
  if (pessoa === mesh.selfId) menuDeReacoes?.pintar(ids);
}
sinaisChamada.on("mudou", ({ pessoa, ids }) => pintarSinais(pessoa, ids));
// Os sinais vencem (Sim e Não depois de 90 s…), e um quadrinho refeito
// (troca de layout, reconexão) recebe as etiquetas de novo.
setInterval(() => {
  if (!mesh.selfId) return;
  sinaisChamada.vencer();
  for (const [pessoa, ids] of Object.entries(sinaisPorPessoa())) camadaReacoes.sinais(pessoa, ids);
}, 5000);

function sinaisPorPessoa() {
  const out = {};
  for (const [id, pessoas] of Object.entries(sinaisChamada.porSinal())) for (const p of pessoas) (out[p] ||= []).push(id);
  return out;
}

/** Reação ou sinal que chegou pelo canal direto (dado de fora: validado). */
function receberReacao(from, op) {
  const v = validarReacao(op);
  if (!v) return false;
  if (v.tipo === "reacao") {
    mostrarReacao(from, v.id, { n: v.n, combo: combosDosOutros.somar(from, v.id, v.n) });
    return true;
  }
  const antes = sinaisChamada.de(from);
  sinaisChamada.definir(from, v.ids);
  if (v.ids.includes("semaudio") && !antes.includes("semaudio")) {
    toast(`${mesh.profiles.get(from)?.name || "Alguém"} não está ouvindo`, { tone: "warn", ms: 5000, key: `semaudio-${from}` });
  }
  return true;
}

/*
 * A tela compartilhada parou de mandar imagem. Janela minimizada não é
 * capturada (o Windows não a desenha): do outro lado a imagem congela e quem
 * compartilha não percebe. Só no modo Fluidez, onde imagem parada por vários
 * segundos não é o normal; no de texto, tela parada é o dia a dia.
 */
const telaParada = { desde: 0, avisou: false };
function avisarTelaParada(samples) {
  const fonte = [...samples.values()].map((s) => s.outbound.screen?.sourceFps).find((x) => x != null);
  if (!screen.active || screen.mode !== "motion" || fonte == null || fonte >= 2) {
    telaParada.desde = 0;
    telaParada.avisou = false;
    return;
  }
  telaParada.desde ||= performance.now();
  if (telaParada.avisou || performance.now() - telaParada.desde < 6000) return;
  telaParada.avisou = true;
  toast("A tela que você compartilha está parada. Se a janela estiver minimizada, abra-a: minimizada, ela não manda imagem e quem assiste vê tudo congelado.", {
    tone: "warn",
    key: "tela-parada",
    ms: 9000,
  });
}

/* ================================================================== *
 * Ligação com a malha
 * ================================================================== */

function wireMesh() {
  mesh.on("joined", ({ self, peers, room, reconnected }) => {
    // Voltou com outro id: o token antigo de pareamento morreu com ele.
    if (quizzvUi.dono && quizzvUi.dono !== self.id) quizzv?.esquecerToken();
    quizzvUi.dono = self.id;
    app.maxPeers = room?.max || app.maxPeers;
    app.roomName = room?.name || app.roomName;
    app.roomCode = room?.code || app.roomCode;
    if (app.roomName) $("#roomName").textContent = app.roomName;
    $("#roomName").hidden = !app.roomName;
    board.selfId = self.id;
    board.color = colorFor(self.id);

    const tile = stage.get("self", "cam");
    tile?.setQuality("good");

    if (reconnected) {
      toast("Reconectado à sala", { tone: "ok" });
    }
    // Sala vazia não precisa de aviso: a sala de espera no palco já diz tudo.
    updateHeader();
  });

  // "peer-added" cobre os dois caminhos: alguém que chega agora e alguém que
  // já estava na sala quando nós chegamos. Criar o ladrilho só no "peer-join"
  // deixava quem entra numa sala cheia sem ver ninguém.
  mesh.on("peer-added", ({ id }) => {
    const profile = mesh.profiles.get(id) || {};
    const state = mesh.states.get(id) || {};
    const tile = stage.ensure(id, "cam", { name: profile.name || "Convidado", avatar: profile.avatar });
    addVolumeTo(tile, id, profile.name || "participante");
    tile.setConnection("connecting");
    tile.setMic(!!state.mic);
    tile.setHand(!!state.hand);
    syncTiles(id); // já transmitindo quando chegamos: o convite aparece sem esperar a mídia
    updateHeader();
  });

  mesh.on("peer-join", (peer) => {
    // Quem caiu e voltou não "entrou" de novo: sem som e sem aviso de sistema.
    if (peer.reconnected) {
      panel.addSystem(`${peer.name} reconectou`);
      return;
    }
    panel.addSystem(`${peer.name} entrou`);
    chime("join");
    notify("Alguém entrou na sala", `${peer.name} está na chamada`);
  });

  mesh.on("peer-leave", ({ id, profile, replaced }) => {
    stage.removePeer(id);
    if (!replaced) sinaisChamada.esquecer(id);
    updateHeader();
    if (replaced) return; // a mesma pessoa está voltando com outra conexão
    panel.addSystem(`${profile?.name || "Alguém"} saiu`);
    chime("leave");
  });

  wireModeration();
  wireModoJogo();
  wireEconomia();
  wireJogos();

  /**
   * As trilhas recebidas e o estado anunciado chegam em ordens diferentes, e o
   * navegador cria uma trilha receptora para a linha de tela mesmo quando
   * ninguém está compartilhando — isso criava um ladrilho preto fantasma. A
   * regra aqui é: o ladrilho existe quando há mídia viva E a pessoa declarou
   * que está enviando aquilo.
   */
  const remoteMedia = new Map(); // id -> { cam, screen, screenAudio }

  /*
   * Como no Discord: a tela de outra pessoa aparece como convite, e só chega
   * (e só é decodificada) depois de clicar em Assistir. Quem transmite não
   * manda a tela para quem não assiste (mesh.assistirTela).
   */
  function assistir(id, sim) {
    mesh.assistirTela(id, sim);
    const som = remoteMedia.get(id)?.screenAudio;
    audio.attach(id, "screenAudio", sim && som?.live ? som.stream : null);
    syncTiles(id);
  }

  function syncTiles(id) {
    const got = remoteMedia.get(id) || {};
    const state = mesh.states.get(id) || {};
    const profile = mesh.profiles.get(id) || {};

    stage.get(id, "cam")?.setCamera(state.cam && got.cam ? got.cam : null);

    // Parou de transmitir: quem assistia volta ao convite na próxima transmissão.
    if (!state.screen && mesh.assistindo.has(id)) {
      mesh.assistirTela(id, false);
      audio.attach(id, "screenAudio", null);
    }

    if (state.screen) {
      const vendo = mesh.assistindo.has(id);
      const tile = stage.ensure(id, "screen", {
        name: `Tela de ${profile.name || "participante"}`,
        avatar: profile.avatar,
      });
      addVolumeTo(tile, id, profile.name || "participante");
      tile.botaoParar ||= tile.addAction({ iconName: "eye-off", label: "Parar de assistir", onClick: () => assistir(id, false) });
      tile.setConvite(vendo ? "" : profile.name || "Alguém", () => assistir(id, true));
      tile.setStream(vendo ? got.screen : null);
      if (vendo && !got.screen) tile.node.classList.add("is-waiting"); // até a primeira imagem chegar
      tile.setQuality(mesh.stats.samples.get(id)?.quality || "unknown");
      stage.relayout();
    } else if (stage.get(id, "screen")) {
      stage.remove(id, "screen");
    }
    refreshBoardHost();
  }

  mesh.on("media", ({ id, role, stream, live }) => {
    // Voz e som da tela vão para a saída de áudio. Sem esta linha a chamada
    // conecta, o vídeo aparece e não sai som nenhum.
    if (role === "mic" || role === "screenAudio") {
      // O som da tela só toca para quem assiste a tela (como no Discord).
      if (role === "screenAudio") remoteMedia.set(id, { ...remoteMedia.get(id), screenAudio: { stream, live } });
      const toca = role === "mic" || mesh.assistindo.has(id);
      audio.attach(id, role, live && toca ? stream : null);
      // A linha de som da tela existe desde o começo da chamada e pode "acordar"
      // sem ninguém compartilhar nada (o navegador recebe silêncio). O aviso só
      // vale quando a pessoa está de fato compartilhando a tela — antes ele
      // aparecia do nada, para todo mundo.
      if (role === "screenAudio" && live && stream && toca && mesh.states.get(id)?.screen) {
        toast(`${mesh.profiles.get(id)?.name || "Alguém"} está compartilhando o som da tela`, {
          tone: "info",
          ms: 3500,
          key: `scraudio-${id}`,
        });
      }
      return;
    }
    if (role !== "cam" && role !== "screen") return;
    /*
     * `mute` NÃO é "parou de compartilhar". A trilha recebida silencia sempre
     * que os pacotes param de chegar por alguns segundos — e a captura de tela
     * do Linux (PipeWire e X11) só entrega quadro quando algo muda na tela.
     * Tela parada = trilha muda = o ladrilho sumia e voltava sem parar, com o
     * aviso "está compartilhando" pulando a cada volta. Quem diz se a pessoa
     * está compartilhando é o estado anunciado por ela; aqui só guardamos o
     * stream enquanto ele existir, e o <video> segura o último quadro.
     */
    const got = remoteMedia.get(id) || {};
    if (stream) got[role] = stream;
    else if (!live) got[role] = null;
    remoteMedia.set(id, got);
    syncTiles(id);
  });

  mesh.on("peer-state", ({ id, state }) => {
    const cam = stage.get(id, "cam");
    if (cam) {
      cam.setMic(!!state.mic);
      cam.setHand(!!state.hand);
    }
    const wasSharing = !!stage.get(id, "screen");
    syncTiles(id);
    if (state.screen && !wasSharing && stage.get(id, "screen")) {
      const name = mesh.profiles.get(id)?.name || "Alguém";
      toast(`${name} está transmitindo a tela`, {
        tone: "info",
        key: `tela-${id}`,
        action: { label: "Assistir", onClick: () => mesh.states.get(id)?.screen && assistir(id, true) },
      });
    }
  });

  mesh.on("peer-removed", ({ id }) => {
    remoteMedia.delete(id);
    audio.detachPeer(id);
  });

  mesh.on("profile", ({ id, profile }) => {
    const tile = stage.get(id, "cam");
    tile?.setName(profile.name);
    tile?.setAvatarSpec(profile.avatar, profile.name);
  });

  /**
   * Quando uma conexão P2P não fecha, a causa quase sempre é a mesma: um dos
   * lados está atrás de um NAT que só um servidor TURN atravessa. Dizer isso
   * na hora poupa a pessoa de procurar culpa na própria internet — e distingue
   * este caso de uma queda passageira.
   */
  const slowPeers = new Map();

  function explainNoTurn(id, { failed = false } = {}) {
    const name = mesh.profiles.get(id)?.name || "Um participante";
    if (mesh.iceConfig?.hasTurn) {
      toast(
        failed
          ? `Não foi possível manter a conexão com ${name}. Peça para recarregar a página.`
          : `A conexão com ${name} está demorando.`,
        { tone: "warn", ms: 7000, key: `conn-${id}` },
      );
      return;
    }
    toast(
      `Não foi possível conectar com ${name}. A rede de um dos dois (empresa, 4G ou Wi-Fi público) ` +
        `está bloqueando a chamada. Tentem outra rede — por exemplo, trocar o Wi-Fi pelos dados do celular.`,
      { tone: "warn", ms: 12_000, key: "no-turn" },
    );
  }

  mesh.on("peer-connection", ({ id, state, relay }) => {
    const tile = stage.get(id, "cam");
    if (tile) tile.setConnection(state === "connected" ? null : state);

    clearTimeout(slowPeers.get(id));
    slowPeers.delete(id);

    if (state === "connected") return;

    if (state === "rebuilding") {
      const name = mesh.profiles.get(id)?.name || "um participante";
      toast(
        `Refazendo a conexão com ${name}${relay ? " por outro caminho" : ""}…`,
        { tone: "info", ms: 3500, key: `rebuild-${id}` },
      );
      return;
    }

    if (state === "exhausted") {
      explainNoTurn(id, { failed: true });
      return;
    }

    // Sem TURN, uma conexão que não fecha em 20 segundos raramente fecha
    // depois. Avisar antes de esgotar as tentativas evita a espera silenciosa.
    if (state === "new" || state === "connecting") {
      slowPeers.set(
        id,
        setTimeout(() => {
          if (mesh.peers.get(id)?.connectionState !== "connected") explainNoTurn(id);
        }, 20_000),
      );
    }
  });

  mesh.on("peer-removed", ({ id }) => {
    clearTimeout(slowPeers.get(id));
    slowPeers.delete(id);
  });

  mesh.on("chat", (m) => {
    const profile = mesh.profiles.get(m.id) || {};
    panel.addMessage({ id: m.id, name: m.name, avatar: profile.avatar, text: m.text, at: m.at });
    notify(m.name, m.text.slice(0, 160));
    if (!panel.open || panel.tab !== "chat") {
      toast(`${m.name}: ${m.text.slice(0, 80)}`, {
        tone: "info",
        key: "chat",
        action: { label: "Abrir", onClick: () => panel.setOpen(true, "chat") },
      });
    }
  });

  // Reação pelo caminho antigo (servidor): quem ainda manda assim.
  mesh.on("reaction", ({ id, kind }) => DO_ANTIGO[kind] && mostrarReacao(id, DO_ANTIGO[kind]));

  mesh.on("board", ({ from, op }) => {
    /*
     * O canal do quadro carrega JSON solto, e legendas e arquivos são JSON
     * solto também. Passá-los por aqui evita abrir um terceiro DataChannel
     * (mais uma negociação por par) e um par de mensagens novas no servidor
     * para algo que o caminho existente já entrega. Cada destinatário
     * reconhece o que é seu pelo `type` e devolve o resto.
     */
    if (transfer.apply(from, op)) return;
    if (op?.type === "link-novo") return avisarLinkNovo(from, op.url);
    if (op?.type === "jogo") {
      jogosEstado.aplicar(op.o);
      return;
    }
    if (op?.type === "jogo-ev") {
      if (op.j === "dz") jogosLogicas.desenho.receber(from, op.d);
      return;
    }
    if ((op?.type === "reacao" || op?.type === "sinal") && receberReacao(from, op)) return;
    if (op?.type === "jogo-emoji") {
      jogos?.voarEmoji(from, String(op.para || ""), String(op.e || ""));
      return;
    }
    if (op?.type === "caption") {
      const profile = mesh.profiles.get(from) || {};
      captions.show(from, {
        name: profile.name || "Alguém",
        text: String(op.text || "").slice(0, 300),
        final: !!op.final,
        color: colorFor(from),
        avatar: profile.avatar,
        confirmado: Number(op.c) || 0,
      });
      return;
    }
    if (!board) return;
    board.apply(from, op);
    // Abrir o quadro por conta própria tiraria a pessoa do que ela estava
    // vendo. Melhor avisar e deixá-la decidir; as operações já ficam guardadas,
    // então ao abrir ela vê tudo o que foi desenhado até ali.
    //
    // O aviso aparece UMA vez por chamada. Antes ele renascia a cada traço
    // (cada pedaço de traço é uma operação), e quem não estava no canvas via
    // a mesma notificação pulando na tela sem parar enquanto alguém desenhava.
    if (!app.boardMode && shouldAnnounceBoard(op)) {
      const who = mesh.profiles.get(from)?.name || "Alguém";
      toast(`${who} está desenhando no canvas`, {
        tone: "info",
        key: "board-invite",
        ms: 6000,
        action: { label: "Ver", onClick: () => openBoard("board") },
      });
    }
  });

  mesh.on("cursor", ({ from, x, y, name, color }) => {
    board?.showLaser(from, { x, y, name, color });
  });

  mesh.on("speaking", ({ id, speaking }) => {
    stage.get(id === mesh.selfId ? "self" : id, "cam")?.setSpeaking(speaking);
  });

  // A barrinha de nível acompanha a voz quadro a quadro. É barato: os valores
  // já foram medidos pelo detector de fala, aqui só se pintam.
  // No celular, 20 pinturas por segundo (o detector também mede nesse ritmo).
  let levelRaf = 0;
  let ultimaPintura = 0;
  let nivelDoMic = "";
  const passoPintura = env.isTouch ? 50 : 0;
  const paintLevels = (t) => {
    levelRaf = requestAnimationFrame(paintLevels);
    if (t - ultimaPintura < passoPintura) return;
    ultimaPintura = t;
    for (const [id, level] of mesh.vad.levels) {
      stage.get(id === mesh.selfId ? "self" : id, "cam")?.setLevel(level);
      // A própria voz também acende o botão do microfone: dá para saber que
      // o microfone está pegando sem procurar o seu ladrilho na grade.
      if (id !== mesh.selfId) continue;
      const lv = Math.min(1, level * 3.2).toFixed(2);
      if (lv === nivelDoMic) continue; // escrever o mesmo valor ainda recalcula o estilo
      nivelDoMic = lv;
      dock?.get("mic")?.style.setProperty("--lv", lv);
    }
  };
  levelRaf = requestAnimationFrame(paintLevels);
  on(window, "pagehide", () => cancelAnimationFrame(levelRaf));

  mesh.on("active-speaker", (id) => stage.setActiveSpeaker(id));

  mesh.on("roster", (roster) => {
    if (panel.open && panel.tab === "people") renderPeopleNow(roster);
    updateHeader(roster);
  });

  mesh.on("stats", (samples) => {
    for (const [id, s] of samples) {
      stage.get(id, "cam")?.setQuality(s.quality);
      stage.get(id, "screen")?.setQuality(s.quality);
    }
    panel.renderStats(samples, mesh.roster(), { history: (id) => mesh.stats.historyFor(id) });
    avisarTelaParada(samples);
  });

  mesh.on("limited", throttle(({ reason }) => {
    toast(
      reason === "cpu"
        ? "O processador está no limite — reduzindo a taxa de quadros para manter a imagem legível."
        : "A rede apertou — ajustando a qualidade automaticamente.",
      { tone: "warn", key: "limited", ms: 4000 },
    );
  }, 20_000));

  // O socket parou de responder e foi derrubado de propósito para reconectar.
  signaling.on("stale", () => {
    toast("A conexão com a sala travou; reconectando…", { tone: "warn", ms: 3000, key: "stale" });
  });

  mesh.on("link", ({ status, reason }) => {
    const badge = $("#linkBadge");
    const text = $("#linkText");
    if (status === "reconnecting" || status === "offline") {
      badge.className = "topbar__selo topbar__selo--aviso";
      text.textContent = "Reconectando à sala…";
    } else if (status === "error") {
      // Removido ou barrado pelo anfitrião: não há o que reconectar.
      if (reason === "kicked" || reason === "room-locked") {
        leaveCall({ motivo: reason });
        return;
      }
      badge.className = "topbar__selo topbar__selo--erro";
      text.textContent = reason === "room-full" ? "Sala cheia" : "Erro de conexão";
      if (reason === "room-full") {
        toast(`Esta sala está cheia: já tem ${app.maxPeers} pessoas, o máximo por chamada.`, {
          tone: "danger",
          ms: 9000,
        });
      }
    } else {
      badge.className = "topbar__selo";
      text.textContent = "Criptografada ponta a ponta";
    }
  });

  /*
   * A sala caiu de vez: sem sinalização por mais de 15 s E sem ninguém ligado
   * direto. Enquanto houver alguém conectado ponto a ponto, a chamada continua
   * (a mídia não passa pelo servidor) e basta o selo "Reconectando…". Sem
   * ninguém, a pessoa ficava olhando uma sala vazia com um selo pequeno.
   */
  let salaCaiu = 0;
  let telaDaQueda = null;
  const ninguemConectado = () => ![...mesh.peers.values()].some((p) => p.connectionState === "connected");
  mesh.on("link", ({ status }) => {
    const fora = status === "reconnecting" || status === "offline";
    if (!fora) {
      clearTimeout(salaCaiu);
      salaCaiu = 0;
      telaDaQueda?.remove();
      telaDaQueda = null;
      return;
    }
    if (salaCaiu || telaDaQueda) return;
    salaCaiu = setTimeout(() => {
      salaCaiu = 0;
      if (app.left || !ninguemConectado()) return;
      telaDaQueda = montarTelaDeErro({
        tipo: navigator.onLine === false ? "internet" : "caiu",
        sondar: () => (app.linkNovo ? Promise.resolve(true) : fetch("/healthz", { cache: "no-store" }).then((r) => r.ok)),
        // Se o anfitrião trocou de link, é por ele que se volta.
        aoTentar: () => (app.linkNovo ? location.assign(app.linkNovo) : location.reload()),
        aoVoltar: () => leaveCall(),
        rotuloVoltar: "Sair da sala",
      });
      telaDaQueda.classList.add("erro--sobre");
      document.body.append(telaDaQueda);
    }, 15_000);
  });

  /*
   * O anfitrião gerou outro link público. Só vale vindo DELE, em https e para
   * esta mesma sala: qualquer participante pode mandar mensagens pelo canal
   * direto, e um link de outro lugar seria um convite para golpe.
   */
  function avisarLinkNovo(de, url) {
    let novo;
    try {
      novo = new URL(url);
    } catch {
      return;
    }
    if (de !== mesh.hostId || novo.protocol !== "https:" || novo.hash !== location.hash) return;
    if (novo.origin === location.origin) return; // já estamos nele
    app.linkNovo = novo.href;
    toast("Quem criou a sala gerou um link novo. A chamada continua; se cair, entre por ele.", {
      tone: "info",
      ms: 20_000,
      key: "link-novo",
      action: { label: "Usar o link novo", onClick: () => location.assign(novo.href) },
    });
  }

  mesh.on("ice", (cfg) => {
    if (!cfg.hasTurn) {
      console.info(
        "[vcall] sem servidor TURN configurado: participantes em redes corporativas ou atrás de NAT restritivo podem não conseguir conectar.",
      );
    }
  });

  media.on("error", ({ kind, err }) => toast(describeMediaError(err, kind), { tone: "warn" }));

  // O navegador bloqueia som antes de um gesto do usuário. Em vez de deixar a
  // pessoa achando que a sala está muda, mostramos um botão explícito.
  audio.on("blocked", (blocked) => {
    let gate = $(".audioGate");
    if (!blocked) {
      gate?.remove();
      return;
    }
    if (gate) return;
    gate = el("button.audioGate", { type: "button" }, [
      icon("volume-2", { size: "sm" }),
      el("span", { text: "Clique para ativar o som" }),
    ]);
    gate.addEventListener("click", async () => {
      const okNow = await audio.resume();
      if (okNow) gate.remove();
    });
    document.body.append(gate);
  });

  // Qualquer clique serve para liberar o áudio.
  on(document, "pointerdown", () => audio.resume(), { once: true });

  // Troca de alto-falante nas configurações.
  media.on("sink", (deviceId) => audio.setSink(deviceId));

  audio.on("fallback", () => {
    toast(
      "O som passou a sair pelo caminho simples deste navegador. O volume de cada pessoa agora vai só até 100%.",
      { tone: "info", ms: 6000, key: "audio-fallback" },
    );
  });

  audio.on("volume", ({ peerId, value }) => {
    stage.get(peerId, "cam")?.setVolume(value);
    stage.get(peerId, "screen")?.setVolume(value);
  });
}

/* ================================================================== *
 * Cabeçalho
 * ================================================================== */

function updateHeader(roster = null) {
  const list = roster || mesh.roster();
  const n = list.length;
  $("#peerCount").textContent = n === 1 ? "só você" : `${n} pessoas`;
  syncWaiting(n <= 1);
}

function startTimer() {
  app.startedAt = Date.now();
  clearInterval(app.timerId);
  app.timerId = setInterval(() => {
    $("#callTimer").textContent = formatDuration((Date.now() - app.startedAt) / 1000);
  }, 1000);
}

/* ================================================================== *
 * Convite
 * ================================================================== */

function roomLink() {
  return linkFor(app.room);
}

/**
 * O "Copiar link" da sala vazia. No app de mesa a página vem de 127.0.0.1,
 * que não abre em nenhum outro aparelho: vale o link público (o túnel sobe ao
 * criar a sala) ou o do Tailscale. Com o túnel ainda subindo, espera por ele.
 */
async function copiarLinkDaReuniao() {
  if (host.disponivel && ["abrindo", "baixando", "verificando"].includes(host.estado)) {
    toast("Gerando o link público… ele é copiado assim que ficar pronto.", { tone: "info", ms: 6000 });
    await host.abrirTunel().catch(() => {});
  }
  const link = host.linkPublico(roomLink()) || host.linkTailscale(roomLink()) || roomLink();
  const local = /^http:\/\/(127\.|localhost)/.test(link);
  copy(link, host.url ? "Link público copiado" : local ? "Link copiado, mas ele só abre neste computador" : "Link copiado");
}

function openInvite() {
  const dlg = $("#inviteModal");
  $("#inviteLink").value = roomLink();
  $("#inviteCode").value = app.roomCode || "—";
  $("#inviteCapacity").textContent =
    `Até ${app.maxPeers} pessoas ao mesmo tempo. O vídeo vai direto entre os participantes, sem passar por servidor — é isso que mantém a conversa criptografada de ponta a ponta.`;
  syncTunnelUi();
  syncTailscaleUi();
  syncAppLink();
  dlg.showModal();
  // O Tailscale pode ter sido aberto ou fechado desde a última vez.
  if (host.disponivel && host.ts.estado !== "pronto") host.conferirTailscale().then(syncTailscaleUi);
  requestAnimationFrame(() => $("#inviteLink").select());
}

/* ================================================================== *
 * Link público (só no aplicativo de mesa)
 * ================================================================== */

/**
 * O campo do link `vcall://`.
 *
 * Só aparece dentro do aplicativo: no navegador comum não há como saber se
 * quem vai receber tem o Vcall instalado, e oferecer um link que pode não
 * abrir nada é pior do que não oferecer.
 */
function syncAppLink() {
  const box = $("#appLinkBox");
  if (!box) return;
  encurtarConvite();
  $("#appLink").value = inviteLink() || "";
  const local = /^http:\/\/(127\.|localhost)/.test(inviteLink() || "");
  $("#appLinkHint").textContent = local
    ? "Este endereço só funciona neste computador. Gere o link público (ou o do Tailscale) abaixo para mandar pelo WhatsApp."
    : !host.url && host.ts.url
      ? "Pela sua rede Tailscale: só abre para quem está nela, com o Tailscale ligado."
      : host.url || !host.disponivel
      ? "Clicável no WhatsApp. Abre direto no Vcall de quem tem o aplicativo; quem não tem entra pelo navegador."
      : "Funciona para quem está na mesma rede que você. Para quem está fora dela, gere o link público abaixo.";
}

/**
 * O convite para mensageiros: o link curto /c/CODIGO (https, clicável e com
 * o cartão da chamada no WhatsApp) sobre o endereço público quando o túnel
 * está de pé, ou sobre o atual. Sem o código da sala ainda, o /abrir#sala.
 */
function inviteLink() {
  const base = (host.url && host.linkPublico(roomLink())) || host.linkTailscale(roomLink()) || roomLink();
  const longo = linkCurto(base, app.roomCode);
  return encurtados.get(longo) || longo;
}

/**
 * No app de mesa, com o túnel de pé: troca o convite do túnel pelo link do
 * encurtador (is.gd/AbC123), que é o que aparece escrito no WhatsApp. Sem
 * resposta, o convite segue com o endereço do túnel.
 */
const encurtados = new Map();
const encurtando = new Set();
function encurtarConvite() {
  const longo = inviteLink();
  if (!host.disponivel || !host.url || encurtados.has(longo) || encurtando.has(longo) || !/^https:\/\/[^/]+\.trycloudflare\.com\/c\//.test(longo)) return;
  encurtando.add(longo);
  host.encurtar(longo).then((curto) => {
    encurtando.delete(longo);
    if (!curto) return;
    encurtados.set(longo, curto);
    syncAppLink();
  });
}

/**
 * O link pela rede Tailscale. Aparece no app de mesa quando o Tailscale está
 * instalado; sem ele, uma linha só diz que a opção existe.
 */
function syncTailscaleUi() {
  const box = $("#hostTailscale");
  if (!box) return;
  const c = host.tsConferido;
  box.hidden = !host.disponivel || !c;
  if (box.hidden) return;
  const { estado, url, habilitar, erro } = host.ts;
  const campo = $("#tsLink");
  const btn = $("#tsBtn");
  const texto = $("#tsBtnText");
  const dica = $("#tsHint");
  const ocupado = ["conferindo", "habilitar", "verificando"].includes(estado);
  const linha = $("#tsLink").closest(".row");

  linha.hidden = !c.instalado;
  campo.value = url ? host.linkTailscale(roomLink()) || "" : "";
  btn.disabled = ocupado;
  $("#tsHabilitar").hidden = estado !== "habilitar" || !habilitar;
  $("#tsFechar").hidden = !(estado === "pronto" || estado === "habilitar");

  if (!c.instalado) {
    dica.textContent =
      "Usa Tailscale? Com ele instalado e ligado aqui e em quem você convida, o Vcall gera um link que só abre dentro da sua rede privada.";
  } else if (estado === "pronto") {
    texto.textContent = "Copiar";
    dica.textContent =
      "Só abre para quem está na sua rede Tailscale. A voz e o vídeo vão direto pela rede privada quando a internet comum não deixa.";
  } else if (estado === "habilitar") {
    texto.textContent = "Esperando…";
    dica.textContent =
      "Falta uma autorização no Tailscale (uma vez só). Abra a página, confirme, e o link sai sozinho.";
  } else if (ocupado) {
    texto.textContent = estado === "verificando" ? "Testando…" : "Conferindo…";
    dica.textContent =
      estado === "verificando"
        ? "Conferindo se o link abre. Na primeira vez isso leva alguns segundos."
        : "Perguntando ao Tailscale deste computador…";
  } else {
    texto.textContent = "Gerar link";
    dica.textContent =
      estado === "erro" && erro
        ? erro
        : c.pronto
          ? `Rede ${c.tailnet || "Tailscale"} conectada. O link só abre para quem está nela.`
          : c.mensagem || "O Tailscale não está pronto neste computador.";
  }
}

function syncTunnelUi() {
  const box = $("#hostTunnel");
  if (!box) return;
  box.hidden = !host.disponivel;
  if (!host.disponivel) return;

  const campo = $("#tunnelLink");
  const btn = $("#tunnelBtn");
  const texto = $("#tunnelBtnText");
  const dica = $("#tunnelHint");
  const ocupado = host.estado === "abrindo" || host.estado === "baixando" || host.estado === "verificando";
  const renovar = $("#tunnelRenew");

  btn.disabled = ocupado;
  campo.value = host.url ? host.linkPublico(roomLink()) || "" : "";
  // Link que não abre, ou que deu erro: outro na hora, sem sair da chamada.
  if (renovar) {
    renovar.hidden = !(host.estado === "pronto" || host.estado === "erro");
    renovar.disabled = ocupado;
  }

  if (host.estado === "pronto") {
    texto.textContent = "Copiar";
    dica.textContent =
      "Qualquer pessoa com este link entra na sala, de qualquer rede. Ele deixa de valer quando você fechar o Vcall.";
  } else if (ocupado) {
    texto.textContent = host.estado === "baixando" ? "Baixando…" : host.estado === "verificando" ? "Testando…" : "Abrindo…";
    dica.textContent =
      host.estado === "baixando"
        ? "Baixando o cloudflared do site oficial do Cloudflare. Só acontece na primeira vez."
        : host.estado === "verificando"
          ? "Conferindo se o link abre de fora, para você não mandar um link que não funciona…"
          : "Pedindo um endereço ao Cloudflare…";
  } else {
    texto.textContent = "Gerar link";
    dica.textContent =
      host.estado === "erro"
        ? "O link não ficou de pé. Veja se há internet e gere outro."
        : "O link acima só funciona nesta rede. Gere um link público para quem está fora dela.";
  }
}

if ($("#tunnelBtn")) {
  host.on("status", () => (syncTunnelUi(), syncTailscaleUi(), syncAppLink()));
  host.on("disponivel", () => (syncTunnelUi(), syncAppLink()));
  host.on("tailscale", () => (syncTailscaleUi(), syncAppLink()));

  /*
   * Pergunta ao servidor local se estamos dentro do aplicativo. Feito uma vez
   * na carga da página, antes de qualquer clique: assim o painel do túnel já
   * está certo quando a pessoa abre o "Convidar" pela primeira vez.
   */
  // Também mantém o batimento quando o token já veio na URL de abertura.
  if (host.disponivel) host.manterVivo();

  host.descobrir().then((sim) => {
    if (!sim) return;
    syncTunnelUi();
    syncAppLink();
    host.status().catch(() => {});
    host.conferirTailscale().then(syncTailscaleUi);
    avisarDeAtualizacao();
    contarPerfil();
  });


  on($("#tsBtn"), "click", async () => {
    if (host.ts.estado === "pronto") {
      const link = host.linkTailscale(roomLink());
      if (link) copy(link, "Link do Tailscale copiado");
      return;
    }
    try {
      await host.abrirTailscale();
      const link = host.linkTailscale(roomLink());
      if (link) copy(link, "Link do Tailscale criado e copiado");
    } catch (err) {
      if (err.message !== "cancelado") toast(err.message, { tone: "warn", ms: 10_000 });
    }
  });
  on($("#tsHabilitar"), "click", () => {
    // O app de mesa abre endereços https no navegador do sistema.
    if (host.ts.habilitar) window.open(host.ts.habilitar, "_blank", "noopener");
  });
  on($("#tsFechar"), "click", () => host.fecharTailscale());

  on($("#tunnelBtn"), "click", async () => {
    // Com o túnel já de pé, o botão vira "copiar": é o que se quer fazer em
    // seguida, e evita um segundo botão só para isso.
    if (host.estado === "pronto") {
      const link = host.linkPublico(roomLink());
      if (link) copy(link, "Link público copiado");
      return;
    }
    try {
      await host.abrirTunel();
      const link = host.linkPublico(roomLink());
      if (link) copy(link, "Link público criado e copiado");
    } catch (err) {
      toast("Não consegui gerar o link público agora. Confira a internet e tente de novo.", { tone: "warn", ms: 8000 });
    }
  });

  /*
   * Outro link, com a chamada no ar. Quem entrou pelo link antigo continua
   * conversando (a mídia vai direto, não passa pelo túnel) e recebe o novo
   * pela conexão direta, com um botão para reentrar por ele.
   */
  on($("#tunnelRenew"), "click", async () => {
    try {
      await host.abrirTunel({ novo: true });
      const link = host.linkPublico(roomLink());
      if (!link) return;
      copy(link, "Link novo criado e copiado");
      if (mesh.peers.size) mesh.broadcastBoard({ type: "link-novo", url: link }, { fallback: false });
    } catch (err) {
      toast("Não consegui gerar outro link agora. Confira a internet e tente de novo.", { tone: "warn", ms: 8000 });
    }
  });

}

on($("#inviteBtn"), "click", openInvite);

on($("#copyAppLinkBtn"), "click", () => {
  const link = inviteLink();
  if (link) copy(link, "Convite copiado");
});
on($("#whatsappBtn"), "click", () => {
  const link = inviteLink();
  if (!link) return;
  if (/^http:\/\/(127\.|localhost)/.test(link)) {
    toast("Esse link só abre neste computador. Gere o link público antes de mandar pelo WhatsApp.", {
      tone: "warn",
      ms: 6000,
    });
    return;
  }
  window.open(linkWhatsApp(link), "_blank", "noopener");
});

on($("#copyLinkBtn"), "click", () => copy(roomLink(), "Link copiado"));
on($("#copyCodeBtn"), "click", () => {
  if (!app.roomCode) return;
  copy(app.roomCode, `Código ${app.roomCode} copiado`);
});

/* ================================================================== *
 * Configurações
 * ================================================================== */

/**
 * Supressão de ruído por IA e sensibilidade de entrada, como no Discord: um
 * medidor mostra o seu volume ao vivo e a marca do limiar; o que fica abaixo
 * dela não é transmitido.
 */
function linhasVoz() {
  const ia = el("input", { type: "checkbox", checked: !!media.voz.ruido });
  ia.addEventListener("change", async () => {
    await media.setVoz({ ruido: ia.checked });
    toast(ia.checked ? "Supressão de ruído por IA ligada" : "Supressão de ruído por IA desligada", { tone: "info", ms: 2000, key: "voz" });
  });

  const limiar = media.voz.limiar;
  const modo = el("select.input", { "aria-label": "Sensibilidade de entrada" });
  for (const [v, t] of [
    ["auto", "Automática — a IA decide o que é voz"],
    ["manual", "Manual — eu escolho o volume mínimo"],
    ["off", "Desligada — o microfone transmite sempre"],
  ]) {
    modo.append(el("option", { value: v, text: t, selected: (typeof limiar === "number" ? "manual" : limiar) === v }));
  }
  const valor = typeof limiar === "number" ? limiar : -50;
  const faixa = el("input.medidor__faixa", { type: "range", min: "-80", max: "-10", step: "1", value: String(valor), "aria-label": "Volume mínimo para transmitir (dB)" });
  const nivel = el("span.medidor__nivel");
  const marca = el("span.medidor__marca");
  const rotulo = el("span.mono", { text: `${valor} dB` });
  const medidor = el("div.medidor", {}, [el("div.medidor__trilho", {}, [nivel, marca]), faixa]);
  const pos = (db) => `${Math.max(0, Math.min(100, ((db + 80) / 70) * 100))}%`;
  const pintarMarca = () => {
    marca.style.left = pos(Number(faixa.value));
    rotulo.textContent = `${faixa.value} dB`;
  };
  const linhaManual = el("div.row", { hidden: modo.value !== "manual" }, [medidor, rotulo]);
  pintarMarca();
  modo.addEventListener("change", () => {
    linhaManual.hidden = modo.value !== "manual";
    media.setVoz({ limiar: modo.value === "manual" ? Number(faixa.value) : modo.value });
  });
  faixa.addEventListener("input", () => {
    pintarMarca();
    media.setVoz({ limiar: Number(faixa.value) });
  });
  const aoNivel = ({ db, aberto }) => {
    if (!medidor.isConnected) return media.off?.("voz-nivel", aoNivel);
    nivel.style.width = pos(db);
    medidor.classList.toggle("is-aberto", !!aberto);
  };
  media.on("voz-nivel", aoNivel);

  /*
   * Ouvir a si mesmo: toca a trilha que vai para a sala, já com a supressão
   * de ruído e o portão. É o jeito de saber, sem ninguém do outro lado, se o
   * microfone certo está aberto e se a voz está passando.
   */
  let eco = null;
  const rotuloOuvir = el("span", { text: "Ouvir minha voz" });
  const ouvir = el("button.btn.btn--ghost", { type: "button", style: "align-self: flex-start" }, [icon("headphones", { size: "sm" }), rotuloOuvir]);
  const pararEco = () => {
    if (!eco) return;
    clearInterval(eco.vigia);
    eco.pause();
    eco.srcObject = null;
    eco = null;
    rotuloOuvir.textContent = "Ouvir minha voz";
  };
  ouvir.addEventListener("click", () => {
    if (eco) return pararEco();
    const trilha = media.micTrack;
    if (!trilha || trilha.readyState !== "live") return toast("Ligue o microfone para se ouvir.", { tone: "warn", key: "eco" });
    if (!trilha.enabled) toast("Seu microfone está desligado: ligue-o para se ouvir.", { tone: "warn", key: "eco" });
    eco = new Audio();
    eco.srcObject = new MediaStream([trilha]);
    if (audio.sinkId && eco.setSinkId) eco.setSinkId(audio.sinkId).catch(() => {});
    eco.play().catch(() => {});
    // Fechou as configurações: para de tocar.
    eco.vigia = setInterval(() => !ouvir.isConnected && pararEco(), 500);
    rotuloOuvir.textContent = "Parar de ouvir";
  });

  return [
    el("label.row", {}, [
      ia,
      el("div", {}, [
        el("div", { text: "Supressão de ruído por IA" }),
        el("div.field__hint", {
          text: "Uma rede neural (RNNoise) tira teclado, ventilador e barulho de fundo da sua voz — no seu computador, sem enviar áudio a ninguém.",
        }),
      ]),
    ]),
    el("label.field", {}, [
      el("span.field__label", { text: "Sensibilidade de entrada" }),
      modo,
      linhaManual,
      el("div.field__hint", {
        text: "Entre uma frase e outra o microfone fecha sozinho: a sala não ouve o que sobra do ambiente. A barra acende quando a sua voz está passando.",
      }),
    ]),
    el("div.field", {}, [
      el("span.field__label", { text: "Testar o microfone" }),
      ouvir,
      el("div.field__hint", { text: "Você ouve exatamente o que a sala ouve. Use fone de ouvido, senão o alto-falante volta para o microfone." }),
    ]),
  ];
}

/** Nome ou avatar trocados no meio da chamada: vale aqui e para os outros. */
function applyProfile(profile) {
  app.profile = { ...app.profile, ...profile };
  /*
   * Na recepção não há sala nem palco: as configurações abrem antes de
   * entrar, e mexer na malha aqui daria erro. Grava a preferência e para.
   */
  if (!app.room || !mesh?.selfId) {
    prefs.set("name", app.profile.name);
    prefs.set("avatar", app.profile.avatar);
    contarPerfil();
    return;
  }
  mesh.updateProfile(app.profile);
  const tile = stage.get("self", "cam");
  tile?.setName(`${app.profile.name} (você)`);
  tile?.setAvatarSpec(app.profile.avatar, app.profile.name);
  stage.get("self", "screen")?.setAvatarSpec(app.profile.avatar, app.profile.name);
  if (panel?.open && panel.tab === "people") renderPeopleNow();
}

/**
 * As configurações.
 *
 * Abre em dois lugares com conteúdos diferentes. Na RECEPÇÃO — antes de
 * entrar em qualquer sala — só existe o que faz sentido ali: perfil,
 * dispositivos, aparência e atualizações. Sensibilidade do microfone,
 * legendas, diagnóstico e qualidade da conexão dependem de uma chamada em
 * andamento e dariam erro, ou pior, mostrariam zeros convincentes.
 *
 * Poder escolher a câmera ANTES de aparecer para alguém era o motivo de
 * existir o botão na tela inicial.
 */
function openSettings({ naRecepcao = false } = {}) {
  const body = $("#settingsBody");
  body.replaceChildren();
  // A folha de atalhos usa o mesmo diálogo e troca o título; devolver aqui
  // evita "Atalhos do teclado" em cima das configurações.
  $("#settingsTitle").textContent = "Configurações";

  const section = (title, children, alvo = body) =>
    alvo.append(el("div.stack", {}, [el("h3", { text: title, style: { fontSize: "var(--text-md)" } }), ...children]));
  // Rede, servidor de apoio e diagnóstico: úteis para quem entende, ruído
  // para quem só quer ligar. Ficam fechados num "Avançado" no fim.
  // O conteúdo do <details> não herda o gap: as seções ficam num miolo próprio.
  const miolo = el("div.stack", { style: { gap: "var(--sp-5)", marginTop: "var(--sp-4)" } });
  const avancado = el("details.avancado", {}, [
    el("summary", { text: "Avançado", style: { cursor: "pointer", fontWeight: "600" } }),
    miolo,
  ]);
  const secaoAvancada = (title, children) => section(title, children, miolo);
  const fecharAvancado = () => miolo.children.length && body.append(avancado);

  // -- identidade --
  // O avatar é um botão: abre a grade de avatares (estilos, sortear, foto) e
  // a troca vale na hora, para você e para todo mundo da sala.
  /*
   * Na recepção ainda não existe perfil montado — ele nasce ao entrar na
   * sala. O editor precisa de um objeto de verdade, então aqui ele vem das
   * preferências guardadas, que é a mesma fonte que a antessala usa.
   */
  body.append(
    profileSection({
      profile: app.profile || { name: prefs.get("name", ""), avatar: semCartum(prefs.get("avatar", null)) || defaultAvatar() },
      onChange: (profile) => applyProfile(profile),
    }),
  );

  // -- dispositivos --
  const deviceRows = [];
  const mk = (kind, list, label) => {
    if (!list.length) return;
    const sel = el("select.input", { "aria-label": label });
    for (const d of list) {
      sel.append(
        el("option", {
          value: d.deviceId,
          text: d.label || label,
          selected: media.selected[kind] === d.deviceId,
        }),
      );
    }
    sel.addEventListener("change", () => media.selectDevice(kind, sel.value));
    deviceRows.push(el("label.field", {}, [el("span.field__label", { text: label }), sel]));
  };
  mk("audioinput", media.devices.audioinput, "Microfone");
  mk("videoinput", media.devices.videoinput, "Câmera");
  mk("audiooutput", media.devices.audiooutput, "Alto-falante");
  if (deviceRows.length) section("Dispositivos", deviceRows);
  section("Transmissão", [blocoDoCodificador()]);

  /*
   * Caminho curto da recepção. Tudo daqui para baixo — sensibilidade do
   * microfone, legendas, diagnóstico, qualidade da conexão — lê o estado de
   * uma chamada que ainda não começou. Mostrar esses painéis fora dela daria
   * erro ou, pior, números zerados com cara de medição de verdade.
   */
  if (naRecepcao) {
    section("Aparência", [seletorDeVisual(), themeRowDeConfiguracoes(), seletorDePaletas()]);
    if (host.disponivel) section("Atualizações", [blocoDeAtualizacao()]);
    if (host.disponivel) secaoAvancada("Rede Tailscale", [blocoDaRede()]);
    if (host.disponivel) secaoAvancada("Redes que bloqueiam a chamada", [blocoDoTurn()]);
    fecharAvancado();
    $("#settingsModal").showModal();
    animarEntradaDoDialogo($("#settingsModal"));
    return;
  }

  // -- áudio --
  const procToggle = el("input", { type: "checkbox", checked: media.processing });
  procToggle.addEventListener("change", async () => {
    await media.setProcessing(procToggle.checked);
    toast(
      procToggle.checked
        ? "Supressão de ruído ligada"
        : "Processamento desligado — melhor para música e instrumentos",
      { tone: "ok", ms: 3000 },
    );
  });
  const master = el("input", {
    type: "range",
    min: "0",
    max: "150",
    step: "5",
    value: String(Math.round(audio.master * 100)),
    style: { flex: "1" },
    "aria-label": "Volume geral",
  });
  const masterLabel = el("span.mono", { text: `${Math.round(audio.master * 100)}%` });
  master.addEventListener("input", () => {
    const v = audio.setMaster(Number(master.value) / 100);
    masterLabel.textContent = `${Math.round(v * 100)}%`;
  });

  const vad = el("input", {
    type: "range",
    min: "1",
    max: "20",
    step: "1",
    value: String(Math.round(mesh.vad.threshold * 100)),
    style: { flex: "1" },
    "aria-label": "Sensibilidade do detector de fala",
  });
  const vadLabel = el("span.mono", { text: `${Math.round(mesh.vad.threshold * 100)}` });
  vad.addEventListener("input", () => {
    const v = mesh.vad.setThreshold(Number(vad.value) / 100);
    vadLabel.textContent = String(Math.round(v * 100));
    prefs.set("vad:threshold", v);
  });

  section("Áudio", [
    el("label.field", {}, [
      el("span.field__label", { text: "Volume geral" }),
      el("div.row", {}, [icon("volume-2", { size: "sm" }), master, masterLabel]),
      el("div.field__hint", {
        text: "O volume de cada pessoa é ajustado no próprio quadradinho dela, passando o mouse por cima.",
      }),
    ]),
    el("label.field", {}, [
      el("span.field__label", { text: "Sensibilidade do indicador de fala" }),
      el("div.row", {}, [icon("mic", { size: "sm" }), vad, vadLabel]),
      el("div.field__hint", {
        text: "Mais baixo detecta sussurro e também o ventilador. Mais alto só acende quando você fala de verdade. O indicador aparece no seu próprio quadradinho e no dos outros.",
      }),
    ]),
    el("label.row", {}, [
      procToggle,
      el("div", {}, [
        el("div", { text: "Cancelamento de eco e supressão de ruído" }),
        el("div.field__hint", {
          text: "Feito para voz. Desligue se alguém for tocar um instrumento ou compartilhar som.",
        }),
      ]),
    ]),
    ...linhasVoz(),
  ]);

  // -- jogos e voz --
  const foco = el("input", { type: "checkbox", checked: !!app.focoVoz });
  foco.addEventListener("change", () => setFocoVoz(foco.checked));
  const linhasJogo = [
    el("label.row", {}, [
      foco,
      el("div", {}, [
        el("div", { text: "Foco na voz — apagar quem está calado" }),
        el("div.field__hint", {
          text: "Quem não está falando fica apagadinho e sem cor; quem fala acende com o anel da marca. Ótimo para jogar junto e para salas cheias. Tecla G.",
        }),
      ]),
    ]),
  ];
  if (window.vcallDesktop?.modoJogo) {
    const jogo = el("input", { type: "checkbox", checked: !!app.modoJogo });
    jogo.addEventListener("change", () => setModoJogo(jogo.checked));
    const canto = el("select.input", { "aria-label": "Canto da sobreposição" });
    for (const [v, t] of [
      ["tl", "Canto superior esquerdo"],
      ["tr", "Canto superior direito"],
      ["bl", "Canto inferior esquerdo"],
      ["br", "Canto inferior direito"],
    ]) {
      canto.append(el("option", { value: v, text: t, selected: prefs.get("modo-jogo:canto", "tl") === v }));
    }
    canto.addEventListener("change", () => {
      prefs.set("modo-jogo:canto", canto.value);
      if (app.modoJogo) setModoJogo(true, { avisar: false });
    });
    linhasJogo.push(
      el("label.row", {}, [
        jogo,
        el("div", {}, [
          el("div", { text: "Modo jogo — sobreposição por cima dos outros programas" }),
          el("div.field__hint", {
            text: "Uma janelinha transparente mostra quem está na chamada e acende quem fala, por cima do jogo (use o jogo em modo janela ou tela cheia sem bordas). Os cliques passam direto. Atalhos que valem dentro do jogo: Ctrl+Shift+M microfone, Ctrl+Shift+O mostra/esconde.",
          }),
        ]),
      ]),
      el("label.field", {}, [el("span.field__label", { text: "Onde a sobreposição fica" }), canto]),
    );
  }
  section("Jogos e voz", linhasJogo);

  // -- legendas, transcrição e avisos --
  const notifyToggle = el("input", { type: "checkbox", checked: app.notify });
  notifyToggle.addEventListener("change", async () => {
    notifyToggle.checked = await setNotifications(notifyToggle.checked);
  });

  const capRows = [
    el("label.row", {}, [
      notifyToggle,
      el("div", {}, [
        el("div", { text: "Avisar quando a aba estiver em segundo plano" }),
        el("div.field__hint", {
          text: "Mensagens novas, arquivos e quem entra na sala. Nada aparece enquanto a aba estiver à vista.",
        }),
      ]),
    ]),
  ];

  if (captionsSupported) {
    const langs = [
      ["pt-BR", "Português (Brasil)"],
      ["pt-PT", "Português (Portugal)"],
      ["en-US", "Inglês"],
      ["es-ES", "Espanhol"],
      ["fr-FR", "Francês"],
      ["de-DE", "Alemão"],
      ["it-IT", "Italiano"],
      ["ja-JP", "Japonês"],
    ];
    const sel = el("select.input", { "aria-label": "Idioma das legendas" });
    for (const [code, label] of langs) {
      sel.append(el("option", { value: code, text: label, selected: captions.lang === code }));
    }
    sel.addEventListener("change", () => {
      captions.lang = sel.value;
      prefs.set("captions:lang", sel.value);
      // O idioma entra no reconhecedor na criação: religar é o que o aplica.
      if (captions.enabled) {
        captions.stop();
        captions.start();
      }
    });
    if (window.vcallDesktop?.prepararWhisper) {
      const niveis = [
        ["rapida", "Rápida — 80 MB, para computadores modestos"],
        ["equilibrada", "Equilibrada — 250 MB, bem mais precisa (recomendada)"],
        ["maxima", "Máxima — a mais precisa, legenda mais lenta (mesmo download)"],
      ];
      const selN = el("select.input", { "aria-label": "Precisão das legendas" });
      for (const [v, t] of niveis) selN.append(el("option", { value: v, text: t, selected: captions.nivel === v }));
      selN.addEventListener("change", () => {
        captions.nivel = selN.value;
        prefs.set("captions:nivel", selN.value);
        if (captions.enabled) {
          captions.stop();
          captions.start();
        }
      });
      capRows.push(
        el("label.field", {}, [
          el("span.field__label", { text: "Precisão das legendas" }),
          selN,
          el("div.field__hint", {
            text: "O reconhecimento acontece no seu próprio computador: nenhum áudio sai daqui. Na primeira vez, o Vcall baixa o que precisa.",
          }),
        ]),
      );
    }
    capRows.push(
      el("label.field", {}, [
        el("span.field__label", { text: "Idioma das legendas" }),
        sel,
        el("div.field__hint", {
          text: "O reconhecimento é do navegador e acontece só no seu microfone. Os outros recebem texto, não áudio.",
        }),
      ]),
    );
  } else {
    capRows.push(
      el("div.field__hint", {
        text: "Este navegador não transcreve fala — no Chrome ou no Edge funciona. Ler as legendas de quem ligar o recurso funciona em qualquer navegador.",
      }),
    );
  }

  const saveTranscript = el("button.btn", {
    type: "button",
    text: "Baixar a transcrição",
    onClick: () => baixarTranscricao("txt"),
  });
  const selT = el("select.input", { "aria-label": "Tamanho das legendas" });
  for (const [v, t] of [["p", "Pequena"], ["m", "Média"], ["g", "Grande"]]) {
    selT.append(el("option", { value: v, text: t, selected: (prefs.get("captions:tamanho", "m")) === v }));
  }
  selT.addEventListener("change", () => {
    prefs.set("captions:tamanho", selT.value);
    document.documentElement.dataset.legenda = selT.value;
  });
  capRows.push(el("label.field", {}, [el("span.field__label", { text: "Tamanho das legendas na tela" }), selT]));
  capRows.push(
    el("div.row", {}, [
      saveTranscript,
      el("span.muted", { text: `${captions.transcript.length} falas registradas` }),
    ]),
  );

  capRows.push(
    el("button.btn", {
      type: "button",
      text: "Revisar permissões de câmera, microfone e avisos",
      onClick: () => revisarPermissoes(),
    }),
  );

  section("Legendas e avisos", capRows);

  // -- tema --
  const themeRow = themeRowDeConfiguracoes();
  section("Aparência", [seletorDeVisual(), themeRow, seletorDePaletas()]);

  // -- diagnóstico de áudio: responde "por que não ouço ninguém?" --
  const audioReport = el("div.field__hint", { text: "Medindo…" });
  const refreshAudio = async () => {
    const dbg = audio.debug();
    const peers = mesh.roster().filter((p) => !p.self);
    if (!peers.length) {
      audioReport.textContent = "Ninguém mais na sala para medir.";
      return;
    }
    const linhas = [];
    for (const p of peers) {
      let pico = 0;
      for (let i = 0; i < 10; i += 1) {
        const l = audio.meter(p.id, "mic");
        if (l != null) pico = Math.max(pico, l);
        await new Promise((r) => setTimeout(r, 40));
      }
      const saida = dbg.outputs.find((o) => o.key === `${p.id}:mic`);
      linhas.push(
        `${p.name}: ${saida ? (saida.paused ? "pausado" : "tocando") : "SEM SAÍDA"}` +
          `, volume ${Math.round((saida?.gain ?? 0) * 100)}%` +
          `, sinal ${pico > 0.005 ? "sim" : "NÃO"}`,
      );
    }
    const somDoApp = { running: "ligado", suspended: "pausado", closed: "fechado" }[dbg.contextState] || dbg.contextState;
    audioReport.textContent =
      `Som do Vcall: ${somDoApp}${dbg.blocked ? " (BLOQUEADO)" : ""} · ` +
      `volume geral ${Math.round(dbg.master * 100)}%\n` +
      linhas.join("\n");
  };
  audioReport.style.whiteSpace = "pre-line";
  audioReport.style.fontFamily = "var(--font-mono)";
  refreshAudio();

  // -- sobre --
  const about = el("div.field__hint", { text: "Conferindo…" });
  fetch("/healthz", { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => {
      about.textContent = `Versão ${v.version}`;
      // Compilação e data continuam à mão de quem dá suporte, sem poluir.
      about.title = `Compilação ${v.build} · ${v.files} arquivos` +
        (v.builtAt ? ` · ${new Date(v.builtAt).toLocaleString("pt-BR")}` : "");
    })
    .catch(() => {
      about.textContent = "Não foi possível consultar a versão.";
    });
  section("Sobre esta versão", [
    about,
    el("div.field__hint", { style: { opacity: "0.6" } }, [
      "Desenvolvido por Victor Kauan · ",
      el("a", {
        href: "https://github.com/victor-kauan-coder",
        target: "_blank",
        rel: "noopener noreferrer",
        text: "victor-kauan-coder",
      }),
    ]),
  ]);

  // -- avançado: rede, servidor de apoio, conexão e diagnóstico --
  const cfg = mesh.iceConfig || {};
  if (host.disponivel) secaoAvancada("Rede Tailscale", [blocoDaRede()]);
  if (host.disponivel) secaoAvancada("Redes que bloqueiam a chamada", [blocoDoTurn()]);
  secaoAvancada("Conexão", [
    el("div.field__hint", {
      text: cfg.hasTurn
        ? "Servidor de apoio ligado: a chamada funciona mesmo em redes que bloqueiam a conexão direta."
        : "Em redes de empresa, de faculdade ou de algumas operadoras de 4G a chamada pode não conectar." +
          (host.disponivel ? " Se acontecer, configure um servidor de apoio logo acima." : " Se acontecer, tente outra rede."),
    }),
    el("div.field__hint", {
      text: `Limite da sala: ${app.maxPeers} participantes. O vídeo vai direto de cada pessoa para todas as outras, então salas maiores pesariam no computador e na internet de todo mundo.`,
    }),
  ]);
  secaoAvancada("Diagnóstico do áudio", [
    audioReport,
    el("button.btn", { type: "button", text: "Medir de novo", onClick: refreshAudio }),
    el("div.field__hint", {
      text: "Se aparecer “SEM SAÍDA” ou “BLOQUEADO”, o som está parando antes do seu alto-falante. Copie este texto se for pedir ajuda.",
    }),
  ]);
  fecharAvancado();

  $("#settingsModal").showModal();
}

/* ================================================================== *
 * Atalhos
 * ================================================================== */

function bindShortcuts() {
  on(document, "keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.target instanceof HTMLSelectElement || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Com um diálogo aberto (Configurações, perfil, convite), as teclas são
    // dele. Antes o Escape era capturado aqui e o diálogo não fechava, e uma
    // letra como "P" mexia no painel por trás dele.
    if (document.querySelector("dialog[open]")) return;

    /*
     * Com o canvas aberto, as letras pertencem a ele. Antes as duas camadas
     * ouviam a mesma tecla: "L" escolhia o ponteiro laser e ao mesmo tempo
     * trocava o layout do palco, e "N", "F" ou "G" disparavam o que não devia.
     * Escape continua chegando aqui, porque é como se fecha o canvas.
     */
    // "?" passa também: é com o canvas aberto que a lista de atalhos é mais
    // procurada, e a maioria deles é dele.
    if (app.boardMode && e.key !== "Escape" && e.key !== "?") return;

    // Com o menu de reagir aberto, 1 a 9 reagem direto (dá para fazer combo no teclado).
    if (/^[1-9]$/.test(e.key) && document.querySelector(".popover--reactions")) {
      const r = REACOES[Number(e.key) - 1];
      if (r) reagir(r.id);
      return;
    }

    switch (e.key.toLowerCase()) {
      case "r":
        openReactionMenu();
        break;
      case "m":
        media.toggleMic();
        syncDockMedia();
        break;
      case "v":
        media.toggleCam().then(syncDockMedia);
        break;
      case "s":
        if (env.canShareScreen) toggleScreen();
        break;
      case "q":
        app.boardMode ? closeBoard() : openBoard(screen.active ? "annotate" : "board");
        break;
      case "k":
        jogos?.aberto ? fecharJogos() : abrirJogos();
        break;
      case "d":
        toggleDeafen();
        break;
      case "h":
        toggleHand();
        break;
      case "t":
        toggleCaptions();
        break;
      case "?":
      case "/":
        openShortcuts();
        break;
      case "c":
        panel.toggle("chat");
        break;
      case "p":
        panel.toggle("people");
        break;
      case "l":
        dock.get("layout")?.click();
        break;
      case "j":
        dock.get("mini")?.click();
        break;
      case "g":
        toast(setFocoVoz(!app.focoVoz) ? "Foco na voz: quem está calado fica apagado" : "Foco na voz desligado", {
          tone: "info",
          ms: 2200,
          key: "foco",
        });
        break;
      case "escape":
        // Com algo selecionado, Escape desfaz a seleção — fechar o canvas
        // inteiro por causa de um clique errado seria um exagero. O próprio
        // canvas cuida de limpá-la; aqui só não se atropela isso.
        if (app.boardMode && board?.selection.size) return;
        if (app.boardMode) closeBoard();
        else if (panel.open) panel.setOpen(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // Barra de espaço: fala enquanto segura (como um rádio).
  let pushed = false;
  on(document, "keydown", (e) => {
    if (e.code !== "Space" || e.repeat || pushed) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // No canvas, segurar espaço é arrastar o plano. Abrir o microfone junto
    // punha a pessoa no ar sem que ela soubesse, só por ter navegado.
    if (app.boardMode) return;
    if (media.micEnabled) return;
    pushed = true;
    media.setMic(true);
    syncDockMedia();
    toast("Falando enquanto a barra de espaço estiver pressionada", { tone: "info", ms: 1500, key: "ptt" });
    e.preventDefault();
  });
  on(document, "keyup", (e) => {
    if (e.code !== "Space" || !pushed) return;
    pushed = false;
    media.setMic(false);
    syncDockMedia();
  });
}

/* ================================================================== *
 * Saída
 * ================================================================== */

function leaveCall({ motivo = null, por = "" } = {}) {
  if (app.left) return;
  app.left = true;
  // A sobreposição e os atalhos globais só fazem sentido dentro da chamada.
  if (app.modoJogo) window.vcallDesktop?.modoJogo?.(false).catch?.(() => {});
  clearInterval(app.timerId);
  app.mini?.close();
  closeBoard();
  fecharJogos();
  camadaReacoes.destruir();
  captions.stop();
  captions.unmount();
  if (recorder.recording) recorder.stop();
  screen.stop("leave");
  audio.stop();
  mesh.leave();
  closeAudio();
  media.stop();
  stage.clearAll();

  // A faixa de arrastar do app de mesa sobrevive à troca de tela.
  const drag = $(".win-drag");
  const minutos = formatDuration((Date.now() - app.startedAt) / 1000);
  const inicio = () => location.assign(location.origin + location.pathname);
  const tela = el("main.leave", { "aria-labelledby": "leaveTitle" }, [
    el("div.leave__art", { "aria-hidden": "true" }, [
      // Quem foi barrado fica do lado de fora da porta; quem saiu, se despede.
      ilustracao(motivo === "kicked" || motivo === "room-locked" ? "sala-de-espera" : "chamada-encerrada", { largura: 320, altura: 240 }),
    ]),
    el("div.leave__body", {}, [
      el("img.brand__mark", { src: "/assets/logo-mark.svg", alt: "", width: 48, height: 48 }),
      el("h1.leave__title", { id: "leaveTitle" },
        motivo === "kicked"
          ? duo("Você foi removido da sala", "Você foi removido da reunião")
          : motivo === "room-locked"
            ? duo("Esta sala está trancada", "Esta reunião está trancada")
            : duo("Você saiu da chamada", "Você saiu da reunião"),
      ),
      el("p.leave__lead", {},
        motivo === "kicked"
          ? [`${por || "O anfitrião"} removeu você desta chamada. Se foi um engano, peça para ele deixar você voltar e tente de novo.`]
          : motivo === "room-locked"
            ? ["O anfitrião trancou a sala ou não liberou a sua entrada. Combine com quem te convidou e tente de novo."]
            : duo(
                `Foram ${minutos} de conversa. A sala continua aberta enquanto alguém estiver nela — dá para voltar pelo mesmo link.`,
                `Foram ${minutos} de reunião. Ela continua aberta enquanto houver alguém: dá para voltar pelo mesmo link.`,
              ),
      ),
      el("div.leave__actions", {}, [
        el("button.btn.btn--primary.btn--lg", { type: "button", onClick: () => location.reload() }, [
          icon("rotate-ccw"),
          el("span", {},
            motivo === "kicked" ? ["Tentar entrar de novo"] : motivo === "room-locked" ? ["Tentar de novo"] : duo("Voltar para a sala", "Participar novamente"),
          ),
        ]),
        el("button.btn.btn--lg", { type: "button", onClick: inicio }, [
          icon("layout-grid"),
          el("span", { text: "Ir para o início" }),
        ]),
        el("button.btn.btn--ghost.btn--lg", {
          type: "button",
          onClick: () => {
            location.hash = newRoomId();
            location.reload();
          },
        }, [icon("plus"), el("span", {}, duo("Nova sala", "Nova reunião"))]),
      ]),
    ]),
  ]);
  swap(() =>
    document.body.replaceChildren(...[drag, el("div.ambient", { "aria-hidden": "true" }), tela].filter(Boolean)),
  ).then(() =>
    stagger(tela.querySelectorAll(".leave__art, .leave__body > *"), { gap: 60 }),
  );
}

// Sair fechando a aba: avisa os outros em vez de deixar um retângulo fantasma.
on(window, "pagehide", () => {
  if (app.joined) signaling.close();
});

/* ================================================================== *
 * Diagnóstico no console
 * ================================================================== */

window.vcall = {
  mesh,
  media,
  screen,
  audio,
  captions,
  recorder,
  transfer,
  get board() {
    return board;
  },
  get stage() {
    return stage;
  },
  get stats() {
    return mesh.stats.samples;
  },
  setFocoVoz,
  setModoJogo,
  testarTurn,
  jogosEstado,
  jogos: jogosLogicas,
};
console.info(
  "%cVcall%c — mídia ponto a ponto, criptografada. `window.vcall` expõe o estado para depuração." +
    "\nDesenvolvido por Victor Kauan · github.com/victor-kauan-coder",
  "font-weight:700;color:#fd4d87",
  "color:inherit",
);

/*
 * Tela de erro própria quando o túnel cai (public/sw.js). Só para quem entra
 * pelo link público (https); no computador de quem criou a sala a página vem
 * do servidor local e não passa por túnel nenhum.
 */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
