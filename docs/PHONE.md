# Rocky on your phone

Rocky runs on your computer. Your phone can reach it privately, to check what is running, approve or deny, and ask a quick question. There is no Rocky server in between. The connection goes over [Tailscale](https://tailscale.com), a free private network between your own devices.

## What you need

- Tailscale on the computer that runs Rocky, and on your phone, signed in to the same account.
- HTTPS certificates turned on for your tailnet (in the Tailscale admin console, under DNS). `tailscale serve` needs them.

## Set it up

1. On the computer, run:

   ```
   tailscale serve 7337
   ```

   Use your own port if you changed `daemon.port`. It prints an address like `https://pc.tail1234.ts.net`. Leave it running, or run it in the background (see `tailscale serve --help`).

2. In Rocky on the computer, open **Settings › Phone and devices**. Add the name it printed (`pc.tail1234.ts.net`).

3. Click **Make a pairing code**. On the phone, open `https://pc.tail1234.ts.net/pair` and type the six digits. The code works once, for five minutes.

4. To install it like an app, use your phone browser's **Add to Home Screen** or **Install app**.

## What a phone can and can't do

A paired phone sees what you see on the computer: Today, Approvals, Tasks, Chat and the rest. High-risk approvals are press-and-hold on a touch screen.

A phone can't:

- add or change API keys or other secrets,
- delete data,
- pair more devices or change the allowed names,
- use Rocky's MCP endpoint.

Do those on the computer.

## Safety

- Rocky still listens only on `127.0.0.1`. Only `tailscale serve` on the same computer passes your phone's requests in, encrypted over HTTPS.
- A request by an allowed name needs a paired phone's cookie. It is `Secure`, `HttpOnly`, `SameSite=Strict`, and lasts 90 days. Rocky stores only its hash.
- Sign a phone out in **Settings › Phone and devices**. It is locked out at once.
- The installed app keeps only Rocky's own page files on the phone. It never keeps answers, approvals or anything from `/api`.

## Not supported

- **Plain HTTP on your home network.** The phone's cookie would travel unencrypted.
- **Cloudflare Tunnel and other public tunnels.** They put Rocky on the public internet.

If you need one of these, open an issue explaining why.

## When it can't connect

"Can't reach your computer. It may be asleep." means the phone reached nothing. Check that:

- the computer is awake,
- Rocky is running (`rocky daemon`, or the desktop app),
- `tailscale serve` is still serving.
