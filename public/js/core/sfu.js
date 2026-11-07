/**
 * core/sfu.js — a tela pelo SFU de quem transmite, em sala de 3 ou mais.
 *
 * Na malha, quem transmite codifica uma cópia da tela por pessoa: com 5
 * assistindo, o processador não passa de ~20 qps. O app de mesa liga um
 * LiveKit no próprio PC (desktop/sfu.js); a tela é codificada UMA vez, em
 * duas camadas, e o SFU repassa os pacotes a cada um.
 *
 * Os papéis, com as mesmas regras do relé (core/rele.js):
 *
 *   ORIGEM   a janela do app que compartilha a tela numa sala de 3 ou mais.
 *            Pede a ficha ao servidor da sala (só ela pode publicar), publica
 *            tela e som da tela e anuncia pelo canal de dados {sfu, chave}.
 *            Só desliga o envio direto para quem CONFIRMA que já recebe pelo
 *            SFU; sem confirmação, volta a mandar direto.
 *   DESTINO  quem recebe o anúncio entra no SFU só para assistir e confirma
 *            quando os quadros chegam. Se pararem, desconfirma, e a origem
 *            volta a mandar direto.
 *
 * Ponta a ponta: os quadros saem cifrados (SFrame, pelo worker do LiveKit)
 * com uma chave nova a cada transmissão, que só anda pelos canais de dados da
 * malha (DTLS, de pessoa para pessoa). O SFU repassa sem ver a imagem.
 *
 * Sem SFU (navegador, servidor puro, LiveKit que não liga), nada muda: a sala
 * continua na malha.
 */
import { alvoDoSom, modoDoCodificador } from "./tuning.js";

export const SFU_MIN_PESSOAS = 3;
const TICK_MS = 1500;
/** Leituras seguidas sem quadro para desistir do SFU (volta à malha). */
const SEM_QUADROS = 2;
/** Teto da camada de cima: 16 pessoas × ~3,7 Mbps cabem em ~60 Mbps de subida. */
const TETO_BPS = 3_500_000;
const ALTURA_MAX = 1080;

/** A origem publica no SFU? Função pura: transmitindo e sala grande. */
export const usarSfu = ({ transmitindo, pessoas, negado }) => !!transmitindo && pessoas >= SFU_MIN_PESSOAS && !negado;

/** Escala de cada camada (de baixo para cima) para a altura capturada. */
export const escalasDasCamadas = (altura) => [Math.max(1, altura / 360), Math.max(1, altura / ALTURA_MAX)];

/** A chave vem de outra pessoa: só base64 curto vale. */
export const chaveValida = (c) => typeof c === "string" && /^[A-Za-z0-9+/=]{16,64}$/.test(c);

let lk = null;
const livekit = () => (lk ||= import("../../vendor/livekit.js"));

const papelDaFonte = (fonte) => (fonte === "screen_share" ? "screen" : fonte === "screen_share_audio" ? "screenAudio" : null);

export class SfuSala {
  #mesh;
  #timer = null;

  /* origem */
  #pub = null; // { room, chave, faixas }
  #ligando = false;
  #negado = false;
  /** peerId -> papéis que a pessoa confirmou receber pelo SFU. */
  #confirmados = new Map();

  /* destino */
  #sub = null; // { de, chave, room, recebido: Map(papel -> {stream, receiver, quadros, parado}) }
  #entrando = false;
  #alvoSom = 0;

  constructor(mesh) {
    this.#mesh = mesh;
    mesh.screen?.on("stop", () => (this.#negado = false));
  }

  start() {
    this.#timer ||= setInterval(() => this.tick().catch(() => {}), TICK_MS);
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#pararPub();
    this.#pararSub();
  }

  /** Para o diagnóstico e os testes: o que está passando pelo SFU agora. */
  get estado() {
    return {
      publicando: !!this.#pub?.room,
      confirmados: Object.fromEntries(this.#confirmados),
      assistindo: this.#sub?.room ? this.#sub.de : null,
      recebendo: this.#sub ? [...this.#sub.recebido].filter(([, r]) => r.live).map(([p]) => p) : [],
    };
  }

  /**
   * Estatísticas do que passa pelo SFU (o mesmo formato do getStats): quem
   * assiste vê as entradas da tela e do som; quem transmite, as camadas.
   */
  async relatorio() {
    const ler = async (alvo) => {
      const r = [];
      (await alvo?.getStats().catch(() => null))?.forEach((x) => r.push(x));
      return r;
    };
    const out = { tela: [], som: [], envio: [] };
    if (this.#sub) {
      out.tela = await ler(this.#sub.recebido.get("screen")?.receiver);
      out.som = await ler(this.#sub.recebido.get("screenAudio")?.receiver);
    }
    if (this.#pub?.faixas.video) out.envio = await ler(this.#pub.faixas.video.track?.sender);
    return out;
  }

  /** Papéis que a origem não manda mais direto para `id` (lido pelo relé). */
  papeisPara(id) {
    return this.#pub?.room ? this.#confirmados.get(id) || [] : [];
  }

  /** Mensagem {type: "sfu" | "sfu-ok"} de outra pessoa, pelo canal de dados. */
  receber(de, msg) {
    if (msg.type === "sfu-ok") {
      const papeis = Array.isArray(msg.papeis) ? msg.papeis.filter((p) => p === "screen" || p === "screenAudio") : [];
      this.#confirmados.set(de, papeis);
      return;
    }
    if (!msg.on) {
      if (this.#sub?.de === de) this.#pararSub();
      return;
    }
    if (!chaveValida(msg.chave)) return;
    if (this.#sub?.de === de && this.#sub.chave === msg.chave) return;
    if (this.#pub) return; // quem transmite pelo SFU não assiste outro por ele
    this.#entrar(de, msg.chave);
  }

  esquecer(id) {
    this.#confirmados.delete(id);
    if (this.#sub?.de === id) this.#pararSub();
  }

  async tick() {
    const mesh = this.#mesh;
    const transmitindo = mesh.screen?.active;
    if (usarSfu({ transmitindo, pessoas: mesh.size, negado: this.#negado })) await this.#publicar();
    else if (this.#pub) this.#pararPub();
    if (this.#pub?.room) {
      const anuncio = { type: "sfu", on: true, chave: this.#pub.chave };
      for (const peer of mesh.peers.values()) peer.sendBoard(anuncio);
      await this.#acompanharFaixas();
    }
    if (this.#sub?.room) await this.#vigiarSub();
  }

  /* ---------------------------------------------------------------- *
   * Origem
   * ---------------------------------------------------------------- */

  /** A ficha do servidor da sala: {url, token} ou null (sem SFU para mim). */
  #pedirEntrada() {
    const sig = this.#mesh.signaling;
    return new Promise((res) => {
      const fim = (m) => (sig.off?.("sfu", fim), clearTimeout(t), res(m?.entrada || null));
      const t = setTimeout(() => fim(null), 20_000);
      sig.on("sfu", fim);
      sig.send({ t: "sfu" });
    });
  }

  async #conectar(entrada, chave) {
    const { Room, ExternalE2EEKeyProvider } = await livekit();
    const keyProvider = new ExternalE2EEKeyProvider();
    await keyProvider.setKey(chave);
    const worker = new Worker(new URL("../../vendor/livekit-e2ee.js", import.meta.url), { type: "module" });
    const room = new Room({ adaptiveStream: false, dynacast: true, e2ee: { keyProvider, worker } });
    await room.setE2EEEnabled(true);
    const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${entrada.url}`;
    await room.connect(ws, entrada.token, { autoSubscribe: true });
    return room;
  }

  async #publicar() {
    if (this.#pub || this.#ligando) return;
    this.#ligando = true;
    try {
      const entrada = await this.#pedirEntrada();
      if (!entrada) {
        this.#negado = true; // até a próxima transmissão
        return;
      }
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const chave = btoa(String.fromCharCode(...bytes));
      const room = await this.#conectar(entrada, chave);
      this.#pub = { room, chave, faixas: { video: null, audio: null } };
      await this.#acompanharFaixas();
    } catch (err) {
      console.warn("[sfu] sem SFU, a tela segue pela malha", err);
      this.#negado = true;
      this.#pararPub();
    } finally {
      this.#ligando = false;
    }
  }

  /** Publica (ou troca) a tela e o som da tela que estão saindo agora. */
  async #acompanharFaixas() {
    const pub = this.#pub;
    const { Track, VideoPreset } = await livekit();
    const screen = this.#mesh.screen;
    const video = screen.sendTrack || screen.videoTrack || null;
    const audio = screen.audioTrack || null;
    const lp = pub.room.localParticipant;
    if (pub.faixas.video?.track?.mediaStreamTrack !== video) {
      if (pub.faixas.video) await lp.unpublishTrack(pub.faixas.video.track, false).catch(() => {});
      pub.faixas.video = null;
      if (video) {
        pub.faixas.video = await lp.publishTrack(video, {
          source: Track.Source.ScreenShare,
          // PC fraco (Configurações › Transmissão › Leve): VP8, o mais barato por software.
          videoCodec: modoDoCodificador() === "leve" ? "vp8" : "h264",
          backupCodec: false,
          simulcast: true,
          screenShareEncoding: { maxBitrate: TETO_BPS, maxFramerate: 60 },
          screenShareSimulcastLayers: [new VideoPreset(640, 360, 600_000, 30)],
          degradationPreference: "maintain-framerate",
        });
        await this.#limitarAltura(pub.faixas.video, video);
      }
    }
    if (pub.faixas.audio?.track?.mediaStreamTrack !== audio) {
      if (pub.faixas.audio) await lp.unpublishTrack(pub.faixas.audio.track, false).catch(() => {});
      pub.faixas.audio = audio ? await lp.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: false, red: true }) : null;
    }
  }

  /**
   * Na Fluidez a captura vem no tamanho da janela (até 1440p). A camada de
   * cima sai em no máximo 1080p e a de baixo em 360p: é o encoder que reduz.
   */
  async #limitarAltura(publicacao, video) {
    const sender = publicacao?.track?.sender;
    const altura = video.getSettings?.().height;
    if (!sender || !altura) return;
    const p = sender.getParameters();
    const escalas = escalasDasCamadas(altura);
    p.encodings?.forEach((e, i) => (e.scaleResolutionDownBy = escalas[Math.min(i, escalas.length - 1)]));
    await sender.setParameters(p).catch(() => {});
  }

  #pararPub() {
    const pub = this.#pub;
    this.#pub = null;
    this.#confirmados.clear();
    if (!pub) return;
    pub.room?.disconnect();
    for (const peer of this.#mesh.peers.values()) peer.sendBoard({ type: "sfu", on: false });
  }

  /* ---------------------------------------------------------------- *
   * Destino
   * ---------------------------------------------------------------- */

  async #entrar(de, chave) {
    if (this.#entrando) return;
    this.#entrando = true;
    this.#pararSub();
    try {
      const entrada = await this.#pedirEntrada();
      if (!entrada) return;
      const { RoomEvent } = await livekit();
      const room = await this.#conectar(entrada, chave);
      const sub = { de, chave, room, recebido: new Map() };
      this.#sub = sub;
      const pegar = (track, _pub, participante) => {
        const papel = papelDaFonte(track.source);
        if (!papel || participante.identity !== de || this.#sub !== sub) return;
        sub.recebido.set(papel, { stream: new MediaStream([track.mediaStreamTrack]), receiver: track.receiver, quadros: -1, parado: 0, live: false });
      };
      room.on(RoomEvent.TrackSubscribed, pegar);
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        const papel = papelDaFonte(track.source);
        if (!papel || this.#sub !== sub) return;
        sub.recebido.delete(papel);
        this.#mesh.receberSfu(de, papel, null);
      });
      for (const p of room.remoteParticipants.values()) for (const t of p.trackPublications.values()) if (t.track) pegar(t.track, t, p);
    } catch (err) {
      console.warn("[sfu] não deu para assistir pelo SFU; segue pela malha", err);
      this.#pararSub();
    } finally {
      this.#entrando = false;
    }
  }

  /** Quadros chegando? Confirma à origem, ou devolve à malha. Sincroniza o som. */
  async #vigiarSub() {
    const sub = this.#sub;
    let jbVideo = null;
    for (const [papel, r] of sub.recebido) {
      let atual = null;
      let jb = null;
      (await r.receiver?.getStats().catch(() => null))?.forEach((x) => {
        if (x.type !== "inbound-rtp") return;
        atual = papel === "screen" ? x.framesDecoded : x.totalSamplesReceived;
        jb = x;
      });
      const andou = atual != null && r.quadros >= 0 && atual > r.quadros;
      r.parado = andou ? 0 : r.parado + 1;
      if (papel === "screen" && jb && r.jb && jb.jitterBufferEmittedCount > r.jb.jitterBufferEmittedCount) {
        jbVideo = ((jb.jitterBufferDelay - r.jb.jitterBufferDelay) / (jb.jitterBufferEmittedCount - r.jb.jitterBufferEmittedCount)) * 1000;
      }
      r.jb = jb;
      r.quadros = atual ?? r.quadros;
      const live = andou || (r.live && r.parado < SEM_QUADROS);
      if (live !== r.live || !r.emitido) {
        r.live = live;
        r.emitido = true;
        this.#mesh.receberSfu(sub.de, papel, { stream: r.stream, live });
      }
    }
    // Mesma sincronia da malha (stats.js): o som espera o buffer da imagem, até 250 ms.
    const som = sub.recebido.get("screenAudio")?.receiver;
    const tela = sub.recebido.get("screen");
    if (som && tela) {
      const novo = alvoDoSom({ videoMs: jbVideo, alvo: this.#alvoSom, videoParado: !tela.live });
      if (novo !== this.#alvoSom) {
        this.#alvoSom = novo;
        try {
          if ("jitterBufferTarget" in som) som.jitterBufferTarget = novo;
        } catch {}
      }
    }
    const papeis = [...sub.recebido].filter(([, r]) => r.live).map(([p]) => p);
    // Só tira a tela da malha com a imagem chegando; o som vai junto dela.
    this.#mesh.peers.get(sub.de)?.sendBoard({ type: "sfu-ok", papeis: papeis.includes("screen") ? papeis : [] });
  }

  #pararSub() {
    const sub = this.#sub;
    this.#sub = null;
    this.#alvoSom = 0;
    if (!sub) return;
    sub.room?.disconnect();
    for (const papel of sub.recebido.keys()) this.#mesh.receberSfu(sub.de, papel, null);
    this.#mesh.peers.get(sub.de)?.sendBoard({ type: "sfu-ok", papeis: [] });
  }
}
