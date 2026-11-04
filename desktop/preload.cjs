/**
 * desktop/preload.cjs — a ponte entre a janela e o sistema.
 *
 * Deliberadamente mínima: a página é a mesma do navegador e não ganha poderes
 * por estar no app. O que existe aqui é cosmético — marcar o documento como
 * "desktop" (o CSS abre espaço para os botões da janela e cria a área de
 * arrastar) e manter a cor desses botões de acordo com o tema.
 *
 * .cjs porque o preload roda em CommonJS mesmo num pacote "type": "module".
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vcallDesktop", {
  isDesktop: true,
  info: () => ipcRenderer.invoke("vcall:info"),
  /** Liga/desliga o modo mini-janela (compacta, sempre por cima). */
  mini: (ligar) => ipcRenderer.invoke("vcall:mini", !!ligar),
  /**
   * Telas e janelas que dá para compartilhar, com miniatura. No Wayland volta
   * `{ portal: true }`: quem mostra a lista é o portal do sistema.
   */
  //
  // SEGURANÇA: a lista traz miniaturas e títulos das suas janelas. Ela só é
  // entregue logo depois de um clique real (ativação do usuário, que página
  // nenhuma consegue forjar) — um site não consegue espiar as suas janelas
  // em segundo plano. O processo principal ainda confere a origem.
  // `{ miniaturas: false }` devolve só nomes e ícones, bem mais rápido.
  fontes: (opcoes) =>
    navigator.userActivation?.isActive === false
      ? Promise.reject(new Error("a lista de janelas só abre a partir de um clique"))
      : ipcRenderer.invoke("vcall:fontes", { miniaturas: opcoes?.miniaturas !== false }),
  /**
   * Legendas no app: garante o modelo de fala do idioma (baixa na primeira
   * vez) e devolve o endereço dele. `aoProgresso` recebe de 0 a 1.
   */
  prepararFala: async (lang, aoProgresso) => {
    const ouvir = (_e, m) => {
      if (m?.lang === lang || !lang) aoProgresso?.(m.p);
    };
    ipcRenderer.on("vcall:fala-progresso", ouvir);
    try {
      return await ipcRenderer.invoke("vcall:fala-preparar", String(lang || "pt-BR"));
    } finally {
      ipcRenderer.removeListener("vcall:fala-progresso", ouvir);
    }
  },
  /**
   * Modo jogo: sobreposição transparente por cima dos outros programas e
   * atalhos globais (Ctrl+Shift+M microfone, Ctrl+Shift+O sobreposição).
   */
  modoJogo: (ligar, canto = "tl") => ipcRenderer.invoke("vcall:modo-jogo", { ligar: !!ligar, canto: String(canto) }),
  /** Manda à sobreposição quem está na chamada e quem está falando. */
  estadoSobreposicao: (estado) => ipcRenderer.send("vcall:sobreposicao-estado", estado),
  /** Atalhos globais chegando do sistema ("mic"). */
  aoAtalho: (fn) => {
    const ouvir = (_e, acao) => fn(String(acao));
    ipcRenderer.on("vcall:atalho", ouvir);
    return () => ipcRenderer.removeListener("vcall:atalho", ouvir);
  },
  /**
   * Legendas com Whisper: garante o modelo do tamanho pedido ("rapida",
   * "equilibrada", "maxima") e devolve onde ele está. `aoProgresso` de 0 a 1.
   */
  prepararWhisper: async (nivel, aoProgresso) => {
    const ouvir = (_e, m) => {
      if (m?.whisper) aoProgresso?.(m.p);
    };
    ipcRenderer.on("vcall:fala-progresso", ouvir);
    try {
      return await ipcRenderer.invoke("vcall:whisper-preparar", String(nivel || ""));
    } finally {
      ipcRenderer.removeListener("vcall:fala-progresso", ouvir);
    }
  },
  descartarWhisper: (nivel) => ipcRenderer.invoke("vcall:whisper-descartar", String(nivel || "")),
  /** Apaga o modelo de fala guardado (corrompido): a próxima vez baixa de novo. */
  descartarFala: (lang) => ipcRenderer.invoke("vcall:fala-descartar", String(lang || "pt-BR")),
  /**
   * Atualização automática: estado (fase, versão, progresso), procurar agora,
   * reiniciar e instalar, e avisos de mudança.
   */
  /** A sala de outra pessoa voltou? (status HTTP, 0 se não respondeu) — public/erro.html */
  sondar: (url) => ipcRenderer.invoke("vcall:sondar", url),
  atualizacao: {
    estado: () => ipcRenderer.invoke("vcall:atualizacao", "estado"),
    verificar: () => ipcRenderer.invoke("vcall:atualizacao", "verificar"),
    instalar: () => ipcRenderer.invoke("vcall:atualizacao", "instalar"),
    aoMudar: (fn) => {
      const ouvir = (_e, s) => fn(s);
      ipcRenderer.on("vcall:atualizacao", ouvir);
      return () => ipcRenderer.removeListener("vcall:atualizacao", ouvir);
    },
  },
  /**
   * O kanban de um GitHub Project no Planning Poker (desktop/github.js):
   * estado, conectar, sair, projeto, cards, estimar. O token fica no processo
   * principal; daqui só saem pedidos fechados.
   */
  github: async (acao, dados) => {
    const r = await ipcRenderer.invoke("vcall:github", { acao: String(acao), dados });
    if (r?.erro) throw new Error(r.erro);
    return r?.valor;
  },
  /** Diz qual fonte a próxima captura deve usar, e se leva o som do sistema. */
  escolherFonte: (id, audio) => ipcRenderer.invoke("vcall:escolher", { id: String(id || ""), audio: !!audio }),
});

window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  root.classList.add("is-desktop", `is-${process.platform}`);

  // Faixa invisível no topo para arrastar a janela nas telas sem barra própria.
  const faixa = document.createElement("div");
  faixa.className = "win-drag";
  faixa.setAttribute("aria-hidden", "true");
  document.body.prepend(faixa);

  // O tema da página vale para os botões nativos da janela.
  let ultimo = null;
  const sincronizar = () => {
    const tema = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    // No visual Empresa a chamada é escura nos dois temas (empresa.css).
    const palco = root.dataset.visual === "empresa" && !!document.querySelector("#topbar:not([hidden])");
    const escuro = tema !== "light" || palco;
    if (escuro !== ultimo) ipcRenderer.send("vcall:tema", (ultimo = escuro));
  };
  new MutationObserver(sincronizar).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-visual"] });
  const topo = document.getElementById("topbar");
  if (topo) new MutationObserver(sincronizar).observe(topo, { attributes: true, attributeFilter: ["hidden"] });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", sincronizar);
  sincronizar();
});
