/**
 * core/stats.js — leitura do getStats e controle adaptativo.
 *
 * Duas coisas acontecem aqui:
 *
 *   1. MEDIÇÃO. A cada ciclo, transformamos o relatório cru do WebRTC em algo
 *      legível: taxa real, quadros por segundo, resolução efetivamente
 *      codificada, latência, perda e congelamentos.
 *
 *   2. ADAPTAÇÃO. Com base nessas medidas, ajustamos o teto de banda da tela e
 *      da câmera. A regra é assimétrica de propósito — desce rápido, sobe
 *      devagar. Subir rápido é o que produz aquele ciclo de travar, recuperar
 *      e travar de novo.
 *
 * Detalhe que muda o diagnóstico: `qualityLimitationReason` só reporta UM
 * motivo por vez, e quando os dois acontecem ele diz "bandwidth". Por isso
 * olhamos a variação de `qualityLimitationDurations`, que é cumulativa e
 * mostra os dois.
 */
import { Emitter } from "../lib/emitter.js";
import { clamp, Ema } from "../lib/util.js";
import { alvoDoSom, codecMelhorQueOSoftware, cpuCeiling, escalaComCalma, escalaPelaBanda, meshBudget, modoDoCodificador, pedeFluidez, PROFILES } from "./tuning.js";

/**
 * O endereço é da rede Tailscale (100.64.0.0/10 ou fd7a:115c:a1e0::/48)?
 * Mesma regra de src/rede.js, que o fixes-test confere contra esta.
 */
export function ehIpTailscale(ip) {
  const s = String(ip || "")
    .trim()
    .replace(/^::ffff:/i, "")
    .replace(/^\[|\]$/g, "");
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(s);
}

const INTERVAL_MS = 2000;
const HISTORY = 30;

// Tela: abaixo de ~600 kbps a sondagem de banda do Chrome (que vai até 2× o
// que está alocado) mal sai do lugar, e a imagem ficava parada por 11–13 s.
const FLOOR = { screen: 600_000, camera: 120_000 };
/** Leituras seguidas sem congestão (2 s cada) antes de devolver o teto. */
const RECUPERA_LEITURAS = 3;
const CEIL = { screen: PROFILES.screenMotion.maxBitrate, camera: PROFILES.camera.maxBitrate };

/** Um snapshot legível por par. */
/**
 * Som da tela menos imagem da tela, em ms (positivo: o som toca depois).
 * O `estimatedPlayoutTimestamp` só existe com a sincronia ativa, ou seja,
 * com os dois no mesmo stream (peer.js).
 */
export function avSync(inbound) {
  const a = inbound.screenAudio?.playoutMs;
  const v = inbound.screen?.playoutMs;
  return a != null && v != null ? Math.round(a - v) : null;
}

/**
 * Tudo o que chegou pela conexão (RTP, RTCP, canais de dados): o vigia de
 * conexão congelada (core/rele.js) olha se isto ainda cresce.
 *
 * Não pode ser o contador de um par só. Com candidato peer-reflexive (NAT,
 * ou o proxy do medidor), o Chrome aponta em `selectedCandidatePairId` um
 * par que fica em 0 byte a chamada inteira, enquanto o tráfego é contado
 * noutro par, "in-progress" ou "waiting" (medido a 10 Mbps: 1,8 MB num, 0 no
 * "em uso"). O vigia via o 0 parado e reiniciava o ICE a cada ~10 s. O
 * transporte DTLS conta tudo; o Firefox não tem esse relatório, e aí vale a
 * soma dos pares.
 */
export function bytesRecebidos(report) {
  let transporte = null;
  let pares = null;
  report.forEach((r) => {
    if (r.type === "transport" && r.bytesReceived != null) transporte = (transporte ?? 0) + r.bytesReceived;
    else if (r.type === "candidate-pair" && r.bytesReceived != null) pares = (pares ?? 0) + r.bytesReceived;
  });
  return transporte ?? pares;
}

function emptySample() {
  return {
    outbound: { screen: null, cam: null, mic: null, screenAudio: null },
    inbound: { screen: null, cam: null, mic: null, screenAudio: null },
    transport: { rtt: null, availableOutgoing: null, availableIncoming: null, localType: null, remoteType: null, bytesReceived: null },
    quality: "unknown",
    score: 0,
  };
}

export class StatsMonitor extends Emitter {
  #timer = 0;
  #prev = new Map(); // peerId -> Map(statId -> report)
  #budget = new Map(); // peerId -> { screen, camera }
  #ema = new Map(); // peerId -> { rtt, loss }
  #history = new Map(); // peerId -> number[] (kbps de saída)

  samples = new Map(); // peerId -> sample

  /**
   * @param {() => Iterable<import("./peer.js").Peer>} getPeers
   * @param {{ adaptive?: boolean }} opts
   */
  constructor(getPeers, { adaptive = true } = {}) {
    super();
    this.getPeers = getPeers;
    this.adaptive = adaptive;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), INTERVAL_MS);
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = 0;
  }

  forget(peerId) {
    this.#prev.delete(peerId);
    for (const k of this.#destravadoEm.keys()) if (k.startsWith(`${peerId}:`)) this.#destravadoEm.delete(k);
    this.#alvoSom.delete(peerId);
    this.#quadrosTela.delete(peerId);
    this.#budget.delete(peerId);
    this.#folga60.delete(peerId);
    this.#lento60.delete(peerId);
    this.#tenta60Em.delete(peerId);
    this.#ema.delete(peerId);
    this.#history.delete(peerId);
    this.#movimento.delete(peerId);
    this.samples.delete(peerId);
  }

  historyFor(peerId) {
    return this.#history.get(peerId) || [];
  }

  /* ---------------------------------------------------------------- */

  async #tick() {
    const peers = [...this.getPeers()];
    if (!peers.length) return;

    const budgets = meshBudget(peers.length, { uplink: this.#uplink() });
    const cpu = cpuCeiling(peers.length, navigator.hardwareConcurrency || 4);

    await Promise.all(peers.map((p) => this.#tickPeer(p, budgets, cpu, peers.length)));
    this.emit("update", this.samples);
  }

  /**
   * Quanto esta máquina consegue ENVIAR, somando todas as conexões.
   *
   * Era aqui que a chamada desmanchava ao compartilhar tela. O orçamento da
   * malha partia de um palpite fixo de 8 Mbps de subida; quem tem 3 Mbps — ou
   * está no 4G, ou num Wi-Fi ruim — recebia um teto três vezes maior do que o
   * enlace aguenta. Cada conexão então enchia a fila do roteador até perder
   * pacote, e o congelamento aparecia em TODO MUNDO ao mesmo tempo, não só em
   * quem transmitia.
   *
   * `availableOutgoingBitrate` é a estimativa do controle de congestionamento
   * de cada conexão. Numa malha elas dividem o mesmo enlace, então a soma
   * aproxima a capacidade real — é o número que o navegador já descobriu na
   * prática, e não um palpite nosso.
   *
   * A suavização é PROPOSITALMENTE assimétrica: cai na hora, sobe devagar.
   * Reagir rápido à piora é o que evita o congelamento; subir devagar é o que
   * evita ficar oscilando entre nítido e borrado a cada segundo.
   *
   * ponytail: estimativa agregada, boa o bastante para dimensionar o teto.
   * Um medidor de verdade (sondagem ativa em banda) só se valer a pena.
   */
  #uplinkEma = 0;

  /** Subida estimada desta máquina, em bps (0 enquanto não há medida). */
  get subida() {
    return this.#uplinkEma;
  }

  #uplink() {
    let total = 0;
    for (const amostra of this.samples.values()) {
      total += amostra?.transport?.availableOutgoing || 0;
    }
    if (!total) return this.#uplinkEma || undefined; // sem medida ainda: o padrão vale

    const teto = clamp(total, 400_000, 25_000_000);
    this.#uplinkEma = this.#uplinkEma
      ? teto < this.#uplinkEma
        ? teto // piorou: acompanha na hora
        : this.#uplinkEma + (teto - this.#uplinkEma) * 0.15 // melhorou: com calma
      : teto;
    return this.#uplinkEma;
  }

  async #tickPeer(peer, budgets, cpu, pares) {
    const report = await peer.getStats();
    if (!report) return;

    const prev = this.#prev.get(peer.id);
    const sample = this.#read(peer, report, prev);
    this.#prev.set(peer.id, report);
    this.samples.set(peer.id, sample);

    const hist = this.#history.get(peer.id) || [];
    const outKbps = Math.round(
      ((sample.outbound.screen?.bitrate || 0) + (sample.outbound.cam?.bitrate || 0)) / 1000,
    );
    hist.push(outKbps);
    if (hist.length > HISTORY) hist.shift();
    this.#history.set(peer.id, hist);

    this.#sincronizar(peer, sample);
    await this.#destravar(peer, sample);
    if (this.adaptive) await this.#adapt(peer, sample, budgets, cpu, pares);
    if (this.adaptive) await this.#camera60(peer, sample, pares);
  }

  /* ---------------------------------------------------------------- *
   * Câmera a 60 qps, só quando sobra banda
   * ---------------------------------------------------------------- */

  /**
   * A câmera sai a 30 qps (tuning.PROFILES.camera): com a banda de uma
   * internet comum, 60 qps só dividem os bits e borram a imagem. Sobe para
   * 60 numa chamada a dois, sem tela compartilhada, com câmera que entrega
   * 60, e quando o encoder já está no teto de 30 com a conexão sobrando
   * (estimativa de envio ≥ 3,5 Mbps, perda < 1%) por 3 leituras seguidas.
   * Volta na hora se a estimativa cair abaixo de 2,8 Mbps, a perda passar de
   * 3% ou o processador não der conta (acusado pelo navegador, ou o encoder
   * abaixo de 36 qps por 3 leituras: aí só tenta de novo em 2 min). O
   * Chrome não estima muito acima do que já se envia (~1,5×), por isso o
   * limiar é perto do teto de 30.
   */
  #folga60 = new Map(); // peerId -> leituras seguidas com folga
  #lento60 = new Map(); // peerId -> leituras seguidas com o encoder abaixo de 60% dos 60 qps
  #tenta60Em = new Map(); // peerId -> só tenta 60 de novo depois desta hora

  async #camera60(peer, sample, pares) {
    const out = sample.outbound.cam;
    const track = peer.tx.cam?.sender?.track;
    if (!out || !track || track.readyState !== "live") return;
    // Quanto a câmera captura (getSettings), não o que chega ao encoder: com o
    // teto de 30 o navegador já entrega só 30, e a estatística da fonte diz 30.
    const fonte = track.getSettings?.().frameRate ?? 30;
    const avail = sample.transport.availableOutgoing;
    const perda = sample.lossSmoothed ?? 0;
    const podeHaver = pares === 1 && !peer.tx.screen?.sender?.track && fonte >= 50 && avail != null;
    const cai = !podeHaver || avail < 2_800_000 || perda > 3 || out.cpuShare > 0.3;
    if (cai) {
      this.#folga60.set(peer.id, 0);
      if (peer.camera60) await peer.definirCamera60(false);
      return;
    }
    if (peer.camera60) {
      // Encoder que não acompanha (VP9 por software numa máquina fraca) sem o
      // navegador acusar CPU: volta a 30 e espera 2 min para tentar de novo.
      const lento = out.fps != null && out.fps < 36 ? (this.#lento60.get(peer.id) || 0) + 1 : 0;
      this.#lento60.set(peer.id, lento);
      if (lento >= 3) {
        this.#tenta60Em.set(peer.id, performance.now() + 120_000);
        this.#folga60.set(peer.id, 0);
        await peer.definirCamera60(false);
      }
      return;
    }
    if (performance.now() < (this.#tenta60Em.get(peer.id) || 0)) return;
    const noTeto = (out.targetBitrate ?? 0) >= PROFILES.camera.maxBitrate * 0.85;
    const folga = noTeto && avail >= 3_500_000 && perda < 1 ? (this.#folga60.get(peer.id) || 0) + 1 : 0;
    this.#folga60.set(peer.id, folga);
    if (folga >= 3) await peer.definirCamera60(true);
  }

  /* ---------------------------------------------------------------- *
   * Sincronia do som da tela (com teto; ver alvoDoSom em tuning.js)
   * ---------------------------------------------------------------- */

  #alvoSom = new Map(); // peerId -> ms
  #quadrosTela = new Map(); // peerId -> framesDecoded da leitura anterior

  #sincronizar(peer, sample) {
    const receiver = peer.tx.screenAudio?.receiver;
    const video = sample.inbound.screen;
    if (!receiver || !video || !sample.inbound.screenAudio) return;
    const antes = this.#quadrosTela.get(peer.id);
    this.#quadrosTela.set(peer.id, video.quadros);
    const alvo = this.#alvoSom.get(peer.id) || 0;
    const novo = alvoDoSom({
      videoMs: video.bufferAgoraMs,
      alvo,
      videoParado: antes != null && video.quadros === antes,
    });
    sample.alvoSomMs = novo;
    if (novo === alvo) return;
    this.#alvoSom.set(peer.id, novo);
    try {
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = novo;
      else if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = novo / 1000;
    } catch {
      /* receptor fechando */
    }
  }

  /* ---------------------------------------------------------------- *
   * Encoder preso no começo da chamada
   * ---------------------------------------------------------------- */

  /**
   * A causa da imagem borrada e travando com internet boa.
   *
   * Toda conexão nasce com uma estimativa de banda baixa (~300 kbps). O
   * encoder escolhe a resolução e a cadência com base nela — 480×270 a 10
   * quadros por segundo, por exemplo — e marca a trilha como "limitada por
   * banda". Segundos depois a estimativa sobe e o encoder passa a ter 1,2
   * Mbps à disposição… e continua em 480×270: no Chrome, essa limitação
   * inicial não é revista sozinha (medido: 0 mudanças de resolução em 20 s,
   * com a meta de bitrate cheia). A chamada inteira ficava assim.
   *
   * Reconfigurar o encoder (trocar a preferência de degradação e voltar)
   * desfaz a limitação: medido, 480×270 a 10 qps → 1280×720 a 20 qps em
   * menos de 6 s. Só é feito quando o próprio navegador diz que a banda
   * sobra (meta ≥ 75% do teto e a estimativa de envio acima dela), para não
   * brigar com uma limitação de verdade; e no máximo a cada 15 s por trilha.
   */
  #destravadoEm = new Map(); // `${peer}:${papel}` -> hora
  destravadas = 0;

  async #destravar(peer, sample) {
    for (const papel of ["cam", "screen"]) {
      const out = sample.outbound[papel];
      const sender = peer.tx[papel]?.sender;
      const track = sender?.track;
      if (!out || !track || track.readyState !== "live") continue;
      if (out.bwShare < 0.8 || !out.targetBitrate) continue;
      let enc;
      try {
        enc = sender.getParameters().encodings?.[0];
      } catch {
        continue;
      }
      if (!enc || enc.active === false || !enc.maxBitrate) continue;
      if (out.targetBitrate < enc.maxBitrate * 0.75) continue; // a banda é que falta: não mexe
      const disponivel = sample.transport.availableOutgoing;
      if (disponivel != null && disponivel < out.targetBitrate) continue;
      if ((sample.lossSmoothed ?? 0) > 2) continue;
      const cfg = track.getSettings?.() || {};
      const escala = enc.scaleResolutionDownBy || 1;
      const larguraEsperada = cfg.width ? cfg.width / escala : null;
      const qpsEsperado = Math.min(enc.maxFramerate || 60, cfg.frameRate || 60);
      const encolhida = larguraEsperada && out.width && out.width < larguraEsperada * 0.9;
      // Na tela, pouco quadro por segundo é o normal (tela parada só manda o
      // repetido); ali só a resolução encolhida denuncia o encoder travado.
      const lenta = papel === "cam" && out.fps != null && out.fps < qpsEsperado * 0.6;
      if (!encolhida && !lenta) continue;
      const chave = `${peer.id}:${papel}`;
      const agora = performance.now();
      if (agora - (this.#destravadoEm.get(chave) || 0) < 15_000) continue;
      this.#destravadoEm.set(chave, agora);
      if (await peer.reconfigurarEncoder(papel)) {
        this.destravadas += 1;
        this.emit("destravado", { peerId: peer.id, papel, de: `${out.width}x${out.height}@${out.fps}` });
      }
    }
  }

  /**
   * Teto de altura da Fluidez com encoder por software. O OpenH264 (uma
   * thread) não passava de 36–41 qps em 1080p, e o teto era 720p para todos.
   * O VP9 usa mais threads: num i5 de 12ª geração (12 threads) ele sai em
   * 1080p a 59–60 qps, 9 ms por quadro, e quem assiste ganha ~1 dB de PSNR
   * (medido pela internet de verdade). Máquina com menos de 8 threads fica em
   * 720p; com 8 ou mais tenta 1080p e desce para 720p se a CPU não der conta.
   */
  #tetoSoftware(budget) {
    if (modoDoCodificador() === "leve") return 720; // PC fraco escolheu o VP8 (tuning.MODOS_CODIFICADOR)
    return budget.tetoSoftware ?? ((globalThis.navigator?.hardwareConcurrency || 4) >= 8 ? 1080 : 720);
  }

  /* ---------------------------------------------------------------- *
   * O que a tela pede além do teto: outro codec, outro modo
   * ---------------------------------------------------------------- */

  #trocouCodec = false;
  #movimento = new Map(); // peerId -> leituras seguidas com a imagem andando e o encoder atrás

  /**
   * Duas coisas que o teto de banda não resolve, avisadas a quem cuida da
   * tela (mesh.js):
   *   "codec-da-tela"      o H.264 da Fluidez saiu por software: o VP9 rende
   *                        mais (tuning.codecMelhorQueOSoftware);
   *   "tela-em-movimento"  3 leituras seguidas (6 s) da Nitidez com a imagem
   *                        andando (quadros perdidos ou banda cheia): é vídeo ou jogo, e
   *                        a Fluidez vai melhor (tuning.pedeFluidez).
   */
  #vigiarTela(peer, screen, perfil) {
    let params = null;
    try {
      params = peer.tx.screen.sender.getParameters();
    } catch {
      /* sender fechando */
    }
    // Cópia direta desligada (a tela vai pelo SFU ou pelo relé): ela não diz nada.
    const ligada = params?.encodings?.[0]?.active !== false;
    if (!this.#trocouCodec && ligada) {
      const negociados = (params?.codecs || []).map((c) => c.mimeType);
      const codec = codecMelhorQueOSoftware({ modo: perfil.contentHint, codec: screen.codec, hardware: screen.hardware, negociados });
      if (codec) {
        this.#trocouCodec = true;
        this.emit("codec-da-tela", codec);
      }
    }
    const andando = ligada && perfil.contentHint === "text" && pedeFluidez({ fonteQps: screen.sourceFps, qps: screen.fps, bps: screen.bitrate });
    const n = andando ? (this.#movimento.get(peer.id) || 0) + 1 : 0;
    this.#movimento.set(peer.id, n);
    if (n === 3) this.emit("tela-em-movimento");
  }

  /* ---------------------------------------------------------------- *
   * Leitura
   * ---------------------------------------------------------------- */

  #read(peer, report, prev) {
    const sample = emptySample();
    const byId = new Map();
    report.forEach((r) => byId.set(r.id, r));

    /**
     * Resolve a qual papel (microfone, câmera, tela) um relatório pertence.
     * O `mid` é o caminho certo e estável, mas nem todo navegador o expõe nos
     * relatórios de RTP; nesse caso caímos no identificador da trilha, que
     * sempre está lá.
     */
    const roleOf = (r, direction) => {
      if (r.mid != null) {
        for (const [role, tx] of Object.entries(peer.tx)) {
          if (tx?.mid != null && String(tx.mid) === String(r.mid)) return role;
        }
      }
      const trackId = r.trackIdentifier;
      if (trackId) {
        for (const [role, tx] of Object.entries(peer.tx)) {
          const track = direction === "out" ? tx?.sender?.track : tx?.receiver?.track;
          if (track && track.id === trackId) return role;
        }
      }
      // Último recurso: o tipo de mídia basta para distinguir áudio de vídeo,
      // e entre os dois vídeos a tela é a que tem resolução maior.
      if (r.kind === "audio") return "mic";
      return null;
    };
    const keyOf = (role) => (["screen", "cam", "mic", "screenAudio"].includes(role) ? role : null);

    // O par em uso é o que o transporte aponta. `nominated` sozinho não serve:
    // um par nomeado antes continua "succeeded" depois de uma troca, e era ele
    // que se lia (banda e atraso de um caminho velho). O Firefox não tem o
    // campo e marca `selected`. Os bytes do vigia vêm de bytesRecebidos.
    let parEmUso = null;
    report.forEach((r) => {
      if (r.type === "transport" && r.selectedCandidatePairId) parEmUso = r.selectedCandidatePairId;
    });

    report.forEach((r) => {
      if (r.type === "outbound-rtp") {
        const key = keyOf(roleOf(r, "out"));
        if (!key) return;
        const before = prev?.get(r.id);
        sample.outbound[key] = this.#outbound(r, before, byId);
      } else if (r.type === "inbound-rtp") {
        const key = keyOf(roleOf(r, "in"));
        if (!key) return;
        const before = prev?.get(r.id);
        sample.inbound[key] = this.#inbound(r, before);
      } else if (r.type === "candidate-pair" && (parEmUso ? r.id === parEmUso : (r.nominated || r.selected) && r.state === "succeeded")) {
        sample.transport.rtt = r.currentRoundTripTime != null ? r.currentRoundTripTime * 1000 : null;
        sample.transport.availableOutgoing = r.availableOutgoingBitrate ?? null;
        sample.transport.availableIncoming = r.availableIncomingBitrate ?? null;
        const local = byId.get(r.localCandidateId);
        const remoto = byId.get(r.remoteCandidateId);
        sample.transport.localType = local?.candidateType ?? null;
        sample.transport.remoteType = remoto?.candidateType ?? null;
        // A rede Tailscale aparece como uma placa de rede a mais: o par
        // escolhido usa os endereços 100.x dela. (O do outro lado pode vir
        // escondido como nome .local; basta um dos dois.)
        sample.transport.tailscale = ehIpTailscale(local?.address ?? local?.ip) || ehIpTailscale(remoto?.address ?? remoto?.ip);
      }
    });

    sample.transport.bytesReceived = bytesRecebidos(report);

    const ema = this.#ema.get(peer.id) || { rtt: new Ema(0.35), loss: new Ema(0.35) };
    this.#ema.set(peer.id, ema);
    if (sample.transport.rtt != null) ema.rtt.push(sample.transport.rtt);
    const loss = Math.max(
      sample.outbound.screen?.lossPct ?? 0,
      sample.outbound.cam?.lossPct ?? 0,
      sample.inbound.screen?.lossPct ?? 0,
      sample.inbound.cam?.lossPct ?? 0,
    );
    ema.loss.push(loss);

    const { quality, score } = gradeConnection({
      rtt: ema.rtt.value,
      lossPct: ema.loss.value,
      limited:
        sample.outbound.screen?.limitedBy || sample.outbound.cam?.limitedBy || "none",
      state: peer.connectionState,
      freezes: sample.inbound.screen?.freezeRatio ?? sample.inbound.cam?.freezeRatio ?? 0,
    });
    sample.quality = quality;
    sample.score = score;
    sample.rttSmoothed = ema.rtt.value;
    sample.lossSmoothed = ema.loss.value;
    sample.relay = sample.transport.localType === "relay" || sample.transport.remoteType === "relay";
    sample.tailscale = !sample.relay && !!sample.transport.tailscale;
    sample.avSyncMs = avSync(sample.inbound);

    return sample;
  }

  #outbound(r, before, byId) {
    const dt = before ? (r.timestamp - before.timestamp) / 1000 : 0;
    const bitrate = dt > 0 ? ((r.bytesSent - before.bytesSent) * 8) / dt : 0;

    const durations = r.qualityLimitationDurations || {};
    const beforeDur = before?.qualityLimitationDurations || {};
    const share = (k) => (dt > 0 ? ((durations[k] || 0) - (beforeDur[k] || 0)) / dt : 0);

    // O relatório remoto conta a perda que o OUTRO lado viu na nossa trilha.
    let lossPct = null;
    if (r.remoteId) {
      const rem = byId.get(r.remoteId);
      if (rem?.fractionLost != null) lossPct = rem.fractionLost * 100;
    }

    const encodeMs =
      before && r.framesEncoded > before.framesEncoded
        ? ((r.totalEncodeTime - before.totalEncodeTime) /
            (r.framesEncoded - before.framesEncoded)) *
          1000
        : null;

    return {
      bitrate,
      fps: r.framesPerSecond ?? null,
      // Quantos quadros a captura entrega: tela parada manda poucos, e aí
      // poucos quadros codificados não é problema.
      sourceFps: byId.get(r.mediaSourceId)?.framesPerSecond ?? null,
      sourceHeight: byId.get(r.mediaSourceId)?.height ?? null,
      // false: o encoder em uso é por software (sem placa de vídeo para o codec).
      hardware: r.powerEfficientEncoder ?? null,
      width: r.frameWidth ?? null,
      height: r.frameHeight ?? null,
      limitedBy: r.qualityLimitationReason || "none",
      cpuShare: share("cpu"),
      bwShare: share("bandwidth"),
      resolutionChanges: r.qualityLimitationResolutionChanges ?? 0,
      targetBitrate: r.targetBitrate ?? null,
      encodeMs,
      lossPct,
      codec: byId.get(r.codecId)?.mimeType?.replace("video/", "").replace("audio/", "") ?? null,
      bytes: r.bytesSent ?? 0,
    };
  }

  #inbound(r, before) {
    const dt = before ? (r.timestamp - before.timestamp) / 1000 : 0;
    const bitrate = dt > 0 ? ((r.bytesReceived - before.bytesReceived) * 8) / dt : 0;

    let lossPct = null;
    if (before) {
      const dLost = (r.packetsLost || 0) - (before.packetsLost || 0);
      const dRecv = (r.packetsReceived || 0) - (before.packetsReceived || 0);
      const total = dLost + dRecv;
      if (total > 0) lossPct = clamp((dLost / total) * 100, 0, 100);
    }

    const freezeDelta = before
      ? (r.totalFreezesDuration || 0) - (before.totalFreezesDuration || 0)
      : 0;

    return {
      bitrate,
      fps: r.framesPerSecond ?? null,
      width: r.frameWidth ?? null,
      height: r.frameHeight ?? null,
      jitter: r.jitter != null ? r.jitter * 1000 : null,
      lossPct,
      freezeCount: r.freezeCount ?? 0,
      freezeRatio: dt > 0 ? clamp(freezeDelta / dt, 0, 1) : 0,
      jitterBufferMs:
        r.jitterBufferEmittedCount > 0
          ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000
          : null,
      playoutMs: r.estimatedPlayoutTimestamp ?? null,
      // Tempo no buffer só desde a última leitura (o acumulado mal se mexe).
      bufferAgoraMs:
        before && r.jitterBufferEmittedCount > before.jitterBufferEmittedCount
          ? ((r.jitterBufferDelay - before.jitterBufferDelay) / (r.jitterBufferEmittedCount - before.jitterBufferEmittedCount)) * 1000
          : null,
      quadros: r.framesDecoded ?? null,
      bytes: r.bytesReceived ?? 0,
    };
  }

  /* ---------------------------------------------------------------- *
   * Adaptação
   * ---------------------------------------------------------------- */

  async #adapt(peer, sample, budgets, cpu, pares) {
    const screen = sample.outbound.screen;
    const hasScreen = !!peer.tx.screen?.sender?.track;
    if (!hasScreen || !screen) return;

    let budget = this.#budget.get(peer.id);
    if (!budget) {
      budget = { screen: budgets.screen, camera: budgets.camera };
      this.#budget.set(peer.id, budget);
    }
    // Cada compartilhamento começa do zero: a subida inicial de
    // tuning.escalaComCalma e o teto de resolução por software.
    const trilha = peer.tx.screen.sender.track.id;
    if (budget.trilha !== trilha) {
      budget.trilha = trilha;
      budget.escala = undefined;
      budget.inicio = undefined;
      budget.apertou = false;
      budget.folgaDesde = 0;
      budget.tetoSoftware = undefined;
      budget.tentar1080Em = undefined;
      budget.esperaSoftware = undefined;
      budget.cpuEscala = 1;
      budget.calmoCpu = 0;
    }

    const avail = sample.transport.availableOutgoing;
    const before = budget.screen;
    const fpsAntes = budget.framerate;
    /*
     * Texto fica em 60 mesmo a dois; vídeo e jogo vão até 120, mas só quando
     * sobra bit para cada quadro. No começo da chamada a conexão ainda está em
     * 2–6 Mbps, e 1080p120 ali congelou a imagem por quase 2 s (a 60, nada;
     * medido). Sobe a partir de ~8 Mbps em 1080p (√2 do que 1080p60 pede) e
     * volta abaixo de ~6 Mbps; a distância entre os dois evita o vaivém.
     */
    const perfil = peer.screenProfile || {};
    const { width = 1920, height = 1080 } = peer.tx.screen.sender.track.getSettings?.() || {};
    // Bits por pixel do que SAI (a captura pode ser de 1440p e o encoder
    // mandar 1080p): medido pela captura, 120 qps nunca passava numa janela grande.
    const porPixel = (screen.targetBitrate ?? 0) / ((screen.width && screen.height ? screen.width * screen.height : 0) || width * height);
    // Monitor de 60 Hz: a captura não passa de 60, e cada degrau do teto até
    // 120 só reconfigurava o encoder (um congelamento no caminho, medido).
    const fonteRapida = (screen.sourceFps ?? 0) > 66;
    // 120 qps só com o encoder na placa: por software nem 1080p60 sobra (stats #tetoSoftware).
    budget.rapido = fonteRapida && screen.hardware !== false && porPixel >= (budget.rapido ? 2.9 : 3.9);
    const tetoPerfil = (budget.rapido && perfil.maxFramerateComBanda) || perfil.maxFramerate || cpu.maxFramerate;
    const tetoFps = Math.min(cpu.maxFramerate, tetoPerfil);
    budget.framerate ??= tetoFps;
    this.#vigiarTela(peer, screen, perfil);

    /*
     * Encoder que não dá conta sem dizer: o de hardware só acusa CPU acima de
     * 150–200% de uso, e com três cópias de 1080p60 na mesma placa ele
     * entregava 5 qps com o motivo "none" (medido). Se a captura manda
     * quadros e o encoder não acompanha nem 60% deles, é o mesmo caso da CPU.
     */
    const alvo = Math.min(screen.sourceFps ?? 0, budget.framerate);
    const atrasado = screen.limitedBy === "none" && alvo > 20 && screen.fps != null && screen.fps < alvo * 0.6;

    // O H.264 por software está de saída (codec-da-tela): a CPU dele não conta.
    const trocandoCodec = this.#trocouCodec && /h264/i.test(screen.codec || "");
    const movimento = perfil.contentHint === "motion";
    const desceResolucao = movimento && screen.hardware === false && this.#tetoSoftware(budget) > 720;
    // Por software o encoder fica para trás sem acusar CPU (OpenH264 em 1080p: 40 de 60).
    const ficaParaTras = alvo > 20 && screen.fps != null && screen.fps < alvo * 0.85;
    /*
     * "cpu" no qualityLimitationReason continua valendo ENQUANTO o próprio
     * Chrome segura a imagem por causa da CPU, mesmo depois de ela folgar.
     * Contar isso como aperto, e cortar quadros e banda a cada 2 s, levou a
     * tela de um jogo de 60 qps e 14 Mbps a 15 qps e 600 kbps com 14 Mbps
     * livres, e ela não voltou mais (medido pela internet de verdade, com a
     * máquina de quem transmite ocupada). Só é aperto se o encoder também
     * entrega menos quadros do que deve.
     */
    const cpuApertada = (screen.cpuShare > 0.3 && ficaParaTras) || atrasado;

    if (cpuApertada && trocandoCodec) {
      /* espera o VP9 entrar */
    } else if ((cpuApertada || ficaParaTras) && desceResolucao) {
      // Fluidez por software sem fôlego para 1080p: o primeiro degrau é a
      // resolução (720p), não os quadros — é o que o "maintain-framerate" pede.
      budget.tetoSoftware = 720;
      budget.calmoCpu = 0;
      // Tenta 1080p de novo depois de um tempo calmo; se cair de novo, espera o dobro.
      budget.tentar1080Em = performance.now() + (budget.esperaSoftware = Math.min(240_000, (budget.esperaSoftware || 15_000) * 2));
      this.emit("limited", { peerId: peer.id, reason: "cpu" });
    } else if (cpuApertada && movimento) {
      // Fluidez: com a CPU apertada quem encolhe a imagem é o próprio Chrome
      // ("maintain-framerate"); cortar quadros aqui seria o contrário do modo.
      // Só o encoder que atrasa sem acusar (o de hardware) encolhe por aqui.
      budget.calmoCpu = 0;
      if (atrasado) budget.cpuEscala = Math.min(2, (budget.cpuEscala || 1) * 1.25);
      this.emit("limited", { peerId: peer.id, reason: "cpu" });
    } else if (cpuApertada) {
      // Nitidez: derrubar quadros preserva a letra. Um degrau por vez (60, 45,
      // 34, 25…), a partir do que a captura dá. A banda fica: menos bits não
      // aliviam a CPU, só borram a imagem.
      budget.calmoCpu = 0;
      budget.framerate = Math.max(15, Math.round((alvo || budget.framerate) * 0.75));
      this.emit("limited", { peerId: peer.id, reason: "cpu" });
    } else {
      /*
       * "bandwidth" no qualityLimitationReason não quer dizer rede cheia: o
       * Chrome dá esse mesmo motivo quando o próprio encoder encolhe a imagem
       * por qualidade (QP alto, comum em jogo e vídeo). Cortar o teto aí
       * piorava o que já estava ruim, a cada 2 s, até o piso — medido: a tela
       * de um jogo foi a 7 qps e 500 kbps com a rede sobrando. Só conta como
       * rede cheia se a estimativa da conexão não cobre o teto, e só com mais
       * gente: numa conexão só, o controle de congestionamento dela já manda.
       */
      const semBanda = pares > 1 && screen.bwShare > 0.3 && avail != null && avail < budget.screen;
      /*
       * Perda: a da própria tela, que tem pacotes de sobra para o número
       * valer, e não a maior entre as quatro linhas. Na câmera e no microfone
       * 1 pacote em 20 já dá 5%, e o corte de 25% a cada 2 s levava a tela ao
       * piso de 450 kbps com 1% de perda real (medido). A dois, quem responde
       * à perda é o controle de congestionamento da própria conexão.
       */
      const perdendo = pares > 1 && (screen.lossPct ?? 0) > 5;
      if (semBanda || perdendo) {
        budget.calmo = 0;
        budget.screen = Math.max(
          FLOOR.screen,
          Math.min(budget.screen * 0.75, (avail || budget.screen) * 0.9),
        );
        this.emit("limited", { peerId: peer.id, reason: "bandwidth" });
      } else if (pares === 1) {
        // A dois quem segura o enlace é o controle da própria conexão; a
        // estimativa dela não passa muito do que já se envia, então esperar
        // por ela para subir deixaria o teto baixo para sempre.
        budget.screen = Math.min(CEIL.screen, budgets.screen, budget.screen * 1.25);
      } else if ((budget.calmo = (budget.calmo || 0) + 1) >= RECUPERA_LEITURAS) {
        // Passou a congestão: volta de uma vez à parte da subida. Subir 15% por
        // leitura prendia a conexão: o Chrome só sonda até 2× o teto alocado,
        // e cada degrau pequeno liberava uma sondagem pequena (medido: 11–13 s
        // de imagem parada depois de uma troca de cena).
        budget.screen = Math.min(CEIL.screen, budgets.screen);
      }
      // A CPU folgou e o encoder acompanha o teto atual: depois de 2 leituras
      // calmas (4 s), os quadros voltam 50% por leitura (de 15 a 60 em ~8 s;
      // antes, +20% e ~16 s) e a imagem encolhida pela CPU volta um degrau.
      budget.calmoCpu = (budget.calmoCpu || 0) + 1;
      const acompanha = screen.fps == null || alvo <= 20 || screen.fps >= alvo * 0.85;
      if (acompanha && budget.calmoCpu >= 2) budget.framerate = Math.round(budget.framerate * 1.5);
      const folgado = screen.fps == null || alvo <= 20 || screen.fps >= alvo * 0.95;
      if (budget.cpuEscala > 1 && folgado && budget.calmoCpu >= 2) budget.cpuEscala = Math.max(1, budget.cpuEscala / 1.25);
      // O jogo aliviou a CPU: o 1080p por software tem outra chance.
      if (budget.tetoSoftware === 720 && folgado && !ficaParaTras && performance.now() >= (budget.tentar1080Em ?? Infinity)) budget.tetoSoftware = undefined;
    }

    budget.framerate = Math.min(tetoFps, budget.framerate);
    budget.screen = clamp(budget.screen, FLOOR.screen, Math.min(CEIL.screen, budgets.screen));
    // Vídeo e jogo encolhem com a banda, para os quadros não caírem (tuning.js).
    const qps = Math.min(budget.framerate, Math.max(30, screen.sourceFps ?? budget.framerate));
    // A leitura em que o codec acabou de trocar traz a meta do encoder
    // recém-criado, que não diz nada da banda.
    const codecTrocou = budget.codec != null && budget.codec !== screen.codec;
    budget.codec = screen.codec;
    const escalaAntes = budget.escala ?? 1;
    budget.escala =
      perfil.contentHint !== "motion"
        ? 1
        : codecTrocou
          ? escalaAntes
          : escalaComCalma(escalaPelaBanda(screen.targetBitrate, width * height, qps, escalaAntes), escalaAntes, budget, performance.now());
    /*
     * Na Fluidez a captura vem no tamanho da janela (screen.js), e o teto de
     * resolução fica aqui: o da qualidade escolhida e, com encoder por
     * software (a máquina não codifica o codec na placa, ou o de hardware
     * caiu no meio da chamada), o de #tetoSoftware.
     */
    const alturaFonte = screen.sourceHeight || height;
    const tetoAltura = perfil.contentHint === "motion" ? Math.min(perfil.alturaMax ?? 1080, screen.hardware === false ? this.#tetoSoftware(budget) : Infinity) : Infinity;
    const escala = Math.max(cpu.scaleResolutionDownBy, budget.escala, alturaFonte / tetoAltura, budget.cpuEscala || 1);

    // Também quando o sender diverge do orçamento: cada renegociação ou troca
    // de trilha reaplica o perfil cheio (peer.retune) por cima do ajuste.
    let atual = null;
    try {
      atual = peer.tx.screen.sender.getParameters().encodings?.[0];
    } catch {
      /* sender fechando */
    }
    const divergiu =
      !atual ||
      atual.maxFramerate !== budget.framerate ||
      atual.maxBitrate !== Math.round(Math.min(budget.screen, peer.screenProfile?.maxBitrate ?? Infinity)) ||
      (atual.scaleResolutionDownBy ?? 1) !== escala;
    if (Math.abs(budget.screen - before) / Math.max(1, before) > 0.05 || budget.framerate !== fpsAntes || budget.escala !== escalaAntes || divergiu) {
      await peer.setScreenBudget({
        maxBitrate: budget.screen,
        maxFramerate: budget.framerate ?? cpu.maxFramerate,
        scaleResolutionDownBy: escala,
        profile: peer.screenProfile,
      });
    }

    // A câmera cede espaço para a tela quando as duas estão ligadas.
    if (peer.tx.cam?.sender?.track) {
      const camTarget = clamp(budgets.camera, FLOOR.camera, CEIL.camera);
      if (camTarget !== budget.camera) {
        budget.camera = camTarget;
        await peer.setCameraBudget({ maxBitrate: camTarget, maxFramerate: cpu.maxFramerate });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Nota de qualidade
 * ------------------------------------------------------------------ */

/**
 * Converte as métricas em uma nota de 0 a 4 e um rótulo. Serve para as
 * barrinhas de sinal em cada participante — e para avisar antes de a chamada
 * ficar ruim, não depois.
 */
export function gradeConnection({ rtt, lossPct, limited, state, freezes }) {
  if (state === "failed" || state === "closed") return { quality: "poor", score: 0 };
  if (state !== "connected") return { quality: "unknown", score: 0 };
  if (rtt == null && lossPct == null) return { quality: "unknown", score: 0 };

  let score = 4;
  const r = rtt ?? 0;
  const l = lossPct ?? 0;

  if (r > 500) score -= 3;
  else if (r > 300) score -= 2;
  else if (r > 150) score -= 1;

  if (l > 8) score -= 3;
  else if (l > 4) score -= 2;
  else if (l > 1.5) score -= 1;

  if ((freezes ?? 0) > 0.15) score -= 1;
  if (limited === "bandwidth") score -= 1;
  else if (limited === "cpu") score -= 0.5;

  score = clamp(Math.round(score), 0, 4);
  const quality = score >= 3 ? "good" : score >= 2 ? "fair" : "poor";
  return { quality, score };
}

export const QUALITY_ICON = {
  good: "network-4",
  fair: "network-2",
  poor: "network-1",
  unknown: "network-0",
};

export const QUALITY_LABEL = {
  good: "Conexão boa",
  fair: "Conexão instável",
  poor: "Conexão ruim",
  unknown: "Medindo a conexão",
};
