/**
 * ui/dashboard.js — painel inicial de chamadas ativas.
 *
 * O que este painel pode e não pode mostrar decorre de uma decisão do
 * sistema: o id de uma sala É o segredo dela. Listar todas as salas seria
 * publicar todas as chaves. Por isso o diretório mostra apenas salas que
 * alguém marcou como PÚBLICAS ao criá-las; as privadas — o padrão — não
 * aparecem aqui nem por engano, e só são alcançadas por link ou código.
 *
 * Com o Tailscale, "Ao vivo agora" junta também as chamadas dos outros
 * computadores com Vcall da rede (/api/rede, que só responde para quem é da
 * máquina ou da tailnet), e a sala pode ser "Na minha rede": visível para a
 * tailnet, invisível para quem chega pelo link público.
 *
 * A atualização é por sondagem a cada poucos segundos, e não por WebSocket.
 * Assinar o diretório exigiria uma conexão de sinalização antes de entrar em
 * qualquer sala, aberta o tempo todo em cada aba parada nesta tela; uma
 * requisição curta a cada cinco segundos entrega a mesma sensação de tempo
 * real por muito menos.
 */
import { el, icon, clear, on } from "../lib/dom.js";
import { avatarEl } from "./avatars.js";
import { toast } from "./toast.js";
import { calm } from "./motion.js";
import { newRoomId, prefs } from "../lib/util.js";
import { duo } from "./theme.js";

const POLL_MS = 5000;
/** A rede é varrida pelo app de mesa; perguntar mais que isto não traz nada novo. */
const POLL_REDE_MS = 10_000;
/** Quantas salas cabem na tela inicial sem rolagem; o resto vira "+N". */
const MAX_VISIVEIS = 4;

function saudacao() {
  const h = new Date().getHours();
  const greet = h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  const name = String(prefs.get("name", "") || "").split(" ")[0];
  return name ? `${greet}, ${name}` : greet;
}

export class Dashboard {
  #timer = 0;
  #timerRede = 0;
  #rooms = [];
  /** Resposta de /api/rede: { disponivel, computadores: [{ eu, curto, url, salas }] } */
  #rede = null;
  #maquinas = null;
  #list = null;
  /* O ingresso: campos e escolhas da nova call. */
  #nomeSala = null;
  #aprovar = null;
  #setor = null;
  #visibilidade = "private";
  #setorTocado = false;
  /** Id escolhido por outro computador da rede (?criar=1#sala). */
  #roomIdFixo = null;
  #empty = null;
  #count = null;
  #node = null;

  constructor({ onEnter, ...opts } = {}) {
    /** onEnter({ roomId, pass, meta, isNew }) */
    this.onEnter = onEnter;
    /** { nome, theme, onSettings } — tudo opcional. */
    this.opts = opts;
  }

  mount(root) {
    // Tela cheia, sem cartão: a recepção É o app, não uma janela dentro dele.
    this.#node = el("section.dash", { "aria-label": "Início" }, [
      this.#header(),
      el("main.dash__main", {}, [this.#hero()]),
    ]);
    root.append(this.#node);
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), POLL_MS);
    this.#buscarRede();
    this.#timerRede = setInterval(() => this.#buscarRede(), POLL_REDE_MS);
    // Uma aba em segundo plano não precisa sondar nada.
    on(document, "visibilitychange", () => {
      if (!document.hidden) this.refresh();
    });
    return this.#node;
  }

  hide() {
    clearInterval(this.#timer);
    clearInterval(this.#timerRede);
    this.#timer = 0;
    this.#timerRede = 0;
    this.#node?.remove();
    this.#node = null;
  }

  /* ---------------------------------------------------------------- */

  /**
   * A faixa de cima.
   *
   * Sem logotipo: quem abriu o programa sabe que programa é, e a marca já
   * está no ícone da janela e no título. No lugar entra o que é útil — o
   * cumprimento, o estado, e o acesso às configurações, que antes só existia
   * dentro de uma chamada, ou seja, tarde demais para quem queria escolher a
   * câmera ANTES de aparecer para alguém.
   */
  #header() {
    const acao = (iconName, rotulo, aoClicar) => {
      const b = el("button.btn.btn--icon.btn--ghost", {
        type: "button",
        "aria-label": rotulo,
        dataset: { tip: rotulo, "tip-placement": "bottom" },
        onClick: aoClicar,
      });
      b.append(icon(iconName));
      return b;
    };

    const tema = acao("laptop", "Tema", () => {});
    this.opts.theme?.bindButton?.(tema);

    return el("header.dash__head", {}, [
      // A marca só aparece no visual Empresa, onde o topo é a barra do programa.
      el("span.dash__marca", { dataset: { so: "empresa" } }, [
        el("img", { src: "/assets/logo-mark.png", alt: "", width: 24, height: 24 }),
        el("span", { text: "Vcall" }),
      ]),
      el("span.dash__greet", { text: saudacao() + (this.opts.nome ? `, ${this.opts.nome}` : "") }),
      el("span.spacer"),
      el("span.dash__status", {}, [el("i"), el("span", {}, duo("Pronto para chamar", "Disponível"))]),
      tema,
      acao("settings", "Configurações", () => this.opts.onSettings?.()),
    ]);
  }

  /**
   * A recepção é um ingresso.
   *
   * Criar uma call é preencher (se quiser) o próprio ingresso e destacá-lo:
   * nome da sala, setor e aprovação de quem entra moram nele, no lugar do
   * modal que se abria antes de qualquer coisa. Quem já foi chamado usa o
   * canhoto, com o código.
   * À esquerda ficam o título e, embaixo, as calls ao vivo como canhotos.
   */
  #hero() {
    return el("div.dash__hero", {}, [
      el("div.dash__intro", {}, [
        el("h1.dash__headline", {}, [
          el("span", { dataset: { so: "vcall" } }, ["Chame alguém ", el("em", { text: "agora." })]),
          el("span", { dataset: { so: "empresa" }, text: saudacao() }),
        ]),
        el("p.dash__lead", {}, duo(
          "Vídeo, voz e tela de um computador direto para o outro. Quem você chama entra pelo link, sem conta.",
          "Comece uma reunião agora ou entre com o código que você recebeu.",
        )),
      ]),
      el("div.dash__art", {}, [this.#bilhete()]),
      this.#body(),
    ]);
  }

  #bilhete() {
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    this.#nomeSala = el("input.bilhete__input", {
      type: "text",
      maxLength: 48,
      autocomplete: "off",
      value: prefs.get("room:lastName", ""),
    });
    // O exemplo acompanha o visual (o placeholder não tem como ter os dois).
    const exemplo = () => {
      this.#nomeSala.placeholder = document.documentElement.dataset.visual === "empresa" ? "Ex.: Reunião de equipe" : "Ex.: Almoço de domingo";
    };
    exemplo();
    on(document, "themechange", exemplo);
    // Aprovar quem entra (como no Meet): a sala nasce trancada e quem chega
    // espera na fila até o anfitrião aceitar. Substitui a antiga senha.
    this.#aprovar = el("input", { type: "checkbox", checked: prefs.get("room:aprovar", false) });

    // O setor é a privacidade. "Na minha rede" entra quando a rede aparece.
    this.#setor = el("div.dash__privacy", { role: "radiogroup", "aria-labelledby": "setorRotulo" });
    this.#visibilidade = prefs.get("room:visibilidade", null) === "public" ? "public" : "private";
    this.#opcao("private", "lock", "Privada", "Só entra quem tem o link ou o código.");
    this.#opcao("public", "users", "Pública", "Aparece em Ao vivo agora para qualquer pessoa entrar.");

    const principal = el("form.bilhete__principal", {
      "aria-label": "Nova call",
      onSubmit: (e) => {
        e.preventDefault();
        this.#criar();
      },
    }, [
      el("div.bilhete__corpo", {}, [
        el("div.bilhete__topo", {}, [
          el("span.bilhete__marca", {}, [el("img", { src: "/assets/logo-mark.png", alt: "", width: 22, height: 22 }), el("span", { text: "Vcall" })]),
          el("dl.bilhete__dados", {}, [
            el("div", {}, [el("dt", { text: "Sessão" }), el("dd", { text: `Hoje, ${hora}` })]),
            el("div", {}, [el("dt", { text: "Lugares" }), el("dd", { text: "Até 16" })]),
          ]),
        ]),
        el("div.bilhete__cabeca", {}, [
          el("span.bilhete__icone", { "aria-hidden": "true" }, [icon("video")]),
          el("div", {}, [
            el("h2.bilhete__titulo", {}, duo("Nova call", "Nova reunião")),
            el("p.bilhete__admite", {}, duo("Admite quem você chamar", "Até 16 pessoas, com vídeo, voz e tela.")),
          ]),
        ]),
        el("label.bilhete__campo", {}, [el("span.bilhete__rotulo", {}, duo("Nome da sala (opcional)", "Nome da reunião (opcional)")), this.#nomeSala]),
        el("div.bilhete__linha", {}, [
          el("div.bilhete__campo", {}, [el("span.bilhete__rotulo", { id: "setorRotulo" }, duo("Setor", "Quem pode entrar")), this.#setor]),
          el("label.bilhete__aprovar", {}, [
            this.#aprovar,
            el("span", {}, [
              el("strong", { text: "Aprovar quem entra" }),
              el("small", { text: "Quem chega espera na fila até você aceitar." }),
            ]),
          ]),
        ]),
        el("div.bilhete__pe", {}, [
          el("button.bilhete__chamar", { type: "submit" }, [icon("video"), ...duo("Chamar agora", "Iniciar reunião")]),
          el("p.bilhete__letras", { text: "Vídeo, voz e tela vão direto, criptografados. A sala some quando todos saem." }),
        ]),
      ]),
    ]);

    return el("div.bilhete", {}, [principal, this.#canhoto()]);
  }

  /** Uma opção de setor: um rádio em forma de pílula, impresso no ingresso. */
  #opcao(valor, iconName, titulo, dica) {
    const b = el("button.privacy", {
      type: "button",
      role: "radio",
      "aria-checked": String(this.#visibilidade === valor),
      dataset: { valor, tip: dica, "tip-placement": "bottom" },
      onClick: () => {
        this.#visibilidade = valor;
        this.#setorTocado = true;
        this.#marcarSetor();
      },
    }, [icon(iconName, { size: "sm" }), el("strong", { text: titulo })]);
    this.#setor.append(b);
  }

  #marcarSetor() {
    for (const b of this.#setor.children) b.setAttribute("aria-checked", String(b.dataset.valor === this.#visibilidade));
  }

  /**
   * "Na minha rede" só existe onde há rede: no app com Tailscale, ou pela
   * tailnet. Quando a rede aparece e a pessoa ainda não escolheu, ela vira o
   * padrão: aparece para a turma e continua escondida do link público.
   */
  #setorDaRede() {
    if (!this.#rede || !this.#setor || this.#setor.querySelector('[data-valor="rede"]')) return;
    this.#opcao("rede", "network", "Na minha rede", "Aparece para quem está na sua rede Tailscale. Quem chega pelo link público não vê.");
    const guardada = prefs.get("room:visibilidade", null);
    if (!this.#setorTocado && (guardada === "rede" || !guardada)) this.#visibilidade = "rede";
    this.#marcarSetor();
  }

  /**
   * O canhoto: quem já foi chamado digita o código aqui.
   *
   * Um campo de verdade, transparente, por cima de seis casas desenhadas: o
   * teclado, o colar e o leitor de tela falam com o campo; as casas só
   * mostram o que ele tem. Na sexta letra a busca começa sozinha, e colar o
   * link curto inteiro (…/c/ABC123) também vale.
   */
  #canhoto() {
    const casas = el("span.bilhete__casas", { "aria-hidden": "true" }, Array.from({ length: 6 }, () => el("span")));
    const codigo = el("input.bilhete__codigo", {
      type: "text",
      maxLength: 6,
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: false,
      enterKeyHint: "go",
      // Só aparece no visual Empresa, onde o campo é visível; no Vcall as casas desenhadas cobrem.
      placeholder: "Ex.: H48C4E",
      "aria-label": "Código da sala",
    });
    const mostrar = () => {
      const foco = document.activeElement === codigo;
      [...casas.children].forEach((c, i) => {
        c.textContent = codigo.value[i] || "";
        c.classList.toggle("is-atual", foco && i === Math.min(codigo.value.length, 5));
      });
    };
    codigo.addEventListener("input", () => {
      codigo.value = codigo.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      mostrar();
      if (codigo.value.length === 6) this.#enterByCode(codigo.value);
    });
    codigo.addEventListener("paste", (e) => {
      const doLink = /\/c\/([A-Za-z0-9]{4,12})/.exec(e.clipboardData?.getData("text") || "");
      if (!doLink) return;
      e.preventDefault();
      codigo.value = doLink[1].toUpperCase().slice(0, 6);
      mostrar();
      this.#enterByCode(doLink[1]);
    });
    codigo.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.#enterByCode(codigo.value);
    });
    codigo.addEventListener("focus", mostrar);
    codigo.addEventListener("blur", mostrar);

    return el("div.bilhete__canhoto", {}, [
      el("div.bilhete__canhotoCabeca", {}, [
        el("span.bilhete__icone", { "aria-hidden": "true" }, [icon("hash")]),
        el("div", {}, [
          el("p.bilhete__canhotoTitulo", {}, duo("Já tem um ingresso?", "Entrar com código")),
          el("p.bilhete__canhotoSub", { dataset: { so: "empresa" }, text: "O código de 6 caracteres do convite." }),
        ]),
      ]),
      el("label.bilhete__codigoCaixa", {}, [
        el("span.bilhete__rotulo", {}, duo("Código da sala", "Código da reunião")),
        el("span.bilhete__codigoWrap", {}, [casas, codigo]),
      ]),
      el("button.bilhete__entrar", { type: "button", onClick: () => this.#enterByCode(codigo.value) }, [
        el("span", { text: "Entrar" }),
        icon("arrow-right", { size: "sm" }),
      ]),
      el("p.bilhete__dica", { text: "Ou cole o link que você recebeu." }),
    ]);
  }

  #body() {
    this.#count = el("span.dash__count", { text: "" });
    this.#list = el("div.dash__list", { role: "list" });
    this.#maquinas = el("div.dash__rede", { hidden: true, "aria-label": "Computadores na sua rede Tailscale" });
    this.#empty = el("div.dash__empty", {}, [
      el("span.dash__emptyArt", { "aria-hidden": "true" }, [icon("search")]),
      el("div.dash__emptyText", {}, [
        el("p.dash__emptyTitle", { text: "Nenhuma call pública no ar agora." }),
        el("p.dash__emptyHint", {
          text: "Salas privadas não aparecem aqui: o endereço delas é o segredo. Entre pelo link ou pelo código que você recebeu.",
        }),
      ]),
    ]);
    return el("section.dash__body", { "aria-labelledby": "aoVivoTitulo" }, [
      el("div.dash__bodyHead", {}, [
        el("h2.dash__title", { id: "aoVivoTitulo" }, [el("i.dash__live", { "aria-hidden": "true" }), "Ao vivo agora"]),
        this.#count,
        el("span.spacer"),
        el("button.btn.btn--icon.btn--ghost", {
          type: "button",
          "aria-label": "Atualizar lista",
          dataset: { tip: "Atualizar", "tip-placement": "bottom" },
          onClick: () => this.refresh(),
        }, [icon("refresh-cw")]),
      ]),
      this.#list,
      this.#empty,
      this.#maquinas,
    ]);
  }

  /* ---------------------------------------------------------------- *
   * Rede Tailscale
   * ---------------------------------------------------------------- */

  async #buscarRede() {
    if (!this.#node || document.hidden) return;
    try {
      const res = await fetch("/api/rede", { cache: "no-store" });
      const dados = res.ok ? await res.json() : null;
      this.#rede = dados?.disponivel ? dados : null;
    } catch {
      this.#rede = null;
    }
    this.#render();
    this.#setorDaRede();
  }

  /** As salas dos OUTROS computadores, cada uma sabendo de onde é. */
  #salasDaRede() {
    const out = [];
    for (const c of this.#rede?.computadores || []) {
      if (c.eu || !c.url) continue;
      for (const s of c.salas || []) out.push({ ...s, computador: { curto: c.curto, url: c.url } });
    }
    return out;
  }

  /** "Na sua rede": os outros computadores com Vcall, com "criar aqui". */
  #desenharMaquinas() {
    const outros = (this.#rede?.computadores || []).filter((c) => !c.eu && c.url);
    this.#maquinas.hidden = !this.#rede;
    if (!this.#rede) return;
    const eu = this.#rede.computadores.find((c) => c.eu);
    this.#maquinas.replaceChildren(
      el("p.dash__redeTitulo", {}, [
        icon("network", { size: "sm" }),
        el("span", { text: outros.length ? "Também na sua rede Tailscale" : "Sua rede Tailscale" }),
      ]),
      ...(outros.length
        ? outros.map((c) => {
            const salas = c.salas.length ? `${c.salas.length} ${c.salas.length === 1 ? "chamada" : "chamadas"}` : "livre";
            // Quem está no computador, quando o Vcall de lá conta; senão, o nome da máquina.
            const p = c.pessoa;
            return el("div.dashPc", { role: "group", "aria-label": p ? `${p.nome}, em ${c.curto}` : c.curto }, [
              p
                ? el("span.dashPc__quem", {}, [
                    avatarEl(p.avatar, { size: 26, title: `Avatar de ${p.nome}` }),
                    el("i.dashPc__luz", { "aria-hidden": "true" }),
                  ])
                : el("i.dashPc__luz", { "aria-hidden": "true" }),
              el("span.dashPc__nome", { text: p ? p.nome : c.curto }),
              el("span.dashPc__n", { text: p ? `${c.curto} · ${salas}` : salas }),
              el("button.btn.btn--ghost.dashPc__criar", {
                type: "button",
                "aria-label": `Criar chamada em ${c.curto}`,
                onClick: () => this.opts.irPara?.(`${c.url}/?criar=1#${newRoomId()}`),
              }, [icon("plus", { size: "sm" }), el("span", { text: "Criar aqui" })]),
            ]);
          })
        : [
            el("p.field__hint", {
              text: eu?.url
                ? "Nenhum outro computador com o Vcall aberto na rede agora."
                : "Nenhum outro computador com o Vcall na rede agora. Para o celular criar chamadas neste computador, ligue Configurações › Rede Tailscale.",
            }),
          ]),
    );
  }

  /* ---------------------------------------------------------------- *
   * Diretório
   * ---------------------------------------------------------------- */

  async refresh() {
    if (!this.#node) return;
    try {
      const res = await fetch("/api/rooms", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      this.#rooms = Array.isArray(data.rooms) ? data.rooms : [];
      this.#render();
      if (this.#count && !this.#rooms.length && !this.#salasDaRede().length) this.#count.textContent = "";
    } catch {
      if (this.#count) this.#count.textContent = "sem contato com o servidor";
    }
  }

  #render() {
    if (!this.#list) return;
    clear(this.#list);
    this.#desenharMaquinas();
    const todas = [...this.#rooms, ...this.#salasDaRede()];
    const n = todas.length;
    const people = todas.reduce((a, r) => a + r.size, 0);
    const pessoas = `${people} ${people === 1 ? "pessoa" : "pessoas"}`;
    this.#count.replaceChildren(
      ...(n ? duo(`${n} ${n === 1 ? "sala" : "salas"} · ${pessoas}`, `${n} ${n === 1 ? "reunião" : "reuniões"} · ${pessoas}`) : []),
    );
    this.#empty.hidden = n > 0;
    // O ponto vermelho só pulsa quando há mesmo alguma call no ar.
    this.#node?.querySelector(".dash__body")?.classList.toggle("is-vazio", n === 0);
    this.#empty.querySelector(".dash__emptyTitle").replaceChildren(
      ...(this.#rede
        ? duo("Nenhuma call no ar na sua rede agora.", "Nenhuma reunião na sua rede agora.")
        : duo("Nenhuma call pública no ar agora.", "Nenhuma reunião pública agora.")),
    );

    // A tela inicial não rola: mostra as mais cheias e resume o resto.
    const ordenadas = todas.sort((a, b) => b.size - a.size);
    for (const room of ordenadas.slice(0, MAX_VISIVEIS)) this.#list.append(this.#card(room));
    if (ordenadas.length > MAX_VISIVEIS) {
      this.#list.append(el("p.dash__more", { text: `Mais ${ordenadas.length - MAX_VISIVEIS} no ar. Entre pelo código que recebeu.` }));
    }
  }

  #card(room) {
    const status = room.full
      ? { tone: "danger", text: "Sala cheia" }
      : room.sharing
        ? { tone: "ok", text: "Compartilhando tela" }
        : room.size > 1
          ? { tone: "ok", text: "Em conversa" }
          : { tone: "warn", text: "Aguardando alguém" };

    const enter = el("button.btn.btn--primary", {
      type: "button",
      disabled: room.full,
      onClick: () => this.#enter(room),
    }, [icon("arrow-right", { size: "sm" }), el("span", { text: room.full ? "Cheia" : "Entrar" })]);

    // Um canhoto por sala: o corpo diz quem e quantos, o picote separa as ações.
    return el("div.dashRoom", { role: "listitem", dataset: { key: room.code || room.name } }, [
      el("div.dashRoom__corpo", {}, [
        el("div.dashRoom__avatar", {}, [
          room.host?.avatar
            ? avatarEl(room.host.avatar, { size: 40, title: `Avatar de ${room.host.name}` })
            : el("div.avatar", { style: { width: "40px", height: "40px" } }),
        ]),
        el("div.dashRoom__info", {}, [
          el("div.dashRoom__name", {}, [
            el("span", { text: room.name }),
            room.locked ? icon("lock", { size: "sm", label: "Sala com senha" }) : null,
          ]),
          el("div.dashRoom__meta", {}, [
            el("span", { text: room.host?.name ? `por ${room.host.name}` : "sem anfitrião" }),
            el("span.dot-sep", { text: `${room.size}/${room.max} ${room.size === 1 ? "pessoa" : "pessoas"}` }),
            room.computador
              ? el("span.dot-sep.dashRoom__pc", {}, [icon("laptop", { size: "sm" }), el("span", { text: `em ${room.computador.curto}` })])
              : el("span.dot-sep.mono", { text: room.code }),
            room.visibility === "rede" ? el("span.dot-sep", { text: "só na rede" }) : null,
            room.aprovar ? el("span.dot-sep", { text: "pede para entrar" }) : null,
          ]),
        ]),
        el(`span.badge.badge--${status.tone}`, { text: status.text }),
      ]),
      el("div.dashRoom__canhoto", {}, [
        el("button.btn.btn--icon.btn--ghost", {
          type: "button",
          "aria-label": "Copiar link de convite",
          dataset: { tip: "Copiar link", "tip-placement": "left" },
          onClick: () => copy(room.computador ? `${room.computador.url}/#${room.id}` : linkFor(room.id), "Link copiado"),
        }, [icon("link")]),
        // O código só vale no servidor da sala: o de outro computador não serve aqui.
        room.computador
          ? null
          : el("button.btn.btn--icon.btn--ghost", {
              type: "button",
              "aria-label": "Copiar código da sala",
              dataset: { tip: "Copiar código", "tip-placement": "left" },
              onClick: () => copy(room.code, `Código ${room.code} copiado`),
            }, [icon("copy")]),
        enter,
      ]),
    ]);
  }

  /* ---------------------------------------------------------------- *
   * Entrada
   * ---------------------------------------------------------------- */

  #enter(room) {
    // Sala de outro computador da rede: vai até ele (a senha, se houver, é pedida lá).
    if (room.computador) {
      this.opts.irPara?.(`${room.computador.url}/#${room.id}`);
      return;
    }
    if (!room.locked) {
      this.onEnter({ roomId: room.id, pass: "", isNew: false, roomName: room.name });
      return;
    }
    this.#askPassword(room);
  }

  async #enterByCode(raw) {
    // Aceita o código ou o link curto colado inteiro (https://…/c/ABC123).
    const doLink = /\/c\/([A-Za-z0-9]{4,12})/.exec(String(raw || ""));
    const code = (doLink ? doLink[1] : String(raw || "")).trim().toUpperCase();
    if (code.length < 4) {
      toast("Digite o código de 6 caracteres da sala.", { tone: "info" });
      return;
    }
    try {
      const res = await fetch(`/api/code/${encodeURIComponent(code)}`, { cache: "no-store" });
      if (!res.ok) {
        toast("Não achei nenhuma sala com esse código. Ele expira quando a sala esvazia.", {
          tone: "warn",
        });
        return;
      }
      const data = await res.json();
      this.#enter({ id: data.id, name: data.name, locked: data.locked, code });
    } catch {
      toast("Não foi possível falar com o servidor.", { tone: "warn" });
    }
  }

  #askPassword(room) {
    const input = el("input.input", { type: "password", placeholder: "Senha da sala", autofocus: true });
    const dlg = modal({
      title: `Entrar em “${room.name || "sala privada"}”`,
      body: [
        el("p.muted", { text: "Esta sala pede senha. Peça a quem te convidou." }),
        input,
      ],
      confirm: "Entrar",
      onConfirm: () => {
        const pass = input.value;
        if (!pass) return false;
        this.onEnter({ roomId: room.id, pass, isNew: false, roomName: room.name });
        return true;
      },
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") dlg.confirm();
    });
  }

  /**
   * "Criar aqui" de outro computador da rede chega com o id da sala já
   * escolhido: o ingresso fica pronto com ele, e o nome ganha o foco.
   */
  abrirCriar({ roomId = null } = {}) {
    this.#roomIdFixo = roomId;
    this.#node?.querySelector(".bilhete")?.classList.add("is-pedido");
    this.#nomeSala?.focus();
    const empresa = document.documentElement.dataset.visual === "empresa";
    toast(
      empresa
        ? "Dê um nome à reunião, se quiser, e toque em Iniciar reunião para criá-la aqui."
        : "Dê um nome à sala, se quiser, e toque em Chamar agora para criar a call aqui.",
      { tone: "info", ms: 6000 },
    );
  }

  /**
   * Destacar o ingresso.
   *
   * O canhoto fica e o resto segue: o movimento dura meio segundo e só então
   * a antessala entra. Sem movimento (prefers-reduced-motion), entra direto.
   */
  #criar() {
    const bilhete = this.#node?.querySelector(".bilhete");
    if (!bilhete || bilhete.classList.contains("is-destacado")) return;
    const name = this.#nomeSala.value.trim().slice(0, 48);
    const aprovar = this.#aprovar.checked;
    prefs.set("room:lastName", name);
    prefs.set("room:visibilidade", this.#visibilidade);
    prefs.set("room:aprovar", aprovar);
    const entrar = () =>
      this.onEnter({
        roomId: this.#roomIdFixo || newRoomId(),
        pass: "",
        isNew: true,
        roomName: name,
        meta: { name, visibility: this.#visibilidade, aprovar },
      });
    bilhete.classList.add("is-destacado");
    // No visual Empresa não há ingresso para destacar: entra direto.
    if (calm() || document.documentElement.dataset.visual === "empresa") entrar();
    else setTimeout(entrar, 520);
  }
}

/* ==================================================================== *
 * Auxiliares
 * ==================================================================== */

export function linkFor(roomId) {
  return `${location.origin}${location.pathname}#${roomId}`;
}

export async function copy(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, { tone: "ok", ms: 2000 });
  } catch {
    toast(`Copie manualmente: ${text}`, { tone: "info", ms: 8000 });
  }
}

/** Diálogo simples em cima de <dialog>, para não reinventar foco e Escape. */
export function modal({ title, body, confirm: confirmLabel, onConfirm, onClose }) {
  const dlg = el("dialog.modal");
  const ok = el("button.btn.btn--primary", { type: "button", text: confirmLabel });
  const card = el("div.modal__card", {}, [
    el("div.modal__head", {}, [
      el("h2.modal__title", { text: title }),
      el("button.btn.btn--icon.btn--ghost", {
        type: "button",
        "aria-label": "Fechar",
        onClick: () => dlg.close(),
      }, [icon("x")]),
    ]),
    el("div.modal__body", {}, body),
    el("div.modal__foot", {}, [
      el("span.spacer"),
      el("button.btn", { type: "button", text: "Cancelar", onClick: () => dlg.close() }),
      ok,
    ]),
  ]);
  dlg.append(card);
  document.body.append(dlg);

  const run = () => {
    if (onConfirm() !== false) dlg.close();
  };
  ok.addEventListener("click", run);
  dlg.addEventListener("close", () => (dlg.remove(), onClose?.()));
  dlg.showModal();
  return { el: dlg, confirm: run };
}
