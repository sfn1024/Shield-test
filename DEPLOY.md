# Deploying Sealed on Netlify

Sealed needs both the static frontend and the Netlify Function relay. If the site is deployed by dragging only the
`dist` folder into Netlify, chat will not work because functions are not included.

Use a Git-based Netlify deploy with these settings:

- Base directory: `Shield-test`
- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

After deploy, check:

```text
https://YOUR-SITE.netlify.app/.netlify/functions/relay?roomId=abcdefghijklmnopqrstuv
```

Expected response:

```json
{"messages":[]}
```

If that URL returns `404`, the function was not deployed. Check the Netlify deploy log for a Functions section and
verify the site is building from the project root that contains `netlify/functions/relay.js`.
