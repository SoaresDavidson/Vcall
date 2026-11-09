/**
 * core/signaling.js — cliente do canal de sinalização.
 *
 * A sinalização é o único canal que passa pelo servidor, e ela é frágil por
 * natureza: celular que dorme, Wi-Fi que troca, proxy que derruba conexões
 * ociosas. Por isso este módulo reconecta sozinho, com backoff e jitter, e
 * reanuncia o participante ao voltar. A chamada de mídia em si sobrevive a
 * quedas curtas de sinalização — as conexões P2P já estabelecidas continuam.
 */
import { Emitter } from "../lib/emitter.js";
import { clamp } from "../lib/util.js";

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

/** Recusas em que insistir não leva a lugar nenhum. */
const FATAL = new Set(["room-full", "bad-room", "bad-password", "already-joined", "kicked", "room-locked"]);

/**
 * Sem pong nesse tempo, a conexão é considerada morta.
 *
 * Um socket pode parar de entregar dados sem nunca disparar `close`: é o caso
 * clássico do Wi-Fi que troca de ponto, do celular que dorme e do NAT que
 * esquece a tradução. Do lado de cá tudo parece aberto, `readyState` continua
 * OPEN, e a sala simplesmente congela. O ping já existia; faltava reparar que
 * a resposta não veio.
 */
const PONG_TIMEOUT_MS = 12_000;
const PING_EVERY_MS = 15_000;

export class Signaling extends Emitter {
  #socket = null;
  #url;
  #joinPayload = null;
  #attempt = 0;
  #timer = 0;
  #closedByUs = false;
  #queue = [];
  #pingSeq = 0;
  #pingSentAt = 0;
  #pingTimer = 0;
  #pongTimer = 0;
  #wokeBound = false;

  /** Round-trip até o servidor de sinalização, em ms (não é a latência de mídia). */
  serverRtt = null;
  #diferencaDoServidor = 0;

  constructor(url = null) {
    super();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.#url = url || `${proto}//${location.host}`;
    this.#bindWake();
  }

  /**
   * Rede que volta e aba que reaparece encurtam a espera.
   *
   * O backoff chega a 20 segundos. Quando alguém fecha o notebook numa reunião
   * e reabre, esperar esses 20 segundos parados é a diferença entre "voltou na
   * hora" e "travou". Estes eventos são justamente o aviso de que vale tentar
   * agora, e não daqui a pouco.
   */
  #bindWake() {
    if (this.#wokeBound) return;
    this.#wokeBound = true;
    const wake = () => {
      if (this.#closedByUs || !this.#joinPayload || this.connected) return;
      this.#attempt = 0; // a espera acumulada já não descreve a situação
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#connect(), 150);
    };
    addEventListener("online", wake);
    addEventListener("pageshow", wake);
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
  }

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Entra na sala. Guarda o payload para reenviar automaticamente em cada
   * reconexão — do ponto de vista do chamador, `join` é feito uma vez só.
   */
  join({ room, profile, state, meta = null, pass = "", hostKey = "", session = "", device = "" }) {
    this.#joinPayload = { t: "join", room, profile, state, meta, pass, hostKey, session, device };
    this.#closedByUs = false;
    this.#connect();
  }

  updateProfile(profile) {
    if (this.#joinPayload) this.#joinPayload.profile = profile;
    this.send({ t: "profile", profile });
  }

  updateState(state) {
    if (this.#joinPayload) this.#joinPayload.state = state;
    this.send({ t: "state", state });
  }

  signal(to, d) {
    this.send({ t: "signal", to, d });
  }

  reaction(kind) {
    this.send({ t: "reaction", kind });
  }

  board(op) {
    this.send({ t: "board", op });
  }

  /** Plano B do indicador de voz, quando o DataChannel ainda não abriu. */
  audio(payload) {
    this.send({ t: "audio", ...payload });
  }

  listRooms() {
    this.send({ t: "list-rooms" });
  }

  /**
   * A hora no relógio do servidor da sala (ms), igual para todos os
   * participantes. Sem um pong ainda, vale a hora deste computador.
   */
  agoraNoServidor() {
    return Date.now() + this.#diferencaDoServidor;
  }

  /**
   * Envia; se estiver desconectado, enfileira. A fila é curta de propósito:
   * sinalização velha (uma oferta de 10 segundos atrás) é pior do que
   * sinalização nenhuma, porque reabre negociações já superadas.
   */
  send(msg) {
    if (this.connected) {
      this.#socket.send(JSON.stringify(msg));
      return true;
    }
    // Estado de voz e SDP velhos não servem para nada: descartar é melhor do
    // que entregar atrasado.
    if (msg.t === "signal" || msg.t === "audio") return false;
    if (this.#queue.length < 32) this.#queue.push(msg);
    return false;
  }

  close() {
    this.#closedByUs = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    if (this.connected) this.send({ t: "leave" });
    this.#socket?.close(1000, "saiu");
    this.#socket = null;
  }

  /* ------------------------------------------------------------------ */

  #connect() {
    clearTimeout(this.#timer);
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) return;

    let socket;
    try {
      socket = new WebSocket(this.#url);
    } catch (err) {
      this.#scheduleReconnect();
      this.emit("error", { fatal: false, err });
      return;
    }
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      socket.send(JSON.stringify(this.#joinPayload));
      while (this.#queue.length) socket.send(JSON.stringify(this.#queue.shift()));
      this.emit("open");
      this.#schedulePing();
    });

    socket.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Qualquer mensagem prova que o caminho está vivo, não só o pong.
      clearTimeout(this.#pongTimer);
      this.#pongTimer = 0;
      if (m.t === "pong") {
        if (m.n === this.#pingSeq) {
          this.serverRtt = Math.round(performance.now() - this.#pingSentAt);
          // O relógio do servidor é o mesmo para todos na sala; o de cada
          // computador pode estar segundos adiantado ou atrasado.
          if (Number.isFinite(m.at)) this.#diferencaDoServidor = m.at + this.serverRtt / 2 - Date.now();
        }
        return;
      }
      this.emit(m.t, m);
      this.emit("message", m);
    });

    socket.addEventListener("close", (ev) => {
      if (this.#socket !== socket) return;
      clearTimeout(this.#pingTimer);
      clearTimeout(this.#pongTimer);
      this.#socket = null;
      this.emit("close", { code: ev.code, reason: ev.reason });
      if (this.#closedByUs) return;
      /*
       * 1008 é "o servidor recusou", mas nem toda recusa é definitiva. Sala
       * cheia, senha errada e id inválido não adianta insistir; excesso de
       * mensagens, sim — e tratar esse caso como fatal era o que derrubava a
       * pessoa da sala de vez depois de uma rajada de legendas ou de um traço
       * longo no canvas, sem nenhuma tentativa de voltar.
       */
      if (ev.code === 1008 && FATAL.has(ev.reason)) {
        this.emit("error", { fatal: true, reason: ev.reason || "recusado" });
        return;
      }
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // O evento `close` sempre vem em seguida; ele cuida da reconexão.
    });
  }

  #scheduleReconnect() {
    if (this.#closedByUs) return;
    const base = BACKOFF[Math.min(this.#attempt, BACKOFF.length - 1)];
    this.#attempt += 1;
    const delay = clamp(base * (0.5 + Math.random() * 0.5), 300, 20_000);
    this.emit("reconnecting", { attempt: this.#attempt, inMs: Math.round(delay) });
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), delay);
  }

  #schedulePing() {
    const tick = () => {
      if (!this.connected) return;
      this.#pingSeq += 1;
      this.#pingSentAt = performance.now();
      this.send({ t: "ping", n: this.#pingSeq });

      // Arma o alarme. Se nada chegar até lá, o socket está morto mesmo
      // parecendo aberto: fechar à força é o que dispara a reconexão.
      clearTimeout(this.#pongTimer);
      this.#pongTimer = setTimeout(() => {
        if (!this.connected) return;
        this.emit("stale");
        try {
          this.#socket.close(4000, "sem resposta");
        } catch {
          /* já fechando */
        }
      }, PONG_TIMEOUT_MS);

      this.#pingTimer = setTimeout(tick, PING_EVERY_MS);
    };
    clearTimeout(this.#pingTimer);
    this.#pingTimer = setTimeout(tick, 3000);
  }
}
