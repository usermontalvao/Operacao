import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { readCredentials, type EnvironmentEndpoints } from '../config.ts';

/** Uma chamada que não volta em 12 segundos não vai voltar. */
const TIMEOUT_MS = 12_000;

export class WsApiError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'WsApiError';
    this.code = code;
  }
}

/**
 * WebSocket API da Binance — o caminho da chave do fluxo de conta em SPOT.
 *
 * Não é preferência de estilo: `POST /api/v3/userDataStream` foi REMOVIDO. O
 * endereço responde `410 Gone` com uma página HTML do nginx — sem código de
 * erro, sem mensagem, nada que o tratamento de erro da corretora saiba ler. O
 * efeito era o pior possível: a abertura do fluxo falhava em silêncio a cada
 * tentativa, o painel ficava sem nenhum aviso de execução em tempo real, e a
 * ordem preenchida na Binance só aparecia na volta seguinte da reconciliação —
 * que, por achar que o fluxo estava de pé, ainda tinha afrouxado o ritmo.
 *
 * A conexão é curta de propósito: uma por chamada. São três chamadas por hora
 * (abrir, renovar, encerrar), então uma sessão permanente aqui seria mais um
 * socket para manter vivo, reconectar e vigiar, em troca de nada.
 *
 * `userDataStream.start` é do tipo USER_STREAM: leva a chave da API no corpo
 * e NÃO leva assinatura HMAC nem timestamp.
 */
export async function wsApiCall<T>(
  method: string,
  params: Record<string, unknown>,
  environment: EnvironmentEndpoints,
): Promise<T> {
  if (!environment.wsApiBase) {
    throw new WsApiError(`WebSocket API não configurada para ${environment.name}`, -1);
  }
  const credentials = readCredentials(environment.name);
  if (!credentials) {
    throw new WsApiError('Credenciais da Binance não configuradas no servidor', -2015);
  }

  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(environment.wsApiBase);
    let encerrado = false;
    const encerrar = (): void => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
    };
    const timer = setTimeout(() => {
      encerrar();
      reject(new WsApiError(`Sem resposta da WebSocket API em ${method}`, -1));
    }, TIMEOUT_MS);
    timer.unref?.();

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          // a Binance recusa o id que não casa com `^[a-zA-Z0-9-]{1,36}$`:
          // o nome do método tem ponto e derrubava a chamada com -1135
          id: randomUUID(),
          method,
          params: { apiKey: credentials.apiKey, ...params },
        }),
      );
    });

    socket.on('message', (data: WebSocket.RawData) => {
      let payload: { status?: number; result?: unknown; error?: { code?: number; msg?: string } };
      try {
        payload = JSON.parse(data.toString());
      } catch {
        encerrar();
        reject(new WsApiError('Resposta ilegível da WebSocket API', -1));
        return;
      }
      encerrar();
      if (payload.status === 200) {
        resolve(payload.result as T);
        return;
      }
      reject(
        new WsApiError(
          payload.error?.msg ?? `WebSocket API recusou ${method}`,
          payload.error?.code ?? -1,
        ),
      );
    });

    socket.on('error', (error: Error) => {
      encerrar();
      reject(new WsApiError(error.message, -1));
    });

    socket.on('close', () => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      reject(new WsApiError(`Conexão da WebSocket API caiu antes de responder ${method}`, -1));
    });
  });
}
