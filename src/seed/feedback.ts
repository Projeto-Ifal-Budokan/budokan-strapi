import type { Core } from '@strapi/strapi';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Os tres depoimentos que estavam hardcoded no site passam a morar aqui.
 *
 * O conteudo veio de `budokan-fe/src/data/testimonials.ts`, onde era copia colada no
 * codigo: para corrigir uma virgula era preciso um deploy do site. Publicado no CMS, o
 * texto muda pelo painel e aparece no site em ate cinco minutos, sem redeploy.
 *
 * So roda com FEEDBACK_SEED_ENABLED=1 no ambiente. Sem a variavel o boot nao toca no
 * conteudo — um ambiente novo nasce vazio ate alguem decidir popular, e ninguem descobre
 * no meio de um deploy que o CMS inseriu gente por conta propria.
 *
 * Idempotente por `authorName`: rodar dez vezes cria tres entradas, nao trinta. A foto
 * segue a mesma regra do controller de envio — nome de arquivo e hash do conteudo —,
 * entao a mesma foto nunca e gravada duas vezes e o varredor de orfaos da retencao
 * reconhece o arquivo como referenciado.
 *
 * `googleSub` fica vazio de proposito. A coluna existe para rastrear quem enviou pelo
 * formulario; aqui nao houve envio, houve migracao de conteudo que ja estava no ar. Deixar
 * um `sub` inventado faria estas tres linhas parecerem conta de alguem.
 *
 * `consentVersion` recebe um valor que nao confunde: `seed-declarado` diz que o aceite
 * dessas tres pessoas nao foi capturado no modal — elas ja estavam publicadas no site
 * antes desta colecao existir, e o consentimento delas esta com a escola, fora do sistema.
 * Um aceite de verdade tem data e uma versao de texto; estas linhas nao tem nem uma nem
 * outra.
 */

const SEED_FLAG = 'FEEDBACK_SEED_ENABLED';
const SEED_CONSENT_VERSION = 'seed-declarado';
const ASSET_SUBDIR = path.join('src', 'seed', 'assets');
const PHOTO_SUBDIR = path.join('uploads', 'feedback');

type Discipline = 'karate' | 'kendo' | 'archery' | 'geral';

interface FeaturedFeedback {
  authorName: string;
  discipline: Discipline;
  message: string;
  photoFile: string;
}

/**
 * Textos iguais aos que estavam no site, sem as aspas que a pagina antiga embutia no
 * conteudo: aspas de enfeite em dado armazenado viram aspas quando alguem reutiliza o
 * texto em outro lugar.
 */
const FEATURED: FeaturedFeedback[] = [
  {
    authorName: 'Aldemar Araújo',
    discipline: 'karate',
    photoFile: 'avatar-aldemar-araujo.jpg',
    message:
      'Iniciei minha jornada no Karate em 2006 na Budokan-Ryu, atraído pela excelência técnica e pelo ambiente acolhedor que a escola proporciona. Ao longo dos anos, a combinação de instrução de alta qualidade e uma atmosfera de respeito mútuo permitiu-me desenvolver habilidades técnicas sólidas e crescer pessoalmente. A ênfase na disciplina, filosofia e tradição do Karate-Do na Budokan-Ryu tem sido fundamental para minha formação, reforçando valores essenciais que aplico em todas as áreas da minha vida.',
  },
  {
    authorName: 'Lilian Carmen',
    discipline: 'archery',
    photoFile: 'avatar-lilian-carmen.jpg',
    message:
      'Comecei a praticar tiro com arco em 2019 e, ao longo dos treinos, fui desenvolvendo a forma de execução correta para um tiro preciso. Em 2021 inicio a prática de tiro com arco na Budokan Arquearia, onde aprimorei, com a prática constante, a percepção do corpo, controle da respiração, forma de segurar o arco e a tensão aplicada à corda. Princípios fundamentais que ajudam na formação intrapessoal e interpessoal.',
  },
  {
    authorName: 'Walter Moura',
    discipline: 'kendo',
    photoFile: 'avatar-walter-moura.jpg',
    message:
      'Há 10 anos, Sempai Alencar me levou para uma aula de Kendo. Eu estava passando por vários problemas na minha vida pessoal e sempre muito resistente a participar de uma única aula. Me lembro como se fosse hoje: quando cheguei ao dojo, me deparei com um senhor dos seus quase 70 anos, com olhos puxados e de um semblante sério — Sensei Shasan. A partir daquele dia, entendi que a disciplina e o amor pelo que fazemos e acreditamos pode mudar nossas vidas. Assim foi com a minha. Oss!!!',
  },
];

/** mesmo hash do controller de envio: conteudo identico, arquivo identico, uma copia so */
const contentHash = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 40);

/**
 * Copia a foto do repositorio para o mesmo lugar onde o controller de envio grava as fotos
 * do Google: `public/uploads/feedback`, que ja e volume persistente no compose e ja e
 * servido pelo middleware `strapi::public`.
 *
 * O arquivo-fonte fica fora de `public/uploads` de proposito: `public/uploads` e montagem
 * de volume, entao qualquer coisa commitada la dentro fica invisivel no container.
 */
const copyPhotoToUploads = async (
  strapi: Core.Strapi,
  fileName: string,
  bytes: Buffer
): Promise<string> => {
  const dir = path.join(strapi.dirs.static.public, PHOTO_SUBDIR);
  const target = path.join(dir, `${contentHash(bytes)}.jpg`);

  try {
    await fs.access(target);
  } catch {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, bytes);
  }

  const origin = (process.env.STRAPI_URL ?? '').replace(/\/+$/, '');
  return `${origin}/${PHOTO_SUBDIR}/${contentHash(bytes)}.jpg`.replace(
    /\\/g,
    '/'
  );
};

export async function seedFeaturedFeedbacks(strapi: Core.Strapi) {
  if (process.env[SEED_FLAG] !== '1') {
    strapi.log.info(
      `feedback seed: desligado (defina ${SEED_FLAG}=1 para cadastrar os depoimentos de destaque).`
    );
    return;
  }

  const assetDir = path.join(strapi.dirs.app.root, ASSET_SUBDIR);
  let created = 0;
  let skipped = 0;

  for (const entry of FEATURED) {
    try {
      // documents() sem status le o que esta no ar: se o nome ja existe publicado, alguem
      // (ou um boot anterior) ja cuidou disso. sem `fields`: a contagem e o que importa,
      // e recortar campos aqui so acrescenta uma chance de o tipo reclamar
      const existing = await strapi
        .documents('api::feedback.feedback')
        .findMany({ filters: { authorName: entry.authorName } });

      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      const bytes = await fs.readFile(path.join(assetDir, entry.photoFile));
      const authorPhotoUrl = await copyPhotoToUploads(
        strapi,
        entry.photoFile,
        bytes
      );

      // create() sem status grava rascunho; publish() e o que poe no ar. A sequencia e
      // explicita porque o resto do sistema depende de rascunho ser o estado inicial —
      // aqui a aprovacao ja aconteceu, ela so nao aconteceu dentro do painel
      const draft = await strapi.documents('api::feedback.feedback').create({
        data: {
          authorName: entry.authorName,
          discipline: entry.discipline,
          rating: null,
          message: entry.message,
          authorPhotoUrl,
          googleSub: null,
          consentAt: null,
          consentVersion: SEED_CONSENT_VERSION,
          submittedAt: null,
          submitterIpHash: null,
          userAgent: null,
        },
      });

      await strapi
        .documents('api::feedback.feedback')
        .publish({ documentId: draft.documentId });

      created += 1;
    } catch (error) {
      // seed que falha nao derruba o boot: o CMS tem que subir mesmo sem conteudo de
      // destaque, e o log diz exatamente qual entrada e o motivo
      strapi.log.warn(
        `feedback seed: "${entry.authorName}" nao cadastrado (${(error as Error).message}).`
      );
    }
  }

  if (created > 0 || skipped > 0) {
    strapi.log.info(
      `feedback seed: ${created} criado(s), ${skipped} ja existiam.`
    );
  }
}
