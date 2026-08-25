/**
 * Limitador de tentativas — sem dependência externa e sem estado global, para
 * poder ser testado sozinho.
 *
 * Duas peças com propósitos diferentes:
 *
 *   AttemptLimiter  conta FALHAS e castiga com trava que dobra. É o porteiro
 *                   do login: quem erra a senha várias vezes fica de fora por
 *                   um tempo que cresce, o que torna força bruta inviável sem
 *                   punir quem só errou de dedo uma vez.
 *
 *   RequestLimiter  conta CHAMADAS em janela fixa. É o teto geral da API —
 *                   protege contra um laço maluco no navegador ou um script
 *                   que resolveu varrer as rotas.
 *
 * O tempo entra por parâmetro (`now`) de propósito: teste de limite que
 * depende do relógio de verdade é teste que dorme e falha sozinho.
 */

export interface AttemptLimiterOptions {
  /** falhas toleradas dentro da janela antes da primeira trava */
  maxAttempts: number;
  /** janela que esquece falhas antigas (ms) */
  windowMs: number;
  /** duração da primeira trava (ms) */
  baseLockMs: number;
  /** teto da trava, por mais que ela dobre (ms) */
  maxLockMs: number;
}

export interface AttemptVerdict {
  allowed: boolean;
  /** quanto falta da trava, em segundos inteiros (0 quando liberado) */
  retryAfterSeconds: number;
  /** quantas falhas ainda cabem antes de travar */
  remainingAttempts: number;
}

interface AttemptState {
  failures: number[];
  lockedUntil: number;
  /** quantas vezes já travou — é o que faz o castigo dobrar */
  lockLevel: number;
}

export const DEFAULT_LOGIN_LIMITS: AttemptLimiterOptions = {
  maxAttempts: 5,
  windowMs: 15 * 60_000,
  baseLockMs: 60_000,
  maxLockMs: 30 * 60_000,
};

export class AttemptLimiter {
  private readonly options: AttemptLimiterOptions;
  private readonly states = new Map<string, AttemptState>();

  constructor(options: AttemptLimiterOptions = DEFAULT_LOGIN_LIMITS) {
    this.options = options;
  }

  /** Pergunta se a chave pode tentar agora. Não consome nada. */
  check(key: string, now: number = Date.now()): AttemptVerdict {
    const state = this.states.get(key);
    if (!state) {
      return { allowed: true, retryAfterSeconds: 0, remainingAttempts: this.options.maxAttempts };
    }
    if (state.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
        remainingAttempts: 0,
      };
    }
    const recent = this.recentFailures(state, now);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remainingAttempts: Math.max(0, this.options.maxAttempts - recent.length),
    };
  }

  /** Registra uma falha e devolve o veredito JÁ com a trava aplicada, se coube. */
  registerFailure(key: string, now: number = Date.now()): AttemptVerdict {
    const state = this.states.get(key) ?? { failures: [], lockedUntil: 0, lockLevel: 0 };
    state.failures = this.recentFailures(state, now);
    state.failures.push(now);

    if (state.failures.length >= this.options.maxAttempts) {
      state.lockLevel += 1;
      const punishment = Math.min(
        this.options.baseLockMs * 2 ** (state.lockLevel - 1),
        this.options.maxLockMs,
      );
      state.lockedUntil = now + punishment;
      // a contagem zera junto com a trava: senão a próxima falha isolada,
      // logo depois de sair do castigo, travaria de novo na hora
      state.failures = [];
    }

    this.states.set(key, state);
    return this.check(key, now);
  }

  /** Acerto apaga o histórico — quem entrou não carrega suspeita adiante. */
  registerSuccess(key: string): void {
    this.states.delete(key);
  }

  /** Descarta chaves frias para a memória não crescer com IP de passagem. */
  sweep(now: number = Date.now()): void {
    for (const [key, state] of this.states) {
      const cold =
        state.lockedUntil <= now && this.recentFailures(state, now).length === 0;
      if (cold) this.states.delete(key);
    }
  }

  size(): number {
    return this.states.size;
  }

  private recentFailures(state: AttemptState, now: number): number[] {
    const floor = now - this.options.windowMs;
    return state.failures.filter((stamp) => stamp > floor);
  }
}

export interface RequestLimiterOptions {
  /** chamadas permitidas por janela */
  max: number;
  windowMs: number;
}

export interface RequestVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/** Teto geral por origem, em janela fixa. */
export class RequestLimiter {
  private readonly options: RequestLimiterOptions;
  private readonly windows = new Map<string, WindowState>();

  constructor(options: RequestLimiterOptions) {
    this.options = options;
  }

  consume(key: string, now: number = Date.now()): RequestVerdict {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + this.options.windowMs };
      this.windows.set(key, fresh);
      return { allowed: true, remaining: this.options.max - 1, retryAfterSeconds: 0 };
    }
    current.count += 1;
    if (current.count > this.options.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
      };
    }
    return {
      allowed: true,
      remaining: this.options.max - current.count,
      retryAfterSeconds: 0,
    };
  }

  sweep(now: number = Date.now()): void {
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }

  size(): number {
    return this.windows.size;
  }
}
