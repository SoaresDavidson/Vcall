/**
 * core/screen.js — captura de tela.
 *
 * Este é o módulo que decide se o compartilhamento vai ficar nítido ou virar
 * um borrão. Pontos que resolvem os problemas mais comuns:
 *
 * - `min` e `exact` são proibidos nas restrições de getDisplayMedia; só
 *   `ideal` e `max` valem. E as restrições são aplicadas DEPOIS da escolha da
 *   superfície, como redução — nunca aumentam a resolução de uma janela.
 * - O Firefox ignora `frameRate` passado na captura, mas respeita o mesmo
 *   valor aplicado logo em seguida na trilha. Aplicamos sempre.
 * - `monitorTypeSurfaces: "exclude"` junto de `displaySurface: "monitor"`
 *   lança TypeError; o mesmo vale para `preferCurrentTab` com
 *   `selfBrowserSurface: "exclude"`. Por isso as opções são montadas em
 *   camadas, e uma falha por opção desconhecida cai num plano B mínimo.
 * - A trilha precisa escutar `ended`: é assim que o botão "Parar
 *   compartilhamento" do próprio navegador chega até o app.
 * - Trocar de janela no meio (surfaceSwitching) muda a resolução sem encerrar
 *   a trilha. Sem reavaliar, o encoder continua com o teto antigo e a imagem
 *   desmancha.
 */
import { Emitter } from "../lib/emitter.js";
import { codecDaTela, constrainScreenTrack, screenProfileFor } from "./tuning.js";

/**
 * Linux: o som do computador vem do "monitor" do PulseAudio/PipeWire (o que
 * sai pelos alto-falantes), que o navegador lista como uma entrada de áudio
 * ("Monitor of …", "Monitor de …"). O Electron não junta esse som à tela: o
 * loopback dele só existe no Windows.
 */
export function escolherMonitor(dispositivos = []) {
  return dispositivos.find((d) => d.kind === "audioinput" && /\bmonitor\b/i.test(d.label || "")) || null;
}

/** App de mesa no Linux: aí o som da tela vem do monitor, não da captura. */
const somPeloMonitor = () =>
  typeof window !== "undefined" && !!window.vcallDesktop && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

/**
 * Prazo para o seletor de tela responder.
 *
 * No Linux o seletor não é do navegador: é do sistema (xdg-desktop-portal).
 * Quando o portal não está instalado, ou está instalado sem a peça certa para
 * a área de trabalho em uso, o Chromium fica esperando uma resposta que nunca
 * vem — e a promessa do `getDisplayMedia` não resolve nem rejeita. Para quem
 * está na chamada isso é indistinguível de travamento: o botão fica pressionado
 * e nada acontece, para sempre.
 *
 * Dois minutos são folgados de propósito: escolher a janela certa entre vinte
 * abertas leva tempo, e cortar alguém no meio da escolha seria pior que o bug.
 */
const PRAZO_SELETOR_MS = 120_000;

function comPrazo(promessa, ms = PRAZO_SELETOR_MS) {
  return new Promise((resolve, reject) => {
    const relogio = setTimeout(() => {
      const err = new Error("o seletor de tela do sistema não respondeu");
      err.name = "SeletorSemResposta";
      reject(err);
    }, ms);
    promessa.then(
      (v) => (clearTimeout(relogio), resolve(v)),
      (e) => (clearTimeout(relogio), reject(e)),
    );
  });
}

/*
 * 120 é o máximo do Chromium; no Windows a captura não passa da taxa do
 * monitor nem repete quadro, e num monitor de 60 Hz pedir 120 ainda pega
 * mais quadros novos da tela inteira (57 em vez de 52, medido no Electron 44).
 * No Linux, 60: o PipeWire não entrega mais que isso, e o X11 não sabe o que
 * mudou na tela, então pedir 120 só capturaria e mandaria quadros repetidos.
 */
const agente = globalThis.navigator?.userAgent ?? "";
export const TETO_QPS = /Linux/.test(agente) && !/Android/.test(agente) ? 60 : 120;

/** Resoluções oferecidas ao usuário. */
export const SCREEN_QUALITY = {
  auto: { label: "Automática", width: 1920, height: 1080, frameRate: TETO_QPS },
  hd: { label: `1080p · até ${TETO_QPS} qps`, width: 1920, height: 1080, frameRate: TETO_QPS },
  smooth: { label: "720p · 60 qps, rede fraca", width: 1280, height: 720, frameRate: 60 },
  light: { label: "720p · econômica", width: 1280, height: 720, frameRate: 15 },
};

export class ScreenShare extends Emitter {
  /** @type {MediaStream|null} */ stream = null;
  /** @type {MediaStreamTrack|null} */ videoTrack = null;
  /** @type {MediaStreamTrack|null} */ audioTrack = null;
  /**
   * O que vai para os outros: a captura passada por `manterQuadros`, que
   * repete o último quadro quando a tela fica parada. `videoTrack` continua
   * sendo a captura original (resolução, tipo de superfície, prévia local).
   * @type {MediaStreamTrack|null}
   */
  sendTrack = null;

  /** "text" para slides/código, "motion" para vídeo/animação. */
  mode = "text";
  /** A pessoa escolheu o modo à mão: a Fluidez automática não mexe nele. */
  modoFixo = false;
  quality = "auto";
  settings = null;

  get active() {
    return !!this.videoTrack && this.videoTrack.readyState === "live";
  }

  /** Codec escolhido para cada modo nesta máquina (tuning.codecDaTela). */
  #codecs = {};

  /**
   * Na Fluidez a captura sai no tamanho da janela, e quem reduz é o encoder
   * (stats.js, pelo `alturaMax` do perfil). O Chromium só deixa a captura
   * ocupar metade do tempo de uma thread, e reduzir ali custa ~6 ms por
   * quadro: 1926×1094 → 720p travava em ~45 qps; sem reduzir, 51–59
   * (medido no Electron 44). O teto de 1440p deixa a janela de 1080p inteira
   * e barra fonte enorme: uma captura em 4K a 60 já não cabe na CPU.
   */
  #restricoes() {
    const q = SCREEN_QUALITY[this.quality] || SCREEN_QUALITY.auto;
    if (this.mode === "motion") return { frameRate: q.frameRate, maxWidth: 2560, maxHeight: 1440 };
    return { frameRate: q.frameRate, maxWidth: q.width, maxHeight: q.height };
  }

  get profile() {
    const q = SCREEN_QUALITY[this.quality] || SCREEN_QUALITY.auto;
    return { ...screenProfileFor(this.mode), codec: this.#codecs[this.mode], alturaMax: q.height };
  }

  /**
   * Abre o seletor de tela do navegador. Precisa ser chamado diretamente de um
   * clique: depois de um `await` intermediário o navegador já perdeu a
   * "ativação transitória" e recusa a captura.
   */
  async start({ quality = this.quality, mode = this.mode, withAudio = false, surface = null, modoFixo = false } = {}) {
    if (this.active) return this.stream;

    this.quality = quality;
    this.mode = mode;
    this.modoFixo = !!modoFixo;
    this.surface = surface;
    this.wantedAudio = !!withAudio;
    const stream = await this.#capturar(withAudio, surface);
    await this.#adotar(stream);

    this.emit("start", this.snapshot());
    this.emit("change", this.snapshot());
    return stream;
  }

  /**
   * Troca O QUE está sendo compartilhado — outra janela, outra tela, com ou
   * sem som — sem parar a transmissão. Os outros continuam no mesmo ladrilho:
   * a trilha nova entra no lugar da antiga pela mesma linha de mídia
   * (replaceTrack), sem renegociar. Se a pessoa desistir no seletor, a
   * transmissão atual continua como estava.
   */
  async switchSource({ withAudio = this.wantedAudio, surface = null, quality = this.quality, mode = this.mode, modoFixo = this.modoFixo } = {}) {
    if (!this.active) return this.start({ withAudio, surface, quality, mode, modoFixo });
    const stream = await this.#capturar(withAudio, surface, quality);
    const antigas = this.stream.getTracks();
    const relayAntigo = this.#relay;
    this.#relay = null;
    this.quality = quality;
    this.mode = mode;
    this.modoFixo = !!modoFixo;
    this.surface = surface;
    this.wantedAudio = !!withAudio;
    await this.#adotar(stream);
    // As antigas só param depois que as novas já estão no lugar: quem assiste
    // não vê um instante de tela preta na troca.
    relayAntigo?.stop();
    for (const t of antigas) {
      try {
        t.stop();
      } catch {
        /* já parada */
      }
    }
    this.emit("switch", this.snapshot());
    this.emit("change", this.snapshot());
    return stream;
  }

  async #capturar(withAudio, surface, quality = this.quality) {
    const q = SCREEN_QUALITY[quality] || SCREEN_QUALITY.auto;
    let stream;
    try {
      stream = await comPrazo(navigator.mediaDevices.getDisplayMedia(this.#options(q, withAudio, surface)));
    } catch (err) {
      if (err?.name === "TypeError" || err?.name === "NotSupportedError") {
        /*
         * Alguma opção nova não foi aceita: tenta o conjunto mínimo e, se nem
         * assim, sem som. O Firefox (comum no Linux) não captura áudio de
         * tela e pode recusar o pedido inteiro só por causa dele.
         *
         * Cada tentativa tem prazo: no Linux o seletor é do sistema, e um
         * portal ausente deixa a promessa pendurada para sempre.
         */
        const planos = withAudio ? [{ video: true, audio: true }, { video: true }] : [{ video: true }];
        let ultimo = err;
        for (const plano of planos) {
          try {
            stream = await comPrazo(navigator.mediaDevices.getDisplayMedia(plano));
            break;
          } catch (err2) {
            ultimo = err2;
            if (err2?.name !== "TypeError" && err2?.name !== "NotSupportedError") break;
          }
        }
        if (!stream) {
          this.emit("error", ultimo);
          throw ultimo;
        }
      } else {
        this.emit("error", err);
        throw err;
      }
    }

    if (!stream.getVideoTracks()[0]) {
      stream.getTracks().forEach((t) => t.stop());
      const err = new Error("a captura não trouxe vídeo");
      this.emit("error", err);
      throw err;
    }
    if (withAudio && !stream.getAudioTracks().length && somPeloMonitor()) {
      const faixa = await this.#somDoMonitor();
      if (faixa) stream.addTrack(faixa);
    }
    return stream;
  }

  /** A faixa do monitor de som, ou null quando o sistema não oferece um. */
  async #somDoMonitor() {
    try {
      const monitor = escolherMonitor(await navigator.mediaDevices.enumerateDevices());
      if (!monitor) return null;
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: monitor.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      return s.getAudioTracks()[0] || null;
    } catch {
      return null;
    }
  }

  async #adotar(stream) {
    const video = stream.getVideoTracks()[0];
    // O relé entra ANTES de qualquer espera: com a tela parada, a captura
    // entrega um quadro no começo e mais nada. Se o relé chegasse depois, não
    // teria quadro nenhum para repetir e ninguém veria a tela até algo mexer.
    const relay = manterQuadros(video);
    this.stream = stream;
    this.videoTrack = video;
    this.audioTrack = stream.getAudioTracks()[0] || null;

    // Dica de conteúdo: define como o encoder negocia nitidez contra fluidez.
    if ("contentHint" in video) video.contentHint = this.mode === "motion" ? "motion" : "text";

    this.settings = await constrainScreenTrack(video, this.#restricoes());
    this.#codecs = { text: await codecDaTela("text"), motion: await codecDaTela("motion") };

    if (this.audioTrack) {
      // Áudio de tela é mídia, não voz: o processamento de voz o destruiria.
      try {
        await this.audioTrack.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
      } catch {
        /* alguns navegadores não permitem: segue assim mesmo */
      }
      const audio = this.audioTrack;
      audio.addEventListener("ended", () => {
        if (this.audioTrack !== audio) return; // trocada de propósito
        this.audioTrack = null;
        this.emit("change", this.snapshot());
      });
    }

    // O botão "Parar compartilhamento" do navegador só chega por aqui. Uma
    // trilha trocada de propósito (switchSource) não encerra nada.
    video.addEventListener("ended", () => {
      if (this.videoTrack === video) this.stop("browser");
    });

    // Troca de janela no meio: a resolução muda sem encerrar a trilha.
    video.addEventListener?.("configurationchange", () => this.#onSurfaceChange());
    this.#watchSurface();

    this.#relay = relay;
    this.sendTrack = this.#relay?.track || video;
    if ("contentHint" in this.sendTrack) this.sendTrack.contentHint = video.contentHint;
  }

  /**
   * Alterna entre priorizar nitidez (texto) e fluidez (vídeo). Escolher no
   * menu fixa o modo; `auto` é a troca feita pelo próprio Vcall.
   */
  setMode(mode, { auto = false } = {}) {
    if (!auto) this.modoFixo = true;
    if (mode === this.mode) return this.mode;
    this.mode = mode === "motion" ? "motion" : "text";
    for (const t of [this.videoTrack, this.sendTrack]) {
      if (t && "contentHint" in t) t.contentHint = this.mode === "motion" ? "motion" : "text";
    }
    // A Fluidez captura no tamanho da janela; a Nitidez, na resolução escolhida.
    if (this.videoTrack) constrainScreenTrack(this.videoTrack, this.#restricoes()).then((s) => (this.settings = s));
    this.emit("mode", this.mode);
    this.emit("change", this.snapshot());
    return this.mode;
  }

  /**
   * Vídeo ou jogo na Nitidez sai aos trancos: ela segura a resolução e joga
   * quadros fora. O padrão do painel é a Nitidez, e o nome da janela de um
   * jogo não diz nada (sharesheet.pareceVideo), então quem percebe é o
   * StatsMonitor: a imagem anda e o encoder não acompanha. Só vale se a
   * pessoa não escolheu o modo à mão.
   */
  fluidezAutomatica() {
    if (!this.active || this.modoFixo || this.mode === "motion") return false;
    this.setMode("motion", { auto: true });
    this.emit("fluidez-auto");
    return true;
  }

  /** O codec desta máquina mudou (tuning.marcarH264PorSoftware): o perfil vai junto. */
  async reavaliarCodecs() {
    this.#codecs = { text: await codecDaTela("text"), motion: await codecDaTela("motion") };
    if (this.active) this.emit("perfil", this.profile);
  }

  async setQuality(quality) {
    this.quality = quality;
    if (!this.videoTrack) return null;
    this.settings = await constrainScreenTrack(this.videoTrack, this.#restricoes());
    this.emit("change", this.snapshot());
    return this.settings;
  }

  stop(reason = "user") {
    if (!this.stream) return;
    clearInterval(this.#surfaceTimer);
    this.#relay?.stop();
    this.#relay = null;
    this.sendTrack = null;
    for (const t of this.stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* já parada */
      }
    }
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.settings = null;
    this.emit("stop", { reason });
    this.emit("change", this.snapshot());
  }

  snapshot() {
    return {
      active: this.active,
      video: this.videoTrack,
      send: this.sendTrack,
      audio: this.audioTrack,
      stream: this.stream,
      mode: this.mode,
      profile: this.profile,
      settings: this.settings,
      hasAudio: !!this.audioTrack,
    };
  }

  /* ---------------------------------------------------------------- */

  #surfaceTimer = 0;
  /** @type {{track: MediaStreamTrack, stop: () => void}|null} */
  #relay = null;

  #options(q, withAudio, surface = null) {
    /** @type {DisplayMediaStreamOptions} */
    const opts = {
      video: {
        // Nada de `min`/`exact` aqui: getDisplayMedia os rejeita.
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.frameRate, max: q.frameRate },
      },
      audio: withAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            // Chrome recente: não captura o som tocado pela própria página
            // (as vozes da chamada). Ignorado onde não existe.
            restrictOwnAudio: true,
            suppressLocalAudioPlayback: false,
          }
        : false,
    };

    // Opções de nível superior (Chrome). Ignoradas em silêncio em outros
    // navegadores; combinações inválidas são evitadas de propósito.
    /*
     * `displaySurface` é uma PREFERÊNCIA, não uma escolha: ela diz ao navegador
     * em qual aba do seletor abrir — tela inteira, janela ou aba. Quem escolhe
     * continua sendo a pessoa, na janela do navegador, e isso não tem como ser
     * contornado por página nenhuma. O que ganhamos é o seletor já abrir no
     * lugar certo, em vez de a pessoa ter que procurar.
     */
    if (surface === "monitor" || surface === "window" || surface === "browser") {
      opts.video.displaySurface = surface;
    }

    opts.selfBrowserSurface = "exclude"; // evita o efeito "sala de espelhos"
    opts.surfaceSwitching = "include"; // deixa trocar de janela sem reiniciar
    opts.systemAudio = withAudio ? "include" : "exclude";
    opts.monitorTypeSurfaces = "include";
    return opts;
  }

  /**
   * `configurationchange` ainda não está em todo lugar; uma sondagem leve
   * cobre o resto. Só emite quando a resolução realmente mudou.
   */
  #watchSurface() {
    clearInterval(this.#surfaceTimer);
    this.#surfaceTimer = setInterval(() => this.#onSurfaceChange(), 3000);
  }

  #onSurfaceChange() {
    if (!this.videoTrack) return;
    const s = this.videoTrack.getSettings?.();
    if (!s) return;
    const prev = this.settings || {};
    if (s.width === prev.width && s.height === prev.height && s.frameRate === prev.frameRate) return;
    this.settings = s;
    this.emit("surface", s);
    this.emit("change", this.snapshot());
  }
}

/**
 * Tela parada não pode virar transmissão parada.
 *
 * A captura de tela só entrega quadro quando algo muda (PipeWire no Linux,
 * WGC no Windows). Com a tela parada nenhum pacote sai, e três coisas quebram
 * do outro lado: a trilha recebida fica "muda" (o ladrilho parecia cair e
 * voltar), quem entra depois fica olhando um retângulo preto até alguém mexer
 * no mouse, e um quadro-chave perdido não tem como ser recuperado.
 *
 * A solução é um relé: a captura passa por um MediaStreamTrackProcessor e sai
 * por um gerador, e quando fica mais de ~1 s sem quadro novo, o último é
 * repetido. Quadro repetido de tela parada custa quase nada ao encoder (é
 * tudo "igual ao anterior"), mas mantém o fluxo vivo e permite que um pedido
 * de quadro-chave seja atendido na hora. Onde a API não existe (Firefox,
 * Safari), a captura segue direto, como antes.
 *
 * @param {MediaStreamTrack} captura
 * @returns {{track: MediaStreamTrack, stop: () => void}|null}
 */
export function manterQuadros(captura, { intervaloMs = 1000 } = {}) {
  if (typeof MediaStreamTrackProcessor !== "function" || typeof MediaStreamTrackGenerator !== "function") return null;
  if (typeof VideoFrame !== "function" || typeof Worker !== "function") return null;
  let gerador = null;
  let worker = null;
  try {
    const processor = new MediaStreamTrackProcessor({ track: captura });
    gerador = new MediaStreamTrackGenerator({ kind: "video" });
    // O laço roda num worker (core/quadros-worker.js): na thread da página,
    // cada engasgo da interface custava quadros.
    worker = new Worker(new URL("./quadros-worker.js", import.meta.url), { type: "module" });
    worker.postMessage({ entrada: processor.readable, saida: gerador.writable, intervaloMs }, [processor.readable, gerador.writable]);
  } catch {
    worker?.terminate();
    gerador?.stop();
    return null;
  }
  return {
    track: gerador,
    stop: () => {
      worker.postMessage("parar");
      try {
        gerador.stop();
      } catch {
        /* já parado */
      }
    },
  };
}

export function describeScreenError(err) {
  switch (err?.name) {
    case "NotAllowedError":
      return "Compartilhamento cancelado.";
    case "NotFoundError":
      return "Nenhuma tela disponível para compartilhar.";
    case "NotReadableError":
      return "O sistema não deixou capturar essa tela. No macOS, libere a gravação de tela para o navegador.";
    case "InvalidStateError":
      return "Clique no botão de compartilhar novamente — a permissão expirou.";
    case "AbortError":
      return "A captura foi interrompida.";
    case "SeletorSemResposta":
      return navigator.userAgent.includes("Linux")
        ? "O Linux não abriu a janela de escolher a tela. Instale o pacote “xdg-desktop-portal” da sua área de trabalho (GNOME, KDE…) e tente de novo."
        : "O seletor de tela não respondeu. Tente compartilhar de novo.";
    default:
      return "Não foi possível compartilhar a tela.";
  }
}
