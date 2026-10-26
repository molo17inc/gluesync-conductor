import fs from 'node:fs';
import path from 'node:path';
import renderContractFiles from '../src/diagnosis/contract/renderContractFiles';

const contractsDir = path.resolve(__dirname, '../contracts');

fs.mkdirSync(contractsDir, { recursive: true });

Object.entries(renderContractFiles()).forEach(([name, content]) => {
  fs.writeFileSync(path.join(contractsDir, name), content);
  console.log(`wrote contracts/${name}`);
});
