/**
 * core/rele.js — a sala se ajuda: quanto mais gente, mais caminhos.
 *
 * Numa malha pura, cada pessoa depende de uma conexão direta com cada outra.
 * Se a de Ana com Bruno cai (NAT que não deixa passar, Wi-Fi que piscou),
 * os dois deixam de se ouvir — mesmo que os dois continuem falando muito bem
 * com Carla. E quem está no 4G precisa mandar uma cópia da própria câmera para
 * cada pessoa, até a subida não dar conta e tudo travar.
 *
 * O relé usa quem está na sala como caminho reserva:
 *
 *   RESGATE   par sem conexão direta há alguns segundos: um terceiro, ligado
 *             aos dois, repassa tudo (voz, câmera, tela) nos dois sentidos,
 *             enquanto a conexão direta continua tentando voltar por baixo.
 *             A voz não some enquanto o ICE se refaz.
 *   AJUDA     quem tem subida fraca (ou está no celular, em sala de 4 ou
 *             mais) manda a câmera e a tela UMA vez, para um ajudante forte,
 *             que repassa para os outros. Voz continua direta: é leve e é a
 *             que mais sente atraso.
 *
 * Cada pessoa anuncia pelo canal de dados (a cada 1,5 s) o que mede de si:
 * subida, núcleos, se é celular, com quem está conectada, e — se for ajudante
 * — o que está repassando. Todos rodam o mesmo planejamento com os mesmos
 * dados; cada um só executa a própria parte:
 *
 *   ajudante  repassa as trilhas recebidas (linhas extras em core/peer.js);
 *   origem    só desliga o envio direto depois que o ajudante CONFIRMA que
 *             está repassando — nunca há um instante sem caminho;
 *   destino   usa a trilha repassada quando ela tem quadros (ou quando a
 *             direta não tem), e volta para a direta assim que ela voltar.
 *
 * O navegador não deixa encaminhar pacotes sem decodificar: o ajudante
 * decodifica e codifica de novo. Por isso só ajuda quem tem processador para
 * isso (4+ núcleos, fora do celular), com um teto de origens por ajudante.
 *
 * Além do relé, este arquivo cuida de dois buracos que o navegador deixa:
 *
 *   TROCA DE REDE   Wi-Fi -> 4G, cabo que sai: o caminho velho morre, mas o
 *                   navegador leva segundos para perceber. Reinicia o ICE de
 *                   todas as conexões na hora (a mídia segue pelo caminho
 *                   velho até o novo ficar pronto).
 *   CONGELADA       conexão que diz "conectada" e não recebe nem um byte:
 *                   com RTCP, DTX e este próprio anúncio, sempre chega algo.
 *                   Dez segundos sem nada é conexão morta — reinicia o ICE.
 */
import { cameraParaSala, PROFILES } from "./tuning.js";

export const RELE_TICK_MS = 1500;
/** Anúncio mais velho que isto não vale (a pessoa sumiu do canal). */
const VALIDADE_MS = 6000;
/** Par sem conexão direta por este tempo entra no resgate. */
const QUEBRA_MS = 3000;
/** Conexão "conectada" sem receber bytes por este tempo é reiniciada. */
const CONGELADA_MS = 10_000;
/** A estimativa de banda leva uns segundos para subir; antes disso ninguém é "fraco". */
const AQUECIMENTO_MS = 20_000;

export const PAPEIS_TODOS = ["mic", "cam", "screen", "screenAudio"];
export const PAPEIS_VIDEO = ["cam", "screen"];

/** O anúncio vem de outra pessoa: só listas de verdade contam. */
const lista = (v) => (Array.isArray(v) ? v : []);

const ehCelular = () =>
  typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");

/**
 * O planejamento: quem repassa o quê para quem. Função pura — todos rodam a
 * mesma com os mesmos anúncios.
 *
 * @param {object} p
 * @param {string[]} p.ids        todos na sala (incluindo quem calcula)
 * @param {Map<string, {cpu?:number, movel?:boolean, fraco?:boolean, ok:Set<string>}>} p.info
 * @param {Array<[string, string]>} p.quebrados  pares sem conexão direta
 * @returns {Array<{h:string, de:string, para:string, papeis:string[]}>}
 */
export function planejarRele({ ids, info, quebrados = [] }) {
  const ligado = (a, b) => !!(info.get(a)?.ok?.has(b) && info.get(b)?.ok?.has(a));
  const forte = (id) => {
    const i = info.get(id);
    return !!i && !i.movel && !i.fraco && (i.cpu ?? 0) >= 4;
  };
  // Ordem de quem ajuda: forte primeiro, depois mais núcleos, celular por último; empate pelo id.
  const peso = (id) => {
    const i = info.get(id);
    if (!i) return -1;
    return (forte(id) ? 1000 : 0) + Math.min(64, i.cpu ?? 2) - (i.movel ? 500 : 0) - (i.fraco ? 100 : 0);
  };
  const ordem = [...ids].sort((a, b) => peso(b) - peso(a) || (a < b ? -1 : a > b ? 1 : 0));
  const chavePar = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const quebrado = new Set(quebrados.map(([a, b]) => chavePar(a, b)));

  const plano = [];
  const juntar = (h, de, para, papeis) => {
    const ja = plano.find((p) => p.h === h && p.de === de && p.para === para);
    if (ja) ja.papeis = [...new Set([...ja.papeis, ...papeis])];
    else plano.push({ h, de, para, papeis: [...papeis] });
  };

  // 1. Resgate: um par quebrado ganha o melhor terceiro ligado aos dois.
  for (const k of [...quebrado].sort()) {
    const [a, b] = k.split("|");
    if (!ids.includes(a) || !ids.includes(b)) continue;
    const h = ordem.find((h) => h !== a && h !== b && ligado(h, a) && ligado(h, b));
    if (!h) continue;
    juntar(h, a, b, PAPEIS_TODOS);
    juntar(h, b, a, PAPEIS_TODOS);
  }

  // 2. Ajuda: quem tem subida fraca (ou é celular, em sala de 4+) manda vídeo uma vez só.
  const n = ids.length;
  if (n >= 3) {
    const fracos = ids
      .filter((id) => {
        const i = info.get(id);
        return !!i && (i.fraco || (i.movel && n >= 4));
      })
      .sort();
    // Cada ajudante aguenta re-codificar o vídeo de poucas origens: metade dos núcleos.
    const vagas = new Map(ordem.filter(forte).map((h) => [h, Math.max(1, Math.floor((info.get(h).cpu ?? 4) / 2))]));
    for (const x of fracos) {
      const h = [...vagas.keys()].find((h) => h !== x && vagas.get(h) > 0 && ligado(h, x));
      if (!h) continue;
      vagas.set(h, vagas.get(h) - 1);
      for (const y of ids) {
        if (y === x || y === h || !ligado(h, y)) continue;
        juntar(h, x, y, PAPEIS_VIDEO);
      }
    }
  }
  return plano;
}

export class Rele {
  /** id -> anúncio mais recente: { up, cpu, movel, fraco, ok:Set, rele, em } */
  info = new Map();
  /** Testes e diagnóstico: { fraco?: boolean, movel?: boolean, cpu?: number, quebrar?: string[] } */
  forcar = null;

  #mesh;
  #timer = 0;
  #inicio = 0;
  #quebradoDesde = new Map(); // "a|b" -> quando a conexão direta sumiu
  #bytes = new Map(); // id -> { valor, desde }
  #meuRele = {}; // de -> para -> papeis (o que ESTA pessoa repassa de fato)
  #fraco = false;
  #fracoDesde = 0;
  #tipoRede = "";
  #trocaTimer = 0;

  constructor(mesh) {
    this.#mesh = mesh;
  }

  start() {
    if (this.#timer) return;
    this.#inicio = Date.now();
    this.#timer = setInterval(() => this.tick(), RELE_TICK_MS);
    this.#ouvirRede();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = 0;
    removeEventListener?.("online", this.#aoTrocarRede);
    navigator.connection?.removeEventListener?.("change", this.#aoMudarConexao);
  }

  /** Anúncio de outro participante (canal de dados). */
  /** Quem já anunciou alguma vez: dessas conexões sempre chega algo a cada 1,5 s. */
  #anunciam = new Set();

  receber(de, msg) {
    this.#anunciam.add(de);
    this.info.set(de, {
      up: Number.isFinite(msg.up) ? msg.up : null,
      cpu: Number.isFinite(msg.cpu) ? msg.cpu : null,
      movel: !!msg.movel,
      fraco: !!msg.fraco,
      ok: new Set(Array.isArray(msg.ok) ? msg.ok.filter((x) => typeof x === "string").slice(0, 64) : []),
      rele: msg.rele && typeof msg.rele === "object" ? msg.rele : {},
      em: Date.now(),
    });
  }

  esquecer(id) {
    this.info.delete(id);
    this.#anunciam.delete(id);
    this.#bytes.delete(id);
    for (const k of [...this.#quebradoDesde.keys()]) if (k.split("|").includes(id)) this.#quebradoDesde.delete(k);
  }

  /* ---------------------------------------------------------------- */

  #meuAnuncio() {
    const mesh = this.#mesh;
    const quebrar = new Set(this.forcar?.quebrar || []);
    const ok = [...mesh.peers.entries()]
      .filter(([id, p]) => p.connectionState === "connected" && !quebrar.has(id))
      .map(([id]) => id);
    return {
      type: "rede",
      up: Math.round((mesh.stats?.subida || 0) / 1000) || null,
      cpu: this.forcar?.cpu ?? ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2),
      movel: this.forcar?.movel ?? ehCelular(),
      fraco: this.forcar?.fraco ?? this.#fraco,
      ok,
      rele: this.#meuRele,
    };
  }

  /**
   * Fraco é quem não tem subida para uma cópia de câmera por pessoa. Só vale
   * depois do aquecimento, e só depois de dez segundos seguidos assim — uma
   * queda de um segundo não muda o caminho de ninguém. Uma vez ajudado, fica:
   * mandando uma cópia só, a estimativa dele nem tem como subir.
   */
  #avaliarFraco() {
    const mesh = this.#mesh;
    const n = mesh.peers.size + 1;
    const up = (mesh.stats?.subida || 0) / 1000;
    if (n < 3) {
      this.#fraco = false;
      this.#fracoDesde = 0;
      return;
    }
    if (this.#fraco || Date.now() - this.#inicio < AQUECIMENTO_MS || !up) return;
    const precisa = (n - 1) * (cameraParaSala(n - 1).maxBitrate / 1000 + 50);
    if (up < precisa * 0.6) {
      this.#fracoDesde ||= Date.now();
      if (Date.now() - this.#fracoDesde > 10_000) this.#fraco = true;
    } else this.#fracoDesde = 0;
  }

  /** Uma volta: anuncia, planeja, executa a própria parte, escolhe as fontes. */
  #ocupado = false;

  async tick() {
    if (this.#ocupado) return;
    this.#ocupado = true;
    try {
      await this.#volta();
    } finally {
      this.#ocupado = false;
    }
  }

  async #volta() {
    const mesh = this.#mesh;
    const eu = mesh.selfId;
    if (!eu) return;
    const agora = Date.now();

    for (const [id, i] of [...this.info]) if (agora - i.em > VALIDADE_MS || !mesh.peers.has(id)) this.info.delete(id);
    this.#avaliarFraco();
    this.#vigiarCongeladas(agora);

    const anuncio = this.#meuAnuncio();
    const meu = { ...anuncio, ok: new Set(anuncio.ok), em: agora };
    const info = new Map(this.info);
    info.set(eu, meu);
    const ids = [eu, ...mesh.peers.keys()];

    // Pares sem conexão direta: só com anúncio fresco das duas pontas.
    const quebrados = [];
    const vistos = new Set();
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b || !info.has(a) || !info.has(b)) continue;
        const k = `${a}|${b}`;
        vistos.add(k);
        const ligados = info.get(a).ok.has(b) && info.get(b).ok.has(a);
        if (ligados) this.#quebradoDesde.delete(k);
        else if (!this.#quebradoDesde.has(k)) this.#quebradoDesde.set(k, agora);
        else if (agora - this.#quebradoDesde.get(k) >= QUEBRA_MS) quebrados.push([a, b]);
      }
    }
    for (const k of [...this.#quebradoDesde.keys()]) if (!vistos.has(k)) this.#quebradoDesde.delete(k);

    const plano = planejarRele({ ids, info, quebrados });
    await this.#executar(plano.filter((p) => p.h === eu), ids.length);

    // Anuncia já com o que está repassando de fato.
    anuncio.rele = this.#meuRele;
    for (const peer of mesh.peers.values()) peer.sendBoard(anuncio);

    this.#rotearOrigem();
    mesh.reavaliarMidia?.();
  }

  /** Parte do ajudante: repassa as trilhas recebidas de cada origem para cada destino. */
  async #executar(tarefas, n) {
    const mesh = this.#mesh;
    const porDestino = new Map();
    const meu = {};
    // Teto de vídeo re-codificado por este processador.
    let vagasVideo = Math.max(2, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4) * 2);
    for (const t of tarefas) {
      const origem = mesh.peers.get(t.de);
      const destino = mesh.peers.get(t.para);
      if (origem?.connectionState !== "connected" || destino?.connectionState !== "connected") continue;
      const desejado = porDestino.get(t.para) || new Map();
      const feitos = [];
      for (const papel of t.papeis) {
        // Tela de quem o destino não assiste (como no Discord) não é repassada.
        if ((papel === "screen" || papel === "screenAudio") && destino.telasVistas && !destino.telasVistas.has(t.de)) continue;
        const ehVideo = PAPEIS_VIDEO.includes(papel);
        if (ehVideo && vagasVideo <= 0) continue;
        const track = origem.tx[papel]?.receiver?.track;
        if (!track) continue;
        if (ehVideo) vagasVideo -= 1;
        desejado.set(`${t.de}:${papel}`, { track, perfil: perfilRepasse(papel, n) });
        feitos.push(papel);
      }
      if (!feitos.length) continue;
      porDestino.set(t.para, desejado);
      (meu[t.de] ||= {})[t.para] = feitos;
    }
    await Promise.all(
      [...mesh.peers.entries()].map(([id, peer]) => {
        const desejado = porDestino.get(id) || new Map();
        if (!desejado.size && !peer.repassando.length) return null;
        return peer.definirRepasse(desejado);
      }),
    );
    this.#meuRele = meu;
  }

  /**
   * Parte da origem: desliga o envio direto do vídeo para quem já recebe por
   * um ajudante — só com a confirmação dele, e só enquanto a conexão com ele
   * estiver de pé. Sem confirmação, volta a mandar direto.
   */
  #rotearOrigem() {
    const mesh = this.#mesh;
    const eu = mesh.selfId;
    for (const [y, peer] of mesh.peers) {
      const papeis = new Set();
      for (const [h, i] of this.info) {
        if (h === y || mesh.peers.get(h)?.connectionState !== "connected") continue;
        for (const p of lista(i.rele?.[eu]?.[y])) if (PAPEIS_VIDEO.includes(p)) papeis.add(p);
      }
      // Quem já recebe a tela pelo SFU (core/sfu.js) também não precisa dela direto.
      for (const p of mesh.sfu?.papeisPara(y) || []) papeis.add(p);
      peer.rotearPorRele([...papeis]);
    }
  }

  /**
   * Parte do destino: quem me entrega (de, papel)? Um ajudante id, ou null
   * para a conexão direta. `repassada(h)` e `direta` dizem se há quadros.
   */
  fonte(de, papel, { repassada, direta }) {
    const eu = this.#mesh.selfId;
    const ajudantes = [...this.info.entries()]
      .filter(([h, i]) => h !== de && lista(i.rele?.[de]?.[eu]).includes(papel) && this.#mesh.peers.get(h)?.connectionState === "connected")
      .map(([h]) => h)
      .sort();
    for (const h of ajudantes) {
      const r = repassada(h);
      if (r?.stream && (r.live || !direta?.live)) return h;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Quedas que o navegador demora a perceber
   * ---------------------------------------------------------------- */

  #vigiarCongeladas(agora) {
    const mesh = this.#mesh;
    for (const [id, peer] of mesh.peers) {
      const bytes = mesh.stats?.samples?.get(id)?.transport?.bytesReceived;
      // Versão antiga do outro lado pode ficar calada de verdade (sem voz, sem câmera, sem anúncio).
      if (peer.connectionState !== "connected" || bytes == null || !this.#anunciam.has(id)) {
        this.#bytes.delete(id);
        continue;
      }
      const antes = this.#bytes.get(id);
      if (!antes || bytes !== antes.valor) {
        this.#bytes.set(id, { valor: bytes, desde: agora });
        continue;
      }
      if (agora - antes.desde >= CONGELADA_MS) {
        this.#bytes.set(id, { valor: bytes, desde: agora }); // próxima tentativa só daqui a outro intervalo
        this.reinicios = (this.reinicios || 0) + 1;
        // Em silêncio: se a conexão estava viva (aba em segundo plano), reiniciar não custa nada.
        peer.reiniciarIce({ silencioso: true });
      }
    }
  }

  #ouvirRede() {
    addEventListener?.("online", this.#aoTrocarRede);
    const c = typeof navigator !== "undefined" ? navigator.connection : null;
    this.#tipoRede = c?.type || "";
    c?.addEventListener?.("change", this.#aoMudarConexao);
  }

  /** `change` também dispara quando só a estimativa de velocidade muda; só a troca de tipo de rede interessa. */
  #aoMudarConexao = () => {
    const tipo = navigator.connection?.type || "";
    if (!tipo || tipo === this.#tipoRede) return;
    this.#tipoRede = tipo;
    this.#aoTrocarRede();
  };

  #aoTrocarRede = () => {
    clearTimeout(this.#trocaTimer);
    // A interface nova leva um instante para ter endereço; antes disso não há candidato novo.
    this.#trocaTimer = setTimeout(() => {
      this.trocasDeRede = (this.trocasDeRede || 0) + 1;
      for (const peer of this.#mesh.peers.values()) peer.reiniciarIce({ silencioso: true });
    }, 800);
  };
}

/** Como o ajudante codifica o que repassa: no degrau da sala, nunca acima. */
export function perfilRepasse(papel, n) {
  if (papel === "cam") return { ...PROFILES.camera, ...cameraParaSala(Math.max(1, n - 1)) };
  // O ajudante decodifica e codifica de novo, uma cópia por pessoa: 30 qps bastam.
  if (papel === "screen") return { ...PROFILES.screenText, maxBitrate: 1_500_000, maxFramerate: 30 };
  if (papel === "mic") return PROFILES.mic;
  return PROFILES.screenAudio;
}
