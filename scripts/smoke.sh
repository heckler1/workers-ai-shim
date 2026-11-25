#!/usr/bin/env bash
# Usage: SHIM_URL=https://workers-ai-shim.<you>.workers.dev CF_API_TOKEN=... scripts/smoke.sh
set -euo pipefail
: "${SHIM_URL:?set SHIM_URL}" "${CF_API_TOKEN:?set CF_API_TOKEN}"
SHIM_URL="${SHIM_URL%/}"
auth=(-H "Authorization: Bearer ${CF_API_TOKEN}")

echo "== health";  curl -fsS "$SHIM_URL/health"; echo
echo "== models";  curl -fsS "${auth[@]}" "$SHIM_URL/v1/models" | head -c 400; echo
echo "== chat"
curl -fsS "${auth[@]}" -H 'content-type: application/json' "$SHIM_URL/v1/chat/completions" \
  -d '{"model":"@cf/zai-org/glm-4.7-flash","messages":[{"role":"user","content":"Say hi in 3 words."}]}'; echo
echo "== image -> out.png"
curl -fsS "${auth[@]}" -H 'content-type: application/json' "$SHIM_URL/v1/images/generations" \
  -d '{"model":"@cf/black-forest-labs/flux-2-klein-9b","prompt":"a small red fox, flat illustration","size":"1024x1024"}' \
  | python3 -c 'import sys,json,base64; open("out.png","wb").write(base64.b64decode(json.load(sys.stdin)["data"][0]["b64_json"]))'
ls -l out.png
echo "== speech -> out.mp3"
curl -fsS "${auth[@]}" -H 'content-type: application/json' "$SHIM_URL/v1/audio/speech" \
  -d '{"model":"@cf/deepgram/aura-2-en","input":"Hello from the shim.","voice":"luna"}' -o out.mp3
ls -l out.mp3
echo "== voices"; curl -fsS "${auth[@]}" "$SHIM_URL/v1/audio/voices?model=@cf/deepgram/aura-2-en" | head -c 300; echo
echo "== transcription of out.mp3 (turbo, verbose_json)"
curl -fsS "${auth[@]}" "$SHIM_URL/v1/audio/transcriptions" -F file=@out.mp3 -F model=@cf/openai/whisper-large-v3-turbo \
  -F response_format=verbose_json -F 'timestamp_granularities[]=word' | head -c 600; echo
