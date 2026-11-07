import { factories } from '@strapi/strapi';
import type { Core } from '@strapi/strapi';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Controller de feedback.
 *
 * O papel Public recebe `create` nesta API (ver bootstrap em src/index.ts). O que fecha a
 * porta e o cabecalho X-Feedback-Key: so o servidor do Next o envia, e ele nunca chega ao
 * navegador. Sem FEEDBACK_SUBMIT_KEY no .env o endpoint recusa tudo — configuracao
 * incompleta nao deixa um endpoint de escrita aberto em producao.
 *
 * Desde o login com Google, o nome e a foto nao sao mais digitados: vem do ID token, que o
 * Next verificou (assinatura, iss, aud, exp) antes de chegar aqui. Este controller exige
 * `googleSub` e `consentAt` — sem eles nao ha escrita, entao um bundle antigo do site nao
 * consegue continuar publicando depoimento anonimo depois da mudanca.
 */

const DISCIPLINES = ['karate', 'kendo', 'archery', 'geral'] as const;
const NAME_MIN = 2;
const NAME_MAX = 60;
const MESSAGE_MIN = 20;
/**
 * 1000: o depoimento de destaque mais longo que ja estava no site tem 502 caracteres, e o
 * limite precisa sobra para quem escreve com calma. Ele fica acima do que o frontend aceita
 * de proposito — o CMS e a ultima barreira, entao ele e mais folgado; quem chega pelo site
 * ve o limite de 1000 e recebe a mensagem antes de enviar.
 */
const MESSAGE_MAX = 1000;
const SUB_MAX = 64;
/** consentimento precisa ser fresco: mais que isso e replay de um aceite velho */
const CONSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** foto: limites duros, verificados no que voltou do Google, nao no que foi prometido */
const PHOTO_MAX_BYTES = 256 * 1024;
const PHOTO_MIN_BYTES = 512;
const PHOTO_SUBDIR = path.join('uploads', 'feedback');
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface FeedbackPayload {
  authorName?: unknown;
  discipline?: unknown;
  rating?: unknown;
  message?: unknown;
  authorPhotoUrl?: unknown;
  googleSub?: unknown;
  consentAt?: unknown;
  consentVersion?: unknown;
  /** campo isca: humano nao preenche, bot preenche. Nunca vira coluna. */
  website?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isGoogleHost = (hostname: string): boolean =>
  hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');

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

  const sub = asText(payload.googleSub);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sub)) {
    errors.push(`googleSub: identificador do Google ausente ou invalido (ate ${SUB_MAX} chars)`);
  }

  const consentAt = Date.parse(asText(payload.consentAt) || String(payload.consentAt ?? ''));
  const age = Number.isNaN(consentAt) ? -1 : Date.now() - consentAt;
  if (age < 0 || age > CONSENT_MAX_AGE_MS) {
    errors.push('consentAt: precisa ser um aceite valido nas ultimas 24 horas');
  }

  if (asText(payload.consentVersion) === '') {
    errors.push('consentVersion: qual texto foi aceito');
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

/**
 * Baixa a foto do Google e grava no storage do proprio CMS.
 *
 * Por que baixar em vez de guardar a URL do Google: o link e emprestado. Se a pessoa apaga
 * a conta, ou o Google muda o endereco, o depoimento publicado fica com a foto quebrada.
 * O arquivo vai para <app>/public/uploads/feedback, que ja e volume persistente
 * (strapi-uploads no compose) e ja e servido pelo middleware strapi::public — o mesmo
 * caminho que o Media Library usa, entao nada novo e montado e nenhum provider externo e
 * contratado.
 *
 * Por que baixar aqui e nao no Next: o corpo da requisicao entre o Next e o CMS continua
 * sendo so a URL. Mandar o arquivo em base64 teria que passar pelo strapi::body, cujo
 * limite de JSON viraria regra de negocio.
 *
 * SSRF: a URL veio de um ID token ja verificado no Next, mas ainda e uma URL que chegou de
 * fora. Entao https obrigatorio, host dentro de googleusercontent.com, redirect nao e
 * seguido, e tipo e tamanho sao conferidos no que voltou — nao no que foi prometido.
 */
const saveAuthorPhoto = async (
  strapi: Core.Strapi,
  rawUrl: string,
): Promise<{ url: string; relativePath: string } | null> => {
  if (rawUrl === '') return null;

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('authorPhotoUrl: URL invalida');
  }
  if (target.protocol !== 'https:' || !isGoogleHost(target.hostname)) {
    throw new Error('authorPhotoUrl: dominio nao permitido');
  }

  const response = await fetch(target, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`authorPhotoUrl: o Google respondeu ${response.status}`);
  }

  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new Error('authorPhotoUrl: so jpeg, png ou webp');
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > PHOTO_MAX_BYTES) {
    throw new Error('authorPhotoUrl: imagem maior que 256 KB');
  }
  if (bytes.byteLength < PHOTO_MIN_BYTES) {
    throw new Error('authorPhotoUrl: imagem vazia ou corrompida');
  }

  // nome = hash do conteudo: a mesma foto nao e gravada duas vezes, e duas pessoas com
  // fotos diferentes nunca escrevem no mesmo arquivo
  const fileName = `${createHash('sha256').update(bytes).digest('hex').slice(0, 40)}.${ext}`;
  const dir = path.join(strapi.dirs.static.public, PHOTO_SUBDIR);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), bytes);

  const origin = (process.env.STRAPI_URL ?? '').replace(/\/+$/, '');
  const relativePath = `${PHOTO_SUBDIR}/${fileName}`.replace(/\\/g, '/');

  return { url: `${origin}/${relativePath}`, relativePath };
};

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

      let photo: { url: string; relativePath: string } | null;
      try {
        photo = await saveAuthorPhoto(strapi, asText(payload.authorPhotoUrl));
      } catch (error) {
        return ctx.badRequest('Dados invalidos.', {
          errors: [(error as Error).message],
        });
      }

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
          authorPhotoUrl: photo?.url ?? null,
          googleSub: asText(payload.googleSub),
          consentAt: new Date(Date.parse(asText(payload.consentAt))).toISOString(),
          consentVersion: asText(payload.consentVersion),
          submittedAt: new Date().toISOString(),
          submitterIpHash: hashIp(ctx.request.ip ?? ''),
          userAgent: String(ctx.request.headers['user-agent'] ?? '').slice(0, 200),
        },
      });

      return { data: { ok: true, documentId: created.documentId } };
    },
  })
);
