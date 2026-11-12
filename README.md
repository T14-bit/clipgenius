# ClipGenius AI

Upload a long video. ClipGenius transcribes it, picks the strongest moments, and renders each one as a vertical 1080x1920 clip with burned-in captions.

## Requirements
- Node.js 20 or newer
- FFmpeg and FFprobe on your PATH (`brew install ffmpeg`, `apt install ffmpeg`, or ffmpeg.org)
- An OpenAI API key (speech-to-text with Whisper) and an Anthropic API key (clip selection)

## Run it
```bash
npm install
cp .env.example .env     # then add your two API keys
npm run check            # confirms FFmpeg and keys are set
npm start                # http://localhost:3000
```

## How it works
1. **Upload** (`server.js`): saves the video under `data/projects/<id>/`.
2. **Extract + transcribe** (`lib/pipeline.js`, `lib/transcribe.js`): FFmpeg pulls mono audio in 10-minute chunks, each sent to Whisper with word timestamps.
3. **Pick clips** (`lib/clips.js`): Claude reads the timestamped transcript in ~25-minute windows and proposes clips with a hook, a 0-100 score and a reason. The server snaps every cut to sentence boundaries, drops overlaps, and keeps the top N.
4. **Edit and render** (`lib/captions.js`, `lib/pipeline.js`): adjust start/end, toggle captions, render. FFmpeg crops to 9:16 (sharp video centered over a blurred copy for landscape sources) and burns in captions.

Jobs run one at a time in a queue. State is in `data/db.json`.

## Accounts and billing
- Email + password accounts (scrypt-hashed, signed HttpOnly cookie). Each person only sees their own videos and clips.
- Credits: 1 credit = 1 minute of uploaded video, charged when you upload and returned automatically if processing fails. Limits are enforced on the server.
- Plans and allowances live in `lib/plans.js` (Free 30, Creator 300, Pro 1200 credits per month; credit pack 100 credits). These numbers are placeholders, change them to match your costs.
- Stripe: in the Stripe dashboard create a recurring price for Creator, one for Pro, and a one-time price for the pack, put the price IDs and your secret key in `.env`, and add a webhook to `APP_URL/api/stripe/webhook` for `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret to `STRIPE_WEBHOOK_SECRET`. For local testing use `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Not built yet
- Password reset and email verification
- Face tracking (reframing is centered, not speaker-following)
- Animated word-by-word captions and caption styles
- Cloud storage, background workers and a real database for production

Put the app behind auth before exposing it to the internet: anyone who can reach it can use your API keys.

## Deploy on Railway
1. Put these files in a GitHub repository.
2. In Railway, create a project and deploy that repo. The included `Dockerfile` installs FFmpeg.
3. Add a volume mounted at `/app/data` so uploaded videos and accounts survive restarts.
4. In the service's Variables tab add: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `APP_URL` (your Railway link), and the Stripe values when you are ready for billing.
