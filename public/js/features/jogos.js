/**
 * features/jogos.js — os jogos de equipe: Planning Poker, Retrospectiva e
 * Daily. Só a lógica; o desenho fica em ui/jogos.js.
 *
 * UM ESTADO SÓ, IGUAL EM TODO MUNDO, SEM SERVIDOR NOVO
 *
 * Tudo o que os jogos precisam lembrar mora num mapa chave → valor, copiado
 * em cada participante. Cada escrita leva um carimbo (relógio de Lamport +
 * id de quem escreveu) e, quando duas escritas disputam a mesma chave, vence
 * a de carimbo maior — em todo computador, na mesma ordem. Isso faz a fusão
 * ser comutativa e idempotente: receber a mesma escrita duas vezes, fora de
 * ordem, ou por dois caminhos (canal direto e servidor) dá o mesmo resultado.
 * Quem entra no meio recebe o mapa de quem já estava e chega ao mesmo estado.
 *
 * As mensagens são minúsculas (uma ou duas chaves por clique) e vão pelo
 * mesmo canal do quadro branco — nenhuma conexão nova.
 *
 * VOTO ESCONDIDO DE VERDADE
 *
 * No Planning Poker, antes da revelação só viaja "fulano votou". O valor fica
 * no computador de quem votou e só é publicado quando alguém revela. Na
 * Retrospectiva é igual com o texto das notas na fase de escrita. Ninguém
 * espia o voto dos outros pelo console.
 */
import { Emitter } from "../lib/emitter.js";

/* ------------------------------------------------------------------ *
 * O estado compartilhado
 * ------------------------------------------------------------------ */

const CHAVE_OK = /^[a-z]+(?:\/[A-Za-z0-9_.:-]{1,64}){0,4}$/;
const MAX_CHAVES = 4000;
const MAX_TEXTO = 600;

/** Valor aceitável vindo de outro participante: pequeno e sem funções. */
function valorOk(v) {
  if (v == null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= MAX_TEXTO;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v).length <= 4000;
    } catch {
      return false;
    }
  }
  return false;
}

export class EstadoJogos extends Emitter {
  /** chave -> { v, c, a } */
  mapa = new Map();
  relogio = 0;

  constructor({ eu = "eu" } = {}) {
    super();
    this.eu = String(eu);
  }

  ler(chave, padrao = null) {
    const e = this.mapa.get(chave);
    return e === undefined || e.v === null ? padrao : e.v;
  }

  /** Entradas cuja chave começa com `prefixo` (valores nulos ficam de fora). */
  *com(prefixo) {
    for (const [k, e] of this.mapa) if (k.startsWith(prefixo) && e.v !== null) yield [k, e.v];
  }

  /** Escreve localmente e avisa para mandar aos outros. `pares`: [[chave, valor], …] */
  definir(pares) {
    const lote = [];
    for (const [k, v] of pares) {
      if (!CHAVE_OK.test(k) || !valorOk(v)) continue;
      this.relogio += 1;
      const e = { v: v ?? null, c: this.relogio, a: this.eu };
      this.mapa.set(k, e);
      lote.push([k, e.v, e.c, e.a]);
    }
    if (lote.length) {
      this.emit("enviar", lote);
      this.emit("mudou", lote.map((x) => x[0]));
    }
    return lote;
  }

  /** Funde o que veio de outro participante. Devolve as chaves que mudaram. */
  aplicar(lote) {
    if (!Array.isArray(lote)) return [];
    const mudou = [];
    for (const item of lote.slice(0, MAX_CHAVES)) {
      if (!Array.isArray(item) || item.length !== 4) continue;
      const [k, v, c, a] = item;
      if (typeof k !== "string" || !CHAVE_OK.test(k) || !valorOk(v)) continue;
      if (!Number.isSafeInteger(c) || c < 0 || typeof a !== "string" || a.length > 64) continue;
      const atual = this.mapa.get(k);
      this.relogio = Math.max(this.relogio, c);
      if (atual && (atual.c > c || (atual.c === c && atual.a >= a))) continue;
      if (!atual && this.mapa.size >= MAX_CHAVES) continue;
      this.mapa.set(k, { v: v ?? null, c, a });
      mudou.push(k);
    }
    if (mudou.length) this.emit("mudou", mudou);
    return mudou;
  }

  /** O mapa inteiro, para quem acabou de chegar. */
  instantaneo() {
    return [...this.mapa].map(([k, e]) => [k, e.v, e.c, e.a]);
  }

  get vazio() {
    return this.mapa.size === 0;
  }
}

/**
 * O estado dos jogos em pedaços para quem chega, por TAMANHO e não só por
 * quantidade. Antes eram 300 chaves por mensagem; com as perguntas de um quiz
 * do QuizzV (até 4 kB cada) um pedaço passava do que o canal direto aceita, o
 * envio falhava calado e quem entrava no meio ficava sem o jogo.
 */
const PEDACO_MAX = 48 * 1024;
const utf8 = new TextEncoder();
/** Bytes que um valor ocupa no fio (acentos valem 2 ou 3 bytes, não 1). */
export const bytesDe = (v) => utf8.encode(JSON.stringify(v)).length;
export function pedacosDoEstado(tudo, max = PEDACO_MAX) {
  const pedacos = [];
  let atual = [];
  let tamanho = 0;
  for (const item of tudo) {
    const t = bytesDe(item) + 1;
    if (atual.length && (tamanho + t > max || atual.length >= 300)) {
      pedacos.push(atual);
      atual = [];
      tamanho = 0;
    }
    atual.push(item);
    tamanho += t;
  }
  if (atual.length) pedacos.push(atual);
  return pedacos;
}

/** Ids curtos para histórias, notas e ações. */
export function novoId() {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/** Inteiro aleatório em [0, n), do sorteio criptográfico do navegador. */
export function aleatorio(n) {
  if (!(n > 0)) return 0;
  const r = new Uint32Array(1);
  globalThis.crypto.getRandomValues(r);
  return r[0] % n;
}

/** `n` itens diferentes de `lista`, sorteados. */
export function sortear(lista, n = 1) {
  return embaralhar(lista).slice(0, n);
}

/**
 * Texto para comparar respostas: sem acento, minúsculo, sem pontuação, com
 * espaço simples. "Guarda-Chuva!" e "guarda chuva" ficam iguais.
 */
export function normalizar(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Como `normalizar`, mas sem espaço nenhum ("guardachuva"). */
export const compacto = (s) => normalizar(s).replace(/ /g, "");

/**
 * Impressão digital curta de um texto (FNV-1a em duas passadas, 64 bits em
 * hexadecimal). Serve para conferir um palpite sem mandar a resposta pela
 * rede; não é criptografia (quem tiver o banco de palavras e paciência
 * descobre), é só para ninguém ver a resposta sem querer.
 */
export function resumo(texto, sal = "") {
  const t = `${sal}|${texto}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < t.length; i += 1) {
    const c = t.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Embaralha um texto com uma chave (XOR + base64): fora da vista, não secreto. */
export function ofuscar(texto, chave = "vcall") {
  const b = new TextEncoder().encode(String(texto));
  const k = new TextEncoder().encode(String(chave) || "vcall");
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i] ^ k[i % k.length]);
  return btoa(s);
}

export function desofuscar(codigo, chave = "vcall") {
  try {
    const s = atob(String(codigo));
    const k = new TextEncoder().encode(String(chave) || "vcall");
    return new TextDecoder().decode(Uint8Array.from(s, (c, i) => c.charCodeAt(0) ^ k[i % k.length]));
  } catch {
    return "";
  }
}

/**
 * Soma os pontos de uma rodada ao placar, uma vez só: o placar lembra a
 * última rodada somada, e somar a mesma rodada de novo não muda nada.
 */
export function somarPlacar(placar, rodada, pontos, nomes = {}) {
  const p = placar && typeof placar === "object" ? placar : { n: 0, pts: {}, nomes: {} };
  if ((Number(p.n) || 0) >= rodada) return p;
  const pts = { ...(p.pts || {}) };
  const ns = { ...(p.nomes || {}) };
  for (const [id, v] of Object.entries(pontos || {})) {
    pts[id] = (Number(pts[id]) || 0) + (Number(v) || 0);
    if (nomes[id]) ns[id] = String(nomes[id]).slice(0, 40);
  }
  return { n: rodada, pts, nomes: ns };
}

/** O placar em ordem, com quem está na chamada mesmo sem ponto ainda. */
export function ranking(placar, pessoas = [], eu = "") {
  const pts = placar?.pts || {};
  const nomes = placar?.nomes || {};
  const ids = new Set([...Object.keys(pts), ...pessoas.map((p) => p.id)]);
  return [...ids]
    .map((id) => ({ id, nome: pessoas.find((p) => p.id === id)?.nome || nomes[id] || "Saiu", pontos: Number(pts[id]) || 0, eu: id === eu, presente: pessoas.some((p) => p.id === id) }))
    .filter((r) => r.presente || r.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
}

/** Quem cuida das tarefas automáticas (o menor id presente): só um faz. */
export function lider(pessoas) {
  return pessoas.map((p) => p.id).sort()[0] || null;
}

/* ------------------------------------------------------------------ *
 * Planning Poker
 * ------------------------------------------------------------------ */

export const BARALHOS = {
  fibonacci: { nome: "Fibonacci", cartas: ["0", "1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "?", "☕"] },
  modificado: { nome: "Fibonacci modificada", cartas: ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "☕"] },
  camisetas: { nome: "Tamanhos de camiseta", cartas: ["PP", "P", "M", "G", "GG", "XGG", "?", "☕"], ordinal: true },
  potencias: { nome: "Potências de 2", cartas: ["0", "1", "2", "4", "8", "16", "32", "64", "?", "☕"] },
  confianca: { nome: "Confiança (punho de 5)", cartas: ["1", "2", "3", "4", "5"], confianca: true },
};

/** Valor numérico de uma carta, ou null (?, ☕, camisetas). */
export function numero(carta) {
  if (carta === "½") return 0.5;
  const n = Number(carta);
  return Number.isFinite(n) && carta !== "" ? n : null;
}

/**
 * Resultado de uma rodada revelada.
 * @param {string[]} votos  as cartas escolhidas
 */
export function resultado(votos, baralho = BARALHOS.fibonacci) {
  const validos = votos.filter((v) => v != null && v !== "?" && v !== "☕");
  const contagem = new Map();
  for (const v of votos) contagem.set(v, (contagem.get(v) || 0) + 1);
  // Ordem do baralho, para o gráfico.
  const distribuicao = [...contagem].sort((a, b) => baralho.cartas.indexOf(a[0]) - baralho.cartas.indexOf(b[0])).map(([carta, n]) => ({ carta, n }));

  let maioria = null;
  let maiorN = 0;
  for (const [carta, n] of contagem) {
    if (carta === "?" || carta === "☕") continue;
    if (n > maiorN) {
      maiorN = n;
      maioria = carta;
    }
  }
  const nums = validos.map(numero).filter((n) => n != null).sort((a, b) => a - b);
  const media = nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
  const mediana = nums.length ? (nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2) : null;
  // Sugestão: a carta do baralho mais perto da média (sem ultrapassar o
  // maior voto — arredondar para cima de todo mundo não é consenso).
  let sugestao = maioria;
  if (media != null && !baralho.ordinal) {
    const cartas = baralho.cartas.map((c) => [c, numero(c)]).filter(([, n]) => n != null);
    let melhor = null;
    for (const [c, n] of cartas) if (!melhor || Math.abs(n - media) < Math.abs(melhor[1] - media)) melhor = [c, n];
    sugestao = melhor?.[0] ?? maioria;
  }
  const concordancia = validos.length ? Math.round((maiorN / validos.length) * 100) : 0;
  return {
    total: votos.length,
    validos: validos.length,
    distribuicao,
    media: media != null ? Math.round(media * 10) / 10 : null,
    mediana,
    maioria,
    sugestao,
    concordancia,
    consenso: validos.length >= 2 && contagem.get(maioria) === validos.length,
    menor: nums.length ? nums[0] : null,
    maior: nums.length ? nums[nums.length - 1] : null,
  };
}

/** A rodada atual de uma história (ou "_", votação avulsa). */
export function rodadaDe(estado, hid) {
  return Number(estado.ler(`p/r/${hid}`, 0)) || 0;
}

export function historiaAtual(estado) {
  return estado.ler("p/atual", "_") || "_";
}

/**
 * O card do GitHub de onde a história veio (features/github.js). Chega de
 * outro participante: o link só passa se for mesmo do github.com.
 */
function cardGithub(gh) {
  const id = (v) => (typeof v === "string" && v ? v.slice(0, 100) : null);
  if (!gh || !(id(gh.item) || id(gh.conteudo))) return null;
  return {
    item: id(gh.item),
    conteudo: id(gh.conteudo),
    numero: Number.isSafeInteger(gh.numero) ? gh.numero : null,
    url: linkGithub(gh.url),
  };
}

const linkGithub = (u) => (typeof u === "string" && /^https:\/\/github\.com\/[^\s]+$/.test(u) ? u : null);
const txt = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/*
 * O que vem junto com uma história do kanban: descrição, checklist (os
 * critérios de aceite) e subtarefas. Cada parte numa chave própria, porque
 * um valor do estado tem até ~4 kB (valorOk): `p/hd/<id>` e `p/hs/<id>`.
 */
const LIMITE_DETALHE = 3900;
const tamanho = (v) => JSON.stringify(v).length;
const corOk = (c) => (typeof c === "string" && /^[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);

/** Etiquetas, responsáveis e tipo, curtos (`et`, `pe`, `ti` em `p/hd/<id>`). */
function pacoteMarcas(m) {
  const et = (m?.etiquetas || []).slice(0, 8).map((e) => ({ n: String(e.nome).slice(0, 40), c: corOk(e.cor) }));
  const pe = (m?.pessoas || []).slice(0, 6).map((x) => String(x).slice(0, 39));
  const ti = m?.tipo?.nome ? { n: String(m.tipo.nome).slice(0, 30), c: corOk(m.tipo.cor) } : null;
  return et.length || pe.length || ti ? { et, pe, ti } : null;
}

function pacoteDetalhes(id, x) {
  const pares = [];
  const itensCheck = (x.criterios?.itens || []).slice(0, 20).map((c) => ({ t: String(c.titulo).slice(0, 220), f: !!c.feito }));
  const marcas = pacoteMarcas(x.marcas);
  if (x.descricao || itensCheck.length || marcas) {
    const d = { t: String(x.descricao || "").slice(0, 1600), cn: String(x.criterios?.nome || "").slice(0, 60), c: itensCheck, ...marcas };
    while (d.c.length > 3 && tamanho(d) > LIMITE_DETALHE) d.c.pop();
    while (d.t && tamanho(d) > LIMITE_DETALHE) d.t = `${d.t.slice(0, Math.floor(d.t.length * 0.85))}…`;
    while (tamanho(d) > LIMITE_DETALHE) d.c.pop();
    d.cm = (x.criterios?.itens?.length || 0) - d.c.length;
    pares.push([`p/hd/${id}`, d]);
  }
  if (x.subtarefas?.length) {
    const s = { s: x.subtarefas.slice(0, 30).map((t) => ({ t: String(t.titulo).slice(0, 160), n: Number.isSafeInteger(t.numero) ? t.numero : null, u: linkGithub(t.url), f: !!t.feita })) };
    while (tamanho(s) > LIMITE_DETALHE) s.s.pop();
    s.m = Math.max(x.subtarefasTotal || 0, x.subtarefas.length) - s.s.length;
    pares.push([`p/hs/${id}`, s]);
  }
  return pares;
}

/** Descrição, checklist e subtarefas de uma história (vêm de outro participante: tudo conferido). */
export function detalhesHistoria(estado, hid) {
  const d = estado.ler(`p/hd/${hid}`) || {};
  const s = estado.ler(`p/hs/${hid}`) || {};
  const lista = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const subtarefas = lista(s.s).map((x) => ({ titulo: txt(x.t, 160), numero: Number.isSafeInteger(x.n) ? x.n : null, url: linkGithub(x.u), feita: x.f === true }));
  const criterios = lista(d.c).map((x) => ({ titulo: txt(x.t, 220), feito: x.f === true }));
  const mais = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  const marca = (x) => ({ nome: txt(x?.n, 40), cor: corOk(x?.c) });
  return {
    descricao: txt(d.t, 1700),
    marcas: {
      etiquetas: lista(d.et).map(marca).filter((e) => e.nome),
      pessoas: (Array.isArray(d.pe) ? d.pe : []).filter((x) => typeof x === "string" && /^[A-Za-z0-9-]{1,39}$/.test(x)),
      tipo: d.ti && typeof d.ti === "object" && txt(d.ti.n, 30) ? marca(d.ti) : null,
    },
    criterios: { nome: txt(d.cn, 60) || "Checklist", itens: criterios, mais: mais(d.cm) },
    subtarefas: { itens: subtarefas, mais: mais(s.m), feitas: subtarefas.filter((x) => x.feita).length },
    vazio: !d.t && !criterios.length && !subtarefas.length,
    semMarcas: !lista(d.et).length && !(Array.isArray(d.pe) && d.pe.length) && !d.ti,
  };
}

/**
 * Histórias, na ordem, com as subtarefas logo abaixo de quem as tem (`pai`)
 * e o `nivel` de cada uma (0 na US).
 */
export function historias(estado) {
  const todas = new Map();
  for (const [k, h] of estado.com("p/h/")) {
    if (h?.apagada) continue;
    const id = k.slice(4);
    todas.set(id, { id, titulo: String(h.titulo || "").slice(0, 200), ordem: Number(h.ordem) || 0, estimativa: h.estimativa ?? null, gh: cardGithub(h.gh), pai: typeof h.pai === "string" && h.pai !== id ? h.pai : null, nivel: 0 });
  }
  const filhas = new Map();
  for (const h of todas.values()) {
    if (!todas.has(h.pai)) h.pai = null; // a de cima foi apagada: sobe
    const irmas = filhas.get(h.pai) || [];
    irmas.push(h);
    filhas.set(h.pai, irmas);
  }
  const ordem = (a, b) => a.ordem - b.ordem || a.id.localeCompare(b.id);
  const lista = [];
  const vistas = new Set();
  const descer = (pai, nivel) => {
    for (const h of (filhas.get(pai) || []).sort(ordem)) {
      if (vistas.has(h.id)) continue;
      vistas.add(h.id);
      lista.push({ ...h, nivel });
      descer(h.id, nivel + 1);
    }
  };
  descer(null, 0);
  // Um ciclo (a dentro de b dentro de a, vindo de fora) não esconde ninguém.
  for (const h of [...todas.values()].sort(ordem)) {
    if (vistas.has(h.id)) continue;
    vistas.add(h.id);
    lista.push({ ...h, pai: null, nivel: 0 });
    descer(h.id, 1);
  }
  return lista;
}

/**
 * O que a mesa mostra: quem votou, quem é espectador, e — revelado — os
 * valores e o resultado.
 * @param {{pessoas: {id:string, nome:string}[], meuVoto: string|null}} o
 */
export function mesaPoker(estado, { pessoas, meuVoto = null, agora = Date.now() }) {
  const hid = historiaAtual(estado);
  const r = rodadaDe(estado, hid);
  const base = `${hid}/${r}`;
  const revEm = estado.ler(`p/rev/${base}`, null);
  const revelado = revEm != null && agora >= Number(revEm);
  const contagem = revEm != null && !revelado ? Math.max(0, Math.ceil((Number(revEm) - agora) / 1000)) : null;
  const baralhoId = estado.ler("p/baralho", "fibonacci");
  const baralho = BARALHOS[baralhoId] || BARALHOS.fibonacci;

  const votaram = new Map();
  for (const [k, v] of estado.com(`p/v/${base}/`)) votaram.set(k.split("/").pop(), v?.n || "");
  const valores = new Map();
  for (const [k, v] of estado.com(`p/val/${base}/`)) if (baralho.cartas.includes(v)) valores.set(k.split("/").pop(), v);

  const presentes = new Set(pessoas.map((p) => p.id));
  const jogadores = pessoas.map((p) => ({
    id: p.id,
    nome: p.nome,
    eu: p.id === estado.eu,
    espectador: !!estado.ler(`p/esp/${p.id}`, false),
    votou: votaram.has(p.id),
    valor: revelado ? (valores.get(p.id) ?? (p.id === estado.eu ? meuVoto : null)) : null,
    presente: true,
  }));
  // Quem votou e saiu continua contando (com o nome que deixou).
  for (const [id, nome] of votaram) {
    if (presentes.has(id)) continue;
    jogadores.push({ id, nome: nome || "Saiu", eu: false, espectador: false, votou: true, valor: revelado ? (valores.get(id) ?? null) : null, presente: false });
  }
  const votantes = jogadores.filter((j) => !j.espectador && j.presente);
  const todosVotaram = votantes.length > 0 && votantes.every((j) => j.votou);
  return {
    historia: hid,
    rodada: r,
    baralhoId,
    baralho,
    revelado,
    contagem,
    jogadores,
    todosVotaram,
    faltam: votantes.filter((j) => !j.votou).length,
    resultado: revelado ? resultado(jogadores.filter((j) => j.valor != null).map((j) => j.valor), baralho) : null,
  };
}

/**
 * As jogadas do Poker. `segredos` guarda o voto de quem está neste
 * computador até a revelação.
 */
export class Poker {
  /** `${hid}/${rodada}` -> carta */
  meus = new Map();

  constructor(estado, { nome = () => "" } = {}) {
    this.estado = estado;
    this.nome = nome;
    // Toda mudança pode ter sido uma revelação: hora de publicar o que é meu.
    estado.on("mudou", () => this.publicarSegredos());
  }

  get base() {
    const hid = historiaAtual(this.estado);
    return `${hid}/${rodadaDe(this.estado, hid)}`;
  }

  meuVoto() {
    return this.meus.get(this.base) ?? null;
  }

  votar(carta) {
    const base = this.base;
    if (this.estado.ler(`p/rev/${base}`) != null) return false; // revelado: só na próxima rodada
    const eu = this.estado.eu;
    if (carta == null || this.meus.get(base) === carta) {
      // Clicar de novo na mesma carta tira o voto.
      this.meus.delete(base);
      this.estado.definir([[`p/v/${base}/${eu}`, null]]);
      return true;
    }
    this.meus.set(base, carta);
    this.estado.definir([[`p/v/${base}/${eu}`, { n: this.nome().slice(0, 40) }]]);
    return true;
  }

  /** Revela depois de uma contagem curta (`ms`), igual para todos. */
  revelar({ ms = 2500, agora = Date.now() } = {}) {
    const base = this.base;
    if (this.estado.ler(`p/rev/${base}`) != null) return false;
    this.estado.definir([[`p/rev/${base}`, agora + ms]]);
    return true;
  }

  novaRodada() {
    const hid = historiaAtual(this.estado);
    this.estado.definir([[`p/r/${hid}`, rodadaDe(this.estado, hid) + 1]]);
  }

  publicarSegredos() {
    const eu = this.estado.eu;
    for (const [base, carta] of this.meus) {
      if (this.estado.ler(`p/rev/${base}`) == null) continue;
      if (this.estado.ler(`p/val/${base}/${eu}`) === carta) continue;
      this.estado.definir([[`p/val/${base}/${eu}`, carta]]);
    }
  }

  /**
   * `titulos`: textos, ou objetos vindos do kanban do GitHub (features/github.js):
   * `{ titulo, estimativa, gh, descricao, criterios, marcas, subtarefas, subtarefasTotal, filhas }`.
   * `filhas` entram como subtarefas votáveis, logo abaixo (até 30 por US).
   * `pai`: põe todas embaixo de uma história que já está na mesa.
   */
  adicionarHistorias(titulos, { pai = null } = {}) {
    const atuais = historias(this.estado);
    let ordem = atuais.length ? Math.max(...atuais.map((h) => h.ordem)) + 1 : 1;
    const pares = [];
    let primeira = null;
    const objeto = (x) => (typeof x === "object" && x ? x : { titulo: x });
    const temTitulo = (x) => String(x.titulo ?? "").trim();
    const por = (x, acima) => {
      const id = novoId();
      const estimativa = x.estimativa ?? null;
      if (estimativa == null) primeira ||= id;
      pares.push([`p/h/${id}`, { titulo: String(x.titulo).trim().slice(0, 200), ordem: ordem++, estimativa, ...(acima ? { pai: acima } : {}), ...(x.gh ? { gh: x.gh } : {}) }], ...pacoteDetalhes(id, x));
      for (const f of (x.filhas || []).map(objeto).filter(temTitulo).slice(0, 30)) por(f, id);
    };
    for (const x of titulos.map(objeto).filter(temTitulo).slice(0, 50)) por(x, pai);
    // Sem história em votação: a primeira nova vira a atual.
    if (primeira && historiaAtual(this.estado) === "_") pares.push(["p/atual", primeira]);
    // Em pedaços que cabem no canal: com descrições, 50 histórias passam de 100 kB.
    for (const pedaco of pedacosDoEstado(pares)) this.estado.definir(pedaco);
    return primeira;
  }

  escolherHistoria(hid) {
    this.estado.definir([["p/atual", hid || "_"]]);
  }

  /** Guarda a estimativa da história e passa para a próxima sem estimativa. */
  salvarEstimativa(hid, carta, { avancar = true } = {}) {
    const h = this.estado.ler(`p/h/${hid}`);
    if (!h) return;
    const pares = [[`p/h/${hid}`, { ...h, estimativa: carta }]];
    if (avancar) {
      // A seguinte sem estimativa (a subtarefa logo abaixo da US), dando a volta no fim.
      const lista = historias(this.estado);
      const i = lista.findIndex((x) => x.id === hid);
      const proxima = [...lista.slice(i + 1), ...lista.slice(0, Math.max(i, 0))].find((x) => x.id !== hid && x.estimativa == null);
      if (proxima) pares.push(["p/atual", proxima.id]);
    }
    this.estado.definir(pares);
  }

  /**
   * Uma subtarefa nova embaixo de `hid` (a US que ficou grande e foi
   * dividida): entra na mesa e na lista de subtarefas da US.
   */
  adicionarSubtarefa(hid, x) {
    const id = this.adicionarHistorias([x], { pai: hid });
    const s = this.estado.ler(`p/hs/${hid}`) || {};
    const lista = Array.isArray(s.s) ? s.s.filter((t) => t?.u !== x.gh?.url) : [];
    const nova = { s: [...lista, { t: String(x.titulo).slice(0, 160), n: Number.isSafeInteger(x.gh?.numero) ? x.gh.numero : null, u: linkGithub(x.gh?.url), f: false }], m: Number.isSafeInteger(s.m) ? s.m : 0 };
    while (nova.s.length > 1 && tamanho(nova) > LIMITE_DETALHE) {
      nova.s.shift();
      nova.m += 1;
    }
    this.estado.definir([[`p/hs/${hid}`, nova]]);
    return id;
  }

  /** Apaga a história e as subtarefas dela. */
  apagarHistoria(hid) {
    const todas = historias(this.estado);
    const fora = new Set([hid]);
    for (const h of todas) if (h.pai && fora.has(h.pai)) fora.add(h.id); // em árvore: a de cima vem antes
    const pares = [];
    for (const id of fora) {
      const h = this.estado.ler(`p/h/${id}`);
      if (h) pares.push([`p/h/${id}`, { ...h, apagada: true }]);
    }
    if (!pares.length) return;
    if (fora.has(historiaAtual(this.estado))) pares.push(["p/atual", "_"]);
    this.estado.definir(pares);
  }

  definirBaralho(id) {
    if (BARALHOS[id]) this.estado.definir([["p/baralho", id]]);
  }

  espectador(sim) {
    this.estado.definir([[`p/esp/${this.estado.eu}`, !!sim]]);
    if (sim) this.votar(null);
  }
}

/** Histórias estimadas em CSV (abre no Excel/Sheets e importa no Jira). */
export function historiasCsv(estado) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return ["Historia;Estimativa", ...historias(estado).map((h) => `${esc(h.titulo)};${esc(h.estimativa ?? "")}`)].join("\r\n");
}

/* ------------------------------------------------------------------ *
 * Retrospectiva
 * ------------------------------------------------------------------ */

export const MODELOS_RETRO = {
  ccp: { nome: "Começar · Parar · Continuar", colunas: ["Começar", "Parar", "Continuar"] },
  bmi: { nome: "Bom · Melhorar · Ideias", colunas: ["Foi bom", "Pode melhorar", "Ideias"] },
  "4l": { nome: "4Ls", colunas: ["Gostei", "Aprendi", "Faltou", "Desejei"] },
  fts: { nome: "Feliz · Triste · Bravo", colunas: ["Feliz", "Triste", "Bravo"] },
};
export const FASES_RETRO = ["escrever", "votar", "discutir"];

export function retro(estado, { pessoas = [] } = {}) {
  const modelo = MODELOS_RETRO[estado.ler("r/modelo", "ccp")] || MODELOS_RETRO.ccp;
  const fase = FASES_RETRO.includes(estado.ler("r/fase")) ? estado.ler("r/fase") : "escrever";
  const votosPorPessoa = Math.min(10, Math.max(1, Number(estado.ler("r/votos", 3)) || 3));
  const notas = [];
  const usados = new Map();
  for (const [k, n] of estado.com("r/n/")) {
    const id = k.slice(4);
    if (!n || n.apagada) continue;
    let votos = 0;
    for (const [kv, qtd] of estado.com(`r/vt/${id}/`)) {
      const q = Math.max(0, Math.min(votosPorPessoa, Number(qtd) || 0));
      votos += q;
      const uid = kv.split("/").pop();
      usados.set(uid, (usados.get(uid) || 0) + q);
    }
    notas.push({
      id,
      col: Math.max(0, Math.min(modelo.colunas.length - 1, Number(n.col) || 0)),
      autor: n.autor,
      nome: n.nome || "",
      texto: estado.ler(`r/t/${id}`, null),
      ordem: Number(n.ordem) || 0,
      votos,
    });
  }
  const acoes = [];
  for (const [k, a] of estado.com("r/a/")) {
    if (!a || a.apagada) continue;
    acoes.push({ id: k.slice(4), texto: String(a.texto || "").slice(0, 300), dono: a.dono || "", feita: !!a.feita, ordem: Number(a.ordem) || 0 });
  }
  acoes.sort((a, b) => a.ordem - b.ordem);
  const ordenar = fase === "discutir" ? (a, b) => b.votos - a.votos || a.ordem - b.ordem : (a, b) => a.ordem - b.ordem;
  return {
    modelo,
    modeloId: estado.ler("r/modelo", "ccp"),
    fase,
    votosPorPessoa,
    meusVotosUsados: usados.get(estado.eu) || 0,
    colunas: modelo.colunas.map((titulo, i) => ({ titulo, notas: notas.filter((n) => n.col === i).sort(ordenar) })),
    escreveram: pessoas.map((p) => ({ ...p, notas: notas.filter((n) => n.autor === p.id).length })),
    acoes,
  };
}

export class Retro {
  /** id da nota -> texto (as minhas, enquanto a fase é de escrita) */
  meus = new Map();

  constructor(estado, { nome = () => "" } = {}) {
    this.estado = estado;
    this.nome = nome;
    estado.on("mudou", () => this.publicarSegredos());
  }

  get escrevendo() {
    return (this.estado.ler("r/fase") || "escrever") === "escrever";
  }

  adicionarNota(col, texto) {
    const t = String(texto || "").trim().slice(0, 500);
    if (!t) return null;
    const id = novoId();
    this.meus.set(id, t);
    const pares = [[`r/n/${id}`, { col, autor: this.estado.eu, nome: this.nome().slice(0, 40), ordem: Date.now() }]];
    if (!this.escrevendo) pares.push([`r/t/${id}`, t]);
    this.estado.definir(pares);
    return id;
  }

  apagarNota(id) {
    const n = this.estado.ler(`r/n/${id}`);
    if (!n || n.autor !== this.estado.eu) return;
    this.meus.delete(id);
    this.estado.definir([[`r/n/${id}`, { ...n, apagada: true }]]);
  }

  /** +1 / -1 voto numa nota, respeitando o total por pessoa. */
  votar(id, delta) {
    const v = retro(this.estado);
    if (v.fase !== "votar") return false;
    const chave = `r/vt/${id}/${this.estado.eu}`;
    const atual = Number(this.estado.ler(chave, 0)) || 0;
    const novo = atual + delta;
    if (novo < 0 || (delta > 0 && v.meusVotosUsados >= v.votosPorPessoa)) return false;
    this.estado.definir([[chave, novo]]);
    return true;
  }

  fase(f) {
    if (FASES_RETRO.includes(f)) this.estado.definir([["r/fase", f]]);
  }

  modelo(id) {
    if (MODELOS_RETRO[id]) this.estado.definir([["r/modelo", id]]);
  }

  adicionarAcao(texto, dono = "") {
    const t = String(texto || "").trim().slice(0, 300);
    if (!t) return;
    this.estado.definir([[`r/a/${novoId()}`, { texto: t, dono: String(dono).slice(0, 40), feita: false, ordem: Date.now() }]]);
  }

  marcarAcao(id, feita) {
    const a = this.estado.ler(`r/a/${id}`);
    if (a) this.estado.definir([[`r/a/${id}`, { ...a, feita: !!feita }]]);
  }

  apagarAcao(id) {
    const a = this.estado.ler(`r/a/${id}`);
    if (a) this.estado.definir([[`r/a/${id}`, { ...a, apagada: true }]]);
  }

  /** Saiu da fase de escrita: os textos que estavam só aqui são publicados. */
  publicarSegredos() {
    if (this.escrevendo) return;
    const pares = [];
    for (const [id, texto] of this.meus) {
      const n = this.estado.ler(`r/n/${id}`);
      if (!n || n.apagada) continue;
      if (this.estado.ler(`r/t/${id}`) !== texto) pares.push([`r/t/${id}`, texto]);
    }
    if (pares.length) this.estado.definir(pares);
  }
}

/** A retrospectiva em Markdown, para colar no Confluence, Notion ou Jira. */
export function retroMarkdown(estado) {
  const v = retro(estado);
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

/* ------------------------------------------------------------------ *
 * Daily (reunião diária)
 * ------------------------------------------------------------------ */

/** Embaralha (Fisher–Yates) com o sorteio criptográfico do navegador. */
export function embaralhar(lista) {
  const a = [...lista];
  const r = new Uint32Array(1);
  for (let i = a.length - 1; i > 0; i -= 1) {
    globalThis.crypto.getRandomValues(r);
    const j = r[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function daily(estado, { agora = Date.now() } = {}) {
  const ordem = Array.isArray(estado.ler("d/ordem")) ? estado.ler("d/ordem").slice(0, 40) : [];
  const i = Number(estado.ler("d/i", -1));
  const tempo = Math.min(600, Math.max(15, Number(estado.ler("d/tempo", 90)) || 90));
  const inicio = Number(estado.ler("d/inicio", 0)) || 0;
  const comecou = Number(estado.ler("d/comecou", 0)) || 0;
  const tempos = estado.ler("d/tempos", {}) || {};
  const atual = i >= 0 && i < ordem.length ? ordem[i] : null;
  const decorrido = atual && inicio ? Math.max(0, (agora - inicio) / 1000) : 0;
  return {
    ordem: ordem.map((p, k) => ({ ...p, k, feito: k < i, atual: k === i, segundos: Number(tempos[p.id]) || null })),
    i,
    tempo,
    atual,
    decorrido,
    restante: tempo - decorrido,
    estourou: decorrido > tempo,
    fim: ordem.length > 0 && i >= ordem.length,
    total: comecou ? Math.max(0, ((i >= ordem.length ? Number(estado.ler("d/terminou", agora)) : agora) - comecou) / 1000) : 0,
  };
}

export class Daily {
  constructor(estado) {
    this.estado = estado;
  }

  sortear(pessoas) {
    const ordem = embaralhar(pessoas.map((p) => ({ id: p.id, nome: String(p.nome || "").slice(0, 40) })));
    this.estado.definir([
      ["d/ordem", ordem],
      ["d/i", -1],
      ["d/inicio", 0],
      ["d/comecou", 0],
      ["d/tempos", {}],
    ]);
  }

  tempo(segundos) {
    this.estado.definir([["d/tempo", Math.min(600, Math.max(15, Number(segundos) || 90))]]);
  }

  /** Começa, ou passa a vez para a próxima pessoa. */
  proximo(agora = Date.now()) {
    const v = daily(this.estado, { agora });
    if (!v.ordem.length || v.fim) return;
    const pares = [];
    if (v.atual) pares.push(["d/tempos", { ...(this.estado.ler("d/tempos", {}) || {}), [v.atual.id]: Math.round(v.decorrido) }]);
    if (v.i < 0) pares.push(["d/comecou", agora]);
    const i = v.i + 1;
    pares.push(["d/i", i], ["d/inicio", agora]);
    if (i >= v.ordem.length) pares.push(["d/terminou", agora]);
    this.estado.definir(pares);
  }

  reiniciar() {
    this.estado.definir([
      ["d/i", -1],
      ["d/inicio", 0],
      ["d/comecou", 0],
      ["d/tempos", {}],
    ]);
  }
}

/* ------------------------------------------------------------------ */

/** As prateleiras do menu de jogos, na ordem em que aparecem. */
export const CATEGORIAS = {
  festa: { nome: "Festa", desc: "Para rir com a turma toda" },
  tabuleiro: { nome: "Tabuleiro e palavras", desc: "Duelos e desafios rápidos" },
  sorteio: { nome: "Sorteios", desc: "Para decidir quem vai primeiro (ou quem paga o café)" },
  equipe: { nome: "Equipe ágil", desc: "Para o trabalho do time" },
};

/** Todos os jogos. `icone` é o nome no sprite de ícones (Lucide, /vendor/icons.svg). */
export const JOGOS = {
  desenho: { nome: "Desenha e Adivinha", cat: "festa", icone: "palette", pessoas: "3+", desc: "Um desenha, o resto adivinha. Quem acerta antes ganha mais." },
  stop: { nome: "Stop!", cat: "festa", icone: "hand", pessoas: "2+", desc: "A adedonha: uma letra, várias categorias. Terminou? Grite STOP!" },
  quiz: { nome: "Quiz", cat: "festa", icone: "lightbulb", pessoas: "1+", desc: "Perguntas de conhecimentos gerais contra o relógio." },
  mimica: { nome: "Mímica", cat: "festa", icone: "drama", pessoas: "3+", desc: "Imite sem falar, com a sua câmera em destaque." },
  quemsoueu: { nome: "Quem sou eu?", cat: "festa", icone: "scan-face", pessoas: "3+", desc: "Todo mundo vê o seu personagem, menos você." },
  roda: { nome: "Roda de perguntas", cat: "festa", icone: "messages-square", pessoas: "2+", desc: "O que você prefere?, Eu nunca…, Quem da call… e quebra-gelo." },
  verdades: { nome: "Duas verdades e uma mentira", cat: "festa", icone: "badge-question-mark", pessoas: "3+", desc: "Conte três coisas sobre você. Qual delas é mentira?" },
  codigo: { nome: "Palavras-código", cat: "festa", icone: "swords", pessoas: "4+", desc: "Dois times, um mestre de cada e uma dica por vez." },
  velha: { nome: "Jogo da velha", cat: "tabuleiro", icone: "hash", pessoas: "1–2", desc: "O clássico. Sozinho? Jogue contra o computador." },
  lig4: { nome: "Lig 4", cat: "tabuleiro", icone: "grid-3x3", pessoas: "1–2", desc: "Quatro em linha antes do outro. Tem computador também." },
  forca: { nome: "Forca", cat: "tabuleiro", icone: "type", pessoas: "2+", desc: "Todo mundo chuta letras para salvar o boneco." },
  memoria: { nome: "Jogo da memória", cat: "tabuleiro", icone: "brain", pessoas: "1+", desc: "Ache os pares, um de cada vez." },
  sorteios: { nome: "Roleta e dados", cat: "sorteio", icone: "dices", pessoas: "1+", desc: "Roleta com os nomes da chamada, dados e cara ou coroa." },
  poker: { nome: "Planning Poker", cat: "equipe", icone: "spade", pessoas: "2+", desc: "Estimem histórias com cartas escondidas até revelar." },
  retro: { nome: "Retrospectiva", cat: "equipe", icone: "sticky-note", pessoas: "2+", desc: "Notas em colunas, votação com pontos e plano de ação." },
  daily: { nome: "Daily", cat: "equipe", icone: "timer", pessoas: "2+", desc: "Ordem sorteada e tempo de fala para cada um." },
};

/** "o Planning Poker", "a Daily", "o Stop!"… para os avisos. */
export function comArtigo(id) {
  const j = JOGOS[id];
  if (!j) return "um jogo";
  if (id === "verdades" || id === "codigo") return j.nome;
  if (id === "sorteios") return "a Roleta";
  const feminino = ["retro", "daily", "mimica", "roda", "forca"].includes(id);
  return `${feminino ? "a" : "o"} ${j.nome}`;
}
