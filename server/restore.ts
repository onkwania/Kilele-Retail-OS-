import { restoreBackup } from './backup-engine.js';
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    'Usage: npm run restore -- BACKUP.sqlite NEW_DATABASE.sqlite. The application must not be using the destination.',
  );
console.log(JSON.stringify(restoreBackup(source, destination), null, 2));
