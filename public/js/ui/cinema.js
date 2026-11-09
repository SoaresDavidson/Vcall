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
  /** O fim do episódio está sendo tratado (evita avançar duas vezes). */
  #avancando = false;
  /** Legendas do vídeo atual, a escolha desta pessoa e de qual vídeo elas são. */
  #legendas = [];
  #legendasDe = "";
  #legendaEscolhida = null;
  /** O nome da última legenda escolhida: o próximo episódio já abre com ela. */
  #nomeLegenda = "";

  montar() {
    const { corpo, extra } = this.c;
    const video = el("video.cinema__video", { playsInline: true, controls: true, preload: "auto" });
    const entrar = botao("Entrar no vídeo", { icone: "play", tipo: "primary", classe: "cinema__entrar", onClick: () => this.#entrar() });
    entrar.hidden = true;
    const vazio = el("div.cinema__vazio");
    const aviso = el("div.cinema__aviso");
    const estado = el("p.cinema__estado", { role: "status" });
    const capa = el("div.cinema__capa");
    capa.hidden = true;
    const escolhaLegenda = el("select.input.jogos__select", { "aria-label": "Legenda (só para você)", onChange: () => this.#escolherLegenda(escolhaLegenda.value) });
    const legenda = el("label.cinema__legenda", { title: "A legenda é só sua: os outros não mudam" }, [icon("captions", { size: "sm" }), escolhaLegenda]);
    legenda.hidden = true;
    const palco = el("div.cinema__palco", {}, [el("div.cinema__tela", {}, [video, capa, entrar, vazio]), legenda, aviso, estado]);

    this.#biblioteca = new PainelBiblioteca(this.l, () => this.desenhar());
    const lado = this.#biblioteca.raiz;
    const parar = botao("Tirar o vídeo", { icone: "x", tipo: "ghost", classe: "jogos__chip", tip: "Tira o vídeo para todos", onClick: () => this.l.fechar() });

    const raiz = el("div.cinema", {}, [palco, lado]);
    corpo.append(raiz);
    extra.append(parar);
    Object.assign(this.#p, { raiz, video, entrar, vazio, aviso, estado, parar, capa, legenda, escolhaLegenda });

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
    this.#desenharCapa(item, t);
    this.#legendasPara(item);

    const quem = this.pessoas().find((x) => x.id === t.por);
    const nome = quem ? (quem.eu ? "você" : quem.nome) : "";
    p.estado.textContent = `${item.nome} · ${t.tocando ? "tocando" : "pausado"}${nome ? ` (por ${nome})` : ""} · ${mmss(this.l.posicaoAgora())}`;
    p.entrar.hidden = !(this.#barrado && t.tocando);
    if (this.#erroVideo) faixa(p.aviso, this.#erroVideo, [icon("info", { size: "sm" }), el("span", { text: this.#erroVideo })], "erro");
    else p.aviso.replaceChildren();

    this.#seguirSala(item, t);
  }

  /* ------------------- cartaz e sinopse, antes do play ------------------- */

  /** Enquanto ninguém deu play, o palco mostra o cartaz e a sinopse. */
  #desenharCapa(item, t) {
    const { capa } = this.#p;
    const mostrar = !t.tocando && t.pos === 0;
    capa.hidden = !mostrar;
    if (!mostrar) return;
    const src = item.img ? this.l.enderecoDaImagem(item) : "";
    const sig = `${item.fonte}:${item.id}|${src}`;
    if (capa.dataset.sig === sig) return;
    capa.dataset.sig = sig;
    capa.replaceChildren(
      ...[
        src ? el("img.cinema__capa-img", { src, alt: "", decoding: "async" }) : null,
        el("div.cinema__capa-texto", {}, [el("h3", { text: item.nome }), item.sin ? el("p", { text: item.sin }) : null]),
      ].filter(Boolean),
    );
  }

  /* ----------------------- legenda (só desta pessoa) ----------------------- */

  /** Troca as legendas quando o vídeo muda: busca as do novo e tira o <track> do antigo. */
  #legendasPara(item) {
    const chave = item ? `${item.fonte}:${item.id}` : "";
    if (this.#legendasDe === chave) return;
    this.#legendasDe = chave;
    this.#legendas = [];
    this.#legendaEscolhida = null;
    this.#mostrarLegenda();
    this.#desenharLegendas();
    if (!item) return;
    this.l
      .legendas(item)
      .then((lista) => {
        if (this.#legendasDe !== chave || !this.#p.raiz) return; // o vídeo já mudou
        this.#legendas = lista;
        const igual = lista.find((l) => l.nome === this.#nomeLegenda);
        this.#legendaEscolhida = igual ? igual.indice : null;
        this.#desenharLegendas();
        this.#mostrarLegenda();
      })
      .catch(() => {});
  }

  #desenharLegendas() {
    const { legenda, escolhaLegenda } = this.#p;
    legenda.hidden = !this.#legendas.length;
    escolhaLegenda.replaceChildren(el("option", { value: "", text: "Sem legenda" }), ...this.#legendas.map((l) => el("option", { value: String(l.indice), text: l.nome })));
    escolhaLegenda.value = this.#legendaEscolhida === null ? "" : String(this.#legendaEscolhida);
  }

  #escolherLegenda(valor) {
    const l = this.#legendas.find((x) => String(x.indice) === valor);
    this.#legendaEscolhida = l ? l.indice : null;
    this.#nomeLegenda = l ? l.nome : "";
    this.#mostrarLegenda();
  }

  /** Põe (ou tira) o <track> no player. WebVTT, vindo da própria sala. */
  #mostrarLegenda() {
    const { video } = this.#p;
    for (const t of video.querySelectorAll("track")) t.remove();
    const item = this.l.item();
    const l = this.#legendas.find((x) => x.indice === this.#legendaEscolhida);
    if (!l || !item) return;
    const src = this.l.enderecoDaLegenda(item, l.indice);
    if (!src) return;
    const faixa = el("track", { kind: "subtitles", label: l.nome, src, default: true });
    faixa.addEventListener("load", () => (faixa.track.mode = "showing"));
    video.append(faixa);
    faixa.track.mode = "showing";
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
    // O episódio acabou: o seguinte entra para todos (features/cinema.js cuida
    // da corrida entre quem termina quase junto). Sem seguinte, só pausa.
    this.ouvir(video, "ended", () => {
      const item = this.l.item();
      if (!item || `${item.fonte}:${item.id}` !== this.#noPlayer || !this.l.tempo().tocando || this.#avancando) return;
      this.#avancando = true;
      this.l
        .avancar({ ...item, seg: Math.round(video.duration) || item.seg })
        .catch(() => {})
        .finally(() => (this.#avancando = false));
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
