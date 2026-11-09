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
import { Vista, abertura, botao, campo, faixa, mmss, sincronizar } from "./jogos-comum.js";

/** Diferença (s) a partir da qual o player é trazido de volta ao ponto da sala. */
const TOLERANCIA = 0.75;

export class VistaCinema extends Vista {
  #p = {};
  #itens = [];
  #carregando = false;
  #erroLista = "";
  /** id do vídeo que está no player. */
  #fonte = "";
  #trocandoFonte = null;
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

    const busca = campo({ placeholder: "Buscar na biblioteca", rotulo: "Buscar vídeos", max: 80, limpar: false, aoEnviar: (t) => this.#carregar(t) });
    busca.addEventListener("input", () => {
      clearTimeout(this.#p.espera);
      this.#p.espera = setTimeout(() => this.#carregar(busca.value), 350);
    });
    const lista = el("ul.cinema__lista", { "aria-label": "Vídeos da biblioteca" });
    const lado = el("aside.cinema__lado", { "aria-label": "Biblioteca de quem hospeda" }, [
      el("h3.jogos__titulo", { text: "Biblioteca" }),
      el("div.cinema__busca", {}, [icon("search", { size: "sm" }), busca]),
      lista,
    ]);
    const parar = botao("Tirar o vídeo", { icone: "x", tipo: "ghost", classe: "jogos__chip", tip: "Tira o vídeo para todos", onClick: () => this.l.fechar() });

    const raiz = el("div.cinema", {}, [palco, lado]);
    corpo.append(raiz);
    extra.append(parar);
    Object.assign(this.#p, { raiz, video, entrar, vazio, aviso, estado, lista, lado, parar });

    this.#ouvirPlayer(video);
    this.ouvir(document, "visibilitychange", () => !document.hidden && this.desenhar());
    this.ouvir(this.l, "disponivel", () => this.desenhar());
    this.aoDestruir(() => {
      clearTimeout(this.#p.espera);
      video.pause();
      video.removeAttribute("src");
      video.load(); // solta a conexão do vídeo
    });
    this.#carregar("");
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
      p.raiz.dataset.estado = "sem-jellyfin";
      p.parar.hidden = true;
      faixa(p.vazio, "sem", [
        abertura({
          icone: "clapperboard",
          titulo: "Quem hospeda ainda não ligou o Jellyfin",
          regras: [
            "O Assistir junto toca vídeos da biblioteca Jellyfin do computador onde a sala está.",
            "Quem hospeda define JELLYFIN_URL e JELLYFIN_KEY no servidor e abre a sala de novo.",
          ],
        }),
      ]);
      return;
    }

    p.raiz.dataset.estado = item ? "com-video" : "sem-video";
    p.parar.hidden = !item;
    this.#desenharLista(item);

    if (!item) {
      faixa(p.vazio, "escolha", [el("p", { text: "Escolha um vídeo na biblioteca: ele abre para todos na chamada, no mesmo ponto." })]);
      p.estado.textContent = "";
      p.aviso.replaceChildren();
      if (this.#fonte) this.#soltarFonte();
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

  /* ------------------------- a biblioteca ------------------------- */

  async #carregar(busca) {
    this.#carregando = true;
    this.#erroLista = "";
    this.desenhar();
    try {
      this.#itens = await this.l.biblioteca(busca);
    } catch (err) {
      this.#erroLista = err.message || "Não deu para abrir a biblioteca.";
      this.#itens = [];
    }
    this.#carregando = false;
    this.desenhar();
  }

  #desenharLista(item) {
    const { lista } = this.#p;
    if (this.#erroLista || (!this.#carregando && !this.#itens.length)) {
      trocarTexto(lista, this.#erroLista || "Nenhum vídeo encontrado.");
      return;
    }
    if (this.#carregando && !this.#itens.length) {
      trocarTexto(lista, "Abrindo a biblioteca…");
      return;
    }
    sincronizar(
      lista,
      this.#itens.map((i) => ({
        chave: i.id,
        sig: `${i.id}|${i.id === item?.id}`,
        criar: () =>
          el("li", {}, [
            el("button.cinema__item", { type: "button", "aria-current": i.id === item?.id ? "true" : null, onClick: () => this.l.escolher(i) }, [
              icon(i.id === item?.id ? "play" : "clapperboard", { size: "sm" }),
              el("span.truncate", { text: i.nome }),
              el("span.muted", { text: i.segundos ? mmss(i.segundos) : "" }),
            ]),
          ]),
      })),
    );
  }

  /* ------------------- o player segue a sala ------------------- */

  async #seguirSala(item, t) {
    const { video } = this.#p;
    if (this.#fonte !== item.id) {
      if (this.#trocandoFonte === item.id) return;
      this.#trocandoFonte = item.id;
      this.#erroVideo = "";
      this.#barrado = false;
      try {
        const src = await this.l.enderecoDoVideo(item.id);
        if (this.l.item()?.id !== item.id || !this.#p.raiz) return;
        this.#fonte = item.id;
        video.src = src;
      } catch (err) {
        this.#erroVideo = err.message || "Não deu para abrir o vídeo.";
      } finally {
        if (this.#trocandoFonte === item.id) this.#trocandoFonte = null;
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

  #soltarFonte() {
    const { video } = this.#p;
    this.#fonte = "";
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
      if (codigo !== 4 && this.#fonte && this.#tentativas < 3) {
        this.#tentativas += 1;
        const id = this.#fonte;
        this.#fonte = "";
        // Ficha vencida ou rede que piscou: pede outra ficha e retoma.
        this.l.enderecoDoVideo(id, { nova: true }).catch(() => {});
      }
      this.desenhar();
    });
  }
}

function trocarTexto(lista, texto) {
  sincronizar(lista, [{ chave: "nada", sig: texto, criar: () => el("li.cinema__nada.muted", { text: texto }) }]);
}
