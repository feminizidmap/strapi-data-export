import { describe, expect, it } from 'vitest';

import {
  columnsFor,
  flattenDocument,
  mergeByStatus,
  type PlanFor,
} from '../server/src/services/flatten';
import type { Plan } from '../server/src/types';

const plan = (partial: Pick<Plan, 'uid'> & Partial<Plan>): Plan => ({
  kind: 'collectionType',
  draftAndPublish: false,
  localized: false,
  scalars: [],
  relations: [],
  components: [],
  dynamicZones: [],
  media: [],
  skipped: [],
  ...partial,
});

const link = plan({
  uid: 'shared.link',
  scalars: [
    { name: 'href', type: 'string' },
    { name: 'label', type: 'string' },
  ],
});

const seo = plan({
  uid: 'shared.seo',
  scalars: [{ name: 'metaTitle', type: 'string' }],
  components: [{ name: 'canonical', component: 'shared.link', repeatable: false }],
  relations: [{ name: 'owner', target: 'api::author.author', many: false }],
});

const quote = plan({
  uid: 'shared.quote',
  scalars: [{ name: 'body', type: 'text' }],
});

const article = plan({
  uid: 'api::article.article',
  draftAndPublish: true,
  scalars: [
    { name: 'title', type: 'string' },
    { name: 'meta', type: 'json' },
  ],
  relations: [
    { name: 'author', target: 'api::author.author', many: false },
    { name: 'tags', target: 'api::tag.tag', many: true },
  ],
  components: [{ name: 'seo', component: 'shared.seo', repeatable: false }],
  dynamicZones: [{ name: 'blocks', components: ['shared.quote', 'shared.seo'] }],
  media: [{ name: 'cover', many: false }],
});

const author = plan({
  uid: 'api::author.author',
  scalars: [{ name: 'name', type: 'string' }],
  components: [{ name: 'links', component: 'shared.link', repeatable: true }],
});

const plans: Record<string, Plan> = {
  'shared.link': link,
  'shared.seo': seo,
  'shared.quote': quote,
};

const planFor: PlanFor = (uid) => {
  const found = plans[uid];
  if (!found) throw new Error(`unknown component ${uid}`);
  return found;
};

const options = { relations: true, media: true, onlyFirst: false };

describe('flattenDocument', () => {
  const document = {
    documentId: 'ferryarticleone000001',
    status: 'draft',
    title: 'The first one',
    meta: { source: 'test' },
    author: 'author-id',
    tags: ['tag-a', 'tag-b'],
    seo: {
      metaTitle: 'Meta',
      canonical: { href: 'https://example.com/one', label: 'Canonical' },
      owner: 'author-id',
    },
    blocks: [
      { __component: 'shared.quote', body: 'First block' },
      { __component: 'shared.seo', metaTitle: 'Second block' },
    ],
    cover: {
      name: 'cover.png',
      url: '/uploads/cover.png',
      hash: 'ferrycoverhash0001',
      ext: '.png',
      mime: 'image/png',
      size: 12.34,
    },
  };

  const row = flattenDocument(document, article, planFor, options);

  it('keeps a nested component and the component inside it', () => {
    expect(row['seo:metaTitle']).toBe('Meta');
    expect(row['seo:canonical:href']).toBe('https://example.com/one');
    expect(row['seo:canonical:label']).toBe('Canonical');
  });

  it('keeps a relation that lives inside a component', () => {
    expect(row['seo:owner']).toBe('author-id');
  });

  it('joins a to-many relation into one cell', () => {
    expect(row.tags).toBe('tag-a,tag-b');
    expect(row.author).toBe('author-id');
  });

  it('keeps dynamic zone order and the component uid', () => {
    expect(row['blocks:1:__component']).toBe('shared.quote');
    expect(row['blocks:1:body']).toBe('First block');
    expect(row['blocks:2:__component']).toBe('shared.seo');
    expect(row['blocks:2:metaTitle']).toBe('Second block');
  });

  it('splits media into the fields JSON already carries', () => {
    expect(row['cover:hash']).toBe('ferrycoverhash0001');
    expect(row['cover:name']).toBe('cover.png');
  });

  it('leaves a json value as one cell', () => {
    expect(row.meta).toEqual({ source: 'test' });
    expect(row).not.toHaveProperty('meta:source');
  });

  it('indexes a repeatable component from one, in order', () => {
    const flattened = flattenDocument(
      {
        documentId: 'author-1',
        name: 'Ada',
        links: [
          { href: 'https://example.com', label: 'Home' },
          { href: 'https://example.org', label: 'Other' },
        ],
      },
      author,
      planFor,
      options
    );

    expect(flattened['links:1:label']).toBe('Home');
    expect(flattened['links:2:label']).toBe('Other');
  });

  it('keeps only the first repeatable entry, and drops the index, when asked', () => {
    const flattened = flattenDocument(
      {
        documentId: 'author-1',
        name: 'Ada',
        links: [
          { href: 'https://example.com', label: 'Home' },
          { href: 'https://example.org', label: 'Other' },
        ],
      },
      author,
      planFor,
      { ...options, onlyFirst: true }
    );

    expect(flattened['links:label']).toBe('Home');
    expect(flattened['links:href']).toBe('https://example.com');
    expect(flattened).not.toHaveProperty('links:1:label');
    expect(flattened).not.toHaveProperty('links:2:label');
    expect(JSON.stringify(flattened)).not.toContain('Other');
  });
});

describe('columnsFor', () => {
  it('sorts identity columns first, then schema order, with numeric segments', () => {
    const victim = plan({
      uid: 'api::case.case',
      draftAndPublish: true,
      components: [{ name: 'victim', component: 'victim.victim', repeatable: true }],
    });
    plans['victim.victim'] = plan({
      uid: 'victim.victim',
      scalars: [
        { name: 'firstname', type: 'string' },
        { name: 'age', type: 'integer' },
      ],
    });

    const columns = columnsFor(
      [
        {
          documentId: 'case-1',
          status: 'draft',
          'victim:10:firstname': 'Late',
          'victim:2:age': 30,
          'victim:2:firstname': 'Early',
        },
      ],
      victim,
      planFor
    );

    expect(columns).toEqual([
      'documentId',
      'status',
      'victim:2:firstname',
      'victim:2:age',
      'victim:10:firstname',
    ]);
  });

  it('orders an article row the way the schema is written', () => {
    const row = flattenDocument(
      {
        documentId: 'one',
        status: 'published',
        title: 'T',
        author: 'a',
        tags: ['b'],
        seo: { metaTitle: 'M', canonical: { href: 'https://example.com', label: 'L' }, owner: 'a' },
        blocks: [{ __component: 'shared.quote', body: 'Q' }],
        cover: { hash: 'h', name: 'n.png' },
      },
      article,
      planFor,
      options
    );

    expect(columnsFor([row], article, planFor)).toEqual([
      'documentId',
      'status',
      'title',
      'seo:metaTitle',
      'seo:canonical:href',
      'seo:canonical:label',
      'seo:owner',
      'blocks:1:__component',
      'blocks:1:body',
      'author',
      'tags',
      'cover:name',
      'cover:hash',
    ]);
  });
});

describe('mergeByStatus', () => {
  it('keeps both versions of one document, draft first', () => {
    const merged = mergeByStatus([
      {
        status: 'draft',
        documents: [
          { documentId: 'b', title: 'B draft' },
          { documentId: 'a', title: 'A draft' },
        ],
      },
      {
        status: 'published',
        documents: [{ documentId: 'a', title: 'A published' }],
      },
    ]);

    expect(
      merged.map((document) => [document.documentId, document.status, document.title])
    ).toEqual([
      ['a', 'draft', 'A draft'],
      ['a', 'published', 'A published'],
      ['b', 'draft', 'B draft'],
    ]);
  });
});
