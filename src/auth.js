import jwt from 'jsonwebtoken';
import { ErroHttp } from './erros.js';

const segredo = process.env.JWT_SECRET;
if (!segredo) {
  throw new Error('JWT_SECRET deve ser definido nas variáveis de ambiente.');
}

export function gerarToken(usuario) {
  return jwt.sign({ sub: String(usuario.id) }, segredo, {
    algorithm: 'HS256',
    expiresIn: '24h'
  });
}

export function autenticar(req, _res, next) {
  const autorizacao = req.get('Authorization');
  const formato = /^Bearer\s+([^\s]+)$/i.exec(autorizacao ?? '');

  if (!formato) return next(new ErroHttp(401, 'NAO_AUTORIZADO'));

  try {
    const dados = jwt.verify(formato[1], segredo, { algorithms: ['HS256'] });
    const id = Number(dados.sub);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error('Token sem ID válido');
    }
    req.usuarioId = id;
    next();
  } catch {
    next(new ErroHttp(401, 'NAO_AUTORIZADO'));
  }
}
