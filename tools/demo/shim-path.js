module.exports = { join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') || '.' };
