# Subir o painel num servidor

O painel roda inteiro no servidor: o robô não precisa de navegador aberto nem
de sessão ativa. É por isso que faz sentido tirá-lo do Mac — lá ele morre
quando a janela do Terminal fecha ou quando a máquina dorme.

## Antes de tudo: só um robô por conta

**Não existe trava de líder.** Se a stack subir enquanto o painel também roda
no seu computador, os dois varrem o mercado e os dois podem comprar, contra o
mesmo Supabase e a mesma carteira. O limite de "uma posição automática por
vez" vale por processo, não entre processos — dois processos abrem duas
posições.

Escolha um dos dois antes de subir. Para desligar o robô do Mac sem fechar o
painel, use o distintivo no topo da tela.

## Onde isto NÃO roda

Hospedagem compartilhada não serve. Um endereço `*.hostingersite.com` com
`panel: hpanel` nos cabeçalhos é plano compartilhado da Hostinger: ele entrega
site estático e PHP atrás do CDN deles, e não mantém processo Node de pé nem
executa Docker. O painel precisa de um **VPS** (ou qualquer host com Docker),
que é onde o seu Portainer já está.

Para descobrir o endereço certo: é o mesmo host onde o Portainer responde.

## O que preparar

O hash da senha do painel, gerado na sua máquina:

```
npm run senha
```

Copie a linha `scrypt$...` inteira — é ela que vai em `PANEL_PASSWORD_HASH`.
A senha em texto nunca sai da sua cabeça.

## Criar a stack no Portainer

1. **Stacks → Add stack → Repository**
2. Repository URL: `https://github.com/usermontalvao/Operacao`
3. Compose path: `docker-compose.yml`
4. Em **Environment variables**, preencha:

| Variável | O que é |
|---|---|
| `SUPABASE_URL` | endereço do projeto no Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | chave de serviço — nunca vai para o navegador |
| `PANEL_USER` | e-mail ou usuário de entrada |
| `PANEL_PASSWORD_HASH` | o `scrypt$...` gerado acima |
| `APP_SECRET` | texto aleatório longo; assina o token de confirmação de ordem |
| `ALLOWED_HOSTS` | o domínio do painel — ver a regra exata abaixo |

Todas as seis são obrigatórias: faltando qualquer uma, o compose **recusa o
deploy** dizendo o nome dela. Isso é de propósito — uma stack que sobe sem
login configurado vira um painel que recusa tudo sem explicar por quê.

Opcionais: `TRADING_MODE` (padrão `PAPER`), `LOG_LEVEL`, `SESSION_HOURS`, e as
chaves da Binance quando for usar conta real ou testnet.

`ALLOW_LIVE_AUTOTRADE` fica em `false`. Ligar isto é a segunda chave da compra
automática em dinheiro real, e ela existe fora do painel justamente para que
um clique na tela não a alcance.

### Acertando o ALLOWED_HOSTS

A conferência compara o cabeçalho `Host` **inteiro e exato**, com porta. É por
isso que o valor certo depende de como você abre o painel:

| Você acessa por | O valor tem de ser |
|---|---|
| `https://painel.seudominio.com` | `painel.seudominio.com` |
| `http://painel.seudominio.com` | `painel.seudominio.com` |
| `http://203.0.113.10:3010` | `203.0.113.10:3010` |

Em 443 e 80 o navegador não manda a porta, então ela **não** entra no valor.
Em qualquer outra porta, entra. Vários endereços vão separados por vírgula.

Errar isto devolve `403 Host não autorizado` em todas as chamadas, com o painel
carregando normalmente — a tela aparece e nada funciona.

## Proxy na frente

A porta é publicada só em `127.0.0.1:3010` do host. Quem expõe para fora é o
proxy — esta API envia ordem de compra e não pode ficar aberta na internet.

No proxy, encaminhe o domínio para `127.0.0.1:3010` e **preserve o cabeçalho
Host**: a API o confere contra `ALLOWED_HOSTS`, e um proxy que reescreve o
Host faz toda chamada voltar 403.

O painel usa Server-Sent Events em `/api/stream`. Desligue o buffer de
resposta para esse caminho, senão a tela congela sem erro nenhum.

## Conferir que subiu

```
docker logs -f operacao
```

A linha `Crypto Setup Hunter no ar` traz `persistencia: ok` quando o Supabase
respondeu. Se vier `INDISPONÍVEL — modo degradado`, o painel está de pé mas
**não opera** — e não grava nada em arquivo local, para não criar um segundo
histórico. Corrija o Supabase e reinicie.

O contêiner tem sonda própria: `docker ps` mostra `healthy` quando
`/api/health` responde.
