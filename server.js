const express = require('express');
const multer = require('multer');
const morgan = require('morgan');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const UPLOAD_ROOT = path.join(ROOT_DIR, 'uploads');
const TMP_ROOT = path.join(UPLOAD_ROOT, 'tmp');
const FINAL_ROOT = path.join(UPLOAD_ROOT, 'final');

for (const dir of [UPLOAD_ROOT, TMP_ROOT, FINAL_ROOT]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use(express.json());
app.use(morgan('tiny'));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const sessions = new Map();
const liveStreams = new Map();

function safeName(name) {
  return (name || 'video.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getSessionDir(uploadId) {
  return path.join(TMP_ROOT, uploadId);
}

async function writeSessionMeta(uploadId, meta) {
  const dir = getSessionDir(uploadId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function readSessionMeta(uploadId) {
  const metaPath = path.join(getSessionDir(uploadId), 'meta.json');
  const data = await fsp.readFile(metaPath, 'utf8');
  return JSON.parse(data);
}

async function mergeChunks(meta) {
  const finalName = `${Date.now()}-${safeName(meta.originalName)}`;
  const finalPath = path.join(FINAL_ROOT, finalName);

  const writer = fs.createWriteStream(finalPath);

  for (let i = 0; i < meta.totalChunks; i += 1) {
    const chunkPath = path.join(getSessionDir(meta.uploadId), `chunk-${i}.part`);
    await new Promise((resolve, reject) => {
      const reader = fs.createReadStream(chunkPath);
      reader.on('error', reject);
      reader.on('end', resolve);
      reader.pipe(writer, { end: false });
    });
  }

  await new Promise((resolve, reject) => {
    writer.end((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return { finalName, finalPath };
}

app.post('/api/uploads/init', async (req, res) => {
  const { filename, totalSize = 0, totalChunks = 1, mimeType = 'application/octet-stream' } = req.body || {};

  if (!filename) {
    return res.status(400).json({ error: 'filename is required' });
  }

  const uploadId = crypto.randomUUID();
  const session = {
    uploadId,
    originalName: safeName(filename),
    totalSize,
    totalChunks: Number(totalChunks),
    mimeType,
    createdAt: new Date().toISOString(),
    receivedChunks: []
  };

  sessions.set(uploadId, session);
  await writeSessionMeta(uploadId, session);

  return res.status(201).json({ uploadId });
});

app.get('/api/uploads/:uploadId/status', async (req, res) => {
  const { uploadId } = req.params;
  let session = sessions.get(uploadId);

  if (!session) {
    try {
      session = await readSessionMeta(uploadId);
      sessions.set(uploadId, session);
    } catch {
      return res.status(404).json({ error: 'upload session not found' });
    }
  }

  return res.json({
    uploadId,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks,
    complete: session.receivedChunks.length === session.totalChunks
  });
});

app.post('/api/uploads/:uploadId/chunk', upload.single('chunk'), async (req, res) => {
  const { uploadId } = req.params;
  const { index } = req.body;
  const chunkIndex = Number(index);

  if (!req.file) {
    return res.status(400).json({ error: 'chunk file is required' });
  }

  if (Number.isNaN(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({ error: 'valid chunk index is required' });
  }

  let session = sessions.get(uploadId);
  if (!session) {
    try {
      session = await readSessionMeta(uploadId);
      sessions.set(uploadId, session);
    } catch {
      return res.status(404).json({ error: 'upload session not found' });
    }
  }

  const sessionDir = getSessionDir(uploadId);
  await fsp.mkdir(sessionDir, { recursive: true });

  const chunkPath = path.join(sessionDir, `chunk-${chunkIndex}.part`);
  await fsp.writeFile(chunkPath, req.file.buffer);

  if (!session.receivedChunks.includes(chunkIndex)) {
    session.receivedChunks.push(chunkIndex);
    session.receivedChunks.sort((a, b) => a - b);
  }

  let completed = false;
  let output = null;

  if (session.receivedChunks.length === session.totalChunks) {
    const merged = await mergeChunks(session);
    completed = true;
    output = merged.finalName;

    await fsp.rm(sessionDir, { recursive: true, force: true });
    sessions.delete(uploadId);
  } else {
    await writeSessionMeta(uploadId, session);
  }

  return res.status(202).json({
    uploadId,
    index: chunkIndex,
    received: session.receivedChunks.length,
    totalChunks: session.totalChunks,
    complete: completed,
    output
  });
});

app.post('/api/streams/init', async (req, res) => {
  const { filename = 'live.webm', mimeType = 'video/webm' } = req.body || {};
  const streamId = crypto.randomUUID();
  const finalName = `${Date.now()}-${safeName(filename)}`;
  const finalPath = path.join(FINAL_ROOT, finalName);
  const writer = fs.createWriteStream(finalPath, { flags: 'a' });

  liveStreams.set(streamId, {
    streamId,
    finalName,
    finalPath,
    writer,
    mimeType,
    chunkCount: 0,
    bytesWritten: 0,
    startedAt: new Date().toISOString()
  });

  return res.status(201).json({ streamId, file: finalName });
});

app.post('/api/streams/:streamId/chunk', upload.single('chunk'), async (req, res) => {
  const { streamId } = req.params;
  const state = liveStreams.get(streamId);

  if (!state) {
    return res.status(404).json({ error: 'live stream session not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'chunk is required' });
  }

  await new Promise((resolve, reject) => {
    state.writer.write(req.file.buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  state.chunkCount += 1;
  state.bytesWritten += req.file.size;

  return res.status(202).json({
    streamId,
    receivedChunks: state.chunkCount,
    bytesWritten: state.bytesWritten
  });
});

app.post('/api/streams/:streamId/finish', async (req, res) => {
  const { streamId } = req.params;
  const state = liveStreams.get(streamId);

  if (!state) {
    return res.status(404).json({ error: 'live stream session not found' });
  }

  await new Promise((resolve, reject) => {
    state.writer.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  liveStreams.delete(streamId);

  return res.json({
    streamId,
    output: state.finalName,
    bytesWritten: state.bytesWritten,
    chunks: state.chunkCount
  });
});

app.get('/api/files', async (_req, res) => {
  const entries = await fsp.readdir(FINAL_ROOT, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const fullPath = path.join(FINAL_ROOT, entry.name);
        const stats = await fsp.stat(fullPath);
        return {
          name: entry.name,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        };
      })
  );

  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return res.json({ files });
});

app.listen(PORT, () => {
  console.log(`StreamSaver server listening on port ${PORT}`);
});
