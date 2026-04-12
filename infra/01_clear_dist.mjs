import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_PREFIX = '[DistClear-01]';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This path correctly resolves to the monorepo root from `infra/scripts/`
// and creates the `dist` folder there.
const DIST_DIR = path.resolve(__dirname, '../dist');

function clearDistDirectory() {
    console.log(`\n${LOG_PREFIX} ===== Starting Distribution Directory Cleanup =====`);
    console.log(`${LOG_PREFIX} Target directory: ${DIST_DIR}`);
    try {
        if (fs.existsSync(DIST_DIR)) {
            fs.rmSync(DIST_DIR, { recursive: true, force: true });
            console.log(`${LOG_PREFIX} ✅ Successfully deleted 'dist' directory.`);
        }
        fs.mkdirSync(DIST_DIR, { recursive: true });
        console.log(`${LOG_PREFIX} ✅ Successfully created clean 'dist' directory.`);
    } catch (error) {
        console.error(`\n${LOG_PREFIX} ❌ CRITICAL ERROR DURING CLEANUP:`, error.message);
        process.exit(1);
    }
}
clearDistDirectory();