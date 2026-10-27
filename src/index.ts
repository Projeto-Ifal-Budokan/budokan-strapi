import type { Core } from '@strapi/strapi';

/**
 * Acoes que o papel Public recebe nesta API.
 *
 * `create` parece assustador para um papel sem login, e e por isso que o controller exige
 * o cabecalho X-Feedback-Key: quem nao e o servidor do Next nao consegue gravar. Leitura
 * fica limitada a find/findPage — nao existe findOne/update/delete publico.
 *
 * O syncPermissions do users-permissions so cria linhas de permissao quando a tabela esta
 * vazia (primeiro boot). Num banco que ja existe, acao nova de content type nao ganha
 * permissao nenhuma por acidente — por isso esta lista explicita, e por isso ela e
 * idempotente: roda a cada boot e nao duplica.
 */
const PUBLIC_FEEDBACK_ACTIONS = [
  'api::feedback.feedback.find',
  'api::feedback.feedback.findPage',
  'api::feedback.feedback.create',
];

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
  },
};
