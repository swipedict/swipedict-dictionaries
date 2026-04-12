import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const LOG_PREFIX = '[IndexGen-04]';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MONOREPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(MONOREPO_ROOT, 'dist');
const PACKAGES_DIR = path.resolve(MONOREPO_ROOT, 'packages');

const PROPERTIES_FILENAME = '_dictionary.properties';
const GLOBAL_INDEX_FILENAME = 'dictionaries.json';
const SERVER_NAME = "SwipeDict";

const EPOCH = new Date('2025-01-01T00:00:00Z').getTime();
const CUSTOM_ALPHABET = '023456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// --- MODIFICATION: Default logging is now OFF ---
const ARGS = process.argv.slice(2);
const SHOULD_LOG_SOURCE = ARGS.includes('--log-missing-source');
const SHOULD_LOG_TARGET = ARGS.includes('--log-missing-target');

function makeFilenameSafe(text) {
    if (!text) return 'untitled';
    return text.trim().toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
        .replace(/ș/g, 's').replace(/ţ/g, 't').replace(/ş/g, 's').replace(/ţ/g, 't')
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function generateBuildId() {
    let num = Math.floor((new Date().getTime() - EPOCH) / 1000);
    let result = '';
    do {
        result = CUSTOM_ALPHABET[num % CUSTOM_ALPHABET.length] + result;
        num = Math.floor(num / CUSTOM_ALPHABET.length);
    } while (num > 0);
    return result;
}

function parseProperties(folderPath) {
    const propsFilePath = path.join(folderPath, PROPERTIES_FILENAME);
    try {
        if (!fs.existsSync(propsFilePath)) return null;
        const props = {};
        fs.readFileSync(propsFilePath, 'utf-8').split(/\r?\n/).forEach(line => {
            const match = line.trim().match(/^([^=\s:]+)\s*[=:]?\s*(.*)$/);
            if (match && match[1] && !match[1].startsWith('#')) {
                props[match[1]] = match[2].replace(/^["']|["']$/g, '');
            }
        });
        return props;
    } catch { return null; }
}

function writeOutputFiles(baseOutputPath, data, fileTypeLabel) {
    const jsonPath = `${baseOutputPath}.json`;
    const gzPath = `${baseOutputPath}.json.gz`;
    try {
        const jsonString = JSON.stringify(data, null, 2);
        fs.writeFileSync(jsonPath, jsonString, 'utf-8');
        console.log(`${LOG_PREFIX}   -> ${fileTypeLabel} JSON written: ${path.relative(MONOREPO_ROOT, jsonPath)}`);
        fs.writeFileSync(gzPath, zlib.gzipSync(jsonString));
        return true;
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ Failed to write ${fileTypeLabel} files:`, e.message);
        return false;
    }
}

function generateDictionaryOutputs(dictProps, dictDistPath) {
    console.log(`\n${LOG_PREFIX} --- Processing: ${dictProps.dictId} ---`);
    if (!fs.existsSync(dictDistPath)) return { success: false };
    
    let indexEntries = [];
    let totalAudioCount = 0;
    let missingAudioLogs = [];
    const files = fs.readdirSync(dictDistPath).filter(f => f.endsWith('.json') && !f.startsWith('index-'));

    for (const file of files) {
        const detailData = JSON.parse(fs.readFileSync(path.join(dictDistPath, file), 'utf-8'));
        totalAudioCount += detailData.media?.audio?.length || 0;
        const contentVersion = detailData.metadata?.contentVersion || 1;

        const isParent = !!detailData.data;
        const sourceInfo = isParent ? detailData.data : detailData.source;
        const targetInfo = isParent ? null : detailData.target;

        const sourceLang = detailData.sourceLanguage || detailData.lang;
        const targetLang = detailData.targetLanguage;

        const sourceIndexObject = {
            headword: sourceInfo.headword,
            pronunciation: sourceInfo.pronunciation || null,
        };
        if (sourceInfo.genus) sourceIndexObject.genus = sourceInfo.genus;
        
        const sourceAudioPath = isParent ? 'data.headword' : 'source.headword';
        const sourceAudioEntry = detailData.media?.audio?.find(a => a.path === sourceAudioPath);
        if (sourceAudioEntry) {
            sourceIndexObject.audioUrl = sourceAudioEntry.url;
        } else if (SHOULD_LOG_SOURCE && sourceInfo.headword) {
            missingAudioLogs.push(`  -> [${file}] Missing SOURCE (${sourceLang}) audio for: "${sourceInfo.headword}"`);
        }

        const indexEntry = {
            id: detailData.id,
            filename: file,
            contentVersion: contentVersion,
            part_of_speech: detailData.part_of_speech,
            tags: detailData.tags || [],
            source: sourceIndexObject,
        };
        
        if (targetInfo) {
            const targetIndexObject = {
                headword: targetInfo.headword,
                pronunciation: targetInfo.pronunciation || null,
            };
            if (targetInfo.genus) targetIndexObject.genus = targetInfo.genus;
            if (targetInfo.headword_definite) targetIndexObject.headword_definite = targetInfo.headword_definite;
            
            const targetAudioEntry = detailData.media?.audio?.find(a => a.path === 'target.headword');
            if (targetAudioEntry) {
                targetIndexObject.audioUrl = targetAudioEntry.url;
            } else if (SHOULD_LOG_TARGET && targetInfo.headword) {
                missingAudioLogs.push(`  -> [${file}] Missing TARGET (${targetLang}) audio for: "${targetInfo.headword}"`);
            }
            indexEntry.target = targetIndexObject;
        }
        
        indexEntries.push(indexEntry);
    }

    if (missingAudioLogs.length > 0) {
        console.warn(`\n${LOG_PREFIX} 🟡 WARN: Found ${missingAudioLogs.length} entries with missing audio files for "${dictProps.dictId}":`);
        missingAudioLogs.forEach(log => console.warn(log));
    }

    const firstEntry = indexEntries.length > 0 ? JSON.parse(fs.readFileSync(path.join(dictDistPath, indexEntries[0].filename), 'utf-8')) : {};
    
    const finalIndex = {
        metadata: {
            dictId: dictProps.dictId,
            ...dictProps,
            lastUpdate: Date.now(),
            sourceLanguage: firstEntry.sourceLanguage || firstEntry.lang || null,
            targetLanguage: firstEntry.targetLanguage || null
        },
        entries: indexEntries.sort((a, b) => a.id.localeCompare(b.id))
    };
    
    const outputIndexBase = path.join(dictDistPath, `index-${dictProps.dictId}`);
    return {
        success: writeOutputFiles(outputIndexBase, finalIndex, `Index (${dictProps.dictId})`),
        audioCount: totalAudioCount
    };
}

function main() {
    console.log(`\n${LOG_PREFIX} ===== Generating Final Indexes =====`);
    const buildId = generateBuildId();
    console.log(`${LOG_PREFIX} Generated unique build ID for this run: ${buildId}`);

    if (SHOULD_LOG_SOURCE) console.log(`${LOG_PREFIX} Logging for missing SOURCE audio is ENABLED.`);
    if (SHOULD_LOG_TARGET) console.log(`${LOG_PREFIX} Logging for missing TARGET audio is ENABLED.`);
    if (!SHOULD_LOG_SOURCE && !SHOULD_LOG_TARGET) console.log(`${LOG_PREFIX} All missing audio logging is DISABLED (default).`);


    let globalDictionariesList = [];
    const packageFolders = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });

    for (const dirEntry of packageFolders.filter(d => d.isDirectory())) {
        const dictProps = parseProperties(path.join(PACKAGES_DIR, dirEntry.name));
        if (!dictProps?.path) continue;
        
        const dictDistPath = path.join(DIST_DIR, dictProps.path);
        const { success, audioCount } = generateDictionaryOutputs(dictProps, dictDistPath);

        if (success) {
            globalDictionariesList.push({
                ...dictProps,
                buildVersion: `v${dictProps.version}-${buildId}`,
                lastUpdate: Date.now(),
                audioFiles: audioCount
            });
        }
    }

    console.log(`\n${LOG_PREFIX} --- Writing Global Index File ---`);
    const globalOutputPathBase = path.join(DIST_DIR, path.basename(GLOBAL_INDEX_FILENAME, '.json'));
    writeOutputFiles(globalOutputPathBase, {
        serverInfo: SERVER_NAME,
        generatedAt: Date.now(),
        dictionaries: globalDictionariesList.sort((a, b) => a.type.localeCompare(b.type) || a.dictId.localeCompare(b.dictId))
    }, "Global Index");
    console.log(`\n${LOG_PREFIX} ===== Index Generation Complete =====`);
}

main();