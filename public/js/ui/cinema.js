/**
 * ui/cinema.js — a tela do "Assistir junto" (features/cinema.js), dentro da
 * mesa de jogos: o player no lugar do destaque e a biblioteca ao lado.
 *
 * O <video> nativo é o controle remoto de todos: play, pausa e a barra de
 * tempo viram escritas no estado compartilhado, e o que chega dos outros
 * move este player. O cuidado todo é não confundir as duas coisas:
 *
 *   - mudança que ESTE código fez no player (seguir a sala) não volta como
 *     comando, senão uma pausa ecoaria pela sala para sempre;
 *   - pausa que o NAVEGADOR fez sozinho também não: o Chromium pausa vídeo
 *     sem áudio em aba de fundo, e o play automático pode ser barrado até a
 *     pessoa clicar na página. Nenhuma das duas é a pessoa pedindo pausa.
 */
import { el, icon } from "../lib/dom.js";
import { Vista, abertura, botao, faixa, mmss } from "./jogos-comum.js";
import { PainelBiblioteca } from "./cinema-biblioteca.js";

/** Diferença (s) a partir da qual o player é trazido de volta ao ponto da sala. */
const TOLERANCIA = 0.75;

export class VistaCinema extends Vista {
  #p = {};
  /** @type {PainelBiblioteca|null} */
  #biblioteca = null;
  /** "fonte:id" do vídeo que está no player. */
  #noPlayer = "";
  #trocando = null;
  /** Ponto para onde ESTE código mandou o player (o `seeked` dele não é da pessoa). */
  #corrigindo = null;
  /** play() deste código em andamento: a pausa que vier junto não é da pessoa. */
  #tentandoTocar = false;
  #barrado = false;
  #erroVideo = "";
  #tentativas = 0;

  montar() {
    const { corpo, extra } = this.c;
    const video = el("video.cinema__video", { playsInline: true, controls: true, preload: "auto" });
    const entrar = botao("Entrar no vídeo", { icone: "play", tipo: "primary", classe: "cinema__entrar", onClick: () => this.#entrar() });
    entrar.hidden = true;
    const vazio = el("div.cinema__vazio");
    const aviso = el("div.cinema__aviso");
    const estado = el("p.cinema__estado", { role: "status" });
    const palco = el("div.cinema__palco", {}, [el("div.cinema__tela", {}, [video, entrar, vazio]), aviso, estado]);

    this.#biblioteca = new PainelBiblioteca(this.l, () => this.desenhar());
    const lado = this.#biblioteca.raiz;
    const parar = botao("Tirar o vídeo", { icone: "x", tipo: "ghost", classe: "jogos__chip", tip: "Tira o vídeo para todos", onClick: () => this.l.fechar() });

    const raiz = el("div.cinema", {}, [palco, lado]);
    corpo.append(raiz);
    extra.append(parar);
    Object.assign(this.#p, { raiz, video, entrar, vazio, aviso, estado, parar });

    this.#ouvirPlayer(video);
    this.ouvir(document, "visibilitychange", () => !document.hidden && this.desenhar());
    this.ouvir(this.l, "disponivel", () => this.desenhar());
    this.aoDestruir(() => {
      this.#biblioteca.destruir();
      video.pause();
      video.removeAttribute("src");
      video.load(); // solta a conexão do vídeo
    });
    this.#biblioteca.comecar();
  }

  /** Enquanto toca, o relógio da mesa chama `tique` para manter o ponto. */
  relogio() {
    return this.l.tempo().tocando;
  }

  tique() {
    this.desenhar();
  }

  desenhar() {
    const p = this.#p;
    if (!p.raiz) return;
    const item = this.l.item();
    const t = this.l.tempo();

    if (this.l.disponivel === false) {
      p.raiz.dataset.estado = "sem-fonte";
      p.parar.hidden = true;
      faixa(p.vazio, "sem", [
        abertura({
          icone: "clapperboard",
          titulo: "Quem hospeda ainda não escolheu o que mostrar",
          regras: [
            "O Assistir junto toca vídeos do computador onde a sala está, sem enviar nada antes.",
            "Quem hospeda liga uma fonte: uma pasta de vídeos (PASTA_VIDEOS, ou Configurações › Vídeos para assistir junto no app de mesa) ou o Jellyfin (JELLYFIN_URL e JELLYFIN_KEY).",
          ],
        }),
      ]);
      return;
    }

    p.raiz.dataset.estado = item ? "com-video" : "sem-video";
    p.parar.hidden = !item;
    this.#biblioteca.desenhar(item);

    if (!item) {
      faixa(p.vazio, "escolha", [el("p", { text: "Escolha um vídeo na biblioteca: ele abre para todos na chamada, no mesmo ponto." })]);
      p.estado.textContent = "";
      p.aviso.replaceChildren();
      if (this.#noPlayer) this.#soltarVideo();
      return;
    }
    p.vazio.replaceChildren();

    const quem = this.pessoas().find((x) => x.id === t.por);
    const nome = quem ? (quem.eu ? "você" : quem.nome) : "";
    p.estado.textContent = `${item.nome} · ${t.tocando ? "tocando" : "pausado"}${nome ? ` (por ${nome})` : ""} · ${mmss(this.l.posicaoAgora())}`;
    p.entrar.hidden = !(this.#barrado && t.tocando);
    if (this.#erroVideo) faixa(p.aviso, this.#erroVideo, [icon("info", { size: "sm" }), el("span", { text: this.#erroVideo })], "erro");
    else p.aviso.replaceChildren();

    this.#seguirSala(item, t);
  }

  /* ------------------- o player segue a sala ------------------- */

  async #seguirSala(item, t) {
    const { video } = this.#p;
    const chave = `${item.fonte}:${item.id}`;
    if (this.#noPlayer !== chave) {
      if (this.#trocando === chave) return;
      this.#trocando = chave;
      this.#erroVideo = "";
      this.#barrado = false;
      try {
        const src = await this.l.enderecoDoVideo(item);
        const agora = this.l.item();
        if (`${agora?.fonte}:${agora?.id}` !== chave || !this.#p.raiz) return;
        this.#noPlayer = chave;
        video.src = src;
      } catch (err) {
        this.#erroVideo = err.message || "Não deu para abrir o vídeo.";
      } finally {
        if (this.#trocando === chave) this.#trocando = null;
      }
      return; // o `loadedmetadata` chama desenhar() de novo
    }
    if (video.readyState < 1) return;

    const alvo = this.l.posicaoAgora();
    if (!video.seeking && Math.abs(video.currentTime - alvo) > TOLERANCIA) {
      this.#corrigindo = alvo;
      video.currentTime = alvo;
    }
    // Em aba escondida o navegador pausaria de novo: retoma quando ela voltar.
    if (t.tocando && video.paused && !document.hidden && !this.#tentandoTocar && !this.#barrado && !video.ended) this.#tocar();
    if (!t.tocando && !video.paused) video.pause();
  }

  async #tocar() {
    const { video } = this.#p;
    this.#tentandoTocar = true;
    try {
      await video.play();
      this.#barrado = false;
    } catch (err) {
      // Play automático barrado: falta um clique da pessoa nesta página.
      if (err?.name === "NotAllowedError") this.#barrado = true;
    } finally {
      this.#tentandoTocar = false;
      this.desenhar();
    }
  }

  /** O clique que libera o som e o play (o navegador exige um gesto). */
  #entrar() {
    this.#barrado = false;
    this.#tocar(); // dentro do clique: é o gesto que o navegador pede
  }

  #soltarVideo() {
    const { video } = this.#p;
    this.#noPlayer = "";
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  #ouvirPlayer(video) {
    const pos = () => video.currentTime;
    this.ouvir(video, "loadedmetadata", () => {
      this.#tentativas = 0;
      this.#erroVideo = "";
      this.desenhar();
    });
    this.ouvir(video, "play", () => {
      if (!this.l.tempo().tocando) this.l.tocar(pos());
    });
    this.ouvir(video, "pause", () => {
      if (document.hidden || this.#tentandoTocar || video.ended || !video.src) return;
      if (this.l.tempo().tocando) this.l.pausar(pos());
    });
    this.ouvir(video, "seeked", () => {
      if (this.#corrigindo != null && Math.abs(pos() - this.#corrigindo) < 0.25) {
        this.#corrigindo = null;
        return;
      }
      this.#corrigindo = null;
      if (Math.abs(pos() - this.l.posicaoAgora()) > TOLERANCIA) this.l.irPara(pos());
    });
    this.ouvir(video, "ended", () => {
      if (this.l.tempo().tocando) this.l.pausar(video.duration || pos());
    });
    this.ouvir(video, "error", () => {
      const codigo = video.error?.code;
      // 4: formato que este navegador não toca (MKV, HEVC…); o resto, rede.
      this.#erroVideo = codigo === 4 ? "Este navegador não toca o formato deste vídeo." : this.#tentativas < 3 ? "O vídeo parou de chegar. Tentando de novo…" : "O vídeo não chega do computador de quem hospeda.";
      const item = this.l.item();
      if (codigo !== 4 && item && this.#noPlayer && this.#tentativas < 3) {
        this.#tentativas += 1;
        this.#noPlayer = "";
        // Ficha vencida ou rede que piscou: pede outra ficha, e o próximo desenho retoma.
        this.l.ficha({ nova: true }).catch(() => {});
      }
      this.desenhar();
    });
  }
}
