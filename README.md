# FineImgur

FineImgur is a lightweight Node.js (CommonJS) relay for Imgur image requests. It mirrors the URL path you request, forwards it to Imgur, and returns the image back to the requester. Responses are cached on disk up to a configurable storage limit, and oversized downloads return a branded failure image with the reason text imprinted.

## Features

- Relay Imgur image requests with the same path and query string.
- On-disk cache with automatic eviction when the cache exceeds the configured size.
- Maximum download size enforcement to prevent disk exhaustion.
- Failure responses are returned as SVG images with readable error text.
- No compiled dependencies — just `npm install` and run.

## Requirements

- Node.js 18+ recommended (uses modern language features, no native modules).

## Installation

```bash
npm install
```

## Configuration

Edit `config.json` to match your environment:

```json
{
  "port": 3000,
  "imgurBaseUrl": "https://i.imgur.com",
  "cacheDir": "./cache",
  "maxCacheBytes": 1073741824,
  "maxDownloadBytes": 10485760,
  "failureImage": {
    "width": 640,
    "height": 360,
    "background": "#1d1d1d",
    "textColor": "#ffffff",
    "accentColor": "#ff4d4d"
  }
}
```

### Important options

- **port**: Local port for the relay server.
- **imgurBaseUrl**: Base URL for Imgur assets (default: `https://i.imgur.com`).
- **cacheDir**: Directory where cached images are stored.
- **maxCacheBytes**: Maximum total cache size before eviction kicks in.
- **maxDownloadBytes**: Maximum size for a single image download. Larger images return a failure image.
- **failureImage**: Controls the size and colors of the SVG failure image.

## Usage

Start the server:

```bash
npm start
```

Request images by using the same path that you would for Imgur:

```text
http://localhost:3000/abc123.png
```

This will fetch `https://i.imgur.com/abc123.png`, cache the result (if it is within size limits), and return it to the requester.

## Notes

- Only `GET` requests are supported.
- Cache eviction is based on the oldest accessed file when the cache exceeds the configured size.
- Failure images are returned as SVG to avoid binary image generation dependencies.

## License

MIT
