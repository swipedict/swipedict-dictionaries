import { execSync } from 'child_process';

const steps = [
  '01_clear_dist.mjs',
  '02_stage_files_to_dist.mjs',
  '03_update_detail_json_media.mjs',
  '04_generate_index.mjs --log-missing-target',
  '05_validate_dist.mjs',
  '06_compress_dist.mjs',
];

try {
  for (const step of steps) {
    console.log(`\nRunning: ${step}`);
    execSync('node ' + step, { stdio: 'inherit' });
  }
  console.log('\nAll steps completed successfully.');
} catch (error) {
  console.error(`\nFailed while executing: ${error.cmd || error.message}`);
  process.exit(1); 
}