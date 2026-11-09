/**
 * ui/cinema-biblioteca.js — o painel ao lado do player do "Assistir junto":
 * as fontes de quem hospeda (abas), a busca e a lista, com grupos que se
 * abrem (série → temporada → episódio, pasta → subpasta).
 *
 * Grupos e filmes aparecem como cartazes, em duas colunas (o painel é
 * estreito); episódios, como lista, com número e título.
 *
 * Cada pessoa navega a biblioteca sozinha; só ESCOLHER um vídeo vai para a
 * sala (features/cinema.js). Por isso nada daqui entra no estado compartilhado.
 */
import { el, icon } from "../lib/dom.js";
import { campo, mmss, sincronizar } from "./jogos-comum.js";

export class PainelBiblioteca {
  #l;
  #aoMudar;
  #fonte = "";
  /** Grupos abertos, do começo da fonte até aqui: [{ id, nome }]. */
  #pilha = [];
  #busca = "";
  #itens = [];
  #carregando = false;
  #erro = "";
  #pedido = 0;
  #espera = 0;
  #p = {};

  /**
   * @param {import("../features/cinema.js").Cinema} logica
   * @param {() => void} aoMudar pede um redesenho da tela
   */
  constructor(logica, aoMudar) {
    this.#l = logica;
    this.#aoMudar = aoMudar;
    const busca = campo({ placeholder: "Buscar", rotulo: "Buscar vídeos", max: 80, limpar: false, aoEnviar: (t) => this.#buscar(t) });
    busca.addEventListener("input", () => {
      clearTimeout(this.#espera);
      this.#espera = setTimeout(() => this.#buscar(busca.value), 350);
    });
    const abas = el("div.cinema__fontes", { role: "tablist", "aria-label": "De onde vêm os vídeos" });
    const trilha = el("nav.cinema__trilha", { "aria-label": "Onde você está na biblioteca" });
    const lista = el("ul.cinema__lista", { "aria-label": "Vídeos" });
    this.raiz = el("aside.cinema__lado", { "aria-label": "Biblioteca de quem hospeda" }, [
      el("h3.jogos__titulo", { text: "Biblioteca" }),
      abas,
      el("div.cinema__busca", {}, [icon("search", { size: "sm" }), busca]),
      trilha,
      lista,
    ]);
    this.#p = { busca, abas, trilha, lista };
  }

  destruir() {
    clearTimeout(this.#espera);
    this.#pedido += 1;
  }

  /** Primeira carga: pede a ficha (que traz as fontes) e abre a primeira. */
  async comecar() {
    try {
      await this.#l.ficha();
    } catch (err) {
      this.#erro = err.message || "Não deu para abrir a biblioteca.";
      this.#aoMudar();
      return;
    }
    const fontes = this.#l.fontes;
    if (!fontes.length) return this.#aoMudar();
    const daSala = this.#l.item()?.fonte;
    this.#abrirFonte(fontes.some((f) => f.id === daSala) ? daSala : fontes[0].id);
  }

  desenhar(item) {
    this.#desenharAbas();
    this.#desenharTrilha();
    this.#desenharLista(item);
  }

  /* ----------------------------- navegação ----------------------------- */

  #abrirFonte(id) {
    this.#fonte = id;
    this.#pilha = [];
    this.#busca = "";
    this.#p.busca.value = "";
    this.#carregar();
  }

  #abrirGrupo(grupo) {
    this.#pilha.push({ id: grupo.id, nome: grupo.nome });
    this.#busca = "";
    this.#p.busca.value = "";
    this.#carregar();
  }

  #voltarPara(nivel) {
    this.#pilha = this.#pilha.slice(0, nivel);
    this.#carregar();
  }

  #buscar(texto) {
    this.#busca = texto.trim();
    // Buscar procura na fonte inteira, não só no grupo aberto.
    if (this.#busca) this.#pilha = [];
    this.#carregar();
  }

  async #carregar() {
    const pedido = ++this.#pedido;
    this.#carregando = true;
    this.#erro = "";
    this.#aoMudar();
    let itens = [];
    let erro = "";
    try {
      itens = await this.#l.biblioteca({ fonte: this.#fonte, busca: this.#busca, pai: this.#pilha.at(-1)?.id || "" });
    } catch (err) {
      erro = err.message || "Não deu para abrir a biblioteca.";
    }
    if (pedido !== this.#pedido) return; // uma busca mais nova já passou na frente
    this.#itens = itens;
    this.#erro = erro;
    this.#carregando = false;
    this.#aoMudar();
  }

  /* ------------------------------ desenho ------------------------------ */

  #desenharAbas() {
    const fontes = this.#l.fontes;
    this.#p.abas.hidden = fontes.length < 2;
    sincronizar(
      this.#p.abas,
      fontes.map((f) => ({
        chave: f.id,
        sig: `${f.nome}|${f.id === this.#fonte}`,
        criar: () => el("button.btn.btn--ghost.jogos__chip", { type: "button", role: "tab", "aria-selected": String(f.id === this.#fonte), onClick: () => this.#abrirFonte(f.id) }, [el("span", { text: f.nome })]),
      })),
    );
  }

  #desenharTrilha() {
    const { trilha } = this.#p;
    trilha.hidden = !this.#pilha.length;
    const nivel = (i, nome) => ({
      chave: `n${i}`,
      sig: `${i}|${nome}|${this.#pilha.length}`,
      criar: () =>
        i === this.#pilha.length
          ? el("span.truncate", { "aria-current": "page", text: nome })
          : el("button.cinema__migalha", { type: "button", onClick: () => this.#voltarPara(i) }, [i === 0 ? icon("chevron-left", { size: "sm" }) : null, el("span.truncate", { text: nome })]),
    });
    sincronizar(trilha, [nivel(0, "Início"), ...this.#pilha.map((g, i) => nivel(i + 1, g.nome))]);
  }

  #desenharLista(item) {
    const { lista } = this.#p;
    const texto = this.#erro || (this.#carregando && !this.#itens.length ? "Abrindo a biblioteca…" : !this.#carregando && !this.#itens.length ? "Nada por aqui." : "");
    if (texto) {
      sincronizar(lista, [{ chave: "nada", sig: texto, criar: () => el("li.cinema__nada.muted", { text: texto }) }]);
      return;
    }
    const atual = (i) => i.tipo === "video" && i.fonte === item?.fonte && i.id === item?.id;
    // Episódio (vídeo que sabe a temporada dele) vai em lista; o resto, em cartaz.
    const episodio = (i) => i.tipo === "video" && Boolean(i.pai);
    sincronizar(
      lista,
      this.#itens.map((i) => {
        const capa = i.imagem ? this.#l.enderecoDaImagem(i) : "";
        return {
          chave: `${i.tipo}:${i.id}`,
          sig: `${i.id}|${i.nome}|${atual(i)}|${capa}`,
          criar: () => {
            const abrir = () => (i.tipo === "grupo" ? this.#abrirGrupo(i) : this.#l.escolher(i));
            if (episodio(i)) {
              return el("li.cinema__linha", {}, [
                el("button.cinema__item", { type: "button", "aria-current": atual(i) ? "true" : null, onClick: abrir }, [
                  icon(atual(i) ? "play" : "clapperboard", { size: "sm" }),
                  el("span.truncate", { text: i.nome }),
                  el("span.muted", { text: i.segundos ? mmss(i.segundos) : "" }),
                ]),
              ]);
            }
            return el("li.cinema__cartaz", {}, [
              el("button.cinema__cartaz-btn", { type: "button", title: i.nome, "aria-current": atual(i) ? "true" : null, onClick: abrir }, [
                el("span.cinema__capa-mini", {}, [capa ? el("img", { src: capa, alt: "", loading: "lazy", decoding: "async" }) : icon(i.tipo === "grupo" ? "folder" : "clapperboard")]),
                el("span.cinema__cartaz-nome", { text: i.nome }),
              ]),
            ]);
          },
        };
      }),
    );
  }
}
