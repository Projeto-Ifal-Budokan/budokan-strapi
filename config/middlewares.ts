export default [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  // o nome aqui e o uid de registro: o loader le <dist>/src/middlewares/*.js e grava como
  // global::<arquivo>, e strapi.middleware() e lookup exato de chave. './force-published'
  // nao existe no registro, cai em "Middleware not found" e o boot aborta.
  // Por ultimo de proposito: roda depois de strapi::query, com a query ja parseada.
  'global::force-published',
];
