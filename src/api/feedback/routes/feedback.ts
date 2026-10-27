/**
 * Rotas do feedback.
 *
 * O Strapi 5 gera find, findOne, create, update e delete a partir do content type. A leitura
 * publica e protegida pelo middleware ./force-published (src/middlewares), que nao deixa
 * ninguem pedir status=draft na content API. A escrita passa pelo cabecalho X-Feedback-Key
 * no controller, e o bootstrap nao concede update nem delete ao papel Public.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::feedback.feedback');
