# API sob Alta Demanda — Documento do Projeto

Este documento explica o projeto do início ao fim: o problema, as tecnologias, o funcionamento, o código, a estratégia de concorrência, os testes realizados e as limitações conhecidas. Ele também serve como **material de estudo**, com leitura guiada do código, laboratórios práticos, exercícios e um resumo para revisão. Complementa o [README.md](README.md), que traz as instruções rápidas de execução.

## Sumário

1. [Como estudar com este documento](#1-como-estudar-com-este-documento)
2. [Apresentação do projeto](#2-apresentação-do-projeto)
3. [Tecnologias utilizadas](#3-tecnologias-utilizadas)
4. [Estrutura de pastas](#4-estrutura-de-pastas)
5. [Arquitetura e funcionamento](#5-arquitetura-e-funcionamento)
6. [Leitura guiada do código](#6-leitura-guiada-do-código)
7. [Banco de dados](#7-banco-de-dados)
8. [Endpoints](#8-endpoints)
9. [Concorrência](#9-concorrência)
10. [Testes executados](#10-testes-executados)
11. [Como executar](#11-como-executar)
12. [Laboratórios práticos](#12-laboratórios-práticos)
13. [Limitações conhecidas](#13-limitações-conhecidas)
14. [Exercícios de fixação](#14-exercícios-de-fixação)
15. [Perguntas prováveis do professor](#15-perguntas-prováveis-do-professor)
16. [Roteiro de apresentação de 5 minutos](#16-roteiro-de-apresentação-de-5-minutos)
17. [Resumo para revisão rápida](#17-resumo-para-revisão-rápida)
18. [Glossário](#18-glossário)
19. [Respostas dos exercícios](#19-respostas-dos-exercícios)

---

## 1. Como estudar com este documento

### Trilha sugerida

| Etapa | O que fazer | Seções | Tempo aproximado |
|---|---|---|---|
| 1. Entender o problema | Ler o que é o sistema e por que a concorrência é perigosa. | 2 e 9.1–9.2 | 15 min |
| 2. Ver o todo | Entender as peças (API, fila, banco) e o caminho de uma requisição. | 3, 4 e 5 | 20 min |
| 3. Ler o código | Acompanhar os arquivos de `src/` com o documento aberto ao lado. | 6 | 40 min |
| 4. Entender os dados | Tabelas, estados do pedido e por que não há contador de vagas. | 7 | 15 min |
| 5. Dominar a concorrência | Bloqueio, transação, fila, cota e FIFO. É a parte mais cobrada. | 9 | 40 min |
| 6. Praticar | Subir o sistema, chamar a API e fazer os laboratórios. | 11 e 12 | 60 min |
| 7. Fixar | Responder os exercícios sem olhar e conferir as respostas. | 14 e 19 | 30 min |
| 8. Apresentar | Treinar as perguntas e o roteiro de 5 minutos. | 15, 16 e 17 | 30 min |

### Checklist: "eu sei explicar…"

Marque cada item quando conseguir explicá-lo **em voz alta, sem ler**:

- [ ] Por que "contar e depois gravar" causa 101 ingressos vendidos.
- [ ] O que acontece, na ordem, quando chega um `POST /pedidos/42/reservar`.
- [ ] O que fazem `BEGIN`, `SELECT ... FOR UPDATE`, `COMMIT` e `ROLLBACK`.
- [ ] Por que o bloqueio é na linha do **show** e não na do pedido.
- [ ] Como a fila em memória funciona usando apenas uma `Promise`.
- [ ] A diferença entre atomicidade, serialização e justiça FIFO.
- [ ] Por que a cota de 2 reservas não é burlada por requisições simultâneas.
- [ ] Por que cancelar devolve a vaga sem precisar de contador.
- [ ] Como o JWT identifica o usuário e por que a senha é salva como hash.
- [ ] Qual é a principal limitação do projeto (latência e instância única).

---

## 2. Apresentação do projeto

### Objetivo

A API permite reservar ingressos para um show. O usuário se cadastra, faz login, cria um pedido, reserva esse pedido e, se quiser, cancela a reserva. Também é possível consultar quantas vagas estão ocupadas e quantas estão livres.

### O problema

Vender ingressos parece simples: basta contar quantos já foram reservados e, se ainda houver vaga, confirmar mais um. O problema aparece quando **muitas pessoas tentam ao mesmo tempo**.

Imagine que resta um único ingresso e duas pessoas clicam em "reservar" no mesmo instante. Se o sistema apenas contar e depois gravar, as duas requisições podem ler "99 ocupadas", as duas concluem que há vaga e as duas gravam. O resultado seria 101 ingressos vendidos para um show de 100 lugares. Esse erro é chamado de *overselling* e nasce de uma **condição de corrida**.

O objetivo central do projeto é impedir que isso aconteça, mesmo com centenas de requisições simultâneas.

> **Analogia:** pense em um único banheiro com uma chave. Quem pega a chave entra; os outros esperam na porta. Ninguém confere "se está livre" e entra junto com outra pessoa. No projeto, a "chave" é o bloqueio da linha do show no banco de dados.

### Regras de negócio

| Regra | Valor |
|---|---|
| Limite global de ingressos reservados | 100 |
| Limite de reservas ativas por usuário | 2 |
| Show disponível | apenas o de ID 7 |
| Quem pode reservar ou cancelar um pedido | somente o dono do pedido |

Uma reserva "ativa" é um pedido no estado `RESERVADO`. Pedidos apenas criados (`NO_CARRINHO`) ou cancelados (`CANCELADO`) não ocupam vaga nem contam na cota pessoal.

---

## 3. Tecnologias utilizadas

| Tecnologia | O que é | Função neste projeto |
|---|---|---|
| **Node.js 22** | Ambiente que executa JavaScript fora do navegador. | Executa a API. Processa as requisições em uma única thread principal, o que torna a fila em memória simples e segura. |
| **Express 5** | Biblioteca para criar servidores HTTP em Node.js. | Define as rotas (`/auth/login`, `/pedidos` etc.), interpreta o JSON recebido e centraliza o tratamento de erros. Na versão 5, erros lançados dentro de funções `async` chegam sozinhos ao tratador de erros. |
| **PostgreSQL 17** | Banco de dados relacional. | Guarda usuários, o show e os pedidos. Fornece as transações e os bloqueios de linha que garantem a consistência das reservas. |
| **pg** | Biblioteca que conecta Node.js ao PostgreSQL. | Mantém um conjunto (pool) de até 15 conexões reutilizáveis com o banco e envia os comandos SQL. |
| **JWT (jsonwebtoken)** | Padrão de token assinado digitalmente. | Depois do login, a API entrega um token. Nas rotas protegidas, o token prova quem é o usuário sem consultar a senha novamente. Usa o algoritmo HS256 e vale 24 horas. |
| **bcryptjs** | Biblioteca de hash de senhas. | Transforma a senha em um hash antes de salvar. A senha original nunca é gravada no banco. |
| **Docker** | Ferramenta que empacota um programa com tudo de que ele precisa. | Empacota a API em uma imagem baseada em `node:22-alpine`. Quem avalia não precisa instalar Node.js nem PostgreSQL. |
| **Docker Compose** | Ferramenta que sobe vários contêineres juntos. | Sobe o banco e a API com um único comando, cria as tabelas automaticamente e só inicia a API depois que o banco está pronto. |

O arquivo `package-lock.json` fixa a versão exata de todas as dependências, inclusive as indiretas. O `Dockerfile` usa `npm ci`, que instala exatamente o que está nesse arquivo, tornando o build reproduzível.

O Docker é **opcional**: o projeto também roda com Node.js e PostgreSQL instalados diretamente no Windows (seção 11.2).

---

## 4. Estrutura de pastas

```text
.
├── src/
│   ├── app.js          # Servidor Express: rotas, validações e respostas HTTP
│   ├── auth.js         # Geração e verificação do token JWT
│   ├── db.js           # Pool de conexões com o PostgreSQL
│   ├── erros.js        # Classe de erro HTTP padronizado
│   └── reservas.js     # Fila em memória + transação de reserva e cancelamento
├── database/
│   └── init.sql        # Criação das tabelas e do show de ID 7
├── scripts/
│   ├── test-api.mjs              # Teste funcional sequencial
│   ├── test-regras.mjs           # Regras de negócio sob concorrência
│   ├── test-concorrencia.mjs     # 130 reservas simultâneas
│   ├── test-carga.mjs            # Medição de desempenho progressiva
│   ├── iniciar-local.ps1         # Sem Docker: liga o PostgreSQL e a API
│   ├── parar-local.ps1           # Sem Docker: desliga o PostgreSQL
│   └── resetar-banco-local.ps1   # Sem Docker: apaga e recria o banco
├── Dockerfile          # Como construir a imagem da API
├── docker-compose.yml  # Como subir banco + API
├── package.json        # Dependências e scripts
├── package-lock.json   # Versões exatas das dependências
├── README.md           # Instruções rápidas
└── DOCUMENTO.md        # Este documento
```

| Arquivo | Responsabilidade |
|---|---|
| `src/app.js` | Recebe as requisições, valida os dados de entrada, chama as regras e devolve o código HTTP e o JSON. Também define o header `X-Lote` e o tratamento central de erros. |
| `src/auth.js` | `gerarToken` cria o JWT no login. `autenticar` é o middleware que exige `Authorization: Bearer <token>` e responde 401 quando o token falta ou é inválido. |
| `src/db.js` | Cria o pool de conexões. Os dados de acesso vêm de variáveis de ambiente definidas no Compose (ou no `iniciar-local.ps1`). |
| `src/erros.js` | Define `ErroHttp`, que carrega o status HTTP e o código de erro (por exemplo, 409 e `POOL_CHEIO`). |
| `src/reservas.js` | **Coração do projeto.** Contém a fila em memória e a função `alterarReserva`, que executa reserva e cancelamento dentro de uma transação com bloqueio. |
| `database/init.sql` | Executado automaticamente pelo PostgreSQL na primeira inicialização do volume (Docker) ou pelo `resetar-banco-local.ps1` (sem Docker). |

---

## 5. Arquitetura e funcionamento

### Visão geral

```mermaid
flowchart LR
    C[Cliente HTTP] -->|JSON na porta 8080| E[API Express]
    E --> A{Token JWT válido?}
    A -->|não| R401[401 NAO_AUTORIZADO]
    A -->|sim| F[Fila em memória]
    F --> T[Transação com bloqueio]
    T --> P[(PostgreSQL)]
    P --> T
    T --> S[Resposta HTTP]
```

Somente as rotas de **reservar** e **cancelar** passam pela fila. Registro, login, criação de pedido e consulta do pool falam com o banco diretamente, porque não alteram a quantidade de vagas ocupadas.

### Passo a passo de uma reserva

```mermaid
sequenceDiagram
    participant C as Cliente
    participant API as API Express
    participant F as Fila em memória
    participant DB as PostgreSQL

    C->>API: POST /pedidos/42/reservar (Bearer token)
    API->>API: Verifica o JWT e extrai o ID do usuário
    API->>F: Enfileira a tarefa
    F->>DB: BEGIN
    F->>DB: SELECT show 7 FOR UPDATE (bloqueia)
    F->>DB: SELECT pedido 42 do usuário FOR UPDATE
    F->>DB: Conta reservas do usuário e do show
    alt Há cota e há vaga
        F->>DB: UPDATE pedido para RESERVADO
        F->>DB: COMMIT (libera o bloqueio)
        API-->>C: 200 + X-Lote: 7F3A
    else Regra violada
        F->>DB: ROLLBACK (libera o bloqueio)
        API-->>C: 404 ou 409 com o código do erro
    end
```

### Ordem das verificações na reserva

Dentro da transação, as verificações acontecem sempre nesta ordem:

1. O pedido existe **e** pertence ao usuário do token? Se não, `404 PEDIDO_NAO_ENCONTRADO`.
2. O pedido está em `NO_CARRINHO`? Se não, `409 ESTADO_INVALIDO`.
3. O usuário tem menos de 2 reservas ativas? Se não, `409 COTA_PESSOAL`.
4. O show tem menos de 100 reservas ativas? Se não, `409 POOL_CHEIO`.

A cota pessoal é verificada antes do pool. Assim, um usuário que já tem duas reservas recebe `COTA_PESSOAL` mesmo quando o show está lotado.

### Tratamento de erros

Todos os erros de regra são lançados como `ErroHttp` e convertidos em um JSON no formato `{"error": "CODIGO"}`. Erros não previstos são registrados no log e respondidos com `500 ERRO_INTERNO`.

---

## 6. Leitura guiada do código

Abra os arquivos de `src/` ao lado deste texto. Os trechos abaixo foram copiados do código real; os números de linha podem mudar um pouco se o código for editado.

### 6.1 `src/erros.js` — um erro que sabe virar resposta HTTP

```js
export class ErroHttp extends Error {
  constructor(status, codigo) {
    super(codigo);
    this.status = status;   // ex.: 409
    this.codigo = codigo;   // ex.: 'POOL_CHEIO'
  }
}
```

Em qualquer lugar do código, uma regra violada faz `throw new ErroHttp(409, 'POOL_CHEIO')`. Ninguém precisa montar a resposta HTTP na hora: o tratador central (seção 6.3) faz isso. É um jeito simples de separar **regra de negócio** de **formato da resposta**.

### 6.2 `src/db.js` — o pool de conexões

```js
export const banco = new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  // ... porta, usuário, senha e banco também vêm de variáveis de ambiente
  max: 15,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});
```

- Abrir uma conexão com o banco é caro. O **pool** mantém até 15 conexões abertas e as empresta às requisições.
- `banco.query(...)` pega uma conexão, executa e devolve sozinho. Já uma **transação** precisa de várias consultas na **mesma** conexão, por isso `reservas.js` usa `banco.connect()` e depois `cliente.release()`.
- O operador `??` usa o valor da direita quando a variável de ambiente não existe. Por isso o projeto funciona sem configurar nada além do `JWT_SECRET`.

### 6.3 `src/app.js` — rotas e respostas

**Configuração inicial**

```js
const app = express();
app.disable('x-powered-by');               // não revela que é Express
app.use(express.json({ limit: '16kb' }));  // lê o corpo JSON, até 16 kB
```

**Validação das credenciais.** `verificarCredenciais` confere se `username` e `password` são textos não vazios, com `username` de até 50 caracteres e `password` de até 72 bytes (o bcrypt ignora o que passa disso). Se algo estiver errado, lança `ErroHttp(400, 'DADOS_INVALIDOS')`.

**Registro**

```js
app.post('/auth/registrar', async (req, res) => {
  const { username, password } = verificarCredenciais(req.body);
  const hash = await bcrypt.hash(password, 10);   // custo 10 = 2^10 rodadas
  try {
    await banco.query('INSERT INTO usuarios (username, password_hash) VALUES ($1, $2)',
                      [username, hash]);
    return res.status(201).end();
  } catch (erro) {
    if (erro.code === '23505') throw new ErroHttp(409, 'USUARIO_JA_EXISTE');
    throw erro;
  }
});
```

Pontos de estudo:

- **`$1, $2` (consulta parametrizada):** os valores vão separados do SQL. Isso impede *SQL injection*, porque o texto do usuário nunca é interpretado como comando.
- **`23505`** é o código do PostgreSQL para "violação de `UNIQUE`". Em vez de primeiro perguntar "esse nome existe?" e depois inserir (o que também seria uma condição de corrida), o código tenta inserir e deixa o banco recusar o duplicado.
- **Express 5:** se `verificarCredenciais` lançar um erro dentro da função `async`, o Express 5 captura a `Promise` rejeitada e manda o erro para o tratador central. No Express 4 seria preciso um `try/catch` em cada rota.

**Login.** Busca o usuário pelo nome e compara a senha com `bcrypt.compare`. Se o usuário não existe **ou** a senha está errada, a resposta é a mesma (`401 CREDENCIAIS_INVALIDAS`), para não revelar quais nomes estão cadastrados. Se estiver tudo certo, devolve `{ token: gerarToken(usuario) }`.

**Rotas protegidas.** O `autenticar` aparece antes da função da rota:

```js
app.post('/pedidos/:id/reservar', autenticar, async (req, res) => {
  const pedido = await alterarReserva({
    pedidoId: idPedidoOu404(req),
    usuarioId: req.usuarioId,     // preenchido pelo middleware autenticar
    acao: 'reservar'
  });
  res.set('X-Lote', '7F3A');      // só chega aqui se a reserva deu certo
  return res.status(200).json(pedido);
});
```

Repare que o `X-Lote` só é definido **depois** do `await`. Se `alterarReserva` lançar um erro, a linha do header nunca é executada; é por isso que respostas de erro não têm `X-Lote`.

**Consulta do pool.** Uma única consulta SQL devolve o total e a contagem de `RESERVADO`; `livres` é calculado como `total - ocupadas` em JavaScript. Como os dois números vêm da mesma leitura, `ocupadas + livres` é sempre 100.

**Tratador central de erros** (o último `app.use`, com quatro parâmetros):

```js
app.use((erro, _req, res, _next) => {
  if (erro instanceof ErroHttp) return res.status(erro.status).json({ error: erro.codigo });
  if (erro instanceof SyntaxError && erro.status === 400 && 'body' in erro)
    return res.status(400).json({ error: 'JSON_INVALIDO' });
  console.error('Erro inesperado:', erro);
  return res.status(500).json({ error: 'ERRO_INTERNO' });
});
```

**Inicialização.** `app.listen` abre a porta 8080. Se ela já estiver em uso (por exemplo, por outra cópia da API), a mensagem `EADDRINUSE` é exibida e o processo termina com código 1. Ao receber `SIGINT` (Ctrl+C) ou `SIGTERM`, o servidor para de aceitar conexões e fecha o pool do banco antes de sair.

### 6.4 `src/auth.js` — JWT

```js
export function gerarToken(usuario) {
  return jwt.sign({ sub: String(usuario.id) }, segredo, { algorithm: 'HS256', expiresIn: '24h' });
}

export function autenticar(req, _res, next) {
  const formato = /^Bearer\s+([^\s]+)$/i.exec(req.get('Authorization') ?? '');
  if (!formato) return next(new ErroHttp(401, 'NAO_AUTORIZADO'));
  try {
    const dados = jwt.verify(formato[1], segredo, { algorithms: ['HS256'] });
    req.usuarioId = Number(dados.sub);   // (o código real ainda valida se é inteiro positivo)
    next();
  } catch {
    next(new ErroHttp(401, 'NAO_AUTORIZADO'));
  }
}
```

- O token tem três partes: cabeçalho, conteúdo (`sub` = ID do usuário, `exp` = validade) e **assinatura**. A assinatura é calculada com o `JWT_SECRET`; quem não conhece o segredo não consegue alterar o `sub` sem invalidar o token.
- O conteúdo do JWT **não é criptografado**, apenas assinado. Qualquer um pode ler o `sub`, mas não pode trocá-lo.
- `algorithms: ['HS256']` impede que um token forjado com outro algoritmo seja aceito.
- Se a variável `JWT_SECRET` não existir, a API se recusa a iniciar (`throw` no topo do arquivo). É melhor falhar cedo do que rodar com um segredo vazio.

### 6.5 `src/reservas.js` — a fila e a transação (o coração)

#### A fila feita com uma única Promise

```js
let cauda = Promise.resolve();

function enfileirar(tarefa) {
  const resultado = cauda.then(tarefa);
  cauda = resultado.catch(() => {}); // Um erro não bloqueia os próximos pedidos.
  return resultado;
}
```

Essas cinco linhas são a fila inteira. `cauda` guarda "o fim da fila": uma `Promise` que só se resolve quando a última tarefa enfileirada termina.

Simulação com três reservas chegando quase juntas (A, B e C):

| Passo | O que acontece | `cauda` passa a ser |
|---|---|---|
| 1 | Chega A. `cauda` já está resolvida, então A começa logo. | "fim de A" |
| 2 | Chega B. `cauda.then(B)` só roda B **depois** que A terminar. | "fim de B" |
| 3 | Chega C. Só roda depois que B terminar. | "fim de C" |
| 4 | A termina com erro (`POOL_CHEIO`). | — |
| 5 | Quem pediu A recebe o erro (pelo `resultado`). A fila segue para B, porque `cauda` foi feita com `.catch(() => {})`. | — |

- Sem o `.catch`, um único erro deixaria `cauda` rejeitada para sempre, e **todas** as reservas seguintes falhariam.
- Repare que a função devolve `resultado`, e não `cauda`. Assim, o chamador recebe o resultado verdadeiro da sua tarefa, inclusive o erro.
- Isso só funciona porque o Node.js executa o JavaScript em **uma thread**: a atribuição `cauda = ...` nunca é interrompida no meio por outra requisição.

#### A transação

```js
export function alterarReserva({ pedidoId, usuarioId, acao }) {
  return enfileirar(async () => {
    const cliente = await banco.connect();   // uma conexão só para esta transação
    let transacaoAtiva = false;
    try {
      await cliente.query('BEGIN');
      transacaoAtiva = true;

      // 1) Catraca: bloqueia a linha do show
      const show = await cliente.query(
        'SELECT total_vagas FROM shows WHERE id = $1 FOR UPDATE', [SHOW_ID]);

      // 2) O pedido precisa ser do usuário (senão, 404)
      const pedido = await cliente.query(
        `SELECT id, status FROM pedidos
         WHERE id = $1 AND usuario_id = $2 AND show_id = $3 FOR UPDATE`,
        [pedidoId, usuarioId, SHOW_ID]);
      if (!pedido.rowCount) throw new ErroHttp(404, 'PEDIDO_NAO_ENCONTRADO');

      if (acao === 'reservar') {
        // 3) Estado, 4) cota pessoal, 5) pool — contados COM o bloqueio mantido
        // ...
        await cliente.query(`UPDATE pedidos SET status = 'RESERVADO' ... WHERE id = $1`, [pedidoId]);
      } else if (acao === 'cancelar') {
        // só RESERVADO pode virar CANCELADO
      }

      await cliente.query('COMMIT');           // grava e libera os bloqueios
      transacaoAtiva = false;
      return { id: ..., status: ... };
    } catch (erro) {
      if (transacaoAtiva) await cliente.query('ROLLBACK');  // desfaz e libera
      throw erro;
    } finally {
      cliente.release();                       // devolve a conexão ao pool, sempre
    }
  });
}
```

| Detalhe do código | Por que existe |
|---|---|
| `banco.connect()` em vez de `banco.query()` | `BEGIN`, as consultas e o `COMMIT` precisam ir pela **mesma** conexão. Com `banco.query`, cada comando poderia cair em uma conexão diferente. |
| `FOR UPDATE` no show **antes** de contar | Garante que a contagem não fica desatualizada entre a leitura e a gravação. |
| `usuario_id = $2` no `WHERE` do pedido | A verificação de dono já vem na consulta: pedido de outra pessoa simplesmente "não existe" (404). |
| Uma única consulta com duas subconsultas `COUNT` | Conta a cota pessoal e a ocupação do show de uma vez. |
| `pessoal >= 2` testado antes de `ocupadas >= 100` | Define a prioridade dos erros: `COTA_PESSOAL` vence `POOL_CHEIO`. |
| `transacaoAtiva` | Evita mandar `ROLLBACK` se o erro aconteceu antes do `BEGIN` (por exemplo, falha ao conectar). |
| `finally { cliente.release() }` | A conexão volta ao pool com sucesso **ou** erro. Sem isso, cada erro "vazaria" uma conexão e, depois de 15, a API travaria. |

### 6.6 `database/init.sql`

Cria as três tabelas, insere o show 7 e cria dois índices parciais. Os detalhes estão na seção 7.

---

## 7. Banco de dados

### Modelo

```mermaid
erDiagram
    USUARIOS ||--o{ PEDIDOS : possui
    SHOWS ||--o{ PEDIDOS : recebe

    USUARIOS {
        bigserial id PK
        varchar username UK
        text password_hash
        timestamptz criado_em
    }
    SHOWS {
        integer id PK
        integer total_vagas
    }
    PEDIDOS {
        bigserial id PK
        bigint usuario_id FK
        integer show_id FK
        varchar status
        timestamptz criado_em
        timestamptz atualizado_em
    }
```

### Tabelas

- **`usuarios`**: um registro por pessoa cadastrada. O `username` é único (`UNIQUE`); é essa restrição que gera o erro de usuário duplicado. A senha é guardada apenas como hash.
- **`shows`**: contém uma única linha, o show de ID 7, com `total_vagas = 100`. Um `CHECK (total_vagas = 100)` impede alterar esse total. Essa linha também serve como **ponto de bloqueio** das reservas (ver seção 9).
- **`pedidos`**: cada pedido pertence a um usuário e a um show (chaves estrangeiras). O `status` só aceita três valores, garantidos por um `CHECK`.

### Como as vagas são contadas

Não existe uma coluna "vagas ocupadas". A ocupação é sempre calculada contando os pedidos com `status = 'RESERVADO'`. Isso evita que um contador separado fique diferente da realidade.

### Índices

Dois índices parciais aceleram as contagens, pois incluem apenas os pedidos `RESERVADO`:

- `idx_pedidos_ativos_show`: reservas ativas por show.
- `idx_pedidos_ativos_usuario`: reservas ativas por usuário.

Um índice parcial (`... WHERE status = 'RESERVADO'`) é menor que um índice comum, porque ignora os pedidos no carrinho e os cancelados, que nunca entram nessas contagens.

### Estados do pedido

```mermaid
stateDiagram-v2
    [*] --> NO_CARRINHO: POST /pedidos
    NO_CARRINHO --> RESERVADO: reservar
    RESERVADO --> CANCELADO: cancelar
    CANCELADO --> [*]
```

| Estado | Ocupa vaga? | Conta na cota pessoal? |
|---|---|---|
| `NO_CARRINHO` | Não | Não |
| `RESERVADO` | Sim | Sim |
| `CANCELADO` | Não | Não |

Qualquer outra transição (reservar um pedido já reservado ou cancelado, cancelar um pedido que não está reservado) responde `409 ESTADO_INVALIDO`.

---

## 8. Endpoints

Todas as respostas de erro têm o formato `{"error": "CODIGO"}`. As rotas marcadas com 🔒 exigem o header `Authorization: Bearer <token>`; sem ele ou com token inválido, a resposta é `401 {"error":"NAO_AUTORIZADO"}`.

### Resumo

| Método e rota | 🔒 | Sucesso | Erros possíveis |
|---|---|---|---|
| `POST /auth/registrar` | | 201 | 400, 409 `USUARIO_JA_EXISTE` |
| `POST /auth/login` | | 200 + token | 400, 401 `CREDENCIAIS_INVALIDAS` |
| `POST /pedidos` | 🔒 | 201 `NO_CARRINHO` | 404 `SHOW_NAO_ENCONTRADO` |
| `POST /pedidos/{id}/reservar` | 🔒 | 200 `RESERVADO` + `X-Lote` | 404, 409 `ESTADO_INVALIDO` / `COTA_PESSOAL` / `POOL_CHEIO` |
| `POST /pedidos/{id}/cancelar` | 🔒 | 200 `CANCELADO` | 404, 409 `ESTADO_INVALIDO` |
| `GET /pool` | 🔒 | 200 `{total, ocupadas, livres}` | — |

### 8.1 `POST /auth/registrar`

Cadastra um usuário. Não exige autenticação.

Body:

```json
{ "username": "joao", "password": "senha123" }
```

| Situação | Resposta |
|---|---|
| Sucesso | `201 Created`, sem corpo |
| Dados ausentes ou inválidos | `400 {"error":"DADOS_INVALIDOS"}` |
| JSON malformado | `400 {"error":"JSON_INVALIDO"}` |
| Usuário já cadastrado | `409 {"error":"USUARIO_JA_EXISTE"}` |

Regras de validação: `username` é texto não vazio de até 50 caracteres; `password` é texto não vazio de até 72 bytes (limite do bcrypt).

### 8.2 `POST /auth/login`

Autentica e devolve o token. Não exige autenticação.

Body:

```json
{ "username": "joao", "password": "senha123" }
```

Sucesso, `200 OK`:

```json
{ "token": "eyJhbGciOiJIUzI1NiIs..." }
```

| Situação | Resposta |
|---|---|
| Dados ausentes ou inválidos | `400 {"error":"DADOS_INVALIDOS"}` |
| Usuário inexistente ou senha errada | `401 {"error":"CREDENCIAIS_INVALIDAS"}` |

### 8.3 `POST /pedidos` 🔒

Cria um pedido no estado `NO_CARRINHO`. Criar um pedido **não** ocupa vaga.

Body:

```json
{ "showId": 7 }
```

Sucesso, `201 Created`:

```json
{ "id": 42, "status": "NO_CARRINHO" }
```

| Situação | Resposta |
|---|---|
| `showId` diferente de 7 (ou ausente) | `404 {"error":"SHOW_NAO_ENCONTRADO"}` |

### 8.4 `POST /pedidos/{id}/reservar` 🔒

Reserva um ingresso para o pedido. Não tem body.

Sucesso, `200 OK`, **com o header `X-Lote: 7F3A`**:

```json
{ "id": 42, "status": "RESERVADO" }
```

| Situação | Resposta |
|---|---|
| Pedido inexistente ou de outro usuário | `404 {"error":"PEDIDO_NAO_ENCONTRADO"}` |
| Pedido já reservado ou cancelado | `409 {"error":"ESTADO_INVALIDO"}` |
| Usuário já tem 2 reservas ativas | `409 {"error":"COTA_PESSOAL"}` |
| As 100 vagas estão ocupadas | `409 {"error":"POOL_CHEIO"}` |

O header `X-Lote` aparece **somente** nas reservas bem-sucedidas. Respostas de erro não o contêm.

### 8.5 `POST /pedidos/{id}/cancelar` 🔒

Cancela uma reserva e devolve a vaga ao pool. Não tem body.

Sucesso, `200 OK` (sem `X-Lote`):

```json
{ "id": 42, "status": "CANCELADO" }
```

| Situação | Resposta |
|---|---|
| Pedido inexistente ou de outro usuário | `404 {"error":"PEDIDO_NAO_ENCONTRADO"}` |
| Pedido que não está `RESERVADO` | `409 {"error":"ESTADO_INVALIDO"}` |

### 8.6 `GET /pool` 🔒

Mostra a ocupação do show.

Sucesso, `200 OK`:

```json
{ "total": 100, "ocupadas": 37, "livres": 63 }
```

`ocupadas` é contado em uma única consulta e `livres` é calculado como `total - ocupadas`. Por isso `ocupadas + livres` é sempre 100.

### Observações

- Pedidos de outro usuário respondem 404, igual a um pedido inexistente. Assim, ninguém descobre quais IDs existem.
- Existe uma rota extra, `GET /health`, sem autenticação, usada pelo Docker para saber se a API está no ar. Ela não faz parte do enunciado.
- Qualquer rota não definida responde `404 {"error":"ROTA_NAO_ENCONTRADA"}`.

---

## 9. Concorrência

Esta é a parte mais importante do projeto.

### 9.1 O que é uma condição de corrida

Uma condição de corrida acontece quando o resultado de um programa depende da **ordem em que operações simultâneas se intercalam**. O erro clássico é o padrão "verificar e depois agir": entre a verificação e a ação, outra requisição pode mudar a situação.

### 9.2 A disputa pela última vaga (versão ingênua)

Suponha 99 vagas ocupadas e duas pessoas, Ana e Bruno, reservando ao mesmo tempo em um sistema **sem proteção**:

| Momento | Requisição da Ana | Requisição do Bruno |
|---|---|---|
| 1 | Conta as reservas: 99 | |
| 2 | | Conta as reservas: 99 |
| 3 | 99 < 100, há vaga | |
| 4 | | 99 < 100, há vaga |
| 5 | Grava RESERVADO (100) | |
| 6 | | Grava RESERVADO (**101**) |

As duas decisões foram tomadas com a mesma informação, que já estava desatualizada quando Bruno gravou.

> **Por que isso acontece mesmo com o Node.js sendo de uma thread?** Porque cada `await banco.query(...)` devolve o controle ao Node enquanto espera o banco. Nesse intervalo, outra requisição pode rodar o seu próprio `COUNT`. A thread é única, mas as esperas se intercalam.

### 9.3 A solução deste projeto: duas camadas

O projeto usa duas proteções que trabalham juntas, ambas em `src/reservas.js`.

**Camada 1 — Fila em memória (dentro da API).** Toda reserva e todo cancelamento entram em uma fila. A API executa uma tarefa de cada vez, na ordem em que as tarefas foram enfileiradas pelo processo Node. A próxima só começa quando a anterior termina, com sucesso ou com erro. Um erro em uma tarefa não trava as seguintes.

**Camada 2 — Transação com bloqueio (dentro do PostgreSQL).** Cada tarefa abre uma transação e bloqueia a linha do show antes de contar qualquer coisa. Essa camada protege os dados mesmo que exista mais de um processo acessando o banco.

### 9.4 BEGIN, SELECT FOR UPDATE, COMMIT e ROLLBACK

- **`BEGIN`** abre uma transação: um conjunto de comandos tratado como uma unidade.
- **`SELECT ... FOR UPDATE`** lê uma linha e a **bloqueia**. Qualquer outra transação que tente bloquear a mesma linha fica esperando.
- **`COMMIT`** confirma tudo o que a transação fez e libera os bloqueios.
- **`ROLLBACK`** desfaz tudo o que a transação fez e também libera os bloqueios.

No projeto, a primeira ação de toda reserva ou cancelamento é:

```sql
SELECT total_vagas FROM shows WHERE id = 7 FOR UPDATE;
```

Como só existe uma linha de show, ela funciona como uma **catraca**: só passa uma transação por vez. Quem chega enquanto a catraca está ocupada espera o `COMMIT` ou o `ROLLBACK` de quem está dentro. O laboratório 12.2 mostra isso acontecendo na prática.

### 9.5 Por que duas transações não reservam a mesma vaga

A contagem de reservas é feita **depois** de obter o bloqueio, e o bloqueio só é liberado **depois** de gravar. Portanto, quando uma transação conta, nenhuma outra pode estar no meio de uma reserva. A contagem está sempre atualizada.

A mesma disputa entre Ana e Bruno, agora com o bloqueio:

| Momento | Transação da Ana | Transação do Bruno |
|---|---|---|
| 1 | `BEGIN` | `BEGIN` |
| 2 | Bloqueia o show ✅ | Tenta bloquear o show ⏳ espera |
| 3 | Conta: 99 ocupadas | ⏳ |
| 4 | 99 < 100: grava RESERVADO | ⏳ |
| 5 | `COMMIT` (libera o bloqueio) | Obtém o bloqueio ✅ |
| 6 | Resposta 200 + `X-Lote: 7F3A` | Conta: **100** ocupadas |
| 7 | | 100 não é menor que 100: `ROLLBACK` |
| 8 | | Resposta 409 `POOL_CHEIO` |

Com uma única instância da API, a fila em memória já impede que as duas transações rodem ao mesmo tempo; o bloqueio do banco é a segunda barreira.

> **Detalhe técnico:** no nível de isolamento padrão do PostgreSQL (*Read Committed*), cada comando enxerga os dados confirmados até o momento em que **ele** começa. Como o `COUNT` do Bruno só executa depois de ele obter o bloqueio (ou seja, depois do `COMMIT` da Ana), ele já enxerga a reserva dela.

### 9.6 Como a cota de duas reservas é protegida

A contagem das reservas do usuário é feita **dentro da mesma transação**, depois do bloqueio do show. Como todas as reservas passam por esse bloqueio, duas reservas do mesmo usuário nunca são avaliadas ao mesmo tempo. Se um usuário disparar cinco reservas simultâneas, elas são processadas uma por uma: as duas primeiras encontram 0 e 1 reservas ativas e são aprovadas; as três seguintes encontram 2 e recebem `COTA_PESSOAL`.

O mesmo vale para várias tentativas sobre o **mesmo pedido**: a primeira muda o estado para `RESERVADO`; as demais encontram o pedido já reservado e recebem `ESTADO_INVALIDO`.

### 9.7 Por que cancelar libera uma vaga

A ocupação é a contagem de pedidos `RESERVADO`. Ao cancelar, o pedido passa a `CANCELADO` e simplesmente deixa de ser contado. Não há contador para decrementar, então não há risco de o contador ficar errado.

O cancelamento usa a mesma fila e o mesmo bloqueio da reserva. Assim, um cancelamento e uma reserva simultâneos também são processados um de cada vez.

### 9.8 Como o banco preserva a consistência

- Se qualquer passo falhar, o `ROLLBACK` desfaz a transação inteira. Não existe "meia reserva".
- A conexão é sempre devolvida ao pool, com sucesso ou com erro.
- O `CHECK` do status impede valores fora dos três estados.
- As chaves estrangeiras impedem pedidos de usuários ou shows inexistentes.
- A consulta do pool lê apenas dados já confirmados (`COMMIT`), em uma única consulta.

### 9.9 Atomicidade, serialização e justiça FIFO

São três ideias diferentes, e é importante não confundi-las:

| Conceito | Pergunta que responde | Quem garante no projeto |
|---|---|---|
| **Atomicidade** | A operação acontece por inteiro ou não acontece? | A transação (`BEGIN` ... `COMMIT`/`ROLLBACK`). |
| **Serialização** | As operações concorrentes se comportam como se fossem executadas uma de cada vez? | O bloqueio da linha do show (e, em uma instância, também a fila). |
| **Justiça FIFO** | Quem pediu primeiro é atendido primeiro? | A fila em memória, **dentro de uma instância**. |

Atomicidade e serialização garantem a **integridade**: nunca mais de 100 reservas, nunca mais de 2 por usuário. Elas não dizem nada sobre **quem** fica com a última vaga. Isso é assunto da justiça FIFO.

### 9.10 O que a fila garante e o que ela não garante

A fila garante que as tarefas são executadas **na ordem em que o processo Node as enfileirou**.

A fila **não** garante a ordem cronológica em que as pessoas clicaram, nem a ordem em que os pacotes chegaram pela rede. Entre o clique do usuário e a entrada na fila existem a rede, o sistema operacional e a leitura das conexões pelo Node. Duas requisições enviadas quase no mesmo instante podem ser enfileiradas em qualquer ordem.

### 9.11 Limitação com múltiplas instâncias

A fila vive na memória de **um** processo. Se a API fosse executada em duas ou mais instâncias, cada uma teria a sua própria fila, sem conhecimento da outra.

- A **integridade** continuaria sendo responsabilidade do bloqueio no PostgreSQL, que é compartilhado por todas as instâncias. Este cenário, porém, **não foi testado** neste projeto.
- A **ordem FIFO global** deixaria de existir. Para tê-la, seria necessária uma fila compartilhada, externa à API.

O `docker-compose.yml` desta entrega executa uma única instância da API.

### 9.12 Deadlocks

Um deadlock ocorre quando duas transações esperam uma pela outra para sempre. No projeto, toda transação de reserva ou cancelamento bloqueia os recursos **sempre na mesma ordem**: primeiro o show, depois o pedido. Com a ordem fixa, não se forma o ciclo de espera necessário para um deadlock.

### 9.13 Outras soluções possíveis (para comparar)

Conhecer alternativas ajuda a justificar a escolha feita:

| Alternativa | Como funcionaria | Por que não foi a escolhida |
|---|---|---|
| `UPDATE` condicional atômico | Um contador `ocupadas` na tabela `shows` e `UPDATE shows SET ocupadas = ocupadas + 1 WHERE id = 7 AND ocupadas < 100`. Se nenhuma linha mudar, o pool está cheio. | Exigiria manter um contador sincronizado com os pedidos e ainda assim conferir a cota pessoal. A contagem direta é mais simples de provar correta. |
| Isolamento `SERIALIZABLE` | O banco detecta conflitos e aborta uma das transações, que precisa ser repetida. | Exige lógica de nova tentativa em caso de erro de serialização. O `FOR UPDATE` é mais explícito e fácil de explicar. |
| Fila externa (Redis, RabbitMQ) | Todas as instâncias da API publicam em uma fila única. | Dá FIFO global com várias instâncias, mas acrescenta infraestrutura que o enunciado não exige. |
| Só a fila em memória, sem bloqueio | A fila sozinha já serializa em uma instância. | Não protege se houver outra instância ou outro programa alterando o banco. |

---

## 10. Testes executados

Os resultados abaixo são reais, obtidos em 14/11/2026 com o banco recém-criado (`docker compose down -v` seguido de `docker compose up --build -d`).

### 10.1 Teste funcional — `npm test`

Fluxo sequencial com dois usuários: registro, usuário duplicado (409), login, criação de pedidos, reserva por não-dono (404), duas reservas com `X-Lote`, terceira reserva recusada por `COTA_PESSOAL`, cancelamento, nova reserva na vaga liberada e conferência do pool. **Resultado: aprovado.**

### 10.2 Regras sob concorrência — `npm run test:regras`

| Cenário | Resultado observado |
|---|---|
| 5 reservas simultâneas do mesmo usuário | 2 aprovadas, 3 `COTA_PESSOAL` |
| 10 reservas simultâneas do mesmo pedido | 1 aprovada, 9 `ESTADO_INVALIDO`; pool subiu apenas 1 |
| 120 reservas simultâneas (60 usuários × 2), pool vazio | 100 aprovadas, 20 `POOL_CHEIO`; pool 100/100 |
| Cancelamento com pool cheio | Pool foi a 99/100; nova reserva aprovada; pool voltou a 100/100 |
| Pool cheio, 10 cancelamentos + 30 reservas simultâneos | 10 aprovadas; pool final 100/100 |
| Pedido de outro usuário | 404 ao reservar e ao cancelar; pool inalterado |
| Header `X-Lote` | `7F3A` em todos os sucessos; ausente em todos os erros e no cancelamento |
| Invariantes do pool | Mais de 300 leituras de `/pool` durante as rajadas, todas com `ocupadas <= 100` e `ocupadas + livres = 100` |

O teste foi executado duas vezes seguidas com o mesmo resultado, pois devolve o pool vazio ao final. **Resultado: aprovado.**

### 10.3 Concorrência — `npm run test:concorrencia`

65 usuários, 130 pedidos e 130 reservas disparadas ao mesmo tempo.

| Medida | Valor |
|---|---|
| Reservas aprovadas | 100 |
| Recusadas com `POOL_CHEIO` | 30 |
| Outras respostas | 0 |
| Pool antes | 0/100 |
| Pool depois | 100/100 |

**Resultado: aprovado.**

### 10.4 Pré-condições

Os três testes **falham explicitamente** se o pool não estiver no estado inicial exigido, em vez de pular verificações. Isso foi conferido executando-os com o pool cheio: os três terminaram com erro e mensagem de pré-condição.

> Se um teste voltar ao prompt **sem** mostrar nem "✓" nem "FALHA", ele foi interrompido (por exemplo, com Ctrl+C) antes de terminar. A etapa "Preparando 65 usuários..." pode levar alguns segundos, porque cada cadastro calcula um hash bcrypt.

### 10.5 Desempenho — `npm run test:carga`

**Contexto da medição:** requisições disparadas do próprio computador para `localhost:8080`, uma única instância da API, timeout do cliente de 15 segundos. Todas as requisições de cada linha foram enviadas ao mesmo tempo. Os tempos variam conforme a máquina.

| Rajada simultânea | Total | 2xx | 409 | 5xx | Timeouts | p50 | p95 | Máxima |
|---|---|---|---|---|---|---|---|---|
| Registrar | 100 | 100 | 0 | 0 | 0 | 4074 ms | 7331 ms | 7605 ms |
| Login | 100 | 100 | 0 | 0 | 0 | 3495 ms | 6559 ms | 6877 ms |
| Criar pedidos | 200 | 200 | 0 | 0 | 0 | 349 ms | 560 ms | 589 ms |
| Criar pedidos | 500 | 500 | 0 | 0 | 0 | 786 ms | 1202 ms | 1240 ms |
| Criar pedidos | 1000 | 1000 | 0 | 0 | 0 | 2391 ms | 2797 ms | 2894 ms |
| Reservar | 200 | 100 | 100 | 0 | 0 | 836 ms | 1178 ms | 1217 ms |
| Reservar | 500 | 100 | 400 | 0 | 0 | 1274 ms | 2103 ms | 2195 ms |
| Reservar | 1000 | 100 | 900 | 0 | 0 | 2373 ms | 4046 ms | 4235 ms |
| Cancelar (após a rajada de 1000) | 100 | 100 | 0 | 0 | 0 | 432 ms | 653 ms | 676 ms |

Leitura dos resultados:

- Em todos os estágios foram aprovadas **exatamente 100** reservas, e o pool voltou a 0/100 após os cancelamentos.
- **Zero respostas 5xx e zero timeouts** em todos os cenários medidos.
- p50 é o tempo que metade das requisições não ultrapassou; p95 é o tempo que 95% não ultrapassaram.
- A latência das reservas cresce com o tamanho da rajada, porque elas são processadas uma de cada vez (cerca de 4 ms por reserva nesta máquina).
- Não foram medidas rajadas acima de 1000 requisições simultâneas.

### 10.6 Execução sem Docker (Windows, 16/11/2026)

Os três testes também foram executados com Node.js 22.23.5 e PostgreSQL 17.12 instalados diretamente no Windows, em um computador modesto (Intel Celeron 3865U, 2 núcleos, 8 GB de RAM), com o banco recriado pelo `resetar-banco-local.ps1`.

| Teste | Resultado |
|---|---|
| `npm test` | Aprovado |
| `npm run test:regras` | Aprovado, com todas as invariantes do pool íntegras |
| `npm run test:concorrencia` | 100 aprovadas, 30 `POOL_CHEIO`, pool 100/100; lote de reservas entre 0,7 s e 3,1 s |

Isso mostra que a correção da estratégia não depende do Docker: ela está no código e no banco.

---

## 11. Como executar

Há duas formas: com Docker (recomendada para quem vai avaliar) ou sem Docker (útil em computadores que não suportam o Docker).

### 11.1 Com Docker

O único pré-requisito é o Docker com Docker Compose.

Na raiz do projeto:

```bash
docker compose down -v
docker compose up --build -d
```

- `docker compose down -v` para os contêineres deste projeto e **apaga o volume do banco**. Isso garante um início limpo: 0 reservas.
- `docker compose up --build -d` constrói a imagem da API, sobe o banco, cria as tabelas, espera o banco ficar pronto e então sobe a API em segundo plano.

A API fica disponível em **http://localhost:8080**.

Verificar o estado:

```bash
docker compose ps
docker compose logs api
curl http://localhost:8080/health
```

Os dois contêineres devem aparecer como `healthy`, e o último comando deve responder `{"status":"ok"}`.

Executar os testes automatizados (o Node.js já está dentro do contêiner). Com o banco recém-criado, nesta ordem:

```bash
docker compose exec -T api npm test
docker compose exec -T api npm run test:regras
docker compose exec -T api npm run test:concorrencia
```

O último teste deixa o pool cheio. Para repetir os testes ou executar a medição de carga, reinicie o banco com os dois comandos de subida e então:

```bash
docker compose exec -T api npm run test:carga
```

### 11.2 Sem Docker (Windows)

**Pré-requisitos** (instalados uma única vez):

| Programa | Observação |
|---|---|
| Node.js 22 ou superior | Versão portátil em `%LOCALAPPDATA%\Programs\nodejs` |
| PostgreSQL 17 | Binários portáteis em `%LOCALAPPDATA%\Programs\pgsql`; dados em `%LOCALAPPDATA%\pgdata-ingressos` |
| Microsoft Visual C++ Redistributable (x64) | Necessário para o PostgreSQL funcionar no Windows |
| Dependências do projeto | `npm ci` na pasta do projeto |
| Política de execução do PowerShell | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, uma vez, para o `npm` e os scripts funcionarem |

O banco local usa o usuário `ingressos` com a senha `senha-local-apenas` (os mesmos valores padrão de `src/db.js`). O administrador do PostgreSQL local é `postgres`, com senha `admin-local`. São senhas de demonstração, e o banco aceita conexões apenas do próprio computador.

**Uso no dia a dia** (PowerShell, na pasta do projeto):

```powershell
# Terminal 1: liga o PostgreSQL e a API (deixe esta janela aberta; Ctrl+C para parar a API)
scripts\iniciar-local.ps1

# Terminal 2: testes, nesta ordem
npm test
npm run test:regras
npm run test:concorrencia

# Para repetir os testes do zero: pare a API (Ctrl+C) e recrie o banco
scripts\resetar-banco-local.ps1

# Ao terminar: desliga o PostgreSQL
scripts\parar-local.ps1
```

**Problemas comuns:**

| Sintoma | Causa e solução |
|---|---|
| `npm.ps1 não pode ser carregado...` | Política de execução do PowerShell. Rode `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` ou use `npm.cmd` no lugar de `npm`. |
| `Não foi possível abrir a porta 8080: EADDRINUSE` | Já existe outra cópia da API rodando. Feche a outra janela (Ctrl+C) antes de iniciar de novo. |
| Testes falham com `PRÉ-CONDIÇÃO: o pool precisa estar vazio` | O pool ficou cheio após o `test:concorrencia`. Rode o `resetar-banco-local.ps1`. |
| `JWT_SECRET deve ser definido...` | A API foi iniciada sem o script. Use `scripts\iniciar-local.ps1`, que define a variável. |
| `node` ou `npm` "não reconhecido" | O terminal foi aberto antes da instalação. Feche e abra o terminal (ou o VS Code). |

### 11.3 Testar manualmente

**No PowerShell** (recomendado no Windows; mostra também como capturar os erros 4xx):

```powershell
$base  = "http://localhost:8080"
$corpo = '{"username":"joao","password":"senha123"}'

# 1. Registrar (201, sem corpo)
Invoke-RestMethod -Method Post "$base/auth/registrar" -ContentType "application/json" -Body $corpo

# 2. Login: guarda o token em uma variável
$token = (Invoke-RestMethod -Method Post "$base/auth/login" -ContentType "application/json" -Body $corpo).token
$h = @{ Authorization = "Bearer $token" }

# 3. Criar pedido
$pedido = Invoke-RestMethod -Method Post "$base/pedidos" -Headers $h -ContentType "application/json" -Body '{"showId":7}'
$pedido

# 4. Reservar e ver o header X-Lote (o try/catch mostra o erro 409, se houver)
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post "$base/pedidos/$($pedido.id)/reservar" -Headers $h
  "X-Lote: " + $r.Headers['X-Lote']; $r.Content
} catch { "Erro " + $_.Exception.Response.StatusCode.value__ + ": " + $_.ErrorDetails.Message }

# 5. Consultar o pool
Invoke-RestMethod "$base/pool" -Headers $h

# 6. Cancelar
Invoke-RestMethod -Method Post "$base/pedidos/$($pedido.id)/cancelar" -Headers $h
```

**Com `curl`** (Linux, macOS ou Git Bash):

```bash
# 1. Registrar
curl -i -X POST http://localhost:8080/auth/registrar \
  -H "Content-Type: application/json" \
  -d '{"username":"joao","password":"senha123"}'

# 2. Login (copie o token da resposta)
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"joao","password":"senha123"}'

# 3. Criar pedido
curl -X POST http://localhost:8080/pedidos \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"showId":7}'

# 4. Reservar (o -i mostra o header X-Lote)
curl -i -X POST http://localhost:8080/pedidos/1/reservar \
  -H "Authorization: Bearer SEU_TOKEN"

# 5. Consultar o pool
curl http://localhost:8080/pool -H "Authorization: Bearer SEU_TOKEN"

# 6. Cancelar
curl -X POST http://localhost:8080/pedidos/1/cancelar \
  -H "Authorization: Bearer SEU_TOKEN"
```

---

## 12. Laboratórios práticos

Experimentos curtos para **ver** os conceitos acontecendo. Os comandos usam a instalação sem Docker (seção 11.2); com Docker, troque o caminho do `psql` por `docker compose exec banco psql -U ingressos -d ingressos`.

### 12.1 Ler o conteúdo de um JWT

Depois de fazer login no PowerShell (seção 11.3), rode:

```powershell
$parte = $token.Split('.')[1].Replace('-','+').Replace('_','/')
$parte = $parte.PadRight($parte.Length + (4 - $parte.Length % 4) % 4, '=')
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parte))
```

Aparece algo como `{"sub":"42","iat":...,"exp":...}`. **Conclusão:** o conteúdo do token é legível por qualquer um; o que impede a fraude é a assinatura. Troque uma letra do token e chame `/pool`: a resposta será `401 NAO_AUTORIZADO`.

### 12.2 Ver o bloqueio `FOR UPDATE` acontecendo

Abra **dois** terminais PowerShell e, em cada um, conecte ao banco:

```powershell
$env:PGPASSWORD = 'senha-local-apenas'
& "$env:LOCALAPPDATA\Programs\pgsql\bin\psql.exe" -h localhost -U ingressos -d ingressos
```

| Passo | Terminal A | Terminal B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `SELECT * FROM shows WHERE id = 7 FOR UPDATE;` (responde na hora) | |
| 3 | | `BEGIN;` |
| 4 | | `SELECT * FROM shows WHERE id = 7 FOR UPDATE;` **fica parado, esperando** |
| 5 | `COMMIT;` | Responde imediatamente após o `COMMIT` de A |
| 6 | | `COMMIT;` |

**Conclusão:** essa espera do passo 4 é exatamente o que acontece com a segunda reserva quando duas disputam a última vaga. Durante o passo 4, tente também fazer uma reserva pela API: ela fica esperando até o passo 5.

> Não deixe uma transação aberta esquecida: enquanto o terminal A não fizer `COMMIT` ou `ROLLBACK`, **todas** as reservas da API ficam paradas. Para sair do `psql`, digite `\q`.

### 12.3 Conferir os dados diretamente no banco

Dentro do `psql`:

```sql
-- Quantos pedidos em cada estado?
SELECT status, COUNT(*) FROM pedidos GROUP BY status;

-- Algum usuário com mais de 2 reservas? (deve voltar vazio)
SELECT usuario_id, COUNT(*) FROM pedidos
WHERE status = 'RESERVADO' GROUP BY usuario_id HAVING COUNT(*) > 2;

-- A senha está guardada como hash, não como texto
SELECT username, password_hash FROM usuarios LIMIT 3;
```

### 12.4 Provocar o overselling (experimento opcional)

Este experimento **altera o código temporariamente** para mostrar por que a proteção existe. Faça apenas com o Git limpo, para conseguir desfazer.

1. Em `src/reservas.js`, troque `return enfileirar(async () => {` por `return (async () => {` e, no fim da função, `});` por `})();`. Isso desliga a fila.
2. Ainda em `src/reservas.js`, apague o ` FOR UPDATE` da consulta do show. Isso desliga o bloqueio.
3. Recrie o banco, inicie a API e rode `npm run test:concorrencia`.
4. Observe: o teste tende a **falhar**, com mais de 100 reservas aprovadas ou contagens inconsistentes. Pode ser preciso rodar mais de uma vez, porque condições de corrida dependem do acaso.
5. Desfaça as mudanças com `git checkout -- src/reservas.js`, recrie o banco e rode o teste de novo: volta a dar exatamente 100.

**Conclusão:** o bug não aparece em testes sequenciais, só sob concorrência. Por isso o projeto tem testes que disparam requisições ao mesmo tempo.

---

## 13. Limitações conhecidas

| Limitação | Explicação |
|---|---|
| **FIFO limitado à instância** | A fila está na memória de um processo. Ela ordena as tarefas conforme o processo Node as enfileira, não conforme a ordem de envio pelos clientes. |
| **Múltiplas instâncias não testadas** | O bloqueio no banco foi projetado para manter a integridade com várias instâncias, mas isso não foi demonstrado em teste. A ordem FIFO global não existiria nesse cenário. |
| **Latência cresce com a concorrência** | As reservas são processadas uma de cada vez. Na medição, 1000 reservas simultâneas levaram até 4,2 segundos. Rajadas muito maiores podem ultrapassar o timeout de um cliente. |
| **Cadastro e login custosos em rajada** | O hash de senha consome CPU de propósito, para dificultar ataques. Na medição, 100 cadastros simultâneos levaram até 7,6 segundos. Durante essas rajadas, as demais rotas também ficam mais lentas. |
| **Fila sem limite e sem timeout de banco** | A fila não recusa tarefas quando cresce, e não há tempo máximo configurado para os comandos SQL. Um comando travado no banco atrasaria todas as reservas seguintes. |
| **Token de usuário inexistente** | O token não é conferido contra o banco. Um token emitido antes de recriar o banco continua válido por até 24 horas; criar um pedido com ele resulta em erro 500 em vez de 401. |
| **Erros de corpo da requisição** | Apenas JSON malformado é respondido com 400. Um corpo maior que 16 kB resulta em erro 500 em vez de 413. |
| **IDs em formatos incomuns** | O ID do pedido na URL é convertido com `Number()`, que aceita formas como `1e2` (interpretado como 100). |
| **Segredos de demonstração** | A senha do banco e o segredo do JWT estão no `docker-compose.yml` e no `iniciar-local.ps1` para que a avaliação funcione sem configuração. Em produção, viriam de um cofre de segredos. |
| **Um único show** | A API atende apenas o show de ID 7, conforme o enunciado. |

---

## 14. Exercícios de fixação

Tente responder **sem consultar** o documento. As respostas estão na seção 19.

**Conceitos**

1. Com suas palavras, o que é uma condição de corrida? Dê o exemplo deste projeto.
2. Qual a diferença entre `COMMIT` e `ROLLBACK`? Os dois liberam os bloqueios?
3. Atomicidade garante que nunca serão vendidos 101 ingressos? Justifique.
4. Por que o conteúdo de um JWT pode ser lido por qualquer pessoa e, mesmo assim, ser seguro?

**Leitura de código**

5. Em `enfileirar`, o que aconteceria se a linha `cauda = resultado.catch(() => {})` fosse trocada por `cauda = resultado`?
6. Por que `alterarReserva` usa `banco.connect()` em vez de `banco.query()`?
7. O que aconteceria se o `cliente.release()` fosse removido do bloco `finally`?
8. Por que `res.set('X-Lote', '7F3A')` fica **depois** do `await alterarReserva(...)`?

**Previsão de resultados**

9. O pool está com 98 ocupadas. Um usuário sem reservas dispara 3 reservas simultâneas (3 pedidos diferentes dele). Quais respostas ele recebe?
10. Um usuário com 2 reservas ativas tenta reservar um terceiro pedido com o pool em 100/100. Qual erro recebe, e por quê?
11. Um pedido `CANCELADO` pode ser reservado de novo? Que resposta a API dá?
12. A usuária Ana tenta cancelar o pedido 10, que é do Bruno. Qual a resposta e por que não é 403?

**Desafio**

13. Se o projeto passasse a ter vários shows, bloquear sempre a linha do show 7 continuaria correto? O que mudaria?
14. Proponha uma forma de manter a ordem FIFO com duas instâncias da API.

---

## 15. Perguntas prováveis do professor

**1. O que é uma condição de corrida e onde ela apareceria neste projeto?**
É quando o resultado depende da ordem em que operações simultâneas se intercalam. Apareceria na reserva: duas requisições contam 99 ocupadas, ambas concluem que há vaga e ambas gravam, chegando a 101.

**2. Como o projeto impede vender mais de 100 ingressos?**
Toda reserva abre uma transação e bloqueia a linha do show com `SELECT ... FOR UPDATE` antes de contar. A contagem e a gravação acontecem com o bloqueio mantido, então só uma transação por vez decide sobre as vagas.

**3. O que o `SELECT ... FOR UPDATE` faz exatamente?**
Lê a linha e coloca um bloqueio exclusivo nela até o fim da transação. Outra transação que tente o mesmo fica esperando o `COMMIT` ou o `ROLLBACK` da primeira.

**4. Por que bloquear a linha do show e não a linha do pedido?**
Porque a regra dos 100 ingressos envolve **todos** os pedidos do show. Dois pedidos diferentes disputam a mesma vaga, então é preciso um ponto de bloqueio comum. A linha do show é esse ponto.

**5. Se o banco já bloqueia, para que serve a fila em memória?**
Para dar ordem de atendimento. O bloqueio garante integridade, mas não promete atender na ordem de chegada. A fila executa as tarefas na ordem em que o processo Node as enfileirou.

**6. A fila garante que quem clicou primeiro leva o ingresso?**
Não. Ela garante a ordem em que as requisições foram enfileiradas pelo processo. A ordem dos cliques ou dos pacotes na rede pode ser diferente, e a fila não tem como conhecê-la.

**7. O que acontece se a API rodar em duas instâncias?**
Cada instância teria sua própria fila, então não haveria FIFO global. A integridade ficaria a cargo do bloqueio no PostgreSQL, que é compartilhado. Esse cenário não foi testado; seria necessária uma fila externa para manter a ordem.

**8. Como a cota de 2 reservas por usuário é protegida contra requisições simultâneas?**
A contagem das reservas do usuário é feita dentro da mesma transação, depois do bloqueio do show. Como as reservas são avaliadas uma por vez, a terceira sempre encontra 2 reservas ativas e recebe `COTA_PESSOAL`. No teste, 5 reservas simultâneas resultaram em exatamente 2 aprovadas.

**9. Se o usuário já tem 2 reservas e o show está lotado, qual erro ele recebe?**
`COTA_PESSOAL`. A cota pessoal é verificada antes do pool.

**10. O que acontece se ocorrer um erro no meio de uma reserva?**
A transação recebe `ROLLBACK`, que desfaz tudo e libera o bloqueio. A conexão volta ao pool e a fila segue para a próxima tarefa. Não existe reserva pela metade.

**11. Pode ocorrer deadlock?**
Não foi identificado caminho para isso. Toda transação bloqueia na mesma ordem: primeiro o show, depois o pedido. Sem ordens diferentes, não se forma o ciclo de espera.

**12. Por que cancelar libera a vaga? Existe um contador?**
Não existe contador. A ocupação é a contagem de pedidos `RESERVADO`. Ao cancelar, o pedido muda para `CANCELADO` e deixa de ser contado.

**13. Por que `ocupadas + livres` é sempre 100?**
Porque `ocupadas` vem de uma única consulta e `livres` é calculado como `total - ocupadas` a partir desse mesmo resultado. Não são duas leituras independentes.

**14. Como funciona a autenticação?**
No login, a API confere a senha com o hash bcrypt e devolve um JWT assinado com HS256, válido por 24 horas, contendo o ID do usuário. As rotas protegidas verificam a assinatura do token e extraem o ID. Sem token válido, a resposta é 401.

**15. Por que um pedido de outro usuário retorna 404 e não 403?**
Porque a busca do pedido já filtra pelo dono. Para quem não é dono, o pedido "não existe". Isso também evita revelar quais IDs de pedido existem.

**16. Por que a senha não é salva diretamente?**
Se o banco vazasse, todas as senhas estariam expostas. O bcrypt gera um hash que não pode ser revertido e é lento de propósito, o que dificulta tentativas em massa.

**17. Como o Docker garante que a API só sobe depois do banco?**
O Compose define um *healthcheck* no banco com `pg_isready`, e a API usa `depends_on` com `condition: service_healthy`. A API só inicia quando o banco responde.

**18. O que faz o `docker compose down -v`?**
Remove os contêineres e a rede do projeto e, por causa do `-v`, apaga o volume de dados. Na subida seguinte, o PostgreSQL executa o `init.sql` de novo e o show volta a ter 0 reservas. Sem Docker, o equivalente é o `resetar-banco-local.ps1`.

**19. Como você sabe que funciona sob concorrência?**
Pelos testes automatizados: 130 reservas simultâneas resultaram em exatamente 100 aprovadas e 30 `POOL_CHEIO`; em rajadas de 200, 500 e 1000 reservas, sempre 100 aprovadas, zero erros 5xx e zero timeouts. O pool foi consultado durante as rajadas e nunca passou de 100.

**20. Qual é a principal desvantagem da estratégia adotada?**
O desempenho. Como as reservas são processadas uma de cada vez, o tempo de espera cresce com o número de requisições simultâneas. Foi uma troca consciente: simplicidade e integridade em vez de vazão máxima.

**21. Como a fila em memória foi implementada?**
Com uma única `Promise` chamada `cauda`, que representa o fim da fila. Cada nova tarefa é encadeada com `cauda.then(tarefa)`, então só começa quando a anterior termina. Um `.catch` vazio impede que o erro de uma tarefa trave as seguintes.

**22. Por que o Node.js, mesmo tendo uma única thread, sofre condição de corrida?**
Porque cada `await` de uma consulta ao banco devolve o controle ao Node. Enquanto uma requisição espera o banco, outra pode executar a sua contagem. A thread é única, mas as esperas se intercalam.

---

## 16. Roteiro de apresentação de 5 minutos

O texto abaixo é uma referência. Não precisa ser lido literalmente.

### 0:00 – 0:45 · Contexto

> "Meu projeto é uma API de reserva de ingressos para um show com 100 lugares. Cada usuário pode ter no máximo 2 reservas. O desafio não é reservar, é reservar **corretamente quando muita gente tenta ao mesmo tempo**. Se o sistema só contar as reservas e depois gravar, duas pessoas podem ver 99 ocupadas, as duas acham que há vaga e o show termina com 101 ingressos. Isso é uma condição de corrida."

### 0:45 – 1:30 · Arquitetura

> "A API foi feita em Node.js com Express e usa PostgreSQL. A autenticação é por token JWT e as senhas são guardadas com hash bcrypt. Tudo sobe com Docker Compose: um contêiner para o banco e um para a API, na porta 8080. O pedido tem três estados: NO_CARRINHO, RESERVADO e CANCELADO. Só o RESERVADO ocupa vaga."

Mostrar o diagrama de estados ou a árvore de arquivos.

### 1:30 – 3:00 · Estratégia de concorrência

> "Usei duas camadas. A primeira é uma fila em memória dentro da API: reservas e cancelamentos são executados um de cada vez, na ordem em que a API os enfileira. A segunda é no banco: cada reserva abre uma transação e bloqueia a linha do show com SELECT FOR UPDATE. Só depois de obter o bloqueio ela conta as reservas, verifica a cota do usuário e o limite de 100, e grava. O COMMIT libera o bloqueio. Quem estava esperando conta de novo e já enxerga a vaga ocupada, então recebe 409 POOL_CHEIO."

> "A transação garante que a reserva acontece por inteiro ou não acontece. O bloqueio garante que nunca passamos de 100. E a fila dá a ordem de atendimento. Uma limitação importante: essa ordem vale para uma instância da API. Com várias instâncias, o banco ainda protegeria os dados, mas a ordem global exigiria uma fila compartilhada."

Mostrar o trecho de `src/reservas.js` com o `FOR UPDATE`.

### 3:00 – 4:30 · Demonstração prática

Com Docker:

1. `docker compose ps` — os dois contêineres `healthy`.
2. Executar `docker compose exec -T api npm run test:regras` e apontar:
   - 5 reservas do mesmo usuário: 2 aprovadas.
   - 10 tentativas no mesmo pedido: 1 aprovada.
   - 120 reservas simultâneas: exatamente 100 aprovadas.
3. Executar `docker compose exec -T api npm run test:concorrencia`: 130 reservas, 100 aprovadas, 30 `POOL_CHEIO`.

Sem Docker: a API ligada com `scripts\iniciar-local.ps1` em um terminal e, no outro, `npm run test:regras` e `npm run test:concorrencia`.

> "Reparem que o número de aprovadas é sempre exatamente 100, e que toda reserva aprovada vem com o header X-Lote 7F3A."

Recomendação: reiniciar o banco (`down -v` e `up --build -d`, ou `resetar-banco-local.ps1`) **antes** da apresentação, pois os testes exigem o pool vazio.

### 4:30 – 5:00 · Conclusão

> "Nos testes de carga, com até 1000 reservas simultâneas, não houve nenhum erro 500 nem timeout, e o pool nunca passou de 100. O custo dessa estratégia é a latência: como as reservas são processadas uma por vez, o tempo de espera cresce com a carga. Foi uma escolha consciente de priorizar a integridade. Como evolução, eu testaria com múltiplas instâncias e usaria uma fila compartilhada."

---

## 17. Resumo para revisão rápida

**O sistema em uma frase:** API de reservas que nunca vende mais de 100 ingressos nem mais de 2 por pessoa, mesmo com centenas de pedidos simultâneos.

| Tema | O essencial |
|---|---|
| Problema | "Contar e depois gravar" sob concorrência gera 101/100 (condição de corrida). |
| Solução, camada 1 | Fila em memória (uma `Promise` encadeada): uma reserva/cancelamento por vez, na ordem de enfileiramento. |
| Solução, camada 2 | Transação + `SELECT ... FOR UPDATE` na linha do show 7: a "catraca" do banco. |
| Ordem das checagens | dono (404) → estado (409 `ESTADO_INVALIDO`) → cota (409 `COTA_PESSOAL`) → pool (409 `POOL_CHEIO`). |
| Contagem de vagas | Não há contador: conta pedidos `RESERVADO`. Cancelar = deixar de ser contado. |
| Estados | `NO_CARRINHO` → `RESERVADO` → `CANCELADO`. Só `RESERVADO` ocupa vaga. |
| Segurança | Senha com bcrypt; JWT HS256 de 24 h; consultas parametrizadas; pedido alheio = 404. |
| Header obrigatório | `X-Lote: 7F3A` só na reserva com sucesso. |
| Prova | 130 simultâneas → 100 aprovadas + 30 `POOL_CHEIO`; até 1000 simultâneas, zero 5xx. |
| Limitações | Latência cresce com a carga; FIFO só dentro de uma instância; várias instâncias não testadas. |

**Três frases para não esquecer:**

1. "A transação garante o tudo ou nada; o bloqueio garante o nunca mais de 100; a fila garante a ordem de atendimento."
2. "A contagem acontece com o bloqueio na mão, e o bloqueio só é solto depois de gravar."
3. "Integridade não depende da fila; a fila só dá ordem."

---

## 18. Glossário

| Termo | Significado |
|---|---|
| **API** | Interface pela qual programas conversam entre si. Aqui, um conjunto de endereços HTTP que recebem e devolvem JSON. |
| **Endpoint** | Um endereço específico da API, formado por método e caminho, como `POST /pedidos`. |
| **HTTP** | Protocolo de comunicação da web. Cada resposta traz um código de status. |
| **HTTP 200 / 201** | Sucesso / sucesso com criação de um recurso. |
| **HTTP 400** | Requisição malformada ou com dados inválidos. |
| **HTTP 401** | Não autenticado: token ausente ou inválido. |
| **HTTP 404** | Recurso não encontrado. |
| **HTTP 409** | Conflito: a requisição é válida, mas não pode ser atendida no estado atual (pool cheio, cota atingida, estado inválido). |
| **HTTP 5xx** | Erro do servidor. |
| **Header** | Informação extra enviada junto com a requisição ou a resposta, como `Authorization` ou `X-Lote`. |
| **JSON** | Formato de texto para troca de dados, como `{"id": 42}`. |
| **JWT** | Token assinado que identifica o usuário. Quem não conhece o segredo não consegue forjá-lo. |
| **Hash** | Transformação de mão única. A partir do hash não se recupera a senha original. |
| **Middleware** | Função que roda antes da rota, como a verificação do token. |
| **Promise** | Objeto do JavaScript que representa um resultado que ainda vai chegar. `.then` encadeia o que fazer depois. |
| **async / await** | Forma de escrever código com Promises como se fosse sequencial. O `await` pausa a função até o resultado chegar, liberando o Node para atender outras requisições. |
| **Event loop** | Mecanismo do Node.js que alterna entre as tarefas prontas para rodar, usando uma única thread. |
| **Consulta parametrizada** | SQL com marcadores (`$1`, `$2`) cujos valores são enviados separadamente, o que impede *SQL injection*. |
| **Transação** | Conjunto de comandos do banco tratado como uma unidade. |
| **Atomicidade** | Propriedade de "tudo ou nada" de uma transação. |
| **COMMIT** | Confirma a transação. |
| **Rollback** | Desfaz a transação. |
| **Lock (bloqueio)** | Reserva temporária de um dado para uma transação; as outras esperam. |
| **SELECT FOR UPDATE** | Leitura que bloqueia as linhas lidas até o fim da transação. |
| **Read Committed** | Nível de isolamento padrão do PostgreSQL: cada comando enxerga apenas dados já confirmados. |
| **Deadlock** | Duas transações esperando uma pela outra indefinidamente. |
| **Condição de corrida** | Erro que depende da ordem de execução de operações simultâneas. |
| **Overselling** | Vender mais do que existe em estoque. |
| **Serialização** | Fazer operações concorrentes se comportarem como se rodassem uma por vez. |
| **FIFO** | *First In, First Out*: o primeiro a entrar na fila é o primeiro a ser atendido. |
| **Pool de conexões** | Conjunto de conexões com o banco reaproveitadas entre requisições. Não confundir com o "pool" de ingressos da rota `/pool`. |
| **Índice parcial** | Índice que inclui apenas as linhas que atendem a uma condição, como `status = 'RESERVADO'`. |
| **Instância** | Uma cópia do programa em execução. |
| **Latência** | Tempo entre enviar a requisição e receber a resposta. |
| **p50 / p95** | Tempos que 50% e 95% das requisições não ultrapassaram. |
| **Timeout** | Tempo máximo de espera antes de desistir. |
| **Variável de ambiente** | Configuração passada ao programa pelo sistema operacional, como `JWT_SECRET` e `PGHOST`. |
| **Docker** | Ferramenta que executa programas em contêineres isolados. |
| **Imagem / Contêiner** | A imagem é o pacote pronto; o contêiner é a imagem em execução. |
| **Docker Compose** | Ferramenta que descreve e sobe vários contêineres juntos. |
| **Volume** | Área de armazenamento que guarda os dados do banco fora do contêiner. |
| **Healthcheck** | Verificação periódica que informa se o contêiner está funcionando. |
| **EADDRINUSE** | Erro do sistema operacional: a porta pedida já está sendo usada por outro programa. |

---

## 19. Respostas dos exercícios

1. É quando o resultado depende da ordem em que operações simultâneas se intercalam. No projeto: duas reservas contam 99 ocupadas ao mesmo tempo, as duas acham que há vaga e as duas gravam, chegando a 101.
2. `COMMIT` confirma as alterações; `ROLLBACK` as desfaz. **Os dois** encerram a transação e liberam os bloqueios.
3. Não. Atomicidade só garante que cada reserva acontece por inteiro ou não acontece. Duas reservas atômicas ainda podem tomar a decisão com a mesma contagem desatualizada. Quem impede o 101 é a **serialização**, dada pelo bloqueio `FOR UPDATE`.
4. Porque o JWT é **assinado**, não criptografado. Qualquer um pode ler o `sub`, mas, se alterá-lo, a assinatura deixa de bater com o `JWT_SECRET` e o token é recusado com 401.
5. Na primeira tarefa que falhasse (por exemplo, `POOL_CHEIO`), `cauda` ficaria rejeitada. Todas as tarefas seguintes, encadeadas com `.then`, seriam puladas e também rejeitadas, e nenhuma reserva ou cancelamento voltaria a funcionar até reiniciar a API.
6. Porque `BEGIN`, as consultas com `FOR UPDATE`, o `UPDATE` e o `COMMIT` precisam ir pela mesma conexão para fazer parte da mesma transação. `banco.query()` pode usar uma conexão diferente a cada chamada.
7. As conexões não voltariam ao pool. Depois de 15 reservas ou cancelamentos, não haveria conexões livres; as tarefas seguintes esperariam 5 segundos (`connectionTimeoutMillis`) e falhariam, travando a fila.
8. Porque, se `alterarReserva` lançar um erro, a execução pula direto para o tratador de erros e a linha do header nunca roda. Assim, o `X-Lote` só aparece em reservas bem-sucedidas.
9. Ele recebe duas respostas 200 com `X-Lote` (o pool vai a 100/100) e uma `409 COTA_PESSOAL`, porque a terceira reserva encontra 2 reservas ativas dele. A cota é verificada antes do pool.
10. `409 COTA_PESSOAL`, porque a cota pessoal é verificada antes do pool cheio.
11. Não. `CANCELADO` é um estado final; tentar reservar responde `409 ESTADO_INVALIDO`. Para reservar de novo, é preciso criar outro pedido.
12. `404 PEDIDO_NAO_ENCONTRADO`. A consulta do pedido já filtra por `usuario_id`, então, para Ana, o pedido do Bruno não existe. Responder 403 revelaria que o pedido 10 existe.
13. Bloquear sempre o show 7 ainda manteria a integridade, mas serializaria reservas de shows diferentes sem necessidade. O certo seria bloquear a linha do show **do pedido** (`WHERE id = <show do pedido> FOR UPDATE`), contar as reservas daquele show e manter a cota por usuário (por show ou global, conforme a regra). Shows diferentes poderiam então ser reservados em paralelo.
14. Usar uma fila compartilhada fora da API, como Redis, RabbitMQ ou uma tabela de fila no próprio PostgreSQL. As instâncias publicariam os pedidos de reserva nela, e um único consumidor (ou consumidores coordenados) processaria na ordem de chegada à fila. O bloqueio `FOR UPDATE` continuaria como garantia de integridade.
