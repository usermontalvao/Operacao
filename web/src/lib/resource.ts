import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Cache de tela, com revalidação em segundo plano.
 *
 * Cada aba do painel é montada do zero quando entra e destruída quando sai —
 * então voltar para uma aba já visitada refazia todas as chamadas e mostrava
 * tela vazia (ou "Carregando…") por algumas centenas de milissegundos, toda
 * vez. Em uma tela que se troca dezenas de vezes por sessão, isso é a
 * diferença entre parecer um aplicativo e parecer um site lento.
 *
 * Aqui o dado da última visita fica guardado fora do React. Ao voltar, ele
 * aparece no mesmo quadro em que a aba abre, e a busca por dados novos corre
 * atrás sem apagar o que está na tela. Continua sendo sempre uma leitura
 * fresca do servidor: o que muda é que ela não é mais um pré-requisito para
 * desenhar.
 *
 * `stale` diz que existe uma leitura em curso — serve para a tela mostrar um
 * sinal discreto de atualização, nunca para esconder o conteúdo.
 */

interface Entrada {
  valor: unknown;
  gravadoEm: number;
}

const guardados = new Map<string, Entrada>();
const emVoo = new Map<string, Promise<unknown>>();

/** Quanto tempo o valor guardado ainda serve para pintar a tela na volta. */
const VALIDADE_MS = 5 * 60_000;

export function lerCache<T>(chave: string): T | null {
  const entrada = guardados.get(chave);
  if (!entrada) return null;
  if (Date.now() - entrada.gravadoEm > VALIDADE_MS) {
    guardados.delete(chave);
    return null;
  }
  return entrada.valor as T;
}

/**
 * Busca com fila única por chave: dois pedidos simultâneos da mesma coisa
 * viram um só. É o que faz o StrictMode (que monta tudo duas vezes em
 * desenvolvimento) e o "passar o mouse e clicar" não gerarem chamadas
 * repetidas.
 */
export async function buscar<T>(chave: string, buscador: () => Promise<T>): Promise<T> {
  const jaEmVoo = emVoo.get(chave);
  if (jaEmVoo) return jaEmVoo as Promise<T>;

  const promessa = buscador()
    .then((valor) => {
      guardados.set(chave, { valor, gravadoEm: Date.now() });
      return valor;
    })
    .finally(() => emVoo.delete(chave));

  emVoo.set(chave, promessa);
  return promessa;
}

/** Adianta a busca sem montar nada — usado ao passar o mouse pela aba. */
export function adiantar<T>(chave: string, buscador: () => Promise<T>): void {
  if (lerCache<T>(chave) !== null || emVoo.has(chave)) return;
  void buscar(chave, buscador).catch(() => undefined);
}

/** Joga fora o que está guardado. Usado quando a conta ou a sessão trocam. */
export function esquecerTudo(): void {
  guardados.clear();
  emVoo.clear();
}

export interface Recurso<T> {
  dados: T | null;
  erro: string | null;
  /** true enquanto há leitura em curso (com ou sem dado na tela) */
  stale: boolean;
  /** true só na primeira vez, quando não há nada para mostrar ainda */
  primeiraVez: boolean;
  recarregar: () => Promise<void>;
}

export function useResource<T>(
  chave: string,
  buscador: () => Promise<T>,
  opcoes: { intervaloMs?: number } = {},
): Recurso<T> {
  const { intervaloMs } = opcoes;

  // o buscador é recriado a cada render; guardá-lo numa ref evita que a
  // identidade dele reinicie o efeito a cada quadro
  const buscadorRef = useRef(buscador);
  buscadorRef.current = buscador;

  const [dados, setDados] = useState<T | null>(() => lerCache<T>(chave));
  const [erro, setErro] = useState<string | null>(null);
  const [stale, setStale] = useState(true);

  const recarregar = useCallback(async (): Promise<void> => {
    setStale(true);
    try {
      const valor = await buscar(chave, () => buscadorRef.current());
      setDados(valor);
      setErro(null);
    } catch (falha) {
      setErro((falha as Error).message);
    } finally {
      setStale(false);
    }
  }, [chave]);

  useEffect(() => {
    // trocar de chave (outro período, por exemplo) mostra o que já foi visto
    // daquela chave antes de sair buscando
    setDados(lerCache<T>(chave));
    let vivo = true;

    const rodar = async (): Promise<void> => {
      if (!vivo) return;
      await recarregar();
    };
    void rodar();

    if (!intervaloMs) return () => { vivo = false; };
    const timer = window.setInterval(() => void rodar(), intervaloMs);
    return () => {
      vivo = false;
      window.clearInterval(timer);
    };
  }, [chave, intervaloMs, recarregar]);

  return { dados, erro, stale, primeiraVez: dados === null && stale, recarregar };
}
