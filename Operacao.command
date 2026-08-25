#!/bin/bash
#
# Atalho de dois cliques do painel Operação (macOS).
#
# Faz na ordem o que dá errado quando se faz na mão: acha o Node mesmo quando
# o Finder abre o terminal sem o PATH do shell, instala o que falta, garante
# que existe login configurado, sobe o servidor e só abre o navegador quando a
# API responde de verdade — abrir antes mostra "não foi possível conectar" e
# parece que o programa quebrou.
#
# Para rodar do terminal:  ./Operacao.command
# Se o duplo clique não funcionar:  chmod +x Operacao.command

set -u
cd "$(dirname "$0")" || exit 1

VERDE=$'\033[32m'; VERMELHO=$'\033[31m'; AMARELO=$'\033[33m'; FIM=$'\033[0m'
# Sem um locale UTF-8 o bash trata os bytes de um acento como parte do nome
# da variável: "$PORTA…" virava a variável "PORTA…" e o set -u derrubava tudo.
# O Terminal aberto pelo Finder costuma vir sem LANG nenhum.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-$LANG}"

PORTA="${PORT:-3010}"
SERVIDOR_PID=""

titulo() { printf '\n%s==> %s%s\n' "$VERDE" "$1" "$FIM"; }
erro()   { printf '%s!! %s%s\n' "$VERMELHO" "$1" "$FIM"; }
aviso()  { printf '%s * %s%s\n' "$AMARELO" "$1" "$FIM"; }

encerrar() {
  if [ -n "$SERVIDOR_PID" ] && kill -0 "$SERVIDOR_PID" 2>/dev/null; then
    titulo "Encerrando o servidor…"
    kill "$SERVIDOR_PID" 2>/dev/null
    wait "$SERVIDOR_PID" 2>/dev/null
  fi
}
trap encerrar EXIT INT TERM

# --- Node ------------------------------------------------------------------
# O Finder abre o terminal sem passar pelo seu ~/.zshrc, então nvm e Homebrew
# não estão no PATH. Procuramos nos lugares de sempre antes de desistir.
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

VERSAO_NODE="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$VERSAO_NODE" -lt 22 ]; then
  erro "Node $VERSAO_NODE é antigo demais — este painel precisa da versão 22 ou mais nova."
  read -r -p "Enter para fechar."
  exit 1
fi
titulo "Node $(node -v) em $(command -v node)"

# --- Porta ocupada ---------------------------------------------------------
# Duas cópias do painel na mesma porta: a segunda morre com um erro cru de
# rede que não diz o que fazer. Melhor avisar antes.
if lsof -nP -iTCP:"$PORTA" -sTCP:LISTEN >/dev/null 2>&1; then
  aviso "Já existe algo na porta $PORTA — o painel provavelmente já está aberto."
  open "http://127.0.0.1:$PORTA"
  read -r -p "Enter para fechar esta janela."
  exit 0
fi

# --- Configuração ----------------------------------------------------------
if [ ! -f .env ]; then
  aviso "Sem .env — copiando do exemplo."
  cp .env.example .env
  chmod 600 .env
fi

if [ ! -d node_modules ]; then
  titulo "Instalando dependências (só na primeira vez, demora um pouco)…"
  npm install || { erro "npm install falhou."; read -r -p "Enter para fechar."; exit 1; }
fi

# --- Login -----------------------------------------------------------------
# Nenhum atalho sobe o painel sem porteiro: esta API envia ordem de compra.
if ! grep -qE '^PANEL_USER=.+' .env; then
  titulo "Login ainda não configurado — vamos criar agora."
  npm run --silent senha || { erro "Login não configurado."; read -r -p "Enter para fechar."; exit 1; }
fi

# --- Tela ------------------------------------------------------------------
if [ ! -f dist/index.html ] || [ -n "$(find web -newer dist/index.html -type f -print -quit 2>/dev/null)" ]; then
  titulo "Montando a tela…"
  npm run --silent build || { erro "O build da tela falhou."; read -r -p "Enter para fechar."; exit 1; }
fi

# --- Servidor --------------------------------------------------------------
titulo "Subindo o servidor na porta ${PORTA}"
npm run --silent start &
SERVIDOR_PID=$!

ENDERECO="http://127.0.0.1:$PORTA"
for _ in $(seq 1 40); do
  if curl -fsS "$ENDERECO/api/health" >/dev/null 2>&1; then
    titulo "No ar: $ENDERECO"
    open "$ENDERECO"
    break
  fi
  if ! kill -0 "$SERVIDOR_PID" 2>/dev/null; then
    erro "O servidor caiu ao iniciar — a mensagem acima diz o motivo."
    read -r -p "Enter para fechar."
    exit 1
  fi
  sleep 0.5
done

printf '\n%sO painel está rodando. Feche esta janela ou aperte Ctrl+C para desligar.%s\n\n' "$AMARELO" "$FIM"
wait "$SERVIDOR_PID"
