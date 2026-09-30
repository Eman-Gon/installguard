import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileFor } from '../shared/profiles.mjs';
const profile=profileFor(process.argv[2] || 'csv-validation-v1');
const result=spawnSync('docker',['build','--build-arg',`CACHE_FIXTURE=${profile.cacheFixture}`,'--build-arg',`NODE_VERSION=${profile.target.version}`,'-f','worker/Dockerfile','-t',profile.image,'.'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit'});
process.exitCode=result.status??1;
