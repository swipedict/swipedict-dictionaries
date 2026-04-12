import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const LOG_PREFIX = '[DistCompressor-06]';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

async function compressFile(filePath) {
    try {
        const fileContent = await fs.promises.readFile(filePath);
        const compressedContent = await gzip(fileContent, { level: zlib.constants.Z_BEST_COMPRESSION });
        await fs.promises.writeFile(`${filePath}.gz`, compressedContent);
    } catch (error) {
        console.error(`${LOG_PREFIX} ❌ Error compressing file ${filePath}:`, error);
    }
}

async function main() {
    console.log("--- Starting 'dist' Folder Compression ---");
    const jsonFiles = await glob('**/*.json', { cwd: DIST_DIR, nodir: true, absolute: true });

    if (jsonFiles.length === 0) {
        console.log(`${LOG_PREFIX} No .json files found to compress.`);
        return;
    }

    console.log(`${LOG_PREFIX} Found ${jsonFiles.length} JSON files to compress.`);
    await Promise.all(jsonFiles.map(filePath => compressFile(filePath)));
    console.log("\n✅ COMPRESSION SUCCESSFUL.");
}

main().catch(err => {
    console.error("\nFATAL UNHANDLED ERROR in main execution:", err);
    process.exit(1);
});