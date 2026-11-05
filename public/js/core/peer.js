/**
 * core/peer.js — uma conexão P2P com um participante.
 *
 * Três decisões de arquitetura carregam este arquivo:
 *
 * 1. QUATRO LINHAS DE MÍDIA FIXAS. Microfone, câmera, tela e áudio da tela
 *    recebem cada um a sua própria linha, criadas de uma vez antes da primeira
 *    oferta. Depois disso, ligar e desligar a câmera ou a tela é só
 *    `replaceTrack` — sem nova linha, sem renegociação, sem janela de conflito.
 *    Era exatamente essa renegociação no meio da chamada que fazia o
 *    compartilhamento de tela funcionar só de um lado, ou chegar preto no
 *    outro.
 *
 *    Só UM dos lados chama `addTransceiver`. Isso não é detalhe: pela
 *    especificação, uma linha criada com `addTransceiver` nunca é reaproveitada
 *    para casar com uma linha da oferta remota — ela é um pedido explícito de
 *    linha própria. Se os dois lados criassem as suas, cada navegador acabaria
 *    com oito linhas: quatro enviando para o vazio e quatro recebendo. O lado
 *    que responde adota as linhas que chegaram na oferta, vira a direção para
 *    `sendrecv` ANTES de montar a resposta e usa essas mesmas. Resultado:
 *    quatro linhas, os mesmos `mid` nas duas pontas, uma única negociação.
 *
 * 2. PERFECT NEGOTIATION. Quando os dois lados tentam negociar ao mesmo tempo,
 *    um deles é "educado" e desfaz a própria oferta em vez de brigar. O papel
 *    é decidido comparando os ids, então é estável e sempre oposto nas duas
 *    pontas.
 *
 * 3. CANAIS DE DADOS NEGOCIADOS. O quadro branco e o ponteiro laser usam
 *    DataChannels com `negotiated: true` e id fixo: existem desde o primeiro
 *    instante, iguais dos dois lados, sem disparar renegociação.
 */
import { Emitter } from "../lib/emitter.js";
import { jitter } from "../lib/util.js";
import { ajustarInicioVideo, ajustarOpus, applyProfile, cameraParaSala, codecDaCamera, preferCodecs, preferRed, PROFILES, screenCodecPreference } from "./tuning.js";

/** Ordem canônica das linhas de mídia. Não altere sem versionar o protocolo. */
export const ROLES = ["mic", "cam", "screen", "screenAudio"];

const ROLE_KIND = { mic: "audio", cam: "video", screen: "video", screenAudio: "audio" };

/** Há servidor TURN nesta entrada de configuração? */
function hasTurn(server) {
  const urls = server?.urls;
  const list = Array.isArray(urls) ? urls : [urls];
  return list.some((u) => String(u || "").startsWith("turn"));
}

/**
 * Canais separados por prioridade. Um canal só tem uma fila: misturar uma
 * imagem de 300 kB com o estado de voz faz o indicador de quem está falando
 * chegar segundos atrasado. Por isso são quatro.
 *
 *   canvas-sync   deltas do canvas — ordenado e confiável, é o estado do desenho
 *   cursor        ponteiro laser — posição velha não serve, sem ordem nem reenvio
 *   audio-control estado de voz (VAD) — minúsculo, frequente, descartável
 *   canvas-blob   imagens em pedaços — grande e lento, fica fora do caminho do resto
 */
const DC_BOARD = { label: "canvas-sync", id: 0, negotiated: true, ordered: true };
const DC_CURSOR = { label: "cursor", id: 1, negotiated: true, ordered: false, maxRetransmits: 0 };
const DC_AUDIO = { label: "audio-control", id: 2, negotiated: true, ordered: false, maxRetransmits: 0 };
const DC_BLOB = { label: "canvas-blob", id: 3, negotiated: true, ordered: true };

/**
 * Acima disto o canal está congestionado; o remetente espera antes de empurrar
 * mais. Com 512 kB na fila, o canal às vezes parava de enviar por 40 a 60 s
 * (a fila parada, o vídeo seguindo normal) e um arquivo de 3 MB não chegava:
 * 3 falhas em 8 rodadas; 256 kB ainda travava; 128 kB, nenhuma em 16.
 */
const BLOB_HIGH_WATER = 128 * 1024;

const GRACE_MS = 2500;
const RESTART_BACKOFF = [0, 1000, 2500, 5000, 8000, 12_000, 20_000];
/**
 * Reinícios de ICE antes de jogar fora a conexão e montar outra do zero.
 *
 * `restartIce()` troca as credenciais e refaz a coleta de candidatos, mas
 * mantém o mesmo RTCPeerConnection — e há estados de onde ele não sai: DTLS
 * que falhou, transceiver órfão, porta que o sistema operacional não devolve.
 * Depois de algumas tentativas, o que resolve é recomeçar.
 */
const RESTARTS_BEFORE_REBUILD = 3;
/**
 * Reconstruções antes de desistir. Antes eram três reinícios e pronto: a
 * conexão morria para sempre e a pessoa só voltava recarregando a página.
 */
const MAX_REBUILDS = 4;

export class Peer extends Emitter {
  /** @type {RTCPeerConnection|null} */ pc = null;
  /** @type {Record<string, RTCRtpTransceiver>} */ tx = {};
  /** mid -> papel, para saber o que é cada trilha que chega. */ #midRole = new Map();
  /** papel -> MediaStream remoto. */ remote = { mic: null, cam: null, screen: null, screenAudio: null };

  #polite;
  /**
   * O lado educado não abre a negociação. Os dois criam exatamente as mesmas
   * linhas de mídia, na mesma ordem; se ambos ofertassem, haveria colisão em
   * *toda* conexão, e o desfazimento da oferta do lado educado deixa no Chrome
   * transceivers órfãos — linhas de mídia que existem mas não chegam ao outro
   * lado. É uma das razões clássicas de "a tela só aparece de um lado".
   * O perfect negotiation continua valendo para tudo que vier depois
   * (reinício de ICE, mudança de perfil): a partir da primeira negociação
   * concluída, o lado educado também pode ofertar.
   */
  #mayOffer;
  #makingOffer = false;
  #lastLocal = {};
  #ignoreOffer = false;
  #settingRemoteAnswer = false;
  #pendingCandidates = [];
  #graceTimer = 0;
  #restarts = 0;
  #rebuilds = 0;
  #restartWatch = 0;
  #closed = false;
  #config;
  /**
   * Só a imagem da tela vai neste stream; o som da tela vai sem stream.
   *
   * Na 3.17.3 os dois iam no mesmo stream (msid no SDP) para o Chromium
   * sincronizar o som com a imagem. Só que essa sincronia segue a imagem sem
   * limite e solta devagar (80 ms por segundo): quando a imagem engasgava,
   * o som ia junto a 2–2,7 s de atraso e levava mais de 25 s para voltar
   * (medido pela internet simulada). Agora quem recebe sincroniza com teto
   * (alvoDoSom em tuning.js, aplicado em stats.js).
   */
  #telaStream = null;

  constructor({ id, selfId, config, profile, local, peerCount = 1 }) {
    super();
    this.id = id;
    this.profile = profile;
    this.#config = config;
    this.#polite = String(selfId) > String(id); // estável e oposto nas duas pontas
    this.#mayOffer = !this.#polite;
    this.peerCount = peerCount;
    this.#build(local);
    this.escolherCodecCamera().catch(() => {});
  }

  get polite() {
    return this.#polite;
  }
  get connectionState() {
    return this.pc?.connectionState || "closed";
  }

  /* ---------------------------------------------------------------- *
   * Construção
   * ---------------------------------------------------------------- */

  #build(local) {
    const pc = new RTCPeerConnection(this.#config);
    this.pc = pc;
    this.#telaStream = new MediaStream();

    // Só quem oferta cria as linhas. Quem responde as adota da oferta.
    if (this.#mayOffer) {
      for (const role of ROLES) {
        const init = { direction: "sendrecv" };
        if (role === "screen") init.streams = [this.#telaStream];
        if (role === "screen") {
          init.sendEncodings = [{ maxBitrate: PROFILES.screenText.maxBitrate, maxFramerate: PROFILES.screenText.maxFramerate }];
        } else if (role === "cam") {
          init.sendEncodings = [{ maxBitrate: PROFILES.camera.maxBitrate, maxFramerate: PROFILES.camera.maxFramerate }];
        }
        this.tx[role] = pc.addTransceiver(ROLE_KIND[role], init);
      }
      // Preferência de codec por linha: tela pede VP9/AV1, câmera fica no padrão.
      preferCodecs(this.tx.screen, screenCodecPreference(this.peerCount));
      // Voz com redundância: um pacote perdido volta no seguinte.
      preferRed(this.tx.mic);
    }

    // Canais de dados: existem antes de qualquer oferta, nos dois lados.
    this.board = pc.createDataChannel(DC_BOARD.label, DC_BOARD);
    this.cursor = pc.createDataChannel(DC_CURSOR.label, DC_CURSOR);
    this.audioCtl = pc.createDataChannel(DC_AUDIO.label, DC_AUDIO);
    this.blob = pc.createDataChannel(DC_BLOB.label, DC_BLOB);
    this.board.binaryType = "arraybuffer";
    this.blob.bufferedAmountLowThreshold = BLOB_HIGH_WATER / 2;
    this.#wireChannel(this.board, "board");
    this.#wireChannel(this.cursor, "cursor");
    this.#wireChannel(this.audioCtl, "audio");
    this.#wireChannel(this.blob, "blob");

    pc.addEventListener("negotiationneeded", () => this.#onNegotiationNeeded());
    pc.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate) this.emit("signal", { candidate: candidate.toJSON() });
    });
    pc.addEventListener("track", (ev) => this.#onTrack(ev));
    pc.addEventListener("connectionstatechange", () => this.#onConnectionState());
    pc.addEventListener("iceconnectionstatechange", () => {
      this.emit("ice", this.pc?.iceConnectionState);
    });
    pc.addEventListener("signalingstatechange", () => {
      // Uma renegociação pode zerar os parâmetros do encoder no Chrome.
      // Reaplicar ao voltar para "stable" é o que impede a tela de degradar
      // silenciosamente depois de alguém entrar ou sair da sala.
      if (pc.signalingState === "stable") {
        this.emit("stable");
        // Linhas de repasse ganham mid na negociação: agora dá para contar de quem são.
        this.#publicarSlots();
      }
    });

    // Anexa o que já estiver ligado localmente.
    this.attachLocal(local);
  }

  #wireChannel(channel, name) {
    channel.addEventListener("open", () => this.emit(`${name}:open`));
    channel.addEventListener("message", (ev) => this.emit(`${name}:message`, ev.data));
    channel.addEventListener("error", () => {
      /* canal de dados caindo não derruba a chamada */
    });
  }

  /* ---------------------------------------------------------------- *
   * Mídia local
   * ---------------------------------------------------------------- */

  /**
   * Sincroniza as quatro trilhas locais com esta conexão. Chamado quando o
   * usuário liga/desliga câmera, microfone ou tela. Nunca renegocia.
   */
  async attachLocal(local = {}) {
    if (!this.pc || this.#closed) return;
    // Guardado porque o lado que responde só ganha as linhas depois da oferta,
    // e precisa reanexar o que já estava ligado localmente.
    this.#lastLocal = local;
    await Promise.all([
      this.#setTrack("mic", local.mic, this.#perfil("mic", local)),
      this.#setTrack("cam", local.cam, this.#perfil("cam", local)),
      this.#setTrack("screen", local.screen, this.#perfil("screen", local)),
      this.#setTrack("screenAudio", local.screenAudio, this.#perfil("screenAudio", local)),
    ]);
  }

  /** O outro lado não está vendo (janela escondida): a câmera não é enviada. */
  #camPausada = false;

  async pausarCamera(pausar) {
    if (this.#camPausada === !!pausar) return;
    this.#camPausada = !!pausar;
    await applyProfile(this.tx.cam?.sender, this.#perfilCamera());
    this.emit("cam-pausada", this.#camPausada);
  }

  get camPausada() {
    return this.#camPausada;
  }

  async #setTrack(role, track, profile) {
    const sender = this.tx[role]?.sender;
    if (!sender) return;
    if (role === "cam" && this.#camPausada) profile = { ...profile, active: false };
    if (sender.track === (track || null)) {
      // Mesma trilha: ainda assim reaplica o perfil, porque contentHint e
      // parâmetros podem ter sido zerados por uma renegociação.
      if (track) await applyProfile(sender, profile);
      return;
    }
    try {
      await sender.replaceTrack(track || null);
    } catch (err) {
      console.warn(`[peer ${this.id}] replaceTrack(${role}) falhou`, err);
      return;
    }
    if (track) await applyProfile(sender, profile);
  }

  /** Reaplica os perfis — usado depois de cada negociação concluída. */
  async retune(local = {}) {
    await Promise.all([
      applyProfile(this.tx.mic?.sender, this.#perfil("mic", local)),
      applyProfile(this.tx.cam?.sender, this.#perfil("cam", local)),
      applyProfile(this.tx.screen?.sender, this.#perfil("screen", local)),
      applyProfile(this.tx.screenAudio?.sender, this.#perfil("screenAudio", local)),
    ]);
  }

  /** Ajusta o teto da trilha de tela (usado pelo controle adaptativo). */
  async setScreenBudget({ maxBitrate, maxFramerate, scaleResolutionDownBy, profile = PROFILES.screenText }) {
    return applyProfile(this.tx.screen?.sender, profile, {
      maxBitrate: Math.min(maxBitrate, profile.maxBitrate),
      maxFramerate: Math.min(maxFramerate, profile.maxFramerateComBanda ?? profile.maxFramerate),
      scaleResolutionDownBy,
      active: !this.#viaRele.has("screen"),
    });
  }

  async setCameraBudget({ maxBitrate, maxFramerate }) {
    const teto = this.#perfilCamera();
    return applyProfile(this.tx.cam?.sender, teto, {
      maxBitrate: Math.min(maxBitrate, teto.maxBitrate),
      maxFramerate: Math.min(maxFramerate, teto.maxFramerate),
    });
  }

  /**
   * Força o encoder de uma trilha a se reconfigurar, desfazendo a limitação
   * de resolução/cadência que ele decidiu no começo da chamada (veja
   * StatsMonitor.#destravar). Troca a preferência de degradação e volta.
   */
  async reconfigurarEncoder(papel) {
    const sender = this.tx[papel]?.sender;
    if (!sender?.track) return false;
    try {
      const p = sender.getParameters();
      const original = p.degradationPreference || "balanced";
      p.degradationPreference = original === "maintain-framerate" ? "balanced" : "maintain-framerate";
      await sender.setParameters(p);
      const q = sender.getParameters();
      q.degradationPreference = original;
      await sender.setParameters(q);
      return true;
    } catch {
      return false;
    }
  }

  /** A sala mudou de tamanho (mesh.js): a câmera enviada a este par acompanha. */
  async ajustarCamera(outros) {
    this.peerCount = outros;
    if (outros > 1) this.#cam60 = false;
    await this.escolherCodecCamera();
    await applyProfile(this.tx.cam?.sender, this.#perfilCamera());
  }

  /** Codec da câmera para esta conexão (tuning.codecDaCamera): muda com o tamanho da sala. */
  codecCamera = null;

  async escolherCodecCamera() {
    const codec = await codecDaCamera(this.peerCount);
    if (codec === this.codecCamera || this.#closed) return;
    this.codecCamera = codec;
    await applyProfile(this.tx.cam?.sender, this.#perfilCamera());
  }

  /** A dois e com banda sobrando, a câmera vai a 60 qps (decidido pelo StatsMonitor). */
  #cam60 = false;

  get camera60() {
    return this.#cam60;
  }

  async definirCamera60(ligar) {
    ligar = !!ligar && this.peerCount <= 1;
    if (ligar === this.#cam60) return;
    this.#cam60 = ligar;
    await applyProfile(this.tx.cam?.sender, this.#perfilCamera());
  }

  #perfilCamera() {
    const perfil = { ...PROFILES.camera, ...cameraParaSala(this.peerCount), active: !this.#camPausada && !this.#viaRele.has("cam") };
    if (this.#cam60) {
      perfil.maxFramerate = PROFILES.camera.maxFramerateComBanda;
      perfil.maxBitrate = PROFILES.camera.maxBitrateComBanda;
    }
    if (this.codecCamera) perfil.codec = this.codecCamera;
    return perfil;
  }

  /** O perfil de cada linha própria, já com o envio direto desligado se ela vai pelo relé. */
  #perfil(role, local = this.#lastLocal) {
    if (role === "cam") return this.#perfilCamera();
    const base =
      role === "mic" ? PROFILES.mic : role === "screen" ? local?.screenProfile || PROFILES.screenText : PROFILES.screenAudio;
    return this.#viaRele.has(role) ? { ...base, active: false } : base;
  }

  /* ---------------------------------------------------------------- *
   * Relé (core/rele.js)
   *
   * Um terceiro participante pode repassar a mídia de alguém para esta
   * conexão: quando o caminho direto entre os dois caiu, ou quando quem envia
   * tem pouca subida para mandar uma cópia a cada pessoa. O repasse usa linhas
   * EXTRAS, só de envio, criadas por quem repassa. As quatro linhas próprias
   * continuam intocadas.
   * ---------------------------------------------------------------- */

  /** Papéis próprios que este par recebe pelo relé (o envio direto fica desligado). */
  #viaRele = new Set();

  async rotearPorRele(papeis) {
    const novo = new Set(papeis);
    const mudou = ROLES.filter((r) => novo.has(r) !== this.#viaRele.has(r));
    if (!mudou.length) return;
    this.#viaRele = novo;
    await Promise.all(mudou.map((r) => applyProfile(this.tx[r]?.sender, this.#perfil(r))));
  }

  get viaRele() {
    return [...this.#viaRele];
  }

  /** Lado de quem repassa: "de:papel" -> transceiver só de envio. */
  #slots = new Map();
  /** Linhas de repasse que ficaram sem uso, prontas para outra origem. */
  #livres = { audio: [], video: [] };
  /** transceiver -> perfil aplicado por último (evita setParameters a cada volta). */
  #perfilSlot = new WeakMap();
  #slotsPublicados = "";

  /**
   * O que repassar para este par: Map "de:papel" -> { track, perfil }.
   * Idempotente — mesh/rele chama a cada volta. Linhas que sobram são
   * esvaziadas e guardadas para reaproveitar, sem renegociar.
   */
  async definirRepasse(desejado) {
    if (!this.pc || this.#closed) return;
    // Linhas novas pedem uma oferta; o lado educado só oferta depois da primeira negociação.
    for (const [chave, t] of [...this.#slots]) {
      if (desejado.has(chave)) continue;
      this.#slots.delete(chave);
      try {
        await t.sender.replaceTrack(null);
      } catch {
        /* conexão fechando */
      }
      this.#livres[t.receiver.track.kind]?.push(t);
    }
    for (const [chave, { track, perfil }] of desejado) {
      if (!this.pc || this.#closed) return;
      let t = this.#slots.get(chave);
      if (!t) {
        const papel = chave.slice(chave.lastIndexOf(":") + 1);
        const kind = ROLE_KIND[papel];
        if (!kind) continue;
        t = this.#livres[kind].pop();
        if (!t) {
          if (!this.#mayOffer) continue;
          try {
            t = this.pc.addTransceiver(kind, { direction: "sendonly" });
          } catch {
            continue;
          }
          if (kind === "audio") preferRed(t);
        }
        this.#slots.set(chave, t);
      }
      if (t.sender.track !== (track || null)) {
        try {
          await t.sender.replaceTrack(track || null);
        } catch {
          continue;
        }
        this.#perfilSlot.delete(t);
      }
      const json = JSON.stringify(perfil);
      if (track && this.#perfilSlot.get(t) !== json && (await applyProfile(t.sender, perfil))) this.#perfilSlot.set(t, json);
    }
    this.#publicarSlots();
  }

  get repassando() {
    return [...this.#slots.keys()];
  }

  /** Conta ao outro lado de quem é cada linha de repasse (só as que já têm mid). */
  #publicarSlots(forcar = false) {
    const mapa = {};
    for (const [chave, t] of this.#slots) {
      if (t.mid == null) continue;
      const i = chave.lastIndexOf(":");
      mapa[t.mid] = { de: chave.slice(0, i), role: chave.slice(i + 1) };
    }
    const json = JSON.stringify(mapa);
    if (!forcar && json === this.#slotsPublicados) return;
    this.#slotsPublicados = json;
    // Pelos dois caminhos: a sinalização pode estar caída, e o canal pode não ter aberto.
    this.emit("signal", { slots: mapa });
    this.sendBoard({ type: "slots", slots: mapa });
  }

  /** Lado de quem recebe: mid -> { de, role }. */
  #slotMapa = new Map();
  /** mid -> MediaStream da trilha repassada. */
  #repasseStreams = new Map();
  #wiredRepasse = new WeakSet();

  receberSlots(mapa) {
    if (!mapa || typeof mapa !== "object") return;
    const novo = new Map();
    for (const [mid, s] of Object.entries(mapa)) {
      if (typeof s?.de !== "string" || s.de.length > 64 || !ROLES.includes(s.role)) continue;
      novo.set(String(mid), { de: s.de, role: s.role });
    }
    const mudaram = [];
    for (const [mid, antigo] of this.#slotMapa) {
      const n = novo.get(mid);
      if (n && n.de === antigo.de && n.role === antigo.role) continue;
      this.#repasseStreams.delete(mid);
      this.emit("repasse", { de: antigo.de, role: antigo.role, stream: null, track: null, live: false });
    }
    for (const [mid, n] of novo) {
      const antigo = this.#slotMapa.get(mid);
      if (!antigo || antigo.de !== n.de || antigo.role !== n.role) mudaram.push(mid);
    }
    this.#slotMapa = novo;
    if (!mudaram.length) return;
    for (const t of this.pc?.getTransceivers() || []) {
      const mid = t.mid != null ? String(t.mid) : null;
      if (mid && mudaram.includes(mid) && t.receiver?.track) this.#adotarRepasse(mid, t.receiver.track);
    }
    this.#claimPendingTracks();
  }

  #adotarRepasse(mid, track) {
    if (!this.#slotMapa.has(mid)) return;
    let stream = this.#repasseStreams.get(mid);
    if (!stream) {
      stream = new MediaStream();
      this.#repasseStreams.set(mid, stream);
    }
    for (const old of stream.getTracks()) if (old !== track) stream.removeTrack(old);
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    const publicar = (live) => {
      const s = this.#slotMapa.get(mid);
      if (s && this.#repasseStreams.get(mid)) this.emit("repasse", { de: s.de, role: s.role, stream: this.#repasseStreams.get(mid), track, live });
    };
    if (!this.#wiredRepasse.has(track)) {
      this.#wiredRepasse.add(track);
      track.addEventListener("unmute", () => publicar(true));
      track.addEventListener("mute", () => publicar(false));
    }
    publicar(!track.muted);
  }

  /** Esquece tudo do relé que pertencia ao RTCPeerConnection descartado. */
  #limparRepasse() {
    for (const s of this.#slotMapa.values()) this.emit("repasse", { de: s.de, role: s.role, stream: null, track: null, live: false });
    this.#slotMapa.clear();
    this.#repasseStreams.clear();
    this.#slots.clear();
    this.#livres = { audio: [], video: [] };
    this.#slotsPublicados = "";
  }

  /**
   * Reinício de ICE pedido de fora: a rede mudou (Wi-Fi -> 4G, cabo saiu) ou
   * a conexão parou de receber bytes sem o navegador perceber. Com a conexão
   * ainda de pé, a mídia segue pelo caminho velho até o novo ficar pronto.
   */
  reiniciarIce({ silencioso = false } = {}) {
    if (this.#closed || !this.pc || !this.#mayOffer) return false;
    if (!silencioso) this.emit("restarting", { attempt: this.#restarts + 1 });
    try {
      this.pc.restartIce();
      this.#armRestartWatchdog();
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Negociação
   * ---------------------------------------------------------------- */

  async #onNegotiationNeeded() {
    if (!this.pc || this.#closed) return;
    if (!this.#mayOffer) return; // o lado educado espera a primeira oferta
    if (this.pc.signalingState !== "stable") return;
    try {
      this.#makingOffer = true;
      // Sem argumentos: o navegador cria a descrição certa para o estado atual
      // e não existe intervalo entre criar e aplicar onde o estado possa mudar.
      await this.pc.setLocalDescription();
      this.emit("signal", {
        description: this.pc.localDescription,
        roles: this.#roleMap(),
      });
    } catch (err) {
      console.warn(`[peer ${this.id}] negociação falhou`, err);
    } finally {
      this.#makingOffer = false;
    }
  }

  /**
   * mid -> papel, publicado junto com a descrição para o outro lado. De quebra,
   * alimenta o mapa local: os `mid` são os mesmos nas duas pontas, então quem
   * oferta já sabe interpretar as trilhas que chegarem, mesmo antes da resposta.
   */
  #roleMap() {
    const map = {};
    for (const role of ROLES) {
      const mid = this.tx[role]?.mid;
      if (mid != null) {
        map[mid] = role;
        this.#midRole.set(String(mid), role);
      }
    }
    this.#claimPendingTracks();
    return map;
  }

  /** Processa uma mensagem de sinalização vinda deste par. */
  async handleSignal({ description, candidate, roles, rebuild, resync, slots }) {
    if (this.#closed) return;

    if (slots) {
      this.receberSlots(slots);
      if (!description && !candidate) return;
    }

    // A sinalização do outro lado caiu e voltou (reanimar): a nossa última
    // oferta pode ter ido para o vazio.
    if (resync) {
      await this.reanimar({ avisar: false });
      return;
    }

    /*
     * O outro lado jogou fora a conexão dele e montou outra. Continuar com a
     * nossa deixaria meia conexão de cada lado: DTLS de um, ICE de outro, e
     * nenhuma mídia atravessando. Recomeçar junto é o que fecha a conta.
     * `echo: false` corta o pingue-pongue — quem recebe não avisa de volta.
     */
    if (rebuild) {
      await this.#rebuild({ echo: false });
      return;
    }

    if (!this.pc) return;

    if (roles) {
      for (const [mid, role] of Object.entries(roles)) this.#midRole.set(String(mid), role);
      this.#claimPendingTracks();
    }

    try {
      if (description) {
        const readyForOffer =
          !this.#makingOffer &&
          (this.pc.signalingState === "stable" || this.#settingRemoteAnswer);
        const collision = description.type === "offer" && !readyForOffer;

        this.#ignoreOffer = !this.#polite && collision;
        if (this.#ignoreOffer) return; // o impolido mantém a própria oferta

        this.#settingRemoteAnswer = description.type === "answer";
        // FEC, DTX e estéreo do Opus: pedidos na descrição remota, que é a
        // que configura o nosso encoder (tuning.js, ajustarOpus).
        // Idem para a banda inicial do vídeo (ajustarInicioVideo).
        const sdp = ajustarInicioVideo(ajustarOpus(description.sdp, (mid) => this.#midRole.get(String(mid))));
        // No lado educado, isto desfaz implicitamente a oferta local pendente.
        await this.pc.setRemoteDescription({ type: description.type, sdp });
        this.#settingRemoteAnswer = false;

        await this.#drainCandidates();

        if (description.type === "offer") {
          // Adota as linhas da oferta e vira a direção ANTES de responder —
          // assim a resposta já sai `sendrecv` e não é preciso uma segunda
          // rodada de negociação só para começar a enviar.
          await this.#adoptTransceivers();
          await this.pc.setLocalDescription();
          this.emit("signal", {
            description: this.pc.localDescription,
            roles: this.#roleMap(),
          });
          // A partir daqui o lado educado também pode iniciar negociações
          // (reinício de ICE, troca de perfil de tela).
          this.#mayOffer = true;
        }
      } else if (candidate) {
        if (!this.pc.remoteDescription) {
          // Candidatos podem chegar antes da descrição: guarde, não descarte.
          this.#pendingCandidates.push(candidate);
          return;
        }
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.#ignoreOffer) console.debug(`[peer ${this.id}] candidato recusado`, err?.name);
        }
      }
    } catch (err) {
      console.warn(`[peer ${this.id}] sinalização falhou`, err);
    }
  }

  /**
   * Casa cada linha recebida na oferta com o seu papel e prepara-a para
   * enviar. Chamado só no lado que responde, e só uma vez: nas renegociações
   * seguintes as linhas já estão adotadas.
   */
  async #adoptTransceivers() {
    if (!this.pc) return;
    const byMid = new Map();
    for (const t of this.pc.getTransceivers()) {
      if (t.mid != null) byMid.set(String(t.mid), t);
    }

    let adoptedAny = false;
    for (const [mid, role] of this.#midRole) {
      if (!ROLES.includes(role)) continue;
      const t = byMid.get(String(mid));
      if (!t || this.tx[role] === t) continue;
      this.tx[role] = t;
      adoptedAny = true;
      // A oferta chegou como sendrecv/recvonly; precisamos poder enviar.
      if (t.direction !== "sendrecv") t.direction = "sendrecv";
      if (role === "screen") t.sender.setStreams?.(this.#telaStream);
      if (role === "screen") preferCodecs(t, screenCodecPreference(this.peerCount));
      if (role === "mic") preferRed(t);
    }

    if (adoptedAny) {
      await this.attachLocal(this.#lastLocal);
      this.emit("adopted", Object.keys(this.tx));
    }
  }

  async #drainCandidates() {
    const list = this.#pendingCandidates;
    this.#pendingCandidates = [];
    for (const c of list) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* candidato obsoleto */
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Mídia remota
   * ---------------------------------------------------------------- */

  #pendingTracks = [];

  #onTrack(ev) {
    const { track, transceiver } = ev;
    const mid = String(transceiver.mid ?? "");
    if (this.#slotMapa.has(mid)) {
      this.#adotarRepasse(mid, track);
      return;
    }
    const role = this.#midRole.get(mid);

    if (!role) {
      // O mapa de papéis pode chegar logo depois; não perca a trilha.
      this.#pendingTracks.push(ev);
      return;
    }
    this.#adoptTrack(role, track, transceiver);
  }

  #claimPendingTracks() {
    if (!this.#pendingTracks.length) return;
    const list = this.#pendingTracks;
    this.#pendingTracks = [];
    for (const ev of list) this.#onTrack(ev);
  }

  #adoptTrack(role, track, transceiver) {
    let stream = this.remote[role];
    if (!stream) {
      stream = new MediaStream();
      this.remote[role] = stream;
    }
    for (const old of stream.getTracks()) {
      if (old !== track) stream.removeTrack(old);
    }
    stream.addTrack(track);

    const publish = () => this.emit("media", { role, stream, track, live: !track.muted });

    if (transceiver) this.#midRole.set(String(transceiver.mid), role);

    // A mesma trilha pode ser adotada de novo (mapa de papéis tardio,
    // renegociação). Os ouvintes são ligados uma vez só por trilha.
    if (this.#wired.has(track)) {
      publish();
      return;
    }
    this.#wired.add(track);

    /*
     * `unmute` é o sinal de que quadros começaram a chegar de verdade. Ligar o
     * <video> antes disso é o que produz aquele retângulo preto que nunca sai.
     *
     * O ouvinte é PERMANENTE. A linha de tela é fixa (não se renegocia), então
     * a mesma trilha recebida silencia quando a pessoa para de compartilhar e
     * volta a ter quadros quando ela compartilha de novo. Com `{ once: true }`
     * o segundo compartilhamento da chamada nunca aparecia do outro lado: o
     * estado dizia "compartilhando", o vídeo chegava, e o ladrilho não nascia.
     */
    track.addEventListener("unmute", publish);
    track.addEventListener("mute", () => this.emit("media", { role, stream, track, live: false }));
    track.addEventListener("ended", () => {
      stream.removeTrack(track);
      this.emit("media", { role, stream: null, track: null, live: false });
    });
    // Publica já, mesmo muda: quem decide se o ladrilho aparece é o estado
    // anunciado pela pessoa, e o ladrilho mostra "carregando" até o 1º quadro.
    publish();
  }

  /** Trilhas recebidas que já têm ouvintes ligados. */
  #wired = new WeakSet();

  /* ---------------------------------------------------------------- *
   * Resiliência
   * ---------------------------------------------------------------- */

  #onConnectionState() {
    const state = this.pc?.connectionState;
    this.emit("state", state);
    clearTimeout(this.#graceTimer);

    if (state === "connected") {
      this.#restarts = 0;
      this.#rebuilds = 0;
      clearTimeout(this.#restartWatch);
      return;
    }
    if (state === "disconnected") {
      // "disconnected" às vezes se resolve sozinho em um ou dois segundos.
      // Reiniciar o ICE imediatamente atrapalharia mais do que ajudaria.
      this.#graceTimer = setTimeout(() => this.#tryRestart(), GRACE_MS);
    } else if (state === "failed") {
      this.#tryRestart();
    }
  }

  async #tryRestart() {
    if (this.#closed || !this.pc) return;
    if (this.pc.connectionState === "connected") return;

    if (this.#restarts >= RESTARTS_BEFORE_REBUILD) {
      await this.#rebuild();
      return;
    }
    const wait = RESTART_BACKOFF[Math.min(this.#restarts, RESTART_BACKOFF.length - 1)];
    this.#restarts += 1;
    this.emit("restarting", { attempt: this.#restarts });

    if (wait) await jitter(wait);
    if (this.#closed || this.pc?.connectionState === "connected") return;

    try {
      // Marca a conexão para renegociar com credenciais ICE novas; o fluxo de
      // perfect negotiation cuida do resto, inclusive de um conflito simultâneo.
      this.pc.restartIce();
      // restartIce() só pede uma renegociação; se a sinalização não estiver
      // estável naquele instante, o pedido se perde em silêncio. Este alarme
      // é o que garante que a tentativa não morra aí.
      this.#armRestartWatchdog();
    } catch (err) {
      console.warn(`[peer ${this.id}] restartIce falhou`, err);
    }
  }

  #armRestartWatchdog() {
    clearTimeout(this.#restartWatch);
    this.#restartWatch = setTimeout(() => {
      if (this.#closed || this.pc?.connectionState === "connected") return;
      this.#tryRestart();
    }, 9000);
  }

  /**
   * Descarta o RTCPeerConnection e monta outro do zero.
   *
   * A partir da segunda reconstrução, força o tráfego por TURN
   * (`iceTransportPolicy: "relay"`). Se a conexão direta já falhou várias
   * vezes, insistir nela é gastar mais uma rodada no caminho que não funciona:
   * quase sempre há um NAT simétrico ou um firewall corporativo no meio, e o
   * relay é o único que atravessa. Sem TURN configurado, não há o que forçar —
   * e aí a mensagem para o usuário é a única saída honesta.
   */
  async #rebuild({ echo = true } = {}) {
    if (this.#closed) return;

    if (this.#rebuilds >= MAX_REBUILDS) {
      this.emit("exhausted");
      return;
    }
    this.#rebuilds += 1;
    this.#restarts = 0;
    clearTimeout(this.#restartWatch);

    const viaRelay =
      this.#rebuilds >= 2 && (this.#config?.iceServers || []).some((s) => hasTurn(s));
    this.emit("rebuilding", { attempt: this.#rebuilds, relay: viaRelay });
    // Avisa antes de derrubar: a mensagem ainda sai pela sinalização, que é
    // independente do P2P que está sendo descartado.
    if (echo) this.emit("signal", { rebuild: true });

    await jitter(1200 * this.#rebuilds);
    if (this.#closed) return;

    const old = this.pc;
    this.pc = null;
    try {
      old?.close();
    } catch {
      /* já fechado */
    }

    // Estado que pertencia à conexão anterior. Mantê-lo faria o novo
    // RTCPeerConnection herdar mids e candidatos que não existem mais.
    this.#midRole.clear();
    this.#limparRepasse();
    this.#pendingCandidates = [];
    this.#pendingTracks = [];
    this.remote = { mic: null, cam: null, screen: null, screenAudio: null };
    this.tx = {};
    this.#makingOffer = false;
    this.#ignoreOffer = false;
    this.#settingRemoteAnswer = false;

    /*
     * Volta à assimetria do começo: só o lado impolido cria as linhas e
     * oferta. Deixar os dois ofertando sobre RTCPeerConnections novos é
     * exatamente o cenário descrito no cabeçalho deste arquivo — cada
     * navegador acabaria com oito linhas, quatro delas enviando para o vazio,
     * e a tela apareceria só de um lado. Como o aviso de reconstrução vai para
     * o outro lado, os dois recomeçam e o impolido oferta.
     */
    this.#mayOffer = !this.#polite;

    const config = viaRelay ? { ...this.#config, iceTransportPolicy: "relay" } : this.#config;
    this.#config = config;
    this.#build(this.#lastLocal);
    this.emit("rebuilt", { relay: viaRelay });
  }

  /**
   * A sinalização caiu e voltou, e este par continuou na sala (mesmo id).
   *
   * Durante a queda, uma oferta (de um reinício de ICE, de uma câmera ligada)
   * pode ter ido para o vazio: quem a fez fica em "have-local-offer" esperando
   * uma resposta que nunca chega, e nenhuma negociação nova acontece mais.
   * Desfaz a oferta pendente, avisa o outro lado para fazer o mesmo e, se a
   * mídia também caiu, recomeça o ICE do zero em vez de esperar o vigia.
   */
  async reanimar({ avisar = true } = {}) {
    if (this.#closed || !this.pc) return;
    let desfez = false;
    if (this.pc.signalingState === "have-local-offer") {
      try {
        await this.pc.setLocalDescription({ type: "rollback" });
        desfez = true;
      } catch {
        /* o estado mudou no meio do caminho */
      }
    }
    this.#makingOffer = false;
    if (avisar) this.emit("signal", { resync: true });
    if (this.pc?.connectionState === "connected") {
      if (desfez) this.#onNegotiationNeeded(); // refaz a negociação que se perdeu
      return;
    }
    this.#restarts = 0;
    this.#tryRestart();
  }

  /** Força uma renegociação completa (usada depois de trocar o perfil de tela). */
  renegotiate() {
    this.#onNegotiationNeeded();
  }

  /* ---------------------------------------------------------------- *
   * Dados
   * ---------------------------------------------------------------- */

  sendBoard(payload) {
    if (this.board?.readyState !== "open") return false;
    try {
      this.board.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendCursor(payload) {
    if (this.cursor?.readyState !== "open") return false;
    try {
      this.cursor.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Estado de voz. Perder um pacote aqui não custa nada: vem outro em 100 ms. */
  sendAudio(payload) {
    if (this.audioCtl?.readyState !== "open") return false;
    try {
      this.audioCtl.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Carga pesada (imagens do canvas). Devolve false quando o canal está
   * cheio, para que o remetente espere em vez de estourar a memória do
   * navegador — um `send` que ignora o buffer derruba a conexão inteira.
   */
  sendBlob(payload) {
    if (this.blob?.readyState !== "open") return false;
    if (this.blob.bufferedAmount > BLOB_HIGH_WATER) return false;
    try {
      this.blob.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Espera o canal de carga pesada esvaziar. Usado entre pedaços de imagem. */
  drainBlob() {
    const ch = this.blob;
    if (!ch || ch.readyState !== "open" || ch.bufferedAmount <= BLOB_HIGH_WATER) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        ch.removeEventListener("bufferedamountlow", done);
        resolve();
      };
      ch.addEventListener("bufferedamountlow", done);
      setTimeout(done, 3000);
    });
  }

  /* ---------------------------------------------------------------- */

  async getStats() {
    if (!this.pc || this.#closed) return null;
    try {
      return await this.pc.getStats();
    } catch {
      return null;
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#graceTimer);
    clearTimeout(this.#restartWatch);
    try {
      this.board?.close();
      this.cursor?.close();
      this.audioCtl?.close();
      this.blob?.close();
    } catch {
      /* já fechado */
    }
    try {
      this.pc?.close();
    } catch {
      /* idem */
    }
    this.pc = null;
    this.clear();
  }
}
