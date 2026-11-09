#!/usr/bin/env node
/**
 * scripts/vendor.mjs
 *
 * Gera os artefatos "vendorizados" que o navegador consome diretamente:
 *
 *   public/vendor/icons.svg    — sprite SVG com o subconjunto de ícones do Lucide (ISC)
 *   public/vendor/emoji.svg    — sprite com os emoji das reações e dos jogos (Fluent Emoji Flat, MIT)
 *   public/vendor/icons.json   — manifesto (id -> viewBox) para checagem em build
 *   public/vendor/avatars.js   — bundle ESM do DiceBear (MIT) com os estilos escolhidos
 *   public/vendor/qr.js        — gerador de QR code (qrcode-generator, MIT), para parear o QuizzV
 *   public/vendor/livekit.js   — cliente do SFU de quem transmite (livekit-client, Apache-2.0),
 *                                e livekit-e2ee.js, o worker que cifra os quadros ponta a ponta
 *   public/vendor/vosk.js      — reconhecimento de fala offline (vosk-browser, Apache-2.0),
 *                                usado pelas legendas no aplicativo de mesa
 *
 * Nenhum ícone é desenhado à mão neste projeto: todos vêm de bibliotecas abertas.
 * Rode com:  npm run vendor
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "node_modules", "lucide-static", "icons");
const outDir = path.join(root, "public", "vendor");

/* ------------------------------------------------------------------ *
 * 1. Sprite de ícones (Lucide)
 * ------------------------------------------------------------------ */

/** Nome do arquivo no lucide-static -> id usado no app. */
const ICONS = [
  // Jogos: menu, telas e sinais (sem emoji: os ícones do app)
  "lightbulb", "drama", "scan-face", "messages-square", "badge-question-mark", "swords", "hash", "grid-3x3",
  "brain", "trophy", "bot", "coins", "flame", "megaphone", "ferris-wheel", "bomb", "thumbs-up", "thumbs-down",
  "heart", "laugh", "coffee", "turtle", "rabbit", "repeat",
  // Cartas do jogo da memória (features/bancos.js)
  "cat", "dog", "fish", "bird", "snail", "bug", "squirrel", "panda", "apple", "cherry", "grape", "banana",
  "pizza", "cake", "ice-cream-cone", "cookie", "carrot", "croissant", "rocket", "plane", "car", "bike", "anchor",
  "umbrella", "cloud", "snowflake", "flower", "tree-pine", "leaf", "music", "guitar", "star", "gem", "key",
  "gift", "feather", "ghost", "sailboat", "drum", "glasses", "puzzle", "tent", "mountain",
  // Moderação e anexos (3.1)
  "user-x",
  "user-check",
  // Jogos de equipe
  "spade",
  "sticky-note",
  "timer",
  "party-popper",
  "list-checks",
  "play",
  "skip-forward",
  "captions",
  "search",
  "lock-open",
  "paperclip",
  "mic",
  "picture-in-picture-2",
  "headphones",
  "bluetooth",
  "mic-off",
  "video",
  "video-off",
  "screen-share",
  "screen-share-off",
  "phone",
  "phone-off",
  "message-square",
  "message-square-text",
  "users",
  "user",
  "user-plus",
  "settings",
  "maximize",
  "minimize",
  "maximize-2",
  "copy",
  "check",
  "check-check",
  "link",
  "sun",
  "moon",
  "monitor",
  "pencil",
  "eraser",
  "square",
  "circle",
  "type",
  "trash-2",
  "undo-2",
  "redo-2",
  "download",
  "x",
  "chevron-down",
  "chevron-right",
  "chevron-left",
  "pin",
  "pin-off",
  "signal",
  "signal-low",
  "signal-medium",
  "signal-high",
  "signal-zero",
  "wifi",
  "wifi-off",
  "activity",
  "hand",
  "volume-2",
  "volume-x",
  "camera",
  "image",
  "presentation",
  "layout-grid",
  "more-vertical",
  "refresh-cw",
  "alert-triangle",
  "loader-2",
  "shield",
  "shield-check",
  "lock",
  "palette",
  "highlighter",
  "move",
  "mouse-pointer-2",
  "minus",
  "plus",
  "send",
  "gauge",
  "cpu",
  "clock",
  "log-out",
  "smile",
  "sparkles",
  "rotate-ccw",
  "save",
  "laptop",
  "network",
  "arrow-up-right",
  "arrow-right",
  "eye",
  "eye-off",
  "bell",
  "bell-off",
  "zap",
  "hard-drive",
  "radio",
  "dices",
  "clapperboard",
  "folder",
  "pause",
  "shuffle",
  "info",
  "circle-help",
  "clipboard-check",
  "square-dashed-mouse-pointer",
  "spline",
  "slash",
  "brush",
  "grip-vertical",
  "panel-right-close",
  "panel-right-open",
  "scan",
  "crown",
  "flip-horizontal",
  // Celular com o QuizzV no Quiz (3.13)
  "smartphone",
];

/** Aliases semânticos: id no app -> nome do arquivo Lucide. */
/** Id no app -> nome nas Octicons (o kanban do GitHub no Planning Poker). */
const OCTICONS = {
  github: "mark-github-16",
  "gh-issue": "issue-opened-16",
  "gh-issue-closed": "issue-closed-16",
  "gh-sub-issue": "issue-tracks-16",
  "gh-tag": "tag-16",
  "gh-milestone": "milestone-16",
  "gh-people": "people-16",
  "gh-project": "project-16",
};

const ALIASES = {
  "network-0": "signal-zero",
  "network-1": "signal-low",
  "network-2": "signal-medium",
  "network-3": "signal-high",
  "network-4": "signal",
  spinner: "loader-2",
  mirror: "flip-horizontal",
  pointer: "mouse-pointer-2",
  arrow: "arrow-up-right",
  line: "slash",
  host: "crown",
};

/*
 * Emoji das reações e dos jogos: Fluent Emoji Flat, da Microsoft (MIT), pelo
 * pacote @iconify-json/fluent-emoji-flat. Desenhados aqui, e não com a fonte
 * do sistema, para serem iguais no Windows, em qualquer Linux (onde a fonte
 * colorida às vezes nem existe e o emoji vira um quadrado) e no celular.
 */
export const EMOJIS = [
  // Reações rápidas
  "thumbs-up", "red-heart", "face-with-tears-of-joy", "face-with-open-mouth", "clapping-hands", "party-popper",
  "fire", "thinking-face", "crying-face", "folded-hands", "hundred-points", "rocket",
  "star-struck", "raising-hands", "eyes", "smiling-face-with-heart-eyes", "skull", "exploding-head",
];

async function buildEmoji() {
  const fonte = path.join(root, "node_modules", "@iconify-json", "fluent-emoji-flat", "icons.json");
  if (!existsSync(fonte)) {
    console.warn("  ! @iconify-json/fluent-emoji-flat não instalado: emoji.svg não foi gerado");
    return;
  }
  const pacote = JSON.parse(await readFile(fonte, "utf8"));
  const largura = pacote.width || 32;
  const altura = pacote.height || 32;
  const simbolos = [];
  for (const nome of EMOJIS) {
    const e = pacote.icons[nome];
    if (!e) {
      console.warn(`  ! emoji ausente no Fluent Emoji Flat: ${nome}`);
      continue;
    }
    simbolos.push(`<symbol id="e-${nome}" viewBox="0 0 ${e.width || largura} ${e.height || altura}">${e.body}</symbol>`);
  }
  const sprite =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Fluent Emoji Flat (MIT License) — https://github.com/microsoft/fluentui-emoji — subconjunto gerado por scripts/vendor.mjs -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">\n${simbolos.join("\n")}\n</svg>\n`;
  await writeFile(path.join(outDir, "emoji.svg"), sprite);
  console.log(`  ✓ emoji.svg  (${simbolos.length} emoji, ${Math.round(sprite.length / 1024)} KB)`);
}

async function buildSprite() {
  const symbols = [];
  const manifest = {};
  const seen = new Map();

  for (const name of ICONS) {
    const file = path.join(iconsDir, `${name}.svg`);
    if (!existsSync(file)) {
      console.warn(`  ! ícone ausente no lucide-static: ${name}`);
      continue;
    }
    const raw = await readFile(file, "utf8");
    const viewBox = (raw.match(/viewBox="([^"]+)"/) || [, "0 0 24 24"])[1];
    // Conteúdo interno do <svg>, sem a tag externa.
    const body = raw
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    symbols.push(
      `<symbol id="i-${name}" viewBox="${viewBox}">${body}</symbol>`,
    );
    manifest[name] = viewBox;
    seen.set(name, true);
  }

  // Marcas que o Lucide não traz: o símbolo do GitHub, das Octicons (MIT), cheio e sem traço.
  const octicons = path.join(root, "node_modules", "@iconify-json", "octicon", "icons.json");
  if (existsSync(octicons)) {
    const pacote = JSON.parse(await readFile(octicons, "utf8"));
    for (const [id, nome] of Object.entries(OCTICONS)) {
      const o = pacote.icons[nome];
      if (!o) {
        console.warn(`  ! ícone ausente nas Octicons: ${nome}`);
        continue;
      }
      const viewBox = `0 0 ${o.width || pacote.width || 16} ${o.height || pacote.height || 16}`;
      symbols.push(`<symbol id="i-${id}" viewBox="${viewBox}"><g stroke="none">${o.body}</g></symbol>`);
      manifest[id] = viewBox;
      seen.set(id, true);
    }
  } else console.warn("  ! @iconify-json/octicon não instalado: sem o símbolo do GitHub");

  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!seen.has(target)) {
      console.warn(`  ! alias ${alias} aponta para ícone ausente: ${target}`);
      continue;
    }
    symbols.push(`<use id="i-${alias}" href="#i-${target}"/>`);
    manifest[alias] = manifest[target];
  }

  const sprite =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Lucide Icons (ISC License) — https://lucide.dev — subconjunto gerado por scripts/vendor.mjs -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">\n${symbols.join("\n")}\n</svg>\n`;

  await writeFile(path.join(outDir, "icons.svg"), sprite);
  await writeFile(
    path.join(outDir, "icons.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(`  ✓ icons.svg  (${Object.keys(manifest).length} símbolos)`);
}

/* ------------------------------------------------------------------ *
 * 2. Bundle de avatares (DiceBear)
 * ------------------------------------------------------------------ */

/** Estilos oferecidos na escolha de avatar. Todos SVG, determinísticos por semente. */
const AVATAR_STYLES = [
  "notionistsNeutral",
  "loreleiNeutral",
  "adventurerNeutral",
  "botttsNeutral",
  "personas",
  "miniavs",
  "thumbs",
  "shapes",
  "identicon",
  "initials",
];

const AVATAR_ENTRY = `
// Gerado por scripts/vendor.mjs — não edite à mão.
// DiceBear (MIT) — https://dicebear.com
import { createAvatar } from "@dicebear/core";
import { ${AVATAR_STYLES.join(", ")} } from "@dicebear/collection";

export const styles = { ${AVATAR_STYLES.join(", ")} };
export const styleIds = ${JSON.stringify(AVATAR_STYLES)};
export { createAvatar };
`;

async function buildAvatars() {
  const entry = path.join(root, "scripts", ".avatars-entry.mjs");
  await writeFile(entry, AVATAR_ENTRY);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    target: ["es2022"],
    outfile: path.join(outDir, "avatars.js"),
    banner: {
      js: "/* DiceBear (MIT) — https://dicebear.com — bundle gerado por scripts/vendor.mjs */",
    },
    logLevel: "error",
  });
  if (result.errors.length) throw new Error("falha no bundle de avatares");
  const { size } = await import("node:fs").then((fs) =>
    fs.promises.stat(path.join(outDir, "avatars.js")),
  );
  console.log(`  ✓ avatars.js (${(size / 1024).toFixed(0)} kB, ${AVATAR_STYLES.length} estilos)`);
  await import("node:fs").then((fs) => fs.promises.unlink(entry));
}

/**
 * Cliente do SFU (livekit-client, Apache-2.0): quem transmite para 3 ou mais
 * pessoas publica a tela uma vez no LiveKit do app de mesa (desktop/sfu.js).
 * O worker cifra e decifra os quadros (SFrame), e o SFU não vê a imagem.
 */
async function buildLivekit() {
  const dist = path.join(root, "node_modules", "livekit-client", "dist");
  for (const [entrada, saida] of [["livekit-client.esm.mjs", "livekit.js"], ["livekit-client.e2ee.worker.mjs", "livekit-e2ee.js"]]) {
    const result = await esbuild.build({
      entryPoints: [path.join(dist, entrada)],
      bundle: true,
      format: "esm",
      minify: true,
      target: ["es2020"],
      outfile: path.join(outDir, saida),
      banner: { js: "/* livekit-client (Apache-2.0) — LiveKit — bundle gerado por scripts/vendor.mjs */" },
      logLevel: "error",
    });
    if (result.errors.length) throw new Error(`falha no bundle de ${saida}`);
    console.log(`  ✓ ${saida}`);
  }
}

/**
 * QR code para parear o celular (QuizzV) com a chamada. Gerado aqui, no
 * navegador: mandar o endereço para um serviço de QR na internet entregaria
 * o token de pareamento a um terceiro — e a CSP nem deixaria.
 */
async function buildQr() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "node_modules", "qrcode-generator", "dist", "qrcode.mjs")],
    bundle: true,
    format: "esm",
    minify: true,
    target: ["es2020"],
    outfile: path.join(outDir, "qr.js"),
    banner: {
      js: "/* qrcode-generator (MIT) — Kazuhiko Arase — bundle gerado por scripts/vendor.mjs */",
    },
    logLevel: "error",
  });
  if (result.errors.length) throw new Error("falha no bundle do QR");
  console.log("  ✓ qr.js");
}

/**
 * Reconhecimento de fala offline (vosk-browser, Apache-2.0). Só é carregado
 * quando a legenda é ligada no app de mesa, onde o reconhecimento do Chrome
 * não existe.
 *
 * O pacote traz um worker embutido (base64) que usa `new Function` para
 * montar funções internas — técnica antiga do Emscripten (embind), que a
 * nossa CSP bloqueia, e com razão: liberar 'unsafe-eval' valeria para o app
 * inteiro. Em vez disso, as três funções que geram código são trocadas aqui
 * pelas versões com closures que o próprio Emscripten adotou depois
 * (DYNAMIC_EXECUTION=0). O resultado é conferido: se sobrar geração de código,
 * o script falha em vez de publicar algo que a CSP vai derrubar.
 */
const VOSK_PATCHES = [
  {
    nome: "createNamedFunction",
    de: /function createNamedFunction\(name,body\)\{name=makeLegalFunctionName\(name\);return new Function\([\s\S]*?\)\(body\)\}/,
    para:
      'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return {[name]:function(){return body.apply(this,arguments)}}[name]}',
  },
  {
    nome: "craftInvokerFunction",
    de: /function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc\)\{[\s\S]*?var invokerFunction=new_\(Function,args1\)\.apply\(null,args2\);return invokerFunction\}/,
    para: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expected=argCount-2;return createNamedFunction(humanName,function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;var wired=new Array(expected);var callArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);callArgs.push(thisWired)}for(var i=0;i<expected;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);callArgs.push(wired[i])}var rv=cppInvokerFunc.apply(null,callArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var j=isClassMethodFunc?1:2;j<argTypes.length;++j){var param=j===1?thisWired:wired[j-2];if(argTypes[j].destructorFunction!==null){argTypes[j].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}})}`,
  },
  {
    nome: "__emval_get_method_caller",
    de: /var functionName=makeLegalFunctionName\("methodCaller_"\+signatureName\);[\s\S]*?var invokerFunction=new_\(Function,params\)\.apply\(null,args\);/,
    para:
      'var invokerFunction=function(handle,name,destructors,args){var offset=0;var argv=new Array(argCount-1);for(var i=0;i<argCount-1;++i){argv[i]=types[1+i].readValueFromPointer(args+offset);offset+=types[i+1]["argPackAdvance"]}var rv=handle[name].apply(handle,argv);for(var k=0;k<argCount-1;++k){if(types[k+1]["deleteObject"]){types[k+1].deleteObject(argv[k])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};',
  },
];

export function patchVoskWorker(codigo) {
  let out = codigo;
  for (const p of VOSK_PATCHES) {
    if (!p.de.test(out)) throw new Error(`vosk: trecho ${p.nome} não encontrado — a versão do vosk-browser mudou`);
    out = out.replace(p.de, () => p.para);
  }
  if (/new Function|new_\(Function|\beval\(/.test(out)) throw new Error("vosk: ainda há geração de código no worker");
  return out;
}

async function copyVosk() {
  const src = path.join(root, "node_modules", "vosk-browser", "dist", "vosk.js");
  if (!existsSync(src)) {
    console.warn("  ! vosk-browser não instalado (npm install --include=dev); mantendo o vosk.js atual");
    return;
  }
  const bundle = await readFile(src, "utf8");
  const m = bundle.match(/createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/);
  if (!m) throw new Error("vosk: worker embutido não encontrado");
  const worker = Buffer.from(m[1], "base64").toString("latin1");
  const corrigido = patchVoskWorker(worker);
  const final = bundle.replace(m[1], Buffer.from(corrigido, "latin1").toString("base64"));
  await writeFile(path.join(outDir, "vosk.js"), final);
  console.log(`  ✓ vosk.js (${(final.length / 1024 / 1024).toFixed(1)} MB, worker sem eval)`);
}

/**
 * Legendas no app de mesa com Whisper (transformers.js + ONNX Runtime, ambos
 * Apache-2.0/MIT). Tudo servido pelo próprio app: a CSP não deixa buscar
 * script de CDN, e o reconhecimento tem que funcionar sem depender de
 * terceiros além do download único do modelo.
 *
 *   public/vendor/whisper/transformers.js     — só o necessário para o Whisper
 *   public/vendor/whisper/ort-wasm-*.{mjs,wasm} — o motor (WebAssembly/WebGPU)
 */
async function buildWhisper() {
  const pasta = path.join(outDir, "whisper");
  const ort = path.join(root, "node_modules", "onnxruntime-web", "dist");
  if (!existsSync(path.join(root, "node_modules", "@huggingface", "transformers")) || !existsSync(ort)) {
    console.warn("  ! @huggingface/transformers não instalado (npm install --include=dev); legendas do app ficam no Vosk");
    return;
  }
  await mkdir(pasta, { recursive: true });
  const entrada = path.join(root, "scripts", ".whisper-entry.mjs");
  await writeFile(
    entrada,
    'export { env, Tensor, WhisperTokenizer, AutoFeatureExtractor, WhisperForConditionalGeneration } from "@huggingface/transformers";\n' +
      // O mesmo ONNX Runtime que o Whisper usa roda o detector de voz.
      'export { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web/webgpu";\n',
  );
  const result = await esbuild.build({
    entryPoints: [entrada],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: true,
    target: ["es2022"],
    outfile: path.join(pasta, "transformers.js"),
    banner: { js: "/* transformers.js (Apache-2.0) + onnxruntime-web (MIT) — bundle gerado por scripts/vendor.mjs */" },
    logLevel: "error",
  });
  await import("node:fs").then((fs) => fs.promises.unlink(entrada));
  if (result.errors.length) throw new Error("falha no bundle do Whisper");
  let total = 0;
  for (const nome of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
    const dados = await readFile(path.join(ort, nome));
    total += dados.length;
    await writeFile(path.join(pasta, nome), dados);
  }
  // Detector de voz Silero v5 (MIT, 2 MB): decide quando alguém começa e
  // para de falar muito melhor que o volume — teclado e ventilador não contam.
  const silero = path.join(root, "node_modules", "@ricky0123", "vad-web", "dist", "silero_vad_v5.onnx");
  if (!existsSync(silero)) throw new Error("silero_vad_v5.onnx não encontrado (npm install --include=dev)");
  const vad = await readFile(silero);
  total += vad.length;
  await writeFile(path.join(pasta, "silero_vad_v5.onnx"), vad);
  const { size } = await import("node:fs").then((fs) => fs.promises.stat(path.join(pasta, "transformers.js")));
  console.log(`  ✓ whisper/ (transformers.js ${(size / 1024).toFixed(0)} kB + motor ${(total / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Supressão de ruído por IA (RNNoise, BSD; build do Jitsi, Apache-2.0). A
 * versão "sync" traz o WebAssembly embutido e abre sem rede nem `await` —
 * é o que um AudioWorklet precisa. Sem eval: passa pela CSP.
 */
async function copyRnnoise() {
  const src = path.join(root, "node_modules", "@jitsi", "rnnoise-wasm", "dist", "rnnoise-sync.js");
  if (!existsSync(src)) {
    console.warn("  ! @jitsi/rnnoise-wasm não instalado; mantendo o rnnoise-sync.js atual");
    return;
  }
  const codigo = await readFile(src, "utf8");
  if (/new Function|\beval\(/.test(codigo)) throw new Error("rnnoise: geração de código não passa pela CSP");
  await writeFile(path.join(outDir, "rnnoise-sync.js"), codigo);
  console.log(`  ✓ rnnoise-sync.js (${(codigo.length / 1024 / 1024).toFixed(1)} MB)`);
}

/* ------------------------------------------------------------------ */

await mkdir(outDir, { recursive: true });
console.log("Vendorizando dependências de UI...");
await buildSprite();
await buildEmoji();
await buildAvatars();
await buildQr();
await buildLivekit();
await copyVosk();
await buildWhisper();
await copyRnnoise();
console.log("Pronto.");
