// The demo (only when the DEMO var is set): the homepage becomes a text box. Type something, hash it, and the text is
// pinned; you get its CID and a gateway link. The same rules run in the browser and on the server, and only the server's
// count: at most 5,000 characters of English letters, numbers, spaces, newlines and simple punctuation.
import { page } from "./spec";

export const DEMO_MAX = 5000;
export const DEMO_PUNCT = ". , ! ? ' \" - : ; ( )";
// letters, digits, space, newline, and . , ! ? ' " - : ; ( )   (no < > & / \ ` or anything else)
export const DEMO_RE = /^[A-Za-z0-9 \n.,!?'"\-:;()]*$/;

/** The server-side check. Returns the text to pin (CRLF folded to LF) or the reason it was refused. */
export function demoText(input: unknown): { text: string } | { error: string } {
  if (typeof input !== "string") return { error: "send JSON {\"text\": \"...\"}" };
  const text = input.replace(/\r\n?/g, "\n");
  if (!text.trim()) return { error: "type something first" };
  if (text.length > DEMO_MAX) return { error: `at most ${DEMO_MAX} characters (this is ${text.length})` };
  if (!DEMO_RE.test(text)) {
    const bad = [...new Set(text.replace(/[A-Za-z0-9 \n.,!?'"\-:;()]/g, ""))].slice(0, 8).join(" ");
    return { error: `only English letters, numbers, spaces and simple punctuation (${DEMO_PUNCT}) are allowed; remove: ${bad}` };
  }
  return { text };
}

export function demoPage() {
  return page("Faux IPFS demo", `
    <h1>Faux IPFS</h1>
    <p>A private IPFS gateway on a Cloudflare Worker, R2 storage and KV: no IPFS node. Type some text, hash it, and it gets
    pinned under the same CID a real IPFS node would give it (CIDv1, like <code>ipfs add --cid-version=1</code>).</p>
    <p class="note"><b>For this demo only simple input is allowed:</b> up to ${DEMO_MAX.toLocaleString("en")} characters of English
    letters (A-Z, a-z), numbers (0-9), spaces, new lines and simple punctuation (<code>${DEMO_PUNCT}</code>).
    Anything you pin here is public to anyone with its CID.</p>
    <textarea id="t" maxlength="${DEMO_MAX}" placeholder="Ahoy. Type something here." spellcheck="false"></textarea>
    <div class="row">
      <button id="go" disabled>Hash it and pin it</button>
      <span class="mut" id="count">0 / ${DEMO_MAX}</span>
      <span class="bad" id="why"></span>
    </div>
    <div id="out" class="out"></div>
    <p class="mut"><a href="/api">API spec</a> &middot; reads are <code>GET /ipfs/&lt;cid&gt;</code>, checked against the CID as they stream
    (add <code>?verify=false</code> to pass the bytes straight through).</p>
<script>
  const t = document.getElementById('t'), go = document.getElementById('go'), why = document.getElementById('why'),
        count = document.getElementById('count'), out = document.getElementById('out');
  const MAX = ${DEMO_MAX}, OK = ${DEMO_RE.toString()};
  function check() {
    const v = t.value.replace(/\\r\\n?/g, '\\n');
    count.textContent = v.length + ' / ' + MAX;
    let msg = '';
    if (v.length > MAX) msg = 'Too long.';
    else if (!OK.test(v)) msg = 'Not allowed here: ' + [...new Set(v.replace(/[A-Za-z0-9 \\n.,!?'"\\-:;()]/g, ''))].slice(0, 8).join(' ');
    why.textContent = msg;
    go.disabled = !!msg || !v.trim();
  }
  t.addEventListener('input', check);
  go.addEventListener('click', async () => {
    go.disabled = true; out.textContent = 'Hashing...';
    try {
      const r = await fetch('/demo/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t.value }) });
      const j = await r.json();
      if (!r.ok) { out.textContent = ''; why.textContent = j.error || ('Error ' + r.status); return; }
      out.innerHTML = '';
      const p = (label, node) => { const d = document.createElement('p'); d.append(label, node); out.append(d); };
      const code = document.createElement('code'); code.textContent = j.cid; p('CID: ', code);
      const a = document.createElement('a'); a.href = j.url; a.textContent = location.origin + j.url; p('Read it (verified): ', a);
      const b = document.createElement('a'); b.href = j.url + '?verify=false'; b.textContent = 'pass-through, no hashing'; p('Or: ', b);
      p(j.isDuplicate ? 'Somebody already pinned exactly this text, so it got the same CID.' : 'Pinned. The same text always gets the same CID.', '');
    } catch (e) { out.textContent = ''; why.textContent = String(e); }
    finally { check(); }
  });
</script>`);
}

export function homePage() {
  return page("Faux IPFS", `
    <h1>Faux IPFS</h1>
    <p>A private IPFS gateway on a Cloudflare Worker, R2 storage and KV. Files get the same CIDs an IPFS node would give
    them, and reads are checked against the CID as they stream.</p>
    <p>Read a file: <code>GET /ipfs/&lt;cid&gt;</code> &middot; <a href="/api">API spec</a></p>`);
}
