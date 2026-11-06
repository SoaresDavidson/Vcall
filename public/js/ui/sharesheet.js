/**
 * ui/sharesheet.js — a tela de compartilhar, antes da do navegador.
 *
 * O QUE ESTA TELA PODE E O QUE NÃO PODE, sem rodeios:
 *
 * A janela final do navegador — aquela com a lista de telas e janelas — é
 * OBRIGATÓRIA e não pode ser substituída. Nenhuma página consegue enumerar as
 * suas janelas, ver miniaturas delas ou escolher uma por conta própria. Se
 * conseguisse, qualquer site leria a sua tela sem você saber. É a mesma regra
 * que vale para câmera e microfone, e aqui ela é ainda mais rígida.
 *
 * O que dá para fazer, e é o que esta tela faz, é tudo o que vem ANTES:
 *
 *   1. PERGUNTAR O QUE VOCÊ QUER MOSTRAR. Tela inteira, uma janela, ou uma aba.
 *      A escolha vira uma preferência (`displaySurface`) que faz o seletor do
 *      navegador ABRIR JÁ NA ABA CERTA, em vez de você ter que procurar.
 *
 *   2. AJUSTAR A QUALIDADE ANTES, e não depois de já estar compartilhando
 *      ruim. Nitidez para texto e código; fluidez para vídeo.
 *
 *   3. DECIDIR SOBRE O SOM. A caixa de "compartilhar áudio" do navegador passa
 *      despercebida por quase todo mundo; aqui ela é uma pergunta explícita.
 *
 * É o mesmo desenho que Meet e Teams usam: painel próprio, depois a janela do
 * sistema. A diferença entre parecer um aplicativo e parecer uma página é
 * justamente este passo.
 *
 * NO APLICATIVO DE MESA É DIFERENTE, e melhor: lá quem responde ao pedido de
 * captura é o próprio Vcall (desktop/main.js), então esta tela mostra a lista
 * de verdade — cada tela e cada janela aberta, com miniatura — e a pessoa
 * escolhe o aplicativo que quer mostrar. No Linux com Wayland a lista é do
 * portal do sistema, que abre logo em seguida.
 *
 * O SOM vem DESLIGADO por padrão. No Windows o "som do computador" é o som
 * de tudo, inclusive das vozes da própria chamada: ligado sem querer, quem
 * está do outro lado se ouve de volta, com atraso.
 */
import { el, icon, $ } from "../lib/dom.js";
import { prefs } from "../lib/util.js";
import { SCREEN_QUALITY, TETO_QPS } from "../core/screen.js";

const SUPERFICIES = [
  {
    id: "monitor",
    icon: "monitor",
    titulo: "Tela inteira",
    texto: "Tudo o que aparece no seu monitor, inclusive o que você abrir depois.",
  },
  {
    id: "window",
    icon: "layout-grid",
    titulo: "Uma janela",
    texto: "Só um programa. O resto da sua tela continua privado.",
  },
  {
    id: "browser",
    icon: "panel-right-open",
    titulo: "Uma aba do navegador",
    texto: "A mais nítida para slides e sites, e a que menos pesa na rede.",
  },
];

/**
 * O título da janela é de vídeo (site ou player)? Vídeo no modo Nitidez sai
 * aos trancos: o encoder guarda a letra nítida e joga quadros fora.
 */
export function pareceVideo(nome) {
  return /youtube|twitch|netflix|prime video|disney\+|globoplay|crunchyroll|vimeo|kick|max|vlc|media player|mpv|potplayer|filmes e tv|player/i.test(String(nome || ""));
}

const MODOS = [
  {
    id: "text",
    icon: "type",
    titulo: "Nitidez",
    texto: "Texto, código, planilhas. A imagem para de perder detalhe quando a rede aperta.",
  },
  {
    id: "motion",
    icon: "zap",
    titulo: "Fluidez",
    texto: `Vídeo e jogo, até ${TETO_QPS} quadros por segundo. A imagem fica menor antes de engasgar.`,
  },
];

/**
 * Abre o painel. Resolve com as escolhas, ou `null` se a pessoa desistir.
 *
 * @returns {Promise<{surface:string, quality:string, mode:string, withAudio:boolean}|null>}
 */
export function escolherCompartilhamento({ podeAudio = true, desktop = null, trocando = false } = {}) {
  return new Promise((resolve) => {
    const escolha = {
      surface: prefs.get("share:surface", "window"),
      quality: prefs.get("screen:quality", "auto"),
      mode: prefs.get("share:mode", "text"),
      // Chave nova de propósito: quem tinha o som ligado pelo padrão antigo
      // (que trazia eco) volta a começar desligado.
      withAudio: prefs.get("share:audio2", false),
      fonte: null,
    };
    // Pedidas já, ainda dentro do clique: a lista de janelas exige um gesto.
    // A sem miniaturas chega em menos de 1 s; as miniaturas vêm depois.
    const fontesPedido = desktop?.fontes ? desktop.fontes({ miniaturas: false }).catch(() => null) : null;
    const miniaturasPedido = desktop?.fontes ? desktop.fontes({ miniaturas: true }).catch(() => null) : null;

    const fundo = el("div.share", { role: "dialog", "aria-modal": "true", "aria-labelledby": "shareTitulo" });
    const card = el("div.share__card");

    card.append(
      el("div.share__head", {}, [
        el("span.share__icone", {}, [icon("screen-share", { size: "lg" })]),
        el("div", {}, [
          el("h2.share__titulo", { id: "shareTitulo", text: trocando ? "Trocar o que você está mostrando" : "Compartilhar sua tela" }),
          el("p.share__sub", {
            text: trocando
              ? "A transmissão continua: quem está assistindo passa a ver a nova escolha, sem cair."
              : "Escolha o que mostrar e como. Nada é gravado nem sai daqui.",
          }),
        ]),
      ]),
    );

    /* -- o que mostrar -- */
    const grade = el("div.share__grade", { role: "radiogroup", "aria-label": "O que mostrar" });
    // Janela de vídeo escolhida: Fluidez, a menos que a pessoa tenha escolhido o modo à mão.
    const modoAuto = { para: null };
    let modoManual = false;
    const cartoes = new Map();
    const somBloco = { node: null, mostrar: () => {} };
    const confirmarRef = { node: null };
    if (fontesPedido) {
      card.append(montarListaDesktop({ fontesPedido, miniaturasPedido, escolha, somBloco, confirmarRef, aoEscolherFonte: (f) => modoAuto.para?.(f) }));
    }
    for (const s of fontesPedido ? [] : SUPERFICIES) {
      const b = el("button.share__opcao", {
        type: "button",
        role: "radio",
        "aria-checked": String(escolha.surface === s.id),
        onClick: () => {
          escolha.surface = s.id;
          for (const [k, n] of cartoes) n.setAttribute("aria-checked", String(k === s.id));
        },
      });
      b.append(
        el("span.share__opcaoIcone", {}, [icon(s.icon, { size: "lg" })]),
        el("span.share__opcaoNome", { text: s.titulo }),
        el("span.share__opcaoTexto", { text: s.texto }),
      );
      cartoes.set(s.id, b);
      grade.append(b);
    }
    if (!fontesPedido) card.append(grade);

    /* -- prioridade da imagem -- */
    const linhaModo = el("div.share__linha", { role: "radiogroup", "aria-label": "Prioridade da imagem" });
    const modos = new Map();
    for (const m of MODOS) {
      const b = el("button.share__pilula", {
        type: "button",
        role: "radio",
        "aria-checked": String(escolha.mode === m.id),
        dataset: { tip: m.texto, "tip-placement": "top" },
        onClick: () => {
          modoManual = true;
          marcarModo(m.id);
        },
      });
      b.append(icon(m.icon, { size: "sm" }), el("span", { text: m.titulo }));
      modos.set(m.id, b);
      linhaModo.append(b);
    }
    function marcarModo(id) {
      escolha.mode = id;
      for (const [k, n] of modos) n.setAttribute("aria-checked", String(k === id));
    }
    modoAuto.para = (f) => {
      if (!modoManual) marcarModo(pareceVideo(f?.nome) ? "motion" : prefs.get("share:mode", "text"));
    };

    /* -- resolução -- */
    const seletorQ = el("select.input.share__select", { "aria-label": "Qualidade" });
    for (const [id, q] of Object.entries(SCREEN_QUALITY)) {
      seletorQ.append(el("option", { value: id, text: q.label, selected: escolha.quality === id }));
    }
    seletorQ.addEventListener("change", () => (escolha.quality = seletorQ.value));

    card.append(
      el("div.share__campo", {}, [
        el("span.share__rotulo", { text: "Prioridade da imagem" }),
        linhaModo,
      ]),
      el("div.share__campo", {}, [el("span.share__rotulo", { text: "Resolução" }), seletorQ]),
    );

    /* -- som -- */
    if (podeAudio) {
      const somDesc = desktop
        ? "Leva o som de tudo o que toca no computador. Use fones: sem eles, as vozes da chamada voltam para os outros como eco."
        : "Para vídeo e música. No Chrome, marque também “Compartilhar áudio” na janela seguinte. Use fones para não gerar eco.";
      const toggle = el("button.share__switch", {
        type: "button",
        role: "switch",
        "aria-checked": String(escolha.withAudio),
        "aria-label": "Compartilhar o som",
        onClick: (e) => {
          escolha.withAudio = !escolha.withAudio;
          e.currentTarget.setAttribute("aria-checked", String(escolha.withAudio));
        },
      });
      somBloco.node = el("div.share__som", {}, [
        el("span.share__opcaoIcone", {}, [icon("volume-2", { size: "sm" })]),
        el("div.share__texto", {}, [
          el("div.share__nome", { text: desktop ? "Compartilhar o som do computador" : "Compartilhar o som" }),
          el("div.share__desc", { text: somDesc }),
        ]),
        toggle,
      ]);
      // No app de mesa, quem diz se há som do computador é a lista (Windows e Linux).
      if (desktop) somBloco.node.hidden = true;
      somBloco.mostrar = (sim) => {
        somBloco.node.hidden = !sim;
        if (!sim) {
          escolha.withAudio = false;
          toggle.setAttribute("aria-checked", "false");
        }
      };
      card.append(somBloco.node);
    }

    if (!fontesPedido) {
      card.append(
        el("p.share__aviso", {
          text: "A seguir o navegador vai mostrar a lista de telas e janelas — esse passo é dele e não pode ser pulado. Ele já abre na aba que você escolheu aqui.",
        }),
      );
    }

    const cancelar = el("button.btn.btn--ghost", { type: "button", text: "Cancelar" });
    const confirmar = el("button.btn.btn--primary.btn--lg", { type: "button" });
    confirmar.append(
      icon(trocando ? "refresh-cw" : "screen-share", { size: "sm" }),
      el("span", { text: trocando ? "Trocar agora" : fontesPedido ? "Compartilhar" : "Escolher o que mostrar" }),
    );
    confirmarRef.node = confirmar;

    card.append(el("div.share__acoes", {}, [cancelar, confirmar]));
    fundo.append(card);
    document.body.append(fundo);

    let resolvido = false;
    const fechar = (valor) => {
      if (resolvido) return;
      resolvido = true;
      fundo.remove();
      document.removeEventListener("keydown", aoTeclar);
      resolve(valor);
    };

    const aoTeclar = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        fechar(null);
      }
    };
    document.addEventListener("keydown", aoTeclar);

    cancelar.addEventListener("click", () => fechar(null));
    fundo.addEventListener("click", (e) => {
      if (e.target === fundo) fechar(null);
    });

    confirmar.addEventListener("click", () => {
      if (confirmar.disabled) return;
      prefs.set("share:surface", escolha.surface);
      prefs.set("screen:quality", escolha.quality);
      if (modoManual) prefs.set("share:mode", escolha.mode);
      // Escolhido à mão, o modo fica; senão a Fluidez pode entrar sozinha (screen.fluidezAutomatica).
      escolha.modoFixo = modoManual;
      prefs.set("share:audio2", escolha.withAudio);
      /*
       * Fecha ANTES de resolver. A captura precisa ser pedida ainda dentro do
       * clique — o navegador exige "ativação transitória" e recusa o pedido se
       * ele vier depois de outra espera. Remover o painel aqui deixa o caminho
       * livre para `getDisplayMedia` ser chamado no mesmo gesto.
       */
      fechar(escolha);
    });

    requestAnimationFrame(() => confirmar.focus());
  });
}

/* ------------------------------------------------------------------ *
 * Aplicativo de mesa: a lista real de telas e janelas
 * ------------------------------------------------------------------ */

/**
 * Monta a lista de fontes do app de mesa. Ela chega de forma assíncrona, em
 * dois tempos: nomes e ícones em menos de 1 s, e as miniaturas (o sistema
 * fotografa cada janela) alguns segundos depois, no lugar dos quadros vazios.
 */
function montarListaDesktop({ fontesPedido, miniaturasPedido, escolha, somBloco, confirmarRef, aoEscolherFonte }) {
  const bloco = el("div.share__fontes");
  const abas = el("div.share__linha", { role: "tablist", "aria-label": "Tipo" });
  const grade = el("div.share__fontesGrade", { role: "radiogroup", "aria-label": "O que compartilhar" });
  const estado = el("p.share__carregando", { text: "Procurando telas e janelas…" });
  bloco.append(abas, estado, grade);

  let tipo = prefs.get("share:tipo", "window");
  let lista = [];

  const marcar = () => {
    for (const n of grade.children) n.setAttribute("aria-checked", String(n.dataset.id === escolha.fonte));
    if (confirmarRef.node) confirmarRef.node.disabled = !escolha.fonte && !escolha.portal;
  };

  const desenhar = () => {
    grade.replaceChildren();
    for (const b of abas.children) b.setAttribute("aria-checked", String(b.dataset.tipo === tipo));
    const visiveis = lista.filter((f) => f.tipo === tipo);
    estado.hidden = visiveis.length > 0;
    if (!visiveis.length) estado.textContent = tipo === "window" ? "Nenhuma janela aberta para compartilhar." : "Nenhuma tela encontrada.";
    for (const f of visiveis) {
      const b = el("button.share__fonte", {
        type: "button",
        role: "radio",
        "aria-label": f.nome,
        title: f.nome,
        dataset: { id: f.id },
        onClick: () => {
          escolha.fonte = f.id;
          escolha.surface = f.tipo === "screen" ? "monitor" : "window";
          aoEscolherFonte?.(f);
          marcar();
        },
        onDblclick: () => {
          escolha.fonte = f.id;
          aoEscolherFonte?.(f);
          marcar();
          confirmarRef.node?.click();
        },
      });
      const miniatura = f.miniatura
        ? el("img.share__fonteImg", { src: f.miniatura, alt: "", draggable: false })
        : el("span.share__fonteImg.share__fonteImg--vazia", {}, [icon(f.tipo === "screen" ? "monitor" : "layout-grid", { size: "lg" })]);
      const rotulo = el("span.share__fonteNome", {}, [
        f.icone ? el("img.share__fonteIcone", { src: f.icone, alt: "", width: 16, height: 16 }) : null,
        el("span.truncate", { text: f.nome }),
      ].filter(Boolean));
      b.append(miniatura, rotulo);
      grade.append(b);
    }
    // A escolha anterior some se a janela foi fechada; cai na primeira da aba.
    if (!visiveis.some((f) => f.id === escolha.fonte)) {
      escolha.fonte = visiveis[0]?.id || null;
      if (visiveis[0]) escolha.surface = visiveis[0].tipo === "screen" ? "monitor" : "window";
      aoEscolherFonte?.(visiveis[0]);
    }
    marcar();
  };

  for (const [id, rotulo, nomeIcone] of [
    ["window", "Janelas", "layout-grid"],
    ["screen", "Telas inteiras", "monitor"],
  ]) {
    abas.append(
      el(
        "button.share__pilula",
        {
          type: "button",
          role: "tab",
          dataset: { tipo: id },
          "aria-checked": String(id === tipo),
          onClick: () => {
            tipo = id;
            prefs.set("share:tipo", id);
            desenhar();
          },
        },
        [icon(nomeIcone, { size: "sm" }), el("span", { text: rotulo })],
      ),
    );
  }

  queueMicrotask(() => {
    if (confirmarRef.node) confirmarRef.node.disabled = true;
  });

  fontesPedido.then((r) => {
    if (!r) {
      // Sem lista (erro no sistema): segue o caminho antigo, a tela principal.
      abas.hidden = true;
      estado.textContent = "Não consegui listar as janelas. A tela principal será compartilhada.";
      escolha.portal = true;
      marcar();
      return;
    }
    somBloco.mostrar?.(!!r.audio);
    if (r.portal) {
      // Wayland: o portal do sistema mostra a lista logo depois deste passo.
      abas.hidden = true;
      estado.textContent = "O sistema vai abrir a janela dele para você escolher a tela ou o aplicativo.";
      escolha.portal = true;
      marcar();
      return;
    }
    lista = r.fontes || [];
    if (!lista.some((f) => f.tipo === tipo)) tipo = lista[0]?.tipo || "screen";
    desenhar();
    // As miniaturas entram no lugar, sem redesenhar a grade (o foco fica onde está).
    miniaturasPedido?.then((m) => {
      // A busca com miniaturas às vezes acha janelas que a rápida não achou.
      const novas = (m?.fontes || []).filter((f) => !lista.some((x) => x.id === f.id));
      if (novas.length) {
        lista.push(...novas);
        desenhar();
      }
      for (const f of m?.fontes || []) {
        const item = lista.find((x) => x.id === f.id);
        if (!item || !f.miniatura) continue;
        item.miniatura = f.miniatura;
        const vazia = [...grade.children].find((b) => b.dataset.id === f.id)?.querySelector(".share__fonteImg--vazia");
        vazia?.replaceWith(el("img.share__fonteImg", { src: f.miniatura, alt: "", draggable: false }));
      }
    });
  });

  return bloco;
}
