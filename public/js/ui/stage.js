/**
 * ui/stage.js — a grade de vídeo.
 *
 * Cada participante pode ocupar até dois ladrilhos: a câmera e a tela
 * compartilhada. Tratá-los como ladrilhos independentes (em vez de um só que
 * alterna) é o que permite ver o rosto de quem apresenta ao lado do que ele
 * está apresentando.
 *
 * Regras de layout, nesta ordem de prioridade:
 *   1. alguém fixado manualmente vence;
 *   2. senão, uma tela compartilhada vai para o destaque;
 *   3. senão, quem está falando ocupa o destaque, se o modo destaque estiver
 *      ligado;
 *   4. senão, grade igualitária.
 */
import { el, icon, clear, setIcon } from "../lib/dom.js";
import { avatarEl, corDoAvatar, setAvatar } from "./avatars.js";
import { QUALITY_ICON, QUALITY_LABEL } from "../core/stats.js";
import { SPRING, animate, burst, calm, flip } from "./motion.js";
import { env, prefs } from "../lib/util.js";

const CONNECTION_TEXT = {
  new: "Conectando…",
  connecting: "Conectando…",
  restarting: "Reconectando…",
  disconnected: "Sinal instável…",
  failed: "Conexão perdida",
  exhausted: "Não foi possível reconectar",
  closed: "Desconectado",
};

const TOQUE = typeof matchMedia === "function" && env.isTouch; // os testes carregam este módulo no Node

/**
 * Gira o celular na tela cheia ("paisagem" | "retrato") e destrava ao sair ("").
 * O WebView do app Android não tem screen.orientation.lock: lá quem gira é o
 * app, pela ponte (Ponte.girar).
 */
function girar(o) {
  if (window.VcallAndroid?.girar) return window.VcallAndroid.girar(o);
  try {
    if (o) screen.orientation?.lock?.(o === "paisagem" ? "landscape" : "portrait").catch(() => {});
    else screen.orientation?.unlock?.();
  } catch {
    /* navegador sem trava de orientação */
  }
}

class Tile {
  #vezDoFundo = 0;

  constructor({ id, peerId, kind, name, avatar, self }) {
    this.id = id;
    this.peerId = peerId;
    this.kind = kind; // "cam" | "screen"
    this.self = self;
    this.pinned = false;

    this.node = el("figure.tile", {
      class: kind === "screen" ? "tile--screen" : "",
      dataset: { tile: id, kind },
      tabindex: "0",
    });

    this.video = el("video.tile__video", {
      autoplay: true,
      playsInline: true,
      // Vídeo local é sempre mudo: o contrário produz microfonia imediata.
      muted: self,
    });
    this.video.setAttribute("playsinline", "");
    if (self && kind === "cam") this.video.classList.add("is-mirrored");

    this.avatarBox = el("div.tile__avatar", {}, [avatarEl(avatar, { title: name })]);
    this.#pintarFundo(avatar);

    this.netBox = el("div.tile__net", { dataset: { quality: "unknown" } }, [
      icon(QUALITY_ICON.unknown, { size: "sm", label: QUALITY_LABEL.unknown }),
    ]);

    this.micIcon = icon("mic", { size: "sm" });
    this.nameEl = el("span.truncate", { text: name });
    this.label = el("figcaption.tile__label", {}, [this.micIcon, this.nameEl]);

    this.actions = el("div.tile__actions");
    this.espera = el("div.tile__espera", { "aria-hidden": "true" }, [
      el("span.tile__espera-anel"),
      el("span", { text: kind === "screen" ? "Carregando a tela…" : "Carregando o vídeo…" }),
    ]);
    this.node.append(this.video, this.avatarBox, this.espera, this.netBox, this.label, this.actions);

    // O enquadramento muda quando o vídeo muda de tamanho (o celular virou)
    // e quando o quadro muda (alguém entrou, a grade se reorganizou).
    if (kind === "cam") {
      const enquadrar = () => this.#enquadrar();
      for (const ev of ["loadedmetadata", "resize"]) this.video.addEventListener(ev, enquadrar);
      this.observador = new ResizeObserver(enquadrar);
      this.observador.observe(this.node);
    }

    this.setCamera(null);
  }

  /**
   * Câmera em pé num quadro deitado (o celular visto do computador), ou o
   * contrário: com `object-fit: cover` sobrava só uma faixa do meio do rosto.
   * Quando o corte esconderia mais de ~30% da imagem, o vídeo aparece
   * inteiro, com o fundo do quadro dos lados. Diferenças pequenas (4:3 num
   * quadro 16:9) continuam preenchendo o quadro.
   */
  #enquadrar() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    const { clientWidth: tw, clientHeight: th } = this.node;
    if (!vw || !vh || !tw || !th) return;
    const video = vw / vh;
    const quadro = tw / th;
    const visivel = video > quadro ? quadro / video : video / quadro;
    this.video.classList.toggle("is-inteiro", visivel < 0.7);
  }

  /**
   * Volume deste participante, 0 a 150%. Vale para a voz e para o som da tela
   * dele — é a mesma pessoa, e separar os dois só confundiria.
   */
  addVolume({ value = 1, onChange, onToggle, name = "" }) {
    const wrap = el("div.vol");

    const btn = el("button.vol__btn", {
      type: "button",
      "aria-label": `Volume de ${name}`,
      dataset: { tip: "Silenciar", "tip-placement": "bottom" },
      onClick: (e) => {
        e.stopPropagation();
        onToggle();
      },
    });
    btn.append(icon("volume-2", { size: "sm" }));

    const slider = el("input.vol__slider", {
      type: "range",
      min: "0",
      max: "150",
      step: "5",
      value: String(Math.round(value * 100)),
      "aria-label": `Volume de ${name} em porcento`,
      onInput: (e) => {
        this.#pintarVolume(Number(e.target.value));
        onChange(Number(e.target.value) / 100);
      },
      onClick: (e) => e.stopPropagation(),
      onPointerdown: (e) => e.stopPropagation(),
      onDblclick: (e) => e.stopPropagation(),
    });

    // A rampa: barras que sobem da esquerda para a direita, pintadas no
    // degradê da marca até o volume atual. Acima de 100% é ganho — as barras
    // do fim acendem em laranja. O <input> continua por baixo (teclado, leitor
    // de tela); a rampa é o desenho dele.
    const rampa = el("span.vol__rampa", { "aria-hidden": "true" });
    for (let i = 0; i < 10; i += 1) rampa.append(el("i", { style: { "--i": String(i) } }));
    const pct = el("span.vol__pct", { "aria-hidden": "true" });
    const trilho = el("span.vol__trilho", {}, [rampa, slider]);
    wrap.append(btn, trilho, pct);
    this.volumeEl = wrap;
    this.node.append(wrap);
    this.setVolume(value);
    return wrap;
  }

  #pintarVolume(pct) {
    if (!this.volumeEl) return;
    // 10 barras para 0–150%: cada uma vale 15%.
    this.volumeEl.style.setProperty("--acesas", String(Math.round(pct / 15)));
    this.volumeEl.classList.toggle("is-boost", pct > 100);
    const rotulo = this.volumeEl.querySelector(".vol__pct");
    if (rotulo) rotulo.textContent = pct === 0 ? "mudo" : `${pct}%`;
  }

  setVolume(value) {
    if (!this.volumeEl) return;
    const pct = Math.round(value * 100);
    this.#pintarVolume(pct);
    const slider = this.volumeEl.querySelector(".vol__slider");
    if (slider && document.activeElement !== slider) slider.value = String(pct);
    const btn = this.volumeEl.querySelector(".vol__btn");
    setIcon(btn.querySelector("svg"), pct === 0 ? "volume-x" : "volume-2");
    btn.classList.toggle("is-muted", pct === 0);
    btn.dataset.tip = pct === 0 ? "Ativar som" : `Silenciar · ${pct}%`;
    this.volumeEl.dataset.level = String(pct);
  }

  addAction({ iconName, label, onClick, pressed = null }) {
    const b = el("button.tile__action", {
      type: "button",
      "aria-label": label,
      dataset: { tip: label, "tip-placement": "bottom", acao: iconName },
      onClick: (e) => {
        e.stopPropagation();
        onClick(b);
      },
    });
    if (pressed !== null) b.setAttribute("aria-pressed", String(pressed));
    b.append(icon(iconName, { size: "sm" }));
    this.actions.append(b);
    return b;
  }

  /**
   * Liga o <video> a um stream.
   *
   * "CARREGANDO" SÓ VALE PARA VÍDEO QUE ESTÁ VINDO.
   *
   * Câmera fechada não é vídeo demorando: é vídeo que não existe, e o
   * ladrilho tem de mostrar o avatar. Antes bastava haver um stream para o
   * aviso aparecer — e o stream continua existindo com a trilha de vídeo
   * desligada, então quem fechava a câmera ficava com "Carregando o vídeo…"
   * para sempre, por cima de um retângulo preto.
   *
   * O que decide é a TRILHA: viva, habilitada e não silenciada pela outra
   * ponta. Fora disso, avatar.
   *
   * MAS NA TELA, `muted` NÃO É "DESLIGADA".
   *
   * Tela parada manda pouco quadro (só o repetido, ~1 por segundo), e o
   * navegador de quem recebe marca a trilha como muda entre um quadro e
   * outro. Tratado como câmera fechada, o ladrilho trocava a tela pelo avatar
   * e voltava a cada 1–3 s: era a "tela que cai e volta". Na tela, o <video>
   * segura o último quadro; quem diz que a pessoa parou é o estado anunciado
   * por ela (o ladrilho inteiro sai), não o silêncio da trilha.
   */
  setStream(stream) {
    const tela = this.kind === "screen";
    const faixa = stream?.getVideoTracks?.().find((t) => t.readyState === "live" && t.enabled && (tela || !t.muted));

    if (!stream || !faixa) {
      this.node.classList.remove("is-waiting");
      this.video.srcObject = null;
      this.video.hidden = true;
      this.avatarBox.hidden = false;
      // Religa sozinho quando a pessoa reabrir a câmera do outro lado.
      this.#vigiarTrilha(stream);
      return;
    }

    if (this.video.srcObject !== stream) {
      this.video.srcObject = stream;
      // Até o primeiro quadro, o ladrilho diz que está carregando em vez de
      // mostrar um retângulo preto que parece defeito.
      if (this.video.readyState < 2) {
        this.node.classList.add("is-waiting");
        this.#esperarPrimeiroQuadro();
      }
    }
    this.video.hidden = false;
    this.avatarBox.hidden = true;
    this.#vigiarTrilha(stream);
    // Autoplay pode ser recusado; o catch evita uma promessa rejeitada solta.
    this.video.play?.().catch(() => {});
  }

  /**
   * Acompanha a trilha de vídeo para o ladrilho reagir sozinho.
   *
   * Quem está do outro lado abre e fecha a câmera sem renegociar nada: a
   * mesma trilha apenas silencia (`mute`) e volta (`unmute`). Sem escutar
   * isso, o ladrilho congela no estado em que estava.
   */
  #vigiarTrilha(stream) {
    const faixa = stream?.getVideoTracks?.()[0] || null;
    if (this.trilhaVigiada === faixa) return;
    if (this.trilhaVigiada && this.aoMudarTrilha) {
      for (const ev of ["mute", "unmute", "ended"]) {
        this.trilhaVigiada.removeEventListener(ev, this.aoMudarTrilha);
      }
    }
    this.trilhaVigiada = faixa;
    if (!faixa) return;
    this.aoMudarTrilha = () => this.setStream(this.trilhaVigiada ? stream : null);
    for (const ev of ["mute", "unmute", "ended"]) faixa.addEventListener(ev, this.aoMudarTrilha);
  }

  /**
   * Tira o "Carregando o vídeo…" quando o vídeo realmente começa.
   *
   * Antes isso dependia de `loadeddata` e `resize` com `{ once: true }`. Dois
   * jeitos de o aviso ficar presto por cima de um vídeo que já está tocando:
   * o palco REMONTA o ladrilho no DOM a cada reorganização (grade, destaque,
   * balão), e mover um <video> pode engolir o evento que já estava a caminho;
   * e `once` queima o ouvinte na primeira vez, mesmo que o quadro não tenha
   * vindo. Aqui a condição é verificada, não o evento: vale `readyState` ou
   * `videoWidth`, e só então os ouvintes saem.
   */
  #esperarPrimeiroQuadro() {
    const eventos = ["loadeddata", "loadedmetadata", "canplay", "playing", "resize", "timeupdate"];
    const conferir = () => {
      if (this.video.readyState < 2 && !this.video.videoWidth) return;
      this.node.classList.remove("is-waiting");
      for (const ev of eventos) this.video.removeEventListener(ev, conferir);
    };
    for (const ev of eventos) this.video.addEventListener(ev, conferir);
    conferir();
  }

  setCamera(stream) {
    if (this.kind !== "cam") return;
    this.setStream(stream);
  }

  setName(name) {
    this.nameEl.textContent = name;
  }

  setAvatarSpec(spec, name) {
    setAvatar(this.avatarBox.firstElementChild, spec);
    this.avatarBox.firstElementChild?.setAttribute("aria-label", `Avatar de ${name}`);
    this.#pintarFundo(spec);
  }

  /**
   * O fundo de quem está sem câmera ganha o tom do próprio avatar (a cor
   * final é decidida em .tile__avatar, no app.css). A troca de avatar no meio
   * da chamada pode chegar antes da cor do anterior; só a última vale.
   */
  #pintarFundo(spec) {
    const vez = ++this.#vezDoFundo;
    corDoAvatar(spec).then((cor) => {
      if (vez !== this.#vezDoFundo) return;
      this.avatarBox.classList.toggle("tem-ambiente", !!cor);
      if (cor) this.avatarBox.style.setProperty("--amb", cor);
    });
  }


  setMic(on) {
    setIcon(this.micIcon, on ? "mic" : "mic-off");
    this.micIcon.classList.toggle("icon--muted", !on);
  }

  setSpeaking(on) {
    if (this.kind !== "cam") return;
    this.node.classList.toggle("is-speaking", !!on);
  }

  /**
   * Intensidade da voz, 0 a 1. Alimenta a barrinha ao lado do nome: o contorno
   * diz "está falando", a barra diz "quanto" — e juntas tornam óbvio de quem é
   * a voz que se está ouvindo.
   */
  /**
   * Intensidade da voz, 0 a 1.
   *
   * Vira um equalizador de três barras ao lado do nome. A barra única anterior
   * dizia a mesma coisa, mas parecia uma barra de progresso — e "progresso" não
   * é o que uma voz tem. Três barras de alturas diferentes é a forma que todo
   * mundo já lê como som, e ocupa menos espaço.
   *
   * O valor sai daqui como número puro, sem unidade, e o CSS o usa em
   * `scaleY`. Isso importa para o consumo: `transform` e `opacity` são as duas
   * únicas propriedades que o navegador anima sem refazer layout nem pintura,
   * e esta função roda a cada quadro para cada participante.
   */
  setLevel(level) {
    if (this.kind !== "cam") return;
    if (!this.eqEl) {
      this.eqEl = el("span.tile__eq", { "aria-hidden": "true" }, [
        el("i"),
        el("i"),
        el("i"),
      ]);
      this.label.insertBefore(this.eqEl, this.nameEl);
    }
    // A voz normal ocupa uma fatia pequena do medidor; sem este ganho as
    // barras mal sairiam do lugar em quem fala baixo.
    const v = Math.min(1, level * 3.2);
    // O anel da marca gira na velocidade da voz: fala mais alto, gira mais
    // rápido; em silêncio ele para onde estava. É a voz desenhada, não um
    // pulso de relógio.
    // No celular o anel não gira: repintar o degradê cônico a cada quadro era
    // caro para a placa de vídeo. Ele continua acendendo com a voz (--lv).
    if (v > 0.05 && !TOQUE) {
      this.spin = ((this.spin || 0) + 1.5 + v * 9) % 360;
      this.node.style.setProperty("--spin", `${this.spin.toFixed(1)}deg`);
    }
    if (Math.abs(v - (this.lastLevel || 0)) < 0.02) return; // evita escrita inútil
    this.lastLevel = v;
    this.node.style.setProperty("--lv", v.toFixed(2));
    this.eqEl.classList.toggle("is-live", v > 0.05);
  }

  /**
   * "Você está apresentando". Substitui a prévia ao vivo quando a própria tela
   * inteira está sendo compartilhada.
   *
   * A prévia da tela inteira mostra a janela do Vcall, que mostra a prévia,
   * que mostra a janela… — o efeito sala de espelhos. Além de feio, ele faz
   * cada quadro ser diferente do anterior: o encoder trabalha no máximo o
   * tempo todo, a subida de rede satura e, em máquina ou internet mais
   * modesta, a chamada cai. Com o aviso no lugar, a imagem enviada fica
   * parada quando nada muda — como deve ser.
   */
  setPresenting(on, { label = "Você está compartilhando a tela inteira" } = {}) {
    if (!on) {
      this.presentEl?.remove();
      this.presentEl = null;
      this.video.classList.remove("is-concealed");
      return;
    }
    if (this.presentEl) return;
    const ver = el("button.btn.btn--ghost.tile__presentBtn", { type: "button" }, [
      icon("eye", { size: "sm" }),
      el("span", { text: "Ver prévia" }),
    ]);
    ver.addEventListener("click", (e) => {
      e.stopPropagation();
      const oculto = this.video.classList.toggle("is-concealed");
      this.presentEl.classList.toggle("is-peek", !oculto);
      ver.lastElementChild.textContent = oculto ? "Ver prévia" : "Esconder prévia";
    });
    this.presentEl = el("div.tile__present", {}, [
      icon("screen-share", { size: "xl" }),
      el("strong", { text: label }),
      el("span", { text: "Quem clicar em Assistir vê a sua tela. A prévia fica escondida para não gerar o efeito espelho." }),
      ver,
    ]);
    this.video.classList.add("is-concealed");
    this.node.append(this.presentEl);
  }

  /**
   * Como no Discord: a tela de outra pessoa que eu não estou assistindo. O
   * ladrilho só convida; nada da tela chega até clicar em Assistir
   * (mesh.assistirTela). `nome` vazio tira o convite.
   */
  setConvite(nome, onAssistir) {
    this.convite = !!nome;
    this.node.classList.toggle("is-convite", this.convite);
    if (!nome) {
      this.conviteEl?.remove();
      this.conviteEl = null;
      return;
    }
    if (document.fullscreenElement === this.node) document.exitFullscreen().catch(() => {});
    if (this.conviteEl) return;
    const assistir = el("button.btn.btn--primary.tile__assistir", {
      type: "button",
      onClick: (e) => {
        e.stopPropagation();
        onAssistir();
      },
    }, [icon("eye", { size: "sm" }), el("span", { text: "Assistir" })]);
    this.conviteEl = el("div.tile__present.tile__convite", {}, [
      icon("screen-share", { size: "xl" }),
      el("strong", { text: `${nome} está transmitindo` }),
      assistir,
    ]);
    this.node.append(this.conviteEl);
  }

  setPinned(on) {
    this.pinned = on;
    this.node.classList.toggle("is-pinned", on);
  }

  setQuality(quality) {
    this.netBox.dataset.quality = quality;
    const svg = this.netBox.querySelector("svg.icon");
    setIcon(svg, QUALITY_ICON[quality] || QUALITY_ICON.unknown);
    svg?.querySelector("title")?.replaceChildren(QUALITY_LABEL[quality] || "");
  }

  setHand(up) {
    if (up && !this.handEl) {
      this.handEl = el("div.tile__hand", {}, [icon("hand", { size: "sm", label: "Mão levantada" })]);
      this.node.append(this.handEl);
    } else if (!up && this.handEl) {
      this.handEl.remove();
      this.handEl = null;
    }
  }

  setConnection(state) {
    const text = CONNECTION_TEXT[state];
    if (!text) {
      this.statusEl?.remove();
      this.statusEl = null;
      return;
    }
    if (!this.statusEl) {
      this.statusEl = el("div.tile__status");
      this.node.append(this.statusEl);
    }
    clear(this.statusEl);
    const spinning = state === "connecting" || state === "new" || state === "restarting";
    this.statusEl.append(
      icon(spinning ? "spinner" : "wifi-off", { size: "lg", className: spinning ? "icon--spin" : "" }),
      el("span", { text }),
    );
  }

  /** Mostra uma reação flutuante sobre o ladrilho. */
  react(iconName) {
    const node = el("div.reaction-float", {}, [icon(iconName, { size: "xl" })]);
    this.node.append(node);
    node.addEventListener("animationend", () => node.remove(), { once: true });
    burst(this.node);
  }

  destroy() {
    this.observador?.disconnect();
    this.video.srcObject = null;
    this.node.remove();
  }
}

export class Stage {
  /** @type {Map<string, Tile>} */ tiles = new Map();
  layout = "auto"; // "auto" | "grid"
  pinnedId = null;
  activeSpeaker = null;
  /** O quadro branco ocupa o destaque; os vídeos vão para a faixa lateral. */
  boardActive = false;

  constructor({ root, gridEl, spotlightEl, onPin }) {
    this.root = root;
    this.grid = gridEl;
    this.spotlight = spotlightEl;
    this.onPin = onPin || (() => {});
    /*
     * Balão flutuante com o seu próprio vídeo, na chamada a dois: a outra
     * pessoa ocupa o palco e você vira um balão que dá para arrastar para
     * qualquer canto — ele desliza até o canto mais próximo, com mola.
     */
    this.floater = el("div.floatSelf", { hidden: true, dataset: { corner: prefs.get("float:corner", "br") } });
    this.floater.setAttribute("aria-label", "Seu vídeo — arraste para outro canto");
    (spotlightEl?.parentElement || root)?.append(this.floater);
    this.#wireFloater();
    // Saiu da tela cheia (botão, voltar do Android, ladrilho que sumiu): o celular volta a girar livre.
    if (TOQUE) document.addEventListener("fullscreenchange", () => document.fullscreenElement || girar(""));
  }

  /** Chamada a dois, sem tela, quadro nem fixação: modo balão. */
  #duo() {
    if (this.layout !== "auto" || this.pinnedId || this.boardActive || this.tiles.size !== 2) return null;
    const lista = [...this.tiles.values()];
    if (lista.some((t) => t.kind !== "cam")) return null;
    const eu = lista.find((t) => t.self);
    const outro = lista.find((t) => !t.self);
    return eu && outro ? { eu, outro } : null;
  }

  #wireFloater() {
    const f = this.floater;
    let arrasto = null;

    f.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input")) return;
      const r = f.getBoundingClientRect();
      arrasto = { id: e.pointerId, x0: e.clientX, y0: e.clientY, r, pts: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
      f.setPointerCapture(e.pointerId);
      f.classList.add("is-dragging");
    });

    f.addEventListener("pointermove", (e) => {
      if (!arrasto || e.pointerId !== arrasto.id) return;
      const dx = e.clientX - arrasto.x0;
      const dy = e.clientY - arrasto.y0;
      f.style.translate = `${dx}px ${dy}px`;
      arrasto.pts.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (arrasto.pts.length > 6) arrasto.pts.shift();
    });

    const soltar = (e) => {
      if (!arrasto || e.pointerId !== arrasto.id) return;
      const a = arrasto;
      arrasto = null;
      f.classList.remove("is-dragging");
      const dx = e.clientX - a.x0;
      const dy = e.clientY - a.y0;
      // Um toque sem arrastar não mexe em nada.
      if (Math.hypot(dx, dy) < 4) {
        f.style.translate = "";
        return;
      }
      // Arremesso: projeta a velocidade final, como numa mola de verdade.
      const p0 = a.pts[0];
      const p1 = a.pts[a.pts.length - 1];
      const dt = Math.max(1, p1.t - p0.t);
      const vx = ((p1.x - p0.x) / dt) * 180;
      const vy = ((p1.y - p0.y) / dt) * 180;
      const area = f.parentElement.getBoundingClientRect();
      const cx = a.r.left + a.r.width / 2 + dx + vx - area.left;
      const cy = a.r.top + a.r.height / 2 + dy + vy - area.top;
      const canto = `${cy < area.height / 2 ? "t" : "b"}${cx < area.width / 2 ? "l" : "r"}`;

      const antes = f.getBoundingClientRect();
      f.style.translate = "";
      f.dataset.corner = canto;
      prefs.set("float:corner", canto);
      const depois = f.getBoundingClientRect();
      animate(
        f,
        [{ translate: `${antes.left - depois.left}px ${antes.top - depois.top}px` }, { translate: "0 0" }],
        SPRING.bouncy,
      );
    };
    f.addEventListener("pointerup", soltar);
    f.addEventListener("pointercancel", soltar);
  }

  /* ---------------------------------------------------------------- */

  tileId(peerId, kind) {
    return `${peerId}:${kind}`;
  }

  ensure(peerId, kind, { name, avatar, self = false }) {
    const id = this.tileId(peerId, kind);
    let tile = this.tiles.get(id);
    if (tile) return tile;

    tile = new Tile({ id, peerId, kind, name, avatar, self });

    tile.addAction({
      iconName: "pin",
      label: "Fixar na tela",
      pressed: false,
      onClick: () => this.togglePin(id),
    });
    // Sem tela cheia (app Android antigo, sem onShowCustomView), sem botão morto.
    // O iPhone não põe elemento em tela cheia, só o <video> (fullscreen()).
    if (env.canFullscreen || env.isSafari) {
      tile.addAction({
        iconName: "maximize-2",
        label: "Tela cheia",
        onClick: () => this.fullscreen(id),
      });
    }

    // Janela flutuante: o vídeo continua visível por cima de outros programas
    // enquanto a pessoa trabalha fora do navegador. O Firefox tem o recurso,
    // mas só pelo controle nativo dele, então o botão não aparece lá.
    if (document.pictureInPictureEnabled) {
      tile.addAction({
        iconName: "panel-right-open",
        label: "Janela flutuante",
        onClick: () => this.pictureInPicture(id),
      });
    }

    tile.node.addEventListener("dblclick", () => this.togglePin(id));

    this.tiles.set(id, tile);
    this.relayout();
    return tile;
  }

  get(peerId, kind) {
    return this.tiles.get(this.tileId(peerId, kind));
  }

  remove(peerId, kind) {
    const id = this.tileId(peerId, kind);
    const tile = this.tiles.get(id);
    if (!tile) return;
    this.tiles.delete(id);
    if (this.pinnedId === id) this.pinnedId = null;
    /*
     * Saída animada: o ladrilho encolhe e some ANTES de os outros ocuparem o
     * lugar dele. Antes ele sumia de um quadro para o outro e a grade pulava.
     * Ele já saiu do mapa, então nenhuma outra conta o enxerga mais.
     */
    const node = tile.node;
    if (calm() || !node.isConnected || !node.animate) {
      tile.destroy();
      this.relayout();
      return;
    }
    node.style.pointerEvents = "none";
    const saida = node.animate(
      [
        { opacity: 1, scale: "1", filter: "blur(0px)" },
        { opacity: 0, scale: "0.82", filter: "blur(4px)" },
      ],
      { duration: 220, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    saida.finished
      .catch(() => {})
      .then(() => {
        tile.destroy();
        this.relayout();
      });
  }

  /**
   * Anima qualquer mudança que mexa no tamanho do palco (abrir o painel
   * lateral, entrar no modo mini): os ladrilhos deslizam para o lugar novo em
   * vez de pular.
   */
  animateChange(mutate) {
    return flip(() => [...this.tiles.values()].map((t) => t.node), () => {
      const r = mutate();
      this.#relayout();
      return r;
    });
  }

  removePeer(peerId) {
    for (const kind of ["cam", "screen"]) this.remove(peerId, kind);
  }

  /* ---------------------------------------------------------------- */

  togglePin(id) {
    this.pinnedId = this.pinnedId === id ? null : id;
    for (const [tid, tile] of this.tiles) {
      tile.setPinned(tid === this.pinnedId);
      const btn = tile.actions.firstElementChild;
      if (btn) {
        btn.setAttribute("aria-pressed", String(tid === this.pinnedId));
        setIcon(btn.querySelector("svg"), tid === this.pinnedId ? "pin-off" : "pin");
        btn.dataset.tip = tid === this.pinnedId ? "Desafixar" : "Fixar na tela";
      }
    }
    this.onPin(this.pinnedId);
    this.relayout();
    return this.pinnedId;
  }

  fullscreen(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    const node = tile.node;
    const isFull = document.fullscreenElement === node || document.webkitFullscreenElement === node;
    if (isFull) return (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    // iPhone: o player do sistema, que já gira sozinho.
    if (!env.canFullscreen) return tile.video.webkitEnterFullscreen?.();
    const pedido = (node.requestFullscreen || node.webkitRequestFullscreen)?.call(node);
    // No celular, a tela deitada gira o aparelho (como no YouTube e no Discord).
    const v = tile.video;
    if (TOQUE) Promise.resolve(pedido).then(() => girar(v.videoWidth >= v.videoHeight ? "paisagem" : "retrato"), () => {});
    else pedido?.catch?.(() => {});
  }

  async pictureInPicture(id) {
    const tile = this.tiles.get(id);
    if (!tile || !document.pictureInPictureEnabled || tile.video.hidden) return false;
    try {
      if (document.pictureInPictureElement === tile.video) {
        await document.exitPictureInPicture();
        return false;
      }
      await tile.video.requestPictureInPicture();
      return true;
    } catch {
      // Sem faixa de vídeo ainda, ou o usuário fechou a janela: não é erro.
      return false;
    }
  }

  /**
   * O ladrilho em destaque agora. É o que a gravação precisa saber para gravar
   * "o que está sendo visto" sem ter de repetir aqui a regra de destaque.
   */
  featured() {
    const id = this.#featured();
    return (id && this.tiles.get(id)) || null;
  }

  setLayout(mode) {
    this.layout = mode;
    this.relayout();
    return this.layout;
  }

  setActiveSpeaker(peerId) {
    this.activeSpeaker = peerId;
    if (this.layout === "auto" && !this.pinnedId) this.relayout();
  }

  /** Quem deve ocupar o destaque agora — ou null para grade igualitária. */
  #featured() {
    if (this.pinnedId && this.tiles.has(this.pinnedId)) return this.pinnedId;
    if (this.layout === "grid") return null;

    // Uma tela compartilhada é quase sempre o motivo da reunião (se assistida: o convite fica na grade).
    for (const [id, tile] of this.tiles) {
      if (tile.kind === "screen" && !tile.convite) return id;
    }

    // Com muita gente, destacar quem fala evita miniaturas ilegíveis.
    if (this.tiles.size > 4 && this.activeSpeaker) {
      const id = this.tileId(this.activeSpeaker, "cam");
      if (this.tiles.has(id)) return id;
    }
    return null;
  }

  /**
   * O quadro branco entra no lugar do destaque, e não por cima de tudo: quem
   * desenha continua vendo quem está falando na faixa ao lado.
   */
  setBoard(active) {
    this.boardActive = active;
    this.relayout();
    return active;
  }

  /** Reorganiza deslizando: cada ladrilho parte de onde estava. */
  relayout() {
    flip(() => [...this.tiles.values()].map((t) => t.node), () => this.#relayout());
  }

  #relayout() {
    const duo = this.#duo();
    const featured = duo ? duo.outro.id : this.boardActive ? null : this.#featured();
    const isSpotlight = !!featured || this.boardActive;

    this.root.classList.toggle("stage--spotlight", isSpotlight);
    this.root.classList.toggle("stage--duo", !!duo);
    /*
     * O quadro precisa ser anunciado no palco, não só guardado aqui.
     *
     * Sozinho na sala, `.stage--alone` vira o palco numa grade de duas
     * colunas com `align-items: center`. O quadro mora dentro do destaque e é
     * posicionado em absoluto — ou seja, não tem altura própria para a grade
     * medir. O destaque colapsava para zero e o canvas nascia com 2 px de
     * altura: a barra de ferramentas aparecia e não dava para desenhar nada.
     */
    this.root.classList.toggle("stage--board", !!this.boardActive);
    this.spotlight.hidden = !isSpotlight;
    this.floater.hidden = !duo;
    if (duo && duo.eu.node.parentElement !== this.floater) this.floater.append(duo.eu.node);

    const ordered = [...this.tiles.values()].sort((a, b) => {
      // Telas primeiro, depois o próprio usuário por último na faixa.
      if (a.kind !== b.kind) return a.kind === "screen" ? -1 : 1;
      if (a.self !== b.self) return a.self ? 1 : -1;
      return 0;
    });

    for (const tile of ordered) {
      if (duo && tile === duo.eu) continue; // mora no balão
      const target = tile.id === featured ? this.spotlight : this.grid;
      if (tile.node.parentElement !== target) target.append(tile.node);
    }

    const gridCount = ordered.length - (featured ? 1 : 0) - (duo ? 1 : 0);
    this.grid.dataset.count = String(Math.max(0, gridCount));
    // Degrau de enxugamento do ladrilho (fonte menor, sem barra de volume).
    // Em degraus, e não contínuo, para não mudar a cada pessoa que entra.
    this.grid.dataset.size =
      gridCount > 12 ? "xl" : gridCount > 8 ? "lg" : gridCount > 4 ? "md" : "sm";
    this.grid.hidden = gridCount === 0;
    this.#fitColumns(gridCount);
  }

  /**
   * Escolhe quantas colunas a grade terá.
   *
   * `auto-fit` com uma largura mínima fixa parecia resolver, mas ele só olha
   * para a largura: com dezesseis pessoas numa tela larga ele fazia onze
   * colunas e duas linhas, e cada ladrilho saía 111×276 — um retrato estreito,
   * a pior forma possível para vídeo, que é deitado. A conta certa envolve a
   * proporção do espaço disponível: procura-se o número de colunas que deixa
   * cada ladrilho mais perto de 16:9.
   */
  #fitColumns(count) {
    if (!count) return;
    const r = this.grid.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.grid.style.setProperty("--cols", String(bestColumns(count, r.width, r.height)));
  }

  clearAll() {
    for (const tile of this.tiles.values()) tile.destroy();
    this.tiles.clear();
    this.pinnedId = null;
    clear(this.grid);
    clear(this.spotlight);
    clear(this.floater);
    this.floater.hidden = true;
  }
}

/** Peso de cada espaço vazio na última fileira, contra o erro de proporção. */
const RAGGED_PENALTY = 0.03;

/**
 * Quantas colunas deixam os ladrilhos mais perto de 16:9.
 *
 * Duas coisas entram na conta:
 *
 * 1. O erro de proporção, medido em logaritmo para ser simétrico — um ladrilho
 *    duas vezes largo demais é tão ruim quanto um duas vezes alto demais, e
 *    uma diferença linear trataria os dois casos de forma desigual.
 *
 * 2. As sobras na última fileira. Só a proporção escolheria cinco colunas para
 *    dezesseis pessoas: as vagas ficam 5+5+5+1, com um ladrilho solitário
 *    embaixo. Quatro por quatro fecha certo e é o que se espera de uma grade.
 */
export function bestColumns(count, width, height, aspect = 16 / 9) {
  if (!count || width <= 0 || height <= 0) return 1;
  let melhor = 1;
  let menorErro = Infinity;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const proporcao = Math.abs(Math.log(width / cols / (height / rows) / aspect));
    const erro = proporcao + (cols * rows - count) * RAGGED_PENALTY;
    if (erro < menorErro) {
      menorErro = erro;
      melhor = cols;
    }
  }
  return melhor;
}
