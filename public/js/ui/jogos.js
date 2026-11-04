/**
 * ui/jogos.js — a mesa de jogos: o menu com todos os jogos (por prateleira)
 * e os jogos de equipe (Planning Poker, Retrospectiva e Daily). Os de festa
 * e de tabuleiro têm a tela deles em ui/festa.js e ui/tabuleiro.js; esta
 * classe é a moldura que os mostra.
 *
 * Ocupa o lugar do destaque (como o quadro branco): os vídeos continuam na
 * faixa ao lado. A lógica e o estado compartilhado ficam em
 * features/jogos.js; aqui é só desenho.
 *
 * Leve de propósito:
 *   - redesenha no máximo uma vez por quadro de animação, e só o que mudou:
 *     cada assento, nota, história e ação tem uma assinatura, e um nó só é
 *     refeito quando a dele muda (`sincronizar`). Assim a carta não vira de
 *     novo, a nota não "entra" de novo e o foco do teclado não se perde
 *     quando outra pessoa vota;
 *   - os campos de texto são criados uma vez e nunca perdem o foco nem o
 *     que a pessoa está digitando;
 *   - um único relógio de 250 ms, ligado só enquanto há contagem, cronômetro
 *     ou Daily em andamento;
 *   - nada de canvas nem biblioteca: elementos simples, animações em CSS.
 */
import { el, icon } from "../lib/dom.js";
import { avatarEl } from "./avatars.js";
import {
  BARALHOS,
  CATEGORIAS,
  FASES_RETRO,
  JOGOS,
  MODELOS_RETRO,
  daily,
  detalhesHistoria,
  historiaAtual,
  historias,
  mesaPoker,
  retro,
} from "../features/jogos.js";
import { confete, mmss, porChave, selo, sincronizar } from "./jogos-comum.js";
import { VISTAS_FESTA } from "./festa.js";
import { VISTAS_TABULEIRO } from "./tabuleiro.js";
import { abrirGithub } from "./github.js";

/** Telas dos jogos que não são de equipe: id -> classe (ui/festa.js, ui/tabuleiro.js). */
const VISTAS = { ...VISTAS_FESTA, ...VISTAS_TABULEIRO };
/** O selo de quantas pessoas, no menu. */
const QUANTOS = { "1+": "dá para jogar sozinho", "1–2": "sozinho ou em dupla" };

/** O que dá para jogar num colega na mesa do Poker (ícones do app). */
const JOGAVEIS = { "thumbs-up": "Joinha", heart: "Coração", "party-popper": "Festa", laugh: "Risada", coffee: "Café", flame: "Fogo" };

/** A carta como aparece: o café é ícone; o resto, o número ou o tamanho. */
const rotuloCarta = (c) => (c === "☕" ? icon("coffee", { label: "Café (pausa)" }) : el("span", { text: c ?? "" }));
const FASE_NOME = { escrever: "Escrever", votar: "Votar", discutir: "Discutir" };

export class PainelJogos {
  aberto = false;
  jogo = "hub";
  #raiz = null;
  #corpo = null;
  #partes = {};
  /** A tela do jogo de festa ou de tabuleiro aberto (ui/festa.js, ui/tabuleiro.js). */
  #vista = null;
  #pedido = 0;
  #relogio = 0;
  #festejado = "";
  #avisadoTimer = 0;
  /** A aba aberta nos detalhes da US em votação: { hid, id }. */
  #aba = null;

  /**
   * @param {object} o
   * @param {import("../features/jogos.js").EstadoJogos} o.estado
   * @param {import("../features/jogos.js").Poker} o.poker
   * @param {import("../features/jogos.js").Retro} o.retro
   * @param {import("../features/jogos.js").Daily} o.daily
   * @param {() => {id:string, nome:string, avatar:any, eu:boolean}[]} o.pessoas
   * @param {(para:string, emoji:string) => void} o.aoEmoji
   * @param {() => void} o.aoFechar
   * @param {(texto:string, nome:string, tipo:string) => void} o.baixar
   * @param {(texto:string, aviso:string) => void} o.copiar
   * @param {(texto:string, tom?:string) => void} o.avisar
   * @param {Record<string, object>} o.logicas a lógica de cada jogo (features/festa.js, features/tabuleiro.js)
   * @param {(id:string) => void} o.aoEscolher alguém escolheu um jogo no menu
   * @param {(pessoa:string) => MediaStream|null} o.videoDe a câmera de alguém (Mímica, Quem sou eu?)
   */
  constructor(o) {
    this.o = o;
    o.estado.on("mudou", () => this.atualizar());
  }

  /* ---------------------------------------------------------------- */

  montar(container, jogo = this.jogo) {
    if (!this.#raiz) this.#raiz = this.#esqueleto();
    container.append(this.#raiz);
    this.aberto = true;
    this.mostrar(jogo);
  }

  desmontar() {
    this.aberto = false;
    this.#vista?.destruir?.();
    this.#vista = null;
    this.#raiz?.remove();
    clearInterval(this.#relogio);
    this.#relogio = 0;
  }

  /** Mostra um jogo (ou "hub", o menu de jogos). Só aqui: não avisa ninguém. */
  mostrar(jogo) {
    this.jogo = JOGOS[jogo] ? jogo : "hub";
    this.#vista?.destruir?.();
    this.#vista = null;
    this.#corpo.replaceChildren();
    this.#partes.extra.replaceChildren();
    // As partes de cada jogo de equipe começam do zero a cada troca.
    this.#partes = { voltar: this.#partes.voltar, titulo: this.#partes.titulo, extra: this.#partes.extra };
    const j = JOGOS[this.jogo];
    this.#partes.voltar.hidden = this.jogo === "hub";
    this.#partes.titulo.replaceChildren(
      ...(j ? [icon(j.icone), el("span.truncate", { text: j.nome })] : [icon("dices"), el("span", { text: "Jogos" })]),
    );
    this.#raiz.dataset.jogo = this.jogo;
    if (this.jogo === "hub") this.#montarHub();
    else if (this.jogo === "poker") this.#montarPoker();
    else if (this.jogo === "retro") this.#montarRetro();
    else if (this.jogo === "daily") this.#montarDaily();
    else {
      const Vista = VISTAS[this.jogo];
      this.#vista = new Vista({
        logica: this.o.logicas?.[this.jogo],
        estado: this.o.estado,
        corpo: this.#corpo,
        extra: this.#partes.extra,
        raiz: this.#raiz,
        pessoas: () => this.#pessoas(),
        avisar: (texto, tom) => this.o.avisar(texto, tom),
        confete: () => confete(this.#raiz),
        videoDe: (id) => this.o.videoDe?.(id) || null,
        pedir: () => this.atualizar(),
        // O celular com o QuizzV (features/quizzv.js), para o Quiz.
        quizzv: this.o.quizzv || null,
      });
      this.#vista.montar();
    }
    this.atualizar();
  }

  atualizar() {
    if (!this.aberto || this.#pedido) return;
    this.#pedido = requestAnimationFrame(() => {
      this.#pedido = 0;
      if (!this.aberto) return;
      if (this.jogo === "hub") this.#desenharHub();
      else if (this.jogo === "poker") this.#desenharPoker();
      else if (this.jogo === "retro") this.#desenharRetro();
      else if (this.jogo === "daily") this.#desenharDaily();
      else this.#vista?.desenhar();
      this.#ajustarRelogio();
    });
  }

  /** Relógio só quando há o que contar: contagem, cronômetro, Daily, ou o jogo pede. */
  #ajustarRelogio() {
    const e = this.o.estado;
    const timer = e.ler("p/timer");
    const precisa =
      (this.jogo === "poker" && (this.#partes.contando || (timer && timer.fim > Date.now() - 2000))) ||
      (this.jogo === "daily" && daily(e).atual) ||
      !!this.#vista?.relogio?.();
    if (precisa && !this.#relogio) this.#relogio = setInterval(() => this.#tique(), 250);
    else if (!precisa && this.#relogio) {
      clearInterval(this.#relogio);
      this.#relogio = 0;
    }
  }

  #tique() {
    if (this.jogo === "daily") this.#desenharDaily();
    else if (this.jogo === "poker") this.#desenharPoker({ soTempo: true });
    else if (this.#vista) {
      this.#vista.tique?.();
      this.#ajustarRelogio();
    }
  }

  /* ---------------------------------------------------------------- *
   * Moldura comum
   * ---------------------------------------------------------------- */

  #esqueleto() {
    const voltar = el("button.btn.btn--ghost.jogos__voltar", { type: "button", "aria-label": "Todos os jogos", dataset: { tip: "Todos os jogos", "tip-placement": "bottom" }, onClick: () => this.mostrar("hub") }, [
      icon("layout-grid", { size: "sm" }),
      el("span", { text: "Jogos" }),
    ]);
    const titulo = el("h2.jogos__nome");
    const extra = el("div.jogos__extra");
    const fechar = el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": "Fechar os jogos", dataset: { tip: "Fechar (os outros continuam)", "tip-placement": "bottom", "tip-align": "end" }, onClick: () => this.o.aoFechar() }, [icon("x", { size: "sm" })]);
    this.#corpo = el("div.jogos__corpo");
    this.#partes = { voltar, titulo, extra };
    return el("section.jogos", { "aria-label": "Jogos" }, [el("header.jogos__topo", {}, [voltar, titulo, extra, fechar]), this.#corpo]);
  }

  /* ---------------------------------------------------------------- *
   * O menu de jogos: uma prateleira por categoria
   * ---------------------------------------------------------------- */

  #montarHub() {
    const prateleiras = Object.entries(CATEGORIAS).map(([cat, c]) => {
      const grade = el("div.hub__grade");
      for (const [id, j] of Object.entries(JOGOS)) {
        if (j.cat !== cat) continue;
        const cartao = el("button.hub__jogo", { type: "button", dataset: { id }, "aria-label": `${j.nome}: ${j.desc}` }, [
          selo(j.icone, "hub__selo"),
          el("span.hub__texto", {}, [el("strong", { text: j.nome }), el("span.hub__desc", { text: j.desc })]),
          el("span.hub__chips", {}, [el("span.hub__chip", { text: QUANTOS[j.pessoas] || `${j.pessoas} pessoas` }), el("span.hub__agora", { text: "em andamento" })]),
        ]);
        cartao.addEventListener("click", () => (this.o.aoEscolher ? this.o.aoEscolher(id) : this.mostrar(id)));
        grade.append(cartao);
      }
      return el("section.hub__prateleira", { "aria-label": c.nome, dataset: { cat } }, [el("header.hub__cabeca", {}, [el("h3", { text: c.nome }), el("span.muted", { text: c.desc })]), grade]);
    });
    this.#corpo.append(el("div.hub", {}, [el("p.hub__intro", { text: "Escolha um jogo: todo mundo na chamada recebe o convite para participar." }), ...prateleiras]));
  }

  #desenharHub() {
    const atual = this.o.estado.ler("jogo");
    for (const b of this.#corpo.querySelectorAll(".hub__jogo")) b.classList.toggle("is-agora", b.dataset.id === atual);
  }

  #pessoas() {
    return this.o.pessoas();
  }

  /* ---------------------------------------------------------------- *
   * Planning Poker
   * ---------------------------------------------------------------- */

  #montarPoker() {
    const { poker, estado } = this.o;
    const p = this.#partes;

    // Controles do topo
    const baralho = el("select.input.jogos__select", { "aria-label": "Baralho" });
    for (const [id, b] of Object.entries(BARALHOS)) baralho.append(el("option", { value: id, text: b.nome }));
    baralho.addEventListener("change", () => poker.definirBaralho(baralho.value));
    const auto = el("button.btn.btn--ghost.jogos__chip", { type: "button", "aria-pressed": "false", dataset: { tip: "Revela sozinho quando todo mundo votar", "tip-placement": "bottom" }, onClick: () => estado.definir([["p/auto", !estado.ler("p/auto", false)]]) }, [icon("zap", { size: "sm" }), el("span", { text: "Auto" })]);
    const assistir = el("button.btn.btn--ghost.jogos__chip", { type: "button", "aria-pressed": "false", dataset: { tip: "Só assistir: você não conta na votação", "tip-placement": "bottom" }, onClick: () => poker.espectador(!estado.ler(`p/esp/${estado.eu}`, false)) }, [icon("eye", { size: "sm" }), el("span", { text: "Assistir" })]);
    const timerTxt = el("span", { text: "Cronômetro" });
    const timer = el("button.btn.btn--ghost.jogos__chip", { type: "button", dataset: { tip: "Tempo de discussão para todos", "tip-placement": "bottom" }, onClick: () => this.#menuTimer(timer) }, [icon("timer", { size: "sm" }), timerTxt]);
    p.extra.append(baralho, auto, assistir, timer);

    // Mesa
    const topo = el("div.poker__fila");
    const base = el("div.poker__fila");
    const centro = el("div.poker__centro");
    const mesa = el("div.poker__mesa", {}, [centro]);
    const mao = el("div.poker__mao", { role: "radiogroup", "aria-label": "Suas cartas" });
    const historia = el("div.poker__historia");

    // Histórias
    const listaH = el("ol.poker__historias");
    const novas = el("textarea.input.poker__nova", { rows: 2, placeholder: "Nova história (uma por linha)", "aria-label": "Novas histórias", maxLength: 4000 });
    const adicionar = () => {
      const linhas = novas.value.split(/\r?\n/);
      if (!linhas.some((l) => l.trim())) return;
      poker.adicionarHistorias(linhas);
      novas.value = "";
    };
    novas.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        adicionar();
      }
      e.stopPropagation(); // atalhos da chamada não valem aqui
    });
    const lado = el("aside.poker__lado", { "aria-label": "Histórias" }, [
      el("h3.jogos__titulo", { text: "Histórias" }),
      listaH,
      el("div.poker__add.poker__add--pilha", {}, [novas, el("button.btn.btn--primary", { type: "button", onClick: adicionar }, [icon("plus", { size: "sm" }), el("span", { text: "Adicionar" })])]),
      el("div.jogos__rodape", {}, [
        this.o.github?.disponivel
          ? el("button.btn.btn--ghost", { type: "button", dataset: { tip: "Trazer US do GitHub Projects, com subtarefas" }, onClick: () => abrirGithub(this.o.github, { avisar: this.o.avisar }) }, [icon("link", { size: "sm" }), el("span", { text: "GitHub" })])
          : null,
        el("button.btn.btn--ghost", { type: "button", onClick: () => this.o.baixar(this.#csv(), "estimativas.csv", "text/csv") }, [icon("download", { size: "sm" }), el("span", { text: "CSV" })]),
        el("button.btn.btn--ghost", { type: "button", onClick: () => this.o.copiar(this.#textoHistorias(), "Estimativas copiadas") }, [icon("copy", { size: "sm" }), el("span", { text: "Copiar" })]),
      ]),
    ]);

    this.#corpo.append(el("div.poker", {}, [el("div.poker__palco", {}, [historia, topo, mesa, base, mao]), lado]));
    Object.assign(p, { baralho, auto, assistir, timer, timerTxt, topo, base, centro, mao, historia, listaH, maoChave: "" });
  }

  #csv() {
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    return ["Historia;Estimativa", ...historias(this.o.estado).map((h) => `${esc(h.titulo)};${esc(h.estimativa ?? "")}`)].join("\r\n");
  }

  #textoHistorias() {
    return historias(this.o.estado)
      .map((h) => `${h.titulo}: ${h.estimativa ?? "—"}`)
      .join("\n");
  }

  #menuTimer(ancora) {
    const { estado } = this.o;
    const ativo = estado.ler("p/timer");
    const menu = el("div.jogos__menu", { role: "menu" });
    const fechar = () => menu.remove();
    for (const min of [1, 2, 3, 5]) {
      menu.append(el("button", { type: "button", role: "menuitem", text: `${min} min`, onClick: () => (estado.definir([["p/timer", { fim: Date.now() + min * 60_000, min }]]), fechar()) }));
    }
    if (ativo && ativo.fim > Date.now()) menu.append(el("button", { type: "button", role: "menuitem", text: "Parar", onClick: () => (estado.definir([["p/timer", null]]), fechar()) }));
    ancora.after(menu);
    setTimeout(() => document.addEventListener("pointerdown", (e) => !menu.contains(e.target) && fechar(), { once: true }), 0);
  }

  #desenharPoker({ soTempo = false } = {}) {
    const { estado, poker } = this.o;
    const p = this.#partes;
    if (!p.centro) return;
    const v = mesaPoker(estado, { pessoas: this.#pessoas(), meuVoto: poker.meuVoto() });

    // Cronômetro de discussão
    const t = estado.ler("p/timer");
    if (t && t.fim) {
      const resta = (t.fim - Date.now()) / 1000;
      p.timerTxt.textContent = resta > 0 ? mmss(resta) : "Tempo!";
      p.timer.classList.toggle("is-acabou", resta <= 0);
      if (resta <= 0 && this.#avisadoTimer !== t.fim) {
        this.#avisadoTimer = t.fim;
        this.o.avisar("Acabou o tempo de discussão", "warn");
      }
    } else {
      p.timerTxt.textContent = "Cronômetro";
      p.timer.classList.remove("is-acabou");
    }
    p.contando = v.contagem != null;
    if (soTempo && !p.contando && !p.esperandoRevelar) return;
    p.esperandoRevelar = p.contando;

    p.baralho.value = v.baralhoId;
    p.auto.setAttribute("aria-pressed", String(!!estado.ler("p/auto", false)));
    const souEspectador = !!estado.ler(`p/esp/${estado.eu}`, false);
    p.assistir.setAttribute("aria-pressed", String(souEspectador));

    // História em votação
    const lista = historias(estado);
    const atual = lista.find((h) => h.id === v.historia);
    const det = atual ? detalhesHistoria(estado, atual.id) : null;
    sincronizar(p.historia, [
      {
        chave: "h",
        sig: atual ? JSON.stringify([atual.id, atual.titulo, atual.gh, det]) : "livre",
        criar: () =>
          atual
            ? el("div.poker__historiaTxt", {}, [
                el("span.jogos__rotulo", { text: "Votando" }),
                el("strong", { text: atual.titulo }),
                atual.gh?.url ? el("a.poker__card", { href: atual.gh.url, target: "_blank", rel: "noopener noreferrer", text: atual.gh.numero ? `#${atual.gh.numero} · abrir no GitHub` : "Abrir no GitHub" }) : null,
                det.vazio ? null : this.#detalhes(atual.id, det),
              ])
            : el("div.poker__historiaTxt", {}, [el("span.jogos__rotulo", { text: "Votação livre" }), el("span.muted", { text: "Adicione histórias ao lado para estimar uma de cada vez." })]),
      },
    ]);

    // Assentos: metade em cima, metade embaixo da mesa. Um assento só é
    // refeito quando muda o que ele mostra.
    const pessoas = this.#pessoas();
    const assentos = v.jogadores.map((j) => this.#assento(j, v, pessoas));
    const antigos = porChave(p.topo, p.base);
    sincronizar(p.topo, assentos.filter((_, i) => i % 2 === 0), antigos);
    sincronizar(p.base, assentos.filter((_, i) => i % 2 === 1), antigos);

    // Centro da mesa (refeito só quando muda: o botão não perde o foco)
    const votos = v.jogadores.filter((j) => j.votou).length;
    const chaveCentro = JSON.stringify([v.contagem, v.revelado && v.resultado, votos, v.faltam, souEspectador]);
    if (chaveCentro !== p.centroChave) {
      p.centroChave = chaveCentro;
      p.centro.replaceChildren(...this.#centro(v, votos, souEspectador));
    }
    if (v.revelado && v.resultado?.consenso && this.#festejado !== `${v.historia}/${v.rodada}`) {
      this.#festejado = `${v.historia}/${v.rodada}`;
      this.#confete();
    }
    // Revelação automática: quem tem o menor id faz (os outros só veem).
    if (!v.revelado && v.contagem == null && v.todosVotaram && estado.ler("p/auto", false)) {
      const lider = v.jogadores.filter((j) => j.presente && !j.espectador).map((j) => j.id).sort()[0];
      if (lider === estado.eu) poker.revelar();
    }

    // A mão (ou, revelado, o gráfico e a estimativa a salvar)
    const meu = poker.meuVoto();
    const chaveMao = `${v.revelado}|${v.baralhoId}|${meu}|${souEspectador}|${v.historia}|${v.rodada}|${JSON.stringify(v.resultado?.distribuicao || [])}`;
    if (chaveMao !== p.maoChave) {
      p.maoChave = chaveMao;
      if (v.revelado) p.mao.replaceChildren(this.#grafico(v, atual));
      else if (souEspectador) p.mao.replaceChildren(el("p.poker__aviso", { text: "Você está só assistindo. Clique em “Assistir” para votar." }));
      else
        p.mao.replaceChildren(
          ...v.baralho.cartas.map((c) =>
            el(
              "button.carta.carta--mao",
              {
                type: "button",
                role: "radio",
                "aria-checked": String(meu === c),
                "aria-label": `Carta ${c}`,
                onClick: () => poker.votar(c),
              },
              [rotuloCarta(c)],
            ),
          ),
        );
    }

    // Lista de histórias
    sincronizar(
      p.listaH,
      lista.length
        ? lista.map((h) => ({
            chave: h.id,
            sig: JSON.stringify([h.titulo, h.estimativa, h.id === v.historia]),
            criar: () =>
              el("li.poker__item", { class: h.id === v.historia ? "is-atual" : "" }, [
                el("button.poker__itemBtn", { type: "button", "aria-label": `Votar: ${h.titulo}`, onClick: () => poker.escolherHistoria(h.id) }, [
                  el("span.truncate", { text: h.titulo }),
                  h.estimativa != null ? el("span.poker__estimativa", { text: h.estimativa }) : h.id === v.historia ? el("span.jogos__rotulo", { text: "votando" }) : null,
                ].filter(Boolean)),
                el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": `Apagar: ${h.titulo}`, onClick: () => poker.apagarHistoria(h.id) }, [icon("trash-2", { size: "sm" })]),
              ]),
          }))
        : [{ chave: "vazio", sig: "", criar: () => el("li.poker__vazio", { text: "Nenhuma história ainda." }) }],
    );
  }

  /**
   * Subtarefas, critérios de aceite e descrição da US em votação, em abas
   * que cada pessoa abre e fecha para si (vem do kanban do GitHub).
   */
  #detalhes(hid, det) {
    const abas = [];
    const { subtarefas: s, criterios: c } = det;
    const linha = (feito, filhos) => el("li", { class: feito ? "is-feito" : "" }, [icon(feito ? "check" : "circle", { size: "sm", label: feito ? "Feito" : "Aberto" }), ...filhos]);
    const resto = (n, oQue) => (n ? el("li.poker__mais", { text: `e mais ${n} ${oQue} no GitHub` }) : null);
    if (s.itens.length) {
      abas.push({
        id: "subtarefas",
        nome: "Subtarefas",
        conta: `${s.feitas}/${s.itens.length + s.mais}`,
        corpo: () =>
          el("ul.poker__check", {}, [
            ...s.itens.map((t) =>
              linha(t.feita, [
                t.url ? el("a.poker__num", { href: t.url, target: "_blank", rel: "noopener noreferrer", text: t.numero ? `#${t.numero}` : "abrir" }) : null,
                el("span", { text: t.titulo }),
              ]),
            ),
            resto(s.mais, "subtarefas"),
          ]),
      });
    }
    if (c.itens.length) {
      abas.push({
        id: "criterios",
        nome: c.nome,
        conta: `${c.itens.filter((x) => x.feito).length}/${c.itens.length + c.mais}`,
        corpo: () => el("ul.poker__check", {}, [...c.itens.map((x) => linha(x.feito, [el("span", { text: x.titulo })])), resto(c.mais, "itens")]),
      });
    }
    if (det.descricao) abas.push({ id: "descricao", nome: "Descrição", conta: "", corpo: () => el("p.poker__desc", { text: det.descricao }) });

    // As contagens ficam sempre à vista; o conteúdo abre por cima da mesa (sem empurrar as cartas) e fecha ao clicar fora.
    if (this.#aba?.hid !== hid) this.#aba = { hid, id: null };
    const painel = el("div.poker__painel", { role: "tabpanel" });
    const botoes = el("div.poker__abas", { role: "tablist", "aria-label": "Detalhes da US" });
    const caixa = el("div.poker__detalhes", {}, [botoes, painel]);
    const foraFecha = (e) => {
      if (!caixa.isConnected || !this.#aba.id) return;
      if (caixa.contains(e.target)) return void document.addEventListener("pointerdown", foraFecha, { once: true });
      this.#aba.id = null;
      mostrar();
    };
    const mostrar = () => {
      const aberta = abas.find((a) => a.id === this.#aba.id);
      for (const b of botoes.children) b.setAttribute("aria-selected", String(b.dataset.id === this.#aba.id));
      painel.hidden = !aberta;
      painel.replaceChildren(aberta ? aberta.corpo() : "");
      if (aberta) setTimeout(() => document.addEventListener("pointerdown", foraFecha, { once: true }), 0);
    };
    for (const a of abas) {
      botoes.append(
        el("button.poker__aba", { type: "button", role: "tab", dataset: { id: a.id }, onClick: () => ((this.#aba.id = this.#aba.id === a.id ? null : a.id), mostrar()) }, [
          el("span", { text: a.nome }),
          a.conta ? el("span.poker__abaConta", { text: a.conta }) : null,
        ]),
      );
    }
    mostrar();
    return caixa;
  }

  #centro(v, votos, souEspectador) {
    const { poker } = this.o;
    if (v.contagem != null) return [el("div.poker__contagem", { text: String(v.contagem), "aria-live": "assertive" })];
    if (v.revelado) {
      const r = v.resultado;
      return [
        el("div.poker__resumo", {}, [
          r.media != null ? el("div", {}, [el("span.jogos__rotulo", { text: "Média" }), el("strong", { text: String(r.media).replace(".", ",") })]) : null,
          r.mediana != null ? el("div", {}, [el("span.jogos__rotulo", { text: "Mediana" }), el("strong", { text: String(r.mediana).replace(".", ",") })]) : null,
          el("div", {}, [el("span.jogos__rotulo", { text: "Concordância" }), el("strong", { text: `${r.concordancia}%` })]),
        ].filter(Boolean)),
        el("button.btn.btn--primary", { type: "button", onClick: () => poker.novaRodada() }, [icon("rotate-ccw", { size: "sm" }), el("span", { text: "Nova votação" })]),
      ];
    }
    if (!votos) return [el("p.poker__aviso", { text: souEspectador ? "Assistindo. Esperando os votos…" : "Escolham suas cartas abaixo" })];
    return [
      el("button.btn.btn--primary.btn--lg.poker__revelar", { type: "button", onClick: () => poker.revelar() }, [el("span", { text: "Revelar cartas" })]),
      el("p.poker__aviso", { text: v.faltam ? `${votos} votaram · faltam ${v.faltam}` : "Todo mundo votou" }),
    ];
  }

  /** Um assento da mesa, como item de `sincronizar`. */
  #assento(j, v, pessoas) {
    const pessoa = pessoas.find((x) => x.id === j.id);
    const estadoCarta = v.revelado && j.valor != null ? "revelada" : j.votou ? "virada" : "vazia";
    let extremo = false;
    if (v.revelado && v.resultado && j.valor != null) {
      const n = j.valor === "½" ? 0.5 : Number(j.valor);
      extremo = v.resultado.menor !== v.resultado.maior && (n === v.resultado.menor || n === v.resultado.maior);
    }
    return {
      chave: j.id,
      sig: JSON.stringify([estadoCarta, estadoCarta === "revelada" ? j.valor : "", extremo, j.nome, j.eu, j.presente, j.espectador, pessoa?.avatar || null]),
      criar: () => this.#criarAssento(j, pessoa, estadoCarta, extremo, v),
    };
  }

  #criarAssento(j, pessoa, estadoCarta, extremo, v) {
    const carta = el(`div.carta.carta--${estadoCarta}`, { "aria-hidden": "true" }, [estadoCarta === "revelada" ? rotuloCarta(j.valor) : el("span")]);
    if (extremo) carta.classList.add("is-extremo");
    const filhos = [
      carta,
      el("div.assento__quem", {}, [
        pessoa?.avatar ? avatarEl(pessoa.avatar, { title: j.nome }) : null,
        el("span.truncate", { text: j.nome }),
        j.espectador ? icon("eye", { size: "sm", label: "Assistindo" }) : null,
      ].filter(Boolean)),
    ];
    if (j.eu) filhos.push(el("span.assento__voce", { text: "você" }));
    if (!j.eu && j.presente) {
      filhos.push(
        el("button.assento__emoji", { type: "button", "aria-label": `Jogar algo em ${j.nome}`, dataset: { tip: "Jogar algo" }, onClick: (e) => this.#menuEmoji(e.currentTarget, j.id) }, [icon("smile", { size: "sm" })]),
      );
    }
    const label = j.espectador ? `${j.nome}: assistindo` : v.revelado ? `${j.nome}: ${j.valor ?? "sem voto"}` : `${j.nome}: ${j.votou ? "votou" : "ainda não votou"}`;
    return el("div.assento", { dataset: { id: j.id }, class: `${j.presente ? "" : "is-saiu"} ${j.espectador ? "is-espectador" : ""} ${j.eu ? "is-eu" : ""}`, role: "group", "aria-label": label }, filhos);
  }

  #menuEmoji(ancora, para) {
    const menu = el("div.jogos__menu.jogos__menu--emoji", { role: "menu" });
    for (const [e, nome] of Object.entries(JOGAVEIS)) menu.append(el("button", { type: "button", role: "menuitem", "aria-label": nome, onClick: () => (this.o.aoEmoji(para, e), menu.remove()) }, [icon(e)]));
    ancora.after(menu);
    setTimeout(() => document.addEventListener("pointerdown", (ev) => !menu.contains(ev.target) && menu.remove(), { once: true }), 0);
  }

  /** Um emoji atravessa a mesa de quem jogou até o alvo. */
  voarEmoji(de, para, emoji) {
    if (!this.aberto || this.jogo !== "poker" || !Object.hasOwn(JOGAVEIS, emoji)) return;
    const alvo = this.#raiz.querySelector(`.assento[data-id="${CSS.escape(para)}"] .carta`);
    if (!alvo) return;
    const origem = this.#raiz.querySelector(`.assento[data-id="${CSS.escape(de)}"] .carta`) || this.#partes.centro;
    const a = origem.getBoundingClientRect();
    const b = alvo.getBoundingClientRect();
    const voo = el("span.emoji-voo", { "aria-hidden": "true" }, [icon(emoji)]);
    voo.style.left = `${a.left + a.width / 2}px`;
    voo.style.top = `${a.top + a.height / 2}px`;
    voo.style.setProperty("--dx", `${b.left - a.left + (b.width - a.width) / 2}px`);
    voo.style.setProperty("--dy", `${b.top - a.top + (b.height - a.height) / 2}px`);
    document.body.append(voo);
    voo.addEventListener("animationend", () => voo.remove(), { once: true });
    setTimeout(() => voo.remove(), 1500);
    alvo.classList.remove("is-atingida");
    void alvo.offsetWidth;
    alvo.classList.add("is-atingida");
  }

  #grafico(v, atual) {
    const r = v.resultado;
    const maximo = Math.max(1, ...r.distribuicao.map((d) => d.n));
    const barras = el(
      "div.poker__barras",
      { role: "img", "aria-label": r.distribuicao.map((d) => `${d.carta}: ${d.n}`).join(", ") },
      r.distribuicao.map((d) =>
        el("div.poker__barra", { class: d.carta === r.maioria ? "is-maioria" : "" }, [
          el("span.poker__barraN", { text: `${d.n} ${d.n === 1 ? "voto" : "votos"}` }),
          el("div.poker__barraCol", { style: { "--h": `${Math.max(4, Math.round((d.n / maximo) * 56))}px` } }),
          el("div.carta.carta--mini", {}, [rotuloCarta(d.carta)]),
        ]),
      ),
    );
    if (!r.total) return el("p.poker__aviso", { text: "Ninguém votou nesta rodada." });
    const filhos = [barras];
    if (atual) {
      const chips = el("div.poker__salvar", {}, [el("span.jogos__rotulo", { text: "Estimativa de" }), el("strong.truncate", { text: atual.titulo })]);
      const opcoes = [...new Set([r.sugestao, r.maioria, ...r.distribuicao.map((d) => d.carta)].filter((c) => c && c !== "?" && c !== "☕"))];
      for (const c of opcoes) {
        chips.append(
          el("button.btn.jogos__chip", { type: "button", class: c === r.sugestao ? "is-sugestao" : "", "aria-label": `Salvar ${c} como estimativa`, dataset: c === r.sugestao ? { tip: "Sugestão: a carta mais perto da média" } : {}, onClick: () => this.o.poker.salvarEstimativa(atual.id, c) }, [rotuloCarta(c)]),
        );
      }
      filhos.push(chips);
    }
    return el("div.poker__resultado", {}, filhos);
  }

  /** Comemoração do consenso: algumas dezenas de pedacinhos em CSS, e somem. */
  #confete() {
    confete(this.#raiz);
    this.o.avisar("Consenso!", "ok");
  }

  /* ---------------------------------------------------------------- *
   * Retrospectiva
   * ---------------------------------------------------------------- */

  #montarRetro() {
    const { estado, retro: rt } = this.o;
    const p = this.#partes;
    const modelo = el("select.input.jogos__select", { "aria-label": "Modelo" });
    for (const [id, m] of Object.entries(MODELOS_RETRO)) modelo.append(el("option", { value: id, text: m.nome }));
    modelo.addEventListener("change", () => rt.modelo(modelo.value));
    const fases = el("div.retro__fases", { role: "tablist", "aria-label": "Fase" });
    const botoesFase = {};
    FASES_RETRO.forEach((f, i) => {
      botoesFase[f] = el("button.retro__fase", { type: "button", role: "tab", onClick: () => rt.fase(f) }, [el("b", { text: String(i + 1) }), el("span", { text: FASE_NOME[f] })]);
      fases.append(botoesFase[f]);
    });
    const pontos = el("span.retro__pontos", { "aria-live": "polite" });
    const exportar = el("button.btn.btn--ghost.jogos__chip", { type: "button", onClick: () => this.o.copiar(this.#retroMd(), "Retrospectiva copiada (Markdown)") }, [icon("copy", { size: "sm" }), el("span", { text: "Copiar" })]);
    const baixar = el("button.btn.btn--ghost.jogos__chip", { type: "button", onClick: () => this.o.baixar(this.#retroMd(), "retrospectiva.md", "text/markdown") }, [icon("download", { size: "sm" }), el("span", { text: ".md" })]);
    p.extra.append(modelo, fases, exportar, baixar);

    const colunas = el("div.retro__colunas");
    const acoesLista = el("ul.retro__acoes");
    const acaoTxt = el("input.input", { type: "text", placeholder: "Nova ação (quem faz o quê)", "aria-label": "Nova ação", maxLength: 300 });
    const addAcao = () => {
      if (!acaoTxt.value.trim()) return;
      rt.adicionarAcao(acaoTxt.value);
      acaoTxt.value = "";
    };
    acaoTxt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addAcao();
      e.stopPropagation();
    });
    const acoes = el("section.retro__plano", { "aria-label": "Plano de ação" }, [
      el("h3.jogos__titulo", {}, [icon("list-checks", { size: "sm" }), el("span", { text: "Plano de ação" })]),
      acoesLista,
      el("div.poker__add", {}, [acaoTxt, el("button.btn.btn--primary", { type: "button", onClick: addAcao }, [icon("plus", { size: "sm" })])]),
    ]);
    const quem = el("div.retro__quem");
    this.#corpo.append(el("div.retro", {}, [quem, colunas, acoes]));
    Object.assign(p, { modelo, botoesFase, pontos, colunas, acoesLista, acoes, quem, colunasDe: "", entradas: [] });
  }

  #retroMd() {
    const v = retro(this.o.estado);
    const linhas = [`# Retrospectiva — ${v.modelo.nome}`, ""];
    for (const c of v.colunas) {
      linhas.push(`## ${c.titulo}`, "");
      const notas = [...c.notas].sort((a, b) => b.votos - a.votos);
      for (const n of notas) linhas.push(`- ${n.texto ?? "(oculta)"}${n.votos ? ` — ${n.votos} voto(s)` : ""}`);
      if (!notas.length) linhas.push("- (nada)");
      linhas.push("");
    }
    linhas.push("## Ações", "");
    for (const a of v.acoes) linhas.push(`- [${a.feita ? "x" : " "}] ${a.texto}${a.dono ? ` (${a.dono})` : ""}`);
    if (!v.acoes.length) linhas.push("- (nenhuma)");
    return linhas.join("\n");
  }

  #desenharRetro() {
    const { estado, retro: rt } = this.o;
    const p = this.#partes;
    if (!p.colunas) return;
    const pessoas = this.#pessoas();
    const v = retro(estado, { pessoas });
    p.modelo.value = v.modeloId;
    p.modelo.disabled = v.fase !== "escrever";
    for (const [f, b] of Object.entries(p.botoesFase)) {
      b.setAttribute("aria-selected", String(f === v.fase));
      b.classList.toggle("is-feita", FASES_RETRO.indexOf(f) < FASES_RETRO.indexOf(v.fase));
    }
    const sobra = v.votosPorPessoa - v.meusVotosUsados;
    p.pontos.textContent = `${"●".repeat(sobra)}${"○".repeat(v.meusVotosUsados)}`;
    p.pontos.setAttribute("aria-label", `${sobra} de ${v.votosPorPessoa} pontos sobrando`);

    // Escrita: quem já escreveu (os textos estão escondidos). Votação: seus pontos.
    p.quem.replaceChildren(
      ...(v.fase === "escrever"
        ? [
            el("span.jogos__rotulo", { text: "Escrevendo (as notas aparecem para todos na fase de votar):" }),
            ...v.escreveram.map((x) => el("span.retro__pessoa", { class: x.notas ? "is-escreveu" : "" }, [el("span", { text: x.nome }), el("b", { text: String(x.notas) })])),
          ]
        : v.fase === "votar"
          ? [el("span.jogos__rotulo", { text: "Dê seus pontos às notas que mais importam:" }), p.pontos]
          : []),
    );

    // Colunas: o esqueleto (e os campos de texto) só muda com o modelo
    if (p.colunasDe !== v.modeloId) {
      p.colunasDe = v.modeloId;
      p.entradas = [];
      p.colunas.replaceChildren(
        ...v.colunas.map((c, i) => {
          const lista = el("div.coluna__notas");
          const txt = el("textarea.input.coluna__txt", { rows: 2, placeholder: "Escreva e tecle Enter", "aria-label": `Nova nota em ${c.titulo}`, maxLength: 500 });
          const add = () => {
            if (!txt.value.trim()) return;
            rt.adicionarNota(i, txt.value);
            txt.value = "";
          };
          txt.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              add();
            }
            e.stopPropagation();
          });
          p.entradas.push({ lista, titulo: el("h3.coluna__titulo", { text: c.titulo }) });
          return el("section.coluna", { dataset: { col: i } }, [p.entradas[i].titulo, lista, el("div.coluna__add", {}, [txt, el("button.btn.btn--icon.btn--primary", { type: "button", "aria-label": `Adicionar em ${c.titulo}`, onClick: add }, [icon("plus", { size: "sm" })])])]);
        }),
      );
    }
    v.colunas.forEach((c, i) => {
      const alvo = p.entradas[i];
      if (!alvo) return;
      alvo.titulo.textContent = `${c.titulo} · ${c.notas.length}`;
      sincronizar(alvo.lista, c.notas.map((n) => this.#nota(n, v)));
    });
    // Acabaram os pontos: os "+" apagam sem refazer as notas.
    const semPontos = v.meusVotosUsados >= v.votosPorPessoa;
    for (const b of p.colunas.querySelectorAll(".nota__mais")) b.disabled = semPontos;

    p.acoes.hidden = v.fase === "escrever";
    sincronizar(
      p.acoesLista,
      v.acoes.length
        ? v.acoes.map((a) => ({
            chave: a.id,
            sig: JSON.stringify([a.texto, a.feita]),
            criar: () =>
              el("li.retro__acao", { class: a.feita ? "is-feita" : "" }, [
                el("label", {}, [
                  el("input", { type: "checkbox", checked: a.feita, onChange: (e) => rt.marcarAcao(a.id, e.target.checked) }),
                  el("span", { text: a.texto }),
                ]),
                el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": `Apagar ação: ${a.texto}`, onClick: () => rt.apagarAcao(a.id) }, [icon("trash-2", { size: "sm" })]),
              ]),
          }))
        : [{ chave: "vazio", sig: "", criar: () => el("li.poker__vazio", { text: "Nenhuma ação combinada ainda." }) }],
    );
  }

  /** Uma nota da retrospectiva, como item de `sincronizar`. */
  #nota(n, v) {
    const { estado, retro: rt } = this.o;
    const minha = n.autor === estado.eu;
    const texto = n.texto ?? (minha ? rt.meus.get(n.id) : null);
    const meus = Number(estado.ler(`r/vt/${n.id}/${estado.eu}`, 0)) || 0;
    return {
      chave: n.id,
      sig: JSON.stringify([texto, n.nome, minha, v.fase, v.fase === "votar" ? meus : 0, v.fase === "discutir" ? n.votos : 0]),
      criar: () => this.#criarNota(n, v, minha, texto, meus),
    };
  }

  #criarNota(n, v, minha, texto, meus) {
    const { retro: rt } = this.o;
    const filhos = [texto != null ? el("p.nota__texto", { text: texto }) : el("p.nota__texto.is-oculta", { text: "Nota escondida até a votação", "aria-label": `Nota de ${n.nome || "alguém"}, escondida até a votação` })];
    const pe = el("div.nota__pe");
    if (minha) pe.append(el("span.jogos__rotulo", { text: "sua" }));
    if (v.fase === "votar") {
      pe.append(
        el("div.nota__votos", {}, [
          el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": "Tirar um ponto", disabled: !meus, onClick: () => rt.votar(n.id, -1) }, [el("span", { text: "−" })]),
          el("span.nota__meus", { text: "●".repeat(meus) || "·", "aria-label": `${meus} ponto(s) seu(s)` }),
          el("button.btn.btn--icon.btn--ghost.nota__mais", { type: "button", "aria-label": "Dar um ponto", disabled: v.meusVotosUsados >= v.votosPorPessoa, onClick: () => rt.votar(n.id, +1) }, [el("span", { text: "+" })]),
        ]),
      );
    } else if (v.fase === "discutir" && n.votos) {
      pe.append(el("span.nota__total", { text: `${n.votos} ${n.votos === 1 ? "ponto" : "pontos"}` }));
    }
    if (minha) pe.append(el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": "Apagar nota", onClick: () => rt.apagarNota(n.id) }, [icon("trash-2", { size: "sm" })]));
    return el("article.nota", { class: `${minha ? "is-minha" : ""}` }, [...filhos, pe]);
  }

  /* ---------------------------------------------------------------- *
   * Daily
   * ---------------------------------------------------------------- */

  #montarDaily() {
    const { daily: dl } = this.o;
    const p = this.#partes;
    const tempo = el("select.input.jogos__select", { "aria-label": "Tempo por pessoa" });
    for (const s of [60, 90, 120, 180]) tempo.append(el("option", { value: s, text: `${mmss(s)} por pessoa` }));
    tempo.addEventListener("change", () => dl.tempo(Number(tempo.value)));
    const sortear = el("button.btn.btn--ghost.jogos__chip", { type: "button", onClick: () => dl.sortear(this.#pessoas()) }, [icon("shuffle", { size: "sm" }), el("span", { text: "Sortear ordem" })]);
    const reiniciar = el("button.btn.btn--ghost.jogos__chip", { type: "button", onClick: () => dl.reiniciar() }, [icon("rotate-ccw", { size: "sm" }), el("span", { text: "Recomeçar" })]);
    p.extra.append(tempo, sortear, reiniciar);
    const lista = el("ol.daily__lista", { "aria-label": "Ordem de fala" });
    const palco = el("div.daily__palco", { "aria-live": "polite" });
    this.#corpo.append(el("div.daily", {}, [lista, palco]));
    Object.assign(p, { tempo, lista, palco, dailyChave: "" });
  }

  #desenharDaily() {
    const { estado, daily: dl } = this.o;
    const p = this.#partes;
    if (!p.palco) return;
    const v = daily(estado);
    p.tempo.value = String(v.tempo);
    const pessoas = this.#pessoas();

    // A lista só é refeita quando muda quem fala (o relógio não mexe nela).
    const chave = `${JSON.stringify(v.ordem.map((o) => [o.id, o.segundos]))}|${v.i}|${v.tempo}`;
    if (chave !== p.dailyChave) {
      p.dailyChave = chave;
      p.lista.replaceChildren(
        ...v.ordem.map((o) =>
          el("li.daily__item", { class: `${o.atual ? "is-atual" : ""} ${o.feito ? "is-feito" : ""}` }, [
            el("span.daily__n", { text: String(o.k + 1) }),
            el("span.truncate", { text: o.nome }),
            o.segundos != null ? el("span.daily__seg", { class: o.segundos > v.tempo ? "is-estourou" : "", text: mmss(o.segundos) }) : o.atual ? el("span.jogos__rotulo", { text: "falando" }) : null,
          ].filter(Boolean)),
        ),
      );
      if (!v.ordem.length) p.lista.append(el("li.poker__vazio", { text: "Sorteie a ordem para começar." }));
    }

    if (!v.ordem.length) {
      p.palco.replaceChildren(
        el("div.daily__vazio", {}, [
          icon("shuffle", { size: "lg" }),
          el("p", { text: "Sorteie quem fala primeiro. Cada um tem o mesmo tempo, e o cronômetro aparece para todos." }),
          el("button.btn.btn--primary.btn--lg", { type: "button", onClick: () => dl.sortear(pessoas) }, [el("span", { text: "Sortear ordem" })]),
        ]),
      );
      return;
    }
    if (v.fim) {
      const estouraram = v.ordem.filter((o) => (o.segundos || 0) > v.tempo);
      p.palco.replaceChildren(
        el("div.daily__vazio", {}, [
          icon("party-popper", { size: "lg" }),
          el("h3", { text: `Daily encerrada em ${mmss(v.total)}` }),
          el("p", { text: estouraram.length ? `Passaram do tempo: ${estouraram.map((o) => o.nome).join(", ")}.` : "Todo mundo dentro do tempo." }),
          el("button.btn", { type: "button", onClick: () => dl.reiniciar() }, [icon("rotate-ccw", { size: "sm" }), el("span", { text: "Recomeçar" })]),
        ]),
      );
      return;
    }
    if (!v.atual) {
      p.palco.replaceChildren(
        el("div.daily__vazio", {}, [
          el("p", { text: `Primeiro: ${v.ordem[0].nome}. ${v.ordem.length} pessoas, ${mmss(v.tempo)} para cada.` }),
          el("button.btn.btn--primary.btn--lg", { type: "button", onClick: () => dl.proximo() }, [icon("play", { size: "sm" }), el("span", { text: "Começar a daily" })]),
        ]),
      );
      return;
    }
    // Quem fala agora: o anel esvazia com o tempo e fica vermelho ao estourar.
    const pessoa = pessoas.find((x) => x.id === v.atual.id);
    const fracao = Math.max(0, Math.min(1, v.restante / v.tempo));
    if (!p.dailyFala || !p.dailyFala.isConnected || p.dailyFala.dataset.id !== v.atual.id) {
      p.dailyTempo = el("strong.daily__tempo");
      p.dailyAnel = el("div.daily__anel", {}, [pessoa?.avatar ? avatarEl(pessoa.avatar, { title: v.atual.nome }) : el("span.daily__inicial", { text: (v.atual.nome || "?").slice(0, 1).toUpperCase() })]);
      const proximo = v.ordem[v.i + 1];
      p.dailyFala = el("div.daily__fala", { dataset: { id: v.atual.id } }, [
        p.dailyAnel,
        el("h3", { text: v.atual.nome }),
        p.dailyTempo,
        el("p.muted", { text: proximo ? `Depois: ${proximo.nome}` : "Última pessoa" }),
        el("button.btn.btn--primary.btn--lg", { type: "button", onClick: () => dl.proximo() }, [icon("skip-forward", { size: "sm" }), el("span", { text: proximo ? "Próximo" : "Encerrar" })]),
      ]);
      p.palco.replaceChildren(p.dailyFala);
    }
    p.dailyAnel.style.setProperty("--p", String(fracao));
    p.dailyAnel.classList.toggle("is-acabando", v.restante <= 15 && !v.estourou);
    p.dailyAnel.classList.toggle("is-estourou", v.estourou);
    p.dailyTempo.textContent = v.estourou ? `${mmss(-(v.decorrido - v.tempo))} passou` : mmss(v.restante);
  }
}

/** Para a nota de quem abriu o jogo: "Ana abriu o Planning Poker". */
export function nomeDoJogo(id) {
  return JOGOS[id]?.nome || "um jogo";
}

/** Usado pelo topo: a história em votação (para avisos). */
export function historiaEmVotacao(estado) {
  const hid = historiaAtual(estado);
  return historias(estado).find((h) => h.id === hid) || null;
}
