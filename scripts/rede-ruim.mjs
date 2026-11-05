/**
 * scripts/rede-ruim.mjs — uma conexão de internet ruim, de mentira, para medir vídeo.
 *
 * Um proxy UDP na frente de um TURN (coturn). Cada participante do teste fala
 * com o TURN por uma porta própria deste proxy, e cada sentido (subida e
 * descida) passa por um "enlace" com:
 *
 *   kbps     banda: os pacotes saem um atrás do outro, no ritmo do enlace;
 *   filaMs   tamanho da fila do roteador: o que passar disso é descartado
 *            (é assim que banda de menos vira perda e atraso na vida real);
 *   atrasoMs atraso de ida, e jitterMs de variação (sem desordenar);
 *   perda    fração de pacotes perdidos ao acaso (0.02 = 2%).
 *
 * Com `iceTransportPolicy: "relay"` toda a mídia passa por aqui — o mesmo
 * caminho de quem está atrás de CGNAT e cai no TURN. Sem tc/netem: roda em
 * qualquer máquina, sem privilégio.
 */
import dgram from "node:dgram";

/** Um sentido do enlace. `enviar(buf)` entrega do outro lado no tempo certo. */
export function enlace({ kbps = 0, filaMs = 300, atrasoMs = 0, jitterMs = 0, perda = 0 } = {}, enviar) {
  let livreEm = 0; // quando o "fio" termina de transmitir o último pacote
  let ultimaEntrega = 0;
  const cont = { recebidos: 0, perdidos: 0, descartadosFila: 0, bytes: 0 };
  return {
    cont,
    passar(buf) {
      cont.recebidos += 1;
      const agora = performance.now();
      if (perda && Math.random() < perda) {
        cont.perdidos += 1;
        return;
      }
      let sai = agora;
      if (kbps) {
        const inicio = Math.max(agora, livreEm);
        if (inicio - agora > filaMs) {
          cont.descartadosFila += 1;
          return;
        }
        livreEm = inicio + (buf.length * 8) / kbps; // kbps = bits por ms
        sai = livreEm;
      }
      let entrega = sai + atrasoMs + (jitterMs ? Math.random() * jitterMs : 0);
      entrega = Math.max(entrega, ultimaEntrega); // sem desordenar
      ultimaEntrega = entrega;
      cont.bytes += buf.length;
      const espera = entrega - agora;
      if (espera < 0.5) enviar(buf);
      else setTimeout(() => enviar(buf), espera);
    },
  };
}

/**
 * Uma porta do proxy, para um participante. `subida`: do participante ao TURN;
 * `descida`: do TURN ao participante.
 */
export function abrirPorta({ porta, turn = { host: "127.0.0.1", porta: 3478 }, subida = {}, descida = {} }) {
  const local = dgram.createSocket("udp4");
  const clientes = new Map(); // "ip:porta" do participante -> socket para o TURN
  const enlaces = [];
  local.on("message", (buf, rinfo) => {
    const chave = `${rinfo.address}:${rinfo.port}`;
    let c = clientes.get(chave);
    if (!c) {
      const sock = dgram.createSocket("udp4");
      const ida = enlace(subida, (b) => sock.send(b, turn.porta, turn.host));
      const volta = enlace(descida, (b) => local.send(b, rinfo.port, rinfo.address));
      sock.on("message", (b) => volta.passar(b));
      sock.bind(0, "127.0.0.1");
      c = { sock, ida, volta };
      clientes.set(chave, c);
      enlaces.push({ ida: ida.cont, volta: volta.cont });
    }
    c.ida.passar(buf);
  });
  return new Promise((resolve) => {
    local.bind(porta, "127.0.0.1", () =>
      resolve({
        porta,
        contadores: () => enlaces,
        fechar: () => {
          for (const c of clientes.values()) c.sock.close();
          local.close();
        },
      }),
    );
  });
}

/** Perfis de conexão usados no banco de vídeo (subida = descida, como a maioria dos testes). */
export const REDES = {
  fibra: { kbps: 50_000, filaMs: 100, atrasoMs: 5, jitterMs: 2, perda: 0 },
  casa: { kbps: 6_000, filaMs: 250, atrasoMs: 25, jitterMs: 10, perda: 0.01 },
  "4g": { kbps: 2_500, filaMs: 400, atrasoMs: 50, jitterMs: 30, perda: 0.02 },
  ruim: { kbps: 1_000, filaMs: 500, atrasoMs: 90, jitterMs: 40, perda: 0.04 },
};
