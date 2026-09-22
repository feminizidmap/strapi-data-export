import type { Core } from '@strapi/strapi';

import { encode } from './csv';
import { columnsFor, flattenDocument, mergeByStatus } from './flatten';
import { buildPopulate } from './populate';
import { makeSerialiser } from './serialise';
import type { Archive, ExportOptions, ExportedDocument, Plan, Status } from '../types';

export interface ExportResult {
  filename: string;
  mime: string;
  body: string;
  count: number;
  /** Things left out, said plainly rather than discovered later. */
  warnings: string[];
}

export const DEFAULTS: Omit<ExportOptions, 'uid'> = {
  format: 'json',
  status: 'both',
  relations: true,
  media: true,
  onlyFirst: false,
};

/** `api::article.article` -> `article`, for a filename a person can read. */
const shortName = (uid: string): string => uid.split('.').pop() ?? uid;

const exportService = ({ strapi }: { strapi: Core.Strapi }) => {
  const serialiser = makeSerialiser(strapi);
  const schema = () => strapi.plugin('ferry').service('schema');

  const self = {
    /** Everything of one content type that matches, as a file. */
    async run(options: ExportOptions): Promise<ExportResult> {
      const opts = { ...DEFAULTS, ...options };

      if (!schema().allowed(opts.uid)) {
        throw new Error(`[ferry] ${opts.uid} is not available for transfer.`);
      }

      const plan: Plan = schema().plan(opts.uid);
      const warnings: string[] = [];

      const maxExport = Number(strapi.plugin('ferry').config('maxExport')) || 10_000;

      const labels = opts.format === 'csv';

      const populate = buildPopulate(strapi, plan, {
        relations: opts.relations,
        media: opts.media,
        labels,
      });

      const query: Record<string, unknown> = { populate };

      // `status` is meaningless on a content type without draft and publish,
      // and passing it anyway is the sort of thing that works until a Strapi
      // minor decides to validate it. `both` is not a document-service status
      // either: it is two reads, merged below.
      if (opts.locale) query.locale = opts.locale;

      const filters: Record<string, unknown> = { ...(opts.filters ?? {}) };
      if (opts.documentIds?.length) filters.documentId = { $in: opts.documentIds };
      if (Object.keys(filters).length > 0) query.filters = filters;
      if (opts.sort) query.sort = opts.sort;

      // The whole result is held in memory to be written as one file, so the
      // cap is a statement of what this can actually do rather than a policy.
      // Silently returning the first page instead would be worse: a truncated
      // export looks exactly like a complete one.
      const limit = Math.min(opts.limit ?? maxExport, maxExport);
      const both = opts.status === 'both' && plan.draftAndPublish;

      const read = async (status?: 'draft' | 'published', cap = limit) => {
        const one: Record<string, unknown> = { ...query, limit: cap };
        if (plan.draftAndPublish && status) one.status = status;

        return plan.kind === 'singleType'
          ? self.readSingle(opts.uid, one)
          : strapi.documents(opts.uid as any).findMany(one as any);
      };

      const serialise = (raw: any): ExportedDocument =>
        serialiser.document(raw, plan, { relations: opts.relations, media: opts.media, labels });

      let serialised: ExportedDocument[];
      let truncated = false;

      if (both) {
        // Fetch each version up to the environment cap, then apply the row
        // limit to the merged file. One document can be two rows, so limiting
        // each query to `limit` would drop the published copy of a document
        // whose draft still fit.
        const draftRaw = await read('draft', maxExport);
        const publishedRaw = await read('published', maxExport);
        if (draftRaw.length >= maxExport || publishedRaw.length >= maxExport) truncated = true;

        const tag = (raw: any[], status: 'draft' | 'published'): ExportedDocument[] =>
          raw.map((item) => ({ ...serialise(item), status }));

        serialised = opts.sort
          ? [...tag(draftRaw, 'draft'), ...tag(publishedRaw, 'published')]
          : mergeByStatus([
              { status: 'draft', documents: draftRaw.map(serialise) },
              { status: 'published', documents: publishedRaw.map(serialise) },
            ]);

        if (serialised.length > limit) truncated = true;
        serialised = serialised.slice(0, limit);
      } else {
        const status = opts.status === 'published' ? 'published' : 'draft';
        const documents = await read(plan.draftAndPublish ? status : undefined);
        serialised = documents.map(serialise);

        // Sorted by the one key that is the same in every environment, so two
        // exports of the same content are the same bytes and a diff means a real
        // change. An explicit sort is the user overriding that on purpose.
        if (!opts.sort) {
          serialised.sort((a, b) => a.documentId.localeCompare(b.documentId));
        }

        if (serialised.length >= limit) truncated = true;
      }

      if (truncated) {
        warnings.push(
          `Stopped at ${limit} documents, which is this environment's export limit. There may be more - narrow the export with filters, or raise \`maxExport\` in the plugin config.`
        );
      }

      if (plan.media.length > 0 && opts.media) {
        warnings.push(
          `Media fields (${plan.media.map((f) => f.name).join(', ')}) travel as a reference, not as the file. The import reconnects them when the same upload already exists.`
        );
      }

      const reportedStatus: Status = both
        ? 'both'
        : opts.status === 'published'
          ? 'published'
          : 'draft';

      if (opts.format === 'csv') {
        const planFor = (uid: string) => schema().componentPlan(uid);
        const csvDocuments = plan.draftAndPublish
          ? serialised.map((document) => ({
              ...document,
              status: document.status ?? reportedStatus,
            }))
          : serialised;
        const rows = csvDocuments.map((document) =>
          flattenDocument(document, plan, planFor, {
            relations: opts.relations,
            media: opts.media,
            onlyFirst: opts.onlyFirst,
          })
        );
        const columns =
          rows.length > 0
            ? columnsFor(rows, plan, planFor)
            : [
                'documentId',
                ...(plan.localized ? ['locale'] : []),
                ...(plan.draftAndPublish ? ['status'] : []),
              ];

        return {
          filename: `${shortName(opts.uid)}.csv`,
          mime: 'text/csv; charset=utf-8',
          body: encode(rows, columns),
          count: serialised.length,
          warnings,
        };
      }

      const archive: Archive = {
        ferry: 1,
        contentType: opts.uid,
        status: reportedStatus,
        ...(opts.locale ? { locale: opts.locale } : {}),
        count: serialised.length,
        documents: serialised,
      };

      return {
        filename: `${shortName(opts.uid)}.json`,
        mime: 'application/json',
        body: `${JSON.stringify(archive, null, 2)}\n`,
        count: serialised.length,
        warnings,
      };
    },

    /**
     * A single type is one document, or none at all before anyone has saved it.
     * The document service still answers `findFirst`, so the only difference
     * from a collection is the shape of the answer.
     */
    async readSingle(uid: string, query: Record<string, unknown>): Promise<any[]> {
      const document = await strapi.documents(uid as any).findFirst(query as any);
      return document ? [document] : [];
    },
  };

  return self;
};

export default exportService;
