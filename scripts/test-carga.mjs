// Medição de desempenho local, com carga progressiva. Exige o pool VAZIO no início.
// Uso: node scripts/test-carga.mjs   (variáveis: BASE_URL, ESTAGIOS=200,500,1000, TIMEOUT_MS)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const estagios = (process.env.ESTAGIOS ?? '200,500,1000').split(',').map(Number);
const limiteMs = Number(process.env.TIMEOUT_MS ?? 15000);
const USUARIOS = 100; // 100 usuários x cota 2 = 200 vagas de cota, suficiente para lotar o pool
const prefixo = randomUUID().slice(0, 8);

async function http(metodo, rota, corpo, token) {
  const inicio = performance.now();
  try {
    const r = await fetch(`${base}${rota}`, {
      method: metodo,
      signal: AbortSignal.timeout(limiteMs),
      headers: {
        ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) })
    });
    const texto = await r.text();
    return { status: r.status, dados: texto ? JSON.parse(texto) : null, ms: performance.now() - inicio };
  } catch (erro) {
    const timeout = erro.name === 'TimeoutError' || erro.name === 'AbortError';
    return { status: timeout ? 'TIMEOUT' : 'ERRO_REDE', dados: null, ms: performance.now() - inicio };
  }
}

function resumir(nome, respostas, duracaoMs) {
  const ms = respostas.map(r => r.ms).sort((x, y) => x - y);
  const percentil = p => Math.round(ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]);
  const contar = teste => respostas.filter(teste).length;
  const linha = {
    etapa: nome,
    total: respostas.length,
    '2xx': contar(r => r.status >= 200 && r.status < 300),
    '409': contar(r => r.status === 409),
    '5xx': contar(r => r.status >= 500),
    outros: contar(r => typeof r.status === 'number' && r.status !== 409 && (r.status < 200 || (r.status >= 300 && r.status < 500))),
    timeouts: contar(r => r.status === 'TIMEOUT'),
    erroRede: contar(r => r.status === 'ERRO_REDE'),
    p50_ms: percentil(0.5),
    p95_ms: percentil(0.95),
    max_ms: Math.round(ms[ms.length - 1]),
    duracao_ms: Math.round(duracaoMs)
  };
  return linha;
}

async function rajada(nome, tarefas) {
  const inicio = performance.now();
  const respostas = await Promise.all(tarefas.map(t => t()));
  return { linha: resumir(nome, respostas, performance.now() - inicio), respostas };
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

async function lerPool(token) {
  const r = await http('GET', '/pool', undefined, token);
  assert.equal(r.status, 200, 'GET /pool falhou');
  assert.equal(r.dados.total, 100);
  assert.equal(r.dados.ocupadas + r.dados.livres, 100);
  assert.equal(r.dados.ocupadas <= 100, true);
  return r.dados;
}

async function main() {
  const tabela = [];
  const password = 'senha123';
  const nomes = Array.from({ length: USUARIOS }, (_, i) => `${prefixo}_${i}`);

  // Autenticação: 100 cadastros simultâneos e depois 100 logins simultâneos (custo do bcrypt).
  const cadastro = await rajada(`registrar x${USUARIOS} simultâneos`,
    nomes.map(username => () => http('POST', '/auth/registrar', { username, password })));
  tabela.push(cadastro.linha);
  assert.equal(cadastro.linha['2xx'], USUARIOS, 'nem todos os cadastros retornaram 201');

  const login = await rajada(`login x${USUARIOS} simultâneos`,
    nomes.map(username => () => http('POST', '/auth/login', { username, password })));
  tabela.push(login.linha);
  assert.equal(login.linha['2xx'], USUARIOS, 'nem todos os logins retornaram 200');
  const tokens = login.respostas.map(r => r.dados.token);

  const inicial = await lerPool(tokens[0]);
  assert.equal(inicial.ocupadas, 0,
    `PRÉ-CONDIÇÃO: o pool precisa estar vazio (ocupadas=${inicial.ocupadas}). ` +
    'Execute: docker compose down -v && docker compose up --build -d');

  for (const n of estagios) {
    // Preparação (fora da medição principal): n pedidos distribuídos entre os usuários.
    const criacao = await rajada(`criar pedidos x${n} simultâneos`,
      Array.from({ length: n }, (_, i) => () => http('POST', '/pedidos', { showId: 7 }, tokens[i % USUARIOS])));
    tabela.push(criacao.linha);
    assert.equal(criacao.linha['2xx'], n, 'nem todos os pedidos foram criados');
    const pedidos = criacao.respostas.map((r, i) => ({ id: r.dados.id, token: tokens[i % USUARIOS] }));

    const reserva = await rajada(`reservar x${n} simultâneos`,
      pedidos.map(p => () => http('POST', `/pedidos/${p.id}/reservar`, undefined, p.token)));
    tabela.push(reserva.linha);

    const pool = await lerPool(tokens[0]);
    console.log(`Estágio ${n}: 200=${reserva.linha['2xx']} 409=${reserva.linha['409']} ` +
      `5xx=${reserva.linha['5xx']} timeouts=${reserva.linha.timeouts} | pool ${pool.ocupadas}/100`);
    assert.equal(pool.ocupadas, reserva.linha['2xx'], 'pool diverge do número de reservas aprovadas');
    if (reserva.linha.timeouts === 0 && reserva.linha.erroRede === 0) {
      assert.equal(reserva.linha['2xx'], 100, 'com o pool vazio, exatamente 100 reservas deveriam ser aprovadas');
    }

    // Devolve o pool vazio para o próximo estágio.
    const reservados = pedidos.filter((_, i) => reserva.respostas[i].status === 200);
    const cancelamento = await rajada(`cancelar x${reservados.length} simultâneos`,
      reservados.map(p => () => http('POST', `/pedidos/${p.id}/cancelar`, undefined, p.token)));
    tabela.push(cancelamento.linha);
    await emLotes(pedidos, 20, p => http('POST', `/pedidos/${p.id}/cancelar`, undefined, p.token));
    assert.equal((await lerPool(tokens[0])).ocupadas, 0, 'pool não voltou a zero após os cancelamentos');
  }

  console.table(tabela);
  const final = await lerPool(tokens[0]);
  console.log(`Pool final: ${JSON.stringify(final)}`);
  const falhas = tabela.reduce((s, l) => s + l['5xx'] + l.timeouts + l.erroRede, 0);
  console.log(`Total de 5xx + timeouts + erros de rede: ${falhas} (timeout do cliente: ${limiteMs} ms)`);
  if (falhas > 0) process.exitCode = 1;
}

main().catch(erro => { console.error('FALHA NO TESTE DE CARGA:', erro); process.exitCode = 1; });
