# Projeto Retorno Escalável

## Sistema multi-estratégia de cripto com risco de carteira

**Status:** especificação para implementação  
**Mercado inicial:** Binance Spot, pares cotados em USDT  
**Objetivo:** elevar o retorno líquido possível sem transformar aumento de exposição em risco de ruína  
**Princípio central:** exposição amplia uma vantagem existente; nunca cria vantagem por conta própria

---

## 1. Decisão executiva

O sistema atual não deve ser simplesmente configurado para comprar mais. Hoje ele já tem componentes valiosos — sizing pelo prejuízo no stop, custos nas duas pontas, replay pessimista, controles de exposição, diário de decisão e execução protegida —, mas ainda opera como uma estratégia automática principal, a `MOMENTUM_BURST`.

O novo projeto deve transformar o robô em um **portfólio de estratégias condicionado ao regime de mercado**. Ele examinará todas as oportunidades, estimará a expectativa líquida de cada uma, eliminará duplicidade e correlação excessiva e preencherá até cinco vagas sem ultrapassar o risco total da carteira.

A multiplicação pretendida virá da combinação de:

1. vantagem estatística comprovada em dados não usados na criação da regra;
2. mais de uma estratégia realmente independente;
3. maior aproveitamento das oportunidades válidas;
4. reinvestimento gradual dos lucros;
5. aumento de capital somente depois que o sistema provar capacidade;
6. redução dos custos fixos e operacionais.

Não farão parte do projeto:

- promessa de retorno diário ou mensal;
- martingale, preço médio infinito ou aumento da mão depois de perdas;
- alavancagem usada para compensar capital pequeno;
- entrada baseada apenas em score alto;
- ativação de estratégia porque ela teve um backtest bonito em uma única janela;
- colocação direta em LIVE antes dos testes e dos critérios de promoção.

## 2. A verdade econômica

O lucro líquido mensal do produto é:

```text
lucro líquido = lucro bruto das operações
              - corretagem
              - slippage
              - funding/juros, se futuramente houver derivativos
              - hospedagem e dados
              - tributos e custos administrativos aplicáveis
```

O retorno mínimo para apenas pagar a infraestrutura é:

```text
retorno de equilíbrio no mês = custo fixo mensal / capital operacional
```

Exemplo ilustrativo com hospedagem de **20 USDT por mês**:

| Capital operacional | Retorno mensal só para pagar 20 USDT |
|---:|---:|
| 100 USDT | 20,0% |
| 250 USDT | 8,0% |
| 500 USDT | 4,0% |
| 1.000 USDT | 2,0% |
| 2.000 USDT | 1,0% |
| 5.000 USDT | 0,4% |

O sentido inverso também deve aparecer no painel:

| Retorno líquido hipotético | Capital necessário para cobrir 20 USDT |
|---:|---:|
| 2% ao mês | 1.000 USDT |
| 3% ao mês | 667 USDT |
| 5% ao mês | 400 USDT |
| 8% ao mês | 250 USDT |
| 10% ao mês | 200 USDT |

Esses números não são previsão de lucro. Eles mostram que, com 100 USDT, o problema de pagar 20 USDT de servidor não é resolvido de forma saudável aumentando a mão: o robô precisaria produzir 20% líquidos todos os meses apenas para empatar.

A antiga meta de 1% ao dia sobre todo o capital equivale a aproximadamente **34,8% em 30 dias**, com composição diária. Ela não será usada como requisito do motor, pois pressionaria o sistema a forçar operações quando não existe vantagem.

### Indicadores econômicos obrigatórios

O sistema deverá exibir em tempo real:

- resultado bruto e líquido;
- corretagem e slippage estimado versus realizado;
- custo mensal de infraestrutura rateado por dia;
- lucro depois da infraestrutura;
- capital operacional;
- retorno de equilíbrio do mês;
- distância em USDT e em percentual até o equilíbrio;
- projeções por faixa, sempre identificadas como simulação e nunca como promessa.

## 3. Estado atual e lacunas

### O que já existe e deve ser preservado

- compra Spot e venda de volta para USDT;
- scanner de múltiplos pares e timeframes;
- separação de PAPER, TESTNET e LIVE;
- sizing pela perda máxima no stop, incluindo taxas e slippage;
- limite por posição, saldo disponível, notional e lote da corretora;
- filtro de liquidez;
- bloqueio de posição repetida no mesmo ativo;
- limite de exposição total e de altcoins;
- leitura do contexto do BTC;
- replay com stop primeiro quando alvo e stop aparecem no mesmo candle;
- métricas de expectativa em R, profit factor e drawdown;
- diário de decisões e funil de bloqueios;
- reconciliação e mecanismos de execução protegida.

### Diagnóstico atual

- Na revisão de 25/08/2026, o projeto passou no `typecheck` e em 200 testes automatizados. Esse estado verde vira portão obrigatório para toda promoção.
- Apenas `MOMENTUM_BURST`, com score mínimo 90, está autorizada para automação.
- `PULLBACK`, `BREAKOUT_RETEST` e `SUPPORT_REVERSAL` permanecem observacionais porque não sustentaram expectativa positiva nas janelas de treino e teste já avaliadas.
- O laboratório existente registra que mudar apenas a saída não salvou entradas sem vantagem; as alternativas ficaram aproximadamente entre **-0,26R e -0,41R**.
- Um score 95 classifica a força do sinal, mas não prova, sozinho, que aquela entrada tem valor esperado positivo.
- A simulação atual mede operações isoladas; falta um replay de carteira que respeite simultaneidade, saldo, risco aberto e correlação.
- Os dois limites de simultaneidade (`maxOpenTrades` e `maxConcurrentTrades`) precisam ser alinhados para que cinco vagas realmente funcionem.
- O cooldown atual pode acontecer depois de qualquer loss e a trava de perdas consecutivas pode permanecer acionada indefinidamente. Isso não implementa a regra desejada de quatro losses, duas horas de pausa e novo ciclo.

## 4. Modelo operacional desejado

```text
Mercado e candles
      ↓
Motor de regime ──────────────┐
      ↓                       │
Geradores de estratégia       │
      ↓                       │
Validação de sinal e custos   │
      ↓                       │
Expectativa calibrada         │
      ↓                       │
Ranking ajustado à correlação │
      ↓                       │
Orçamento de risco da carteira
      ↓
Entrada e proteção na corretora
      ↓
Reconciliação, saída e aprendizado
```

O scanner continua vendo todas as oportunidades. O fato de haver cinco vagas não significa que as cinco serão ocupadas. Uma vaga só recebe capital quando o candidato passa em todos os portões e melhora a carteira depois de considerar correlação, custos e risco no stop.

## 5. Motor de regime

Antes de escolher uma estratégia, o sistema deve classificar o mercado sem olhar dados futuros.

### Regimes mínimos

| Regime | Características | Estratégias possíveis |
|---|---|---|
| Alta tendencial | BTC e amplitude de mercado em tendência positiva | Momentum, pullback de tendência, rompimento/reteste |
| Alta volátil | Tendência positiva, volatilidade anormal | Momentum com posição reduzida |
| Lateral | Tendência fraca e reversões frequentes | Reversão à média/suporte, alvos mais curtos |
| Baixa tendencial | BTC e amplitude de mercado em deterioração | Caixa em USDT; short somente em fase futura validada |
| Choque/indefinido | Volatilidade, spread ou dados anormais | Nenhuma entrada nova |

### Variáveis iniciais

- preço do BTC versus médias de 50 e 200 dias;
- inclinação dessas médias;
- retorno do BTC em 7 e 30 dias;
- volatilidade realizada e ATR em percentis históricos;
- percentual do universo acima das médias de 20, 50 e 200 períodos;
- força relativa do ativo contra BTC e contra o universo;
- volume, spread, profundidade e slippage esperado;
- concentração dos sinais no mesmo tema/categoria.

O regime não deve prever o próximo candle. Ele decide **quais estratégias têm permissão para competir** e qual multiplicador de risco, sempre entre zero e um, será aplicado.

## 6. Portfólio de estratégias

### Estratégia A — Momentum Burst 2.0

É a campeã atual e permanece como primeira estratégia automática.

Evoluções:

- calibrar score para probabilidade e expectativa em R;
- separar explosão genuína de candle de exaustão;
- medir atraso entre a geração e a execução;
- incluir força relativa e amplitude de mercado;
- testar entrada limit maker ou pullback curto sem perder fills;
- preservar paridade entre o alvo de 3R validado e o usado em PAPER/LIVE;
- impedir compra quando o sinal já envelheceu além da janela medida.

### Estratégia B — Pullback em tendência

Não será ativada com a lógica atual. Será reconstruída como uma estratégia específica de regime:

- ativo e BTC acima da tendência longa;
- força relativa positiva;
- retração controlada, com queda de volume;
- retomada confirmada, em vez de tentativa de adivinhar o fundo;
- stop estrutural e alvo compatível com a volatilidade;
- cancelamento quando a tendência perde validade.

### Estratégia C — Rompimento e reteste

- nível formado por múltiplos testes, não por uma única máxima;
- rompimento com volume e fechamento válido;
- reteste com aceitação acima do nível;
- bloqueio de rompimentos excessivamente distantes da média;
- prazo máximo curto para o reteste;
- filtro de liquidez e slippage mais rigoroso.

### Estratégia D — Reversão à média em lateralização

- habilitada apenas em regime lateral;
- entrada perto da borda da faixa, nunca no centro;
- confirmação de rejeição;
- alvo conservador no meio ou no lado oposto da faixa;
- desativação imediata quando a faixa rompe com expansão de volatilidade.

### Estratégia E — Rotação por força relativa

- universo restrito aos pares mais líquidos;
- ranking de força contra BTC e contra o índice interno do mercado;
- compra somente quando a tendência de mercado autoriza risco;
- rebalanceamento com frequência controlada para não destruir o edge em taxas;
- limite de concentração por setor e fator de correlação.

### Estratégia F — Short direcional, fase futura

Spot long-only fica majoritariamente em USDT durante mercados vendedores. Para capturar tendências de baixa, poderá existir um módulo separado de USDⓈ-M Futures, porém **não faz parte da primeira entrega LIVE**.

Condições mínimas para iniciar essa fase:

- três meses de execução Spot estável e reconciliada;
- estratégia short validada separadamente e em carteira;
- testnet e subconta/chaves isoladas;
- margem isolada, nunca cross como padrão;
- alavancagem inicial máxima entre 1,0x e 1,5x;
- risco no stop calculado sobre o patrimônio, não sobre a margem;
- cálculo de liquidação, funding, mark price e gap;
- kill switch independente do Spot.

Alavancagem não altera a qualidade do sinal; ela amplifica lucro, perda, slippage e risco operacional. A CFTC destaca justamente que a alavancagem amplia os riscos já elevados da volatilidade de ativos virtuais.

## 7. Do score para expectativa calibrada

O score visual continuará útil, mas a ordenação real deve usar expectativa líquida:

```text
expectativa_R = P(win) × ganho_médio_R
              - P(loss) × perda_média_R
              - custo_médio_R
```

Cada candidato receberá:

- `probabilityOfProfit` calibrada;
- `expectedRNet`;
- intervalo de confiança;
- número de casos comparáveis;
- regime e versão da estratégia;
- slippage esperado;
- risco de correlação adicionado à carteira;
- motivo legível para entrar, esperar ou recusar.

O ranking será:

```text
priority = expectedRNet
         × confidenceFactor
         × liquidityFactor
         × regimeFactor
         × diversificationFactor
```

Nenhum fator poderá transformar expectativa negativa em positiva. Fatores de confiança, regime e liquidez variam de zero a um.

## 8. Sizing e risco de carteira

### Capital autorizado

O usuário poderá definir o capital operacional de duas formas:

- percentual do saldo elegível; e
- teto absoluto opcional em USDT.

```text
capital operacional = min(
  saldo elegível × percentual autorizado,
  teto absoluto, quando preenchido
)
```

O valor não será presumido em 100, 1.000 ou 5.000 USDT. O motor se ajustará ao saldo real e aos filtros mínimos da corretora. Se o risco calculado resultar em ordem menor que o mínimo do par, a oportunidade será recusada; o sistema não aumentará o risco para “caber” na ordem mínima.

### Risco de cada posição

```text
orçamento de risco = capital operacional × risco por operação × fatores de redução

quantidade pelo risco = orçamento de risco /
  (perda por unidade no stop + taxas e slippage)

quantidade final = mínimo entre:
  quantidade pelo risco,
  limite por posição,
  saldo disponível,
  teto de notional,
  capacidade restante da carteira,
  capacidade restante do cluster,
  lote permitido pela corretora
```

### Configuração recomendada para o primeiro estágio

| Controle | Valor inicial |
|---|---:|
| Risco máximo por operação | 0,75% do capital operacional |
| Risco total aberto nos stops | 3,0% |
| Posições simultâneas | até 5 |
| Exposição nominal total | até 80% |
| Exposição nominal em altcoins | até 60% |
| Exposição por ativo | até 20% |
| Risco por cluster correlacionado | até 1,5% |
| Operações abertas por dia | teto de segurança 12 |
| Perdas consecutivas para pausa | 4 |
| Pausa técnica | 120 minutos |
| Drawdown de redução inicial | 3% |
| Drawdown de redução forte | 5% |
| Drawdown de paralisação | 8% |

Depois de pelo menos 200 operações elegíveis em PAPER/TESTNET e execução consistente, o risco individual poderá ser testado em 1%, mantendo risco total aberto máximo de 4%. Isso é uma promoção condicionada, não configuração inicial.

### Risco aberto, não apenas capital investido

O novo controle decisivo será:

```text
risco aberto = soma, em USDT, das perdas estimadas de todas as posições
               se cada stop restante for executado com seus custos
```

Uma carteira pode ter 80% do capital investido e apenas 3% de risco nos stops; também pode ter pouca exposição nominal e risco excessivo se os stops forem largos. Por isso os dois limites precisam coexistir.

### Correlação

Os ativos serão agrupados por correlação móvel e por fatores econômicos:

- BTC/majors;
- layer 1;
- DeFi;
- memes;
- exchange tokens;
- ativos ligados ao mesmo evento ou narrativa.

Cinco altcoins altamente correlacionadas não contam como cinco apostas independentes. O `diversificationFactor` reduz ou bloqueia a entrada quando ela repete risco já presente.

## 9. Circuit breakers

### Regra das quatro perdas

A regra desejada será implementada como estado persistente:

1. contar apenas operações realizadas e encerradas;
2. ao fechar a quarta perda consecutiva, gravar `pausedUntil = closedAt + 120 minutos`;
3. durante a pausa, bloquear novas entradas, mas continuar protegendo e encerrando posições existentes;
4. se outra posição fechar com perda durante a pausa, estender a pausa a partir desse fechamento;
5. ao terminar a pausa, iniciar um novo ciclo de contagem automaticamente;
6. não apagar o histórico; apenas criar uma nova época de risco;
7. manter bloqueios independentes, como drawdown, dados inválidos ou BTC vendedor.

Isso substitui o comportamento inadequado de pausar depois de qualquer loss e evita que quatro perdas antigas deixem o sistema parado para sempre.

### Escada de drawdown

| Queda desde o topo | Ação |
|---:|---|
| Menor que 3% | risco normal aprovado |
| 3% a 5% | multiplicador 0,75 |
| 5% a 8% | multiplicador 0,50 |
| 8% ou mais | novas entradas paradas e revisão obrigatória |

O risco não volta imediatamente ao máximo após um único ganho. A recuperação de 0,50 para 0,75 exige uma janela de dez operações sem nova mínima e com expectativa realizada positiva. O retorno a 1,00 exige novo topo de patrimônio ou aprovação explícita após análise.

### Outros bloqueios duros

- feed de preço atrasado ou candles incompletos;
- divergência entre posição local e saldo/ordem da corretora;
- stop ausente ou quantidade desprotegida acima da tolerância;
- slippage observado muito acima do modelo;
- spread ou liquidez fora do limite;
- chave, timestamp, rate limit ou reconciliação degradados;
- anomalia de volatilidade;
- limite diário de perda;
- kill switch manual e servidor fail-closed.

## 10. Execução e custos

O backtest, PAPER, TESTNET e LIVE precisam compartilhar as mesmas políticas de entrada, sizing e saída.

### Requisitos

- entrada idempotente por fingerprint do sinal;
- atualização via user data stream e reconciliação REST;
- proteção de fill parcial;
- OTOCO/OCO quando o fluxo e o tipo de ordem suportarem;
- fallback seguro quando a ordem protetora for rejeitada;
- arredondamento sempre para baixo no sizing;
- uso dos filtros reais de preço, lote e notional do par;
- custo configurado pelo nível real de taxa da conta;
- medição de slippage por símbolo, horário, volatilidade e tamanho;
- cancelamento de sinal vencido;
- registro do motivo de cada bloqueio;
- paridade exata entre saída simulada e saída enviada à corretora.

### Otimização que pode aumentar retorno líquido

- limitar entradas a pares cuja liquidez suporte o tamanho pretendido;
- testar ordem limit maker quando ela não causar perda excessiva de fills;
- medir `fillRate × expectancy`, não apenas a economia de taxa;
- agrupar leituras de mercado sem atrasar decisões;
- reduzir churn de estratégias laterais;
- recalibrar slippage automaticamente com observações reais;
- avaliar cada otimização sob custo 1x, 1,5x e 2x.

## 11. Laboratório e validação

Nenhuma estratégia nova entra na lista automática diretamente.

### Dados

- ampliar o histórico para três a cinco anos quando o ativo permitir;
- congelar o universo de cada data para reduzir viés de sobrevivência;
- guardar símbolos deslistados quando houver fonte histórica disponível;
- usar apenas candles fechados;
- versionar dados, parâmetros, commit e data do teste;
- simular filtros da corretora e capacidade de saldo.

### Walk-forward

Configuração inicial proposta:

- treino: 180 dias;
- validação: 60 dias;
- teste futuro: 30 dias;
- avanço: 30 dias;
- embargo entre janelas para evitar vazamento de sinais sobrepostos;
- parâmetros escolhidos no treino e congelados antes da janela seguinte.

Os períodos poderão ser alongados para estratégias de 4h/1d. A regra importante é que o teste nunca participe da escolha dos parâmetros.

### Replay de carteira

O simulador deverá processar todos os sinais em ordem cronológica e aplicar:

- saldo reservado;
- máximo de posições;
- risco aberto;
- exposição total e por cluster;
- concorrência entre sinais no mesmo horário;
- prioridade ajustada à expectativa;
- fills e cancelamentos;
- sequência de perdas e pausas;
- drawdown dinâmico;
- custos e slippage dependentes do tamanho;
- indisponibilidade de capital até a saída.

### Testes de robustez

- convenção pessimista intrabar;
- custos multiplicados por 1,5 e 2;
- atraso de um candle e atraso em segundos/minutos;
- retirada aleatória de 10% dos melhores trades;
- Monte Carlo por reordenação das operações;
- bootstrap de expectativa e drawdown;
- sensibilidade: parâmetros vizinhos devem continuar aceitáveis;
- resultado por ano, trimestre, regime, estratégia e ativo;
- concentração de lucro;
- falha de feed, fill parcial, restart e duplicação de evento.

### Portão de promoção de estratégia

Valores iniciais, sujeitos a ajuste antes da implementação:

| Critério | Exigência mínima |
|---|---:|
| Operações totais preenchidas | 300 |
| Operações estritamente fora da amostra | 100 |
| Expectativa líquida fora da amostra | pelo menos +0,10R |
| Profit factor fora da amostra | pelo menos 1,25 |
| Janelas walk-forward positivas | pelo menos 60% |
| Resultado com custos 2x | expectativa maior que zero |
| Concentração do lucro em um ativo | menos de 25% |
| Drawdown da estratégia | dentro do orçamento aprovado |
| Paridade PAPER/backtest | sem divergência material não explicada |

Uma estratégia que não reúne amostra suficiente permanece `OBSERVATIONAL`, mesmo que o resultado inicial seja alto.

### Portão de promoção do portfólio

- expectativa líquida positiva fora da amostra;
- profit factor de carteira de pelo menos 1,30;
- drawdown máximo simulado de até 10%, com o hard stop operacional em 8%;
- nenhuma janela de choque com perda incompatível com o capital;
- sobrevivência ao teste de custos 2x;
- melhora real contra operar somente `MOMENTUM_BURST`;
- diversidade efetiva: o ganho não pode depender de uma única moeda ou mês.

## 12. Uso de IA

A IA será uma camada de diagnóstico e calibração, nunca uma chave sem limite para movimentar dinheiro.

### Funções autorizadas

- identificar regime e anomalias;
- calibrar probabilidade a partir de histórico versionado;
- comparar comportamento recente com a população do backtest;
- reduzir tamanho ou vetar entradas frágeis;
- explicar em linguagem simples por que uma entrada foi aceita ou recusada;
- detectar degradação de estratégia;
- gerar pós-mortem e recomendar que um challenger volte ao laboratório.

### Funções proibidas

- aumentar o risco acima dos tetos determinísticos;
- recuperar loss dobrando a próxima posição;
- inventar stop ou alvo fora da política versionada;
- alterar parâmetros em LIVE sem promoção controlada;
- operar com saída textual não validada;
- ignorar bloqueio de risco.

### Champion/challenger

- `champion`: estratégia e parâmetros autorizados;
- `challenger`: roda em shadow mode com preços reais, sem ordens;
- comparação por expectativa, custo, drawdown, estabilidade e fill;
- promoção apenas após janela mínima e aprovação registrada;
- rollback automático para a versão anterior quando houver degradação operacional.

## 13. Dados e observabilidade

### Novas entidades

- `strategy_versions`: regra, parâmetros, hash do código e estado de promoção;
- `backtest_runs`: dados, janelas, custos, métricas e artefatos;
- `portfolio_snapshots`: patrimônio, exposição, risco aberto e clusters;
- `risk_epochs`: sequência de losses, pausa e motivo de reinício;
- `system_pauses`: início, fim, causa e resolução;
- `cost_ledger`: taxa, slippage, funding e infraestrutura;
- `execution_quality`: preço esperado, preço realizado, atraso e fill rate;
- `strategy_health`: expectativa móvel, drawdown e status champion/challenger;
- `market_regimes`: classificação, confiança e atributos usados.

### Alertas

- posição sem proteção;
- divergência de saldo;
- quatro losses e início da pausa;
- pausa encerrada ou estendida;
- drawdown em cada degrau;
- custo mensal acima do previsto;
- estratégia degradada;
- taxa de bloqueio anormal;
- dados atrasados;
- erro de ordem ou reconciliação.

## 14. Produto e interface

### Dashboard principal

- patrimônio total e capital operacional autorizado;
- USDT livre, reservado e exposto;
- risco aberto no stop, em USDT e percentual;
- cinco vagas de posição, com cluster e contribuição de risco;
- regime atual e estratégias habilitadas;
- lucro bruto, custos de trading, hospedagem e lucro econômico;
- ponto de equilíbrio mensal;
- drawdown, degrau de risco e pausa vigente;
- saúde de cada estratégia.

### Radar

Cada oportunidade mostrará:

- score visual;
- expectativa líquida em R;
- intervalo de confiança e tamanho da amostra;
- regime compatível ou incompatível;
- custo e slippage estimados;
- risco planejado;
- impacto no risco aberto e no cluster;
- status: `ELEGIBLE`, `WAIT`, `BLOCKED` ou `OBSERVATIONAL`;
- motivo completo da decisão.

### Configurações

- capital operacional em percentual e teto USDT;
- risco individual e risco aberto;
- cinco posições simultâneas;
- exposição por ativo, altcoin e cluster;
- quatro losses e pausa de 120 minutos;
- degraus de drawdown;
- custo fixo mensal;
- perfis `CONSERVADOR`, `BASE_VALIDADO` e `EXPERIMENTAL_PAPER`;
- nenhuma opção de risco experimental disponível no LIVE sem promoção.

## 15. Backlog técnico

### P0 — Fundação para aumentar exposição com segurança

1. Manter `typecheck` e os 200 testes atuais verdes; toda regra nova precisa acrescentar cobertura.
2. Aplicar e validar, em cada ambiente, as migrações do diário/funil de decisões já preparadas.
3. Criar `src/core/portfolio/openRisk.ts` para risco agregado nos stops.
4. Criar `src/core/portfolio/correlation.ts` e classificação de clusters.
5. Criar `src/core/backtest/portfolio.ts` para replay cronológico da carteira.
6. Adicionar `operationalCapitalPercent` e `operationalCapitalCapUsdt`.
7. Alinhar `maxOpenTrades` e `maxConcurrentTrades` em cinco.
8. Implementar `risk_epochs` para quatro losses, pausa de duas horas e reinício automático.
9. Adicionar escada de drawdown e restauração gradual.
10. Criar módulo `src/core/economics/viability.ts` e painel de equilíbrio.
11. Garantir fail-closed em dados, store, reconciliação e proteção de ordens.

### P1 — Motor de vantagem

1. Criar `src/core/regime/marketRegime.ts`.
2. Criar `src/core/strategy/router.ts`.
3. Criar `src/lab/walkForward.ts`.
4. Calibrar score versus probabilidade e expectativa.
5. Versionar estratégias e relatórios.
6. Reengenheirar pullback, reteste e reversão sem liberar automação.
7. Criar rotação por força relativa em shadow mode.
8. Adicionar testes de concentração, correlação e custos 2x.

### P2 — PAPER e TESTNET

1. Rodar portfólio em shadow/PAPER por 30 dias.
2. Comparar sinal, decisão, fill teórico e fill executável.
3. Rodar TESTNET por pelo menos 14 dias.
4. Testar restart, desconexão, fill parcial e rejeição de proteção.
5. Corrigir divergências e repetir a janela se houver falha material.

### P3 — LIVE em canário

1. Começar com 10% do capital autorizado.
2. Promover para 25%, 50% e 100% apenas após critérios de execução e risco.
3. Exigir no mínimo 50 operações elegíveis por estágio ou janela temporal equivalente.
4. Voltar um estágio em caso de degradação.
5. Nunca promover durante drawdown ou com incidente aberto.

### P4 — Derivativos opcionais

1. Laboratório separado para short.
2. Modelo completo de funding, mark price, margem e liquidação.
3. Testnet dedicado.
4. Chaves/subconta separadas.
5. Canário com risco menor que o Spot.

## 16. Cronograma recomendado

| Período | Entrega |
|---|---|
| Semana 1 | P0: risco aberto, capital operacional, pausa e economia |
| Semanas 2 e 3 | simulador de carteira, regime e walk-forward |
| Semana 4 | challengers e relatório consolidado; sem promoção automática prematura |
| Dias 31 a 60 | PAPER/shadow contínuo e correções |
| Dias 61 a 75 | TESTNET e testes de falha |
| Dias 76 a 90 | decisão de canário LIVE, somente se todos os portões passarem |

Trinta dias são suficientes para construir e iniciar validação, mas normalmente não são suficientes para afirmar que várias estratégias funcionam em todos os regimes. O cronograma evita confundir ausência temporária de perdas com vantagem estatística.

## 17. Critérios de sucesso do projeto

### Técnicos

- typecheck e testes automatizados aprovados;
- backtest, PAPER e LIVE usando as mesmas políticas;
- nenhuma duplicação de ordem em restart/retry;
- nenhuma quantidade preenchida sem proteção além da tolerância;
- reconciliação consistente com a corretora;
- risco aberto e custos reproduzíveis.

### Quantitativos

- portfólio aprovado nos portões fora da amostra;
- resultado positivo sob custos 2x;
- drawdown dentro do orçamento;
- nenhuma dependência excessiva de um ativo, mês ou estratégia;
- execução real compatível com o slippage previsto;
- melhora comprovada sobre o champion atual.

### Econômicos

- custo do sistema visível e auditável;
- capital mínimo de equilíbrio calculado automaticamente;
- expectativa de trading separada da obrigação de pagar hospedagem;
- escala baseada em evidência, nunca em urgência financeira.

## 18. Cenários de retorno

Somente para planejamento financeiro, e não como promessa:

| Cenário mensal | Retorno líquido de trading antes da hospedagem | Interpretação |
|---|---:|---|
| Adverso | -5% a -10% | mês ruim possível; os disjuntores devem limitar dano |
| Conservador positivo | 1% a 3% | pode não pagar infraestrutura com capital pequeno |
| Meta operacional madura | 3% a 6% | exige edge real, custos controlados e execução estável |
| Mês forte | 6% a 10% | possível em certos regimes, mas não deve virar obrigação |

O sistema será avaliado por expectativa, drawdown, consistência e lucro líquido após custos — não por perseguir a faixa mais alta. Um mês forte não autoriza aumento automático de risco; uma série curta de gains não prova vantagem.

## 19. Decisão final recomendada

1. Não aumentar agora o risco do LIVE.
2. Construir primeiro o simulador de carteira e o risco aberto.
3. Corrigir a pausa das quatro perdas e habilitar até cinco vagas sob orçamento agregado.
4. Preservar `MOMENTUM_BURST` como champion.
5. Reconstruir as demais estratégias como challengers condicionados ao regime.
6. Tornar visível o ponto de equilíbrio econômico.
7. promover capital e estratégias por estágios objetivos.
8. considerar short/alavancagem apenas como projeto separado depois que o Spot estiver comprovado.

O resultado desejado não é um robô que opera mais. É um robô que **só aumenta o volume quando a vantagem, a capacidade de execução e o orçamento de risco permitem**.

## 20. Referências oficiais

- [CVM — Robôs de investimentos](https://www.gov.br/investidor/pt-br/investir/como-investir/profissionais-do-mercado/robos-de-investimentos): automação pode reduzir vieses, mas não há garantia de maior rentabilidade e os custos importam.
- [CVM — Série educacional sobre day trade](https://www.gov.br/cvm/pt-br/assuntos/noticias/2023/cvm-lanca-serie-de-videos-educacionais-sobre-day-trade): material de risco baseado em estudo de participantes do mercado brasileiro.
- [CVM — Criptoativos e riscos](https://www.gov.br/cvm/pt-br/assuntos/protecao/mercado-forex/criptoativos-forex): volatilidade elevada e alerta sobre promessas de rentabilidade extraordinária.
- [CFTC — Understand the Risks of Virtual Currency Trading](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/understand_risks_of_virtual_currency.html): volatilidade, risco de plataforma e amplificação de risco por alavancagem.
- [Binance Developer Documentation](https://developers.binance.com/en/docs/introduction): referência primária para endpoints, streams e regras de execução.

**Nota sobre evidência:** estatísticas públicas da CVM sobre day trade em ações e futuros ajudam a dimensionar o risco de operações frequentes, mas não são evidência direta da performance deste robô ou do mercado cripto. A decisão deste projeto dependerá dos próprios testes fora da amostra e da execução observada.
