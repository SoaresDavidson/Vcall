/**
 * core/tuning.js — ajuste fino do encoder.
 *
 * É aqui que se decide se o compartilhamento de tela vai ficar legível ou
 * virar um borrão. Três alavancas importam, e a ordem importa:
 *
 *   1. contentHint  — diz ao encoder o que é a imagem. Para tela com texto,
 *                     "text" liga as ferramentas de conteúdo sintético e já
 *                     implica degradationPreference "maintain-resolution".
 *   2. degradationPreference — o que sacrificar quando a banda aperta.
 *                     Para texto: mantenha a resolução, derrube quadros.
 *                     Para vídeo em movimento: o inverso.
 *   3. maxBitrate / priority — quanto de banda esta trilha pode reivindicar.
 *                     Numa chamada com câmera + tela, a tela precisa ganhar,
 *                     senão o alocador reparte igual e a tela some.
 *
 * Duas armadilhas conhecidas estão tratadas aqui:
 *   - `degradationPreference` fica no topo de RTCRtpSendParameters, não dentro
 *     de encodings[0]. Colocado no lugar errado, é silenciosamente ignorado.
 *   - setCodecPreferences exige capacidades de RTCRtpReceiver (não Sender)
 *     desde o Chrome 124, e a lista precisa continuar contendo rtx/red, senão
 *     a retransmissão morre e o vídeo congela na primeira perda de pacote.
 */

/* ------------------------------------------------------------------ *
 * Perfis
 * ------------------------------------------------------------------ */

/*
 * Vídeo e jogo vão até 120 qps, o máximo que o Chromium captura da tela
 * (kMaxScreenCastFrameRate); texto e câmera param em 60, onde mais quadros só
 * tirariam bits de cada um. Os tetos abaixo valem para uma pessoa só do outro
 * lado; com mais gente, cameraParaSala, meshBudget e cpuCeiling descem degrau
 * por degrau (cada um codifica uma cópia por par).
 */
export const PROFILES = {
  /**
   * Câmera: rosto em movimento, resolução é negociável.
   *
   * 30 qps, como o Meet e o Zoom. Com a mesma banda, 60 qps dão metade dos
   * bits a cada quadro: medido (scripts/bench-video.mjs, câmera a 60 qps,
   * VP9), 720p a 30 deu 38,1 dB de PSNR na internet de casa contra 36,3 a 60,
   * e na 4G 37,1 contra 33,6 — a 60 a imagem ainda caía para 535p. Quem sobe
   * para 60 é o StatsMonitor, numa chamada a dois e com banda sobrando
   * (`maxFramerateComBanda`, até `maxBitrateComBanda`).
   *
   * "balanced" ficou: o "maintain-framerate" congelou mais na 4G (3,7 s
   * contra 2,5 s) e na internet ruim (21 s contra 15 s).
   */
  camera: {
    contentHint: "motion",
    degradationPreference: "balanced",
    maxBitrate: 2_500_000,
    maxFramerate: 30,
    maxFramerateComBanda: 60,
    maxBitrateComBanda: 4_000_000,
    priority: "low",
    networkPriority: "low",
  },
  /** Tela com texto/código/slides: legibilidade acima de fluidez. */
  screenText: {
    contentHint: "text",
    degradationPreference: "maintain-resolution",
    maxBitrate: 6_000_000,
    maxFramerate: 60,
    priority: "high",
    networkPriority: "high",
  },
  /**
   * Tela com vídeo, jogo ou animação: fluidez acima de nitidez. 1080p60 em
   * movimento pede ~10 Mbps; 120 qps pedem √2 disso (a regra do Moonlight),
   * não o dobro: quadros vizinhos ficam mais parecidos. Num monitor de 60 Hz
   * a captura não repete quadro, então o teto de 120 não custa nada (medido).
   * Começa em 60: quem sobe para `maxFramerateComBanda` é o controle
   * adaptativo, quando a conexão já tem banda para isso (StatsMonitor).
   */
  screenMotion: {
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
    maxBitrate: 14_000_000,
    maxFramerate: 60,
    maxFramerateComBanda: 120,
    priority: "high",
    networkPriority: "high",
  },
  /** Voz. */
  mic: {
    maxBitrate: 40_000,
    priority: "high",
    networkPriority: "high",
  },
  /** Áudio capturado da tela (música, vídeo): estéreo, sem processamento. */
  screenAudio: {
    maxBitrate: 128_000,
    priority: "medium",
    networkPriority: "medium",
  },
};

/* ------------------------------------------------------------------ *
 * Codecs
 * ------------------------------------------------------------------ */

const codecCache = new Map();

/**
 * Lista de codecs de vídeo disponíveis para *receber*. É essa lista que o
 * setCodecPreferences aceita a partir do Chrome 124.
 */
function videoCapabilities() {
  if (!codecCache.has("video")) {
    let caps = null;
    try {
      caps = RTCRtpReceiver.getCapabilities?.("video") || null;
    } catch {
      caps = null;
    }
    codecCache.set("video", caps);
  }
  return codecCache.get("video");
}

export function supportsCodec(mime) {
  const caps = videoCapabilities();
  if (!caps) return false;
  return caps.codecs.some((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
}

/**
 * Reordena os codecs do transceiver colocando os preferidos na frente.
 * Os demais continuam na lista — inclusive rtx e red, cuja remoção é uma
 * causa clássica de "congela e volta" em rede com perda.
 */
export function preferCodecs(transceiver, mimes) {
  if (typeof transceiver?.setCodecPreferences !== "function") return null;
  const caps = videoCapabilities();
  if (!caps) return null;

  const wanted = [];
  for (const mime of mimes) {
    for (const c of caps.codecs) {
      if (c.mimeType.toLowerCase() !== mime.toLowerCase()) continue;
      // VP9: o perfil 0 (8 bits, 4:2:0) é o rápido e universal. O perfil 2
      // (10 bits) costuma aparecer na lista e custa caro sem ganho aqui.
      if (/vp9/i.test(mime) && c.sdpFmtpLine && !/profile-id=0/.test(c.sdpFmtpLine)) continue;
      wanted.push(c);
    }
  }
  if (!wanted.length) return null;

  const rest = caps.codecs.filter((c) => !wanted.includes(c));
  try {
    transceiver.setCodecPreferences([...wanted, ...rest]);
    return wanted[0].mimeType;
  } catch (err) {
    console.warn("[tuning] setCodecPreferences recusado", err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Voz
 * ------------------------------------------------------------------ */

/**
 * Redundância de áudio (RED, RFC 2198) na linha do microfone.
 *
 * Cada pacote leva junto uma cópia do quadro anterior. Um pacote perdido na
 * rede é reconstruído pelo seguinte, sem esperar reenvio — é o que segura a
 * voz inteira em Wi-Fi ruim e 4G, e é o que o Meet usa. Custa o dobro de uma
 * banda que já é pequena (voz é ~40 kbps), e só enquanto a pessoa fala: com
 * DTX ligado, quem está calado não manda quase nada.
 *
 * Opus continua na lista logo atrás: quem não fala RED negocia Opus puro.
 */
export function preferRed(transceiver) {
  if (typeof transceiver?.setCodecPreferences !== "function") return false;
  let caps = null;
  try {
    caps = RTCRtpReceiver.getCapabilities?.("audio") || null;
  } catch {
    caps = null;
  }
  if (!caps) return false;
  const red = caps.codecs.filter((c) => /^audio\/red$/i.test(c.mimeType));
  const opus = caps.codecs.filter((c) => /^audio\/opus$/i.test(c.mimeType));
  if (!red.length || !opus.length) return false;
  const rest = caps.codecs.filter((c) => !red.includes(c) && !opus.includes(c));
  try {
    transceiver.setCodecPreferences([...red, ...opus, ...rest]);
    return true;
  } catch (err) {
    console.debug("[tuning] RED recusado", err?.name || err);
    return false;
  }
}

/**
 * O que cada linha de áudio pede ao Opus de quem envia para nós.
 *
 * Os parâmetros do `a=fmtp` do Opus dizem como a outra ponta deve codificar
 * o que manda para cá. Por isso são escritos na descrição REMOTA, antes do
 * setRemoteDescription: é ela que configura o nosso encoder.
 *
 *   microfone    FEC dentro do próprio Opus (perda isolada some sem ninguém
 *                notar) e DTX (silêncio vira um pacote a cada 400 ms em vez
 *                de 50 por segundo). Numa sala cheia quase todos estão calados
 *                — com DTX, cada pessoa a mais custa quase nada de banda.
 *   tela         música e vídeo: estéreo de verdade (o padrão do navegador é
 *                mono) e taxa alta. Sem DTX, que corta o fim das notas.
 */
export const OPUS_POR_PAPEL = {
  mic: { useinbandfec: 1, usedtx: 1, stereo: 0 },
  screenAudio: { useinbandfec: 1, usedtx: 0, stereo: 1, "sprop-stereo": 1, maxaveragebitrate: 128000 },
};

/**
 * Reescreve os `a=fmtp` do Opus de uma descrição SDP, seção por seção,
 * conforme o papel de cada linha (`papelDoMid`: mid -> papel). Linhas sem
 * papel conhecido ficam como vieram.
 */
export function ajustarOpus(sdp, papelDoMid) {
  if (typeof sdp !== "string" || !sdp.includes("opus/48000")) return sdp;
  const fim = sdp.includes("\r\n") ? "\r\n" : "\n";
  const [cabeca, ...secoes] = sdp.split(`${fim}m=`);
  const novas = secoes.map((s) => {
    const mid = /(?:^|\n)a=mid:(\S+)/.exec(s)?.[1];
    const pedir = OPUS_POR_PAPEL[papelDoMid(mid)];
    const pt = /(?:^|\n)a=rtpmap:(\d+) opus\/48000/i.exec(s)?.[1];
    if (!pedir || !pt) return s;
    const linhas = s.split(fim);
    const i = linhas.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    const params = new Map();
    if (i >= 0) {
      for (const par of linhas[i].slice(`a=fmtp:${pt} `.length).split(";")) {
        const [k, v] = par.split("=");
        if (k?.trim()) params.set(k.trim(), (v ?? "").trim());
      }
    }
    for (const [k, v] of Object.entries(pedir)) params.set(k, String(v));
    const linha = `a=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(";")}`;
    if (i >= 0) linhas[i] = linha;
    else {
      const r = linhas.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      linhas.splice(r + 1, 0, linha);
    }
    return linhas.join(fim);
  });
  return [cabeca, ...novas].join(`${fim}m=`);
}

/**
 * Banda com que a conexão começa, em kbps (`x-google-start-bitrate`).
 *
 * Sem isto o Chrome começa estimando 300 kbps. O encoder da câmera nasce em
 * 320×180 a 10 qps e fica lá até a estimativa subir e o #destravar
 * (stats.js) agir: medido, os primeiros 8 a 10 s de toda chamada eram assim,
 * e a tela levava 16 s para chegar à taxa cheia. Começando em 1,5 Mbps a
 * câmera já nasce em 720p. Se o enlace for menor, o controle de
 * congestionamento corrige em menos de um segundo.
 *
 * Como o Opus em ajustarOpus: vai na descrição REMOTA, que é a que configura
 * o nosso envio. Parâmetro só do Chrome; os outros ignoram.
 */
const INICIO_KBPS = 1500;

export function ajustarInicioVideo(sdp, kbps = INICIO_KBPS) {
  if (typeof sdp !== "string" || !/\r?\nm=video /.test(sdp)) return sdp;
  const fim = sdp.includes("\r\n") ? "\r\n" : "\n";
  const [cabeca, ...secoes] = sdp.split(`${fim}m=`);
  const novas = secoes.map((s) => {
    if (!s.startsWith("video ")) return s;
    const linhas = s.split(fim);
    const codecs = [];
    for (const l of linhas) {
      const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(l);
      if (m) codecs.push(m[1]);
    }
    for (const pt of codecs) {
      const i = linhas.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
      if (i >= 0) {
        if (!linhas[i].includes("x-google-start-bitrate")) linhas[i] += `;x-google-start-bitrate=${kbps}`;
      } else {
        const r = linhas.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
        linhas.splice(r + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${kbps}`);
      }
    }
    return linhas.join(fim);
  });
  return [cabeca, ...novas].join(`${fim}m=`);
}

/**
 * Ordem de preferência para conteúdo de tela.
 * VP9 vence por larga margem em texto — o mesmo quadro custa cerca de metade
 * da banda de VP8/H264 a 1080p. AV1 ficou de fora de propósito: sem
 * aceleração de hardware (a regra no Linux), o encoder por software a 1080p
 * satura a CPU de máquinas modestas, os quadros atrasam, a trilha recebida
 * silencia e a tela "cai e volta" do outro lado.
 */
export function screenCodecPreference(_peerCount) {
  const list = [];
  if (supportsCodec("video/VP9")) list.push("video/VP9");
  list.push("video/VP8");
  return list;
}

/**
 * O codec que a tela usa NESTA máquina, escolhido na hora de compartilhar.
 *
 * Todos os codecs continuam negociados na linha (preferCodecs não tira
 * nenhum); quem escolhe qual sai é `encodings[0].codec`, trocado com
 * setParameters, sem renegociar. Cada um escolhe o seu: quem tem AV1 por
 * hardware manda AV1, quem não tem manda o que a sua placa codifica.
 *
 * 1080p a 60 qps por software, uma cópia por pessoa, não cabe na CPU de
 * quase ninguém. Por isso a ordem é: AV1 por hardware (o mais nítido por
 * bit, com ferramentas de conteúdo de tela), VP9 por hardware, e sem nenhum
 * dos dois, H.264 para vídeo e jogo (toda placa de vídeo tem codificador
 * H.264) e VP9 por software para texto (tela parada custa pouco e o VP9 é
 * muito mais nítido em letra que o H.264).
 *
 * O `powerEfficient` do encodingInfo é confiável para AV1 e VP9, mas não
 * para H.264 (no Chrome do Windows ele diz "não" com o Quick Sync em uso);
 * por isso o H.264 entra pela regra, não pela pergunta.
 */
const hardware = new Map(); // mime -> Promise<boolean>; a placa não muda no meio da sessão

function porHardware(mime) {
  if (!hardware.has(mime)) {
    hardware.set(
      mime,
      (async () => {
        if (!supportsCodec(mime)) return false;
        try {
          const r = await navigator.mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType: mime, width: 1920, height: 1080, framerate: 60, bitrate: 8_000_000 },
          });
          return !!(r.supported && r.powerEfficient);
        } catch {
          return false;
        }
      })(),
    );
  }
  return hardware.get(mime);
}

/**
 * O codec da câmera NESTA máquina, para `outros` pessoas recebendo.
 *
 * VP9 dá a mesma imagem com uns 30–40% menos bits que o VP8 (o padrão do
 * navegador). Medido na 4G de mentira (2,5 Mbps, 2% de perda): o VP8 caía
 * para 479p e 33,6 dB; o VP9 ficou em 720p e 36,9 dB, com menos tempo
 * congelado. O preço é processador: por software ele custa 2 a 3 vezes o
 * VP8. Então: VP9 pela placa de vídeo sempre; por software só com 4 núcleos
 * ou mais, fora do celular, e com no máximo 2 cópias para codificar. Fora
 * disso fica o VP8 (sempre negociado; trocar volta ao VP8 quando a sala cresce).
 */
const ehCelular = () => {
  const nav = globalThis.navigator;
  return nav?.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent || "");
};

export async function codecDaCamera(
  outros,
  { nucleos = globalThis.navigator?.hardwareConcurrency || 2, celular = ehCelular(), hardware = porHardware, suporta = supportsCodec } = {},
) {
  if (!suporta("video/VP9")) return "video/VP8";
  if (await hardware("video/VP9")) return "video/VP9";
  if (!celular && nucleos >= 4 && outros <= 2) return "video/VP9";
  return "video/VP8";
}

export async function codecDaTela(mode) {
  if (await porHardware("video/AV1")) return "video/AV1";
  if (await porHardware("video/VP9")) return "video/VP9";
  return mode === "motion" && supportsCodec("video/H264") ? "video/H264" : "video/VP9";
}

/** A entrada de `params.codecs` (os negociados) para um tipo; H.264 só no modo de pacotes 1. */
function codecNegociado(codecs, mime) {
  return (codecs || []).find(
    (c) => c.mimeType.toLowerCase() === mime.toLowerCase() && (!/h264/i.test(mime) || /packetization-mode=1/.test(c.sdpFmtpLine || "")),
  );
}

/* ------------------------------------------------------------------ *
 * Parâmetros do sender
 * ------------------------------------------------------------------ */

/**
 * Aplica um perfil a um sender. Ler-modificar-escrever é obrigatório: montar
 * um objeto de parâmetros do zero faz o setParameters rejeitar.
 */
export async function applyProfile(sender, profile, overrides = {}) {
  if (!sender) return false;
  const opts = { ...profile, ...overrides };

  // contentHint vive na trilha, não no sender — e não sobrevive a um
  // replaceTrack, então é reaplicado aqui a cada chamada.
  if (opts.contentHint && sender.track && "contentHint" in sender.track) {
    sender.track.contentHint = opts.contentHint;
  }

  let params;
  try {
    params = sender.getParameters();
  } catch {
    return false;
  }
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

  if (opts.degradationPreference) params.degradationPreference = opts.degradationPreference;

  const enc = params.encodings[0];
  if (opts.maxBitrate != null) enc.maxBitrate = Math.round(opts.maxBitrate);
  if (opts.maxFramerate != null) enc.maxFramerate = opts.maxFramerate;
  if (opts.scaleResolutionDownBy != null) {
    enc.scaleResolutionDownBy = Math.max(1, opts.scaleResolutionDownBy);
  }
  if (opts.priority) enc.priority = opts.priority;
  if (opts.networkPriority) enc.networkPriority = opts.networkPriority;
  // Codec pedido mas não negociado com este par: fica o que está (pedir um
  // de fora da lista faz o setParameters inteiro ser recusado).
  const codec = opts.codec && codecNegociado(params.codecs, opts.codec);
  if (codec) enc.codec = codec;
  enc.active = opts.active !== false;

  try {
    await sender.setParameters(params);
    return true;
  } catch (err) {
    // Trocar o codec por setParameters é recente (Chrome 126+); quem não
    // aceita recusa a chamada inteira, e junto iam o teto de banda e de
    // quadros. Sem o codec, o resto do perfil ainda vale.
    if (codec) {
      delete enc.codec;
      try {
        await sender.setParameters(params);
        return true;
      } catch {
        /* cai no aviso abaixo */
      }
    }
    // Navegadores divergem sobre o que aceitam aqui; falhar não pode derrubar
    // a chamada — só significa que a trilha vai com os padrões do navegador.
    console.debug("[tuning] setParameters recusado", err?.name || err);
    return false;
  }
}

/**
 * Corrige o que o navegador ignora nas restrições iniciais do getDisplayMedia.
 * O Firefox descarta `frameRate` passado na captura, mas respeita o mesmo
 * valor aplicado depois na trilha.
 */
export async function constrainScreenTrack(track, { frameRate = 60, maxWidth = 1920, maxHeight = 1080 } = {}) {
  if (!track) return null;
  try {
    await track.applyConstraints({
      frameRate: { ideal: frameRate, max: frameRate },
      width: { max: maxWidth },
      height: { max: maxHeight },
    });
  } catch {
    /* restrição recusada: seguimos com o que a captura deu */
  }
  return track.getSettings?.() || null;
}

/**
 * Escolhe entre o perfil de texto e o de movimento a partir do que a captura
 * realmente entregou e do que o usuário declarou estar mostrando.
 */
export function screenProfileFor(mode) {
  return mode === "motion" ? PROFILES.screenMotion : PROFILES.screenText;
}

/* ------------------------------------------------------------------ *
 * Orçamento de banda da malha
 * ------------------------------------------------------------------ */

/**
 * Cada RTCPeerConnection estima a banda isoladamente e não sabe das outras.
 * Numa malha, todas tentam ocupar o mesmo enlace de subida. Sem um teto
 * central, quatro pares pedem quatro vezes a banda disponível e o resultado
 * é congestionamento — exatamente o "travando" que se vê na prática.
 */
export function meshBudget(peerCount, { uplink = 8_000_000 } = {}) {
  const n = Math.max(1, peerCount);
  /*
   * Uma pessoa só do outro lado: não há o que dividir, e o controle de
   * congestionamento da própria conexão já acha o limite do enlace. Usar a
   * estimativa como teto aqui era um teto que se alimentava de si mesmo: o
   * Chrome não estima muito acima do que está sendo enviado (~1,5×), então
   * 70% disso prendia a tela em ~3,4 Mbps em qualquer rede (medido).
   */
  if (n === 1) return { screen: PROFILES.screenMotion.maxBitrate, camera: PROFILES.camera.maxBitrate };
  const share = uplink / n;

  /*
   * O PISO É POR PAR, MAS O ENLACE É UM SÓ.
   *
   * Um piso generoso parece gentileza e é o contrário: com quatro pares e um
   * piso de 600 kbps cada, o programa promete 2,4 Mbps de subida mesmo num
   * enlace de 1,5 Mbps — e volta a entupir exatamente o que o orçamento
   * existia para proteger. Então o piso só vale enquanto a soma couber; a
   * partir daí a divisão honesta vence, e a imagem fica feia em vez de a
   * chamada cair. Feio e estável é melhor que bonito e travando.
   */
  const cabe = (600_000 + 150_000) * n <= uplink * 0.95;
  const piso = cabe ? { screen: 600_000, camera: 150_000 } : { screen: 0, camera: 0 };

  return {
    screen: Math.round(Math.min(PROFILES.screenMotion.maxBitrate, Math.max(piso.screen, share * 0.7))),
    camera: Math.round(Math.min(PROFILES.camera.maxBitrate, Math.max(piso.camera, share * 0.25))),
  };
}

/**
 * Câmera conforme o tamanho da sala (`outros`: quantas pessoas recebem).
 *
 * Numa malha, cada um codifica e envia uma cópia da própria câmera para cada
 * outro. 720p a 1,2 Mbps para oito pessoas são quase 10 Mbps de subida, que
 * Wi-Fi de casa e 4G não têm: a fila enche, o áudio atrasa e tudo trava. E
 * num ladrilho de um nono da tela ninguém vê a diferença de 720p para 240p.
 */
export function cameraParaSala(outros) {
  // 30 qps; a dois o StatsMonitor sobe para 60 quando a banda sobra.
  if (outros <= 1) return { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 };
  if (outros <= 3) return { maxBitrate: 600_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 };
  if (outros <= 5) return { maxBitrate: 350_000, scaleResolutionDownBy: 2, maxFramerate: 24 };
  if (outros <= 8) return { maxBitrate: 200_000, scaleResolutionDownBy: 3, maxFramerate: 15 };
  return { maxBitrate: 120_000, scaleResolutionDownBy: 4, maxFramerate: 15 };
}

/**
 * Quanto encolher a tela em movimento para caber na banda sem perder quadros.
 *
 * Com pouca banda para a imagem cheia, o encoder de tempo real estoura a meta
 * e joga quadros fora aos trancos: medido, 6 Mbps de subida com 1% de perda
 * davam 1,5 a 3 Mbps de meta, e um jogo em 1080p/720p chegava do outro lado
 * a 14–50 qps, com congelamentos a cada 2 s. Jogo e vídeo a 60 qps pedem
 * perto de 0,06 bit por pixel; abaixo disso vale mais a imagem menor com
 * todos os quadros. Encolhe na hora e só cresce com 30% de folga, senão a
 * imagem vai e volta a cada oscilação da banda.
 */
const DEGRAUS = [1, 1.25, 1.5, 2, 2.5, 3];
const BITS_POR_PIXEL = 0.06;

export function escalaPelaBanda(bps, pixels, qps, atual = 1) {
  if (!bps || !pixels || !qps) return atual;
  const cabe = (e, folga = 1) => bps >= (pixels / (e * e)) * qps * BITS_POR_PIXEL * folga;
  const precisa = DEGRAUS.find((e) => cabe(e)) ?? DEGRAUS.at(-1);
  if (precisa >= atual) return precisa;
  const cresce = DEGRAUS.find((e) => e >= precisa && cabe(e, 1.3));
  return cresce != null && cresce < atual ? cresce : atual;
}

/**
 * Quanto segurar o som da tela para acompanhar a imagem, em ms
 * (`jitterBufferTarget` do som; quem recebe chama a cada leitura).
 *
 * O alvo é o tempo da imagem no buffer (`videoMs`, média da última
 * leitura): com ele como mínimo, o som espera o mesmo que a imagem. Não
 * acumula a diferença de uma leitura para outra: o buffer do som leva
 * segundos para crescer, e somar a cada leitura disparava o alvo até o teto
 * (medido: o som foi a ~90 ms atrás da imagem). Nunca segura mais que
 * SINCRONIA_MAX_MS, e solta na hora quando a imagem engasga (buffer acima
 * de 400 ms ou sem quadros novos): som atrasado incomoda mais que imagem
 * atrasada, e diferença abaixo de ~125 ms ninguém percebe (ITU-R BT.1359).
 * Mudança menor que 30 ms fica como está.
 */
export const SINCRONIA_MAX_MS = 250;
export function alvoDoSom({ videoMs, alvo = 0, videoParado = false }) {
  if (videoParado || videoMs == null || videoMs > 400) return 0;
  const novo = Math.round(Math.min(SINCRONIA_MAX_MS, Math.max(0, videoMs)));
  return Math.abs(novo - alvo) < 30 ? alvo : novo;
}

/**
 * Subir a resolução reinicia o encoder e gera um quadro-chave: um soluço na
 * tela. Com a banda oscilando, a escala ia e voltava várias vezes por minuto.
 * Cresce só depois de SUBIR_ESCALA_MS de folga seguida; encolher é na hora,
 * para a imagem não congelar. `estado` guarda desde quando há folga.
 */
export const SUBIR_ESCALA_MS = 18_000;
export function escalaComCalma(quer, atual, estado, agora) {
  if (quer >= atual) {
    estado.folgaDesde = 0;
    return quer;
  }
  estado.folgaDesde ||= agora;
  if (agora - estado.folgaDesde < SUBIR_ESCALA_MS) return atual;
  estado.folgaDesde = 0;
  return quer;
}

/**
 * Teto de codificação sugerido pela CPU: numa malha codificamos N vezes.
 * Máquinas modestas com muitos pares precisam abrir mão de quadros antes de
 * abrir mão de resolução (texto ilegível é pior que texto que anda devagar).
 */
export function cpuCeiling(peerCount, cores) {
  const load = peerCount / Math.max(2, cores);
  if (load > 1.2) return { maxFramerate: 10, scaleResolutionDownBy: 1.5 };
  if (load > 0.8) return { maxFramerate: 15, scaleResolutionDownBy: 1.25 };
  if (load > 0.5) return { maxFramerate: 24, scaleResolutionDownBy: 1 };
  if (load > 0.3) return { maxFramerate: 30, scaleResolutionDownBy: 1 };
  // Acima de 60 só com uma cópia: cada pessoa a mais é outra codificação inteira.
  return { maxFramerate: peerCount <= 1 ? 120 : 60, scaleResolutionDownBy: 1 };
}
