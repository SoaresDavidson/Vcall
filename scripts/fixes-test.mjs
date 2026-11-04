#!/usr/bin/env node
/**
 * scripts/fixes-test.mjs — as correções da versão 3.1, sem navegador.
 *
 * Cada bloco prova um problema real que existiu (e o descreve), com um
 * servidor de verdade e clientes WebSocket de verdade. Roda em segundos, em
 * qualquer sistema, e é o primeiro a rodar no CI.
 *
 *   node scripts/fixes-test.mjs
 */
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

import { createHttpServer } from "../src/http.js";
import { attachSignaling } from "../src/signaling.js";
import { parseClientMessage } from "../src/protocol.js";
import { descreverFontes, montarResposta, sessaoWayland, audioDoSistemaSuportado, umPorVez } from "../desktop/captura.js";
import { lerZip, montarTar, zipParaTarGz, nomeDoModelo, responderModelo } from "../desktop/fala.js";
import { destinoDoLink } from "../desktop/protocol.js";
import { linkAbrir, linkDaSala, linkDoAplicativo, linkWhatsApp, salaDoFragmento, ehCelular } from "../public/js/lib/invite.js";
import { createBoardNotice } from "../public/js/features/board-notice.js";
import { argsParaX11, executavelParaRegistrar, lancador, modoDeReabrir, opcoesDeExibicao } from "../desktop/linux.js";
import { adaptarEncoder, jaAdaptado } from "../desktop/whisper-curto.js";
import { assinar, confere, nomeNaRelease, sha512DoArquivo } from "../desktop/assinatura.js";
import { instalaAoFechar, maisNova, modoDeInstalacao } from "../desktop/atualizacao.js";
import { reabrirDepois, trocarAppImage } from "../desktop/appimage.js";
import { ROTA_CURTA, origemPublica, paginaDoConvite } from "../src/convite.js";
import { ehAndroid, linkCurto, linkIntentAndroid } from "../public/js/lib/invite.js";
import { tipoDoCodigo } from "../public/js/ui/tela-erro.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync as gravar } from "node:fs";
import { tmpdir } from "node:os";
import { join as juntar } from "node:path";
import { Acordo, limpar, quadrosPara, tokensPara, wer } from "../public/js/features/whisper-nucleo.js";
import { Codigo, Desenho, DuasVerdades, Mimica, QuemSouEu, Quiz, Roda, Stop as StopJogo, valida } from "../public/js/features/festa.js";
import { BOT, Forca, Lig4, Memoria, Sorteios, Velha, resultadoLig4, resultadoVelha } from "../public/js/features/tabuleiro.js";
import { Chuva, Combo, ComboRemoto, DO_ANTIGO, REACOES, SINAIS, Sinais, validar as validarReacao } from "../public/js/features/reacoes.js";
import { BARALHOS, Daily, EstadoJogos, Poker, Retro, compacto, daily, detalhesHistoria, historias, mesaPoker, resultado, retro } from "../public/js/features/jogos.js";
import { KanbanGithub } from "../public/js/features/github.js";
import { LinkTailscale, MENSAGENS, escolherPorta, interpretarFalha, lerEstado, urlDe } from "../desktop/tailscale.js";
import { ehDaRede, ehIpTailscale } from "../src/rede.js";
import { RoomRegistry, Participant } from "../src/rooms.js";
import { normalizeRoomMeta } from "../src/protocol.js";
import { escolherMonitor } from "../public/js/core/screen.js";
import { somDoComputadorNaLista } from "../desktop/captura.js";
import { RedeVcall, limparPessoa, limparSala, paresOnline, pareceVcall } from "../desktop/rede.js";
import { ehIpTailscale as ehIpTailscaleNavegador } from "../public/js/core/stats.js";
import { clientIp } from "../src/signaling.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { criarEncurtador } from "../desktop/encurtador.js";

let passou = 0;
const ok = (nome) => {
  passou += 1;
  console.log(`✓ ${nome}`);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * Servidor de verdade
 * ================================================================== */

const PORT = 3098;
const server = createHttpServer({});
attachSignaling(server);
await new Promise((r) => server.listen(PORT, r));

/** Cliente de teste: junta as mensagens recebidas e espera por uma delas. */
function cliente(porta = PORT) {
  const ws = new WebSocket(`ws://localhost:${porta}`);
  const msgs = [];
  const fila = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    msgs.push(m);
    for (const f of [...fila]) {
      if (f.pred(m)) {
        fila.splice(fila.indexOf(f), 1);
        f.resolve(m);
      }
    }
  });
  const c = {
    ws,
    msgs,
    fechado: new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) }))),
    aberto: new Promise((r, rej) => {
      ws.on("open", r);
      ws.on("error", rej);
    }),
    send: (m) => ws.send(JSON.stringify(m)),
    esperar(pred, ms = 3000) {
      const achado = msgs.find(pred);
      if (achado) return Promise.resolve(achado);
      return new Promise((resolve, reject) => {
        fila.push({ pred, resolve });
        setTimeout(() => reject(new Error("mensagem não chegou")), ms);
      });
    },
    async entrar(room, extra = {}) {
      await c.aberto;
      c.send({ t: "join", room, profile: { name: extra.nome || "T" }, state: {}, ...extra });
      return c.esperar((m) => m.t === "welcome" || m.t === "error" || m.t === "waiting");
    },
  };
  return c;
}
const sala = (n) => `sala-teste-${n}-${Math.random().toString(36).slice(2, 12)}`;
const TOK = (n) => `token-${n}-abcdefghijklmnop`;

/* -- senha da sala: antes NUNCA era conferida (room.hasPass não existia) -- */
{
  const id = sala("senha");
  const dono = cliente();
  const w = await dono.entrar(id, { meta: { name: "Secreta", visibility: "private", pass: "1234" }, pass: "1234" });
  assert.equal(w.t, "welcome", "quem cria com senha entra");

  const intruso = cliente();
  const r = await intruso.entrar(id, { pass: "errada" });
  assert.equal(r.t, "error");
  assert.equal(r.error, "bad-password", "senha errada precisa ser recusada");
  const sem = cliente();
  assert.equal((await sem.entrar(id)).error, "bad-password", "sem senha também é recusado");
  const certo = cliente();
  assert.equal((await certo.entrar(id, { pass: "1234" })).t, "welcome", "com a senha certa entra");
  ok("segurança: a senha da sala é conferida (antes qualquer um entrava)");
  for (const c of [dono, intruso, sem, certo]) c.ws.close();
}

/* -- reconexão: sem participante duplicado -- */
{
  const id = sala("dup");
  const a = cliente();
  await a.entrar(id, { nome: "Ana", session: TOK("a") });
  const b1 = cliente();
  const w1 = await b1.entrar(id, { nome: "Beto", session: TOK("b") });
  await a.esperar((m) => m.t === "peer-join" && m.peer.id === w1.you.id);

  // A conexão do Beto "cai" sem avisar: nada de FIN nem leave — o socket só
  // para de responder (Wi-Fi que troca, notebook que dorme). O servidor
  // continua achando que ele está lá. Ele volta com a mesma sessão.
  b1.ws._socket.pause();
  b1.ws._socket.removeAllListeners("data");
  const antes = a.msgs.length;
  const b2 = cliente();
  const w2 = await b2.entrar(id, { nome: "Beto 2", session: TOK("b") });
  // Para a Ana ele nunca saiu: mesmo id, nada de saída e entrada (que
  // derrubariam a conexão direta e o áudio e o vídeo dele).
  assert.equal(w2.you.id, w1.you.id, "quem volta pela mesma aba mantém o id");
  const perfil = await a.esperar((m) => m.t === "profile" && m.id === w1.you.id);
  assert.equal(perfil.name, "Beto 2", "o nome novo chega aos outros");
  await espera(150);
  assert.ok(!a.msgs.slice(antes).some((m) => m.t === "peer-leave" || m.t === "peer-join"), "nenhum aviso de saída ou de entrada");
  assert.equal(w2.peers.length, 1, "quem volta vê só a Ana, e não um fantasma de si mesmo");
  // Outra aba (outra sessão) do mesmo Beto não derruba a primeira.
  const b3 = cliente();
  await b3.entrar(id, { nome: "Beto 2", session: TOK("c") });
  await espera(200);
  assert.equal(b2.ws.readyState, WebSocket.OPEN, "sessões diferentes convivem");
  ok("sincronização: quem cai e volta mantém o id e a conexão direta (sem duplicata)");
  for (const c of [a, b2, b3]) c.ws.close();
}

/* -- porta em uso: o erro chega a quem é dono do servidor, sem exceção solta -- */
{
  const ocupado = createHttpServer({});
  await new Promise((r) => ocupado.listen(0, "127.0.0.1", r));
  const srv = createHttpServer({});
  attachSignaling(srv);
  const soltas = [];
  const pegaSolta = (e) => soltas.push(e);
  process.on("uncaughtException", pegaSolta);
  const erro = await new Promise((r) => {
    srv.once("error", r);
    srv.listen(ocupado.address().port, "127.0.0.1");
    setTimeout(() => r(null), 1000);
  });
  process.off("uncaughtException", pegaSolta);
  assert.equal(soltas.length, 0, "a sinalização não transforma o erro do servidor em exceção não tratada");
  assert.equal(erro?.code, "EADDRINUSE", "o erro chega a quem é dono do servidor (e o app de mesa tenta a próxima porta)");
  ocupado.close();
  ok("porta em uso: o erro chega ao servidor, sem janela de erro no app de mesa");
}

/* -- queda sem aviso: a saída espera a mesma aba voltar; sair pelo botão é na hora -- */
{
  const PORTA2 = PORT - 1;
  const srv = createHttpServer({});
  attachSignaling(srv, { graca: 400 });
  await new Promise((r) => srv.listen(PORTA2, r));
  const id = sala("graca");
  const a = cliente(PORTA2);
  await a.entrar(id, { nome: "Ana", session: TOK("a") });

  const b = cliente(PORTA2);
  const wb = await b.entrar(id, { nome: "Beto", session: TOK("b") });
  b.ws.terminate(); // queda de rede: sem leave, sem código 1000
  await espera(150);
  assert.ok(!a.msgs.some((m) => m.t === "peer-leave"), "não some na primeira oscilação");
  const saiu = await a.esperar((m) => m.t === "peer-leave" && m.id === wb.you.id, 2000);
  assert.ok(saiu, "não voltou a tempo: a saída é anunciada");

  const c = cliente(PORTA2);
  const wc = await c.entrar(id, { nome: "Caio", session: TOK("c") });
  c.send({ t: "leave" });
  const t0 = Date.now();
  await a.esperar((m) => m.t === "peer-leave" && m.id === wc.you.id, 300);
  assert.ok(Date.now() - t0 < 300, "quem sai pelo botão sai na hora");
  ok("sincronização: queda espera a volta antes de virar saída; o botão Sair é imediato");
  a.ws.close();
  srv.close();
}

/* -- moderação: só o anfitrião, conferido no servidor -- */
{
  const id = sala("mod");
  const host = cliente();
  const wh = await host.entrar(id, { nome: "Host", hostKey: TOK("host"), device: TOK("dh") });
  assert.equal(wh.you.host, true, "quem cria é o anfitrião");
  const g = cliente();
  const wg = await g.entrar(id, { nome: "Guest", device: TOK("dg") });
  assert.equal(wg.you.host, false);

  // Convidado tenta moderar: recusado.
  g.send({ t: "moderate", action: "kick", target: wh.you.id });
  const recusa = await g.esperar((m) => m.t === "error" && m.error === "not-host");
  assert.ok(recusa, "convidado não pode remover ninguém");
  assert.equal(host.ws.readyState, WebSocket.OPEN);

  host.send({ t: "moderate", action: "mute", target: wg.you.id });
  assert.equal((await g.esperar((m) => m.t === "moderated")).action, "mute", "silenciar chega ao alvo");

  host.send({ t: "moderate", action: "lower-hand", target: wg.you.id });
  await g.esperar((m) => m.t === "moderated" && m.action === "lower-hand");

  host.send({ t: "moderate", action: "kick", target: wg.you.id });
  await g.esperar((m) => m.t === "moderated" && m.action === "kick");
  const fim = await g.fechado;
  assert.equal(fim.code, 1008);
  assert.equal(fim.reason, "kicked", "o motivo diz ao cliente para não reconectar");

  // Mesmo aparelho, conexão nova: barrado.
  const volta = cliente();
  assert.equal((await volta.entrar(id, { nome: "Guest", device: TOK("dg") })).error, "kicked", "removido não volta pelo mesmo aparelho");
  ok("moderação: silenciar, baixar a mão e remover só pelo anfitrião; removido não volta");

  // Readmitir: o anfitrião vê a lista (sem o id do aparelho) e deixa voltar.
  const lista = await host.esperar((m) => m.t === "banned" && m.list.length === 1);
  assert.equal(lista.list[0].name, "Guest");
  assert.ok(!JSON.stringify(lista).includes(TOK("dg")), "o anfitrião não vê o identificador do aparelho");
  const intruso = cliente();
  await intruso.entrar(id, { nome: "Intruso" });
  intruso.send({ t: "moderate", action: "unban", target: lista.list[0].id });
  assert.ok(await intruso.esperar((m) => m.t === "error" && m.error === "not-host"), "só o anfitrião readmite");
  host.send({ t: "moderate", action: "unban", target: lista.list[0].id });
  const depois = await host.esperar((m) => m.t === "banned" && m.readmitted === "Guest");
  assert.equal(depois.list.length, 0);
  const voltou = cliente();
  assert.ok((await voltou.entrar(id, { nome: "Guest", device: TOK("dg") })).you, "readmitido entra pelo mesmo aparelho");
  voltou.ws.close();
  intruso.ws.close();
  ok("moderação: o anfitrião deixa voltar quem removeu (e só ele)");

  // O anfitrião cai e volta com a chave: recupera o papel.
  const outro = cliente();
  const wo = await outro.entrar(id, { nome: "Outro" });
  host.ws.terminate();
  await outro.esperar((m) => m.t === "peer-leave" && m.id === wh.you.id, 60_000).catch(() => null);
  const host2 = cliente();
  const wh2 = await host2.entrar(id, { nome: "Host", hostKey: TOK("host") });
  assert.equal(wh2.you.host, true, "a chave de anfitrião devolve o papel");
  await outro.esperar((m) => m.t === "host" && m.id === wh2.you.id);
  const chave = cliente();
  const falsa = await chave.entrar(id, { nome: "Esperto", hostKey: TOK("chute") });
  assert.equal(falsa.you.host, false, "chave errada não promove ninguém");
  ok("moderação: o anfitrião recupera o papel ao voltar; chave falsa não promove");
  void wo;
  for (const c of [host2, outro, chave, volta]) c.ws.close();
}

/* -- sala de espera -- */
{
  const id = sala("espera");
  const host = cliente();
  await host.entrar(id, { nome: "Host", hostKey: TOK("h2") });
  host.send({ t: "moderate", action: "lock" });
  await host.esperar((m) => m.t === "room" && m.closed === true);

  const bia = cliente();
  assert.equal((await bia.entrar(id, { nome: "Bia" })).t, "waiting", "sala trancada põe na espera");
  const batida = await host.esperar((m) => m.t === "knock" && m.name === "Bia");
  bia.send({ t: "chat", text: "posso?" });
  await espera(150);
  assert.ok(!host.msgs.some((m) => m.t === "chat"), "quem espera não fala na sala");

  host.send({ t: "moderate", action: "admit", target: batida.id });
  const w = await bia.esperar((m) => m.t === "welcome");
  assert.equal(w.peers.length, 1, "admitida, entra e vê o anfitrião");

  const caio = cliente();
  await caio.entrar(id, { nome: "Caio" });
  const b2 = await host.esperar((m) => m.t === "knock" && m.name === "Caio");
  host.send({ t: "moderate", action: "deny", target: b2.id });
  assert.equal((await caio.fechado).reason, "room-locked", "recusado sai com motivo definitivo");

  const davi = cliente();
  await davi.entrar(id, { nome: "Davi" });
  await host.esperar((m) => m.t === "knock" && m.name === "Davi");
  host.send({ t: "moderate", action: "unlock" });
  assert.ok(await davi.esperar((m) => m.t === "welcome"), "destrancar deixa entrar quem esperava");
  ok("sala de espera: bate, espera, é admitido ou recusado; destrancar libera");
  for (const c of [host, bia, davi]) c.ws.close();
}

/* -- som do computador no Linux: vem do monitor do PulseAudio/PipeWire -- */
{
  assert.equal(somDoComputadorNaLista("linux"), true, "o Linux mostra a opção de som");
  assert.equal(somDoComputadorNaLista("win32"), true);
  assert.equal(somDoComputadorNaLista("darwin"), false);
  const lista = [
    { kind: "audioinput", deviceId: "mic", label: "Microfone interno" },
    { kind: "videoinput", deviceId: "cam", label: "Monitor HD" },
    { kind: "audioinput", deviceId: "mon", label: "Monitor of Built-in Audio Analog Stereo" },
  ];
  assert.equal(escolherMonitor(lista)?.deviceId, "mon", "acha o monitor entre as entradas de áudio");
  assert.equal(escolherMonitor([{ kind: "audioinput", deviceId: "pt", label: "Monitor de Áudio interno" }])?.deviceId, "pt", "em português também");
  assert.equal(escolherMonitor([{ kind: "audioinput", deviceId: "mic", label: "Microfone" }]), null, "sem monitor: nada");
  ok("som do computador no Linux: a opção aparece e o monitor de som é achado");
}

/* -- aprovar quem entra: a sala já nasce com fila (como no Meet) -- */
{
  assert.equal(normalizeRoomMeta({ aprovar: true }).aprovar, true);
  assert.equal(normalizeRoomMeta({ aprovar: "sim" }).aprovar, false, "só true liga a fila");
  const id = sala("aprovar");
  const dono = cliente();
  const w = await dono.entrar(id, { meta: { name: "Com fila", aprovar: true }, hostKey: TOK("ap") });
  assert.equal(w.t, "welcome", "quem cria entra direto");
  const eva = cliente();
  assert.equal((await eva.entrar(id, { nome: "Eva" })).t, "waiting", "quem chega espera na fila");
  const batida = await dono.esperar((m) => m.t === "knock" && m.name === "Eva");
  dono.send({ t: "moderate", action: "admit", target: batida.id });
  assert.ok(await eva.esperar((m) => m.t === "welcome"), "aceita, entra");
  ok("aprovar quem entra: a sala nasce com fila e o anfitrião aceita");
  for (const c of [dono, eva]) c.ws.close();
}

/* -- protocolo -- */
{
  const p = parseClientMessage(JSON.stringify({ t: "moderate", action: "explodir", target: "x" }));
  assert.equal(p.ok, false, "ação desconhecida é recusada");
  const k = parseClientMessage(JSON.stringify({ t: "moderate", action: "kick" }));
  assert.equal(k.ok, false, "remover sem alvo é recusado");
  const j = parseClientMessage(JSON.stringify({ t: "join", room: "A".repeat(22), hostKey: "curta", session: "<script>" }));
  assert.equal(j.msg.hostKey, "", "chave fora do formato vira vazia");
  assert.equal(j.msg.session, "", "sessão fora do formato vira vazia");
  ok("protocolo: moderação e segredos validados na entrada");
}

/* -- CF-Connecting-IP: só quando ligado (app de mesa / TRUST_CLOUDFLARE) -- */
{
  // Com a opção desligada (padrão do servidor), forjar o cabeçalho não
  // escapa do limite de conexões por endereço.
  const { config } = await import("../src/config.js");
  const limite = config.limits.maxSocketsPerIp;
  const abertos = [];
  let recusados = 0;
  for (let i = 0; i < limite + 3; i++) {
    const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: { "cf-connecting-ip": `203.0.113.${i + 1}` } });
    const r = await new Promise((res) => {
      ws.on("open", () => res(true));
      ws.on("error", () => res(false));
    });
    if (r) abertos.push(ws);
    else recusados += 1;
  }
  assert.ok(recusados >= 3, "cabeçalho forjado não pode furar o limite por endereço");
  for (const ws of abertos) ws.close();
  ok("segurança: CF-Connecting-IP forjado não fura o limite de conexões");
}

/* -- SFU de quem transmite (fase 1): ficha, proxy e configuração -- */
{
  const { assinarFicha, conferirPacote, montarConfig, salaNoSfu } = await import("../desktop/sfu.js");
  const { definirSfu } = await import("../src/sfu.js");
  const { createHmac } = await import("node:crypto");
  const http = await import("node:http");
  const { WebSocketServer } = await import("ws");

  // Configuração: sinalização só local e vídeo que não pausa (as pausas e
  // trocas de camada eram as travadas de até 3 s da fase 0).
  const conf = montarConfig({ porta: 7880, portaUdp: 50000, chave: "k", segredo: "s" });
  assert.match(conf, /bind_addresses: \["127\.0\.0\.1"\]/);
  assert.match(conf, /allow_pause: false/);
  assert.match(conf, /use_external_ip: true/);

  // Ficha: JWT HS256 que o LiveKit aceita; só quem é local publica.
  const ficha = assinarFicha({ chave: "k", segredo: "s", id: "ana", nome: "Ana", sala: "abc", publica: false });
  const [c, b, a] = ficha.split(".");
  assert.equal(createHmac("sha256", "s").update(`${c}.${b}`).digest("base64url"), a, "assinatura confere");
  const corpo = JSON.parse(Buffer.from(b, "base64url").toString());
  assert.equal(corpo.video.canPublish, false, "quem assiste não publica");
  assert.equal(corpo.video.canPublishData, false);
  assert.ok(!salaNoSfu("sala-secreta").includes("secreta"), "o id da sala não vai para o LiveKit");

  // Pacote com SHA256 diferente do fixado não roda.
  const pasta = mkdtempSync(juntar(tmpdir(), "vcall-sfu-"));
  gravar(juntar(pasta, "x.zip"), "não é o LiveKit");
  await assert.rejects(conferirPacote(juntar(pasta, "x.zip"), "0".repeat(64)), /SHA256/);

  // Sem SFU (servidor puro): a sala fica na malha.
  const sem = cliente();
  await sem.entrar(sala("sfu0"));
  sem.send({ t: "sfu" });
  assert.equal((await sem.esperar((m) => m.t === "sfu")).entrada, null);

  // Um "LiveKit" de mentira atrás do /sfu/: HTTP e WebSocket.
  const caminhos = [];
  const lk = http.createServer((req, res) => (caminhos.push(req.url), res.end("ok")));
  const lkWs = new WebSocketServer({ server: lk });
  lkWs.on("connection", (w, req) => w.send(`oi ${req.url}`));
  await new Promise((r) => lk.listen(0, "127.0.0.1", r));
  const porta = lk.address().port;
  let ligado = false;
  definirSfu({
    porta: () => (ligado ? porta : null),
    ligar: async () => ((ligado = true), porta),
    ficha: (id, nome, s, publica) => `ficha-${publica}`,
  });

  // Quem chega pelo túnel (CF-Connecting-IP) não liga o SFU nem publica.
  const id = sala("sfu1");
  const fora = new WebSocket(`ws://localhost:${PORT}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  const msgsFora = [];
  fora.on("message", (r) => msgsFora.push(JSON.parse(String(r))));
  await new Promise((r) => fora.on("open", r));
  const esperarFora = async (pred) => {
    for (let i = 0; i < 60 && !msgsFora.some(pred); i++) await new Promise((r) => setTimeout(r, 50));
    return msgsFora.find(pred);
  };
  fora.send(JSON.stringify({ t: "join", room: id, profile: { name: "Fora" }, state: {} }));
  await esperarFora((m) => m.t === "welcome");
  fora.send(JSON.stringify({ t: "sfu" }));
  assert.equal((await esperarFora((m) => m.t === "sfu")).entrada, null, "de fora, com o SFU parado: malha");
  assert.equal(ligado, false, "quem é de fora não liga o SFU");

  // A janela do app liga e publica; depois, quem é de fora entra só para assistir.
  const local = cliente();
  await local.entrar(id);
  local.send({ t: "sfu" });
  assert.deepEqual((await local.esperar((m) => m.t === "sfu")).entrada, { url: "/sfu", token: "ficha-true" });
  msgsFora.length = 0;
  fora.send(JSON.stringify({ t: "sfu" }));
  assert.deepEqual((await esperarFora((m) => m.t === "sfu")).entrada, { url: "/sfu", token: "ficha-false" });

  // Proxy: /sfu/rtc vira /rtc no LiveKit, no HTTP e no WebSocket.
  const r = await fetch(`http://localhost:${PORT}/sfu/rtc/validate?access_token=x`);
  assert.equal(await r.text(), "ok");
  assert.equal(caminhos.at(-1), "/rtc/validate?access_token=x");
  const viaProxy = new WebSocket(`ws://localhost:${PORT}/sfu/rtc?access_token=x`);
  const eco = await new Promise((res, rej) => (viaProxy.on("message", (d) => res(String(d))), viaProxy.on("error", rej)));
  assert.equal(eco, "oi /rtc?access_token=x");

  for (const w of [viaProxy, fora, local.ws, sem.ws]) w.close();
  lkWs.close();
  lk.close();
  definirSfu(null);
  ok("SFU: só a janela do app publica, o id da sala não vaza e /sfu/ chega ao LiveKit");
}

server.close();

/* ================================================================== *
 * Compartilhar tela no app de mesa (desktop/captura.js)
 * ================================================================== */
{
  const fontes = [
    { id: "screen:1:0", name: "Entire screen" },
    { id: "window:42:0", name: "Planilha — LibreOffice" },
    { id: "window:7:1", name: "Vcall" },
    { id: "window:9:0", name: "" },
  ];
  const lista = descreverFontes(fontes, { propria: "window:7:1" });
  assert.deepEqual(
    lista.map((f) => f.id),
    ["screen:1:0", "window:42:0"],
    "a própria janela e as sem título ficam de fora",
  );
  assert.equal(lista[0].nome, "Tela 1");

  const pedido = { audioRequested: true, videoRequested: true };
  // O bug do Linux: `audio: undefined` presente no objeto.
  const linux = montarResposta({ fontes, escolha: null, pedido, plataforma: "linux" });
  assert.ok(!("audio" in linux), "no Linux a chave audio NÃO pode existir (o Electron recusa undefined)");
  const janela = montarResposta({ fontes, escolha: { id: "window:42:0", audio: false }, pedido, plataforma: "win32" });
  assert.equal(janela.video.id, "window:42:0", "a janela escolhida é a que vai");
  assert.ok(!("audio" in janela), "som só quando pedido");
  const comSom = montarResposta({ fontes, escolha: { id: "screen:1:0", audio: true }, pedido, plataforma: "win32" });
  assert.equal(comSom.audio, "loopback");
  const semPedido = montarResposta({ fontes, escolha: { id: "screen:1:0", audio: true }, pedido: { audioRequested: false }, plataforma: "win32" });
  assert.ok(!("audio" in semPedido), "sem áudio pedido pela página, sem áudio");
  assert.deepEqual(montarResposta({ fontes, escolha: { id: "window:999:0" }, pedido }), {}, "janela fechada: recusa");
  assert.equal(sessaoWayland({ XDG_SESSION_TYPE: "wayland" }), true);
  assert.equal(sessaoWayland({ XDG_SESSION_TYPE: "x11" }), false);
  assert.equal(audioDoSistemaSuportado("linux"), false);
  ok("desktop: escolha de tela/janela, Linux sem audio:undefined, som só quando pedido");

  // O app caía no Linux com dois pedidos de captura ao mesmo tempo (duas
  // sessões do portal no mesmo PipeWire): agora é um por vez, com prazo.
  let t = 0;
  const fila = umPorVez(1000, () => t);
  const a = fila.pegar();
  assert.ok(a !== null, "o primeiro pedido passa");
  assert.equal(fila.pegar(), null, "o segundo, no meio do primeiro, é recusado");
  fila.soltar(a);
  const b = fila.pegar();
  assert.ok(b !== null, "depois de responder, a vez volta");
  t = 1500;
  const c = fila.pegar();
  assert.ok(c !== null, "portal que nunca respondeu não prende a vez para sempre");
  fila.soltar(b);
  assert.equal(fila.pegar(), null, "a vez vencida, ao soltar atrasada, não libera a vez nova");
  ok("desktop: um pedido de captura por vez, com prazo");
}

/* ================================================================== *
 * Atualização automática (desktop/assinatura.js, desktop/atualizacao.js)
 * ================================================================== */
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const chavePrivada = privateKey.export({ type: "pkcs8", format: "pem" });
  const chavePublica = publicKey.export({ type: "spki", format: "pem" });
  const pasta = mkdtempSync(juntar(tmpdir(), "vcall-assina-"));
  const arquivo = juntar(pasta, "VcallSetup-3.7.0.exe");
  gravar(arquivo, Buffer.from("instalador de mentira"));
  const sha512 = await sha512DoArquivo(arquivo);
  const assinatura = assinar({ versao: "3.7.0", sha512, chavePrivada });

  assert.equal(confere({ versao: "3.7.0", sha512, assinatura, chavePublica }), true, "o pacote assinado por nós passa");
  assert.equal(confere({ versao: "v3.7.0", sha512, assinatura, chavePublica }), true, "a tag com v na frente é a mesma versão");
  gravar(arquivo, Buffer.from("instalador trocado no caminho"));
  const outro = await sha512DoArquivo(arquivo);
  assert.equal(confere({ versao: "3.7.0", sha512: outro, assinatura, chavePublica }), false, "arquivo trocado: recusa");
  assert.equal(confere({ versao: "3.8.0", sha512, assinatura, chavePublica }), false, "instalador antigo fingindo ser versão nova: recusa");
  const intrusa = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(confere({ versao: "3.7.0", sha512, assinatura: assinar({ versao: "3.7.0", sha512, chavePrivada: intrusa }), chavePublica }), false, "assinado por outra chave: recusa");
  assert.equal(confere({ versao: "3.7.0", sha512, assinatura: "lixo", chavePublica }), false, "assinatura malformada: recusa, sem exceção");
  assert.equal(confere({ versao: "3.7.0", sha512, assinatura: "", chavePublica }), false, "sem assinatura: recusa");

  const nomes = ["Vcall-3.7.0-x86_64.AppImage", "Vcall-3.7.0-amd64.deb", "Vcall-3.7.0-x86_64.rpm", "Vcall-3.7.0-x64.pacman"];
  assert.equal(nomeNaRelease(nomes, "Vcall-3.7.0-amd64.deb"), "Vcall-3.7.0-amd64.deb");
  assert.equal(nomeNaRelease(nomes, "update.rpm"), "Vcall-3.7.0-x86_64.rpm", "nome diferente no disco: acha pela extensão");
  assert.equal(nomeNaRelease(nomes, "algo.zip"), null);

  assert.equal(modoDeInstalacao({ plataforma: "win32", empacotado: true }), "sozinho");
  assert.equal(modoDeInstalacao({ plataforma: "linux", empacotado: true, appImage: true }), "sozinho");
  assert.equal(modoDeInstalacao({ plataforma: "linux", empacotado: true, tipoPacote: "deb\n" }), "senha", "Ubuntu/Fedora: o sistema pede a senha");
  assert.equal(modoDeInstalacao({ plataforma: "linux", empacotado: true, tipoPacote: "rpm" }), "senha");
  assert.equal(modoDeInstalacao({ plataforma: "linux", empacotado: true, tipoPacote: "pacman" }), "manual", "pacman fora do latest-linux.yml: só avisa");
  assert.equal(modoDeInstalacao({ plataforma: "linux", empacotado: true }), "manual", ".tar.gz: só avisa");
  assert.equal(modoDeInstalacao({ plataforma: "win32", empacotado: false }), "manual", "rodando do código-fonte: só avisa");
  assert.equal(instalaAoFechar({ conferida: "3.14.0", modo: "sozinho" }), true, "fechar o Vcall instala a versão conferida");
  assert.equal(instalaAoFechar({ conferida: "3.14.0", modo: "sozinho", desligando: true }), false, "Windows desligando: o instalador seria cortado no meio e o Vcall sumia");
  assert.equal(instalaAoFechar({ conferida: null, modo: "sozinho" }), false, "nada conferido: não instala");
  assert.equal(instalaAoFechar({ conferida: "3.14.0", modo: "senha" }), false, ".deb/.rpm: só pelo botão");
  assert.equal(maisNova("v3.10.0", "3.9.0"), true, "3.10 é mais nova que 3.9");
  assert.equal(maisNova("3.7.0", "3.7.0"), false);
  ok("atualização: só instala o que foi assinado por nós, na versão certa; modo por tipo de instalação; nunca com o sistema desligando");
}

/* ================================================================== *
 * Legendas offline (desktop/fala.js)
 * ================================================================== */
{
  // Monta um .zip pequeno à mão (método 0) e confere a conversão.
  const zip = zipSimples([
    ["vosk-model/am/final.mdl", Buffer.from("x".repeat(1000))],
    ["vosk-model/conf/model.conf", Buffer.from("--sample-frequency=16000\n")],
  ]);
  const entradas = lerZip(zip);
  assert.equal(entradas.length, 2);
  const tar = gunzipSync(zipParaTarGz(zip));
  const nomes = lerNomesTar(tar);
  assert.deepEqual(
    nomes,
    ["vosk-model/", "vosk-model/am/", "vosk-model/am/final.mdl", "vosk-model/conf/", "vosk-model/conf/model.conf"],
    "pastas que o .zip não lista entram no .tar antes do conteúdo",
  );
  assert.throws(() => lerZip(zipSimples([["../fora.txt", Buffer.from("x")]])), /suspeito/, "caminho que escapa da pasta é recusado");
  assert.throws(() => montarTar([{ nome: `${"a".repeat(200)}/b`, dados: Buffer.alloc(1), pasta: false }]), /longo/);
  assert.equal(nomeDoModelo("pt-BR"), "pt-BR.tar.gz");
  assert.equal(nomeDoModelo("xx-YY"), "pt-BR.tar.gz", "idioma desconhecido cai no português");
  const r = await responderModelo("/tmp", "vcall-fala://modelo/..%2F..%2Fetc%2Fpasswd");
  assert.equal(r.status, 404, "nada de caminho arbitrário pelo esquema interno");
  ok("legendas: .zip→.tar.gz correto, caminhos maliciosos recusados");
}

/* ================================================================== *
 * Convite pelo WhatsApp (public/js/lib/invite.js)
 * ================================================================== */
{
  const sala = "abcdefghijklmnopqrstuv";
  const publico = `https://exemplo.trycloudflare.com/#${sala}`;
  const convite = linkAbrir(publico);
  assert.equal(convite, `https://exemplo.trycloudflare.com/abrir#${sala}`);
  assert.equal(linkAbrir("https://x.com/#curto"), null, "sem sala válida, sem convite");
  assert.equal(salaDoFragmento(`#${sala}`), sala);
  const direto = linkDaSala("https://exemplo.trycloudflare.com", sala);
  const app = linkDoAplicativo(direto);
  const destino = destinoDoLink(app);
  assert.deepEqual(destino, { tipo: "remoto", url: direto }, "o link vcall:// gerado é aceito pelo app de mesa");
  const wa = linkWhatsApp(convite);
  assert.equal(wa, `https://wa.me/?text=${encodeURIComponent(convite)}`, "só o link: o WhatsApp mostra o cartão sem o endereço escrito");
  assert.equal(ehCelular("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), true);
  assert.equal(ehCelular("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
  ok("convite: link https clicável no WhatsApp que o app de mesa aceita");
}

/* ================================================================== *
 * Aviso do canvas (public/js/features/board-notice.js)
 * ================================================================== */
{
  const n = createBoardNotice();
  const avisos = [];
  for (let i = 0; i < 40; i++) avisos.push(n.shouldAnnounce({ type: i % 2 ? "stroke-chunk" : "add" }));
  assert.equal(avisos.filter(Boolean).length, 1, "40 operações de desenho = 1 aviso");
  const m = createBoardNotice();
  m.seen();
  assert.equal(m.shouldAnnounce({ type: "add" }), false, "quem já abriu o canvas não é avisado");
  assert.equal(createBoardNotice().shouldAnnounce({ type: "cursor" }), false, "ponteiro não é desenho");
  ok("canvas: 'fulano está desenhando' aparece uma vez, não a cada traço");
}

/* ================================================================== *
 * Linux: Fedora, Arch, Ubuntu… (desktop/linux.js)
 * ================================================================== */
{
  const appimage = { APPIMAGE: "/home/ana/Vcall-3.1.0-x86_64.AppImage" };
  // Electron 38+ abre como Wayland nativo, e lá a janela não se posiciona:
  // com XWayland disponível, o Vcall reabre por ele. A opção vai na linha de
  // comando de verdade (via appendSwitch ela só chegava à GPU, e o app não
  // abria no Fedora). GTK 3 sempre.
  const argv = ["/opt/Vcall/vcall", "vcall://sala/abc"];
  const x11 = (env, a = argv) => argsParaX11({ plataforma: "linux", env, argv: a });
  assert.deepEqual(x11({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), ["vcall://sala/abc", "--ozone-platform=x11"], "Fedora/Ubuntu GNOME: reabre pelo XWayland, com o link");
  assert.equal(x11({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, [...argv, "--ozone-platform=x11"]), null, "já reaberto: não entra em laço");
  assert.equal(x11({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, [...argv, "--ozone-platform=wayland"]), null, "escolha da pessoa vale");
  assert.equal(x11({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }), null, "Wayland sem XWayland: fica nativo");
  assert.equal(x11({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), null, "X11: nada a fazer");
  assert.equal(argsParaX11({ plataforma: "win32", env: { DISPLAY: ":0", WAYLAND_DISPLAY: "w" }, argv }), null, "fora do Linux, nada");
  // Reabrir sem sair do processo: no AppImage, sair desmonta /tmp/.mount_* e
  // a cópia reaberta não subia ("Cannot mount AppImage").
  assert.equal(modoDeReabrir({ temExecve: true }), "execve", "com execve (Electron 44): o mesmo processo vira o novo");
  assert.equal(modoDeReabrir({ temExecve: false }), "reabrir");
  const main = (await import("node:fs")).readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
  assert.ok(/modoDeReabrir\(\) === "execve"[\s\S]{0,80}process\.execve\(process\.execPath/.test(main), "o main.js usa o execve antes de qualquer janela");
  // Sobreposição: dois pedidos seguidos ao abrir; o segundo se perdia. E o
  // canto vai no did-finish-load: no ready-to-show o módulo da página ainda
  // não ouvia, e a janela ficava no canto padrão.
  assert.ok(/once\("did-finish-load"[\s\S]{0,120}send\("vcall:canto", cantoSobreposicao\)/.test(main), "a sobreposição recebe o canto atual depois que a página carrega");
  // O WebRTCPipeWireCapturer saiu no M133; e o Chromium só lê um enable-features.
  assert.ok(!/appendSwitch\("enable-features", "WebRTCPipeWireCapturer"\)/.test(main), "sem a opção morta do PipeWire");
  assert.ok((main.match(/appendSwitch\("enable-features"/g) || []).length <= 1, "no máximo um enable-features (o Chromium só lê um)");
  assert.deepEqual(opcoesDeExibicao({ plataforma: "linux" }), [["gtk-version", "3"]]);
  assert.deepEqual(opcoesDeExibicao({ plataforma: "win32", env: {} }), [], "fora do Linux, nada");

  assert.equal(executavelParaRegistrar({ plataforma: "linux", env: appimage, execPath: "/tmp/.mount_x/vcall" }), appimage.APPIMAGE, "AppImage registra o próprio arquivo");
  assert.equal(executavelParaRegistrar({ plataforma: "linux", env: {}, execPath: "/opt/Vcall/vcall" }), null, ".deb/.rpm/pacman já têm .desktop");
  assert.equal(executavelParaRegistrar({ plataforma: "linux", env: {}, execPath: "/home/ana/vcall/vcall-bin" }), "/home/ana/vcall/vcall", ".tar.gz registra o lançador, não o vcall-bin");
  assert.equal(lancador("/opt/Vcall/vcall-bin"), "/opt/Vcall/vcall", "a atualização reabre pelo lançador");

  // O sandbox: quem decide é o lançador, antes de o Chromium subir (com
  // appendSwitch, o Chromium já tinha abortado com SIGTRAP no Ubuntu 24.04).
  const fsN = await import("node:fs");
  const tpl = fsN.readFileSync(new URL("./linux/depois-de-instalar.tpl", import.meta.url), "utf8");
  assert.ok(
    /^chmod 4755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/m.test(tpl) && !/unshare --user true/.test(tpl),
    "os pacotes deixam o chrome-sandbox setuid sempre, sem o teste do unshare como root",
  );
  if (process.platform === "linux") {
    const { execFileSync } = await import("node:child_process");
    const os = await import("node:os");
    const dir = fsN.mkdtempSync(juntar(os.tmpdir(), "vcall-lancador-"));
    fsN.copyFileSync(new URL("./linux/vcall.sh", import.meta.url), juntar(dir, "vcall"));
    fsN.writeFileSync(juntar(dir, "vcall-bin"), '#!/bin/sh\necho "$@"\n');
    fsN.writeFileSync(juntar(dir, "chrome-sandbox"), "");
    for (const f of ["vcall", "vcall-bin"]) fsN.chmodSync(juntar(dir, f), 0o755);
    // unshare falso no PATH: sai 0 (namespaces liberados) ou 1 (barrados, como o AppArmor faz).
    const abrir = (saida, env = {}) => {
      const bin = juntar(dir, `u${saida}`);
      fsN.mkdirSync(bin, { recursive: true });
      fsN.writeFileSync(juntar(bin, "unshare"), `#!/bin/sh\nexit ${saida}\n`, { mode: 0o755 });
      return execFileSync(juntar(dir, "vcall"), ["vcall://sala/x"], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf8" }).trim();
    };
    let apparmor = false;
    try {
      apparmor = fsN.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
    } catch {
      /* kernel sem o AppArmor do Ubuntu */
    }
    assert.equal(abrir(1), "--no-sandbox vcall://sala/x", "sem namespaces nem chrome-sandbox setuid: abre sem sandbox, com o link");
    assert.equal(abrir(1, { APPIMAGE: "/home/ana/v.AppImage" }), "--no-sandbox vcall://sala/x", "AppImage também");
    assert.equal(abrir(0), apparmor ? "--no-sandbox vcall://sala/x" : "vcall://sala/x", "com namespaces: sandbox ligado (salvo AppArmor restringindo)");
    fsN.rmSync(dir, { recursive: true, force: true });
  }
  ok("Linux: sandbox, link vcall:// e XWayland sem perder o AppImage, no Fedora, Arch, Ubuntu 24.04 e Debian");
}

/* ------------------------------------------------------------------ *
 * Tela de erro: o que a Cloudflare responde vira a explicação certa
 * ------------------------------------------------------------------ */
{
  // 530 (erro 1033) e 502: o Vcall de quem convidou fechou ou caiu.
  assert.equal(tipoDoCodigo(530), "tunel");
  assert.equal(tipoDoCodigo(502), "tunel");
  assert.equal(tipoDoCodigo(521), "tunel");
  assert.equal(tipoDoCodigo(524), "demora", "524 é tempo esgotado na Cloudflare");
  assert.equal(tipoDoCodigo(504), "demora");
  assert.equal(tipoDoCodigo(500), "servidor");
  assert.equal(tipoDoCodigo(530, false), "internet", "sem internet vence qualquer código");
  ok("tela de erro: código da Cloudflare vira a explicação certa");
}

/* ------------------------------------------------------------------ *
 * Legendas: o núcleo do reconhecimento e o encoder "curto"
 * ------------------------------------------------------------------ */
{
  // Palavras confirmadas só quando duas leituras concordam, e nunca voltam.
  const a = new Acordo();
  assert.deepEqual(a.ler("bom dia"), { confirmado: "", provisorio: "bom dia" });
  assert.deepEqual(a.ler("Bom dia a"), { confirmado: "Bom dia", provisorio: "a" });
  assert.deepEqual(a.ler("bom dia a todos"), { confirmado: "Bom dia a", provisorio: "todos" });
  assert.equal(a.ler("bom tia").confirmado, "Bom dia a", "o confirmado não muda com uma leitura pior");

  assert.equal(limpar("Obrigado por assistir!"), "", "alucinação clássica descartada");
  assert.equal(limpar("[Música] oi pessoal"), "oi pessoal");
  assert.equal(limpar("sim sim sim sim sim"), "sim", "laço de repetição colapsado");
  assert.equal(limpar("vamos começar", "hoje nós vamos começar"), "", "eco do contexto descartado");
  assert.equal(limpar("  ok,  vamos lá "), "ok, vamos lá");

  assert.equal(quadrosPara(16_000 * 3), 400, "3 s de fala + 1 s de folga");
  assert.equal(quadrosPara(16_000 * 40), 3000, "nunca passa da janela de 30 s");
  assert.ok(tokensPara(16_000 * 2) < tokensPara(16_000 * 8), "limite de texto cresce com o áudio");

  assert.deepEqual(wer("Bom dia, a todos!", "bom dia a todos"), { erros: 0, palavras: 4 }, "pontuação e caixa não contam");
  assert.equal(wer("o prazo é sexta", "o prado é sexta feira").erros, 2);

  // Encoder de brinquedo com a mesma estrutura do Whisper: y = x + posições.
  const modelo = encoderDeBrinquedo();
  const curto = adaptarEncoder(modelo);
  assert.ok(jaAdaptado(curto) && !jaAdaptado(modelo));
  assert.equal(adaptarEncoder(curto), curto, "adaptar de novo não muda nada");
  const ort = (await import("onnxruntime-node")).default;
  const rodar = async (bytes, t) => {
    const s = await ort.InferenceSession.create(bytes, { logSeverityLevel: 3 });
    const x = new Float32Array(t * 2).fill(1);
    try {
      const r = await s.run({ x: new ort.Tensor("float32", x, [1, t, 2]) });
      return { y: [...r.y.data], saidas: s.outputNames };
    } catch (err) {
      return { erro: err.message, saidas: s.outputNames };
    }
  };
  const antes = await rodar(modelo, 3);
  assert.ok(antes.erro, "o original não aceita 3 posições (só 1500)");
  const depois = await rodar(curto, 3);
  assert.deepEqual(depois.y, [1, 1, 2, 2, 3, 3], "3 posições: x + posições[0..2]");
  assert.deepEqual(depois.saidas, ["y"], "as saídas de atenção saem do modelo");
  const cheio = await rodar(curto, 1500);
  assert.equal(cheio.y.length, 3000, "os 30 s inteiros continuam funcionando");
  ok("legendas: palavras confirmadas, limpeza de alucinações e encoder curto (saída idêntica)");
}

/* ------------------------------------------------------------------ *
 * Jogos de equipe: o estado converge, e ninguém vê o voto antes da hora
 * ------------------------------------------------------------------ */
{
  // Três pessoas; as mensagens chegam fora de ordem e às vezes repetidas.
  let semente = 7;
  const sorte = () => ((semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ids = ["aaa", "bbb", "ccc"];
  const nos = ids.map((id) => new EstadoJogos({ eu: id }));
  const fila = [];
  for (const n of nos) n.on("enviar", (lote) => nos.forEach((m) => m !== n && fila.push([m, lote])));
  const entregar = () => {
    while (fila.length) {
      const [m, lote] = fila.splice(Math.floor(sorte() * fila.length), 1)[0];
      m.aplicar(lote);
      if (sorte() < 0.3) m.aplicar(lote);
    }
  };
  const pessoas = ids.map((id) => ({ id, nome: id.toUpperCase() }));
  const igual = () => {
    const s0 = JSON.stringify([...nos[0].mapa].sort());
    for (const n of nos) assert.equal(JSON.stringify([...n.mapa].sort()), s0, "os três estados são idênticos");
  };

  // Planning Poker: o voto fica em casa até alguém revelar.
  const pk = nos.map((n) => new Poker(n, { nome: () => n.eu }));
  pk[0].adicionarHistorias(["Login com Google", "Tela de perfil"]);
  entregar();
  pk[0].votar("5");
  pk[1].votar("8");
  pk[2].votar("5");
  entregar();
  for (const n of nos) {
    const m = mesaPoker(n, { pessoas });
    assert.ok(m.todosVotaram && m.jogadores.every((j) => j.votou && j.valor == null), "todos votaram, nenhum valor à vista");
    assert.ok(!JSON.stringify(n.instantaneo()).includes('"8"'), "o 8 não saiu do aparelho de quem votou");
  }
  pk[1].revelar({ ms: 0 });
  entregar();
  entregar();
  for (const [i, n] of nos.entries()) {
    const v = mesaPoker(n, { pessoas, meuVoto: pk[i].meuVoto(), agora: Date.now() + 10 });
    assert.ok(v.revelado);
    assert.deepEqual(v.jogadores.map((j) => j.valor), ["5", "8", "5"]);
    assert.deepEqual([v.resultado.media, v.resultado.mediana, v.resultado.maioria, v.resultado.concordancia], [6, 5, "5", 67]);
  }
  igual();
  pk[0].salvarEstimativa(historias(nos[0])[0].id, "5");
  entregar();
  assert.equal(historias(nos[2])[0].estimativa, "5");
  const seguinte = mesaPoker(nos[2], { pessoas });
  assert.equal(seguinte.historia, historias(nos[2])[1].id, "salvar a estimativa passa para a próxima história");
  assert.ok(!seguinte.jogadores.some((j) => j.votou), "e a votação recomeça limpa");

  // Quem chega depois recebe tudo de uma vez e fica igual.
  const novo = new EstadoJogos({ eu: "ddd" });
  novo.aplicar(nos[1].instantaneo());
  assert.equal(JSON.stringify([...novo.mapa].sort()), JSON.stringify([...nos[1].mapa].sort()));

  // Resultado: consenso, "?" não conta, camisetas e ½.
  assert.equal(resultado(["8", "8", "8"]).consenso, true);
  assert.equal(resultado(["8"]).consenso, false, "uma pessoa sozinha não é consenso");
  assert.equal(resultado(["3", "5", "?"]).validos, 2);
  assert.equal(resultado(["M", "G", "M"], BARALHOS.camisetas).maioria, "M");
  assert.equal(resultado(["½", "1"], BARALHOS.modificado).media, 0.8);

  // Kanban do GitHub: as US marcadas entram uma vez só, com descrição, critérios, etiquetas e subtarefas; as subtarefas abertas viram itens votáveis logo abaixo; cada estimativa vai para o card uma vez, pelo computador de quem importou; e uma US grande se divide em sub-issues novas.
  {
    const gravados = [];
    const criados = [];
    const gh = (n) => `https://github.com/acme/app/issues/${n}`;
    const cards = [
      { item: "PVTI_1", conteudo: "I_12", titulo: "US12 — Pagar com Pix", numero: 12, url: gh(12), coluna: "c1", estimativa: null, subs: { total: 3, feitas: 1 } },
      { item: "PVTI_2", conteudo: "I_13", titulo: "Exportar PDF", numero: 13, url: gh(13), coluna: "c1", estimativa: 3, subs: null },
      // A sub-issue #42 também é card (com estimativa e outra coluna): vem com a US e usa o card dela.
      { item: "PVTI_42", conteudo: "I_42", titulo: "[US12] Webhook", numero: 42, url: gh(42), coluna: "c2", estimativa: 2, subs: null, pai: gh(12) },
    ];
    const longo = "x".repeat(300);
    const detalhes = {
      PVTI_1: {
        corpo: "**Descrição**\nComo cliente, quero pagar com Pix.\n\n**Critérios de aceite**\n- [ ] QR na tela\n- [x] Confirma em [10 s](https://x.y)\n",
        marcas: { etiquetas: [{ nome: "pagamentos", cor: "0E8A16" }, { nome: "x", cor: "red;}" }], pessoas: ["ana", "<b>"], tipo: { nome: "Feature", cor: "a2eeef" } },
        subs: [
          { conteudo: "I_40", titulo: "[US12] Criar cobrança", numero: 40, url: gh(40), feita: true, corpo: "" },
          { conteudo: "I_41", titulo: "Tela do QR", numero: 41, url: "javascript:alert(1)", feita: false, corpo: "Mostrar o QR.\n\n## Critérios\n- [ ] Some em 5 min" },
          { conteudo: "I_42", titulo: "[US12] Webhook", numero: 42, url: gh(42), feita: false, corpo: "" },
        ],
        subsTotal: 3,
      },
      // Muita coisa: tem de caber no limite de um valor do estado em vez de a história sumir.
      PVTI_2: { corpo: `${longo}\n${Array.from({ length: 20 }, (_, i) => `- [ ] critério ${i} ${longo}`).join("\n")}`, subs: Array.from({ length: 30 }, (_, i) => ({ conteudo: `I_${100 + i}`, titulo: `sub ${i} ${longo}`, numero: 100 + i, url: gh(100 + i), feita: true, corpo: "" })), subsTotal: 45 },
    };
    const ponte = async (acao, d) => {
      if (acao === "cards") return cards;
      if (acao === "detalhes") return Object.fromEntries(d.itens.map((i) => [i, detalhes[i]]));
      if (acao === "estimar") return gravados.push(d), { item: d.item || `PVTI_de_${d.conteudo}` };
      if (acao === "repositorio") return { id: "R_1", nome: "acme/app", pai: { numero: 12, titulo: "US12", marco: null }, pessoas: [], etiquetas: [], marcos: [], tipos: [] };
      if (acao === "criar") return criados.push(d), { conteudo: "I_77", numero: 77, url: gh(77), titulo: d.titulo, item: "PVTI_77", aviso: null };
      throw new Error(acao);
    };
    const passa = () => new Promise((ok) => setTimeout(ok, 0));
    const kg = new KanbanGithub(nos[0], pk[0], ponte);
    const projeto = { id: "PVT_x", titulo: "Sprint", status: { id: "F_st", nome: "Status", colunas: [{ id: "c1", nome: "Todo" }, { id: "c2", nome: "Doing" }] }, numeros: [{ id: "F_est", nome: "Estimativa" }] };
    const r = await kg.importar(projeto, cards.slice(0, 2), { campo: projeto.numeros[0], todos: cards });
    assert.deepEqual([r.novos, r.faltam], [2, 0]);
    entregar();
    assert.equal((await kg.importar(projeto, cards.slice(0, 2), { campo: projeto.numeros[0], todos: cards })).novos, 0, "importar de novo não repete cards");
    const doGh = historias(nos[2]).filter((h) => h.gh);
    assert.deepEqual(doGh.map((h) => [h.titulo, h.nivel, h.estimativa, h.gh.numero, h.gh.url]), [
      ["US12 — Pagar com Pix", 0, null, 12, gh(12)],
      ["Tela do QR", 1, null, 41, null],
      ["Webhook", 1, "2", 42, gh(42)],
      ["Exportar PDF", 0, "3", 13, gh(13)],
    ], "as subtarefas abertas entram logo abaixo da US (a fechada não), e a que é card traz a estimativa dele");
    const [us12, qr, webhook] = doGh;
    assert.ok(qr.pai === us12.id && webhook.pai === us12.id);
    const d1 = detalhesHistoria(nos[2], us12.id);
    assert.equal(d1.descricao, "Como cliente, quero pagar com Pix.", "a descrição sem o título e sem a checklist");
    assert.deepEqual([d1.criterios.nome, d1.criterios.itens], ["Critérios de aceite", [{ titulo: "QR na tela", feito: false }, { titulo: "Confirma em 10 s", feito: true }]]);
    assert.deepEqual(d1.subtarefas.itens.map((t) => [t.titulo, t.numero, t.url, t.feita]), [
      ["Criar cobrança", 40, gh(40), true],
      ["Tela do QR", 41, null, false],
      ["Webhook", 42, gh(42), false],
    ], "a etiqueta [US12] sai e um link que não é do GitHub não passa");
    assert.deepEqual(d1.marcas, { etiquetas: [{ nome: "pagamentos", cor: "0e8a16" }, { nome: "x", cor: null }], pessoas: ["ana"], tipo: { nome: "Feature", cor: "a2eeef" } }, "cor e login esquisitos não passam");
    const dq = detalhesHistoria(nos[2], qr.id);
    assert.deepEqual([dq.descricao, dq.criterios.itens.map((c) => c.titulo)], ["Mostrar o QR.", ["Some em 5 min"]], "a subtarefa traz a descrição dela");
    const d2 = detalhesHistoria(nos[2], doGh[3].id);
    assert.ok(d2.subtarefas.itens.length > 5 && d2.subtarefas.itens.length + d2.subtarefas.mais === 45, "subtarefas cortadas para caber, com a conta do resto");
    assert.ok(d2.criterios.itens.length >= 3 && d2.criterios.itens.length + d2.criterios.mais === 20, "critérios cortados para caber, com a conta do resto");

    pk[1].salvarEstimativa(us12.id, "8"); // outra pessoa salva
    entregar();
    await passa();
    assert.deepEqual(gravados, [{ projeto: "PVT_x", item: "PVTI_1", conteudo: "I_12", campo: "F_est", numero: 8, coluna: { campo: "F_st", opcao: "c1" } }], "quem importou grava o 8 no card");
    assert.equal(mesaPoker(nos[2], { pessoas }).historia, qr.id, "salvar a US passa para a subtarefa dela");
    pk[2].salvarEstimativa(qr.id, "5");
    entregar();
    await passa();
    assert.deepEqual(gravados[1], { projeto: "PVT_x", item: null, conteudo: "I_41", campo: "F_est", numero: 5, coluna: { campo: "F_st", opcao: "c1" } }, "a subtarefa fora do quadro entra nele, na coluna da US");
    pk[2].salvarEstimativa(qr.id, "3");
    entregar();
    await passa();
    assert.equal(gravados[2].item, "PVTI_de_I_41", "e da segunda vez já usa o card dela");
    pk[0].salvarEstimativa(webhook.id, "5");
    entregar();
    await passa();
    assert.deepEqual([gravados[3].item, gravados[3].coluna.opcao], ["PVTI_42", "c2"], "a subtarefa que é card grava no card dela");
    pk[2].votar("1");
    entregar();
    await passa();
    assert.equal(gravados.length, 4, "o que já foi gravado não vai de novo a cada mudança da mesa");
    pk[2].votar(null);
    entregar();

    // Ninguém na chamada aponta outra issue: um card inventado no estado não é gravado nem dividido.
    nos[1].definir([["p/h/zz", { titulo: "x", ordem: 99, estimativa: "8", gh: { item: "PVTI_999", conteudo: "I_999", url: "javascript:alert(1)" } }]]);
    entregar();
    await passa();
    const zz = historias(nos[1]).find((h) => h.id === "zz");
    assert.equal(zz.gh.url, null, "um link vindo de outro participante só aparece se for do github.com");
    assert.equal(gravados.length, 4);
    assert.ok(kg.podeDividir(us12) && kg.podeDividir(qr) && !kg.podeDividir(zz));
    assert.ok(!new KanbanGithub(nos[1], pk[1], ponte).podeDividir(us12), "só quem trouxe a US divide");
    pk[1].apagarHistoria("zz");
    entregar();

    // Dividir: a sub-issue nasce no GitHub embaixo da US, já no quadro, e entra na mesa logo abaixo.
    const f = await kg.formulario(us12);
    assert.deepEqual([f.repo.nome, f.coluna, f.cartas.join(" ")], ["acme/app", "c1", "0 1 2 3 5 8 13 21 34 55 89"]);
    const nova = await kg.criarSubtarefa(
      us12,
      { repositorio: "R_1", titulo: "Recibo por e-mail", corpo: "Mandar o recibo.\n\n## Critérios de aceite\n- [ ] Chega em 1 min", pessoas: ["U_1"], etiquetas: ["L_1"], marco: "", tipo: "", coluna: "c2", estimativa: "5" },
      { etiquetas: [{ nome: "pagamentos", cor: "0e8a16" }], pessoas: ["ana"], tipo: null },
    );
    assert.equal(nova.numero, 77);
    assert.deepEqual(criados, [{ pai: "I_12", repositorio: "R_1", titulo: "Recibo por e-mail", corpo: "Mandar o recibo.\n\n## Critérios de aceite\n- [ ] Chega em 1 min", pessoas: ["U_1"], etiquetas: ["L_1"], marco: null, tipo: null, projeto: "PVT_x", coluna: { campo: "F_st", opcao: "c2" }, estimativa: { campo: "F_est", numero: 5 } }]);
    entregar();
    await passa();
    const arvore = historias(nos[2]);
    const recibo = arvore.find((h) => h.gh?.numero === 77);
    assert.deepEqual([recibo.pai, recibo.nivel, recibo.estimativa, arvore.indexOf(recibo) - arvore.findIndex((h) => h.id === us12.id)], [us12.id, 1, "5", 3], "a subtarefa nova vem depois das outras da US");
    assert.equal(gravados.length, 4, "a estimativa da nova já foi junto ao criar");
    assert.deepEqual(detalhesHistoria(nos[2], recibo.id).criterios.itens.map((c) => c.titulo), ["Chega em 1 min"]);
    assert.deepEqual(detalhesHistoria(nos[2], recibo.id).marcas.etiquetas, [{ nome: "pagamentos", cor: "0e8a16" }]);
    assert.deepEqual(detalhesHistoria(nos[2], us12.id).subtarefas.itens.map((t) => t.numero), [40, 41, 42, 77], "e aparece na aba de subtarefas da US");

    // Apagar a US leva as subtarefas junto; um ciclo vindo de fora não some com ninguém nem trava.
    pk[0].apagarHistoria(us12.id);
    entregar();
    assert.deepEqual(historias(nos[1]).filter((h) => h.gh).map((h) => h.titulo), ["Exportar PDF"]);
    nos[1].definir([["p/h/ca", { titulo: "a", ordem: 1, pai: "cb" }], ["p/h/cb", { titulo: "b", ordem: 2, pai: "ca" }]]);
    assert.deepEqual(historias(nos[1]).filter((h) => h.id === "ca" || h.id === "cb").map((h) => [h.id, h.nivel]), [["ca", 0], ["cb", 1]]);
    pk[1].apagarHistoria("ca");
    entregar();
    assert.ok(!historias(nos[0]).some((h) => h.id === "ca" || h.id === "cb"));
  }

  // Retrospectiva: notas escondidas enquanto se escreve, 3 pontos por pessoa.
  const rt = nos.map((n) => new Retro(n, { nome: () => n.eu }));
  rt[0].adicionarNota(0, "Pareamento ajudou muito");
  rt[1].adicionarNota(2, "Daily mais curta");
  entregar();
  let vista = retro(nos[2], { pessoas });
  assert.ok(vista.colunas.flatMap((c) => c.notas).every((n) => n.texto == null), "texto dos outros escondido na escrita");
  assert.deepEqual(vista.escreveram.map((x) => x.notas), [1, 1, 0], "mas dá para ver quem já escreveu");
  rt[2].fase("votar");
  entregar();
  entregar();
  vista = retro(nos[2], { pessoas });
  assert.deepEqual(vista.colunas.flatMap((c) => c.notas).map((n) => n.texto).sort(), ["Daily mais curta", "Pareamento ajudou muito"]);
  const nota = vista.colunas[0].notas[0].id;
  for (let k = 0; k < 3; k += 1) assert.ok(rt[2].votar(nota, +1));
  assert.equal(rt[2].votar(nota, +1), false, "o quarto ponto é recusado");
  entregar();
  assert.equal(retro(nos[0]).colunas[0].notas[0].votos, 3);

  // Daily: ordem sorteada e tempo de cada um, igual para todos.
  const dl = nos.map((n) => new Daily(n));
  dl[0].sortear(pessoas);
  entregar();
  const t0 = Date.now();
  dl[1].proximo(t0);
  entregar();
  assert.equal(Math.round(daily(nos[2], { agora: t0 + 30_000 }).decorrido), 30);
  // Duas pessoas apertam "Próximo" ao mesmo tempo: avança uma vez só.
  dl[2].proximo(t0 + 100_000);
  dl[0].proximo(t0 + 100_000);
  entregar();
  assert.equal(daily(nos[1], { agora: t0 + 100_000 }).i, 1, "dois cliques juntos não pulam ninguém");
  dl[0].proximo(t0 + 160_000);
  entregar();
  dl[1].proximo(t0 + 200_000);
  entregar();
  const fim = daily(nos[2], { agora: t0 + 300_000 });
  assert.ok(fim.fim);
  assert.deepEqual(fim.ordem.map((o) => o.segundos), [100, 60, 40]);
  igual();

  // O que chega de fora e não presta é descartado.
  const e = new EstadoJogos({ eu: "x" });
  const aceitos = e.aplicar([
    ["../etc", 1, 1, "a"],
    ["p/h/x", "x".repeat(9999), 2, "a"],
    ["p/atual", "ok", 1e300, "a"],
    ["jogo", "poker", 3, "a"],
  ]);
  assert.deepEqual(aceitos, ["jogo"], "chave estranha, valor enorme e relógio absurdo recusados");
  ok("jogos: Poker, Retro e Daily convergem fora de ordem; voto e nota só aparecem na hora certa");
}

/* ------------------------------------------------------------------ *
 * Tailscale: o link pela rede privada de quem convida
 * ------------------------------------------------------------------ */
{
  // Respostas de verdade do CLI (tailscale v1.104, deslogado e sem daemon).
  const deslogado = { BackendState: "NeedsLogin", Self: { DNSName: "", TailscaleIPs: null }, Health: ["Tailscale is stopped."] };
  assert.equal(lerEstado(deslogado).motivo, "deslogado");
  assert.equal(interpretarFalha("Logged out."), MENSAGENS.deslogado);
  assert.equal(
    interpretarFalha("failed to connect to local tailscaled (which appears to be running as tailscaled, pid 1). Got error: ...; not running?"),
    MENSAGENS["sem-daemon"],
  );
  assert.match(interpretarFalha("flag provided but not defined: -https"), /1\.52/, "versão antiga pede atualização");
  assert.equal(interpretarFalha("serve config denied", "linux"), MENSAGENS.operador, "no Linux: o comando do operador");

  const rodando = {
    BackendState: "Running",
    Self: { DNSName: "maquina.tail1234.ts.net.", TailscaleIPs: ["100.101.5.5", "fd7a:115c:a1e0::5"] },
    CurrentTailnet: { Name: "time@example.com", MagicDNSEnabled: true },
    CertDomains: ["maquina.tail1234.ts.net"],
  };
  const e = lerEstado(rodando);
  assert.deepEqual([e.pronto, e.nome, e.ipv4, e.https], [true, "maquina.tail1234.ts.net", "100.101.5.5", true]);
  assert.equal(lerEstado({ ...rodando, CurrentTailnet: { MagicDNSEnabled: false } }).motivo, "sem-dns");

  // Não pisa no que a pessoa já publica.
  assert.equal(escolherPorta({}, "m.ts.net"), 443);
  assert.equal(escolherPorta({ TCP: { 443: { HTTPS: true } } }, "m.ts.net"), 8443);
  assert.equal(escolherPorta({ Web: { "m.ts.net:443": {} }, Foreground: { s1: { TCP: { 8443: {} } } } }, "m.ts.net"), 10000);
  assert.equal(escolherPorta({ TCP: { 443: {}, 8443: {}, 10000: {} } }, "m.ts.net"), null);
  assert.equal(urlDe("m.ts.net", 443), "https://m.ts.net");
  assert.equal(urlDe("m.ts.net", 8443), "https://m.ts.net:8443");

  // Endereços da tailnet: a mesma regra no servidor e no navegador.
  for (const [ip, sim] of [["100.64.0.1", true], ["100.127.255.254", true], ["100.63.0.1", false], ["100.128.0.1", false], ["::ffff:100.101.5.5", true], ["fd7a:115c:a1e0::1", true], ["192.168.0.10", false], ["", false]]) {
    assert.equal(ehIpTailscale(ip), sim, ip);
    assert.equal(ehIpTailscaleNavegador(ip), sim, `navegador: ${ip}`);
  }

  // O IP real de quem entra pelo `tailscale serve` (que SUBSTITUI o X-Forwarded-For).
  const pedido = (headers, ip = "127.0.0.1") => ({ socket: { remoteAddress: ip }, headers });
  assert.equal(clientIp(pedido({ "x-forwarded-for": "100.101.102.103" }), { trustTailscale: true }), "100.101.102.103");
  assert.equal(clientIp(pedido({ "x-forwarded-for": "100.101.102.103" }), { trustTailscale: false }), "127.0.0.1", "desligado, não confia");
  assert.equal(clientIp(pedido({ "x-forwarded-for": "8.8.8.8" }), { trustTailscale: true }), "127.0.0.1", "fora da tailnet, não confia");
  assert.equal(
    clientIp(pedido({ "x-forwarded-for": "100.101.102.103", "cf-connecting-ip": "203.0.113.9" }), { trustTailscale: true, trustCloudflare: true }),
    "203.0.113.9",
    "pelo túnel do Cloudflare, um X-Forwarded-For forjado não vale",
  );
  assert.equal(clientIp(pedido({ "x-forwarded-for": "100.101.102.103" }, "192.168.0.7"), { trustTailscale: true }), "192.168.0.7", "só de dentro da máquina");

  // O fluxo inteiro, com um `tailscale serve` de mentira (sem shell: roda até no Windows).
  const falso = ({ habilitar = false, morre = false } = {}) => {
    const chamadas = [];
    const gerar = (cli, args) => {
      chamadas.push(args.join(" "));
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.morto = false;
      proc.kill = () => {
        proc.morto = true;
        setImmediate(() => proc.emit("exit", null));
      };
      setTimeout(() => {
        if (morre) {
          proc.stderr.write("serve config denied\n");
          return setTimeout(() => proc.emit("exit", 1), 5);
        }
        if (habilitar) proc.stdout.write("\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nX\n");
        setTimeout(() => proc.stdout.write("Available within your tailnet:\n\nhttps://maquina.tail1234.ts.net/\n\nPress Ctrl+C to exit.\n"), habilitar ? 40 : 5);
      }, 5);
      falso.ultimo = proc;
      return proc;
    };
    const rodar = async (cli, args) =>
      args[0] === "status"
        ? { code: 0, stdout: JSON.stringify(rodando), stderr: "" }
        : { code: 0, stdout: JSON.stringify({ TCP: { 443: {} } }), stderr: "" };
    return { achar: async () => "tailscale", rodar, gerar, pedir: async () => 200, chamadas };
  };

  const f1 = falso({ habilitar: true });
  const link = new LinkTailscale(7718, f1);
  const estados = [];
  link.on("status", (st) => estados.push(st.state + (st.habilitar ? `:${st.habilitar}` : "")));
  assert.equal(await link.start(), "https://maquina.tail1234.ts.net:8443");
  assert.deepEqual(f1.chamadas, ["serve --https=8443 http://127.0.0.1:7718"], "primeiro plano (sem --bg), na 8443 porque a 443 estava em uso");
  assert.deepEqual(estados, ["conferindo", "habilitar:https://login.tailscale.com/f/serve?node=nX", "verificando", "pronto"]);
  link.stop();
  assert.ok(falso.ultimo.morto, "desligar mata o serve (e o Tailscale desfaz a publicação)");
  assert.equal(link.url, null);

  // O serve cai sozinho (Tailscale fechado): o link some.
  const f2 = falso();
  const link2 = new LinkTailscale(7718, f2);
  await link2.start();
  falso.ultimo.emit("exit", 0);
  assert.deepEqual([link2.state, link2.url], ["parado", null]);

  // Sem permissão no Linux: a mensagem diz o que fazer.
  const link3 = new LinkTailscale(7718, falso({ morre: true }));
  await assert.rejects(link3.start(), (err) => err.message === interpretarFalha("serve config denied"));
  assert.equal(link3.state, "erro");
  ok("Tailscale: estados reais do CLI, porta livre, IP da tailnet, serve em primeiro plano que morre junto");
}

/* ------------------------------------------------------------------ *
 * Rede Tailscale: chamadas de todos os computadores e "Na minha rede"
 * ------------------------------------------------------------------ */
{
  // Quem é "da rede": a própria máquina, ou quem veio pelo tailscale serve.
  const pedido = (headers = {}, ip = "127.0.0.1") => ({ socket: { remoteAddress: ip }, headers });
  assert.equal(ehDaRede(pedido()), true, "a janela do app, na própria máquina");
  assert.equal(ehDaRede(pedido({ "x-forwarded-for": "100.101.102.103" }), { trustTailscale: true }), true, "pela tailnet");
  assert.equal(ehDaRede(pedido({ "x-forwarded-for": "100.101.102.103" }), { trustTailscale: false }), false);
  assert.equal(ehDaRede(pedido({ "cf-connecting-ip": "203.0.113.9" }), { trustTailscale: true }), false, "pelo túnel do Cloudflare, não");
  assert.equal(ehDaRede(pedido({ "x-forwarded-for": "203.0.113.9" }), { trustTailscale: true }), false, "proxy de fora da tailnet, não");
  assert.equal(ehDaRede(pedido({}, "192.168.0.20")), false, "outro computador direto, não");
  assert.equal(ehDaRede(pedido(), { trustProxy: true }), false, "atrás de proxy declarado, sem endereço da tailnet, não");

  // Visibilidade "rede": o servidor aceita e o diretório só mostra para a rede.
  assert.equal(normalizeRoomMeta({ visibility: "rede" }).visibility, "rede");
  assert.equal(normalizeRoomMeta({ visibility: "qualquer" }).visibility, "private");
  const reg = new RoomRegistry();
  const ID = (c) => c.repeat(20);
  const entrar = (sala) => sala.add(new Participant({ readyState: 1, send() {} }, { room: sala.id, profile: { name: "Ana" }, state: { mic: true } }));
  entrar(reg.ensure(ID("p"), { name: "Pública", visibility: "public" }));
  entrar(reg.ensure(ID("r"), { name: "Do time", visibility: "rede" }));
  entrar(reg.ensure(ID("x"), { name: "Segredo", visibility: "private" }));
  assert.deepEqual(reg.directory().map((r) => r.name), ["Pública"], "de fora: só a pública");
  assert.deepEqual(reg.directory({ rede: true }).map((r) => r.name).sort(), ["Do time", "Pública"], "da rede: pública e da rede, nunca a privada");

  // As mesmas regras pela HTTP de verdade: /api/rooms e /api/rede.
  const srv = createHttpServer({
    registry: reg,
    trustTailscale: true,
    rede: async () => ({ disponivel: true, computadores: [] }),
    pessoa: () => ({ nome: "Ana", avatar: { style: "thumbs", seed: "a" } }),
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const pegar = async (caminho, headers = {}) => {
    const res = await fetch(base + caminho, { headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const local = await pegar("/api/rooms");
  assert.equal(local.json.servidor, "vcall", "o servidor se identifica para a varredura da rede");
  assert.deepEqual(local.json.rooms.map((r) => r.name).sort(), ["Do time", "Pública"]);
  const pelaTailnet = await pegar("/api/rooms", { "x-forwarded-for": "100.101.102.103" });
  assert.equal(pelaTailnet.json.rooms.length, 2, "quem vem pela tailnet vê a sala da rede");
  assert.equal(pelaTailnet.json.pessoa?.nome, "Ana", "pela tailnet, vê quem está no computador");
  const peloTunel = await pegar("/api/rooms", { "cf-connecting-ip": "203.0.113.9" });
  assert.deepEqual(peloTunel.json.rooms.map((r) => r.name), ["Pública"], "pelo link público, a sala da rede não existe");
  assert.equal(peloTunel.json.pessoa, null, "pelo link público, ninguém vê quem está no computador");
  assert.equal((await pegar("/api/rede")).status, 200);
  assert.equal((await pegar("/api/rede", { "cf-connecting-ip": "203.0.113.9" })).status, 404, "a lista da rede não vaza pelo túnel");
  srv.close();

  // A varredura: só computadores ligados, só quem é Vcall, e com prazo.
  const st = {
    BackendState: "Running",
    Self: { DNSName: "eu.tail1.ts.net.", TailscaleIPs: ["100.64.0.1"] },
    CurrentTailnet: { Name: "time", MagicDNSEnabled: true },
    Peer: {
      a: { DNSName: "notebook-ana.tail1.ts.net.", HostName: "notebook-ana", Online: true, TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"], OS: "windows" },
      b: { DNSName: "celular.tail1.ts.net.", HostName: "celular", Online: true, TailscaleIPs: ["100.64.0.3"], OS: "android" },
      c: { DNSName: "desligado.tail1.ts.net.", HostName: "desligado", Online: false, TailscaleIPs: ["100.64.0.4"] },
      d: { DNSName: "malicioso.tail1.ts.net.", HostName: "malicioso", Online: true, TailscaleIPs: ["100.64.0.5"] },
    },
  };
  assert.deepEqual(paresOnline(st).map((p) => p.curto), ["notebook-ana", "celular", "malicioso"]);
  assert.equal(pareceVcall({ rooms: [], stats: { publicRooms: 0 } }), true, "um Vcall 3.9 (sem a marca) também conta");
  assert.equal(pareceVcall({ rooms: [] }), false);
  assert.equal(limparSala({ id: "../../etc", name: "x" }), null, "id de sala inválido é descartado");
  assert.deepEqual(limparPessoa({ nome: " Ana ", avatar: { style: "thumbs", seed: "a", photo: "data:image/png;base64,x" } }), { nome: "Ana", avatar: { style: "thumbs", seed: "a" } }, "foto não passa");
  assert.equal(limparPessoa({ nome: "   " }), null, "sem nome: ninguém");
  assert.deepEqual(limparPessoa({ nome: "x".repeat(500), avatar: "<svg>" }), { nome: "x".repeat(40), avatar: null }, "nome cortado, avatar estranho some");

  let agora = 1_000_000;
  const pedidos = [];
  const salaAna = { id: ID("a"), code: "ABC123", name: "Planning", visibility: "rede", size: 3, max: 16, host: { name: "Ana", avatar: { style: "thumbs", seed: "a" } } };
  const pedir = async (url, ip) => {
    pedidos.push(url);
    if (url.startsWith("https://notebook-ana.tail1.ts.net:8443/")) {
      return { status: 200, json: { servidor: "vcall", versao: "3.10.0", rooms: [salaAna], pessoa: { nome: "Ana", avatar: { style: "thumbs", seed: "a" } } } };
    }
    if (url.startsWith("https://malicioso.tail1.ts.net/")) {
      return { status: 200, json: { servidor: "vcall", rooms: [{ id: ID("m"), name: "y".repeat(5000), size: -5, host: { name: { toString: 1 } }, extra: "<script>" }] } };
    }
    throw new Error("ECONNREFUSED");
  };
  const rede = new RedeVcall({
    achar: async () => "tailscale",
    rodar: async () => ({ code: 0, stdout: JSON.stringify(st), stderr: "" }),
    pedir,
    eu: () => ({ url: "https://eu.tail1.ts.net", salas: [] }),
    agora: () => agora,
  });
  const lista = await rede.listar();
  assert.equal(lista.disponivel, true);
  const nomes = lista.computadores.map((c) => c.curto);
  assert.equal(nomes[0], "eu", "este computador primeiro");
  assert.deepEqual(nomes.slice(1).sort(), ["malicioso", "notebook-ana"], "o celular sem Vcall e o desligado ficam de fora");
  const ana = lista.computadores.find((c) => c.curto === "notebook-ana");
  assert.equal(ana.url, "https://notebook-ana.tail1.ts.net:8443", "achou o Vcall na porta em que ele está");
  assert.equal(ana.salas[0].name, "Planning");
  assert.equal(ana.pessoa?.nome, "Ana", "mostra quem está no computador");
  assert.equal(lista.computadores.find((c) => c.curto === "malicioso").pessoa, null, "Vcall antigo, sem pessoa: fica o nome da máquina");
  const mal = lista.computadores.find((c) => c.curto === "malicioso").salas[0];
  assert.equal(mal.name.length, 48, "nome gigante cortado");
  assert.equal(mal.size, 0, "número inválido zerado");
  assert.equal(mal.host.name, "", "tipo errado vira vazio");
  assert.ok(!("extra" in mal), "campo desconhecido não passa");

  // Logo depois: devolve a lista guardada, sem perguntar de novo.
  const antes = pedidos.length;
  await rede.listar();
  assert.equal(pedidos.length, antes, "lista fresca vem do cache");
  // Mais tarde: quem não é Vcall (o celular) não é perguntado por 2 minutos.
  agora += 10_000;
  await rede.listar();
  await new Promise((r) => setTimeout(r, 20));
  const novos = pedidos.slice(antes);
  assert.ok(!novos.some((u) => u.includes("celular")), "o celular sem Vcall não é perguntado de novo tão cedo");
  agora += 31_000;
  await rede.listar();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(pedidos.slice(antes + novos.length).some((u) => u.includes("celular")), "depois de 30 s, é perguntado de novo (pode ter ligado o Vcall)");
  assert.ok(novos.some((u) => u.startsWith("https://notebook-ana.tail1.ts.net:8443/")), "o Vcall conhecido é perguntado primeiro na porta certa");

  // Sem Tailscale pronto: a rede some do painel, sem erro.
  const semLogin = new RedeVcall({ achar: async () => "tailscale", rodar: async () => ({ stdout: JSON.stringify({ BackendState: "NeedsLogin" }) }) });
  assert.deepEqual(await semLogin.listar(), { disponivel: false, motivo: "deslogado", computadores: [] });
  ok("rede Tailscale: sala \"Na minha rede\" só para a tailnet, varredura dos computadores com Vcall, dados de fora limpos");
}

/* ------------------------------------------------------------------ *
 * Link curto do convite: prévia do WhatsApp por chamada, dado de fora
 * escapado, imagem em endereço absoluto
 * ------------------------------------------------------------------ */
{
  const html = '<head>\n<!-- prévia:início -->\n<title>x</title>\n<!-- prévia:fim -->\n</head>';
  const sala = { id: "Ab3_dE-fGh1JkLmN0pQr", name: 'Planning "da" <Ana>', host: { profile: { name: "Ana & Bia" } } };
  const req = { headers: { host: "rio-azul.trycloudflare.com", "x-forwarded-proto": "https" } };
  const p = paginaDoConvite(html, { sala, origem: origemPublica(req), codigo: "AB3XYZ" });
  assert.ok(p.includes('og:title" content="Planning &quot;da&quot; &lt;Ana&gt; · Vcall"'), "nome da sala escapado");
  assert.ok(p.includes("Ana &amp; Bia te chamou"), "quem chamou, escapado");
  assert.ok(p.includes('og:image" content="https://rio-azul.trycloudflare.com/assets/convite.jpg"'), "imagem em endereço absoluto");
  assert.ok(p.includes('name="vcall-sala" content="Ab3_dE-fGh1JkLmN0pQr"'));
  assert.ok(!p.includes("<title>x</title>"), "a prévia genérica sai");
  const fim = paginaDoConvite(html, { sala: null, origem: null, codigo: "ZZZZZZ" });
  assert.ok(fim.includes("Chamada encerrada") && fim.includes('vcall-convite" content="encerrado"') && !fim.includes("vcall-sala"));
  assert.equal(origemPublica({ headers: { host: 'x"><script>' } }), null, "Host estranho não entra na página");
  assert.equal(origemPublica({ headers: { host: "localhost:3000" }, socket: {} }), "http://localhost:3000");
  assert.ok(ROTA_CURTA.test("/c/AB3XYZ") && !ROTA_CURTA.test("/c/../x") && !ROTA_CURTA.test("/c/AB3XYZ/x"));
  assert.equal(linkCurto("https://rio-azul.trycloudflare.com/#Ab3_dE-fGh1JkLmN0pQr", "ab3xyz"), "https://rio-azul.trycloudflare.com/c/AB3XYZ");
  assert.equal(linkCurto("https://rio-azul.trycloudflare.com/#Ab3_dE-fGh1JkLmN0pQr", ""), "https://rio-azul.trycloudflare.com/abrir#Ab3_dE-fGh1JkLmN0pQr", "sem código, o convite de sempre");
  {
    const sala = "https://rio-azul.trycloudflare.com/#Ab3_dE-fGh1JkLmN0pQr";
    const u = encodeURIComponent(sala);
    assert.equal(linkIntentAndroid(sala), `intent://join?u=${u}#Intent;scheme=vcall;package=com.vcall.app;S.browser_fallback_url=${u};end`);
    assert.equal(linkIntentAndroid("http://192.168.0.10:3000/#Ab3_dE-fGh1JkLmN0pQr"), null, "http de rede local: o app recusa, fica no navegador");
    assert.ok(linkIntentAndroid("http://localhost:3000/#Ab3_dE-fGh1JkLmN0pQr"));
    assert.equal(linkIntentAndroid("lixo"), null);
    assert.ok(ehAndroid("Mozilla/5.0 (Linux; Android 14) Mobile") && !ehAndroid("Mozilla/5.0 (iPhone)"));
  }
  ok("convite curto: /c/CODIGO com a prévia da chamada no WhatsApp, tudo escapado");
}

{
  const convite = "https://rio-azul-casa.trycloudflare.com/c/AB3XYZ";
  const pedidos = [];
  const resposta = (texto, ok = true) => ({ ok, text: async () => texto });
  // is.gd fora do ar: cai no TinyURL. Só pergunta uma vez por convite.
  let enc = criarEncurtador({
    fetch: async (u) => (pedidos.push(u), u.startsWith("https://is.gd/") ? resposta("Error", false) : resposta("https://tinyurl.com/2abc9xy\n")),
  });
  assert.equal(await enc(convite), "https://tinyurl.com/2abc9xy");
  assert.equal(await enc(convite), "https://tinyurl.com/2abc9xy");
  assert.equal(pedidos.length, 2, "cache: o mesmo convite não é encurtado de novo");
  assert.ok(pedidos[0].includes(encodeURIComponent(convite)));
  enc = criarEncurtador({ fetch: async () => resposta("https://is.gd/AbC123") });
  assert.equal(await enc(convite), "https://is.gd/AbC123");
  // Só o convite do túnel: não é um encurtador aberto.
  assert.equal(await enc("https://exemplo.com/c/AB3XYZ"), null);
  assert.equal(await enc("https://rio-azul-casa.trycloudflare.com/#sala"), null);
  // Resposta estranha (HTML, outro domínio) não vira convite.
  enc = criarEncurtador({ fetch: async () => resposta("<html>https://golpe.example/x</html>") });
  assert.equal(await enc(convite), null);
  // Sem rede: fica o link do túnel, e tenta de novo depois.
  let falhas = 0;
  enc = criarEncurtador({ fetch: async () => (falhas++, Promise.reject(new Error("offline"))) });
  assert.equal(await enc(convite), null);
  assert.equal(await enc(convite), null);
  assert.equal(falhas, 4);
  ok("encurtador: is.gd com TinyURL de reserva, só o convite do túnel, resposta conferida");
}

/* ------------------------------------------------------------------ *
 * Atualizar o AppImage no Linux: antes o arquivo era apagado e salvo com
 * outro nome (o atalho do menu quebrava) e a versão nova abria com a antiga
 * ainda viva (e se fechava). Agora: mesmo caminho, e só reabre depois.
 * ------------------------------------------------------------------ */
if (process.platform === "linux") {
  const { mkdtempSync: mk, writeFileSync: escreve, readFileSync: le, existsSync: existe, readdirSync } = await import("node:fs");
  const { spawn: sp } = await import("node:child_process");
  const dir = mk(juntar(tmpdir(), "vcall-appimage-"));
  const atual = juntar(dir, "Vcall-3.7.7-x86_64.AppImage");
  const marca = juntar(dir, "abriu.txt");
  escreve(atual, "#!/bin/sh\necho velho >> " + marca + "\n", { mode: 0o755 });
  const novo = juntar(dir, "baixado.AppImage");
  escreve(novo, "#!/bin/sh\necho \"novo $APPIMAGE\" >> " + marca + "\n");
  // O "Vcall antigo" ainda está rodando: um processo que demora a sair.
  const velho = sp("sleep", ["1.2"]);
  assert.equal(trocarAppImage({ novo, atual }), atual, "o caminho não muda (atalhos continuam valendo)");
  assert.ok(le(atual, "utf8").includes("novo"), "o arquivo foi trocado");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".AppImage")).sort(), ["Vcall-3.7.7-x86_64.AppImage", "baixado.AppImage"], "nada com outro nome, nenhum resto");
  reabrirDepois({ pid: velho.pid, exe: atual, env: { ...process.env, APPIMAGE: "/tmp/.mount_x/velho" } });
  await espera(500);
  assert.ok(!existe(marca), "não abre enquanto o antigo ainda está vivo (a trava de instância única fecharia a nova)");
  await new Promise((r) => velho.on("exit", r));
  await espera(900);
  assert.equal(le(marca, "utf8").trim(), "novo", "abre a versão nova depois que a antiga sai, sem o APPIMAGE do processo velho");
  assert.throws(() => trocarAppImage({ novo, atual: "relativo/Vcall.AppImage" }), /inválido/);
  ok("atualização do AppImage: mesmo arquivo, atalho intacto, reabre só depois que a versão antiga fecha");
}

/*
 * O processo que reabre o app nascia herdando os arquivos abertos do Vcall
 * antigo (app.asar, .pak de dentro da montagem velha) e os passava para a
 * versão nova: a montagem do AppImage antigo nunca era desmontada e o arquivo
 * trocado seguia ocupando o disco. Agora o bash fecha tudo acima do 2.
 */
if (process.platform === "linux") {
  const { interpretador } = await import("../desktop/appimage.js");
  const { mkdtempSync: mk, writeFileSync: escreve, readFileSync: le, openSync } = await import("node:fs");
  const { spawn: sp } = await import("node:child_process");
  assert.equal(interpretador(() => false).sh, "/bin/sh", "sem bash, sh");
  assert.equal(interpretador(() => false).fechar, "", "e sem o laço que o dash não entende");
  assert.ok(interpretador(() => true).fechar.includes("exec $n>&-"));
  const dir = mk(juntar(tmpdir(), "vcall-fd-"));
  const herdado = juntar(dir, "app.asar");
  escreve(herdado, "velho");
  const marca = juntar(dir, "fds.txt");
  const exe = juntar(dir, "Vcall.AppImage");
  escreve(exe, `#!/bin/sh\nls -l /proc/$$/fd > ${marca}\n`, { mode: 0o755 });
  const fd = openSync(herdado, "r");
  // Como o Chromium: um arquivo aberto sem fechar-ao-executar chega ao filho.
  const comHerdado = (cmd, args, o) => sp(cmd, args, { ...o, stdio: ["ignore", "ignore", "ignore", fd] });
  reabrirDepois({ pid: 999999, exe, env: process.env, spawn: comHerdado });
  await espera(1200);
  const fds = le(marca, "utf8");
  assert.ok(!fds.includes(herdado), `a versão nova não pode receber os arquivos da antiga:\n${fds}`);
  ok("reabrir o AppImage não passa adiante os arquivos abertos da versão antiga");
}

/*
 * .deb e .rpm: o electron-updater instalava com pkexec de forma síncrona, com
 * a janela aberta e congelada ("não está respondendo"), trocando /opt/Vcall
 * com o Chromium rodando. Agora o app fecha antes, e um processo à parte pede
 * a senha, instala, anota o resultado e reabre.
 */
if (process.platform === "linux") {
  const { acharComando, comandoDeInstalacao, instalarPacoteDepois } = await import("../desktop/pacote.js");
  const { mkdtempSync: mk, writeFileSync: escreve, readFileSync: le, existsSync: existe } = await import("node:fs");
  const { spawn: sp } = await import("node:child_process");

  const so = (...nomes) => (n) => (nomes.includes(n) ? `/usr/bin/${n}` : null);
  assert.deepEqual(comandoDeInstalacao({ tipo: "rpm", arquivo: "/c/v.rpm", achar: so("dnf", "rpm") }), ["/usr/bin/dnf", "install", "-y", "--nogpgcheck", "/c/v.rpm"], "Fedora: dnf");
  assert.equal(comandoDeInstalacao({ tipo: "rpm", arquivo: "/c/v.rpm", achar: so("zypper", "rpm") })[0], "/usr/bin/zypper", "openSUSE: zypper");
  assert.deepEqual(comandoDeInstalacao({ tipo: "rpm", arquivo: "/c/v.rpm", achar: so("rpm") }), ["/usr/bin/rpm", "-U", "--replacepkgs", "/c/v.rpm"]);
  assert.deepEqual(comandoDeInstalacao({ tipo: "deb", arquivo: "/c/v.deb", achar: so("apt-get", "dpkg") }), ["/usr/bin/apt-get", "install", "-y", "--allow-downgrades", "/c/v.deb"], "Ubuntu: apt-get resolve dependências");
  assert.deepEqual(comandoDeInstalacao({ tipo: "deb", arquivo: "/c/v.deb", achar: so("dpkg") }), ["/usr/bin/dpkg", "-i", "/c/v.deb"]);
  assert.equal(comandoDeInstalacao({ tipo: "pacman", arquivo: "/c/v", achar: so("pacman") }), null);
  assert.throws(() => instalarPacoteDepois({ tipo: "rpm", arquivo: "/c/v.rpm", exe: "/x", log: "/l", root: false, achar: so("dnf"), spawn: () => ({}) }), /pkexec/, "sem pkexec não fecha o app à toa");
  assert.equal(acharComando("sh"), existe("/usr/bin/sh") ? "/usr/bin/sh" : "/bin/sh");

  const rodar = async ({ codigoSenha }) => {
    const dir = mk(juntar(tmpdir(), "vcall-pacote-"));
    const marca = juntar(dir, "ordem.txt");
    const log = juntar(dir, "vcall.log");
    const falso = (nome, corpo) => {
      escreve(juntar(dir, nome), `#!/bin/sh\n${corpo}\n`, { mode: 0o755 });
      return juntar(dir, nome);
    };
    falso("pkexec", `echo "senha $*" >> ${marca}; [ ${codigoSenha} = 0 ] || exit ${codigoSenha}; exec "$@"`);
    falso("dnf", `echo "dnf $*" >> ${marca}`);
    const exe = falso("vcall", `echo abriu >> ${marca}`);
    const achar = (n) => (["pkexec", "dnf"].includes(n) ? juntar(dir, n) : null);
    const velho = sp("sleep", ["1"]);
    const { comando } = instalarPacoteDepois({ pid: velho.pid, tipo: "rpm", arquivo: "/tmp/Vcall-3.12.0.rpm", exe, log, root: false, achar });
    assert.equal(comando[0], juntar(dir, "pkexec"), "a senha é pedida pelo pkexec");
    await espera(400);
    assert.ok(!existe(marca), "nada roda com o Vcall ainda aberto");
    await new Promise((r) => velho.on("exit", r));
    await espera(1200);
    return { ordem: le(marca, "utf8").trim().split("\n"), log: JSON.parse(le(log, "utf8").trim()) };
  };
  let r = await rodar({ codigoSenha: 0 });
  assert.deepEqual(r.ordem, [`senha ${r.ordem[0].split(" ")[1]} install -y --nogpgcheck /tmp/Vcall-3.12.0.rpm`, "dnf install -y --nogpgcheck /tmp/Vcall-3.12.0.rpm", "abriu"], "depois de sair: senha, instala, reabre");
  assert.equal(r.log.evento, "atualizacao-pacote");
  assert.equal(r.log.codigo, 0, "o resultado fica no registro do app");
  r = await rodar({ codigoSenha: 126 });
  assert.deepEqual(r.ordem.slice(-1), ["abriu"], "senha cancelada: o Vcall abre de novo (na versão antiga)");
  assert.ok(!r.ordem.some((l) => l.startsWith("dnf")), "e nada é instalado");
  assert.equal(r.log.codigo, 126);
  ok(".deb/.rpm: instala depois que o Vcall fecha, com pkexec, anota o resultado e sempre reabre");
}

/* ------------------------------------------------------------------ *
 * Jogos de festa e de tabuleiro: segredo que não vaza, placar que soma
 * uma vez, vez que passa sozinha e o computador que não perde na velha
 * ------------------------------------------------------------------ */
{
  let sementeJ = 11;
  const sorte = () => ((sementeJ = (sementeJ * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  /** Uma mesa de jogo: N estados que se falam fora de ordem e com repetição. */
  function mesa(ids) {
    const nos = ids.map((id) => new EstadoJogos({ eu: id }));
    const fila = [];
    for (const n of nos) n.on("enviar", (lote) => nos.forEach((m) => m !== n && fila.push([m, lote])));
    const entregar = () => {
      while (fila.length) {
        const [m, lote] = fila.splice(Math.floor(sorte() * fila.length), 1)[0];
        m.aplicar(lote);
        if (sorte() < 0.3) m.aplicar(lote);
      }
    };
    const igual = () => {
      const s0 = JSON.stringify([...nos[0].mapa].sort());
      for (const n of nos) assert.equal(JSON.stringify([...n.mapa].sort()), s0, "estados iguais");
    };
    const pessoas = ids.map((id) => ({ id, nome: id[0].toUpperCase() + id.slice(1) }));
    return { nos, entregar, igual, pessoas };
  }
  let relogio = 1_000_000;
  const agora = () => relogio;

  /* Desenha e Adivinha */
  {
    const { nos, entregar, igual, pessoas } = mesa(["ana", "bia", "caio"]);
    const dz = nos.map((n, i) => new Desenho(n, { nome: () => pessoas[i].nome, agora }));
    // eventos efêmeros (traços, palpites) entre todos
    dz.forEach((d, i) => d.on("evento", (ev) => dz.forEach((o, k) => k !== i && o.receber(nos[i].eu, JSON.parse(JSON.stringify(ev))))));
    dz[0].comecar(pessoas);
    entregar();
    const r = dz[1].r;
    assert.equal(r.fase, "escolhendo");
    const desenhista = dz.findIndex((d) => d.eu === r.de);
    const outros = [0, 1, 2].filter((i) => i !== desenhista);
    assert.equal(dz[desenhista].opcoes().length, 3);
    assert.ok(dz[desenhista].escolher("Guarda-chuva", "Objeto"));
    entregar();
    for (const n of nos) assert.ok(!JSON.stringify(n.instantaneo()).toLowerCase().includes("chuva"), "a palavra não sai do computador de quem desenha");
    assert.equal(dz[outros[0]].formaVisivel(), "______-_____");
    // traço
    const t = dz[desenhista].iniciarTraco("#e53935", 10, 100, 100);
    dz[desenhista].estenderTraco(t, 120, 130);
    dz[desenhista].estenderTraco(t, 150, 170);
    dz[desenhista].terminarTraco(t);
    await espera(250);
    assert.deepEqual(dz[outros[1]].tracos.get(t).p, [100, 100, 120, 130, 150, 170], "o traço chega inteiro");
    // alguém de fora tentando desenhar é ignorado
    dz[outros[0]].receber(nos[outros[1]].eu, { tipo: "trc", n: r.n, id: "falso", c: "#e53935", e: 4, p: [1, 2] });
    assert.ok(!dz[outros[0]].tracos.has("falso"), "só quem desenha mexe na tela");
    // palpites
    let quase = 0;
    dz[outros[1]].on("conversa", () => (quase = dz[outros[1]].conversa.filter((c) => c.tipo === "quase").length));
    assert.equal(dz[outros[1]].chutar("guarda chuvo"), "errou");
    assert.equal(quase, 1, "quem desenha avisa: está quase");
    relogio += 20_000;
    assert.equal(dz[outros[0]].chutar("guarda  CHUVA"), "acertou");
    entregar();
    assert.equal(dz[outros[0]].chutar("de novo"), "nada", "quem acertou não chuta mais");
    relogio += 30_000;
    dz[desenhista].manter(pessoas);
    entregar();
    assert.ok(nos.every((n) => n.ler("dz/dica")?.l?.length === 1), "uma letra de dica com metade do tempo");
    assert.equal(dz[outros[1]].chutar("guarda-chuva"), "acertou");
    entregar();
    dz[desenhista].manter(pessoas); // todos acertaram: encerra
    entregar();
    assert.equal(dz[outros[0]].fase(), "revelada");
    assert.equal(nos[outros[0]].ler("dz/fim").palavra, "Guarda-chuva");
    const pts = dz[0].pontosDaVez();
    assert.ok(pts[nos[outros[0]].eu] > pts[nos[outros[1]].eu], "quem acertou antes ganha mais");
    assert.equal(pts[nos[desenhista].eu], 120, "quem desenha ganha por acerto");
    dz[desenhista].manter(pessoas); // começa a contar a pausa da revelação
    relogio += 7000;
    dz[desenhista].manter(pessoas);
    entregar();
    assert.equal(dz[2].r.fase, "escolhendo");
    assert.notEqual(dz[2].r.de, nos[desenhista].eu, "a vez passa");
    assert.equal(nos[1].ler("dz/placar").pts[nos[desenhista].eu], 120);
    // 1 volta = 3 vezes; com 2 voltas, 6
    igual();
  }

  /* Mímica */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia"]);
    const mm = nos.map((n, i) => new Mimica(n, { nome: () => pessoas[i].nome, agora }));
    mm[1].comecar(pessoas);
    entregar();
    const ator = mm.findIndex((m) => m.eu === m.r.de);
    const outro = 1 - ator;
    mm[ator].escolher("tocar violão", "Ação");
    entregar();
    assert.ok(!JSON.stringify(nos[outro].instantaneo()).includes("violão"));
    relogio += 10_000;
    mm[ator].acertou(nos[outro].eu, "B");
    entregar();
    assert.equal(nos[outro].ler("mm/fim").palavra, "tocar violão");
    const p = mm[outro].pontosDaVez();
    assert.ok(p[nos[outro].eu] > 100 && p[nos[ator].eu] === 75);
  }

  /* Stop */
  {
    const { nos, entregar, igual, pessoas } = mesa(["ana", "bia", "caio"]);
    const st = nos.map((n, i) => new StopJogo(n, { nome: () => pessoas[i].nome, agora }));
    st[0].configurar({ cats: ["nome", "animal", "cor"] });
    st[0].novaRodada(pessoas);
    entregar();
    const L = st[2].r.letra;
    assert.ok(/^[A-Z]$/.test(L));
    const resp = [
      { nome: `${L}ucas`, animal: `${L}eão`, cor: `${L}ilás` },
      { nome: `${L}ucas`, animal: `${L}ontra`, cor: "Quase" }, // Q nunca é sorteado
      { nome: `${L}eandro`, animal: `${L}xyz`, cor: "" },
    ];
    resp.forEach((r, i) => Object.entries(r).forEach(([c, v]) => st[i].escrever(c, v)));
    assert.ok(!st[1].podeParar(), "com resposta de outra letra, não dá para gritar STOP");
    assert.ok(st[0].podeParar());
    for (const n of nos) assert.ok(![...n.com("st/a/")].length, "ninguém vê nada antes do STOP");
    st[0].gritarStop();
    entregar();
    entregar();
    assert.equal([...nos[1].com("st/a/")].length, 3, "com o STOP, todos publicam");
    st[0].escrever("cor", "mudou depois");
    // vetos: duas pessoas anulam o animal inventado do Caio
    st[0].vetar("caio", "animal");
    st[1].vetar("caio", "animal");
    entregar();
    const v = st[2].vista(pessoas);
    const por = Object.fromEntries(v.jogadores.map((j) => [j.id, j]));
    assert.equal(por.ana.celulas.nome.pontos, 5, "nome repetido vale 5");
    assert.equal(por.caio.celulas.nome.pontos, 10, "nome único vale 10");
    assert.equal(por.caio.celulas.animal.pontos, 0, "anulado pela maioria vale 0");
    assert.equal(por.bia.celulas.cor.pontos, 0, "outra letra vale 0");
    assert.equal(por.caio.celulas.cor.pontos, 0, "em branco vale 0");
    st[1].novaRodada(pessoas);
    entregar();
    assert.equal(nos[0].ler("st/placar").pts.ana, por.ana.pontos, "o placar soma a rodada anterior");
    assert.notEqual(st[0].r.letra, L, "não repete a letra");
    igual();
  }

  /* Quiz */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia"]);
    const qz = nos.map((n, i) => new Quiz(n, { nome: () => pessoas[i].nome, agora }));
    qz[0].configurar({ qtd: 5, tempo: 20 });
    qz[0].comecar();
    entregar();
    assert.equal(qz[1].vista(pessoas).fase, "preparar");
    relogio += 3000;
    const p = qz[1].pergunta();
    assert.equal(p.opcoes.length, 4);
    relogio += 2000;
    assert.ok(qz[0].responder(p.certa));
    assert.ok(!qz[0].responder((p.certa + 1) % 4), "uma resposta por pergunta");
    relogio += 8000;
    assert.ok(qz[1].responder((p.certa + 1) % 4));
    entregar();
    const vi = qz[1].vista(pessoas);
    assert.equal(vi.fase, "revelada", "todos responderam: revela");
    assert.equal(vi.placar[0].id, "ana");
    assert.equal(vi.placar[0].total, 950, "certo em 2 s de 20: 950");
    assert.equal(vi.placar[1].total, 0);
    qz[0].manter(pessoas);
    relogio += 6500;
    qz[0].manter(pessoas);
    entregar();
    assert.equal(qz[1].passo().k, 1, "o líder passa para a próxima");
  }

  /* Roda */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia", "caio"]);
    const rp = nos.map((n, i) => new Roda(n, { nome: () => pessoas[i].nome, agora }));
    rp[0].proxima("prefere", pessoas);
    entregar();
    rp[0].votar(0);
    rp[1].votar(1);
    entregar();
    for (const n of nos) assert.ok(![...n.com("rp/val/")].length, "voto escondido até revelar");
    rp[2].votar(0);
    entregar();
    rp.forEach((r) => r.manter(pessoas));
    entregar();
    entregar();
    const v = rp[1].vista(pessoas);
    assert.equal(v.fase, "revelada");
    assert.deepEqual(v.lados.map((l) => l.length), [2, 1]);
    rp[1].proxima("quem", pessoas);
    entregar();
    rp[0].votar("bia");
    rp[1].votar("bia");
    rp[2].votar("ana");
    entregar();
    rp[0].revelar();
    entregar();
    entregar();
    assert.deepEqual(rp[2].vista(pessoas).ranking.map((x) => [x.nome, x.n]), [["Bia", 2], ["Ana", 1]]);
  }

  /* Duas verdades */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia", "caio"]);
    const dv = nos.map((n, i) => new DuasVerdades(n, { nome: () => pessoas[i].nome, agora }));
    dv[0].publicar(["Já morei no Japão", "Toco piano", "Tenho 3 gatos"], 2);
    dv[1].publicar(["A", "B", "C"], 0);
    entregar();
    assert.ok(!JSON.stringify(nos[2].instantaneo()).includes('"i":'), "a mentira não está no estado");
    dv[2].proxima(pessoas);
    entregar();
    const vez = dv[2].vez();
    const autor = dv.findIndex((d) => d.eu === vez.de);
    const mentira = dv[autor].minha.i;
    const outros = [0, 1, 2].filter((i) => i !== autor);
    dv[outros[0]].votar(mentira);
    dv[outros[1]].votar((mentira + 1) % 3);
    entregar();
    assert.ok(dv[autor].revelar(pessoas));
    entregar();
    const vi = dv[outros[1]].vista(pessoas);
    assert.equal(vi.mentira, mentira);
    const pl = nos[0].ler("dv/placar").pts;
    assert.equal(pl[nos[outros[0]].eu], 100);
    assert.equal(pl[nos[autor].eu], 50);
  }

  /* Palavras-código */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia", "caio", "duda"]);
    const pc = nos.map((n, i) => new Codigo(n, { nome: () => pessoas[i].nome, agora }));
    pc[0].novoJogo();
    pc[0].sortearTimes(pessoas);
    entregar();
    const j = pc[1].jogo();
    assert.equal(j.palavras.length, 25);
    assert.equal([...j.chave].filter((c) => c === "x").length, 1);
    assert.ok(!JSON.stringify(nos[1].instantaneo()).includes(j.chave), "a chave não fica à vista");
    const vez = pc[0].vez().time;
    const mestre = pc.find((p) => p.meuTime().time === vez && p.meuTime().mestre);
    const agente = pc.find((p) => p.meuTime().time === vez && !p.meuTime().mestre);
    assert.ok(!agente.apontar(0), "sem dica não aponta");
    assert.ok(mestre.darDica("bicho", 2));
    entregar();
    assert.ok(agente.vista(pessoas).cartas.every((c) => c.cor === null), "o agente não vê as cores");
    assert.ok(mestre.vista(pessoas).cartas.every((c) => c.cor), "o mestre vê");
    const minha = [...j.chave].findIndex((c) => c === vez);
    agente.apontar(minha);
    entregar();
    assert.equal(pc[3].vez().time, vez, "acertou: continua");
    const neutra = [...j.chave].findIndex((c) => c === "n");
    agente.apontar(neutra);
    entregar();
    assert.notEqual(pc[3].vez().time, vez, "neutra: passa a vez");
    const outroMestre = pc.find((p) => p.meuTime().time !== vez && p.meuTime().mestre);
    const outroAgente = pc.find((p) => p.meuTime().time !== vez && !p.meuTime().mestre);
    outroMestre.darDica("tudo", 0);
    entregar();
    outroAgente.apontar(j.chave.indexOf("x"));
    entregar();
    const fim = pc[0].vista(pessoas);
    assert.equal(fim.vencedor, vez, "quem acha a bomba perde");
  }

  /* Velha e Lig 4 */
  {
    assert.deepEqual(resultadoVelha("xxx o o  ").vencedor, 1);
    assert.equal(resultadoVelha("xoxxoxoxo").fim, true);
    // o computador nunca perde da velha (200 partidas contra jogadas ao acaso)
    const { nos } = mesa(["ana"]);
    const v = new Velha(nos[0], { agora });
    for (let k = 0; k < 200; k += 1) {
      let t = "         ";
      let vez = k % 2 ? 1 : 2; // às vezes o humano começa
      const bot = 2;
      while (!resultadoVelha(t).fim) {
        const livres = [...t].map((c, i) => (c === " " ? i : -1)).filter((i) => i >= 0);
        const livre = vez === bot ? v.jogadaDoBot(t, bot) : livres[Math.floor(sorte() * livres.length)];
        t = v.aplicar(t, livre, vez).t;
        vez = vez === 1 ? 2 : 1;
      }
      assert.notEqual(resultadoVelha(t).vencedor, 1, `o computador perdeu: ${t}`);
    }
    // duas pessoas
    const m = mesa(["ana", "bia"]);
    const jv = m.nos.map((n, i) => new Velha(n, { nome: () => m.pessoas[i].nome, agora }));
    jv[0].sentar(1);
    m.entregar();
    jv[1].sentar(2);
    m.entregar();
    assert.ok(!jv[1].jogar(4), "não é a vez dela");
    for (const [q, i] of [[0, 0], [1, 4], [0, 1], [1, 5], [0, 2]]) {
      assert.ok(jv[q].jogar(i));
      m.entregar();
    }
    const fim = jv[1].vista(m.pessoas);
    assert.equal(fim.vencedor, 1);
    assert.deepEqual(fim.placar.map((p) => [p.nome, p.vitorias]), [["Ana", 1]]);
    jv[1].revanche();
    m.entregar();
    assert.equal(jv[0].vista(m.pessoas).p1.id, "bia", "revanche troca os lados");
    // Lig 4: a peça cai, quatro na diagonal ganha, e o computador bloqueia
    const lg = new Lig4(nos[0], { agora });
    let t = " ".repeat(42);
    t = lg.aplicar(t, 3, 1).t;
    t = lg.aplicar(t, 3, 2).t;
    assert.equal(t[35 + 3], "x");
    assert.equal(t[28 + 3], "o");
    let bloqueio = " ".repeat(42);
    for (const c of [0, 1, 2]) bloqueio = lg.aplicar(bloqueio, c, 1).t;
    assert.equal(lg.jogadaDoBot(bloqueio, 2), 3, "bloqueia a linha de três");
    let ganha = bloqueio;
    for (const c of [0, 1, 2]) ganha = lg.aplicar(ganha, c, 2).t;
    assert.equal(lg.jogadaDoBot(ganha, 2), 3, "e ganha quando pode (antes de bloquear)");
    let diag = " ".repeat(42);
    for (const [c, q] of [[0, 1], [1, 2], [1, 1], [2, 2], [2, 2], [2, 1], [3, 2], [3, 2], [3, 2], [3, 1]]) diag = lg.aplicar(diag, c, q).t;
    assert.equal(resultadoLig4(diag).vencedor, 1, "diagonal");
  }

  /* Forca */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia"]);
    const fc = nos.map((n, i) => new Forca(n, { nome: () => pessoas[i].nome, agora }));
    assert.ok(fc[0].propor("Pão de Açúcar", "Lugar"));
    entregar();
    assert.ok(!JSON.stringify(nos[1].instantaneo()).includes("Açúcar"));
    assert.ok(!fc[0].chutar("a"), "quem escolheu não joga");
    fc[1].chutar("ã");
    entregar();
    let v = fc[0].vista();
    assert.equal(v.posicoes.filter((p) => p.aberta && p.ch !== " ").length, 3, "o A abre Ã, A e Á");
    for (const l of "PODECUR") fc[1].chutar(l);
    entregar();
    assert.equal(fc[0].vista().fase, "ganhou");
    fc[0].nova();
    entregar();
    for (const l of "KWYZQX") fc[1].chutar(l);
    entregar();
    v = fc[1].vista();
    if (!compacto(fc[1].jogo().palavra).match(/[kwyzqx]/)) assert.equal(v.fase, "perdeu");
  }

  /* Memória */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia"]);
    const mem = nos.map((n, i) => new Memoria(n, { nome: () => pessoas[i].nome, agora, espera: 10 }));
    mem[0].comecar(pessoas, 12);
    entregar();
    const j = mem[0].jogo();
    const daVez = mem.findIndex((m) => m.eu === mem[0].daVez().id);
    const outro = 1 - daVez;
    assert.ok(!mem[outro].virar(0), "fora da vez não vira");
    const a = 0;
    const b = j.cartas.indexOf(j.cartas[0], 1);
    mem[daVez].virar(a);
    entregar();
    mem[daVez].virar(b);
    entregar();
    assert.equal(mem[outro].vista(pessoas).jogadores.find((x) => x.id === nos[daVez].eu).pares, 1);
    assert.equal(mem[outro].daVez().id, nos[daVez].eu, "par: continua a vez");
    const c = j.cartas.findIndex((x, i) => i !== a && i !== b);
    const d = j.cartas.findIndex((x, i) => i !== a && i !== b && x !== j.cartas[c]);
    mem[daVez].virar(c);
    mem[daVez].virar(d);
    entregar();
    assert.equal(mem[outro].vista(pessoas).cartas.filter((x) => x.aberta).length, 2, "errou: as duas aparecem");
    await espera(150);
    entregar();
    assert.equal(mem[outro].daVez().id, nos[outro].eu, "e a vez passa");
  }

  /* Sorteios */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia"]);
    const rl = nos.map((n, i) => new Sorteios(n, { nome: () => pessoas[i].nome, agora }));
    rl[0].girar(pessoas);
    entregar();
    const g = rl[1].vista(pessoas).giro;
    assert.ok(["Ana", "Bia"].includes(g.opcoes[g.alvo]));
    rl[1].rolar(3);
    rl[0].moeda();
    entregar();
    assert.equal(rl[0].vista(pessoas).dados.valores.length, 3);
    relogio += 5000;
    assert.equal(rl[1].vista(pessoas).historico.length, 3);
  }

  /* Quem sou eu */
  {
    const { nos, entregar, pessoas } = mesa(["ana", "bia", "caio"]);
    const qs = nos.map((n, i) => new QuemSouEu(n, { nome: () => pessoas[i].nome, agora }));
    qs[0].sortear(pessoas);
    entregar();
    const v = qs[1].vista(pessoas);
    assert.equal(v.cartas.find((c) => c.eu).quem, null, "a minha carta fica escondida");
    assert.ok(v.cartas.filter((c) => !c.eu).every((c) => c.quem), "as dos outros aparecem");
    qs[0].marcar("bia", "acertou");
    entregar();
    assert.ok(qs[1].vista(pessoas).cartas.find((c) => c.eu).quem, "acertou: a dela aparece para ela");
  }

  // Duas pessoas sentam ao mesmo tempo, cada uma num lado: as duas ficam.
  {
    const m = mesa(["ana", "bia"]);
    const lg = m.nos.map((n, i) => new Lig4(n, { nome: () => m.pessoas[i].nome, agora }));
    lg[0].sentar(1);
    lg[1].sentar(2);
    m.entregar();
    const v = lg[0].vista(m.pessoas);
    assert.deepEqual([v.p1?.id, v.p2?.id], ["ana", "bia"], "lugares em chaves separadas não se apagam");
  }
  ok("jogos de festa e tabuleiro: palavra, resposta e voto só saem na hora; placar, vez e computador certos");
}

/* ------------------------------------------------------------------ *
 * Reações: combo sem inundar a rede, chuva só com várias pessoas, sinais
 * que vencem sozinhos e dado de fora conferido
 * ------------------------------------------------------------------ */
{
  // Combo: 9 cliques em 600 ms viram no máximo 3 mensagens, com a soma certa.
  let t = 0;
  const enviados = [];
  const combo = new Combo((id, n) => enviados.push([id, n]), { janela: 250, agora: () => t });
  const tamanhos = [];
  for (let i = 0; i < 9; i += 1) {
    t = i * 70;
    tamanhos.push(combo.soltar("festa"));
  }
  assert.deepEqual(tamanhos, [1, 2, 3, 4, 5, 6, 7, 8, 9], "o combo cresce na hora, sem esperar a rede");
  await espera(300);
  combo.descarregar();
  assert.ok(enviados.length <= 3, `9 cliques viraram ${enviados.length} mensagens`);
  assert.equal(enviados.reduce((a, [, n]) => a + n, 0), 9, "nenhum clique se perde");
  t = 5000;
  assert.equal(combo.soltar("festa"), 1, "depois de uma pausa, o combo recomeça");
  assert.equal(combo.soltar("amei"), 1, "outra reação recomeça o combo");
  combo.descarregar();

  // Do outro lado, os lotes somam: quem vê também vê o ×9.
  const remoto = new ComboRemoto({ janela: 1500 });
  assert.equal(remoto.somar("ana", "festa", 3, 0), 3);
  assert.equal(remoto.somar("ana", "festa", 4, 250), 7);
  assert.equal(remoto.somar("bia", "festa", 1, 300), 1, "cada pessoa tem o próprio combo");
  assert.equal(remoto.somar("ana", "festa", 2, 500), 9);
  assert.equal(remoto.somar("ana", "festa", 1, 3000), 1, "1,5 s sem nada e o combo zera");

  // Chuva: a mesma reação de 3 pessoas em 4 s; uma pessoa clicando sem parar não basta.
  const chuva = new Chuva({ pessoas: 3, janela: 4000, pausa: 6000 });
  for (let i = 0; i < 20; i += 1) assert.equal(chuva.registrar("palmas", "ana", i * 50), false, "uma pessoa só não faz chover");
  assert.equal(chuva.registrar("palmas", "bia", 1000), false);
  assert.equal(chuva.registrar("palmas", "caio", 2000), true, "a terceira pessoa faz chover");
  assert.equal(chuva.registrar("palmas", "duda", 2500), false, "e não chove de novo logo em seguida");
  assert.equal(chuva.registrar("fogo", "ana", 2600) || chuva.registrar("fogo", "bia", 2700), false);
  assert.equal(chuva.registrar("fogo", "caio", 9000), false, "reações espalhadas por mais de 4 s não contam juntas");

  // Sinais: um por grupo, vencem no prazo de quem recebe, e "Já volto" não vence.
  let agora = 0;
  const sinais = new Sinais({ agora: () => agora });
  const mudancas = [];
  sinais.on("mudou", (m) => mudancas.push(m));
  assert.deepEqual(sinais.alternar("ana", "sim"), ["sim"]);
  assert.deepEqual(sinais.alternar("ana", "nao"), ["nao"], "Não tira o Sim");
  assert.deepEqual(sinais.alternar("ana", "devagar"), ["nao", "devagar"], "grupos diferentes convivem");
  assert.deepEqual(sinais.alternar("ana", "devagar"), ["nao"], "clicar de novo desliga");
  sinais.definir("bia", ["sim", "nao", "javolto", "inventado"]);
  assert.deepEqual(sinais.de("bia"), ["nao", "javolto"], "o que chega pela rede também respeita os grupos");
  sinais.definir("caio", ["nao"]);
  assert.deepEqual(sinais.contagem(), { nao: 3, javolto: 1 });
  assert.deepEqual(sinais.porSinal().nao.sort(), ["ana", "bia", "caio"]);
  agora = 91_000;
  assert.equal(sinais.vencer(), true);
  assert.deepEqual(sinais.de("ana"), [], "o Não some depois de 90 s");
  assert.deepEqual(sinais.de("bia"), ["javolto"], "o Já volto fica até a pessoa tirar");
  assert.ok(mudancas.some((m) => m.pessoa === "caio" && m.ids.length === 0), "quem venceu avisa a tela");
  sinais.esquecer("bia");
  assert.deepEqual(sinais.porSinal(), {}, "quem sai da chamada leva os sinais junto");
  const n = mudancas.length;
  sinais.definir("ana", []);
  assert.equal(mudancas.length, n, "sem mudança, sem repintar");

  // O que chega pelo canal é dado de fora.
  assert.deepEqual(validarReacao({ type: "reacao", r: "festa", n: 3 }), { tipo: "reacao", id: "festa", n: 3 });
  assert.equal(validarReacao({ type: "reacao", r: "festa", n: 1e9 }).n, 20, "lote enorme vira 20");
  assert.equal(validarReacao({ type: "reacao", r: "festa", n: "5" }).n, 1);
  assert.equal(validarReacao({ type: "reacao", r: "<img src=x>" }), null);
  assert.equal(validarReacao({ type: "reacao", r: "__proto__" }), null);
  assert.deepEqual(validarReacao({ type: "sinal", s: ["sim", "sim", "x", 7] }), { tipo: "sinal", ids: ["sim"] });
  assert.deepEqual(validarReacao({ type: "sinal", s: "sim" }), { tipo: "sinal", ids: [] });
  assert.equal(validarReacao(null), null);

  // Catálogo: ids únicos, e todo emoji existe no sprite (senão aparece um buraco).
  const { readFileSync } = await import("node:fs");
  const sprite = readFileSync(new URL("../public/vendor/emoji.svg", import.meta.url), "utf8");
  const ids = [...REACOES, ...SINAIS].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "ids repetidos");
  for (const x of REACOES) assert.ok(sprite.includes(`id="e-${x.emoji}"`), `falta o emoji ${x.emoji} no sprite`);
  // Fora das reações, nada de emoji: sinais, jogos e cartas usam os ícones do app.
  const icones = readFileSync(new URL("../public/vendor/icons.svg", import.meta.url), "utf8");
  const { JOGOS } = await import("../public/js/features/jogos.js");
  const { CARTAS_MEMORIA } = await import("../public/js/features/bancos.js");
  const nomes = [...SINAIS.map((x) => x.icone), ...Object.values(JOGOS).map((j) => j.icone), ...CARTAS_MEMORIA, "thumbs-up", "heart", "party-popper", "laugh", "coffee", "flame"];
  for (const n of nomes) assert.ok(icones.includes(`id="i-${n}"`), `falta o ícone ${n} no sprite`);
  assert.ok(CARTAS_MEMORIA.length >= 15, "pares suficientes para o tabuleiro difícil");
  for (const novo of Object.values(DO_ANTIGO)) assert.ok(REACOES.some((r) => r.id === novo), "reação antiga sem par novo");
  ok("reações: combo em poucas mensagens e igual dos dois lados, chuva só com 3 pessoas, sinais que vencem, dado de fora conferido");
}

/*
 * Servidor TURN pelas configurações do app de mesa. No app instalado não há
 * .env para editar: sem isto, quem estava no 4G ou na rede da empresa não
 * tinha como ganhar um TURN. A senha nunca volta para a página.
 */
{
  const { definirTurnLocal, iceConfiguration, normalizarTurnLocal } = await import("../src/ice.js");
  const { lerTurn, salvarTurn, visaoDoTurn } = await import("../desktop/turn.js");
  const { readFileSync, statSync } = await import("node:fs");
  const arquivo = juntar(mkdtempSync(juntar(tmpdir(), "vcall-turn-")), "turn.json");

  assert.equal(normalizarTurnLocal({ tipo: "api", url: "http://inseguro.exemplo/x" }), null, "link de provedor só em https");
  assert.equal(normalizarTurnLocal({ tipo: "segredo", urls: "https://nao-e-turn", segredo: "s" }), null, "endereço tem de ser turn:/turns:");
  assert.equal(normalizarTurnLocal({ tipo: "fixo", urls: "turn:a.exemplo:3478", usuario: "u" }), null, "sem senha não vale");
  assert.deepEqual(
    normalizarTurnLocal({ tipo: "segredo", urls: "turn:a.exemplo:3478, turns:a.exemplo:5349?transport=tcp  javascript:x", segredo: " s3 " }),
    { tipo: "segredo", urls: ["turn:a.exemplo:3478", "turns:a.exemplo:5349?transport=tcp"], segredo: "s3" },
    "lista separada por vírgula, lixo fora",
  );

  // Coturn próprio: as credenciais saem por HMAC, com validade, e o segredo não vai junto.
  let r = salvarTurn(arquivo, { tipo: "segredo", urls: "turn:a.exemplo:3478", segredo: "segredo-de-teste" });
  assert.ok(r.ok, r.erro);
  assert.deepEqual(r.turn, { tipo: "segredo", urls: ["turn:a.exemplo:3478"], usuario: "", temSegredo: true }, "a página só fica sabendo que há um segredo");
  assert.ok(!JSON.stringify(visaoDoTurn(lerTurn(arquivo))).includes("segredo-de-teste"), "o segredo nunca volta para a página");
  if (process.platform !== "win32") assert.equal(statSync(arquivo).mode & 0o077, 0, "turn.json só legível pelo dono");
  let ice = await iceConfiguration();
  const turn = ice.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith("turn")));
  assert.ok(ice.hasTurn && turn, "o /ice passa a ter TURN");
  assert.match(turn.username, /^\d+:vcall$/, "usuário é a validade");
  const { createHmac } = await import("node:crypto");
  assert.equal(turn.credential, createHmac("sha1", "segredo-de-teste").update(turn.username).digest("base64"), "senha é o HMAC do coturn");
  assert.equal(ice.turnMode, "app:segredo");

  // Salvar de novo com o campo secreto vazio mantém o segredo; trocar de tipo pede o novo.
  r = salvarTurn(arquivo, { tipo: "segredo", urls: "turns:b.exemplo:5349", segredo: "" });
  assert.ok(r.ok && lerTurn(arquivo).segredo === "segredo-de-teste", "campo vazio mantém o segredo salvo");
  assert.ok(salvarTurn(arquivo, { tipo: "fixo", urls: "turn:b.exemplo:3478", usuario: "ana", senha: "" }).erro, "outro tipo sem senha é recusado");
  assert.equal(lerTurn(arquivo).tipo, "segredo", "e o que estava salvo continua");

  // Desligar volta ao que estiver no ambiente (aqui: só STUN).
  r = salvarTurn(arquivo, { tipo: "nenhum" });
  assert.deepEqual(r.turn, { tipo: "nenhum" });
  assert.equal(JSON.parse(readFileSync(arquivo, "utf8")).tipo, "nenhum");
  ice = await iceConfiguration();
  assert.equal(ice.hasTurn, false, "desligado, o /ice volta a não ter TURN");
  definirTurnLocal(null);
  ok("TURN nas configurações do app: validado, salvo só para o dono, segredo que não volta à página, HMAC igual ao do coturn");
}

/* ------------------------------------------------------------------ *
 * 3.17: o controle adaptativo da tela.
 *
 *   - O Chrome diz "bandwidth" também quando o encoder encolhe a imagem por
 *     QP alto. O controle lia isso como rede cheia e cortava o teto 25% a
 *     cada 2 s, até o piso: um jogo compartilhado ia a 7 qps e 500 kbps com
 *     20 Mbps sobrando.
 *   - Encoder de hardware que não dá conta não diz nada (motivo "none"): a
 *     fonte manda 60 qps e saem 20. O teto de quadros tem de descer.
 * ------------------------------------------------------------------ */
{
  const { StatsMonitor } = await import("../public/js/core/stats.js");
  const { PROFILES } = await import("../public/js/core/tuning.js");

  /** Um par falso com a linha de tela ligada; `tela` diz o que o getStats conta. */
  function parFalso(tela, perfil = PROFILES.screenMotion) {
    const enc = { maxBitrate: perfil.maxBitrate, maxFramerate: 60 };
    let ajustes = 0;
    const sender = {
      track: { readyState: "live", id: "t", getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }) },
      getParameters: () => ({ encodings: [{ ...enc }] }),
    };
    let t = 0;
    return {
      enc,
      get ajustes() {
        return ajustes;
      },
      id: "b",
      connectionState: "connected",
      screenProfile: perfil,
      tx: { screen: { mid: "2", sender }, cam: { mid: "1", sender: { track: null } } },
      async getStats() {
        t += 2000;
        return new Map([
          ["OT", { id: "OT", type: "outbound-rtp", kind: "video", mid: "2", timestamp: t, bytesSent: t * 1000, mediaSourceId: "SV", framesPerSecond: tela.fps, frameWidth: tela.w, frameHeight: tela.h, qualityLimitationReason: tela.motivo, qualityLimitationDurations: { [tela.motivo]: t / 1000 }, targetBitrate: tela.alvo ?? 3_000_000, remoteId: "RI", powerEfficientEncoder: tela.hw }],
          ["RI", { id: "RI", type: "remote-inbound-rtp", kind: "video", fractionLost: tela.perda ?? 0 }],
          ["SV", { id: "SV", type: "media-source", kind: "video", framesPerSecond: tela.fonte ?? 60, height: tela.alturaFonte ?? 1080 }],
          ...(tela.parEmUso
            ? [
                ["T", { id: "T", type: "transport", selectedCandidatePairId: "CP2" }],
                ["CP2", { id: "CP2", type: "candidate-pair", nominated: false, state: "succeeded", availableOutgoingBitrate: 7_000_000, currentRoundTripTime: 0.05 }],
              ]
            : []),
          ["CP", { id: "CP", type: "candidate-pair", nominated: true, state: "succeeded", availableOutgoingBitrate: 20_000_000, currentRoundTripTime: 0.01 }],
        ]);
      },
      // Como o peer.js: o perfil é o teto.
      async setScreenBudget(b) {
        ajustes++;
        enc.maxBitrate = Math.min(b.maxBitrate, b.profile.maxBitrate);
        enc.maxFramerate = Math.min(b.maxFramerate, b.profile.maxFramerateComBanda ?? b.profile.maxFramerate);
        enc.scaleResolutionDownBy = b.scaleResolutionDownBy;
      },
      async setCameraBudget() {},
      async reconfigurarEncoder() {
        return false;
      },
    };
  }
  /** Roda `voltas` ciclos do monitor sem esperar os 2 s de cada um. */
  async function rodar(peer, voltas) {
    const original = globalThis.setInterval;
    let ciclo = null;
    globalThis.setInterval = (fn) => ((ciclo = fn), 1);
    const m = new StatsMonitor(() => [peer]);
    m.start();
    globalThis.setInterval = original;
    for (let i = 0; i < voltas; i++) await ciclo();
    return m;
  }

  const jogo = parFalso({ fps: 58, w: 960, h: 540, motivo: "bandwidth" });
  await rodar(jogo, 6);
  assert.equal(jogo.enc.maxBitrate, PROFILES.screenMotion.maxBitrate, `"bandwidth" do encoder com a rede sobrando derrubou o teto para ${jogo.enc.maxBitrate}`);

  const atrasado = parFalso({ fps: 20, w: 1920, h: 1080, motivo: "none" });
  await rodar(atrasado, 1);
  assert.ok(atrasado.enc.maxFramerate < 60 && atrasado.enc.maxFramerate >= 30, `encoder que não acompanha a fonte: teto foi a ${atrasado.enc.maxFramerate}`);

  // Monitor de 120 Hz, uma pessoa do outro lado: vídeo vai a 120 com banda para
  // isso, fica em 60 enquanto a conexão ainda sobe, e texto fica em 60 sem o
  // controle reaplicar o teto a cada volta.
  const jogo120 = parFalso({ fps: 118, fonte: 120, w: 1920, h: 1080, motivo: "none", alvo: 12_000_000 });
  await rodar(jogo120, 3);
  assert.equal(jogo120.enc.maxFramerate, 120, `vídeo a dois num monitor de 120 Hz: teto ${jogo120.enc.maxFramerate}`);
  const comeco = parFalso({ fps: 60, fonte: 120, w: 1920, h: 1080, motivo: "none", alvo: 4_000_000 });
  await rodar(comeco, 3);
  assert.equal(comeco.enc.maxFramerate, 60, `com 4 Mbps, 1080p120 congela: teto ${comeco.enc.maxFramerate}`);
  const texto120 = parFalso({ fps: 60, fonte: 120, w: 1920, h: 1080, motivo: "none", alvo: 12_000_000 }, PROFILES.screenText);
  await rodar(texto120, 4);
  assert.equal(texto120.enc.maxFramerate, 60, `texto: teto ${texto120.enc.maxFramerate}`);
  assert.ok(texto120.ajustes <= 1, `texto: o teto foi reaplicado ${texto120.ajustes} vezes em 4 voltas`);
  ok("tela: o teto não cai quando o próprio encoder encolhe a imagem, desce um degrau quando ele não acompanha a captura, e vai a 120 qps só no vídeo");

  // 3.17.1 (o bloco seguinte conta a história).
  const pelaInternet = parFalso({ fps: 60, w: 1920, h: 1080, motivo: "bandwidth", alvo: 2_000_000, perda: 0.04, parEmUso: true });
  const monitor = await rodar(pelaInternet, 6);
  assert.equal(monitor.samples.get("b").transport.availableOutgoing, 7_000_000, "a banda disponível vem do par que o transporte usa");
  assert.equal(pelaInternet.enc.maxBitrate, PROFILES.screenMotion.maxBitrate, `4% de perda a dois derrubou o teto para ${pelaInternet.enc.maxBitrate}`);
  assert.equal(pelaInternet.enc.scaleResolutionDownBy, 2, `jogo com 2 Mbps: escala ${pelaInternet.enc.scaleResolutionDownBy}`);
  const textoApertado = parFalso({ fps: 60, w: 1920, h: 1080, motivo: "bandwidth", alvo: 2_000_000 }, PROFILES.screenText);
  await rodar(textoApertado, 2);
  assert.equal(textoApertado.enc.scaleResolutionDownBy, 1, "texto nunca encolhe pela banda: a letra tem de continuar legível");
  ok("tela pela internet: banda lida do par em uso, perda pequena não derruba o teto e o jogo encolhe com a banda");

  // 3.17.2: sem encoder de hardware, vídeo em 1080p não passa de ~40 qps na CPU.
  const semPlaca = parFalso({ fps: 40, w: 1920, h: 1080, motivo: "none", alvo: 12_000_000, hw: false });
  await rodar(semPlaca, 2);
  assert.equal(semPlaca.enc.scaleResolutionDownBy, 1.5, `encoder por software na Fluidez: escala ${semPlaca.enc.scaleResolutionDownBy} (1080p tem de virar 720p)`);
  const comPlaca = parFalso({ fps: 60, w: 1920, h: 1080, motivo: "none", alvo: 12_000_000, hw: true });
  await rodar(comPlaca, 2);
  assert.equal(comPlaca.enc.scaleResolutionDownBy, 1, "com hardware, a imagem fica cheia");
  const janela720 = parFalso({ fps: 45, w: 1280, h: 720, motivo: "none", alvo: 12_000_000, hw: false, alturaFonte: 720 });
  await rodar(janela720, 2);
  assert.equal(janela720.enc.scaleResolutionDownBy, 1, "janela de 720p não encolhe de novo");
  // A Fluidez captura no tamanho da janela (screen.js): o teto da qualidade fica no encoder.
  const janela4k = parFalso({ fps: 60, w: 3840, h: 2160, motivo: "none", alvo: 12_000_000, hw: true, alturaFonte: 2160 }, { ...PROFILES.screenMotion, alturaMax: 1080 });
  await rodar(janela4k, 2);
  assert.equal(janela4k.enc.scaleResolutionDownBy, 2, `janela 4K com placa: escala ${janela4k.enc.scaleResolutionDownBy} (tem de sair em 1080p)`);
  const leve = parFalso({ fps: 60, w: 1920, h: 1080, motivo: "none", alvo: 12_000_000, hw: true }, { ...PROFILES.screenMotion, alturaMax: 720 });
  await rodar(leve, 2);
  assert.equal(leve.enc.scaleResolutionDownBy, 1.5, `qualidade de 720p com placa: escala ${leve.enc.scaleResolutionDownBy}`);
  const textoSemPlaca = parFalso({ fps: 30, w: 1920, h: 1080, motivo: "none", alvo: 6_000_000, hw: false }, PROFILES.screenText);
  await rodar(textoSemPlaca, 2);
  assert.equal(textoSemPlaca.enc.scaleResolutionDownBy, 1, "texto não perde resolução por causa do encoder");
  ok("tela sem encoder de hardware: vídeo e jogo vão em 720p, texto continua cheio");
}

/* ------------------------------------------------------------------ *
 * 3.17.1: a tela travando pela internet.
 *
 * Medido com 6 Mbps de subida, 50 ms e 1% de perda: o jogo chegava a 14–50
 * qps, congelado metade do tempo.
 *   - A banda e os bytes recebidos vinham de um par `nominated` antigo, não
 *     do par em uso: com os bytes dele parados, o vigia de conexão congelada
 *     reiniciava a conexão a cada ~10 s.
 *   - A maior perda entre as quatro linhas (1 pacote em 20 da câmera = 5%)
 *     cortava a tela 25% a cada 2 s, até o piso.
 *   - Com pouca banda, a imagem cheia fazia o encoder jogar quadros fora.
 * ------------------------------------------------------------------ */
{
  const { escalaPelaBanda } = await import("../public/js/core/tuning.js");
  const px = 1920 * 1080;
  assert.equal(escalaPelaBanda(10_000_000, px, 60), 1, "com banda, a imagem cheia");
  assert.equal(escalaPelaBanda(2_000_000, px, 60), 2, "2 Mbps a 60 qps: 960×540");
  assert.equal(escalaPelaBanda(800_000, px, 60), 3, "pouca banda: o menor degrau");
  assert.equal(escalaPelaBanda(4_500_000, px, 60, 2), 1.5, "a banda subiu: cresce");
  assert.equal(escalaPelaBanda(6_000_000, px, 60, 1.5), 1.5, "sem 30% de folga, não cresce (6 Mbps cabe em 1,25 por pouco)");
  assert.equal(escalaPelaBanda(3_000_000, px, 60, 1), 2, "a banda caiu: encolhe na hora");
  assert.equal(escalaPelaBanda(0, px, 60, 1.5), 1.5, "sem medida, fica como está");
  ok("tela: vídeo e jogo encolhem com a banda em vez de perder quadros, e crescem só com folga");
}

/* ------------------------------------------------------------------ *
 * 3.17.2: janela de vídeo escolhida no seletor vai na Fluidez.
 *
 * O padrão do seletor é Nitidez (texto). Um vídeo do YouTube compartilhado
 * assim saía aos trancos: o encoder guarda a letra nítida e descarta quadros.
 * ------------------------------------------------------------------ */
{
  const { pareceVideo } = await import("../public/js/ui/sharesheet.js");
  for (const nome of [
    "(1643) Advance 2.0 Suit - Marvel’s Spider-Man 2 PS5 Pro Free Roam Gameplay (4K60FPS Pro Performance) - YouTube - Brave",
    "Twitch - Google Chrome",
    "Netflix",
    "VLC media player",
  ])
    assert.ok(pareceVideo(nome), `vídeo não reconhecido: ${nome}`);
  for (const nome of ["Documento1 - Word", "Planilha - Excel", "README.md - Visual Studio Code", "Slides - PowerPoint", "Explorador de Arquivos"])
    assert.ok(!pareceVideo(nome), `não é vídeo: ${nome}`);
  ok("seletor: janela de vídeo (YouTube, Twitch, players) escolhe a Fluidez sozinha");
}

/* ------------------------------------------------------------------ *
 * 3.17.4: o vigia reiniciava a conexão a cada ~10 s (a 10 Mbps, ~metade
 * das rodadas). O par de `selectedCandidatePairId` ficava em 0 byte e o
 * tráfego era contado noutro par (candidato peer-reflexive).
 * ------------------------------------------------------------------ */
{
  const { bytesRecebidos } = await import("../public/js/core/stats.js");
  const rel = (n) =>
    new Map([
      ["T", { id: "T", type: "transport", selectedCandidatePairId: "CP0", bytesReceived: 5000 + n }],
      ["CP0", { id: "CP0", type: "candidate-pair", state: "succeeded", bytesReceived: 0 }],
      ["CP1", { id: "CP1", type: "candidate-pair", state: "in-progress", bytesReceived: n }],
    ]);
  assert.notEqual(bytesRecebidos(rel(100)), bytesRecebidos(rel(900)), "o tráfego no outro par tem de contar");
  assert.equal(bytesRecebidos(rel(100)), 5100, "o transporte conta tudo");
  const semTransporte = new Map([...rel(700)].filter(([k]) => k !== "T"));
  assert.equal(bytesRecebidos(semTransporte), 700, "Firefox (sem transporte): soma dos pares");
  assert.equal(bytesRecebidos(new Map()), null, "sem nada, sem medida");
  ok("vigia de conexão congelada: conta os bytes do transporte inteiro, não de um par");
}

/* ------------------------------------------------------------------ *
 * 3.17.4: cada troca de escala reinicia o encoder (quadro-chave). Encolher
 * é na hora; crescer só depois de folga seguida.
 * ------------------------------------------------------------------ */
{
  const { escalaComCalma, SUBIR_ESCALA_MS } = await import("../public/js/core/tuning.js");
  const est = {};
  assert.equal(escalaComCalma(3, 2, est, 0), 3, "a banda caiu: encolhe na hora");
  assert.equal(escalaComCalma(2, 3, est, 1000), 3, "folga recém-aberta: espera");
  assert.equal(escalaComCalma(2, 3, est, 1000 + SUBIR_ESCALA_MS - 1), 3, "ainda não completou o tempo");
  assert.equal(escalaComCalma(2, 3, est, 1000 + SUBIR_ESCALA_MS), 2, "folga estável: cresce");
  assert.equal(escalaComCalma(1.5, 2, est, 50_000), 2);
  assert.equal(escalaComCalma(2, 2, est, 55_000), 2, "a folga sumiu no meio");
  assert.equal(escalaComCalma(1.5, 2, est, 60_000), 2, "a contagem recomeça do zero");
  assert.ok(SUBIR_ESCALA_MS >= 15_000 && SUBIR_ESCALA_MS <= 20_000);
  ok("tela: a resolução sobe só com folga estável (15–20 s) e desce na hora");
}

/* ------------------------------------------------------------------ *
 * 3.17.4: tela parada. O relé repetia o último quadro com a hora de captura
 * antiga, e o encoder descartava todas as cópias (medido com captura de aba
 * de verdade: 0 quadros codificados em 12 s; com a cópia feita dos pixels,
 * 1 por segundo). O teste do navegador usa um canvas, que não tem essa hora.
 * ------------------------------------------------------------------ */
{
  const w = (await import("node:fs")).readFileSync(new URL("../public/js/core/quadros-worker.js", import.meta.url), "utf8");
  assert.ok(!/new VideoFrame\(ultimo\b/.test(w), "a repetição não pode copiar o VideoFrame (leva a hora de captura antiga)");
  assert.ok(/createImageBitmap\(ultimo\)[\s\S]{0,200}new VideoFrame\(bitmap, \{ timestamp: agora\(\) \}\)[\s\S]{0,80}bitmap\.close\(\)/.test(w), "repete a partir dos pixels e fecha o bitmap");
  ok("tela parada: o quadro repetido nasce dos pixels e o encoder não o descarta");
}

/* ------------------------------------------------------------------ *
 * 3.17.4: o som da tela era arrastado pela imagem. No mesmo stream, a
 * sincronia do Chromium segurava o som até 2–2,7 s quando a imagem
 * engasgava, e soltava a 80 ms por segundo. Agora o som vai noutro stream
 * e a sincronia é nossa, com teto.
 * ------------------------------------------------------------------ */
{
  const { alvoDoSom, SINCRONIA_MAX_MS } = await import("../public/js/core/tuning.js");
  assert.equal(alvoDoSom({ videoMs: 120, alvo: 0 }), 120, "o som espera o mesmo que a imagem");
  assert.equal(alvoDoSom({ videoMs: 125, alvo: 120 }), 120, "mudança < 30 ms: fica");
  assert.equal(alvoDoSom({ videoMs: 130, alvo: 120 }), 120, "não acumula leitura a leitura");
  assert.equal(alvoDoSom({ videoMs: 380, alvo: 0 }), SINCRONIA_MAX_MS, "nunca segura mais que o teto");
  assert.equal(alvoDoSom({ videoMs: 1500, alvo: 250 }), 0, "imagem engasgada: o som segue sozinho");
  assert.equal(alvoDoSom({ videoMs: 100, alvo: 250, videoParado: true }), 0, "imagem parada: solta o som");
  assert.equal(alvoDoSom({ videoMs: 60, alvo: 120 }), 60, "a imagem adiantou: o som solta");
  assert.ok(SINCRONIA_MAX_MS <= 300);

  const fs = await import("node:fs");
  const peer = fs.readFileSync(new URL("../public/js/core/peer.js", import.meta.url), "utf8");
  assert.ok(!/screenAudio"\) (init\.streams|t\.sender\.setStreams)/.test(peer) && !/role === "screenAudio"\) (init\.streams|t\.sender\.setStreams)/.test(peer), "o som da tela não pode ir no stream da imagem");
  assert.ok(/role === "screen"\) init\.streams = \[this\.#telaStream\]/.test(peer));

  // A congestão passou: o teto volta inteiro em vez de subir 15% por leitura.
  const stats = fs.readFileSync(new URL("../public/js/core/stats.js", import.meta.url), "utf8");
  assert.ok(!/budget\.screen \* 1\.15/.test(stats), "sem a recuperação de 15% por leitura");
  assert.ok(/FLOOR = \{ screen: 600_000/.test(stats), "piso da tela em 600 kbps");
  ok("som da tela: stream próprio e sincronia com teto de 250 ms; banda volta inteira após a congestão");
}

/* ------------------------------------------------------------------ *
 * 3.17.4: indicador de sincronia (som da tela − imagem da tela).
 * ------------------------------------------------------------------ */
{
  const { avSync } = await import("../public/js/core/stats.js");
  assert.equal(avSync({ screen: { playoutMs: 1000 }, screenAudio: { playoutMs: 1070.4 } }), 70, "som 70 ms atrás da imagem");
  assert.equal(avSync({ screen: { playoutMs: 1000 }, screenAudio: { playoutMs: null } }), null, "sem sincronia, sem número");
  assert.equal(avSync({ screen: null, screenAudio: null }), null);
  ok("estatísticas: avSyncMs = playout do som da tela − o da imagem");
}

/* -- SFU no navegador (fases 2 e 3): quando entra, camadas, chave e troca sem buraco -- */
{
  const { usarSfu, escalasDasCamadas, chaveValida, SFU_MIN_PESSOAS } = await import("../public/js/core/sfu.js");
  const { readFileSync } = await import("node:fs");

  // Só quem transmite numa sala de 3 ou mais; a dois, a malha é direta e mais rápida.
  assert.equal(SFU_MIN_PESSOAS, 3);
  assert.equal(usarSfu({ transmitindo: true, pessoas: 2 }), false);
  assert.equal(usarSfu({ transmitindo: true, pessoas: 3 }), true);
  assert.equal(usarSfu({ transmitindo: false, pessoas: 16 }), false);
  assert.equal(usarSfu({ transmitindo: true, pessoas: 16, negado: true }), false, "sem SFU para mim: malha");

  // Captura de 1440p: camada de cima em 1080p, de baixo em 360p; nunca amplia.
  assert.deepEqual(escalasDasCamadas(1440), [4, 1440 / 1080]);
  assert.deepEqual(escalasDasCamadas(720), [2, 1]);

  // A chave chega de outra pessoa: só base64 curto.
  assert.ok(chaveValida(btoa("x".repeat(32))));
  assert.ok(!chaveValida("<script>"));
  assert.ok(!chaveValida(123));

  const sfu = readFileSync(new URL("../public/js/core/sfu.js", import.meta.url), "utf8");
  const mesh = readFileSync(new URL("../public/js/core/mesh.js", import.meta.url), "utf8");
  const rele = readFileSync(new URL("../public/js/core/rele.js", import.meta.url), "utf8");
  // Cifra ponta a ponta ligada antes de conectar; chave nova a cada transmissão.
  assert.match(sfu, /setE2EEEnabled\(true\);\s*const ws = /);
  assert.match(sfu, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  // Quem assiste só confirma (e a origem só desliga a direta) com a imagem chegando.
  assert.match(sfu, /papeis\.includes\("screen"\) \? papeis : \[\]/);
  // A interface só troca para o SFU com quadros (ou sem a direta).
  assert.match(mesh, /peloSfu = !!sfu\?\.stream && \(sfu\.live \|\| !direta\?\.live\)/);
  // O relé não religa a direta de quem já recebe pelo SFU.
  assert.match(rele, /mesh\.sfu\?\.papeisPara\(y\)/);
  ok("SFU no navegador: entra em sala de 3+, cifra ponta a ponta e troca sem deixar ninguém sem imagem");
}

console.log(`\n${passou} blocos de verificação passaram.`);
process.exit(0);

/* ------------------------------------------------------------------ */

function zipSimples(arquivos) {
  const locais = [];
  const centrais = [];
  let offset = 0;
  for (const [nome, dados] of arquivos) {
    const n = Buffer.from(nome);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(dados.length, 18);
    h.writeUInt32LE(dados.length, 22);
    h.writeUInt16LE(n.length, 26);
    locais.push(h, n, dados);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(dados.length, 20);
    c.writeUInt32LE(dados.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrais.push(c, n);
    offset += 30 + n.length + dados.length;
  }
  const dir = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(dir.length, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, dir, fim]);
}

/**
 * Um ONNX mínimo com a forma do encoder do Whisper: y = Add(x, embed_positions.weight),
 * posições [1500, 2] com valores i (linha i), e uma saída "encoder_attentions.0"
 * que o adaptador deve remover. Protobuf escrito à mão.
 */
function encoderDeBrinquedo() {
  const v = (n) => {
    const o = [];
    let x = BigInt(n);
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      o.push(b);
    } while (x);
    return Buffer.from(o);
  };
  const b = (num, c) => Buffer.concat([v((num << 3) | 2), v(c.length), c]);
  const t = (num, s) => b(num, Buffer.from(s));
  const i = (num, n) => Buffer.concat([v(num << 3), v(n)]);
  const tipo = (dims) =>
    b(2, b(1, Buffer.concat([i(1, 1), b(2, Buffer.concat(dims.map((d) => b(1, typeof d === "number" ? i(1, d) : t(2, d)))))])));
  const valor = (nome, dims) => Buffer.concat([t(1, nome), tipo(dims)]);
  const pesos = Buffer.alloc(1500 * 2 * 4);
  for (let k = 0; k < 1500; k += 1) {
    pesos.writeFloatLE(k, k * 8);
    pesos.writeFloatLE(k, k * 8 + 4);
  }
  const grafo = Buffer.concat([
    b(1, Buffer.concat([t(1, "x"), t(1, "embed_positions.weight"), t(2, "y"), t(3, "/Add_2"), t(4, "Add")])),
    b(1, Buffer.concat([t(1, "y"), t(2, "encoder_attentions.0"), t(3, "/Id"), t(4, "Identity")])),
    t(2, "brinquedo"),
    b(5, Buffer.concat([i(1, 1500), i(1, 2), i(2, 1), t(8, "embed_positions.weight"), b(9, pesos)])),
    b(11, valor("x", [1, "T", 2])),
    b(12, valor("y", [1, "T", 2])),
    b(12, valor("encoder_attentions.0", [1, "T", 2])),
  ]);
  return Buffer.concat([i(1, 7), b(8, Buffer.concat([t(1, ""), i(2, 11)])), b(7, grafo)]);
}

function lerNomesTar(tar) {
  const nomes = [];
  for (let p = 0; p + 512 <= tar.length; ) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const base = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const prefixo = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    nomes.push(prefixo ? `${prefixo}/${base}` : base);
    const tam = parseInt(h.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    p += 512 + Math.ceil(tam / 512) * 512;
  }
  return nomes;
}
