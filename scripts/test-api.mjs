import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8080';

async function http(metodo, rota, corpo, token) {
  const resposta = await fetch(`${base}${rota}`, {
    method: metodo,
    headers: {
      ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) })
  });
  const texto = await resposta.text();
  return {
    status: resposta.status,
    dados: texto ? JSON.parse(texto) : null,
    headers: resposta.headers
  };
}

async function executar() {
  const identificador = randomUUID().slice(0, 10);
  const u1 = `a_${identificador}`;
  const u2 = `b_${identificador}`;
  const senha = 'senha123';

  assert.equal((await http('GET', '/pool')).status, 401, 'Pool precisa de autenticação');
  assert.equal((await http('POST', '/auth/registrar', { username: u1, password: senha })).status, 201);
  assert.equal((await http('POST', '/auth/registrar', { username: u2, password: senha })).status, 201);
  assert.equal((await http('POST', '/auth/registrar', { username: u1, password: senha })).status, 409);

  const login1 = await http('POST', '/auth/login', { username: u1, password: senha });
  const login2 = await http('POST', '/auth/login', { username: u2, password: senha });
  assert.equal(login1.status, 200);
  assert.equal(login2.status, 200);
  const t1 = login1.dados.token;
  const t2 = login2.dados.token;
  assert.equal(typeof t1, 'string');
  assert.equal(typeof t2, 'string');

  const inicio = await http('GET', '/pool', undefined, t1);
  assert.equal(inicio.status, 200);
  assert.equal(inicio.dados.total, 100);
  assert.equal(inicio.dados.ocupadas + inicio.dados.livres, 100);
  assert.equal(inicio.dados.ocupadas <= 100, true);

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const pedido = await http('POST', '/pedidos', { showId: 7 }, t1);
    assert.equal(pedido.status, 201);
    assert.equal(pedido.dados.status, 'NO_CARRINHO');
    ids.push(pedido.dados.id);
  }

  const naoDono = await http('POST', `/pedidos/${ids[0]}/reservar`, undefined, t2);
  assert.equal(naoDono.status, 404);

  // Sem duas vagas livres não há como validar cota, cancelamento e X-Lote: falha explícita.
  assert.equal(inicio.dados.livres >= 2, true,
    `PRÉ-CONDIÇÃO: são necessárias 2 vagas livres (livres=${inicio.dados.livres}). ` +
    'Execute: docker compose down -v && docker compose up --build -d');

  for (const id of ids.slice(0, 2)) {
    const r = await http('POST', `/pedidos/${id}/reservar`, undefined, t1);
    assert.equal(r.status, 200);
    assert.equal(r.dados.status, 'RESERVADO');
    assert.equal(r.headers.get('x-lote'), '7F3A');
  }
  const excedente = await http('POST', `/pedidos/${ids[2]}/reservar`, undefined, t1);
  assert.equal(excedente.status, 409);
  assert.deepEqual(excedente.dados, { error: 'COTA_PESSOAL' });

  const meio = await http('GET', '/pool', undefined, t1);
  assert.equal(meio.dados.ocupadas, inicio.dados.ocupadas + 2);
  assert.equal(meio.dados.ocupadas + meio.dados.livres, 100);

  const cancelado = await http('POST', `/pedidos/${ids[0]}/cancelar`, undefined, t1);
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.dados.status, 'CANCELADO');
  assert.equal((await http('POST', `/pedidos/${ids[0]}/reservar`, undefined, t1)).status, 409);
  const reservaNova = await http('POST', `/pedidos/${ids[2]}/reservar`, undefined, t1);
  assert.equal(reservaNova.status, 200);
  assert.equal(reservaNova.headers.get('x-lote'), '7F3A');
  assert.equal((await http('POST', `/pedidos/${ids[2]}/cancelar`, undefined, t2)).status, 404);

  assert.equal((await http('POST', `/pedidos/${ids[1]}/cancelar`, undefined, t1)).status, 200);
  assert.equal((await http('POST', `/pedidos/${ids[2]}/cancelar`, undefined, t1)).status, 200);
  const fim = await http('GET', '/pool', undefined, t1);
  assert.equal(fim.dados.ocupadas, inicio.dados.ocupadas);
  assert.equal(fim.dados.ocupadas + fim.dados.livres, 100);

  console.log('✓ Registro, login, JWT, estados, cota, propriedade, cancelamento e X-Lote: OK');
  console.log('✓ Pool íntegro após criação, reserva e cancelamento: OK');
}

executar().catch(erro => {
  console.error('FALHA NO TESTE:', erro);
  process.exitCode = 1;
});
