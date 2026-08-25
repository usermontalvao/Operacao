#!/bin/bash
#
# Atalho de dois cliques do modo DESENVOLVIMENTO (macOS).
#
# Diferença para o Operacao.command: aqui sobem os dois processos do
# `npm run dev` — o servidor com --watch (reinicia sozinho quando um arquivo
# do servidor muda) e o Vite na porta 5180 (troca a tela sem recarregar).
# Não há build: a tela é montada na hora, então editar e ver acontece junto.
#
# Use este quando for MEXER no código. Para só operar, use o Operacao.command.

set -u
cd "$(dirname "$0")" || exit 1

# Sem um locale UTF-8 o bash trata os bytes de um acento como parte do nome da
# variável seguinte. O Terminal aberto pelo Finder costuma vir sem LANG.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-$LANG}"

VERDE=$'\033[32m'; VERMELHO=$'\033[31m'; AMARELO=$'\033[33m'; FIM=$'\033[0m'
PORTA_WEB=5180

titulo() { printf '\n%s==> %s%s\n' "$VERDE" "$1" "$FIM"; }
erro()   { printf '%s!! %s%s\n' "$VERMELHO" "$1" "$FIM"; }

if ! command -v node >/dev/null 2>&1; then
  for caminho in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    [ -x "$caminho/node" ] && PATH="$caminho:$PATH"
  done
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  fi
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  erro "Node.js não encontrado. Instale a versão 22 ou mais nova em https://nodejs.org"
  read -r -p "Enter para fechar."
  exit 1
fi
titulo "Node $(node -v) em $(command -v node)"

if [ ! -d node_modules ]; then
  titulo "Instalando dependências…"
  npm install || { erro "npm install falhou."; read -r -p "Enter para fechar."; exit 1; }
fi

if ! grep -qE '^PANEL_USER=.+' .env 2>/dev/null; then
  titulo "Login ainda não configurado — vamos criar agora."
  npm run --silent senha || { erro "Login não configurado."; read -r -p "Enter para fechar."; exit 1; }
fi

titulo "Subindo em modo desenvolvimento…"
printf '%s   servidor recarrega sozinho · tela em http://127.0.0.1:%s%s\n' "$AMARELO" "$PORTA_WEB" "$FIM"
printf '%s   Ctrl+C nesta janela desliga os dois.%s\n' "$AMARELO" "$FIM"

# a tela demora ~1s para responder; abrir antes mostra erro de conexão
( for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORTA_WEB}" >/dev/null 2>&1; then
      open "http://127.0.0.1:${PORTA_WEB}"
      break
    fi
    sleep 0.5
  done ) &

npm run dev
