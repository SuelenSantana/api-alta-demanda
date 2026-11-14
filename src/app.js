import express from 'express';
import bcrypt from 'bcryptjs';
import { banco } from './db.js';
import { autenticar, gerarToken } from './auth.js';
import { ErroHttp } from './erros.js';
import { alterarReserva } from './reservas.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function verificarCredenciais(body) {
  const username = body?.username;
  const password = body?.password;
  if (typeof username !== 'string' || username.trim().length === 0 ||
      username.length > 50 || typeof password !== 'string' ||
      password.length === 0 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new ErroHttp(400, 'DADOS_INVALIDOS');
  }
  return { username: username.trim(), password };
}

app.post('/auth/registrar', async (req, res) => {
  const { username, password } = verificarCredenciais(req.body);
  const hash = await bcrypt.hash(password, 10);

  try {
    await banco.query(
      'INSERT INTO usuarios (username, password_hash) VALUES ($1, $2)',
      [username, hash]
    );
    return res.status(201).end();
  } catch (erro) {
    if (erro.code === '23505') throw new ErroHttp(409, 'USUARIO_JA_EXISTE');
    throw erro;
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = verificarCredenciais(req.body);
  const resultado = await banco.query(
    'SELECT id, password_hash FROM usuarios WHERE username = $1',
    [username]
  );
  if (!resultado.rowCount || !(await bcrypt.compare(password, resultado.rows[0].password_hash))) {
    throw new ErroHttp(401, 'CREDENCIAIS_INVALIDAS');
  }
  return res.status(200).json({ token: gerarToken(resultado.rows[0]) });
});

// Os endpoints abaixo exigem autenticação.
app.post('/pedidos', autenticar, async (req, res) => {
  if (req.body?.showId !== 7) throw new ErroHttp(404, 'SHOW_NAO_ENCONTRADO');

  const resultado = await banco.query(
    `INSERT INTO pedidos (usuario_id, show_id, status)
     VALUES ($1, $2, 'NO_CARRINHO')
     RETURNING id, status`,
    [req.usuarioId, 7]
  );
  return res.status(201).json({
    id: Number(resultado.rows[0].id),
    status: resultado.rows[0].status
  });
});

function idPedidoOu404(req) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ErroHttp(404, 'PEDIDO_NAO_ENCONTRADO');
  }
  return id;
}

app.post('/pedidos/:id/reservar', autenticar, async (req, res) => {
  const pedido = await alterarReserva({
    pedidoId: idPedidoOu404(req),
    usuarioId: req.usuarioId,
    acao: 'reservar'
  });
  res.set('X-Lote', '7F3A');
  return res.status(200).json(pedido);
});

app.post('/pedidos/:id/cancelar', autenticar, async (req, res) => {
  const pedido = await alterarReserva({
    pedidoId: idPedidoOu404(req),
    usuarioId: req.usuarioId,
    acao: 'cancelar'
  });
  return res.status(200).json(pedido);
});

app.get('/pool', autenticar, async (_req, res) => {
  // Uma única consulta garante a consistência da leitura do snapshot.
  // 'ocupadas' é calculado a partir dos pedidos efetivamente RESERVADO.
  const resultado = await banco.query(
    `SELECT s.total_vagas AS total,
       (SELECT COUNT(*)::integer FROM pedidos p
        WHERE p.show_id = s.id AND p.status = 'RESERVADO') AS ocupadas
     FROM shows s WHERE s.id = $1`,
    [7]
  );
  if (!resultado.rowCount) throw new ErroHttp(404, 'SHOW_NAO_ENCONTRADO');
  const { total, ocupadas } = resultado.rows[0];
  return res.status(200).json({ total, ocupadas, livres: total - ocupadas });
});

// Endpoint adicional de saúde para o Docker (não exige login).
app.get('/health', async (_req, res) => {
  await banco.query('SELECT 1');
  res.status(200).json({ status: 'ok' });
});

app.use((_req, _res, next) => next(new ErroHttp(404, 'ROTA_NAO_ENCONTRADA')));

app.use((erro, _req, res, _next) => {
  if (erro instanceof ErroHttp) {
    return res.status(erro.status).json({ error: erro.codigo });
  }
  if (erro instanceof SyntaxError && erro.status === 400 && 'body' in erro) {
    return res.status(400).json({ error: 'JSON_INVALIDO' });
  }
  console.error('Erro inesperado:', erro);
  return res.status(500).json({ error: 'ERRO_INTERNO' });
});

const porta = Number(process.env.PORT ?? 8080);
const servidor = app.listen(porta, '0.0.0.0', () => {
  console.log(`API de ingressos disponível na porta ${porta}`);
});

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    servidor.close(async () => {
      await banco.end();
      process.exit(0);
    });
  });
}
