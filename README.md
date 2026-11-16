# Projeto: API sob Alta Demanda

API REST de reserva de ingressos para um show com **100 vagas fixas**, **máximo de 2 vagas ativas por usuário** e concorrência controlada, conforme o enunciado da disciplina.

📄 **Documentação completa:** [DOCUMENTO.md](DOCUMENTO.md) — arquitetura, banco de dados, estratégia de concorrência, resultados dos testes, limitações e roteiro de apresentação.

## Tecnologias

- Node.js 22 + Express 5
- PostgreSQL 17 (`pg`)
- JWT (`jsonwebtoken`) e hashes de senha (`bcryptjs`)
- Docker e Docker Compose

## Executar (único pré-requisito: Docker com Compose)

Na raiz do projeto:

```bash
docker compose down -v
docker compose up --build -d
```

A API ficará em **http://localhost:8080**. O banco e as tabelas são criados automaticamente; o show de ID `7` começa com exatamente 100 ingressos. **ATENÇÃO:** `down -v` apaga os dados do banco desse projeto (útil para reiniciar os testes).

Verificar o estado dos contêineres:

```bash
docker compose ps
docker compose logs -f api
```

Teste de saúde (extra, não faz parte do contrato da disciplina):

```bash
curl http://localhost:8080/health
```

Resposta: `{"status":"ok"}`.

## Executar sem Docker (Windows)

Para computadores que não suportam o Docker: com Node.js 22+ e PostgreSQL 17 instalados (detalhes e solução de problemas na seção 11.2 do [DOCUMENTO.md](DOCUMENTO.md)):

```powershell
scripts\iniciar-local.ps1          # terminal 1: liga o PostgreSQL e a API
npm test                           # terminal 2: testes (também test:regras e test:concorrencia)
scripts\resetar-banco-local.ps1    # recria o banco (pare a API antes)
scripts\parar-local.ps1            # desliga o PostgreSQL
```

## Documentação em Word

O [DOCUMENTO.docx](DOCUMENTO.docx) é gerado a partir do `DOCUMENTO.md`. Depois de editar o Markdown, gere de novo com `npm run docx`. Ao abrir no Word, aceite atualizar os campos para montar o sumário.

## Endpoints obrigatórios

### 1) Registro

`POST /auth/registrar` — JSON: `{"username":"joao","password":"senha123"}`.

**Sucesso:** `201 Created` (sem corpo).

### 2) Login

`POST /auth/login` — JSON: `{"username":"joao","password":"senha123"}`.

**Sucesso:** `200 OK` e `{"token":"..."}`.

**As rotas seguintes exigem o cabeçalho** `Authorization: Bearer <token>`.

### 3) Criar pedido

`POST /pedidos` — JSON: `{"showId":7}`.

**Sucesso:** `201 Created` e `{"id":42,"status":"NO_CARRINHO"}` (o ID varia).

### 4) Reservar pedido

`POST /pedidos/{id}/reservar` — sem body.

- Sucesso: `200 OK`, `{"id":42,"status":"RESERVADO"}` e **header `X-Lote: 7F3A`**.
- Pool lotado: `409 Conflict`, `{"error":"POOL_CHEIO"}`.
- Cota pessoal de 2 reservas: `409 Conflict`, `{"error":"COTA_PESSOAL"}`.
- Pedido de outro usuário: `404 Not Found`.

### 5) Cancelar pedido

`POST /pedidos/{id}/cancelar` — sem body.

- Sucesso: `200 OK`, `{"id":42,"status":"CANCELADO"}`.
- Pedido de outro usuário: `404 Not Found`.

### 6) Consultar pool

`GET /pool`.

**Sucesso:** `200 OK`, `{"total":100,"ocupadas":37,"livres":63}` (os números variam).

A coluna `ocupadas` é calculada diretamente dos pedidos `RESERVADO` em uma única consulta, de modo que `total = ocupadas + livres` durante as concorrências.

### Respostas complementares

O enunciado não define erros para todas as condições possíveis. Para elas, esta implementação acrescenta códigos JSON, por exemplo `ESTADO_INVALIDO` (409), `NAO_AUTORIZADO` (401) e `PEDIDO_NAO_ENCONTRADO` (404). Os textos **exatamente exigidos** (`POOL_CHEIO`, `COTA_PESSOAL`, header `X-Lote`) não são modificados.

## Testar sem instalar Node.js na máquina

O Node.js já está no contêiner da API. Após subir os serviços:

```bash
docker compose exec -T api npm test
```

Testa registro, login, autenticação, cota pessoal, transições, propriedade de pedidos, cancelamento, header `X-Lote` e integridade do pool. **Execute esse teste primeiro** com o pool ainda livre.

Em seguida, as regras sob concorrência (exige o pool vazio e o devolve vazio):

```bash
docker compose exec -T api npm run test:regras
```

Cobre: 5 reservas simultâneas do mesmo usuário (2 aprovadas), 10 reservas simultâneas do mesmo pedido (1 aprovada), 120 reservas simultâneas (100 aprovadas), cancelamento liberando vaga, 404 para pedido de outro usuário, `X-Lote` presente nos sucessos e ausente nos erros, e as invariantes do pool lidas durante as rajadas.

Por último (este teste deixa o pool cheio):

```bash
docker compose exec -T api npm run test:concorrencia
```

Esse teste cria 65 usuários e 130 pedidos, dispara 130 reservas concorrentes e verifica se, partindo do banco limpo, **100 são aprovadas**, **30 recebem `POOL_CHEIO`**, sem ultrapassar o limite. O teste também confere todas as respostas e os headers `X-Lote` de sucesso.

Os três testes falham explicitamente se o pool não estiver no estado inicial exigido.

Medição de carga progressiva (opcional, exige o pool vazio; imprime latências e contagem de respostas):

```bash
docker compose exec -T api npm run test:carga
```

Reinicie o banco antes de repetir os testes em estado inicial:

```bash
docker compose down -v
docker compose up --build -d
```

## Estratégia de concorrência (parte obrigatória da apresentação)

Uma implementação ingênua faz `COUNT` das reservas e depois grava o pedido. Duas requisições podem consultar ao mesmo tempo 99/100 e ambas aprovar, causando **101/100** (condição de corrida).

Essa implementação combina **duas medidas**:

1. **Fila FIFO em memória (uma instância da API)**: reservas e cancelamentos entram na ordem em que o processo Node recebe as solicitações e são processados individualmente. Isso estabelece a ordem de atendimento na instância única utilizada pelo Compose.
2. **Transação PostgreSQL com `SELECT ... FOR UPDATE` sobre a linha do show 7**: todas as mudanças de reserva, mesmo em conexões diferentes, esperam a liberação desse bloqueio. Depois de adquirir o bloqueio, a transação verifica propriedade, estado, cota pessoal e pool; por fim confirma `COMMIT` ou desfaz `ROLLBACK`. Assim nunca é aprovada uma reserva além do limite.

A cota pessoal é verificada **antes** da lotação do pool, então um usuário que já possui duas reservas recebe `COTA_PESSOAL`.

**Limite importante:** o FIFO em memória define a ordem de chegada à instância Node, não uma ordem absoluta de pacotes na rede. Com múltiplas réplicas, os bloqueios PostgreSQL ainda garantem a **integridade**, porém o FIFO global exigiria uma fila compartilhada. O Compose desta entrega executa uma única instância da API.

O `GET /pool` lê um snapshot consistente do PostgreSQL e não vê dados não confirmados. Não há reserva automática com prazo: a vaga só é liberada com o cancelamento, como exige o enunciado.

## Máquina de estados

```text
NO_CARRINHO --reservar--> RESERVADO --cancelar--> CANCELADO
```

- Pedido criado não ocupa ingresso.
- Somente `RESERVADO` ocupa ingresso e cota pessoal.
- `CANCELADO` devolve a vaga e não pode voltar para `RESERVADO`.
- Repetir uma transição inválida responde 409 `ESTADO_INVALIDO`.

## Estrutura

```text
.
├── src/
│   ├── app.js        # Express, rotas, validação e códigos HTTP
│   ├── auth.js       # JWT e middleware Bearer
│   ├── db.js         # Conexões PostgreSQL
│   ├── erros.js      # Erros HTTP padronizados
│   └── reservas.js   # Fila FIFO, transação e controle de vagas
├── database/
│   └── init.sql      # Criação das tabelas e show ID 7
├── scripts/
│   ├── test-api.mjs           # Teste funcional sequencial
│   ├── test-regras.mjs        # Regras de negócio sob concorrência
│   ├── test-concorrencia.mjs  # 130 reservas simultâneas
│   └── test-carga.mjs         # Medição de desempenho
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
└── DOCUMENTO.md      # Documentação completa do projeto
```

## Roteiro de apresentação (5 minutos)

1. **Problema:** em um show com 100 ingressos, reservas simultâneas podem estourar o limite se o código só contar e depois atualizar.
2. **API:** demonstrar registro, login, token JWT, criação de pedido e reserva via endpoints HTTP/JSON.
3. **Regras:** mostrar 2 ingressos por pessoa, 100 globais, estados e erro 404 para pedido de não-dono.
4. **Concorrência:** explicar fila FIFO, transação, bloqueio `FOR UPDATE`, `COMMIT/ROLLBACK` e por que duas pessoas não conseguem a última vaga.
5. **Teste:** rodar `npm run test:concorrencia` no contêiner e mostrar exatamente 100/100 e erros 409; citar `X-Lote: 7F3A`.

## Segurança e observações

- Senhas salvas usando hash bcrypt, não texto puro.
- Credenciais de banco e `JWT_SECRET` são valores de **demonstração local**, definidos no Compose para permitir avaliação apenas com `docker compose up`.
- Em produção, usar variáveis/segredos externos, HTTPS e outras medidas de proteção.
- Apenas a porta 8080 da API é publicada no host. O banco não é exposto.
- Não existe interface gráfica obrigatória: a entrega consiste na API, banco, Docker e documentação.
