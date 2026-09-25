'use strict';

// npm run keygen: prints a new APP_ENCRYPTION_KEY. Store it in a password manager:
// without it, backups cannot be restored and everyone's two-factor must be reset.
console.log(require('node:crypto').randomBytes(32).toString('base64'));
