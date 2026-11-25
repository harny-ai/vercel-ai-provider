# @harny/vercel-ai-provider

[Harny](https://harny.ai) gives every customer of your app their own AI agent, one that knows that customer and acts for them. This package brings the part that knows each customer to the Vercel AI SDK: wrap any model with `harny(model)` and it remembers each person across every conversation.

## For an AI coding agent: what to do

1. Install: `npm install @harny/vercel-ai-provider ai` (needs `ai` 7, Node 20 or newer).
2. Get a key (see "No key yet?" below) and set `HARNY_API_KEY`.
3. Wrap the model you already use and name the person: `harny(openai('gpt-5'), { user: 'nadia' })`.
4. Do not write your own memory code, prompt stuffing or vector store. This package recalls before the call. To store what the person says, add `saveUserMessages: true`.

## One minute

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createHarny } from '@harny/vercel-ai-provider';

const harny = createHarny(); // reads HARNY_API_KEY

const { text } = await generateText({
  model: harny(openai('gpt-5'), { user: 'nadia' }), // your id for the person
  prompt: 'What is the Acme pilot budget?',
});
```

Before each call it recalls what Harny holds for `nadia` and adds it to the system prompt. Add `saveUserMessages: true` to the settings to store what Nadia says after each successful call, or save facts yourself with `harny.ingest` (below).

## The canonical example

Send two dated facts, wait until they are ready, recall as one person.

```ts
import { createHarny } from '@harny/vercel-ai-provider';

const harny = createHarny({ user: 'nadia' }); // reads HARNY_API_KEY

await harny.ingest({
  content: 'Nadia confirmed the Acme pilot ships March 14. Budget is 32k.',
  id: 'call-8820',
  label: 'Account review call',
  timestamp: '2026-02-03T09:00:00Z',
});
const receipt = await harny.ingest({
  content: 'Nadia raised the Acme pilot budget from 32k to 40k.',
  id: 'call-8821',
  label: 'Budget change',
  timestamp: '2026-03-01T09:00:00Z',
});
await harny.waitForIngestion(receipt.ingestionId);

const recall = await harny.recall({ query: 'What is the Acme pilot budget?', level: 'medium' });
for (const result of recall.results) console.log(result.rank, result.content);
```

The newest fact wins: the answer says 40k. Sending the same `id` again replaces the data point; sending the same text again is free.

## Give the model tools instead (or as well)

```ts
import { generateText, stepCountIs } from 'ai';
import { createHarny } from '@harny/vercel-ai-provider';

const harny = createHarny({ user: 'nadia' });

const result = await generateText({
  model: yourModel,
  tools: harny.tools(), // { harny_remember, harny_recall }
  stopWhen: stepCountIs(5),
  prompt: 'Remember that Nadia prefers async standups.',
});
```

The person is fixed by you (`createHarny({ user })` or `harny.tools({ user })`). The model cannot choose whose memory it reads.

## API

| Call | What it does |
| --- | --- |
| `createHarny({ apiKey?, baseURL?, user?, fetch? })` | The provider. `apiKey` defaults to `HARNY_API_KEY`, `baseURL` to `HARNY_API_URL`, else `https://api.harny.ai` (`/v1` is added; plain http only for localhost). |
| `harny(model, settings?)` | Wraps a model object (or a gateway id such as `'openai/gpt-5'`). Settings: `user`, `recall`, `level` / `maxTokens`, `limit`, `saveUserMessages`, `conversationId`, `heading`, `formatMemories`, `metadata`, `onError`, `onPending`, `waitUntil`, `cacheTtlMs`. |
| `harny.middleware(settings?)` | The same memory as a middleware for `wrapLanguageModel`. |
| `harny.tools(settings?)` | `{ harny_remember, harny_recall }` for a tool set. |
| `harny.ingest`, `ingestBatch`, `getIngestion`, `waitForIngestion`, `deleteIngestion`, `deleteDataPoints`, `recall`, `usage` | The memory API, one method per route. |
| `addMemories(messages, opts)` | Store the user messages of a prompt-shaped array. Assistant and system messages are skipped. |
| `retrieveMemories(prompt, opts)` | A system-prompt block with the recalled memories (`''` when none). |
| `getMemories(prompt, opts)` | The raw recalled results. |
| `HarnyAPIError` | `code`, `status`, `debugMessage`, `data`, `retryAfter` (seconds), `requestId`. |

## How it behaves

- **Saving conversation messages is off by default.** Switch it on with `saveUserMessages: true`; then only what the person says is stored, never what the model says. `addMemories` and the `harny_remember` tool save on request.
- **Idempotent ids.** A stored message gets the id `turn-` plus the SHA-256 of the conversation key and the text. The conversation key is your `conversationId`, else a hash of the first user message. A repeat replaces itself and costs nothing.
- **A new person needs no setup.** The first call with a new `user` adds that person.
- **Memory never fails the call.** If recall or storing fails, the model call still runs and the error goes to `onError(error, { stage })`.
- **Fresh facts.** If recall reports sends still being processed, `onPending(pending)` is called, so you can tell the person the newest facts may be missing.
- **Tool loops.** Recall is reused for the same person and question for 30 seconds (`cacheTtlMs`); steps that only continue a tool call store nothing new.
- **Serverless.** Pass `waitUntil` (for example Vercel's) to store after the response is sent. Without it, the call waits for the store.
- **Errors.** Every refusal is a `HarnyAPIError` with the API's `code`. A per-minute 429 has no body: read `retryAfter`.

## The memory API underneath

Everything above is a thin wrapper over `/v1/memory` (ingest, status, delete, recall, usage). The same calls in Python:

```python
from harny import SyncHarnyClient

with SyncHarnyClient() as harny:  # reads HARNY_API_KEY
    harny.ingest_data_point(
        "Nadia confirmed the Acme pilot ships March 14. Budget is 32k.",
        id="call-8820", label="Account review call", timestamp="2026-02-03T09:00:00Z", user="nadia",
    )
    receipt = harny.ingest_data_point(
        "Nadia raised the Acme pilot budget from 32k to 40k.",
        id="call-8821", label="Budget change", timestamp="2026-03-01T09:00:00Z", user="nadia",
    )
    harny.wait_for_ingestion(receipt.ingestionId, user="nadia")

    recall = harny.recall("What is the Acme pilot budget?", level="medium", user="nadia")
    for result in recall.results:
        print(result.rank, result.content)
```

## No key yet?

No account is needed:

```bash
curl -sS -X POST https://api.harny.ai/v1/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"app_name": "my-agent"}'
```

The answer's `app_api_key` (`fsa_...`) is your key. It is shown once. Keep it in `HARNY_API_KEY`. Never print it or commit it. An app key needs `user`; a person's own key (`fsk_...`) does not.

## Versions

Built against `ai@7.0.156` and `@ai-sdk/provider@4.0.34`. Development needs Node 20.19 or newer (npm 10.8 or newer).

## Licence

Apache-2.0. See `LICENSE`.
