/**
 * features/github.js — o kanban de um GitHub Project no Planning Poker.
 *
 * Quem importa escolhe as US de uma coluna; cada uma entra na mesa com a
 * descrição, a checklist do corpo (em geral os critérios de aceite) e as
 * sub-issues abertas como subtarefas votáveis logo abaixo, e vai para todo
 * mundo pelo estado dos jogos. Uma US (ou subtarefa) grande demais vira novas
 * sub-issues no GitHub pelo "Dividir". Quando uma estimativa é salva — por
 * qualquer pessoa — o computador de quem importou grava o número no campo
 * escolhido do projeto. O projeto, o campo e as issues ficam só aqui: ninguém
 * na chamada consegue mandar este computador gravar em outro lugar.
 *
 * Quem fala com o GitHub é o app de mesa (desktop/github.js), pela `ponte`.
 */
import { BARALHOS, historias, numero } from "./jogos.js";

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

/** A chave de um card na mesa: o item do quadro ou, numa subtarefa fora dele, a issue. */
export const chaveCard = (gh) => gh?.item || gh?.conteudo || null;

/** Uma sub-issue do GitHub como subtarefa votável (`card`: ela mesma no quadro, se estiver). */
function subtarefa(s, card) {
  const corpo = lerCorpo(s.corpo);
  return {
    titulo: semEtiqueta(s.titulo),
    estimativa: card?.estimativa == null ? null : String(card.estimativa),
    gh: { item: card?.item ?? null, conteudo: s.conteudo ?? null, numero: s.numero, url: s.url },
    descricao: corpo.descricao,
    criterios: corpo.criterios,
    marcas: s.marcas,
  };
}

export class KanbanGithub {
  /** O quadro da última importação: `{ projeto: { id, titulo, status }, campo: { id, nome } | null }`. */
  quadro = null;
  /**
   * O que este computador trouxe ou criou: chave do card -> `{ item, conteudo, coluna }`.
   * Só nestes ele grava, e com os ids daqui: quem está na chamada não aponta outra issue.
   */
  #meus = new Map();
  /** chave -> número que o GitHub já tem (ou que já tentamos gravar). */
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

  /** Os cards e issues do GitHub que já estão na mesa. */
  naMesa() {
    return new Set(historias(this.estado).flatMap((h) => [h.gh?.item, h.gh?.conteudo]).filter(Boolean));
  }

  /** O quadro e todos os cards dele (`ref`: `{ id }` ou `{ endereco }`). */
  async abrir(ref) {
    const projeto = await this.ponte("projeto", ref);
    const campo = projeto.numeros.find((f) => /estim|point|ponto/i.test(f.nome)) || projeto.numeros[0] || null;
    const cards = await this.ponte("cards", { projeto: projeto.id, status: projeto.status?.nome || "", campo: campo?.nome || "" });
    return { projeto, cards, campo };
  }

  /**
   * Põe na mesa as US escolhidas, com descrição, checklist e subtarefas; as
   * subtarefas abertas entram também como itens para votar (`subtarefas`).
   * `todos`: os cards do quadro (uma subtarefa que também é card usa o dele).
   * `campo`: onde gravar as estimativas (null: não grava).
   */
  async importar(projeto, escolhidos, { campo = null, todos = escolhidos, subtarefas = true } = {}) {
    const naMesa = this.naMesa();
    const livres = escolhidos.filter((c) => !naMesa.has(c.item));
    const novos = livres.slice(0, 50); // o limite de adicionarHistorias
    const det = novos.length ? await this.ponte("detalhes", { itens: novos.map((c) => c.item) }) : {};
    if (this.quadro?.projeto.id !== projeto.id || this.quadro?.campo?.id !== campo?.id) {
      this.#meus.clear();
      this.#enviados.clear();
    }
    this.quadro = { projeto: { id: projeto.id, titulo: projeto.titulo, status: projeto.status || null }, campo: campo ? { id: campo.id, nome: campo.nome } : null };
    const anotar = (chave, dados, estimativa) => {
      if (!chave) return;
      this.#meus.set(chave, { ...this.#meus.get(chave), ...dados });
      if (!this.#indo.has(chave)) this.#enviados.set(chave, estimativa ?? null);
    };
    for (const c of todos) anotar(c.item, { item: c.item, conteudo: c.conteudo ?? null, coluna: c.coluna ?? null }, c.estimativa);
    const porUrl = new Map(todos.filter((c) => c.url).map((c) => [c.url, c]));
    if (novos.length) {
      this.poker.adicionarHistorias(
        novos.map((c) => {
          const d = det?.[c.item] || {};
          const corpo = lerCorpo(d.corpo);
          const abertas = subtarefas ? (d.subs || []).filter((s) => !s.feita && !naMesa.has(s.conteudo) && !naMesa.has(porUrl.get(s.url)?.item)) : [];
          for (const s of abertas) {
            const card = porUrl.get(s.url);
            anotar(card?.item || s.conteudo, { item: card?.item ?? null, conteudo: s.conteudo ?? null, coluna: card?.coluna ?? c.coluna ?? null }, card?.estimativa);
          }
          return {
            titulo: c.titulo,
            estimativa: c.estimativa == null ? null : String(c.estimativa),
            gh: { item: c.item, conteudo: c.conteudo ?? null, numero: c.numero, url: c.url },
            descricao: corpo.descricao,
            criterios: corpo.criterios,
            marcas: d.marcas,
            subtarefas: (d.subs || []).map((s) => ({ ...s, titulo: semEtiqueta(s.titulo) })),
            subtarefasTotal: d.subsTotal || 0,
            filhas: abertas.map((s) => subtarefa(s, porUrl.get(s.url))),
          };
        }),
      );
    }
    return { novos: novos.length, faltam: livres.length - novos.length };
  }

  /** Dá para criar subtarefas embaixo desta história: é uma issue que este computador trouxe. */
  podeDividir(h) {
    return !!(this.ponte && this.quadro && this.#meus.get(chaveCard(h?.gh))?.conteudo);
  }

  /** O que o formulário de "Dividir" oferece: o repositório da issue e o quadro. */
  async formulario(h) {
    const meu = this.#meus.get(chaveCard(h?.gh));
    if (!meu?.conteudo || !this.quadro) throw new Error("Esta história não veio do GitHub por este computador.");
    const repo = await this.ponte("repositorio", { issue: meu.conteudo });
    const baralho = BARALHOS[this.estado.ler("p/baralho", "fibonacci")] || BARALHOS.fibonacci;
    return {
      repo,
      quadro: this.quadro,
      coluna: meu.coluna,
      cartas: baralho.cartas.filter((c) => numero(c) != null),
    };
  }

  /**
   * Cria a subtarefa no GitHub embaixo da história `h` e põe na mesa, logo
   * abaixo dela. `dados`: `{ titulo, corpo, pessoas, etiquetas, marco, tipo,
   * coluna, estimativa }` (ids do repositório, como vieram de `formulario`).
   * `marcas`: o que mostrar na mesa (nomes e cores das etiquetas, logins, tipo).
   */
  async criarSubtarefa(h, dados, marcas = null) {
    const meu = this.#meus.get(chaveCard(h?.gh));
    const q = this.quadro;
    if (!meu?.conteudo || !q) throw new Error("Esta história não veio do GitHub por este computador.");
    const n = numero(String(dados.estimativa ?? ""));
    const status = q.projeto.status;
    const r = await this.ponte("criar", {
      pai: meu.conteudo,
      repositorio: dados.repositorio,
      titulo: dados.titulo,
      corpo: dados.corpo,
      pessoas: dados.pessoas,
      etiquetas: dados.etiquetas,
      marco: dados.marco || null,
      tipo: dados.tipo || null,
      projeto: q.projeto.id,
      coluna: status?.id && dados.coluna ? { campo: status.id, opcao: dados.coluna } : null,
      estimativa: q.campo && n != null ? { campo: q.campo.id, numero: n } : null,
    });
    const chave = r.item || r.conteudo;
    this.#meus.set(chave, { item: r.item, conteudo: r.conteudo, coluna: dados.coluna || meu.coluna || null });
    this.#enviados.set(chave, r.item && q.campo && n != null ? n : null);
    const corpo = lerCorpo(dados.corpo);
    this.poker.adicionarSubtarefa(h.id, {
      titulo: r.titulo,
      estimativa: n == null ? null : String(dados.estimativa),
      gh: { item: r.item, conteudo: r.conteudo, numero: r.numero, url: r.url },
      descricao: corpo.descricao,
      criterios: corpo.criterios,
      marcas,
    });
    return r;
  }

  /** Estimativa nova num card trazido daqui: grava no GitHub (uma vez por valor). */
  #sincronizar() {
    const q = this.quadro;
    if (!q?.campo) return;
    for (const h of historias(this.estado)) {
      const chave = chaveCard(h.gh);
      const meu = chave && this.#meus.get(chave);
      const n = numero(String(h.estimativa ?? ""));
      if (!meu || n == null || this.#enviados.get(chave) === n || this.#indo.has(chave)) continue;
      this.#indo.add(chave);
      // Marca antes de saber o resultado: um erro não vira uma tentativa a cada voto.
      this.#enviados.set(chave, n);
      const status = q.projeto.status;
      this.ponte("estimar", {
        projeto: q.projeto.id,
        item: meu.item,
        conteudo: meu.conteudo,
        campo: q.campo.id,
        numero: n,
        // Uma subtarefa fora do quadro entra nele na coluna da US.
        coluna: status?.id && meu.coluna ? { campo: status.id, opcao: meu.coluna } : null,
      })
        .then((r) => {
          if (r?.item) meu.item = r.item;
          this.avisar(`Estimativa ${n} gravada no GitHub${h.gh.numero ? ` (#${h.gh.numero})` : ""}`, "ok");
        })
        .catch((err) => this.avisar(`Não gravou no GitHub: ${err.message}`, "warn"))
        .finally(() => {
          this.#indo.delete(chave);
          this.#sincronizar();
        });
    }
  }
}
