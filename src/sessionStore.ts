import path from 'path';
import { mkdir, readFile, readdir, stat, writeFile, unlink } from 'fs/promises';

export interface ChatMessage { role: 'user' | 'model'; parts: any[] }
export interface ChatSessionFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');

export async function ensureStore() {
  await mkdir(SESS_DIR, { recursive: true });
}

function sessPath(id: string) { return path.join(SESS_DIR, `${id}.json`); }

export async function createSessionFile(id: string, title: string) {
  const now = new Date().toISOString();
  const file: ChatSessionFile = { id, title, createdAt: now, updatedAt: now, history: [] };
  await writeFile(sessPath(id), JSON.stringify(file, null, 2), 'utf8');
  return file;
}

export async function loadSessionFile(id: string) {
  const buf = await readFile(sessPath(id), 'utf8');
  return JSON.parse(buf) as ChatSessionFile;
}

export async function saveSessionFile(file: ChatSessionFile) {
  file.updatedAt = new Date().toISOString();
  await writeFile(sessPath(file.id), JSON.stringify(file, null, 2), 'utf8');
}

export async function renameSessionFile(id: string, title: string) {
  const file = await loadSessionFile(id);
  file.title = title;
  await saveSessionFile(file);
  return file;
}

export async function deleteSessionFile(id: string) {
  try { await unlink(sessPath(id)); } catch { /* ignore */ }
}

export interface SessionListItem { id: string; title: string; updatedAt: string; createdAt: string; turns: number }

export async function listSessions(): Promise<SessionListItem[]> {
  await ensureStore();
  const files = await readdir(SESS_DIR);
  const items: SessionListItem[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const id = f.replace(/\.json$/, '');
      const fp = path.join(SESS_DIR, f);
      const buf = await readFile(fp, 'utf8');
      const j = JSON.parse(buf) as ChatSessionFile;
      items.push({ id, title: j.title, updatedAt: j.updatedAt, createdAt: j.createdAt, turns: Math.floor(j.history.filter(m => m.role === 'model').length) });
    } catch { /* ignore corrupt */ }
  }
  items.sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
  return items;
}
