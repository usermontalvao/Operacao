# ============================================================================
#  Painel Operação — imagem de produção.
#
#  Duas etapas: a primeira monta a tela (precisa das devDependencies), a
#  segunda fica só com o que roda. O servidor executa os fontes .ts
#  diretamente — o Node 24 remove os tipos sozinho, sem passo de compilação —
#  então `src/` viaja para a imagem final, e não um `dist/` de servidor.
# ============================================================================

# ---- etapa 1: a tela --------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# as dependências primeiro, sozinhas: assim a camada do npm ci só é refeita
# quando o package-lock muda, e não a cada alteração de código
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY src ./src
RUN npm run build


# ---- etapa 2: o que roda ----------------------------------------------------
FROM node:24-slim
WORKDIR /app

ENV NODE_ENV=production \
    # Dentro do contêiner é obrigatório escutar em 0.0.0.0: o padrão do
    # projeto é 127.0.0.1, que faria a porta publicada não responder nada.
    # O isolamento continua existindo — ele vem do mapeamento da porta no
    # compose, que publica apenas em 127.0.0.1 do host.
    HOST=0.0.0.0 \
    PORT=3010

COPY package.json package-lock.json ./
# --omit=dev tira vite, tailwind e typescript; as optionalDependencies
# (@supabase/supabase-js) continuam, e são elas que falam com o banco
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY --from=build /app/dist ./dist

# roda sem privilégio: a imagem do Node já traz o usuário `node`
USER node

EXPOSE 3010

# O /api/health responde sem sessão de propósito — é o único endpoint que
# responde — então serve de sonda sem precisar de credencial. Usa o fetch
# nativo do Node para não instalar curl só por causa disto.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sem --env-file: no contêiner as variáveis vêm do ambiente, não de um arquivo
CMD ["node", "src/server/index.ts"]
