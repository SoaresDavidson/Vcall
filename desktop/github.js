/**
 * desktop/github.js — o quadro (kanban) de um GitHub Project no Planning Poker.
 *
 * Mora no processo principal porque a página só fala com o próprio servidor
 * (connect-src 'self', src/http.js). O token também fica aqui, cifrado pelo
 * sistema (safeStorage), e a página só pede operações fechadas: listar os
 * projetos, ler um quadro e os cards dele (com descrição e subtarefas) e
 * gravar um número num card. Nada de
 * GraphQL livre: um script injetado na página não ganha o token inteiro.
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
    status: status ? { nome: status.name, colunas: status.options.map((o) => ({ id: o.id, nome: o.name })) } : null,
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
        ... on Issue { title number url subIssuesSummary { total completed } }
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

const DETALHES = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { id content {
  ... on Issue { body subIssues(first: 50) { totalCount nodes { title number url state } } }
  ... on PullRequest { body }
  ... on DraftIssue { body }
} } } }`;

/** A descrição e as sub-issues dos cards escolhidos (até 100 de uma vez). */
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
      subs: (c.subIssues?.nodes || []).filter(Boolean).map((s) => ({ titulo: s.title, numero: s.number, url: s.url, feita: s.state === "CLOSED" })),
      subsTotal: c.subIssues?.totalCount ?? 0,
    };
  }
  return out;
}

async function estimar({ projeto: p, item, campo, numero }) {
  const n = Number(numero);
  if (!Number.isFinite(n)) throw new Error("A estimativa não é um número.");
  await gql(
    "mutation($p: ID!, $i: ID!, $f: ID!, $n: Float!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { number: $n } }) { projectV2Item { id } } }",
    { p: String(p), i: String(item), f: String(campo), n },
  );
  return true;
}

const ACOES = { estado, conectar: (d) => conectar(d.token), sair, projetos, projeto, cards, detalhes, estimar };

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
