import express, { Request, Response } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { GoogleGenAI } from '@google/genai';
import mime from 'mime';
import path from 'path';
import { mkdir, writeFile as writeFileAsync } from 'fs/promises';
import { logEvent } from './logger';
import { ensureStore, createSessionFile, saveSessionFile, loadSessionFile, listSessions, renameSessionFile, deleteSessionFile } from './sessionStore';

// ===== In-memory stores =====
// Legacy one-shot uploads (kept for backward-compat, not used by chat UI)
const uploads = new Map<string, { base64: string; mimeType: string; prompt?: string; inputFileName?: string }>();
// Chat sessions: maintain message history for multi-turn
interface ChatMessage { role: 'user' | 'model'; parts: any[] }
interface ChatSession { id: string; history: ChatMessage[]; generating: boolean; turn: number }
const sessions = new Map<string, ChatSession>();

// ===== Artifacts helpers =====
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.resolve(process.cwd(), 'artifacts');

async function saveBufferToArtifacts(fileName: string, buffer: Buffer) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const filePath = path.join(ARTIFACT_DIR, fileName);
  await writeFileAsync(filePath, buffer);
  return filePath;
}

function extFromMime(mimeType: string) {
  return mime.getExtension(mimeType || '') || 'png';
}

function deriveTitle(text?: string, imageCount: number = 0) {
  const maxLen = 30;
  if (text && text.trim().length > 0) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
  }
  if (imageCount > 0) return `图片对话（${imageCount}张）`;
  return `会话 ${new Date().toLocaleString()}`;
}

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

// Static frontend
app.use(express.static('public', { extensions: ['html'] }));

// Ensure persistence store exists on start
ensureStore().catch(()=>{});

// Multer for multipart/form-data
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// ===== Session persistence endpoints =====
app.get('/sessions', async (_req: Request, res: Response) => {
  const items = await listSessions();
  res.json({ items });
});

app.get('/session/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const file = await loadSessionFile(id);
    // Warm into memory map
    sessions.set(id, { id: file.id, history: file.history, generating: false, turn: file.history.filter(m => m.role === 'model').length });
    res.json(file);
  } catch (e: any) {
    res.status(404).json({ error: 'Not found' });
  }
});

app.post('/session/:id/rename', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const title = (body?.title || '').toString().slice(0, 200);
        const file = await renameSessionFile(id, title);
        res.json({ ok: true, title: file.title });
      } catch {
        res.status(400).json({ error: 'Invalid body' });
      }
    });
  } catch {
    res.status(500).json({ error: 'Rename failed' });
  }
});

app.delete('/session/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  await deleteSessionFile(id);
  sessions.delete(id);
  res.json({ ok: true });
});

// ===== Chat session endpoints =====
app.post('/session', async (_req: Request, res: Response) => {
  const id = nanoid(10);
  const title = `会话 ${new Date().toLocaleString()}`;
  sessions.set(id, { id, history: [], generating: false, turn: 0 });
  await createSessionFile(id, title);
  logEvent('session_create', { sessionId: id });
  res.json({ sessionId: id, title });
});

// Accept a user message (text + optional images). Returns the turn id for streaming.
app.post('/message', upload.array('image', 12), async (req: Request, res: Response) => {
  try {
    const sessionId = (req.body?.sessionId as string) || '';
    const text = (req.body?.text as string | undefined)?.trim();
    const sess = sessions.get(sessionId);
    if (!sess) { res.status(400).json({ error: 'Invalid sessionId' }); return; }
    if (sess.generating) { res.status(409).json({ error: 'Generation in progress, please wait' }); return; }

    // Assemble parts: text first, then images (align with SDK examples)
    const parts: any[] = [];

    const files = (req.files as any as Array<Express.Multer.File>) || [];

    if (text) parts.push({ text });

    let idx = 0;
    for (const f of files) {
      if (!f) continue;
      const mimeType = f.mimetype || 'image/png';
      const buffer = f.buffer;
      const base64 = buffer.toString('base64');
      const ext = extFromMime(mimeType);
      const fileName = `session-${sessionId}-user-${sess.turn + 1}-${idx++}.${ext}`;
      await saveBufferToArtifacts(fileName, buffer);
      parts.push({ inlineData: { mimeType, data: base64 } });
    }

    if (parts.length === 0) { res.status(400).json({ error: 'Empty message' }); return; }

    // Debug summary log (no base64)
    logEvent('message_received', { sessionId, turn: sess.turn + 1, images: files.length, hasText: !!text, mimeTypes: files.map(f => f?.mimetype) });

    sess.history.push({ role: 'user', parts });

    // Auto-name session on first user message
    if (sess.turn === 0) {
      try {
        const title = deriveTitle(text, files.length);
        await renameSessionFile(sessionId, title);
        logEvent('session_autoname', { sessionId, title });
      } catch {}
    }

    // Reserve a turn id for the upcoming assistant response
    const turn = sess.turn + 1;
    res.json({ sessionId, turn });
  } catch (err: any) {
    console.error('Message error:', err);
    res.status(500).json({ error: 'Failed to accept message' });
  }
});

// Stream assistant response for a session turn via SSE
app.get('/stream/session/:sessionId', async (req: Request, res: Response) => {
  sseInit(res);
  const sessionId = req.params.sessionId;
  const sess = sessions.get(sessionId);
  if (!sess) {
    sseSend(res, 'error', { message: 'Invalid sessionId' });
    return res.end();
  }
  if (sess.generating) {
    sseSend(res, 'error', { message: 'Already generating' });
    return res.end();
  }

  const ping = setInterval(() => ssePing(res), 15000);

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      sseSend(res, 'error', { message: 'GEMINI_API_KEY is not set' });
      clearInterval(ping); return res.end();
    }
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GENAI_MODEL || 'gemini-2.5-flash-image-preview';
    // If the latest user message contains any image parts, request IMAGE+TEXT; otherwise TEXT.
    const lastUser = [...sess.history].reverse().find(m => m.role === 'user');
    const hasImages = !!lastUser?.parts?.some((p: any) => p?.inlineData?.data);
    const config: any = { responseModalities: hasImages ? ['IMAGE', 'TEXT'] : ['TEXT'] };

    logEvent('stream_start', { sessionId, turn: sess.turn + 1, model, config, hasImages });

    sess.generating = true;
    sseSend(res, 'status', { message: 'Generating...' });

    const response = await ai.models.generateContentStream({ model, config, contents: sess.history });

    // Accumulate assistant message parts to append to history at the end
    const assistantParts: any[] = [];
    let genIndex = 0;
    let outImages = 0;
    let outTextChars = 0;

    for await (const chunk of response as any) {
      const chunkParts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of chunkParts) {
        if (p?.inlineData?.data) {
          const outMime = p.inlineData.mimeType || 'image/png';
          sseSend(res, 'image', { mimeType: outMime, data: p.inlineData.data });
          outImages += 1;
          try {
            const ext = extFromMime(outMime);
            const fileName = `session-${sessionId}-assistant-${sess.turn + 1}-${genIndex++}.${ext}`;
            const buf = Buffer.from(p.inlineData.data, 'base64');
            await saveBufferToArtifacts(fileName, buf);
            sseSend(res, 'status', { message: `Saved generated image: ${fileName}` });
          } catch (e) { /* ignore save errors */ }
          assistantParts.push({ inlineData: { mimeType: outMime, data: p.inlineData.data } });
        } else if (typeof p?.text === 'string' && p.text.length > 0) {
          sseSend(res, 'text', { delta: p.text });
          assistantParts.push({ text: p.text });
          outTextChars += p.text.length;
        }
      }
    }

    // Append assistant message to history and advance turn counter
    sess.history.push({ role: 'model', parts: assistantParts });
    sess.turn += 1;
    // Persist session to disk
    try {
      const existing = await loadSessionFile(sessionId).catch(() => null);
      const title = existing?.title || `会话 ${new Date().toLocaleString()}`;
      await saveSessionFile({ id: sessionId, title, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), history: sess.history });
    } catch {}
    sseSend(res, 'done', {});
    logEvent('stream_end', { sessionId, turn: sess.turn + 1, outImages, outTextChars });
  } catch (err: any) {
    console.error('Session stream error:', err);
    logEvent('stream_error', { message: err?.message, stack: err?.stack, sessionId });
    sseSend(res, 'error', { message: err?.message || 'Generation failed' });
  } finally {
    sess.generating = false;
    clearInterval(ping);
    res.end();
  }
});

// ===== Legacy one-shot endpoints (kept, but chat UI won't use them) =====
// Accept pasted image and optional prompt (legacy)
app.post('/upload', upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No image provided' }); return; }
    const mimeType = req.file.mimetype || 'image/png';
    const buffer = req.file.buffer; const base64 = buffer.toString('base64');
    const prompt = (req.body?.prompt as string | undefined) || undefined;
    const id = nanoid(12); const ext = extFromMime(mimeType);
    const inputFileName = `input-${id}.${ext}`; await saveBufferToArtifacts(inputFileName, buffer);
    uploads.set(id, { base64, mimeType, prompt, inputFileName });
    setTimeout(() => uploads.delete(id), 10 * 60 * 1000).unref?.();
    res.json({ id });
  } catch (err: any) { console.error('Upload error:', err); logEvent('upload_error', { message: err?.message, stack: err?.stack }); res.status(500).json({ error: 'Upload failed' }); }
});

// Legacy stream for one-shot id (not used by chat UI)
app.get('/stream/:id', async (req: Request, res: Response) => {
  sseInit(res);
  const id = req.params.id; const item = uploads.get(id);
  if (!item) { sseSend(res, 'error', { message: 'Invalid or expired id' }); return res.end(); }
  const ping = setInterval(() => ssePing(res), 15000);
  try {
    const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) { sseSend(res, 'error', { message: 'GEMINI_API_KEY is not set' }); clearInterval(ping); return res.end(); }
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GENAI_MODEL || 'gemini-2.5-flash-image-preview';
    const config: any = { responseModalities: ['IMAGE', 'TEXT'] };
    const parts: any[] = []; if (item.prompt && item.prompt.trim()) parts.push({ text: item.prompt.trim() });
    parts.push({ inlineData: { mimeType: item.mimeType, data: item.base64 } });
    const contents = [{ role: 'user', parts }];
    sseSend(res, 'status', { message: 'Generating...' });
    const response = await ai.models.generateContentStream({ model, config, contents });
    for await (const chunk of response as any) {
      const chunkParts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of chunkParts) {
        if (p?.inlineData?.data) { sseSend(res, 'image', { mimeType: p.inlineData.mimeType || 'image/png', data: p.inlineData.data }); }
        else if (typeof p?.text === 'string' && p.text.length > 0) { sseSend(res, 'text', { delta: p.text }); }
      }
    }
    sseSend(res, 'done', {});
  } catch (err: any) { console.error('Stream error:', err); logEvent('legacy_stream_error', { message: err?.message, stack: err?.stack }); sseSend(res, 'error', { message: err?.message || 'Generation failed' }); }
  finally { clearInterval(ping); res.end(); uploads.delete(id); }
});

// ===== SSE helpers =====
function sseInit(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}
function sseSend(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function ssePing(res: Response) { res.write(`: ping ${Date.now()}\n\n`); }

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

