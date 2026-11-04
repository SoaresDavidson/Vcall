/**
 * ui/github.js — os diálogos do GitHub Projects no Planning Poker: trazer
 * US (conectar, escolher o projeto e marcar as US de uma coluna) e dividir
 * uma US grande em subtarefas novas. A lógica fica em features/github.js;
 * quem fala com o GitHub é o app de mesa.
 */
import { el, icon } from "../lib/dom.js";

const ULTIMO = "vcall:github-projeto";
const SUBS = "vcall:github-subtarefas";
const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=project,repo,read:org&description=Vcall%20Planning%20Poker";

const guardado = (k) => {
  try {
    return localStorage.getItem(k) || "";
  } catch {
    return "";
  }
};
const guardar = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* só não lembra da próxima vez */
  }
};

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
/** "há 2 dias", "ontem"… */
function haQuanto(iso) {
  let v = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(v)) return "";
  for (const [n, u] of [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"], [Infinity, "year"]]) {
    if (Math.abs(v) < n) return rtf.format(Math.round(v), u);
    v /= n;
  }
  return "";
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/**
 * @param {import("../features/github.js").KanbanGithub} kanban
 * @param {{ avisar: (texto:string, tom?:string) => void }} o
 */
export function abrirGithub(kanban, { avisar }) {
  const dlg = el("dialog.modal.gh");
  const conta = el("div.gh__conta");
  const corpo = el("div.gh__corpo");
  const erro = el("p.gh__erro", { role: "alert" });
  const pe = el("div.gh__pe");
  dlg.append(
    el("div.modal__card", {}, [
      el("div.modal__head", {}, [
        el("span.gh__marca", { "aria-hidden": "true" }, [icon("github")]),
        el("h2.modal__title", { text: "Histórias do GitHub" }),
        el("span.spacer"),
        conta,
        el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": "Fechar", onClick: () => dlg.close() }, [icon("x")]),
      ]),
      corpo,
      erro,
      pe,
    ]),
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();

  /** Projetos e o quadro aberto, para voltar sem buscar de novo. */
  const st = { login: null, projetos: null, quadro: null, coluna: null, marcados: new Set() };

  const ocupado = async (botao, fn) => {
    if (botao) botao.disabled = true;
    erro.textContent = "";
    try {
      await fn();
    } catch (err) {
      erro.textContent = err.message;
    } finally {
      if (botao) botao.disabled = false;
    }
  };

  const carregando = (texto) => {
    pe.replaceChildren();
    corpo.replaceChildren(el("div.gh__carregando", { role: "status" }, [icon("loader-2", { size: "sm", className: "icon--spin" }), el("span", { text: texto })]));
  };

  const mostrarConta = () => {
    if (!st.login && st.login !== "") return conta.replaceChildren();
    const sair = el("button.btn.btn--ghost.gh__sair", { type: "button", "aria-label": "Desconectar do GitHub" }, [icon("log-out", { size: "sm" }), el("span", { text: "Sair" })]);
    sair.addEventListener("click", () =>
      ocupado(sair, async () => {
        await kanban.ponte("sair");
        Object.assign(st, { login: null, projetos: null, quadro: null });
        telaConectar();
      }),
    );
    conta.replaceChildren(
      el("span.gh__quem", {}, [el("span.gh__inicial", { "aria-hidden": "true", text: (st.login || "?").slice(0, 1).toUpperCase() }), el("span.truncate", { text: st.login ? `@${st.login}` : "Conectado" })]),
      sair,
    );
  };

  /* ---- 1. Conectar ------------------------------------------------ */

  function telaConectar() {
    mostrarConta();
    pe.replaceChildren();
    const token = el("input.input.mono", { type: "password", autocomplete: "off", spellcheck: false, placeholder: "ghp_…", "aria-label": "Token do GitHub" });
    const conectar = el("button.btn.btn--primary", { type: "button", text: "Conectar" });
    conectar.addEventListener("click", () =>
      ocupado(conectar, async () => {
        const r = await kanban.ponte("conectar", { token: token.value });
        st.login = r.login || "";
        await telaProjetos();
      }),
    );
    token.addEventListener("keydown", (e) => e.key === "Enter" && conectar.click());
    corpo.replaceChildren(
      el("div.gh__intro", {}, [
        el("span.gh__selo", { "aria-hidden": "true" }, [icon("list-checks")]),
        el("div", {}, [
          el("h3.gh__titulo", { text: "Traga a sprint para a mesa" }),
          el("p.muted", { text: "As US de uma coluna do GitHub Projects viram histórias, com descrição, critérios de aceite e subtarefas. A estimativa que vocês salvarem volta para o card." }),
        ]),
      ]),
      el("ol.gh__passos", {}, [
        el("li", {}, [
          el("span.gh__n", { text: "1", "aria-hidden": "true" }),
          el("div.gh__passo", {}, [
            el("strong", { text: "Gere um token no GitHub" }),
            el("span.muted", { text: "Token clássico. Os escopos já vêm marcados: project, repo (para repositórios privados) e read:org." }),
          ]),
          el("a.btn", { href: TOKEN_URL, target: "_blank", rel: "noopener noreferrer" }, [el("span", { text: "Abrir o GitHub" })]),
        ]),
        el("li", {}, [
          el("span.gh__n", { text: "2", "aria-hidden": "true" }),
          el("div.gh__passo", {}, [el("strong", { text: "Cole o token aqui" }), el("div.row", {}, [token, conectar])]),
        ]),
      ]),
      el("p.gh__fino", {}, [icon("shield-check", { size: "sm" }), el("span", { text: "Fica cifrado neste computador. Só o seu Vcall usa, e só nas salas abertas por ele." })]),
    );
    token.focus();
  }

  /* ---- 2. Projeto ------------------------------------------------- */

  async function telaProjetos() {
    mostrarConta();
    if (!st.projetos) {
      carregando("Buscando seus projetos…");
      try {
        st.projetos = await kanban.ponte("projetos");
      } catch (err) {
        st.projetos = [];
        erro.textContent = err.message;
      }
    }
    pe.replaceChildren();
    const ultimo = guardado(ULTIMO);
    const projetos = [...st.projetos].sort((a, b) => (b.id === ultimo) - (a.id === ultimo));
    const filtro = el("input.input", { type: "search", placeholder: "Procurar projeto", "aria-label": "Procurar projeto" });
    const lista = el("ul.gh__lista", { "aria-label": "Seus projetos" });
    const desenhar = () => {
      const q = filtro.value.trim().toLowerCase();
      const itens = projetos.filter((p) => !q || `${p.titulo} ${p.dono}`.toLowerCase().includes(q));
      lista.replaceChildren(
        ...itens.map((p) =>
          el("li", {}, [
            el("button.gh__projeto", { type: "button", onClick: () => abrirQuadro({ id: p.id }) }, [
              el("span.gh__projIco", { "aria-hidden": "true" }, [icon("layout-grid", { size: "sm" })]),
              el("span.gh__projTxt", {}, [
                el("strong.truncate", { text: p.titulo }),
                el("span.truncate", { text: [p.dono, `#${p.numero}`, p.cards != null ? plural(p.cards, "card", "cards") : "", haQuanto(p.atualizado)].filter(Boolean).join(" · ") }),
              ]),
              p.id === ultimo ? el("span.badge.badge--accent", { text: "último" }) : null,
              icon("chevron-right", { size: "sm" }),
            ]),
          ]),
        ),
      );
      if (!itens.length) lista.append(el("li.gh__vazio", { text: projetos.length ? "Nenhum projeto com esse nome." : "Nenhum projeto apareceu para este token. Cole o endereço abaixo." }));
    };
    filtro.addEventListener("input", desenhar);
    desenhar();
    const endereco = el("input.input", { type: "url", placeholder: "https://github.com/orgs/empresa/projects/3", "aria-label": "Endereço do projeto" });
    const abrir = el("button.btn", { type: "button", text: "Abrir" });
    abrir.addEventListener("click", () => abrirQuadro({ endereco: endereco.value }, abrir));
    endereco.addEventListener("keydown", (e) => e.key === "Enter" && abrir.click());
    corpo.replaceChildren(
      ...(projetos.length > 6 ? [filtro] : []),
      lista,
      el("div.gh__outro", {}, [el("span.field__label", { text: "Ou cole o endereço de um projeto" }), el("div.row", {}, [endereco, abrir])]),
    );
    (projetos.length > 6 ? filtro : lista.querySelector("button") || endereco).focus();
  }

  async function abrirQuadro(ref, botao = null) {
    await ocupado(botao, async () => {
      if (!botao) carregando("Abrindo o quadro…");
      try {
        st.quadro = await kanban.abrir(ref);
      } catch (err) {
        if (!botao) await telaProjetos();
        throw err;
      }
      guardar(ULTIMO, st.quadro.projeto.id);
      const colunas = st.quadro.projeto.status?.colunas || [];
      // Começa pela coluna com mais US ainda sem estimativa (em geral a do próximo sprint).
      const semEstimativa = (c) => st.quadro.cards.filter((x) => x.coluna === c.id && x.estimativa == null).length;
      st.coluna = [...colunas].sort((a, b) => semEstimativa(b) - semEstimativa(a))[0]?.id ?? null;
      telaCards();
    });
  }

  /* ---- 3. US da coluna -------------------------------------------- */

  function telaCards() {
    mostrarConta();
    const { projeto, cards } = st.quadro;
    const naMesa = kanban.naMesa();
    const colunas = projeto.status?.colunas || [];
    // Uma sub-issue cuja US também está no quadro vem junto com ela: não aparece solta.
    const urls = new Set(cards.map((c) => c.url).filter(Boolean));
    const soltos = cards.filter((c) => !(c.pai && urls.has(c.pai)));
    const daColuna = () => (colunas.length ? soltos.filter((c) => c.coluna === st.coluna) : soltos);
    const padrao = () => new Set(daColuna().filter((c) => !naMesa.has(c.item) && c.estimativa == null).map((c) => c.item));
    st.marcados = padrao();

    const voltar = el("button.btn.btn--ghost.gh__voltar", { type: "button", onClick: () => telaProjetos() }, [icon("chevron-left", { size: "sm" }), el("span", { text: "Projetos" })]);
    const abas = el("div.gh__colunas", { role: "group", "aria-label": "Colunas do quadro" });
    const todas = el("input", { type: "checkbox", "aria-label": "Marcar todas" });
    const contagem = el("span.muted");
    const lista = el("ul.gh__cards", { "aria-label": "US da coluna" });
    const campo = el("select.input.gh__campo", { "aria-label": "Campo que recebe a estimativa" }, [
      el("option", { value: "", text: "Não gravar no GitHub" }),
      ...projeto.numeros.map((f) => el("option", { value: f.id, text: f.nome })),
    ]);
    campo.value = st.quadro.campo?.id || "";
    const importar = el("button.btn.btn--primary", { type: "button" });
    const comSubs = el("input", { type: "checkbox", checked: guardado(SUBS) !== "0" });
    comSubs.addEventListener("change", () => guardar(SUBS, comSubs.checked ? "1" : "0"));

    const desenhar = () => {
      abas.replaceChildren(
        ...colunas.map((c) => {
          const n = soltos.filter((x) => x.coluna === c.id).length;
          return el("button.gh__aba", { type: "button", "aria-pressed": String(c.id === st.coluna), onClick: () => ((st.coluna = c.id), (st.marcados = padrao()), desenhar()) }, [
            el("span", { text: c.nome }),
            el("span.gh__qtd", { text: String(n) }),
          ]);
        }),
      );
      const vis = daColuna();
      const livres = vis.filter((c) => !naMesa.has(c.item));
      lista.replaceChildren(
        ...vis.map((c) => {
          const mesa = naMesa.has(c.item);
          const caixa = el("input", { type: "checkbox", checked: st.marcados.has(c.item), disabled: mesa, "aria-label": c.titulo });
          caixa.addEventListener("change", () => {
            if (caixa.checked) st.marcados.add(c.item);
            else st.marcados.delete(c.item);
            rodape();
          });
          return el("li", {}, [
            el("label.gh__card", { class: mesa ? "is-mesa" : "" }, [
              caixa,
              c.numero ? el("span.gh__num", { text: `#${c.numero}` }) : el("span.gh__num", { text: "rascunho" }),
              el("span.gh__cardTit", { text: c.titulo }),
              el("span.gh__chips", {}, [
                c.subs ? el("span.gh__chip", { title: `${c.subs.feitas} de ${c.subs.total} subtarefas fechadas` }, [icon("list-checks", { size: "sm" }), el("span", { text: `${c.subs.feitas}/${c.subs.total}` })]) : null,
                mesa ? el("span.gh__chip", { text: "na mesa" }) : c.estimativa != null ? el("span.gh__chip.gh__chip--est", { title: "Já estimada", text: String(c.estimativa) }) : null,
              ]),
            ]),
          ]);
        }),
      );
      if (!vis.length) lista.append(el("li.gh__vazio", { text: "Nenhuma US nesta coluna." }));
      todas.disabled = !livres.length;
      rodape();
    };

    const rodape = () => {
      const livres = daColuna().filter((c) => !naMesa.has(c.item));
      const n = livres.filter((c) => st.marcados.has(c.item)).length;
      todas.checked = !!livres.length && n === livres.length;
      todas.indeterminate = n > 0 && n < livres.length;
      contagem.textContent = livres.length ? `${n} de ${livres.length} marcadas` : "Todas já estão na mesa";
      importar.replaceChildren(icon("download", { size: "sm" }), el("span", { text: n ? `Importar ${n} US` : "Importar" }));
      importar.disabled = !n;
    };

    todas.addEventListener("change", () => {
      for (const c of daColuna()) if (!naMesa.has(c.item)) todas.checked ? st.marcados.add(c.item) : st.marcados.delete(c.item);
      desenhar();
    });
    importar.addEventListener("click", () =>
      ocupado(importar, async () => {
        const escolhidos = cards.filter((c) => st.marcados.has(c.item));
        importar.replaceChildren(icon("loader-2", { size: "sm", className: "icon--spin" }), el("span", { text: "Trazendo subtarefas…" }));
        const r = await kanban.importar(projeto, escolhidos, { campo: projeto.numeros.find((f) => f.id === campo.value) || null, todos: cards, subtarefas: comSubs.checked });
        avisar(`${plural(r.novos, "US importada", "US importadas")}${r.faltam ? `; importe de novo para trazer mais ${r.faltam}` : ""}`, "ok");
        dlg.close();
      }).finally(() => dlg.isConnected && rodape()),
    );

    corpo.replaceChildren(
      el("div.gh__topo", {}, [voltar, el("strong.truncate", { text: projeto.titulo })]),
      colunas.length ? abas : el("p.muted", { text: "O projeto não tem colunas: aparecem todos os cards." }),
      el("label.gh__todas", {}, [todas, el("span", { text: "Marcar todas" }), el("span.spacer"), contagem]),
      lista,
    );
    pe.replaceChildren(
      el("div.gh__opcoesPe", {}, [
        el("label.gh__destino", {}, [
          el("span.field__label", { text: "A estimativa vai para" }),
          projeto.numeros.length ? campo : el("span.muted", { text: "Crie um campo de número no projeto (ex.: Estimate) para gravar." }),
        ]),
        el("label.gh__outra", { dataset: { tip: "Cada sub-issue aberta vira um item da mesa, logo abaixo da US" } }, [comSubs, icon("gh-sub-issue", { size: "sm" }), el("span", { text: "Votar também as subtarefas" })]),
      ]),
      importar,
    );
    desenhar();
  }

  /* ---- começo ------------------------------------------------------ */

  carregando("Conectando…");
  kanban
    .ponte("estado")
    .then((r) => {
      if (!dlg.isConnected) return;
      if (!r.conectado) return telaConectar();
      st.login = r.login || "";
      return telaProjetos();
    })
    .catch((err) => corpo.replaceChildren(el("div.gh__carregando", {}, [icon("alert-triangle", { size: "sm" }), el("span", { text: err.message })])));
}

/* ------------------------------------------------------------------ *
 * Dividir: subtarefas novas no GitHub, embaixo da US em votação
 * ------------------------------------------------------------------ */

const bolinha = (cor) => el("span.gh__bolinha", { "aria-hidden": "true", style: cor ? { "--cor": `#${cor}` } : {} });

/**
 * Escolha de vários (responsáveis, etiquetas) como no GitHub: a lista abre
 * com uma busca e o escolhido fica à vista embaixo do nome.
 * @param {{ nome:string, icone:string, vazio:string, opcoes:{id:string, rotulo:string, detalhe?:string, cor?:string}[] }} o
 */
function seletor({ nome, icone, vazio, opcoes }) {
  const marcados = new Set();
  const escolhidos = el("div.gh__escolhidos");
  const filtro = el("input.input", { type: "search", placeholder: "Procurar", "aria-label": `Procurar em ${nome.toLowerCase()}` });
  const lista = el("ul.gh__opcoes", { "aria-label": nome });
  const caixa = el("details.gh__seletor", {}, [
    el("summary.gh__secao", {}, [icon(icone, { size: "sm" }), el("span", { text: nome }), el("span.spacer"), icon("chevron-down", { size: "sm", className: "gh__seta" })]),
    el("div.gh__pop", {}, [filtro, lista]),
  ]);
  const mostrarEscolhidos = () =>
    escolhidos.replaceChildren(
      ...(marcados.size
        ? opcoes.filter((o) => marcados.has(o.id)).map((o) => el("span.gh__escolhido", {}, [o.cor ? bolinha(o.cor) : null, el("span", { text: o.rotulo })]))
        : [el("span.muted", { text: vazio })]),
    );
  const mostrarLista = () => {
    const q = filtro.value.trim().toLowerCase();
    const vis = opcoes.filter((o) => !q || `${o.rotulo} ${o.detalhe || ""}`.toLowerCase().includes(q)).slice(0, 80);
    lista.replaceChildren(
      ...vis.map((o) => {
        const cx = el("input", { type: "checkbox", checked: marcados.has(o.id) });
        cx.addEventListener("change", () => {
          if (cx.checked) marcados.add(o.id);
          else marcados.delete(o.id);
          mostrarEscolhidos();
        });
        return el("li", {}, [
          el("label.gh__opcao", {}, [cx, o.cor ? bolinha(o.cor) : null, el("span.gh__opcaoTxt", {}, [el("span", { text: o.rotulo }), o.detalhe ? el("span.muted.truncate", { text: o.detalhe }) : null])]),
        ]);
      }),
    );
    if (!vis.length) lista.append(el("li.gh__vazio", { text: opcoes.length ? "Nada com esse nome." : "Nada para escolher neste repositório." }));
  };
  filtro.addEventListener("input", mostrarLista);
  // Esc fecha só a lista, não o formulário inteiro (e o que já foi escrito).
  caixa.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !caixa.open) return;
    e.preventDefault();
    e.stopPropagation();
    caixa.open = false;
    caixa.querySelector("summary").focus();
  });
  caixa.addEventListener("toggle", () => {
    if (!caixa.open) return;
    mostrarLista();
    filtro.focus();
  });
  mostrarEscolhidos();
  return {
    el: el("div.gh__campoLado", {}, [caixa, escolhidos]),
    caixa,
    ids: () => [...marcados],
    escolhidos: () => opcoes.filter((o) => marcados.has(o.id)),
  };
}

/** Um campo de uma escolha só, na coluna do lado: o nome com o ícone e um select. */
function campoLado(nome, icone, controle) {
  return el("label.gh__campoLado", {}, [el("span.gh__secao", {}, [icon(icone, { size: "sm" }), el("span", { text: nome })]), controle]);
}

const opcoesSelect = (vazio, itens) => [el("option", { value: "", text: vazio }), ...itens.map(([v, t]) => el("option", { value: v, text: t }))];

/**
 * O formulário que cria subtarefas no GitHub embaixo da história `historia`
 * (a US ou a subtarefa que ficou grande demais), com o que dá para escolher
 * ao criar uma issue lá. Cada uma entra na mesa logo abaixo.
 * @param {import("../features/github.js").KanbanGithub} kanban
 */
export function abrirDividir(kanban, historia, { avisar }) {
  const dlg = el("dialog.modal.gh.gh--dividir");
  const corpo = el("div.gh__corpo");
  const erro = el("p.gh__erro", { role: "alert" });
  const pe = el("div.gh__pe");
  dlg.append(
    el("div.modal__card", {}, [
      el("div.modal__head", {}, [
        el("span.gh__marca", { "aria-hidden": "true" }, [icon("github")]),
        el("h2.modal__title", { text: "Dividir em subtarefas" }),
        el("span.spacer"),
        el("button.btn.btn--icon.btn--ghost", { type: "button", "aria-label": "Fechar", onClick: () => dlg.close() }, [icon("x")]),
      ]),
      corpo,
      erro,
      pe,
    ]),
  );
  // Digitar aqui não aciona os atalhos da chamada.
  dlg.addEventListener("keydown", (e) => e.key !== "Escape" && e.stopPropagation());
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  corpo.replaceChildren(el("div.gh__carregando", { role: "status" }, [icon("loader-2", { size: "sm", className: "icon--spin" }), el("span", { text: "Lendo o repositório…" })]));

  kanban
    .formulario(historia)
    .then((f) => dlg.isConnected && montar(f))
    .catch((err) => corpo.replaceChildren(el("div.gh__carregando", {}, [icon("alert-triangle", { size: "sm" }), el("span", { text: err.message })])));

  function montar({ repo, quadro, coluna, cartas }) {
    const titulo = el("input.input", { type: "text", maxLength: 256, placeholder: "O que precisa ser feito", "aria-label": "Título", autocomplete: "off" });
    const desc = el("textarea.input.gh__desc", { rows: 7, maxLength: 60000, placeholder: "Detalhes, contexto, como testar… (aceita Markdown)", "aria-label": "Descrição" });
    const inserir = (texto) => {
      desc.focus();
      desc.setRangeText(texto, desc.selectionStart, desc.selectionEnd, "end");
    };
    const atalhoCriterios = el("button.btn.btn--ghost.gh__mini", { type: "button", onClick: () => inserir(`${desc.value && !desc.value.endsWith("\n") ? "\n\n" : ""}## Critérios de aceite\n- [ ] `) }, [
      icon("list-checks", { size: "sm" }),
      el("span", { text: "Critérios de aceite" }),
    ]);

    const pessoas = seletor({ nome: "Responsáveis", icone: "gh-people", vazio: "Ninguém", opcoes: repo.pessoas.map((p) => ({ id: p.id, rotulo: p.login, detalhe: p.nome })) });
    const etiquetas = seletor({ nome: "Etiquetas", icone: "gh-tag", vazio: "Nenhuma", opcoes: repo.etiquetas.map((e) => ({ id: e.id, rotulo: e.nome, detalhe: e.descricao, cor: e.cor })) });
    const tipo = el("select.input", { "aria-label": "Tipo" }, opcoesSelect("Sem tipo", repo.tipos.map((t) => [t.id, t.nome])));
    const marco = el("select.input", { "aria-label": "Marco" }, opcoesSelect("Sem marco", repo.marcos.map((m) => [m.id, m.prazo ? `${m.titulo} · até ${new Date(m.prazo).toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : m.titulo])));
    marco.value = repo.marcos.some((m) => m.id === repo.pai.marco) ? repo.pai.marco : ""; // o marco da US, como ponto de partida
    const colunas = quadro.projeto.status?.colunas || [];
    const colunaSel = el("select.input", { "aria-label": "Coluna do quadro" }, opcoesSelect("Sem coluna", colunas.map((c) => [c.id, c.nome])));
    colunaSel.value = colunas.some((c) => c.id === coluna) ? coluna : "";
    const estimativa = el("select.input", { "aria-label": `Estimativa (${quadro.campo?.nome || ""})` }, opcoesSelect("Votar depois", cartas.map((c) => [c, c])));
    // Clicar fora da lista aberta fecha a lista.
    dlg.addEventListener("pointerdown", (e) => {
      for (const s of [pessoas, etiquetas]) if (s.caixa.open && !s.caixa.contains(e.target)) s.caixa.open = false;
    });

    const criadas = el("ul.gh__criadas", { "aria-label": "Criadas agora" });
    const outra = el("input", { type: "checkbox" });
    const criar = el("button.btn.btn--primary", { type: "button" }, [icon("github", { size: "sm" }), el("span", { text: "Criar subtarefa" })]);
    const enviar = async () => {
      erro.textContent = "";
      if (!titulo.value.trim()) {
        erro.textContent = "Dê um título para a subtarefa.";
        return titulo.focus();
      }
      criar.disabled = true;
      try {
        const tipoEsc = repo.tipos.find((t) => t.id === tipo.value);
        const r = await kanban.criarSubtarefa(
          historia,
          {
            repositorio: repo.id,
            titulo: titulo.value,
            corpo: desc.value,
            pessoas: pessoas.ids(),
            etiquetas: etiquetas.ids(),
            marco: marco.value,
            tipo: tipo.value,
            coluna: colunaSel.value,
            estimativa: quadro.campo ? estimativa.value : "",
          },
          {
            etiquetas: etiquetas.escolhidos().map((e) => ({ nome: e.rotulo, cor: e.cor })),
            pessoas: pessoas.escolhidos().map((p) => p.rotulo),
            tipo: tipoEsc ? { nome: tipoEsc.nome, cor: tipoEsc.cor } : null,
          },
        );
        if (r.aviso) avisar(r.aviso, "warn");
        else avisar(`Subtarefa #${r.numero} criada no GitHub`, "ok");
        criadas.append(el("li", {}, [icon("gh-issue", { size: "sm" }), el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", text: `#${r.numero}` }), el("span.truncate", { text: r.titulo })]));
        if (!outra.checked) return dlg.close();
        // Como no GitHub: o resto fica escolhido para a próxima.
        titulo.value = "";
        desc.value = "";
        estimativa.value = "";
        titulo.focus();
      } catch (err) {
        erro.textContent = err.message;
      } finally {
        criar.disabled = false;
      }
    };
    criar.addEventListener("click", enviar);
    titulo.addEventListener("keydown", (e) => e.key === "Enter" && enviar());
    desc.addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && enviar());

    const pai = historia.gh?.numero ? `#${historia.gh.numero} · ${historia.titulo}` : historia.titulo;
    corpo.replaceChildren(
      el("div.gh__pai", {}, [
        icon("gh-sub-issue", { size: "sm" }),
        el("span.muted", { text: "Embaixo de" }),
        el("strong.truncate", { text: pai }),
        el("span.spacer"),
        el("span.gh__repo", {}, [icon("github", { size: "sm" }), el("span.truncate", { text: repo.nome })]),
      ]),
      el("div.gh__form", {}, [
        el("div.gh__principal", {}, [
          el("label.gh__rotulo", {}, [el("span.field__label", { text: "Título" }), titulo]),
          el("div.gh__rotulo", {}, [el("div.row", {}, [el("span.field__label", { text: "Descrição" }), el("span.spacer"), atalhoCriterios]), desc]),
          criadas,
        ]),
        el("aside.gh__lado", { "aria-label": "Detalhes da issue" }, [
          pessoas.el,
          etiquetas.el,
          repo.tipos.length ? campoLado("Tipo", "gh-issue", tipo) : null,
          campoLado("Marco", "gh-milestone", repo.marcos.length ? marco : el("span.muted", { text: "Nenhum marco aberto" })),
          el("div.gh__campoLado.gh__projetoLado", {}, [
            el("span.gh__secao", {}, [icon("gh-project", { size: "sm" }), el("span.truncate", { text: quadro.projeto.titulo || "Projeto" })]),
            colunas.length ? el("label.gh__sub", {}, [el("span.muted", { text: "Coluna" }), colunaSel]) : null,
            quadro.campo ? el("label.gh__sub", {}, [el("span.muted", { text: quadro.campo.nome }), estimativa]) : el("span.muted", { text: "Sem campo de estimativa" }),
          ]),
        ]),
      ]),
    );
    pe.replaceChildren(el("label.gh__outra", {}, [outra, el("span", { text: "Criar outra depois desta" })]), el("span.spacer"), criar);
    titulo.focus();
  }
}
