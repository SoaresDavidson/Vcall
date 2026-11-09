/**
 * src/config.js — configuração central, lida do ambiente uma única vez.
 */
import process from "node:process";
import { loadEnv } from "./env.js";

// Antes de qualquer leitura de process.env. Como este módulo é o primeiro que
// consulta o ambiente, chamar aqui garante a ordem certa qualquer que seja o
// ponto de entrada.
export const envFile = loadEnv();

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = Object.freeze({
  /** Pasta de vídeos do "Assistir junto" (src/cinema-pasta.js; o app de mesa pode trocá-la). */
  pastaVideos: process.env.PASTA_VIDEOS || "",

  port: int(process.env.PORT, 3000),
  /**
   * Vazio de propósito. Sem host, o Node escuta no endereço não especificado
   * IPv6 (`::`) em modo duplo, atendendo IPv4 e IPv6 ao mesmo tempo.
   *
   * Fixar "0.0.0.0" — que parece o mais abrangente — escuta SÓ em IPv4. No
   * Windows, `localhost` resolve primeiro para o IPv6 `::1`, a conexão é
   * recusada, e o navegador mostra "a página não funciona" mesmo com o
   * servidor rodando normalmente. Defina HOST só se souber que precisa.
   */
  host: process.env.HOST || undefined,

  /**
   * Máximo de participantes por sala.
   *
   * O custo de uma malha ponto a ponto é quadrático: com N pessoas, cada
   * máquina mantém N-1 conexões e codifica o próprio vídeo uma vez para cada
   * uma. O teto foi de 8 para 16 porque o app já reduz sozinho a qualidade
   * conforme a sala enche (ver core/tuning.js): acima de 8 pessoas a câmera
   * cai para resolução e taxa de quadros menores, o que mantém a conta de
   * codificação parecida com a de uma sala pequena em alta qualidade.
   *
   * Acima de 16 a malha deixa de ser honesta — precisaria de um servidor de
   * mídia no meio, e aí a conversa pararia de ser criptografada ponta a ponta.
   * Quem quiser tentar assim mesmo pode subir MAX_PEERS; o limite duro existe
   * para que a sala não fique inutilizável para todo mundo por causa de uma
   * máquina fraca.
   */
  maxPeersPerRoom: Math.min(int(process.env.MAX_PEERS, 16), 32),

  /** Limites de payload — o servidor só repassa sinalização, nunca mídia. */
  limits: Object.freeze({
    wsPayload: int(process.env.MAX_WS_PAYLOAD, 256 * 1024),
    displayName: 32,
    chatMessage: 2000,
    avatarSpec: 512,
    /** Foto de avatar em data URL (≈48 kB de imagem viram ~64 kB em base64). */
    avatarPhoto: int(process.env.MAX_AVATAR_PHOTO, 96 * 1024),
    roomId: 64,
    /**
     * Mensagens por janela, por conexão. Subiu junto com as legendas ao vivo
     * e o canvas: um traço longo somado a uma fala contínua passava dos 90
     * antigos com facilidade, e o excedente agora é descartado em vez de
     * derrubar a conexão.
     */
    rateBurst: int(process.env.RATE_BURST, 240),
    rateWindowMs: int(process.env.RATE_WINDOW_MS, 10_000),
    /** Sockets simultâneos por endereço. Uma pessoa abre 2 ou 3 abas, não 40. */
    maxSocketsPerIp: int(process.env.MAX_SOCKETS_PER_IP, 24),
  }),

  /**
   * Origens aceitas no WebSocket, separadas por vírgula. Vazio (padrão) aceita
   * apenas a origem que serviu a página — o que já cobre localhost, rede local
   * e túnel sem precisar configurar nada.
   */
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** Ping/pong de keep-alive do WebSocket. */
  heartbeatMs: int(process.env.HEARTBEAT_MS, 25_000),

  /**
   * STUN resolve a maioria das redes domésticas. Redes corporativas, CGNAT e
   * algumas operadoras móveis exigem TURN — sem ele a chamada simplesmente não
   * conecta. Configure TURN_URLS (separados por vírgula), TURN_USER e TURN_PASS.
   */
  ice: Object.freeze({
    stun: (
      process.env.STUN_URLS ||
      "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    turnUrls: (process.env.TURN_URLS || process.env.TURN_URL || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    turnUser: process.env.TURN_USER || "",
    turnPass: process.env.TURN_PASS || "",

    /**
     * Segredo compartilhado do coturn (`use-auth-secret`). Quando presente, o
     * servidor gera um usuário e uma senha válidos por algumas horas, em vez de
     * publicar uma senha fixa. Isso importa: o /ice é público, então uma senha
     * estática ali vira um relay aberto para quem quiser usar a sua banda.
     */
    turnSecret: process.env.TURN_SECRET || "",

    /**
     * Cloudflare Realtime TURN: a chave de longo prazo fica no servidor e
     * troca-se por credenciais curtas a cada pedido.
     */
    cfKeyId: process.env.CF_TURN_KEY_ID || "",
    cfToken: process.env.CF_TURN_API_TOKEN || "",

    /**
     * Qualquer provedor que entregue `iceServers` por REST (Metered, Xirsys e
     * afins). A chave fica no servidor; o navegador recebe só o resultado.
     */
    apiUrl: process.env.TURN_API_URL || "",
    apiToken: process.env.TURN_API_TOKEN || "",
    apiMethod: (process.env.TURN_API_METHOD || "GET").toUpperCase() === "POST" ? "POST" : "GET",

    /** Validade das credenciais temporárias, em segundos. */
    ttl: int(process.env.TURN_TTL, 6 * 3600),

    /** "all" | "relay" — force "relay" para testar TURN de verdade. */
    transportPolicy: process.env.ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all",
  }),

  /**
   * "Assistir junto": o Jellyfin de quem hospeda (src/cinema-jellyfin.js). A chave
   * da API fica só no servidor; sem os dois, a função fica desligada.
   */
  jellyfin: Object.freeze({
    url: process.env.JELLYFIN_URL || "",
    key: process.env.JELLYFIN_KEY || "",
    /** Nome da única biblioteca que a sala enxerga. Vazio: todas (com aviso no log). */
    biblioteca: (process.env.JELLYFIN_BIBLIOTECA || "").trim(),
  }),

  /** Em produção atrás de um proxy TLS, deixe true para exigir HTTPS nos links. */
  trustProxy: process.env.TRUST_PROXY === "1",
  /**
   * Atrás do cloudflared rodando NA MESMA máquina: usar o CF-Connecting-IP
   * como endereço de quem conecta. Desligado por padrão — atrás de um nginx
   * local qualquer um poderia forjar esse cabeçalho. O app de mesa liga
   * sozinho (o túnel dele é o cloudflared).
   */
  trustCloudflare: process.env.TRUST_CLOUDFLARE === "1",
  /** Atrás de `tailscale serve` na mesma máquina: o IP da tailnet vem no X-Forwarded-For. */
  trustTailscale: process.env.TRUST_TAILSCALE === "1",

  dev: process.env.NODE_ENV !== "production",
});
