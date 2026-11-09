/**
 * desktop/pasta.js — a "Pasta de vídeos" do Assistir junto no app de mesa.
 *
 * No app instalado não há .env para pôr PASTA_VIDEOS. A escolha fica em
 * pasta.json, na pasta do app, e vai para src/cinema-pasta.js na hora.
 *
 * Três estados: sem arquivo (vale o PASTA_VIDEOS do ambiente, se houver),
 * pasta escolhida, e "desligada" (a pessoa desligou de propósito: o ambiente
 * não volta a valer).
 */
import { statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { definirPasta, pastaAtual } from "../src/cinema-pasta.js";

/** string (pode ser "" = desligada) ou undefined se nunca foi escolhida. */
export function lerPasta(arquivo) {
  try {
    const v = JSON.parse(readFileSync(arquivo, "utf8"))?.pasta;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** O que a página vê: a pasta de agora, e se ainda existe. */
export function visaoDaPasta() {
  const caminho = pastaAtual();
  let existe = false;
  try {
    existe = !!caminho && statSync(caminho).isDirectory();
  } catch {
    /* sumiu ou sem permissão */
  }
  return { pasta: caminho, existe };
}

/** Grava (caminho vazio = desligar), aplica na hora e devolve a visão ou { erro }. */
export function salvarPasta(arquivo, caminho) {
  const nova = caminho ? path.resolve(String(caminho)) : "";
  try {
    mkdirSync(path.dirname(arquivo), { recursive: true });
    writeFileSync(arquivo, JSON.stringify({ pasta: nova }));
  } catch {
    return { erro: "Não consegui salvar a escolha neste computador." };
  }
  definirPasta(nova);
  return visaoDaPasta();
}
