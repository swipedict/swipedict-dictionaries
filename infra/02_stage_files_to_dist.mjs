import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_PREFIX = '[StageFiles-02]';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- FIX: CORRECTED ROOT PATHS ---
// These paths are now calculated correctly based on the script's location.
const SWIPEDICT_ROOT = path.resolve(__dirname, '..','..'); // Correctly points to 'swipedict'
const DICTIONARIES_ROOT = path.resolve(SWIPEDICT_ROOT, 'swipedict-dictionaries'); // Correctly points to 'swipedict-dictionaries'
const PACKAGES_DIR = path.join(DICTIONARIES_ROOT, 'packages'); // Correct path to packages

const DIST_DIR = path.join(DICTIONARIES_ROOT, 'dist');         // Correct path to dist
const MEDIA_SOURCE_DIR = path.join(SWIPEDICT_ROOT, 'swipedict-dictionaries-media'); // Correct path to media source
const MEDIA_DEST_DIR = path.join(DIST_DIR, 'media');        // Correct path to media destination

const PROPERTIES_FILENAME = '_dictionary.properties';

function getDictProps(folderPath) {
    const propsFilePath = path.join(folderPath, PROPERTIES_FILENAME);
    try {
        if (!fs.existsSync(propsFilePath)) return null;
        const fileContent = fs.readFileSync(propsFilePath, 'utf-8');
        const props = {};
        fileContent.split(/\r?\n/).forEach(line => {
            const match = line.trim().match(/^([^=\s:]+)\s*[=:]?\s*(.*)$/);
            if (match && match[1] && !match[1].startsWith('#')) {
                props[match[1]] = match[2].replace(/^["']|["']$/g, '');
            }
        });
        return props;
    } catch { return null; }
}

async function main() {
    console.log(`\n${LOG_PREFIX} ===== Staging All Source Files to Dist =====`);
    let totalJsonCopied = 0;
    
    // --- STAGE 1: Copy and version JSON files from packages ---
    console.log(`\n${LOG_PREFIX} --- Stage 1: Processing JSON packages... ---`);
    console.log(`${LOG_PREFIX}   Source: ${PACKAGES_DIR}`);
    const packageFolders = await fsPromises.readdir(PACKAGES_DIR, { withFileTypes: true });

    for (const dirEntry of packageFolders.filter(d => d.isDirectory())) {
        const dictSourcePath = path.join(PACKAGES_DIR, dirEntry.name);
        const dictProps = getDictProps(dictSourcePath);

        if (!dictProps?.path) {
            console.warn(`\n${LOG_PREFIX} 🟡 WARN: Skipping ${dirEntry.name} (missing _dictionary.properties or path).`);
            continue;
        }

        console.log(`${LOG_PREFIX}   Processing package: ${dirEntry.name}`);
        const targetDictDistPath = path.join(DIST_DIR, dictProps.path);
        await fsPromises.mkdir(targetDictDistPath, { recursive: true });

        const sourceJsonFiles = (await fsPromises.readdir(dictSourcePath)).filter(f => f.endsWith('.json') && !f.startsWith('_'));
        
        for (const file of sourceJsonFiles) {
            const sourceFilePath = path.join(dictSourcePath, file);
            const detailData = JSON.parse(await fsPromises.readFile(sourceFilePath, 'utf-8'));
            const version = detailData.metadata?.contentVersion || 1;
            const baseName = path.parse(file).name;
            
            const versionedFilename = `${baseName}-v${version}.json`;
            const destDetailFilePath = path.join(targetDictDistPath, versionedFilename);
            await fsPromises.copyFile(sourceFilePath, destDetailFilePath);
            totalJsonCopied++;
        }
    }
    console.log(`${LOG_PREFIX} ✅ Stage 1 Complete. Staged ${totalJsonCopied} JSON files.`);

    // --- STAGE 2: Copy the entire media repository ---
    console.log(`\n${LOG_PREFIX} --- Stage 2: Copying media repository... ---`);
    try {
        await fsPromises.access(MEDIA_SOURCE_DIR);
        console.log(`${LOG_PREFIX}   Source: ${MEDIA_SOURCE_DIR}`);
        console.log(`${LOG_PREFIX}   Destination: ${MEDIA_DEST_DIR}`);
        
        await fsPromises.mkdir(MEDIA_DEST_DIR, { recursive: true });
        // Copy media, excluding .git and ftp-audio (raw backup files not needed on server)
        const MEDIA_EXCLUDES = new Set(['.git', 'ftp-audio', 'temp']);
        await fsPromises.cp(MEDIA_SOURCE_DIR, MEDIA_DEST_DIR, {
            recursive: true,
            filter: (src) => {
                const rel = path.relative(MEDIA_SOURCE_DIR, src);
                const parts = rel.split(path.sep);
                return !parts.some(p => MEDIA_EXCLUDES.has(p));
            }
        });

        console.log(`${LOG_PREFIX} ✅ Stage 2 Complete. Media repository copied successfully.`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`${LOG_PREFIX} 🟡 WARN: Media source directory not found. Skipping media stage.`);
            console.log(`   (Looked for: ${MEDIA_SOURCE_DIR})`);
        } else {
            console.error(`${LOG_PREFIX} ❌ ERROR during media copy:`, e);
        }
    }
    
    console.log(`\n${LOG_PREFIX} ===== Staging Complete =====`);
}

main().catch(err => {
    console.error("FATAL ERROR in main execution:", err);
    process.exit(1);
});