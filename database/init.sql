-- Executado automaticamente pelo contêiner PostgreSQL no primeiro start.
CREATE TABLE usuarios (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE shows (
    id INTEGER PRIMARY KEY,
    total_vagas INTEGER NOT NULL CHECK (total_vagas = 100)
);

INSERT INTO shows (id, total_vagas) VALUES (7, 100);

CREATE TABLE pedidos (
    id BIGSERIAL PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES usuarios(id),
    show_id INTEGER NOT NULL REFERENCES shows(id),
    status VARCHAR(20) NOT NULL DEFAULT 'NO_CARRINHO'
      CHECK (status IN ('NO_CARRINHO', 'RESERVADO', 'CANCELADO')),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Consultas rápidas de contagem de pedidos RESERVADO.
CREATE INDEX idx_pedidos_ativos_show
  ON pedidos (show_id) WHERE status = 'RESERVADO';
CREATE INDEX idx_pedidos_ativos_usuario
  ON pedidos (usuario_id) WHERE status = 'RESERVADO';
