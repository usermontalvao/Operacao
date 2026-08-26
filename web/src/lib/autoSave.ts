import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Salvar sozinho, sem perder o que a pessoa está digitando.
 *
 * A tela de ajustes tinha os dois comportamentos ao mesmo tempo: interruptores
 * que gravavam no clique e formulários com botão "Salvar". Quem trocasse um
 * número e saísse da tela perdia a mudança sem aviso — e não havia como saber
 * qual dos dois modelos valia para o campo em que se estava mexendo.
 *
 * Este gancho resolve com três cuidados que a versão ingênua não teria:
 *
 *  1. O ESTADO LOCAL MUDA NA HORA. Digitar não pode esperar rede: o campo
 *     responde imediatamente e o envio acontece depois.
 *  2. O ENVIO ESPERA A PESSOA PARAR. Sem isso, digitar "1500" mandaria quatro
 *     requisições — e a de "1" seria salva primeiro, com o valor errado
 *     visível por um instante.
 *  3. RESPOSTA DO SERVIDOR NÃO PISA EM EDIÇÃO EM CURSO. Enquanto houver
 *     alteração pendente, a releitura de fundo é ignorada. Sem esta trava, o
 *     recarregamento que vem depois de salvar apagaria o número que a pessoa
 *     começou a digitar enquanto o salvamento ia e voltava.
 */

export type EstadoAutoSave = 'parado' | 'pendente' | 'salvando' | 'salvo' | 'erro';

const ESPERA_MS = 700;

export interface AutoSave<T> {
  /** o valor que a tela desenha — sempre o mais recente que a pessoa digitou */
  valor: T | null;
  /** aplica uma mudança e agenda o salvamento */
  alterar: (patch: Partial<T>) => void;
  estado: EstadoAutoSave;
  erro: string | null;
  /** true enquanto houver mudança local ainda não confirmada pelo servidor */
  sujo: boolean;
}

export function useAutoSave<T extends object>(input: {
  /** o valor vindo do servidor */
  remoto: T | null;
  /** marca que muda quando o servidor grava — dispara a ressemeadura */
  versao: string | undefined;
  salvar: (valor: T) => Promise<unknown>;
  /** avisa o resto do app que algo mudou */
  aoSalvar?: () => void;
}): AutoSave<T> {
  const { remoto, versao, salvar, aoSalvar } = input;
  const [valor, setValor] = useState<T | null>(remoto);
  const [estado, setEstado] = useState<EstadoAutoSave>('parado');
  const [erro, setErro] = useState<string | null>(null);

  const sujo = useRef(false);
  const semeadoDe = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /*
   * O salvar mais recente, guardado numa referência.
   *
   * O temporizador é armado dentro de `alterar`, que é memorizado. Sem esta
   * indireção, ele dispararia com a versão de `salvar` que existia quando o
   * gancho foi criado — e continuaria mandando para o destino antigo depois
   * de a tela trocar de conta ou de modalidade.
   */
  const salvarRef = useRef(salvar);
  salvarRef.current = salvar;
  const aoSalvarRef = useRef(aoSalvar);
  aoSalvarRef.current = aoSalvar;

  useEffect(() => {
    if (remoto === null) return;
    // edição em curso tem prioridade sobre o que o servidor devolveu
    if (sujo.current) return;
    if (semeadoDe.current === versao) return;
    semeadoDe.current = versao;
    setValor(remoto);
  }, [remoto, versao]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const alterar = useCallback((patch: Partial<T>) => {
    setValor((anterior) => {
      if (anterior === null) return anterior;
      const proximo = { ...anterior, ...patch };
      sujo.current = true;
      setEstado('pendente');
      setErro(null);

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setEstado('salvando');
        void salvarRef
          .current(proximo)
          .then(() => {
            sujo.current = false;
            setEstado('salvo');
            aoSalvarRef.current?.();
          })
          .catch((falha: Error) => {
            /*
             * `sujo` continua true depois de falhar, e isso é proposital: o
             * valor local ainda não existe no servidor. Limpar aqui deixaria a
             * próxima releitura sobrescrever a edição — a pessoa veria o
             * número voltar sozinho ao antigo, sem entender que o salvamento
             * tinha falhado.
             */
            setEstado('erro');
            setErro(falha.message);
          });
      }, ESPERA_MS);

      return proximo;
    });
  }, []);

  return { valor, alterar, estado, erro, sujo: sujo.current };
}

export function rotuloDoEstado(estado: EstadoAutoSave): string | null {
  if (estado === 'pendente') return 'alterado…';
  if (estado === 'salvando') return 'salvando…';
  if (estado === 'salvo') return 'salvo';
  if (estado === 'erro') return 'falhou';
  return null;
}
