/**
 * desktop/github.js — o quadro (kanban) de um GitHub Project no Planning Poker.
 *
 * Mora no processo principal porque a página só fala com o próprio servidor
 * (connect-src 'self', src/http.js). O token também fica aqui, cifrado pelo
 * sistema (safeStorage), e a página só pede operações fechadas: listar os
 * projetos, ler um quadro e os cards dele (com descrição e subtarefas),
 * gravar um número num card e criar uma subtarefa embaixo de uma issue.
 * Nada de GraphQL livre: um script injetado na página não ganha o token inteiro.
 */
import { app, safeStorage } from "electron";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.github.com/graphql";
const arquivo = () => path.join(app.getPath("userData"), "github.token");
let token = null;
let login = null;
let carregado = false;

/** "github.com/orgs/acme/projects/3" ou ".../users/ana/projects/1" (com ou sem /views/…). */
export function lerEndereco(texto) {
  const m = /github\.com\/(orgs|users)\/([A-Za-z0-9-]{1,39})\/projects\/(\d{1,7})(?:[/?#]|$)/i.exec(String(texto || "").trim());
  return m && { dono: m[1].toLowerCase() === "orgs" ? "organization" : "user", login: m[2], numero: Number(m[3]) };
}

async function lerToken() {
  if (carregado) return token;
  carregado = true;
  try {
    if (safeStorage.isEncryptionAvailable()) token = safeStorage.decryptString(await readFile(arquivo()));
  } catch {
    token = null;
  }
  return token;
}

function traduzir(erro) {
  if (erro?.type === "INSUFFICIENT_SCOPES") return "O token precisa do escopo “project” (ou “read:project” para só importar).";
  if (erro?.type === "NOT_FOUND") return "Projeto não encontrado. Confira o endereço e se o token tem acesso a ele.";
  return String(erro?.message || "O GitHub recusou o pedido.");
}

async function gql(query, variables = {}, t = token) {
  if (!t) throw new Error("Conecte o GitHub primeiro.");
  let r;
  try {
    r = await fetch(API, {
      method: "POST",
      headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json", "User-Agent": "Vcall" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Sem resposta do GitHub. Confira a internet.");
  }
  if (r.status === 401) throw new Error("O GitHub recusou o token. Gere outro e conecte de novo.");
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) throw new Error(traduzir(j.errors[0]));
  if (!r.ok) throw new Error(`O GitHub respondeu ${r.status}.`);
  return j.data;
}

async function estado() {
  if (!(await lerToken())) return { conectado: false };
  if (!login) login = (await gql("query { viewer { login } }").catch(() => null))?.viewer?.login || null;
  return { conectado: true, login };
}

async function conectar(novo) {
  const t = String(novo || "").trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new Error("Isso não parece um token do GitHub.");
  const d = await gql("query { viewer { login } }", {}, t);
  token = t;
  login = d.viewer.login;
  carregado = true;
  // Sem cifra do sistema (alguns Linux), o token vale só até fechar o app: nunca vai em texto puro para o disco.
  if (safeStorage.isEncryptionAvailable()) await writeFile(arquivo(), safeStorage.encryptString(t), { mode: 0o600 });
  return { conectado: true, login };
}

async function sair() {
  token = login = null;
  carregado = true;
  await rm(arquivo(), { force: true });
  return { conectado: false };
}

const CAMPOS = "id title fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } } }";
const RESUMO = "id title number url closed updatedAt items { totalCount }";

/** Os projetos que o token enxerga: os da pessoa e os das organizações dela. */
async function projetos() {
  const d = await gql(`query { viewer {
    login projectsV2(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${RESUMO} } }
    organizations(first: 20) { nodes { login projectsV2(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${RESUMO} } } } }
  } }`);
  const v = d.viewer;
  const lista = [
    ...v.projectsV2.nodes.map((p) => ({ ...p, dono: v.login })),
    ...v.organizations.nodes.flatMap((o) => (o?.projectsV2?.nodes || []).map((p) => ({ ...p, dono: o.login }))),
  ];
  return lista
    .filter((p) => p && !p.closed)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((p) => ({ id: p.id, titulo: p.title, numero: p.number, dono: p.dono, url: p.url, atualizado: p.updatedAt, cards: p.items?.totalCount ?? null }));
}

/** As colunas do quadro (o campo Status) e os campos numéricos onde dá para gravar a estimativa. */
async function projeto({ id = "", endereco = "" }) {
  let p;
  if (id) {
    p = (await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${CAMPOS} } } }`, { id: String(id) }))?.node;
  } else {
    const e = lerEndereco(endereco);
    if (!e) throw new Error("Cole o endereço do projeto, como github.com/orgs/empresa/projects/3.");
    // `e.dono` é "organization" ou "user" (lerEndereco), nunca texto de quem pediu.
    p = (await gql(`query($login: String!, $n: Int!) { dono: ${e.dono}(login: $login) { projectV2(number: $n) { ${CAMPOS} } } }`, { login: e.login, n: e.numero }))?.dono?.projectV2;
  }
  if (!p?.id) throw new Error("Projeto não encontrado.");
  const campos = p.fields.nodes.filter((f) => f?.id);
  const selecao = campos.filter((f) => f.dataType === "SINGLE_SELECT");
  const status = selecao.find((f) => /^status$/i.test(f.name)) || selecao[0];
  return {
    id: p.id,
    titulo: p.title,
    status: status ? { id: status.id, nome: status.name, colunas: status.options.map((o) => ({ id: o.id, nome: o.name })) } : null,
    numeros: campos.filter((f) => f.dataType === "NUMBER").map((f) => ({ id: f.id, nome: f.name })),
  };
}

const ITENS = `query($id: ID!, $after: String, $status: String!, $campo: String!, $temStatus: Boolean!, $temCampo: Boolean!) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isArchived
      coluna: fieldValueByName(name: $status) @include(if: $temStatus) { ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
      valor: fieldValueByName(name: $campo) @include(if: $temCampo) { ... on ProjectV2ItemFieldNumberValue { number } }
      content {
        ... on Issue { id title number url subIssuesSummary { total completed } parent { url } }
        ... on PullRequest { title number url }
        ... on DraftIssue { title }
      }
    } } } } }`;

/** Todos os cards do quadro, na ordem dele, com a coluna, a estimativa e o resumo das subtarefas. */
async function cards({ projeto: id, status = "", campo = "" }) {
  const lista = [];
  let after = null;
  for (let pagina = 0; pagina < 10; pagina++) {
    const d = await gql(ITENS, { id: String(id), after, status: String(status), campo: String(campo), temStatus: !!status, temCampo: !!campo });
    const itens = d?.node?.items;
    if (!itens) break;
    for (const n of itens.nodes) {
      if (!n || n.isArchived || !n.content?.title) continue;
      const s = n.content.subIssuesSummary;
      lista.push({
        item: n.id,
        titulo: n.content.title,
        numero: n.content.number ?? null,
        url: n.content.url ?? null,
        conteudo: n.content.id ?? null,
        pai: n.content.parent?.url ?? null,
        coluna: n.coluna?.optionId ?? null,
        estimativa: n.valor?.number ?? null,
        subs: s?.total ? { total: s.total, feitas: s.completed } : null,
      });
    }
    if (!itens.pageInfo.hasNextPage) break;
    after = itens.pageInfo.endCursor;
  }
  return lista;
}

const MARCAS = "labels(first: 10) { nodes { name color } } assignees(first: 6) { nodes { login } } issueType { name color }";
const DETALHES = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { id content {
  ... on Issue { body ${MARCAS} subIssues(first: 50) { totalCount nodes { id title number url state body ${MARCAS} } } }
  ... on PullRequest { body }
  ... on DraftIssue { body }
} } } }`;

/** Etiquetas, responsáveis e tipo de uma issue. */
const marcas = (c) => ({
  etiquetas: (c?.labels?.nodes || []).filter(Boolean).map((l) => ({ nome: l.name, cor: l.color })),
  pessoas: (c?.assignees?.nodes || []).filter(Boolean).map((a) => a.login),
  tipo: c?.issueType ? { nome: c.issueType.name, cor: c.issueType.color } : null,
});

/** A descrição e as sub-issues (com a descrição delas) dos cards escolhidos, até 100 de uma vez. */
async function detalhes({ itens = [] }) {
  const ids = [...new Set((Array.isArray(itens) ? itens : []).map(String))].slice(0, 100);
  if (!ids.length) return {};
  const d = await gql(DETALHES, { ids });
  const out = {};
  for (const n of d?.nodes || []) {
    if (!n?.id) continue;
    const c = n.content || {};
    out[n.id] = {
      corpo: String(c.body || "").slice(0, 20000),
      marcas: marcas(c),
      subs: (c.subIssues?.nodes || []).filter(Boolean).map((s) => ({
        conteudo: s.id,
        titulo: s.title,
        numero: s.number,
        url: s.url,
        feita: s.state === "CLOSED",
        corpo: String(s.body || "").slice(0, 8000),
        marcas: marcas(s),
      })),
      subsTotal: c.subIssues?.totalCount ?? 0,
    };
  }
  return out;
}

/** Põe a issue no quadro (se já estiver, o GitHub devolve o mesmo card) e devolve o id do card. */
async function noQuadro(projetoId, conteudo) {
  if (!conteudo) throw new Error("Este card não é uma issue.");
  const d = await gql("mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }", { p: String(projetoId), c: String(conteudo) });
  return d.addProjectV2ItemById.item.id;
}

/** `valor`: { number } ou { singleSelectOptionId } (ProjectV2FieldValue). */
const definirCampo = (projetoId, item, campo, valor) =>
  gql("mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: $v }) { projectV2Item { id } } }", {
    p: String(projetoId),
    i: String(item),
    f: String(campo),
    v: valor,
  });

/**
 * Grava o número no card. Uma subtarefa que ainda não está no quadro (`item`
 * vazio, só a issue em `conteudo`) entra nele antes, na `coluna` da US.
 */
async function estimar({ projeto: p, item, conteudo, campo, numero, coluna }) {
  const n = Number(numero);
  if (!Number.isFinite(n)) throw new Error("A estimativa não é um número.");
  let i = item;
  if (!i) {
    i = await noQuadro(p, conteudo);
    if (coluna?.campo && coluna?.opcao) await definirCampo(p, i, coluna.campo, { singleSelectOptionId: String(coluna.opcao) });
  }
  await definirCampo(p, i, campo, { number: n });
  return { item: i };
}

const REPOSITORIO = `query($id: ID!) { node(id: $id) { ... on Issue { number title milestone { id } repository {
  id nameWithOwner
  assignableUsers(first: 100) { nodes { id login name } }
  labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { id name color description } }
  milestones(first: 50, states: OPEN, orderBy: { field: DUE_DATE, direction: ASC }) { nodes { id title dueOn } }
  issueTypes(first: 25) { nodes { id name color description isEnabled } }
} } } }`;

/** O que dá para escolher ao criar uma issue no repositório da issue `issue`: pessoas, etiquetas, marcos e tipos. */
async function repositorio({ issue }) {
  const i = (await gql(REPOSITORIO, { id: String(issue || "") }))?.node;
  const r = i?.repository;
  if (!r) throw new Error("Issue não encontrada.");
  const nos = (v) => (v?.nodes || []).filter(Boolean);
  return {
    id: r.id,
    nome: r.nameWithOwner,
    pai: { numero: i.number, titulo: i.title, marco: i.milestone?.id ?? null },
    pessoas: nos(r.assignableUsers).map((u) => ({ id: u.id, login: u.login, nome: u.name || "" })),
    etiquetas: nos(r.labels).map((l) => ({ id: l.id, nome: l.name, cor: l.color, descricao: l.description || "" })),
    marcos: nos(r.milestones).map((m) => ({ id: m.id, titulo: m.title, prazo: m.dueOn })),
    tipos: nos(r.issueTypes).filter((t) => t.isEnabled !== false).map((t) => ({ id: t.id, nome: t.name, cor: t.color, descricao: t.description || "" })),
  };
}

const ids = (v, max) => (Array.isArray(v) ? v : []).map(String).filter(Boolean).slice(0, max);

/**
 * Cria uma issue como sub-issue de `pai`, com o que dá para escolher no
 * GitHub, e põe no quadro com a coluna e a estimativa. A issue criada não se
 * perde se o quadro falhar: volta com um `aviso`.
 */
async function criar({ pai, repositorio: repo, titulo, corpo = "", pessoas, etiquetas, marco, tipo, projeto: p, coluna, estimativa }) {
  const t = String(titulo || "").trim();
  if (!t) throw new Error("Dê um título para a subtarefa.");
  if (!pai || !repo) throw new Error("Falta a issue de cima.");
  const entrada = {
    repositoryId: String(repo),
    parentIssueId: String(pai),
    title: t.slice(0, 256),
    body: String(corpo || "").slice(0, 60000),
    assigneeIds: ids(pessoas, 10),
    labelIds: ids(etiquetas, 20),
    ...(marco ? { milestoneId: String(marco) } : {}),
    ...(tipo ? { issueTypeId: String(tipo) } : {}),
  };
  const issue = (await gql("mutation($i: CreateIssueInput!) { createIssue(input: $i) { issue { id number url title } } }", { i: entrada })).createIssue.issue;
  const r = { conteudo: issue.id, numero: issue.number, url: issue.url, titulo: issue.title, item: null, aviso: null };
  if (!p) return r;
  try {
    r.item = await noQuadro(p, issue.id);
    if (coluna?.campo && coluna?.opcao) await definirCampo(p, r.item, coluna.campo, { singleSelectOptionId: String(coluna.opcao) });
    const n = estimativa?.numero === "" || estimativa?.numero == null ? NaN : Number(estimativa.numero);
    if (estimativa?.campo && Number.isFinite(n)) await definirCampo(p, r.item, estimativa.campo, { number: n });
  } catch (err) {
    r.aviso = `#${issue.number} criada, mas o quadro não foi atualizado: ${err.message}`;
  }
  return r;
}

const ACOES = { estado, conectar: (d) => conectar(d.token), sair, projetos, projeto, cards, detalhes, estimar, repositorio, criar };

/** O que a página pede pelo preload. Devolve `{ valor }` ou `{ erro }` (mensagem limpa, sem o "Error invoking…" do IPC). */
export async function pedir(acao, dados) {
  const f = Object.hasOwn(ACOES, acao) ? ACOES[acao] : null;
  if (!f) return { erro: "Ação desconhecida." };
  try {
    return { valor: await f(dados && typeof dados === "object" ? dados : {}) };
  } catch (err) {
    return { erro: String(err?.message || err) };
  }
}
