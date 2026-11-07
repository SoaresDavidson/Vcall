/**
 * features/host.js — o painel de quem hospeda, no aplicativo de mesa.
 *
 * Só existe quando a página foi aberta pelo executável do Vcall. No navegador
 * comum, `disponivel` é falso e nada disto aparece — o app web continua sendo
 * exatamente o que era.
 *
 * O segredo chega uma única vez, no endereço que o executável abre
 * (`?host=...`), e é imediatamente tirado da barra de endereços e guardado em
 * `sessionStorage`. Duas razões para não deixá-lo na URL: ela é copiada por
 * engano com facilidade — é justamente o que se faz nesta tela, copiar
 * endereços — e fica no histórico do navegador. Em `sessionStorage` ele morre
 * quando a aba fecha, que é exatamente o tempo de vida do servidor.
 */
import { Emitter } from "../lib/emitter.js";

const CHAVE = "vcall:host-token";

function capturarToken() {
  const url = new URL(location.href);
  const vindo = url.searchParams.get("host");
  if (vindo) {
    try {
      sessionStorage.setItem(CHAVE, vindo);
    } catch {
      /* sessão sem armazenamento: o token vale só para esta carga da página */
    }
    url.searchParams.delete("host");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return vindo;
  }
  try {
    return sessionStorage.getItem(CHAVE);
  } catch {
    return null;
  }
}

export class HostPanel extends Emitter {
  token = capturarToken();
  estado = "parado";
  url = null;
  /** Link pela rede Tailscale: {estado, url, habilitar, erro} e o que o app sabe dela. */
  ts = { estado: "parado", url: null, habilitar: null, erro: null };
  /** Resultado de "tailscale/conferir": instalado? conectado? por que não? */
  tsConferido = null;

  /** Período entre batimentos; o servidor informa no aperto de mão. */
  batimentoMs = 4000;
  #batida = 0;

  /** Estamos rodando dentro do executável? */
  get disponivel() {
    return !!this.token;
  }

  /**
   * Avisa o aplicativo, a cada poucos segundos, que a janela continua aberta.
   *
   * É o que permite ao executável se desligar sozinho quando a pessoa fecha a
   * janela. Sem isso o servidor ficava rodando para sempre, e — pior — com o
   * túnel no ar: o endereço público continuava aceitando quem tivesse o link,
   * depois de a pessoa achar que tinha fechado tudo.
   *
   * O aviso de saída usa `sendBeacon`, e não `fetch`: ao fechar a aba o
   * navegador cancela requisições pendentes, e um `fetch` disparado nesse
   * instante quase nunca chega. O beacon é entregue pelo navegador depois,
   * justamente para este caso.
   */
  manterVivo() {
    if (!this.token || this.#batida) return;

    const bater = () => {
      // `keepalive` para o aviso sobreviver a uma navegação no meio do caminho.
      fetch("/__host/vivo", { cache: "no-store", keepalive: true }).catch(() => {});
    };
    bater();
    this.#batida = setInterval(bater, this.batimentoMs);

    const despedir = () => {
      clearInterval(this.#batida);
      this.#batida = 0;
      try {
        navigator.sendBeacon("/__host/tchau");
      } catch {
        /* sem beacon: o silêncio do batimento resolve em alguns segundos */
      }
    };

    // `pagehide` é o único que dispara de forma confiável ao fechar a janela;
    // `beforeunload` não vale em celular e `unload` foi descontinuado.
    addEventListener("pagehide", (e) => {
      // Uma página que vai para o cache de voltar/avançar não fechou de fato.
      if (!e.persisted) despedir();
    });
  }

  /**
   * Descobre o token perguntando ao servidor local, quando ele não veio na URL.
   *
   * Uma janela pode ser aberta por caminhos que não passam o token: um link
   * `vcall://`, um recarregar depois da sessão ser limpa, um endereço digitado
   * à mão. Nesses casos o painel do túnel sumia do "Convidar" sem explicação —
   * a pessoa via o botão num dia e não via no outro.
   *
   * A pergunta só é respondida para quem está na própria máquina; de fora, o
   * servidor responde 404 e este método simplesmente conclui que não é o app.
   */
  async descobrir() {
    if (this.token) return true;
    try {
      const res = await fetch("/__host/hello", { cache: "no-store" });
      if (!res.ok) return false;
      const corpo = await res.json();
      if (!corpo?.app || !corpo?.token) return false;
      this.token = corpo.token;
      this.batimentoMs = corpo.batimento || 4000;
      try {
        sessionStorage.setItem(CHAVE, corpo.token);
      } catch {
        /* vale para esta carga da página */
      }
      this.emit("disponivel", true);
      this.manterVivo();
      return true;
    } catch {
      // Servidor web comum: a rota não existe. É o caso normal fora do app.
      return false;
    }
  }

  async #chamar(acao, { params = null, ...opts } = {}) {
    if (!this.token) throw new Error("sem token de anfitrião");
    const busca = new URLSearchParams({ t: this.token, ...(params || {}) });
    const res = await fetch(`/__host/${acao}?${busca}`, {
      cache: "no-store",
      ...opts,
    });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(corpo.erro || `falha (${res.status})`);
    return corpo;
  }

  /** Nome e avatar de quem usa o app, para a lista da rede Tailscale. */
  perfil(nome, avatar) {
    const params = { nome: nome || "", estilo: avatar?.style || "", semente: avatar?.seed || "" };
    return this.#chamar("perfil", { params }).catch(() => {});
  }

  /** Link curto do convite público, ou null (fica o do túnel). */
  async encurtar(u) {
    try {
      return (await this.#chamar("encurtar", { params: { u } })).url || null;
    } catch {
      return null;
    }
  }

  async status() {
    const r = await this.#chamar("status");
    this.estado = r.estado;
    this.url = r.url;
    if (r.tailscale) this.ts = r.tailscale;
    this.emit("status", r);
    return r;
  }

  /* ---------------------------------------------------------------- *
   * Tailscale
   * ---------------------------------------------------------------- */

  /** O Tailscale está instalado e conectado aqui? Só olha, não muda nada. */
  async conferirTailscale() {
    try {
      this.tsConferido = await this.#chamar("tailscale/conferir");
    } catch {
      this.tsConferido = { instalado: false, pronto: false };
    }
    this.emit("tailscale", this.ts);
    return this.tsConferido;
  }

  /**
   * Publica a sala na rede Tailscale e devolve o link. Pode esperar a pessoa
   * ligar o HTTPS na página do Tailscale: enquanto isso o estado é
   * "habilitar", com o endereço da página em `ts.habilitar`.
   */
  async abrirTailscale() {
    this.ts = { ...this.ts, estado: "conferindo", erro: null };
    this.emit("tailscale", this.ts);
    const acompanhar = setInterval(() => {
      this.#chamar("status")
        .then((r) => {
          if (!r.tailscale || this.ts.estado === "pronto") return;
          if (r.tailscale.estado !== this.ts.estado || r.tailscale.habilitar !== this.ts.habilitar) {
            this.ts = r.tailscale;
            this.emit("tailscale", this.ts);
          }
        })
        .catch(() => {});
    }, 1500);
    try {
      const r = await this.#chamar("tailscale/abrir").finally(() => clearInterval(acompanhar));
      this.ts = { estado: r.estado, url: r.url, habilitar: r.habilitar || null, erro: null };
      this.emit("tailscale", this.ts);
      return r.url;
    } catch (err) {
      this.ts = { estado: "erro", url: null, habilitar: null, erro: err.message };
      this.emit("tailscale", this.ts);
      throw err;
    }
  }

  /** Abre, nesta janela do app, uma chamada de outro computador da rede. */
  async abrir(url) {
    return this.#chamar("abrir", { params: { u: url } });
  }

  /** "Deixar este computador disponível na rede Tailscale": ler ou mudar. */
  async configRede(sempre) {
    return this.#chamar("rede/config", { params: sempre == null ? null : { sempre: sempre ? "1" : "0" } });
  }

  /** Codificador da transmissão (Configurações › Transmissão): sem argumento só lê. */
  async configCodificador(config = null) {
    return this.#chamar("codificador/config", { params: config });
  }

  /** Reabre o app (as opções do Chromium só valem ao abrir). */
  async reiniciar() {
    return this.#chamar("app/reiniciar");
  }

  /** Servidor TURN do app: sem argumento só lê; com `config`, salva. */
  async configTurn(config = null) {
    return this.#chamar("turn/config", { params: config });
  }

  async fecharTailscale() {
    await this.#chamar("tailscale/fechar").catch(() => {});
    this.ts = { estado: "parado", url: null, habilitar: null, erro: null };
    this.emit("tailscale", this.ts);
  }

  /** O endereço da sala pelo Tailscale (mesma ideia do `linkPublico`). */
  linkTailscale(linkLocal) {
    return this.ts.url ? trocarOrigem(linkLocal, this.ts.url) : null;
  }

  /**
   * Liga o túnel e devolve o endereço público. Pode demorar: na primeira vez
   * o cloudflared ainda é baixado.
   */
  async abrirTunel({ novo = false } = {}) {
    this.estado = "abrindo";
    this.emit("status", { estado: this.estado, url: null });
    // Enquanto o pedido corre (baixar, abrir, testar o link: pode passar de
    // meio minuto), o painel acompanha a fase em vez de ficar em "Abrindo…".
    const fase = setInterval(() => {
      this.#chamar("status")
        .then((r) => {
          // "erro" aqui é só a troca entre a primeira e a segunda tentativa.
          if (this.estado === "pronto" || ["pronto", "parado", "erro"].includes(r.estado)) return;
          if (r.estado !== this.estado) {
            this.estado = r.estado;
            this.emit("status", { estado: r.estado, url: null });
          }
        })
        .catch(() => {});
    }, 1500);
    try {
      // "renovar" derruba o túnel atual e sobe outro (link novo, mesma chamada).
      const r = await this.#chamar(novo ? "tunnel/renovar" : "tunnel/abrir").finally(() => clearInterval(fase));
      this.estado = r.estado;
      this.url = r.url;
      this.emit("status", r);
      return r.url;
    } catch (err) {
      this.estado = "erro";
      this.emit("status", { estado: "erro", erro: err.message });
      throw err;
    }
  }

  /**
   * Existe versão nova publicada no GitHub?
   *
   * Quem confere é o executável, não a página: a página está dentro de um
   * navegador e uma consulta a github.com daqui esbarraria na política de
   * origem. E mais importante — a resposta diz qual versão esta máquina está
   * rodando, então ela passa pelo caminho com token, que só responde a quem
   * está na própria máquina.
   */
  async atualizacao({ forcar = false } = {}) {
    return this.#chamar("atualizacao", { params: forcar ? { forcar: "1" } : null });
  }

  async fecharTunel() {
    const r = await this.#chamar("tunnel/fechar");
    this.estado = r.estado;
    this.url = null;
    this.emit("status", r);
    return r;
  }

  /**
   * O link `vcall://` que abre a sala no aplicativo de quem receber.
   *
   * Ele carrega o ENDEREÇO COMPLETO do servidor, não só o id da sala. Um
   * `vcall://ID` sozinho não funcionaria: a sala existe na máquina de quem
   * hospeda, e o aplicativo de quem recebe abriria o servidor local dele —
   * criando uma sala vazia de mesmo nome, em que ninguém se encontra.
   *
   * Sem túnel aberto, o endereço é o da rede local e o link só vale para quem
   * está na mesma rede. É a mesma limitação do link comum, e por isso a
   * interface mostra os dois lado a lado.
   */
  linkDoApp(linkDaSala) {
    const base = this.linkPublico(linkDaSala) || this.linkTailscale(linkDaSala) || linkDaSala;
    if (!base) return null;
    return `vcall://join?u=${encodeURIComponent(base)}`;
  }

  /**
   * Converte o endereço local da sala no endereço público equivalente.
   * O id da sala vive no fragmento, que o túnel não toca — só a origem muda.
   */
  linkPublico(linkLocal) {
    return this.url ? trocarOrigem(linkLocal, this.url) : null;
  }
}

/** O mesmo caminho e o mesmo fragmento (a sala), noutra origem. */
function trocarOrigem(linkLocal, origem) {
  try {
    const local = new URL(linkLocal);
    const novo = new URL(origem);
    novo.pathname = local.pathname;
    novo.hash = local.hash;
    return novo.toString();
  } catch {
    return null;
  }
}
