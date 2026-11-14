import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const usuarios = Number(process.env.USUARIOS_TESTE ?? 65);
if (!Number.isInteger(usuarios) || usuarios < 1 || usuarios > 500) {
  throw new Error('USUARIOS_TESTE deve estar entre 1 e 500');
}

async function requisitar(method, path, body, token) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await r.text();
  return { status: r.status, json: raw ? JSON.parse(raw) : null, lote: r.headers.get('x-lote') };
}

async function loteComLimite(itens, limite, funcao) {
  const resultado = new Array(itens.length);
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    for (;;) {
      const i = proximo++;
      if (i >= itens.length) return;
      resultado[i] = await funcao(itens[i], i);
    }
  });
  await Promise.all(trabalhadores);
  return resultado;
}

const pedidos_minimos = quantidade => quantidade * 2 > 100;

async function main() {
  const prefixo = randomUUID().slice(0, 8);
  const registros = Array.from({ length: usuarios }, (_, i) => `${prefixo}_${i}`);
  console.log(`Preparando ${usuarios} usuários e ${usuarios * 2} pedidos...`);

  const pessoas = await loteComLimite(registros, 8, async username => {
    const senha = 'senha123';
    const a = await requisitar('POST', '/auth/registrar', { username, password: senha });
    assert.equal(a.status, 201, `Falha no cadastro: ${username}`);
    const b = await requisitar('POST', '/auth/login', { username, password: senha });
    assert.equal(b.status, 200, `Falha no login: ${username}`);
    return b.json.token;
  });

  const antes = await requisitar('GET', '/pool', undefined, pessoas[0]);
  assert.equal(antes.status, 200);
  // Com o pool já ocupado o teste passaria sem disputar as 100 vagas: falha explícita.
  assert.equal(antes.json.ocupadas, 0,
    `PRÉ-CONDIÇÃO: o pool precisa estar vazio (ocupadas=${antes.json.ocupadas}). ` +
    'Execute: docker compose down -v && docker compose up --build -d');
  assert.equal(pedidos_minimos(usuarios), true,
    'PRÉ-CONDIÇÃO: USUARIOS_TESTE deve ser >= 51 para haver mais de 100 reservas concorrentes');
  const pedidos = (await loteComLimite(pessoas, 15, async token => {
    const a = await requisitar('POST', '/pedidos', { showId: 7 }, token);
    const b = await requisitar('POST', '/pedidos', { showId: 7 }, token);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    return [{ id: a.json.id, token }, { id: b.json.id, token }];
  })).flat();

  console.log(`Disparando ${pedidos.length} reservas simultâneas...`);
  const inicio = performance.now();
  const resultados = await Promise.all(pedidos.map(({ id, token }) =>
    requisitar('POST', `/pedidos/${id}/reservar`, undefined, token)
  ));
  const duracao = Math.round(performance.now() - inicio);

  const sucessos = resultados.filter(x => x.status === 200);
  const poolCheio = resultados.filter(x => x.status === 409 && x.json?.error === 'POOL_CHEIO');
  const outros = resultados.filter(x => !(
    x.status === 200 || (x.status === 409 && x.json?.error === 'POOL_CHEIO')
  ));

  const esperados = Math.min(pedidos.length, antes.json.livres);
  assert.equal(sucessos.length, esperados, 'Quantidade inesperada de reservas aprovadas');
  assert.equal(poolCheio.length, pedidos.length - esperados, 'Falhas de pool incorretas');
  assert.equal(outros.length, 0, `Respostas inesperadas: ${JSON.stringify(outros)}`);
  assert.equal(sucessos.every(x => x.lote === '7F3A'), true);

  const depois = await requisitar('GET', '/pool', undefined, pessoas[0]);
  assert.equal(depois.status, 200);
  assert.equal(depois.json.ocupadas, antes.json.ocupadas + sucessos.length);
  assert.equal(depois.json.total, 100);
  assert.equal(depois.json.ocupadas + depois.json.livres, 100);
  assert.equal(depois.json.ocupadas <= 100, true);

  console.log(`✓ Aprovadas: ${sucessos.length}; recusadas por pool cheio: ${poolCheio.length}`);
  console.log(`✓ Ocupadas ao final: ${depois.json.ocupadas}/100; integridade: OK`);
  console.log(`✓ Duração do lote de reservas: ${duracao} ms (varia com a máquina)`);
  console.log('Observação: o teste pressupõe que não haja outro cliente alterando o pool durante a execução.');
}

main().catch(e => { console.error('FALHA NO TESTE DE CONCORRÊNCIA:', e); process.exitCode = 1; });
