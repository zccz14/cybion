from pathlib import Path
manifest = [line.strip() for line in Path('docs/responses-codex-parity.md').read_text().splitlines() if line.startswith(('response.', 'codex.', 'responsesapi.', 'error'))]
source = Path('src/responses.rs').read_text()
missing = [event for event in manifest if f'rename = "{event}"' not in source]
if missing:
    raise SystemExit(f'missing Codex event handlers: {missing}')
print(f'validated {len(manifest)} Codex Responses event values')
