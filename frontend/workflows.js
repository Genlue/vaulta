// Saved views are local UI preferences. They store a rule, never a copied result
// set, and applying one cannot mutate a vault or move a file.
import { norm } from './model.js';

export const viewPages = new Set(['inbox', 'all', 'physical', 'category', 'flags', 'excluded', 'missing']);
const string = value => typeof value === 'string' ? value : '';
const labels = value => Array.isArray(value) ? [...new Set(value.filter(text => typeof text === 'string'))].slice(0, 512) : [];
// Views saved before the type filter moved from icon names to asset groups.
const legacyType = { play: 'video', 'volume-2': 'audio', 'file-text': 'document' };
const typeName = value => legacyType[string(value)] || string(value);
export function restoreViews(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(v => v && v.id && v.name && v.vaultId && viewPages.has(v.page)).slice(0, 40).map(v => ({
    id: string(v.id), name: string(v.name), vaultId: string(v.vaultId), page: v.page,
    folder: norm(string(v.folder)), folderId: string(v.folderId), facet: string(v.facet),
    sort: string(v.sort), direction: v.direction === 'desc' ? 'desc' : 'asc',
    filters: { category: string(v.filters?.category), type: typeName(v.filters?.type), flags: labels(v.filters?.flags) },
  }));
}

// Registry order is by name, not depth, so walk the child graph by ID.
export function vaultSubtree(registry, id) {
  const children = new Map();
  for (const vault of registry) {
    if (!vault.parent_id) continue;
    if (!children.has(vault.parent_id)) children.set(vault.parent_id, []);
    children.get(vault.parent_id).push(vault.id);
  }
  const affected = new Set([id]);
  for (const parent of affected) for (const child of children.get(parent) || []) affected.add(child);
  return affected;
}

// Title prefix outranks anywhere in the title, then synonyms/help text.
// Split a query on whitespace so “收件 处理” and “command settings” both work.
export function matchCommands(commands, query, limit = 14) {
  const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return commands.map(c => {
    const name = c.label.normalize('NFKC').toLocaleLowerCase();
    const rest = `${c.group ?? ''} ${c.hint ?? ''} ${c.keywords ?? ''}`.normalize('NFKC').toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.startsWith(term)) score += 8;
      else if (name.includes(term)) score += 4;
      else if (rest.includes(term)) score += 1;
      else return null;
    }
    return { c, score };
  }).filter(Boolean).sort((a,b) => b.score - a.score).slice(0, limit).map(x => x.c);
}
