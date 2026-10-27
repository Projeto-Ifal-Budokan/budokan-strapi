/**
 * Forca documento publicado nas leituras publicas do feedback.
 *
 * Por que middleware e nao policy: a content API do Strapi 5 aceita `?status=draft`, e o
 * CoreService usa `status: 'published'` apenas como default — o parametro enviado pelo
 * cliente ganha. Sem isto, `GET /api/feedbacks?status=draft` devolveria ao papel Public os
 * depoimentos ainda nao aprovados, exatamente o conteudo que a moderacao existe para nao
 * mostrar. A policy nao serve: createPolicyContext faz Object.assign({}, ctx) e `query` do
 * Koa e getter no prototype, entao nao ha garantia de encontrar o objeto real de query.
 *
 * Duas coisas que quase derrubaram o CMS e valem o registro:
 *   - o nome em config/middlewares.ts tem que ser `global::force-published`. O loader le
 *     <dist>/src/middlewares/*.js e registra como global::<arquivo>; strapi.middleware() e
 *     um lookup exato de chave, entao "./force-published" da "Middleware not found" e o
 *     boot aborta.
 *   - o export tem que ser uma FABRICA: instantiateMiddleware chama factory(config,
 *     {strapi}) e usa o retorno como middleware. Exportando o middleware direto, o retorno
 *     vira undefined e o Strapi coloca um dummy silencioso — a protecao existe no papel e
 *     nao roda.
 *
 * O painel do Strapi nao e afetado: ele usa as rotas de content-manager, nao /api/feedbacks.
 */

interface QueryGuardContext {
  path: string;
  method: string;
  query: Record<string, unknown>;
  request: { query: Record<string, unknown> };
}

const FEEDBACK_PATH = '/api/feedbacks';

const forcePublished = (ctx: QueryGuardContext, next: () => Promise<void>) => {
  if (ctx.path.startsWith(FEEDBACK_PATH) && ctx.method === 'GET') {
    ctx.query.status = 'published';
    // ctx.query delega para ctx.request.query; atribuir nos dois cobre o caso de o
    // middleware strapi::query ter substituido um dos dois objetos
    ctx.request.query.status = 'published';
  }

  return next();
};

export default () => forcePublished;
