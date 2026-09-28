import type { ExportedDocument, Plan } from '../types';
import { MEDIA_FIELDS } from './populate';

/**
 * A serialised document, as one spreadsheet row.
 *
 * JSON keeps the tree. CSV cannot, so each leaf becomes a column whose name is
 * the path that led to it, joined with `:`. Repeatable components and dynamic
 * zones keep their order as a numeric segment starting at 1
 * (`victim:1:firstname`), which is the same order the JSON export writes,
 * counted the way a spreadsheet does. With `onlyFirst`, a repeatable keeps its
 * first entry and drops the number: `victim:firstname`.
 *
 * The walk follows the plan rather than every key on the object. A `json` field
 * or a custom field is one value, and splitting it would invent columns the
 * schema does not have.
 */

export type PlanFor = (componentUid: string) => Plan;

export interface FlattenOptions {
  relations: boolean;
  media: boolean;
  /** Repeatable components: first entry only, and no index in the column name. */
  onlyFirst?: boolean;
}

const LEADING = ['documentId', 'locale', 'status'];

const isIndex = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value);

const orderedNames = (plan: Plan): string[] => [
  ...plan.scalars.map((field) => field.name),
  ...plan.components.map((field) => field.name),
  ...plan.dynamicZones.map((field) => field.name),
  ...plan.relations.map((field) => field.name),
  ...plan.media.map((field) => field.name),
];

const rankIn = (names: string[], name: string): number => {
  if (name === '__component') return -1;
  const index = names.indexOf(name);
  return index === -1 ? names.length : index;
};

const zoneFieldNames = (zoneComponents: string[], planFor: PlanFor): string[] => {
  const names: string[] = [];
  for (const uid of zoneComponents) {
    for (const name of orderedNames(planFor(uid))) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
};

const mediaKeyRank = (name: string | undefined): number => {
  if (name === undefined) return -1;
  const index = MEDIA_FIELDS.indexOf(name);
  return index === -1 ? MEDIA_FIELDS.length : index;
};

/**
 * Column order for a header that should not jump around between exports.
 *
 * Identity columns first, then schema order. Numeric path segments compare as
 * numbers, so `victim:2` stays before `victim:10`.
 */
export const compareColumns = (a: string, b: string, plan: Plan, planFor: PlanFor): number => {
  const ai = LEADING.indexOf(a);
  const bi = LEADING.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }

  return compareAt(a.split(':'), b.split(':'), 0, plan, planFor);
};

const compareAt = (
  a: string[],
  b: string[],
  index: number,
  plan: Plan,
  planFor: PlanFor
): number => {
  if (index >= a.length && index >= b.length) return 0;
  if (index >= a.length) return -1;
  if (index >= b.length) return 1;

  const left = a[index];
  const right = b[index];

  if (left !== right) {
    if (isIndex(left) && isIndex(right)) return Number(left) - Number(right);
    const names = orderedNames(plan);
    const byRank = rankIn(names, left) - rankIn(names, right);
    if (byRank !== 0) return byRank;
    return left.localeCompare(right);
  }

  const component = plan.components.find((field) => field.name === left);
  if (component) {
    const child = planFor(component.component);
    if (component.repeatable) {
      const next = index + 1;
      if (isIndex(a[next]) && isIndex(b[next]) && a[next] !== b[next]) {
        return Number(a[next]) - Number(b[next]);
      }
      const afterIndex = isIndex(a[next]) ? next + 1 : next;
      return compareAt(a, b, afterIndex, child, planFor);
    }
    return compareAt(a, b, index + 1, child, planFor);
  }

  const zone = plan.dynamicZones.find((field) => field.name === left);
  if (zone) {
    const next = index + 1;
    if (isIndex(a[next]) && isIndex(b[next]) && a[next] !== b[next]) {
      return Number(a[next]) - Number(b[next]);
    }
    const afterIndex = isIndex(a[next]) ? next + 1 : next;
    return compareZoneAt(a, b, afterIndex, zone.components, planFor);
  }

  const media = plan.media.find((field) => field.name === left);
  if (media) {
    const next = index + 1;
    if (media.many && isIndex(a[next]) && isIndex(b[next])) {
      if (a[next] !== b[next]) return Number(a[next]) - Number(b[next]);
      return mediaKeyRank(a[next + 1]) - mediaKeyRank(b[next + 1]);
    }
    return mediaKeyRank(a[next]) - mediaKeyRank(b[next]);
  }

  return compareAt(a, b, index + 1, plan, planFor);
};

const compareZoneAt = (
  a: string[],
  b: string[],
  index: number,
  zoneComponents: string[],
  planFor: PlanFor
): number => {
  if (index >= a.length && index >= b.length) return 0;
  if (index >= a.length) return -1;
  if (index >= b.length) return 1;

  const left = a[index];
  const right = b[index];
  const names = zoneFieldNames(zoneComponents, planFor);

  if (left !== right) {
    if (isIndex(left) && isIndex(right)) return Number(left) - Number(right);
    const byRank = rankIn(names, left) - rankIn(names, right);
    if (byRank !== 0) return byRank;
    return left.localeCompare(right);
  }

  for (const uid of zoneComponents) {
    const child = planFor(uid);
    if (orderedNames(child).includes(left)) {
      return compareAt(a, b, index, child, planFor);
    }
  }

  return compareZoneAt(a, b, index + 1, zoneComponents, planFor);
};

const assignMedia = (row: Record<string, unknown>, prefix: string, file: unknown): void => {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return;

  for (const key of MEDIA_FIELDS) {
    if (key in file) row[`${prefix}${key}`] = (file as Record<string, unknown>)[key];
  }
};

const flattenInto = (
  value: Record<string, unknown>,
  plan: Plan,
  path: string,
  row: Record<string, unknown>,
  options: FlattenOptions,
  planFor: PlanFor
): void => {
  for (const field of plan.scalars) {
    if (!(field.name in value)) continue;
    row[`${path}${field.name}`] = value[field.name];
  }

  for (const component of plan.components) {
    if (!(component.name in value)) continue;
    const nested = value[component.name];
    const child = planFor(component.component);

    if (component.repeatable) {
      const list = Array.isArray(nested) ? nested : [];
      const items = options.onlyFirst ? list.slice(0, 1) : list;
      items.forEach((item, itemIndex) => {
        if (!item || typeof item !== 'object') return;
        const here = options.onlyFirst
          ? `${path}${component.name}:`
          : `${path}${component.name}:${itemIndex + 1}:`;
        flattenInto(item as Record<string, unknown>, child, here, row, options, planFor);
      });
      continue;
    }

    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenInto(
        nested as Record<string, unknown>,
        child,
        `${path}${component.name}:`,
        row,
        options,
        planFor
      );
    }
  }

  for (const zone of plan.dynamicZones) {
    if (!(zone.name in value)) continue;
    const zoneValue = value[zone.name];
    const entries: unknown[] = Array.isArray(zoneValue) ? zoneValue : [];

    entries.forEach((entry, entryIndex) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      const prefix = `${path}${zone.name}:${entryIndex + 1}:`;
      if (record.__component) row[`${prefix}__component`] = record.__component;
      if (typeof record.__component !== 'string') return;
      flattenInto(record, planFor(record.__component), prefix, row, options, planFor);
    });
  }

  if (options.relations) {
    for (const relation of plan.relations) {
      if (!(relation.name in value)) continue;
      const related = value[relation.name];
      row[`${path}${relation.name}`] = Array.isArray(related) ? related.join(',') : related;
    }
  }

  if (options.media) {
    for (const field of plan.media) {
      if (!(field.name in value)) continue;
      const media = value[field.name];

      if (field.many) {
        const files = Array.isArray(media) ? media : media ? [media] : [];
        files.forEach((file, fileIndex) => {
          assignMedia(row, `${path}${field.name}:${fileIndex + 1}:`, file);
        });
        continue;
      }

      assignMedia(row, `${path}${field.name}:`, media);
    }
  }
};

/** One document, one row. `status` is copied when the caller stamped a version. */
export const flattenDocument = (
  document: Record<string, unknown>,
  plan: Plan,
  planFor: PlanFor,
  options: FlattenOptions
): Record<string, unknown> => {
  const row: Record<string, unknown> = {};

  if ('documentId' in document) row.documentId = document.documentId;
  if (plan.localized && 'locale' in document) row.locale = document.locale;
  if (document.status != null) row.status = document.status;

  flattenInto(document, plan, '', row, options, planFor);

  return row;
};

/** The header: every key any row actually used, in schema order. */
export const columnsFor = (
  rows: Array<Record<string, unknown>>,
  plan: Plan,
  planFor: PlanFor
): string[] => {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }

  return [...keys].sort((a, b) => compareColumns(a, b, plan, planFor));
};

/**
 * Draft and published copies of the same document, as separate rows.
 *
 * Unpublished documents appear once. A document that has both versions appears
 * twice, draft first, and `status` says which row is which.
 */
export const mergeByStatus = (
  groups: Array<{ status: 'draft' | 'published'; documents: ExportedDocument[] }>
): ExportedDocument[] => {
  const rows = groups.flatMap(({ status, documents }) =>
    documents.map((document) => ({ ...document, status }))
  );

  rows.sort((a, b) => {
    const byId = String(a.documentId).localeCompare(String(b.documentId));
    if (byId !== 0) return byId;
    return String(a.status).localeCompare(String(b.status));
  });

  return rows;
};
