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
const PACKAGES_DIR = path.resolve(MONOREPO_ROOT, 'packages');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
let validateEntry, validateParentEntry, validateGlobalIndex, validateTags;

let globalStats = { totalErrors: 0, totalWarnings: 0, dictionariesChecked: 0, entriesChecked: 0, mediaLinksChecked: 0 };
let mediaAvailable = false;

async function loadAndCompileSchemas() {
    try {
        const entrySchemaContent = await fs.readFile(path.join(SPEC_DIR, 'entry.schema.json'), 'utf-8');
        validateEntry = ajv.compile(JSON.parse(entrySchemaContent));

        const parentSchemaContent = await fs.readFile(path.join(SPEC_DIR, 'parent.schema.json'), 'utf-8');
        validateParentEntry = ajv.compile(JSON.parse(parentSchemaContent));

        // entry/parent schemas only pattern-match the tag strings; the controlled
        // vocabulary lives in tagging.schema.json and has to be applied separately.
        const taggingSchemaContent = await fs.readFile(path.join(SPEC_DIR, 'tagging.schema.json'), 'utf-8');
        validateTags = ajv.compile(JSON.parse(taggingSchemaContent));

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

function checkTags(data, filePath) {
    if (validateTags(data.tags)) return;
    console.error(`${LOG_PREFIX} ❌ TAG validation failed for: ${path.relative(MONOREPO_ROOT, filePath)}`);
    console.error(`  - tags: ${JSON.stringify(data.tags)}`);
    validateTags.errors.forEach(e => console.error(`  - Path: tags${e.instancePath || ''} | Message: ${e.message}`));
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
    checkTags(detailData, detailJsonPath);

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

// Root entries (packages/ms-ro) never reach dist, so dist validation alone would leave
// them entirely unvalidated — this pass covers every package source file. Shape decides
// the schema: 'data' marks a root entry, 'source'+'target' a pair entry.
async function validatePackageSources() {
    console.log(`\n${LOG_PREFIX} --- Validating package source files ---`);
    let packageDirs;
    try {
        packageDirs = (await fs.readdir(PACKAGES_DIR, { withFileTypes: true }))
            .filter(d => d.isDirectory()).map(d => d.name);
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ Could not read packages directory: ${PACKAGES_DIR}`);
        globalStats.totalErrors++;
        return;
    }

    for (const pkg of packageDirs) {
        const pkgPath = path.join(PACKAGES_DIR, pkg);
        const files = (await fs.readdir(pkgPath)).filter(f => f.endsWith('.json'));
        let checked = 0;
        for (const file of files) {
            const filePath = path.join(pkgPath, file);
            let data;
            try {
                data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
            } catch (e) {
                console.error(`${LOG_PREFIX} ❌ INVALID JSON in: ${path.relative(MONOREPO_ROOT, filePath)}`);
                globalStats.totalErrors++;
                continue;
            }

            let validator;
            if (data.data) validator = validateParentEntry;
            else if (data.source && data.target) validator = validateEntry;
            else {
                console.error(`${LOG_PREFIX} ❌ UNRECOGNIZED entry shape (neither root nor pair): ${path.relative(MONOREPO_ROOT, filePath)}`);
                globalStats.totalErrors++;
                continue;
            }

            checked++;
            globalStats.entriesChecked++;
            if (!validator(data)) {
                logSchemaErrors(validator.errors, filePath);
            }
            checkTags(data, filePath);
        }
        console.log(`${LOG_PREFIX}   -> ${pkg}: ${checked} source entries validated.`);
    }
}

async function main() {
    console.log("--- Starting Final 'dist' Folder Validation ---");
    if (!(await loadAndCompileSchemas())) process.exit(1);

    await validatePackageSources();

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