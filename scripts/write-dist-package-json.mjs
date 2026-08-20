// The package is ESM ("type": "module"), so the CommonJS build needs its own
// package.json telling Node that dist/cjs/*.js are CommonJS files. Without it
// require('@dominaite/dominaite-node') throws ERR_REQUIRE_ESM.
import { writeFileSync } from 'node:fs'

writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n')
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n')
