/**
 * ui/github.js — o diálogo que traz US do GitHub Projects para o Planning
 * Poker: conectar, escolher o projeto e marcar as US de uma coluna. A lógica
 * fica em features/github.js; quem fala com o GitHub é o app de mesa.
 */
import { el, icon } from "../lib/dom.js";

const ULTIMO = "vcall:github-projeto";
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
    const daColuna = () => (colunas.length ? cards.filter((c) => c.coluna === st.coluna) : cards);
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

    const desenhar = () => {
      abas.replaceChildren(
        ...colunas.map((c) => {
          const n = cards.filter((x) => x.coluna === c.id).length;
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
        const r = await kanban.importar(projeto, escolhidos, { campo: projeto.numeros.find((f) => f.id === campo.value) || null, todos: cards });
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
      el("label.gh__destino", {}, [
        el("span.field__label", { text: "A estimativa vai para" }),
        projeto.numeros.length ? campo : el("span.muted", { text: "Crie um campo de número no projeto (ex.: Estimate) para gravar." }),
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
