# SwipeDict Dictionaries

Bilingual dictionary data for the SwipeDict vocabulary learning app. Currently contains:

- **ms-de-ro** — German → Romanian (~2700 entries)
- **ms-en-ro** — English → Romanian (~1400 entries)

## Entry Format

Each entry is a JSON file following the [entry schema](spec/entry.schema.json):

```json
{
  "id": "ms-de-ro-abendessen",
  "part_of_speech": "noun",
  "tags": ["topic:food", "level:A1"],
  "sourceLanguage": "de",
  "targetLanguage": "ro",
  "source": {
    "headword": "Abendessen",
    "definition": "Evening meal",
    "pronunciation": "ˈaːbn̩tˌɛsn̩"
  },
  "target": {
    "headword": "cina",
    "definition": "Masă de seară",
    "pronunciation": "ˈt͡ʃi.na"
  },
  "senses": [...],
  "examples": [...],
  "media": {
    "audio": [
      { "path": "target.headword", "url": "/media/ms-ro/audio/cina.opus", "lang": "ro" }
    ]
  }
}
```

## Build Pipeline

The `infra/` directory contains a 6-step build pipeline:

```bash
cd infra
npm run build    # or: node cicd.js
```

| Step | Script | Description |
|---|---|---|
| 1 | `01_clear_dist.mjs` | Wipes the `dist/` output folder |
| 2 | `02_stage_files_to_dist.mjs` | Copies source JSONs + media into `dist/` |
| 3 | `03_update_detail_json_media.mjs` | Links audio file paths into detail JSONs |
| 4 | `04_generate_index.mjs` | Generates per-dictionary and global indexes |
| 5 | `05_validate_dist.mjs` | Validates all entries against JSON schemas |
| 6 | `06_compress_dist.mjs` | Gzip-compresses all JSON files |

Output: `dist/`

## Schemas

- [dictionary.schema.json](spec/dictionary.schema.json) — Global dictionary metadata
- [entry.schema.json](spec/entry.schema.json) — Vocabulary entry format
- [parent.schema.json](spec/parent.schema.json) — Parent/group entry format
- [tagging.schema.json](spec/tagging.schema.json) — Tag taxonomy

## AI Attribution

Dictionary content (translations, definitions, example sentences, learning tips) was generated with the assistance of AI tools (OpenAI). All entries have been reviewed and curated.

Audio files are generated using ElevenLabs TTS and stored in a separate private repository.

## License

CC BY-SA 4.0 — see [LICENSE](LICENSE)
