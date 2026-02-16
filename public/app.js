const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_RETRIES = 3;

const fileInput = document.getElementById('videoFile');
const startBtn = document.getElementById('startBtn');
const resumeBtn = document.getElementById('resumeBtn');
const startStreamBtn = document.getElementById('startStreamBtn');
const stopStreamBtn = document.getElementById('stopStreamBtn');
const progressBar = document.getElementById('progressBar');
const statusEl = document.getElementById('status');
const savedFilesEl = document.getElementById('savedFiles');
const refreshFilesBtn = document.getElementById('refreshFilesBtn');

let mediaRecorder = null;
let activeMediaStream = null;
let activeLiveStreamId = null;
let streamChunkIndex = 0;

function setStatus(text) {
  statusEl.textContent = text;
}

function setProgress(completedChunks, totalChunks) {
  const percent = Math.round((completedChunks / totalChunks) * 100);
  progressBar.value = Number.isFinite(percent) ? percent : 0;
}

async function initSession(file) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const response = await fetch('/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      totalSize: file.size,
      totalChunks,
      mimeType: file.type || 'application/octet-stream'
    })
  });

  if (!response.ok) {
    throw new Error('Failed to initialize upload session');
  }

  const { uploadId } = await response.json();
  localStorage.setItem('streamsaver:lastUploadId', uploadId);
  localStorage.setItem('streamsaver:lastFileName', file.name);
  return { uploadId, totalChunks };
}

async function getSessionStatus(uploadId) {
  const response = await fetch(`/api/uploads/${uploadId}/status`);
  if (!response.ok) {
    throw new Error('Upload session not found. Start a new upload.');
  }

  return response.json();
}

async function sendChunk(uploadId, file, index, totalChunks) {
  const start = index * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  const blob = file.slice(start, end);

  const formData = new FormData();
  formData.append('index', String(index));
  formData.append('totalChunks', String(totalChunks));
  formData.append('chunk', blob, `${file.name}.part.${index}`);

  const response = await fetch(`/api/uploads/${uploadId}/chunk`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Chunk ${index} failed`);
  }

  return response.json();
}

async function uploadFile(file, uploadId = null, uploadedSet = new Set()) {
  let session = null;
  if (!uploadId) {
    session = await initSession(file);
    uploadId = session.uploadId;
  }

  const totalChunks = session?.totalChunks || Math.ceil(file.size / CHUNK_SIZE);
  let sentCount = uploadedSet.size;
  setProgress(sentCount, totalChunks);

  for (let index = 0; index < totalChunks; index += 1) {
    if (uploadedSet.has(index)) {
      continue;
    }

    let done = false;
    let attempts = 0;

    while (!done && attempts < MAX_RETRIES) {
      attempts += 1;
      try {
        setStatus(`Uploading chunk ${index + 1}/${totalChunks} (try ${attempts}/${MAX_RETRIES})...`);
        const payload = await sendChunk(uploadId, file, index, totalChunks);
        done = true;
        sentCount += 1;
        setProgress(sentCount, totalChunks);

        if (payload.complete) {
          setStatus(`Upload complete. Saved as ${payload.output}`);
          localStorage.removeItem('streamsaver:lastUploadId');
          await refreshSavedFiles();
          return;
        }
      } catch (error) {
        if (attempts >= MAX_RETRIES) {
          throw error;
        }
      }
    }
  }

  setStatus('Upload finished.');
}

startBtn.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    setStatus('Pick a video file first.');
    return;
  }

  try {
    await uploadFile(file);
  } catch (error) {
    setStatus(error.message);
  }
});

resumeBtn.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  const uploadId = localStorage.getItem('streamsaver:lastUploadId');

  if (!file || !uploadId) {
    setStatus('Need selected file + remembered upload session to resume.');
    return;
  }

  try {
    const status = await getSessionStatus(uploadId);
    const uploadedSet = new Set(status.receivedChunks || []);
    await uploadFile(file, uploadId, uploadedSet);
  } catch (error) {
    setStatus(error.message);
  }
});

async function startLiveStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Live streaming is not supported in this browser.');
  }

  activeMediaStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  const initResponse = await fetch('/api/streams/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: `live-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
      mimeType: 'video/webm'
    })
  });

  if (!initResponse.ok) {
    throw new Error('Unable to initialize live stream session.');
  }

  const { streamId } = await initResponse.json();
  activeLiveStreamId = streamId;
  streamChunkIndex = 0;

  mediaRecorder = new MediaRecorder(activeMediaStream, {
    mimeType: 'video/webm'
  });

  mediaRecorder.addEventListener('dataavailable', async (event) => {
    if (!event.data || event.data.size === 0 || !activeLiveStreamId) {
      return;
    }

    const formData = new FormData();
    formData.append('index', String(streamChunkIndex));
    formData.append('chunk', event.data, `live.part.${streamChunkIndex}`);

    streamChunkIndex += 1;

    try {
      const response = await fetch(`/api/streams/${activeLiveStreamId}/chunk`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        setStatus('Live stream chunk upload failed.');
      } else {
        setStatus(`Live streaming... sent ${streamChunkIndex} chunks.`);
      }
    } catch {
      setStatus('Network error while streaming live chunk.');
    }
  });

  mediaRecorder.addEventListener('stop', async () => {
    try {
      if (activeLiveStreamId) {
        const response = await fetch(`/api/streams/${activeLiveStreamId}/finish`, {
          method: 'POST'
        });

        if (response.ok) {
          const payload = await response.json();
          setStatus(`Live stream saved as ${payload.output}`);
        } else {
          setStatus('Live stream stopped, but server finalize failed.');
        }
      }
    } catch {
      setStatus('Live stream stopped, but finalize request failed.');
    } finally {
      activeLiveStreamId = null;
      if (activeMediaStream) {
        for (const track of activeMediaStream.getTracks()) {
          track.stop();
        }
      }
      activeMediaStream = null;
      await refreshSavedFiles();
      startStreamBtn.disabled = false;
      stopStreamBtn.disabled = true;
    }
  });

  mediaRecorder.start(1000);
  setStatus('Live stream started. Recording and sending chunks every second.');
  startStreamBtn.disabled = true;
  stopStreamBtn.disabled = false;
}

function stopLiveStream() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

startStreamBtn.addEventListener('click', () => {
  startLiveStream().catch((error) => {
    setStatus(error.message);
    startStreamBtn.disabled = false;
    stopStreamBtn.disabled = true;
  });
});

stopStreamBtn.addEventListener('click', () => {
  stopLiveStream();
});

async function refreshSavedFiles() {
  const response = await fetch('/api/files');
  const payload = await response.json();
  savedFilesEl.textContent = '';

  if (!payload.files.length) {
    const li = document.createElement('li');
    li.textContent = 'No saved files yet.';
    savedFilesEl.append(li);
    return;
  }

  for (const file of payload.files) {
    const li = document.createElement('li');
    const mb = (file.sizeBytes / (1024 * 1024)).toFixed(2);
    li.textContent = `${file.name} - ${mb} MB - ${new Date(file.modifiedAt).toLocaleString()}`;
    savedFilesEl.append(li);
  }
}

refreshFilesBtn.addEventListener('click', () => {
  refreshSavedFiles().catch((error) => setStatus(error.message));
});

refreshSavedFiles().catch((error) => setStatus(error.message));
