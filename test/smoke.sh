#!/usr/bin/env bash
# End-to-end check against a running Faux IPFS (default: `npm run dev` on :8799, owner token from .dev.vars).
#   bash test/smoke.sh [base-url]
# Run the dev server with the demo on, on empty storage (rm -rf .wrangler/state first):
#   npx wrangler dev --port 8799 --local --var DEMO:true
# Uploads files and a folder, checks the CIDs against kubo (`ipfs add --only-hash`), reads them back verified and pass-through,
# with ranges, HEAD and format=raw, checks owner-only access, then tampers with the stored bytes (local dev only)
# to show verification refusing them while ?verify=false serves them.
set -u
BASE=${1:-http://127.0.0.1:8799}
cd "$(dirname "$0")/.."
TOKEN=$(sed -n 's/^OWNER_TOKEN=//p' .dev.vars)
KUBO=$(node -e "console.log(require('kubo').path())")
rm -rf .smoke-tmp; mkdir -p .smoke-tmp/ipfs; export IPFS_PATH=.smoke-tmp/ipfs; "$KUBO" init --profile test -e >/dev/null 2>&1
T=.smoke-tmp; pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then echo "ok    $3"; pass=$((pass+1)); else echo "FAIL  $3: got [$1] want [$2]"; fail=$((fail+1)); fi; }
auth=(-H "Authorization: Bearer $TOKEN")
curl() { command curl -m 60 "$@"; }   # never hang the run

node -e "const b=require('crypto').randomBytes(1300000);require('fs').writeFileSync('$T/big.bin',b)"
printf 'hello world' > "$T/hello.txt"

# ---- owner only
ok "$(curl -s -o /dev/null -w '%{http_code}' -X POST -F file=@"$T/hello.txt" "$BASE/api/files")" 401 "upload without the owner token is refused"
ok "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$BASE/api/files")" 401 "list with a wrong token is refused"

# ---- upload: CIDs match kubo
for v in 1 0; do
  for f in hello.txt big.bin; do
    want=$("$KUBO" add --only-hash -Q --cid-version=$v "$T/$f")
    got=$(curl -s "${auth[@]}" -F file=@"$T/$f" -F cidVersion=$v "$BASE/api/files" | node -pe "JSON.parse(require('fs').readFileSync(0)).cid")
    ok "$got" "$want" "upload $f as CIDv$v matches kubo ($want)"
  done
done
BIG=$("$KUBO" add --only-hash -Q --cid-version=1 "$T/big.bin")
HELLO=$("$KUBO" add --only-hash -Q --cid-version=1 "$T/hello.txt")
ok "$(curl -s "${auth[@]}" -F file=@"$T/big.bin" "$BASE/api/files" | node -pe "JSON.parse(require('fs').readFileSync(0)).isDuplicate")" true "re-upload is a duplicate"

# ---- gateway reads
sha() { node -e "process.stdin.pipe(require('crypto').createHash('sha256')).setEncoding('hex').on('data',d=>console.log(d))"; }
want=$(sha < "$T/big.bin")
ok "$(curl -s "$BASE/ipfs/$BIG" | sha)" "$want" "verified read returns the exact bytes"
ok "$(curl -s "$BASE/ipfs/$BIG?verify=false" | sha)" "$want" "pass-through read returns the exact bytes"
ok "$(curl -s -D - -o /dev/null "$BASE/ipfs/$BIG" | tr -d '\r' | sed -n 's/^x-faux-verify: //Ip')" verified "header says verified"
ok "$(curl -s -D - -o /dev/null "$BASE/ipfs/$BIG?verify=false" | tr -d '\r' | sed -n 's/^x-faux-verify: //Ip')" skipped "header says skipped with ?verify=false"
ok "$(curl -s -r 300000-300009 "$BASE/ipfs/$BIG" | sha)" "$(tail -c +300001 "$T/big.bin" | head -c 10 | sha)" "verified range across a chunk boundary"
ok "$(curl -s -o /dev/null -w '%{http_code}' -r 0-99 "$BASE/ipfs/$BIG")" 206 "range answers 206"
ok "$(curl -s -I "$BASE/ipfs/$HELLO" | tr -d '\r' | sed -n 's/^content-length: //Ip')" 11 "HEAD gives the length"
ok "$(curl -s "$BASE/ipfs/$HELLO")" "hello world" "small file body"
ok "$(curl -s -I "$BASE/ipfs/$HELLO" | tr -d '\r' | sed -n 's/^cache-control: //Ip')" "public, max-age=29030400, immutable" "immutable cache header"
# the raw root block, checked by kubo itself: `ipfs block put` hashes it and must give back the same CID
curl -s "$BASE/ipfs/$BIG?format=raw" -o "$T/root.blk"
ok "$("$KUBO" block put --cid-codec=dag-pb "$T/root.blk" 2>/dev/null)" "$BIG" "format=raw root block hashes to the CID (kubo)"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")" 404 "unpinned CID is 404"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/notacid")" 400 "bad CID is 400"

# ---- list, rename, Pinata-shaped calls
ok "$(curl -s "${auth[@]}" "$BASE/api/files" | node -pe "JSON.parse(require('fs').readFileSync(0)).files.length")" 4 "list shows 4 files"
ok "$(curl -s "${auth[@]}" -X PATCH -H 'content-type: application/json' -d '{"name":"renamed.txt"}' "$BASE/api/files/$HELLO" | node -pe "JSON.parse(require('fs').readFileSync(0)).name")" renamed.txt "rename"
J=$(curl -s "${auth[@]}" -H 'content-type: application/json' -d '{"pinataContent":{"a":1},"pinataMetadata":{"name":"a.json"}}' "$BASE/pinning/pinJSONToIPFS" | node -pe "JSON.parse(require('fs').readFileSync(0)).IpfsHash")
ok "$(curl -s "$BASE/ipfs/$J")" '{"a":1}' "pinJSONToIPFS then read it back"
ok "$(curl -s "${auth[@]}" -F file=@"$T/hello.txt" -F 'pinataOptions={"cidVersion":0}' "$BASE/pinning/pinFileToIPFS" | node -pe "JSON.parse(require('fs').readFileSync(0)).IpfsHash")" "$("$KUBO" add --only-hash -Q "$T/hello.txt")" "pinFileToIPFS with pinataOptions cidVersion 0"

# ---- public pages and the demo (dev runs with DEMO=true from .dev.vars)
ok "$(curl -s "$BASE/" | grep -c 'For this demo only simple input is allowed')" 1 "homepage is the demo, with the simple-input note"
ok "$(curl -s "$BASE/" | grep -c 'href="/api"')" 1 "homepage links the API spec"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api")" 200 "API spec page is public"
ok "$(curl -s "$BASE/api/openapi.json" | node -pe "JSON.parse(require('fs').readFileSync(0)).openapi")" 3.1.0 "openapi.json"
printf 'Ahoy, Scuppers. Same slime, same nuggets!' > "$T/demo.txt"
DCID=$(curl -s -H 'content-type: application/json' -d '{"text":"Ahoy, Scuppers. Same slime, same nuggets!"}' "$BASE/demo/pin" | node -pe "JSON.parse(require('fs').readFileSync(0)).cid")
ok "$DCID" "$("$KUBO" add --only-hash -Q --cid-version=1 "$T/demo.txt")" "demo pin gives kubo's CID"
ok "$(curl -s "$BASE/ipfs/$DCID")" "Ahoy, Scuppers. Same slime, same nuggets!" "demo text reads back"
ok "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"text":"<script>alert(1)</script>"}' "$BASE/demo/pin")" 400 "demo refuses < > / characters"
ok "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"text":"café"}' "$BASE/demo/pin")" 400 "demo refuses non-English letters"
node -e "require('fs').writeFileSync('$T/long.json', JSON.stringify({text:'a'.repeat(5001)}))"
ok "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data-binary @"$T/long.json" "$BASE/demo/pin")" 400 "demo refuses 5001 characters"
node -e "require('fs').writeFileSync('$T/max.json', JSON.stringify({text:'b'.repeat(5000)}))"
ok "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data-binary @"$T/max.json" "$BASE/demo/pin")" 201 "demo takes exactly 5000 characters"

# ---- folders: upload files with paths in their names, like `ipfs add -r site`
mkdir -p "$T/site/img"
printf '<h1>hello from a folder</h1>' > "$T/site/index.html"
printf 'same slime, same nuggets' > "$T/site/notes.txt"
cp "$T/big.bin" "$T/site/img/big.bin"
printf '{"a":1}' > "$T/site/img/x.json"
DIR=$(curl -s "${auth[@]}" -F "file=@$T/site/index.html;filename=site/index.html" -F "file=@$T/site/notes.txt;filename=site/notes.txt" \
  -F "file=@$T/site/img/big.bin;filename=site/img/big.bin" -F "file=@$T/site/img/x.json;filename=site/img/x.json" "$BASE/api/files" \
  | node -pe "const j=JSON.parse(require('fs').readFileSync(0)); j.kind==='dir' ? j.cid : 'not a folder: '+JSON.stringify(j)")
ok "$DIR" "$("$KUBO" add -r -Q --cid-version=1 "$T/site")" "folder upload gives kubo's ipfs add -r CID"
ok "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/ipfs/$DIR")" "301 $BASE/ipfs/$DIR/" "folder URL without a slash redirects to the slash"
ok "$(curl -s "$BASE/ipfs/$DIR/")" '<h1>hello from a folder</h1>' "folder serves its index.html"
ok "$(curl -s "$BASE/ipfs/$DIR/notes.txt")" 'same slime, same nuggets' "file by path"
ok "$(curl -s "$BASE/ipfs/$DIR/img/big.bin" | sha)" "$want" "multi-chunk file in a subfolder, verified"
ok "$(curl -s "$BASE/ipfs/$DIR/img/big.bin?verify=false" | sha)" "$want" "same file, pass-through"
ok "$(curl -s -r 300000-300009 "$BASE/ipfs/$DIR/img/big.bin" | sha)" "$(tail -c +300001 "$T/big.bin" | head -c 10 | sha)" "range inside a folder file"
ok "$(curl -s -I "$BASE/ipfs/$DIR/img/x.json" | tr -d '\r' | sed -n 's/^content-type: //Ip')" "application/json" "content type from the file name"
ok "$(curl -s "$BASE/ipfs/$DIR/img/" | grep -c 'x.json')" 1 "a folder without index.html gets a listing"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/$DIR/nope.txt")" 404 "missing path is 404"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/$("$KUBO" add -Q --cid-version=1 "$T/site/notes.txt")")" 404 "a file's own CID isn't served alone (reach it through the folder)"
curl -s "$BASE/ipfs/$DIR/?format=raw" -o "$T/dir.blk"
ok "$("$KUBO" block put --cid-codec=dag-pb "$T/dir.blk" 2>/dev/null)" "$DIR" "format=raw folder block hashes to the folder CID (kubo)"
# tamper with the copy of big.bin inside the folder: the verified read refuses it, pass-through serves it
BIGF=$("$KUBO" add -Q --only-hash --cid-version=1 "$T/big.bin")
node -e "const b=require('fs').readFileSync('$T/big.bin');b[900000]^=1;require('fs').writeFileSync('$T/bad2.bin',b)"
curl -s -o /dev/null -X PUT --data-binary @"$T/bad2.bin" "$BASE/cdn-cgi/local/explorer/api/r2/buckets/faux-ipfs/objects/dirs%2F$DIR%2F$BIGF"
got=$(curl -s "$BASE/ipfs/$DIR/img/big.bin" | wc -c | tr -d ' ')
[ "$got" -lt 1300000 ] && ok stopped stopped "tampered folder file: verified read stops (sent $got of 1300000 bytes)" || ok "$got" "<1300000" "tampered folder file: verified read stops"
ok "$(curl -s "$BASE/ipfs/$DIR/notes.txt")" 'same slime, same nuggets' "the folder's other files still verify"
ok "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X DELETE "$BASE/api/files/$DIR")" 200 "delete the folder"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/$DIR/notes.txt")" 404 "deleted folder is gone"

# ---- tamper with the stored bytes (local dev storage only): verification must refuse them
node -e "const b=require('fs').readFileSync('$T/big.bin');b[700000]^=1;require('fs').writeFileSync('$T/bad.bin',b)"
# through wrangler dev's local explorer API (a second wrangler process would take the dev server down)
curl -s -o /dev/null -X PUT --data-binary @"$T/bad.bin" "$BASE/cdn-cgi/local/explorer/api/r2/buckets/faux-ipfs/objects/files%2F$BIG"
got=$(curl -s "$BASE/ipfs/$BIG" | wc -c | tr -d ' ')
[ "$got" -lt 1300000 ] && ok stopped stopped "tampered file: verified read stops early (sent $got of 1300000 bytes)" || ok "$got" "<1300000" "tampered file: verified read stops early"
ok "$(curl -s "$BASE/ipfs/$BIG?verify=false" | sha)" "$(sha < "$T/bad.bin")" "tampered file: ?verify=false passes the bad bytes through"
ok "$(curl -s -o /dev/null -w '%{http_code}' -r 0-99 "$BASE/ipfs/$BIG")" 206 "tampered file: a range in an untouched chunk still verifies"

# ---- delete
ok "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X DELETE "$BASE/api/files/$BIG")" 200 "delete"
ok "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ipfs/$BIG")" 404 "deleted file is gone"

rm -rf .smoke-tmp
echo "$pass passed, $fail failed"; [ $fail -eq 0 ]
