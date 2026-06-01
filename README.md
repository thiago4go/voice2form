# voice2form

Framework-agnostic browser plugin that reads any `<form>` and turns form filling into a voice-to-voice chatbot experience.

- Works on any site that can load a JavaScript file
- Uses browser speech recognition + speech synthesis
- Uses an **OpenAI-compatible backend** (`/v1/chat/completions`)

## Quick start (pure HTML)

```html
<script src="/src/voice2form.js"></script>
<script>
  new Voice2Form({
    backendUrl: "https://your-openai-compatible-backend",
    apiKey: "YOUR_API_KEY",
    model: "gpt-4o-mini",
    selector: "form"
  });
</script>
```

## OpenAI-compatible backend contract

The plugin sends:
- `POST {backendUrl}/v1/chat/completions`
- Standard OpenAI Chat Completions payload

The model should return strict JSON in `choices[0].message.content`:

```json
{
  "fields": { "email": "john@doe.com", "name": "John Doe" },
  "reply": "Great, I filled your form."
}
```

## Deploy in different stacks

### WordPress
1. Copy `/src/voice2form.js` to your theme assets.
2. Enqueue it in `functions.php` via `wp_enqueue_script`.
3. Add an inline init script with your `backendUrl` and `apiKey`.

### WooCommerce
Same as WordPress, then target checkout forms with selector examples:
- `form.checkout`
- `form.woocommerce-cart-form`

### Laravel
1. Place `/src/voice2form.js` in `public/js`.
2. Include `<script src="{{ asset('js/voice2form.js') }}"></script>` in Blade.
3. Initialize in Blade or Vite entry script.

### Python (Django / Flask / FastAPI templates)
1. Serve `/src/voice2form.js` as static asset.
2. Include it in template HTML.
3. Initialize with your OpenAI-compatible backend URL.

### Next.js
1. Put script in `public/voice2form.js`.
2. Load with `<Script src="/voice2form.js" strategy="afterInteractive" />`.
3. Initialize in client component `useEffect`.

### Pure HTML
Just include script and initialize (Quick start above).

## Notes

- Requires browser support for `SpeechRecognition` (or `webkitSpeechRecognition`).
- For production, keep API keys server-side when possible (proxy requests through your backend).
