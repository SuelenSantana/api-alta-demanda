import pg from 'pg';

// Um pool de conexões é compartilhado entre as requisições.
export const banco = new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'ingressos',
  password: process.env.PGPASSWORD ?? 'senha-local-apenas',
  database: process.env.PGDATABASE ?? 'ingressos',
  max: 15,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

banco.on('error', (erro) => {
  console.error('Erro em conexão ociosa com PostgreSQL:', erro);
});
