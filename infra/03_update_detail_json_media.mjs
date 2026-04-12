import fsPromises from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_PREFIX = '[LinkMedia-03]';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DICTIONARIES_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(DICTIONARIES_ROOT, 'dist');
const MEDIA_DIR = path.join(DIST_DIR, 'media');

const WRITE_CHANGES = true;

function linkAudio(detailData, audioDir, urlPrefix, baseFilename, jsonPathType, lang) {
    let linksAdded = 0;
    if (!fs.existsSync(audioDir)) return 0;

    try {
        const matchingFiles = fs.readdirSync(audioDir)
            .filter(f => f.startsWith(baseFilename) && f.endsWith('.opus'));

        if (matchingFiles.length > 0) {
           // console.log(`    -> Found ${matchingFiles.length} audio file(s) for "${baseFilename}"`);
            if (!detailData.media) detailData.media = {};
            if (!detailData.media.audio) detailData.media.audio = [];

            let exampleTextField = 'sourceText';
            if (jsonPathType.startsWith('target.')) {
                exampleTextField = 'targetText';
            } else if (jsonPathType.startsWith('data.')) {
                exampleTextField = 'text';
            }

            for (const audioFile of matchingFiles) {
                let currentJsonPath = jsonPathType;
                if (audioFile.includes('-example-')) {
                    const exampleIndex = parseInt(audioFile.split('-example-')[1], 10) - 1;
                    const example = detailData.examples?.[exampleIndex];
                    if (example && example[exampleTextField]) {
                        currentJsonPath = `examples.${exampleIndex}.${exampleTextField}`;
                    } else continue;
                } else if (audioFile.includes('_etymology')) {
                    const side = jsonPathType.split('.')[0]; // 'target', 'source', or 'data'
                    currentJsonPath = `${side}.etymology`;
                }
                const audioUrl = `${urlPrefix}/${audioFile}`;
                if (!detailData.media.audio.some(a => a.url === audioUrl)) {
                    // This object now perfectly matches your schema
                    detailData.media.audio.push({
                        path: currentJsonPath,
                        url: audioUrl,
                        lang: lang
                    });
                    linksAdded++;
                }
            }
        }
    } catch (error) {
        console.error(`    -> ❌ ERROR during audio search in ${audioDir}:`, error);
    }
    return linksAdded;
}

async function processDictionary(dictDistPath) {
    const dictId = path.basename(dictDistPath);
    console.log(`\n--- Processing Dictionary: ${dictId} ---`);

    const detailJsonFiles = (await fsPromises.readdir(dictDistPath)).filter(f => f.endsWith('.json') && !f.startsWith('index-'));

    for (const versionedJsonFile of detailJsonFiles) {
        const detailJsonPath = path.join(dictDistPath, versionedJsonFile);
        
        try {
            const detailData = JSON.parse(await fsPromises.readFile(detailJsonPath, 'utf-8'));
            const jsonFileBaseName = path.parse(versionedJsonFile).name.replace(/-v\d+$/, '');
            let totalLinksForFile = 0;

            const ownAudioDir = path.join(MEDIA_DIR, dictId, 'audio');
            const ownUrlPrefix = `/media/${dictId}/audio`;
            if (detailData.source) {
                totalLinksForFile += linkAudio(detailData, ownAudioDir, ownUrlPrefix, jsonFileBaseName, 'source.headword', detailData.sourceLanguage);
            } else if (detailData.data) {
                totalLinksForFile += linkAudio(detailData, ownAudioDir, ownUrlPrefix, jsonFileBaseName, 'data.headword', detailData.lang);
            }

            if (detailData.parent) {
                const parentId = detailData.parent.split('@')[0];
                const parentIdParts = parentId.split('-');
                if (parentIdParts.length >= 3) {
                    const parentPackageId = `${parentIdParts[0]}-${parentIdParts[1]}`;
                    const parentBaseFilename = parentIdParts.slice(2).join('-');
                    const parentAudioDir = path.join(MEDIA_DIR, parentPackageId, 'audio');
                    const parentUrlPrefix = `/media/${parentPackageId}/audio`;
                    totalLinksForFile += linkAudio(detailData, parentAudioDir, parentUrlPrefix, parentBaseFilename, 'target.headword', detailData.targetLanguage);
                }
            }
            
            if (totalLinksForFile > 0 && WRITE_CHANGES) {
                await fsPromises.writeFile(detailJsonPath, JSON.stringify(detailData, null, 2), 'utf-8');
             //   console.log(`  ✅ Saved ${versionedJsonFile} with ${totalLinksForFile} new audio link(s).`);
            }
        } catch (error) {
            console.error(`  -> ❌ ERROR processing ${versionedJsonFile}:`, error.message);
        }
    }
}

async function main() {
    console.log(`\n${LOG_PREFIX} ===== Linking Media to Detail JSONs =====`);
    if (!fs.existsSync(DIST_DIR)) {
        console.error(`\n❌ FATAL: DIST_DIR not found at '${DIST_DIR}'. Ensure script 02 ran successfully.`);
        process.exit(1);
    }
    
    const distFolders = (await fsPromises.readdir(DIST_DIR, { withFileTypes: true }))
        .filter(d => d.isDirectory() && d.name !== 'media');

    for (const dirEntry of distFolders) {
        await processDictionary(path.join(DIST_DIR, dirEntry.name));
    }

    console.log(`\n${LOG_PREFIX} ===== Media Linking Complete =====`);
}

main().catch(err => {
    console.error("FATAL ERROR in main execution:", err);
    process.exit(1);
});