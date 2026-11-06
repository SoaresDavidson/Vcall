/**
 * core/mesh.js — a sala.
 *
 * Costura sinalização, mídia local e conexões P2P num único objeto com o qual
 * a interface conversa. Topologia em malha: cada participante mantém uma
 * conexão direta com cada outro. É o que permite criptografia fim a fim sem
 * servidor de mídia, e é também por isso que o limite de participantes é baixo
 * — com N pessoas, cada uma codifica N−1 vezes.
 */
import { Emitter } from "../lib/emitter.js";
import { deviceToken, hostKeyFor, sessionToken } from "../lib/identity.js";
import { Peer } from "./peer.js";
import { Rele } from "./rele.js";
import { SfuSala } from "./sfu.js";
import { StatsMonitor } from "./stats.js";
import { marcarH264PorSoftware } from "./tuning.js";
import { VoiceActivity } from "./vad.js";

/**
 * Entrega um pedaço no canal de carga pesada de um participante, esperando o
 * buffer esvaziar quantas vezes for preciso. Só desiste se o canal não abrir
 * a tempo ou fechar no meio.
 */
async function entregarBlob(peer, data, { limiteMs = 60_000 } = {}) {
  const ate = Date.now() + limiteMs;
  while (Date.now() < ate) {
    if (peer.sendBlob(data)) return true;
    const aberto = peer.blob?.readyState === "open";
    if (aberto) await peer.drainBlob();
    else await new Promise((r) => setTimeout(r, 250)); // canal ainda abrindo
    if (peer.blob && (peer.blob.readyState === "closing" || peer.blob.readyState === "closed")) return false;
  }
  return false;
}

export class Mesh extends Emitter {
  /** @type {Map<string, Peer>} */ peers = new Map();
  /** @type {Map<string, object>} */ profiles = new Map();
  /** @type {Map<string, object>} */ states = new Map();

  selfId = null;
  self = null;
  hostId = null;
  iceConfig = null;
  joinedAt = 0;

  constructor({ signaling, media, screen }) {
    super();
    this.signaling = signaling;
    this.media = media;
    this.screen = screen;

    this.vad = new VoiceActivity();
    this.stats = new StatsMonitor(() => this.peers.values());
    this.rele = new Rele(this);
    this.sfu = new SfuSala(this);

    this.#wireSignaling();
    this.#wireMedia();
    this.#wireStats();
  }

  get size() {
    return this.peers.size + 1;
  }

  /** peerId -> quando levantou a mão (ordem da fila). */
  handAt = new Map();
  /** Sala de espera, para o anfitrião: id -> { id, name, avatar }. */
  knocks = new Map();
  /** (Anfitrião) quem foi removido e pode ser readmitido. */
  banned = [];

  get isHost() {
    return this.hostId === this.selfId;
  }

  /* ---------------------------------------------------------------- *
   * Entrada e saída
   * ---------------------------------------------------------------- */

  async join({ room, profile, state, meta = null, pass = "" }) {
    this.iceConfig = await fetchIceConfig();
    this.emit("ice", this.iceConfig);
    this.room = room;
    this.roomMeta = meta;
    this.signaling.join({
      room,
      profile,
      state,
      meta,
      pass,
      hostKey: hostKeyFor(room),
      session: sessionToken(),
      device: deviceToken(),
    });
  }

  /** Ação de anfitrião. O servidor confere se quem pede é mesmo o anfitrião. */
  moderate(action, target = "") {
    return this.signaling.send({ t: "moderate", action, target });
  }

  /**
   * Passa a acompanhar o próprio microfone no detector de fala.
   *
   * Sem isto, o destaque de "está falando" aparecia para todo mundo menos
   * para quem fala — o analisador só via as trilhas que chegavam pela rede.
   * A origem é o stream local de captura, antes de qualquer conexão.
   */
  trackSelfAudio() {
    if (!this.selfId) return;
    const stream = this.media.stream;
    if (!stream || !stream.getAudioTracks().length) {
      this.vad.untrack(this.selfId);
      return;
    }
    if (this.#selfTracked === stream) return;
    this.#selfTracked = stream;
    this.vad.track(this.selfId, stream);
  }

  #selfTracked = null;

  leave() {
    this.stats.stop();
    this.rele.stop();
    this.sfu.stop();
    this.vad.stop();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.profiles.clear();
    this.states.clear();
    this.signaling.close();
    this.emit("left");
  }

  /* ---------------------------------------------------------------- *
   * Sinalização
   * ---------------------------------------------------------------- */

  #wireSignaling() {
    const sig = this.signaling;

    sig.on("welcome", (m) => {
      const first = !this.selfId;
      // O servidor devolve o mesmo id a quem volta logo depois de uma queda:
      // para os outros, ninguém saiu, e as conexões diretas continuam valendo.
      const mesmoId = m.you.id === this.selfId;
      this.selfId = m.you.id;
      this.self = m.you;
      this.hostId = m.you.host ? m.you.id : this.hostId;
      if (first) this.joinedAt = Date.now();

      // Reconexão: pares que sumiram da lista são descartados. Com id novo,
      // todos: do outro lado, as conexões com o id antigo já foram fechadas.
      const alive = new Set(m.peers.map((p) => p.id));
      for (const id of [...this.peers.keys()]) {
        if (!mesmoId || !alive.has(id)) this.#dropPeer(id);
      }
      if (mesmoId) for (const peer of this.peers.values()) peer.reanimar();

      for (const p of m.peers) this.#addPeer(p);
      this.stats.start();
      this.rele.start();
      this.sfu.start();
      this.trackSelfAudio();
      this.room = this.room || m.room?.id;
      this.roomInfo = m.room || null;
      this.emit("joined", { self: m.you, peers: m.peers, room: m.room, reconnected: !first });
      this.emit("roster", this.roster());
    });

    sig.on("peer-join", (m) => {
      // Reconexão de alguém que caiu: o id antigo sai antes de o novo entrar.
      // O servidor já avisou a saída; isto cobre o caso de o aviso se perder.
      if (m.replaces && this.peers.has(m.replaces)) {
        const profile = this.profiles.get(m.replaces);
        this.#dropPeer(m.replaces);
        this.emit("peer-leave", { id: m.replaces, profile, replaced: true });
      }
      this.#addPeer(m.peer);
      this.emit("peer-join", { ...m.peer, reconnected: !!m.replaces });
      this.emit("roster", this.roster());
    });

    sig.on("peer-leave", (m) => {
      if (!this.peers.has(m.id) && !this.profiles.has(m.id)) return; // já tratado
      const profile = this.profiles.get(m.id);
      this.#dropPeer(m.id);
      if (m.newHost) this.hostId = m.newHost;
      this.emit("peer-leave", { id: m.id, profile, replaced: !!m.replacedBy });
      this.emit("roster", this.roster());
    });

    sig.on("host", (m) => {
      this.hostId = m.id;
      this.emit("host", { id: m.id, self: m.id === this.selfId });
      this.emit("roster", this.roster());
    });
    sig.on("moderated", (m) => this.emit("moderated", m));
    // Sala de espera: quem espera recebe "waiting"; o anfitrião, "knock".
    sig.on("waiting", (m) => this.emit("waiting", m));
    sig.on("knock", (m) => {
      this.knocks.set(m.id, { id: m.id, name: m.name, avatar: m.avatar });
      this.emit("knock", m);
    });
    sig.on("knock-gone", (m) => {
      this.knocks.delete(m.id);
      this.emit("knock-gone", m);
    });
    sig.on("banned", (m) => {
      this.banned = Array.isArray(m.list) ? m.list : [];
      this.emit("banned", { list: this.banned, readmitted: m.readmitted || null });
    });
    sig.on("room", (m) => {
      this.roomInfo = { ...(this.roomInfo || {}), closed: !!m.closed };
      this.emit("room-closed", { closed: !!m.closed, by: m.by });
    });

    sig.on("signal", (m) => {
      this.peers.get(m.from)?.handleSignal(m.d);
    });

    sig.on("profile", (m) => {
      const p = this.profiles.get(m.id) || {};
      const next = { ...p, name: m.name, avatar: m.avatar };
      this.profiles.set(m.id, next);
      const peer = this.peers.get(m.id);
      if (peer) peer.profile = next;
      this.emit("profile", { id: m.id, profile: next });
      this.emit("roster", this.roster());
    });

    sig.on("state", (m) => {
      // Ordem das mãos levantadas: guarda quando cada uma subiu.
      const antes = this.states.get(m.id) || {};
      if (m.state?.hand && !antes.hand) this.handAt.set(m.id, Date.now());
      if (!m.state?.hand) this.handAt.delete(m.id);
      this.states.set(m.id, m.state);
      this.emit("peer-state", { id: m.id, state: m.state });
      this.emit("roster", this.roster());
    });

    sig.on("chat", (m) => this.emit("chat", m));
    // Plano B do VAD: pares que ainda não abriram o canal de dados.
    sig.on("audio", (m) => {
      if (m.id === this.selfId) return;
      this.vad.levels.set(m.id, m.level || 0);
      this.emit("speaking", { id: m.id, speaking: !!m.speaking, level: m.level || 0, via: "server" });
    });
    sig.on("rooms", (m) => this.emit("rooms", m.rooms || []));
    sig.on("reaction", (m) => this.emit("reaction", m));
    // Fallback do quadro para pares que ainda não abriram o canal de dados.
    sig.on("board", (m) => this.emit("board", { from: m.id, op: m.op, via: "server" }));

    sig.on("reconnecting", (info) => this.emit("link", { status: "reconnecting", ...info }));
    sig.on("open", () => this.emit("link", { status: "online" }));
    sig.on("close", () => this.emit("link", { status: "offline" }));
    sig.on("error", (e) => this.emit("link", { status: "error", ...e }));
  }

  /* ---------------------------------------------------------------- *
   * Pares
   * ---------------------------------------------------------------- */

  #addPeer(info) {
    if (this.peers.has(info.id) || info.id === this.selfId) return;

    this.profiles.set(info.id, { name: info.name, avatar: info.avatar });
    this.states.set(info.id, info.state || {});
    if (info.host) this.hostId = info.id;

    const peer = new Peer({
      id: info.id,
      selfId: this.selfId,
      config: this.iceConfig,
      profile: { name: info.name, avatar: info.avatar },
      local: this.#localSnapshot(),
      peerCount: this.peers.size + 1,
    });
    peer.screenProfile = this.screen.profile;

    peer.on("signal", (d) => this.signaling.signal(info.id, d));
    peer.on("media", ({ role, stream, live }) => {
      this.#guardar(this.#direta, info.id, role, { stream, live });
      this.#emitirMidia(info.id, role, { sempre: true });
    });
    // Trilha de OUTRA pessoa que este par repassa (core/rele.js).
    peer.on("repasse", ({ de, role, stream, live }) => {
      if (de === this.selfId) return;
      const porAjudante = this.#repassada.get(de) || new Map();
      this.#repassada.set(de, porAjudante);
      this.#guardar(porAjudante, info.id, role, stream ? { stream, live } : null);
      this.#emitirMidia(de, role, { sempre: true });
    });
    peer.on("state", (state) => this.emit("peer-connection", { id: info.id, state }));
    peer.on("restarting", (i) => this.emit("peer-connection", { id: info.id, state: "restarting", ...i }));
    peer.on("exhausted", () => this.emit("peer-connection", { id: info.id, state: "exhausted" }));
    peer.on("stable", () => {
      // Depois de cada negociação, os parâmetros do encoder podem ter sido
      // zerados pelo navegador. Reaplicar aqui é o que mantém a tela nítida
      // quando alguém entra ou sai no meio de uma apresentação.
      peer.retune(this.#localSnapshot());
    });
    peer.on("rebuilding", (i) => this.emit("peer-connection", { id: info.id, state: "rebuilding", ...i }));
    /*
     * O canal abriu — pela primeira vez, ou de novo depois de uma
     * reconstrução. Nos dois casos o outro lado pode ter perdido operações
     * enquanto o canal esteve fechado, e é aqui que a reconciliação começa.
     */
    peer.on("board:open", () => {
      this.emit("board-channel", { id: info.id });
      // Quem chegou agora precisa saber que esta janela está escondida.
      if (!this.#vendo) peer.sendBoard({ type: "ver", cam: false });
      for (const m of this.#chatPendente.get(info.id) || []) peer.sendBoard(m);
      this.#chatPendente.delete(info.id);
    });
    peer.on("board:message", (raw) => this.#onPeerData(info.id, raw, "board"));
    peer.on("cursor:message", (raw) => this.#onPeerData(info.id, raw, "cursor"));
    peer.on("audio:message", (raw) => this.#onPeerData(info.id, raw, "audio"));
    peer.on("blob:message", (raw) => this.#onPeerData(info.id, raw, "board"));

    this.peers.set(info.id, peer);
    this.emit("peer-added", { id: info.id, peer });
    this.#ajustarCameras();
  }

  /** Mais ou menos gente na sala: a câmera enviada a cada um muda de degrau (tuning.cameraParaSala). */
  #ajustarCameras() {
    const outros = this.peers.size;
    for (const peer of this.peers.values()) if (peer.peerCount !== outros) peer.ajustarCamera(outros);
  }

  #dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.#blobFilas.delete(id);
    this.#chatPendente.delete(id);
    peer.close();
    this.peers.delete(id);
    this.profiles.delete(id);
    this.states.delete(id);
    this.vad.untrack(id);
    this.stats.forget(id);
    this.rele.esquecer(id);
    this.sfu.esquecer(id);
    this.#viaSfu.delete(id);
    this.#direta.delete(id);
    this.#repassada.delete(id);
    this.#emitida.delete(id);
    for (const porAjudante of this.#repassada.values()) porAjudante.delete(id);
    for (const de of this.#repassada.keys()) for (const role of ["mic", "cam", "screen", "screenAudio"]) this.#emitirMidia(de, role);
    this.emit("peer-removed", { id });
    this.#ajustarCameras();
  }

  /* ---------------------------------------------------------------- *
   * De onde vem cada trilha: direto da pessoa ou por um ajudante (rele.js)
   * ---------------------------------------------------------------- */

  /** id -> papel -> { stream, live } recebido direto da pessoa. */
  #direta = new Map();
  /** de -> ajudante -> papel -> { stream, live } repassado por um terceiro. */
  #repassada = new Map();
  /** id -> papel -> o que a interface recebeu por último. */
  #emitida = new Map();
  /** id -> papel -> { stream, live } recebido pelo SFU de quem transmite (core/sfu.js). */
  #viaSfu = new Map();

  /** O SFU entregou (ou deixou de entregar) a tela de `id`. */
  receberSfu(id, role, valor) {
    this.#guardar(this.#viaSfu, id, role, valor);
    this.#emitirMidia(id, role, { sempre: true });
  }

  #guardar(mapa, id, role, valor) {
    const porPapel = mapa.get(id) || {};
    if (valor) porPapel[role] = valor;
    else delete porPapel[role];
    mapa.set(id, porPapel);
  }

  /** O ajudante que entrega (id, papel), ou null para a conexão direta. */
  fonteDe(id, role) {
    return this.rele.fonte(id, role, {
      repassada: (h) => this.#repassada.get(id)?.get(h)?.[role],
      direta: this.#direta.get(id)?.[role],
    });
  }

  /**
   * Entrega à interface a trilha da fonte escolhida. A interface não sabe de
   * relé: ela continua recebendo "media" de (id, papel), e só o stream muda.
   */
  #emitirMidia(id, role, { sempre = false } = {}) {
    if (!this.peers.has(id)) return;
    // O SFU vence quando tem quadros (ou quando a direta não tem): a origem
    // desliga a direta assim que esta pessoa confirma o SFU.
    const sfu = this.#viaSfu.get(id)?.[role];
    const direta = this.#direta.get(id)?.[role];
    const peloSfu = !!sfu?.stream && (sfu.live || !direta?.live);
    const h = peloSfu ? "sfu" : this.fonteDe(id, role);
    const atual = (peloSfu ? sfu : h ? this.#repassada.get(id)?.get(h)?.[role] : direta) || null;
    const emitida = this.#emitida.get(id)?.[role];
    if (!atual && !emitida) return;
    // Reavaliação sem mudança não incomoda a interface; evento da própria trilha passa sempre.
    if (!sempre && emitida && atual && emitida.stream === atual.stream && emitida.live === atual.live) return;
    this.#guardar(this.#emitida, id, role, atual ? { ...atual } : { stream: null, live: false });
    if (role === "mic" && atual?.stream) this.vad.track(id, atual.stream);
    this.emit("media", { id, role, stream: atual?.stream || null, live: !!atual?.live, via: h });
  }

  /** O relé mudou de plano: confere a fonte de tudo que já chegou. */
  reavaliarMidia() {
    const ids = new Set([...this.#direta.keys(), ...this.#repassada.keys()]);
    for (const id of ids) for (const role of ["mic", "cam", "screen", "screenAudio"]) this.#emitirMidia(id, role);
  }

  #onPeerData(from, raw, channel) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === "cursor") {
      this.emit("cursor", { from, ...msg });
      return;
    }
    if (channel === "audio") {
      // O nível chega quadro a quadro; guardá-lo aqui é o que faz a barrinha
      // do participante remoto se mexer junto com a voz dele.
      this.vad.levels.set(from, msg.level || 0);
      this.emit("speaking", { id: from, speaking: !!msg.speaking, level: msg.level || 0, via: "p2p" });
      return;
    }
    if (msg?.type === "chat") {
      // As mesmas regras que o servidor aplicava (src/protocol.js).
      const text = typeof msg.text === "string" ? msg.text.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 2000).trim() : "";
      if (text) this.emit("chat", { id: from, name: this.profiles.get(from)?.name || "Convidado", text, at: Date.now() });
      return;
    }
    if (msg?.type === "rede") {
      this.rele.receber(from, msg);
      return;
    }
    if (msg?.type === "sfu" || msg?.type === "sfu-ok") {
      this.sfu.receber(from, msg);
      return;
    }
    if (msg?.type === "slots") {
      this.peers.get(from)?.receberSlots(msg.slots);
      return;
    }
    // "Não estou vendo o seu vídeo": a câmera para de ser enviada a este par.
    if (msg?.type === "ver") {
      this.peers.get(from)?.pausarCamera(msg.cam === false);
      return;
    }
    this.emit("board", { from, op: msg, via: "p2p" });
  }

  /**
   * Janela minimizada ou em outra aba: os outros param de mandar câmera para
   * cá (voz e tela continuam). É banda de subida que eles economizam — numa
   * malha, cada câmera é codificada uma vez por pessoa que a recebe.
   */
  #vendo = true;
  verVideo(vendo) {
    if (this.#vendo === !!vendo) return;
    this.#vendo = !!vendo;
    for (const peer of this.peers.values()) peer.sendBoard({ type: "ver", cam: this.#vendo });
  }

  /* ---------------------------------------------------------------- *
   * Mídia local -> todos os pares
   * ---------------------------------------------------------------- */

  #localSnapshot() {
    return {
      mic: this.media.micTrack,
      cam: this.media.camTrack,
      screen: this.screen.sendTrack || this.screen.videoTrack,
      screenAudio: this.screen.audioTrack,
      screenProfile: this.screen.profile,
    };
  }

  #wireMedia() {
    const push = () => {
      const local = this.#localSnapshot();
      for (const peer of this.peers.values()) {
        peer.screenProfile = local.screenProfile;
        peer.attachLocal(local);
      }
      this.publishState();
    };

    this.media.on("change", () => {
      // Trocar de microfone cria um stream novo; o detector precisa segui-lo.
      this.#selfTracked = null;
      this.trackSelfAudio();
      push();
    });
    this.screen.on("change", push);
    // Trocar entre "texto" e "movimento" muda a dica de conteúdo e a política
    // de degradação; basta reaplicar o perfil, sem renegociar nada.
    const retunar = () => {
      const local = this.#localSnapshot();
      for (const peer of this.peers.values()) {
        peer.screenProfile = local.screenProfile;
        peer.retune(local);
      }
    };
    this.screen.on("mode", retunar);
    // Outro codec para a tela (stats.js, "codec-da-tela"): também sem renegociar.
    this.screen.on("perfil", retunar);

    this.on("peer-added", ({ peer }) => peer.attachLocal(this.#localSnapshot()));
  }

  #wireStats() {
    this.stats.on("update", (samples) => this.emit("stats", samples));
    this.stats.on("limited", (info) => this.emit("limited", info));
    this.stats.on("codec-da-tela", () => {
      marcarH264PorSoftware();
      this.screen.reavaliarCodecs();
    });
    this.stats.on("tela-em-movimento", () => this.screen.fluidezAutomatica());
    this.vad.on("speaking", (e) => {
      this.emit("speaking", e);
      // A própria transição fala/cala vai para todo mundo: quem me silenciou
      // localmente, ou está com o áudio desligado, continua vendo que eu falo.
      if (e.id === this.selfId) this.#publishSpeaking(e.speaking, e.level);
    });
    this.vad.on("active", (id) => this.emit("active-speaker", id));

    // Nível contínuo do próprio microfone, só pelo DataChannel. Não vai pelo
    // servidor de propósito: seriam dezenas de mensagens por segundo.
    setInterval(() => {
      if (!this.selfId || !this.peers.size) return;
      const level = this.vad.levelOf(this.selfId);
      if (level < 0.004 && !this.#lastSpeaking) return;
      const payload = { speaking: this.#lastSpeaking, level: Number(level.toFixed(3)) };
      for (const peer of this.peers.values()) peer.sendAudio(payload);
    }, 120);
  }

  #lastSpeaking = false;

  #publishSpeaking(speaking, level = 0) {
    this.#lastSpeaking = speaking;
    const payload = { speaking, level: Number((level || 0).toFixed(3)) };
    let needsFallback = false;
    for (const peer of this.peers.values()) {
      if (!peer.sendAudio(payload)) needsFallback = true;
    }
    if (needsFallback) this.signaling.audio(payload);
  }

  /** Pede ao servidor o diretório de salas públicas. */
  listRooms() {
    this.signaling.send({ t: "list-rooms" });
  }

  /* ---------------------------------------------------------------- *
   * Publicação de estado
   * ---------------------------------------------------------------- */

  publishState(extra = {}) {
    const state = {
      mic: this.media.micEnabled,
      cam: this.media.camEnabled,
      screen: this.screen.active,
      hand: !!this.localState?.hand,
      board: !!this.localState?.board,
      ...extra,
    };
    if (state.hand && !this.localState?.hand) this.handAt.set(this.selfId, Date.now());
    if (!state.hand) this.handAt.delete(this.selfId);
    this.localState = state;
    this.signaling.updateState(state);
    this.emit("self-state", state);
    return state;
  }

  updateProfile(profile) {
    this.self = { ...this.self, ...profile };
    this.signaling.updateProfile(profile);
    this.emit("roster", this.roster());
  }

  /* ---------------------------------------------------------------- *
   * Difusão
   * ---------------------------------------------------------------- */

  /**
   * Manda uma operação do quadro para todos. O caminho normal é o DataChannel
   * (direto, sem servidor). Se algum par ainda não abriu o canal, aquele par
   * recebe pelo servidor — sem duplicar para quem já recebeu por P2P.
   */
  broadcastBoard(op, { fallback = true } = {}) {
    let needsFallback = false;
    for (const peer of this.peers.values()) {
      if (!peer.sendBoard(op)) needsFallback = true;
    }
    /*
     * `fallback: false` para conteúdo descartável — legenda parcial, por
     * exemplo. O caminho pelo servidor reentrega a mensagem para TODOS, e não
     * só para quem ficou sem canal direto; com legendas ao vivo isso virava
     * dezenas de mensagens por segundo multiplicadas pela sala inteira, e era
     * o que estourava o limite de taxa e derrubava a conexão.
     */
    if (needsFallback && fallback) this.signaling.board(op);
  }

  broadcastCursor(payload) {
    for (const peer of this.peers.values()) peer.sendCursor(payload);
  }

  /**
   * Carga pesada do canvas (imagens). Vai pelo canal separado, e espera o
   * buffer esvaziar entre os pedaços em vez de empurrar tudo de uma vez.
   */
  broadcastBlob(payload) {
    /*
     * ANTES: cada pedaço tentava uma vez, esperava o buffer no máximo 3 s e
     * tentava de novo — se ainda não coubesse, o pedaço era DESCARTADO em
     * silêncio. Como quem chamava não esperava um pedaço sair antes de mandar
     * o próximo, arquivos de alguns MB perdiam pedaços e nunca terminavam de
     * chegar, e a ordem podia se embaralhar.
     *
     * AGORA: uma fila por participante. Cada pedaço só sai depois do
     * anterior, espera o buffer quanto for preciso e só desiste se o canal
     * fechar. A promessa diz para quem chegou e para quem não chegou.
     */
    const data = JSON.stringify(payload);
    const envios = [...this.peers.entries()].map(([id, peer]) => {
      const anterior = this.#blobFilas.get(id) || Promise.resolve(true);
      const proximo = anterior.then(() => entregarBlob(peer, data)).catch(() => false);
      this.#blobFilas.set(id, proximo);
      return proximo.then((ok) => ({ id, ok }));
    });
    return Promise.all(envios).then((r) => ({
      ok: r.filter((x) => x.ok).map((x) => x.id),
      falhou: r.filter((x) => !x.ok).map((x) => x.id),
    }));
  }

  /** peerId -> promessa do último pedaço na fila daquele participante. */
  #blobFilas = new Map();

  /*
   * O chat vai pelo canal direto (DTLS), nunca pelo servidor. Pelo servidor,
   * o texto passava aberto pelo computador de quem convidou e pela borda da
   * Cloudflare, e o selo "criptografada ponta a ponta" não era verdade para
   * ele. Quem ainda não tem o canal aberto recebe quando ele abrir.
   */
  #chatPendente = new Map(); // peerId -> mensagens esperando o canal

  sendChat(text) {
    const msg = { type: "chat", text };
    for (const [id, peer] of this.peers) {
      if (peer.sendBoard(msg)) continue;
      this.#chatPendente.set(id, [...(this.#chatPendente.get(id) || []), msg].slice(-50));
    }
  }

  sendReaction(kind) {
    this.signaling.reaction(kind);
  }

  /* ---------------------------------------------------------------- */

  roster() {
    const list = [];
    if (this.self) {
      list.push({
        id: this.selfId,
        self: true,
        name: this.self.name,
        avatar: this.self.avatar,
        state: this.localState || {},
        handAt: this.localState?.hand ? this.handAt.get(this.selfId) || 0 : 0,
        host: this.hostId === this.selfId,
        connection: "connected",
        quality: "good",
      });
    }
    for (const [id, peer] of this.peers) {
      const profile = this.profiles.get(id) || {};
      list.push({
        id,
        self: false,
        name: profile.name,
        avatar: profile.avatar,
        state: this.states.get(id) || {},
        handAt: this.handAt.get(id) || 0,
        host: this.hostId === id,
        connection: peer.connectionState,
        quality: this.stats.samples.get(id)?.quality || "unknown",
      });
    }
    return list;
  }
}

/** Busca a configuração de ICE no servidor. Nunca embutida no HTML. */
async function fetchIceConfig() {
  const fallback = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 1,
    hasTurn: false,
  };
  try {
    const res = await fetch("/ice", { cache: "no-store" });
    if (!res.ok) return fallback;
    const cfg = await res.json();
    return cfg?.iceServers?.length ? cfg : fallback;
  } catch {
    return fallback;
  }
}
