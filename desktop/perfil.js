/**
 * desktop/perfil.js — o perfil de navegador do aplicativo.
 *
 * Existe para resolver uma coisa só: a janela cinza do navegador pedindo
 * microfone toda vez que alguém abre o Vcall.
 *
 * Nenhuma página consegue se autoconceder câmera ou microfone — e ainda bem,
 * senão qualquer site faria isso. Mas quem ABRE o navegador pode preparar o
 * terreno: a permissão por site fica gravada num arquivo de preferências do
 * próprio Chromium, e este módulo escreve ali que `http://127.0.0.1:PORTA`
 * está liberado, antes de o navegador subir. Quando a página pede a câmera,
 * a resposta já está dada e nenhuma janela aparece.
 *
 * Duas consequências que vale entender:
 *
 * 1. EXIGE UM PERFIL PRÓPRIO. Não dá para mexer no perfil pessoal de quem usa
 *    o computador — seria alterar as preferências do navegador dele por fora,
 *    o que é invasivo e, de quebra, o Chromium desfaz ao perceber. O Vcall
 *    passa a ter a própria pasta de perfil, isolada.
 *
 * 2. A LIBERAÇÃO É ESTREITA. Vale para UM endereço — o servidor local do
 *    próprio Vcall — e dentro de um perfil que só o Vcall usa. Nenhum outro
 *    site, nem no perfil pessoal, ganha nada com isso.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TRIALS_WEBRTC } from "./webrtc.js";

/**
 * A pasta de perfil do Vcall, separada da do navegador pessoal.
 *
 * NÃO é constante de propósito. No Ubuntu o navegador é um Snap, e o
 * confinamento do Snap recusa pasta oculta dentro da pasta pessoal — era
 * exatamente isto que impedia o aplicativo de abrir lá. Quando o navegador
 * escolhido é confinado, `usarPerfil()` move o perfil para dentro da área
 * dele, que é a única que ele consegue escrever. Ver desktop/navegador.js.
 */
export let PASTA_PERFIL = path.join(os.homedir(), ".vcall", "navegador");

/** Aponta o perfil para outra pasta, antes de qualquer gravação. */
export function usarPerfil(pasta) {
  if (pasta) PASTA_PERFIL = pasta;
  return PASTA_PERFIL;
}

/**
 * Carimbo de tempo do Chromium: microssegundos desde 1601.
 *
 * É o formato que ele usa em `last_modified`. Com um valor fora de formato,
 * ele descarta a entrada inteira em silêncio — e a permissão não vale.
 */
function agoraChromium() {
  const EPOCH_1601_ATE_1970 = 11644473600000;
  return String((Date.now() + EPOCH_1601_ATE_1970) * 1000);
}

/**
 * Grava as permissões do Vcall no perfil.
 *
 * `setting: 1` é permitir, `2` é bloquear — é a numeração interna do Chromium.
 * A chave do site tem o formato `origem,*`, que é como ele identifica uma
 * exceção por origem.
 *
 * O arquivo é lido e reescrito, nunca substituído: ele guarda também o estado
 * da janela, o zoom e outras coisas do perfil, e jogar tudo fora faria o
 * navegador reabrir do zero a cada execução.
 */
export async function liberarPermissoes(porta, opcoes = {}) {
  return liberarPermissoesDaOrigem(`http://127.0.0.1:${porta}`, opcoes);
}

/**
 * O mesmo, para uma origem qualquer.
 *
 * Usado ao entrar na sala de outra pessoa por um link `vcall://`: a janela vai
 * para o servidor dela, que é outra origem, e sem esta liberação o convite de
 * um amigo voltaria a mostrar exatamente a janela do navegador que este
 * módulo existe para evitar.
 *
 * Quem chama valida a origem antes (ver desktop/protocol.js): só entram
 * endereços https ou da rede local, com sala de verdade.
 */
export async function liberarPermissoesDaOrigem(origemBase, { camera = true, microfone = true } = {}) {
  const dir = path.join(PASTA_PERFIL, "Default");
  const arquivo = path.join(dir, "Preferences");

  let prefs = {};
  try {
    prefs = JSON.parse(await readFile(arquivo, "utf8"));
  } catch {
    /* primeira execução: o arquivo ainda não existe */
  }

  const origem = `${origemBase},*`;
  const quando = agoraChromium();
  const valor = (permitido) => ({ last_modified: quando, setting: permitido ? 1 : 2 });

  prefs.profile ||= {};
  prefs.profile.content_settings ||= {};
  const exc = (prefs.profile.content_settings.exceptions ||= {});

  exc.media_stream_camera ||= {};
  exc.media_stream_mic ||= {};
  exc.media_stream_camera[origem] = valor(camera);
  exc.media_stream_mic[origem] = valor(microfone);

  /*
   * A captura de tela continua perguntando, e é proposital: escolher QUAL
   * janela compartilhar é a própria permissão. Não existe "liberar de
   * antemão" que faça sentido aí.
   */

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(arquivo, JSON.stringify(prefs));
    return true;
  } catch {
    // Sem gravação, o navegador volta a perguntar — chato, mas funcional.
    return false;
  }
}

/**
 * Argumentos de linha de comando da janela do aplicativo.
 *
 * `--app=` é o que tira abas e barra de endereço. O resto existe para a
 * primeira execução do perfil não vir cheia de tela de boas-vindas, importação
 * de favoritos e pedido para virar navegador padrão por cima da chamada.
 */
export function argumentosDaJanela(url, navegador = null) {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${PASTA_PERFIL}`,
    "--window-size=1280,820",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    // FlexFEC no vídeo (desktop/webrtc.js).
    `--force-fieldtrials=${TRIALS_WEBRTC}`,
    // Sem isto o Chromium encosta a janela no canto superior esquerdo.
    "--window-position=120,80",
  ];

  if (process.platform === "linux") args.unshift(...opcoesLinux());

  // O Flatpak não é o navegador: é quem o executa.
  if (navegador?.flatpak) return ["run", `--filesystem=${PASTA_PERFIL}`, navegador.flatpak, ...args];
  return args;
}

/**
 * O que o Chromium precisa para compartilhar tela no Linux de hoje.
 *
 * COMPARTILHAR TELA NO WAYLAND NÃO PASSA PELO NAVEGADOR: passa pelo portal do
 * sistema (xdg-desktop-portal + PipeWire), que é quem desenha o seletor de
 * janelas e entrega o vídeo. Sem `WebRTCPipeWireCapturer`, o Chromium tenta
 * capturar pelo X11; sob Wayland isso devolve tela preta — ou, pior, a
 * promessa do `getDisplayMedia` nunca resolve e a chamada parece travada.
 * Era este o congelamento ao clicar em compartilhar.
 *
 * `ozone-platform-hint=auto` faz o Chromium rodar em Wayland nativo quando a
 * sessão é Wayland, em vez de pelo XWayland. Switches desconhecidos são
 * ignorados pelo Chromium, então as duas linhas são seguras em versão antiga
 * e em sessão X11.
 */
function opcoesLinux() {
  const opcoes = ["--enable-features=WebRTCPipeWireCapturer"];
  const wayland =
    process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY);
  if (wayland) opcoes.push("--ozone-platform-hint=auto");
  return opcoes;
}
