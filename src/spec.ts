// The API, described once: served as OpenAPI at /api/openapi.json and rendered as a page at /api.
type Op = {
  method: string; path: string; summary: string; auth: "owner" | "gateway" | "none" | "demo";
  params?: [string, string, string][]; // [name, in, description]
  body?: string; returns: string;
};

export const OPS: Op[] = [
  { method: "GET", path: "/ipfs/{cid}", auth: "gateway", summary: "Read a pinned file, or a folder (redirects to the slash form, then serves index.html or a listing). Bytes are checked against the CID as they stream, unless verify=false.",
    params: [["cid", "path", "CIDv0 (Qm...) or CIDv1 (bafy..., bafk...)"], ["verify", "query", "false = pass the bytes through without hashing (default from VERIFY_DEFAULT)"],
      ["download", "query", "true = Content-Disposition: attachment"], ["filename", "query", "name for the download"], ["format", "query", "raw = the root block, for clients that verify it themselves"],
      ["gatewayToken", "query", "needed when GATEWAY_TOKEN is set (also pinataGatewayToken, or the x-gateway-token header)"], ["Range", "header", "bytes=a-b, answered 206"]],
    returns: "200/206 the file, with Etag, X-Ipfs-Path, X-Ipfs-Roots, immutable Cache-Control and X-Faux-Verify: verified|skipped. 404 if not pinned here." },
  { method: "GET", path: "/ipfs/{cid}/{path}", auth: "gateway", summary: "A file or subfolder inside a pinned folder. Every folder node on the way is hashed against the CID that points to it.",
    params: [["path", "path", "e.g. img/photo.jpg; a folder path ends in /"], ["verify", "query", "false = no hashing"]],
    returns: "200/206 the file; a folder gives its index.html or a listing; 404 if the path isn't in the folder" },
  { method: "HEAD", path: "/ipfs/{cid}", auth: "gateway", summary: "The same headers as GET, no body.", returns: "200" },
  { method: "POST", path: "/api/files", auth: "owner", summary: "Upload and pin a file. Returns its CID, the same one `ipfs add` would give.",
    body: "multipart/form-data: file (required), name, cidVersion (0|1), keyvalues (JSON). For a folder, send several file parts whose filenames carry the path (site/index.html, site/img/a.png): the folder gets the CID `ipfs add -r` gives. Or a raw body with ?name=&cidVersion=",
    returns: "201 {cid, kind (file|dir), name, size, type, cidVersion, created, keyvalues, files (folders), url, isDuplicate}; 200 with isDuplicate: true if already pinned" },
  { method: "GET", path: "/api/files", auth: "owner", summary: "List pinned files.", params: [["limit", "query", "up to 1000 (default 100)"], ["cursor", "query", "from the previous page"]],
    returns: "200 {files: [{cid, name, size, created}], cursor}" },
  { method: "GET", path: "/api/files/{cid}", auth: "owner", summary: "One file's record.", returns: "200 the record; 404 if not pinned" },
  { method: "PATCH", path: "/api/files/{cid}", auth: "owner", summary: "Rename, or merge keyvalues. The CID never changes.", body: "JSON {name?, keyvalues?}", returns: "200 the record" },
  { method: "DELETE", path: "/api/files/{cid}", auth: "owner", summary: "Unpin and delete a file or folder, with all its stored objects and blocks.", returns: "200 {deleted}; 404 if not pinned" },
  { method: "POST", path: "/pinning/pinFileToIPFS", auth: "owner", summary: "Legacy pinning-API alias: upload (file, pinataMetadata, pinataOptions.cidVersion), for existing SDK calls.", body: "multipart/form-data", returns: "200 {IpfsHash, PinSize, Timestamp, isDuplicate}" },
  { method: "POST", path: "/pinning/pinJSONToIPFS", auth: "owner", summary: "Legacy pinning-API alias: pin a JSON value.", body: "JSON {pinataContent, pinataMetadata, pinataOptions}", returns: "200 {IpfsHash, PinSize, Timestamp, isDuplicate}" },
  { method: "DELETE", path: "/pinning/unpin/{cid}", auth: "owner", summary: "Legacy pinning-API alias: delete.", returns: "200 OK" },
  { method: "GET", path: "/data/pinList", auth: "owner", summary: "Legacy pinning-API alias: list.", returns: "200 {count, rows: [{ipfs_pin_hash, size, date_pinned, metadata}]}" },
  { method: "GET", path: "/data/testAuthentication", auth: "owner", summary: "Check a token.", returns: "200" },
  { method: "POST", path: "/demo/pin", auth: "demo", summary: "Demo only (when DEMO is set): pin a short text. Up to 5,000 characters of English letters, numbers, spaces, newlines and . , ! ? ' \" - : ; ( ).",
    body: "JSON {text}", returns: "201/200 {cid, url, size, isDuplicate}; 400 if the text breaks the rules; 404 when DEMO is off" },
];

const AUTH: Record<Op["auth"], string> = {
  owner: "Authorization: Bearer <OWNER_TOKEN>",
  gateway: "open, or GATEWAY_TOKEN when it is set",
  none: "none",
  demo: "none (only exists when DEMO is set)",
};

export function openapi(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of OPS) {
    (paths[o.path] ??= {})[o.method.toLowerCase()] = {
      summary: o.summary,
      security: o.auth === "owner" ? [{ owner: [] }] : o.auth === "gateway" ? [{ gateway: [] }, {}] : [],
      parameters: (o.params ?? []).map(([name, where, description]) => ({ name, in: where, description, required: where === "path" })),
      ...(o.body ? { requestBody: { description: o.body } } : {}),
      responses: { default: { description: o.returns } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Faux IPFS", version: "0.1.0", description: "A private IPFS gateway on a Cloudflare Worker, R2 and KV. No IPFS node." },
    servers: [{ url: origin }],
    components: { securitySchemes: {
      owner: { type: "http", scheme: "bearer", description: "OWNER_TOKEN" },
      gateway: { type: "apiKey", in: "query", name: "gatewayToken", description: "GATEWAY_TOKEN, when set" },
    } },
    paths,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function apiPage(origin: string) {
  const rows = OPS.map((o) => `
    <section>
      <h3><span class="m m-${o.method.toLowerCase()}">${o.method}</span> <code>${esc(o.path)}</code></h3>
      <p>${esc(o.summary)}</p>
      <p class="auth">Auth: ${esc(AUTH[o.auth])}</p>
      ${o.params ? `<table>${o.params.map(([n, w, d]) => `<tr><td><code>${esc(n)}</code></td><td>${w}</td><td>${esc(d)}</td></tr>`).join("")}</table>` : ""}
      ${o.body ? `<p><b>Body:</b> ${esc(o.body)}</p>` : ""}
      <p><b>Returns:</b> ${esc(o.returns)}</p>
    </section>`).join("");
  return page("Faux IPFS API", `
    <p><a href="/">&larr; home</a> &middot; <a href="/api/openapi.json">openapi.json</a></p>
    <h1>Faux IPFS API</h1>
    <p>Everything under <code>/api/files</code>, <code>/pinning</code> and <code>/data</code> belongs to the owner and needs
    <code>Authorization: Bearer &lt;OWNER_TOKEN&gt;</code>. Reads under <code>/ipfs/</code> are open unless a gateway token is set.</p>
    <pre>curl -H "Authorization: Bearer $OWNER_TOKEN" -F file=@photo.jpg ${esc(origin)}/api/files
curl ${esc(origin)}/ipfs/&lt;cid&gt;
curl "${esc(origin)}/ipfs/&lt;cid&gt;?verify=false"</pre>
    ${rows}`);
}

export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
  :root { --bg:#fbfaf7; --fg:#1d1d1f; --mut:#6b6b70; --line:#e4e2dc; --acc:#0b7a75; --code:#f1efe9; color-scheme: light dark }
  @media (prefers-color-scheme: dark) { :root { --bg:#141416; --fg:#ececec; --mut:#9a9aa2; --line:#2a2a2e; --acc:#4fd1c5; --code:#1f1f23 } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif }
  main { max-width: 820px; margin: 0 auto; padding: 28px 16px 60px }
  h1 { font-size: 30px; margin: 8px 0 6px } h3 { margin: 0 0 6px; font-size: 17px }
  a { color: var(--acc) } code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 14px }
  pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow-x: auto }
  section { border-top: 1px solid var(--line); padding: 16px 0 }
  .m { display:inline-block; min-width: 58px; text-align:center; font: 700 12px/22px ui-monospace, Consolas, monospace; border-radius: 4px; color:#fff; background:#666 }
  .m-get, .m-head { background:#2b7a3d } .m-post { background:#1f5fa8 } .m-patch { background:#a86a1f } .m-delete { background:#a8321f }
  .auth { color: var(--mut); font-size: 14px; margin: 0 0 6px }
  table { border-collapse: collapse; font-size: 14px; margin: 6px 0 } td { border-top: 1px solid var(--line); padding: 4px 10px 4px 0; vertical-align: top }
  textarea { width: 100%; box-sizing: border-box; min-height: 200px; font: 15px/1.5 ui-monospace, Consolas, monospace; padding: 10px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--code); color: var(--fg) }
  button { font: 600 16px system-ui, sans-serif; padding: 10px 18px; border: 0; border-radius: 8px; background: var(--acc); color: #fff; cursor: pointer }
  button:disabled { opacity: .45; cursor: default }
  .row { display:flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 10px 0 }
  .mut { color: var(--mut); font-size: 14px } .bad { color: #c0392b; font-size: 14px }
  .note { border-left: 3px solid var(--acc); padding: 6px 12px; background: var(--code); border-radius: 0 6px 6px 0; font-size: 14px }
  .out { word-break: break-all }
</style></head><body><main>${body}</main></body></html>`;
}
