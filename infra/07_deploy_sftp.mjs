import SftpClient from 'ssh2-sftp-client';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration & Argument Parsing ---
const envFileArg = process.argv.find(arg => arg.startsWith('--env='));
if (!envFileArg) {
    console.error('❌ Error: --env argument is required.');
    console.error(`   Example: node ${path.basename(__filename)} --env=path/to/your/.envfile`);
    process.exit(1);
}
// --sync: skip files where remote size === local size (incremental upload)
const SYNC_MODE = process.argv.includes('--sync');
if (SYNC_MODE) console.log('🔄 Sync mode ENABLED: unchanged files (by size) will be skipped.');
const envFilePath = path.resolve(envFileArg.split('=')[1]);
console.log(`🔧 Using .env file path from argument: ${envFilePath}`);

const dotenvResult = dotenv.config({ path: envFilePath });
if (dotenvResult.error) {
    console.error(`Error loading environment variables from ${envFilePath}:`, dotenvResult.error.message);
    process.exit(1);
}

const {
    SFTP_HOST,
    SFTP_PORT = 22,
    SFTP_USER,
    SFTP_PASSWORD,
    SFTP_PRIVATE_KEY_PATH,
    SFTP_PASSPHRASE,
    SFTP_REMOTE_PATH,
    SFTP_CONCURRENCY = '8' // Increased default concurrency
} = process.env;

// --- Paths ---
const LOCAL_BASE_PATH = path.resolve(__dirname, '..', 'dist');

// --- Validation & SFTP Config (Unchanged) ---
if (!SFTP_HOST || !SFTP_USER || !SFTP_REMOTE_PATH) { console.error(`Error: Missing required SFTP configuration in ${envFilePath} (SFTP_HOST, SFTP_USER, SFTP_REMOTE_PATH)`); process.exit(1); }
if (!SFTP_PASSWORD && !SFTP_PRIVATE_KEY_PATH) { console.error(`Error: Missing authentication method in ${envFilePath}. Provide either SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH.`); process.exit(1); }
const sftpConfig = { host: SFTP_HOST, port: parseInt(SFTP_PORT, 10), username: SFTP_USER, ...(SFTP_PASSWORD ? { password: SFTP_PASSWORD } : {}), ...(SFTP_PRIVATE_KEY_PATH ? { privateKey: tryReadKeyFileSync(SFTP_PRIVATE_KEY_PATH, envFilePath), passphrase: SFTP_PASSPHRASE } : {}), retries: 2, retry_factor: 2, retry_minTimeout: 2000, keepalivePubkey: true, keepaliveCountMax: 10, keepaliveInterval: 15000 };
function tryReadKeyFileSync(keyPath, envPath) { try { const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(path.dirname(envPath), keyPath); return fs.readFileSync(resolved); } catch (err) { console.error(`Error reading private key at ${path.resolve(path.dirname(envPath), keyPath)}:`, err.message); process.exit(1); } }


// --- Remote file size index (populated once in sync mode) ---
const remoteFileIndex = new Map(); // remotePath (normalized) -> size

async function buildRemoteIndex(sftp, remotePath) {
    try {
        const items = await sftp.list(remotePath);
        for (const item of items) {
            const fullRemotePath = (remotePath + '/' + item.name).replace(/\/+/g, '/');
            if (item.type === 'd') {
                await buildRemoteIndex(sftp, fullRemotePath);
            } else {
                remoteFileIndex.set(fullRemotePath, item.size);
            }
        }
    } catch (e) {
        // Directory doesn't exist yet — that's fine
    }
}

// --- NEW: Progress Bar Logic ---
let limit; // To be assigned after dynamic import
const progressState = { current: 0, total: 0 };
const PROGRESS_BAR_WIDTH = 30;

function updateProgress() {
    if (progressState.total === 0) return;
    const percentage = Math.round((progressState.current / progressState.total) * 100);
    const filledBlocks = Math.round((percentage / 100) * PROGRESS_BAR_WIDTH);
    const emptyBlocks = PROGRESS_BAR_WIDTH - filledBlocks;
    const bar = '▓'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
    process.stdout.write(`\r[UPLOAD] ${bar} ${percentage}% (${progressState.current}/${progressState.total})`);
    if (progressState.current === progressState.total) {
        process.stdout.write('\n'); // Move to next line when complete
    }
}

// --- NEW: File Counting Logic ---
async function countFilesInDirectory(dirPath) {
    let count = 0;
    try {
        const items = await fsPromises.readdir(dirPath, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dirPath, item.name);
            if (item.isDirectory()) {
                count += await countFilesInDirectory(fullPath);
            } else if (item.isFile()) {
                count++;
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Warning: Could not count files in ${dirPath}: ${e.message}`);
    }
    return count;
}

async function getTotalFilesToUpload() {
    let total = 0;
    const globalDictionariesFile = path.resolve(LOCAL_BASE_PATH, 'dictionaries.json');
    try {
        await fsPromises.access(globalDictionariesFile);
        total += 2; // .json and .json.gz
        const fileContent = await fsPromises.readFile(globalDictionariesFile, 'utf-8');
        const data = JSON.parse(fileContent);
        if (data.dictionaries && Array.isArray(data.dictionaries)) {
            for (const dictInfo of data.dictionaries) {
                if (dictInfo.path) {
                    const dictPath = path.resolve(LOCAL_BASE_PATH, dictInfo.path);
                    total += await countFilesInDirectory(dictPath);
                }
            }
        }
    } catch (e) {
        console.error(`❌ Cannot calculate total files. Missing or invalid ${path.basename(globalDictionariesFile)}.`);
        throw e;
    }
    // Count media files
    const mediaPath = path.resolve(LOCAL_BASE_PATH, 'media');
    try {
        await fsPromises.access(mediaPath);
        total += await countFilesInDirectory(mediaPath);
    } catch { /* no media dir, that's fine */ }
    return total;
}


// --- REFACTORED: Helper Functions for Upload ---
async function uploadDirectory(sftp, localPath, remotePath) {
    try {
        await sftp.mkdir(remotePath, true);
        const items = await fsPromises.readdir(localPath, { withFileTypes: true });
        const uploadPromises = items.map((item) => limit(async () => {
            const localItemPath = path.join(localPath, item.name);
            const remoteItemPath = path.join(remotePath, item.name).replace(/\\/g, '/');
            if (item.isDirectory()) {
                await uploadDirectory(sftp, localItemPath, remoteItemPath);
            } else if (item.isFile()) {
                try {
                    if (SYNC_MODE) {
                        const localStat = await fsPromises.stat(localItemPath);
                        const remoteSize = remoteFileIndex.get(remoteItemPath);
                        if (remoteSize !== undefined && remoteSize === localStat.size) {
                            progressState.current++;
                            updateProgress();
                            return; // unchanged
                        }
                    }
                    await sftp.fastPut(localItemPath, remoteItemPath);
                    progressState.current++;
                    updateProgress();
                } catch (uploadErr) {
                    console.error(`\n[FILE] Error uploading ${localItemPath} to ${remoteItemPath}:`, uploadErr.message);
                }
            }
        }));
        await Promise.all(uploadPromises);
    } catch (err) {
        console.error(`\n[DIR] Error processing directory ${localPath}:`, err.message);
        throw err;
    }
}

async function uploadSingleFile(sftp, localFilePath, remoteBaseTargetPath) {
    const remoteFilePath = path.join(remoteBaseTargetPath, path.basename(localFilePath)).replace(/\\/g, '/');
    try {
        await fsPromises.access(localFilePath);
        await limit(() => sftp.fastPut(localFilePath, remoteFilePath));
        progressState.current++;
        updateProgress();
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`\n[FILE] Skipping upload: Local file not found at ${localFilePath}`);
        } else {
            console.error(`\n[FILE] Error uploading ${localFilePath}:`, err.message);
            throw err;
        }
    }
}

// --- Main Deployment Function ---
async function deploy() {
    let CONCURRENCY_LIMIT = parseInt(SFTP_CONCURRENCY, 10);
    if (isNaN(CONCURRENCY_LIMIT) || CONCURRENCY_LIMIT <= 0) {
        console.warn(`Invalid SFTP_CONCURRENCY value. Using default of 8.`);
        CONCURRENCY_LIMIT = 8;
    }
    limit = pLimit(CONCURRENCY_LIMIT);
    console.log(`🔧 Using SFTP concurrency limit: ${CONCURRENCY_LIMIT}`);

    const sftp = new SftpClient();
    console.log(`🚀 Starting deployment of 'dist' folder to ${SFTP_HOST}:${SFTP_REMOTE_PATH}...`);
    console.log(`📁 Local source base: ${LOCAL_BASE_PATH}`);

    try {
        progressState.total = await getTotalFilesToUpload();
        if (progressState.total === 0) {
            console.log('🟡 No files found to upload. Exiting.');
            return;
        }
        console.log(`🔍 Found ${progressState.total} total files to upload.`);

        console.log('🔌 Connecting to SFTP server...');
        await sftp.connect(sftpConfig);
        console.log('🔗 SFTP connection established.');

        if (SYNC_MODE) {
            console.log('🔍 Building remote file index for sync...');
            await buildRemoteIndex(sftp, SFTP_REMOTE_PATH);
            console.log(`   Remote index built: ${remoteFileIndex.size} files cached.`);
        }

        console.log(`Ensuring remote base directory exists: ${SFTP_REMOTE_PATH}`);
        await sftp.mkdir(SFTP_REMOTE_PATH, true);

        // Upload global files first
        await uploadSingleFile(sftp, path.resolve(LOCAL_BASE_PATH, 'dictionaries.json'), SFTP_REMOTE_PATH);
        await uploadSingleFile(sftp, path.resolve(LOCAL_BASE_PATH, 'dictionaries.json.gz'), SFTP_REMOTE_PATH);
        
        // Read global index to find directories to upload
        const globalIndexContent = await fsPromises.readFile(path.resolve(LOCAL_BASE_PATH, 'dictionaries.json'), 'utf-8');
        const dictionariesToDeploy = JSON.parse(globalIndexContent).dictionaries;

        console.log("\n📚 Uploading dictionary directories...");
        for (const dictInfo of dictionariesToDeploy) {
            if (!dictInfo.path) {
                console.warn(`\n   🟡 Skipping dictionary entry due to missing 'path'.`);
                continue;
            }
            const localDictPath = path.resolve(LOCAL_BASE_PATH, dictInfo.path);
            const remoteDictPath = path.join(SFTP_REMOTE_PATH, dictInfo.path).replace(/\\/g, '/');
            try {
                await fsPromises.access(localDictPath);
                await uploadDirectory(sftp, localDictPath, remoteDictPath);
            } catch (dirAccessErr) {
                if (dirAccessErr.code === 'ENOENT') {
                    console.warn(`\n   🟡 Skipping directory '${dictInfo.path}': Local directory not found.`);
                } else {
                    console.error(`\n   ❌ Error accessing local directory ${localDictPath}:`, dirAccessErr.message);
                }
            }
        }

        // Upload media directory (audio files etc.)
        const localMediaPath = path.resolve(LOCAL_BASE_PATH, 'media');
        const remoteMediaPath = path.join(SFTP_REMOTE_PATH, 'media').replace(/\\/g, '/');
        try {
            await fsPromises.access(localMediaPath);
            console.log("\n🔊 Uploading media directory...");
            await uploadDirectory(sftp, localMediaPath, remoteMediaPath);
        } catch (mediaErr) {
            if (mediaErr.code === 'ENOENT') {
                console.warn('\n   🟡 No media directory found in dist, skipping.');
            } else {
                console.error('\n   ❌ Error uploading media directory:', mediaErr.message);
            }
        }

        console.log('\n-------------------------------------');
        console.log('✅ Deployment successful!');
        console.log('-------------------------------------');

    } catch (err) {
        console.error('\n-------------------------------------');
        console.error('❌ Deployment failed:', err.message || err);
        if (err.stack) console.error(err.stack);
        console.error('-------------------------------------');
        process.exitCode = 1;
    } finally {
        console.log('\n🔌 Disconnecting from SFTP server...');
        if (sftp.sftp) {
           await sftp.end().catch(endErr => console.error("   Error during SFTP disconnect:", endErr.message));
           console.log('🛑 SFTP connection closed.');
        } else {
           console.log('   SFTP connection was not fully established or already closed.');
        }
    }
}

// --- Run Deployment ---
deploy().catch(err => {
    console.error("Unhandled error during deployment startup:", err);
    process.exit(1);
});