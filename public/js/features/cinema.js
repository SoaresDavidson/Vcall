/**
 * features/cinema.js — "Assistir junto": um vídeo da biblioteca Jellyfin de
 * quem hospeda, no mesmo ponto para todos. Só a lógica; a tela fica em
 * ui/cinema.js.
 *
 * O VÍDEO NÃO VIAJA ENTRE AS PESSOAS
 *
 * Cada participante baixa o vídeo do servidor da sala (src/jellyfin.js), que
 * mora no computador de quem hospeda e repassa ao Jellyfin dele. Nada é
 * enviado antes: o navegador pede só o trecho que vai tocar (Range).
 *
 * O QUE VIAJA: DUAS CHAVES NO ESTADO DOS JOGOS
 *
 *   cn/item   qual vídeo  { id, nome, seg }
 *   cn/tempo  como tocar  { tocando, pos, em, por }
 *
 * `em` é a hora em que `pos` valia, no relógio do SERVIDOR da sala — o mesmo
 * para todos. O relógio de cada computador pode estar segundos fora, e com
 * ele cada um calcularia um ponto diferente do vídeo. Com o do servidor,
 * "tocando desde 12,5 s às 15:00:03" dá o mesmo ponto em todo lugar, inclusive
 * para quem chega no meio e recebe só o estado.
 *
 * Quem mexeu por último vence (o estado é "último a escrever", features/jogos.js):
 * qualquer um dá play, pausa ou pula, como num controle remoto compartilhado.
 */
import { Emitter } from "../lib/emitter.js";

const ID_RE = /^[a-f0-9]{32}$/;

export class Cinema extends Emitter {
  /** null: ainda não perguntou; true/false: o servidor tem (ou não) Jellyfin. */
  disponivel = null;
  #ficha = "";
  #pedindoFicha = null;

  /**
   * @param {import("./jogos.js").EstadoJogos} estado
   * @param {object} o
   * @param {() => number} o.agora hora no relógio do servidor da sala (ms)
   * @param {() => string} o.sala id da sala
   * @param {() => string} o.sessao token da sessão desta aba (o mesmo do join)
   * @param {typeof fetch} [o.buscar]
   */
  constructor(estado, { agora, sala, sessao, buscar = (...a) => fetch(...a) }) {
    super();
    this.estado = estado;
    this.agora = agora;
    this.sala = sala;
    this.sessao = sessao;
    this.fetch = buscar;
  }

  /* -------------------------- estado -------------------------- */

  item() {
    const i = this.estado.ler("cn/item");
    return i && ID_RE.test(i.id) ? i : null;
  }

  tempo() {
    const t = this.estado.ler("cn/tempo");
    if (!t || typeof t !== "object") return { tocando: false, pos: 0, em: 0, por: "" };
    return { tocando: !!t.tocando, pos: Math.max(0, Number(t.pos) || 0), em: Number(t.em) || 0, por: String(t.por || "") };
  }

  /** Em que ponto (s) o vídeo deveria estar agora. */
  posicaoAgora() {
    const t = this.tempo();
    if (!t.tocando || !t.em) return t.pos;
    const passou = Math.max(0, (this.agora() - t.em) / 1000);
    const fim = this.item()?.seg || Infinity;
    return Math.min(t.pos + passou, fim);
  }

  escolher({ id, nome, segundos }) {
    if (!ID_RE.test(id)) return;
    this.estado.definir([
      ["cn/item", { id, nome: String(nome || "").slice(0, 200), seg: Math.max(0, Number(segundos) || 0) }],
      ["cn/tempo", { tocando: false, pos: 0, em: this.agora(), por: this.estado.eu }],
    ]);
  }

  tocar(pos) {
    this.#tempo(true, pos);
  }

  pausar(pos) {
    this.#tempo(false, pos);
  }

  /** Pular para `pos` sem mudar o play/pausa. */
  irPara(pos) {
    this.#tempo(this.tempo().tocando, pos);
  }

  fechar() {
    this.estado.definir([
      ["cn/item", null],
      ["cn/tempo", null],
    ]);
  }

  #tempo(tocando, pos) {
    if (!this.item()) return;
    this.estado.definir([["cn/tempo", { tocando, pos: Math.max(0, Number(pos) || 0), em: this.agora(), por: this.estado.eu }]]);
  }

  /* ------------------- o Jellyfin de quem hospeda ------------------- */

  /** A ficha desta aba no servidor da sala. `null` se o servidor não tem Jellyfin. */
  async ficha({ nova = false } = {}) {
    if (this.#ficha && !nova) return this.#ficha;
    this.#pedindoFicha ||= (async () => {
      const r = await this.fetch("/jellyfin/ficha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sala: this.sala(), sessao: this.sessao() }),
      });
      if (r.status === 404) {
        this.#mudarDisponivel(false);
        return null;
      }
      if (!r.ok) throw new Error(r.status === 403 ? "Você ainda não está na sala." : `O servidor recusou (${r.status}).`);
      this.#mudarDisponivel(true);
      this.#ficha = (await r.json()).ficha || "";
      return this.#ficha;
    })().finally(() => (this.#pedindoFicha = null));
    return this.#pedindoFicha;
  }

  /** Vídeos da biblioteca (busca vazia: todos, até 40). */
  async biblioteca(busca = "") {
    for (const nova of [false, true]) {
      const f = await this.ficha({ nova });
      if (!f) return [];
      const r = await this.fetch(`/jellyfin/itens?f=${encodeURIComponent(f)}&busca=${encodeURIComponent(busca)}`);
      if (r.status === 403 && !nova) continue; // ficha vencida: pede outra uma vez
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || `Falha ao buscar (${r.status}).`);
      return (await r.json()).itens || [];
    }
    return [];
  }

  /** Endereço do arquivo do vídeo, servido pela própria sala. */
  async enderecoDoVideo(id, { nova = false } = {}) {
    const f = await this.ficha({ nova });
    return f && ID_RE.test(id) ? `/jellyfin/video/${id}?f=${encodeURIComponent(f)}` : "";
  }

  #mudarDisponivel(v) {
    if (this.disponivel === v) return;
    this.disponivel = v;
    this.emit("disponivel", v);
  }
}
