import { mkdir, appendFile } from 'fs/promises';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

function ts() {
  return new Date().toISOString();
}

export async function logEvent(type: string, payload: Record<string, any> = {}) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: ts(), type, ...payload }) + '\n';
    await appendFile(LOG_FILE, line, { encoding: 'utf8' });
  } catch (e) {
    // Best-effort logging; ignore errors
  }
}

