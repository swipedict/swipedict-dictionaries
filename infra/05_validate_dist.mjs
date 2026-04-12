import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const LOG_PREFIX = '[DistValidator-05]';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONOREPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(MONOREPO_ROOT, 'dist');
const SPEC_DIR = path.resolve(MONOREPO_ROOT, 'spec');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
let validateEntry, validateParentEntry, validateGlobalIndex;

let globalStats = { totalErrors: 0, totalWarnings: 0, dictionariesChecked: 0, entriesChecked: 0, mediaLinksChecked: 0 };
let mediaAvailable = false;

async function loadAndCompileSchemas() {
    try {
        const entrySchemaContent = await fs.readFile(path.join(SPEC_DIR, 'entry.schema.json'), 'utf-8');
        validateEntry = ajv.compile(JSON.parse(entrySchemaContent));

        const parentSchemaContent = await fs.readFile(path.join(SPEC_DIR, 'parent.schema.json'), 'utf-8');
        validateParentEntry = ajv.compile(JSON.parse(parentSchemaContent));
        
        const globalIndexSchema = {
            type: "object",
            properties: {
                serverInfo: { type: "string" },
                generatedAt: { type: "number" },
                dictionaries: { type: "array", items: { type: "object" } }
            },
            required: ["serverInfo", "generatedAt", "dictionaries"]
        };
        validateGlobalIndex = ajv.compile(globalIndexSchema);

        console.log(`${LOG_PREFIX} Schemas loaded successfully.`);
        return true;
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ FATAL: Could not load schemas from ${SPEC_DIR}.`, e);
        return false;
    }
}

function logSchemaErrors(errors, filePath) {
    console.error(`${LOG_PREFIX} ❌ SCHEMA validation failed for: ${path.relative(MONOREPO_ROOT, filePath)}`);
    errors.forEach(e => console.error(`  - Path: ${e.instancePath || '/'} | Message: ${e.message}`));
    globalStats.totalErrors++;
}

async function checkExistence(p, type) {
    try {
        await fs.access(p);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} ❌ MISSING ${type}: ${path.relative(MONOREPO_ROOT, p)}`);
        globalStats.totalErrors++;
        return false;
    }
}

async function processEntry(indexEntry, dictDistPath, validator) {
    globalStats.entriesChecked++;
    const detailJsonPath = path.join(dictDistPath, indexEntry.filename);

    if (!(await checkExistence(detailJsonPath, 'Detail JSON File'))) return;

    let detailData;
    try {
        detailData = JSON.parse(await fs.readFile(detailJsonPath, 'utf-8'));
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ INVALID JSON in: ${path.relative(MONOREPO_ROOT, detailJsonPath)}`);
        globalStats.totalErrors++;
        return;
    }
    
    if (!validator(detailData)) {
        logSchemaErrors(validator.errors, detailJsonPath);
    }

    if (detailData.media?.audio) {
        for (const audioEntry of detailData.media.audio) {
            globalStats.mediaLinksChecked++;
            if (!audioEntry.url) {
                console.error(`${LOG_PREFIX} ❌ Missing URL in media entry in: ${path.relative(MONOREPO_ROOT, detailJsonPath)}`);
                globalStats.totalErrors++;
                continue;
            }

            const mediaFilePath = path.join(DIST_DIR, audioEntry.url);
            if (!(await checkExistence(mediaFilePath, 'Media File'))) {
                if (!mediaAvailable) {
                    console.warn(`${LOG_PREFIX} ⚠️  WARN: Media file missing (media repo not staged): ${path.relative(MONOREPO_ROOT, mediaFilePath)}`);
                    console.warn(`  - Referenced by: ${path.relative(MONOREPO_ROOT, detailJsonPath)}`);
                    globalStats.totalErrors--;
                    globalStats.totalWarnings++;
                } else {
                    console.error(`  - Referenced by: ${path.relative(MONOREPO_ROOT, detailJsonPath)}`);
                }
            }
        }
    }
}

async function processDictionary(dictionaryInfo, distDir) {
    globalStats.dictionariesChecked++;
    console.log(`\n${LOG_PREFIX} Checking dictionary: ${dictionaryInfo.dictId}`);
    
    const dictDistPath = path.join(distDir, dictionaryInfo.path);
    if (!(await checkExistence(dictDistPath, 'Dictionary Directory'))) return;

    const indexJsonPath = path.join(dictDistPath, `index-${dictionaryInfo.dictId}.json`);
    if (!(await checkExistence(indexJsonPath, 'Dictionary Index File'))) return;
    
    let indexData;
    try {
        indexData = JSON.parse(await fs.readFile(indexJsonPath, 'utf-8'));
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ INVALID JSON in: ${path.relative(MONOREPO_ROOT, indexJsonPath)}`);
        globalStats.totalErrors++;
        return;
    }
    
    const isParentDict = dictionaryInfo.type.split('-').length === 1;
    const validator = isParentDict ? validateParentEntry : validateEntry;
    console.log(`${LOG_PREFIX}   -> Using ${isParentDict ? 'PARENT' : 'ENTRY'} schema for validation.`);

    for (const entry of indexData.entries) {
        if (!entry.filename) {
             console.error(`${LOG_PREFIX} ❌ Missing 'filename' in an index entry in: ${path.relative(MONOREPO_ROOT, indexJsonPath)}`);
             globalStats.totalErrors++;
             continue;
        }
        await processEntry(entry, dictDistPath, validator);
    }
}

async function main() {
    console.log("--- Starting Final 'dist' Folder Validation ---");
    if (!(await loadAndCompileSchemas())) process.exit(1);

    const mediaDirPath = path.join(DIST_DIR, 'media');
    try {
        await fs.access(mediaDirPath);
        mediaAvailable = true;
    } catch {
        mediaAvailable = false;
        console.log(`${LOG_PREFIX} ⚠️  Media directory not found in dist. Missing media will be treated as warnings.`);
    }
    
    const globalIndexPath = path.join(DIST_DIR, 'dictionaries.json');
    if (!(await checkExistence(globalIndexPath, 'Global Index File'))) process.exit(1);

    const globalIndexData = JSON.parse(await fs.readFile(globalIndexPath, 'utf-8'));
    if (!validateGlobalIndex(globalIndexData)) {
        logSchemaErrors(validateGlobalIndex.errors, globalIndexPath);
    }
    
    if (globalIndexData.dictionaries) {
        for (const dictionaryInfo of globalIndexData.dictionaries) {
            await processDictionary(dictionaryInfo, DIST_DIR);
        }
    }

    console.log("\n\n======= GLOBAL SUMMARY (Dist Validation) =======");
    console.log(`Dictionaries: ${globalStats.dictionariesChecked} | Entries: ${globalStats.entriesChecked} | Media Links: ${globalStats.mediaLinksChecked}`);
    if (globalStats.totalWarnings > 0) {
        console.log(`Warnings: ${globalStats.totalWarnings} (missing media — media repo not staged)`);
    }
    console.log(`Total Errors Found: ${globalStats.totalErrors}`);
    console.log("================================================");

    if (globalStats.totalErrors > 0) {
        console.error("\n❌ VALIDATION FAILED.");
        process.exit(1);
    } else {
        console.log("\n✅ VALIDATION SUCCESSFUL.");
    }
}

main().catch(err => {
    console.error("\nFATAL UNHANDLED ERROR in main execution:", err);
    process.exit(1);
});