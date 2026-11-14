import { banco } from './db.js';
import { ErroHttp } from './erros.js';

const SHOW_ID = 7;

// As solicitações entram nesta fila na ordem em que chegam ao processo Node.
// O próximo trabalho só começa depois de o anterior encerrar (sucesso ou erro).
// A fila FIFO dá previsibilidade ao atendimento em UMA instância da API.
// O bloqueio no PostgreSQL protege a consistência até entre instâncias diferentes.
let cauda = Promise.resolve();

function enfileirar(tarefa) {
  const resultado = cauda.then(tarefa);
  cauda = resultado.catch(() => {}); // Um erro não bloqueia os próximos pedidos.
  return resultado;
}

/**
 * Executa reserva/cancelamento com o MESMO bloqueio de linha.
 * A linha do show funciona como 'ponto de serialização' para os 100 ingressos.
 */
export function alterarReserva({ pedidoId, usuarioId, acao }) {
  return enfileirar(async () => {
    const cliente = await banco.connect();
    let transacaoAtiva = false;

    try {
      await cliente.query('BEGIN');
      transacaoAtiva = true;

      // Todos os caminhos que alteram vagas precisam bloquear primeiro o show.
      // Assim, duas transações concorrentes não aprovam a última vaga juntas.
      const show = await cliente.query(
        'SELECT total_vagas FROM shows WHERE id = $1 FOR UPDATE',
        [SHOW_ID]
      );
      if (!show.rowCount) throw new ErroHttp(404, 'SHOW_NAO_ENCONTRADO');

      // Mesmo quando o ID pertence a outra pessoa, retornamos 404.
      const pedido = await cliente.query(
        `SELECT id, status FROM pedidos
         WHERE id = $1 AND usuario_id = $2 AND show_id = $3
         FOR UPDATE`,
        [pedidoId, usuarioId, SHOW_ID]
      );
      if (!pedido.rowCount) throw new ErroHttp(404, 'PEDIDO_NAO_ENCONTRADO');

      const atual = pedido.rows[0].status;
      if (acao === 'reservar') {
        if (atual !== 'NO_CARRINHO') {
          throw new ErroHttp(409, 'ESTADO_INVALIDO');
        }

        // Contagens com o bloqueio global mantido até o COMMIT.
        const contagem = await cliente.query(
          `SELECT
             (SELECT COUNT(*)::integer FROM pedidos
              WHERE usuario_id = $1 AND status = 'RESERVADO') AS pessoal,
             (SELECT COUNT(*)::integer FROM pedidos
              WHERE show_id = $2 AND status = 'RESERVADO') AS ocupadas`,
          [usuarioId, SHOW_ID]
        );

        // Prioridade: a cota pessoal é verificada antes do pool global.
        if (contagem.rows[0].pessoal >= 2) {
          throw new ErroHttp(409, 'COTA_PESSOAL');
        }
        if (contagem.rows[0].ocupadas >= show.rows[0].total_vagas) {
          throw new ErroHttp(409, 'POOL_CHEIO');
        }

        await cliente.query(
          `UPDATE pedidos SET status = 'RESERVADO', atualizado_em = NOW()
           WHERE id = $1`,
          [pedidoId]
        );
      } else if (acao === 'cancelar') {
        // Só um pedido reservado pode devolver uma vaga ao pool.
        if (atual !== 'RESERVADO') {
          throw new ErroHttp(409, 'ESTADO_INVALIDO');
        }
        await cliente.query(
          `UPDATE pedidos SET status = 'CANCELADO', atualizado_em = NOW()
           WHERE id = $1`,
          [pedidoId]
        );
      } else {
        throw new Error('Ação interna inválida');
      }

      await cliente.query('COMMIT');
      transacaoAtiva = false;
      return {
        id: Number(pedido.rows[0].id),
        status: acao === 'reservar' ? 'RESERVADO' : 'CANCELADO'
      };
    } catch (erro) {
      if (transacaoAtiva) {
        try { await cliente.query('ROLLBACK'); }
        catch (erroRollback) { console.error('Falha no ROLLBACK:', erroRollback); }
      }
      throw erro;
    } finally {
      cliente.release();
    }
  });
}
