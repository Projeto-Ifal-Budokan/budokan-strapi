import { factories } from '@strapi/strapi';
import { createHash } from 'node:crypto';

/**
 * Controller de feedback.
 *
 * O papel Public recebe `create` nesta API (ver bootstrap em src/index.ts), porque o
 * formulario nao tem login. O que fecha a porta e o cabecalho X-Feedback-Key: so o
 * servidor do Next o envia, e ele nunca chega ao navegador. Sem FEEDBACK_SUBMIT_KEY no
 * .env o endpoint recusa tudo — configuracao incompleta nao deixa um endpoint de escrita
 * aberto em producao.
 */

const DISCIPLINES = ['karate', 'kendo', 'archery', 'geral'] as const;
const NAME_MIN = 2;
const NAME_MAX = 60;
const MESSAGE_MIN = 20;
const MESSAGE_MAX = 500;

interface FeedbackPayload {
  authorName?: unknown;
  discipline?: unknown;
  rating?: unknown;
  message?: unknown;
  /** campo isca: humano nao preenche, bot preenche. Nunca vira coluna. */
  website?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const validate = (payload: FeedbackPayload): string[] => {
  const errors: string[] = [];

  const name = asText(payload.authorName);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.push(`authorName: entre ${NAME_MIN} e ${NAME_MAX} caracteres`);
  }

  const message = asText(payload.message);
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    errors.push(`message: entre ${MESSAGE_MIN} e ${MESSAGE_MAX} caracteres`);
  }

  const discipline = asText(payload.discipline) || 'geral';
  if (!(DISCIPLINES as readonly string[]).includes(discipline)) {
    errors.push('discipline: valor desconhecido');
  }

  if (payload.rating !== undefined && payload.rating !== null && payload.rating !== '') {
    const rating = Number(payload.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      errors.push('rating: inteiro entre 1 e 5');
    }
  }

  return errors;
};

/**
 * Hash do IP com um salt por processo: serve para rastrear abuso repetido sem guardar o
 * IP em claro. Nao e identificador estavel sem proxy configurado, entao nao e usado para
 * decidir nada — a limitacao por IP acontece no servidor do Next.
 */
const hashIp = (ip: string): string =>
  createHash('sha256').update(`${ip}:${process.env.FEEDBACK_SUBMIT_KEY ?? ''}`).digest('hex').slice(0, 32);

export default factories.createCoreController(
  'api::feedback.feedback',
  ({ strapi }) => ({
    async create(ctx) {
      const expected = process.env.FEEDBACK_SUBMIT_KEY;
      if (!expected) {
        return ctx.badRequest('Envio de feedback desativado: FEEDBACK_SUBMIT_KEY ausente.');
      }
      if (ctx.request.headers['x-feedback-key'] !== expected) {
        return ctx.unauthorized('Chave de envio invalida.');
      }

      const payload = (((ctx.request.body as Record<string, unknown>) ?? {}).data ??
        {}) as FeedbackPayload;

      // Isca preenchida: responde igual a um envio legitimo para o bot nao aprender que
      // foi pego. Nada e gravado.
      if (asText(payload.website) !== '') {
        return { data: { ok: true } };
      }

      const errors = validate(payload);
      if (errors.length > 0) {
        return ctx.badRequest('Dados invalidos.', { errors });
      }

      const rating = payload.rating === undefined || payload.rating === null || payload.rating === ''
        ? null
        : Number(payload.rating);

      // documents() e nao service(): o CoreService.getFetchParams injeta
      // { status: 'published' } como default, entao service().create() publica a entrada
      // na hora e a moderacao nao segura nada. Sem status, documents().create() grava como
      // rascunho (publishedAt null) e e isso que queremos: aparece so depois de aprovar.
      // validate() ja garantiu que o valor esta em DISCIPLINES; o cast so devolve o tipo
      const discipline = (asText(payload.discipline) || 'geral') as
        (typeof DISCIPLINES)[number];

      const created = await strapi.documents('api::feedback.feedback').create({
        data: {
          authorName: asText(payload.authorName),
          discipline,
          rating,
          message: asText(payload.message),
          submittedAt: new Date().toISOString(),
          submitterIpHash: hashIp(ctx.request.ip ?? ''),
          userAgent: String(ctx.request.headers['user-agent'] ?? '').slice(0, 200),
        },
      });

      return { data: { ok: true, documentId: created.documentId } };
    },
  })
);
