export class ErroHttp extends Error {
  constructor(status, codigo) {
    super(codigo);
    this.status = status;
    this.codigo = codigo;
  }
}
