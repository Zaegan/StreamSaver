# StreamSaver
Allows user to stream video directly to the server's hard disk.

Presents a webpage with a back-end capable of taking in video streams at high bandwidth, in a delay or interruption tolerant manner.
Works well with both android and apple mobile devices.
Built in support for high-bitrate video.

## Included web server suite

This repository includes a complete Node.js web application:

- `server.js`: Express-based API and static web server.
- `public/index.html`: Mobile-friendly upload and live-stream page.
- `public/app.js`: Chunked file upload logic with retries/resume plus live camera stream logic.
- `public/styles.css`: Basic responsive styling.

## Supported modes

### 1) Chunked file upload (interruption-tolerant)

1. Browser initializes an upload session (`/api/uploads/init`).
2. Video file is split into 4 MB chunks in the browser.
3. Each chunk is uploaded individually (`/api/uploads/:id/chunk`).
4. Server stores chunks temporarily and merges when complete.
5. Final merged video is stored in `uploads/final`.

Upload status can be checked and resumed (`/api/uploads/:id/status`).

### 2) Live stream recording to disk

1. Browser requests camera/microphone permission.
2. A live stream session is created (`/api/streams/init`).
3. `MediaRecorder` emits chunks every second and sends each chunk to `/api/streams/:id/chunk`.
4. Server appends each chunk directly to a file in `uploads/final`.
5. When recording stops, the browser finalizes the file (`/api/streams/:id/finish`).

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser.
