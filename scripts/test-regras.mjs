// Testes de regras sob concorrência. Exige o pool VAZIO no início
// (docker compose down -v && docker compose up --build -d) e o devolve vazio ao final.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const prefixo = randomUUID().slice(0, 8);
const criados = []; // todos os pedidos criados, para limpeza ao final
let sequencia = 0;

async function http(metodo, rota, corpo, token) {
  const r = await fetch(`${base}${rota}`, {
    method: metodo,
    headers: {
      ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) })
  });
  const texto = await r.text();
  return { status: r.status, dados: texto ? JSON.parse(texto) : null, lote: r.headers.get('x-lote') };
}

async function emLotes(itens, limite, funcao) {
  const saida = new Array(itens.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    for (;;) {
      const i = proximo++;
      if (i >= itens.length) return;
      saida[i] = await funcao(itens[i], i);
    }
  }));
  return saida;
}

async function criarUsuarios(quantidade) {
  const nomes = Array.from({ length: quantidade }, () => `${prefixo}_${sequencia++}`);
  return emLotes(nomes, 8, async username => {
    const password = 'senha123';
    assert.equal((await http('POST', '/auth/registrar', { username, password })).status, 201);
    const login = await http('POST', '/auth/login', { username, password });
    assert.equal(login.status, 200);
    return login.dados.token;
  });
}

async function criarPedido(token) {
  const r = await http('POST', '/pedidos', { showId: 7 }, token);
  assert.equal(r.status, 201);
  assert.deepEqual(r.dados, { id: r.dados.id, status: 'NO_CARRINHO' });
  const pedido = { id: r.dados.id, token };
  criados.push(pedido);
  return pedido;
}

const reservar = p => http('POST', `/pedidos/${p.id}/reservar`, undefined, p.token);
const cancelar = p => http('POST', `/pedidos/${p.id}/cancelar`, undefined, p.token);

// Lê o pool e confere as invariantes em TODA leitura.
async function lerPool(token) {
  const r = await http('GET', '/pool', undefined, token);
  assert.equal(r.status, 200);
  const { total, ocupadas, livres } = r.dados;
  assert.equal(total, 100, 'total deve ser 100');
  assert.equal(ocupadas + livres, 100, `ocupadas + livres != 100: ${JSON.stringify(r.dados)}`);
  assert.equal(ocupadas >= 0 && ocupadas <= 100, true, `ocupadas fora de 0..100: ${ocupadas}`);
  return r.dados;
}

// Consulta o pool repetidamente enquanto uma rajada está em andamento.
async function comVigiaDoPool(token, rajada) {
  let ativo = true;
  let leituras = 0;
  const vigia = (async () => {
    while (ativo) { await lerPool(token); leituras++; }
  })();
  try {
    return await rajada();
  } finally {
    ativo = false;
    await vigia;
    console.log(`   (${leituras} leituras do pool durante a rajada, todas íntegras)`);
  }
}

function sucessoValido(r, id) {
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados, { id, status: 'RESERVADO' });
  assert.equal(r.lote, '7F3A', 'reserva bem-sucedida precisa de X-Lote: 7F3A');
}

function erroValido(r, status, codigo) {
  assert.equal(r.status, status, `esperado ${status} ${codigo}, veio ${r.status} ${JSON.stringify(r.dados)}`);
  assert.deepEqual(r.dados, { error: codigo });
  assert.equal(r.lote, null, 'resposta de erro não pode ter X-Lote');
}

async function executar() {
  const [a, b, c, d] = await criarUsuarios(4);

  const inicial = await lerPool(a);
  assert.equal(inicial.ocupadas, 0,
    `PRÉ-CONDIÇÃO: o pool precisa estar vazio (ocupadas=${inicial.ocupadas}). ` +
    'Execute: docker compose down -v && docker compose up --build -d');

  // 1) Cinco pedidos simultâneos do mesmo usuário: exatamente duas aprovações.
  const cincoPedidos = [];
  for (let i = 0; i < 5; i++) cincoPedidos.push(await criarPedido(a));
  const r1 = await Promise.all(cincoPedidos.map(reservar));
  const ok1 = cincoPedidos.filter((_, i) => r1[i].status === 200);
  assert.equal(ok1.length, 2, `cota pessoal: esperadas 2 aprovações, vieram ${ok1.length}`);
  r1.forEach((r, i) => r.status === 200
    ? sucessoValido(r, cincoPedidos[i].id)
    : erroValido(r, 409, 'COTA_PESSOAL'));
  assert.equal((await lerPool(a)).ocupadas, 2);
  console.log('✓ 1. Mesmo usuário, 5 reservas simultâneas: 2 aprovadas, 3 COTA_PESSOAL');

  // 5) Pedido de outro usuário: 404 ao reservar e ao cancelar, sem X-Lote.
  erroValido(await http('POST', `/pedidos/${cincoPedidos[0].id}/reservar`, undefined, b), 404, 'PEDIDO_NAO_ENCONTRADO');
  erroValido(await http('POST', `/pedidos/${ok1[0].id}/cancelar`, undefined, b), 404, 'PEDIDO_NAO_ENCONTRADO');
  erroValido(await http('POST', `/pedidos/${ok1[0].id}/reservar`), 401, 'NAO_AUTORIZADO');
  assert.equal((await lerPool(a)).ocupadas, 2, 'tentativa de não-dono não pode alterar o pool');
  console.log('✓ 5. Pedido de outro usuário: 404 em reservar e cancelar; sem token: 401');

  for (const p of ok1) assert.equal((await cancelar(p)).status, 200);
  assert.equal((await lerPool(a)).ocupadas, 0);

  // 2) Dez reservas simultâneas do MESMO pedido: apenas uma aprovação.
  const unico = await criarPedido(b);
  const r2 = await Promise.all(Array.from({ length: 10 }, () => reservar(unico)));
  const ok2 = r2.filter(r => r.status === 200);
  assert.equal(ok2.length, 1, `mesmo pedido: esperada 1 aprovação, vieram ${ok2.length}`);
  r2.forEach(r => r.status === 200 ? sucessoValido(r, unico.id) : erroValido(r, 409, 'ESTADO_INVALIDO'));
  assert.equal((await lerPool(a)).ocupadas, 1, 'um pedido só pode ocupar uma vaga');
  assert.equal((await cancelar(unico)).status, 200);
  console.log('✓ 2. Mesmo pedido, 10 reservas simultâneas: 1 aprovada, 9 ESTADO_INVALIDO');

  // 3) 120 reservas simultâneas (60 usuários x 2), pool vazio: exatamente 100.
  const multidao = await criarUsuarios(60);
  const pedidos = (await emLotes(multidao, 15, async t => [await criarPedido(t), await criarPedido(t)])).flat();
  assert.equal((await lerPool(a)).ocupadas, 0);
  const r3 = await comVigiaDoPool(a, () => Promise.all(pedidos.map(reservar)));
  const reservados = pedidos.filter((_, i) => r3[i].status === 200);
  assert.equal(reservados.length, 100, `esperadas 100 aprovações, vieram ${reservados.length}`);
  r3.forEach((r, i) => r.status === 200
    ? sucessoValido(r, pedidos[i].id)
    : erroValido(r, 409, 'POOL_CHEIO'));
  assert.deepEqual(await lerPool(a), { total: 100, ocupadas: 100, livres: 0 });
  console.log('✓ 3. 120 reservas simultâneas: 100 aprovadas, 20 POOL_CHEIO; pool 100/100');
  console.log('✓ 6/7. X-Lote: 7F3A em todos os sucessos e ausente em todos os erros');

  // 4) Cancelamento libera a vaga para uma nova reserva.
  const espera = await criarPedido(d);
  erroValido(await reservar(espera), 409, 'POOL_CHEIO');
  const liberado = reservados.pop();
  const cancelamento = await cancelar(liberado);
  assert.equal(cancelamento.status, 200);
  assert.deepEqual(cancelamento.dados, { id: liberado.id, status: 'CANCELADO' });
  assert.equal(cancelamento.lote, null, 'cancelamento não deve ter X-Lote');
  assert.deepEqual(await lerPool(a), { total: 100, ocupadas: 99, livres: 1 });
  sucessoValido(await reservar(espera), espera.id);
  reservados.push(espera);
  assert.deepEqual(await lerPool(a), { total: 100, ocupadas: 100, livres: 0 });
  erroValido(await reservar(liberado), 409, 'ESTADO_INVALIDO');
  console.log('✓ 4. Cancelamento liberou 1 vaga (99/100) e nova reserva a ocupou (100/100)');

  // Extra) Pool cheio: 10 cancelamentos e 30 reservas ao mesmo tempo.
  const novos = await criarUsuarios(15);
  const tentativas = (await emLotes(novos, 15, async t => [await criarPedido(t), await criarPedido(t)])).flat();
  const aCancelar = reservados.splice(0, 10);
  const [rc, rr] = await comVigiaDoPool(a, () => Promise.all([
    Promise.all(aCancelar.map(cancelar)),
    Promise.all(tentativas.map(reservar))
  ]));
  rc.forEach(r => assert.equal(r.status, 200, 'cancelamento de pedido reservado deve dar 200'));
  rr.forEach((r, i) => r.status === 200
    ? sucessoValido(r, tentativas[i].id)
    : erroValido(r, 409, 'POOL_CHEIO'));
  const okMisto = rr.filter(r => r.status === 200).length;
  assert.equal(okMisto <= 10, true, `aprovadas (${okMisto}) além das 10 vagas liberadas`);
  assert.equal((await lerPool(a)).ocupadas, 100 - 10 + okMisto);
  console.log(`✓ Extra. Pool cheio, 10 cancelamentos + 30 reservas simultâneos: ${okMisto} aprovadas, ` +
    `pool ${100 - 10 + okMisto}/100`);

  // Limpeza: devolve o pool vazio para permitir nova execução.
  await emLotes(criados, 15, cancelar);
  assert.deepEqual(await lerPool(c), { total: 100, ocupadas: 0, livres: 100 });
  console.log('✓ 8. Invariantes ocupadas <= 100 e ocupadas + livres = 100 em todas as leituras');
  console.log('✓ Pool devolvido vazio (0/100)');
}

executar().catch(erro => {
  console.error('FALHA NO TESTE DE REGRAS:', erro);
  console.error('O banco pode ter ficado com reservas. Reinicie com: docker compose down -v && docker compose up --build -d');
  process.exitCode = 1;
});
