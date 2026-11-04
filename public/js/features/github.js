/**
 * features/github.js — o kanban de um GitHub Project no Planning Poker.
 *
 * Quem importa escolhe as US de uma coluna; cada uma entra na mesa com a
 * descrição, a checklist do corpo (em geral os critérios de aceite) e as
 * sub-issues como subtarefas, e vai para todo mundo pelo estado dos jogos.
 * Quando uma estimativa é salva — por qualquer pessoa — o computador de quem
 * importou grava o número no campo escolhido do projeto. O projeto, o campo e
 * os cards ficam só aqui: ninguém na chamada consegue mandar este computador
 * gravar em outro lugar.
 *
 * Quem fala com o GitHub é o app de mesa (desktop/github.js), pela `ponte`.
 */
import { historias, numero } from "./jogos.js";

const CHECK = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const TITULO = /^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*:?|__(.+?)__:?)\s*#*\s*$/;

/** Markdown em texto corrido: sem imagens, comentários, ênfase nem endereço dos links. */
function textoSimples(linha) {
  return linha
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim();
}

/**
 * O corpo de uma issue em duas partes: a descrição (texto simples) e a
 * checklist, com o nome do título que vem antes dela ("Critérios de aceite").
 */
export function lerCorpo(md) {
  const linhas = String(md || "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const itens = [];
  let nome = "";
  let ultimoTitulo = "";
  let iTitulo = -1;
  const texto = [];
  for (const linha of linhas) {
    const c = CHECK.exec(linha);
    if (c) {
      if (!itens.length) {
        nome = ultimoTitulo;
        // O título da checklist não fica também na descrição.
        if (iTitulo >= 0 && iTitulo === texto.length - 1) texto.pop();
      }
      itens.push({ titulo: textoSimples(c[2]), feito: c[1] !== " " });
      continue;
    }
    const t = TITULO.exec(linha);
    if (t) {
      ultimoTitulo = textoSimples(t[1] || t[2] || t[3]).replace(/:$/, "");
      iTitulo = texto.length;
    }
    texto.push(textoSimples(linha));
  }
  // "Descrição" no começo é o nome da seção, que a mesa já mostra.
  while (texto.length && (!texto[0] || /^descri[cç][aã]o:?$/i.test(texto[0]))) texto.shift();
  const descricao = texto.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { descricao, criterios: itens.length ? { nome: nome || "Checklist", itens: itens.filter((i) => i.titulo) } : null };
}

/** "[US12] Criar GET /alertas" → "Criar GET /alertas": a etiqueta repete a US de cima. */
const semEtiqueta = (t) => String(t || "").replace(/^\s*\[[^\]]{1,24}\]\s*[-–—:]?\s*/, "") || String(t || "");

export class KanbanGithub {
  /** { projeto, campo, itens: Set<itemId> } depois de importar com um campo para gravar. */
  vinculo = null;
  /** item -> número que o GitHub já tem (ou que já tentamos gravar). */
  #enviados = new Map();
  #indo = new Set();

  /**
   * @param {import("./jogos.js").EstadoJogos} estado
   * @param {import("./jogos.js").Poker} poker
   * @param {((acao:string, dados?:object) => Promise<any>)|null} ponte  window.vcallDesktop.github
   * @param {(texto:string, tom?:string) => void} avisar
   */
  constructor(estado, poker, ponte, avisar = () => {}) {
    Object.assign(this, { estado, poker, ponte, avisar });
    if (ponte) estado.on("mudou", () => this.#sincronizar());
  }

  get disponivel() {
    return !!this.ponte;
  }

  /** Os cards do GitHub que já estão na mesa. */
  naMesa() {
    return new Set(historias(this.estado).map((h) => h.gh?.item).filter(Boolean));
  }

  /** O quadro e todos os cards dele (`ref`: `{ id }` ou `{ endereco }`). */
  async abrir(ref) {
    const projeto = await this.ponte("projeto", ref);
    const campo = projeto.numeros.find((f) => /estim|point|ponto/i.test(f.nome)) || projeto.numeros[0] || null;
    const cards = await this.ponte("cards", { projeto: projeto.id, status: projeto.status?.nome || "", campo: campo?.nome || "" });
    return { projeto, cards, campo };
  }

  /**
   * Põe na mesa as US escolhidas, com descrição, checklist e subtarefas.
   * `todos`: os cards do quadro (para gravar a estimativa de qualquer um deles).
   * Devolve quantas entraram.
   */
  async importar(projeto, escolhidos, { campo = null, todos = escolhidos } = {}) {
    const naMesa = this.naMesa();
    const novos = escolhidos.filter((c) => !naMesa.has(c.item)).slice(0, 50); // o limite de adicionarHistorias
    const det = novos.length ? await this.ponte("detalhes", { itens: novos.map((c) => c.item) }) : {};
    if (campo) {
      if (this.vinculo?.projeto !== projeto.id || this.vinculo?.campo !== campo.id) this.vinculo = { projeto: projeto.id, campo: campo.id, itens: new Set() };
      for (const c of todos) {
        this.vinculo.itens.add(c.item);
        if (!this.#indo.has(c.item)) this.#enviados.set(c.item, c.estimativa);
      }
    } else this.vinculo = null;
    if (novos.length) {
      this.poker.adicionarHistorias(
        novos.map((c) => {
          const d = det?.[c.item] || {};
          const corpo = lerCorpo(d.corpo);
          return {
            titulo: c.titulo,
            estimativa: c.estimativa == null ? null : String(c.estimativa),
            gh: { item: c.item, numero: c.numero, url: c.url },
            descricao: corpo.descricao,
            criterios: corpo.criterios,
            subtarefas: (d.subs || []).map((s) => ({ ...s, titulo: semEtiqueta(s.titulo) })),
            subtarefasTotal: d.subsTotal || 0,
          };
        }),
      );
    }
    return { novos: novos.length, faltam: escolhidos.filter((c) => !naMesa.has(c.item)).length - novos.length };
  }

  /** Estimativa nova num card importado daqui: grava no GitHub (uma vez por valor). */
  #sincronizar() {
    const v = this.vinculo;
    if (!v) return;
    for (const h of historias(this.estado)) {
      const item = h.gh?.item;
      const n = numero(String(h.estimativa ?? ""));
      if (!item || n == null || !v.itens.has(item) || this.#enviados.get(item) === n || this.#indo.has(item)) continue;
      this.#indo.add(item);
      // Marca antes de saber o resultado: um erro não vira uma tentativa a cada voto.
      this.#enviados.set(item, n);
      this.ponte("estimar", { projeto: v.projeto, item, campo: v.campo, numero: n })
        .then(() => this.avisar(`Estimativa ${n} gravada no GitHub${h.gh.numero ? ` (#${h.gh.numero})` : ""}`, "ok"))
        .catch((err) => this.avisar(`Não gravou no GitHub: ${err.message}`, "warn"))
        .finally(() => {
          this.#indo.delete(item);
          this.#sincronizar();
        });
    }
  }
}
