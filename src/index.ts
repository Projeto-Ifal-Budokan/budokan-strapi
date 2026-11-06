import type { Core } from '@strapi/strapi';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { seedFeaturedFeedbacks } from './seed/feedback';

/**
 * Acoes que o papel Public recebe nesta API.
 *
 * `create` parece assustador para um papel sem login, e e por isso que o controller exige
 * o cabecalho X-Feedback-Key: quem nao e o servidor do Next nao consegue gravar. Leitura
 * fica so em find — nao ha findOne/update/delete publico; o site lista, nao abre detalhe.
 *
 * O syncPermissions do users-permissions so cria linhas de permissao quando a tabela esta
 * vazia (primeiro boot). Num banco que ja existe, acao nova de content type nao ganha
 * permissao nenhuma por acidente — por isso esta lista explicita, e por isso ela e
 * idempotente: roda a cada boot e nao duplica.
 */
const PUBLIC_FEEDBACK_ACTIONS = [
  'api::feedback.feedback.find',
  'api::feedback.feedback.create',
];

/**
 * findPage era a leitura paginada do Strapi 4. No Strapi 5 as rotas geradas sao find,
 * findOne, create, update e delete; a linha antiga nao atende nada e fica como ruido no
 * painel de permissoes, entao retiramos.
 */
const REVOKED_FEEDBACK_ACTIONS = ['api::feedback.feedback.findPage'];

async function grantPublicFeedback(strapi: Core.Strapi) {
  const publicRole = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    strapi.log.warn('users-permissions: papel Public nao encontrado; feedback fica fechado.');
    return;
  }

  for (const action of PUBLIC_FEEDBACK_ACTIONS) {
    const existing = await strapi.db
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });

    if (!existing) {
      await strapi.db
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
      strapi.log.info(`users-permissions: concedido "${action}" ao papel Public.`);
    }
  }

  for (const action of REVOKED_FEEDBACK_ACTIONS) {
    const stale = await strapi.db
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });

    if (stale) {
      await strapi.db
        .query('plugin::users-permissions.permission')
        .delete({ where: { id: stale.id } });
      strapi.log.info(`users-permissions: revogado "${action}" do papel Public.`);
    }
  }
}

/**
 * Retencao dos depoimentos.
 *
 * O formulario passou a pedir login com Google, entao cada envio carrega identidade real:
 * o `sub` da conta, o nome e a foto da pessoa. Isso e dado pessoal desde o momento em que
 * chega — nao só se for publicado. Aprovar bem nao resolve a coleta: o que resolve e nao
 * guardar para sempre o que nunca foi aprovado.
 *
 * Rascunho que passa de FEEDBACK_DRAFT_TTL_DAYS sem aprovacao e apagado. Quem aprova tudo
 * dentro do prazo nao perde nada; quem nunca olha o painel para de acumular dado.
 *
 * A mesma varredura remove arquivo orfao: apagar a entrada no painel tira a linha e deixa
 * o JPEG no disco. Comparar o diretorio com o que ainda e referenciado cobre entrada
 * rejeitada, expurgada e apagada com um mecanismo so, e rodar duas vezes nao muda nada.
 */
const DRAFT_TTL_DEFAULT_DAYS = 30;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PHOTO_SUBDIR = path.join('uploads', 'feedback');

interface FeedbackRow {
  id: number;
  documentId: string;
  publishedAt?: string | null;
  submittedAt?: string | null;
  authorPhotoUrl?: string | null;
}

const draftTtlDays = (): number => {
  const raw = Number(process.env.FEEDBACK_DRAFT_TTL_DAYS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DRAFT_TTL_DEFAULT_DAYS;
};

const fileNameOf = (url?: string | null): string => {
  if (!url) return '';
  try {
    return new URL(String(url)).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
};

async function runFeedbackRetention(strapi: Core.Strapi) {
  const db = strapi.db.query('api::feedback.feedback');
  // uma leitura so: a mesma lista decide o expurgo e monta o conjunto de arquivos vivos
  const rows = ((await db.findMany({})) ?? []) as FeedbackRow[];

  // rascunho de uma entrada que ja foi publicada um dia nao e lixo: e uma versao nova
  // esperando revisao. por isso o filtro olha o documentId, nao so a linha.
  const everPublished = new Set(
    rows.filter((row) => Boolean(row.publishedAt)).map((row) => row.documentId),
  );
  const cutoff = Date.now() - draftTtlDays() * 86_400_000;

  const stale = rows.filter((row) => {
    if (row.publishedAt || everPublished.has(row.documentId)) return false;
    const submittedAt = row.submittedAt ? Date.parse(row.submittedAt) : Number.NaN;
    // sem submittedAt nao ha como saber a idade: nao apaga no chute
    return Number.isFinite(submittedAt) && submittedAt < cutoff;
  });

  for (const row of stale) {
    await db.delete({ where: { id: row.id } });
  }

  const referenced = new Set(
    rows
      .filter((row) => !stale.some((dead) => dead.id === row.id))
      .map((row) => fileNameOf(row.authorPhotoUrl))
      .filter(Boolean),
  );

  let orphans = 0;
  const dir = path.join(strapi.dirs.static.public, PHOTO_SUBDIR);
  try {
    for (const entry of await fs.readdir(dir)) {
      if (referenced.has(entry)) continue;
      await fs.rm(path.join(dir, entry), { force: true });
      orphans += 1;
    }
  } catch (error) {
    // diretorio ainda nao existe: ninguem enviou foto ate aqui
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return { purged: stale.length, orphans };
}

async function scheduleFeedbackRetention(strapi: Core.Strapi) {
  const run = async () => {
    try {
      const { purged, orphans } = await runFeedbackRetention(strapi);
      if (purged > 0 || orphans > 0) {
        strapi.log.info(
          `feedback: retencao removeu ${purged} rascunho(s) e ${orphans} arquivo(s) orfao(s).`,
        );
      }
    } catch (error) {
      // retencao que falha nao pode derrubar o boot do CMS
      strapi.log.warn(`feedback: retencao falhou (${(error as Error).message}).`);
    }
  };

  // unref: o timer nao segura o processo vivo, e num `strapi console` ele nao fica
  // pendurado depois do trabalho
  setInterval(run, RETENTION_INTERVAL_MS).unref();
  await run();
}

export default {
  /**
   * Runs before the application is initialized.
   */
  register() {},

  /**
   * Runs before the application gets started.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await grantPublicFeedback(strapi);
    await scheduleFeedbackRetention(strapi);
    // por ultimo: o seed le e escreve conteudo, e nao ha nada nele que dependa do resto do
    // boot. ele proprio decide se roda (FEEDBACK_SEED_ENABLED) e nao derruba nada
    await seedFeaturedFeedbacks(strapi);
  },
};
