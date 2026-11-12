# ClipGenius AI

Turn a long video into short vertical clips. ClipGenius transcribes the audio, suggests the strongest moments, and renders selected clips at 1080×1920 with optional burned-in captions.

## Requirements

- Node.js 20 or newer
- FFmpeg and FFprobe on your `PATH` (`brew install ffmpeg`, `apt install ffmpeg`, or [ffmpeg.org](https://ffmpeg.org/))
- An OpenAI API key for Whisper transcription and an Anthropic API key for clip selection

## Run locally

```bash
npm install
cp .env.example .env
```

Add `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` to `.env`, then run:

```bash
npm run check
npm start
```

Open <http://localhost:3000>. Create an account, upload a video with an audio track, wait for the clip suggestions, then adjust the timestamps and render a vertical clip.

`npm run check` verifies that FFmpeg/FFprobe are installed and that both AI API keys are configured. Never commit `.env` or put API keys in frontend code.

## How it works

1. **Upload:** `server.js` validates and stores the video under `data/projects/<id>/`.
2. **Transcribe:** FFmpeg extracts mono audio in 10-minute chunks; each chunk is sent to Whisper for word and segment timestamps.
3. **Select:** Claude analyzes the timestamped transcript in approximately 25-minute windows and proposes clips. The server snaps cut points to transcript segment boundaries, removes overlaps, and keeps the highest-scoring suggestions.
4. **Render:** choose a clip, edit its start/end times, and optionally add captions. FFmpeg renders a vertical 9:16 video. Landscape video is centered over a blurred background.

Video jobs run sequentially to limit CPU usage. User, project, and billing data is stored in `data/db.json`; uploaded videos and renders are in `data/`. This lightweight file store is intended for a single server instance, not multi-instance production use.

## Accounts and billing

- Accounts use scrypt-hashed passwords and signed HttpOnly session cookies. Users can access only their own videos and clips.
- Uploads use credits: one credit per minute of video, rounded up. Credits are charged at upload and refunded if processing fails, including when a server restart interrupts processing.
- Plan amounts and displayed prices are placeholders in `lib/plans.js`. Review them and your operating costs before enabling payments.
- To enable Stripe, configure the secret key and price IDs in `.env`, then create a Stripe webhook to `APP_URL/api/stripe/webhook` for `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, and `customer.subscription.deleted`. Set `STRIPE_WEBHOOK_SECRET` to the webhook signing secret. For local testing, use `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Deploy to Railway

The repository includes a Dockerfile that installs FFmpeg and a Railway configuration that uses `/api/health` as a deployment health check.

1. In Railway, create a project and deploy from the `T14-bit/clipgenius` GitHub repository. The root `Dockerfile` will build the service.
2. Add a persistent volume to the service and mount it at `/app/data`. This is required to preserve accounts, sessions, uploaded videos, and rendered clips across restarts and deployments.
3. Add runtime variables in the Railway service's Variables panel:
   - `OPENAI_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `APP_URL` set to the deployed public URL
   - `SESSION_SECRET` set to a long, random secret (keep it private)
   - Stripe variables if you are enabling billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_PACK`
4. Deploy the service and open its public domain. Configure the Stripe webhook URL using that same `APP_URL` if billing is enabled.

Do not commit secrets. Before exposing this app to the public internet or accepting payments, review the security and operational limitations below.

## Current limitations and production checklist

- No password reset or email verification.
- Reframing is centered; there is no face/speaker tracking.
- Captions are phrase-based rather than animated word-by-word.
- The JSON file store and in-memory job queue are single-instance only. Use a database, durable job queue, and suitable object storage before scaling horizontally.
- Set realistic upload and resource limits, monitor API costs, and review plan prices before accepting public users or payments.
