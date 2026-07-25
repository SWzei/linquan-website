import db from '../src/config/db.js';
import { provisionMaintainer } from '../src/services/maintainerService.js';

const credential = process.env.MAINTAINER_CREDENTIAL;
const password = process.env.MAINTAINER_PASSWORD;
const email = process.env.MAINTAINER_EMAIL || null;
const replaceActive = process.env.MAINTAINER_REPLACE_ACTIVE === 'true';
const recoverActive = process.env.MAINTAINER_RECOVER_ACTIVE === 'true';
if (replaceActive && recoverActive) throw new Error('Choose transfer or recovery, not both');
const requiredConfirmation = replaceActive
  ? 'TRANSFER_MAINTAINER'
  : recoverActive ? 'RECOVER_MAINTAINER' : 'PROVISION_MAINTAINER';

if (process.env.MAINTAINER_CONFIRM !== requiredConfirmation) {
  throw new Error(`Set MAINTAINER_CONFIRM=${requiredConfirmation} after verifying a current database backup`);
}
if (!credential || !password) throw new Error('MAINTAINER_CREDENTIAL and MAINTAINER_PASSWORD are required');

const userId = provisionMaintainer({ credential, password, email, replaceActive, recoverActive });
console.log(`Maintainer provisioning completed for user id ${userId}. Credentials were not printed.`);
if (typeof db.close === 'function') db.close();
